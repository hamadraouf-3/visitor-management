import dataclasses
import io
import re
import uuid
from datetime import timedelta

import pytest
from alembic import command
from pydantic import SecretStr
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import cli
from app.core.config import Settings
from app.core.time import FakeClock
from app.db.session import create_db_engine
from app.models import AuditLog, Company, Department, Role, User, Visit, VisitorPass
from app.security.passwords import PasswordHasherService
from app.services.seeding import (
    ARABIC_DEMO_ADDRESS,
    DEFAULT_DEMO_PASSWORD,
    DEMO_COMPANY,
    E2E_DEMO_COMPANY,
    ENGLISH_DEMO_ADDRESS,
    OTHER_CORP,
    SeedDepartment,
    Seeder,
    seed_id,
)
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    alembic_config,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    refreshed,
    signed_in,
)


@pytest.fixture(autouse=True)
def _fast_hashing(monkeypatch: pytest.MonkeyPatch, hasher: PasswordHasherService) -> None:
    monkeypatch.setattr(cli, "PasswordHasherService", lambda **_kwargs: hasher)


def _count(db: Session, model) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(model)) or 0


def test_seed_demo_is_idempotent(db: Session, settings: Settings, capsys) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    companies, departments, users = _count(db, Company), _count(db, Department), _count(db, User)
    audit_rows = _count(db, AuditLog)

    assert cli.main(["seed-demo"], settings=settings) == 0
    assert (_count(db, Company), _count(db, Department), _count(db, User)) == (companies, departments, users)
    assert _count(db, AuditLog) == audit_rows
    assert "already present" in capsys.readouterr().out

    company = db.scalars(select(Company).where(Company.slug == DEMO_COMPANY.slug)).one()
    assert company.id == seed_id(DEMO_COMPANY.slug)
    # The brand's own company (Phase 10, B10-10): Arabic by default, with its Arabic name.
    assert (company.name, company.name_ar, company.default_language) == ("Mawdoo3", "موضوع", "ar")
    assert company.timezone == "Asia/Amman"
    # The address in both languages (B10-27), the domain the sign-in addresses' own.
    assert (company.address, company.address_ar) == (ENGLISH_DEMO_ADDRESS, ARABIC_DEMO_ADDRESS)
    assert company.email_domain == "demo.local"
    # Departments in both languages (B10-27); each keeps the seed ID of its English key.
    departments = {
        row.id: (row.name, row.name_ar)
        for row in db.scalars(select(Department).where(Department.company_id == company.id))
    }
    assert departments == {
        seed_id(DEMO_COMPANY.slug, "department", key): (key, arabic) for key, arabic in DEPARTMENTS.items()
    }
    seeded = {user.email: user for user in db.scalars(select(User).where(User.company_id == company.id))}
    assert set(seeded) == {
        "admin@demo.local",
        "host@demo.local",
        "host2@demo.local",
        "reception@demo.local",
        "manager@demo.local",
        "management@demo.local",
    }
    assert seeded["manager@demo.local"].roles == ["EMPLOYEE", "MANAGEMENT"]  # union of roles (D-04)
    assert seeded["management@demo.local"].roles == ["MANAGEMENT"]  # the read-only role on its own
    assert seeded["admin@demo.local"].roles == ["SYSTEM_ADMIN"]
    for user in seeded.values():
        assert user.id == seed_id(DEMO_COMPANY.slug, "user", user.email)
    assert {email: user.full_name for email, user in seeded.items()} == ARABIC_DEMO_NAMES
    assert departments[seeded["host@demo.local"].department_id] == ("Finance", "المالية")
    assert seeded["reception@demo.local"].department_id is None
    assert all(user.phone for user in seeded.values())
    assert not any(user.must_change_password for user in seeded.values())


ARABIC_DEMO_NAMES = {
    "admin@demo.local": "أمل حداد",
    "host@demo.local": "عمر خليل",
    "host2@demo.local": "لينا صالح",
    "reception@demo.local": "رامي ناصر",
    "manager@demo.local": "دينا فرح",
    "management@demo.local": "نور عباس",
}
ENGLISH_DEMO_NAMES = {
    "admin@demo.local": "Amal Haddad",
    "host@demo.local": "Omar Khalil",
    "host2@demo.local": "Lina Saleh",
    "reception@demo.local": "Rami Nasser",
    "manager@demo.local": "Dina Farah",
    "management@demo.local": "Nour Abbas",
}
# Department key (its English name) -> its Arabic name.
DEPARTMENTS = {
    "Executive Office": "المكتب التنفيذي",
    "Finance": "المالية",
    "IT": "تقنية المعلومات",
    "Operations": "العمليات",
    "Human Resources": "الموارد البشرية",
}
ENGLISH_DEPARTMENTS = set(DEPARTMENTS)


def test_seeded_users_can_log_in(db: Session, settings: Settings, client) -> None:
    cli.main(["seed-demo"], settings=settings)
    response = client.post(
        "/api/v1/auth/login", json={"email": "admin@demo.local", "password": "Demo-Visitor-2026"}
    )
    assert response.status_code == 200
    company = response.json()["company"]
    assert (company["name"], company["name_ar"], company["default_language"]) == ("Mawdoo3", "موضوع", "ar")
    assert response.json()["user"]["preferred_language"] is None


def test_seed_e2e_adds_second_company(db: Session, settings: Settings) -> None:
    assert cli.main(["seed-e2e"], settings=settings) == 0
    slugs = set(db.scalars(select(Company.slug)))
    assert {DEMO_COMPANY.slug, OTHER_CORP.slug} <= slugs
    other = db.scalars(select(Company).where(Company.slug == OTHER_CORP.slug)).one()
    # The second tenant is English by default and has no Arabic name: a company of each kind.
    assert (other.name, other.name_ar, other.default_language) == ("Other Corp", None, "en")
    roles = {user.email: user.roles for user in db.scalars(select(User).where(User.company_id == other.id))}
    assert roles == {
        "admin@other.local": ["SYSTEM_ADMIN"],
        "host@other.local": ["EMPLOYEE"],
        "reception@other.local": ["RECEPTIONIST"],
        "management@other.local": ["MANAGEMENT"],
    }


