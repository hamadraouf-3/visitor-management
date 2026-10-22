"""The Visitor Journey's location registry (Phase 15, /api/v1/locations, docs/api.md §17).

Buildings hold floors (ordered by `level`, negative below ground), floors hold zones. Names follow the
department name rules (1-120 characters, one line, trimmed); `name_ar` is the Arabic name, shown instead
of `name` in Arabic, and may be null. Archiving is `is_active: false` (B15-5): nothing is deleted.

Phase 16: a zone's `access` (COMMON, STANDARD, RESTRICTED; B16-1), and a visit's allowed areas
(`VisitAccessAreas`, `VisitAccessAreasInput`; B16-2).
"""

from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator, Field

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.models.enums import ZoneAccess
from app.models.tracking import FLOOR_LEVEL_MAX, FLOOR_LEVEL_MIN
from app.schemas.common import (
    DepartmentName,
    NotNull,
    OptionalDepartmentName,
    RequestModel,
    ResponseModel,
    UTCDatetime,
)
from app.services.tracking_rules import ACCESS_AREAS_MAX

LocationName = DepartmentName
OptionalLocationName = OptionalDepartmentName
FloorLevel = Annotated[int, Field(ge=FLOOR_LEVEL_MIN, le=FLOOR_LEVEL_MAX)]
DUPLICATE_AREAS = FieldProblem(FieldCode.DUPLICATES, "Choose each place once.")


def _no_duplicates(ids: list[UUID]) -> list[UUID]:
    if len(set(ids)) != len(ids):
        raise FieldValueError(DUPLICATE_AREAS)
    return ids


# Floors or zones of a visit's allowed areas: at most ACCESS_AREAS_MAX, each once (B16-2).
AccessAreaIds = Annotated[list[UUID], Field(max_length=ACCESS_AREAS_MAX), AfterValidator(_no_duplicates)]


# ---- references (journeys, cameras) ----------------------------------------------------------------


class LocationRef(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None


class FloorRef(LocationRef):
    level: int


class ZoneRef(LocationRef):
    """A zone as a location embeds it, with its access level (Phase 16, B16-1): the zone's level now."""

    access: ZoneAccess


class JourneyLocation(ResponseModel):
    """A zone with its floor and building: where a camera is, or was when an event arrived."""

    building: LocationRef
    floor: FloorRef
    zone: ZoneRef


# ---- a visit's allowed areas (Phase 16, B16-2) -----------------------------------------------------------


class AccessFloor(ResponseModel):
    """An allowed floor of a visit, with its building. `is_active`: the floor and its building are active."""

    id: UUID
    name: str
    name_ar: str | None
    level: int
    building: LocationRef
    is_active: bool


class AccessZone(ResponseModel):
    """An allowed extra zone of a visit (any access level, on any floor), with its floor and building."""

    id: UUID
    name: str
    name_ar: str | None
    access: ZoneAccess
    floor: FloorRef
    building: LocationRef
    is_active: bool


class VisitAccessAreas(ResponseModel):
    """A visit's allowed areas: floors by building name then level, zones by floor level then name. Both
    empty: "not set" (only RESTRICTED zones alert for the visit)."""

    floors: list[AccessFloor]
    zones: list[AccessZone]


class VisitAccessAreasInput(RequestModel):
    """PUT /visits/{id}/access-areas, and `access_areas` of a new visit: active floors and zones of the
    company, each list at most 50, no duplicates. Both empty: "not set"."""

    floor_ids: AccessAreaIds
    zone_ids: AccessAreaIds


# ---- the registry ----------------------------------------------------------------------------------


class Building(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None
    is_active: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class Floor(ResponseModel):
    id: UUID
    building_id: UUID
    name: str
    name_ar: str | None
    level: int
    is_active: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class Zone(ResponseModel):
    id: UUID
    floor_id: UUID
    name: str
    name_ar: str | None
    access: ZoneAccess
    is_active: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class FloorNode(Floor):
    zones: list[Zone]


class BuildingNode(Building):
    floors: list[FloorNode]


class LocationTree(ResponseModel):
    """GET /locations: every building of the company, active and archived, by name; floors by level;
    zones by name."""

    buildings: list[BuildingNode]


class BuildingCreate(RequestModel):
    name: LocationName
    name_ar: OptionalLocationName = None


class BuildingUpdate(RequestModel):
    """PATCH: omitted fields are unchanged; `name_ar` null (or blank) clears it; `is_active` archives
    (false) or restores (true)."""

    name: Annotated[LocationName | None, NotNull] = None
    name_ar: OptionalLocationName = None
    is_active: Annotated[bool | None, NotNull] = None


class FloorCreate(RequestModel):
    building_id: UUID
    name: LocationName
    name_ar: OptionalLocationName = None
    level: FloorLevel


class FloorUpdate(RequestModel):
    name: Annotated[LocationName | None, NotNull] = None
    name_ar: OptionalLocationName = None
    level: Annotated[FloorLevel | None, NotNull] = None
    is_active: Annotated[bool | None, NotNull] = None


class ZoneCreate(RequestModel):
    floor_id: UUID
    name: LocationName
    name_ar: OptionalLocationName = None
    access: ZoneAccess = ZoneAccess.STANDARD


class ZoneUpdate(RequestModel):
    name: Annotated[LocationName | None, NotNull] = None
    name_ar: OptionalLocationName = None
    access: Annotated[ZoneAccess | None, NotNull] = None
    is_active: Annotated[bool | None, NotNull] = None
