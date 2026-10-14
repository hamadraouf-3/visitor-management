"""A company's palette (Phase 12, B12-4 and B12-21: `app.core.palette`): every guarantee of every role, for
a grid of the whole RGB cube and for the colours that usually break such a derivation (greys, black, white,
yellow, pastel and neon colours, colours right at the two contrast thresholds)."""

import math
import random
import re
from itertools import product

import pytest

from app.core.palette import (
    ALGORITHM,
    BLACK,
    DARKENED_CONTRAST,
    DEEP_CONTRAST,
    HOVER_MIN_DIFFERENCE,
    INK,
    TEXT_CONTRAST,
    TINT_MIN_LUMINANCE,
    WHITE,
    BrandPalette,
    contrast,
    derive_palette,
    is_color,
    lightness_difference,
    luminance,
    oklch,
    to_hex,
    to_rgb,
)
from app.models.company import BRAND_COLOR_PATTERN

HEX = re.compile(r"#[0-9a-f]{6}")
# Every 15th value of each channel, 0 and 255 included: 18 x 18 x 18 = 5 832 colours of the whole cube.
GRID = [to_hex(rgb) for rgb in product(range(0, 256, 15), repeat=3)]
GREYS = [to_hex((value, value, value)) for value in range(256)]
NAMED = {
    "black": "#000000",
    "white": "#ffffff",
    "nearly black": "#010101",
    "nearly white": "#fefefe",
    "yellow": "#ffff00",
    "mawdoo3 yellow": "#f7b916",
    "neon green": "#39ff14",
    "neon pink": "#ff10f0",
    "neon cyan": "#00ffff",
    "magenta": "#ff00ff",
    "red": "#ff0000",
    "green": "#00ff00",
    "blue": "#0000ff",
    "mawdoo3 teal": "#188086",
    "the logo's teal": "#169897",
    "mid grey": "#808080",
    "the lightest grey white reads on": "#767676",
    "one step lighter": "#777777",
    "the product's ink": "#1c262b",
    "pastel": "#ffe4e1",
    "navy": "#000080",
    "brown": "#8b4513",
    # The colours of the review that asked for a company's own colour on its surfaces (B12-21).
    "the review's yellow": "#f5b800",
    "the review's pastel": "#f9c6d0",
    "orange": "#ff6600",
    "the darkest grey the dark ink reads on": "#8b8b8b",
    "one step darker": "#8a8a8a",
}
ROLES = [
    "strong",
    "strong_hover",
    "deep",
    "bright",
    "tint",
    "tint_border",
    "on_strong",
    "on_bright",
    "surface",
    "on_surface",
    "surface_hover",
]


def _random_colours(count: int) -> list[str]:
    generator = random.Random(20261013)
    return [
        to_hex((generator.randrange(256), generator.randrange(256), generator.randrange(256)))
        for _ in range(count)
    ]


