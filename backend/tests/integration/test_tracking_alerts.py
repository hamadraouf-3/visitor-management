"""Area alerts (Phase 16, B16-4 to B16-15): raised from the journey's own confirmed location when an ingested
batch stores a confirmed observation; opened, moved on, escalated and resolved by the rule; resolved by a
check-out, by a change of the visit's allowed areas and by reception; never raised from what the journey
itself would not show; e-mailed on an opening and an escalation only, after the commit, within the
company's and the visit's budgets; never opened or escalated by a host's change of the areas (B16-25); read,
summarised and acted on by the right roles of the right company only."""

import logging
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import EmailMessage, TrackingAlert
from app.repositories.tracking import TrackingHealthRepository
from tests.support import (
    Api,
    World,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    error_code,
    rate_limits,
    signed_in,
)
from tests.tracking_support import (
    VISIT_START,
    AreaRegistry,
    RecordingProvider,
    area_registry,
    areas,
    association_of,
    disabled,
    enroll,
    observed,
    post_events,
    sees,
    tracking_key,
    tracking_settings,
    using_provider,
)

ALERT = "TRACKING_ALERT"


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


@pytest.fixture
def manager(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.manager)


@pytest.fixture
def places(db: Session, world: World) -> AreaRegistry:
    return area_registry(db, world.a.company)


@pytest.fixture
def provider(app: FastAPI) -> RecordingProvider:
    with using_provider(app, RecordingProvider()) as recording:
        assert isinstance(recording, RecordingProvider)
        yield recording


@pytest.fixture
def key(db: Session, world: World) -> str:
    tracking_settings(db, world.a.company)
    return tracking_key(db, world.a.company, world.a.admin)


def tracked_visit(
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    db: Session,
    *,
    access: dict[str, list[str]] | None = None,
) -> tuple[str, str]:
    """A visit allowed on the second floor (or on `access`), checked in and enrolled: (its ID, its ref)."""
    body = {"access_areas": access if access is not None else areas(floors=(places.second,))}
    created = create_visit(host, world.a.employee.id, VISIT_START, **body)
    visit_id = created["visit"]["id"]
    assert check_in(reception, visit_id).status_code == 200
    assert enroll(reception, visit_id, places.reception_camera).json()["association"]["status"] == "ACTIVE"
    return visit_id, association_of(db, visit_id).ref


def alerts_of(db: Session, visit_id: str) -> list[TrackingAlert]:
    db.expire_all()
    return list(
        db.scalars(
            select(TrackingAlert)
            .where(TrackingAlert.visit_id == UUID(visit_id))
            .order_by(TrackingAlert.created_at)
        )
    )


def alert_emails(email_provider: MemoryProvider) -> list[Any]:
    return [email for email in email_provider.sent if email.kind == ALERT]


def journey(api: Api, visit_id: str) -> dict[str, Any]:
    response = api.get(f"/visits/{visit_id}/journey")
    assert response.status_code == 200, response.text
    return response.json()


def instant(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def escalations(api: Api) -> tuple[list[datetime | None], list[datetime | None]]:
    """Each `escalated_at` the summary's `latest` and the active alerts list answer, as instants (B16-26)."""
    summary = api.get("/tracking/alerts/summary", headers={"X-Background-Refresh": "1"})
    listed = api.get("/tracking/alerts")
    assert summary.status_code == 200 and listed.status_code == 200
    return (
        [instant(item["escalated_at"]) for item in summary.json()["latest"]],
        [instant(item["escalated_at"]) for item in listed.json()["items"]],
    )


# ---- the rule, through ingestion -------------------------------------------------------------------------


def test_another_floor_opens_an_alert_that_moves_on_and_returning_resolves_it(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    first_seen = clock.peek()
    assert sees(client, key, ref, places.office_camera, first_seen, event_id="o-1") == [
        ("accepted", None),
        ("accepted", None),
    ]
    [alert] = alerts_of(db, visit_id)
    assert (alert.type, alert.status, alert.observations) == ("UNAUTHORIZED_AREA", "OPEN", 1)
    assert alert.opened_at == alert.last_seen_at == first_seen
    assert alert.first_zone_id == alert.last_zone_id == places.office.id
    assert alert.simulated is True  # the simulator's association
    [opened] = audit_rows(db, "TRACKING_ALERT_OPENED")
    assert opened.actor_user_id is None and opened.entity_id == UUID(visit_id)
    assert opened.meta == {
        "alert_id": str(alert.id),
        "type": "UNAUTHORIZED_AREA",
        "building_id": str(places.building.id),
        "floor_id": str(places.fourth.id),
        "zone_id": str(places.office.id),
        "simulated": True,
        "trigger": "OBSERVATION",
        "notified": 1,  # the host (no alert addresses yet)
        "notice_limited_by": None,
    }
    assert len(alert_emails(email_provider)) == 1

    # Seen again in the same zone: the alert moves on, without a new row, audit or e-mail.
    clock.advance(seconds=30)
    second_seen = clock.peek()
    sees(client, key, ref, places.office_camera, second_seen, event_id="o-2")
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.observations, alert.last_seen_at) == ("OPEN", 2, second_seen)
    assert alert.opened_at == first_seen
    assert len(audit_rows(db, "TRACKING_ALERT_OPENED")) == 1 and len(alert_emails(email_provider)) == 1

    # The journey shows it, as the list does.
    shown = journey(reception, visit_id)
    assert [item["id"] for item in shown["alerts"]] == [str(alert.id)]
    assert shown["alerts"][0]["last_location"]["zone"] == {
        "id": str(places.office.id),
        "name": "Open office",
        "name_ar": "المكاتب",
        "access": "STANDARD",
    }
    listed = reception.get("/journeys").json()["items"]
    assert listed[0]["alert"] == {"id": str(alert.id), "type": "UNAUTHORIZED_AREA", "status": "OPEN"}

    # Back on an allowed floor, more than the conflict window later: resolved, by the system.
    clock.advance(minutes=2)
    sees(client, key, ref, places.second_camera, clock.peek(), event_id="s-1")
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.resolution, alert.resolved_by_id) == ("RESOLVED", "RETURNED", None)
    [resolved] = audit_rows(db, "TRACKING_ALERT_RESOLVED")
    assert resolved.actor_user_id is None
    assert resolved.meta == {"alert_id": str(alert.id), "resolution": "RETURNED", "noted": False}
    assert journey(reception, visit_id)["alerts"][0]["resolved_by"] is None


