"""The Visitor Journey's rules, without a database (Phase 15, docs/visitor-journey-design.md).

**Every constant below is a placeholder pending the analysis of real footage** (B15-16): no tracking
model was available to measure them (docs/visitor-tracking-model-assessment.md, BLOCKED BY
ENVIRONMENT). They are named here once, recorded in docs/decisions/phase-15-backend.md and used nowhere
else.

The journey state of a visit is one value, computed on the server at every read (`journey_state`):

* DISABLED: the provider is `disabled`, or the company has tracking not allowed or not enabled.
* NOT_ENROLLED: the visit has no association.
* PENDING: its latest association is PENDING.
* ENDED: its latest association ended (or its expiry has passed).
* UNAVAILABLE: ACTIVE, but no contact from the provider within `PROVIDER_CONTACT_TIMEOUT`.
* STALE: ACTIVE, and the latest sighting is a LOST; or nothing confirmed for longer than the company's
  stale threshold: freshness is anchored on the latest confirmed observation's `observed_at`, or on the
  association's `activated_at` while there is no confirmed observation yet.
* UNCERTAIN: ACTIVE, and the latest observation is fresh (within the stale threshold) but not confirmed
  (the provider said UNCERTAIN, its confidence is below the company's threshold, the threshold is null,
  or the provider sent no confidence), or a confirmed observation within `CONFLICT_WINDOW` of it names
  another floor.
* ACTIVE: otherwise. A freshly activated association with no observation yet is ACTIVE, with no location
  ("Unknown"), until the stale threshold has passed since its activation (the lead's decision of
  2026-10-20, B15-12).

The checks run in that order (UNAVAILABLE, LOST, UNCERTAIN for a fresh unconfirmed or contested latest
observation, then the freshness anchor), so a fresh uncertain sighting reads UNCERTAIN and an old one
STALE.

"Latest" orders by `observed_at` (then `received_at`, then the row ID), never by arrival: an older
event that arrives late never replaces a newer one. A location is shown only from a confirmed
observation; with a null threshold nothing counts as confirmed (B15-12).
"""

import base64
import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from uuid import UUID

from app.models.enums import JourneyEventType, ObservationMatch, TrackingAssociationStatus

# ---- placeholders pending real footage (B15-16) ----------------------------------------------------
# Two confirmed observations this close in time that name different floors make the state UNCERTAIN.
CONFLICT_WINDOW = timedelta(seconds=60)
# No provider contact (any request with a valid key) for this long makes an ACTIVE journey UNAVAILABLE.
PROVIDER_CONTACT_TIMEOUT = timedelta(minutes=5)
# How far the provider's clock may run ahead of ours: an event observed later than now + this is
# rejected (IN_FUTURE); one observed earlier than its association's creation minus this is rejected
# (BEFORE_ASSOCIATION).
CLOCK_SKEW_TOLERANCE = timedelta(minutes=2)
# The longest an ACTIVE association lives without a check-out, revoke or switch-off: this long after
# its activation (B15-15, as amended after the independent review, B15-34).
ASSOCIATION_MAX_LIFETIME = timedelta(hours=12)
# A PENDING association the provider has not activated within this long after its creation expires,
# so a lost ENROLLED does not block the visit for hours: reception can start again (B15-34).
PENDING_TIMEOUT = timedelta(minutes=10)
# One JOURNEY_LIST_VIEWED audit row per user in this window, when the list shows a location (B15-31).
JOURNEY_LIST_AUDIT_WINDOW = timedelta(minutes=60)
# A visit's journey answers at most this many events (the most recent ones) and their total.
TIMELINE_LIMIT = 500
# One JOURNEY_VIEWED audit row per user and visit in this window (B15-19).
JOURNEY_VIEW_AUDIT_WINDOW = timedelta(minutes=60)

# ---- the ingestion contract (docs/visitor-tracking-integration.md) ----------------------------------
MAX_EVENTS_PER_BATCH = 100
MAX_LIVE_KEYS = 2  # unrevoked tracking keys per company: one in use, one for a rotation (B15-10)

REF_PREFIX = "trk_"
REF_RANDOM_BYTES = 20  # 160 bits -> 32 base32 characters
KEY_PREFIX = "vtk_"
KEY_RANDOM_BYTES = 32  # 256 bits -> 43 URL-safe characters
KEY_DISPLAY_LENGTH = len(KEY_PREFIX) + 4
KEY_PATTERN = re.compile(r"vtk_[A-Za-z0-9_-]{43}", re.ASCII)
BEARER = re.compile(r"Bearer (vtk_[A-Za-z0-9_-]{43})", re.ASCII)


