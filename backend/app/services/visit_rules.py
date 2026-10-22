"""Pure visit rules (contract §5, §6, §7.5, §8.1, D-14): no database, no clock of their own.

* `assert_transition` is the visit state machine. Services call it under the visit row lock.
* `schedule_problems` / `visit_window` are the scheduling rules.
* The flag and permission functions compute the derived fields of the §8.1 `Visit` for one caller.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import date, datetime, timedelta, tzinfo
from uuid import UUID

from app.core.errors import (
    InvalidStateTransition,
    VisitAlreadyCheckedIn,
    VisitNotCheckedIn,
)
from app.core.field_errors import FieldCode, FieldProblem
from app.core.policy import MAX_SCHEDULE_AHEAD, MAX_VISIT_DURATION, SCHEDULE_PAST_TOLERANCE
from app.core.time import as_zone, company_day_bounds, local_date
from app.models.enums import CheckInMethod, CheckOutMethod, PassRevokeReason, Role, VisitStatus
from app.schemas.common import PassStatus
from app.security.permissions import Capability, has_capability, is_visit_owner

# ---- state machine ------------------------------------------------------------------------------

type TransitionMethod = CheckInMethod | CheckOutMethod | None

# (from, to) -> the methods allowed for that transition; None = no method (system or owner action).
_ALLOWED: dict[tuple[VisitStatus, VisitStatus], frozenset[TransitionMethod]] = {
    (VisitStatus.SCHEDULED, VisitStatus.CHECKED_IN): frozenset(
        {CheckInMethod.QR, CheckInMethod.MANUAL, CheckInMethod.OVERRIDE}
    ),
    (VisitStatus.SCHEDULED, VisitStatus.CANCELLED): frozenset({None}),
    (VisitStatus.SCHEDULED, VisitStatus.NO_SHOW): frozenset({None}),
    # Same company-local day only; that rule needs the clock and is checked by the check-in service.
    (VisitStatus.NO_SHOW, VisitStatus.CHECKED_IN): frozenset({CheckInMethod.OVERRIDE}),
    (VisitStatus.CHECKED_IN, VisitStatus.CHECKED_OUT): frozenset(
        {CheckOutMethod.QR, CheckOutMethod.MANUAL, CheckOutMethod.CORRECTED, CheckOutMethod.BULK}
    ),
}


def _check_method_kind(target: VisitStatus, method: TransitionMethod) -> None:
    """A method of the wrong kind is a programming error, not a client error."""
    if target is VisitStatus.CHECKED_IN:
        valid = isinstance(method, CheckInMethod)
    elif target is VisitStatus.CHECKED_OUT:
        valid = isinstance(method, CheckOutMethod)
    else:
        valid = method is None
    if not valid:
        raise ValueError(f"method {method!r} does not apply to a transition to {target.value}")


def assert_transition(
    current: VisitStatus | str, target: VisitStatus, *, method: TransitionMethod = None
) -> None:
    """Raise unless `current → target` with `method` is allowed (contract §5).

    Allowed: SCHEDULED → CHECKED_IN (QR, MANUAL, OVERRIDE) | CANCELLED | NO_SHOW; NO_SHOW → CHECKED_IN
    (OVERRIDE only); CHECKED_IN → CHECKED_OUT (QR, MANUAL, CORRECTED, BULK). Everything else is
    409 INVALID_STATE_TRANSITION, except the cases §8.2 names: checking in a visit that is already
    checked in (VISIT_ALREADY_CHECKED_IN) and checking out one that is not (VISIT_NOT_CHECKED_IN).
    WALK_IN is not a transition: walk-ins are created checked in.
    """
    current = VisitStatus(current)
    _check_method_kind(target, method)
    if method in _ALLOWED.get((current, target), frozenset()):
        return
    if target is VisitStatus.CHECKED_IN and current is VisitStatus.CHECKED_IN:
        raise VisitAlreadyCheckedIn()
    if target is VisitStatus.CHECKED_OUT and current is not VisitStatus.CHECKED_IN:
        raise VisitNotCheckedIn()
    raise InvalidStateTransition()


# ---- scheduling (D-14) --------------------------------------------------------------------------

_MAX_HOURS = int(MAX_VISIT_DURATION.total_seconds() // 3600)
END_NOT_AFTER_START = FieldProblem(
    FieldCode.END_NOT_AFTER_START, "The end time must be after the start time."
)
TOO_LONG = FieldProblem(
    FieldCode.VISIT_TOO_LONG, f"A visit can last at most {_MAX_HOURS} hours.", {"max_hours": _MAX_HOURS}
)
END_IN_PAST = FieldProblem(FieldCode.END_IN_PAST, "The end time must not be in the past.")
START_IN_PAST = FieldProblem(FieldCode.START_IN_PAST, "The start time must not be in the past.")
TOO_FAR_AHEAD = FieldProblem(
    FieldCode.TOO_FAR_AHEAD,
    f"A visit can be scheduled at most {MAX_SCHEDULE_AHEAD.days} days ahead.",
    {"max_days": MAX_SCHEDULE_AHEAD.days},
)


def schedule_problems(
    start: datetime, end: datetime, *, now: datetime, check_start: bool = True
) -> dict[str, FieldProblem]:
    """Field errors of a visit schedule (D-14). `check_start=False` skips the start-time rules for a
    reschedule that keeps the current start: a visit already under way may still have its end moved."""
    problems: dict[str, FieldProblem] = {}
    if end <= start:
        problems["scheduled_end"] = END_NOT_AFTER_START
    elif end - start > MAX_VISIT_DURATION:
        problems["scheduled_end"] = TOO_LONG
    elif end < now:
        problems["scheduled_end"] = END_IN_PAST
    if check_start:
        if start < now - SCHEDULE_PAST_TOLERANCE:
            problems["scheduled_start"] = START_IN_PAST
        elif start > now + MAX_SCHEDULE_AHEAD:
            problems["scheduled_start"] = TOO_FAR_AHEAD
    return problems


def visit_window(
    start: datetime, end: datetime, *, grace_before_minutes: int, grace_after_minutes: int
) -> tuple[datetime, datetime]:
    """The pass validity window: the schedule widened by the company's current grace periods (§4)."""
    return start - timedelta(minutes=grace_before_minutes), end + timedelta(minutes=grace_after_minutes)


