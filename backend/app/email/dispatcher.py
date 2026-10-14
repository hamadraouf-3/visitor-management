"""Delivery of queued e-mails (contract §9).

`deliver(job)` runs after the request committed. It claims the row `WHERE id = :id AND status =
'PENDING'` through `session_factory` (so it only ever acts on committed data), tries the provider up to
three times for transient errors (backoff 1 s, 3 s), and records SENT (provider id, sent_at) or FAILED
(attempts, sanitized last_error, last_attempt_at). Provider calls never run inside a database
transaction. A job with a `DeliveryAudit` (invitations) also gets its outcome audited (e.g.
INVITATION_SENT / INVITATION_FAILED, with the recipient's domain only) in the same transaction as the
final status.

Deliveries never run in the request worker threads. A request schedules `deliver_in_background(job)`
(`schedule_delivery`), a Starlette background task that waits for one of the dispatcher's own
`concurrency` delivery slots (an anyio `CapacityLimiter` per event loop) and runs `deliver` in a worker
thread holding that slot. The sync routes and dependencies of every request (sessions, authentication,
GET /health) share anyio's default limiter of 40 threads; a provider that stops answering held one of
them for each queued message (up to 49 s each), and about 40 messages froze the whole API. Now a hanging
provider delays only e-mail. A message also has a deadline (`deadline_seconds`, 20 s from its first
attempt): every attempt is bounded by the time left (the provider's `timeout_seconds`), and no retry
starts with less than `MIN_ATTEMPT_SECONDS` left, so a provider that does not answer ends a message after
about 20 s (two attempts) instead of 49 s, while quick transient errors still get their three attempts.

The claim also refreshes the row's `updated_at`, and every failed attempt does too: a PENDING row whose
`updated_at` is older than `INTERRUPTED_AFTER` is not being delivered by anyone. `fail_interrupted`
(run by the application at startup and every minute) marks such rows FAILED, so a message lost with
its process (a crash, a kill after the grace period, a restart while the queue waited) shows up under
Needs attention instead of staying PENDING forever; a queued job whose row was failed meanwhile is
skipped by its claim instead of sending a message nobody is waiting for any more.
"""

import logging
import re
import time
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta

import anyio.to_thread
from anyio import CapacityLimiter
from anyio.lowlevel import RunVar
from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.request_context import RequestContext
from app.db.session import session_factory
from app.email.providers.base import EmailDeliveryError, EmailProvider, ProviderResult
from app.email.service import DeliveryJob, recipient_domain
from app.models import EmailKind, EmailStatus
from app.repositories.email_messages import ClosedMessage, EmailMessageRepository
from app.services import audit
from app.services.audit import AuditAction, AuditEntity

logger = logging.getLogger("app.email")

MAX_ATTEMPTS = 3
BACKOFF_SECONDS: tuple[float, ...] = (1.0, 3.0)
DELIVERY_CONCURRENCY = 4
DELIVERY_DEADLINE_SECONDS = 20.0
MIN_ATTEMPT_SECONDS = 2.0  # a retry with less time left than this is not started
# A PENDING row untouched for this long is not being delivered: a live delivery refreshes `updated_at`
# when it starts and after every failed attempt, and ends within its deadline (20 s).
INTERRUPTED_AFTER = timedelta(minutes=5)
INTERRUPTED_ERROR = "Sending was interrupted before it completed."
SUPERSEDED_ERROR = "Replaced by a newer invitation."
_LAST_ERROR_MAX = 500
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


def sanitize_error(message: str) -> str:
    return _CONTROL.sub(" ", message).strip()[:_LAST_ERROR_MAX] or "Delivery failed."


