import ast
import re
import secrets
from collections.abc import Iterator
from ipaddress import ip_network
from pathlib import Path

import pytest
from psycopg import pq
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from app.core.config import (
    BACKEND_DIR,
    BUCKET_CAPS,
    DEV_SECRET_KEY,
    GUESSING_LIMITS,
    REPO_ROOT,
    Settings,
    email_address_of,
    normalise_origin,
)
from app.security.secret_strength import is_strong_secret

DB = "postgresql://vms_app:pw@localhost:5433/vms"
# Generated for each run: a key the production check accepts is never written into the repository, where
# anyone could copy it as a "known-good" key (SEC-47).
STRONG_SECRET = secrets.token_urlsafe(48)
REMOTE = "postgresql://vms_app:Runtime-Secret-01@db.bank-dc2.internal:5432/vms"
REMOTE_OWNER = "postgresql://vms_owner:Owner-Secret-02@db.bank-dc2.internal:5432/vms"

PRODUCTION = {
    "app_env": "production",
    "database_url": DB,
    "secret_key": STRONG_SECRET,
    "app_base_url": "https://vms.example.com",
    "allowed_origins": "https://vms.example.com",
    "cookie_secure": True,
    "rate_limit_enabled": True,
    "email_provider": "resend",
    "resend_api_key": "re_test_key",
}


def make(**values) -> Settings:
    return Settings(_env_file=None, **{"app_env": "development", **values})


def test_defaults_and_normalisation() -> None:
    settings = make(
        database_url=DB,
        allowed_origins="https://A.example.com:443, http://localhost:5173/ ,http://[::1]:8080",
        trusted_proxies="127.0.0.1, 10.0.0.0/8",
    )
    assert settings.runtime_url.startswith("postgresql+psycopg://")
    assert settings.allowed_origins == ["https://a.example.com", "http://localhost:5173", "http://[::1]:8080"]
    assert settings.trusted_proxies == [ip_network("127.0.0.1/32"), ip_network("10.0.0.0/8")]
    assert settings.qr_base_url == settings.app_base_url
    assert settings.pass_url_base == "http://localhost:5173/pass"
    assert settings.email_outbox_dir.is_absolute()
    assert settings.cookie_secure is True and settings.rate_limit_enabled is True


@pytest.mark.parametrize(
    "origins",
    ["*", "https://example.com/path", "ftp://example.com", "example.com", "https://u:p@example.com"],
)
def test_invalid_origins_are_rejected(origins: str) -> None:
    with pytest.raises(ValidationError):
        make(database_url=DB, allowed_origins=origins)


def test_normalise_origin_for_requests() -> None:
    assert normalise_origin("HTTPS://VMS.Example.com:443") == "https://vms.example.com"
    assert normalise_origin("null") is None
    assert normalise_origin("https://vms.example.com/x") is None


def test_app_env_is_required() -> None:
    # A deployment that forgets APP_ENV must not silently start with the development posture.
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=None, database_url=DB)  # type: ignore[call-arg]
    assert caught.value.errors()[0]["loc"] == ("app_env",)


@pytest.mark.parametrize("value", ["prod", "Production ", ""])
def test_app_env_accepts_only_known_environments(value: str) -> None:
    with pytest.raises(ValidationError):
        make(database_url=DB, app_env=value)


def test_valid_production_configuration() -> None:
    settings = make(**PRODUCTION)
    assert settings.is_production


@pytest.mark.parametrize(
    ("override", "problem"),
    [
        ({"secret_key": DEV_SECRET_KEY}, "SECRET_KEY"),
        ({"secret_key": "short-secret"}, "SECRET_KEY"),
        ({"secret_key": "a" * 40}, "SECRET_KEY"),
        ({"secret_key": "please-change-me-" + STRONG_SECRET}, "SECRET_KEY"),
        ({"cookie_secure": False}, "COOKIE_SECURE"),
        ({"rate_limit_enabled": False}, "RATE_LIMIT_ENABLED"),
        ({"email_provider": "outbox"}, "EMAIL_PROVIDER=outbox"),
        ({"email_provider": "memory"}, "EMAIL_PROVIDER=memory"),
        ({"email_fail_domain": "fail.test"}, "EMAIL_FAIL_DOMAIN"),
        ({"app_base_url": "http://vms.example.com"}, "APP_BASE_URL"),
        ({"allowed_origins": "http://vms.example.com"}, "ALLOWED_ORIGINS"),
        # Phase 15 (B15-1): synthetic journeys never reach real people's records.
        (
            {"tracking_provider": "simulator"},
            "TRACKING_PROVIDER=simulator is for development and E2E tests only",
        ),
    ],
)
def test_production_refuses_unsafe_settings(override: dict, problem: str) -> None:
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, **override})
    assert problem in str(caught.value)


def test_resend_requires_api_key() -> None:
    with pytest.raises(ValidationError, match="RESEND_API_KEY"):
        make(database_url=DB, email_provider="resend")


def test_development_allows_local_conveniences() -> None:
    settings = make(
        database_url=DB, cookie_secure=False, rate_limit_enabled=False, email_fail_domain="Fail.Test"
    )
    assert settings.email_fail_domain == "fail.test"


@pytest.mark.parametrize(
    "values",
    [
        {"database_url": "mysql://x"},
        {"database_url": DB, "db_app_role": "vms_app; DROP ROLE x"},
        {"database_url": DB, "seed_company_timezone": "Mars/Base"},
        {"database_url": DB, "log_level": "LOUD"},
        {"database_url": DB, "session_idle_minutes": 0},
        {"database_url": DB, "app_base_url": "javascript:alert(1)"},
    ],
)
def test_invalid_values(values: dict) -> None:
    with pytest.raises(ValidationError):
        make(**values)


def test_secret_is_not_exposed_in_repr() -> None:
    settings = make(database_url=DB, secret_key=STRONG_SECRET)
    assert STRONG_SECRET not in repr(settings)


# ---- base URLs are origins (the SPA serves /pass and /reset-password at the root) -----------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://vms.example.com", "https://vms.example.com"),
        ("https://vms.example.com/", "https://vms.example.com"),
        ("HTTPS://VMS.Example.COM:443/", "https://vms.example.com"),
        ("http://localhost:5173", "http://localhost:5173"),
        (" http://192.168.1.20:5173 ", "http://192.168.1.20:5173"),
        ("http://[::1]:5173", "http://[::1]:5173"),
    ],
)
def test_base_urls_are_normalised_origins(value: str, expected: str) -> None:
    settings = make(database_url=DB, app_base_url=value, qr_base_url=value)
    assert settings.app_base_url == expected
    assert settings.qr_base_url == expected
    assert settings.pass_url_base == f"{expected}/pass"