def _check(color: str) -> BrandPalette:
    """Every guarantee of the palette of `color` (the module's table, and the contract's)."""
    palette = derive_palette(color)
    roles = palette.as_dict()
    assert list(roles) == ROLES
    assert all(HEX.fullmatch(value) for value in roles.values()), (color, roles)
    assert palette.on_strong == WHITE and palette.on_bright == INK

    # strong: white text reads on it; it reads on white. The colour itself when it already passes.
    white_on_strong = contrast(WHITE, palette.strong)
    assert white_on_strong >= TEXT_CONTRAST, (color, palette.strong, white_on_strong)
    if contrast(WHITE, color) >= TEXT_CONTRAST:
        assert palette.strong == color
    else:
        # Darkened, and no more than the palette needs: just past 5:1.
        assert luminance(palette.strong) < luminance(color)
        assert DARKENED_CONTRAST <= white_on_strong < DARKENED_CONTRAST + 0.25, (color, palette.strong)

    # strong_hover: a step from strong that can be seen, and white text reads on it as well.
    assert palette.strong_hover != palette.strong, color
    step = lightness_difference(palette.strong, palette.strong_hover)
    assert step >= HOVER_MIN_DIFFERENCE, (color, palette.strong, palette.strong_hover, step)
    assert contrast(WHITE, palette.strong_hover) >= TEXT_CONTRAST, (color, palette.strong_hover)
    if oklch(palette.strong)[0] >= 0.25:
        assert luminance(palette.strong_hover) < luminance(palette.strong), (color, palette.strong_hover)
    else:  # black, or nearly: there is nothing darker to see, so the step lightens
        assert luminance(palette.strong_hover) > luminance(palette.strong), (color, palette.strong_hover)

    # surface: the colour ITSELF wherever white or the dark ink reads on it, white first; a mid-tone
    # that carries neither is painted with strong (B12-21).
    white_reads, ink_reads = contrast(WHITE, color) >= TEXT_CONTRAST, contrast(INK, color) >= TEXT_CONTRAST
    assert not (white_reads and ink_reads), color  # no colour carries both: "white first" never chooses
    if white_reads:
        assert (palette.surface, palette.on_surface) == (color, WHITE), (color, palette.surface)
    elif ink_reads:
        assert (palette.surface, palette.on_surface) == (color, INK), (color, palette.surface)
    else:
        assert (palette.surface, palette.on_surface) == (palette.strong, WHITE), (color, palette.surface)
    # on_surface: white or the dark ink (the ink of `bright`), and it reads on the surface.
    assert palette.on_surface in (WHITE, palette.on_bright)
    on_surface = contrast(palette.on_surface, palette.surface)
    assert on_surface >= TEXT_CONTRAST, (color, palette.surface, palette.on_surface, on_surface)
    # Where the surface is the strong step, the two are one pair with one hover step.
    if palette.surface == palette.strong:
        assert palette.on_surface == palette.on_strong
        assert palette.surface_hover == palette.strong_hover

    # surface_hover: a step from surface that can be seen, under the same ink.
    assert palette.surface_hover != palette.surface, color
    step = lightness_difference(palette.surface, palette.surface_hover)
    assert step >= HOVER_MIN_DIFFERENCE, (color, palette.surface, palette.surface_hover, step)
    on_hover = contrast(palette.on_surface, palette.surface_hover)
    assert on_hover >= TEXT_CONTRAST, (color, palette.surface_hover, palette.on_surface, on_hover)

    # deep: a dark surface for white text.
    assert contrast(WHITE, palette.deep) >= DEEP_CONTRAST, (color, palette.deep)

    # bright: dark text on it, and it on the deep surface.
    assert contrast(palette.on_bright, palette.bright) >= TEXT_CONTRAST, (color, palette.bright)
    assert contrast(palette.bright, palette.deep) >= TEXT_CONTRAST, (color, palette.bright, palette.deep)

    # tint: near white; strong text reads on it.
    assert contrast(palette.strong, palette.tint) >= TEXT_CONTRAST, (color, palette.strong, palette.tint)
    assert luminance(palette.tint) >= TINT_MIN_LUMINANCE, (color, palette.tint)

    # tint_border: between the tint and the strong colour.
    assert luminance(palette.strong) <= luminance(palette.tint_border) <= luminance(palette.tint), color
    return palette


# ---- the guarantees, for everything ---------------------------------------------------------------


def test_every_colour_of_a_grid_of_the_whole_cube_gives_a_palette_that_keeps_every_guarantee() -> None:
    assert len(GRID) == 18**3 and {BLACK, WHITE, "#ffff00", "#ff00ff", "#00ffff"} <= set(GRID)
    for color in GRID:
        _check(color)


def test_every_grey_gives_a_palette_that_keeps_every_guarantee() -> None:
    for color in GREYS:
        _check(color)


@pytest.mark.parametrize("color", NAMED.values(), ids=NAMED.keys())
def test_the_colours_that_usually_break_a_palette(color: str) -> None:
    _check(color)


def test_random_colours_keep_every_guarantee() -> None:
    for color in _random_colours(3000):
        _check(color)


def test_colours_around_the_contrast_threshold_keep_every_guarantee() -> None:
    """The colours white text just reads on, and the ones it just does not: where a derivation that
    rounds at the wrong moment fails by a hair."""
    near = [color for color in GRID + _random_colours(20_000) if 4.3 <= contrast(WHITE, color) <= 4.7]
    assert len(near) > 300
    assert any(contrast(WHITE, color) < TEXT_CONTRAST for color in near)
    assert any(contrast(WHITE, color) >= TEXT_CONTRAST for color in near)
    for color in near:
        _check(color)


