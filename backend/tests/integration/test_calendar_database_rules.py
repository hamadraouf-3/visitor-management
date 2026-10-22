"""Revision 0016 at the database (Phase 14, B14-11): the e-mail kinds of the host's e-mails and of the
visitor's calendar invitation, which of them a company may write texts for, the visit's calendar event
version, and a downgrade that refuses to lose what the older schema cannot hold, also when it is still
being written; an upgrade that waits for no lock longer than 5 s and validates every CHECK it adds
(B14-23)."""

import io
import time
import uuid
from collections.abc import Callable

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.pool import NullPool

from tests.integration.test_migrations import _downgrade_racing
from tests.support import BACKEND_DIR, ThrowawayDatabase, World, alembic_config

HEAD = "0020"
HOST_KINDS = ("HOST_VISIT_SCHEDULED", "HOST_VISIT_RESCHEDULED", "HOST_VISIT_CANCELLED")
COMPANY_ID = "00000000-0000-0000-0000-000000000016"
NEW_COMPANY = "INSERT INTO companies (id, name, slug, timezone) VALUES (:id, :name, :slug, 'UTC')"
NEW_MESSAGE = (
    "INSERT INTO email_messages (id, company_id, kind, to_email, subject, provider) "
    "VALUES (gen_random_uuid(), :company, :kind, 'dana@example.com', 'Visit', 'memory')"
)
NEW_TEXT = (
    "INSERT INTO email_template_overrides (id, company_id, kind, language, field, text) "
    "VALUES (gen_random_uuid(), :company, :kind, 'en', 'subject', :text)"
)
SCHEDULED_VISITS = "SELECT count(*) FROM visits WHERE status = 'SCHEDULED'"


def _owner(url: str) -> Engine:
    return create_engine(url, poolclass=NullPool, connect_args={"options": "-c timezone=UTC"})


def _version(connection: Connection) -> str:
    version: str = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    return version


def _has_sequence(connection: Connection) -> bool:
    return (
        connection.execute(
            text(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'visits' AND column_name = 'calendar_sequence'"
            )
        ).scalar_one()
        == 1
    )


def _visit(connection: Connection, *, status: str = "SCHEDULED", sequence: int = 0) -> None:
    """A visit of the company COMPANY_ID, with its host and its visitor, as the owner writes rows."""
    host, visitor = uuid.uuid4(), uuid.uuid4()
    connection.execute(
        text(
            "INSERT INTO users (id, company_id, full_name, email, password_hash, roles) "
            "VALUES (:id, :company, 'Host', :email, 'x', ARRAY['EMPLOYEE'])"
        ),
        {"id": host, "company": COMPANY_ID, "email": f"{host}@example.com"},
    )
    connection.execute(
        text(
            "INSERT INTO visitors (id, company_id, full_name, search_text, name_sort, created_by_id, "
            "created_at, updated_at) "
            "VALUES (:id, :company, 'Dana', 'dana', 'dana', :host, now(), now())"
        ),
        {"id": visitor, "company": COMPANY_ID, "host": host},
    )
    connection.execute(
        text(
            "INSERT INTO visits (id, company_id, visitor_id, host_id, created_by_id, purpose, "
            "scheduled_start, scheduled_end, window_start, window_end, status, visitor_name, host_name, "
            "calendar_sequence, cancelled_at, created_at, updated_at) "
            "VALUES (gen_random_uuid(), :company, :visitor, :host, :host, 'Review', "
            "'2026-10-20 07:00Z', '2026-10-20 08:00Z', '2026-10-20 06:30Z', '2026-10-20 08:30Z', "
            ":status, 'Dana', 'Host', :sequence, :cancelled_at, now(), now())"
        ),
        {
            "company": COMPANY_ID,
            "visitor": visitor,
            "host": host,
            "status": status,
            "sequence": sequence,
            "cancelled_at": "2026-10-19 08:00Z" if status == "CANCELLED" else None,
        },
    )


# ---- the runtime role's view -----------------------------------------------------------------------


@pytest.mark.parametrize("kind", [*HOST_KINDS, "VISITOR_CALENDAR"])
def test_the_new_kinds_are_e_mail_kinds(connection: Connection, world: World, kind: str) -> None:
    connection.execute(text(NEW_MESSAGE), {"company": world.a.company.id, "kind": kind})


