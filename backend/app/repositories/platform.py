"""Data access of the platform owner (Phase 11, B11-1 to B11-12).

The platform's own tables (`platform_admins`, `platform_sessions`, `platform_audit_logs`) and its views of
the companies: the companies themselves, per-company counts, and each company's administrators. Nothing
here reads a company's visitors, visits, departments or audit rows (B11-2): the counts are aggregates.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Text, cast, func, or_, select, update
from sqlalchemy.dialects.postgresql import ARRAY, array
from sqlalchemy.orm import Session

from app.core.text import escape_like
from app.models import (
    Company,
    PasswordResetToken,
    PlatformAdmin,
    PlatformAuditLog,
    PlatformSession,
    Role,
    User,
    Visit,
)
from app.models.user import UserSession
from app.repositories.ids import any_of
from app.repositories.pagination import Page, paginate

# The look-back of a company's visit count (B11-2).
RECENT_VISITS_DAYS = 30
_ADMIN_ROLE = cast(array([Role.SYSTEM_ADMIN.value], type_=Text), ARRAY(Text))


class PlatformAdminRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, admin: PlatformAdmin) -> PlatformAdmin:
        self.db.add(admin)
        self.db.flush()
        return admin

    def get(self, admin_id: UUID) -> PlatformAdmin | None:
        return self.db.get(PlatformAdmin, admin_id)

    def get_by_email(self, email: str) -> PlatformAdmin | None:
        return self.db.scalars(select(PlatformAdmin).where(PlatformAdmin.email == email)).one_or_none()

    def lock_credentials(self, admin_id: UUID) -> PlatformAdmin | None:
        """Re-read the account under a row lock (`FOR NO KEY UPDATE`), refreshing the loaded object: sign-in,
        password changes and the CLI's password reset serialise on it, as a user's do (B1-45)."""
        statement = (
            select(PlatformAdmin)
            .where(PlatformAdmin.id == admin_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
        return self.db.scalars(statement).one_or_none()

    def names(self, admin_ids: Collection[UUID]) -> dict[UUID, str]:
        if not admin_ids:
            return {}
        statement = select(PlatformAdmin.id, PlatformAdmin.full_name).where(
            any_of(PlatformAdmin.id, admin_ids)
        )
        return {row.id: row.full_name for row in self.db.execute(statement)}


class PlatformSessionRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, session: PlatformSession) -> PlatformSession:
        self.db.add(session)
        self.db.flush()
        return session

    def find_live(
        self, token_hash: str, *, now: datetime, idle_cutoff: datetime
    ) -> tuple[PlatformSession, PlatformAdmin] | None:
        """A non-revoked, unexpired, recently used session of an active platform administrator."""
        statement = (
            select(PlatformSession, PlatformAdmin)
            .join(PlatformAdmin, PlatformAdmin.id == PlatformSession.platform_admin_id)
            .where(
                PlatformSession.token_hash == token_hash,
                PlatformSession.revoked_at.is_(None),
                PlatformSession.expires_at > now,
                PlatformSession.last_seen_at > idle_cutoff,
                PlatformAdmin.is_active.is_(True),
            )
        )
        row = self.db.execute(statement).one_or_none()
        return None if row is None else (row[0], row[1])

    def is_live(self, session_id: UUID, *, now: datetime) -> bool:
        statement = select(PlatformSession.id).where(
            PlatformSession.id == session_id,
            PlatformSession.revoked_at.is_(None),
            PlatformSession.expires_at > now,
        )
        return self.db.scalar(statement) is not None

    def hold_live(self, session_id: UUID, *, now: datetime) -> bool:
        """`is_live`, with the session row locked `FOR SHARE` until the caller's transaction ends (B11-38).

        Every way a session ends is an UPDATE of this row (sign-out, a password change, the operator's
        reset), and an UPDATE conflicts with this lock. So a write that calls this either waits for an
        ending in progress and then finds the session revoked (PostgreSQL re-reads the row once the lock
        is granted), or makes the ending wait until the write has committed: no write commits after its
        session was ended. Reads of the row and other writes of the same session (which take the same
        shared lock) do not wait; the one other UPDATE of the row, a request recording the session's
        activity (`touch`), waits for the write's commit, which is brief and holds nothing the write
        needs."""
        statement = (
            select(PlatformSession.id)
            .where(
                PlatformSession.id == session_id,
                PlatformSession.revoked_at.is_(None),
                PlatformSession.expires_at > now,
            )
            .with_for_update(read=True)
        )
        return self.db.scalar(statement) is not None

    def revoke(self, session_id: UUID, *, now: datetime) -> None:
        self.db.execute(
            update(PlatformSession)
            .where(PlatformSession.id == session_id, PlatformSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )

    def revoke_all_for_admin(
        self, admin_id: UUID, *, now: datetime, except_session_id: UUID | None = None
    ) -> int:
        statement = update(PlatformSession).where(
            PlatformSession.platform_admin_id == admin_id,
            PlatformSession.revoked_at.is_(None),
            PlatformSession.expires_at > now,
        )
        if except_session_id is not None:
            statement = statement.where(PlatformSession.id != except_session_id)
        return len(self.db.scalars(statement.values(revoked_at=now).returning(PlatformSession.id)).all())


class PlatformAuditLogRepository:
    """Append-only, like `AuditLogRepository`: the runtime role cannot change or delete rows."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def search(
        self, *, company_id: UUID | None, action: str | None, page: int, page_size: int
    ) -> Page[PlatformAuditLog]:
        """Newest first by `seq`."""
        statement = select(PlatformAuditLog)
        if company_id is not None:
            statement = statement.where(PlatformAuditLog.company_id == company_id)
        if action is not None:
            statement = statement.where(PlatformAuditLog.action == action)
        return paginate(
            self.db,
            statement.order_by(PlatformAuditLog.seq.desc()),
            page=page,
            page_size=page_size,
            serial_count=True,
        )


