"""Whose e-mail a message is: the identity its header, colours, sender and footer present (Phase 12, B12-12).

There are two.

* A **company's** e-mails show that company and nothing else: its logo inline, or its name as a word
  mark when it has none; its colours, taken from the palette of its colour (`app.core.palette`), or the
  product's teal while it has none; its name as the sender's display name and in the footer. No
  sentence, header, alternative text or colour of such an e-mail names the product or shows the Mawdoo3
  logo. That is every e-mail a company's people and visitors receive: every visit e-mail, the password
  reset and the password notice of its users, the previews and test e-mails of its texts, and the
  notice to its administrators of what the platform owner did (B12-22).
* The **product's** own identity stays on one message, which no company's people receive: the test
  e-mail of `python -m app.cli send-test-email`.

`EmailColors` are the colours the templates take their brand colours from (`macros.html`); everything
else in an e-mail (ink, body and muted text, lines, the yellow of a change to notice) is the same for
everyone. With the palette's guarantees every pair the templates use reads
(tests/unit/test_email_identity.py): `on_surface` on `surface` (the primary button), `link` on white and
on `tint` (the pill, the word mark, the outline button), `on_accent` on `accent` (the pass button),
`accent` and white on `card` (the pass card), and the body and muted text on `tint` (a notice).

A company's surfaces are its own colour (B12-21): the bar of the header and the primary button are the
palette's `surface`, which is the colour as the platform owner chose it wherever white or the dark ink
reads on it, with `on_surface` as the button's text. A yellow company's button is yellow with dark text.
What is written on white in the brand's colour (links, the pill, the word mark, an outline button) stays
`strong`, the step of the colour that reads there; so does the edge of every button, so that a white
company's button is still a button on the white card.

A company's logo is shown on a white header, which is what a logo "for light surfaces" is drawn for. Since
Phase 13 it is never sent as it was stored: `app.email.logos` draws an opaque rendition of it on a white
plate, and one of its logo for dark surfaces on the dark header (B13-2).

**The dark design** (Phase 13, B13-1). Every e-mail declares that it has a light and a dark design
(`color-scheme: light dark`); a client that honours `prefers-color-scheme` (Apple Mail, the Outlook apps)
shows the dark one, which the templates draw with `DarkColors`. Its neutrals are the web application's
dark ones (`frontend/src/index.css`, theme-dark), and its brand colours are derived from the company's
palette by the rules of the web application's dark set (`frontend/src/identity/tokens.ts`, `darkTokens`),
here in Python: a colour is moved towards white or black in steps of 4 % until it reads where it is
used (`_ensure`). A company without a colour gets the same derivation from the product's own colours.
Every pair the dark design draws reads (tests/unit/test_email_dark.py): text 4.5:1, the bar and the
edges of buttons 3:1.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass

from app.core.palette import WHITE, BrandPalette, contrast, to_hex, to_rgb
from app.email.providers.base import InlineImage
from app.models.enums import Language

# The largest a company's logo is shown in the header (CSS pixels); it keeps its proportions and is
# never enlarged. The pill stands beside it where there is room and under it on a phone (B12-23): a
# logo this wide and the longest pill are 335 pixels together, more than a phone's header has.
LOGO_BOX_WIDTH = 168
LOGO_BOX_HEIGHT = 44


@dataclass(frozen=True, slots=True)
class EmailColors:
    """The brand colours of an e-mail, as the templates write them (`#RRGGBB`)."""

    surface: str  # the bar or band of the header and the primary button: the company's own colour
    on_surface: str  # text on `surface`: white, or the dark ink on a light colour
    strong: str  # the edge of a button: it shows on white whatever the colour
    link: str  # text in the brand's colour on white and on `tint`: the pill, the word mark, links
    accent: str  # the light vivid step: the pass card's label and button, the steps' figures
    on_accent: str  # text on `accent`
    card: str  # the dark card of the visitor pass, and the squares of the steps
    card_line: str  # a line on the card
    tint: str  # the background of a notice and of the pill on a white header
    tint_edge: str  # the edge of a notice


# The product's own colours (mawdoo3.com's palette, B10-17): also every company's until the platform
# owner gives it a colour. `tests/unit/test_email_design.py` holds the contrast of each pair.
DEFAULT_COLORS = EmailColors(
    surface="#188086",
    on_surface="#FFFFFF",
    strong="#188086",
    link="#146E73",
    accent="#27B5BB",
    on_accent="#1E2A32",
    card="#1E2A32",
    card_line="#33444E",
    tint="#E5F6F7",
    tint_edge="#27B5BB",
)


def colors_of(palette: BrandPalette) -> EmailColors:
    """A company's e-mail colours, from the palette of its colour."""
    return EmailColors(
        surface=palette.surface.upper(),
        on_surface=palette.on_surface.upper(),
        strong=palette.strong.upper(),
        link=palette.strong.upper(),
        accent=palette.bright.upper(),
        on_accent=palette.on_bright.upper(),
        card=palette.deep.upper(),
        card_line=palette.strong.upper(),
        tint=palette.tint.upper(),
        tint_edge=palette.tint_border.upper(),
    )


