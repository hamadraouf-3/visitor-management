"""A visit's allowed areas and what feeds them (Phase 16, B16-1, B16-2, B16-3, B16-13, B16-19): a zone's
access level, a department's floor and the default it gives new visits (invitations and walk-ins), the
areas a request names, PUT /visits/{id}/access-areas for each role and status, its validation codes and
tenant isolation, the location tree for every role, and the companies' alert settings."""

from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import Visit, VisitAccessArea
from tests.support import (
    Api,
    World,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    create_visit_booked_by,
    error_code,
    signed_in,
    visit_body,
    walk_in_body,
)
from tests.tracking_support import VISIT_START, AreaRegistry, area_registry, areas


@pytest.fixture
def admin(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.admin)


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


@pytest.fixture
def places(db: Session, world: World) -> AreaRegistry:
    return area_registry(db, world.a.company)


def field_codes(response: Any) -> dict[str, Any]:
    assert response.status_code == 422, response.text
    return {
        field: entry["code"] for field, entry in response.json()["error"]["details"]["field_codes"].items()
    }


def floor_ids(visit: dict[str, Any]) -> list[str]:
    return [floor["id"] for floor in visit["access_areas"]["floors"]]


def zone_ids(visit: dict[str, Any]) -> list[str]:
    return [zone["id"] for zone in visit["access_areas"]["zones"]]


def put_areas(api: Api, visit_id: str, body: dict[str, Any]) -> Any:
    return api.put(f"/visits/{visit_id}/access-areas", json=body)


def archive_zone(admin: Api, zone: Any, camera: Any) -> None:
    """A zone is archived once its cameras are (B15-5)."""
    assert admin.patch(f"/tracking/cameras/{camera.id}", json={"is_active": False}).status_code == 200
    assert admin.patch(f"/locations/zones/{zone.id}", json={"is_active": False}).status_code == 200


# ---- zones' access level ---------------------------------------------------------------------------


def test_a_zone_s_access_level(admin: Api, places: AreaRegistry, db: Session) -> None:
    created = admin.post("/locations/zones", json={"floor_id": str(places.second.id), "name": "Kitchen"})
    assert created.status_code == 201 and created.json()["access"] == "STANDARD"
    vault = admin.post(
        "/locations/zones", json={"floor_id": str(places.second.id), "name": "Vault", "access": "RESTRICTED"}
    )
    assert vault.status_code == 201 and vault.json()["access"] == "RESTRICTED"
    zone_id = created.json()["id"]
    changed = admin.patch(f"/locations/zones/{zone_id}", json={"access": "COMMON"})
    assert changed.status_code == 200 and changed.json()["access"] == "COMMON"
    [row] = audit_rows(db, "LOCATION_UPDATED", entity_id=UUID(zone_id))
    assert row.meta == {"changed_fields": ["access"]}
    assert field_codes(admin.patch(f"/locations/zones/{zone_id}", json={"access": "SECRET"})) == {
        "access": "invalid_choice"
    }
    assert field_codes(admin.patch(f"/locations/zones/{zone_id}", json={"access": None})) == {
        "access": "required"
    }
    tree = admin.get("/locations").json()
    second = next(floor for floor in tree["buildings"][0]["floors"] if floor["level"] == 2)
    assert {zone["name"]: zone["access"] for zone in second["zones"]} == {
        "Kitchen": "COMMON",
        "Meeting rooms": "STANDARD",
        "Vault": "RESTRICTED",
    }