@dataclass(frozen=True, slots=True)
class CompanyCounts:
    """What the platform owner may know about a company's use (B11-2): aggregates only."""

    active_users: int
    visits_last_30_days: int


class PlatformCompanyRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def search(self, *, q: str | None, is_active: bool | None, page: int, page_size: int) -> Page[Company]:
        statement = select(Company)
        if q:
            pattern = f"%{escape_like(q)}%"
            statement = statement.where(
                or_(
                    Company.name.ilike(pattern, escape="\\"),
                    Company.name_ar.ilike(pattern, escape="\\"),
                    Company.slug.ilike(pattern, escape="\\"),
                )
            )
        if is_active is not None:
            statement = statement.where(Company.is_active.is_(is_active))
        statement = statement.order_by(func.lower(Company.name), Company.id)
        return paginate(self.db, statement, page=page, page_size=page_size)

    def counts(self, company_ids: Collection[UUID], *, now: datetime) -> dict[UUID, CompanyCounts]:
        """Active users, and visits scheduled to start in the 30 days up to `now`, per company (two
        grouped queries, whatever the number of companies)."""
        if not company_ids:
            return {}
        users: dict[UUID, int] = {
            row[0]: row[1]
            for row in self.db.execute(
                select(User.company_id, func.count())
                .where(any_of(User.company_id, company_ids), User.is_active.is_(True))
                .group_by(User.company_id)
            )
        }
        visits: dict[UUID, int] = {
            row[0]: row[1]
            for row in self.db.execute(
                select(Visit.company_id, func.count())
                .where(
                    any_of(Visit.company_id, company_ids),
                    Visit.scheduled_start >= now - timedelta(days=RECENT_VISITS_DAYS),
                    Visit.scheduled_start < now,
                )
                .group_by(Visit.company_id)
            )
        }
        return {
            company_id: CompanyCounts(
                active_users=int(users.get(company_id, 0)), visits_last_30_days=int(visits.get(company_id, 0))
            )
            for company_id in company_ids
        }

    def admins(self, company_id: UUID) -> list[User]:
        """The company's administrators (SYSTEM_ADMIN), active ones first: the only users the platform
        owner sees (B11-2)."""
        statement = (
            select(User)
            .where(User.company_id == company_id, User.roles.contains(_ADMIN_ROLE))
            .order_by(User.is_active.desc(), func.lower(User.full_name), User.id)
        )
        return list(self.db.scalars(statement).unique())

    def admin(self, company_id: UUID, user_id: UUID) -> User | None:
        statement = select(User).where(
            User.company_id == company_id, User.id == user_id, User.roles.contains(_ADMIN_ROLE)
        )
        return self.db.scalars(statement).unique().one_or_none()

    def revoke_sessions(self, company_id: UUID, *, now: datetime) -> int:
        """End every live session of the company's users (deactivation, B11-10)."""
        statement = (
            update(UserSession)
            .where(
                UserSession.company_id == company_id,
                UserSession.revoked_at.is_(None),
                UserSession.expires_at > now,
            )
            .values(revoked_at=now)
            .returning(UserSession.id)
        )
        return len(self.db.scalars(statement).all())

    def invalidate_reset_tokens(self, company_id: UUID, *, now: datetime) -> int:
        """Invalidate every unused password-reset token of the company's users (deactivation, B11-10)."""
        users = select(User.id).where(User.company_id == company_id)
        statement = (
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id.in_(users),
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.invalidated_at.is_(None),
            )
            .values(invalidated_at=now)
            .returning(PasswordResetToken.id)
            .execution_options(synchronize_session=False)
        )
        return len(self.db.scalars(statement).all())