@pytest.mark.parametrize("field", ["app_base_url", "qr_base_url"])
@pytest.mark.parametrize(
    "value",
    [
        "https://vms.example.com/vms",  # path prefix: /vms/pass would not match the pass grammar
        "https://vms.example.com/vms/",
        "https://vms.example.com/?x=1",
        "https://vms.example.com/#pass",
        "https://user:secret@vms.example.com",
        "https://user@vms.example.com",
        "ftp://vms.example.com",
        "vms.example.com",
        "//vms.example.com",
        "javascript:alert(1)",
    ],
)
def test_base_urls_with_more_than_an_origin_are_rejected(field: str, value: str) -> None:
    with pytest.raises(ValidationError) as caught:
        make(database_url=DB, **{field: value})
    assert "must be an origin" in str(caught.value)
    assert field.upper() in str(caught.value)


def test_qr_base_url_defaults_to_the_app_origin_and_app_base_url_is_required() -> None:
    settings = make(database_url=DB, app_base_url="https://vms.example.com/", qr_base_url="")
    assert settings.qr_base_url == "https://vms.example.com"
    with pytest.raises(ValidationError, match="APP_BASE_URL is required"):
        make(database_url=DB, app_base_url=" ")


# ---- SECRET_KEY placeholders ----------------------------------------------------------------------


def _env_example_value(name: str) -> str:
    for line in (REPO_ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == name:
            return value.strip()
    raise AssertionError(f"{name} is missing from .env.example")


def test_env_example_documents_exactly_the_settings() -> None:
    # Unknown variables are ignored at startup (extra="ignore"), so a renamed setting left in a
    # deployment's environment would silently stop applying; the template must name the real ones.
    # Optional settings appear commented out (`# NAME=value`).
    assignment = re.compile(r"#?\s*([A-Z][A-Z0-9_]*)=")
    documented = set()
    for line in (REPO_ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if match := assignment.match(line.strip()):
            documented.add(match.group(1))
    assert documented == {name.upper() for name in Settings.model_fields}


def test_env_example_ships_no_usable_secret_key() -> None:
    shipped = _env_example_value("SECRET_KEY")
    assert shipped == ""
    # Empty means "not configured": the development default, which production refuses.
    assert make(database_url=DB, secret_key=shipped).secret_key.get_secret_value() == DEV_SECRET_KEY
    with pytest.raises(ValidationError, match="SECRET_KEY"):
        make(**{**PRODUCTION, "secret_key": shipped})


@pytest.mark.parametrize(
    "secret",
    [
        "replace-with-a-long-random-value",  # the placeholder an earlier .env.example shipped
        "REPLACE_ME_0123456789abcdefghijklmnopqrstuv",
        "placeholder-Zq8vN3kL0pW7xR2tY6uB9mC4dF1",
        "  ",
    ],
)
def test_production_refuses_placeholder_secrets(secret: str) -> None:
    with pytest.raises(ValidationError, match="SECRET_KEY"):
        make(**{**PRODUCTION, "secret_key": secret})


@pytest.mark.parametrize("domain", ["Fail.Test", "@fail.test", "xn--bcher-kva.example", "a-b.c-d.museum"])
def test_email_fail_domain_uses_the_shared_domain_rule(domain: str) -> None:
    assert make(database_url=DB, email_fail_domain=domain).email_fail_domain == domain.lower().lstrip("@")


@pytest.mark.parametrize("domain", ["fail", "-fail.test", "fail.t", "fail.1test", "fa il.test", "fail..test"])
def test_email_fail_domain_rejects_non_domains(domain: str) -> None:
    with pytest.raises(ValidationError, match="EMAIL_FAIL_DOMAIN"):
        make(database_url=DB, email_fail_domain=domain)


# ---- secrets never echoed (SEC-17) ----------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg2://vms:Xk29fLq7@db/vms",
        "postgresql+asyncpg://vms_app:Pr0d-DB-Passw0rd-XYZ@db.internal:5432/vms",
        "mysql://vms_app:Pr0dPassw0rd@db.bank.internal:3306/vms",
    ],
)
@pytest.mark.parametrize("field", ["database_url", "migration_database_url"])
def test_a_rejected_database_url_is_not_echoed(field: str, url: str) -> None:
    values = {"database_url": DB, field: url}
    with pytest.raises(ValidationError) as caught:
        make(**values)
    text = str(caught.value)
    assert "must use PostgreSQL" in text
    password = url.split("@")[0].rsplit(":", 1)[1]
    user = url.split("://")[1].split(":")[0]
    for leaked in (password, password[-6:], user + ":", url[:24]):
        assert leaked not in text
    assert "input_value" not in text


def test_a_refused_production_configuration_echoes_no_input() -> None:
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, "cookie_secure": False, "resend_api_key": "re_TAILKEY_secret"})
    text = str(caught.value)
    assert "COOKIE_SECURE" in text
    assert "re_TAILKEY_secret" not in text and "TAILKEY" not in text
    assert "input_value" not in text


def test_database_passwords_are_not_exposed_in_repr() -> None:
    settings = make(
        database_url="postgresql+psycopg://vms_app:Pr0d-Db-Pass@db/vms",
        migration_database_url="postgresql+psycopg://vms_owner:Owner-Pass@db/vms",
    )
    assert "Pr0d-Db-Pass" not in repr(settings) and "Owner-Pass" not in repr(settings)
    assert "Pr0d-Db-Pass" not in str(settings)
    assert settings.runtime_url == "postgresql+psycopg://vms_app:Pr0d-Db-Pass@db/vms"
    assert settings.migration_url == "postgresql+psycopg://vms_owner:Owner-Pass@db/vms"


# ---- production: proxies and database roles (SEC-18, SEC-23) ----------------------------------------


@pytest.mark.parametrize(
    "proxies",
    ["0.0.0.0/0", "::/0", "0.0.0.0/0,::/0", "1.0.0.0/1,128.0.0.0/1", "10.0.0.0/7", "2001::/31"],
)
def test_production_refuses_catch_all_trusted_proxies(proxies: str) -> None:
    with pytest.raises(ValidationError, match="TRUSTED_PROXIES"):
        make(**{**PRODUCTION, "trusted_proxies": proxies})


