"""The seeds' demo accounts never serve production (Phase 11 security review, B11-36).

The finding: `seed-demo` and `seed-e2e` refuse to run with APP_ENV=production, and nothing else stopped
`platform@demo.local` (published password, no forced change, no expiry, above every company) from existing
in a production database: one seeded before it became production's, a restored demo database, or a seed
run from a workstation against the production DATABASE_URL.
"""

import secrets
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app import cli
from app.core import config
from app.core.config import ConfigurationError, Settings
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import PlatformAdmin, PlatformAuditLog, User
from app.security.passwords import PasswordHasherService
from app.services import seed_guard
from app.services.seed_guard import (
    find_seed_accounts,
    is_seed_platform_admin,
    is_seed_user,
    require_no_seed_accounts,
)
from app.services.seeding import (
    DEFAULT_DEMO_PASSWORD,
    SEED_PLATFORM_ADMIN_IDS,
    SEED_USER_IDS,
    seed_platform_admin_id,
    seed_user_id,
)
from tests.support import (
    Api,
    Factory,
    PlatformApi,
    ThrowawayDatabase,
    World,
    audit_rows,
    error_code,
    platform_audit_rows,
)

DEMO_USERS = (
    "admin@demo.local",
    "host2@demo.local",
    "host@demo.local",
    "management@demo.local",
    "manager@demo.local",
    "reception@demo.local",
)
OTHER_USERS = ("admin@other.local", "host@other.local", "management@other.local", "reception@other.local")


@pytest.fixture(autouse=True)
def _fast_hashing(monkeypatch: pytest.MonkeyPatch, hasher: PasswordHasherService) -> None:
    monkeypatch.setattr(cli, "PasswordHasherService", lambda **_kwargs: hasher)


def _production(database: ThrowawayDatabase) -> Settings:
    """A valid production configuration; the engine is passed to `create_app` separately (its URLs are
    never connected to)."""
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="production",
        database_url="postgresql://runtime:runtime-secret-0001@db.internal/vms?sslmode=verify-full",
        migration_database_url="postgresql://owner:owner-secret-0001@db.internal/vms?sslmode=verify-full",
        db_app_role=database.app_role,
        secret_key=secrets.token_urlsafe(48),  # generated: no production-valid key in the code (SEC-47)
        app_base_url="https://vms.example.com",
        allowed_origins="https://vms.example.com",
        cookie_secure=True,
        email_provider="resend",
        resend_api_key="re_test_key",
        log_level="WARNING",
    )


@pytest.fixture
def production_app(
    monkeypatch: pytest.MonkeyPatch,
    database: ThrowawayDatabase,
    app_engine: Engine,
    hasher: PasswordHasherService,
    connection,
) -> FastAPI:
    """The application in production mode on the test database. The test cluster's roles sign in with
    the passwords scripts/db.ps1 publishes, which production refuses on its own
    (`test_runtime_privileges.py`); that check is not what these tests are about."""
    monkeypatch.setattr(config, "PUBLISHED_DB_PASSWORD_MARKERS", ())
    return create_app(
        _production(database), engine=app_engine, password_hasher=hasher, email_provider=MemoryProvider()
    )


def _production_client(app: FastAPI) -> TestClient:
    headers = {"Origin": "https://vms.example.com"}
    return TestClient(
        app, base_url="https://vms.example.com", client=("203.0.113.10", 50000), headers=headers
    )


# ---- which accounts are the seeds' -----------------------------------------------------------------------


def test_the_seeds_accounts_are_known_by_their_ids() -> None:
    assert sorted(SEED_USER_IDS.values()) == sorted((*DEMO_USERS, *OTHER_USERS))
    assert dict(SEED_PLATFORM_ADMIN_IDS) == {
        seed_platform_admin_id("platform@demo.local"): "platform@demo.local"
    }
    assert is_seed_user(seed_user_id("demo-company", "admin@demo.local"))
    assert is_seed_user(seed_user_id("other-corp", "reception@other.local"))
    assert is_seed_platform_admin(seed_platform_admin_id("platform@demo.local"))
    # Not an address, and not any ID: only what the seeds themselves create.
    assert not is_seed_user(seed_user_id("demo-company", "someone@demo.local"))
    assert not is_seed_user(uuid.uuid4()) and not is_seed_platform_admin(uuid.uuid4())
    assert not is_seed_platform_admin(seed_user_id("demo-company", "admin@demo.local"))


