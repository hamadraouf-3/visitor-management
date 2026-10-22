"""Rate limiting (contract §7.3).

`RateLimiter` is the interface; `InMemoryRateLimiter` is a sliding-window implementation kept on
`app.state` (single process: run one worker per instance until a shared store such as Redis exists).
Time comes from the application clock so tests can move it.

Two ways to count:
* `hit` counts every request (e.g. the per-user API budget).
* `reserve` + `settle` count only outcomes that turn out to be failures (e.g. wrong passwords) without a
  check-then-record race: `reserve` atomically takes in-flight slots in every bucket (one per key, or
  `LimitKey.slots`; all or nothing), and an in-flight slot counts against the limit until `settle`
  either records it or gives it back. Concurrent attempts therefore can never exceed a limit, even
  though their outcome is only known after the slow work. Endpoints that count every attempt
  (forgot/reset-password) reserve and settle counted at once.

Keys never contain raw identifiers: callers derive them with `limiter_key`, which HMACs the parts
with SECRET_KEY so no email address sits in process memory.

Memory is bounded. A bucket lives only while it can still affect a decision (its own window, its
lockout, or an in-flight slot), and how many buckets can exist depends on what a policy's keys are
derived from (`BucketScope`):
* BOUNDED keys name rows that exist (an authenticated user, a visit, an existing account); the data
  bounds their number, so they are never capped.
* NETWORK keys are client addresses and IPv6 prefixes; EMAIL keys are digests of e-mail addresses that
  anonymous clients typed. Anyone can mint new ones (e-mail strings at no cost at all), so each of the
  two scopes has its own cap. Separate caps keep free e-mail strings from using up the room that the
  per-network limits need.
A scope at its cap never refuses a request: a request that needs a new bucket of that scope is admitted
and judged by its other buckets, and only that bucket is not created (`Reservation.untracked`). Refusing
instead would let anyone who fills a table lock every new client out (sign-in and password recovery
for everybody). Live buckets are never evicted either, because forgetting one would reset somebody's
failure count or lockout.
"""

import bisect
import hashlib
import hmac
import logging
import math
import threading
from collections import Counter, OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Protocol

from app.core import time as app_time
from app.core.config import Settings

logger = logging.getLogger("app.rate_limit")


class PolicyName(StrEnum):
    LOGIN_FAILURES_IP_EMAIL = "login_failures_ip_email"
    LOGIN_FAILURES_IP = "login_failures_ip"
    LOGIN_FAILURES_PREFIX = "login_failures_prefix"
    LOGIN_FAILURES_ACCOUNT = "login_failures_account"
    LOGIN_FAILURES_UNKNOWN_ACCOUNT = "login_failures_unknown_account"
    LOGIN_FAILURES_DEVICE = "login_failures_device"
    LOGIN_SUCCESSES_ACCOUNT = "login_successes_account"
    PASSWORD_CHANGE_FAILURES = "password_change_failures"
    PASSWORD_CHANGES_PER_USER = "password_changes_per_user"
    USER_EMAIL_REFUSALS_PER_USER = "user_email_refusals_per_user"
    USER_EMAIL_REFUSALS_PER_COMPANY = "user_email_refusals_per_company"
    PASSWORD_NOTICES_PER_USER = "password_notices_per_user"
    FORGOT_PASSWORD_ACCOUNT = "forgot_password_account"
    FORGOT_PASSWORD_IP = "forgot_password_ip"
    FORGOT_PASSWORD_PREFIX = "forgot_password_prefix"
    RESET_PASSWORD_IP = "reset_password_ip"
    RESET_PASSWORD_PREFIX = "reset_password_prefix"
    SCAN_PER_USER = "scan_per_user"
    ATTENDANCE_REFUSALS_PER_USER = "attendance_refusals_per_user"
    STALE_CHECK_OUT_EMPTY_RUNS = "stale_check_out_empty_runs"
    INVITATIONS_PER_USER_DAY = "invitations_per_user_day"
    INVITATION_RESENDS_PER_VISIT = "invitation_resends_per_visit"
    RESCHEDULE_NOTICES_PER_USER_DAY = "reschedule_notices_per_user_day"
    RESCHEDULE_NOTICES_PER_VISIT = "reschedule_notices_per_visit"
    HOST_ARRIVALS_PER_USER_DAY = "host_arrivals_per_user_day"
    HOST_VISIT_NOTICES_PER_USER_DAY = "host_visit_notices_per_user_day"
    CALENDAR_EMAILS_PER_COMPANY_DAY = "calendar_emails_per_company_day"
    TRACKING_ALERT_EMAILS_PER_COMPANY_DAY = "tracking_alert_emails_per_company_day"
    TRACKING_ALERT_NOTICES_PER_VISIT = "tracking_alert_notices_per_visit"
    TEMPLATE_TEST_SENDS_PER_USER = "template_test_sends_per_user"
    PUBLIC_BRAND_IP = "public_brand_ip"
    PUBLIC_BRAND_PREFIX = "public_brand_prefix"
    BRAND_CHANGES_PER_USER = "brand_changes_per_user"
    TRACKING_REQUESTS_PER_KEY = "tracking_requests_per_key"
    TRACKING_KEY_FAILURES_IP = "tracking_key_failures_ip"
    API_PER_USER = "api_per_user"