@pytest.mark.parametrize("proxies", ["", "10.0.0.0/8", "172.16.0.0/12,192.168.1.10", "2001:db8::/32", "::1"])
def test_production_accepts_scoped_trusted_proxies(proxies: str) -> None:
    assert make(**{**PRODUCTION, "trusted_proxies": proxies}).is_production


def test_development_accepts_any_trusted_proxies() -> None:
    assert make(database_url=DB, trusted_proxies="0.0.0.0/0").trusted_proxies == [ip_network("0.0.0.0/0")]


def test_production_refuses_the_owner_role_at_runtime() -> None:
    owner = "postgresql://vms_owner:Zq8vN3kL0pW7xR2tY6uB@db/vms"
    with pytest.raises(ValidationError, match="must use the runtime role") as caught:
        make(**{**PRODUCTION, "database_url": owner, "migration_database_url": owner})
    assert "Zq8vN3kL0pW7xR2tY6uB" not in str(caught.value)
    separate = make(
        **{**PRODUCTION, "migration_database_url": "postgresql://vms_owner:other@db/vms?sslmode=verify-full"}
    )
    assert separate.is_production


@pytest.mark.parametrize(
    "values",
    [
        {"database_url": "postgresql://vms_app:vms_app_local_dev@db/vms"},
        {"migration_database_url": "postgresql://vms_owner:vms_owner_local_dev@db/vms"},
        {"database_url": "postgresql://vms_app:VMS_APP_LOCAL_DEV@db/vms"},
    ],
)
def test_production_refuses_the_published_local_database_passwords(values: dict) -> None:
    with pytest.raises(ValidationError, match="published local-development password") as caught:
        make(**{**PRODUCTION, **values})
    assert "local_dev" not in str(caught.value).lower().replace("local-development", "")


# ---- SECRET_KEY strength (SEC-35) ----------------------------------------------------------------


@pytest.mark.parametrize(
    "secret",
    [
        "0123456789" * 5,
        "qwertyuiopasdfghjklzxcvbnm1234567890qwertyuiop",
        "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqr",
        "BankVMS-Production-2026-Key-Amman-Jordan-Main",
        "your-own-long-default-dummy-value-for-test-2026",
        "P4ssw0rd-Admin-2026-Visitor-Management-System!",
        "correct horse battery staple jordan amman visitor",
        "Ministry-Interior-Amman-Visitors-2026-2026-2026",
    ],
)
def test_production_refuses_guessable_secrets(secret: str) -> None:
    """The finding's shapes, each long enough, with ten distinct characters and no placeholder word (the
    earlier rule accepted them all): sequences, keyboard walks, repetitions, words and dates."""
    assert len(secret) >= 43 and len(set(secret)) >= 10
    with pytest.raises(ValidationError, match="SECRET_KEY") as caught:
        make(**{**PRODUCTION, "secret_key": secret})
    assert secret not in str(caught.value)


def test_production_needs_at_least_43_characters() -> None:
    with pytest.raises(ValidationError, match="SECRET_KEY"):
        make(**{**PRODUCTION, "secret_key": secrets.token_urlsafe(24)})  # 32 random: 192 bits


@pytest.mark.parametrize(
    "generate",
    [
        lambda: secrets.token_urlsafe(48),  # the template's generator
        lambda: secrets.token_urlsafe(32),
        lambda: secrets.token_hex(32),
    ],
)
def test_production_accepts_generated_secrets(generate) -> None:
    for _ in range(200):
        assert make(**{**PRODUCTION, "secret_key": generate()}).is_production


# ---- published keys (SEC-47) ---------------------------------------------------------------------

# Production-valid keys this test suite once spelled out (the security audit's report quotes them).
PUBLISHED_SECRET_KEYS = (
    "Zq8vN3kL0pW7xR2tY6uB9mC4dF1gH5jSa7Ke2Xw9Pm4R",
    "Zq8vN3kL0pW7xR2tY6uB9mC4dF1gH5jS-production-test",
)


@pytest.mark.parametrize("secret", PUBLISHED_SECRET_KEYS)
def test_production_refuses_published_secret_keys(secret: str) -> None:
    """Random-looking, long enough and strong by every estimate: only their publication makes them weak.
    With one of them, whoever has the source can forge device-trust entries (one per nonce, each with
    its own failure budget) and recompute the limiter's keys."""
    assert len(secret) >= 43 and is_strong_secret(secret)
    with pytest.raises(ValidationError, match="SECRET_KEY is weak, guessable, published") as caught:
        make(**{**PRODUCTION, "secret_key": secret})
    assert secret not in str(caught.value)


def _secret_key_literals(tree: ast.AST) -> Iterator[str]:
    """String constants that code passes as a SECRET_KEY: `secret_key=` arguments, `"secret_key"`
    dictionary entries and values bound to a name that mentions a secret or a key (also in tuples)."""
    for node in ast.walk(tree):
        values: list[ast.expr | None] = []
        if isinstance(node, ast.keyword) and node.arg == "secret_key":
            values.append(node.value)
        elif isinstance(node, ast.Dict):
            values += [
                value
                for key, value in zip(node.keys, node.values, strict=True)
                if isinstance(key, ast.Constant) and key.value == "secret_key"
            ]
        elif isinstance(node, ast.Assign | ast.AnnAssign):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(
                isinstance(target, ast.Name) and re.search("SECRET|KEY", target.id, re.I)
                for target in targets
            ):
                values.append(node.value)
        for value in values:
            elements = value.elts if isinstance(value, ast.Tuple | ast.List) else [value]
            for element in elements:
                if isinstance(element, ast.Constant) and isinstance(element.value, str):
                    yield element.value


def _sources() -> list[Path]:
    backend = REPO_ROOT / "backend"
    return sorted(
        [*backend.glob("app/**/*.py"), *backend.glob("tests/**/*.py"), *(REPO_ROOT / "scripts").glob("*.py")]
    )


@pytest.mark.usefixtures("no_libpq_environment")
def test_no_production_valid_secret_key_is_written_in_the_code() -> None:
    """The test suite once carried two keys the production check accepted, one of them named
    "...-production-test": an operator copying a "known-good" key from the tests would deploy a key
    everyone with the source knows. Keys are generated at run time instead (SEC-47)."""
    accepted: list[str] = []
    for path in _sources():
        for literal in _secret_key_literals(ast.parse(path.read_text(encoding="utf-8"))):
            try:
                make(**{**PRODUCTION, "secret_key": literal})
            except ValidationError as error:
                refused = "SECRET_KEY" in str(error)
            else:
                refused = False
            if not refused:
                accepted.append(f"{path.relative_to(REPO_ROOT)}: {literal[:6]}...")
    assert accepted == []


