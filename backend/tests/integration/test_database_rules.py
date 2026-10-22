"""Database-level guarantees (contract §4): grants, immutability triggers, CHECKs, tenant FKs."""

import uuid
from collections.abc import Iterator
from datetime import timedelta

import psycopg
import pytest
from psycopg.errors import InsufficientPrivilege
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.time import FakeClock
from app.models import Role
from tests.support import Factory, World


def _expect_failure(connection: Connection, statement: str, params: dict | None = None) -> DBAPIError:
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as caught:
        connection.execute(text(statement), params or {})
    savepoint.rollback()
    return caught.value


def _insert_audit_row(connection: Connection) -> uuid.UUID:
    row_id = uuid.uuid4()
    connection.execute(
        text("INSERT INTO audit_logs (id, action, created_at) VALUES (:id, 'TEST_EVENT', :now)"),
        {"id": row_id, "now": "2026-10-05T06:00:00Z"},
    )
    return row_id


# ---- audit_logs immutability --------------------------------------------------------------------


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE audit_logs SET action = 'TAMPERED' WHERE id = :id",
        "DELETE FROM audit_logs WHERE id = :id",
        "TRUNCATE audit_logs",
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable",
        "ALTER TABLE audit_logs DISABLE TRIGGER ALL",
        "DROP TABLE audit_logs",
    ],
)
def test_runtime_role_cannot_modify_audit_logs(connection: Connection, statement: str) -> None:
    row_id = _insert_audit_row(connection)
    error = _expect_failure(connection, statement, {"id": row_id} if ":id" in statement else None)
    assert "permission denied" in str(error.orig).lower() or "must be owner" in str(error.orig).lower()
    remaining = connection.execute(text("SELECT action FROM audit_logs WHERE id = :id"), {"id": row_id})
    assert remaining.scalar_one() == "TEST_EVENT"


@pytest.fixture
def owner_connection(owner_engine: Engine) -> Iterator[Connection]:
    connection = owner_engine.connect()
    transaction = connection.begin()
    try:
        yield connection
    finally:
        transaction.rollback()
        connection.close()


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE audit_logs SET action = 'TAMPERED' WHERE id = :id",
        "DELETE FROM audit_logs WHERE id = :id",
        "TRUNCATE audit_logs",
    ],
)
def test_trigger_blocks_even_the_owner(owner_connection: Connection, statement: str) -> None:
    row_id = _insert_audit_row(owner_connection)
    error = _expect_failure(owner_connection, statement, {"id": row_id} if ":id" in statement else None)
    assert "append-only" in str(error.orig)


def test_runtime_role_can_insert_and_read_audit_logs(connection: Connection) -> None:
    row_id = _insert_audit_row(connection)
    seq = connection.execute(text("SELECT seq FROM audit_logs WHERE id = :id"), {"id": row_id}).scalar_one()
    assert seq > 0


def test_runtime_role_has_no_ddl_or_truncate(connection: Connection) -> None:
    _expect_failure(connection, "CREATE TABLE intruder (id int)")
    _expect_failure(connection, "TRUNCATE users")
    _expect_failure(connection, "ALTER TABLE users ADD COLUMN intruder int")


@pytest.mark.parametrize(
    "statement",
    ["CREATE TEMP TABLE intruder (id int)", "CREATE TEMPORARY VIEW intruder AS SELECT 1 AS id"],
)
def test_runtime_role_cannot_create_temporary_objects(connection: Connection, statement: str) -> None:
    # TEMPORARY is granted to PUBLIC on every new database; revision 0008 revokes it (SEC-22), and so do
    # scripts/db.ps1 and the test harness (`test_migrations` checks a database the harness did not touch).
    error = _expect_failure(connection, statement)
    assert "permission denied" in str(error.orig).lower()
    privileges = connection.execute(
        text("SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY')")
    )
    assert privileges.scalar_one() is False


