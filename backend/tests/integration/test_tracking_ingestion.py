"""POST /api/v1/tracking/events (Phase 15, B15-9, B15-17): Bearer keys only, per-event outcomes, server-side
resolution of company, association and camera, duplicates, stale and out-of-order events, the journey
state each produces, the provider's outage and recovery, the per-key budget, and logs that carry no ref,
key or payload."""

import json
import logging
from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import TrackingHealthCount, TrackingKey, VisitorJourneyEvent
from tests.support import Api, World, error_code, rate_limits, signed_in
from tests.tracking_support import (
    EVENTS,
    RecordingProvider,
    Registry,
    SilentProvider,
    association_of,
    disabled,
    enroll,
    heartbeat,
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


@pytest.fixture
def key(db: Session, world: World) -> str:
    tracking_settings(db, world.a.company)
    return tracking_key(db, world.a.company, world.a.admin)


@pytest.fixture
def enrolled(
    host: Api, reception: Api, world: World, places: Registry, provider, key, db: Session
) -> tuple[str, str]:
    """A checked-in, enrolled visit: (visit ID, its ref)."""
    visit_id = inside_visit(host, reception, world.a.employee.id)
    assert enroll(reception, visit_id, places.reception_camera).json()["association"]["status"] == "ACTIVE"
    return visit_id, association_of(db, visit_id).ref


def outcomes(response: Any) -> list[tuple[str, str | None]]:
    assert response.status_code == 200, response.text
    return [(item["result"], item["reason"]) for item in response.json()["results"]]


def journey(api: Api, visit_id: str) -> dict[str, Any]:
    response = api.get(f"/visits/{visit_id}/journey")
    assert response.status_code == 200, response.text
    return response.json()


# ---- authentication ---------------------------------------------------------------------------------


def test_the_route_is_absent_while_the_provider_is_disabled(
    app: FastAPI, client: TestClient, key: str, clock: FakeClock
) -> None:
    with using_provider(app, disabled()):
        response = post_events(client, key, [heartbeat(clock.peek())])
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"


@pytest.mark.parametrize("method", ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
def test_every_other_method_is_absent_too_while_the_provider_is_disabled(
    app: FastAPI, client: TestClient, method: str
) -> None:
    """B15-38: a disabled deployment does not even reveal that the path exists (a GET answered 405)."""
    with using_provider(app, disabled()):
        assert client.request(method, EVENTS).status_code == 404
    with using_provider(app, RecordingProvider()):
        response = client.request(method, EVENTS)
    assert response.status_code == 405
    if method != "HEAD":
        assert error_code(response) == "METHOD_NOT_ALLOWED"


@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "Bearer ",
        "Basic dmlzaXRvcjpwYXNz",
        "Bearer vtk_" + "A" * 43,  # well formed, unknown
        "bearer {key}",  # the scheme is case-sensitive here: exactly "Bearer"
        "Bearer {key} extra",
    ],
)
def test_a_wrong_or_absent_key_is_401(
    client: TestClient, provider, key: str, clock: FakeClock, authorization: str | None
) -> None:
    headers = {"Authorization": authorization.format(key=key)} if authorization is not None else {}
    response = client.post(EVENTS, json={"events": [heartbeat(clock.peek())]}, headers=headers)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"


def test_a_revoked_key_is_401(
    make_client, client: TestClient, provider, key: str, world: World, db: Session, clock: FakeClock
) -> None:
    assert outcomes(post_events(client, key, [heartbeat(clock.peek())])) == [("accepted", None)]
    admin = signed_in(make_client, world.a.admin)
    key_id = db.scalar(select(TrackingKey.id))
    assert admin.delete(f"/tracking/keys/{key_id}").status_code == 200
    response = post_events(client, key, [heartbeat(clock.peek())])
    assert response.status_code == 401


def test_a_session_cookie_is_not_accepted(
    make_client, provider, key: str, world: World, clock: FakeClock
) -> None:
    admin = signed_in(make_client, world.a.admin)  # cookie jar holds a live session and its CSRF token
    response = admin.post("/tracking/events", json={"events": [heartbeat(clock.peek())]})
    assert response.status_code == 401
    # With the key, the cookie changes nothing and no CSRF token is needed.
    response = admin.post(
        "/tracking/events",
        json={"events": [heartbeat(clock.peek())]},
        csrf=False,
        headers={"Authorization": f"Bearer {key}"},
    )
    assert response.status_code == 200


