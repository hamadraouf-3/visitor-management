"""The Visitor Journey's reads and actions (Phase 15, /api/v1/journeys, /api/v1/visits/{id}/journey and
/api/v1/visits/{id}/tracking/*, docs/api.md §17).

Phase 16: the live view (`GET /journeys/live`), a journey's path, allowed areas and alerts, and the
tracking alerts (`/api/v1/tracking/alerts`)."""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import ConfigDict, Field, StringConstraints, ValidationError, model_validator
from pydantic_core import InitErrorDetails

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.models.enums import (
    JourneyEventType,
    ObservationMatch,
    TrackingAlertResolution,
    TrackingAlertStatus,
    TrackingAlertType,
    TrackingAssociationStatus,
    TrackingEndReason,
)
from app.models.tracking import ALERT_NOTE_MAX_LENGTH
from app.schemas.common import (
    BLANK_TO_NONE,
    NO_BIDI_CONTROLS,
    ONE_LINE,
    CompanyLocalDate,
    DepartmentRef,
    PageQuery,
    QueryModel,
    RequestModel,
    ResponseModel,
    SearchText,
    UserRef,
    UTCDatetime,
    VisitStatus,
    comma_separated,
)
from app.schemas.locations import JourneyLocation, VisitAccessAreas
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
    # Phase 16 (B16-10): for a confirmed observation with a location, whether the visit's current allowed
    # areas allow it; null for every other event.
    allowed: bool | None


# ---- alerts (Phase 16, B16-5 to B16-12) ------------------------------------------------------------------


class TrackingAlertRef(ResponseModel):
    """A visit's active alert, as a list row or a visitor of the live view names it."""

    id: UUID
    type: TrackingAlertType
    status: TrackingAlertStatus


class TrackingAlert(ResponseModel):
    id: UUID
    type: TrackingAlertType
    status: TrackingAlertStatus
    simulated: bool  # raised from the simulator's association
    visit: JourneyVisitSummary
    first_location: JourneyLocation  # where it opened, as resolved then
    last_location: JourneyLocation  # the latest violating location
    opened_at: UTCDatetime  # observed_at of the first violating observation
    last_seen_at: UTCDatetime  # observed_at of the latest violating observation
    # The server's time of the escalation to RESTRICTED_AREA; null for an alert that never escalated (also
    # one opened as RESTRICTED_AREA). B16-26.
    escalated_at: UTCDatetime | None
    observations: int
    access_areas: VisitAccessAreas  # the visit's allowed areas now
    acknowledged_at: UTCDatetime | None
    acknowledged_by: UserRef | None
    resolved_at: UTCDatetime | None
    resolved_by: UserRef | None  # null with `resolved_at`: the system
    resolution: TrackingAlertResolution | None
    note: str | None  # the latest staff note
    can_act: bool  # an administrator or a receptionist, and not RESOLVED


class TrackingAlertBrief(ResponseModel):
    id: UUID
    type: TrackingAlertType
    visit_id: UUID
    visitor_name: str
    location: JourneyLocation  # the latest violating location
    opened_at: UTCDatetime
    # Null unless escalated; `latest` is ordered by `escalated_at` or else `opened_at` (B16-26), a key the
    # shell's watcher compares with.
    escalated_at: UTCDatetime | None
    simulated: bool


class TrackingAlertSummary(ResponseModel):
    """GET /tracking/alerts/summary: cheap, polled by the interface's shell. All zeros while tracking is
    not allowed or the deployment has no provider."""

    open: int  # status OPEN
    active: int  # OPEN and ACKNOWLEDGED
    latest: list[TrackingAlertBrief]  # up to 5 OPEN, the newest opened or escalated first (B16-26)


# One line, at most 300 characters; blank: no note.
AlertNote = Annotated[
    Annotated[str, StringConstraints(max_length=ALERT_NOTE_MAX_LENGTH)] | None,
    BLANK_TO_NONE,
    NO_BIDI_CONTROLS,
    ONE_LINE,
]


