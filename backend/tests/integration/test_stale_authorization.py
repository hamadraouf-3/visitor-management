"""A request authorized before a deactivation or demotion, and waiting behind it, does not run after it
(SEC-07, contract §7.2 "immediate revocation"), on real, separately committing connections.

The defender's transaction (the deactivation or demotion: the company row `FOR UPDATE`, the user row
changed, the sessions revoked) is held open while the attacker's request, already authenticated, waits
for the company row; then it commits and the attacker's request continues. Before the fix the request
carried on with the authority it had when it started: it reactivated the deactivated administrator,
promoted another account to SYSTEM_ADMIN, or changed the company settings. Creating an account (a new
SYSTEM_ADMIN that outlives the revocation), a department or a visitor did the same until SEC-31.

Every scenario runs twice: on the committed tests' database, and on one whose default isolation level is
REPEATABLE READ (`ALTER DATABASE … SET default_transaction_isolation`, SEC-37). There the re-check used to
read a snapshot taken before the wait, so the revoked authority still looked current; every connection
now runs READ COMMITTED whatever the default (`app.db.session.SESSION_SETTINGS`).
"""

import threading
import time
from collections.abc import Callable, Iterator
from datetime import timedelta

import httpx
import pytest
from alembic import command
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core import time as app_time
from app.core.config import Settings
from app.db.session import create_db_engine, make_sessionmaker, session_factory
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import AuditLog, Company, Department, Role, User, Visit, Visitor
from app.security.passwords import Argon2Parameters, PasswordHasherService
from tests.conftest import _test_settings
from tests.support import DEFAULT_PASSWORD, Api, ThrowawayDatabase, alembic_config, unique, visit_body

pytestmark = pytest.mark.committed

APPLICATION_NAME = "vms-tests-stale-auth"
FAST_ARGON2 = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)
TEMPORARY_PASSWORD = "Vt7qLm2-Rx9wZp-Kd4"


@pytest.fixture(scope="session")
def repeatable_read_settings(create_database: Callable[[str], ThrowawayDatabase]) -> Settings:
    """A migrated database whose default isolation level is REPEATABLE READ (a DBA's or a hardening
    baseline's choice, SEC-37)."""
    database = create_database("vms_repeatable_read")
    command.upgrade(alembic_config(database), "head")
    owner = create_engine(database.owner_url, isolation_level="AUTOCOMMIT", poolclass=NullPool)
    try:
        with owner.connect() as connection:
            setting = "default_transaction_isolation = 'repeatable read'"
            connection.execute(text(f'ALTER DATABASE "{database.name}" SET {setting}'))
    finally:
        owner.dispose()
    return _test_settings(database)


@pytest.fixture(params=["default-isolation", "repeatable-read-default"])
def stale_settings(request: pytest.FixtureRequest, committed_settings: Settings) -> Settings:
    if request.param == "default-isolation":
        return committed_settings
    settings: Settings = request.getfixturevalue("repeatable_read_settings")
    return settings


