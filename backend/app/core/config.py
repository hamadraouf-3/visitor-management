"""Application settings (environment variables / `.env`).

All configuration is read here once; nothing else reads `os.environ` (here only libpq's own PGSSLMODE,
PGHOST, PGHOSTADDR, PGSERVICE, PGUSER and PGPASSWORD, which decide how and as whom the database is
reached). Production refuses unsafe combinations at startup instead of running with a weakened security
posture.
"""

import hashlib
import os
import re
import unicodedata
from email.utils import parseaddr
from functools import lru_cache
from ipaddress import IPv4Network, IPv6Network, ip_address, ip_network
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import unquote, urlsplit
from zoneinfo import available_timezones

from pydantic import Field, SecretStr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from app.core.text import normalise_domain_name
from app.security.secret_strength import is_strong_secret

API_PREFIX = "/api/v1"

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent
# Runtime artefacts (the development e-mail outbox): git-ignored as a whole.
VAR_DIR = BACKEND_DIR / "var"

# Local-development default only (used when SECRET_KEY is unset or empty); production refuses it.
DEV_SECRET_KEY = "dev-only-insecure-secret-key-change-me-0000000000"  # noqa: S105 - refused in production
# Placeholder-like words: a copied template value ("replace-with-…") must never pass as a real key.
_WEAK_SECRET_MARKERS = (
    "change-me",
    "changeme",
    "insecure",
    "secret-key",
    "password",
    "example",
    "replace",
    "placeholder",
)
# The length of `secrets.token_urlsafe(32)` (256 bits); the template's generator gives 64 characters.
MIN_PRODUCTION_SECRET_LENGTH = 43
# The widest network TRUSTED_PROXIES may list in production. Every hop inside it may set the client
# address (X-Forwarded-For) and the request ID, so a catch-all (0.0.0.0/0, ::/0, or the two /1 halves)
# would let any client choose its own address in audit rows and rotate past the per-IP limits.
MIN_PROXY_PREFIX = {4: 8, 6: 32}
# Passwords of the local database roles published in .env.example and scripts/db.ps1. Production refuses
# them wherever libpq would take them from: here from the URL and PGPASSWORD, and at startup from the
# connection itself, which also covers a password file and a connection service (`db.privileges`).
PUBLISHED_DB_PASSWORD_MARKERS: tuple[str, ...] = ("local_dev",)
# SHA-256 digests of SECRET_KEY values that were published as production-valid keys: the test suite's
# former fixed keys, quoted in the security audit's report (SEC-47). The tests now generate their keys.
_PUBLISHED_SECRET_KEY_DIGESTS = frozenset(
    {
        "b12419b61003e9c0bab9811c707747ce32344b8c85d712559c0ed621844e6acd",
        "3d666ae5e870a1810e585947a4445d4678293904caf32914cca577d98f209d07",
    }
)
# Production ceilings of the limits that bound password guessing, account-recovery abuse and probing for
# accounts (§7.3; SEC-46): ten times the default. Above that a limit no longer limits anything, which is
# what RATE_LIMIT_ENABLED=false (refused in production) does openly. The two refusal budgets of POST /users
# are the only control on the deferred SEC-05 existence check (an address taken in any company). Throughput
# budgets (API, scans, invitations, sign-ins, ...) are tuned upward for large sites and have no ceiling.
PRODUCTION_LIMIT_CEILING_FACTOR = 10
GUESSING_LIMITS = (
    "rate_limit_login_per_ip_email",
    "rate_limit_login_per_ip",
    "rate_limit_login_per_account",
    "rate_limit_login_per_prefix",
    "rate_limit_password_change_per_user",
    "rate_limit_forgot_per_email",
    "rate_limit_forgot_per_ip",
    "rate_limit_forgot_per_prefix",
    "rate_limit_reset_per_ip",
    "rate_limit_reset_per_prefix",
    "rate_limit_user_email_refusals_per_hour",
    "rate_limit_user_email_refusals_per_company_per_hour",
    # Probing for companies (B12-9): the public identity endpoints answer whether a slug names an active
    # company, to anyone.
    "rate_limit_public_brand_per_ip",
    "rate_limit_public_brand_per_prefix",
)
# Production floors of the limiter's caps on buckets keyed by anonymous input: a tenth of the default. A
# full cap admits new keys untracked (B1-66), so a tiny cap (the field accepts 100) would let about a
# hundred source addresses switch the per-address, per-prefix and per-(address, e-mail) login and recovery
# limits off for every later client, leaving only the per-account lockout.
PRODUCTION_BUCKET_FLOOR_DIVISOR = 10
# Production ceilings of the platform owner's session lifetimes (B11-6): the account manages every company.
PLATFORM_SESSION_MAX_AGE_HOURS_CEILING = 12
PLATFORM_SESSION_IDLE_MINUTES_CEILING = 60
BUCKET_CAPS = ("rate_limit_max_network_buckets", "rate_limit_max_email_buckets")
# libpq modes that verify the database server's certificate (SEC-40); `require` encrypts but accepts any
# certificate, so a man in the middle can still read and change the traffic.
VERIFYING_SSL_MODES = frozenset({"verify-ca", "verify-full"})
DATABASE_URL_SYNTAX = (
    "database URLs must be unambiguous: percent-encode the characters @ : / ? # [ ] and % in the user "
    "name and password (urllib.parse.quote(password, safe=''))"
)

