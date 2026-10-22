"""Builds the contract §8.1 `Visit` for one caller from visit rows.

A page of visits is assembled with a fixed number of queries whatever its size: the users the visits
refer to (current names, the host's current phone and activity), the latest invitation e-mail, the
e-mails that carried the visitor's event (Phase 14, B14-16, B14-18, B14-26), the latest
cancellation/reschedule notice and the current pass of every visit (the active one, otherwise the last
issued), and each visitor's current e-mail address (needed to resend) and phone (the evacuation list,
B57-72).

The invitation a visit shows is its latest invitation e-mail, or, when that one went out (or is on its
way) and the calendar invitation that followed it to the visitor's address FAILED, that failure (B14-18):
the visitor has the pass without the event, and the host's resend sends both again, as for a failed
invitation. `visitor_calendar_sent`: the visitor's calendar holds the visit (B14-16, B14-26).

Snapshot fields (visitor, host name, department names in both languages) come from the visit row itself
(D-17).

The views are built from ORM entities or from `VisitRecord` rows (the reception lists, which only show
visits). Parts that repeat across a response's visits (user references, departments, permission sets) are
built once per response (`_SharedParts`), and the company-local day once per list (`CompanyDay`): GET
/reception/today, polled by every reception tablet, builds about 250 visits (re-audit round 1).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import EmailKind, EmailStatus, Visit
from app.models.enums import CheckInMethod, CheckOutMethod, PassRevokeReason, VisitStatus
from app.repositories.email_messages import VISITOR_EVENT_KINDS, EmailMessageRepository, LatestEmail
from app.repositories.passes import CurrentPass, PassRepository
from app.repositories.users import UserRepository, UserSummary
from app.repositories.visitors import VisitorContact, VisitorRepository
from app.repositories.visits import VisitRecord
from app.schemas.common import DepartmentRef, InvitationStatus, UserRef
from app.schemas.locations import VisitAccessAreas
from app.schemas.reception import InsideVisit, InsideVisitor
from app.schemas.visits import (
    NoticeKind,
    NoticeStatus,
    VisitHost,
    VisitInvitation,
    VisitNotice,
    VisitPass,
    VisitPermissions,
    VisitVisitor,
)
from app.schemas.visits import (
    Visit as VisitOut,
)
from app.security.sessions import AuthContext
from app.services import visit_rules
from app.services.access_areas import AccessAreaService
from app.services.calendar_state import failed_calendar_invitation, holds_event, messages_to
from app.services.visit_rules import Caller


@dataclass(frozen=True, slots=True)
class Viewer:
    """Who a response is built for, and the company calendar it is read in."""

    caller: Caller
    company_id: UUID
    timezone: str

    @classmethod
    def of(cls, auth: AuthContext) -> Viewer:
        return cls(
            caller=Caller(user_id=auth.user_id, roles=auth.roles),
            company_id=auth.company_id,
            timezone=auth.user.company.timezone,
        )


_INVITATION_STATUS: dict[str, InvitationStatus] = {
    EmailStatus.PENDING.value: "PENDING",
    EmailStatus.SENT.value: "SENT",
    EmailStatus.FAILED.value: "FAILED",
}


_NOTICE_STATUS: dict[str, NoticeStatus] = {
    EmailStatus.PENDING.value: "PENDING",
    EmailStatus.SENT.value: "SENT",
    EmailStatus.FAILED.value: "FAILED",
}
_NOTICE_KINDS: dict[str, NoticeKind] = {
    EmailKind.VISIT_CANCELLED.value: "VISIT_CANCELLED",
    EmailKind.VISIT_RESCHEDULED.value: "VISIT_RESCHEDULED",
}


def notice_view(message: LatestEmail | None) -> VisitNotice | None:
    if message is None:
        return None
    status = _NOTICE_STATUS[message.status]
    return VisitNotice(
        kind=_NOTICE_KINDS[message.kind],
        status=status,
        to_email=message.to_email,
        sent_at=message.sent_at,
        error=message.last_error if status != "SENT" else None,
    )


def invitation_view(message: LatestEmail | None, *, calendar_failed: bool = False) -> VisitInvitation:
    """`message`: the visit's latest invitation, or the calendar invitation that followed it and failed
    (`calendar_failed`, B14-18)."""
    if message is None:
        return VisitInvitation(
            status="NOT_SENT",
            to_email=None,
            attempts=0,
            last_attempt_at=None,
            sent_at=None,
            error=None,
            calendar_failed=False,
        )
    status = _INVITATION_STATUS[message.status]
    return VisitInvitation(
        status=status,
        to_email=message.to_email,
        attempts=message.attempts,
        last_attempt_at=message.last_attempt_at,
        sent_at=message.sent_at,
        error=message.last_error if status != "SENT" else None,
        calendar_failed=calendar_failed,
    )


class VisitViewBuilder:
    def __init__(self, db: Session, viewer: Viewer, *, now: datetime) -> None:
        self.db = db
        self.viewer = viewer
        self.now = now

    def one(self, visit: Visit) -> VisitOut:
        return self.build([visit])[0]

    def build(self, visits: Sequence[Visit | VisitRecord]) -> list[VisitOut]:
        return [view for view, _ in self._build(visits)]

    def build_inside(self, visits: Sequence[Visit | VisitRecord]) -> list[InsideVisit]:
        """Evacuation-list entries (B57-72): `Visit` plus the visitor record's current phone, so a
        missing visitor can be called. Only for callers who read every visitor (VIEW_INSIDE)."""
        return [
            InsideVisit(
                **{
                    **dict(view),
                    "visitor": InsideVisitor(
                        **dict(view.visitor), phone=contact.phone if contact is not None else None
                    ),
                }
            )
            for view, contact in self._build(visits)
        ]

    def _build(self, visits: Sequence[Visit | VisitRecord]) -> list[tuple[VisitOut, VisitorContact | None]]:
        """Each visit's view, with its visitor's current contact details."""
        if not visits:
            return []
        company_id = self.viewer.company_id
        visit_ids = [visit.id for visit in visits]
        user_ids = {
            user_id
            for visit in visits
            for user_id in (
                visit.host_id,
                visit.created_by_id,
                visit.checked_in_by_id,
                visit.checked_out_by_id,
                visit.cancelled_by_id,
            )
            if user_id is not None
        }
        users = UserRepository(self.db).summaries(company_id, user_ids)
        messages = EmailMessageRepository(self.db)
        invitations = messages.latest_invitations(company_id, visit_ids)
        events = messages.event_messages(company_id, visit_ids, VISITOR_EVENT_KINDS)
        notices = messages.latest_notices(company_id, visit_ids)
        passes = PassRepository(self.db).current_for_visits(company_id, visit_ids)
        contacts = VisitorRepository(self.db).contacts(company_id, {visit.visitor_id for visit in visits})
        # Where each visitor may be (Phase 16, B16-2): three queries whatever the page's size.
        areas = AccessAreaService(self.db).views(company_id, visit_ids)
        parts = _SharedParts(users)
        day = visit_rules.CompanyDay.at(self.now, self.viewer.timezone)
        views = []
        for visit in visits:
            contact = contacts.get(visit.visitor_id)
            invitation = invitations.get(visit.id)
            # What the visitor's calendar was sent of the visit (B14-16, B14-18, B14-26).
            sent = messages_to(events, visit.id, contact.email if contact is not None else None)
            view = self._view(
                visit,
                parts=parts,
                day=day,
                invitation=invitation,
                failed_calendar=failed_calendar_invitation(sent, invitation),
                visitor_calendar_sent=holds_event(sent),
                notice=notices.get(visit.id),
                visitor_pass=passes.get(visit.id),
                visitor_has_email=contact is not None and contact.email is not None,
                access_areas=areas[visit.id],
            )
            views.append((view, contact))
        return views

    def _view(
        self,
        visit: Visit | VisitRecord,
        *,
        parts: _SharedParts,
        day: visit_rules.CompanyDay,
        invitation: LatestEmail | None,
        failed_calendar: LatestEmail | None,
        visitor_calendar_sent: bool,
        notice: LatestEmail | None,
        visitor_pass: CurrentPass | None,
        visitor_has_email: bool,
        access_areas: VisitAccessAreas,
    ) -> VisitOut:
        """`failed_calendar`: the calendar invitation that followed `invitation` and failed, when nothing
        put the event in the visitor's calendar since (`calendar_state.failed_calendar_invitation`);
        `visitor_calendar_sent`: the visitor's calendar holds the visit (`calendar_state.holds_event`)."""
        now = day.now
        # The visitor has the pass without the event (B14-18): the visit shows the calendar invitation's
        # failure, and says that it is that one's.
        if failed_calendar is not None:
            invitation = failed_calendar
        status = visit.status
        host = parts.users.get(visit.host_id)
        flags = visit_rules.visit_permissions(
            self.viewer.caller,
            status=status,
            host_id=visit.host_id,
            created_by_id=visit.created_by_id,
            host_active=host is not None and host.can_host,
            visitor_has_email=visitor_has_email,
            scheduled_start=visit.scheduled_start,
            window_start=visit.window_start,
            window_end=visit.window_end,
            day=day,
        )
        check_in_at, check_in_method = visit.check_in_at, visit.check_in_method
        check_out_at, check_out_method = visit.check_out_at, visit.check_out_method
        return VisitOut(
            id=visit.id,
            status=VisitStatus(status),
            visitor=VisitVisitor(
                id=visit.visitor_id, full_name=visit.visitor_name, company_name=visit.visitor_company_name
            ),
            host=VisitHost(id=visit.host_id, full_name=visit.host_name, phone=host.phone if host else None),
            department=parts.department(visit.department_id, visit.department_name, visit.department_name_ar),
            purpose=visit.purpose,
            scheduled_start=visit.scheduled_start,
            scheduled_end=visit.scheduled_end,
            window_start=visit.window_start,
            window_end=visit.window_end,
            is_walk_in=visit.is_walk_in,
            walk_in_reason=visit.walk_in_reason,
            check_in_at=check_in_at,
            check_in_method=CheckInMethod(check_in_method) if check_in_method else None,
            check_in_note=visit.check_in_note,
            checked_in_by=parts.optional_user(visit.checked_in_by_id),
            check_out_at=check_out_at,
            check_out_method=CheckOutMethod(check_out_method) if check_out_method else None,
            check_out_note=visit.check_out_note,
            checked_out_by=parts.optional_user(visit.checked_out_by_id),
            cancelled_at=visit.cancelled_at,
            cancellation_reason=visit.cancellation_reason,
            cancelled_by=parts.optional_user(visit.cancelled_by_id),
            no_show_at=visit.no_show_at,
            duration_seconds=visit_rules.duration_seconds(check_in_at, check_out_at),
            is_overdue=visit_rules.is_overdue(status, visit.scheduled_end, now),
            is_stale=day.is_stale(status, check_in_at),
            created_by=parts.user(visit.created_by_id),
            created_at=visit.created_at,
            updated_at=visit.updated_at,
            calendar_sequence=visit.calendar_sequence,
            visitor_calendar_sent=visitor_calendar_sent,
            invitation=(
                invitation_view(invitation, calendar_failed=failed_calendar is not None)
                if invitation is not None
                else parts.not_sent
            ),
            last_notice=notice_view(notice),
            pass_=VisitPass(
                status=visit_rules.pass_status(
                    revoked_at=visitor_pass.revoked_at if visitor_pass else None,
                    issued=visitor_pass is not None,
                    visit_status=status,
                    window_end=visit.window_end,
                    now=now,
                ),
                issued_at=visitor_pass.created_at if visitor_pass else None,
                revoke_reason=(
                    PassRevokeReason(visitor_pass.revoke_reason)
                    if visitor_pass is not None and visitor_pass.revoke_reason
                    else None
                ),
            ),
            permissions=parts.permissions(flags),
            access_areas=access_areas,
        )


