"""ASGI middleware.

`RequestContextMiddleware` (outermost): request ID (a trusted proxy's, otherwise generated), client IP,
access log without query strings, security headers, and the catch-all 500 envelope (no internals leak).

`BodySizeLimitMiddleware` (next): 413 PAYLOAD_TOO_LARGE for API bodies above MAX_REQUEST_BODY_BYTES, or
above a route's own limit (`BodyLimit`: the upload of a company's brand image, B12-6).

`CsrfOriginMiddleware`: the global CSRF/Origin enforcement of contract §7.2 for every unsafe method
under the API prefix:
  (a) `Sec-Fetch-Site: cross-site` is rejected; `same-site` only with an allowed Origin;
  (b) a present `Origin` must be in ALLOWED_ORIGINS;
  (c) requests carrying a live session must send `X-CSRF-Token` matching that session,
      except for the explicit exemption list (login, forgot-password, reset-password).
Requests under /api/v1/platform belong to the platform owner's realm (`CsrfRealm`, B11-6): their session
is the platform session cookie, matched against its own CSRF token, with its own exemption (sign-in).
Every failure is reported to `record_failure` with the live session behind the request, if any, so the
audit row is attributed to its user and company whichever check failed. When the session lookup that
check (c) needs cannot reach the database, the answer is 503 SERVICE_BUSY, as for every other request
during an outage: this middleware runs outside the exception handlers that map database errors.
All three are pure ASGI middleware so background tasks and context variables behave normally. Every
path-based decision (API or not, exemptions) uses `route_path`, the path the router dispatches on, so a
deployment under a `root_path` prefix cannot route around the checks.

`FirstWrite` (innermost, in the application as `python -m app.serve` runs it): calls back once, on the
first request with an unsafe method, so that the process that takes the writes, and with them sends
the e-mails, draws the e-mails' logos ahead (B13-7).
"""

import logging
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import anyio.to_thread
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.client_ip import client_ip_from_scope, peer_is_trusted_proxy
from app.core.config import API_PREFIX, Settings, normalise_origin
from app.core.errors import CsrfFailed, PayloadTooLarge, ServiceBusy, error_body, internal_error_body
from app.core.request_context import (
    REQUEST_ID_HEADER,
    accept_or_generate_request_id,
    reset_request_id,
    set_request_id,
)
from app.core.routing import is_public_path, route_path, route_template
from app.db.errors import database_error_summary

access_logger = logging.getLogger("app.access")
logger = logging.getLogger("app.middleware")

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

_COMMON_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
}
_API_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": (
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}
_HSTS = "max-age=31536000; includeSubDomains"
# API headers a route may set itself: the e-mail preview document (GET /email-templates/{kind}/preview)
# carries its own sandboxing Content-Security-Policy, which lets the administrator's page frame it, and a
# brand image its own (B12-9).
_ROUTE_DECIDES = frozenset({"Content-Security-Policy"})
# ... and, for the public identity endpoints alone (B12-9), how long an answer may be kept: a company's
# logo is the same for everyone and carries its version in its address. Everywhere else `no-store` is
# written over whatever a route set, so no answer to a signed-in person can ever be marked cacheable.
_PUBLIC_ROUTE_DECIDES = frozenset({"Cache-Control"})
# ... and only for an answer that is the thing asked for: the content, or "you already have it". An
# error is never kept, whatever set its headers (a missing company may exist tomorrow).
_KEPT_STATUSES = frozenset({200, 304})


def is_api_path(path: str) -> bool:
    """`path` must be a route path (`route_path(scope)`), never the raw `scope["path"]`."""
    return path == API_PREFIX or path.startswith(API_PREFIX + "/")