class JourneyState(StrEnum):
    DISABLED = "DISABLED"
    NOT_ENROLLED = "NOT_ENROLLED"
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    UNCERTAIN = "UNCERTAIN"
    STALE = "STALE"
    UNAVAILABLE = "UNAVAILABLE"
    ENDED = "ENDED"


class EnrollBlocker(StrEnum):
    """Why a visit cannot be enrolled now: a short state the interface shows instead of a note."""

    PROVIDER_DISABLED = "PROVIDER_DISABLED"
    NOT_ALLOWED = "NOT_ALLOWED"
    NOT_ENABLED = "NOT_ENABLED"
    NOT_CHECKED_IN = "NOT_CHECKED_IN"
    ALREADY_ENROLLED = "ALREADY_ENROLLED"
    NO_ENROLLMENT_POINT = "NO_ENROLLMENT_POINT"
    NOT_PERMITTED = "NOT_PERMITTED"


class IngestEventType(StrEnum):
    """What the provider may send. ENROLLMENT_FAILED and HEARTBEAT change state but are not stored."""

    ENROLLED = "ENROLLED"
    ENROLLMENT_FAILED = "ENROLLMENT_FAILED"
    OBSERVED = "OBSERVED"
    LOST = "LOST"
    HEARTBEAT = "HEARTBEAT"


class IngestResult(StrEnum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"
    REJECTED = "rejected"


class RejectReason(StrEnum):
    """Why an event was rejected. Rejected events are never stored, only counted (B15-9, B15-11)."""

    TRACKING_OFF = "TRACKING_OFF"  # the company has tracking not allowed or not enabled
    UNKNOWN_ASSOCIATION = "UNKNOWN_ASSOCIATION"  # no association of this company has the ref
    ASSOCIATION_ENDED = "ASSOCIATION_ENDED"  # ended (or expired) before the event was observed
    ALREADY_ENROLLED = "ALREADY_ENROLLED"  # ENROLLED / ENROLLMENT_FAILED for an ACTIVE association
    # OBSERVED / LOST for an association the provider has not activated (still PENDING): nobody is bound
    # to it yet, so the sighting may be of anyone (B15-28).
    NOT_ACTIVE = "NOT_ACTIVE"
    UNKNOWN_CAMERA = "UNKNOWN_CAMERA"  # not a registered, active camera of the company
    CAMERA_MISMATCH = "CAMERA_MISMATCH"  # ENROLLED at another camera than the enrollment camera
    TOO_OLD = "TOO_OLD"  # observed before the company's retention window
    IN_FUTURE = "IN_FUTURE"  # observed more than CLOCK_SKEW_TOLERANCE after now
    BEFORE_ASSOCIATION = "BEFORE_ASSOCIATION"  # observed before the association existed


class ProviderOperation(StrEnum):
    """A call of the application to the provider that failed (counted in the health record)."""

    ENROLL = "ENROLL"
    REVOKE = "REVOKE"


# The health counts' reason column holds a rejection reason or `PROVIDER_<operation>_FAILED`.
PROVIDER_FAILURE_PREFIX = "PROVIDER_"
PROVIDER_FAILURE_SUFFIX = "_FAILED"


def provider_failure_reason(operation: ProviderOperation) -> str:
    return f"{PROVIDER_FAILURE_PREFIX}{operation.value}{PROVIDER_FAILURE_SUFFIX}"


def provider_operation_of(reason: str) -> ProviderOperation | None:
    if reason.startswith(PROVIDER_FAILURE_PREFIX) and reason.endswith(PROVIDER_FAILURE_SUFFIX):
        name = reason.removeprefix(PROVIDER_FAILURE_PREFIX).removesuffix(PROVIDER_FAILURE_SUFFIX)
        return ProviderOperation(name) if name in ProviderOperation.__members__ else None
    return None


# ---- references and keys -----------------------------------------------------------------------------


def new_ref() -> str:
    """A new association reference: `trk_` + 32 base32 characters (160 random bits). Nothing of the
    visit, the visitor, an e-mail, a phone number, a name or a pass goes into it (B15-6)."""
    random = base64.b32encode(secrets.token_bytes(REF_RANDOM_BYTES)).decode("ascii").lower()
    return REF_PREFIX + random


@dataclass(frozen=True, slots=True)
class NewKey:
    secret: str  # shown once, never stored
    prefix: str  # for display
    digest: str  # SHA-256, the only thing stored


def new_key() -> NewKey:
    secret = KEY_PREFIX + secrets.token_urlsafe(KEY_RANDOM_BYTES)
    return NewKey(secret=secret, prefix=secret[:KEY_DISPLAY_LENGTH], digest=key_digest(secret))


def key_digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("ascii")).hexdigest()


