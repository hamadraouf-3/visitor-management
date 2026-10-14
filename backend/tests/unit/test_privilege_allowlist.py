"""The runtime role's table privileges are judged as an allowlist of the migrations' grants (SEC-R7):
`privileges_beyond_the_migrations` on its own, for the cases a test database cannot set up (privilege
types PostgreSQL may add later) and for the exact boundaries of what is allowed."""

import pytest

from app.db.privileges import HeldPrivilege, privileges_beyond_the_migrations


def _table(relation: str, privilege: str, column: str | None = None) -> HeldPrivilege:
    return HeldPrivilege(relation=relation, kind="r", column=column, privilege=privilege)


def _sequence(privilege: str, *, audit_order: bool = False) -> HeldPrivilege:
    name = "audit_logs_seq_seq" if audit_order else "later_sequence"
    return HeldPrivilege(
        relation=name, kind="S", column=None, privilege=privilege, audit_order_sequence=audit_order
    )


AS_MIGRATED = [
    *(
        _table(table, privilege)
        for table in ("visits", "visitors", "users")
        for privilege in ("SELECT", "INSERT", "UPDATE")
    ),
    _table("audit_logs", "SELECT"),
    *(_table("audit_logs", "INSERT", column) for column in ("id", "action", "metadata", "created_at")),
]


def test_the_migrations_grants_pass() -> None:
    assert privileges_beyond_the_migrations(AS_MIGRATED) == []


@pytest.mark.parametrize(
    "held",
    [
        _table("later_table", "UPDATE"),  # a later migration's table (default privileges)
        _table("visits", "UPDATE", "purpose"),  # a column subset of a table grant
        _table("audit_logs", "SELECT", "action"),
        _table("visitors", "SELECT", "id"),
        _sequence("USAGE"),  # a later migration's sequence (default privileges)
        _sequence("SELECT"),
        HeldPrivilege(relation="later_view", kind="v", column=None, privilege="SELECT"),
    ],
)
def test_what_the_migrations_and_their_default_privileges_grant_passes(held: HeldPrivilege) -> None:
    assert privileges_beyond_the_migrations([*AS_MIGRATED, held]) == []


@pytest.mark.parametrize(
    ("held", "problems"),
    [
        (_table("visits", "MAINTAIN"), ["maintains_tables"]),
        (_table("audit_logs", "MAINTAIN"), ["maintains_tables"]),
        (_table("visits", "TRIGGER"), ["adds_triggers"]),
        (_table("audit_logs", "TRIGGER"), ["changes_audit_rows", "adds_triggers"]),
        (_table("users", "REFERENCES"), ["references_tables"]),
        (_table("users", "REFERENCES", "id"), ["references_tables"]),
        (_table("visits", "DELETE"), ["deletes_rows"]),
        (_table("visits", "TRUNCATE"), ["deletes_rows"]),
        (_table("audit_logs", "DELETE"), ["deletes_rows", "changes_audit_rows"]),
        (_table("audit_logs", "UPDATE"), ["changes_audit_rows"]),
        (_table("audit_logs", "UPDATE", "metadata"), ["changes_audit_rows"]),
        (_table("audit_logs", "INSERT"), ["chooses_audit_order"]),  # the whole table includes `seq`
        (_table("audit_logs", "INSERT", "seq"), ["chooses_audit_order"]),
        (_sequence("USAGE", audit_order=True), ["chooses_audit_order"]),  # nextval
        (_sequence("UPDATE", audit_order=True), ["chooses_audit_order"]),  # setval
        (_table("alembic_version", "SELECT"), ["accesses_migration_state"]),
        (_table("alembic_version", "UPDATE"), ["accesses_migration_state"]),
        (_table("alembic_version", "DELETE"), ["deletes_rows", "accesses_migration_state"]),
        (_sequence("UPDATE"), ["holds_unexpected_privileges"]),
        # A privilege type a later PostgreSQL adds is refused until the check knows it.
        (_table("visits", "SOMETHING_NEW"), ["holds_unexpected_privileges"]),
    ],
)
def test_privileges_beyond_the_migrations_are_named(held: HeldPrivilege, problems: list[str]) -> None:
    assert privileges_beyond_the_migrations([*AS_MIGRATED, held]) == problems


def test_the_problems_are_reported_once_and_in_a_fixed_order() -> None:
    held = [
        _table("alembic_version", "INSERT"),
        _table("visits", "REFERENCES"),
        _table("users", "TRIGGER"),
        _table("visits", "MAINTAIN"),
        _table("audit_logs", "MAINTAIN"),
    ]
    assert privileges_beyond_the_migrations(held) == [
        "maintains_tables",
        "adds_triggers",
        "references_tables",
        "accesses_migration_state",
    ]
