"""The platform owner's pieces in isolation (Phase 11, B11-6): settings and their production limits, the
CSRF middleware's realms, the cookies, and the attribution of security events."""

import uuid
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app.core.errors import SecurityEvent
from app.core.middleware import CsrfFailureReason, CsrfOriginMiddleware, CsrfRealm, CsrfSessionInfo
from app.core.request_context import RequestContext
from app.core.routing import is_platform_path
from app.security.platform_sessions import (
    INSECURE_PLATFORM_COOKIE_NAMES,
    SECURE_PLATFORM_COOKIE_NAMES,
    platform_cookie_names,
    platform_session_policy,
)
from app.services.audit import SecurityAudit, SecurityEventCoalescer
from tests.unit.test_config import PRODUCTION, make

TENANT = CsrfSessionInfo(
    session_id=uuid.uuid4(), user_id=uuid.uuid4(), company_id=uuid.uuid4(), csrf_token_hash="t"
)
PLATFORM = CsrfSessionInfo(
    session_id=uuid.uuid4(), user_id=uuid.uuid4(), company_id=None, csrf_token_hash="p", platform=True
)


def test_the_platform_session_settings_and_their_production_ceilings() -> None:
    settings = make(database_url=PRODUCTION["database_url"])
    assert (settings.platform_session_max_age_hours, settings.platform_session_idle_minutes) == (8, 30)
    policy = platform_session_policy(settings)
    assert policy.max_age.total_seconds() == 8 * 3600 and policy.idle_timeout.total_seconds() == 30 * 60
    assert make(**PRODUCTION, platform_session_max_age_hours=12, platform_session_idle_minutes=60)
    with pytest.raises(ValidationError, match="PLATFORM_SESSION_MAX_AGE_HOURS must be at most 12"):
        make(**PRODUCTION, platform_session_max_age_hours=13)
    with pytest.raises(ValidationError, match="PLATFORM_SESSION_IDLE_MINUTES must be at most 60"):
        make(**PRODUCTION, platform_session_idle_minutes=61)
    # Outside production the field bounds still apply.
    with pytest.raises(ValidationError):
        make(database_url=PRODUCTION["database_url"], platform_session_max_age_hours=25)
    with pytest.raises(ValidationError):
        make(database_url=PRODUCTION["database_url"], rate_limit_template_test_sends_per_hour=101)


def test_the_platform_cookie_names() -> None:
    assert platform_cookie_names(True) is SECURE_PLATFORM_COOKIE_NAMES
    assert platform_cookie_names(False) is INSECURE_PLATFORM_COOKIE_NAMES
    assert SECURE_PLATFORM_COOKIE_NAMES.session == "__Host-vms_platform_session"
    assert SECURE_PLATFORM_COOKIE_NAMES.csrf == "__Host-vms_platform_csrf"
    assert INSECURE_PLATFORM_COOKIE_NAMES.csrf == "vms_platform_csrf"


@pytest.mark.parametrize(
    ("path", "platform"),
    [
        ("/api/v1/platform", True),
        ("/api/v1/platform/companies", True),
        ("/api/v1/platformx", False),
        ("/api/v1/auth/login", False),
    ],
)
def test_which_paths_are_the_platform_s(path: str, platform: bool) -> None:
    assert is_platform_path(path) is platform


type Recorded = list[tuple[CsrfFailureReason, CsrfSessionInfo | None]]


def _client(recorded: Recorded, cookies: dict[str, str]) -> TestClient:
    async def endpoint(_request: Request) -> PlainTextResponse:
        return PlainTextResponse("ok")

    app = Starlette(
        routes=[
            Route("/api/v1/things", endpoint, methods=["POST"]),
            Route("/api/v1/platform/things", endpoint, methods=["POST"]),
            Route("/api/v1/platform/auth/login", endpoint, methods=["POST"]),
        ]
    )
    lookups: dict[str, Callable[[str], CsrfSessionInfo | None]] = {
        "tenant": lambda raw: TENANT if raw == "tenant-session" else None,
        "platform": lambda raw: PLATFORM if raw == "platform-session" else None,
    }
    app.add_middleware(
        CsrfOriginMiddleware,
        allowed_origins=frozenset({"https://vms.test"}),
        session_cookie_name="vms_session",
        csrf_header="X-CSRF-Token",
        exempt=frozenset(),
        lookup_session=lookups["tenant"],
        csrf_matches=lambda stored, presented: presented == f"good-{stored}",
        record_failure=lambda _request, reason, info: recorded.append((reason, info)),
        realms=(
            CsrfRealm(
                prefix="/api/v1/platform",
                session_cookie_name="vms_platform_session",
                lookup_session=lookups["platform"],
                exempt=frozenset({("POST", "/api/v1/platform/auth/login")}),
            ),
        ),
    )
    return TestClient(app, base_url="https://testserver", cookies=cookies)


BOTH = {"vms_session": "tenant-session", "vms_platform_session": "platform-session"}


def test_each_realm_checks_its_own_session_and_token() -> None:
    recorded: Recorded = []
    client = _client(recorded, BOTH)
    assert client.post("/api/v1/things", headers={"X-CSRF-Token": "good-t"}).status_code == 200
    assert client.post("/api/v1/platform/things", headers={"X-CSRF-Token": "good-p"}).status_code == 200
    # The other realm's token does not pass.
    assert client.post("/api/v1/things", headers={"X-CSRF-Token": "good-p"}).status_code == 403
    assert client.post("/api/v1/platform/things", headers={"X-CSRF-Token": "good-t"}).status_code == 403
    assert recorded == [("token_mismatch", TENANT), ("token_mismatch", PLATFORM)]


def test_a_realm_s_exemption_is_its_own() -> None:
    recorded: Recorded = []
    client = _client(recorded, BOTH)
    assert client.post("/api/v1/platform/auth/login").status_code == 200
    assert recorded == []


def test_a_tenant_cookie_alone_does_not_vouch_for_a_platform_request() -> None:
    recorded: Recorded = []
    client = _client(recorded, {"vms_session": "tenant-session"})
    # No platform session: the request goes on to the endpoint, which answers 401 there.
    assert client.post("/api/v1/platform/things").status_code == 200
    assert recorded == []


def test_a_cross_site_platform_request_names_the_platform_session() -> None:
    recorded: Recorded = []
    client = _client(recorded, BOTH)
    assert client.post("/api/v1/platform/things", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert recorded == [("cross_site", PLATFORM)]


class _Writer:
    def __init__(self) -> None:
        self.events: list[SecurityEvent] = []

    def __call__(self, event: SecurityEvent, context: RequestContext) -> bool:
        self.events.append(event)
        return True


def test_platform_events_are_coalesced_apart_from_the_companies() -> None:
    writer = _Writer()
    audit = SecurityAudit(SecurityEventCoalescer(), writer=writer)
    context = RequestContext(ip_address="198.51.100.7", user_agent=None, request_id=None)
    tenant = SecurityEvent(action="RATE_LIMITED", metadata={"policy": "login_failures_ip"})
    platform = SecurityEvent(action="RATE_LIMITED", metadata={"policy": "login_failures_ip"}, platform=True)
    for event in (tenant, platform, tenant, platform):
        audit.record(event, context)
    # The first of each realm is written; the repeats are held for the summary row.
    assert [event.platform for event in writer.events] == [False, True]
