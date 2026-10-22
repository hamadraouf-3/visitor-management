"""Helpers of the Visitor Journey's tests (Phase 15): the simulator wired into the shared application, a
provider that records (or fails) its calls, a company's registry, settings and keys. Phase 16: a registry
with zones of every access level (`area_registry`), and a sighting batch (`sees`)."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.models import (
    Building,
    Company,
    CompanyTrackingSettings,
    Floor,
    TrackingAssociation,
    TrackingCamera,
    TrackingKey,
    User,
    Zone,
    ZoneAccess,
)
from app.services.environment import ServiceEnvironment
from app.services.tracking_ingestion import ingest_simulated
from app.services.tracking_provider import (
    DisabledProvider,
    ProviderError,
    ProviderHealth,
    SimulatorProvider,
    TrackingProvider,
)
from app.services.tracking_rules import new_key
from tests.conftest import TEST_START
from tests.support import API, Api, check_in, create_visit

# A visit 07:00-08:00Z (10:00-11:00 in Amman): its pass window is 06:00-09:00Z, open from TEST_START on.
VISIT_START = TEST_START + timedelta(hours=1)
EVENTS = f"{API}/tracking/events"


@dataclass
class RecordingProvider:
    """The simulator, recording every call; `fail_enroll` / `fail_revoke` make those calls raise."""

    simulator: SimulatorProvider = field(default_factory=lambda: SimulatorProvider(ingest_simulated))
    fail_enroll: bool = False
    fail_revoke: bool = False
    enrolled: list[tuple[UUID, str, str]] = field(default_factory=list)
    revoked: list[tuple[UUID, str]] = field(default_factory=list)

    @property
    def name(self) -> str:
        return "simulator"

    @property
    def enabled(self) -> bool:
        return True

    def enroll(self, *, company_id: UUID, ref: str, provider_camera_id: str, at: datetime) -> None:
        self.enrolled.append((company_id, ref, provider_camera_id))
        if self.fail_enroll:
            raise ProviderError("the provider did not take the enrollment")
        self.simulator.enroll(company_id=company_id, ref=ref, provider_camera_id=provider_camera_id, at=at)

    def revoke(self, *, company_id: UUID, ref: str) -> None:
        self.revoked.append((company_id, ref))
        if self.fail_revoke:
            raise ProviderError("the provider did not answer")

    def health(self) -> ProviderHealth:
        return ProviderHealth(reachable=True)


@dataclass
class SilentProvider(RecordingProvider):
    """A provider that takes enrollment requests and answers nothing (the association stays PENDING)."""

    def enroll(self, *, company_id: UUID, ref: str, provider_camera_id: str, at: datetime) -> None:
        self.enrolled.append((company_id, ref, provider_camera_id))


@contextmanager
def using_provider(app: FastAPI, provider: TrackingProvider) -> Iterator[TrackingProvider]:
    """Run with the application's tracking provider replaced (its one `ServiceEnvironment` swapped)."""
    environment: ServiceEnvironment = app.state.service_environment
    app.state.service_environment = replace(environment, tracking=provider)
    try:
        yield provider
    finally:
        app.state.service_environment = environment


def disabled() -> DisabledProvider:
    return DisabledProvider()


@dataclass(frozen=True)
class Registry:
    building: Building
    ground: Floor
    upper: Floor
    lobby: Zone
    office: Zone
    reception_camera: TrackingCamera  # an enrollment point on the ground floor
    ground_camera: TrackingCamera  # ground floor, lobby
    upper_camera: TrackingCamera  # upper floor, office


