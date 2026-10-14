"""Signing in to a deactivated company (Phase 11 review, B11-46).

A user of a company that the platform owner deactivated typed the right password and was told "Invalid
email or password". With valid credentials, and when the company's deactivation is the only obstacle, the
answer is now 409 COMPANY_INACTIVE. Everything else about a sign-in is as it was: a wrong password and an
unknown address get the same 401 after the same single verification, forgot-password says nothing, and
wrong passwords count towards the lockout. The verified refusal does not.
"""

from datetime import timedelta

import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import PlatformAdmin, Role, UserSession
from app.security.passwords import PasswordHasherService
from tests.support import (
    DEFAULT_PASSWORD,
    Api,
    Factory,
    PlatformApi,
    World,
    audit_rows,
    error_code,
    platform_signed_in,
    rate_limits,
)

WRONG = "Wrong-Password-1234"
INVALID = {"code": "INVALID_CREDENTIALS", "message": "Invalid email or password.", "details": {}}


@pytest.fixture
def owner(factory: Factory) -> PlatformAdmin:
    return factory.platform_admin(email="owner@platform.test")


@pytest.fixture
def platform(make_client, owner: PlatformAdmin) -> PlatformApi:
    return platform_signed_in(make_client, owner)


@pytest.fixture
def deactivated(platform: PlatformApi, world: World) -> World:
    assert platform.post(f"/platform/companies/{world.a.company.id}/deactivate").status_code == 200
    return world


def _sessions(db: Session, world: World) -> int:
    return db.scalar(
        select(func.count()).select_from(UserSession).where(UserSession.company_id == world.a.company.id)
    )


def test_the_right_password_is_told_that_the_company_is_deactivated(
    deactivated: World, make_client, db: Session
) -> None:
    before = _sessions(db, deactivated)
    for user in (deactivated.a.admin, deactivated.a.employee, deactivated.a.receptionist):
        response = Api(make_client()).login(user.email)
        assert response.status_code == 409, response.text
        assert response.json()["error"] == {
            "code": "COMPANY_INACTIVE",
            "message": "This company is deactivated.",
            "details": {},
        }
        assert "set-cookie" not in response.headers  # no session, no device trust
        [row] = audit_rows(db, "AUTH_LOGIN_FAILED", actor_user_id=user.id)  # audited as before
        assert row.meta == {"reason": "company_inactive"} and row.company_id == deactivated.a.company.id
    assert _sessions(db, deactivated) == before
    # The other company signs in as ever.
    assert Api(make_client()).login(deactivated.b.admin.email).status_code == 200


def test_only_valid_credentials_reach_that_answer(
    deactivated: World, make_client, factory: Factory, clock: FakeClock
) -> None:
    """Enumeration-safe: without the right password nobody learns that the company is deactivated, or
    that the address has an account at all."""
    wrong = Api(make_client()).login(deactivated.a.admin.email, WRONG)
    unknown = Api(make_client()).login("nobody@alpha.example", WRONG)
    active_company = Api(make_client()).login(deactivated.b.admin.email, WRONG)
    for response in (wrong, unknown, active_company):
        assert response.status_code == 401 and response.json()["error"] == INVALID
    # Nor is it the answer while something else is in the way as well.
    inactive = factory.user(deactivated.a.company, is_active=False)
    expired = factory.user(
        deactivated.a.company,
        must_change_password=True,
        password_expires_at=clock.now() - timedelta(minutes=1),
    )
    for user in (inactive, expired):
        response = Api(make_client()).login(user.email)
        assert response.status_code == 401 and response.json()["error"] == INVALID


def test_one_password_verification_whatever_the_answer(
    deactivated: World, make_client, hasher: PasswordHasherService, monkeypatch: pytest.MonkeyPatch
) -> None:
    verifications: list[int] = []
    verify = hasher.verify  # the dummy verification of an unknown address goes through it as well
    monkeypatch.setattr(hasher, "verify", lambda *args: verifications.append(1) or verify(*args))
    attempts = [
        (deactivated.a.admin.email, DEFAULT_PASSWORD, 409),
        (deactivated.a.admin.email, WRONG, 401),
        ("nobody@alpha.example", WRONG, 401),
        (deactivated.b.admin.email, DEFAULT_PASSWORD, 200),
    ]
    for count, (email, password, status) in enumerate(attempts, start=1):
        assert Api(make_client()).login(email, password).status_code == status
        assert len(verifications) == count  # exactly one more, whatever the answer


