"""Production refuses to start on a database role that could undo the database's guarantees (SEC-23), that
holds privileges beyond the migrations' grants (SEC-R7), that carries default settings of its own (SEC-38)
or that signed in with a published password (SEC-R6); every connection pins the settings the application
relies on (SEC-37, SEC-38); a failed startup connection does not print the database URL (SEC-36)."""

import secrets
import traceback
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core import config
from app.core.config import ConfigurationError, Settings
from app.db.privileges import (
    require_runtime_privileges,
    runtime_password_is_published,
    runtime_privilege_problems,
    runtime_role_settings,
)
from app.db.session import connection_options, create_db_engine
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import Company
from app.security.passwords import PasswordHasherService
from tests.support import ThrowawayDatabase, alembic_config


def _production(settings: Settings, database: ThrowawayDatabase) -> Settings:
    """A valid production configuration; the engine is passed to `create_app` separately, so the URLs
    (which must not use the published local passwords in production) are never connected to."""
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="production",
        database_url="postgresql://runtime:runtime-secret-0001@db.internal/vms?sslmode=verify-full",
        migration_database_url="postgresql://owner:owner-secret-0001@db.internal/vms?sslmode=verify-full",
        db_app_role=database.app_role,
        secret_key=secrets.token_urlsafe(48),  # generated: no production-valid key in the code (SEC-47)
        app_base_url="https://vms.example.com",
        allowed_origins="https://vms.example.com",
        cookie_secure=True,
        email_provider="resend",
        resend_api_key="re_test_key",
        log_level="WARNING",
    )


@pytest.fixture
def local_passwords_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """The test cluster's roles sign in with the passwords scripts/db.ps1 publishes, which production
    refuses (`test_production_refuses_a_published_password_wherever_libpq_takes_it`). Tests of the other
    startup checks accept them."""
    monkeypatch.setattr(config, "PUBLISHED_DB_PASSWORD_MARKERS", ())


def test_the_runtime_role_has_none_of_the_refused_privileges(app_engine: Engine) -> None:
    assert runtime_privilege_problems(app_engine) == []


def test_the_schema_owner_is_recognised(owner_engine: Engine) -> None:
    problems = set(runtime_privilege_problems(owner_engine))
    assert {"owns_schema_objects", "changes_audit_rows", "deletes_rows", "chooses_audit_order"} <= problems


# ---- attributes, memberships and role switches (SEC-49) -------------------------------------------
# A role whose only excess is a role attribute or a membership passed the privilege checks (none of them
# confers a table privilege). The test databases cannot create roles, so the check also judges an
# existing role by name: the bootstrap superuser, the schema owner (CREATEDB, scripts/db.ps1) and
# PostgreSQL's predefined roles (each is a member of itself).


def _bootstrap_superuser(engine: Engine) -> str:
    with engine.connect() as connection:
        return str(connection.execute(text("SELECT rolname FROM pg_roles WHERE oid = 10")).scalar_one())


def test_role_attributes_beyond_login_are_refused(app_engine: Engine, owner_engine: Engine) -> None:
    """REPLICATION streams every database's WAL and pins WAL with replication slots; CREATEROLE and
    CREATEDB administer roles and databases of the whole cluster."""
    superuser = set(runtime_privilege_problems(app_engine, role=_bootstrap_superuser(app_engine)))
    assert {
        "superuser",
        "bypasses_row_security",
        "replicates",
        "creates_roles",
        "creates_databases",
    } <= superuser
    assert "creates_databases" in runtime_privilege_problems(owner_engine)  # LOGIN CREATEDB


@pytest.mark.parametrize(
    "role", ["pg_execute_server_program", "pg_read_server_files", "pg_write_server_files"]
)
def test_server_program_and_file_roles_are_refused(app_engine: Engine, role: str) -> None:
    """COPY ... TO PROGRAM runs commands as the database server's operating-system account, and the file
    roles read and write its files (pg_hba.conf, the data directory): the audit triggers and history
    would be one statement away."""
    assert "uses_server_files_or_programs" in runtime_privilege_problems(app_engine, role=role)


def test_a_membership_of_any_role_is_refused(app_engine: Engine, owner_engine: Engine) -> None:
    """The migrations grant the runtime role no membership. A membership WITH INHERIT FALSE, SET TRUE
    gives nothing `has_table_privilege` can see, yet `SET ROLE` reaches the other role's privileges, so
    any membership is refused, whatever its options say."""
    assert "member_of_roles" in runtime_privilege_problems(app_engine, role="pg_monitor")  # 3 memberships
    assert "member_of_roles" in runtime_privilege_problems(owner_engine)  # GRANT vms_app TO vms_owner
    assert "member_of_roles" not in runtime_privilege_problems(app_engine)


