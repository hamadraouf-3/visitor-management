"""Order visitors by a folded name key.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-05

The cluster's builtin C.UTF-8 collation compares code points, so ordering the visitor list by
`lower(full_name)` put `Élodie` after `Sarah`, and names starting with alef with hamza before names
starting with the bare alef. `name_sort` holds the name folded like `search_text` (case, accents, Arabic
letter variants). The list is ordered by it and then by id, backed by an index per company.

Existing rows are backfilled in batches with the application's own folding
(`app.core.search.name_sort_key`), so they sort exactly like rows the application writes. Reading the
rows means this revision cannot be rendered as SQL (offline mode).
"""

from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import context, op

from app.core.search import name_sort_key

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "ix_visitors_company_id_name_sort_id"
BATCH_SIZE = 1000

_visitors = sa.table(
    "visitors",
    sa.column("id", sa.Uuid()),
    sa.column("full_name", sa.String()),
    sa.column("name_sort", sa.Text()),
)


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError("Revision 0004 computes visitors.name_sort from the stored names; run it online.")
    op.add_column("visitors", sa.Column("name_sort", sa.Text(), nullable=True))
    _backfill(op.get_bind())
    op.alter_column("visitors", "name_sort", nullable=False)
    op.create_index(INDEX, "visitors", ["company_id", "name_sort", "id"])


def _backfill(connection: sa.Connection) -> None:
    """Keyset batches by id, so memory stays bounded however many visitors there are."""
    update = (
        _visitors.update()
        .where(_visitors.c.id == sa.bindparam("visitor_id"))
        .values(name_sort=sa.bindparam("sort_key"))
    )
    last_id: UUID | None = None
    while True:
        batch = sa.select(_visitors.c.id, _visitors.c.full_name).order_by(_visitors.c.id).limit(BATCH_SIZE)
        if last_id is not None:
            batch = batch.where(_visitors.c.id > last_id)
        rows = connection.execute(batch).all()
        if not rows:
            return
        connection.execute(
            update, [{"visitor_id": row.id, "sort_key": name_sort_key(row.full_name)} for row in rows]
        )
        last_id = rows[-1].id


def downgrade() -> None:
    op.drop_index(INDEX, table_name="visitors")
    op.drop_column("visitors", "name_sort")
