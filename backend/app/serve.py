"""The run command of the API server: `python -m app.serve [--host HOST] [--port PORT]`.

Every deployment (local development, the Phase 9 Dockerfile, E2E runs) starts the server this way, so the
security-relevant server options cannot drift between them:

* `proxy_headers=False`: uvicorn's own proxy-header handling would rewrite the client address from
  `X-Forwarded-For` for any peer in FORWARDED_ALLOW_IPS (127.0.0.1 by default) before the application
  sees the request. TRUSTED_PROXIES (`app.core.client_ip`, contract §7.3) must be the only rule that
  decides when that header is believed.
* `server_header=False`: no `Server: uvicorn` header discloses the implementation.
* `access_log=False` and `log_config=None`: the application's JSON logging is the only configuration,
  and its access log omits query strings (uvicorn's would log them).
* `ws="none"`: the API has no WebSocket routes. With uvicorn's default ("auto", and `websockets` installed
  by uvicorn[standard]) an upgrade request was handled by uvicorn's WebSocket protocol before the
  application: no request ID, security headers or access-log line, a "WebSocket <path>?<query> 403" line
  with the query string, and at LOG_LEVEL=DEBUG every request header, cookies included (SEC-45). Now an
  upgrade request is an ordinary HTTP request, answered and logged by the application.
* `workers=1`: the rate limiter is in-memory; run one worker per instance (contract §3).
* `factory=True`: importing `app.main` must not read configuration or create engines. The factory is
  `create_served_app`: the application with the e-mails' logos drawn ahead of the requests that send
  them (B13-7), which an application built by a test leaves out.
* `timeout_graceful_shutdown`: on SIGTERM uvicorn stops accepting connections and waits for the
  requests in flight and their background tasks (e-mail delivery). Unbounded, that wait lasted as long
  as they did (47 s for an e-mail retrying against a provider that does not answer; a request blocked
  on a row lock waits as long as the lock is held), past docker-compose.yml's `stop_grace_period`, and
  the SIGKILL that followed skipped the lifespan shutdown, which writes the coalesced security-event
  counts (`SecurityAudit.flush`). After GRACEFUL_SHUTDOWN_SECONDS uvicorn cancels what still runs, runs
  the lifespan shutdown and re-raises the signal, whose default action ends the process although a
  worker thread may still be busy (threads cannot be interrupted; what one had not committed is lost,
  as with any kill). As PID 1 the process would ignore that signal and wait for the thread, so the
  container runs an init (`init: true`). The compose `stop_grace_period` of the API leaves a margin
  above GRACEFUL_SHUTDOWN_SECONDS for the lifespan shutdown (`tests/unit/test_serve.py` checks it).
  Not covered here: cancelling a request that is blocked inside PostgreSQL stalls the event loop until
  that statement ends (the request session's cleanup, docs/decisions/phase-9-deploy.md D9-32).

Host and port come from SERVER_HOST / SERVER_PORT, overridable with --host / --port.
"""

import argparse
from collections.abc import Sequence
from typing import Any

import uvicorn

from app.core.config import Settings, get_settings

APP_FACTORY = "app.main:create_served_app"
# Requests answer in well under a second: this only bounds a stuck one, or an e-mail still retrying.
GRACEFUL_SHUTDOWN_SECONDS = 20


def server_options(settings: Settings, *, host: str | None = None, port: int | None = None) -> dict[str, Any]:
    """Keyword arguments for `uvicorn.run` / `uvicorn.Config`."""
    return {
        "app": APP_FACTORY,
        "factory": True,
        "host": host or settings.server_host,
        "port": port or settings.server_port,
        "proxy_headers": False,
        "server_header": False,
        "access_log": False,
        "log_config": None,
        "ws": "none",
        "workers": 1,
        "timeout_graceful_shutdown": GRACEFUL_SHUTDOWN_SECONDS,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.serve", description="Run the API server.")
    parser.add_argument("--host", help="address to listen on (default: SERVER_HOST)")
    parser.add_argument("--port", type=int, help="port to listen on (default: SERVER_PORT)")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    uvicorn.run(**server_options(get_settings(), host=args.host, port=args.port))


if __name__ == "__main__":
    main()
