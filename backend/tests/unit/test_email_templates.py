"""Visit e-mails (contract §9, Phase 10 B10-6 to B10-9): content of every template in both languages,
plain-text twins, escaping of hostile input, header safety, who replies reach, the date/time wording, the
leading language, and whose identity each e-mail shows (Phase 12, B12-12 and B12-22: a company's own logo
or name in every e-mail its people and visitors receive, the product's in the CLI's test e-mail alone);
and what keeps an e-mail inside a phone's width (B12-23)."""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from html.parser import HTMLParser

import pytest

from app.core.config import Settings
from app.email import service as service_module
from app.email.formatting import VisitTimes, format_date, format_span, timezone_label, utc_offset, zone_name
from app.email.identity import LOGO_BOX_HEIGHT, LOGO_BOX_WIDTH, fitted
from app.email.logos import PLATE, light_rendition
from app.email.rendering import LOGO_HEIGHT, LOGO_WIDTH, EmailRenderer, compact_html
from app.email.service import (
    LOGO_CONTENT_ID,
    NO_BRAND_IMAGES,
    NO_TEMPLATE_TEXTS,
    QR_CONTENT_ID,
    BrandImageSource,
    EmailService,
    brand_logo,
    build_test_email,
    recipient_domain,
)
from app.models import Company, Language, User, Visit
from tests.png_support import CompanyLogos, make_png

START = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)  # 10:00 in Asia/Amman
TOKEN = "Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A"
HOST_EMAIL = "omar.khalil@demo.test"
ARABIC_INDIC_DIGITS = re.compile("[\u0660-\u0669\u06f0-\u06f9]")
# Keeps an Arabic date's day, month and year, a zone label or a time range on one line (phase 10 review).
NB = "\N{NO-BREAK SPACE}"
RANGE = f"{NB}\N{EN DASH}{NB}"


class _Messages:
    def add(self, message):
        return message


def _service(*, logos: BrandImageSource = NO_BRAND_IMAGES, **settings_values) -> EmailService:
    """The e-mail service without a database. `logos`: where a company's logo comes from (none has one
    unless a test gives it one)."""
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.test",
        email_from="Demo Visitors <visitors@demo.test>",
        **settings_values,
    )
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=settings,
        renderer=EmailRenderer(),
        provider_name="memory",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=logos,
    )
    service.messages = _Messages()  # type: ignore[assignment]
    return service


def _company(**changes) -> Company:
    values = {
        "id": uuid.uuid4(),
        "name": "Acme Holding",
        "name_ar": "أكمي القابضة",
        "slug": "acme",
        "timezone": "Asia/Amman",
        "address": "Building 14\nKing Abdullah II Street, Amman",
        "notify_host_on_check_in": True,
        "default_language": "en",
    }
    values.update(changes)
    return Company(**values)


def _visit(company: Company, **changes) -> Visit:
    values = {
        "id": uuid.uuid4(),
        "company_id": company.id,
        "visitor_id": uuid.uuid4(),
        "host_id": uuid.uuid4(),
        "visitor_name": "Dana Guest",
        "visitor_company_name": "Acme",
        "host_name": "Omar Khalil",
        "department_name": "Finance",
        "purpose": "Quarterly review",
        "scheduled_start": START,
        "scheduled_end": START + timedelta(hours=1),
        "window_start": START - timedelta(hours=1),
        "window_end": START + timedelta(hours=2),
    }
    values.update(changes)
    return Visit(**values)


# The isolation of values inside sentences (B10-14): a `<span dir>` around a value in HTML, Unicode
# isolates around each line of a value in plain text.
_ISOLATING_SPAN = re.compile(r'<span dir="(?:ltr|rtl)">([^<]*)</span>')
ISOLATES = re.compile("[\u2066-\u2069]")
FSI, LRI, PDI = "\N{FIRST STRONG ISOLATE}", "\N{LEFT-TO-RIGHT ISOLATE}", "\N{POP DIRECTIONAL ISOLATE}"


