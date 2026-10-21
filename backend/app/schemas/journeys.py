"""The Visitor Journey's reads and actions (Phase 15, /api/v1/journeys, /api/v1/visits/{id}/journey and
/api/v1/visits/{id}/tracking/*, docs/api.md §17)."""

from typing import Annotated
from uuid import UUID

from pydantic import Field

from app.models.enums import (
    JourneyEventType,
    ObservationMatch,
    TrackingAssociationStatus,
    TrackingEndReason,
)
from app.schemas.common import (
    CompanyLocalDate,
    DepartmentRef,
    PageQuery,
    RequestModel,
    ResponseModel,
    SearchText,
    UserRef,
    UTCDatetime,
    VisitStatus,
    comma_separated,
)
from app.schemas.locations import JourneyLocation
from app.schemas.tracking import CameraRef, TrackingProviderName
from app.schemas.visits import VisitVisitor
from app.services.tracking_rules import EnrollBlocker, JourneyState

JourneyStateFilter = Annotated[list[JourneyState], comma_separated(JourneyState)]


class JourneyVisitSummary(ResponseModel):
    id: UUID
    status: VisitStatus
    visitor: VisitVisitor
    host: UserRef
    department: DepartmentRef | None
    scheduled_start: UTCDatetime
    scheduled_end: UTCDatetime
    check_in_at: UTCDatetime | None
    check_out_at: UTCDatetime | None


class TrackingAssociation(ResponseModel):
    """A visit's tracking association. Its reference is the provider's and is never answered (B15-6)."""

    id: UUID
    status: TrackingAssociationStatus
    provider: TrackingProviderName
    simulated: bool
    created_at: UTCDatetime
    activated_at: UTCDatetime | None
    ended_at: UTCDatetime | None
    ended_reason: TrackingEndReason | None
    expires_at: UTCDatetime
    enrollment_camera: CameraRef | None


class JourneyEvent(ResponseModel):
    id: UUID
    type: JourneyEventType
    observed_at: UTCDatetime
    received_at: UTCDatetime
    camera: CameraRef | None
    # Where the camera was when the event arrived: a later move of the camera never rewrites it.
    location: JourneyLocation | None
    match: ObservationMatch | None  # what the provider said (OBSERVED only)
    confidence: float | None  # only when the provider sent one
    # What the application counts: CONFIRMED with a confidence at least the company's threshold (never
    # with a null threshold). The interface marks confirmed / uncertain from this, not from `match`.
    confirmed: bool
    model_version: str | None


class JourneyListItem(ResponseModel):
    visit: JourneyVisitSummary
    state: JourneyState
    simulated: bool
    last_location: JourneyLocation | None  # only ever from a confirmed observation; null: "Unknown"
    last_observed_at: UTCDatetime | None
    # Whole seconds since `last_observed_at` at the server's clock, as `VisitJourney.freshness_seconds`
    # (B15-27): null without a confirmed location.
    freshness_seconds: int | None


class VisitJourney(ResponseModel):
    visit: JourneyVisitSummary
    state: JourneyState
    association: TrackingAssociation | None  # the visit's latest association
    last_location: JourneyLocation | None
    last_observed_at: UTCDatetime | None
    freshness_seconds: int | None
    timeline: list[JourneyEvent]  # ascending observed_at; the most recent TIMELINE_LIMIT events
    timeline_total: int
    can_enroll: bool
    enroll_blocker: EnrollBlocker | None  # null exactly when `can_enroll`
    can_revoke: bool


class JourneyListQuery(PageQuery):
    """GET /journeys: the visits that were inside during the company-local `day` (default today)."""

    day: CompanyLocalDate | None = None
    q: SearchText = None
    state: JourneyStateFilter = Field(default_factory=list)


class TrackingEnrollRequest(RequestModel):
    camera_id: UUID  # the application's camera ID (`TrackingCamera.id`) of an active enrollment point
