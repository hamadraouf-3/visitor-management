"""Allowed areas and area alerts held by the database itself (revision 0019, Phase 16, B16-2, B16-6, B16-17,
B16-21): one active alert per visit, an alert's visit is its association's, an area is a floor or a zone,
a visit's live area is unique, nothing is deleted by the runtime role; a migration that only adds (the
previous release keeps working on it, its `prune-journeys` included), goes back cleanly, and refuses to
lose what was entered; and a prune that locks in a batch's order. Revision 0020 (B16-26) only adds
`tracking_alerts.escalated_at`, read back from the audit log for the alerts escalated before it."""

import threading
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta

import pytest
from alembic import command
from pydantic import SecretStr
from sqlalchemy import Engine, create_engine, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app import cli
from app.core import time as app_time
from app.core.config import Settings
from app.db.session import create_db_engine
from app.models import AuditLog, TrackingAlert, TrackingAssociation, VisitAccessArea, VisitorJourneyEvent
from app.services.tracking_maintenance import PruneResult, prune_journeys
from tests.integration.test_migrations import SCHEMA_QUERIES
from tests.integration.test_tracking_cli import _company_with_history
from tests.integration.test_tracking_races import WAIT, _Threads
from tests.support import Api, ThrowawayDatabase, World, alembic_config, signed_in
from tests.tracking_support import (
    AreaRegistry,
    RecordingProvider,
    area_registry,
    association_of,
    enroll,
    inside_visit,
    tracking_settings,
    using_provider,
)

# The newest revision: where a refused downgrade leaves the database (the whole downgrade is one
# transaction), and where `upgrade head` brings it.
HEAD = "0020"
NEW_TABLES = {"visit_access_areas", "tracking_alerts"}
NEW_COLUMNS = {
    ("zones", "access"),
    ("departments", "floor_id"),
    ("company_tracking_settings", "area_alerts_enabled"),
    ("company_tracking_settings", "alert_notify_host"),
    ("company_tracking_settings", "alert_emails"),
}
NEW_CONSTRAINTS_OF_OLD_TABLES = {
    ("zones", "ck_zones_access_valid"),
    ("departments", "fk_departments_floor"),
    ("company_tracking_settings", "ck_company_tracking_settings_alert_emails_count"),
    # PostgreSQL 18 lists a NOT NULL column's constraint in pg_constraint too.
    ("zones", "zones_access_not_null"),
    ("company_tracking_settings", "company_tracking_settings_area_alerts_enabled_not_null"),
    ("company_tracking_settings", "company_tracking_settings_alert_notify_host_not_null"),
    ("company_tracking_settings", "company_tracking_settings_alert_emails_not_null"),
}
CHANGED_CONSTRAINTS = {("email_messages", "ck_email_messages_kind_valid")}


def _schema(engine: Engine) -> dict[str, list[tuple]]:
    with engine.connect() as connection:
        return {
            name: [tuple(row) for row in connection.execute(text(sql))]
            for name, sql in SCHEMA_QUERIES.items()
        }


