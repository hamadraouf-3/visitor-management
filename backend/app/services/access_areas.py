"""A visit's allowed areas (Phase 16, docs/visitor-journey-design.md §9, B16-2, B16-3).

* **What they are.** A set of floors and a set of extra zones (any access level, on any floor). Neither:
  "not set", and only RESTRICTED zones alert for the visit (`tracking_rules.violation`).
* **At creation** (an invitation, a walk-in): the request's `access_areas` when it sends them; omitted or
  null, the floor of the visit's department (`departments.floor_id`) when it has one and that floor is
  active; otherwise nothing. An archived department floor is skipped, never refused (B16-3).
* **Changed** by `PUT /visits/{id}/access-areas` (`VisitsService.set_access_areas`).
* **Validated** under the company row's lock, which every change of the location registry holds
  `FOR UPDATE`: an ID that is not a floor (zone) of the company answers 422 `not_found`, an archived one
  (or one in an archived floor or building) `location_archived`, on `floor_ids` / `zone_ids` (prefixed
  `access_areas.` in a visit's creation).
* **Stored** in `visit_access_areas`, one row per area; the runtime role cannot delete, so an area taken
  away keeps its row with `removed_at` (B16-2).
* **Shown** in every `Visit`, `VisitJourney`, `TrackingAlert` and live visitor: floors by building name then
  level, zones by floor level then name, each with `is_active`.
"""

from collections.abc import Collection, Sequence
from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.field_errors import FieldCode, FieldProblem
from app.models import Department, Visit
from app.models.enums import ZoneAccess
from app.repositories.tracking import NO_AREAS, AccessAreaRepository, LiveAreas, LocationRepository
from app.schemas.locations import (
    AccessFloor,
    AccessZone,
    FloorRef,
    LocationRef,
    VisitAccessAreas,
    VisitAccessAreasInput,
)
from app.services.scoping import REFERENCE_NOT_FOUND, FieldErrors
from app.services.tracking_rules import NOT_SET, AccessAreas

LOCATION_ARCHIVED = FieldProblem(FieldCode.LOCATION_ARCHIVED, "This location is archived.")


def no_areas() -> VisitAccessAreas:
    return VisitAccessAreas(floors=[], zones=[])


def _as_rule(areas: LiveAreas) -> AccessAreas:
    return AccessAreas(floor_ids=areas.floor_ids, zone_ids=areas.zone_ids)


