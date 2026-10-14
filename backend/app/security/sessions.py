"""Server-side sessions (contract §7.2).

The browser holds an opaque token in an HttpOnly cookie; the database stores only its SHA-256.
A session is valid while not revoked, before its absolute expiry (SESSION_MAX_AGE_HOURS) and while it
has been used within the idle timeout (SESSION_IDLE_MINUTES). `last_seen_at` is written at most once a
minute and never for background refreshes (`X-Background-Refresh: 1`), so polling screens still time
out when nobody touches them.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Role, User, UserSession
from app.repositories.sessions import SessionRepository
from app.security.tokens import generate_token, hash_token, is_well_formed

BACKGROUND_REFRESH_HEADER = "X-Background-Refresh"
USER_AGENT_MAX_LENGTH = 400


@dataclass(frozen=True, slots=True)
class CookieNames:
    session: str
    csrf: str
    device: str  # device trust (`app.security.device_trust`), kept across sign-outs


SECURE_COOKIE_NAMES = CookieNames(
    session="__Host-vms_session", csrf="__Host-vms_csrf", device="__Host-vms_device"
)
INSECURE_COOKIE_NAMES = CookieNames(session="vms_session", csrf="vms_csrf", device="vms_device")


def cookie_names(secure: bool) -> CookieNames:
    """`__Host-` names require the Secure attribute, so plain-http development uses the bare names."""
    return SECURE_COOKIE_NAMES if secure else INSECURE_COOKIE_NAMES


@dataclass(frozen=True, slots=True)
class SessionPolicy:
    max_age: timedelta
    idle_timeout: timedelta
    touch_interval: timedelta = timedelta(minutes=1)

    @classmethod
    def from_settings(cls, settings: Settings) -> SessionPolicy:
        return cls(
            max_age=timedelta(hours=settings.session_max_age_hours),
            idle_timeout=timedelta(minutes=settings.session_idle_minutes),
        )


@dataclass(frozen=True, slots=True)
class AuthContext:
    """The authenticated principal of a request: the live session and its (active) user.

    The identifiers are copied out of the ORM rows when the context is built: error handlers and
    background work read them after the request session has been rolled back and closed.
    """

    user: User
    session: UserSession
    roles: frozenset[Role]
    user_id: UUID
    company_id: UUID
    session_id: UUID

    @classmethod
    def build(cls, user: User, session: UserSession, roles: frozenset[Role]) -> AuthContext:
        return cls(
            user=user,
            session=session,
            roles=roles,
            user_id=user.id,
            company_id=user.company_id,
            session_id=session.id,
        )


@dataclass(frozen=True, slots=True)
class IssuedSession:
    session: UserSession
    token: str  # raw; only ever placed in the Set-Cookie header
    csrf_token: str  # raw; only ever placed in the Set-Cookie header


def truncate_user_agent(user_agent: str | None) -> str | None:
    if not user_agent:
        return None
    return user_agent[:USER_AGENT_MAX_LENGTH]


class SessionManager:
    def __init__(self, db: Session, policy: SessionPolicy) -> None:
        self.repository = SessionRepository(db)
        self.policy = policy

    def create(
        self, user: User, *, now: datetime, ip_address: str | None, user_agent: str | None
    ) -> IssuedSession:
        token = generate_token()
        csrf_token = generate_token()
        session = UserSession(
            user_id=user.id,
            company_id=user.company_id,
            token_hash=hash_token(token),
            csrf_token_hash=hash_token(csrf_token),
            expires_at=now + self.policy.max_age,
            last_seen_at=now,
            ip_address=ip_address,
            user_agent=truncate_user_agent(user_agent),
            created_at=now,
        )
        self.repository.add(session)
        return IssuedSession(session=session, token=token, csrf_token=csrf_token)

    def lookup(self, raw_token: str | None, *, now: datetime) -> tuple[UserSession, User] | None:
        if raw_token is None or not is_well_formed(raw_token):
            return None
        return self.repository.find_live(
            hash_token(raw_token), now=now, idle_cutoff=now - self.policy.idle_timeout
        )

    def touch(self, session: UserSession, *, now: datetime, background: bool) -> bool:
        """Extend the idle window for user activity. Returns True when `last_seen_at` was written."""
        if background or now - session.last_seen_at < self.policy.touch_interval:
            return False
        session.last_seen_at = now  # flushed with the caller's commit
        return True

    def is_live(self, session_id: UUID, *, now: datetime) -> bool:
        """Re-check a session already authenticated by this request (not revoked, not expired) against
        the latest committed state, e.g. after waiting for a lock."""
        return self.repository.is_live(session_id, now=now)

    def revoke(self, session_id: UUID, *, now: datetime) -> None:
        self.repository.revoke(session_id, now=now)

    def revoke_all(self, user_id: UUID, *, now: datetime, except_session_id: UUID | None = None) -> int:
        return self.repository.revoke_all_for_user(user_id, now=now, except_session_id=except_session_id)
