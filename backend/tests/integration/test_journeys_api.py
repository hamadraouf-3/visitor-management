"""GET /api/v1/journeys and GET /api/v1/visits/{id}/journey (Phase 15): the day's visits with their state,
search, the state filter and pagination, tenant isolation, least privilege for hosts, and the coalesced
audit of opening a journey."""

from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from tests.conftest import TEST_START
from tests.support import Api, World, audit_rows, check_in, check_out, create_visit, error_code, signed_in
from tests.tracking_support import (
    VISIT_START,
    RecordingProvider,
    Registry,
    association_of,
    enroll,
    inside_visit,
    observed,
    post_events,
    registry,
    tracking_key,
    tracking_settings,
    using_provider,
)


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


@pytest.fixture
def places(db: Session, world: World) -> Registry:
    return registry(db, world.a.company)


@pytest.fixture
def provider(app: FastAPI) -> RecordingProvider:
    with using_provider(app, RecordingProvider()) as recording:
        assert isinstance(recording, RecordingProvider)
        yield recording


def _guest(name: str, company: str | None = None) -> dict[str, str]:
    visitor = {"full_name": name, "email": f"{name.split()[0].lower()}@guests.example.com"}
    if company:
        visitor["company_name"] = company
    return visitor


def test_the_day_s_visits_with_their_state(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    db: Session,
    clock: FakeClock,
) -> None:
    tracking_settings(db, world.a.company)
    key = tracking_key(db, world.a.company, world.a.admin)
    tracked = create_visit(host, world.a.employee.id, VISIT_START, visitor=_guest("Rania Tracked", "Acme"))
    plain = create_visit(host, world.a.employee.id, VISIT_START, visitor=_guest("Omar Plain", "Globex"))
    expected = create_visit(host, world.a.employee.id, VISIT_START, visitor=_guest("Lina Later"))
    for created in (tracked, plain):
        assert check_in(reception, created["visit"]["id"]).status_code == 200
    tracked_id = tracked["visit"]["id"]
    enroll(reception, tracked_id, places.reception_camera)
    clock.advance(minutes=1)
    ref = association_of(db, tracked_id).ref
    post_events(client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="j1")])
    page = reception.get("/journeys")
    assert page.status_code == 200, page.text
    body = page.json()
    assert body["total"] == 2 and body["page"] == 1
    by_name = {item["visit"]["visitor"]["full_name"]: item for item in body["items"]}
    assert set(by_name) == {"Rania Tracked", "Omar Plain"}  # a visitor not yet inside is not listed
    assert expected["visit"]["id"] not in {item["visit"]["id"] for item in body["items"]}
    assert by_name["Rania Tracked"]["state"] == "ACTIVE" and by_name["Rania Tracked"]["simulated"] is True
    assert by_name["Rania Tracked"]["last_location"]["floor"]["level"] == 3
    # Freshness by the server's clock, as on the visit's journey (B15-27); null without a location.
    assert 0 <= by_name["Rania Tracked"]["freshness_seconds"] <= 2
    assert by_name["Omar Plain"]["freshness_seconds"] is None
    assert by_name["Omar Plain"]["state"] == "NOT_ENROLLED" and by_name["Omar Plain"]["last_location"] is None
    assert by_name["Omar Plain"]["visit"]["host"] == {
        "id": str(world.a.employee.id),
        "full_name": "Alpha Employee",
    }
    # Search by the visitor's name or company, and filter by state.
    assert [i["visit"]["id"] for i in reception.get("/journeys", params={"q": "globex"}).json()["items"]] == [
        plain["visit"]["id"]
    ]
    assert [i["visit"]["id"] for i in reception.get("/journeys", params={"q": "rania"}).json()["items"]] == [
        tracked_id
    ]
    active = reception.get("/journeys", params={"state": "ACTIVE,STALE"}).json()
    assert active["total"] == 1 and active["items"][0]["visit"]["id"] == tracked_id
    paged = reception.get("/journeys", params={"page_size": 1, "page": 2}).json()
    assert paged["total"] == 2 and len(paged["items"]) == 1
    paged_filtered = reception.get("/journeys", params={"state": "NOT_ENROLLED", "page_size": 1}).json()
    assert paged_filtered["total"] == 1 and paged_filtered["items"][0]["visit"]["id"] == plain["visit"]["id"]
    assert reception.get("/journeys", params={"state": "LOST"}).status_code == 422
    clock.advance(minutes=4)
    listed = next(i for i in reception.get("/journeys").json()["items"] if i["visit"]["id"] == tracked_id)
    detail = reception.get(f"/visits/{tracked_id}/journey").json()
    assert 240 <= listed["freshness_seconds"] <= 241
    assert abs(listed["freshness_seconds"] - detail["freshness_seconds"]) <= 1
    # A visit checked out today stays on today's list, ENDED.
    clock.advance(minutes=1)
    assert check_out(reception, tracked_id).status_code == 200
    item = next(i for i in reception.get("/journeys").json()["items"] if i["visit"]["id"] == tracked_id)
    assert item["state"] == "ENDED" and item["visit"]["status"] == "CHECKED_OUT"
    # The day before: nobody was inside.
    yesterday = (TEST_START - timedelta(days=1)).date().isoformat()
    assert reception.get("/journeys", params={"day": yesterday}).json()["total"] == 0