def fitted(
    width: int, height: int, *, box_width: int = LOGO_BOX_WIDTH, box_height: int = LOGO_BOX_HEIGHT
) -> tuple[int, int]:
    """The size an image of `width` x `height` pixels is shown at inside the box: its proportions kept,
    never enlarged, at least one pixel each way."""
    scale = min(box_width / width, box_height / height, 1.0)
    return max(1, round(width * scale)), max(1, round(height * scale))


# ---- the dark design (Phase 13, B13-1) ----------------------------------------------------------------

BLACK = "#000000"
# The neutrals of the web application's dark scheme (index.css, theme-dark; tokens.ts NEUTRALS.dark).
DARK_CANVAS = "#101619"  # around the card
DARK_SURFACE = "#182126"  # the card and its header (app.email.logos.DARK_HEADER)
DARK_SURFACE_MUTED = "#1f2a30"  # (and surface-raised) where the web application's brand colours must read
DARK_SUNKEN = "#12191c"  # the footer
DARK_TAB_TRACK = "#1c272d"
DARK_LINE = "#2a373e"  # the card's edge, dividers, the details grid's frame
DARK_RULE = "#222d33"  # the lines between the grid's cells
DARK_INK = "#eef2f4"  # headings, values, strong text
DARK_BODY = "#c3ced5"  # running text
DARK_MUTED = "#99a9b2"  # labels, small print, the footer
# What no longer holds (a cancelled visit, a password change): the web application's dark warning.
DARK_ATTENTION_SURFACE = "#2d2408"
DARK_ATTENTION_EDGE = "#f7b916"
# WCAG 2.2 AA: text 4.5:1; the bar, a button's edge and other marks 3:1 (as tokens.ts TEXT and UI).
TEXT_CONTRAST = 4.5
UI_CONTRAST = 3.0
_STEPS = 25  # tokens.ts STEPS: a colour is moved in steps of 1/25


def _mix(color: str, target: str, amount: float) -> str:
    """`amount` of `target` mixed into `color`, per channel (colour.ts `mix`, rounded as JavaScript's
    `Math.round` rounds: half up)."""
    share = min(1.0, max(0.0, amount))
    channels = (
        math.floor(min(255.0, max(0.0, start + (end - start) * share)) + 0.5)
        for start, end in zip(to_rgb(color), to_rgb(target), strict=True)
    )
    red, green, blue = channels
    return to_hex((red, green, blue))


def _ensure(color: str, passes: Callable[[str], bool], toward: str) -> str:
    """`color` when it passes; else the first of its steps towards `toward` that does (tokens.ts)."""
    if passes(color):
        return color
    for step in range(1, _STEPS):
        candidate = _mix(color, toward, step / _STEPS)
        if passes(candidate):
            return candidate
    return toward


def _reads_on(backgrounds: tuple[str, ...], minimum: float) -> Callable[[str], bool]:
    return lambda candidate: all(contrast(candidate, background) >= minimum for background in backgrounds)


def _reads_under(*texts: str) -> Callable[[str], bool]:
    """A background on which every one of `texts` reads (tokens.ts `readsOnBoth`)."""
    return lambda background: all(contrast(text, background) >= TEXT_CONTRAST for text in texts)


