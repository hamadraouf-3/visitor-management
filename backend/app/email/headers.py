"""Header safety: no header value can be read as two lines (contract §9, S10-5), and a Subject is what
every provider sends, whatever went into it (B11-40, B11-41).

A Subject is built from catalog text, a company's own text and values that people typed (company and
visitor names). `subject_line` finishes every one of them, in the renderer, so that the SMTP provider,
Resend, the development outbox, the e-mail log and the preview all carry the same text:

* one line (`sanitize_header`), with the no-break spaces and word joiners that keep a date or a time range
  together in a body turned back into what a header is searched by;
* no explicit direction controls (embeddings, overrides, isolates): in a header nothing closes them, so
  one typed into a value would reorder the rest of the Subject, the other language's half included;
* no RFC 2047 encoded word (`literal_text`): text typed as `=?utf-8?q?…?=` would otherwise reach a mail
  client as other text than the administrator saw, through every provider that passes a Subject on as it
  is;
* at most `SUBJECT_MAX_LENGTH` characters (`shorten`): a value can be far longer than the text around it.

A company's e-mails are sent in the company's name (Phase 12, B12-13): `sender_named` gives the
configured sender address another display name. The name is a company's, which its administrators can
change, so it is finished like a subject and then made unable to be anything but a name: no quote,
backslash or angle bracket (what delimits a name and an address), no "@" (a name must not read as another
address), bounded. Each of those five is refused in every form that Unicode treats as the same character
for compatibility (B12-20): a name with U+FF20 FULLWIDTH COMMERCIAL AT between "support" and
"bank.example" reads as an address as much as one with "@" does. The address is never taken from
anything but the configuration.

What this does not do: it does not judge what a name says. A company named "Bank Support" sends e-mail
under that name, from the deployment's address. And a character that merely resembles one of the five,
without being a compatibility form of it, is a letter like any other.
"""

import re
from email.utils import parseaddr
from unicodedata import category, normalize

# Control characters (C0, DEL, C1 with NEL) and the Unicode line and paragraph separators: everything
# `str.splitlines()` breaks a line at, so no header value can be read as two lines.
_HEADER_UNSAFE = re.compile(r"[\x00-\x1f\x7f-\x9f\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]+")
# Explicit embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069).
_DIRECTION_CONTROLS = re.compile(
    "[\N{LEFT-TO-RIGHT EMBEDDING}-\N{RIGHT-TO-LEFT OVERRIDE}"
    "\N{LEFT-TO-RIGHT ISOLATE}-\N{POP DIRECTIONAL ISOLATE}]"
)
_NBSP = "\N{NO-BREAK SPACE}"
_WORD_JOINER = "\N{WORD JOINER}"
_ZWJ = "\N{ZERO WIDTH JOINER}"
ELLIPSIS = "\N{HORIZONTAL ELLIPSIS}"
# The longest Subject sent (and stored: `email_messages.subject` holds 300 characters). Mail clients show
# far less; a long company name still fits with the date after it.
SUBJECT_MAX_LENGTH = 250


# The longest display name of a sender. Mail clients show far less.
SENDER_NAME_MAX_LENGTH = 100
# What delimits a display name and an address in a mailbox (`"name" <address>`: the quote, the backslash
# that escapes inside it, the angle brackets), and the "@" that would make a name read as an address of
# its own.
_NOT_IN_A_NAME = frozenset('<>"@\\')
_SPACES = re.compile(r"\s+")


def sanitize_header(value: str) -> str:
    """Header values never carry CR/LF, other line breaks or control characters (no header injection)."""
    return _HEADER_UNSAFE.sub(" ", value).strip()


def literal_text(text: str) -> str:
    """Header text that reaches a mail client as written. An RFC 2047 encoded word in it
    (`=?utf-8?q?Acme=0D=0ABcc:...?=`) would be decoded on the way, by Python's `email` package or by the
    recipient's client, into other text, line breaks included; a space after each `=?` that would open one
    keeps it literal (S10-13)."""
    return text.replace("=?", "= ?")


def _belongs_to_previous(character: str) -> bool:
    """Whether `character` is part of the one before it on screen: a combining mark, a variation selector,
    a joiner, an emoji modifier or a tag, or the second half of a surrogate pair."""
    return (
        category(character) in {"Mn", "Mc", "Me"}
        or character == _ZWJ
        or "\N{EMOJI MODIFIER FITZPATRICK TYPE-1-2}" <= character <= "\N{EMOJI MODIFIER FITZPATRICK TYPE-6}"
        or "\N{TAG SPACE}" <= character <= "\N{CANCEL TAG}"
        or "\udc00" <= character <= "\udfff"
    )


