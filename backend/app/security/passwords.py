"""Password hashing (Argon2id) and the password policy (contract §7.1).

Parameters are explicit: time_cost=3, memory_cost=64 MiB, parallelism=4, 32-byte hash, 16-byte salt
(OWASP's Argon2id recommendations for interactive logins; ~50-150 ms per hash on current server CPUs).
A process-wide semaphore caps concurrent hash operations (each needs 64 MiB); when it stays saturated
for longer than the acquire timeout the request fails fast with 503 SERVICE_BUSY instead of queueing.

Passwords are NFKC-normalised before hashing and verification so visually identical input typed on
different keyboards/IMEs matches.

Policy (contract §7.1, extended by SEC-03): 12-128 characters, not the e-mail address, not in the
embedded list of breached passwords, and not guessable: a password built from a common word
(`common_words.txt`, the letters of the breached passwords) or from the account's own name, e-mail
address or company, plus digits, a year or symbols, is refused. Password spraying tries exactly those
("Welcome@2026", "Spring2026!!", "JaneDoe@2026") against every address it can guess.
"""

import os
import re
import secrets
import threading
import unicodedata
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import cache
from importlib import resources

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.errors import ServiceBusy
from app.core.field_errors import FieldCode, FieldProblem

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 128
# Upper bound on what we are willing to hash at all (login input is not policy-checked).
PASSWORD_INPUT_MAX_LENGTH = 1024


@dataclass(frozen=True, slots=True)
class Argon2Parameters:
    time_cost: int = 3
    memory_cost_kib: int = 64 * 1024
    parallelism: int = 4
    hash_len: int = 32
    salt_len: int = 16


PRODUCTION_ARGON2 = Argon2Parameters()


def normalise_password(password: str) -> str:
    return unicodedata.normalize("NFKC", password)


class PasswordHasherService:
    def __init__(
        self,
        parameters: Argon2Parameters = PRODUCTION_ARGON2,
        *,
        max_concurrency: int | None = None,
        acquire_timeout_seconds: float = 2.0,
    ) -> None:
        self.parameters = parameters
        self._hasher = PasswordHasher(
            time_cost=parameters.time_cost,
            memory_cost=parameters.memory_cost_kib,
            parallelism=parameters.parallelism,
            hash_len=parameters.hash_len,
            salt_len=parameters.salt_len,
            type=Type.ID,
        )
        self.max_concurrency = max_concurrency or os.cpu_count() or 4
        self._slots = threading.BoundedSemaphore(self.max_concurrency)
        self._acquire_timeout = acquire_timeout_seconds
        self._dummy_hash: str | None = None
        self._dummy_lock = threading.Lock()

    @contextmanager
    def _slot(self) -> Iterator[None]:
        if not self._slots.acquire(timeout=self._acquire_timeout):
            raise ServiceBusy()
        try:
            yield
        finally:
            self._slots.release()

    def hash(self, password: str) -> str:
        with self._slot():
            return self._hasher.hash(normalise_password(password))

    def verify(self, password_hash: str, password: str) -> bool:
        with self._slot():
            try:
                return self._hasher.verify(password_hash, normalise_password(password))
            except VerificationError, InvalidHashError:  # VerifyMismatchError is a VerificationError
                return False

    def verify_dummy(self, password: str) -> bool:
        """Spend the same work as a real verification when there is no user (timing parity). Always False."""
        self.verify(self._get_dummy_hash(), password)
        return False

    def needs_rehash(self, password_hash: str) -> bool:
        try:
            return self._hasher.check_needs_rehash(password_hash)
        except InvalidHashError:
            return True

    def _get_dummy_hash(self) -> str:
        if self._dummy_hash is None:
            with self._dummy_lock:
                if self._dummy_hash is None:
                    self._dummy_hash = self.hash(secrets.token_urlsafe(32))
        return self._dummy_hash


@cache
def _common_passwords() -> frozenset[str]:
    return frozenset(line.casefold() for line in _data_lines("common_passwords.txt"))


def _data_lines(name: str) -> list[str]:
    text = resources.files("app.security").joinpath(name).read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


