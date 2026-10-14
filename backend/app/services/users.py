"""User administration and the host directory (contract §7.5, §8 /users).

Invariants:
* An administrator cannot remove their own SYSTEM_ADMIN role or change their own activity (409
  SELF_MODIFICATION).
* Once its locks are held, a change or a creation re-checks that the caller is still a live, active
  administrator (`services.authorization`): a deactivation or demotion it waited for stops it (SEC-07,
  SEC-31).
* A company always keeps at least one active SYSTEM_ADMIN (409 LAST_ADMIN). Changes that could break
  this lock the company row first (`SELECT … FOR UPDATE`) so concurrent changes are serialised.
* Deactivation revokes all sessions and unused reset tokens and ends every browser's device trust
  (SEC-30). Deactivation, or losing the last host role, cancels the user's SCHEDULED hosted visits
  through `HostedVisitCanceller` (D-18).
* A full-name change refreshes the `host_name` snapshot of the user's SCHEDULED hosted visits in the
  same transaction through `VisitSnapshotRefresher` (D-17).
* Refusals of these rules (SELF_MODIFICATION, LAST_ADMIN, USER_EMAIL_UNAVAILABLE) are audited as
  USER_CHANGE_REFUSED through the security-event writer: an administrator's attempts to lock the company
  out, or to probe for addresses, stay on record although nothing changed.
"""

from collections.abc import Collection, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.core import time as app_time
from app.core.errors import (
    AppError,
    LastAdmin,
    RateLimited,
    SecurityEvent,
    SelfModification,
    UserEmailUnavailable,
)
from app.core.policy import TEMPORARY_PASSWORD_TTL
from app.core.rate_limit import LimitKey, RateLimiter, RatePolicies
from app.core.request_context import RequestContext
from app.db.errors import unique_violation_constraint
from app.email.service import DeliveryJob
from app.models import Department, Role, User
from app.repositories.companies import CompanyRepository
from app.repositories.departments import DepartmentRepository
from app.repositories.locking import RowLock
from app.repositories.pagination import Page
from app.repositories.password_resets import PasswordResetRepository
from app.repositories.sessions import SessionRepository
from app.repositories.users import UserRepository
from app.schemas.common import ordered_roles
from app.schemas.users import HOSTS_MAX_RESULTS, UserCreate, UserUpdate
from app.security.device_trust import new_device_trust_epoch
from app.security.passwords import PasswordHasherService, password_policy_error
from app.security.permissions import is_host
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change, require_still_authorized
from app.services.departments import assignable_department
from app.services.scoping import FieldErrors, require_found
from app.services.visit_snapshots import VisitSnapshotRefresher

EMAIL_CONSTRAINT = "uq_users_email"


def _refused(error_class: type[AppError], *, operation: str, user_id: UUID | None) -> AppError:
    return error_class(
        security_events=[
            SecurityEvent(
                action=AuditAction.USER_CHANGE_REFUSED,
                entity_type=AuditEntity.USER if user_id is not None else None,
                entity_id=user_id,
                metadata={"code": error_class.code, "operation": operation},
            )
        ]
    )


# ---- D-18 hook ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class HostedVisitCancellation:
    cancelled: int
    delivery_jobs: tuple[DeliveryJob, ...] = field(default=())


class HostedVisitCanceller(Protocol):
    """Cancels a host's SCHEDULED visits in the caller's transaction (reason "Host is no longer
    available", visitors notified, audited) and returns the e-mail jobs to schedule after commit.
    Implemented by `services.visit_hooks.HostedVisitCancellations`, which `create_app` wires."""

    def cancel_hosted_visits(
        self, db: Session, *, host: User, actor: AuthContext, context: RequestContext, now: datetime
    ) -> HostedVisitCancellation: ...


@dataclass(frozen=True, slots=True)
class UserUpdateResult:
    user: User
    cancelled_visits: int | None  # set when hosted visits were cancelled
    delivery_jobs: Sequence[DeliveryJob] = ()


