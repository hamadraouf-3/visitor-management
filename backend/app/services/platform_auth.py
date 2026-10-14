"""Sign-in, sign-out, password change and preferences of the platform owner (Phase 11, B11-6, B11-7).

The same bar as a tenant's sign-in (`services.auth`, contract §7.1-§7.3):

* the e-mail is normalised, and every failure budget is reserved before any hashing: the client's
  (per address and typed e-mail, per address, per IPv6 /48), then the account's (or, for a browser that
  holds the platform device cookie for the account, that device's: SEC-01; or, for a sign-in with the
  temporary password the CLI generated, that password's: B11-35), then the account's budget of
  successful sign-ins (SEC-02). The per-address and per-prefix budgets are shared with the tenant sign-in
  (one client, one budget); the others have keys of their own;
* exactly one Argon2 verification on every path (the account's hash or the dummy), then the account
  checks (active, temporary password not expired); every failure is the same 401 INVALID_CREDENTIALS;
* the account row is locked and its hash re-checked before the session is created, so a password change
  that committed meanwhile defeats the sign-in;
* a password change verifies the current password within its own failure budget and a budget of
  successful changes (SEC-43), revokes every session, the caller's included, and issues a new one
  (SEC-04), and ends every other browser's device trust (SEC-30);
* every success, failure and refusal is in the platform's audit trail (B11-4).

What differs: there is no forgot-password for a platform account (an operator resets it with
`python -m app.cli create-platform-admin --reset`), and no "your password was changed" e-mail (the
e-mail outbox belongs to companies; B11-8).

Because that reset is the only recovery, it must work while strangers keep the account locked (B11-35):

* the account's failure budget, and the budget of wrong current passwords at a password change, are keyed
  by the account **and its device-trust epoch**. A reset (and every password change) starts a new epoch,
  so what was counted against the old password is not held against the new one. The budgets live in this
  process and the reset runs in another, which is why the key, not a call, has to carry this;
* a sign-in with the temporary password that the command generated is judged by that password's own
  budget (`security.temporary_passwords`), as a trusted browser is by its own;
* the change that completes a reset is outside the hourly budget of successful changes (SEC-43): it can
  happen once per reset, and a spent budget must not leave the owner stuck behind PASSWORD_CHANGE_REQUIRED.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import NoReturn

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.client_ip import rate_limit_prefix, rate_limit_subject
from app.core.config import Settings
from app.core.errors import (
    InvalidCredentials,
    InvalidCurrentPassword,
    NotAuthenticated,
    RateLimited,
    SecurityEvent,
    ValidationFailed,
)
from app.core.rate_limit import LimitKey, RateLimiter, RatePolicies, RatePolicy, Reservation, limiter_key
from app.core.request_context import RequestContext
from app.core.text import normalise_email
from app.models import Language, PlatformAdmin
from app.repositories.platform import PlatformAdminRepository
from app.security.device_trust import DeviceTrust, new_device_trust_epoch
from app.security.passwords import PasswordHasherService, normalise_password, password_policy_error
from app.security.platform_sessions import IssuedPlatformSession, PlatformAuthContext, PlatformSessionManager
from app.security.sessions import SessionPolicy
from app.security.temporary_passwords import holds_temporary_password
from app.services import audit
from app.services.audit import AuditAction, AuditEntity, SecurityAudit
from app.services.auth import ACCOUNT_THROTTLED_MESSAGE, PASSWORD_UNCHANGED
from app.services.seed_guard import is_seed_platform_admin

# Words a platform password must not be built from, besides the account's name and address.
PLATFORM_WORDS = ("platform", "admin")


def account_words(admin: PlatformAdmin) -> tuple[str, ...]:
    return (admin.full_name, *PLATFORM_WORDS)


@dataclass(frozen=True, slots=True)
class PlatformLogin:
    admin: PlatformAdmin
    issued: IssuedPlatformSession
    device_cookie: str


@dataclass(frozen=True, slots=True)
class PlatformPasswordChanged:
    session: IssuedPlatformSession
    device_cookie: str


@dataclass(frozen=True, slots=True)
class _Attempt:
    failures: Reservation
    success: Reservation
    admin: PlatformAdmin | None
    device_key: str | None

    def give_back(self, limiter: RateLimiter) -> None:
        limiter.settle(self.failures, counted=False)
        limiter.settle(self.success, counted=False)


def _event(action: AuditAction, admin: PlatformAdmin | None, **metadata: object) -> SecurityEvent:
    return SecurityEvent(
        action=action,
        actor_user_id=admin.id if admin else None,
        entity_type=AuditEntity.PLATFORM_ADMIN if admin else None,
        entity_id=admin.id if admin else None,
        metadata=metadata,
        attribute_to_request_user=False,
        platform=True,
    )


class PlatformAuthService:
    def __init__(
        self,
        db: Session,
        *,
        settings: Settings,
        hasher: PasswordHasherService,
        limiter: RateLimiter,
        policies: RatePolicies,
        session_policy: SessionPolicy,
        security_audit: SecurityAudit,
        device_trust: DeviceTrust,
    ) -> None:
        self.db = db
        self.settings = settings
        self.hasher = hasher
        self.limiter = limiter
        self.policies = policies
        self.security_audit = security_audit
        self.device_trust = device_trust
        self.sessions = PlatformSessionManager(db, session_policy)
        self.admins = PlatformAdminRepository(db)

    def _key(self, *parts: object) -> str:
        return limiter_key(self.settings.secret_key.get_secret_value(), *parts)

    # ---- sign-in / sign-out ---------------------------------------------------------------------

    def login(
        self,
        email: str,
        password: str,
        context: RequestContext,
        *,
        presented_session_token: str | None,
        device_cookie: str | None,
    ) -> PlatformLogin:
        email = normalise_email(email)
        ip_email_key = self._key("platform-login-ip-email", rate_limit_subject(context.ip_address), email)
        attempt = self._reserve(email, password, ip_email_key, context, device_cookie=device_cookie)
        now = app_time.now()
        try:
            admin, reason, verified_hash = self._verify(attempt.admin, password, now=now)
            if admin is not None and reason is None:
                admin, reason = self._recheck_under_lock(admin, verified_hash, now=now)
        except BaseException:
            attempt.give_back(self.limiter)
            raise
        if admin is None or reason is not None:
            self.limiter.settle(attempt.success, counted=False)
            self._failed(admin, reason or "unknown_account", attempt.failures)
        self.limiter.settle(attempt.failures, counted=False)
        self.limiter.clear(self.policies.login_failures_ip_email, ip_email_key)
        if attempt.device_key is not None:
            self.limiter.clear(self.policies.login_failures_device, attempt.device_key)
        try:
            issued = self._sign_in(admin, password, context, presented_session_token, now=now)
        except BaseException:
            self.limiter.settle(attempt.success, counted=False)
            raise
        self.limiter.settle(attempt.success, counted=True)
        cookie = self.device_trust.issue(device_cookie, admin.id, admin.device_trust_epoch, now=now)
        return PlatformLogin(admin=admin, issued=issued, device_cookie=cookie)

    def _verify(
        self, admin: PlatformAdmin | None, password: str, *, now: datetime
    ) -> tuple[PlatformAdmin | None, str | None, str | None]:
        """Exactly one Argon2 verification on every path, then the account checks."""
        if admin is None:
            self.hasher.verify_dummy(password)
            return None, "unknown_account", None
        verified_hash = admin.password_hash
        if not self.hasher.verify(verified_hash, password):
            return admin, "bad_password", None
        return admin, self._account_problem(admin, now=now), verified_hash

    def _account_problem(self, admin: PlatformAdmin, *, now: datetime) -> str | None:
        if self.settings.is_production and is_seed_platform_admin(admin.id):
            # The seeds' demo account, whose password is published, in a production database (B11-36).
            return "seed_account"
        if not admin.is_active:
            return "inactive"
        if admin.password_expires_at is not None and admin.password_expires_at <= now:
            return "password_expired"
        return None

    def _recheck_under_lock(
        self, admin: PlatformAdmin, verified_hash: str | None, *, now: datetime
    ) -> tuple[PlatformAdmin, str | None]:
        locked = self.admins.lock_credentials(admin.id)
        if locked is None or locked.password_hash != verified_hash:
            return admin, "credentials_changed"
        return locked, self._account_problem(locked, now=now)

    def _sign_in(
        self,
        admin: PlatformAdmin,
        password: str,
        context: RequestContext,
        presented_session_token: str | None,
        *,
        now: datetime,
    ) -> IssuedPlatformSession:
        if self.hasher.needs_rehash(admin.password_hash):
            admin.password_hash = self.hasher.hash(password)
        if presented_session_token:
            previous = self.sessions.lookup(presented_session_token, now=now)
            if previous is not None:
                self.sessions.revoke(previous[0].id, now=now)
        issued = self.sessions.create(
            admin, now=now, ip_address=context.ip_address, user_agent=context.user_agent
        )
        admin.last_login_at = now
        audit.record_platform(
            self.db,
            action=AuditAction.AUTH_LOGIN_SUCCEEDED,
            context=context,
            actor_platform_admin_id=admin.id,
            entity_type=AuditEntity.PLATFORM_ADMIN,
            entity_id=admin.id,
            metadata={"session_id": issued.session.id},
        )
        self.db.commit()
        return issued

    def _reserve(
        self,
        email: str,
        password: str,
        ip_email_key: str,
        context: RequestContext,
        *,
        device_cookie: str | None,
    ) -> _Attempt:
        """Every budget before any hashing (see the module): the client's first, so a client that has
        spent them costs no database work, then the account's (or the trusted device's, or the temporary
        password's) and the account's successful sign-ins."""
        subject = rate_limit_subject(context.ip_address)
        prefix = rate_limit_prefix(context.ip_address)
        client_keys = [
            LimitKey(self.policies.login_failures_ip_email, ip_email_key),
            # Shared with the tenant sign-in: one client's failures count once, wherever it guesses.
            LimitKey(self.policies.login_failures_ip, self._key("login-ip", subject)),
        ]
        if prefix is not None:
            client_keys.append(
                LimitKey(self.policies.login_failures_prefix, self._key("login-prefix", prefix))
            )
        client = self.limiter.reserve(client_keys)
        if client.denied_by is not None:
            raise RateLimited(retry_after=client.retry_after, policy=client.denied_by.name)
        try:
            admin = self.admins.get_by_email(email)
            device_key = None
            if admin is not None:
                device_key = self._own_budget_key(admin, password, device_cookie, now=app_time.now())
            account = self.limiter.reserve([self._account_key(email, admin, device_key)])
            if account.denied_by is not None:
                raise self._throttled(admin, account.denied_by, account.retry_after)
            success = self._reserve_success(admin, account)
        except BaseException:
            self.limiter.settle(client, counted=False)
            raise
        return _Attempt(client.joined(account), success, admin, device_key)

    def _own_budget_key(
        self, admin: PlatformAdmin, password: str, device_cookie: str | None, *, now: datetime
    ) -> str | None:
        """The key of the failure budget this attempt has for itself instead of the account's, or None.

        A browser holding the account's device cookie has its device's budget (SEC-01). A sign-in whose
        password starts with the tagged characters of the temporary password that the CLI generated has
        that password's budget (B11-35): the operator's reset must let its holder in while strangers keep
        the account's budget spent, and a new account has no trusted browser yet. Both are judged by
        `login_failures_device`: the same numbers, and a block that is theirs alone."""
        device = self.device_trust.device_for(device_cookie, admin.id, admin.device_trust_epoch, now=now)
        if device is not None:
            return self._key("platform-login-device", admin.id, device)
        if holds_temporary_password(admin, password, now=now):
            return self._key("platform-login-temporary-password", admin.id, admin.temporary_password_tag)
        return None

    def _account_key(self, email: str, admin: PlatformAdmin | None, device_key: str | None) -> LimitKey:
        if device_key is not None:
            return LimitKey(self.policies.login_failures_device, device_key)
        if admin is not None:
            # With the device-trust epoch (B11-35): failures counted against a password that has since
            # been reset or changed are not held against its successor. The new password is not the one
            # that was being guessed, and the operator's reset runs in another process, which cannot
            # clear this process's limiter.
            return LimitKey(
                self.policies.login_failures_account,
                self._key("platform-login-account", admin.id, admin.device_trust_epoch),
            )
        return LimitKey(
            self.policies.login_failures_unknown_account, self._key("platform-login-unknown-account", email)
        )

    def _reserve_success(self, admin: PlatformAdmin | None, account: Reservation) -> Reservation:
        if admin is None:
            return Reservation(())
        policy = self.policies.login_successes_account
        success = self.limiter.reserve([LimitKey(policy, self._key("platform-login-success", admin.id))])
        if success.denied_by is not None:
            self.limiter.settle(account, counted=False)
            raise self._throttled(admin, policy, success.retry_after)
        return success

    @staticmethod
    def _throttled(admin: PlatformAdmin | None, policy: RatePolicy, retry_after: int) -> RateLimited:
        return RateLimited(
            ACCOUNT_THROTTLED_MESSAGE,
            retry_after=retry_after,
            policy=policy.name,
            security_events=[_event(AuditAction.RATE_LIMITED, admin, policy=policy.name)],
        )

    def _failed(self, admin: PlatformAdmin | None, reason: str, reservation: Reservation) -> NoReturn:
        decisions = self.limiter.settle(reservation, counted=True)
        locked_by = next((name for name, decision in decisions.items() if decision.lockout_started), None)
        events = [_event(AuditAction.AUTH_LOGIN_FAILED, admin, reason=reason)]
        if locked_by is not None:
            events.append(_event(AuditAction.AUTH_ACCOUNT_THROTTLED, admin, policy=locked_by))
        raise InvalidCredentials(security_events=events)

    def logout(self, auth: PlatformAuthContext, context: RequestContext) -> None:
        self.sessions.revoke(auth.session_id, now=app_time.now())
        audit.record_platform(
            self.db,
            action=AuditAction.AUTH_LOGOUT,
            context=context,
            actor_platform_admin_id=auth.platform_admin_id,
            entity_type=AuditEntity.PLATFORM_ADMIN,
            entity_id=auth.platform_admin_id,
            metadata={"session_id": auth.session_id},
        )
        self.db.commit()

    # ---- password change ------------------------------------------------------------------------

    def change_password(
        self,
        auth: PlatformAuthContext,
        current_password: str,
        new_password: str,
        context: RequestContext,
        *,
        device_cookie: str | None,
    ) -> PlatformPasswordChanged:
        admin = auth.admin
        problem = password_policy_error(new_password, email=admin.email, context=account_words(admin))
        if problem is not None:
            raise ValidationFailed({"new_password": problem})
        # Wrong current passwords are counted against the password they were guesses at (B11-35): the
        # epoch changes with every reset and change, so a budget spent before the operator's reset does
        # not refuse the change that the reset demands.
        failures_key = f"platform:{auth.platform_admin_id}:{admin.device_trust_epoch}"
        failures_policy = self.policies.password_change_failures
        failures = self.limiter.reserve((LimitKey(failures_policy, failures_key),))
        if failures.denied_by is not None:
            raise RateLimited(retry_after=failures.retry_after, policy=failures_policy.name)
        change = self._reserve_change(auth, failures)
        verified_hash = admin.password_hash
        try:
            verified = self.hasher.verify(verified_hash, current_password)
        except BaseException:
            self.limiter.settle(failures, counted=False)
            self.limiter.settle(change, counted=False)
            raise
        if not verified:
            self.limiter.settle(change, counted=False)
            self._current_password_rejected(auth, failures)
        self.limiter.settle(failures, counted=False)
        try:
            issued, now = self._replace(auth, verified_hash, current_password, new_password, context)
        except BaseException:
            self.limiter.settle(change, counted=False)
            raise
        self.limiter.settle(change, counted=True)
        self.limiter.clear(failures_policy, failures_key)
        cookie = self.device_trust.issue(device_cookie, admin.id, admin.device_trust_epoch, now=now)
        return PlatformPasswordChanged(session=issued, device_cookie=cookie)

    def _reserve_change(self, auth: PlatformAuthContext, failures: Reservation) -> Reservation:
        """A slot of the account's successful password changes per hour (SEC-43), taken with the failure
        slot and before any hashing; it counts only when the change commits.

        The change that completes an operator-issued temporary password takes none (B11-35): it is the
        one request the account can make (every other answers PASSWORD_CHANGE_REQUIRED), it can happen
        once per `create-platform-admin` run, and a budget spent before the reset would otherwise leave
        the owner locked behind that gate for up to an hour."""
        if auth.admin.must_change_password:
            return Reservation(())
        policy = self.policies.password_changes_per_user
        change = self.limiter.reserve((LimitKey(policy, f"platform:{auth.platform_admin_id}"),))
        if change.denied_by is not None:
            self.limiter.settle(failures, counted=False)
            raise RateLimited(retry_after=change.retry_after, policy=policy.name)
        return change

    def _replace(
        self,
        auth: PlatformAuthContext,
        verified_hash: str,
        current_password: str,
        new_password: str,
        context: RequestContext,
    ) -> tuple[IssuedPlatformSession, datetime]:
        if normalise_password(new_password) == normalise_password(current_password):
            raise ValidationFailed({"new_password": PASSWORD_UNCHANGED})
        now = app_time.now()
        locked = self.admins.lock_credentials(auth.platform_admin_id)
        if locked is None or not locked.is_active or not self.sessions.is_live(auth.session_id, now=now):
            raise NotAuthenticated(
                security_events=[
                    _event(AuditAction.AUTH_PASSWORD_CHANGE_FAILED, auth.admin, reason="session_ended")
                ]
            )
        if locked.password_hash != verified_hash:
            raise InvalidCurrentPassword(
                security_events=[
                    _event(AuditAction.AUTH_PASSWORD_CHANGE_FAILED, auth.admin, reason="credentials_changed")
                ]
            )
        set_platform_password(locked, self.hasher.hash(new_password), now=now)
        self.db.flush()
        revoked = self.sessions.revoke_all(locked.id, now=now)
        issued = self.sessions.create(
            locked, now=now, ip_address=context.ip_address, user_agent=context.user_agent
        )
        audit.record_platform(
            self.db,
            action=AuditAction.AUTH_PASSWORD_CHANGED,
            context=context,
            actor_platform_admin_id=locked.id,
            entity_type=AuditEntity.PLATFORM_ADMIN,
            entity_id=locked.id,
            metadata={"revoked_sessions": revoked, "session_id": issued.session.id},
        )
        self.db.commit()
        return issued, now

    def _current_password_rejected(self, auth: PlatformAuthContext, reservation: Reservation) -> NoReturn:
        """Count the failed guess; once the budget is spent the session ends too (as for users)."""
        policy = self.policies.password_change_failures
        decision = self.limiter.settle(reservation, counted=True)[policy.name]
        metadata: dict[str, object] = {"reason": "invalid_current_password"}
        if not decision.allowed:
            self.sessions.revoke(auth.session_id, now=app_time.now())
            self.db.commit()
            metadata["session_revoked"] = True
        raise InvalidCurrentPassword(
            security_events=[_event(AuditAction.AUTH_PASSWORD_CHANGE_FAILED, auth.admin, **metadata)]
        )

    # ---- preferences ----------------------------------------------------------------------------

    def set_language(self, auth: PlatformAuthContext, language: Language) -> PlatformAdmin:
        """The platform pages' language; not audited, as for users (B10-4)."""
        admin = auth.admin
        if admin.preferred_language != language.value:
            admin.preferred_language = language.value
            self.db.commit()
        return admin


def set_platform_password(
    admin: PlatformAdmin,
    password_hash: str,
    *,
    now: datetime,
    temporary_until: datetime | None = None,
    temporary_tag: str | None = None,
) -> None:
    """A new password: a temporary one (`temporary_until`, from the CLI) must be changed at the next
    sign-in. A new device-trust epoch ends the trust of every browser that signed in before (SEC-30) and
    starts the account's failure budgets afresh (B11-35). `temporary_tag` is the tag of a generated
    temporary password (`security.temporary_passwords`); any other password has none, so a password
    change removes the tag of the temporary password it replaces."""
    if temporary_tag is not None and temporary_until is None:
        raise ValueError("only a temporary password has a tag")
    admin.password_hash = password_hash
    admin.must_change_password = temporary_until is not None
    admin.password_expires_at = temporary_until
    admin.password_changed_at = now
    admin.device_trust_epoch = new_device_trust_epoch()
    admin.temporary_password_tag = temporary_tag
