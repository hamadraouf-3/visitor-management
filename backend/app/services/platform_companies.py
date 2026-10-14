"""The platform owner's management of companies (Phase 11, B11-2, B11-5, B11-9 to B11-13).

What the platform owner can do: list and read companies with two counts (active users, visits scheduled
in the last 30 days), create a company with its first administrator, change its identity (names, time
zone, default language; never the slug), deactivate and reactivate it, list its administrators, add an
administrator and send an administrator a password-reset link. Nothing else about a company: no visitor,
visit, department, non-administrator user or audit row is read here (privacy by default, B11-2).

Every action is audited twice (B11-5): in the platform's trail (`platform_audit_logs`, actor = the
platform administrator, `company_id` = the company) and, when it changes the company, in the company's own
trail (`audit_logs`), without an actor (no user of the company did it) and with
`metadata.source = "platform"` and `metadata.platform_admin_id`, so the company's administrators see what
was done to their company and the seeds treat it as a person's change (B10-15). The company's row carries
the request ID but not the platform owner's network address or browser (B11-37).

Every write re-checks the caller once the company row is locked, and a creation after it hashed the
temporary password (`require_platform_still_authorized`, B11-38): a request that waited while its session
was ended (a sign-out in another tab, the operator's reset) answers 401 and writes nothing.

The platform owner can reach into a company by adding itself an administrator, or by sending a reset link
to a mailbox it controls. The audit rows record that; so that somebody also reads it, the company's
**other** active administrators get a short security notice by e-mail when an administrator is added to an
existing company or one is sent a reset link (`_notify_other_admins`, B11-43). Not at a company's
creation: there is nobody else yet.

"This address cannot be used" (409 USER_EMAIL_UNAVAILABLE) tells the platform owner that an address has an
account in some company (addresses are unique across companies, D-03). Such refusals are audited in the
platform's trail (USER_CHANGE_REFUSED) and bounded per platform account (`_address_refusals`, B11-42), as
an administrator's are (SEC-05).

Deactivation (B11-10) locks the company row `FOR UPDATE`, sets `is_active = false`, revokes every live
session of its users and invalidates their unused reset links in the same transaction. From then on its
users' sign-ins, reset links and sessions are refused (`services.auth`, `repositories.sessions`), and its
passes are answered like unknown passes (`repositories.passes`). Reactivation restores sign-in only:
revoked sessions stay revoked.
"""

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.core import time as app_time
from app.core.config import Settings
from app.core.errors import (
    AccountInactive,
    CompanyInactive,
    Conflict,
    RateLimited,
    SecurityEvent,
    UserEmailUnavailable,
)
from app.core.policy import TEMPORARY_PASSWORD_TTL
from app.core.rate_limit import LimitKey, RateLimiter, RatePolicies, limiter_key
from app.core.request_context import RequestContext
from app.db.errors import unique_violation_constraint
from app.email.service import PASSWORD_RESET_TTL, DeliveryJob, EmailService, PlatformAction
from app.models import Company, PasswordResetToken, Role, User
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.pagination import Page
from app.repositories.password_resets import PasswordResetRepository
from app.repositories.platform import (
    PlatformAdminRepository,
    PlatformAuditLogRepository,
    PlatformCompanyRepository,
)
from app.repositories.users import UserRepository
from app.schemas.platform import (
    CompanyAdminCreate,
    CompanyCounts,
    CompanyRef,
    PlatformActorRef,
    PlatformAuditLog,
    PlatformAuditLogQuery,
    PlatformCompany,
    PlatformCompanyCreate,
    PlatformCompanyListQuery,
    PlatformCompanyUpdate,
)
from app.security.passwords import PasswordHasherService, password_policy_error
from app.security.platform_sessions import PlatformAuthContext
from app.security.tokens import generate_token, hash_token
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import require_platform_still_authorized
from app.services.brand import BrandReader
from app.services.company import UNKNOWN_TIMEZONE, CompanyService
from app.services.scoping import FieldErrors, require_found
from app.services.users import EMAIL_CONSTRAINT

