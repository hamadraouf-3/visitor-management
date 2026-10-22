"""When an area alert escalated: `tracking_alerts.escalated_at`.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-21

Phase 16 after its review (docs/decisions/phase-16-backend.md, B16-26). The shell's summary
(`GET /tracking/alerts/summary`) names the five newest OPEN alerts. An escalation (UNAUTHORIZED_AREA ->
RESTRICTED_AREA, OPEN again, B16-8) keeps the alert's `opened_at`, the first violating observation's time,
so with five newer alerts open an escalated one never reached the five and the interface never told of it.
The summary is now ordered by `coalesce(escalated_at, opened_at)`:

* `tracking_alerts.escalated_at` timestamptz NULL: the server's time of the escalation, like
  `acknowledged_at` and `resolved_at`; NULL for an alert that never escalated (an alert escalates once at
  most: it never backs down). A nullable column without a default rewrites no table.
* The alerts escalated before this revision get the time of their escalation from the audit log: the
  `TRACKING_ALERT_ESCALATED` row whose `alert_id` names them, read through the index on (company, action).

No new index: the summary reads a company's OPEN alerts through `ix_tracking_alerts_company_status`, at
most one per checked-in visit (B16-6), and sorts those few.

Additive only: the previous release's code (revision 0019's) runs unchanged on this schema. It never names
the column, so an alert it escalates keeps NULL and is ordered by `opened_at`, as in that release; its
`prune-journeys` deletes alerts whatever their columns. `lock_timeout` is 5 s for the upgrade (B14-23).

Privileges: the runtime role's table-level SELECT, INSERT and UPDATE on `tracking_alerts` (revision 0019,
from the schema's default privileges) cover a new column; nothing is granted or revoked here.

Downgrade drops the column: revision 0019's code does not read it. Only the summary's order depended on
it; the escalations stay in the audit log, from which an upgrade again reads them back.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The longest the upgrade waits for a table's lock (B14-23).
LOCK_TIMEOUT = "5s"
TABLE = "tracking_alerts"
COLUMN = "escalated_at"
# Each escalated alert's escalation, from its audit row (B16-16), of the companies that hold alerts.
BACKFILL = f"""
    UPDATE {TABLE} t
    SET {COLUMN} = e.escalated_at
    FROM (
        SELECT a.company_id, a.metadata ->> 'alert_id' AS alert_id, max(a.created_at) AS escalated_at
        FROM audit_logs a
        WHERE a.company_id IN (SELECT DISTINCT company_id FROM {TABLE})
          AND a.action = 'TRACKING_ALERT_ESCALATED'
        GROUP BY a.company_id, a.metadata ->> 'alert_id'
    ) e
    WHERE t.company_id = e.company_id AND t.id::text = e.alert_id
"""


def upgrade() -> None:
    # B14-23: no lock waited for longer than this; the session's own value again after the upgrade.
    op.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
    op.add_column(TABLE, sa.Column(COLUMN, sa.DateTime(timezone=True), nullable=True))
    op.execute(BACKFILL)
    op.execute("SET LOCAL lock_timeout TO DEFAULT")


def downgrade() -> None:
    op.drop_column(TABLE, COLUMN)
