"""A company's colour and the accessible palette derived from it (Phase 12, B12-4).

The platform owner chooses one colour per company (`#rrggbb`). Nobody chooses shades: this module derives
them, so that text stays readable whatever was chosen: a grey, black, white, yellow or a neon colour. It is
the only implementation. The web application receives the palette with the brand (`CompanyBrand.palette`)
and the e-mails are coloured with the same one (`app.email.identity`).

The roles and what each guarantees (WCAG 2.x contrast ratios, measured on the 8-bit colours that are
returned, for every input: `tests/unit/test_palette.py` walks a grid of the whole RGB cube):

    strong        text, links and icons on white, and a surface under white text.
                  contrast(white, strong) >= 4.5. The colour itself when it already passes; otherwise the
                  same hue, darkened as little as the palette needs (see "The tint" below).
    strong_hover  the hover and pressed step of `strong`: darker, or lighter when `strong` is too dark to
                  darken visibly. contrast(white, strong_hover) >= 4.5, and it is at least
                  HOVER_MIN_DIFFERENCE of OKLCH lightness away from `strong`.
    surface       what the brand's surfaces are painted with: the application's shell, primary buttons,
                  the bar and the button of an e-mail. The chosen colour ITSELF whenever white or the
                  dark ink reads on it (4.5:1); otherwise `strong` (see "The surface" below).
    on_surface    the ink of text and icons on `surface` and on `surface_hover`: white where white reads
                  on `surface`, otherwise the dark ink. contrast(on_surface, surface) >= 4.5.
    surface_hover the hover and pressed step of `surface`. contrast(on_surface, surface_hover) >= 4.5,
                  and it is at least HOVER_MIN_DIFFERENCE of OKLCH lightness away from `surface`.
    deep          a very dark step of the hue, for dark surfaces. contrast(white, deep) >= 10.
    bright        a light, vivid step: accents on dark surfaces, fills under dark text.
                  contrast(on_bright, bright) >= 4.5 and contrast(bright, deep) >= 4.5.
    tint          a near-white tint for chips, selected rows and notices.
                  contrast(strong, tint) >= 4.5, and the product's own text colours read on it.
    tint_border   the edge of tinted elements, between `tint` and `strong` (decorative).
    on_strong     white.
    on_bright     the product's dark ink.

How. Colours are moved in OKLCH (Björn Ottosson's OKLab in polar form): lightness can change there while
the hue a person sees stays, which is not true of HSL (a yellow darkened in HSL turns green). A target is
a lightness and a chroma at the colour's own hue; chroma is reduced until the colour exists in sRGB, the
result is rounded to 8 bits, and then the guarantee is measured on those 8 bits. While it does not hold,
the lightness moves towards black or white, where every such test passes, so every search ends. A colour
with almost no chroma has no hue worth keeping and is treated as a grey: a grey brand stays grey in every
role.

The tint. `strong` text must read on `tint` (4.5:1). A colour that only just carries white text (4.5:1)
leaves no room between itself and white: the only "tint" it reads on is white, which tints nothing. So a
colour that has to be darkened is darkened to 5:1 against white rather than to 4.5:1: slightly darker
than white text alone would need, and what a visible tint needs. A colour that passes as it is stays as
it is, as the platform owner chose it, and its tint is as strong as that colour allows.

The surface. A company's colour is the colour of its logo, and its people expect to see that colour, not
a neighbour of it: a yellow company is yellow. White text does not read on yellow, which is why `strong`
is an olive there; but dark text does. So a surface is painted with the colour as it was chosen, under
whichever ink reads on it: white on a dark colour (there `surface` is `strong` and `on_surface` is
`on_strong`), the dark ink on a light one (a yellow, a pastel, a neon colour, white). Only the mid-tones
between, on which neither ink reaches 4.5:1 (a mid grey, a pure red: a relative luminance between 0.18
and 0.26), cannot be used as they are: there the surface is `strong`, the same hue just dark enough for
white. `strong` keeps its meaning: it is the colour of text, links and icons on white, where the yellow
itself could not be read.

The hover step. A surface shows that the pointer is on it by a step of lightness that can be seen:
HOVER_MIN_DIFFERENCE (0.06 of OKLCH lightness, three times what is taken as just noticeable), measured
like every guarantee on the 8-bit colours returned. The step goes darker, by 0.07, wherever its ink
still reads on the darker colour. It goes lighter where that is not so: for a colour too dark to darken
visibly (black, a very dark navy; by 0.16, to a lightness of at least 0.28), and for a light surface
that is only just light enough for the dark ink (by 0.07). `strong_hover` and `surface_hover` are the
same step, so where the surface is `strong` they are the same colour.

The arithmetic is plain floating point on 8-bit inputs, and every result is rounded to 8 bits, so the
same colour gives the same palette on every machine. `ALGORITHM` names this derivation: it is part of a
brand's version, so a change here reaches every cached copy of a palette.
"""

