"""The location registry: buildings, floors and zones (Phase 15, /api/v1/locations, B15-5).

* Read by every role that sees journeys (the tree, active and archived); changed by administrators.
  Since Phase 16 (B16-19) every role of the company reads it: an invitation form offers the allowed
  areas. A caller who does not see journeys (a host who is only an employee) reads the active buildings,
  floors and zones only; nobody but administrators and receptionists ever reads a camera.
* A zone has an access level (Phase 16, B16-1): COMMON, STANDARD (the default) or RESTRICTED.
* Editable whatever the tracking provider is, so a company can prepare its buildings before tracking is
  switched on.
* Nothing is deleted: the runtime database role cannot delete rows (revision 0006), and cameras, journey
  events and their history refer to these rows. Archiving (`is_active: false`) is refused while the row
  holds active children (floors, zones, cameras: 409 LOCATION_IN_USE); a child cannot be created in, or
  restored under, an archived parent (422 `location_archived`).
* Names are unique per parent, ignoring case: a building's in the company, a zone's on its floor
  (409 CONFLICT `name`); a floor's level is unique in its building (409 CONFLICT `level`).

A change starts with the company row `FOR UPDATE` (so two changes of one company's registry run one
after the other and the uniqueness checks see each other), then the caller is re-checked (SEC-07).
"""

from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import Conflict, LocationInUse
from app.core.field_errors import FieldCode, FieldProblem
from app.core.request_context import RequestContext
from app.db.base import Base
from app.db.errors import unique_violation_constraint
from app.models import Building, Floor, Zone
from app.repositories.locking import RowLock
from app.repositories.tracking import LocationRepository
from app.schemas.locations import Building as BuildingOut
from app.schemas.locations import (
    BuildingCreate,
    BuildingNode,
    BuildingUpdate,
    FloorCreate,
    FloorNode,
    FloorUpdate,
    LocationTree,
    ZoneCreate,
    ZoneUpdate,
)
from app.schemas.locations import Floor as FloorOut
from app.schemas.locations import Zone as ZoneOut
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change
from app.services.scoping import REFERENCE_NOT_FOUND, FieldErrors, require_found

BUILDING_NAME_TAKEN = "A building with this name already exists."
LEVEL_TAKEN = "This building already has a floor at this level."
ZONE_NAME_TAKEN = "This floor already has a zone with this name."
LOCATION_ARCHIVED = FieldProblem(FieldCode.LOCATION_ARCHIVED, "This location is archived.")
# The unique index behind each conflict -> (field, message).
_CONFLICTS = {
    "uq_buildings_company_name": ("name", BUILDING_NAME_TAKEN),
    "uq_floors_building_id_level": ("level", LEVEL_TAKEN),
    "uq_zones_floor_name": ("name", ZONE_NAME_TAKEN),
}


