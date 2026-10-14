"""Visit data access, always scoped by company and, for EMPLOYEE-only callers, by ownership.

`owner_id` narrows a query to the visits a user owns (host or creator, contract §7.5); None means the
whole company. Every list ends with the unique `id` tie-breaker (§3.2-6).
"""

import re
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import ColumnElement, Select, and_, exists, func, not_, or_, select, union_all, update
from sqlalchemy.orm import QueryableAttribute, Session, aliased

from app.core.policy import GRACE_MINUTES_MAX
from app.core.text import escape_like
from app.models import EmailKind, EmailMessage, EmailStatus, Visit, Visitor, VisitStatus
from app.repositories.pagination import Page, paginate
from app.repositories.scope import owned_by, visitor_readable_by


class VisitRecord(NamedTuple):
    """A visit as the visit responses read it (`services.visit_views`), for lists that only show visits:
    loaded as plain rows, without the ORM's identity map and attribute instrumentation (about 4 ms of CPU
    less for GET /reception/today's 250 visits, re-audit round 1). Nothing may change a record: lists
    that lead to a change load entities."""

    id: UUID
    status: str
    visitor_id: UUID
    visitor_name: str
    visitor_company_name: str | None
    host_id: UUID
    host_name: str
    department_id: UUID | None
    department_name: str | None
    department_name_ar: str | None
    purpose: str
    scheduled_start: datetime
    scheduled_end: datetime
    window_start: datetime
    window_end: datetime
    is_walk_in: bool
    walk_in_reason: str | None
    check_in_at: datetime | None
    check_in_method: str | None
    check_in_note: str | None
    checked_in_by_id: UUID | None
    check_out_at: datetime | None
    check_out_method: str | None
    check_out_note: str | None
    checked_out_by_id: UUID | None
    cancelled_at: datetime | None
    cancellation_reason: str | None
    cancelled_by_id: UUID | None
    no_show_at: datetime | None
    created_by_id: UUID
    created_at: datetime
    updated_at: datetime


_RECORD_COLUMNS = tuple(getattr(Visit, name) for name in VisitRecord._fields)


def _records(statement: Select[tuple[object, ...]], db: Session) -> list[VisitRecord]:
    return [VisitRecord._make(row) for row in db.execute(statement)]


def _scoped(company_id: UUID, owner_id: UUID | None) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [Visit.company_id == company_id]
    if owner_id is not None:
        conditions.append(owned_by(owner_id))
    return conditions


# Every writer derives a visit's pass window from its schedule and the company's grace periods, which are
# at most GRACE_MINUTES_MAX (`visit_rules.visit_window`; the companies table's CHECK constraints), so a
# window never opens longer than that before the visit starts. Bounding `scheduled_start` by it keeps the
# expected-list queries on the (company_id, scheduled_start) indexes while they select by `window_start`.
_LONGEST_GRACE = timedelta(minutes=GRACE_MINUTES_MAX)


def _expected_by(end: datetime) -> list[ColumnElement[bool]]:
    """SCHEDULED visits whose pass works before `end`: the window opens before it (SEC-R2). A pass is
    valid from its window's start, not from the scheduled start, so a visit starting just after midnight
    (or tomorrow, with a long grace period) is admitted by its pass today and is expected today. After the
    NO_SHOW marking every SCHEDULED visit's window is still open, so this also keeps a visit that started
    before midnight and is still within its window."""
    return [
        Visit.status == VisitStatus.SCHEDULED.value,
        Visit.window_start < end,
        Visit.scheduled_start < end + _LONGEST_GRACE,  # implied by the line above; for the index
    ]


def latest_invitation_status() -> ColumnElement[str | None]:
    """Status of the visit's latest VISITOR_INVITATION e-mail (NULL when none exists)."""
    return (
        select(EmailMessage.status)
        .where(
            EmailMessage.company_id == Visit.company_id,
            EmailMessage.visit_id == Visit.id,
            EmailMessage.kind == EmailKind.VISITOR_INVITATION.value,
        )
        .order_by(EmailMessage.created_at.desc(), EmailMessage.id.desc())
        .limit(1)
        .correlate(Visit)
        .scalar_subquery()
    )


