"""Per-request values that logging and auditing need without threading them through every call."""

import re
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass

from starlette.requests import Request

REQUEST_ID_HEADER = "X-Request-ID"
# A request ID passed on by a trusted proxy is accepted only when it cannot smuggle anything into logs or
# headers (`accept_or_generate_request_id`).
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$")

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)


def current_request_id() -> str | None:
    return _request_id.get()


def set_request_id(value: str | None) -> Token[str | None]:
    return _request_id.set(value)


def reset_request_id(token: Token[str | None]) -> None:
    _request_id.reset(token)


def accept_or_generate_request_id(candidate: str | None, *, from_trusted_proxy: bool) -> str:
    """The request's ID: the one a trusted proxy (TRUSTED_PROXIES, the rule `X-Forwarded-For` follows)
    passed on, when it is safe, otherwise a new server-generated one.

    A client's own `X-Request-ID` is never adopted: the ID is written to every log line and audit row
    of the request, and a client that could choose it could file its own requests under another
    request's ID (an administrator's, or one a user reported) and mix them into that trail.
    """
    if from_trusted_proxy and candidate and _SAFE_REQUEST_ID.fullmatch(candidate):
        return candidate
    return uuid.uuid4().hex


USER_AGENT_MAX_LENGTH = 400


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Who/where a change came from, for audit rows. Built once per request (or SYSTEM for jobs)."""

    ip_address: str | None
    user_agent: str | None
    request_id: str | None

    @classmethod
    def from_request(cls, request: Request) -> RequestContext:
        state = request.scope.get("state", {})
        user_agent = request.headers.get("user-agent")
        return cls(
            ip_address=state.get("client_ip"),
            user_agent=user_agent[:USER_AGENT_MAX_LENGTH] if user_agent else None,
            request_id=state.get("request_id"),
        )


SYSTEM_CONTEXT = RequestContext(ip_address=None, user_agent=None, request_id=None)
