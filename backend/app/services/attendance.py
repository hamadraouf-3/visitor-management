"""Check-in, check-out and walk-ins (contract §5, §6, §8 POST /visits/{id}/check-in, /check-out,
POST /reception/check-out-stale and /reception/walk-ins). Routes require the RECEPTION capability
(administrators and receptionists), who read every visit of the company.

Locks follow `repositories.locking`: `begin_visit_change` (the company's NO_SHOW marking committed, then
the company row `FOR KEY SHARE`), the host `FOR KEY SHARE` where the host's activity decides the answer,
then the visit `FOR UPDATE` (§3.2-4). The clock is read once the visit lock is held, and the NO_SHOW
deadline is re-checked under it.

"Host active" below is §7.5's host: an active account that still holds EMPLOYEE or SYSTEM_ADMIN
(`visit_references.can_host`). D-18 cancels only SCHEDULED visits when a host is deactivated or loses
the role, so a NO_SHOW visit of such a host still exists and must be refused here (HOST_INACTIVE).

Check-in (§6):
* QR: the token is evaluated exactly like a scan (`scan.evaluate_scan`) and must be row 9 (READY), for a
  pass of this visit.
* MANUAL (reception verified the visitor's ID): the same evaluation of the visit itself, without a pass,
  so a replaced pass (row 6) does not stand in the way: SCHEDULED within the window, host active.
* OVERRIDE (reason required): SCHEDULED or NO_SHOW, on the company-local day of `scheduled_start`, host
  active, at any time of that day.
A refusal carries the §6 code with `details.visit` (and `details.check_in_options` where §6 defines
them), like a scan. Of two concurrent check-ins of a visit the second waits for the first's lock and
gets 409 VISIT_ALREADY_CHECKED_IN; a visitor already inside on another visit gets 409
VISITOR_ALREADY_INSIDE (`uq_visits_visitor_inside`). The host is e-mailed (`notify_host_on_check_in`,
host active) after the commit; a visit is checked in once, so the e-mail goes out once. Arrival e-mails
count against the checking-in user's daily budget (HOST_ARRIVAL_DAILY_LIMIT, `EmailQuota`); beyond it the
check-in or walk-in still succeeds without the e-mail, and the audit row says which budget left it out.

Check-out: QR (any pass of this visit, as §6 row 4), MANUAL, or CORRECTED (an earlier time between the
check-in and now, with a note). The pass is revoked (VISIT_COMPLETED).

Bulk (POST /reception/check-out-stale): every visit still checked in from before company-local today
whose scheduled end has passed is checked out with method BULK and the reason as its note, at its
scheduled end but never before its check-in. A visit from an earlier day that has not ended yet (a night
walk-in expected until the morning) is a visitor still on site and stays on the evacuation list. A run
that finds nothing to check out is audited once per user and company-local day (SEC-42).

Walk-ins (D-07): created CHECKED_IN in one step with method WALK_IN; the visitor is chosen or reused as
for invitations (D-05). `walk_in_reason` is always the reason code and the receptionist's note, for any
reason, is the check-in note. No pass is issued: nobody could ever be shown its token, and a walk-in
checks out by name.

Successes are audited in the transaction (VISIT_CHECKED_IN, VISIT_CHECKED_OUT, WALK_IN_CREATED,
STALE_VISITS_CHECKED_OUT); refusals (409/410, an invalid pass) through the security-event writer
(VISIT_CHECK_IN_REFUSED, VISIT_CHECK_OUT_REFUSED, WALK_IN_REFUSED) with the error code, so the request's
rollback cannot erase them.

What an attempt can cost is bounded per user before any lock is taken: a QR check-in or check-out spends
one of the caller's scans (120 per minute, §7.3) whatever its outcome; every other check-in, check-out or
walk-in keeps a slot of the caller's refusal budget (`attendance_refusals_per_user`, 30 per minute) only
when it is refused. Beyond either budget the request answers 429 RATE_LIMITED, whose audit row is
coalesced (B1-33), so a scripted or stolen reception session cannot append refusal rows to the
append-only audit log at the API rate. Successful MANUAL, OVERRIDE and CORRECTED attempts cost nothing.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import (
    AppError,
    HostInactive,
    NotFound,
    OverrideNotAllowed,
    PassInvalid,
    RateLimited,
    SecurityEvent,
    ValidationFailed,
    VisitAlreadyCheckedIn,
    VisitCancelled,
    VisitCompleted,
    VisitNotCheckedIn,
    VisitorAlreadyInside,
    WalkInsDisabled,
)
from app.core.field_errors import FieldCode, FieldProblem
from app.core.policy import MAX_VISIT_DURATION
from app.core.rate_limit import LimitKey, PolicyName
from app.core.request_context import RequestContext
from app.core.time import as_zone, company_day_bounds, local_date
from app.db.errors import unique_violation_constraint
from app.email.service import DeliveryJob
from app.models import CheckInMethod, CheckOutMethod, Company, PassRevokeReason, User, Visit, VisitStatus
from app.repositories.departments import DepartmentRepository
from app.repositories.locking import RowLock
from app.repositories.users import UserRepository
from app.repositories.visits import VisitRepository
from app.schemas.reception import CheckInOption, ScanErrorDetails, StaleCheckOutRequest, StaleCheckOutResult
from app.schemas.visits import (
    CheckInRequest,
    CheckOutRequest,
    CorrectedCheckOut,
    OverrideCheckIn,
    QrCheckIn,
    QrCheckOut,
    WalkInCreate,
)
from app.schemas.visits import Visit as VisitOut
from app.security.sessions import AuthContext
from app.services import audit, visit_rules
from app.services.audit import AuditAction, AuditEntity
from app.services.email_quota import QuotaUnit
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_if_expired
from app.services.passes import PassService, invalid_pass
from app.services.results import Mutation
from app.services.scan import ScanOutcome, ScanSubject, count_scan, evaluate_scan, scan_error
from app.services.scoping import FieldErrors, require_found
from app.services.visit_lifecycle import begin_visit_change
from app.services.visit_references import active_host, can_host, visit_department
from app.services.visit_views import Viewer, VisitViewBuilder
from app.services.visitors import ResolvedVisitor, VisitorResolver

INSIDE_CONSTRAINT = "uq_visits_visitor_inside"
CHECK_OUT_BEFORE_CHECK_IN = FieldProblem(
    FieldCode.CHECK_OUT_BEFORE_CHECK_IN, "The check-out time must not be before the check-in time."
)
CHECK_OUT_IN_FUTURE = FieldProblem(
    FieldCode.CHECK_OUT_IN_FUTURE, "The check-out time must not be in the future."
)
EXPECTED_END_NOT_IN_FUTURE = FieldProblem(
    FieldCode.EXPECTED_END_IN_PAST, "The expected end must be in the future."
)
LOST_PASS_REASON = "LOST_PASS"  # noqa: S105 - a walk-in reason, not a credential
WALK_IN_FOR_AN_EXPECTED_VISIT = FieldProblem(
    FieldCode.WALK_IN_EXPECTED_VISIT,
    "This visitor has a visit today. Check them in on that visit instead (Expected), after verifying "
    "their ID: the lost pass then stops working when they check out.",
)
WALK_IN_DURING_A_VISIT_WINDOW = FieldProblem(
    FieldCode.WALK_IN_DURING_WINDOW,
    "This visitor's pass for a visit is valid now. Check them in on that visit instead (Expected), after "
    "verifying their ID: the lost pass then stops working when they check out.",
)
WALK_IN_BEFORE_A_VISIT_WINDOW = (
    "This visitor's pass for a visit becomes valid at {time} today. Check them in on that visit from then "
    "(Expected), after verifying their ID: a walk-in would leave the lost pass working."
)
WALK_IN_NEEDS_THE_VISITOR_RECORD = FieldProblem(
    FieldCode.WALK_IN_NEEDS_RECORD,
    "A lost pass belongs to a visitor who was invited: select their record as a returning visitor (or "
    "check them in from Expected), after verifying their ID, instead of entering new details.",
)


def walk_in_before_window(time: str) -> FieldProblem:
    """A lost-pass walk-in of a visitor whose pass becomes valid at `time` (HH:MM, company time) today."""
    return FieldProblem(
        FieldCode.WALK_IN_BEFORE_WINDOW, WALK_IN_BEFORE_A_VISIT_WINDOW.format(time=time), {"time": time}
    )


type AttendanceMethod = CheckInMethod | CheckOutMethod


def walk_in_end_problems(expected_end: datetime, *, now: datetime) -> dict[str, FieldProblem]:
    """Field errors of a walk-in's expected end: after now, and at most 24 hours away (D-14)."""
    if expected_end <= now:
        return {"expected_end": EXPECTED_END_NOT_IN_FUTURE}
    if expected_end - now > MAX_VISIT_DURATION:
        return {"expected_end": visit_rules.TOO_LONG}
    return {}


