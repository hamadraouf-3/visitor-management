"""The e-mails in mawdoo3.com's palette (Phase 10, B10-17): the teal header with the white logo baked onto
it, turquoise only behind dark text, slate text, the yellow pill for changes to notice, and no colour of
the earlier navy design left; the explanatory filler removed (B10-19).

Since Phase 12 (B12-12) that palette is the product's own and the default of a company without a colour:
the e-mails here are those of such a company (a teal bar over a white header that names it), and the
product's own test e-mail (the teal band with the logo). A company's own colours:
tests/unit/test_email_identity.py."""

import functools
import importlib.util
import re
import struct
import zlib
from pathlib import Path

import pytest

from app.email.providers.base import OutgoingEmail
from app.email.rendering import EmailRenderer
from app.email.service import LOGO_FILE, _logo_png, brand_logo, build_test_email
from app.models import User
from tests.unit.test_email_templates import _company, _invitation, _service, _visit

REPO_ROOT = Path(__file__).resolve().parents[3]
HEADER_TEAL = (0x18, 0x80, 0x86)
# Colours of the design before mawdoo3.com's palette (B10-6): navy ink, the old button and link teals.
RETIRED_COLOURS = ("#0B1A22", "#0B1020", "#0F7675", "#0B5F5E", "#169897", "#3A4152", "#5A6275", "#EEF1F4")


