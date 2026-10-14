"""Credential changes racing logins and other changes, on real, separately committing connections
(contract §7.2 revocation: reset revokes every session, change revokes every other session; §4: issuing
a reset token, and every credential change, invalidates the user's unused tokens).

The attacker's request is held inside its password verification (after it read the user row) while the
victim's reset or change runs to completion and commits; then the attacker's request continues. Without
serialisation on the user row, the attacker's request would act on the stale credential: a login would
create a session that survives the reset, and a password change would overwrite the reset password.
"""

import threading
import time
import uuid
from collections.abc import Iterator
from datetime import timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core import time as app_time
from app.core.config import Settings
from app.core.rate_limit import InMemoryRateLimiter, RatePolicies
from app.core.request_context import RequestContext
from app.db.session import create_db_engine, make_sessionmaker, session_factory
from app.email.dispatcher import EmailDispatcher
from app.email.providers.memory import MemoryProvider
from app.email.rendering import EmailRenderer, RenderedEmail
from app.main import create_app
from app.models import (
    AuditLog,
    Company,
    PasswordResetToken,
    PlatformAdmin,
    PlatformAuditLog,
    Role,
    User,
    UserSession,
)
from app.security.passwords import Argon2Parameters, PasswordHasherService
from app.security.tokens import generate_token, hash_token
from app.services.audit import SecurityAudit, SecurityEventCoalescer
from app.services.auth import PasswordResetIssuer
from tests.support import Api, PlatformApi, unique

pytestmark = pytest.mark.committed

FAST_ARGON2 = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)
ORIGINAL = "Original-Password-2026"
RECOVERED = "Recovered-Kiwi-Lantern-2026"
VICTIM_CHANGED = "Changed-Kiwi-Harbour-2026"
ATTACKER_CHOICE = "Chosen-Indigo-Walrus-2026"


class OneShotGate(PasswordHasherService):
    """Holds the next password verification, once armed, until the test releases it."""

    def __init__(self) -> None:
        super().__init__(FAST_ARGON2, max_concurrency=8, acquire_timeout_seconds=30)
        self._lock = threading.Lock()
        self._armed = False
        self._armed_hashing = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def arm(self) -> None:
        with self._lock:
            self._armed = True

    def arm_hashing(self) -> None:
        """Hold the next hashing instead (a creation hashes its temporary password)."""
        with self._lock:
            self._armed_hashing = True

    def verify(self, password_hash: str, password: str) -> bool:
        with self._lock:
            gated, self._armed = self._armed, False
        if gated:
            self._hold()
        return super().verify(password_hash, password)

    def hash(self, password: str) -> str:
        with self._lock:
            gated, self._armed_hashing = self._armed_hashing, False
        if gated:
            self._hold()
        return super().hash(password)

    def _hold(self) -> None:
        self.entered.set()
        if not self.release.wait(timeout=30):
            raise TimeoutError("the gate was never released")


RACE_APPLICATION_NAME = "vms-tests-race"