_ROLE_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
_LOG_LEVELS = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
# SMTP_HOST: a DNS name (one label is fine: `localhost`, a compose service such as `mailpit`), in ASCII.
_SMTP_HOST_NAME = re.compile(
    r"(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?",
    re.ASCII,
)
# What Python's SMTP client can send in AUTH: it encodes the user name and password as ASCII.
_SMTP_CREDENTIAL = re.compile(r"[\x20-\x7e]+", re.ASCII)
# A Gmail App Password as Google shows it: 16 letters, in groups of four separated by spaces.
_GMAIL_APP_PASSWORD = re.compile(r"[a-z]{4}(?: ?[a-z]{4}){3}", re.ASCII | re.IGNORECASE)

# Names people see (B10-5, B10-16), one per language:
# - the PRODUCT is this software: the footer of its own test e-mail ("Sent by Mawdoo3 Visitors"), the
#   default sender name (EMAIL_FROM) and the OpenAPI title;
# - the BRAND is the organisation whose logo that test e-mail carries: the logo's text alternative.
# No e-mail to a company's staff or visitors shows either (B12-12, B12-22): those are the company's own.
# A company (tenant) is a database row with its own `name` and `name_ar`, never a setting.
# One line of visible text: no control, format (bidi, zero-width), separator or unassigned characters,
# which would hide or reorder text in a subject line or a heading.
DEFAULT_BRAND_NAME_AR = "موضوع"  # "Mawdoo3" in Arabic
DEFAULT_BRAND_NAME_EN = "Mawdoo3"
DEFAULT_PRODUCT_NAME_AR = "زوار موضوع"  # "Mawdoo3 Visitors" in Arabic
DEFAULT_PRODUCT_NAME_EN = "Mawdoo3 Visitors"
BRAND_NAME_MAX_LENGTH = 60
_INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})

AppEnv = Literal["development", "test", "production"]
EmailProviderName = Literal["resend", "smtp", "outbox", "memory"]
# How the SMTP provider protects the connection (S10-2): STARTTLS on the submission port, TLS from the first
# byte (implicit TLS, "SMTPS"), or nothing at all (local capture servers; refused in production).
SmtpSecurity = Literal["starttls", "ssl", "none"]
SMTP_DEFAULT_PORTS: dict[SmtpSecurity, int] = {"starttls": 587, "ssl": 465, "none": 25}
GMAIL_SMTP_HOST = "smtp.gmail.com"
IPNetwork = IPv4Network | IPv6Network


class ConfigurationError(RuntimeError):
    """Raised when the configuration is unusable (e.g. unsafe settings in production)."""


def _split_csv(value: object) -> object:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


def _normalise_origin(origin: str) -> str:
    """Return `scheme://host[:port]` in lowercase; raise ValueError for anything else."""
    if origin == "*":
        raise ValueError("'*' is not allowed in ALLOWED_ORIGINS; list each origin explicitly")
    parts = urlsplit(origin.strip())
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ValueError(f"invalid origin {origin!r}: expected scheme://host[:port]")
    if parts.path not in {"", "/"} or parts.query or parts.fragment or parts.username or parts.password:
        raise ValueError(f"invalid origin {origin!r}: an origin has no path, query, fragment or credentials")
    host = parts.hostname.lower()
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    default_port = 443 if parts.scheme == "https" else 80
    port = f":{parts.port}" if parts.port and parts.port != default_port else ""
    return f"{parts.scheme}://{host}{port}"


def normalise_origin(origin: str) -> str | None:
    """Normalise a request `Origin` header value for comparison; None when it is not a valid origin."""
    try:
        return _normalise_origin(origin)
    except ValueError:
        return None


def _psycopg_url(url: str) -> str:
    """Accept plain `postgresql://` URLs but always drive them with psycopg 3."""
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    if not url.startswith("postgresql+psycopg://"):
        raise ValueError("database URLs must use PostgreSQL (postgresql+psycopg://...)")
    return url