def window_ended(window_end: datetime, now: datetime) -> bool:
    """NO_SHOW deadline (contract §5): a SCHEDULED visit whose window ended before `now`."""
    return window_end < now


# ---- derived fields -----------------------------------------------------------------------------


def same_company_day(a: datetime, b: datetime, tz: str | tzinfo) -> bool:
    return local_date(a, tz) == local_date(b, tz)


@dataclass(frozen=True, slots=True)
class CompanyDay:
    """The company-local day of `now`, worked out once for every visit of a list."""

    now: datetime
    zone: tzinfo
    today: date
    start: datetime  # UTC

    @classmethod
    def at(cls, now: datetime, tz: str | tzinfo) -> CompanyDay:
        zone = as_zone(tz)
        today = local_date(now, zone)
        start, _ = company_day_bounds(today, zone)
        return cls(now=now, zone=zone, today=today, start=start)

    def is_today(self, instant: datetime) -> bool:
        """`same_company_day(now, instant, tz)`."""
        return local_date(instant, self.zone) == self.today

    def is_stale(self, status: str, check_in_at: datetime | None) -> bool:
        """Checked in before company-local today (the visitor never checked out on an earlier day)."""
        return status == VisitStatus.CHECKED_IN and check_in_at is not None and check_in_at < self.start


def is_overdue(status: str, scheduled_end: datetime, now: datetime) -> bool:
    return status == VisitStatus.CHECKED_IN and now > scheduled_end


def is_stale(status: str, check_in_at: datetime | None, now: datetime, tz: str | tzinfo) -> bool:
    """`CompanyDay.is_stale` for one visit."""
    if status != VisitStatus.CHECKED_IN or check_in_at is None:
        return False
    return CompanyDay.at(now, tz).is_stale(status, check_in_at)


