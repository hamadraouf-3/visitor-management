"""The account login block is for untrusted clients only (SEC-01, OWASP device cookies), and a password
change or reset or a deactivation ends the trust of every browser that signed in before (SEC-30).

Before SEC-01: anyone who knew an address could keep that account blocked for every browser with 10
wrong passwords every 15 minutes (two source addresses suffice), and the victim's natural recovery, a
password reset, ended their remaining sessions without lifting the block.

Before SEC-30: device trust could not be revoked. Someone who once knew the password and signed in from
several cookie jars kept, for 90 days and through a reset or a deactivation, a failure budget of 10 per
15 minutes per jar for guessing the new password, outside the account's budget and its lockout.
"""

import re
from datetime import timedelta

import httpx
import pytest
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import User
from app.security.device_trust import DEVICE_TRUST_TTL, MAX_DEVICE_ENTRIES
from app.security.sessions import SECURE_COOKIE_NAMES
from tests.support import DEFAULT_PASSWORD, Api, Factory, World, audit_rows, error_code

WRONG = "Wrong-Password-123"
DEVICE = SECURE_COOKIE_NAMES.device
ATTACKERS = ("203.0.113.10", "203.0.113.11")
NEW_PASSWORD = "Recovered-Kiwi-Lantern-77"


def _client(make_client, address: str, cookies: httpx.Cookies | None = None) -> Api:
    api = Api(make_client(client=(address, 1234)))
    if cookies is not None:
        api.client.cookies.update(cookies)
    return api


def _lock_out(make_client, user: User) -> None:
    """10 failures from two addresses (5 each, the per-(IP, e-mail) budget): the account is blocked."""
    for address in ATTACKERS:
        attacker = _client(make_client, address)
        for _ in range(5):
            assert attacker.login(user.email, WRONG).status_code == 401
    assert _client(make_client, "198.51.100.200").login(user.email).status_code == 429


@pytest.fixture
def tablet(make_client, world: World) -> Api:
    """The reception tablet, which signed in yesterday (and so holds a device cookie)."""
    api = _client(make_client, "198.51.100.7")
    assert api.login(world.a.receptionist.email).status_code == 200
    assert api.client.cookies.get(DEVICE)
    assert api.post("/auth/logout").status_code == 204  # signing out keeps the device cookie
    assert api.client.cookies.get(DEVICE)
    return api


def test_the_device_cookie_is_a_strict_host_only_http_only_cookie(make_client, world: World) -> None:
    response = _client(make_client, "198.51.100.8").login(world.a.employee.email)
    (device,) = [value for value in response.headers.get_list("set-cookie") if value.startswith(DEVICE)]
    attributes = {part.strip().lower() for part in device.split(";")[1:]}
    assert {"httponly", "secure", "samesite=strict", "path=/"} <= attributes
    assert f"max-age={int(DEVICE_TRUST_TTL.total_seconds())}" in attributes
    assert world.a.employee.email not in device and DEFAULT_PASSWORD not in device


def test_a_blocked_account_still_admits_its_trusted_browsers(
    make_client, world: World, tablet: Api, db: Session
) -> None:
    user = world.a.receptionist
    _lock_out(make_client, user)
    assert len(audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_user_id=user.id)) == 1

    assert tablet.login(user.email).status_code == 200  # the tablet: trusted, so not blocked
    assert tablet.get("/auth/me").status_code == 200
    stranger = _client(make_client, "203.0.113.12")
    assert stranger.login(user.email).status_code == 429  # the correct password, but untrusted
    assert stranger.login(user.email, WRONG).status_code == 429


def test_failures_from_a_trusted_browser_block_only_that_browser(
    make_client, world: World, tablet: Api, db: Session
) -> None:
    user = world.a.receptionist
    other_browser = _client(make_client, "198.51.100.9")
    assert other_browser.login(user.email).status_code == 200
    # Ten wrong passwords with the tablet's cookie (from two addresses: 5 per address and 5 minutes).
    for address in ("198.51.100.20", "198.51.100.21"):
        copy = _client(make_client, address, tablet.client.cookies)
        for _ in range(5):
            assert copy.login(user.email, WRONG).status_code == 401
    assert _client(make_client, "198.51.100.22", tablet.client.cookies).login(user.email).status_code == 429
    (throttled,) = audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_user_id=user.id)
    assert throttled.meta == {"policy": "login_failures_device"}
    # The account's own block was never touched: other browsers, trusted or not, still sign in.
    assert other_browser.login(user.email).status_code == 200
    assert _client(make_client, "198.51.100.23").login(user.email).status_code == 200