def test_a_database_that_was_never_seeded_holds_none(db: Session, world: World, factory: Factory) -> None:
    factory.platform_admin(email="owner@platform.test")
    found = find_seed_accounts(db)
    assert not found and (found.platform_admins, found.users) == ((), ())
    require_no_seed_accounts()


@pytest.mark.parametrize(
    ("command", "users"), [("seed-demo", DEMO_USERS), ("seed-e2e", (*DEMO_USERS, *OTHER_USERS))]
)
def test_a_seeded_database_is_recognised(
    db: Session, settings: Settings, command: str, users: tuple[str, ...]
) -> None:
    assert cli.main([command], settings=settings) == 0
    found = find_seed_accounts(db)
    assert found
    assert found.platform_admins == ("platform@demo.local",)
    assert found.users == tuple(sorted(users))
    with pytest.raises(ConfigurationError) as refused:
        require_no_seed_accounts()
    message = str(refused.value)
    assert "seed-demo or seed-e2e" in message and "published password" in message
    assert "platform account platform@demo.local" in message
    assert f"{len(users)} company user(s): {', '.join(sorted(users))}" in message
    assert "never seeded" in message and "docs/production-readiness.md" in message
    assert DEFAULT_DEMO_PASSWORD not in message


def test_an_address_of_the_seeds_domain_is_not_a_seed_account(
    db: Session, world: World, factory: Factory
) -> None:
    """Any company's administrator can create a user with such an address (and `create-platform-admin`
    an account): if an address were the test, a tenant could stop production from starting."""
    factory.user(world.a.company, email="visitor-desk@demo.local")
    factory.user(world.b.company, email="admin@other.local")  # the seed's address, not the seed's row
    factory.platform_admin(email="platform@demo.local")
    assert not find_seed_accounts(db)
    require_no_seed_accounts()


def test_a_deactivated_seed_account_still_counts(db: Session, settings: Settings) -> None:
    """Existence, not activity: an administrator of the demo company could reactivate a seed user, and
    that must not be what decides whether production starts next time."""
    assert cli.main(["seed-demo"], settings=settings) == 0
    for user in db.scalars(select(User).where(User.id.in_(list(SEED_USER_IDS)))):
        user.is_active = False
    db.scalars(
        select(PlatformAdmin).where(PlatformAdmin.email == "platform@demo.local")
    ).one().is_active = False
    db.commit()
    found = find_seed_accounts(db)
    assert found.platform_admins == ("platform@demo.local",) and len(found.users) == 6


def test_only_the_platform_account_is_enough(db: Session, factory: Factory, hasher) -> None:
    admin = PlatformAdmin(
        id=seed_platform_admin_id("platform@demo.local"),
        email="renamed@platform.example",  # whatever its address has become
        full_name="Platform Owner",
        password_hash=hasher.hash(DEFAULT_DEMO_PASSWORD),
    )
    db.add(admin)
    db.commit()
    with pytest.raises(ConfigurationError, match=r"platform account platform@demo\.local\)"):
        require_no_seed_accounts()