def walk_in_reason_fields(data: WalkInCreate) -> tuple[str, str | None]:
    """(`walk_in_reason`, `check_in_note`) of a walk-in: the reason code (OTHER included), so the column
    can be read and grouped as a code, and the note, required for OTHER (`WalkInCreate`) and optional
    otherwise, as the check-in note. Free text in the reason column could not be told from a code."""
    return data.reason, data.reason_note


def corrected_check_out_problems(
    check_in_at: datetime, check_out_at: datetime, *, now: datetime
) -> FieldProblem | None:
    """A corrected check-out time lies between the check-in and now (inclusive)."""
    if check_out_at < check_in_at:
        return CHECK_OUT_BEFORE_CHECK_IN
    if check_out_at > now:
        return CHECK_OUT_IN_FUTURE
    return None


def bulk_check_out_time(visit: Visit) -> datetime:
    """When a visit left over from an earlier day is taken to have ended (§8): its scheduled end, but
    never before its check-in. The bulk action only takes visits whose scheduled end has passed and that
    were checked in before today (B57-71), so this instant is never in the future."""
    if visit.check_in_at is None:
        raise ValueError("only checked-in visits can be checked out")
    return max(visit.check_in_at, visit.scheduled_end)


@dataclass(frozen=True, slots=True)
class HostNotice:
    """The host-arrival e-mail of a check-in: queued (`jobs`), not wanted (empty), or left out because
    the checking-in user's budget is used up (`limited_by`)."""

    jobs: tuple[DeliveryJob, ...] = ()
    limited_by: PolicyName | None = None

    def audit_metadata(self) -> dict[str, object]:
        return {
            "host_notified": bool(self.jobs),
            "email_message_id": self.jobs[0].message_id if self.jobs else None,
            "notice_limited_by": self.limited_by,
        }


