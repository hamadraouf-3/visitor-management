"""Maintenance of the Visitor Journey (Phase 15): `cli prune-journeys` (any environment) and
`cli simulate-journey` (non-production, with `TRACKING_PROVIDER=simulator`).

`prune_journeys` deletes journey events observed longer ago than their company's `retention_days`
(default 30, at most 90), and ended associations that ended longer ago and hold no event any more. The
runtime role cannot delete (revision 0006), so it runs as the schema owner (MIGRATION_DATABASE_URL), like
`prune-sessions` (B15-21). The append-only trigger of `visitor_journey_events` refuses updates only; a
deletion by the schema owner is the retention it exists for. Audit rows stay (they name IDs only).

`simulate_journey` sends synthetic events for a visit's open simulator association **through the same
ingestion service** a provider's events go through (B15-7): a HEARTBEAT, then one OBSERVED event per
step up to now (never before the association existed), walking the company's active cameras, with
`model_version` "simulator". It sends a confidence only
when one is given (`--confidence`): nothing about a real model is implied, and with the company's
threshold unset nothing counts as confirmed anyway.
"""

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.request_context import SYSTEM_CONTEXT
from app.models import TrackingAssociation, TrackingCamera
from app.models.enums import ObservationMatch, TrackingAssociationStatus
from app.models.tracking import RETENTION_DAYS_DEFAULT
from app.services.tracking_ingestion import TrackingIngestion, ingest_simulated
from app.services.tracking_provider import SIMULATOR_MODEL_VERSION, IncomingEvent, SimulatorProvider
from app.services.tracking_rules import CONFLICT_WINDOW, MAX_EVENTS_PER_BATCH, IngestEventType, IngestResult

MAX_SIMULATED_STEPS = MAX_EVENTS_PER_BATCH - 1  # one batch: the heartbeat and the steps

# Each company's retention (`r`): its settings row's, or the default (`:default_days`) without one.
_PRUNE_EVENTS = text(
    """
    DELETE FROM visitor_journey_events e
    USING (
        SELECT c.id AS company_id, coalesce(s.retention_days, :default_days) AS retention_days
        FROM companies c LEFT JOIN company_tracking_settings s ON s.company_id = c.id
    ) r
    WHERE e.company_id = r.company_id
      AND e.observed_at < CAST(:now AS timestamptz) - make_interval(days => r.retention_days)
    RETURNING e.id
    """
)
_PRUNE_ASSOCIATIONS = text(
    """
    DELETE FROM tracking_associations a
    USING (
        SELECT c.id AS company_id, coalesce(s.retention_days, :default_days) AS retention_days
        FROM companies c LEFT JOIN company_tracking_settings s ON s.company_id = c.id
    ) r
    WHERE a.company_id = r.company_id
      AND a.status = 'ENDED'
      AND a.ended_at < CAST(:now AS timestamptz) - make_interval(days => r.retention_days)
      AND NOT EXISTS (SELECT 1 FROM visitor_journey_events e WHERE e.association_id = a.id)
    RETURNING a.id
    """
)


class TrackingMaintenanceError(Exception):
    """A user-facing reason why a command cannot proceed; nothing was written."""


@dataclass(frozen=True, slots=True)
class PruneResult:
    events: int
    associations: int


def prune_journeys(owner_engine: Engine, *, now: datetime) -> PruneResult:
    """Delete what each company's retention no longer keeps; returns how many rows went."""
    with owner_engine.begin() as connection:
        parameters = {"now": now, "default_days": RETENTION_DAYS_DEFAULT}
        events = len(connection.execute(_PRUNE_EVENTS, parameters).all())
        associations = len(connection.execute(_PRUNE_ASSOCIATIONS, parameters).all())
    return PruneResult(events=events, associations=associations)


@dataclass(frozen=True, slots=True)
class SimulationResult:
    company_id: UUID
    association_id: UUID
    results: dict[str, int]