def presented_key(authorization: str | None) -> str | None:
    """The key of an `Authorization: Bearer <key>` header, or None when the header is absent or is not
    exactly that (a key never comes from a cookie, a query string or the body)."""
    if authorization is None:
        return None
    match = BEARER.fullmatch(authorization.strip())
    return match.group(1) if match else None


# ---- the association's lifetime ------------------------------------------------------------------------


def pending_expiry(created_at: datetime) -> datetime:
    """When a PENDING association expires unless the provider activates it first (B15-34)."""
    return created_at + PENDING_TIMEOUT


def active_expiry(activated_at: datetime) -> datetime:
    """When an ACTIVE association expires unless a check-out, a revoke or a switch-off ends it sooner
    (B15-34): ASSOCIATION_MAX_LIFETIME after its activation."""
    return activated_at + ASSOCIATION_MAX_LIFETIME


# ---- the journey state ---------------------------------------------------------------------------------


def is_confirmed(match: str | None, confidence: float | None, threshold: float | None) -> bool:
    """Whether the application counts an observation as confirmed: the provider said CONFIRMED, and its
    confidence is at least the company's threshold. A null threshold confirms nothing (it must come from
    an evaluation on site footage, B15-12); an observation without a confidence is never confirmed."""
    return (
        match == ObservationMatch.CONFIRMED
        and threshold is not None
        and confidence is not None
        and confidence >= threshold
    )


@dataclass(frozen=True, slots=True)
class Sighting:
    """An OBSERVED or LOST event as the state needs it."""

    event_id: UUID
    type: JourneyEventType
    observed_at: datetime
    floor_id: UUID | None
    match: str | None
    confidence: float | None


@dataclass(frozen=True, slots=True)
class AssociationFacts:
    status: TrackingAssociationStatus
    expires_at: datetime
    activated_at: datetime | None = None  # set once ACTIVE (a CHECK of the table)


def journey_state(
    *,
    tracking_on: bool,
    association: AssociationFacts | None,
    last_contact_at: datetime | None,
    latest_sighting: Sighting | None,
    latest_confirmed_at: datetime | None,
    conflict: bool,
    threshold: float | None,
    stale_after: timedelta,
    now: datetime,
) -> JourneyState:
    """The journey state (see the module's list). `latest_sighting` is the latest OBSERVED or LOST event
    of the latest association; `latest_confirmed_at` the `observed_at` of its latest confirmed
    observation; `conflict` whether a confirmed observation within CONFLICT_WINDOW of the latest confirmed
    one names another floor."""
    if not tracking_on:
        return JourneyState.DISABLED
    if association is None:
        return JourneyState.NOT_ENROLLED
    if association.status is TrackingAssociationStatus.ENDED or association.expires_at <= now:
        return JourneyState.ENDED
    if association.status is TrackingAssociationStatus.PENDING:
        return JourneyState.PENDING
    if last_contact_at is None or now - last_contact_at > PROVIDER_CONTACT_TIMEOUT:
        return JourneyState.UNAVAILABLE
    if latest_sighting is not None and latest_sighting.type is JourneyEventType.LOST:
        return JourneyState.STALE
    if latest_sighting is not None and now - latest_sighting.observed_at <= stale_after:
        confirmed = is_confirmed(latest_sighting.match, latest_sighting.confidence, threshold)
        if not confirmed or conflict:
            return JourneyState.UNCERTAIN
    # Freshness: the latest confirmed observation, or the activation while there is none yet.
    anchor = latest_confirmed_at or association.activated_at
    if anchor is None or now - anchor > stale_after:
        return JourneyState.STALE
    return JourneyState.ACTIVE


def freshness_seconds(observed_at: datetime | None, *, now: datetime) -> int | None:
    """Whole seconds since an observation (0 for one a provider's clock placed slightly ahead)."""
    if observed_at is None:
        return None
    return max(0, int((now - observed_at).total_seconds()))
