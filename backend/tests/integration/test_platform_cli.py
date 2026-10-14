"""The platform owner's accounts from the command line and the seeds (Phase 11, B11-3)."""

import io
import re

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import cli
from app.core.config import Settings
from app.core.time import FakeClock
from app.models import PlatformAdmin, PlatformAuditLog, PlatformSession
from app.security.passwords import PasswordHasherService, password_policy_error
from app.security.temporary_passwords import GENERATED_PASSWORD_LENGTH
from app.services.platform_bootstrap import generate_temporary_password
from app.services.seeding import DEFAULT_DEMO_PASSWORD, seed_id
from tests.support import PlatformApi, platform_audit_rows, platform_signed_in, refreshed

STDIN_PASSWORD = "Granite-Willow-Copper-47"


@pytest.fixture(autouse=True)
def _fast_hashing(monkeypatch: pytest.MonkeyPatch, hasher: PasswordHasherService) -> None:
    monkeypatch.setattr(cli, "PasswordHasherService", lambda **_kwargs: hasher)


def _admin(db: Session, email: str) -> PlatformAdmin:
    db.expire_all()
    return db.scalars(select(PlatformAdmin).where(PlatformAdmin.email == email)).one()


def test_a_generated_temporary_password_is_printed_once_and_must_be_changed(
    db: Session, settings: Settings, capsys, make_client, clock: FakeClock
) -> None:
    assert cli.main(["create-platform-admin", "--email", "Owner@Platform.Example"], settings=settings) == 0
    out = capsys.readouterr().out
    [password] = re.findall(r"temporary password \(shown once\): (\S+)", out)
    assert password_policy_error(password) is None and len(password) == GENERATED_PASSWORD_LENGTH == 32
    admin = _admin(db, "owner@platform.example")
    assert (admin.full_name, admin.must_change_password, admin.is_active) == ("Platform Owner", True, True)
    assert admin.password_expires_at is not None
    assert password not in admin.password_hash
    [row] = platform_audit_rows(db, "PLATFORM_ADMIN_CREATED", entity_id=admin.id)
    assert row.actor_platform_admin_id is None and row.meta == {"source": "cli"}
    api = platform_signed_in(make_client, admin, password)
    assert api.get("/platform/companies").status_code == 403  # PASSWORD_CHANGE_REQUIRED


def test_a_password_from_stdin_and_a_name(
    db: Session, settings: Settings, monkeypatch, capsys, make_client
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(STDIN_PASSWORD + "\r\n"))
    args = [
        "create-platform-admin",
        "--email",
        "op@platform.example",
        "--full-name",
        "Ops",
        "--password-stdin",
    ]
    assert cli.main(args, settings=settings) == 0
    out = capsys.readouterr().out
    assert "shown once" not in out and STDIN_PASSWORD not in out
    admin = _admin(db, "op@platform.example")
    assert admin.full_name == "Ops" and STDIN_PASSWORD not in admin.password_hash
    assert PlatformApi(make_client()).login(admin.email, STDIN_PASSWORD).status_code == 200


@pytest.mark.parametrize(
    ("args", "stdin", "message"),
    [
        (["--email", "not-an-address"], "", "--email"),
        (["--email", "weak@platform.example", "--password-stdin"], "short\n", "at least 12"),
        (["--email", "weak@platform.example", "--password-stdin"], "Platform-Admin-2026\n", ""),
        (["--email", "ghost@platform.example", "--reset"], "", "no platform account"),
    ],
)
def test_refusals(db: Session, settings: Settings, monkeypatch, capsys, args, stdin, message) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    assert cli.main(["create-platform-admin", *args], settings=settings) == cli.EXIT_USAGE
    assert message in capsys.readouterr().err
    assert (
        db.scalar(
            select(func.count())
            .select_from(PlatformAdmin)
            .where(PlatformAdmin.email.like("%platform.example"))
        )
        == 0
    )


def test_an_existing_account_needs_reset(db: Session, settings: Settings, capsys, make_client) -> None:
    assert cli.main(["create-platform-admin", "--email", "owner@platform.example"], settings=settings) == 0
    first = re.findall(r"shown once\): (\S+)", capsys.readouterr().out)[0]
    assert cli.main(["create-platform-admin", "--email", "owner@platform.example"], settings=settings) == 2
    assert "--reset" in capsys.readouterr().err
    admin = _admin(db, "owner@platform.example")
    api = platform_signed_in(make_client, admin, first)
    assert (
        cli.main(["create-platform-admin", "--email", "owner@platform.example", "--reset"], settings=settings)
        == 0
    )
    second = re.findall(r"shown once\): (\S+)", capsys.readouterr().out)[0]
    assert second != first
    # The reset ends the sessions and the old password.
    assert api.get("/platform/auth/me").status_code == 401
    assert PlatformApi(make_client()).login(admin.email, first).status_code == 401
    assert PlatformApi(make_client()).login(admin.email, second).status_code == 200
    stored = refreshed(db, PlatformAdmin, admin.id)
    assert stored.must_change_password is True
    [row] = platform_audit_rows(db, "PLATFORM_ADMIN_PASSWORD_SET", entity_id=admin.id)
    assert row.meta == {"revoked_sessions": 1, "source": "cli"}
    live = db.scalars(
        select(PlatformSession).where(
            PlatformSession.platform_admin_id == admin.id, PlatformSession.revoked_at.is_(None)
        )
    ).all()
    assert len(live) == 1  # the sign-in with the new password


def test_the_seeds_create_the_demo_platform_account_once(
    db: Session, settings: Settings, capsys, make_client
) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert "platform accounts created: platform@demo.local" in capsys.readouterr().out
    admin = _admin(db, "platform@demo.local")
    assert admin.id == seed_id("platform", "platform@demo.local")
    assert (admin.full_name, admin.must_change_password) == ("مالك المنصة", False)
    rows = db.scalar(select(func.count()).select_from(PlatformAuditLog))
    assert cli.main(["seed-e2e"], settings=settings) == 0
    assert "platform accounts already present (unchanged): platform@demo.local" in capsys.readouterr().out
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(PlatformAuditLog)) == rows
    api = PlatformApi(make_client())
    assert api.login("platform@demo.local", DEFAULT_DEMO_PASSWORD).status_code == 200
    assert api.get("/platform/companies").status_code == 200


def test_the_generator_always_passes_the_policy() -> None:
    passwords = {generate_temporary_password() for _ in range(50)}
    assert len(passwords) == 50
    assert all(password_policy_error(password) is None for password in passwords)