def test_a_deactivated_company_s_key_is_401(
    client: TestClient, provider, key: str, world: World, db: Session, clock: FakeClock
) -> None:
    world.a.company.is_active = False
    world.a.company.deactivated_at = clock.peek()
    db.commit()
    assert post_events(client, key, [heartbeat(clock.peek())]).status_code == 401


def test_wrong_keys_are_counted_per_address(
    app: FastAPI, client: TestClient, provider, clock: FakeClock
) -> None:
    with rate_limits(app, tracking_key_failures_ip=2):
        for _ in range(2):
            assert post_events(client, "vtk_" + "B" * 43, [heartbeat(clock.peek())]).status_code == 401
        response = post_events(client, "vtk_" + "B" * 43, [heartbeat(clock.peek())])
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert int(response.headers["Retry-After"]) >= 1


def test_each_key_has_a_budget(
    app: FastAPI, client: TestClient, provider, key: str, clock: FakeClock
) -> None:
    with rate_limits(app, tracking_requests_per_key=2):
        assert post_events(client, key, [heartbeat(clock.peek())]).status_code == 200
        assert post_events(client, key, [heartbeat(clock.peek())]).status_code == 200
        response = post_events(client, key, [heartbeat(clock.peek())])
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"


# ---- the body ---------------------------------------------------------------------------------------


def test_a_malformed_body_is_422(client: TestClient, provider, key: str, clock: FakeClock) -> None:
    auth = {"Authorization": f"Bearer {key}"}
    now = clock.peek().isoformat()
    cases: list[tuple[Any, str]] = [
        ({"events": []}, "events"),
        (
            {"events": [{"provider_event_id": "x", "type": "OBSERVED", "observed_at": now}]},
            "events.0.association_ref",
        ),
        ({"events": [{"provider_event_id": "x", "type": "SEEN", "observed_at": now}]}, "events.0.type"),
        (
            {
                "events": [
                    {"provider_event_id": "x", "type": "HEARTBEAT", "observed_at": "2026-10-05T09:00:00"}
                ]
            },
            "events.0.observed_at",
        ),
        ({"events": [heartbeat(clock.peek()) | {"payload": {"crop": "..."}}]}, "events.0.payload"),
        ({"events": [heartbeat(clock.peek())], "company_id": "x"}, "company_id"),
        ({"events": [heartbeat(clock.peek()) | {"association_ref": "trk_x"}]}, "events.0.association_ref"),
        (
            {
                "events": [
                    {
                        "provider_event_id": "x",
                        "type": "OBSERVED",
                        "association_ref": "trk_x",
                        "camera_id": "c",
                        "observed_at": now,
                        "match": "CONFIRMED",
                        "confidence": 1.5,
                    }
                ]
            },
            "events.0.confidence",
        ),
        (
            {
                "events": [
                    {
                        "provider_event_id": "x",
                        "type": "LOST",
                        "association_ref": "trk_x",
                        "observed_at": now,
                        "match": "CONFIRMED",
                    }
                ]
            },
            "events.0.match",
        ),
        (
            {"events": [{"provider_event_id": "x" * 129, "type": "HEARTBEAT", "observed_at": now}]},
            "events.0.provider_event_id",
        ),
        (
            {"events": [{"provider_event_id": "has space", "type": "HEARTBEAT", "observed_at": now}]},
            "events.0.provider_event_id",
        ),
        ({"events": [heartbeat(clock.peek(), f"hb-{n}") for n in range(101)]}, "events"),
    ]
    for body, path in cases:
        response = client.post(EVENTS, json=body, headers=auth)
        assert response.status_code == 422, (body, response.text)
        assert path in response.json()["error"]["details"]["fields"], (path, response.json())
    not_json = client.post(EVENTS, content=b"{not json", headers={**auth, "Content-Type": "application/json"})
    assert not_json.status_code == 422
    assert not_json.json()["error"]["details"]["field_codes"] == {
        "body": {"code": "invalid_json", "params": {}}
    }
    deep = client.post(EVENTS, content=b"[" * 20000, headers={**auth, "Content-Type": "application/json"})
    assert deep.status_code == 422
    form = client.post(
        EVENTS, content=b"events=1", headers={**auth, "Content-Type": "application/x-www-form-urlencoded"}
    )
    assert form.status_code == 415 and error_code(form) == "UNSUPPORTED_MEDIA_TYPE"


