"""Where a visit's journey stands now: one function for every reader (Phase 15, B15-12, B15-30; Phase 16,
B16-5).

`current_journeys` computes, for a set of visits, the journey state and the observation the last known
location comes from. It is **the** computation: the journey list, a visit's journey, the live view and the
area alerts all use it, so an alert is never raised from a location the journey itself would not show
(B16-5): a location only from a confirmed observation of an association the provider activated, never
while a confirmed observation within the conflict window names another floor (B15-28, B15-30).

`visit_summary` is the visit as a journey and an alert show it.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import TrackingAssociation, Visit, VisitStatus
from app.models.enums import JourneyEventType, TrackingAssociationStatus
from app.repositories.tracking import (
    AssociationRepository,
    AssociationSummary,
    PlacedZone,
    SightingRow,
    TrackingHealthRepository,
)
from app.schemas.common import DepartmentRef, UserRef
from app.schemas.journeys import JourneyVisitSummary
from app.schemas.locations import JourneyLocation
from app.schemas.visits import VisitVisitor
from app.services.tracking_provider import TrackingProvider
from app.services.tracking_rules import (
    CONFLICT_WINDOW,
    AssociationFacts,
    JourneyState,
    Sighting,
    journey_state,
)
from app.services.tracking_settings import EffectiveSettings, journey_location

SIMULATOR = "simulator"


@dataclass(frozen=True, slots=True)
class CurrentJourney:
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

    @property
    def simulated(self) -> bool:
        return self.association is not None and self.association.provider == SIMULATOR


def current_journeys(
    db: Session,
    provider: TrackingProvider,
    company_id: UUID,
    visit_ids: Sequence[UUID],
    settings: EffectiveSettings,
    *,
    now: datetime,
) -> dict[UUID, CurrentJourney]:
    """Each visit's journey state and its latest association's sightings, in one query per part (B15-20)."""
    associations = AssociationRepository(db)
    latest = associations.latest_for_visits(company_id, visit_ids)
    summaries = associations.summaries(
        company_id,
        # An association the provider never activated bound nobody: nothing of it is shown (B15-28).
        [association for association in latest.values() if association.activated_at is not None],
        threshold=settings.min_confidence,
        conflict_window=CONFLICT_WINDOW,
    )
    health = TrackingHealthRepository(db).get(company_id)
    last_contact = health.last_contact_at if health is not None else None
    tracking_on = provider.enabled and settings.allowed and settings.enabled
    stale_after = timedelta(minutes=settings.stale_after_minutes)
    computed: dict[UUID, CurrentJourney] = {}
    for visit_id in visit_ids:
        association = latest.get(visit_id)
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
        computed[visit_id] = CurrentJourney(state=state, association=association, summary=summary)
    return computed


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


def place_of(zone_id: UUID | None, places: dict[UUID, PlacedZone]) -> JourneyLocation | None:
    """A zone's location (building, floor, zone with its access level), or None."""
    if zone_id is None or zone_id not in places:
        return None
    return journey_location(places[zone_id])


def visit_summary(visit: Visit) -> JourneyVisitSummary:
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
