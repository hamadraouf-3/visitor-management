"""Dashboard schemas (contract §8 /dashboard, §8.1 `EmployeeDashboard`, `AdminDashboard`)."""

from app.schemas.audit import AuditLog
from app.schemas.common import ResponseModel
from app.schemas.visits import Visit


class EmployeeDashboardCounts(ResponseModel):
    today: int
    upcoming: int
    inside: int
    completed_30d: int
    cancelled_30d: int
    needs_attention: int


class EmployeeDashboard(ResponseModel):
    counts: EmployeeDashboardCounts
    today: list[Visit]


class AdminDashboardCounts(ResponseModel):
    visitors_total: int
    visits_total: int
    inside_now: int
    visits_today: int
    employees: int
    receptionists: int
    management: int
    admins: int


class AdminDashboard(ResponseModel):
    counts: AdminDashboardCounts
    recent_audit: list[AuditLog]  # latest 10
