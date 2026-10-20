"""Business-facing e-mail API (contract §9).

Each `queue_*` method renders the message, inserts its `email_messages` row (PENDING) in the caller's
transaction and returns a `DeliveryJob`. The caller commits and only then schedules
`EmailDispatcher.deliver(job)` (see `schedule_delivery`), so a job never refers to uncommitted data.
Rendered bodies are never stored: an invitation carries the raw pass token.

Replies (B24-71): a deployment that sets EMAIL_REPLY_TO routes every reply to that mailbox. Otherwise a
visitor's reply to a visit e-mail reaches the host (Reply-To: the active host's address), so a visitor
who has a question or is running late can reach someone. Only messages without a Reply-To ask the
reader not to reply.

Languages (Phase 10, B10-7 to B10-9): every message is in Arabic and English, the leading language first.
E-mails to visitors lead with the company's `default_language` and carry both languages in the subject;
e-mails to staff (host arrival, password reset and change, the notice of a platform action) lead with
the recipient's `preferred_language`, else the company's, and their subject is in that language only.
Every subject is finished by `headers.subject_line` (one line, no direction controls, no encoded word, at
most 250 characters; B11-40, B11-41), and a bilingual one gives each language its share. A subject that is
too long gives up some of the company's name before anything else (`subject_within`, B12-24): the name is
cut short where it stands, so the date after it stays and each language's half is still a whole sentence.
The Arabic text names the company by `name_ar` when it is set, and the visit's department and the
company's address by their Arabic values when they are set (B10-26); the English text by `name`, the
department's name and `address`.

Identity (Phase 12, B12-12; `app.email.identity`): a company's e-mails are that company's and nothing
else. Its logo heads them inline (`cid:brand-logo`), or its name as a word mark while it has no logo; its
colours come from the palette of its colour, or the product's teal while it has none; the sender's
display name is the company's (the address stays EMAIL_FROM's: `headers.sender_named`); the footer says
"Sent by <company>." and the plain-text part starts with its name. Nothing in them names the product or
shows the Mawdoo3 logo. That covers **every e-mail a company's people and visitors receive**: every visit
e-mail, the password reset and the password notice of a company's users, the previews and test e-mails of
its texts, and (B12-22) the notice to its administrators of what the platform owner did.

The product's own identity (B10-16, B10-17) is left on one message, which goes to whoever runs the
deployment and to nobody of a company: the test e-mail of `python -m app.cli send-test-email`. There the
PRODUCT (PRODUCT_NAME_AR / PRODUCT_NAME_EN, «زوار موضوع» / Mawdoo3 Visitors) is who sends the message:
the footer says "Sent by Mawdoo3 Visitors", the plain-text part starts with it, and EMAIL_FROM's name is
it; the logo that heads it is the BRAND's (BRAND_NAME_AR / BRAND_NAME_EN, the logo's text alternative).

Links (B12-14): a pass link and a reset link name the company (`?c=<slug>`), so the page they open shows
that company before anyone signs in. The token stays in the fragment, alone.

Light and dark (Phase 13, B13-1 to B13-5): every e-mail carries a light design and a dark one, for the
clients that honour `prefers-color-scheme`. A company's logo is never sent as it was stored: its
renditions are (`app.email.logos`), an opaque light one on a white plate (`cid:brand-logo`) and, when the
company has a logo for dark surfaces, an opaque dark one that only the dark design shows
(`cid:brand-logo-dark`). A preview shows one design alone (`scheme`): "light", the e-mail as a client
in light mode shows it, or "dark", with its dark rules applied, as a client in dark mode shows it.

Calendars (Phase 14, B14-1 to B14-12; `app.email.calendar`): the visit e-mails carry the visit as a
calendar event, so it is in the visitor's and in the host's calendar, moves when the visit gets a new time
and goes when it is cancelled. The visitor's calendar invitation (VISITOR_CALENDAR, the short e-mail
that follows every invitation) and notice of a new time carry an iTIP REQUEST, the notice of the
cancellation a CANCEL, all with the `UID` of the visitor's event; the host's three e-mails (a new visit,
its new time, its cancellation: `HOST_VISIT_*`) do the same for the host's event. Each carries the
visit's `calendar_sequence` as its `SEQUENCE`. The event is written in the e-mail's leading language and
never holds the pass link or a token (B14-4); and the invitation itself carries none (B14-10), because
Outlook keeps the text of the e-mail that carries an event, pass link and QR code included, in the
calendar entry. The host's event is private (B14-19). No event goes to the sending mailbox itself, its
organizer (B14-5; in any spelling of its address, B14-21), nor with a test e-mail of a company's texts:
its visit exists nowhere. An address the visitor no longer has is sent the withdrawal of the visitor's
event (a VISITOR_CALENDAR message whose CANCEL says nothing of the visit, B14-17).
"""

import logging
import re
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from email.utils import parseaddr
from functools import cache
from importlib import resources
from typing import Any, Literal, Protocol
from urllib.parse import quote

import idna
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.config import Settings
from app.core.palette import derive_palette
from app.core.png import PngError
from app.core.qr import qr_png
from app.core.text import validate_email_address
from app.email.calendar import (
    CalendarMailbox,
    CalendarMethod,
    CalendarRole,
    VisitEvent,
    calendar_part,
    event_uid,
)
from app.email.editable import Texts, Variables, render_subject, usable_texts
from app.email.formatting import VisitTimes, format_date, format_time, timezone_label
from app.email.headers import (
    SUBJECT_MAX_LENGTH,
    cut_short,
    sanitize_header,
    sender_named,
    shorten,
    subject_line,
)
from app.email.i18n import Sentence, as_language, minutes, other_language, translate
from app.email.identity import DEFAULT_COLORS, Identity, colors_of, dark_colors_of, fitted
from app.email.logos import PLATE, Rendition, dark_rendition, is_mark, light_rendition
from app.email.providers.base import InlineImage, OutgoingEmail
from app.email.rendering import COMMA, LOGO_HEIGHT, LOGO_WIDTH, EmailRenderer, RenderedEmail, Scheme
from app.models import (
    BrandAssetKind,
    Company,
    EmailKind,
    EmailMessage,
    EmailStatus,
    Language,
    TemplateField,
    User,
    Visit,
)
from app.repositories.brand import BrandImage, CompanyBrandRepository
from app.repositories.email_messages import EmailMessageRepository
from app.repositories.email_templates import EmailTemplateOverrideRepository, TemplateTexts
from app.security.tokens import build_pass_url