SLUG_CONSTRAINT = "uq_companies_slug"
SLUG_TAKEN = "A company with this slug already exists."
_IDENTITY = ("name", "name_ar", "timezone", "default_language")


class PlatformCompaniesService:
    def __init__(
        self,
        db: Session,
        *,
        settings: Settings,
        hasher: PasswordHasherService,
        limiter: RateLimiter,
        policies: RatePolicies,
        emails: EmailService,
        brands: BrandReader,
    ) -> None:
        self.db = db
        self.settings = settings
        self.hasher = hasher
        self.limiter = limiter
        self.policies = policies
        self.emails = emails
        self.brands = brands
        self.companies = CompanyRepository(db)
        self.platform = PlatformCompanyRepository(db)
        self.users = UserRepository(db)

    # ---- reads ----------------------------------------------------------------------------------

    def list_companies(self, query: PlatformCompanyListQuery) -> Page[PlatformCompany]:
        page = self.platform.search(
            q=query.q, is_active=query.is_active, page=query.page, page_size=query.page_size
        )
        return Page(items=self._views(page.items), page=page.page, page_size=page.page_size, total=page.total)

    def get_company(self, company_id: UUID) -> PlatformCompany:
        return self._views([require_found(self.companies.get(company_id))])[0]

    def list_admins(self, company_id: UUID) -> list[User]:
        require_found(self.companies.get(company_id))
        return self.platform.admins(company_id)

    def _views(self, companies: Sequence[Company]) -> list[PlatformCompany]:
        counts = self.platform.counts([company.id for company in companies], now=app_time.now())
        brands = self.brands.of_many(companies)  # one query for the page (B12-7)
        return [
            PlatformCompany.build(
                company,
                CompanyCounts(
                    active_users=counts[company.id].active_users,
                    visits_last_30_days=counts[company.id].visits_last_30_days,
                ),
                brands[company.id],
            )
            for company in companies
        ]

    # ---- create ---------------------------------------------------------------------------------

    def create_company(
        self, auth: PlatformAuthContext, data: PlatformCompanyCreate, context: RequestContext
    ) -> tuple[PlatformCompany, User]:
        errors = FieldErrors()
        if not CompanyService(self.db).is_valid_timezone(data.timezone):
            errors.add("timezone", UNKNOWN_TIMEZONE)
        problem = password_policy_error(
            data.admin.temporary_password,
            email=data.admin.email,
            context=(data.admin.full_name, data.name, data.name_ar or "", data.slug),
        )
        if problem is not None:
            errors.add("admin.temporary_password", problem)
        errors.raise_if_any()
        with self._address_refusals(auth):
            return self._create_company(auth, data, context)

    def _create_company(
        self, auth: PlatformAuthContext, data: PlatformCompanyCreate, context: RequestContext
    ) -> tuple[PlatformCompany, User]:
        if self.companies.get_by_slug(data.slug) is not None:
            raise Conflict("slug", SLUG_TAKEN)
        if self.users.get_by_email(data.admin.email) is not None:
            raise self._address_taken(None)
        password_hash = self.hasher.hash(data.admin.temporary_password)
        now = app_time.now()
        # There is no company row to wait for yet; the hashing above is where this request spends its
        # time. A session that ended meanwhile creates nothing (B11-38).
        require_platform_still_authorized(self.db, auth, now=now)
        company = Company(
            slug=data.slug,
            name=data.name,
            name_ar=data.name_ar,
            timezone=data.timezone,
            default_language=data.default_language.value,
        )
        try:
            with self.db.begin_nested():
                self.companies.add(company)
        except IntegrityError as exc:
            if unique_violation_constraint(exc) == SLUG_CONSTRAINT:
                raise Conflict("slug", SLUG_TAKEN) from None
            raise
        self._audit(auth, AuditAction.COMPANY_CREATED, company.id, AuditEntity.COMPANY, company.id, context)
        # The first administrator of a new company: there is nobody to tell (B11-43).
        admin, _notices = self._add_admin(auth, company, data.admin, password_hash, context, now=now)
        self.db.commit()
        return self._views([company])[0], admin

    def create_admin(
        self, auth: PlatformAuthContext, company_id: UUID, data: CompanyAdminCreate, context: RequestContext
    ) -> tuple[User, list[DeliveryJob]]:
        """A new administrator of an existing company, and the notices to its other administrators, to
        deliver after this returns (the transaction is committed)."""
        company = require_found(self.companies.get(company_id))
        problem = password_policy_error(
            data.temporary_password,
            email=data.email,
            context=(data.full_name, company.name, company.name_ar or "", company.slug),
        )
        if problem is not None:
            errors = FieldErrors()
            errors.add("temporary_password", problem)
            errors.raise_if_any()
        with self._address_refusals(auth):
            if self.users.get_by_email(data.email) is not None:
                raise self._address_taken(company.id)
            # Hashed before the lock, which is then held only for the insert (as POST /users does).
            password_hash = self.hasher.hash(data.temporary_password)
            # `FOR KEY SHARE`, as every user creation: the company cannot be deleted or deactivated
            # meanwhile. Then the caller again: a session that ended while this request hashed, or
            # waited for the row, adds no administrator (B11-38).
            company = self._lock_company(auth, company_id, RowLock.KEY_SHARE)
            user, notices = self._add_admin(
                auth, company, data, password_hash, context, now=app_time.now(), notify=True
            )
            self.db.commit()
            return user, notices

    @contextmanager
    def _address_refusals(self, auth: PlatformAuthContext) -> Iterator[None]:
        """The budget of "this address cannot be used" answers (B11-42), as `UsersService._address_refusals`
        for an administrator (SEC-05): a slot is taken before the address is looked up, kept for a
        USER_EMAIL_UNAVAILABLE and given back for anything else. With none left the request answers 429
        before the lookup, for a free address as well, so the 429 says nothing about any address. One
        budget per platform account for both creations (the policy and the numbers of
        `user_email_refusals_per_user`, under a key of its own)."""
        policy = self.policies.user_email_refusals_per_user
        reservation = self.limiter.reserve((LimitKey(policy, f"platform:{auth.platform_admin_id}"),))
        if reservation.denied_by is not None:
            raise RateLimited(retry_after=reservation.retry_after, policy=policy.name)
        refused = False
        try:
            yield
        except UserEmailUnavailable:
            refused = True
            raise
        finally:
            self.limiter.settle(reservation, counted=refused)

    @staticmethod
    def _address_taken(company_id: UUID | None) -> UserEmailUnavailable:
        """409 USER_EMAIL_UNAVAILABLE, on record in the platform's trail (B11-42): USER_CHANGE_REFUSED with
        the company the administrator was meant for (none for a new company). Never the address, and
        never which account or company holds it."""
        return UserEmailUnavailable(
            security_events=[
                SecurityEvent(
                    action=AuditAction.USER_CHANGE_REFUSED,
                    company_id=company_id,
                    metadata={"code": UserEmailUnavailable.code, "operation": "create"},
                    platform=True,
                )
            ]
        )

    def _lock_company(self, auth: PlatformAuthContext, company_id: UUID, lock: RowLock) -> Company:
        """The first step of a write on an existing company: its row locked, then the caller re-checked
        (B11-38). Nothing may be written before this returns. An ended session answers 401 whether or
        not the company exists."""
        company = self.companies.get(company_id, lock=lock)
        require_platform_still_authorized(self.db, auth, now=app_time.now())
        return require_found(company)

    def _add_admin(
        self,
        auth: PlatformAuthContext,
        company: Company,
        data: CompanyAdminCreate,
        password_hash: str,
        context: RequestContext,
        *,
        now: datetime,
        notify: bool = False,
    ) -> tuple[User, list[DeliveryJob]]:
        """The administrator's row and its audit rows. With `notify`, the company's other administrators
        are told (B11-43), and both audit rows say how many (`notified_admins`)."""
        user = User(
            company_id=company.id,
            full_name=data.full_name,
            email=data.email,
            password_hash=password_hash,
            roles=[Role.SYSTEM_ADMIN.value],
            is_active=True,
            must_change_password=True,
            password_expires_at=now + TEMPORARY_PASSWORD_TTL,
        )
        try:
            with self.db.begin_nested():
                self.users.add(user)
        except IntegrityError as exc:
            if unique_violation_constraint(exc) == EMAIL_CONSTRAINT:
                raise self._address_taken(company.id) from None
            raise
        set_committed_value(user, "company", company)
        set_committed_value(user, "department", None)
        notices: list[DeliveryJob] = []
        details: dict[str, object] = {"roles": user.roles}
        if notify:
            notices = self._notify_other_admins(company, about=user, action="admin_added", now=now)
            details["notified_admins"] = len(notices)
        self._audit(auth, AuditAction.USER_CREATED, company.id, AuditEntity.USER, user.id, context, details)
        return user, notices

    def _notify_other_admins(
        self, company: Company, *, about: User, action: PlatformAction, now: datetime
    ) -> list[DeliveryJob]:
        """A security notice to every other active administrator of the company (B11-43): the platform
        owner added the administrator `about`, or sent `about` a reset link. Queued in the caller's
        transaction; the caller delivers the jobs after its commit.

        Each recipient gets at most five such notices an hour (the numbers of the "password changed"
        notices, SEC-06, under a key of its own): beyond that the action is still done and audited, and
        only that e-mail is left out, so a platform account, or whoever took one over, cannot flood an
        administrator's mailbox either. The first notices are the ones that tell."""
        policy = self.policies.password_notices_per_user
        jobs: list[DeliveryJob] = []
        for admin in self.platform.admins(company.id):
            if not admin.is_active or admin.id == about.id:
                continue
            if not self.limiter.hit(policy, f"platform-notice:{admin.id}").allowed:
                continue
            jobs.append(self.emails.queue_platform_notice(admin, action=action, about=about, when=now))
        return jobs

    # ---- identity and activity ------------------------------------------------------------------

    def update_company(
        self,
        auth: PlatformAuthContext,
        company_id: UUID,
        data: PlatformCompanyUpdate,
        context: RequestContext,
    ) -> PlatformCompany:
        company = self._lock_company(auth, company_id, RowLock.UPDATE)
        supplied = data.model_fields_set
        if (
            "timezone" in supplied
            and data.timezone != company.timezone
            and not CompanyService(self.db).is_valid_timezone(data.timezone or "")
        ):
            errors = FieldErrors()
            errors.add("timezone", UNKNOWN_TIMEZONE)
            errors.raise_if_any()
        changed: list[str] = []
        for name in _IDENTITY:
            if name not in supplied:
                continue
            value: Any = getattr(data, name)
            if name == "default_language" and value is not None:
                value = value.value
            if value != getattr(company, name):
                setattr(company, name, value)
                changed.append(name)
        if changed:
            self._audit(
                auth,
                AuditAction.COMPANY_SETTINGS_UPDATED,
                company.id,
                AuditEntity.COMPANY,
                company.id,
                context,
                {"changed_fields": changed},
            )
            self.db.commit()
        return self._views([company])[0]

    def set_active(
        self, auth: PlatformAuthContext, company_id: UUID, active: bool, context: RequestContext
    ) -> PlatformCompany:
        """Deactivate or reactivate (B11-10); doing it again changes and audits nothing."""
        company = self._lock_company(auth, company_id, RowLock.UPDATE)
        if company.is_active == active:
            return self._views([company])[0]
        now = app_time.now()
        metadata: dict[str, object] = {}
        if active:
            company.is_active = True
            company.deactivated_at = None
            action = AuditAction.COMPANY_REACTIVATED
        else:
            company.is_active = False
            company.deactivated_at = now
            self.db.flush()  # the company row first, then its users' sessions and links
            metadata["revoked_sessions"] = self.platform.revoke_sessions(company.id, now=now)
            metadata["invalidated_reset_links"] = self.platform.invalidate_reset_tokens(company.id, now=now)
            action = AuditAction.COMPANY_DEACTIVATED
        self._audit(auth, action, company.id, AuditEntity.COMPANY, company.id, context, metadata)
        self.db.commit()
        return self._views([company])[0]

    # ---- an administrator's reset link ----------------------------------------------------------

    def send_admin_reset(
        self, auth: PlatformAuthContext, company_id: UUID, user_id: UUID, context: RequestContext
    ) -> tuple[User, list[DeliveryJob]]:
        """A password-reset link to one of the company's administrators (the product's own reset e-mail,
        30 minutes, single use; B11-11), worded as sent by the platform owner (B11-49). Within the
        account's budget of reset e-mails, shared with forgot-password: 429 RATE_LIMITED beyond it.
        Returns the administrator and the e-mails to deliver after the commit: the reset link first,
        then the notices to the company's other administrators (B11-43)."""
        company = self._lock_company(auth, company_id, RowLock.KEY_SHARE)
        found = require_found(self.platform.admin(company_id, user_id))
        if not company.is_active:
            raise CompanyInactive()
        if not found.is_active:
            raise AccountInactive()
        policy = self.policies.forgot_password_account
        key = limiter_key(self.settings.secret_key.get_secret_value(), "forgot-account", found.id)
        decision = self.limiter.hit(policy, key)
        if not decision.allowed:
            raise RateLimited(retry_after=decision.retry_after, policy=policy.name)
        user = require_found(self.users.lock_credentials(company_id, user_id))
        now = app_time.now()
        resets = PasswordResetRepository(self.db)
        resets.invalidate_unused(user.id, now=now)
        raw_token = generate_token()
        resets.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=hash_token(raw_token),
                expires_at=now + PASSWORD_RESET_TTL,
                requested_ip=context.ip_address,
                created_at=now,
            )
        )
        job = self.emails.queue_password_reset(user, raw_token, sent_by_platform_owner=True)
        notices = self._notify_other_admins(company, about=user, action="reset_sent", now=now)
        self._audit(
            auth,
            AuditAction.AUTH_PASSWORD_RESET_REQUESTED,
            company_id,
            AuditEntity.USER,
            user.id,
            context,
            {"email_message_id": job.message_id, "notified_admins": len(notices)},
        )
        self.db.commit()
        return user, [job, *notices]

    # ---- the platform's trail -------------------------------------------------------------------

    def audit_logs(self, query: PlatformAuditLogQuery) -> Page[PlatformAuditLog]:
        page = PlatformAuditLogRepository(self.db).search(
            company_id=query.company_id, action=query.action, page=query.page, page_size=query.page_size
        )
        actors = PlatformAdminRepository(self.db).names(
            {row.actor_platform_admin_id for row in page.items if row.actor_platform_admin_id is not None}
        )
        companies = {
            company.id: company
            for company in (
                self.companies.get(company_id)
                for company_id in {row.company_id for row in page.items if row.company_id is not None}
            )
            if company is not None
        }
        items = []
        for row in page.items:
            actor = None
            if row.actor_platform_admin_id is not None:
                actor = PlatformActorRef(
                    id=row.actor_platform_admin_id, full_name=actors.get(row.actor_platform_admin_id, "")
                )
            company = companies.get(row.company_id) if row.company_id is not None else None
            reference = (
                CompanyRef(id=company.id, name=company.name, name_ar=company.name_ar) if company else None
            )
            items.append(PlatformAuditLog.from_row(row, actor=actor, company=reference))
        return Page(items=items, page=page.page, page_size=page.page_size, total=page.total)

    def _audit(
        self,
        auth: PlatformAuthContext,
        action: AuditAction,
        company_id: UUID,
        entity_type: AuditEntity,
        entity_id: UUID,
        context: RequestContext,
        details: Mapping[str, object] | None = None,
    ) -> None:
        """Both rows of an action that changed a company (`audit.record_platform_change`, B11-5): the
        company's without the platform owner's network details (B11-37), the platform's with them."""
        audit.record_platform_change(
            self.db,
            action=action,
            context=context,
            platform_admin_id=auth.platform_admin_id,
            company_id=company_id,
            entity_type=entity_type,
            entity_id=entity_id,
            metadata=details,
        )