def test_the_literal_scan_finds_keys_written_in_any_of_its_forms() -> None:
    source = (
        'A_SECRET = "s1"\nKEYS = ("s2", "s3")\nmake(secret_key="s4")\nPROD = {"secret_key": "s5"}\n'
        'other = "not a key"\nsecret_key: str = "s6"\n'
    )
    assert sorted(_secret_key_literals(ast.parse(source))) == ["s1", "s2", "s3", "s4", "s5", "s6"]


# ---- database URLs read alike by every parser (SEC-36) ---------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://vms_app:Tr0ub4dor@Zx9-Secret@db.internal:5432/vms",  # host "Zx9-Secret@db.internal"
        "postgresql://vms_app:Tr0ub4dor@Zx9:Secret@localhost:5433/vms",  # an invalid port for the engine
        "postgresql://vms_app:Tr0ub4dor/Zx9-Secret@localhost:5433/vms",
        "postgresql://vms_app:Tr0ub4dor#Zx9-Secret@localhost/vms",
        "postgresql://vms_app:Tr0ub4dor?Zx9-Secret@localhost/vms",
        "postgresql://vms_app:Tr0ub4dor[Zx9-Secret@localhost/vms",
    ],
)
@pytest.mark.parametrize("field", ["database_url", "migration_database_url"])
def test_an_ambiguous_database_url_is_refused_without_echo(field: str, url: str) -> None:
    """An unencoded reserved character in the password makes the engine (SQLAlchemy) and the standard URL
    parser read different credentials and hosts: the engine then tried to connect to a "host" that is the
    end of the password, and the driver's error printed it to the startup log."""
    with pytest.raises(ValidationError) as caught:
        make(**{"database_url": DB, field: url})
    text = str(caught.value)
    assert "percent-encode" in text
    for leaked in ("Zx9", "Secret", "Tr0ub4dor", "input_value"):
        assert leaked not in text


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://vms_app:Tr0ub4dor%40Zx9-Secret@localhost:5433/vms",
        "postgresql://vms_app:pa%3Ass%2F%3F%23@localhost:5433/vms",
        "postgresql://vms_app:pa:ss@localhost:5433/vms",  # a colon in the password is read alike
        "postgresql://vms_app:pw@[::1]:5433/vms",
        "postgresql://vms_app:pw@/vms?host=/var/run/postgresql",
        "postgresql://vms_app@/vms",
    ],
)
def test_unambiguous_database_urls_are_accepted(url: str) -> None:
    assert make(database_url=url).runtime_url.startswith("postgresql+psycopg://")


def test_the_credential_checks_read_the_password_the_engine_uses() -> None:
    encoded = "postgresql://vms_app:x%40vms_app_local_dev@db.internal/vms?sslmode=verify-full"
    with pytest.raises(ValidationError, match="published local-development password"):
        make(**{**PRODUCTION, "database_url": encoded})


# ---- credentials outside the URL's user:password part (SEC-R6) -------------------------------------


def test_the_engine_passes_query_credentials_over_the_urls_own() -> None:
    """What the checks below rest on: SQLAlchemy's psycopg dialect hands libpq the `user` and `password`
    query parameters in place of the URL's user:password part."""
    url = make_url(
        "postgresql+psycopg://vms_app:url-secret@localhost:5433/vms?user=other&password=query-secret"
    )
    engine = create_engine(url)
    try:
        _args, parameters = engine.dialect.create_connect_args(url)
    finally:
        engine.dispose()
    assert (parameters["user"], parameters["password"]) == ("other", "query-secret")


LOCAL = "postgresql://vms_app@localhost:5433/vms"
LOCAL_OWNER = "postgresql://vms_owner@localhost:5433/vms"


@pytest.mark.parametrize(
    ("values", "environment"),
    [
        ({"database_url": LOCAL + "?password=vms_app_local_dev"}, {}),
        # The parameter wins over the URL's own password, which therefore cannot hide it.
        (
            {
                "database_url": "postgresql://vms_app:Runtime-Secret-01@localhost/vms?password=vms_app_local_dev"
            },
            {},
        ),
        ({"database_url": LOCAL}, {"PGPASSWORD": "vms_app_local_dev"}),
        ({"migration_database_url": LOCAL_OWNER + "?password=vms_owner_local_dev"}, {}),
        ({"migration_database_url": LOCAL_OWNER}, {"PGPASSWORD": "vms_owner_local_dev"}),
    ],
)
def test_production_refuses_published_passwords_however_libpq_gets_them(
    no_libpq_environment: pytest.MonkeyPatch, values: dict, environment: dict
) -> None:
    """The finding: only the URL's user:password part was read, so `?password=vms_app_local_dev`, or
    PGPASSWORD with a password-less URL, passed, and production started and served with the published
    password. A password file or a service entry is checked at startup (`test_runtime_privileges`)."""
    for name, value in environment.items():
        no_libpq_environment.setenv(name, value)
    with pytest.raises(ValidationError, match="published local-development password") as caught:
        make(**{**PRODUCTION, **values})
    assert "local_dev" not in str(caught.value).lower().replace("local-development", "")


def test_pgpassword_counts_only_when_the_url_gives_no_password(
    no_libpq_environment: pytest.MonkeyPatch,
) -> None:
    no_libpq_environment.setenv("PGPASSWORD", "vms_app_local_dev")
    url = "postgresql://vms_app:Runtime-Secret-01@localhost:5433/vms"
    assert make(**{**PRODUCTION, "database_url": url}).is_production  # libpq uses the URL's password


@pytest.mark.parametrize(
    ("runtime", "environment"),
    [
        ("postgresql://localhost:5433/vms?user=vms_owner&password=Runtime-Secret-01", {}),
        (
            "postgresql://vms_app:Runtime-Secret-01@localhost:5433/vms?user=vms_owner",
            {},
        ),  # the parameter wins
        ("postgresql://localhost:5433/vms?password=Runtime-Secret-01", {"PGUSER": "vms_owner"}),
    ],
)
def test_production_refuses_the_owner_role_however_libpq_gets_it(
    no_libpq_environment: pytest.MonkeyPatch, runtime: str, environment: dict
) -> None:
    for name, value in environment.items():
        no_libpq_environment.setenv(name, value)
    owner = "postgresql://vms_owner:Owner-Secret-02@localhost:5433/vms"
    with pytest.raises(ValidationError, match="must use the runtime role"):
        make(**{**PRODUCTION, "database_url": runtime, "migration_database_url": owner})


