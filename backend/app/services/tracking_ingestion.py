"""The provider-facing ingestion (Phase 15, `POST /api/v1/tracking/events`, B15-9, B15-17,
docs/visitor-tracking-integration.md).

**Authentication** (`authenticate_key`, `limit_key`): `Authorization: Bearer <tracking key>` only. A
session cookie is neither required nor accepted, and the route is exempt from CSRF (there is no cookie
to ride on). A wrong, revoked or absent key, or one of a deactivated company, answers 401 in the standard
envelope; wrong keys count against the client address (`tracking_key_failures_ip`: only the failures,
never a valid request in flight, B15-36), good ones against the key (`tracking_requests_per_key`).

**Locks** (B15-18 as corrected after the independent review, B15-29): a batch first takes the company row
`FOR KEY SHARE`, the first lock of every writer (`repositories.locking`), and re-checks under it that the
key is still unrevoked and the company active; only then the key row, the associations (in ID order) and
the health rows. A switch-off, a key revocation, the platform owner's switch and a deactivation all lock
the company row `FOR UPDATE` first, so they and a batch run one after the other and never deadlock.

**Server-side resolution.** Nothing the provider sends names a company or a visit: the company is the
key's, an association is found by its ref within that company, a camera by the provider's camera ID
within that company. Each event gets one outcome, answered in the batch's order, and the batch answers
200. A batch's ENROLLED and ENROLLMENT_FAILED events are applied before its sightings (otherwise in the
batch's order), so a sighting sent with the enrollment that activates its association counts (B15-28):

1. HEARTBEAT: accepted (only the contact is recorded).
2. An event ID this company already holds from this provider: `duplicate` (no new row), so a provider
   can retry a batch; the IDs are read once the batch's associations are locked, so a concurrent retry
   of the same event is a duplicate too (B15-33). An ENROLLMENT_FAILED repeated for an association it
   already ended is a duplicate as well.
3. Rejected, in this order: TRACKING_OFF, IN_FUTURE, TOO_OLD (before the company's retention window),
   UNKNOWN_ASSOCIATION, then for an ended association ASSOCIATION_ENDED (an OBSERVED or LOST observed
   before the end of an association that **was active** is still appended to history, without changing
   anything), NOT_ACTIVE (an OBSERVED or LOST for an association the provider has not activated yet:
   nobody is bound to it, B15-28), BEFORE_ASSOCIATION, UNKNOWN_CAMERA (not registered, archived, or of
   another company: never a floor), ALREADY_ENROLLED and CAMERA_MISMATCH for ENROLLED /
   ENROLLMENT_FAILED.
4. Accepted: ENROLLED turns PENDING into ACTIVE (and its expiry becomes 12 hours after the activation,
   B15-34); ENROLLMENT_FAILED ends the association; OBSERVED and LOST of an active association are
   appended with the building, floor and zone of the camera as it is now.

Rejected events are never stored, only counted by reason in the company's health record: rows about
people who are not enrolled visitors, or who were never bound to an association, would be surveillance
data. Nothing of an event, a ref or a key is logged.
"""

import logging
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.client_ip import rate_limit_subject
from app.core.errors import NotAuthenticated, RateLimited
from app.core.rate_limit import RateLimiter, RatePolicies, limiter_key
from app.core.request_context import SYSTEM_CONTEXT, RequestContext
from app.db.session import session_factory
from app.models import Company, TrackingAssociation, TrackingCamera, TrackingEndReason
from app.models.enums import JourneyEventType, TrackingAssociationStatus
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.tracking import (
    AssociationRepository,
    CameraRepository,
    JourneyEventRepository,
    LocationRepository,
    TrackingHealthRepository,
    TrackingKeyRepository,
    TrackingSettingsRepository,
)
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.tracking_lifecycle import EndTrigger, TrackingLifecycle
from app.services.tracking_provider import IncomingEvent, TrackingProvider
from app.services.tracking_rules import (
    CLOCK_SKEW_TOLERANCE,
    IngestEventType,
    IngestResult,
    RejectReason,
    active_expiry,
    key_digest,
    presented_key,
)
from app.services.tracking_settings import effective_settings

