"""The Visitor Journey's configuration (Phase 15): the location registry, cameras, a company's tracking
settings and status, its provider keys, and the platform owner's switch. Roles, tenant isolation and
audit rows on every endpoint."""

import hashlib
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import CompanyTrackingSettings, TrackingKey
from tests.support import (
    Api,
    World,
    audit_rows,
    error_code,
    platform_audit_rows,
    platform_signed_in,
    signed_in,
)
from tests.tracking_support import RecordingProvider, Registry, registry, tracking_settings, using_provider


@pytest.fixture
def admin(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.admin)


def codes(response: Any) -> dict[str, Any]:
    assert response.status_code == 422, response.text
    return response.json()["error"]["details"]["field_codes"]


# ---- the location registry ----------------------------------------------------------------------------


def test_administrators_build_the_tree_and_every_journey_role_reads_it(
    make_client, admin: Api, world: World, db: Session
) -> None:
    building = admin.post("/locations/buildings", json={"name": "  HQ ", "name_ar": "المقر"})
    assert building.status_code == 201, building.text
    assert building.json()["name"] == "HQ" and building.json()["is_active"] is True
    building_id = building.json()["id"]
    for level, name in ((2, "Second"), (-1, "Basement"), (0, "Ground")):
        response = admin.post(
            "/locations/floors", json={"building_id": building_id, "name": name, "level": level}
        )
        assert response.status_code == 201, response.text
    floors = {
        floor["level"]: floor["id"] for floor in admin.get("/locations").json()["buildings"][0]["floors"]
    }
    zone = admin.post("/locations/zones", json={"floor_id": floors[0], "name": "Lobby"})
    assert zone.status_code == 201
    for user in (world.a.manager, world.a.receptionist):
        tree = signed_in(make_client, user).get("/locations")
        assert tree.status_code == 200
        [only] = tree.json()["buildings"]
        assert [floor["level"] for floor in only["floors"]] == [-1, 0, 2]  # by level
        assert only["floors"][1]["zones"][0]["name"] == "Lobby"
    employee = signed_in(make_client, world.a.employee)
    assert employee.get("/locations").status_code == 403
    for user in (world.a.manager, world.a.receptionist):
        api = signed_in(make_client, user)
        assert api.post("/locations/buildings", json={"name": "Annex"}).status_code == 403
    created = audit_rows(db, "LOCATION_CREATED")
    assert [row.entity_type for row in created] == ["building", "floor", "floor", "floor", "zone"]


def test_names_and_levels_are_unique_per_parent(admin: Api, world: World, db: Session) -> None:
    places = registry(db, world.a.company)
    taken = admin.post("/locations/buildings", json={"name": "hq"})
    assert taken.status_code == 409 and taken.json()["error"]["details"] == {"field": "name"}
    level = admin.post(
        "/locations/floors", json={"building_id": str(places.building.id), "name": "X", "level": 3}
    )
    assert level.status_code == 409 and level.json()["error"]["details"] == {"field": "level"}
    zone = admin.post("/locations/zones", json={"floor_id": str(places.ground.id), "name": "LOBBY"})
    assert zone.status_code == 409 and zone.json()["error"]["details"] == {"field": "name"}
    # The same zone name on another floor is fine; another company may reuse every name.
    assert (
        admin.post("/locations/zones", json={"floor_id": str(places.upper.id), "name": "Lobby"}).status_code
        == 201
    )
    registry(db, world.b.company)
    moved = admin.patch(f"/locations/floors/{places.upper.id}", json={"level": 0})
    assert moved.status_code == 409 and moved.json()["error"]["details"] == {"field": "level"}


