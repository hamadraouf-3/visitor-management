"""Startup check of the runtime database role (SEC-23, contract §4 "least privilege at runtime").

The database-level guarantees (append-only `audit_logs`, no deleted visit history, no DDL) hold only
while the application connects as the restricted runtime role that the migrations grant to. Pointed at
the schema owner (one credential for DATABASE_URL and MIGRATION_DATABASE_URL is a common shortcut), a
superuser, or a role granted more than that, the application would run as before while a SQL injection,
a leaked credential or a bug could disable the triggers, delete history or create tables, and nothing
would show it. Production therefore refuses to start unless the connected role has none of these.

The migrations give the runtime role table, column and sequence privileges only, so the role is judged
as an allowlist where a privilege check cannot see everything (SEC-49): it must be the role the
connection logged in as (no role switched to by a startup option or a role default: `SET ROLE NONE`
would give the login role back), have no role attribute but LOGIN and INHERIT (SUPERUSER, BYPASSRLS,
REPLICATION, CREATEROLE, CREATEDB), and be a member of no role at all, whatever the membership's INHERIT
and SET options say: a privilege reachable only through `SET ROLE` is invisible to `has_table_privilege`,
and memberships of predefined roles such as `pg_execute_server_program` or `pg_write_server_files` hand
out the database server's operating-system account (those three are also named on their own). It must
own nothing in `public`: no table, sequence, view, function or type, nor the schema itself.

Table privileges are an allowlist too (SEC-R7): every privilege the role holds on a table, view,
sequence or column of `public`, directly or through PUBLIC, must be one the migrations grant: SELECT,
INSERT and UPDATE on the business tables (and on tables a later migration adds: the schema's default
privileges); on `audit_logs` and `platform_audit_logs` SELECT and INSERT on every column but `seq`; SELECT
and USAGE on sequences other than the audit orders' (default privileges again), nothing on those; nothing on
`alembic_version`. A short denylist let "GRANT ALL, then revoke what the error names" through with
MAINTAIN (a runtime credential could hold ACCESS EXCLUSIVE on `audit_logs` and stall every audited
write), TRIGGER (it could attach `audit_logs_immutable()` to `visits` and make every visit change fail),
REFERENCES and write access to the migration state. Everything else is named `holds_unexpected_privileges`,
so a privilege type PostgreSQL adds later is refused as well.

The role must also have no default settings of its own (`ALTER ROLE … SET`, for every database or for
this one, SEC-38). PostgreSQL lets every role set them for itself, and nothing can revoke that; they
apply to every new connection, survive a restart, a password rotation and (when set for every database)
a restore, and the schema owner cannot remove them. A leaked runtime credential could so make every
write fail while /health stays "ok", or weaken durability (`synchronous_commit`) or the timeouts. The
settings the application depends on are pinned by every connection (`db.session.SESSION_SETTINGS`);
this check refuses the rest, and every connection must run READ COMMITTED (SEC-37). The remedy, by
whoever holds the runtime credential: `ALTER ROLE <runtime role> RESET ALL` (and `… IN DATABASE <db>
RESET ALL`). Settings of the database itself (`ALTER DATABASE … SET`) need its owner and are not refused.

Finally the connection must not have signed in with a published local-development password (SEC-18,
SEC-R6). Configuration refuses it in the URL, a `password` parameter and PGPASSWORD; libpq can also take it
from a password file or a connection service entry, which configuration cannot read, so the password the
connection actually used (libpq's PQpass) is checked here.

The check names only the failing properties and the names of the parameters, never the role's name, a
password or a setting's value.
"""

from collections.abc import Iterable
from dataclasses import dataclass

import psycopg
from sqlalchemy import Engine, text

from app.core.config import ConfigurationError, is_published_database_password
from app.db.errors import database_error_summary