class BucketScope(StrEnum):
    """What a policy's keys are derived from, which decides whether its buckets are capped."""

    BOUNDED = "bounded"  # rows that exist: authenticated users, visits, existing accounts (uncapped)
    NETWORK = "network"  # client addresses and IPv6 prefixes (RATE_LIMIT_MAX_NETWORK_BUCKETS)
    EMAIL = "email"  # e-mail addresses typed by anonymous clients (RATE_LIMIT_MAX_EMAIL_BUCKETS)


@dataclass(frozen=True, slots=True)
class RatePolicy:
    name: PolicyName
    limit: int
    window_seconds: int
    # When set, reaching the limit blocks the key for this long (an account lockout) instead of only
    # until the oldest hit leaves the window.
    lockout_seconds: int | None = None
    scope: BucketScope = BucketScope.BOUNDED


PASSWORD_NOTICES_PER_HOUR = 5
# A bulk stale check-out that finds nothing to check out is recorded once per user and company-local day
# (SEC-42); the key names the day, and the window outlasts any local day (23 to 25 hours).
STALE_CHECK_OUT_EMPTY_RUNS_PER_DAY = 1
STALE_CHECK_OUT_EMPTY_RUN_WINDOW_SECONDS = 2 * 24 * 60 * 60
# The tracking alerts' e-mails of a company in 24 hours (Phase 16, B16-15): each recipient of an opened or
# escalated alert takes one. Every company's e-mails leave through the one sending mailbox; a noisy provider
# (or a misplaced camera) must not use up the other companies' day. Beyond it the alert still opens.
TRACKING_ALERT_EMAILS_PER_COMPANY_DAY = 500
# The e-mailed openings and escalations of one visit's alerts in an hour (Phase 16, B16-25), whatever their
# number of recipients: a visitor walking in and out of a forbidden zone, or areas changed back and forth by
# reception, must not send the addresses and the host one e-mail each time. Beyond it the alert still opens
# or escalates; only its e-mails are left out.
TRACKING_ALERT_NOTICES_PER_VISIT_HOUR = 3
DEFAULT_MAX_NETWORK_BUCKETS = 100_000
DEFAULT_MAX_EMAIL_BUCKETS = 100_000
CAPACITY_WARNING_INTERVAL_SECONDS = 60


@dataclass(frozen=True, slots=True)
class RateDecision:
    allowed: bool
    retry_after: int = 0  # seconds; > 0 only when not allowed and waiting can help
    remaining: int = 0
    lockout_started: bool = False  # this call's recorded hit started the policy's lockout
    # More slots were asked for than the policy's limit: refused whatever the bucket holds, and waiting
    # never helps (so there is no `retry_after`).
    exceeds_limit: bool = False


@dataclass(frozen=True, slots=True)
class LimitKey:
    policy: RatePolicy
    key: str
    slots: int = 1  # how many hits this reservation takes in the key's bucket

    def __post_init__(self) -> None:
        if self.slots < 1:
            raise ValueError("a reservation takes at least one slot per key")


