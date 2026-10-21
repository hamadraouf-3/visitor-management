"""The Visitor Journey's location registry (Phase 15, docs/api.md §17): the tree for every role that sees
journeys; buildings, floors and zones created, changed and archived by administrators. Nothing is
deleted (B15-5)."""

from uuid import UUID

from fastapi import APIRouter, status

from app.api.deps import AdminAuth, ContextDep, LocationsServiceDep, ViewJourneysAuth
from app.schemas.locations import (
    Building,
    BuildingCreate,
    BuildingUpdate,
    Floor,
    FloorCreate,
    FloorUpdate,
    LocationTree,
    Zone,
    ZoneCreate,
    ZoneUpdate,
)

router = APIRouter(prefix="/locations", tags=["locations"])


@router.get("", response_model=LocationTree)
def get_locations(auth: ViewJourneysAuth, service: LocationsServiceDep) -> LocationTree:
    return service.tree(auth)


@router.post("/buildings", response_model=Building, status_code=status.HTTP_201_CREATED)
def create_building(
    body: BuildingCreate, auth: AdminAuth, service: LocationsServiceDep, context: ContextDep
) -> Building:
    return service.create_building(auth, body, context)


@router.patch("/buildings/{building_id}", response_model=Building)
def update_building(
    building_id: UUID,
    body: BuildingUpdate,
    auth: AdminAuth,
    service: LocationsServiceDep,
    context: ContextDep,
) -> Building:
    return service.update_building(auth, building_id, body, context)


@router.post("/floors", response_model=Floor, status_code=status.HTTP_201_CREATED)
def create_floor(
    body: FloorCreate, auth: AdminAuth, service: LocationsServiceDep, context: ContextDep
) -> Floor:
    return service.create_floor(auth, body, context)


@router.patch("/floors/{floor_id}", response_model=Floor)
def update_floor(
    floor_id: UUID, body: FloorUpdate, auth: AdminAuth, service: LocationsServiceDep, context: ContextDep
) -> Floor:
    return service.update_floor(auth, floor_id, body, context)


@router.post("/zones", response_model=Zone, status_code=status.HTTP_201_CREATED)
def create_zone(body: ZoneCreate, auth: AdminAuth, service: LocationsServiceDep, context: ContextDep) -> Zone:
    return service.create_zone(auth, body, context)


@router.patch("/zones/{zone_id}", response_model=Zone)
def update_zone(
    zone_id: UUID, body: ZoneUpdate, auth: AdminAuth, service: LocationsServiceDep, context: ContextDep
) -> Zone:
    return service.update_zone(auth, zone_id, body, context)
