"""Limiter abuse paths through the API: IPv6 sites rotating /64s (B1-43), and full limiter tables, which
must never lock anyone out (B1-66)."""

from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.rate_limit import InMemoryRateLimiter
from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.security.passwords import PasswordHasherService
from tests.support import Api, World, audit_rows, error_code

WRONG = "Wrong-Password-123"


@pytest.fixture
def make_app(
    settings: Settings, app_engine: Engine, hasher: PasswordHasherService, connection: Connection
) -> Callable[..., FastAPI]:
    def make(
        *,
        rate_limiter: InMemoryRateLimiter | None = None,
        email_provider: MemoryProvider | None = None,
        **overrides: object,
    ) -> FastAPI:
        return create_app(
            settings.model_copy(update=overrides),
            engine=app_engine,
            password_hasher=hasher,
            email_provider=email_provider or MemoryProvider(),
            rate_limiter=rate_limiter,
        )

    return make


def _api(app: FastAPI, address: str) -> Api:
    return Api(TestClient(app, base_url="https://testserver", client=(address, 1234)))


def test_rotating_64s_inside_one_48_hits_the_prefix_limit(
    make_app: Callable[..., FastAPI], world: World, db: Session
) -> None:
    app = make_app(rate_limit_login_per_prefix=12)
    for network in range(4):  # four /64s of one /48, three failures each: below every per-IP limit
        for host in range(3):
            response = _api(app, f"2001:db8:5:{network}::{host + 1}").login(
                f"nobody-{network}-{host}@x.test", WRONG
            )
            assert response.status_code == 401
    blocked = _api(app, "2001:db8:5:ffff::1").login(world.a.employee.email)
    assert blocked.status_code == 429
    assert error_code(blocked) == "RATE_LIMITED"
    assert int(blocked.headers["Retry-After"]) > 1
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "login_failures_prefix"
    # Another /48 (another site) and IPv4 clients are not affected.
    assert _api(app, "2001:db8:6::1").login(world.a.employee.email).status_code == 200
    assert _api(app, "203.0.113.77").login(world.a.employee.email).status_code == 200


def test_throttled_logins_from_fresh_64s_of_one_48_write_one_row(
    make_app: Callable[..., FastAPI], db: Session
) -> None:
    app = make_app(rate_limit_login_per_prefix=3)
    for network in range(3):  # spends the /48's login budget
        response = _api(app, f"2001:db8:9:{network}::1").login(f"nobody-{network}@x.test", WRONG)
        assert response.status_code == 401
    for network in range(200):  # every request from a /64 never seen before
        response = _api(app, f"2001:db8:9:{network + 100:x}::1").login("someone@x.test", WRONG)
        assert response.status_code == 429
    assert [row.meta["policy"] for row in audit_rows(db, "RATE_LIMITED")] == ["login_failures_prefix"]

    app.state.security_audit.flush()
    rows = audit_rows(db, "RATE_LIMITED")
    assert len(rows) == 2
    assert rows[1].meta["deferred"] is True and rows[1].meta["coalesced"] == 198


def test_reset_password_attempts_are_limited_per_48(make_app: Callable[..., FastAPI], db: Session) -> None:
    app = make_app(rate_limit_reset_per_prefix=3)
    body = {"token": "x" * 43, "new_password": "Brand-New-Password-1"}
    for network in range(3):
        response = _api(app, f"2001:db8:7:{network}::1").post("/auth/reset-password", json=body, csrf=False)
        assert response.status_code == 400
    blocked = _api(app, "2001:db8:7:99::1").post("/auth/reset-password", json=body, csrf=False)
    assert blocked.status_code == 429
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "reset_password_prefix"


def test_forgot_password_requests_are_limited_per_48(make_app: Callable[..., FastAPI], db: Session) -> None:
    app = make_app(rate_limit_forgot_per_prefix=2)
    for network in range(3):
        response = _api(app, f"2001:db8:8:{network}::1").post(
            "/auth/forgot-password", json={"email": f"someone-{network}@x.test"}, csrf=False
        )
        assert response.status_code == 202  # identical answer, dropped silently once limited
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "forgot_password_prefix"


