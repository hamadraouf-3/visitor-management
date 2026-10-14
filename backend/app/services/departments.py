"""Departments (contract §8 /departments). A department has a name (B10-25: the default, English or only,
name) and may have an Arabic name. No value of one department, name or Arabic name, may be a value of
another department of the company, ignoring case (B10-29): two departments then never read the same,
in the Arabic interface (`name_ar`, else `name`) or in the English one (`name`, beside which the
administrators' list shows `name_ar`). A department's own two values may be equal. Name against name
and Arabic name against Arabic name have unique indexes; across the two languages the service checks,
and every change that names a department holds the company row `FOR UPDATE`, so two such changes in a
company run one after the other and the second sees the first.

A rename, in either language, refreshes the `department_name` and `department_name_ar` snapshots of
SCHEDULED visits in the same transaction (D-17, `VisitSnapshotRefresher`). Users and visits can only be
assigned to active departments (`assignable_department`). Creation and changes start with the company row
(`FOR UPDATE` when they name the department, else `FOR KEY SHARE`) and re-check the caller
(`lock_company_for_change`): an administrator deactivated or demoted meanwhile changes nothing (SEC-31).
"""

from collections.abc import Mapping
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import Conflict, Forbidden
from app.core.field_errors import FieldCode, FieldProblem
from app.core.request_context import RequestContext
from app.db.errors import unique_violation_constraint
from app.models import Department
from app.repositories.departments import DepartmentRepository
from app.repositories.locking import RowLock
from app.schemas.departments import DepartmentCreate, DepartmentUpdate
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change
from app.services.scoping import FieldErrors, require_found
from app.services.visit_snapshots import VisitSnapshotRefresher

NAME_CONSTRAINT = "uq_departments_company_name"
NAME_AR_CONSTRAINT = "uq_departments_company_name_ar"
NAME_TAKEN = "A department with this name already exists."
NAME_AR_TAKEN = "A department with this Arabic name already exists."
# The unique index behind each name -> (the field it is reported on, the message).
_NAME_CONFLICTS = {NAME_CONSTRAINT: ("name", NAME_TAKEN), NAME_AR_CONSTRAINT: ("name_ar", NAME_AR_TAKEN)}
DEPARTMENT_INACTIVE = FieldProblem(FieldCode.DEPARTMENT_INACTIVE, "This department is inactive.")


def assignable_department(
    departments: DepartmentRepository,
    company_id: UUID,
    department_id: UUID | None,
    errors: FieldErrors,
    *,
    lock: RowLock | None = None,
) -> Department | None:
    """The department a request names for a user or a visit (`department_id`): it must belong to the
    company (§3.2-5) and be active, otherwise a field error is recorded."""
    if department_id is None:
        return None
    department = errors.require(departments.get(company_id, department_id, lock=lock), "department_id")
    if department is not None and not department.is_active:
        errors.add("department_id", DEPARTMENT_INACTIVE)
    return department


class DepartmentsService:
    def __init__(self, db: Session, *, snapshots: VisitSnapshotRefresher) -> None:
        self.db = db
        self.snapshots = snapshots
        self.departments = DepartmentRepository(db)

    def list_departments(self, auth: AuthContext, *, include_inactive: bool) -> list[Department]:
        if include_inactive and not has_capability(auth.roles, Capability.ADMINISTER):
            raise Forbidden()
        return self.departments.list_in_company(auth.company_id, include_inactive=include_inactive)

    def create(self, auth: AuthContext, data: DepartmentCreate, context: RequestContext) -> Department:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        self._require_free(auth.company_id, "name", data.name)
        if data.name_ar is not None:
            self._require_free(auth.company_id, "name_ar", data.name_ar)
        department = Department(
            company_id=auth.company_id, name=data.name, name_ar=data.name_ar, is_active=True
        )
        self._save(department)
        self._audit(auth, department, AuditAction.DEPARTMENT_CREATED, context, {})
        self.db.commit()
        return department

    def update(
        self, auth: AuthContext, department_id: UUID, data: DepartmentUpdate, context: RequestContext
    ) -> Department:
        # A change that names the department is serialised with every other one in the company (B10-29).
        names = data.name is not None or "name_ar" in data.model_fields_set
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE if names else RowLock.KEY_SHARE)
        department = require_found(self.departments.get(auth.company_id, department_id, lock=RowLock.UPDATE))
        changed: list[str] = []
        renamed = data.name is not None and data.name != department.name
        # Supplied as null (or blank) clears the Arabic name; omitted leaves it as it is.
        renamed_ar = "name_ar" in data.model_fields_set and data.name_ar != department.name_ar
        # The names are checked before either is changed: a lookup flushes pending changes, and a flush
        # outside `_save` would turn a concurrent duplicate into an unmapped error instead of a 409.
        if renamed and data.name is not None:
            self._require_free(auth.company_id, "name", data.name, department, previous=department.name)
        if renamed_ar and data.name_ar is not None:
            self._require_free(
                auth.company_id, "name_ar", data.name_ar, department, previous=department.name_ar
            )
        if renamed and data.name is not None:
            department.name = data.name
            changed.append("name")
        if renamed_ar:
            department.name_ar = data.name_ar
            changed.append("name_ar")
        if data.is_active is not None and data.is_active != department.is_active:
            department.is_active = data.is_active
            changed.append("is_active")
        if not changed:
            return department
        self._save(department)
        if "name" in changed or "name_ar" in changed:
            self.snapshots.department_renamed(self.db, department=department, now=app_time.now())
        self._audit(auth, department, AuditAction.DEPARTMENT_UPDATED, context, {"changed_fields": changed})
        self.db.commit()
        return department

    def _require_free(
        self,
        company_id: UUID,
        field: str,
        value: str,
        department: Department | None = None,
        *,
        previous: str | None = None,
    ) -> None:
        """409 `CONFLICT` on `field` when another department of the company (inactive ones included) has
        `value` as its name or its Arabic name, ignoring case (B10-29). The same language is checked first,
        so its message wins: "… with this name …" for another department's name, "… with this Arabic name
        …" for another department's Arabic name. `department` is the one being changed (its own values
        never conflict). A value that only changes case (`previous`) is not checked across the languages:
        a department that already shared a value with another (written before B10-29) stays editable."""
        same, other = (
            (self.departments.get_by_name, self.departments.get_by_name_ar)
            if field == "name"
            else (self.departments.get_by_name_ar, self.departments.get_by_name)
        )
        messages = (NAME_TAKEN, NAME_AR_TAKEN) if field == "name" else (NAME_AR_TAKEN, NAME_TAKEN)
        existing = same(company_id, value)
        if existing is not None and (department is None or existing.id != department.id):
            raise Conflict(field, messages[0])
        if previous is not None and previous.lower() == value.lower():
            return
        existing = other(company_id, value)
        if existing is not None and (department is None or existing.id != department.id):
            raise Conflict(field, messages[1])

    def _save(self, department: Department) -> None:
        try:
            with self.db.begin_nested():
                self.departments.add(department)
        except IntegrityError as exc:
            conflict = _NAME_CONFLICTS.get(unique_violation_constraint(exc) or "")
            if conflict is not None:
                raise Conflict(*conflict) from None
            raise

    def _audit(
        self,
        auth: AuthContext,
        department: Department,
        action: AuditAction,
        context: RequestContext,
        metadata: Mapping[str, object],
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.DEPARTMENT,
            entity_id=department.id,
            metadata=metadata,
        )
