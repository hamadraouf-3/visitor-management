"""The Visitor Journey's provider-neutral boundary (revision 0018, Phase 15, docs/visitor-journey-design.md).

Every row carries `company_id`, and every reference to a row of the same company is a composite foreign
key over `(company_id, …)`, as elsewhere in the schema: a child can never point at another company's
parent (B15-3).

* The location registry: `buildings` → `floors` → `zones`, and `tracking_cameras` (the provider's camera
  IDs, each in a zone). No credential, URL, address or stream of a camera is stored: those stay with the
  provider (B15-4). Rows are archived (`is_active`), never deleted: the runtime role cannot delete
  (revision 0006), and history refers to them (B15-5).
* `tracking_associations`: a visit's random reference (`ref`) given to the provider, with its lifecycle.
  At most one PENDING or ACTIVE association per visit (a partial unique index). The ref never derives
  from the visit, the visitor or a pass (B15-6).
* `visitor_journey_events`: append-only observations, with the building, floor and zone resolved when the
  event arrived, so a later camera move never rewrites history (B15-8). No provider payload, image,
  crop, embedding or template is stored, ever.
* `tracking_keys`: the provider's credentials per company, stored as SHA-256 digests only; at most two
  unrevoked keys per company (a partial unique index on a slot, B15-10).
* `company_tracking_settings`: the platform owner's `allowed` and the company's own settings, a side
  table rather than columns of `companies` (B15-2). A company without a row has the defaults.
* `tracking_health`, `tracking_health_counts`: the last contact and accepted event, and counts of
  rejections and provider failures by reason over a 24-hour ring of hourly slots (B15-11).

Revision 0019 (Phase 16, docs/decisions/phase-16-backend.md) adds, without changing anything 0018 holds:

* `zones.access` (COMMON, STANDARD, RESTRICTED; B16-1), `departments.floor_id` (the default allowed floor
  of the department's visits, B16-3) and the companies' alert settings (B16-13);
* `visit_access_areas`: each visit's allowed floors and extra zones, one row per area, removed rows kept
  with `removed_at` (the runtime role cannot delete, B16-2);
* `tracking_alerts`: a visitor seen outside the visit's allowed areas, at most one active (OPEN or
  ACKNOWLEDGED) per visit (a partial unique index, B16-6).

Revision 0020 adds `tracking_alerts.escalated_at` (nullable): when an alert escalated, so the summary
names an escalation among the newest (B16-26).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import (
    JourneyEventType,
    ObservationMatch,
    TrackingAlertResolution,
    TrackingAlertStatus,
    TrackingAlertType,
    TrackingAssociationStatus,
    TrackingEndReason,
    ZoneAccess,
    sql_in_list,
)

# Floors are ordered by `level` (negative below ground). A placeholder range wide enough for any
# building the product will meet (B15-5).
FLOOR_LEVEL_MIN = -20
FLOOR_LEVEL_MAX = 200
LOCATION_NAME_MAX_LENGTH = 120
CAMERA_NAME_MAX_LENGTH = 120
PROVIDER_ID_MAX_LENGTH = 128
MODEL_VERSION_MAX_LENGTH = 64
KEY_LABEL_MAX_LENGTH = 100
# The provider's identifiers (camera IDs, event IDs) are visible ASCII: no space, no control character,
# nothing that renders as something else (B15-4).
VISIBLE_ASCII = "^[!-~]+$"
# A provider's name as the deployment names it (`TRACKING_PROVIDER`), e.g. `simulator`.
PROVIDER_NAME_PATTERN = "^[a-z][a-z0-9_]{0,31}$"
# `trk_` + 32 base32 characters: 160 random bits (B15-6).
REF_PATTERN = "^trk_[a-z2-7]{32}$"
KEY_PREFIX_PATTERN = "^vtk_[A-Za-z0-9_-]{4}$"
SHA256_HEX_PATTERN = "^[0-9a-f]{64}$"
# Settings ranges (B15-12). The stale threshold and the retention are display and retention settings;
# the minimum confidence has no default: it must come from an evaluation on site footage.
STALE_AFTER_MINUTES_DEFAULT = 15
STALE_AFTER_MINUTES_MAX = 240
RETENTION_DAYS_DEFAULT = 30
RETENTION_DAYS_MAX = 90
HEALTH_SLOTS = 24  # hourly slots of `tracking_health_counts`: the last 24 hours (B15-11)
OPEN_STATUSES_SQL = "status IN ('PENDING', 'ACTIVE')"
# Phase 16: the addresses a company's area alerts go to besides the host (B16-13), and an alert's note.
ALERT_EMAILS_MAX = 5
ALERT_EMAIL_MAX_LENGTH = 320
ALERT_NOTE_MAX_LENGTH = 300
ACTIVE_ALERT_STATUSES_SQL = "status IN ('OPEN', 'ACKNOWLEDGED')"
LIVE_AREA_SQL = "removed_at IS NULL"


def _same_company(
    columns: list[str], target: str, target_columns: list[str], name: str
) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(
        columns, [f"{target}.{column}" for column in target_columns], name=name, ondelete="RESTRICT"
    )


def _name_checks() -> tuple[CheckConstraint, CheckConstraint]:
    return (
        CheckConstraint("btrim(name) <> ''", name="name_not_blank"),
        CheckConstraint("name_ar IS NULL OR btrim(name_ar) <> ''", name="name_ar_not_blank"),
    )


# ---- the location registry -----------------------------------------------------------------------


class Building(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "buildings"
    __table_args__ = (UniqueConstraint("company_id", "id"), *_name_checks())

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(LOCATION_NAME_MAX_LENGTH), nullable=False)
    name_ar: Mapped[str | None] = mapped_column(String(LOCATION_NAME_MAX_LENGTH))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


class Floor(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "floors"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        # Target of the journey events' (company, building, floor): the floor is in that building.
        UniqueConstraint("company_id", "building_id", "id"),
        UniqueConstraint("building_id", "level"),
        _same_company(["company_id", "building_id"], "buildings", ["company_id", "id"], "fk_floors_building"),
        CheckConstraint(f"level BETWEEN {FLOOR_LEVEL_MIN} AND {FLOOR_LEVEL_MAX}", name="level_range"),
        *_name_checks(),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    building_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(LOCATION_NAME_MAX_LENGTH), nullable=False)
    name_ar: Mapped[str | None] = mapped_column(String(LOCATION_NAME_MAX_LENGTH))
    level: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


class Zone(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "zones"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        # Target of the journey events' (company, floor, zone): the zone is on that floor.
        UniqueConstraint("company_id", "floor_id", "id"),
        _same_company(["company_id", "floor_id"], "floors", ["company_id", "id"], "fk_zones_floor"),
        *_name_checks(),
        CheckConstraint(f"access IN ({sql_in_list(ZoneAccess)})", name="access_valid"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    floor_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(LOCATION_NAME_MAX_LENGTH), nullable=False)
    name_ar: Mapped[str | None] = mapped_column(String(LOCATION_NAME_MAX_LENGTH))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Who may be in it (revision 0019, B16-1); a zone created before Phase 16 is STANDARD.
    access: Mapped[str] = mapped_column(
        String(10), nullable=False, default=ZoneAccess.STANDARD.value, server_default=text("'STANDARD'")
    )


# Names unique per parent, ignoring case (the services answer 409 CONFLICT on `name`).
Index("uq_buildings_company_name", Building.company_id, func.lower(Building.name), unique=True)
Index("uq_zones_floor_name", Zone.floor_id, func.lower(Zone.name), unique=True)


class TrackingCamera(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A camera as the provider names it (`provider_camera_id`), placed in a zone. A camera without a zone
    cannot exist. No credential, URL, IP address or stream address is stored (B15-4)."""

    __tablename__ = "tracking_cameras"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        UniqueConstraint("company_id", "provider_camera_id"),
        _same_company(["company_id", "zone_id"], "zones", ["company_id", "id"], "fk_tracking_cameras_zone"),
        CheckConstraint(f"provider_camera_id ~ '{VISIBLE_ASCII}'", name="provider_camera_id_visible_ascii"),
        CheckConstraint("btrim(name) <> ''", name="name_not_blank"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    provider_camera_id: Mapped[str] = mapped_column(String(PROVIDER_ID_MAX_LENGTH), nullable=False)
    name: Mapped[str] = mapped_column(String(CAMERA_NAME_MAX_LENGTH), nullable=False)
    zone_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    # A reception camera: enrollment binds "the person at this camera now" to an association.
    is_enrollment_point: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


# ---- associations and their events ---------------------------------------------------------------


class TrackingAssociation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "tracking_associations"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        # Target of the events' (company, association, visit): an event's visit is its association's.
        UniqueConstraint("company_id", "id", "visit_id"),
        UniqueConstraint("ref"),
        _same_company(
            ["company_id", "visit_id"], "visits", ["company_id", "id"], "fk_tracking_associations_visit"
        ),
        _same_company(
            ["company_id", "enrollment_camera_id"],
            "tracking_cameras",
            ["company_id", "id"],
            "fk_tracking_associations_camera",
        ),
        _same_company(
            ["company_id", "created_by_id"], "users", ["company_id", "id"], "fk_tracking_associations_user"
        ),
        CheckConstraint(f"ref ~ '{REF_PATTERN}'", name="ref_format"),
        CheckConstraint(f"provider ~ '{PROVIDER_NAME_PATTERN}'", name="provider_name"),
        CheckConstraint(f"status IN ({sql_in_list(TrackingAssociationStatus)})", name="status_valid"),
        CheckConstraint(
            f"ended_reason IS NULL OR ended_reason IN ({sql_in_list(TrackingEndReason)})",
            name="ended_reason_valid",
        ),
        CheckConstraint("(status = 'ENDED') = (ended_at IS NOT NULL)", name="ended_status"),
        CheckConstraint("(ended_at IS NULL) = (ended_reason IS NULL)", name="ended_reason_set"),
        CheckConstraint("status <> 'ACTIVE' OR activated_at IS NOT NULL", name="active_activated"),
        CheckConstraint("status <> 'PENDING' OR activated_at IS NULL", name="pending_not_activated"),
        CheckConstraint("activated_at IS NULL OR activated_at >= created_at", name="activated_after_created"),
        CheckConstraint("ended_at IS NULL OR ended_at >= created_at", name="ended_after_created"),
        CheckConstraint("expires_at > created_at", name="expires_after_created"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    visit_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    # Random, never derived from the visit, the visitor or a pass; given only to the provider; never
    # logged, audited or returned by the API (B15-6).
    ref: Mapped[str] = mapped_column(String(36), nullable=False)
    # The deployment's provider when the association was made (`TRACKING_PROVIDER`).
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    enrollment_camera_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    status: Mapped[str] = mapped_column(
        String(8),
        nullable=False,
        default=TrackingAssociationStatus.PENDING.value,
        server_default=text("'PENDING'"),
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_reason: Mapped[str | None] = mapped_column(String(24))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# At most one PENDING or ACTIVE association per visit: a retried enrollment finds it instead of making a
# second one.
Index(
    "uq_tracking_associations_open_visit",
    TrackingAssociation.visit_id,
    unique=True,
    postgresql_where=text(OPEN_STATUSES_SQL),
)
# The open associations of a company by expiry: the expiry sweep of every read and ingest, and the
# revocation of them all when tracking is switched off.
Index(
    "ix_tracking_associations_open_company",
    TrackingAssociation.company_id,
    TrackingAssociation.expires_at,
    postgresql_where=text(OPEN_STATUSES_SQL),
)
# The latest association of a visit.
Index(
    "ix_tracking_associations_visit_created",
    TrackingAssociation.company_id,
    TrackingAssociation.visit_id,
    TrackingAssociation.created_at,
)
# Ended associations by end time (`cli prune-journeys`).
Index(
    "ix_tracking_associations_ended",
    TrackingAssociation.company_id,
    TrackingAssociation.ended_at,
    postgresql_where=text("status = 'ENDED'"),
)


class VisitorJourneyEvent(UUIDPrimaryKeyMixin, Base):
    """An observation the provider reported for an association, append-only (the runtime role holds no
    UPDATE on it, and a trigger refuses every UPDATE). Rejected events are never stored: rows about
    people who are not enrolled visitors would be surveillance data (B15-9)."""

    __tablename__ = "visitor_journey_events"
    __table_args__ = (
        UniqueConstraint(
            "company_id", "provider", "provider_event_id", name="uq_journey_events_provider_event"
        ),
        _same_company(
            ["company_id", "association_id", "visit_id"],
            "tracking_associations",
            ["company_id", "id", "visit_id"],
            "fk_journey_events_association",
        ),
        _same_company(
            ["company_id", "camera_id"], "tracking_cameras", ["company_id", "id"], "fk_journey_events_camera"
        ),
        _same_company(
            ["company_id", "building_id", "floor_id"],
            "floors",
            ["company_id", "building_id", "id"],
            "fk_journey_events_floor",
        ),
        _same_company(
            ["company_id", "floor_id", "zone_id"],
            "zones",
            ["company_id", "floor_id", "id"],
            "fk_journey_events_zone",
        ),
        CheckConstraint(f"type IN ({sql_in_list(JourneyEventType)})", name="type_valid"),
        CheckConstraint(f"match IS NULL OR match IN ({sql_in_list(ObservationMatch)})", name="match_valid"),
        CheckConstraint("(type = 'OBSERVED') = (match IS NOT NULL)", name="match_of_observation"),
        CheckConstraint("type = 'LOST' OR camera_id IS NOT NULL", name="camera_of_sighting"),
        CheckConstraint(
            "(camera_id IS NULL) = (zone_id IS NULL) AND (zone_id IS NULL) = (floor_id IS NULL) "
            "AND (floor_id IS NULL) = (building_id IS NULL)",
            name="location_complete",
        ),
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)", name="confidence_range"
        ),
        CheckConstraint(f"provider_event_id ~ '{VISIBLE_ASCII}'", name="provider_event_id_visible"),
        CheckConstraint(f"provider ~ '{PROVIDER_NAME_PATTERN}'", name="provider_name"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    visit_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    association_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_event_id: Mapped[str] = mapped_column(String(PROVIDER_ID_MAX_LENGTH), nullable=False)
    type: Mapped[str] = mapped_column(String(8), nullable=False)
    camera_id: Mapped[uuid.UUID | None] = mapped_column()
    # Where the camera was when the event arrived (B15-8).
    building_id: Mapped[uuid.UUID | None] = mapped_column()
    floor_id: Mapped[uuid.UUID | None] = mapped_column()
    zone_id: Mapped[uuid.UUID | None] = mapped_column()
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Set by the ingestion service from the application clock.
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    match: Mapped[str | None] = mapped_column(String(12))
    # Only what the provider sent (B15-9).
    confidence: Mapped[float | None] = mapped_column(Double)
    model_version: Mapped[str | None] = mapped_column(String(MODEL_VERSION_MAX_LENGTH))


# A visit's timeline and its latest observations ("latest" orders by observed_at).
Index(
    "ix_journey_events_visit_observed",
    VisitorJourneyEvent.company_id,
    VisitorJourneyEvent.visit_id,
    VisitorJourneyEvent.observed_at,
)
# A camera's events by time.
Index(
    "ix_journey_events_camera_observed",
    VisitorJourneyEvent.company_id,
    VisitorJourneyEvent.camera_id,
    VisitorJourneyEvent.observed_at,
)
# The retention prune (`cli prune-journeys`).
Index("ix_journey_events_company_observed", VisitorJourneyEvent.company_id, VisitorJourneyEvent.observed_at)


# ---- the provider's credentials ------------------------------------------------------------------


class TrackingKey(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A provider credential of a company. Only the SHA-256 digest of the key is stored; the key itself
    is shown once, in the answer that creates it (B15-10)."""

    __tablename__ = "tracking_keys"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        UniqueConstraint("key_hash"),
        _same_company(
            ["company_id", "created_by_id"], "users", ["company_id", "id"], "fk_tracking_keys_creator"
        ),
        _same_company(
            ["company_id", "revoked_by_id"], "users", ["company_id", "id"], "fk_tracking_keys_revoker"
        ),
        CheckConstraint(f"key_hash ~ '{SHA256_HEX_PATTERN}'", name="key_hash_sha256"),
        CheckConstraint(f"prefix ~ '{KEY_PREFIX_PATTERN}'", name="prefix_format"),
        CheckConstraint("slot IN (1, 2)", name="slot_valid"),
        CheckConstraint("revoked_at IS NOT NULL OR revoked_by_id IS NULL", name="revoked_by_when_revoked"),
        CheckConstraint("btrim(label) <> ''", name="label_not_blank"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(KEY_LABEL_MAX_LENGTH), nullable=False)
    prefix: Mapped[str] = mapped_column(String(8), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # An unrevoked key holds slot 1 or 2 (`uq_tracking_keys_live_slot`): two at most, for a rotation.
    slot: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by_id: Mapped[uuid.UUID | None] = mapped_column()


Index(
    "uq_tracking_keys_live_slot",
    TrackingKey.company_id,
    TrackingKey.slot,
    unique=True,
    postgresql_where=text("revoked_at IS NULL"),
)


# ---- settings and health -------------------------------------------------------------------------


class CompanyTrackingSettings(TimestampMixin, Base):
    """A company's tracking settings (B15-2). `allowed` is the platform owner's; the rest the company
    administrator's, and `enabled` only while allowed."""

    __tablename__ = "company_tracking_settings"
    __table_args__ = (
        CheckConstraint("allowed OR NOT enabled", name="enabled_only_when_allowed"),
        CheckConstraint(
            "min_confidence IS NULL OR (min_confidence >= 0 AND min_confidence <= 1)",
            name="min_confidence_range",
        ),
        CheckConstraint(
            f"stale_after_minutes BETWEEN 1 AND {STALE_AFTER_MINUTES_MAX}", name="stale_after_minutes_range"
        ),
        CheckConstraint(f"retention_days BETWEEN 1 AND {RETENTION_DAYS_MAX}", name="retention_days_range"),
        CheckConstraint(f"cardinality(alert_emails) <= {ALERT_EMAILS_MAX}", name="alert_emails_count"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), primary_key=True
    )
    allowed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # NULL: no observation counts as confirmed (B15-12). Never defaulted: it comes from an evaluation.
    min_confidence: Mapped[float | None] = mapped_column(Double)
    stale_after_minutes: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=STALE_AFTER_MINUTES_DEFAULT,
        server_default=text(str(STALE_AFTER_MINUTES_DEFAULT)),
    )
    retention_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=RETENTION_DAYS_DEFAULT,
        server_default=text(str(RETENTION_DAYS_DEFAULT)),
    )
    # Area alerts (revision 0019, B16-13): evaluated at all; e-mailed to the visit's host; e-mailed to these
    # addresses (lower case, distinct, at most ALERT_EMAILS_MAX: the service normalises them).
    area_alerts_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    alert_notify_host: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    alert_emails: Mapped[list[str]] = mapped_column(
        ARRAY(String(ALERT_EMAIL_MAX_LENGTH)), nullable=False, default=list, server_default=text("'{}'")
    )


class TrackingHealth(Base):
    """The provider's last contact with a company (any request with a valid key) and the last accepted
    event. Reasons and counts only, never a payload (B15-11)."""

    __tablename__ = "tracking_health"

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), primary_key=True
    )
    last_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_accepted_event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TrackingHealthCount(Base):
    """How many events were rejected for a reason (or provider calls failed) in one hour: a ring of
    `HEALTH_SLOTS` hourly slots per company and reason, reused in place, so the table never grows and
    the runtime role never deletes (B15-11)."""

    __tablename__ = "tracking_health_counts"
    __table_args__ = (
        PrimaryKeyConstraint("company_id", "reason", "slot"),
        CheckConstraint(f"slot BETWEEN 0 AND {HEALTH_SLOTS - 1}", name="slot_range"),
        CheckConstraint("count >= 1", name="count_positive"),
        CheckConstraint("reason ~ '^[A-Z][A-Z_]{0,31}$'", name="reason_format"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("companies.id", ondelete="RESTRICT"))
    reason: Mapped[str] = mapped_column(String(32))
    slot: Mapped[int] = mapped_column(SmallInteger)
    hour_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False)


