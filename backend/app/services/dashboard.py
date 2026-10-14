"""Dashboards (contract §8 /dashboard, §8.1 `EmployeeDashboard`, `AdminDashboard`).

Employee (D-23): counts over the caller's own visits (host or creator) and today's list; the full lists
live on GET /visits.
* today: visits scheduled for the company-local day, cancelled ones excluded (the list shows the same);
* upcoming: SCHEDULED visits on later days;
* inside: CHECKED_IN visits, whatever their date;
* completed_30d / cancelled_30d: checked out / cancelled during the last 30 days;
* needs_attention: SCHEDULED visits whose invitation failed or was requested but never queued.

Administrator: company-wide counts and the latest audit rows.
* visitors_total / visits_total: every visitor and every visit of the company (any status);
* inside_now: CHECKED_IN visits, whatever their date;
* visits_today: visits scheduled for the company-local day, cancelled ones excluded (walk-ins start at
  their check-in, so today's walk-ins count);
* employees / receptionists / management / admins: active users holding the role (a user with several
  roles counts for each, D-04);
* recent_audit: the company's latest RECENT_AUDIT_ROWS audit rows, newest first.
"""

from datetime import timedelta

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.policy import DASHBOARD_RECENT_DAYS, INLINE_VISIT_LIST_CAP
from app.core.time import company_day_bounds, local_date
from app.models import Role
from app.repositories.audit_logs import AuditLogRepository
from app.repositories.users import UserRepository
from app.repositories.visitors import VisitorRepository
from app.repositories.visits import VisitRepository
from app.schemas.dashboard import (
    AdminDashboard,
    AdminDashboardCounts,
    EmployeeDashboard,
    EmployeeDashboardCounts,
)
from app.security.sessions import AuthContext
from app.services.audit_trail import audit_log_views
from app.services.no_shows import mark_no_shows_committed
from app.services.visit_views import Viewer, VisitViewBuilder

RECENT_AUDIT_ROWS = 10


class DashboardService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.visits = VisitRepository(db)

    def employee(self, auth: AuthContext) -> EmployeeDashboard:
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        viewer = Viewer.of(auth)
        today_start, today_end = company_day_bounds(local_date(now, viewer.timezone), viewer.timezone)
        counts = self.visits.dashboard_counts(
            auth.company_id,
            owner_id=auth.user_id,
            today_start=today_start,
            today_end=today_end,
            recent_since=now - timedelta(days=DASHBOARD_RECENT_DAYS),
        )
        today = self.visits.starting_between(
            auth.company_id,
            owner_id=auth.user_id,
            start=today_start,
            end=today_end,
            limit=INLINE_VISIT_LIST_CAP,
        )
        return EmployeeDashboard(
            counts=EmployeeDashboardCounts(
                today=counts.today,
                upcoming=counts.upcoming,
                inside=counts.inside,
                completed_30d=counts.completed_recent,
                cancelled_30d=counts.cancelled_recent,
                needs_attention=counts.needs_attention,
            ),
            today=VisitViewBuilder(self.db, viewer, now=now).build(today),
        )

    def admin(self, auth: AuthContext) -> AdminDashboard:
        now = app_time.now()
        company_id = auth.company_id
        mark_no_shows_committed(self.db, company_id, now=now)
        timezone = auth.user.company.timezone
        today_start, today_end = company_day_bounds(local_date(now, timezone), timezone)
        visits = self.visits.company_counts(company_id, day_start=today_start, day_end=today_end)
        roles = UserRepository(self.db).count_active_by_role(company_id)
        recent = AuditLogRepository(self.db).latest(company_id, limit=RECENT_AUDIT_ROWS)
        return AdminDashboard(
            counts=AdminDashboardCounts(
                visitors_total=VisitorRepository(self.db).count_in_company(company_id),
                visits_total=visits.total,
                inside_now=visits.inside,
                visits_today=visits.today,
                employees=roles[Role.EMPLOYEE],
                receptionists=roles[Role.RECEPTIONIST],
                management=roles[Role.MANAGEMENT],
                admins=roles[Role.SYSTEM_ADMIN],
            ),
            recent_audit=audit_log_views(self.db, company_id, recent),
        )