def test_archiving_needs_an_empty_location_and_children_need_an_active_parent(
    admin: Api, world: World, db: Session
) -> None:
    places = registry(db, world.a.company)
    for path in (
        f"/locations/buildings/{places.building.id}",
        f"/locations/floors/{places.upper.id}",
        f"/locations/zones/{places.office.id}",
    ):
        response = admin.patch(path, json={"is_active": False})
        assert response.status_code == 409 and error_code(response) == "LOCATION_IN_USE", path
    # Archive the camera, then the zone, then the floor.
    assert (
        admin.patch(f"/tracking/cameras/{places.upper_camera.id}", json={"is_active": False}).status_code
        == 200
    )
    assert admin.patch(f"/locations/zones/{places.office.id}", json={"is_active": False}).status_code == 200
    archived_floor = admin.patch(f"/locations/floors/{places.upper.id}", json={"is_active": False})
    assert archived_floor.status_code == 200 and archived_floor.json()["is_active"] is False
    # Nothing new under an archived parent, nothing restored under one.
    assert codes(admin.post("/locations/zones", json={"floor_id": str(places.upper.id), "name": "New"})) == {
        "floor_id": {"code": "location_archived", "params": {}}
    }
    assert codes(admin.patch(f"/locations/zones/{places.office.id}", json={"is_active": True})) == {
        "is_active": {"code": "location_archived", "params": {}}
    }
    camera = {"provider_camera_id": "cam-new", "name": "New", "zone_id": str(places.office.id)}
    assert codes(admin.post("/tracking/cameras", json=camera)) == {
        "zone_id": {"code": "location_archived", "params": {}}
    }
    # Restore from the top down.
    assert admin.patch(f"/locations/floors/{places.upper.id}", json={"is_active": True}).status_code == 200
    assert admin.patch(f"/locations/zones/{places.office.id}", json={"is_active": True}).status_code == 200
    [row, *_] = audit_rows(db, "LOCATION_UPDATED")
    assert row.meta == {"changed_fields": ["is_active"]}
    tree = admin.get("/locations").json()
    assert {floor["name"]: floor["is_active"] for floor in tree["buildings"][0]["floors"]} == {
        "Ground": True,
        "Third": True,
    }


def test_nothing_of_another_company_is_reachable(make_client, admin: Api, world: World, db: Session) -> None:
    mine = registry(db, world.a.company)
    other = registry(db, world.b.company, prefix="b-")
    for path in (
        f"/locations/buildings/{other.building.id}",
        f"/locations/floors/{other.upper.id}",
        f"/locations/zones/{other.office.id}",
        f"/tracking/cameras/{other.upper_camera.id}",
    ):
        response = admin.patch(path, json={"name": "Taken over"})
        assert response.status_code == 404 and error_code(response) == "NOT_FOUND", path
    floor = admin.post(
        "/locations/floors", json={"building_id": str(other.building.id), "name": "X", "level": 9}
    )
    assert codes(floor) == {"building_id": {"code": "not_found", "params": {}}}
    camera = {"provider_camera_id": "cam-x", "name": "X", "zone_id": str(other.office.id)}
    assert codes(admin.post("/tracking/cameras", json=camera)) == {
        "zone_id": {"code": "not_found", "params": {}}
    }
    tree = admin.get("/locations").json()
    assert [building["id"] for building in tree["buildings"]] == [str(mine.building.id)]
    cameras = admin.get("/tracking/cameras").json()
    assert {camera["id"] for camera in cameras} == {
        str(mine.reception_camera.id),
        str(mine.ground_camera.id),
        str(mine.upper_camera.id),
    }
    # A provider camera ID is unique per company only.
    same_id = {"provider_camera_id": "b-cam-3f", "name": "Copy", "zone_id": str(mine.office.id)}
    assert admin.post("/tracking/cameras", json=same_id).status_code == 201


# ---- cameras -----------------------------------------------------------------------------------------


def test_cameras(make_client, admin: Api, world: World, db: Session) -> None:
    places = registry(db, world.a.company)
    created = admin.post(
        "/tracking/cameras",
        json={"provider_camera_id": "cam-2f-east", "name": "East stairs", "zone_id": str(places.office.id)},
    )
    assert created.status_code == 201, created.text
    camera = created.json()
    assert camera["is_enrollment_point"] is False and camera["is_active"] is True
    assert camera["location"]["building"]["name"] == "HQ" and camera["location"]["floor"]["level"] == 3
    duplicate = admin.post(
        "/tracking/cameras",
        json={"provider_camera_id": "cam-2f-east", "name": "Again", "zone_id": str(places.office.id)},
    )
    assert duplicate.status_code == 409 and duplicate.json()["error"]["details"] == {
        "field": "provider_camera_id"
    }
    for bad in ("", "with space", "x" * 129, "naïve"):
        response = admin.post(
            "/tracking/cameras",
            json={"provider_camera_id": bad, "name": "Bad", "zone_id": str(places.office.id)},
        )
        assert response.status_code == 422, bad
    moved = admin.patch(f"/tracking/cameras/{camera['id']}", json={"zone_id": str(places.lobby.id)})
    assert moved.status_code == 200 and moved.json()["location"]["zone"]["name"] == "Lobby"
    # No URL, address or credential is ever part of a camera.
    unknown = admin.patch(
        f"/tracking/cameras/{camera['id']}", json={"rtsp_url": "rtsp://user:pass@10.0.0.1/"}
    )
    assert codes(unknown) == {"rtsp_url": {"code": "not_allowed", "params": {}}}
    [row] = audit_rows(db, "TRACKING_CAMERA_UPDATED")
    assert row.meta == {"changed_fields": ["zone_id"]}
    assert len(audit_rows(db, "TRACKING_CAMERA_CREATED")) == 1
    # Receptionists read the enrollment points only; management and hosts not at all.
    reception = signed_in(make_client, world.a.receptionist)
    listed = reception.get("/tracking/cameras")
    assert [item["id"] for item in listed.json()] == [str(places.reception_camera.id)]
    assert reception.get("/tracking/cameras", params={"include_archived": "true"}).status_code == 403
    assert reception.post("/tracking/cameras", json={}).status_code == 403
    for user in (world.a.manager, world.a.employee):
        assert signed_in(make_client, user).get("/tracking/cameras").status_code == 403
    # Archived cameras: listed for administrators on request only.
    admin.patch(f"/tracking/cameras/{camera['id']}", json={"is_active": False})
    assert camera["id"] not in {item["id"] for item in admin.get("/tracking/cameras").json()}
    assert camera["id"] in {
        item["id"] for item in admin.get("/tracking/cameras", params={"include_archived": "true"}).json()
    }