def test_every_role_reads_the_locations_and_a_host_only_the_active_ones(
    make_client, admin: Api, places: AreaRegistry, world: World
) -> None:
    annex = admin.post("/locations/buildings", json={"name": "Annex"}).json()
    archive_zone(admin, places.server, places.server_camera)
    assert admin.patch(f"/locations/buildings/{annex['id']}", json={"is_active": False}).status_code == 200
    # A floor archived inside the active building (its zone first, B15-5).
    archive_zone(admin, places.meeting, places.second_camera)
    assert admin.patch(f"/locations/floors/{places.second.id}", json={"is_active": False}).status_code == 200
    host_tree = signed_in(make_client, world.a.employee).get("/locations")
    assert host_tree.status_code == 200
    [tower] = host_tree.json()["buildings"]
    assert tower["name"] == "Tower"
    assert sorted(floor["name"] for floor in tower["floors"]) == ["Fourth", "Ground"]
    assert {floor["is_active"] for floor in tower["floors"]} == {True}
    fourth = next(floor for floor in tower["floors"] if floor["level"] == 4)
    assert [zone["name"] for zone in fourth["zones"]] == ["Open office"]
    for user in (world.a.admin, world.a.manager, world.a.receptionist):
        tree = signed_in(make_client, user).get("/locations").json()
        assert len(tree["buildings"]) == 2  # the archived one too
        tower = next(building for building in tree["buildings"] if building["name"] == "Tower")
        floors = {floor["name"]: floor for floor in tower["floors"]}
        assert {name: floor["is_active"] for name, floor in floors.items()} == {
            "Ground": True,
            "Second": False,  # listed, as archived
            "Fourth": True,
        }
        assert [(zone["name"], zone["is_active"]) for zone in floors["Second"]["zones"]] == [
            ("Meeting rooms", False)
        ]
    # Another company's registry stays its own; writes stay the administrators'.
    other = signed_in(make_client, world.b.employee)
    assert other.get("/locations").json() == {"buildings": []}
    assert other.post("/locations/buildings", json={"name": "Mine"}).status_code == 403


# ---- a department's floor ---------------------------------------------------------------------------


def test_a_department_s_floor(
    make_client, admin: Api, places: AreaRegistry, world: World, db: Session
) -> None:
    created = admin.post("/departments", json={"name": "Research", "floor_id": str(places.second.id)})
    assert created.status_code == 201, created.text
    assert created.json()["floor"] == {
        "id": str(places.second.id),
        "name": "Second",
        "name_ar": "الثاني",
        "level": 2,
        "building": {"id": str(places.building.id), "name": "Tower", "name_ar": "البرج"},
        "is_active": True,
    }
    department_id = created.json()["id"]
    listed = signed_in(make_client, world.a.employee).get("/departments").json()
    assert next(item for item in listed if item["id"] == department_id)["floor"]["id"] == str(
        places.second.id
    )
    assert next(item for item in listed if item["name"] == "Finance")["floor"] is None
    changed = admin.patch(f"/departments/{department_id}", json={"floor_id": str(places.fourth.id)})
    assert changed.status_code == 200 and changed.json()["floor"]["level"] == 4
    [updated] = audit_rows(db, "DEPARTMENT_UPDATED", entity_id=UUID(department_id))
    assert updated.meta == {"changed_fields": ["floor_id"]}
    cleared = admin.patch(f"/departments/{department_id}", json={"floor_id": None})
    assert cleared.status_code == 200 and cleared.json()["floor"] is None
    # Unknown, or another company's: not found.
    other = area_registry(db, world.b.company, prefix="b-")
    for floor_id in (UUID(int=3), other.second.id):
        body = {"floor_id": str(floor_id)}
        assert field_codes(admin.patch(f"/departments/{department_id}", json=body)) == {
            "floor_id": "not_found"
        }
        assert field_codes(admin.post("/departments", json={"name": "X", **body})) == {
            "floor_id": "not_found"
        }
    assert (
        admin.patch(f"/departments/{department_id}", json={"floor_id": str(places.second.id)}).status_code
        == 200
    )
    # Archiving a floor a department names is not refused; the department shows it archived, and an archived
    # floor cannot be chosen.
    archive_zone(admin, places.meeting, places.second_camera)
    assert admin.patch(f"/locations/floors/{places.second.id}", json={"is_active": False}).status_code == 200
    shown = admin.get("/departments", params={"include_inactive": "true"}).json()
    assert next(item for item in shown if item["id"] == department_id)["floor"]["is_active"] is False
    finance = world.a.finance.id
    assert field_codes(admin.patch(f"/departments/{finance}", json={"floor_id": str(places.second.id)})) == {
        "floor_id": "location_archived"
    }
    # Unchanged (the same archived floor again) is no change at all.
    same = admin.patch(f"/departments/{department_id}", json={"floor_id": str(places.second.id)})
    assert same.status_code == 200


