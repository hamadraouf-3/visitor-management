"""Maintenance of the Visitor Journey (Phase 15): `cli prune-journeys` (any environment) and
`cli simulate-journey` (non-production, with `TRACKING_PROVIDER=simulator`).

`prune_journeys` deletes, for each company's `retention_days` (default 30, at most 90): the tracking
alerts last changed (`updated_at`) longer ago than that, whatever their status (Phase 16, B16-17); the
journey events observed longer ago; and the ended associations that ended longer ago and hold no event
and no alert any more. It first locks those ended associations `FOR UPDATE` in ID order, then deletes the
alerts: an ingested batch locks its associations (an ended one it names included) before its visits' alerts
(B16-7), so the prune takes them in the same order and the two never deadlock (B16-17). The runtime role
cannot delete (revision 0006), so it runs as the schema owner (MIGRATION_DATABASE_URL), like
`prune-sessions` (B15-21). The append-only trigger of
`visitor_journey_events` refuses updates only; a deletion by the schema owner is the retention it exists
for. Audit rows stay (they name IDs only). A visit's allowed areas are part of the visit and stay.

`simulate_journey` sends synthetic events for a visit's open simulator association **through the same
ingestion service** a provider's events go through (B15-7): a HEARTBEAT, then one OBSERVED event per
step up to now (never before the association existed), walking the company's active cameras, with
`model_version` "simulator". It sends a confidence only
when one is given (`--confidence`): nothing about a real model is implied, and with the company's
threshold unset nothing counts as confirmed anyway. With `cameras` (Phase 16, B16-20: `--cameras`, the
provider's camera IDs) it walks exactly those cameras in order, one observation each, the last one now,
so a test can bring a visitor into a given zone; two cameras on different floors observed within the
conflict window of each other make the journey UNCERTAIN, as a real provider's observations would (the
steps are never placed before the association existed). Area alerts are evaluated as for any batch;
their e-mails are delivered by the command once the batch has committed.
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
from app.email.service import DeliveryJob
from app.models import TrackingAssociation, TrackingCamera
from app.models.enums import ObservationMatch, TrackingAssociationStatus
from app.models.tracking import RETENTION_DAYS_DEFAULT
from app.services.tracking_alerts import AlertMailer
from app.services.tracking_ingestion import TrackingIngestion, ingest_simulated
from app.services.tracking_provider import SIMULATOR_MODEL_VERSION, IncomingEvent, SimulatorProvider
from app.services.tracking_rules import CONFLICT_WINDOW, MAX_EVENTS_PER_BATCH, IngestEventType, IngestResult

MAX_SIMULATED_STEPS = MAX_EVENTS_PER_BATCH - 1  # one batch: the heartbeat and the steps
DEFAULT_SIMULATED_STEPS = 3

# Each company's retention (`r`): its settings row's, or the default (`:default_days`) without one.
# The ended associations past it, locked in ID order before any alert (B16-17): the batch's order (B16-7).
_LOCK_ENDED_ASSOCIATIONS = text(
    """
    SELECT a.id
    FROM tracking_associations a
    JOIN (
        SELECT c.id AS company_id, coalesce(s.retention_days, :default_days) AS retention_days
        FROM companies c LEFT JOIN company_tracking_settings s ON s.company_id = c.id
    ) r ON r.company_id = a.company_id
    WHERE a.status = 'ENDED'
      AND a.ended_at < CAST(:now AS timestamptz) - make_interval(days => r.retention_days)
    ORDER BY a.id
    FOR UPDATE OF a
    """
)
_PRUNE_ALERTS = text(
    """
    DELETE FROM tracking_alerts t
    USING (
        SELECT c.id AS company_id, coalesce(s.retention_days, :default_days) AS retention_days
        FROM companies c LEFT JOIN company_tracking_settings s ON s.company_id = c.id
    ) r
    WHERE t.company_id = r.company_id
      AND t.updated_at < CAST(:now AS timestamptz) - make_interval(days => r.retention_days)
    RETURNING t.id
    """
)
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
      AND NOT EXISTS (SELECT 1 FROM tracking_alerts t WHERE t.association_id = a.id)
    RETURNING a.id
    """
)


class TrackingMaintenanceError(Exception):
    """A user-facing reason why a command cannot proceed; nothing was written."""


@dataclass(frozen=True, slots=True)
class PruneResult:
    events: int
    associations: int
    alerts: int = 0


