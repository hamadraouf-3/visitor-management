import json
import re
import unicodedata

import pytest

from app.core.config import REPO_ROOT
from app.security.tokens import (
    JS_TRIM_CHARACTERS,
    extract_pass_token,
    generate_token,
    hash_token,
    is_well_formed,
    token_matches,
)


def test_generated_tokens_are_random_and_url_safe() -> None:
    tokens = {generate_token() for _ in range(200)}
    assert len(tokens) == 200
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{43}", token) for token in tokens)
    assert all(is_well_formed(token) for token in tokens)


def test_hash_is_sha256_hex() -> None:
    assert hash_token("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert len(hash_token(generate_token())) == 64


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("a" * 32, True),
        ("a" * 128, True),
        ("a" * 31, False),
        ("a" * 129, False),
        ("a" * 40 + "=", False),
        ("a" * 40 + " ", False),
        ("", False),
        (None, False),
    ],
)
def test_well_formed(value: str | None, expected: bool) -> None:
    assert is_well_formed(value) is expected


def test_token_matches() -> None:
    token = generate_token()
    stored = hash_token(token)
    assert token_matches(stored, token)
    assert not token_matches(stored, generate_token())
    assert not token_matches(stored, None)
    assert not token_matches(stored, "short")


def _shared_vectors() -> list[dict]:
    """docs/contract/pass-token-vectors.json: the cases the frontend parser runs as well (contract §6)."""
    document = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    return document["cases"]


VECTORS_PATH = REPO_ROOT / "docs" / "contract" / "pass-token-vectors.json"
SHARED_CASES = _shared_vectors()


def test_shared_vectors_cover_valid_and_invalid_input() -> None:
    assert len(SHARED_CASES) >= 50
    assert any(case["expected"] is None for case in SHARED_CASES)
    assert any(case["expected"] is not None for case in SHARED_CASES)


def test_shared_vectors_pin_the_trim_set_at_its_edges() -> None:
    # Where ECMAScript trim() and Python's str.strip() differ: both parsers must run these cases.
    inputs = {case["input"]: case["expected"] for case in SHARED_CASES}
    assert inputs["\ufeff" + TOKEN] == TOKEN
    assert inputs[TOKEN + "\x1d"] is None
    assert inputs[TOKEN + "\x85"] is None


@pytest.mark.parametrize("case", SHARED_CASES, ids=[case["name"] for case in SHARED_CASES])
def test_extract_pass_token_follows_the_shared_vectors(case: dict) -> None:
    assert extract_pass_token(case["input"]) == case["expected"]


TOKEN = "Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        # Trimming follows ECMAScript's String.prototype.trim(), not str.strip(), so both parsers agree
        # (the shared vectors pin a leading BOM, a trailing GS and a trailing NEL):
        ("\ufeff" + TOKEN + "\u3000", TOKEN),  # BOM and ideographic space are trimmed (JS) ...
        ("\u00a0https://vms.example.com/pass#" + TOKEN + "\u2028", TOKEN),
        ("\x1c" + TOKEN, None),  # ... but not the separators U+001C-U+001F (str.strip() would)
        ("https://vms.example.com/pass\x00#" + TOKEN, None),
        ("https://vms.example.com/pass?q=%20x#" + TOKEN, TOKEN),  # encoded space in the query is fine
        ("hTtPs://vms.example.com/pass#" + TOKEN, TOKEN),
        ("https://vms.example.com:8443/pass/?#" + TOKEN, TOKEN),
        ("https://@vms.example.com/pass#" + TOKEN, None),
        ("https:///pass#" + TOKEN, None),  # no host
        ("https://vms.example.com/pass#" + TOKEN + "\n\n", TOKEN),
    ],
)
def test_extract_pass_token_edge_cases(value: str | None, expected: str | None) -> None:
    assert extract_pass_token(value) == expected


def test_trim_set_matches_ecmascript() -> None:
    # ECMAScript WhiteSpace: TAB, VT, FF, SP, NBSP, ZWNBSP (U+FEFF) and every Zs code point;
    # LineTerminator: LF, CR, LS, PS.
    zs = {chr(code) for code in range(0x110000) if unicodedata.category(chr(code)) == "Zs"}
    expected = {"\t", "\v", "\f", " ", "\u00a0", "\ufeff", "\n", "\r", "\u2028", "\u2029"} | zs
    assert set(JS_TRIM_CHARACTERS) == expected
