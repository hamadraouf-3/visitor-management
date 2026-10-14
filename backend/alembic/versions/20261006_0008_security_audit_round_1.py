"""Security audit round 1: runtime-role hardening, the password-changed e-mail and visitor ownership.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-06

* SEC-21: the runtime role (DB_APP_ROLE) may insert audit rows but no longer choose their `seq`. Revision
  0001 granted table-level INSERT on `audit_logs` and USAGE on its identity sequence ("+ sequence usage",
  §4), which let a leaked runtime credential place forged rows anywhere in the audit order (INSERT …
  OVERRIDING SYSTEM VALUE, COPY) and claim future `seq` values so that every later audit write failed.
  INSERT is now granted on every column but `seq`, and the sequence privileges are revoked: an identity
  column draws its value without them.
* SEC-22: no TEMPORARY for anyone but the owner on this database. PostgreSQL grants it to PUBLIC on
  every new database, and only scripts/db.ps1 and the test harness revoked it, so a database provisioned
  any other way let the runtime role create temporary tables that shadow `audit_logs` for its session.
  The migration role owns the database (contract §4), so the revocation works here; for a database it
  does not own, PostgreSQL only warns, and the application's startup check refuses to run with the
  privilege in production (`app.db.privileges`).
* SEC-06: e-mail kind PASSWORD_CHANGED (the notice after a password change or reset).
* SEC-08: `visitors.owned_by_creator`: whether creating the visitor puts it in its creator's own read
  scope. Existing rows keep the behaviour they had (true); there is no production data.

Downgrade restores the grants of revisions 0001-0007 (TEMPORARY stays revoked: it was never granted by a
migration) and refuses to run while rows exist that the older schema cannot represent faithfully: a
visitor whose `owned_by_creator` is false (it would silently become true, putting the visitor back into
a former receptionist's scope, the SEC-24 lesson) or a PASSWORD_CHANGED e-mail. The tables are locked
before the rows are counted, so a write in progress cannot slip past the count (SEC-39). Downgrades are
meant to run with the API stopped all the same: the older schema breaks the running code.
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Every audit_logs column but the identity `seq`. A column added later needs its own INSERT grant.
AUDIT_INSERT_COLUMNS = (
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
)
KINDS_BEFORE = (
    "VISITOR_INVITATION",
    "VISIT_RESCHEDULED",
    "VISIT_CANCELLED",
    "HOST_ARRIVAL",
    "PASSWORD_RESET",
)
KINDS_AFTER = (*KINDS_BEFORE, "PASSWORD_CHANGED")


def _app_role() -> str:
    role = context.config.attributes.get("app_role") or "vms_app"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid application role name: {role!r}")
    return role


def _kind_check(kinds: Sequence[str]) -> None:
    op.drop_constraint(op.f("ck_email_messages_kind_valid"), "email_messages", type_="check")
    op.create_check_constraint(
        op.f("ck_email_messages_kind_valid"),
        "email_messages",
        "kind IN (" + ", ".join(f"'{kind}'" for kind in kinds) + ")",
    )


def upgrade() -> None:
    role = _app_role()
    # SEC-21
    op.execute(f"REVOKE INSERT ON TABLE audit_logs FROM {role}")
    op.execute(f"GRANT INSERT ({', '.join(AUDIT_INSERT_COLUMNS)}) ON TABLE audit_logs TO {role}")
    op.execute(f"REVOKE ALL ON SEQUENCE audit_logs_seq_seq FROM {role}")
    # SEC-22: PUBLIC holds TEMPORARY by default; the runtime role must not hold it directly either.
    op.execute(
        f"""
        DO $$
        BEGIN
            EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
            EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM {role}', current_database());
        END
        $$
        """
    )
    # SEC-06
    _kind_check(KINDS_AFTER)
    # SEC-08
    op.add_column(
        "visitors",
        sa.Column("owned_by_creator", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a write still in progress (a desk visitor with owned_by_creator
    # false, a PASSWORD_CHANGED notice) is invisible to the counts, and DROP COLUMN would wait for it and
    # then drop its value. Taking the lock first makes every such write commit before the counts (which
    # run READ COMMITTED: `app.db.session.SESSION_SETTINGS`) and holds new ones until the downgrade ends.
    op.execute("LOCK TABLE visitors, email_messages IN ACCESS EXCLUSIVE MODE")
    blocked = connection.execute(
        sa.text("SELECT count(*) FROM visitors WHERE NOT owned_by_creator")
    ).scalar_one()
    notices = connection.execute(
        sa.text("SELECT count(*) FROM email_messages WHERE kind = 'PASSWORD_CHANGED'")
    ).scalar_one()
    if blocked or notices:
        raise RuntimeError(
            "revision 0008 cannot be downgraded: "
            f"{blocked} visitor(s) registered outside their creator's own scope would enter it again, and "
            f"{notices} PASSWORD_CHANGED e-mail row(s) are not representable before 0008. Restore a "
            "backup taken before the upgrade instead."
        )
    role = _app_role()
    op.drop_column("visitors", "owned_by_creator")
    _kind_check(KINDS_BEFORE)
    op.execute(f"REVOKE INSERT ({', '.join(AUDIT_INSERT_COLUMNS)}) ON TABLE audit_logs FROM {role}")
    op.execute(f"GRANT INSERT ON TABLE audit_logs TO {role}")
    op.execute(f"GRANT USAGE ON SEQUENCE audit_logs_seq_seq TO {role}")
