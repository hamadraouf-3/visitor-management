"""Revision 0013 at the database (Phase 11, B11-1, B11-4, B11-10, B11-20): the platform's audit trail is
append-only like `audit_logs`, the runtime role's grants on the new tables, the CHECKs, and a guarded
downgrade. And revision 0014 (the security review, B11-45): the notice's e-mail kind, a temporary
password's tag, and its downgrade."""

import uuid
from collections.abc import Callable, Iterator

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.pool import NullPool

from tests.integration.test_migrations import _downgrade_racing
from tests.support import Factory, ThrowawayDatabase, World, alembic_config


def _expect_failure(connection: Connection, statement: str, params: dict | None = None) -> DBAPIError:
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as caught:
        connection.execute(text(statement), params or {})
    savepoint.rollback()
    return caught.value


def _insert_platform_row(connection: Connection) -> uuid.UUID:
    row_id = uuid.uuid4()
    connection.execute(
        text("INSERT INTO platform_audit_logs (id, action, created_at) VALUES (:id, 'TEST_EVENT', :now)"),
        {"id": row_id, "now": "2026-10-05T06:00:00Z"},
    )
    return row_id


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE platform_audit_logs SET action = 'TAMPERED' WHERE id = :id",
        "DELETE FROM platform_audit_logs WHERE id = :id",
        "TRUNCATE platform_audit_logs",
        "ALTER TABLE platform_audit_logs DISABLE TRIGGER platform_audit_logs_immutable",
        "DROP TABLE platform_audit_logs",
        "INSERT INTO platform_audit_logs (id, seq, action, created_at) OVERRIDING SYSTEM VALUE "
        "VALUES (gen_random_uuid(), 0, 'FORGED', '2020-01-01Z')",
        "SELECT nextval('platform_audit_logs_seq_seq')",
        "DELETE FROM platform_sessions",
        "DELETE FROM email_template_overrides",
        "DELETE FROM platform_admins",
    ],
)
def test_the_runtime_role_cannot_change_the_platform_trail_or_delete(
    connection: Connection, statement: str
) -> None:
    row_id = _insert_platform_row(connection)
    error = _expect_failure(connection, statement, {"id": row_id} if ":id" in statement else None)
    message = str(error.orig).lower()
    assert "permission denied" in message or "must be owner" in message
    remaining = connection.execute(
        text("SELECT action FROM platform_audit_logs WHERE id = :id"), {"id": row_id}
    )
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
        "UPDATE platform_audit_logs SET action = 'TAMPERED' WHERE id = :id",
        "DELETE FROM platform_audit_logs WHERE id = :id",
        "TRUNCATE platform_audit_logs",
    ],
)
def test_the_trigger_blocks_even_the_owner(owner_connection: Connection, statement: str) -> None:
    row_id = _insert_platform_row(owner_connection)
    error = _expect_failure(owner_connection, statement, {"id": row_id} if ":id" in statement else None)
    assert "append-only" in str(error.orig)


def test_the_runtime_role_s_grants_on_the_new_tables(connection: Connection) -> None:
    insertable = connection.execute(
        text(
            "SELECT column_name FROM information_schema.column_privileges WHERE grantee = current_user "
            "AND table_name = 'platform_audit_logs' AND privilege_type = 'INSERT'"
        )
    ).scalars()
    assert set(insertable) == {
        "id",
        "actor_platform_admin_id",
        "company_id",
        "action",
        "entity_type",
        "entity_id",
        "metadata",
        "ip_address",
        "user_agent",
        "request_id",
        "created_at",
    }
    usage = connection.execute(
        text("SELECT has_sequence_privilege(current_user, 'platform_audit_logs_seq_seq', 'USAGE')")
    ).scalar_one()
    assert usage is False


