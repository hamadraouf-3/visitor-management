"""Queries of the Visitor Journey (Phase 15). Every query is scoped by `company_id` (contract §3.2-5): an ID
of another company finds nothing, exactly like an ID that does not exist.

Lock order (`repositories.locking`, extended by B15-18 and corrected after the independent review,
B15-29): **the company row first, always**. A visit change: the company row `FOR KEY SHARE`, then the
visit row, then the visit's tracking association. A company-wide change (tracking switched off, a key
revoked, the platform owner's switch, a deactivation): the company row `FOR UPDATE`, then its settings or
key row, then the open associations in ID order. An ingested batch and an expiry sweep: the company row
`FOR KEY SHARE` too, then the key row, then the associations in ID order, then the health rows. Inserting
an event takes `FOR KEY SHARE` on the rows its foreign keys name (the company among them), which a batch
already holds; so no writer waits for the company row while it holds a row another writer needs first.
"""

from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, RowMapping, Select, and_, case, func, or_, select, true, update
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.orm import Session, aliased
from sqlalchemy.sql.selectable import LateralFromClause

from app.models import (
    Building,
    CompanyTrackingSettings,
    Floor,
    TrackingAssociation,
    TrackingCamera,
    TrackingHealth,
    TrackingHealthCount,
    TrackingKey,
    Visit,
    VisitorJourneyEvent,
    Zone,
)
from app.models.enums import JourneyEventType, ObservationMatch, TrackingAssociationStatus
from app.models.tracking import HEALTH_SLOTS
from app.repositories.locking import RowLock, with_lock

OPEN = (TrackingAssociationStatus.PENDING.value, TrackingAssociationStatus.ACTIVE.value)
SIGHTINGS = (JourneyEventType.OBSERVED.value, JourneyEventType.LOST.value)
HEALTH_WINDOW = timedelta(hours=HEALTH_SLOTS)


# ---- the location registry -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlacedZone:
    """A zone with its floor and building (one row of `LocationRepository.zones`)."""

    zone: Zone
    floor: Floor
    building: Building

    @property
    def active(self) -> bool:
        return self.zone.is_active and self.floor.is_active and self.building.is_active


class LocationRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def buildings(self, company_id: UUID) -> list[Building]:
        return list(
            self.db.scalars(
                select(Building)
                .where(Building.company_id == company_id)
                .order_by(func.lower(Building.name), Building.id)
            )
        )

    def floors(self, company_id: UUID) -> list[Floor]:
        return list(
            self.db.scalars(
                select(Floor).where(Floor.company_id == company_id).order_by(Floor.level, Floor.id)
            )
        )

    def zones_of_company(self, company_id: UUID) -> list[Zone]:
        return list(
            self.db.scalars(
                select(Zone).where(Zone.company_id == company_id).order_by(func.lower(Zone.name), Zone.id)
            )
        )

    def building(
        self, company_id: UUID, building_id: UUID, *, lock: RowLock | None = None
    ) -> Building | None:
        statement = select(Building).where(Building.company_id == company_id, Building.id == building_id)
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def floor(self, company_id: UUID, floor_id: UUID, *, lock: RowLock | None = None) -> Floor | None:
        statement = select(Floor).where(Floor.company_id == company_id, Floor.id == floor_id)
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def zone(self, company_id: UUID, zone_id: UUID, *, lock: RowLock | None = None) -> Zone | None:
        statement = select(Zone).where(Zone.company_id == company_id, Zone.id == zone_id)
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def placed(self, company_id: UUID, zone_ids: Collection[UUID]) -> dict[UUID, PlacedZone]:
        """Each of `zone_ids` (of the company) with its floor and building."""
        if not zone_ids:
            return {}
        rows = self.db.execute(
            select(Zone, Floor, Building)
            .join(Floor, and_(Floor.company_id == Zone.company_id, Floor.id == Zone.floor_id))
            .join(Building, and_(Building.company_id == Floor.company_id, Building.id == Floor.building_id))
            .where(Zone.company_id == company_id, Zone.id.in_(list(zone_ids)))
        ).all()
        return {zone.id: PlacedZone(zone, floor, building) for zone, floor, building in rows}

    def building_by_name(self, company_id: UUID, name: str) -> Building | None:
        return self.db.scalars(
            select(Building).where(
                Building.company_id == company_id, func.lower(Building.name) == name.lower()
            )
        ).first()

    def floor_by_level(self, company_id: UUID, building_id: UUID, level: int) -> Floor | None:
        return self.db.scalars(
            select(Floor).where(
                Floor.company_id == company_id, Floor.building_id == building_id, Floor.level == level
            )
        ).first()

    def zone_by_name(self, company_id: UUID, floor_id: UUID, name: str) -> Zone | None:
        return self.db.scalars(
            select(Zone).where(
                Zone.company_id == company_id,
                Zone.floor_id == floor_id,
                func.lower(Zone.name) == name.lower(),
            )
        ).first()

    def active_floors_of(self, company_id: UUID, building_id: UUID) -> int:
        return (
            self.db.scalar(
                select(func.count()).where(
                    Floor.company_id == company_id,
                    Floor.building_id == building_id,
                    Floor.is_active.is_(True),
                )
            )
            or 0
        )

    def active_zones_of(self, company_id: UUID, floor_id: UUID) -> int:
        return (
            self.db.scalar(
                select(func.count()).where(
                    Zone.company_id == company_id, Zone.floor_id == floor_id, Zone.is_active.is_(True)
                )
            )
            or 0
        )

    def active_cameras_in(self, company_id: UUID, zone_id: UUID) -> int:
        return (
            self.db.scalar(
                select(func.count()).where(
                    TrackingCamera.company_id == company_id,
                    TrackingCamera.zone_id == zone_id,
                    TrackingCamera.is_active.is_(True),
                )
            )
            or 0
        )


# ---- cameras ---------------------------------------------------------------------------------------


class CameraRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, company_id: UUID, camera_id: UUID, *, lock: RowLock | None = None) -> TrackingCamera | None:
        statement = select(TrackingCamera).where(
            TrackingCamera.company_id == company_id, TrackingCamera.id == camera_id
        )
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def by_provider_id(self, company_id: UUID, provider_camera_id: str) -> TrackingCamera | None:
        return self.db.scalars(
            select(TrackingCamera).where(
                TrackingCamera.company_id == company_id,
                TrackingCamera.provider_camera_id == provider_camera_id,
            )
        ).one_or_none()

    def active_by_provider_ids(
        self, company_id: UUID, provider_ids: Collection[str]
    ) -> dict[str, TrackingCamera]:
        """The company's active cameras among `provider_ids`, by provider camera ID."""
        if not provider_ids:
            return {}
        cameras = self.db.scalars(
            select(TrackingCamera).where(
                TrackingCamera.company_id == company_id,
                TrackingCamera.provider_camera_id.in_(list(provider_ids)),
                TrackingCamera.is_active.is_(True),
            )
        )
        return {camera.provider_camera_id: camera for camera in cameras}

    def in_company(
        self, company_id: UUID, *, include_archived: bool, enrollment_points_only: bool
    ) -> list[TrackingCamera]:
        statement = select(TrackingCamera).where(TrackingCamera.company_id == company_id)
        if not include_archived:
            statement = statement.where(TrackingCamera.is_active.is_(True))
        if enrollment_points_only:
            statement = statement.where(TrackingCamera.is_enrollment_point.is_(True))
        return list(self.db.scalars(statement.order_by(func.lower(TrackingCamera.name), TrackingCamera.id)))

    def names(self, company_id: UUID, camera_ids: Collection[UUID]) -> dict[UUID, str]:
        if not camera_ids:
            return {}
        rows = self.db.execute(
            select(TrackingCamera.id, TrackingCamera.name).where(
                TrackingCamera.company_id == company_id, TrackingCamera.id.in_(list(camera_ids))
            )
        )
        return {row.id: row.name for row in rows}