class TrackingAlertAction(RequestModel):
    """POST /tracking/alerts/{id}/acknowledge and /resolve. A note replaces the alert's latest note."""

    note: AlertNote = None


DAY_ONLY_WITH_SCOPE_DAY = FieldProblem(FieldCode.NOT_ALLOWED, "A day is only chosen with scope=day.")


class TrackingAlertListQuery(PageQuery):
    """GET /tracking/alerts: `active` (default) the OPEN and ACKNOWLEDGED alerts of any day; `day` those
    opened during a company-local day (default today), whatever their status. Newest `opened_at` first."""

    scope: Literal["active", "day"] = "active"
    day: CompanyLocalDate | None = None
    visit_id: UUID | None = None

    @model_validator(mode="after")
    def _day_with_its_scope(self) -> Self:
        if self.day is not None and self.scope != "day":
            raise _field_error("day", DAY_ONLY_WITH_SCOPE_DAY)
        return self


def _field_error(field: str, problem: FieldProblem) -> ValidationError:
    """A validation error located at `field` (a model validator's own errors have no location), shaped
    like the error of a validator that raised `FieldValueError(problem)`."""
    return ValidationError.from_exception_data(
        "TrackingAlertListQuery",
        [
            InitErrorDetails(
                type="value_error", loc=(field,), input=None, ctx={"error": FieldValueError(problem)}
            )
        ],
    )


class JourneyListItem(ResponseModel):
    visit: JourneyVisitSummary
    state: JourneyState
    simulated: bool
    last_location: JourneyLocation | None  # only ever from a confirmed observation; null: "Unknown"
    last_observed_at: UTCDatetime | None
    # Whole seconds since `last_observed_at` at the server's clock, as `VisitJourney.freshness_seconds`
    # (B15-27): null without a confirmed location.
    freshness_seconds: int | None
    alert: TrackingAlertRef | None  # Phase 16: the visit's active alert


class JourneyStay(ResponseModel):
    """Consecutive confirmed observations in one zone (Phase 16, B16-10), oldest first."""

    location: JourneyLocation
    # "from" is a Python keyword: exposed under that name through the alias.
    from_: UTCDatetime = Field(alias="from", serialization_alias="from")
    to: UTCDatetime
    observations: int
    allowed: bool  # under the visit's current allowed areas

    model_config = ConfigDict(
        from_attributes=True, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True
    )


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
    # Phase 16: the visit's allowed areas, whether the caller may change them, its latest alerts (newest
    # first, at most 20) and its path (confirmed observations with a location, oldest first).
    access_areas: VisitAccessAreas
    can_edit_access_areas: bool
    alerts: list[TrackingAlert]
    path: list[JourneyStay]


# ---- the live view (Phase 16, B16-11) --------------------------------------------------------------------


class LiveVisitor(ResponseModel):
    visit: JourneyVisitSummary
    state: JourneyState
    simulated: bool
    last_location: JourneyLocation | None  # only ever from a confirmed observation; null: "Unknown"
    last_observed_at: UTCDatetime | None
    freshness_seconds: int | None
    alert: TrackingAlertRef | None
    access_areas: VisitAccessAreas


class LiveJourneys(ResponseModel):
    """GET /journeys/live: every visit of the company checked in now (at most 1000, newest check-in first;
    `truncated` beyond)."""

    generated_at: UTCDatetime
    truncated: bool
    visitors: list[LiveVisitor]


class LiveJourneyQuery(QueryModel):
    """`building_id`: only the visitors located in that building, and those without a location."""

    building_id: UUID | None = None


class JourneyListQuery(PageQuery):
    """GET /journeys: the visits that were inside during the company-local `day` (default today)."""

    day: CompanyLocalDate | None = None
    q: SearchText = None
    state: JourneyStateFilter = Field(default_factory=list)


class TrackingEnrollRequest(RequestModel):
    camera_id: UUID  # the application's camera ID (`TrackingCamera.id`) of an active enrollment point