def test_a_company_s_activity_columns_change_together(connection: Connection, factory: Factory) -> None:
    company = factory.company("Checked")
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_companies_active_matches_deactivated_at"):
        connection.execute(text("UPDATE companies SET is_active = false WHERE id = :id"), {"id": company.id})
    savepoint.rollback()
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_companies_active_matches_deactivated_at"):
        connection.execute(
            text("UPDATE companies SET deactivated_at = now() WHERE id = :id"), {"id": company.id}
        )
    savepoint.rollback()


@pytest.mark.parametrize(
    ("values", "constraint"),
    [
        ({"kind": "PASSWORD_RESET"}, "ck_email_template_overrides_kind_valid"),
        ({"language": "fr"}, "ck_email_template_overrides_language_valid"),
        ({"field": "html"}, "ck_email_template_overrides_field_valid"),
        ({"text": "   "}, "ck_email_template_overrides_text_valid"),
        ({"text": "x" * 2001}, "ck_email_template_overrides_text_valid"),
    ],
)
def test_the_overrides_checks(connection: Connection, world: World, values: dict, constraint: str) -> None:
    row = {"kind": "HOST_ARRIVAL", "language": "en", "field": "subject", "text": "Hi", **values}
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match=constraint):
        connection.execute(
            text(
                "INSERT INTO email_template_overrides (id, company_id, kind, language, field, text) "
                "VALUES (gen_random_uuid(), :company, :kind, :language, :field, :text)"
            ),
            {"company": world.a.company.id, **row},
        )
    savepoint.rollback()


def test_an_override_s_author_belongs_to_its_company(connection: Connection, world: World) -> None:
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="fk_email_template_overrides_company_id_updated_by_id_users"):
        connection.execute(
            text(
                "INSERT INTO email_template_overrides "
                "(id, company_id, kind, language, field, text, updated_by_id) "
                "VALUES (gen_random_uuid(), :company, 'HOST_ARRIVAL', 'en', 'subject', 'Hi', :user)"
            ),
            {"company": world.a.company.id, "user": world.b.admin.id},
        )
    savepoint.rollback()


# ---- the migration's downgrade -------------------------------------------------------------------------


# The newest revision: where a refused downgrade leaves the database (the whole downgrade is one
# transaction), and where `upgrade head` brings it.
HEAD = "0018"
COMPANY_ID = "00000000-0000-0000-0000-000000000001"
NEW_COMPANY = "INSERT INTO companies (id, name, slug, timezone) VALUES (:id, :name, :slug, 'UTC')"
NEW_OVERRIDE = (
    "INSERT INTO email_template_overrides (id, company_id, kind, language, field, text) "
    "VALUES (gen_random_uuid(), :id, 'HOST_ARRIVAL', 'en', 'subject', :text)"
)


def _owner(url: str) -> Engine:
    return create_engine(url, poolclass=NullPool, connect_args={"options": "-c timezone=UTC"})


@pytest.mark.parametrize(
    ("setup", "message"),
    [
        (
            [
                (
                    "INSERT INTO companies (id, name, slug, timezone, is_active, deactivated_at) "
                    "VALUES (gen_random_uuid(), 'Gone', 'gone', 'UTC', false, now())",
                    {},
                )
            ],
            "1 deactivated company",
        ),
        (
            [
                (NEW_COMPANY, {"id": COMPANY_ID, "name": "Texts", "slug": "texts"}),
                (NEW_OVERRIDE, {"id": COMPANY_ID, "text": "Here: {visitor_name}"}),
            ],
            "1 company e-mail text",
        ),
        (
            [
                (
                    "INSERT INTO platform_admins (id, email, full_name, password_hash) "
                    "VALUES (gen_random_uuid(), 'owner@example.com', 'Owner', 'x')",
                    {},
                )
            ],
            "1 platform account",
        ),
        (
            [
                (
                    "INSERT INTO platform_audit_logs (id, action) "
                    "VALUES (gen_random_uuid(), 'AUTH_LOGIN_FAILED')",
                    {},
                )
            ],
            "1 platform audit row",
        ),
    ],
)
def test_the_downgrade_refuses_to_lose_data_or_widen_access(
    create_database: Callable[[str], ThrowawayDatabase], setup: list[tuple[str, dict]], message: str
) -> None:
    database = create_database("vms_0013")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            for statement, params in setup:
                connection.execute(text(statement), params)
        with pytest.raises(RuntimeError, match=message):
            command.downgrade(config, "0012")
        with engine.connect() as connection:
            # Nothing was undone: the whole downgrade is one transaction, so the parts of revisions 0015
            # and 0014 (which had nothing to refuse) are rolled back with revision 0013's refusal.
            version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            assert version == HEAD
            assert connection.execute(text("SELECT to_regclass('platform_admins')")).scalar_one() is not None
    finally:
        engine.dispose()


