"""The contract §6 scan table as a pure function: every row, its options and warnings, and the order in
which the rows apply when several conditions hold."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from app.services.scan import ScanOutcome, ScanSubject, evaluate_scan

TZ = "Asia/Amman"  # UTC+3
START = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)  # 10:00 local
SUBJECT = ScanSubject(
    visit_status="SCHEDULED",
    pass_revoke_reason=None,
    host_active=True,
    scheduled_start=START,
    scheduled_end=START + timedelta(hours=1),
    window_start=START - timedelta(hours=1),
    window_end=START + timedelta(hours=2),
)
IN_SCHEDULE = START + timedelta(minutes=10)
IN_WINDOW_EARLY = START - timedelta(minutes=30)
BEFORE_WINDOW_SAME_DAY = START - timedelta(hours=3)  # 07:00 local
AFTER_WINDOW_SAME_DAY = START + timedelta(hours=5)  # 15:00 local
NEXT_DAY = START + timedelta(days=1)
PREVIOUS_DAY = START - timedelta(days=1)


def _evaluate(now: datetime, **changes):
    return evaluate_scan(replace(SUBJECT, **changes), now=now, timezone=TZ)


def test_row_9_ready_inside_the_schedule() -> None:
    result = _evaluate(IN_SCHEDULE)
    assert (result.outcome, result.warnings, result.check_in_options) == (ScanOutcome.READY, (), ())
    assert result.succeeded


@pytest.mark.parametrize("now", [IN_WINDOW_EARLY, START + timedelta(hours=1, minutes=30)])
def test_row_9_warns_outside_the_scheduled_time(now: datetime) -> None:
    result = _evaluate(now)
    assert result.outcome is ScanOutcome.READY and result.warnings == ("OUTSIDE_SCHEDULED_TIME",)


@pytest.mark.parametrize("now", [SUBJECT.window_start, SUBJECT.window_end, SUBJECT.scheduled_start])
def test_window_and_schedule_bounds_are_inclusive(now: datetime) -> None:
    assert _evaluate(now).outcome is ScanOutcome.READY


def test_row_8_not_yet_valid() -> None:
    assert _evaluate(BEFORE_WINDOW_SAME_DAY).check_in_options == ("OVERRIDE",)
    result = _evaluate(PREVIOUS_DAY)
    assert result.outcome is ScanOutcome.PASS_NOT_YET_VALID and result.check_in_options == ()


def test_row_7_expired() -> None:
    late = _evaluate(AFTER_WINDOW_SAME_DAY)
    assert late.outcome is ScanOutcome.PASS_EXPIRED and late.check_in_options == ("OVERRIDE",)
    assert _evaluate(NEXT_DAY).check_in_options == ()
    no_show = _evaluate(IN_SCHEDULE, visit_status="NO_SHOW")
    assert no_show.outcome is ScanOutcome.PASS_EXPIRED and no_show.check_in_options == ("OVERRIDE",)


@pytest.mark.parametrize("reason", ["ROTATED", "VISITOR_EMAIL_CHANGED"])
def test_row_6_replaced_pass(reason: str) -> None:
    inside = _evaluate(IN_SCHEDULE, pass_revoke_reason=reason)
    assert inside.outcome is ScanOutcome.PASS_REVOKED and inside.check_in_options == ("MANUAL",)
    assert _evaluate(BEFORE_WINDOW_SAME_DAY, pass_revoke_reason=reason).check_in_options == ("OVERRIDE",)
    assert _evaluate(AFTER_WINDOW_SAME_DAY, pass_revoke_reason=reason).check_in_options == ("OVERRIDE",)
    assert _evaluate(NEXT_DAY, pass_revoke_reason=reason).check_in_options == ()


def test_row_5_host_inactive() -> None:
    result = _evaluate(IN_SCHEDULE, host_active=False)
    assert result.outcome is ScanOutcome.HOST_INACTIVE and result.check_in_options == ()


def test_row_4_already_checked_in() -> None:
    result = _evaluate(IN_SCHEDULE, visit_status="CHECKED_IN")
    assert result.outcome is ScanOutcome.ALREADY_CHECKED_IN and result.warnings == () and result.succeeded
    late = _evaluate(START + timedelta(hours=1, seconds=1), visit_status="CHECKED_IN")
    assert late.warnings == ("OVERSTAYED",)


def test_rows_2_and_3() -> None:
    assert _evaluate(IN_SCHEDULE, visit_status="CANCELLED").outcome is ScanOutcome.VISIT_CANCELLED
    assert _evaluate(IN_SCHEDULE, visit_status="CHECKED_OUT").outcome is ScanOutcome.VISIT_COMPLETED
    assert not _evaluate(IN_SCHEDULE, visit_status="CANCELLED").succeeded


@pytest.mark.parametrize(
    ("changes", "now", "expected"),
    [
        # Row 2 before everything: a cancelled visit's revoked pass with an inactive host.
        (
            {"visit_status": "CANCELLED", "pass_revoke_reason": "VISIT_CANCELLED", "host_active": False},
            IN_SCHEDULE,
            ScanOutcome.VISIT_CANCELLED,
        ),
        # Row 3 before row 4's question and before the host check.
        ({"visit_status": "CHECKED_OUT", "host_active": False}, IN_SCHEDULE, ScanOutcome.VISIT_COMPLETED),
        # Row 4: any pass of a checked-in visit, even a replaced one, at any time, with any host.
        (
            {"visit_status": "CHECKED_IN", "pass_revoke_reason": "ROTATED", "host_active": False},
            NEXT_DAY,
            ScanOutcome.ALREADY_CHECKED_IN,
        ),
        # Row 5 before row 6.
        ({"host_active": False, "pass_revoke_reason": "ROTATED"}, IN_SCHEDULE, ScanOutcome.HOST_INACTIVE),
        # Row 6 before rows 7 and 8 while SCHEDULED ...
        ({"pass_revoke_reason": "ROTATED"}, AFTER_WINDOW_SAME_DAY, ScanOutcome.PASS_REVOKED),
        ({"pass_revoke_reason": "ROTATED"}, PREVIOUS_DAY, ScanOutcome.PASS_REVOKED),
        # ... but a NO_SHOW visit's replaced pass is row 7.
        (
            {"visit_status": "NO_SHOW", "pass_revoke_reason": "ROTATED"},
            AFTER_WINDOW_SAME_DAY,
            ScanOutcome.PASS_EXPIRED,
        ),
    ],
)
def test_rows_apply_in_contract_order(changes: dict, now: datetime, expected: ScanOutcome) -> None:
    assert _evaluate(now, **changes).outcome is expected


def test_same_day_is_the_company_local_day() -> None:
    # 23:30 local on the visit day is 20:30 UTC: still the same day locally.
    late_evening = datetime(2026, 10, 5, 20, 30, tzinfo=UTC)
    assert _evaluate(late_evening).check_in_options == ("OVERRIDE",)
    # 00:30 local the next day is 21:30 UTC on the same UTC date: a different local day.
    after_midnight = datetime(2026, 10, 5, 21, 30, tzinfo=UTC)
    assert _evaluate(after_midnight).check_in_options == ()