def test_the_host_s_kinds_are_editable_and_the_calendar_invitation_is_not(
    connection: Connection, world: World
) -> None:
    company = world.a.company.id
    for kind in HOST_KINDS:
        connection.execute(
            text(NEW_TEXT), {"company": company, "kind": kind, "text": "Visit: {visitor_name}"}
        )
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_email_template_overrides_kind_valid"):
        connection.execute(text(NEW_TEXT), {"company": company, "kind": "VISITOR_CALENDAR", "text": "Hi"})
    savepoint.rollback()
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_email_messages_kind_valid"):
        connection.execute(text(NEW_MESSAGE), {"company": company, "kind": "HOST_VISIT"})
    savepoint.rollback()


def test_a_visit_s_calendar_version_starts_at_0_and_is_never_negative(
    connection: Connection, world: World
) -> None:
    connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Versions", "slug": "versions-16"})
    _visit(connection)
    assert (
        connection.execute(
            text("SELECT calendar_sequence FROM visits WHERE company_id = :c"), {"c": COMPANY_ID}
        ).scalar_one()
        == 0
    )
    statement = text("UPDATE visits SET calendar_sequence = :value WHERE company_id = :c")
    assert connection.execute(statement, {"value": 7, "c": COMPANY_ID}).rowcount == 1  # no new grant needed
    savepoint = connection.begin_nested()
    with pytest.raises(IntegrityError, match="ck_visits_calendar_sequence_non_negative"):
        connection.execute(statement, {"value": -1, "c": COMPANY_ID})
    savepoint.rollback()


# ---- the downgrade ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("setup", "counted"),
    [
        (
            lambda c: c.execute(text(NEW_MESSAGE), {"company": COMPANY_ID, "kind": "HOST_VISIT_SCHEDULED"}),
            "1 e-mail",
        ),
        (
            lambda c: c.execute(text(NEW_MESSAGE), {"company": COMPANY_ID, "kind": "VISITOR_CALENDAR"}),
            "1 e-mail",
        ),
        (
            lambda c: c.execute(
                text(NEW_TEXT),
                {"company": COMPANY_ID, "kind": "HOST_VISIT_CANCELLED", "text": "Off: {visitor_name}"},
            ),
            "1 company e-mail text",
        ),
        (lambda c: _visit(c, sequence=1), "1 scheduled visit"),
    ],
    ids=["a host's e-mail", "a calendar invitation", "a host's text", "a scheduled visit's version"],
)
def test_the_downgrade_refuses_to_lose_what_the_older_schema_cannot_hold(
    create_database: Callable[[str], ThrowawayDatabase],
    setup: Callable[[Connection], object],
    counted: str,
) -> None:
    database = create_database("vms_0016")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Kept", "slug": "kept"})
            setup(connection)
        with pytest.raises(RuntimeError, match="revision 0016 cannot be downgraded") as refused:
            command.downgrade(config, "0015")
        assert counted in str(refused.value)
        with engine.connect() as connection:
            assert _version(connection) == HEAD and _has_sequence(connection)
    finally:
        engine.dispose()


def test_the_downgrade_and_upgrade_of_0016_round_trip(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_0016_round")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Kept", "slug": "kept"})
            # Nothing the older schema cannot hold: a finished visit's version, a host's text reset to the
            # product's (a row without a text), a text of another kind.
            _visit(connection, status="CANCELLED", sequence=2)
            connection.execute(
                text(NEW_TEXT), {"company": COMPANY_ID, "kind": "HOST_VISIT_SCHEDULED", "text": "x"}
            )
            connection.execute(text("UPDATE email_template_overrides SET text = NULL"))
            connection.execute(
                text(NEW_TEXT),
                {"company": COMPANY_ID, "kind": "HOST_ARRIVAL", "text": "{visitor_name} is here"},
            )
        command.downgrade(config, "0015")
        with engine.begin() as connection:
            assert _version(connection) == "0015" and not _has_sequence(connection)
            kinds = connection.execute(text("SELECT kind FROM email_template_overrides")).scalars().all()
            assert kinds == ["HOST_ARRIVAL"]  # the emptied row of a host's kind is gone, nothing else
            for kind in ("HOST_VISIT_SCHEDULED", "VISITOR_CALENDAR"):
                savepoint = connection.begin_nested()
                with pytest.raises(IntegrityError, match="ck_email_messages_kind_valid"):
                    connection.execute(text(NEW_MESSAGE), {"company": COMPANY_ID, "kind": kind})
                savepoint.rollback()
        command.upgrade(config, "head")
        with engine.begin() as connection:
            assert _version(connection) == HEAD and _has_sequence(connection)
            assert connection.execute(text("SELECT calendar_sequence FROM visits")).scalar_one() == 0
            connection.execute(text(NEW_MESSAGE), {"company": COMPANY_ID, "kind": "VISITOR_CALENDAR"})
    finally:
        engine.dispose()