def test_pguser_fills_in_only_what_the_url_leaves_out(no_libpq_environment: pytest.MonkeyPatch) -> None:
    no_libpq_environment.setenv("PGUSER", "vms_owner")
    owner = "postgresql://vms_owner:Owner-Secret-02@localhost:5433/vms"
    runtime = "postgresql://vms_app:Runtime-Secret-01@localhost:5433/vms"
    assert make(**{**PRODUCTION, "database_url": runtime, "migration_database_url": owner}).is_production
    # A connection service entry can name the user before PGUSER and cannot be read here: the startup
    # check judges the role actually connected (`app.db.privileges`).
    service = "postgresql://localhost/vms?service=vmsprod&sslmode=verify-full&password=Runtime-Secret-01"
    assert make(**{**PRODUCTION, "database_url": service, "migration_database_url": owner}).is_production


# ---- database transport (SEC-40) -------------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_libpq_environment(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """The libpq variables the transport check reads are the test's own, not the developer's."""
    for name in ("PGSSLMODE", "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGUSER", "PGPASSWORD"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


@pytest.mark.usefixtures("no_libpq_environment")
@pytest.mark.parametrize("query", ["", "?sslmode=prefer", "?sslmode=require", "?sslmode=disable"])
@pytest.mark.parametrize("field", ["database_url", "migration_database_url"])
def test_production_refuses_unverified_database_connections(field: str, query: str) -> None:
    """libpq's default (prefer) falls back to plain text and never checks the certificate; require
    encrypts but accepts any certificate. Both let a man in the middle read and change the traffic."""
    values = {"database_url": REMOTE + "?sslmode=verify-full", "migration_database_url": None}
    values[field] = (REMOTE if field == "database_url" else REMOTE_OWNER) + query
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, **values})
    text = str(caught.value)
    assert f"{field.upper()} must verify the database server's certificate" in text
    assert "Runtime-Secret-01" not in text and "Owner-Secret-02" not in text


@pytest.mark.usefixtures("no_libpq_environment")
@pytest.mark.parametrize(
    "url",
    [
        REMOTE + "?sslmode=verify-full",
        REMOTE + "?sslmode=verify-ca&sslrootcert=/etc/vms/db-ca.pem",
        "postgresql://vms_app:Runtime-Secret-01@localhost:5432/vms",
        "postgresql://vms_app:Runtime-Secret-01@127.0.0.1:5432/vms",
        "postgresql://vms_app:Runtime-Secret-01@[::1]:5432/vms",
        "postgresql://vms_app:Runtime-Secret-01@/vms?host=/var/run/postgresql",
        "postgresql://vms_app:Runtime-Secret-01@/vms",
    ],
)
def test_production_accepts_verified_or_local_database_connections(url: str) -> None:
    assert make(**{**PRODUCTION, "database_url": url, "migration_database_url": None}).is_production


def test_production_honours_pgsslmode(no_libpq_environment: pytest.MonkeyPatch) -> None:
    no_libpq_environment.setenv("PGSSLMODE", "verify-full")
    assert make(**{**PRODUCTION, "database_url": REMOTE}).is_production
    with pytest.raises(ValidationError, match="must verify"):  # the URL's own mode wins, as in libpq
        make(**{**PRODUCTION, "database_url": REMOTE + "?sslmode=require"})
    no_libpq_environment.setenv("PGHOST", "db.bank-dc2.internal")  # no host in the URL: PGHOST decides
    no_libpq_environment.setenv("PGSSLMODE", "prefer")
    with pytest.raises(ValidationError, match="must verify"):
        make(**{**PRODUCTION, "database_url": "postgresql://vms_app:Runtime-Secret-01@/vms"})


@pytest.mark.usefixtures("no_libpq_environment")
def test_unverified_database_connections_need_an_explicit_opt_out() -> None:
    settings = make(**{**PRODUCTION, "database_url": REMOTE, "db_require_tls": False})
    assert settings.is_production
    assert make(database_url=REMOTE).app_env == "development"  # only production checks it


# ---- connection services and PGHOSTADDR (SEC-48) --------------------------------------------------

SERVICE_URL = "postgresql://vms_app:Runtime-Secret-01@/vms?service=vmsprod"
SERVICE_OWNER_URL = "postgresql://vms_owner:Owner-Secret-02@/vms?service=vmsprod"


@pytest.mark.parametrize(
    "query",
    ["", "&sslmode=require", "&sslmode=prefer"],
)
@pytest.mark.parametrize("field", ["database_url", "migration_database_url"])
def test_a_connection_service_needs_a_verifying_sslmode_in_the_url(
    no_libpq_environment: pytest.MonkeyPatch, field: str, query: str
) -> None:
    """The finding: a host-less URL naming a pg_service.conf entry was taken for the local Unix socket,
    while libpq connected to the entry's remote host with its default sslmode (prefer: no certificate
    check, plain text as a fallback). The entry cannot be read here, and its sslmode outranks PGSSLMODE,
    so only the URL's own sslmode counts."""
    no_libpq_environment.setenv("PGSSLMODE", "verify-full")
    values = {"database_url": REMOTE + "?sslmode=verify-full", "migration_database_url": None}
    values[field] = (SERVICE_URL if field == "database_url" else SERVICE_OWNER_URL) + query
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, **values})
    text = str(caught.value)
    assert f"{field.upper()} must verify the database server's certificate" in text
    assert "Runtime-Secret-01" not in text and "Owner-Secret-02" not in text


def test_a_connection_service_with_a_local_host_in_the_url_is_not_local() -> None:
    """The entry's `hostaddr` wins over the URL's host: libpq would connect there."""
    url = "postgresql://vms_app:Runtime-Secret-01@localhost:5432/vms?service=vmsprod"
    with pytest.raises(ValidationError, match="DATABASE_URL must verify"):
        make(**{**PRODUCTION, "database_url": url})


@pytest.mark.parametrize("mode", ["verify-full", "verify-ca"])
def test_a_connection_service_with_a_verifying_sslmode_in_the_url_is_accepted(mode: str) -> None:
    settings = make(
        **{
            **PRODUCTION,
            "database_url": f"{SERVICE_URL}&sslmode={mode}",
            "migration_database_url": f"{SERVICE_OWNER_URL}&sslmode={mode}",
        }
    )
    assert settings.is_production