def test_the_refusal_is_not_a_failed_attempt(deactivated: World, platform: PlatformApi, make_client) -> None:
    """Retrying while the company is deactivated locks nobody out: not the account (ten failures), not
    the address and e-mail (five). Signing in works the moment the company is reactivated."""
    browser = Api(make_client())
    for _ in range(12):
        assert error_code(browser.login(deactivated.a.admin.email)) == "COMPANY_INACTIVE"
    assert platform.post(f"/platform/companies/{deactivated.a.company.id}/reactivate").status_code == 200
    assert browser.login(deactivated.a.admin.email).status_code == 200
    assert (
        Api(make_client(client=("198.51.100.9", 50000))).login(deactivated.a.admin.email).status_code == 200
    )


def test_wrong_passwords_still_lock_the_account(
    deactivated: World, platform: PlatformApi, make_client, db: Session
) -> None:
    """Brute-force protection is what it was: guesses at a deactivated company's account are counted,
    and once it is locked even the right password is refused before any hashing, with the lockout's own
    answer (which says nothing about the company either)."""
    email = deactivated.a.admin.email
    for host in range(1, 11):
        assert Api(make_client(client=(f"198.51.100.{host}", 50000))).login(email, WRONG).status_code == 401
    response = Api(make_client(client=("198.51.100.99", 50000))).login(email)
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_user_id=deactivated.a.admin.id)
    assert platform.post(f"/platform/companies/{deactivated.a.company.id}/reactivate").status_code == 200
    assert Api(make_client(client=("198.51.100.98", 50000))).login(email).status_code == 429  # still locked


def test_verified_refusals_are_bounded_like_sign_ins(app: FastAPI, deactivated: World, make_client) -> None:
    """Each one costs a password verification and an audit row, so it takes a slot of the account's
    successful sign-ins (SEC-02); beyond them the answer is 429 before any hashing."""
    with rate_limits(app, login_successes_account=3):
        for _ in range(3):
            assert Api(make_client()).login(deactivated.a.admin.email).status_code == 409
        response = Api(make_client()).login(deactivated.a.admin.email)
        assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
        assert int(response.headers["retry-after"]) > 0


def test_forgot_password_stays_silent(
    deactivated: World, make_client, email_provider: MemoryProvider
) -> None:
    sent = len(email_provider.sent)
    answers = [
        Api(make_client()).post("/auth/forgot-password", json={"email": email}, csrf=False)
        for email in (deactivated.a.admin.email, deactivated.b.admin.email, "nobody@alpha.example")
    ]
    assert {response.status_code for response in answers} == {202}
    assert len({response.text.split('"request_id"')[0] for response in answers}) == 1  # identical bodies
    # Only the active company's account got a link.
    assert [email.to for email in email_provider.sent[sent:]] == [deactivated.b.admin.email]


def test_a_must_change_account_gets_the_same_answer(
    deactivated: World, make_client, factory: Factory
) -> None:
    pending = factory.user(deactivated.a.company, roles=(Role.SYSTEM_ADMIN,), must_change_password=True)
    assert error_code(Api(make_client()).login(pending.email)) == "COMPANY_INACTIVE"


def test_the_platform_owner_s_sign_in_knows_no_such_answer(
    deactivated: World, owner: PlatformAdmin, make_client
) -> None:
    """The platform owner belongs to no company: deactivated companies change nothing for it, and its
    sign-in never answers COMPANY_INACTIVE (a company user's credentials are simply invalid there)."""
    assert PlatformApi(make_client()).login(owner.email, DEFAULT_PASSWORD).status_code == 200
    response = PlatformApi(make_client()).login(deactivated.a.admin.email, DEFAULT_PASSWORD)
    assert response.status_code == 401 and response.json()["error"] == INVALID
    assert PlatformApi(make_client()).login(owner.email, WRONG).json()["error"] == INVALID