def is_refusal(exc: AppError) -> bool:
    """A refused attendance change, audited through the security-event writer: a 409/410 (a refused
    transition, a visitor already inside, walk-ins turned off, ...) or an invalid pass."""
    return exc.status_code in (409, 410) or isinstance(exc, PassInvalid)


@contextmanager
def refusals_audited(action: AuditAction, *, entity_id: UUID, metadata: dict[str, Any]) -> Iterator[None]:
    """Audit a refused attendance change: a 409/410, or an invalid pass, raised inside the block gets a
    security event naming the visit and the error code (its default event, if any, is replaced)."""
    try:
        yield
    except AppError as exc:
        if is_refusal(exc):
            exc.security_events = (
                SecurityEvent(
                    action=action,
                    entity_type=AuditEntity.VISIT,
                    entity_id=entity_id,
                    metadata={**metadata, "code": exc.code},
                ),
            )
        raise


@contextmanager
def refusal_budget(env: ServiceEnvironment, auth: AuthContext) -> Iterator[None]:
    """Count the attempt inside the block against the caller's budget of refused attendance changes
    (`attendance_refusals_per_user`) when it is refused (`is_refusal`). A slot is taken before the block,
    so an exhausted budget answers 429 RATE_LIMITED before any lock or audit write, and concurrent
    attempts cannot overrun it; it is kept for a refusal and given back for any other outcome (success,
    422, 404, a failure)."""
    policy = env.policies.attendance_refusals_per_user
    reservation = env.limiter.reserve((LimitKey(policy, str(auth.user_id)),))
    if not reservation.granted:
        raise RateLimited(retry_after=reservation.retry_after, policy=policy.name)
    refused = False
    try:
        yield
    except AppError as exc:
        refused = is_refusal(exc)
        raise
    finally:
        env.limiter.settle(reservation, counted=refused)