def _id_of(auth: object, name: str) -> str | None:
    value = getattr(auth, name, None)
    return None if value is None else str(value)


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp, *, settings: Settings) -> None:
        self.app = app
        self.trusted_proxies = tuple(settings.trusted_proxies)
        self.hsts = settings.is_production

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = accept_or_generate_request_id(
            Headers(scope=scope).get(REQUEST_ID_HEADER),
            from_trusted_proxy=peer_is_trusted_proxy(scope, self.trusted_proxies),
        )
        client_ip = client_ip_from_scope(scope, self.trusted_proxies)
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        state["client_ip"] = client_ip
        context_token = set_request_id(request_id)
        path: str = scope["path"]
        api = is_api_path(route_path(scope))
        route_decides = _ROUTE_DECIDES | (
            _PUBLIC_ROUTE_DECIDES if is_public_path(route_path(scope)) else frozenset()
        )
        started_at = time.perf_counter()
        response_started = False
        status_code = 500
        logged = False

        def log_access() -> None:
            """The access line, once: when the response's last byte is handed to the server (so
            `duration_ms` is the response time, not including background tasks such as e-mail delivery,
            which run afterwards), or when the request ends without a complete response."""
            nonlocal logged
            if logged:
                return
            logged = True
            auth = state.get("auth")  # set by the authentication dependency (`api.deps`)
            access_logger.info(
                "request",
                extra={
                    "method": scope["method"],
                    "path": path,  # never the query string: it can carry search terms or identifiers
                    "route": route_template(scope),  # `/api/v1/visits/{visit_id}`: aggregates by endpoint
                    "status": status_code,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
                    "client_ip": client_ip,
                    # IDs only (contract §3.2-8), so one tenant's or user's requests can be followed; the
                    # platform owner's requests carry `platform_admin_id` instead (B11-6).
                    "user_id": _id_of(auth, "user_id"),
                    "company_id": _id_of(auth, "company_id"),
                    "platform_admin_id": _id_of(auth, "platform_admin_id"),
                },
            )

        async def send_with_headers(message: Message) -> None:
            nonlocal response_started, status_code
            if message["type"] == "http.response.start":
                response_started = True
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers[REQUEST_ID_HEADER] = request_id
                for name, value in _COMMON_HEADERS.items():
                    headers.setdefault(name, value)
                if api:
                    decides = route_decides if status_code in _KEPT_STATUSES else _ROUTE_DECIDES
                    for name, value in _API_HEADERS.items():
                        if name in decides and name in headers:
                            continue  # the route's own policy (the e-mail preview, B11-28; B12-9)
                        headers[name] = value
                if self.hsts:
                    headers.setdefault("Strict-Transport-Security", _HSTS)
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                log_access()

        try:
            await self.app(scope, receive, send_with_headers)
        except Exception as exc:
            # Formatted exceptions never show a PostgreSQL DETAIL (row values; `app.core.logging`); the
            # error's class, SQLSTATE and constraint name are logged instead.
            logger.exception(
                "unhandled error while processing request", extra=database_error_summary(exc) or {}
            )
            if not response_started:
                response = JSONResponse(status_code=500, content=internal_error_body())
                await response(scope, receive, send_with_headers)
        finally:
            log_access()
            reset_request_id(context_token)


class _BodyTooLarge(Exception):
    """Raised into the application when it reads past the body limit (see `BodySizeLimitMiddleware`)."""


def _declared_length(scope: Scope) -> int | None:
    value = Headers(scope=scope).get("content-length")
    if value is None:
        return None
    try:
        length = int(value)
    except ValueError:
        return None
    return length if length >= 0 else None


@dataclass(frozen=True, slots=True)
class BodyLimit:
    """A route whose body may be larger (or must be smaller) than MAX_REQUEST_BODY_BYTES: the method and a
    pattern that the whole route path matches. Decided on the route path, like every other check here."""

    method: str
    path: re.Pattern[str]
    max_body_bytes: int


