"""Bounded waits for the database (readiness round 1).

Before this round the application's engine had no connect timeout (psycopg waits 130 s), the pool's
30 s wait, and no statement or lock timeout: a database that accepts TCP and never answers held every
request for up to 130 s, filled the request worker threads, and GET /health (same pool, sync route)
could not answer within the container health check's 5 s.

Re-audit round 1: the interrupted-delivery sweep logs an outage as one WARNING line, like every other
path that meets one (tests at the end).
"""

import logging
import secrets
import socket
import time
from collections.abc import Callable, Iterator

import anyio
import anyio.to_thread
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app import main as main_module
from app.core.config import Settings
from app.db.session import (
    DatabaseTimeouts,
    create_app_engine,
    create_db_engine,
    make_sessionmaker,
    session_factory,
)
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.security.passwords import PasswordHasherService
from app.services.health import DatabaseProbe
from tests.support import TEST_CLIENT_ADDRESS, Api, error_code


@pytest.fixture
def silent_database(settings: Settings) -> Iterator[str]:
    """The runtime URL pointed at a TCP port that accepts connections and never answers (a black-holed
    or hung server): the kernel completes the handshake for the listen backlog, nothing ever replies."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(64)
    port = listener.getsockname()[1]
    url = make_url(settings.runtime_url).set(host="127.0.0.1", port=port)
    try:
        yield url.render_as_string(hide_password=False)
    finally:
        listener.close()


def test_the_application_engine_pins_its_timeouts(settings: Settings) -> None:
    engine = create_app_engine(settings)
    try:
        with engine.connect() as connection:
            row = connection.execute(
                text("SELECT current_setting('statement_timeout'), current_setting('lock_timeout')")
            ).one()
            parameters = connection.connection.dbapi_connection.info.get_parameters()  # type: ignore[union-attr]
        assert tuple(row) == ("30s", "10s")
        assert parameters["connect_timeout"] == "5"
        assert (parameters["keepalives"], parameters["keepalives_idle"]) == ("1", "30")
        assert engine.pool.timeout() == 5  # type: ignore[attr-defined]
    finally:
        engine.dispose()


def test_parameters_the_url_gives_are_kept(settings: Settings) -> None:
    url = (
        make_url(settings.runtime_url)
        .update_query_dict({"connect_timeout": "9"})
        .render_as_string(hide_password=False)
    )
    engine = create_db_engine(url, pool_size=1, timeouts=DatabaseTimeouts())
    try:
        with engine.connect() as connection:
            parameters = connection.connection.dbapi_connection.info.get_parameters()  # type: ignore[union-attr]
        assert parameters["connect_timeout"] == "9"
    finally:
        engine.dispose()


def test_a_database_that_never_answers_fails_within_the_connect_timeout(silent_database: str) -> None:
    engine = create_db_engine(silent_database, pool_size=1, timeouts=DatabaseTimeouts(connect_seconds=2))
    started = time.monotonic()
    try:
        with pytest.raises(OperationalError), engine.connect():
            pass  # pragma: no cover - the connection never opens
    finally:
        engine.dispose()
    assert time.monotonic() - started < 8  # psycopg's own default: 130 s


def test_statements_and_lock_waits_are_cancelled(settings: Settings) -> None:
    engine = create_db_engine(
        settings.runtime_url, pool_size=2, timeouts=DatabaseTimeouts(statement_ms=1_000, lock_ms=500)
    )
    try:
        started = time.monotonic()
        with pytest.raises(OperationalError, match="QueryCanceled"), engine.connect() as connection:
            connection.execute(text("SELECT pg_sleep(5)"))
        assert time.monotonic() - started < 4
        with engine.connect() as holder, engine.connect() as waiter:
            holder.execute(text("SELECT pg_advisory_lock(7310)"))
            try:
                started = time.monotonic()
                with pytest.raises(OperationalError, match="LockNotAvailable"):
                    waiter.execute(text("SELECT pg_advisory_xact_lock(7310)"))
                assert time.monotonic() - started < 4
            finally:
                holder.execute(text("SELECT pg_advisory_unlock(7310)"))
    finally:
        engine.dispose()


@pytest.fixture
def tiny_pool_app(settings: Settings, hasher: PasswordHasherService) -> Iterator[tuple[FastAPI, Engine]]:
    """An application whose requests use a pool of two connections with a 1 s wait (no test
    transaction: `session_factory` points at that pool)."""
    engine = create_db_engine(settings.runtime_url, pool_size=1, timeouts=DatabaseTimeouts(pool_seconds=1))
    app = create_app(settings, engine=engine, password_hasher=hasher, email_provider=MemoryProvider())
    session_factory.override(make_sessionmaker(engine))
    try:
        yield app, engine
    finally:
        session_factory.clear_override()
        engine.dispose()


def test_an_exhausted_pool_answers_service_busy(tiny_pool_app: tuple[FastAPI, Engine]) -> None:
    app, engine = tiny_pool_app
    api = Api(TestClient(app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS))
    with engine.connect(), engine.connect():  # every pooled connection busy (pool_size + overflow)
        started = time.monotonic()
        response = api.login("nobody@example.com", "Some-Password-123")
        elapsed = time.monotonic() - started
    assert response.status_code == 503 and error_code(response) == "SERVICE_BUSY"  # not a 500
    assert elapsed < 5
    with pytest.raises(PoolTimeoutError), engine.connect(), engine.connect(), engine.connect():
        pass  # pragma: no cover


def test_health_answers_in_time_while_the_database_hangs(
    client: TestClient, silent_database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client.app.state, "database_probe", DatabaseProbe(silent_database))  # type: ignore[attr-defined]
    started = time.monotonic()
    response = Api(client).get("/health")
    assert response.status_code == 503
    assert response.json()["error"]["details"] == {"database": "unavailable"}
    assert time.monotonic() - started < 4.5  # the container health check gives up after 5 s


def test_health_answers_while_every_request_thread_waits(shared_app: FastAPI) -> None:
    """GET /health no longer needs a request worker thread: with all of them taken (requests waiting for
    the database, or deliveries before this round), it still answers."""
    statuses: list[int] = []

    async def main() -> None:
        default = anyio.to_thread.current_default_thread_limiter()
        holders = [object() for _ in range(int(default.total_tokens))]
        for holder in holders:
            await default.acquire_on_behalf_of(holder)
        try:
            transport = httpx.ASGITransport(app=shared_app, client=TEST_CLIENT_ADDRESS)
            async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
                with anyio.fail_after(10):
                    statuses.append((await client.get("/api/v1/health")).status_code)
        finally:
            for holder in holders:
                default.release_on_behalf_of(holder)

    anyio.run(main)
    assert statuses == [200]


def test_the_probe_reuses_a_result_for_a_second(settings: Settings) -> None:
    now = [100.0]
    probe = DatabaseProbe(settings.runtime_url, monotonic=lambda: now[0])
    connects: list[int] = []
    real: Callable[[], Engine] = probe._connect_engine

    def counting() -> Engine:
        connects.append(1)
        return real()

    probe._connect_engine = counting  # type: ignore[method-assign]
    try:
        assert probe.check() and probe.check()
        assert len(connects) == 1
        now[0] += 1.0
        assert probe.check()
        assert len(connects) == 2
    finally:
        probe.dispose()


# ---- the interrupted-delivery sweep during an outage (re-audit round 1) -------------------------------
# The sweep runs before the application serves and every minute. It logged every failure with
# `logger.exception`: during an outage, one ERROR record with a ~145-line traceback per run, where every
# other path that meets an outage writes one WARNING line without a traceback.

SWEEP_SKIPPED = "closing interrupted e-mail deliveries skipped: database unavailable ({})"


def _sweep_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "app.main"]


def _assert_one_line_without_traceback(caplog: pytest.LogCaptureFixture, error_class: str) -> None:
    (record,) = _sweep_records(caplog)
    assert (record.levelno, record.getMessage()) == (logging.WARNING, SWEEP_SKIPPED.format(error_class))
    assert record.exc_info is None and record.exc_text is None
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR or record.exc_info]
    assert "Traceback" not in caplog.text


@pytest.fixture
def sweep_database() -> Iterator[Callable[[Engine], None]]:
    """Points the sweep's sessions at an engine of the test's choosing (no test transaction)."""
    engines: list[Engine] = []

    def use(engine: Engine) -> None:
        engines.append(engine)
        session_factory.override(make_sessionmaker(engine))

    yield use
    session_factory.clear_override()
    for engine in engines:
        engine.dispose()


def test_an_outage_at_startup_is_one_warning_without_traceback(
    settings: Settings, hasher: PasswordHasherService, caplog: pytest.LogCaptureFixture
) -> None:
    """The finding's case: the database is missing when the API starts. The application still starts,
    answers 503, and the startup sweep writes one WARNING line."""
    missing = make_url(settings.runtime_url).set(database=f"vms_missing_{secrets.token_hex(4)}")
    configured = settings.model_copy(update={"database_url": SecretStr(missing.render_as_string(False))})
    default = session_factory._default  # create_app points the default at its own engine
    try:
        with caplog.at_level(logging.WARNING):
            app = create_app(configured, password_hasher=hasher, email_provider=MemoryProvider())
            with TestClient(app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS) as client:
                health = Api(client).get("/health")
                login = Api(client).login("nobody@example.com", "Some-Password-123")
    finally:
        session_factory._default = default
    assert health.status_code == 503 and health.json()["error"]["details"] == {"database": "unavailable"}
    assert login.status_code == 503 and error_code(login) == "SERVICE_BUSY"
    _assert_one_line_without_traceback(caplog, "OperationalError")


def test_a_hung_database_is_one_warning_without_traceback(
    silent_database: str, sweep_database: Callable[[Engine], None], caplog: pytest.LogCaptureFixture
) -> None:
    """A black-holed server: the connect timeout ends the run (psycopg's ConnectionTimeout)."""
    sweep_database(
        create_db_engine(silent_database, pool_size=1, timeouts=DatabaseTimeouts(connect_seconds=1))
    )
    with caplog.at_level(logging.WARNING):
        anyio.run(main_module._fail_interrupted_deliveries)
    _assert_one_line_without_traceback(caplog, "ConnectionTimeout")


def test_a_full_pool_is_one_warning_without_traceback(
    settings: Settings, sweep_database: Callable[[Engine], None], caplog: pytest.LogCaptureFixture
) -> None:
    engine = create_db_engine(settings.runtime_url, pool_size=1, timeouts=DatabaseTimeouts(pool_seconds=1))
    sweep_database(engine)
    with engine.connect(), engine.connect(), caplog.at_level(logging.WARNING):  # pool and overflow taken
        anyio.run(main_module._fail_interrupted_deliveries)
    _assert_one_line_without_traceback(caplog, "TimeoutError")


def test_an_unexpected_sweep_failure_keeps_its_traceback(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def defect() -> None:
        raise RuntimeError("a defect in the sweep")

    monkeypatch.setattr(main_module, "fail_interrupted", defect)
    with caplog.at_level(logging.WARNING):
        anyio.run(main_module._fail_interrupted_deliveries)
    (record,) = _sweep_records(caplog)
    assert (record.levelno, record.getMessage()) == (
        logging.ERROR,
        "closing interrupted e-mail deliveries failed",
    )
    assert record.exc_info is not None and record.exc_info[0] is RuntimeError
