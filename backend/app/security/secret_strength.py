"""A conservative strength estimate for SECRET_KEY (SEC-35).

SECRET_KEY keys the device-cookie HMAC (`security.device_trust`) and the rate limiter's identifiers. A
key that can be guessed offline from one cookie (an insider's own device cookie is a known message and
MAC) lets its holder forge device cookies, i.e. failure budgets beyond the account lockout. Length and a
count of distinct characters cannot tell "BankVMS-Production-2026-Key-Amman" or a keyboard walk from a
generated key, so production also requires an estimated 128 bits, counted the way a guesser would build
the key: from words, years, runs and repetitions first, character by character only for the rest.

* Patterns (the longest at each position, case-insensitive): a common word of four or more letters (the
  password policy's list, `common_base_words`), also with the usual substitutions undone ("p4ssw0rd");
  a year 1900-2099; a run of four or more equal, ascending or descending characters ("aaaa", "abcd",
  "9876") or a stretch of a keyboard row ("qwer", "asdf"); a repetition of four or more characters of an
  earlier part of the key. Each counts a small, fixed number of bits however long it is.
* Word-shaped letters (a capital and three or more lowercase letters, "Production"; or a lowercase word
  between separators, "your-own-key"): an unknown word, 2.5 bits a letter (the order of the entropy of
  English words) and one for a capital.
* Every other character counts what a random character of its kind would give: a letter log2(52), a
  digit log2(10), a word separator (space - _ . , : ;) 2 bits, another ASCII symbol log2(33), anything
  else log2(95).
* A hexadecimal key (digits and the letters a-f in one case, as `secrets.token_hex` writes) counts 4
  bits a character; only runs and repetitions are patterns there (words and years in it are chance).

The estimate is the cheapest way to build the key from these parts (dynamic programming), so it never
credits a key more than its most guessable reading. No estimate proves that a key is random; this one
refuses the human-made shapes (words, names, dates and keyboard patterns joined by separators, or a few
words run together) and accepts generated keys of the production minimum length (43 characters) with a
margin: in samples of 20,000 each, the lowest score of `secrets.token_urlsafe(32)` and of random
letters-and-digits of 43 characters was 151 bits, and of `secrets.token_urlsafe(48)`, the documented
generator, 235 bits.
A long phrase of uncommon words can still pass: such a phrase is not guessable from a word list either.
"""

import math
import re
from functools import cache

from app.security.passwords import common_base_words

MIN_SECRET_BITS = 128
MIN_PATTERN_LENGTH = 4
WORD_BITS = 12.0  # about the size of the word list, plus a bit for the letter case
YEAR_BITS = 7.0  # 200 years
RUN_BITS = 8.0  # the first character and the direction
REPEAT_BITS = 8.0  # where the repeated part starts and how long it is
WORD_SHAPED_LETTER_BITS = 2.5
# Only the start of a longer value is examined (the estimate is quadratic in the length): a generated key
# reaches the floor within a fraction of it.
MAX_EXAMINED_LENGTH = 512