def test_runtime_role_privileges_match_contract(connection: Connection) -> None:
    rows = connection.execute(
        text(
            """
            SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
            FROM information_schema.role_table_grants
            WHERE grantee = current_user AND table_schema = 'public'
            GROUP BY table_name
            """
        )
    ).all()
    grants = dict(rows)
    # audit_logs: SELECT on the table, INSERT on every column but `seq` (revision 0008, SEC-21).
    assert grants.pop("audit_logs") == "SELECT"
    # The platform's trail likewise (revision 0013, B11-4).
    assert grants.pop("platform_audit_logs") == "SELECT"
    assert grants.pop("alembic_version", None) is None
    # The visitor journey's events are append-only: no UPDATE either (revision 0018, B15-9).
    assert grants.pop("visitor_journey_events") == "INSERT,SELECT"
    # No DELETE anywhere (revision 0006): the application deletes nothing (D-12).
    assert set(grants.values()) == {"INSERT,SELECT,UPDATE"}
    # The nine tables of revisions 0001-0012, platform_admins, platform_sessions and
    # email_template_overrides (revision 0013), company_brand_assets (revision 0015), the nine other
    # tables of the visitor journey (revision 0018), and visit_access_areas and tracking_alerts (revision
    # 0019, Phase 16): SELECT, INSERT, UPDATE from the schema's default privileges.
    assert len(grants) == 24 and "company_brand_assets" in grants and "tracking_associations" in grants
    assert grants["visit_access_areas"] == grants["tracking_alerts"] == "INSERT,SELECT,UPDATE"
    insertable = connection.execute(
        text(
            "SELECT column_name FROM information_schema.column_privileges "
            "WHERE grantee = current_user AND table_name = 'audit_logs' AND privilege_type = 'INSERT'"
        )
    ).scalars()
    assert set(insertable) == {
        "id",
        "company_id",
        "actor_user_id",
        "action",
        "entity_type",
        "entity_id",
        "metadata",
        "ip_address",
        "user_agent",
        "request_id",
        "created_at",
    }
    sequence = connection.execute(
        text(
            "SELECT has_sequence_privilege(current_user, 'audit_logs_seq_seq', 'USAGE'), "
            "has_sequence_privilege(current_user, 'audit_logs_seq_seq', 'UPDATE')"
        )
    ).one()
    assert tuple(sequence) == (False, False)


@pytest.mark.parametrize(
    "statement",
    [
        # A chosen `seq` would place a forged row anywhere in the audit order, or claim the next values
        # so that every later audit write fails (SEC-21).
        "INSERT INTO audit_logs (id, seq, action, created_at) OVERRIDING SYSTEM VALUE "
        "VALUES (gen_random_uuid(), 0, 'FORGED_PAST', '2020-01-01Z')",
        "INSERT INTO audit_logs (id, seq, action, created_at) OVERRIDING SYSTEM VALUE "
        "SELECT gen_random_uuid(), (SELECT max(seq) FROM audit_logs) + n, 'CLAIMED', now() "
        "FROM generate_series(1, 40) AS n",
        "SELECT nextval('audit_logs_seq_seq')",
        "SELECT setval('audit_logs_seq_seq', 1000000)",
    ],
)
def test_runtime_role_cannot_choose_audit_sequence_values(connection: Connection, statement: str) -> None:
    error = _expect_failure(connection, statement)
    assert "permission denied" in str(error.orig).lower()
    row_id = _insert_audit_row(connection)  # the normal insert still draws its own `seq`
    seq = connection.execute(text("SELECT seq FROM audit_logs WHERE id = :id"), {"id": row_id}).scalar_one()
    assert seq > 0


def _copy_forged_row(driver_connection: psycopg.Connection) -> None:
    with driver_connection.cursor().copy("COPY audit_logs (id, seq, action, created_at) FROM STDIN") as copy:
        copy.write_row((uuid.uuid4(), -5, "FORGED_COPY", "2019-01-01T00:00:00Z"))


def test_runtime_role_cannot_copy_chosen_audit_sequence_values(app_engine: Engine) -> None:
    raw = app_engine.raw_connection()
    driver_connection = raw.driver_connection
    assert isinstance(driver_connection, psycopg.Connection)
    try:
        with pytest.raises(InsufficientPrivilege):
            _copy_forged_row(driver_connection)
    finally:
        driver_connection.rollback()
        raw.close()


def test_tables_created_later_follow_the_runtime_grants(
    owner_connection: Connection, connection: Connection
) -> None:
    role = connection.execute(text("SELECT current_user")).scalar_one()
    owner_connection.execute(text("CREATE TABLE later_table (id int)"))
    privileges = {
        privilege: owner_connection.execute(
            text("SELECT has_table_privilege(:role, 'later_table', :privilege)"),
            {"role": role, "privilege": privilege},
        ).scalar_one()
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")
    }
    assert privileges == {"SELECT": True, "INSERT": True, "UPDATE": True, "DELETE": False, "TRUNCATE": False}


