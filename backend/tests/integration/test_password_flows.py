import re
from collections import Counter
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import EmailMessage, PasswordResetToken, User, UserSession
from app.security.passwords import PasswordHasherService
from app.security.tokens import hash_token
from tests.support import (
    DEFAULT_PASSWORD,
    Api,
    Factory,
    World,
    audit_rows,
    error_code,
    rate_limits,
    refreshed,
)

NEW_PASSWORD = "Brand-New-Passphrase-77"
ACCEPTED = {
    "message": "If an account exists for that email address, we have sent instructions to reset the password."
}


def _live_sessions(db: Session, user_id) -> list[UserSession]:
    db.expire_all()
    return list(
        db.scalars(
            select(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        )
    )


def _reset_token_from(provider: MemoryProvider) -> str:
    assert provider.sent, "no e-mail was sent"
    match = re.search(r"#token=([A-Za-z0-9_-]+)", provider.sent[-1].reset_url or "")
    assert match
    return match.group(1)


# ---- forced change gate -------------------------------------------------------------------------


@pytest.fixture
def forced(client: TestClient, factory: Factory, clock: FakeClock) -> tuple[Api, User]:
    company = factory.company()
    factory.department(company, "Finance")
    user = factory.user(
        company, must_change_password=True, password_expires_at=clock.peek() + timedelta(hours=72)
    )
    api = Api(client)
    assert api.login(user.email).status_code == 200
    return api, user


@pytest.mark.parametrize(
    ("method", "path"),
    [("get", "/users/hosts"), ("get", "/departments"), ("get", "/company/settings")],
)
def test_password_change_gate_blocks_other_endpoints(forced, method: str, path: str) -> None:
    api, _user = forced
    response = getattr(api, method)(path)
    assert response.status_code == 403
    assert error_code(response) == "PASSWORD_CHANGE_REQUIRED"
    assert response.json()["error"]["message"] == "You must change your password before continuing."


def test_password_change_gate_allows_me_change_and_logout(forced, db: Session) -> None:
    api, user = forced
    assert api.get("/auth/me").json()["user"]["must_change_password"] is True
    response = api.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 204
    stored = refreshed(db, User, user.id)
    assert stored.must_change_password is False
    assert stored.password_expires_at is None
    assert stored.password_changed_at is not None
    assert api.get("/departments").status_code == 200
    assert api.post("/auth/logout").status_code == 204


def test_change_password_rejects_reuse_of_the_temporary_password(forced) -> None:
    api, _user = forced
    response = api.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": DEFAULT_PASSWORD}
    )
    assert response.status_code == 422
    assert "new_password" in response.json()["error"]["details"]["fields"]


# ---- change password ----------------------------------------------------------------------------


