"""Pure rules of reception and reports: walk-in times and reasons, corrected and bulk check-out times,
report ranges, company-local date filters, and MANUAL check-in through the scan evaluation."""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from app.core.errors import ValidationFailed
from app.core.time import company_date_filter_bounds
from app.models import Visit
from app.schemas.visits import WalkInCreate
from app.services import visit_rules
from app.services.attendance import (
    CHECK_OUT_BEFORE_CHECK_IN,
    CHECK_OUT_IN_FUTURE,
    EXPECTED_END_NOT_IN_FUTURE,
    bulk_check_out_time,
    corrected_check_out_problems,
    walk_in_end_problems,
    walk_in_reason_fields,
)
from app.services.reports import RANGE_TOO_LONG, report_range
from app.services.scan import ScanOutcome, ScanSubject, evaluate_scan

NOW = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)  # 09:00 in Amman


def _walk_in(reason: str, note: str | None = None) -> WalkInCreate:
    body: dict = {
        "visitor": {"full_name": "Guest"},
        "host_id": str(uuid.uuid4()),
        "purpose": "Visit",
        "expected_end": (NOW + timedelta(hours=1)).isoformat(),
        "reason": reason,
    }
    if note is not None:
        body["reason_note"] = note
    return WalkInCreate.model_validate(body)


@pytest.mark.parametrize(
    ("expected_end", "problems"),
    [
        (NOW + timedelta(minutes=1), {}),
        (NOW + timedelta(hours=24), {}),
        (NOW, {"expected_end": EXPECTED_END_NOT_IN_FUTURE}),
        (NOW - timedelta(hours=1), {"expected_end": EXPECTED_END_NOT_IN_FUTURE}),
        (NOW + timedelta(hours=24, seconds=1), {"expected_end": visit_rules.TOO_LONG}),
    ],
)
def test_walk_in_expected_end(expected_end: datetime, problems: dict) -> None:
    assert walk_in_end_problems(expected_end, now=NOW) == problems
    assert visit_rules.TOO_LONG.message == "A visit can last at most 24 hours."
    assert visit_rules.TOO_LONG.detail() == {"code": "visit_too_long", "params": {"max_hours": 24}}


@pytest.mark.parametrize(
    ("reason", "note", "fields"),
    [
        ("NO_INVITATION", None, ("NO_INVITATION", None)),
        ("LOST_PASS", "Phone at the hotel", ("LOST_PASS", "Phone at the hotel")),
        # Always the code (a note equal to a code stays a note), so the column groups by reason.
        ("OTHER", "Contractor", ("OTHER", "Contractor")),
        ("OTHER", "DELIVERY", ("OTHER", "DELIVERY")),
    ],
)
def test_walk_in_reason_fields(reason: str, note: str | None, fields: tuple) -> None:
    assert walk_in_reason_fields(_walk_in(reason, note)) == fields


def test_corrected_check_out_time_lies_between_check_in_and_now() -> None:
    check_in_at = NOW - timedelta(hours=2)
    assert corrected_check_out_problems(check_in_at, check_in_at, now=NOW) is None
    assert corrected_check_out_problems(check_in_at, NOW, now=NOW) is None
    assert corrected_check_out_problems(check_in_at, check_in_at - timedelta(seconds=1), now=NOW) == (
        CHECK_OUT_BEFORE_CHECK_IN
    )
    assert (
        corrected_check_out_problems(check_in_at, NOW + timedelta(seconds=1), now=NOW) == CHECK_OUT_IN_FUTURE
    )


def _checked_in(check_in_at: datetime, scheduled_end: datetime) -> Visit:
    return Visit(status="CHECKED_IN", check_in_at=check_in_at, scheduled_end=scheduled_end)


