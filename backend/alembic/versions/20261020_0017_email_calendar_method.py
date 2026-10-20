"""The calendar event an e-mail carried: `email_messages.calendar_method`.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-20

Phase 14 after its verification (docs/decisions/phase-14-backend.md, B14-26): whether a calendar holds a
visit's event decides what a later change sends it (a cancelled visit always leaves the visitor's
calendar, B14-16; an old address loses the event, B14-17; with calendar invitations switched off only the
calendars that hold an event are sent its changes, B14-27). A notice of a new time can now go without its
event (beyond the company's budget, or to a calendar that never had it while the switch is off), so the
kind of an e-mail no longer says whether it carried one. The method it carried is recorded:

* `email_messages.calendar_method` varchar(8), NULL when the message carried no event, else `REQUEST` or
  `CANCEL`; CHECK `ck_email_messages_calendar_method_valid`. A nullable column without a default rewrites
  no table.
* The rows written before this revision get the method their kind and age tell. Every row of the kinds
  revision 0016 added carried an event: `VISITOR_CALENDAR` a REQUEST (a withdrawal of B14-17 too, which
  then counts as a REQUEST: one CANCEL too many later, never one too few), the host's notice of a new
  visit and of a new time a REQUEST, the host's cancellation a CANCEL. `VISIT_RESCHEDULED` and
  `VISIT_CANCELLED` carried one only once revision 0016's code sent them, that is from the first row of
  those kinds on: they get REQUEST and CANCEL from then on, and stay NULL before (a database upgraded
  from 0015 has no such row, so none is marked). A host whose address was the sending mailbox was sent
  no event (B14-5); its rows count as holding one, which only lets the visit's later notices reach that
  host as they always did.

Locks as revision 0016 (B14-23): `lock_timeout` is 5 s for the upgrade, put back to the session's value at
its end; the CHECK is added NOT VALID and then validated.

Privileges: the runtime role's table-level SELECT, INSERT and UPDATE on `email_messages` cover a new
column; nothing is granted or revoked here.

Downgrade drops the column and its CHECK: revision 0016's code does not read it. What it held is lost; an
upgrade again marks the rows by their kind and age as above.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The longest the upgrade waits for a table's lock (B14-23).
LOCK_TIMEOUT = "5s"
CHECK = "ck_email_messages_calendar_method_valid"
# The kinds revision 0016 added: every row of them carried an event.
CALENDAR_KINDS = (
    "VISITOR_CALENDAR",
    "HOST_VISIT_SCHEDULED",
    "HOST_VISIT_RESCHEDULED",
    "HOST_VISIT_CANCELLED",
)
CANCEL_KINDS = ("VISIT_CANCELLED", "HOST_VISIT_CANCELLED")


def _quoted(kinds: Sequence[str]) -> str:
    return ", ".join(f"'{kind}'" for kind in kinds)


def upgrade() -> None:
    # B14-23: no lock waited for longer than this; the session's own value again after the upgrade.
    op.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
    op.add_column("email_messages", sa.Column("calendar_method", sa.String(8), nullable=True))
    first_calendar_row = (
        f"(SELECT min(created_at) FROM email_messages WHERE kind IN ({_quoted(CALENDAR_KINDS)}))"
    )
    op.execute(
        "UPDATE email_messages SET calendar_method = "
        f"CASE WHEN kind IN ({_quoted(CANCEL_KINDS)}) THEN 'CANCEL' ELSE 'REQUEST' END "
        f"WHERE kind IN ({_quoted(CALENDAR_KINDS)}) "
        f"OR (kind IN ('VISIT_RESCHEDULED', 'VISIT_CANCELLED') AND created_at >= {first_calendar_row})"
    )
    op.execute(
        f"ALTER TABLE email_messages ADD CONSTRAINT {CHECK} "
        "CHECK (calendar_method IN ('REQUEST', 'CANCEL')) NOT VALID"
    )
    op.execute(f"ALTER TABLE email_messages VALIDATE CONSTRAINT {CHECK}")
    op.execute("SET LOCAL lock_timeout TO DEFAULT")


def downgrade() -> None:
    op.drop_constraint(op.f(CHECK), "email_messages", type_="check")
    op.drop_column("email_messages", "calendar_method")