class BodySizeLimitMiddleware:
    """Rejects API request bodies larger than `max_body_bytes` with 413 PAYLOAD_TOO_LARGE.

    FastAPI reads and parses a whole body before any dependency runs, so without a bound one anonymous
    request could make the (single) worker hold an arbitrarily large body in memory. A declared
    `Content-Length` above the limit is refused before anything is read. Without a declared length, or
    when the declared length is wrong, the bytes are counted while the application reads them: past the
    limit the read raises into the application, whatever it answers is discarded, and the 413 is sent
    instead. Installed inside `RequestContextMiddleware`, so the rejection carries the request ID and the
    API headers like every other error.

    `route_limits` gives single routes a limit of their own (the first that matches applies): the upload
    of a company's brand image takes a PNG of at most 512 KiB, which nothing else may send.
    """

    def __init__(self, app: ASGIApp, *, max_body_bytes: int, route_limits: Sequence[BodyLimit] = ()) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.route_limits = tuple(route_limits)

    def _limit(self, scope: Scope) -> int:
        path = route_path(scope)
        for limit in self.route_limits:
            if scope["method"] == limit.method and limit.path.fullmatch(path):
                return limit.max_body_bytes
        return self.max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not is_api_path(route_path(scope)):
            await self.app(scope, receive, send)
            return
        max_body_bytes = self._limit(scope)
        declared = _declared_length(scope)
        if declared is not None and declared > max_body_bytes:
            await self._reject(scope, receive, send)
            return

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > max_body_bytes:
                    exceeded = True
                    raise _BodyTooLarge()
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal response_started
            if exceeded:
                return  # the application's answer to an aborted body is replaced by the 413
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            # Whatever the application made of the aborted read (FastAPI turns it into a 400) is moot.
            if not exceeded:
                raise
        if exceeded and not response_started:
            await self._reject(scope, receive, send)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
        logger.info("request body too large")
        response = JSONResponse(
            status_code=PayloadTooLarge.status_code,
            content=error_body(PayloadTooLarge.code, PayloadTooLarge.default_message),
        )
        await response(scope, receive, send)


@dataclass(frozen=True, slots=True)
class CsrfSessionInfo:
    """What the CSRF check needs to know about the live session behind a session cookie: a user's, or
    with `platform` a platform administrator's (`user_id` then names the administrator, B11-6)."""

    session_id: UUID
    user_id: UUID
    company_id: UUID | None
    csrf_token_hash: str
    platform: bool = False


@dataclass(frozen=True, slots=True)
class CsrfRealm:
    """Requests under `prefix` authenticate with their own session cookie (B11-6): the platform owner's
    pages under /api/v1/platform. Every other API request uses the default (tenant) cookie."""

    prefix: str
    session_cookie_name: str
    lookup_session: Callable[[str], CsrfSessionInfo | None]
    exempt: frozenset[tuple[str, str]] = frozenset()


CsrfFailureReason = Literal["cross_site", "origin_not_allowed", "token_mismatch"]
SessionLookup = Callable[[str], CsrfSessionInfo | None]
CsrfMatcher = Callable[[str, str | None], bool]
CsrfFailureRecorder = Callable[[Request, CsrfFailureReason, CsrfSessionInfo | None], None]


class CsrfOriginMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_origins: frozenset[str],
        session_cookie_name: str,
        csrf_header: str,
        exempt: frozenset[tuple[str, str]],
        lookup_session: SessionLookup,
        csrf_matches: CsrfMatcher,
        record_failure: CsrfFailureRecorder,
        realms: Sequence[CsrfRealm] = (),
    ) -> None:
        self.app = app
        self.allowed_origins = allowed_origins
        self.default_realm = CsrfRealm(API_PREFIX, session_cookie_name, lookup_session, exempt)
        self.realms = tuple(realms)
        self.csrf_header = csrf_header
        self.csrf_matches = csrf_matches
        self.record_failure = record_failure

    def _realm(self, path: str) -> CsrfRealm:
        """The realm whose session cookie authenticates `path` (a route path)."""
        for realm in self.realms:
            if path == realm.prefix or path.startswith(realm.prefix + "/"):
                return realm
        return self.default_realm

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] not in UNSAFE_METHODS
            or not is_api_path(route_path(scope))
        ):
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        try:
            failure = await self._check(request)
        except (OperationalError, PoolTimeoutError) as exc:
            # Like the application's handlers of these: one line, no traceback, retryable 503.
            logger.warning("database unavailable or contended: %s", type(getattr(exc, "orig", exc)).__name__)
            busy = JSONResponse(
                status_code=ServiceBusy.status_code,
                content=error_body(ServiceBusy.code, ServiceBusy.default_message),
            )
            await busy(scope, receive, send)
            return
        if failure is None:
            await self.app(scope, receive, send)
            return
        reason, info = failure
        await anyio.to_thread.run_sync(self.record_failure, request, reason, info)
        response = JSONResponse(
            status_code=CsrfFailed.status_code,
            content=error_body(CsrfFailed.code, CsrfFailed.default_message),
        )
        await response(scope, receive, send)

    def _origin_allowed(self, origin: str | None) -> bool:
        if origin is None:
            return False
        normalised = normalise_origin(origin)
        return normalised is not None and normalised in self.allowed_origins

    async def _check(self, request: Request) -> tuple[CsrfFailureReason, CsrfSessionInfo | None] | None:
        """The failure to report, or None to let the request through. Raises `OperationalError` when
        the token check cannot look the session up."""
        headers = request.headers
        origin = headers.get("origin")
        fetch_site = (headers.get("sec-fetch-site") or "").strip().lower()
        if fetch_site == "cross-site" or (fetch_site == "same-site" and not self._origin_allowed(origin)):
            return "cross_site", await self._attribution(request)
        if origin is not None and not self._origin_allowed(origin):
            return "origin_not_allowed", await self._attribution(request)

        realm = self._realm(route_path(request.scope))
        if (request.method, route_path(request.scope)) in realm.exempt:
            return None
        info = await self._session(request)
        if info is None:
            # No live session: the endpoint answers 401 where authentication is required.
            return None
        if not self.csrf_matches(info.csrf_token_hash, headers.get(self.csrf_header)):
            return "token_mismatch", info
        return None

    async def _session(self, request: Request) -> CsrfSessionInfo | None:
        """The live session of the request's realm (its own cookie): a tenant cookie never vouches for a
        platform request, nor a platform cookie for a tenant request."""
        realm = self._realm(route_path(request.scope))
        raw_session = request.cookies.get(realm.session_cookie_name)
        if not raw_session:
            return None
        return await anyio.to_thread.run_sync(realm.lookup_session, raw_session)

    async def _attribution(self, request: Request) -> CsrfSessionInfo | None:
        """The live session behind a request already rejected by its origin, so the audit row names its
        user and company (§4: company_id is NULL only when unattributable). The rejection itself does
        not depend on it: if the lookup fails, the event is recorded unattributed."""
        try:
            return await self._session(request)
        except (OperationalError, PoolTimeoutError) as exc:
            # Expected during an outage, for every such request: no traceback.
            logger.warning(
                "session lookup for CSRF failure attribution failed: %s",
                type(getattr(exc, "orig", exc)).__name__,
            )
            return None
        except Exception:
            logger.warning("session lookup for CSRF failure attribution failed", exc_info=True)
            return None


class FirstWrite:
    """Calls `callback` once: when the process takes its first request with an unsafe method (B13-7). In
    the deployment that is the main API instance alone, the one that sends the e-mails; nginx sends the
    read services nothing but GETs. The callback runs before the request goes on and must not block (it
    starts a thread); whatever it raises is logged, and the request goes on."""

    def __init__(self, app: ASGIApp, *, callback: Callable[[], object]) -> None:
        self.app = app
        self.callback: Callable[[], object] | None = callback

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        callback = self.callback
        if callback is not None and scope["type"] == "http" and scope["method"] in UNSAFE_METHODS:
            self.callback = None
            try:
                callback()
            except Exception:
                logger.exception("the first write's callback failed")
        await self.app(scope, receive, send)
