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

Phase 16 (B16-7) adds the alerts: **a visit before its association, and its alert after it**. An
ingested batch takes the company row, the key, then **the visits its refs name `FOR KEY SHARE` (ID
order)**, then its associations (ID order), its contact's health row, then the alerts of those visits; a
check-out and a change of a visit's allowed areas take the company row, the visit `FOR UPDATE`, its
association, then its alert; a receptionist's acknowledge or resolve holds only the company row
(`FOR KEY SHARE`) and the alert. The batch must hold its visits first because an alert's e-mail row refers
to the visit (its foreign key takes `FOR KEY SHARE` on it): taken only then, after the association, a
check-out holding the visit and waiting for the association would deadlock with it. Only the holder of
an association's lock opens or moves its visit's alert, so a batch waiting for an alert while it holds the
health row waits for nobody who needs that row. The alert itself refers to its association, not to the
visit row.
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
    TrackingAlert,
    TrackingAssociation,
    TrackingCamera,
    TrackingHealth,
    TrackingHealthCount,
    TrackingKey,
    Visit,
    VisitAccessArea,
    VisitorJourneyEvent,
    Zone,
)
from app.models.enums import (
    JourneyEventType,
    ObservationMatch,
    TrackingAlertStatus,
    TrackingAssociationStatus,
)
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


@dataclass(frozen=True, slots=True)
class PlacedFloor:
    """A floor with its building (one row of `LocationRepository.placed_floors`)."""

    floor: Floor
    building: Building

    @property
    def active(self) -> bool:
        return self.floor.is_active and self.building.is_active


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

    def placed_floors(self, company_id: UUID, floor_ids: Collection[UUID]) -> dict[UUID, PlacedFloor]:
        """Each of `floor_ids` (of the company) with its building."""
        if not floor_ids:
            return {}
        rows = self.db.execute(
            select(Floor, Building)
            .join(Building, and_(Building.company_id == Floor.company_id, Building.id == Floor.building_id))
            .where(Floor.company_id == company_id, Floor.id.in_(list(floor_ids)))
        ).all()
        return {floor.id: PlacedFloor(floor, building) for floor, building in rows}

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

    def hold_visits_of_refs(self, company_id: UUID, refs: Collection[str]) -> None:
        """The visits of the company's associations among `refs`, `FOR KEY SHARE` in ID order, before their
        associations (Phase 16, B16-7): an alert's e-mail row refers to its visit, and a check-out holds the
        visit `FOR UPDATE` before it waits for the association. Held so, a check-out and a batch meet at the
        visit, in the same order."""
        if not refs:
            return
        visits_of_refs = select(TrackingAssociation.visit_id).where(
            TrackingAssociation.company_id == company_id, TrackingAssociation.ref.in_(list(refs))
        )
        statement = (
            select(Visit.id)
            .where(Visit.company_id == company_id, Visit.id.in_(visits_of_refs))
            .order_by(Visit.id)
            .with_for_update(read=True, key_share=True)
        )
        self.db.execute(statement).all()

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

    def add(self, values: dict[str, object]) -> UUID | None:
        """Append one event; its ID, or None when its (company, provider, provider event ID) is already
        stored (a retried batch, or the same event in two batches at once)."""
        return self.db.execute(
            insert(VisitorJourneyEvent)
            .values(**values)
            .on_conflict_do_nothing(constraint="uq_journey_events_provider_event")
            .returning(VisitorJourneyEvent.id)
        ).scalar_one_or_none()

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


# ---- allowed areas (Phase 16, B16-2) ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class LiveAreas:
    """A visit's live allowed areas, as IDs."""

    floor_ids: frozenset[UUID]
    zone_ids: frozenset[UUID]


NO_AREAS = LiveAreas(frozenset(), frozenset())


class AccessAreaRepository:
    """`visit_access_areas`: a visit's allowed floors and extra zones. The runtime role cannot delete, so an
    area taken away keeps its row with `removed_at` (B16-2); only rows without one are live."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def live(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, LiveAreas]:
        """Each visit's live areas (a visit without any is not in the answer)."""
        if not visit_ids:
            return {}
        rows = self.db.execute(
            select(VisitAccessArea.visit_id, VisitAccessArea.floor_id, VisitAccessArea.zone_id).where(
                VisitAccessArea.company_id == company_id,
                VisitAccessArea.visit_id.in_(list(visit_ids)),
                VisitAccessArea.removed_at.is_(None),
            )
        ).all()
        floors: dict[UUID, set[UUID]] = {}
        zones: dict[UUID, set[UUID]] = {}
        for visit_id, floor_id, zone_id in rows:
            if floor_id is not None:
                floors.setdefault(visit_id, set()).add(floor_id)
            if zone_id is not None:
                zones.setdefault(visit_id, set()).add(zone_id)
        return {
            visit_id: LiveAreas(frozenset(floors.get(visit_id, ())), frozenset(zones.get(visit_id, ())))
            for visit_id in floors.keys() | zones.keys()
        }

    def replace(
        self,
        company_id: UUID,
        visit_id: UUID,
        *,
        current: LiveAreas,
        floor_ids: Collection[UUID],
        zone_ids: Collection[UUID],
        now: datetime,
    ) -> None:
        """Make `floor_ids` and `zone_ids` the visit's live areas: the others get `removed_at`, the new ones a
        row. The caller holds the visit's row lock."""
        removed_floors = current.floor_ids - set(floor_ids)
        removed_zones = current.zone_ids - set(zone_ids)
        if removed_floors or removed_zones:
            self.db.execute(
                update(VisitAccessArea)
                .where(
                    VisitAccessArea.company_id == company_id,
                    VisitAccessArea.visit_id == visit_id,
                    VisitAccessArea.removed_at.is_(None),
                    or_(
                        VisitAccessArea.floor_id.in_(list(removed_floors)),
                        VisitAccessArea.zone_id.in_(list(removed_zones)),
                    ),
                )
                .values(removed_at=now)
            )
        for floor_id in sorted(set(floor_ids) - current.floor_ids):
            self.db.add(
                VisitAccessArea(company_id=company_id, visit_id=visit_id, floor_id=floor_id, created_at=now)
            )
        for zone_id in sorted(set(zone_ids) - current.zone_ids):
            self.db.add(
                VisitAccessArea(company_id=company_id, visit_id=visit_id, zone_id=zone_id, created_at=now)
            )
        self.db.flush()