@dataclass(frozen=True, slots=True)
class DarkColors:
    """The colours of an e-mail's dark design, as the templates write them (`#RRGGBB`). The neutrals are
    the same for everyone; the brand's are derived from a palette (`dark_colors_of`)."""

    accent: str  # the bar, the primary button and its edge, an outline button's edge, the steps' squares
    on_accent: str  # text on `accent`
    accent_text: str  # brand-coloured text: the pill, the word mark, links, an outline button
    accent_surface: str  # the pill and an information notice
    accent_border: str  # the edge of the pass card
    canvas: str  # the neutrals: the same for everyone (DARK_*)
    surface: str
    sunken: str
    line: str
    rule: str
    ink: str
    body: str
    muted: str
    attention_surface: str
    attention_edge: str


def dark_colors(deep: str, bright: str, on_bright: str) -> DarkColors:
    """The dark design from three roles of a palette: its brand colours as tokens.ts `darkTokens` derives
    the web application's `accent-surface`, `accent`, `accent-text`, `on-accent` and `accent-border`."""
    surfaces = (DARK_SURFACE, DARK_CANVAS, DARK_SURFACE_MUTED, DARK_SURFACE_MUTED, DARK_TAB_TRACK)
    deep_surface = _ensure(deep, _reads_under(DARK_INK, DARK_MUTED), BLACK)
    accent = _ensure(bright, _reads_on(surfaces, UI_CONTRAST), WHITE)
    row_highlight = _ensure(_mix(deep_surface, DARK_SURFACE, 0.5), _reads_under(DARK_INK, DARK_MUTED), BLACK)
    text = _ensure(accent, _reads_on((*surfaces[:4], deep_surface, row_highlight), TEXT_CONTRAST), WHITE)
    return DarkColors(
        accent=accent.upper(),
        on_accent=on_bright.upper(),
        accent_text=text.upper(),
        accent_surface=deep_surface.upper(),
        accent_border=_mix(accent, deep_surface, 0.6).upper(),
        canvas=DARK_CANVAS.upper(),
        surface=DARK_SURFACE.upper(),
        sunken=DARK_SUNKEN.upper(),
        line=DARK_LINE.upper(),
        rule=DARK_RULE.upper(),
        ink=DARK_INK.upper(),
        body=DARK_BODY.upper(),
        muted=DARK_MUTED.upper(),
        attention_surface=DARK_ATTENTION_SURFACE.upper(),
        attention_edge=DARK_ATTENTION_EDGE.upper(),
    )


def dark_colors_of(palette: BrandPalette | None) -> DarkColors:
    """A company's dark design: from the palette of its colour, or from the product's own colours (the
    light design's `DEFAULT_COLORS`: its card, accent and the ink on it) while it has none."""
    if palette is None:
        return DEFAULT_DARK_COLORS
    return dark_colors(palette.deep, palette.bright, palette.on_bright)


DEFAULT_DARK_COLORS = dark_colors(
    DEFAULT_COLORS.card.lower(), DEFAULT_COLORS.accent.lower(), DEFAULT_COLORS.on_accent.lower()
)


@dataclass(frozen=True, slots=True)
class Identity:
    """What an e-mail shows of its sender."""

    product: bool  # the product's own identity (the CLI's test e-mail); otherwise a company's
    # The sender's name per language: the logo's text alternative, and a company's word mark.
    names: dict[Language, str]
    # The first line of the plain-text part, per leading language.
    masthead: dict[Language, str]
    colors: EmailColors
    logo: InlineImage | None = None
    logo_width: int = 0  # as shown, in CSS pixels (the plate included)
    logo_height: int = 0
    # The logo is an emblem: the header writes the company's name beside it (B13-12).
    logo_mark: bool = False
    # Phase 13 (B13-1, B13-2). The dark design's colours.
    dark: DarkColors = DEFAULT_DARK_COLORS
    # CSS pixels of plate baked around the logo on every side (`app.email.logos.PLATE`); 0 for a logo
    # sent without one (the product's, which is baked onto its teal band; a company's that could not be
    # drawn).
    plate: int = 0
    # The rendition of the company's logo for dark surfaces, shown by the dark design only.
    logo_dark: InlineImage | None = None
    logo_dark_width: int = 0
    logo_dark_height: int = 0
    logo_dark_mark: bool = False  # a mark: the dark header writes the company's name beside it

    @property
    def images(self) -> tuple[InlineImage, ...]:
        """The inline images every message of this identity carries."""
        return tuple(image for image in (self.logo, self.logo_dark) if image is not None)
