"""Migrations: clean downgrade/upgrade, no drift from the ORM models, and data carried across revisions."""

import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError
from sqlalchemy.pool import NullPool

from app.core.search import name_sort_key
from app.db.base import Base
from tests.conftest import _drop_database
from tests.support import ThrowawayDatabase, alembic_config

SCHEMA_QUERIES = {
    "columns": """
        SELECT table_name, column_name, data_type, character_maximum_length, is_nullable,
               column_default, is_identity, identity_generation
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'alembic_version'
        ORDER BY 1, 2
    """,
    "constraints": """
        SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'alembic_version'
        ORDER BY 1, 2
    """,
    "indexes": """
        SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'alembic_version' ORDER BY 1, 2
    """,
}


def _snapshot(connection: Connection) -> dict[str, list[tuple]]:
    return {
        name: [tuple(row) for row in connection.execute(text(sql))] for name, sql in SCHEMA_QUERIES.items()
    }


def _privileges(connection: Connection, role: str) -> dict[str, list[tuple]]:
    """The runtime role's table privileges and the schema's default privileges (revisions 0001, 0006)."""
    return {
        "tables": [
            tuple(row)
            for row in connection.execute(
                text(
                    "SELECT table_name, privilege_type FROM information_schema.role_table_grants "
                    "WHERE grantee = :role AND table_schema = 'public' ORDER BY 1, 2"
                ),
                {"role": role},
            )
        ],
        "defaults": [
            tuple(row)
            for row in connection.execute(
                text("SELECT defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY 1, 2")
            )
        ],
    }


def _engine(url: str):
    return create_engine(url, poolclass=NullPool, connect_args={"options": "-c timezone=UTC"})


def test_downgrade_then_upgrade_is_clean(create_database: Callable[[str], ThrowawayDatabase]) -> None:
    database = create_database("vms_migration")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _engine(database.owner_url)
    try:
        with engine.connect() as connection:
            before = _snapshot(connection)
            assert before["columns"], "upgrade created no tables"
            privileges = _privileges(connection, database.app_role)
            assert ("visits", "DELETE") not in privileges["tables"]
            assert ("visits", "UPDATE") in privileges["tables"]

        command.downgrade(config, "0005")
        with engine.connect() as connection:
            # Revision 0006 revokes nothing but DELETE, and its downgrade restores exactly that; revision
            # 0008's downgrade restores the table-level INSERT on audit_logs (SEC-21).
            # Only the tables that exist at 0005 (revision 0013's tables are gone).
            restored = _privileges(connection, database.app_role)
            assert set(restored["tables"]) - set(privileges["tables"]) == {
                (table, "DELETE") for table in {table for table, _ in restored["tables"]} - {"audit_logs"}
            } | {("audit_logs", "INSERT")}

        command.downgrade(config, "base")
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        "SELECT count(*) FROM pg_tables "
                        "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
                    )
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace")
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'")
                ).scalar_one()
                == 0
            )
            assert connection.execute(text("SELECT count(*) FROM pg_default_acl")).scalar_one() == 0

        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert _snapshot(connection) == before
            assert _privileges(connection, database.app_role) == privileges
    finally:
        engine.dispose()