def test_an_oversized_body_is_413(client: TestClient, provider, key: str, clock: FakeClock) -> None:
    body = json.dumps({"events": [heartbeat(clock.peek(), "x" * 100)] * 1000}).encode()
    assert len(body) > 64 * 1024
    response = client.post(
        EVENTS, content=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    )
    assert response.status_code == 413 and error_code(response) == "PAYLOAD_TOO_LARGE"


def test_nothing_of_a_stranger_s_body_is_read(client: TestClient, provider) -> None:
    response = client.post(EVENTS, content=b"{not json", headers={"Content-Type": "application/json"})
    assert response.status_code == 401


# ---- resolution -------------------------------------------------------------------------------------


def test_duplicates_are_answered_and_not_stored_twice(
    client: TestClient, enrolled: tuple[str, str], places: Registry, key: str, db: Session, clock: FakeClock
) -> None:
    _visit_id, ref = enrolled
    event = observed(ref, places.upper_camera, clock.peek(), event_id="evt-1")
    assert outcomes(post_events(client, key, [event, event])) == [("accepted", None), ("duplicate", None)]
    assert outcomes(post_events(client, key, [event])) == [("duplicate", None)]
    stored = db.scalar(select(func.count()).where(VisitorJourneyEvent.provider_event_id == "evt-1"))
    assert stored == 1


def test_unknown_cameras_and_refs_are_rejected_and_only_counted(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    db: Session,
    world: World,
    clock: FakeClock,
) -> None:
    _visit_id, ref = enrolled
    other = registry(db, world.b.company, prefix="b-")
    now = clock.peek()
    places.ground_camera.is_active = False
    db.commit()
    response = post_events(
        client,
        key,
        [
            observed(ref, "cam-nobody-registered", now, event_id="u1"),
            observed(ref, other.upper_camera, now, event_id="u2"),  # another company's camera
            observed(ref, places.ground_camera, now, event_id="u3"),  # archived
            observed("trk_" + "a" * 32, places.upper_camera, now, event_id="u4"),
            observed("not-a-ref", places.upper_camera, now, event_id="u5"),
        ],
    )
    assert outcomes(response) == [
        ("rejected", "UNKNOWN_CAMERA"),
        ("rejected", "UNKNOWN_CAMERA"),
        ("rejected", "UNKNOWN_CAMERA"),
        ("rejected", "UNKNOWN_ASSOCIATION"),
        ("rejected", "UNKNOWN_ASSOCIATION"),
    ]
    assert db.scalar(select(func.count()).where(VisitorJourneyEvent.type == "OBSERVED")) == 0
    counts = {row.reason: row.count for row in db.scalars(select(TrackingHealthCount))}
    assert counts == {"UNKNOWN_CAMERA": 3, "UNKNOWN_ASSOCIATION": 2}


def test_another_company_s_key_cannot_reach_this_company_s_associations(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    db: Session,
    world: World,
    clock: FakeClock,
) -> None:
    visit_id, ref = enrolled
    tracking_settings(db, world.b.company)
    registry(db, world.b.company, prefix="b-")
    other_key = tracking_key(db, world.b.company, world.b.admin)
    response = post_events(client, other_key, [observed(ref, "b-cam-3f", clock.peek(), event_id="x1")])
    assert outcomes(response) == [("rejected", "UNKNOWN_ASSOCIATION")]
    response = post_events(
        client, other_key, [observed(ref, places.upper_camera, clock.peek(), event_id="x2")]
    )
    assert outcomes(response) == [("rejected", "UNKNOWN_ASSOCIATION")]
    assert db.scalar(select(func.count()).where(VisitorJourneyEvent.visit_id == visit_id)) == 1  # ENROLLED


def test_time_rules(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    db: Session,
    world: World,
    clock: FakeClock,
) -> None:
    _visit_id, ref = enrolled
    now = clock.peek()
    tracking_settings(db, world.a.company, retention_days=1)
    response = post_events(
        client,
        key,
        [
            observed(ref, places.upper_camera, now + timedelta(minutes=3), event_id="t1"),
            observed(ref, places.upper_camera, now + timedelta(minutes=1), event_id="t2"),  # clock skew
            observed(ref, places.upper_camera, now - timedelta(days=2), event_id="t3"),
            observed(ref, places.upper_camera, now - timedelta(hours=1), event_id="t4"),  # before enrollment
        ],
    )
    assert outcomes(response) == [
        ("rejected", "IN_FUTURE"),
        ("accepted", None),
        ("rejected", "TOO_OLD"),
        ("rejected", "BEFORE_ASSOCIATION"),
    ]


