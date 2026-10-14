"""Temporary passwords of platform accounts and the failure budget of their own (B11-35).

A platform account has no forgot-password: an operator creates it, and recovers it, with
`python -m app.cli create-platform-admin [--reset]`, which hands over a temporary password. The account's
sign-in budget (ten failures, then fifteen minutes of 429) is meant for strangers, but anyone who knows
the address can keep it spent. A browser that signed in before is not held back by that (its device
cookie, SEC-01); a new account, and one whose password the operator has just reset, has no such browser.

So a password that the command **generates** carries its own proof of the hand-over. It is
`GENERATED_PASSWORD_LENGTH` random characters; a tag of the first `TAGGED_LENGTH` of them (SHA-256 with
the account's ID, `platform_admins.temporary_password_tag`) is stored beside the Argon2id hash of the whole
password. A sign-in whose password starts with the tagged characters is judged by a failure budget of that
temporary password (the numbers of a trusted browser's, `login_failures_device`) instead of the account's:

* whoever was handed the password signs in, whatever strangers do to the account's budget;
* nothing gets easier for a stranger: without the tagged characters an attempt is on the account's budget
  as before, and with them it has ten guesses at the rest, then that budget is blocked too. Finding the
  tagged characters by trying is out of reach (`TAGGED_LENGTH` random characters, about 73 bits; each
  try is a sign-in attempt);
* the tag is no second, weaker password hash: the tagged characters are extra ones in front of the
  `SECRET_LENGTH` characters that alone carry the password's strength (about 122 bits), which only the
  Argon2id hash covers. Reading the tag tells nothing about them;
* the tag lives exactly as long as the temporary password: the forced change at the first sign-in removes
  it (a CHECK keeps it from existing without `must_change_password`), and it is not honoured once the
  password has expired.

A password the operator types (`--password-stdin`) has no tag and so no budget of its own.
"""

import hashlib
import hmac
import secrets
import string
from datetime import datetime
from typing import Protocol
from uuid import UUID

from app.security.passwords import normalise_password, password_policy_error

# The characters whose tag is stored, in front of the characters that are the secret.
TAGGED_LENGTH = 12
SECRET_LENGTH = 20
GENERATED_PASSWORD_LENGTH = TAGGED_LENGTH + SECRET_LENGTH
_ALPHABET = string.ascii_letters + string.digits + "-_.!@#%"
_LABEL = "vms-platform-temporary-password-v1"


class TemporaryPasswordHolder(Protocol):
    """What `holds_temporary_password` reads of an account (`models.PlatformAdmin`)."""

    id: UUID
    must_change_password: bool
    password_expires_at: datetime | None
    temporary_password_tag: str | None


def generate_temporary_password() -> str:
    """A random temporary password that passes the password policy: `GENERATED_PASSWORD_LENGTH` characters
    of letters, digits and symbols (`TAGGED_LENGTH` tagged ones, then `SECRET_LENGTH`, about 122 bits)."""
    while True:
        password = "".join(secrets.choice(_ALPHABET) for _ in range(GENERATED_PASSWORD_LENGTH))
        if password_policy_error(password) is None:
            return password


def temporary_password_tag(account_id: UUID, password: str) -> str | None:
    """The tag of `password` for the account: SHA-256 over a label, the account's ID and the password's
    first `TAGGED_LENGTH` characters (normalised as every password is); None for a shorter password."""
    tagged = normalise_password(password)[:TAGGED_LENGTH]
    if len(tagged) < TAGGED_LENGTH:
        return None
    material = "\x1f".join((_LABEL, account_id.hex, tagged))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def holds_temporary_password(account: TemporaryPasswordHolder, password: str, *, now: datetime) -> bool:
    """Whether a sign-in with `password` starts with the tagged characters of the account's current,
    unexpired temporary password (compared in constant time). It says nothing about the rest of the
    password: the Argon2id verification decides the sign-in."""
    stored = account.temporary_password_tag
    if stored is None or not account.must_change_password:
        return False
    if account.password_expires_at is not None and account.password_expires_at <= now:
        return False
    presented = temporary_password_tag(account.id, password)
    return presented is not None and hmac.compare_digest(presented, stored)
