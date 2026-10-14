import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Visitor(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "visitors"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        # NULLs are distinct: visitors without an e-mail never collide. Maps to 409 VISITOR_EXISTS.
        UniqueConstraint("company_id", "email"),
        ForeignKeyConstraint(
            ["company_id", "created_by_id"], ["users.company_id", "users.id"], ondelete="RESTRICT"
        ),
        CheckConstraint("email IS NULL OR (email <> '' AND email = lower(email))", name="email_lowercase"),
        CheckConstraint("phone_digits IS NULL OR phone_digits ~ '^[0-9]+$'", name="phone_digits_only"),
        CheckConstraint("btrim(full_name) <> ''", name="full_name_not_blank"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    email: Mapped[str | None] = mapped_column(String(320))
    phone: Mapped[str | None] = mapped_column(String(40))
    # Derived by the visitor service: digits of `phone` only, for phone search.
    phone_digits: Mapped[str | None] = mapped_column(String(40))
    company_name: Mapped[str | None] = mapped_column(String(200))
    # Derived by the visitor service: folded (case, accents, Arabic letter variants) name/email/company.
    search_text: Mapped[str] = mapped_column(Text, nullable=False)
    # Derived by the visitor service: the name folded the same way, the key lists are ordered by
    # (`core.search.name_sort_key`; the C.UTF-8 collation compares code points).
    name_sort: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column()
    # Whether creating the visitor puts it in its creator's own read scope (contract §7.5 "visitors
    # created by me"): only when the creator's read scope was their own at the time (an EMPLOYEE-only
    # user). Reception, administrators and management read every visitor; what they register is
    # nobody's in particular, so a later move to an EMPLOYEE-only role does not keep it (SEC-08).
    owned_by_creator: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


Index(
    "ix_visitors_search_text_trgm",
    Visitor.search_text,
    postgresql_using="gin",
    postgresql_ops={"search_text": "gin_trgm_ops"},
)
Index(
    "ix_visitors_phone_digits_trgm",
    Visitor.phone_digits,
    postgresql_using="gin",
    postgresql_ops={"phone_digits": "gin_trgm_ops"},
)
Index("ix_visitors_company_id_created_at_id", Visitor.company_id, Visitor.created_at, Visitor.id)
Index("ix_visitors_company_id_name_sort_id", Visitor.company_id, Visitor.name_sort, Visitor.id)
