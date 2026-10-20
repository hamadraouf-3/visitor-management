"""SmtpProvider against real SMTP servers on 127.0.0.1 (S10-7): aiosmtpd with STARTTLS, implicit TLS or
plain text and AUTH, behind a throwaway self-signed certificate that the provider's context trusts; raw TCP
listeners for silent servers, refused greetings and other misbehaviour (replies spread out over time,
replies that never end, a hang-up after a refusal). Covers the message as a mail client receives it (the
inline QR code decoded back to the pass URL), header injection (encoded words included), the
transient/permanent classification, the per-delivery deadline, and that no credential reaches a log record
or an error."""

import base64
import logging
import select
import socket
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.qr import qr_matrix
from app.email.logos import light_rendition
from app.email.providers.base import EmailDeliveryError, InlineImage, OutgoingEmail
from app.email.providers.smtp import SmtpProvider, SmtpServer, _Budget, _ReplyReader
from app.email.rendering import EmailRenderer
from app.email.service import (
    LOGO_CONTENT_ID,
    NO_TEMPLATE_TEXTS,
    QR_CONTENT_ID,
    EmailService,
)
from app.models import Company, EmailKind, User, Visit
from app.security.tokens import generate_token
from tests.png_support import SAMPLE_LOGO as COMPANY_LOGO
from tests.png_support import CompanyLogos
from tests.qr_png import qr_modules
from tests.smtp_support import (
    HOST,
    Certificate,
    Credentials,
    RawServer,
    ScriptedServer,
    SmtpTestServer,
    closed_port,
    make_certificate,
    smtp_server,
)

USERNAME = "visitors@demo.test"
PASSWORD = "abcdefghijklmnop"  # the shape of a Gmail App Password
NOW = datetime(2026, 10, 7, 8, 30, tzinfo=UTC)
START = datetime(2026, 10, 12, 7, 0, tzinfo=UTC)
RECIPIENT = "dana@example.com"
HOST_EMAIL = "omar.khalil@demo.test"
ALLOWED_HEADERS = {
    "from",
    "to",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
    "content-id",
}


# ---- servers and messages -----------------------------------------------------------------------


@pytest.fixture(scope="module")
def certificate(tmp_path_factory: pytest.TempPathFactory) -> Certificate:
    return make_certificate(tmp_path_factory.mktemp("smtp-certificate"))


@pytest.fixture(scope="module")
def starttls_server(certificate: Certificate) -> Iterator[SmtpTestServer]:
    with smtp_server(
        security="starttls", certificate=certificate, credentials=Credentials(USERNAME, PASSWORD)
    ) as server:
        yield server


@pytest.fixture
def server(starttls_server: SmtpTestServer) -> SmtpTestServer:
    """The STARTTLS server with AUTH (Gmail's setup: port 587, STARTTLS, user name and App Password)."""
    starttls_server.handler.reset()
    credentials = starttls_server.credentials
    assert credentials is not None
    credentials.password, credentials.failure_reply, credentials.attempts = PASSWORD, None, 0
    return starttls_server


def _provider(
    port: int,
    certificate: Certificate | None,
    *,
    security: str = "starttls",
    username: str | None = USERNAME,
    password: str | None = PASSWORD,
    timeout: float = 5.0,
) -> SmtpProvider:
    return SmtpProvider(
        SmtpServer(
            host=HOST,
            port=port,
            security=security,  # type: ignore[arg-type]
            username=username,
            password=SecretStr(password) if password is not None else None,
            timeout_seconds=timeout,
        ),
        ehlo_name="vms.test",
        ssl_context=certificate.client_context() if certificate is not None else None,
        clock=lambda: NOW,
    )


def _settings(**values: object) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.test",
        email_from="Demo Visitors <visitors@demo.test>",
        **values,
    )


class _Messages:
    def add(self, message: object) -> object:
        return message


def _invitation(
    *,
    company_name: str = "Mawdoo3",
    company_name_ar: str | None = None,
    recipient: str = RECIPIENT,
    default_language: str = "en",
    **visit: str,
) -> OutgoingEmail:
    """A real invitation of a company with a logo, rendered by EmailService (with its pass URL, its QR
    code and the company's logo, B12-12)."""
    company = Company(
        id=uuid.uuid4(),
        name=company_name,
        name_ar=company_name_ar,
        default_language=default_language,
        slug="demo",
        timezone="Asia/Amman",
        address="Building 14\nKing Abdullah II Street, Amman",
        notify_host_on_check_in=True,
    )
    values = {
        "visitor_name": "Dana Guest",
        "visitor_company_name": "Acme",
        "host_name": "Omar Khalil",
        "department_name": "Finance",
        "purpose": "Quarterly review",
        **visit,
    }
    record = Visit(
        id=uuid.uuid4(),
        company_id=company.id,
        scheduled_start=START,
        scheduled_end=START + timedelta(hours=1),
        window_start=START - timedelta(hours=1),
        window_end=START + timedelta(hours=2),
        **values,
    )
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=_settings(),
        renderer=EmailRenderer(),
        provider_name="smtp",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=CompanyLogos(COMPANY_LOGO, 240, 80),
    )
    service.messages = _Messages()  # type: ignore[assignment]
    return service.queue_visitor_invitation(
        record, generate_token(), company=company, recipient=recipient, host_email=HOST_EMAIL
    ).email


def _simple(**changes: object) -> OutgoingEmail:
    values: dict[str, object] = {
        "message_id": uuid.UUID("12345678-1234-5678-1234-567812345678"),
        "kind": EmailKind.PASSWORD_RESET,
        "to": RECIPIENT,
        "subject": "Reset your password",
        "html": "<p>Hello</p>",
        "text": "Hello",
        "sender": "Demo Visitors <visitors@demo.test>",
    }
    values.update(changes)
    return OutgoingEmail(**values)  # type: ignore[arg-type]