def test_a_device_cookie_trusts_only_the_accounts_it_was_issued_for(
    make_client, world: World, tablet: Api, clock: FakeClock
) -> None:
    victim = world.a.admin
    _lock_out(make_client, victim)
    # The receptionist's tablet is trusted for the receptionist, not for the administrator.
    assert _client(make_client, "198.51.100.30", tablet.client.cookies).login(victim.email).status_code == 429

    cookie = tablet.client.cookies.get(DEVICE)
    assert cookie
    user_hex, issued, epoch, nonce, mac = cookie.split("~")[0].split(".")
    forged = [
        f"{victim.id.hex}.{issued}.{epoch}.{nonce}.{mac}",  # another user's ID under the receptionist's MAC
        f"{user_hex}.{issued}.{epoch}.{nonce}.{'A' * len(mac)}",
        "garbage",
        "x" * 5000,
    ]
    for value in forged:
        forger = _client(make_client, "198.51.100.31")
        forger.client.cookies.set(DEVICE, value)
        assert forger.login(victim.email).status_code == 429

    # Trust ends with the cookie's lifetime, whatever the browser keeps.
    clock.advance(DEVICE_TRUST_TTL + timedelta(minutes=1))
    _lock_out(make_client, world.a.receptionist)
    expired = _client(make_client, "198.51.100.32", tablet.client.cookies)
    assert expired.login(world.a.receptionist.email).status_code == 429


