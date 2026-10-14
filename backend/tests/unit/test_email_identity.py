"""Whose e-mail a message is (Phase 12, B12-12, B12-13 and B12-22): every e-mail a company's people and
visitors receive shows that company and nothing of the product: its logo or its name, its own colour on
the bar and the button (B12-21), its name as the sender's; and whatever colour the platform owner chose,
every text in them reads."""

import re
import uuid
from itertools import product
from unicodedata import normalize

import pytest

from app.core.palette import INK as DARK_INK
from app.core.palette import contrast, derive_palette, to_hex
from app.email.headers import SENDER_NAME_MAX_LENGTH, display_name, sender_named
from app.email.identity import DEFAULT_COLORS, EmailColors, colors_of
from app.email.logos import light_rendition
from app.email.providers.base import OutgoingEmail
from app.email.providers.smtp import _mailbox
from app.email.rendering import EmailRenderer
from app.email.service import (
    LOGO_CONTENT_ID,
    brand_logo,
    build_test_email,
    company_identity,
    product_identity,
)
from app.models import Company, User
from tests.png_support import SAMPLE_LOGO, CompanyLogos
from tests.unit.test_email_templates import (
    HOST_EMAIL,
    START,
    TOKEN,
    _all_emails,
    _company,
    _invitation,
    _plain,
    _platform_notice,
    _read,
    _service,
    _visit,
)

WHITE = "#ffffff"
# The colours of an e-mail that are the same for everyone (templates/macros.html).
INK, BODY, MUTED, CARD_MUTED = "#1e2a32", "#33444e", "#5a6872", "#b8c4cb"
# The product's own colours: nothing of them may show in the e-mail of a company with a colour of its own.
PRODUCT_COLOURS = ("#188086", "#146E73", "#27B5BB", "#E5F6F7")
# What names the product and its brand.
PRODUCT_WORDS = ("Mawdoo3", "موضوع", "Visitors", "زوار")
GRID = [to_hex(rgb) for rgb in product(range(0, 256, 17), repeat=3)]  # 16 x 16 x 16 colours of the cube
AWKWARD = {
    "yellow": "#ffff00",
    "black": "#000000",
    "near white": "#f4f6f8",
    "white": "#ffffff",
    "neon": "#39ff14",
    "the review's yellow": "#f5b800",
    "the review's pastel": "#f9c6d0",
    "mid grey": "#808080",
    "orange": "#ff6600",
}


def _pairs(colors: EmailColors) -> dict[str, float]:
    """Every pair of text and background the templates draw with the brand colours, with its contrast."""
    strong, link, accent, on_accent, card, tint = (
        value.lower()
        for value in (colors.strong, colors.link, colors.accent, colors.on_accent, colors.card, colors.tint)
    )
    return {
        "the primary button's text on its surface": contrast(
            colors.on_surface.lower(), colors.surface.lower()
        ),
        "the edge of a button on the white card": contrast(strong, WHITE),
        "the word mark, the pill's text and an outline button on white": contrast(link, WHITE),
        "the pill's text on the tint": contrast(link, tint),
        "the pass button's text on the accent": contrast(on_accent, accent),
        "the pass card's label and the steps' figures on the card": contrast(accent, card),
        "white on the pass card": contrast(WHITE, card),
        "the pass card's small print": contrast(CARD_MUTED, card),
        "a notice's text on the tint": contrast(BODY, tint),
        "a notice's strong text on the tint": contrast(INK, tint),
        "muted text on the tint": contrast(MUTED, tint),
    }


# ---- colours ----------------------------------------------------------------------------------------


def test_the_product_s_colours_read_in_every_pair() -> None:
    pairs = _pairs(DEFAULT_COLORS)
    assert all(ratio >= 4.5 for ratio in pairs.values()), pairs
    # The figures the design documents (B10-17).
    assert round(pairs["the primary button's text on its surface"], 2) == 4.70
    assert round(pairs["the pass button's text on the accent"], 2) == 5.87
    assert round(pairs["white on the pass card"], 2) == 14.66


