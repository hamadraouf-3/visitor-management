"""SECRET_KEY strength estimate (SEC-35): human-made shapes score low, generated keys high."""

import secrets
import string

import pytest

from app.security.secret_strength import MIN_SECRET_BITS, estimated_bits, is_strong_secret


@pytest.mark.parametrize(
    ("secret", "most"),
    [
        ("0123456789" * 4, 40),  # an ascending run, then repetitions
        ("qwertyuiopasdfghjklzxcvbnm123456", 40),  # keyboard rows
        ("abcdefghijklmnopqrstuvwxyzabcdef", 40),
        ("a" * 40, 10),
        ("todo-todo-todo-todo-todo-todo-todo-todo", 40),
        ("P4ssw0rd-Admin-2026-Visitor-Management-System!", 100),  # substitutions undone, a year
        ("BankVMS-Production-2026-Key-Amman", 110),  # the finding's example
    ],
)
def test_human_made_keys_score_low(secret: str, most: float) -> None:
    assert estimated_bits(secret) <= most
    assert not is_strong_secret(secret)


def test_the_estimate_is_the_cheapest_reading() -> None:
    """A long run is cheaper than the same letters read as a word-shaped token or as random letters."""
    assert estimated_bits("abcdefghijklmnopqrstuvwxyz") == pytest.approx(8.0)
    assert estimated_bits("Production") == pytest.approx(1 + 2.5 * 10)
    assert estimated_bits("production") < estimated_bits("pr0ductxqz")  # a lowercase word between edges


@pytest.mark.parametrize(
    "generate",
    [
        lambda: secrets.token_urlsafe(48),
        lambda: secrets.token_urlsafe(32),
        lambda: secrets.token_hex(32),
        lambda: "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(43)),
        lambda: "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(43)),
    ],
)
def test_generated_keys_of_the_minimum_length_pass_with_a_margin(generate) -> None:
    scores = [estimated_bits(generate()) for _ in range(300)]
    assert min(scores) >= MIN_SECRET_BITS + 10


def test_only_the_start_of_a_very_long_value_is_examined() -> None:
    assert estimated_bits(secrets.token_urlsafe(2000)) > MIN_SECRET_BITS
