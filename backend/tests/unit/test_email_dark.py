"""The e-mails' dark design (Phase 13, B13-1, B13-2, B13-5): what a mail client in dark mode shows, the
logo that reads in every client, and the previews of one design alone.

* Colours: the web application's dark neutrals, and the company's brand colours on them by the rules of
  `frontend/src/identity/tokens.ts` (`darkTokens`), pinned here; every pair reads (text 4.5:1, the bar
  and the buttons' edges 3:1) for the product's colours, a spread of companies and a grid of the cube.
* Markup: every element painted in the light design has a dark value, except what stays as it is (the
  pass card, the QR code on its white tile, the yellow attention pill, the product's band).
* The logo: the dark rendition only in the dark design, with the company's name beside a mark; the
  light rendition's white tile where there is none.
* Previews: `light` has nothing that can match `prefers-color-scheme: dark`; `dark` applies its rules
  unconditionally.
"""

import re
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from itertools import product
from types import SimpleNamespace

import pytest

from app.core.palette import WHITE, contrast, derive_palette, to_hex
from app.core.png import PngLimits, decode_png
from app.core.qr import qr_png
from app.email.identity import (
    DARK_ATTENTION_SURFACE,
    DARK_BODY,
    DARK_CANVAS,
    DARK_INK,
    DARK_MUTED,
    DARK_SUNKEN,
    DARK_SURFACE,
    DEFAULT_COLORS,
    DarkColors,
    Identity,
    colors_of,
    dark_colors,
    dark_colors_of,
)
from app.email.logos import PLATE, dark_rendition, light_rendition
from app.email.providers.base import OutgoingEmail
from app.email.rendering import EmailRenderer
from app.email.service import LOGO_CONTENT_ID, LOGO_DARK_CONTENT_ID, build_test_email
from tests.png_support import CompanyLogos, drawn_logo, png_size
from tests.unit.test_email_templates import START, TOKEN, _all_emails, _company, _service, _visit

# The pass card's own colours, which the dark design keeps (templates/macros.html).
CARD_MUTED = "#b8c4cb"
# The yellow pill of a change to notice, and its ink: the same in both designs.
ATTENTION, ATTENTION_INK = "#f7b916", "#1e2a32"
# The spread of companies the contract names: yellow, white, black, navy, pastel, and the two demo colours.
SPREAD = {
    "yellow": "#f5b800",
    "white": "#ffffff",
    "black": "#000000",
    "navy": "#000080",
    "pastel": "#f9c6d0",
    "demo blue": "#007ac3",
    "demo sand": "#a18e78",
    "the bank's navy": "#1b3a6b",
    "neon": "#39ff14",
    "mid grey": "#808080",
}
GRID = [to_hex(rgb) for rgb in product(range(0, 256, 17), repeat=3)]
# Classes that place things (the phone's layout), not colour them.
LAYOUT = {"vpx", "vpp", "vcl", "vcs", "vhd", "vhk"}


def _pairs(dark: DarkColors) -> dict[str, tuple[float, float]]:
    """Every pair the dark design draws: its contrast, and the least it needs."""
    lower = {name: getattr(dark, name).lower() for name in DarkColors.__dataclass_fields__}
    text = {
        f"{ink} on {ground}": (contrast(lower[ink], lower[ground]), 4.5)
        for ink in ("ink", "body", "muted")
        for ground in ("canvas", "surface", "sunken", "accent_surface", "attention_surface")
    }
    return {
        **text,
        "brand text on the card": (contrast(lower["accent_text"], lower["surface"]), 4.5),
        "the pill's text on the pill": (contrast(lower["accent_text"], lower["accent_surface"]), 4.5),
        "the primary button's text": (contrast(lower["on_accent"], lower["accent"]), 4.5),
        "a step's figure on its square": (contrast(lower["on_accent"], lower["accent"]), 4.5),
        "the bar and every button's edge on the card": (contrast(lower["accent"], lower["surface"]), 3.0),
        "a notice's edge on the card": (contrast(lower["accent"], lower["surface"]), 3.0),
        "the attention notice's edge": (contrast(lower["attention_edge"], lower["surface"]), 3.0),
    }