def test_models_match_migration(
    create_database: Callable[[str], ThrowawayDatabase], database: ThrowawayDatabase
) -> None:
    """Autogenerate finds nothing to do, and a schema built from the models is identical."""
    migrated = _engine(database.owner_url)
    try:
        with migrated.connect() as connection:
            context = MigrationContext.configure(
                connection, opts={"compare_type": True, "compare_server_default": True}
            )
            assert compare_metadata(context, Base.metadata) == []
            migrated_snapshot = _snapshot(connection)
    finally:
        migrated.dispose()

    from_models = create_database("vms_models")
    engine = _engine(from_models.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            Base.metadata.create_all(connection)
        with engine.connect() as connection:
            assert _snapshot(connection) == migrated_snapshot
    finally:
        engine.dispose()


def test_reset_token_invalidation_survives_upgrade_and_downgrade(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """0002: tokens the old code invalidated (`expires_at` moved before the 30-minute lifetime) become
    `invalidated_at`; a downgrade folds `invalidated_at` back into `expires_at`, so no invalidated token
    turns usable on either side of the migration."""
    database = create_database("vms_migration_0002")
    config = alembic_config(database)
    command.upgrade(config, "0001")
    engine = _engine(database.owner_url)
    issued = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)
    company_id, user_id = uuid.uuid4(), uuid.uuid4()
    tokens = {name: uuid.uuid4() for name in ("superseded", "running", "used")}
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO companies (id, name, slug, timezone) VALUES (:id, 'Co', 'co', 'UTC')"),
                {"id": company_id},
            )
            connection.execute(
                text(
                    "INSERT INTO users (id, company_id, full_name, email, password_hash, roles) "
                    "VALUES (:id, :company_id, 'User', 'user@example.com', 'x', ARRAY['EMPLOYEE'])"
                ),
                {"id": user_id, "company_id": company_id},
            )
            rows = {
                "superseded": (issued + timedelta(minutes=5), None),  # invalidated the old way
                "running": (issued + timedelta(minutes=30), None),
                "used": (issued + timedelta(minutes=30), issued + timedelta(minutes=1)),
            }
            for name, (expires_at, used_at) in rows.items():
                connection.execute(
                    text(
                        "INSERT INTO password_reset_tokens "
                        "(id, user_id, token_hash, expires_at, used_at, created_at) "
                        "VALUES (:id, :user_id, :hash, :expires_at, :used_at, :created_at)"
                    ),
                    {
                        "id": tokens[name],
                        "user_id": user_id,
                        "hash": name.ljust(64, "0"),
                        "expires_at": expires_at,
                        "used_at": used_at,
                        "created_at": issued,
                    },
                )

        command.upgrade(config, "head")
        with engine.begin() as connection:
            invalidated = dict(
                connection.execute(text("SELECT id, invalidated_at FROM password_reset_tokens")).all()
            )
            assert invalidated == {
                tokens["superseded"]: issued + timedelta(minutes=5),
                tokens["running"]: None,
                tokens["used"]: None,
            }
            connection.execute(
                text("UPDATE password_reset_tokens SET invalidated_at = :at WHERE id = :id"),
                {"at": issued + timedelta(minutes=10), "id": tokens["running"]},
            )

        command.downgrade(config, "0001")
        with engine.connect() as connection:
            expiries = dict(
                connection.execute(text("SELECT id, expires_at FROM password_reset_tokens")).all()
            )
        assert expiries == {
            tokens["superseded"]: issued + timedelta(minutes=5),
            tokens["running"]: issued + timedelta(minutes=10),
            tokens["used"]: issued + timedelta(minutes=30),
        }
    finally:
        engine.dispose()


def test_visitor_name_sort_is_backfilled_with_the_application_folding(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """0004: existing visitors get exactly the key the application writes (`name_sort_key`), in batches
    (2,503 rows: three of them), before the column becomes NOT NULL; a downgrade drops it again."""
    database = create_database("vms_migration_0004")
    config = alembic_config(database)
    command.upgrade(config, "0003")
    engine = _engine(database.owner_url)
    company_id = uuid.uuid4()
    special = {
        uuid.uuid4(): name
        for name in (
            "  Élodie   MARCHAND ",
            "Straße Müller",
            "\N{ARABIC LETTER ALEF WITH HAMZA ABOVE}\N{ARABIC FATHA}"
            "\N{ARABIC LETTER HAH}\N{ARABIC LETTER MEEM}",
        )
    }
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO companies (id, name, slug, timezone) VALUES (:id, 'Co', 'co', 'UTC')"),
                {"id": company_id},
            )
            connection.execute(
                text(
                    "INSERT INTO visitors (id, company_id, full_name, search_text) "
                    "SELECT gen_random_uuid(), :company_id, 'Guest ' || n, 'guest ' || n "
                    "FROM generate_series(1, 2500) AS n"
                ),
                {"company_id": company_id},
            )
            for visitor_id, name in special.items():
                connection.execute(
                    text(
                        "INSERT INTO visitors (id, company_id, full_name, search_text) "
                        "VALUES (:id, :company_id, :name, 'x')"
                    ),
                    {"id": visitor_id, "company_id": company_id, "name": name},
                )

        command.upgrade(config, "head")
        with engine.connect() as connection:
            stored = dict(
                connection.execute(
                    text("SELECT id, name_sort FROM visitors WHERE id = ANY(:ids)"), {"ids": list(special)}
                ).all()
            )
            assert stored == {visitor_id: name_sort_key(name) for visitor_id, name in special.items()}
            assert stored[next(iter(special))] == "elodie marchand"
            mismatched = connection.execute(
                text(
                    "SELECT count(*) FROM visitors "
                    "WHERE full_name LIKE 'Guest %' AND name_sort <> lower(full_name)"
                )
            ).scalar_one()
            assert mismatched == 0

        command.downgrade(config, "0003")
        with engine.connect() as connection:
            columns = connection.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_name = 'visitors'")
            ).scalars()
            assert "name_sort" not in set(columns)
    finally:
        engine.dispose()


