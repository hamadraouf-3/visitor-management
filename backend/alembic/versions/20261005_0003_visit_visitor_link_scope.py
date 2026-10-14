"""Record whether a visit's link to its visitor grants visitor read scope.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-05

An EMPLOYEE-only user may invite a visitor by e-mail address. When the company already has a visitor
with that address outside the user's read scope, the visit is linked to it without revealing anything
(contract §7.5). Without a record of how the link was made, "linked to an owned visit" put that visitor
in the user's read scope, so typing a guessed address opened the stored record. `visitor_link_in_scope`
is false for such links, and the scope predicates ignore them.

Existing rows keep the behaviour they had (true).

Downgrade refuses while any link is out of scope (SEC-24): dropping the column and adding it again on the
next upgrade would turn every such link back into scope (the server default is true), silently and for
good giving EMPLOYEE-only users the stored records of visitors they only typed the address of. A
database in that state is rolled back from a backup instead. The table is locked before the count, so a
write in progress cannot slip past it (SEC-39).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "visits",
        sa.Column("visitor_link_in_scope", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )


def downgrade() -> None:
    # Locked before counting (SEC-39): a link written by a transaction still in progress is invisible to
    # the count, and DROP COLUMN would wait for it and then drop its value.
    op.execute("LOCK TABLE visits IN ACCESS EXCLUSIVE MODE")
    out_of_scope = (
        op.get_bind()
        .execute(sa.text("SELECT count(*) FROM visits WHERE NOT visitor_link_in_scope"))
        .scalar_one()
    )
    if out_of_scope:
        raise RuntimeError(
            f"revision 0003 cannot be downgraded: {out_of_scope} visit(s) link a visitor outside their "
            "owners' read scope, and the next upgrade would put those visitors back in scope. Restore a "
            "backup taken before the upgrade instead."
        )
    op.drop_column("visits", "visitor_link_in_scope")