class AttendanceService:
    def __init__(self, db: Session, env: ServiceEnvironment) -> None:
        self.db = db
        self.env = env
        self.visits = VisitRepository(db)
        self.users = UserRepository(db)
        self.departments = DepartmentRepository(db)
        self.passes = PassService(db, settings=env.settings)
        self.emails = env.email_service(db)
        self.quota = env.email_quota()
        self.resolver = VisitorResolver(db)

    # ---- check-in -------------------------------------------------------------------------------

    def check_in(
        self, auth: AuthContext, visit_id: UUID, request: CheckInRequest, context: RequestContext
    ) -> Mutation[VisitOut]:
        """Locks: company (shared), the visit's host (shared: its activity and roles decide), the visit."""
        with self._attempt(auth, scanned=isinstance(request, QrCheckIn)):
            return self._check_in(auth, visit_id, request, context)

    def _check_in(
        self, auth: AuthContext, visit_id: UUID, request: CheckInRequest, context: RequestContext
    ) -> Mutation[VisitOut]:
        method = CheckInMethod(request.method)
        company = begin_visit_change(self.db, auth)
        host_id = require_found(self.visits.get(auth.company_id, visit_id)).host_id  # never changes
        host = self.users.get_in_company(auth.company_id, host_id, lock=RowLock.KEY_SHARE)
        visit = require_found(self.visits.lock(auth.company_id, visit_id))
        now = app_time.now()
        viewer = Viewer.of(auth)
        with refusals_audited(
            AuditAction.VISIT_CHECK_IN_REFUSED, entity_id=visit.id, metadata={"method": method}
        ):
            mark_if_expired(self.db, visit, now=now)
            from_status = visit.status
            pass_id = self._admit_check_in(
                auth, visit, request, host_active=can_host(host), viewer=viewer, now=now
            )
            note = request.reason if isinstance(request, OverrideCheckIn) else None
            self._record_check_in(
                visit, actor_id=auth.user_id, method=method, note=note, now=now, viewer=viewer
            )

        with self.quota.unit() as quota:
            notice = self._notify_host(auth, company, host, visit, quota)
            metadata: dict[str, object] = {
                "method": method,
                "from_status": from_status,
                **notice.audit_metadata(),
            }
            if pass_id is not None:
                metadata["pass_id"] = pass_id
            if method in (CheckInMethod.MANUAL, CheckInMethod.OVERRIDE):
                metadata["id_verified"] = True
            self._audit(auth, AuditAction.VISIT_CHECKED_IN, visit, context, metadata)
            payload = VisitViewBuilder(self.db, viewer, now=now).one(visit)
            self.db.commit()
        return Mutation(payload, notice.jobs)

    def _admit_check_in(
        self,
        auth: AuthContext,
        visit: Visit,
        request: CheckInRequest,
        *,
        host_active: bool,
        viewer: Viewer,
        now: datetime,
    ) -> UUID | None:
        """Raise unless the visit may be checked in with `request`; returns the presented pass's ID (QR)."""
        if isinstance(request, OverrideCheckIn):
            self._admit_override(visit, host_active=host_active, viewer=viewer, now=now)
            return None
        presented_pass = None
        if isinstance(request, QrCheckIn):
            presented = self.passes.presented(auth.company_id, request.pass_token)
            if presented.visitor_pass.visit_id != visit.id:
                raise invalid_pass()
            presented_pass = presented.visitor_pass
        evaluation = evaluate_scan(
            ScanSubject.of(visit, presented_pass, host_active=host_active), now=now, timezone=viewer.timezone
        )
        if evaluation.outcome is ScanOutcome.READY:
            return presented_pass.id if presented_pass is not None else None
        view = self._view(visit, viewer, now)
        if evaluation.outcome is ScanOutcome.ALREADY_CHECKED_IN:
            raise VisitAlreadyCheckedIn(details=_details(view))
        raise scan_error(evaluation, view)

    def _admit_override(self, visit: Visit, *, host_active: bool, viewer: Viewer, now: datetime) -> None:
        """OVERRIDE: SCHEDULED or NO_SHOW (§5), on the visit's company-local day, host active."""
        status = VisitStatus(visit.status)
        if status is VisitStatus.CHECKED_IN:
            raise VisitAlreadyCheckedIn(details=_details(self._view(visit, viewer, now)))
        refusal: type[AppError] | None = None
        if status is VisitStatus.CANCELLED:
            refusal = VisitCancelled
        elif status is VisitStatus.CHECKED_OUT:
            refusal = VisitCompleted
        elif not host_active:
            refusal = HostInactive
        elif not visit_rules.same_company_day(now, visit.scheduled_start, viewer.timezone):
            refusal = OverrideNotAllowed
        if refusal is not None:
            # No way to check this visit in remains (§6: `check_in_options` is empty).
            raise refusal(details=_details(self._view(visit, viewer, now), options=[]))
        visit_rules.assert_transition(status, VisitStatus.CHECKED_IN, method=CheckInMethod.OVERRIDE)

    def _record_check_in(
        self,
        visit: Visit,
        *,
        actor_id: UUID,
        method: CheckInMethod,
        note: str | None,
        now: datetime,
        viewer: Viewer,
    ) -> None:
        """Write the check-in in a savepoint: a visitor already inside on another visit violates
        `uq_visits_visitor_inside` (also when that check-in commits while this one waits for the index)."""
        visit_rules.assert_transition(visit.status, VisitStatus.CHECKED_IN, method=method)
        try:
            with self.db.begin_nested():
                visit.status = VisitStatus.CHECKED_IN.value
                visit.check_in_at = now
                visit.checked_in_by_id = actor_id
                visit.check_in_method = method.value
                visit.check_in_note = note
                self.db.flush()
        except IntegrityError as exc:
            if unique_violation_constraint(exc) != INSIDE_CONSTRAINT:
                raise
            raise VisitorAlreadyInside(details=_details(self._view(visit, viewer, now))) from None

    # ---- check-out ------------------------------------------------------------------------------

    def check_out(
        self, auth: AuthContext, visit_id: UUID, request: CheckOutRequest, context: RequestContext
    ) -> VisitOut:
        """Locks: company (shared), the visit."""
        with self._attempt(auth, scanned=isinstance(request, QrCheckOut)):
            return self._check_out(auth, visit_id, request, context)

    def _check_out(
        self, auth: AuthContext, visit_id: UUID, request: CheckOutRequest, context: RequestContext
    ) -> VisitOut:
        method = CheckOutMethod(request.method)
        begin_visit_change(self.db, auth)
        visit = require_found(self.visits.lock(auth.company_id, visit_id))
        now = app_time.now()
        viewer = Viewer.of(auth)
        pass_id: UUID | None = None
        with refusals_audited(
            AuditAction.VISIT_CHECK_OUT_REFUSED, entity_id=visit.id, metadata={"method": method}
        ):
            if isinstance(request, QrCheckOut):
                presented = self.passes.presented(auth.company_id, request.pass_token)
                if presented.visitor_pass.visit_id != visit.id:
                    raise invalid_pass()
                pass_id = presented.visitor_pass.id
            if visit.status != VisitStatus.CHECKED_IN:
                raise VisitNotCheckedIn(details=_details(self._view(visit, viewer, now)))

        check_out_at, note = now, None
        if isinstance(request, CorrectedCheckOut):
            if visit.check_in_at is None:  # excluded by the CHECKED_IN status
                raise ValueError("a checked-in visit has a check-in time")
            problem = corrected_check_out_problems(visit.check_in_at, request.check_out_at, now=now)
            if problem is not None:
                raise ValidationFailed({"check_out_at": problem})
            check_out_at, note = request.check_out_at, request.note
        metadata: dict[str, object] = {"pass_id": pass_id} if pass_id is not None else {}
        self._record_check_out(
            visit,
            auth=auth,
            method=method,
            at=check_out_at,
            note=note,
            context=context,
            now=now,
            metadata=metadata,
        )
        payload = VisitViewBuilder(self.db, viewer, now=now).one(visit)
        self.db.commit()
        return payload

    def check_out_stale(
        self, auth: AuthContext, request: StaleCheckOutRequest, context: RequestContext
    ) -> StaleCheckOutResult:
        """Locks: company (shared), then the stale, overdue visits in id order. The instant that decides
        which visits are overdue is read once the company lock is held.

        A run that checks out nobody is audited (STALE_VISITS_CHECKED_OUT{count: 0}: the desk ran the
        end-of-day action and found nothing) once per user and company-local day (SEC-42); a repeat
        within that day writes nothing, since it would only say the same again. Otherwise a scripted or
        stolen reception session looping on the action would append a permanent row per request at the
        API rate. A run that checks visits out is always audited (each visit is checked out once)."""
        company = begin_visit_change(self.db, auth)
        cutoff = app_time.now()
        today = local_date(cutoff, company.timezone)
        today_start, _ = company_day_bounds(today, company.timezone)
        visits = self.visits.lock_stale_overdue(
            auth.company_id, checked_in_before=today_start, ended_before=cutoff
        )
        empty_run = None
        if not visits:
            policy = self.env.policies.stale_check_out_empty_runs
            empty_run = self.env.limiter.reserve((LimitKey(policy, f"{auth.user_id}:{today.isoformat()}"),))
            if not empty_run.granted:  # recorded already today: nothing new to say
                self.db.commit()
                return StaleCheckOutResult(checked_out=0)
        try:
            self._record_stale_run(auth, visits, request, context, checked_in_before=today.isoformat())
        except BaseException:
            if empty_run is not None:
                self.env.limiter.settle(empty_run, counted=False)
            raise
        if empty_run is not None:
            self.env.limiter.settle(empty_run, counted=True)
        return StaleCheckOutResult(checked_out=len(visits))

    def _record_stale_run(
        self,
        auth: AuthContext,
        visits: list[Visit],
        request: StaleCheckOutRequest,
        context: RequestContext,
        *,
        checked_in_before: str,
    ) -> None:
        """Check `visits` out (BULK) and commit them with the run's audit row."""
        now = app_time.now()
        for visit in visits:
            self._record_check_out(
                visit,
                auth=auth,
                method=CheckOutMethod.BULK,
                at=bulk_check_out_time(visit),
                note=request.reason,
                context=context,
                now=now,
                metadata={},
            )
        audit.record(
            self.db,
            action=AuditAction.STALE_VISITS_CHECKED_OUT,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.COMPANY,
            entity_id=auth.company_id,
            metadata={"count": len(visits), "checked_in_before": checked_in_before},
        )
        self.db.commit()

    def _record_check_out(
        self,
        visit: Visit,
        *,
        auth: AuthContext,
        method: CheckOutMethod,
        at: datetime,
        note: str | None,
        context: RequestContext,
        now: datetime,
        metadata: dict[str, object],
    ) -> None:
        visit_rules.assert_transition(visit.status, VisitStatus.CHECKED_OUT, method=method)
        visit.status = VisitStatus.CHECKED_OUT.value
        visit.check_out_at = at
        visit.checked_out_by_id = auth.user_id
        visit.check_out_method = method.value
        visit.check_out_note = note
        self.db.flush()
        self.passes.revoke_active(
            visit, reason=PassRevokeReason.VISIT_COMPLETED, actor_id=auth.user_id, context=context, now=now
        )
        self._audit(
            auth,
            AuditAction.VISIT_CHECKED_OUT,
            visit,
            context,
            {
                "method": method,
                "duration_seconds": visit_rules.duration_seconds(visit.check_in_at, visit.check_out_at),
                **metadata,
            },
        )

    # ---- walk-ins -------------------------------------------------------------------------------

    def register_walk_in(
        self, auth: AuthContext, data: WalkInCreate, context: RequestContext
    ) -> Mutation[VisitOut]:
        """Locks: company (shared), host and department (shared), the visitor (shared, or exclusive when
        empty fields are filled in), then the new visit's unique-index entry."""
        with self._attempt(auth, scanned=False):
            return self._register_walk_in(auth, data, context)

    def _register_walk_in(
        self, auth: AuthContext, data: WalkInCreate, context: RequestContext
    ) -> Mutation[VisitOut]:
        company = begin_visit_change(self.db, auth)
        if not company.allow_walk_ins:
            raise _walk_in_refused(WalkInsDisabled(), entity_type=AuditEntity.COMPANY, entity_id=company.id)
        now = app_time.now()
        errors = FieldErrors()
        host = active_host(self.users, auth.company_id, data.host_id, errors)
        department = visit_department(self.departments, auth.company_id, data.department_id, host, errors)
        for field, message in walk_in_end_problems(data.expected_end, now=now).items():
            errors.add(field, message)
        choice = self.resolver.choose(auth, data, errors)
        errors.raise_if_any()
        if host is None:  # excluded by `raise_if_any`; narrows the type
            raise NotFound()

        resolved = self.resolver.resolve(auth, choice, context=context, now=now)
        if data.reason == LOST_PASS_REASON:
            self._refuse_a_lost_pass_walk_in(company, resolved, now=now)
        now = app_time.now()  # the locks are held: the check-in happens now
        late = walk_in_end_problems(data.expected_end, now=now)  # time passed while waiting for them
        if late:
            raise ValidationFailed(late)
        window_start, window_end = visit_rules.visit_window(
            now,
            data.expected_end,
            grace_before_minutes=company.pass_grace_before_minutes,
            grace_after_minutes=company.pass_grace_after_minutes,
        )
        reason, note = walk_in_reason_fields(data)
        visit = Visit(
            company_id=auth.company_id,
            visitor_id=resolved.visitor.id,
            host_id=host.id,
            created_by_id=auth.user_id,
            department_id=department.id if department else None,
            purpose=data.purpose,
            scheduled_start=now,
            scheduled_end=data.expected_end,
            window_start=window_start,
            window_end=window_end,
            status=VisitStatus.CHECKED_IN.value,
            invitation_requested=False,
            visitor_link_in_scope=resolved.in_scope,
            visitor_name=resolved.snapshot_name,
            visitor_company_name=resolved.snapshot_company_name,
            host_name=host.full_name,
            department_name=department.name if department else None,
            department_name_ar=department.name_ar if department else None,
            is_walk_in=True,
            walk_in_reason=reason,
            check_in_at=now,
            checked_in_by_id=auth.user_id,
            check_in_method=CheckInMethod.WALK_IN.value,
            check_in_note=note,
            created_at=now,
            updated_at=now,
        )
        try:
            with self.db.begin_nested():
                self.visits.add(visit)
        except IntegrityError as exc:
            if unique_violation_constraint(exc) != INSIDE_CONSTRAINT:
                raise
            raise _walk_in_refused(
                VisitorAlreadyInside(), entity_type=AuditEntity.VISITOR, entity_id=resolved.visitor.id
            ) from None

        self._audit(
            auth,
            AuditAction.WALK_IN_CREATED,
            visit,
            context,
            {
                "visitor_id": visit.visitor_id,
                "host_id": visit.host_id,
                "department_id": visit.department_id,
                "visitor_reused": resolved.reused,
                "reason": data.reason,
            },
        )
        with self.quota.unit() as quota:
            notice = self._notify_host(auth, company, host, visit, quota)
            self._audit(
                auth,
                AuditAction.VISIT_CHECKED_IN,
                visit,
                context,
                {"method": CheckInMethod.WALK_IN, **notice.audit_metadata()},
            )
            payload = VisitViewBuilder(self.db, Viewer.of(auth), now=now).one(visit)
            self.db.commit()
        return Mutation(payload, notice.jobs)

    # ---- helpers --------------------------------------------------------------------------------

    def _refuse_a_lost_pass_walk_in(
        self, company: Company, resolved: ResolvedVisitor, *, now: datetime
    ) -> None:
        """A visitor who lost the pass of a visit they are expected for today is checked in on that visit
        (MANUAL after an ID check, or OVERRIDE outside its window), not registered as a walk-in (SEC-09).
        A walk-in would leave the reported-lost pass valid: whoever holds it could check in on the
        original visit once the visitor has left, or while they are inside. Checking in on the visit
        consumes it, and its pass is revoked at check-out (VISIT_COMPLETED).

        "Expected today" is the reception Expected list: SCHEDULED visits whose pass works before the end
        of the company-local day (`VisitRepository.expected_of_visitor`). A pass is valid from its
        window's start, not from the scheduled start (SEC-R2): a visit starting at 00:10 tomorrow is
        admitted by its pass from 23:10 tonight with the default grace, and with a long grace period any
        visit of tomorrow can be. The answer says what reception can do now: a visit of today (MANUAL in
        its window, OVERRIDE outside it), a pass valid now (MANUAL), or a pass that becomes valid later
        today for a visit of tomorrow, which no check-in can consume yet (OVERRIDE needs the visit's own
        day, §6): the time from which MANUAL can. Revoking the reported-lost pass instead would need a new
        revoke reason (a §8.1 change).

        That check needs the visitor's own record, so a LOST_PASS walk-in may not register a new visitor
        (SEC-32): a pass belongs to a visit, whose visitor is on record. Details typed without the
        e-mail address (D-05 matches by address only) would otherwise create a second record with no
        visits, the expected visit would go unnoticed, and the lost pass would admit a second person
        under the visitor's name while they are inside (a second record is not "already inside")."""
        if resolved.created:
            raise ValidationFailed({"reason": WALK_IN_NEEDS_THE_VISITOR_RECORD})
        _start, day_end = company_day_bounds(local_date(now, company.timezone), company.timezone)
        expected = self.visits.expected_of_visitor(company.id, resolved.visitor.id, day_end)
        if not expected:
            return
        if any(
            visit_rules.same_company_day(now, visit.scheduled_start, company.timezone) for visit in expected
        ):
            raise ValidationFailed({"reason": WALK_IN_FOR_AN_EXPECTED_VISIT})
        if any(visit.window_start <= now for visit in expected):
            raise ValidationFailed({"reason": WALK_IN_DURING_A_VISIT_WINDOW})
        opens = min(visit.window_start for visit in expected).astimezone(as_zone(company.timezone))
        raise ValidationFailed({"reason": walk_in_before_window(opens.strftime("%H:%M"))})

    @contextmanager
    def _attempt(self, auth: AuthContext, *, scanned: bool) -> Iterator[None]:
        """Bound what the attempt inside the block may cost the caller, before any lock: a scanned pass
        (QR) spends one of the caller's scans whatever the outcome (B57-12); anything else keeps a slot of
        the refusal budget only when it is refused (`refusal_budget`)."""
        if scanned:
            count_scan(self.env, auth)
            yield
            return
        with refusal_budget(self.env, auth):
            yield

    def _notify_host(
        self, auth: AuthContext, company: Company, host: User | None, visit: Visit, quota: QuotaUnit
    ) -> HostNotice:
        """§9: "Your visitor … has arrived", when the company wants it and the host can host (§7.5),
        within the checking-in user's daily budget of arrival e-mails (`EmailQuota`). Beyond it the
        check-in stands and only the e-mail is left out."""
        if not company.notify_host_on_check_in or host is None or not can_host(host):
            return HostNotice()
        limited_by = quota.host_arrival(auth.user_id)
        if limited_by is not None:
            return HostNotice(limited_by=limited_by)
        return HostNotice(jobs=(self.emails.queue_host_arrival(visit, company=company, host=host),))

    def _view(self, visit: Visit, viewer: Viewer, now: datetime) -> VisitOut:
        return VisitViewBuilder(self.db, viewer, now=now).one(visit)

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


def _details(view: VisitOut, *, options: list[CheckInOption] | None = None) -> dict[str, Any]:
    """`error.details` of a refused check-in/check-out: the visit as it is now (§6 ScanErrorDetails)."""
    return ScanErrorDetails(visit=view, check_in_options=options).model_dump(mode="json")


def _walk_in_refused(error: AppError, *, entity_type: AuditEntity, entity_id: UUID) -> AppError:
    error.security_events = (
        SecurityEvent(
            action=AuditAction.WALK_IN_REFUSED,
            entity_type=entity_type,
            entity_id=entity_id,
            metadata={"code": error.code},
        ),
    )
    return error
