"""The Visitor Journey's rules held by the database itself (revision 0018, Phase 15): tenant-safe composite
keys, one open association per visit, two live keys per company, the settings' invariant, append-only
events, and a migration that only adds (the previous release keeps working) and refuses to lose data on
its way down."""

import time
import uuid
from collections.abc import Callable
from datetime import timedelta

import pytest
from alembic import command
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core import time as app_time
from app.models import (
    CompanyTrackingSettings,
    TrackingAssociation,
    TrackingCamera,
    TrackingKey,
    VisitorJourneyEvent,
)
from app.services.tracking_rules import new_key, new_ref
from tests.integration.test_migrations import SCHEMA_QUERIES
from tests.support import Api, ThrowawayDatabase, World, alembic_config, signed_in
from tests.tracking_support import (
    RecordingProvider,
    inside_visit,
    registry,
    tracking_settings,
    using_provider,
)

NEW_TABLES = {
    "buildings",
    "floors",
    "zones",
    "tracking_cameras",
    "tracking_associations",
    "visitor_journey_events",
    "tracking_keys",
    "company_tracking_settings",
    "tracking_health",
    "tracking_health_counts",
}


def _insert(db: Session, row: object) -> None:
    db.add(row)
    db.flush()


def _fails(db: Session, row: object, constraint: str) -> None:
    with pytest.raises(IntegrityError) as caught, db.begin_nested():
        _insert(db, row)
    assert constraint in str(caught.value.orig.diag.constraint_name), caught.value  # type: ignore[union-attr]


def _association(
    company_id: uuid.UUID, visit_id: uuid.UUID, camera_id: uuid.UUID, user_id: uuid.UUID
) -> TrackingAssociation:
    now = app_time.now()
    return TrackingAssociation(
        company_id=company_id,
        visit_id=visit_id,
        ref=new_ref(),
        provider="simulator",
        enrollment_camera_id=camera_id,
        status="PENDING",
        created_by_id=user_id,
        expires_at=now + timedelta(hours=1),
        created_at=now,
        updated_at=now,
    )


def test_composite_keys_keep_every_reference_in_its_company(make_client, db: Session, world: World) -> None:
    mine = registry(db, world.a.company)
    other = registry(db, world.b.company, prefix="b-")
    host = signed_in(make_client, world.a.employee)
    reception = signed_in(make_client, world.a.receptionist)
    visit_id = uuid.UUID(inside_visit(host, reception, world.a.employee.id))
    now = app_time.now()
    # A camera in another company's zone.
    _fails(
        db,
        TrackingCamera(
            company_id=world.a.company.id,
            provider_camera_id="x",
            name="X",
            zone_id=other.office.id,
            created_at=now,
            updated_at=now,
        ),
        "fk_tracking_cameras_zone",
    )
    # An association enrolled at another company's camera, or made by another company's user.
    _fails(
        db,
        _association(world.a.company.id, visit_id, other.reception_camera.id, world.a.receptionist.id),
        "fk_tracking_associations_camera",
    )
    _fails(
        db,
        _association(world.a.company.id, visit_id, mine.reception_camera.id, world.b.receptionist.id),
        "fk_tracking_associations_user",
    )
    association = _association(
        world.a.company.id, visit_id, mine.reception_camera.id, world.a.receptionist.id
    )
    db.add(association)
    db.commit()

    def event(**overrides: object) -> VisitorJourneyEvent:
        values: dict[str, object] = {
            "company_id": world.a.company.id,
            "visit_id": visit_id,
            "association_id": association.id,
            "provider": "simulator",
            "provider_event_id": f"e-{uuid.uuid4().hex}",
            "type": "OBSERVED",
            "camera_id": mine.upper_camera.id,
            "building_id": mine.building.id,
            "floor_id": mine.upper.id,
            "zone_id": mine.office.id,
            "observed_at": now,
            "received_at": now,
            "match": "CONFIRMED",
        }
        values.update(overrides)
        return VisitorJourneyEvent(**values)

    # An event of another visit than its association's, a floor of another building, a zone of
    # another floor, a camera of another company.
    other_visit = uuid.UUID(inside_visit(host, reception, world.a.employee.id))
    _fails(db, event(visit_id=other_visit), "fk_journey_events_association")
    _fails(db, event(building_id=other.building.id), "fk_journey_events_floor")
    _fails(db, event(zone_id=mine.lobby.id), "fk_journey_events_zone")
    _fails(db, event(camera_id=other.upper_camera.id), "fk_journey_events_camera")
    _fails(db, event(match=None), "ck_visitor_journey_events_match_of_observation")
    _fails(db, event(camera_id=None), "ck_visitor_journey_events_camera_of_sighting")
    _fails(db, event(confidence=1.2), "ck_visitor_journey_events_confidence_range")
    db.add(event(provider_event_id="same"))
    db.commit()
    _fails(db, event(provider_event_id="same"), "uq_journey_events_provider_event")


