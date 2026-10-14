"""Values that keep their own direction inside a sentence of the other direction (Phase 10, B10-14).

A name, a company, a purpose or a network address is inserted into Arabic and English sentences alike.
Without isolation the Unicode bidirectional algorithm mixes it with the sentence around it: in an Arabic
sentence the full stop of "Quarterly budget review." or of "John Smith Jr." moves to the wrong end, and
the IPv6 address 2001:db8::7334 is shown as db8::7334:2001, a different address. An isolated value is laid
out on its own and then placed in the sentence as one unit, so neither changes the order of the other.

- HTML: the value is wrapped in `<span dir="ltr|rtl">`. Every engine isolates an element that has a `dir`
  attribute, and the direction is computed here (the first strong character, as `dir="auto"` and FSI
  would), so clients that know no `auto` and no isolate characters still get it right.
- Plain text: each line of the value is wrapped in FSI (or LRI for a value that is always left to right)
  and PDI, the only isolation plain text has.

A right-to-left section isolates every value: there, even a value of Latin letters and digits alone is
reordered. A left-to-right section isolates only a value that contains a right-to-left character or an
explicit direction control: without one, every character of a left-to-right sentence resolves to the
same level, so nothing can move (and the English text the E2E suite reads stays exactly as it was).
Subjects are never isolated: they are headers, built with `translate`.
"""

from typing import Literal
from unicodedata import bidirectional

from markupsafe import Markup, escape

Direction = Literal["ltr", "rtl"]

FSI = "\N{FIRST STRONG ISOLATE}"
LRI = "\N{LEFT-TO-RIGHT ISOLATE}"
RLI = "\N{RIGHT-TO-LEFT ISOLATE}"
PDI = "\N{POP DIRECTIONAL ISOLATE}"
ISOLATE_CHARACTERS = frozenset((FSI, LRI, RLI, PDI))

# Bidirectional classes that make text right to left, or change the order of what follows them.
_RIGHT_TO_LEFT_OR_EXPLICIT = frozenset(
    {"R", "AL", "AN", "LRE", "RLE", "LRO", "RLO", "PDF", "LRI", "RLI", "FSI", "PDI"}
)
_ISOLATE_INITIATORS = frozenset({"LRI", "RLI", "FSI"})


def direction_of(text: str) -> Direction:
    """The direction of `text` by its first strong character, skipping isolated runs (UAX #9, P2 and P3):
    `rtl` for Arabic or Hebrew, else `ltr` (also for text without a strong character)."""
    depth = 0
    for character in text:
        kind = bidirectional(character)
        if kind in _ISOLATE_INITIATORS:
            depth += 1
        elif kind == "PDI":
            depth = max(depth - 1, 0)
        elif depth == 0 and kind == "L":
            return "ltr"
        elif depth == 0 and kind in ("R", "AL"):
            return "rtl"
    return "ltr"


def needs_isolation(value: str, context: Direction) -> bool:
    """Whether `value` must be isolated inside a sentence of direction `context` (see the module)."""
    if not value:
        return False
    if context == "rtl":
        return True
    return any(bidirectional(character) in _RIGHT_TO_LEFT_OR_EXPLICIT for character in value)


def isolate_text(value: str, context: Direction, direction: Direction | None = None) -> str:
    """`value` for plain text: each line between FSI (LRI when `direction` is `ltr`, RLI when `rtl`) and
    PDI. A line break ends every isolate (UAX #9, X8), so a multi-line value is isolated line by line."""
    if not needs_isolation(value, context):
        return value
    opener = {None: FSI, "ltr": LRI, "rtl": RLI}[direction]
    lines = []
    for line in value.splitlines(keepends=True):
        content = line.splitlines()[0]  # without the line break `splitlines` kept
        ending = line[len(content) :]
        lines.append(f"{opener}{content}{PDI}{ending}" if content else line)
    return "".join(lines)


def isolate_html(value: str, context: Direction, direction: Direction | None = None) -> Markup:
    """`value` for HTML, escaped: in `<span dir="...">` when it needs isolation, with `direction` or else
    the value's own (`direction_of`)."""
    if not needs_isolation(value, context):
        return escape(value)
    return Markup('<span dir="{}">{}</span>').format(direction or direction_of(value), value)