def _switched_engine(url: str, role: str) -> Engine:
    """A connection that logs in with `url` and then runs as `role` (a libpq startup option)."""
    return create_engine(
        url,
        poolclass=NullPool,
        connect_args={"options": f"{connection_options()} -c role={role}", "application_name": "vms-tests"},
    )


def test_a_connection_switched_to_the_runtime_role_is_judged_by_its_login_role(
    database: ThrowawayDatabase,
) -> None:
    """The verifier's set-up: the schema owner logs in and runs as the runtime role, so the check saw
    the runtime role's privileges, while `SET ROLE NONE` gives the owner's back on the same connection."""
    engine = _switched_engine(database.owner_url, database.app_role)
    try:
        with engine.connect() as connection:
            users = connection.execute(text("SELECT session_user <> current_user")).scalar_one()
        assert users is True
        problems = set(runtime_privilege_problems(engine))
        assert {"switched_role", "owns_schema_objects", "deletes_rows", "changes_audit_rows"} <= problems
        with pytest.raises(ConfigurationError, match="switched_role"):
            require_runtime_privileges(engine)
    finally:
        engine.dispose()


@pytest.fixture
def owner_runs_as_runtime_role(
    create_database: Callable[[str], ThrowawayDatabase],
) -> Iterator[ThrowawayDatabase]:
    """A migrated database in which the schema owner's connections start as the runtime role (a role
    default, `ALTER ROLE ... IN DATABASE ... SET role`: the engine's startup options cannot override what
    they do not name)."""
    database = create_database("vms_role_switch")
    command.upgrade(alembic_config(database), "head")
    engine = create_db_engine(database.owner_url, pool_size=1, application_name="vms-tests-switch")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(f'ALTER ROLE CURRENT_USER IN DATABASE "{database.name}" SET role = {database.app_role}')
            )
        yield database
    finally:
        with engine.begin() as connection:
            connection.execute(text("SET ROLE NONE"))
            connection.execute(text(f'ALTER ROLE CURRENT_USER IN DATABASE "{database.name}" RESET ALL'))
        engine.dispose()


def test_a_role_default_that_switches_roles_is_refused(owner_runs_as_runtime_role: ThrowawayDatabase) -> None:
    engine = create_db_engine(owner_runs_as_runtime_role.owner_url, pool_size=1)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT current_user")).scalar_one() == (
                owner_runs_as_runtime_role.app_role
            )
        assert "switched_role" in runtime_privilege_problems(engine)
        assert runtime_role_settings(engine) == ["role"]  # the login role's own default
        with pytest.raises(ConfigurationError, match="restricted runtime role"):
            require_runtime_privileges(engine)
    finally:
        engine.dispose()


@pytest.mark.usefixtures("local_passwords_accepted")
def test_production_starts_with_the_runtime_role(
    settings: Settings, database: ThrowawayDatabase, app_engine: Engine, hasher: PasswordHasherService
) -> None:
    app = create_app(
        _production(settings, database),
        engine=app_engine,
        password_hasher=hasher,
        email_provider=MemoryProvider(),
    )
    with TestClient(app, base_url="https://testserver") as client:
        assert client.get("/api/v1/health").status_code == 200


def test_production_refuses_to_start_as_the_schema_owner(
    settings: Settings, database: ThrowawayDatabase, owner_engine: Engine, hasher: PasswordHasherService
) -> None:
    """The finding's set-up: DATABASE_URL pointed at the owner (the same credential for both URLs is the
    usual shortcut; `_check_production` refuses that spelling, this check whatever the role is called)."""
    app = create_app(
        _production(settings, database),
        engine=owner_engine,
        password_hasher=hasher,
        email_provider=MemoryProvider(),
    )
    with (
        pytest.raises(ConfigurationError, match="restricted runtime role") as caught,
        TestClient(app, base_url="https://testserver"),
    ):
        pass  # pragma: no cover - startup fails
    assert "owns_schema_objects" in str(caught.value)
    assert database.app_role not in str(caught.value) and "vms_owner" not in str(caught.value)


def test_outside_production_nothing_is_checked(
    settings: Settings, owner_engine: Engine, hasher: PasswordHasherService
) -> None:
    app = create_app(settings, engine=owner_engine, password_hasher=hasher, email_provider=MemoryProvider())
    with TestClient(app, base_url="https://testserver") as client:
        assert client.get("/api/v1/health").status_code == 200


# ---- the runtime role's own defaults (SEC-38) ----------------------------------------------------

