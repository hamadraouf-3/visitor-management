"""A visit in the visitor's and the host's calendars: the host's e-mails, and the event's version.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-19

Phase 14 (docs/decisions/phase-14-backend.md, B14-1 and B14-6): the visit e-mails carry the visit as a
calendar event (iCalendar, sent as an iTIP REQUEST or CANCEL), and the host is told of a visit, of its new
time and of its cancellation, so the visit is in the host's calendar too.

* E-mail kinds HOST_VISIT_SCHEDULED, HOST_VISIT_RESCHEDULED and HOST_VISIT_CANCELLED: the host's three
  e-mails. `ck_email_messages_kind_valid` gains them, and so does `ck_email_template_overrides_kind_valid`:
  a company may write their texts, as it writes those of the visitor's three (B11-20).
* E-mail kind VISITOR_CALENDAR (B14-10): the short e-mail that follows a visitor's invitation with the
  visit as an event of the visitor's calendar and without the pass, since Outlook keeps an invitation's
  own text in the calendar entry. `ck_email_messages_kind_valid` gains it; it is not editable (its words
  are the invitation's), so the CHECK of `email_template_overrides.kind` does not.
* `visits.calendar_sequence` integer NOT NULL DEFAULT 0, CHECK `ck_visits_calendar_sequence_non_negative`:
  the version of the visit's calendar event, the `SEQUENCE` of every iCalendar object sent about it. 0
  when the visit is created; one more at every new time and at the cancellation, so a calendar applies
  the newer message and ignores an older one. Existing visits start at 0.

Privileges: the runtime role holds table-level SELECT, INSERT and UPDATE on `visits`, `email_messages`
and `email_template_overrides` (the schema's default privileges, revisions 0001 and 0006), which cover a
new column and a changed CHECK; nothing is granted or revoked here. A column with a constant default
rewrites no table.

Locks (B14-23). Every statement here takes its table's ACCESS EXCLUSIVE lock, which waits behind every
open transaction that read the table, and every request that reads it then waits behind the migration.
`lock_timeout` is 5 s for the upgrade (`SET LOCAL`, put back to the session's value at its end): a lock
that is not granted by then fails the upgrade, which leaves nothing behind (one transaction) and is run
again, instead of holding the API up for as long as the longest transaction lasts. The CHECKs of
`email_messages` and `visits` are added NOT VALID and then validated (VALIDATE CONSTRAINT), the form that
lets the scan run under a weaker lock when it is a transaction of its own. Alembic runs the whole upgrade
in one transaction, so here the scan still runs under the lock the ALTER took; the two tables are read
once each. The end state is the same as a validated CHECK's: the same names, all validated.

Downgrade restores the CHECKs of revision 0015 and drops the column. After locking the three tables
(SEC-39) it refuses while:

* an e-mail of the host's kinds or of VISITOR_CALENDAR is in the e-mail log (the older schema cannot
  represent it, and the log is evidence of who was told what);
* a company has a text of one of them (it would be lost). A row whose text is NULL (a text reset to the
  product's) holds nothing and is removed;
* a SCHEDULED visit's event has a version above 0: calendars hold that version, and after the next
  upgrade the counter would start again below it, so their entries would ignore the visit's next
  change. A visit that is no longer SCHEDULED sends nothing again, so its version is not needed.

Restore a backup taken before the upgrade instead.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

HOST_KINDS = ("HOST_VISIT_SCHEDULED", "HOST_VISIT_RESCHEDULED", "HOST_VISIT_CANCELLED")
CALENDAR_KIND = "VISITOR_CALENDAR"
NEW_MESSAGE_KINDS = (*HOST_KINDS, CALENDAR_KIND)
MESSAGE_KINDS_BEFORE = (
    "VISITOR_INVITATION",
    "VISIT_RESCHEDULED",
    "VISIT_CANCELLED",
    "HOST_ARRIVAL",
    "PASSWORD_RESET",
    "PASSWORD_CHANGED",
    "PLATFORM_ACTION_NOTICE",
)
EDITABLE_KINDS_BEFORE = ("VISITOR_INVITATION", "VISIT_RESCHEDULED", "VISIT_CANCELLED", "HOST_ARRIVAL")
# The longest the upgrade waits for a table's lock (B14-23).
LOCK_TIMEOUT = "5s"


def _kind_check(table: str, kinds: Sequence[str]) -> None:
    name = op.f(f"ck_{table}_kind_valid")
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, _kinds(kinds))


def _add_check_not_valid(table: str, name: str, condition: str) -> None:
    """The CHECK `name` added without reading the table, then validated (B14-23)."""
    op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID")
    op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")


def _kinds(kinds: Sequence[str]) -> str:
    return "kind IN (" + ", ".join(f"'{kind}'" for kind in kinds) + ")"


def upgrade() -> None:
    # B14-23: no lock waited for longer than this; the session's own value again after the upgrade.
    op.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
    messages_check = op.f("ck_email_messages_kind_valid")
    op.drop_constraint(messages_check, "email_messages", type_="check")
    _add_check_not_valid(
        "email_messages", messages_check, _kinds((*MESSAGE_KINDS_BEFORE, *NEW_MESSAGE_KINDS))
    )
    _kind_check("email_template_overrides", (*EDITABLE_KINDS_BEFORE, *HOST_KINDS))
    op.add_column(
        "visits",
        sa.Column("calendar_sequence", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    _add_check_not_valid("visits", op.f("ck_visits_calendar_sequence_non_negative"), "calendar_sequence >= 0")
    op.execute("SET LOCAL lock_timeout TO DEFAULT")


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): an e-mail, a text or a new time still being written is invisible
    # to the counts, and the restored CHECKs would then fail on it, or it would be lost.
    op.execute("LOCK TABLE visits, email_messages, email_template_overrides IN ACCESS EXCLUSIVE MODE")
    host_kinds = {"kinds": list(HOST_KINDS)}
    messages = connection.execute(
        sa.text("SELECT count(*) FROM email_messages WHERE kind = ANY(:kinds)"),
        {"kinds": list(NEW_MESSAGE_KINDS)},
    ).scalar_one()
    texts = connection.execute(
        sa.text(
            "SELECT count(*) FROM email_template_overrides WHERE kind = ANY(:kinds) AND text IS NOT NULL"
        ),
        host_kinds,
    ).scalar_one()
    versions = connection.execute(
        sa.text("SELECT count(*) FROM visits WHERE status = 'SCHEDULED' AND calendar_sequence > 0")
    ).scalar_one()
    if messages or texts or versions:
        raise RuntimeError(
            "revision 0016 cannot be downgraded: "
            f"{messages} e-mail row(s) of the host's or the calendar kinds are not representable before 0016, "
            f"{texts} company e-mail text(s) of the host's e-mails would be lost, and {versions} scheduled "
            "visit(s) have a calendar event version that calendars hold. Restore a backup taken before the "
            "upgrade instead."
        )
    connection.execute(sa.text("DELETE FROM email_template_overrides WHERE kind = ANY(:kinds)"), host_kinds)
    op.drop_constraint(op.f("ck_visits_calendar_sequence_non_negative"), "visits", type_="check")
    op.drop_column("visits", "calendar_sequence")
    _kind_check("email_template_overrides", EDITABLE_KINDS_BEFORE)
    _kind_check("email_messages", MESSAGE_KINDS_BEFORE)
