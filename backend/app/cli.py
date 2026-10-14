"""Operational commands: `python -m app.cli <command>`.

  seed-demo         The demo company (Mawdoo3 / موضوع, Arabic by default) with departments, one user per
                    role and one multi-role user, named in Arabic, and the Mawdoo3 logo, icon and colour
                    as its own brand (refused in production)
  seed-e2e          The same company with the English names the E2E suite reads, plus "Other Corp" (one
                    user per role, no brand) for cross-tenant E2E tests (refused in production)
  create-admin      Create a SYSTEM_ADMIN (optionally with a new company); allowed in production
  create-platform-admin
                    Create the platform owner's account (or, with --reset, give it a new temporary
                    password); the temporary password is read from stdin (--password-stdin) or generated
                    and printed once, and must be changed at the first sign-in; a generated password
                    signs in even while failed sign-ins keep the account locked; allowed in production
  mark-no-shows     Mark expired SCHEDULED visits NO_SHOW in every company (contract §5)
  prune-sessions    Delete sessions that ended more than N days ago (default 30); runs as the schema
                    owner (MIGRATION_DATABASE_URL); allowed in production
  e2e-time-travel   Move one visit and its passes N minutes into the past (refused in production)
  send-test-email   Send a short test message with a sample QR code through the configured e-mail
                    provider (EMAIL_PROVIDER) and print the result; Arabic first unless
                    --language en; allowed in production

Seed users, and the platform owner's demo account platform@demo.local, share SEED_DEMO_PASSWORD (local
default: Demo-Visitor-2026). Seeding is idempotent. Seed accounts never belong in production: the API
refuses to start there on a database that holds one, and refuses their sign-in (services.seed_guard). The
commands only parse input and print results; the work happens in the service layer.
"""

import argparse
import getpass
import sys
import uuid
from collections.abc import Sequence
from datetime import timedelta

from pydantic import ValidationError

from app.core import time as app_time
from app.core.config import ConfigurationError, Settings, get_settings
from app.core.errors import validation_fields
from app.db.session import create_app_engine, create_db_engine, session_factory
from app.email.providers.base import EmailDeliveryError
from app.email.providers.factory import create_email_provider, email_configuration_warnings
from app.email.rendering import EmailRenderer
from app.email.service import TEST_EMAIL_SAMPLE_FRAGMENT, build_test_email
from app.models import DEFAULT_LANGUAGE, Language
from app.schemas.common import EmailAddress, Name200, RequestModel
from app.security.passwords import PasswordHasherService, password_policy_error
from app.services.bootstrap import AdminBootstrapService, BootstrapError
from app.services.maintenance import SESSION_RETENTION_DAYS, E2ETimeTravel, MaintenanceError, prune_sessions
from app.services.no_shows import mark_no_shows_everywhere
from app.services.platform_bootstrap import DEFAULT_FULL_NAME as DEFAULT_PLATFORM_ADMIN_NAME
from app.services.platform_bootstrap import PlatformBootstrapError, PlatformBootstrapService
from app.services.seeding import (
    DEFAULT_DEMO_PASSWORD,
    DEMO_COMPANY,
    DEMO_PLATFORM_ADMIN,
    E2E_DEMO_COMPANY,
    E2E_PLATFORM_ADMIN,
    OTHER_CORP,
    SeedCompany,
    Seeder,
    SeedPlatformAdmin,
    SeedReport,
)

EXIT_USAGE = 2
# A test e-mail gets what a real message gets: the dispatcher's per-message deadline (one attempt here).
TEST_EMAIL_DEADLINE_SECONDS = 20.0


class CommandError(Exception):
    """A user-facing failure; printed without a traceback."""


class AdminBootstrap(RequestModel):
    """create-admin input, validated by the same rules as the API (POST /users, PATCH /company/settings)."""

    email: EmailAddress
    full_name: Name200
    company_name: Name200 | None = None


_OPTIONS = {"email": "--email", "full_name": "--full-name", "company_name": "--company-name"}


