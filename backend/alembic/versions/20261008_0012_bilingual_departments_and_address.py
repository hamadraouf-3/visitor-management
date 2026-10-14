"""Bilingual department names and company address: the Arabic name of a department, the Arabic address of a
company, and the Arabic department name recorded on each visit.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-08

Phase 10 (docs/decisions/phase-10-backend.md, B10-24 to B10-26): in the English interface a department
shows its English name, in the Arabic interface its Arabic name when it has one. `name` stays the
default (English, or only) name, as `companies.name` does next to `name_ar` (revision 0011).

* `departments.name_ar` varchar(120) NULL, CHECK not blank: the department's Arabic name. Same length as
  `name`. Unique per company ignoring case where it is set (`uq_departments_company_name_ar`, partial on
  `name_ar IS NOT NULL`), like `name`'s `uq_departments_company_name`; the service maps it to 409 CONFLICT
  on the field `name_ar`.
* `companies.address_ar` text NULL: the company's address in Arabic, with the rules of `address` (no
  CHECK, as `address` has none: the service stores a blank address as NULL).
* `visits.department_name_ar` varchar(120) NULL: the snapshot of the department's Arabic name beside
  `department_name` (D-17): set when the visit is created, refreshed while it is SCHEDULED, frozen from
  check-in on. Existing visits get NULL: no department had an Arabic name before this revision.

Privileges: the runtime role holds table-level SELECT, INSERT and UPDATE on the three tables (revisions
0001 and 0006), which cover new columns; nothing is granted or revoked here, and the downgrade-then-upgrade
test compares the privileges before and after. Adding a nullable column rewrites no table; the new index
reads only `departments`, which is small.

Downgrade drops the columns and the index. It refuses while any of them holds a value, which the next
upgrade would not restore (an Arabic department name, an Arabic address, an Arabic department name on a
visit): dropping it would lose data silently. The tables are locked before the rows are counted (SEC-39),
so a write in progress cannot slip past the count. Clear the department names and addresses first (the
refusal names how). Checked-out and cancelled visits cannot be changed (`visits_terminal_immutable`), so
once one of them holds an Arabic department name the way back is a backup taken before the upgrade.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("departments", sa.Column("name_ar", sa.String(length=120), nullable=True))
    op.create_check_constraint(
        op.f("ck_departments_name_ar_not_blank"), "departments", "name_ar IS NULL OR btrim(name_ar) <> ''"
    )
    op.create_index(
        "uq_departments_company_name_ar",
        "departments",
        ["company_id", sa.literal_column("lower(name_ar)")],
        unique=True,
        postgresql_where=sa.text("name_ar IS NOT NULL"),
    )
    op.add_column("companies", sa.Column("address_ar", sa.Text(), nullable=True))
    op.add_column("visits", sa.Column("department_name_ar", sa.String(length=120), nullable=True))


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a write still in progress is invisible to the counts, and DROP COLUMN
    # would wait for it and then drop its value.
    op.execute("LOCK TABLE companies, departments, visits IN ACCESS EXCLUSIVE MODE")
    departments = connection.execute(
        sa.text("SELECT count(*) FROM departments WHERE name_ar IS NOT NULL")
    ).scalar_one()
    addresses = connection.execute(
        sa.text("SELECT count(*) FROM companies WHERE address_ar IS NOT NULL")
    ).scalar_one()
    visits = connection.execute(
        sa.text("SELECT count(*) FROM visits WHERE department_name_ar IS NOT NULL")
    ).scalar_one()
    if departments or addresses or visits:
        raise RuntimeError(
            "revision 0012 cannot be downgraded: "
            f"{departments} Arabic department name(s), {addresses} Arabic company address(es) and {visits} "
            "Arabic department name(s) recorded on visits would be lost. Clear the departments and addresses "
            "first (UPDATE departments SET name_ar = NULL; UPDATE companies SET address_ar = NULL; then "
            "UPDATE visits SET department_name_ar = NULL WHERE status NOT IN ('CHECKED_OUT', 'CANCELLED')), "
            "or restore a backup taken before the upgrade: finished visits cannot be changed."
        )
    op.drop_column("visits", "department_name_ar")
    op.drop_column("companies", "address_ar")
    op.drop_index("uq_departments_company_name_ar", table_name="departments")
    op.drop_constraint(op.f("ck_departments_name_ar_not_blank"), "departments", type_="check")
    op.drop_column("departments", "name_ar")
