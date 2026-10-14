"""Aggregates for GET /reports/summary (contract §8.1 `ReportSummary`), always for one company.

A report covers the visits whose `scheduled_start` lies in `[start, end)` (a walk-in's schedule starts
at its check-in). Calendar days and hours are taken in the company's timezone with PostgreSQL's
`AT TIME ZONE`, inside a subquery so the grouping expression carries no bound parameter of its own.

Two statements read the range, whatever its length (up to 366 days, a year of visits): `totals` (one
pass over the range for the counters, one for the distinct visitors, counted through a hash of their IDs
rather than `count(DISTINCT …)`, whose sort spilled to disk at the default `work_mem` on a year of
visits), and `breakdowns`, which counts visits per day, check-ins per hour, visits per department and per
host in a single pass (`GROUPING SETS`) and ranks the hosts in SQL, so the ordering of ties by name is
PostgreSQL's `lower()`, as before. They replace five separate passes over the same range.
"""

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Date,
    DateTime,
    Integer,
    and_,
    case,
    cast,
    extract,
    func,
    literal,
    or_,
    select,
)
from sqlalchemy.orm import QueryableAttribute, Session, aliased
from sqlalchemy.sql.elements import BinaryExpression

from app.models import CheckOutMethod, Department, User, Visit, VisitStatus

# Check-outs whose time was not observed: a corrected time or the end-of-day bulk check-out (§5).
UNOBSERVED_CHECK_OUTS = (CheckOutMethod.CORRECTED.value, CheckOutMethod.BULK.value)


@dataclass(frozen=True, slots=True)
class ReportTotalsRow:
    visits: int
    unique_visitors: int  # distinct visitors among the visits that were checked in
    checked_in: int  # visits that were checked in (still inside or checked out since)
    checked_out: int
    no_show: int
    cancelled: int
    walk_ins: int
    settled: int  # visits that reached a final or checked-in state (no longer SCHEDULED)
    avg_duration_seconds: float | None  # observed check-outs only


@dataclass(frozen=True, slots=True)
class DepartmentCountRow:
    department_id: UUID | None
    name: str | None  # None: the visits without a department
    name_ar: str | None  # the department's Arabic name, None without one
    count: int


@dataclass(frozen=True, slots=True)
class HostCountRow:
    host_id: UUID
    full_name: str
    count: int


@dataclass(frozen=True, slots=True)
class ReportBreakdowns:
    visits_per_day: dict[date, int] = field(default_factory=dict)  # company-local dates with visits
    check_ins_by_hour: dict[int, int] = field(default_factory=dict)  # company-local hours with check-ins
    by_department: list[DepartmentCountRow] = field(default_factory=list)  # most visits first
    top_hosts: list[HostCountRow] = field(default_factory=list)  # most visits first, at most `top_hosts`


# The dimension of a `breakdowns` row: the grouping set it belongs to.
_DAY, _HOUR, _DEPARTMENT, _HOST = "day", "hour", "department", "host"


def _local(
    column: QueryableAttribute[datetime] | QueryableAttribute[datetime | None], timezone: str
) -> BinaryExpression[datetime]:
    """`column AT TIME ZONE :timezone`: the wall-clock time in the company's timezone (timestamp without
    time zone)."""
    return column.op("AT TIME ZONE", return_type=DateTime())(timezone)


class ReportRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    @staticmethod
    def _in_range(
        company_id: UUID, start: datetime, end: datetime, visit: type[Visit] = Visit
    ) -> list[ColumnElement[bool]]:
        return [visit.company_id == company_id, visit.scheduled_start >= start, visit.scheduled_start < end]

    def totals(self, company_id: UUID, *, start: datetime, end: datetime) -> ReportTotalsRow:
        status = Visit.status
        checked_in = Visit.check_in_at.is_not(None)
        observed = and_(
            status == VisitStatus.CHECKED_OUT.value, Visit.check_out_method.not_in(UNOBSERVED_CHECK_OUTS)
        )
        # The distinct visitors who came, counted from the set of their IDs (a hash aggregate). An alias,
        # so the subquery is not correlated to the outer query's visits.
        came = aliased(Visit)
        visitors_who_came = (
            select(came.visitor_id)
            .where(*self._in_range(company_id, start, end, came), came.check_in_at.is_not(None))
            .distinct()
            .subquery()
        )
        statement = select(
            func.count(),
            select(func.count()).select_from(visitors_who_came).scalar_subquery(),
            func.count().filter(checked_in),
            func.count().filter(status == VisitStatus.CHECKED_OUT.value),
            func.count().filter(status == VisitStatus.NO_SHOW.value),
            func.count().filter(status == VisitStatus.CANCELLED.value),
            func.count().filter(Visit.is_walk_in.is_(True)),
            func.count().filter(status != VisitStatus.SCHEDULED.value),
            func.avg(extract("epoch", Visit.check_out_at - Visit.check_in_at)).filter(observed),
        ).where(*self._in_range(company_id, start, end))
        row = self.db.execute(statement).one()
        counts = [int(value or 0) for value in row[:8]]
        average: Decimal | float | None = row[8]
        return ReportTotalsRow(
            visits=counts[0],
            unique_visitors=counts[1],
            checked_in=counts[2],
            checked_out=counts[3],
            no_show=counts[4],
            cancelled=counts[5],
            walk_ins=counts[6],
            settled=counts[7],
            avg_duration_seconds=float(average) if average is not None else None,
        )

    def breakdowns(
        self, company_id: UUID, *, start: datetime, end: datetime, timezone: str, top_hosts: int
    ) -> ReportBreakdowns:
        """Visits per company-local day, check-ins per company-local hour, visits per department and the
        `top_hosts` hosts with the most visits, in one pass over the range.

        Departments and hosts are named by their current names; departments are ordered by visits, then
        name (the visits without a department last among equals), then ID; hosts by visits, then name,
        then ID."""
        in_range = (
            select(
                cast(_local(Visit.scheduled_start, timezone), Date).label("day"),
                cast(extract("hour", _local(Visit.check_in_at, timezone)), Integer).label("hour"),
                Visit.department_id,
                Visit.host_id,
            )
            .where(*self._in_range(company_id, start, end))
            .subquery("in_range")
        )
        dimension = case(
            (func.grouping(in_range.c.day) == 0, literal(_DAY)),
            (func.grouping(in_range.c.hour) == 0, literal(_HOUR)),
            (func.grouping(in_range.c.department_id) == 0, literal(_DEPARTMENT)),
            else_=literal(_HOST),
        )
        grouped = (
            select(
                dimension.label("dimension"),
                in_range.c.day,
                in_range.c.hour,
                in_range.c.department_id,
                in_range.c.host_id,
                func.count().label("visits"),
            )
            .group_by(
                func.grouping_sets(
                    in_range.c.day, in_range.c.hour, in_range.c.department_id, in_range.c.host_id
                )
            )
            .subquery("grouped")
        )
        name = func.coalesce(Department.name, User.full_name)
        ranked = (
            select(
                grouped,
                Department.name.label("department_name"),
                Department.name_ar.label("department_name_ar"),
                User.full_name.label("host_name"),
                func.row_number()
                .over(
                    partition_by=grouped.c.dimension,
                    order_by=(
                        grouped.c.visits.desc(),
                        func.lower(name).nulls_last(),
                        grouped.c.department_id,
                        grouped.c.host_id,
                    ),
                )
                .label("rank"),
            )
            .outerjoin(
                Department,
                and_(Department.company_id == company_id, Department.id == grouped.c.department_id),
            )
            .outerjoin(User, and_(User.company_id == company_id, User.id == grouped.c.host_id))
            .subquery("ranked")
        )
        statement = (
            select(ranked)
            .where(or_(ranked.c.dimension != _HOST, ranked.c.rank <= top_hosts))
            .order_by(ranked.c.dimension, ranked.c.rank)
        )
        result = ReportBreakdowns()
        for row in self.db.execute(statement).mappings():
            visits = int(row["visits"])
            match row["dimension"]:
                case "day":
                    result.visits_per_day[row["day"]] = visits
                case "hour" if row["hour"] is not None:  # the NULL group: visits never checked in
                    result.check_ins_by_hour[int(row["hour"])] = visits
                case "department":
                    result.by_department.append(
                        DepartmentCountRow(
                            row["department_id"], row["department_name"], row["department_name_ar"], visits
                        )
                    )
                case "host" if row["host_name"] is not None:  # a visit's host always exists (FK)
                    result.top_hosts.append(HostCountRow(row["host_id"], row["host_name"], visits))
        return result