def test_change_password_with_wrong_current_password(client: TestClient, world: World, db: Session) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    response = api.post(
        "/auth/change-password", json={"current_password": "Not-My-Password-1", "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 400
    assert response.json()["error"] == {
        "code": "INVALID_CURRENT_PASSWORD",
        "message": "Your current password is incorrect.",
        "details": {},
    }
    rows = audit_rows(db, "AUTH_PASSWORD_CHANGE_FAILED", actor_user_id=world.a.employee.id)
    assert len(rows) == 1 and rows[0].meta == {"reason": "invalid_current_password"}


@pytest.mark.parametrize(
    ("new_password", "fragment"),
    [
        ("short-1", "at least 12"),
        ("x" * 129, "at most 128"),
        ("password1234", "too common"),
    ],
)
def test_change_password_policy(client: TestClient, world: World, new_password: str, fragment: str) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    response = api.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": new_password}
    )
    assert response.status_code == 422
    assert fragment in response.json()["error"]["details"]["fields"]["new_password"]


def test_change_password_rejects_email_as_password(client: TestClient, factory: Factory) -> None:
    company = factory.company()
    user = factory.user(company, email="long.address.here@example.com")
    api = Api(client)
    api.login(user.email)
    response = api.post(
        "/auth/change-password",
        json={"current_password": DEFAULT_PASSWORD, "new_password": "LONG.ADDRESS.HERE@example.com"},
    )
    assert response.status_code == 422


def test_change_password_revokes_other_sessions_only(make_client, world: World, db: Session) -> None:
    current = Api(make_client())
    other = Api(make_client())
    current.login(world.a.employee.email)
    other.login(world.a.employee.email)
    db.add(
        PasswordResetToken(
            user_id=world.a.employee.id,
            token_hash="a" * 64,
            expires_at=refreshed(db, User, world.a.employee.id).created_at + timedelta(days=1),
        )
    )
    db.commit()

    response = current.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 204
    assert current.get("/auth/me").status_code == 200
    assert other.get("/auth/me").status_code == 401
    (live,) = _live_sessions(db, world.a.employee.id)
    rows = audit_rows(db, "AUTH_PASSWORD_CHANGED", actor_user_id=world.a.employee.id)
    assert rows[-1].meta["revoked_sessions"] == 1 and rows[-1].meta["session_id"] == str(live.id)
    assert current.login(world.a.employee.email, NEW_PASSWORD).status_code == 200


def test_change_password_replaces_the_current_session(make_client, world: World, db: Session) -> None:
    """SEC-04: a copy of the session cookie taken before the change (an unattended tablet, a borrowed
    browser profile) stops working; the browser that made the change continues on a new session."""
    owner = Api(make_client())
    assert owner.login(world.a.employee.email).status_code == 200
    stolen = Api(make_client())
    stolen.client.cookies.update(owner.client.cookies)
    old_session, old_csrf = owner.session_token, owner.csrf_token
    assert stolen.get("/visits").status_code == 200

    response = owner.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 204 and response.content == b""
    assert owner.session_token not in (None, old_session)
    assert owner.csrf_token not in (None, old_csrf)

    assert stolen.get("/visits").status_code == 401
    assert stolen.get("/auth/me").status_code == 401
    copied = stolen.post("/visitors", json={"full_name": "Copied Session Probe"})
    assert copied.status_code in {401, 403}
    assert owner.get("/visits").status_code == 200
    created = owner.post("/visitors", json={"full_name": "Owner After Change"})
    assert created.status_code == 201  # the new CSRF token goes with the new session
    assert len(_live_sessions(db, world.a.employee.id)) == 1


# ---- forgot / reset password --------------------------------------------------------------------


def test_forgot_password_is_identical_for_unknown_and_known(
    client: TestClient, world: World, email_provider: MemoryProvider, db: Session
) -> None:
    api = Api(client)
    unknown = api.post("/auth/forgot-password", json={"email": "nobody@example.com"}, csrf=False)
    known = api.post("/auth/forgot-password", json={"email": world.a.employee.email.upper()}, csrf=False)

    assert unknown.status_code == known.status_code == 202
    assert unknown.json() == known.json() == ACCEPTED
    assert len(email_provider.sent) == 1
    sent = email_provider.sent[0]
    assert sent.to == world.a.employee.email
    # The company's own reset page (B12-14): its slug in the query, the token alone in the fragment.
    assert sent.reset_url.startswith(f"https://vms.test/reset-password?c={world.a.company.slug}#token=")
    assert sent.reset_url in sent.text
    db.expire_all()
    message = db.scalars(
        select(EmailMessage).where(EmailMessage.recipient_user_id == world.a.employee.id)
    ).one()
    assert message.status == "SENT" and message.kind == "PASSWORD_RESET" and message.attempts == 1
    requested = audit_rows(db, "AUTH_PASSWORD_RESET_REQUESTED", entity_id=world.a.employee.id)
    assert len(requested) == 1 and requested[0].actor_user_id is None


def test_forgot_password_for_inactive_user_sends_nothing(
    client: TestClient, factory: Factory, email_provider: MemoryProvider
) -> None:
    company = factory.company()
    user = factory.user(company, is_active=False)
    response = Api(client).post("/auth/forgot-password", json={"email": user.email}, csrf=False)
    assert response.status_code == 202
    assert email_provider.sent == []


def test_reset_password_once(
    client: TestClient, make_client, world: World, email_provider: MemoryProvider, db: Session
) -> None:
    logged_in = Api(make_client())
    logged_in.login(world.a.employee.email)
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    token = _reset_token_from(email_provider)

    response = api.post(
        "/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD}, csrf=False
    )
    assert response.status_code == 204
    assert logged_in.get("/auth/me").status_code == 401  # every session revoked
    assert api.login(world.a.employee.email, NEW_PASSWORD).status_code == 200
    assert len(audit_rows(db, "AUTH_PASSWORD_RESET_COMPLETED", actor_user_id=world.a.employee.id)) == 1

    again = api.post(
        "/auth/reset-password", json={"token": token, "new_password": "Another-Passphrase-88"}, csrf=False
    )
    assert again.status_code == 400
    assert again.json()["error"] == {
        "code": "INVALID_RESET_TOKEN",
        "message": "This password reset link is invalid or has expired.",
        "details": {},
    }
    assert len(audit_rows(db, "AUTH_PASSWORD_RESET_FAILED")) == 1


def test_reset_token_expires_after_30_minutes(
    client: TestClient, world: World, email_provider: MemoryProvider, clock: FakeClock
) -> None:
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    token = _reset_token_from(email_provider)
    clock.advance(minutes=30, seconds=1)
    response = api.post(
        "/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD}, csrf=False
    )
    assert response.status_code == 400


def test_new_reset_request_invalidates_previous_token(
    client: TestClient, world: World, email_provider: MemoryProvider, clock: FakeClock
) -> None:
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    first = _reset_token_from(email_provider)
    clock.advance(minutes=1)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    second = _reset_token_from(email_provider)
    assert first != second
    stale = api.post("/auth/reset-password", json={"token": first, "new_password": NEW_PASSWORD}, csrf=False)
    assert stale.status_code == 400
    fresh = api.post("/auth/reset-password", json={"token": second, "new_password": NEW_PASSWORD}, csrf=False)
    assert fresh.status_code == 204


def _stored_token(db: Session, raw: str) -> PasswordResetToken:
    db.expire_all()
    return db.scalars(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(raw))
    ).one()


