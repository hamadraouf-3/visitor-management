"""Management report (contract §8 GET /reports/summary, §8.1 `ReportSummary`; MANAGEMENT and
SYSTEM_ADMIN).

The range is a span of company-local dates, inclusive: by default the last 30 days up to today, at most
366 days. A report covers the visits scheduled to start in the range (a walk-in's schedule starts at its
check-in), whatever their status, after the NO_SHOW marking:
* totals: every visit; `unique_visitors` counts the distinct visitors among those checked in (people who
  actually came); `checked_in` the visits that were checked in (inside now or checked out since);
* no_show_rate: NO_SHOW visits over the visits that reached a final or checked-in state (every status
  but SCHEDULED), null while there are none;
* avg_duration_seconds: mean of `check_out_at - check_in_at` over checked-out visits, leaving out
  CORRECTED and BULK check-outs, whose time was not observed; null without any;
* visits_per_day: one entry per date of the range (0 for days without visits), by the company-local
  date of `scheduled_start`;
* by_department: visits per department under its current names, `name` and `name_ar` (B10-25; "No
  department" and no Arabic name for none), most first;
* top_hosts: the 10 hosts with the most visits, under their current names;
* check_ins_by_hour: hours 0-23 of `check_in_at` in the company's timezone.
"""

from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import ValidationFailed
from app.core.time import company_date_range_bounds, local_date
from app.repositories.reports import ReportRepository
from app.schemas.reports import (
    RANGE_TOO_LONG,
    REPORT_DEFAULT_DAYS,
    REPORT_MAX_DAYS,
    TOP_HOSTS,
    DepartmentCount,
    HostCount,
    HourCount,
    ReportSummary,
    ReportSummaryQuery,
    ReportTotals,
    VisitsPerDay,
)
from app.security.sessions import AuthContext
from app.services.no_shows import mark_no_shows_committed

NO_DEPARTMENT = "No department"


def report_range(date_from: date | None, date_to: date | None, *, today: date) -> tuple[date, date]:
    """The inclusive date range of a report. Without dates: the last REPORT_DEFAULT_DAYS days up to
    today. Only an end: the REPORT_DEFAULT_DAYS days up to it. Only a start: from it up to today (at
    most REPORT_MAX_DAYS days; a start in the future gives that one day)."""
    default_span = timedelta(days=REPORT_DEFAULT_DAYS - 1)
    if date_from is not None and date_to is not None:
        first, last = date_from, date_to
    elif date_from is not None:
        first = date_from
        last = max(date_from, min(today, date_from + timedelta(days=REPORT_MAX_DAYS - 1)))
    elif date_to is not None:
        first, last = date_to - default_span, date_to
    else:
        first, last = today - default_span, today
    if (last - first).days + 1 > REPORT_MAX_DAYS:
        raise ValidationFailed({"date_to": RANGE_TOO_LONG})
    return first, last


class ReportsService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.reports = ReportRepository(db)

    def summary(self, auth: AuthContext, query: ReportSummaryQuery) -> ReportSummary:
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        timezone = auth.user.company.timezone
        first, last = report_range(query.date_from, query.date_to, today=local_date(now, timezone))
        start, end = company_date_range_bounds(first, last, timezone)
        company_id = auth.company_id

        totals = self.reports.totals(company_id, start=start, end=end)
        breakdowns = self.reports.breakdowns(
            company_id, start=start, end=end, timezone=timezone, top_hosts=TOP_HOSTS
        )
        per_day, per_hour = breakdowns.visits_per_day, breakdowns.check_ins_by_hour
        days = [first + timedelta(days=offset) for offset in range((last - first).days + 1)]
        return ReportSummary(
            date_from=first,
            date_to=last,
            timezone=timezone,
            totals=ReportTotals(
                visits=totals.visits,
                unique_visitors=totals.unique_visitors,
                checked_in=totals.checked_in,
                checked_out=totals.checked_out,
                no_show=totals.no_show,
                cancelled=totals.cancelled,
                walk_ins=totals.walk_ins,
            ),
            no_show_rate=totals.no_show / totals.settled if totals.settled else None,
            avg_duration_seconds=(
                round(totals.avg_duration_seconds, 1) if totals.avg_duration_seconds is not None else None
            ),
            visits_per_day=[VisitsPerDay(date=day, count=per_day.get(day, 0)) for day in days],
            by_department=[
                DepartmentCount(
                    department_id=row.department_id,
                    name=row.name or NO_DEPARTMENT,
                    name_ar=row.name_ar,
                    count=row.count,
                )
                for row in breakdowns.by_department
            ],
            top_hosts=[
                HostCount(host_id=row.host_id, full_name=row.full_name, count=row.count)
                for row in breakdowns.top_hosts
            ],
            check_ins_by_hour=[HourCount(hour=hour, count=per_hour.get(hour, 0)) for hour in range(24)],
        )
