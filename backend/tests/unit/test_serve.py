"""`python -m app.serve`, the one run command: the server options that decide security behaviour are fixed
in code (contract §7.3: TRUSTED_PROXIES alone decides when X-Forwarded-For is believed)."""

import inspect
import logging
import re
import socket
import threading
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path

import anyio.to_thread
import pytest
import uvicorn
import yaml
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app import main, serve
from app.core.config import Settings
from app.core.logging import PROTOCOL_LOGGERS, configure_logging
from app.core.middleware import FirstWrite


def _settings(**values) -> Settings:
    return Settings(_env_file=None, app_env="development", database_url="postgresql://u:p@h/d", **values)


def test_server_options() -> None:
    options = serve.server_options(_settings())
    assert options == {
        "app": "app.main:create_served_app",
        "factory": True,
        "host": "127.0.0.1",
        "port": 8000,
        "proxy_headers": False,
        "server_header": False,
        "access_log": False,
        "log_config": None,
        "ws": "none",
        "workers": 1,
        "timeout_graceful_shutdown": 20,
    }


def test_host_and_port_come_from_settings_or_arguments() -> None:
    settings = _settings(server_host="0.0.0.0", server_port=9000)  # noqa: S104 - a container listens on all interfaces
    assert serve.server_options(settings)["host"] == "0.0.0.0"  # noqa: S104
    assert serve.server_options(settings)["port"] == 9000
    overridden = serve.server_options(settings, host="127.0.0.1", port=8001)
    assert (overridden["host"], overridden["port"]) == ("127.0.0.1", 8001)
    args = serve.build_parser().parse_args(["--port", "8001"])
    assert args.port == 8001 and args.host is None


def test_uvicorn_proxy_header_rewriting_is_off() -> None:
    config = uvicorn.Config(**serve.server_options(_settings()))
    assert config.proxy_headers is False
    assert config.server_header is False and config.access_log is False and config.workers == 1


def test_main_runs_uvicorn_with_those_options(monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(serve.uvicorn, "run", lambda **kwargs: captured.update(kwargs))
    monkeypatch.setattr(serve, "get_settings", _settings)
    serve.main(["--host", "127.0.0.1", "--port", "8001"])
    assert captured["proxy_headers"] is False and captured["port"] == 8001 and captured["factory"] is True


# ---- shutdown --------------------------------------------------------------------------------------

COMPOSE_FILE = Path(__file__).resolve().parents[3] / "docker-compose.yml"
# What the lifespan shutdown needs after the graceful wait: cancelling the sweeper, writing the
# coalesced security-event counts (one INSERT per window) and disposing of the engine. Normally
# milliseconds; the margin also covers a pool whose connections are all held by stuck requests.
LIFESPAN_SHUTDOWN_MARGIN_SECONDS = 20


def _compose_seconds(value: str) -> int:
    match = re.fullmatch(r"(?:(\d+)m)?(?:(\d+)s)?", value)
    assert match and value, f"unexpected compose duration {value!r}"
    return int(match[1] or 0) * 60 + int(match[2] or 0)


def test_graceful_shutdown_is_bounded_below_the_compose_stop_grace_period() -> None:
    """The finding: no bound, so a stuck request (128 s) or an e-mail retrying (47 s) outlasted compose's
    30 s grace period; the SIGKILL skipped the lifespan shutdown and its flush of coalesced counts."""
    assert uvicorn.Config(**serve.server_options(_settings())).timeout_graceful_shutdown == 20
    backend = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))["services"]["backend"]
    grace = _compose_seconds(backend["stop_grace_period"])
    assert grace >= serve.GRACEFUL_SHUTDOWN_SECONDS + LIFESPAN_SHUTDOWN_MARGIN_SECONDS
    # The image's CMD (python -m app.serve), not PID 1: the re-raised SIGTERM must be able to end it.
    assert "command" not in backend and "entrypoint" not in backend
    assert backend.get("init") is True