def test_a_password_reset_trusts_the_browser_and_lifts_the_block(
    make_client, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """The finding's recovery path: forgot-password, reset. The reset proves control of the mailbox, so
    the browser that completes it is trusted for the account and the account's block is lifted."""
    user = world.a.receptionist
    _lock_out(make_client, user)
    browser = _client(make_client, "198.51.100.40")
    assert browser.post("/auth/forgot-password", json={"email": user.email}, csrf=False).status_code == 202
    match = re.search(r"#token=([A-Za-z0-9_-]+)", email_provider.sent[-1].reset_url or "")
    assert match
    reset = browser.post(
        "/auth/reset-password", json={"token": match.group(1), "new_password": NEW_PASSWORD}, csrf=False
    )
    assert reset.status_code == 204
    assert browser.client.cookies.get(DEVICE)

    assert browser.login(user.email, NEW_PASSWORD).status_code == 200
    assert _client(make_client, "198.51.100.41").login(user.email, NEW_PASSWORD).status_code == 200  # lifted
    # The attacker can block untrusted clients again, but not the browser that recovered the account.
    _lock_out_with(make_client, user, NEW_PASSWORD)
    assert browser.login(user.email, NEW_PASSWORD).status_code == 200


def _lock_out_with(make_client, user: User, password: str) -> None:
    for address in ("203.0.113.20", "203.0.113.21"):
        attacker = _client(make_client, address)
        for _ in range(5):
            assert attacker.login(user.email, WRONG).status_code == 401
    assert _client(make_client, "198.51.100.201").login(user.email, password).status_code == 429


def test_one_browser_is_trusted_for_several_accounts(make_client, factory: Factory, world: World) -> None:
    company = factory.company()
    users = [factory.user(company) for _ in range(MAX_DEVICE_ENTRIES + 1)]
    desk = _client(make_client, "198.51.100.50")
    for user in users:
        assert desk.login(user.email).status_code == 200
    cookie = desk.client.cookies.get(DEVICE)
    assert cookie and len(cookie.split("~")) == MAX_DEVICE_ENTRIES
    # The oldest account fell out; the newest five are trusted.
    for user in users[1:]:
        _lock_out(make_client, user)
        assert desk.login(user.email).status_code == 200, user.email
    _lock_out(make_client, users[0])
    assert error_code(desk.login(users[0].email)) == "RATE_LIMITED"


# ---- revocation (SEC-30) ---------------------------------------------------------------------------


def _farm(make_client, user: User, password: str, count: int) -> list[str]:
    """The device cookies of `count` cookie jars that signed in to `user` (someone who knew the password
    at the time)."""
    cookies = []
    for index in range(count):
        browser = _client(make_client, f"192.0.2.{60 + index}")
        assert browser.login(user.email, password).status_code == 200
        cookies.append(browser.client.cookies.get(DEVICE) or "")
        assert cookies[-1]
    return cookies


def _with_device(make_client, address: str, device: str) -> Api:
    api = _client(make_client, address)
    api.client.cookies.set(DEVICE, device)
    return api


def _reset(make_client, browser: Api, user: User, email_provider: MemoryProvider, password: str) -> None:
    assert browser.post("/auth/forgot-password", json={"email": user.email}, csrf=False).status_code == 202
    match = re.search(r"#token=([A-Za-z0-9_-]+)", email_provider.sent[-1].reset_url or "")
    assert match
    reset = browser.post(
        "/auth/reset-password", json={"token": match.group(1), "new_password": password}, csrf=False
    )
    assert reset.status_code == 204


def test_a_reset_ends_the_trust_of_every_browser_that_signed_in_before(
    make_client, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """The finding's scenario A: three cookie jars signed in with the old password; the victim resets the
    password; strangers block the account. The farmed cookies are untrusted now: their correct-password
    attempts are refused like a stranger's, and their guesses count against the account."""
    user = world.a.receptionist
    farmed = _farm(make_client, user, DEFAULT_PASSWORD, 3)
    victim = _client(make_client, "198.51.100.70")
    _reset(make_client, victim, user, email_provider, NEW_PASSWORD)

    _lock_out_with(make_client, user, NEW_PASSWORD)
    for index, jar in enumerate(farmed):
        attacker = _with_device(make_client, f"203.0.113.{80 + index}", jar)
        assert attacker.login(user.email, NEW_PASSWORD).status_code == 429  # was 200: trusted
        assert attacker.login(user.email, WRONG).status_code == 429  # no budget of its own
    assert victim.login(user.email, NEW_PASSWORD).status_code == 200  # the browser that reset it
    assert [row.meta for row in audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_user_id=user.id)] == [
        {"policy": "login_failures_account"}
    ]


def test_after_a_password_change_only_the_changing_browser_is_trusted(
    make_client, world: World, db: Session
) -> None:
    """A guess from a cookie issued before the change counts against the account's budget: ten of them
    block the account for everyone untrusted, and the browser that made the change still signs in."""
    user = world.a.employee
    (jar,) = _farm(make_client, user, DEFAULT_PASSWORD, 1)
    owner = _client(make_client, "198.51.100.71")
    assert owner.login(user.email).status_code == 200
    changed = owner.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert changed.status_code == 204
    assert any(value.startswith(DEVICE) for value in changed.headers.get_list("set-cookie"))

    for address in ("203.0.113.90", "203.0.113.91"):  # 5 per (address, e-mail)
        attacker = _with_device(make_client, address, jar)
        for _ in range(5):
            assert attacker.login(user.email, WRONG).status_code == 401
    assert _client(make_client, "198.51.100.72").login(user.email, NEW_PASSWORD).status_code == 429
    (throttled,) = audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_user_id=user.id)
    assert throttled.meta == {"policy": "login_failures_account"}  # was login_failures_device
    assert owner.login(user.email, NEW_PASSWORD).status_code == 200


def test_a_deactivation_ends_the_trust_of_every_browser(make_client, world: World) -> None:
    """The finding's scenario B: an administrator deactivates and reactivates the account (the attacker's
    session ends); the attacker's device cookie from before is untrusted afterwards."""
    user = world.a.manager
    (jar,) = _farm(make_client, user, DEFAULT_PASSWORD, 1)
    admin = _client(make_client, "198.51.100.73")
    assert admin.login(world.a.admin.email).status_code == 200
    assert admin.patch(f"/users/{user.id}", json={"is_active": False}).status_code == 200
    assert admin.patch(f"/users/{user.id}", json={"is_active": True}).status_code == 200

    _lock_out(make_client, user)
    attacker = _with_device(make_client, "203.0.113.92", jar)
    assert attacker.login(user.email).status_code == 429  # was 200: the cookie outlived the deactivation


def test_an_unrelated_change_keeps_the_browsers_trusted(make_client, world: World, tablet: Api) -> None:
    """Only a password change or reset and a deactivation end the trust: a rename does not."""
    user = world.a.receptionist
    admin = _client(make_client, "198.51.100.74")
    assert admin.login(world.a.admin.email).status_code == 200
    assert admin.patch(f"/users/{user.id}", json={"full_name": "Renamed Receptionist"}).status_code == 200
    _lock_out(make_client, user)
    assert tablet.login(user.email).status_code == 200