@dataclass(frozen=True, slots=True)
class Reservation:
    """In-flight slots taken by `RateLimiter.reserve`; settle exactly once when granted.

    `keys` are the keys holding a slot. `untracked` keys were admitted without a bucket because their
    scope was at its cap; nothing is counted for them.
    """

    keys: tuple[LimitKey, ...]
    denied_by: RatePolicy | None = None
    retry_after: int = 0
    untracked: tuple[LimitKey, ...] = ()
    # Refused because a key asks for more slots than its policy's limit (`RateDecision.exceeds_limit`):
    # the request can never be granted, so a caller must not answer "try again later".
    exceeds_limit: bool = False

    @property
    def granted(self) -> bool:
        return self.denied_by is None

    def joined(self, other: Reservation) -> Reservation:
        """One reservation holding the slots of two granted ones, to settle them together."""
        if not (self.granted and other.granted):
            raise ValueError("only granted reservations can be joined")
        _unique_policies((*self.keys, *self.untracked, *other.keys, *other.untracked))
        return Reservation((*self.keys, *other.keys), untracked=(*self.untracked, *other.untracked))


@dataclass(frozen=True, slots=True)
class RatePolicies:
    login_failures_ip_email: RatePolicy
    login_failures_ip: RatePolicy
    login_failures_prefix: RatePolicy
    login_failures_account: RatePolicy
    login_failures_unknown_account: RatePolicy
    login_failures_device: RatePolicy
    login_successes_account: RatePolicy
    password_change_failures: RatePolicy
    password_changes_per_user: RatePolicy
    user_email_refusals_per_user: RatePolicy
    user_email_refusals_per_company: RatePolicy
    password_notices_per_user: RatePolicy
    forgot_password_account: RatePolicy
    forgot_password_ip: RatePolicy
    forgot_password_prefix: RatePolicy
    reset_password_ip: RatePolicy
    reset_password_prefix: RatePolicy
    scan_per_user: RatePolicy
    attendance_refusals_per_user: RatePolicy
    stale_check_out_empty_runs: RatePolicy
    invitations_per_user_day: RatePolicy
    invitation_resends_per_visit: RatePolicy
    reschedule_notices_per_user_day: RatePolicy
    reschedule_notices_per_visit: RatePolicy
    host_arrivals_per_user_day: RatePolicy
    host_visit_notices_per_user_day: RatePolicy
    calendar_emails_per_company_day: RatePolicy
    tracking_alert_emails_per_company_day: RatePolicy
    tracking_alert_notices_per_visit: RatePolicy
    template_test_sends_per_user: RatePolicy
    public_brand_ip: RatePolicy
    public_brand_prefix: RatePolicy
    brand_changes_per_user: RatePolicy
    tracking_requests_per_key: RatePolicy
    tracking_key_failures_ip: RatePolicy
    api_per_user: RatePolicy

    @classmethod
    def from_settings(cls, settings: Settings) -> RatePolicies:
        five_minutes, fifteen_minutes = 5 * 60, 15 * 60
        network, email = BucketScope.NETWORK, BucketScope.EMAIL
        account_limit = settings.rate_limit_login_per_account
        return cls(
            login_failures_ip_email=RatePolicy(
                PolicyName.LOGIN_FAILURES_IP_EMAIL,
                settings.rate_limit_login_per_ip_email,
                five_minutes,
                scope=email,
            ),
            login_failures_ip=RatePolicy(
                PolicyName.LOGIN_FAILURES_IP, settings.rate_limit_login_per_ip, five_minutes, scope=network
            ),
            login_failures_prefix=RatePolicy(
                PolicyName.LOGIN_FAILURES_PREFIX,
                settings.rate_limit_login_per_prefix,
                five_minutes,
                scope=network,
            ),
            login_failures_account=RatePolicy(
                PolicyName.LOGIN_FAILURES_ACCOUNT,
                account_limit,
                fifteen_minutes,
                lockout_seconds=fifteen_minutes,
            ),
            # The same budget for an address without an account, so a lockout reveals nothing about
            # which addresses have one; keyed by the typed address, hence capped.
            login_failures_unknown_account=RatePolicy(
                PolicyName.LOGIN_FAILURES_UNKNOWN_ACCOUNT,
                account_limit,
                fifteen_minutes,
                lockout_seconds=fifteen_minutes,
                scope=email,
            ),
            # The account budget of a browser holding a device cookie for the account (SEC-01): its
            # failures block that browser only, and the account's block does not apply to it. Keyed by
            # (user, device) from a server-signed cookie, so bounded by the successful sign-ins.
            login_failures_device=RatePolicy(
                PolicyName.LOGIN_FAILURES_DEVICE,
                account_limit,
                fifteen_minutes,
                lockout_seconds=fifteen_minutes,
            ),
            # Not in §7.3 (SEC-02/SEC-14): successful sign-ins per account. Each one costs an Argon2
            # verification and writes a session and an audit row that are never deleted.
            login_successes_account=RatePolicy(
                PolicyName.LOGIN_SUCCESSES_ACCOUNT,
                settings.rate_limit_login_successes_per_account,
                fifteen_minutes,
            ),
            password_change_failures=RatePolicy(
                PolicyName.PASSWORD_CHANGE_FAILURES,
                settings.rate_limit_password_change_per_user,
                fifteen_minutes,
            ),
            # Not in §7.3 (SEC-43): successful password changes per account and hour. Each one costs two
            # Argon2 operations (verify and hash) and writes a session and an audit row; the counterpart
            # of `login_successes_account` for POST /auth/change-password.
            password_changes_per_user=RatePolicy(
                PolicyName.PASSWORD_CHANGES_PER_USER, settings.rate_limit_password_changes_per_hour, 60 * 60
            ),
            # Not in §7.3 (SEC-05): POST /users answers whether an address is taken in any company
            # (D-03); refusals for taken addresses are bounded per administrator and hour, and per company
            # and hour, since an administrator can create more administrators (SEC-R1).
            user_email_refusals_per_user=RatePolicy(
                PolicyName.USER_EMAIL_REFUSALS_PER_USER,
                settings.rate_limit_user_email_refusals_per_hour,
                60 * 60,
            ),
            user_email_refusals_per_company=RatePolicy(
                PolicyName.USER_EMAIL_REFUSALS_PER_COMPANY,
                settings.rate_limit_user_email_refusals_per_company_per_hour,
                60 * 60,
            ),
            # "Your password was changed" notices per account and hour (SEC-06). Every change and reset
            # sends one; beyond this the change is still made and only the e-mail is left out, so a
            # script changing its own password back and forth cannot use up the provider's quota.
            password_notices_per_user=RatePolicy(
                PolicyName.PASSWORD_NOTICES_PER_USER, PASSWORD_NOTICES_PER_HOUR, 60 * 60
            ),
            forgot_password_account=RatePolicy(
                PolicyName.FORGOT_PASSWORD_ACCOUNT, settings.rate_limit_forgot_per_email, fifteen_minutes
            ),
            forgot_password_ip=RatePolicy(
                PolicyName.FORGOT_PASSWORD_IP,
                settings.rate_limit_forgot_per_ip,
                fifteen_minutes,
                scope=network,
            ),
            forgot_password_prefix=RatePolicy(
                PolicyName.FORGOT_PASSWORD_PREFIX,
                settings.rate_limit_forgot_per_prefix,
                fifteen_minutes,
                scope=network,
            ),
            reset_password_ip=RatePolicy(
                PolicyName.RESET_PASSWORD_IP,
                settings.rate_limit_reset_per_ip,
                fifteen_minutes,
                scope=network,
            ),
            reset_password_prefix=RatePolicy(
                PolicyName.RESET_PASSWORD_PREFIX,
                settings.rate_limit_reset_per_prefix,
                fifteen_minutes,
                scope=network,
            ),
            scan_per_user=RatePolicy(PolicyName.SCAN_PER_USER, settings.rate_limit_scan_per_minute, 60),
            # Not in §7.3: refused check-ins/check-outs/walk-ins without a scanned pass (L-BE-2).
            attendance_refusals_per_user=RatePolicy(
                PolicyName.ATTENDANCE_REFUSALS_PER_USER,
                settings.rate_limit_attendance_refusals_per_minute,
                60,
            ),
            # Not in §7.3 (SEC-42): how often a bulk stale check-out that checks out nobody writes its
            # audit row; keyed by (user, company-local day). Not a refusal: such a run still answers 200.
            stale_check_out_empty_runs=RatePolicy(
                PolicyName.STALE_CHECK_OUT_EMPTY_RUNS,
                STALE_CHECK_OUT_EMPTY_RUNS_PER_DAY,
                STALE_CHECK_OUT_EMPTY_RUN_WINDOW_SECONDS,
            ),
            invitations_per_user_day=RatePolicy(
                PolicyName.INVITATIONS_PER_USER_DAY, settings.invitation_daily_limit, 24 * 60 * 60
            ),
            invitation_resends_per_visit=RatePolicy(
                PolicyName.INVITATION_RESENDS_PER_VISIT, settings.rate_limit_resends_per_visit_hour, 60 * 60
            ),
            reschedule_notices_per_user_day=RatePolicy(
                PolicyName.RESCHEDULE_NOTICES_PER_USER_DAY,
                settings.reschedule_notice_daily_limit,
                24 * 60 * 60,
            ),
            reschedule_notices_per_visit=RatePolicy(
                PolicyName.RESCHEDULE_NOTICES_PER_VISIT,
                settings.rate_limit_reschedule_notices_per_visit_hour,
                60 * 60,
            ),
            host_arrivals_per_user_day=RatePolicy(
                PolicyName.HOST_ARRIVALS_PER_USER_DAY, settings.host_arrival_daily_limit, 24 * 60 * 60
            ),
            # Not in §7.3 (Phase 14, B14-15): the host's e-mails of scheduled visits per acting user and
            # day, and the e-mails carrying a visit's calendar event per company and day (keyed by the
            # company: every company's e-mails share the one sending mailbox).
            host_visit_notices_per_user_day=RatePolicy(
                PolicyName.HOST_VISIT_NOTICES_PER_USER_DAY,
                settings.host_visit_notice_daily_limit,
                24 * 60 * 60,
            ),
            calendar_emails_per_company_day=RatePolicy(
                PolicyName.CALENDAR_EMAILS_PER_COMPANY_DAY,
                settings.calendar_email_company_daily_limit,
                24 * 60 * 60,
            ),
            # Not in §7.3 (Phase 16, B16-15): the tracking alerts' e-mails per company and 24 hours.
            tracking_alert_emails_per_company_day=RatePolicy(
                PolicyName.TRACKING_ALERT_EMAILS_PER_COMPANY_DAY,
                TRACKING_ALERT_EMAILS_PER_COMPANY_DAY,
                24 * 60 * 60,
            ),
            # Not in §7.3 (Phase 16, B16-25): the e-mailed openings and escalations of a visit's alerts per
            # hour, keyed by the visit (visits exist: bounded), like `reschedule_notices_per_visit`.
            tracking_alert_notices_per_visit=RatePolicy(
                PolicyName.TRACKING_ALERT_NOTICES_PER_VISIT, TRACKING_ALERT_NOTICES_PER_VISIT_HOUR, 60 * 60
            ),
            # Not in §7.3 (B11-29): test e-mails of a company's edited texts, to the administrator's own
            # address, per administrator and hour.
            template_test_sends_per_user=RatePolicy(
                PolicyName.TEMPLATE_TEST_SENDS_PER_USER,
                settings.rate_limit_template_test_sends_per_hour,
                60 * 60,
            ),
            # Not in §7.3 (B12-9): the public identity endpoints (a company's brand, its images, its web
            # app manifest), per client address and minute and per IPv6 /48. Every request counts,
            # whatever it asks for and whatever the answer: they are what bounds probing for companies.
            public_brand_ip=RatePolicy(
                PolicyName.PUBLIC_BRAND_IP, settings.rate_limit_public_brand_per_ip, 60, scope=network
            ),
            public_brand_prefix=RatePolicy(
                PolicyName.PUBLIC_BRAND_PREFIX, settings.rate_limit_public_brand_per_prefix, 60, scope=network
            ),
            # Not in §7.3 (B12-7): changes of companies' brands per platform account and hour.
            brand_changes_per_user=RatePolicy(
                PolicyName.BRAND_CHANGES_PER_USER, settings.rate_limit_brand_changes_per_hour, 60 * 60
            ),
            # Not in §7.3 (Phase 15, B15-17): the tracking provider's ingestion requests per key and minute
            # (keys exist: bounded), and requests with a wrong, revoked or absent key per client address and
            # 5 minutes, which bounds the key lookups an anonymous client can cause.
            tracking_requests_per_key=RatePolicy(
                PolicyName.TRACKING_REQUESTS_PER_KEY, settings.rate_limit_tracking_requests_per_minute, 60
            ),
            tracking_key_failures_ip=RatePolicy(
                PolicyName.TRACKING_KEY_FAILURES_IP,
                settings.rate_limit_tracking_key_failures_per_ip,
                five_minutes,
                scope=network,
            ),
            api_per_user=RatePolicy(PolicyName.API_PER_USER, settings.rate_limit_api_per_minute, 60),
        )


