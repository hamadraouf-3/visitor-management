"""The runtime role may no longer delete rows.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-06

Revision 0001 granted the runtime role (DB_APP_ROLE) SELECT, INSERT, UPDATE and DELETE on every table but
audit_logs, as contract §4 words it. The application deletes nothing: visits and visitors are never
deleted (D-12), users and departments are deactivated, sessions and reset tokens are revoked or
invalidated in place, passes are revoked, e-mail rows keep their final status. The unused DELETE only
let a SQL injection or a leaked runtime credential erase visit history (the `visits_terminal_immutable`
trigger guards UPDATE only). This revision revokes it on every table, and from the default privileges
so tables created later follow. The schema owner keeps every privilege for deliberate maintenance
(retention, anonymisation).

Downgrade grants DELETE back exactly as revision 0001 did.
"""

import re
from collections.abc import Sequence

from alembic import context, op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The tables revision 0001 granted DELETE on (every table but audit_logs).
TABLES_GRANTED_DELETE = (
    "companies",
    "departments",
    "users",
    "user_sessions",
    "password_reset_tokens",
    "visitors",
    "visits",
    "visitor_passes",
    "email_messages",
)


def _app_role() -> str:
    role = context.config.attributes.get("app_role") or "vms_app"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid application role name: {role!r}")
    return role


def upgrade() -> None:
    role = _app_role()
    op.execute(f"REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM {role}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE DELETE ON TABLES FROM {role}")


def downgrade() -> None:
    role = _app_role()
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO {role}")
    op.execute(f"GRANT DELETE ON TABLE {', '.join(TABLES_GRANTED_DELETE)} TO {role}")
