"""Visitor journeys (Phase 15, docs/api.md §17): the day's list, a visit's journey, and the tracking
actions; the live view of everyone inside (Phase 16, B16-11). Administrators, management and
receptionists read; administrators and receptionists enroll and revoke. A host who is only an employee
gets 403 (B15-13)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import ContextDep, JourneyServiceDep, TrackVisitsAuth, ViewJourneysAuth
from app.schemas.common import Paginated
from app.schemas.journeys import (
    JourneyListItem,
    JourneyListQuery,
    LiveJourneyQuery,
    LiveJourneys,
    TrackingEnrollRequest,
    VisitJourney,
)

router = APIRouter(tags=["journeys"])


@router.get("/journeys", response_model=Paginated[JourneyListItem])
def list_journeys(
    auth: ViewJourneysAuth,
    service: JourneyServiceDep,
    query: Annotated[JourneyListQuery, Query()],
    context: ContextDep,
) -> Paginated[JourneyListItem]:
    """The visits that were inside during the company-local `day` (default today), newest check-in
    first, with their journey state and last confirmed location."""
    page = service.list_journeys(auth, query, context)
    return Paginated[JourneyListItem](
        items=page.items, page=page.page, page_size=page.page_size, total=page.total
    )


@router.get("/journeys/live", response_model=LiveJourneys)
def live_journeys(
    auth: ViewJourneysAuth,
    service: JourneyServiceDep,
    query: Annotated[LiveJourneyQuery, Query()],
    context: ContextDep,
) -> LiveJourneys:
    """Every visit of the company checked in now (at most 1000, newest check-in first), with its journey
    state, confirmed location, active alert and allowed areas. `building_id` keeps the visitors located in
    that building and those without a location. Audited like the list (JOURNEY_LIST_VIEWED)."""
    return service.live(auth, query, context)


@router.get("/visits/{visit_id}/journey", response_model=VisitJourney)
def get_visit_journey(
    visit_id: UUID, auth: ViewJourneysAuth, service: JourneyServiceDep, context: ContextDep
) -> VisitJourney:
    """Opening a journey is audited (JOURNEY_VIEWED, at most once per user and visit per hour)."""
    return service.visit_journey(auth, visit_id, context)


@router.post("/visits/{visit_id}/tracking/enroll", response_model=VisitJourney)
def enroll_visit_tracking(
    visit_id: UUID,
    body: TrackingEnrollRequest,
    auth: TrackVisitsAuth,
    service: JourneyServiceDep,
    context: ContextDep,
) -> VisitJourney:
    """Ask the provider to bind the person at the enrollment camera to this visit. Idempotent."""
    return service.enroll(auth, visit_id, body, context)


@router.post("/visits/{visit_id}/tracking/revoke", response_model=VisitJourney)
def revoke_visit_tracking(
    visit_id: UUID, auth: TrackVisitsAuth, service: JourneyServiceDep, context: ContextDep
) -> VisitJourney:
    """End the visit's tracking association, if one is open. Idempotent."""
    return service.revoke(auth, visit_id, context)
