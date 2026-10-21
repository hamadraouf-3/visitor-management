"""The Visitor Journey's location registry (Phase 15, /api/v1/locations, docs/api.md §17).

Buildings hold floors (ordered by `level`, negative below ground), floors hold zones. Names follow the
department name rules (1-120 characters, one line, trimmed); `name_ar` is the Arabic name, shown instead
of `name` in Arabic, and may be null. Archiving is `is_active: false` (B15-5): nothing is deleted.
"""

from typing import Annotated
from uuid import UUID

from pydantic import Field

from app.models.tracking import FLOOR_LEVEL_MAX, FLOOR_LEVEL_MIN
from app.schemas.common import (
    DepartmentName,
    NotNull,
    OptionalDepartmentName,
    RequestModel,
    ResponseModel,
    UTCDatetime,
)

LocationName = DepartmentName
OptionalLocationName = OptionalDepartmentName
FloorLevel = Annotated[int, Field(ge=FLOOR_LEVEL_MIN, le=FLOOR_LEVEL_MAX)]


# ---- references (journeys, cameras) ----------------------------------------------------------------


class LocationRef(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None


class FloorRef(LocationRef):
    level: int


class JourneyLocation(ResponseModel):
    """A zone with its floor and building: where a camera is, or was when an event arrived."""

    building: LocationRef
    floor: FloorRef
    zone: LocationRef


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


class ZoneUpdate(RequestModel):
    name: Annotated[LocationName | None, NotNull] = None
    name_ar: OptionalLocationName = None
    is_active: Annotated[bool | None, NotNull] = None
