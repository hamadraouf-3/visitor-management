"""CSRF protection primitives (contract §7.2).

Each session has its own random CSRF token, delivered in a readable cookie and echoed by the SPA in
`X-CSRF-Token`; only its hash is stored with the session. The global middleware
(`app.core.middleware.CsrfOriginMiddleware`) enforces it for every unsafe API request carrying a live
session, except the explicit exemption list below.
"""

from collections.abc import Callable

from app.core import time as app_time
from app.core.config import API_PREFIX
from app.core.middleware import CsrfSessionInfo
from app.core.routing import PLATFORM_PREFIX
from app.db.session import session_factory
from app.security.platform_sessions import PlatformSessionManager
from app.security.sessions import SessionManager, SessionPolicy
from app.security.tokens import token_matches

CSRF_HEADER = "X-CSRF-Token"

# Only these may be called with a stale/foreign session cookie and no CSRF header: they establish or
# recover a session. Origin and Sec-Fetch-Site checks still apply to them.
CSRF_EXEMPT: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", f"{API_PREFIX}/auth/login"),
        ("POST", f"{API_PREFIX}/auth/forgot-password"),
        ("POST", f"{API_PREFIX}/auth/reset-password"),
    }
)
# The platform owner's realm (B11-6): its sign-in is the only exemption.
PLATFORM_CSRF_EXEMPT: frozenset[tuple[str, str]] = frozenset({("POST", f"{PLATFORM_PREFIX}/auth/login")})


def csrf_matches(stored_hash: str, presented: str | None) -> bool:
    return token_matches(stored_hash, presented)


def make_session_lookup(policy: SessionPolicy) -> Callable[[str], CsrfSessionInfo | None]:
    """Resolve a raw session cookie to what the CSRF check needs, using its own short session."""

    def lookup(raw_session_token: str) -> CsrfSessionInfo | None:
        with session_factory() as db:
            found = SessionManager(db, policy).lookup(raw_session_token, now=app_time.now())
            if found is None:
                return None
            session, _user = found
            return CsrfSessionInfo(
                session_id=session.id,
                user_id=session.user_id,
                company_id=session.company_id,
                csrf_token_hash=session.csrf_token_hash,
            )

    return lookup


def make_platform_session_lookup(policy: SessionPolicy) -> Callable[[str], CsrfSessionInfo | None]:
    """Resolve a raw platform session cookie to what the CSRF check needs (B11-6)."""

    def lookup(raw_session_token: str) -> CsrfSessionInfo | None:
        with session_factory() as db:
            found = PlatformSessionManager(db, policy).lookup(raw_session_token, now=app_time.now())
            if found is None:
                return None
            session, admin = found
            return CsrfSessionInfo(
                session_id=session.id,
                user_id=admin.id,
                company_id=None,
                csrf_token_hash=session.csrf_token_hash,
                platform=True,
            )

    return lookup