def test_triggers_and_extension_exist(connection: Connection) -> None:
    triggers = dict(
        connection.execute(
            text("SELECT tgname, tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal")
        ).all()
    )
    assert triggers == {
        "visits_terminal_immutable": "visits",
        "audit_logs_immutable": "audit_logs",
        "platform_audit_logs_immutable": "platform_audit_logs",  # revision 0013 (B11-4)
        "visitor_journey_events_immutable": "visitor_journey_events",  # revision 0018 (B15-9)
    }
    assert (
        connection.execute(text("SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'")).scalar_one()
        == 1
    )


def test_session_timezone_is_utc(connection: Connection) -> None:
    assert connection.execute(text("SHOW timezone")).scalar_one() == "UTC"


def test_a_freshly_migrated_database_gives_the_runtime_role_no_temporary_objects(
    admin_engine: Engine, create_database: Callable[[str], ThrowawayDatabase]
) -> None:
    """SEC-22: the migration itself revokes TEMPORARY (PostgreSQL grants it to PUBLIC on every new
    database), so a database provisioned without scripts/db.ps1 or the test harness is covered too."""
    template = create_database("vms_migration_temp_names")  # only for its URLs and role
    name = f"vms_migration_temp_{uuid.uuid4().hex[:8]}"
    with admin_engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))  # no REVOKE, unlike the harness
    database = ThrowawayDatabase(
        name,
        make_url(template.owner_url).set(database=name).render_as_string(hide_password=False),
        make_url(template.app_url).set(database=name).render_as_string(hide_password=False),
        template.app_role,
    )
    try:
        engine = _engine(database.owner_url)
        try:
            with engine.connect() as connection:
                granted = connection.execute(
                    text("SELECT has_database_privilege(:role, current_database(), 'TEMPORARY')"),
                    {"role": database.app_role},
                ).scalar_one()
                assert granted is True  # PostgreSQL's default for a new database
            command.upgrade(alembic_config(database), "head")
            with engine.connect() as connection:
                granted = connection.execute(
                    text("SELECT has_database_privilege(:role, current_database(), 'TEMPORARY')"),
                    {"role": database.app_role},
                ).scalar_one()
                assert granted is False
        finally:
            engine.dispose()
        runtime = _engine(database.app_url)
        try:
            with runtime.connect() as connection, pytest.raises(ProgrammingError, match="permission denied"):
                connection.execute(text("CREATE TEMP TABLE audit_logs (LIKE public.audit_logs)"))
        finally:
            runtime.dispose()
    finally:
        with admin_engine.connect() as connection:
            # An autovacuum worker may still be processing the new database (the harness's retry).
            _drop_database(connection, name)


