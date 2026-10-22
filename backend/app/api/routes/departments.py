from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.deps import AdminAuth, ContextDep, CurrentAuth, DepartmentsServiceDep
from app.schemas.departments import Department, DepartmentCreate, DepartmentListQuery, DepartmentUpdate

router = APIRouter(prefix="/departments", tags=["departments"])


@router.get("", response_model=list[Department])
def list_departments(
    auth: CurrentAuth, service: DepartmentsServiceDep, query: Annotated[DepartmentListQuery, Query()]
) -> list[Department]:
    """Active departments; `include_inactive=true` is reserved for administrators."""
    departments = service.list_departments(auth, include_inactive=query.include_inactive)
    return service.views(auth.company_id, departments)


@router.post("", response_model=Department, status_code=status.HTTP_201_CREATED)
def create_department(
    body: DepartmentCreate, auth: AdminAuth, service: DepartmentsServiceDep, context: ContextDep
) -> Department:
    return service.views(auth.company_id, [service.create(auth, body, context)])[0]


@router.patch("/{department_id}", response_model=Department)
def update_department(
    department_id: UUID,
    body: DepartmentUpdate,
    auth: AdminAuth,
    service: DepartmentsServiceDep,
    context: ContextDep,
) -> Department:
    return service.views(auth.company_id, [service.update(auth, department_id, body, context)])[0]