def test_the_downgrade_and_upgrade_of_0013_round_trip(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_0013_round")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            # A text back on the product's (NULL) and an active company do not block it.
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Kept", "slug": "kept"})
            connection.execute(text(NEW_OVERRIDE), {"id": COMPANY_ID, "text": None})
        command.downgrade(config, "0012")
        with engine.connect() as connection:
            tables = set(
                connection.execute(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                ).scalars()
            )
            new_tables = {
                "platform_admins",
                "platform_sessions",
                "platform_audit_logs",
                "email_template_overrides",
            }
            assert not tables & new_tables
            columns = set(
                connection.execute(
                    text("SELECT column_name FROM information_schema.columns WHERE table_name = 'companies'")
                ).scalars()
            )
            assert not columns & {"is_active", "deactivated_at"}
            functions = connection.execute(
                text("SELECT count(*) FROM pg_proc WHERE proname = 'platform_audit_logs_immutable'")
            ).scalar_one()
            assert functions == 0
        command.upgrade(config, "head")
        with engine.connect() as connection:
            active = connection.execute(
                text("SELECT is_active FROM companies WHERE slug = 'kept'")
            ).scalar_one()
            assert active is True
    finally:
        engine.dispose()


# ---- revision 0014: the notice of a platform action, a temporary password's tag (B11-45) ----------------

NEW_NOTICE = (
    "INSERT INTO email_messages (id, company_id, kind, to_email, subject, provider) "
    "VALUES (gen_random_uuid(), :company, :kind, 'amal@example.com', 'Notice', 'memory')"
)
NEW_PLATFORM_ADMIN = (
    "INSERT INTO platform_admins (id, email, full_name, password_hash, must_change_password, "
    "temporary_password_tag) VALUES (gen_random_uuid(), 'owner@example.com', 'Owner', 'x', true, :tag)"
)
TAG = "a" * 64


def test_the_notice_is_an_e_mail_kind_and_not_an_editable_one(connection: Connection, world: World) -> None:
    """As the runtime role, with the privileges it had: the new kind is accepted in the e-mail log, any
    other is not, and no company text can be stored for it."""
    company = world.a.company.id
    connection.execute(text(NEW_NOTICE), {"company": company, "kind": "PLATFORM_ACTION_NOTICE"})
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_email_messages_kind_valid"):
        connection.execute(text(NEW_NOTICE), {"company": company, "kind": "PLATFORM_NOTICE"})
    savepoint.rollback()
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_email_template_overrides_kind_valid"):
        connection.execute(
            text(
                "INSERT INTO email_template_overrides (id, company_id, kind, language, field, text) "
                "VALUES (gen_random_uuid(), :company, 'PLATFORM_ACTION_NOTICE', 'en', 'heading', 'Hi')"
            ),
            {"company": company},
        )
    savepoint.rollback()


def test_the_runtime_role_writes_a_tag_only_beside_a_temporary_password(
    connection: Connection, factory: Factory
) -> None:
    admin = factory.platform_admin(must_change_password=True)
    statement = text("UPDATE platform_admins SET temporary_password_tag = :tag WHERE id = :id")
    assert connection.execute(statement, {"tag": TAG, "id": admin.id}).rowcount == 1  # no new grant needed
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_platform_admins_temporary_password_tag_is_temporary"):
        connection.execute(
            text("UPDATE platform_admins SET must_change_password = false WHERE id = :id"), {"id": admin.id}
        )
    savepoint.rollback()
    cleared = text(
        "UPDATE platform_admins SET must_change_password = false, temporary_password_tag = NULL "
        "WHERE id = :id"
    )
    assert connection.execute(cleared, {"id": admin.id}).rowcount == 1


def _version(connection: Connection) -> str:
    version: str = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    return version


def _columns(connection: Connection, table: str) -> set[str]:
    return set(
        connection.execute(
            text("SELECT column_name FROM information_schema.columns WHERE table_name = :table"),
            {"table": table},
        ).scalars()
    )


def test_the_downgrade_of_0014_refuses_while_a_notice_is_in_the_e_mail_log(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_0014")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Told", "slug": "told"})
            connection.execute(text(NEW_NOTICE), {"company": COMPANY_ID, "kind": "PLATFORM_ACTION_NOTICE"})
            connection.execute(text(NEW_PLATFORM_ADMIN), {"tag": TAG})
        with pytest.raises(RuntimeError, match="1 PLATFORM_ACTION_NOTICE e-mail row"):
            command.downgrade(config, "0013")
        with engine.connect() as connection:
            assert _version(connection) == HEAD
            assert "temporary_password_tag" in _columns(connection, "platform_admins")
    finally:
        engine.dispose()