def duration_seconds(check_in_at: datetime | None, check_out_at: datetime | None) -> int | None:
    if check_in_at is None or check_out_at is None:
        return None
    return int((check_out_at - check_in_at).total_seconds())


def pass_status(
    *,
    revoked_at: datetime | None,
    issued: bool,
    visit_status: str,
    window_end: datetime,
    now: datetime,
) -> PassStatus:
    """ACTIVE / REVOKED / EXPIRED / NONE for the visit's latest pass; validity comes from the window."""
    if not issued:
        return "NONE"
    if revoked_at is not None:
        return "REVOKED"
    if visit_status == VisitStatus.NO_SHOW or now > window_end:
        return "EXPIRED"
    return "ACTIVE"


REPLACED_PASS_REASONS = frozenset(
    {PassRevokeReason.ROTATED.value, PassRevokeReason.VISITOR_EMAIL_CHANGED.value}
)


# ---- permissions (contract §7.5) ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Caller:
    """The roles and identity a permission is decided for."""

    user_id: UUID
    roles: frozenset[Role]


def can_manage_visit(caller: Caller, *, host_id: UUID, created_by_id: UUID) -> bool:
    """Update / cancel / resend: administrators for any visit, hosts (EMPLOYEE) for visits they own."""
    if has_capability(caller.roles, Capability.MANAGE_ALL_VISITS):
        return True
    return has_capability(caller.roles, Capability.MANAGE_OWN_VISITS) and is_visit_owner(
        user_id=caller.user_id, roles=caller.roles, host_id=host_id, created_by_id=created_by_id
    )


def reads_all_visits(roles: Collection[Role]) -> bool:
    return has_capability(roles, Capability.READ_ALL_VISITS)


def may_edit_access_areas(caller: Caller, *, host_id: UUID) -> bool:
    """Who changes a visit's allowed areas (Phase 16, B16-2): an administrator or a receptionist
    (TRACK_VISITS), or the visit's host (EMPLOYEE) for their own visit. Management alone reads them."""
    if has_capability(caller.roles, Capability.TRACK_VISITS):
        return True
    return Role.EMPLOYEE in caller.roles and caller.user_id == host_id


def can_edit_access_areas(caller: Caller, *, status: str, host_id: UUID) -> bool:
    """`may_edit_access_areas`, while the visit is SCHEDULED or CHECKED_IN."""
    return status in (VisitStatus.SCHEDULED, VisitStatus.CHECKED_IN) and may_edit_access_areas(
        caller, host_id=host_id
    )


@dataclass(frozen=True, slots=True)
class VisitPermissionFlags:
    can_edit: bool
    can_cancel: bool
    can_resend: bool
    can_check_in: bool
    can_check_out: bool
    can_edit_access_areas: bool


def visit_permissions(
    caller: Caller,
    *,
    status: str,
    host_id: UUID,
    created_by_id: UUID,
    host_active: bool,  # §7.5: an active account still holding a host role
    visitor_has_email: bool,
    scheduled_start: datetime,
    window_start: datetime,
    window_end: datetime,
    day: CompanyDay,  # the company-local day of the instant decided for (`day.now`)
) -> VisitPermissionFlags:
    now = day.now
    scheduled = status == VisitStatus.SCHEDULED
    manageable = scheduled and can_manage_visit(caller, host_id=host_id, created_by_id=created_by_id)
    reception = has_capability(caller.roles, Capability.RECEPTION)
    inside_window = scheduled and window_start <= now <= window_end
    override_possible = status in (VisitStatus.SCHEDULED, VisitStatus.NO_SHOW) and day.is_today(
        scheduled_start
    )
    return VisitPermissionFlags(
        can_edit=manageable,
        can_cancel=manageable,
        can_resend=manageable and visitor_has_email,
        can_check_in=reception and host_active and (inside_window or override_possible),
        can_check_out=reception and status == VisitStatus.CHECKED_IN,
        can_edit_access_areas=can_edit_access_areas(caller, status=status, host_id=host_id),
    )