# ---- colours ----------------------------------------------------------------------------------------


def test_the_neutrals_are_the_web_application_s_dark_ones() -> None:
    """index.css, theme-dark: canvas, surface, sunken, text, secondary text, muted text."""
    assert (DARK_CANVAS, DARK_SURFACE, DARK_SUNKEN) == ("#101619", "#182126", "#12191c")
    assert (DARK_INK, DARK_BODY, DARK_MUTED) == ("#eef2f4", "#c3ced5", "#99a9b2")
    assert DARK_ATTENTION_SURFACE == "#2d2408"  # --color-warning-surface


@pytest.mark.parametrize(
    ("color", "accent", "accent_surface", "accent_border"),
    [
        (None, "#27B5BB", "#1E2A32", "#226269"),
        ("#1b3a6b", "#9ABFFA", "#1E3559", "#506C99"),
        ("#f5b800", "#F5B800", "#463200", "#8C6800"),
        ("#ffffff", "#BEBEBE", "#353535", "#6C6C6C"),
        ("#000000", "#BEBEBE", "#353535", "#6C6C6C"),
    ],
    ids=["no colour", "the bank's navy", "yellow", "white", "black"],
)
def test_the_brand_colours_are_derived_as_the_web_application_derives_them(
    color: str | None, accent: str, accent_surface: str, accent_border: str
) -> None:
    """Values of tokens.ts `darkTokens` for the same palettes (`accent`, `accent-text`, `accent-surface`,
    `accent-border`, `on-accent`), taken from the web application's own code; 412 palettes agreed when
    the port was written (B13-1). A company without a colour: the same rules on the product's colours."""
    dark = dark_colors_of(derive_palette(color) if color else None)
    assert (dark.accent, dark.accent_text, dark.accent_surface, dark.accent_border) == (
        accent,
        accent,
        accent_surface,
        accent_border,
    )
    assert dark.on_accent == ("#1E2A32" if color is None else "#1C262B")


@pytest.mark.parametrize(
    ("deep", "bright", "accent", "accent_text", "accent_surface", "accent_border"),
    [
        ("#3a3a3a", "#202020", "#797979", "#a4a4a4", "#3a3a3a", "#535353"),
        ("#556677", "#334455", "#6c7885", "#a1a9b1", "#333d47", "#4a5560"),
        ("#2a2a2a", "#8a8a8a", "#8a8a8a", "#939393", "#2a2a2a", "#505050"),
        ("#40209a", "#5040c0", "#7366cd", "#aba3e1", "#40209a", "#543cae"),
    ],
)
def test_the_rules_move_a_colour_that_does_not_read_as_the_web_application_does(
    deep: str, bright: str, accent: str, accent_text: str, accent_surface: str, accent_border: str
) -> None:
    """No palette the server derives needs a dark colour moved (over 70,849 colours none does: its own
    guarantees meet the dark targets), so these inputs are made up: roles that do not read on the dark
    surfaces. The values are tokens.ts `darkTokens`' for the same inputs (604 such inputs agreed)."""
    dark = dark_colors(deep, bright, "#1c262b")
    assert (dark.accent, dark.accent_text, dark.accent_surface, dark.accent_border) == tuple(
        value.upper() for value in (accent, accent_text, accent_surface, accent_border)
    )


def test_the_product_s_dark_design_reads_in_every_pair() -> None:
    pairs = _pairs(dark_colors_of(None))
    failing = {name: round(ratio, 2) for name, (ratio, least) in pairs.items() if ratio < least}
    assert not failing


def test_every_colour_a_company_can_have_gives_a_dark_design_that_reads() -> None:
    """The spread of the contract and a grid of the whole RGB cube (16 x 16 x 16 colours)."""
    assert len(GRID) == 4096
    for color in [*SPREAD.values(), *GRID]:
        pairs = _pairs(dark_colors_of(derive_palette(color)))
        failing = {name: round(ratio, 2) for name, (ratio, least) in pairs.items() if ratio < least}
        assert not failing, (color, failing)


