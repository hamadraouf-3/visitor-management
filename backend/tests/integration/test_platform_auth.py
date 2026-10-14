"""The platform owner's sign-in and session (Phase 11, B11-1, B11-4, B11-6 to B11-8): the same bar as a
tenant's (one Argon2 verification, budgets and lockout, forced change, CSRF, audit), its own cookies and
audit trail, and no crossing between the tenant and the platform realms."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import AuditLog, PlatformAdmin, PlatformSession
from app.security.platform_sessions import SECURE_PLATFORM_COOKIE_NAMES
from app.security.sessions import SECURE_COOKIE_NAMES
from tests.support import (
    DEFAULT_PASSWORD,
    Api,
    Factory,
    PlatformApi,
    World,
    audit_rows,
    error_code,
    platform_audit_rows,
    platform_signed_in,
    refreshed,
    signed_in,
)

NEW_PASSWORD = "Quartz-Harbor-Violet-93"


@pytest.fixture
def owner(factory: Factory) -> PlatformAdmin:
    return factory.platform_admin(email="owner@platform.test", full_name="Platform Owner")


def test_sign_in_sets_the_platform_cookies_and_answers_who_is_signed_in(
    make_client, owner: PlatformAdmin, db: Session
) -> None:
    api = PlatformApi(make_client())
    response = api.login(owner.email)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "admin": {
            "id": str(owner.id),
            "full_name": "Platform Owner",
            "email": owner.email,
            "must_change_password": False,
            "preferred_language": None,
        }
    }
    cookies = {cookie.name: cookie for cookie in api.client.cookies.jar}
    assert set(cookies) >= {
        SECURE_PLATFORM_COOKIE_NAMES.session,
        SECURE_PLATFORM_COOKIE_NAMES.csrf,
        SECURE_PLATFORM_COOKIE_NAMES.device,
    }
    assert SECURE_COOKIE_NAMES.session not in cookies  # no tenant session
    set_cookies = response.headers.get_list("set-cookie")
    session_cookie = next(c for c in set_cookies if c.startswith(SECURE_PLATFORM_COOKIE_NAMES.session))
    assert "HttpOnly" in session_cookie and "Secure" in session_cookie and "SameSite=lax" in session_cookie
    assert "Max-Age=28800" in session_cookie  # PLATFORM_SESSION_MAX_AGE_HOURS = 8
    csrf_cookie = next(c for c in set_cookies if c.startswith(SECURE_PLATFORM_COOKIE_NAMES.csrf))
    assert "HttpOnly" not in csrf_cookie and "SameSite=strict" in csrf_cookie
    assert api.get("/platform/auth/me").json()["admin"]["id"] == str(owner.id)
    [row] = platform_audit_rows(db, "AUTH_LOGIN_SUCCEEDED", actor_platform_admin_id=owner.id)
    assert row.entity_type == "platform_admin" and row.company_id is None
    assert refreshed(db, PlatformAdmin, owner.id).last_login_at is not None
    # Nothing in any company's trail.
    assert db.scalars(select(AuditLog).where(AuditLog.actor_user_id == owner.id)).all() == []


def test_nobody_signed_in_is_not_authenticated(client: TestClient) -> None:
    response = PlatformApi(client).get("/platform/auth/me")
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"


@pytest.mark.parametrize(
    ("email", "password", "reason"),
    [
        ("owner@platform.test", "Wrong-Password-1234", "bad_password"),
        ("nobody@platform.test", DEFAULT_PASSWORD, "unknown_account"),
    ],
)
def test_a_failed_sign_in_is_one_answer_and_audited_in_the_platform_trail(
    make_client, owner: PlatformAdmin, db: Session, email: str, password: str, reason: str
) -> None:
    response = PlatformApi(make_client()).login(email, password)
    assert response.status_code == 401 and error_code(response) == "INVALID_CREDENTIALS"
    [row] = platform_audit_rows(db, "AUTH_LOGIN_FAILED")
    assert row.meta == {"reason": reason}
    assert row.actor_platform_admin_id == (owner.id if reason == "bad_password" else None)
    assert audit_rows(db, "AUTH_LOGIN_FAILED") == []  # the companies' trail is untouched


def test_an_inactive_or_expired_account_cannot_sign_in(
    make_client, factory: Factory, clock: FakeClock, db: Session
) -> None:
    inactive = factory.platform_admin(is_active=False)
    expired = factory.platform_admin(
        must_change_password=True, password_expires_at=clock.now() - timedelta(minutes=1)
    )
    for admin, reason in ((inactive, "inactive"), (expired, "password_expired")):
        response = PlatformApi(make_client()).login(admin.email)
        assert response.status_code == 401
        assert platform_audit_rows(db, "AUTH_LOGIN_FAILED", actor_platform_admin_id=admin.id)[0].meta == {
            "reason": reason
        }


def test_a_tenant_account_cannot_sign_in_to_the_platform_and_back(
    make_client, world: World, owner: PlatformAdmin
) -> None:
    assert PlatformApi(make_client()).login(world.a.admin.email).status_code == 401
    assert Api(make_client()).login(owner.email).status_code == 401


def test_the_account_is_locked_after_repeated_failures(
    make_client, owner: PlatformAdmin, db: Session
) -> None:
    for attempt in range(10):
        api = PlatformApi(make_client(client=(f"198.51.100.{attempt + 1}", 50000)))
        assert api.login(owner.email, "Wrong-Password-1234").status_code == 401
    response = PlatformApi(make_client(client=("198.51.100.99", 50000))).login(owner.email)
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert int(response.headers["retry-after"]) > 0
    assert platform_audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_platform_admin_id=owner.id)
    assert platform_audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "login_failures_account"


def test_a_trusted_browser_is_not_locked_out_by_strangers(make_client, owner: PlatformAdmin) -> None:
    trusted = platform_signed_in(make_client, owner)
    assert trusted.post("/platform/auth/logout").status_code == 204
    for attempt in range(10):
        api = PlatformApi(make_client(client=(f"198.51.100.{attempt + 1}", 50000)))
        api.login(owner.email, "Wrong-Password-1234")
    assert trusted.login(owner.email).status_code == 200  # its device cookie names the account


def test_the_temporary_password_must_be_changed_first(
    make_client, factory: Factory, clock: FakeClock, db: Session
) -> None:
    admin = factory.platform_admin(
        must_change_password=True, password_expires_at=clock.now() + timedelta(hours=72)
    )
    api = platform_signed_in(make_client, admin)
    assert api.get("/platform/auth/me").json()["admin"]["must_change_password"] is True
    response = api.get("/platform/companies")
    assert response.status_code == 403 and error_code(response) == "PASSWORD_CHANGE_REQUIRED"
    assert api.patch("/platform/auth/preferences", json={"language": "ar"}).status_code == 200
    old_session = api.session_token
    response = api.post(
        "/platform/auth/change-password",
        json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD},
    )
    assert response.status_code == 204, response.text
    assert api.session_token != old_session  # a new session (SEC-04)
    assert api.get("/platform/companies").status_code == 200
    stored = refreshed(db, PlatformAdmin, admin.id)
    assert (stored.must_change_password, stored.password_expires_at) == (False, None)
    assert stored.preferred_language == "ar"
    [row] = platform_audit_rows(db, "AUTH_PASSWORD_CHANGED", actor_platform_admin_id=admin.id)
    assert row.meta["revoked_sessions"] == 1
    # The old session is gone.
    stale = PlatformApi(make_client())
    stale.client.cookies.set(SECURE_PLATFORM_COOKIE_NAMES.session, old_session or "")
    assert stale.get("/platform/auth/me").status_code == 401


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        (
            {"current_password": "Wrong-Password-1234", "new_password": NEW_PASSWORD},
            400,
            "INVALID_CURRENT_PASSWORD",
        ),
        ({"current_password": DEFAULT_PASSWORD, "new_password": "short"}, 422, "VALIDATION_ERROR"),
        (
            {"current_password": DEFAULT_PASSWORD, "new_password": "Platform-Owner-2026"},
            422,
            "VALIDATION_ERROR",
        ),
        ({"current_password": DEFAULT_PASSWORD, "new_password": DEFAULT_PASSWORD}, 422, "VALIDATION_ERROR"),
    ],
)
def test_a_refused_password_change(
    make_client, owner: PlatformAdmin, db: Session, body, status, code
) -> None:
    api = platform_signed_in(make_client, owner)
    response = api.post("/platform/auth/change-password", json=body)
    assert response.status_code == status and error_code(response) == code
    if status == 400:
        assert platform_audit_rows(db, "AUTH_PASSWORD_CHANGE_FAILED", actor_platform_admin_id=owner.id)


def test_sign_out_ends_the_session(make_client, owner: PlatformAdmin, db: Session) -> None:
    api = platform_signed_in(make_client, owner)
    response = api.post("/platform/auth/logout")
    assert response.status_code == 204
    assert api.get("/platform/auth/me").status_code == 401
    assert platform_audit_rows(db, "AUTH_LOGOUT", actor_platform_admin_id=owner.id)
    session = db.scalars(select(PlatformSession).where(PlatformSession.platform_admin_id == owner.id)).one()
    assert session.revoked_at is not None


def test_the_idle_and_absolute_lifetimes(make_client, owner: PlatformAdmin, clock: FakeClock) -> None:
    api = platform_signed_in(make_client, owner)
    clock.advance(timedelta(minutes=29))
    assert api.get("/platform/auth/me").status_code == 200
    clock.advance(timedelta(minutes=31))  # PLATFORM_SESSION_IDLE_MINUTES = 30 since the last use
    assert api.get("/platform/auth/me").status_code == 401
    api = platform_signed_in(make_client, owner)
    for _ in range(16):  # 464 minutes
        clock.advance(timedelta(minutes=29))
        assert api.get("/platform/auth/me").status_code == 200
    clock.advance(timedelta(minutes=29))  # past PLATFORM_SESSION_MAX_AGE_HOURS = 8
    assert api.get("/platform/auth/me").status_code == 401


BACKGROUND = {"X-Background-Refresh": "1"}


def _last_seen(db: Session, admin: PlatformAdmin):
    db.expire_all()
    return db.scalars(
        select(PlatformSession.last_seen_at)
        .where(PlatformSession.platform_admin_id == admin.id)
        .order_by(PlatformSession.created_at.desc())
    ).first()


def test_a_background_refresh_does_not_extend_the_idle_timeout(
    make_client, owner: PlatformAdmin, clock: FakeClock, db: Session
) -> None:
    """The twin of the company session's rule (B11-34): the platform pages' heartbeat carries
    `X-Background-Refresh: 1` every minute, and an open tab nobody touches must still time out."""
    api = platform_signed_in(make_client, owner)
    signed_in_at = _last_seen(db, owner)
    for _ in range(29):  # the heartbeat, once a minute for 29 minutes
        clock.advance(minutes=1)
        assert api.get("/platform/auth/me", headers=BACKGROUND).status_code == 200
    assert _last_seen(db, owner) == signed_in_at  # a background request never writes `last_seen_at`
    clock.advance(minutes=1, seconds=1)  # PLATFORM_SESSION_IDLE_MINUTES = 30 since the sign-in
    response = api.get("/platform/auth/me", headers=BACKGROUND)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"
    assert api.get("/platform/auth/me").status_code == 401  # the session is over for every request


def test_only_a_request_of_the_person_extends_the_idle_timeout(
    make_client, owner: PlatformAdmin, clock: FakeClock, db: Session
) -> None:
    api = platform_signed_in(make_client, owner)
    clock.advance(minutes=20)
    assert api.get("/platform/companies", headers=BACKGROUND).status_code == 200  # a list's refetch
    clock.advance(minutes=5)
    assert api.get("/platform/companies").status_code == 200  # the person: 25 minutes after the sign-in
    seen = _last_seen(db, owner)
    clock.advance(minutes=29)
    assert api.get("/platform/auth/me", headers=BACKGROUND).status_code == 200  # 29 minutes after that
    assert _last_seen(db, owner) == seen
    clock.advance(minutes=1, seconds=1)
    assert api.get("/platform/auth/me", headers=BACKGROUND).status_code == 401
    # Any other value of the header is a request like any other.
    api = platform_signed_in(make_client, owner)
    clock.advance(minutes=29)
    assert api.get("/platform/auth/me", headers={"X-Background-Refresh": "0"}).status_code == 200
    clock.advance(minutes=29)
    assert api.get("/platform/auth/me").status_code == 200


# ---- CSRF and the two realms ----------------------------------------------------------------------------


def test_an_unsafe_platform_request_needs_the_platform_csrf_token(
    make_client, owner: PlatformAdmin, world: World, db: Session
) -> None:
    api = platform_signed_in(make_client, owner)
    response = api.post("/platform/auth/logout", csrf=False)
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"
    [row] = platform_audit_rows(db, "CSRF_FAILED", actor_platform_admin_id=owner.id)
    assert row.meta["reason"] == "token_mismatch"
    assert audit_rows(db, "CSRF_FAILED") == []
    # A tenant's CSRF token does not stand for the platform's, even in a browser holding both sessions.
    tenant = signed_in(make_client, world.a.admin)
    api.client.cookies.update(tenant.client.cookies)
    response = api.post(
        "/platform/auth/logout", csrf=False, headers={"X-CSRF-Token": tenant.csrf_token or ""}
    )
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"


def test_a_cross_site_platform_request_is_refused_before_anything(
    make_client, owner: PlatformAdmin, db: Session
) -> None:
    api = PlatformApi(make_client())
    response = api.post(
        "/platform/auth/login",
        json={"email": owner.email, "password": DEFAULT_PASSWORD},
        csrf=False,
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"
    assert platform_audit_rows(db, "CSRF_FAILED")[0].meta["reason"] == "origin_not_allowed"


TENANT_READS = [
    "/auth/me",
    "/visits",
    "/visitors",
    "/users",
    "/audit-logs",
    "/reports/summary",
    "/reception/today",
    "/dashboard/admin",
    "/company/settings",
    "/email-templates",
]


@pytest.mark.parametrize("path", TENANT_READS)
def test_a_platform_session_reads_nothing_of_a_company(make_client, owner: PlatformAdmin, path: str) -> None:
    api = platform_signed_in(make_client, owner)
    response = api.get(path)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"


@pytest.mark.parametrize(
    "path",
    ["/platform/auth/me", "/platform/companies", "/platform/audit-logs", "/platform/companies/x/admins"],
)
def test_a_tenant_session_reaches_nothing_of_the_platform(make_client, world: World, path: str) -> None:
    api = signed_in(make_client, world.a.admin)
    response = api.get(path)
    assert response.status_code in (401, 404)
    if path != "/platform/companies/x/admins":
        assert error_code(response) == "NOT_AUTHENTICATED"
    response = api.post("/platform/companies", json={})
    assert response.status_code == 401


def test_the_platform_api_has_a_budget_per_administrator(make_client, owner: PlatformAdmin, app) -> None:
    from tests.support import rate_limits

    api = platform_signed_in(make_client, owner)
    with rate_limits(app, api_per_user=2):
        assert api.get("/platform/auth/me").status_code == 200
        assert api.get("/platform/auth/me").status_code == 200
        response = api.get("/platform/auth/me")
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"


def test_the_access_log_names_the_platform_administrator(make_client, owner: PlatformAdmin, caplog) -> None:
    api = platform_signed_in(make_client, owner)
    with caplog.at_level("INFO", logger="app.access"):
        assert api.get("/platform/auth/me").status_code == 200
    [line] = [record for record in caplog.records if record.name == "app.access"]
    assert line.platform_admin_id == str(owner.id)  # type: ignore[attr-defined]
    assert (line.user_id, line.company_id) == (None, None)  # type: ignore[attr-defined]
