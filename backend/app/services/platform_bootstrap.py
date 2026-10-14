"""Platform owner accounts from the command line (Phase 11, B11-3): `python -m app.cli
create-platform-admin`. There is no self-registration and no API that creates one.

A new account gets a temporary password (typed on stdin, or generated here and printed once by the CLI)
that must be changed at the first sign-in and expires after 72 hours (as an administrator-issued password,
D-11). `--reset` gives an existing account a new temporary password the same way and ends its sessions
and every browser's device trust. Both are written to the platform's audit trail without an actor
(`metadata.source = "cli"`). Allowed in production.

The reset is the account's only recovery (there is no forgot-password, B11-8), so it has to work while
strangers keep the account's sign-in budget spent (B11-35): a **generated** temporary password is stored
with its tag (`security.temporary_passwords`), which gives a sign-in with it a failure budget of its own;
and the new device-trust epoch starts the account's budgets afresh. A password the operator supplies has
no tag. A reset changes the password and nothing else: the command refuses a name with it.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.policy import TEMPORARY_PASSWORD_TTL
from app.core.request_context import SYSTEM_CONTEXT
from app.db.errors import unique_violation_constraint
from app.models import PlatformAdmin
from app.repositories.platform import PlatformAdminRepository, PlatformSessionRepository
from app.security.passwords import PasswordHasherService, password_policy_error
from app.security.temporary_passwords import generate_temporary_password, temporary_password_tag
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.platform_auth import PLATFORM_WORDS, set_platform_password

EMAIL_CONSTRAINT = "uq_platform_admins_email"
DEFAULT_FULL_NAME = "Platform Owner"

__all__ = [
    "DEFAULT_FULL_NAME",
    "PlatformAccount",
    "PlatformBootstrapError",
    "PlatformBootstrapService",
    "generate_temporary_password",
]


class PlatformBootstrapError(Exception):
    """A user-facing reason why the command cannot proceed; nothing was written."""


@dataclass(frozen=True, slots=True)
class PlatformAccount:
    admin_id: UUID
    email: str
    created: bool  # False: an existing account was given a new temporary password (`--reset`)
    # The temporary password when it was generated here: the caller shows it once. None when the operator
    # supplied the password.
    generated_password: str | None


@dataclass(frozen=True, slots=True)
class _TemporaryPassword:
    password_hash: str
    tag: str | None  # of a generated password (B11-35)
    generated: str | None
    expires_at: datetime


class PlatformBootstrapService:
    def __init__(self, db: Session, *, hasher: PasswordHasherService) -> None:
        self.db = db
        self.hasher = hasher
        self.admins = PlatformAdminRepository(db)

    def create(self, *, email: str, full_name: str, password: str | None) -> PlatformAccount:
        """A new account. `email` and `full_name` are already validated by the API's schema types;
        `password` None generates the temporary password."""
        if self.admins.get_by_email(email) is not None:
            raise PlatformBootstrapError(
                "a platform account with this e-mail address already exists; pass --reset to give it a new "
                "temporary password"
            )
        admin_id = uuid.uuid4()
        now = app_time.now()
        temporary = self._temporary_password(password, admin_id, email=email, full_name=full_name, now=now)
        admin = PlatformAdmin(
            id=admin_id,
            email=email,
            full_name=full_name,
            password_hash=temporary.password_hash,
            is_active=True,
            must_change_password=True,
            password_expires_at=temporary.expires_at,
            temporary_password_tag=temporary.tag,
        )
        try:
            with self.db.begin_nested():
                self.admins.add(admin)
        except IntegrityError as exc:
            self.db.rollback()
            if unique_violation_constraint(exc) == EMAIL_CONSTRAINT:
                raise PlatformBootstrapError(
                    "a platform account with this e-mail address already exists"
                ) from None
            raise
        self._audit(AuditAction.PLATFORM_ADMIN_CREATED, admin, {})
        self.db.commit()
        return PlatformAccount(admin.id, admin.email, created=True, generated_password=temporary.generated)

    def reset(self, *, email: str, password: str | None) -> PlatformAccount:
        """A new temporary password for an existing account: its sessions end, and so does every
        browser's device trust (a new epoch, which also starts its failure budgets afresh, B11-35).
        Nothing else about the account changes."""
        existing = self.admins.get_by_email(email)
        if existing is None:
            raise PlatformBootstrapError("no platform account has this e-mail address")
        now = app_time.now()
        # The policy judges the password against the account's own name, not one typed with the command.
        temporary = self._temporary_password(
            password, existing.id, email=existing.email, full_name=existing.full_name, now=now
        )
        admin = self.admins.lock_credentials(existing.id)
        if admin is None:  # pragma: no cover - the account cannot be deleted
            raise PlatformBootstrapError("no platform account has this e-mail address")
        set_platform_password(
            admin,
            temporary.password_hash,
            now=now,
            temporary_until=temporary.expires_at,
            temporary_tag=temporary.tag,
        )
        self.db.flush()
        revoked = PlatformSessionRepository(self.db).revoke_all_for_admin(admin.id, now=now)
        self._audit(AuditAction.PLATFORM_ADMIN_PASSWORD_SET, admin, {"revoked_sessions": revoked})
        self.db.commit()
        return PlatformAccount(admin.id, admin.email, created=False, generated_password=temporary.generated)

    def _temporary_password(
        self, supplied: str | None, admin_id: UUID, *, email: str, full_name: str, now: datetime
    ) -> _TemporaryPassword:
        """The hash of the temporary password, and for a generated one its tag and the password itself."""
        words = (full_name, *PLATFORM_WORDS)
        if supplied is None:
            password = generate_temporary_password()
            while password_policy_error(password, email=email, context=words) is not None:
                password = generate_temporary_password()  # pragma: no cover - random text spells no name
            tag = temporary_password_tag(admin_id, password)
        else:
            problem = password_policy_error(supplied, email=email, context=words)
            if problem is not None:
                raise PlatformBootstrapError(problem.message)
            password, tag = supplied, None
        return _TemporaryPassword(
            password_hash=self.hasher.hash(password),
            tag=tag,
            generated=password if supplied is None else None,
            expires_at=now + TEMPORARY_PASSWORD_TTL,
        )

    def _audit(self, action: AuditAction, admin: PlatformAdmin, metadata: dict[str, object]) -> None:
        audit.record_platform(
            self.db,
            action=action,
            context=SYSTEM_CONTEXT,
            actor_platform_admin_id=None,
            entity_type=AuditEntity.PLATFORM_ADMIN,
            entity_id=admin.id,
            metadata={**metadata, "source": "cli"},
        )