def test_seed_timezone_comes_from_settings(db: Session, settings: Settings) -> None:
    custom = settings.model_copy(update={"seed_company_timezone": "Europe/Berlin"})
    cli.main(["seed-demo"], settings=custom)
    assert (
        db.scalars(select(Company.timezone).where(Company.slug == DEMO_COMPANY.slug)).one() == "Europe/Berlin"
    )


@pytest.mark.parametrize("command", ["seed-demo", "seed-e2e"])
def test_seeding_is_refused_in_production(db: Session, settings: Settings, command: str, capsys) -> None:
    production = settings.model_copy(update={"app_env": "production"})
    assert cli.main([command], settings=production) == cli.EXIT_USAGE
    assert "not available" in capsys.readouterr().err
    assert db.scalars(select(Company).where(Company.slug == DEMO_COMPANY.slug)).first() is None


def test_create_admin_with_new_company(db: Session, settings: Settings, monkeypatch, capsys) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("Bootstrap-Admin-Pass-1\n"))
    code = cli.main(
        [
            "create-admin",
            "--email",
            "Boss@Example.com",
            "--full-name",
            "The Boss",
            "--company-slug",
            "new-co",
            "--company-name",
            "New Co",
            "--password-stdin",
        ],
        settings=settings,
    )
    assert code == 0
    user = db.scalars(select(User).where(User.email == "boss@example.com")).one()
    assert user.roles == ["SYSTEM_ADMIN"]
    assert db.get(Company, user.company_id).slug == "new-co"
    assert "created administrator" in capsys.readouterr().out


def test_create_admin_rejects_weak_password_and_unknown_company(
    db: Session, settings: Settings, monkeypatch
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("short\n"))
    args = ["create-admin", "--email", "x@example.com", "--full-name", "X", "--company-slug", "nope"]
    assert cli.main([*args, "--password-stdin"], settings=settings) == cli.EXIT_USAGE

    monkeypatch.setattr("sys.stdin", io.StringIO("Long-Enough-Pass-123\n"))
    assert cli.main([*args, "--password-stdin"], settings=settings) == cli.EXIT_USAGE
    assert db.scalars(select(User).where(User.email == "x@example.com")).first() is None


def test_seeded_management_only_user_is_read_only(db: Session, settings: Settings, make_client) -> None:
    cli.main(["seed-demo"], settings=settings)
    client = make_client()
    login = client.post(
        "/api/v1/auth/login", json={"email": "management@demo.local", "password": "Demo-Visitor-2026"}
    )
    assert login.status_code == 200 and login.json()["user"]["roles"] == ["MANAGEMENT"]
    csrf = {"X-CSRF-Token": client.cookies.get("__Host-vms_csrf")}
    assert client.get("/api/v1/users/hosts").status_code == 200  # directory read: every role
    denied = client.post("/api/v1/departments", json={"name": "Not Allowed"}, headers=csrf)
    assert denied.status_code == 403


def test_mark_no_shows_covers_every_company(
    db: Session, settings: Settings, make_client, world: World, clock: FakeClock, capsys
) -> None:
    start = TEST_START + timedelta(hours=1)
    a_visit = create_visit(signed_in(make_client, world.a.employee), world.a.employee.id, start)["visit"][
        "id"
    ]
    b_visit = create_visit(signed_in(make_client, world.b.employee), world.b.employee.id, start)["visit"][
        "id"
    ]
    later = create_visit(
        signed_in(make_client, world.a.employee), world.a.employee.id, start + timedelta(days=1)
    )["visit"]["id"]
    clock.set(start + timedelta(hours=2, minutes=1))

    assert cli.main(["mark-no-shows"], settings=settings) == 0
    assert "visits marked NO_SHOW: 2" in capsys.readouterr().out
    assert [refreshed(db, Visit, visit_id).status for visit_id in (a_visit, b_visit, later)] == [
        "NO_SHOW",
        "NO_SHOW",
        "SCHEDULED",
    ]
    assert {row.company_id for row in audit_rows(db, "VISIT_MARKED_NO_SHOW")} == {
        world.a.company.id,
        world.b.company.id,
    }
    assert cli.main(["mark-no-shows"], settings=settings) == 0
    assert "visits marked NO_SHOW: 0" in capsys.readouterr().out


def test_e2e_time_travel_expires_a_pass(
    db: Session, settings: Settings, make_client, world: World, capsys
) -> None:
    start = TEST_START + timedelta(hours=1)
    host = signed_in(make_client, world.a.employee)
    created = create_visit(host, world.a.employee.id, start)
    visit_id = created["visit"]["id"]
    issued_before = refreshed(db, Visit, visit_id).window_end

    assert cli.main(["e2e-time-travel", "--visit-id", visit_id, "--minutes", "180"], settings=settings) == 0
    assert "moved 180 minutes into the past" in capsys.readouterr().out
    visit = refreshed(db, Visit, visit_id)
    assert visit.window_end == issued_before - timedelta(minutes=180)
    assert visit.scheduled_start == start - timedelta(minutes=180)
    visitor_pass = db.scalars(select(VisitorPass).where(VisitorPass.visit_id == visit.id)).one()
    assert visitor_pass.created_at < TEST_START - timedelta(minutes=170)
    assert audit_rows(db, "VISIT_TIME_SHIFTED", entity_id=visit.id)[-1].meta == {
        "minutes": -180,
        "source": "cli",
    }

    reception = signed_in(make_client, world.a.receptionist)
    scan = reception.post("/reception/scan", json={"token": created["pass_url"]})
    assert scan.status_code == 410 and scan.json()["error"]["code"] == "PASS_EXPIRED"
    assert refreshed(db, Visit, visit_id).status == "NO_SHOW"


