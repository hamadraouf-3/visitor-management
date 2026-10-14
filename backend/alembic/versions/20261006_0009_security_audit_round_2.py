"""Security audit round 2: revocable device trust.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-06

* SEC-30: `users.device_trust_epoch`. A device cookie entry (SEC-01) carries the account's epoch and is
  trusted only while it is the current one; the application replaces it with a new random value on
  every password change and reset and on deactivation, which ends the trust of every browser that signed
  in before. Existing rows receive a random value each, so every entry issued before this revision (the
  application ignores the earlier cookie format anyway) is untrusted.

Downgrade drops the column. Nothing is widened by a later upgrade: that upgrade gives every account a new
random epoch again, so no entry issued before the downgrade is trusted afterwards (each browser signs
in once more, untrusted, as after a new SECRET_KEY).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("device_trust_epoch", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
    )
    # A random non-negative 63-bit value per account, like `new_device_trust_epoch`.
    op.execute("UPDATE users SET device_trust_epoch = floor(random()::numeric * 9223372036854775807)::bigint")


def downgrade() -> None:
    op.drop_column("users", "device_trust_epoch")