def test_superseded_token_stays_invalid_when_the_clock_steps_back(
    client: TestClient, world: World, email_provider: MemoryProvider, clock: FakeClock, db: Session
) -> None:
    start = clock.peek()
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    first = _reset_token_from(email_provider)
    clock.advance(seconds=5)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)  # supersedes it

    # The application clock now reads earlier than the invalidation: an NTP step back, a resumed VM, or a
    # second instance whose clock lags behind.
    with app_time.using_clock(FakeClock(start + timedelta(seconds=4))):
        stale = api.post(
            "/auth/reset-password", json={"token": first, "new_password": NEW_PASSWORD}, csrf=False
        )
    assert stale.status_code == 400
    assert error_code(stale) == "INVALID_RESET_TOKEN"
    stored = _stored_token(db, first)
    assert stored.invalidated_at is not None and stored.used_at is None
    assert stored.expires_at == stored.created_at + timedelta(minutes=30)  # the lifetime is untouched
    assert api.login(world.a.employee.email, NEW_PASSWORD).status_code == 401


def test_invalidation_includes_tokens_the_clock_already_considers_expired(
    client: TestClient, world: World, email_provider: MemoryProvider, clock: FakeClock, db: Session
) -> None:
    start = clock.peek()
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    first = _reset_token_from(email_provider)
    clock.advance(minutes=31)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    assert _stored_token(db, first).invalidated_at is not None

    with app_time.using_clock(FakeClock(start + timedelta(minutes=10))):  # inside its old lifetime
        stale = api.post(
            "/auth/reset-password", json={"token": first, "new_password": NEW_PASSWORD}, csrf=False
        )
    assert stale.status_code == 400