def test_every_colour_a_company_can_have_reads_in_every_pair() -> None:
    """A grid of the whole RGB cube: whatever the platform owner chooses, no text of an e-mail falls
    below 4.5:1 (and white on the pass card stays at 10:1 or more)."""
    assert len(GRID) == 4096
    for color in [*GRID, *AWKWARD.values()]:
        pairs = _pairs(colors_of(derive_palette(color)))
        failing = {name: round(ratio, 2) for name, ratio in pairs.items() if ratio < 4.5}
        assert not failing, (color, failing)
        assert pairs["white on the pass card"] >= 10, color


def test_a_company_s_colours_are_written_as_the_templates_write_colours() -> None:
    colors = colors_of(derive_palette("#7c3aed"))
    for value in (
        colors.surface,
        colors.on_surface,
        colors.strong,
        colors.link,
        colors.accent,
        colors.on_accent,
        colors.card,
        colors.card_line,
        colors.tint,
        colors.tint_edge,
    ):
        assert re.fullmatch(r"#[0-9A-F]{6}", value), value
    assert colors.strong == "#7C3AED"  # the colour itself where white already reads on it
    assert (colors.surface, colors.on_surface) == ("#7C3AED", "#FFFFFF")


def test_a_company_without_a_colour_has_the_product_s_default_colours() -> None:
    assert company_identity(_company(), None).colors is DEFAULT_COLORS
    assert company_identity(_company(brand_color="#7c3aed"), None).colors == colors_of(
        derive_palette("#7c3aed")
    )
    assert product_identity(_service().settings).colors is DEFAULT_COLORS


@pytest.mark.parametrize("language", ["ar", "en"])
def test_a_company_s_colour_is_the_colour_of_every_one_of_its_e_mails(language: str) -> None:
    """The bar of the header, the buttons, the pass card, the pill, the notices: all from the company's
    palette, and nothing of the product's teal and turquoise left."""
    company = _company(default_language=language, brand_color="#7c3aed")
    colors = colors_of(derive_palette("#7c3aed"))
    emails = _all_emails(company)
    assert len(emails) == 8  # the notices of a platform action among them (B12-22)
    for email in emails:
        html = email.html.upper()
        assert f'HEIGHT="6" BGCOLOR="{colors.surface}"' in html, email.kind  # the header's bar
        for colour in PRODUCT_COLOURS:
            assert colour not in html, (email.kind, colour)
    invitation = _all_emails(company)[0].html
    assert f'bgcolor="{colors.card}"' in invitation  # the pass card
    # The pass button: the accent with its own ink.
    button = re.search(rf'bgcolor="{colors.accent}"[^>]*>\s*<a [^>]*style="([^"]*)"', invitation)
    assert button is not None and f"color:{colors.on_accent}" in button.group(1)
    # The other language's outline button: the brand's colour as text on white.
    assert re.search(
        rf'bgcolor="#FFFFFF" class="vbo" style="[^"]*border:2px solid {colors.strong}',
        invitation,
    )


@pytest.mark.parametrize(("name", "color"), AWKWARD.items())
def test_awkward_colours_still_give_a_readable_e_mail(name: str, color: str) -> None:
    """Yellow, black, white: the e-mail is drawn with the palette's readable steps, never with white text
    on yellow or a black button label on black."""
    company = _company(brand_color=color)
    palette = derive_palette(color)
    for email in _all_emails(company):
        html = email.html
        # White text only ever sits on the strong step, the card or the QR tile's surroundings.
        for background, style in re.findall(
            r'bgcolor="(#[0-9A-Fa-f]{6})"[^>]*>\s*<a [^>]*style="([^"]*)"', html
        ):
            text = re.search(r"(?<![-\w])color:(#[0-9A-Fa-f]{6})", style)
            assert text is not None
            assert contrast(text.group(1).lower(), background.lower()) >= 4.5, (
                name,
                background,
                text.group(1),
            )
    assert contrast(WHITE, palette.strong) >= 4.5


# ---- a company's own colour on its bar and its button (B12-21) --------------------------------------


def _primary_button(html: str) -> tuple[str, str, str]:
    """(fill, edge, text colour) of the leading language's button of a password-reset e-mail."""
    button = re.search(
        r'<td align="center" bgcolor="(#[0-9A-F]{6})" class="vbn" style="[^"]*'
        r"background-color:(#[0-9A-F]{6});"
        r'border:2px solid (#[0-9A-F]{6});[^"]*">\s*<a [^>]*style="([^"]*)"',
        html,
    )
    assert button is not None
    fill, background, edge, style = button.groups()
    text = re.search(r"(?<![-\w])color:(#[0-9A-F]{6})", style)
    assert text is not None and fill == background
    return fill, edge, text.group(1)


