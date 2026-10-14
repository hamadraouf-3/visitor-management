"""Report schemas (contract §8 /reports/summary, §8.1 `ReportSummary`)."""

from datetime import date
from typing import Annotated
from uuid import UUID

from pydantic import Field, ValidationInfo, field_validator

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.schemas.common import DateRangeQuery, ResponseModel

REPORT_MAX_DAYS = 366
REPORT_DEFAULT_DAYS = 30
TOP_HOSTS = 10
RANGE_TOO_LONG = FieldProblem(
    FieldCode.RANGE_TOO_LONG,
    f"Choose a range of at most {REPORT_MAX_DAYS} days.",
    {"max_days": REPORT_MAX_DAYS},
)


class ReportSummaryQuery(DateRangeQuery):
    """GET /reports/summary: company-local dates, inclusive. The service fills an open end (default: the
    last REPORT_DEFAULT_DAYS days) and applies the same REPORT_MAX_DAYS limit to the result."""

    @field_validator("date_to")
    @classmethod
    def _within_report_limit(cls, value: date | None, info: ValidationInfo) -> date | None:
        start = info.data.get("date_from")
        if value is not None and start is not None and (value - start).days + 1 > REPORT_MAX_DAYS:
            raise FieldValueError(RANGE_TOO_LONG)
        return value


class ReportTotals(ResponseModel):
    visits: int
    unique_visitors: int
    checked_in: int
    checked_out: int
    no_show: int
    cancelled: int
    walk_ins: int


class VisitsPerDay(ResponseModel):
    date: date  # company-local
    count: int


class DepartmentCount(ResponseModel):
    """`name` and `name_ar` are the department's current names (B10-25); a visit without a department
    counts under `department_id` null, "No department" and no Arabic name."""

    department_id: UUID | None
    name: str
    name_ar: str | None
    count: int


class HostCount(ResponseModel):
    host_id: UUID
    full_name: str
    count: int


class HourCount(ResponseModel):
    hour: Annotated[int, Field(ge=0, le=23)]  # company timezone
    count: int


class ReportSummary(ResponseModel):
    date_from: date
    date_to: date
    timezone: str
    totals: ReportTotals
    no_show_rate: float | None  # no_show / visits that reached a final or checked-in state
    avg_duration_seconds: float | None  # excludes CORRECTED and BULK check-outs
    visits_per_day: list[VisitsPerDay]
    by_department: list[DepartmentCount]
    top_hosts: list[HostCount]  # top TOP_HOSTS
    check_ins_by_hour: list[HourCount]  # hours 0..23