# ---- users / roles ------------------------------------------------------------------------------


def test_roles_check_rejects_unknown_and_empty(world: World, connection: Connection) -> None:
    for roles in ("{SUPERUSER}", "{}", "{EMPLOYEE,ROOT}"):
        error = _expect_failure(
            connection,
            "UPDATE users SET roles = CAST(:roles AS text[]) WHERE id = :id",
            {"roles": roles, "id": world.a.employee.id},
        )
        assert "ck_users_roles_valid" in str(error.orig)


def test_email_must_be_lowercase(world: World, connection: Connection) -> None:
    error = _expect_failure(
        connection, "UPDATE users SET email = 'Upper@Example.com' WHERE id = :id", {"id": world.a.employee.id}
    )
    assert "ck_users_email_lowercase" in str(error.orig)


def test_user_cannot_reference_other_company_department(world: World, connection: Connection) -> None:
    error = _expect_failure(
        connection,
        "UPDATE users SET department_id = :department WHERE id = :id",
        {"department": world.b.finance.id, "id": world.a.employee.id},
    )
    assert "fk_users_company_id_department_id_departments" in str(error.orig)


def test_department_name_unique_case_insensitive(world: World, connection: Connection) -> None:
    error = _expect_failure(
        connection,
        "INSERT INTO departments (id, company_id, name, created_at, updated_at) "
        "VALUES (:id, :company, 'FINANCE', now(), now())",
        {"id": uuid.uuid4(), "company": world.a.company.id},
    )
    assert "uq_departments_company_name" in str(error.orig)


# ---- visits -------------------------------------------------------------------------------------


@pytest.fixture
def visit_ids(factory: Factory, world: World, clock: FakeClock) -> dict:
    db = factory.db
    visitor_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO visitors (id, company_id, full_name, search_text, name_sort, created_by_id, "
            "created_at, updated_at) "
            "VALUES (:id, :company, 'Visitor One', 'visitor one', 'visitor one', :creator, :now, :now)"
        ),
        {
            "id": visitor_id,
            "company": world.a.company.id,
            "creator": world.a.employee.id,
            "now": clock.peek(),
        },
    )
    db.commit()
    return {"visitor": visitor_id, "company": world.a.company.id, "host": world.a.employee.id}


def _insert_visit(connection: Connection, ids: dict, start, **columns) -> uuid.UUID:
    visit_id = uuid.uuid4()
    values = {
        "id": visit_id,
        "company_id": ids["company"],
        "visitor_id": ids["visitor"],
        "host_id": ids["host"],
        "created_by_id": ids["host"],
        "purpose": "Meeting",
        "scheduled_start": start,
        "scheduled_end": start + timedelta(hours=1),
        "window_start": start - timedelta(hours=1),
        "window_end": start + timedelta(hours=2),
        "status": "SCHEDULED",
        "visitor_name": "Visitor One",
        "host_name": "Host",
        "created_at": start,
        "updated_at": start,
        **columns,
    }
    names = ", ".join(values)
    placeholders = ", ".join(f":{name}" for name in values)
    connection.execute(text(f"INSERT INTO visits ({names}) VALUES ({placeholders})"), values)  # noqa: S608
    return visit_id


@pytest.mark.parametrize("status", ["CHECKED_OUT", "SCHEDULED"])
def test_runtime_role_cannot_delete_visits(
    connection: Connection, visit_ids: dict, clock: FakeClock, status: str
) -> None:
    start = clock.peek()
    columns = (
        _materialise(CHECKED_OUT, start, visit_ids["host"]) if status == "CHECKED_OUT" else {"status": status}
    )
    visit_id = _insert_visit(connection, visit_ids, start, **columns)
    error = _expect_failure(connection, "DELETE FROM visits WHERE id = :id", {"id": visit_id})
    assert "permission denied" in str(error.orig).lower()
    remaining = connection.execute(text("SELECT status FROM visits WHERE id = :id"), {"id": visit_id})
    assert remaining.scalar_one() == status


@pytest.mark.parametrize(
    "table",
    [
        "companies",
        "departments",
        "users",
        "user_sessions",
        "password_reset_tokens",
        "visitors",
        "visits",
        "visitor_passes",
        "email_messages",
    ],
)
def test_runtime_role_cannot_delete_or_truncate_any_table(connection: Connection, table: str) -> None:
    for statement in (f"DELETE FROM {table}", f"TRUNCATE {table}"):  # noqa: S608
        error = _expect_failure(connection, statement)
        assert "permission denied" in str(error.orig).lower()