# ---- settings and health -------------------------------------------------------------------------


class TrackingSettingsRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, company_id: UUID) -> CompanyTrackingSettings | None:
        """The company's settings row, or None while it has the defaults (no row is written by a read)."""
        return self.db.get(CompanyTrackingSettings, company_id)

    def allowed_of(self, company_ids: Collection[UUID]) -> dict[UUID, bool]:
        if not company_ids:
            return {}
        rows = self.db.execute(
            select(CompanyTrackingSettings.company_id, CompanyTrackingSettings.allowed).where(
                CompanyTrackingSettings.company_id.in_(list(company_ids))
            )
        )
        found = {row.company_id: row.allowed for row in rows}
        return {company_id: found.get(company_id, False) for company_id in company_ids}

    def lock(self, company_id: UUID, *, now: datetime) -> CompanyTrackingSettings:
        """The company's settings row `FOR UPDATE`, created with the defaults if it does not exist yet.
        Call with the company row locked `FOR UPDATE` (the first lock of every settings change)."""
        self.db.execute(
            insert(CompanyTrackingSettings)
            .values(company_id=company_id, created_at=now, updated_at=now)
            .on_conflict_do_nothing(index_elements=[CompanyTrackingSettings.company_id])
        )
        statement = select(CompanyTrackingSettings).where(CompanyTrackingSettings.company_id == company_id)
        return self.db.scalars(with_lock(statement, RowLock.UPDATE)).one()


@dataclass(frozen=True, slots=True)
class HealthCounts:
    by_reason: dict[str, int]


class TrackingHealthRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, company_id: UUID) -> TrackingHealth | None:
        return self.db.get(TrackingHealth, company_id)

    def record(self, company_id: UUID, *, contact_at: datetime | None, accepted_at: datetime | None) -> None:
        """The provider's contact and the last accepted event, never moved back in time."""
        if contact_at is None and accepted_at is None:
            return
        statement = insert(TrackingHealth).values(
            company_id=company_id, last_contact_at=contact_at, last_accepted_event_at=accepted_at
        )
        excluded = statement.excluded
        self.db.execute(
            statement.on_conflict_do_update(
                index_elements=[TrackingHealth.company_id],
                set_={
                    "last_contact_at": func.greatest(
                        TrackingHealth.last_contact_at, excluded.last_contact_at
                    ),
                    "last_accepted_event_at": func.greatest(
                        TrackingHealth.last_accepted_event_at, excluded.last_accepted_event_at
                    ),
                },
            )
        )

    def count(self, company_id: UUID, counts: dict[str, int], *, now: datetime) -> None:
        """Add `counts` (reason -> how many) to the current hour's slot of the ring (B15-11). A slot last
        used 24 hours ago or more starts again from this count. Reasons in sorted order, so two writers
        never wait for each other's rows the other way round."""
        hour = int(now.timestamp() // 3600)
        hour_start = datetime.fromtimestamp(hour * 3600, tz=now.tzinfo)
        for reason in sorted(counts):
            statement = insert(TrackingHealthCount).values(
                company_id=company_id,
                reason=reason,
                slot=hour % HEALTH_SLOTS,
                hour_start=hour_start,
                count=counts[reason],
            )
            excluded = statement.excluded
            self.db.execute(
                statement.on_conflict_do_update(
                    index_elements=[
                        TrackingHealthCount.company_id,
                        TrackingHealthCount.reason,
                        TrackingHealthCount.slot,
                    ],
                    set_={
                        # The same hour: add to it; an older hour in this slot: start again.
                        "count": case(
                            (
                                TrackingHealthCount.hour_start == excluded.hour_start,
                                TrackingHealthCount.count + excluded.count,
                            ),
                            else_=excluded.count,
                        ),
                        "hour_start": excluded.hour_start,
                    },
                )
            )

    def counts_since(self, company_id: UUID, *, now: datetime) -> dict[str, int]:
        """Counts by reason over the last 24 hours (the current hour included)."""
        rows = self.db.execute(
            select(TrackingHealthCount.reason, func.sum(TrackingHealthCount.count).label("total"))
            .where(
                TrackingHealthCount.company_id == company_id,
                TrackingHealthCount.hour_start > now - HEALTH_WINDOW,
            )
            .group_by(TrackingHealthCount.reason)
        )
        return {row.reason: int(row.total) for row in rows}


# ---- keys ----------------------------------------------------------------------------------------


class TrackingKeyRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def in_company(self, company_id: UUID) -> list[TrackingKey]:
        return list(
            self.db.scalars(
                select(TrackingKey)
                .where(TrackingKey.company_id == company_id)
                .order_by(TrackingKey.created_at.desc(), TrackingKey.id)
            )
        )

    def get(self, company_id: UUID, key_id: UUID, *, lock: RowLock | None = None) -> TrackingKey | None:
        statement = select(TrackingKey).where(TrackingKey.company_id == company_id, TrackingKey.id == key_id)
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def by_digest(self, digest: str) -> TrackingKey | None:
        return self.db.scalars(select(TrackingKey).where(TrackingKey.key_hash == digest)).one_or_none()

    def live_slots(self, company_id: UUID) -> set[int]:
        return set(
            self.db.scalars(
                select(TrackingKey.slot).where(
                    TrackingKey.company_id == company_id, TrackingKey.revoked_at.is_(None)
                )
            )
        )

    def touch(self, company_id: UUID, key_id: UUID, *, now: datetime) -> None:
        self.db.execute(
            update(TrackingKey)
            .where(TrackingKey.company_id == company_id, TrackingKey.id == key_id)
            .values(last_used_at=now)
        )


# ---- associations and events ---------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SightingRow:
    id: UUID
    type: str
    observed_at: datetime
    floor_id: UUID | None
    zone_id: UUID | None
    match: str | None
    confidence: float | None


@dataclass(frozen=True, slots=True)
class AssociationSummary:
    """What the journey state of a visit needs about its latest association (`journey_summaries`)."""

    association: TrackingAssociation
    latest_sighting: SightingRow | None
    latest_confirmed: SightingRow | None
    conflict: bool


class AssociationRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def open_for_visit(
        self, company_id: UUID, visit_id: UUID, *, lock: RowLock | None = None
    ) -> TrackingAssociation | None:
        statement = select(TrackingAssociation).where(
            TrackingAssociation.company_id == company_id,
            TrackingAssociation.visit_id == visit_id,
            TrackingAssociation.status.in_(OPEN),
        )
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def latest_for_visits(
        self, company_id: UUID, visit_ids: Collection[UUID]
    ) -> dict[UUID, TrackingAssociation]:
        if not visit_ids:
            return {}
        statement = (
            select(TrackingAssociation)
            .where(
                TrackingAssociation.company_id == company_id,
                TrackingAssociation.visit_id.in_(list(visit_ids)),
            )
            .order_by(
                TrackingAssociation.visit_id,
                TrackingAssociation.created_at.desc(),
                TrackingAssociation.id.desc(),
            )
            .ext(distinct_on(TrackingAssociation.visit_id))
        )
        return {association.visit_id: association for association in self.db.scalars(statement)}

    def lock_by_refs(self, company_id: UUID, refs: Collection[str]) -> dict[str, TrackingAssociation]:
        """The company's associations among `refs`, locked `FOR UPDATE` in ID order."""
        if not refs:
            return {}
        statement = (
            select(TrackingAssociation)
            .where(TrackingAssociation.company_id == company_id, TrackingAssociation.ref.in_(list(refs)))
            .order_by(TrackingAssociation.id)
        )
        return {
            association.ref: association
            for association in self.db.scalars(with_lock(statement, RowLock.UPDATE))
        }

    def lock_open_of_company(self, company_id: UUID) -> list[TrackingAssociation]:
        statement = (
            select(TrackingAssociation)
            .where(TrackingAssociation.company_id == company_id, TrackingAssociation.status.in_(OPEN))
            .order_by(TrackingAssociation.id)
        )
        return list(self.db.scalars(with_lock(statement, RowLock.UPDATE)))

    def lock_expired(self, company_id: UUID, *, now: datetime) -> list[TrackingAssociation]:
        """The company's open associations whose expiry has passed, locked in ID order. A row another
        transaction ended meanwhile no longer matches once its lock is granted, and is skipped."""
        statement = (
            select(TrackingAssociation)
            .where(
                TrackingAssociation.company_id == company_id,
                TrackingAssociation.status.in_(OPEN),
                TrackingAssociation.expires_at <= now,
            )
            .order_by(TrackingAssociation.id)
        )
        return list(self.db.scalars(with_lock(statement, RowLock.UPDATE)))

    def has_expired(self, company_id: UUID, *, now: datetime) -> bool:
        return bool(
            self.db.scalar(
                select(
                    select(TrackingAssociation.id)
                    .where(
                        TrackingAssociation.company_id == company_id,
                        TrackingAssociation.status.in_(OPEN),
                        TrackingAssociation.expires_at <= now,
                    )
                    .exists()
                )
            )
        )

    def summaries(
        self,
        company_id: UUID,
        associations: Sequence[TrackingAssociation],
        *,
        threshold: float | None,
        conflict_window: timedelta,
    ) -> dict[UUID, AssociationSummary]:
        """For each association: its latest sighting (OBSERVED or LOST), its latest confirmed observation
        (none with a null threshold) and whether a confirmed observation within `conflict_window` of that one
        names another floor. "Latest" orders by observed_at, then received_at, then ID. One query; each
        part reads the visit's events backwards on `ix_journey_events_visit_observed`."""
        if not associations:
            return {}
        a = aliased(TrackingAssociation)
        sighting = _latest_event(a, VisitorJourneyEvent.type.in_(SIGHTINGS), "sighting")
        columns: list[Any] = [a.id, *_sighting_columns(sighting, "s_")]
        statement: Select[*tuple[Any, ...]] = select(*columns).select_from(a).outerjoin(sighting, true())
        if threshold is not None:
            confirmed = _latest_event(a, _confirmed(VisitorJourneyEvent, threshold), "confirmed")
            other = aliased(VisitorJourneyEvent)
            conflict = (
                select(other.id)
                .where(
                    other.company_id == a.company_id,
                    other.visit_id == a.visit_id,
                    other.association_id == a.id,
                    _confirmed(other, threshold),
                    other.observed_at >= confirmed.c.observed_at - conflict_window,
                    other.floor_id != confirmed.c.floor_id,
                )
                .exists()
            )
            statement = statement.add_columns(*_sighting_columns(confirmed, "c_"), conflict.label("conflict"))
            statement = statement.outerjoin(confirmed, true())
        statement = statement.where(a.company_id == company_id, a.id.in_([item.id for item in associations]))
        by_id = {item.id: item for item in associations}
        summaries: dict[UUID, AssociationSummary] = {}
        for row in self.db.execute(statement).mappings():
            confirmed_row = _sighting(row, "c_") if threshold is not None else None
            summaries[row["id"]] = AssociationSummary(
                association=by_id[row["id"]],
                latest_sighting=_sighting(row, "s_"),
                latest_confirmed=confirmed_row,
                conflict=bool(row.get("conflict")) if confirmed_row is not None else False,
            )
        return summaries


def _confirmed(event: Any, threshold: float) -> ColumnElement[bool]:
    """An observation the application counts as confirmed (`tracking_rules.is_confirmed`), of `event`
    (the events table or an alias of it)."""
    return and_(
        event.type == JourneyEventType.OBSERVED.value,
        event.match == ObservationMatch.CONFIRMED.value,
        event.confidence.is_not(None),
        event.confidence >= threshold,
    )


def _latest_event(association: Any, condition: ColumnElement[bool], name: str) -> LateralFromClause:
    """The latest event of `association` that meets `condition`, as a LATERAL subquery `name`."""
    e = VisitorJourneyEvent
    return (
        select(e.id, e.type, e.observed_at, e.floor_id, e.zone_id, e.match, e.confidence)
        .where(
            e.company_id == association.company_id,
            e.visit_id == association.visit_id,
            e.association_id == association.id,
            condition,
        )
        .order_by(e.observed_at.desc(), e.received_at.desc(), e.id.desc())
        .limit(1)
        .lateral(name)
    )


_SIGHTING_FIELDS = ("id", "type", "observed_at", "floor_id", "zone_id", "match", "confidence")


def _sighting_columns(subquery: Any, prefix: str) -> list[Any]:
    return [subquery.c[name].label(prefix + name) for name in _SIGHTING_FIELDS]


def _sighting(row: RowMapping, prefix: str) -> SightingRow | None:
    if row[prefix + "id"] is None:
        return None
    return SightingRow(**{name: row[prefix + name] for name in _SIGHTING_FIELDS})


class JourneyEventRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def known_ids(self, company_id: UUID, provider: str, event_ids: Collection[str]) -> set[str]:
        if not event_ids:
            return set()
        return set(
            self.db.scalars(
                select(VisitorJourneyEvent.provider_event_id).where(
                    VisitorJourneyEvent.company_id == company_id,
                    VisitorJourneyEvent.provider == provider,
                    VisitorJourneyEvent.provider_event_id.in_(list(event_ids)),
                )
            )
        )

    def add(self, values: dict[str, object]) -> bool:
        """Append one event; False when its (company, provider, provider event ID) is already stored (a
        retried batch, or the same event in two batches at once)."""
        inserted = self.db.execute(
            insert(VisitorJourneyEvent)
            .values(**values)
            .on_conflict_do_nothing(constraint="uq_journey_events_provider_event")
            .returning(VisitorJourneyEvent.id)
        ).scalar_one_or_none()
        return inserted is not None

    def timeline(self, company_id: UUID, visit_id: UUID, *, limit: int) -> list[VisitorJourneyEvent]:
        """The visit's most recent `limit` events, oldest first: of associations the provider activated only
        (B15-28; ingestion stores nothing else, this keeps it so for rows written before that rule)."""
        newest = list(
            self.db.scalars(
                select(VisitorJourneyEvent)
                .where(
                    VisitorJourneyEvent.company_id == company_id,
                    VisitorJourneyEvent.visit_id == visit_id,
                    _of_an_activated_association(),
                )
                .order_by(
                    VisitorJourneyEvent.observed_at.desc(),
                    VisitorJourneyEvent.received_at.desc(),
                    VisitorJourneyEvent.id.desc(),
                )
                .limit(limit)
            )
        )
        return newest[::-1]

    def count_for_visit(self, company_id: UUID, visit_id: UUID) -> int:
        return (
            self.db.scalar(
                select(func.count()).where(
                    VisitorJourneyEvent.company_id == company_id,
                    VisitorJourneyEvent.visit_id == visit_id,
                    _of_an_activated_association(),
                )
            )
            or 0
        )


def _of_an_activated_association() -> ColumnElement[bool]:
    """The event belongs to an association the provider activated (B15-28)."""
    return (
        select(TrackingAssociation.id)
        .where(
            TrackingAssociation.company_id == VisitorJourneyEvent.company_id,
            TrackingAssociation.id == VisitorJourneyEvent.association_id,
            TrackingAssociation.activated_at.is_not(None),
        )
        .exists()
    )


def present_during(start: datetime, end: datetime) -> ColumnElement[bool]:
    """A visit was inside at some time in `[start, end)`: checked in before `end` and not checked out
    before `start` (a visit still inside has no check-out)."""
    return and_(
        Visit.check_in_at.is_not(None),
        Visit.check_in_at < end,
        or_(Visit.check_out_at.is_(None), Visit.check_out_at >= start),
    )