def _rgb_rows(data: bytes) -> tuple[int, int, list[bytes]]:
    """Width, height and rows of an 8-bit RGB PNG (what the packaged logo is)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    position, idat, header = 8, b"", None
    while position < len(data):
        length, kind = struct.unpack(">I4s", data[position : position + 8])
        body = data[position + 8 : position + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        position += 12 + length
    assert header is not None
    width, height, depth, colour, _compression, _filter, interlace = header
    assert (depth, colour, interlace) == (8, 2, 0), "an opaque 8-bit RGB image"
    raw, stride, rows, previous = zlib.decompress(idat), width * 3, [], bytearray(width * 3)
    for y in range(height):
        kind = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for x in range(stride):
            left, up = (line[x - 3] if x >= 3 else 0), previous[x]
            up_left = previous[x - 3] if x >= 3 else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                p = left + up - up_left
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - up_left)
                line[x] = (line[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else up_left)) & 0xFF
        rows.append(bytes(line))
        previous = line
    return width, height, rows


def test_the_logo_is_the_white_wordmark_on_the_header_teal() -> None:
    """Opaque, the logo's own size, and every pixel a mix of white and the header's teal, so the image
    blends into the header and stays readable where a client recolours the band."""
    width, height, rows = _rgb_rows(_logo_png())
    assert (width, height) == (462, 149)
    pixels = [tuple(row[x : x + 3]) for row in rows for x in range(0, len(row), 3)]
    assert pixels[0] == pixels[width - 1] == pixels[-1] == HEADER_TEAL
    white = 0
    for pixel in pixels:
        alpha = (pixel[0] - HEADER_TEAL[0]) / (255 - HEADER_TEAL[0])
        for channel in range(3):
            expected = HEADER_TEAL[channel] + alpha * (255 - HEADER_TEAL[channel])
            assert abs(pixel[channel] - expected) <= 1.5, pixel
        white += pixel == (255, 255, 255)
    assert white > 5_000  # the wordmark is there
    assert brand_logo().filename == LOGO_FILE


def test_the_packaged_logo_is_what_the_generator_writes() -> None:
    """scripts/email_logo.py rebuilds it from frontend/public/brand/logo-white.png; a changed source or
    header colour must be regenerated (skipped where the frontend is not checked out)."""
    script = REPO_ROOT / "scripts" / "email_logo.py"
    if not (REPO_ROOT / "frontend" / "public" / "brand" / "logo-white.png").is_file():
        pytest.skip("the frontend's brand files are not here")
    spec = importlib.util.spec_from_file_location("email_logo", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.EMAIL_HEADER_TEAL == HEADER_TEAL
    assert module.build() == _logo_png()


@functools.cache
def _all_emails(language: str = "en") -> dict[str, OutgoingEmail]:
    """Every template once per leading language (rendering them all takes about a second)."""
    company = _company(default_language=language)
    service = _service()
    visit = _visit(company, check_in_at=_visit(company).scheduled_start)
    host = User(
        id=visit.host_id,
        company_id=company.id,
        company=company,
        email="host@demo.test",
        full_name="Omar Khalil",
        preferred_language=company.default_language,
    )
    return {
        "invitation": _invitation(company).email,
        "rescheduled": service.queue_visit_rescheduled(
            visit, company=company, recipient="d@example.com", host_email=None
        ).email,
        "cancelled": service.queue_visit_cancelled(
            visit, "Host travelling", company=company, recipient="d@example.com", host_email=None
        ).email,
        "arrival": service.queue_host_arrival(visit, company=company, host=host).email,
        "reset": service.queue_password_reset(host, "T" * 43).email,
        "changed": service.queue_password_changed(
            host, how="changed", when=visit.scheduled_start, ip_address=None
        ).email,
        "test": build_test_email(
            service.settings, EmailRenderer(), "admin@example.com", now=visit.scheduled_start
        ),
    }


@pytest.mark.parametrize("language", ["ar", "en"])
def test_every_e_mail_uses_the_mawdoo3_palette(language: str) -> None:
    for kind, email in _all_emails(language).items():
        html = email.html.upper()
        if kind == "test":
            # The product's own header: the teal band (the logo's own teal) and the turquoise rule.
            assert 'BGCOLOR="#188086" CLASS="VPX"' in html
            assert 'HEIGHT="4" BGCOLOR="#27B5BB"' in html
        else:
            # A company without a colour: the same teal as a bar over its white header (B12-12).
            assert 'HEIGHT="6" BGCOLOR="#188086"' in html, kind
            assert 'BGCOLOR="#FFFFFF" CLASS="VPX VSF"' in html, kind
        for colour in RETIRED_COLOURS:
            assert colour not in html, (kind, colour)
        # Turquoise is a fill behind dark text only: white text never sits on it.
        for button in re.findall(r'BGCOLOR="#27B5BB"[^>]*>\s*<A [^>]*STYLE="([^"]*)"', html):
            assert "COLOR:#1E2A32" in button.replace(" ", ""), kind
    # The visitor pass is the dark card with the turquoise label and button.
    invitation = _all_emails(language)["invitation"].html.upper()
    assert 'BGCOLOR="#1E2A32"' in invitation and 'BGCOLOR="#27B5BB"' in invitation


@pytest.mark.parametrize(
    ("kind", "attention"),
    [
        ("invitation", False),
        ("rescheduled", True),
        ("cancelled", True),
        ("arrival", False),
        ("reset", False),
        ("changed", True),
        ("test", False),
    ],
)
def test_changes_to_notice_have_the_yellow_pill(kind: str, attention: bool) -> None:
    html = _all_emails()[kind].html
    pill = re.search(
        r'<span lang="[a-z]{2}"(?: class="vpl")? style="display:inline-block;padding:5px 12px;[^"]*"',
        html,
    )
    assert pill is not None
    assert ("background-color:#F7B916" in pill.group(0)) is attention
    assert ("color:#1E2A32" if attention else "color:#146E73") in pill.group(0)
    if not attention:
        # Teal text on white (the product's band) or on the light turquoise (a company's white header).
        background = "#FFFFFF" if kind == "test" else "#E5F6F7"
        assert f"background-color:{background}" in pill.group(0)


def test_the_cancelled_visit_and_the_security_notice_say_what_no_longer_holds_in_a_yellow_notice() -> None:
    emails = _all_emails()
    for kind, sentence in (
        ("cancelled", "Your visitor pass for this visit is no longer valid."),
        ("changed", "If you did not make this change, reset your password now and tell your administrator."),
    ):
        notice = re.search(r'bgcolor="#FEF5DC"[^>]*>\s*<strong[^>]*>([^<]*)</strong>', emails[kind].html)
        assert notice is not None and notice.group(1) == sentence, kind
