"""PATCH /api/v1/auth/preferences and the language fields of the Me payload (Phase 10, B10-1 to B10-4).

The caller sets their own interface and e-mail language; `null` follows the company's default. The
endpoint runs under the session, CSRF and Origin rules of every unsafe request, spends only the per-user
API budget, works while a password change is required, and writes no audit row."""

from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import AuditLog, Company, Role, User
from tests.support import (
    AUDIT_SEQ_WATERMARK,
    Api,
    Factory,
    World,
    error_code,
    no_brand,
    rate_limits,
    refreshed,
)


def _signed_in(make_client, user: User) -> Api:
    api = Api(make_client())
    assert api.login(user.email).status_code == 200
    return api


def _audit_rows_since_start(db: Session) -> int:
    db.expire_all()
    watermark = db.info.get(AUDIT_SEQ_WATERMARK, 0)
    return db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.seq > watermark)) or 0


@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
def test_every_role_sets_its_own_language(make_client, world: World, db: Session, role: Role) -> None:
    user = world.a.users_by_role[role]
    api = _signed_in(make_client, user)
    assert api.get("/auth/me").json()["user"]["preferred_language"] is None

    response = api.patch("/auth/preferences", json={"language": "ar"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["user"]["id"] == str(user.id) and body["user"]["preferred_language"] == "ar"
    # The whole Me payload, as GET /auth/me answers it.
    assert body == api.get("/auth/me").json()
    assert refreshed(db, User, user.id).preferred_language == "ar"
    switched = api.patch("/auth/preferences", json={"language": "en"})
    assert switched.status_code == 200 and switched.json()["user"]["preferred_language"] == "en"


def test_the_me_payload_carries_the_company_languages(make_client, factory: Factory, db: Session) -> None:
    company = factory.company("Mawdoo3", name_ar="موضوع", default_language="ar")
    user = factory.user(company)
    me = _signed_in(make_client, user).get("/auth/me").json()
    assert me["company"] == {
        "id": str(company.id),
        "name": "Mawdoo3",
        "name_ar": "موضوع",
        "slug": company.slug,
        "address": None,
        "address_ar": None,
        "timezone": "Asia/Amman",
        "default_language": "ar",
        "brand": no_brand(),
        "tracking_allowed": False,
    }
    assert me["user"]["preferred_language"] is None  # follows the company


@pytest.mark.parametrize(
    "body",
    [
        {"language": "fr"},
        {"language": "AR"},
        {"language": "arabic"},
        {"language": None},
        {"language": 1},
        {},
        {"language": "ar", "theme": "dark"},
    ],
)
def test_anything_but_ar_or_en_is_refused(make_client, world: World, db: Session, body: dict) -> None:
    api = _signed_in(make_client, world.a.employee)
    response = api.patch("/auth/preferences", json=body)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"
    fields = response.json()["error"]["details"]["fields"]
    assert set(fields) <= {"language", "theme"} and fields
    assert refreshed(db, User, world.a.employee.id).preferred_language is None


def test_the_message_for_an_unknown_language_lists_the_choices(make_client, world: World) -> None:
    response = _signed_in(make_client, world.a.employee).patch("/auth/preferences", json={"language": "fr"})
    assert response.json()["error"]["details"]["fields"] == {"language": "Choose one of: 'ar' or 'en'."}


def test_it_needs_a_session(make_client) -> None:
    response = Api(make_client()).patch("/auth/preferences", json={"language": "ar"})
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"


def test_it_needs_the_csrf_token(make_client, world: World, db: Session) -> None:
    api = _signed_in(make_client, world.a.employee)
    missing = api.patch("/auth/preferences", json={"language": "ar"}, csrf=False)
    assert missing.status_code == 403 and error_code(missing) == "CSRF_FAILED"
    forged = api.patch("/auth/preferences", json={"language": "ar"}, headers={"X-CSRF-Token": "x" * 43})
    assert forged.status_code == 403 and error_code(forged) == "CSRF_FAILED"
    cross_site = api.patch(
        "/auth/preferences", json={"language": "ar"}, headers={"Origin": "https://evil.example"}
    )
    assert cross_site.status_code == 403 and error_code(cross_site) == "CSRF_FAILED"
    assert refreshed(db, User, world.a.employee.id).preferred_language is None


def test_it_works_while_a_password_change_is_required(
    make_client, factory: Factory, db: Session, clock: FakeClock
) -> None:
    """The forced-change screen offers the language switch (B10-3); every other endpoint stays closed."""
    company = factory.company()
    user = factory.user(
        company, must_change_password=True, password_expires_at=clock.peek() + timedelta(hours=72)
    )
    api = _signed_in(make_client, user)
    assert error_code(api.get("/departments")) == "PASSWORD_CHANGE_REQUIRED"

    response = api.patch("/auth/preferences", json={"language": "ar"})

    assert response.status_code == 200
    assert (
        response.json()["user"] | {"preferred_language": "ar", "must_change_password": True}
        == (response.json()["user"])
    )
    assert refreshed(db, User, user.id).preferred_language == "ar"
    assert error_code(api.get("/departments")) == "PASSWORD_CHANGE_REQUIRED"


def test_a_language_change_writes_no_audit_row(make_client, world: World, db: Session) -> None:
    api = _signed_in(make_client, world.a.employee)
    before = _audit_rows_since_start(db)
    for language in ("ar", "en", "ar"):
        assert api.patch("/auth/preferences", json={"language": language}).status_code == 200
    assert _audit_rows_since_start(db) == before


def test_choosing_the_current_language_again_writes_nothing(
    make_client, factory: Factory, db: Session, clock: FakeClock
) -> None:
    company = factory.company()
    user = factory.user(company, preferred_language="en")
    api = _signed_in(make_client, user)  # the sign-in itself writes the user row (last_login_at)
    updated_at = refreshed(db, User, user.id).updated_at
    clock.advance(minutes=5)
    assert api.patch("/auth/preferences", json={"language": "en"}).status_code == 200
    assert refreshed(db, User, user.id).updated_at == updated_at


def test_only_the_callers_own_preference_changes(make_client, world: World, db: Session) -> None:
    api = _signed_in(make_client, world.a.admin)
    assert api.patch("/auth/preferences", json={"language": "ar"}).status_code == 200
    for other in (world.a.employee, world.a.receptionist, world.b.admin):
        assert refreshed(db, User, other.id).preferred_language is None
    # The company's default is not the user's preference.
    assert refreshed(db, Company, world.a.company.id).default_language == "en"


def test_it_spends_the_per_user_api_budget_only(app: FastAPI, make_client, world: World, db: Session) -> None:
    api = _signed_in(make_client, world.a.employee)
    with rate_limits(app, api_per_user=3):
        for language in ("ar", "en", "ar"):
            assert api.patch("/auth/preferences", json={"language": language}).status_code == 200
        throttled = api.patch("/auth/preferences", json={"language": "en"})
    assert throttled.status_code == 429 and error_code(throttled) == "RATE_LIMITED"
    assert "Retry-After" in throttled.headers
    assert refreshed(db, User, world.a.employee.id).preferred_language == "ar"


def test_the_preference_decides_the_language_of_the_users_emails(
    make_client, factory: Factory, client: TestClient, email_provider: MemoryProvider
) -> None:
    """Staff e-mails lead with the recipient's language, else the company's (B10-9)."""
    company = factory.company("Mawdoo3", name_ar="موضوع", default_language="en")
    user = factory.user(company)
    api = _signed_in(make_client, user)
    anonymous = Api(make_client())

    assert anonymous.post("/auth/forgot-password", json={"email": user.email}, csrf=False).status_code == 202
    assert email_provider.sent[-1].subject == "Reset your Mawdoo3 account password"

    assert api.patch("/auth/preferences", json={"language": "ar"}).status_code == 200
    assert anonymous.post("/auth/forgot-password", json={"email": user.email}, csrf=False).status_code == 202
    reset = email_provider.sent[-1]
    assert reset.subject == "إعادة تعيين كلمة مرور حسابك في موضوع"
    assert reset.text.index("مرحبًا") < reset.text.index("Hello")