def test_the_downgrade_and_upgrade_of_0014_round_trip(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_0014_round")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Kept", "slug": "kept"})
            # A pending temporary password with its tag does not block it: the account stays, with the
            # same password, and only loses the failure budget of its own.
            connection.execute(text(NEW_PLATFORM_ADMIN), {"tag": TAG})
        command.downgrade(config, "0013")
        with engine.begin() as connection:
            assert _version(connection) == "0013"
            assert "temporary_password_tag" not in _columns(connection, "platform_admins")
            kept = connection.execute(text("SELECT email, must_change_password FROM platform_admins")).one()
            assert tuple(kept) == ("owner@example.com", True)
            # The older schema knows no such e-mail.
            savepoint = connection.begin_nested()
            with pytest.raises(IntegrityError, match="ck_email_messages_kind_valid"):
                connection.execute(
                    text(NEW_NOTICE), {"company": COMPANY_ID, "kind": "PLATFORM_ACTION_NOTICE"}
                )
            savepoint.rollback()
            connection.execute(text(NEW_NOTICE), {"company": COMPANY_ID, "kind": "PASSWORD_CHANGED"})
        command.upgrade(config, "head")
        with engine.begin() as connection:
            assert _version(connection) == HEAD
            assert (
                connection.execute(text("SELECT temporary_password_tag FROM platform_admins")).scalar_one()
                is None
            )
            connection.execute(text(NEW_NOTICE), {"company": COMPANY_ID, "kind": "PLATFORM_ACTION_NOTICE"})
    finally:
        engine.dispose()


def test_a_notice_written_during_the_0014_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """The guard locks the table before it counts (SEC-39): a notice whose transaction is still open
    when the downgrade starts is seen, instead of failing the restored CHECK or slipping past it."""
    database = create_database("vms_0014_race")
    command.upgrade(alembic_config(database), "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Racing", "slug": "racing"})
        in_flight = NEW_NOTICE.replace(":company", f"'{COMPANY_ID}'").replace(
            ":kind", "'PLATFORM_ACTION_NOTICE'"
        )
        refused = _downgrade_racing(database, "0013", in_flight)
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            assert _version(connection) == HEAD
            assert connection.execute(text("SELECT count(*) FROM email_messages")).scalar_one() == 1
    finally:
        engine.dispose()
