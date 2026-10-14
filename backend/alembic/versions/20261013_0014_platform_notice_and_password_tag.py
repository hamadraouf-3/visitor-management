"""Security review of Phase 11: the notice of a platform action, and a temporary password's own tag.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-13

Phase 11 security review (docs/decisions/phase-11-backend.md, B11-34 onwards):

* B11-43: e-mail kind PLATFORM_ACTION_NOTICE, the security notice a company's other administrators
  receive when the platform owner adds an administrator to their company or sends one a password-reset
  link. `ck_email_messages_kind_valid` gains the value. The kind is not editable: the CHECK of
  `email_template_overrides.kind` (revision 0013) is unchanged.
* B11-35: `platform_admins.temporary_password_tag` char(64) NULL: the SHA-256 tag of the first characters
  of a temporary password that `create-platform-admin` generated. A sign-in whose password starts with
  them is judged by a failure budget of its own, so the account's lockout, which anyone who knows the
  address can cause, does not keep the holder of that password out. It is no password hash: the tagged
  characters are extra ones, in front of the 20 random characters that alone carry the password's
  strength, and the Argon2id hash in `password_hash` covers all of them. A tag exists only beside a
  temporary password (CHECK `ck_platform_admins_temporary_password_tag_is_temporary`), so it ends with the
  forced password change.

Privileges: the runtime role holds table-level SELECT, INSERT and UPDATE on `platform_admins` and
`email_messages` (the schema's default privileges, revisions 0001 and 0006), which cover a new column and
a changed CHECK; nothing is granted or revoked here, and the downgrade-then-upgrade test compares the
privileges before and after. Adding a nullable column rewrites no table; replacing the CHECK reads
`email_messages` once to validate it.

Downgrade restores the CHECK of revision 0013 and drops the column. It refuses, after locking
`email_messages` (SEC-39), while a PLATFORM_ACTION_NOTICE row exists: the older schema cannot represent
it, and the e-mail log is evidence of who was told what. Dropping the tags loses nothing that the next
upgrade must restore: a temporary password still signs in, only without a budget of its own, until the
operator issues a new one (`create-platform-admin --reset`).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS_BEFORE = (
    "VISITOR_INVITATION",
    "VISIT_RESCHEDULED",
    "VISIT_CANCELLED",
    "HOST_ARRIVAL",
    "PASSWORD_RESET",
    "PASSWORD_CHANGED",
)
NOTICE_KIND = "PLATFORM_ACTION_NOTICE"
KINDS_AFTER = (*KINDS_BEFORE, NOTICE_KIND)


def _kind_check(kinds: Sequence[str]) -> None:
    op.drop_constraint(op.f("ck_email_messages_kind_valid"), "email_messages", type_="check")
    op.create_check_constraint(
        op.f("ck_email_messages_kind_valid"),
        "email_messages",
        "kind IN (" + ", ".join(f"'{kind}'" for kind in kinds) + ")",
    )


def upgrade() -> None:
    # B11-43
    _kind_check(KINDS_AFTER)
    # B11-35
    op.add_column("platform_admins", sa.Column("temporary_password_tag", sa.CHAR(64), nullable=True))
    op.create_check_constraint(
        op.f("ck_platform_admins_temporary_password_tag_is_temporary"),
        "platform_admins",
        "temporary_password_tag IS NULL OR must_change_password",
    )


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a notice still being queued is invisible to the count, and the
    # restored CHECK would then fail on it, or the row would be written against the older schema.
    op.execute("LOCK TABLE email_messages, platform_admins IN ACCESS EXCLUSIVE MODE")
    notices = connection.execute(
        sa.text("SELECT count(*) FROM email_messages WHERE kind = :kind"), {"kind": NOTICE_KIND}
    ).scalar_one()
    if notices:
        raise RuntimeError(
            "revision 0014 cannot be downgraded: "
            f"{notices} {NOTICE_KIND} e-mail row(s) are not representable before 0014. Restore a backup "
            "taken before the upgrade instead."
        )
    op.drop_constraint(
        op.f("ck_platform_admins_temporary_password_tag_is_temporary"), "platform_admins", type_="check"
    )
    op.drop_column("platform_admins", "temporary_password_tag")
    _kind_check(KINDS_BEFORE)
