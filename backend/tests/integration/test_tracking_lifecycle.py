"""The tracking association's lifecycle (Phase 15, B15-14, B15-15, B15-18): who may enroll and when,
idempotent enrollment, the simulator's immediate ENROLLED, revoke, check-out ending it in its own
transaction, expiry checked on reads, the provider's failures counted in health, a new association on
re-enrollment, and the company switch-offs ending everything."""

import logging
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import TrackingAssociation, TrackingHealthCount, VisitorJourneyEvent
from app.repositories.tracking import TrackingHealthRepository
from app.services.tracking_rules import ASSOCIATION_MAX_LIFETIME, PENDING_TIMEOUT, REF_PREFIX
from tests.conftest import TEST_START
from tests.support import Api, World, audit_rows, check_in, check_out, create_visit, error_code, signed_in
from tests.tracking_support import (
    VISIT_START,
    RecordingProvider,
    Registry,
    SilentProvider,
    association_of,
    disabled,
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


@pytest.fixture
def tracking_on(db: Session, world: World) -> None:
    tracking_settings(db, world.a.company)


# ---- enrollment ----------------------------------------------------------------------------------------


def test_the_simulator_enrolls_at_once_and_marks_it_simulated(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    response = enroll(reception, visit_id, places.reception_camera)
    assert response.status_code == 200, response.text
    journey = response.json()
    association = journey["association"]
    assert association["status"] == "ACTIVE" and association["provider"] == "simulator"
    assert association["simulated"] is True and association["enrollment_camera"]["name"] == "Reception"
    # Enrolled, nothing observed yet: ACTIVE, with no location (B15-12).
    assert journey["state"] == "ACTIVE" and journey["last_location"] is None
    assert "ref" not in association  # the provider's reference never leaves the server
    assert [event["type"] for event in journey["timeline"]] == ["ENROLLED"]
    assert journey["timeline"][0]["model_version"] == "simulator"
    assert journey["timeline"][0]["location"]["zone"]["name"] == "Lobby"
    assert journey["can_enroll"] is False and journey["enroll_blocker"] == "ALREADY_ENROLLED"
    assert journey["can_revoke"] is True
    # The binding request named the camera as the provider knows it, and a random ref.
    [(company_id, ref, camera_id)] = provider.enrolled
    assert company_id == world.a.company.id and camera_id == "cam-reception"
    assert ref.startswith(REF_PREFIX) and visit_id.replace("-", "") not in ref
    [requested] = audit_rows(db, "TRACKING_ENROLLMENT_REQUESTED")
    assert requested.actor_user_id == world.a.receptionist.id and str(requested.entity_id) == visit_id
    assert set(requested.meta) == {"association_id", "camera_id", "provider"}
    [activated] = audit_rows(db, "TRACKING_ASSOCIATION_ACTIVATED")
    assert activated.meta["association_id"] == association["id"] and activated.actor_user_id is None


def test_enrollment_is_idempotent(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    first = enroll(reception, visit_id, places.reception_camera).json()
    again = enroll(reception, visit_id, places.reception_camera)
    assert again.status_code == 200 and again.json()["association"]["id"] == first["association"]["id"]
    assert len(provider.enrolled) == 1
    assert db.scalar(select(TrackingAssociation.id).where(TrackingAssociation.visit_id == visit_id).limit(2))
    count = len(
        list(db.scalars(select(TrackingAssociation.id).where(TrackingAssociation.visit_id == visit_id)))
    )
    assert count == 1


@pytest.mark.parametrize(
    ("allowed", "enabled", "reason"),
    [(False, False, "NOT_ALLOWED"), (True, False, "NOT_ENABLED")],
)
def test_enrollment_needs_the_company_switches(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    db: Session,
    allowed: bool,
    enabled: bool,
    reason: str,
) -> None:
    tracking_settings(db, world.a.company, allowed=allowed, enabled=enabled)
    visit_id = inside_visit(host, reception, world.a.employee.id)
    response = enroll(reception, visit_id, places.reception_camera)
    assert response.status_code == 409 and error_code(response) == "TRACKING_NOT_AVAILABLE"
    assert response.json()["error"]["details"] == {"reason": reason}
    assert provider.enrolled == []
    journey = reception.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "DISABLED" and journey["enroll_blocker"] == reason


def test_enrollment_is_refused_while_the_provider_is_disabled(
    app: FastAPI, host: Api, reception: Api, world: World, places: Registry, tracking_on, db: Session
) -> None:
    with using_provider(app, disabled()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        response = enroll(reception, visit_id, places.reception_camera)
        assert response.status_code == 409 and response.json()["error"]["details"] == {
            "reason": "PROVIDER_DISABLED"
        }
        journey = reception.get(f"/visits/{visit_id}/journey").json()
        assert journey["state"] == "DISABLED" and journey["enroll_blocker"] == "PROVIDER_DISABLED"
    assert db.scalar(select(TrackingAssociation.id)) is None


def test_any_checked_in_visit_is_enrolled_whatever_its_schedule(
    make_client,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    clock: FakeClock,
) -> None:
    """B15-34 (after the independent review): a visitor inside is inside, also after the pass window (a
    late OVERRIDE check-in, an overstay); only a visit that is not CHECKED_IN is refused."""
    scheduled = create_visit(host, world.a.employee.id, VISIT_START)["visit"]["id"]
    response = enroll(reception, scheduled, places.reception_camera)
    assert response.status_code == 409 and error_code(response) == "VISIT_NOT_CHECKED_IN"
    assert reception.get(f"/visits/{scheduled}/journey").json()["enroll_blocker"] == "NOT_CHECKED_IN"
    inside = inside_visit(host, reception, world.a.employee.id)
    clock.advance(hours=3, minutes=1)  # the pass window ended at 09:00Z (scheduled end + an hour's grace)
    desk = signed_in(make_client, world.a.receptionist)
    assert desk.get(f"/visits/{inside}/journey").json()["enroll_blocker"] is None
    late = enroll(desk, inside, places.reception_camera)
    assert late.status_code == 200 and late.json()["association"]["status"] == "ACTIVE"
    assert len(provider.enrolled) == 1


def test_the_camera_must_be_an_active_enrollment_point_of_the_company(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    other = registry(db, world.b.company, prefix="b-")
    visit_id = inside_visit(host, reception, world.a.employee.id)
    places.upper_camera.is_enrollment_point = False
    db.commit()
    for camera in (places.upper_camera, other.reception_camera):
        response = enroll(reception, visit_id, camera)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["details"]["field_codes"] == {
            "camera_id": {"code": "not_found", "params": {}}
        }
    places.reception_camera.is_active = False
    db.commit()
    archived = enroll(reception, visit_id, places.reception_camera)
    assert archived.status_code == 422
    assert reception.get(f"/visits/{visit_id}/journey").json()["enroll_blocker"] == "NO_ENROLLMENT_POINT"
    assert provider.enrolled == []


@pytest.mark.parametrize("role", ["manager", "employee"])
def test_only_reception_and_administrators_enroll_and_revoke(
    make_client, host: Api, reception: Api, world: World, places: Registry, provider, tracking_on, role: str
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    api = signed_in(make_client, getattr(world.a, role))
    for path in (f"/visits/{visit_id}/tracking/enroll", f"/visits/{visit_id}/tracking/revoke"):
        response = api.post(path, json={"camera_id": str(places.reception_camera.id)})
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    admin = signed_in(make_client, world.a.admin)
    assert enroll(admin, visit_id, places.reception_camera).status_code == 200
    if role == "manager":
        journey = api.get(f"/visits/{visit_id}/journey").json()
        assert journey["can_enroll"] is False and journey["enroll_blocker"] == "NOT_PERMITTED"
        assert journey["can_revoke"] is False


def test_another_company_s_visit_is_not_found(
    make_client, host: Api, reception: Api, world: World, places: Registry, provider, tracking_on
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    stranger = signed_in(make_client, world.b.receptionist)
    for response in (
        stranger.post(
            f"/visits/{visit_id}/tracking/enroll", json={"camera_id": str(places.reception_camera.id)}
        ),
        stranger.post(f"/visits/{visit_id}/tracking/revoke"),
        stranger.get(f"/visits/{visit_id}/journey"),
    ):
        assert response.status_code == 404 and error_code(response) == "NOT_FOUND"


# ---- ending ----------------------------------------------------------------------------------------------


def test_revoke_ends_it_once_and_tells_the_provider(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    ref = association_of(db, visit_id).ref
    response = reception.post(f"/visits/{visit_id}/tracking/revoke")
    assert response.status_code == 200
    journey = response.json()
    assert journey["state"] == "ENDED" and journey["association"]["ended_reason"] == "REVOKED"
    assert journey["can_revoke"] is False and journey["can_enroll"] is True
    assert provider.revoked == [(world.a.company.id, ref)]
    again = reception.post(f"/visits/{visit_id}/tracking/revoke")
    assert again.status_code == 200 and again.json()["association"]["ended_reason"] == "REVOKED"
    assert len(provider.revoked) == 1
    [row] = audit_rows(db, "TRACKING_ASSOCIATION_REVOKED")
    assert row.actor_user_id == world.a.receptionist.id
    assert row.meta == {
        "association_id": journey["association"]["id"],
        "reason": "REVOKED",
        "trigger": "USER",
    }


def test_re_enrollment_makes_a_new_association_and_the_old_ref_stays_dead(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    clock: FakeClock,
) -> None:
    key = tracking_key(db, world.a.company, world.a.admin)
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    old = association_of(db, visit_id)
    reception.post(f"/visits/{visit_id}/tracking/revoke")
    clock.advance(seconds=5)
    renewed = enroll(reception, visit_id, places.reception_camera).json()["association"]
    assert renewed["id"] != str(old.id) and renewed["status"] == "ACTIVE"
    assert association_of(db, visit_id).ref != old.ref
    clock.advance(seconds=5)
    response = post_events(
        client, key, [observed(old.ref, places.upper_camera, clock.peek(), event_id="e-old")]
    )
    assert response.json()["results"] == [
        {"provider_event_id": "e-old", "result": "rejected", "reason": "ASSOCIATION_ENDED"}
    ]


def test_check_out_ends_it_in_the_same_transaction_and_late_events_are_refused(
    client: TestClient,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    clock: FakeClock,
) -> None:
    key = tracking_key(db, world.a.company, world.a.admin)
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    ref = association_of(db, visit_id).ref
    seen_before = clock.advance(minutes=5)
    clock.advance(minutes=1)
    response = check_out(reception, visit_id)
    assert response.status_code == 200, response.text
    association = association_of(db, visit_id)
    assert association.status == "ENDED" and association.ended_reason == "CHECKED_OUT"
    checked_out_at = datetime.fromisoformat(response.json()["check_out_at"].replace("Z", "+00:00"))
    assert association.ended_at == checked_out_at  # the check-out's own time, in its transaction
    assert provider.revoked == [(world.a.company.id, ref)]
    [ended] = audit_rows(db, "TRACKING_ASSOCIATION_ENDED")
    assert ended.meta["reason"] == "CHECKED_OUT" and ended.meta["trigger"] == "CHECK_OUT"
    assert ended.actor_user_id == world.a.receptionist.id
    clock.advance(seconds=10)
    results = post_events(
        client,
        key,
        [
            # Observed after the check-out: refused.
            observed(ref, places.upper_camera, clock.peek(), event_id="after"),
            # Observed before it, arriving late: kept in history, changing nothing.
            observed(ref, places.upper_camera, seen_before, event_id="before"),
        ],
    ).json()["results"]
    assert [(item["result"], item["reason"]) for item in results] == [
        ("rejected", "ASSOCIATION_ENDED"),
        ("accepted", None),
    ]
    journey = reception.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "ENDED" and journey["association"]["ended_reason"] == "CHECKED_OUT"
    assert [event["type"] for event in journey["timeline"]] == ["ENROLLED", "OBSERVED"]


def test_a_failed_check_out_leaves_the_association_open(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    refused = check_out(
        reception, visit_id, method="CORRECTED", check_out_at="2026-10-05T05:00:00Z", note="x"
    )
    assert refused.status_code == 422
    assert association_of(db, visit_id).status == "ACTIVE" and provider.revoked == []


def test_a_check_out_after_an_unswept_expiry_ends_it_at_its_expiry(
    make_client,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    clock: FakeClock,
) -> None:
    """B15-35: nothing read the journey since the association expired; the check-out ends it as what it
    was (EXPIRED at its expiry, by nobody), not as checked out half an hour after it ended."""
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    association = association_of(db, visit_id)
    clock.set(association.expires_at + timedelta(minutes=30))
    desk = signed_in(make_client, world.a.receptionist)
    response = check_out(desk, visit_id)
    assert response.status_code == 200, response.text
    ended = association_of(db, visit_id)
    assert ended.status == "ENDED" and ended.ended_reason == "EXPIRED"
    assert ended.ended_at == association.expires_at
    [row] = audit_rows(db, "TRACKING_ASSOCIATION_ENDED")
    assert row.meta["reason"] == "EXPIRED" and row.meta["trigger"] == "EXPIRY" and row.actor_user_id is None
    assert provider.revoked == [(world.a.company.id, association.ref)]


@pytest.mark.parametrize("change", ["check-out", "switch-off", "refused enrollment"])
def test_a_failure_to_count_a_provider_failure_never_fails_the_committed_change(
    make_client,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    change: str,
) -> None:
    """B15-37: the provider does not answer, and counting that fails too (the database went away for a
    moment): the change was committed before the provider was asked, so it is answered as done."""

    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError("the database went away")

    visit_id = inside_visit(host, reception, world.a.employee.id)
    if change == "refused enrollment":
        provider.fail_enroll = True
    else:
        enroll(reception, visit_id, places.reception_camera)
        provider.fail_revoke = True
    monkeypatch.setattr(TrackingHealthRepository, "count", broken)
    with caplog.at_level(logging.WARNING):
        if change == "check-out":
            response = check_out(reception, visit_id)
        elif change == "switch-off":
            response = signed_in(make_client, world.a.admin).patch(
                "/tracking/settings", json={"enabled": False}
            )
        else:
            response = enroll(reception, visit_id, places.reception_camera)
    assert response.status_code == 200, response.text
    association = association_of(db, visit_id)
    assert association.status == "ENDED"
    expected = {
        "check-out": "CHECKED_OUT",
        "switch-off": "REVOKED",
        "refused enrollment": "ENROLLMENT_FAILED",
    }
    assert association.ended_reason == expected[change]
    assert db.scalars(select(TrackingHealthCount)).all() == []
    [record] = [r for r in caplog.records if r.getMessage() == "counting a tracking provider failure failed"]
    assert record.error == "RuntimeError"  # type: ignore[attr-defined]  # the class only, never the message
    assert "the database went away" not in caplog.text


def test_the_bulk_check_out_ends_them_too(
    make_client,
    host: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    clock: FakeClock,
) -> None:
    # 23:00-23:30 in Amman (20:00-20:30Z): its pass window lasts until 00:30 the next day.
    late = TEST_START + timedelta(hours=14)
    visit_id = create_visit(host, world.a.employee.id, late)["visit"]["id"]
    clock.set(late)
    desk = signed_in(make_client, world.a.receptionist)
    assert check_in(desk, visit_id).status_code == 200
    enroll(desk, visit_id, places.reception_camera)
    association = association_of(db, visit_id)
    # 00:10 the next day: still inside, scheduled end passed, the association not expired yet.
    clock.set(late + timedelta(minutes=70))
    desk = signed_in(make_client, world.a.receptionist)
    response = desk.post("/reception/check-out-stale", json={"reason": "Forgot to check out"})
    assert response.status_code == 200 and response.json() == {"checked_out": 1}
    ended = association_of(db, visit_id)
    assert ended.id == association.id and ended.status == "ENDED" and ended.ended_reason == "CHECKED_OUT"
    assert provider.revoked == [(world.a.company.id, association.ref)]


def test_an_active_association_expires_twelve_hours_after_its_activation(
    make_client,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    clock: FakeClock,
) -> None:
    """B15-34: the visit's schedule no longer bounds it (this visit's pass window ends at 09:00Z); an
    expiry is checked on reads and ends it at `expires_at`."""
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    association = association_of(db, visit_id)
    assert association.activated_at is not None
    assert association.expires_at == association.activated_at + ASSOCIATION_MAX_LIFETIME
    clock.advance(hours=11, minutes=55)
    desk = signed_in(make_client, world.a.receptionist)
    assert desk.get(f"/visits/{visit_id}/journey").json()["association"]["status"] == "ACTIVE"
    clock.advance(minutes=10)
    journey = desk.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "ENDED"
    assert journey["association"]["ended_reason"] == "EXPIRED"
    assert journey["association"]["ended_at"] == journey["association"]["expires_at"]
    assert provider.revoked == [(world.a.company.id, association.ref)]
    [row] = audit_rows(db, "TRACKING_ASSOCIATION_ENDED")
    assert row.meta["reason"] == "EXPIRED" and row.actor_user_id is None


def test_a_pending_association_expires_after_ten_minutes_and_reception_can_start_again(
    app: FastAPI,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    tracking_on,
    db: Session,
    clock: FakeClock,
) -> None:
    """B15-34: an ENROLLED that never arrives (the provider lost it, or the enrollment camera was archived
    meanwhile) does not block the visit for hours."""
    with using_provider(app, SilentProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        pending = enroll(reception, visit_id, places.reception_camera).json()
        assert pending["state"] == "PENDING" and pending["enroll_blocker"] == "ALREADY_ENROLLED"
        association = association_of(db, visit_id)
        assert association.expires_at == association.created_at + PENDING_TIMEOUT
        clock.advance(minutes=9)
        assert reception.get(f"/visits/{visit_id}/journey").json()["state"] == "PENDING"
        clock.advance(minutes=2)
        expired = reception.get(f"/visits/{visit_id}/journey").json()
        assert expired["state"] == "ENDED" and expired["association"]["ended_reason"] == "EXPIRED"
        assert expired["can_enroll"] is True
        again = enroll(reception, visit_id, places.reception_camera).json()
        assert again["association"]["id"] != str(association.id) and again["state"] == "PENDING"


def test_a_provider_that_does_not_take_the_enrollment_ends_it_and_counts_it(
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    provider.fail_enroll = True
    visit_id = inside_visit(host, reception, world.a.employee.id)
    journey = enroll(reception, visit_id, places.reception_camera).json()
    assert journey["state"] == "ENDED" and journey["association"]["ended_reason"] == "ENROLLMENT_FAILED"
    assert journey["can_enroll"] is True
    counts = list(db.scalars(select(TrackingHealthCount)))
    assert [(row.reason, row.count) for row in counts] == [("PROVIDER_ENROLL_FAILED", 1)]
    provider.fail_enroll = False
    assert enroll(reception, visit_id, places.reception_camera).json()["association"]["status"] == "ACTIVE"


def test_a_provider_that_answers_later_leaves_it_pending(
    app: FastAPI, host: Api, reception: Api, world: World, places: Registry, tracking_on
) -> None:
    with using_provider(app, SilentProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        journey = enroll(reception, visit_id, places.reception_camera).json()
        assert journey["state"] == "PENDING" and journey["association"]["status"] == "PENDING"
        assert journey["association"]["activated_at"] is None


def test_a_failed_revoke_is_counted_and_the_association_stays_ended(
    make_client,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    provider.fail_revoke = True
    response = reception.post(f"/visits/{visit_id}/tracking/revoke")
    assert response.status_code == 200 and response.json()["association"]["status"] == "ENDED"
    counts = {row.reason: row.count for row in db.scalars(select(TrackingHealthCount))}
    assert counts == {"PROVIDER_REVOKE_FAILED": 1}
    admin = signed_in(make_client, world.a.admin)
    health = admin.get("/tracking/settings").json()["health"]
    assert health["provider_errors_last_24h"] == [{"operation": "REVOKE", "count": 1}]
    assert health["rejected_last_24h"] == []
    assert reception.get("/tracking/settings").status_code == 403


def test_switching_tracking_off_ends_every_open_association(
    make_client,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
) -> None:
    first = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, first, places.reception_camera)
    admin = signed_in(make_client, world.a.admin)
    response = admin.patch("/tracking/settings", json={"enabled": False})
    assert response.status_code == 200 and response.json()["enabled"] is False
    association = association_of(db, first)
    assert association.status == "ENDED" and association.ended_reason == "REVOKED"
    assert provider.revoked == [(world.a.company.id, association.ref)]
    [disabled_row] = audit_rows(db, "TRACKING_DISABLED")
    assert disabled_row.meta == {"revoked": 1}
    [ended] = audit_rows(db, "TRACKING_ASSOCIATION_ENDED")
    assert ended.meta["trigger"] == "TRACKING_DISABLED" and ended.actor_user_id == world.a.admin.id


def test_the_company_s_deactivation_ends_its_tracking(
    make_client,
    host: Api,
    reception: Api,
    world: World,
    places: Registry,
    provider: RecordingProvider,
    tracking_on,
    db: Session,
    factory,
) -> None:
    from tests.support import platform_signed_in

    visit_id = inside_visit(host, reception, world.a.employee.id)
    enroll(reception, visit_id, places.reception_camera)
    owner = platform_signed_in(make_client, factory.platform_admin())
    response = owner.post(f"/platform/companies/{world.a.company.id}/deactivate")
    assert response.status_code == 200
    association = association_of(db, visit_id)
    assert association.status == "ENDED" and association.ended_reason == "REVOKED"
    [ended] = audit_rows(db, "TRACKING_ASSOCIATION_ENDED")
    assert ended.meta["trigger"] == "COMPANY_DEACTIVATED" and ended.meta["source"] == "platform"
    [row] = audit_rows(db, "COMPANY_DEACTIVATED")
    assert row.meta["ended_tracking"] == 1


def test_events_are_stored_without_images_or_payloads(db: Session) -> None:
    """The events table has no column that could hold an image, a crop, an embedding or a payload."""
    columns = {column.name: str(column.type) for column in VisitorJourneyEvent.__table__.columns}
    assert not any(type_name.startswith(("BYTEA", "JSON", "BLOB", "TEXT")) for type_name in columns.values())
    assert set(columns) == {
        "id",
        "company_id",
        "visit_id",
        "association_id",
        "provider",
        "provider_event_id",
        "type",
        "camera_id",
        "building_id",
        "floor_id",
        "zone_id",
        "observed_at",
        "received_at",
        "match",
        "confidence",
        "model_version",
    }


def test_a_long_visit_s_association_also_expires_twelve_hours_after_activation(
    host: Api, reception: Api, world: World, places: Registry, provider, tracking_on, db: Session
) -> None:
    created = create_visit(host, world.a.employee.id, VISIT_START, minutes=20 * 60)
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    visit_id = created["visit"]["id"]
    enroll(reception, visit_id, places.reception_camera)
    association = association_of(db, visit_id)
    assert association.activated_at is not None
    assert association.expires_at - association.activated_at == timedelta(hours=12)
