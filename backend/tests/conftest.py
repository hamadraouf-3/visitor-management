"""Test harness (contract §11).

* Throwaway databases per test session, created by the owner role and migrated with Alembic; the
  application connects as the runtime role. They are dropped at the end.
* Each test runs inside an outer transaction that is rolled back afterwards. Only
  `app.db.session.session_factory` is overridden, so requests, the security-event writer, the e-mail
  dispatcher and the CLI all join that transaction (`join_transaction_mode="create_savepoint"`).
* Tests marked `committed` use real commits on separate connections instead (concurrency, dispatcher),
  in a database of their own (`committed_*` fixtures). Rows they leave behind (audit_logs is
  append-only) therefore never reach the rolled-back tests, whatever the order or selection of tests.
  Collection fails if a committed test uses a fixture of the shared database or the other way round.
* `audit_rows` only sees rows written by the current test (`audit_seq_watermark`).
* A strictly increasing fake clock, a reset rate limiter and the in-memory e-mail provider per test.

`pytest --committed-first` runs the committed tests before all others; CI runs the suite in this order
as well as the default one, so a test that depends on running before committed tests fails there.

Connection settings come from VMS_TEST_MIGRATION_DATABASE_URL / VMS_TEST_DATABASE_URL, falling back to
MIGRATION_DATABASE_URL / DATABASE_URL (repository `.env`); only the database name is replaced.
"""

import os
import secrets
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import pytest
from alembic import command
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core import time as app_time
from app.core.config import Settings
from app.core.time import FakeClock
from app.db.session import create_db_engine, make_sessionmaker, session_factory
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.security.passwords import Argon2Parameters, PasswordHasherService
from tests.support import (
    AUDIT_SEQ_WATERMARK,
    PLATFORM_AUDIT_SEQ_WATERMARK,
    TEST_CLIENT_ADDRESS,
    Factory,
    ThrowawayDatabase,
    World,
    alembic_config,
    build_world,
)

TEST_START = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)  # 09:00 in Asia/Amman
# Cheap Argon2 parameters keep the suite fast; production parameters are asserted in unit tests.
FAST_ARGON2 = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)

COMMITTED_MARKER = "committed"
PERFORMANCE_MARKER = "performance"
# Fixtures bound to the database the rolled-back tests share, and to the committed tests' database.
SHARED_DATABASE_FIXTURES = frozenset(
    {"database", "settings", "app_engine", "owner_engine", "shared_app", "app", "connection", "db"}
)
COMMITTED_DATABASE_FIXTURES = frozenset(
    {"committed_database", "committed_settings", "committed_engine", "committed_session_factory"}
)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--committed-first",
        action="store_true",
        default=False,
        help="run the tests marked 'committed' before all other tests (test-isolation check)",
    )
    parser.addoption(
        "--performance",
        action="store_true",
        default=False,
        help="also run the tests marked 'performance' (seeded volume, latency budgets; run with -s)",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    problems: list[str] = []
    for item in items:
        fixtures = set(getattr(item, "fixturenames", ()))
        if item.get_closest_marker(COMMITTED_MARKER) is not None:
            mixed = sorted(fixtures & SHARED_DATABASE_FIXTURES)
            if mixed:
                problems.append(f"{item.nodeid}: committed test uses shared-database fixtures {mixed}")
        else:
            mixed = sorted(fixtures & COMMITTED_DATABASE_FIXTURES)
            if mixed:
                problems.append(f"{item.nodeid}: uses {mixed} without the '{COMMITTED_MARKER}' marker")
    if problems:
        raise pytest.UsageError("\n".join(problems))
    if not config.getoption("performance"):
        skip = pytest.mark.skip(reason="performance check: run with --performance (and -s for the numbers)")
        for item in items:
            if item.get_closest_marker(PERFORMANCE_MARKER) is not None:
                item.add_marker(skip)
    if config.getoption("committed_first"):
        items.sort(key=lambda item: item.get_closest_marker(COMMITTED_MARKER) is None)  # stable


def _source_urls() -> tuple[str, str, str]:
    owner = os.environ.get("VMS_TEST_MIGRATION_DATABASE_URL")
    app = os.environ.get("VMS_TEST_DATABASE_URL")
    if owner and app:
        return owner, app, os.environ.get("VMS_TEST_DB_APP_ROLE", "vms_app")
    configured = Settings()  # type: ignore[call-arg]  # from the environment / .env
    return configured.migration_url, configured.runtime_url, configured.db_app_role


def _with_database(url: str, name: str) -> str:
    return make_url(url).set(database=name).render_as_string(hide_password=False)


def _drop_database(connection: Connection, name: str, *, attempts: int = 10) -> None:
    # WITH (FORCE) terminates the remaining sessions, but a non-superuser may not terminate an
    # autovacuum worker that happens to be processing the database; it finishes within moments.
    for attempt in range(attempts):
        try:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            return
        except ProgrammingError:
            if attempt == attempts - 1:
                raise
            time.sleep(1)


@pytest.fixture(scope="session")
def admin_engine() -> Iterator[Engine]:
    owner_url, _app_url, _role = _source_urls()
    engine = create_engine(owner_url, isolation_level="AUTOCOMMIT", poolclass=NullPool)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def create_database(admin_engine: Engine) -> Iterator[Callable[[str], ThrowawayDatabase]]:
    """Factory for throwaway databases (dropped at session end)."""
    owner_url, app_url, app_role = _source_urls()
    created: list[str] = []

    def factory(prefix: str) -> ThrowawayDatabase:
        name = f"{prefix}_{secrets.token_hex(4)}"
        with admin_engine.connect() as connection:
            connection.execute(text(f'CREATE DATABASE "{name}"'))
            # As scripts/db.ps1 does for vms/vms_e2e: the runtime role gets no DDL, temporary tables
            # included (PostgreSQL grants TEMPORARY on every new database to PUBLIC).
            connection.execute(text(f'REVOKE TEMPORARY ON DATABASE "{name}" FROM PUBLIC'))
        created.append(name)
        return ThrowawayDatabase(
            name, _with_database(owner_url, name), _with_database(app_url, name), app_role
        )

    yield factory
    with admin_engine.connect() as connection:
        for name in created:
            _drop_database(connection, name)


def _migrated(create_database: Callable[[str], ThrowawayDatabase], prefix: str) -> ThrowawayDatabase:
    db = create_database(prefix)
    command.upgrade(alembic_config(db), "head")
    return db


def _test_settings(database: ThrowawayDatabase) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url=database.app_url,
        migration_database_url=database.owner_url,
        db_app_role=database.app_role,
        secret_key="test-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz",
        app_base_url="https://vms.test",
        qr_base_url="https://vms.test",
        allowed_origins="https://vms.test",
        trusted_proxies="",
        cookie_secure=True,
        email_provider="memory",
        email_fail_domain=None,
        rate_limit_enabled=True,
        log_level="WARNING",
        log_json=True,
        seed_company_timezone="Asia/Amman",
        seed_demo_password="Demo-Visitor-2026",
    )