class _SharedParts:
    """The parts of a response's visit views that repeat across its visits (the users they refer to,
    departments, permission sets, the "not sent" invitation), built once per response. They are values,
    never changed once built, so one instance serves every visit that shows the same thing."""

    def __init__(self, users: dict[UUID, UserSummary]) -> None:
        self.users = users
        self.not_sent = invitation_view(None)
        self._users: dict[UUID, UserRef] = {}
        self._departments: dict[tuple[UUID, str | None, str | None], DepartmentRef] = {}
        self._permissions: dict[visit_rules.VisitPermissionFlags, VisitPermissions] = {}

    def user(self, user_id: UUID) -> UserRef:
        ref = self._users.get(user_id)
        if ref is None:
            user = self.users.get(user_id)
            ref = self._users[user_id] = UserRef(id=user_id, full_name=user.full_name if user else "")
        return ref

    def optional_user(self, user_id: UUID | None) -> UserRef | None:
        return None if user_id is None else self.user(user_id)

    def department(
        self, department_id: UUID | None, name: str | None, name_ar: str | None
    ) -> DepartmentRef | None:
        if department_id is None:
            return None
        key = (department_id, name, name_ar)
        ref = self._departments.get(key)
        if ref is None:
            ref = self._departments[key] = DepartmentRef(id=department_id, name=name or "", name_ar=name_ar)
        return ref

    def permissions(self, flags: visit_rules.VisitPermissionFlags) -> VisitPermissions:
        permissions = self._permissions.get(flags)
        if permissions is None:
            permissions = self._permissions[flags] = VisitPermissions(
                can_edit=flags.can_edit,
                can_cancel=flags.can_cancel,
                can_resend=flags.can_resend,
                can_check_in=flags.can_check_in,
                can_check_out=flags.can_check_out,
                can_edit_access_areas=flags.can_edit_access_areas,
            )
        return permissions
