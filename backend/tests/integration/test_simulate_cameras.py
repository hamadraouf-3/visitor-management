"""`cli simulate-journey --cameras` (Phase 16, B16-20): the given provider camera IDs walked in order, one
observation each, the last one now, so a test can bring a visitor into a given zone; the area alerts that
raises, e-mailed by the command after the batch's commit; refusals."""

from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import cli
from app.core.config import Settings
from app.core.time import FakeClock
from app.models import EmailMessage, TrackingAlert
from tests.support import World, create_visit, signed_in
from tests.tracking_support import (
    VISIT_START,
    RecordingProvider,
    area_registry,
    areas,
    association_of,
    enroll,
    tracking_settings,
    using_provider,
)


@pytest.fixture
def simulator_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"tracking_provider": "simulator"})


def _enrolled_visit(app: FastAPI, make_client, world: World, db: Session) -> tuple[str, Any, Any]:
    places = area_registry(db, world.a.company)
    tracking_settings(db, world.a.company, min_confidence=0.8)
    host, reception = signed_in(make_client, world.a.employee), signed_in(make_client, world.a.receptionist)
    visit_id = create_visit(
        host, world.a.employee.id, VISIT_START, access_areas=areas(floors=(places.second,))
    )["visit"]["id"]
    with using_provider(app, RecordingProvider()):
        assert reception.post(f"/visits/{visit_id}/check-in", json={"method": "MANUAL"}).status_code == 200
        enroll(reception, visit_id, places.reception_camera)
    return visit_id, places, reception


def test_the_cameras_are_walked_in_order_and_the_alert_is_e_mailed(
    app: FastAPI,
    make_client,
    world: World,
    db: Session,
    simulator_settings: Settings,
    clock: FakeClock,
    capsys,
) -> None:
    visit_id, _places, reception = _enrolled_visit(app, make_client, world, db)
    clock.advance(minutes=10)
    args = [
        "simulate-journey",
        "--visit",
        visit_id,
        "--cameras",
        "cam-2f, cam-4f",
        "--confidence",
        "0.9",
    ]
    assert cli.main(args, settings=simulator_settings) == 0
    out = capsys.readouterr().out
    assert "accepted: 2" in out and "marked Simulated" in out
    assert "tracking alert e-mails: 1 (1 delivered)" in out  # the host
    with using_provider(app, RecordingProvider()):
        journey = reception.get(f"/visits/{visit_id}/journey").json()
    observed = [event for event in journey["timeline"] if event["type"] == "OBSERVED"]
    assert [event["camera"]["name"] for event in observed] == ["Second floor", "Fourth floor"]
    # The default interval (120 s) apart: more than the conflict window, so the fourth floor is the place.
    assert journey["state"] == "ACTIVE" and journey["last_location"]["floor"]["level"] == 4
    db.expire_all()
    [alert] = db.scalars(select(TrackingAlert)).all()
    assert (alert.status, alert.type, alert.simulated) == ("OPEN", "UNAUTHORIZED_AREA", True)
    [message] = db.scalars(select(EmailMessage).where(EmailMessage.kind == "TRACKING_ALERT")).all()
    assert message.status == "SENT" and message.to_email == world.a.employee.email


def test_one_camera_right_after_the_enrollment_is_seen_now(
    app: FastAPI, make_client, world: World, db: Session, simulator_settings: Settings, capsys
) -> None:
    visit_id, places, _reception = _enrolled_visit(app, make_client, world, db)
    args = ["simulate-journey", "--visit", visit_id, "--cameras", "cam-4f-server", "--confidence", "0.9"]
    assert cli.main(args, settings=simulator_settings) == 0
    assert "accepted: 1" in capsys.readouterr().out
    db.expire_all()
    [alert] = db.scalars(select(TrackingAlert)).all()
    assert alert.type == "RESTRICTED_AREA" and alert.last_zone_id == places.server.id


def test_the_cameras_option_s_refusals(
    app: FastAPI, make_client, world: World, db: Session, simulator_settings: Settings, capsys
) -> None:
    visit_id, _places, _reception = _enrolled_visit(app, make_client, world, db)
    base = ["simulate-journey", "--visit", visit_id]
    assert cli.main([*base, "--cameras", "cam-2f,cam-unknown"], settings=simulator_settings) == cli.EXIT_USAGE
    assert "not a camera of the visit's company: cam-unknown" in capsys.readouterr().err
    other = area_registry(db, world.b.company, prefix="b-")
    assert (
        cli.main([*base, "--cameras", other.office_camera.provider_camera_id], settings=simulator_settings)
        == 2
    )
    assert "not a camera of the visit's company" in capsys.readouterr().err
    assert (
        cli.main([*base, "--cameras", "cam-2f", "--steps", "2"], settings=simulator_settings)
        == cli.EXIT_USAGE
    )
    assert "--steps must be the number of --cameras" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        cli.main([*base, "--cameras", "cam-2f,,cam-4f"], settings=simulator_settings)
    production = simulator_settings.model_copy(update={"app_env": "production"})
    assert cli.main([*base, "--cameras", "cam-2f"], settings=production) == cli.EXIT_USAGE
    assert "not available when APP_ENV=production" in capsys.readouterr().err
    assert association_of(db, visit_id).status == "ACTIVE"
    db.expire_all()
    assert db.scalars(select(TrackingAlert)).all() == []