# ---- the areas of a new visit ---------------------------------------------------------------------------


def test_a_new_visit_gets_its_department_s_floor_unless_it_names_its_areas(
    make_client, admin: Api, host: Api, places: AreaRegistry, world: World, db: Session, factory
) -> None:
    finance = world.a.finance.id
    admin.patch(f"/departments/{finance}", json={"floor_id": str(places.second.id)})
    defaulted = create_visit(host, world.a.employee.id, VISIT_START, department_id=str(finance))["visit"]
    assert floor_ids(defaulted) == [str(places.second.id)] and zone_ids(defaulted) == []
    [made] = audit_rows(db, "VISIT_CREATED", entity_id=UUID(defaulted["id"]))
    assert made.meta["access_floor_ids"] == [str(places.second.id)] and made.meta["access_zone_ids"] == []
    explicit = create_visit(
        host,
        world.a.employee.id,
        VISIT_START,
        department_id=str(finance),
        access_areas=areas(floors=(places.fourth,), zones=(places.server, places.meeting)),
    )["visit"]
    assert floor_ids(explicit) == [str(places.fourth.id)]
    assert zone_ids(explicit) == [str(places.meeting.id), str(places.server.id)]  # by floor level, then name
    assert explicit["access_areas"]["zones"][1]["access"] == "RESTRICTED"
    nothing = create_visit(
        host, world.a.employee.id, VISIT_START, department_id=str(finance), access_areas=areas()
    )["visit"]
    assert nothing["access_areas"] == {"floors": [], "zones": []}
    as_null = create_visit(
        host, world.a.employee.id, VISIT_START, department_id=str(finance), access_areas=None
    )["visit"]
    assert floor_ids(as_null) == [str(places.second.id)]
    # Without a department named, the host's department (as for the visit's department itself).
    member = factory.user(world.a.company, department=world.a.finance)
    own = create_visit(signed_in(make_client, member), member.id, VISIT_START)["visit"]
    assert own["department"]["id"] == str(finance) and floor_ids(own) == [str(places.second.id)]
    # No department, no floor: not set.
    plain = create_visit(host, world.a.employee.id, VISIT_START)["visit"]
    assert plain["access_areas"] == {"floors": [], "zones": []}
    # An archived floor is skipped, never refused.
    archive_zone(admin, places.meeting, places.second_camera)
    assert admin.patch(f"/locations/floors/{places.second.id}", json={"is_active": False}).status_code == 200
    skipped = create_visit(host, world.a.employee.id, VISIT_START, department_id=str(finance))["visit"]
    assert skipped["access_areas"] == {"floors": [], "zones": []}


def test_a_walk_in_gets_the_same_default(
    admin: Api, reception: Api, places: AreaRegistry, world: World, db: Session, clock: FakeClock
) -> None:
    finance = world.a.finance.id
    admin.patch(f"/departments/{finance}", json={"floor_id": str(places.fourth.id)})
    end = clock.peek() + timedelta(hours=2)
    walked = reception.post(
        "/reception/walk-ins", json=walk_in_body(world.a.employee.id, end, department_id=str(finance))
    )
    assert walked.status_code == 201, walked.text
    assert floor_ids(walked.json()) == [str(places.fourth.id)]
    [made] = audit_rows(db, "WALK_IN_CREATED", entity_id=UUID(walked.json()["id"]))
    assert made.meta["access_floor_ids"] == [str(places.fourth.id)]
    named = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            end,
            department_id=str(finance),
            visitor={"full_name": "Second Walker"},
            access_areas=areas(zones=(places.lobby,)),
        ),
    )
    assert named.status_code == 201, named.text
    assert floor_ids(named.json()) == [] and zone_ids(named.json()) == [str(places.lobby.id)]
    refused = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            end,
            visitor={"full_name": "Third Walker"},
            access_areas={"floor_ids": [str(UUID(int=9))], "zone_ids": []},
        ),
    )
    assert field_codes(refused) == {"access_areas.floor_ids": "not_found"}