# ---- allowed areas and area alerts (revision 0019, Phase 16) ---------------------------------------


class VisitAccessArea(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """One allowed area of a visit: a floor, or an extra zone (any access level, on any floor), never both
    (B16-2). A visit with no live row has its areas "not set": only RESTRICTED zones alert for it. The
    runtime role cannot delete, so an area taken away is kept with `removed_at`; a live area of a visit
    is unique (partial unique indexes)."""

    __tablename__ = "visit_access_areas"
    __table_args__ = (
        _same_company(
            ["company_id", "visit_id"], "visits", ["company_id", "id"], "fk_visit_access_areas_visit"
        ),
        _same_company(
            ["company_id", "floor_id"], "floors", ["company_id", "id"], "fk_visit_access_areas_floor"
        ),
        _same_company(["company_id", "zone_id"], "zones", ["company_id", "id"], "fk_visit_access_areas_zone"),
        CheckConstraint("(floor_id IS NULL) <> (zone_id IS NULL)", name="one_area"),
        CheckConstraint("removed_at IS NULL OR removed_at >= created_at", name="removed_after_added"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    visit_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    floor_id: Mapped[uuid.UUID | None] = mapped_column()
    zone_id: Mapped[uuid.UUID | None] = mapped_column()
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


Index(
    "uq_visit_access_areas_live_floor",
    VisitAccessArea.visit_id,
    VisitAccessArea.floor_id,
    unique=True,
    postgresql_where=text(LIVE_AREA_SQL),
)
Index(
    "uq_visit_access_areas_live_zone",
    VisitAccessArea.visit_id,
    VisitAccessArea.zone_id,
    unique=True,
    postgresql_where=text(LIVE_AREA_SQL),
)
# The live areas of a page of visits (every `Visit` answer carries them).
Index(
    "ix_visit_access_areas_live_visit",
    VisitAccessArea.company_id,
    VisitAccessArea.visit_id,
    postgresql_where=text(LIVE_AREA_SQL),
)


class TrackingAlert(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A visitor seen, by the journey's own confirmed location, where the visit's allowed areas do not
    allow (B16-5 to B16-12). At most one active (OPEN or ACKNOWLEDGED) alert per visit. The first and the
    latest violating location are kept as resolved when they were seen (like the events, B15-8); its
    visit is its association's (a composite key). The association's deletion by retention takes its
    alerts with it (ON DELETE CASCADE, B16-17); `cli prune-journeys` deletes alerts by their own age
    first."""

    __tablename__ = "tracking_alerts"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        ForeignKeyConstraint(
            ["company_id", "association_id", "visit_id"],
            [
                "tracking_associations.company_id",
                "tracking_associations.id",
                "tracking_associations.visit_id",
            ],
            name="fk_tracking_alerts_association",
            ondelete="CASCADE",
        ),
        _same_company(
            ["company_id", "first_building_id", "first_floor_id"],
            "floors",
            ["company_id", "building_id", "id"],
            "fk_tracking_alerts_first_floor",
        ),
        _same_company(
            ["company_id", "first_floor_id", "first_zone_id"],
            "zones",
            ["company_id", "floor_id", "id"],
            "fk_tracking_alerts_first_zone",
        ),
        _same_company(
            ["company_id", "last_building_id", "last_floor_id"],
            "floors",
            ["company_id", "building_id", "id"],
            "fk_tracking_alerts_last_floor",
        ),
        _same_company(
            ["company_id", "last_floor_id", "last_zone_id"],
            "zones",
            ["company_id", "floor_id", "id"],
            "fk_tracking_alerts_last_zone",
        ),
        _same_company(
            ["company_id", "acknowledged_by_id"],
            "users",
            ["company_id", "id"],
            "fk_tracking_alerts_acknowledger",
        ),
        _same_company(
            ["company_id", "resolved_by_id"], "users", ["company_id", "id"], "fk_tracking_alerts_resolver"
        ),
        CheckConstraint(f"type IN ({sql_in_list(TrackingAlertType)})", name="type_valid"),
        CheckConstraint(f"status IN ({sql_in_list(TrackingAlertStatus)})", name="status_valid"),
        CheckConstraint(
            f"resolution IS NULL OR resolution IN ({sql_in_list(TrackingAlertResolution)})",
            name="resolution_valid",
        ),
        CheckConstraint("(status = 'RESOLVED') = (resolved_at IS NOT NULL)", name="resolved_status"),
        CheckConstraint("(resolved_at IS NULL) = (resolution IS NULL)", name="resolution_set"),
        CheckConstraint("resolved_at IS NOT NULL OR resolved_by_id IS NULL", name="resolver_when_resolved"),
        CheckConstraint("status <> 'ACKNOWLEDGED' OR acknowledged_at IS NOT NULL", name="acknowledged_set"),
        CheckConstraint("status <> 'OPEN' OR acknowledged_at IS NULL", name="open_unacknowledged"),
        CheckConstraint(
            "acknowledged_at IS NOT NULL OR acknowledged_by_id IS NULL", name="acknowledger_when_acknowledged"
        ),
        CheckConstraint("observations >= 1", name="observations_positive"),
        CheckConstraint("last_seen_at >= opened_at", name="seen_after_opened"),
        CheckConstraint("note IS NULL OR btrim(note) <> ''", name="note_not_blank"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    visit_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    association_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(
        String(12), nullable=False, default=TrackingAlertStatus.OPEN.value, server_default=text("'OPEN'")
    )
    # Raised from the simulator's association: marked Simulated everywhere (B16-12).
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Where it opened and the latest violating place, as resolved then.
    first_building_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    first_floor_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    first_zone_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    last_building_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    last_floor_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    last_zone_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    # `observed_at` of the first and of the latest violating observation.
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    observations: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default=text("1"))
    # The server's time of its escalation (UNAUTHORIZED_AREA -> RESTRICTED_AREA, B16-8); NULL for an alert
    # that never escalated. The summary names the newest of this or `opened_at` first (revision 0020, B16-26).
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_by_id: Mapped[uuid.UUID | None] = mapped_column()
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column()  # NULL with `resolved_at`: the system
    resolution: Mapped[str | None] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(String(ALERT_NOTE_MAX_LENGTH))  # the latest staff note


# At most one active alert per visit: the database's half of the engine's rule (B16-6).
Index(
    "uq_tracking_alerts_active_visit",
    TrackingAlert.visit_id,
    unique=True,
    postgresql_where=text(ACTIVE_ALERT_STATUSES_SQL),
)
# The summary and the active list (company, status: the summary sorts the company's few OPEN alerts, at
# most one per checked-in visit, B16-26); a day's list (company, opened_at); a visit's alerts.
Index("ix_tracking_alerts_company_status", TrackingAlert.company_id, TrackingAlert.status)
Index("ix_tracking_alerts_company_opened", TrackingAlert.company_id, TrackingAlert.opened_at)
Index("ix_tracking_alerts_visit", TrackingAlert.company_id, TrackingAlert.visit_id, TrackingAlert.opened_at)
# The association's foreign key (its deletion by retention) and the retention prune (`cli prune-journeys`).
Index("ix_tracking_alerts_association", TrackingAlert.association_id)
Index("ix_tracking_alerts_company_updated", TrackingAlert.company_id, TrackingAlert.updated_at)