def _reset(company: Company) -> OutgoingEmail:
    user = User(id=uuid.uuid4(), company_id=company.id, full_name="Amal Haddad", email="amal@demo.test")
    user.company = company
    return _service().queue_password_reset(user, TOKEN).email


@pytest.mark.parametrize(
    ("color", "olive"),
    [("#f5b800", "#8E6900"), ("#f9c6d0", "#90636D"), ("#39ff14", "#138100"), ("#ffffff", "#6F6F6F")],
    ids=["yellow", "pastel", "neon", "white"],
)
def test_a_light_company_s_bar_and_button_are_its_own_colour_with_dark_text(color: str, olive: str) -> None:
    """The review: a yellow company's e-mail was drawn in #8e6900, an olive brown, because white text
    needs it. Its bar and its button are now the yellow itself, with dark text on the button. What is
    written on white in the brand's colour stays the step that reads there."""
    own, ink = color.upper(), DARK_INK.upper()
    html = _reset(_company(brand_color=color)).html
    bar = f'<td height="6" bgcolor="{own}" class="vbr" style="height:6px;line-height:6px;font-size:6px;'
    assert f"{bar}background-color:{own};" in html
    assert _primary_button(html) == (own, olive, ink)
    assert contrast(DARK_INK, color) >= 4.5 > contrast(WHITE, color)
    # The pill and the word mark (on white), the other language's outline button: the strong step.
    assert f"font-weight:700;color:{olive};white-space:nowrap;" in html
    assert (
        f'bgcolor="#FFFFFF" class="vbo" style="border-radius:10px;background-color:#FFFFFF;'
        f"border:2px solid {olive};" in html
    )
    assert re.search(
        rf'font-weight:700;color:{olive};text-decoration:none;border-radius:10px;">[^<]+</a>', html
    )
    # Nothing is filled with the olive any more: it is the colour of text and of edges.
    assert f'bgcolor="{olive}"' not in html and f"background-color:{olive}" not in html
    # Every e-mail of the company has the same bar.
    for email in _all_emails(_company(brand_color=color)):
        assert f'<td height="6" bgcolor="{own}"' in email.html, email.kind


@pytest.mark.parametrize(
    ("color", "surface"),
    [("#000080", "#000080"), ("#e11d48", "#E11D48"), ("#000000", "#000000"), ("#808080", "#6F6F6F")],
    ids=["navy", "red", "black", "mid grey"],
)
def test_a_dark_company_s_bar_and_button_carry_white_text(color: str, surface: str) -> None:
    """A dark colour is its own surface under white; a mid-tone that carries neither ink is painted
    with its strong step, as before."""
    html = _reset(_company(brand_color=color)).html
    assert f'<td height="6" bgcolor="{surface}"' in html
    assert _primary_button(html) == (surface, surface, "#FFFFFF")


def test_a_company_without_a_colour_keeps_the_default_teal_bar_and_button() -> None:
    html = _reset(_company()).html
    assert '<td height="6" bgcolor="#188086"' in html
    assert _primary_button(html) == ("#188086", "#188086", "#FFFFFF")


def test_every_button_of_every_e_mail_reads_and_shows_on_white_whatever_the_colour() -> None:
    """Over a grid of the cube: the text of each button on its fill at 4.5:1, and its edge on the white
    card at 3:1 or more (the palette gives 4.5:1), so that a white company's button is still a button."""
    colours = [*GRID[::37], *AWKWARD.values()]
    assert len(colours) > 110
    for color in colours:
        company = _company(brand_color=color)
        for email in (_reset(company), _invitation(company).email):
            buttons = re.findall(
                r'bgcolor="(#[0-9A-F]{6})"(?: class="[^"]*")? style="[^"]*border:2px solid (#[0-9A-F]{6});'
                r'[^"]*">\s*<a [^>]*'
                r'style="[^"]*(?<![-\w])color:(#[0-9A-F]{6});',
                email.html,
            )
            assert len(buttons) == 2, (color, email.kind)
            for fill, edge, text in buttons:
                assert contrast(text.lower(), fill.lower()) >= 4.5, (color, fill, text)
                # On the white card the edge shows; on the dark pass card the fill itself does.
                shows = contrast(edge.lower(), WHITE) >= 3 or fill == colors_of(derive_palette(color)).accent
                assert shows, (color, fill, edge)


