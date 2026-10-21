"""`cli prune-journeys` (retention, as the schema owner) and `cli simulate-journey` (synthetic events
through the ingestion service, non-production) (Phase 15, B15-7, B15-21)."""

import uuid
from collections.abc import Callable, Iterator
from datetime import datetime, timedelta

import pytest
from alembic import command
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import Engine, func, select, text
from sqlalchemy.orm import Session

from app import cli
from app.core.config import Settings
from app.core.time import FakeClock
from app.db.session import create_db_engine
from app.models import (
    Company,
    CompanyTrackingSettings,
    TrackingAssociation,
    User,
    Visit,
    Visitor,
    VisitorJourneyEvent,
)
from app.services.tracking_rules import new_ref
from tests.support import ThrowawayDatabase, World, alembic_config, signed_in
from tests.tracking_support import (
    RecordingProvider,
    Registry,
    association_of,
    enroll,
    inside_visit,
    registry,
    tracking_settings,
    using_provider,
)

# ---- prune-journeys ---------------------------------------------------------------------------------


@pytest.fixture
def owner(create_database: Callable[[str], ThrowawayDatabase]) -> Iterator[tuple[ThrowawayDatabase, Engine]]:
    database = create_database("vms_prune_journeys")
    command.upgrade(alembic_config(database), "head")
    engine = create_db_engine(database.owner_url, pool_size=1, application_name="vms-tests-prune")
    try:
        yield database, engine
    finally:
        engine.dispose()


def _company_with_history(db: Session, slug: str, now: datetime, *, retention_days: int | None) -> uuid.UUID:
    """A company with one visit, an ended association with an old and a recent event, and an older ended
    association whose only event is old."""
    company = Company(name=slug, slug=slug, timezone="UTC")
    db.add(company)
    db.flush()
    if retention_days is not None:
        db.add(CompanyTrackingSettings(company_id=company.id, retention_days=retention_days))
    user = User(
        company_id=company.id,
        full_name="Host",
        email=f"host@{slug}.example.com",
        password_hash="x",
        roles=["EMPLOYEE"],
    )
    visitor = Visitor(company_id=company.id, full_name="Guest", search_text="guest", name_sort="guest")
    db.add_all([user, visitor])
    db.flush()
    places = registry(db, company)
    start = now - timedelta(days=60)
    visit = Visit(
        company_id=company.id,
        visitor_id=visitor.id,
        host_id=user.id,
        created_by_id=user.id,
        purpose="Review",
        scheduled_start=start,
        scheduled_end=now + timedelta(days=1),
        window_start=start,
        window_end=now + timedelta(days=1),
        visitor_name="Guest",
        host_name="Host",
    )
    db.add(visit)
    db.flush()
    for index, (created, ended, observed) in enumerate(
        (
            (now - timedelta(days=50), now - timedelta(days=40), [now - timedelta(days=45)]),
            (
                now - timedelta(days=10),
                now - timedelta(days=1),
                [now - timedelta(days=8), now - timedelta(days=2)],
            ),
        )
    ):
        association = TrackingAssociation(
            company_id=company.id,
            visit_id=visit.id,
            ref=new_ref(),
            provider="simulator",
            enrollment_camera_id=places.reception_camera.id,
            status="ENDED",
            created_by_id=user.id,
            activated_at=created,
            ended_at=ended,
            ended_reason="CHECKED_OUT",
            expires_at=created + timedelta(hours=12),
            created_at=created,
            updated_at=ended,
        )
        db.add(association)
        db.flush()
        for number, at in enumerate(observed):
            db.add(
                VisitorJourneyEvent(
                    company_id=company.id,
                    visit_id=visit.id,
                    association_id=association.id,
                    provider="simulator",
                    provider_event_id=f"{slug}-{index}-{number}",
                    type="OBSERVED",
                    camera_id=places.upper_camera.id,
                    building_id=places.building.id,
                    floor_id=places.upper.id,
                    zone_id=places.office.id,
                    observed_at=at,
                    received_at=at,
                    match="CONFIRMED",
                )
            )
    db.commit()
    return company.id


def test_prune_journeys_keeps_each_company_s_retention(
    owner: tuple[ThrowawayDatabase, Engine], settings: Settings, clock: FakeClock, capsys
) -> None:
    database, engine = owner
    now = clock.peek()
    with Session(engine) as db:
        default = _company_with_history(db, "default-co", now, retention_days=None)  # 30 days
        short = _company_with_history(db, "short-co", now, retention_days=5)
    maintenance = settings.model_copy(update={"migration_database_url": SecretStr(database.owner_url)})
    assert cli.main(["prune-journeys"], settings=maintenance) == 0
    out = capsys.readouterr().out
    # Default company: the 45-day-old event and its association (ended 40 days ago) go.
    # Short company: also the 8-day-old event; its association ended a day ago and keeps the recent one.
    assert "journey events deleted: 3; ended tracking associations deleted: 2" in out
    with Session(engine) as db:
        remaining = {
            company: db.scalar(select(func.count()).where(VisitorJourneyEvent.company_id == company))
            for company in (default, short)
        }
        assert remaining == {default: 2, short: 1}
        assert db.scalar(select(func.count()).select_from(TrackingAssociation)) == 2
    assert cli.main(["prune-journeys"], settings=maintenance) == 0
    assert "journey events deleted: 0; ended tracking associations deleted: 0" in capsys.readouterr().out


