"""Visits (contract §5, §6, §7.5, §8 /visits, D-14, D-16, D-22).

Reading: SYSTEM_ADMIN, RECEPTIONIST and MANAGEMENT read every visit of the company; an EMPLOYEE-only
caller reads the visits they host or created (forced: `scope` and `host_id` only ever narrow). A visit
outside the caller's scope is 404, an out-of-scope ID in a body or filter a 422 field error.

Changing (update, cancel, resend, reissue the pass): administrators for any visit, hosts for visits they
own; only SCHEDULED visits. Every change starts with `begin_visit_change` (the company's NO_SHOW marking,
then the company row lock), locks the visit (`SELECT … FOR UPDATE` by id and company; an update
share-locks the department the visit moves into before that), re-checks the NO_SHOW deadline under the
lock, validates the transition and only then writes. Row locks follow the order of
`repositories.locking`.

Creating: the host is the caller, unless the caller is an administrator, who may invite on behalf of any
active host (B10-24, §7.5 "EMPLOYEE: themselves as host only"); otherwise 422 `host_must_be_self` on
`host_id`. Creating always issues a pass; its URL is returned once (`pass_url`). The rows the new visit
depends on are locked first (host, department, visitor), so a concurrent deactivation (D-18) or address
change (D-19) either sees the new visit or is seen by it. The invitation e-mail is queued only on request (it
needs the visitor's e-mail address) and is delivered after the commit; a delivery failure never undoes
the visit. A reschedule keeps the pass (D-22) and tells the visitor by e-mail when an invitation had been
requested; a resend rotates the pass, and so does a pass reissued for the host to share (no e-mail).
Visitor e-mails, the host's e-mails of a visit and pass replacements count against the budgets of
`EmailQuota` (B14-15).
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import Forbidden, NotFound, VisitNotEditable, VisitorEmailRequired
from app.core.request_context import RequestContext
from app.core.search import normalise_search_text, phone_query_digits
from app.core.time import company_date_filter_bounds
from app.email.service import DeliveryJob
from app.models import Company, EmailKind, PassRevokeReason, User, Visit, VisitStatus
from app.repositories.departments import DepartmentRepository
from app.repositories.locking import RowLock
from app.repositories.users import UserRepository
from app.repositories.visitors import VisitorRepository
from app.repositories.visits import VisitFilters, VisitRepository
from app.schemas.common import Paginated
from app.schemas.visits import Visit as VisitOut
from app.schemas.visits import (
    VisitCancel,
    VisitCreate,
    VisitCreateResult,
    VisitListQuery,
    VisitorMatch,
    VisitPassResult,
    VisitResendResult,
    VisitUpdate,
)
from app.security.permissions import Capability, has_capability, is_host
from app.security.sessions import AuthContext
from app.services import audit, visit_rules
from app.services.audit import AuditAction, AuditEntity
from app.services.departments import assignable_department
from app.services.email_quota import QuotaUnit
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_if_expired, mark_no_shows_committed
from app.services.results import Mutation
from app.services.scoping import FieldErrors, require_found, visit_read_owner, visitor_read_owner
from app.services.visit_lifecycle import VisitLifecycle, begin_visit_change
from app.services.visit_references import (
    HOST_MUST_BE_SELF,
    HOST_NOT_AVAILABLE,
    active_host,
    visit_department,
)
from app.services.visit_rules import Caller
from app.services.visit_views import Viewer, VisitViewBuilder
from app.services.visitors import VisitorResolver

__all__ = ["HOST_MUST_BE_SELF", "HOST_NOT_AVAILABLE", "VisitsService"]


class VisitsService:
    def __init__(self, db: Session, env: ServiceEnvironment) -> None:
        self.db = db
        self.env = env
        self.visits = VisitRepository(db)
        self.users = UserRepository(db)
        self.departments = DepartmentRepository(db)
        self.visitors = VisitorRepository(db)
        self.resolver = VisitorResolver(db)
        self.lifecycle = VisitLifecycle(db, env)
        self.quota = env.email_quota()

    # ---- reads ----------------------------------------------------------------------------------

    def list_visits(self, auth: AuthContext, query: VisitListQuery) -> Paginated[VisitOut]:
        now = app_time.now()
        viewer = Viewer.of(auth)
        filters = self._filters(auth, query, viewer)
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        owner_id, nothing = self._list_owner(auth, query)
        if nothing:
            return Paginated[VisitOut](items=[], page=query.page, page_size=query.page_size, total=0)
        result = self.visits.search(
            auth.company_id, owner_id=owner_id, filters=filters, page=query.page, page_size=query.page_size
        )
        return Paginated[VisitOut](
            items=VisitViewBuilder(self.db, viewer, now=now).build(result.items),
            page=result.page,
            page_size=result.page_size,
            total=result.total,
        )

    def get_visit(self, auth: AuthContext, visit_id: UUID) -> VisitOut:
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        visit = require_found(self.visits.get(auth.company_id, visit_id, owner_id=visit_read_owner(auth)))
        return VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit)

    # ---- create ---------------------------------------------------------------------------------

    def create_visit(
        self, auth: AuthContext, data: VisitCreate, context: RequestContext
    ) -> Mutation[VisitCreateResult]:
        """Locks: company (shared), host, department and visitor (`FOR KEY SHARE`, read under the lock),
        before the visit is written."""
        company = begin_visit_change(self.db, auth)
        now = app_time.now()
        errors = FieldErrors()
        host = self._chosen_host(auth, data.host_id, errors)
        department = visit_department(self.departments, auth.company_id, data.department_id, host, errors)
        for field, message in visit_rules.schedule_problems(
            data.scheduled_start, data.scheduled_end, now=now
        ).items():
            errors.add(field, message)
        choice = self.resolver.choose(auth, data, errors)
        errors.raise_if_any()
        if host is None:  # excluded by `raise_if_any`; narrows the type
            raise NotFound()
        if data.send_invitation and choice.email is None:
            raise VisitorEmailRequired()

        with self.quota.unit() as quota:
            if data.send_invitation:
                quota.invitations(auth.user_id)
            resolved = self.resolver.resolve(auth, choice, context=context, now=now)
            # Read from the locked visitor row: an address change committed while this request waited
            # is the one the invitation goes to.
            recipient = resolved.visitor.email
            if data.send_invitation and recipient is None:
                raise VisitorEmailRequired()
            window_start, window_end = visit_rules.visit_window(
                data.scheduled_start,
                data.scheduled_end,
                grace_before_minutes=company.pass_grace_before_minutes,
                grace_after_minutes=company.pass_grace_after_minutes,
            )
            visit = self.visits.add(
                Visit(
                    company_id=auth.company_id,
                    visitor_id=resolved.visitor.id,
                    host_id=host.id,
                    created_by_id=auth.user_id,
                    department_id=department.id if department else None,
                    purpose=data.purpose,
                    scheduled_start=data.scheduled_start,
                    scheduled_end=data.scheduled_end,
                    window_start=window_start,
                    window_end=window_end,
                    status=VisitStatus.SCHEDULED.value,
                    invitation_requested=data.send_invitation,
                    visitor_link_in_scope=resolved.in_scope,
                    visitor_name=resolved.snapshot_name,
                    visitor_company_name=resolved.snapshot_company_name,
                    host_name=host.full_name,
                    department_name=department.name if department else None,
                    department_name_ar=department.name_ar if department else None,
                    created_at=now,
                    updated_at=now,
                )
            )
            # The host is told of the visit, with it as an event of the host's calendar (B14-2), whoever
            # booked it and whether or not the visitor is invited by e-mail, within the budgets of the
            # host's e-mails (B14-15), while calendar invitations are on (B14-27). It is delivered after the
            # visitor's e-mails; it is reserved first (B14-15).
            host_notice = self.lifecycle.tell_host(
                visit,
                EmailKind.HOST_VISIT_SCHEDULED,
                company=company,
                host=host,
                quota=quota,
                actor_id=auth.user_id,
            )
            self._audit(
                auth,
                AuditAction.VISIT_CREATED,
                visit,
                context,
                {
                    "visitor_id": visit.visitor_id,
                    "host_id": visit.host_id,
                    "department_id": visit.department_id,
                    "visitor_reused": resolved.reused,
                    "visitor_link_in_scope": resolved.in_scope,
                    "invitation_requested": data.send_invitation,
                    "host_notified": host_notice.job is not None,
                    "host_notice_limited_by": host_notice.limited_by,
                },
            )
            issued = self.lifecycle.passes.issue(
                visit, company=company, actor_id=auth.user_id, context=context, now=now
            )
            jobs: tuple[DeliveryJob, ...] = ()
            if data.send_invitation and recipient is not None:
                jobs = self.lifecycle.invite(
                    visit,
                    issued,
                    company=company,
                    recipient=recipient,
                    actor_id=auth.user_id,
                    context=context,
                    quota=quota,
                )
            jobs += () if host_notice.job is None else (host_notice.job,)
            payload = VisitCreateResult(
                visit=VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit),
                pass_url=issued.url,
                visitor_match=VisitorMatch(reused=resolved.reused),
            )
            self.db.commit()
        return Mutation(payload, jobs)

    # ---- change ---------------------------------------------------------------------------------

    def update_visit(
        self, auth: AuthContext, visit_id: UUID, data: VisitUpdate, context: RequestContext
    ) -> Mutation[VisitOut]:
        """Locks: company (shared), the requested department (shared), then the visit
        (`repositories.locking`)."""
        company = begin_visit_change(self.db, auth)
        # The department a visit moves into is read under its lock, taken before the visit's. A rename
        # or deactivation holds the department `FOR UPDATE` while it refreshes that department's
        # SCHEDULED visits (D-17), and this visit is not among them until this change commits: either
        # that change committed first and is seen here, or it waits for this one. Problems with the
        # department are reported only once the visit is known to change department, after the checks
        # of the visit itself (404, 403, 409 come first).
        department_problems = FieldErrors()
        requested_department = (
            assignable_department(
                self.departments,
                auth.company_id,
                data.department_id,
                department_problems,
                lock=RowLock.KEY_SHARE,
            )
            if "department_id" in data.model_fields_set
            else None
        )
        with self.quota.unit() as quota:
            visit, now = self._lock_manageable(auth, visit_id)
            if visit.status != VisitStatus.SCHEDULED:
                raise VisitNotEditable()

            supplied = data.model_fields_set
            start = data.scheduled_start if data.scheduled_start is not None else visit.scheduled_start
            end = data.scheduled_end if data.scheduled_end is not None else visit.scheduled_end
            schedule_changes = [
                name
                for name, old, new in (
                    ("scheduled_start", visit.scheduled_start, start),
                    ("scheduled_end", visit.scheduled_end, end),
                )
                if old != new
            ]
            rescheduled = bool(schedule_changes)
            errors = FieldErrors()
            if rescheduled:
                for field, message in visit_rules.schedule_problems(
                    start, end, now=now, check_start=start != visit.scheduled_start
                ).items():
                    errors.add(field, message)
            department_changed = "department_id" in supplied and data.department_id != visit.department_id
            if department_changed:
                errors.include(department_problems)
            errors.raise_if_any()

            changed: list[str] = []
            if data.purpose is not None and data.purpose != visit.purpose:
                visit.purpose = data.purpose
                changed.append("purpose")
            if department_changed:
                visit.department_id = requested_department.id if requested_department else None
                changed.append("department_id")
            if rescheduled:
                visit.scheduled_start, visit.scheduled_end = start, end
                visit.window_start, visit.window_end = visit_rules.visit_window(
                    start,
                    end,
                    grace_before_minutes=company.pass_grace_before_minutes,
                    grace_after_minutes=company.pass_grace_after_minutes,
                )
                # A new version of the visit's calendar event (B14-6), whether or not anyone is told.
                visit.calendar_sequence += 1
                changed += schedule_changes
            builder = VisitViewBuilder(self.db, Viewer.of(auth), now=now)
            if not changed:
                payload = builder.one(visit)
                self.db.commit()
                return Mutation(payload)

            self._refresh_snapshots(visit)
            self.db.flush()
            self._audit(auth, AuditAction.VISIT_UPDATED, visit, context, {"changed_fields": changed})
            jobs: tuple[DeliveryJob, ...] = ()
            if rescheduled:
                jobs = self._announce_reschedule(auth, visit, company, quota, context)
            payload = builder.one(visit)
            self.db.commit()
        return Mutation(payload, jobs)

    def cancel_visit(
        self, auth: AuthContext, visit_id: UUID, data: VisitCancel, context: RequestContext
    ) -> Mutation[VisitOut]:
        """The visitor is told only when an invitation was requested for the visit (B24-25): a notice
        goes out at most once per invited visit, so the invitation budget bounds these e-mails. Once the
        visitor's calendar was sent the visit it is told whatever `notify_visitor` says (B14-16). The
        host's e-mail counts against the budgets of `EmailQuota` (B14-15)."""
        company = begin_visit_change(self.db, auth)
        with self.quota.unit() as quota:
            visit, now = self._lock_manageable(auth, visit_id)
            jobs = self.lifecycle.cancel(
                visit,
                company=company,
                actor_id=auth.user_id,
                reason=data.reason,
                notify=data.notify_visitor,
                trigger="user",
                context=context,
                now=now,
                quota=quota,
            )
            payload = VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit)
            self.db.commit()
        return Mutation(payload, jobs)

    def resend_invitation(
        self, auth: AuthContext, visit_id: UUID, context: RequestContext
    ) -> Mutation[VisitResendResult]:
        """Rotate the pass (the previous QR code stops working, D-10) and send a new invitation; or, when
        only the calendar invitation failed (`Visit.invitation.calendar_failed`, B14-18), send the calendar
        invitation alone again (B14-31): the visitor has the pass, which stays valid, and the response's
        `pass_url` is null."""
        company = begin_visit_change(self.db, auth)
        with self.quota.unit() as quota:
            visit, now = self._lock_manageable(auth, visit_id)
            if visit.status != VisitStatus.SCHEDULED:
                raise VisitNotEditable()
            recipient = self.lifecycle.visitor_email(visit)
            if recipient is None:
                raise VisitorEmailRequired()
            if self.lifecycle.calendar_failed(visit, recipient) and not self.lifecycle.emails.sends_from(
                recipient
            ):
                quota.calendar_resend(auth.user_id, visit.id, company.id)
                calendar = self.lifecycle.resend_calendar(
                    visit, company=company, recipient=recipient, actor_id=auth.user_id, context=context
                )
                resent = VisitResendResult(
                    visit=VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit),
                    pass_url=None,
                    visitor_match=VisitorMatch(reused=False),
                )
                self.db.commit()
                return Mutation(resent, (calendar,))
            quota.invitations(auth.user_id, resend_of=visit.id)

            issued = self.lifecycle.passes.replace(
                visit,
                company=company,
                reason=PassRevokeReason.ROTATED,
                actor_id=auth.user_id,
                context=context,
                now=now,
            )
            jobs = self.lifecycle.invite(
                visit,
                issued,
                company=company,
                recipient=recipient,
                actor_id=auth.user_id,
                context=context,
                quota=quota,
            )
            payload = VisitResendResult(
                visit=VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit),
                pass_url=issued.url,
                visitor_match=VisitorMatch(reused=False),
            )
            self.db.commit()
        return Mutation(payload, jobs)

    def reissue_pass(self, auth: AuthContext, visit_id: UUID, context: RequestContext) -> VisitPassResult:
        """Rotate the pass and return its one-time URL without sending anything (B57-04): the host shares
        it themselves, e.g. for a visitor without an e-mail address whose first link was never shared.
        The previous QR code stops working (D-10). Audited as PASS_REVOKED + PASS_ISSUED."""
        company = begin_visit_change(self.db, auth)
        with self.quota.unit() as quota:
            visit, now = self._lock_manageable(auth, visit_id)
            if visit.status != VisitStatus.SCHEDULED:
                raise VisitNotEditable()
            quota.pass_rotation(visit.id)
            issued = self.lifecycle.passes.replace(
                visit,
                company=company,
                reason=PassRevokeReason.ROTATED,
                actor_id=auth.user_id,
                context=context,
                now=now,
            )
            payload = VisitPassResult(
                visit=VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit), pass_url=issued.url
            )
            self.db.commit()
        return payload

    # ---- helpers --------------------------------------------------------------------------------

    def _chosen_host(self, auth: AuthContext, host_id: UUID, errors: FieldErrors) -> User | None:
        """The new visit's host: the caller themselves, or for an administrator any active host (B10-24).
        Another user named by a caller who is not an administrator is refused before it is looked up, so
        the answer says nothing about that user."""
        if host_id != auth.user_id and not has_capability(auth.roles, Capability.INVITE_FOR_ANY_HOST):
            errors.add("host_id", HOST_MUST_BE_SELF)
            return None
        return active_host(self.users, auth.company_id, host_id, errors)

    def _list_owner(self, auth: AuthContext, query: VisitListQuery) -> tuple[UUID | None, bool]:
        """(owner filter, nothing visible). EMPLOYEE-only callers are always limited to their own
        visits; `scope=mine` narrows anyone to the visits they own (none for a non-host)."""
        forced = visit_read_owner(auth)
        if forced is not None:
            return forced, False
        if query.scope == "mine":
            return (auth.user_id, False) if is_host(auth.roles) else (None, True)
        return None, False

    def _filters(self, auth: AuthContext, query: VisitListQuery, viewer: Viewer) -> VisitFilters:
        """Resolve the filter IDs within the company (422 when unknown, §3.2-5) and turn company-local
        dates into instants."""
        errors = FieldErrors()
        company_id = auth.company_id
        if query.host_id is not None:
            errors.require(self.users.get_in_company(company_id, query.host_id), "host_id")
        if query.department_id is not None:
            errors.require(self.departments.get(company_id, query.department_id), "department_id")
        if query.visitor_id is not None:
            errors.require(
                self.visitors.get(company_id, query.visitor_id, owner_id=visitor_read_owner(auth)),
                "visitor_id",
            )
        errors.raise_if_any()
        starts_from, starts_before = company_date_filter_bounds(
            query.date_from, query.date_to, viewer.timezone
        )
        return VisitFilters(
            statuses=tuple(query.status),
            starts_from=starts_from,
            starts_before=starts_before,
            host_id=query.host_id,
            visitor_id=query.visitor_id,
            department_id=query.department_id,
            needs_attention=query.needs_attention,
            search=query.q,
            search_folded=(normalise_search_text(query.q) or None) if query.q else None,
            phone_digits=phone_query_digits(query.q) if query.q else None,
            newest_first=query.order != "asc",
        )

    def _lock_manageable(self, auth: AuthContext, visit_id: UUID) -> tuple[Visit, datetime]:
        """Lock a visit the caller may change: 404 outside the read scope, 403 when readable but not
        owned (e.g. MANAGEMENT + EMPLOYEE on someone else's visit). Marks it NO_SHOW if its window
        ended. Returns the visit and the instant the change happens at: read after the lock was
        granted, so a change that waited for another one is also stamped after it."""
        visit = require_found(self.visits.lock(auth.company_id, visit_id, owner_id=visit_read_owner(auth)))
        now = app_time.now()
        caller = Caller(user_id=auth.user_id, roles=auth.roles)
        if not visit_rules.can_manage_visit(caller, host_id=visit.host_id, created_by_id=visit.created_by_id):
            raise Forbidden()
        mark_if_expired(self.db, visit, now=now)
        return visit, now

    def _refresh_snapshots(self, visit: Visit) -> None:
        """D-17: a SCHEDULED visit's snapshots follow their sources. The visitor's stay as typed when the
        visit was linked by reuse outside its creator's scope (B24-15)."""
        if visit.visitor_link_in_scope:
            visitor = require_found(self.visitors.get(visit.company_id, visit.visitor_id))
            visit.visitor_name = visitor.full_name
            visit.visitor_company_name = visitor.company_name
        host = require_found(self.users.get_in_company(visit.company_id, visit.host_id))
        visit.host_name = host.full_name
        department = (
            self.departments.get(visit.company_id, visit.department_id) if visit.department_id else None
        )
        visit.department_name = department.name if department else None
        visit.department_name_ar = department.name_ar if department else None

    def _announce_reschedule(
        self, auth: AuthContext, visit: Visit, company: Company, quota: QuotaUnit, context: RequestContext
    ) -> tuple[DeliveryJob, ...]:
        """D-22: the pass stays valid; a visitor who was (to be) invited by e-mail is told the new time,
        and so is the host who was told of the visit (B14-2), each with their calendar event at the new
        time where it may go. Each within its own budgets (`EmailQuota`, B14-15): the visitor's in the
        reschedule-notice budgets, the host's in the host's e-mails, not in the visit's reschedule
        notices, so a quick fourth correction still moves the host's calendar. Beyond a budget the new
        time stands and that e-mail is left out; beyond the company's calendar events, or with calendar
        invitations off to a calendar without the visit, the notice goes without its event (B14-27,
        B14-28). The audit row says which: `visitor_notified` / `host_notified`, `calendar_sent` /
        `host_calendar_sent`, and the budget that limited either (`notice_limited_by`,
        `host_notice_limited_by`)."""
        visitor = self.lifecycle.tell_visitor_of_new_time(
            visit, company=company, quota=quota, actor_id=auth.user_id
        )
        host = self.lifecycle.tell_host(
            visit,
            EmailKind.HOST_VISIT_RESCHEDULED,
            company=company,
            host=self.lifecycle.host_to_tell(visit, of_a_change=True),
            quota=quota,
            actor_id=auth.user_id,
        )
        self._audit(
            auth,
            AuditAction.VISIT_RESCHEDULED,
            visit,
            context,
            {
                "visitor_notified": visitor.job is not None,
                "email_message_id": visitor.job.message_id if visitor.job else None,
                "calendar_sent": visitor.calendar,
                "notice_limited_by": visitor.limited_by,
                "host_notified": host.job is not None,
                "host_calendar_sent": host.calendar,
                "host_notice_limited_by": host.limited_by,
            },
        )
        return tuple(sent.job for sent in (visitor, host) if sent.job is not None)

    def _audit(
        self,
        auth: AuthContext,
        action: AuditAction,
        visit: Visit,
        context: RequestContext,
        metadata: dict[str, object],
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata=metadata,
        )