def test_a_host_s_e_mail_written_during_the_0016_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """The guard locks the tables before it counts (SEC-39): an e-mail whose transaction is still open
    when the downgrade starts is seen, instead of failing the restored CHECK or slipping past it."""
    database = create_database("vms_0016_race")
    command.upgrade(alembic_config(database), "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Racing", "slug": "racing"})
        in_flight = NEW_MESSAGE.replace(":company", f"'{COMPANY_ID}'").replace(
            ":kind", "'HOST_VISIT_SCHEDULED'"
        )
        refused = _downgrade_racing(database, "0015", in_flight)
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            assert _version(connection) == HEAD
            assert connection.execute(text("SELECT count(*) FROM email_messages")).scalar_one() == 1
    finally:
        engine.dispose()


# ---- the upgrade's locks (B14-23) ----------------------------------------------------------------------

CHECKS = (
    "ck_email_messages_calendar_method_valid",  # revision 0017 (B14-26)
    "ck_email_messages_kind_valid",
    "ck_email_template_overrides_kind_valid",
    "ck_visits_calendar_sequence_non_negative",
)


def test_the_0016_upgrade_adds_its_checks_not_valid_then_validates_them() -> None:
    """The statements as the upgrade emits them (Alembic's offline mode): a lock is waited for 5 s at
    most, from the first statement to the last, after which the session's own value is back; the CHECKs
    of the two large tables are added without reading them and validated afterwards."""
    config = Config(str(BACKEND_DIR / "alembic.ini"), output_buffer=io.StringIO())
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.attributes["database_url"] = "postgresql://offline@localhost/offline"
    config.attributes["app_role"] = "vms_app"
    config.attributes["configure_logging"] = False
    command.upgrade(config, "0015:0016", sql=True)
    assert isinstance(config.output_buffer, io.StringIO)
    lines = config.output_buffer.getvalue().splitlines()
    sql = " ".join(line for line in lines if not line.startswith("--"))
    statements = [
        " ".join(statement.split())
        for statement in sql.split(";")
        if "alembic_version" not in statement and statement.strip() not in {"", "BEGIN", "COMMIT"}
    ]
    assert statements[0] == "SET LOCAL lock_timeout = '5s'"
    assert statements[-1] == "SET LOCAL lock_timeout TO DEFAULT"
    for table, check in (
        ("email_messages", "ck_email_messages_kind_valid"),
        ("visits", "ck_visits_calendar_sequence_non_negative"),
    ):
        added = next(index for index, s in enumerate(statements) if f"ADD CONSTRAINT {check} CHECK" in s)
        assert statements[added].startswith(f"ALTER TABLE {table} ") and statements[added].endswith(
            "NOT VALID"
        )
        assert statements[added + 1] == f"ALTER TABLE {table} VALIDATE CONSTRAINT {check}"