def test_terminal_visits_are_immutable(connection: Connection, visit_ids: dict, clock: FakeClock) -> None:
    start = clock.peek()
    checked_out = _insert_visit(
        connection,
        visit_ids,
        start,
        status="CHECKED_OUT",
        check_in_at=start,
        checked_in_by_id=visit_ids["host"],
        check_in_method="MANUAL",
        check_out_at=start + timedelta(minutes=30),
        checked_out_by_id=visit_ids["host"],
        check_out_method="MANUAL",
    )
    cancelled = _insert_visit(
        connection,
        visit_ids,
        start,
        status="CANCELLED",
        cancelled_at=start,
        cancellation_reason="Changed plans",
    )
    for visit_id in (checked_out, cancelled):
        error = _expect_failure(
            connection, "UPDATE visits SET purpose = 'Edited' WHERE id = :id", {"id": visit_id}
        )
        assert "can no longer be modified" in str(error.orig)

    scheduled = _insert_visit(connection, visit_ids, start)
    connection.execute(text("UPDATE visits SET purpose = 'Edited' WHERE id = :id"), {"id": scheduled})


HOST = object()  # placeholder for the host's user ID in the parametrised rows below
CHECKED_IN = {"status": "CHECKED_IN", "check_in_at": 0, "checked_in_by_id": HOST, "check_in_method": "MANUAL"}
CHECKED_OUT = {
    **CHECKED_IN,
    "status": "CHECKED_OUT",
    "check_out_at": 30,
    "checked_out_by_id": HOST,
    "check_out_method": "MANUAL",
}


def _materialise(columns: dict, start, host_id) -> dict:
    """Minutes after `start` become timestamps; HOST becomes the host's ID."""
    values = {}
    for name, value in columns.items():
        if value is HOST:
            value = host_id
        elif name.endswith(("_at", "_start", "_end")) and isinstance(value, int):
            value = start + timedelta(minutes=value)
        values[name] = value
    return values


# Each row breaks exactly one rule, in both directions of the two-way CHECKs (contract §4).
@pytest.mark.parametrize(
    ("columns", "constraint"),
    [
        ({"status": "LOST"}, "ck_visits_status_valid"),
        ({"scheduled_end": 0}, "ck_visits_schedule_order"),
        ({"window_start": 1}, "ck_visits_window_covers_schedule"),
        ({"window_end": 30}, "ck_visits_window_covers_schedule"),
        # status <-> check-in
        ({"status": "CHECKED_IN"}, "ck_visits_check_in_status"),
        ({**CHECKED_IN, "status": "SCHEDULED"}, "ck_visits_check_in_status"),
        ({**CHECKED_IN, "checked_in_by_id": None}, "ck_visits_check_in_by"),
        ({"checked_in_by_id": HOST}, "ck_visits_check_in_by"),
        ({**CHECKED_IN, "check_in_method": None}, "ck_visits_check_in_method_set"),
        ({"check_in_method": "MANUAL"}, "ck_visits_check_in_method_set"),
        # status <-> check-out
        ({**CHECKED_IN, "status": "CHECKED_OUT"}, "ck_visits_check_out_status"),
        ({**CHECKED_OUT, "status": "CHECKED_IN"}, "ck_visits_check_out_status"),
        ({**CHECKED_OUT, "checked_out_by_id": None}, "ck_visits_check_out_by"),
        ({**CHECKED_IN, "checked_out_by_id": HOST}, "ck_visits_check_out_by"),
        ({**CHECKED_OUT, "check_out_method": None}, "ck_visits_check_out_method_set"),
        ({**CHECKED_IN, "check_out_method": "MANUAL"}, "ck_visits_check_out_method_set"),
        ({**CHECKED_OUT, "check_out_at": -1}, "ck_visits_check_out_after_check_in"),
        # cancellation and no-show
        ({"status": "CANCELLED"}, "ck_visits_cancelled_status"),
        ({"cancelled_at": 0}, "ck_visits_cancelled_status"),
        ({"cancellation_reason": "Why"}, "ck_visits_cancel_fields"),
        ({"status": "NO_SHOW"}, "ck_visits_no_show_at_set"),
        # walk-ins
        ({"is_walk_in": True, "walk_in_reason": "Lost pass"}, "ck_visits_walk_in_method"),
        ({**CHECKED_IN, "check_in_method": "WALK_IN"}, "ck_visits_walk_in_method"),
        ({"walk_in_reason": "Lost pass"}, "ck_visits_walk_in_reason"),
        (
            {**CHECKED_IN, "check_in_method": "WALK_IN", "is_walk_in": True},
            "ck_visits_walk_in_reason",
        ),
    ],
)
def test_visit_lifecycle_checks(
    connection: Connection, visit_ids: dict, clock: FakeClock, columns: dict, constraint: str
) -> None:
    start = clock.peek()
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError) as caught:
        _insert_visit(connection, visit_ids, start, **_materialise(columns, start, visit_ids["host"]))
    savepoint.rollback()
    assert constraint in str(caught.value.orig)