# ---- nothing of the product in a company's e-mail ---------------------------------------------------


@pytest.mark.parametrize("language", ["ar", "en"])
@pytest.mark.parametrize("with_logo", [True, False], ids=["with a logo", "without a logo"])
def test_no_e_mail_of_a_company_names_or_shows_the_product(language: str, with_logo: bool) -> None:
    """B12-12: not in the subject, the sender, either body, an image's text alternative or an attachment;
    for every e-mail a company's people and visitors receive, in both leading languages."""
    company = _company(default_language=language)  # Acme Holding / أكمي القابضة
    # EMAIL_FROM is "Demo Visitors <visitors@demo.test>": the product's display name is not the sender's.
    service = _service(logos=CompanyLogos(SAMPLE_LOGO, 240, 80)) if with_logo else _service()
    emails = _all_emails(company, service)
    # The four visit e-mails, the two about a password, the two notices of a platform action (B12-22).
    assert [email.kind.value for email in emails] == [
        "VISITOR_INVITATION",
        "VISIT_RESCHEDULED",
        "VISIT_CANCELLED",
        "HOST_ARRIVAL",
        "PASSWORD_RESET",
        "PASSWORD_CHANGED",
        "PLATFORM_ACTION_NOTICE",
        "PLATFORM_ACTION_NOTICE",
    ]
    for email in emails:
        for part in (email.subject, email.sender, email.html, email.text):
            for word in PRODUCT_WORDS:
                assert word not in part, (email.kind, word)
        assert "on behalf of" not in email.text and "نيابةً عن" not in email.text
        assert brand_logo().content not in [image.content for image in email.inline_images]
        assert email.sender.endswith("<visitors@demo.test>")  # the configured address, always
        attached = {image.content_id for image in email.inline_images}
        assert (LOGO_CONTENT_ID in attached) is with_logo


@pytest.mark.parametrize("action", ["admin_added", "reset_sent"])
@pytest.mark.parametrize("language", ["ar", "en"])
def test_the_notice_of_a_platform_action_shows_the_company_and_nothing_of_the_product(
    language: str, action: str
) -> None:
    """B12-22. The notice to a company's administrators carried the Mawdoo3 logo on the teal band, a
    text part that began «زوار موضوع | Mawdoo3 Visitors» and "Sent by Mawdoo3 Visitors on behalf of …".
    It is the company's e-mail: its logo, its colours, its name as the sender, "Sent by <company>."."""
    company = _company(default_language=language, brand_color="#7c3aed")
    notice = _platform_notice(company, _service(logos=CompanyLogos(SAMPLE_LOGO, 240, 80)), action)
    html = notice.html.upper()
    # The bar, and the white header around a plated logo (B13-2).
    assert 'HEIGHT="6" BGCOLOR="#7C3AED"' in html and 'BGCOLOR="#FFFFFF" CLASS="VPP VSF"' in html
    assert 'BGCOLOR="#188086"' not in html and 'HEIGHT="4" BGCOLOR="#27B5BB"' not in html  # no teal band
    for colour in PRODUCT_COLOURS:
        assert colour not in html, colour
    name = "أكمي القابضة" if language == "ar" else "Acme Holding"
    assert notice.sender == f'"{name}" <visitors@demo.test>'
    assert [image.content for image in notice.inline_images] == [light_rendition(SAMPLE_LOGO).content]
    assert brand_logo().content != SAMPLE_LOGO
    assert f'alt="{name}"' in notice.html
    text = _read(notice.text)
    assert text.startswith(
        "أكمي القابضة | Acme Holding\n" if language == "ar" else "Acme Holding | أكمي القابضة\n"
    )
    assert "Sent by Acme Holding." in text and "أُرسلت من أكمي القابضة." in text
    for part in (notice.subject, notice.sender, notice.html, notice.text):
        for word in PRODUCT_WORDS:
            assert word not in part, word
        assert "on behalf of" not in part and "نيابةً عن" not in part
    # It still says who acted, by role.
    assert "The platform owner" in text and "مالك المنصة" in text
    # Without a logo the company's name heads it, as in its other e-mails.
    plain = _platform_notice(company, action=action)
    assert plain.inline_images == () and "cid:" not in plain.html
    assert re.search(
        rf'<span dir="(?:ltr|rtl)" class="vlk" style="[^"]*font-weight:700;[^"]*">{name}</span>',
        plain.html,
    )


