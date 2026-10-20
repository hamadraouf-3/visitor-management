import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import EmailKind, EmailStatus, EventMethod, sql_in_list


class EmailMessage(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Delivery bookkeeping for one outgoing e-mail.

    Rendered bodies are deliberately not stored: they may contain a raw pass or reset token.
    """

    __tablename__ = "email_messages"
    __table_args__ = (
        ForeignKeyConstraint(
            ["company_id", "visit_id"], ["visits.company_id", "visits.id"], ondelete="RESTRICT"
        ),
        ForeignKeyConstraint(
            ["company_id", "recipient_user_id"], ["users.company_id", "users.id"], ondelete="RESTRICT"
        ),
        CheckConstraint(f"kind IN ({sql_in_list(EmailKind)})", name="kind_valid"),
        CheckConstraint(f"status IN ({sql_in_list(EmailStatus)})", name="status_valid"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        CheckConstraint("(status = 'SENT') = (sent_at IS NOT NULL)", name="sent_at_set"),
        CheckConstraint(f"calendar_method IN ({sql_in_list(EventMethod)})", name="calendar_method_valid"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    visit_id: Mapped[uuid.UUID | None] = mapped_column()
    recipient_user_id: Mapped[uuid.UUID | None] = mapped_column()
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    to_email: Mapped[str] = mapped_column(String(320), nullable=False)
    subject: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=EmailStatus.PENDING.value, server_default=text("'PENDING'")
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_message_id: Mapped[str | None] = mapped_column(String(255))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    last_error: Mapped[str | None] = mapped_column(String(500))  # sanitized, never provider internals
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The iTIP method of the calendar event the message carried, NULL when it carried none (revision 0017,
    # Phase 14, B14-26): whether a calendar was sent the visit's event, or had it taken out.
    calendar_method: Mapped[str | None] = mapped_column(String(8))


Index("ix_email_messages_visit_id_created_at", EmailMessage.visit_id, EmailMessage.created_at)
Index("ix_email_messages_status", EmailMessage.status)
