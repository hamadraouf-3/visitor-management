"""Search normalisation (contract §4): case, accents, Arabic letter variants and phone digits."""

import pytest

from app.core.search import (
    ascii_digits,
    name_sort_key,
    normalise_search_text,
    phone_query_digits,
    visitor_search_text,
)

ALEF = "\N{ARABIC LETTER ALEF}"
HEH = "\N{ARABIC LETTER HEH}"
YEH = "\N{ARABIC LETTER YEH}"
# Alphabetically: Ibrahim (alef, beh, ...), Ahmad (alef with hamza above, hah, ...), Bashir (beh, ...).
IBRAHIM = "\N{ARABIC LETTER ALEF}\N{ARABIC LETTER BEH}\N{ARABIC LETTER REH}\N{ARABIC LETTER ALEF}"
AHMAD = (
    "\N{ARABIC LETTER ALEF WITH HAMZA ABOVE}\N{ARABIC LETTER HAH}\N{ARABIC LETTER MEEM}\N{ARABIC LETTER DAL}"
)
BASHIR = "\N{ARABIC LETTER BEH}\N{ARABIC LETTER SHEEN}\N{ARABIC LETTER YEH}\N{ARABIC LETTER REH}"


@pytest.mark.parametrize(
    ("raw", "folded"),
    [
        ("Élodie MARTIN", "elodie martin"),
        ("  Zoë   Ångström\t", "zoe angstrom"),
        ("Straße", "strasse"),
        ("\N{LATIN SMALL LIGATURE FI}ona", "fiona"),
        ("\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}stanbul", "istanbul"),
        ("".join(chr(ord(letter) + 0xFEE0) for letter in "Fullwidth"), "fullwidth"),
        ("\N{ARABIC LETTER ALEF WITH HAMZA ABOVE}", ALEF),
        ("\N{ARABIC LETTER ALEF WITH HAMZA BELOW}", ALEF),
        ("\N{ARABIC LETTER ALEF WITH MADDA ABOVE}", ALEF),
        ("\N{ARABIC LETTER ALEF WASLA}", ALEF),
        ("\N{ARABIC LETTER TEH MARBUTA}", HEH),
        ("\N{ARABIC LETTER ALEF MAKSURA}", YEH),
        ("\N{ARABIC LETTER BEH}\N{ARABIC TATWEEL}\N{ARABIC LETTER BEH}", "\N{ARABIC LETTER BEH}" * 2),
        (
            "\N{ARABIC LETTER MEEM}\N{ARABIC FATHA}\N{ARABIC LETTER HAH}\N{ARABIC SUKUN}"
            "\N{ARABIC LETTER MEEM}\N{ARABIC DAMMA}\N{ARABIC LETTER DAL}\N{ARABIC SHADDA}",
            "\N{ARABIC LETTER MEEM}\N{ARABIC LETTER HAH}\N{ARABIC LETTER MEEM}\N{ARABIC LETTER DAL}",
        ),
        # Presentation forms decompose to the base letters.
        ("\N{ARABIC LETTER ALEF ISOLATED FORM}", ALEF),
        ("", ""),
    ],
)
def test_normalise_search_text(raw: str, folded: str) -> None:
    assert normalise_search_text(raw) == folded


def test_query_and_stored_text_fold_alike() -> None:
    stored = visitor_search_text(
        "Fatima Al-Zahra\N{ARABIC LETTER TEH MARBUTA}", "F.Z@Example.com", "Société A"
    )
    assert normalise_search_text("SOCIETE a") in stored
    assert normalise_search_text("f.z@example") in stored
    assert normalise_search_text("zahra\N{ARABIC LETTER HEH}") in stored


def test_visitor_search_text_skips_missing_parts() -> None:
    assert visitor_search_text("Dana", None, None) == "dana"
    assert visitor_search_text("Dana", "d@example.com", "Acme") == "dana d@example.com acme"


def test_name_sort_key_orders_names_as_people_read_them() -> None:
    """Python compares strings by code point, as the database's C.UTF-8 collation does."""
    names = ["Sarah Johnson", "Élodie Marchand", "daniel Smith", "Karim Haddad", BASHIR, AHMAD, IBRAHIM]
    assert sorted(names, key=name_sort_key) == [
        "daniel Smith",
        "Élodie Marchand",
        "Karim Haddad",
        "Sarah Johnson",
        IBRAHIM,
        AHMAD,
        BASHIR,
    ]
    # Ordering by lower(full_name), as the visitor list did before revision 0004:
    assert sorted(names, key=str.lower) == [
        "daniel Smith",
        "Karim Haddad",
        "Sarah Johnson",
        "Élodie Marchand",
        AHMAD,
        IBRAHIM,
        BASHIR,
    ]
    assert name_sort_key("  Élodie   MARCHAND ") == "elodie marchand"


@pytest.mark.parametrize(
    ("raw", "digits"),
    [
        ("+962 79 123-4567", "962791234567"),
        ("(06) 500 1000 ext. 2", "0650010002"),
        ("".join(chr(0x0660 + int(d)) for d in "0791234567"), "0791234567"),  # Arabic-Indic digits
        ("".join(chr(0x06F0 + int(d)) for d in "123"), "123"),  # Extended Arabic-Indic (Persian)
        ("no digits", None),
        (None, None),
    ],
)
def test_ascii_digits(raw: str | None, digits: str | None) -> None:
    assert ascii_digits(raw) == digits


@pytest.mark.parametrize(
    ("query", "match"),
    [
        ("0791234567", "791234567"),
        ("+962791234567", "791234567"),
        ("00962 79 123 4567", "791234567"),
        ("123456", "123456"),
        ("12345", None),
        ("Room 12", None),
    ],
)
def test_phone_query_digits(query: str, match: str | None) -> None:
    assert phone_query_digits(query) == match