# Defaults a holder of the runtime credential can give the role for good (ALTER ROLE … SET).
PLANTED = {
    "default_transaction_read_only": "on",  # every write fails, /health stays "ok"
    "default_transaction_isolation": "'repeatable read'",  # the SEC-07 re-checks read stale snapshots
    "search_path": "pg_catalog",
    "synchronous_commit": "off",  # not pinned: refused at startup instead
}


@pytest.fixture
def planted(create_database: Callable[[str], ThrowawayDatabase]) -> Iterator[ThrowawayDatabase]:
    """A migrated database for which the runtime role gave itself the defaults above (scoped to this
    database: the role is shared with the other databases of the cluster)."""
    database = create_database("vms_role_defaults")
    command.upgrade(alembic_config(database), "head")
    engine = create_db_engine(database.app_url, pool_size=1, application_name="vms-tests-plant")
    try:
        with engine.begin() as connection:
            for name, value in PLANTED.items():
                connection.execute(
                    text(f'ALTER ROLE CURRENT_USER IN DATABASE "{database.name}" SET {name} = {value}')
                )
        yield database
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'ALTER ROLE CURRENT_USER IN DATABASE "{database.name}" RESET ALL'))
        engine.dispose()


def test_planted_role_defaults_do_not_reach_the_applications_connections(planted: ThrowawayDatabase) -> None:
    engine = create_db_engine(planted.app_url, pool_size=1)
    try:
        with engine.connect() as connection:
            shown = {name: connection.execute(text(f"SHOW {name}")).scalar_one() for name in PLANTED}
        assert shown["default_transaction_read_only"] == "off"
        assert shown["default_transaction_isolation"] == "read committed"
        assert shown["search_path"] == "public"
        assert shown["synchronous_commit"] == "off"  # the planted value: production refuses to start
        with Session(engine) as db:  # writes work
            db.add(Company(name="Writable", slug=f"writable-{uuid.uuid4().hex[:8]}", timezone="UTC"))
            db.commit()
    finally:
        engine.dispose()


def test_production_refuses_a_runtime_role_with_defaults_of_its_own(
    settings: Settings, database: ThrowawayDatabase, planted: ThrowawayDatabase, hasher: PasswordHasherService
) -> None:
    engine = create_db_engine(planted.app_url, pool_size=1)
    try:
        assert runtime_privilege_problems(engine) == []  # the privileges are those of the runtime role
        assert runtime_role_settings(engine) == sorted(PLANTED)
        app = create_app(
            _production(settings, database),
            engine=engine,
            password_hasher=hasher,
            email_provider=MemoryProvider(),
        )
        with (
            pytest.raises(ConfigurationError, match="default settings of its own") as caught,
            TestClient(app, base_url="https://testserver"),
        ):
            pass  # pragma: no cover - startup fails
        assert all(name in str(caught.value) for name in PLANTED)
        assert database.app_role not in str(caught.value) and "repeatable" not in str(caught.value)
    finally:
        engine.dispose()


@pytest.mark.usefixtures("local_passwords_accepted")
def test_the_runtime_role_has_no_defaults_of_its_own(app_engine: Engine) -> None:
    assert runtime_role_settings(app_engine) == []
    require_runtime_privileges(app_engine)


# ---- a failed startup connection (SEC-36) --------------------------------------------------------


def test_a_failed_startup_connection_does_not_print_the_database_url(
    settings: Settings, database: ThrowawayDatabase, hasher: PasswordHasherService
) -> None:
    """The finding: a password with an unencoded "@" made the driver try the host "Zx9-Secret@localhost",
    and its error, with that end of the password, reached the startup log (uvicorn logs the traceback of
    a failed startup as text). Configuration now refuses such a URL; this is the backstop for any other
    connection failure at startup: only the error's class and SQLSTATE are reported."""
    engine = create_db_engine(
        "postgresql+psycopg://vms_app:Tr0ub4dor@Zx9-Secret@localhost:5433/vms", pool_size=1
    )
    try:
        app = create_app(
            _production(settings, database),
            engine=engine,
            password_hasher=hasher,
            email_provider=MemoryProvider(),
        )
        with (
            pytest.raises(ConfigurationError, match="could not check the runtime database role") as caught,
            TestClient(app, base_url="https://testserver"),
        ):
            pass  # pragma: no cover - startup fails
        logged = "".join(traceback.format_exception(caught.value))
        assert "OperationalError" in logged
        for leaked in ("Zx9", "Secret", "Tr0ub4dor", "vms_app"):
            assert leaked not in logged
    finally:
        engine.dispose()