PASSWORD_RESET_TTL = timedelta(minutes=30)
PasswordChange = Literal["changed", "reset"]
# What the platform owner did to an administrator account of a company, as the notice to the company's
# other administrators names it (B11-43): added the account, or sent it a password-reset link.
PlatformAction = Literal["admin_added", "reset_sent"]
# The inline QR image of an invitation, referenced from the HTML as `cid:visitor-pass-qr`.
QR_CONTENT_ID = "visitor-pass-qr"
# The logo in the header of a message, referenced as `cid:brand-logo` (B10-6): a company's own in its
# e-mails, the product's in the CLI's test e-mail (B12-12, B12-22). Since Phase 13 a company's is the
# light rendition of its logo, and the dark design shows the rendition of its logo for dark surfaces,
# `cid:brand-logo-dark`, when it has one (B13-2).
LOGO_CONTENT_ID = "brand-logo"
LOGO_FILE = "brand-logo.png"
LOGO_DARK_CONTENT_ID = "brand-logo-dark"
LOGO_DARK_FILE = "brand-logo-dark.png"
# The fragment of the sample QR code in a test e-mail: shaped like a pass link, and no pass token.
TEST_EMAIL_SAMPLE_FRAGMENT = "sample-not-a-visitor-pass"
# Between the two languages of a visitor e-mail's subject.
SUBJECT_SEPARATOR = " | "
# The least of a company's name that a subject still shows when it has to shorten the name, the ellipsis
# included (`subject_within`).
SUBJECT_NAME_MIN = 12
# Before the subject of a test e-mail of a company's texts (B11-29), in the language that leads it.
TEST_SUBJECT_PREFIX = {Language.AR: "[رسالة تجريبية] ", Language.EN: "[Test] "}
LANGUAGES = (Language.AR, Language.EN)
# The host's three e-mails of a scheduled visit (B14-2): the catalog's prefix of each, and the iTIP method
# of the event it carries.
HOST_VISIT_KINDS: dict[EmailKind, tuple[str, CalendarMethod]] = {
    EmailKind.HOST_VISIT_SCHEDULED: ("host_scheduled", "REQUEST"),
    EmailKind.HOST_VISIT_RESCHEDULED: ("host_rescheduled", "REQUEST"),
    EmailKind.HOST_VISIT_CANCELLED: ("host_cancelled", "CANCEL"),
}
# Characters that end a line of an address and would double the comma that joins it to the next one.
_AUDIT_SAFE_DOMAIN = re.compile(r"[a-z0-9.-]{1,100}")
_WHITE_SPACE_RUN = re.compile(r"\s+")
_ARABIC_COMMA = "\N{ARABIC COMMA}"
logger = logging.getLogger("app.email")


def one_line(name: str | None) -> str | None:
    """A name as one line: every run of white space (line and paragraph breaks, tabs) becomes one space.
    Names are single-line (SEC-34); this keeps rows stored before that rule from printing extra lines
    ("Company: …") into the e-mails that show them."""
    return None if name is None else _WHITE_SPACE_RUN.sub(" ", name).strip()


# Gmail's own domains, where a dot in the local part is no part of the address and googlemail.com is
# gmail.com (https://support.google.com/mail/answer/7436150); in an organisation's domain dots count.
_GMAIL_DOMAINS = frozenset({"gmail.com", "googlemail.com"})


def mailbox_key(address: str) -> str:
    """The mailbox `address` delivers to, as far as its spelling tells (B14-21): letter case aside; the
    domain in its ASCII (IDNA) form, so `exämple.com` and `xn--exmple-cua.com` are one; without a `+tag`
    (Gmail, Google Workspace and Microsoft 365 deliver `name+tag@` to `name@`); and for a Gmail address
    without dots and with gmail.com for googlemail.com. Another address of the same account (an alias)
    cannot be told from its spelling."""
    local, at, domain = address.strip().lower().rpartition("@")
    local = local.split("+", 1)[0]
    if not domain.isascii():
        with suppress(idna.IDNAError, UnicodeError):  # not a domain IDNA can write: compared as it is
            domain = idna.encode(domain, uts46=True).decode("ascii")
    if domain in _GMAIL_DOMAINS:
        local, domain = local.replace(".", ""), "gmail.com"
    return f"{local}{at}{domain}"


def recipient_domain(address: str) -> str:
    """The domain of an address in ASCII form for audit metadata (§3.2-8 allows no addresses)."""
    domain = address.rpartition("@")[2].strip().lower()
    try:
        ascii_domain = domain.encode("idna").decode("ascii")
    except UnicodeError:
        return "unknown"
    return ascii_domain if _AUDIT_SAFE_DOMAIN.fullmatch(ascii_domain) else "unknown"


@cache
def _logo_png() -> bytes:
    return resources.files("app.email").joinpath("assets", LOGO_FILE).read_bytes()


def brand_logo() -> InlineImage:
    """The product's logo as an inline image (`assets/brand-logo.png`: the white wordmark on the header's
    teal #188086, 462 x 149 px, written by scripts/email_logo.py, B10-17), read from the package once.
    Only the CLI's test e-mail carries it (B12-12, B12-22)."""
    return InlineImage(content_id=LOGO_CONTENT_ID, filename=LOGO_FILE, content=_logo_png())


def brand_names(settings: Settings) -> dict[Language, str]:
    """The organisation behind the logo, per language (the logo's `alt`)."""
    return {Language.AR: settings.brand_name_ar, Language.EN: settings.brand_name_en}


def product_names(settings: Settings) -> dict[Language, str]:
    """The product, per language: who sends the CLI's test e-mail (B10-16)."""
    return {Language.AR: settings.product_name_ar, Language.EN: settings.product_name_en}


def company_names(company: Company) -> dict[Language, str]:
    """The company's name in each language: Arabic shows `name_ar` when it is set, English `name`."""
    name = one_line(company.name) or ""
    return {Language.AR: one_line(company.name_ar) or name, Language.EN: name}


def company_addresses(company: Company) -> dict[Language, str | None]:
    """The company's address in each language (B10-26): Arabic shows `address_ar` when it is set, English
    `address`; a section whose own address is missing shows the other one rather than none, so a visitor
    always learns where to go. Addresses keep their line breaks."""
    english = company.address or company.address_ar
    return {Language.AR: company.address_ar or company.address, Language.EN: english}


def department_names(visit: Visit) -> dict[Language, str | None]:
    """The visit's department in each language (B10-26), from its snapshots (D-17): Arabic shows
    `department_name_ar` when it is set, English `department_name`."""
    name = one_line(visit.department_name)
    return {Language.AR: one_line(visit.department_name_ar) or name, Language.EN: name}


def masthead(names: dict[Language, str]) -> dict[Language, str]:
    """The first line of the plain-text part, per leading language: the sender's name in that language,
    then in the other one where it differs."""
    lines: dict[Language, str] = {}
    for lead in LANGUAGES:
        first, second = names[lead], names[other_language(lead)]
        lines[lead] = first if first == second else f"{first} | {second}"
    return lines


def product_identity(settings: Settings) -> Identity:
    """The product's own identity, of the CLI's test e-mail and of nothing a company's people receive
    (B12-12, B12-22): the white logo on the teal band, the product's colours, and the product's name on
    the first line of the text part."""
    return Identity(
        product=True,
        names=brand_names(settings),
        masthead=masthead(product_names(settings)),
        colors=DEFAULT_COLORS,
        logo=brand_logo(),
        logo_width=LOGO_WIDTH,
        logo_height=LOGO_HEIGHT,
    )


def _drawn(image: BrandImage, draw: Callable[[bytes], Rendition]) -> Rendition | None:
    """A rendition of a stored logo, or None when it cannot be drawn (which no stored logo should be: it
    passed the same check at upload). The e-mail is sent either way: whatever goes wrong while drawing (a
    refusal of the bytes, or a fault of the drawing itself, B13-11) is logged, with its traceback, and
    the stored logo goes instead. A visit's creation, check-in or cancellation never fails for a logo."""
    try:
        return draw(image.content)
    except Exception as error:
        problem = error.problem.value if isinstance(error, PngError) else type(error).__name__
        logger.warning(
            "company logo could not be drawn for e-mail",
            extra={"kind": image.info.kind.value, "problem": problem},
            exc_info=True,
        )
        return None