def test_a_restricted_zone_escalates_the_alert_and_e_mails_again(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    opened = clock.peek()
    sees(client, key, ref, places.office_camera, opened, event_id="o-1")
    [alert] = alerts_of(db, visit_id)
    assert alert.escalated_at is None  # an opening is no escalation (B16-26)
    # The answers name it too: null in the summary's brief and in the alerts list.
    assert escalations(reception) == ([None], [None])
    acknowledged = reception.post(f"/tracking/alerts/{alert.id}/acknowledge", json={"note": "On my way"})
    assert acknowledged.status_code == 200 and acknowledged.json()["status"] == "ACKNOWLEDGED"
    assert acknowledged.json()["escalated_at"] is None
    # The same floor, so no conflict: the server room.
    clock.advance(seconds=20)
    seen = clock.peek()
    sees(client, key, ref, places.server_camera, seen, event_id="srv-1")
    answered = clock.peek()
    [alert] = alerts_of(db, visit_id)
    assert (alert.type, alert.status, alert.acknowledged_at, alert.acknowledged_by_id) == (
        "RESTRICTED_AREA",
        "OPEN",
        None,
        None,
    )
    assert alert.first_zone_id == places.office.id and alert.last_zone_id == places.server.id
    assert (alert.observations, alert.last_seen_at, alert.note) == (2, seen, "On my way")
    # When it escalated: the server's time, during the batch (B16-26). Its opening stays the first
    # violating observation's.
    escalated_at = alert.escalated_at
    assert alert.opened_at == opened and escalated_at is not None and seen <= escalated_at < answered
    # Open again: the summary's brief, the alerts list and the journey's alert name it.
    assert escalations(reception) == ([escalated_at], [escalated_at])
    assert instant(journey(reception, visit_id)["alerts"][0]["escalated_at"]) == escalated_at
    [escalated] = audit_rows(db, "TRACKING_ALERT_ESCALATED")
    assert escalated.actor_user_id is None
    assert escalated.meta["from_type"] == "UNAUTHORIZED_AREA" and escalated.meta["type"] == "RESTRICTED_AREA"
    assert escalated.meta["zone_id"] == str(places.server.id) and escalated.meta["notified"] == 1
    sent = alert_emails(email_provider)
    assert len(sent) == 2 and "restricted area" in sent[1].subject
    # Back to the office: still a violation (UNAUTHORIZED), but an alert never backs down.
    clock.advance(seconds=20)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-2")
    [alert] = alerts_of(db, visit_id)
    assert (alert.type, alert.status, alert.observations) == ("RESTRICTED_AREA", "OPEN", 3)
    assert alert.escalated_at == escalated_at  # escalated once: a later observation leaves it
    assert escalations(reception) == ([escalated_at], [escalated_at])
    assert len(alert_emails(email_provider)) == 2


def test_with_no_areas_set_only_restricted_zones_alert_and_common_zones_never(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db, access=areas())
    assert journey(reception, visit_id)["access_areas"] == {"floors": [], "zones": []}
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    clock.advance(minutes=2)
    sees(client, key, ref, places.lobby_camera, clock.peek(), event_id="l-1")
    assert alerts_of(db, visit_id) == []
    clock.advance(minutes=2)
    sees(client, key, ref, places.server_camera, clock.peek(), event_id="srv-1")
    [alert] = alerts_of(db, visit_id)
    assert (alert.type, alert.status) == ("RESTRICTED_AREA", "OPEN")
    # A COMMON zone allows everyone: the restricted alert resolves there.
    clock.advance(minutes=2)
    sees(client, key, ref, places.lobby_camera, clock.peek(), event_id="l-2")
    assert alerts_of(db, visit_id)[0].resolution == "RETURNED"


def test_a_listed_zone_is_allowed_whatever_its_level_or_floor(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(
        host, reception, world, places, db, access=areas(floors=(places.second,), zones=(places.server,))
    )
    clock.advance(minutes=1)
    sees(client, key, ref, places.server_camera, clock.peek(), event_id="srv-1")
    assert alerts_of(db, visit_id) == []
    # The office beside it is not listed, and its floor is not allowed.
    clock.advance(seconds=20)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert [alert.type for alert in alerts_of(db, visit_id)] == ["UNAUTHORIZED_AREA"]


def test_a_batch_after_the_provider_s_silence_is_its_contact_and_alerts(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """The journey an alert reads is the one the API shows once the batch commits: a batch that ends more
    than 5 minutes of silence is the provider's contact, so the journey is ACTIVE, not UNAVAILABLE (found
    while testing `simulate-journey --cameras`: the contact used to be recorded after the evaluation)."""
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=10)
    response = post_events(client, key, [observed(ref, places.office_camera, clock.peek(), event_id="o-1")])
    assert [item["result"] for item in response.json()["results"]] == ["accepted"]
    assert journey(reception, visit_id)["state"] == "ACTIVE"
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["OPEN"]


# ---- what never alerts ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case",
    ["uncertain", "below threshold", "no confidence", "null threshold", "alerts off", "tracking off"],
)
def test_nothing_unconfirmed_or_switched_off_alerts(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    case: str,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    match, confidence = "CONFIRMED", 0.93
    if case == "uncertain":
        match = "UNCERTAIN"
    elif case == "below threshold":
        confidence = 0.5
    elif case == "no confidence":
        confidence = None
    elif case == "null threshold":
        tracking_settings(db, world.a.company, min_confidence=None)
    elif case == "alerts off":
        settings = tracking_settings(db, world.a.company)
        settings.area_alerts_enabled = False
        db.commit()
    elif case == "tracking off":
        tracking_settings(db, world.a.company, enabled=False)
    clock.advance(minutes=1)
    outcomes = sees(
        client,
        key,
        ref,
        places.office_camera,
        clock.peek(),
        event_id="o-1",
        match=match,
        confidence=confidence,
    )
    expected = "rejected" if case == "tracking off" else "accepted"
    assert outcomes[1][0] == expected
    assert alerts_of(db, visit_id) == []
    assert audit_rows(db, "TRACKING_ALERT_OPENED") == []


def test_alerts_off_leaves_an_active_alert_as_it_is(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    settings = tracking_settings(db, world.a.company)
    settings.area_alerts_enabled = False
    db.commit()
    clock.advance(minutes=2)
    sees(client, key, ref, places.second_camera, clock.peek(), event_id="s-1")
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.observations) == ("OPEN", 1)


def test_two_floors_within_the_conflict_window_alert_nothing(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """B15-30: two confirmed floors within 60 s answer no location, so there is nothing to alert on."""
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.second_camera, clock.peek(), event_id="s-1")
    clock.advance(seconds=30)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert journey(reception, visit_id)["state"] == "UNCERTAIN"
    assert alerts_of(db, visit_id) == []
    # Seen there again once the window has passed: now the journey places the visitor, and it alerts.
    clock.advance(seconds=90)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-2")
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["OPEN"]


def test_a_late_old_event_never_opens_or_resolves_anything(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    early = clock.peek()
    clock.advance(minutes=3)
    sees(client, key, ref, places.second_camera, clock.peek(), event_id="s-1")
    # Observed on the fourth floor three minutes earlier, arriving now: history only.
    sees(client, key, ref, places.office_camera, early, event_id="o-old")
    assert alerts_of(db, visit_id) == []
    # And the other way round: an open alert is not resolved by an old allowed sighting.
    clock.advance(minutes=2)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    sees(client, key, ref, places.second_camera, early + timedelta(seconds=30), event_id="s-old")
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.observations) == ("OPEN", 1)


def test_a_late_sighting_of_an_ended_association_never_alerts(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    before = clock.peek()
    clock.advance(minutes=1)
    assert reception.post(f"/visits/{visit_id}/tracking/revoke").status_code == 200
    # Observed before the revoke, arriving after it: appended to history, never alerted on.
    assert sees(client, key, ref, places.office_camera, before, event_id="late-1")[1] == ("accepted", None)
    assert alerts_of(db, visit_id) == []


def test_a_revoke_or_tracking_switched_off_leaves_the_alert(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert reception.post(f"/visits/{visit_id}/tracking/revoke").status_code == 200
    admin = signed_in(make_client, world.a.admin)
    assert admin.patch("/tracking/settings", json={"enabled": False}).status_code == 200
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["OPEN"]


# ---- other ends ---------------------------------------------------------------------------------------


def test_the_check_out_resolves_the_alert_in_its_transaction(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert check_out(reception, visit_id).status_code == 200
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.resolution, alert.resolved_by_id) == (
        "RESOLVED",
        "CHECKED_OUT",
        world.a.receptionist.id,
    )
    [resolved] = audit_rows(db, "TRACKING_ALERT_RESOLVED")
    assert resolved.actor_user_id == world.a.receptionist.id and resolved.meta["resolution"] == "CHECKED_OUT"


def test_changing_the_areas_resolves_the_alert_or_opens_one(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    seen = clock.peek()
    sees(client, key, ref, places.office_camera, seen, event_id="o-1")
    allowed = reception.put(
        f"/visits/{visit_id}/access-areas", json=areas(floors=(places.second, places.fourth))
    )
    assert allowed.status_code == 200, allowed.text
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.resolution, alert.resolved_by_id) == (
        "RESOLVED",
        "AREAS_CHANGED",
        world.a.receptionist.id,
    )
    # Taken away again by reception: the current location violates the areas again, so a new alert opens,
    # by the editor (a receptionist or an administrator; a host's change never opens one, B16-25).
    again = reception.put(f"/visits/{visit_id}/access-areas", json=areas(floors=(places.second,)))
    assert again.status_code == 200, again.text
    first, second = alerts_of(db, visit_id)
    assert first.status == "RESOLVED" and (second.status, second.type) == ("OPEN", "UNAUTHORIZED_AREA")
    assert second.opened_at == seen and second.observations == 1
    [_, reopened] = audit_rows(db, "TRACKING_ALERT_OPENED")
    assert reopened.actor_user_id == world.a.receptionist.id and reopened.meta["trigger"] == "AREAS_CHANGED"
    assert len(alert_emails(email_provider)) == 2  # the first opening and this one


def test_a_host_s_change_of_the_areas_resolves_but_never_raises_an_alert(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    """B16-25 (found in review): the visit's host may change its areas, and so resolve its alert, but the
    host's change never opens or escalates one, nor e-mails anyone. Toggling the areas would otherwise tell
    the host where the visitor is, and e-mail every alert address, on demand. The next confirmed observation
    opens it, as after a change of a zone's level (B16-1)."""
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    [alert] = alerts_of(db, visit_id)
    assert (alert.type, alert.status) == ("UNAUTHORIZED_AREA", "OPEN")
    assert len(alert_emails(email_provider)) == 1
    # The office becomes restricted. The host's change that still leaves the visitor outside the areas does
    # not escalate the alert (a receptionist's would).
    admin = signed_in(make_client, world.a.admin)
    restricted = admin.patch(f"/locations/zones/{places.office.id}", json={"access": "RESTRICTED"})
    assert restricted.status_code == 200, restricted.text
    changed = host.put(
        f"/visits/{visit_id}/access-areas", json=areas(floors=(places.second,), zones=(places.meeting,))
    )
    assert changed.status_code == 200, changed.text
    [alert] = alerts_of(db, visit_id)
    assert (alert.type, alert.status) == ("UNAUTHORIZED_AREA", "OPEN")
    assert audit_rows(db, "TRACKING_ALERT_ESCALATED") == []
    # Allowing the office resolves it, by the host.
    allowed = host.put(
        f"/visits/{visit_id}/access-areas", json=areas(floors=(places.second,), zones=(places.office,))
    )
    assert allowed.status_code == 200, allowed.text
    [alert] = alerts_of(db, visit_id)
    assert (alert.status, alert.resolution, alert.resolved_by_id) == (
        "RESOLVED",
        "AREAS_CHANGED",
        world.a.employee.id,
    )
    # Taking it away, giving it back, taking it away again: nothing opens, nobody is e-mailed.
    for body in (
        areas(floors=(places.second,)),
        areas(zones=(places.office,)),
        areas(floors=(places.second,)),
    ):
        toggled = host.put(f"/visits/{visit_id}/access-areas", json=body)
        assert toggled.status_code == 200, toggled.text
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["RESOLVED"]
    assert len(audit_rows(db, "TRACKING_ALERT_OPENED")) == 1
    assert len(audit_rows(db, "VISIT_ACCESS_AREAS_CHANGED")) == 5
    assert len(alert_emails(email_provider)) == 1
    # The next confirmed observation there opens it, by the system: a restricted area now.
    clock.advance(seconds=30)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-2")
    first, second = alerts_of(db, visit_id)
    assert first.status == "RESOLVED" and (second.type, second.status) == ("RESTRICTED_AREA", "OPEN")
    reopened = audit_rows(db, "TRACKING_ALERT_OPENED")[-1]
    assert reopened.actor_user_id is None and reopened.meta["trigger"] == "OBSERVATION"
    assert len(alert_emails(email_provider)) == 2


def test_an_areas_change_with_alerts_off_or_without_a_location_changes_no_alert(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db, access=areas())
    # No confirmed location yet: nothing to evaluate.
    assert (
        reception.put(f"/visits/{visit_id}/access-areas", json=areas(zones=(places.meeting,))).status_code
        == 200
    )
    assert alerts_of(db, visit_id) == []
    # With the areas set to the meeting rooms, the office opens an alert; with area alerts off, allowing the
    # office leaves it as it is, and taking every area away again opens nothing either.
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["OPEN"]
    settings = tracking_settings(db, world.a.company)
    settings.area_alerts_enabled = False
    db.commit()
    assert (
        reception.put(f"/visits/{visit_id}/access-areas", json=areas(zones=(places.office,))).status_code
        == 200
    )
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["OPEN"]
    assert audit_rows(db, "TRACKING_ALERT_RESOLVED") == []


def test_without_a_provider_an_areas_change_raises_nothing(
    app: FastAPI,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """With the deployment's provider `disabled`, every journey is DISABLED, so no location exists to judge:
    taking the visit's areas away from where it was last seen opens nothing."""
    visit_id, ref = tracked_visit(host, reception, world, places, db, access=areas(floors=(places.fourth,)))
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert alerts_of(db, visit_id) == []
    with using_provider(app, disabled()):
        changed = reception.put(f"/visits/{visit_id}/access-areas", json=areas(floors=(places.second,)))
        assert changed.status_code == 200
        assert reception.get(f"/visits/{visit_id}/journey").json()["state"] == "DISABLED"
    assert alerts_of(db, visit_id) == []


# ---- reception and administrators -------------------------------------------------------------------


def test_acknowledge_and_resolve_by_reception(
    client: TestClient,
    host: Api,
    reception: Api,
    manager: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    [alert] = alerts_of(db, visit_id)
    path = f"/tracking/alerts/{alert.id}"
    # Management reads, and does not act; a host who is only an employee does neither.
    assert manager.get("/tracking/alerts").status_code == 200
    assert manager.post(f"{path}/acknowledge").status_code == 403
    assert manager.post(f"{path}/resolve").status_code == 403
    assert host.get("/tracking/alerts").status_code == 403
    assert host.get("/tracking/alerts/summary").status_code == 403
    assert manager.get("/tracking/alerts").json()["items"][0]["can_act"] is False
    # A note is one line of at most 300 characters.
    for note, code in (("x" * 301, "too_long"), ("two\nlines", "line_breaks")):
        refused = reception.post(f"{path}/acknowledge", json={"note": note})
        assert (
            refused.status_code == 422
            and refused.json()["error"]["details"]["field_codes"]["note"]["code"] == code
        )
    acknowledged = reception.post(f"{path}/acknowledge", json={"note": "Escorting back"})
    assert acknowledged.status_code == 200
    body = acknowledged.json()
    assert (body["status"], body["note"], body["can_act"]) == ("ACKNOWLEDGED", "Escorting back", True)
    assert body["acknowledged_by"] == {"id": str(world.a.receptionist.id), "full_name": "Alpha Reception"}
    # Again: unchanged, nothing audited.
    again = reception.post(f"{path}/acknowledge", json={"note": "ignored"})
    assert again.status_code == 200 and again.json()["note"] == "Escorting back"
    assert len(audit_rows(db, "TRACKING_ALERT_ACKNOWLEDGED")) == 1
    resolved = reception.post(f"{path}/resolve", json={"note": "Back at reception"})
    assert resolved.status_code == 200
    body = resolved.json()
    assert (body["status"], body["resolution"], body["note"], body["can_act"]) == (
        "RESOLVED",
        "MANUAL",
        "Back at reception",
        False,
    )
    assert body["resolved_by"]["id"] == str(world.a.receptionist.id)
    assert reception.post(f"{path}/resolve").status_code == 200  # idempotent, no body needed
    assert len(audit_rows(db, "TRACKING_ALERT_RESOLVED")) == 1
    late = reception.post(f"{path}/acknowledge")
    assert late.status_code == 409 and error_code(late) == "ALERT_RESOLVED"
    [row] = audit_rows(db, "TRACKING_ALERT_RESOLVED")
    assert row.actor_user_id == world.a.receptionist.id
    assert row.meta == {"alert_id": str(alert.id), "resolution": "MANUAL", "noted": True}
    # A resolved alert is not in the active list any more, but in the day's.
    assert reception.get("/tracking/alerts").json()["total"] == 0
    assert reception.get("/tracking/alerts", params={"scope": "day"}).json()["total"] == 1
    # After a manual resolve, the next violating observation opens a new alert.
    clock.advance(seconds=30)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-2")
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["RESOLVED", "OPEN"]


def test_unknown_and_other_companies_alerts_are_not_found(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    [alert] = alerts_of(db, visit_id)
    other = signed_in(make_client, world.b.receptionist)
    for action in ("acknowledge", "resolve"):
        assert other.post(f"/tracking/alerts/{alert.id}/{action}").status_code == 404
        unknown = reception.post(f"/tracking/alerts/{UUID(int=7)}/{action}")
        assert unknown.status_code == 404
    tracking_settings(db, world.b.company)
    assert other.get("/tracking/alerts").json() == {"items": [], "page": 1, "page_size": 25, "total": 0}
    summary = other.get("/tracking/alerts/summary").json()
    assert summary == {"open": 0, "active": 0, "latest": []}
    # Another company's visit as a filter is answered like an unknown one.
    foreign = other.get("/tracking/alerts", params={"visit_id": visit_id})
    assert foreign.status_code == 422
    assert foreign.json()["error"]["details"]["field_codes"]["visit_id"]["code"] == "not_found"
    assert [item["id"] for item in other.get("/journeys/live").json()["visitors"]] == []
    assert reception.get("/tracking/alerts", params={"visit_id": visit_id}).json()["total"] == 1
    assert alerts_of(db, visit_id)[0].status == "OPEN"


# ---- reads ---------------------------------------------------------------------------------------------


def test_the_list_and_the_summary(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    first_id, first_ref = tracked_visit(host, reception, world, places, db)
    second_id, second_ref = tracked_visit(signed_in(make_client, world.a.admin), reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, first_ref, places.office_camera, clock.peek(), event_id="a-1")
    clock.advance(seconds=1)
    sees(client, key, second_ref, places.server_camera, clock.peek(), event_id="b-1")
    first, second = alerts_of(db, first_id)[0], alerts_of(db, second_id)[0]
    assert reception.post(f"/tracking/alerts/{first.id}/acknowledge").status_code == 200
    summary = reception.get("/tracking/alerts/summary", headers={"X-Background-Refresh": "1"})
    assert summary.status_code == 200
    body = summary.json()
    assert (body["open"], body["active"]) == (1, 2)
    assert body["latest"] == [
        {
            "id": str(second.id),
            "type": "RESTRICTED_AREA",
            "visit_id": second_id,
            "visitor_name": "Dana Guest",
            "location": body["latest"][0]["location"],
            "opened_at": body["latest"][0]["opened_at"],
            "escalated_at": None,  # opened as RESTRICTED_AREA: never escalated (B16-26)
            "simulated": True,
        }
    ]
    assert body["latest"][0]["location"]["zone"]["access"] == "RESTRICTED"
    listed = reception.get("/tracking/alerts").json()
    assert [item["id"] for item in listed["items"]] == [str(second.id), str(first.id)]  # newest first
    assert [item["escalated_at"] for item in listed["items"]] == [None, None]
    item = listed["items"][1]
    assert item["visit"]["id"] == first_id and item["access_areas"]["floors"][0]["id"] == str(
        places.second.id
    )
    assert item["first_location"]["floor"]["level"] == 4 and item["observations"] == 1
    assert reception.get("/tracking/alerts", params={"visit_id": first_id}).json()["total"] == 1
    paged = reception.get("/tracking/alerts", params={"page_size": 1, "page": 2}).json()
    assert paged["total"] == 2 and [item["id"] for item in paged["items"]] == [str(first.id)]
    day = reception.get("/tracking/alerts", params={"scope": "day", "day": "2026-10-04"})
    assert day.json()["total"] == 0
    today = reception.get("/tracking/alerts", params={"scope": "day", "day": "2026-10-05"})
    assert today.json()["total"] == 2
    refused = reception.get("/tracking/alerts", params={"day": "2026-10-05"})
    assert refused.status_code == 422
    assert refused.json()["error"]["details"]["field_codes"]["day"]["code"] == "not_allowed"
    assert reception.get("/tracking/alerts", params={"scope": "week"}).status_code == 422


def test_an_escalation_comes_first_in_the_summary_whatever_its_opening(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """B16-26 (the open item of F16-38): an escalation keeps the alert's `opened_at`, so with five newer
    alerts open an escalated one stayed out of the summary's five and the shell never told of it. The
    summary now names the newest opened or escalated first: six open, the oldest escalates, it comes
    first. Its brief keeps its own `opened_at` and names its `escalated_at`, the order's key the shell's
    watcher compares with (null on every brief before)."""
    visits = [tracked_visit(host, reception, world, places, db) for _ in range(6)]
    clock.advance(minutes=1)
    for index, (_visit_id, ref) in enumerate(visits):
        clock.advance(seconds=1)
        sees(client, key, ref, places.office_camera, clock.peek(), event_id=f"o-{index}")
    alerts = [alerts_of(db, visit_id)[0] for visit_id, _ref in visits]
    assert [alert.escalated_at for alert in alerts] == [None] * 6

    def latest() -> list[dict[str, Any]]:
        response = reception.get("/tracking/alerts/summary", headers={"X-Background-Refresh": "1"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["open"], body["active"]) == (6, 6)
        return list(body["latest"])

    def named(items: list[dict[str, Any]]) -> list[tuple[str, str]]:
        return [(item["id"], item["type"]) for item in items]

    # The five newest openings; the oldest is left out.
    items = latest()
    assert named(items) == [(str(alert.id), "UNAUTHORIZED_AREA") for alert in reversed(alerts[1:])]
    assert [item["escalated_at"] for item in items] == [None] * 5
    # The oldest escalates (the server room is on the office's floor: no conflict).
    clock.advance(seconds=20)
    seen = clock.peek()
    oldest_visit, oldest_ref = visits[0]
    sees(client, key, oldest_ref, places.server_camera, seen, event_id="srv-0")
    answered = clock.peek()
    [oldest] = alerts_of(db, oldest_visit)
    assert (oldest.type, oldest.status) == ("RESTRICTED_AREA", "OPEN")
    assert oldest.escalated_at is not None and seen <= oldest.escalated_at < answered
    assert oldest.opened_at < min(alert.opened_at for alert in alerts[1:])
    items = latest()
    assert named(items) == [(str(oldest.id), "RESTRICTED_AREA")] + [
        (str(alert.id), "UNAUTHORIZED_AREA") for alert in reversed(alerts[2:])
    ]
    assert set(items[0]) == {
        "id",
        "type",
        "visit_id",
        "visitor_name",
        "location",
        "opened_at",
        "escalated_at",
        "simulated",
    }
    assert datetime.fromisoformat(items[0]["opened_at"]) == oldest.opened_at
    assert instant(items[0]["escalated_at"]) == oldest.escalated_at
    assert [item["escalated_at"] for item in items[1:]] == [None] * 4
    assert items[0]["location"]["zone"]["id"] == str(places.server.id)


def test_the_summary_is_empty_while_tracking_is_not_allowed_or_there_is_no_provider(
    app: FastAPI,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    _visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert reception.get("/tracking/alerts/summary").json()["open"] == 1
    with using_provider(app, disabled()):
        assert reception.get("/tracking/alerts/summary").json() == {"open": 0, "active": 0, "latest": []}
    tracking_settings(db, world.a.company, allowed=False, enabled=False)
    assert reception.get("/tracking/alerts/summary").json() == {"open": 0, "active": 0, "latest": []}


def test_the_summary_poll_does_not_extend_the_session(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """The shell polls with `X-Background-Refresh: 1`, which never counts as the person's activity (the
    `/auth/me` heartbeat's rule): the session's `last_seen_at` stays."""
    from app.models import UserSession

    def last_seen() -> Any:
        db.expire_all()
        return db.scalars(
            select(UserSession.last_seen_at).where(UserSession.user_id == world.a.receptionist.id)
        ).one()

    before = last_seen()
    clock.advance(minutes=5)
    assert reception.get("/tracking/alerts/summary", headers={"X-Background-Refresh": "1"}).status_code == 200
    assert last_seen() == before
    reception.get("/tracking/alerts/summary")
    assert last_seen() > before


# ---- e-mails -------------------------------------------------------------------------------------------


def test_who_gets_the_e_mails_in_which_language_with_which_link(
    make_client,
    client: TestClient,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
    factory,
) -> None:
    arabic_host = factory.user(world.a.company, full_name="Huda Host", preferred_language="ar")
    admin = signed_in(make_client, world.a.admin)
    settings = admin.patch(
        "/tracking/settings",
        json={"alert_emails": ["Security@Example.com", "security@example.com", arabic_host.email.upper()]},
    )
    assert settings.status_code == 200 and settings.json()["alert_emails"] == [
        "security@example.com",
        arabic_host.email,
    ]
    created = create_visit(admin, arabic_host.id, VISIT_START, access_areas=areas(floors=(places.second,)))
    visit_id = created["visit"]["id"]
    assert check_in(reception, visit_id).status_code == 200
    enroll(reception, visit_id, places.reception_camera)
    ref = association_of(db, visit_id).ref
    email_provider.clear()
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    sent = {email.to: email for email in alert_emails(email_provider)}
    # The host is also an alert address: one e-mail, the alert addresses' (with the journey link).
    assert sorted(sent) == sorted(["security@example.com", arabic_host.email])
    security = sent["security@example.com"]
    assert security.subject == "[Simulated] Tracking alert: Dana Guest is outside the allowed areas"
    assert f"/journey/{visit_id}?c={world.a.company.slug}" in security.text
    # The host's copy as an alert address is the company's language (English), not the host's own (Arabic).
    as_address = sent[arabic_host.email]
    assert as_address.subject == security.subject
    assert "Tower \u203a Fourth \u203a Open office" in as_address.text
    assert f"/journey/{visit_id}?c={world.a.company.slug}" in as_address.text
    assert "Tower \u203a Fourth \u203a Open office" in security.text
    assert "Second" in security.text  # the allowed floors
    # Nothing that opens a pass, names the provider's reference or a key.
    for email in sent.values():
        for secret in (ref, key, "/pass", "#token"):
            assert secret not in email.text and secret not in email.html
    # Without the host among the alert addresses: the host gets the visit's page, in the host's language.
    admin.patch("/tracking/settings", json={"alert_emails": ["security@example.com"]})
    email_provider.clear()
    clock.advance(minutes=2)
    sees(client, key, ref, places.second_camera, clock.peek(), event_id="s-1")  # resolved
    clock.advance(minutes=2)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-2")  # a new alert
    sent = {email.to: email for email in alert_emails(email_provider)}
    assert sorted(sent) == sorted(["security@example.com", arabic_host.email])
    host_email = sent[arabic_host.email]
    assert host_email.subject == "[محاكاة] تنبيه تتبّع: Dana Guest خارج المناطق المسموحة"
    assert f"/visits/{visit_id}?c={world.a.company.slug}" in host_email.text
    assert "/journey/" not in host_email.text and "/journey/" not in host_email.html
    assert "البرج \u203a الرابع \u203a المكاتب" in host_email.text  # the Arabic names lead
    rows = db.scalars(
        select(EmailMessage).where(EmailMessage.kind == ALERT).order_by(EmailMessage.created_at)
    ).all()
    # As an alert address the first time (no account), as the host the second time (the account).
    assert [row.recipient_user_id for row in rows if row.to_email == arabic_host.email] == [
        None,
        arabic_host.id,
    ]
    assert {row.status for row in rows} == {"SENT"} and {row.visit_id for row in rows} == {UUID(visit_id)}


def test_an_alert_address_reads_the_company_s_language(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    """The alert addresses get the company's language (B16-14): Arabic for a company whose default is Arabic,
    the Arabic names of the place leading."""
    world.a.company.default_language = "ar"
    db.commit()
    admin = signed_in(make_client, world.a.admin)
    settings = admin.patch(
        "/tracking/settings", json={"alert_emails": ["security@example.com"], "alert_notify_host": False}
    )
    assert settings.status_code == 200, settings.text
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    email_provider.clear()
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    [security] = alert_emails(email_provider)
    assert security.to == "security@example.com"
    assert security.subject == "[محاكاة] تنبيه تتبّع: Dana Guest خارج المناطق المسموحة"
    assert "البرج \u203a الرابع \u203a المكاتب" in security.text
    assert f"/journey/{visit_id}?c={world.a.company.slug}" in security.text


def test_no_host_e_mail_when_the_company_says_so_and_none_for_an_inactive_host(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    admin = signed_in(make_client, world.a.admin)
    assert admin.patch("/tracking/settings", json={"alert_notify_host": False}).status_code == 200
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    assert alert_emails(email_provider) == []
    [opened] = audit_rows(db, "TRACKING_ALERT_OPENED")
    assert opened.meta["notified"] == 0 and alerts_of(db, visit_id)[0].status == "OPEN"
    # The company tells hosts again, but this host's account is deactivated (the visit inside stays): a new
    # opening goes to the alert address only, and its audit row counts that one e-mail.
    settings = admin.patch(
        "/tracking/settings", json={"alert_notify_host": True, "alert_emails": ["security@example.com"]}
    )
    assert settings.status_code == 200, settings.text
    deactivated = admin.patch(f"/users/{world.a.employee.id}", json={"is_active": False})
    assert deactivated.status_code == 200, deactivated.text
    clock.advance(minutes=2)
    sees(client, key, ref, places.second_camera, clock.peek(), event_id="s-1")  # resolved: RETURNED
    clock.advance(minutes=2)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-2")  # a new opening
    assert [alert.status for alert in alerts_of(db, visit_id)] == ["RESOLVED", "OPEN"]
    assert [email.to for email in alert_emails(email_provider)] == ["security@example.com"]
    reopened = audit_rows(db, "TRACKING_ALERT_OPENED")[-1]
    assert (reopened.meta["notified"], reopened.meta["notice_limited_by"]) == (1, None)


def test_the_company_s_daily_budget_of_alert_e_mails(
    app: FastAPI,
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    admin = signed_in(make_client, world.a.admin)
    admin.patch("/tracking/settings", json={"alert_emails": ["one@example.com", "two@example.com"]})
    clock.advance(minutes=1)
    with rate_limits(app, tracking_alert_emails_per_company_day=2):
        sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
        assert sorted(email.to for email in alert_emails(email_provider)) == [
            "one@example.com",
            "two@example.com",
        ]
        [opened] = audit_rows(db, "TRACKING_ALERT_OPENED")
        assert opened.meta["notified"] == 2
        assert opened.meta["notice_limited_by"] == "tracking_alert_emails_per_company_day"
        # The escalation still happens; its e-mails do not fit.
        clock.advance(seconds=20)
        sees(client, key, ref, places.server_camera, clock.peek(), event_id="srv-1")
        assert alerts_of(db, visit_id)[0].type == "RESTRICTED_AREA"
        assert len(alert_emails(email_provider)) == 2
        [escalated] = audit_rows(db, "TRACKING_ALERT_ESCALATED")
        assert escalated.meta["notified"] == 0


def test_a_visit_s_hourly_budget_of_alert_notices(
    app: FastAPI,
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
) -> None:
    """B16-25: at most 3 e-mailed openings or escalations per visit and hour, whatever their number of
    recipients; a notice's slot is taken with its first recipient's company slot, both or neither. Beyond it
    the alert still opens, nothing of it is queued, and its audit row names the visit's budget."""
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    admin = signed_in(make_client, world.a.admin)
    admin.patch("/tracking/settings", json={"alert_emails": ["one@example.com", "two@example.com"]})
    recipients = ["one@example.com", "two@example.com", world.a.employee.email]

    def in_and_out(number: int) -> None:
        clock.advance(minutes=2)
        sees(client, key, ref, places.office_camera, clock.peek(), event_id=f"o-{number}")  # opens
        clock.advance(minutes=2)
        sees(client, key, ref, places.second_camera, clock.peek(), event_id=f"s-{number}")  # resolves

    with rate_limits(app, tracking_alert_emails_per_company_day=10):
        for number in range(1, 5):
            in_and_out(number)
        opened = audit_rows(db, "TRACKING_ALERT_OPENED")
        assert [row.meta["notified"] for row in opened] == [3, 3, 3, 0]
        assert [row.meta["notice_limited_by"] for row in opened] == [
            None,
            None,
            None,
            "tracking_alert_notices_per_visit",
        ]
        assert [alert.resolution for alert in alerts_of(db, visit_id)] == ["RETURNED"] * 4  # all four opened
        assert sorted(email.to for email in alert_emails(email_provider)) == sorted(recipients * 3)
        count = select(func.count()).select_from(EmailMessage).where(EmailMessage.kind == ALERT)
        assert db.scalar(count) == 9
        # An hour later the visit's budget has room again. The company's day has one e-mail left, which the
        # fourth opening did not take (both or neither): the fifth opening's first recipient gets it.
        clock.advance(hours=1)
        in_and_out(5)
        fifth = audit_rows(db, "TRACKING_ALERT_OPENED")[-1]
        assert (fifth.meta["notified"], fifth.meta["notice_limited_by"]) == (
            1,
            "tracking_alert_emails_per_company_day",
        )
        assert [email.to for email in alert_emails(email_provider)][-1] == "one@example.com"
        assert db.scalar(count) == 10


def test_a_batch_that_fails_sends_nothing_and_opens_nothing(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
    make_client,
) -> None:
    """E-mails go after the commit: a batch that fails after the alert was opened and its e-mails queued
    (here, writing the health rows) leaves no alert, no e-mail row and sends nothing."""
    visit_id, ref = tracked_visit(host, reception, world, places, db)

    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError("the database went away")

    monkeypatch.setattr(TrackingHealthRepository, "record", broken)
    failing = make_client(raise_server_exceptions=False)
    clock.advance(minutes=1)
    at = clock.peek()
    response = post_events(failing, key, [observed(ref, places.office_camera, at, event_id="o-1")])
    assert response.status_code == 500
    monkeypatch.undo()
    assert alerts_of(db, visit_id) == []
    assert alert_emails(email_provider) == []
    assert db.scalar(select(func.count()).select_from(EmailMessage).where(EmailMessage.kind == ALERT)) == 0


# ---- the journey and the live view -------------------------------------------------------------------


def test_a_journey_shows_its_areas_path_alerts_and_what_is_allowed(
    client: TestClient,
    host: Api,
    reception: Api,
    manager: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    start = clock.peek()
    sees(client, key, ref, places.second_camera, start, event_id="s-1")
    sees(client, key, ref, places.second_camera, start + timedelta(seconds=10), event_id="s-2")
    sees(
        client,
        key,
        ref,
        places.second_camera,
        start + timedelta(seconds=20),
        event_id="s-u",
        match="UNCERTAIN",
    )
    clock.advance(minutes=2)
    office_at = clock.peek()
    sees(client, key, ref, places.office_camera, office_at, event_id="o-1")
    clock.advance(minutes=2)
    back_at = clock.peek()
    sees(client, key, ref, places.second_camera, back_at, event_id="s-3")
    shown = journey(reception, visit_id)
    assert [
        (stay["location"]["floor"]["level"], stay["observations"], stay["allowed"]) for stay in shown["path"]
    ] == [(2, 2, True), (4, 1, False), (2, 1, True)]
    assert shown["path"][0]["from"] == start.isoformat().replace("+00:00", "Z")
    assert shown["path"][0]["to"] == (start + timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
    allowed = [(event["type"], event["confirmed"], event["allowed"]) for event in shown["timeline"]]
    assert allowed == [
        ("ENROLLED", False, None),
        ("OBSERVED", True, True),
        ("OBSERVED", True, True),
        ("OBSERVED", False, None),  # not confirmed
        ("OBSERVED", True, False),
        ("OBSERVED", True, True),
    ]
    assert shown["access_areas"]["floors"] == [
        {
            "id": str(places.second.id),
            "name": "Second",
            "name_ar": "الثاني",
            "level": 2,
            "building": {"id": str(places.building.id), "name": "Tower", "name_ar": "البرج"},
            "is_active": True,
        }
    ]
    assert shown["can_edit_access_areas"] is True
    assert [alert["resolution"] for alert in shown["alerts"]] == ["RETURNED"]
    assert journey(manager, visit_id)["can_edit_access_areas"] is False
    # The current areas decide: allowing the fourth floor marks its stay allowed.
    reception.put(f"/visits/{visit_id}/access-areas", json=areas(floors=(places.second, places.fourth)))
    assert [stay["allowed"] for stay in journey(reception, visit_id)["path"]] == [True, True, True]


def test_the_live_view(
    make_client,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    located_id, ref = tracked_visit(host, reception, world, places, db)
    plain = create_visit(host, world.a.employee.id, VISIT_START)
    plain_id = plain["visit"]["id"]
    assert check_in(reception, plain_id).status_code == 200
    expected = create_visit(host, world.a.employee.id, VISIT_START)  # not inside
    clock.advance(minutes=1)
    sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
    response = reception.get("/journeys/live")
    assert response.status_code == 200, response.text
    live = response.json()
    assert live["truncated"] is False
    by_id = {visitor["visit"]["id"]: visitor for visitor in live["visitors"]}
    assert set(by_id) == {located_id, plain_id} and expected["visit"]["id"] not in by_id
    located = by_id[located_id]
    assert (located["state"], located["simulated"]) == ("ACTIVE", True)
    assert located["last_location"]["zone"]["id"] == str(places.office.id)
    assert located["freshness_seconds"] == 0
    assert located["alert"]["type"] == "UNAUTHORIZED_AREA"
    assert located["access_areas"]["floors"][0]["id"] == str(places.second.id)
    assert (by_id[plain_id]["state"], by_id[plain_id]["last_location"], by_id[plain_id]["alert"]) == (
        "NOT_ENROLLED",
        None,
        None,
    )
    # One audit row an hour, like the list.
    [viewed] = audit_rows(db, "JOURNEY_LIST_VIEWED")
    assert viewed.meta == {"view": "LIVE", "located": 1} and viewed.actor_user_id == world.a.receptionist.id
    reception.get("/journeys/live")
    assert len(audit_rows(db, "JOURNEY_LIST_VIEWED")) == 1
    # A building: its located visitors, and everyone without a location.
    filtered = reception.get("/journeys/live", params={"building_id": str(places.building.id)}).json()
    assert {visitor["visit"]["id"] for visitor in filtered["visitors"]} == {located_id, plain_id}
    annex = area_registry(db, world.a.company, prefix="annex-")
    elsewhere = reception.get("/journeys/live", params={"building_id": str(annex.building.id)}).json()
    assert [visitor["visit"]["id"] for visitor in elsewhere["visitors"]] == [plain_id]
    unknown = reception.get("/journeys/live", params={"building_id": str(UUID(int=5))})
    assert unknown.status_code == 422
    assert unknown.json()["error"]["details"]["field_codes"]["building_id"]["code"] == "not_found"
    other_company = area_registry(db, world.b.company, prefix="b-")
    foreign = reception.get("/journeys/live", params={"building_id": str(other_company.building.id)})
    assert foreign.status_code == 422
    # The cap: the newest check-ins, and `truncated`.
    monkeypatch.setattr("app.services.journeys.LIVE_VISITORS_LIMIT", 1)
    capped = reception.get("/journeys/live").json()
    assert capped["truncated"] is True and [visitor["visit"]["id"] for visitor in capped["visitors"]] == [
        plain_id
    ]
    # Roles.
    assert host.get("/journeys/live").status_code == 403
    assert signed_in(make_client, world.a.manager).get("/journeys/live").status_code == 200


def test_the_logs_carry_no_ref_key_or_location_names(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: AreaRegistry,
    provider,
    key: str,
    db: Session,
    clock: FakeClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    visit_id, ref = tracked_visit(host, reception, world, places, db)
    clock.advance(minutes=1)
    with caplog.at_level(logging.DEBUG):
        sees(client, key, ref, places.office_camera, clock.peek(), event_id="o-1")
        reception.post(f"/tracking/alerts/{alerts_of(db, visit_id)[0].id}/resolve", json={"note": "Seen"})
    text = "\n".join(record.getMessage() + str(record.__dict__) for record in caplog.records)
    for secret in (ref, key, "Open office", "Dana Guest"):
        assert secret not in text
