"""Two administrators naming departments at the same moment, on real, separately committing connections
(B10-29: no value of a department, name or Arabic name, is a value of another department of the company).

No unique index backs that rule across the two languages (rows written before it may already break it), so
the service checks it,
and every department change that names a department holds the company row `FOR UPDATE`. The first
request is held inside its transaction, after its check and its insert and before its commit; the second
must then wait for the company row, and once the first commits it sees the new department and answers 409.
Under the earlier `FOR KEY SHARE` the second request ran beside the first, passed its check and committed:
two departments read the same.
"""

import threading
import time
from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import create_db_engine, make_sessionmaker, session_factory
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import Company, Department, Role, User
from app.repositories.departments import DepartmentRepository
from app.security.passwords import Argon2Parameters, PasswordHasherService
from tests.support import DEFAULT_PASSWORD, Api, unique

pytestmark = pytest.mark.committed

APPLICATION_NAME = "vms-tests-department-race"
FAST_ARGON2 = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)


class InsertGate:
    """Holds the next department write (`DepartmentRepository.add`, after its flush), once armed, until the
    test releases it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._armed = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def arm(self) -> None:
        with self._lock:
            self._armed = True

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        original = DepartmentRepository.add

        def add(repository: DepartmentRepository, department: Department) -> Department:
            result = original(repository, department)
            with self._lock:
                gated, self._armed = self._armed, False
            if gated:
                self.entered.set()
                if not self.release.wait(timeout=30):
                    raise TimeoutError("the department gate was never released")
            return result

        monkeypatch.setattr(DepartmentRepository, "add", add)


@pytest.fixture
def engine(committed_settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(committed_settings.runtime_url, pool_size=4, application_name=APPLICATION_NAME)
    yield engine
    engine.dispose()


@pytest.fixture
def maker(engine: Engine) -> Iterator[sessionmaker[Session]]:
    committed = make_sessionmaker(engine)
    session_factory.override(committed)
    try:
        yield committed
    finally:
        session_factory.clear_override()


@pytest.fixture
def race_app(committed_settings: Settings, engine: Engine, maker: sessionmaker[Session]) -> FastAPI:
    hasher = PasswordHasherService(FAST_ARGON2, max_concurrency=4)
    return create_app(
        committed_settings, engine=engine, password_hasher=hasher, email_provider=MemoryProvider()
    )


@pytest.fixture
def scenario(maker: sessionmaker[Session]) -> dict[str, object]:
    """A company with two administrators and a department "Legal" without an Arabic name."""
    hasher = PasswordHasherService(FAST_ARGON2, max_concurrency=1)
    with maker() as db:
        company = Company(name="Race Co", slug=unique("dept-race"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        admins = [
            User(
                company_id=company.id,
                full_name=f"Admin {index}",
                email=f"{unique('dept-admin')}@example.com",
                password_hash=hasher.hash(DEFAULT_PASSWORD),
                roles=[Role.SYSTEM_ADMIN.value],
            )
            for index in (1, 2)
        ]
        legal = Department(company_id=company.id, name="Legal")
        db.add_all([*admins, legal])
        db.commit()
        return {"company": company, "admins": admins, "legal": legal}


def _signed_in(app: FastAPI, user: User, address: str) -> Api:
    api = Api(TestClient(app, base_url="https://testserver", client=(address, 50000)))
    assert api.login(user.email).status_code == 200
    return api


def _waits_for_a_lock(maker: sessionmaker[Session], worker: threading.Thread, timeout: float = 10) -> bool:
    deadline = time.monotonic() + timeout
    with maker() as observer:
        while time.monotonic() < deadline and worker.is_alive():
            waiting = observer.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE application_name = :name AND wait_event_type = 'Lock'"
                ),
                {"name": APPLICATION_NAME},
            ).scalar_one()
            observer.rollback()
            if waiting:
                return True
            time.sleep(0.02)
    return False


def _race(
    gate: InsertGate,
    maker: sessionmaker[Session],
    first: Callable[[], httpx.Response],
    second: Callable[[], httpx.Response],
) -> tuple[httpx.Response, httpx.Response]:
    """Hold `first` after its write, start `second` until it waits for a lock, then let both finish."""
    responses: dict[str, httpx.Response] = {}
    failures: list[BaseException] = []

    def run(key: str, request: Callable[[], httpx.Response]) -> None:
        try:
            responses[key] = request()
        except BaseException as exc:  # surfaced below
            failures.append(exc)

    gate.arm()
    holder = threading.Thread(target=run, args=("first", first))
    holder.start()
    waiter: threading.Thread | None = None
    try:
        assert gate.entered.wait(timeout=30), "the first request never wrote its department"
        waiter = threading.Thread(target=run, args=("second", second))
        waiter.start()
        assert _waits_for_a_lock(maker, waiter), "the second request ran beside the first"
    finally:
        gate.release.set()
        holder.join(timeout=30)
        if waiter is not None:
            waiter.join(timeout=30)
    assert not holder.is_alive() and (waiter is None or not waiter.is_alive())
    if failures:
        raise failures[0]
    return responses["first"], responses["second"]


def _named(maker: sessionmaker[Session], company: Company, value: str) -> int:
    """How many departments of the company have `value` as their name or their Arabic name."""
    with maker() as db:
        return len(DepartmentRepository(db).named(company.id, value))


@pytest.mark.parametrize(
    ("first", "second", "field", "label"),
    [
        (
            lambda legal: ("post", "/departments", {"name": "IT", "name_ar": "تقنية المعلومات"}),
            lambda legal: ("post", "/departments", {"name": "تقنية المعلومات"}),
            "name",
            "تقنية المعلومات",
        ),
        (
            lambda legal: ("post", "/departments", {"name": "Finance"}),
            lambda legal: ("patch", f"/departments/{legal.id}", {"name_ar": "Finance"}),
            "name_ar",
            "Finance",
        ),
        (
            lambda legal: ("post", "/departments", {"name": "Operations", "name_ar": "العمليات"}),
            lambda legal: ("post", "/departments", {"name": "العمليات", "name_ar": "Operations"}),
            "name",
            "العمليات",
        ),
    ],
    ids=["create-beside-create", "rename-beside-create", "swapped-names"],
)
def test_two_administrators_cannot_give_two_departments_one_name(
    race_app: FastAPI,
    scenario: dict[str, object],
    maker: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    first: Callable[[Department], tuple[str, str, dict[str, object]]],
    second: Callable[[Department], tuple[str, str, dict[str, object]]],
    field: str,
    label: str,
) -> None:
    admins = scenario["admins"]
    legal = scenario["legal"]
    company = scenario["company"]
    assert isinstance(admins, list) and isinstance(legal, Department) and isinstance(company, Company)
    one = _signed_in(race_app, admins[0], "203.0.113.51")
    two = _signed_in(race_app, admins[1], "203.0.113.52")
    gate = InsertGate()
    gate.install(monkeypatch)
    method_one, path_one, body_one = first(legal)
    method_two, path_two, body_two = second(legal)
    created, refused = _race(
        gate,
        maker,
        lambda: getattr(one, method_one)(path_one, json=body_one),
        lambda: getattr(two, method_two)(path_two, json=body_two),
    )
    assert created.status_code == 201, created.text
    assert refused.status_code == 409, refused.text
    assert refused.json()["error"]["details"] == {"field": field}
    assert _named(maker, company, label) == 1
    with maker() as db:
        stored = db.get(Department, legal.id)
        assert stored is not None and (stored.name, stored.name_ar) == ("Legal", None)