# The judged role is the connection's login role (`session_user`), or `:role` (tests and diagnostics).
_CHECK = text(
    """
    WITH judged AS (
        SELECT r.* FROM pg_roles r WHERE r.rolname = coalesce(CAST(:role AS name), session_user)
    )
    SELECT
        session_user <> current_user AS switched_role,
        j.rolsuper AS superuser,
        j.rolbypassrls AS bypasses_row_security,
        j.rolreplication AS replicates,
        j.rolcreaterole AS creates_roles,
        j.rolcreatedb AS creates_databases,
        EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = j.oid) AS member_of_roles,
        (
            pg_has_role(j.oid, 'pg_execute_server_program', 'MEMBER')
            OR pg_has_role(j.oid, 'pg_read_server_files', 'MEMBER')
            OR pg_has_role(j.oid, 'pg_write_server_files', 'MEMBER')
        ) AS uses_server_files_or_programs,
        (
            EXISTS (
                SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND pg_has_role(j.oid, c.relowner, 'MEMBER')
            )
            OR EXISTS (
                SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND pg_has_role(j.oid, p.proowner, 'MEMBER')
            )
            OR EXISTS (
                SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'public' AND pg_has_role(j.oid, t.typowner, 'MEMBER')
            )
            OR EXISTS (
                SELECT 1 FROM pg_namespace n
                WHERE n.nspname = 'public' AND pg_has_role(j.oid, n.nspowner, 'MEMBER')
            )
        ) AS owns_schema_objects,
        has_schema_privilege(j.oid, 'public', 'CREATE') AS creates_in_schema,
        has_database_privilege(j.oid, current_database(), 'CREATE') AS creates_schemas,
        has_database_privilege(j.oid, current_database(), 'TEMPORARY') AS creates_temporary_objects,
        (
            has_table_privilege(j.oid, 'public.audit_logs', 'UPDATE')
            OR has_table_privilege(j.oid, 'public.audit_logs', 'DELETE')
            OR has_table_privilege(j.oid, 'public.audit_logs', 'TRUNCATE')
            OR has_table_privilege(j.oid, 'public.audit_logs', 'TRIGGER')
            OR coalesce(
                has_table_privilege(j.oid, to_regclass('public.platform_audit_logs'), 'UPDATE')
                OR has_table_privilege(j.oid, to_regclass('public.platform_audit_logs'), 'DELETE')
                OR has_table_privilege(j.oid, to_regclass('public.platform_audit_logs'), 'TRUNCATE')
                OR has_table_privilege(j.oid, to_regclass('public.platform_audit_logs'), 'TRIGGER'),
                false
            )
        ) AS changes_audit_rows,
        (
            has_column_privilege(j.oid, 'public.audit_logs', 'seq', 'INSERT')
            OR coalesce(
                has_column_privilege(j.oid, to_regclass('public.platform_audit_logs'), 'seq', 'INSERT'), false
            )
        ) AS chooses_audit_order,
        EXISTS (
            SELECT 1 FROM pg_tables t
            WHERE t.schemaname = 'public' AND (
                has_table_privilege(j.oid, format('%I.%I', t.schemaname, t.tablename), 'DELETE')
                OR has_table_privilege(j.oid, format('%I.%I', t.schemaname, t.tablename), 'TRUNCATE')
            )
        ) AS deletes_rows,
        current_setting('transaction_isolation') <> 'read committed' AS not_read_committed
    FROM judged j
    """
)
# The defaults of the login role and of the current role (they differ only on a refused switch): for every
# database (setdatabase 0) and for this one.
_ROLE_SETTINGS = text(
    """
    SELECT DISTINCT split_part(setting, '=', 1) AS name
    FROM pg_db_role_setting s
    CROSS JOIN LATERAL unnest(s.setconfig) AS setting
    WHERE s.setrole IN (SELECT oid FROM pg_roles WHERE rolname IN (session_user, current_user))
      AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
    ORDER BY 1
    """
)