class RateLimiter(Protocol):
    def check(self, policy: RatePolicy, key: str) -> RateDecision:
        """Would one more hit be allowed? Does not record anything."""
        ...

    def hit(self, policy: RatePolicy, key: str) -> RateDecision:
        """Record a hit if allowed; a denied hit is not recorded. When the policy's scope is at its cap
        and the key has no bucket, the hit is allowed without being recorded."""
        ...

    def reserve(self, keys: Sequence[LimitKey]) -> Reservation:
        """Atomically take each key's in-flight slots (`LimitKey.slots`) in its bucket, or nothing when
        any bucket lacks room (the first such key, in the given order, is reported). Keys whose scope is
        at its cap and that have no bucket yet are admitted untracked. One key per policy. A key asking
        for more slots than its policy's limit is refused with `exceeds_limit` and no `retry_after`."""
        ...

    def settle(self, reservation: Reservation, *, counted: bool) -> Mapping[PolicyName, RateDecision]:
        """Give back the slots of a granted reservation. With `counted`, each slot becomes a recorded hit
        (applying lockouts). Returns each tracked bucket's state afterwards, from recorded hits only."""
        ...

    def clear(self, policy: RatePolicy, key: str) -> None: ...

    def reset(self) -> None: ...


def limiter_key(secret: str, *parts: object) -> str:
    """Stable, non-reversible key for identifiers such as e-mail addresses or IPs."""
    material = "\x1f".join("" if part is None else str(part) for part in parts)
    return hmac.new(secret.encode(), material.encode(), hashlib.sha256).hexdigest()[:40]