@pytest.fixture(scope="session")
def database(create_database: Callable[[str], ThrowawayDatabase]) -> ThrowawayDatabase:
    """The database of the rolled-back tests."""
    return _migrated(create_database, "vms_test")


@pytest.fixture(scope="session")
def settings(database: ThrowawayDatabase) -> Settings:
    return _test_settings(database)


@pytest.fixture(scope="session")
def committed_database(create_database: Callable[[str], ThrowawayDatabase]) -> ThrowawayDatabase:
    """The database of the tests marked `committed`: their rows persist until the session ends."""
    return _migrated(create_database, "vms_committed")


@pytest.fixture(scope="session")
def committed_settings(committed_database: ThrowawayDatabase) -> Settings:
    return _test_settings(committed_database)


@pytest.fixture(scope="session")
def committed_engine(committed_settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(
        committed_settings.runtime_url, pool_size=5, application_name="vms-tests-committed"
    )
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def app_engine(settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(settings.runtime_url, pool_size=5, application_name="vms-tests")
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def owner_engine(database: ThrowawayDatabase) -> Iterator[Engine]:
    engine = create_db_engine(database.owner_url, pool_size=2, application_name="vms-tests-owner")
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def hasher() -> PasswordHasherService:
    return PasswordHasherService(FAST_ARGON2, max_concurrency=8)


@pytest.fixture(scope="session")
def email_provider() -> MemoryProvider:
    return MemoryProvider()


@pytest.fixture(scope="session")
def sleeps() -> list[float]:
    return []


@pytest.fixture(scope="session")
def shared_app(
    settings: Settings,
    app_engine: Engine,
    hasher: PasswordHasherService,
    email_provider: MemoryProvider,
    sleeps: list[float],
) -> FastAPI:
    return create_app(
        settings,
        engine=app_engine,
        password_hasher=hasher,
        email_provider=email_provider,
        email_sleep=sleeps.append,
    )


@pytest.fixture
def app(shared_app: FastAPI, email_provider: MemoryProvider, sleeps: list[float]) -> FastAPI:
    """The shared application with per-test state reset (rate limiter, audit coalescing, e-mail
    provider, sleeps)."""
    shared_app.state.service_environment.limiter.reset()
    shared_app.state.security_audit.reset()
    email_provider.clear()
    sleeps.clear()
    return shared_app


@pytest.fixture(autouse=True)
def clock() -> Iterator[FakeClock]:
    fake = FakeClock(TEST_START)
    with app_time.using_clock(fake):
        yield fake


@pytest.fixture
def connection(app_engine: Engine) -> Iterator[Connection]:
    """The outer transaction every session of this test joins; rolled back afterwards."""
    connection = app_engine.connect()
    transaction = connection.begin()
    watermark = connection.execute(text("SELECT coalesce(max(seq), 0) FROM audit_logs")).scalar_one()
    platform_watermark = connection.execute(
        text("SELECT coalesce(max(seq), 0) FROM platform_audit_logs")
    ).scalar_one()
    session_factory.override(
        sessionmaker(
            bind=connection,
            join_transaction_mode="create_savepoint",
            expire_on_commit=False,
            info={AUDIT_SEQ_WATERMARK: watermark, PLATFORM_AUDIT_SEQ_WATERMARK: platform_watermark},
        )
    )
    try:
        yield connection
    finally:
        session_factory.clear_override()
        transaction.rollback()
        connection.close()


@pytest.fixture
def db(connection: Connection) -> Iterator[Session]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def committed_session_factory(committed_engine: Engine) -> Iterator[sessionmaker[Session]]:
    """Real, separately committing sessions on the committed tests' database."""
    maker = make_sessionmaker(committed_engine)
    session_factory.override(maker)
    try:
        yield maker
    finally:
        session_factory.clear_override()


@pytest.fixture
def factory(db: Session, hasher: PasswordHasherService) -> Factory:
    return Factory(db, hasher)


@pytest.fixture
def world(factory: Factory) -> World:
    return build_world(factory)


@pytest.fixture
def client(app: FastAPI, connection: Connection) -> TestClient:
    return TestClient(app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS)


@pytest.fixture
def make_client(app: FastAPI, connection: Connection) -> Callable[..., TestClient]:
    def make(**kwargs: object) -> TestClient:
        options = {"base_url": "https://testserver", "client": TEST_CLIENT_ADDRESS, **kwargs}
        return TestClient(app, **options)  # type: ignore[arg-type]

    return make