def _parts(message: EmailMessage) -> tuple[EmailMessage, EmailMessage, EmailMessage]:
    """(text/plain, text/html, the QR code's image/png) of
    multipart/alternative > [text, related > [html, QR png, logo png]]. The company's logo (B10-6, B12-12)
    is checked here: inline, its own Content-ID, the company's PNG as it was stored."""
    assert message.get_content_type() == "multipart/alternative"
    text, related = message.iter_parts()
    assert text.get_content_type() == "text/plain"
    assert related.get_content_type() == "multipart/related"
    html, image, logo = related.iter_parts()
    assert html.get_content_type() == "text/html" and image.get_content_type() == "image/png"
    assert logo.get_content_type() == "image/png" and logo["Content-ID"] == f"<{LOGO_CONTENT_ID}>"
    assert logo.get_content_disposition() == "inline" and logo.get_filename() == "brand-logo.png"
    assert (
        logo["Content-Transfer-Encoding"] == "base64"
        and logo.get_content() == light_rendition(COMPANY_LOGO).content
    )
    assert f'src="cid:{LOGO_CONTENT_ID}"' in _body(html)  # type: ignore[arg-type]
    return text, html, image  # type: ignore[return-value]


def _body(part: EmailMessage) -> str:
    content = part.get_content()
    assert isinstance(content, str)
    return content.replace("\r\n", "\n")


def _failure(provider: SmtpProvider, email: OutgoingEmail | None = None, **send: float) -> EmailDeliveryError:
    with pytest.raises(EmailDeliveryError) as caught:
        provider.send(email or _invitation(), **send)
    return caught.value


# ---- delivery ------------------------------------------------------------------------------------


def test_starttls_delivers_an_invitation_with_its_qr_code_inline(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    email = _invitation()
    result = _provider(server.port, certificate).send(email, timeout_seconds=20.0)

    message_id = f"vms-email-{email.message_id}@demo.test"
    assert result.provider_message_id == message_id
    [received] = server.handler.received
    # The envelope names the sender and exactly the one recipient.
    assert received.mail_from == "visitors@demo.test" and received.rcpt_tos == [RECIPIENT]
    assert server.credentials is not None and server.credentials.attempts == 1
    # EHLO with the application's name, before and after STARTTLS (RFC 3207 discards what came before).
    assert server.handler.ehlo_names == ["vms.test", "vms.test"]

    message = received.message()
    # The company's name, the configured address (B12-13); the envelope's sender is that address.
    assert message["From"] == "Mawdoo3 <visitors@demo.test>"
    assert message["To"] == RECIPIENT
    assert message["Reply-To"] == HOST_EMAIL  # the host, as with Resend (B24-71)
    assert (
        message["Subject"]
        == email.subject
        == (
            "Your visit to Mawdoo3 on Monday, 12 October 2026 | "
            "زيارتك إلى Mawdoo3 يوم الاثنين، 12 تشرين الأول 2026"
        )
    )
    assert message["Message-ID"] == f"<{message_id}>"
    assert parsedate_to_datetime(message["Date"]) == NOW

    text, html, image = _parts(message)
    # The bodies as rendered (the wire's CRLF line ends aside).
    text_body, html_body = (_body(part) for part in (text, html))
    assert text_body.rstrip("\n") == email.text.rstrip("\n")
    assert html_body.rstrip("\n") == email.html.rstrip("\n")
    # The image is inline, and its Content-ID is the one the HTML refers to.
    assert f'src="cid:{QR_CONTENT_ID}"' in html_body
    assert image["Content-ID"] == f"<{QR_CONTENT_ID}>"
    assert image.get_content_disposition() == "inline" and image.get_filename() == f"{QR_CONTENT_ID}.png"
    # The PNG received is the QR code of exactly the pass URL, which the HTML and the text link to as well.
    assert email.pass_url is not None
    assert qr_modules(image.get_content()) == qr_matrix(email.pass_url)
    assert f'href="{email.pass_url}"' in html_body and email.pass_url in text_body
    # 7-bit throughout (quoted-printable text, base64 image): no server needs 8BITMIME.
    assert received.data.isascii()
    assert text["Content-Transfer-Encoding"] == html["Content-Transfer-Encoding"] == "quoted-printable"
    assert image["Content-Transfer-Encoding"] == "base64"


def test_implicit_tls_delivers(certificate: Certificate) -> None:
    with smtp_server(
        security="ssl", certificate=certificate, credentials=Credentials(USERNAME, PASSWORD)
    ) as tls:
        _provider(tls.port, certificate, security="ssl").send(_invitation(), timeout_seconds=20.0)
        [received] = tls.handler.received
        assert received.rcpt_tos == [RECIPIENT]
        assert tls.credentials is not None and tls.credentials.attempts == 1
        _text, _html, image = _parts(received.message())
        assert image["Content-ID"] == f"<{QR_CONTENT_ID}>"


def _calendar_emails() -> tuple[OutgoingEmail, OutgoingEmail]:
    """The visitor's calendar invitation (a REQUEST, B14-10) and the host's notice of a cancellation (a
    CANCEL, B14-2) of a company with a logo, rendered by EmailService."""
    company = Company(
        id=uuid.uuid4(),
        name="Mawdoo3",
        name_ar="موضوع",
        default_language="ar",
        slug="demo",
        timezone="Asia/Amman",
        address="Building 14\nKing Abdullah II Street, Amman",
        notify_host_on_check_in=True,
    )
    visit = Visit(
        id=uuid.uuid4(),
        company_id=company.id,
        visitor_name="Dana Guest",
        visitor_company_name="Acme",
        host_name="Omar Khalil",
        department_name="Finance",
        purpose="Quarterly review",
        scheduled_start=START,
        scheduled_end=START + timedelta(hours=1),
        window_start=START - timedelta(hours=1),
        window_end=START + timedelta(hours=2),
        calendar_sequence=2,
    )
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=_settings(),
        renderer=EmailRenderer(),
        provider_name="smtp",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=CompanyLogos(COMPANY_LOGO, 240, 80),
    )
    service.messages = _Messages()  # type: ignore[assignment]
    invitation = service.queue_visitor_calendar(
        visit, company=company, recipient=RECIPIENT, host_email=HOST_EMAIL
    ).email
    host = User(
        id=uuid.uuid4(),
        company_id=company.id,
        full_name="Omar Khalil",
        email=HOST_EMAIL,
        preferred_language="en",
    )
    cancelled = service.queue_host_visit(
        visit, kind=EmailKind.HOST_VISIT_CANCELLED, company=company, host=host, reason="Plans changed"
    ).email
    return invitation, cancelled