_KEYBOARD_ROWS = ("1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "qwertzuiop", "azertyuiop", "yxcvbnm")
_SEPARATORS = frozenset(" -_.,:;")
_YEAR = re.compile(r"(?:19|20)\d\d")
# A capitalised word anywhere ("Production", "MyCompanyKey"), or a lowercase word between separators or
# at an end ("your-own-key"): a run of lowercase letters next to digits or other letters is what random
# lowercase-and-digit keys are made of, so it counts as random characters. Words are at most 16 letters.
_WORD_SHAPED = re.compile(r"[A-Z][a-z]{3,15}|(?<![A-Za-z0-9])[a-z]{3,15}(?![A-Za-z0-9])")
_HEX_LOWER = re.compile(r"(?=.*[0-9])(?=.*[a-f])[0-9a-f]+")
_HEX_UPPER = re.compile(r"(?=.*[0-9])(?=.*[A-F])[0-9A-F]+")
_UNDO_SUBSTITUTIONS = str.maketrans(
    {"0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t"}
)


@cache
def _words_by_length() -> dict[int, frozenset[str]]:
    by_length: dict[int, set[str]] = {}
    for word in common_base_words():
        if len(word) >= MIN_PATTERN_LENGTH and word.isascii():
            by_length.setdefault(len(word), set()).add(word)
    return {length: frozenset(words) for length, words in sorted(by_length.items(), reverse=True)}


@cache
def _keyboard_stretches() -> frozenset[str]:
    """Every stretch of `MIN_PATTERN_LENGTH` keys of a keyboard row, in both directions."""
    stretches: set[str] = set()
    for row in _KEYBOARD_ROWS:
        for keys in (row, row[::-1]):
            last = len(keys) - MIN_PATTERN_LENGTH
            stretches.update(keys[start : start + MIN_PATTERN_LENGTH] for start in range(last + 1))
    return frozenset(stretches)


def _word_lengths_at(text: str, start: int) -> list[int]:
    lengths = []
    for length, words in _words_by_length().items():
        chunk = text[start : start + length]
        if len(chunk) == length and (chunk in words or chunk.translate(_UNDO_SUBSTITUTIONS) in words):
            lengths.append(length)
    return lengths


def _run_at(text: str, start: int) -> int:
    """The length of the run at `start`: equal, ascending or descending characters, or keyboard keys."""
    best = 0
    if start + 1 < len(text):
        step = ord(text[start + 1]) - ord(text[start])
        if step in (-1, 0, 1):
            end = start + 1
            while end + 1 < len(text) and ord(text[end + 1]) - ord(text[end]) == step:
                end += 1
            best = end - start + 1
    stretches = _keyboard_stretches()
    end = start
    while text[end : end + MIN_PATTERN_LENGTH] in stretches:
        end += 1  # every window of a longer stretch is a stretch too
    if end > start:
        best = max(best, end - start + MIN_PATTERN_LENGTH - 1)
    return best


def _repeat_at(text: str, start: int) -> int:
    """The length of the longest part starting at `start` that also starts somewhere before `start`."""
    length = 0
    while start + length < len(text) and text.find(text[start : start + length + 1], 0, start + length) >= 0:
        length += 1
    return length


def _patterns_at(secret: str, text: str, start: int, *, hexadecimal: bool) -> list[tuple[int, float]]:
    """Every pattern starting at `start`: its length and the bits it counts."""
    found: list[tuple[int, float]] = []
    for longest, bits in ((_run_at(text, start), RUN_BITS), (_repeat_at(text, start), REPEAT_BITS)):
        found += [(length, bits) for length in range(MIN_PATTERN_LENGTH, longest + 1)]
    if hexadecimal:
        return found
    found += [(length, WORD_BITS) for length in _word_lengths_at(text, start)]
    if _YEAR.match(text, start):
        found.append((MIN_PATTERN_LENGTH, YEAR_BITS))
    if shaped := _WORD_SHAPED.match(secret, start):
        capital = 1.0 if secret[start].isupper() else 0.0
        found.append((shaped.end() - start, capital + WORD_SHAPED_LETTER_BITS * (shaped.end() - start)))
    return found


def _character_bits(character: str, *, hexadecimal: bool) -> float:
    if hexadecimal:
        return 4.0
    if character.isascii() and character.isalpha():
        return math.log2(52)
    if character.isascii() and character.isdigit():
        return math.log2(10)
    if character in _SEPARATORS:
        return 2.0
    if character.isascii() and character.isprintable():
        return math.log2(33)
    return math.log2(95)


def estimated_bits(secret: str) -> float:
    """A conservative estimate of the bits a guesser must search to find `secret` (see the module)."""
    secret = secret[:MAX_EXAMINED_LENGTH]
    # Lowercase character by character (keeps every position; `str.lower` can change the length).
    text = "".join(lower if len(lower := character.lower()) == 1 else character for character in secret)
    hexadecimal = bool(_HEX_LOWER.fullmatch(secret) or _HEX_UPPER.fullmatch(secret))
    # The cheapest way to build the key from patterns and single characters (dynamic programming from
    # the end): `cheapest[i]` is the estimate for `secret[i:]`.
    cheapest = [0.0] * (len(text) + 1)
    for position in range(len(text) - 1, -1, -1):
        options = [_character_bits(secret[position], hexadecimal=hexadecimal) + cheapest[position + 1]]
        options += [
            bits + cheapest[position + length]
            for length, bits in _patterns_at(secret, text, position, hexadecimal=hexadecimal)
        ]
        cheapest[position] = min(options)
    return cheapest[0]


def is_strong_secret(secret: str) -> bool:
    return estimated_bits(secret) >= MIN_SECRET_BITS