def test_the_cli_s_test_e_mail_is_the_one_message_that_keeps_the_product_s_identity() -> None:
    """It goes to whoever runs the deployment, never to a company's people."""
    settings = _service().settings
    email = build_test_email(settings, EmailRenderer(), "ops@example.com", now=START)
    assert 'BGCOLOR="#188086" CLASS="VPX"' in email.html.upper()  # the teal band with the logo
    assert brand_logo().content in [image.content for image in email.inline_images]
    assert email.sender == "Demo Visitors <visitors@demo.test>"  # EMAIL_FROM as configured
    assert "Mawdoo3 Visitors" in email.text and "أُرسلت عبر زوار موضوع." in _read(email.text)
    assert product_identity(settings).product and not company_identity(_company(), None).product


def test_a_company_s_name_in_the_header_is_text_and_nothing_else() -> None:
    """The word mark and the logo's text alternative are a company's name, which its administrators
    choose: escaped like every other value."""
    hostile = '"><img src=x onerror=alert(1)><b>Acme</b>'
    company = _company(name=hostile, name_ar=None)
    for service in (_service(), _service(logos=CompanyLogos(SAMPLE_LOGO, 240, 80))):
        for email in _all_emails(company, service):
            assert "<img src=x" not in email.html and "<b>Acme</b>" not in email.html
            assert "onerror=alert(1)&gt;" in email.html  # there, as text
            # No attribute was closed early: every image of the document is one the service attached.
            sources = set(re.findall(r'<img src="([^"]*)"', email.html))
            assert sources == {f"cid:{image.content_id}" for image in email.inline_images}


def test_a_long_company_name_is_set_smaller_in_the_header() -> None:
    short = _invitation(_company(name="Acme", name_ar=None)).email.html
    long = _invitation(
        _company(name="The International Company for Visitor Reception", name_ar=None)
    ).email.html
    assert "font-size:20px;line-height:28px;font-weight:700" in short
    assert "font-size:16px;line-height:22px;font-weight:700" in long


# ---- the sender ------------------------------------------------------------------------------------


def test_a_visitor_e_mail_is_sent_in_the_company_s_name_in_its_leading_language() -> None:
    english = _invitation(_company(default_language="en")).email
    arabic = _invitation(_company(default_language="ar")).email
    assert english.sender == '"Acme Holding" <visitors@demo.test>'
    assert arabic.sender == '"أكمي القابضة" <visitors@demo.test>'
    # A company without an Arabic name is named by its only name in both.
    assert _invitation(_company(name_ar=None, default_language="ar")).email.sender == english.sender


def test_a_staff_e_mail_is_sent_in_the_company_s_name_in_the_recipient_s_language() -> None:
    company = _company(default_language="en")
    service = _service()

    def reset(language: str | None) -> OutgoingEmail:
        user = User(
            id=uuid.uuid4(),
            company_id=company.id,
            full_name="Amal Haddad",
            email="amal@demo.test",
            preferred_language=language,
        )
        user.company = company
        return service.queue_password_reset(user, TOKEN).email

    assert reset("ar").sender == '"أكمي القابضة" <visitors@demo.test>'
    assert reset("en").sender == reset(None).sender == '"Acme Holding" <visitors@demo.test>'


