from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import Role, User, UserSession
from app.security.passwords import Argon2Parameters, PasswordHasherService
from tests.support import (
    DEFAULT_PASSWORD,
    Api,
    Factory,
    World,
    audit_rows,
    error_code,
    no_brand,
    refreshed,
)

INVALID = {"code": "INVALID_CREDENTIALS", "message": "Invalid email or password.", "details": {}}


def test_login_success_sets_cookies_and_returns_me(client: TestClient, world: World, db: Session) -> None:
    api = Api(client)
    response = api.login(world.a.admin.email)

    assert response.status_code == 200
    body = response.json()
    assert body["user"] == {
        "id": str(world.a.admin.id),
        "full_name": world.a.admin.full_name,
        "email": world.a.admin.email,
        "phone": None,
        "roles": ["SYSTEM_ADMIN"],
        "department": {"id": str(world.a.finance.id), "name": "Finance", "name_ar": None},
        "must_change_password": False,
        "preferred_language": None,
    }
    assert body["company"] == {
        "id": str(world.a.company.id),
        "name": world.a.company.name,
        "name_ar": None,
        "slug": world.a.company.slug,
        "timezone": "Asia/Amman",
        "default_language": "en",
        # Its identity (B12-11): no logo, icon or colour yet.
        "brand": no_brand(),
    }

    cookies = {c.split("=", 1)[0]: c for c in response.headers.get_list("set-cookie")}
    session_cookie = cookies["__Host-vms_session"].lower()
    csrf_cookie = cookies["__Host-vms_csrf"].lower()
    assert "httponly" in session_cookie and "secure" in session_cookie
    assert "samesite=lax" in session_cookie and "path=/" in session_cookie
    assert "domain=" not in session_cookie
    assert "httponly" not in csrf_cookie and "secure" in csrf_cookie
    assert "samesite=strict" in csrf_cookie and "path=/" in csrf_cookie
    assert api.session_token and api.csrf_token and api.session_token != api.csrf_token

    rows = audit_rows(db, "AUTH_LOGIN_SUCCEEDED", entity_id=world.a.admin.id)
    assert len(rows) == 1
    assert rows[0].company_id == world.a.company.id
    assert rows[0].actor_user_id == world.a.admin.id
    assert str(rows[0].ip_address) == "203.0.113.10"
    assert rows[0].request_id
    assert refreshed(db, User, world.a.admin.id).last_login_at is not None


def test_login_normalises_email(client: TestClient, factory: Factory) -> None:
    company = factory.company()
    factory.user(company, email="mixed.case@example.com")
    response = Api(client).login("  MIXED.Case@Example.COM ")
    assert response.status_code == 200


@pytest.mark.parametrize("scenario", ["bad_password", "inactive", "unknown_account", "password_expired"])
def test_login_failures_are_identical_and_audited(
    scenario: str, client: TestClient, factory: Factory, db: Session, clock: FakeClock
) -> None:
    company = factory.company()
    user = factory.user(
        company,
        is_active=scenario != "inactive",
        must_change_password=scenario == "password_expired",
        password_expires_at=clock.peek() - timedelta(minutes=1) if scenario == "password_expired" else None,
    )
    email = "nobody@example.com" if scenario == "unknown_account" else user.email
    password = "Wrong-Password-123" if scenario == "bad_password" else DEFAULT_PASSWORD

    response = Api(client).login(email, password)

    assert response.status_code == 401
    assert response.json()["error"] == INVALID
    assert "set-cookie" not in response.headers
    rows = audit_rows(db, "AUTH_LOGIN_FAILED")
    assert len(rows) == 1
    assert rows[0].meta == {"reason": scenario}
    if scenario == "unknown_account":
        assert rows[0].company_id is None and rows[0].actor_user_id is None and rows[0].entity_id is None
    else:
        assert rows[0].company_id == company.id and rows[0].actor_user_id == user.id