def test_colours_around_the_dark_ink_s_threshold_keep_every_guarantee() -> None:
    """The other edge of the mid-tones (B12-21): the colours the dark ink just reads on, which are their
    own surface, and the ones it just does not, which are painted with `strong`. Just above it there is
    no room to darken on hover, so the step goes lighter there."""
    near = [color for color in GRID + _random_colours(20_000) if 4.3 <= contrast(INK, color) <= 4.7]
    assert len(near) > 300
    own = [color for color in near if contrast(INK, color) >= TEXT_CONTRAST]
    assert own and len(own) < len(near)
    for color in near:
        palette = _check(color)
        assert (palette.surface == color) is (color in own), color
    for color in own:
        palette = derive_palette(color)
        assert luminance(palette.surface_hover) > luminance(palette.surface), color


# ---- what the roles look like ------------------------------------------------------------------------


def test_a_grey_brand_stays_grey_in_every_role() -> None:
    for color in [*GREYS[::5], "#ffffff", "#000000"]:
        palette = derive_palette(color)
        for role in (
            "strong",
            "strong_hover",
            "deep",
            "bright",
            "tint",
            "tint_border",
            "surface",
            "surface_hover",
        ):
            red, green, blue = to_rgb(getattr(palette, role))
            assert red == green == blue, (color, role, getattr(palette, role))


def _hue_distance(first: str, second: str) -> float:
    difference = abs(oklch(first)[2] - oklch(second)[2]) % (2 * math.pi)
    return math.degrees(min(difference, 2 * math.pi - difference))


@pytest.mark.parametrize(
    "color", ["#ffff00", "#f7b916", "#39ff14", "#00ffff", "#ff10f0", "#ff6600", "#ff0000"]
)
def test_a_darkened_colour_keeps_its_hue(color: str) -> None:
    """A yellow that has to be darkened becomes a dark yellow (an olive), not a green: lightness moves in
    OKLCH, where the hue a person sees stays."""
    palette = derive_palette(color)
    assert palette.strong != color
    for role in ("strong", "strong_hover", "deep", "bright", "tint_border", "surface", "surface_hover"):
        assert _hue_distance(color, getattr(palette, role)) < 12, (color, role, getattr(palette, role))


def test_a_colour_that_already_carries_white_text_is_used_as_it_is() -> None:
    for color in ("#188086", "#000000", "#0000ff", "#7c3aed", "#767676", "#1c262b", "#8b4513"):
        assert derive_palette(color).strong == color
    # ... and one that does not is darkened, never lightened or replaced.
    assert derive_palette("#777777").strong != "#777777"
    assert luminance(derive_palette("#ffffff").strong) < luminance("#777777")


def test_a_light_vivid_colour_is_its_own_bright_step() -> None:
    """The neon green of a neon-green brand is shown, on dark surfaces and under dark text."""
    for color in ("#ffff00", "#39ff14", "#00ffff", "#f7b916"):
        assert derive_palette(color).bright == color
    # A dark colour's bright step is a light one of its hue; white's is not white (a fill must show).
    assert luminance(derive_palette("#188086").bright) > 0.4
    assert derive_palette("#ffffff").bright != "#ffffff"


def test_the_tint_shows_on_white_wherever_the_colour_leaves_room_for_it() -> None:
    """A colour that had to be darkened is darkened to 5:1, so its tint is a visible one (not white)."""
    for color in GRID:
        palette = derive_palette(color)
        if palette.strong != color:
            assert luminance(palette.tint) < 0.92, (color, palette.tint)


def test_black_and_nearly_black_lighten_on_hover() -> None:
    for color in ("#000000", "#010101", "#0a0a0a", "#00001a"):
        palette = derive_palette(color)
        assert contrast(palette.strong, palette.strong_hover) > 1.3, (color, palette.strong_hover)
        assert contrast(WHITE, palette.strong_hover) >= 10
        assert (palette.surface, palette.surface_hover) == (palette.strong, palette.strong_hover)


# ---- the company's own colour on its surfaces (B12-21) --------------------------------------------------