def test_e2e_time_travel_refusals(db: Session, settings: Settings, make_client, world: World, capsys) -> None:
    start = TEST_START + timedelta(hours=1)
    host = signed_in(make_client, world.a.employee)
    visit_id = create_visit(host, world.a.employee.id, start)["visit"]["id"]
    production = settings.model_copy(update={"app_env": "production"})
    assert cli.main(["e2e-time-travel", "--visit-id", visit_id, "--minutes", "10"], settings=production) == 2
    assert "not available" in capsys.readouterr().err
    unknown = "00000000-0000-4000-8000-000000000000"
    assert cli.main(["e2e-time-travel", "--visit-id", unknown, "--minutes", "10"], settings=settings) == 2
    assert "visit not found" in capsys.readouterr().err
    assert cli.main(["e2e-time-travel", "--visit-id", visit_id, "--minutes", "0"], settings=settings) == 2
    host.post(f"/visits/{visit_id}/cancel", json={})
    assert cli.main(["e2e-time-travel", "--visit-id", visit_id, "--minutes", "10"], settings=settings) == 2
    assert "can no longer be modified" in capsys.readouterr().err
    assert refreshed(db, Visit, visit_id).scheduled_start == start


def _create_admin(settings: Settings, monkeypatch, *extra: str, full_name: str = "The Boss") -> int:
    monkeypatch.setattr("sys.stdin", io.StringIO("Bootstrap-Admin-Pass-1\n"))
    args = ["create-admin", "--email", "boss2@example.com", "--full-name", full_name, "--password-stdin"]
    return cli.main([*args, *extra], settings=settings)


def test_create_admin_validates_like_the_api(db: Session, settings: Settings, monkeypatch, capsys) -> None:
    new_company = ("--company-slug", "co-two", "--company-name", "Co Two")
    assert _create_admin(settings, monkeypatch, *new_company, full_name="   ") == cli.EXIT_USAGE
    assert "--full-name" in capsys.readouterr().err
    assert _create_admin(settings, monkeypatch, *new_company, full_name="Bad\x00Name") == cli.EXIT_USAGE
    assert "control characters" in capsys.readouterr().err
    blank_company = ("--company-slug", "co-two", "--company-name", "  ")
    assert _create_admin(settings, monkeypatch, *blank_company) == cli.EXIT_USAGE
    assert "--company-name" in capsys.readouterr().err
    assert db.scalars(select(User).where(User.email == "boss2@example.com")).first() is None


def test_create_admin_refuses_an_existing_address(
    db: Session, settings: Settings, monkeypatch, capsys
) -> None:
    new_company = ("--company-slug", "co-dup", "--company-name", "Co Dup")
    assert _create_admin(settings, monkeypatch, *new_company) == 0
    assert _create_admin(settings, monkeypatch, *new_company) == cli.EXIT_USAGE
    assert "already exists" in capsys.readouterr().err


def test_create_admin_duplicate_race_is_a_domain_error(
    db: Session, settings: Settings, monkeypatch, capsys
) -> None:
    """A concurrent insert of the same address: the up-front check sees nothing, the unique index decides,
    and the result is the same user-facing error (no traceback, nothing written)."""
    assert _create_admin(settings, monkeypatch, "--company-slug", "co-race", "--company-name", "Co Race") == 0
    monkeypatch.setattr("app.repositories.users.UserRepository.get_by_email", lambda _self, _email: None)
    code = _create_admin(
        settings, monkeypatch, "--company-slug", "co-race-two", "--company-name", "Co Race Two"
    )
    assert code == cli.EXIT_USAGE
    assert "already exists" in capsys.readouterr().err
    db.expire_all()
    assert db.scalars(select(Company).where(Company.slug == "co-race-two")).first() is None


def test_create_admin_checks_the_timezone_against_the_database(
    db: Session, settings: Settings, monkeypatch, capsys
) -> None:
    new_company = ("--company-slug", "co-three", "--company-name", "Co Three")
    monkeypatch.setattr(
        "app.repositories.companies.CompanyRepository.database_knows_timezone", lambda _self, _name: False
    )
    assert _create_admin(settings, monkeypatch, *new_company, "--timezone", "Asia/Amman") == cli.EXIT_USAGE
    assert "unknown timezone" in capsys.readouterr().err
    assert db.scalars(select(Company).where(Company.slug == "co-three")).first() is None


# ---- prune-sessions (SEC-02/SEC-14) ------------------------------------------------------------------


