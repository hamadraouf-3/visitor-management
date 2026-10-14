"""Authentication use cases (contract §7.1-§7.4).

Login: normalise the e-mail, reserve the attempt in every login-failure budget before any hashing,
always run exactly one Argon2 verification (the user's hash or a dummy), then check activity and
temporary-password expiry. Every failure is the same 401 INVALID_CREDENTIALS and is audited through the
security-event writer.

One refusal has an answer of its own (B11-46): when the password verified, the account is active and its
password current, and the only obstacle is that the platform owner deactivated the company, the sign-in
answers 409 COMPANY_INACTIVE ("This company is deactivated."), so the person learns why instead of being
told their correct password is wrong. It is reachable with valid credentials only: a wrong password or an
unknown address gets the same 401 as ever, after the same single verification. It is audited as before
(AUTH_LOGIN_FAILED, `reason = "company_inactive"`) and is not a failed attempt: nothing is counted
towards a lockout, so retrying while the company is deactivated locks nobody out after its reactivation.
It counts where a successful sign-in counts instead (the account's budget of verified sign-ins, SEC-02),
which bounds what a credential holder can make the server verify and write.

In production a seed account cannot sign in (`services.seed_guard`, B11-36): it answers like a wrong
password.

Throttled password checks reserve their slot atomically (`RateLimiter.reserve`) and settle it once the
outcome is known, so concurrent attempts cannot all pass a check before any failure is recorded. Login
reserves the client's budgets first (a client that has spent them costs no database work), then looks
the account up and reserves its budget: an existing account's bucket is keyed by the user, so the
number of those buckets is bounded by the accounts that exist, while an address without an account gets
an identical budget keyed by the typed address (`login_failures_unknown_account`). Both lock out alike,
so a lockout does not reveal which addresses have accounts. A browser holding a device cookie for the
account (it signed in, or completed a reset, there before: `security.device_trust`) is judged by that
device's own budget instead, so strangers' failures cannot keep the account's own browsers out (SEC-01).
Successful sign-ins have a budget of their own per account (SEC-02).

Change-password replaces the caller's session as well as revoking the others (SEC-04), and both a change
and a reset send the account a "your password was changed" notice (SEC-06). Successful changes have a
budget of their own per account, like sign-ins (SEC-43). Both also give the account a
new device-trust epoch, which ends the trust of every browser but the one that made the change (SEC-30);
so does a deactivation (`UsersService.update_user`).

Credential changes and logins serialise on the user row (`UserRepository.lock_credentials`): login
re-checks, under that lock, that the hash it verified is still the stored one before it creates a
session, and change-password writes the new hash only if the verified hash is still current and its
session is still live (compare-and-swap). Without this, a login or change that verified the old
password before a reset/change committed would survive that reset/change (§7.2 revocation).
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import NoReturn

import anyio.to_thread
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.client_ip import rate_limit_prefix, rate_limit_subject
from app.core.config import Settings
from app.core.errors import (
    CompanyInactive,
    InvalidCredentials,
    InvalidCurrentPassword,
    InvalidResetToken,
    NotAuthenticated,
    RateLimited,
    SecurityEvent,
    ValidationFailed,
)
from app.core.field_errors import FieldCode, FieldProblem
from app.core.rate_limit import LimitKey, RateLimiter, RatePolicies, RatePolicy, Reservation, limiter_key
from app.core.request_context import RequestContext
from app.core.text import normalise_email
from app.db.session import session_factory
from app.email.dispatcher import EmailDispatcher, ensure_committed
from app.email.rendering import EmailRenderer
from app.email.service import PASSWORD_RESET_TTL, DeliveryJob, EmailService, PasswordChange
from app.models import PasswordResetToken, User
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.password_resets import PasswordResetRepository
from app.repositories.users import UserRepository
from app.security.device_trust import DeviceTrust, new_device_trust_epoch
from app.security.passwords import PasswordHasherService, normalise_password, password_policy_error
from app.security.sessions import AuthContext, IssuedSession, SessionManager, SessionPolicy
from app.security.tokens import generate_token, hash_token, is_well_formed
from app.services import audit
from app.services.audit import AuditAction, AuditEntity, SecurityAudit
from app.services.seed_guard import is_seed_user

logger = logging.getLogger("app.auth")

ACCOUNT_THROTTLED_MESSAGE = "Too many attempts. Try again later."
PASSWORD_UNCHANGED = FieldProblem(
    FieldCode.PASSWORD_UNCHANGED, "Choose a password that is different from your current password."
)
RESET_REQUEST_ACCEPTED_MESSAGE = (
    "If an account exists for that email address, we have sent instructions to reset the password."
)
# The audited reason of a sign-in whose only obstacle is the company's deactivation (B11-46).
COMPANY_INACTIVE = "company_inactive"


def _account_words(user: User) -> tuple[str, ...]:
    """The account's own words a new password must not be built from (with its e-mail address)."""
    return (user.full_name, user.company.name, user.company.slug)