def _plain(html: str) -> str:
    """The words of an HTML body as a reader sees them: the isolating spans dropped (their text stays in
    place), every other tag a space."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", _ISOLATING_SPAN.sub(r"\1", html)))


def _read(text: str) -> str:
    """A plain-text body as a reader sees it: without the invisible isolate characters, and a no-break space
    (which keeps an Arabic date or a time range on one line) as the space it looks like."""
    return ISOLATES.sub("", text).replace("\N{NO-BREAK SPACE}", " ")


def _invitation(
    company: Company, *, host_email: str | None = HOST_EMAIL, service: EmailService | None = None
):
    return (service or _service()).queue_visitor_invitation(
        _visit(company), TOKEN, company=company, recipient="dana@example.com", host_email=host_email
    )


class _Sections(HTMLParser):
    """The `lang` of every element that declares one, in document order, and the `src` of every image."""

    def __init__(self) -> None:
        super().__init__()
        self.languages: list[tuple[str, str | None]] = []
        self.images: list[dict[str, str | None]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if "lang" in attributes:
            self.languages.append((attributes["lang"] or "", attributes.get("dir")))
        if tag == "img":
            self.images.append(attributes)


def _sections(html: str) -> _Sections:
    parser = _Sections()
    parser.feed(html)
    return parser


def _leading_language(html: str) -> str:
    """The first section's language after the document's own (`<html lang>`)."""
    parsed = _sections(html)
    return parsed.languages[1][0]


# ---- the invitation ----------------------------------------------------------------------------------


def test_invitation_has_everything_section_9_asks_for() -> None:
    company = _company()
    job = _invitation(company)
    email = job.email
    # The company's slug in the query, the token alone in the fragment (B12-14).
    pass_url = f"https://vms.test/pass?c=acme#{TOKEN}"
    assert email.subject == (
        "Your visit to Acme Holding on Monday, 5 October 2026 | "
        "زيارتك إلى أكمي القابضة يوم الاثنين، 5 تشرين الأول 2026"
    )
    # Sent in the company's name, from the configured address (B12-13).
    assert email.to == "dana@example.com" and email.sender == '"Acme Holding" <visitors@demo.test>'
    for body in (_plain(email.html), _read(email.text)):
        for expected in (
            "Acme Holding",
            "Building 14",
            "King Abdullah II Street, Amman",
            "Hello Dana Guest,",
            "Omar Khalil",
            "Finance",
            "Monday, 5 October 2026",
            "10:00 \N{EN DASH} 11:00 (Amman time, UTC+3)",
            "Purpose",
            "provided by your host",
            "Quarterly review",
            "show this QR code on your phone or on a printout",
            "valid photo ID",
            "This pass is personal. Please do not forward this email.",
            pass_url,
            # The same, in Arabic.
            "أكمي القابضة",
            "مرحبًا Dana Guest،",
            "الاثنين، 5 تشرين الأول 2026",
            "10:00 \N{EN DASH} 11:00 (بتوقيت عمّان، UTC+3)",
            "كما ذكره مضيفك",
            "هذه البطاقة شخصية، يُرجى عدم إعادة توجيه هذه الرسالة.",
        ):
            assert expected in body, expected
        # Explanatory filler is gone (B10-19): the tip, the "details below" and the QR-missing hint.
        for filler in (
            "screenshot of the QR code",
            "Here are the details",
            "If the QR code is not displayed",
        ):
            assert filler not in body, filler
    assert "Show this QR code at reception" in _plain(email.html)
    assert (
        "Show the QR code of your visitor pass at reception when you arrive. Open your pass here:"
        in email.text
    )
    # The arrival window, worded from the visitor's side and with the zone.
    assert "You can check in from 09:00. Your pass expires at 12:00 (Amman time)." in email.text
    assert "يمكنك تسجيل الدخول ابتداءً من 09:00، وتنتهي صلاحية بطاقتك عند 12:00 (بتوقيت عمّان)." in _read(
        email.text
    )
    # The pass card shows the window as two figures under their labels, and the zone under them.
    html = _plain(email.html)
    assert "Check in from 09:00 Pass expires 12:00 Amman time, UTC+3" in html
    assert f'<img src="cid:{QR_CONTENT_ID}"' in email.html
    assert 'alt="QR code of your visitor pass for Acme Holding"' in email.html
    assert "<" not in email.text
    assert "Asia/Amman" not in email.html and "Asia/Amman" not in email.text  # no IANA identifiers
    # No internal identifiers.
    for internal in (job.email.message_id, company.id):
        assert str(internal) not in email.html and str(internal) not in email.text
    assert email.pass_url == pass_url
    # A company without a logo: the QR code is the message's only image (B12-12).
    assert [image.content_id for image in email.inline_images] == [QR_CONTENT_ID]


def test_invitation_opens_the_pass_with_a_button_in_each_language_and_shows_the_link_as_small_print() -> None:
    html = _invitation(_company()).email.html
    pass_url = f"https://vms.test/pass?c=acme#{TOKEN}"
    # Two links to the pass: the card's button (leading language) and the other language's button.
    assert html.count(f'href="{pass_url}"') == 2
    assert re.search(rf'<a href="{re.escape(pass_url)}"[^>]*>Open my visitor pass</a>', html)
    assert re.search(rf'<a href="{re.escape(pass_url)}"[^>]*>عرض بطاقة الزيارة</a>', html)
    assert "If the button does not work, copy this link into your browser:" in html
    assert "إن لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:" in html
    # The address itself is muted, left-to-right text under the buttons, not link text.
    small_print = re.findall(
        rf'<p dir="ltr" class="vmt" style="[^"]*font-size:12px;[^"]*">{re.escape(pass_url)}</p>', html
    )
    assert len(small_print) == 2
    # The purpose label stays short; its source is a note beside it.
    assert "Purpose (as provided by your host)" not in html
    assert re.search(r'>Purpose \(<span dir="ltr">provided by your host</span>\)</span>', html)


@pytest.mark.parametrize(
    ("notify_host", "promise", "promise_ar"),
    [
        (
            True,
            "Reception will check you in and let Omar Khalil know that you have arrived.",
            "سيسجّل الاستقبال دخولك ويُعلم Omar Khalil بقدومك.",
        ),
        (
            False,
            "Reception will check you in and contact your host.",
            "سيسجّل الاستقبال دخولك ويتواصل مع مضيفك.",
        ),
    ],
)
def test_invitation_promises_a_host_notification_only_when_the_company_sends_one(
    notify_host: bool, promise: str, promise_ar: str
) -> None:
    email = _invitation(_company(notify_host_on_check_in=notify_host)).email
    for body in (_plain(email.html), _read(email.text)):
        assert promise in body and promise_ar in body
        assert ("know that you have arrived" in body) is notify_host


def test_visitor_replies_reach_the_host() -> None:
    company = _company()
    service = _service()
    jobs = [
        service.queue_visitor_invitation(
            _visit(company), TOKEN, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        ),
        service.queue_visit_rescheduled(
            _visit(company), company=company, recipient="d@example.com", host_email=HOST_EMAIL
        ),
        service.queue_visit_cancelled(
            _visit(company), None, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        ),
    ]
    for job in jobs:
        assert job.email.reply_to == HOST_EMAIL
        for body in (_plain(job.email.html), _read(job.email.text)):
            assert "eply to this email to reach Omar Khalil." in body
            assert "ردّ على هذه الرسالة للتواصل مع Omar Khalil." in body
            assert "do not reply" not in body and "عدم الرد" not in body
    assert "Questions, or running late? Reply to this email to reach Omar Khalil." in jobs[0].email.text


def test_a_deployment_reply_address_takes_every_reply() -> None:
    company = _company()
    job = _invitation(company, service=_service(email_reply_to="reception@demo.test"))
    assert job.email.reply_to == "reception@demo.test"
    assert "Questions, or running late? Reply to this email." in job.email.text
    assert "لديك سؤال أو ستتأخر؟ ردّ على هذه الرسالة." in job.email.text
    assert "do not reply" not in job.email.text


def test_without_anyone_to_reply_to_the_visitor_is_pointed_elsewhere() -> None:
    """A cancellation because the host left (D-18): no active host, no deployment reply address."""
    company = _company()
    email = (
        _service()
        .queue_visit_cancelled(
            _visit(company),
            "Host is no longer available",
            company=company,
            recipient="d@example.com",
            host_email=None,
        )
        .email
    )
    assert email.reply_to is None
    for body in (_plain(email.html), _read(email.text)):
        assert "If you have any questions, please contact Acme Holding." in body
        assert "إن كان لديك أي سؤال، يُرجى التواصل مع أكمي القابضة." in body
        assert "Please do not reply to this email." in body
        assert "يُرجى عدم الرد على هذه الرسالة." in body


def test_hostile_input_is_escaped() -> None:
    company = _company(
        name='ACME "Evil" & Co <b>',
        name_ar='<script>alert("ar")</script>',
        address="<script>alert(1)</script>",
    )
    visit = _visit(
        company,
        visitor_name='<img src=x onerror="alert(1)">',
        host_name="</td></tr></table><a href='https://evil.example'>click</a>",
        department_name="<style>*{display:none}</style>",
        purpose='"><svg onload=alert(2)>',
    )
    html = (
        _service()
        .queue_visitor_invitation(
            visit, TOKEN, company=company, recipient="x@example.com", host_email=HOST_EMAIL
        )
        .email.html
    )
    for raw in ("<img src=x", "<script>", "</td></tr></table><a", "<style>*", "<svg", "<b>"):
        assert raw not in html, raw
    assert "&lt;img src=x onerror=&#34;alert(1)&#34;&gt;" in html
    assert "ACME &#34;Evil&#34; &amp; Co &lt;b&gt;" in html
    assert "&lt;script&gt;alert(&#34;ar&#34;)&lt;/script&gt;" in html
    for template in ("rescheduled", "cancelled"):
        rendered = (
            _service().queue_visit_rescheduled(
                visit, company=company, recipient="x@example.com", host_email=HOST_EMAIL
            )
            if template == "rescheduled"
            else _service().queue_visit_cancelled(
                visit, "<i>no</i>", company=company, recipient="x@example.com", host_email=HOST_EMAIL
            )
        ).email.html
        assert "<img src=x" not in rendered and "<script>" not in rendered and "<i>no</i>" not in rendered


def test_header_values_cannot_be_injected() -> None:
    company = _company(name="Demo\r\nBcc: victim@example.com", name_ar="عربي\u2028Bcc: victim@example.com")
    visit = _visit(company, visitor_name="Guest\r\nX-Injected: 1")
    job = _service().queue_visitor_invitation(
        visit,
        TOKEN,
        company=company,
        recipient=" dana@example.com\r\n",
        host_email=f"{HOST_EMAIL}\r\nBcc: x@y",
    )
    assert "\r" not in job.email.subject and "\n" not in job.email.subject
    assert "\u2028" not in job.email.subject
    assert job.email.to == "dana@example.com"
    assert (
        job.email.reply_to is not None and "\n" not in job.email.reply_to and "\r" not in job.email.reply_to
    )
    host = User(id=uuid.uuid4(), full_name="Omar", email="omar@demo.test")
    arrival = _service().queue_host_arrival(
        _visit(company, visitor_name="Guest\r\nBcc: x@y", check_in_at=START), company=company, host=host
    )
    assert "\n" not in arrival.email.subject


# ---- the other visit e-mails -------------------------------------------------------------------------


def test_rescheduled_email_has_no_qr_and_keeps_the_pass() -> None:
    company = _company()
    visit = _visit(
        company, scheduled_start=START + timedelta(days=1), scheduled_end=START + timedelta(days=1, hours=2)
    )
    visit.window_start, visit.window_end = (
        START + timedelta(days=1, hours=-1),
        START + timedelta(days=1, hours=3),
    )
    email = (
        _service()
        .queue_visit_rescheduled(visit, company=company, recipient="dana@example.com", host_email=HOST_EMAIL)
        .email
    )
    assert (
        email.subject == "Your visit to Acme Holding has been rescheduled | تغيّر موعد زيارتك إلى أكمي القابضة"
    )
    assert email.inline_images == ()  # no QR code, and this company has no logo
    assert "cid:" not in email.html and email.pass_url is None
    for body in (_plain(email.html), _read(email.text)):
        assert "Your existing QR code remains valid." in body
        assert "Tuesday, 6 October 2026" in body and "10:00 \N{EN DASH} 12:00" in body
        assert "You can now check in from 09:00. Your pass expires at 13:00 (Amman time)." in body
        assert "رمز QR الذي لديك ما زال صالحًا." in body
        assert "الثلاثاء، 6 تشرين الأول 2026" in body
        assert (
            "يمكنك الآن تسجيل الدخول ابتداءً من 09:00، وتنتهي صلاحية بطاقتك عند 13:00 (بتوقيت عمّان)." in body
        )


@pytest.mark.parametrize("reason", ["Meeting moved online", None])
def test_cancelled_email(reason: str | None) -> None:
    company = _company()
    email = (
        _service()
        .queue_visit_cancelled(
            _visit(company), reason, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        )
        .email
    )
    assert email.subject == "Your visit to Acme Holding has been cancelled | أُلغيت زيارتك إلى أكمي القابضة"
    for body in (_plain(email.html), _read(email.text)):
        assert "has been cancelled" in body and "no longer valid" in body
        assert "لم تعد بطاقة الزيارة الخاصة بهذه الزيارة صالحة." in body
        assert ("Reason given" in body) is (reason is not None)
        assert ("السبب المذكور" in body) is (reason is not None)
        if reason:
            assert body.count(reason) == 2  # in each language's section


def test_host_arrival_email() -> None:
    company = _company()
    host = User(id=uuid.uuid4(), full_name="Omar Khalil", email="omar@demo.test")
    visit = _visit(company, check_in_at=START + timedelta(minutes=3))
    job = _service().queue_host_arrival(visit, company=company, host=host)
    assert job.email.to == "omar@demo.test" and job.email.subject == "Your visitor Dana Guest has arrived"
    assert job.email.reply_to is None
    for body in (_plain(job.email.html), _read(job.email.text)):
        assert (
            "Your visitor Dana Guest has arrived and checked in at reception at 10:03 (Amman time)." in body
        )
        assert "زائرك Dana Guest في الاستقبال، وقد سُجّل الدخول الساعة 10:03 (بتوقيت عمّان)." in body
        assert "Acme" in body and "Quarterly review" in body
        assert "Monday, 5 October 2026, 10:00 \N{EN DASH} 11:00" in body
        assert "الاثنين، 5 تشرين الأول 2026، 10:00 \N{EN DASH} 11:00" in body
    with pytest.raises(ValueError, match="checked-in"):
        _service().queue_host_arrival(_visit(company), company=company, host=host)


# ---- languages (B10-7 to B10-9) ----------------------------------------------------------------------


def test_visitor_emails_lead_with_the_company_default_language() -> None:
    arabic = _company(default_language="ar")
    service = _service()
    visit = _visit(arabic)
    emails = [
        service.queue_visitor_invitation(
            visit, TOKEN, company=arabic, recipient="d@example.com", host_email=HOST_EMAIL
        ).email,
        service.queue_visit_rescheduled(
            visit, company=arabic, recipient="d@example.com", host_email=None
        ).email,
        service.queue_visit_cancelled(
            visit, None, company=arabic, recipient="d@example.com", host_email=None
        ).email,
    ]
    for email in emails:
        assert email.html.startswith('<!DOCTYPE html>\n<html lang="ar" dir="rtl"')
        assert _leading_language(email.html) == "ar"
        # The subject names both languages, the company's first.
        arabic_subject, english_subject = email.subject.split(" | ")
        assert "أكمي القابضة" in arabic_subject and "Acme Holding" in english_subject
        # Arabic first in both bodies.
        for body in (_plain(email.html), _read(email.text)):
            assert body.index("مرحبًا Dana Guest،") < body.index("Hello Dana Guest,")
    assert emails[0].subject.startswith("زيارتك إلى أكمي القابضة يوم الاثنين، 5 تشرين الأول 2026 | ")
    english = _invitation(_company()).email
    assert english.html.startswith('<!DOCTYPE html>\n<html lang="en" dir="ltr"')
    assert _leading_language(english.html) == "en"
    assert english.text.index("Hello Dana Guest,") < _read(english.text).index("مرحبًا Dana Guest،")


def test_every_language_section_declares_its_direction() -> None:
    html = _invitation(_company(default_language="ar")).email.html
    sections = _sections(html).languages
    assert {language for language, _ in sections} == {"ar", "en"}
    for language, direction in sections:
        if direction is not None:
            assert direction == ("rtl" if language == "ar" else "ltr"), (language, direction)
    # Arabic sections align to the right, English ones to the left.
    assert re.search(r'dir="rtl" lang="ar" align="right"', html)
    assert re.search(r'dir="ltr" lang="en" align="left"', html)


def test_arabic_text_uses_latin_digits_and_levantine_months() -> None:
    email = _invitation(_company(default_language="ar")).email
    for body in (email.subject, email.html, email.text):
        assert not ARABIC_INDIC_DIGITS.search(body)
    assert "تشرين الأول" in _read(email.text) and "October" in email.text


def test_the_arabic_text_falls_back_to_the_company_name() -> None:
    company = _company(name_ar=None, default_language="ar")
    email = _invitation(company).email
    assert email.subject.startswith("زيارتك إلى Acme Holding يوم ")
    assert "زيارتك إلى Acme Holding" in _read(email.text)


@pytest.mark.parametrize(
    ("company_language", "preference", "expected"),
    [("ar", None, "ar"), ("en", None, "en"), ("en", "ar", "ar"), ("ar", "en", "en")],
)
def test_staff_emails_lead_with_the_recipients_language(
    company_language: str, preference: str | None, expected: str
) -> None:
    company = _company(default_language=company_language)
    host = User(
        id=uuid.uuid4(), full_name="Omar Khalil", email="omar@demo.test", preferred_language=preference
    )
    user = User(
        id=uuid.uuid4(),
        company_id=company.id,
        full_name="Amal Haddad",
        email="amal@demo.test",
        preferred_language=preference,
    )
    user.company = company
    service = _service()
    arrival = service.queue_host_arrival(
        _visit(company, check_in_at=START + timedelta(minutes=3)), company=company, host=host
    ).email
    reset = service.queue_password_reset(user, TOKEN).email
    changed = service.queue_password_changed(user, how="reset", when=START, ip_address=None).email
    subjects = {
        "ar": ("زائرك Dana Guest في الاستقبال", "إعادة تعيين كلمة مرور حسابك في أكمي القابضة"),
        "en": ("Your visitor Dana Guest has arrived", "Reset your Acme Holding account password"),
    }
    # A staff subject is in the recipient's language only.
    assert (arrival.subject, reset.subject) == subjects[expected]
    assert changed.subject == (
        "تمت إعادة تعيين كلمة مرور حسابك في أكمي القابضة"
        if expected == "ar"
        else "Your Acme Holding account password was reset"
    )
    for email in (arrival, reset, changed):
        assert _leading_language(email.html) == expected
        # The other language follows.
        assert "Hello " in email.text and "مرحبًا " in email.text


def test_password_reset_in_arabic_counts_minutes_the_arabic_way() -> None:
    company = _company(default_language="ar")
    user = User(id=uuid.uuid4(), company_id=company.id, full_name="Amal Haddad", email="amal@demo.test")
    user.company = company
    email = _service().queue_password_reset(user, TOKEN).email
    assert "تنتهي صلاحية هذا الرابط خلال 30 دقيقة، ويمكن استخدامه مرة واحدة." in email.text
    assert "This link expires in 30 minutes and can be used once." in email.text
    # The company's own reset page (B12-14): its slug in the query, the token alone in the fragment.
    assert email.reset_url == f"https://vms.test/reset-password?c=acme#token={TOKEN}"
    assert email.html.count(f'href="{email.reset_url}"') == 2  # a button in each language


def test_a_company_s_e_mail_is_sent_by_the_company_and_names_nobody_else() -> None:
    """B12-12: the footer and the first line of the text part name the company, in each language's own
    name of it, and never the product."""
    both = _read(_invitation(_company(name="Mawdoo3", name_ar="موضوع")).email.text)
    assert both.startswith("Mawdoo3 | موضوع\n")
    assert both.endswith("--\nSent by Mawdoo3.\nأُرسلت من موضوع.\n")
    other = _invitation(_company(name="Other Corp", name_ar=None)).email
    text = _read(other.text)
    assert text.startswith("Other Corp\n")  # one name: said once
    assert text.endswith("--\nSent by Other Corp.\nأُرسلت من Other Corp.\n")
    html = _plain(other.html)
    assert "Sent by Other Corp." in html and "أُرسلت من Other Corp." in html
    for body in (both, text, html):
        assert "on behalf of" not in body and "نيابةً عن" not in body
        assert "visitor management" not in body.lower()


def _platform_notice(company: Company, service: EmailService | None = None, action: str = "admin_added"):
    """The notice to a company's administrators of what the platform owner did (B11-43)."""
    user = User(id=uuid.uuid4(), company_id=company.id, full_name="Amal Haddad", email="amal@demo.test")
    user.company = company
    about = User(id=uuid.uuid4(), company_id=company.id, full_name="Lina Saleh", email="lina@demo.test")
    return (
        (service or _service())
        .queue_platform_notice(user, action=action, about=about, when=START)  # type: ignore[arg-type]
        .email
    )


