"""Visit state changes shared by the visit service, the visitor service (D-19) and the D-18 host hook.

Every transaction that changes visits starts with `begin_visit_change` and then takes its row locks in
the order of `repositories.locking`. Callers hold the visit's row lock (`VisitRepository.lock*`, contract
§3.2-4) and have re-checked the NO_SHOW deadline (`no_shows.mark_if_expired`). Audit rows and e-mail jobs
are created only after the guarded write; the jobs are delivered after the caller's commit.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.request_context import RequestContext
from app.email.dispatcher import SUPERSEDED_ERROR, audit_closed_invitations
from app.email.service import DeliveryAudit, DeliveryJob
from app.models import Company, PassRevokeReason, Visit, VisitStatus
from app.repositories.companies import CompanyRepository
from app.repositories.email_messages import EmailMessageRepository
from app.repositories.locking import RowLock
from app.repositories.users import UserRepository
from app.repositories.visitors import VisitorRepository
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import require_still_authorized
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_no_shows_committed
from app.services.passes import IssuedPass, PassService
from app.services.scoping import require_found
from app.services.visit_rules import assert_transition


def begin_visit_change(db: Session, auth: AuthContext) -> Company:
    """The start of every transaction that changes visits or visitors: the company's NO_SHOW marking is
    committed first, so the change holds no visit rows it did not ask for, then the company row is
    share-locked, the first lock of the order in `repositories.locking`. A deactivation or a removal of
    roles holds that lock `FOR UPDATE` until it commits, so the caller is re-checked once it is held
    (SEC-07): a change authorized before the revocation does not run after it."""
    mark_no_shows_committed(db, auth.company_id, now=app_time.now())
    company = require_found(CompanyRepository(db).get(auth.company_id, lock=RowLock.KEY_SHARE))
    require_still_authorized(db, auth, now=app_time.now())
    return company


class VisitLifecycle:
    def __init__(self, db: Session, env: ServiceEnvironment) -> None:
        self.db = db
        self.env = env
        self.passes = PassService(db, settings=env.settings)
        self.emails = env.email_service(db)
        self.visitors = VisitorRepository(db)
        self.users = UserRepository(db)

    def visitor_email(self, visit: Visit) -> str | None:
        contact = self.visitors.contacts(visit.company_id, [visit.visitor_id]).get(visit.visitor_id)
        return contact.email if contact is not None else None

    def notice_recipient(self, visit: Visit) -> str | None:
        """Where a reschedule or cancellation notice goes: the visitor's address, and only when an
        invitation was requested for the visit (B24-25): a visitor who never got an e-mail from the
        system gets no notice out of nowhere."""
        return self.visitor_email(visit) if visit.invitation_requested else None

    def host_email(self, visit: Visit) -> str | None:
        """The host's address while the host is active: the visitor's replies reach the host (B24-71)."""
        return self.users.active_email(visit.company_id, visit.host_id)

    def booked_by(self, visit: Visit) -> str | None:
        """The name of whoever booked the visit, when that is not the host (B57-02): the invitation says
        it was sent on the host's behalf instead of putting the booker's words in the host's mouth."""
        if visit.created_by_id == visit.host_id:
            return None
        creator = self.users.summaries(visit.company_id, [visit.created_by_id]).get(visit.created_by_id)
        return creator.full_name if creator is not None else None

    def cancel(
        self,
        visit: Visit,
        *,
        company: Company,
        actor_id: UUID,
        reason: str | None,
        notify: bool,
        trigger: str,
        context: RequestContext,
        now: datetime,
    ) -> DeliveryJob | None:
        """SCHEDULED → CANCELLED: revoke the pass (VISIT_CANCELLED) and, when `notify` and the visit has a
        `notice_recipient`, queue the VISIT_CANCELLED e-mail with the reason."""
        assert_transition(visit.status, VisitStatus.CANCELLED)
        visit.status = VisitStatus.CANCELLED.value
        visit.cancelled_at = now
        visit.cancelled_by_id = actor_id
        visit.cancellation_reason = reason
        self.db.flush()
        self.passes.revoke_active(
            visit, reason=PassRevokeReason.VISIT_CANCELLED, actor_id=actor_id, context=context, now=now
        )
        recipient = self.notice_recipient(visit) if notify else None
        job = (
            self.emails.queue_visit_cancelled(
                visit, reason, company=company, recipient=recipient, host_email=self.host_email(visit)
            )
            if recipient is not None
            else None
        )
        audit.record(
            self.db,
            action=AuditAction.VISIT_CANCELLED,
            context=context,
            company_id=visit.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata={
                "trigger": trigger,
                "reason_given": reason is not None,
                "visitor_notified": job is not None,
                "email_message_id": job.message_id if job else None,
            },
        )
        return job

    def invite(
        self,
        visit: Visit,
        issued: IssuedPass,
        *,
        company: Company,
        recipient: str,
        actor_id: UUID,
        context: RequestContext,
    ) -> DeliveryJob:
        """Queue the invitation carrying `issued` (the pass just issued for this visit). The caller has
        reserved it in the user's invitation budget (`EmailQuota`).

        An earlier invitation of the visit still PENDING is closed (FAILED, audited INVITATION_FAILED
        `reason: superseded`): it carries the pass this one replaced, so a delivery that has not started
        yet must not send it, and it would otherwise stay PENDING for ever."""
        visit.invitation_requested = True
        superseded = EmailMessageRepository(self.db).close_pending_invitations(
            visit.company_id, visit.id, error=SUPERSEDED_ERROR, now=app_time.now()
        )
        audit_closed_invitations(self.db, superseded, reason="superseded", context=context)
        job = self.emails.queue_visitor_invitation(
            visit,
            issued.token,
            company=company,
            recipient=recipient,
            host_email=self.host_email(visit),
            booked_by=self.booked_by(visit),
            invitation_audit=DeliveryAudit(
                company_id=visit.company_id,
                entity_type=AuditEntity.VISIT,
                entity_id=visit.id,
                sent_action=AuditAction.INVITATION_SENT,
                failed_action=AuditAction.INVITATION_FAILED,
                request_id=context.request_id,
            ),
        )
        audit.record(
            self.db,
            action=AuditAction.INVITATION_QUEUED,
            context=context,
            company_id=visit.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata={"email_message_id": job.message_id, "pass_id": issued.pass_id},
        )
        return job
