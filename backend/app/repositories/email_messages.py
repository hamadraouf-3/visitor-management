from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.models import EmailKind, EmailMessage, EmailStatus
from app.repositories.ids import any_of


class LatestEmail(NamedTuple):
    """The latest e-mail of some kinds for a visit, as visit responses show it (`Visit.invitation`,
    `Visit.last_notice`)."""

    kind: str
    status: str
    to_email: str
    attempts: int
    last_attempt_at: datetime | None
    sent_at: datetime | None
    last_error: str | None


@dataclass(frozen=True, slots=True)
class ClosedMessage:
    """A PENDING message closed without delivery (what its audit row needs; no body)."""

    id: UUID
    company_id: UUID
    kind: str
    visit_id: UUID | None
    to_email: str
    attempts: int


class EmailMessageRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, message: EmailMessage) -> EmailMessage:
        self.db.add(message)
        self.db.flush()
        return message

    def claim_pending(self, message_id: UUID, *, now: datetime) -> bool:
        """Whether the message is still PENDING; if so, its `updated_at` becomes `now`, the sign that a
        delivery is under way (`fail_stale_pending` leaves it alone)."""
        statement = (
            update(EmailMessage)
            .where(EmailMessage.id == message_id, EmailMessage.status == EmailStatus.PENDING.value)
            .values(updated_at=now)
            .returning(EmailMessage.id)
        )
        return self.db.scalars(statement).one_or_none() is not None

    def fail_stale_pending(self, *, older_than: datetime, error: str, now: datetime) -> list[ClosedMessage]:
        """PENDING → FAILED (`error`, already sanitized) for every message untouched since `older_than`:
        no delivery is under way for it. Returns the messages changed."""
        statement = (
            update(EmailMessage)
            .where(EmailMessage.status == EmailStatus.PENDING.value, EmailMessage.updated_at < older_than)
            .values(status=EmailStatus.FAILED.value, last_error=error, updated_at=now)
            .returning(*_CLOSED_COLUMNS)
            .execution_options(synchronize_session=False)
        )
        return [ClosedMessage(*row) for row in self.db.execute(statement)]

    def close_pending_invitations(
        self, company_id: UUID, visit_id: UUID, *, error: str, now: datetime
    ) -> list[ClosedMessage]:
        """PENDING → FAILED (`error`) for the visit's invitations still waiting: a newer invitation
        replaces them (its pass rotated theirs), so a delivery not yet started must not send them."""
        statement = (
            update(EmailMessage)
            .where(
                EmailMessage.company_id == company_id,
                EmailMessage.visit_id == visit_id,
                EmailMessage.kind == EmailKind.VISITOR_INVITATION.value,
                EmailMessage.status == EmailStatus.PENDING.value,
            )
            .values(status=EmailStatus.FAILED.value, last_error=error, updated_at=now)
            .returning(*_CLOSED_COLUMNS)
            .execution_options(synchronize_session=False)
        )
        return [ClosedMessage(*row) for row in self.db.execute(statement)]

    def mark_sent(self, message_id: UUID, *, provider_message_id: str | None, now: datetime) -> int | None:
        """PENDING → SENT for the attempt that just succeeded. Returns the number of attempts, or None
        when the message is no longer PENDING (nothing changed)."""
        statement = (
            update(EmailMessage)
            .where(EmailMessage.id == message_id, EmailMessage.status == EmailStatus.PENDING.value)
            .values(
                status=EmailStatus.SENT.value,
                attempts=EmailMessage.attempts + 1,
                provider_message_id=provider_message_id,
                last_error=None,
                last_attempt_at=now,
                sent_at=now,
                updated_at=now,
            )
            .returning(EmailMessage.attempts)
        )
        return self.db.scalars(statement).one_or_none()

    def record_failed_attempt(
        self, message_id: UUID, *, error: str, final: bool, now: datetime
    ) -> int | None:
        """Count a failed attempt (`error` already sanitized); a final one makes the message FAILED,
        otherwise it stays PENDING for the next attempt. Returns the number of attempts, or None when
        the message is no longer PENDING (nothing changed)."""
        statement = (
            update(EmailMessage)
            .where(EmailMessage.id == message_id, EmailMessage.status == EmailStatus.PENDING.value)
            .values(
                status=EmailStatus.FAILED.value if final else EmailStatus.PENDING.value,
                attempts=EmailMessage.attempts + 1,
                last_error=error,
                last_attempt_at=now,
                updated_at=now,
            )
            .returning(EmailMessage.attempts)
        )
        return self.db.scalars(statement).one_or_none()

    def latest_invitations(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, LatestEmail]:
        """The most recent VISITOR_INVITATION e-mail of each visit (contract §8.1 `Visit.invitation`)."""
        return self._latest_of_kinds(company_id, visit_ids, (EmailKind.VISITOR_INVITATION,))

    def latest_notices(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, LatestEmail]:
        """The most recent cancellation or reschedule notice of each visit (`Visit.last_notice`)."""
        return self._latest_of_kinds(
            company_id, visit_ids, (EmailKind.VISIT_CANCELLED, EmailKind.VISIT_RESCHEDULED)
        )

    def _latest_of_kinds(
        self, company_id: UUID, visit_ids: Collection[UUID], kinds: Collection[EmailKind]
    ) -> dict[UUID, LatestEmail]:
        """Only what a visit response shows, not entities: a list holds up to hundreds of visits."""
        if not visit_ids:
            return {}
        statement = (
            select(EmailMessage.visit_id, *_LATEST_COLUMNS)
            .where(
                EmailMessage.company_id == company_id,
                any_of(EmailMessage.visit_id, visit_ids),
                EmailMessage.kind.in_([kind.value for kind in kinds]),
            )
            .order_by(EmailMessage.visit_id, EmailMessage.created_at.desc(), EmailMessage.id.desc())
            .ext(distinct_on(EmailMessage.visit_id))
        )
        return {row[0]: LatestEmail(*row[1:]) for row in self.db.execute(statement) if row[0] is not None}


_LATEST_COLUMNS = (
    EmailMessage.kind,
    EmailMessage.status,
    EmailMessage.to_email,
    EmailMessage.attempts,
    EmailMessage.last_attempt_at,
    EmailMessage.sent_at,
    EmailMessage.last_error,
)
_CLOSED_COLUMNS = (
    EmailMessage.id,
    EmailMessage.company_id,
    EmailMessage.kind,
    EmailMessage.visit_id,
    EmailMessage.to_email,
    EmailMessage.attempts,
)
