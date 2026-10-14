"""Server-side pass validation (contract §6, `POST /reception/scan`).

`evaluate_scan` is the §6 table as a pure function, rows 2-9 in order (row 1, an invalid pass, is decided
before a visit is known: `PassService.presented`). Check-in (`services.attendance`) reuses the same steps:
QR requires row 9 (`ScanOutcome.READY`) for a pass of the visit being checked in, MANUAL the same
evaluation without a pass, and both answer refusals with `scan_error`.

| row | condition                                              | outcome              |
|-----|--------------------------------------------------------|----------------------|
| 2   | visit CANCELLED                                        | 409 VISIT_CANCELLED  |
| 3   | visit CHECKED_OUT                                      | 409 VISIT_COMPLETED  |
| 4   | visit CHECKED_IN (any pass of it, any time)            | 200 ALREADY_CHECKED_IN (+ OVERSTAYED) |
| 5   | host inactive (deactivated, or no longer a host, §7.5) | 409 HOST_INACTIVE    |
| 6   | pass revoked (ROTATED / VISITOR_EMAIL_CHANGED), SCHEDULED | 410 PASS_REVOKED  |
| 7   | NO_SHOW, or SCHEDULED after the window                 | 410 PASS_EXPIRED     |
| 8   | SCHEDULED before the window                            | 409 PASS_NOT_YET_VALID |
| 9   | SCHEDULED within the window                            | 200 READY (+ OUTSIDE_SCHEDULED_TIME) |

Every outcome is audited as PASS_SCANNED with `outcome`: successes in the request's transaction, failures
through the security-event writer (the error carries the event), and never with the token.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import (
    AppError,
    HostInactive,
    PassExpired,
    PassNotYetValid,
    PassRevoked,
    RateLimited,
    SecurityEvent,
    VisitCancelled,
    VisitCompleted,
)
from app.core.request_context import RequestContext
from app.models import Visit, VisitorPass, VisitStatus
from app.repositories.users import UserRepository
from app.schemas.reception import CheckInOption, ScanActions, ScanErrorDetails, ScanResult, ScanWarning
from app.schemas.visits import Visit as VisitOut
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_no_shows_committed
from app.services.passes import PassService
from app.services.visit_rules import REPLACED_PASS_REASONS, same_company_day
from app.services.visit_views import Viewer, VisitViewBuilder

OUTSIDE_SCHEDULED_TIME = "Visitor is outside the scheduled visit time."
OVERSTAYED = "Visitor has stayed past the scheduled end time."

type WarningCode = Literal["OUTSIDE_SCHEDULED_TIME", "OVERSTAYED"]


class ScanOutcome(StrEnum):
    READY = "READY"  # row 9
    ALREADY_CHECKED_IN = "ALREADY_CHECKED_IN"  # row 4
    VISIT_CANCELLED = "VISIT_CANCELLED"  # row 2
    VISIT_COMPLETED = "VISIT_COMPLETED"  # row 3
    HOST_INACTIVE = "HOST_INACTIVE"  # row 5
    PASS_REVOKED = "PASS_REVOKED"  # row 6
    PASS_EXPIRED = "PASS_EXPIRED"  # row 7
    PASS_NOT_YET_VALID = "PASS_NOT_YET_VALID"  # row 8


_ERRORS: dict[ScanOutcome, type[AppError]] = {
    ScanOutcome.VISIT_CANCELLED: VisitCancelled,
    ScanOutcome.VISIT_COMPLETED: VisitCompleted,
    ScanOutcome.HOST_INACTIVE: HostInactive,
    ScanOutcome.PASS_REVOKED: PassRevoked,
    ScanOutcome.PASS_EXPIRED: PassExpired,
    ScanOutcome.PASS_NOT_YET_VALID: PassNotYetValid,
}


@dataclass(frozen=True, slots=True)
class ScanSubject:
    """What the evaluation needs to know about a scanned pass and its visit."""

    visit_status: str
    pass_revoke_reason: str | None
    host_active: bool  # §7.5: an active account still holding a host role
    scheduled_start: datetime
    scheduled_end: datetime
    window_start: datetime
    window_end: datetime

    @classmethod
    def of(cls, visit: Visit, visitor_pass: VisitorPass | None, *, host_active: bool) -> ScanSubject:
        """`visitor_pass` None: the visit itself is judged, as for a MANUAL check-in after an ID check
        (a replaced pass, row 6, does not apply)."""
        return cls(
            visit_status=visit.status,
            pass_revoke_reason=visitor_pass.revoke_reason if visitor_pass is not None else None,
            host_active=host_active,
            scheduled_start=visit.scheduled_start,
            scheduled_end=visit.scheduled_end,
            window_start=visit.window_start,
            window_end=visit.window_end,
        )


@dataclass(frozen=True, slots=True)
class ScanEvaluation:
    outcome: ScanOutcome
    check_in_options: tuple[CheckInOption, ...] = ()
    warnings: tuple[WarningCode, ...] = ()

    @property
    def succeeded(self) -> bool:
        return self.outcome in (ScanOutcome.READY, ScanOutcome.ALREADY_CHECKED_IN)


def evaluate_scan(subject: ScanSubject, *, now: datetime, timezone: str) -> ScanEvaluation:
    """Rows 2-9 of the contract §6 table, in order (the NO_SHOW marking has already run)."""
    status = subject.visit_status
    same_day = same_company_day(now, subject.scheduled_start, timezone)
    override: tuple[CheckInOption, ...] = ("OVERRIDE",) if same_day else ()
    inside_window = subject.window_start <= now <= subject.window_end

    if status == VisitStatus.CANCELLED:
        return ScanEvaluation(ScanOutcome.VISIT_CANCELLED)
    if status == VisitStatus.CHECKED_OUT:
        return ScanEvaluation(ScanOutcome.VISIT_COMPLETED)
    if status == VisitStatus.CHECKED_IN:
        overstayed: tuple[WarningCode, ...] = ("OVERSTAYED",) if now > subject.scheduled_end else ()
        return ScanEvaluation(ScanOutcome.ALREADY_CHECKED_IN, warnings=overstayed)
    if not subject.host_active:
        return ScanEvaluation(ScanOutcome.HOST_INACTIVE)
    scheduled = status == VisitStatus.SCHEDULED
    if scheduled and subject.pass_revoke_reason in REPLACED_PASS_REASONS:
        options: tuple[CheckInOption, ...] = ("MANUAL",) if inside_window else override
        return ScanEvaluation(ScanOutcome.PASS_REVOKED, check_in_options=options)
    if status == VisitStatus.NO_SHOW or (scheduled and now > subject.window_end):
        return ScanEvaluation(ScanOutcome.PASS_EXPIRED, check_in_options=override)
    if scheduled and now < subject.window_start:
        return ScanEvaluation(ScanOutcome.PASS_NOT_YET_VALID, check_in_options=override)
    if scheduled:
        outside: tuple[WarningCode, ...] = (
            () if subject.scheduled_start <= now <= subject.scheduled_end else ("OUTSIDE_SCHEDULED_TIME",)
        )
        return ScanEvaluation(ScanOutcome.READY, warnings=outside)
    raise ValueError(f"unknown visit status {status!r}")  # every status is covered above


_WARNING_MESSAGES: dict[WarningCode, str] = {
    "OUTSIDE_SCHEDULED_TIME": OUTSIDE_SCHEDULED_TIME,
    "OVERSTAYED": OVERSTAYED,
}


def scan_warnings(evaluation: ScanEvaluation) -> list[ScanWarning]:
    return [ScanWarning(code=code, message=_WARNING_MESSAGES[code]) for code in evaluation.warnings]


def scan_error(
    evaluation: ScanEvaluation, view: VisitOut, *, security_events: Sequence[SecurityEvent] = ()
) -> AppError:
    """The error of a failed evaluation (rows 2, 3, 5-8), with the visit and the check-in options in
    `details` (§6)."""
    error_class = _ERRORS[evaluation.outcome]
    return error_class(
        details=ScanErrorDetails(visit=view, check_in_options=list(evaluation.check_in_options)).model_dump(
            mode="json"
        ),
        security_events=security_events,
    )


def count_scan(env: ServiceEnvironment, auth: AuthContext) -> None:
    """Spend one of the caller's scans (120 per minute, §7.3), or raise 429 RATE_LIMITED. Scans and QR
    check-ins/check-outs share the budget: each looks a token up by its hash."""
    policy = env.policies.scan_per_user
    decision = env.limiter.hit(policy, str(auth.user_id))
    if not decision.allowed:
        raise RateLimited(retry_after=decision.retry_after, policy=policy.name)


class ReceptionScanService:
    def __init__(self, db: Session, env: ServiceEnvironment) -> None:
        self.db = db
        self.env = env
        self.passes = PassService(db, settings=env.settings)
        self.users = UserRepository(db)

    def scan(self, auth: AuthContext, raw_input: str, context: RequestContext) -> ScanResult:
        count_scan(self.env, auth)
        presented = self.passes.presented(auth.company_id, raw_input)  # row 1
        now = app_time.now()
        if mark_no_shows_committed(self.db, auth.company_id, now=now):
            self.db.refresh(presented.visit)
        visit, visitor_pass = presented.visit, presented.visitor_pass
        host = self.users.summaries(auth.company_id, [visit.host_id]).get(visit.host_id)
        viewer = Viewer.of(auth)
        evaluation = evaluate_scan(
            ScanSubject.of(visit, visitor_pass, host_active=host is not None and host.can_host),
            now=now,
            timezone=viewer.timezone,
        )
        view = VisitViewBuilder(self.db, viewer, now=now).one(visit)
        event_metadata = {"outcome": evaluation.outcome, "pass_id": visitor_pass.id}
        if not evaluation.succeeded:
            raise scan_error(
                evaluation,
                view,
                security_events=[
                    SecurityEvent(
                        action=AuditAction.PASS_SCANNED,
                        entity_type=AuditEntity.VISIT,
                        entity_id=visit.id,
                        metadata=event_metadata,
                    )
                ],
            )
        audit.record(
            self.db,
            action=AuditAction.PASS_SCANNED,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata=event_metadata,
        )
        self.db.commit()
        ready = evaluation.outcome is ScanOutcome.READY
        return ScanResult(
            result="READY" if ready else "ALREADY_CHECKED_IN",
            visit=view,
            warnings=scan_warnings(evaluation),
            actions=ScanActions(check_in=ready, check_out=not ready),
        )
