"""The visit as a calendar event (Phase 14, docs/decisions/phase-14-backend.md B14-1 to B14-9, B14-17,
B14-19, B14-21).

`app.email.calendar` writes iCalendar objects (RFC 5545) as iTIP messages (RFC 5546) by hand. Every object
written here is read back by an iCalendar parser that is not ours (`icalendar`, a test-only dependency,
B14-9), and the octets themselves are held to the RFC's rules: CRLF line ends, lines of at most 75 octets
folded without splitting a character, escaped text, times in UTC.

The e-mail service's events (what each e-mail carries, in which language, never a pass link) are held
here too, on messages rendered by the real service and templates; what the API queues for whom is held by
`tests/integration/test_visit_calendars.py`."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import icalendar
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.email.calendar import (
    LINE_OCTETS,
    PRODID,
    CalendarEvent,
    CalendarMailbox,
    calendar_address,
    common_name,
    event_uid,
    fold,
    text_value,
    utc_stamp,
    write_calendar,
)
from app.email.providers.base import OutgoingEmail
from app.email.rendering import EmailRenderer
from app.email.service import (
    NO_BRAND_IMAGES,
    NO_TEMPLATE_TEXTS,
    EmailService,
    mailbox_key,
    one_line_address,
)
from app.models import Company, EmailKind, Language, User, Visit
from app.security.tokens import generate_token

START = datetime(2026, 10, 20, 7, 0, tzinfo=UTC)
STAMP = datetime(2026, 10, 19, 9, 15, 30, 123456, tzinfo=UTC)
VISIT_ID = uuid.UUID("0b6f4f6e-6d1c-4f53-9a43-8f2b9c0f1a77")
SENDER = "visitors@demo.test"
ARABIC = "زيارة إلى شركة موضوع للتقنية والحلول الرقمية المتكاملة ذات المسؤولية المحدودة"


def _event(**changes: object) -> CalendarEvent:
    values: dict[str, object] = {
        "method": "REQUEST",
        "uid": event_uid(VISIT_ID, "visitor"),
        "sequence": 0,
        "stamp": STAMP,
        "start": START,
        "end": START + timedelta(hours=1),
        "summary": "Visit to Mawdoo3",
        "location": "Building 14, King Abdullah II Street, Amman",
        "description": "Host: Omar Khalil\nShow your visitor pass at reception when you arrive.",
        "organizer": CalendarMailbox("Mawdoo3", SENDER),
        "attendee": CalendarMailbox("Dana Guest", "dana@example.com"),
    }
    values.update(changes)
    return CalendarEvent(**values)  # type: ignore[arg-type]


def _parsed(data: bytes) -> tuple[icalendar.Calendar, icalendar.Event]:
    calendar = icalendar.Calendar.from_ical(data)
    [event] = calendar.walk("VEVENT")
    return calendar, event


def _physical_lines(data: bytes) -> list[bytes]:
    assert data.endswith(b"\r\n")
    return data[:-2].split(b"\r\n")


def _unfolded(data: bytes) -> list[str]:
    """The content lines, unfolded octet by octet (RFC 5545 §3.1: a CRLF followed by one space goes)."""
    return data.replace(b"\r\n ", b"").decode("utf-8").split("\r\n")[:-1]


# ---- the writer, against the RFC ------------------------------------------------------------------


def test_a_request_is_read_back_whole_by_another_parser() -> None:
    data = write_calendar(_event())
    calendar, event = _parsed(data)
    assert calendar["METHOD"] == "REQUEST" and calendar["VERSION"] == "2.0"
    assert calendar["PRODID"] == PRODID and calendar["CALSCALE"] == "GREGORIAN"
    assert str(event["UID"]) == f"visit-{VISIT_ID}-visitor"
    assert event["SEQUENCE"] == 0
    assert event.decoded("DTSTAMP") == STAMP.replace(microsecond=0)
    assert event.decoded("DTSTART") == START and event.decoded("DTEND") == START + timedelta(hours=1)
    assert str(event["SUMMARY"]) == "Visit to Mawdoo3"
    assert str(event["LOCATION"]) == "Building 14, King Abdullah II Street, Amman"
    assert str(event["DESCRIPTION"]) == (
        "Host: Omar Khalil\nShow your visitor pass at reception when you arrive."
    )
    assert str(event["STATUS"]) == "CONFIRMED" and str(event["TRANSP"]) == "OPAQUE"
    assert str(event["ORGANIZER"]) == f"mailto:{SENDER}" and event["ORGANIZER"].params["CN"] == "Mawdoo3"
    attendee = event["ATTENDEE"]
    assert str(attendee) == "mailto:dana@example.com"
    assert dict(attendee.params) == {
        "CN": "Dana Guest",
        "CUTYPE": "INDIVIDUAL",
        "ROLE": "REQ-PARTICIPANT",
        "PARTSTAT": "NEEDS-ACTION",
        "RSVP": "FALSE",
    }
    # One event, one attendee, nothing else the writer did not mean to write.
    assert [component.name for component in calendar.walk()] == ["VCALENDAR", "VEVENT"]
    assert {name for name, _ in event.property_items(recursive=False)} == {
        "BEGIN",
        "UID",
        "SEQUENCE",
        "DTSTAMP",
        "DTSTART",
        "DTEND",
        "SUMMARY",
        "LOCATION",
        "DESCRIPTION",
        "ORGANIZER",
        "ATTENDEE",
        "STATUS",
        "TRANSP",
        "END",
    }


def test_a_cancellation_names_the_same_event_with_a_newer_version() -> None:
    request = write_calendar(_event(sequence=1))
    cancel = write_calendar(_event(method="CANCEL", sequence=2))
    request_calendar, request_event = _parsed(request)
    cancel_calendar, cancel_event = _parsed(cancel)
    assert request_calendar["METHOD"] == "REQUEST" and cancel_calendar["METHOD"] == "CANCEL"
    # RFC 5546 §3.2.5: the UID, the organizer, the attendee and a SEQUENCE; the event marked cancelled.
    assert cancel_event["UID"] == request_event["UID"]
    assert cancel_event["SEQUENCE"] > request_event["SEQUENCE"]
    assert str(cancel_event["STATUS"]) == "CANCELLED"
    assert str(cancel_event["ORGANIZER"]) == str(request_event["ORGANIZER"])
    assert str(cancel_event["ATTENDEE"]) == str(request_event["ATTENDEE"])
    assert cancel_event.decoded("DTSTART") == START


def test_every_line_ends_with_crlf_and_holds_no_bare_line_break() -> None:
    data = write_calendar(_event(description="one\ntwo\r\nthree\rfour"))
    assert b"\n" not in data.replace(b"\r\n", b"")
    assert b"\r" not in data.replace(b"\r\n", b"")
    assert data.startswith(b"BEGIN:VCALENDAR\r\n") and data.endswith(b"END:VCALENDAR\r\n")
    assert "DESCRIPTION:one\\ntwo\\nthree\\nfour" in _unfolded(data)


@pytest.mark.parametrize(
    ("value", "written"),
    [
        ("plain", "plain"),
        ("a, b; c", "a\\, b\\; c"),
        ("back\\slash", "back\\\\slash"),
        ("line\nbreak", "line\\nbreak"),
        ("windows\r\nbreak", "windows\\nbreak"),
        ("old mac\rbreak", "old mac\\nbreak"),
        ("unicode\N{LINE SEPARATOR}line\N{PARAGRAPH SEPARATOR}paragraph", "unicode\\nline\\nparagraph"),
        ("tab\there", "tab here"),
        ("bell\x07 and \x1b escape \x7f del \x85 nel", "bell and  escape  del  nel"),
        ("colon: stays", "colon: stays"),
        ("\N{RIGHT-TO-LEFT OVERRIDE}evil\N{POP DIRECTIONAL FORMATTING}", "evil"),
        ("\N{FIRST STRONG ISOLATE}name\N{POP DIRECTIONAL ISOLATE}", "name"),
        ("\\;,\n", "\\\\\\;\\,\\n"),
    ],
)
def test_text_is_escaped_as_rfc_5545_says(value: str, written: str) -> None:
    assert text_value(value) == written


@pytest.mark.parametrize(
    "value",
    [
        "Quarterly review; budget, risks \\ next steps",
        "سطر أول\nسطر ثانٍ، مع فاصلة؛ وفاصلة منقوطة",
        "emoji 🏢 and joiners 👩‍💼 survive",
    ],
)
def test_escaped_text_reads_back_as_written(value: str) -> None:
    _, event = _parsed(write_calendar(_event(description=value, summary=value, location=value)))
    for name in ("DESCRIPTION", "SUMMARY", "LOCATION"):
        assert str(event[name]) == value


@pytest.mark.parametrize("text", [ARABIC * 3, "🏢" * 60, "é" * 120, "a" * 300, "ب" + "x" * 200 + "ج"])
def test_long_lines_are_folded_on_octets_without_splitting_a_character(text: str) -> None:
    data = write_calendar(_event(summary=text, description=text))
    for line in _physical_lines(data):
        assert len(line) <= LINE_OCTETS
        line.decode("utf-8")  # each line is whole UTF-8 on its own: no character split between two
    # Unfolding gives the lines back, and so does the other parser.
    assert f"SUMMARY:{text}" in _unfolded(data)
    _, event = _parsed(data)
    assert str(event["SUMMARY"]) == text and str(event["DESCRIPTION"]) == text


def test_folding_at_the_boundary() -> None:
    exactly = "X" * LINE_OCTETS
    assert fold(exactly) == exactly.encode()
    longer = "X" * (LINE_OCTETS + 1)
    assert fold(longer) == ("X" * LINE_OCTETS + "\r\n X").encode()
    # A continuation line starts with one space, which counts: 74 octets of text after it.
    two_lines = "X" * (LINE_OCTETS + 74 + 1)
    assert fold(two_lines).split(b"\r\n") == [b"X" * 75, b" " + b"X" * 74, b" X"]
    # An Arabic letter is two octets: the cut moves back rather than split one.
    arabic = "ab" + "ب" * 40  # 82 octets: the 76th octet is the second half of a letter
    first, second = fold(arabic).split(b"\r\n")
    assert len(first) == 74 and second.startswith(b" ") and first.decode() + second[1:].decode() == arabic


def test_times_are_written_in_utc() -> None:
    amman = ZoneInfo("Asia/Amman")
    assert utc_stamp(datetime(2026, 10, 20, 10, 0, tzinfo=amman)) == "20261020T070000Z"
    assert utc_stamp(STAMP) == "20261019T091530Z"  # whole seconds
    with pytest.raises(ValueError, match="aware"):
        utc_stamp(datetime(2026, 10, 20, 10, 0))
    data = write_calendar(_event(start=datetime(2026, 10, 20, 10, 0, tzinfo=amman)))
    lines = _unfolded(data)
    assert "DTSTART:20261020T070000Z" in lines
    # No time zone definition is needed: every time is UTC.
    assert not any(line.startswith(("BEGIN:VTIMEZONE", "TZID")) or ";TZID=" in line for line in lines)


def test_an_event_must_be_well_formed() -> None:
    with pytest.raises(ValueError, match="SEQUENCE"):
        write_calendar(_event(sequence=-1))
    with pytest.raises(ValueError, match="ends after it starts"):
        write_calendar(_event(end=START))


def test_the_uid_is_stable_per_visit_and_role_and_names_nobody() -> None:
    other = uuid.uuid4()
    assert event_uid(VISIT_ID, "visitor") == event_uid(VISIT_ID, "visitor") == f"visit-{VISIT_ID}-visitor"
    assert event_uid(VISIT_ID, "host") == f"visit-{VISIT_ID}-host"
    assert len({event_uid(visit, role) for visit in (VISIT_ID, other) for role in ("visitor", "host")}) == 4
    assert re.fullmatch(r"visit-[0-9a-f-]{36}-(visitor|host)", event_uid(other, "host"))


@pytest.mark.parametrize(
    ("name", "written"),
    [
        ("Mawdoo3", '"Mawdoo3"'),
        ("شركة موضوع", '"شركة موضوع"'),
        ('He said "hi"', '"He said hi"'),
        ("Acme, Inc.; R&D: Labs", '"Acme, Inc.; R&D: Labs"'),
        ("support@bank.example", '"support bank.example"'),
        ("Line\r\nBreak", '"Line Break"'),
        ("   ", None),
    ],
)
def test_a_common_name_is_a_safe_quoted_string(name: str, written: str | None) -> None:
    assert common_name(name) == written


def test_a_mailbox_without_a_name_has_no_cn() -> None:
    _, event = _parsed(write_calendar(_event(attendee=CalendarMailbox("", "dana@example.com"))))
    assert "CN" not in event["ATTENDEE"].params and str(event["ATTENDEE"]) == "mailto:dana@example.com"


@pytest.mark.parametrize(
    ("address", "uri"),
    [
        ("dana@example.com", "mailto:dana@example.com"),
        ("dana.o'neil+visits@example.com", "mailto:dana.o'neil+visits@example.com"),
        ("dana@Example.COM", "mailto:dana@example.com"),
        ("dana@exämple.com", "mailto:dana@xn--exmple-cua.com"),
        ("a%b?c#d@example.com", "mailto:a%25b%3Fc%23d@example.com"),
        ("دانة@example.com", "mailto:%D8%AF%D8%A7%D9%86%D8%A9@example.com"),
    ],
)
def test_addresses_are_mailto_uris(address: str, uri: str) -> None:
    assert calendar_address(address) == uri


# ---- what the e-mails carry ------------------------------------------------------------------------


def _settings() -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.test",
        email_from="Demo Visitors <visitors@demo.test>",
        resend_api_key=SecretStr("re_test"),
    )


class _Messages:
    def add(self, message: object) -> object:
        return message


def _service() -> EmailService:
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=_settings(),
        renderer=EmailRenderer(),
        provider_name="memory",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=NO_BRAND_IMAGES,
    )
    service.messages = _Messages()  # type: ignore[assignment]
    return service


def _company(language: str = "ar") -> Company:
    return Company(
        id=uuid.uuid4(),
        name="Mawdoo3",
        name_ar="موضوع",
        slug="mawdoo3",
        timezone="Asia/Amman",
        default_language=language,
        address="Building 14,\nKing Abdullah II Street, Amman",
        address_ar="مبنى 14\nشارع الملك عبدالله الثاني، عمّان",  # noqa: RUF001 - Arabic text
        notify_host_on_check_in=True,
    )


def _visit(company: Company, *, sequence: int = 0, **changes: object) -> Visit:
    values: dict[str, object] = {
        "id": VISIT_ID,
        "company_id": company.id,
        "host_id": uuid.uuid4(),
        "created_by_id": uuid.uuid4(),
        "visitor_name": "Dana Guest",
        "visitor_company_name": "Acme",
        "host_name": "عمر خليل",
        "department_name": "Finance",
        "department_name_ar": "المالية",
        "purpose": "Quarterly review",
        "scheduled_start": START,
        "scheduled_end": START + timedelta(hours=1),
        "window_start": START - timedelta(minutes=30),
        "window_end": START + timedelta(hours=1, minutes=30),
        "calendar_sequence": sequence,
    }
    values.update(changes)
    return Visit(**values)


def _host(company: Company, language: str | None = "en") -> User:
    return User(
        id=uuid.uuid4(),
        company_id=company.id,
        full_name="Omar Khalil",
        email="omar@demo.test",
        preferred_language=language,
    )


def _event_of(email: OutgoingEmail) -> icalendar.Event:
    assert email.calendar is not None
    calendar, event = _parsed(email.calendar.content)
    assert calendar["METHOD"] == email.calendar.method
    assert str(event["UID"]) == email.calendar.uid and event["SEQUENCE"] == email.calendar.sequence
    return event


def _calendar_email(company: Company, visit: Visit | None = None, recipient: str = "dana@example.com"):
    return (
        _service()
        .queue_visitor_calendar(
            visit or _visit(company), company=company, recipient=recipient, host_email=None
        )
        .email
    )


def test_the_invitation_carries_no_event_its_calendar_invitation_does() -> None:
    """B14-10: Outlook keeps the text of an e-mail that carries an event in the calendar entry, so the
    invitation (pass link, QR code) carries none, and the short e-mail that follows it carries the event."""
    company = _company("ar")
    token = generate_token()
    service = _service()
    invitation = service.queue_visitor_invitation(
        _visit(company), token, company=company, recipient="dana@example.com", host_email="omar@demo.test"
    ).email
    assert invitation.calendar is None and invitation.kind == EmailKind.VISITOR_INVITATION
    email = service.queue_visitor_calendar(
        _visit(company), company=company, recipient="dana@example.com", host_email="omar@demo.test"
    ).email
    assert email.kind == EmailKind.VISITOR_CALENDAR and email.to == "dana@example.com"
    assert email.calendar is not None and email.calendar.method == "REQUEST"
    # The invitation's subject (so a mail client shows the two together), sender and Reply-To.
    assert (email.subject, email.sender, email.reply_to) == (
        invitation.subject,
        invitation.sender,
        invitation.reply_to,
    )
    event = _event_of(email)
    assert str(event["UID"]) == f"visit-{VISIT_ID}-visitor" and event["SEQUENCE"] == 0
    assert str(event["SUMMARY"]) == "زيارة إلى موضوع"
    # The Arabic address on one line, its lines joined by the Arabic comma.
    assert str(event["LOCATION"]) == "مبنى 14، شارع الملك عبدالله الثاني، عمّان"
    assert str(event["DESCRIPTION"]).split("\n") == [
        "المضيف: عمر خليل",
        "القسم: المالية",
        "الغرض من الزيارة: Quarterly review",
        "اعرض بطاقة زيارتك عند الاستقبال لدى وصولك.",
    ]
    # The organizer is the sending address under the company's name, as the From is (B14-5).
    assert str(event["ORGANIZER"]) == "mailto:visitors@demo.test"
    assert event["ORGANIZER"].params["CN"] == "موضوع" and email.sender == '"موضوع" <visitors@demo.test>'
    assert str(event["ATTENDEE"]) == "mailto:dana@example.com"
    assert event["ATTENDEE"].params["CN"] == "Dana Guest" and event["ATTENDEE"].params["RSVP"] == "FALSE"
    # No pass link, no token and no QR code: neither in the event nor in the e-mail that carries it.
    assert invitation.pass_url is not None and invitation.pass_url in invitation.html
    content = email.calendar.content.decode()
    for text in (content, email.html, email.text):
        assert token not in text and "/pass" not in text and "?c=" not in text
    assert "http" not in content and "#" not in content and email.pass_url is None
    assert "visitor-pass-qr" not in email.html
    assert [image.content_id for image in email.inline_images] == []  # a company without a logo


@pytest.mark.parametrize("language", ["ar", "en"])
def test_the_calendar_invitation_reads_as_the_invitation_does(language: str) -> None:
    company = _company(language)
    email = _calendar_email(company)
    heading = {"ar": "زيارتك إلى ", "en": "Your visit to "}
    line = {"ar": "الزيارة مرفقة لإضافتها إلى تقويمك.", "en": "The visit is attached for your calendar."}
    for lang in ("ar", "en"):
        assert heading[lang] in email.html and heading[lang] in email.text
        assert line[lang] in email.html and line[lang] in email.text
    assert email.html.index(heading[language]) < email.html.index(heading["en" if language == "ar" else "ar"])
    # The company's identity, with the dark design (B13-1).
    assert 'content="light dark"' in email.html and "prefers-color-scheme: dark" in email.html
    assert "Mawdoo3" in email.text.splitlines()[0]


def test_an_english_led_company_writes_the_visitor_s_event_in_english() -> None:
    event = _event_of(_calendar_email(_company("en")))
    assert str(event["SUMMARY"]) == "Visit to Mawdoo3"
    assert str(event["LOCATION"]) == "Building 14, King Abdullah II Street, Amman"
    assert str(event["DESCRIPTION"]).split("\n") == [
        "Host: عمر خليل",
        "Department: Finance",
        "Purpose: Quarterly review",
        "Show your visitor pass at reception when you arrive.",
    ]


def test_the_notices_of_a_new_time_and_of_a_cancellation_carry_the_same_event() -> None:
    company = _company("en")
    service = _service()
    later = START + timedelta(days=1)
    moved = service.queue_visit_rescheduled(
        _visit(company, sequence=1, scheduled_start=later, scheduled_end=later + timedelta(hours=2)),
        company=company,
        recipient="dana@example.com",
        host_email=None,
    ).email
    cancelled = service.queue_visit_cancelled(
        _visit(company, sequence=2),
        "Plans changed",
        company=company,
        recipient="dana@example.com",
        host_email=None,
    ).email
    moved_event, cancelled_event = _event_of(moved), _event_of(cancelled)
    assert moved.calendar is not None and moved.calendar.method == "REQUEST"
    assert moved_event.decoded("DTSTART") == later and moved_event["SEQUENCE"] == 1
    assert cancelled.calendar is not None and cancelled.calendar.method == "CANCEL"
    assert str(cancelled_event["STATUS"]) == "CANCELLED" and cancelled_event["SEQUENCE"] == 2
    assert moved_event["UID"] == cancelled_event["UID"] == f"visit-{VISIT_ID}-visitor"
    # Neither carries the pass link (they never did: the pass stays as it was, D-22).
    for email in (moved, cancelled):
        assert "/pass" not in email.html and "/pass" not in email.text


@pytest.mark.parametrize(
    ("kind", "method", "status"),
    [
        (EmailKind.HOST_VISIT_SCHEDULED, "REQUEST", "CONFIRMED"),
        (EmailKind.HOST_VISIT_RESCHEDULED, "REQUEST", "CONFIRMED"),
        (EmailKind.HOST_VISIT_CANCELLED, "CANCEL", "CANCELLED"),
    ],
)
def test_the_host_s_e_mails_carry_the_host_s_own_event(kind: EmailKind, method: str, status: str) -> None:
    company = _company("ar")
    host = _host(company, "en")
    email = (
        _service()
        .queue_host_visit(
            _visit(company, sequence=3), kind=kind, company=company, host=host, booked_by="Lina Admin"
        )
        .email
    )
    assert email.kind == kind and email.to == "omar@demo.test"
    assert email.calendar is not None and email.calendar.method == method
    event = _event_of(email)
    # Its own UID, in the host's language (English here, in an Arabic-led company).
    assert str(event["UID"]) == f"visit-{VISIT_ID}-host" and event["SEQUENCE"] == 3
    assert str(event["STATUS"]) == status
    assert str(event["SUMMARY"]) == "Visit: Dana Guest"
    assert str(event["LOCATION"]) == "Building 14, King Abdullah II Street, Amman"
    assert str(event["DESCRIPTION"]).split("\n") == [
        "Visitor: Dana Guest",
        "Company: Acme",
        "Department: Finance",
        "Purpose: Quarterly review",
        "Booked by: Lina Admin",
    ]
    assert str(event["ATTENDEE"]) == "mailto:omar@demo.test"
    assert event["ATTENDEE"].params["CN"] == "عمر خليل"
    assert event["ORGANIZER"].params["CN"] == "Mawdoo3" and str(event["ORGANIZER"]) == f"mailto:{SENDER}"
    assert "/pass" not in email.html and "/pass" not in email.text


def test_the_host_s_event_in_arabic() -> None:
    company = _company("en")
    email = (
        _service()
        .queue_host_visit(
            _visit(company, visitor_company_name=None, department_name=None, department_name_ar=None),
            kind=EmailKind.HOST_VISIT_SCHEDULED,
            company=company,
            host=_host(company, "ar"),
        )
        .email
    )
    event = _event_of(email)
    assert str(event["SUMMARY"]) == "زيارة: Dana Guest"
    # Only the details there are: no visitor's company, department or booker.
    assert str(event["DESCRIPTION"]).split("\n") == [
        "الزائر: Dana Guest",
        "الغرض من الزيارة: Quarterly review",
    ]


def test_a_company_without_an_address_writes_no_location() -> None:
    company = _company("en")
    company.address = company.address_ar = None
    assert "LOCATION" not in _event_of(_calendar_email(company))


@pytest.mark.parametrize(
    ("address", "language", "line"),
    [
        (None, Language.EN, None),
        ("", Language.EN, None),
        ("One line", Language.EN, "One line"),
        ("Building 14,\nKing Street,\n\nAmman", Language.EN, "Building 14, King Street, Amman"),
        ("مبنى 14،\nعمّان", Language.AR, "مبنى 14، عمّان"),  # noqa: RUF001 - Arabic text
        (" \n ", Language.EN, None),
    ],
)
def test_an_address_is_one_line_as_a_location(
    address: str | None, language: Language, line: str | None
) -> None:
    assert one_line_address(address, language) == line


def test_the_event_s_stamp_is_when_the_e_mail_is_queued(monkeypatch: pytest.MonkeyPatch) -> None:
    queued = datetime(2026, 10, 19, 12, 0, 1, tzinfo=UTC)
    monkeypatch.setattr("app.email.service.app_time.now", lambda: queued)
    assert _event_of(_calendar_email(_company("en"))).decoded("DTSTAMP") == queued


def test_a_visit_never_stored_counts_as_the_first_version() -> None:
    """A preview's sample visit has no counter (the column's default applies when a row is written)."""
    company = _company("en")
    visit = _visit(company)
    visit.calendar_sequence = None  # type: ignore[assignment]
    assert _event_of(_calendar_email(company, visit))["SEQUENCE"] == 0


@pytest.mark.parametrize("language", ["ar", "en"])
def test_only_the_e_mails_of_a_new_visit_say_that_the_event_is_attached(language: str) -> None:
    company = _company(language)
    service = _service()
    line = {"ar": "الزيارة مرفقة لإضافتها إلى تقويمك.", "en": "The visit is attached for your calendar."}
    host = _host(company, language)
    scheduled = service.queue_host_visit(
        _visit(company), kind=EmailKind.HOST_VISIT_SCHEDULED, company=company, host=host
    ).email
    for email in (_calendar_email(company), scheduled):
        # In both languages of the e-mail, in both parts.
        for text in line.values():
            assert text in email.html and text in email.text
    others = [
        service.queue_host_visit(
            _visit(company), kind=EmailKind.HOST_VISIT_RESCHEDULED, company=company, host=host
        ).email,
        service.queue_visitor_invitation(
            _visit(company), generate_token(), company=company, recipient="d@example.com", host_email=None
        ).email,
    ]
    for email in others:
        assert not any(text in email.html or text in email.text for text in line.values())


def test_a_test_e_mail_carries_no_event_and_does_not_say_one_is_attached() -> None:
    company = _company("en")
    service = _service()
    for kind in (EmailKind.HOST_VISIT_SCHEDULED, EmailKind.HOST_VISIT_CANCELLED):
        prepared = service.prepare_host_visit(
            _visit(company), kind=kind, company=company, host_name="Omar", host_language="en", calendar=False
        )
        assert prepared.event is None
        email = service.queue_prepared(prepared, company_id=company.id, to="admin@demo.test").email
        assert email.calendar is None
        assert "attached for your calendar" not in email.html + email.text
    for prepared in (
        service.prepare_visit_rescheduled(_visit(company), company=company, host_email=None, calendar=False),
        service.prepare_visit_cancelled(
            _visit(company), None, company=company, host_email=None, calendar=False
        ),
    ):
        assert prepared.event is None


def test_a_host_s_arrival_notice_carries_no_event() -> None:
    company = _company("en")
    visit = _visit(company, check_in_at=START)
    email = _service().queue_host_arrival(visit, company=company, host=_host(company)).email
    assert email.calendar is None


@pytest.mark.parametrize("address", ["visitors@demo.test", "Visitors@Demo.TEST", " visitors@demo.test "])
def test_the_sending_mailbox_is_never_sent_an_event_of_its_own(address: str) -> None:
    """B14-5: the organizer of every event is EMAIL_FROM's address. A host (or a visitor) whose address it
    is would be invited to their own event, which Outlook does not add ("As the meeting organizer, you
    do not need to respond"): the e-mail goes without the event, and without the line that says it is
    attached."""
    company = _company("en")
    service = _service()
    assert service.sends_from(address) and not service.sends_from("other@demo.test")
    host = _host(company, "en")
    host.email = address.strip()
    for kind in (
        EmailKind.HOST_VISIT_SCHEDULED,
        EmailKind.HOST_VISIT_RESCHEDULED,
        EmailKind.HOST_VISIT_CANCELLED,
    ):
        email = service.queue_host_visit(_visit(company), kind=kind, company=company, host=host).email
        assert email.calendar is None and email.kind == kind
        assert "attached for your calendar" not in email.html + email.text
    moved = service.queue_visit_rescheduled(
        _visit(company), company=company, recipient=address.strip(), host_email=None
    ).email
    assert moved.calendar is None
    # Anyone else gets the event.
    assert _calendar_email(company, recipient="other@demo.test").calendar is not None


# ---- review fixes (B14-17, B14-19, B14-21, RFC 6868) ------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "Caret ^ Name",
        "Dana^nGuest",  # RFC 6868: `^n` would be read as a line break
        "O^'Neil",  # ... and `^'` as a double quote
        "^^ twice",
        "ن^ص",
    ],
)
def test_a_name_s_carets_are_doubled_and_read_back_as_typed(name: str) -> None:
    """RFC 6868 §3: a reader that decodes parameter values (icalendar does) turns `^n`, `^'` and `^^` into
    a line break, a double quote and one caret; the writer doubles every caret, so the name comes back as
    it was typed, in the organizer's and the attendee's CN."""
    data = write_calendar(
        _event(organizer=CalendarMailbox(name, SENDER), attendee=CalendarMailbox(name, "d@x.test"))
    )
    assert common_name(name) == '"' + name.replace("^", "^^") + '"'
    _, event = _parsed(data)
    assert event["ORGANIZER"].params["CN"] == name and event["ATTENDEE"].params["CN"] == name


def test_the_host_s_event_is_private_and_the_visitor_s_is_not() -> None:
    """B14-19: a host's calendar is often shared with colleagues; `CLASS:PRIVATE` asks the calendar to
    show them the time taken, not the visitor. The visitor's own event keeps the calendar's default."""
    company = _company("en")
    service = _service()
    for kind in (
        EmailKind.HOST_VISIT_SCHEDULED,
        EmailKind.HOST_VISIT_RESCHEDULED,
        EmailKind.HOST_VISIT_CANCELLED,
    ):
        email = service.queue_host_visit(
            _visit(company), kind=kind, company=company, host=_host(company)
        ).email
        assert str(_event_of(email)["CLASS"]) == "PRIVATE"
    for email in (
        _calendar_email(company),
        service.queue_visit_cancelled(
            _visit(company), None, company=company, recipient="dana@example.com", host_email=None
        ).email,
    ):
        assert "CLASS" not in _event_of(email)
    assert "CLASS" not in _parsed(write_calendar(_event()))[1]


def test_a_withdrawal_uninvites_its_attendee_without_cancelling_the_event() -> None:
    """RFC 5546 §3.2.5: a CANCEL that uninvites some attendees has no STATUS (one that cancels the event
    says CANCELLED). Without a description or a location the object says only what identifies it."""
    data = write_calendar(
        _event(method="CANCEL", sequence=1, withdrawn=True, summary="Visit", description=None, location=None)
    )
    calendar, event = _parsed(data)
    assert calendar["METHOD"] == "CANCEL" and event["SEQUENCE"] == 1
    assert {name for name, _ in event.property_items(recursive=False)} == {
        "BEGIN",
        "UID",
        "SEQUENCE",
        "DTSTAMP",
        "DTSTART",
        "DTEND",
        "SUMMARY",
        "ORGANIZER",
        "ATTENDEE",
        "TRANSP",
        "END",
    }
    with pytest.raises(ValueError, match="only a CANCEL"):
        write_calendar(_event(withdrawn=True))


@pytest.mark.parametrize("language", ["ar", "en"])
def test_the_withdrawal_from_an_old_address_says_nothing_of_the_visit(language: str) -> None:
    """B14-17 (D-19): the address the visitor no longer has may be nobody the visit concerns. Its e-mail
    and its event name neither the visitor, the host, the department, the purpose, the address nor the
    date; replies never go to the host; no link. The event is the visitor's (its UID), one version
    newer than what the address was sent, and is taken out of that calendar alone."""
    company = _company(language)
    email = (
        _service()
        .queue_visitor_withdrawal(_visit(company, sequence=2), company=company, recipient="old@example.com")
        .email
    )
    assert email.kind == EmailKind.VISITOR_CALENDAR and email.to == "old@example.com"
    assert email.calendar is not None and email.calendar.method == "CANCEL"
    assert email.reply_to is None  # no EMAIL_REPLY_TO here; never the host's address
    event = _event_of(email)
    assert str(event["UID"]) == f"visit-{VISIT_ID}-visitor" and event["SEQUENCE"] == 2
    assert event.decoded("DTSTART") == START and event.decoded("DTEND") == START + timedelta(hours=1)
    assert str(event["SUMMARY"]) == {"ar": "زيارة", "en": "Visit"}[language]
    assert "STATUS" not in event and "DESCRIPTION" not in event and "LOCATION" not in event
    assert str(event["ATTENDEE"]) == "mailto:old@example.com" and "CN" not in event["ATTENDEE"].params
    assert str(event["ORGANIZER"]) == f"mailto:{SENDER}"
    # The heading and its one sentence, in both languages, in the company's identity and both designs;
    # nothing of the visit.
    headings = {"en": "This visit invitation has been withdrawn", "ar": "سُحبت دعوة الزيارة هذه"}
    for text in headings.values():
        assert text in email.html and text in email.text
    other = "en" if language == "ar" else "ar"
    assert email.html.index(headings[language]) < email.html.index(headings[other])  # the company's first
    assert 'content="light dark"' in email.html and "prefers-color-scheme: dark" in email.html
    assert "Mawdoo3" in email.text.splitlines()[0] and email.sender.endswith(f"<{SENDER}>")
    assert email.subject in {
        "سحب دعوة الزيارة | Visit invitation withdrawn",
        "Visit invitation withdrawn | سحب دعوة الزيارة",
    }
    words = (email.html + email.text).replace("http://www.w3.org/1999/xhtml", "")
    content = email.calendar.content.decode()
    for detail in ("Dana", "عمر", "Finance", "المالية", "Quarterly", "Building", "مبنى", "/pass", "http"):
        assert detail not in words and detail not in content, detail
    for date in ("2026", "October", "أكتوبر", "Tuesday", "الثلاثاء"):  # the date is the event's alone
        assert date not in words, date


@pytest.mark.parametrize(
    ("address", "key"),
    [
        ("visitors@demo.test", "visitors@demo.test"),
        (" Visitors@Demo.TEST ", "visitors@demo.test"),
        ("visitors+calendar@demo.test", "visitors@demo.test"),
        ("v.isitors@demo.test", "v.isitors@demo.test"),  # dots count outside Gmail
        ("Front.Desk+x@gmail.com", "frontdesk@gmail.com"),
        ("front.desk@googlemail.com", "frontdesk@gmail.com"),
        ("not-an-address", "not-an-address"),
        # B14-33: a domain in Unicode and in its ASCII form is one domain.
        ("dana@exämple.com", "dana@xn--exmple-cua.com"),
        ("Dana+x@EXÄMPLE.com", "dana@xn--exmple-cua.com"),
        ("dana@xn--exmple-cua.com", "dana@xn--exmple-cua.com"),
        ("dana@bad..exämple", "dana@bad..exämple"),  # not a domain IDNA writes: compared as it is
    ],
)
def test_an_address_is_compared_as_the_mailbox_it_reaches(address: str, key: str) -> None:
    assert mailbox_key(address) == key


@pytest.mark.parametrize(
    ("sender", "same", "other"),
    [
        (
            "Demo Visitors <visitors@demo.test>",
            ["visitors+hosts@demo.test", "VISITORS+x@demo.test"],
            ["v.isitors@demo.test", "visitors@demo.test.example"],
        ),
        (
            "Front Desk <front.desk@gmail.com>",
            ["frontdesk@gmail.com", "Front.Desk+visits@googlemail.com", "f.r.o.n.t.d.e.s.k@gmail.com"],
            ["frontdesk@example.com", "front.desks@gmail.com"],
        ),
        (
            "Visits <visits@xn--exmple-cua.com>",
            ["visits@exämple.com", "Visits+x@EXÄMPLE.com"],
            ["visits@example.com"],
        ),
    ],
)
def test_the_sending_mailbox_is_recognised_in_any_spelling(
    sender: str, same: list[str], other: list[str]
) -> None:
    """B14-21: Gmail, Google Workspace and Microsoft 365 deliver `name+tag@` to `name@`, and Gmail ignores
    dots and reads googlemail.com as gmail.com: each spelling is the organizer's own mailbox, which is
    sent no event of its own (B14-5)."""
    service = _service()
    service.settings = service.settings.model_copy(update={"email_from": sender})
    assert all(service.sends_from(address) for address in same)
    assert not any(service.sends_from(address) for address in other)
    company = _company("en")
    host = _host(company)
    host.email = same[-1]
    email = service.queue_host_visit(
        _visit(company), kind=EmailKind.HOST_VISIT_SCHEDULED, company=company, host=host
    ).email
    assert email.calendar is None