def test_the_0016_upgrade_gives_up_a_lock_it_cannot_get_and_leaves_every_check_validated(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """A transaction that has read `visits` holds the upgrade's lock: the upgrade fails after 5 s,
    leaving nothing behind, instead of holding every request to the table for as long as that
    transaction lasts. Run again, it ends where a database upgraded before this change is: the same
    CHECKs, by name, all validated."""
    database = create_database("vms_0016_locks")
    config = alembic_config(database)
    command.upgrade(config, "0015")
    engine = _owner(database.owner_url)
    try:
        with engine.connect() as reader:
            reader.execute(text("SELECT count(*) FROM visits"))  # its transaction stays open
            started = time.monotonic()
            with pytest.raises(OperationalError) as refused:
                command.upgrade(config, "head")
            waited = time.monotonic() - started
            reader.rollback()
        assert getattr(refused.value.orig, "sqlstate", None) == "55P03"  # lock_not_available
        assert 4.5 <= waited < 30
        with engine.connect() as connection:
            assert _version(connection) == "0015" and not _has_sequence(connection)
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert _version(connection) == HEAD and _has_sequence(connection)
            rows = connection.execute(
                text("SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY(:names)"),
                {"names": list(CHECKS)},
            ).all()
            assert sorted(rows) == [(name, True) for name in CHECKS]
            # The upgrade's own lock_timeout ended with it.
            assert connection.execute(text("SELECT current_setting('lock_timeout')")).scalar_one() == "0"
    finally:
        engine.dispose()


# ---- revision 0017: the event an e-mail carried (B14-26) ------------------------------------------------

AT = (
    "INSERT INTO email_messages (id, company_id, kind, to_email, subject, provider, created_at, updated_at) "
    "VALUES (gen_random_uuid(), :company, :kind, 'dana@example.com', 'Visit', 'memory', :at, :at)"
)
METHODS = "SELECT kind, to_char(created_at AT TIME ZONE 'UTC', 'MM-DD'), calendar_method FROM email_messages"


def _methods(connection: Connection) -> list[tuple[str, str, str | None]]:
    return sorted(tuple(row) for row in connection.execute(text(METHODS)))


def test_the_0017_upgrade_marks_the_event_each_earlier_e_mail_carried(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    """The rows written before revision 0017 get the method their kind and age tell: every row of the
    kinds revision 0016 added carried an event; a notice of a new time or of a cancellation carried one
    from the first of those rows on, and none before (a database upgraded from 0015 marks none). The
    CHECK is validated; a downgrade drops the column, and an upgrade marks the rows again."""
    database = create_database("vms_0017")
    config = alembic_config(database)
    command.upgrade(config, "0015")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Marked", "slug": "marked"})
            for kind, at in (
                ("VISIT_RESCHEDULED", "2026-10-01 08:00Z"),
                ("VISIT_CANCELLED", "2026-10-02 08:00Z"),
            ):
                connection.execute(text(AT), {"company": COMPANY_ID, "kind": kind, "at": at})
        command.upgrade(config, "head")  # from 0015, as production: nothing carried an event
        with engine.connect() as connection:
            assert _methods(connection) == [
                ("VISIT_CANCELLED", "10-02", None),
                ("VISIT_RESCHEDULED", "10-01", None),
            ]
        command.downgrade(config, "0016")
        with engine.begin() as connection:
            for kind, at in (
                ("VISITOR_CALENDAR", "2026-10-19 08:00Z"),
                ("HOST_VISIT_SCHEDULED", "2026-10-19 08:00Z"),
                ("VISIT_RESCHEDULED", "2026-10-19 09:00Z"),
                ("HOST_VISIT_RESCHEDULED", "2026-10-19 09:00Z"),
                ("VISIT_CANCELLED", "2026-10-20 10:00Z"),
                ("HOST_VISIT_CANCELLED", "2026-10-20 10:00Z"),
                ("HOST_ARRIVAL", "2026-10-20 11:00Z"),
            ):
                connection.execute(text(AT), {"company": COMPANY_ID, "kind": kind, "at": at})
        command.upgrade(config, "head")
        with engine.begin() as connection:
            assert _methods(connection) == [
                ("HOST_ARRIVAL", "10-20", None),
                ("HOST_VISIT_CANCELLED", "10-20", "CANCEL"),
                ("HOST_VISIT_RESCHEDULED", "10-19", "REQUEST"),
                ("HOST_VISIT_SCHEDULED", "10-19", "REQUEST"),
                ("VISITOR_CALENDAR", "10-19", "REQUEST"),
                ("VISIT_CANCELLED", "10-02", None),  # before the first calendar e-mail
                ("VISIT_CANCELLED", "10-20", "CANCEL"),
                ("VISIT_RESCHEDULED", "10-01", None),
                ("VISIT_RESCHEDULED", "10-19", "REQUEST"),
            ]
            validated = "SELECT convalidated FROM pg_constraint WHERE conname = :name"
            check = "ck_email_messages_calendar_method_valid"
            assert connection.execute(text(validated), {"name": check}).scalar_one()
            savepoint = connection.begin_nested()
            with pytest.raises(IntegrityError, match="ck_email_messages_calendar_method_valid"):
                connection.execute(text("UPDATE email_messages SET calendar_method = 'PUBLISH'"))
            savepoint.rollback()
    finally:
        engine.dispose()