@dataclass(frozen=True, slots=True)
class PasswordChanged:
    session: IssuedSession  # replaces the caller's session (SEC-04)
    notice: DeliveryJob | None  # "your password was changed" (SEC-06), delivered after the commit
    device_cookie: str  # the browser's device cookie: the only browser trusted for the account (SEC-30)


@dataclass(frozen=True, slots=True)
class PasswordReset:
    device_cookie: str  # the browser's device cookie: the only browser trusted for the account (SEC-30)
    notice: DeliveryJob | None


@dataclass(frozen=True, slots=True)
class LoginResult:
    user: User
    issued: IssuedSession
    device_cookie: str  # the browser's device cookie, now trusting it for this account (SEC-01)


@dataclass(frozen=True, slots=True)
class _LoginAttempt:
    """A login attempt's limiter slots: `failures` (the client's and the account's or device's failure
    budgets) count when it fails, `success` (the account's successful sign-ins) when it succeeds."""

    failures: Reservation
    success: Reservation
    user: User | None
    device_key: str | None

    def give_back(self, limiter: RateLimiter) -> None:
        limiter.settle(self.failures, counted=False)
        limiter.settle(self.success, counted=False)


@dataclass(frozen=True, slots=True)
class _ChangeOutcome:
    """A committed password change: the caller's new session, the notice to deliver and its instant."""

    session: IssuedSession
    notice: DeliveryJob | None
    now: datetime


@dataclass(frozen=True, slots=True)
class _Verification:
    """Outcome of the password check: the user (if any), the failure reason (None on success) and the
    hash the password was verified against."""

    user: User | None
    reason: str | None
    verified_hash: str | None = None