@pytest.fixture
def engine(stale_settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(stale_settings.runtime_url, pool_size=4, application_name=APPLICATION_NAME)
    yield engine
    engine.dispose()


@pytest.fixture
def defender_engine(stale_settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(stale_settings.runtime_url, pool_size=1, application_name="vms-tests-defender")
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
def stale_app(stale_settings: Settings, engine: Engine, maker: sessionmaker[Session]) -> FastAPI:
    hasher = PasswordHasherService(FAST_ARGON2, max_concurrency=4)
    return create_app(stale_settings, engine=engine, password_hasher=hasher, email_provider=MemoryProvider())


@pytest.fixture
def people(maker: sessionmaker[Session]) -> dict[str, User]:
    hasher = PasswordHasherService(FAST_ARGON2, max_concurrency=1)
    with maker() as db:
        company = Company(name="Stale Co", slug=unique("stale"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        users = {}
        for name, roles in (
            ("attacker", [Role.SYSTEM_ADMIN]),
            ("defender", [Role.SYSTEM_ADMIN]),
            ("puppet", [Role.EMPLOYEE]),
            ("host", [Role.EMPLOYEE]),
        ):
            users[name] = User(
                company_id=company.id,
                full_name=f"{name.title()} Person",
                email=f"{unique(name)}@example.com",
                password_hash=hasher.hash(DEFAULT_PASSWORD),
                roles=[role.value for role in roles],
            )
            db.add(users[name])
        db.commit()
        return users


def _signed_in(app: FastAPI, user: User) -> Api:
    api = Api(TestClient(app, base_url="https://testserver", client=("203.0.113.40", 50000)))
    assert api.login(user.email).status_code == 200
    return api


def _deactivate(connection: Connection, user: User) -> None:
    """What `UsersService.update_user` does for a deactivation, in the same lock order."""
    connection.execute(text("SELECT id FROM companies WHERE id = :c FOR UPDATE"), {"c": user.company_id})
    connection.execute(text("UPDATE users SET is_active = false WHERE id = :u"), {"u": user.id})
    connection.execute(
        text("UPDATE user_sessions SET revoked_at = :now WHERE user_id = :u AND revoked_at IS NULL"),
        {"u": user.id, "now": app_time.now()},
    )


def _demote(connection: Connection, user: User, roles: list[str]) -> None:
    connection.execute(text("SELECT id FROM companies WHERE id = :c FOR UPDATE"), {"c": user.company_id})
    connection.execute(text("UPDATE users SET roles = :r WHERE id = :u"), {"u": user.id, "r": roles})


def _behind(
    defender_engine: Engine,
    maker: sessionmaker[Session],
    revoke: Callable[[Connection], None],
    request: Callable[[], httpx.Response],
) -> httpx.Response:
    """Hold the revocation open, start `request` until it waits for the company row, then commit the
    revocation and let the request finish. Returns its response."""
    responses: list[httpx.Response] = []
    with defender_engine.connect() as connection:
        transaction = connection.begin()
        revoke(connection)
        worker = threading.Thread(target=lambda: responses.append(request()))
        worker.start()
        try:
            assert _waits_for_a_lock(maker, worker), "the request never waited behind the revocation"
        finally:
            transaction.commit()
        worker.join(timeout=30)
    assert not worker.is_alive() and responses
    return responses[0]


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


def _user(maker: sessionmaker[Session], user: User) -> User:
    with maker() as db:
        found = db.get(User, user.id)
        assert found is not None
        return found


def _actions_by(maker: sessionmaker[Session], user: User) -> list[str]:
    with maker() as db:
        rows = db.scalars(select(AuditLog.action).where(AuditLog.actor_user_id == user.id))
        return list(rows)


def test_a_deactivated_administrator_cannot_reactivate_themselves(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    attacker = _signed_in(stale_app, people["attacker"])
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _deactivate(connection, people["attacker"]),
        lambda: attacker.patch(f"/users/{people['attacker'].id}", json={"is_active": True}),
    )
    assert response.status_code == 401 and response.json()["error"]["code"] == "NOT_AUTHENTICATED"
    assert _user(maker, people["attacker"]).is_active is False
    assert "USER_REACTIVATED" not in _actions_by(maker, people["attacker"])
    assert "ACCESS_DENIED" in _actions_by(maker, people["attacker"])
    retry = Api(TestClient(stale_app, base_url="https://testserver", client=("203.0.113.41", 50000)))
    assert retry.login(people["attacker"].email).status_code == 401


def test_a_deactivated_administrator_cannot_promote_another_account(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    attacker = _signed_in(stale_app, people["attacker"])
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _deactivate(connection, people["attacker"]),
        lambda: attacker.patch(f"/users/{people['puppet'].id}", json={"roles": ["EMPLOYEE", "SYSTEM_ADMIN"]}),
    )
    assert response.status_code == 401
    assert _user(maker, people["puppet"]).roles == ["EMPLOYEE"]
    assert "USER_ROLES_CHANGED" not in _actions_by(maker, people["attacker"])


@pytest.mark.parametrize(
    "change",
    [
        lambda people: ("patch", "/company/settings", {"allow_walk_ins": False}),
        lambda people: ("patch", f"/users/{people['attacker'].id}", {"roles": ["EMPLOYEE", "SYSTEM_ADMIN"]}),
    ],
    ids=["company-settings", "re-promote-self"],
)
def test_a_demoted_administrator_cannot_finish_an_administrative_change(
    stale_app: FastAPI,
    people: dict[str, User],
    defender_engine: Engine,
    maker: sessionmaker[Session],
    change: Callable[[dict[str, User]], tuple[str, str, dict[str, object]]],
) -> None:
    attacker = _signed_in(stale_app, people["attacker"])
    method, path, body = change(people)
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _demote(connection, people["attacker"], ["EMPLOYEE"]),
        lambda: getattr(attacker, method)(path, json=body),
    )
    assert response.status_code == 403 and response.json()["error"]["code"] == "FORBIDDEN"
    assert _user(maker, people["attacker"]).roles == ["EMPLOYEE"]
    with maker() as db:
        company = db.get(Company, people["attacker"].company_id)
        assert company is not None and company.allow_walk_ins is True
    actions = _actions_by(maker, people["attacker"])
    assert "COMPANY_SETTINGS_UPDATED" not in actions and "USER_ROLES_CHANGED" not in actions


def test_a_visit_change_waiting_for_its_hosts_deactivation_is_refused(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    host = _signed_in(stale_app, people["host"])
    start = app_time.now() + timedelta(days=1)
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _deactivate(connection, people["host"]),
        lambda: host.post("/visits", json=visit_body(people["host"].id, start)),
    )
    assert response.status_code == 401
    with maker() as db:
        assert db.scalars(select(Visit.id).where(Visit.created_by_id == people["host"].id)).all() == []


def test_an_unrelated_role_change_of_someone_else_does_not_refuse_the_caller(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    attacker = _signed_in(stale_app, people["attacker"])
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _demote(connection, people["defender"], ["SYSTEM_ADMIN", "MANAGEMENT"]),
        lambda: attacker.patch("/company/settings", json={"allow_walk_ins": False}),
    )
    assert response.status_code == 200


def test_connections_run_read_committed_whatever_the_default(engine: Engine) -> None:
    with engine.connect() as connection:
        assert connection.execute(text("SHOW transaction_isolation")).scalar_one() == "read committed"


def test_two_administrators_demoting_each_other_keep_one(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    """The defender demotes the attacker while the attacker's request demotes the defender (the only two
    administrators). Under a REPEATABLE READ default both used to succeed: the company had no
    administrator left (LAST_ADMIN read the same stale snapshot)."""
    attacker = _signed_in(stale_app, people["attacker"])
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _demote(connection, people["attacker"], ["EMPLOYEE"]),
        lambda: attacker.patch(f"/users/{people['defender'].id}", json={"roles": ["EMPLOYEE"]}),
    )
    assert response.status_code == 403
    assert _user(maker, people["defender"]).roles == ["SYSTEM_ADMIN"]


# ---- creations wait for the revocation too (SEC-31) ----------------------------------------------


def _new_admin_body() -> dict[str, object]:
    return {
        "full_name": "Backdoor Admin",
        "email": f"{unique('backdoor')}@example.com",
        "roles": ["SYSTEM_ADMIN"],
        "temporary_password": TEMPORARY_PASSWORD,
    }


def _users_with_email(maker: sessionmaker[Session], email: object) -> list[User]:
    with maker() as db:
        return list(db.scalars(select(User).where(User.email == email)))


@pytest.mark.parametrize(
    ("revoke", "status"),
    [
        (lambda people: lambda connection: _deactivate(connection, people["attacker"]), 401),
        (lambda people: lambda connection: _demote(connection, people["attacker"], ["EMPLOYEE"]), 403),
    ],
    ids=["deactivated", "demoted"],
)
def test_a_revoked_administrator_cannot_create_an_administrator(
    stale_app: FastAPI,
    people: dict[str, User],
    defender_engine: Engine,
    maker: sessionmaker[Session],
    revoke: Callable[[dict[str, User]], Callable[[Connection], None]],
    status: int,
) -> None:
    """The finding: an in-flight POST /users of an administrator who is deactivated (or demoted) meanwhile
    created a new SYSTEM_ADMIN after the defender's 200, a working login that outlives the revocation."""
    attacker = _signed_in(stale_app, people["attacker"])
    body = _new_admin_body()
    response = _behind(defender_engine, maker, revoke(people), lambda: attacker.post("/users", json=body))
    assert response.status_code == status, response.text
    assert _users_with_email(maker, body["email"]) == []
    actions = _actions_by(maker, people["attacker"])
    assert "USER_CREATED" not in actions and "ACCESS_DENIED" in actions


def test_a_deactivated_administrator_cannot_create_or_change_departments(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    with maker() as db:
        department = Department(company_id=people["attacker"].company_id, name=unique("Finance"))
        db.add(department)
        db.commit()
    for request in (
        lambda api: api.post("/departments", json={"name": unique("Shadow IT")}),
        lambda api: api.patch(f"/departments/{department.id}", json={"name": "Renamed by a revoked admin"}),
    ):
        attacker = _signed_in(stale_app, people["attacker"])
        response = _behind(
            defender_engine,
            maker,
            lambda connection: _deactivate(connection, people["attacker"]),
            lambda request=request, attacker=attacker: request(attacker),
        )
        assert response.status_code == 401, response.text
        with maker() as db:
            db.execute(text("UPDATE users SET is_active = true WHERE id = :u"), {"u": people["attacker"].id})
            db.commit()
    with maker() as db:
        names = db.scalars(select(Department.name).where(Department.company_id == department.company_id))
        assert set(names) == {department.name}
    assert "DEPARTMENT_CREATED" not in _actions_by(maker, people["attacker"])


def test_a_deactivated_administrator_cannot_rename_an_account(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    """A change that leaves roles and activity alone also waits for the revocation (company row FOR KEY
    SHARE) instead of committing beside it."""
    attacker = _signed_in(stale_app, people["attacker"])
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _deactivate(connection, people["attacker"]),
        lambda: attacker.patch(f"/users/{people['puppet'].id}", json={"full_name": "Renamed Puppet"}),
    )
    assert response.status_code == 401
    assert _user(maker, people["puppet"]).full_name == "Puppet Person"


def test_a_deactivated_host_cannot_register_a_visitor(
    stale_app: FastAPI, people: dict[str, User], defender_engine: Engine, maker: sessionmaker[Session]
) -> None:
    host = _signed_in(stale_app, people["host"])
    name = unique("Registered After Revocation")
    response = _behind(
        defender_engine,
        maker,
        lambda connection: _deactivate(connection, people["host"]),
        lambda: host.post("/visitors", json={"full_name": name}),
    )
    assert response.status_code == 401
    with maker() as db:
        assert db.scalars(select(Visitor.id).where(Visitor.full_name == name)).all() == []