@pytest.mark.parametrize(
    ("name", "shown"),
    [
        ("Acme Corp", "Acme Corp"),
        ("Acme, Inc. (Amman)", "Acme, Inc. (Amman)"),
        ("موضوع", "موضوع"),
        ("  Acme   Corp  ", "Acme Corp"),
        # What delimits a mailbox cannot be part of a name ...
        ('Acme" <ceo@evil.test>', "Acme ceo evil.test"),
        ("Acme <ceo@evil.test>", "Acme ceo evil.test"),
        ("Acme\\", "Acme"),
        ('"', ""),
        # ... a name does not read as an address of its own ...
        ("security@bank.example", "security bank.example"),
        # ... in any form of those characters that Unicode treats as the same for compatibility: the
        # fullwidth and the small "@" (the security review's two names, B12-20) ...
        ("support\N{FULLWIDTH COMMERCIAL AT}paypal.com", "support paypal.com"),
        ("service\N{SMALL COMMERCIAL AT}bank.example", "service bank.example"),
        (
            "Bank \N{FULLWIDTH LESS-THAN SIGN}ceo\N{FULLWIDTH COMMERCIAL AT}bank.example"
            "\N{FULLWIDTH GREATER-THAN SIGN}",
            "Bank ceo bank.example",
        ),
        ("Bank \N{SMALL LESS-THAN SIGN}ceo\N{SMALL GREATER-THAN SIGN}", "Bank ceo"),
        ("\N{FULLWIDTH QUOTATION MARK}Bank\N{FULLWIDTH QUOTATION MARK}", "Bank"),
        ("Bank\N{FULLWIDTH REVERSE SOLIDUS}\N{SMALL REVERSE SOLIDUS}", "Bank"),
        ("a\N{FULLWIDTH COMMERCIAL AT}\N{SMALL COMMERCIAL AT}@b", "a b"),
        # ... nor carry a second header, a hidden direction or an encoded word.
        ("Acme\r\nBcc: victim@evil.test", "Acme Bcc: victim evil.test"),
        ("Acme\N{LINE SEPARATOR}Bcc: x", "Acme Bcc: x"),
        ("Acme\N{RIGHT-TO-LEFT OVERRIDE}proC", "AcmeproC"),
        ("=?utf-8?q?Acme=0D=0ABcc:_x?=", "= ?utf-8?q?Acme=0D=0ABcc:_x?="),
        ("\t", ""),
    ],
)
def test_a_sender_s_name_is_only_ever_a_name(name: str, shown: str) -> None:
    assert display_name(name) == shown
    sender = sender_named("Mawdoo3 Visitors <no-reply@visitors.test>", name)
    assert sender == (f'"{shown}" <no-reply@visitors.test>' if shown else "no-reply@visitors.test")
    assert "\r" not in sender and "\n" not in sender
    # Every provider reads one mailbox out of it: this name, the configured address.
    mailbox = _mailbox(sender)
    assert mailbox is not None
    assert (mailbox.display_name, mailbox.addr_spec) == (shown, "no-reply@visitors.test")


@pytest.mark.parametrize(
    "name",
    [
        "\N{FULLWIDTH LATIN CAPITAL LETTER A}cme \N{PARENTHESIZED IDEOGRAPH STOCK}",
        "Caf\N{LATIN SMALL LETTER E}\N{COMBINING ACUTE ACCENT} \N{LATIN SMALL LIGATURE FI}n",
        "\N{ARABIC LETTER SHEEN}\N{ARABIC LETTER REH}\N{ARABIC LETTER KAF}\N{ARABIC LETTER TEH MARBUTA}"
        " \N{ARABIC LIGATURE ALLAH ISOLATED FORM}",
        "\N{HALFWIDTH KATAKANA LETTER KA}\N{HALFWIDTH KATAKANA VOICED SOUND MARK}",
        "Acme \N{NOT LESS-THAN} \N{NOT EQUAL TO} Co",
        "\N{FULLWIDTH EQUALS SIGN}\N{FULLWIDTH QUESTION MARK}utf-8\N{FULLWIDTH QUESTION MARK}",
    ],
)
def test_every_other_character_of_a_sender_s_name_stays_as_it_was_typed(name: str) -> None:
    """Only the five characters are judged by their compatibility form. The name is not normalised: a
    fullwidth letter, a ligature or a half-width kana stays what the company typed, so the sender's name
    is the name the e-mail itself shows. (A sign that only contains the shape of "<" is not one.)"""
    assert display_name(name) == name
    assert normalize("NFKC", name) != name or "\N{NOT LESS-THAN}" in name
    mailbox = _mailbox(sender_named("no-reply@visitors.test", name))
    assert mailbox is not None
    assert (mailbox.display_name, mailbox.addr_spec) == (name, "no-reply@visitors.test")


def test_a_sender_s_name_is_bounded() -> None:
    shown = display_name("A" * 500)
    assert len(shown) == SENDER_NAME_MAX_LENGTH and shown.endswith("\N{HORIZONTAL ELLIPSIS}")
    mailbox = _mailbox(sender_named("no-reply@visitors.test", "ش" * 500))
    assert mailbox is not None and mailbox.addr_spec == "no-reply@visitors.test"
    assert len(mailbox.display_name) == SENDER_NAME_MAX_LENGTH