def test_one_open_association_per_visit_and_a_well_formed_lifecycle(
    make_client, db: Session, world: World
) -> None:
    places = registry(db, world.a.company)
    host = signed_in(make_client, world.a.employee)
    reception = signed_in(make_client, world.a.receptionist)
    visit_id = uuid.UUID(inside_visit(host, reception, world.a.employee.id))
    first = _association(world.a.company.id, visit_id, places.reception_camera.id, world.a.receptionist.id)
    db.add(first)
    db.commit()
    _fails(
        db,
        _association(world.a.company.id, visit_id, places.reception_camera.id, world.a.receptionist.id),
        "uq_tracking_associations_open_visit",
    )
    bad_ref = _association(world.a.company.id, visit_id, places.reception_camera.id, world.a.receptionist.id)
    bad_ref.ref = f"trk_{visit_id.hex}"  # anything derived from the visit is not even well formed
    bad_ref.status = "ENDED"
    bad_ref.ended_at, bad_ref.ended_reason = app_time.now(), "REVOKED"
    _fails(db, bad_ref, "ck_tracking_associations_ref_format")
    half_ended = _association(
        world.a.company.id, visit_id, places.reception_camera.id, world.a.receptionist.id
    )
    half_ended.status = "ENDED"
    _fails(db, half_ended, "ck_tracking_associations_ended_status")
    first.status, first.ended_at, first.ended_reason = "ENDED", app_time.now(), "CHECKED_OUT"
    db.commit()
    # Once it ended, a new one may start.
    db.add(_association(world.a.company.id, visit_id, places.reception_camera.id, world.a.receptionist.id))
    db.commit()


def test_two_live_keys_at_most_and_the_settings_invariant(db: Session, world: World) -> None:
    def key(slot: int) -> TrackingKey:
        made = new_key()
        return TrackingKey(
            company_id=world.a.company.id,
            label="k",
            prefix=made.prefix,
            key_hash=made.digest,
            slot=slot,
            created_by_id=world.a.admin.id,
            created_at=app_time.now(),
        )

    db.add_all([key(1), key(2)])
    db.commit()
    _fails(db, key(1), "uq_tracking_keys_live_slot")
    _fails(db, key(3), "ck_tracking_keys_slot_valid")
    raw = key(1)
    raw.key_hash = "not-a-digest"
    _fails(db, raw, "ck_tracking_keys_key_hash_sha256")
    _fails(
        db,
        CompanyTrackingSettings(company_id=world.a.company.id, allowed=False, enabled=True),
        "ck_company_tracking_settings_enabled_only_when_allowed",
    )
    _fails(
        db,
        CompanyTrackingSettings(company_id=world.a.company.id, retention_days=91),
        "ck_company_tracking_settings_retention_days_range",
    )


# ---- the migration ---------------------------------------------------------------------------------


def _schema(engine: Engine) -> dict[str, list[tuple]]:
    with engine.connect() as connection:
        return {
            name: [tuple(row) for row in connection.execute(text(sql))]
            for name, sql in SCHEMA_QUERIES.items()
        }


def _without_new_tables(schema: dict[str, list[tuple]]) -> dict[str, list[tuple]]:
    return {name: [row for row in rows if row[0] not in NEW_TABLES] for name, rows in schema.items()}


def test_revision_0018_only_adds_and_goes_back_cleanly(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0018")
    config = alembic_config(database)
    command.upgrade(config, "0017")
    engine = create_engine(database.owner_url, poolclass=NullPool)
    try:
        before = _schema(engine)
        command.upgrade(config, "0018")
        after = _schema(engine)
        # Every table, column, constraint and index of revision 0017 is exactly as it was: the previous
        # release's code runs on this schema unchanged.
        assert _without_new_tables(after) == before
        assert {row[0] for row in after["columns"]} - {row[0] for row in before["columns"]} == NEW_TABLES
        command.downgrade(config, "0017")
        assert _schema(engine) == before
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM pg_proc WHERE proname = 'visitor_journey_events_immutable'")
                ).scalar_one()
                == 0
            )
        command.upgrade(config, "head")
        assert _schema(engine) == after
    finally:
        engine.dispose()