def test_prune_sessions_deletes_only_sessions_that_ended_long_ago(
    create_database, settings: Settings, clock: FakeClock, capsys
) -> None:
    """Every sign-in writes a session row that the runtime role cannot delete; the schema owner prunes the
    ones that ended (revoked or expired) more than the retention period ago."""
    database = create_database("vms_prune")
    command.upgrade(alembic_config(database), "head")
    owner = create_db_engine(database.owner_url, pool_size=1, application_name="vms-tests-prune")
    now = clock.now()
    ages = {
        "revoked long ago": (now - timedelta(days=40), now - timedelta(days=40)),
        "expired long ago": (None, now - timedelta(days=31)),
        "revoked recently": (now - timedelta(days=2), now + timedelta(hours=2)),
        "live": (None, now + timedelta(hours=10)),
    }
    try:
        with owner.begin() as connection:
            company, user = uuid.uuid4(), uuid.uuid4()
            connection.execute(
                text("INSERT INTO companies (id, name, slug, timezone) VALUES (:id, 'Co', 'co', 'UTC')"),
                {"id": company},
            )
            connection.execute(
                text(
                    "INSERT INTO users (id, company_id, full_name, email, password_hash, roles) "
                    "VALUES (:id, :c, 'U', 'u@example.com', 'x', ARRAY['EMPLOYEE'])"
                ),
                {"id": user, "c": company},
            )
            for index, (revoked_at, expires_at) in enumerate(ages.values()):
                connection.execute(
                    text(
                        "INSERT INTO user_sessions (id, user_id, company_id, token_hash, csrf_token_hash, "
                        "expires_at, last_seen_at, revoked_at, created_at) "
                        "VALUES (gen_random_uuid(), :u, :c, :t, :t, :e, :e, :r, :e)"
                    ),
                    {
                        "u": user,
                        "c": company,
                        "t": f"{index}".ljust(64, "0"),
                        "e": expires_at,
                        "r": revoked_at,
                    },
                )
            # The platform owner's sessions follow the same rule (B11-6).
            platform_admin = uuid.uuid4()
            connection.execute(
                text(
                    "INSERT INTO platform_admins (id, email, full_name, password_hash) "
                    "VALUES (:id, 'p@example.com', 'P', 'x')"
                ),
                {"id": platform_admin},
            )
            for index, (revoked_at, expires_at) in enumerate(ages.values()):
                connection.execute(
                    text(
                        "INSERT INTO platform_sessions (id, platform_admin_id, token_hash, csrf_token_hash, "
                        "expires_at, last_seen_at, revoked_at, created_at) "
                        "VALUES (gen_random_uuid(), :p, :t, :t, :e, :e, :r, :e)"
                    ),
                    {"p": platform_admin, "t": f"p{index}".ljust(64, "0"), "e": expires_at, "r": revoked_at},
                )
        maintenance = settings.model_copy(update={"migration_database_url": SecretStr(database.owner_url)})
        assert cli.main(["prune-sessions"], settings=maintenance) == 0
        assert "sessions deleted: 4" in capsys.readouterr().out
        with owner.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM user_sessions")).scalar_one() == 2
            assert connection.execute(text("SELECT count(*) FROM platform_sessions")).scalar_one() == 2
        assert cli.main(["prune-sessions", "--older-than-days", "0"], settings=maintenance) == cli.EXIT_USAGE
    finally:
        owner.dispose()


# ---- re-running a seed on a database seeded before Phase 10 (B10-10) ------------------------------


def _company_seeded_before_phase_10(db: Session, slug: str, name: str) -> Company:
    """A seed company as an earlier version wrote it: no Arabic name, the column's default language."""
    company = Company(id=seed_id(slug), slug=slug, name=name, timezone="Asia/Amman", default_language="ar")
    db.add(company)
    db.commit()
    return company


def test_seed_demo_gives_an_earlier_demo_company_the_brand_and_its_arabic_name(
    db: Session, settings: Settings, capsys
) -> None:
    company = _company_seeded_before_phase_10(db, DEMO_COMPANY.slug, "Demo Company")

    assert cli.main(["seed-demo"], settings=settings) == 0

    stored = refreshed(db, Company, company.id)
    assert (stored.name, stored.name_ar, stored.default_language) == ("Mawdoo3", "موضوع", "ar")
    (row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)
    assert row.meta == {"changed_fields": ["name", "name_ar"], "source": "seed"}
    assert row.actor_user_id is None
    assert f"companies updated:   {DEMO_COMPANY.slug}" in capsys.readouterr().out
    # Idempotent: nothing more to do, nothing more audited.
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert len(audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)) == 1
    assert "companies updated" not in capsys.readouterr().out


def test_seed_demo_never_renames_a_company_someone_named(db: Session, settings: Settings) -> None:
    company = _company_seeded_before_phase_10(db, DEMO_COMPANY.slug, "Acme Jordan")
    company.name_ar = "أكمي الأردن"
    company.default_language = "en"
    db.commit()

    assert cli.main(["seed-demo"], settings=settings) == 0

    stored = refreshed(db, Company, company.id)
    assert (stored.name, stored.name_ar, stored.default_language) == ("Acme Jordan", "أكمي الأردن", "en")
    assert audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id) == []


def test_seed_demo_fills_only_a_missing_arabic_name(db: Session, settings: Settings) -> None:
    company = _company_seeded_before_phase_10(db, DEMO_COMPANY.slug, "Acme Jordan")

    assert cli.main(["seed-demo"], settings=settings) == 0

    stored = refreshed(db, Company, company.id)
    assert (stored.name, stored.name_ar, stored.default_language) == ("Acme Jordan", "موضوع", "ar")
    (row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)
    assert row.meta["changed_fields"] == ["name_ar"]


def test_seed_e2e_moves_the_second_tenant_off_the_column_default(db: Session, settings: Settings) -> None:
    other = _company_seeded_before_phase_10(db, OTHER_CORP.slug, "Other Corp")

    assert cli.main(["seed-e2e"], settings=settings) == 0

    stored = refreshed(db, Company, other.id)
    assert (stored.name, stored.name_ar, stored.default_language) == ("Other Corp", None, "en")
    (row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=other.id)
    assert row.meta["changed_fields"] == ["default_language"]


def test_create_admin_creates_an_arabic_default_company(db: Session, settings: Settings, monkeypatch) -> None:
    """A company made by create-admin gets the product's default language (the column's default)."""
    monkeypatch.setattr("sys.stdin", io.StringIO("Bootstrap-Admin-Pass-1\n"))
    args = ["create-admin", "--email", "boss2@example.com", "--full-name", "The Boss"]
    company_args = ["--company-slug", "fresh-co", "--company-name", "Fresh Co", "--password-stdin"]
    assert cli.main([*args, *company_args], settings=settings) == 0
    company = db.scalars(select(Company).where(Company.slug == "fresh-co")).one()
    assert (company.name_ar, company.default_language) == (None, "ar")


# ---- a seed never overrides a person (B10-15) ------------------------------------------------------


def _administrator(make_client, email: str) -> Api:
    api = Api(make_client())
    login = api.login(email, DEFAULT_DEMO_PASSWORD)
    assert login.status_code == 200, login.text
    return api