def test_the_notice_of_a_platform_action_is_sent_by_the_company_like_every_other_e_mail() -> None:
    """B12-22: it used to be the product's e-mail ("Mawdoo3 Visitors | زوار موضوع", "Sent by Mawdoo3
    Visitors on behalf of Other Corp.", EMAIL_FROM's own name). Nothing of the product reaches a
    company's people: the notice is headed, signed and sent in the company's name."""
    other = _platform_notice(_company(name="Other Corp", name_ar=None))
    text = _read(other.text)
    assert text.startswith("Other Corp\n")
    assert text.endswith(
        "--\nSent by Other Corp. Please do not reply to this email.\n"
        "أُرسلت من Other Corp. يُرجى عدم الرد على هذه الرسالة.\n"
    )
    assert "Sent by Other Corp." in _plain(other.html) and "أُرسلت من Other Corp." in _plain(other.html)
    assert other.sender == '"Other Corp" <visitors@demo.test>'  # the company's name, the configured address
    for part in (other.subject, other.sender, other.html, other.text):
        assert "Mawdoo3" not in part and "موضوع" not in part and "Demo Visitors" not in part
        assert "on behalf of" not in part and "نيابةً عن" not in part
    # Who acted is said in words, by role.
    assert "The platform owner added a new administrator account to Other Corp" in text
    assert "أضاف مالك المنصة حسابًا جديدًا لمدير نظام في Other Corp" in text


@pytest.mark.parametrize(
    ("name", "name_ar"),
    [("Mawdoo3", None), ("MAWDOO3", "موضوع"), ("Mawdoo3 Labs", "موضوع"), ("موضوع", None)],
)
def test_a_company_that_carries_the_brand_s_name_is_a_company_like_any_other(
    name: str, name_ar: str | None
) -> None:
    """The product's sentence had a special case for the brand's own company. A company's e-mail has
    none: whatever a company is called, its notice says "Sent by <that company>." and nothing else."""
    text = _read(_platform_notice(_company(name=name, name_ar=name_ar)).text)
    assert f"Sent by {name}." in text and f"أُرسلت من {name_ar or name}." in text
    assert "Visitors" not in text and "زوار" not in text


def test_a_company_name_ending_with_a_full_stop_gives_one_full_stop() -> None:
    """The pre-existing "on behalf of ACME Inc.." (B10-15's note) is fixed in every sentence (B10-19)."""
    company = _company(name="ACME Inc.", name_ar=None)
    email = _invitation(company).email
    for body in (_read(email.text), _plain(email.html)):
        assert "Sent by ACME Inc." in body
        assert "ACME Inc.." not in body
        assert "has invited you to visit ACME Inc." in body
    notice = _platform_notice(company)
    for body in (_read(notice.text), _plain(notice.html)):
        assert "Sent by ACME Inc." in body
        assert "ACME Inc.." not in body


def test_the_product_and_the_brand_come_from_the_settings() -> None:
    """They name the product's own test e-mail (the CLI's); no e-mail of a company changes with them
    (B12-12, B12-22)."""
    service = _service(
        brand_name_en="Acme",
        brand_name_ar="أكمي",
        product_name_en="Acme Visits",
        product_name_ar="زيارات أكمي",
    )
    test_email = build_test_email(service.settings, EmailRenderer(), "ops@example.com", now=START)
    text = _read(test_email.text)
    assert text.startswith("زيارات أكمي | Acme Visits\n")
    assert "Sent by Acme Visits." in text and "أُرسلت عبر زيارات أكمي." in text
    # The logo's text alternative is the brand (what the logo shows), not the product.
    assert 'alt="أكمي"' in test_email.html
    company = _company(name="Mawdoo3", name_ar="موضوع")
    for email in (_invitation(company, service=service).email, _platform_notice(company, service)):
        for body in (email.subject, email.html, email.text, email.sender):
            assert "Acme" not in body and "أكمي" not in body