def test_the_downgrade_refuses_to_lose_what_was_entered(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0018_data")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = create_engine(database.owner_url, poolclass=NullPool)
    try:
        with engine.begin() as connection:
            company = uuid.uuid4()
            connection.execute(
                text("INSERT INTO companies (id, name, slug, timezone) VALUES (:id, 'Co', 'co-0018', 'UTC')"),
                {"id": company},
            )
            connection.execute(
                text("INSERT INTO company_tracking_settings (company_id) VALUES (:id)"), {"id": company}
            )
        command.downgrade(config, "0017")  # a settings row with the defaults holds nothing to lose
        command.upgrade(config, "head")
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO buildings (id, company_id, name) VALUES (gen_random_uuid(), :id, 'HQ')"),
                {"id": company},
            )
        with pytest.raises(RuntimeError, match="buildings: 1"):
            command.downgrade(config, "0017")
        with engine.connect() as connection:
            version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            assert version == "0018"
    finally:
        engine.dispose()


def test_the_0018_upgrade_gives_up_a_lock_it_cannot_get_and_leaves_nothing_behind(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """The independent review's migration probe, kept (B15-32): a write in flight on `visits` (a check-in
    not committed yet) holds the upgrade's foreign-key lock; the upgrade fails after its 5 s lock timeout
    instead of queueing every request behind it, and leaves nothing behind. Run again, it ends with the
    runtime role's grants on the new tables exactly as B15-1 and B15-9 say."""
    database = create_database("vms_0018_locks")
    config = alembic_config(database)
    command.upgrade(config, "0017")
    owner = create_engine(database.owner_url, poolclass=NullPool)
    runtime = create_engine(database.app_url, poolclass=NullPool)
    try:
        with runtime.connect() as writer:
            writer.execute(text("UPDATE visits SET updated_at = updated_at WHERE false"))  # stays open
            started = time.monotonic()
            with pytest.raises(OperationalError) as refused:
                command.upgrade(config, "0018")
            waited = time.monotonic() - started
            writer.rollback()
        assert getattr(refused.value.orig, "sqlstate", None) == "55P03"  # lock_not_available
        assert 4.5 <= waited < 30
        with owner.connect() as connection:
            assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0017"
            assert (
                connection.execute(text("SELECT to_regclass('public.tracking_associations')")).scalar()
                is None
            )
        command.upgrade(config, "0018")
        with owner.connect() as connection:
            grants = dict(
                connection.execute(
                    text(
                        "SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) "
                        "FROM information_schema.role_table_grants "
                        "WHERE grantee = :role AND table_name = ANY(:tables) GROUP BY table_name"
                    ),
                    {"role": database.app_role, "tables": sorted(NEW_TABLES)},
                ).all()
            )
            assert connection.execute(text("SELECT current_setting('lock_timeout')")).scalar_one() == "0"
        assert grants == {
            table: "INSERT,SELECT" if table == "visitor_journey_events" else "INSERT,SELECT,UPDATE"
            for table in NEW_TABLES
        }
    finally:
        owner.dispose()
        runtime.dispose()


def test_the_runtime_role_holds_no_update_on_events(app_engine: Engine) -> None:
    with app_engine.connect() as connection:
        privileges = set(
            connection.execute(
                text(
                    "SELECT privilege_type FROM information_schema.role_table_grants "
                    "WHERE grantee = current_user AND table_name = 'visitor_journey_events'"
                )
            ).scalars()
        )
        connection.rollback()
    assert privileges == {"SELECT", "INSERT"}


def test_simulated_enrollment_writes_through_the_runtime_role(
    app, make_client, db: Session, world: World
) -> None:
    """End to end on the runtime role: an enrollment, its event and the health row are written with
    nothing but SELECT, INSERT and UPDATE (and no UPDATE on events)."""
    places = registry(db, world.a.company)
    tracking_settings(db, world.a.company)
    host: Api = signed_in(make_client, world.a.employee)
    reception = signed_in(make_client, world.a.receptionist)
    with using_provider(app, RecordingProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        response = reception.post(
            f"/visits/{visit_id}/tracking/enroll", json={"camera_id": str(places.reception_camera.id)}
        )
    assert response.status_code == 200 and response.json()["state"] in {"STALE", "UNAVAILABLE", "ACTIVE"}


def test_an_update_of_an_event_is_refused_even_to_the_owner(owner_engine: Engine) -> None:
    with owner_engine.connect() as connection:
        with pytest.raises(DBAPIError, match="append-only"):
            connection.execute(text("UPDATE visitor_journey_events SET model_version = 'x'"))
        connection.rollback()
