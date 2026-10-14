"""Text normalisation shared by schemas and services."""

import re
import unicodedata

from email_validator import EmailNotValidError, validate_email

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError

EMAIL_MAX_LENGTH = 320
# RFC 6761/6762 special-use domains accepted on purpose: on-premise and demo installations use
# `.local` addresses and the E2E suite uses `.test`. Deliverability is the provider's concern.
_ACCEPTED_SPECIAL_USE_SUFFIX = ".local"
_PROBE_SUFFIX = ".test"


# C0 controls and DEL, except tab, line feed and carriage return (multi-line text). PostgreSQL text
# cannot hold NUL at all, and none of these belong in form input, headers or logs.
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
CONTROL_CHARACTERS_MESSAGE = "Remove unsupported control characters."
CONTROL_CHARACTERS = FieldProblem(FieldCode.CONTROL_CHARACTERS, CONTROL_CHARACTERS_MESSAGE)
INVALID_DOMAIN = FieldProblem(FieldCode.INVALID_DOMAIN, "Enter a domain name such as example.com.")


def has_control_characters(value: str) -> bool:
    return _CONTROL_CHARACTERS.search(value) is not None


def normalise_email(value: str) -> str:
    """Identifier normalisation for lookups (login, forgot-password): NFKC, trimmed, lowercase."""
    return unicodedata.normalize("NFKC", value).strip().lower()


def validate_email_address(value: str) -> str:
    """Validate a new e-mail address and return its stored form (lowercase). Raises FieldValueError (a
    ValueError) with the code `too_long` or `invalid_email`."""
    candidate = unicodedata.normalize("NFKC", value).strip()
    if len(candidate) > EMAIL_MAX_LENGTH:
        raise FieldValueError(
            FieldProblem(FieldCode.TOO_LONG, "Email address is too long.", {"max": EMAIL_MAX_LENGTH})
        )
    local, at, domain = candidate.rpartition("@")
    probe = candidate
    if at and domain.lower().endswith(_ACCEPTED_SPECIAL_USE_SUFFIX):
        probe = f"{local}@{domain[: -len(_ACCEPTED_SPECIAL_USE_SUFFIX)]}{_PROBE_SUFFIX}"
    try:
        result = validate_email(
            probe,
            check_deliverability=False,
            test_environment=True,
            allow_quoted_local=False,
            allow_domain_literal=False,
            allow_display_name=False,
        )
    except EmailNotValidError as exc:
        raise _invalid_email(f"Enter a valid email address. {exc}") from None
    if "=?" in result.local_part:
        # RFC 2047 §5: an encoded word never appears in an address, and mail libraries decode one in a
        # header anyway (the To line would then name another mailbox than the envelope).
        raise _invalid_email('Enter a valid email address. The part before the @-sign cannot contain "=?".')
    normalised_domain = result.domain if probe == candidate else domain
    return f"{result.local_part}@{normalised_domain}".lower()


def _invalid_email(message: str) -> FieldValueError:
    """The address checker's own reason (in English) follows "Enter a valid email address."."""
    return FieldValueError(FieldProblem(FieldCode.INVALID_EMAIL, message))


# A DNS host name in lowercase ASCII (IDNs in their xn-- form): labels of 1-63 letters, digits and
# inner hyphens, at least two labels, and a top-level label of 2+ characters starting with a letter.
_DOMAIN_NAME = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]", re.ASCII
)


def normalise_domain_name(value: str) -> str:
    """Lowercase domain name (`example.com`, `fail.test`); leading `@`s are dropped. Raises FieldValueError
    (`invalid_domain`)."""
    candidate = value.strip().lower().lstrip("@")
    if not _DOMAIN_NAME.fullmatch(candidate):
        raise FieldValueError(INVALID_DOMAIN)
    return candidate


# A company's slug (B11-12): 1-80 lowercase letters, digits and inner hyphens. It is the company's public
# name in addresses (/c/<slug>, ?c=<slug>, the public identity endpoints: B12-9), so it needs no escaping
# anywhere, and anything else can be refused before it reaches a query.
_COMPANY_SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?", re.ASCII)


def is_company_slug(value: str) -> bool:
    return _COMPANY_SLUG.fullmatch(value) is not None


def escape_like(value: str) -> str:
    """Escape LIKE/ILIKE wildcards; use with `escape='\\\\'`."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