# ---- values isolated from the sentences around them (B10-14) ---------------------------------------
# The reviewer's cases: ordinary English values in an Arabic-led e-mail. Without isolation the full stop
# of "Quarterly budget review." and of "John Smith Jr." moved to the wrong end, and the IPv6 address of a
# password notice was shown as "db8:85a3::8a2e:370:7334:2001".

ARABIC_LED = {"name": "ACME Inc.", "name_ar": None, "default_language": "ar"}


def _english_values_visit(company: Company, **changes) -> Visit:
    values = {"visitor_name": "John Smith Jr.", "visitor_company_name": "ACME Inc."}
    values |= {"purpose": "Quarterly budget review.", "check_in_at": START + timedelta(minutes=3)}
    return _visit(company, **(values | changes))


def _arabic_section(html: str) -> str:
    """The HTML of the Arabic part of an Arabic-led e-mail: from its first section to the English one."""
    return html[html.index('lang="ar" align="right"') : html.index('lang="en" align="left"')]


def test_arabic_sentences_isolate_the_names_and_companies_in_them() -> None:
    company = _company(**ARABIC_LED)
    email = (
        _service()
        .queue_visitor_invitation(
            _english_values_visit(company),
            TOKEN,
            company=company,
            recipient="d@example.com",
            host_email=HOST_EMAIL,
            booked_by="Lina Saleh Sr.",
        )
        .email
    )
    arabic = _arabic_section(email.html)
    assert 'مرحبًا <span dir="ltr">John Smith Jr.</span>،' in arabic
    assert (
        'تلقّيت دعوةً من <span dir="ltr">Lina Saleh Sr.</span> نيابةً عن <span dir="ltr">Omar Khalil</span> '
        'لزيارة <span dir="ltr">ACME Inc.</span></p>'
    ) in arabic  # the company's own full stop ends the sentence (B10-19)
    assert f"مرحبًا {FSI}John Smith Jr.{PDI}،" in email.text
    assert f"لزيارة {FSI}ACME Inc.{PDI}\n" in email.text
    # The footer names the company the same way.
    assert 'أُرسلت من <span dir="ltr">ACME Inc.</span></p>' in email.html
    assert f"أُرسلت من {FSI}ACME Inc.{PDI}\n" in email.text
    # The QR code's alternative text is an attribute: isolate characters, never markup.
    alt = re.search(r'<img src="cid:visitor-pass-qr"[^>]* alt="([^"]*)"', email.html)
    assert alt is not None and alt.group(1) == f"رمز QR لبطاقة زيارتك إلى {FSI}ACME Inc.{PDI}"
    # Subjects are headers and stay as they were.
    assert not ISOLATES.search(email.subject) and "<span" not in email.subject


def test_arabic_details_show_each_value_in_its_own_direction() -> None:
    company = _company(**ARABIC_LED)
    visit = _english_values_visit(company)
    email = (
        _service()
        .queue_visitor_invitation(visit, TOKEN, company=company, recipient="d@example.com", host_email=None)
        .email
    )
    arabic = _arabic_section(email.html)
    # Every value of the grid is a block with its own direction: an English purpose keeps its full stop at
    # its end, an Arabic date reads right to left; the note beside a label gets its own direction too.
    assert re.search(
        r'<span dir="ltr" class="vik" style="display:block;[^"]*">Quarterly budget review\.</span>',
        arabic,
    )
    assert re.search(r'<span dir="ltr" class="vik" style="display:block;[^"]*">Omar Khalil</span>', arabic)
    assert re.search(
        f'<span dir="rtl" class="vik" style="display:block;[^"]*">'
        f"الاثنين، 5{NB}تشرين{NB}الأول{NB}2026</span>",
        arabic,
    )
    assert 'الغرض من الزيارة (<span dir="rtl">كما ذكره مضيفك</span>)' in arabic
    # The plain-text part: each value of a "Label: value" line isolated, line by line for an address.
    assert f"الغرض من الزيارة (كما ذكره مضيفك): {FSI}Quarterly budget review.{PDI}\n" in email.text
    assert f"المضيف: {FSI}Omar Khalil{PDI}\n" in email.text
    assert f"العنوان: {FSI}Building 14{PDI}\n{FSI}King Abdullah II Street, Amman{PDI}\n" in email.text
    # Dates and times are written in the sentence's own language and are left as they are: an Arabic time
    # range reads right to left with its line.
    assert f"التاريخ: الاثنين، 5{NB}تشرين{NB}الأول{NB}2026\n" in email.text
    assert f"الوقت: 10:00{RANGE}11:00 (بتوقيت{NB}عمّان،{NB}UTC+3)\n" in email.text


def test_the_host_arrival_notice_isolates_the_visitor_for_an_arabic_reader() -> None:
    company = _company(**ARABIC_LED)
    host = User(id=uuid.uuid4(), full_name="Omar Khalil", email="o@demo.test", preferred_language="ar")
    email = _service().queue_host_arrival(_english_values_visit(company), company=company, host=host).email
    arabic = _arabic_section(email.html)
    assert 'زائرك <span dir="ltr">John Smith Jr.</span> في الاستقبال، وقد سُجّل الدخول' in arabic
    assert re.search(r'<span dir="ltr" class="vik" style="display:block;[^"]*">ACME Inc\.</span>', arabic)
    assert f"الشركة: {FSI}ACME Inc.{PDI}\n" in email.text
    assert f"الزائر: {FSI}John Smith Jr.{PDI}\n" in email.text
    assert email.subject == "زائرك John Smith Jr. في الاستقبال"


def test_the_security_notice_shows_an_ipv6_address_left_to_right_in_arabic() -> None:
    company = _company(**ARABIC_LED)
    user = User(id=uuid.uuid4(), company_id=company.id, full_name="Omar Khalil", email="o@demo.test")
    user.company = company
    address = "2001:db8:85a3::8a2e:370:7334"
    email = _service().queue_password_changed(user, how="changed", when=START, ip_address=address).email
    assert f'من عنوان الشبكة <span dir="ltr">{address}</span>. ' in _arabic_section(email.html)
    assert f"من عنوان الشبكة {LRI}{address}{PDI}. " in email.text
    # English is left to right already: the address is printed as it is.
    assert f"from the network address {address}. You were signed out" in email.text
    assert f"from the network address {address}. You were signed out" in email.html


def test_english_sections_keep_latin_values_as_they_were_and_isolate_arabic_ones() -> None:
    """The E2E suite reads `Hello <name>`, `Host: <name>`, `Department: <name>`, the purpose and
    `Your visitor <name> has arrived and checked in` from the text part: with Latin values the English
    part has no isolate character."""
    company = _company(default_language="ar")
    visit = _visit(company, check_in_at=START + timedelta(minutes=3))
    service = _service()
    invitation = service.queue_visitor_invitation(
        visit, TOKEN, company=company, recipient="d@example.com", host_email=HOST_EMAIL
    ).email
    host = User(id=uuid.uuid4(), full_name="Omar Khalil", email="o@demo.test", preferred_language="en")
    arrival = service.queue_host_arrival(visit, company=company, host=host).email
    english_text = invitation.text[invitation.text.index("\nEnglish\n") :]
    assert not ISOLATES.search(english_text.split("\n--\n")[0])
    for expected in ("Hello Dana Guest,", "Host: Omar Khalil", "Department: Finance", "Quarterly review"):
        assert expected in invitation.text
    assert "Your visitor Dana Guest has arrived and checked in" in arrival.text
    # An Arabic name in an English sentence is isolated (right to left) in both parts.
    arabic_name = "هند الخطيب"
    email = service.queue_visitor_invitation(
        _visit(company, visitor_name=arabic_name),
        TOKEN,
        company=company,
        recipient="d@example.com",
        host_email=HOST_EMAIL,
    ).email
    assert f'Hello <span dir="rtl">{arabic_name}</span>,' in email.html
    assert f"Hello {FSI}{arabic_name}{PDI}," in email.text
    assert f'مرحبًا <span dir="rtl">{arabic_name}</span>،' in email.html


def test_an_isolated_value_cannot_break_out_of_its_span() -> None:
    company = _company(**ARABIC_LED)
    hostile = '</span><a href="https://evil.example">x</a>'
    email = (
        _service()
        .queue_visitor_invitation(
            _visit(company, visitor_name=hostile),
            TOKEN,
            company=company,
            recipient="d@example.com",
            host_email=HOST_EMAIL,
        )
        .email
    )
    assert '<a href="https://evil.example"' not in email.html
    assert (
        'مرحبًا <span dir="ltr">&lt;/span&gt;&lt;a href=&#34;https://evil.example&#34;&gt;x&lt;/a&gt;</span>،'
        in (email.html)
    )


# ---- the department and the address in each language (B10-26) ---------------------------------------
# The Arabic part shows the department's Arabic name and the company's Arabic address when they are set,
# the English part the department's name and the address. People's names, companies and purposes stay as
# typed.

SEPARATOR = "\n----------------------------------------\n"
ARABIC_ADDRESS = "مبنى رقم 14" + "\n" + "عمّان"


def _html_part(html: str, language: str) -> str:
    """The HTML of one language's part: from its first section to the other language's, or to the end."""
    other = "en" if language == "ar" else "ar"
    start, other_start = html.index(f'lang="{language}" align='), html.index(f'lang="{other}" align=')
    return html[start:other_start] if other_start > start else html[start:]


def _text_part(text: str, language: str, lead: str) -> str:
    """The plain text of one language's part: the leading one before the separator, the other after it."""
    return text[: text.index(SEPARATOR)] if language == lead else text[text.rindex(SEPARATOR) :]


