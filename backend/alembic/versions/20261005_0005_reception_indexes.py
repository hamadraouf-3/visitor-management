"""Indexes for the reception lists that are polled every 15 seconds.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-05

GET /reception/today reads the visits checked out today and the SCHEDULED visits in start order. Without
these indexes both walked every visit of the company: measured on 60,000 visits, the checked-out list
took 18 ms (sequential scan) and the expected list 58 ms (the start-order index scanned through every
past visit before it reached the scheduled ones); the counts took about 180 ms. Both costs grow with the
company's history, and reception tablets poll the screen. With them the lists take under 1 ms and the
counts (which now pre-filter on indexable conditions) about 19 ms, bounded by the open visits.

* `ix_visits_company_id_check_out_at`: visits checked out in a period, latest first.
* `ix_visits_company_id_scheduled_start_id_scheduled` (partial, SCHEDULED only): the expected list.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_visits_company_id_check_out_at", "visits", ["company_id", "check_out_at"])
    op.create_index(
        "ix_visits_company_id_scheduled_start_id_scheduled",
        "visits",
        ["company_id", "scheduled_start", "id"],
        postgresql_where=sa.text("status = 'SCHEDULED'"),
    )


def downgrade() -> None:
    op.drop_index("ix_visits_company_id_scheduled_start_id_scheduled", table_name="visits")
    op.drop_index("ix_visits_company_id_check_out_at", table_name="visits")