# A guessable password is a common word, a name or the account's own details dressed up with digits,
# a year and symbols ("Welcome@2026", "Spring2026!!", "JaneDoe@2026"). Its letters are compared after
# undoing the usual substitutions (leetspeak): once every such word is taken out, fewer than
# `MIN_OTHER_LETTERS` letters may not remain.
MIN_OTHER_LETTERS = 4
MIN_BASE_WORD_LENGTH = 4
MIN_CONTEXT_WORD_LENGTH = 3
_COMMON_SUBSTITUTIONS = (
    str.maketrans(
        {
            "0": "o",
            "1": "i",
            "!": "i",
            "3": "e",
            "4": "a",
            "@": "a",
            "5": "s",
            "$": "s",
            "7": "t",
            "+": "t",
            "8": "b",
            "9": "g",
            "|": "l",
        }
    ),
    str.maketrans(
        {"1": "l", "!": "l", "0": "o", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t"}
    ),
)


def _letters(text: str) -> str:
    return "".join(ch for ch in text if ch.isalpha())


@cache
def _base_words() -> tuple[str, ...]:
    """Common words and the letters of the common passwords, longest first."""
    words = {word.casefold() for word in _data_lines("common_words.txt")}
    words |= {_letters(entry) for entry in _common_passwords()}
    return _longest_first(word for word in words if len(word) >= MIN_BASE_WORD_LENGTH)


def common_base_words() -> tuple[str, ...]:
    """The common words guessable passwords are built from (lowercase letters, at least four, longest
    first); also used to estimate SECRET_KEY's strength (`security.secret_strength`)."""
    return _base_words()


def _longest_first(words: Iterable[str]) -> tuple[str, ...]:
    """Longest first, so a longer word is taken out before a shorter one inside it."""
    return tuple(sorted(set(words), key=lambda word: (-len(word), word)))


_EDGE_NON_LETTERS = re.compile(r"^[\W\d_]+|[\W\d_]+$")


def _skeletons(password: str) -> set[str]:
    """The password's letters (casefolded) as typed, and with the common substitutions undone: once for
    the whole password and once without its leading and trailing digits and symbols, so a year or
    "!234" at the end is not read as letters ("J4n3-D0e-1990!!" is "janedoe")."""
    folded = normalise_password(password).casefold()
    core = _EDGE_NON_LETTERS.sub("", folded)
    return {_letters(folded)} | {
        _letters(text.translate(table)) for text in (folded, core) for table in _COMMON_SUBSTITUTIONS
    }


def _context_words(email: str | None, context: Iterable[str]) -> tuple[str, ...]:
    """The account's own words: the e-mail address's local part and domain labels, and the parts of
    the names given (full name, company name and slug), each whole and joined."""
    texts = list(context)
    if email:
        local, _at, domain = email.casefold().rpartition("@")
        texts += [local, *domain.split(".")]
    words: set[str] = set()
    for text in texts:
        parts = [
            _letters(part) for part in re.split(r"[^\w]+|_", unicodedata.normalize("NFKC", text).casefold())
        ]
        words.update(part for part in parts if len(part) >= MIN_CONTEXT_WORD_LENGTH)
        joined = "".join(parts)
        if len(joined) >= MIN_CONTEXT_WORD_LENGTH:
            words.add(joined)
    return _longest_first(words)


def _built_from(skeleton: str, words: Iterable[str]) -> bool:
    """Whether `skeleton` contains at least one of `words` and, without them, fewer than
    `MIN_OTHER_LETTERS` letters."""
    remaining, found = skeleton, False
    for word in words:
        if word in remaining:
            remaining = remaining.replace(word, "")
            found = True
    return found and len(remaining) < MIN_OTHER_LETTERS


GUESSABLE_MESSAGE = (
    "This password is too easy to guess: it is a common word with numbers or symbols added. "
    "Choose a less predictable password."
)
PERSONAL_MESSAGE = (
    "This password is too easy to guess: it is based on your name, email address or company. "
    "Choose a less predictable password."
)


PASSWORD_TOO_SHORT = FieldProblem(
    FieldCode.TOO_SHORT,
    f"Password must be at least {PASSWORD_MIN_LENGTH} characters.",
    {"min": PASSWORD_MIN_LENGTH},
)
PASSWORD_TOO_LONG = FieldProblem(
    FieldCode.TOO_LONG,
    f"Password must be at most {PASSWORD_MAX_LENGTH} characters.",
    {"max": PASSWORD_MAX_LENGTH},
)
PASSWORD_IS_EMAIL = FieldProblem(
    FieldCode.PASSWORD_IS_EMAIL, "Password must not be the same as your email address."
)
PASSWORD_COMMON = FieldProblem(
    FieldCode.PASSWORD_COMMON, "This password is too common. Choose a less predictable password."
)
PASSWORD_GUESSABLE = FieldProblem(FieldCode.PASSWORD_GUESSABLE, GUESSABLE_MESSAGE)
PASSWORD_PERSONAL = FieldProblem(FieldCode.PASSWORD_PERSONAL, PERSONAL_MESSAGE)


def password_policy_error(
    password: str, *, email: str | None = None, context: Iterable[str] = (), dictionary: bool = True
) -> FieldProblem | None:
    """Why a new password is unacceptable (its code and user-facing message), or None when it satisfies
    the policy.

    `context`: the account's own names (full name, company name and slug), which a password must not be
    built from, any more than from the e-mail address. `dictionary=False` applies only the length and
    common-password rules (the development seed's published demo password)."""
    normalised = normalise_password(password)
    if len(normalised) < PASSWORD_MIN_LENGTH:
        return PASSWORD_TOO_SHORT
    if len(normalised) > PASSWORD_MAX_LENGTH:
        return PASSWORD_TOO_LONG
    folded = normalised.strip().casefold()
    if email and folded == email.strip().casefold():
        return PASSWORD_IS_EMAIL
    if folded in _common_passwords():
        return PASSWORD_COMMON
    if not dictionary:
        return None
    skeletons = _skeletons(password)
    if any(_built_from(skeleton, _base_words()) for skeleton in skeletons):
        return PASSWORD_GUESSABLE
    personal = _context_words(email, context)
    if personal:
        words = _longest_first((*personal, *_base_words()))
        if any(_built_from(skeleton, words) for skeleton in skeletons):
            return PASSWORD_PERSONAL
    return None