def _bootstrap_input(args: argparse.Namespace) -> AdminBootstrap:
    try:
        return AdminBootstrap(email=args.email, full_name=args.full_name, company_name=args.company_name)
    except ValidationError as exc:
        problems = validation_fields(exc.errors())
        raise CommandError(
            "; ".join(f"{_OPTIONS.get(field, field)}: {message}" for field, message in problems.items())
        ) from None


def _connect(settings: Settings) -> None:
    session_factory.configure(create_app_engine(settings))


def _refuse_in_production(settings: Settings, command: str) -> None:
    if settings.is_production:
        raise CommandError(f"{command} is not available when APP_ENV=production")


def _seed_password(settings: Settings) -> str:
    password = (
        settings.seed_demo_password.get_secret_value()
        if settings.seed_demo_password
        else DEFAULT_DEMO_PASSWORD
    )
    # The published demo password ("Demo-Visitor-2026") is built from common words on purpose: seeding is
    # refused in production, and only the length and breached-password rules apply to it.
    problem = password_policy_error(password, dictionary=False)
    if problem is not None:
        raise CommandError(f"SEED_DEMO_PASSWORD is not acceptable: {problem.message}")
    return password


def _print_report(report: SeedReport) -> None:
    print(f"companies created:   {', '.join(report.companies_created) or '-'}")
    print(f"departments created: {len(report.departments_created)}")
    print(f"users created:       {', '.join(report.users_created) or '-'}")
    if report.companies_updated:
        print(f"companies updated:   {', '.join(report.companies_updated)}")
    if report.companies_branded:
        # The demo company's logo, icon and colour (B12-15).
        print(f"companies branded:   {', '.join(report.companies_branded)}")
    # Keys and addresses only (ASCII): a Windows console may not print the Arabic names (B10-20).
    if report.departments_updated:
        print(f"departments updated: {', '.join(report.departments_updated)}")
    if report.users_updated:
        print(f"users updated:       {', '.join(report.users_updated)}")
    if report.users_skipped:
        print(f"users already present (unchanged): {', '.join(report.users_skipped)}")
    if report.platform_admins_created:
        print(f"platform accounts created: {', '.join(report.platform_admins_created)}")
    if report.platform_admins_skipped:
        print(f"platform accounts already present (unchanged): {', '.join(report.platform_admins_skipped)}")


def _seed(
    settings: Settings, specs: Sequence[SeedCompany], platform_admin: SeedPlatformAdmin, command: str
) -> None:
    _refuse_in_production(settings, command)
    password = _seed_password(settings)
    _connect(settings)
    with session_factory() as db:
        # Rows a seed writes say so (B11-36): "seed", not the "cli" of create-admin.
        report = Seeder(db, hasher=PasswordHasherService(max_concurrency=1), source="seed").seed(
            specs,
            timezone=settings.seed_company_timezone,
            password=password,
            platform_admins=(platform_admin,),
        )
    _print_report(report)


def _read_password(from_stdin: bool) -> str:
    if from_stdin:
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass("Password: ")
    if first != getpass.getpass("Repeat password: "):
        raise CommandError("passwords do not match")
    return first


def _create_admin(settings: Settings, args: argparse.Namespace) -> None:
    data = _bootstrap_input(args)
    password = _read_password(args.password_stdin)
    _connect(settings)
    with session_factory() as db:
        service = AdminBootstrapService(db, hasher=PasswordHasherService(max_concurrency=1))
        try:
            admin = service.bootstrap_admin(
                email=data.email,
                full_name=data.full_name,
                password=password,
                company_slug=args.company_slug,
                company_name=data.company_name,
                timezone=args.timezone or settings.seed_company_timezone,
            )
        except BootstrapError as exc:
            raise CommandError(str(exc)) from None
    print(f"created administrator {admin.email} in company {admin.company_slug} ({admin.company_id})")


class PlatformAdminInput(RequestModel):
    """create-platform-admin input, validated by the API's rules for an address and a name."""

    email: EmailAddress
    full_name: Name200