def test_the_sender_s_address_is_always_the_configured_one() -> None:
    assert sender_named("no-reply@visitors.test", "Acme") == '"Acme" <no-reply@visitors.test>'
    assert sender_named('"Old, Name" <no-reply@visitors.test>', "Acme") == '"Acme" <no-reply@visitors.test>'
    # A sender without an address is not made into one: the provider refuses it, as before.
    assert sender_named("not an address", "Acme") == "not an address"
    assert sender_named("", "Acme") == ""


def test_a_hostile_company_name_reaches_no_header_through_the_sender() -> None:
    company = _company(name='Evil" <ceo@bank.example>\r\nBcc: victim@evil.test', name_ar=None)
    email = _invitation(company).email
    assert email.sender == '"Evil ceo bank.example Bcc: victim evil.test" <visitors@demo.test>'
    mailbox = _mailbox(email.sender)
    assert mailbox is not None and mailbox.addr_spec == "visitors@demo.test"


# The five characters a sender's name never holds: what delimits a mailbox, and the "@" of an address.
DELIMITERS = frozenset('<>"@\\')
# Every code point but the surrogates, which are no characters.
CODE_POINTS = [chr(point) for point in range(0x110000) if not 0xD800 <= point <= 0xDFFF]


def test_the_compatibility_forms_of_the_delimiters_are_the_known_ones() -> None:
    """The characters that normalising (NFKC) turns into one of the five. A Unicode version that adds
    one is caught by the next test whatever this list says; this one says which they are today."""
    forms = {
        character: normalize("NFKC", character)
        for character in CODE_POINTS
        if DELIMITERS & set(normalize("NFKC", character)) and character not in DELIMITERS
    }
    assert forms == {
        "\N{SMALL LESS-THAN SIGN}": "<",
        "\N{SMALL GREATER-THAN SIGN}": ">",
        "\N{SMALL REVERSE SOLIDUS}": "\\",
        "\N{SMALL COMMERCIAL AT}": "@",
        "\N{FULLWIDTH QUOTATION MARK}": '"',
        "\N{FULLWIDTH LESS-THAN SIGN}": "<",
        "\N{FULLWIDTH GREATER-THAN SIGN}": ">",
        "\N{FULLWIDTH COMMERCIAL AT}": "@",
        "\N{FULLWIDTH REVERSE SOLIDUS}": "\\",
    }


def test_no_character_makes_a_sender_s_name_read_as_an_address() -> None:
    """Every code point there is: whatever a name is made of, neither the sender's name nor its
    normalised form holds one of the five, a line break or a direction control; and the mailbox every
    provider reads out of the sender is this name at the configured address."""
    unwanted = DELIMITERS | set("\r\n\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}\N{NEXT LINE}")
    unwanted |= {chr(point) for point in (*range(0x202A, 0x202F), *range(0x2066, 0x206A))}

    def survives(name: str) -> bool:
        shown = display_name(name)
        return bool(unwanted & set(shown) or unwanted & set(normalize("NFKC", shown)))

    # Names of 64 code points each (a name may be longer): one of them that came through, as typed or
    # once normalised, shows in the name whatever stands beside it.
    for start in range(0, len(CODE_POINTS), 64):
        batch = CODE_POINTS[start : start + 64]
        if survives("".join(batch)):
            culprits = [f"U+{ord(character):04X}" for character in batch if survives(f"a{character}b")]
            pytest.fail(f"in a sender's name: {culprits or batch}")
    # ... and one at a time between two letters, where the compatibility forms are (the blocks up to
    # the CJK symbols, and the presentation, small and fullwidth forms at the end of the first plane).
    kept_as_typed = 0
    alone = [*CODE_POINTS[:0x3100], *(chr(point) for point in range(0xF900, 0x10000))]
    for character in alone:
        assert not survives(f"a{character}b"), f"U+{ord(character):04X}"
        kept_as_typed += display_name(f"a{character}b") == f"a{character}b"
    # Nearly every character is kept as typed: the rule is about five characters, not about scripts.
    assert kept_as_typed > len(alone) - 200
    for character in ("\N{FULLWIDTH COMMERCIAL AT}", "\N{SMALL COMMERCIAL AT}", "@"):
        sender = sender_named("no-reply@visitors.test", f"support{character}bank.example")
        assert sender == '"support bank.example" <no-reply@visitors.test>'
        mailbox = _mailbox(sender)
        assert mailbox is not None
        assert (mailbox.display_name, mailbox.addr_spec) == ("support bank.example", "no-reply@visitors.test")