class UsersService:
    def __init__(
        self,
        db: Session,
        *,
        hasher: PasswordHasherService,
        hosted_visits: HostedVisitCanceller,
        snapshots: VisitSnapshotRefresher,
        limiter: RateLimiter,
        policies: RatePolicies,
    ) -> None:
        self.db = db
        self.hasher = hasher
        self.limiter = limiter
        self.policies = policies
        self.hosted_visits = hosted_visits
        self.snapshots = snapshots
        self.users = UserRepository(db)
        self.departments = DepartmentRepository(db)
        self.companies = CompanyRepository(db)

    # ---- reads ----------------------------------------------------------------------------------

    def list_hosts(self, auth: AuthContext, *, q: str | None) -> list[User]:
        return self.users.list_hosts(auth.company_id, q=q, limit=HOSTS_MAX_RESULTS)

    def list_users(
        self,
        auth: AuthContext,
        *,
        q: str | None,
        roles: Collection[Role],
        is_active: bool | None,
        page: int,
        page_size: int,
    ) -> Page[User]:
        return self.users.search(
            auth.company_id, q=q, roles=roles, is_active=is_active, page=page, page_size=page_size
        )

    def get_user(self, auth: AuthContext, user_id: UUID) -> User:
        return require_found(self.users.get_in_company(auth.company_id, user_id))

    # ---- create ---------------------------------------------------------------------------------

    def create_user(self, auth: AuthContext, data: UserCreate, context: RequestContext) -> User:
        errors = FieldErrors()
        department = assignable_department(self.departments, auth.company_id, data.department_id, errors)
        company = auth.user.company
        problem = password_policy_error(
            data.temporary_password,
            email=data.email,
            context=(data.full_name, company.name, company.slug),
        )
        if problem is not None:
            errors.add("temporary_password", problem)
        errors.raise_if_any()
        with self._address_refusals(auth):
            return self._create_user(auth, data, department, context)

    @contextmanager
    def _address_refusals(self, auth: AuthContext) -> Iterator[None]:
        """Addresses are unique across companies (D-03), so a refusal tells the administrator that the
        address has an account somewhere (not where). Refusals for taken addresses are bounded per
        administrator and per company (SEC-05): a slot of each budget is taken before the lookup, kept for
        a USER_EMAIL_UNAVAILABLE and given back for anything else; with none left in either the request
        answers 429 before the lookup, so the 429 says nothing about the address.

        The company budget is the bound on the actor this protects against, a company's administrator
        (SEC-R1): with only a budget per administrator, each administrator account they create (a free
        address costs nothing) would bring ten more confirmations an hour. With the defaults (10 per
        administrator, 20 per company) one administrator alone cannot spend the company budget, and so
        cannot hold back the other administrators' user creations either."""
        per_user = self.policies.user_email_refusals_per_user
        per_company = self.policies.user_email_refusals_per_company
        reservation = self.limiter.reserve(
            (LimitKey(per_user, str(auth.user_id)), LimitKey(per_company, str(auth.company_id)))
        )
        if reservation.denied_by is not None:
            raise RateLimited(retry_after=reservation.retry_after, policy=reservation.denied_by.name)
        refused = False
        try:
            yield
        except UserEmailUnavailable:
            refused = True
            raise
        finally:
            self.limiter.settle(reservation, counted=refused)

    def _create_user(
        self, auth: AuthContext, data: UserCreate, department: Department | None, context: RequestContext
    ) -> User:
        if self.users.get_by_email(data.email) is not None:
            # Also for other companies' addresses: which company, and whether the account is active,
            # stays hidden. That the address is taken cannot (D-03); `_address_refusals` bounds how often
            # an administrator, and a company, can learn it.
            raise _refused(UserEmailUnavailable, operation="create", user_id=None)

        # Hashed before the lock, which is then held only for the insert. The address is checked again
        # by the unique constraint below.
        password_hash = self.hasher.hash(data.temporary_password)
        # A deactivation or demotion of the caller that committed meanwhile, or that this request waits
        # for, stops it (SEC-31): a revoked administrator's in-flight request must not create an account,
        # least of all a SYSTEM_ADMIN that would outlive the revocation.
        lock_company_for_change(self.db, auth, lock=RowLock.KEY_SHARE)
        now = app_time.now()
        user = User(
            company_id=auth.company_id,
            full_name=data.full_name,
            email=data.email,
            phone=data.phone,
            password_hash=password_hash,
            roles=[role.value for role in ordered_roles(data.roles)],
            department_id=department.id if department else None,
            is_active=True,
            must_change_password=True,
            password_expires_at=now + TEMPORARY_PASSWORD_TTL,
        )
        try:
            with self.db.begin_nested():
                self.users.add(user)
        except IntegrityError as exc:
            if unique_violation_constraint(exc) == EMAIL_CONSTRAINT:
                raise _refused(UserEmailUnavailable, operation="create", user_id=None) from None
            raise
        set_committed_value(user, "department", department)
        set_committed_value(user, "company", auth.user.company)
        audit.record(
            self.db,
            action=AuditAction.USER_CREATED,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.USER,
            entity_id=user.id,
            metadata={"roles": user.roles, "department_id": user.department_id},
        )
        self.db.commit()
        return user

    # ---- update ---------------------------------------------------------------------------------

    def update_user(
        self, auth: AuthContext, user_id: UUID, data: UserUpdate, context: RequestContext
    ) -> UserUpdateResult:
        supplied = data.model_fields_set
        # Changes that can affect the "last active administrator" invariant (and, with it, the D-18
        # cancellations below against visit changes: `repositories.locking`) serialise on the company
        # row `FOR UPDATE`. Any other change takes it `FOR KEY SHARE`: it then either waits for a
        # deactivation or demotion of the caller and is re-checked below, or that revocation waits for
        # it (SEC-07, SEC-31).
        roles_or_activity = bool(supplied & {"roles", "is_active"})
        self.companies.get(auth.company_id, lock=RowLock.UPDATE if roles_or_activity else RowLock.KEY_SHARE)
        user = require_found(self.users.get_in_company(auth.company_id, user_id, lock=RowLock.UPDATE))
        # A deactivation or demotion of the caller that this request waited for must stop it (SEC-07).
        require_still_authorized(self.db, auth, now=app_time.now())

        old_roles = user.role_set
        old_active = user.is_active
        new_roles = frozenset(data.roles) if data.roles is not None else old_roles
        new_active = data.is_active if data.is_active is not None else old_active

        # Administrators cannot lock themselves out, and never change their own activity: an active
        # administrator has nothing to reactivate.
        if user.id == auth.user_id and (
            Role.SYSTEM_ADMIN not in new_roles or not new_active or new_active != old_active
        ):
            raise _refused(SelfModification, operation="update", user_id=user.id)
        was_admin = old_active and Role.SYSTEM_ADMIN in old_roles
        stays_admin = new_active and Role.SYSTEM_ADMIN in new_roles
        if (
            was_admin
            and not stays_admin
            and self.users.count_active_admins(auth.company_id, excluding=user.id) == 0
        ):
            raise _refused(LastAdmin, operation="update", user_id=user.id)

        errors = FieldErrors()
        department: Department | None = user.department
        if "department_id" in supplied and data.department_id != user.department_id:
            department = assignable_department(self.departments, auth.company_id, data.department_id, errors)
        errors.raise_if_any()

        changed: list[str] = []
        if data.full_name is not None and data.full_name != user.full_name:
            user.full_name = data.full_name
            changed.append("full_name")
        if "phone" in supplied and data.phone != user.phone:
            user.phone = data.phone
            changed.append("phone")
        if "department_id" in supplied and data.department_id != user.department_id:
            user.department_id = data.department_id
            changed.append("department_id")
        if new_roles != old_roles:
            user.roles = [role.value for role in ordered_roles(new_roles)]
            changed.append("roles")
        if new_active != old_active:
            user.is_active = new_active
            changed.append("is_active")
        if not changed:
            return UserUpdateResult(user=user, cancelled_visits=None)

        now = app_time.now()
        self.db.flush()
        set_committed_value(user, "department", department)
        if "full_name" in changed:
            self.snapshots.host_renamed(self.db, host=user, now=now)
        self._audit_update(auth, user, changed, old_roles, new_roles, context)

        deactivated = old_active and not new_active
        if deactivated:
            revoked = SessionRepository(self.db).revoke_all_for_user(user.id, now=now)
            PasswordResetRepository(self.db).invalidate_unused(user.id, now=now)
            # No browser stays trusted (SEC-30): after a reactivation, every browser that signed in
            # before (a former holder of the password included) is judged by the account's budget.
            user.device_trust_epoch = new_device_trust_epoch()
            self._audit(auth, user, AuditAction.USER_DEACTIVATED, context, {"revoked_sessions": revoked})
        elif new_active and not old_active:
            self._audit(auth, user, AuditAction.USER_REACTIVATED, context, {})

        cancellation: HostedVisitCancellation | None = None
        if deactivated or (is_host(old_roles) and not is_host(new_roles)):
            cancellation = self.hosted_visits.cancel_hosted_visits(
                self.db, host=user, actor=auth, context=context, now=now
            )
        self.db.commit()
        if cancellation is not None and cancellation.cancelled > 0:
            return UserUpdateResult(user, cancellation.cancelled, cancellation.delivery_jobs)
        return UserUpdateResult(user=user, cancelled_visits=None)

    # ---- helpers --------------------------------------------------------------------------------

    def _audit_update(
        self,
        auth: AuthContext,
        user: User,
        changed: list[str],
        old_roles: frozenset[Role],
        new_roles: frozenset[Role],
        context: RequestContext,
    ) -> None:
        self._audit(auth, user, AuditAction.USER_UPDATED, context, {"changed_fields": changed})
        if old_roles != new_roles:
            self._audit(
                auth,
                user,
                AuditAction.USER_ROLES_CHANGED,
                context,
                {
                    "added": ordered_roles(new_roles - old_roles),
                    "removed": ordered_roles(old_roles - new_roles),
                },
            )

    def _audit(
        self,
        auth: AuthContext,
        user: User,
        action: AuditAction,
        context: RequestContext,
        metadata: Mapping[str, object],
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.USER,
            entity_id=user.id,
            metadata=metadata,
        )