def test_a_database_that_cannot_be_checked_refuses_without_the_driver_s_words(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Failing:
        def __enter__(self):
            raise RuntimeError("password=hunter2 host=db.internal")

        def __exit__(self, *_exc) -> None:
            return None

    monkeypatch.setattr(seed_guard, "session_factory", Failing)
    with pytest.raises(ConfigurationError) as refused:
        require_no_seed_accounts()
    assert "hunter2" not in str(refused.value) and "db.internal" not in str(refused.value)
    assert "could not check the database for demo accounts" in str(refused.value)
    assert refused.value.__cause__ is None and refused.value.__suppress_context__


# ---- production start-up ---------------------------------------------------------------------------------


def test_production_starts_on_a_database_without_seed_accounts(production_app: FastAPI, world: World) -> None:
    with _production_client(production_app) as client:
        assert client.get("/api/v1/health").status_code == 200


@pytest.mark.parametrize("command", ["seed-demo", "seed-e2e"])
def test_production_refuses_to_start_on_a_seeded_database(
    production_app: FastAPI, settings: Settings, command: str
) -> None:
    assert cli.main([command], settings=settings) == 0  # seeded outside production
    with (
        pytest.raises(ConfigurationError, match="demo accounts created by seed-demo or seed-e2e") as refused,
        _production_client(production_app),
    ):
        pass  # pragma: no cover - startup fails
    assert "platform@demo.local" in str(refused.value)
    assert DEFAULT_DEMO_PASSWORD not in str(refused.value)


def test_development_starts_on_a_seeded_database(app: FastAPI, settings: Settings, connection) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    with TestClient(app, base_url="https://testserver") as client:
        assert client.get("/api/v1/health").status_code == 200


# ---- sign-in, should a seed account appear while production runs --------------------------------------


def test_production_refuses_a_seed_account_s_sign_in(
    production_app: FastAPI, settings: Settings, db: Session
) -> None:
    """A seed run from a workstation against the production database, after the API started."""
    assert cli.main(["seed-e2e"], settings=settings) == 0
    client = _production_client(production_app)  # no lifespan: the API was already running
    response = Api(client).login("admin@demo.local", DEFAULT_DEMO_PASSWORD)
    assert response.status_code == 401 and error_code(response) == "INVALID_CREDENTIALS"
    assert "set-cookie" not in response.headers
    admin_id = seed_user_id("demo-company", "admin@demo.local")
    assert [row.meta for row in audit_rows(db, "AUTH_LOGIN_FAILED", actor_user_id=admin_id)] == [
        {"reason": "seed_account"}
    ]
    response = PlatformApi(client).login("platform@demo.local", DEFAULT_DEMO_PASSWORD)
    assert response.status_code == 401 and error_code(response) == "INVALID_CREDENTIALS"
    assert "set-cookie" not in response.headers
    platform_id = seed_platform_admin_id("platform@demo.local")
    rows = platform_audit_rows(db, "AUTH_LOGIN_FAILED", actor_platform_admin_id=platform_id)
    assert [row.meta for row in rows] == [{"reason": "seed_account"}]
    # The same answer as a wrong password, and it counts like one.
    wrong = Api(client).login("admin@demo.local", "Wrong-Password-1234")
    assert wrong.status_code == 401 and wrong.json()["error"] == response.json()["error"]


def test_production_signs_in_accounts_that_are_not_the_seeds(
    production_app: FastAPI, world: World, factory: Factory
) -> None:
    owner = factory.platform_admin(email="platform@demo.local")  # the address alone refuses nothing
    client = _production_client(production_app)
    assert Api(client).login(world.a.admin.email).status_code == 200
    assert PlatformApi(client).login(owner.email).status_code == 200


def test_outside_production_the_seed_accounts_sign_in(make_client, settings: Settings) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert Api(make_client()).login("admin@demo.local", DEFAULT_DEMO_PASSWORD).status_code == 200
    assert PlatformApi(make_client()).login("platform@demo.local", DEFAULT_DEMO_PASSWORD).status_code == 200


# ---- what the seeds leave in the trails --------------------------------------------------------------------


def test_rows_written_by_a_seed_say_seed_and_those_of_create_admin_say_cli(
    db: Session, settings: Settings, monkeypatch
) -> None:
    import io

    from app.models import AuditLog

    assert cli.main(["seed-e2e"], settings=settings) == 0
    sources = {
        row.meta.get("source")
        for row in db.scalars(select(AuditLog).where(AuditLog.seq > db.info["audit_seq_watermark"]))
    }
    assert sources == {"seed"}
    platform_sources = [
        row.meta
        for row in db.scalars(
            select(PlatformAuditLog).where(PlatformAuditLog.seq > db.info["platform_audit_seq_watermark"])
        )
    ]
    assert platform_sources == [{"source": "seed"}]
    monkeypatch.setattr("sys.stdin", io.StringIO("Bootstrap-Admin-Pass-1\n"))
    args = ["create-admin", "--email", "boss@example.com", "--full-name", "The Boss", "--password-stdin"]
    assert cli.main([*args, "--company-slug", "new-co", "--company-name", "New Co"], settings=settings) == 0
    created = db.scalars(select(User).where(User.email == "boss@example.com")).one()
    assert {row.meta["source"] for row in audit_rows(db, "USER_CREATED", entity_id=created.id)} == {"cli"}
    assert {
        row.meta["source"] for row in audit_rows(db, "COMPANY_CREATED", company_id=created.company_id)
    } == {"cli"}