@pytest.mark.parametrize("lead", ["ar", "en"])
@pytest.mark.parametrize("kind", ["invitation", "rescheduled"])
def test_each_language_shows_the_department_and_the_address_in_its_own_language(lead: str, kind: str) -> None:
    company = _company(default_language=lead, address_ar=ARABIC_ADDRESS)
    visit = _visit(company, department_name_ar="المالية")
    service = _service()
    if kind == "invitation":
        email = service.queue_visitor_invitation(
            visit, TOKEN, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        ).email
    else:
        email = service.queue_visit_rescheduled(
            visit, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        ).email
    arabic_html, english_html = _html_part(email.html, "ar"), _html_part(email.html, "en")
    assert re.search(r'<span dir="rtl" class="vik" style="display:block;[^"]*">المالية</span>', arabic_html)
    assert re.search(r'<span dir="ltr" class="vik" style="display:block;[^"]*">Finance</span>', english_html)
    assert re.search(
        f'<span dir="rtl" class="vik" style="display:block;[^"]*">{ARABIC_ADDRESS}</span>', arabic_html
    )
    assert re.search(
        r'<span dir="ltr" class="vik" style="display:block;[^"]*">'
        r"Building 14\nKing Abdullah II Street, Amman</span>",
        english_html,
    )
    assert "Finance" not in _plain(arabic_html) and "King Abdullah" not in arabic_html
    assert "المالية" not in english_html and "عمّان" not in english_html
    arabic_text, english_text = _text_part(email.text, "ar", lead), _text_part(email.text, "en", lead)
    assert f"القسم: {FSI}المالية{PDI}\n" in arabic_text
    assert f"العنوان: {FSI}مبنى رقم 14{PDI}\n{FSI}عمّان{PDI}\n" in arabic_text
    # The English part is exactly what it was (the E2E suite reads `Department: <name>`).
    assert "Department: Finance\n" in english_text
    assert "Address: Building 14\nKing Abdullah II Street, Amman\n" in english_text
    assert "المالية" not in english_text and "Finance" not in arabic_text


def test_without_arabic_values_both_languages_show_the_department_s_name_and_the_address() -> None:
    company = _company(default_language="ar")
    email = _invitation(company).email
    arabic_text, english_text = _text_part(email.text, "ar", "ar"), _text_part(email.text, "en", "ar")
    assert f"القسم: {FSI}Finance{PDI}\n" in arabic_text
    assert f"العنوان: {FSI}Building 14{PDI}\n{FSI}King Abdullah II Street, Amman{PDI}\n" in arabic_text
    assert "Department: Finance\n" in english_text
    assert "Address: Building 14\nKing Abdullah II Street, Amman\n" in english_text
    # No department, no address: neither line in either language.
    bare = (
        _service()
        .queue_visitor_invitation(
            _visit(_company(address=None), department_name=None),
            TOKEN,
            company=_company(address=None),
            recipient="d@example.com",
            host_email=HOST_EMAIL,
        )
        .email
    )
    for absent in ("Department:", "Address:", "القسم:", "العنوان:"):
        assert absent not in bare.text
    assert ">Department<" not in bare.html and ">القسم<" not in bare.html


def test_an_address_given_in_arabic_only_reaches_the_english_reader_too() -> None:
    """A visitor who reads English must still learn where to go: without an English address the English
    part shows the Arabic one, isolated in its own direction."""
    company = _company(default_language="ar", address=None, address_ar="عمّان")
    email = _invitation(company).email
    assert f"Address: {FSI}عمّان{PDI}\n" in _text_part(email.text, "en", "ar")
    assert f"العنوان: {FSI}عمّان{PDI}\n" in _text_part(email.text, "ar", "ar")


def test_an_arabic_department_name_is_one_line_and_escaped() -> None:
    """Stored names are one line (SEC-34); a row stored otherwise still prints one line, and markup in an
    Arabic name is text."""
    company = _company(default_language="ar")
    visit = _visit(company, department_name_ar="المالية" + "\n" + "الشركة: <b>x</b>")
    email = (
        _service()
        .queue_visitor_invitation(
            visit, TOKEN, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        )
        .email
    )
    assert f"القسم: {FSI}المالية الشركة: <b>x</b>{PDI}\n" in email.text
    assert "<b>x</b>" not in email.html and "الشركة: &lt;b&gt;x&lt;/b&gt;" in email.html


def test_the_subject_and_the_people_s_names_do_not_change_with_the_arabic_department() -> None:
    company = _company(default_language="ar", address_ar=ARABIC_ADDRESS)
    plain = _invitation(company).email
    bilingual = (
        _service()
        .queue_visitor_invitation(
            _visit(company, department_name_ar="المالية"),
            TOKEN,
            company=company,
            recipient="dana@example.com",
            host_email=HOST_EMAIL,
        )
        .email
    )
    assert bilingual.subject == plain.subject
    for typed in ("Dana Guest", "Omar Khalil", "Quarterly review"):
        assert typed in _text_part(bilingual.text, "ar", "ar") and typed in _text_part(
            bilingual.text, "en", "ar"
        )


# ---- whose logo and name head an e-mail (B10-6, B12-12) ----------------------------------------------


def _all_emails(company: Company, service: EmailService | None = None, **visit_values):
    """Every e-mail a company's people and visitors receive: the four visit e-mails, the two about a
    user's password, and the two notices of what the platform owner did (B12-22)."""
    service = service or _service()
    visit = _visit(company, **({"check_in_at": START + timedelta(minutes=3)} | visit_values))
    user = User(id=uuid.uuid4(), company_id=company.id, full_name="Amal Haddad", email="amal@demo.test")
    user.company = company
    about = User(id=uuid.uuid4(), company_id=company.id, full_name="Lina Saleh", email="lina@demo.test")
    host = User(id=uuid.uuid4(), full_name="Omar Khalil", email="omar@demo.test")
    return [
        service.queue_visitor_invitation(
            visit, TOKEN, company=company, recipient="d@example.com", host_email=HOST_EMAIL
        ).email,
        service.queue_visit_rescheduled(
            visit, company=company, recipient="d@example.com", host_email=None
        ).email,
        service.queue_visit_cancelled(
            visit, "x", company=company, recipient="d@example.com", host_email=None
        ).email,
        service.queue_host_arrival(visit, company=company, host=host).email,
        service.queue_password_reset(user, TOKEN).email,
        service.queue_password_changed(user, how="changed", when=START, ip_address="198.51.100.7").email,
        service.queue_platform_notice(user, action="admin_added", about=about, when=START).email,
        service.queue_platform_notice(user, action="reset_sent", about=about, when=START).email,
    ]


# A company's own logo (900 x 300), and one as wide as a logo is shown (1200 x 300). Since Phase 13 an
# e-mail carries their renditions (B13-2): the logo on its white plate, PLATE pixels on every side.
COMPANY_LOGO = make_png(900, 300)
WIDE_LOGO = make_png(1200, 300)
# Bytes that are no image: a logo that cannot be drawn is sent as it was stored (B13-2).
UNDRAWABLE_LOGO = b"\x89PNG\r\n\x1a\n a company's own logo"


def _header_logos(html: str) -> list[dict[str, str | None]]:
    return [image for image in _sections(html).images if image["src"] == f"cid:{LOGO_CONTENT_ID}"]


@pytest.mark.parametrize("language", ["ar", "en"])
def test_a_company_s_e_mails_carry_its_own_logo_inline(language: str) -> None:
    """B12-12: the company's logo, never the product's; shown inside the header's box with its
    proportions; its text alternative is the company's name in the leading language. Since Phase 13
    (B13-2) the logo travels as its light rendition, on a white plate that the size shown includes."""
    company = _company(default_language=language)
    service = _service(logos=CompanyLogos(COMPANY_LOGO, 900, 300))
    for email in _all_emails(company, service):
        images = {image.content_id: image for image in email.inline_images}
        assert images[LOGO_CONTENT_ID].content == light_rendition(COMPANY_LOGO).content
        assert images[LOGO_CONTENT_ID].content not in (COMPANY_LOGO, brand_logo().content)
        assert images[LOGO_CONTENT_ID].mime_type == "image/png"
        # Every `cid:` the HTML refers to is attached, and every attachment is referred to.
        referenced = set(re.findall(r'src="cid:([^"]+)"', email.html))
        assert referenced == set(images), email.kind
        [logo] = _header_logos(email.html)
        # 900 x 300 inside 168 x 44 is 132 x 44, and the plate around it.
        assert (logo["width"], logo["height"]) == (str(132 + 2 * PLATE), str(44 + 2 * PLATE))
        assert logo["alt"] == ("أكمي القابضة" if language == "ar" else "Acme Holding")


@pytest.mark.parametrize("language", ["ar", "en"])
def test_a_logo_that_cannot_be_drawn_is_sent_as_it_was_stored(language: str) -> None:
    """No stored logo should fail to decode (each passed the same check at upload); if one ever did, the
    e-mail still goes, with the stored bytes, without a plate and without a dark rendition (B13-2)."""
    company = _company(default_language=language)
    service = _service(logos=CompanyLogos(UNDRAWABLE_LOGO, 900, 300, dark=COMPANY_LOGO))
    for email in _all_emails(company, service):
        assert [image.content for image in email.inline_images if image.content_id != QR_CONTENT_ID] == [
            UNDRAWABLE_LOGO
        ]
        [logo] = _header_logos(email.html)
        assert (logo["width"], logo["height"]) == ("132", "44")
        assert "border-radius" not in logo["style"]


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_an_html_template_loses_only_the_white_space_html_does_not_draw(newline: str) -> None:
    """B13-8: the indentation of the template's lines, and a line break beside a block's or a table's
    tag. A line break between two inline tags is a space HTML draws, and stays; so does one after a value,
    and whatever a value holds (this runs on the template, before any value is put in)."""
    source = newline.join(
        [
            "<table>",
            "  <tr>",
            '    <td style="padding:0">',
            "      <span>a</span>",
            "      <span>b</span> {{ value }}",
            "    </td>",
            "  </tr>",
            "</table>",
            "",
        ]
    )
    expected = newline.join(
        [
            '<table><tr><td style="padding:0"><span>a</span>',
            "<span>b</span> {{ value }}",
            "</td></tr></table>",
            "",
        ]
    )
    assert compact_html(source) == expected