# ---- table privileges beyond the migrations' grants (SEC-R7) ---------------------------------------
# The check refused only DELETE and TRUNCATE anywhere and UPDATE, TRIGGER and INSERT(seq) on audit_logs.
# GRANT ALL followed by revoking exactly what its error named passed, leaving MAINTAIN (ACCESS EXCLUSIVE
# on audit_logs: every audited write stalls), TRIGGER (attaching audit_logs_immutable() to visits: every
# visit change fails), REFERENCES, and writes to alembic_version.


def _owner_runs(database: ThrowawayDatabase, *statements: str) -> None:
    engine = create_db_engine(database.owner_url, pool_size=1, application_name="vms-tests-grants")
    try:
        with engine.begin() as connection:
            for statement in statements:
                connection.execute(text(statement.format(role=database.app_role)))
    finally:
        engine.dispose()


def _problems(database: ThrowawayDatabase) -> list[str]:
    engine = create_db_engine(database.app_url, pool_size=1, application_name="vms-tests-grants")
    try:
        return runtime_privilege_problems(engine)
    finally:
        engine.dispose()


@pytest.fixture(scope="module")
def grantable(create_database: Callable[[str], ThrowawayDatabase]) -> ThrowawayDatabase:
    """A migrated database whose grants the tests change and restore (the shared one stays as migrated)."""
    database = create_database("vms_grants")
    command.upgrade(alembic_config(database), "head")
    return database