class LocationsService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.locations = LocationRepository(db)

    # ---- the tree ---------------------------------------------------------------------------------

    def tree(self, auth: AuthContext) -> LocationTree:
        """The company's buildings, floors and zones; the active ones only for a caller who does not see
        journeys (B16-19). Archiving keeps a child under an active parent, so an active zone's floor and
        building are active too."""
        company_id = auth.company_id
        active_only = not has_capability(auth.roles, Capability.VIEW_JOURNEYS)
        zones_by_floor: dict[UUID, list[ZoneOut]] = {}
        for zone in self.locations.zones_of_company(company_id):
            if zone.is_active or not active_only:
                zones_by_floor.setdefault(zone.floor_id, []).append(ZoneOut.model_validate(zone))
        floors_by_building: dict[UUID, list[FloorNode]] = {}
        for floor in self.locations.floors(company_id):
            if not floor.is_active and active_only:
                continue
            node = FloorNode(
                **FloorOut.model_validate(floor).model_dump(), zones=zones_by_floor.get(floor.id, [])
            )
            floors_by_building.setdefault(floor.building_id, []).append(node)
        return LocationTree(
            buildings=[
                BuildingNode(
                    **BuildingOut.model_validate(building).model_dump(),
                    floors=floors_by_building.get(building.id, []),
                )
                for building in self.locations.buildings(company_id)
                if building.is_active or not active_only
            ]
        )

    # ---- buildings --------------------------------------------------------------------------------

    def create_building(
        self, auth: AuthContext, data: BuildingCreate, context: RequestContext
    ) -> BuildingOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        if self.locations.building_by_name(auth.company_id, data.name) is not None:
            raise Conflict("name", BUILDING_NAME_TAKEN)
        now = app_time.now()
        building = Building(
            company_id=auth.company_id,
            name=data.name,
            name_ar=data.name_ar,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        self._save(building)
        self._audit(auth, AuditAction.LOCATION_CREATED, AuditEntity.BUILDING, building.id, context, {})
        self.db.commit()
        return BuildingOut.model_validate(building)

    def update_building(
        self, auth: AuthContext, building_id: UUID, data: BuildingUpdate, context: RequestContext
    ) -> BuildingOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        building = require_found(self.locations.building(auth.company_id, building_id, lock=RowLock.UPDATE))
        if data.name is not None and data.name.lower() != building.name.lower():
            existing = self.locations.building_by_name(auth.company_id, data.name)
            if existing is not None and existing.id != building.id:
                raise Conflict("name", BUILDING_NAME_TAKEN)
        if (
            data.is_active is False
            and building.is_active
            and self.locations.active_floors_of(auth.company_id, building.id)
        ):
            raise LocationInUse()
        return self._apply(auth, building, data, AuditEntity.BUILDING, context, BuildingOut.model_validate)

    # ---- floors -----------------------------------------------------------------------------------

    def create_floor(self, auth: AuthContext, data: FloorCreate, context: RequestContext) -> FloorOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        building = self.locations.building(auth.company_id, data.building_id, lock=RowLock.KEY_SHARE)
        self._require_active_parent(building, "building_id")
        if self.locations.floor_by_level(auth.company_id, data.building_id, data.level) is not None:
            raise Conflict("level", LEVEL_TAKEN)
        now = app_time.now()
        floor = Floor(
            company_id=auth.company_id,
            building_id=data.building_id,
            name=data.name,
            name_ar=data.name_ar,
            level=data.level,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        self._save(floor)
        self._audit(auth, AuditAction.LOCATION_CREATED, AuditEntity.FLOOR, floor.id, context, {})
        self.db.commit()
        return FloorOut.model_validate(floor)

    def update_floor(
        self, auth: AuthContext, floor_id: UUID, data: FloorUpdate, context: RequestContext
    ) -> FloorOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        floor = require_found(self.locations.floor(auth.company_id, floor_id, lock=RowLock.UPDATE))
        if data.level is not None and data.level != floor.level:
            existing = self.locations.floor_by_level(auth.company_id, floor.building_id, data.level)
            if existing is not None and existing.id != floor.id:
                raise Conflict("level", LEVEL_TAKEN)
        if data.is_active is True and not floor.is_active:
            self._require_active_parent(
                self.locations.building(auth.company_id, floor.building_id), "is_active"
            )
        if (
            data.is_active is False
            and floor.is_active
            and self.locations.active_zones_of(auth.company_id, floor.id)
        ):
            raise LocationInUse()
        return self._apply(auth, floor, data, AuditEntity.FLOOR, context, FloorOut.model_validate)

    # ---- zones ------------------------------------------------------------------------------------

    def create_zone(self, auth: AuthContext, data: ZoneCreate, context: RequestContext) -> ZoneOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        floor = self.locations.floor(auth.company_id, data.floor_id, lock=RowLock.KEY_SHARE)
        self._require_active_parent(floor, "floor_id")
        if self.locations.zone_by_name(auth.company_id, data.floor_id, data.name) is not None:
            raise Conflict("name", ZONE_NAME_TAKEN)
        now = app_time.now()
        zone = Zone(
            company_id=auth.company_id,
            floor_id=data.floor_id,
            name=data.name,
            name_ar=data.name_ar,
            access=data.access.value,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        self._save(zone)
        self._audit(auth, AuditAction.LOCATION_CREATED, AuditEntity.ZONE, zone.id, context, {})
        self.db.commit()
        return ZoneOut.model_validate(zone)

    def update_zone(
        self, auth: AuthContext, zone_id: UUID, data: ZoneUpdate, context: RequestContext
    ) -> ZoneOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        zone = require_found(self.locations.zone(auth.company_id, zone_id, lock=RowLock.UPDATE))
        if data.name is not None and data.name.lower() != zone.name.lower():
            existing = self.locations.zone_by_name(auth.company_id, zone.floor_id, data.name)
            if existing is not None and existing.id != zone.id:
                raise Conflict("name", ZONE_NAME_TAKEN)
        if data.is_active is True and not zone.is_active:
            self._require_active_parent(self.locations.floor(auth.company_id, zone.floor_id), "is_active")
        if (
            data.is_active is False
            and zone.is_active
            and self.locations.active_cameras_in(auth.company_id, zone.id)
        ):
            raise LocationInUse()
        return self._apply(auth, zone, data, AuditEntity.ZONE, context, ZoneOut.model_validate)

    # ---- helpers ----------------------------------------------------------------------------------

    @staticmethod
    def _require_active_parent(parent: Building | Floor | None, field: str) -> None:
        """A child is created in, or restored under, an active parent only. Archiving is refused while a
        row has active children, so an active zone always stands on an active floor in an active
        building, and an active camera in an active zone."""
        errors = FieldErrors()
        if parent is None:
            errors.add(field, REFERENCE_NOT_FOUND)
        elif not parent.is_active:
            errors.add(field, LOCATION_ARCHIVED)
        errors.raise_if_any()

    def _apply[T](
        self,
        auth: AuthContext,
        row: Building | Floor | Zone,
        data: BuildingUpdate | FloorUpdate | ZoneUpdate,
        entity: AuditEntity,
        context: RequestContext,
        view: Callable[[Any], T],
    ) -> T:
        supplied = data.model_fields_set
        changed: list[str] = []
        for name in ("name", "name_ar", "level", "access", "is_active"):
            if name not in supplied or not hasattr(data, name):
                continue
            value = getattr(data, name)
            if name != "name_ar" and value is None:
                continue
            if value != getattr(row, name):
                setattr(row, name, value)
                changed.append(name)
        if not changed:
            return view(row)
        row.updated_at = app_time.now()
        self._save(row)
        self._audit(auth, AuditAction.LOCATION_UPDATED, entity, row.id, context, {"changed_fields": changed})
        self.db.commit()
        return view(row)

    def _save(self, row: Base) -> None:
        try:
            with self.db.begin_nested():
                self.db.add(row)
                self.db.flush()
        except IntegrityError as exc:
            conflict = _CONFLICTS.get(unique_violation_constraint(exc) or "")
            if conflict is not None:
                raise Conflict(*conflict) from None
            raise

    def _audit(
        self,
        auth: AuthContext,
        action: AuditAction,
        entity: AuditEntity,
        entity_id: UUID,
        context: RequestContext,
        metadata: Mapping[str, object],
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=entity,
            entity_id=entity_id,
            metadata=metadata,
        )
