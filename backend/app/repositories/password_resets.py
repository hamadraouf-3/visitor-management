"""Password-reset tokens (contract §4).

A token is usable while it is neither consumed (`used_at`) nor invalidated (`invalidated_at`) and its
lifetime has not run out (`expires_at > now`). Consumption and invalidation are terminal states that no
later clock reading can undo; only the natural expiry depends on the clock.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import ColumnElement, select, update
from sqlalchemy.orm import Session

from app.models import Company, PasswordResetToken, User


def _usable(token_hash: str, now: datetime) -> tuple[ColumnElement[bool], ...]:
    return (
        PasswordResetToken.token_hash == token_hash,
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.invalidated_at.is_(None),
        PasswordResetToken.expires_at > now,
    )


class PasswordResetRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, token: PasswordResetToken) -> PasswordResetToken:
        self.db.add(token)
        self.db.flush()
        return token

    def find_usable(self, token_hash: str, *, now: datetime) -> tuple[PasswordResetToken, User] | None:
        """Look up a usable token of an active user of an active company (B11-10) without consuming it."""
        statement = (
            select(PasswordResetToken, User)
            .join(User, User.id == PasswordResetToken.user_id)
            .join(Company, Company.id == User.company_id)
            .where(*_usable(token_hash, now), User.is_active.is_(True), Company.is_active.is_(True))
        )
        row = self.db.execute(statement).unique().one_or_none()
        return None if row is None else (row[0], row[1])

    def consume(self, token_hash: str, *, now: datetime) -> UUID | None:
        """Atomically mark the token used; returns its user id, or None if it was not usable."""
        statement = (
            update(PasswordResetToken)
            .where(*_usable(token_hash, now))
            .values(used_at=now)
            .returning(PasswordResetToken.user_id)
            .execution_options(synchronize_session=False)
        )
        return self.db.execute(statement).scalar_one_or_none()

    def invalidate_unused(self, user_id: UUID, *, now: datetime) -> int:
        """Invalidate every unconsumed token of a user (password change/reset, deactivation, new request).

        Already expired tokens are included: whether a token has expired depends on the clock, and a
        clock that steps back must not revive one either.
        """
        statement = (
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == user_id,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.invalidated_at.is_(None),
            )
            .values(invalidated_at=now)
            .returning(PasswordResetToken.id)
            .execution_options(synchronize_session=False)
        )
        return len(self.db.scalars(statement).all())