def company_identity(
    company: Company, logo: BrandImage | None, logo_dark: BrandImage | None = None
) -> Identity:
    """A company's identity (B12-12): its logo, or none (the templates then write its name), and the
    colours of its palette, or the product's teal while it has no colour; the dark design's colours from
    the same palette (B13-1).

    The logo is sent as its renditions (B13-2): the light one on its white plate, and the dark one when
    the company has a logo for dark surfaces; beside either that is an emblem the header writes the
    company's name (B13-12). Without a logo for light surfaces there is no image in the header, whatever
    else the company has: its name stands there in both designs (as in the web application's
    `CompanyLogo` on a page). A logo that cannot be drawn is sent as it was stored, without a plate and
    without a dark rendition."""
    names = company_names(company)
    palette = derive_palette(company.brand_color) if company.brand_color else None
    identity = Identity(
        product=False,
        names=names,
        masthead=masthead(names),
        colors=colors_of(palette) if palette else DEFAULT_COLORS,
        dark=dark_colors_of(palette),
    )
    if logo is None:
        return identity
    light = _drawn(logo, light_rendition)
    if light is None:
        width, height = fitted(logo.info.width, logo.info.height)
        image = InlineImage(content_id=LOGO_CONTENT_ID, filename=LOGO_FILE, content=logo.content)
        mark = is_mark(logo.info.width, logo.info.height)
        return replace(identity, logo=image, logo_width=width, logo_height=height, logo_mark=mark)
    identity = replace(
        identity,
        logo=InlineImage(content_id=LOGO_CONTENT_ID, filename=LOGO_FILE, content=light.content),
        logo_width=light.width,
        logo_height=light.height,
        logo_mark=light.mark,
        plate=PLATE,
    )
    dark = _drawn(logo_dark, dark_rendition) if logo_dark is not None else None
    if dark is None:
        return identity
    return replace(
        identity,
        logo_dark=InlineImage(content_id=LOGO_DARK_CONTENT_ID, filename=LOGO_DARK_FILE, content=dark.content),
        logo_dark_width=dark.width,
        logo_dark_height=dark.height,
        logo_dark_mark=dark.mark,
    )


def one_line_address(address: str | None, language: Language) -> str | None:
    """A company's address on one line, as a calendar's location shows it (B14-3): its lines joined by
    the language's comma. A location is looked up on a map, where line breaks have no place."""
    if not address:
        return None
    lines = [line.strip().rstrip(",;" + _ARABIC_COMMA).strip() for line in address.splitlines()]
    return COMMA[language].join(line for line in lines if line) or None


def event_description(language: Language, details: tuple[tuple[str, str | None], ...], *last: str) -> str:
    """An event's description (B14-3): a "Label: value" line per detail that has a value, labelled as the
    e-mails label them, then `last`. Plain text: a calendar writes no markup and no isolate characters
    (`app.email.calendar.text_value` removes direction controls)."""
    lines = [f"{translate(language, key)}: {value}" for key, value in details if value]
    return "\n".join((*lines, *last))


def company_link(url: str, slug: str) -> str:
    """`url` naming the company: `?c=<slug>`, so the page it opens shows that company's identity before
    anyone signs in (B12-14). Whatever the link carries in its fragment is added after this."""
    return f"{url}?c={quote(slug, safe='')}"


Footer = dict[Language, tuple[Sentence, ...]]


def company_footers(company: dict[Language, str], *, has_reply_to: bool) -> Footer:
    """Who sent a company's e-mail, per language: the company, and nobody else (B12-12); "please do not
    reply" when nobody reads replies."""
    return {
        language: (
            Sentence("footer.company", {"company": company[language]}),
            *(() if has_reply_to else (Sentence("footer.no_reply"),)),
        )
        for language in LANGUAGES
    }


def product_footers(product: dict[Language, str], *, has_reply_to: bool) -> Footer:
    """Who sent the product's own message, per language: the product; "please do not reply" when nobody
    reads replies. Sentences, which the templates render with the names isolated (B10-14)."""
    return {
        language: (
            Sentence("footer.sent", {"product": product[language]}),
            *(() if has_reply_to else (Sentence("footer.no_reply"),)),
        )
        for language in LANGUAGES
    }


# A subject's words around the company's name: the text for the name as it is to show there.
type Wording = Callable[[str], str]
# One language's part of a subject, in at most that many characters.
type Half = Callable[[int], str]