def test_grant_all_then_revoking_what_the_error_named_is_still_refused(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """The finding's misprovisioning, step by step, on a database of its own."""
    database = create_database("vms_grant_all")
    command.upgrade(alembic_config(database), "head")
    _owner_runs(database, "GRANT ALL ON ALL TABLES IN SCHEMA public TO {role}")
    assert {"changes_audit_rows", "chooses_audit_order", "deletes_rows"} <= set(_problems(database))
    _owner_runs(
        database,
        "REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM {role}",
        "REVOKE UPDATE, TRIGGER, INSERT ON audit_logs FROM {role}",
        "GRANT INSERT (id, company_id, actor_user_id, action, entity_type, entity_id, metadata, ip_address, "
        "user_agent, request_id, created_at) ON audit_logs TO {role}",
    )
    # The platform's trail (revision 0013) is refused alike until its grants are put back as well.
    assert {"changes_audit_rows", "chooses_audit_order"} <= set(_problems(database))
    _owner_runs(
        database,
        "REVOKE UPDATE, TRIGGER, INSERT ON platform_audit_logs FROM {role}",
        "GRANT INSERT (id, actor_platform_admin_id, company_id, action, entity_type, entity_id, metadata, "
        "ip_address, user_agent, request_id, created_at) ON platform_audit_logs TO {role}",
    )
    problems = _problems(database)
    assert problems == ["maintains_tables", "adds_triggers", "references_tables", "accesses_migration_state"]
    engine = create_db_engine(database.app_url, pool_size=1)
    try:
        with pytest.raises(ConfigurationError, match="maintains_tables, adds_triggers") as caught:
            require_runtime_privileges(engine)
    finally:
        engine.dispose()
    assert database.app_role not in str(caught.value)


@pytest.mark.parametrize(
    ("grant", "revoke", "problem"),
    [
        (
            "GRANT MAINTAIN ON audit_logs TO {role}",
            "REVOKE MAINTAIN ON audit_logs FROM {role}",
            "maintains_tables",
        ),
        ("GRANT TRIGGER ON visits TO {role}", "REVOKE TRIGGER ON visits FROM {role}", "adds_triggers"),
        (
            "GRANT REFERENCES ON visitors TO {role}",
            "REVOKE REFERENCES ON visitors FROM {role}",
            "references_tables",
        ),
        (
            "GRANT REFERENCES (id) ON users TO {role}",
            "REVOKE REFERENCES (id) ON users FROM {role}",
            "references_tables",
        ),
        (
            "GRANT SELECT ON alembic_version TO {role}",
            "REVOKE SELECT ON alembic_version FROM {role}",
            "accesses_migration_state",
        ),
        (
            "GRANT UPDATE (metadata) ON audit_logs TO {role}",
            "REVOKE UPDATE (metadata) ON audit_logs FROM {role}",
            "changes_audit_rows",
        ),
        (
            "GRANT USAGE ON SEQUENCE audit_logs_seq_seq TO {role}",
            "REVOKE USAGE ON SEQUENCE audit_logs_seq_seq FROM {role}",
            "chooses_audit_order",
        ),
        # Through PUBLIC, which every role holds.
        ("GRANT MAINTAIN ON visits TO PUBLIC", "REVOKE MAINTAIN ON visits FROM PUBLIC", "maintains_tables"),
        ("GRANT TRIGGER ON users TO PUBLIC", "REVOKE TRIGGER ON users FROM PUBLIC", "adds_triggers"),
        ("GRANT DELETE ON visits TO PUBLIC", "REVOKE DELETE ON visits FROM PUBLIC", "deletes_rows"),
    ],
)
def test_privileges_beyond_the_migrations_grants_are_refused(
    grantable: ThrowawayDatabase, grant: str, revoke: str, problem: str
) -> None:
    assert _problems(grantable) == []
    _owner_runs(grantable, grant)
    try:
        assert _problems(grantable) == [problem]
    finally:
        _owner_runs(grantable, revoke)
    assert _problems(grantable) == []


@pytest.mark.parametrize(
    ("grant", "revoke"),
    [
        # What a later migration's tables and sequences get from the schema's default privileges.
        ("CREATE TABLE later_table (id integer)", "DROP TABLE later_table"),
        ("CREATE SEQUENCE later_sequence", "DROP SEQUENCE later_sequence"),
        # Within what the migrations grant: a column subset, and PUBLIC reading a business table.
        (
            "GRANT SELECT (id, action) ON audit_logs TO {role}",
            "REVOKE SELECT (id, action) ON audit_logs FROM {role}",
        ),
        ("GRANT SELECT ON visits TO PUBLIC", "REVOKE SELECT ON visits FROM PUBLIC"),
    ],
)
def test_the_migrations_grants_and_default_privileges_pass(
    grantable: ThrowawayDatabase, grant: str, revoke: str
) -> None:
    _owner_runs(grantable, grant)
    try:
        assert _problems(grantable) == []
    finally:
        _owner_runs(grantable, revoke)


# ---- a published password, wherever libpq takes it from (SEC-R6) -----------------------------------


@pytest.fixture
def cluster_password(app_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> str:
    """The runtime role's password on the test cluster, treated as a published one whatever it is (with
    the repository's .env it is the published `vms_app_local_dev` anyway)."""
    password = app_engine.url.password
    if not password:
        pytest.skip("the test database is reached without a password")
    monkeypatch.setattr(config, "PUBLISHED_DB_PASSWORD_MARKERS", (password.lower(),))
    return password


def test_production_refuses_to_start_with_a_published_password(
    settings: Settings,
    database: ThrowawayDatabase,
    app_engine: Engine,
    hasher: PasswordHasherService,
    cluster_password: str,
) -> None:
    app = create_app(
        _production(settings, database),
        engine=app_engine,
        password_hasher=hasher,
        email_provider=MemoryProvider(),
    )
    with (
        pytest.raises(ConfigurationError, match="published local-development password") as caught,
        TestClient(app, base_url="https://testserver"),
    ):
        pass  # pragma: no cover - startup fails
    assert cluster_password not in str(caught.value) and database.app_role not in str(caught.value)


def _escaped(field: str) -> str:
    return field.replace("\\", "\\\\").replace(":", "\\:")


@pytest.mark.parametrize("source", ["PGPASSWORD", "PGPASSFILE"])
def test_production_refuses_a_published_password_wherever_libpq_takes_it(
    database: ThrowawayDatabase,
    cluster_password: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    source: str,
) -> None:
    """The finding: configuration read only the URL's user:password part, and a password given any other
    way passed. Configuration now also reads a `password` parameter and PGPASSWORD; a password file or a
    connection service entry it cannot read, so the startup check asks the connection which password it
    used (libpq's PQpass)."""
    url = make_url(database.app_url)
    monkeypatch.delenv("PGPASSWORD", raising=False)
    if source == "PGPASSWORD":
        monkeypatch.setenv("PGPASSWORD", cluster_password)
    else:
        passfile = tmp_path / "pgpass.conf"
        passfile.write_text(
            f"*:*:*:{_escaped(url.username or '')}:{_escaped(cluster_password)}\n", encoding="utf-8"
        )
        passfile.chmod(0o600)  # libpq ignores a password file others can read (POSIX)
        monkeypatch.setenv("PGPASSFILE", str(passfile))
    engine = create_db_engine(url.set(password=None).render_as_string(hide_password=False), pool_size=1)
    try:
        assert runtime_privilege_problems(engine) == []  # the role itself is the runtime role
        assert runtime_password_is_published(engine) is True
        with pytest.raises(ConfigurationError, match="published local-development password") as caught:
            require_runtime_privileges(engine)
    finally:
        engine.dispose()
    assert cluster_password not in str(caught.value)
