"""Authorization that still holds after waiting for a lock (SEC-07, contract §7.2 "immediate revocation").

A request is authenticated and authorized once, when it starts (`api.deps.get_session_auth`,
`require_capability`). Every write then serialises on the company row (`lock_company_for_change`): role
and activity changes and company settings take it `FOR UPDATE`; visit and visitor changes, user and
visitor creation and department changes `FOR KEY SHARE`. A deactivation or a demotion holds the same
lock `FOR UPDATE` until it commits, so a request that was authorized before it, and waited behind it,
would otherwise carry on with authority that no longer exists: a deactivated administrator's in-flight
request could reactivate their own account, grant SYSTEM_ADMIN to another account, create a new
SYSTEM_ADMIN account (SEC-31) or change the company settings, after the defender's 200.

`require_still_authorized` re-checks the caller once the company lock is held: the session must still be
live (deactivation revokes every session), the account still active, and the account must still hold
every role the request was authorized with (a removed role may be the one that granted it; added roles
change nothing). Anything else answers 401 NOT_AUTHENTICATED or 403 FORBIDDEN and writes nothing; the
refusal is audited (ACCESS_DENIED). The reads are plain column reads: under READ COMMITTED they see what
committed before the lock was granted, and every change of a user's roles or activity holds the company
lock until it commits (`UsersService.update_user`). Every connection runs READ COMMITTED whatever the
server, database or role default is (`db.session.create_db_engine`, SEC-37): under REPEATABLE READ the
snapshot would predate the wait, and the re-check would read the authority the caller had before.

The platform owner's writes have the same re-check: `require_platform_still_authorized` (B11-38).
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import Forbidden, NotAuthenticated, PasswordChangeRequired, SecurityEvent
from app.models import Company, PlatformAdmin, User
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.platform import PlatformSessionRepository
from app.repositories.sessions import SessionRepository
from app.security.permissions import parse_roles
from app.security.platform_sessions import PlatformAuthContext
from app.security.sessions import AuthContext
from app.services.audit import AuditAction
from app.services.scoping import require_found


def _ended() -> NotAuthenticated:
    return NotAuthenticated(
        security_events=[
            SecurityEvent(action=AuditAction.ACCESS_DENIED, metadata={"reason": "session_ended"})
        ]
    )


def require_still_authorized(db: Session, auth: AuthContext, *, now: datetime) -> None:
    """Call with the company row locked, before writing anything."""
    if not SessionRepository(db).is_live(auth.session_id, now=now):
        raise _ended()
    row = db.execute(
        select(User.is_active, User.roles).where(User.company_id == auth.company_id, User.id == auth.user_id)
    ).one_or_none()
    if row is None or not row.is_active:
        raise _ended()
    if not auth.roles <= parse_roles(row.roles):
        raise Forbidden()


def lock_company_for_change(db: Session, auth: AuthContext, *, lock: RowLock) -> Company:
    """The first step of every write: the caller's company row locked (`lock`, the first lock of the
    order in `repositories.locking`), then the caller re-checked (`require_still_authorized`). Nothing
    may be written before this returns."""
    company = require_found(CompanyRepository(db).get(auth.company_id, lock=lock))
    require_still_authorized(db, auth, now=app_time.now())
    return company


def require_platform_still_authorized(db: Session, auth: PlatformAuthContext, *, now: datetime) -> None:
    """The platform owner's counterpart of `require_still_authorized` (B11-38): call once the company row
    is locked (to create a company: after the slow work, before the first write).

    A platform write waits for that row like any other write, and for the hashing of a temporary
    password; a sign-out in another tab, a password change or the operator's `create-platform-admin
    --reset` can end its session meanwhile. The session must still be live, the account still active and
    not under a forced password change (a reset sets one); otherwise 401 NOT_AUTHENTICATED (audited
    ACCESS_DENIED, `reason = "session_ended"`, in the platform's trail) or 403 PASSWORD_CHANGE_REQUIRED,
    and nothing is written.

    No company lock serialises a platform session's end with the write, as the company row does for a
    user's deactivation, so the session row itself is held `FOR SHARE` until the write commits
    (`PlatformSessionRepository.hold_live`): after this returns, the session cannot be ended before the
    write is committed. The lock comes after the company row and before any user row, and no transaction
    takes it before a company row, so it adds no deadlock to the order of `repositories.locking`."""
    if not PlatformSessionRepository(db).hold_live(auth.session_id, now=now):
        raise _ended()
    row = db.execute(
        select(PlatformAdmin.is_active, PlatformAdmin.must_change_password).where(
            PlatformAdmin.id == auth.platform_admin_id
        )
    ).one_or_none()
    if row is None or not row.is_active:
        raise _ended()
    if row.must_change_password:
        raise PasswordChangeRequired()