def test_pgservice_counts_like_a_service_in_the_url(no_libpq_environment: pytest.MonkeyPatch) -> None:
    no_libpq_environment.setenv("PGSERVICE", "vmsprod")
    no_libpq_environment.setenv("PGSSLMODE", "verify-full")
    for url in (
        "postgresql://vms_app:Runtime-Secret-01@/vms",
        "postgresql://vms_app:Runtime-Secret-01@localhost:5432/vms",
    ):
        with pytest.raises(ValidationError, match="DATABASE_URL must verify"):
            make(**{**PRODUCTION, "database_url": url})
    url = "postgresql://vms_app:Runtime-Secret-01@/vms?sslmode=verify-full"
    assert make(**{**PRODUCTION, "database_url": url}).is_production


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://vms_app:Runtime-Secret-01@/vms",
        "postgresql://vms_app:Runtime-Secret-01@localhost:5432/vms",
    ],
)
def test_pghostaddr_is_where_libpq_connects(no_libpq_environment: pytest.MonkeyPatch, url: str) -> None:
    """PGHOSTADDR applies whenever the URL names no `hostaddr`, even with a host in the URL."""
    no_libpq_environment.setenv("PGHOSTADDR", "192.0.2.10")
    with pytest.raises(ValidationError, match="DATABASE_URL must verify"):
        make(**{**PRODUCTION, "database_url": url})
    no_libpq_environment.setenv("PGSSLMODE", "verify-full")
    assert make(**{**PRODUCTION, "database_url": url}).is_production
    no_libpq_environment.delenv("PGSSLMODE")
    separator = "&" if "?" in url else "?"
    assert make(**{**PRODUCTION, "database_url": f"{url}{separator}hostaddr=127.0.0.1"}).is_production
    no_libpq_environment.setenv("PGHOSTADDR", "127.0.0.1")
    assert make(**{**PRODUCTION, "database_url": url}).is_production


def _libpq_parameters(conninfo: str) -> dict[str, str | None]:
    """The parameters libpq settles on for `conninfo` (URL, service file, environment, defaults), read
    from a connection that is started and abandoned at once."""
    connection = pq.PGconn.connect_start(conninfo.encode())
    try:
        return {
            option.keyword.decode(): option.val.decode() if option.val is not None else None
            for option in connection.info
        }
    finally:
        connection.finish()


def test_libpq_reads_a_service_entry_before_the_environment(
    no_libpq_environment: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """What the check above relies on: a service entry's host, hostaddr and sslmode win over PGHOST and
    PGSSLMODE and over a host in the URL (hostaddr), and only the URL's own sslmode wins over the entry."""
    services = tmp_path / "pg_service.conf"
    services.write_text(
        "[remote]\nhost=192.0.2.10\nport=1\nsslmode=disable\n[address]\nhostaddr=192.0.2.11\nport=1\n",
        encoding="utf-8",
    )
    no_libpq_environment.setenv("PGSERVICEFILE", str(services))
    no_libpq_environment.setenv("PGHOST", "127.0.0.1")
    no_libpq_environment.setenv("PGSSLMODE", "verify-full")
    remote = _libpq_parameters("service=remote dbname=vms connect_timeout=1")
    assert (remote["host"], remote["sslmode"]) == ("192.0.2.10", "disable")
    assert _libpq_parameters("service=remote dbname=vms sslmode=verify-full")["sslmode"] == "verify-full"
    address = _libpq_parameters("host=localhost service=address dbname=vms")
    assert (address["host"], address["hostaddr"]) == ("localhost", "192.0.2.11")
    no_libpq_environment.delenv("PGSSLMODE")
    no_libpq_environment.setenv("PGHOSTADDR", "192.0.2.12")
    assert _libpq_parameters("host=localhost dbname=vms")["hostaddr"] == "192.0.2.12"


# ---- limits that switch protection off (SEC-46) ----------------------------------------------------


@pytest.mark.parametrize("name", GUESSING_LIMITS)
def test_production_refuses_guessing_limits_beyond_ten_times_their_default(name: str) -> None:
    """A login, change-password, forgot or reset limit far above its default limits nothing: the same
    posture as RATE_LIMIT_ENABLED=false, which production refuses."""
    default = Settings.model_fields[name].default
    assert make(**{**PRODUCTION, name: 10 * default}).is_production
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, name: 10 * default + 1})
    assert f"{name.upper()} must be at most {10 * default}" in str(caught.value)
    assert make(**{"database_url": DB, name: 10**9}).app_env == "development"  # production only


def test_the_findings_relaxed_production_configuration_is_refused() -> None:
    relaxed = dict.fromkeys(GUESSING_LIMITS, 10**9)
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, **relaxed})
    text = str(caught.value)
    assert all(f"{name.upper()} must be at most" in text for name in GUESSING_LIMITS)
    assert "1000000000" not in text  # the rejected values are not echoed


def test_throughput_budgets_have_no_production_ceiling() -> None:
    """Large sites raise these (busy desks, office NAT, shared reception accounts)."""
    raised = {
        "rate_limit_api_per_minute": 100_000,
        "rate_limit_scan_per_minute": 100_000,
        "rate_limit_attendance_refusals_per_minute": 10_000,
        "rate_limit_login_successes_per_account": 10_000,
        "rate_limit_password_changes_per_hour": 1_000,
        "invitation_daily_limit": 100_000,
        "host_arrival_daily_limit": 100_000,
    }
    assert make(**{**PRODUCTION, **raised}).is_production


def test_the_template_stays_within_the_production_ceilings() -> None:
    for name in GUESSING_LIMITS:
        assert int(_env_example_value(name.upper())) <= 10 * Settings.model_fields[name].default
    for name in BUCKET_CAPS:
        assert int(_env_example_value(name.upper())) >= Settings.model_fields[name].default // 10


def test_production_caps_the_budgets_of_the_sec_05_existence_check() -> None:
    """SEC-R5: the refusal budgets of POST /users are the only control on the deferred SEC-05 check of
    whether an address has an account in another company; 10^9 was accepted in production."""
    assert {
        "rate_limit_user_email_refusals_per_hour",
        "rate_limit_user_email_refusals_per_company_per_hour",
    } <= set(GUESSING_LIMITS)
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, "rate_limit_user_email_refusals_per_hour": 10**9})
    assert "RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR must be at most 100 " in str(caught.value)