@pytest.mark.parametrize(("which", "method"), [(0, "REQUEST"), (1, "CANCEL")])
def test_a_calendar_event_travels_as_the_tree_outlook_gmail_and_apple_read(
    server: SmtpTestServer, certificate: Certificate, which: int, method: str
) -> None:
    """B14-7: multipart/mixed > [multipart/alternative > [text/plain, multipart/related > [text/html,
    logo], text/calendar; method=…], application/ics attachment]. The text/calendar part is the last
    alternative, has no Content-Disposition ([MS-STANOICAL]: an attachment is not imported as iMIP data)
    and carries the iTIP method as its parameter (RFC 6047 §2.4); both copies are the object as written,
    octet for octet."""
    email = _calendar_emails()[which]
    assert email.calendar is not None and email.calendar.method == method
    _provider(server.port, certificate).send(email, timeout_seconds=20.0)
    [received] = server.handler.received
    message = received.message()
    assert message.get_content_type() == "multipart/mixed"
    # The company's name in the e-mail's language (the visitor's: the company's; the host's: English).
    assert message["From"] == ("موضوع" if which == 0 else "Mawdoo3") + " <visitors@demo.test>"
    alternative, attachment = message.iter_parts()
    assert alternative.get_content_type() == "multipart/alternative"
    text, related, calendar = alternative.iter_parts()
    assert text.get_content_type() == "text/plain" and related.get_content_type() == "multipart/related"
    html, logo = related.iter_parts()
    assert html.get_content_type() == "text/html" and logo["Content-ID"] == f"<{LOGO_CONTENT_ID}>"
    # The invitation: text/calendar with the method, UTF-8, no disposition, base64 (7-bit on the wire).
    assert calendar.get_content_type() == "text/calendar"
    assert calendar.get_param("method") == method and calendar.get_param("charset") == "UTF-8"
    assert calendar.get_content_disposition() is None and calendar["Content-Transfer-Encoding"] == "base64"
    assert calendar.get_payload(decode=True) == email.calendar.content
    # The same object as invite.ics, an attachment of the whole message.
    assert attachment.get_content_type() == "application/ics"
    assert attachment.get_content_disposition() == "attachment" and attachment.get_filename() == "invite.ics"
    assert attachment.get_param("name") == "invite.ics"
    assert attachment.get_payload(decode=True) == email.calendar.content
    assert received.data.isascii()
    # The bodies arrive as rendered, and the headers are the message's own.
    assert _body(html).rstrip("\n") == email.html.rstrip("\n")
    assert _body(text).rstrip("\n") == email.text.rstrip("\n")
    assert {name.lower() for name in message} <= ALLOWED_HEADERS
    assert message["Message-ID"] == f"<vms-email-{email.message_id}@demo.test>"


def test_a_message_without_an_event_keeps_its_tree() -> None:
    """Every other e-mail is the tree it was: no mixed part, no calendar."""
    with smtp_server(security="none") as capture:
        _provider(capture.port, None, security="none", username=None, password=None).send(_invitation())
        message = capture.handler.received[0].message()
        assert message.get_content_type() == "multipart/alternative"
        assert not any(part.get_content_type() == "text/calendar" for part in message.walk())


def test_an_event_with_an_unknown_method_is_not_sent() -> None:
    email = _calendar_emails()[0]
    assert email.calendar is not None
    broken = replace(email, calendar=replace(email.calendar, method="PUBLISH"))
    with smtp_server(security="none") as capture:
        provider = _provider(capture.port, None, security="none", username=None, password=None)
        with pytest.raises(EmailDeliveryError, match="could not be built") as caught:
            provider.send(broken)
        assert caught.value.transient is False and capture.handler.received == []


def test_plain_text_to_a_local_capture_server() -> None:
    with smtp_server(security="none") as capture:
        email = _invitation()
        _provider(capture.port, None, security="none", username=None, password=None).send(email)
        [received] = capture.handler.received
        assert received.message()["Subject"] == email.subject


def test_credentials_are_never_sent_unencrypted() -> None:
    with pytest.raises(ValueError, match="unencrypted"):
        _provider(25, None, security="none")
    with pytest.raises(ValueError, match="go together"):
        _provider(587, None, password=None)