def test_temporary_password_within_validity_logs_in_with_change_required(
    client: TestClient, factory: Factory, clock: FakeClock
) -> None:
    company = factory.company()
    user = factory.user(
        company, must_change_password=True, password_expires_at=clock.peek() + timedelta(hours=1)
    )
    response = Api(client).login(user.email)
    assert response.status_code == 200
    assert response.json()["user"]["must_change_password"] is True


def test_login_rate_limit_per_ip_and_email(client: TestClient, world: World, db: Session) -> None:
    api = Api(client)
    for _ in range(5):
        assert api.login(world.a.employee.email, "Wrong-Password-123").status_code == 401

    blocked = api.login(world.a.employee.email, DEFAULT_PASSWORD)  # even the right password
    assert blocked.status_code == 429
    assert error_code(blocked) == "RATE_LIMITED"
    assert int(blocked.headers["Retry-After"]) > 0
    rows = audit_rows(db, "RATE_LIMITED")
    assert rows[-1].meta["policy"] == "login_failures_ip_email"

    # A different address from the same IP is unaffected.
    assert api.login(world.a.admin.email).status_code == 200


def test_login_window_expires_with_time(client: TestClient, world: World, clock: FakeClock) -> None:
    api = Api(client)
    for _ in range(5):
        api.login(world.a.employee.email, "Wrong-Password-123")
    assert api.login(world.a.employee.email).status_code == 429
    clock.advance(minutes=5, seconds=1)
    assert api.login(world.a.employee.email).status_code == 200


def test_account_lockout_across_ips(make_client, world: World, db: Session, clock: FakeClock) -> None:
    email = world.a.employee.email
    for index in range(10):
        client = make_client(client=(f"198.51.100.{index + 1}", 40000))
        assert Api(client).login(email, "Wrong-Password-123").status_code == 401

    throttled = audit_rows(db, "AUTH_ACCOUNT_THROTTLED")
    assert len(throttled) == 1
    assert throttled[0].actor_user_id == world.a.employee.id

    fresh = Api(make_client(client=("198.51.100.200", 40000)))
    response = fresh.login(email, DEFAULT_PASSWORD)
    assert response.status_code == 429
    assert response.json()["error"]["message"] == "Too many attempts. Try again later."
    assert int(response.headers["Retry-After"]) > 0

    clock.advance(minutes=15, seconds=1)
    assert fresh.login(email, DEFAULT_PASSWORD).status_code == 200


def test_login_failures_per_ip_counts_failures_only(make_client, factory: Factory) -> None:
    company = factory.company()
    users = [factory.user(company) for _ in range(31)]
    api = Api(make_client(client=("192.0.2.50", 1234)))
    for user in users[:30]:
        assert api.login(user.email, "Wrong-Password-123").status_code == 401
    response = api.login(users[30].email)
    assert response.status_code == 429
    assert error_code(response) == "RATE_LIMITED"


def test_successful_logins_do_not_consume_ip_budget(make_client, factory: Factory) -> None:
    company = factory.company()
    users = [factory.user(company) for _ in range(2)]  # an office NAT: many sign-ins, one address
    api = Api(make_client(client=("192.0.2.51", 1234)))
    for _ in range(20):
        for user in users:
            assert api.login(user.email).status_code == 200