import math
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from functools import lru_cache

# Part of every brand's version (`services.brand.brand_version`): change it with the derivation.
ALGORITHM = "oklch-2"

_COLOR = re.compile(r"#[0-9a-f]{6}")
WHITE = "#ffffff"
BLACK = "#000000"
# The product's dark ink (the web application's `--color-ink`, the text colour of the light theme).
INK = "#1c262b"

TEXT_CONTRAST = 4.5  # WCAG 2.x AA for text
DARKENED_CONTRAST = 5.0  # white on a `strong` that had to be darkened (see "The tint" in the module)
DEEP_CONTRAST = 10.0  # white on `deep`
# The tint is a near-white surface that the product's own text sits on as well: its secondary and muted
# text colours (the web application's and the e-mails') need 4.5:1 on it, which this luminance gives.
TINT_MIN_LUMINANCE = 0.80

# The least a hover step differs from its surface, in OKLCH lightness (0 for black, 1 for white): three
# times the 0.02 that is taken as just noticeable. The step aims at `_HOVER_DARKER`; rounding to 8 bits
# leaves a little less.
HOVER_MIN_DIFFERENCE = 0.06

# Below this chroma a colour is a grey: its hue is noise (and undefined for black and white).
_GREY_CHROMA = 0.02
_STEP = 0.002  # of OKLCH lightness, between two tries
# Targets: an OKLCH lightness, and the most chroma the role keeps.
_HOVER_DARKER = 0.07
_HOVER_LIGHTER = 0.16  # a surface below `_HOVER_FLOOR` lightens on hover instead, to at least `_HOVER_MIN`
_HOVER_FLOOR, _HOVER_MIN = 0.25, 0.28
_HOVER_TRIES = 8  # steps of `_STEP` past the usual one, where rounding left less than the least difference
_DEEP_LIGHTNESS, _DEEP_CHROMA = 0.33, 0.07
_BRIGHT_LIGHTNESS, _BRIGHT_CHROMA = 0.80, 0.16
# A colour that is itself light and vivid is its own bright step (a neon green, a yellow): at least this
# light, and either vivid or not so light that it is nearly white.
_BRIGHT_OWN_LIGHTNESS, _BRIGHT_OWN_CHROMA, _BRIGHT_OWN_CEILING = 0.72, 0.06, 0.90
_TINT_LIGHTNESS, _TINT_CHROMA = 0.96, 0.022
_BORDER_LIGHTNESS, _BORDER_CHROMA = 0.86, 0.06

type RGB = tuple[int, int, int]
type Check = Callable[[str], bool]


def is_color(value: object) -> bool:
    """Whether `value` is a colour as the API spells it: `#rrggbb`, lower case, nothing else."""
    return isinstance(value, str) and _COLOR.fullmatch(value) is not None


def to_rgb(color: str) -> RGB:
    if not is_color(color):
        raise ValueError("a colour is written #rrggbb in lower case")
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def to_hex(rgb: RGB) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def _linear(channel: int) -> float:
    value = channel / 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def _encoded(value: float) -> int:
    value = min(max(value, 0.0), 1.0)
    encoded = 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
    return min(max(round(encoded * 255), 0), 255)


