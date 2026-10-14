"""Pure visit rules: the state machine (full matrix), D-14 scheduling, derived flags, permissions."""

import itertools
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.errors import InvalidStateTransition, VisitAlreadyCheckedIn, VisitNotCheckedIn
from app.models.enums import CheckInMethod, CheckOutMethod, Role, VisitStatus
from app.services import visit_rules
from app.services.visit_rules import Caller, assert_transition

S, CI, CO, CA, NS = (
    VisitStatus.SCHEDULED,
    VisitStatus.CHECKED_IN,
    VisitStatus.CHECKED_OUT,
    VisitStatus.CANCELLED,
    VisitStatus.NO_SHOW,
)

# The contract §5 matrix: (from, to, method) that are allowed. Everything else is refused.
ALLOWED = {
    (S, CI, CheckInMethod.QR),
    (S, CI, CheckInMethod.MANUAL),
    (S, CI, CheckInMethod.OVERRIDE),
    (S, CA, None),
    (S, NS, None),
    (NS, CI, CheckInMethod.OVERRIDE),
    (CI, CO, CheckOutMethod.QR),
    (CI, CO, CheckOutMethod.MANUAL),
    (CI, CO, CheckOutMethod.CORRECTED),
    (CI, CO, CheckOutMethod.BULK),
}


def _methods_for(target: VisitStatus) -> list:
    if target is CI:
        return list(CheckInMethod)
    if target is CO:
        return list(CheckOutMethod)
    return [None]


MATRIX = [
    (current, target, method)
    for current, target in itertools.product(VisitStatus, VisitStatus)
    for method in _methods_for(target)
]


@pytest.mark.parametrize(("current", "target", "method"), MATRIX, ids=str)
def test_full_transition_matrix(current: VisitStatus, target: VisitStatus, method) -> None:
    if (current, target, method) in ALLOWED:
        assert_transition(current, target, method=method)
        return
    if target is CI and current is CI:
        expected: type[Exception] = VisitAlreadyCheckedIn
    elif target is CO and current is not CI:
        expected = VisitNotCheckedIn
    else:
        expected = InvalidStateTransition
    with pytest.raises(expected):
        assert_transition(current, target, method=method)


def test_matrix_covers_every_pair() -> None:
    assert len({(current, target) for current, target, _ in MATRIX}) == len(VisitStatus) ** 2
    assert ALLOWED.issubset(MATRIX)


def test_walk_in_is_not_a_transition() -> None:
    with pytest.raises(InvalidStateTransition):
        assert_transition(S, CI, method=CheckInMethod.WALK_IN)


@pytest.mark.parametrize(
    ("target", "method"),
    [(CI, None), (CI, CheckOutMethod.QR), (CO, CheckInMethod.QR), (CO, None), (CA, CheckInMethod.MANUAL)],
)
def test_a_method_of_the_wrong_kind_is_a_programming_error(target: VisitStatus, method) -> None:
    with pytest.raises(ValueError, match="does not apply"):
        assert_transition(S, target, method=method)


def test_stored_status_strings_are_accepted() -> None:
    assert_transition("SCHEDULED", VisitStatus.CANCELLED)
    with pytest.raises(InvalidStateTransition):
        assert_transition("CANCELLED", VisitStatus.CANCELLED)


# ---- scheduling ---------------------------------------------------------------------------------

NOW = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (NOW + timedelta(hours=1), NOW + timedelta(hours=2), {}),
        (NOW - timedelta(minutes=5), NOW + timedelta(hours=1), {}),  # tolerance boundary
        (NOW + timedelta(hours=1), NOW + timedelta(hours=25), {}),  # exactly 24 hours
        (NOW + timedelta(days=365), NOW + timedelta(days=365, hours=1), {}),
        (
            NOW + timedelta(hours=1),
            NOW + timedelta(hours=1),
            {"scheduled_end": visit_rules.END_NOT_AFTER_START},
        ),
        (
            NOW + timedelta(hours=2),
            NOW + timedelta(hours=1),
            {"scheduled_end": visit_rules.END_NOT_AFTER_START},
        ),
        (
            NOW + timedelta(hours=1),
            NOW + timedelta(hours=25, seconds=1),
            {"scheduled_end": visit_rules.TOO_LONG},
        ),
        (
            NOW - timedelta(minutes=5, seconds=1),
            NOW + timedelta(hours=1),
            {"scheduled_start": visit_rules.START_IN_PAST},
        ),
        (
            NOW + timedelta(days=365, seconds=1),
            NOW + timedelta(days=365, hours=1),
            {"scheduled_start": visit_rules.TOO_FAR_AHEAD},
        ),
        (
            NOW - timedelta(hours=3),
            NOW - timedelta(hours=1),
            {"scheduled_start": visit_rules.START_IN_PAST, "scheduled_end": visit_rules.END_IN_PAST},
        ),
    ],
)
def test_schedule_problems(start: datetime, end: datetime, expected: dict[str, str]) -> None:
    assert visit_rules.schedule_problems(start, end, now=NOW) == expected


def test_keeping_the_start_skips_the_start_rules() -> None:
    started = NOW - timedelta(hours=1)
    assert visit_rules.schedule_problems(started, NOW + timedelta(hours=1), now=NOW, check_start=False) == {}
    assert visit_rules.schedule_problems(started, NOW - timedelta(minutes=1), now=NOW, check_start=False) == {
        "scheduled_end": visit_rules.END_IN_PAST
    }