def test_seed_e2e_keeps_the_default_language_an_administrator_chose(
    db: Session, settings: Settings, make_client
) -> None:
    """The reviewer's case: Other Corp's administrator chose Arabic; a re-run of seed-e2e set it back to
    English, because Arabic is also the value an earlier seed left behind."""
    assert cli.main(["seed-e2e"], settings=settings) == 0
    admin = _administrator(make_client, "admin@other.local")
    chosen = admin.patch("/company/settings", json={"default_language": "ar", "name_ar": None})
    assert chosen.status_code == 200, chosen.text
    assert (chosen.json()["default_language"], chosen.json()["name_ar"]) == ("ar", None)

    assert cli.main(["seed-e2e"], settings=settings) == 0

    stored = refreshed(db, Company, seed_id(OTHER_CORP.slug))
    assert (stored.name, stored.name_ar, stored.default_language) == ("Other Corp", None, "ar")
    rows = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=stored.id)
    assert [(row.actor_user_id is not None, row.meta["changed_fields"]) for row in rows] == [
        (True, ["default_language"])
    ]


def test_seed_demo_keeps_an_arabic_name_an_administrator_cleared(
    db: Session, settings: Settings, make_client, capsys
) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    admin = _administrator(make_client, "admin@demo.local")
    cleared = admin.patch("/company/settings", json={"name_ar": None})
    assert cleared.status_code == 200 and cleared.json()["name_ar"] is None
    capsys.readouterr()

    assert cli.main(["seed-demo"], settings=settings) == 0

    stored = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (stored.name, stored.name_ar, stored.default_language) == ("Mawdoo3", None, "ar")
    assert "companies updated" not in capsys.readouterr().out
    rows = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=stored.id)
    assert [row.meta for row in rows] == [{"changed_fields": ["name_ar"]}]


def test_seed_demo_keeps_the_former_name_when_an_administrator_chose_it(
    db: Session, settings: Settings, make_client
) -> None:
    """`Demo Company` is renamed only while nobody chose it: typed back in the settings, it stays."""
    assert cli.main(["seed-demo"], settings=settings) == 0
    admin = _administrator(make_client, "admin@demo.local")
    renamed = admin.patch("/company/settings", json={"name": "Demo Company"})
    assert renamed.status_code == 200, renamed.text

    assert cli.main(["seed-demo"], settings=settings) == 0

    assert refreshed(db, Company, seed_id(DEMO_COMPANY.slug)).name == "Demo Company"


def test_a_change_to_another_setting_does_not_stop_the_language_back_fill(
    db: Session, settings: Settings, factory: Factory, make_client
) -> None:
    """Only the fields a person changed are theirs: an administrator who set the address of a company
    seeded before Phase 10 still gets the seed's name, Arabic name and language for it."""
    company = _company_seeded_before_phase_10(db, DEMO_COMPANY.slug, "Demo Company")
    admin = signed_in(make_client, factory.user(company, roles=(Role.SYSTEM_ADMIN,)))
    assert admin.patch("/company/settings", json={"address": "Amman"}).status_code == 200

    assert cli.main(["seed-demo"], settings=settings) == 0

    stored = refreshed(db, Company, company.id)
    assert (stored.name, stored.name_ar, stored.default_language, stored.address) == (
        "Mawdoo3",
        "موضوع",
        "ar",
        "Amman",
    )
    rows = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)
    assert [(row.actor_user_id is None, row.meta["changed_fields"]) for row in rows] == [
        (False, ["address"]),
        (True, ["name", "name_ar"]),
    ]


# ---- Arabic demo names, English E2E names (B10-20); departments in both languages (B10-27) ----------


def _demo_names(db: Session) -> tuple[dict[str, str], dict[str, tuple[str, str | None]]]:
    """(e-mail -> full name, department key -> (name, Arabic name)) of the demo company, by seed ID."""
    db.expire_all()
    company_id = seed_id(DEMO_COMPANY.slug)
    users = {
        user.email: user.full_name for user in db.scalars(select(User).where(User.company_id == company_id))
    }
    names = {
        department.id: (department.name, department.name_ar) for department in db.scalars(select(Department))
    }
    keys = {seed_id(DEMO_COMPANY.slug, "department", key): key for key in ENGLISH_DEPARTMENTS}
    return users, {
        keys[department_id]: name for department_id, name in names.items() if department_id in keys
    }


BILINGUAL_DEPARTMENTS = {key: (key, arabic) for key, arabic in DEPARTMENTS.items()}


def test_seed_e2e_keeps_the_english_names_the_end_to_end_suite_reads(db: Session, settings: Settings) -> None:
    assert cli.main(["seed-e2e"], settings=settings) == 0
    users, departments = _demo_names(db)
    assert users == ENGLISH_DEMO_NAMES
    assert departments == {key: (key, None) for key in ENGLISH_DEPARTMENTS}
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ENGLISH_DEMO_ADDRESS, None)
    # The same company, addresses and seed IDs as seed-demo: only the display names differ.
    assert [user.email for user in E2E_DEMO_COMPANY.users] == [user.email for user in DEMO_COMPANY.users]
    assert [d.key for d in E2E_DEMO_COMPANY.departments] == [d.key for d in DEMO_COMPANY.departments]
    assert [d.name for d in E2E_DEMO_COMPANY.departments] == [d.name for d in DEMO_COMPANY.departments]
    assert audit_rows(db, "USER_UPDATED") == [] and audit_rows(db, "DEPARTMENT_UPDATED") == []