def test_revision_0019_only_adds_and_goes_back_cleanly(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0019")
    config = alembic_config(database)
    command.upgrade(config, "0018")
    engine = create_engine(database.owner_url, poolclass=NullPool)
    try:
        before = _schema(engine)
        command.upgrade(config, "0019")
        after = _schema(engine)
        # Columns: the five new ones, and the new tables'; every other column exactly as it was.
        old_columns = {(row[0], row[1]): row for row in before["columns"]}
        new_columns = {(row[0], row[1]): row for row in after["columns"]}
        added = set(new_columns) - set(old_columns)
        assert {key for key in added if key[0] not in NEW_TABLES} == NEW_COLUMNS
        assert {key[0] for key in added} - {"zones", "departments", "company_tracking_settings"} == NEW_TABLES
        assert all(new_columns[key] == row for key, row in old_columns.items())
        # A new column is nullable or has a default: the previous release's inserts still work.
        for key in NEW_COLUMNS:
            row = new_columns[key]
            assert row[4] == "YES" or row[5] is not None, key
        # Constraints: the old ones as they were (the e-mail kinds' CHECK admits one more kind), plus the new.
        old_constraints = {(row[0], row[1]): row[2] for row in before["constraints"]}
        new_constraints = {(row[0], row[1]): row[2] for row in after["constraints"]}
        for key, definition in old_constraints.items():
            if key in CHANGED_CONSTRAINTS:
                assert "TRACKING_ALERT" in new_constraints[key] and "TRACKING_ALERT" not in definition
                assert new_constraints[key].replace(", 'TRACKING_ALERT'::character varying", "") == definition
            else:
                assert new_constraints[key] == definition, key
        added_constraints = set(new_constraints) - set(old_constraints)
        assert {key for key in added_constraints if key[0] not in NEW_TABLES} == NEW_CONSTRAINTS_OF_OLD_TABLES
        # Indexes: only the new tables'.
        old_indexes = {(row[0], row[1]): row[2] for row in before["indexes"]}
        new_indexes = {(row[0], row[1]): row[2] for row in after["indexes"]}
        assert all(new_indexes[key] == definition for key, definition in old_indexes.items())
        assert {key[0] for key in set(new_indexes) - set(old_indexes)} == NEW_TABLES
        command.downgrade(config, "0018")
        assert _schema(engine) == before
        command.upgrade(config, "0019")
        assert _schema(engine) == after
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("statement", "held"),
    [
        ("UPDATE zones SET access = 'RESTRICTED'", "zones not STANDARD: 1"),
        ("UPDATE departments SET floor_id = (SELECT id FROM floors LIMIT 1)", "departments with a floor: 1"),
        ("UPDATE company_tracking_settings SET area_alerts_enabled = false", "alert settings: 1"),
        ("UPDATE company_tracking_settings SET alert_emails = '{guard@example.com}'", "alert settings: 1"),
    ],
)
def test_the_0019_downgrade_refuses_to_lose_what_was_entered(
    create_database: Callable[[str], ThrowawayDatabase], statement: str, held: str
) -> None:
    database = create_database("vms_migration_0019_data")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = create_engine(database.owner_url, poolclass=NullPool)
    company = uuid.uuid4()
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO companies (id, name, slug, timezone) VALUES (:id, 'Co', 'co-0019', 'UTC')"),
                {"id": company},
            )
            connection.execute(
                text("INSERT INTO company_tracking_settings (company_id) VALUES (:id)"), {"id": company}
            )
            connection.execute(
                text("INSERT INTO departments (id, company_id, name) VALUES (gen_random_uuid(), :id, 'Ops')"),
                {"id": company},
            )
            building = connection.execute(
                text(
                    "INSERT INTO buildings (id, company_id, name) "
                    "VALUES (gen_random_uuid(), :id, 'HQ') RETURNING id"
                ),
                {"id": company},
            ).scalar_one()
            floor = connection.execute(
                text(
                    "INSERT INTO floors (id, company_id, building_id, name, level) "
                    "VALUES (gen_random_uuid(), :id, :building, 'G', 0) RETURNING id"
                ),
                {"id": company, "building": building},
            ).scalar_one()
            connection.execute(
                text(
                    "INSERT INTO zones (id, company_id, floor_id, name) "
                    "VALUES (gen_random_uuid(), :id, :floor, 'L')"
                ),
                {"id": company, "floor": floor},
            )
        # The previous release's rows (no new column named) got the defaults, and hold nothing of 0019.
        command.downgrade(config, "0018")
        command.upgrade(config, "head")
        with engine.begin() as connection:
            connection.execute(text(statement))
        with pytest.raises(RuntimeError, match=held):
            command.downgrade(config, "0018")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == HEAD
    finally:
        engine.dispose()


# ---- revision 0020: when an alert escalated (B16-26) ------------------------------------------------------