class AccessAreaService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repository = AccessAreaRepository(db)
        self.locations = LocationRepository(db)

    # ---- the rule's input ---------------------------------------------------------------------------

    def of_visits(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, AccessAreas]:
        """Each visit's allowed areas, as the violation rule takes them (NOT_SET for a visit without)."""
        live = self.repository.live(company_id, visit_ids)
        return {visit_id: _as_rule(live.get(visit_id, NO_AREAS)) for visit_id in visit_ids}

    def of_visit(self, company_id: UUID, visit_id: UUID) -> AccessAreas:
        return self.of_visits(company_id, [visit_id]).get(visit_id, NOT_SET)

    # ---- a request's areas ----------------------------------------------------------------------------

    def resolve(
        self, company_id: UUID, data: VisitAccessAreasInput, errors: FieldErrors, *, prefix: str = ""
    ) -> AccessAreas:
        """The areas a request names, each an active floor (zone) of the company; problems go to `errors`
        on `{prefix}floor_ids` / `{prefix}zone_ids` (the first per list)."""
        floors = self.locations.placed_floors(company_id, data.floor_ids)
        for floor_id in data.floor_ids:
            floor = floors.get(floor_id)
            if floor is None:
                errors.add(f"{prefix}floor_ids", REFERENCE_NOT_FOUND)
            elif not floor.active:
                errors.add(f"{prefix}floor_ids", LOCATION_ARCHIVED)
        zones = self.locations.placed(company_id, data.zone_ids)
        for zone_id in data.zone_ids:
            zone = zones.get(zone_id)
            if zone is None:
                errors.add(f"{prefix}zone_ids", REFERENCE_NOT_FOUND)
            elif not zone.active:
                errors.add(f"{prefix}zone_ids", LOCATION_ARCHIVED)
        return AccessAreas(floor_ids=frozenset(data.floor_ids), zone_ids=frozenset(data.zone_ids))

    def department_default(self, company_id: UUID, department: Department | None) -> AccessAreas:
        """The default areas of a new visit of `department`: its floor while that floor (and its building)
        is active, else none (B16-3)."""
        if department is None or department.floor_id is None:
            return NOT_SET
        floor = self.locations.placed_floors(company_id, [department.floor_id]).get(department.floor_id)
        if floor is None or not floor.active:
            return NOT_SET
        return AccessAreas(floor_ids=frozenset({department.floor_id}))

    def write(
        self, visit: Visit, areas: AccessAreas, *, current: AccessAreas = NOT_SET, now: datetime
    ) -> None:
        """Make `areas` the visit's live areas (the caller holds the visit's row, or has just created it)."""
        self.repository.replace(
            visit.company_id,
            visit.id,
            current=LiveAreas(current.floor_ids, current.zone_ids),
            floor_ids=areas.floor_ids,
            zone_ids=areas.zone_ids,
            now=now,
        )

    # ---- what the API answers ----------------------------------------------------------------------

    def views(self, company_id: UUID, visit_ids: Sequence[UUID]) -> dict[UUID, VisitAccessAreas]:
        """Each visit's allowed areas as the API shows them, in three queries whatever the visits' number."""
        live = self.repository.live(company_id, visit_ids)
        floor_ids = {floor_id for areas in live.values() for floor_id in areas.floor_ids}
        zone_ids = {zone_id for areas in live.values() for zone_id in areas.zone_ids}
        floors = self.locations.placed_floors(company_id, floor_ids)
        zones = self.locations.placed(company_id, zone_ids)
        views: dict[UUID, VisitAccessAreas] = {}
        for visit_id in visit_ids:
            areas = live.get(visit_id)
            if areas is None:
                views[visit_id] = no_areas()
                continue
            placed_floors = sorted(
                (floors[floor_id] for floor_id in areas.floor_ids if floor_id in floors),
                key=lambda place: (place.building.name.casefold(), place.floor.level, str(place.floor.id)),
            )
            placed_zones = sorted(
                (zones[zone_id] for zone_id in areas.zone_ids if zone_id in zones),
                key=lambda place: (place.floor.level, place.zone.name.casefold(), str(place.zone.id)),
            )
            views[visit_id] = VisitAccessAreas(
                floors=[
                    AccessFloor(
                        id=place.floor.id,
                        name=place.floor.name,
                        name_ar=place.floor.name_ar,
                        level=place.floor.level,
                        building=_building(place.building),
                        is_active=place.active,
                    )
                    for place in placed_floors
                ],
                zones=[
                    AccessZone(
                        id=place.zone.id,
                        name=place.zone.name,
                        name_ar=place.zone.name_ar,
                        access=ZoneAccess(place.zone.access),
                        floor=FloorRef(
                            id=place.floor.id,
                            name=place.floor.name,
                            name_ar=place.floor.name_ar,
                            level=place.floor.level,
                        ),
                        building=_building(place.building),
                        is_active=place.active,
                    )
                    for place in placed_zones
                ],
            )
        return views

    def view(self, company_id: UUID, visit_id: UUID) -> VisitAccessAreas:
        return self.views(company_id, [visit_id])[visit_id]


def _building(building: object) -> LocationRef:
    return LocationRef.model_validate(building)


def ids_of(areas: AccessAreas) -> dict[str, list[UUID]]:
    """The audit metadata of a set of areas (IDs only, sorted)."""
    return {"floor_ids": sorted(areas.floor_ids, key=str), "zone_ids": sorted(areas.zone_ids, key=str)}
