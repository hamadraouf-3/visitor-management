"""Health, security headers, request IDs, error envelopes and the catch-all 500."""

import logging
from ipaddress import ip_network

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.time import FakeClock
from app.main import create_app
from tests.support import TEST_CLIENT_ADDRESS, Api, World, audit_rows, error_code


def test_health_ok(client: TestClient) -> None:
    response = Api(client).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_health_reports_database_outage(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken_engine():
        raise ConnectionError("database is down")

    probe = client.app.state.database_probe  # type: ignore[attr-defined]
    monkeypatch.setattr(probe, "_connect_engine", broken_engine)
    monkeypatch.setattr(probe, "_last", None)
    response = Api(client).get("/health")
    assert response.status_code == 503
    assert response.json()["error"] == {
        "code": "SERVICE_BUSY",
        "message": "The service is busy. Please try again.",
        "details": {"database": "unavailable"},
    }


def test_api_security_headers(client: TestClient) -> None:
    for response in (Api(client).get("/health"), Api(client).get("/auth/me")):
        headers = response.headers
        assert headers["Cache-Control"] == "no-store"
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["Referrer-Policy"] == "no-referrer"
        assert headers["X-Frame-Options"] == "DENY"
        assert headers["Content-Security-Policy"].startswith("default-src 'none'")
        assert headers["Cross-Origin-Resource-Policy"] == "same-origin"
        assert "Strict-Transport-Security" not in headers  # only in production
        assert len(headers["X-Request-ID"]) == 32


def test_hsts_in_production(settings: Settings, app_engine, hasher, email_provider) -> None:
    production = settings.model_copy(update={"app_env": "production"})
    app = create_app(production, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    response = TestClient(app, base_url="https://testserver").get("/api/v1/does-not-exist")
    assert response.headers["Strict-Transport-Security"].startswith("max-age=")
    assert app.openapi_url is None and app.docs_url is None


def test_openapi_available_outside_production(client: TestClient) -> None:
    assert client.get("/openapi.json").status_code == 200


def test_openapi_title_is_the_product_s_name(client: TestClient) -> None:
    """B10-16: the product, "Mawdoo3 Visitors", names the API; never "Visitor Management"."""
    assert client.get("/openapi.json").json()["info"]["title"] == "Mawdoo3 Visitors API"


@pytest.fixture
def behind_proxy(settings: Settings, app_engine, hasher, email_provider, connection) -> TestClient:
    """A client whose direct peer (the test client address) is a trusted proxy."""
    proxied = settings.model_copy(update={"trusted_proxies": [ip_network(f"{TEST_CLIENT_ADDRESS[0]}/32")]})
    app = create_app(proxied, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    return TestClient(app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS)


def test_request_id_from_a_trusted_proxy_is_kept(behind_proxy: TestClient) -> None:
    response = Api(behind_proxy).get("/health", headers={"X-Request-ID": "edge-proxy-1234abcd"})
    assert response.headers["X-Request-ID"] == "edge-proxy-1234abcd"


@pytest.mark.parametrize("candidate", ["short", "bad id with spaces", "x" * 65, "evil;id=<script>1234"])
def test_unsafe_request_id_is_replaced(behind_proxy: TestClient, candidate: str) -> None:
    response = Api(behind_proxy).get("/health", headers={"X-Request-ID": candidate})
    assert response.headers["X-Request-ID"] != candidate
    assert len(response.headers["X-Request-ID"]) == 32


def test_error_envelope_carries_request_id(behind_proxy: TestClient) -> None:
    response = Api(behind_proxy).get("/auth/me", headers={"X-Request-ID": "trace-0000000042"})
    assert response.json()["request_id"] == "trace-0000000042"


def test_a_clients_own_request_id_is_never_adopted(client: TestClient, db: Session, world: World) -> None:
    """SEC-12/16: a direct client cannot file its requests under an ID of its choosing (an
    administrator's earlier request, say); its ID is neither echoed nor written to the audit trail."""
    admin_request = Api(client).get("/health")
    chosen = admin_request.headers["X-Request-ID"]  # looks exactly like a server-generated one
    failed = Api(client).post(
        "/auth/login",
        json={"email": world.a.admin.email, "password": "not-the-password-0"},
        csrf=False,
        headers={"X-Request-ID": chosen},
    )
    assert failed.status_code == 401
    assert failed.headers["X-Request-ID"] != chosen
    assert failed.json()["request_id"] == failed.headers["X-Request-ID"]
    (row,) = audit_rows(db, "AUTH_LOGIN_FAILED")
    assert row.request_id == failed.headers["X-Request-ID"]


@pytest.mark.parametrize(("method", "path"), [("GET", "/visits/"), ("POST", "/visits/"), ("GET", "/users/")])
def test_trailing_slash_is_not_redirected(client: TestClient, method: str, path: str) -> None:
    """SEC-13: no 307 whose Location is built from the client's Host header (and http behind TLS)."""
    response = client.request(
        method, f"/api/v1{path}", headers={"Host": "evil.example"}, follow_redirects=False
    )
    assert response.status_code in {404, 405}
    assert "location" not in response.headers
    assert error_code(response) in {"NOT_FOUND", "METHOD_NOT_ALLOWED"}


def test_unknown_route_and_method(client: TestClient) -> None:
    missing = Api(client).get("/nope")
    assert missing.status_code == 404
    assert error_code(missing) == "NOT_FOUND"
    wrong_method = client.delete("/api/v1/health")
    assert wrong_method.status_code == 405
    assert error_code(wrong_method) == "METHOD_NOT_ALLOWED"


@pytest.mark.parametrize("content", [b"{not json", b'{"email": "a@b.c", "password": "x"', b"[1, 2,]"])
def test_malformed_json_is_a_validation_error(client: TestClient, content: bytes) -> None:
    response = client.post(
        "/api/v1/auth/login", content=content, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"
    # The key names the body, not the parser's character offset.
    assert response.json()["error"]["details"] == {
        "fields": {"body": "The request body is not valid JSON."},
        "field_codes": {"body": {"code": "invalid_json", "params": {}}},
    }


def test_login_field_errors_are_worded_for_people(client: TestClient) -> None:
    response = Api(client).post("/auth/login", json={"email": "", "password": ""}, csrf=False)
    assert response.json()["error"]["details"]["fields"] == {
        "email": "This field is required.",
        "password": "This field is required.",
    }


def test_validation_errors_never_log_input_values(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "Sup3r-Secret-Value-That-Must-Not-Leak"
    with caplog.at_level(logging.INFO):
        response = Api(client).post(
            "/auth/login", json={"email": secret * 20, "password": secret}, csrf=False
        )
    assert response.status_code == 422
    assert secret not in response.text
    assert all(
        secret not in record.getMessage() and secret not in str(record.__dict__) for record in caplog.records
    )


def test_access_log_has_no_query_string(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="app.access"):
        Api(client).get("/users/hosts", params={"q": "private-search-term"})
    access = [record for record in caplog.records if record.name == "app.access"]
    assert access
    assert access[-1].path == "/api/v1/users/hosts"
    assert all("private-search-term" not in str(record.__dict__) for record in access)


@pytest.fixture
def failing_app(settings: Settings, app_engine, hasher, email_provider) -> FastAPI:
    app = create_app(settings, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    router = APIRouter()

    @router.get("/api/v1/explode")
    def explode() -> None:
        raise RuntimeError("database password is hunter2 and the stack says so")

    app.include_router(router)
    return app


def test_unhandled_error_hides_internals(failing_app: FastAPI, caplog: pytest.LogCaptureFixture) -> None:
    client = TestClient(failing_app, base_url="https://testserver")
    with caplog.at_level(logging.ERROR):
        response = client.get("/api/v1/explode")
    assert response.status_code == 500
    body = response.json()
    assert body["error"] == {
        "code": "INTERNAL_ERROR",
        "message": "Something went wrong. Please try again.",
        "details": {},
    }
    assert "hunter2" not in response.text
    assert body["request_id"] == response.headers["X-Request-ID"]
    assert response.headers["Cache-Control"] == "no-store"
    assert any(record.exc_info for record in caplog.records)  # operators still get the traceback


def test_forbidden_is_audited_with_route_template(make_client, world: World, db: Session) -> None:
    api = Api(make_client())
    api.login(world.a.employee.email)
    response = api.get(f"/users/{world.a.admin.id}")
    assert response.status_code == 403
    row = audit_rows(db, "ACCESS_DENIED", actor_user_id=world.a.employee.id)[-1]
    assert row.company_id == world.a.company.id
    assert row.meta == {"method": "GET", "route": "/api/v1/users/{user_id}"}
    assert str(world.a.admin.id) not in str(row.meta)


def test_audit_metadata_never_contains_personal_data(
    make_client, world: World, db: Session, clock: FakeClock
) -> None:
    api = Api(make_client())
    api.login(world.a.admin.email)
    api.post(
        "/users",
        json={
            "full_name": "Private Person",
            "email": "private.person@example.com",
            "phone": "+962 79 999 9999",
            "roles": ["EMPLOYEE"],
            "temporary_password": "Tmp-Kiwi-Lantern-2026",
        },
    )
    api.login("private.person@example.com", "Wrong-Password-123")
    db.expire_all()
    from sqlalchemy import select

    from app.models import AuditLog

    dumped = " ".join(str(row.meta) for row in db.scalars(select(AuditLog)))
    for fragment in ("Private Person", "private.person", "999 9999", "Tmp-Kiwi-Lantern", "Wrong-Password"):
        assert fragment not in dumped


@pytest.mark.parametrize(
    "body",
    [
        {"email": "a\u0000b@example.com", "password": "Whatever-Password-1"},
        {"email": "someone@example.com", "password": "pass\u0000word-123"},
    ],
)
def test_nul_in_login_is_a_validation_error_not_a_500(
    client: TestClient, body: dict, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        response = Api(client).post("/auth/login", json=body, csrf=False)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"
    assert not any(record.levelno >= logging.ERROR for record in caplog.records)


def test_oversized_bodies_are_refused_before_anything_else(client: TestClient, settings: Settings) -> None:
    huge = b'{"email": "a@b.c", "password": "' + b"x" * settings.max_request_body_bytes + b'"}'
    response = client.post("/api/v1/auth/login", content=huge, headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert response.json()["request_id"] == response.headers["X-Request-ID"]
    assert response.headers["Cache-Control"] == "no-store"


def test_streamed_oversized_body_is_refused(client: TestClient, settings: Settings) -> None:
    def chunks():
        for _ in range(settings.max_request_body_bytes // 1000 + 2):
            yield b"x" * 1000

    response = client.post(
        "/api/v1/auth/login", content=chunks(), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


@pytest.mark.parametrize(
    ("trusted", "peer", "expected"),
    [
        ("", "203.0.113.10", "203.0.113.10"),  # no trusted proxies: the header is ignored
        ("10.0.0.0/8", "203.0.113.10", "203.0.113.10"),  # the peer is not a trusted proxy
        ("10.0.0.0/8", "10.0.0.2", "198.51.100.7"),  # a trusted proxy: its rightmost untrusted entry
    ],
)
def test_forwarded_for_is_honoured_only_from_trusted_proxies(
    settings: Settings,
    app_engine,
    hasher,
    email_provider,
    connection,
    world: World,
    db: Session,
    trusted: str,
    peer: str,
    expected: str,
) -> None:
    proxies = [ip_network(trusted)] if trusted else []
    configured = settings.model_copy(update={"trusted_proxies": proxies})
    app = create_app(configured, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    client = TestClient(app, base_url="https://testserver", client=(peer, 50000))
    response = client.post(
        "/api/v1/auth/login",
        json={"email": world.a.employee.email, "password": "Wrong-Password-123"},
        headers={"X-Forwarded-For": "6.6.6.6, 198.51.100.7"},
    )
    assert response.status_code == 401
    row = audit_rows(db, "AUTH_LOGIN_FAILED", actor_user_id=world.a.employee.id)[-1]
    assert str(row.ip_address) == expected


def test_nul_in_admin_input_is_a_validation_error(make_client, world: World) -> None:
    api = Api(make_client())
    api.login(world.a.admin.email)
    response = api.post("/departments", json={"name": "Ops\u0000x"})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {"name": "Remove unsupported control characters."}
    patch = api.patch("/company/settings", json={"address": "Line 1\nLine 2\u0007"})
    assert patch.status_code == 422
    multi_line = api.patch("/company/settings", json={"address": "Line 1\nLine 2"})
    assert multi_line.status_code == 200 and multi_line.json()["address"] == "Line 1\nLine 2"
