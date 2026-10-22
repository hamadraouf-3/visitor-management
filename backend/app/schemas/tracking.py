"""The Visitor Journey's tracking API (Phase 15, /api/v1/tracking, docs/api.md §17).

* Status, settings, keys and cameras: cookie sessions and CSRF, like every tenant endpoint.
* The provider's ingestion (`POST /tracking/events`): a Bearer tracking key only, no cookie, no CSRF;
  its models (`TrackingEventBatch`, `TrackingEventResults`) are documented in
  docs/visitor-tracking-integration.md and are not part of the frontend's contract snapshot (B15-17).
"""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AfterValidator, Field, StringConstraints, ValidationError, model_validator
from pydantic_core import InitErrorDetails

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.models.enums import ObservationMatch
from app.models.tracking import (
    ALERT_EMAILS_MAX,
    CAMERA_NAME_MAX_LENGTH,
    KEY_LABEL_MAX_LENGTH,
    MODEL_VERSION_MAX_LENGTH,
    PROVIDER_ID_MAX_LENGTH,
    RETENTION_DAYS_MAX,
    STALE_AFTER_MINUTES_MAX,
)
from app.schemas.common import (
    NO_BIDI_CONTROLS,
    ONE_LINE,
    TRIMMED,
    EmailAddress,
    NotNull,
    QueryModel,
    RequestDatetime,
    RequestModel,
    ResponseModel,
    UserRef,
    UTCDatetime,
)
from app.schemas.locations import JourneyLocation
from app.services.tracking_rules import (
    MAX_EVENTS_PER_BATCH,
    IngestEventType,
    IngestResult,
    ProviderOperation,
    RejectReason,
)

TrackingProviderName = Literal["disabled", "simulator"]
# A provider's identifier (a camera ID, an event ID, a model version): visible ASCII, taken exactly as
# sent (never trimmed: an ID is compared as it is).
VISIBLE_ASCII = r"^[!-~]+$"
ProviderId = Annotated[
    str, StringConstraints(min_length=1, max_length=PROVIDER_ID_MAX_LENGTH, pattern=VISIBLE_ASCII)
]
ModelVersion = Annotated[
    str, StringConstraints(min_length=1, max_length=MODEL_VERSION_MAX_LENGTH, pattern=VISIBLE_ASCII)
]
# A reference that is not well formed names no association: it is answered per event
# (UNKNOWN_ASSOCIATION), not as a malformed body.
AssociationRefInput = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=VISIBLE_ASCII)]
Confidence = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
CameraName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=CAMERA_NAME_MAX_LENGTH),
    TRIMMED,
    NO_BIDI_CONTROLS,
    ONE_LINE,
]
KeyLabel = Annotated[
    str, StringConstraints(min_length=1, max_length=KEY_LABEL_MAX_LENGTH), TRIMMED, NO_BIDI_CONTROLS, ONE_LINE
]
StaleAfterMinutes = Annotated[int, Field(ge=1, le=STALE_AFTER_MINUTES_MAX)]
RetentionDays = Annotated[int, Field(ge=1, le=RETENTION_DAYS_MAX)]


def _distinct(addresses: list[str]) -> list[str]:
    """In the order given, each address once (they are already lower case: `EmailAddress`)."""
    return list(dict.fromkeys(addresses))


# The company's alert addresses (Phase 16, B16-13): at most ALERT_EMAILS_MAX valid addresses, stored lower
# case and once each. A bad one is answered at its own path (`alert_emails.<index>`).
AlertEmails = Annotated[list[EmailAddress], Field(max_length=ALERT_EMAILS_MAX), AfterValidator(_distinct)]


# ---- status and settings -------------------------------------------------------------------------


class TrackingStatus(ResponseModel):
    """GET /tracking/status: one line for the Visitor Journey page's banner."""

    provider: TrackingProviderName
    simulated: bool  # the deployment's provider is the simulator: everything it shows is synthetic
    available: bool  # the deployment has a provider at all (not `disabled`)
    allowed: bool
    enabled: bool
    last_contact_at: UTCDatetime | None
    # available, allowed and enabled, the provider answers, and it contacted the application within 5 minutes
    healthy: bool


class TrackingRejectionCount(ResponseModel):
    reason: RejectReason
    count: int


class TrackingProviderErrorCount(ResponseModel):
    operation: ProviderOperation
    count: int


class TrackingHealth(ResponseModel):
    """Reasons and counts only, never an event's content (B15-11)."""

    last_contact_at: UTCDatetime | None
    last_accepted_event_at: UTCDatetime | None
    rejected_last_24h: list[TrackingRejectionCount]
    provider_errors_last_24h: list[TrackingProviderErrorCount]


class TrackingSettings(ResponseModel):
    provider: TrackingProviderName  # the deployment's, read-only
    allowed: bool  # the platform owner's, read-only
    enabled: bool
    # Null: no observation counts as confirmed. It must come from an evaluation on site footage.
    min_confidence: float | None
    stale_after_minutes: int
    retention_days: int
    health: TrackingHealth
    # Area alerts (Phase 16, B16-13): evaluated at all; e-mailed to the visit's host; e-mailed to these.
    area_alerts_enabled: bool
    alert_notify_host: bool
    alert_emails: list[str]


