"""Visit state changes shared by the visit service, the visitor service (D-19) and the D-18 host hook.

Every transaction that changes visits starts with `begin_visit_change` and then takes its row locks in
the order of `repositories.locking`. Callers hold the visit's row lock (`VisitRepository.lock*`, contract
§3.2-4) and have re-checked the NO_SHOW deadline (`no_shows.mark_if_expired`). Audit rows and e-mail jobs
are created only after the guarded write; the jobs are delivered after the caller's commit.

Calendars (Phase 14, B14-1, B14-2, B14-6, B14-10): the visit is an event of the visitor's and the host's
calendars, versioned by `visits.calendar_sequence`, which a new time and the cancellation raise by one.
The visitor's comes with every invitation, in a short e-mail of its own that follows it (`invite`), and
with the notices of a new time and of the cancellation; once the visitor's calendar holds the visit, its
cancellation always reaches the visitor (B14-16), and an address the visitor no longer has is sent its
withdrawal (`withdraw_visitor_event`, D-19, B14-17). The host is told of a new visit, of its new time
and of its cancellation (`HOST_VISIT_*`) while the account is active (and of the cancellations its
deactivation causes, B14-20), and of a change only when they were told of the visit (`host_to_tell`).

Which calendar holds the event is read from the e-mails that carried it (`calendar_state`, B14-26). Whether
an e-mail carries its event (`attach_event`): never to the sending mailbox (B14-5); with calendar
invitations switched off, only to a calendar that already holds the event, so no new entry is made and
none is left wrong (B14-27); and an event that adds or moves the visit counts against the company's
calendar events, beyond which a notice goes without it and an e-mail that is only the event is left out,
while an event that takes the visit out is never left out (B14-15, B14-28).
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.rate_limit import PolicyName
from app.core.request_context import RequestContext
from app.email.dispatcher import SUPERSEDED_ERROR, audit_closed_invitations
from app.email.service import DeliveryAudit, DeliveryJob
from app.models import Company, EmailKind, PassRevokeReason, User, Visit, VisitStatus
from app.repositories.companies import CompanyRepository
from app.repositories.email_messages import (
    HOST_EVENT_KINDS,
    VISITOR_EVENT_KINDS,
    EmailMessageRepository,
    LatestEmail,
)
from app.repositories.locking import RowLock
from app.repositories.users import UserRepository
from app.repositories.visitors import VisitorRepository
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import require_still_authorized
from app.services.calendar_state import failed_calendar_invitation, holds_event, messages_to
from app.services.email_quota import QuotaUnit
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


@dataclass(frozen=True, slots=True)
class Notice:
    """An e-mail a change sends one person, as its audit row records it: the job, if the e-mail went;
    the budget that left it out, or left its event out (`limited_by`); whether it carries the person's
    event (`calendar`)."""

    job: DeliveryJob | None
    limited_by: PolicyName | None = None
    calendar: bool = False


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

    @property
    def calendars_on(self) -> bool:
        """Whether calendar invitations are switched on (CALENDAR_INVITATIONS_ENABLED, B14-27)."""
        return self.env.settings.calendar_invitations_enabled

    def visitor_events(self, visits: Collection[Visit], address: str | None) -> dict[UUID, list[LatestEmail]]:
        """The visitor's events of each of `visits` (of one company) sent to `address`'s mailbox, oldest
        first (`calendar_state.messages_to`)."""
        if address is None or not visits:
            return {visit.id: [] for visit in visits}
        company_id = next(iter(visits)).company_id
        events = EmailMessageRepository(self.db).event_messages(
            company_id, [visit.id for visit in visits], VISITOR_EVENT_KINDS
        )
        return {visit.id: messages_to(events, visit.id, address) for visit in visits}

    def holders(self, visits: Collection[Visit], address: str | None) -> set[UUID]:
        """The visits among `visits` whose event the calendar of `address` holds (B14-16, B14-26): the
        last event it was sent of the visit is a REQUEST, whatever became of that e-mail."""
        return {
            visit_id for visit_id, sent in self.visitor_events(visits, address).items() if holds_event(sent)
        }

    def host_holds(self, visit: Visit, host: User) -> bool:
        """Whether the host's calendar holds the host's event of the visit (B14-26)."""
        events = EmailMessageRepository(self.db).event_messages(
            visit.company_id, [visit.id], HOST_EVENT_KINDS
        )
        return holds_event(messages_to(events, visit.id, host.email))

    def calendar_failed(self, visit: Visit, address: str) -> bool:
        """Whether only the calendar invitation that followed the visit's latest invitation to `address`
        failed (`Visit.invitation.calendar_failed`, B14-18)."""
        invitation = (
            EmailMessageRepository(self.db).latest_invitations(visit.company_id, [visit.id]).get(visit.id)
        )
        sent = self.visitor_events([visit], address)[visit.id]
        return failed_calendar_invitation(sent, invitation) is not None

    def attach_event(
        self, address: str, *, holds: bool, removal: bool, company: Company, quota: QuotaUnit
    ) -> tuple[bool, PolicyName | None]:
        """Whether an e-mail to `address` carries its event, and the budget that left the event out:
        never to the sending mailbox, its organizer (B14-5); with calendar invitations off only to a
        calendar that holds the event (`holds`: a new time or a removal, never a new entry, B14-27); an
        event that adds or moves the visit is one of the company's calendar events and is left out beyond
        them (B14-28); a removal is never left out and counts while there is room (B14-15)."""
        if self.emails.sends_from(address) or not (self.calendars_on or holds):
            return False, None
        if removal:
            quota.calendar_removal(company.id)
            return True, None
        limited_by = quota.calendar_event(company.id)
        return limited_by is None, limited_by

    def host_to_tell(self, visit: Visit, *, of_a_change: bool, deactivated: bool = False) -> User | None:
        """The host who gets the host's e-mail of the visit (B14-2): the visit's host while the account is
        active (a deactivated account is sent nothing, as everywhere), or, with `deactivated`, the host
        whose deactivation cancels the visit (D-18): the entries leave the calendar of the account it
        stops, as they leave the calendar of a host who loses the host role (B14-20). Of a new time or the
        cancellation (`of_a_change`) only a host who was told of the visit: one booked before the host's
        e-mails existed gets no notice of a change out of nowhere, as a visitor never invited gets none
        (B24-25)."""
        host = self.users.get_in_company(visit.company_id, visit.host_id)
        if host is None or not (host.is_active or deactivated):
            return None
        if of_a_change and not EmailMessageRepository(self.db).queued_for_visit(
            visit.company_id, visit.id, EmailKind.HOST_VISIT_SCHEDULED
        ):
            return None
        return host

    def tell_host(
        self,
        visit: Visit,
        kind: EmailKind,
        *,
        company: Company,
        host: User | None,
        quota: QuotaUnit,
        actor_id: UUID,
        reason: str | None = None,
    ) -> Notice:
        """The host's e-mail of the visit to `host` (`host_to_tell` chose the host; None: nobody), within
        the acting user's host e-mails (B14-15).

        The notice of a new visit is there for the host's event (B14-28): with calendar invitations off it
        is not sent (B14-27), and it counts against the company's calendar events with the host's budget,
        both or neither, so beyond either it is left out (to the sending mailbox it goes without the event,
        within the host's budget alone). The notices of a new time and of the cancellation are notices:
        they carry the event where `attach_event` lets them, and go without it otherwise."""
        if host is None:
            return Notice(None)
        if kind == EmailKind.HOST_VISIT_SCHEDULED:
            if not self.calendars_on:
                return Notice(None)
            calendar = not self.emails.sends_from(host.email)
            limited_by = (
                quota.host_new_visit_notice(actor_id, company.id)
                if calendar
                else quota.host_visit_notice(actor_id)
            )
            if limited_by is not None:
                return Notice(None, limited_by)
        else:
            limited_by = quota.host_visit_notice(actor_id)
            if limited_by is not None:
                return Notice(None, limited_by)
            calendar, limited_by = self.attach_event(
                host.email,
                holds=self.host_holds(visit, host),
                removal=kind == EmailKind.HOST_VISIT_CANCELLED,
                company=company,
                quota=quota,
            )
        job = self.emails.queue_host_visit(
            visit,
            kind=kind,
            company=company,
            host=host,
            booked_by=self.booked_by(visit),
            reason=reason,
            calendar=calendar,
        )
        return Notice(job, limited_by, calendar)

    def tell_visitor_of_new_time(
        self, visit: Visit, *, company: Company, quota: QuotaUnit, actor_id: UUID
    ) -> Notice:
        """D-22: the visitor whose invitation was requested is told the new time (`notice_recipient`),
        within the reschedule budgets (beyond them the notice is left out), with the visitor's event at
        the new time where `attach_event` lets it go: beyond the company's calendar events, or with
        calendar invitations off to a calendar that does not hold the visit, the notice goes without it
        (B14-28)."""
        recipient = self.notice_recipient(visit)
        if recipient is None:
            return Notice(None)
        limited_by = quota.reschedule_notice(actor_id, visit.id)
        if limited_by is not None:
            return Notice(None, limited_by)
        calendar, limited_by = self.attach_event(
            recipient,
            holds=visit.id in self.holders([visit], recipient),
            removal=False,
            company=company,
            quota=quota,
        )
        job = self.emails.queue_visit_rescheduled(
            visit, company=company, recipient=recipient, host_email=self.host_email(visit), calendar=calendar
        )
        return Notice(job, limited_by, calendar)

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
        quota: QuotaUnit,
        host_deactivated: bool = False,
    ) -> tuple[DeliveryJob, ...]:
        """SCHEDULED → CANCELLED: revoke the pass (VISIT_CANCELLED) and, when the visit has a
        `notice_recipient`, queue the VISIT_CANCELLED e-mail with the reason if `notify` asks for it, and
        whatever `notify` says when that address's calendar holds the visit: a cancelled visit always
        leaves the visitor's calendar (B14-16). That one carries no reason: the caller asked that the
        visitor not be told (B14-32). No budget leaves it out (each follows a counted invitation,
        B14-15). Whatever `notify` says (it is about the visitor), the host who was told of the visit is
        told of its cancellation, so the entry leaves the host's calendar (B14-2), within the budgets of
        the host's e-mails; `host_deactivated`: the host's deactivation cancels it (D-18, B14-20). Each
        carries the cancellation of its event, one version newer (B14-6), where `attach_event` lets it.
        Returns the visitor's e-mail job, if any, before the host's."""
        assert_transition(visit.status, VisitStatus.CANCELLED)
        visit.status = VisitStatus.CANCELLED.value
        visit.cancelled_at = now
        visit.cancelled_by_id = actor_id
        visit.cancellation_reason = reason
        visit.calendar_sequence += 1
        self.db.flush()
        self.passes.revoke_active(
            visit, reason=PassRevokeReason.VISIT_CANCELLED, actor_id=actor_id, context=context, now=now
        )
        recipient = self.notice_recipient(visit)
        holds = visit.id in self.holders([visit], recipient)
        job: DeliveryJob | None = None
        if recipient is not None and (notify or holds):
            calendar, _ = self.attach_event(
                recipient, holds=holds, removal=True, company=company, quota=quota
            )
            job = self.emails.queue_visit_cancelled(
                visit,
                reason if notify else None,
                company=company,
                recipient=recipient,
                host_email=self.host_email(visit),
                calendar=calendar,
            )
        host = self.tell_host(
            visit,
            EmailKind.HOST_VISIT_CANCELLED,
            company=company,
            host=self.host_to_tell(visit, of_a_change=True, deactivated=host_deactivated),
            quota=quota,
            actor_id=actor_id,
            reason=reason,
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
                "host_notified": host.job is not None,
                "host_notice_limited_by": host.limited_by,
            },
        )
        return tuple(sent for sent in (job, host.job) if sent is not None)

    def withdraw_visitor_event(self, visit: Visit, *, company: Company, address: str) -> DeliveryJob:
        """D-19 (B14-17): the visitor no longer has `address`, whose calendar holds the visit
        (`holders`). The visit's version is raised and `address` is sent the withdrawal of the visitor's
        event, so the event leaves that calendar; the caller raises the version again before the new
        address's invitation, so that one is newer than the withdrawal (B14-30). The caller counts it in
        the editor's invitations and the company's calendar events while they have room
        (`QuotaUnit.withdrawal`); no budget leaves it out."""
        visit.calendar_sequence += 1
        return self.emails.queue_visitor_withdrawal(visit, company=company, recipient=address)

    def resend_calendar(
        self, visit: Visit, *, company: Company, recipient: str, actor_id: UUID, context: RequestContext
    ) -> DeliveryJob:
        """B14-31: the calendar invitation alone, sent again because it failed while the invitation went
        out (`calendar_failed`): the same version of the visitor's event, a new DTSTAMP; the pass is not
        replaced and no invitation is sent. The caller has reserved it (`QuotaUnit.calendar_resend`).
        Audited as INVITATION_QUEUED without a pass (`pass_id` null, `calendar_sent` true)."""
        job = self.emails.queue_visitor_calendar(
            visit, company=company, recipient=recipient, host_email=self.host_email(visit)
        )
        audit.record(
            self.db,
            action=AuditAction.INVITATION_QUEUED,
            context=context,
            company_id=visit.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata={
                "email_message_id": job.message_id,
                "pass_id": None,
                "calendar_sent": True,
                "notice_limited_by": None,
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
        quota: QuotaUnit,
    ) -> tuple[DeliveryJob, ...]:
        """Queue the invitation carrying `issued` (the pass just issued for this visit), then its
        calendar invitation (B14-10), the visitor's event without the pass, which is delivered after it.
        The caller has reserved the invitation in the user's invitation budget (`EmailQuota`); the
        calendar invitation goes where `attach_event` lets an event go and is left out otherwise
        (INVITATION_QUEUED says so): not to the sending mailbox itself, the event's organizer (B14-5), not
        beyond the company's calendar events (B14-15), and with calendar invitations off only to a
        calendar that already holds the visit (B14-27). Returns the invitation's job first.

        An earlier invitation of the visit still PENDING is closed (FAILED, audited INVITATION_FAILED
        `reason: superseded`): it carries the pass this one replaced, so a delivery that has not started
        yet must not send it, and it would otherwise stay PENDING for ever."""
        visit.invitation_requested = True
        superseded = EmailMessageRepository(self.db).close_pending_invitations(
            visit.company_id, visit.id, error=SUPERSEDED_ERROR, now=app_time.now()
        )
        audit_closed_invitations(self.db, superseded, reason="superseded", context=context)
        host_email = self.host_email(visit)
        job = self.emails.queue_visitor_invitation(
            visit,
            issued.token,
            company=company,
            recipient=recipient,
            host_email=host_email,
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
        calendar: DeliveryJob | None = None
        send, limited_by = self.attach_event(
            recipient,
            holds=visit.id in self.holders([visit], recipient),
            removal=False,
            company=company,
            quota=quota,
        )
        if send:
            calendar = self.emails.queue_visitor_calendar(
                visit, company=company, recipient=recipient, host_email=host_email
            )
        audit.record(
            self.db,
            action=AuditAction.INVITATION_QUEUED,
            context=context,
            company_id=visit.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata={
                "email_message_id": job.message_id,
                "pass_id": issued.pass_id,
                "calendar_sent": calendar is not None,
                "notice_limited_by": limited_by,
            },
        )
        return (job,) if calendar is None else (job, calendar)
