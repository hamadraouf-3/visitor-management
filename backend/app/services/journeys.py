"""Visitor journeys: the list of a day, a visit's journey, and the tracking actions (Phase 15,
/api/v1/journeys, /api/v1/visits/{id}/journey, /api/v1/visits/{id}/tracking/enroll and /revoke).

* **Who.** Administrators, management and receptionists read journeys (VIEW_JOURNEYS); administrators
  and receptionists enroll and revoke (TRACK_VISITS). A host who is only an employee is refused: least
  privilege, a host has no need for a visitor's movements (B15-13).
* **Reads end what has expired** (`TrackingLifecycle.expire_due`) before they compute anything, so an
  expiry never depends on a job; opening a visit's journey is audited (JOURNEY_VIEWED), at most once per
  user and visit in `JOURNEY_VIEW_AUDIT_WINDOW` (B15-19), and a list that shows anyone's location is
  audited (JOURNEY_LIST_VIEWED), at most once per user in `JOURNEY_LIST_AUDIT_WINDOW` (B15-31).
* **What a journey shows** comes only from associations the provider activated (B15-28); a location only
  from a confirmed observation that no other confirmed observation within the conflict window contradicts
  (B15-30).
* **Enrollment** (B15-14) is allowed only when the provider is not `disabled`, the company has tracking
  allowed and enabled, the visit is CHECKED_IN (whatever its schedule says: a visitor inside is inside,
  B15-34), no PENDING/ACTIVE association exists, and the camera is an active enrollment point of the
  company. It is idempotent: a retry answers
  the existing association. The association is committed PENDING first; then the provider is asked to
  bind the person at the camera (`enroll(ref, provider_camera_id, at)`), outside any lock. A request the
  provider does not take ends the association at once (ENROLLMENT_FAILED), so reception can try again.
  The simulator answers with an ENROLLED event straight away (through the ingestion service), so the
  answer already shows the association ACTIVE.
* **Revoke** is always allowed (ending tracking is always safe) and idempotent.
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import cast
from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import TrackingNotAvailable, ValidationFailed, VisitNotCheckedIn
from app.core.request_context import RequestContext
from app.core.text import escape_like
from app.core.time import company_day_bounds, local_date
from app.models import AuditLog, Company, TrackingAssociation, TrackingEndReason, Visit, VisitStatus
from app.models.enums import JourneyEventType, ObservationMatch, TrackingAssociationStatus
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.pagination import Page, paginate
from app.repositories.tracking import (
    AssociationRepository,
    AssociationSummary,
    CameraRepository,
    JourneyEventRepository,
    LocationRepository,
    PlacedZone,
    SightingRow,
    TrackingHealthRepository,
    TrackingSettingsRepository,
    present_during,
)
from app.repositories.visits import VisitRepository
from app.schemas.common import DepartmentRef, UserRef
from app.schemas.journeys import (
    JourneyEvent,
    JourneyListItem,
    JourneyListQuery,
    JourneyVisitSummary,
    TrackingEnrollRequest,
    VisitJourney,
)
from app.schemas.journeys import TrackingAssociation as AssociationOut
from app.schemas.locations import JourneyLocation
from app.schemas.tracking import CameraRef, TrackingProviderName
from app.schemas.visits import VisitVisitor
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.scoping import REFERENCE_NOT_FOUND, require_found
from app.services.tracking_lifecycle import EndTrigger, TrackingLifecycle
from app.services.tracking_provider import TrackingProvider
from app.services.tracking_rules import (
    CONFLICT_WINDOW,
    JOURNEY_LIST_AUDIT_WINDOW,
    JOURNEY_VIEW_AUDIT_WINDOW,
    TIMELINE_LIMIT,
    AssociationFacts,
    EnrollBlocker,
    JourneyState,
    ProviderOperation,
    Sighting,
    freshness_seconds,
    is_confirmed,
    journey_state,
    new_ref,
    pending_expiry,
    provider_failure_reason,
)
from app.services.tracking_settings import EffectiveSettings, effective_settings, journey_location
from app.services.visit_lifecycle import begin_visit_change

logger = logging.getLogger("app.tracking")
OPEN_VISIT_CONSTRAINT = "uq_tracking_associations_open_visit"


@dataclass(frozen=True, slots=True)
class _Computed:
    state: JourneyState
    association: TrackingAssociation | None  # the visit's latest
    summary: AssociationSummary | None  # its sightings: only once the provider activated it (B15-28)

    @property
    def location(self) -> SightingRow | None:
        """The observation the last location comes from: the latest confirmed one, unless a confirmed
        observation within the conflict window names another floor (B15-30): then nothing is reliable."""
        if self.summary is None or self.summary.conflict:
            return None
        return self.summary.latest_confirmed


class JourneyService:
    def __init__(self, db: Session, provider: TrackingProvider) -> None:
        self.db = db
        self.provider = provider
        self.visits = VisitRepository(db)
        self.associations = AssociationRepository(db)
        self.events = JourneyEventRepository(db)
        self.cameras = CameraRepository(db)
        self.locations = LocationRepository(db)

    # ---- reads ------------------------------------------------------------------------------------

    def list_journeys(
        self, auth: AuthContext, query: JourneyListQuery, context: RequestContext
    ) -> Page[JourneyListItem]:
        company = require_found(CompanyRepository(self.db).get(auth.company_id))
        now = self._expire(auth.company_id, context=context)
        day = query.day or local_date(now, company.timezone)
        start, end = company_day_bounds(day, company.timezone)
        statement = select(Visit).where(Visit.company_id == company.id, present_during(start, end))
        if query.q:
            pattern = f"%{escape_like(query.q)}%"
            statement = statement.where(
                Visit.visitor_name.ilike(pattern, escape="\\")
                | Visit.visitor_company_name.ilike(pattern, escape="\\")
            )
        statement = statement.order_by(Visit.check_in_at.desc(), Visit.id.desc())
        settings = effective_settings(TrackingSettingsRepository(self.db).get(company.id))
        if not query.state:
            page = paginate(self.db, statement, page=query.page, page_size=query.page_size)
            items = self._list_items(company, page.items, settings, now=now)
            self._audit_list(auth, items, day=day, context=context, now=now)
            return Page(items=items, page=page.page, page_size=page.page_size, total=page.total)
        # A state is computed, not stored: the day's visits are computed and then filtered.
        visits = list(self.db.scalars(statement))
        computed = self._compute(company.id, visits, settings, now=now)
        wanted = set(query.state)
        matching = [visit for visit in visits if computed[visit.id].state in wanted]
        offset = (query.page - 1) * query.page_size
        chosen = matching[offset : offset + query.page_size]
        items = self._items(company.id, chosen, computed, now=now)
        self._audit_list(auth, items, day=day, context=context, now=now)
        return Page(items=items, page=query.page, page_size=query.page_size, total=len(matching))

    def visit_journey(self, auth: AuthContext, visit_id: UUID, context: RequestContext) -> VisitJourney:
        visit = require_found(self.visits.get(auth.company_id, visit_id))
        now = self._expire(auth.company_id, context=context)
        self._audit_view(auth, visit, context, now=now)
        return self._journey(auth, visit, now=now)

    # ---- actions ----------------------------------------------------------------------------------

    def enroll(
        self, auth: AuthContext, visit_id: UUID, data: TrackingEnrollRequest, context: RequestContext
    ) -> VisitJourney:
        company = begin_visit_change(self.db, auth)
        visit = require_found(self.visits.lock(auth.company_id, visit_id))
        now = app_time.now()
        lifecycle = TrackingLifecycle(self.db, self.provider)
        lifecycle.expire_due(company.id, now=now, context=context)
        settings = effective_settings(TrackingSettingsRepository(self.db).get(company.id))
        blocker = _availability(self.provider, settings)
        if blocker is not None:
            self._settle(lifecycle, now)
            raise TrackingNotAvailable(blocker.value)
        if self.associations.open_for_visit(company.id, visit.id) is not None:
            # A retry (or a second click): the association that exists, never a second one.
            self._settle(lifecycle, now)
            return self._journey(auth, visit, now=now)
        if visit.status != VisitStatus.CHECKED_IN:
            self._settle(lifecycle, now)
            raise VisitNotCheckedIn()
        camera = self.cameras.get(company.id, data.camera_id)
        place = self.locations.placed(company.id, {camera.zone_id}).get(camera.zone_id) if camera else None
        if (
            camera is None
            or not camera.is_active
            or not camera.is_enrollment_point
            or place is None
            or not place.active
        ):
            self._settle(lifecycle, now)
            raise ValidationFailed({"camera_id": REFERENCE_NOT_FOUND})
        association = TrackingAssociation(
            company_id=company.id,
            visit_id=visit.id,
            ref=new_ref(),
            provider=self.provider.name,
            enrollment_camera_id=camera.id,
            status=TrackingAssociationStatus.PENDING.value,
            created_by_id=auth.user_id,
            expires_at=pending_expiry(now),  # until the provider activates it (B15-34)
            created_at=now,
            updated_at=now,
        )
        self.db.add(association)
        self.db.flush()
        audit.record(
            self.db,
            action=AuditAction.TRACKING_ENROLLMENT_REQUESTED,
            context=context,
            company_id=company.id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
            metadata={
                "association_id": association.id,
                "camera_id": camera.id,
                "provider": self.provider.name,
            },
        )
        self.db.commit()
        lifecycle.after_commit(now=now)
        self._ask_provider(association, camera.provider_camera_id, context=context, at=now)
        self.db.expire_all()
        return self._journey(auth, visit, now=app_time.now())

    def revoke(self, auth: AuthContext, visit_id: UUID, context: RequestContext) -> VisitJourney:
        company = begin_visit_change(self.db, auth)
        visit = require_found(self.visits.lock(auth.company_id, visit_id))
        now = app_time.now()
        lifecycle = TrackingLifecycle(self.db, self.provider)
        lifecycle.expire_due(company.id, now=now, context=context)
        association = self.associations.open_for_visit(company.id, visit.id, lock=RowLock.UPDATE)
        if association is not None:
            lifecycle.end(
                association,
                reason=TrackingEndReason.REVOKED,
                at=now,
                now=now,
                trigger=EndTrigger.USER,
                context=context,
                actor_id=auth.user_id,
                action=AuditAction.TRACKING_ASSOCIATION_REVOKED,
            )
        self._settle(lifecycle, now)
        return self._journey(auth, visit, now=now)

    # ---- helpers ----------------------------------------------------------------------------------

    def _settle(self, lifecycle: TrackingLifecycle, now: datetime) -> None:
        """Commit what the request wrote (an expiry, an end) and call the provider for what ended."""
        self.db.commit()
        lifecycle.after_commit(now=now)

    def _expire(self, company_id: UUID, *, context: RequestContext) -> datetime:
        now = app_time.now()
        lifecycle = TrackingLifecycle(self.db, self.provider)
        if lifecycle.expire_due(company_id, now=now, context=context):
            self._settle(lifecycle, now)
        return now

    def _ask_provider(
        self,
        association: TrackingAssociation,
        provider_camera_id: str,
        *,
        context: RequestContext,
        at: datetime,
    ) -> None:
        """The binding request, after the commit (B15-18). A request the provider does not take ends the
        association (ENROLLMENT_FAILED), so a new enrollment can be tried; the failure is counted."""
        try:
            self.provider.enroll(
                company_id=association.company_id,
                ref=association.ref,
                provider_camera_id=provider_camera_id,
                at=at,
            )
            return
        except Exception as exc:
            logger.warning("tracking provider enroll failed", extra={"error": type(exc).__name__})
        now = app_time.now()
        lifecycle = TrackingLifecycle(self.db, self.provider)
        # The company row first, like every writer (B15-29).
        CompanyRepository(self.db).get(association.company_id, lock=RowLock.KEY_SHARE)
        locked = self.associations.open_for_visit(
            association.company_id, association.visit_id, lock=RowLock.UPDATE
        )
        if (
            locked is not None
            and locked.id == association.id
            and locked.status == TrackingAssociationStatus.PENDING
        ):
            lifecycle.end(
                locked,
                reason=TrackingEndReason.ENROLLMENT_FAILED,
                at=now,
                now=now,
                trigger=EndTrigger.PROVIDER,
                context=context,
            )
        self.db.commit()
        try:
            TrackingHealthRepository(self.db).count(
                association.company_id, {provider_failure_reason(ProviderOperation.ENROLL): 1}, now=now
            )
            self.db.commit()
        except Exception as exc:
            # Bookkeeping: the enrollment request and its end stand (B15-37).
            self.db.rollback()
            logger.warning("counting a tracking provider failure failed", extra={"error": type(exc).__name__})

    def _audit_list(
        self,
        auth: AuthContext,
        items: Sequence[JourneyListItem],
        *,
        day: date,
        context: RequestContext,
        now: datetime,
    ) -> None:
        """JOURNEY_LIST_VIEWED when the answer shows anyone's location (B15-31), unless this user has one
        younger than the window: the list reveals where people were, so reading it leaves a trace too."""
        located = sum(1 for item in items if item.last_location is not None)
        if not located:
            return
        recent = self.db.scalar(
            select(
                exists().where(
                    AuditLog.company_id == auth.company_id,
                    AuditLog.action == AuditAction.JOURNEY_LIST_VIEWED.value,
                    AuditLog.actor_user_id == auth.user_id,
                    AuditLog.created_at > now - JOURNEY_LIST_AUDIT_WINDOW,
                )
            )
        )
        if recent:
            return
        audit.record(
            self.db,
            action=AuditAction.JOURNEY_LIST_VIEWED,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.COMPANY,
            entity_id=auth.company_id,
            metadata={"day": day.isoformat(), "located": located},
        )
        self.db.commit()

    def _audit_view(self, auth: AuthContext, visit: Visit, context: RequestContext, *, now: datetime) -> None:
        """JOURNEY_VIEWED, unless this user's row for this visit is younger than the window (B15-19)."""
        recent = self.db.scalar(
            select(
                exists().where(
                    AuditLog.company_id == auth.company_id,
                    AuditLog.entity_type == AuditEntity.VISIT.value,
                    AuditLog.entity_id == visit.id,
                    AuditLog.action == AuditAction.JOURNEY_VIEWED.value,
                    AuditLog.actor_user_id == auth.user_id,
                    AuditLog.created_at > now - JOURNEY_VIEW_AUDIT_WINDOW,
                )
            )
        )
        if recent:
            return
        audit.record(
            self.db,
            action=AuditAction.JOURNEY_VIEWED,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.VISIT,
            entity_id=visit.id,
        )
        self.db.commit()

    def _compute(
        self, company_id: UUID, visits: Sequence[Visit], settings: EffectiveSettings, *, now: datetime
    ) -> dict[UUID, _Computed]:
        latest = self.associations.latest_for_visits(company_id, [visit.id for visit in visits])
        summaries = self.associations.summaries(
            company_id,
            # An association the provider never activated bound nobody: nothing of it is shown (B15-28).
            [association for association in latest.values() if association.activated_at is not None],
            threshold=settings.min_confidence,
            conflict_window=CONFLICT_WINDOW,
        )
        health = TrackingHealthRepository(self.db).get(company_id)
        last_contact = health.last_contact_at if health is not None else None
        tracking_on = self.provider.enabled and settings.allowed and settings.enabled
        stale_after = timedelta(minutes=settings.stale_after_minutes)
        computed: dict[UUID, _Computed] = {}
        for visit in visits:
            association = latest.get(visit.id)
            summary = summaries.get(association.id) if association is not None else None
            state = journey_state(
                tracking_on=tracking_on,
                association=(
                    AssociationFacts(
                        TrackingAssociationStatus(association.status),
                        association.expires_at,
                        association.activated_at,
                    )
                    if association is not None
                    else None
                ),
                last_contact_at=last_contact,
                latest_sighting=_sighting(summary.latest_sighting) if summary is not None else None,
                latest_confirmed_at=(
                    summary.latest_confirmed.observed_at
                    if summary is not None and summary.latest_confirmed is not None
                    else None
                ),
                conflict=summary.conflict if summary is not None else False,
                threshold=settings.min_confidence,
                stale_after=stale_after,
                now=now,
            )
            computed[visit.id] = _Computed(state=state, association=association, summary=summary)
        return computed

    def _list_items(
        self, company: Company, visits: Sequence[Visit], settings: EffectiveSettings, *, now: datetime
    ) -> list[JourneyListItem]:
        computed = self._compute(company.id, visits, settings, now=now)
        return self._items(company.id, visits, computed, now=now)

    def _items(
        self, company_id: UUID, visits: Sequence[Visit], computed: dict[UUID, _Computed], *, now: datetime
    ) -> list[JourneyListItem]:
        zone_ids = {
            location.zone_id
            for item in computed.values()
            if (location := item.location) is not None and location.zone_id is not None
        }
        places = self.locations.placed(company_id, zone_ids)
        items: list[JourneyListItem] = []
        for visit in visits:
            item = computed[visit.id]
            confirmed = item.location
            items.append(
                JourneyListItem(
                    visit=_summary(visit),
                    state=item.state,
                    simulated=item.association is not None and item.association.provider == "simulator",
                    last_location=_location(confirmed, places),
                    last_observed_at=confirmed.observed_at if confirmed is not None else None,
                    freshness_seconds=freshness_seconds(
                        confirmed.observed_at if confirmed is not None else None, now=now
                    ),
                )
            )
        return items

    def _journey(self, auth: AuthContext, visit: Visit, *, now: datetime) -> VisitJourney:
        company_id = auth.company_id
        settings = effective_settings(TrackingSettingsRepository(self.db).get(company_id))
        computed = self._compute(company_id, [visit], settings, now=now)[visit.id]
        association = computed.association
        confirmed = computed.location
        timeline = self.events.timeline(company_id, visit.id, limit=TIMELINE_LIMIT)
        zone_ids = {event.zone_id for event in timeline if event.zone_id is not None}
        if confirmed is not None and confirmed.zone_id is not None:
            zone_ids.add(confirmed.zone_id)
        places = self.locations.placed(company_id, zone_ids)
        camera_ids = {event.camera_id for event in timeline if event.camera_id is not None}
        if association is not None:
            camera_ids.add(association.enrollment_camera_id)
        camera_names = self.cameras.names(company_id, camera_ids)
        open_association = association is not None and association.status in (
            TrackingAssociationStatus.PENDING,
            TrackingAssociationStatus.ACTIVE,
        )
        blocker = self._enroll_blocker(auth, visit, settings, open_association=open_association, now=now)
        return VisitJourney(
            visit=_summary(visit),
            state=computed.state,
            association=_association(association, camera_names) if association is not None else None,
            last_location=_location(confirmed, places),
            last_observed_at=confirmed.observed_at if confirmed is not None else None,
            freshness_seconds=freshness_seconds(confirmed.observed_at if confirmed else None, now=now),
            timeline=[
                JourneyEvent(
                    id=event.id,
                    type=JourneyEventType(event.type),
                    observed_at=event.observed_at,
                    received_at=event.received_at,
                    camera=(
                        CameraRef(id=event.camera_id, name=camera_names.get(event.camera_id, ""))
                        if event.camera_id is not None
                        else None
                    ),
                    location=_place(event.zone_id, places),
                    match=ObservationMatch(event.match) if event.match is not None else None,
                    confidence=event.confidence,
                    confirmed=event.type == JourneyEventType.OBSERVED
                    and is_confirmed(event.match, event.confidence, settings.min_confidence),
                    model_version=event.model_version,
                )
                for event in timeline
            ],
            timeline_total=self.events.count_for_visit(company_id, visit.id),
            can_enroll=blocker is None,
            enroll_blocker=blocker,
            can_revoke=open_association and has_capability(auth.roles, Capability.TRACK_VISITS),
        )

    def _enroll_blocker(
        self,
        auth: AuthContext,
        visit: Visit,
        settings: EffectiveSettings,
        *,
        open_association: bool,
        now: datetime,
    ) -> EnrollBlocker | None:
        if not has_capability(auth.roles, Capability.TRACK_VISITS):
            return EnrollBlocker.NOT_PERMITTED
        blocker = _availability(self.provider, settings)
        if blocker is not None:
            return blocker
        if open_association:
            return EnrollBlocker.ALREADY_ENROLLED
        if visit.status != VisitStatus.CHECKED_IN:
            return EnrollBlocker.NOT_CHECKED_IN
        points = self.cameras.in_company(
            visit.company_id, include_archived=False, enrollment_points_only=True
        )
        places = self.locations.placed(visit.company_id, {camera.zone_id for camera in points})
        if not any(places[camera.zone_id].active for camera in points):
            return EnrollBlocker.NO_ENROLLMENT_POINT
        return None