@pytest.mark.parametrize(
    ("columns", "note_column", "constraint"),
    [
        ({**CHECKED_IN, "check_in_method": "OVERRIDE"}, "check_in_note", "ck_visits_override_note"),
        ({**CHECKED_OUT, "check_out_method": "CORRECTED"}, "check_out_note", "ck_visits_check_out_note"),
        ({**CHECKED_OUT, "check_out_method": "BULK"}, "check_out_note", "ck_visits_check_out_note"),
    ],
)
def test_override_corrected_and_bulk_require_notes(
    connection: Connection,
    visit_ids: dict,
    clock: FakeClock,
    columns: dict,
    note_column: str,
    constraint: str,
) -> None:
    start = clock.peek()
    values = _materialise(columns, start, visit_ids["host"])
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match=constraint):
        _insert_visit(connection, visit_ids, start, **values)
    savepoint.rollback()
    _insert_visit(connection, visit_ids, start, **values, **{note_column: "Reason given"})


def test_consistent_lifecycle_rows_are_accepted(
    connection: Connection, visit_ids: dict, clock: FakeClock
) -> None:
    start = clock.peek()
    host = visit_ids["host"]
    _insert_visit(connection, visit_ids, start, **_materialise(CHECKED_OUT, start, host))
    _insert_visit(
        connection, visit_ids, start, status="CANCELLED", cancelled_at=start, cancellation_reason="x"
    )
    _insert_visit(connection, visit_ids, start, status="NO_SHOW", no_show_at=start)
    walk_in = {**CHECKED_IN, "check_in_method": "WALK_IN", "is_walk_in": True, "walk_in_reason": "Lost pass"}
    _insert_visit(connection, visit_ids, start, **_materialise(walk_in, start, host))


def test_visitor_cannot_be_inside_twice(connection: Connection, visit_ids: dict, clock: FakeClock) -> None:
    start = clock.peek()
    inside = {
        "status": "CHECKED_IN",
        "check_in_at": start,
        "checked_in_by_id": visit_ids["host"],
        "check_in_method": "MANUAL",
    }
    _insert_visit(connection, visit_ids, start, **inside)
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="uq_visits_visitor_inside"):
        _insert_visit(connection, visit_ids, start, **inside)
    savepoint.rollback()


def test_visit_cannot_reference_other_company_host(
    connection: Connection, visit_ids: dict, world: World, clock: FakeClock
) -> None:
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="fk_visits_company_id_host_id_users"):
        _insert_visit(connection, {**visit_ids, "host": world.b.employee.id}, clock.peek())
    savepoint.rollback()


def test_only_one_active_pass_per_visit(connection: Connection, visit_ids: dict, clock: FakeClock) -> None:
    visit_id = _insert_visit(connection, visit_ids, clock.peek())
    insert = (
        "INSERT INTO visitor_passes (id, company_id, visit_id, token_hash, created_at) "
        "VALUES (:id, :company, :visit, :hash, now())"
    )
    connection.execute(
        text(insert),
        {"id": uuid.uuid4(), "company": visit_ids["company"], "visit": visit_id, "hash": "a" * 64},
    )
    error = _expect_failure(
        connection,
        insert,
        {"id": uuid.uuid4(), "company": visit_ids["company"], "visit": visit_id, "hash": "b" * 64},
    )
    assert "uq_passes_active_visit" in str(error.orig)