def test_an_e_mail_keeps_the_white_space_of_its_values() -> None:
    company = _company(address="Building 14\n    King Abdullah II Street")
    email = (
        _service()
        .queue_visitor_invitation(
            _visit(company), TOKEN, company=company, recipient="dana@example.com", host_email=HOST_EMAIL
        )
        .email
    )
    assert "Building 14\n    King Abdullah II Street</span>" in email.html
    assert not re.search(r"\n[ \t]+<", email.html)  # no line of the template starts with white space
    assert "\n  " in email.text  # the plain-text part is read as it is written


def test_a_fault_while_drawing_never_stops_an_e_mail(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """B13-11: whatever goes wrong while a logo is drawn, not only a refused image (a fault of the drawing
    itself), the e-mail goes with the stored logo, and the fault is logged with its traceback. A visit's
    creation, check-in or cancellation renders its e-mail inside the request: a drawing fault must not
    fail them."""

    def broken(content: bytes) -> object:
        raise ZeroDivisionError("a fault of the drawing")

    monkeypatch.setattr(service_module, "light_rendition", broken)
    company = _company()
    service = _service(logos=CompanyLogos(COMPANY_LOGO, 900, 300, dark=COMPANY_LOGO))
    with caplog.at_level(logging.WARNING, logger="app.email"):
        emails = _all_emails(company, service)
    assert len(emails) == 8
    for email in emails:
        assert [image.content for image in email.inline_images if image.content_id != QR_CONTENT_ID] == [
            COMPANY_LOGO
        ]
    [record] = [record for record in caplog.records if record.name == "app.email"]
    assert record.getMessage() == "company logo could not be drawn for e-mail"
    assert record.problem == "ZeroDivisionError" and record.kind == "logo"  # type: ignore[attr-defined]
    assert record.exc_info is not None and record.exc_info[0] is ZeroDivisionError


@pytest.mark.parametrize("language", ["ar", "en"])
def test_a_company_without_a_logo_is_named_in_the_header_instead(language: str) -> None:
    """B12-12: no logo of anybody else stands in; the company's name is the word mark."""
    name = "أكمي القابضة" if language == "ar" else "Acme Holding"
    for email in _all_emails(_company(default_language=language)):
        assert _header_logos(email.html) == []
        assert LOGO_CONTENT_ID not in {image.content_id for image in email.inline_images}
        assert set(re.findall(r'src="cid:([^"]+)"', email.html)) == {
            image.content_id for image in email.inline_images
        }
        header = email.html[: email.html.index("<h1")]
        assert re.search(
            rf'<span dir="(?:ltr|rtl)" class="vlk" style="[^"]*font-weight:700;[^"]*">{name}</span>',
            header,
        )


@pytest.mark.parametrize(
    ("width", "height", "shown"),
    [
        (462, 149, (136, 44)),  # the demo brand's logo
        (1200, 32, (168, 4)),  # as wide as a logo may be
        (32, 600, (2, 44)),  # as tall as one may be
        (32, 32, (32, 32)),  # never enlarged
        (512, 512, (44, 44)),
    ],
)
def test_a_logo_is_fitted_into_the_header_s_box(width: int, height: int, shown: tuple[int, int]) -> None:
    assert fitted(width, height) == shown
    assert shown[0] <= LOGO_BOX_WIDTH and shown[1] <= LOGO_BOX_HEIGHT


@pytest.mark.parametrize("language", ["ar", "en"])
def test_only_the_cli_s_test_e_mail_carries_the_product_s_logo(language: str) -> None:
    """The CLI's test e-mail keeps the product's identity (B12-12). The notice of a platform action, which
    carried it too, is a company's e-mail since B12-22: the company's own logo heads it."""
    logo = brand_logo()
    assert logo.content.startswith(b"\x89PNG\r\n\x1a\n") and logo.mime_type == "image/png"
    service = _service(logos=CompanyLogos(COMPANY_LOGO, 900, 300))
    test_email = build_test_email(
        service.settings, EmailRenderer(), "ops@example.com", now=START, language=Language(language)
    )
    images = {image.content_id: image for image in test_email.inline_images}
    assert images[LOGO_CONTENT_ID].content == logo.content
    assert set(re.findall(r'src="cid:([^"]+)"', test_email.html)) == set(images)
    [shown] = _header_logos(test_email.html)
    assert shown["width"] == str(LOGO_WIDTH) and shown["height"] == str(LOGO_HEIGHT)
    assert shown["alt"] == ("موضوع" if language == "ar" else "Mawdoo3")
    for action in ("admin_added", "reset_sent"):
        notice = _platform_notice(_company(default_language=language), service, action)
        assert [image.content for image in notice.inline_images] == [light_rendition(COMPANY_LOGO).content]
        [shown] = _header_logos(notice.html)
        assert (shown["width"], shown["height"]) == (str(132 + 2 * PLATE), str(44 + 2 * PLATE))
        assert shown["alt"] == ("أكمي القابضة" if language == "ar" else "Acme Holding")


def test_the_logo_keeps_the_aspect_ratio_of_the_image() -> None:
    png = brand_logo().content
    width, height = int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")
    assert (width, height) == (462, 149)
    assert abs(LOGO_WIDTH / LOGO_HEIGHT - width / height) < 0.02


def test_no_email_names_the_old_product() -> None:
    for language in ("ar", "en"):
        for email in _all_emails(_company(default_language=language)):
            for body in (email.subject, email.html, email.text):
                assert "visitor management" not in body.lower(), email.kind


# ---- date and time wording ---------------------------------------------------------------------------


def test_date_and_time_wording() -> None:
    assert format_date(START, "Asia/Amman") == "Monday, 5 October 2026"
    assert timezone_label(START, "Asia/Amman") == "Amman time, UTC+3"
    winter, summer = datetime(2026, 1, 15, 12, tzinfo=UTC), datetime(2026, 7, 15, 12, tzinfo=UTC)
    assert timezone_label(winter, "America/New_York") == "New York time, UTC-5"
    assert timezone_label(summer, "America/New_York") == "New York time, UTC-4"
    assert timezone_label(START, "Asia/Kolkata") == "Kolkata time, UTC+5:30"
    assert timezone_label(START, "America/Argentina/Buenos_Aires") == "Buenos Aires time, UTC-3"
    assert timezone_label(winter, "Europe/London") == "London time, UTC"
    # Zones without a place are shown by their offset.
    assert timezone_label(START, "UTC") == zone_name(START, "UTC") == "UTC"
    assert timezone_label(START, "Etc/GMT-4") == zone_name(START, "Etc/GMT-4") == "UTC+4"
    assert zone_name(START, "Asia/Amman") == "Amman time"
    assert utc_offset(START, "America/St_Johns") == "UTC-2:30"
    # The Date row already names the first day: across midnight the Time row says "the next day".
    overnight = format_span(
        datetime(2026, 10, 5, 19, 42, tzinfo=UTC), datetime(2026, 10, 5, 21, 42, tzinfo=UTC), "Asia/Amman"
    )
    # The range never breaks at its dash (no-break spaces around it).
    assert overnight == f"22:42{RANGE}00:42 the next day"
    # Longer spans (not visits, which last at most 24 hours) name both days, in the application's format.
    multi_day = format_span(
        datetime(2026, 10, 5, 20, 0, tzinfo=UTC), datetime(2026, 10, 7, 22, 0, tzinfo=UTC), "Asia/Amman"
    )
    assert multi_day == f"Mon, 5 Oct, 23:00{NB}\N{EN DASH} Thu, 8 Oct, 01:00"
    times = VisitTimes.build(
        scheduled_start=datetime(2026, 10, 5, 19, 30, tzinfo=UTC),
        scheduled_end=datetime(2026, 10, 5, 20, 30, tzinfo=UTC),
        window_start=datetime(2026, 10, 5, 18, 30, tzinfo=UTC),
        window_end=datetime(2026, 10, 5, 21, 30, tzinfo=UTC),
        timezone="Asia/Amman",
    )
    # The visit is on the 5th (22:30 local); the pass expires after midnight, so that end gets a date.
    assert (times.check_in_from, times.expires_at) == ("21:30", "Tue, 6 Oct, 00:30")
    # An English sentence says the two as the card shows them ("... expires at Tue, 6 Oct, 00:30").
    assert (times.from_phrase, times.until_phrase, times.dated) == ("21:30", "Tue, 6 Oct, 00:30", True)
    same_day = VisitTimes.build(
        scheduled_start=START,
        scheduled_end=START + timedelta(hours=1),
        window_start=START - timedelta(hours=1),
        window_end=START + timedelta(hours=2),
        timezone="Asia/Amman",
    )
    assert (same_day.from_phrase, same_day.until_phrase, same_day.dated) == ("09:00", "12:00", False)


def test_arabic_date_and_time_wording() -> None:
    """Levantine month names, Latin digits, the Arabic comma: `Intl.DateTimeFormat('ar-JO-u-nu-latn')`;
    the day, the two-word month and the year joined by no-break spaces, so a mail client never shows
    «تشرين» / «الأول» on two lines (phase 10 review)."""
    ar = Language.AR
    assert format_date(START, "Asia/Amman", ar) == f"الاثنين، 5{NB}تشرين{NB}الأول{NB}2026"
    months = [
        format_date(datetime(2026, month, 15, 12, tzinfo=UTC), "UTC", ar).split(" ", 1)[1].split(NB, 1)[1]
        for month in range(1, 13)
    ]
    assert [month.rsplit(NB, 1)[0].replace(NB, " ") for month in months] == [
        "كانون الثاني",
        "شباط",
        "آذار",
        "نيسان",
        "أيار",
        "حزيران",
        "تموز",
        "آب",
        "أيلول",
        "تشرين الأول",
        "تشرين الثاني",
        "كانون الأول",
    ]
    assert timezone_label(START, "Asia/Amman", ar) == f"بتوقيت{NB}عمّان،{NB}UTC+3"
    assert zone_name(START, "Asia/Amman", ar) == "بتوقيت عمّان"
    assert zone_name(START, "Asia/Riyadh", ar) == "بتوقيت الرياض"
    # A zone without an Arabic place name is shown by its offset.
    assert (
        timezone_label(START, "Asia/Kolkata", ar).replace(NB, " ")
        == zone_name(START, "Asia/Kolkata", ar)
        == "بتوقيت UTC+5:30"
    )
    assert zone_name(START, "UTC", ar) == "بتوقيت UTC"
    overnight = format_span(
        datetime(2026, 10, 5, 19, 42, tzinfo=UTC), datetime(2026, 10, 5, 21, 42, tzinfo=UTC), "Asia/Amman", ar
    )
    assert overnight == f"22:42{RANGE}00:42 من اليوم التالي"
    multi_day = format_span(
        datetime(2026, 10, 5, 20, 0, tzinfo=UTC), datetime(2026, 10, 7, 22, 0, tzinfo=UTC), "Asia/Amman", ar
    )
    # Another day's time after a comma and «الساعة», as the interface writes it.
    assert multi_day == (
        f"الاثنين، 5{NB}تشرين{NB}الأول، الساعة{NB}23:00{NB}\N{EN DASH} "
        f"الخميس، 8{NB}تشرين{NB}الأول، الساعة{NB}01:00"
    )
    times = VisitTimes.build(
        scheduled_start=datetime(2026, 10, 5, 19, 30, tzinfo=UTC),
        scheduled_end=datetime(2026, 10, 5, 20, 30, tzinfo=UTC),
        window_start=datetime(2026, 10, 5, 18, 30, tzinfo=UTC),
        window_end=datetime(2026, 10, 5, 21, 30, tzinfo=UTC),
        timezone="Asia/Amman",
        language=ar,
    )
    expires = f"الثلاثاء، 6{NB}تشرين{NB}الأول، الساعة{NB}00:30"
    assert (times.check_in_from, times.expires_at) == ("21:30", expires)
    # In a sentence the list's commas would read as the sentence's own (B12-23): the day comes after
    # «يوم» and the time after «الساعة», and what belongs together stays on one line.
    assert times.until_phrase == f"يوم{NB}الثلاثاء 6{NB}تشرين{NB}الأول الساعة{NB}00:30"
    assert (times.from_phrase, times.dated) == ("21:30", True)
    # A window that starts the evening before: the same wording after «ابتداءً من».
    early = VisitTimes.build(
        scheduled_start=datetime(2026, 10, 5, 21, 20, tzinfo=UTC),  # 00:20 on the 6th
        scheduled_end=datetime(2026, 10, 5, 22, 20, tzinfo=UTC),
        window_start=datetime(2026, 10, 5, 20, 50, tzinfo=UTC),
        window_end=datetime(2026, 10, 5, 23, 20, tzinfo=UTC),
        timezone="Asia/Amman",
        language=ar,
    )
    assert early.from_phrase == f"يوم{NB}الاثنين 5{NB}تشرين{NB}الأول الساعة{NB}23:50"
    assert (early.check_in_from, early.dated) == (f"الاثنين، 5{NB}تشرين{NB}الأول، الساعة{NB}23:50", True)
    # On the visit's own day a time is enough; the end brings the preposition its sentence leaves out.
    assert (early.expires_at, early.until_phrase) == ("02:20", "عند 02:20")
    same_day = VisitTimes.build(
        scheduled_start=START,
        scheduled_end=START + timedelta(hours=1),
        window_start=START - timedelta(hours=1),
        window_end=START + timedelta(hours=2),
        timezone="Asia/Amman",
        language=ar,
    )
    assert (same_day.from_phrase, same_day.until_phrase, same_day.dated) == ("09:00", "عند 12:00", False)


# ---- booked by someone else, across midnight ---------------------------------------------------------


def test_an_invitation_booked_by_someone_else_names_them_and_attributes_nothing_to_the_host() -> None:
    """D-02 lets an employee book a visit for any active colleague: the e-mail must not put the booker's
    words in the host's mouth (B57-02)."""
    company = _company()
    email = (
        _service()
        .queue_visitor_invitation(
            _visit(company, purpose="Sign the vendor contract"),
            TOKEN,
            company=company,
            recipient="dana@example.com",
            host_email=HOST_EMAIL,
            booked_by="Lina Saleh",
        )
        .email
    )
    for body in (_plain(email.html), _read(email.text)):
        assert "Lina Saleh has invited you to visit Acme Holding on behalf of Omar Khalil." in body
        assert "تلقّيت دعوةً من Lina Saleh نيابةً عن Omar Khalil لزيارة أكمي القابضة." in body
        assert "Omar Khalil has invited you" not in body
        assert "provided by your host" not in body and "كما ذكره مضيفك" not in body
        assert "Sign the vendor contract" in body
    assert "Invited by: Lina Saleh" in email.text and "Purpose: Sign the vendor contract" in email.text
    assert re.search(r">Invited by</span>\s*<span[^>]*>Lina Saleh</span>", email.html)
    assert re.search(r">Purpose</span>\s*<span[^>]*>Sign the vendor contract</span>", email.html)


def test_an_invitation_booked_by_the_host_keeps_the_host_wording() -> None:
    email = _invitation(_company()).email
    for body in (_plain(email.html), _read(email.text)):
        assert "Omar Khalil has invited you to visit Acme Holding." in body
        assert "تلقّيت دعوةً من Omar Khalil لزيارة أكمي القابضة." in body
        # (The footer says on whose behalf the brand sends the message; that is not about the visit.)
        assert "on behalf of Omar Khalil" not in body and "Invited by" not in body
        assert "نيابةً عن Omar Khalil" not in body and "مُرسِل الدعوة" not in body


def test_a_visit_across_midnight_names_its_date_once() -> None:
    """The Date row shows the first day; the Time row says when the visit ends without repeating it."""
    company = _company()
    start = datetime(2026, 10, 5, 19, 42, tzinfo=UTC)  # 22:42 in Amman
    visit = _visit(
        company,
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=2),
        window_start=start - timedelta(hours=1),
        window_end=start + timedelta(hours=3),
    )
    email = (
        _service()
        .queue_visitor_invitation(
            visit, TOKEN, company=company, recipient="dana@example.com", host_email=HOST_EMAIL
        )
        .email
    )
    assert "Date: Monday, 5 October 2026" in email.text
    assert f"Time: 22:42{RANGE}00:42 the next day (Amman time, UTC+3)" in email.text
    assert "You can check in from 21:42. Your pass expires at Tue, 6 Oct, 01:42 (Amman time)." in email.text
    assert "Mon 5 Oct" not in email.text and "Tue 6 Oct" not in email.text
    assert f"الوقت: 22:42{RANGE}00:42 من اليوم التالي (بتوقيت{NB}عمّان،{NB}UTC+3)" in email.text


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_pass_that_expires_after_midnight_says_so_in_an_arabic_sentence(lead: str) -> None:
    """The review's sentence (B12-23): «تنتهي صلاحية بطاقتك عند الأربعاء، 14 تشرين الأول، الساعة 01:57»,
    "at Wednesday, ..." with the commas of a list inside the sentence. It is now «يوم الأربعاء 14 تشرين
    الأول الساعة 01:57», in the invitation and in the notice of a new time, in both of their parts."""
    company = _company(default_language=lead)
    start = datetime(2026, 10, 13, 19, 57, tzinfo=UTC)  # 22:57 on Tuesday the 13th in Amman
    visit = _visit(
        company,
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=2),
        window_start=start - timedelta(minutes=30),
        window_end=start + timedelta(hours=3),
    )
    service = _service()
    invitation = service.queue_visitor_invitation(
        visit, TOKEN, company=company, recipient="dana@example.com", host_email=HOST_EMAIL
    ).email
    rescheduled = service.queue_visit_rescheduled(
        visit, company=company, recipient="dana@example.com", host_email=HOST_EMAIL
    ).email
    said = "وتنتهي صلاحية بطاقتك يوم الأربعاء 14 تشرين الأول الساعة 01:57 (بتوقيت عمّان)."
    assert f"يمكنك تسجيل الدخول ابتداءً من 22:27، {said}" in _read(invitation.text)
    assert f"يمكنك الآن تسجيل الدخول ابتداءً من 22:27، {said}" in _read(rescheduled.text)
    assert f"يمكنك الآن تسجيل الدخول ابتداءً من 22:27، {said}" in _plain(rescheduled.html).replace(NB, " ")
    if lead == "en":  # the other language's part of an invitation says the window in a sentence
        assert f"يمكنك تسجيل الدخول ابتداءً من 22:27، {said}" in _plain(invitation.html).replace(NB, " ")
    for email in (invitation, rescheduled):
        for body in (email.html, email.text):
            assert "عند الأربعاء" not in body.replace(NB, " ") and "بطاقتك عند" not in body
    # The no-break rules stand: the day with its month, «الساعة» with its time, «يوم» with its day.
    sentences = [
        invitation.text,
        rescheduled.text,
        rescheduled.html,
        *([invitation.html] if lead == "en" else []),
    ]
    for body in sentences:
        assert f"يوم{NB}الأربعاء 14{NB}تشرين{NB}الأول الساعة{NB}01:57" in body
    # English is worded as it was.
    assert "Your pass expires at Wed, 14 Oct, 01:57 (Amman time)." in invitation.text
    # Under its label, on the card, the moment is still the list the interface writes.
    if lead == "ar":
        assert f"الأربعاء، 14{NB}تشرين{NB}الأول، الساعة{NB}01:57</span>" in invitation.html


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_the_pass_card_shows_a_window_across_midnight_one_end_under_the_other(lead: str) -> None:
    """Two halves of a phone's width cannot hold a date in large figures: the invitation was 421 pixels
    wide on a 375-pixel phone (B12-23). An end with a date is a phrase: both ends are set smaller and
    stacked, each across the card. A window on one day keeps its two large figures side by side."""
    company = _company(default_language=lead)
    start = datetime(2026, 10, 13, 19, 57, tzinfo=UTC)
    late = _visit(
        company,
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=2),
        window_start=start - timedelta(minutes=30),
        window_end=start + timedelta(hours=3),
    )
    figure = re.compile(
        r"font-size:(\d+)px;line-height:(\d+)px;font-weight:700;color:#FFFFFF;"
        r'word-break:break-word;">([^<]+)<'
    )
    for visit, sizes, halves in ((late, {("18", "26")}, 0), (_visit(company), {("26", "34")}, 2)):
        html = (
            _service()
            .queue_visitor_invitation(
                visit, TOKEN, company=company, recipient="dana@example.com", host_email=HOST_EMAIL
            )
            .email.html
        )
        begin = html.index("border-radius:12px;")  # the table of the window, on the pass card
        card = html[begin : html.index("</table>", begin)]
        figures = figure.findall(card)
        assert len(figures) == 2 and {(size, line) for size, line, _ in figures} == sizes
        assert card.count('width="50%"') == halves and card.count("<tr>") == (1 if halves else 2)
    # The values themselves: a time, and a date with its time.
    assert [value for _, _, value in figures] == ["09:00", "12:00"]