@pytest.fixture
def race_engine(committed_settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(
        committed_settings.runtime_url, pool_size=6, application_name=RACE_APPLICATION_NAME
    )
    yield engine
    engine.dispose()


@pytest.fixture
def maker(race_engine: Engine) -> Iterator[sessionmaker[Session]]:
    committed = make_sessionmaker(race_engine)
    session_factory.override(committed)
    try:
        yield committed
    finally:
        session_factory.clear_override()


@pytest.fixture
def gate() -> OneShotGate:
    return OneShotGate()


@pytest.fixture
def race_app(committed_settings: Settings, race_engine: Engine, gate: OneShotGate, maker) -> FastAPI:
    return create_app(
        committed_settings, engine=race_engine, password_hasher=gate, email_provider=MemoryProvider()
    )


@pytest.fixture
def victim(maker: sessionmaker[Session], gate: OneShotGate) -> User:
    with maker() as db:
        company = Company(name="Race Co", slug=unique("race"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        user = User(
            company_id=company.id,
            full_name="Race Victim",
            email=f"{unique('victim')}@example.com",
            password_hash=gate.hash(ORIGINAL),
            roles=[Role.EMPLOYEE.value],
        )
        db.add(user)
        db.commit()
        return user


def _client(app: FastAPI, address: str) -> Api:
    return Api(TestClient(app, base_url="https://testserver", client=(address, 50000)))


def _reset_token(maker: sessionmaker[Session], user: User) -> str:
    raw = generate_token()
    now = app_time.now()
    with maker() as db:
        db.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=hash_token(raw),
                expires_at=now + timedelta(minutes=30),
                created_at=now,
            )
        )
        db.commit()
    return raw


def _while_held(
    gate: OneShotGate, attacker_request, victim_action, *, hashing: bool = False
) -> httpx.Response:
    """Run `attacker_request` in a thread, hold it inside its password verification (or, with `hashing`,
    inside the hashing of a new password), run `victim_action` to completion, then let the attacker's
    request finish. Returns the attacker's response."""
    responses: list[httpx.Response] = []
    failures: list[BaseException] = []

    def attack() -> None:
        try:
            responses.append(attacker_request())
        except BaseException as exc:  # surfaced below
            failures.append(exc)

    if hashing:
        gate.arm_hashing()
    else:
        gate.arm()
    thread = threading.Thread(target=attack)
    thread.start()
    try:
        assert gate.entered.wait(timeout=30), "the attacker's request never reached the gate"
        victim_action()
    finally:
        gate.release.set()
        thread.join(timeout=30)
    assert not thread.is_alive()
    if failures:
        raise failures[0]
    return responses[0]


def _live_sessions(maker: sessionmaker[Session], user: User) -> int:
    with maker() as db:
        rows = db.scalars(
            select(UserSession.id).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        )
        return len(rows.all())


def _audit_reasons(maker: sessionmaker[Session], action: str, user: User) -> list[str]:
    with maker() as db:
        rows = db.scalars(
            select(AuditLog)
            .where(AuditLog.action == action, AuditLog.entity_id == user.id)
            .order_by(AuditLog.seq)
        )
        return [row.meta.get("reason") for row in rows]


# ---- login racing a reset / a change (B3) ----------------------------------------------------------


def test_login_that_verified_the_old_password_cannot_outlive_a_reset(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    attacker = _client(race_app, "198.51.100.66")
    token = _reset_token(maker, victim)

    def reset() -> None:
        response = _client(race_app, "203.0.113.20").post(
            "/auth/reset-password", json={"token": token, "new_password": RECOVERED}, csrf=False
        )
        assert response.status_code == 204

    response = _while_held(gate, lambda: attacker.login(victim.email, ORIGINAL), reset)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"
    assert attacker.get("/auth/me").status_code == 401
    assert _live_sessions(maker, victim) == 0
    assert _audit_reasons(maker, "AUTH_LOGIN_FAILED", victim) == ["credentials_changed"]
    assert _client(race_app, "203.0.113.20").login(victim.email, RECOVERED).status_code == 200


def test_login_that_verified_the_old_password_cannot_outlive_a_change(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    owner = _client(race_app, "203.0.113.21")
    assert owner.login(victim.email, ORIGINAL).status_code == 200
    attacker = _client(race_app, "198.51.100.67")

    def change() -> None:
        response = owner.post(
            "/auth/change-password", json={"current_password": ORIGINAL, "new_password": VICTIM_CHANGED}
        )
        assert response.status_code == 204

    response = _while_held(gate, lambda: attacker.login(victim.email, ORIGINAL), change)

    assert response.status_code == 401
    assert attacker.get("/auth/me").status_code == 401
    assert owner.get("/auth/me").status_code == 200  # the changing session itself stays signed in
    assert _live_sessions(maker, victim) == 1


def test_login_that_won_the_lock_is_revoked_by_the_later_reset(
    race_app: FastAPI, victim: User, maker: sessionmaker[Session]
) -> None:
    # The other order: the login commits first; the reset then sees and revokes its session.
    attacker = _client(race_app, "198.51.100.68")
    assert attacker.login(victim.email, ORIGINAL).status_code == 200
    token = _reset_token(maker, victim)
    reset = _client(race_app, "203.0.113.22").post(
        "/auth/reset-password", json={"token": token, "new_password": RECOVERED}, csrf=False
    )
    assert reset.status_code == 204
    assert attacker.get("/auth/me").status_code == 401


# ---- change-password racing a reset / another change (B2) -------------------------------------------


def test_password_change_in_flight_cannot_overwrite_a_reset(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    attacker = _client(race_app, "198.51.100.69")
    assert attacker.login(victim.email, ORIGINAL).status_code == 200
    token = _reset_token(maker, victim)

    def reset() -> None:
        response = _client(race_app, "203.0.113.23").post(
            "/auth/reset-password", json={"token": token, "new_password": RECOVERED}, csrf=False
        )
        assert response.status_code == 204

    response = _while_held(
        gate,
        lambda: attacker.post(
            "/auth/change-password", json={"current_password": ORIGINAL, "new_password": ATTACKER_CHOICE}
        ),
        reset,
    )

    # The reset revoked the attacker's session while the change was in flight: nothing is written.
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"
    assert _client(race_app, "203.0.113.23").login(victim.email, RECOVERED).status_code == 200
    assert _client(race_app, "198.51.100.69").login(victim.email, ATTACKER_CHOICE).status_code == 401
    assert _audit_reasons(maker, "AUTH_PASSWORD_CHANGE_FAILED", victim) == ["session_ended"]


def test_concurrent_password_changes_cannot_both_win(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    # Two sessions of the same account: the one held in its verification must not overwrite the
    # other's committed change (its current password is no longer the stored one).
    first = _client(race_app, "203.0.113.24")
    second = _client(race_app, "198.51.100.70")
    assert first.login(victim.email, ORIGINAL).status_code == 200
    assert second.login(victim.email, ORIGINAL).status_code == 200

    def change_from_first() -> None:
        response = first.post(
            "/auth/change-password", json={"current_password": ORIGINAL, "new_password": VICTIM_CHANGED}
        )
        assert response.status_code == 204

    response = _while_held(
        gate,
        lambda: second.post(
            "/auth/change-password", json={"current_password": ORIGINAL, "new_password": ATTACKER_CHOICE}
        ),
        change_from_first,
    )

    # The first change revoked every other session, so the second request is no longer signed in.
    assert response.status_code == 401
    assert _client(race_app, "203.0.113.24").login(victim.email, VICTIM_CHANGED).status_code == 200
    assert _client(race_app, "198.51.100.71").login(victim.email, ATTACKER_CHOICE).status_code == 401


def test_two_changes_on_one_session_cannot_both_write(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    # The same session sends two changes (a double submit, or a hijacked tab next to the owner's). The
    # first change replaces the session (SEC-04), so the second, which waited for the user row lock,
    # finds its session ended and writes nothing.
    first = _client(race_app, "203.0.113.25")
    assert first.login(victim.email, ORIGINAL).status_code == 200
    twin = Api(
        TestClient(
            race_app,
            base_url="https://testserver",
            client=("203.0.113.25", 50001),
            cookies=dict(first.client.cookies),
        )
    )

    def change_from_first() -> None:
        response = first.post(
            "/auth/change-password", json={"current_password": ORIGINAL, "new_password": VICTIM_CHANGED}
        )
        assert response.status_code == 204

    response = _while_held(
        gate,
        lambda: twin.post(
            "/auth/change-password", json={"current_password": ORIGINAL, "new_password": ATTACKER_CHOICE}
        ),
        change_from_first,
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"
    assert first.get("/auth/me").status_code == 200  # on the session that replaced it
    assert twin.get("/auth/me").status_code == 401
    assert _client(race_app, "203.0.113.26").login(victim.email, VICTIM_CHANGED).status_code == 200
    assert _client(race_app, "203.0.113.27").login(victim.email, ATTACKER_CHOICE).status_code == 401
    assert _audit_reasons(maker, "AUTH_PASSWORD_CHANGE_FAILED", victim) == ["session_ended"]


# ---- reset-token issue racing another issue / a password change -------------------------------------


class HeldRenderer(EmailRenderer):
    """Holds the next rendering, once armed, until the test releases it. The issuer renders the e-mail
    after it has invalidated the user's older tokens and inserted its own, before it commits."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._armed = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def arm(self) -> None:
        with self._lock:
            self._armed = True

    def render(self, *args: Any, **kwargs: Any) -> RenderedEmail:
        with self._lock:
            held, self._armed = self._armed, False
        if held:
            self.entered.set()
            if not self.release.wait(timeout=30):
                raise TimeoutError("the rendering gate was never released")
        return super().render(*args, **kwargs)


@pytest.fixture
def held_renderer() -> HeldRenderer:
    return HeldRenderer()


@pytest.fixture
def issuer(committed_settings: Settings, held_renderer: HeldRenderer, maker) -> PasswordResetIssuer:
    dispatcher = EmailDispatcher(MemoryProvider(), sleep=lambda _seconds: None)
    return PasswordResetIssuer(
        settings=committed_settings,
        renderer=held_renderer,
        dispatcher=dispatcher,
        limiter=InMemoryRateLimiter(),
        policies=RatePolicies.from_settings(committed_settings),
        security_audit=SecurityAudit(SecurityEventCoalescer()),
    )


ISSUE_CONTEXT = RequestContext(ip_address="203.0.113.30", user_agent=None, request_id=None)


def _blocked_on_a_lock(
    maker: sessionmaker[Session], worker: threading.Thread, timeout: float = 5.0, *, waiters: int = 1
) -> bool:
    """True once `waiters` connections of the race engine wait for a lock; False if `worker` finished
    first (it never had to wait) or too few waited within `timeout`."""
    deadline = time.monotonic() + timeout
    with maker() as observer:
        while time.monotonic() < deadline and worker.is_alive():
            waiting = observer.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE application_name = :name AND wait_event_type = 'Lock'"
                ),
                {"name": RACE_APPLICATION_NAME},
            ).scalar_one()
            observer.rollback()
            if waiting >= waiters:
                return True
            time.sleep(0.02)
    return False


def _usable_tokens(maker: sessionmaker[Session], user: User) -> int:
    now = app_time.now()
    with maker() as db:
        rows = db.scalars(
            select(PasswordResetToken.id).where(
                PasswordResetToken.user_id == user.id,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.invalidated_at.is_(None),
                PasswordResetToken.expires_at > now,
            )
        )
        return len(rows.all())


def _start_held_issue(issuer: PasswordResetIssuer, renderer: HeldRenderer, user: User) -> threading.Thread:
    renderer.arm()
    issuing = threading.Thread(target=issuer.issue, args=(user.email, ISSUE_CONTEXT))
    issuing.start()
    assert renderer.entered.wait(timeout=30), "the issue never reached its e-mail"
    return issuing


def test_concurrent_reset_requests_leave_one_usable_token(
    issuer: PasswordResetIssuer, held_renderer: HeldRenderer, victim: User, maker: sessionmaker[Session]
) -> None:
    # The first issue has inserted its token but not committed; the second must wait for it, or its
    # invalidation cannot see that token and both stay usable.
    first = _start_held_issue(issuer, held_renderer, victim)
    second = threading.Thread(target=issuer.issue, args=(victim.email, ISSUE_CONTEXT))
    second.start()
    try:
        waited = _blocked_on_a_lock(maker, second)
    finally:
        held_renderer.release.set()
        first.join(timeout=30)
        second.join(timeout=30)
    assert not first.is_alive() and not second.is_alive()
    assert _usable_tokens(maker, victim) == 1
    assert waited, "the second issue did not wait for the first one's user row lock"


def test_reset_token_issued_during_a_password_change_does_not_outlive_it(
    race_app: FastAPI,
    issuer: PasswordResetIssuer,
    held_renderer: HeldRenderer,
    victim: User,
    maker: sessionmaker[Session],
) -> None:
    owner = _client(race_app, "203.0.113.31")
    assert owner.login(victim.email, ORIGINAL).status_code == 200
    issuing = _start_held_issue(issuer, held_renderer, victim)

    responses: list[httpx.Response] = []
    changing = threading.Thread(
        target=lambda: responses.append(
            owner.post(
                "/auth/change-password", json={"current_password": ORIGINAL, "new_password": VICTIM_CHANGED}
            )
        )
    )
    changing.start()
    try:
        waited = _blocked_on_a_lock(maker, changing)
    finally:
        held_renderer.release.set()
        issuing.join(timeout=30)
        changing.join(timeout=30)
    assert not issuing.is_alive() and not changing.is_alive()
    assert responses[0].status_code == 204
    # The change ran after the issue committed, so its invalidation covered the new token (§4).
    assert _usable_tokens(maker, victim) == 0
    assert waited, "the password change did not wait for the issue's user row lock"


# ---- login racing the deactivation of its company (Phase 11, B11-10) --------------------------------

PLATFORM_PASSWORD = "Platform-Quartz-Lantern-61"


def test_a_sign_in_that_verified_the_password_cannot_outlive_its_company_s_deactivation(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    with maker() as db:
        owner = PlatformAdmin(
            email=f"{unique('owner')}@platform.example",
            full_name="Race Owner",
            password_hash=gate.hash(PLATFORM_PASSWORD),
        )
        db.add(owner)
        db.commit()
        owner_email = owner.email
    platform = PlatformApi(
        TestClient(race_app, base_url="https://testserver", client=("203.0.113.30", 50000))
    )
    assert platform.login(owner_email, PLATFORM_PASSWORD).status_code == 200
    signer = _client(race_app, "198.51.100.70")

    def deactivate() -> None:
        response = platform.post(f"/platform/companies/{victim.company_id}/deactivate")
        assert response.status_code == 200, response.text

    response = _while_held(gate, lambda: signer.login(victim.email, ORIGINAL), deactivate)

    # The password had verified: the sign-in that lost the race is told why (B11-46), and has no session.
    assert response.status_code == 409 and response.json()["error"]["code"] == "COMPANY_INACTIVE"
    assert "set-cookie" not in response.headers
    assert signer.get("/auth/me").status_code == 401
    assert _live_sessions(maker, victim) == 0
    with maker() as db:
        reasons = [
            row.meta.get("reason")
            for row in db.scalars(
                select(AuditLog)
                .where(AuditLog.action == "AUTH_LOGIN_FAILED", AuditLog.entity_id == victim.id)
                .order_by(AuditLog.seq)
            )
        ]
    assert reasons == ["company_inactive"]


# ---- a reset link issued while its company is being deactivated (B11-39) ----------------------------


def _platform_owner(maker: sessionmaker[Session], gate: OneShotGate) -> str:
    with maker() as db:
        owner = PlatformAdmin(
            email=f"{unique('owner')}@platform.example",
            full_name="Race Owner",
            password_hash=gate.hash(PLATFORM_PASSWORD),
        )
        db.add(owner)
        db.commit()
        return owner.email


def _platform_api(race_app: FastAPI, cookies: dict[str, str] | None = None, port: int = 50000) -> PlatformApi:
    return PlatformApi(
        TestClient(race_app, base_url="https://testserver", client=("203.0.113.30", port), cookies=cookies)
    )


def _platform_signed_in(race_app: FastAPI, maker: sessionmaker[Session], gate: OneShotGate) -> PlatformApi:
    platform = _platform_api(race_app)
    assert platform.login(_platform_owner(maker, gate), PLATFORM_PASSWORD).status_code == 200
    return platform


def test_a_reset_link_issued_during_a_deactivation_does_not_outlive_it(
    race_app: FastAPI,
    gate: OneShotGate,
    issuer: PasswordResetIssuer,
    held_renderer: HeldRenderer,
    victim: User,
    maker: sessionmaker[Session],
) -> None:
    # The finding: the request had written its token but not committed when the deactivation
    # invalidated the company's links, so the token stayed usable and worked after a reactivation.
    platform = _platform_signed_in(race_app, maker, gate)
    issuing = _start_held_issue(issuer, held_renderer, victim)

    responses: list[httpx.Response] = []
    deactivating = threading.Thread(
        target=lambda: responses.append(platform.post(f"/platform/companies/{victim.company_id}/deactivate"))
    )
    deactivating.start()
    try:
        waited = _blocked_on_a_lock(maker, deactivating)
    finally:
        held_renderer.release.set()
        issuing.join(timeout=30)
        deactivating.join(timeout=30)
    assert not issuing.is_alive() and not deactivating.is_alive()
    assert responses[0].status_code == 200 and responses[0].json()["is_active"] is False
    # The deactivation ran after the issue committed, so its invalidation covered the new token.
    assert _usable_tokens(maker, victim) == 0
    assert waited, "the deactivation did not wait for the issue's lock on the company row"
    assert platform.post(f"/platform/companies/{victim.company_id}/reactivate").status_code == 200
    assert _usable_tokens(maker, victim) == 0  # a reactivation revives nothing


def test_a_reset_request_that_meets_a_deactivation_in_flight_issues_nothing(
    issuer: PasswordResetIssuer, victim: User, maker: sessionmaker[Session]
) -> None:
    # The other order: the deactivation holds the company row and has not committed. The request must
    # wait for it and then find the company deactivated, instead of reading the row as it was before.
    jobs: list[object] = []
    issuing = threading.Thread(target=lambda: jobs.append(issuer.issue(victim.email, ISSUE_CONTEXT)))
    with maker() as deactivating:
        # As the deactivation does: the row FOR UPDATE first, then the change.
        deactivating.execute(
            text("SELECT id FROM companies WHERE id = :id FOR UPDATE"), {"id": victim.company_id}
        )
        deactivating.execute(
            text("UPDATE companies SET is_active = false, deactivated_at = :now WHERE id = :id"),
            {"now": app_time.now(), "id": victim.company_id},
        )
        issuing.start()
        try:
            waited = _blocked_on_a_lock(maker, issuing)
        finally:
            deactivating.commit()
            issuing.join(timeout=30)
    assert not issuing.is_alive()
    assert jobs == [None]  # no e-mail
    assert _usable_tokens(maker, victim) == 0
    assert waited, "the issue did not wait for the deactivation's lock on the company row"


# ---- a platform write in flight when its session ends (B11-38) -------------------------------------

ADMIN_BODY = {"full_name": "Late Admin", "temporary_password": "Tmp-Kiwi-Lantern-2026"}


def _company_admin(maker: sessionmaker[Session], gate: OneShotGate, company_id) -> User:
    with maker() as db:
        admin = User(
            company_id=company_id,
            full_name="Race Admin",
            email=f"{unique('admin')}@example.com",
            password_hash=gate.hash(ORIGINAL),
            roles=[Role.SYSTEM_ADMIN.value],
        )
        db.add(admin)
        db.commit()
        return admin


def _company_state(maker: sessionmaker[Session], company_id) -> tuple[str, bool, int, int, int]:
    """What a platform write can change: the company's name and activity, its users, its reset links and
    its audit rows."""
    with maker() as db:
        company = db.get(Company, company_id)
        assert company is not None
        users = db.scalars(select(User.id).where(User.company_id == company_id)).all()
        tokens = db.scalars(select(PasswordResetToken.id).where(PasswordResetToken.user_id.in_(users))).all()
        rows = db.scalars(select(AuditLog.id).where(AuditLog.company_id == company_id)).all()
        return company.name, company.is_active, len(users), len(tokens), len(rows)


@pytest.mark.parametrize("write", ["deactivate", "rename", "reset_link", "add_admin"])
def test_a_platform_write_that_waited_for_the_company_stops_when_its_session_has_ended(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session], write: str
) -> None:
    # The finding: the request waited for the company row; meanwhile its session was ended (a sign-out
    # in another tab, a password reset by the operator). Once the row was free it carried on and
    # answered 200.
    company_id = victim.company_id
    admin = _company_admin(maker, gate, company_id)
    platform = _platform_signed_in(race_app, maker, gate)
    owner_id = platform.get("/platform/auth/me").json()["admin"]["id"]
    other_tab = _platform_api(race_app, dict(platform.client.cookies), port=50001)
    base = f"/platform/companies/{company_id}"
    requests = {
        "deactivate": lambda: platform.post(f"{base}/deactivate"),
        "rename": lambda: platform.patch(base, json={"name": "Renamed Too Late"}),
        "reset_link": lambda: platform.post(f"{base}/admins/{admin.id}/password-reset"),
        "add_admin": lambda: platform.post(
            f"{base}/admins", json={**ADMIN_BODY, "email": f"{unique('late')}@example.com"}
        ),
    }
    before = _company_state(maker, company_id)
    responses: list[httpx.Response] = []
    writing = threading.Thread(target=lambda: responses.append(requests[write]()))
    with maker() as holder:
        holder.execute(text("SELECT id FROM companies WHERE id = :id FOR UPDATE"), {"id": company_id})
        writing.start()
        try:
            assert _blocked_on_a_lock(maker, writing), "the write did not wait for the company row"
            assert other_tab.post("/platform/auth/logout").status_code == 204
        finally:
            holder.rollback()
            writing.join(timeout=30)
    assert not writing.is_alive()
    assert responses[0].status_code == 401, responses[0].text
    assert responses[0].json()["error"]["code"] == "NOT_AUTHENTICATED"
    assert _company_state(maker, company_id) == before  # nothing was written
    with maker() as db:  # the refusal is on record in the platform's trail
        denials = db.scalars(
            select(PlatformAuditLog).where(
                PlatformAuditLog.action == "ACCESS_DENIED",
                PlatformAuditLog.actor_platform_admin_id == uuid.UUID(owner_id),
            )
        ).all()
    assert [row.meta for row in denials] == [{"reason": "session_ended"}]


@pytest.mark.parametrize("write", ["create_company", "add_admin"])
def test_a_platform_creation_in_flight_stops_when_its_session_has_ended(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session], write: str
) -> None:
    # A creation spends its time hashing the temporary password; the session ends meanwhile.
    platform = _platform_signed_in(race_app, maker, gate)
    other_tab = _platform_api(race_app, dict(platform.client.cookies), port=50001)
    slug = unique("late")
    address = f"{unique('late')}@example.com"
    requests = {
        "create_company": lambda: platform.post(
            "/platform/companies",
            json={
                "name": "Late Co",
                "slug": slug,
                "timezone": "Asia/Amman",
                "default_language": "en",
                "admin": {**ADMIN_BODY, "email": address},
            },
        ),
        "add_admin": lambda: platform.post(
            f"/platform/companies/{victim.company_id}/admins", json={**ADMIN_BODY, "email": address}
        ),
    }

    def sign_out() -> None:
        assert other_tab.post("/platform/auth/logout").status_code == 204

    response = _while_held(gate, requests[write], sign_out, hashing=True)

    assert response.status_code == 401, response.text
    with maker() as db:
        assert db.scalars(select(Company.id).where(Company.slug == slug)).first() is None
        assert db.scalars(select(User.id).where(User.email == address)).first() is None


def test_a_sign_out_waits_for_a_platform_write_that_passed_its_re_check(
    race_app: FastAPI, gate: OneShotGate, victim: User, maker: sessionmaker[Session]
) -> None:
    # The third order: the write has re-checked its caller and has not committed yet. Its session cannot
    # be ended under it: the re-check holds the session row `FOR SHARE`, so the sign-out waits for the
    # write's commit. With a re-check that only read the row, the sign-out answered at once and the write
    # committed after its session had ended.
    company_id = victim.company_id
    admin = _company_admin(maker, gate, company_id)
    platform = _platform_signed_in(race_app, maker, gate)
    owner_id = uuid.UUID(platform.get("/platform/auth/me").json()["admin"]["id"])
    other_tab = _platform_api(race_app, dict(platform.client.cookies), port=50001)
    written: list[httpx.Response] = []
    signed_out: list[httpx.Response] = []
    writing = threading.Thread(
        target=lambda: written.append(
            platform.post(f"/platform/companies/{company_id}/admins/{admin.id}/password-reset")
        )
    )
    signing_out = threading.Thread(target=lambda: signed_out.append(other_tab.post("/platform/auth/logout")))
    with maker() as holder:
        # The write locks the administrator's row after its re-check (to invalidate the older links):
        # with that row held here, it waits between its re-check and its commit.
        holder.execute(text("SELECT id FROM users WHERE id = :id FOR UPDATE"), {"id": admin.id})
        writing.start()
        try:
            assert _blocked_on_a_lock(maker, writing), "the write did not wait for the administrator's row"
            signing_out.start()
            sign_out_waited = _blocked_on_a_lock(maker, signing_out, timeout=10.0, waiters=2)
            answered_under_the_write = [response.status_code for response in signed_out]
        finally:
            holder.rollback()
            writing.join(timeout=30)
            signing_out.join(timeout=30)
    assert not writing.is_alive() and not signing_out.is_alive()
    assert answered_under_the_write == [], "the session was ended under a write that had passed its re-check"
    assert sign_out_waited, "the sign-out did not wait for the write's lock on the session row"
    assert written[0].status_code == 202, written[0].text  # committed while its session was live
    assert signed_out[0].status_code == 204  # and only then the session ended
    with maker() as db:
        actions = db.scalars(
            select(PlatformAuditLog.action)
            .where(PlatformAuditLog.actor_platform_admin_id == owner_id)
            .order_by(PlatformAuditLog.seq)
        ).all()
    assert actions[-2:] == ["AUTH_PASSWORD_RESET_REQUESTED", "AUTH_LOGOUT"]
    assert platform.get("/platform/auth/me").status_code == 401