def test_a_stuck_request_no_longer_delays_the_lifespan_shutdown(monkeypatch) -> None:
    """With the server as `app.serve` configures it, a request blocked in a worker thread (like a sync
    endpoint waiting on a row lock) is cancelled after GRACEFUL_SHUTDOWN_SECONDS, and the lifespan
    shutdown, where the API flushes its coalesced security-event counts, runs while it is still blocked.
    Without the bound the server waited for the request (here: until the test releases it)."""
    monkeypatch.setattr(serve, "GRACEFUL_SHUTDOWN_SECONDS", 1)
    entered, release, flushed = threading.Event(), threading.Event(), threading.Event()

    def stuck(_request: Request) -> PlainTextResponse:  # sync: runs in a worker thread, like the API's
        entered.set()
        release.wait(60)
        return PlainTextResponse("too late")

    @asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        yield
        await anyio.to_thread.run_sync(flushed.set)  # where the API runs SecurityAudit.flush

    app = Starlette(routes=[Route("/stuck", stuck)], lifespan=lifespan)
    options = {**serve.server_options(_settings()), "app": app, "factory": False}
    server = uvicorn.Server(uvicorn.Config(**options))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        for _ in range(500):
            if server.started:
                break
            time.sleep(0.01)
        assert server.started
        with socket.create_connection(listener.getsockname(), timeout=30) as client:
            client.sendall(b"GET /stuck HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            assert entered.wait(10)
            stopping = time.monotonic()
            server.should_exit = True  # what SIGTERM does
            assert flushed.wait(15), "the lifespan shutdown waited for the stuck request"
            elapsed = time.monotonic() - stopping
            assert not release.is_set()
            assert 0.9 <= elapsed < 10
            thread.join(timeout=10)
            assert not thread.is_alive()
    finally:
        release.set()
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()


# ---- upgrade requests (SEC-45) -------------------------------------------------------------------

SESSION_SECRET = "SessionSecretValue0123"
QUERY_SECRET = "QuerySecretValue4567"
UPGRADE_REQUEST = (
    f"GET /api/v1/visitors?q=zelda.private%40visitor-example.com&token={QUERY_SECRET} HTTP/1.1\r\n"
    "Host: 127.0.0.1\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    "Sec-WebSocket-Version: 13\r\n"
    f"Cookie: __Host-vms_session={SESSION_SECRET}; __Host-vms_csrf=CsrfSecretValue89\r\n"
    "\r\n"
)


class _Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def restored_logging() -> Iterator[None]:
    """The process-wide logging configuration as it was before the test (the test sets DEBUG)."""
    root = logging.getLogger()
    names = (*PROTOCOL_LOGGERS, "uvicorn.access")
    saved = (
        root.level,
        list(root.handlers),
        {name: (logging.getLogger(name).level, list(logging.getLogger(name).filters)) for name in names},
    )
    try:
        yield
    finally:
        root.setLevel(saved[0])
        root.handlers[:] = saved[1]
        for name, (level, filters) in saved[2].items():
            logging.getLogger(name).setLevel(level)
            logging.getLogger(name).filters[:] = filters


def _serve_one(settings: Settings, request: str) -> bytes:
    """Run the server as `app.serve` configures it (with a stand-in application that has no routes, like
    the API has no WebSocket routes) on a loopback port, send `request` and return the response."""
    options = {**serve.server_options(settings), "app": Starlette(routes=[]), "factory": False}
    server = uvicorn.Server(uvicorn.Config(**options))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        for _ in range(500):
            if server.started:
                break
            time.sleep(0.01)
        assert server.started
        with socket.create_connection(listener.getsockname(), timeout=5) as client:
            client.sendall(request.encode())
            return client.recv(65536)
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()


@pytest.mark.usefixtures("restored_logging")
def test_an_upgrade_request_is_plain_http_and_logs_neither_headers_nor_query() -> None:
    """The finding: with uvicorn's WebSocket protocol (`ws="auto"`), a handshake skipped the application,
    uvicorn logged '"WebSocket <path>?<query>" 403' with the query string, and at LOG_LEVEL=DEBUG every
    request header ('< cookie: __Host-vms_session=…'), which a log reader could replay. The server now
    has no WebSocket protocol, so the request is plain HTTP for the application (here: 404)."""
    settings = _settings(log_level="DEBUG")
    configure_logging(settings)
    collected = _Collect()
    logging.getLogger().addHandler(collected)
    response = _serve_one(settings, UPGRADE_REQUEST)
    logged = "\n".join(record.getMessage() for record in collected.records)
    for leaked in (SESSION_SECRET, "CsrfSecretValue89", QUERY_SECRET, "zelda", "< cookie", "WebSocket /"):
        assert leaked not in logged
    assert "No supported WebSocket library" not in logged  # wrong advice: the protocol is off on purpose
    assert response.startswith(b"HTTP/1.1 404")  # the application's answer, not a refused handshake


@pytest.mark.usefixtures("restored_logging")
def test_debug_logging_keeps_protocol_loggers_at_info() -> None:
    """LOG_LEVEL=DEBUG is for the application's loggers; the protocol libraries write raw request data
    into their debug messages, past the redaction of `extra` fields."""
    configure_logging(_settings(log_level="DEBUG"))
    assert logging.getLogger("app.test").isEnabledFor(logging.DEBUG)
    for name in (*PROTOCOL_LOGGERS, "websockets.server"):
        assert logging.getLogger(name).getEffectiveLevel() == logging.INFO
    configure_logging(_settings(log_level="WARNING"))
    assert logging.getLogger("uvicorn.error").getEffectiveLevel() == logging.WARNING


# ---- the application as served (B13-7) ----------------------------------------------------------------


def test_the_served_application_draws_the_e_mails_logos_ahead(monkeypatch: pytest.MonkeyPatch) -> None:
    """The run command's factory is `create_app` with the e-mails' logos drawn ahead; an application a
    test builds (`create_app` itself) leaves that out."""
    assert inspect.signature(main.create_app).parameters["warm_email_logos"].default is False
    calls: list[dict] = []
    monkeypatch.setattr(main, "create_app", lambda **options: calls.append(options) or "application")
    assert serve.APP_FACTORY == "app.main:create_served_app"
    assert main.create_served_app() == "application" and calls == [{"warm_email_logos": True}]


def test_the_first_write_calls_back_once_and_never_stops_a_request(caplog: pytest.LogCaptureFixture) -> None:
    async def answer(request: Request) -> PlainTextResponse:
        return PlainTextResponse(request.method)

    inner = Starlette(routes=[Route("/", answer, methods=["GET", "HEAD", "POST", "DELETE"])])
    calls: list[str] = []
    client = TestClient(FirstWrite(inner, callback=lambda: calls.append("called")))
    assert client.get("/").text == "GET" and client.head("/").status_code == 200
    assert calls == []  # a read is no write
    assert client.post("/").text == "POST" and client.delete("/").text == "DELETE"
    assert calls == ["called"]  # once

    def broken() -> None:
        raise RuntimeError("the callback failed")

    with caplog.at_level(logging.ERROR, logger="app.middleware"):
        assert TestClient(FirstWrite(inner, callback=broken)).post("/").text == "POST"
    failures = [record for record in caplog.records if record.name == "app.middleware"]
    assert [record.getMessage() for record in failures] == ["the first write's callback failed"]
    assert failures[0].exc_info is not None