def test_attacker_networks_within_their_budgets_cannot_lock_anyone_out(
    make_app: Callable[..., FastAPI],
    world: World,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    """B1-66: full limiter tables never refuse a request. Every attacker network stays within each of its
    budgets (fresh addresses at login, forgot-password and reset-password) until both capped scopes are
    full; an unrelated client can still sign in and recover a password, and the limits that exist,
    including every existing account's, keep working."""
    limiter = InMemoryRateLimiter(max_network_buckets=12, max_email_buckets=20)
    app = make_app(rate_limiter=limiter, email_provider=email_provider)
    attackers = [f"198.51.100.{n + 1}" for n in range(6)] + [f"2001:db8:a:{n}::1" for n in range(4)]
    statuses: set[int] = set()
    for round_ in range(4):
        clock.advance(seconds=11)
        for index, address in enumerate(attackers):
            api = _api(app, address)
            statuses.add(api.login(f"nobody-{round_}-{index}@x.test", WRONG).status_code)
            forgot = {"email": f"nobody-{round_}-{index}@x.test"}
            statuses.add(api.post("/auth/forgot-password", json=forgot, csrf=False).status_code)
            reset = {"token": "x" * 43, "new_password": "Brand-New-Password-1"}
            statuses.add(api.post("/auth/reset-password", json=reset, csrf=False).status_code)
    assert statuses == {401, 202, 400}  # never a 429: every network stayed within its budgets
    stats = limiter.stats()
    assert (stats.network_buckets, stats.email_buckets) == (12, 20)
    assert audit_rows(db, "RATE_LIMITED") == []

    # An unrelated client signs in and recovers a password.
    bystander = _api(app, "203.0.113.200")
    assert bystander.login(world.a.employee.email).status_code == 200
    email_provider.clear()
    assert (
        bystander.post("/auth/forgot-password", json={"email": world.a.admin.email}, csrf=False).status_code
        == 202
    )
    token = email_provider.sent[-1].reset_url.split("#token=", 1)[1]
    reset = {"token": token, "new_password": "Brand-New-Password-1"}
    assert (
        _api(app, "2001:db8:ffff::1").post("/auth/reset-password", json=reset, csrf=False).status_code == 204
    )

    # The account budget of an existing account is never capped, so the flood cannot switch it off.
    for index in range(10):
        assert _api(app, f"192.0.2.{index + 1}").login(world.a.manager.email, WRONG).status_code == 401
    locked = _api(app, "192.0.2.100").login(world.a.manager.email)
    assert locked.status_code == 429
    assert locked.json()["error"]["message"] == "Too many attempts. Try again later."


def test_unknown_addresses_lock_out_like_accounts(make_client, world: World, db: Session) -> None:
    """No account-existence oracle: an address without an account is throttled exactly like one with an
    account (same status, message and lockout), although only the latter has a bucket bounded by data."""
    for email in (world.a.employee.email, "nobody-at-all@example.com"):
        for index in range(10):
            api = Api(make_client(client=(f"198.51.100.{index + 1}", 40000)))
            assert api.login(email, WRONG).status_code == 401
        locked = Api(make_client(client=("198.51.100.200", 40000))).login(email)
        assert locked.status_code == 429
        assert locked.json()["error"]["message"] == "Too many attempts. Try again later."
    assert [row.meta["policy"] for row in audit_rows(db, "AUTH_ACCOUNT_THROTTLED")] == [
        "login_failures_account",
        "login_failures_unknown_account",
    ]


def test_a_locked_account_does_not_spend_the_clients_budget(make_client, world: World) -> None:
    for index in range(10):
        Api(make_client(client=(f"198.51.100.{index + 1}", 40000))).login(world.a.employee.email, WRONG)
    api = Api(make_client(client=("192.0.2.60", 1234)))
    for _ in range(40):  # beyond the per-IP failure budget of 30
        assert api.login(world.a.employee.email, WRONG).status_code == 429
    assert api.login(world.a.admin.email).status_code == 200
