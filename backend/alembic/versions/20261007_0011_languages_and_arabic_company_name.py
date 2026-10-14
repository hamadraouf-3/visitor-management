"""Languages: the user's preferred language, the company's default language and its Arabic name.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-07

Phase 10 (docs/decisions/phase-10-backend.md, B10-1 and B10-2): the product is bilingual (Arabic and
English, switchable by the user).

* `users.preferred_language` varchar(2) NULL, CHECK `ar`/`en`: the user's own choice
  (PATCH /api/v1/auth/preferences); NULL follows the company.
* `companies.default_language` varchar(2) NOT NULL DEFAULT 'ar', CHECK `ar`/`en`: the interface language of
  users without a preference and the leading language of the e-mails to visitors and to those users.
  Existing companies get Arabic, the product's default.
* `companies.name_ar` varchar(200) NULL, CHECK not blank: the Arabic name, shown when the interface or an
  e-mail is in Arabic; `name` stays the English (or only) name. Same length as `name`.

Privileges: the runtime role holds table-level SELECT, INSERT and UPDATE on both tables (revisions 0001 and
0006), which cover new columns; nothing is granted or revoked here. Adding a nullable column, or a column
with a constant default, rewrites no table (PostgreSQL 11+), so the upgrade only takes brief locks.

Downgrade drops the three columns. It refuses while any of them holds a value that the next upgrade would
not restore (an Arabic company name, a user's language, a company whose default language is not Arabic):
dropping it would lose data silently. The tables are locked before the rows are counted (SEC-39), so a
write in progress cannot slip past the count. Clear the values first (the refusal names how) or restore a
backup taken before the upgrade.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LANGUAGES = "'ar', 'en'"
DEFAULT_LANGUAGE = "ar"


def upgrade() -> None:
    op.add_column("users", sa.Column("preferred_language", sa.String(length=2), nullable=True))
    op.create_check_constraint(
        op.f("ck_users_preferred_language_valid"),
        "users",
        f"preferred_language IS NULL OR preferred_language IN ({LANGUAGES})",
    )
    op.add_column("companies", sa.Column("name_ar", sa.String(length=200), nullable=True))
    op.create_check_constraint(
        op.f("ck_companies_name_ar_not_blank"), "companies", "name_ar IS NULL OR btrim(name_ar) <> ''"
    )
    op.add_column(
        "companies",
        sa.Column(
            "default_language",
            sa.String(length=2),
            server_default=sa.text(f"'{DEFAULT_LANGUAGE}'"),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        op.f("ck_companies_default_language_valid"), "companies", f"default_language IN ({LANGUAGES})"
    )


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a write still in progress is invisible to the counts, and DROP COLUMN
    # would wait for it and then drop its value.
    op.execute("LOCK TABLE companies, users IN ACCESS EXCLUSIVE MODE")
    named = connection.execute(
        sa.text("SELECT count(*) FROM companies WHERE name_ar IS NOT NULL")
    ).scalar_one()
    defaults = connection.execute(
        sa.text("SELECT count(*) FROM companies WHERE default_language <> :default"),
        {"default": DEFAULT_LANGUAGE},
    ).scalar_one()
    preferences = connection.execute(
        sa.text("SELECT count(*) FROM users WHERE preferred_language IS NOT NULL")
    ).scalar_one()
    if named or defaults or preferences:
        raise RuntimeError(
            "revision 0011 cannot be downgraded: "
            f"{named} company Arabic name(s), {defaults} company default language(s) other than "
            f"'{DEFAULT_LANGUAGE}' and {preferences} user language preference(s) would be lost. Clear them "
            "first (UPDATE companies SET name_ar = NULL, default_language = 'ar'; UPDATE users SET "
            "preferred_language = NULL) or restore a backup taken before the upgrade."
        )
    op.drop_constraint(op.f("ck_companies_default_language_valid"), "companies", type_="check")
    op.drop_column("companies", "default_language")
    op.drop_constraint(op.f("ck_companies_name_ar_not_blank"), "companies", type_="check")
    op.drop_column("companies", "name_ar")
    op.drop_constraint(op.f("ck_users_preferred_language_valid"), "users", type_="check")
    op.drop_column("users", "preferred_language")