# ---- the header on a phone (B12-23) ----------------------------------------------------------------------


def _pill(html: str) -> str:
    found = re.search(
        r'<span lang="[a-z]{2}"(?: class="vpl")? style="(display:inline-block;padding:5px 12px;[^"]*)"',
        html,
    )
    assert found is not None
    return found.group(1)


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_on_a_phone_the_kind_of_message_goes_under_the_logo(lead: str) -> None:
    """A 160-pixel logo and the pill «إعادة تعيين كلمة المرور» (155 pixels, on one line) made the
    password-reset e-mail 389 pixels wide on every phone (B12-23). Below 480 pixels the two cells of the
    header stack, both at the start of the line; and beside a logo, which cannot give way, the pill's
    own text may wrap where a client drops the style sheet.

    Beside a logo on its plate (B13-2) the header's padding gives the plate back, so the logo's own
    edge and the pill stay where the text starts, on a phone too."""
    start = "right" if lead == "ar" else "left"
    end = "left" if lead == "ar" else "right"
    company = _company(default_language=lead)
    with_logo = _all_emails(company, _service(logos=CompanyLogos(WIDE_LOGO, 1200, 300)))
    without = _all_emails(company)
    assert len(with_logo) == len(without) == 8
    for email in (*with_logo, *without):
        phone = email.html.index("@media only screen and (max-width: 480px)")
        style = email.html[phone : email.html.index("</style>", phone)]
        stacked = f"display:block!important;width:auto!important;text-align:{start}!important"
        assert f".vhd{{{stacked}}}" in style
        header = email.html[: email.html.index("<h1")]
        # The cell of the logo or the name, then the cell of the pill.
        assert re.findall(r'class="(vhd[^"]*)"', header) == ["vhd", "vhd vhk"]
    for email in without:
        style = email.html[email.html.index("@media only screen") :]
        assert ".vhk{padding:10px 0 0 0!important}" in style
        assert 'class="vpx vsf" style="padding:18px 32px 16px 32px;' in email.html
    for email in with_logo:
        style = email.html[email.html.index("@media only screen") :]
        assert (
            f".vhk{{padding:{10 - PLATE}px 0 {PLATE}px 0!important;padding-{start}:{PLATE}px!important}}"
        ) in style
        assert f".vpp{{padding-{start}:{18 - PLATE}px!important;padding-{end}:18px!important}}" in style
        assert (
            f'class="vpp vsf" style="padding-top:{18 - PLATE}px;padding-bottom:{16 - PLATE}px;'
            f"padding-{start}:{32 - PLATE}px;padding-{end}:32px;"
        ) in email.html
        [logo] = _header_logos(email.html)
        # As wide as a logo is shown, and the plate around it.
        assert (logo["width"], logo["height"]) == (str(168 + 2 * PLATE), str(42 + 2 * PLATE))
        assert "white-space:normal" in _pill(email.html) and "border-radius:13px" in _pill(email.html)
    for email in without:
        # A name gives way itself (it wraps), so the pill stays on one line.
        assert "white-space:nowrap" in _pill(email.html)
    # The product's own header (the CLI's test e-mail): its logo and its pill are both short.
    test_email = build_test_email(_service().settings, EmailRenderer(), "ops@example.com", now=START)
    assert "white-space:nowrap" in _pill(test_email.html) and 'class="vhd' not in test_email.html