def simulate_journey(
    db: Session,
    settings: Settings,
    *,
    visit_id: UUID,
    steps: int,
    interval: timedelta,
    match: ObservationMatch,
    confidence: float | None,
    now: datetime,
) -> SimulationResult:
    if settings.is_production:
        raise TrackingMaintenanceError("simulate-journey is not available when APP_ENV=production")
    if settings.tracking_provider != "simulator":
        raise TrackingMaintenanceError("simulate-journey needs TRACKING_PROVIDER=simulator")
    if not 1 <= steps <= MAX_SIMULATED_STEPS:
        raise TrackingMaintenanceError(f"--steps must be between 1 and {MAX_SIMULATED_STEPS}")
    if confidence is not None and not 0 <= confidence <= 1:
        raise TrackingMaintenanceError("--confidence must be between 0 and 1")
    association = db.scalars(
        select(TrackingAssociation).where(
            TrackingAssociation.visit_id == visit_id,
            TrackingAssociation.status.in_(
                (TrackingAssociationStatus.PENDING.value, TrackingAssociationStatus.ACTIVE.value)
            ),
        )
    ).one_or_none()
    if association is None:
        raise TrackingMaintenanceError("the visit has no open tracking association: enroll it first")
    if association.provider != SimulatorProvider.name:
        raise TrackingMaintenanceError("the visit's association was not made by the simulator")
    cameras = _walk(db, association.company_id)
    if not cameras:
        raise TrackingMaintenanceError("the visit's company has no active camera to walk past")
    events: list[IncomingEvent] = [
        IncomingEvent(
            provider_event_id=f"sim-heartbeat-{uuid4().hex}", type=IngestEventType.HEARTBEAT, observed_at=now
        )
    ]
    for at, camera in _schedule(cameras, association.created_at, steps=steps, interval=interval, now=now):
        events.append(
            IncomingEvent(
                provider_event_id=f"sim-observed-{uuid4().hex}",
                type=IngestEventType.OBSERVED,
                observed_at=at,
                association_ref=association.ref,
                camera_id=camera.provider_camera_id,
                match=match.value,
                confidence=confidence,
                model_version=SIMULATOR_MODEL_VERSION,
            )
        )
    outcomes = TrackingIngestion(db, SimulatorProvider(ingest_simulated)).ingest(
        association.company_id, events, key_id=None, context=SYSTEM_CONTEXT
    )
    tally = Counter(
        outcome.result.value
        if outcome.reason is None
        else f"{IngestResult.REJECTED.value}:{outcome.reason.value}"
        for outcome in outcomes[1:]
    )
    return SimulationResult(
        company_id=association.company_id, association_id=association.id, results=dict(tally)
    )


def _schedule(
    cameras: Sequence[TrackingCamera], since: datetime, *, steps: int, interval: timedelta, now: datetime
) -> list[tuple[datetime, TrackingCamera]]:
    """When and where each step is observed: `interval` apart up to now, but never before the association
    existed (the steps are then closer together). The walk moves on to the next camera only once more
    than CONFLICT_WINDOW has passed since it last moved, so a simulated visitor is never seen on two
    floors within that window: the simulator never makes a journey UNCERTAIN by itself."""
    if steps == 1:
        return [(now, cameras[0])]
    start = max(since, now - interval * (steps - 1))
    spacing = (now - start) / (steps - 1)
    schedule: list[tuple[datetime, TrackingCamera]] = []
    index, moved_at = 0, start
    for step in range(steps):
        at = start + spacing * step
        if at - moved_at > CONFLICT_WINDOW:
            index, moved_at = index + 1, at
        schedule.append((at, cameras[index % len(cameras)]))
    return schedule


def _walk(db: Session, company_id: UUID) -> Sequence[TrackingCamera]:
    """The cameras a simulated visitor walks past: the active ones that are not enrollment points (all
    active ones when there are no others), in name order."""
    cameras = list(
        db.scalars(
            select(TrackingCamera)
            .where(TrackingCamera.company_id == company_id, TrackingCamera.is_active.is_(True))
            .order_by(TrackingCamera.name, TrackingCamera.id)
        )
    )
    others = [camera for camera in cameras if not camera.is_enrollment_point]
    return others or cameras
