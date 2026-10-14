"""Device cookies (SEC-01): signed, per account, bounded, expiring, and revocable per account (SEC-30)."""

import uuid
from datetime import UTC, datetime, timedelta

from app.security.device_trust import (
    DEVICE_TRUST_TTL,
    MAX_DEVICE_COOKIE_LENGTH,
    MAX_DEVICE_ENTRIES,
    DeviceTrust,
    new_device_trust_epoch,
)

NOW = datetime(2026, 10, 6, 8, 0, tzinfo=UTC)
KEY = "test-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz"
EPOCH = 0x1234_5678_9ABC


def test_a_cookie_trusts_the_browser_for_the_accounts_it_was_issued_for() -> None:
    trust = DeviceTrust(KEY)
    alice, bob = uuid.uuid4(), uuid.uuid4()
    cookie = trust.issue(None, alice, EPOCH, now=NOW)
    assert trust.device_for(cookie, alice, EPOCH, now=NOW) is not None
    assert trust.device_for(cookie, bob, EPOCH, now=NOW) is None
    both = trust.issue(cookie, bob, 7, now=NOW)
    assert trust.device_for(both, alice, EPOCH, now=NOW) == trust.device_for(cookie, alice, EPOCH, now=NOW)
    assert trust.device_for(both, bob, 7, now=NOW) is not None
    renewed = trust.issue(both, alice, EPOCH, now=NOW + timedelta(days=1))
    assert len(renewed.split("~")) == 2  # one entry per account, the newest first
    assert renewed.startswith(alice.hex)


def test_an_entry_is_trusted_only_at_the_accounts_current_epoch() -> None:
    """SEC-30: a password change or reset, or a deactivation, gives the account a new epoch; every entry
    issued before it stops being trusted, and the browser that made the change gets a fresh one."""
    trust = DeviceTrust(KEY)
    user = uuid.uuid4()
    farmed = [trust.issue(None, user, EPOCH, now=NOW) for _ in range(3)]  # three cookie jars
    assert all(trust.device_for(cookie, user, EPOCH, now=NOW) is not None for cookie in farmed)
    assert len({trust.device_for(cookie, user, EPOCH, now=NOW) for cookie in farmed}) == 3  # 3 budgets

    new_epoch = EPOCH + 1
    assert all(trust.device_for(cookie, user, new_epoch, now=NOW) is None for cookie in farmed)
    reissued = trust.issue(farmed[0], user, new_epoch, now=NOW)
    assert trust.device_for(reissued, user, new_epoch, now=NOW) is not None
    assert trust.device_for(reissued, user, EPOCH, now=NOW) is None  # the old entry was replaced


def test_new_epochs_are_random_bigint_values() -> None:
    epochs = {new_device_trust_epoch() for _ in range(1000)}
    assert len(epochs) == 1000
    assert all(0 <= epoch < 2**63 for epoch in epochs)  # a PostgreSQL bigint


def test_tampered_foreign_and_expired_cookies_earn_no_trust() -> None:
    trust = DeviceTrust(KEY)
    user = uuid.uuid4()
    cookie = trust.issue(None, user, EPOCH, now=NOW)
    user_hex, issued, epoch, nonce, mac = cookie.split(".")
    for forged in (
        f"{uuid.uuid4().hex}.{issued}.{epoch}.{nonce}.{mac}",
        f"{user_hex}.{int(issued, 16) + 1:x}.{epoch}.{nonce}.{mac}",
        f"{user_hex}.{issued}.{int(epoch, 16) + 1:x}.{nonce}.{mac}",  # another epoch under the old MAC
        f"{user_hex}.{issued}.0{epoch}.{nonce}.{mac}",
        f"{user_hex}.{issued}.{epoch}.{nonce}x.{mac}",
        f"{user_hex.upper()}.{issued}.{epoch}.{nonce}.{mac}",
        f"{user_hex}.{issued}.{nonce}.{mac}",  # the earlier format without the epoch
        f"{user_hex}.{issued}.{epoch}.{nonce}",
        "",
        cookie + "~" + "x" * MAX_DEVICE_COOKIE_LENGTH,
    ):
        assert trust.device_for(forged, user, EPOCH, now=NOW) is None
        assert trust.device_for(forged, user, int(epoch, 16) + 1, now=NOW) is None
    other_key = DeviceTrust("another-secret-key-0123456789-abcdefghijk")
    assert other_key.device_for(cookie, user, EPOCH, now=NOW) is None
    assert trust.device_for(cookie, user, EPOCH, now=NOW + DEVICE_TRUST_TTL) is not None
    assert trust.device_for(cookie, user, EPOCH, now=NOW + DEVICE_TRUST_TTL + timedelta(seconds=1)) is None
    # Issued in the future:
    assert trust.device_for(cookie, user, EPOCH, now=NOW - timedelta(minutes=5)) is None


def test_a_cookie_holds_a_bounded_number_of_accounts() -> None:
    trust = DeviceTrust(KEY)
    users = [uuid.uuid4() for _ in range(MAX_DEVICE_ENTRIES + 2)]
    cookie = None
    for user in users:
        cookie = trust.issue(cookie, user, new_device_trust_epoch(), now=NOW)
    assert cookie is not None
    assert len(cookie.split("~")) == MAX_DEVICE_ENTRIES
    assert len(cookie) < MAX_DEVICE_COOKIE_LENGTH
    kept = [entry.split(".")[0] for entry in cookie.split("~")]
    assert kept == [user.hex for user in reversed(users[2:])]  # the newest five, newest first