def _availability(provider: TrackingProvider, settings: EffectiveSettings) -> EnrollBlocker | None:
    if not provider.enabled:
        return EnrollBlocker.PROVIDER_DISABLED
    if not settings.allowed:
        return EnrollBlocker.NOT_ALLOWED
    if not settings.enabled:
        return EnrollBlocker.NOT_ENABLED
    return None


def _sighting(row: SightingRow | None) -> Sighting | None:
    if row is None:
        return None
    return Sighting(
        event_id=row.id,
        type=JourneyEventType(row.type),
        observed_at=row.observed_at,
        floor_id=row.floor_id,
        match=row.match,
        confidence=row.confidence,
    )


def _location(confirmed: SightingRow | None, places: dict[UUID, PlacedZone]) -> JourneyLocation | None:
    """The last known location: only ever from a confirmed observation (B15-12)."""
    return _place(confirmed.zone_id if confirmed is not None else None, places)


def _place(zone_id: UUID | None, places: dict[UUID, PlacedZone]) -> JourneyLocation | None:
    if zone_id is None or zone_id not in places:
        return None
    return journey_location(places[zone_id])


def _summary(visit: Visit) -> JourneyVisitSummary:
    return JourneyVisitSummary(
        id=visit.id,
        status=VisitStatus(visit.status),
        visitor=VisitVisitor(
            id=visit.visitor_id, full_name=visit.visitor_name, company_name=visit.visitor_company_name
        ),
        host=UserRef(id=visit.host_id, full_name=visit.host_name),
        department=(
            DepartmentRef(
                id=visit.department_id, name=visit.department_name, name_ar=visit.department_name_ar
            )
            if visit.department_id is not None and visit.department_name is not None
            else None
        ),
        scheduled_start=visit.scheduled_start,
        scheduled_end=visit.scheduled_end,
        check_in_at=visit.check_in_at,
        check_out_at=visit.check_out_at,
    )


def _association(association: TrackingAssociation, camera_names: dict[UUID, str]) -> AssociationOut:
    return AssociationOut(
        id=association.id,
        status=TrackingAssociationStatus(association.status),
        provider=cast(TrackingProviderName, association.provider),
        simulated=association.provider == "simulator",
        created_at=association.created_at,
        activated_at=association.activated_at,
        ended_at=association.ended_at,
        ended_reason=TrackingEndReason(association.ended_reason) if association.ended_reason else None,
        expires_at=association.expires_at,
        enrollment_camera=CameraRef(
            id=association.enrollment_camera_id, name=camera_names.get(association.enrollment_camera_id, "")
        ),
    )