def test_visit_window() -> None:
    start, end = NOW, NOW + timedelta(hours=1)
    assert visit_rules.visit_window(start, end, grace_before_minutes=60, grace_after_minutes=30) == (
        NOW - timedelta(hours=1),
        NOW + timedelta(minutes=90),
    )
    assert visit_rules.visit_window(start, end, grace_before_minutes=0, grace_after_minutes=0) == (start, end)


def test_no_show_deadline_is_strictly_after_the_window() -> None:
    assert not visit_rules.window_ended(NOW, NOW)
    assert visit_rules.window_ended(NOW, NOW + timedelta(microseconds=1))


# ---- derived flags ------------------------------------------------------------------------------


def test_overdue_stale_and_duration() -> None:
    end = NOW + timedelta(hours=1)
    assert visit_rules.is_overdue("CHECKED_IN", end, end + timedelta(seconds=1))
    assert not visit_rules.is_overdue("CHECKED_IN", end, end)
    assert not visit_rules.is_overdue("SCHEDULED", end, end + timedelta(hours=1))
    # Company-local today in Asia/Amman (UTC+3) starts at 21:00 UTC the previous evening.
    assert not visit_rules.is_stale("CHECKED_IN", datetime(2026, 10, 4, 21, 0, tzinfo=UTC), NOW, "Asia/Amman")
    assert visit_rules.is_stale("CHECKED_IN", datetime(2026, 10, 4, 20, 59, tzinfo=UTC), NOW, "Asia/Amman")
    assert not visit_rules.is_stale("CHECKED_OUT", datetime(2026, 10, 1, tzinfo=UTC), NOW, "Asia/Amman")
    assert visit_rules.duration_seconds(NOW, NOW + timedelta(minutes=97)) == 97 * 60
    assert visit_rules.duration_seconds(NOW, None) is None


@pytest.mark.parametrize(
    ("revoked", "issued", "status", "now_offset", "expected"),
    [
        (False, False, "SCHEDULED", 0, "NONE"),
        (True, True, "CANCELLED", 0, "REVOKED"),
        (False, True, "SCHEDULED", 0, "ACTIVE"),
        (False, True, "SCHEDULED", 2, "EXPIRED"),
        (False, True, "NO_SHOW", 0, "EXPIRED"),
    ],
)
def test_pass_status(revoked: bool, issued: bool, status: str, now_offset: int, expected: str) -> None:
    window_end = NOW + timedelta(hours=1)
    assert (
        visit_rules.pass_status(
            revoked_at=NOW if revoked else None,
            issued=issued,
            visit_status=status,
            window_end=window_end,
            now=NOW + timedelta(hours=now_offset),
        )
        == expected
    )


# ---- permissions (§7.5) -------------------------------------------------------------------------

ME, OTHER = uuid.uuid4(), uuid.uuid4()


def _caller(*roles: Role) -> Caller:
    return Caller(user_id=ME, roles=frozenset(roles))


@pytest.mark.parametrize(
    ("roles", "host", "creator", "expected"),
    [
        ((Role.SYSTEM_ADMIN,), OTHER, OTHER, True),
        ((Role.EMPLOYEE,), ME, OTHER, True),
        ((Role.EMPLOYEE,), OTHER, ME, True),
        ((Role.EMPLOYEE,), OTHER, OTHER, False),
        ((Role.RECEPTIONIST,), ME, ME, False),  # not a host role: never an owner
        ((Role.MANAGEMENT,), ME, ME, False),
        ((Role.MANAGEMENT, Role.EMPLOYEE), OTHER, OTHER, False),
        ((Role.MANAGEMENT, Role.EMPLOYEE), ME, OTHER, True),
    ],
)
def test_can_manage_visit(roles, host, creator, expected: bool) -> None:
    assert visit_rules.can_manage_visit(_caller(*roles), host_id=host, created_by_id=creator) is expected


def _flags(
    caller: Caller, status: str = "SCHEDULED", *, now: datetime = NOW, host_active: bool = True, email=True
):
    return visit_rules.visit_permissions(
        caller,
        status=status,
        host_id=ME,
        created_by_id=ME,
        host_active=host_active,
        visitor_has_email=email,
        scheduled_start=NOW + timedelta(hours=1),
        window_start=NOW,
        window_end=NOW + timedelta(hours=3),
        day=visit_rules.CompanyDay.at(now, "Asia/Amman"),
    )


def test_visit_permission_flags() -> None:
    owner = _flags(_caller(Role.EMPLOYEE))
    assert (owner.can_edit, owner.can_cancel, owner.can_resend, owner.can_check_in) == (
        True,
        True,
        True,
        False,
    )
    assert _flags(_caller(Role.EMPLOYEE), email=False).can_resend is False
    assert not _flags(_caller(Role.EMPLOYEE), "CANCELLED").can_edit
    reception = _flags(_caller(Role.RECEPTIONIST))
    assert reception.can_check_in and not reception.can_edit and not reception.can_check_out
    assert _flags(_caller(Role.RECEPTIONIST), "CHECKED_IN").can_check_out
    assert not _flags(_caller(Role.RECEPTIONIST), host_active=False).can_check_in
    # NO_SHOW the same company-local day: an override check-in remains possible; the next day it is not.
    assert _flags(_caller(Role.RECEPTIONIST), "NO_SHOW", now=NOW + timedelta(hours=5)).can_check_in
    assert not _flags(_caller(Role.RECEPTIONIST), "NO_SHOW", now=NOW + timedelta(days=1)).can_check_in


def test_management_has_no_permission_flags() -> None:
    flags = _flags(_caller(Role.MANAGEMENT))
    assert not any(
        (flags.can_edit, flags.can_cancel, flags.can_resend, flags.can_check_in, flags.can_check_out)
    )