def parse_database_url(url: str) -> URL:
    """`url` as the engine reads it (SQLAlchemy's `make_url`, SEC-36).

    Refused, without the value being echoed, when it cannot be parsed or when the standard URL parser
    reads its user name, password, host or port differently. The two disagree only on unencoded reserved
    characters in the credentials: with an "@" in the password the engine takes the rest of the password
    for the host name, which the driver's connection error then prints to the startup log, and the checks
    of the credentials below would inspect other values than the ones used to connect."""
    try:
        engine = make_url(url)
        standard = urlsplit(url)
        read_by_standard = (
            unquote(standard.username) if standard.username is not None else None,
            unquote(standard.password) if standard.password is not None else None,
            standard.hostname,
            standard.port,
        )
    except ArgumentError, ValueError:
        raise ValueError(DATABASE_URL_SYNTAX) from None
    host = engine.host.lower() if engine.host else None
    read_by_engine = (engine.username, engine.password, host, engine.port)
    if read_by_engine != read_by_standard:
        raise ValueError(DATABASE_URL_SYNTAX)
    return engine


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        # A rejected setting must not be printed back: a startup error (stderr, then central logging)
        # would otherwise carry `input_value=<the database URL with its password>` (SEC-17).
        hide_input_in_errors=True,
    )

    # Required: a deployment that forgets APP_ENV must not start with the development posture
    # (dev SECRET_KEY, outbox e-mail, open API docs) and production checks switched off.
    app_env: AppEnv

    # Runtime role (DML only). Migrations use the owner role. Secrets: they carry the role passwords, so
    # `repr(settings)` masks them; `.get_secret_value()` only where an engine is created.
    database_url: SecretStr
    migration_database_url: SecretStr | None = None
    db_app_role: str = "vms_app"
    db_pool_size: int = Field(default=10, ge=1, le=100)
    # Bounds on waiting for the database (`db.session`): a new connection (libpq connect_timeout; also
    # TCP keepalives and a TCP user timeout on every connection), a free pooled connection, one statement,
    # and one lock. Without them a database that stops answering held every request for up to 130 s
    # (psycopg's own connect timeout) and filled the request worker threads.
    db_connect_timeout_seconds: int = Field(default=5, ge=2, le=60)
    db_pool_timeout_seconds: int = Field(default=5, ge=1, le=60)
    db_statement_timeout_ms: int = Field(default=30_000, ge=1_000, le=600_000)
    db_lock_timeout_ms: int = Field(default=10_000, ge=100, le=600_000)
    # Production refuses database URLs that do not verify the server's certificate (sslmode=verify-full or
    # verify-ca, in the URL or PGSSLMODE), unless they reach the database over a Unix socket or loopback
    # (SEC-40). False only for a database on a network the deployment controls end to end.
    db_require_tls: bool = True

    secret_key: SecretStr = SecretStr(DEV_SECRET_KEY)
    app_base_url: str = "http://localhost:5173"
    qr_base_url: str | None = None
    allowed_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]
    trusted_proxies: Annotated[list[IPNetwork], NoDecode] = []

    cookie_secure: bool = True
    session_max_age_hours: int = Field(default=12, ge=1, le=24 * 30)
    session_idle_minutes: int = Field(default=240, ge=5, le=24 * 60)
    # The platform owner's sessions (Phase 11, B11-6): shorter than a tenant's, since the account manages
    # every company. Production refuses more than PLATFORM_SESSION_MAX_AGE_HOURS_CEILING hours and
    # PLATFORM_SESSION_IDLE_MINUTES_CEILING minutes.
    platform_session_max_age_hours: int = Field(default=8, ge=1, le=24)
    platform_session_idle_minutes: int = Field(default=30, ge=5, le=24 * 60)

    email_provider: EmailProviderName = "outbox"
    resend_api_key: SecretStr | None = None
    # EMAIL_PROVIDER=smtp (`email.providers.smtp`, S10-1). SMTP_PORT defaults by SMTP_SECURITY (587, 465,
    # 25); SMTP_USERNAME and SMTP_PASSWORD go together (both empty: no AUTH). SMTP_TIMEOUT_SECONDS bounds
    # the connection and every wait for the server, and never runs past a message's 20 s deadline.
    smtp_host: str | None = None
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: SmtpSecurity = "starttls"
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_timeout_seconds: float = Field(default=10.0, ge=1, le=60)
    email_from: str = f"{DEFAULT_PRODUCT_NAME_EN} <no-reply@localhost>"
    email_reply_to: str | None = None
    email_outbox_dir: Path = Path("var/outbox")
    email_fail_domain: str | None = None
    # E-mails delivered at the same time (`email.dispatcher`): deliveries wait for one of these slots,
    # never for the worker threads requests use, so a provider that hangs delays only e-mail.
    email_delivery_concurrency: int = Field(default=4, ge=1, le=32)

    rate_limit_enabled: bool = True
    rate_limit_login_per_ip_email: int = Field(default=5, ge=1)
    rate_limit_login_per_ip: int = Field(default=30, ge=1)
    rate_limit_login_per_account: int = Field(default=10, ge=1)
    # Successful sign-ins per account and 15 minutes (each writes a session and an audit row).
    rate_limit_login_successes_per_account: int = Field(default=30, ge=1)
    rate_limit_password_change_per_user: int = Field(default=5, ge=1)
    # Successful password changes per account and hour (SEC-43): each costs two Argon2 operations and
    # writes a session and an audit row. Beyond it 429 before any hashing; a reset still works.
    rate_limit_password_changes_per_hour: int = Field(default=5, ge=1)
    # POST /users refused because the address is taken (in any company), per administrator and hour, and
    # per company and hour: an administrator can create more administrators (SEC-05).
    rate_limit_user_email_refusals_per_hour: int = Field(default=10, ge=1)
    rate_limit_user_email_refusals_per_company_per_hour: int = Field(default=20, ge=1)
    rate_limit_forgot_per_email: int = Field(default=3, ge=1)  # per existing account's address
    rate_limit_forgot_per_ip: int = Field(default=10, ge=1)
    rate_limit_reset_per_ip: int = Field(default=20, ge=1)
    # Coarse secondary limits per IPv6 /48 on the anonymous endpoints (one site can rotate through
    # 65,536 /64 subjects); same windows as the per-IP limits.
    rate_limit_login_per_prefix: int = Field(default=300, ge=1)
    rate_limit_forgot_per_prefix: int = Field(default=100, ge=1)
    rate_limit_reset_per_prefix: int = Field(default=200, ge=1)
    # Caps on limiter buckets keyed by anonymous input, one per kind of key: client addresses/prefixes,
    # and e-mail addresses typed into login. A full cap stops tracking new keys of that kind (the
    # request is still judged by its other limits) instead of refusing anyone or growing memory.
    rate_limit_max_network_buckets: int = Field(default=100_000, ge=100)
    rate_limit_max_email_buckets: int = Field(default=100_000, ge=100)
    rate_limit_scan_per_minute: int = Field(default=120, ge=1)
    # Refused check-ins, check-outs and walk-ins without a scanned pass (MANUAL, OVERRIDE, CORRECTED,
    # walk-in) per user and minute; each refusal writes an audit row. Beyond it these requests answer 429
    # until the window frees a slot. Successful ones never spend it. QR attempts spend the scan budget.
    rate_limit_attendance_refusals_per_minute: int = Field(default=30, ge=1)
    rate_limit_resends_per_visit_hour: int = Field(default=3, ge=1)
    rate_limit_api_per_minute: int = Field(default=600, ge=1)
    invitation_daily_limit: int = Field(default=50, ge=1)
    # "Your visit has been rescheduled" e-mails a user's changes may send, per user and 24 hours and per
    # visit and hour. Beyond them the change is still made; only the e-mail is left out.
    reschedule_notice_daily_limit: int = Field(default=50, ge=1)
    rate_limit_reschedule_notices_per_visit_hour: int = Field(default=3, ge=1)
    # "Your visitor has arrived" e-mails to hosts per user who checks visitors in (or registers walk-ins)
    # and 24 hours. Beyond it the check-in still succeeds; only the e-mail is left out.
    host_arrival_daily_limit: int = Field(default=500, ge=1)
    # Test e-mails of a company's edited texts (POST /email-templates/{kind}/test, B11-29), always to the
    # administrator's own address, per administrator and hour.
    rate_limit_template_test_sends_per_hour: int = Field(default=5, ge=1, le=100)
    # The public identity endpoints (Phase 12, B12-9): a company's brand, its images and its web app
    # manifest, which the sign-in and pass pages read without a session. Per client address and minute,
    # and per IPv6 /48. A whole office behind one address opens the sign-in page in the morning, so the
    # default is generous; production refuses more than ten times it (the endpoints tell anyone whether
    # a slug names an active company).
    rate_limit_public_brand_per_ip: int = Field(default=600, ge=1)
    rate_limit_public_brand_per_prefix: int = Field(default=6000, ge=1)
    # Changes of companies' brands by one platform account per hour (an image stored or removed, a
    # colour): each upload is inflated and checked, and each change writes two audit rows.
    rate_limit_brand_changes_per_hour: int = Field(default=120, ge=1, le=10_000)

    password_hash_concurrency: int | None = Field(default=None, ge=1, le=64)

    # Largest accepted API request body; every contract body is far below 64 KiB.
    max_request_body_bytes: int = Field(default=64 * 1024, ge=1024, le=10 * 1024 * 1024)

    # `python -m app.serve` listens here unless --host/--port are given.
    server_host: str = "127.0.0.1"
    server_port: int = Field(default=8000, ge=1, le=65535)

    log_level: str = "INFO"
    log_json: bool = True

    seed_company_timezone: str = "Asia/Amman"
    seed_demo_password: SecretStr | None = None

    # The organisation behind the logo (B10-5) and the product's own name (B10-16), in Arabic and
    # English: see DEFAULT_BRAND_NAME_AR above for which is shown where.
    brand_name_ar: str = DEFAULT_BRAND_NAME_AR
    brand_name_en: str = DEFAULT_BRAND_NAME_EN
    product_name_ar: str = DEFAULT_PRODUCT_NAME_AR
    product_name_en: str = DEFAULT_PRODUCT_NAME_EN

    # ---- field normalisation -------------------------------------------------------------------

    @field_validator("database_url", "migration_database_url", mode="before")
    @classmethod
    def _db_url(cls, value: object) -> object:
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        if not isinstance(value, str):
            return value
        url = _psycopg_url(value.strip())
        parse_database_url(url)  # unambiguous, so the checks read the credentials the engine uses
        return url

    @field_validator("db_app_role")
    @classmethod
    def _role_name(cls, value: str) -> str:
        if not _ROLE_NAME.fullmatch(value):
            raise ValueError("DB_APP_ROLE must be a plain lowercase PostgreSQL identifier")
        return value

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _origins_csv(cls, value: object) -> object:
        return _split_csv(value)

    @field_validator("allowed_origins")
    @classmethod
    def _origins(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(_normalise_origin(origin) for origin in value))

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def _proxies_csv(cls, value: object) -> object:
        items = _split_csv(value)
        if isinstance(items, list):
            return [ip_network(item, strict=False) if isinstance(item, str) else item for item in items]
        return items

    @field_validator("secret_key", mode="before")
    @classmethod
    def _secret_or_dev_default(cls, value: object) -> object:
        # An empty SECRET_KEY (as shipped in .env.example) means "not configured": the development
        # default, which production refuses.
        if value is None or (isinstance(value, str) and not value.strip()):
            return DEV_SECRET_KEY
        return value

    @field_validator("app_base_url", "qr_base_url")
    @classmethod
    def _base_url(cls, value: str | None, info: ValidationInfo) -> str | None:
        # The SPA serves /pass and /reset-password at the root, and the shared pass-token grammar
        # requires the path to be exactly /pass, so these must be bare origins.
        if value is None or not value.strip():
            if info.field_name == "app_base_url":
                raise ValueError("APP_BASE_URL is required")
            return None  # QR_BASE_URL defaults to APP_BASE_URL
        try:
            return _normalise_origin(value)
        except ValueError:
            raise ValueError(
                f"{(info.field_name or 'value').upper()} must be an origin (scheme://host[:port]) "
                "without a path, query, fragment or credentials"
            ) from None

    @field_validator(
        "email_fail_domain",
        "email_reply_to",
        "resend_api_key",
        "smtp_host",
        "smtp_port",
        "smtp_username",
        "smtp_password",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("smtp_security", mode="before")
    @classmethod
    def _smtp_security(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("smtp_host")
    @classmethod
    def _smtp_host(cls, value: str | None) -> str | None:
        if value is None:
            return None
        host = value.strip().lower()
        try:
            return str(ip_address(host.strip("[]")))
        except ValueError:
            pass
        if not _SMTP_HOST_NAME.fullmatch(host):
            raise ValueError(
                "SMTP_HOST must be a host name such as smtp.gmail.com, or an IP address, without a scheme, "
                "port or path (the port goes in SMTP_PORT)"
            )
        return host.rstrip(".")

    @field_validator("smtp_username")
    @classmethod
    def _smtp_username(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not _SMTP_CREDENTIAL.fullmatch(value):
            raise ValueError(
                "SMTP_USERNAME must contain only printable ASCII characters (Python's SMTP client cannot "
                "send others)"
            )
        return value

    @field_validator("email_fail_domain")
    @classmethod
    def _fail_domain(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return normalise_domain_name(value)
        except ValueError:
            raise ValueError("EMAIL_FAIL_DOMAIN must be a domain name such as fail.test") from None

    @field_validator("log_level")
    @classmethod
    def _log_level(cls, value: str) -> str:
        value = value.strip().upper()
        if value not in _LOG_LEVELS:
            raise ValueError(f"LOG_LEVEL must be one of {sorted(_LOG_LEVELS)}")
        return value

    @field_validator("brand_name_ar", "brand_name_en", "product_name_ar", "product_name_en")
    @classmethod
    def _display_name(cls, value: str, info: ValidationInfo) -> str:
        name = (info.field_name or "name").upper()
        value = unicodedata.normalize("NFC", value).strip()
        if not value:
            raise ValueError(f"{name} must not be empty")
        if len(value) > BRAND_NAME_MAX_LENGTH:
            raise ValueError(f"{name} must be at most {BRAND_NAME_MAX_LENGTH} characters")
        if any(unicodedata.category(character) in _INVISIBLE_CATEGORIES for character in value):
            raise ValueError(
                f"{name} must be one line of visible text, without control, format or text-direction "
                "characters"
            )
        return value

    @field_validator("seed_company_timezone")
    @classmethod
    def _seed_timezone(cls, value: str) -> str:
        if value not in available_timezones():
            raise ValueError("SEED_COMPANY_TIMEZONE must be an IANA timezone name, e.g. Asia/Amman")
        return value

    @field_validator("email_outbox_dir")
    @classmethod
    def _outbox_dir(cls, value: Path) -> Path:
        """A relative directory is resolved against backend/ and must stay inside backend/var, the only
        git-ignored place there: outbox files carry raw pass and reset links and personal data. A Windows
        path whose backslashes a POSIX shell removed (`C:UsersYouAppData...`) is not absolute, and was
        once resolved to a folder of 56 such e-mails beside the source code (audit recommendation 15)."""
        if value.is_absolute():
            return value
        resolved = (BACKEND_DIR / value).resolve()
        if not resolved.is_relative_to(VAR_DIR.resolve()):
            raise ValueError(
                "EMAIL_OUTBOX_DIR must be an absolute path, or a relative path inside var/ (it is resolved "
                "against backend/, and only backend/var is kept out of git); quote Windows paths in a "
                "POSIX shell, which otherwise removes their backslashes"
            )
        return resolved

    @model_validator(mode="after")
    def _cross_field(self) -> Settings:
        if self.qr_base_url is None:
            self.qr_base_url = self.app_base_url
        if self.email_provider == "resend" and self.resend_api_key is None:
            raise ValueError("EMAIL_PROVIDER=resend requires RESEND_API_KEY")
        if self.smtp_password is not None:
            self.smtp_password = _smtp_password(self.smtp_password, host=self.smtp_host)
        if self.email_provider == "smtp":
            problems = _smtp_problems(self)
            if problems:
                raise ValueError("; ".join(problems))
        if self.app_env == "production":
            _check_production(self)
        return self

    # ---- derived values ------------------------------------------------------------------------

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def runtime_url(self) -> str:
        """DATABASE_URL in clear: only for creating the runtime engine."""
        return self.database_url.get_secret_value()

    @property
    def migration_url(self) -> str:
        if self.migration_database_url is None:
            raise ConfigurationError("MIGRATION_DATABASE_URL is required to run migrations")
        return self.migration_database_url.get_secret_value()

    @property
    def pass_url_base(self) -> str:
        return f"{self.qr_base_url}/pass"

    @property
    def smtp_server_port(self) -> int:
        """SMTP_PORT, or the usual port of SMTP_SECURITY when it is not set."""
        return self.smtp_port or SMTP_DEFAULT_PORTS[self.smtp_security]


def email_address_of(value: str) -> str | None:
    """The address in a mailbox such as `Mawdoo3 <visitors@example.com>` (lowercase), or None
    when there is none."""
    _name, address = parseaddr(value)
    return address.lower() if "@" in address else None


def _smtp_password(password: SecretStr, *, host: str | None) -> SecretStr:
    """The password as the server expects it (never logged or echoed). Google shows an App Password as
    four groups of four letters, and the spaces are often pasted with it: for smtp.gmail.com they are
    removed (an App Password has none)."""
    value = password.get_secret_value()
    if host == GMAIL_SMTP_HOST and " " in value and _GMAIL_APP_PASSWORD.fullmatch(value):
        return SecretStr(value.replace(" ", ""))
    return password


def _smtp_problems(settings: Settings) -> list[str]:
    """What EMAIL_PROVIDER=smtp cannot work without, in every environment. The messages name the setting,
    never its value."""
    problems: list[str] = []
    if settings.smtp_host is None:
        problems.append("EMAIL_PROVIDER=smtp requires SMTP_HOST")
    has_username, has_password = settings.smtp_username is not None, settings.smtp_password is not None
    if has_username and not has_password:
        problems.append("EMAIL_PROVIDER=smtp requires SMTP_PASSWORD when SMTP_USERNAME is set")
    if has_password and not has_username:
        problems.append("EMAIL_PROVIDER=smtp requires SMTP_USERNAME when SMTP_PASSWORD is set")
    if settings.smtp_password is not None and not _SMTP_CREDENTIAL.fullmatch(
        settings.smtp_password.get_secret_value()
    ):
        problems.append(
            "SMTP_PASSWORD must contain only printable ASCII characters (Python's SMTP client cannot send "
            "others)"
        )
    if settings.smtp_security == "none" and (has_username or has_password):
        problems.append(
            "SMTP_SECURITY=none would send SMTP_USERNAME and SMTP_PASSWORD unencrypted: use starttls or ssl, "
            "or leave both empty for a local capture server"
        )
    if email_address_of(settings.email_from) is None:
        problems.append(
            "EMAIL_FROM must be an e-mail address, optionally with a name: Name <address@example.com>"
        )
    return problems


def is_published_database_password(password: str | None) -> bool:
    """Whether `password` is one of the published local-development database passwords (never logged)."""
    return password is not None and any(
        marker in password.lower() for marker in PUBLISHED_DB_PASSWORD_MARKERS
    )


def _raw_query_values(url: URL, name: str) -> list[str]:
    """Every value of a query parameter, as given (a password may contain commas or spaces)."""
    value = url.query.get(name)
    if value is None:
        return []
    return [value] if isinstance(value, str) else list(value)


def _query_values(url: URL, name: str) -> list[str]:
    return [part.strip() for item in _raw_query_values(url, name) for part in item.split(",") if part.strip()]


def _uses_service(url: URL) -> bool:
    """A connection service file entry applies: a `service` in the URL or PGSERVICE."""
    return bool(_query_values(url, "service") or os.environ.get("PGSERVICE", "").strip())


def _effective_user(url: URL) -> str | None:
    """The role libpq logs in as for `url` (never logged or echoed). The engine passes a `user` query
    parameter over the URL's user name (SQLAlchemy's psycopg dialect), and libpq takes a parameter the URL
    does not give from a service entry before PGUSER. None when it cannot be told here: a service entry
    (which cannot be read) or the operating-system account would name the role. The role actually
    connected is judged at startup (`app.db.privileges`)."""
    users = _raw_query_values(url, "user")
    if users:
        return users[-1] or None
    if url.username:
        return url.username
    if _uses_service(url):
        return None
    return os.environ.get("PGUSER") or None


def _candidate_passwords(url: URL) -> list[str]:
    """The passwords libpq may use for `url` that can be read here (never logged or echoed): the URL's
    `password` query values (the engine passes them over the user:password part), its user:password part,
    and PGPASSWORD when the URL gives none. A password from a service entry or a password file (`passfile`,
    PGPASSFILE, ~/.pgpass) cannot be read here; the production startup check reads the one the connection
    actually used (`app.db.privileges`)."""
    passwords = [*_raw_query_values(url, "password"), *([url.password] if url.password else [])]
    if not passwords and os.environ.get("PGPASSWORD"):
        passwords.append(os.environ["PGPASSWORD"])
    return passwords


def _is_local_host(host: str) -> bool:
    """A Unix-domain socket (a directory, or an abstract socket "@…") or a loopback address."""
    if host.startswith(("/", "@")) or host.lower() == "localhost":
        return True
    try:
        return ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _environment_values(name: str) -> list[str]:
    return [part.strip() for part in os.environ.get(name, "").split(",") if part.strip()]


def _verifies_server(url: URL) -> bool:
    """Whether libpq will verify the database server's certificate for `url`, or reaches it only over a
    Unix socket or loopback (where there is no network to intercept).

    libpq takes each parameter from the URL first, then from a connection service file entry (a `service`
    in the URL or PGSERVICE), then from the environment (PGHOST, PGHOSTADDR, PGSSLMODE), then its
    defaults. A service entry can name a remote host or `hostaddr` (which wins over the URL's host) and
    its own sslmode (which wins over PGSSLMODE), and it cannot be read here: with a service, only a
    verifying sslmode in the URL itself counts (SEC-48). Otherwise every host the URL names (or PGHOST,
    when it names none) and every address (the URL's `hostaddr`, or PGHOSTADDR when it names none: libpq
    connects there whatever the host says) must be local for the connection to be; no target at all is
    the default Unix socket."""
    url_modes = _query_values(url, "sslmode")
    if _uses_service(url):
        return bool(url_modes) and url_modes[-1].lower() in VERIFYING_SSL_MODES
    hosts = ([url.host] if url.host else []) + _query_values(url, "host")
    addresses = _query_values(url, "hostaddr") or _environment_values("PGHOSTADDR")
    targets = (hosts or _environment_values("PGHOST")) + addresses
    if all(_is_local_host(target) for target in targets):  # no target at all: the default Unix socket
        return True
    modes = url_modes or [os.environ.get("PGSSLMODE", "")]
    return modes[-1].lower() in VERIFYING_SSL_MODES


def _database_problems(settings: Settings) -> list[str]:
    """The runtime must not run as the schema owner (which may disable the append-only triggers, delete
    history and run DDL) nor with a published local-development password. Both are judged by what libpq
    will use, not only by the URL's user:password part (SEC-R6): a `user` or `password` query parameter
    wins over it, and PGUSER and PGPASSWORD fill in what the URL leaves out. The role actually connected
    and the password it used are checked once more at startup (`app.db.privileges`)."""
    problems: list[str] = []
    runtime = parse_database_url(settings.database_url.get_secret_value())
    owner = (
        parse_database_url(settings.migration_database_url.get_secret_value())
        if settings.migration_database_url is not None
        else None
    )
    runtime_user = _effective_user(runtime)
    if runtime_user is not None and owner is not None and runtime_user == _effective_user(owner):
        problems.append("DATABASE_URL must use the runtime role, not the MIGRATION_DATABASE_URL owner role")
    for name, url in (("DATABASE_URL", runtime), ("MIGRATION_DATABASE_URL", owner)):
        if url is not None and any(is_published_database_password(p) for p in _candidate_passwords(url)):
            problems.append(
                f"{name} uses a published local-development password (in the URL, its password parameter "
                "or PGPASSWORD)"
            )
    return problems


def _database_tls_problems(settings: Settings) -> list[str]:
    """Database connections must verify the server (SEC-40): libpq's default, sslmode=prefer, falls back
    to plain text when the server or a man in the middle does not offer TLS and never checks the
    certificate, so visitor data, password and token hashes and audit rows could be read and changed in
    transit."""
    if not settings.db_require_tls:
        return []
    problems: list[str] = []
    for name, url in (
        ("DATABASE_URL", settings.database_url),
        ("MIGRATION_DATABASE_URL", settings.migration_database_url),
    ):
        if url is not None and not _verifies_server(parse_database_url(url.get_secret_value())):
            problems.append(
                f"{name} must verify the database server's certificate (sslmode=verify-full or verify-ca, "
                "in the URL or PGSSLMODE; in the URL itself when a connection service is used, a service "
                "in the URL or PGSERVICE) unless it connects over a Unix socket or loopback; set "
                "DB_REQUIRE_TLS=false only for a database on a network the deployment controls"
            )
    return problems


def _proxy_problems(settings: Settings) -> list[str]:
    too_wide = [
        network
        for network in settings.trusted_proxies
        if network.prefixlen < MIN_PROXY_PREFIX[network.version]
    ]
    if not too_wide:
        return []
    return [
        "TRUSTED_PROXIES must list the reverse proxies' own addresses or networks (at most /8 for IPv4 "
        f"and /32 for IPv6), not {', '.join(str(network) for network in too_wide)}"
    ]


def _limit_problems(settings: Settings) -> list[str]:
    """Limits so high that they switch password-guessing, recovery and account-probing protection off
    (SEC-46), and bucket caps so low that a few hundred source addresses switch the per-network limits off
    (SEC-R5). The messages name the setting and the bound, never the value."""
    problems: list[str] = []
    for name in GUESSING_LIMITS:
        default = Settings.model_fields[name].default
        ceiling = PRODUCTION_LIMIT_CEILING_FACTOR * default
        if getattr(settings, name) > ceiling:
            problems.append(
                f"{name.upper()} must be at most {ceiling} ({PRODUCTION_LIMIT_CEILING_FACTOR} times its "
                f"default {default})"
            )
    for name in BUCKET_CAPS:
        default = Settings.model_fields[name].default
        floor = default // PRODUCTION_BUCKET_FLOOR_DIVISOR
        if getattr(settings, name) < floor:
            problems.append(
                f"{name.upper()} must be at least {floor} (1/{PRODUCTION_BUCKET_FLOOR_DIVISOR} of its "
                f"default {default})"
            )
    return problems


def _check_production(settings: Settings) -> None:
    problems: list[str] = []
    secret = settings.secret_key.get_secret_value()
    lowered = secret.lower()
    if (
        secret == DEV_SECRET_KEY
        or len(secret) < MIN_PRODUCTION_SECRET_LENGTH
        or len(set(secret)) < 10
        or any(marker in lowered for marker in _WEAK_SECRET_MARKERS)
        # Words, dates, keyboard walks and repetitions: guessable offline from one device cookie (SEC-35).
        or not is_strong_secret(secret)
        # Known to everyone who read the repository or the audit report (SEC-47).
        or hashlib.sha256(secret.encode()).hexdigest() in _PUBLISHED_SECRET_KEY_DIGESTS
    ):
        problems.append(
            "SECRET_KEY is weak, guessable, published or a default; generate at least 43 random "
            'characters, e.g. python -c "import secrets; print(secrets.token_urlsafe(48))"'
        )
    if not settings.cookie_secure:
        problems.append("COOKIE_SECURE must be true")
    if not settings.rate_limit_enabled:
        problems.append("RATE_LIMIT_ENABLED must be true")
    problems += _limit_problems(settings)
    if settings.platform_session_max_age_hours > PLATFORM_SESSION_MAX_AGE_HOURS_CEILING:
        problems.append(
            f"PLATFORM_SESSION_MAX_AGE_HOURS must be at most {PLATFORM_SESSION_MAX_AGE_HOURS_CEILING}"
        )
    if settings.platform_session_idle_minutes > PLATFORM_SESSION_IDLE_MINUTES_CEILING:
        problems.append(
            f"PLATFORM_SESSION_IDLE_MINUTES must be at most {PLATFORM_SESSION_IDLE_MINUTES_CEILING}"
        )
    if settings.email_provider in {"outbox", "memory"}:
        problems.append(f"EMAIL_PROVIDER={settings.email_provider} is for development and tests only")
    if settings.email_provider == "smtp" and settings.smtp_security == "none":
        problems.append(
            "SMTP_SECURITY=none is for development and tests only (local capture servers): use starttls "
            "or ssl"
        )
    if settings.email_fail_domain is not None:
        problems.append("EMAIL_FAIL_DOMAIN must not be set")
    if not settings.app_base_url.startswith("https://"):
        problems.append("APP_BASE_URL must use https")
    if settings.qr_base_url is not None and not settings.qr_base_url.startswith("https://"):
        problems.append("QR_BASE_URL must use https")
    if any(not origin.startswith("https://") for origin in settings.allowed_origins):
        problems.append("ALLOWED_ORIGINS must contain https origins only")
    problems += _proxy_problems(settings)
    problems += _database_problems(settings)
    problems += _database_tls_problems(settings)
    if problems:
        raise ValueError("unsafe production configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    """Settings loaded from the environment (cached). Tests construct `Settings` explicitly instead."""
    return Settings()  # values come from the environment
