import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Department(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "departments"
    __table_args__ = (
        # Target of composite tenant foreign keys (company_id, department_id).
        UniqueConstraint("company_id", "id"),
        CheckConstraint("btrim(name) <> ''", name="name_not_blank"),
        CheckConstraint("name_ar IS NULL OR btrim(name_ar) <> ''", name="name_ar_not_blank"),
        # The department's floor, of the same company (revision 0019, Phase 16, B16-3).
        ForeignKeyConstraint(
            ["company_id", "floor_id"],
            ["floors.company_id", "floors.id"],
            name="fk_departments_floor",
            ondelete="RESTRICT",
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    # The default (English, or only) name; `name_ar` is the Arabic name, shown instead of it when the
    # interface or an e-mail is in Arabic (revision 0012, B10-25). The service trims both and stores a
    # blank Arabic name as NULL.
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    name_ar: Mapped[str | None] = mapped_column(String(120))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Where the department works (revision 0019, B16-3): a new visit of the department is allowed on this
    # floor unless its request names its own areas. An archived floor is skipped, not refused.
    floor_id: Mapped[uuid.UUID | None] = mapped_column()


# Case-insensitive uniqueness per company; services map these names to 409 CONFLICT (fields "name" and
# "name_ar"). The Arabic name is unique only where it is set.
Index("uq_departments_company_name", Department.company_id, func.lower(Department.name), unique=True)
Index(
    "uq_departments_company_name_ar",
    Department.company_id,
    func.lower(Department.name_ar),
    unique=True,
    postgresql_where=text("name_ar IS NOT NULL"),
)