def registry(db: Session, company: Company, *, prefix: str = "") -> Registry:
    """A building with two floors, a zone on each, a reception camera and one camera per floor."""
    now = app_time.now()
    common: dict[str, Any] = {"company_id": company.id, "created_at": now, "updated_at": now}
    building = Building(name=f"{prefix}HQ", **common)
    db.add(building)
    db.flush()
    ground = Floor(building_id=building.id, name="Ground", level=0, **common)
    upper = Floor(building_id=building.id, name="Third", name_ar="الثالث", level=3, **common)
    db.add_all([ground, upper])
    db.flush()
    lobby = Zone(floor_id=ground.id, name="Lobby", **common)
    office = Zone(floor_id=upper.id, name="Offices", **common)
    db.add_all([lobby, office])
    db.flush()
    reception_camera = TrackingCamera(
        provider_camera_id=f"{prefix}cam-reception",
        name="Reception",
        zone_id=lobby.id,
        is_enrollment_point=True,
        **common,
    )
    ground_camera = TrackingCamera(
        provider_camera_id=f"{prefix}cam-lobby", name="Lobby east", zone_id=lobby.id, **common
    )
    upper_camera = TrackingCamera(
        provider_camera_id=f"{prefix}cam-3f", name="Third floor", zone_id=office.id, **common
    )
    db.add_all([reception_camera, ground_camera, upper_camera])
    db.commit()
    return Registry(building, ground, upper, lobby, office, reception_camera, ground_camera, upper_camera)


def tracking_settings(
    db: Session,
    company: Company,
    *,
    allowed: bool = True,
    enabled: bool = True,
    min_confidence: float | None = 0.8,
    stale_after_minutes: int = 15,
    retention_days: int = 30,
) -> CompanyTrackingSettings:
    now = app_time.now()
    row = db.get(CompanyTrackingSettings, company.id)
    if row is None:
        row = CompanyTrackingSettings(company_id=company.id, created_at=now, updated_at=now)
        db.add(row)
    row.allowed, row.enabled, row.min_confidence = allowed, enabled, min_confidence
    row.stale_after_minutes, row.retention_days = stale_after_minutes, retention_days
    db.commit()
    return row


def tracking_key(db: Session, company: Company, creator: User, *, slot: int = 1) -> str:
    """A live key of the company; returns its secret."""
    made = new_key()
    db.add(
        TrackingKey(
            company_id=company.id,
            label="Provider",
            prefix=made.prefix,
            key_hash=made.digest,
            slot=slot,
            created_by_id=creator.id,
            created_at=app_time.now(),
        )
    )
    db.commit()
    return made.secret


def inside_visit(host: Api, reception: Api, host_id: UUID, *, start: datetime = VISIT_START) -> str:
    """A visit, checked in by `reception`; returns its ID."""
    created = create_visit(host, host_id, start)
    response = check_in(reception, created["visit"]["id"])
    assert response.status_code == 200, response.text
    return str(created["visit"]["id"])


def enroll(api: Api, visit_id: str, camera: TrackingCamera) -> Any:
    return api.post(f"/visits/{visit_id}/tracking/enroll", json={"camera_id": str(camera.id)})


def post_events(client: TestClient, key: str | None, events: list[dict[str, Any]], **kwargs: Any) -> Any:
    headers = {"Authorization": f"Bearer {key}"} if key is not None else {}
    headers.update(kwargs.pop("headers", {}))
    return client.post(EVENTS, json={"events": events}, headers=headers, **kwargs)


def observed(
    ref: str,
    camera: TrackingCamera | str,
    at: datetime,
    *,
    event_id: str,
    match: str = "CONFIRMED",
    confidence: float | None = 0.93,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "provider_event_id": event_id,
        "type": "OBSERVED",
        "association_ref": ref,
        "camera_id": camera if isinstance(camera, str) else camera.provider_camera_id,
        "observed_at": at.isoformat(),
        "match": match,
        "model_version": "test-1",
    }
    if confidence is not None:
        event["confidence"] = confidence
    return event


def heartbeat(at: datetime, event_id: str = "hb-1") -> dict[str, Any]:
    return {"provider_event_id": event_id, "type": "HEARTBEAT", "observed_at": at.isoformat()}