def _create_platform_admin(settings: Settings, args: argparse.Namespace) -> None:
    if args.reset and args.full_name is not None:
        # It used to be ignored without a word. A reset is the account's recovery: it changes the
        # password and nothing else.
        raise CommandError(
            "--full-name cannot be used with --reset: a reset gives the account a new temporary password "
            "and changes nothing else"
        )
    try:
        data = PlatformAdminInput(email=args.email, full_name=args.full_name or DEFAULT_PLATFORM_ADMIN_NAME)
    except ValidationError as exc:
        problems = validation_fields(exc.errors())
        raise CommandError(
            "; ".join(f"{_OPTIONS.get(field, field)}: {message}" for field, message in problems.items())
        ) from None
    # None: the service generates the temporary password (and only then gives it a budget of its own).
    supplied = sys.stdin.readline().rstrip("\r\n") if args.password_stdin else None
    _connect(settings)
    with session_factory() as db:
        service = PlatformBootstrapService(db, hasher=PasswordHasherService(max_concurrency=1))
        try:
            if args.reset:
                account = service.reset(email=data.email, password=supplied)
            else:
                account = service.create(email=data.email, full_name=data.full_name, password=supplied)
        except PlatformBootstrapError as exc:
            raise CommandError(str(exc)) from None
    verb = "created platform account" if account.created else "new temporary password for platform account"
    print(f"{verb} {account.email} ({account.admin_id})")
    if account.generated_password is not None:
        # Printed once: it is stored only as a hash. It expires in 72 hours and must be changed at the
        # first sign-in (/platform/login).
        print(f"temporary password (shown once): {account.generated_password}")
    print("the password must be changed at the first sign-in and expires in 72 hours")
    if account.generated_password is not None:
        # B11-35: a generated password has a failure budget of its own.
        print(
            "this password signs in even while the account is locked by failed sign-ins: "
            "it has a failure budget of its own"
        )


def _mark_no_shows(settings: Settings) -> None:
    _connect(settings)
    with session_factory() as db:
        counts = mark_no_shows_everywhere(db, now=app_time.now())
    print(f"visits marked NO_SHOW: {sum(counts.values())} (companies checked: {len(counts)})")


def _prune_sessions(settings: Settings, args: argparse.Namespace) -> None:
    engine = create_db_engine(settings.migration_url, pool_size=1, application_name="vms-maintenance")
    try:
        deleted = prune_sessions(engine, now=app_time.now(), older_than=timedelta(days=args.older_than_days))
    except MaintenanceError as exc:
        raise CommandError(str(exc)) from None
    finally:
        engine.dispose()
    print(f"sessions deleted: {deleted} (ended more than {args.older_than_days} days ago)")


def _visit_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise argparse.ArgumentTypeError("expected a visit ID (UUID)") from None


def _time_travel(settings: Settings, args: argparse.Namespace) -> None:
    _refuse_in_production(settings, "e2e-time-travel")
    _connect(settings)
    with session_factory() as db:
        try:
            shifted = E2ETimeTravel(db, settings=settings).shift_into_past(args.visit_id, args.minutes)
        except MaintenanceError as exc:
            raise CommandError(str(exc)) from None
    print(
        f"visit {shifted.visit_id} ({shifted.status}) moved {args.minutes} minutes into the past: "
        f"starts {shifted.scheduled_start.isoformat()}, pass window ends {shifted.window_end.isoformat()}"
    )