def test_the_areas_a_request_names_are_checked(
    admin: Api, host: Api, places: AreaRegistry, world: World, db: Session
) -> None:
    other = area_registry(db, world.b.company, prefix="b-")
    archive_zone(admin, places.server, places.server_camera)
    created = visit_body(
        world.a.employee.id,
        VISIT_START,
        access_areas={"floor_ids": [str(other.second.id)], "zone_ids": [str(places.server.id)]},
    )
    assert field_codes(host.post("/visits", json=created)) == {
        "access_areas.floor_ids": "not_found",
        "access_areas.zone_ids": "location_archived",
    }
    twice = str(places.second.id)
    duplicated = visit_body(
        world.a.employee.id, VISIT_START, access_areas={"floor_ids": [twice, twice], "zone_ids": []}
    )
    assert field_codes(host.post("/visits", json=duplicated)) == {"access_areas.floor_ids": "duplicates"}
    many = [str(UUID(int=number)) for number in range(1, 52)]
    too_many = visit_body(world.a.employee.id, VISIT_START, access_areas={"floor_ids": [], "zone_ids": many})
    assert field_codes(host.post("/visits", json=too_many)) == {"access_areas.zone_ids": "too_many_items"}
    missing = visit_body(world.a.employee.id, VISIT_START, access_areas={"floor_ids": []})
    assert field_codes(host.post("/visits", json=missing)) == {"access_areas.zone_ids": "required"}
    assert db.scalars(select(Visit.id).where(Visit.company_id == world.a.company.id)).all() == []


# ---- PUT /visits/{id}/access-areas -------------------------------------------------------------------


def test_who_changes_a_visit_s_areas(
    make_client,
    admin: Api,
    host: Api,
    reception: Api,
    places: AreaRegistry,
    world: World,
    db: Session,
    factory,
) -> None:
    visit = create_visit(host, world.a.employee.id, VISIT_START)["visit"]
    visit_id = visit["id"]
    assert visit["permissions"]["can_edit_access_areas"] is True  # the host
    for api, floor in ((host, places.second), (reception, places.fourth), (admin, places.ground)):
        response = put_areas(api, visit_id, areas(floors=(floor,)))
        assert response.status_code == 200, response.text
        assert floor_ids(response.json()) == [str(floor.id)]
    body = areas(floors=(places.second,))
    manager = signed_in(make_client, world.a.manager)
    assert manager.get(f"/visits/{visit_id}").json()["permissions"]["can_edit_access_areas"] is False
    refused = put_areas(manager, visit_id, body)
    assert refused.status_code == 403 and error_code(refused) == "FORBIDDEN"
    # Another employee: the visit is not theirs to read (404, as every visit endpoint answers).
    colleague = signed_in(make_client, factory.user(world.a.company))
    assert put_areas(colleague, visit_id, body).status_code == 404
    # The employee who booked a visit for another host owns it, but only its host changes its areas.
    booker = factory.user(world.a.company)
    booked = create_visit_booked_by(db, admin, booker, world.a.employee.id, VISIT_START)["visit"]
    booker_api = signed_in(make_client, booker)
    assert booker_api.get(f"/visits/{booked['id']}").json()["permissions"]["can_edit_access_areas"] is False
    assert put_areas(booker_api, booked["id"], body).status_code == 403
    # Another company: not found, and never a body ID of another company.
    stranger = signed_in(make_client, world.b.receptionist)
    assert put_areas(stranger, visit_id, body).status_code == 404
    assert put_areas(stranger, str(UUID(int=4)), body).status_code == 404
    other = area_registry(db, world.b.company, prefix="b-")
    assert field_codes(
        put_areas(reception, visit_id, areas(floors=(other.second,), zones=(other.server,)))
    ) == {
        "floor_ids": "not_found",
        "zone_ids": "not_found",
    }


