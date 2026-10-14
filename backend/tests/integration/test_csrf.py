import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.security.sessions import SECURE_COOKIE_NAMES
from tests.support import Api, World, audit_rows, error_code

CSRF_MESSAGE = "Your session could not be verified. Please refresh the page and try again."


@pytest.fixture
def api(client: TestClient, world: World) -> Api:
    api = Api(client)
    assert api.login(world.a.admin.email).status_code == 200
    return api


def _create_department(api: Api, **kwargs) -> object:
    return api.post("/departments", json={"name": "Security"}, **kwargs)


def test_valid_csrf_token_is_accepted(api: Api) -> None:
    assert _create_department(api).status_code == 201


def test_missing_csrf_token_is_rejected_and_audited(api: Api, world: World, db: Session) -> None:
    response = _create_department(api, csrf=False)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CSRF_FAILED"
    assert response.json()["error"]["message"] == CSRF_MESSAGE
    rows = audit_rows(db, "CSRF_FAILED")
    assert len(rows) == 1
    assert rows[0].actor_user_id == world.a.admin.id
    assert rows[0].company_id == world.a.company.id
    assert rows[0].meta == {"reason": "token_mismatch", "method": "POST", "route": "/api/v1/departments"}


def test_wrong_csrf_token_is_rejected(api: Api, db: Session) -> None:
    response = _create_department(api, headers={"X-CSRF-Token": "x" * 43})
    assert response.status_code == 403
    assert error_code(response) == "CSRF_FAILED"


def test_csrf_token_of_another_session_is_rejected(make_client, world: World) -> None:
    first = Api(make_client())
    first.login(world.a.admin.email)
    second = Api(make_client())
    second.login(world.a.admin.email)
    response = first.post("/departments", json={"name": "Ops"}, headers={"X-CSRF-Token": second.csrf_token})
    assert response.status_code == 403


def test_csrf_applies_to_patch_and_logout(api: Api, world: World) -> None:
    patch = api.patch(f"/departments/{world.a.finance.id}", json={"name": "Treasury"}, csrf=False)
    assert patch.status_code == 403
    logout = api.post("/auth/logout", csrf=False)
    assert logout.status_code == 403
    assert api.get("/auth/me").status_code == 200  # the session survived


def test_safe_methods_need_no_token(api: Api) -> None:
    assert api.get("/departments").status_code == 200


def test_cross_site_fetch_is_rejected_even_when_unauthenticated(client: TestClient, world: World) -> None:
    api = Api(client)
    response = api.post(
        "/auth/login",
        json={"email": world.a.admin.email, "password": "irrelevant-password"},
        headers={"Sec-Fetch-Site": "cross-site"},
        csrf=False,
    )
    assert response.status_code == 403
    assert error_code(response) == "CSRF_FAILED"


def test_same_site_requires_allowed_origin(api: Api) -> None:
    rejected = _create_department(api, headers={"Sec-Fetch-Site": "same-site"})
    assert rejected.status_code == 403
    accepted = _create_department(api, headers={"Sec-Fetch-Site": "same-site", "Origin": "https://vms.test"})
    assert accepted.status_code == 201