@pytest.mark.parametrize("color", [None, *SPREAD.values()])
def test_what_the_dark_design_keeps_still_reads_on_it(color: str | None) -> None:
    """The pass card keeps its light design's colours: white, its small print and the accent on it read
    (as tests/unit/test_email_identity.py holds for every colour); the attention pill is the same yellow."""
    colors = colors_of(derive_palette(color)) if color else DEFAULT_COLORS
    card = colors.card.lower()
    assert contrast(WHITE, card) >= 10 and contrast(CARD_MUTED, card) >= 4.5
    assert contrast(colors.accent.lower(), card) >= 4.5
    assert contrast(ATTENTION_INK, ATTENTION) >= 4.5


# ---- the markup of the dark design -------------------------------------------------------------------

_COLOURING = re.compile(r"(?<![-\w])(?:background-color|color|border(?:-[a-z]+)?)\s*:[^;\"]*#[0-9A-Fa-f]{6}")


@dataclass
class _Element:
    tag: str
    classes: set[str]
    style: str
    painted: bool  # sets a colour of its own (inline, or a bgcolor)
    kept: bool  # stands where the dark design keeps the light one's colours


class _Painting(HTMLParser):
    """Every element of the body, with whether it paints a colour and whether the dark design keeps it."""

    VOID = {"img", "meta", "br", "hr", "link", "input"}

    def __init__(self) -> None:
        super().__init__()
        self.elements: list[_Element] = []
        self._stack: list[bool] = []  # per open element: whether it and what is inside it are kept
        self._in_body = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: value or "" for name, value in attrs}
        if tag == "body":
            self._in_body = True
        classes = set(values.get("class", "").split())
        style = values.get("style", "")
        painted = bool(_COLOURING.search(style)) or "bgcolor" in values
        inside = bool(self._stack and self._stack[-1])
        kept = inside or bool(
            classes & {"vps", "vdo"}  # the pass card; what only the dark design shows
            or "display:none" in style.replace(" ", "")  # the preheader
            or values.get("bgcolor", "").upper() in {"#188086", "#27B5BB"}  # the product's band and rule
            or "background-color:#F7B916" in style  # the attention pill
            or tag == "img"  # an image's alternative text in the colour around it
        )
        if self._in_body:
            self.elements.append(_Element(tag, classes, style, painted, kept))
        if tag not in self.VOID:
            self._stack.append(kept)

    def handle_endtag(self, tag: str) -> None:
        if tag not in self.VOID and self._stack:
            self._stack.pop()


