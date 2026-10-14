"""Trigram indexes for the visit history search.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-06

GET /visits?q= (the company-wide history, reception's search) matches the visit's name snapshots
(visitor, visitor company, host) with ILIKE, or the stored visitor's folded search text and phone digits.
Without indexes on the snapshots, the count and the page each read every visit of the company: measured
on 60,000 visits, a surname carried by three visitors took 166 ms (93 ms of SQL) and a phone number
141 ms, growing linearly with the history. With these indexes the snapshot matches are bitmap index
scans, and the repository turns the stored-visitor match into a list of visitor IDs read through the
visitors' own trigram indexes, so PostgreSQL combines all of them (BitmapOr).

Plain CREATE INDEX (it blocks writes to visits while it builds), with IF NOT EXISTS: a deployment that
already holds a large visits table creates the three indexes CONCURRENTLY first, under the same names,
and this revision then leaves them as they are.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SNAPSHOT_COLUMNS = ("visitor_name", "visitor_company_name", "host_name")


def upgrade() -> None:
    for column in SNAPSHOT_COLUMNS:
        op.create_index(
            f"ix_visits_{column}_trgm",
            "visits",
            [column],
            postgresql_using="gin",
            postgresql_ops={column: "gin_trgm_ops"},
            if_not_exists=True,
        )


def downgrade() -> None:
    for column in reversed(SNAPSHOT_COLUMNS):
        op.drop_index(f"ix_visits_{column}_trgm", table_name="visits")