def subject_within(wording: Wording, company: str, limit: int) -> str:
    """The subject `wording(company)` in at most `limit` characters (B12-24).

    A subject that is too long gives up some of the company's name first: the name is cut short where
    it stands, with an ellipsis, by as much as the subject is too long. What follows the name (the date
    of the visit) stays, and the subject is still a whole sentence: "Your visit to International Company
    for Advanced Technological Solutions and Integrated Digital… on Wednesday, 14 October 2026", where
    cutting at the end gave "… and Integrated Digital Services on Wednesday, 14 Octo…". The name keeps
    at least `SUBJECT_NAME_MIN` characters. A subject that is still too long then (another value is the
    long one), or that does not name the company, is cut at its end."""
    text = subject_line(wording(company))
    name = subject_line(company)
    uses = text.count(name) if name else 0
    if len(text) <= limit or not uses:
        return shorten(text, limit)
    keep = len(name) - -(-(len(text) - limit) // uses)  # the excess, shared by the name's places
    while keep >= SUBJECT_NAME_MIN:
        shorter = subject_line(wording(cut_short(name, keep)))
        if len(shorter) <= limit:
            return shorter
        keep -= 1  # a full stop the shorter name no longer replaces, a name inside another value
    return shorten(text, limit)


def naming_the_company(wording: Wording, company: str) -> Half:
    """A part of a subject that names the company: shortened by its name first (`subject_within`)."""
    return lambda limit: subject_within(wording, company, limit)


def cut_at_its_end(text: str) -> Half:
    """A part of a subject that is plain text: finished like a subject, and cut at its end."""
    return lambda limit: shorten(subject_line(text), limit)


def join_subjects(first: Half, second: Half, *, room: int = SUBJECT_MAX_LENGTH) -> str:
    """`<leading language> | <other language>` in at most `room` characters (B11-40). When the two are
    too long together the longer one is shortened, and neither gets less than half of the room: a long
    company name in the leading language never pushes the other language out of the subject."""
    room -= len(SUBJECT_SEPARATOR)
    whole = first(room), second(room)
    if len(whole[0]) + len(whole[1]) <= room:
        return SUBJECT_SEPARATOR.join(whole)
    head = first(max(room // 2, room - len(whole[1])))
    return f"{head}{SUBJECT_SEPARATOR}{second(room - len(head))}"


def prefixed(prefix: str, subject: Callable[[int], str]) -> str:
    """`prefix` and the subject after it, in at most `SUBJECT_MAX_LENGTH` characters together: the
    subject is built for the room the prefix leaves, so the "[Test] " of a test e-mail costs the
    company's name a few characters and never the end of the sentence (B12-24)."""
    if not prefix:
        return subject(SUBJECT_MAX_LENGTH)
    # The prefix as it is sent: finished like the subject it heads (an encoded word typed into it is
    # broken up, which makes it longer), with its own last space, which the bar keeps from being trimmed.
    head = subject_line(f"{prefix}|").removesuffix("|")
    return f"{head}{subject(SUBJECT_MAX_LENGTH - len(head))}"


def _date_time(instant: datetime, timezone: str, language: Language) -> str:
    separator = _ARABIC_COMMA if language == Language.AR else ","
    return f"{format_date(instant, timezone, language)}{separator} {format_time(instant, timezone)}"


def build_test_email(
    settings: Settings,
    renderer: EmailRenderer,
    recipient: str,
    *,
    now: datetime,
    language: Language = Language.AR,
) -> OutgoingEmail:
    """The message of `python -m app.cli send-test-email` (S10-6): short, with a sample QR code inline
    exactly as an invitation carries its pass, so the recipient's mail client shows whether invitations
    will display. The QR code and the link point to `{QR_BASE_URL}/pass#sample-…`: the address real
    invitations use, with no pass token. Same sender and Reply-To rules as every other message, and the
    brand logo like every message; `language` leads (`--language`, Arabic by default). Not stored: there
    is no `email_messages` row and no company. Raises ValueError for an invalid recipient."""
    sample_url = f"{settings.pass_url_base}#{TEST_EMAIL_SAMPLE_FRAGMENT}"
    product = product_names(settings)
    sender_name = one_line(parseaddr(settings.email_from)[0]) or product[language]
    reply_to = settings.email_reply_to
    identity = product_identity(settings)
    rendered = renderer.render(
        "test_email",
        subject=translate(language, "test.subject", sender=sender_name),
        language=language,
        context={
            "identity": identity,
            "colors": identity.colors,
            "product": product,
            "footer": product_footers(product, has_reply_to=reply_to is not None),
            "sample_url": sample_url,
            "qr_base_url": settings.qr_base_url,
            "qr_cid": QR_CONTENT_ID,
            "sent_at": {lang: f"{_date_time(now, 'UTC', lang)} UTC" for lang in LANGUAGES},
        },
    )
    qr_image = InlineImage(
        content_id=QR_CONTENT_ID, filename=f"{QR_CONTENT_ID}.png", content=qr_png(sample_url)
    )
    return OutgoingEmail(
        message_id=uuid.uuid4(),
        kind=EmailKind.VISITOR_INVITATION,  # what it imitates; no kind of its own (§8.1 enum unchanged)
        to=validate_email_address(sanitize_header(recipient)),
        subject=rendered.subject,
        html=rendered.html,
        text=rendered.text,
        sender=sanitize_header(settings.email_from),
        reply_to=sanitize_header(reply_to) if reply_to else None,
        inline_images=(qr_image, *identity.images),
    )


@dataclass(frozen=True, slots=True)
class DeliveryAudit:
    """Audit rows the dispatcher writes with a message's final outcome, in the same transaction as the
    status change (IDs and enums only)."""

    company_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    sent_action: str
    failed_action: str
    request_id: str | None = None


@dataclass(frozen=True, slots=True)
class DeliveryJob:
    message_id: uuid.UUID
    email: OutgoingEmail
    audit: DeliveryAudit | None = field(default=None)


class TemplateTextSource(Protocol):
    """Where a company's own e-mail texts come from (B11-20): `EmailTemplateOverrideRepository`."""

    def texts(self, company_id: uuid.UUID, kind: EmailKind | str) -> TemplateTexts: ...


class _NoTemplateTexts:
    """No company texts: every e-mail uses the product's texts (unit tests, the CLI's test e-mail)."""

    def texts(self, company_id: uuid.UUID, kind: EmailKind | str) -> TemplateTexts:
        return {}


NO_TEMPLATE_TEXTS: TemplateTextSource = _NoTemplateTexts()


class BrandImageSource(Protocol):
    """Where a company's logo comes from (B12-12): `CompanyBrandRepository`."""

    def image(self, company_id: uuid.UUID, kind: BrandAssetKind) -> BrandImage | None: ...


class _NoBrandImages:
    """No company has a logo: every company e-mail shows the company's name (unit tests)."""

    def image(self, company_id: uuid.UUID, kind: BrandAssetKind) -> BrandImage | None:
        return None


NO_BRAND_IMAGES: BrandImageSource = _NoBrandImages()


@dataclass(frozen=True, slots=True)
class PreparedEmail:
    """A rendered e-mail before it is queued: what `_queue` sends, and what a preview shows (B11-28)."""

    kind: EmailKind
    rendered: RenderedEmail
    reply_to: str | None
    inline_images: tuple[InlineImage, ...]
    sender: str  # the From mailbox: EMAIL_FROM's address under the company's name (B12-13)
    pass_url: str | None = None
    # The visit as a calendar event (B14-1), addressed to the recipient when the e-mail is queued; None
    # for an e-mail that carries none (a host's arrival notice, a test e-mail).
    event: VisitEvent | None = None


def visit_variables(context: dict[str, Any]) -> Variables:
    """The values of a visitor e-mail's variables (B11-22), per language, from `_visit_context`."""
    return {
        language: {
            "visitor_name": context["visitor_name"] or "",
            "company": context["company_name"][language],
            "host_name": context["host_name"] or "",
            "date": context["times"][language].date,
            "time": context["times"][language].time,
            "timezone": context["times"][language].timezone,
            "department": context["department_name"][language] or "",
            "purpose": context["purpose"],
        }
        for language in LANGUAGES
    }


def arrival_variables(context: dict[str, Any], *, host_name: str, arrived_at: str) -> Variables:
    """The values of a host arrival e-mail's variables (B11-22), per language."""
    return {
        language: {
            "host_name": host_name,
            "visitor_name": context["visitor_name"] or "",
            "visitor_company": context["visitor_company_name"] or "",
            "company": context["company_name"][language],
            "date": context["times"][language].date,
            "time": arrived_at,
            "timezone": context["times"][language].timezone,
            "purpose": context["purpose"],
        }
        for language in LANGUAGES
    }


def host_visit_variables(context: dict[str, Any], *, host_name: str) -> Variables:
    """The values of the variables of the host's e-mails of a scheduled visit (B14-2), per language."""
    return {
        language: {
            "host_name": host_name,
            "visitor_name": context["visitor_name"] or "",
            "visitor_company": context["visitor_company_name"] or "",
            "company": context["company_name"][language],
            "date": context["times"][language].date,
            "time": context["times"][language].time,
            "timezone": context["times"][language].timezone,
            "department": context["department_name"][language] or "",
            "purpose": context["purpose"],
        }
        for language in LANGUAGES
    }


def subject_half(
    language: Language, key: str, values: dict[str, object], *, overrides: Texts, variables: Variables
) -> Half:
    """The subject in one language, for a given room: the company's own text (B11-20), else the
    catalog's, with the company's name shortened where the room asks for it (`subject_within`)."""
    own = overrides.get(language, {}).get(TemplateField.SUBJECT.value)
    if own:
        names = variables[language]
        return naming_the_company(
            lambda name: render_subject(own, {**names, "company": name}), names.get("company", "")
        )
    if "company" in values:
        return naming_the_company(
            lambda name: translate(language, key, **{**values, "company": name}), str(values["company"])
        )
    # The catalog's subject does not name the company (a host's arrival notice).
    return cut_at_its_end(translate(language, key, **values))


def single_subject(
    language: Language,
    key: str,
    values: dict[str, object],
    *,
    overrides: Texts,
    variables: Variables,
    prefix: str = "",
) -> str:
    """The subject of an e-mail to staff, in the recipient's language only (B10-9), after `prefix`."""
    return prefixed(prefix, subject_half(language, key, values, overrides=overrides, variables=variables))


def bilingual_subject(
    lead: Language,
    key: str,
    values: dict[Language, dict[str, object]],
    *,
    overrides: Texts,
    variables: Variables,
    prefix: str = "",
) -> str:
    """`<leading language> | <other language>` after `prefix`: the subject of an e-mail to a visitor,
    whose language the company can only guess (B10-9), with the company's own subjects where it has
    them. Each language's half is a whole sentence whatever the company is called (B12-24)."""
    other = other_language(lead)
    first = subject_half(lead, key, values[lead], overrides=overrides, variables=variables)
    second = subject_half(other, key, values[other], overrides=overrides, variables=variables)
    return prefixed(prefix, lambda room: join_subjects(first, second, room=room))


class EmailService:
    def __init__(
        self,
        db: Session,
        *,
        settings: Settings,
        renderer: EmailRenderer,
        provider_name: str,
        template_texts: TemplateTextSource | None = None,
        brand_images: BrandImageSource | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.renderer = renderer
        self.provider_name = provider_name
        self.messages = EmailMessageRepository(db)
        # A company's own texts are read when an e-mail is rendered, i.e. when it is queued (B11-26).
        self.template_texts: TemplateTextSource = template_texts or EmailTemplateOverrideRepository(db)
        # ... and so is its identity (B12-12): the logo and colour it has then.
        self.brand_images: BrandImageSource = brand_images or CompanyBrandRepository(db)
        self._identities: dict[tuple[uuid.UUID, str | None], Identity] = {}

    def _texts(self, company_id: uuid.UUID, kind: EmailKind, overrides: Texts | None) -> Texts:
        """The company's texts an e-mail of `kind` uses: the saved ones, or `overrides` (a preview's
        draft over them), and of those only what passes the checks today (`usable_texts`, B11-40)."""
        texts = overrides if overrides is not None else self.template_texts.texts(company_id, kind)
        return usable_texts(kind, texts)

    # ---- visitors -------------------------------------------------------------------------------
    # `host_email` is the host's address while the host is active (None otherwise): see "Replies" above.
    # Visitor e-mails lead with the company's default language (B10-9).

    def queue_visitor_invitation(
        self,
        visit: Visit,
        raw_token: str,
        *,
        company: Company,
        recipient: str,
        host_email: str | None,
        booked_by: str | None = None,
        invitation_audit: DeliveryAudit | None = None,
    ) -> DeliveryJob:
        """The invitation with the pass as an inline QR code (`cid:`) and a button to the pass page. The
        QR payload and the link are exactly the pass URL.

        `booked_by` is the name of whoever booked the visit when that is not the host (D-02 lets anyone
        book for any active colleague): the e-mail then says who sent it on the host's behalf and does
        not attribute the purpose to the host (B57-02)."""
        prepared = self.prepare_visitor_invitation(
            visit,
            build_pass_url(self.settings.pass_url_base, raw_token, company.slug),
            company=company,
            host_email=host_email,
            booked_by=booked_by,
        )
        return self.queue_prepared(
            prepared, company_id=company.id, to=recipient, visit_id=visit.id, audit=invitation_audit
        )

    def prepare_visitor_invitation(
        self,
        visit: Visit,
        pass_url: str,
        *,
        company: Company,
        host_email: str | None,
        booked_by: str | None = None,
        overrides: Texts | None = None,
        subject_prefix: str = "",
        scheme: Scheme | None = None,
    ) -> PreparedEmail:
        """The rendered invitation (`queue_visitor_invitation`); `overrides` replaces the company's saved
        texts (a preview of a draft), `subject_prefix` heads the subject (a test e-mail's "[Test] "), and
        `scheme` renders one design alone, whatever the viewer's scheme (a preview of it, B13-5).

        It carries no calendar event (B14-10): Outlook would keep its text, the pass link and the QR code
        with it, in the calendar entry. The visitor's event follows in its own e-mail
        (`queue_visitor_calendar`)."""
        reply_to = self._visitor_reply_to(host_email)
        lead = as_language(company.default_language)
        identity = self.identity_of(company)
        context = self._visit_context(visit, company, host_email=host_email, reply_to=reply_to)
        texts = self._texts(company.id, EmailKind.VISITOR_INVITATION, overrides)
        variables = visit_variables(context)
        rendered = self.renderer.render(
            "visitor_invitation",
            subject=self._invitation_subject(lead, context, texts, variables, prefix=subject_prefix),
            language=lead,
            scheme=scheme,
            context={
                **context,
                "pass_url": pass_url,
                "qr_cid": QR_CONTENT_ID,
                "notify_host_on_check_in": company.notify_host_on_check_in,
                "booked_by": one_line(booked_by),
                "overrides": texts,
                "variables": variables,
            },
        )
        qr_image = InlineImage(
            content_id=QR_CONTENT_ID, filename=f"{QR_CONTENT_ID}.png", content=qr_png(pass_url)
        )
        return PreparedEmail(
            EmailKind.VISITOR_INVITATION,
            rendered,
            reply_to,
            (qr_image, *identity.images),
            self._sender(company, lead),
            pass_url=pass_url,
        )

    def queue_visitor_calendar(
        self, visit: Visit, *, company: Company, recipient: str, host_email: str | None
    ) -> DeliveryJob:
        """The visitor's calendar invitation (B14-10): the short e-mail that follows the invitation, with
        the visit as an event of the visitor's calendar (a REQUEST). The caller sends it after every
        invitation, and only then; never to the sending mailbox itself (`sends_from`)."""
        prepared = self.prepare_visitor_calendar(visit, company=company, host_email=host_email)
        return self.queue_prepared(prepared, company_id=company.id, to=recipient, visit_id=visit.id)

    def prepare_visitor_calendar(
        self, visit: Visit, *, company: Company, host_email: str | None, scheme: Scheme | None = None
    ) -> PreparedEmail:
        """The rendered calendar invitation: the invitation's subject (so a mail client shows the two
        together) and heading, the company's own where it wrote them, the visit's date, time, host and
        address, and the line that says the event is attached. No pass link and no QR code: in Outlook
        this text becomes the calendar entry's (B14-10). In the invitation's language and identity."""
        reply_to = self._visitor_reply_to(host_email)
        lead = as_language(company.default_language)
        context = self._visit_context(visit, company, host_email=host_email, reply_to=reply_to)
        texts = self._texts(company.id, EmailKind.VISITOR_INVITATION, None)
        variables = visit_variables(context)
        rendered = self.renderer.render(
            "visitor_calendar",
            subject=self._invitation_subject(lead, context, texts, variables),
            language=lead,
            scheme=scheme,
            context={**context, "overrides": texts, "variables": variables},
        )
        event = self._visitor_event(visit, company, lead, "REQUEST")
        return self._prepared(EmailKind.VISITOR_CALENDAR, rendered, reply_to, company, lead, event=event)

    @staticmethod
    def _invitation_subject(
        lead: Language, context: dict[str, Any], texts: Texts, variables: Variables, *, prefix: str = ""
    ) -> str:
        """The invitation's subject (the company's own, where it wrote one), which its calendar invitation
        shares."""
        return bilingual_subject(
            lead,
            "invitation.subject",
            {
                language: {
                    "company": context["company_name"][language],
                    "date": context["times"][language].date,
                }
                for language in LANGUAGES
            },
            overrides=texts,
            variables=variables,
            prefix=prefix,
        )

    def queue_visitor_withdrawal(self, visit: Visit, *, company: Company, recipient: str) -> DeliveryJob:
        """The visitor's event taken out of the calendar of `recipient`, an address the visitor no longer
        has, to which the visit's calendar invitation went (D-19, B14-17): a VISITOR_CALENDAR message whose
        CANCEL uninvites that address. The caller has raised the visit's `calendar_sequence`, so the
        withdrawal is newer than anything sent there; the new address's calendar invitation carries the
        same version."""
        prepared = self.prepare_visitor_withdrawal(visit, company=company)
        return self.queue_prepared(prepared, company_id=company.id, to=recipient, visit_id=visit.id)

    def prepare_visitor_withdrawal(
        self, visit: Visit, *, company: Company, scheme: Scheme | None = None
    ) -> PreparedEmail:
        """The rendered withdrawal: the company's header and footer, a heading and one sentence; no date,
        host, address or link, and replies only to EMAIL_REPLY_TO, never to the host, since the address
        may be nobody the visit concerns. Its event: the visit's identity and times, a summary that names
        nothing, no description and no location (B14-17)."""
        reply_to = self.settings.email_reply_to
        lead = as_language(company.default_language)
        rendered = self.renderer.render(
            "visitor_withdrawn",
            subject=bilingual_subject(
                lead,
                "withdrawn.subject",
                {language: {} for language in LANGUAGES},
                overrides={},
                variables={},
            ),
            language=lead,
            scheme=scheme,
            context=self._company_context(company, has_reply_to=reply_to is not None),
        )
        event = replace(
            self._event(
                visit,
                company,
                lead,
                "CANCEL",
                role="visitor",
                summary=translate(lead, "calendar.withdrawn_summary"),
                description=None,
                attendee=None,
            ),
            location=None,
            withdrawn=True,
        )
        return self._prepared(EmailKind.VISITOR_CALENDAR, rendered, reply_to, company, lead, event=event)

    def queue_visit_rescheduled(
        self,
        visit: Visit,
        *,
        company: Company,
        recipient: str,
        host_email: str | None,
        calendar: bool = True,
    ) -> DeliveryJob:
        """No QR code (the raw token is never stored): the visitor's existing pass stays valid (D-22).
        `calendar`: with the visitor's event at the new time; the caller leaves it out where it may not
        go (B14-15, B14-27)."""
        prepared = self.prepare_visit_rescheduled(
            visit, company=company, host_email=host_email, calendar=calendar
        )
        return self.queue_prepared(prepared, company_id=company.id, to=recipient, visit_id=visit.id)

    def prepare_visit_rescheduled(
        self,
        visit: Visit,
        *,
        company: Company,
        host_email: str | None,
        overrides: Texts | None = None,
        subject_prefix: str = "",
        scheme: Scheme | None = None,
        calendar: bool = True,
    ) -> PreparedEmail:
        """The notice of a new time, with the visitor's event at its new time (a REQUEST, B14-1)."""
        reply_to = self._visitor_reply_to(host_email)
        context = self._visit_context(visit, company, host_email=host_email, reply_to=reply_to)
        lead = as_language(company.default_language)
        texts = self._texts(company.id, EmailKind.VISIT_RESCHEDULED, overrides)
        variables = visit_variables(context)
        rendered = self.renderer.render(
            "visit_rescheduled",
            subject=bilingual_subject(
                lead,
                "rescheduled.subject",
                {language: {"company": context["company_name"][language]} for language in LANGUAGES},
                overrides=texts,
                variables=variables,
                prefix=subject_prefix,
            ),
            language=lead,
            scheme=scheme,
            context={**context, "overrides": texts, "variables": variables},
        )
        event = self._visitor_event(visit, company, lead, "REQUEST") if calendar else None
        return self._prepared(EmailKind.VISIT_RESCHEDULED, rendered, reply_to, company, lead, event=event)

    def queue_visit_cancelled(
        self,
        visit: Visit,
        reason: str | None,
        *,
        company: Company,
        recipient: str,
        host_email: str | None,
        calendar: bool = True,
    ) -> DeliveryJob:
        """`calendar`: with the cancellation of the visitor's event; the caller leaves it out where it
        may not go (B14-27)."""
        prepared = self.prepare_visit_cancelled(
            visit, reason, company=company, host_email=host_email, calendar=calendar
        )
        return self.queue_prepared(prepared, company_id=company.id, to=recipient, visit_id=visit.id)

    def prepare_visit_cancelled(
        self,
        visit: Visit,
        reason: str | None,
        *,
        company: Company,
        host_email: str | None,
        overrides: Texts | None = None,
        subject_prefix: str = "",
        scheme: Scheme | None = None,
        calendar: bool = True,
    ) -> PreparedEmail:
        """The notice of the cancellation, with the visitor's event cancelled (a CANCEL, B14-1)."""
        reply_to = self._visitor_reply_to(host_email)
        context = self._visit_context(visit, company, host_email=host_email, reply_to=reply_to)
        lead = as_language(company.default_language)
        texts = self._texts(company.id, EmailKind.VISIT_CANCELLED, overrides)
        variables = visit_variables(context)
        rendered = self.renderer.render(
            "visit_cancelled",
            subject=bilingual_subject(
                lead,
                "cancelled.subject",
                {language: {"company": context["company_name"][language]} for language in LANGUAGES},
                overrides=texts,
                variables=variables,
                prefix=subject_prefix,
            ),
            language=lead,
            scheme=scheme,
            context={**context, "reason": reason, "overrides": texts, "variables": variables},
        )
        event = self._visitor_event(visit, company, lead, "CANCEL") if calendar else None
        return self._prepared(EmailKind.VISIT_CANCELLED, rendered, reply_to, company, lead, event=event)

    # ---- staff ----------------------------------------------------------------------------------
    # Staff e-mails lead with the recipient's own language, else the company's; the subject is in that
    # language only (B10-9).

    def queue_host_arrival(self, visit: Visit, *, company: Company, host: User) -> DeliveryJob:
        """Tell the host "Your visitor … has arrived and checked in." The caller decides whether to send
        it (`notify_host_on_check_in`, host active, once per check-in: contract §9)."""
        prepared = self.prepare_host_arrival(
            visit,
            company=company,
            host_name=host.full_name,
            host_language=host.preferred_language,
        )
        return self.queue_prepared(
            prepared, company_id=company.id, to=host.email, visit_id=visit.id, recipient_user_id=host.id
        )

    def prepare_host_arrival(
        self,
        visit: Visit,
        *,
        company: Company,
        host_name: str,
        host_language: str | None,
        overrides: Texts | None = None,
        subject_prefix: str = "",
        scheme: Scheme | None = None,
    ) -> PreparedEmail:
        if visit.check_in_at is None:
            raise ValueError("a host arrival e-mail needs a checked-in visit")
        reply_to = self.settings.email_reply_to
        context = self._visit_context(visit, company, host_email=None, reply_to=reply_to)
        lead = as_language(host_language, company.default_language)
        arrived_at = format_time(visit.check_in_at, company.timezone)
        full_name = one_line(host_name) or ""
        texts = self._texts(company.id, EmailKind.HOST_ARRIVAL, overrides)
        variables = arrival_variables(context, host_name=full_name, arrived_at=arrived_at)
        rendered = self.renderer.render(
            "host_arrival",
            subject=single_subject(
                lead,
                "arrival.subject",
                {"visitor": context["visitor_name"]},
                overrides=texts,
                variables=variables,
                prefix=subject_prefix,
            ),
            language=lead,
            scheme=scheme,
            context={
                **context,
                "host_full_name": full_name,
                "arrived_at": arrived_at,
                "overrides": texts,
                "variables": variables,
            },
        )
        return self._prepared(EmailKind.HOST_ARRIVAL, rendered, reply_to, company, lead)

    def queue_host_visit(
        self,
        visit: Visit,
        *,
        kind: EmailKind,
        company: Company,
        host: User,
        booked_by: str | None = None,
        reason: str | None = None,
        calendar: bool = True,
    ) -> DeliveryJob:
        """The host's e-mail of a scheduled visit (B14-2): `kind` is HOST_VISIT_SCHEDULED (a new visit),
        HOST_VISIT_RESCHEDULED (its new time) or HOST_VISIT_CANCELLED (with `reason`), each with the
        host's event of the visit unless `calendar` is false. The caller decides whether to send it and
        with what (an active host; the budgets and the calendar switch: `services.visit_lifecycle`).

        A host whose address is the one the e-mails are sent from would be the organizer of their own
        event, which no calendar adds from an invitation (B14-5): that host gets the e-mail without it."""
        prepared = self.prepare_host_visit(
            visit,
            kind=kind,
            company=company,
            host_name=host.full_name,
            host_language=host.preferred_language,
            booked_by=booked_by,
            reason=reason,
            calendar=calendar and not self.sends_from(host.email),
        )
        return self.queue_prepared(
            prepared, company_id=company.id, to=host.email, visit_id=visit.id, recipient_user_id=host.id
        )

    def prepare_host_visit(
        self,
        visit: Visit,
        *,
        kind: EmailKind,
        company: Company,
        host_name: str,
        host_language: str | None,
        booked_by: str | None = None,
        reason: str | None = None,
        overrides: Texts | None = None,
        subject_prefix: str = "",
        scheme: Scheme | None = None,
        calendar: bool = True,
    ) -> PreparedEmail:
        """The rendered host's e-mail of a scheduled visit (`queue_host_visit`), in the host's language
        (B10-9). `booked_by`: whoever booked the visit, when that is not the host; `calendar` as for the
        visitor's invitation (only the notice of a new visit says that the event is attached)."""
        prefix, method = HOST_VISIT_KINDS[kind]
        reply_to = self.settings.email_reply_to
        context = self._visit_context(visit, company, host_email=None, reply_to=reply_to)
        lead = as_language(host_language, company.default_language)
        full_name = one_line(host_name) or ""
        texts = self._texts(company.id, kind, overrides)
        variables = host_visit_variables(context, host_name=full_name)
        rendered = self.renderer.render(
            "host_visit",
            subject=single_subject(
                lead,
                f"{prefix}.subject",
                {"visitor": context["visitor_name"], "date": context["times"][lead].date},
                overrides=texts,
                variables=variables,
                prefix=subject_prefix,
            ),
            language=lead,
            scheme=scheme,
            context={
                **context,
                "kind": prefix,
                "host_full_name": full_name,
                "booked_by": one_line(booked_by),
                "reason": reason,
                "calendar_attached": calendar and kind == EmailKind.HOST_VISIT_SCHEDULED,
                "overrides": texts,
                "variables": variables,
            },
        )
        event = self._host_event(visit, company, lead, method, booked_by=booked_by) if calendar else None
        return self._prepared(kind, rendered, reply_to, company, lead, event=event)

    def queue_password_reset(
        self, user: User, raw_token: str, *, sent_by_platform_owner: bool = False
    ) -> DeliveryJob:
        """The reset link. `sent_by_platform_owner`: the platform owner sent it (B11-11), so the message
        says so instead of "We received a request … If you did not request this" (B11-49): the reader
        asked for nothing. The same link, expiry and layout, and as little editable as the other one.
        It is the company's e-mail either way (B12-12), and its link names the company (B12-14)."""
        company = user.company
        names = company_names(company)
        lead = as_language(user.preferred_language, company.default_language)
        reset_page = company_link(f"{self.settings.app_base_url}/reset-password", company.slug)
        reset_url = f"{reset_page}#token={raw_token}"
        reply_to = self.settings.email_reply_to
        ttl_minutes = int(PASSWORD_RESET_TTL.total_seconds() // 60)
        rendered = self.renderer.render(
            "password_reset",
            subject=translate(lead, "reset.subject", company=names[lead]),
            language=lead,
            context={
                **self._company_context(company, has_reply_to=reply_to is not None),
                "full_name": one_line(user.full_name),
                "reset_url": reset_url,
                "duration": {language: minutes(language, ttl_minutes) for language in LANGUAGES},
                # The catalog keys of the two sentences that say who asked: `reset.intro` / `reset.ignore`
                # or `reset.platform_intro` / `reset.platform_ignore`.
                "asked": "platform_" if sent_by_platform_owner else "",
            },
        )
        return self._queue(
            kind=EmailKind.PASSWORD_RESET,
            company_id=user.company_id,
            to=user.email,
            rendered=rendered,
            reply_to=reply_to,
            recipient_user_id=user.id,
            reset_url=reset_url,
            identity=self.identity_of(company),
            sender=self._sender(company, lead),
        )

    def queue_password_changed(
        self, user: User, *, how: PasswordChange, when: datetime, ip_address: str | None
    ) -> DeliveryJob:
        """The notice that the account's password was changed or reset (SEC-06, ASVS 2.2.3), to the
        account's own address: whoever did not make the change learns of it and how to react."""
        company = user.company
        names = company_names(company)
        lead = as_language(user.preferred_language, company.default_language)
        reply_to = self.settings.email_reply_to
        rendered = self.renderer.render(
            "password_changed",
            subject=translate(lead, f"changed.subject.{how}", company=names[lead]),
            language=lead,
            context={
                **self._company_context(company, has_reply_to=reply_to is not None),
                "full_name": one_line(user.full_name),
                "how": how,
                "date": {language: format_date(when, company.timezone, language) for language in LANGUAGES},
                "time": format_time(when, company.timezone),
                "zone": {
                    language: timezone_label(when, company.timezone, language) for language in LANGUAGES
                },
                "ip_address": ip_address,
                # The company's own page for asking for a reset link (B12-14).
                "reset_url": company_link(f"{self.settings.app_base_url}/forgot-password", company.slug),
            },
        )
        return self._queue(
            kind=EmailKind.PASSWORD_CHANGED,
            company_id=user.company_id,
            to=user.email,
            rendered=rendered,
            reply_to=reply_to,
            recipient_user_id=user.id,
            identity=self.identity_of(company),
            sender=self._sender(company, lead),
        )

    def queue_platform_notice(
        self, recipient: User, *, action: PlatformAction, about: User, when: datetime
    ) -> DeliveryJob:
        """The security notice to one of a company's administrators that the platform owner added an
        administrator to the company, or sent one a password-reset link (B11-43): who ("the platform
        owner", never the platform account's name: B11-5), what and to which account, and when, in the
        company's time zone. No credential, no link and no network address. Like the other security
        notices it leads with the recipient's language and its texts are not editable (B11-21).

        It is the company's e-mail, like every other one its people receive (B12-22): its logo or its
        name, its colours, its name as the sender and "Sent by <company>." Nothing of the product
        reaches a company's people. Who acted is said in words: "the platform owner"."""
        company = recipient.company
        names = company_names(company)
        lead = as_language(recipient.preferred_language, company.default_language)
        reply_to = self.settings.email_reply_to
        rendered = self.renderer.render(
            "platform_notice",
            subject=translate(lead, f"platform.subject.{action}", company=names[lead]),
            language=lead,
            context={
                **self._company_context(company, has_reply_to=reply_to is not None),
                "full_name": one_line(recipient.full_name),
                "action": action,
                "about_name": one_line(about.full_name),
                "about_email": about.email,
                "date": {language: format_date(when, company.timezone, language) for language in LANGUAGES},
                "time": format_time(when, company.timezone),
                "zone": {
                    language: timezone_label(when, company.timezone, language) for language in LANGUAGES
                },
            },
        )
        return self._queue(
            kind=EmailKind.PLATFORM_ACTION_NOTICE,
            company_id=recipient.company_id,
            to=recipient.email,
            rendered=rendered,
            reply_to=reply_to,
            recipient_user_id=recipient.id,
            identity=self.identity_of(company),
            sender=self._sender(company, lead),
        )

    # ---- helpers --------------------------------------------------------------------------------

    def _visitor_reply_to(self, host_email: str | None) -> str | None:
        return self.settings.email_reply_to or host_email

    def identity_of(self, company: Company) -> Identity:
        """The company's identity as it is now (B12-12): read once per company and colour for the
        e-mails this service queues (a host's deactivation cancels many visits at once). Its logos'
        renditions are drawn once per process (`app.email.logos`)."""
        key = (company.id, company.brand_color)
        if key not in self._identities:
            logo = self.brand_images.image(company.id, BrandAssetKind.LOGO)
            logo_dark = self.brand_images.image(company.id, BrandAssetKind.LOGO_DARK) if logo else None
            self._identities[key] = company_identity(company, logo, logo_dark)
        return self._identities[key]

    def _sender(self, company: Company, lead: Language) -> str:
        """The From mailbox of a company's e-mail (B12-13): EMAIL_FROM's address under the company's
        name in the e-mail's leading language."""
        return sender_named(self.settings.email_from, company_names(company)[lead])

    def _prepared(
        self,
        kind: EmailKind,
        rendered: RenderedEmail,
        reply_to: str | None,
        company: Company,
        lead: Language,
        *,
        event: VisitEvent | None = None,
    ) -> PreparedEmail:
        return PreparedEmail(
            kind,
            rendered,
            reply_to,
            self.identity_of(company).images,
            self._sender(company, lead),
            event=event,
        )

    # ---- calendar events (B14-1 to B14-5) -------------------------------------------------------

    def sends_from(self, address: str) -> bool:
        """Whether `address` is the mailbox the e-mails are sent from (EMAIL_FROM's address), in any
        spelling that reaches it (`mailbox_key`: letter case, a `+tag`, Gmail's dots; B14-21): the
        organizer of every event (B14-5), to whom an invitation to their own event means nothing (Outlook:
        "As the meeting organizer, you do not need to respond", and nothing is added)."""
        sender = parseaddr(self.settings.email_from)[1].strip()
        return bool(sender) and mailbox_key(address) == mailbox_key(sender)

    def _organizer(self, company: Company, lead: Language) -> CalendarMailbox:
        """Who organizes a company's events (B14-5): the address its e-mails are sent from (EMAIL_FROM),
        under the name they are sent in (the company's, in the e-mail's leading language), so a calendar
        sees the invitation come from its organizer."""
        return CalendarMailbox(company_names(company)[lead], parseaddr(self.settings.email_from)[1])

    def _event(
        self,
        visit: Visit,
        company: Company,
        lead: Language,
        method: CalendarMethod,
        *,
        role: CalendarRole,
        summary: str,
        description: str | None,
        attendee: str | None,
        private: bool = False,
    ) -> VisitEvent:
        return VisitEvent(
            method=method,
            uid=event_uid(visit.id, role),
            # A visit that was never stored (a preview's sample) has no counter yet.
            sequence=visit.calendar_sequence or 0,
            start=visit.scheduled_start,
            end=visit.scheduled_end,
            summary=summary,
            location=one_line_address(company_addresses(company)[lead], lead),
            description=description,
            organizer=self._organizer(company, lead),
            attendee_name=attendee or "",
            private=private,
        )

    def _visitor_event(
        self, visit: Visit, company: Company, lead: Language, method: CalendarMethod
    ) -> VisitEvent:
        """The visit in the visitor's calendar (B14-3): "Visit to {company}" at the company's address,
        with the host, the department and the purpose, and the pass to show at reception. No link."""
        details = (
            ("label.host", one_line(visit.host_name)),
            ("label.department", department_names(visit)[lead]),
            ("label.purpose", visit.purpose),
        )
        return self._event(
            visit,
            company,
            lead,
            method,
            role="visitor",
            summary=translate(lead, "calendar.visitor_summary", company=company_names(company)[lead]),
            description=event_description(lead, details, translate(lead, "calendar.show_pass")),
            attendee=one_line(visit.visitor_name),
        )

    def _host_event(
        self,
        visit: Visit,
        company: Company,
        lead: Language,
        method: CalendarMethod,
        *,
        booked_by: str | None,
    ) -> VisitEvent:
        """The visit in the host's calendar (B14-3): "Visit: {visitor}" at the company's address, with
        who visits, from where, the department, the purpose and who booked it when not the host. Private
        (`CLASS:PRIVATE`, B14-19): a host's calendar is often shared with colleagues, who should see the
        time taken and not who the visitor is."""
        visitor = one_line(visit.visitor_name) or ""
        details = (
            ("label.visitor", visitor),
            ("label.company", one_line(visit.visitor_company_name)),
            ("label.department", department_names(visit)[lead]),
            ("label.purpose", visit.purpose),
            ("label.booked_by", one_line(booked_by)),
        )
        return self._event(
            visit,
            company,
            lead,
            method,
            role="host",
            summary=translate(lead, "calendar.host_summary", visitor=visitor),
            description=event_description(lead, details),
            attendee=one_line(visit.host_name),
            private=True,
        )

    def _company_context(self, company: Company, *, has_reply_to: bool) -> dict[str, Any]:
        """What every e-mail of a company shows of its sender: the company's identity and footer."""
        names = company_names(company)
        identity = self.identity_of(company)
        return {
            "company_name": names,
            "identity": identity,
            "colors": identity.colors,
            "footer": company_footers(names, has_reply_to=has_reply_to),
        }

    def _visit_context(
        self, visit: Visit, company: Company, *, host_email: str | None, reply_to: str | None
    ) -> dict[str, Any]:
        """What visit e-mails show, for both languages. Names are the visit's snapshots (D-17); the
        department and the company's address per language (B10-26); no internal IDs.

        `replies_reach_host`: a reply reaches the host (their address is the Reply-To);
        `has_reply_to`: replies reach someone at all (otherwise the footer asks not to reply)."""
        return {
            **self._company_context(company, has_reply_to=reply_to is not None),
            "company_address": company_addresses(company),
            "visitor_name": one_line(visit.visitor_name),
            "visitor_company_name": one_line(visit.visitor_company_name),
            "host_name": one_line(visit.host_name),
            "department_name": department_names(visit),
            "purpose": visit.purpose,
            "times": {
                language: VisitTimes.build(
                    scheduled_start=visit.scheduled_start,
                    scheduled_end=visit.scheduled_end,
                    window_start=visit.window_start,
                    window_end=visit.window_end,
                    timezone=company.timezone,
                    language=language,
                )
                for language in LANGUAGES
            },
            "has_reply_to": reply_to is not None,
            "replies_reach_host": host_email is not None and reply_to == host_email,
        }

    def queue_prepared(
        self,
        prepared: PreparedEmail,
        *,
        company_id: uuid.UUID,
        to: str,
        visit_id: uuid.UUID | None = None,
        recipient_user_id: uuid.UUID | None = None,
        audit: DeliveryAudit | None = None,
    ) -> DeliveryJob:
        return self._queue(
            kind=prepared.kind,
            company_id=company_id,
            to=to,
            rendered=prepared.rendered,
            reply_to=prepared.reply_to,
            recipient_user_id=recipient_user_id,
            visit_id=visit_id,
            pass_url=prepared.pass_url,
            inline_images=prepared.inline_images,
            sender=prepared.sender,
            event=prepared.event,
            audit=audit,
        )

    def _queue(
        self,
        *,
        kind: EmailKind,
        company_id: uuid.UUID,
        to: str,
        rendered: RenderedEmail,
        reply_to: str | None,
        sender: str,
        recipient_user_id: uuid.UUID | None = None,
        visit_id: uuid.UUID | None = None,
        pass_url: str | None = None,
        reset_url: str | None = None,
        inline_images: tuple[InlineImage, ...] | None = None,
        identity: Identity | None = None,
        event: VisitEvent | None = None,
        audit: DeliveryAudit | None = None,
    ) -> DeliveryJob:
        """`inline_images` are the message's images; without them, those of `identity` (its logo, if it
        has one). `event`: the visit as a calendar event, addressed here to the recipient, its DTSTAMP the
        moment the e-mail is queued (B14-1); never to the sending mailbox itself, the event's organizer
        (`sends_from`, B14-5)."""
        if inline_images is None:
            inline_images = identity.images if identity is not None else ()
        recipient = validate_email_address(sanitize_header(to))
        if event is not None and self.sends_from(recipient):
            event = None
        message = self.messages.add(
            EmailMessage(
                id=uuid.uuid4(),
                company_id=company_id,
                visit_id=visit_id,
                recipient_user_id=recipient_user_id,
                kind=kind.value,
                to_email=recipient,
                subject=rendered.subject[:300],
                status=EmailStatus.PENDING.value,
                provider=self.provider_name,
                attempts=0,
                # What the recipient's calendar was sent of the visit (B14-26).
                calendar_method=event.method if event is not None else None,
            )
        )
        email = OutgoingEmail(
            message_id=message.id,
            kind=kind,
            to=recipient,
            subject=rendered.subject,
            html=rendered.html,
            text=rendered.text,
            sender=sender,
            reply_to=sanitize_header(reply_to) if reply_to else None,
            inline_images=inline_images,
            calendar=(
                calendar_part(event.addressed(recipient, stamp=app_time.now())) if event is not None else None
            ),
            pass_url=pass_url,
            reset_url=reset_url,
        )
        return DeliveryJob(message_id=message.id, email=email, audit=audit)