def test_revision_0020_only_adds_escalated_at_and_goes_back_cleanly(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0020")
    config = alembic_config(database)
    command.upgrade(config, "0019")
    engine = create_engine(database.owner_url, poolclass=NullPool)
    try:
        before = _schema(engine)
        command.upgrade(config, "0020")
        after = _schema(engine)
        # One column more, nullable and without a default: no table is rewritten, and the previous release's
        # inserts (which never name it) still work. Every other column, constraint and index as it was.
        old_columns = {(row[0], row[1]): row for row in before["columns"]}
        new_columns = {(row[0], row[1]): row for row in after["columns"]}
        assert set(new_columns) - set(old_columns) == {("tracking_alerts", "escalated_at")}
        # data_type, character_maximum_length, is_nullable, column_default
        assert new_columns[("tracking_alerts", "escalated_at")][2:6] == (
            "timestamp with time zone",
            None,
            "YES",
            None,
        )
        assert all(new_columns[key] == row for key, row in old_columns.items())
        assert after["constraints"] == before["constraints"]
        assert after["indexes"] == before["indexes"]
        # The runtime role's table-level privileges cover the new column: nothing to grant.
        with engine.connect() as connection:
            for privilege in ("SELECT", "INSERT", "UPDATE"):
                assert connection.execute(
                    text("SELECT has_column_privilege(:role, 'tracking_alerts', 'escalated_at', :privilege)"),
                    {"role": database.app_role, "privilege": privilege},
                ).scalar_one(), privilege
        command.downgrade(config, "0019")
        assert _schema(engine) == before
        command.upgrade(config, "0020")
        assert _schema(engine) == after
    finally:
        engine.dispose()


# ---- the rules ----------------------------------------------------------------------------------------


@pytest.fixture
def tracked(app, make_client, db: Session, world: World) -> tuple[AreaRegistry, str]:
    """An enrolled visit and the company's area registry."""
    places = area_registry(db, world.a.company)
    tracking_settings(db, world.a.company)
    host: Api = signed_in(make_client, world.a.employee)
    reception = signed_in(make_client, world.a.receptionist)
    with using_provider(app, RecordingProvider()):
        visit_id = inside_visit(host, reception, world.a.employee.id)
        enroll(reception, visit_id, places.reception_camera)
    return places, visit_id


def _alert(db: Session, world: World, places: AreaRegistry, visit_id: str, **values: object) -> TrackingAlert:
    association = association_of(db, visit_id)
    now = app_time.now()
    fields: dict[str, object] = {
        "company_id": world.a.company.id,
        "visit_id": uuid.UUID(visit_id),
        "association_id": association.id,
        "type": "UNAUTHORIZED_AREA",
        "status": "OPEN",
        "simulated": True,
        "first_building_id": places.building.id,
        "first_floor_id": places.fourth.id,
        "first_zone_id": places.office.id,
        "last_building_id": places.building.id,
        "last_floor_id": places.fourth.id,
        "last_zone_id": places.office.id,
        "opened_at": now,
        "last_seen_at": now,
        "created_at": now,
        "updated_at": now,
    }
    fields.update(values)
    return TrackingAlert(**fields)


def _insert(db: Session, row: object) -> None:
    db.add(row)
    db.flush()


def _fails(db: Session, row: object, constraint: str) -> None:
    with pytest.raises(IntegrityError) as caught, db.begin_nested():
        _insert(db, row)
    assert constraint in str(caught.value.orig.diag.constraint_name), caught.value  # type: ignore[union-attr]


def test_one_active_alert_per_visit_and_its_visit_is_its_association_s(
    tracked: tuple[AreaRegistry, str], db: Session, world: World, factory
) -> None:
    places, visit_id = tracked
    first = _alert(db, world, places, visit_id)
    db.add(first)
    db.commit()
    _fails(db, _alert(db, world, places, visit_id), "uq_tracking_alerts_active_visit")
    _fails(
        db,
        _alert(db, world, places, visit_id, status="ACKNOWLEDGED", acknowledged_at=app_time.now()),
        "uq_tracking_alerts_active_visit",
    )
    first.status, first.resolved_at, first.resolution = "RESOLVED", app_time.now(), "MANUAL"
    db.commit()
    db.add(_alert(db, world, places, visit_id))  # once resolved, a new one may open
    db.commit()
    # The visit is the association's; the location consistent; the company's own (resolved alerts, so the
    # open one above does not stand in the way).
    resolved = {"status": "RESOLVED", "resolved_at": app_time.now(), "resolution": "MANUAL"}
    elsewhere = _alert(db, world, places, visit_id, **resolved)
    elsewhere.visit_id = uuid.uuid4()
    _fails(db, elsewhere, "fk_tracking_alerts_association")
    _fails(
        db,
        _alert(db, world, places, visit_id, last_floor_id=places.second.id, **resolved),
        "fk_tracking_alerts_last",
    )
    other = area_registry(db, world.b.company, prefix="b-")
    _fails(
        db,
        _alert(
            db,
            world,
            places,
            visit_id,
            first_building_id=other.building.id,
            first_floor_id=other.fourth.id,
            first_zone_id=other.office.id,
            **resolved,
        ),
        "fk_tracking_alerts_first",
    )


@pytest.mark.parametrize(
    ("values", "constraint"),
    [
        ({"status": "RESOLVED"}, "ck_tracking_alerts_resolved_status"),
        ({"resolved_at": None, "resolution": "MANUAL"}, "ck_tracking_alerts_resolution_set"),
        ({"status": "ACKNOWLEDGED"}, "ck_tracking_alerts_acknowledged_set"),
        ({"acknowledged_at": app_time.now()}, "ck_tracking_alerts_open_unacknowledged"),
        ({"observations": 0}, "ck_tracking_alerts_observations_positive"),
        ({"type": "SOMEWHERE"}, "ck_tracking_alerts_type_valid"),
        ({"note": "  "}, "ck_tracking_alerts_note_not_blank"),
    ],
)
def test_an_alert_s_checks(
    tracked: tuple[AreaRegistry, str], db: Session, world: World, values: dict, constraint: str
) -> None:
    places, visit_id = tracked
    if "opened_at" not in values:
        values = {**values}
    _fails(db, _alert(db, world, places, visit_id, **values), constraint)
    later = app_time.now() + timedelta(minutes=1)
    _fails(db, _alert(db, world, places, visit_id, opened_at=later), "ck_tracking_alerts_seen_after_opened")


def test_an_area_is_a_floor_or_a_zone_and_a_live_area_is_unique(
    tracked: tuple[AreaRegistry, str], db: Session, world: World
) -> None:
    places, visit_id = tracked
    visit = uuid.UUID(visit_id)
    company = world.a.company.id
    _fails(db, VisitAccessArea(company_id=company, visit_id=visit), "ck_visit_access_areas_one_area")
    _fails(
        db,
        VisitAccessArea(
            company_id=company, visit_id=visit, floor_id=places.second.id, zone_id=places.meeting.id
        ),
        "ck_visit_access_areas_one_area",
    )
    db.add(VisitAccessArea(company_id=company, visit_id=visit, floor_id=places.second.id))
    db.commit()
    _fails(
        db,
        VisitAccessArea(company_id=company, visit_id=visit, floor_id=places.second.id),
        "uq_visit_access_areas_live_floor",
    )
    other = area_registry(db, world.b.company, prefix="b-")
    _fails(
        db,
        VisitAccessArea(company_id=company, visit_id=visit, zone_id=other.office.id),
        "fk_visit_access_areas_zone",
    )


def test_the_runtime_role_deletes_no_alert_and_no_area(app_engine: Engine) -> None:
    with app_engine.connect() as connection:
        for table in ("tracking_alerts", "visit_access_areas"):
            with pytest.raises(DBAPIError, match="permission denied"):
                connection.execute(text(f"DELETE FROM {table}"))  # noqa: S608 - this test's table names
            connection.rollback()


# What revision 0018's `prune-journeys` runs (Phase 15's code, which knows nothing of the alerts).
PRUNE_EVENTS_0018 = text(
    """
    DELETE FROM visitor_journey_events e
    USING (
        SELECT c.id AS company_id, coalesce(s.retention_days, :default_days) AS retention_days
        FROM companies c LEFT JOIN company_tracking_settings s ON s.company_id = c.id
    ) r
    WHERE e.company_id = r.company_id
      AND e.observed_at < CAST(:now AS timestamptz) - make_interval(days => r.retention_days)
    RETURNING e.id
    """
)
PRUNE_ASSOCIATIONS_0018 = text(
    """
    DELETE FROM tracking_associations a
    USING (
        SELECT c.id AS company_id, coalesce(s.retention_days, :default_days) AS retention_days
        FROM companies c LEFT JOIN company_tracking_settings s ON s.company_id = c.id
    ) r
    WHERE a.company_id = r.company_id
      AND a.status = 'ENDED'
      AND a.ended_at < CAST(:now AS timestamptz) - make_interval(days => r.retention_days)
      AND NOT EXISTS (SELECT 1 FROM visitor_journey_events e WHERE e.association_id = a.id)
    RETURNING a.id
    """
)


def _old_association_alert(
    db: Session,
    company_id: uuid.UUID,
    *,
    updated_days_ago: int,
    now: datetime,
    escalated_at: datetime | None = None,
) -> uuid.UUID:
    """A resolved alert on the company's older ended association (`_company_with_history`), last changed
    `updated_days_ago` days ago, escalated at `escalated_at` when given (revision 0020); returns the
    association's ID."""
    association = db.scalars(
        select(TrackingAssociation)
        .where(TrackingAssociation.company_id == company_id)
        .order_by(TrackingAssociation.created_at)
    ).first()
    assert association is not None
    event = db.scalars(
        select(VisitorJourneyEvent).where(VisitorJourneyEvent.association_id == association.id)
    ).first()
    assert event is not None
    at = now - timedelta(days=updated_days_ago)
    db.add(
        TrackingAlert(
            company_id=company_id,
            visit_id=association.visit_id,
            association_id=association.id,
            type="UNAUTHORIZED_AREA" if escalated_at is None else "RESTRICTED_AREA",
            status="RESOLVED",
            simulated=True,
            first_building_id=event.building_id,
            first_floor_id=event.floor_id,
            first_zone_id=event.zone_id,
            last_building_id=event.building_id,
            last_floor_id=event.floor_id,
            last_zone_id=event.zone_id,
            opened_at=event.observed_at,
            last_seen_at=event.observed_at,
            escalated_at=escalated_at,
            resolved_at=at,
            resolution="MANUAL",
            created_at=at,
            updated_at=at,
        )
    )
    db.commit()
    return association.id


@pytest.fixture
def owner(create_database: Callable[[str], ThrowawayDatabase]):
    database = create_database("vms_prune_alerts")
    command.upgrade(alembic_config(database), "head")
    engine = create_db_engine(database.owner_url, pool_size=1, application_name="vms-tests-prune-alerts")
    try:
        yield database, engine
    finally:
        engine.dispose()


def test_the_previous_release_s_prune_still_works_once_alerts_exist(owner, clock) -> None:
    """Revision 0018's `prune-journeys` deletes an ended association that an alert refers to without an
    error: the alert goes with it (ON DELETE CASCADE, B16-17), an escalated one (revision 0020's column
    set) included."""
    _database, engine = owner
    now = clock.peek()
    with Session(engine) as db:
        company = _company_with_history(db, "old-prune", now, retention_days=None)
        association = _old_association_alert(
            db, company, updated_days_ago=1, now=now, escalated_at=now - timedelta(days=2)
        )
    with engine.begin() as connection:
        parameters = {"now": now, "default_days": 30}
        connection.execute(PRUNE_EVENTS_0018, parameters)
        deleted = [row.id for row in connection.execute(PRUNE_ASSOCIATIONS_0018, parameters)]
    assert deleted == [association]
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM tracking_alerts")).scalar_one() == 0


def test_prune_journeys_deletes_old_alerts_first_and_keeps_an_association_a_recent_one_needs(
    owner, settings: Settings, clock, capsys
) -> None:
    database, engine = owner
    now = clock.peek()
    with Session(engine) as db:
        stale = _company_with_history(db, "stale-alert", now, retention_days=None)
        # Escalated (revision 0020): the prune goes by the last change, whatever the alert's columns.
        _old_association_alert(db, stale, updated_days_ago=35, now=now, escalated_at=now - timedelta(days=36))
        recent = _company_with_history(db, "recent-alert", now, retention_days=None)
        kept = _old_association_alert(db, recent, updated_days_ago=1, now=now)
    maintenance = settings.model_copy(update={"migration_database_url": SecretStr(database.owner_url)})
    assert cli.main(["prune-journeys"], settings=maintenance) == 0
    assert (
        "tracking alerts deleted: 1; journey events deleted: 2; ended tracking associations deleted: 1"
        in capsys.readouterr().out
    )
    with engine.connect() as connection:
        alerts = connection.execute(text("SELECT company_id, association_id FROM tracking_alerts")).all()
        assert alerts == [(recent, kept)]
        assert (
            connection.execute(
                text("SELECT count(*) FROM tracking_associations WHERE id = :id"), {"id": kept}
            ).scalar_one()
            == 1
        )


def test_revision_0020_reads_an_earlier_escalation_back_from_the_audit_log(owner, clock) -> None:
    """B16-26: an alert escalated before revision 0020 (here: escalated, then the column dropped by a
    downgrade, which refuses nothing) gets the time of its escalation from its TRACKING_ALERT_ESCALATED
    audit row; an alert that never escalated stays NULL, whatever other action names it or whatever
    another company's escalation row says."""
    database, engine = owner
    now = clock.peek()
    escalated_at = now - timedelta(days=3)
    with Session(engine) as db:
        company = _company_with_history(db, "escalated-0020", now, retention_days=None)
        other = _company_with_history(db, "other-0020", now, retention_days=None)
        _old_association_alert(db, company, updated_days_ago=1, now=now)
        _old_association_alert(db, company, updated_days_ago=1, now=now, escalated_at=escalated_at)
        alerts = {
            alert.type: alert
            for alert in db.scalars(select(TrackingAlert).where(TrackingAlert.company_id == company))
        }
        plain, escalated = alerts["UNAUTHORIZED_AREA"], alerts["RESTRICTED_AREA"]

        def audited(company_id: uuid.UUID, action: str, alert: TrackingAlert, at: datetime) -> AuditLog:
            return AuditLog(
                company_id=company_id,
                action=action,
                entity_type="visit",
                entity_id=alert.visit_id,
                meta={"alert_id": str(alert.id), "type": alert.type},
                created_at=at,
            )

        db.add_all(
            [
                audited(company, "TRACKING_ALERT_OPENED", plain, now - timedelta(days=4)),
                audited(company, "TRACKING_ALERT_OPENED", escalated, now - timedelta(days=4)),
                audited(company, "TRACKING_ALERT_ESCALATED", escalated, escalated_at),
                # Another company's row that names this company's alert is not its escalation.
                audited(other, "TRACKING_ALERT_ESCALATED", plain, now - timedelta(days=2)),
            ]
        )
        db.commit()
        expected = {plain.id: None, escalated.id: escalated_at}
    config = alembic_config(database)
    command.downgrade(config, "0019")
    command.upgrade(config, "0020")
    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT id, escalated_at FROM tracking_alerts WHERE company_id = :company"),
            {"company": company},
        )
        values = {row.id: row.escalated_at for row in rows}
    assert values == expected