def test_tracking_switched_off_rejects_everything_but_the_heartbeat(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    db: Session,
    world: World,
    clock: FakeClock,
) -> None:
    _visit_id, ref = enrolled
    tracking_settings(db, world.a.company, enabled=False)
    response = post_events(
        client,
        key,
        [heartbeat(clock.peek()), observed(ref, places.upper_camera, clock.peek(), event_id="o1")],
    )
    assert outcomes(response) == [("accepted", None), ("rejected", "TRACKING_OFF")]


def test_enrollment_events(
    app: FastAPI,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    with using_provider(app, SilentProvider()):
        first = inside_visit(host, reception, world.a.employee.id)
        assert enroll(reception, first, places.reception_camera).json()["state"] == "PENDING"
        ref = association_of(db, first).ref
        now = clock.peek()
        enrolled_elsewhere = {
            "provider_event_id": "en-1",
            "type": "ENROLLED",
            "association_ref": ref,
            "camera_id": places.upper_camera.provider_camera_id,
            "observed_at": now.isoformat(),
        }
        assert outcomes(post_events(client, key, [enrolled_elsewhere])) == [("rejected", "CAMERA_MISMATCH")]
        # Nobody is bound to a PENDING association yet: its sightings are refused (B15-28).
        assert outcomes(
            post_events(client, key, [observed(ref, places.ground_camera, now, event_id="p-1")])
        ) == [("rejected", "NOT_ACTIVE")]
        enrolled_here = enrolled_elsewhere | {
            "provider_event_id": "en-2",
            "camera_id": places.reception_camera.provider_camera_id,
        }
        assert outcomes(post_events(client, key, [enrolled_here])) == [("accepted", None)]
        assert association_of(db, first).status == "ACTIVE"
        again = enrolled_here | {"provider_event_id": "en-3"}
        assert outcomes(post_events(client, key, [again])) == [("rejected", "ALREADY_ENROLLED")]

        failed_visit = inside_visit(host, reception, world.a.employee.id)  # another visitor
        enroll(reception, failed_visit, places.reception_camera)
        failed_ref = association_of(db, failed_visit).ref
        failure = {
            "provider_event_id": "ef-1",
            "type": "ENROLLMENT_FAILED",
            "association_ref": failed_ref,
            "observed_at": clock.peek().isoformat(),
        }
        assert outcomes(post_events(client, key, [failure])) == [("accepted", None)]
        ended = association_of(db, failed_visit)
        assert ended.status == "ENDED" and ended.ended_reason == "ENROLLMENT_FAILED"
        retried = failure | {"provider_event_id": "ef-2"}
        assert outcomes(post_events(client, key, [retried])) == [("duplicate", None)]


# ---- after the independent review: only an activated association has sightings (B15-28) --------------


def test_sightings_of_an_association_that_never_activated_are_refused_and_never_shown(
    app: FastAPI,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """Nobody is bound to a PENDING association, nor to one whose enrollment failed: a sighting of it would
    place somebody on a floor without any person behind it."""
    with using_provider(app, SilentProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        assert enroll(reception, visit_id, places.reception_camera).json()["state"] == "PENDING"
        association = association_of(db, visit_id)
        seen = clock.peek()
        lost = {"provider_event_id": "na-2", "type": "LOST", "association_ref": association.ref}
        refused = post_events(
            client,
            key,
            [
                observed(association.ref, places.upper_camera, seen, event_id="na-1"),
                lost | {"observed_at": seen.isoformat()},
            ],
        )
        assert outcomes(refused) == [("rejected", "NOT_ACTIVE"), ("rejected", "NOT_ACTIVE")]
        clock.advance(seconds=30)
        failed = {
            "provider_event_id": "na-3",
            "type": "ENROLLMENT_FAILED",
            "association_ref": association.ref,
            "observed_at": clock.peek().isoformat(),
        }
        assert outcomes(post_events(client, key, [failed])) == [("accepted", None)]
        # Observed before the end, but the association never bound anybody: no late history either.
        late = observed(association.ref, places.upper_camera, seen + timedelta(seconds=10), event_id="na-4")
        assert outcomes(post_events(client, key, [late])) == [("rejected", "ASSOCIATION_ENDED")]
        stored = db.scalars(
            select(VisitorJourneyEvent.provider_event_id).where(
                VisitorJourneyEvent.association_id == association.id
            )
        ).all()
        assert stored == []
        detail = journey(reception, visit_id)
        assert detail["state"] == "ENDED" and detail["association"]["ended_reason"] == "ENROLLMENT_FAILED"
        assert detail["last_location"] is None and detail["last_observed_at"] is None
        assert detail["timeline"] == [] and detail["timeline_total"] == 0
        [row] = reception.get("/journeys").json()["items"]
        assert row["state"] == "ENDED" and row["last_location"] is None


def test_a_batch_applies_its_enrollment_before_its_sightings(
    app: FastAPI,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """A provider may send the first sighting in the batch that confirms the enrollment, in any order:
    ENROLLED and ENROLLMENT_FAILED are applied first, the outcomes keep the batch's order."""
    with using_provider(app, SilentProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
        ref = association_of(db, visit_id).ref
        now = clock.peek()
        enrolled = {
            "provider_event_id": "bo-2",
            "type": "ENROLLED",
            "association_ref": ref,
            "camera_id": places.reception_camera.provider_camera_id,
            "observed_at": now.isoformat(),
        }
        sighting = observed(ref, places.upper_camera, now + timedelta(seconds=5), event_id="bo-1")
        response = post_events(client, key, [sighting, enrolled])
        assert [item["provider_event_id"] for item in response.json()["results"]] == ["bo-1", "bo-2"]
        assert outcomes(response) == [("accepted", None), ("accepted", None)]
        detail = journey(reception, visit_id)
        assert detail["state"] == "ACTIVE" and detail["last_location"]["floor"]["level"] == 3


def test_a_stored_sighting_of_a_never_activated_association_is_not_shown(
    app: FastAPI,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    """A row stored before B15-28 (when a PENDING association's sightings were accepted) stays in the
    append-only table but is no part of any journey: not the location, not the timeline."""
    with using_provider(app, SilentProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
        association = association_of(db, visit_id)
        now = clock.peek()
        db.add(
            VisitorJourneyEvent(
                company_id=association.company_id,
                visit_id=association.visit_id,
                association_id=association.id,
                provider="simulator",
                provider_event_id="legacy-1",
                type="OBSERVED",
                camera_id=places.upper_camera.id,
                building_id=places.building.id,
                floor_id=places.upper.id,
                zone_id=places.office.id,
                observed_at=now,
                received_at=now,
                match="CONFIRMED",
                confidence=0.95,
            )
        )
        db.commit()
        detail = journey(reception, visit_id)
        assert detail["state"] == "PENDING"
        assert detail["last_location"] is None and detail["timeline"] == [] and detail["timeline_total"] == 0
        [row] = reception.get("/journeys").json()["items"]
        assert row["last_location"] is None and row["freshness_seconds"] is None


def test_valid_requests_never_spend_the_address_s_failure_budget(
    app: FastAPI, client: TestClient, provider, key: str, clock: FakeClock
) -> None:
    """B15-36: only a wrong key counts, so a provider sending many batches at once from one address is
    never refused for them."""
    with rate_limits(app, tracking_key_failures_ip=1):
        for index in range(5):
            assert post_events(client, key, [heartbeat(clock.peek(), f"hb-{index}")]).status_code == 200
        assert post_events(client, "vtk_" + "C" * 43, [heartbeat(clock.peek())]).status_code == 401
        response = post_events(client, "vtk_" + "C" * 43, [heartbeat(clock.peek())])
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"


def test_a_check_of_the_failure_budget_takes_nothing_from_it(
    app: FastAPI, db: Session, world: World, key: str
) -> None:
    """B15-36: a valid key is checked against the budget, not counted in it, however many requests are in
    flight at once (the review's concern: more concurrent valid requests than the budget answered 429)."""
    from app.services.tracking_ingestion import authenticate_key

    env = app.state.service_environment
    failures = replace(env.policies.tracking_key_failures_ip, limit=1)
    policies = replace(env.policies, tracking_key_failures_ip=failures)
    secret = app.state.settings.secret_key.get_secret_value()
    for _ in range(31):  # none of them finished: nothing was settled in between
        context = authenticate_key(
            db,
            f"Bearer {key}",
            client_ip="198.51.100.77",
            secret_key=secret,
            limiter=env.limiter,
            policies=policies,
        )
        assert context.company_id == world.a.company.id


# ---- the journey state ------------------------------------------------------------------------------


def test_a_fresh_enrollment_is_active_and_unknown_until_the_stale_threshold_passes(
    client: TestClient, enrolled: tuple[str, str], key: str, reception: Api, clock: FakeClock
) -> None:
    """Freshness runs from the activation while nothing is confirmed (the lead's decision, B15-12): right
    after enrolling the journey is ACTIVE with no location ("Unknown"), and only once the stale threshold
    (15 min) has passed without a confirmed observation does it turn STALE."""
    visit_id, _ref = enrolled
    fresh = journey(reception, visit_id)
    assert fresh["state"] == "ACTIVE"
    assert fresh["last_location"] is None and fresh["last_observed_at"] is None
    assert fresh["freshness_seconds"] is None
    clock.advance(minutes=14)
    post_events(client, key, [heartbeat(clock.peek(), "hb-14")])  # the provider is still in contact
    assert journey(reception, visit_id)["state"] == "ACTIVE"
    clock.advance(minutes=2)
    post_events(client, key, [heartbeat(clock.peek(), "hb-16")])
    stale = journey(reception, visit_id)
    assert stale["state"] == "STALE" and stale["last_location"] is None


def test_a_confirmed_fresh_observation_is_active_with_its_inferred_floor(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    reception: Api,
    clock: FakeClock,
) -> None:
    visit_id, ref = enrolled
    clock.advance(minutes=2)
    seen = clock.peek()
    post_events(client, key, [observed(ref, places.upper_camera, seen, event_id="a1", confidence=0.91)])
    clock.advance(minutes=4)
    result = journey(reception, visit_id)
    assert result["state"] == "ACTIVE"
    assert result["last_location"]["floor"] == {
        "id": str(places.upper.id),
        "name": "Third",
        "name_ar": "الثالث",
        "level": 3,
    }
    assert result["last_location"]["zone"]["name"] == "Offices"
    assert result["last_observed_at"].startswith(seen.strftime("%Y-%m-%dT%H:%M"))
    assert 239 <= result["freshness_seconds"] <= 241
    [_, sighting] = result["timeline"]
    assert sighting["confirmed"] is True and sighting["confidence"] == 0.91
    assert sighting["camera"]["name"] == "Third floor" and sighting["match"] == "CONFIRMED"


def test_the_latest_is_by_observation_time_not_arrival(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    reception: Api,
    clock: FakeClock,
) -> None:
    visit_id, ref = enrolled
    clock.advance(minutes=3)
    newer = clock.peek()
    post_events(client, key, [observed(ref, places.upper_camera, newer, event_id="new")])
    # An older observation (ground floor) that arrives later never replaces the newer floor.
    post_events(
        client, key, [observed(ref, places.ground_camera, newer - timedelta(minutes=2), event_id="old")]
    )
    result = journey(reception, visit_id)
    assert result["state"] == "ACTIVE" and result["last_location"]["floor"]["level"] == 3
    assert [event["camera"]["name"] for event in result["timeline"]] == [
        "Reception",
        "Lobby east",
        "Third floor",
    ]


def test_uncertain_and_below_threshold_observations_never_become_the_last_floor(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    reception: Api,
    clock: FakeClock,
    db: Session,
    world: World,
) -> None:
    visit_id, ref = enrolled
    clock.advance(minutes=1)
    post_events(client, key, [observed(ref, places.ground_camera, clock.peek(), event_id="c1")])
    clock.advance(minutes=1)
    post_events(
        client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="u1", match="UNCERTAIN")]
    )
    result = journey(reception, visit_id)
    assert result["state"] == "UNCERTAIN" and result["last_location"]["floor"]["level"] == 0
    assert result["timeline"][-1]["confirmed"] is False
    clock.advance(minutes=1)
    post_events(
        client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="b1", confidence=0.5)]
    )
    result = journey(reception, visit_id)
    assert result["state"] == "UNCERTAIN" and result["last_location"]["floor"]["level"] == 0
    clock.advance(minutes=1)
    post_events(
        client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="n1", confidence=None)]
    )
    result = journey(reception, visit_id)
    assert result["state"] == "UNCERTAIN" and result["timeline"][-1]["confidence"] is None
    # With no threshold nothing is confirmed: no location at all.
    tracking_settings(db, world.a.company, min_confidence=None)
    result = journey(reception, visit_id)
    assert (
        result["state"] == "UNCERTAIN"
        and result["last_location"] is None
        and result["last_observed_at"] is None
    )
    assert not any(event["confirmed"] for event in result["timeline"])


def test_two_confirmed_floors_within_a_minute_are_uncertain(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    reception: Api,
    clock: FakeClock,
) -> None:
    visit_id, ref = enrolled
    clock.advance(minutes=1)
    first = clock.peek()
    post_events(
        client,
        key,
        [
            observed(ref, places.ground_camera, first, event_id="f1"),
            observed(ref, places.upper_camera, first + timedelta(seconds=40), event_id="f2"),
        ],
    )
    clock.advance(minutes=1)
    # Two reliable observations contradict each other: no floor is reliable, so none is answered
    # ("Unknown"), in the journey and in the list alike (B15-30).
    conflicted = journey(reception, visit_id)
    assert conflicted["state"] == "UNCERTAIN"
    assert conflicted["last_location"] is None and conflicted["last_observed_at"] is None
    assert conflicted["freshness_seconds"] is None
    assert [event["confirmed"] for event in conflicted["timeline"] if event["type"] == "OBSERVED"] == [
        True,
        True,
    ]
    [row] = reception.get("/journeys").json()["items"]
    assert row["state"] == "UNCERTAIN" and row["last_location"] is None and row["freshness_seconds"] is None
    clock.advance(minutes=1)
    post_events(client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="f3")])
    resolved = journey(reception, visit_id)
    assert resolved["state"] == "ACTIVE" and resolved["last_location"]["floor"]["level"] == 3


