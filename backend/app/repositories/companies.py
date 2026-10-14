from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import Company
from app.repositories.locking import RowLock, with_lock


class CompanyRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, company: Company) -> Company:
        self.db.add(company)
        self.db.flush()
        return company

    def get(self, company_id: UUID, *, lock: RowLock | None = None) -> Company | None:
        """`lock=UPDATE` serialises company-wide invariants such as "at least one active administrator";
        `lock=KEY_SHARE` is the first lock of every visit change (lock order: `repositories.locking`)."""
        statement = with_lock(select(Company).where(Company.id == company_id), lock)
        return self.db.scalars(statement).one_or_none()

    def list_ids(self) -> list[UUID]:
        """Every company (maintenance commands that run per company, e.g. mark-no-shows)."""
        return list(self.db.scalars(select(Company.id).order_by(Company.id)))

    def get_by_slug(self, slug: str) -> Company | None:
        return self.db.scalars(select(Company).where(Company.slug == slug)).one_or_none()

    def database_knows_timezone(self, name: str) -> bool:
        statement = text("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = :tz)")
        return bool(self.db.execute(statement, {"tz": name}).scalar())
