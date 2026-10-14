from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Department
from app.repositories.locking import RowLock, with_lock


class DepartmentRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, department: Department) -> Department:
        self.db.add(department)
        self.db.flush()
        return department

    def get(self, company_id: UUID, department_id: UUID, *, lock: RowLock | None = None) -> Department | None:
        statement = select(Department).where(
            Department.company_id == company_id, Department.id == department_id
        )
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def list_in_company(self, company_id: UUID, *, include_inactive: bool) -> list[Department]:
        statement = select(Department).where(Department.company_id == company_id)
        if not include_inactive:
            statement = statement.where(Department.is_active.is_(True))
        statement = statement.order_by(func.lower(Department.name), Department.id)
        return list(self.db.scalars(statement))

    def get_by_name(self, company_id: UUID, name: str) -> Department | None:
        statement = select(Department).where(
            Department.company_id == company_id, func.lower(Department.name) == name.lower()
        )
        return self.db.scalars(statement).one_or_none()

    def get_by_name_ar(self, company_id: UUID, name_ar: str) -> Department | None:
        """The department whose Arabic name is `name_ar`, ignoring case (`uq_departments_company_name_ar`)."""
        statement = select(Department).where(
            Department.company_id == company_id, func.lower(Department.name_ar) == name_ar.lower()
        )
        return self.db.scalars(statement).one_or_none()

    def named(self, company_id: UUID, name: str) -> list[Department]:
        """The departments that show `name` in either language: their name or their Arabic name is `name`,
        ignoring case."""
        lowered = name.lower()
        statement = (
            select(Department)
            .where(
                Department.company_id == company_id,
                or_(func.lower(Department.name) == lowered, func.lower(Department.name_ar) == lowered),
            )
            .order_by(Department.id)
        )
        return list(self.db.scalars(statement))