def test_password_change_invalidates_unused_reset_tokens(
    make_client, world: World, email_provider: MemoryProvider, db: Session
) -> None:
    anonymous = Api(make_client())
    anonymous.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    token = _reset_token_from(email_provider)
    owner = Api(make_client())
    owner.login(world.a.employee.email)
    changed = owner.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert changed.status_code == 204
    assert _stored_token(db, token).invalidated_at is not None
    stale = anonymous.post(
        "/auth/reset-password", json={"token": token, "new_password": "Another-Passphrase-88"}, csrf=False
    )
    assert stale.status_code == 400


def test_weak_password_keeps_reset_link_usable(
    client: TestClient, world: World, email_provider: MemoryProvider
) -> None:
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    token = _reset_token_from(email_provider)
    weak = api.post("/auth/reset-password", json={"token": token, "new_password": "short"}, csrf=False)
    assert weak.status_code == 422
    ok = api.post("/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD}, csrf=False)
    assert ok.status_code == 204


def test_reset_clears_forced_change_and_temporary_expiry(
    client: TestClient, factory: Factory, email_provider: MemoryProvider, db: Session, clock: FakeClock
) -> None:
    company = factory.company()
    user = factory.user(
        company, must_change_password=True, password_expires_at=clock.peek() - timedelta(hours=1)
    )
    api = Api(client)
    api.post("/auth/forgot-password", json={"email": user.email}, csrf=False)
    token = _reset_token_from(email_provider)
    assert (
        api.post(
            "/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD}, csrf=False
        ).status_code
        == 204
    )
    stored = refreshed(db, User, user.id)
    assert stored.must_change_password is False and stored.password_expires_at is None


def test_malformed_reset_token(client: TestClient) -> None:
    response = Api(client).post(
        "/auth/reset-password", json={"token": "not a token!", "new_password": NEW_PASSWORD}, csrf=False
    )
    assert response.status_code == 400


def test_forgot_password_throttles_drop_silently(
    client: TestClient, world: World, email_provider: MemoryProvider, db: Session
) -> None:
    api = Api(client)
    for _ in range(3):
        assert (
            api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False).json()
            == ACCEPTED
        )
    dropped = api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    assert dropped.status_code == 202 and dropped.json() == ACCEPTED
    assert len(email_provider.sent) == 3
    row = audit_rows(db, "RATE_LIMITED")[-1]
    assert row.meta == {"policy": "forgot_password_account"}
    # Attributed to the account's company (visible to its administrators); the requester is anonymous.
    assert (row.company_id, row.actor_user_id) == (world.a.company.id, None)
    assert (row.entity_type, row.entity_id) == ("user", world.a.employee.id)


def test_forgot_password_account_limit_holds_across_addresses(
    make_client, world: World, email_provider: MemoryProvider
) -> None:
    # The per-account budget is keyed by the account, not by the client: rotating addresses cannot
    # flood a user's mailbox (or keep replacing their reset link).
    for index in range(6):
        api = Api(make_client(client=(f"198.51.100.{index + 1}", 1000)))
        api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    assert len(email_provider.sent) == 3


def test_forgot_password_for_unknown_addresses_keeps_no_per_address_state(
    client: TestClient, app: FastAPI
) -> None:
    api = Api(client)
    for index in range(5):
        response = api.post(
            "/auth/forgot-password", json={"email": f"nobody-{index}@example.com"}, csrf=False
        )
        assert response.status_code == 202
    stats = app.state.service_environment.limiter.stats()
    assert (stats.network_buckets, stats.email_buckets) == (1, 0)  # only the client's own budget


def test_forgot_password_ip_throttle(make_client, factory: Factory, email_provider: MemoryProvider) -> None:
    company = factory.company()
    users = [factory.user(company) for _ in range(11)]
    api = Api(make_client(client=("192.0.2.77", 1000)))
    for user in users:
        assert api.post("/auth/forgot-password", json={"email": user.email}, csrf=False).status_code == 202
    assert len(email_provider.sent) == 10