logger = logging.getLogger("app.tracking")

SIMULATOR = "simulator"
KEY_REQUIRED = "A valid tracking key is required."
# Applied before the batch's sightings (B15-28).
_ENROLLMENT_TYPES = frozenset({IngestEventType.ENROLLED, IngestEventType.ENROLLMENT_FAILED})
_SIGHTING_TYPES = frozenset({IngestEventType.OBSERVED, IngestEventType.LOST})


@dataclass(frozen=True, slots=True)
class TrackingKeyContext:
    """The authenticated provider of a request: a company's key. `user_id` is None (no person), so
    audit rows and the access log attribute the request to the company only."""

    company_id: UUID
    key_id: UUID
    user_id: None = None


@dataclass(frozen=True, slots=True)
class Outcome:
    provider_event_id: str
    result: IngestResult
    reason: RejectReason | None = None


def authenticate_key(
    db: Session,
    authorization: str | None,
    *,
    client_ip: str | None,
    secret_key: str,
    limiter: RateLimiter,
    policies: RatePolicies,
) -> TrackingKeyContext:
    """The key's company, or 401. A client address that sent too many wrong keys gets 429 before any
    lookup. The key is compared by its SHA-256 digest only.

    Only failures count (B15-36): the budget is checked, not reserved, so any number of valid requests in
    flight from one address (a provider sending batches in parallel) never use it up. Concurrent wrong
    keys may pass the check together and overrun the budget by their number; it bounds load, not
    guessing (a key has 256 bits)."""
    failures = policies.tracking_key_failures_ip
    subject = limiter_key(secret_key, "tracking-key-failures-ip", rate_limit_subject(client_ip))
    decision = limiter.check(failures, subject)
    if not decision.allowed:
        raise RateLimited(retry_after=decision.retry_after, policy=failures.name)
    presented = presented_key(authorization)
    key = TrackingKeyRepository(db).by_digest(key_digest(presented)) if presented is not None else None
    live = key is not None and key.revoked_at is None
    company = CompanyRepository(db).get(key.company_id) if key is not None and live else None
    if key is None or company is None or not company.is_active:
        limiter.hit(failures, subject)
        raise NotAuthenticated(KEY_REQUIRED)
    return TrackingKeyContext(company_id=key.company_id, key_id=key.id)


def limit_key(key: TrackingKeyContext, *, limiter: RateLimiter, policies: RatePolicies) -> None:
    """The key's budget of requests (`tracking_requests_per_key`)."""
    policy = policies.tracking_requests_per_key
    decision = limiter.hit(policy, str(key.key_id))
    if not decision.allowed:
        raise RateLimited(retry_after=decision.retry_after, policy=policy.name)


class TrackingIngestion:
    def __init__(self, db: Session, provider: TrackingProvider) -> None:
        self.db = db
        self.provider = provider
        self.lifecycle = TrackingLifecycle(db, provider)
        self.associations = AssociationRepository(db)
        self.events = JourneyEventRepository(db)
        self.health = TrackingHealthRepository(db)

    def ingest(
        self,
        company_id: UUID,
        events: Sequence[IncomingEvent],
        *,
        key_id: UUID | None,
        context: RequestContext,
    ) -> list[Outcome]:
        """Apply a batch for the company and commit; one outcome per event, in order."""
        now = app_time.now()
        # The company row first (B15-29): every writer that conflicts with a batch locks it first too.
        company = CompanyRepository(self.db).get(company_id, lock=RowLock.KEY_SHARE)
        if company is None:  # pragma: no cover - the key's company exists (foreign key)
            raise NotAuthenticated(KEY_REQUIRED)
        if key_id is not None:
            # Re-checked under the lock (SEC-07): a revocation or a deactivation that committed while this
            # request waited wins.
            keys = TrackingKeyRepository(self.db)
            key = keys.get(company_id, key_id)
            if key is None or key.revoked_at is not None or not company.is_active:
                raise NotAuthenticated(KEY_REQUIRED)
            keys.touch(company_id, key_id, now=now)
        self.lifecycle.expire_due(company_id, now=now, context=context)
        batch = _Batch(self, company, events, now=now, context=context)
        outcomes = batch.run()
        rejected = Counter(outcome.reason.value for outcome in outcomes if outcome.reason is not None)
        accepted_events = any(
            outcome.result is IngestResult.ACCEPTED and event.type is not IngestEventType.HEARTBEAT
            for outcome, event in zip(outcomes, events, strict=True)
        )
        # Health rows last (lock order, `repositories.tracking`).
        self.health.record(company_id, contact_at=now, accepted_at=now if accepted_events else None)
        if rejected:
            self.health.count(company_id, dict(rejected), now=now)
        self.db.commit()
        self.lifecycle.after_commit(now=now)
        return outcomes