def test_foreign_origin_is_rejected(api: Api, db: Session) -> None:
    response = _create_department(api, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert audit_rows(db, "CSRF_FAILED")[-1].meta["reason"] == "origin_not_allowed"


@pytest.mark.parametrize(
    ("headers", "reason"),
    [
        ({"Origin": "https://evil.example"}, "origin_not_allowed"),
        ({"Sec-Fetch-Site": "cross-site"}, "cross_site"),
        ({"Sec-Fetch-Site": "same-site", "Origin": "https://sibling.vms.test"}, "cross_site"),
    ],
)
def test_origin_failures_with_a_live_session_are_attributed(
    api: Api, world: World, db: Session, headers: dict[str, str], reason: str
) -> None:
    # Same-site sibling origins and non-browser clients can send the session cookie along; the row
    # must reach the tenant's own audit trail (GET /audit-logs is company-scoped).
    response = api.patch("/company/settings", json={"allow_walk_ins": False}, headers=headers)
    assert response.status_code == 403
    assert error_code(response) == "CSRF_FAILED"
    [row] = audit_rows(db, "CSRF_FAILED")
    assert row.company_id == world.a.company.id
    assert row.actor_user_id == world.a.admin.id
    assert row.meta == {"reason": reason, "method": "PATCH", "route": "/api/v1/company/settings"}


def test_origin_failure_with_an_ended_session_is_unattributed(
    api: Api, client: TestClient, db: Session
) -> None:
    assert api.post("/auth/logout").status_code == 204
    client.cookies.set(SECURE_COOKIE_NAMES.session, "x" * 43)  # a stale or forged cookie names nobody
    response = _create_department(api, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    [row] = audit_rows(db, "CSRF_FAILED")
    assert row.company_id is None and row.actor_user_id is None


def test_null_origin_is_rejected(api: Api) -> None:
    assert _create_department(api, headers={"Origin": "null"}).status_code == 403


def test_allowed_origin_and_same_origin_fetch_are_accepted(api: Api) -> None:
    response = _create_department(
        api, headers={"Origin": "https://VMS.test", "Sec-Fetch-Site": "same-origin"}
    )
    assert response.status_code == 201


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/auth/login", {"email": "someone@example.com", "password": "Wrong-Password-1"}),
        ("/auth/forgot-password", {"email": "someone@example.com"}),
        ("/auth/reset-password", {"token": "x" * 43, "new_password": "A-New-Password-123"}),
    ],
)
def test_exempt_endpoints_work_without_token_while_logged_in(api: Api, path: str, payload: dict) -> None:
    response = api.post(path, json=payload, csrf=False)
    assert response.status_code != 403
    assert response.status_code in {202, 400, 401}


def test_exempt_endpoints_still_enforce_origin(api: Api) -> None:
    response = api.post(
        "/auth/forgot-password",
        json={"email": "someone@example.com"},
        headers={"Origin": "https://evil.example"},
        csrf=False,
    )
    assert response.status_code == 403


def test_unauthenticated_unsafe_request_gets_401_not_403(client: TestClient) -> None:
    response = Api(client).post("/departments", json={"name": "X"}, csrf=False)
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("path", "route"),
    [
        # Attacker-chosen text in the path never reaches the audit trail (§3.2-8).
        ("/api/v1/jane.doe@example.com/Jane Doe +962791234567", "unmatched"),
        ("/api/v1/departments/0b7e8a52-55d4-4b8f-9d9b-1c0f8b3f2a10", "/api/v1/departments/{department_id}"),
        ("/api/v1/users/jane.doe@example.com", "/api/v1/users/{user_id}"),
    ],
)
def test_csrf_audit_stores_the_route_template_not_the_path(
    client: TestClient, db: Session, path: str, route: str
) -> None:
    response = client.patch(path, json={}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    row = audit_rows(db, "CSRF_FAILED")[-1]
    assert row.meta == {"reason": "origin_not_allowed", "method": "PATCH", "route": route}
    assert "jane" not in str(row.meta).lower()


class DatabaseDown(Exception):
    """Stands in for the driver error SQLAlchemy wraps (`OperationalError.orig`)."""


def test_unsafe_request_with_a_session_during_a_database_outage_is_service_busy(
    api: Api, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def database_down() -> Session:
        raise OperationalError("connect", {}, DatabaseDown("connection refused"))

    # The CSRF token check looks the session up before any route (and its exception handlers) runs.
    monkeypatch.setattr("app.security.csrf.session_factory", database_down)
    with caplog.at_level(logging.WARNING):
        response = _create_department(api)

    assert response.status_code == 503
    assert error_code(response) == "SERVICE_BUSY"
    assert response.json()["request_id"] == response.headers["X-Request-ID"]
    assert response.headers["Cache-Control"] == "no-store"
    assert not any(record.exc_info for record in caplog.records)  # one line per request, no traceback
    assert "unhandled error" not in caplog.text