class AuthService:
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
        emails: EmailService,
        device_trust: DeviceTrust | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.hasher = hasher
        self.limiter = limiter
        self.policies = policies
        self.security_audit = security_audit
        self.emails = emails
        self.device_trust = device_trust or DeviceTrust(settings.secret_key.get_secret_value())
        self.sessions = SessionManager(db, session_policy)
        self.users = UserRepository(db)
        self.resets = PasswordResetRepository(db)

    def _key(self, *parts: object) -> str:
        return limiter_key(self.settings.secret_key.get_secret_value(), *parts)

    # ---- login / logout -------------------------------------------------------------------------

    def login(
        self,
        email: str,
        password: str,
        context: RequestContext,
        *,
        presented_session_token: str | None,
        device_cookie: str | None = None,
    ) -> LoginResult:
        email = normalise_email(email)
        ip_email_key = self._key("login-ip-email", rate_limit_subject(context.ip_address), email)
        attempt = self._reserve_login_attempt(email, ip_email_key, context, device_cookie=device_cookie)
        now = app_time.now()
        try:
            outcome = self._authenticate(attempt.user, password, now=now)
            if outcome.user is not None and outcome.reason is None:
                outcome = self._recheck_under_lock(outcome, now=now)
        except BaseException:
            attempt.give_back(self.limiter)  # no verdict (e.g. 503 SERVICE_BUSY)
            raise
        user = outcome.user
        if user is not None and outcome.reason == COMPANY_INACTIVE:
            self._company_inactive(user, attempt)
        if user is None or outcome.reason is not None:
            self.limiter.settle(attempt.success, counted=False)
            self._login_failed(user, outcome.reason or "unknown_account", attempt.failures)
        self.limiter.settle(attempt.failures, counted=False)
        self.limiter.clear(self.policies.login_failures_ip_email, ip_email_key)
        if attempt.device_key is not None:
            self.limiter.clear(self.policies.login_failures_device, attempt.device_key)
        try:
            issued = self._sign_in(user, password, context, presented_session_token, now=now)
        except BaseException:
            self.limiter.settle(attempt.success, counted=False)
            raise
        self.limiter.settle(attempt.success, counted=True)
        return LoginResult(
            user=user,
            issued=issued,
            device_cookie=self.device_trust.issue(device_cookie, user.id, user.device_trust_epoch, now=now),
        )

    def _sign_in(
        self,
        user: User,
        password: str,
        context: RequestContext,
        presented_session_token: str | None,
        *,
        now: datetime,
    ) -> IssuedSession:
        """The new session of a verified login, committed with its audit row."""
        if self.hasher.needs_rehash(user.password_hash):
            user.password_hash = self.hasher.hash(password)
        if presented_session_token:
            previous = self.sessions.lookup(presented_session_token, now=now)
            if previous is not None:
                self.sessions.revoke(previous[0].id, now=now)
        issued = self.sessions.create(
            user, now=now, ip_address=context.ip_address, user_agent=context.user_agent
        )
        user.last_login_at = now
        audit.record(
            self.db,
            action=AuditAction.AUTH_LOGIN_SUCCEEDED,
            context=context,
            company_id=user.company_id,
            actor_user_id=user.id,
            entity_type=AuditEntity.USER,
            entity_id=user.id,
            metadata={"session_id": issued.session.id},
        )
        self.db.commit()
        return issued

    def logout(self, auth: AuthContext, context: RequestContext) -> None:
        now = app_time.now()
        self.sessions.revoke(auth.session_id, now=now)
        audit.record(
            self.db,
            action=AuditAction.AUTH_LOGOUT,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.USER,
            entity_id=auth.user_id,
            metadata={"session_id": auth.session_id},
        )
        self.db.commit()

    def _authenticate(self, user: User | None, password: str, *, now: datetime) -> _Verification:
        """Exactly one Argon2 verification on every path (timing parity), then the account checks."""
        if user is None:
            self.hasher.verify_dummy(password)
            return _Verification(None, "unknown_account")
        verified_hash = user.password_hash
        if not self.hasher.verify(verified_hash, password):
            return _Verification(user, "bad_password")
        return _Verification(user, self._account_problem(user, now=now), verified_hash)

    def _account_problem(self, user: User, *, now: datetime) -> str | None:
        """Why an account whose password verified may not sign in (the audited `reason`), or None.

        The company comes last: "company_inactive" means it is the only obstacle, which is what the
        answer of its own says (`_company_inactive`, B11-46)."""
        if self.settings.is_production and is_seed_user(user.id):
            return "seed_account"
        if not user.is_active:
            return "inactive"
        if user.password_expires_at is not None and user.password_expires_at <= now:
            return "password_expired"
        if not user.company.is_active:
            return "company_inactive"
        return None

    def _company_inactive(self, user: User, attempt: _LoginAttempt) -> NoReturn:
        """The sign-in of a user whose company the platform owner deactivated (B11-10), with the right
        password: 409 COMPANY_INACTIVE instead of the 401 that every failure shares (B11-46).

        Not a failed attempt: the failure slots are given back, so it counts towards no lockout and
        costs the client's budgets nothing. A verified one: it takes the slot of a successful sign-in
        (SEC-02), which bounds how often a credential holder can make the server run a verification and
        write this audit row (30 in 15 minutes, then 429 before any hashing)."""
        self.limiter.settle(attempt.failures, counted=False)
        self.limiter.settle(attempt.success, counted=True)
        raise CompanyInactive(
            security_events=[
                SecurityEvent(
                    action=AuditAction.AUTH_LOGIN_FAILED,
                    company_id=user.company_id,
                    actor_user_id=user.id,
                    entity_type=AuditEntity.USER,
                    entity_id=user.id,
                    metadata={"reason": COMPANY_INACTIVE},
                    attribute_to_request_user=False,
                )
            ]
        )

    def _recheck_under_lock(self, outcome: _Verification, *, now: datetime) -> _Verification:
        """Lock the user row and require the verified hash to still be the stored one.

        A reset or change that committed after the unlocked read (and therefore revoked only the
        sessions that existed then) must defeat this login as well; one that commits later waits for
        the lock and then revokes the session this login creates.
        """
        user = outcome.user
        if user is None:
            return outcome
        # The company first (the lock order of `repositories.locking`): a deactivation holds it `FOR
        # UPDATE` until it commits, so this sign-in either sees the company deactivated or makes the
        # deactivation wait, and then revoke, the session it creates (B11-10).
        CompanyRepository(self.db).get(user.company_id, lock=RowLock.KEY_SHARE)
        locked = self.users.lock_credentials(user.company_id, user.id)
        if locked is None or locked.password_hash != outcome.verified_hash:
            return _Verification(user, "credentials_changed")
        return _Verification(locked, self._account_problem(locked, now=now), outcome.verified_hash)

    def _reserve_login_attempt(
        self, email: str, ip_email_key: str, context: RequestContext, *, device_cookie: str | None
    ) -> _LoginAttempt:
        """Take a slot in every login budget before any hashing (§7.1, §7.3): the failure budgets, and
        for an existing account its budget of successful sign-ins (SEC-02/SEC-14), which counts only a
        login that succeeds, so a credential holder cannot sign in without bound (each sign-in costs an
        Argon2 verification and writes a session and an audit row that are never deleted).

        The client's budgets come first, so a client that has spent them costs no database work. The
        account budget needs the lookup, which every attempt that gets this far makes exactly once
        (whether or not the address has an account), so it adds no timing difference. A trusted
        browser's attempt takes its device's budget instead of the account's (SEC-01): the account's
        block is for untrusted clients, so a stranger's failures cannot keep the account's own browsers
        out, and failures from a trusted browser block only that browser.
        """
        subject = rate_limit_subject(context.ip_address)
        prefix = rate_limit_prefix(context.ip_address)
        client_keys = [
            LimitKey(self.policies.login_failures_ip_email, ip_email_key),
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
            user = self.users.get_by_email(email)
            device_key = None
            if user is not None:
                device = self.device_trust.device_for(
                    device_cookie, user.id, user.device_trust_epoch, now=app_time.now()
                )
                if device is not None:
                    device_key = self._key("login-device", user.id, device)
            account = self.limiter.reserve([self._login_account_key(email, user, device_key)])
            if account.denied_by is not None:
                raise self._account_throttled(user, account.denied_by, account.retry_after)
            success = self._reserve_success(user, account)
        except BaseException:
            self.limiter.settle(client, counted=False)  # a locked account does not cost the client
            raise
        return _LoginAttempt(client.joined(account), success, user, device_key)

    def _reserve_success(self, user: User | None, account: Reservation) -> Reservation:
        """A slot of the account's successful sign-ins (none for an address without an account). When
        they are spent the attempt is refused before any hashing, like a locked account."""
        if user is None:
            return Reservation(())
        policy = self.policies.login_successes_account
        success = self.limiter.reserve([LimitKey(policy, self._key("login-success", user.id))])
        if success.denied_by is not None:
            self.limiter.settle(account, counted=False)
            raise self._account_throttled(user, policy, success.retry_after)
        return success

    def _login_account_key(self, email: str, user: User | None, device_key: str | None) -> LimitKey:
        if device_key is not None:
            return LimitKey(self.policies.login_failures_device, device_key)
        if user is not None:
            return LimitKey(self.policies.login_failures_account, self._key("login-account", user.id))
        return LimitKey(
            self.policies.login_failures_unknown_account, self._key("login-unknown-account", email)
        )

    @staticmethod
    def _account_throttled(user: User | None, policy: RatePolicy, retry_after: int) -> RateLimited:
        return RateLimited(
            ACCOUNT_THROTTLED_MESSAGE,
            retry_after=retry_after,
            policy=policy.name,
            security_events=[
                SecurityEvent(
                    action=AuditAction.RATE_LIMITED,
                    company_id=user.company_id if user else None,
                    actor_user_id=user.id if user else None,
                    metadata={"policy": policy.name},
                    attribute_to_request_user=False,
                )
            ],
        )

    def _login_failed(self, user: User | None, reason: str, reservation: Reservation) -> NoReturn:
        decisions = self.limiter.settle(reservation, counted=True)
        # Only the account policies have lockouts: one starting here means this failure reached the limit.
        locked_by = next((name for name, decision in decisions.items() if decision.lockout_started), None)

        company_id = user.company_id if user else None
        actor_user_id = user.id if user else None
        events = [
            SecurityEvent(
                action=AuditAction.AUTH_LOGIN_FAILED,
                company_id=company_id,
                actor_user_id=actor_user_id,
                entity_type=AuditEntity.USER if user else None,
                entity_id=actor_user_id,
                metadata={"reason": reason},
                attribute_to_request_user=False,
            )
        ]
        if locked_by is not None:
            events.append(
                SecurityEvent(
                    action=AuditAction.AUTH_ACCOUNT_THROTTLED,
                    company_id=company_id,
                    actor_user_id=actor_user_id,
                    entity_type=AuditEntity.USER if user else None,
                    entity_id=actor_user_id,
                    metadata={"policy": locked_by},
                    attribute_to_request_user=False,
                )
            )
        raise InvalidCredentials(security_events=events)

    # ---- password change ------------------------------------------------------------------------

    def change_password(
        self,
        auth: AuthContext,
        current_password: str,
        new_password: str,
        context: RequestContext,
        *,
        device_cookie: str | None = None,
    ) -> PasswordChanged:
        """Change the password; returns the session that replaces the caller's (SEC-04), the notice to
        deliver after the commit (SEC-06) and the browser's device cookie (SEC-30).

        Every other session is revoked (§7.2), and so is the current one: the caller continues on a new
        session with a new CSRF token, so a copy of the old cookie (an unattended tablet, a borrowed
        browser profile) does not survive the change that its owner made to get rid of it. Likewise
        every other browser's device trust ends (the new epoch): only this browser is trusted."""
        user = auth.user
        # The policy first: a new password it refuses is answered without hashing anything (an Argon2
        # verification per refused attempt would cost the server and the caller's own failure budget).
        problem = password_policy_error(new_password, email=user.email, context=_account_words(user))
        if problem is not None:
            raise ValidationFailed({"new_password": problem})
        policy = self.policies.password_change_failures
        reservation = self.limiter.reserve((LimitKey(policy, str(auth.user_id)),))
        if reservation.denied_by is not None:
            raise RateLimited(retry_after=reservation.retry_after, policy=policy.name)
        change = self._reserve_change(auth, reservation)
        verified_hash = user.password_hash
        try:
            verified = self.hasher.verify(verified_hash, current_password)
        except BaseException:
            self.limiter.settle(reservation, counted=False)
            self.limiter.settle(change, counted=False)
            raise
        if not verified:
            self.limiter.settle(change, counted=False)
            self._current_password_rejected(auth, reservation)
        self.limiter.settle(reservation, counted=False)

        try:
            changed = self._replace_password(auth, verified_hash, current_password, new_password, context)
        except BaseException:
            self.limiter.settle(change, counted=False)  # nothing was changed
            raise
        self.limiter.settle(change, counted=True)
        self.limiter.clear(policy, str(auth.user_id))
        trusted = self.device_trust.issue(device_cookie, user.id, user.device_trust_epoch, now=changed.now)
        return PasswordChanged(changed.session, changed.notice, trusted)

    def _reserve_change(self, auth: AuthContext, failures: Reservation) -> Reservation:
        """A slot of the account's successful password changes (SEC-43), taken with the failure slot and
        before any hashing; it counts only when the change commits. Without this budget a credential
        holder could change the password back and forth at the API rate: two Argon2 operations on the
        process-wide hash pool and a session and an audit row (never deleted) per request, as sign-ins
        could before SEC-02. Once it is spent the attempt is refused (429) before verification; the
        account holder can still reset the password."""
        policy = self.policies.password_changes_per_user
        change = self.limiter.reserve((LimitKey(policy, str(auth.user_id)),))
        if change.denied_by is not None:
            self.limiter.settle(failures, counted=False)
            raise RateLimited(retry_after=change.retry_after, policy=policy.name)
        return change

    def _replace_password(
        self,
        auth: AuthContext,
        verified_hash: str,
        current_password: str,
        new_password: str,
        context: RequestContext,
    ) -> _ChangeOutcome:
        """The change itself, once the current password is verified: committed with its audit row."""
        user = auth.user
        if normalise_password(new_password) == normalise_password(current_password):
            raise ValidationFailed({"new_password": PASSWORD_UNCHANGED})

        now = app_time.now()
        self._lock_unchanged_credentials(auth, verified_hash, now=now)
        self._set_password(user, new_password, now=now)
        revoked = self.sessions.revoke_all(user.id, now=now, except_session_id=auth.session_id)
        self.sessions.revoke(auth.session_id, now=now)
        issued = self.sessions.create(
            user, now=now, ip_address=context.ip_address, user_agent=context.user_agent
        )
        self.resets.invalidate_unused(user.id, now=now)
        notice = self._password_notice(user, "changed", context, now=now)
        audit.record(
            self.db,
            action=AuditAction.AUTH_PASSWORD_CHANGED,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.USER,
            entity_id=auth.user_id,
            metadata={
                "revoked_sessions": revoked,
                "session_id": issued.session.id,
                **self._notice_metadata(notice),
            },
        )
        self.db.commit()
        return _ChangeOutcome(issued, notice, now)

    def _current_password_rejected(self, auth: AuthContext, reservation: Reservation) -> NoReturn:
        """Count the failed guess. Once the budget is spent, end this session as well: whoever holds it
        (an unattended shared tablet, a hijacked browser) must then sign in, which needs the password
        and is subject to the login throttles."""
        policy = self.policies.password_change_failures
        decision = self.limiter.settle(reservation, counted=True)[policy.name]
        metadata: dict[str, object] = {"reason": "invalid_current_password"}
        if not decision.allowed:
            self.sessions.revoke(auth.session_id, now=app_time.now())
            self.db.commit()
            metadata["session_revoked"] = True
        raise InvalidCurrentPassword(
            security_events=[
                SecurityEvent(
                    action=AuditAction.AUTH_PASSWORD_CHANGE_FAILED,
                    company_id=auth.company_id,
                    actor_user_id=auth.user_id,
                    entity_type=AuditEntity.USER,
                    entity_id=auth.user_id,
                    metadata=metadata,
                )
            ]
        )

    def _lock_unchanged_credentials(self, auth: AuthContext, verified_hash: str, *, now: datetime) -> None:
        """Compare-and-swap guard: under the user row lock, the session must still be live and the
        stored hash must still be the one the current password was verified against. Otherwise a reset
        (or another change) committed meanwhile, and this request must not overwrite it."""
        locked = self.users.lock_credentials(auth.company_id, auth.user_id)
        if locked is None or not locked.is_active or not self.sessions.is_live(auth.session_id, now=now):
            raise NotAuthenticated(security_events=[self._change_failed(auth, "session_ended")])
        if locked.password_hash != verified_hash:
            raise InvalidCurrentPassword(security_events=[self._change_failed(auth, "credentials_changed")])

    @staticmethod
    def _change_failed(auth: AuthContext, reason: str) -> SecurityEvent:
        return SecurityEvent(
            action=AuditAction.AUTH_PASSWORD_CHANGE_FAILED,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.USER,
            entity_id=auth.user_id,
            metadata={"reason": reason},
        )

    def _set_password(self, user: User, password: str, *, now: datetime) -> None:
        """Write a new password; the caller holds the user row lock (`lock_credentials`). A new
        device-trust epoch ends the trust of every browser that signed in with the old password (SEC-30):
        whoever knew it is back on the account's failure budget."""
        user.password_hash = self.hasher.hash(password)
        user.must_change_password = False
        user.password_expires_at = None
        user.password_changed_at = now
        user.device_trust_epoch = new_device_trust_epoch()
        self.db.flush()  # the users UPDATE precedes the session revocation that follows

    # ---- forgot / reset password ----------------------------------------------------------------

    def accept_password_reset_request(self, email: str, context: RequestContext) -> str | None:
        """Apply the client's forgot-password throttles. Returns the normalised e-mail to process in the
        background, or None when the request is silently dropped (the response is identical).

        The per-address limit is applied by `PasswordResetIssuer`, which looks the account up anyway:
        only an existing account receives e-mail, and its budget is keyed by the user, so typed
        addresses take no limiter memory and the request does the same work for every address.
        """
        email = normalise_email(email)
        limit_keys = [
            LimitKey(
                self.policies.forgot_password_ip,
                self._key("forgot-ip", rate_limit_subject(context.ip_address)),
            ),
        ]
        prefix = rate_limit_prefix(context.ip_address)
        if prefix is not None:
            limit_keys.append(
                LimitKey(self.policies.forgot_password_prefix, self._key("forgot-prefix", prefix))
            )
        reservation = self.limiter.reserve(limit_keys)
        if reservation.denied_by is not None:
            self.security_audit.record(
                SecurityEvent(
                    action=AuditAction.RATE_LIMITED, metadata={"policy": reservation.denied_by.name}
                ),
                context,
            )
            return None
        self.limiter.settle(reservation, counted=True)  # every accepted request counts
        return email

    def reset_password(
        self, token: str, new_password: str, context: RequestContext, *, device_cookie: str | None = None
    ) -> PasswordReset:
        """Set a new password from a reset link. Returns the browser's device cookie, now trusting it for
        the account: completing a reset proves control of the account's mailbox, so this browser signs
        in even while strangers keep the account's login blocked for untrusted clients (SEC-01), and
        that block is lifted. Every other browser's trust ends with the new epoch (SEC-30): a reset is
        how an account is taken back from someone who knew the password."""
        # Checked before the token lookup: every failed lookup writes a security audit row. Every
        # attempt counts, so the reservation is settled as counted straight away.
        limit_keys = [
            LimitKey(
                self.policies.reset_password_ip, self._key("reset-ip", rate_limit_subject(context.ip_address))
            )
        ]
        prefix = rate_limit_prefix(context.ip_address)
        if prefix is not None:
            limit_keys.append(
                LimitKey(self.policies.reset_password_prefix, self._key("reset-prefix", prefix))
            )
        reservation = self.limiter.reserve(limit_keys)
        if reservation.denied_by is not None:
            raise RateLimited(retry_after=reservation.retry_after, policy=reservation.denied_by.name)
        self.limiter.settle(reservation, counted=True)

        now = app_time.now()
        found = self.resets.find_usable(hash_token(token), now=now) if is_well_formed(token) else None
        if found is None:
            raise self._invalid_reset_token()
        _token, user = found
        problem = password_policy_error(new_password, email=user.email, context=_account_words(user))
        if problem is not None:
            raise ValidationFailed({"new_password": problem})  # the link stays usable for another try
        # The user row first, like every other credential change: change-password locks the user and
        # then invalidates this user's reset tokens, so consuming the token first could deadlock.
        CompanyRepository(self.db).get(user.company_id, lock=RowLock.KEY_SHARE)
        locked = self.users.lock_credentials(user.company_id, user.id)
        if locked is None or not locked.is_active or not locked.company.is_active:
            raise self._invalid_reset_token()  # deactivated concurrently, or its company (B11-10)
        if self.resets.consume(hash_token(token), now=now) != user.id:
            raise self._invalid_reset_token()  # consumed concurrently

        self._set_password(locked, new_password, now=now)
        revoked = self.sessions.revoke_all(user.id, now=now)
        self.resets.invalidate_unused(user.id, now=now)
        notice = self._password_notice(locked, "reset", context, now=now)
        audit.record(
            self.db,
            action=AuditAction.AUTH_PASSWORD_RESET_COMPLETED,
            context=context,
            company_id=user.company_id,
            actor_user_id=user.id,
            entity_type=AuditEntity.USER,
            entity_id=user.id,
            metadata={"revoked_sessions": revoked, **self._notice_metadata(notice)},
        )
        self.db.commit()
        self.limiter.clear(self.policies.login_failures_account, self._key("login-account", user.id))
        trusted = self.device_trust.issue(device_cookie, user.id, locked.device_trust_epoch, now=now)
        return PasswordReset(trusted, notice)

    def _password_notice(
        self, user: User, how: PasswordChange, context: RequestContext, *, now: datetime
    ) -> DeliveryJob | None:
        """Queue the "your password was changed" notice in the caller's transaction (SEC-06), within the
        account's hourly budget of such notices; None when it is spent (the change is still made)."""
        if not self.limiter.hit(self.policies.password_notices_per_user, str(user.id)).allowed:
            return None
        return self.emails.queue_password_changed(user, how=how, when=now, ip_address=context.ip_address)

    @staticmethod
    def _notice_metadata(notice: DeliveryJob | None) -> dict[str, object]:
        if notice is None:
            return {"notice": "limited"}
        return {"email_message_id": notice.message_id}

    @staticmethod
    def _invalid_reset_token() -> InvalidResetToken:
        return InvalidResetToken(
            security_events=[
                SecurityEvent(
                    action=AuditAction.AUTH_PASSWORD_RESET_FAILED,
                    metadata={"reason": "invalid_or_expired_token"},
                    attribute_to_request_user=False,
                )
            ]
        )


class PasswordResetIssuer:
    """Background half of forgot-password: token + e-mail for an existing active user.

    Runs after the 202 response with its own session, so the request does the same work whether or not
    the account exists (contract §7.2). Each account receives at most `RATE_LIMIT_FORGOT_PER_EMAIL`
    reset e-mails per 15 minutes, whoever asks; requests beyond that are dropped (audited
    RATE_LIMITED for the account's company). Issuing invalidates the user's earlier tokens under the
    user row lock, so at most one token of a user is usable at any time. Before that lock it takes the
    company row `FOR KEY SHARE` and requires the company to be active (B11-39), so a token is never
    written while the company's deactivation, which invalidates its links, is under way.
    """

    def __init__(
        self,
        *,
        settings: Settings,
        renderer: EmailRenderer,
        dispatcher: EmailDispatcher,
        limiter: RateLimiter,
        policies: RatePolicies,
        security_audit: SecurityAudit,
    ) -> None:
        self.settings = settings
        self.renderer = renderer
        self.dispatcher = dispatcher
        self.limiter = limiter
        self.policy = policies.forgot_password_account
        self.security_audit = security_audit

    async def issue_and_deliver(self, email: str, context: RequestContext) -> None:
        """The forgot-password background task: `issue` in a request worker thread (database work
        only), then the e-mail in one of the dispatcher's delivery slots, never in a request thread."""
        job = await anyio.to_thread.run_sync(self.issue, email, context)
        if job is not None:
            await self.dispatcher.deliver_in_background(job)

    def issue(self, email: str, context: RequestContext) -> DeliveryJob | None:
        """Issue a token for the account of `email` and queue its e-mail. Returns the committed job to
        deliver, or None (no active account, the account's budget spent, or an error, which is logged:
        the request was answered long ago)."""
        try:
            outcome = self._issue(email, context)
            # Both side effects follow the issuing session's end: the e-mail after the commit
            # (§3.2-1), the denial through the security-event writer's own session.
            if isinstance(outcome, SecurityEvent):
                self.security_audit.record(outcome, context)
                return None
            return outcome
        except Exception:
            logger.exception("password reset issuance failed")
            return None

    def _issue(self, email: str, context: RequestContext) -> DeliveryJob | SecurityEvent | None:
        """Issue a token and queue its e-mail. Returns the job to deliver, the denial to audit when the
        account's budget is spent, or None when there is no active account for the address."""
        with session_factory() as db:
            users = UserRepository(db)
            found = users.get_by_email(email)
            if found is None or not found.is_active or not found.company.is_active:
                return None
            if not self.limiter.hit(self.policy, self._account_key(found)).allowed:  # every request counts
                return self._account_throttled(found)
            # The company row first (the lock order of `repositories.locking`), `FOR KEY SHARE`, as the
            # sign-in and the reset itself take it (B11-39). A deactivation holds that row `FOR UPDATE`
            # until it commits, and it invalidates the company's unused links in the same transaction: so
            # this request either waits for it and finds the company deactivated (the unlocked read above
            # could not see an uncommitted change), or makes it wait until the token below is committed,
            # where its invalidation covers it. Without this lock a token written during a deactivation
            # stayed usable, and worked again after a reactivation.
            company = CompanyRepository(db).get(found.company_id, lock=RowLock.KEY_SHARE)
            if company is None or not company.is_active:
                return None
            # Then the user row, like every credential change (B1-45): concurrent issues and a
            # password change or reset then serialise, so each one's invalidation sees every token
            # issued before it and no token outlives a later issue or credential change.
            user = users.lock_credentials(found.company_id, found.id)
            if user is None or not user.is_active:
                return None
            now = app_time.now()
            resets = PasswordResetRepository(db)
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
            emails = EmailService(
                db,
                settings=self.settings,
                renderer=self.renderer,
                provider_name=self.dispatcher.provider.name,
            )
            job = emails.queue_password_reset(user, raw_token)
            audit.record(
                db,
                action=AuditAction.AUTH_PASSWORD_RESET_REQUESTED,
                context=context,
                company_id=user.company_id,
                actor_user_id=None,  # the requester is anonymous
                entity_type=AuditEntity.USER,
                entity_id=user.id,
                metadata={"email_message_id": job.message_id},
            )
            db.commit()
            ensure_committed(db)
            return job

    def _account_key(self, user: User) -> str:
        return limiter_key(self.settings.secret_key.get_secret_value(), "forgot-account", user.id)

    def _account_throttled(self, user: User) -> SecurityEvent:
        """The denial of a request beyond the account's budget, attributed to the account's company."""
        return SecurityEvent(
            action=AuditAction.RATE_LIMITED,
            company_id=user.company_id,
            entity_type=AuditEntity.USER,
            entity_id=user.id,
            metadata={"policy": self.policy.name},
            attribute_to_request_user=False,
        )
