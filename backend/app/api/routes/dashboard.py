from fastapi import APIRouter

from app.api.deps import AdminDashboardAuth, DashboardServiceDep, EmployeeDashboardAuth
from app.schemas.dashboard import AdminDashboard, EmployeeDashboard

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/employee", response_model=EmployeeDashboard)
def employee_dashboard(auth: EmployeeDashboardAuth, service: DashboardServiceDep) -> EmployeeDashboard:
    return service.employee(auth)


@router.get("/admin", response_model=AdminDashboard)
def admin_dashboard(auth: AdminDashboardAuth, service: DashboardServiceDep) -> AdminDashboard:
    return service.admin(auth)
