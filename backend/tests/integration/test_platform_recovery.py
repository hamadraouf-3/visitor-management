"""Recovering a platform account that strangers keep locked (Phase 11 security review, B11-35).

Anyone who knows a platform account's address can spend its sign-in budget (ten failures, then fifteen
minutes of 429 for every browser that is not trusted). A platform account has no forgot-password: the
operator's `create-platform-admin --reset` is its recovery. Before the fix the reset made things worse:
it ended every browser's device trust, and the account's budget, counted in the API process, stayed
spent, so the owner could not sign in with the new temporary password either.

Now a reset starts the budgets clean (they are keyed by the account's device-trust epoch), and a generated
temporary password has a failure budget of its own, so whoever holds it signs in whatever strangers do.
"""

import io
import re

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import cli
from app.core.config import Settings
from app.models import PlatformAdmin
from app.security.passwords import PasswordHasherService, password_policy_error
from app.security.temporary_passwords import (
    GENERATED_PASSWORD_LENGTH,
    TAGGED_LENGTH,
    generate_temporary_password,
    holds_temporary_password,
    temporary_password_tag,
)
from tests.support import (
    PlatformApi,
    error_code,
    platform_audit_rows,
    rate_limits,
    refreshed,
)

EMAIL = "owner@platform.example"
OWN_PASSWORD = "Quartz-Harbor-Violet-93"
SECOND_PASSWORD = "Indigo-Walrus-Meadow-58"
STDIN_PASSWORD = "Granite-Willow-Copper-47"
WRONG = "Wrong-Password-1234"


@pytest.fixture(autouse=True)
def _fast_hashing(monkeypatch: pytest.MonkeyPatch, hasher: PasswordHasherService) -> None:
    monkeypatch.setattr(cli, "PasswordHasherService", lambda **_kwargs: hasher)


def _cli(settings: Settings, capsys, *args: str) -> str:
    """Run create-platform-admin and return the generated temporary password it printed."""
    assert cli.main(["create-platform-admin", "--email", EMAIL, *args], settings=settings) == 0
    [password] = re.findall(r"temporary password \(shown once\): (\S+)", capsys.readouterr().out)
    return password


def _admin(db: Session) -> PlatformAdmin:
    db.expire_all()
    return db.scalars(select(PlatformAdmin).where(PlatformAdmin.email == EMAIL)).one()


def _strangers_lock_the_account(make_client, *, network: int) -> None:
    """Ten failures from ten addresses, then the account is blocked for browsers it does not know."""
    for host in range(1, 11):
        stranger = PlatformApi(make_client(client=(f"198.51.{network}.{host}", 50000)))
        assert stranger.login(EMAIL, WRONG).status_code == 401
    blocked = PlatformApi(make_client(client=(f"198.51.{network}.99", 50000))).login(EMAIL, WRONG)
    assert blocked.status_code == 429 and error_code(blocked) == "RATE_LIMITED"


def _change(api: PlatformApi, current: str, new: str):
    return api.post("/platform/auth/change-password", json={"current_password": current, "new_password": new})


def _owner_with_a_trusted_browser(settings: Settings, capsys, make_client) -> PlatformApi:
    temporary = _cli(settings, capsys)
    browser = PlatformApi(make_client())
    assert browser.login(EMAIL, temporary).status_code == 200
    assert _change(browser, temporary, OWN_PASSWORD).status_code == 204
    return browser


# ---- the reviewer's scenario ---------------------------------------------------------------------------


def test_a_reset_recovers_an_account_that_strangers_keep_locked(
    db: Session, settings: Settings, capsys, make_client
) -> None:
    trusted = _owner_with_a_trusted_browser(settings, capsys, make_client)
    _strangers_lock_the_account(make_client, network=100)
    # As before: another browser is blocked even with the right password, the trusted one is not.
    assert PlatformApi(make_client()).login(EMAIL, OWN_PASSWORD).status_code == 429
    assert trusted.login(EMAIL, OWN_PASSWORD).status_code == 200

    # The password is lost: the operator resets it. Every browser's trust ends with the old password.
    temporary = _cli(settings, capsys, "--reset")
    # The strangers go on, and lock the account again at once.
    _strangers_lock_the_account(make_client, network=101)

    # The owner signs in with the new temporary password all the same: from a browser that was never
    # trusted, and from the one that was.
    new_browser = PlatformApi(make_client(client=("203.0.113.77", 50000)))
    response = new_browser.login(EMAIL, temporary)
    assert response.status_code == 200, response.text
    assert trusted.login(EMAIL, temporary).status_code == 200
    # ... and completes the forced change, after which that browser is trusted like any other.
    assert new_browser.get("/platform/companies").status_code == 403
    assert _change(new_browser, temporary, SECOND_PASSWORD).status_code == 204
    assert new_browser.get("/platform/companies").status_code == 200
    assert new_browser.post("/platform/auth/logout").status_code == 204
    _strangers_lock_the_account(make_client, network=102)
    assert new_browser.login(EMAIL, SECOND_PASSWORD).status_code == 200
    # Nothing got easier for the strangers: the account is still blocked for them, the old passwords
    # are dead, and the temporary one died with the change.
    for password in (OWN_PASSWORD, temporary, SECOND_PASSWORD):
        assert (
            PlatformApi(make_client(client=("198.51.103.1", 50000))).login(EMAIL, password).status_code == 429
        )
    assert _admin(db).temporary_password_tag is None


