"""Indexes for the current pass of a page of visits and for the audit log's date filter.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-06

* `ix_visitor_passes_company_id_visit_id`: every list of visits (GET /reception/today and /inside, which
  reception tablets poll every 15 seconds, GET /visits, a visitor's history, the dashboards) looks up the
  current pass of each visit on the page (`PassRepository.current_for_visits`: active or most recently
  issued, so no `revoked_at` condition). The only index on `visit_id` was the partial
  `uq_passes_active_visit` (active passes only), so PostgreSQL read every pass ever issued: passes are
  never deleted and every invited visit has one, so the cost grew with the company's whole history, not
  with the page (on 60,000 passes, a sequential scan of 20-25 ms for each list). The composite foreign
  key `(company_id, visit_id) -> visits` uses the same columns.
* `ix_audit_logs_company_id_created_at`: GET /audit-logs with `date_from` / `date_to` filters on
  `created_at`; the count of a page and the page itself read every audit row of the company (append-only,
  never deleted) without it. The count becomes an index-only scan of the range.

Plain CREATE INDEX (it blocks writes to the table while it builds), with IF NOT EXISTS: a deployment
that already holds large tables creates them CONCURRENTLY first, under the same names and columns, and
this revision then leaves them as they are:

    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_visitor_passes_company_id_visit_id
        ON visitor_passes (company_id, visit_id);
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_audit_logs_company_id_created_at
        ON audit_logs (company_id, created_at);
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_visitor_passes_company_id_visit_id",
        "visitor_passes",
        ["company_id", "visit_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_audit_logs_company_id_created_at",
        "audit_logs",
        ["company_id", "created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("ix_audit_logs_company_id_created_at", table_name="audit_logs")
    op.drop_index("ix_visitor_passes_company_id_visit_id", table_name="visitor_passes")