def test_deactivation_invalidates_reset_tokens(
    make_client, world: World, email_provider: MemoryProvider
) -> None:
    anonymous = Api(make_client())
    anonymous.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    token = _reset_token_from(email_provider)

    admin = Api(make_client())
    admin.login(world.a.admin.email)
    assert admin.patch(f"/users/{world.a.employee.id}", json={"is_active": False}).status_code == 200
    admin.patch(f"/users/{world.a.employee.id}", json={"is_active": True})

    response = anonymous.post(
        "/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD}, csrf=False
    )
    assert response.status_code == 400


# ---- guessing the current password (change-password throttle) ----------------------------------


def _wrong_change(api: Api):
    return api.post(
        "/auth/change-password", json={"current_password": "Not-My-Password-1", "new_password": NEW_PASSWORD}
    )


def test_current_password_guessing_ends_the_session(make_client, world: World, db: Session) -> None:
    api = Api(make_client())
    api.login(world.a.receptionist.email)
    for _ in range(4):
        assert error_code(_wrong_change(api)) == "INVALID_CURRENT_PASSWORD"
        assert api.get("/auth/me").status_code == 200

    fifth = _wrong_change(api)
    assert fifth.status_code == 400 and error_code(fifth) == "INVALID_CURRENT_PASSWORD"
    assert api.get("/auth/me").status_code == 401  # the session is gone: the password is needed again
    rows = audit_rows(db, "AUTH_PASSWORD_CHANGE_FAILED", actor_user_id=world.a.receptionist.id)
    assert len(rows) == 5
    assert rows[-1].meta == {"reason": "invalid_current_password", "session_revoked": True}
    assert rows[0].meta == {"reason": "invalid_current_password"}


def test_current_password_guessing_is_throttled_across_sessions(
    make_client, world: World, db: Session, clock: FakeClock
) -> None:
    first, second = Api(make_client()), Api(make_client())
    first.login(world.a.employee.email)
    second.login(world.a.employee.email)
    for _ in range(5):
        _wrong_change(first)

    # Even the right password is refused until the budget recovers; no verification is attempted.
    blocked = second.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert blocked.status_code == 429 and error_code(blocked) == "RATE_LIMITED"
    assert int(blocked.headers["Retry-After"]) > 0
    assert audit_rows(db, "RATE_LIMITED", actor_user_id=world.a.employee.id)[-1].meta["policy"] == (
        "password_change_failures"
    )

    clock.advance(minutes=15, seconds=1)
    ok = second.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert ok.status_code == 204


def test_successful_change_resets_the_guess_budget(make_client, world: World) -> None:
    api = Api(make_client())
    api.login(world.a.employee.email)
    for _ in range(4):
        _wrong_change(api)
    assert (
        api.post(
            "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
        ).status_code
        == 204
    )
    for _ in range(4):
        assert error_code(_wrong_change(api)) == "INVALID_CURRENT_PASSWORD"
    assert api.get("/auth/me").status_code == 200


def test_reset_password_is_throttled_per_ip_before_the_token_lookup(make_client, db: Session) -> None:
    api = Api(make_client(client=("192.0.2.88", 1000)))
    body = {"token": "x" * 43, "new_password": NEW_PASSWORD}
    for _ in range(20):
        assert api.post("/auth/reset-password", json=body, csrf=False).status_code == 400
    throttled = api.post("/auth/reset-password", json=body, csrf=False)
    assert throttled.status_code == 429 and error_code(throttled) == "RATE_LIMITED"
    assert int(throttled.headers["Retry-After"]) > 0
    assert len(audit_rows(db, "AUTH_PASSWORD_RESET_FAILED")) == 20  # no row per further request

    other = Api(make_client(client=("192.0.2.89", 1000)))
    assert other.post("/auth/reset-password", json=body, csrf=False).status_code == 400


# ---- guessable passwords are refused wherever a password is set (SEC-03) --------------------------