def _a_backend_waits_for_a_lock(engine: Engine) -> bool:
    """Whether a backend of the engine's database is (soon) waiting for a row lock."""
    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        with engine.connect() as connection:
            waiting = connection.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )
            ).scalar_one()
        if waiting:
            return True
        time.sleep(0.05)
    return False


def test_the_prune_locks_an_ended_association_before_deleting_its_alert(owner, clock) -> None:
    """B16-17 (found in review): an ingested batch locks its associations (an ended one it names included)
    and then its visits' alerts (B16-7). The prune locks the ended associations it may delete before it
    deletes any alert, so a batch and the prune queue at the association. Here a transaction takes the
    batch's locks in the batch's order: the old ended association, then, once the prune waits, the old
    alert. A prune that deleted the alert first would hold it while waiting for the association, and
    PostgreSQL would end one of the two with a deadlock."""
    database, engine = owner
    now = clock.peek()
    with Session(engine) as db:
        company = _company_with_history(db, "prune-lock-order", now, retention_days=None)
        association = _old_association_alert(db, company, updated_days_ago=35, now=now)
        alert = db.scalars(select(TrackingAlert.id).where(TrackingAlert.association_id == association)).one()
    batch_engine = create_engine(database.owner_url, poolclass=NullPool)
    holding, release = threading.Event(), threading.Event()
    threads = _Threads()

    def batch() -> uuid.UUID | None:
        with batch_engine.begin() as connection:
            connection.execute(text("SET LOCAL lock_timeout = '10s'"))
            connection.execute(
                text("SELECT id FROM tracking_associations WHERE id = :id FOR UPDATE"), {"id": association}
            )
            holding.set()
            release.wait(WAIT)
            return connection.execute(
                text("SELECT id FROM tracking_alerts WHERE id = :id FOR UPDATE"), {"id": alert}
            ).scalar_one_or_none()

    try:
        threads.start("batch", batch)
        assert holding.wait(WAIT)
        threads.start("prune", lambda: prune_journeys(engine, now=now))
        try:
            assert _a_backend_waits_for_a_lock(batch_engine), "the prune should wait for the batch"
        finally:
            release.set()
            threads.join()
    finally:
        batch_engine.dispose()
    assert threads.errors == {}
    # The batch had the alert (the prune had not touched it); then the prune deleted all it should.
    assert threads.results["batch"] == alert
    assert threads.results["prune"] == PruneResult(events=1, associations=1, alerts=1)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM tracking_alerts")).scalar_one() == 0
        assert (
            connection.execute(
                text("SELECT count(*) FROM tracking_associations WHERE id = :id"), {"id": association}
            ).scalar_one()
            == 0
        )