@pytest.mark.parametrize("name", BUCKET_CAPS)
def test_production_refuses_bucket_caps_below_a_tenth_of_their_default(name: str) -> None:
    """SEC-R5: a full cap admits new keys untracked (B1-66), so with a cap of 100 about a hundred source
    addresses switched the per-address, per-prefix and per-(address, e-mail) login and recovery limits
    off for every later client."""
    floor = Settings.model_fields[name].default // 10
    assert make(**{**PRODUCTION, name: floor}).is_production
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, name: 1234})
    text = str(caught.value)
    assert f"{name.upper()} must be at least {floor}" in text
    assert "1234" not in text  # the rejected value is not echoed
    assert make(**{"database_url": DB, name: 100}).app_env == "development"  # production only


# ---- the development outbox stays out of the repository (audit recommendation 15) -----------------


@pytest.mark.parametrize(
    "value",
    [
        # A Windows path whose backslashes Git Bash removed: drive-relative, so it was resolved to
        # backend/UsersUser... beside the source code (56 e-mails with pass links, not git-ignored).
        "C:UsersUserAppDataLocalTempclaudeC--Users-Userscratchpadfix3outbox",
        "UsersYouAppDataLocalTempoutbox",
        "outbox",
        "../outbox",
        "var/../outbox",
    ],
)
def test_a_relative_outbox_outside_var_is_refused(value: str) -> None:
    with pytest.raises(ValidationError, match="EMAIL_OUTBOX_DIR must be an absolute path"):
        make(database_url=DB, email_outbox_dir=value)


@pytest.mark.parametrize("value", ["var/outbox", "var/e2e/outbox", "var"])
def test_a_relative_outbox_inside_var_is_resolved_against_the_backend(value: str) -> None:
    assert make(database_url=DB, email_outbox_dir=value).email_outbox_dir == (BACKEND_DIR / value).resolve()


def test_an_absolute_outbox_is_taken_as_given(tmp_path: Path) -> None:
    """The E2E suite gives an absolute directory under frontend/e2e/.artifacts (git-ignored)."""
    assert make(database_url=DB, email_outbox_dir=str(tmp_path)).email_outbox_dir == tmp_path


# ---- SMTP (S10-2) -----------------------------------------------------------------------------------

SMTP_PASSWORD = "Smtp-Secret-Pass-0123"
GMAIL = {
    "email_provider": "smtp",
    "smtp_host": "smtp.gmail.com",
    "smtp_username": "visitors.desk@gmail.com",
    "smtp_password": "abcdefghijklmnop",
    "email_from": "Mawdoo3 <visitors.desk@gmail.com>",
}


def test_smtp_defaults_follow_the_security_mode() -> None:
    settings = make(database_url=DB, **GMAIL)
    assert (settings.smtp_security, settings.smtp_server_port, settings.smtp_timeout_seconds) == (
        "starttls",
        587,
        10.0,
    )
    assert make(database_url=DB, **GMAIL, smtp_security="SSL").smtp_server_port == 465
    assert make(database_url=DB, **GMAIL, smtp_security="ssl", smtp_port="2465").smtp_server_port == 2465
    local = {"email_provider": "smtp", "smtp_host": "localhost", "smtp_security": "none"}
    assert make(database_url=DB, **local).smtp_server_port == 25
    # Empty values (as the template ships them) mean "not set".
    assert make(database_url=DB, **GMAIL, smtp_port="").smtp_server_port == 587


@pytest.mark.parametrize(
    ("values", "problem"),
    [
        ({"smtp_host": ""}, "EMAIL_PROVIDER=smtp requires SMTP_HOST"),
        ({"smtp_password": ""}, "EMAIL_PROVIDER=smtp requires SMTP_PASSWORD when SMTP_USERNAME is set"),
        ({"smtp_username": " "}, "EMAIL_PROVIDER=smtp requires SMTP_USERNAME when SMTP_PASSWORD is set"),
        ({"email_from": "Mawdoo3"}, "EMAIL_FROM must be an e-mail address"),
        (
            {"smtp_security": "none"},
            "SMTP_SECURITY=none would send SMTP_USERNAME and SMTP_PASSWORD unencrypted",
        ),
        ({"smtp_security": "tls"}, "smtp_security"),
        ({"smtp_timeout_seconds": 0}, "smtp_timeout_seconds"),
        ({"smtp_port": 70000}, "smtp_port"),
    ],
)
def test_smtp_settings_are_checked_at_startup(values: dict, problem: str) -> None:
    with pytest.raises(ValidationError) as caught:
        make(database_url=DB, **{**GMAIL, **values})
    text = str(caught.value)
    assert problem in text
    assert "abcdefghijklmnop" not in text and "input_value" not in text


@pytest.mark.parametrize(
    "host",
    [
        "smtp.gmail.com:587",
        "smtps://smtp.gmail.com",
        "smtp.gmail.com/",
        "smtp gmail.com",
        "-smtp.example.com",
    ],
)
def test_smtp_host_is_a_host_name_or_address(host: str) -> None:
    with pytest.raises(ValidationError, match="SMTP_HOST must be a host name") as caught:
        make(database_url=DB, **{**GMAIL, "smtp_host": host})
    assert host not in str(caught.value)


@pytest.mark.parametrize(
    ("host", "stored"),
    [
        ("SMTP.Gmail.com", "smtp.gmail.com"),
        ("mailpit", "mailpit"),
        ("10.0.0.25", "10.0.0.25"),
        ("[::1]", "::1"),
    ],
)
def test_smtp_host_is_normalised(host: str, stored: str) -> None:
    assert make(database_url=DB, **{**GMAIL, "smtp_host": host}).smtp_host == stored


@pytest.mark.parametrize("field", ["smtp_username", "smtp_password"])
@pytest.mark.parametrize("value", ["pässwörd-123", "pass\x00word", "line\nbreak"])
def test_smtp_credentials_are_printable_ascii_and_never_echoed(field: str, value: str) -> None:
    with pytest.raises(ValidationError) as caught:
        make(database_url=DB, **{**GMAIL, field: value})
    text = str(caught.value)
    assert f"{field.upper()} must contain only printable ASCII characters" in text
    assert value not in text and "input_value" not in text


def test_the_smtp_password_is_a_secret() -> None:
    settings = make(database_url=DB, **{**GMAIL, "smtp_password": SMTP_PASSWORD})
    assert SMTP_PASSWORD not in repr(settings) and SMTP_PASSWORD not in str(settings)
    assert settings.smtp_password is not None and settings.smtp_password.get_secret_value() == SMTP_PASSWORD


