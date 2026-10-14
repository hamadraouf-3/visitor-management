"""CsrfOriginMiddleware in isolation: which session a failure is attributed to (B1-58), and the answer
when the session lookup cannot reach the database (B1-67)."""

import logging
import uuid
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app.core.middleware import CsrfFailureReason, CsrfOriginMiddleware, CsrfSessionInfo

SESSION = CsrfSessionInfo(
    session_id=uuid.uuid4(), user_id=uuid.uuid4(), company_id=uuid.uuid4(), csrf_token_hash="h" * 64
)

type Recorded = list[tuple[CsrfFailureReason, CsrfSessionInfo | None]]


def _client(
    lookup: Callable[[str], CsrfSessionInfo | None], recorded: Recorded, *, session_cookie: bool = True
) -> TestClient:
    async def endpoint(_request: Request) -> PlainTextResponse:
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/api/v1/things", endpoint, methods=["POST"])])
    app.add_middleware(
        CsrfOriginMiddleware,
        allowed_origins=frozenset({"https://vms.test"}),
        session_cookie_name="vms_session",
        csrf_header="X-CSRF-Token",
        exempt=frozenset(),
        lookup_session=lookup,
        csrf_matches=lambda stored, presented: presented == "good",
        record_failure=lambda _request, reason, info: recorded.append((reason, info)),
    )
    cookies = {"vms_session": "raw"} if session_cookie else None
    return TestClient(app, base_url="https://testserver", cookies=cookies)


@pytest.mark.parametrize(
    ("headers", "reason"),
    [
        ({"Origin": "https://evil.example"}, "origin_not_allowed"),
        ({"Sec-Fetch-Site": "cross-site"}, "cross_site"),
    ],
)
def test_origin_failures_carry_the_live_session(headers: dict[str, str], reason: str) -> None:
    recorded: Recorded = []
    client = _client(lambda _raw: SESSION, recorded)
    response = client.post("/api/v1/things", headers=headers)
    assert response.status_code == 403
    assert recorded == [(reason, SESSION)]


def test_origin_failure_without_a_cookie_needs_no_lookup() -> None:
    recorded: Recorded = []

    def lookup(_raw: str) -> CsrfSessionInfo | None:
        raise AssertionError("no cookie, no lookup")

    client = _client(lookup, recorded, session_cookie=False)
    response = client.post("/api/v1/things", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert recorded == [("origin_not_allowed", None)]


def test_failed_attribution_lookup_still_rejects_the_request(caplog: pytest.LogCaptureFixture) -> None:
    recorded: Recorded = []

    def lookup(_raw: str) -> CsrfSessionInfo | None:
        raise ConnectionError("database unavailable")

    client = _client(lookup, recorded)
    response = client.post("/api/v1/things", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CSRF_FAILED"
    assert recorded == [("origin_not_allowed", None)]
    assert "attribution failed" in caplog.text


def test_token_check_uses_the_same_session() -> None:
    recorded: Recorded = []
    client = _client(lambda _raw: SESSION, recorded)
    rejected = client.post("/api/v1/things", headers={"X-CSRF-Token": "bad"})
    accepted = client.post("/api/v1/things", headers={"X-CSRF-Token": "good"})
    assert (rejected.status_code, accepted.status_code) == (403, 200)
    assert recorded == [("token_mismatch", SESSION)]


class DatabaseDown(Exception):
    """Stands in for the driver error SQLAlchemy wraps (`OperationalError.orig`)."""


def _database_down(_raw: str) -> CsrfSessionInfo | None:
    raise OperationalError("SELECT user_sessions", {}, DatabaseDown("connection refused"))


def test_token_check_during_a_database_outage_answers_service_busy(caplog: pytest.LogCaptureFixture) -> None:
    recorded: Recorded = []
    client = _client(_database_down, recorded)
    with caplog.at_level(logging.WARNING, logger="app.middleware"):
        response = client.post("/api/v1/things", headers={"X-CSRF-Token": "good"})

    assert response.status_code == 503
    assert response.json()["error"] == {
        "code": "SERVICE_BUSY",
        "message": "The service is busy. Please try again.",
        "details": {},
    }
    assert recorded == []  # nothing failed verification; nothing reached the endpoint either
    warnings = [record for record in caplog.records if record.name == "app.middleware"]
    assert [record.levelno for record in warnings] == [logging.WARNING]
    assert warnings[0].exc_info is None and "DatabaseDown" in warnings[0].getMessage()


def test_attribution_during_a_database_outage_logs_no_traceback(caplog: pytest.LogCaptureFixture) -> None:
    recorded: Recorded = []
    client = _client(_database_down, recorded)
    with caplog.at_level(logging.WARNING, logger="app.middleware"):
        response = client.post("/api/v1/things", headers={"Origin": "https://evil.example"})

    assert response.status_code == 403  # the origin decides; the lookup only attributes the row
    assert recorded == [("origin_not_allowed", None)]
    warnings = [record for record in caplog.records if record.name == "app.middleware"]
    assert len(warnings) == 1 and warnings[0].exc_info is None