def test_retries_of_one_message_carry_the_same_message_id(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    provider = _provider(server.port, certificate)
    email = _invitation()
    provider.send(email)
    provider.send(email)
    first, second = (received.message()["Message-ID"] for received in server.handler.received)
    assert first == second == f"<vms-email-{email.message_id}@demo.test>"


def test_without_a_reply_address_there_is_no_reply_to(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    provider = _provider(server.port, certificate)
    provider.send(_simple(reply_to=None))
    provider.send(_simple(reply_to="not an address"))  # only a misconfigured EMAIL_REPLY_TO can be that
    for received in server.handler.received:
        assert "Reply-To" not in received.message()
    message = server.handler.received[0].message()
    assert message.get_content_type() == "multipart/alternative"  # text and HTML, no related part
    assert [part.get_content_type() for part in message.iter_parts()] == ["text/plain", "text/html"]


def test_international_addresses(certificate: Certificate) -> None:
    with (
        smtp_server(security="none") as utf8,
        smtp_server(security="none", enable_SMTPUTF8=False) as ascii_only,
    ):
        # A domain with non-ASCII letters is sent in its ASCII (IDNA) form: any server takes it.
        for capture in (utf8, ascii_only):
            _provider(capture.port, None, security="none", username=None, password=None).send(
                _simple(to="dana@exämple.com")
            )
            [received] = capture.handler.received
            assert (
                received.rcpt_tos == ["dana@xn--exmple-cua.com"] and "SMTPUTF8" not in received.mail_options
            )
        # A non-ASCII local part needs SMTPUTF8 from the server.
        _provider(utf8.port, None, security="none", username=None, password=None).send(
            _simple(to="dänä@example.com")
        )
        assert utf8.handler.received[-1].rcpt_tos == ["dänä@example.com"]
        assert "SMTPUTF8" in utf8.handler.received[-1].mail_options
        error = _failure(
            _provider(ascii_only.port, None, security="none", username=None, password=None),
            _simple(to="dänä@example.com"),
        )
        assert error.transient is False and "SMTPUTF8" in str(error)
        assert len(ascii_only.handler.received) == 1


def test_a_message_without_a_valid_sender_is_not_attempted() -> None:
    provider = _provider(closed_port(), None, security="none", username=None, password=None)
    for sender in ("", "Mawdoo3 Visitors", "a@b.test, c@d.test"):
        error = _failure(provider, _simple(sender=sender))
        assert error.transient is False and str(error) == "EMAIL_FROM is not a valid e-mail address."


# ---- header injection ----------------------------------------------------------------------------

HOSTILE = (
    "\r\nBcc: victim@evil.test",
    "\nX-Injected: 1",
    "\rX-Injected: 2",
    "\u2028X-Injected: 3",
    "\u2029Bcc: victim@evil.test",
    "\x85X-Injected: 4",
    "\x0bX-Injected: 5\x0cX-Injected: 6",
    "\x1cX-Injected: 7\x1dX-Injected: 8\x1eX-Injected: 9",
)


@pytest.mark.parametrize("payload", HOSTILE)
def test_no_header_can_be_injected_through_names_purpose_or_company(
    server: SmtpTestServer, certificate: Certificate, payload: str
) -> None:
    email = _invitation(
        company_name=f"Demo{payload}",
        visitor_name=f"Guest{payload}",
        visitor_company_name=f"Acme{payload}",
        host_name=f"Omar{payload}",
        department_name=f"Finance{payload}",
        purpose=f"Review{payload}",
    )
    _provider(server.port, certificate).send(email)

    [received] = server.handler.received
    assert received.rcpt_tos == [RECIPIENT]  # no further recipient
    message = received.message()
    for part in message.walk():
        assert {name.lower() for name in part} <= ALLOWED_HEADERS
    assert len(message.get_all("Subject") or []) == 1 and len(message.get_all("To") or []) == 1
    subject = message["Subject"]
    assert subject.startswith("Your visit to Demo ") and "\n" not in subject and "\r" not in subject
    _text, _html, image = _parts(message)
    assert email.pass_url is not None and qr_modules(image.get_content()) == qr_matrix(email.pass_url)


@pytest.mark.parametrize("payload", HOSTILE)
@pytest.mark.parametrize("field", ["subject", "sender", "reply_to"])
def test_the_provider_keeps_line_breaks_out_of_headers_on_its_own(
    server: SmtpTestServer, certificate: Certificate, field: str, payload: str
) -> None:
    """Without EmailService's sanitising: the provider's own defence for every header it sets. The message
    goes out with the text on one line, or (a sender that is no longer an address) is refused unsent."""
    values = {
        "subject": f"Hello{payload}",
        "sender": f"Demo{payload} <visitors@demo.test>",
        "reply_to": f"reception@demo.test{payload}",
    }
    refused: EmailDeliveryError | None = None
    try:
        _provider(server.port, certificate).send(_simple(**{field: values[field]}))
    except EmailDeliveryError as error:
        refused = error
    if refused is not None:
        assert field == "sender" and refused.transient is False
        assert server.handler.received == []
        return
    [received] = server.handler.received
    assert received.rcpt_tos == [RECIPIENT]
    message = received.message()
    assert {name.lower() for name in message} <= ALLOWED_HEADERS
    assert len(message.get_all("Subject") or []) == 1
    if field == "subject":
        assert message["Subject"].startswith("Hello ") and message["Subject"].count("X-Injected") <= 3


@pytest.mark.parametrize(
    "recipient",
    [f"{RECIPIENT}\r\nBcc: victim@evil.test", f"{RECIPIENT}, victim@evil.test", f"Dana <{RECIPIENT}>"],
)
def test_the_recipient_is_exactly_one_bare_address(
    server: SmtpTestServer, certificate: Certificate, recipient: str
) -> None:
    error = _failure(_provider(server.port, certificate), _simple(to=recipient))
    assert error.transient is False and str(error) == "The recipient is not a valid e-mail address."
    assert server.handler.received == []


ENCODED_WORDS = (
    "=?utf-8?q?Acme=0D=0ABcc:_victim@evil.test?=",
    "=?utf-8?b?QWNtZQ0KQmNjOiB2aWN0aW1AZXZpbC50ZXN0?=",
    "Acme=?utf-8?q?=0AX-Injected:_1?=Corp",
)


@pytest.mark.parametrize("company_name", ENCODED_WORDS)
def test_an_encoded_word_in_the_subject_stays_literal_text(
    server: SmtpTestServer, certificate: Certificate, company_name: str
) -> None:
    """The `email` package decodes RFC 2047 encoded words in the text it is given: a company name written
    as one would reach a mail client as a subject with a line break in it. The provider breaks the
    `=?` that opens one, so the subject a client decodes is the text as typed (on one line)."""
    email = _invitation(company_name=company_name)
    _provider(server.port, certificate).send(email)
    [received] = server.handler.received
    subject = received.message()["Subject"]
    assert subject == email.subject.replace("=?", "= ?")
    assert subject.startswith("Your visit to ") and "\r" not in subject and "\n" not in subject
    # The bilingual subject reaches the wire as encoded words (it holds Arabic); the headers stay 7-bit.
    assert received.data.split(b"\r\n\r\n", 1)[0].isascii()
    # The English half alone is ASCII: it is sent as text, with no encoded word anywhere in the headers.
    english = email.subject.split(" | ")[0]
    server.handler.reset()
    _provider(server.port, certificate).send(_simple(subject=english))
    [plain] = server.handler.received
    assert plain.message()["Subject"] == english.replace("=?", "= ?")
    assert b"=?" not in plain.data.split(b"\r\n\r\n", 1)[0]


def test_an_arabic_subject_is_sent_as_utf_8_encoded_words(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    """Phase 10 (B10-9): an Arabic-led invitation's subject is RFC 2047 encoded (UTF-8), folded into
    lines a server accepts, and decodes to exactly the subject rendered."""
    email = _invitation(default_language="ar")
    assert email.subject.startswith("زيارتك إلى Mawdoo3 يوم الاثنين، 12 تشرين الأول 2026 | Your visit to ")
    _provider(server.port, certificate).send(email)
    [received] = server.handler.received
    headers = received.data.split(b"\r\n\r\n", 1)[0]
    assert headers.isascii() and all(len(line) <= 998 for line in headers.split(b"\r\n"))
    raw_subject = next(
        line for line in headers.decode("ascii").split("\r\n") if line.lower().startswith("subject:")
    )
    assert "=?utf-8?" in raw_subject.lower()
    assert received.message()["Subject"] == email.subject
    # The Arabic text part of the message reads back as rendered, Arabic first.
    text, html, _image = _parts(received.message())
    assert _body(text).rstrip("\n") == email.text.rstrip("\n")
    assert _body(html).startswith('<!DOCTYPE html>\n<html lang="ar" dir="rtl"')


@pytest.mark.parametrize(
    "address",
    [
        "=?utf-8?q?bcc=3a_x=40evil.test=0d=0a?=@example.com",
        "=?utf-8?b?YmNjOiB4QGV2aWwudGVzdA0K?=@example.com",
        "dana@=?utf-8?q?evil=2etest?=.example.com",
    ],
)
def test_an_address_holding_an_encoded_word_is_never_used(
    server: SmtpTestServer, certificate: Certificate, address: str
) -> None:
    """RFC 2047 §5: an encoded word never appears in an address. The `email` package would decode one in
    the To header (a different mailbox from the envelope's, and one a strict parser refuses), so the
    provider refuses such a recipient or sender and leaves out such a Reply-To."""
    provider = _provider(server.port, certificate)
    error = _failure(provider, _simple(to=address))
    assert error.transient is False and str(error) == "The recipient is not a valid e-mail address."
    error = _failure(provider, _simple(sender=f"Demo Visitors <{address}>"))
    assert error.transient is False and str(error) == "EMAIL_FROM is not a valid e-mail address."
    assert server.handler.received == []
    provider.send(_simple(reply_to=address))
    [received] = server.handler.received
    assert "Reply-To" not in received.message()


def test_inline_images_with_unsafe_content_ids_are_refused(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    for image in (
        InlineImage(content_id="qr>\r\nBcc: x@evil.test", filename="qr.png", content=b"\x89PNG"),
        InlineImage(content_id="qr", filename="qr.png", content=b"\x89PNG", mime_type="image/png\r\nX: 1"),
    ):
        error = _failure(_provider(server.port, certificate), _simple(inline_images=(image,)))
        assert error.transient is False
    assert server.handler.received == []


# ---- sign-in -------------------------------------------------------------------------------------


def test_a_refused_sign_in_is_permanent_and_logged_once(
    server: SmtpTestServer, certificate: Certificate, caplog: pytest.LogCaptureFixture
) -> None:
    provider = _provider(server.port, certificate, password="wrong-password-123")
    caplog.set_level(logging.DEBUG)

    first, second = _failure(provider), _failure(provider)

    for error in (first, second):
        assert error.transient is False
        assert str(error) == (
            "The mail server refused the SMTP sign-in (SMTP 535 5.7.8); check SMTP_USERNAME and "
            "SMTP_PASSWORD."
        )
    problems = [record for record in caplog.records if record.getMessage().startswith("SMTP configuration")]
    [record] = problems  # once, not once per message
    assert record.levelno == logging.ERROR and record.name == "app.email"
    assert "SMTP_USERNAME and SMTP_PASSWORD" in record.getMessage() and "App Password" in record.getMessage()
    assert server.handler.received == []

    # A message that goes through again re-arms the report.
    assert server.credentials is not None
    server.credentials.password = "wrong-password-123"
    provider.send(_invitation())
    server.credentials.password = PASSWORD
    _failure(provider)
    assert len([r for r in caplog.records if r.getMessage().startswith("SMTP configuration")]) == 2


@pytest.mark.parametrize(
    ("reply", "transient", "label"),
    [
        ("535 5.7.8 Username and Password not accepted", False, "SMTP 535 5.7.8"),
        ("534 5.7.9 Application-specific password required", False, "SMTP 534 5.7.9"),
        ("454 4.7.0 Temporary authentication failure", True, "SMTP 454 4.7.0"),
    ],
)
def test_sign_in_failures(
    server: SmtpTestServer, certificate: Certificate, reply: str, transient: bool, label: str
) -> None:
    assert server.credentials is not None
    server.credentials.failure_reply = reply
    error = _failure(_provider(server.port, certificate, password="not-the-password"))
    assert error.transient is transient and f"({label})" in str(error)


def test_a_refused_sign_in_costs_one_attempt_per_message(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    """The server offers PLAIN and LOGIN: a wrong password is tried once per message, not once per
    mechanism (each refusal counts towards the account's lockout)."""
    provider = _provider(server.port, certificate, password="wrong-password-123")
    for _message in range(2):
        error = _failure(provider)
        assert error.transient is False and "(SMTP 535 5.7.8)" in str(error)
    assert server.credentials is not None and server.credentials.attempts == 2


def test_sign_in_uses_login_when_plain_is_not_offered(certificate: Certificate) -> None:
    with smtp_server(
        security="starttls",
        certificate=certificate,
        credentials=Credentials(USERNAME, PASSWORD),
        auth_exclude_mechanism=["PLAIN"],
    ) as login_only:
        _provider(login_only.port, certificate).send(_simple())
        assert login_only.credentials is not None and login_only.credentials.attempts == 1
        assert len(login_only.handler.received) == 1


def test_a_server_that_hangs_up_after_refusing_the_sign_in(
    certificate: Certificate, caplog: pytest.LogCaptureFixture
) -> None:
    """Over implicit TLS the server answers AUTH with 535 and closes the connection: the error is the
    refused sign-in (permanent, logged with what to check), not a dropped connection to retry."""
    commands: list[bytes] = []
    context = certificate.server_context()

    def serve(connection: socket.socket, stopping: threading.Event) -> None:
        with context.wrap_socket(connection, server_side=True) as tls, tls.makefile("rb") as lines:
            tls.sendall(b"220 test ESMTP\r\n")
            for line in lines:
                commands.append(line.split(b" ", 1)[0].upper())
                if commands[-1] == b"EHLO":
                    tls.sendall(b"250-test\r\n250 AUTH PLAIN LOGIN\r\n")
                elif commands[-1] == b"AUTH":
                    tls.sendall(b"535 5.7.8 Username and Password not accepted\r\n")
                    return

    with ScriptedServer(serve) as strict:
        error = _failure(_provider(strict.port, certificate, security="ssl"))
    assert error.transient is False
    assert str(error) == (
        "The mail server refused the SMTP sign-in (SMTP 535 5.7.8); check SMTP_USERNAME and SMTP_PASSWORD."
    )
    assert commands == [b"EHLO", b"AUTH"] and strict.connections == 1
    assert any("refused the SMTP sign-in" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize(
    ("replies", "transient", "expected"),
    [
        (("", "421 4.7.0 Try again later, closing connection. (EHLO)"), True,
         "The mail server deferred the greeting (EHLO) (SMTP 421 4.7.0)."),
        (("", "554 5.7.1 Access denied"), False,
         "The mail server refused the greeting (EHLO) (SMTP 554 5.7.1)."),
        (("421 4.7.0 Try again later, closing connection. (EHLO)",), True,
         "The mail server deferred the greeting (EHLO) (SMTP 421 4.7.0)."),
    ],
    ids=["421 after STARTTLS", "554 after STARTTLS", "421 before STARTTLS"],
)  # fmt: skip
def test_a_refused_ehlo_is_reported_as_such(
    server: SmtpTestServer,
    certificate: Certificate,
    caplog: pytest.LogCaptureFixture,
    replies: tuple[str, ...],
    transient: bool,
    expected: str,
) -> None:
    """Gmail answers EHLO with `421 4.7.0 Try again later` when it throttles. smtplib returns an EHLO's
    error reply instead of raising it, and reads it as "no extensions": unchecked, the 421 became a
    permanent "no AUTH" (after STARTTLS) or "no STARTTLS" (before it) configuration problem."""
    server.handler.script("EHLO", *replies)
    error = _failure(_provider(server.port, certificate))
    assert error.transient is transient and str(error) == expected
    assert not any(record.getMessage().startswith("SMTP configuration") for record in caplog.records)
    assert server.credentials is not None and server.credentials.attempts == 0
    assert server.handler.received == []


def test_a_server_without_starttls_is_refused_never_used_in_plain_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with smtp_server(security="none") as plain:
        error = _failure(_provider(plain.port, None))
        assert error.transient is False
        assert str(error) == "The mail server does not offer STARTTLS; check SMTP_SECURITY and SMTP_PORT."
        assert plain.handler.received == []
    assert any("does not offer STARTTLS" in record.getMessage() for record in caplog.records)


def test_a_server_without_auth(certificate: Certificate) -> None:
    # Implicit TLS where the server offers no AUTH at all, and STARTTLS where it offers no mechanism.
    with smtp_server(security="ssl", certificate=certificate, auth_require_tls=True) as no_auth:
        error = _failure(_provider(no_auth.port, certificate, security="ssl"))
        assert error.transient is False and "does not offer SMTP sign-in" in str(error)
    with smtp_server(
        security="starttls",
        certificate=certificate,
        credentials=Credentials(USERNAME, PASSWORD),
        auth_exclude_mechanism=["LOGIN", "PLAIN"],
    ) as no_mechanism:
        error = _failure(_provider(no_mechanism.port, certificate))
        assert error.transient is False and "no SMTP sign-in method" in str(error)


# ---- refusals and failures ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("command", "reply", "transient", "expected"),
    [
        ("RCPT", "550 5.1.1 <dana@example.com>: Recipient address rejected: User unknown", False,
         "The mail server rejected the recipient address (SMTP 550 5.1.1)."),
        ("RCPT", "553 5.1.3 <dana@example.com>: Recipient address rejected: bad syntax", False,
         "The mail server rejected the recipient address (SMTP 553 5.1.3)."),
        ("RCPT", "450 4.2.1 <dana@example.com>: Mailbox busy", True,
         "The mail server deferred the recipient (SMTP 450 4.2.1)."),
        ("RCPT", "421 4.7.0 Try again later, closing connection", True,
         "The mail server deferred the recipient (SMTP 421 4.7.0)."),
        ("MAIL", "553 5.7.1 <visitors@demo.test>: Sender address rejected: not owned by user", False,
         "The mail server refused the sender address (SMTP 553 5.7.1); check EMAIL_FROM."),
        ("MAIL", "451 4.3.0 Temporary lookup failure", True,
         "The mail server deferred the sender (SMTP 451 4.3.0)."),
        ("MAIL", "530 5.7.0 Authentication Required", False,
         "The mail server requires SMTP sign-in (SMTP 530 5.7.0)."),
        ("DATA", "451 4.3.0 Error: queue file write error", True,
         "The mail server deferred the message (SMTP 451 4.3.0)."),
        ("DATA", "421 4.3.2 Service shutting down", True,
         "The mail server deferred the message (SMTP 421 4.3.2)."),
        ("DATA", "554 5.7.1 Message rejected as spam", False,
         "The mail server rejected the message (SMTP 554 5.7.1)."),
        ("DATA", "552 Message size exceeds fixed limit", False,
         "The mail server rejected the message (SMTP 552)."),
    ],
)  # fmt: skip
def test_replies_are_classified(
    server: SmtpTestServer, certificate: Certificate, command: str, reply: str, transient: bool, expected: str
) -> None:
    server.handler.script(command, reply)
    error = _failure(_provider(server.port, certificate))
    assert error.transient is transient
    assert str(error) == expected  # the code and enhanced status only: never the server's own text
    assert server.handler.received == []


@pytest.mark.parametrize(
    ("greeting", "transient", "expected"),
    [
        (b"421 4.3.2 Service not available\r\n", True,
         "The mail server is not accepting connections right now (SMTP 421 4.3.2)."),
        (b"554 5.7.1 No SMTP service here\r\n", False,
         "The mail server refused the connection (SMTP 554 5.7.1)."),
    ],
)  # fmt: skip
def test_a_refused_greeting(greeting: bytes, transient: bool, expected: str) -> None:
    with RawServer(greeting) as raw:
        error = _failure(_provider(raw.port, None, security="none", username=None, password=None))
    assert error.transient is transient and str(error) == expected


def test_a_server_that_never_answers_times_out() -> None:
    email = _invitation()  # rendered before the clock starts: only the attempt is timed
    with RawServer(greeting=None) as silent:
        started = time.monotonic()
        error = _failure(
            _provider(silent.port, None, security="none", username=None, password=None, timeout=1.0), email
        )
        elapsed = time.monotonic() - started
    assert error.transient is True and str(error) == "The mail server did not respond in time."
    assert 0.9 <= elapsed < 3.0


def test_a_refused_connection_is_transient() -> None:
    error = _failure(_provider(closed_port(), None, security="none", username=None, password=None))
    assert error.transient is True and str(error).startswith("Could not connect to the mail server")


def test_an_untrusted_certificate_is_permanent(
    server: SmtpTestServer, caplog: pytest.LogCaptureFixture
) -> None:
    # The system's trusted certificates (the production default) do not include the test's own.
    provider = SmtpProvider(
        SmtpServer(
            host=HOST, port=server.port, username=USERNAME, password=SecretStr(PASSWORD), timeout_seconds=5
        )
    )
    error = _failure(provider)
    assert error.transient is False
    assert (
        str(error)
        == "The mail server's TLS certificate could not be verified (SSL: CERTIFICATE_VERIFY_FAILED)."
    )
    assert (
        server.handler.received == [] and server.credentials is not None and server.credentials.attempts == 0
    )
    assert any("certificate could not be verified" in record.getMessage() for record in caplog.records)


def test_implicit_tls_against_a_starttls_port_is_a_tls_failure(
    server: SmtpTestServer, certificate: Certificate
) -> None:
    error = _failure(_provider(server.port, certificate, security="ssl"))
    assert error.transient is True and "TLS handshake" in str(error) and "SMTP_SECURITY" in str(error)


# ---- the deadline ---------------------------------------------------------------------------------


def test_an_attempt_never_outlasts_the_time_the_dispatcher_has_left() -> None:
    """SMTP_TIMEOUT_SECONDS is 10 s, but only 1.5 s of the message's deadline are left."""
    email = _invitation()  # rendered before the clock starts: only the attempt is timed
    with RawServer(greeting=None) as silent:
        started = time.monotonic()
        error = _failure(
            _provider(silent.port, None, security="none", username=None, password=None, timeout=10.0),
            email,
            timeout_seconds=1.5,
        )
        elapsed = time.monotonic() - started
    assert error.transient is True and str(error) == "The mail server did not respond in time."
    assert 1.4 <= elapsed < 3.0


def test_a_slow_server_cannot_stretch_an_attempt_past_the_deadline() -> None:
    """Every reply comes within the per-operation timeout (0.4 s of 5 s), but together they would take
    longer than the 1 s left: the attempt ends at the deadline."""
    with smtp_server(security="none") as slow:
        slow.handler.delay = 0.4
        provider = _provider(slow.port, None, security="none", username=None, password=None, timeout=5.0)
        email = _invitation()  # rendered before the clock starts: only the attempt is timed
        started = time.monotonic()
        error = _failure(provider, email, timeout_seconds=1.0)
        elapsed = time.monotonic() - started
        assert error.transient is True and str(error) == "The mail server did not respond in time."
        assert 0.9 <= elapsed < 1.9
        assert slow.handler.received == []
        # With the whole deadline left the same server accepts the message.
        provider.send(_invitation(), timeout_seconds=20.0)
        assert len(slow.handler.received) == 1


def test_no_time_left_means_no_attempt() -> None:
    provider = _provider(closed_port(), None, security="none", username=None, password=None)
    for left in (0.0, -1.0):
        error = _failure(provider, timeout_seconds=left)
        assert error.transient is True and "in time" in str(error)


def _trickle(unit: bytes) -> Callable[[socket.socket, threading.Event], None]:
    """A server that spreads its greeting out: `unit` every 0.2 s (well within any per-operation timeout)
    for 6 s, then ends it and hangs up."""

    def serve(connection: socket.socket, stopping: threading.Event) -> None:
        until = time.monotonic() + 6.0
        while time.monotonic() < until and not stopping.wait(0.2):
            connection.sendall(unit)
        connection.sendall(b"\r\n220 ready\r\n")

    return serve


@pytest.mark.parametrize(
    "unit", [b"220-still greeting you\r\n", b"2"], ids=["a line at a time", "a byte at a time"]
)
def test_a_reply_spread_out_over_time_cannot_stretch_an_attempt_past_the_deadline(unit: bytes) -> None:
    """Each piece arrives within the per-operation timeout (0.2 s of 10 s), and smtplib reads a reply line
    after line (and a line chunk after chunk) without limit: the attempt still ends when the 1.5 s left
    are over, not when the server stops."""
    with ScriptedServer(_trickle(unit)) as trickling:
        provider = _provider(
            trickling.port, None, security="none", username=None, password=None, timeout=10.0
        )
        email = _invitation()  # rendered before the clock starts: only the attempt is timed
        started = time.monotonic()
        error = _failure(provider, email, timeout_seconds=1.5)
        elapsed = time.monotonic() - started
    assert error.transient is True and str(error) == "The mail server did not respond in time."
    assert 1.4 <= elapsed < 2.5


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_the_addresses_of_a_host_name_share_the_time_left(monkeypatch: pytest.MonkeyPatch) -> None:
    """SMTP_HOST resolves to three addresses that drop every connection attempt (black-holed): each gets at
    most the time still left, and none is tried once it is over (`socket.create_connection` gives each
    the whole per-operation timeout: three times SMTP_TIMEOUT_SECONDS)."""
    clock = _Clock()
    attempts: list[tuple[str, float]] = []

    class BlackHole:
        def __init__(self, *args: object) -> None:
            self.timeout = 0.0

        def settimeout(self, value: float) -> None:
            self.timeout = value

        def connect(self, address: tuple[str, int]) -> None:
            attempts.append((address[0], self.timeout))
            clock.now += self.timeout  # the attempt waits out its timeout
            raise TimeoutError("timed out")

        def close(self) -> None:
            pass

    addresses = ["192.0.2.1", "198.51.100.1", "203.0.113.1"]
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *args, **kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port)) for address in addresses
        ],
    )
    monkeypatch.setattr(socket, "socket", BlackHole)
    provider = SmtpProvider(
        SmtpServer(host="smtp.example.test", port=587, security="none", timeout_seconds=1.0),
        ehlo_name="vms.test",
        clock=lambda: NOW,
        monotonic=clock,
    )
    started = clock.now
    error = _failure(provider, timeout_seconds=1.2)
    assert error.transient is True and str(error) == "The mail server did not respond in time."
    assert [address for address, _timeout in attempts] == addresses[:2]
    assert [timeout for _address, timeout in attempts] == [1.0, pytest.approx(0.2)]
    assert clock.now - started == pytest.approx(1.2)


def test_the_tls_handshake_after_starttls_gets_only_the_time_left(certificate: Certificate) -> None:
    """The server takes 1.2 s of the 2 s left to answer STARTTLS, then never completes the handshake: the
    handshake gets the 0.8 s still left, not a fresh timeout."""

    def serve(connection: socket.socket, stopping: threading.Event) -> None:
        with connection.makefile("rb") as lines:
            connection.sendall(b"220 test ESMTP\r\n")
            lines.readline()  # EHLO
            connection.sendall(b"250-test\r\n250 STARTTLS\r\n")
            lines.readline()  # STARTTLS
            time.sleep(1.2)
            connection.sendall(b"220 2.0.0 Ready to start TLS\r\n")
            stopping.wait()  # and never a ServerHello

    with ScriptedServer(serve) as slow:
        provider = _provider(slow.port, certificate, username=None, password=None, timeout=10.0)
        email = _invitation()  # rendered before the clock starts: only the attempt is timed
        started = time.monotonic()
        error = _failure(provider, email, timeout_seconds=2.0)
        elapsed = time.monotonic() - started
    assert error.transient is True and str(error) == "The mail server did not respond in time."
    assert 1.9 <= elapsed < 2.6


def test_a_reply_that_never_ends_is_cut_off() -> None:
    """A greeting of 1 MiB of continuation lines: smtplib keeps every line in memory, so the provider stops
    reading a reply after 64 KiB."""

    def serve(connection: socket.socket, stopping: threading.Event) -> None:
        connection.sendall(b"220-" + b"x" * 60 + b"\r\n")
        connection.sendall((b"220-" + b"x" * 60 + b"\r\n") * 16384 + b"220 ready\r\n")

    with ScriptedServer(serve) as flooding:
        provider = _provider(flooding.port, None, security="none", username=None, password=None)
        error = _failure(provider, timeout_seconds=5.0)
    assert error.transient is True and str(error) == "The mail server's reply was too long."


def test_a_refusal_that_arrives_just_before_the_deadline_stays_a_refusal() -> None:
    """The 550 to RCPT arrives as the deadline passes: smtplib's clean-up (RSET) then has no time left, and
    the error is still the recipient's refusal (permanent), not a timeout."""
    clock = _Clock()

    def serve(connection: socket.socket, stopping: threading.Event) -> None:
        with connection.makefile("rb") as lines:
            connection.sendall(b"220 test ESMTP\r\n")
            for line in lines:
                command = line[:4].upper()
                if command == b"EHLO":
                    connection.sendall(b"250 test\r\n")
                elif command == b"RCPT":
                    time.sleep(0.5)  # the provider is waiting for this reply by now
                    clock.now += 60.0  # the deadline passes while the server answers
                    connection.sendall(b"550 5.1.1 <dana@example.com>: Recipient address rejected\r\n")
                else:
                    connection.sendall(b"250 2.0.0 Ok\r\n")

    with ScriptedServer(serve) as refusing:
        provider = SmtpProvider(
            SmtpServer(host=HOST, port=refusing.port, security="none", timeout_seconds=5.0),
            ehlo_name="vms.test",
            clock=lambda: NOW,
            monotonic=clock,
        )
        error = _failure(provider, timeout_seconds=10.0)
    assert error.transient is False
    assert str(error) == "The mail server rejected the recipient address (SMTP 550 5.1.1)."


def test_a_reply_that_arrived_in_time_is_read_after_the_deadline() -> None:
    """The deadline passes between the provider's command and its read of the reply: what the server
    sent in time is still read, without waiting, and nothing more is waited for."""
    clock = _Clock()
    reply = b"550 5.1.1 <dana@example.com>: Recipient address rejected\r\n"
    client, server = socket.socketpair()
    with client, server:
        reader = _ReplyReader(client, _Budget(5.0, clock.now + 1.0, clock))
        server.sendall(reply)
        assert select.select([client], [], [], 5.0)[0]  # the reply has arrived
        clock.now += 60.0
        buffer = bytearray(256)
        assert buffer[: reader.readinto(buffer)] == reply
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            reader.readinto(buffer)
        assert time.monotonic() - started < 0.5


# ---- secrets ---------------------------------------------------------------------------------------


def _secret_forms(username: str, password: str) -> list[str]:
    """The password, and how AUTH PLAIN and AUTH LOGIN put it on the wire."""
    return [
        password,
        base64.b64encode(password.encode()).decode(),
        base64.b64encode(f"\0{username}\0{password}".encode()).decode(),
    ]


def test_no_credential_reaches_a_log_record_or_an_error(
    server: SmtpTestServer, certificate: Certificate, caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    secret = "Sup3r-Secret-App-Pass"
    caplog.set_level(logging.DEBUG)
    assert server.credentials is not None
    errors: list[EmailDeliveryError] = []
    providers = [
        _provider(server.port, certificate, password=secret),  # refused sign-in
        SmtpProvider(SmtpServer(host=HOST, port=server.port, username=USERNAME, password=SecretStr(secret))),
        _provider(closed_port(), certificate, password=secret),  # nothing listening
    ]
    for provider in providers:
        errors.append(_failure(provider))
        assert all(form not in repr(provider) for form in _secret_forms(USERNAME, secret))
    server.handler.script("RCPT", "550 5.1.1 <dana@example.com>: Recipient address rejected")
    server.credentials.password = secret
    errors.append(_failure(_provider(server.port, certificate, password=secret)))  # signed in, then refused
    server.handler.script("DATA", "451 4.3.0 Try again")
    errors.append(_failure(_provider(server.port, certificate, password=secret)))

    texts = [record.getMessage() for record in caplog.records]
    texts += [str(vars(record)) for record in caplog.records]
    texts += [record.exc_text or "" for record in caplog.records]
    for error in errors:
        texts += [str(error), repr(error)]
        # No reference to smtplib's exception, whose frames hold the connection and the password.
        assert error.__context__ is None and error.__cause__ is None and error.__traceback__ is not None
    for form in _secret_forms(USERNAME, secret):
        assert all(form not in text for text in texts), form
    assert all(RECIPIENT not in str(error) for error in errors)  # nor the recipient's address
    assert "Sup3r" not in repr(SmtpServer(host=HOST, port=587, username=USERNAME, password=SecretStr(secret)))