def test_seed_demo_completes_an_earlier_english_seed(
    db: Session, settings: Settings, make_client, capsys
) -> None:
    """A database seeded with the English names (before B10-20, or by seed-e2e): seed-demo gives every seed
    user its Arabic name and every seed department its Arabic name beside the English one, keeps every ID,
    audits each change like the company completion and refreshes the name snapshots of SCHEDULED visits
    (D-17). A second run changes nothing."""
    assert cli.main(["seed-e2e"], settings=settings) == 0
    host = _administrator(make_client, "host@demo.local")
    host_id = seed_id(DEMO_COMPANY.slug, "user", "host@demo.local")
    visit_id = create_visit(host, host_id, TEST_START + timedelta(hours=1))["visit"]["id"]
    visit = refreshed(db, Visit, visit_id)
    assert (visit.host_name, visit.department_name, visit.department_name_ar) == (
        "Omar Khalil",
        "Finance",
        None,
    )
    capsys.readouterr()

    assert cli.main(["seed-demo"], settings=settings) == 0

    users, departments = _demo_names(db)
    assert users == ARABIC_DEMO_NAMES
    assert departments == BILINGUAL_DEPARTMENTS
    visit = refreshed(db, Visit, visit_id)
    assert (visit.host_name, visit.department_name, visit.department_name_ar) == (
        "عمر خليل",
        "Finance",
        "المالية",
    )
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ENGLISH_DEMO_ADDRESS, ARABIC_DEMO_ADDRESS)
    user_rows = audit_rows(db, "USER_UPDATED")
    department_rows = audit_rows(db, "DEPARTMENT_UPDATED")
    assert len(user_rows) == 6 and len(department_rows) == 5
    for row in (*user_rows, *department_rows):
        assert row.actor_user_id is None and row.company_id == seed_id(DEMO_COMPANY.slug)
    assert {row.meta["changed_fields"][0] for row in user_rows} == {"full_name"}
    assert [row.meta for row in department_rows] == [{"changed_fields": ["name_ar"], "source": "seed"}] * 5
    assert {row.entity_id for row in user_rows} == {
        seed_id(DEMO_COMPANY.slug, "user", email) for email in ARABIC_DEMO_NAMES
    }
    (company_row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)
    assert company_row.meta == {"changed_fields": ["address_ar"], "source": "seed"}
    out = capsys.readouterr().out
    assert "users updated:       admin@demo.local, host@demo.local" in out
    assert "departments updated: demo-company/Executive Office, demo-company/Finance" in out
    assert f"companies updated:   {DEMO_COMPANY.slug}" in out
    assert "departments created: 0" in out

    assert cli.main(["seed-demo"], settings=settings) == 0
    assert len(audit_rows(db, "USER_UPDATED")) == 6 and len(audit_rows(db, "DEPARTMENT_UPDATED")) == 5
    assert len(audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)) == 1
    out = capsys.readouterr().out
    assert "users updated" not in out and "departments updated" not in out and "companies updated" not in out


def test_seed_demo_never_changes_what_a_person_changed(db: Session, settings: Settings, make_client) -> None:
    """B10-15's rule for users and departments: a name a person set is theirs, even when it is the earlier
    seed's English name again; a person's Arabic name, or one they cleared, stays; another company's user
    and a name another department already shows are left alone."""
    assert cli.main(["seed-e2e"], settings=settings) == 0
    admin = _administrator(make_client, "admin@demo.local")
    host_id = seed_id(DEMO_COMPANY.slug, "user", "host@demo.local")
    lina_id = seed_id(DEMO_COMPANY.slug, "user", "host2@demo.local")
    department = {key: seed_id(DEMO_COMPANY.slug, "department", key) for key in ENGLISH_DEPARTMENTS}
    for body in ({"full_name": "Omar K."}, {"full_name": "Omar Khalil"}):  # back to the seed's name
        assert admin.patch(f"/users/{host_id}", json=body).status_code == 200
    assert admin.patch(f"/users/{lina_id}", json={"full_name": "Lina S."}).status_code == 200
    # Renamed: the seed's Arabic name is not the Arabic of the new name.
    assert admin.patch(f"/departments/{department['Finance']}", json={"name": "Accounts"}).status_code == 200
    # Renamed and back to the seed's name: the Arabic name is still the seed's to give.
    for name in ("Technology", "IT"):
        assert admin.patch(f"/departments/{department['IT']}", json={"name": name}).status_code == 200
    # An Arabic name a person chose, and one a person set and cleared again.
    chosen = admin.patch(f"/departments/{department['Executive Office']}", json={"name_ar": "مكتب المدير"})
    assert chosen.status_code == 200
    for value in ("الموارد", None):
        response = admin.patch(f"/departments/{department['Human Resources']}", json={"name_ar": value})
        assert response.status_code == 200
    # Someone already uses the Arabic name of Operations as another department's name.
    taken = admin.post("/departments", json={"name": "العمليات"})
    assert taken.status_code == 201, taken.text

    assert cli.main(["seed-demo"], settings=settings) == 0

    users, departments = _demo_names(db)
    assert users["host@demo.local"] == "Omar Khalil" and users["host2@demo.local"] == "Lina S."
    assert users["admin@demo.local"] == "أمل حداد"
    assert departments == {
        "Finance": ("Accounts", None),
        "IT": ("IT", "تقنية المعلومات"),
        "Executive Office": ("Executive Office", "مكتب المدير"),
        "Human Resources": ("Human Resources", None),
        "Operations": ("Operations", None),
    }
    cli_rows = [row for row in audit_rows(db, "DEPARTMENT_UPDATED") if row.actor_user_id is None]
    assert {row.entity_id: row.meta["changed_fields"] for row in cli_rows} == {department["IT"]: ["name_ar"]}
    cli_users = [row for row in audit_rows(db, "USER_UPDATED") if row.actor_user_id is None]
    assert {row.entity_id for row in cli_users} == {
        seed_id(DEMO_COMPANY.slug, "user", email)
        for email in ARABIC_DEMO_NAMES
        if email not in ("host@demo.local", "host2@demo.local")
    }
    # Other Corp's users are never touched by the demo company's names.
    other = {
        user.full_name for user in db.scalars(select(User).where(User.company_id == seed_id(OTHER_CORP.slug)))
    }
    assert other == {"Sami Odeh", "Huda Mansour", "Yousef Darwish", "Rana Qasem"}