# ---- settings and status ----------------------------------------------------------------------------


def test_settings_have_the_defaults_and_enabling_needs_the_platform_owner(
    make_client, admin: Api, world: World, db: Session
) -> None:
    settings = admin.get("/tracking/settings")
    assert settings.status_code == 200
    assert settings.json() == {
        "provider": "disabled",
        "allowed": False,
        "enabled": False,
        "min_confidence": None,
        "stale_after_minutes": 15,
        "retention_days": 30,
        "health": {
            "last_contact_at": None,
            "last_accepted_event_at": None,
            "rejected_last_24h": [],
            "provider_errors_last_24h": [],
        },
    }
    assert db.get(CompanyTrackingSettings, world.a.company.id) is None  # a read writes nothing
    refused = admin.patch("/tracking/settings", json={"enabled": True})
    assert refused.status_code == 409 and refused.json()["error"]["details"] == {"reason": "NOT_ALLOWED"}
    # The registry and the other settings stay editable while tracking is not allowed.
    changed = admin.patch(
        "/tracking/settings", json={"min_confidence": 0.85, "stale_after_minutes": 10, "retention_days": 7}
    )
    assert changed.status_code == 200
    assert {
        key: changed.json()[key] for key in ("min_confidence", "stale_after_minutes", "retention_days")
    } == {
        "min_confidence": 0.85,
        "stale_after_minutes": 10,
        "retention_days": 7,
    }
    [row] = audit_rows(db, "TRACKING_SETTINGS_UPDATED")
    assert row.meta == {"changed_fields": ["min_confidence", "retention_days", "stale_after_minutes"]}
    cleared = admin.patch("/tracking/settings", json={"min_confidence": None})
    assert cleared.status_code == 200 and cleared.json()["min_confidence"] is None
    for body in (
        {"min_confidence": 1.01},
        {"min_confidence": -0.1},
        {"stale_after_minutes": 0},
        {"stale_after_minutes": 241},
        {"retention_days": 91},
        {"retention_days": None},
        {"enabled": None},
        {"allowed": True},  # the platform owner's alone
        {"provider": "simulator"},
    ):
        assert admin.patch("/tracking/settings", json=body).status_code == 422, body
    for user in (world.a.manager, world.a.receptionist, world.a.employee):
        api = signed_in(make_client, user)
        assert api.get("/tracking/settings").status_code == 403
        assert api.patch("/tracking/settings", json={"retention_days": 9}).status_code == 403


def test_status_for_the_banner(
    make_client, app: FastAPI, world: World, db: Session, clock: FakeClock
) -> None:
    reception = signed_in(make_client, world.a.receptionist)
    assert reception.get("/tracking/status").json() == {
        "provider": "disabled",
        "simulated": False,
        "available": False,
        "allowed": False,
        "enabled": False,
        "last_contact_at": None,
        "healthy": False,
    }
    tracking_settings(db, world.a.company)
    with using_provider(app, RecordingProvider()):
        status = signed_in(make_client, world.a.manager).get("/tracking/status").json()
        assert (
            status["provider"] == "simulator" and status["simulated"] is True and status["available"] is True
        )
        assert status["allowed"] is True and status["enabled"] is True
        assert status["healthy"] is False  # no contact yet
    assert signed_in(make_client, world.a.employee).get("/tracking/status").status_code == 403


# ---- keys ----------------------------------------------------------------------------------------------