def test_a_new_account_can_be_reached_although_its_address_is_under_attack(
    db: Session, settings: Settings, capsys, make_client
) -> None:
    temporary = _cli(settings, capsys)
    _strangers_lock_the_account(make_client, network=100)  # before the owner ever signed in
    assert PlatformApi(make_client()).login(EMAIL, temporary).status_code == 200


def test_a_reset_starts_the_account_s_budget_clean_whatever_the_password(
    db: Session, settings: Settings, capsys, make_client, monkeypatch
) -> None:
    """A password the operator typed has no budget of its own, but the reset still lifts the block that
    was there: the account's budget is keyed by its device-trust epoch, which the reset renews."""
    _owner_with_a_trusted_browser(settings, capsys, make_client)
    _strangers_lock_the_account(make_client, network=100)
    monkeypatch.setattr("sys.stdin", io.StringIO(STDIN_PASSWORD + "\n"))
    args = ["create-platform-admin", "--email", EMAIL, "--reset", "--password-stdin"]
    assert cli.main(args, settings=settings) == 0
    assert _admin(db).temporary_password_tag is None
    assert PlatformApi(make_client()).login(EMAIL, STDIN_PASSWORD).status_code == 200
    # Without a budget of its own the strangers can lock it out again (the generated password is the
    # one that cannot be).
    _strangers_lock_the_account(make_client, network=101)
    assert PlatformApi(make_client()).login(EMAIL, STDIN_PASSWORD).status_code == 429


# ---- the temporary password's own budget -----------------------------------------------------------


def test_the_budget_of_a_temporary_password_is_a_budget(
    db: Session, settings: Settings, capsys, make_client
) -> None:
    """Brute-force protection is not weaker: whoever knows the tagged characters has ten guesses at the
    rest, then that password is blocked as well; nobody else is on that budget."""
    temporary = _cli(settings, capsys)
    admin = _admin(db)
    _strangers_lock_the_account(make_client, network=100)
    # A password that only looks like one of the CLI's is judged by the account's budget: blocked.
    lookalike = generate_temporary_password()
    assert lookalike[:TAGGED_LENGTH] != temporary[:TAGGED_LENGTH]
    assert PlatformApi(make_client(client=("198.51.104.1", 50000))).login(EMAIL, lookalike).status_code == 429
    # The right first characters and a wrong rest: an ordinary failure, ten times.
    near = temporary[:TAGGED_LENGTH] + "x" * (GENERATED_PASSWORD_LENGTH - TAGGED_LENGTH)
    for host in range(1, 11):
        guesser = PlatformApi(make_client(client=(f"198.51.105.{host}", 50000)))
        assert guesser.login(EMAIL, near).status_code == 401
    # Then the temporary password itself is blocked for fifteen minutes.
    response = PlatformApi(make_client()).login(EMAIL, temporary)
    assert response.status_code == 429 and int(response.headers["retry-after"]) > 0
    throttled = platform_audit_rows(db, "AUTH_ACCOUNT_THROTTLED", actor_platform_admin_id=admin.id)
    assert [row.meta["policy"] for row in throttled] == ["login_failures_account", "login_failures_device"]


def test_the_tag_ends_with_the_temporary_password(
    db: Session, settings: Settings, capsys, make_client, clock
) -> None:
    temporary = _cli(settings, capsys)
    admin = _admin(db)
    assert len(temporary) == GENERATED_PASSWORD_LENGTH == 32 and password_policy_error(temporary) is None
    tag = admin.temporary_password_tag
    assert tag is not None and len(tag) == 64 and tag == temporary_password_tag(admin.id, temporary)
    assert temporary[:TAGGED_LENGTH] not in tag and temporary not in admin.password_hash
    assert holds_temporary_password(admin, temporary, now=clock.now())
    # Another first character (a generated password may itself start with "x").
    other_first = "y" if temporary.startswith("x") else "x"
    assert not holds_temporary_password(admin, other_first + temporary[1:], now=clock.now())
    assert not holds_temporary_password(admin, temporary[: TAGGED_LENGTH - 1], now=clock.now())
    # Another account's tag of the same characters is another tag.
    other = PlatformAdmin(email="other@platform.example", full_name="Other", password_hash="x")
    db.add(other)
    db.commit()
    assert temporary_password_tag(other.id, temporary) != tag
    # The forced change ends it; so does the temporary password's expiry.
    browser = PlatformApi(make_client())
    assert browser.login(EMAIL, temporary).status_code == 200
    assert _change(browser, temporary, OWN_PASSWORD).status_code == 204
    assert refreshed(db, PlatformAdmin, admin.id).temporary_password_tag is None
    second = _cli(settings, capsys, "--reset")
    admin = _admin(db)
    assert admin.temporary_password_tag not in (None, tag)
    assert holds_temporary_password(admin, second, now=clock.now())
    clock.advance(hours=72, seconds=1)
    assert not holds_temporary_password(admin, second, now=clock.now())


