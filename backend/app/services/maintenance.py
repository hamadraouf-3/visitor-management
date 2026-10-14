"""Maintenance: `cli prune-sessions` (any environment) and `cli e2e-time-travel` (non-production).

`prune_sessions` deletes sessions that ended (revoked, or past their absolute expiry) longer ago than
the retention period. Every sign-in writes a session row and the runtime role cannot delete (B57-60), so
without it the table only grows (SEC-02/SEC-14). It runs as the schema owner (MIGRATION_DATABASE_URL);
audit rows, which name session IDs, are append-only and stay.

`e2e-time-travel` (contract §11, Phase 9 E2E expiry scenarios):
Moves one visit into the past by N minutes: its schedule, pass window and lifecycle timestamps, and its
passes' timestamps, all by the same amount, so the visit stays internally consistent and the pass
behaves as if the clock had moved forward (e.g. 410 PASS_EXPIRED, then NO_SHOW via
`cli mark-no-shows`). Refused in production; cancelled and checked-out visits are immutable and are
refused as well. Audited as VISIT_TIME_SHIFTED so the manipulation is visible.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Engine, delete, or_
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.config import Settings
from app.core.request_context import SYSTEM_CONTEXT
from app.models import PlatformSession, UserSession, VisitStatus
from app.repositories.passes import PassRepository
from app.repositories.visits import VisitRepository
from app.services import audit
from app.services.audit import AuditAction, AuditEntity

MAX_SHIFT_MINUTES = 400 * 24 * 60
SESSION_RETENTION_DAYS = 30


class MaintenanceError(Exception):
    """A user-facing reason why a maintenance command cannot proceed; nothing was written."""


@dataclass(frozen=True, slots=True)
class ShiftedVisit:
    visit_id: UUID
    status: str
    scheduled_start: datetime
    window_end: datetime


class E2ETimeTravel:
    def __init__(self, db: Session, *, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.visits = VisitRepository(db)
        self.passes = PassRepository(db)

    def shift_into_past(self, visit_id: UUID, minutes: int) -> ShiftedVisit:
        if self.settings.is_production:
            raise MaintenanceError("e2e-time-travel is not available when APP_ENV=production")
        if not 1 <= minutes <= MAX_SHIFT_MINUTES:
            raise MaintenanceError(f"--minutes must be between 1 and {MAX_SHIFT_MINUTES}")
        visit = self.visits.lock_for_maintenance(visit_id)
        if visit is None:
            raise MaintenanceError("visit not found")
        if visit.status in (VisitStatus.CHECKED_OUT, VisitStatus.CANCELLED):
            raise MaintenanceError(f"a {visit.status} visit can no longer be modified")

        delta = -timedelta(minutes=minutes)
        now = app_time.now()
        self.visits.shift_times(visit.company_id, visit.id, delta, now=now)
        self.passes.shift_times(visit.company_id, visit.id, delta)
        audit.record(
            self.db,
            action=AuditAction.VISIT_TIME_SHIFTED,
            context=SYSTEM_CONTEXT,
            company_id=visit.company_id,
            actor_user_id=None,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata={"minutes": -minutes, "source": "cli"},
        )
        self.db.commit()
        self.db.refresh(visit)  # the bulk update bypassed the loaded object
        return ShiftedVisit(
            visit_id=visit.id,
            status=visit.status,
            scheduled_start=visit.scheduled_start,
            window_end=visit.window_end,
        )


def prune_sessions(owner_engine: Engine, *, now: datetime, older_than: timedelta) -> int:
    """Delete the sessions that ended more than `older_than` before `now`; returns how many. A live
    session, or one that ended within the retention period (still useful to an investigation of recent
    sign-ins), is kept."""
    if older_than < timedelta(days=1):
        raise MaintenanceError("the retention period must be at least one day")
    cutoff = now - older_than
    with owner_engine.begin() as connection:
        deleted = connection.execute(
            delete(UserSession)
            .where(or_(UserSession.revoked_at < cutoff, UserSession.expires_at < cutoff))
            .returning(UserSession.id)
        )
        # The platform owner's sessions follow the same rule (B11-6).
        deleted_platform = connection.execute(
            delete(PlatformSession)
            .where(or_(PlatformSession.revoked_at < cutoff, PlatformSession.expires_at < cutoff))
            .returning(PlatformSession.id)
        )
        return len(deleted.all()) + len(deleted_platform.all())