class _Batch:
    """One batch's resolution (see the module's rules)."""

    def __init__(
        self,
        ingestion: TrackingIngestion,
        company: Company,
        events: Sequence[IncomingEvent],
        *,
        now: datetime,
        context: RequestContext,
    ) -> None:
        self.db = ingestion.db
        self.ingestion = ingestion
        self.company = company
        self.events = events
        self.now = now
        self.context = context
        self.provider = ingestion.provider.name
        settings = effective_settings(TrackingSettingsRepository(self.db).get(company.id))
        self.tracking_on = settings.allowed and settings.enabled and company.is_active
        self.retention = timedelta(days=settings.retention_days)
        refs = {event.association_ref for event in events if event.association_ref is not None}
        self.associations = ingestion.associations.lock_by_refs(company.id, refs) if self.tracking_on else {}
        # Read once the associations are locked (B15-33): a batch that waited for a concurrent one sees
        # what that one stored.
        self.seen = ingestion.events.known_ids(
            company.id,
            self.provider,
            {event.provider_event_id for event in events if event.type is not IngestEventType.HEARTBEAT},
        )
        camera_ids = {event.camera_id for event in events if event.camera_id is not None}
        self.cameras = CameraRepository(self.db).active_by_provider_ids(company.id, camera_ids)
        self.places = LocationRepository(self.db).placed(
            company.id, {camera.zone_id for camera in self.cameras.values()}
        )

    def run(self) -> list[Outcome]:
        """The outcomes in the batch's order; the enrollment events are applied first (B15-28)."""
        order = sorted(
            range(len(self.events)), key=lambda index: self.events[index].type not in _ENROLLMENT_TYPES
        )
        outcomes: dict[int, Outcome] = {index: self._one(self.events[index]) for index in order}
        return [outcomes[index] for index in range(len(self.events))]

    def _one(self, event: IncomingEvent) -> Outcome:
        if event.type is IngestEventType.HEARTBEAT:
            return Outcome(event.provider_event_id, IngestResult.ACCEPTED)
        if event.provider_event_id in self.seen:
            return Outcome(event.provider_event_id, IngestResult.DUPLICATE)
        reason = self._reason(event)
        if reason is not None:
            association = self.associations.get(event.association_ref or "")
            if (
                event.type is IngestEventType.ENROLLMENT_FAILED
                and association is not None
                and association.ended_reason == TrackingEndReason.ENROLLMENT_FAILED
            ):
                return Outcome(event.provider_event_id, IngestResult.DUPLICATE)
            return Outcome(event.provider_event_id, IngestResult.REJECTED, reason)
        return self._apply(event)

    def _reason(self, event: IncomingEvent) -> RejectReason | None:
        if not self.tracking_on:
            return RejectReason.TRACKING_OFF
        if event.observed_at > self.now + CLOCK_SKEW_TOLERANCE:
            return RejectReason.IN_FUTURE
        if event.observed_at < self.now - self.retention:
            return RejectReason.TOO_OLD
        association = self.associations.get(event.association_ref or "")
        if association is None:
            return RejectReason.UNKNOWN_ASSOCIATION
        sighting = event.type in _SIGHTING_TYPES
        if association.status == TrackingAssociationStatus.ENDED:
            # A late sighting of an association that was active counts as history; one that never was
            # bound anybody (B15-28).
            late_sighting = (
                sighting
                and association.activated_at is not None
                and association.ended_reason != TrackingEndReason.ENROLLMENT_FAILED
                and association.ended_at is not None
                and event.observed_at < association.ended_at
            )
            if not late_sighting:
                return RejectReason.ASSOCIATION_ENDED
        if sighting and association.status == TrackingAssociationStatus.PENDING:
            return RejectReason.NOT_ACTIVE
        if event.observed_at < association.created_at - CLOCK_SKEW_TOLERANCE:
            return RejectReason.BEFORE_ASSOCIATION
        camera = self._camera(event)
        if event.camera_id is not None and camera is None:
            return RejectReason.UNKNOWN_CAMERA
        if event.type in (IngestEventType.ENROLLED, IngestEventType.ENROLLMENT_FAILED):
            if association.status != TrackingAssociationStatus.PENDING:
                return RejectReason.ALREADY_ENROLLED
            if event.type is IngestEventType.ENROLLED and (
                camera is None or camera.id != association.enrollment_camera_id
            ):
                return RejectReason.CAMERA_MISMATCH
        return None

    def _camera(self, event: IncomingEvent) -> TrackingCamera | None:
        if event.camera_id is None:
            return None
        camera = self.cameras.get(event.camera_id)
        if camera is None:
            return None
        place = self.places.get(camera.zone_id)
        # A camera whose zone, floor or building is archived places nobody (B15-5).
        return camera if place is not None and place.active else None

    def _apply(self, event: IncomingEvent) -> Outcome:
        association = self.associations[event.association_ref or ""]
        if event.type is IngestEventType.ENROLLMENT_FAILED:
            self.ingestion.lifecycle.end(
                association,
                reason=TrackingEndReason.ENROLLMENT_FAILED,
                at=self.now,
                now=self.now,
                trigger=EndTrigger.PROVIDER,
                context=self.context,
            )
            return Outcome(event.provider_event_id, IngestResult.ACCEPTED)
        if not self._store(event, association):
            return Outcome(event.provider_event_id, IngestResult.DUPLICATE)
        self.seen.add(event.provider_event_id)
        if event.type is IngestEventType.ENROLLED:
            association.status = TrackingAssociationStatus.ACTIVE.value
            association.activated_at = self.now
            association.expires_at = active_expiry(self.now)  # B15-34
            association.updated_at = self.now
            self.db.flush()
            audit.record(
                self.db,
                action=AuditAction.TRACKING_ASSOCIATION_ACTIVATED,
                context=self.context,
                company_id=self.company.id,
                actor_user_id=None,
                entity_type=AuditEntity.VISIT,
                entity_id=association.visit_id,
                metadata={"association_id": association.id, "provider": self.provider},
            )
        return Outcome(event.provider_event_id, IngestResult.ACCEPTED)

    def _store(self, event: IncomingEvent, association: TrackingAssociation) -> bool:
        camera = self._camera(event)
        place = self.places.get(camera.zone_id) if camera is not None else None
        return self.ingestion.events.add(
            {
                "company_id": self.company.id,
                "visit_id": association.visit_id,
                "association_id": association.id,
                "provider": self.provider,
                "provider_event_id": event.provider_event_id,
                "type": JourneyEventType(event.type.value).value,
                "camera_id": camera.id if camera is not None else None,
                "building_id": place.building.id if place is not None else None,
                "floor_id": place.floor.id if place is not None else None,
                "zone_id": place.zone.id if place is not None else None,
                "observed_at": event.observed_at,
                "received_at": self.now,
                "match": event.match if event.type is IngestEventType.OBSERVED else None,
                "confidence": event.confidence,
                "model_version": event.model_version,
            }
        )


def ingest_simulated(company_id: UUID, events: Sequence[IncomingEvent]) -> None:
    """The simulator's sink (`SimulatorProvider`): the events go through the same ingestion as a real
    provider's, in a session of their own, for the company the association belongs to."""
    from app.services.tracking_provider import SimulatorProvider

    with session_factory() as db:
        TrackingIngestion(db, SimulatorProvider(ingest_simulated)).ingest(
            company_id, events, key_id=None, context=SYSTEM_CONTEXT
        )