class EmailDispatcher:
    def __init__(
        self,
        provider: EmailProvider,
        *,
        sleep: Callable[[float], None] = time.sleep,
        max_attempts: int = MAX_ATTEMPTS,
        backoff_seconds: Sequence[float] = BACKOFF_SECONDS,
        concurrency: int = DELIVERY_CONCURRENCY,
        deadline_seconds: float = DELIVERY_DEADLINE_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_attempts < 1 or len(backoff_seconds) < max_attempts - 1:
            raise ValueError("backoff_seconds needs one entry per retry")
        if concurrency < 1:
            raise ValueError("concurrency must be at least 1")
        self.provider = provider
        self._sleep = sleep
        self._monotonic = monotonic
        self.max_attempts = max_attempts
        self.backoff_seconds = tuple(backoff_seconds)
        self.concurrency = concurrency
        self.deadline_seconds = deadline_seconds
        # One limiter per event loop (anyio primitives belong to the loop that created them; the test
        # client runs every request in a loop of its own).
        self._slots: RunVar[CapacityLimiter] = RunVar(f"email-delivery-slots-{id(self)}")

    def delivery_slots(self) -> CapacityLimiter:
        """This dispatcher's delivery slots in the running event loop."""
        try:
            return self._slots.get()
        except LookupError:
            slots = CapacityLimiter(self.concurrency)
            self._slots.set(slots)
            return slots

    async def deliver_in_background(self, job: DeliveryJob) -> EmailStatus | None:
        """`deliver(job)` in a worker thread holding one of the dispatcher's delivery slots, never a token
        of the default thread limiter that requests use."""
        return await anyio.to_thread.run_sync(self.deliver, job, limiter=self.delivery_slots())

    def deliver(self, job: DeliveryJob) -> EmailStatus | None:
        """Deliver one queued message. Returns the final status, or None if it was not PENDING."""
        with session_factory() as db:
            claimed = EmailMessageRepository(db).claim_pending(job.message_id, now=app_time.now())
            db.commit()
        if not claimed:
            logger.warning("email not pending; delivery skipped", extra={"message_id": str(job.message_id)})
            return None

        deadline = self._monotonic() + self.deadline_seconds
        for attempt in range(1, self.max_attempts + 1):
            try:
                result = self.provider.send(job.email, timeout_seconds=deadline - self._monotonic())
            except EmailDeliveryError as exc:
                error = exc
            except Exception:
                logger.exception(
                    "unexpected e-mail provider error", extra={"message_id": str(job.message_id)}
                )
                error = EmailDeliveryError("Unexpected error while sending.", transient=False)
            else:
                self._mark_sent(job, result)
                logger.info(
                    "email sent",
                    extra={
                        "message_id": str(job.message_id),
                        "kind": job.email.kind.value,
                        "attempt": attempt,
                    },
                )
                return EmailStatus.SENT

            backoff = self.backoff_seconds[attempt - 1] if attempt < self.max_attempts else 0.0
            past_deadline = deadline - (self._monotonic() + backoff) < MIN_ATTEMPT_SECONDS
            final = not error.transient or attempt == self.max_attempts or past_deadline
            self._record_failure(job, error, final=final)
            logger.warning(
                "email delivery failed",
                extra={
                    "message_id": str(job.message_id),
                    "kind": job.email.kind.value,
                    "attempt": attempt,
                    "transient": error.transient,
                    "final": final,
                    "past_deadline": past_deadline,
                },
            )
            if final:
                return EmailStatus.FAILED
            self._sleep(backoff)
        return EmailStatus.FAILED  # pragma: no cover - the loop always returns

    def _mark_sent(self, job: DeliveryJob, result: ProviderResult) -> None:
        with session_factory() as db:
            attempts = EmailMessageRepository(db).mark_sent(
                job.message_id, provider_message_id=result.provider_message_id, now=app_time.now()
            )
            if attempts is not None:
                self._audit(db, job, sent=True, attempts=attempts)
            db.commit()

    def _record_failure(self, job: DeliveryJob, error: EmailDeliveryError, *, final: bool) -> None:
        with session_factory() as db:
            attempts = EmailMessageRepository(db).record_failed_attempt(
                job.message_id, error=sanitize_error(str(error)), final=final, now=app_time.now()
            )
            if final and attempts is not None:
                self._audit(db, job, sent=False, attempts=attempts)
            db.commit()

    @staticmethod
    def _audit(db: Session, job: DeliveryJob, *, sent: bool, attempts: int) -> None:
        if job.audit is None:
            return
        audit.record(
            db,
            action=job.audit.sent_action if sent else job.audit.failed_action,
            context=RequestContext(ip_address=None, user_agent=None, request_id=job.audit.request_id),
            company_id=job.audit.company_id,
            actor_user_id=None,  # delivery is the system's doing; INVITATION_QUEUED names the requester
            entity_type=job.audit.entity_type,
            entity_id=job.audit.entity_id,
            metadata={
                "email_message_id": job.message_id,
                "recipient_domain": recipient_domain(job.email.to),
                "attempts": attempts,
            },
        )


def ensure_committed(db: Session) -> None:
    """Guard (contract §3.2-1): delivery is only scheduled once the creating transaction is committed."""
    if db.in_transaction():
        raise RuntimeError("commit the transaction that created the e-mail before scheduling its delivery")


def schedule_delivery(
    background_tasks: BackgroundTasks, db: Session, dispatcher: EmailDispatcher, job: DeliveryJob
) -> None:
    ensure_committed(db)
    background_tasks.add_task(dispatcher.deliver_in_background, job)


def schedule_deliveries(
    background_tasks: BackgroundTasks, db: Session, dispatcher: EmailDispatcher, jobs: Sequence[DeliveryJob]
) -> None:
    for job in jobs:
        schedule_delivery(background_tasks, db, dispatcher, job)


# ---- messages nobody is delivering any more ---------------------------------------------------------


def audit_closed_invitations(
    db: Session, closed: Sequence[ClosedMessage], *, reason: str, context: RequestContext | None = None
) -> None:
    """INVITATION_FAILED for each closed invitation, as the dispatcher writes for a failed one (IDs, the
    recipient's domain and the attempts only; no actor), with why it was closed and, when a request
    closed it, that request's context."""
    for message in closed:
        if message.kind != EmailKind.VISITOR_INVITATION.value or message.visit_id is None:
            continue
        audit.record(
            db,
            action=AuditAction.INVITATION_FAILED,
            context=context or RequestContext(ip_address=None, user_agent=None, request_id=None),
            company_id=message.company_id,
            actor_user_id=None,
            entity_type=AuditEntity.VISIT,
            entity_id=message.visit_id,
            metadata={
                "email_message_id": message.id,
                "recipient_domain": recipient_domain(message.to_email),
                "attempts": message.attempts,
                "reason": reason,
            },
        )


def fail_interrupted(*, now: datetime | None = None) -> list[ClosedMessage]:
    """Mark FAILED every PENDING message untouched for `INTERRUPTED_AFTER` (its delivery was lost with
    a process, or waited too long for a slot), with INVITATION_FAILED audit rows for invitations, in
    one transaction. Every company's rows: this is the system's own bookkeeping."""
    now = now or app_time.now()
    with session_factory() as db:
        closed = EmailMessageRepository(db).fail_stale_pending(
            older_than=now - INTERRUPTED_AFTER, error=INTERRUPTED_ERROR, now=now
        )
        audit_closed_invitations(db, closed, reason="interrupted")
        db.commit()
    if closed:
        logger.warning("interrupted e-mail deliveries marked failed", extra={"count": len(closed)})
    return closed