def _takes_the_next(character: str) -> bool:
    """Whether what follows `character` belongs to it: a joiner, or the first half of a surrogate pair."""
    return character == _ZWJ or "\ud800" <= character <= "\udbff"


def _is_regional_indicator(character: str) -> bool:
    return "\N{REGIONAL INDICATOR SYMBOL LETTER A}" <= character <= "\N{REGIONAL INDICATOR SYMBOL LETTER Z}"


def cut_short(text: str, limit: int) -> str:
    """The start of `text` in at most `limit` characters, the last of them an ellipsis: for a text that is
    known to go on (`shorten` leaves a text that fits as it is).

    The cut never falls inside what a reader sees as one character: not before a combining mark (Arabic
    vowel signs), a variation selector or an emoji modifier, not inside an emoji joined by ZWJ or a flag
    (two regional indicators), and not between the halves of a surrogate pair."""
    if limit < 1:
        raise ValueError("a text is shortened to at least one character")
    cut = min(limit - 1, len(text))  # room for the ellipsis
    while 0 < cut < len(text) and (_belongs_to_previous(text[cut]) or _takes_the_next(text[cut - 1])):
        cut -= 1
    if 0 < cut < len(text) and _is_regional_indicator(text[cut]):
        before = 0
        while before < cut and _is_regional_indicator(text[cut - before - 1]):
            before += 1
        cut -= before % 2  # an odd number before the cut: it would split a pair
    return text[:cut].rstrip() + ELLIPSIS


def shorten(text: str, limit: int) -> str:
    """`text` in at most `limit` characters, ending with an ellipsis when something was cut (`cut_short`)."""
    if limit < 1:
        raise ValueError("a text is shortened to at least one character")
    return text if len(text) <= limit else cut_short(text, limit)


def _reads_as_a_delimiter(character: str) -> bool:
    """Whether `character` is one of the five a name may not hold, as typed or in a compatibility form:
    the fullwidth and small variants (U+FF20 and U+FE6B of "@", U+FF1C and U+FE64 of "<", ...), which a
    reader takes for the character itself and which software that normalises text (NFKC) turns into it.

    Judging one character at a time misses nothing that normalising the whole name would find:
    normalisation decomposes each character on its own, and composing never produces one of the five
    (tests/unit/test_email_identity.py goes through every code point)."""
    if character.isascii():
        return character in _NOT_IN_A_NAME
    return not _NOT_IN_A_NAME.isdisjoint(normalize("NFKC", character))


def display_name(name: str) -> str:
    """`name` as a sender's display name: one line, no direction controls, no encoded word, none of the
    characters that delimit a mailbox in any compatibility form (`_reads_as_a_delimiter`), at most
    `SENDER_NAME_MAX_LENGTH` characters. Every other character stays as it was typed, so the sender's
    name is the name the e-mail itself shows. May be empty. Applying it twice changes nothing."""
    kept = "".join(" " if _reads_as_a_delimiter(character) else character for character in name)
    text = subject_line(kept, limit=SENDER_NAME_MAX_LENGTH)
    return _SPACES.sub(" ", text).strip()


def sender_named(sender: str, name: str) -> str:
    """The mailbox `sender` (EMAIL_FROM: `Name <address>` or a bare address) under another display name:
    `"name" <address>`, the form every provider is given. The address is `sender`'s own, always. A name
    that shows nothing leaves the bare address; a `sender` without an address is returned as it is (the
    provider refuses it, as before)."""
    mailbox = sanitize_header(sender)
    address = parseaddr(mailbox)[1]
    if "@" not in address:
        return mailbox
    shown = display_name(name)
    return f'"{shown}" <{address}>' if shown else address


def subject_line(value: str, *, limit: int = SUBJECT_MAX_LENGTH) -> str:
    """A Subject as it is sent, stored and shown (see the module): one line, without direction controls
    or an encoded word, in at most `limit` characters. Applying it twice changes nothing."""
    text = sanitize_header(value.replace(_NBSP, " ").replace(_WORD_JOINER, ""))
    text = _DIRECTION_CONTROLS.sub("", text).strip()
    return shorten(literal_text(text), limit)