def association_of(db: Session, visit_id: str) -> TrackingAssociation:
    """The visit's latest association, read fresh (the API never answers its ref)."""
    db.expire_all()
    association = db.scalars(
        select(TrackingAssociation)
        .where(TrackingAssociation.visit_id == UUID(visit_id))
        .order_by(TrackingAssociation.created_at.desc())
    ).first()
    assert association is not None
    return association


# ---- Phase 16: allowed areas and alerts --------------------------------------------------------------


@dataclass(frozen=True)
class AreaRegistry:
    """A building with a ground floor (a COMMON lobby and the reception camera), a second floor (a
    STANDARD zone) and a fourth floor (a STANDARD office and a RESTRICTED server room), one camera each."""

    building: Building
    ground: Floor
    second: Floor
    fourth: Floor
    lobby: Zone  # COMMON
    meeting: Zone  # STANDARD, second floor
    office: Zone  # STANDARD, fourth floor
    server: Zone  # RESTRICTED, fourth floor
    reception_camera: TrackingCamera  # an enrollment point in the lobby
    lobby_camera: TrackingCamera
    second_camera: TrackingCamera
    office_camera: TrackingCamera
    server_camera: TrackingCamera


def area_registry(db: Session, company: Company, *, prefix: str = "") -> AreaRegistry:
    now = app_time.now()
    common: dict[str, Any] = {"company_id": company.id, "created_at": now, "updated_at": now}
    building = Building(name=f"{prefix}Tower", name_ar="البرج", **common)
    db.add(building)
    db.flush()
    ground = Floor(building_id=building.id, name="Ground", name_ar="الأرضي", level=0, **common)
    second = Floor(building_id=building.id, name="Second", name_ar="الثاني", level=2, **common)
    fourth = Floor(building_id=building.id, name="Fourth", name_ar="الرابع", level=4, **common)
    db.add_all([ground, second, fourth])
    db.flush()
    lobby = Zone(floor_id=ground.id, name="Lobby", access=ZoneAccess.COMMON.value, **common)
    meeting = Zone(floor_id=second.id, name="Meeting rooms", access=ZoneAccess.STANDARD.value, **common)
    office = Zone(floor_id=fourth.id, name="Open office", name_ar="المكاتب", **common)
    server = Zone(floor_id=fourth.id, name="Server room", access=ZoneAccess.RESTRICTED.value, **common)
    db.add_all([lobby, meeting, office, server])
    db.flush()

    def camera(provider_id: str, name: str, zone: Zone, *, point: bool = False) -> TrackingCamera:
        return TrackingCamera(
            provider_camera_id=f"{prefix}{provider_id}",
            name=name,
            zone_id=zone.id,
            is_enrollment_point=point,
            **common,
        )

    cameras = (
        camera("cam-reception", "Reception", lobby, point=True),
        camera("cam-lobby", "Lobby", lobby),
        camera("cam-2f", "Second floor", meeting),
        camera("cam-4f", "Fourth floor", office),
        camera("cam-4f-server", "Server room", server),
    )
    db.add_all(cameras)
    db.commit()
    return AreaRegistry(building, ground, second, fourth, lobby, meeting, office, server, *cameras)


def sees(
    client: TestClient,
    key: str,
    ref: str,
    camera: TrackingCamera,
    at: datetime,
    *,
    event_id: str,
    match: str = "CONFIRMED",
    confidence: float | None = 0.93,
) -> list[tuple[str, str | None]]:
    """One batch: a heartbeat and one observation; the outcomes of both."""
    response = post_events(
        client,
        key,
        [
            heartbeat(at, f"hb-{event_id}"),
            observed(ref, camera, at, event_id=event_id, match=match, confidence=confidence),
        ],
    )
    assert response.status_code == 200, response.text
    return [(item["result"], item["reason"]) for item in response.json()["results"]]


def areas(*, floors: tuple[Floor, ...] = (), zones: tuple[Zone, ...] = ()) -> dict[str, list[str]]:
    """A `VisitAccessAreasInput` body."""
    return {"floor_ids": [str(floor.id) for floor in floors], "zone_ids": [str(zone.id) for zone in zones]}
