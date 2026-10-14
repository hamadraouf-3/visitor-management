import uuid
from datetime import datetime

from sqlalchemy import CHAR, CheckConstraint, DateTime, ForeignKeyConstraint, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, UUIDPrimaryKeyMixin
from app.models.enums import PassRevokeReason, sql_in_list


class VisitorPass(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A QR pass. Only the SHA-256 of the token is stored; validity comes from the visit's window."""

    __tablename__ = "visitor_passes"
    __table_args__ = (
        ForeignKeyConstraint(
            ["company_id", "visit_id"], ["visits.company_id", "visits.id"], ondelete="RESTRICT"
        ),
        ForeignKeyConstraint(
            ["company_id", "created_by_id"], ["users.company_id", "users.id"], ondelete="RESTRICT"
        ),
        CheckConstraint(
            f"revoke_reason IS NULL OR revoke_reason IN ({sql_in_list(PassRevokeReason)})",
            name="revoke_reason_valid",
        ),
        CheckConstraint("(revoked_at IS NULL) = (revoke_reason IS NULL)", name="revocation_consistent"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    visit_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(String(32))


# At most one active pass per visit.
Index(
    "uq_passes_active_visit",
    VisitorPass.visit_id,
    unique=True,
    postgresql_where=text("revoked_at IS NULL"),
)
# The current pass of each visit on a page (`PassRepository.current_for_visits`, revision 0010): active or
# revoked, so the partial index above cannot serve it. Also the composite foreign key's columns.
Index("ix_visitor_passes_company_id_visit_id", VisitorPass.company_id, VisitorPass.visit_id)