def _seed_minimal_visit(connection: Connection, *, link_in_scope: bool) -> None:
    company_id, user_id, visitor_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    start = datetime(2026, 10, 6, 7, 0, tzinfo=UTC)
    connection.execute(
        text("INSERT INTO companies (id, name, slug, timezone) VALUES (:id, 'Co', :slug, 'UTC')"),
        {"id": company_id, "slug": f"co-{company_id.hex[:8]}"},
    )
    connection.execute(
        text(
            "INSERT INTO users (id, company_id, full_name, email, password_hash, roles) "
            "VALUES (:id, :company_id, 'Host', :email, 'x', ARRAY['EMPLOYEE'])"
        ),
        {"id": user_id, "company_id": company_id, "email": f"host-{user_id.hex[:8]}@example.com"},
    )
    has_name_sort = connection.execute(
        text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name = 'visitors' AND column_name = 'name_sort'"
        )
    ).scalar_one()
    connection.execute(
        text(
            "INSERT INTO visitors (id, company_id, full_name, search_text"
            + (", name_sort) " if has_name_sort else ") ")
            + "VALUES (:id, :company_id, 'Guest', 'guest'"
            + (", 'guest')" if has_name_sort else ")")
        ),
        {"id": visitor_id, "company_id": company_id},
    )
    connection.execute(
        text(
            "INSERT INTO visits (id, company_id, visitor_id, host_id, created_by_id, purpose, "
            "scheduled_start, scheduled_end, window_start, window_end, visitor_name, host_name, "
            "visitor_link_in_scope) "
            "VALUES (gen_random_uuid(), :company_id, :visitor_id, :user_id, :user_id, 'Meeting', "
            ":start, :end, :start, :end, 'Guest', 'Host', :in_scope)"
        ),
        {
            "company_id": company_id,
            "visitor_id": visitor_id,
            "user_id": user_id,
            "start": start,
            "end": start + timedelta(hours=1),
            "in_scope": link_in_scope,
        },
    )


def test_visit_link_scope_cannot_be_lost_by_a_downgrade(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """SEC-24: dropping `visitor_link_in_scope` and adding it again on the next upgrade would turn every
    out-of-scope link back into scope (the default is true). The 0003 downgrade refuses while such a
    link exists; with only in-scope links it runs."""
    database = create_database("vms_migration_0003_scope")
    config = alembic_config(database)
    command.upgrade(config, "0003")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            _seed_minimal_visit(connection, link_in_scope=False)
        with pytest.raises(RuntimeError, match="cannot be downgraded"):
            command.downgrade(config, "0002")
        with engine.connect() as connection:
            values = connection.execute(text("SELECT visitor_link_in_scope FROM visits ORDER BY 1")).scalars()
            assert list(values) == [False, True]  # nothing was dropped
        with engine.begin() as connection:
            connection.execute(text("UPDATE visits SET visitor_link_in_scope = true"))
        command.downgrade(config, "0002")
    finally:
        engine.dispose()


def test_visitor_ownership_cannot_be_lost_by_a_downgrade(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """Revision 0008 (SEC-08): a visitor registered outside its creator's own scope would enter it again
    if the column were dropped and re-added, so the downgrade refuses while one exists."""
    database = create_database("vms_migration_0008_owner")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            connection.execute(text("UPDATE visitors SET owned_by_creator = false"))
        with pytest.raises(RuntimeError, match="cannot be downgraded"):
            command.downgrade(config, "0007")
        with engine.begin() as connection:
            connection.execute(text("UPDATE visitors SET owned_by_creator = true"))
        command.downgrade(config, "0007")
        command.upgrade(config, "head")
    finally:
        engine.dispose()


# ---- downgrade guards against writes in flight (SEC-39) --------------------------------------------


def _downgrade_racing(database: ThrowawayDatabase, target: str, in_flight: str) -> BaseException | None:
    """Run `in_flight` as the runtime role without committing, start the downgrade to `target`, wait
    until it waits for a lock, then commit the write. Returns what the downgrade raised (None: it ran)."""
    outcome: list[BaseException | None] = []

    def downgrade() -> None:
        try:
            command.downgrade(alembic_config(database), target)
            outcome.append(None)
        except Exception as exc:
            outcome.append(exc)

    writer = _engine(database.app_url)
    observer = _engine(database.owner_url)
    try:
        with writer.connect() as connection:
            transaction = connection.begin()
            assert connection.execute(text(in_flight)).rowcount == 1
            worker = threading.Thread(target=downgrade)
            worker.start()
            try:
                assert _migration_waits_for_a_lock(observer, database.name, worker)
            finally:
                transaction.commit()
            worker.join(timeout=60)
        assert not worker.is_alive() and outcome
        return outcome[0]
    finally:
        writer.dispose()
        observer.dispose()


def _migration_waits_for_a_lock(observer: Engine, name: str, worker: threading.Thread) -> bool:
    deadline = time.monotonic() + 30
    with observer.connect() as connection:
        while time.monotonic() < deadline and worker.is_alive():
            waiting = connection.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = :name "
                    "AND application_name = 'vms-migrations' AND wait_event_type = 'Lock'"
                ),
                {"name": name},
            ).scalar_one()
            connection.rollback()
            if waiting:
                return True
            time.sleep(0.05)
    return False


