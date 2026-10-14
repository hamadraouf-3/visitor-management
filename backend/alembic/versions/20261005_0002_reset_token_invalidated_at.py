"""Terminal invalidation of password-reset tokens.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-05

Invalidation used to set `expires_at = now`. A token is usable while `expires_at > now`, so any later
clock reading earlier than the invalidation instant (an NTP step back, a resumed VM, a second instance
whose clock lags) made a superseded or revoked token usable again. `invalidated_at` records the
invalidation as a state of its own: lookup and consumption require it to be NULL, whatever the clock
says. A token ends in at most one way, so `used_at` and `invalidated_at` are never both set.

Existing rows: a token the old code invalidated has `expires_at` before `created_at` + the 30-minute
lifetime it was issued with (a token that simply runs out keeps exactly that `expires_at`), so those
rows are marked invalidated at their recorded invalidation instant.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "password_reset_tokens"
SINGLE_OUTCOME = "ck_password_reset_tokens_single_outcome"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("invalidated_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        f"UPDATE {TABLE} SET invalidated_at = expires_at "
        "WHERE used_at IS NULL AND expires_at < created_at + interval '30 minutes'"
    )
    op.create_check_constraint(op.f(SINGLE_OUTCOME), TABLE, "used_at IS NULL OR invalidated_at IS NULL")


def downgrade() -> None:
    op.drop_constraint(op.f(SINGLE_OUTCOME), TABLE, type_="check")
    # Back to the previous representation, so invalidated tokens do not become usable again.
    op.execute(
        f"UPDATE {TABLE} SET expires_at = least(expires_at, invalidated_at) WHERE invalidated_at IS NOT NULL"
    )
    op.drop_column(TABLE, "invalidated_at")