def test_seed_e2e_does_not_take_the_arabic_names_away(db: Session, settings: Settings) -> None:
    """seed-e2e on a database seeded by seed-demo finds the departments by seed ID and leaves both their
    names, and the Arabic user names and address (it knows no former names): no duplicate department and
    no audit row."""
    assert cli.main(["seed-demo"], settings=settings) == 0
    departments = _count(db, Department)
    assert cli.main(["seed-e2e"], settings=settings) == 0
    users, names = _demo_names(db)
    assert users == ARABIC_DEMO_NAMES and names == BILINGUAL_DEPARTMENTS
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ENGLISH_DEMO_ADDRESS, ARABIC_DEMO_ADDRESS)
    assert _count(db, Department) == departments + len(OTHER_CORP.departments)
    assert audit_rows(db, "USER_UPDATED") == [] and audit_rows(db, "DEPARTMENT_UPDATED") == []
    assert audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id) == []


# ---- the company's address in both languages (B10-27; B10-23 wrote it in Arabic only) ---------------


def test_seed_demo_writes_the_address_in_both_languages_and_seed_e2e_in_english(
    db: Session, settings: Settings
) -> None:
    """The English interface shows the English address, the Arabic interface and the Arabic part of every
    visitor e-mail the Arabic one; the end-to-end suite keeps the English one it was given, alone."""
    assert (DEMO_COMPANY.address, DEMO_COMPANY.address_ar) == (ENGLISH_DEMO_ADDRESS, ARABIC_DEMO_ADDRESS)
    assert not re.search(r"[A-Za-z]", ARABIC_DEMO_ADDRESS)
    assert (E2E_DEMO_COMPANY.address, E2E_DEMO_COMPANY.address_ar) == (ENGLISH_DEMO_ADDRESS, None)
    assert cli.main(["seed-e2e"], settings=settings) == 0
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ENGLISH_DEMO_ADDRESS, None)


def test_seed_demo_adds_the_arabic_address_to_an_earlier_english_seed_address(
    db: Session, settings: Settings, capsys
) -> None:
    """A database seeded before B10-23: the English address stays and gains its Arabic one, audited like
    a change in the settings page, without an actor; a second run changes nothing."""
    company = _company_seeded_before_phase_10(db, DEMO_COMPANY.slug, "Mawdoo3")
    company.name_ar, company.address = "موضوع", ENGLISH_DEMO_ADDRESS
    db.commit()

    assert cli.main(["seed-demo"], settings=settings) == 0

    stored = refreshed(db, Company, company.id)
    assert (stored.address, stored.address_ar) == (ENGLISH_DEMO_ADDRESS, ARABIC_DEMO_ADDRESS)
    (row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)
    assert row.meta == {"changed_fields": ["address_ar"], "source": "seed"}
    assert row.actor_user_id is None
    assert f"companies updated:   {DEMO_COMPANY.slug}" in capsys.readouterr().out
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert len(audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)) == 1


def test_seed_demo_keeps_an_address_a_person_set(db: Session, settings: Settings, make_client) -> None:
    """B10-15: an address someone typed is theirs, the earlier seed's Arabic one included, and gets no
    Arabic address of the seed's; an Arabic address a person cleared stays cleared; another company's
    address is never replaced."""
    assert cli.main(["seed-demo"], settings=settings) == 0
    admin = _administrator(make_client, "admin@demo.local")
    chosen = admin.patch("/company/settings", json={"address": ARABIC_DEMO_ADDRESS, "address_ar": None})
    assert chosen.status_code == 200, chosen.text

    assert cli.main(["seed-demo"], settings=settings) == 0
    stored = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (stored.address, stored.address_ar) == (ARABIC_DEMO_ADDRESS, None)

    # Back to the seed's English address: the Arabic one the person cleared is still theirs.
    assert admin.patch("/company/settings", json={"address": ENGLISH_DEMO_ADDRESS}).status_code == 200
    assert cli.main(["seed-demo"], settings=settings) == 0
    stored = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (stored.address, stored.address_ar) == (ENGLISH_DEMO_ADDRESS, None)
    cli_rows = [
        row
        for row in audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=stored.id)
        if row.actor_user_id is None
    ]
    assert cli_rows == []

    other = _company_seeded_before_phase_10(db, "elsewhere", "Elsewhere")
    other.address = "Amman"
    db.commit()
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert (refreshed(db, Company, other.id).address, refreshed(db, Company, other.id).address_ar) == (
        "Amman",
        None,
    )


# ---- converting the Arabic-only demo of B10-20 and B10-23 (the user's database) ---------------------

# The demo company as seed-demo wrote it from B10-20 and B10-23 until B10-27: the departments named in
# Arabic only and the address in Arabic only.
ARABIC_ONLY_DEMO = dataclasses.replace(
    DEMO_COMPANY,
    departments=tuple(SeedDepartment(key=key, name=arabic) for key, arabic in DEPARTMENTS.items()),
    address=ARABIC_DEMO_ADDRESS,
    address_ar=None,
    former_addresses=(),
)


def _seed_arabic_only_demo(db: Session, settings: Settings, hasher: PasswordHasherService) -> None:
    Seeder(db, hasher=hasher).seed(
        [ARABIC_ONLY_DEMO], timezone=settings.seed_company_timezone, password=DEFAULT_DEMO_PASSWORD
    )
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ARABIC_DEMO_ADDRESS, None)
    assert _demo_names(db)[1] == {key: (arabic, None) for key, arabic in DEPARTMENTS.items()}