# Every privilege the judged role holds on a relation (table, partitioned table, view, materialized view,
# foreign table, sequence) of `public` or on one of its columns, granted to it directly or to PUBLIC; a
# relation without an ACL has its owner's default one. Privileges through a membership are not listed:
# any membership is refused on its own (`member_of_roles`).
_HELD_PRIVILEGES = text(
    """
    WITH judged AS (
        SELECT r.oid FROM pg_roles r WHERE r.rolname = coalesce(CAST(:role AS name), session_user)
    ),
    relations AS (
        SELECT c.oid, c.relname, c.relkind, c.relowner, c.relacl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ),
    granted AS (
        SELECT r.oid, r.relname, r.relkind, CAST(NULL AS name) AS attname, a.grantee, a.privilege_type
        FROM relations r
        CROSS JOIN LATERAL aclexplode(coalesce(
            r.relacl,
            acldefault(CAST(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END AS "char"), r.relowner)
        )) a
        UNION ALL
        SELECT r.oid, r.relname, r.relkind, att.attname, a.grantee, a.privilege_type
        FROM relations r
        JOIN pg_attribute att
            ON att.attrelid = r.oid AND att.attnum > 0 AND NOT att.attisdropped AND att.attacl IS NOT NULL
        CROSS JOIN LATERAL aclexplode(att.attacl) a
    )
    SELECT DISTINCT
        g.relname AS relation,
        CAST(g.relkind AS text) AS kind,
        CAST(g.attname AS text) AS column_name,
        g.privilege_type AS privilege,
        coalesce(
            g.oid = to_regclass(pg_get_serial_sequence('public.audit_logs', 'seq'))
            OR (
                to_regclass('public.platform_audit_logs') IS NOT NULL
                AND g.oid = to_regclass(pg_get_serial_sequence('public.platform_audit_logs', 'seq'))
            ),
            false
        ) AS audit_order_sequence
    FROM granted g CROSS JOIN judged j
    WHERE g.grantee IN (j.oid, 0)
    ORDER BY 1, 3, 4
    """
)

AUDIT_TABLE = "audit_logs"
# Every append-only trail: the companies' and the platform owner's (revision 0013, B11-4).
AUDIT_TABLES = frozenset({AUDIT_TABLE, "platform_audit_logs"})
AUDIT_ORDER_COLUMN = "seq"
MIGRATION_STATE_TABLE = "alembic_version"
# What the migrations grant the runtime role: on every business table, and through the schema's default
# privileges on every table and sequence a later migration creates.
_TABLE_PRIVILEGES = frozenset({"SELECT", "INSERT", "UPDATE"})
_SEQUENCE_PRIVILEGES = frozenset({"SELECT", "USAGE"})
# The names the problems are reported by, in this order after those of `_CHECK`.
_PRIVILEGE_PROBLEMS = (
    "deletes_rows",
    "changes_audit_rows",
    "chooses_audit_order",
    "maintains_tables",
    "adds_triggers",
    "references_tables",
    "accesses_migration_state",
    "holds_unexpected_privileges",
)


@dataclass(frozen=True, slots=True)
class HeldPrivilege:
    """One privilege the judged role holds (`_HELD_PRIVILEGES`)."""

    relation: str
    kind: str  # pg_class.relkind: 'S' a sequence, anything else a table-like relation
    column: str | None  # a column privilege, or None for one on the whole relation
    privilege: str  # SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, USAGE, ...
    audit_order_sequence: bool = False  # the sequence behind audit_logs.seq


def _granted_by_migrations(held: HeldPrivilege) -> bool:
    if held.kind == "S":
        return not held.audit_order_sequence and held.privilege in _SEQUENCE_PRIVILEGES
    if held.relation == MIGRATION_STATE_TABLE:
        return False
    if held.relation in AUDIT_TABLES:
        return held.privilege == "SELECT" or (
            held.privilege == "INSERT" and held.column is not None and held.column != AUDIT_ORDER_COLUMN
        )
    return held.privilege in _TABLE_PRIVILEGES


def _problem_names(held: HeldPrivilege) -> set[str]:
    """What a privilege beyond the migrations' grants allows, by the names the check reports."""
    if held.kind == "S":
        return {"chooses_audit_order" if held.audit_order_sequence else "holds_unexpected_privileges"}
    names: set[str] = set()
    if held.relation == MIGRATION_STATE_TABLE:
        names.add("accesses_migration_state")
    if held.privilege in {"DELETE", "TRUNCATE"}:
        names.add("deletes_rows")
    if held.relation in AUDIT_TABLES:
        if held.privilege in {"UPDATE", "DELETE", "TRUNCATE", "TRIGGER"}:
            names.add("changes_audit_rows")
        elif held.privilege == "INSERT":  # on the whole table, or on `seq`
            names.add("chooses_audit_order")
    names |= {
        name
        for privilege, name in (
            ("MAINTAIN", "maintains_tables"),
            ("TRIGGER", "adds_triggers"),
            ("REFERENCES", "references_tables"),
        )
        if held.privilege == privilege
    }
    return names or {"holds_unexpected_privileges"}