def _send_test_email(settings: Settings, args: argparse.Namespace) -> None:
    """One attempt through the configured provider, without the database (nothing is stored or audited:
    S10-6). Prints where the message went or the classified error; never a credential."""
    for warning in email_configuration_warnings(settings):
        print(f"warning: {warning}", file=sys.stderr)
    try:
        email = build_test_email(
            settings, EmailRenderer(), args.to, now=app_time.now(), language=Language(args.language)
        )
    except ValueError as exc:
        raise CommandError(f"--to: {exc}") from None
    try:
        provider = create_email_provider(settings)
    except ConfigurationError as exc:
        raise CommandError(str(exc)) from None
    try:
        result = provider.send(email, timeout_seconds=TEST_EMAIL_DEADLINE_SECONDS)
    except EmailDeliveryError as exc:
        kind = "temporary: a real message would be retried" if exc.transient else "permanent"
        raise CommandError(f"test e-mail not sent ({kind}): {exc}") from None
    match settings.email_provider:
        case "smtp":
            print(
                f"test e-mail to {email.to} accepted by the mail server {settings.smtp_host}:"
                f"{settings.smtp_server_port} ({settings.smtp_security})"
            )
        case "resend":
            print(f"test e-mail to {email.to} accepted by Resend")
        case "outbox":
            print(f"test e-mail written to {settings.email_outbox_dir} (EMAIL_PROVIDER=outbox sends nothing)")
        case _:
            print(f"test e-mail kept by the {provider.name} provider (nothing is sent)")
    if result.provider_message_id:
        print(f"message id: {result.provider_message_id}")
    print(f"its sample QR code opens {settings.pass_url_base}#{TEST_EMAIL_SAMPLE_FRAGMENT}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed-demo", help="seed the demo company (non-production)")
    commands.add_parser("seed-e2e", help="seed the demo company and Other Corp (non-production)")
    admin = commands.add_parser("create-admin", help="create a SYSTEM_ADMIN user")
    admin.add_argument("--email", required=True)
    admin.add_argument("--full-name", required=True)
    admin.add_argument("--company-slug", required=True, help="existing company, or the slug for a new one")
    admin.add_argument("--company-name", help="create the company with this name if the slug is unknown")
    admin.add_argument("--timezone", help="IANA timezone for a new company (default SEED_COMPANY_TIMEZONE)")
    admin.add_argument(
        "--password-stdin", action="store_true", help="read the password from stdin instead of prompting"
    )
    platform = commands.add_parser(
        "create-platform-admin", help="create the platform owner's account (or reset its password)"
    )
    platform.add_argument("--email", required=True)
    platform.add_argument(
        "--full-name",
        help=f"the new account's name (default: {DEFAULT_PLATFORM_ADMIN_NAME}); not with --reset",
    )
    platform.add_argument(
        "--password-stdin",
        action="store_true",
        help="read the temporary password from stdin instead of generating one and printing it once",
    )
    platform.add_argument(
        "--reset",
        action="store_true",
        help="give an existing platform account a new temporary password and end its sessions; "
        "a generated password also signs in while the account is locked by failed sign-ins",
    )
    commands.add_parser("mark-no-shows", help="mark expired SCHEDULED visits NO_SHOW (all companies)")
    prune = commands.add_parser("prune-sessions", help="delete sessions that ended long ago (schema owner)")
    prune.add_argument(
        "--older-than-days",
        type=int,
        default=SESSION_RETENTION_DAYS,
        help=f"keep sessions that ended within this many days (default {SESSION_RETENTION_DAYS})",
    )
    travel = commands.add_parser(
        "e2e-time-travel", help="move a visit and its passes into the past (non-production, E2E tests)"
    )
    travel.add_argument("--visit-id", required=True, type=_visit_id)
    travel.add_argument("--minutes", required=True, type=int, help="how far into the past, in minutes")
    test_email = commands.add_parser(
        "send-test-email", help="send a test message through the configured e-mail provider"
    )
    test_email.add_argument("--to", required=True, help="the address to send the test message to")
    test_email.add_argument(
        "--language",
        choices=[language.value for language in Language],
        default=DEFAULT_LANGUAGE.value,
        help="the language the message leads with; the other follows (default: ar)",
    )
    return parser


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = settings or get_settings()
    try:
        match args.command:
            case "seed-demo":
                _seed(settings, (DEMO_COMPANY,), DEMO_PLATFORM_ADMIN, args.command)
            case "seed-e2e":
                _seed(settings, (E2E_DEMO_COMPANY, OTHER_CORP), E2E_PLATFORM_ADMIN, args.command)
            case "create-admin":
                _create_admin(settings, args)
            case "create-platform-admin":
                _create_platform_admin(settings, args)
            case "mark-no-shows":
                _mark_no_shows(settings)
            case "prune-sessions":
                _prune_sessions(settings, args)
            case "e2e-time-travel":
                _time_travel(settings, args)
            case "send-test-email":
                _send_test_email(settings, args)
    except CommandError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    return 0


if __name__ == "__main__":
    sys.exit(main())