def needs_attention() -> ColumnElement[bool]:
    """Contract §8.1: SCHEDULED visits whose latest invitation FAILED, or that have none although one was
    requested."""
    latest = latest_invitation_status()
    return and_(
        Visit.status == VisitStatus.SCHEDULED.value,
        or_(
            latest == EmailStatus.FAILED.value,
            and_(latest.is_(None), Visit.invitation_requested.is_(True)),
        ),
    )


def _contains(
    column: QueryableAttribute[str] | QueryableAttribute[str | None], text: str
) -> ColumnElement[bool]:
    return column.ilike(f"%{escape_like(text)}%", escape="\\")


# pg_trgm can look a LIKE pattern up only through a run of three word characters (letters or digits).
_TRIGRAM_RUN = re.compile(r"[^\W_]{3}")


def _has_trigram(text: str | None) -> bool:
    return text is not None and _TRIGRAM_RUN.search(text) is not None


def _snapshot_match(visit: type[Visit], text: str) -> ColumnElement[bool]:
    """`text` in one of the visit's name snapshots (visitor, visitor company, host), as typed."""
    return or_(
        _contains(visit.visitor_name, text),
        _contains(visit.visitor_company_name, text),
        _contains(visit.host_name, text),
    )


@dataclass(frozen=True, slots=True)
class VisitFilters:
    """GET /visits filters, already resolved by the service (IDs checked, dates turned into instants,
    search text normalised)."""

    statuses: Sequence[VisitStatus] = ()
    starts_from: datetime | None = None  # inclusive
    starts_before: datetime | None = None  # exclusive
    host_id: UUID | None = None
    visitor_id: UUID | None = None
    department_id: UUID | None = None
    needs_attention: bool = False
    search: str | None = None  # as typed; matches the name snapshots
    search_folded: str | None = None  # normalised; matches the visitor's search_text
    phone_digits: str | None = None
    newest_first: bool = True


@dataclass(frozen=True, slots=True)
class ReceptionCounts:
    expected: int  # SCHEDULED, starting before the end of the day (window still open)
    inside: int  # CHECKED_IN, any day
    checked_out: int  # checked out during the day
    no_show: int  # NO_SHOW, scheduled for the day
    cancelled: int  # CANCELLED, scheduled for the day
    walk_ins: int  # walk-ins checked in during the day


@dataclass(frozen=True, slots=True)
class CompanyVisitCounts:
    total: int
    inside: int
    today: int


@dataclass(frozen=True, slots=True)
class DashboardCounts:
    today: int
    upcoming: int
    inside: int
    completed_recent: int
    cancelled_recent: int
    needs_attention: int


class VisitRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, visit: Visit) -> Visit:
        self.db.add(visit)
        self.db.flush()
        return visit

    # ---- single visits --------------------------------------------------------------------------

    def get(self, company_id: UUID, visit_id: UUID, *, owner_id: UUID | None = None) -> Visit | None:
        statement = select(Visit).where(Visit.id == visit_id, *_scoped(company_id, owner_id))
        return self.db.scalars(statement).one_or_none()

    def lock(self, company_id: UUID, visit_id: UUID, *, owner_id: UUID | None = None) -> Visit | None:
        """`SELECT … FOR UPDATE` by id and company (contract §3.2-4), refreshing a loaded object."""
        statement = (
            select(Visit)
            .where(Visit.id == visit_id, *_scoped(company_id, owner_id))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return self.db.scalars(statement).one_or_none()

    def lock_scheduled_hosted_by(self, company_id: UUID, host_id: UUID) -> list[Visit]:
        statement = (
            select(Visit)
            .where(
                Visit.company_id == company_id,
                Visit.host_id == host_id,
                Visit.status == VisitStatus.SCHEDULED.value,
            )
            .order_by(Visit.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list(self.db.scalars(statement))

    def lock_stale_overdue(
        self, company_id: UUID, *, checked_in_before: datetime, ended_before: datetime
    ) -> list[Visit]:
        """CHECKED_IN visits checked in before `checked_in_before` whose scheduled end lies before
        `ended_before`, locked in id order (`repositories.locking`). A visit checked out by someone else
        while this waited no longer matches: PostgreSQL re-checks the condition on the row it locks."""
        statement = (
            select(Visit)
            .where(
                Visit.company_id == company_id,
                Visit.status == VisitStatus.CHECKED_IN.value,
                Visit.check_in_at < checked_in_before,
                Visit.scheduled_end < ended_before,
            )
            .order_by(Visit.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list(self.db.scalars(statement))

    def lock_scheduled_of_visitor(self, company_id: UUID, visitor_id: UUID) -> list[Visit]:
        statement = (
            select(Visit)
            .where(
                Visit.company_id == company_id,
                Visit.visitor_id == visitor_id,
                Visit.status == VisitStatus.SCHEDULED.value,
            )
            .order_by(Visit.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list(self.db.scalars(statement))

    # ---- NO_SHOW --------------------------------------------------------------------------------

    def mark_no_shows(self, company_id: UUID, *, now: datetime) -> list[UUID]:
        """Contract §5: one UPDATE marking every SCHEDULED visit whose window has ended. Rows another
        transaction holds locked are skipped (no waiting, no deadlock): that transaction is changing the
        visit and re-checks the deadline under its own lock."""
        expired = (
            select(Visit.id)
            .where(
                Visit.company_id == company_id,
                Visit.status == VisitStatus.SCHEDULED.value,
                Visit.window_end < now,
            )
            .order_by(Visit.id)
            .with_for_update(skip_locked=True)
        )
        statement = (
            update(Visit)
            .where(Visit.id.in_(expired.scalar_subquery()), Visit.status == VisitStatus.SCHEDULED.value)
            .values(status=VisitStatus.NO_SHOW.value, no_show_at=now, updated_at=now)
            .returning(Visit.id)
            .execution_options(synchronize_session=False)
        )
        return list(self.db.scalars(statement).all())

    # ---- lists ----------------------------------------------------------------------------------

    def search(
        self,
        company_id: UUID,
        *,
        owner_id: UUID | None,
        filters: VisitFilters,
        page: int,
        page_size: int,
    ) -> Page[Visit]:
        return paginate(
            self.db, self._filtered(company_id, owner_id, filters), page=page, page_size=page_size
        )

    def _filtered(self, company_id: UUID, owner_id: UUID | None, filters: VisitFilters) -> Select[Visit]:
        conditions = _scoped(company_id, owner_id)
        if filters.statuses:
            conditions.append(Visit.status.in_([status.value for status in filters.statuses]))
        if filters.starts_from is not None:
            conditions.append(Visit.scheduled_start >= filters.starts_from)
        if filters.starts_before is not None:
            conditions.append(Visit.scheduled_start < filters.starts_before)
        if filters.host_id is not None:
            conditions.append(Visit.host_id == filters.host_id)
        if filters.visitor_id is not None:
            conditions.append(Visit.visitor_id == filters.visitor_id)
        if filters.department_id is not None:
            conditions.append(Visit.department_id == filters.department_id)
        if filters.needs_attention:
            conditions.append(needs_attention())
        text_match = self._text_match(company_id, filters, owner_id)
        if text_match is not None:
            conditions.append(text_match)
        order = (
            (Visit.scheduled_start.desc(), Visit.id.desc())
            if filters.newest_first
            else (Visit.scheduled_start.asc(), Visit.id.asc())
        )
        return select(Visit).where(*conditions).order_by(*order)

    @staticmethod
    def _text_match(
        company_id: UUID, filters: VisitFilters, owner_id: UUID | None
    ) -> ColumnElement[bool] | None:
        """The visit's own snapshots, or the stored visitor's search text and phone digits. The stored
        record is searched only where the caller may read it (`owner_id`): otherwise matching would
        reveal it character by character.

        A query with a trigram to look up (three letters or digits in a row, or a phone number) is
        written as `id IN (<snapshot matches> UNION ALL <stored-visitor matches>)`, so that each part is
        planned on its own through its trigram indexes (the snapshots: revision 0007; the visitors:
        `ix_visitors_search_text_trgm` / `ix_visitors_phone_digits_trgm`, then their visits by
        `visitor_id`). As one OR with a correlated EXISTS, the count and the page both read every visit
        of the company whenever matches were rare. A shorter query has no trigram to look up and
        matches a large share of the visits: one filtered pass in start order finds a page fastest (it
        stops after the page), so it keeps that form."""
        visitor_match: list[ColumnElement[bool]] = []
        if filters.search_folded:
            visitor_match.append(_contains(Visitor.search_text, filters.search_folded))
        if filters.phone_digits:
            visitor_match.append(Visitor.phone_digits.like(f"%{filters.phone_digits}%"))
        stored_conditions = [or_(*visitor_match)] if visitor_match else []
        if stored_conditions and owner_id is not None:
            stored_conditions.append(visitor_readable_by(owner_id))

        if not _has_trigram(filters.search) and filters.phone_digits is None:
            alternatives = [_snapshot_match(Visit, filters.search)] if filters.search else []
            if stored_conditions:
                alternatives.append(
                    exists().where(
                        Visitor.company_id == Visit.company_id,
                        Visitor.id == Visit.visitor_id,
                        *stored_conditions,
                    )
                )
            return or_(*alternatives) if alternatives else None

        matched = aliased(Visit, name="matched_visits")
        parts: list[Select[UUID]] = []
        if filters.search:
            parts.append(
                select(matched.id).where(
                    matched.company_id == company_id, _snapshot_match(matched, filters.search)
                )
            )
        if stored_conditions:
            parts.append(
                select(matched.id)
                .join(
                    Visitor, and_(Visitor.company_id == matched.company_id, Visitor.id == matched.visitor_id)
                )
                .where(matched.company_id == company_id, *stored_conditions)
            )
        if not parts:
            return None
        return Visit.id.in_(union_all(*parts) if len(parts) > 1 else parts[0])

    def list_for_visitor(
        self, company_id: UUID, visitor_id: UUID, *, owner_id: UUID | None, page: int, page_size: int
    ) -> Page[Visit]:
        statement = (
            select(Visit)
            .where(Visit.visitor_id == visitor_id, *_scoped(company_id, owner_id))
            .order_by(Visit.scheduled_start.desc(), Visit.id.desc())
        )
        return paginate(self.db, statement, page=page, page_size=page_size)

    def actionable_for_visitors(
        self,
        company_id: UUID,
        visitor_ids: Collection[UUID],
        *,
        owner_id: UUID | None,
        day_start: datetime,
        day_end: datetime,
        now: datetime,
        limit: int,
    ) -> list[Visit]:
        """Every CHECKED_IN visit (the visitor is inside), and the SCHEDULED visits a desk can act on today:
        those starting on the given day (OVERRIDE applies all day), and those whose pass works between `now`
        and the end of the day (the window is open or opens today: `_expected_by`, SEC-R2), earliest
        first. No NO_SHOW marking runs before this read, hence the explicit `window_end`."""
        if not visitor_ids:
            return []
        statement = (
            select(Visit)
            .where(
                Visit.visitor_id.in_(list(visitor_ids)),
                *_scoped(company_id, owner_id),
                or_(
                    Visit.status == VisitStatus.CHECKED_IN.value,
                    and_(
                        Visit.status == VisitStatus.SCHEDULED.value,
                        or_(
                            and_(Visit.scheduled_start >= day_start, Visit.scheduled_start < day_end),
                            and_(Visit.window_start < day_end, Visit.window_end >= now),
                        ),
                    ),
                ),
            )
            .order_by(Visit.scheduled_start, Visit.id)
            .limit(limit)
        )
        return list(self.db.scalars(statement))

    def starting_between(
        self, company_id: UUID, *, owner_id: UUID | None, start: datetime, end: datetime, limit: int
    ) -> list[Visit]:
        statement = (
            select(Visit)
            .where(
                *_scoped(company_id, owner_id),
                Visit.scheduled_start >= start,
                Visit.scheduled_start < end,
                Visit.status != VisitStatus.CANCELLED.value,
            )
            .order_by(Visit.scheduled_start, Visit.id)
            .limit(limit)
        )
        return list(self.db.scalars(statement))

    # ---- reception ------------------------------------------------------------------------------

    def expected_until(self, company_id: UUID, end: datetime, *, limit: int) -> list[VisitRecord]:
        """SCHEDULED visits whose pass works before `end` (`_expected_by`), earliest start first: after the
        NO_SHOW marking, everyone still expected up to `end`."""
        statement = (
            select(*_RECORD_COLUMNS)
            .where(Visit.company_id == company_id, *_expected_by(end))
            .order_by(Visit.scheduled_start, Visit.id)
            .limit(limit)
        )
        return _records(statement, self.db)

    def expected_of_visitor(self, company_id: UUID, visitor_id: UUID, end: datetime) -> list[Visit]:
        """The visitor's SCHEDULED visits whose pass works before `end` (`expected_until` for one visitor),
        earliest start first."""
        statement = (
            select(Visit)
            .where(Visit.company_id == company_id, Visit.visitor_id == visitor_id, *_expected_by(end))
            .order_by(Visit.scheduled_start, Visit.id)
        )
        return list(self.db.scalars(statement))

    def inside(self, company_id: UUID, *, limit: int | None = None) -> list[VisitRecord]:
        """Every CHECKED_IN visit, whatever the day it was checked in on, earliest check-in first."""
        statement = (
            select(*_RECORD_COLUMNS)
            .where(Visit.company_id == company_id, Visit.status == VisitStatus.CHECKED_IN.value)
            .order_by(Visit.check_in_at, Visit.id)
            .limit(limit)
        )
        return _records(statement, self.db)

    def checked_out_between(
        self, company_id: UUID, start: datetime, end: datetime, *, limit: int
    ) -> list[VisitRecord]:
        """Visits checked out in `[start, end)`, latest check-out first."""
        statement = (
            select(*_RECORD_COLUMNS)
            .where(
                Visit.company_id == company_id,
                Visit.status == VisitStatus.CHECKED_OUT.value,
                Visit.check_out_at >= start,
                Visit.check_out_at < end,
            )
            .order_by(Visit.check_out_at.desc(), Visit.id.desc())
            .limit(limit)
        )
        return _records(statement, self.db)

    def no_shows_starting_between(
        self, company_id: UUID, start: datetime, end: datetime, *, limit: int
    ) -> list[VisitRecord]:
        statement = (
            select(*_RECORD_COLUMNS)
            .where(
                Visit.company_id == company_id,
                Visit.status == VisitStatus.NO_SHOW.value,
                Visit.scheduled_start >= start,
                Visit.scheduled_start < end,
            )
            .order_by(Visit.scheduled_start, Visit.id)
            .limit(limit)
        )
        return _records(statement, self.db)

    def reception_counts(
        self, company_id: UUID, *, day_start: datetime, day_end: datetime
    ) -> ReceptionCounts:
        """The exact counts behind GET /reception/today, in one query (the lists are capped).

        The WHERE clause keeps exactly the rows some count can include, as an OR of conditions each
        backed by an index, so PostgreSQL combines index scans instead of reading the company's whole
        history (the screen is polled; revision 0005)."""
        status = Visit.status
        starts_today = and_(Visit.scheduled_start >= day_start, Visit.scheduled_start < day_end)
        open_or_today = or_(
            status.in_([VisitStatus.SCHEDULED.value, VisitStatus.CHECKED_IN.value]),
            starts_today,
            and_(Visit.check_in_at >= day_start, Visit.check_in_at < day_end),
            and_(Visit.check_out_at >= day_start, Visit.check_out_at < day_end),
        )
        statement = select(
            func.count().filter(*_expected_by(day_end)),
            func.count().filter(status == VisitStatus.CHECKED_IN.value),
            func.count().filter(
                status == VisitStatus.CHECKED_OUT.value,
                Visit.check_out_at >= day_start,
                Visit.check_out_at < day_end,
            ),
            func.count().filter(status == VisitStatus.NO_SHOW.value, starts_today),
            func.count().filter(status == VisitStatus.CANCELLED.value, starts_today),
            func.count().filter(
                Visit.is_walk_in.is_(True), Visit.check_in_at >= day_start, Visit.check_in_at < day_end
            ),
        ).where(Visit.company_id == company_id, open_or_today)
        row = self.db.execute(statement).one()
        return ReceptionCounts(*(int(value or 0) for value in row))

    def company_counts(
        self, company_id: UUID, *, day_start: datetime, day_end: datetime
    ) -> CompanyVisitCounts:
        """Administrator dashboard: every visit, the visitors inside now, and today's visits (scheduled for
        the company-local day, cancelled ones excluded, like the employee dashboard's `today`)."""
        statement = select(
            func.count(),
            func.count().filter(Visit.status == VisitStatus.CHECKED_IN.value),
            func.count().filter(
                Visit.scheduled_start >= day_start,
                Visit.scheduled_start < day_end,
                Visit.status != VisitStatus.CANCELLED.value,
            ),
        ).where(Visit.company_id == company_id)
        row = self.db.execute(statement).one()
        return CompanyVisitCounts(*(int(value or 0) for value in row))

    # ---- aggregates -----------------------------------------------------------------------------

    def dashboard_counts(
        self,
        company_id: UUID,
        *,
        owner_id: UUID,
        today_start: datetime,
        today_end: datetime,
        recent_since: datetime,
    ) -> DashboardCounts:
        status = Visit.status
        statement = select(
            func.count().filter(
                Visit.scheduled_start >= today_start,
                Visit.scheduled_start < today_end,
                status != VisitStatus.CANCELLED.value,
            ),
            func.count().filter(status == VisitStatus.SCHEDULED.value, Visit.scheduled_start >= today_end),
            func.count().filter(status == VisitStatus.CHECKED_IN.value),
            func.count().filter(status == VisitStatus.CHECKED_OUT.value, Visit.check_out_at >= recent_since),
            func.count().filter(status == VisitStatus.CANCELLED.value, Visit.cancelled_at >= recent_since),
            func.count().filter(needs_attention()),
        ).where(*_scoped(company_id, owner_id))
        row = self.db.execute(statement).one()
        return DashboardCounts(*(int(value or 0) for value in row))

    def visitor_stats(
        self, company_id: UUID, visitor_ids: Collection[UUID], *, owner_id: UUID | None
    ) -> dict[UUID, tuple[int, datetime | None]]:
        """Per visitor: the number of visits in scope and the latest check-in among them."""
        if not visitor_ids:
            return {}
        statement = (
            select(Visit.visitor_id, func.count(), func.max(Visit.check_in_at))
            .where(Visit.visitor_id.in_(list(visitor_ids)), *_scoped(company_id, owner_id))
            .group_by(Visit.visitor_id)
        )
        return {row[0]: (int(row[1]), row[2]) for row in self.db.execute(statement)}

    def visitors_with_visits_not_owned_by(
        self, company_id: UUID, visitor_ids: Collection[UUID], owner_id: UUID
    ) -> set[UUID]:
        """Visitors having at least one visit `owner_id` does not own (`scope.owned_by`): hosted by someone
        else and created by someone else, or a walk-in for someone else's visit."""
        if not visitor_ids:
            return set()
        statement = (
            select(Visit.visitor_id)
            .where(
                Visit.company_id == company_id,
                Visit.visitor_id.in_(list(visitor_ids)),
                not_(owned_by(owner_id)),
            )
            .distinct()
        )
        return set(self.db.scalars(statement))

    # ---- snapshots (D-17) -----------------------------------------------------------------------

    def refresh_host_name(self, company_id: UUID, host_id: UUID, name: str, *, now: datetime) -> int:
        return self._refresh(company_id, Visit.host_id == host_id, now=now, host_name=name)

    def refresh_department_names(
        self, company_id: UUID, department_id: UUID, name: str, name_ar: str | None, *, now: datetime
    ) -> int:
        return self._refresh(
            company_id,
            Visit.department_id == department_id,
            now=now,
            department_name=name,
            department_name_ar=name_ar,
        )

    def complete_department_names(
        self,
        company_id: UUID,
        department_id: UUID,
        name: str,
        name_ar: str,
        *,
        statuses: Collection[VisitStatus],
        now: datetime,
    ) -> int:
        """Give the department's visits in `statuses` that recorded one of its two names (`name` or
        `name_ar`) and no Arabic name both names: the same name, recorded in one language only. For the
        seed's conversion of its own names (B10-27); a person's rename never reaches visits outside
        SCHEDULED (D-17)."""
        return self._refresh(
            company_id,
            and_(
                Visit.department_id == department_id,
                Visit.department_name.in_([name, name_ar]),
                Visit.department_name_ar.is_(None),
            ),
            now=now,
            statuses=statuses,
            department_name=name,
            department_name_ar=name_ar,
        )

    def _refresh(
        self,
        company_id: UUID,
        condition: ColumnElement[bool],
        *,
        now: datetime,
        statuses: Collection[VisitStatus] = (VisitStatus.SCHEDULED,),
        **values: object,
    ) -> int:
        # Only SCHEDULED visits follow their sources; from check-in on the snapshots are frozen (the seed's
        # `complete_department_names` is the one exception). Finished visits cannot change at all
        # (`visits_terminal_immutable`). The rows are locked in id order first, like every multi-visit
        # change (`repositories.locking`).
        if not {VisitStatus.CHECKED_OUT, VisitStatus.CANCELLED}.isdisjoint(statuses):
            raise ValueError("checked-out and cancelled visits are immutable")
        in_statuses = Visit.status.in_([status.value for status in statuses])
        targets = (
            select(Visit.id)
            .where(Visit.company_id == company_id, condition, in_statuses)
            .order_by(Visit.id)
            .with_for_update()
        )
        statement = (
            update(Visit)
            .where(Visit.id.in_(targets.scalar_subquery()), in_statuses)
            .values(**values, updated_at=now)
            .returning(Visit.id)
            .execution_options(synchronize_session="fetch")
        )
        return len(self.db.scalars(statement).all())

    # ---- non-production maintenance -------------------------------------------------------------

    def lock_for_maintenance(self, visit_id: UUID) -> Visit | None:
        """Unscoped lookup by ID for the E2E time-travel command (refused in production)."""
        statement = (
            select(Visit)
            .where(Visit.id == visit_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return self.db.scalars(statement).one_or_none()

    def shift_times(self, company_id: UUID, visit_id: UUID, delta: timedelta, *, now: datetime) -> None:
        """Move every instant of a visit by `delta` (schedule, window and lifecycle timestamps alike, so
        the visit's CHECK constraints keep holding)."""
        columns = (
            "scheduled_start",
            "scheduled_end",
            "window_start",
            "window_end",
            "check_in_at",  # NULL stays NULL
            "check_out_at",
            "no_show_at",
            "cancelled_at",
        )
        values: dict[str, object] = {column: getattr(Visit, column) + delta for column in columns}
        values["updated_at"] = now
        self.db.execute(
            update(Visit)
            .where(Visit.company_id == company_id, Visit.id == visit_id)
            .values(values)
            .execution_options(synchronize_session=False)
        )
