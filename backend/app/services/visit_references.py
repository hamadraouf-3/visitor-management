"""The host and department a new visit names: visit creation and walk-ins (contract §3.2-5, B24-23).

Both rows are read under `FOR KEY SHARE` (`repositories.locking`, after the company row and before the
visitor and visit rows). A deactivation or role change (D-18) and a department rename or deactivation
(D-17) hold the row `FOR UPDATE`, so such a change either committed first and is seen here, or waits for
the new visit and then processes it like any other.

`can_host` is §7.5's host rule for a loaded user; check-ins and the arrival e-mail use it as well.
"""

from uuid import UUID

from app.core.field_errors import FieldCode, FieldProblem
from app.models import Department, User
from app.repositories.departments import DepartmentRepository
from app.repositories.locking import RowLock
from app.repositories.users import UserRepository
from app.security.permissions import is_available_host
from app.services.departments import assignable_department
from app.services.scoping import FieldErrors

HOST_NOT_AVAILABLE = FieldProblem(FieldCode.HOST_UNAVAILABLE, "Choose an active host.")
# POST /visits by a caller who may not invite on behalf of others (B10-24): only administrators may.
HOST_MUST_BE_SELF = FieldProblem(
    FieldCode.HOST_MUST_BE_SELF, "You can only invite visitors you host yourself."
)


def can_host(user: User | None) -> bool:
    """Whether `user` can host a visit now (§7.5): active and holding EMPLOYEE or SYSTEM_ADMIN. The
    one rule for choosing a host, checking a visitor in and telling the host of the arrival."""
    return user is not None and is_available_host(is_active=user.is_active, roles=user.role_set)


def active_host(users: UserRepository, company_id: UUID, host_id: UUID, errors: FieldErrors) -> User | None:
    """The host, share-locked and checked under the lock: an active user holding EMPLOYEE or
    SYSTEM_ADMIN; otherwise a field error on `host_id`."""
    host = errors.require(users.get_in_company(company_id, host_id, lock=RowLock.KEY_SHARE), "host_id")
    if host is not None and not can_host(host):
        errors.add("host_id", HOST_NOT_AVAILABLE)
        return None
    return host


def visit_department(
    departments: DepartmentRepository,
    company_id: UUID,
    department_id: UUID | None,
    host: User | None,
    errors: FieldErrors,
) -> Department | None:
    """The named department (it must be active), otherwise the host's unless it has been deactivated;
    share-locked so a rename (D-17) cannot slip between this read and the visit's snapshot."""
    if department_id is not None:
        return assignable_department(departments, company_id, department_id, errors, lock=RowLock.KEY_SHARE)
    if host is None or host.department_id is None:
        return None
    department = departments.get(company_id, host.department_id, lock=RowLock.KEY_SHARE)
    return department if department is not None and department.is_active else None