def test_journeys_are_disabled_while_tracking_is_off(host: Api, reception: Api, world: World) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    [item] = reception.get("/journeys").json()["items"]
    assert item["visit"]["id"] == visit_id and item["state"] == "DISABLED"
    journey = reception.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "DISABLED" and journey["association"] is None and journey["timeline"] == []
    assert journey["enroll_blocker"] == "PROVIDER_DISABLED" and journey["timeline_total"] == 0


def test_roles_and_tenants(make_client, host: Api, reception: Api, world: World) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    for user in (world.a.admin, world.a.manager, world.a.receptionist):
        api = signed_in(make_client, user)
        assert api.get("/journeys").status_code == 200
        assert api.get(f"/visits/{visit_id}/journey").status_code == 200
    # A host, even the visit's own, has no need for a visitor's movements (least privilege).
    for path in ("/journeys", f"/visits/{visit_id}/journey"):
        response = host.get(path)
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    other = signed_in(make_client, world.b.receptionist)
    assert other.get("/journeys").json()["items"] == []
    assert other.get(f"/visits/{visit_id}/journey").status_code == 404
    assert Api(make_client()).get("/journeys").status_code == 401


def test_opening_a_journey_is_audited_once_an_hour_per_user_and_visit(
    make_client, host: Api, reception: Api, world: World, db: Session, clock: FakeClock
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    for _ in range(3):
        assert reception.get(f"/visits/{visit_id}/journey").status_code == 200
    manager = signed_in(make_client, world.a.manager)
    manager.get(f"/visits/{visit_id}/journey")
    rows = audit_rows(db, "JOURNEY_VIEWED")
    assert [(row.actor_user_id, str(row.entity_id), row.entity_type) for row in rows] == [
        (world.a.receptionist.id, visit_id, "visit"),
        (world.a.manager.id, visit_id, "visit"),
    ]
    assert rows[0].meta == {}
    reception.get("/journeys")  # the list is not an opening of a journey
    clock.advance(minutes=61)
    reception = signed_in(make_client, world.a.receptionist)
    reception.get(f"/visits/{visit_id}/journey")
    assert len(audit_rows(db, "JOURNEY_VIEWED")) == 3


def test_a_list_that_shows_locations_is_audited_once_an_hour_per_user(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    db: Session,
    clock: FakeClock,
) -> None:
    """B15-31 (after the independent review): the list reveals where people were, so reading it leaves a
    trace too (JOURNEY_LIST_VIEWED), coalesced like opening a journey; a list that shows nobody's location
    reveals nothing and leaves none."""
    tracking_settings(db, world.a.company)
    key = tracking_key(db, world.a.company, world.a.admin)
    visit_id = inside_visit(host, reception, world.a.employee.id)
    assert reception.get("/journeys").status_code == 200  # nobody enrolled
    enroll(reception, visit_id, places.reception_camera)
    assert reception.get("/journeys").json()["items"][0]["last_location"] is None  # no observation yet
    assert audit_rows(db, "JOURNEY_LIST_VIEWED") == []
    clock.advance(minutes=1)
    ref = association_of(db, visit_id).ref
    post_events(client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="la-1")])
    for _ in range(3):
        assert reception.get("/journeys").json()["items"][0]["last_location"] is not None
    manager = signed_in(make_client, world.a.manager)
    assert manager.get("/journeys", params={"state": "ACTIVE"}).json()["total"] == 1  # the filtered path
    rows = audit_rows(db, "JOURNEY_LIST_VIEWED")
    assert [(row.actor_user_id, row.entity_type, str(row.entity_id)) for row in rows] == [
        (world.a.receptionist.id, "company", str(world.a.company.id)),
        (world.a.manager.id, "company", str(world.a.company.id)),
    ]
    assert rows[0].meta == {"day": "2026-10-05", "located": 1}
    assert audit_rows(db, "JOURNEY_VIEWED") == []  # opening a journey is audited apart
    clock.advance(minutes=61)
    reception = signed_in(make_client, world.a.receptionist)
    assert (
        reception.get("/journeys").json()["items"][0]["last_location"] is not None
    )  # an hour old, still shown
    assert len(audit_rows(db, "JOURNEY_LIST_VIEWED")) == 3
