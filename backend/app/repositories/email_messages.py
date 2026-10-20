from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.models import EmailKind, EmailMessage, EmailStatus, EventMethod
from app.repositories.ids import any_of

# The kinds that carry the visitor's event of a visit and the host's (Phase 14, B14-1), whether or not a
# given message carried it (`EmailMessage.calendar_method`, B14-26).
VISITOR_EVENT_KINDS = (EmailKind.VISITOR_CALENDAR, EmailKind.VISIT_RESCHEDULED, EmailKind.VISIT_CANCELLED)
HOST_EVENT_KINDS = (
    EmailKind.HOST_VISIT_SCHEDULED,
    EmailKind.HOST_VISIT_RESCHEDULED,
    EmailKind.HOST_VISIT_CANCELLED,
)


class LatestEmail(NamedTuple):
    """An e-mail of a visit as visit responses and the calendar rules read it (`Visit.invitation`,
    `Visit.last_notice`, `Visit.visitor_calendar_sent`; `app.services.calendar_state`)."""

    kind: str
    status: str
    to_email: str
    attempts: int
    last_attempt_at: datetime | None
    sent_at: datetime | None
    last_error: str | None
    created_at: datetime
    calendar_method: str | None


# The e-mails of visits that carried an event: visit ID → address → its messages, oldest first.
type EventMessages = dict[UUID, dict[str, list[LatestEmail]]]


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

    def event_messages(
        self, company_id: UUID, visit_ids: Collection[UUID], kinds: Collection[EmailKind]
    ) -> EventMessages:
        """The visits' e-mails of `kinds` that carried an event (a REQUEST or a CANCEL, B14-26), per visit
        and address, oldest first: what each calendar was sent of the visit (`app.services.calendar_state`
        reads them). A visit has a handful, so a page of visits reads them in one query."""
        if not visit_ids:
            return {}
        statement = (
            select(EmailMessage.visit_id, *_LATEST_COLUMNS)
            .where(
                EmailMessage.company_id == company_id,
                any_of(EmailMessage.visit_id, visit_ids),
                EmailMessage.kind.in_([kind.value for kind in kinds]),
                EmailMessage.calendar_method.is_not(None),
            )
            .order_by(EmailMessage.created_at, EmailMessage.id)
        )
        messages: EventMessages = {}
        for row in self.db.execute(statement):
            if row[0] is not None:
                message = LatestEmail._make(row[1:])
                messages.setdefault(row[0], {}).setdefault(message.to_email, []).append(message)
        return messages

    def close_pending_requests(
        self, company_id: UUID, visit_ids: Collection[UUID], to_email: str, *, error: str, now: datetime
    ) -> int:
        """PENDING → FAILED (`error`) for the visits' e-mails to `to_email` that carry a REQUEST of an
        event and wait for a delivery slot: the visitor no longer has that address (D-19, B14-29), and a
        REQUEST delivered there after the event's withdrawal would put the visit back in that calendar.
        A CANCEL waiting for its slot still goes. Returns how many were closed."""
        if not visit_ids:
            return 0
        statement = (
            update(EmailMessage)
            .where(
                EmailMessage.company_id == company_id,
                any_of(EmailMessage.visit_id, visit_ids),
                EmailMessage.to_email == to_email,
                EmailMessage.calendar_method == EventMethod.REQUEST.value,
                EmailMessage.status == EmailStatus.PENDING.value,
            )
            .values(status=EmailStatus.FAILED.value, last_error=error, updated_at=now)
            .returning(EmailMessage.id)
            .execution_options(synchronize_session=False)
        )
        return len(self.db.scalars(statement).all())

    def queued_for_visit(self, company_id: UUID, visit_id: UUID, kind: EmailKind) -> bool:
        """Whether an e-mail of `kind` was ever queued for the visit, whatever became of it."""
        statement = select(EmailMessage.id).where(
            EmailMessage.company_id == company_id,
            EmailMessage.visit_id == visit_id,
            EmailMessage.kind == kind.value,
        )
        return self.db.scalars(statement.limit(1)).first() is not None

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
        return {
            row[0]: LatestEmail._make(row[1:]) for row in self.db.execute(statement) if row[0] is not None
        }


_LATEST_COLUMNS = (
    EmailMessage.kind,
    EmailMessage.status,
    EmailMessage.to_email,
    EmailMessage.attempts,
    EmailMessage.last_attempt_at,
    EmailMessage.sent_at,
    EmailMessage.last_error,
    EmailMessage.created_at,
    EmailMessage.calendar_method,
)
_CLOSED_COLUMNS = (
    EmailMessage.id,
    EmailMessage.company_id,
    EmailMessage.kind,
    EmailMessage.visit_id,
    EmailMessage.to_email,
    EmailMessage.attempts,
)
