from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, select, update
from sqlalchemy.orm import Session

from app.models import Company, User, UserSession


class SessionRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, session: UserSession) -> UserSession:
        self.db.add(session)
        self.db.flush()
        return session

    def find_live(
        self, token_hash: str, *, now: datetime, idle_cutoff: datetime
    ) -> tuple[UserSession, User] | None:
        """A non-revoked, unexpired, recently used session of an active user of an active company
        (a deactivation revokes the sessions too: B11-10)."""
        statement = (
            select(UserSession, User)
            .join(User, and_(User.id == UserSession.user_id, User.company_id == UserSession.company_id))
            .join(Company, Company.id == UserSession.company_id)
            .where(
                UserSession.token_hash == token_hash,
                UserSession.revoked_at.is_(None),
                UserSession.expires_at > now,
                UserSession.last_seen_at > idle_cutoff,
                User.is_active.is_(True),
                Company.is_active.is_(True),
            )
        )
        row = self.db.execute(statement).one_or_none()
        return None if row is None else (row[0], row[1])

    def is_live(self, session_id: UUID, *, now: datetime) -> bool:
        """The session is neither revoked nor past its absolute expiry, as committed right now."""
        statement = select(UserSession.id).where(
            UserSession.id == session_id, UserSession.revoked_at.is_(None), UserSession.expires_at > now
        )
        return self.db.scalar(statement) is not None

    def revoke(self, session_id: UUID, *, now: datetime) -> None:
        self.db.execute(
            update(UserSession)
            .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )

    def revoke_all_for_user(
        self, user_id: UUID, *, now: datetime, except_session_id: UUID | None = None
    ) -> int:
        """Revoke the user's sessions that could still be used. Sessions past their absolute expiry are
        dead already and are left alone: revoking them too made a deactivation's cost (and the time it
        holds the company lock) grow with every session the user ever had (SEC-14)."""
        statement = update(UserSession).where(
            UserSession.user_id == user_id, UserSession.revoked_at.is_(None), UserSession.expires_at > now
        )
        if except_session_id is not None:
            statement = statement.where(UserSession.id != except_session_id)
        revoked = self.db.scalars(statement.values(revoked_at=now).returning(UserSession.id)).all()
        return len(revoked)