def test_seed_demo_turns_the_arabic_only_demo_into_both_languages(
    db: Session,
    settings: Settings,
    hasher: PasswordHasherService,
    make_client,
    clock: FakeClock,
    capsys,
) -> None:
    """The user's database: departments named «المالية» and so on, the address in Arabic, all from the
    seed. seed-demo gives each department its English name back with the Arabic one as `name_ar`, and the
    company the English address with the Arabic one as `address_ar`; audited without an actor, listed,
    idempotent. Visits that recorded the Arabic name alone get both where the database lets a visit
    change: SCHEDULED (D-17), and checked-in and no-show ones (the same name, now known in English).
    Checked-out and cancelled visits cannot change (`visits_terminal_immutable`) and keep what they
    recorded."""
    _seed_arabic_only_demo(db, settings, hasher)
    host_id = seed_id(DEMO_COMPANY.slug, "user", "host@demo.local")
    host = _administrator(make_client, "host@demo.local")
    reception = _administrator(make_client, "reception@demo.local")
    soon = TEST_START + timedelta(minutes=30)
    visits = {
        name: create_visit(host, host_id, start)["visit"]["id"]
        for name, start in (
            ("scheduled", TEST_START + timedelta(days=1)),
            ("inside", soon),
            ("finished", soon),
            ("cancelled", soon),
            ("no_show", TEST_START + timedelta(minutes=10)),
        )
    }
    assert check_in(reception, visits["inside"]).status_code == 200
    assert check_in(reception, visits["finished"]).status_code == 200
    assert check_out(reception, visits["finished"]).status_code == 200
    assert host.post(f"/visits/{visits['cancelled']}/cancel", json={}).status_code == 200
    clock.set(TEST_START + timedelta(hours=2, minutes=30))  # past the no-show's window
    assert cli.main(["mark-no-shows"], settings=settings) == 0
    for visit_id in visits.values():
        assert refreshed(db, Visit, visit_id).department_name == "المالية"
    capsys.readouterr()

    assert cli.main(["seed-demo"], settings=settings) == 0

    assert _demo_names(db)[1] == BILINGUAL_DEPARTMENTS
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ENGLISH_DEMO_ADDRESS, ARABIC_DEMO_ADDRESS)
    snapshots = {
        name: (
            refreshed(db, Visit, visit_id).status,
            refreshed(db, Visit, visit_id).department_name,
            refreshed(db, Visit, visit_id).department_name_ar,
        )
        for name, visit_id in visits.items()
    }
    assert snapshots == {
        "scheduled": ("SCHEDULED", "Finance", "المالية"),
        "inside": ("CHECKED_IN", "Finance", "المالية"),
        "no_show": ("NO_SHOW", "Finance", "المالية"),
        "finished": ("CHECKED_OUT", "المالية", None),
        "cancelled": ("CANCELLED", "المالية", None),
    }
    department_rows = audit_rows(db, "DEPARTMENT_UPDATED")
    assert len(department_rows) == 5
    assert all(row.actor_user_id is None for row in department_rows)
    assert {row.entity_id for row in department_rows} == {
        seed_id(DEMO_COMPANY.slug, "department", key) for key in DEPARTMENTS
    }
    assert [row.meta for row in department_rows] == [
        {"changed_fields": ["name", "name_ar"], "source": "seed"}
    ] * 5
    (company_row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)
    assert company_row.meta == {"changed_fields": ["address", "address_ar"], "source": "seed"}
    assert company_row.actor_user_id is None
    out = capsys.readouterr().out
    assert f"companies updated:   {DEMO_COMPANY.slug}" in out
    assert "departments updated: demo-company/Executive Office, demo-company/Finance, demo-company/IT" in out
    # Users keep their Arabic names: people's names stay as typed.
    assert _demo_names(db)[0] == ARABIC_DEMO_NAMES and audit_rows(db, "USER_UPDATED") == []

    # Idempotent: nothing more to do, nothing more audited.
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert len(audit_rows(db, "DEPARTMENT_UPDATED")) == 5
    assert len(audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=company.id)) == 1
    out = capsys.readouterr().out
    assert "departments updated" not in out and "companies updated" not in out


def test_seed_demo_leaves_the_arabic_only_demo_where_a_person_changed_it(
    db: Session, settings: Settings, hasher: PasswordHasherService, make_client
) -> None:
    """B10-15 on the conversion: a department a person renamed, even to the seed's own Arabic name, an
    English name another department already has, an Arabic name another department already shows, and
    an address a person typed are left alone; the rest is converted."""
    _seed_arabic_only_demo(db, settings, hasher)
    admin = _administrator(make_client, "admin@demo.local")
    department = {key: seed_id(DEMO_COMPANY.slug, "department", key) for key in DEPARTMENTS}
    # IT renamed, Executive Office renamed and back to the seed's Arabic name.
    assert admin.patch(f"/departments/{department['IT']}", json={"name": "التقنية"}).status_code == 200
    for name in ("الإدارة", "المكتب التنفيذي"):
        response = admin.patch(f"/departments/{department['Executive Office']}", json={"name": name})
        assert response.status_code == 200
    # A department a person created already has the English name of Finance.
    assert admin.post("/departments", json={"name": "finance"}).status_code == 201
    # Another department already shows the Arabic name of Operations. The API refuses that now, since
    # Operations is still named «العمليات» (B10-29), so it is a department written before that rule.
    refused = admin.post("/departments", json={"name": "Ops", "name_ar": "العمليات"})
    assert refused.status_code == 409 and refused.json()["error"]["details"] == {"field": "name_ar"}
    db.add(Department(company_id=seed_id(DEMO_COMPANY.slug), name="Ops", name_ar="العمليات"))
    db.commit()
    # The address typed in the settings, the earlier seed's own (saving the same value is no change).
    for address in ("Amman", ARABIC_DEMO_ADDRESS):
        assert admin.patch("/company/settings", json={"address": address}).status_code == 200

    assert cli.main(["seed-demo"], settings=settings) == 0

    assert _demo_names(db)[1] == {
        "IT": ("التقنية", None),
        "Executive Office": ("المكتب التنفيذي", None),
        "Finance": ("المالية", None),
        "Operations": ("Operations", None),
        "Human Resources": ("Human Resources", "الموارد البشرية"),
    }
    company = refreshed(db, Company, seed_id(DEMO_COMPANY.slug))
    assert (company.address, company.address_ar) == (ARABIC_DEMO_ADDRESS, None)
    cli_rows = [row for row in audit_rows(db, "DEPARTMENT_UPDATED") if row.actor_user_id is None]
    assert {row.entity_id: row.meta["changed_fields"] for row in cli_rows} == {
        department["Operations"]: ["name"],
        department["Human Resources"]: ["name", "name_ar"],
    }
