"""Query-parameter models (contract §8) and the error envelope schema."""

from datetime import date

import pytest
from pydantic import ValidationError

from app.core.errors import error_body
from app.models import Role, VisitStatus
from app.schemas.audit import AuditLogQuery
from app.schemas.common import (
    DATE_OUT_OF_RANGE,
    MULTI_VALUE_MAX_LENGTH,
    SEARCH_MAX_LENGTH,
    ErrorEnvelope,
    PageQuery,
)
from app.schemas.reports import REPORT_MAX_DAYS, ReportSummaryQuery
from app.schemas.users import UserListQuery
from app.schemas.visits import VisitListQuery


def _errors(model: type, **values: object) -> dict[str, str]:
    with pytest.raises(ValidationError) as caught:
        model.model_validate(values)
    return {".".join(str(part) for part in error["loc"]): error["msg"] for error in caught.value.errors()}


def test_multi_value_filters_accept_commas_and_repeated_parameters() -> None:
    assert VisitListQuery.model_validate({"status": "SCHEDULED, CHECKED_IN,SCHEDULED"}).status == [
        VisitStatus.SCHEDULED,
        VisitStatus.CHECKED_IN,
    ]
    # FastAPI hands a repeated parameter over as a list.
    assert VisitListQuery.model_validate({"status": ["NO_SHOW", "CANCELLED,NO_SHOW"]}).status == [
        VisitStatus.NO_SHOW,
        VisitStatus.CANCELLED,
    ]
    assert VisitListQuery.model_validate({"status": " , "}).status == []
    assert VisitListQuery().status == [] and UserListQuery().role == []


def test_unknown_filter_value_lists_the_allowed_values_without_echoing_input() -> None:
    errors = _errors(UserListQuery, role="EMPLOYEE,JANITOR")
    assert errors == {
        "role": "Value error, Choose one of: 'SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST' or 'MANAGEMENT'."
    }
    assert "JANITOR" not in str(errors)


def test_multi_value_filters_have_a_size_cap() -> None:
    errors = _errors(VisitListQuery, status="SCHEDULED," * (MULTI_VALUE_MAX_LENGTH // 10 + 1))
    assert errors == {"status": f"Value error, Enter at most {MULTI_VALUE_MAX_LENGTH} characters."}


def test_search_text_is_trimmed_bounded_and_free_of_control_characters() -> None:
    assert UserListQuery.model_validate({"q": "  Ann  "}).q == "Ann"
    assert UserListQuery.model_validate({"q": "   "}).q is None
    # Invisible characters around pasted text are trimmed too; nothing visible means no filter (L-BE-1).
    zwsp, bom = "\N{ZERO WIDTH SPACE}", "\N{ZERO WIDTH NO-BREAK SPACE}"
    assert UserListQuery.model_validate({"q": f"{zwsp}Ann{bom}"}).q == "Ann"
    assert VisitListQuery.model_validate({"q": f" {zwsp}{bom} "}).q is None
    assert set(_errors(UserListQuery, q="x" * (SEARCH_MAX_LENGTH + 1))) == {"q"}
    # Rejected, not silently trimmed away (str.strip() would drop U+001F).
    assert _errors(UserListQuery, q="\x1fAnn") == {"q": "Value error, Remove unsupported control characters."}


def test_unknown_query_parameters_are_rejected() -> None:
    assert _errors(VisitListQuery, sort="asc") == {"sort": "Extra inputs are not permitted"}


def test_pages_are_bounded() -> None:
    assert PageQuery().page == 1 and PageQuery().page_size == 25
    assert set(_errors(PageQuery, page=0, page_size=101)) == {"page", "page_size"}


def test_date_ranges_must_be_ordered() -> None:
    assert _errors(VisitListQuery, date_from="2026-10-05", date_to="2026-10-04") == {
        "date_to": "Value error, The end date must not be before the start date."
    }
    open_ended = AuditLogQuery.model_validate({"date_to": "2026-10-04"})
    assert open_ended.date_from is None and open_ended.date_to == date(2026, 10, 4)


def test_report_range_is_limited() -> None:
    start = date(2025, 1, 1)
    longest = date.fromordinal(start.toordinal() + REPORT_MAX_DAYS - 1)
    assert ReportSummaryQuery(date_from=start, date_to=longest).date_to == longest
    too_long = date.fromordinal(longest.toordinal() + 1)
    assert _errors(ReportSummaryQuery, date_from=start.isoformat(), date_to=too_long.isoformat()) == {
        "date_to": f"Value error, Choose a range of at most {REPORT_MAX_DAYS} days."
    }


@pytest.mark.parametrize(
    ("field", "value", "valid"),
    [
        ("action", "USER_UPDATED", True),
        ("action", "user updated", False),
        ("entity_type", "user", True),
        ("entity_type", "USER", False),
    ],
)
def test_audit_filters_have_the_shape_of_stored_values(field: str, value: str, valid: bool) -> None:
    if valid:
        assert getattr(AuditLogQuery.model_validate({field: value}), field) == value
    else:
        assert set(_errors(AuditLogQuery, **{field: value})) == {field}


def test_role_filter_values_are_roles() -> None:
    assert UserListQuery.model_validate({"role": "MANAGEMENT"}).role == [Role.MANAGEMENT]


def test_error_envelope_describes_every_error_body() -> None:
    body = error_body("VALIDATION_ERROR", "Please correct the highlighted fields.", {"fields": {"q": "x"}})
    assert ErrorEnvelope.model_validate(body).model_dump(mode="json") == body


@pytest.mark.parametrize("model", [VisitListQuery, ReportSummaryQuery, AuditLogQuery])
@pytest.mark.parametrize("value", ["0001-01-01", "1899-12-31", "9999-12-31"])
def test_dates_outside_the_supported_range_are_field_errors(model: type, value: str) -> None:
    # The services turn a date into the UTC bounds of that day and the next: at the ends of Python's
    # calendar that overflows.
    for field in ("date_from", "date_to"):
        assert _errors(model, **{field: value}) == {field: f"Value error, {DATE_OUT_OF_RANGE}"}


def test_dates_at_the_ends_of_the_supported_range_are_accepted() -> None:
    for model in (VisitListQuery, AuditLogQuery):
        query = model.model_validate({"date_from": "1900-01-01", "date_to": "9998-12-31"})
        assert (query.date_from, query.date_to) == (date(1900, 1, 1), date(9998, 12, 31))
