"""Throttles under concurrency (contract §7.1/§7.3: rate-limit checks happen before any hashing).

Every password verification is held at a gate until the test releases it, so all attempts are in flight
at the same time. A check-then-record limiter lets every one of them reach the verification; a limiter
that reserves the attempt atomically lets through only as many as the limit allows.
"""

import threading
import uuid
from collections import Counter
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import create_db_engine, make_sessionmaker, session_factory
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import AuditLog, Company, Role, User
from app.security.passwords import Argon2Parameters, PasswordHasherService
from tests.support import API, unique

pytestmark = pytest.mark.committed

ATTEMPTS = 30
WRONG_PASSWORD = "Wrong-Password-123"
FAST_ARGON2 = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)


class GatedHasher(PasswordHasherService):
    """Counts verifications and holds each one until `release` is set."""

    def __init__(self) -> None:
        super().__init__(FAST_ARGON2, max_concurrency=ATTEMPTS + 5, acquire_timeout_seconds=30)
        self.condition = threading.Condition()
        self.entered = 0
        self.release = threading.Event()

    def verify(self, password_hash: str, password: str) -> bool:
        with self.condition:
            self.entered += 1
            self.condition.notify_all()
        if not self.release.wait(timeout=30):
            raise TimeoutError("verification gate was never released")
        return super().verify(password_hash, password)


@pytest.fixture
def roomy_engine(committed_settings: Settings) -> Iterator[Engine]:
    # Enough connections that the pool never limits how many attempts are in flight.
    engine = create_db_engine(
        committed_settings.runtime_url, pool_size=ATTEMPTS + 5, application_name="vms-tests-gate"
    )
    yield engine
    engine.dispose()


@pytest.fixture
def committed_maker(roomy_engine: Engine) -> Iterator[sessionmaker[Session]]:
    """Real, separately committing sessions for the requests, the audit writer and the test itself."""
    maker = make_sessionmaker(roomy_engine)
    session_factory.override(maker)
    try:
        yield maker
    finally:
        session_factory.clear_override()


@pytest.fixture
def gated() -> GatedHasher:
    return GatedHasher()


@pytest.fixture
def gated_app(committed_settings: Settings, roomy_engine: Engine, gated: GatedHasher) -> FastAPI:
    return create_app(
        committed_settings, engine=roomy_engine, password_hasher=gated, email_provider=MemoryProvider()
    )


@pytest.fixture
def account(committed_maker: sessionmaker[Session], hasher: PasswordHasherService) -> User:
    with committed_maker() as db:
        company = Company(name="Gate Co", slug=unique("gate"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        user = User(
            company_id=company.id,
            full_name="Gate User",
            email=f"{unique('gate')}@example.com",
            password_hash=hasher.hash("Committed-Password-1"),
            roles=[Role.EMPLOYEE.value],
        )
        db.add(user)
        db.commit()
        return user


def _run_concurrently(app: FastAPI, gated: GatedHasher, calls: list[tuple[tuple[str, int], dict]]) -> Counter:
    """POST every login at once; release the gate once each call is either verifying or answered."""
    statuses: list[int] = []

    def attempt(client_address: tuple[str, int], body: dict) -> None:
        client = TestClient(app, base_url="https://testserver", client=client_address)
        try:
            status = client.post(f"{API}/auth/login", json=body).status_code
        except Exception:  # surfaced through the status counter
            status = -1
        with gated.condition:
            statuses.append(status)
            gated.condition.notify_all()

    threads = [threading.Thread(target=attempt, args=call) for call in calls]
    for thread in threads:
        thread.start()
    try:
        with gated.condition:
            settled = gated.condition.wait_for(
                lambda: gated.entered + len(statuses) >= len(calls), timeout=30
            )
    finally:
        gated.release.set()
        for thread in threads:
            thread.join(timeout=30)
    assert settled, "attempts neither reached the verification nor were answered"
    assert not any(thread.is_alive() for thread in threads)
    return Counter(statuses)


def _audit_count(maker: sessionmaker[Session], action: str, user_id: uuid.UUID) -> int:
    with maker() as db:
        rows = db.scalars(
            select(AuditLog.id).where(AuditLog.action == action, AuditLog.actor_user_id == user_id)
        )
        return len(rows.all())


def test_parallel_failures_from_one_ip_cannot_exceed_the_ip_email_limit(
    gated_app: FastAPI, gated: GatedHasher, account: User
) -> None:
    body = {"email": account.email, "password": WRONG_PASSWORD}
    statuses = _run_concurrently(gated_app, gated, [(("203.0.113.90", 40000), body)] * ATTEMPTS)

    assert gated.entered == 5  # login failures per (IP, e-mail): 5 / 5 min
    assert statuses == Counter({401: 5, 429: ATTEMPTS - 5})


def test_parallel_failures_from_many_ips_cannot_exceed_the_account_limit(
    gated_app: FastAPI,
    gated: GatedHasher,
    account: User,
    committed_maker: sessionmaker[Session],
) -> None:
    body = {"email": account.email, "password": WRONG_PASSWORD}
    calls = [((f"198.51.100.{index + 1}", 40000), body) for index in range(ATTEMPTS)]
    statuses = _run_concurrently(gated_app, gated, calls)

    assert gated.entered == 10  # login failures per account: 10 / 15 min, then locked out
    assert statuses == Counter({401: 10, 429: ATTEMPTS - 10})
    assert _audit_count(committed_maker, "AUTH_ACCOUNT_THROTTLED", account.id) == 1