def test_a_reschedule_notice_does_not_say_the_host_made_the_change() -> None:
    """The creator or an administrator may reschedule; the notice states the fact without an author."""
    company = _company()
    email = (
        _service()
        .queue_visit_rescheduled(
            _visit(company), company=company, recipient="dana@example.com", host_email=HOST_EMAIL
        )
        .email
    )
    for body in (_plain(email.html), _read(email.text)):
        assert "The time of your visit to Acme Holding with Omar Khalil has changed." in body
        assert "Omar Khalil has changed the time" not in body


@pytest.mark.parametrize(
    ("address", "domain"),
    [
        ("person@Example.COM", "example.com"),
        ("person@b\N{LATIN SMALL LETTER U WITH DIAERESIS}cher.example", "xn--bcher-kva.example"),
        ("person@", "unknown"),
    ],
)
def test_recipient_domain_for_audit(address: str, domain: str) -> None:
    assert recipient_domain(address) == domain


# ---- a process that started before a value existed (B12-26) ------------------------------------------------
# A running API process reads a template again whenever its file changes, with the code it started with
# (the user's demo did, while this round was built: every e-mail failed on `colors.surface`). The
# templates give every value of this round a default, so such a process keeps sending what it knows.
# This test and the defaults go together, once no process from before 2026-10-14 is running.


@dataclass(frozen=True)
class _ColoursBefore:
    """`EmailColors` as it was before B12-21: no `surface`, no `on_surface`."""

    strong: str
    link: str
    accent: str
    on_accent: str
    card: str
    card_line: str
    tint: str
    tint_edge: str


@dataclass(frozen=True)
class _TimesBefore:
    """`VisitTimes` as it was before B12-23: no `dated`, no phrases."""

    date: str
    time: str
    timezone: str
    zone: str
    check_in_from: str
    expires_at: str


class _RendererOfAnOlderProcess:
    """Renders today's templates with the values the code knew before this round."""

    def __init__(self) -> None:
        self.renderer = EmailRenderer()

    def render(self, template, *, subject, context, language, scheme=None):
        older = dict(context)  # an older process passes no `scheme` either (B13-5)
        colours = context["colors"]
        older["colors"] = _ColoursBefore(
            **{name: getattr(colours, name) for name in _ColoursBefore.__dataclass_fields__}
        )
        if "times" in context:
            older["times"] = {
                lang: _TimesBefore(
                    **{name: getattr(times, name) for name in _TimesBefore.__dataclass_fields__}
                )
                for lang, times in context["times"].items()
            }
        return self.renderer.render(template, subject=subject, context=older, language=language)


@pytest.mark.parametrize("lead", ["ar", "en"])
def test_a_process_that_started_before_this_round_still_renders_every_e_mail(lead: str) -> None:
    company = _company(default_language=lead, brand_color="#f5b800")
    start = datetime(2026, 10, 13, 19, 57, tzinfo=UTC)  # a window that ends after midnight
    window = {
        "scheduled_start": start,
        "scheduled_end": start + timedelta(hours=2),
        "window_start": start - timedelta(minutes=30),
        "window_end": start + timedelta(hours=3),
    }
    older = _service()
    older.renderer = _RendererOfAnOlderProcess()  # type: ignore[assignment]
    emails = _all_emails(company, older, **window)
    assert len(emails) == 8
    for email in emails:
        # What that code knew: the strong step as the bar ...
        assert '<td height="6" bgcolor="#8E6900"' in email.html, email.kind
    invitation, rescheduled, reset = emails[0], emails[1], emails[4]
    # ... and under white text on the primary button.
    assert re.search(
        r'bgcolor="#8E6900" class="vbn" style="border-radius:10px;background-color:#8E6900;'
        r"border:2px solid #8E6900;"
        r'[^"]*">\s*<a [^>]*color:#FFFFFF;',
        reset.html,
    )
    # The window as that code worded it: the values under the card's labels, in two halves.
    assert invitation.html.count('width="50%" align="center"') == 2
    assert "Your pass expires at Wed, 14 Oct, 01:57 (Amman time)." in invitation.text
    assert "Your pass expires at Wed, 14 Oct, 01:57 (Amman time)." in _plain(rescheduled.html)
    # The same e-mails from today's code differ only in what this round added.
    today = _all_emails(company, **window)
    assert (
        '<td height="6" bgcolor="#F5B800"' in today[0].html
        and 'width="50%" align="center"' not in today[0].html
    )