def test_keys_are_shown_once_stored_as_digests_and_limited_to_two(
    make_client, admin: Api, world: World, db: Session
) -> None:
    created = admin.post("/tracking/keys", json={"label": "Shaheen pilot"})
    assert created.status_code == 201, created.text
    key = created.json()
    secret = key["secret"]
    assert secret.startswith("vtk_") and len(secret) == 47 and key["prefix"] == secret[:8]
    stored = db.scalar(select(TrackingKey).where(TrackingKey.id == key["id"]))
    assert stored is not None and stored.key_hash == hashlib.sha256(secret.encode()).hexdigest()
    listed = admin.get("/tracking/keys").json()
    assert [item["id"] for item in listed] == [key["id"]] and "secret" not in listed[0]
    assert listed[0]["created_by"] == {"id": str(world.a.admin.id), "full_name": world.a.admin.full_name}
    assert secret not in admin.get("/tracking/keys").text
    assert admin.post("/tracking/keys", json={"label": "Rotation"}).status_code == 201
    third = admin.post("/tracking/keys", json={"label": "Third"})
    assert third.status_code == 409 and error_code(third) == "TRACKING_KEY_LIMIT"
    revoked = admin.delete(f"/tracking/keys/{key['id']}")
    assert revoked.status_code == 200 and revoked.json()["revoked_at"] is not None
    assert admin.delete(f"/tracking/keys/{key['id']}").json()["revoked_at"] == revoked.json()["revoked_at"]
    assert admin.post("/tracking/keys", json={"label": "Third"}).status_code == 201
    assert len(audit_rows(db, "TRACKING_KEY_CREATED")) == 3
    [row] = audit_rows(db, "TRACKING_KEY_REVOKED")
    assert str(row.entity_id) == key["id"] and row.meta == {}
    for audit in audit_rows(db, "TRACKING_KEY_CREATED"):
        assert secret not in str(audit.meta) and key["prefix"] not in str(audit.meta)
    other = signed_in(make_client, world.b.admin)
    assert other.delete(f"/tracking/keys/{key['id']}").status_code == 404
    assert other.get("/tracking/keys").json() == []
    for user in (world.a.manager, world.a.receptionist):
        assert signed_in(make_client, user).post("/tracking/keys", json={"label": "x"}).status_code == 403


# ---- the platform owner ----------------------------------------------------------------------------------


def test_the_platform_owner_allows_tracking_per_company(
    make_client, admin: Api, world: World, db: Session, factory
) -> None:
    owner = platform_signed_in(make_client, factory.platform_admin())
    allowed = owner.patch(f"/platform/companies/{world.a.company.id}/tracking", json={"allowed": True})
    assert allowed.status_code == 200 and allowed.json()["tracking_allowed"] is True
    assert owner.get(f"/platform/companies/{world.b.company.id}").json()["tracking_allowed"] is False
    assert admin.patch("/tracking/settings", json={"enabled": True}).json()["enabled"] is True
    # The company's people see the switch in /auth/me (B15-27); another company's stays off.
    assert admin.get("/auth/me").json()["company"]["tracking_allowed"] is True
    other = signed_in(make_client, world.b.receptionist)
    assert other.get("/auth/me").json()["company"]["tracking_allowed"] is False
    again = owner.patch(f"/platform/companies/{world.a.company.id}/tracking", json={"allowed": True})
    assert again.status_code == 200
    assert len(platform_audit_rows(db, "TRACKING_ALLOWED")) == 1
    [company_row] = audit_rows(db, "TRACKING_ALLOWED")
    assert company_row.actor_user_id is None and company_row.meta["source"] == "platform"
    disallowed = owner.patch(f"/platform/companies/{world.a.company.id}/tracking", json={"allowed": False})
    assert disallowed.json()["tracking_allowed"] is False
    settings = admin.get("/tracking/settings").json()
    assert settings["allowed"] is False and settings["enabled"] is False
    assert admin.get("/auth/me").json()["company"]["tracking_allowed"] is False
    [platform_row] = platform_audit_rows(db, "TRACKING_DISALLOWED")
    assert platform_row.meta == {"was_enabled": True, "ended_tracking": 0}
    # Only the platform owner: a company administrator's session is not accepted there.
    tenant = admin.patch(f"/platform/companies/{world.a.company.id}/tracking", json={"allowed": True})
    assert tenant.status_code == 401
    missing = owner.patch(
        "/platform/companies/00000000-0000-4000-8000-000000000000/tracking", json={"allowed": True}
    )
    assert missing.status_code == 404


def test_the_company_admin_cannot_set_the_platform_switch(admin: Api, world: World, db: Session) -> None:
    tracking_settings(db, world.a.company, allowed=False, enabled=False)
    assert admin.patch("/tracking/settings", json={"allowed": True}).status_code == 422
    assert admin.get("/tracking/settings").json()["allowed"] is False


def test_registry_helpers_place_cameras(db: Session, world: World) -> None:
    places: Registry = registry(db, world.a.company)
    assert places.reception_camera.is_enrollment_point and not places.upper_camera.is_enrollment_point