def _dark_rules(html: str) -> dict[str, str]:
    """The dark design's rules by class (from the style sheet with the media query)."""
    start = html.index("@media (prefers-color-scheme: dark)")
    block = html[start : html.index("</style>", start)]
    rules: dict[str, str] = {}
    for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", block.split("{", 1)[1]):
        for selector in selectors.split(","):
            name = selector.strip().lstrip(".")
            rules[name] = rules.get(name, "") + body
    return rules


def _has_class(html: str, name: str) -> bool:
    """Whether an element of `html` has the class `name`."""
    return re.search(rf'class="(?:[^"]* )?{name}(?: [^"]*)?"', html) is not None


def _emails(identity: str, lead: str = "en") -> list[OutgoingEmail]:
    navy, mark, gold = drawn_logo("navy"), drawn_logo("mark"), drawn_logo("gold")
    logos = {
        "mark": CompanyLogos(navy, *png_size(navy), dark=mark),
        "wordmark": CompanyLogos(navy, *png_size(navy), dark=gold),
        "light only": CompanyLogos(navy, *png_size(navy)),
        # A logo for light surfaces that is an emblem (the bank's diamond): alone, with its mark for dark
        # surfaces, with a wordmark for dark surfaces.
        "emblem": CompanyLogos(mark, *png_size(mark)),
        "emblems": CompanyLogos(mark, *png_size(mark), dark=mark),
        "emblem and wordmark": CompanyLogos(mark, *png_size(mark), dark=gold),
    }.get(identity)
    service = _service(logos=logos) if logos else _service()
    return _all_emails(_company(default_language=lead, brand_color="#1b3a6b"), service)


IDENTITIES = ["mark", "wordmark", "light only", "no logo"]


@pytest.mark.parametrize("identity", IDENTITIES)
@pytest.mark.parametrize("lead", ["ar", "en"])
def test_every_e_mail_says_it_has_a_light_and_a_dark_design(identity: str, lead: str) -> None:
    for email in _emails(identity, lead):
        html = email.html
        assert '<meta name="color-scheme" content="light dark">' in html, email.kind
        assert '<meta name="supported-color-schemes" content="light dark">' in html
        assert ":root{color-scheme:light dark;" in html
        # The dark rules in a media query, and again for Outlook.com's own dark mode, each in a style
        # sheet of its own (a client that drops one keeps the others).
        assert html.count("@media (prefers-color-scheme: dark) {") == 1
        assert "[data-ogsb] .vcv" in html and "[data-ogsc] .vik" in html
        assert re.search(r"<style>\s*\[data-ogsb\]", html)


@pytest.mark.parametrize("identity", IDENTITIES)
def test_every_painted_element_has_a_dark_value(identity: str) -> None:
    """Apple Mail in dark mode shows exactly what the dark rules say: an element painted in the light
    design without a dark rule would stay white (a white header on a dark card, dark text on dark).
    Kept as they are: the pass card, the preheader, images, the attention pill, the product's band."""
    for email in [*_emails(identity), *_emails(identity, "ar")]:
        rules = _dark_rules(email.html)
        parser = _Painting()
        parser.feed(email.html)
        missing = [
            (element.tag, element.style[:60])
            for element in parser.elements
            if element.painted and not element.kept and not (element.classes - LAYOUT) & set(rules)
        ]
        assert not missing, (email.kind, missing)
        used = {name for element in parser.elements for name in element.classes}
        # Every rule is for something there is (the logo's two classes only where a dark logo is).
        unused = set(rules) - used - {"vlo", "vdo", "vbn", "vbnt"}
        unused -= {"vbo", "vbot", "vst", "vnt"}
        unused -= {"vna", "vps", "vgd", "vgc", "vpl"}
        assert not unused, (email.kind, unused)


def test_the_dark_rules_carry_the_company_s_dark_colours() -> None:
    dark = dark_colors_of(derive_palette("#1b3a6b"))
    rules = _dark_rules(_emails("mark")[0].html)
    assert f"background-color:{dark.canvas}!important" in rules["vcv"]
    assert f"background-color:{dark.surface}!important" in rules["vcd"]
    assert f"background-color:{dark.accent}!important" in rules["vbr"]
    assert f"color:{dark.accent_text}!important" in rules["vlk"]
    assert f"background-color:{dark.accent_surface}!important" in rules["vpl"]
    assert f"color:{dark.on_accent}!important" in rules["vbnt"]
    assert f"color:{dark.ink}!important" in rules["vik"]
    assert "display:none!important" in rules["vlo"]
    assert "display:block!important" in rules["vdo"]


def test_the_dark_rules_come_after_the_phone_s() -> None:
    """Both set the line under a stacked cell; the dark colour must win."""
    html = _emails("mark")[0].html
    assert html.index("@media only screen and (max-width: 480px)") < html.index("prefers-color-scheme: dark")


_SWAP = re.compile(r"\.v(?:lo|do)\b")  # a selector of the logo's swap: the light rendition out, the dark in


@pytest.mark.parametrize("identity", ["mark", "wordmark", "emblems", "emblem and wordmark"])
@pytest.mark.parametrize("lead", ["ar", "en"])
def test_the_logo_s_swap_stays_inside_the_dark_media_query(identity: str, lead: str) -> None:
    """B13-9. The swap hides the light rendition and shows the dark one: anywhere but inside
    `@media (prefers-color-scheme: dark)` it would hide the logo where no dark design is shown (the
    reviewer's mutation, macros.html `{% if not outlook %}` made `{% if true %}`, put it in Outlook.com's
    sheet, which every client that reads attribute selectors applies). And Outlook.com's sheet is its
    own: every selector in it starts with one of its two marks."""
    for email in _emails(identity, lead):
        sheets = re.findall(r"<style>(.*?)</style>", email.html, flags=re.DOTALL)
        [media] = [sheet for sheet in sheets if "@media (prefers-color-scheme: dark)" in sheet]
        query = media.index("@media (prefers-color-scheme: dark)")
        inside = media[media.index("{", query) + 1 : media.rindex("}")]
        assert len(_SWAP.findall(inside)) == 2, email.kind
        assert not _SWAP.search(media.replace(inside, "")), email.kind
        assert not [sheet for sheet in sheets if sheet is not media and _SWAP.search(sheet)], email.kind
        [outlook] = [sheet for sheet in sheets if "[data-og" in sheet]
        selectors = [
            selector.strip()
            for group in re.findall(r"([^{}]+)\{[^{}]*\}", outlook)
            for selector in group.split(",")
        ]
        assert len(selectors) > 20
        assert all(selector.startswith(("[data-ogsb] ", "[data-ogsc] ")) for selector in selectors), selectors


# ---- the logo ----------------------------------------------------------------------------------------


def _header(html: str) -> str:
    """A company's header, from its bar to the heading (the preheader before it names the company too)."""
    return html[html.index('class="vbr"') : html.index("<h1")]


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_mark_for_dark_surfaces_is_shown_by_the_dark_design_only_with_the_name_beside_it(lead: str) -> None:
    """The bank's case: a navy wordmark for light surfaces and its diamond alone for dark ones."""
    name = "أكمي القابضة" if lead == "ar" else "Acme Holding"
    navy, mark = drawn_logo("navy"), drawn_logo("mark")
    for email in _emails("mark", lead):
        images = {image.content_id: image.content for image in email.inline_images}
        assert images[LOGO_CONTENT_ID] == light_rendition(navy).content
        assert images[LOGO_DARK_CONTENT_ID] == dark_rendition(mark).content
        header = _header(email.html)
        # The light rendition, hidden by the dark design.
        assert re.search(rf'<img src="cid:{LOGO_CONTENT_ID}"[^>]* alt="{name}" class="vlo"', header)
        # The dark one: hidden from every client but the dark design, and from Outlook for Windows.
        dark = header[header.index("<!--[if !mso]><!-->") : header.index("<!--<![endif]-->")]
        assert '<div class="vdo" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">' in dark
        assert re.search(
            rf'<img src="cid:{LOGO_DARK_CONTENT_ID}" width="\d+" height="{44 + 2 * PLATE}" alt=""', dark
        )
        # A mark does not say whose it is: the name beside it, in the dark design's ink.
        assert re.search(rf'class="vik" style="[^"]*">{name}</span>', dark)
        assert f"color:{DARK_INK.upper()}!important" in _dark_rules(email.html)["vik"]
        assert header.count(f">{name}<") == 1 and f'alt="{name}"' in header


def test_the_dark_logo_is_seamless_on_the_dark_header() -> None:
    """The dark rendition's plate is exactly the colour the dark rules paint the header with."""
    email = _emails("mark")[0]
    rules = _dark_rules(email.html)
    header = re.search(r"background-color:(#[0-9A-F]{6})!important", rules["vsf"])
    assert header is not None
    [dark] = [image.content for image in email.inline_images if image.content_id == LOGO_DARK_CONTENT_ID]
    pixels = decode_png(dark, PngLimits(1, 2000, 1, 2000, 1 << 20))
    corner = pixels.rgba[:3]
    assert "#{:02X}{:02X}{:02X}".format(*corner) == header.group(1) == DARK_SURFACE.upper()


def test_a_wordmark_for_dark_surfaces_stands_alone() -> None:
    for email in _emails("wordmark"):
        dark = _header(email.html)
        dark = dark[dark.index('<div class="vdo"') : dark.index("<!--<![endif]-->")]
        assert re.search(
            rf'<img src="cid:{LOGO_DARK_CONTENT_ID}" width="\d+" height="\d+" alt="Acme Holding"', dark
        )
        assert "</span>" not in dark


def test_without_a_logo_for_dark_surfaces_the_dark_design_keeps_the_white_tile() -> None:
    """Deliberately: the light rendition, opaque and rounded, reads on the dark header too."""
    for email in _emails("light only"):
        header = _header(email.html)
        assert not _has_class(header, "vlo") and not _has_class(header, "vdo")
        assert LOGO_DARK_CONTENT_ID not in {image.content_id for image in email.inline_images}
        assert re.search(
            r'<img src="cid:brand-logo"[^>]*style="display:block;[^"]*border-radius:10px;', header
        )


def test_without_a_logo_the_name_is_written_in_both_designs() -> None:
    for email in _emails("no logo"):
        header = _header(email.html)
        assert "cid:" not in header
        assert re.search(r'class="vlk" style="[^"]*">Acme Holding</span>', header)


def test_a_logo_for_dark_surfaces_without_one_for_light_surfaces_is_not_shown() -> None:
    """As the web application's CompanyLogo on a page: without a logo for light surfaces, the name."""
    company = _company(brand_color="#1b3a6b")

    class _DarkOnly(CompanyLogos):
        def image(self, company_id: uuid.UUID, kind):
            return None if kind.value == "logo" else super().image(company_id, kind)

    service = _service(logos=_DarkOnly(b"", 1, 1, dark=drawn_logo("gold")))
    for email in _all_emails(company, service):
        assert not email.inline_images or {image.content_id for image in email.inline_images} == {
            "visitor-pass-qr"
        }
        assert not _has_class(_header(email.html), "vdo")


# ---- the name beside an emblem (B13-12) ---------------------------------------------------------------

_NAMES = {"ar": "أكمي القابضة", "en": "Acme Holding"}


def _name_beside(name: str, classes: str) -> re.Pattern[str]:
    """The cell of the name beside an emblem: in the light design's ink (the dark rules give `vik` the
    dark one), 12 pixels from the emblem's own edge (its plate is part of them)."""
    return re.compile(
        rf'<td valign="middle" style="vertical-align:middle;padding-(?:left|right):{12 - PLATE}px;">\s*'
        rf'<span dir="(?:ltr|rtl)" class="{classes}" style="[^"]*font-weight:700;color:#1E2A32;[^"]*">'
        rf"{name}</span>"
    )


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_beside_a_light_emblem_the_name_is_written_in_both_designs(lead: str) -> None:
    """The web application's rule (CompanyLogo.tsx): an emblem does not say whose it is, so the name
    stands beside it, and the picture's own text alternative is empty. Without a logo for dark surfaces
    the dark design keeps the white tile, and the name beside it."""
    name = _NAMES[lead]
    for email in _emails("emblem", lead):
        header = _header(email.html)
        assert re.search(rf'<img src="cid:{LOGO_CONTENT_ID}"[^>]* alt="" style="display:block;', header)
        assert _name_beside(name, "vik").search(header), email.kind
        assert header.count(f">{name}<") == 1
        assert not _has_class(header, "vlo") and not _has_class(header, "vdo")


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_two_emblems_share_one_name(lead: str) -> None:
    """An emblem for each design: one name serves both, outside the block only the dark design shows."""
    name = _NAMES[lead]
    for email in _emails("emblems", lead):
        header = _header(email.html)
        assert _name_beside(name, "vik").search(header), email.kind
        assert header.count(name) == 1  # neither image's text alternative repeats it
        dark = header[header.index("<!--[if !mso]><!-->") : header.index("<!--<![endif]-->")]
        assert f'src="cid:{LOGO_DARK_CONTENT_ID}"' in dark and name not in dark
        assert re.search(rf'<img src="cid:{LOGO_CONTENT_ID}"[^>]* alt="" class="vlo"', header)


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_beside_a_light_emblem_and_a_dark_wordmark_the_dark_design_hides_the_name(lead: str) -> None:
    name = _NAMES[lead]
    for email in _emails("emblem and wordmark", lead):
        header = _header(email.html)
        assert _name_beside(name, "vik vlo").search(header), email.kind
        assert re.search(rf'<img src="cid:{LOGO_DARK_CONTENT_ID}"[^>]* alt="{name}"', header)
        assert re.search(rf'<img src="cid:{LOGO_CONTENT_ID}"[^>]* alt="" class="vlo"', header)


def test_the_qr_code_is_opaque_with_its_quiet_zone() -> None:
    """A client that inverts backgrounds cannot hide it: grey without tRNS, and four white modules round."""
    data = qr_png("https://vms.test/pass?c=acme#" + TOKEN)
    assert data[24:26] == bytes((1, 0)) and b"tRNS" not in data
    pixels = decode_png(data, PngLimits(1, 2000, 1, 2000, 1 << 20))
    rows = [pixels.rgba[y * pixels.width * 4 : (y + 1) * pixels.width * 4] for y in range(pixels.height)]
    quiet = 4 * 8  # four modules of eight pixels
    for row in rows[:quiet] + rows[-quiet:]:
        assert row == b"\xff" * len(row)
    for row in rows:
        assert row[: quiet * 4] == row[-quiet * 4 :] == b"\xff" * (quiet * 4)


# ---- the product's own e-mail ------------------------------------------------------------------------


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_the_product_s_test_e_mail_has_the_dark_design_too(lead: str) -> None:
    service = _service()
    email = build_test_email(service.settings, EmailRenderer(), "ops@example.com", now=START, language=lead)
    assert '<meta name="color-scheme" content="light dark">' in email.html
    rules = _dark_rules(email.html)
    assert f"background-color:{dark_colors_of(None).surface}!important" in rules["vcd"]
    # Its band and its logo baked onto the band stay as they are.
    assert 'bgcolor="#188086" class="vpx"' in email.html
    parser = _Painting()
    parser.feed(email.html)
    assert not [
        e for e in parser.elements if e.painted and not e.kept and not (e.classes - LAYOUT) & set(rules)
    ]


# ---- previews of one design ------------------------------------------------------------------------------


def _preview(scheme: str, identity: str = "mark", lead: str = "en"):
    navy, mark = drawn_logo("navy"), drawn_logo("mark")
    logos = CompanyLogos(navy, *png_size(navy), dark=mark) if identity == "mark" else None
    service = _service(logos=logos) if logos else _service()
    company = _company(default_language=lead, brand_color="#1b3a6b")
    visit = _visit(company, check_in_at=START)
    url = "https://vms.test/pass?c=acme#sample-not-a-visitor-pass"
    return [
        service.prepare_visitor_invitation(visit, url, company=company, host_email=None, scheme=scheme),
        service.prepare_visit_rescheduled(visit, company=company, host_email=None, scheme=scheme),
        service.prepare_visit_cancelled(visit, "Travel", company=company, host_email=None, scheme=scheme),
        service.prepare_host_arrival(
            visit, company=company, host_name="Omar", host_language=lead, scheme=scheme
        ),
    ]


@pytest.mark.parametrize("identity", ["mark", "no logo"])
@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_light_preview_cannot_turn_dark(identity: str, lead: str) -> None:
    """A document in a frame follows the device's scheme, whatever the page around it says: the light
    preview has no rule that `prefers-color-scheme: dark` could switch on, and no dark logo."""
    for prepared in _preview("light", identity, lead):
        html = prepared.rendered.html
        assert '<meta name="color-scheme" content="light">' in html
        assert ":root{color-scheme:light;" in html
        assert "prefers-color-scheme" not in html
        styles = "".join(re.findall(r"<style>(.*?)</style>", html, flags=re.DOTALL))
        assert ".vdo" not in styles and "data-og" not in styles
        assert re.findall(r"@media[^{]*", styles) == ["@media only screen and (max-width: 480px) "]
        assert not _has_class(html, "vdo") and f"cid:{LOGO_DARK_CONTENT_ID}" not in html


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_dark_preview_applies_the_dark_design_whatever_the_viewer_s_scheme(lead: str) -> None:
    for prepared in _preview("dark", lead=lead):
        html = prepared.rendered.html
        assert '<meta name="color-scheme" content="dark">' in html
        assert ":root{color-scheme:dark;" in html
        assert "prefers-color-scheme" not in html and "data-og" not in html
        # The rules stand on their own: no media query around them.
        assert re.search(r"<style>\s*\.vcv\{background-color:#101619!important\}", html)
        assert ".vdo{display:block!important;" in html
        assert f'src="cid:{LOGO_DARK_CONTENT_ID}"' in html


def test_the_e_mail_as_sent_is_the_default() -> None:
    service = _service()
    company = _company()
    visit = _visit(company)
    sent = service.prepare_visit_rescheduled(visit, company=company, host_email=None).rendered.html
    assert '<meta name="color-scheme" content="light dark">' in sent


# ---- a process that started before the dark design (B12-26) ------------------------------------------


@dataclass(frozen=True)
class _IdentityBefore:
    """`Identity` as it was before Phase 13: no dark colours, no plate, no dark logo."""

    product: bool
    names: dict
    masthead: dict
    colors: object
    logo: object = None
    logo_width: int = 0
    logo_height: int = 0


class _RendererBeforeTheDarkDesign:
    """Renders today's templates with the values the code knew before Phase 13 (no `scheme`)."""

    def __init__(self) -> None:
        self.renderer = EmailRenderer()

    def render(self, template, *, subject, context, language, scheme=None):
        identity = context["identity"]
        older = {
            **context,
            "identity": _IdentityBefore(
                identity.product,
                identity.names,
                identity.masthead,
                identity.colors,
                identity.logo,
                identity.logo_width,
                identity.logo_height,
            ),
        }
        return self.renderer.render(template, subject=subject, context=older, language=language)


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_process_that_started_before_the_dark_design_still_sends_the_light_one(lead: str) -> None:
    """The user's demonstration server reads changed templates with the code it started with (B12-26)."""
    navy = drawn_logo("navy")
    older = _service(logos=CompanyLogos(navy, *png_size(navy), dark=drawn_logo("mark")))
    older.renderer = _RendererBeforeTheDarkDesign()  # type: ignore[assignment]
    emails = _all_emails(_company(default_language=lead, brand_color="#1b3a6b"), older)
    assert len(emails) == 8
    for email in emails:
        assert '<meta name="color-scheme" content="light">' in email.html
        assert "prefers-color-scheme" not in email.html and not _has_class(email.html, "vdo")
        # No plate either: the header keeps its padding.
        assert 'class="vpx vsf" style="padding:18px 32px 16px 32px;' in email.html


class _RendererBeforeTheNameBesideALightEmblem:
    """Renders today's templates with the identity this phase's first code built: everything but
    `logo_mark` (B13-12), which the user's demonstration server ran when these templates changed."""

    def __init__(self) -> None:
        self.renderer = EmailRenderer()

    def render(self, template, *, subject, context, language, scheme=None):
        identity = context["identity"]
        fields = {
            name: getattr(identity, name) for name in Identity.__dataclass_fields__ if name != "logo_mark"
        }
        older = {**context, "identity": SimpleNamespace(**fields)}
        return self.renderer.render(
            template, subject=subject, context=older, language=language, scheme=scheme
        )


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_process_that_started_before_the_name_beside_a_light_emblem_still_sends(lead: str) -> None:
    """Without `logo_mark` a light emblem stands alone in the light design, as that code drew it, and
    the rest of the e-mail is today's."""
    older = _service(logos=CompanyLogos(drawn_logo("mark"), *png_size(drawn_logo("mark"))))
    older.renderer = _RendererBeforeTheNameBesideALightEmblem()  # type: ignore[assignment]
    emails = _all_emails(_company(default_language=lead, brand_color="#1b3a6b"), older)
    assert len(emails) == 8
    for email in emails:
        header = _header(email.html)
        assert re.search(rf'<img src="cid:{LOGO_CONTENT_ID}"[^>]* alt="{_NAMES[lead]}"', header)
        assert f">{_NAMES[lead]}<" not in header
        assert '<meta name="color-scheme" content="light dark">' in email.html