@pytest.mark.parametrize(
    "name",
    [
        "support\N{FULLWIDTH COMMERCIAL AT}paypal.com",
        "Bank\N{RIGHT-TO-LEFT OVERRIDE} \N{SMALL COMMERCIAL AT}\r\nBcc: x",
        "=?utf-8?q?x?= \N{FULLWIDTH LESS-THAN SIGN}a@b\N{FULLWIDTH GREATER-THAN SIGN}",
        "A" * 500,
        "\N{FULLWIDTH COMMERCIAL AT}" * 500,
    ],
)
def test_a_sender_s_name_is_finished_once(name: str) -> None:
    assert display_name(display_name(name)) == display_name(name)


@pytest.mark.parametrize("at", ["\N{FULLWIDTH COMMERCIAL AT}", "\N{SMALL COMMERCIAL AT}", "@"])
def test_a_company_named_like_an_address_sends_under_a_name_that_is_none(at: str) -> None:
    """The security review's case (B12-20): a company's administrator names the company "support",
    U+FF20 FULLWIDTH COMMERCIAL AT, "paypal.com". Its e-mails still say so where they show the company
    (a company chooses its name); the sender's name does not read as an address, and the address is the
    deployment's."""
    company = _company(name=f"support{at}paypal.com", name_ar=None, default_language="en")
    email = _invitation(company).email
    assert email.sender == '"support paypal.com" <visitors@demo.test>'
    mailbox = _mailbox(email.sender)
    assert mailbox is not None
    assert (mailbox.display_name, mailbox.addr_spec) == ("support paypal.com", "visitors@demo.test")
    assert f"support{at}paypal.com" in email.subject  # the name itself is the company's to choose


# ---- links -----------------------------------------------------------------------------------------


def test_the_links_of_a_company_s_e_mails_name_the_company_and_keep_tokens_in_the_fragment() -> None:
    company = _company(slug="acme-holding")
    service = _service()
    user = User(id=uuid.uuid4(), company_id=company.id, full_name="Amal Haddad", email="amal@demo.test")
    user.company = company
    invitation = service.queue_visitor_invitation(
        _visit(company), TOKEN, company=company, recipient="d@example.com", host_email=HOST_EMAIL
    ).email
    reset = service.queue_password_reset(user, TOKEN).email
    changed = service.queue_password_changed(user, how="changed", when=START, ip_address=None).email
    assert invitation.pass_url == f"https://vms.test/pass?c=acme-holding#{TOKEN}"
    assert reset.reset_url == f"https://vms.test/reset-password?c=acme-holding#token={TOKEN}"
    for email, link in ((invitation, invitation.pass_url), (reset, reset.reset_url)):
        assert link is not None
        assert email.html.count(f'href="{link}"') == 2 and email.text.count(link) == 2
        # The token appears only as the fragment of those links.
        for body in (email.html, email.text):
            assert body.count(TOKEN) == body.count(link)
            assert f"?c=acme-holding#{TOKEN}" in body or f"?c=acme-holding#token={TOKEN}" in body
    # The notice of a changed password points to the company's own page for a new link.
    forgot = "https://vms.test/forgot-password?c=acme-holding"
    assert changed.html.count(f'href="{forgot}"') == 2 and forgot in _read(changed.text)
    assert "#" not in forgot


def test_a_company_s_e_mail_says_who_sent_it_once_per_language() -> None:
    company = Company(
        id=uuid.uuid4(),
        name="Acme",
        name_ar="أكمي",
        slug="acme",
        timezone="Asia/Amman",
        default_language="en",
    )
    email = _invitation(company).email
    assert _read(email.text).endswith("--\nSent by Acme.\nأُرسلت من أكمي.\n")
    footer = _plain(email.html[email.html.rindex('bgcolor="#F8F8F8"') :])
    assert footer.count("Sent by Acme.") == 1 and footer.count("أُرسلت من أكمي.") == 1