def test_stale_lost_and_unavailable(
    client: TestClient,
    enrolled: tuple[str, str],
    places: Registry,
    key: str,
    reception: Api,
    clock: FakeClock,
    db: Session,
    world: World,
) -> None:
    visit_id, ref = enrolled
    clock.advance(minutes=1)
    post_events(client, key, [observed(ref, places.upper_camera, clock.peek(), event_id="s1")])
    clock.advance(minutes=4)
    post_events(client, key, [heartbeat(clock.peek())])
    tracking_settings(db, world.a.company, stale_after_minutes=3)
    stale = journey(reception, visit_id)
    assert stale["state"] == "STALE" and stale["last_location"]["floor"]["level"] == 3
    tracking_settings(db, world.a.company, stale_after_minutes=15)
    assert journey(reception, visit_id)["state"] == "ACTIVE"
    lost = {
        "provider_event_id": "l1",
        "type": "LOST",
        "association_ref": ref,
        "observed_at": clock.peek().isoformat(),
    }
    assert outcomes(post_events(client, key, [lost])) == [("accepted", None)]
    assert journey(reception, visit_id)["state"] == "STALE"
    # The provider goes quiet: no contact for more than 5 minutes.
    clock.advance(minutes=6)
    assert journey(reception, visit_id)["state"] == "UNAVAILABLE"
    status = reception.get("/tracking/status").json()
    assert status["healthy"] is False and status["simulated"] is True
    # It comes back: a heartbeat is contact again.
    post_events(client, key, [heartbeat(clock.peek(), "hb-back")])
    assert journey(reception, visit_id)["state"] == "STALE"
    assert reception.get("/tracking/status").json()["healthy"] is True


def test_the_logs_carry_no_ref_key_or_payload(
    caplog: pytest.LogCaptureFixture,
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    key: str,
    db: Session,
    clock: FakeClock,
) -> None:
    with caplog.at_level(logging.DEBUG):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
        ref = association_of(db, visit_id).ref
        post_events(
            client,
            key,
            [
                observed(ref, places.upper_camera, clock.peek(), event_id="secret-event-id-77"),
                observed(ref, "cam-unknown-secret", clock.peek(), event_id="secret-event-id-78"),
            ],
        )
        post_events(client, "vtk_" + "C" * 43, [heartbeat(clock.peek())])
        provider.fail_revoke = True
        reception.post(f"/visits/{visit_id}/tracking/revoke")
    text = "\n".join(
        record.getMessage() + " " + json.dumps(record.__dict__, default=str) for record in caplog.records
    )
    # The tracking logger is captured: its warning about the failed revoke is there, without the ref.
    assert any(record.getMessage() == "tracking provider revoke failed" for record in caplog.records)
    assert any(record.name == "app.access" for record in caplog.records)
    for secret in (ref, key, "vtk_" + "C" * 43, "secret-event-id-77", "cam-unknown-secret", key[:20]):
        assert secret not in text
