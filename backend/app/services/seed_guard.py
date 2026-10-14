"""Production never runs on a database that holds the seeds' demo accounts (B11-36).

`seed-demo` and `seed-e2e` create accounts that sign in with a published password (`Demo-Visitor-2026`,
or SEED_DEMO_PASSWORD) which never has to be changed and never expires: one per role in the demo
companies, and the platform owner's `platform@demo.local`, which manages every company. The commands
refuse to run with APP_ENV=production, but that guards only the process that seeds. A database seeded
before it became production's, a demo database restored over it, or a seed run from a workstation whose
DATABASE_URL names the production database all leave those accounts in production.

So the accounts are looked for where they would be used:

* **at start-up** (`require_no_seed_accounts`, called by the application's lifespan in production, after
  the runtime-role check): the API refuses to serve while a seed account exists, with a message that
  names the accounts and what to do;
* **at sign-in** (`is_seed_user`, `is_seed_platform_admin`, used by the two sign-in services in
  production): a seed account that appears while the API runs cannot sign in. It answers like any wrong
  password (401 INVALID_CREDENTIALS, after the one password verification every attempt gets), audited
  `AUTH_LOGIN_FAILED` with `reason = "seed_account"`.

A seed account is recognised by its ID, which the seeds derive from a fixed namespace and the account's
address (`services.seeding.SEED_USER_IDS`, `SEED_PLATFORM_ADMIN_IDS`). That is exact, and it is safe: no
API lets anyone choose an ID (users created through the API, `create-admin` and `create-platform-admin`
get random ones), so no tenant can plant a row that stops the platform from starting. The reserved
addresses (`@demo.local`, `@other.local`) are deliberately not the test: an administrator of any company
can create a user with such an address, and an address says nothing about the password behind it.

The check looks at existence, not activity: a deactivated seed user can be reactivated by an
administrator of its company, which must not be what decides whether production starts next time.
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import ConfigurationError
from app.db.errors import database_error_summary
from app.db.session import session_factory
from app.models import PlatformAdmin, User
from app.repositories.ids import any_of
from app.services.seeding import SEED_PLATFORM_ADMIN_IDS, SEED_USER_IDS


def is_seed_user(user_id: UUID) -> bool:
    return user_id in SEED_USER_IDS


def is_seed_platform_admin(admin_id: UUID) -> bool:
    return admin_id in SEED_PLATFORM_ADMIN_IDS


@dataclass(frozen=True, slots=True)
class SeedAccounts:
    """The seed accounts a database holds, by the addresses the seeds give them (sorted)."""

    platform_admins: tuple[str, ...]
    users: tuple[str, ...]

    def __bool__(self) -> bool:
        return bool(self.platform_admins or self.users)


def find_seed_accounts(db: Session) -> SeedAccounts:
    """The seed accounts in the database, active or not: two indexed lookups by primary key."""
    platform_ids = db.scalars(
        select(PlatformAdmin.id).where(any_of(PlatformAdmin.id, SEED_PLATFORM_ADMIN_IDS))
    )
    user_ids = db.scalars(select(User.id).where(any_of(User.id, SEED_USER_IDS)))
    return SeedAccounts(
        platform_admins=tuple(sorted(SEED_PLATFORM_ADMIN_IDS[found] for found in platform_ids)),
        users=tuple(sorted(SEED_USER_IDS[found] for found in user_ids)),
    )


def require_no_seed_accounts() -> None:
    """Refuse to run production on a database that holds a seed account (see the module).

    The message names the seed accounts by the addresses the seeds give them, which are published in the
    README, and nothing read from the database. A failure to query is reported by the error's class and
    SQLSTATE only, as the runtime-role check does (SEC-36)."""
    try:
        with session_factory() as db:
            found = find_seed_accounts(db)
            db.rollback()
    except Exception as exc:
        summary = database_error_summary(exc) or {"error": type(exc).__name__}
        raise ConfigurationError(
            "could not check the database for demo accounts ("
            + ", ".join(f"{key}={value}" for key, value in summary.items())
            + "): is it migrated to the current revision (alembic upgrade head)?"
        ) from None
    if not found:
        return
    parts = []
    if found.platform_admins:
        parts.append("platform account " + ", ".join(found.platform_admins))
    if found.users:
        parts.append(f"{len(found.users)} company user(s): " + ", ".join(found.users))
    raise ConfigurationError(
        "this database holds demo accounts created by seed-demo or seed-e2e ("
        + "; ".join(parts)
        + "). They sign in with a published password that never has to be changed, so production refuses "
        "to start on a database that holds them. Use a database that was never seeded (alembic upgrade "
        "head, then create-platform-admin and create-admin); if this is the production database and a "
        "seed was run against it by mistake, remove the seed's rows as described in "
        "docs/production-readiness.md (demo accounts in a production database)"
    )