def test_the_areas_change_while_scheduled_or_checked_in(
    make_client, host: Api, reception: Api, places: AreaRegistry, world: World, db: Session, clock: FakeClock
) -> None:
    body = areas(floors=(places.second,))
    visit_id = create_visit(host, world.a.employee.id, VISIT_START)["visit"]["id"]
    assert check_in(reception, visit_id).status_code == 200
    inside = put_areas(reception, visit_id, body)
    assert inside.status_code == 200 and inside.json()["permissions"]["can_edit_access_areas"] is True
    assert check_out(reception, visit_id).status_code == 200
    closed = put_areas(reception, visit_id, areas())
    assert closed.status_code == 409 and error_code(closed) == "VISIT_NOT_EDITABLE"
    assert reception.get(f"/visits/{visit_id}").json()["permissions"]["can_edit_access_areas"] is False
    cancelled_id = create_visit(host, world.a.employee.id, VISIT_START)["visit"]["id"]
    assert host.post(f"/visits/{cancelled_id}/cancel").status_code == 200
    assert error_code(put_areas(host, cancelled_id, body)) == "VISIT_NOT_EDITABLE"
    # A visit whose window has passed is marked NO_SHOW under the lock, and refused.
    late_id = create_visit(host, world.a.employee.id, VISIT_START)["visit"]["id"]
    clock.advance(hours=5)
    host = signed_in(make_client, world.a.employee)  # the earlier session has timed out meanwhile
    late = put_areas(host, late_id, body)
    assert late.status_code == 409 and error_code(late) == "VISIT_NOT_EDITABLE"
    assert host.get(f"/visits/{late_id}").json()["status"] == "NO_SHOW"
    # Checks of the body come after those of the visit.
    assert error_code(put_areas(host, late_id, {"floor_ids": [str(UUID(int=1))], "zone_ids": []})) == (
        "VISIT_NOT_EDITABLE"
    )


def test_a_change_is_audited_and_an_unchanged_set_writes_nothing(
    host: Api, places: AreaRegistry, world: World, db: Session
) -> None:
    visit_id = create_visit(host, world.a.employee.id, VISIT_START)["visit"]["id"]
    first = put_areas(host, visit_id, areas(floors=(places.second,), zones=(places.server,)))
    assert first.status_code == 200
    [changed] = audit_rows(db, "VISIT_ACCESS_AREAS_CHANGED")
    assert changed.actor_user_id == world.a.employee.id and changed.entity_id == UUID(visit_id)
    assert changed.meta == {
        "added_floor_ids": [str(places.second.id)],
        "removed_floor_ids": [],
        "added_zone_ids": [str(places.server.id)],
        "removed_zone_ids": [],
    }
    # The same sets in another order: nothing written.
    again = put_areas(host, visit_id, areas(zones=(places.server,), floors=(places.second,)))
    assert again.status_code == 200 and again.json() == first.json() | {
        "updated_at": again.json()["updated_at"]
    }
    assert len(audit_rows(db, "VISIT_ACCESS_AREAS_CHANGED")) == 1
    put_areas(host, visit_id, areas(floors=(places.fourth,)))
    last = audit_rows(db, "VISIT_ACCESS_AREAS_CHANGED")[-1]
    assert last.meta == {
        "added_floor_ids": [str(places.fourth.id)],
        "removed_floor_ids": [str(places.second.id)],
        "added_zone_ids": [],
        "removed_zone_ids": [str(places.server.id)],
    }
    # Taken-away areas keep their rows (the runtime role cannot delete), marked removed.
    db.expire_all()
    rows = db.scalars(select(VisitAccessArea).where(VisitAccessArea.visit_id == UUID(visit_id))).all()
    live = {row.floor_id or row.zone_id for row in rows if row.removed_at is None}
    removed = {row.floor_id or row.zone_id for row in rows if row.removed_at is not None}
    assert live == {places.fourth.id} and removed == {places.second.id, places.server.id}
    # A floor given back is a new row.
    put_areas(host, visit_id, areas(floors=(places.second,)))
    put_areas(host, visit_id, areas(floors=(places.fourth,)))
    db.expire_all()
    rows = db.scalars(select(VisitAccessArea).where(VisitAccessArea.visit_id == UUID(visit_id))).all()
    assert sum(1 for row in rows if row.floor_id == places.fourth.id) == 2