def test_session_rows_follow_their_user(world: World, connection: Connection) -> None:
    error = _expect_failure(
        connection,
        "INSERT INTO user_sessions (id, user_id, company_id, token_hash, csrf_token_hash, expires_at, "
        "last_seen_at, created_at) VALUES (:id, :user, :company, :t, :c, now(), now(), now())",
        {
            "id": uuid.uuid4(),
            "user": world.a.employee.id,
            "company": world.b.company.id,
            "t": "c" * 64,
            "c": "d" * 64,
        },
    )
    assert "fk_user_sessions_company_id_user_id_users" in str(error.orig)


def test_role_enum_values_match_check_constraint(connection: Connection) -> None:
    definition = connection.execute(
        text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_users_roles_valid'")
    ).scalar_one()
    for role in Role:
        assert role.value in definition


# ---- constraint-name mapping used by services for concurrent duplicates -------------------------


def test_unique_violation_constraint_names(world: World, factory: Factory) -> None:
    from app.db.errors import unique_violation_constraint
    from app.models import Department, User

    db = factory.db
    factory.department(world.a.company, "Treasury", name_ar="الخزينة")
    cases = [
        (Department(company_id=world.a.company.id, name="finance"), "uq_departments_company_name"),
        (
            Department(company_id=world.a.company.id, name="Vault", name_ar="الخزينة"),
            "uq_departments_company_name_ar",
        ),
        (
            User(
                company_id=world.a.company.id,
                full_name="Duplicate",
                email=world.b.employee.email,
                password_hash="x",
                roles=["EMPLOYEE"],
            ),
            "uq_users_email",
        ),
    ]
    for entity, constraint in cases:
        savepoint = db.begin_nested()
        db.add(entity)
        with pytest.raises(IntegrityError) as caught:
            db.flush()
        savepoint.rollback()
        assert unique_violation_constraint(caught.value) == constraint

    savepoint = db.begin_nested()
    db.add(Department(company_id=world.a.company.id, name="   "))
    with pytest.raises(IntegrityError) as caught:
        db.flush()
    savepoint.rollback()
    assert unique_violation_constraint(caught.value) is None  # a CHECK violation, not a duplicate


@pytest.mark.parametrize(
    ("revoked_at", "revoke_reason"),
    [(True, None), (False, "ROTATED")],
    ids=["revoked_without_reason", "reason_without_revocation"],
)
def test_pass_revocation_is_consistent(
    connection: Connection, visit_ids: dict, clock: FakeClock, revoked_at: bool, revoke_reason: str | None
) -> None:
    visit_id = _insert_visit(connection, visit_ids, clock.peek())
    error = _expect_failure(
        connection,
        "INSERT INTO visitor_passes "
        "(id, company_id, visit_id, token_hash, revoked_at, revoke_reason, created_at) "
        "VALUES (:id, :company, :visit, :hash, :revoked_at, :reason, now())",
        {
            "id": uuid.uuid4(),
            "company": visit_ids["company"],
            "visit": visit_id,
            "hash": "e" * 64,
            "revoked_at": clock.peek() if revoked_at else None,
            "reason": revoke_reason,
        },
    )
    assert "ck_visitor_passes_revocation_consistent" in str(error.orig)


def _insert_visitor(connection: Connection, company_id, email: str | None) -> None:
    connection.execute(
        text(
            "INSERT INTO visitors (id, company_id, full_name, email, search_text, name_sort, created_at, "
            "updated_at) VALUES (:id, :company, 'Guest', :email, 'guest', 'guest', now(), now())"
        ),
        {"id": uuid.uuid4(), "company": company_id, "email": email},
    )


def test_visitor_email_is_unique_per_company(connection: Connection, world: World) -> None:
    _insert_visitor(connection, world.a.company.id, "guest@example.com")
    error = _expect_failure(
        connection,
        "INSERT INTO visitors (id, company_id, full_name, email, search_text, name_sort, created_at, "
        "updated_at) VALUES (:id, :company, 'Guest Two', 'guest@example.com', 'guest two', 'guest two', "
        "now(), now())",
        {"id": uuid.uuid4(), "company": world.a.company.id},
    )
    assert "uq_visitors_company_id_email" in str(error.orig)
    _insert_visitor(connection, world.b.company.id, "guest@example.com")  # another tenant
    _insert_visitor(connection, world.a.company.id, None)  # NULL e-mails never collide
    _insert_visitor(connection, world.a.company.id, None)