@pytest.mark.parametrize(
    ("color", "strong", "hover"),
    [
        ("#f5b800", "#8e6900", "#daa300"),  # the review's yellow: an olive brown under white text
        ("#f9c6d0", "#90636d", "#e2b0ba"),  # the review's pastel
        ("#39ff14", "#138100", "#2ce500"),  # the review's neon green
        ("#ffff00", "#737300", "#e7e700"),
        ("#00ffff", "#007c7c", "#00e5e5"),
        ("#ffffff", "#6f6f6f", "#e8e8e8"),
    ],
)
def test_a_light_colour_is_its_own_surface_under_the_dark_ink(color: str, strong: str, hover: str) -> None:
    """A yellow company is yellow: its shell and its buttons are the colour of its logo with dark text,
    not the olive that white text would need. `strong` is still that olive: it is what reads on white."""
    palette = derive_palette(color)
    assert (palette.surface, palette.on_surface) == (color, INK)
    assert palette.on_surface == palette.on_bright == "#1c262b"
    assert palette.strong == strong != palette.surface
    # The pressed step is the same colour a little darker, still under the dark ink.
    assert palette.surface_hover == hover
    assert luminance(palette.surface_hover) < luminance(palette.surface)
    assert contrast(WHITE, palette.surface) < 3 < TEXT_CONTRAST <= contrast(INK, palette.surface_hover)


@pytest.mark.parametrize("color", ["#188086", "#000080", "#000000", "#7c3aed", "#e00000", "#767676"])
def test_a_dark_colour_is_its_own_surface_under_white(color: str) -> None:
    palette = derive_palette(color)
    assert (palette.surface, palette.on_surface) == (color, WHITE)
    assert (palette.surface, palette.surface_hover) == (palette.strong, palette.strong_hover)


@pytest.mark.parametrize(
    ("color", "surface"),
    [("#808080", "#6f6f6f"), ("#ff0000", "#e00000"), ("#777777", "#6f6f6f"), ("#8a8a8a", "#6f6f6f")],
)
def test_a_mid_tone_that_carries_neither_ink_is_painted_with_the_strong_step(
    color: str, surface: str
) -> None:
    """Between the two thresholds (a relative luminance of 0.18 to 0.26) neither white nor the dark ink
    reaches 4.5:1 on the colour: the surface is the same hue, just dark enough for white."""
    assert contrast(WHITE, color) < TEXT_CONTRAST and contrast(INK, color) < TEXT_CONTRAST
    palette = derive_palette(color)
    assert palette.surface == palette.strong == surface != color
    assert (palette.on_surface, palette.surface_hover) == (WHITE, palette.strong_hover)


def test_every_grey_is_painted_by_the_side_of_the_thresholds_it_is_on() -> None:
    """The greys in order: white reads on the dark ones, which are their own surface; then the mid
    greys, painted with the strong grey; then the light ones, their own surface under the dark ink."""
    kinds = [
        "strong" if palette.surface != grey else "white" if palette.on_surface == WHITE else "ink"
        for grey, palette in ((grey, derive_palette(grey)) for grey in GREYS)
    ]
    assert kinds == ["white"] * 0x77 + ["strong"] * (0x8B - 0x77) + ["ink"] * (0x100 - 0x8B)


def test_a_hover_step_goes_darker_wherever_its_ink_still_reads_there() -> None:
    """Darker is what a pressed surface looks like. The step goes lighter only where darker cannot be:
    below a colour too dark to darken visibly, and above a surface only just light enough for the dark
    ink."""
    directions = [
        "darker" if luminance(palette.surface_hover) < luminance(palette.surface) else "lighter"
        for palette in (derive_palette(grey) for grey in GREYS)
    ]
    assert directions == (
        ["lighter"] * 0x22  # black and nearly black
        + ["darker"] * (0x8B - 0x22)  # white text: on the grey itself, then on the strong grey
        + ["lighter"] * (0xA0 - 0x8B)  # the dark ink would not read on a darker step
        + ["darker"] * (0x100 - 0xA0)
    )
    # The same for colours: an orange is light enough for the dark ink, and not for a darker step.
    orange = derive_palette("#ff6600")
    assert (orange.surface, orange.on_surface) == ("#ff6600", INK)
    assert luminance(orange.surface_hover) > luminance(orange.surface)


def test_a_hover_step_is_measured_in_lightness() -> None:
    assert lightness_difference(WHITE, BLACK) == pytest.approx(1.0)
    assert lightness_difference(BLACK, WHITE) == pytest.approx(1.0)  # whichever is the lighter
    assert lightness_difference("#188086", "#188086") == 0
    assert HOVER_MIN_DIFFERENCE == 0.06
    # The least step over the grid is the usual one less what rounding to 8 bits takes.
    least = min(
        lightness_difference(palette.surface, palette.surface_hover)
        for palette in (derive_palette(color) for color in GRID[::7])
    )
    assert HOVER_MIN_DIFFERENCE <= least < 0.07