def test_the_database_keeps_a_tag_only_beside_a_temporary_password(db: Session, factory) -> None:
    from sqlalchemy.exc import IntegrityError

    admin = factory.platform_admin()
    admin.temporary_password_tag = "0" * 64  # `must_change_password` is false
    with pytest.raises(IntegrityError, match="ck_platform_admins_temporary_password_tag_is_temporary"):
        db.commit()
    db.rollback()


# ---- the forced change after a reset ---------------------------------------------------------------------


def test_a_spent_budget_of_wrong_current_passwords_does_not_block_the_change_after_a_reset(
    db: Session, settings: Settings, capsys, make_client
) -> None:
    browser = _owner_with_a_trusted_browser(settings, capsys, make_client)
    for _ in range(5):  # RATE_LIMIT_PASSWORD_CHANGE_PER_USER: the fifth also ends the session
        assert _change(browser, WRONG, SECOND_PASSWORD).status_code == 400
    assert browser.get("/platform/auth/me").status_code == 401
    assert browser.login(EMAIL, OWN_PASSWORD).status_code == 200
    assert _change(browser, OWN_PASSWORD, SECOND_PASSWORD).status_code == 429  # spent, as before

    temporary = _cli(settings, capsys, "--reset")
    assert browser.login(EMAIL, temporary).status_code == 200
    response = _change(browser, temporary, SECOND_PASSWORD)
    assert response.status_code == 204, response.text


def test_the_forced_change_is_outside_the_budget_of_changes(
    app: FastAPI, db: Session, settings: Settings, capsys, make_client
) -> None:
    """The change that completes an operator's reset happens once per reset, so the budget that stops a
    credential holder from changing the password back and forth (SEC-43) neither counts nor refuses it."""
    browser = _owner_with_a_trusted_browser(settings, capsys, make_client)
    with rate_limits(app, password_changes_per_user=1):
        assert _change(browser, OWN_PASSWORD, SECOND_PASSWORD).status_code == 204  # the hour's one change
        assert _change(browser, SECOND_PASSWORD, OWN_PASSWORD).status_code == 429
        temporary = _cli(settings, capsys, "--reset")
        assert browser.login(EMAIL, temporary).status_code == 200
        response = _change(browser, temporary, OWN_PASSWORD)
        assert response.status_code == 204, response.text
        # A change of the owner's own choice is still within the budget.
        assert _change(browser, OWN_PASSWORD, SECOND_PASSWORD).status_code == 429


# ---- the command's own rules -------------------------------------------------------------------------------


def test_a_reset_does_not_take_a_name(db: Session, settings: Settings, capsys) -> None:
    """`--reset --full-name N` silently ignored the name; the combination is refused instead."""
    assert (
        cli.main(["create-platform-admin", "--email", EMAIL, "--full-name", "First"], settings=settings) == 0
    )
    capsys.readouterr()
    before = _admin(db)
    args = ["create-platform-admin", "--email", EMAIL, "--reset", "--full-name", "Second Name"]
    assert cli.main(args, settings=settings) == cli.EXIT_USAGE
    captured = capsys.readouterr()
    assert "--full-name" in captured.err and "--reset" in captured.err and "shown once" not in captured.out
    after = _admin(db)
    assert (after.full_name, after.password_hash) == ("First", before.password_hash)
    assert platform_audit_rows(db, "PLATFORM_ADMIN_PASSWORD_SET") == []


def test_a_reset_checks_the_password_against_the_account_s_own_name(
    db: Session, settings: Settings, capsys, monkeypatch
) -> None:
    args = ["create-platform-admin", "--email", EMAIL, "--full-name", "Zainab Marwan"]
    assert cli.main(args, settings=settings) == 0
    capsys.readouterr()
    monkeypatch.setattr("sys.stdin", io.StringIO("Zainab-Marwan-2026!!\n"))
    reset = ["create-platform-admin", "--email", EMAIL, "--reset", "--password-stdin"]
    assert cli.main(reset, settings=settings) == cli.EXIT_USAGE
    assert "too easy to guess" in capsys.readouterr().err
    assert platform_audit_rows(db, "PLATFORM_ADMIN_PASSWORD_SET") == []


def test_what_the_command_prints(db: Session, settings: Settings, capsys, monkeypatch) -> None:
    assert cli.main(["create-platform-admin", "--email", EMAIL], settings=settings) == 0
    out = capsys.readouterr().out
    assert out.count("temporary password (shown once): ") == 1
    assert "expires in 72 hours" in out and "even while the account is locked" in out
    monkeypatch.setattr("sys.stdin", io.StringIO(STDIN_PASSWORD + "\n"))
    assert (
        cli.main(
            ["create-platform-admin", "--email", EMAIL, "--reset", "--password-stdin"], settings=settings
        )
        == 0
    )
    out = capsys.readouterr().out
    assert "shown once" not in out and STDIN_PASSWORD not in out
    assert "even while the account is locked" not in out  # only a generated password has that
