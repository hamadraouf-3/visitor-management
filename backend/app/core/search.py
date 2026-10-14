"""Visitor search normalisation (contract §4 `visitors.search_text`, `visitors.phone_digits`).

Stored text and queries are folded the same way, so a search matches regardless of case, accents,
Arabic letter variants or the way a phone number was typed:

* case: `str.casefold` (sharp s → ss, dotted capital I → i);
* accents: compatibility decomposition (NFKD) with every combining mark removed (e-acute → e, the fi
  ligature → fi, Arabic presentation forms → base letters);
* Arabic: alef with hamza above/below, with madda and alef wasla → alef; teh marbuta → heh; alef
  maksura → yeh; tatweel and harakat removed (the harakat are combining marks, so the previous step
  already drops them);
* whitespace collapsed to single spaces.

Phone numbers keep their ASCII digits only (Arabic-Indic and other decimal digits are converted), and a
query with at least six digits also matches on its last nine digits, so `0791234567` finds
`+962 79 123 4567`.

Lists are ordered by the same folding (`visitors.name_sort`): the cluster's builtin C.UTF-8 collation
compares code points, so ordering by the name itself puts `Élodie` after `Sarah` and alef with hamza
before the bare alef.
"""

import unicodedata

_ALEF = "\N{ARABIC LETTER ALEF}"
_ARABIC_FOLDS = str.maketrans(
    {
        "\N{ARABIC LETTER ALEF WITH HAMZA ABOVE}": _ALEF,
        "\N{ARABIC LETTER ALEF WITH HAMZA BELOW}": _ALEF,
        "\N{ARABIC LETTER ALEF WITH MADDA ABOVE}": _ALEF,
        "\N{ARABIC LETTER ALEF WASLA}": _ALEF,
        "\N{ARABIC LETTER TEH MARBUTA}": "\N{ARABIC LETTER HEH}",
        "\N{ARABIC LETTER ALEF MAKSURA}": "\N{ARABIC LETTER YEH}",
        "\N{ARABIC TATWEEL}": None,
    }
)
PHONE_QUERY_MIN_DIGITS = 6
PHONE_MATCH_DIGITS = 9


def normalise_search_text(value: str) -> str:
    """The folded form stored in `search_text` and used for queries (see module docstring)."""
    decomposed = unicodedata.normalize("NFKD", unicodedata.normalize("NFKD", value).casefold())
    without_marks = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return " ".join(without_marks.translate(_ARABIC_FOLDS).split())


def visitor_search_text(full_name: str, email: str | None, company_name: str | None) -> str:
    return normalise_search_text(" ".join(part for part in (full_name, email, company_name) if part))


def name_sort_key(full_name: str) -> str:
    """The key a name is ordered by (`visitors.name_sort`): folded like search text, so `Élodie` sorts
    with `Elodie` and a name starting with alef with hamza with names starting with the bare alef,
    whatever the database collation."""
    return normalise_search_text(full_name)


def ascii_digits(value: str | None) -> str | None:
    """The decimal digits of `value` as ASCII (`+962 ٧٩` → `96279`), or None when there are none."""
    if value is None:
        return None
    digits = "".join(str(unicodedata.decimal(ch)) for ch in value if ch.isdecimal())
    return digits or None


def phone_query_digits(query: str) -> str | None:
    """The digits a query matches against `phone_digits`: its last nine digits when it has at least six,
    otherwise None (a short number is more likely part of a name or company)."""
    digits = ascii_digits(query)
    if digits is None or len(digits) < PHONE_QUERY_MIN_DIGITS:
        return None
    return digits[-PHONE_MATCH_DIGITS:]