# ---- the mawdoo3 teal: the demo brand ------------------------------------------------------------------


def test_the_palette_of_the_demo_brand_s_teal() -> None:
    """Pinned: these are the colours the demo company shows. A change of the derivation changes them, and
    must change `ALGORITHM` with them (it is part of every brand's version)."""
    assert ALGORITHM == "oklch-2"
    assert derive_palette("#188086").as_dict() == {
        "strong": "#188086",
        "strong_hover": "#006a70",
        "deep": "#003e41",
        "bright": "#74cfd5",
        "tint": "#eafeff",
        "tint_border": "#a3dde1",
        "on_strong": "#ffffff",
        "on_bright": "#1c262b",
        "surface": "#188086",
        "on_surface": "#ffffff",
        "surface_hover": "#006a70",
    }


@pytest.mark.parametrize(
    ("color", "strong", "bright"),
    [
        ("#000000", "#000000", "#bebebe"),
        ("#ffffff", "#6f6f6f", "#bebebe"),
        ("#ffff00", "#737300", "#ffff00"),
        ("#39ff14", "#138100", "#39ff14"),
        ("#ff0000", "#e00000", "#ffa193"),
    ],
)
def test_pinned_palettes_of_awkward_colours(color: str, strong: str, bright: str) -> None:
    palette = derive_palette(color)
    assert (palette.strong, palette.bright) == (strong, bright)


def test_the_same_colour_always_gives_the_same_palette() -> None:
    first = [derive_palette(color) for color in GRID[::97]]
    derive_palette.cache_clear()
    assert [derive_palette(color) for color in GRID[::97]] == first


# ---- what a colour is ------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["#000000", "#ffffff", "#188086", "#0a1b2c", "#abcdef"])
def test_a_colour_is_a_hash_and_six_lower_case_hexadecimal_digits(value: str) -> None:
    assert is_color(value)
    assert re.fullmatch(BRAND_COLOR_PATTERN, value)  # the database's CHECK is the same rule


@pytest.mark.parametrize(
    "value",
    [
        "",
        "#",
        "188086",
        "#18808",
        "#1880866",
        "#188086 ",
        " #188086",
        "#188086\n",
        "#18808G",
        "#ABCDEF",
        "#AbCdEf",
        "#fff",
        "#ffff",
        "#ffffffff",
        "red",
        "teal",
        "rgb(24,128,134)",
        "rgb(24 128 134)",
        "hsl(183 70% 31%)",
        "#188086;background:url(//evil.test/x)",
        "#188086}body{display:none",
        "#188086</style><script>alert(1)</script>",
        "url(javascript:alert(1))",
        "var(--color-accent)",
        "expression(alert(1))",
        "#\uff11\uff18\uff18\uff10\uff18\uff16",  # full-width digits
        "#١٨٨٠٨٦",  # Arabic-Indic digits
        "\uff03188086",  # a full-width number sign
        "#18808٦",
        None,
        0,
        188086,
        0x188086,
        1.5,
        True,
        b"#188086",
        ["#188086"],
        {"color": "#188086"},
    ],
)
def test_nothing_else_is_a_colour(value: object) -> None:
    assert not is_color(value)
    if isinstance(value, str):
        assert not re.fullmatch(BRAND_COLOR_PATTERN, value)
        with pytest.raises(ValueError, match="#rrggbb"):
            derive_palette(value)


def test_contrast_is_the_wcag_ratio() -> None:
    assert contrast(WHITE, BLACK) == pytest.approx(21.0)
    assert contrast(BLACK, WHITE) == pytest.approx(21.0)  # whichever is the lighter
    assert contrast("#188086", "#188086") == pytest.approx(1.0)
    # The figures the design documents for the product's teal and ink (docs/development.md §2.5).
    assert round(contrast(WHITE, "#188086"), 2) == 4.70
    assert round(contrast(WHITE, "#136a6f"), 2) == 6.33
    assert round(contrast(WHITE, "#1c262b"), 2) == 15.42
    assert round(contrast(WHITE, "#767676"), 2) == 4.54