def prune_journeys(owner_engine: Engine, *, now: datetime) -> PruneResult:
    """Delete what each company's retention no longer keeps; returns how many rows went. The ended
    associations it may delete are locked first (the lock order of a batch: an association before an
    alert, B16-7, B16-17), then the alerts go (an association is kept while an alert refers to it), then
    the events, then those associations."""
    with owner_engine.begin() as connection:
        parameters = {"now": now, "default_days": RETENTION_DAYS_DEFAULT}
        connection.execute(_LOCK_ENDED_ASSOCIATIONS, parameters).all()
        alerts = len(connection.execute(_PRUNE_ALERTS, parameters).all())
        events = len(connection.execute(_PRUNE_EVENTS, parameters).all())
        associations = len(connection.execute(_PRUNE_ASSOCIATIONS, parameters).all())
    return PruneResult(events=events, associations=associations, alerts=alerts)


@dataclass(frozen=True, slots=True)
class SimulationResult:
    company_id: UUID
    association_id: UUID
    results: dict[str, int]
    # The alert e-mails the batch queued and committed, for the command to deliver (B16-14).
    alert_jobs: tuple[DeliveryJob, ...] = ()


def simulate_journey(
    db: Session,
    settings: Settings,
    *,
    visit_id: UUID,
    steps: int | None,
    interval: timedelta,
    match: ObservationMatch,
    confidence: float | None,
    now: datetime,
    cameras: Sequence[str] | None = None,
    mailer: AlertMailer | None = None,
) -> SimulationResult:
    """`steps`: how many observations (default 3, or one per camera of `cameras`). `cameras`: the provider's
    camera IDs to walk, in order, one per step (B16-20)."""
    if settings.is_production:
        raise TrackingMaintenanceError("simulate-journey is not available when APP_ENV=production")
    if settings.tracking_provider != "simulator":
        raise TrackingMaintenanceError("simulate-journey needs TRACKING_PROVIDER=simulator")
    if cameras is not None and not cameras:
        raise TrackingMaintenanceError("--cameras needs at least one camera ID")
    if steps is None:
        steps = len(cameras) if cameras else DEFAULT_SIMULATED_STEPS
    if cameras and steps != len(cameras):
        raise TrackingMaintenanceError("--steps must be the number of --cameras (one observation each)")
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
    if cameras:
        chosen = _chosen(db, association.company_id, cameras)
        schedule = _schedule_cameras(chosen, association.created_at, interval=interval, now=now)
    else:
        walk = _walk(db, association.company_id)
        if not walk:
            raise TrackingMaintenanceError("the visit's company has no active camera to walk past")
        schedule = _schedule(walk, association.created_at, steps=steps, interval=interval, now=now)
    events: list[IncomingEvent] = [
        IncomingEvent(
            provider_event_id=f"sim-heartbeat-{uuid4().hex}", type=IngestEventType.HEARTBEAT, observed_at=now
        )
    ]
    for at, camera in schedule:
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
    ingestion = TrackingIngestion(db, SimulatorProvider(ingest_simulated), mailer=mailer)
    outcomes = ingestion.ingest(association.company_id, events, key_id=None, context=SYSTEM_CONTEXT)
    tally = Counter(
        outcome.result.value
        if outcome.reason is None
        else f"{IngestResult.REJECTED.value}:{outcome.reason.value}"
        for outcome in outcomes[1:]
    )
    return SimulationResult(
        company_id=association.company_id,
        association_id=association.id,
        results=dict(tally),
        alert_jobs=ingestion.alert_jobs,
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


def _schedule_cameras(
    cameras: Sequence[TrackingCamera], since: datetime, *, interval: timedelta, now: datetime
) -> list[tuple[datetime, TrackingCamera]]:
    """`--cameras` (B16-20): one observation per camera, in the order given, `interval` apart and the last
    one now; a walk longer than the association's life is squeezed into it (never before it existed)."""
    if len(cameras) == 1:
        return [(now, cameras[0])]
    start = max(since, now - interval * (len(cameras) - 1))
    spacing = (now - start) / (len(cameras) - 1)
    return [(start + spacing * step, camera) for step, camera in enumerate(cameras)]


def _chosen(db: Session, company_id: UUID, provider_ids: Sequence[str]) -> list[TrackingCamera]:
    """The company's cameras named by `provider_ids`, in that order; an ID that is not one of its cameras
    is refused (an archived camera is sent, and the ingestion answers UNKNOWN_CAMERA, as for a provider)."""
    found = {
        camera.provider_camera_id: camera
        for camera in db.scalars(
            select(TrackingCamera).where(
                TrackingCamera.company_id == company_id,
                TrackingCamera.provider_camera_id.in_(list(provider_ids)),
            )
        )
    }
    missing = [provider_id for provider_id in provider_ids if provider_id not in found]
    if missing:
        raise TrackingMaintenanceError(
            "not a camera of the visit's company: " + ", ".join(sorted(set(missing)))
        )
    return [found[provider_id] for provider_id in provider_ids]


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