def test_bulk_check_out_time_is_the_scheduled_end_but_never_before_the_check_in() -> None:
    """§8 `max(check_in_at, scheduled_end)`: the bulk action only takes visits whose end has passed
    (B57-71), so the result is never in the future."""
    yesterday = NOW - timedelta(days=1)
    assert bulk_check_out_time(_checked_in(yesterday, yesterday + timedelta(hours=1))) == (
        yesterday + timedelta(hours=1)
    )
    late = _checked_in(yesterday + timedelta(hours=3), yesterday + timedelta(hours=1))
    assert bulk_check_out_time(late) == yesterday + timedelta(hours=3)
    with pytest.raises(ValueError, match="checked-in"):
        bulk_check_out_time(Visit(status="SCHEDULED", scheduled_end=NOW))


TODAY = date(2026, 10, 5)


@pytest.mark.parametrize(
    ("date_from", "date_to", "expected"),
    [
        (None, None, (date(2026, 9, 6), TODAY)),
        (date(2026, 10, 1), date(2026, 10, 3), (date(2026, 10, 1), date(2026, 10, 3))),
        (None, date(2026, 8, 31), (date(2026, 8, 2), date(2026, 8, 31))),
        (date(2026, 9, 20), None, (date(2026, 9, 20), TODAY)),
        (date(2025, 1, 1), None, (date(2025, 1, 1), date(2026, 1, 1))),  # capped at 366 days
        (date(2026, 12, 1), None, (date(2026, 12, 1), date(2026, 12, 1))),  # a start in the future
        (date(2028, 1, 1), date(2028, 12, 31), (date(2028, 1, 1), date(2028, 12, 31))),  # leap year: 366
    ],
)
def test_report_range(date_from: date | None, date_to: date | None, expected: tuple[date, date]) -> None:
    assert report_range(date_from, date_to, today=TODAY) == expected


def test_report_range_longer_than_366_days_is_refused() -> None:
    with pytest.raises(ValidationFailed) as refused:
        report_range(date(2025, 1, 1), date(2026, 1, 2), today=TODAY)
    assert refused.value.fields == {"date_to": RANGE_TOO_LONG}


def test_company_date_filter_bounds_around_midnight() -> None:
    start, end = company_date_filter_bounds(date(2026, 10, 5), date(2026, 10, 6), "Asia/Amman")
    assert start == datetime(2026, 10, 4, 21, 0, tzinfo=UTC) and end == datetime(
        2026, 10, 6, 21, 0, tzinfo=UTC
    )
    assert company_date_filter_bounds(None, None, "Asia/Amman") == (None, None)
    assert company_date_filter_bounds(date(2026, 10, 5), None, "UTC") == (
        datetime(2026, 10, 5, tzinfo=UTC),
        None,
    )
    # A DST day is 23 hours long: the bounds follow the zone, not a fixed 24 hours.
    spring_start, spring_end = company_date_filter_bounds(
        date(2026, 3, 8), date(2026, 3, 8), "America/New_York"
    )
    assert spring_end - spring_start == timedelta(hours=23)


def _subject(status: str, *, revoked: str | None = None, host_active: bool = True) -> ScanSubject:
    start = NOW + timedelta(minutes=30)
    return ScanSubject(
        visit_status=status,
        pass_revoke_reason=revoked,
        host_active=host_active,
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=1),
        window_start=start - timedelta(hours=1),
        window_end=start + timedelta(hours=2),
    )


def test_manual_check_in_is_the_scan_evaluation_without_a_pass() -> None:
    """MANUAL check-in judges the visit itself: a replaced pass (row 6) does not stand in the way, which
    is exactly the case MANUAL exists for."""
    visit = Visit(
        status="SCHEDULED",
        scheduled_start=NOW,
        scheduled_end=NOW + timedelta(hours=1),
        window_start=NOW - timedelta(hours=1),
        window_end=NOW + timedelta(hours=2),
    )
    assert ScanSubject.of(visit, None, host_active=True).pass_revoke_reason is None
    replaced = _subject("SCHEDULED", revoked="ROTATED")
    assert evaluate_scan(replaced, now=NOW, timezone="Asia/Amman").outcome is ScanOutcome.PASS_REVOKED
    assert evaluate_scan(_subject("SCHEDULED"), now=NOW, timezone="Asia/Amman").outcome is ScanOutcome.READY