def test_successful_logins_of_one_account_have_a_budget(
    make_client, factory: Factory, db: Session, clock: FakeClock
) -> None:
    """SEC-02/SEC-14: every sign-in runs Argon2 and writes a session and an audit row that are never
    deleted, so one credential cannot sign in without bound (30 per account and 15 minutes). Beyond
    the budget the attempt is refused before any hashing, from any address, and nothing is written."""
    company = factory.company()
    user = factory.user(company)
    for index in range(30):
        api = Api(make_client(client=(f"192.0.2.{60 + index % 3}", 1234)))
        assert api.login(user.email).status_code == 200
    sessions_before = len(list(db.scalars(select(UserSession).where(UserSession.user_id == user.id))))
    refused = Api(make_client(client=("198.51.100.99", 1234))).login(user.email)
    assert refused.status_code == 429 and error_code(refused) == "RATE_LIMITED"
    assert int(refused.headers["Retry-After"]) > 0
    db.expire_all()
    assert len(list(db.scalars(select(UserSession).where(UserSession.user_id == user.id)))) == sessions_before
    assert len(audit_rows(db, "AUTH_LOGIN_SUCCEEDED", actor_user_id=user.id)) == 30
    (limited,) = audit_rows(db, "RATE_LIMITED", company_id=company.id)
    assert limited.meta == {"policy": "login_successes_account"}
    # Wrong passwords never spend it; other accounts are unaffected; it frees up with the window.
    other = factory.user(company)
    assert Api(make_client(client=("192.0.2.70", 1234))).login(other.email).status_code == 200
    clock.advance(timedelta(minutes=15, seconds=1))
    assert Api(make_client(client=("192.0.2.71", 1234))).login(user.email).status_code == 200


def test_login_rehashes_outdated_hash(client: TestClient, factory: Factory, db: Session) -> None:
    weak = PasswordHasherService(Argon2Parameters(time_cost=1, memory_cost_kib=512, parallelism=1))
    company = factory.company()
    user = factory.user(company)
    user.password_hash = weak.hash(DEFAULT_PASSWORD)
    db.commit()
    old_hash = user.password_hash

    assert Api(client).login(user.email).status_code == 200
    assert refreshed(db, User, user.id).password_hash != old_hash


def test_relogin_revokes_the_previous_session_of_this_browser(
    client: TestClient, world: World, db: Session
) -> None:
    api = Api(client)
    api.login(world.a.employee.email)
    first = api.session_token
    api.login(world.a.employee.email)
    assert api.session_token != first

    db.expire_all()
    sessions = db.scalars(select(UserSession).where(UserSession.user_id == world.a.employee.id)).all()
    assert len(sessions) == 2
    assert sum(1 for s in sessions if s.revoked_at is None) == 1


def test_roles_are_returned_in_canonical_order(client: TestClient, factory: Factory) -> None:
    company = factory.company()
    user = factory.user(company, roles=(Role.MANAGEMENT, Role.EMPLOYEE))
    response = Api(client).login(user.email)
    assert response.json()["user"]["roles"] == ["EMPLOYEE", "MANAGEMENT"]


def test_login_validation_errors_use_envelope(client: TestClient) -> None:
    response = Api(client).post("/auth/login", json={"email": "", "password": ""}, csrf=False)
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert set(body["error"]["details"]["fields"]) == {"email", "password"}


def test_ipv6_rotation_within_one_64_shares_the_per_ip_budget(make_client, factory: Factory) -> None:
    company = factory.company()
    users = [factory.user(company) for _ in range(31)]
    for index, user in enumerate(users[:30]):
        api = Api(make_client(client=(f"2001:db8:1:2::{index + 1:x}", 1234)))
        assert api.login(user.email, "Wrong-Password-123").status_code == 401
    rotated = Api(make_client(client=("2001:db8:1:2:ffff::1", 1234)))
    response = rotated.login(users[30].email)
    assert response.status_code == 429
    assert error_code(response) == "RATE_LIMITED"

    # Another /64 is another client.
    assert Api(make_client(client=("2001:db8:1:3::1", 1234))).login(users[30].email).status_code == 200


def test_audit_keeps_the_full_ipv6_address(make_client, world: World, db: Session) -> None:
    api = Api(make_client(client=("2001:db8:1:2::abcd", 1234)))
    assert api.login(world.a.employee.email).status_code == 200
    row = audit_rows(db, "AUTH_LOGIN_SUCCEEDED", entity_id=world.a.employee.id)[-1]
    assert str(row.ip_address) == "2001:db8:1:2::abcd"