def luminance(color: str) -> float:
    """The relative luminance of WCAG 2.x (0 for black, 1 for white)."""
    red, green, blue = (_linear(channel) for channel in to_rgb(color))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(first: str, second: str) -> float:
    """The contrast ratio of WCAG 2.x between two colours (1 to 21), whichever is the lighter."""
    lighter, darker = sorted((luminance(first), luminance(second)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def oklch(color: str) -> tuple[float, float, float]:
    """Lightness (0 to 1), chroma and hue (radians) of a colour."""
    red, green, blue = (_linear(channel) for channel in to_rgb(color))
    long = math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
    medium = math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
    short = math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
    lightness = 0.2104542553 * long + 0.7936177850 * medium - 0.0040720468 * short
    a = 1.9779984951 * long - 2.4285922050 * medium + 0.4505937099 * short
    b = 0.0259040371 * long + 0.7827717662 * medium - 0.8086757660 * short
    return lightness, math.hypot(a, b), math.atan2(b, a)


def _linear_rgb(lightness: float, chroma: float, hue: float) -> tuple[float, float, float]:
    a, b = chroma * math.cos(hue), chroma * math.sin(hue)
    long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    short = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
        -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
        -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short,
    )


def _displayable(lightness: float, chroma: float, hue: float) -> bool:
    return all(-0.0005 <= value <= 1.0005 for value in _linear_rgb(lightness, chroma, hue))


def _color(lightness: float, chroma: float, hue: float) -> str:
    """The sRGB colour of that lightness and hue with at most that chroma: the chroma is reduced until
    the colour can be displayed (a very light or a very dark colour holds little)."""
    lightness = min(max(lightness, 0.0), 1.0)
    if chroma and not _displayable(lightness, chroma, hue):
        low, high = 0.0, chroma
        for _ in range(16):
            middle = (low + high) / 2
            if _displayable(lightness, middle, hue):
                low = middle
            else:
                high = middle
        chroma = low
    red, green, blue = _linear_rgb(lightness, chroma, hue)
    return to_hex((_encoded(red), _encoded(green), _encoded(blue)))


def _nearest(start: float, end: float, chroma: float, hue: float, passes: Check) -> str:
    """The colour that `passes` whose lightness is nearest to `start`, going towards `end` (0: darker,
    1: lighter). Black passes every test asked of a darker colour here and white every test asked of a
    lighter one, so there is always an answer."""
    candidate = _color(start, chroma, hue)
    if passes(candidate):
        return candidate
    failing, passing = start, end
    for _ in range(12):  # to within 1/4096 of the way
        middle = (failing + passing) / 2
        if passes(_color(middle, chroma, hue)):
            passing = middle
        else:
            failing = middle
    # Where rounding to 8 bits makes the test uneven just there, go on towards `end` in small steps.
    step = _STEP if end > start else -_STEP
    lightness = passing
    while 0.0 < lightness < 1.0:
        candidate = _color(lightness, chroma, hue)
        if passes(candidate):
            return candidate
        lightness += step
    return WHITE if end > start else BLACK


def _reads_on(*pairs: tuple[str, float], luminance_floor: float = 0.0) -> Check:
    """A test: the candidate has each contrast with the given colours, and at least that luminance."""

    def passes(candidate: str) -> bool:
        return luminance(candidate) >= luminance_floor and all(
            contrast(other, candidate) >= floor for other, floor in pairs
        )

    return passes


def lightness_difference(first: str, second: str) -> float:
    """How far apart two colours are in OKLCH lightness (0 to 1): what a hover step is measured by."""
    return abs(oklch(first)[0] - oklch(second)[0])


def _hover(surface: str, ink: str, chroma: float, hue: float) -> str:
    """The hover and pressed step of `surface`, which carries text in `ink`: a colour of the same hue
    that `ink` reads on as well and that is at least HOVER_MIN_DIFFERENCE of lightness away. Darker
    where that can be seen and the ink allows it, otherwise lighter (see "The hover step" in the module).
    """
    lightness = oklch(surface)[0]

    def passes(candidate: str) -> bool:
        return (
            lightness_difference(candidate, surface) >= HOVER_MIN_DIFFERENCE
            and contrast(ink, candidate) >= TEXT_CONTRAST
        )

    if lightness < _HOVER_FLOOR:
        # Black, or nearly: there is nothing darker to see, so the step goes the other way. So dark a
        # colour stays far below what white text needs.
        return _nearest(max(lightness + _HOVER_LIGHTER, _HOVER_MIN), 1.0, chroma, hue, passes)
    for extra in range(_HOVER_TRIES):
        candidate = _color(lightness - _HOVER_DARKER - extra * _STEP, chroma, hue)
        if passes(candidate):
            return candidate
    if contrast(ink, BLACK) >= TEXT_CONTRAST:
        # A light ink reads on every darker colour: the nearest one that is far enough away.
        return _nearest(lightness - _HOVER_DARKER, 0.0, chroma, hue, passes)
    # A dark ink on a surface that is only just light enough for it: the step goes lighter.
    return _nearest(lightness + _HOVER_DARKER, 1.0, chroma, hue, passes)


@dataclass(frozen=True, slots=True)
class BrandPalette:
    """The palette of one colour (see the module for each role's guarantee)."""

    strong: str
    strong_hover: str
    deep: str
    bright: str
    tint: str
    tint_border: str
    on_strong: str
    on_bright: str
    surface: str
    on_surface: str
    surface_hover: str

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


@lru_cache(maxsize=1024)
def derive_palette(color: str) -> BrandPalette:
    """The palette of `color` (`#rrggbb`, lower case). Raises ValueError for anything else."""
    lightness, chroma, hue = oklch(color)  # refuses anything that is not a colour
    if chroma < _GREY_CHROMA:
        chroma, hue = 0.0, 0.0

    # The colour itself wherever white text reads on it; otherwise its hue, darkened.
    if contrast(WHITE, color) >= TEXT_CONTRAST:
        strong = color
    else:
        strong = _nearest(lightness, 0.0, chroma, hue, _reads_on((WHITE, DARKENED_CONTRAST)))
    strong_hover = _hover(strong, WHITE, chroma, hue)

    # A surface is the colour itself under whichever ink reads on it, white first; a mid-tone that
    # carries neither is painted with the strong step.
    if contrast(WHITE, color) >= TEXT_CONTRAST:
        surface, on_surface = color, WHITE
    elif contrast(INK, color) >= TEXT_CONTRAST:
        surface, on_surface = color, INK
    else:
        surface, on_surface = strong, WHITE
    surface_hover = strong_hover if surface == strong else _hover(surface, on_surface, chroma, hue)

    deep = _nearest(_DEEP_LIGHTNESS, 0.0, min(chroma, _DEEP_CHROMA), hue, _reads_on((WHITE, DEEP_CONTRAST)))
    accent = _reads_on((INK, TEXT_CONTRAST), (deep, TEXT_CONTRAST))
    own = lightness >= _BRIGHT_OWN_LIGHTNESS and (
        chroma >= _BRIGHT_OWN_CHROMA or lightness <= _BRIGHT_OWN_CEILING
    )
    if own and accent(color):
        bright = color
    else:
        bright = _nearest(_BRIGHT_LIGHTNESS, 1.0, min(chroma, _BRIGHT_CHROMA), hue, accent)
    tint = _nearest(
        _TINT_LIGHTNESS,
        1.0,
        min(chroma, _TINT_CHROMA),
        hue,
        _reads_on((strong, TEXT_CONTRAST), luminance_floor=TINT_MIN_LUMINANCE),
    )
    # Between the tint and the strong colour: never lighter than the one, never darker than the other.
    border = _color(_BORDER_LIGHTNESS, min(chroma, _BORDER_CHROMA), hue)
    if luminance(border) > luminance(tint):
        border = tint
    elif luminance(border) < luminance(strong):
        border = strong
    return BrandPalette(
        strong=strong,
        strong_hover=strong_hover,
        deep=deep,
        bright=bright,
        tint=tint,
        tint_border=border,
        on_strong=WHITE,
        on_bright=INK,
        surface=surface,
        on_surface=on_surface,
        surface_hover=surface_hover,
    )