@pytest.mark.parametrize("pasted", ["abcd efgh ijkl mnop", "ABCD EFGH IJKL MNOP", "abcdefghijklmnop"])
def test_a_gmail_app_password_is_taken_with_or_without_its_spaces(pasted: str) -> None:
    settings = make(database_url=DB, **{**GMAIL, "smtp_password": pasted})
    assert settings.smtp_password is not None
    assert settings.smtp_password.get_secret_value() == pasted.replace(" ", "")


def test_only_gmail_app_passwords_lose_their_spaces() -> None:
    other = make(
        database_url=DB, **{**GMAIL, "smtp_host": "smtp.example.com", "smtp_password": "abcd efgh ijkl mnop"}
    )
    assert other.smtp_password is not None and other.smtp_password.get_secret_value() == "abcd efgh ijkl mnop"
    phrase = make(database_url=DB, **{**GMAIL, "smtp_password": "correct horse battery staple"})
    assert phrase.smtp_password is not None
    assert phrase.smtp_password.get_secret_value() == "correct horse battery staple"


def test_a_local_capture_server_needs_no_credentials_outside_production() -> None:
    for environment in ("development", "test"):
        settings = make(
            app_env=environment,
            database_url=DB,
            email_provider="smtp",
            smtp_host="localhost",
            smtp_port="1025",
            smtp_security="none",
        )
        assert (settings.smtp_security, settings.smtp_server_port) == ("none", 1025)


@pytest.mark.parametrize("security", ["starttls", "ssl"])
def test_production_accepts_smtp_over_tls(security: str) -> None:
    settings = make(**{**PRODUCTION, **GMAIL, "smtp_security": security})
    assert settings.is_production and settings.email_provider == "smtp"


def test_production_refuses_smtp_without_tls() -> None:
    with pytest.raises(ValidationError) as caught:
        make(
            **{
                **PRODUCTION,
                "email_provider": "smtp",
                "smtp_host": "mail.internal.example",
                "smtp_security": "none",
            }
        )
    assert "SMTP_SECURITY=none is for development and tests only" in str(caught.value)


def test_smtp_settings_are_ignored_by_other_providers() -> None:
    settings = make(database_url=DB, email_provider="outbox", smtp_username="someone@example.com")
    assert settings.email_provider == "outbox"


def test_email_address_of() -> None:
    assert email_address_of("Mawdoo3 <Desk@Gmail.com>") == "desk@gmail.com"
    assert email_address_of("desk@gmail.com") == "desk@gmail.com"
    assert email_address_of("Mawdoo3") is None
    assert email_address_of("a@b.test, c@d.test") is None


# ---- the brand (Phase 10, B10-5) ------------------------------------------------------------------


def test_the_brand_defaults_to_mawdoo3_in_both_languages() -> None:
    settings = make(database_url=DB)
    assert (settings.brand_name_ar, settings.brand_name_en) == ("موضوع", "Mawdoo3")
    assert "visitor management" not in settings.email_from.lower()


def test_the_product_is_mawdoo3_visitors_and_sends_the_e_mails() -> None:
    """B10-16: the product's own name, beside the brand; EMAIL_FROM's default sender name is it."""
    settings = make(database_url=DB)
    assert (settings.product_name_ar, settings.product_name_en) == ("زوار موضوع", "Mawdoo3 Visitors")
    assert settings.email_from == "Mawdoo3 Visitors <no-reply@localhost>"
    custom = make(database_url=DB, product_name_en="  Acme Visits ", product_name_ar=" زيارات أكمي ")
    assert (custom.product_name_en, custom.product_name_ar) == ("Acme Visits", "زيارات أكمي")


def test_the_brand_names_are_trimmed_and_normalised() -> None:
    settings = make(database_url=DB, brand_name_en="  Acme Visits ", brand_name_ar=" زيارات أكمي ")
    assert (settings.brand_name_en, settings.brand_name_ar) == ("Acme Visits", "زيارات أكمي")


@pytest.mark.parametrize(
    ("field", "value", "problem"),
    [
        ("brand_name_en", "   ", "BRAND_NAME_EN must not be empty"),
        ("brand_name_ar", "", "BRAND_NAME_AR must not be empty"),
        ("brand_name_en", "x" * 61, "BRAND_NAME_EN must be at most 60 characters"),
        ("brand_name_en", "Mawdoo3\nBcc: x@evil.test", "BRAND_NAME_EN must be one line of visible text"),
        ("brand_name_en", "Maw\u202edoo3", "BRAND_NAME_EN must be one line of visible text"),
        ("brand_name_ar", "موضوع\u2028x", "BRAND_NAME_AR must be one line of visible text"),
        ("brand_name_ar", "مو\u200bضوع", "BRAND_NAME_AR must be one line of visible text"),
        ("brand_name_en", "Mawdoo3\x00", "BRAND_NAME_EN must be one line of visible text"),
        ("product_name_en", " ", "PRODUCT_NAME_EN must not be empty"),
        ("product_name_ar", "ز" * 61, "PRODUCT_NAME_AR must be at most 60 characters"),
        (
            "product_name_en",
            "Visitors\r\nBcc: x@evil.test",
            "PRODUCT_NAME_EN must be one line of visible text",
        ),
        ("product_name_ar", "زوار\u202bموضوع", "PRODUCT_NAME_AR must be one line of visible text"),
    ],
)
def test_a_brand_name_must_be_one_line_of_visible_text(field: str, value: str, problem: str) -> None:
    with pytest.raises(ValidationError, match=problem) as caught:
        make(database_url=DB, **{field: value})
    assert "evil" not in str(caught.value)  # the value is never echoed (hide_input_in_errors)


def test_the_tracking_provider_is_off_by_default_everywhere() -> None:
    """Phase 15 (B15-1): `disabled` unless a deployment says otherwise; production's template keeps it."""
    assert make(database_url=DB).tracking_provider == "disabled"
    assert make(**PRODUCTION).tracking_provider == "disabled"
    assert make(database_url=DB, tracking_provider="simulator").tracking_provider == "simulator"
    with pytest.raises(ValidationError):
        make(database_url=DB, tracking_provider="shaheen")  # no real adapter exists
    template = (REPO_ROOT / "deploy" / "env" / "backend.env.example").read_text(encoding="utf-8")
    assert any(line.rstrip() == "TRACKING_PROVIDER=disabled" for line in template.splitlines())
    assert _env_example_value("TRACKING_PROVIDER") == "disabled"
