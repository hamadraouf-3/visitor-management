import dataclasses
from datetime import UTC, datetime, timedelta

import pytest

from app.core.client_ip import rate_limit_prefix, rate_limit_subject
from app.core.config import Settings
from app.core.rate_limit import (
    BucketScope,
    DisabledRateLimiter,
    InMemoryRateLimiter,
    LimiterStats,
    LimitKey,
    PolicyName,
    RatePolicies,
    RatePolicy,
    Reservation,
    create_rate_limiter,
    limiter_key,
)
from app.core.time import FakeClock

POLICY = RatePolicy(PolicyName.SCAN_PER_USER, limit=3, window_seconds=60)
LOCKOUT = RatePolicy(PolicyName.LOGIN_FAILURES_ACCOUNT, limit=2, window_seconds=60, lockout_seconds=900)


@pytest.fixture
def fake() -> FakeClock:
    return FakeClock(datetime(2026, 1, 1, tzinfo=UTC))


@pytest.fixture
def limiter(fake: FakeClock) -> InMemoryRateLimiter:
    return InMemoryRateLimiter(clock=fake.now)


def test_hits_until_limit_then_denies_with_retry_after(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    for remaining in (2, 1, 0):
        decision = limiter.hit(POLICY, "user-1")
        assert decision.allowed and decision.remaining == remaining
    fake.advance(seconds=10)
    denied = limiter.hit(POLICY, "user-1")
    assert not denied.allowed
    assert 49 <= denied.retry_after <= 50
    assert limiter.hit(POLICY, "user-2").allowed  # keys are independent


def test_window_slides(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    limiter.hit(POLICY, "k")
    fake.advance(seconds=30)
    limiter.hit(POLICY, "k")
    limiter.hit(POLICY, "k")
    assert not limiter.check(POLICY, "k").allowed
    fake.advance(seconds=30)  # the first hit leaves the window: exactly one slot frees up
    assert limiter.check(POLICY, "k").allowed
    assert limiter.hit(POLICY, "k").allowed
    assert not limiter.check(POLICY, "k").allowed


def test_denied_hits_are_not_recorded(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    for _ in range(3):
        limiter.hit(POLICY, "k")
    for _ in range(10):
        limiter.hit(POLICY, "k")
    fake.advance(seconds=61)
    assert limiter.hit(POLICY, "k").remaining == 2


def test_check_does_not_record(limiter: InMemoryRateLimiter) -> None:
    for _ in range(10):
        assert limiter.check(POLICY, "k").allowed


def test_clear_and_reset(limiter: InMemoryRateLimiter) -> None:
    for _ in range(3):
        limiter.hit(POLICY, "a")
        limiter.hit(POLICY, "b")
    limiter.clear(POLICY, "a")
    assert limiter.check(POLICY, "a").allowed
    assert not limiter.check(POLICY, "b").allowed
    limiter.reset()
    assert limiter.check(POLICY, "b").allowed


def test_uses_application_clock_by_default(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter()
    for _ in range(3):
        limiter.hit(POLICY, "k")
    assert not limiter.check(POLICY, "k").allowed
    clock.advance(timedelta(seconds=61))
    assert limiter.check(POLICY, "k").allowed


def test_disabled_limiter_allows_everything() -> None:
    limiter = DisabledRateLimiter()
    for _ in range(100):
        assert limiter.hit(POLICY, "k").allowed
        assert limiter.hit(LOCKOUT, "k").allowed


def test_policies_follow_the_contract() -> None:
    policies = RatePolicies.from_settings(
        Settings(_env_file=None, app_env="test", database_url="postgresql://u:p@h/d")
    )
    assert (policies.login_failures_ip_email.limit, policies.login_failures_ip_email.window_seconds) == (
        5,
        300,
    )
    assert (policies.login_failures_ip.limit, policies.login_failures_ip.window_seconds) == (30, 300)
    account = policies.login_failures_account
    assert (account.limit, account.window_seconds, account.lockout_seconds) == (10, 900, 900)
    # An address without an account locks out exactly alike (no account-existence oracle).
    unknown = policies.login_failures_unknown_account
    assert (unknown.limit, unknown.window_seconds, unknown.lockout_seconds) == (10, 900, 900)
    # A trusted browser's own account budget (SEC-01): the same numbers.
    device = policies.login_failures_device
    assert (device.limit, device.window_seconds, device.lockout_seconds) == (10, 900, 900)
    # Not in §7.3: successful sign-ins per account (SEC-02/SEC-14), taken-address refusals (SEC-05).
    successes = policies.login_successes_account
    assert (successes.limit, successes.window_seconds, successes.lockout_seconds) == (30, 900, None)
    refused_addresses = policies.user_email_refusals_per_user
    assert (refused_addresses.limit, refused_addresses.window_seconds) == (10, 3600)
    # SEC-R1: and per company, since an administrator can create more administrators.
    company_refusals = policies.user_email_refusals_per_company
    assert (company_refusals.limit, company_refusals.window_seconds) == (20, 3600)
    forgot = policies.forgot_password_account
    assert (forgot.limit, forgot.window_seconds) == (3, 900)
    assert (policies.forgot_password_ip.limit, policies.forgot_password_ip.window_seconds) == (10, 900)
    # Not in §7.3; added with decision B1-31 (phase-1-backend.md).
    change = policies.password_change_failures
    assert (change.limit, change.window_seconds, change.lockout_seconds) == (5, 900, None)
    # Not in §7.3; added with SEC-43 (phase-8-backend.md): successful password changes per account.
    changes = policies.password_changes_per_user
    assert (changes.limit, changes.window_seconds, changes.lockout_seconds) == (5, 3600, None)
    assert (policies.reset_password_ip.limit, policies.reset_password_ip.window_seconds) == (20, 900)
    assert (policies.scan_per_user.limit, policies.scan_per_user.window_seconds) == (120, 60)
    # Not in §7.3; added with L-BE-2 (phase-8-backend.md): refused attendance changes without a pass.
    refusals = policies.attendance_refusals_per_user
    assert (refusals.limit, refusals.window_seconds, refusals.lockout_seconds) == (30, 60, None)
    # SEC-42: an empty bulk stale check-out is audited once per (user, local day); the window outlasts it.
    empty_runs = policies.stale_check_out_empty_runs
    assert (empty_runs.limit, empty_runs.window_seconds) == (1, 2 * 86400)
    assert (policies.invitations_per_user_day.limit, policies.invitations_per_user_day.window_seconds) == (
        50,
        86400,
    )
    assert (
        policies.invitation_resends_per_visit.limit,
        policies.invitation_resends_per_visit.window_seconds,
    ) == (
        3,
        3600,
    )
    assert (policies.api_per_user.limit, policies.api_per_user.window_seconds) == (600, 60)
    # Reschedule notices (not in §7.3; decision B24-70): per user and day, per visit and hour.
    notices = policies.reschedule_notices_per_user_day
    assert (notices.limit, notices.window_seconds) == (50, 86400)
    per_visit = policies.reschedule_notices_per_visit
    assert (per_visit.limit, per_visit.window_seconds) == (3, 3600)
    # Secondary per-IPv6-/48 limits (decision B1-43): same windows as the per-IP limits.
    assert (policies.login_failures_prefix.limit, policies.login_failures_prefix.window_seconds) == (300, 300)
    assert (policies.forgot_password_prefix.limit, policies.forgot_password_prefix.window_seconds) == (
        100,
        900,
    )
    assert (policies.reset_password_prefix.limit, policies.reset_password_prefix.window_seconds) == (200, 900)


def test_scopes_follow_what_the_keys_are_derived_from() -> None:
    policies = RatePolicies.from_settings(
        Settings(_env_file=None, app_env="test", database_url="postgresql://u:p@h/d")
    )
    scopes = {field.name: getattr(policies, field.name).scope for field in dataclasses.fields(policies)}
    network, email, bounded = BucketScope.NETWORK, BucketScope.EMAIL, BucketScope.BOUNDED
    assert scopes == {
        # Typed by anonymous clients: any string is a new key.
        "login_failures_ip_email": email,
        "login_failures_unknown_account": email,
        # Client addresses and IPv6 prefixes.
        "login_failures_ip": network,
        "login_failures_prefix": network,
        "forgot_password_ip": network,
        "forgot_password_prefix": network,
        "reset_password_ip": network,
        "reset_password_prefix": network,
        # Rows that exist: never capped, so no flood can switch these limits off.
        "login_failures_account": bounded,
        "login_failures_device": bounded,  # (user, device) from a server-signed cookie
        "login_successes_account": bounded,
        "password_change_failures": bounded,
        "password_changes_per_user": bounded,
        "user_email_refusals_per_user": bounded,
        "user_email_refusals_per_company": bounded,
        "password_notices_per_user": bounded,
        "forgot_password_account": bounded,
        "scan_per_user": bounded,
        "attendance_refusals_per_user": bounded,
        "stale_check_out_empty_runs": bounded,  # (user, company-local day)
        "invitations_per_user_day": bounded,
        "invitation_resends_per_visit": bounded,
        "reschedule_notices_per_user_day": bounded,
        "reschedule_notices_per_visit": bounded,
        "host_arrivals_per_user_day": bounded,
        "template_test_sends_per_user": bounded,  # administrators (B11-29)
        "public_brand_ip": network,  # the public identity endpoints (B12-9)
        "public_brand_prefix": network,
        "brand_changes_per_user": bounded,  # platform accounts (B12-7)
        "api_per_user": bounded,
    }


def test_factory_honours_switch_and_caps() -> None:
    enabled = Settings(_env_file=None, app_env="test", database_url="postgresql://u:p@h/d")
    disabled = Settings(
        _env_file=None, app_env="test", database_url="postgresql://u:p@h/d", rate_limit_enabled=False
    )
    assert isinstance(create_rate_limiter(enabled), InMemoryRateLimiter)
    assert isinstance(create_rate_limiter(disabled), DisabledRateLimiter)
    capped = Settings(
        _env_file=None,
        app_env="test",
        database_url="postgresql://u:p@h/d",
        rate_limit_max_network_buckets=100,
        rate_limit_max_email_buckets=200,
    )
    limiter = create_rate_limiter(capped)
    assert isinstance(limiter, InMemoryRateLimiter)
    for index in range(300):
        _counted(limiter, LimitKey(NET, f"ip{index}"), LimitKey(TYPED, f"e{index}"))
    assert limiter.stats() == LimiterStats(buckets=300, network_buckets=100, email_buckets=200)


def test_limiter_keys_hide_identifiers() -> None:
    key = limiter_key("secret", "login", "203.0.113.1", "person@example.com")
    assert key == limiter_key("secret", "login", "203.0.113.1", "person@example.com")
    assert key != limiter_key("other-secret", "login", "203.0.113.1", "person@example.com")
    assert "person" not in key and "203" not in key


# ---- reservations (in-flight attempts count against the limit) ---------------------------------

PER_IP = RatePolicy(PolicyName.LOGIN_FAILURES_IP, limit=3, window_seconds=60)


def test_reservations_count_while_in_flight(limiter: InMemoryRateLimiter) -> None:
    keys = [LimitKey(POLICY, "k")]
    granted = [limiter.reserve(keys) for _ in range(3)]
    assert all(reservation.granted for reservation in granted)
    denied = limiter.reserve(keys)
    assert not denied.granted and denied.denied_by == POLICY and denied.retry_after == 1
    assert not limiter.check(POLICY, "k").allowed


def test_uncounted_settle_gives_the_slot_back(limiter: InMemoryRateLimiter) -> None:
    reservation = limiter.reserve([LimitKey(POLICY, "k")])
    for _ in range(2):
        limiter.reserve([LimitKey(POLICY, "k")])
    assert not limiter.check(POLICY, "k").allowed
    assert limiter.settle(reservation, counted=False)[POLICY.name].allowed
    assert limiter.check(POLICY, "k").allowed


def test_counted_settle_records_a_hit(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    for _ in range(3):
        decisions = limiter.settle(limiter.reserve([LimitKey(POLICY, "k")]), counted=True)
    assert not decisions[POLICY.name].allowed  # three recorded failures exhaust the bucket
    denied = limiter.reserve([LimitKey(POLICY, "k")])
    assert not denied.granted and denied.retry_after > 1  # recorded hits: wait for the window
    fake.advance(seconds=61)
    assert limiter.reserve([LimitKey(POLICY, "k")]).granted


def test_reservation_is_all_or_nothing(limiter: InMemoryRateLimiter) -> None:
    for _ in range(3):
        limiter.hit(PER_IP, "ip")
    denied = limiter.reserve([LimitKey(POLICY, "acct"), LimitKey(PER_IP, "ip")])
    assert denied.denied_by == PER_IP
    assert limiter.check(POLICY, "acct").remaining == 3  # nothing was taken from the first bucket
    assert limiter.settle(denied, counted=True) == {}


def test_first_exhausted_key_is_reported(limiter: InMemoryRateLimiter) -> None:
    for _ in range(3):
        limiter.hit(POLICY, "a")
        limiter.hit(PER_IP, "b")
    assert limiter.reserve([LimitKey(PER_IP, "b"), LimitKey(POLICY, "a")]).denied_by == PER_IP


def test_lockout_starts_once(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    first = limiter.reserve([LimitKey(LOCKOUT, "acct")])
    second = limiter.reserve([LimitKey(LOCKOUT, "acct")])
    assert not limiter.reserve([LimitKey(LOCKOUT, "acct")]).granted  # limit 2, both slots in flight
    assert not limiter.settle(first, counted=True)[LOCKOUT.name].lockout_started
    reached = limiter.settle(second, counted=True)[LOCKOUT.name]
    assert reached.lockout_started and not reached.allowed and reached.retry_after == 900
    fake.advance(seconds=120)  # past the window but still locked out
    assert not limiter.reserve([LimitKey(LOCKOUT, "acct")]).granted
    assert not limiter.check(LOCKOUT, "acct").allowed
    fake.advance(seconds=781)
    assert limiter.reserve([LimitKey(LOCKOUT, "acct")]).granted


def test_clear_keeps_in_flight_slots(limiter: InMemoryRateLimiter) -> None:
    limiter.hit(POLICY, "k")
    in_flight = limiter.reserve([LimitKey(POLICY, "k")])
    limiter.clear(POLICY, "k")
    assert limiter.check(POLICY, "k").remaining == 2  # the recorded hit is gone, the slot is not
    limiter.settle(in_flight, counted=False)
    assert limiter.check(POLICY, "k").remaining == 3


def test_settle_after_reset_never_goes_negative(limiter: InMemoryRateLimiter) -> None:
    reservation = limiter.reserve([LimitKey(POLICY, "k")])
    limiter.reset()
    limiter.settle(reservation, counted=False)
    assert limiter.check(POLICY, "k").remaining == 3


def test_one_key_per_policy(limiter: InMemoryRateLimiter) -> None:
    with pytest.raises(ValueError, match="one key per policy"):
        limiter.reserve([LimitKey(POLICY, "a"), LimitKey(POLICY, "b")])


def test_a_reservation_takes_several_slots_or_none(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    """One request that sends several e-mails (D-19 re-sends) reserves them together: a refusal leaves
    nothing counted (B24-16), a grant counts them all."""
    limiter.hit(POLICY, "k")
    refused = limiter.reserve([LimitKey(POLICY, "k", slots=3)])  # 1 used + 3 > limit 3
    assert refused.denied_by == POLICY and refused.retry_after == 60  # until the recorded hit expires
    assert limiter.check(POLICY, "k").remaining == 2  # nothing was taken
    granted = limiter.reserve([LimitKey(POLICY, "k", slots=2)])
    assert granted.granted
    assert not limiter.reserve([LimitKey(POLICY, "k")]).granted  # the two slots count while in flight
    limiter.settle(granted, counted=True)
    assert limiter.check(POLICY, "k").remaining == 0
    fake.advance(seconds=61)
    assert limiter.check(POLICY, "k").remaining == 3  # all three recorded hits expired together


def test_given_back_slots_free_the_bucket(limiter: InMemoryRateLimiter) -> None:
    reservation = limiter.reserve([LimitKey(POLICY, "k", slots=3)])
    assert not limiter.reserve([LimitKey(POLICY, "k")]).granted
    limiter.settle(reservation, counted=False)
    assert limiter.check(POLICY, "k").remaining == 3


def test_more_slots_than_the_limit_never_fit(limiter: InMemoryRateLimiter) -> None:
    """Refused whatever the bucket holds, and flagged so that no caller answers "try again later" with a
    Retry-After that can never be met (SEC-44)."""
    refused = limiter.reserve([LimitKey(POLICY, "k", slots=4)])
    assert refused.denied_by == POLICY and refused.exceeds_limit and refused.retry_after == 0
    fits = limiter.reserve([LimitKey(POLICY, "k", slots=3)])
    assert fits.granted and not fits.exceeds_limit
    limiter.settle(fits, counted=True)
    full = limiter.reserve([LimitKey(POLICY, "k")])  # full, but the window frees it: not "never"
    assert full.denied_by == POLICY and not full.exceeds_limit and full.retry_after > 0
    with pytest.raises(ValueError, match="at least one slot"):
        LimitKey(POLICY, "k", slots=0)


def test_disabled_limiter_grants_reservations() -> None:
    limiter = DisabledRateLimiter()
    reservation = limiter.reserve([LimitKey(LOCKOUT, "acct")])
    assert reservation.granted
    assert limiter.settle(reservation, counted=True)[LOCKOUT.name].allowed


# ---- retention and the per-scope caps (B1-43, amended by B1-66) ------------------------------------

TYPED = RatePolicy(PolicyName.LOGIN_FAILURES_IP_EMAIL, limit=3, window_seconds=900, scope=BucketScope.EMAIL)
TYPED_LOCKOUT = RatePolicy(
    PolicyName.LOGIN_FAILURES_UNKNOWN_ACCOUNT,
    limit=2,
    window_seconds=60,
    lockout_seconds=900,
    scope=BucketScope.EMAIL,
)
NET = RatePolicy(PolicyName.FORGOT_PASSWORD_IP, limit=10, window_seconds=900, scope=BucketScope.NETWORK)
NET_PREFIX = RatePolicy(
    PolicyName.FORGOT_PASSWORD_PREFIX, limit=100, window_seconds=900, scope=BucketScope.NETWORK
)
ACCOUNT = RatePolicy(PolicyName.LOGIN_FAILURES_ACCOUNT, limit=2, window_seconds=60, lockout_seconds=900)


def _counted(limiter: InMemoryRateLimiter, *keys: LimitKey) -> Reservation:
    reservation = limiter.reserve(list(keys))
    assert reservation.granted
    limiter.settle(reservation, counted=True)
    return reservation


def test_buckets_expire_with_their_own_window(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    for index in range(50):
        _counted(limiter, LimitKey(TYPED, f"email-{index}"))  # 15-minute window
        limiter.hit(POLICY, f"user-{index}")  # 1-minute window
    assert limiter.stats() == LimiterStats(buckets=100, network_buckets=0, email_buckets=50)
    fake.advance(seconds=61)
    limiter.check(POLICY, "anyone")  # any call sweeps (at most once per second)
    assert limiter.stats() == LimiterStats(buckets=50, network_buckets=0, email_buckets=50)
    fake.advance(seconds=900)
    limiter.check(POLICY, "anyone")
    assert limiter.stats() == LimiterStats(buckets=0, network_buckets=0, email_buckets=0)  # not 24 hours


def test_lockouts_outlive_their_window(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    for _ in range(2):
        _counted(limiter, LimitKey(TYPED_LOCKOUT, "acct"))
    fake.advance(seconds=120)  # past the 60 s window, inside the 900 s lockout
    limiter.check(POLICY, "anyone")
    assert limiter.stats().email_buckets == 1
    assert not limiter.reserve([LimitKey(TYPED_LOCKOUT, "acct")]).granted
    fake.advance(seconds=781)
    limiter.check(POLICY, "anyone")
    assert limiter.stats().email_buckets == 0


def test_in_flight_buckets_are_never_swept(limiter: InMemoryRateLimiter, fake: FakeClock) -> None:
    in_flight = limiter.reserve([LimitKey(TYPED, "slow")])
    fake.advance(seconds=3600)
    limiter.check(POLICY, "anyone")
    assert limiter.stats().email_buckets == 1
    limiter.settle(in_flight, counted=False)
    assert limiter.stats().email_buckets == 0


def test_buckets_without_failures_are_dropped_at_once(limiter: InMemoryRateLimiter) -> None:
    # A successful login gives its slots back; nothing is left to remember.
    reservation = limiter.reserve([LimitKey(TYPED, "e"), LimitKey(NET, "ip"), LimitKey(ACCOUNT, "acct")])
    assert limiter.stats() == LimiterStats(buckets=3, network_buckets=1, email_buckets=1)
    limiter.settle(reservation, counted=False)
    assert limiter.stats() == LimiterStats(buckets=0, network_buckets=0, email_buckets=0)


def test_denied_reservations_create_no_buckets(limiter: InMemoryRateLimiter) -> None:
    for index in range(10):
        _counted(limiter, LimitKey(NET, "ip"), LimitKey(TYPED, f"e{index}"))
    before = limiter.stats()
    for index in range(100):  # the IP budget is spent: new addresses must not cost memory
        denied = limiter.reserve([LimitKey(NET, "ip"), LimitKey(TYPED, f"new-{index}")])
        assert denied.denied_by == NET
    assert limiter.stats() == before


def test_full_scope_admits_new_keys_untracked_instead_of_refusing(fake: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now, max_email_buckets=5)
    for index in range(5):
        _counted(limiter, LimitKey(TYPED, f"e{index}"))

    reservation = limiter.reserve([LimitKey(NET, "ip"), LimitKey(TYPED, "e5"), LimitKey(ACCOUNT, "acct")])
    assert reservation.granted
    assert reservation.untracked == (LimitKey(TYPED, "e5"),)
    assert reservation.keys == (LimitKey(NET, "ip"), LimitKey(ACCOUNT, "acct"))  # these still count
    assert set(limiter.settle(reservation, counted=True)) == {NET.name, ACCOUNT.name}
    assert limiter.stats() == LimiterStats(buckets=7, network_buckets=1, email_buckets=5)
    # `hit` degrades the same way: allowed, nothing recorded.
    assert limiter.hit(TYPED, "e6").allowed
    assert limiter.stats().email_buckets == 5


def test_full_scopes_keep_enforcing_the_buckets_that_exist(fake: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now, max_network_buckets=1, max_email_buckets=1)
    for _ in range(3):
        _counted(limiter, LimitKey(TYPED, "known"))
    for _ in range(10):
        _counted(limiter, LimitKey(NET, "ip"))
    # Both scopes are full; live buckets are never evicted, so their counts still apply ...
    assert limiter.reserve([LimitKey(TYPED, "known")]).denied_by == TYPED
    assert limiter.reserve([LimitKey(NET, "ip")]).denied_by == NET
    # ... and budgets keyed by existing rows are never capped, so a flood cannot switch them off.
    for _ in range(2):
        _counted(limiter, LimitKey(NET, "fresh-ip"), LimitKey(TYPED, "fresh-e"), LimitKey(ACCOUNT, "acct"))
    locked = limiter.reserve(
        [LimitKey(NET, "fresh-ip"), LimitKey(TYPED, "fresh-e"), LimitKey(ACCOUNT, "acct")]
    )
    assert locked.denied_by == ACCOUNT and locked.retry_after > 60


def test_email_keys_never_take_the_room_of_network_keys(fake: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now, max_network_buckets=2, max_email_buckets=2)
    for index in range(50):  # typed addresses cost an attacker nothing
        limiter.settle(limiter.reserve([LimitKey(TYPED, f"e{index}")]), counted=True)
    reservation = limiter.reserve([LimitKey(NET, "ip"), LimitKey(TYPED, "e-new")])
    assert reservation.keys == (LimitKey(NET, "ip"),)
    assert reservation.untracked == (LimitKey(TYPED, "e-new"),)


def test_a_scope_without_room_for_all_its_new_keys_tracks_none_of_them(fake: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now, max_network_buckets=3)
    _counted(limiter, LimitKey(NET, "ip-a"), LimitKey(NET_PREFIX, "48-a"))
    short = limiter.reserve([LimitKey(NET, "ip-b"), LimitKey(NET_PREFIX, "48-b")])  # needs 2, 1 left
    assert short.granted and short.keys == () and len(short.untracked) == 2
    assert limiter.settle(short, counted=True) == {}
    assert limiter.stats().network_buckets == 2
    fits = limiter.reserve([LimitKey(NET, "ip-b"), LimitKey(NET_PREFIX, "48-a")])  # needs 1
    assert fits.keys == (LimitKey(NET, "ip-b"), LimitKey(NET_PREFIX, "48-a")) and fits.untracked == ()


def test_cap_frees_up_when_buckets_expire(fake: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now, max_email_buckets=5)
    for index in range(5):
        _counted(limiter, LimitKey(TYPED, f"e{index}"))
    assert limiter.reserve([LimitKey(TYPED, "late")]).untracked == (LimitKey(TYPED, "late"),)
    fake.advance(seconds=901)
    late = limiter.reserve([LimitKey(TYPED, "late")])
    assert late.keys == (LimitKey(TYPED, "late"),) and late.untracked == ()


def test_full_scopes_are_logged_once_a_minute_each(fake: FakeClock, caplog: pytest.LogCaptureFixture) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now, max_network_buckets=1, max_email_buckets=1)
    _counted(limiter, LimitKey(TYPED, "a"), LimitKey(NET, "ip"))
    with caplog.at_level("WARNING", logger="app.rate_limit"):
        for index in range(10):
            limiter.reserve([LimitKey(TYPED, f"x{index}"), LimitKey(NET, f"ip{index}")])
        fake.advance(seconds=30)
        limiter.reserve([LimitKey(TYPED, "y")])
        fake.advance(seconds=31)
        limiter.reserve([LimitKey(TYPED, "z")])
    assert [getattr(record, "scope", None) for record in caplog.records] == ["email", "network", "email"]


def test_joined_reservations_settle_together(limiter: InMemoryRateLimiter) -> None:
    first = limiter.reserve([LimitKey(POLICY, "k")])
    second = limiter.reserve([LimitKey(PER_IP, "ip")])
    decisions = limiter.settle(first.joined(second), counted=True)
    assert set(decisions) == {POLICY.name, PER_IP.name}
    assert limiter.check(POLICY, "k").remaining == 2
    assert limiter.check(PER_IP, "ip").remaining == 2
    with pytest.raises(ValueError, match="one key per policy"):
        first.joined(Reservation((LimitKey(POLICY, "other"),)))
    with pytest.raises(ValueError, match="granted"):
        first.joined(Reservation((), denied_by=POLICY))


def test_attacker_networks_within_their_budgets_never_refuse_an_unrelated_client(fake: FakeClock) -> None:
    """Regression for B1-43: networks that each stayed within every budget filled the one shared
    anonymous cap with typed addresses, after which every new client was refused. Scaled down (caps of
    150 and 300 instead of 100,000); the key layout is AuthService's: the client's (IP, e-mail), IP and
    IPv6 /48 keys, then the account key (unknown addresses: `login_failures_unknown_account`)."""
    policies = RatePolicies.from_settings(
        Settings(_env_file=None, app_env="test", database_url="postgresql://u:p@h/d")
    )
    limiter = InMemoryRateLimiter(clock=fake.now, max_network_buckets=150, max_email_buckets=300)
    attackers = [f"198.51.{n // 250}.{n % 250}" for n in range(80)]
    attackers += [f"2001:db8:{site:x}:{n:x}::1" for site in range(4) for n in range(10)]  # 10 /64s per /48
    fresh = iter(range(1_000_000))
    round_seconds = 11  # just inside 30 failures / 5 min per IP and 300 / 5 min per /48

    def login(address: str, account: tuple[RatePolicy, str]) -> Reservation:
        email = f"user-{next(fresh)}@x.test"
        subject = rate_limit_subject(address)
        keys = [
            LimitKey(policies.login_failures_ip_email, f"{subject}/{email}"),
            LimitKey(policies.login_failures_ip, subject),
        ]
        if (site := rate_limit_prefix(address)) is not None:
            keys.append(LimitKey(policies.login_failures_prefix, site))
        client = limiter.reserve(keys)
        if not client.granted:
            return client
        account_reservation = limiter.reserve([LimitKey(*account)])
        if not account_reservation.granted:
            limiter.settle(client, counted=False)
            return account_reservation
        return client.joined(account_reservation)

    def failed_login(address: str) -> bool:
        attempt = login(address, (policies.login_failures_unknown_account, f"unknown-{next(fresh)}"))
        if attempt.granted:
            limiter.settle(attempt, counted=True)
        return attempt.granted

    def counted_request(*keys: LimitKey) -> bool:
        reservation = limiter.reserve(keys)
        if reservation.granted:
            limiter.settle(reservation, counted=True)
        return reservation.granted

    refused: list[str] = []
    for round_ in range(1800 // round_seconds):  # 30 minutes
        fake.advance(seconds=round_seconds)
        for address in attackers:
            subject, site = rate_limit_subject(address), rate_limit_prefix(address)
            # A failed login with a fresh address every round: as many as the per-IP budget allows.
            assert failed_login(address)
            if round_ % 9 == 0:  # forgot-password every 99 s (10 / 15 min per IP, 100 per /48)
                forgot = [LimitKey(policies.forgot_password_ip, subject)]
                if site is not None:
                    forgot.append(LimitKey(policies.forgot_password_prefix, site))
                assert counted_request(*forgot)
            if round_ % 5 == 0:  # reset-password every 55 s (20 / 15 min per IP)
                reset = [LimitKey(policies.reset_password_ip, subject)]
                if site is not None:
                    reset.append(LimitKey(policies.reset_password_prefix, site))
                assert counted_request(*reset)
        if round_ >= 55:  # once the flood is at full strength
            client_address = f"203.0.113.{round_ % 250}"
            success = login(client_address, (policies.login_failures_account, "existing-user-id"))
            if success.granted:
                limiter.settle(success, counted=False)
            else:
                refused.append(success.denied_by.name if success.denied_by else "?")
            forgot = counted_request(LimitKey(policies.forgot_password_ip, client_address))
            reset = counted_request(LimitKey(policies.reset_password_ip, client_address))
            if not (forgot and reset):
                refused.append("forgot_or_reset")

    assert refused == []
    stats = limiter.stats()
    assert (stats.network_buckets, stats.email_buckets) == (150, 300)  # the flood did fill both scopes

    # Limits that exist keep working while both scopes are full: an attacker over its IP budget ...
    over_budget = [failed_login(attackers[0]) for _ in range(40)]
    assert not all(over_budget)
    # ... and the account budget of an existing account, which no flood can push out.
    for index in range(10):
        attempt = login(f"192.0.2.{index}", (policies.login_failures_account, "victim-id"))
        assert attempt.granted
        limiter.settle(attempt, counted=True)
    locked = login("192.0.2.200", (policies.login_failures_account, "victim-id"))
    assert locked.denied_by == policies.login_failures_account


def test_sweep_cost_does_not_grow_with_live_buckets(fake: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock=fake.now)
    for index in range(2000):
        limiter.hit(POLICY, f"user-{index}")
    visited = 0
    original = type(limiter._tables[POLICY.name]).items

    class CountingDict(type(limiter._tables[POLICY.name])):  # type: ignore[misc]
        def items(self):  # type: ignore[override]
            nonlocal visited
            for item in original(self):
                visited += 1
                yield item

    limiter._tables[POLICY.name] = CountingDict(limiter._tables[POLICY.name])
    fake.advance(seconds=2)
    limiter.check(POLICY, "anyone")  # sweeps: every bucket is still inside its window
    assert visited == 1  # stops at the oldest bucket instead of walking all 2,000
