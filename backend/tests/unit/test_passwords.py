import random
import threading

import pytest

from app.core.errors import ServiceBusy
from app.security.passwords import (
    GUESSABLE_MESSAGE,
    PASSWORD_GUESSABLE,
    PASSWORD_PERSONAL,
    PERSONAL_MESSAGE,
    PRODUCTION_ARGON2,
    Argon2Parameters,
    PasswordHasherService,
    password_policy_error,
)

FAST = Argon2Parameters(time_cost=1, memory_cost_kib=1024, parallelism=1)


@pytest.fixture(scope="module")
def hasher() -> PasswordHasherService:
    return PasswordHasherService(FAST, max_concurrency=2)


def test_production_parameters_are_explicit() -> None:
    assert (
        Argon2Parameters(time_cost=3, memory_cost_kib=65536, parallelism=4, hash_len=32, salt_len=16)
        == PRODUCTION_ARGON2
    )
    encoded = PasswordHasherService().hash("Some-Long-Password-1")
    assert encoded.startswith("$argon2id$v=19$m=65536,t=3,p=4$")


def test_hash_and_verify(hasher: PasswordHasherService) -> None:
    encoded = hasher.hash("Correct-Horse-Battery")
    assert encoded.startswith("$argon2id$")
    assert hasher.verify(encoded, "Correct-Horse-Battery")
    assert not hasher.verify(encoded, "correct-horse-battery")
    assert hasher.hash("Correct-Horse-Battery") != encoded  # salted


def test_verify_tolerates_garbage_hashes(hasher: PasswordHasherService) -> None:
    assert not hasher.verify("not-a-hash", "anything")
    assert hasher.needs_rehash("not-a-hash")


def test_unicode_normalisation(hasher: PasswordHasherService) -> None:
    composed = "Café-Passphrase-12"
    decomposed = "Café-Passphrase-12"
    assert hasher.verify(hasher.hash(composed), decomposed)


def test_dummy_verification_always_fails(hasher: PasswordHasherService) -> None:
    assert hasher.verify_dummy("whatever") is False
    assert hasher.verify_dummy("whatever") is False  # dummy hash computed once, reused


def test_needs_rehash_when_parameters_change(hasher: PasswordHasherService) -> None:
    stronger = PasswordHasherService(Argon2Parameters(time_cost=2, memory_cost_kib=2048, parallelism=1))
    assert stronger.needs_rehash(hasher.hash("Some-Long-Password-1"))
    assert not hasher.needs_rehash(hasher.hash("Some-Long-Password-1"))


def test_saturation_fails_fast_with_service_busy() -> None:
    busy = PasswordHasherService(FAST, max_concurrency=1, acquire_timeout_seconds=0.05)
    occupied = threading.Event()
    release = threading.Event()

    def hold_the_only_slot() -> None:
        with busy._slot():
            occupied.set()
            release.wait(5)

    holder = threading.Thread(target=hold_the_only_slot)
    holder.start()
    occupied.wait(5)
    try:
        with pytest.raises(ServiceBusy):
            busy.hash("Some-Long-Password-1")
    finally:
        release.set()
        holder.join(5)
    assert busy.verify(busy.hash("Some-Long-Password-1"), "Some-Long-Password-1")


@pytest.mark.parametrize(
    ("password", "email", "expected"),
    [
        ("Elevenchars", None, "at least 12"),
        ("x" * 129, None, "at most 128"),
        ("Password1234", None, "too common"),
        ("  QWERTY123456  ", None, "too common"),
        ("person@example.com", "Person@Example.com", "email"),
        ("A-Perfectly-Fine-Passphrase", "person@example.com", None),
        ("x" * 128, None, None),
        ("é" * 12, None, None),
    ],
)
def test_password_policy(password: str, email: str | None, expected: str | None) -> None:
    error = password_policy_error(password, email=email)
    if expected is None:
        assert error is None
    else:
        assert error is not None
        assert expected in error.message


# ---- guessable passwords (SEC-03): what password spraying tries ------------------------------------

JANE = {"email": "jane.doe@demo.local", "context": ("Jane Doe", "Demo Company", "demo-company")}


@pytest.mark.parametrize(
    "password",
    [
        "Password@2026",
        "Welcome@2026",
        "Admin@123456",
        "Qwerty@123456",
        "Password2026!",
        "Passw0rd!234",
        "P@55w0rd-2026",
        "Spring2026!!",
        "Summer2026!!",
        "Company@2026",
        "Visitor@2026",
        "Welcome@12345",
        "Temporary-Pass-2026",
        "Mohammad1990!",
        "Summer-in-Amman-2026",
        "DemoCompany1!",
    ],
)
def test_common_words_dressed_up_with_digits_and_symbols_are_refused(password: str) -> None:
    assert password_policy_error(password) == PASSWORD_GUESSABLE
    assert password_policy_error(password, **JANE) == PASSWORD_GUESSABLE
    assert PASSWORD_GUESSABLE.message == GUESSABLE_MESSAGE


@pytest.mark.parametrize("password", ["demo.local12", "jane.doe2026!", "JaneDoe@2026", "J4n3-D0e-1990!!"])
def test_passwords_built_from_the_account_itself_are_refused(password: str) -> None:
    assert password_policy_error(password, **JANE) == PASSWORD_PERSONAL
    assert PASSWORD_PERSONAL.message == PERSONAL_MESSAGE
    assert password_policy_error(password, email="someone@example.com") is None  # not someone else's


@pytest.mark.parametrize(
    "password",
    [
        "Correct-Horse-Battery-42",
        "correct horse battery staple",
        "Passionfruit-Monday-77",
        "Brand-New-Password-2026",
        "8#2$9!4@7%1^3&5*",
        "Ahmad loves the sea at Aqaba",
        "\N{ARABIC LETTER SEEN}\N{ARABIC LETTER ALEF}\N{ARABIC LETTER REH}\N{ARABIC LETTER TEH MARBUTA}"
        " 2026 xyz",
    ],
)
def test_passphrases_and_random_passwords_are_accepted(password: str) -> None:
    assert password_policy_error(password, **JANE) is None


def test_generated_temporary_passwords_are_never_refused() -> None:
    """The admin form's generator (frontend `temporaryPassword.ts`: 20 characters of this alphabet)."""
    alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    rng = random.Random(20261006)
    for _ in range(5000):
        password = "".join(rng.choice(alphabet) for _ in range(20))
        assert password_policy_error(password, **JANE) is None, password


def test_the_development_seed_password_passes_only_the_basic_rules() -> None:
    assert password_policy_error("Demo-Visitor-2026") == PASSWORD_GUESSABLE
    assert password_policy_error("Demo-Visitor-2026", dictionary=False) is None
    assert password_policy_error("Password1234", dictionary=False) is not None