def privileges_beyond_the_migrations(held: Iterable[HeldPrivilege]) -> list[str]:
    """The problems of the privileges in `held` that the migrations do not grant the runtime role, in
    `_PRIVILEGE_PROBLEMS` order (empty: none)."""
    names: set[str] = set()
    for privilege in held:
        if not _granted_by_migrations(privilege):
            names |= _problem_names(privilege)
    return [name for name in _PRIVILEGE_PROBLEMS if name in names]


def runtime_privilege_problems(engine: Engine, *, role: str | None = None) -> list[str]:
    """The properties of the connection's login role (or of `role`, for tests and diagnostics) that the
    runtime role must not have (empty: none)."""
    with engine.connect() as connection:
        row = connection.execute(_CHECK, {"role": role}).mappings().one()
        held = [
            HeldPrivilege(
                relation=privilege["relation"],
                kind=privilege["kind"],
                column=privilege["column_name"],
                privilege=privilege["privilege"],
                audit_order_sequence=privilege["audit_order_sequence"],
            )
            for privilege in connection.execute(_HELD_PRIVILEGES, {"role": role}).mappings()
        ]
        connection.rollback()
    problems = [name for name, present in row.items() if present]
    return problems + [name for name in privileges_beyond_the_migrations(held) if name not in problems]


def runtime_password_is_published(engine: Engine) -> bool:
    """Whether the connection signed in with a published local-development password, wherever libpq took
    it from (the URL, PGPASSWORD, a password file, a connection service): libpq's PQpass reports the
    password the connection used. The password itself never leaves this function."""
    with engine.connect() as connection:
        driver = connection.connection.driver_connection
        password: str | None = driver.info.password if isinstance(driver, psycopg.Connection) else None
        connection.rollback()
    return is_published_database_password(password or None)


def runtime_role_settings(engine: Engine) -> list[str]:
    """The names of the parameters the connection's login role (and current role) has defaults for
    (`ALTER ROLE … SET`), for every database or for this one (empty: none)."""
    with engine.connect() as connection:
        names = list(connection.execute(_ROLE_SETTINGS).scalars())
        connection.rollback()
    return names


def require_runtime_privileges(engine: Engine) -> None:
    """Refuse to run with a database role that could undo the database-level guarantees, that carries
    default settings of its own, or that signed in with a published local-development password.

    A failure to connect is reported by the driver error's class and SQLSTATE only, never its message
    (SEC-36): libpq quotes the host it tried, and for a URL whose password holds an unencoded "@" that
    "host" is the end of the password. Uvicorn logs a failed startup's traceback as plain text, so the
    driver error must not be part of it (`from None`)."""
    try:
        problems = runtime_privilege_problems(engine)
        settings = runtime_role_settings(engine)
        published_password = runtime_password_is_published(engine)
    except Exception as exc:
        summary = database_error_summary(exc) or {"error": type(exc).__name__}
        raise ConfigurationError(
            "could not check the runtime database role ("
            + ", ".join(f"{key}={value}" for key, value in summary.items())
            + "); the driver's message is not shown because it can quote parts of DATABASE_URL: check "
            "its host, port, database name, user name and password"
        ) from None
    if problems:
        raise ConfigurationError(
            "DATABASE_URL must connect as the restricted runtime role (DB_APP_ROLE) the migrations "
            "grant to: a plain LOGIN role that is a member of no other role and holds no privileges "
            "beyond the migrations' grants; the connected role has: " + ", ".join(problems)
        )
    if settings:
        raise ConfigurationError(
            "the runtime role (DB_APP_ROLE) has default settings of its own (ALTER ROLE ... SET), which "
            "anyone holding its credential can set: " + ", ".join(settings) + ". Remove them with "
            "ALTER ROLE ... RESET ALL (and ALTER ROLE ... IN DATABASE ... RESET ALL); settings the "
            "deployment needs belong to the database (ALTER DATABASE ... SET)"
        )
    if published_password:
        raise ConfigurationError(
            "DATABASE_URL signs in with a published local-development password (from the URL, "
            "PGPASSWORD, a password file or a connection service entry): give the runtime role a password "
            "of its own"
        )