def test_spray_shaped_passwords_are_refused_everywhere(
    make_client, factory: Factory, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """The finding's sequence: an administrator's temporary password "Welcome@2026", then a change to
    "Password@2026"; and a password built from the user's own name. Each is refused on its field, and a
    refused new password is answered before the current one is even checked (no guess spent)."""
    company = factory.company("Demo Company")
    admin = Api(make_client())
    assert admin.login(world.a.admin.email).status_code == 200
    created = admin.post(
        "/users",
        json={
            "full_name": "Jane Doe",
            "email": "jane.doe@demo.local",
            "roles": ["EMPLOYEE"],
            "temporary_password": "Welcome@2026",
        },
    )
    assert created.status_code == 422
    assert "too easy to guess" in created.json()["error"]["details"]["fields"]["temporary_password"]
    assert audit_rows(db, "USER_CREATED") == []

    jane = factory.user(company, email="jane.doe@demo.local", full_name="Jane Doe")
    api = Api(make_client())
    assert api.login(jane.email).status_code == 200
    for weak in ("Password@2026", "JaneDoe@2026", "Demo-Company-26"):
        response = api.post(
            "/auth/change-password", json={"current_password": "Not-My-Password-1", "new_password": weak}
        )
        assert response.status_code == 422, weak
        assert "too easy to guess" in response.json()["error"]["details"]["fields"]["new_password"]
    assert audit_rows(db, "AUTH_PASSWORD_CHANGE_FAILED") == []  # nothing was verified, nothing counted

    assert api.post("/auth/forgot-password", json={"email": jane.email}, csrf=False).status_code == 202
    token = _reset_token_from(email_provider)
    weak_reset = Api(make_client()).post(
        "/auth/reset-password", json={"token": token, "new_password": "Spring2026!!"}, csrf=False
    )
    assert weak_reset.status_code == 422
    strong_reset = Api(make_client()).post(
        "/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD}, csrf=False
    )
    assert strong_reset.status_code == 204  # the refused attempt left the link usable


# ---- "your password was changed" (SEC-06) ----------------------------------------------------------


def _notices(provider: MemoryProvider) -> list:
    return [email for email in provider.sent if email.kind == "PASSWORD_CHANGED"]


def test_a_password_change_and_a_reset_notify_the_account(
    make_client, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    user = world.a.employee
    api = Api(make_client(client=("198.51.100.77", 1234)))
    assert api.login(user.email).status_code == 200
    changed = api.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert changed.status_code == 204
    (notice,) = _notices(email_provider)
    assert notice.to == user.email
    assert "password was changed" in notice.subject
    assert "198.51.100.77" in notice.text and "/forgot-password" in notice.text
    assert NEW_PASSWORD not in notice.text and DEFAULT_PASSWORD not in notice.html
    row = refreshed(db, EmailMessage, notice.message_id)
    assert (row.kind, row.status, row.recipient_user_id) == ("PASSWORD_CHANGED", "SENT", user.id)
    (audited,) = audit_rows(db, "AUTH_PASSWORD_CHANGED", actor_user_id=user.id)
    assert audited.meta["email_message_id"] == str(notice.message_id)

    assert api.post("/auth/forgot-password", json={"email": user.email}, csrf=False).status_code == 202
    token = _reset_token_from(email_provider)
    reset = Api(make_client()).post(
        "/auth/reset-password", json={"token": token, "new_password": "Another-Passphrase-88"}, csrf=False
    )
    assert reset.status_code == 204
    assert [email.subject for email in _notices(email_provider)][-1].endswith("password was reset")
    assert len(_notices(email_provider)) == 2


def test_password_change_notices_have_an_hourly_budget(
    app: FastAPI, client: TestClient, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """A script that changes its own password back and forth must not use up the provider's quota: five
    notices an hour, then the change is still made and only the e-mail is left out (audited). The
    changes themselves have a budget of the same size (SEC-43), raised here to reach the notices'."""
    api = Api(client)
    assert api.login(world.a.employee.email).status_code == 200
    passwords = [DEFAULT_PASSWORD, NEW_PASSWORD, "Another-Passphrase-88"]
    with rate_limits(app, password_changes_per_user=10):
        for index in range(6):
            response = api.post(
                "/auth/change-password",
                json={"current_password": passwords[index % 3], "new_password": passwords[(index + 1) % 3]},
            )
            assert response.status_code == 204, response.text
    assert len(_notices(email_provider)) == 5
    rows = audit_rows(db, "AUTH_PASSWORD_CHANGED", actor_user_id=world.a.employee.id)
    assert rows[-1].meta["notice"] == "limited" and "email_message_id" not in rows[-1].meta


def test_successful_password_changes_have_a_budget_per_account(
    make_client,
    client: TestClient,
    world: World,
    db: Session,
    clock: FakeClock,
    hasher: PasswordHasherService,
    email_provider: MemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SEC-43: only wrong current passwords were counted, and a success cleared even those, so one
    credential could change its password back and forth at the API rate: two Argon2 operations on the
    process-wide hash pool and a permanent audit row and a session row per request. Five changes an hour
    per account; the sixth is refused before any hashing, and a password reset still works."""
    user = world.a.employee
    api = Api(make_client())
    assert api.login(user.email).status_code == 200
    passwords = [DEFAULT_PASSWORD, NEW_PASSWORD]
    for index in range(5):
        response = api.post(
            "/auth/change-password",
            json={"current_password": passwords[index % 2], "new_password": passwords[(index + 1) % 2]},
        )
        assert response.status_code == 204, response.text
    stored_hash = refreshed(db, User, user.id).password_hash

    hashing: Counter[str] = Counter()
    for name in ("verify", "hash"):
        original = getattr(hasher, name)
        monkeypatch.setattr(
            hasher,
            name,
            lambda *args, _name=name, _original=original: hashing.update([_name]) or _original(*args),
        )
    for current in (NEW_PASSWORD, "Not-My-Password-1"):  # right or wrong: nothing is verified
        refused = api.post(
            "/auth/change-password",
            json={"current_password": current, "new_password": "Another-Passphrase-88"},
        )
        assert refused.status_code == 429 and error_code(refused) == "RATE_LIMITED", refused.text
        assert 0 < int(refused.headers["Retry-After"]) <= 3600
    assert hashing == Counter()
    assert refreshed(db, User, user.id).password_hash == stored_hash
    assert len(audit_rows(db, "AUTH_PASSWORD_CHANGED", actor_user_id=user.id)) == 5
    assert audit_rows(db, "AUTH_PASSWORD_CHANGE_FAILED", actor_user_id=user.id) == []
    assert (
        audit_rows(db, "RATE_LIMITED", actor_user_id=user.id)[-1].meta["policy"]
        == "password_changes_per_user"
    )
    assert api.get("/auth/me").status_code == 200  # the session is kept

    other = Api(make_client())
    assert other.login(world.a.receptionist.email).status_code == 200
    changed = other.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert changed.status_code == 204  # another account's budget

    hashing.clear()
    clock.advance(hours=1, seconds=1)  # the first change has left the window
    again = api.post(
        "/auth/change-password",
        json={"current_password": NEW_PASSWORD, "new_password": "Another-Passphrase-88"},
    )
    assert again.status_code == 204, again.text
    assert hashing == Counter({"verify": 1, "hash": 1})


def test_a_spent_change_budget_leaves_the_password_reset(
    app: FastAPI, make_client, client: TestClient, world: World, email_provider: MemoryProvider
) -> None:
    api = Api(make_client())
    assert api.login(world.a.employee.email).status_code == 200
    with rate_limits(app, password_changes_per_user=1):
        first = api.post(
            "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
        )
        assert first.status_code == 204
        second = api.post(
            "/auth/change-password",
            json={"current_password": NEW_PASSWORD, "new_password": "Another-Passphrase-88"},
        )
        assert second.status_code == 429
        anonymous = Api(client)
        anonymous.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
        reset = anonymous.post(
            "/auth/reset-password",
            json={"token": _reset_token_from(email_provider), "new_password": "Another-Passphrase-88"},
            csrf=False,
        )
        assert reset.status_code == 204
    assert anonymous.login(world.a.employee.email, "Another-Passphrase-88").status_code == 200