class TrackingSettingsUpdate(RequestModel):
    """PATCH /tracking/settings: omitted fields are unchanged; `min_confidence` null clears it."""

    enabled: Annotated[bool | None, NotNull] = None
    min_confidence: Confidence | None = None
    stale_after_minutes: Annotated[StaleAfterMinutes | None, NotNull] = None
    retention_days: Annotated[RetentionDays | None, NotNull] = None
    area_alerts_enabled: Annotated[bool | None, NotNull] = None
    alert_notify_host: Annotated[bool | None, NotNull] = None
    alert_emails: Annotated[AlertEmails | None, NotNull] = None


# ---- keys ----------------------------------------------------------------------------------------------


class TrackingKey(ResponseModel):
    id: UUID
    label: str
    prefix: str  # the key's first characters, for telling keys apart; never the key
    created_at: UTCDatetime
    created_by: UserRef | None
    last_used_at: UTCDatetime | None
    revoked_at: UTCDatetime | None


class TrackingKeyCreated(TrackingKey):
    """POST /tracking/keys: the only answer that carries the key. It is stored as a SHA-256 digest."""

    secret: str


class TrackingKeyCreate(RequestModel):
    label: KeyLabel


# ---- cameras ------------------------------------------------------------------------------------------


class CameraRef(ResponseModel):
    id: UUID
    name: str


class TrackingCamera(ResponseModel):
    id: UUID
    provider_camera_id: str
    name: str
    zone_id: UUID
    location: JourneyLocation
    is_enrollment_point: bool
    is_active: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class TrackingCameraCreate(RequestModel):
    provider_camera_id: ProviderId
    name: CameraName
    zone_id: UUID
    is_enrollment_point: bool = False


class TrackingCameraUpdate(RequestModel):
    """PATCH: omitted fields are unchanged; `is_active` archives (false) or restores (true)."""

    provider_camera_id: Annotated[ProviderId | None, NotNull] = None
    name: Annotated[CameraName | None, NotNull] = None
    zone_id: Annotated[UUID | None, NotNull] = None
    is_enrollment_point: Annotated[bool | None, NotNull] = None
    is_active: Annotated[bool | None, NotNull] = None


class TrackingCameraListQuery(QueryModel):
    include_archived: bool = False  # administrators only


# ---- the provider's ingestion (not in the frontend's contract) -----------------------------------------

REQUIRED_FOR_TYPE = FieldProblem(FieldCode.REQUIRED, "This field is required for this type of event.")
NOT_FOR_TYPE = FieldProblem(FieldCode.NOT_ALLOWED, "This field is not allowed for this type of event.")
_NEEDS_CAMERA = frozenset({IngestEventType.ENROLLED, IngestEventType.OBSERVED})


class TrackingEventIn(RequestModel):
    """One event of a provider's batch. Unknown fields are refused, as everywhere; there is no free-form
    payload, and no company or visit ID: the company comes from the key, the visit from the ref."""

    provider_event_id: ProviderId
    type: IngestEventType
    association_ref: AssociationRefInput | None = None
    camera_id: ProviderId | None = None
    observed_at: RequestDatetime  # RFC 3339 with its offset
    match: ObservationMatch | None = None
    confidence: Confidence | None = None
    model_version: ModelVersion | None = None

    @model_validator(mode="after")
    def _fields_of_the_type(self) -> Self:
        problems: list[tuple[str, FieldProblem]] = []
        heartbeat = self.type is IngestEventType.HEARTBEAT
        if heartbeat and self.association_ref is not None:
            problems.append(("association_ref", NOT_FOR_TYPE))
        if not heartbeat and self.association_ref is None:
            problems.append(("association_ref", REQUIRED_FOR_TYPE))
        if self.type in _NEEDS_CAMERA and self.camera_id is None:
            problems.append(("camera_id", REQUIRED_FOR_TYPE))
        if self.type is IngestEventType.OBSERVED and self.match is None:
            problems.append(("match", REQUIRED_FOR_TYPE))
        if self.type is not IngestEventType.OBSERVED and self.match is not None:
            problems.append(("match", NOT_FOR_TYPE))
        if problems:
            raise _field_error(problems)
        return self


def _field_error(problems: list[tuple[str, FieldProblem]]) -> ValidationError:
    """A validation error at each field (a model validator's own errors have no location), shaped like
    the error of a validator that raised `FieldValueError(problem)`."""
    return ValidationError.from_exception_data(
        "TrackingEventIn",
        [
            InitErrorDetails(
                type="value_error", loc=(field,), input=None, ctx={"error": FieldValueError(problem)}
            )
            for field, problem in problems
        ],
    )


class TrackingEventBatch(RequestModel):
    events: Annotated[list[TrackingEventIn], Field(min_length=1, max_length=MAX_EVENTS_PER_BATCH)]


class TrackingEventOutcome(ResponseModel):
    provider_event_id: str
    result: IngestResult
    reason: RejectReason | None


class TrackingEventResults(ResponseModel):
    """One outcome per event, in the order of the batch."""

    results: list[TrackingEventOutcome]