# ---- area alerts (Phase 16, B16-5 to B16-12) -----------------------------------------------------------

ACTIVE_ALERT_STATUSES = (TrackingAlertStatus.OPEN.value, TrackingAlertStatus.ACKNOWLEDGED.value)


@dataclass(frozen=True, slots=True)
class AlertCounts:
    open: int
    active: int


class TrackingAlertRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, company_id: UUID, alert_id: UUID, *, lock: RowLock | None = None) -> TrackingAlert | None:
        statement = select(TrackingAlert).where(
            TrackingAlert.company_id == company_id, TrackingAlert.id == alert_id
        )
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def active_for_visit(
        self, company_id: UUID, visit_id: UUID, *, lock: RowLock | None = None
    ) -> TrackingAlert | None:
        """The visit's OPEN or ACKNOWLEDGED alert (one at most: `uq_tracking_alerts_active_visit`). Locked,
        a row another transaction resolved meanwhile no longer matches once its lock is granted."""
        statement = select(TrackingAlert).where(
            TrackingAlert.company_id == company_id,
            TrackingAlert.visit_id == visit_id,
            TrackingAlert.status.in_(ACTIVE_ALERT_STATUSES),
        )
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def active_for_visits(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, TrackingAlert]:
        if not visit_ids:
            return {}
        alerts = self.db.scalars(
            select(TrackingAlert).where(
                TrackingAlert.company_id == company_id,
                TrackingAlert.visit_id.in_(list(visit_ids)),
                TrackingAlert.status.in_(ACTIVE_ALERT_STATUSES),
            )
        )
        return {alert.visit_id: alert for alert in alerts}

    def of_visit(self, company_id: UUID, visit_id: UUID, *, limit: int) -> list[TrackingAlert]:
        """The visit's latest alerts, newest `opened_at` first."""
        return list(
            self.db.scalars(
                select(TrackingAlert)
                .where(TrackingAlert.company_id == company_id, TrackingAlert.visit_id == visit_id)
                .order_by(TrackingAlert.opened_at.desc(), TrackingAlert.id.desc())
                .limit(limit)
            )
        )

    def listed(
        self,
        company_id: UUID,
        *,
        active_only: bool,
        opened_from: datetime | None = None,
        opened_before: datetime | None = None,
        visit_id: UUID | None = None,
    ) -> Select[TrackingAlert]:
        """The statement of a list: the active alerts, or those opened in `[opened_from, opened_before)`;
        newest `opened_at` first."""
        statement = select(TrackingAlert).where(TrackingAlert.company_id == company_id)
        if active_only:
            statement = statement.where(TrackingAlert.status.in_(ACTIVE_ALERT_STATUSES))
        if opened_from is not None:
            statement = statement.where(TrackingAlert.opened_at >= opened_from)
        if opened_before is not None:
            statement = statement.where(TrackingAlert.opened_at < opened_before)
        if visit_id is not None:
            statement = statement.where(TrackingAlert.visit_id == visit_id)
        return statement.order_by(TrackingAlert.opened_at.desc(), TrackingAlert.id.desc())

    def counts(self, company_id: UUID) -> AlertCounts:
        rows = self.db.execute(
            select(TrackingAlert.status, func.count().label("total"))
            .where(
                TrackingAlert.company_id == company_id,
                TrackingAlert.status.in_(ACTIVE_ALERT_STATUSES),
            )
            .group_by(TrackingAlert.status)
        ).all()
        by_status = {row.status: int(row.total) for row in rows}
        opened = by_status.get(TrackingAlertStatus.OPEN.value, 0)
        acknowledged = by_status.get(TrackingAlertStatus.ACKNOWLEDGED.value, 0)
        return AlertCounts(open=opened, active=opened + acknowledged)

    def latest_open(self, company_id: UUID, *, limit: int) -> list[TrackingAlert]:
        """The newest OPEN alerts, by when each opened or, once escalated, escalated (B16-26): an escalation
        keeps `opened_at`, and would otherwise stay behind newer alerts and never be named."""
        return list(
            self.db.scalars(
                select(TrackingAlert)
                .where(
                    TrackingAlert.company_id == company_id,
                    TrackingAlert.status == TrackingAlertStatus.OPEN.value,
                )
                .order_by(
                    func.coalesce(TrackingAlert.escalated_at, TrackingAlert.opened_at).desc(),
                    TrackingAlert.id.desc(),
                )
                .limit(limit)
            )
        )