def test_a_visitor_written_during_the_0008_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """The finding: the guard counted without a lock, so a desk visitor (owned_by_creator false) whose
    write was still in progress was invisible to it; DROP COLUMN then waited for that write and dropped
    its value, and the next upgrade put the visitor back into its creator's scope (default true)."""
    database = create_database("vms_migration_0008_race")
    command.upgrade(alembic_config(database), "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
        refused = _downgrade_racing(database, "0007", "UPDATE visitors SET owned_by_creator = false")
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            head = ScriptDirectory.from_config(alembic_config(database)).get_current_head()
            assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == head
            owned = connection.execute(text("SELECT owned_by_creator FROM visitors")).scalars()
            assert list(owned) == [False]
    finally:
        engine.dispose()


def test_a_link_written_during_the_0003_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0003_race")
    command.upgrade(alembic_config(database), "0003")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
        refused = _downgrade_racing(database, "0002", "UPDATE visits SET visitor_link_in_scope = false")
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            values = connection.execute(text("SELECT visitor_link_in_scope FROM visits")).scalars()
            assert list(values) == [False]
    finally:
        engine.dispose()


def test_the_device_trust_epoch_is_random_per_account_and_survives_no_round_trip(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """Revision 0009 (SEC-30): existing accounts get a random epoch each, and a downgrade followed by an
    upgrade gives them new ones, so no device cookie issued before the downgrade is trusted again."""
    database = create_database("vms_migration_0009_epoch")
    config = alembic_config(database)
    command.upgrade(config, "0008")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            _seed_minimal_visit(connection, link_in_scope=True)
        command.upgrade(config, "head")
        query = text("SELECT device_trust_epoch FROM users ORDER BY id")
        with engine.connect() as connection:
            first = list(connection.execute(query).scalars())
        assert len(set(first)) == 2 and all(0 <= epoch < 2**63 for epoch in first)
        command.downgrade(config, "0008")
        command.upgrade(config, "head")
        with engine.connect() as connection:
            second = list(connection.execute(query).scalars())
        assert not set(first) & set(second)
    finally:
        engine.dispose()


# ---- revision 0011: languages (Phase 10, B10-1) ----------------------------------------------------


def test_the_language_columns_and_their_checks(create_database: Callable[[str], ThrowawayDatabase]) -> None:
    """0011: existing companies become Arabic by default; the CHECKs admit only ar/en and a non-blank
    Arabic name; the runtime role writes the new columns through its table-level grants."""
    database = create_database("vms_migration_0011_checks")
    config = alembic_config(database)
    command.upgrade(config, "0010")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
        command.upgrade(config, "head")
        with engine.connect() as connection:
            row = connection.execute(text("SELECT name_ar, default_language FROM companies")).one()
            assert tuple(row) == (None, "ar")
            assert connection.execute(text("SELECT preferred_language FROM users")).scalar_one() is None
        runtime = _engine(database.app_url)
        try:
            with runtime.begin() as connection:
                connection.execute(text("UPDATE companies SET name_ar = 'شركة', default_language = 'en'"))
                connection.execute(text("UPDATE users SET preferred_language = 'ar'"))
            for statement in (
                "UPDATE companies SET default_language = 'fr'",
                "UPDATE companies SET default_language = NULL",
                "UPDATE companies SET name_ar = '   '",
                "UPDATE users SET preferred_language = 'AR'",
            ):
                with runtime.connect() as connection, pytest.raises(IntegrityError):
                    connection.execute(text(statement))
        finally:
            runtime.dispose()
    finally:
        engine.dispose()


def test_the_language_columns_cannot_be_lost_by_a_downgrade(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """0011's downgrade refuses while a value the next upgrade would not restore exists (an Arabic name, a
    language preference, a default other than Arabic); with only defaults it runs."""
    database = create_database("vms_migration_0011_guard")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
        for setup, reset in (
            ("UPDATE companies SET name_ar = 'شركة'", "UPDATE companies SET name_ar = NULL"),
            ("UPDATE companies SET default_language = 'en'", "UPDATE companies SET default_language = 'ar'"),
            ("UPDATE users SET preferred_language = 'en'", "UPDATE users SET preferred_language = NULL"),
        ):
            with engine.begin() as connection:
                connection.execute(text(setup))
            with pytest.raises(RuntimeError, match="0011 cannot be downgraded"):
                command.downgrade(config, "0010")
            with engine.begin() as connection:
                connection.execute(text(reset))
        command.downgrade(config, "0010")
        with engine.connect() as connection:
            columns = set(
                connection.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name IN ('companies', 'users')"
                    )
                ).scalars()
            )
            assert not {"name_ar", "default_language", "preferred_language"} & columns
        command.upgrade(config, "head")
    finally:
        engine.dispose()


def test_a_preference_written_during_the_0011_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0011_race")
    command.upgrade(alembic_config(database), "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
        refused = _downgrade_racing(database, "0010", "UPDATE users SET preferred_language = 'ar'")
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            assert connection.execute(text("SELECT preferred_language FROM users")).scalar_one() == "ar"
    finally:
        engine.dispose()


# ---- revision 0012: bilingual department names and company address (Phase 10, B10-25) ---------------


def _add_department(connection: Connection, name: str) -> None:
    """A department of the (only) company of `_seed_minimal_visit`, without an Arabic name."""
    connection.execute(
        text(
            "INSERT INTO departments (id, company_id, name) "
            "SELECT gen_random_uuid(), id, :name FROM companies LIMIT 1"
        ),
        {"name": name},
    )


def test_the_bilingual_columns_and_their_rules(create_database: Callable[[str], ThrowawayDatabase]) -> None:
    """0012: existing rows get no Arabic department name, address or visit snapshot; the runtime role
    writes the new columns through its table-level grants; a blank Arabic name is refused, and an Arabic
    name is unique per company ignoring case, where it is set."""
    database = create_database("vms_migration_0012_rules")
    config = alembic_config(database)
    command.upgrade(config, "0011")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            _add_department(connection, "Finance")
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT name_ar FROM departments")).scalar_one() is None
            assert connection.execute(text("SELECT address_ar FROM companies")).scalar_one() is None
            assert connection.execute(text("SELECT department_name_ar FROM visits")).scalar_one() is None
            index = connection.execute(
                text("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_departments_company_name_ar'")
            ).scalar_one()
            assert (
                "UNIQUE" in index
                and "lower((name_ar)::text)" in index
                and "WHERE (name_ar IS NOT NULL)" in index
            )
        runtime = _engine(database.app_url)
        try:
            with runtime.begin() as connection:
                connection.execute(text("UPDATE departments SET name_ar = 'المالية'"))
                connection.execute(text("UPDATE companies SET address_ar = 'عمّان'"))
                connection.execute(text("UPDATE visits SET department_name_ar = 'المالية'"))
                # Departments without an Arabic name do not collide.
                _add_department(connection, "Legal")
                _add_department(connection, "Press")
                # The same Arabic name in another company is fine.
                other = uuid.uuid4()
                connection.execute(
                    text(
                        "INSERT INTO companies (id, name, slug, timezone) "
                        "VALUES (:id, 'Other', 'other', 'UTC')"
                    ),
                    {"id": other},
                )
                connection.execute(
                    text(
                        "INSERT INTO departments (id, company_id, name, name_ar) "
                        "VALUES (gen_random_uuid(), :company, 'Finance', 'المالية')"
                    ),
                    {"company": other},
                )
            for statement in (
                "UPDATE departments SET name_ar = '   ' WHERE name = 'Legal'",
                "UPDATE departments SET name_ar = 'المالية' WHERE name = 'Legal'",
            ):
                with runtime.connect() as connection, pytest.raises(IntegrityError):
                    connection.execute(text(statement))
            with runtime.begin() as connection:
                connection.execute(text("UPDATE departments SET name_ar = 'Mktb' WHERE name = 'Legal'"))
            with (
                runtime.connect() as connection,
                pytest.raises(IntegrityError, match="uq_departments_company_name_ar"),
            ):
                connection.execute(text("UPDATE departments SET name_ar = 'MKTB' WHERE name = 'Press'"))
        finally:
            runtime.dispose()
    finally:
        engine.dispose()


def test_the_bilingual_columns_cannot_be_lost_by_a_downgrade(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """0012's downgrade refuses while an Arabic department name, an Arabic address or an Arabic department
    name recorded on a visit exists; with none it runs, and the next upgrade restores the schema."""
    database = create_database("vms_migration_0012_guard")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            _add_department(connection, "Finance")
        for setup, reset in (
            ("UPDATE departments SET name_ar = 'المالية'", "UPDATE departments SET name_ar = NULL"),
            ("UPDATE companies SET address_ar = 'عمّان'", "UPDATE companies SET address_ar = NULL"),
            (
                "UPDATE visits SET department_name_ar = 'المالية'",
                "UPDATE visits SET department_name_ar = NULL",
            ),
        ):
            with engine.begin() as connection:
                connection.execute(text(setup))
            with pytest.raises(RuntimeError, match="0012 cannot be downgraded"):
                command.downgrade(config, "0011")
            with engine.begin() as connection:
                connection.execute(text(reset))
        command.downgrade(config, "0011")
        with engine.connect() as connection:
            columns = set(
                connection.execute(
                    text(
                        "SELECT table_name || '.' || column_name FROM information_schema.columns "
                        "WHERE table_name IN ('departments', 'companies', 'visits')"
                    )
                ).scalars()
            )
            assert not {"departments.name_ar", "companies.address_ar", "visits.department_name_ar"} & columns
            assert (
                connection.execute(
                    text("SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_departments_company_name_ar'")
                ).scalar_one()
                == 0
            )
        command.upgrade(config, "head")
    finally:
        engine.dispose()


def test_a_finished_visit_s_arabic_department_name_needs_a_backup_to_downgrade(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """A cancelled or checked-out visit cannot be changed (`visits_terminal_immutable`), so its Arabic
    department name cannot be cleared: the refusal says to restore a backup, and the value stays."""
    database = create_database("vms_migration_0012_finished")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            connection.execute(
                text(
                    "UPDATE visits SET department_name_ar = 'المالية', status = 'CANCELLED', "
                    "cancelled_at = scheduled_start"
                )
            )
        with engine.connect() as connection, pytest.raises(DBAPIError, match="can no longer be modified"):
            connection.execute(text("UPDATE visits SET department_name_ar = NULL"))
        with pytest.raises(RuntimeError, match="restore a backup taken before the upgrade"):
            command.downgrade(config, "0011")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT department_name_ar FROM visits")).scalar_one() == "المالية"
    finally:
        engine.dispose()


def test_an_arabic_name_written_during_the_0012_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_migration_0012_race")
    command.upgrade(alembic_config(database), "head")
    engine = _engine(database.owner_url)
    try:
        with engine.begin() as connection:
            _seed_minimal_visit(connection, link_in_scope=True)
            _add_department(connection, "Finance")
        refused = _downgrade_racing(database, "0011", "UPDATE departments SET name_ar = 'المالية'")
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            assert connection.execute(text("SELECT name_ar FROM departments")).scalar_one() == "المالية"
    finally:
        engine.dispose()