def _unique_policies(keys: Sequence[LimitKey]) -> tuple[LimitKey, ...]:
    keys = tuple(keys)
    if len({limit_key.policy.name for limit_key in keys}) != len(keys):
        raise ValueError("a reservation takes at most one key per policy")
    return keys


@dataclass(slots=True)
class _Bucket:
    policy: RatePolicy
    touched_at: float  # creation or last recorded hit; buckets are kept in this order per policy
    hits: list[float] = field(default_factory=list)  # ascending
    blocked_until: float = 0.0
    in_flight: int = 0

    def prune(self, policy: RatePolicy, now: float) -> None:
        del self.hits[: bisect.bisect_right(self.hits, now - policy.window_seconds)]

    def is_idle(self, now: float) -> bool:
        """Nothing left that could affect a decision: no slot in flight, no lockout, no hit in the
        window."""
        return (
            self.in_flight == 0
            and self.blocked_until <= now
            and (not self.hits or self.hits[-1] <= now - self.policy.window_seconds)
        )


@dataclass(frozen=True, slots=True)
class LimiterStats:
    buckets: int
    network_buckets: int
    email_buckets: int


class InMemoryRateLimiter:
    """Thread-safe sliding-window limiter (sync routes run in a thread pool).

    Buckets are kept per policy in `touched_at` order, so the sweep only visits buckets that may have
    expired and stops at the first one touched within its policy's window. It runs at most once per
    `sweep_interval_seconds` of clock time, driven by the calls themselves, before any capacity check.
    """

    def __init__(
        self,
        clock: Callable[[], datetime] = app_time.now,
        *,
        max_network_buckets: int = DEFAULT_MAX_NETWORK_BUCKETS,
        max_email_buckets: int = DEFAULT_MAX_EMAIL_BUCKETS,
        sweep_interval_seconds: float = 1.0,
    ) -> None:
        self._clock = clock
        self._caps: dict[BucketScope, int] = {
            BucketScope.NETWORK: max_network_buckets,
            BucketScope.EMAIL: max_email_buckets,
        }
        self._sweep_interval = sweep_interval_seconds
        self._tables: dict[PolicyName, OrderedDict[str, _Bucket]] = {}
        self._counts: Counter[BucketScope] = Counter()
        self._lock = threading.Lock()
        self._last_sweep = -math.inf
        self._last_capacity_warning: dict[BucketScope, float] = {}

    def _now(self) -> float:
        return self._clock().timestamp()

    # ---- bucket bookkeeping (call with the lock held) --------------------------------------------

    def _existing(self, policy: RatePolicy, key: str, now: float) -> _Bucket | None:
        table = self._tables.get(policy.name)
        bucket = table.get(key) if table is not None else None
        if bucket is not None:
            bucket.prune(policy, now)
        return bucket

    def _create(self, policy: RatePolicy, key: str, now: float) -> _Bucket:
        bucket = _Bucket(policy, touched_at=now)
        self._tables.setdefault(policy.name, OrderedDict())[key] = bucket
        self._counts[policy.scope] += 1
        return bucket

    def _drop(self, name: PolicyName, key: str) -> None:
        bucket = self._tables[name].pop(key)
        self._counts[bucket.policy.scope] -= 1

    def _drop_if_idle(self, policy: RatePolicy, key: str, bucket: _Bucket, now: float) -> None:
        table = self._tables.get(policy.name)
        if bucket.is_idle(now) and table is not None and table.get(key) is bucket:
            self._drop(policy.name, key)

    def _record(self, policy: RatePolicy, key: str, bucket: _Bucket, now: float) -> bool:
        """Append a hit; returns True when it started the policy's lockout."""
        bucket.hits.append(now)
        bucket.touched_at = now
        self._tables[policy.name].move_to_end(key)
        if policy.lockout_seconds is None or len(bucket.hits) < policy.limit:
            return False
        already_blocked = bucket.blocked_until > now
        bucket.blocked_until = now + policy.lockout_seconds
        return not already_blocked

    def _sweep(self, now: float) -> None:
        self._last_sweep = now
        for name, table in self._tables.items():
            idle: list[str] = []
            for key, bucket in table.items():
                if bucket.touched_at > now - bucket.policy.window_seconds:
                    break  # this bucket and every later one were touched within the window
                if bucket.is_idle(now):
                    idle.append(key)
            for key in idle:
                self._drop(name, key)

    def _maybe_sweep(self, now: float) -> None:
        if now - self._last_sweep >= self._sweep_interval:
            self._sweep(now)

    def _has_room(self, scope: BucketScope, needed: int, now: float) -> bool:
        """Whether `needed` more buckets of `scope` fit under its cap (BOUNDED is never capped)."""
        cap = self._caps.get(scope)
        if cap is None or self._counts[scope] + needed <= cap:
            return True
        if now - self._last_capacity_warning.get(scope, -math.inf) >= CAPACITY_WARNING_INTERVAL_SECONDS:
            self._last_capacity_warning[scope] = now
            logger.warning(
                "rate limiter scope is at its bucket cap; new keys of this scope are admitted untracked",
                extra={"scope": scope.value, "buckets": self._counts[scope], "cap": cap},
            )
        return False

    # ---- decisions --------------------------------------------------------------------------------

    @staticmethod
    def _decision(
        bucket: _Bucket | None,
        policy: RatePolicy,
        now: float,
        *,
        include_in_flight: bool = True,
        slots: int = 1,
    ) -> RateDecision:
        """Whether `slots` more hits fit."""
        if slots > policy.limit:
            return RateDecision(False, exceeds_limit=True)  # can never fit: waiting does not help
        if bucket is None:
            return RateDecision(True, remaining=policy.limit)
        if bucket.blocked_until > now:
            return RateDecision(False, retry_after=max(1, math.ceil(bucket.blocked_until - now)))
        used = len(bucket.hits) + (bucket.in_flight if include_in_flight else 0)
        if used + slots <= policy.limit:
            return RateDecision(True, remaining=policy.limit - used)
        if len(bucket.hits) + slots > policy.limit:
            # Recorded hits alone leave no room: wait until enough of the oldest have left the window.
            oldest_expiry = bucket.hits[len(bucket.hits) + slots - 1 - policy.limit] + policy.window_seconds
            return RateDecision(False, retry_after=max(1, math.ceil(oldest_expiry - now)))
        # Only in-flight attempts fill the bucket; they resolve within moments.
        return RateDecision(False, retry_after=1)

    # ---- RateLimiter --------------------------------------------------------------------------------

    def check(self, policy: RatePolicy, key: str) -> RateDecision:
        now = self._now()
        with self._lock:
            self._maybe_sweep(now)
            return self._decision(self._existing(policy, key, now), policy, now)

    def hit(self, policy: RatePolicy, key: str) -> RateDecision:
        now = self._now()
        with self._lock:
            self._maybe_sweep(now)
            bucket = self._existing(policy, key, now)
            decision = self._decision(bucket, policy, now)
            if not decision.allowed:
                return decision
            if bucket is None:
                if not self._has_room(policy.scope, 1, now):
                    return decision  # admitted untracked
                bucket = self._create(policy, key, now)
            self._record(policy, key, bucket, now)
            return RateDecision(True, remaining=max(0, policy.limit - len(bucket.hits) - bucket.in_flight))

    def reserve(self, keys: Sequence[LimitKey]) -> Reservation:
        keys = _unique_policies(keys)
        now = self._now()
        with self._lock:
            self._maybe_sweep(now)
            buckets = [self._existing(limit_key.policy, limit_key.key, now) for limit_key in keys]
            for limit_key, bucket in zip(keys, buckets, strict=True):
                decision = self._decision(bucket, limit_key.policy, now, slots=limit_key.slots)
                if not decision.allowed:
                    return Reservation(
                        keys,
                        denied_by=limit_key.policy,
                        retry_after=decision.retry_after,
                        exceeds_limit=decision.exceeds_limit,
                    )
            needed = Counter(
                limit_key.policy.scope
                for limit_key, bucket in zip(keys, buckets, strict=True)
                if bucket is None
            )
            full = {scope for scope, count in needed.items() if not self._has_room(scope, count, now)}
            tracked: list[LimitKey] = []
            untracked: list[LimitKey] = []
            for limit_key, bucket in zip(keys, buckets, strict=True):
                if bucket is None:
                    if limit_key.policy.scope in full:
                        untracked.append(limit_key)
                        continue
                    bucket = self._create(limit_key.policy, limit_key.key, now)
                bucket.in_flight += limit_key.slots
                tracked.append(limit_key)
            return Reservation(tuple(tracked), untracked=tuple(untracked))

    def settle(self, reservation: Reservation, *, counted: bool) -> Mapping[PolicyName, RateDecision]:
        if not reservation.granted:
            return {}
        now = self._now()
        decisions: dict[PolicyName, RateDecision] = {}
        with self._lock:
            for limit_key in reservation.keys:
                policy, key = limit_key.policy, limit_key.key
                # Only `reset` removes a bucket with a slot in flight; never go below zero.
                bucket = self._existing(policy, key, now)
                if bucket is None:
                    if not counted or not self._has_room(policy.scope, 1, now):
                        decisions[policy.name] = RateDecision(True, remaining=policy.limit)
                        continue
                    bucket = self._create(policy, key, now)  # the slots were granted: record them
                bucket.in_flight = max(0, bucket.in_flight - limit_key.slots)
                started = False
                if counted:
                    for _ in range(limit_key.slots):
                        started = self._record(policy, key, bucket, now) or started
                decision = self._decision(bucket, policy, now, include_in_flight=False)
                decisions[policy.name] = RateDecision(
                    decision.allowed, decision.retry_after, decision.remaining, started
                )
                self._drop_if_idle(policy, key, bucket, now)
        return decisions

    def clear(self, policy: RatePolicy, key: str) -> None:
        with self._lock:
            table = self._tables.get(policy.name)
            bucket = table.get(key) if table is not None else None
            if bucket is None:
                return
            if bucket.in_flight:
                # Keep the slots of attempts still in flight; forget only what was recorded.
                bucket.hits.clear()
                bucket.blocked_until = 0.0
            else:
                self._drop(policy.name, key)

    def reset(self) -> None:
        with self._lock:
            self._tables.clear()
            self._counts.clear()
            self._last_sweep = -math.inf
            self._last_capacity_warning.clear()

    def stats(self) -> LimiterStats:
        with self._lock:
            return LimiterStats(
                buckets=sum(len(table) for table in self._tables.values()),
                network_buckets=self._counts[BucketScope.NETWORK],
                email_buckets=self._counts[BucketScope.EMAIL],
            )


class DisabledRateLimiter:
    """Used when RATE_LIMIT_ENABLED=false (refused in production)."""

    def check(self, policy: RatePolicy, key: str) -> RateDecision:
        return RateDecision(True, remaining=policy.limit)

    def hit(self, policy: RatePolicy, key: str) -> RateDecision:
        return RateDecision(True, remaining=policy.limit)

    def reserve(self, keys: Sequence[LimitKey]) -> Reservation:
        return Reservation(_unique_policies(keys))

    def settle(self, reservation: Reservation, *, counted: bool) -> Mapping[PolicyName, RateDecision]:
        return {
            limit_key.policy.name: RateDecision(True, remaining=limit_key.policy.limit)
            for limit_key in reservation.keys
        }

    def clear(self, policy: RatePolicy, key: str) -> None:
        return None

    def reset(self) -> None:
        return None


def create_rate_limiter(settings: Settings) -> RateLimiter:
    if not settings.rate_limit_enabled:
        return DisabledRateLimiter()
    return InMemoryRateLimiter(
        max_network_buckets=settings.rate_limit_max_network_buckets,
        max_email_buckets=settings.rate_limit_max_email_buckets,
    )