def test_the_runtime_role_cannot_delete_or_rewrite_journey_events(
    app_engine: Engine, owner_engine: Engine
) -> None:
    with app_engine.connect() as connection:
        for statement in (
            "DELETE FROM visitor_journey_events",
            "UPDATE visitor_journey_events SET match = NULL",
        ):
            with pytest.raises(Exception, match="permission denied"):
                connection.execute(text(statement))
            connection.rollback()
    with owner_engine.connect() as connection:
        with pytest.raises(Exception, match="append-only"):
            connection.execute(text("UPDATE visitor_journey_events SET match = NULL"))
        connection.rollback()


# ---- simulate-journey -------------------------------------------------------------------------------


@pytest.fixture
def simulator_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"tracking_provider": "simulator"})


def test_simulate_journey_walks_the_cameras_through_the_ingestion_service(
    app: FastAPI,
    make_client,
    world: World,
    db: Session,
    simulator_settings: Settings,
    clock: FakeClock,
    capsys,
) -> None:
    places: Registry = registry(db, world.a.company)
    tracking_settings(db, world.a.company, min_confidence=0.8)
    host, reception = signed_in(make_client, world.a.employee), signed_in(make_client, world.a.receptionist)
    with using_provider(app, RecordingProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
        clock.advance(minutes=10)  # the visitor walks about for a while
        args = ["simulate-journey", "--visit", visit_id, "--steps", "4", "--confidence", "0.9"]
        assert cli.main(args, settings=simulator_settings) == 0
        out = capsys.readouterr().out
        assert "accepted: 4" in out and "marked Simulated" in out
        journey = reception.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "ACTIVE" and journey["association"]["simulated"] is True
    timeline = journey["timeline"]
    assert [event["type"] for event in timeline] == [
        "ENROLLED",
        "OBSERVED",
        "OBSERVED",
        "OBSERVED",
        "OBSERVED",
    ]
    assert {event["model_version"] for event in timeline} == {"simulator"}
    # The walk passes the non-enrollment cameras in name order: Lobby east, Third floor, ...
    assert [event["camera"]["name"] for event in timeline[1:]] == ["Lobby east", "Third floor"] * 2
    assert journey["last_location"]["floor"]["level"] == 3


def test_simulate_journey_right_after_enrollment_stays_on_one_floor(
    app: FastAPI, make_client, world: World, db: Session, simulator_settings: Settings, capsys
) -> None:
    """Steps squeezed into the few seconds since the enrollment never put the visitor on two floors within
    a minute, so the simulator never makes a journey UNCERTAIN by itself."""
    places = registry(db, world.a.company)
    tracking_settings(db, world.a.company, min_confidence=0.8)
    host, reception = signed_in(make_client, world.a.employee), signed_in(make_client, world.a.receptionist)
    with using_provider(app, RecordingProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
        args = ["simulate-journey", "--visit", visit_id, "--steps", "3", "--confidence", "0.9"]
        assert cli.main(args, settings=simulator_settings) == 0
        assert "accepted: 3" in capsys.readouterr().out
        journey = reception.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "ACTIVE"
    assert {event["camera"]["name"] for event in journey["timeline"][1:]} == {"Lobby east"}


def test_simulate_journey_without_a_confidence_confirms_nothing(
    app: FastAPI, make_client, world: World, db: Session, simulator_settings: Settings
) -> None:
    places = registry(db, world.a.company)
    tracking_settings(db, world.a.company)
    host, reception = signed_in(make_client, world.a.employee), signed_in(make_client, world.a.receptionist)
    with using_provider(app, RecordingProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
        assert cli.main(["simulate-journey", "--visit", visit_id], settings=simulator_settings) == 0
        journey = reception.get(f"/visits/{visit_id}/journey").json()
    assert journey["state"] == "UNCERTAIN" and journey["last_location"] is None


def test_simulate_journey_refusals(
    app: FastAPI,
    make_client,
    world: World,
    db: Session,
    settings: Settings,
    simulator_settings: Settings,
    capsys,
) -> None:
    places = registry(db, world.a.company)
    tracking_settings(db, world.a.company)
    host, reception = signed_in(make_client, world.a.employee), signed_in(make_client, world.a.receptionist)
    visit_id = inside_visit(host, reception, world.a.employee.id)
    production = simulator_settings.model_copy(update={"app_env": "production"})
    assert cli.main(["simulate-journey", "--visit", visit_id], settings=production) == cli.EXIT_USAGE
    assert "not available when APP_ENV=production" in capsys.readouterr().err
    assert cli.main(["simulate-journey", "--visit", visit_id], settings=settings) == cli.EXIT_USAGE
    assert "TRACKING_PROVIDER=simulator" in capsys.readouterr().err
    assert cli.main(["simulate-journey", "--visit", visit_id], settings=simulator_settings) == cli.EXIT_USAGE
    assert "enroll it first" in capsys.readouterr().err
    with using_provider(app, RecordingProvider()):
        enroll(reception, visit_id, places.reception_camera)
    for extra in (["--steps", "0"], ["--steps", "100"], ["--confidence", "1.5"]):
        assert cli.main(["simulate-journey", "--visit", visit_id, *extra], settings=simulator_settings) == 2
    association = association_of(db, visit_id)
    association.provider = "other"
    db.commit()
    assert cli.main(["simulate-journey", "--visit", visit_id], settings=simulator_settings) == cli.EXIT_USAGE
    assert "not made by the simulator" in capsys.readouterr().err
