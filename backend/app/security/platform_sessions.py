"""The platform owner's server-side sessions (Phase 11, B11-6).

The same model as a tenant session (`app.security.sessions`): an opaque token in an HttpOnly cookie, only
its SHA-256 stored, an absolute and an idle lifetime, and a CSRF token of its own. The cookies have names
of their own, so a browser can hold a tenant session and a platform session at the same time and neither
ever authenticates a request of the other realm:

* `__Host-vms_platform_session` (HttpOnly; Secure; SameSite=Lax; Path=/)
* `__Host-vms_platform_csrf` (readable by the SPA; Secure; SameSite=Strict; Path=/)
* `__Host-vms_platform_device` (HttpOnly; Secure; SameSite=Strict; Path=/; 90 days), the device cookie
  of SEC-01 for platform accounts

With COOKIE_SECURE=false (plain-http development only) the names drop the `__Host-` prefix. The lifetimes
are PLATFORM_SESSION_MAX_AGE_HOURS (8) and PLATFORM_SESSION_IDLE_MINUTES (30). As for a tenant session,
`last_seen_at` is written at most once a minute and never for a background refresh
(`X-Background-Refresh: 1`), so the idle timeout counts from the person's last own request (B11-34).
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import PlatformAdmin, PlatformSession
from app.repositories.platform import PlatformSessionRepository
from app.security.sessions import CookieNames, SessionPolicy, truncate_user_agent
from app.security.tokens import generate_token, hash_token, is_well_formed

SECURE_PLATFORM_COOKIE_NAMES = CookieNames(
    session="__Host-vms_platform_session",
    csrf="__Host-vms_platform_csrf",
    device="__Host-vms_platform_device",
)
INSECURE_PLATFORM_COOKIE_NAMES = CookieNames(
    session="vms_platform_session", csrf="vms_platform_csrf", device="vms_platform_device"
)


def platform_cookie_names(secure: bool) -> CookieNames:
    return SECURE_PLATFORM_COOKIE_NAMES if secure else INSECURE_PLATFORM_COOKIE_NAMES


@dataclass(frozen=True, slots=True)
class PlatformAuthContext:
    """The authenticated platform administrator of a request, with the identifiers copied out of the ORM
    rows (error handlers read them after the request's session is closed). It has no company and no
    roles: nothing tenant-scoped accepts it."""

    admin: PlatformAdmin
    session: PlatformSession
    platform_admin_id: UUID
    session_id: UUID

    @classmethod
    def build(cls, admin: PlatformAdmin, session: PlatformSession) -> PlatformAuthContext:
        return cls(admin=admin, session=session, platform_admin_id=admin.id, session_id=session.id)


@dataclass(frozen=True, slots=True)
class IssuedPlatformSession:
    session: PlatformSession
    token: str  # raw; only ever placed in the Set-Cookie header
    csrf_token: str  # raw; only ever placed in the Set-Cookie header


def platform_session_policy(settings: Settings) -> SessionPolicy:
    """PLATFORM_SESSION_MAX_AGE_HOURS and PLATFORM_SESSION_IDLE_MINUTES."""
    return SessionPolicy(
        max_age=timedelta(hours=settings.platform_session_max_age_hours),
        idle_timeout=timedelta(minutes=settings.platform_session_idle_minutes),
    )


class PlatformSessionManager:
    def __init__(self, db: Session, policy: SessionPolicy) -> None:
        self.repository = PlatformSessionRepository(db)
        self.policy = policy

    def create(
        self, admin: PlatformAdmin, *, now: datetime, ip_address: str | None, user_agent: str | None
    ) -> IssuedPlatformSession:
        token = generate_token()
        csrf_token = generate_token()
        session = PlatformSession(
            platform_admin_id=admin.id,
            token_hash=hash_token(token),
            csrf_token_hash=hash_token(csrf_token),
            expires_at=now + self.policy.max_age,
            last_seen_at=now,
            ip_address=ip_address,
            user_agent=truncate_user_agent(user_agent),
            created_at=now,
        )
        self.repository.add(session)
        return IssuedPlatformSession(session=session, token=token, csrf_token=csrf_token)

    def lookup(self, raw_token: str | None, *, now: datetime) -> tuple[PlatformSession, PlatformAdmin] | None:
        if raw_token is None or not is_well_formed(raw_token):
            return None
        return self.repository.find_live(
            hash_token(raw_token), now=now, idle_cutoff=now - self.policy.idle_timeout
        )

    def touch(self, session: PlatformSession, *, now: datetime, background: bool) -> bool:
        """Extend the idle window for the person's own activity, as `SessionManager.touch` does: never for
        a background refresh (`X-Background-Refresh: 1`, the platform pages' heartbeat and refetches), so
        a platform tab left open still reaches PLATFORM_SESSION_IDLE_MINUTES (B11-34). Returns True when
        `last_seen_at` was written."""
        if background or now - session.last_seen_at < self.policy.touch_interval:
            return False
        session.last_seen_at = now  # flushed with the caller's commit
        return True

    def is_live(self, session_id: UUID, *, now: datetime) -> bool:
        return self.repository.is_live(session_id, now=now)

    def revoke(self, session_id: UUID, *, now: datetime) -> None:
        self.repository.revoke(session_id, now=now)

    def revoke_all(self, admin_id: UUID, *, now: datetime, except_session_id: UUID | None = None) -> int:
        return self.repository.revoke_all_for_admin(admin_id, now=now, except_session_id=except_session_id)