def test_every_visit_answer_carries_its_areas(
    admin: Api, host: Api, reception: Api, places: AreaRegistry, world: World, db: Session
) -> None:
    annex = area_registry(db, world.a.company, prefix="annex-")
    db.execute(
        update(type(annex.building)).where(type(annex.building).id == annex.building.id).values(name="Annex")
    )
    db.commit()
    visit_id = create_visit(host, world.a.employee.id, VISIT_START)["visit"]["id"]
    put_areas(
        reception,
        visit_id,
        areas(floors=(places.fourth, annex.second, places.second), zones=(places.server, places.lobby)),
    )
    shown = host.get(f"/visits/{visit_id}").json()
    # Floors by building name, then level; zones by their floor's level, then name.
    assert [(floor["building"]["name"], floor["level"]) for floor in shown["access_areas"]["floors"]] == [
        ("Annex", 2),
        ("Tower", 2),
        ("Tower", 4),
    ]
    assert [zone["name"] for zone in shown["access_areas"]["zones"]] == ["Lobby", "Server room"]
    assert shown["access_areas"]["zones"][0]["floor"] == {
        "id": str(places.ground.id),
        "name": "Ground",
        "name_ar": "الأرضي",
        "level": 0,
    }
    listed = admin.get("/visits").json()["items"]
    assert next(item for item in listed if item["id"] == visit_id)["access_areas"] == shown["access_areas"]
    assert check_in(reception, visit_id).status_code == 200
    inside = reception.get("/reception/inside").json()
    assert (
        next(item for item in inside["items"] if item["id"] == visit_id)["access_areas"]
        == shown["access_areas"]
    )
    today = reception.get("/reception/today").json()
    assert all("access_areas" in item for item in today["inside"])


# ---- the companies' alert settings -------------------------------------------------------------------


def test_the_alert_settings(make_client, admin: Api, world: World, db: Session) -> None:
    from tests.tracking_support import tracking_settings

    tracking_settings(db, world.a.company)
    changed = admin.patch(
        "/tracking/settings",
        json={
            "area_alerts_enabled": False,
            "alert_notify_host": False,
            "alert_emails": [" Guard@Example.COM", "guard@example.com", "desk@example.org"],
        },
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["area_alerts_enabled"], body["alert_notify_host"]) == (False, False)
    assert body["alert_emails"] == ["guard@example.com", "desk@example.org"]
    [row] = audit_rows(db, "TRACKING_SETTINGS_UPDATED")
    assert row.meta == {"changed_fields": ["alert_emails", "alert_notify_host", "area_alerts_enabled"]}
    # Another order is another list (it is the order the e-mails go out in); the same list again writes
    # nothing.
    reordered = {"alert_emails": ["desk@example.org", "guard@example.com"]}
    assert (
        admin.patch("/tracking/settings", json=reordered).json()["alert_emails"] == reordered["alert_emails"]
    )
    assert len(audit_rows(db, "TRACKING_SETTINGS_UPDATED")) == 2
    assert admin.patch("/tracking/settings", json=reordered).status_code == 200
    assert len(audit_rows(db, "TRACKING_SETTINGS_UPDATED")) == 2
    # A bad address is answered at its own index; more than five are refused; null is refused.
    bad = admin.patch("/tracking/settings", json={"alert_emails": ["ok@example.com", "not-an-address"]})
    assert field_codes(bad) == {"alert_emails.1": "invalid_email"}
    six = [f"user{number}@example.com" for number in range(6)]
    assert field_codes(admin.patch("/tracking/settings", json={"alert_emails": six})) == {
        "alert_emails": "too_many_items"
    }
    for name in ("alert_emails", "area_alerts_enabled", "alert_notify_host"):
        assert field_codes(admin.patch("/tracking/settings", json={name: None})) == {name: "required"}
    cleared = admin.patch("/tracking/settings", json={"alert_emails": []})
    assert cleared.status_code == 200 and cleared.json()["alert_emails"] == []
    for user in (world.a.manager, world.a.receptionist):
        assert (
            signed_in(make_client, user).patch("/tracking/settings", json={"alert_emails": []}).status_code
            == 403
        )
