import json
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.core.config import ConfigurationError, Settings
from app.email.dispatcher import sanitize_error
from app.email.headers import sanitize_header
from app.email.identity import DEFAULT_COLORS, Identity
from app.email.providers.base import CalendarPart, EmailDeliveryError, InlineImage, OutgoingEmail
from app.email.providers.factory import create_email_provider, ehlo_name, email_configuration_warnings
from app.email.providers.memory import MemoryProvider
from app.email.providers.outbox import OutboxProvider
from app.email.providers.resend import ResendProvider
from app.email.providers.smtp import SmtpProvider
from app.email.rendering import EmailRenderer
from app.email.service import (
    LOGO_CONTENT_ID,
    QR_CONTENT_ID,
    brand_logo,
    build_test_email,
    company_footers,
    masthead,
)
from app.models import EmailKind, Language

RESET_URL = "https://vms.example.com/reset-password?c=acme#token=" + "T" * 43


def _context(full_name: str, company: str) -> dict[str, object]:
    """What the e-mail service gives the reset e-mail of a company without a logo or a colour (B12-12)."""
    names = {Language.AR: company, Language.EN: company}
    identity = Identity(product=False, names=names, masthead=masthead(names), colors=DEFAULT_COLORS)
    return {
        "company_name": names,
        "identity": identity,
        "colors": identity.colors,
        "footer": company_footers(names, has_reply_to=False),
        "full_name": full_name,
        "reset_url": RESET_URL,
        "duration": {Language.AR: "30 دقيقة", Language.EN: "30 minutes"},
        "asked": "",  # the user asked for the link ("platform_": the platform owner sent it, B11-49)
    }


def _render(full_name: str = "Dana Example", company: str = "Mawdoo3"):
    return EmailRenderer().render(
        "password_reset",
        subject=f"Reset your {company} account password",
        language=Language.EN,
        context=_context(full_name, company),
    )


def test_password_reset_email_renders_html_and_text() -> None:
    rendered = _render()
    assert rendered.subject == "Reset your Mawdoo3 account password"
    assert "<table" in rendered.html and 'role="presentation"' in rendered.html
    assert f'href="{RESET_URL}"' in rendered.html
    assert "Reset password" in rendered.html
    assert "30 minutes" in rendered.html and "30 minutes" in rendered.text
    assert RESET_URL in rendered.text
    assert "<" not in rendered.text
    assert "Hello Dana Example," in rendered.text
    # Without a Reply-To nobody reads replies, so the footer says so.
    assert "Please do not reply to this email." in rendered.text


def test_user_supplied_values_are_escaped_in_html() -> None:
    rendered = _render(full_name='<script>alert("x")</script>', company="A & B <Corp>")
    assert "<script>" not in rendered.html
    assert "&lt;script&gt;" in rendered.html
    assert "A &amp; B &lt;Corp&gt;" in rendered.html


def test_headers_are_stripped_of_control_characters() -> None:
    assert sanitize_header("Hello\r\nBcc: victim@example.com") == "Hello Bcc: victim@example.com"
    rendered = EmailRenderer().render(
        "password_reset", subject="Line one\nLine two", language=Language.AR, context=_context("N", "C")
    )
    assert "\n" not in rendered.subject


def _email(to: str = "person@example.com", images=()) -> OutgoingEmail:
    rendered = _render()
    return OutgoingEmail(
        message_id=uuid.UUID("12345678-1234-5678-1234-567812345678"),
        kind=EmailKind.PASSWORD_RESET,
        to=to,
        subject=rendered.subject,
        html=rendered.html,
        text=rendered.text,
        inline_images=tuple(images),
        reset_url=RESET_URL,
    )


def test_outgoing_email_repr_hides_bodies_and_links() -> None:
    assert RESET_URL not in repr(_email())


def test_outbox_writes_the_contract_files(tmp_path: Path) -> None:
    provider = OutboxProvider(tmp_path, clock=lambda: datetime(2026, 10, 5, 8, 30, tzinfo=UTC))
    image = InlineImage(content_id="qr", filename="qr.png", content=b"\x89PNG fake")
    result = provider.send(_email(images=[image]))

    stem = "12345678-1234-5678-1234-567812345678"
    assert result.provider_message_id == f"outbox-{stem}"
    assert {path.name for path in tmp_path.iterdir()} == {
        f"{stem}.json",
        f"{stem}.html",
        f"{stem}.txt",
        f"{stem}-qr.png",
    }
    metadata = json.loads((tmp_path / f"{stem}.json").read_text(encoding="utf-8"))
    assert metadata == {
        "message_id": stem,
        "kind": "PASSWORD_RESET",
        "to": "person@example.com",
        "subject": "Reset your Mawdoo3 account password",
        "created_at": "2026-10-05T08:30:00Z",
        "pass_url": None,
        "reset_url": RESET_URL,
        "calendar": None,  # no calendar event (Phase 14, B14-7)
    }
    assert (tmp_path / f"{stem}-qr.png").read_bytes() == b"\x89PNG fake"


def test_outbox_records_the_pass_url_of_an_invitation(tmp_path: Path) -> None:
    pass_url = "https://vms.example.com/pass#" + "P" * 43
    email = OutgoingEmail(
        message_id=uuid.UUID("87654321-4321-8765-4321-876543218765"),
        kind=EmailKind.VISITOR_INVITATION,
        to="guest@example.com",
        subject="Your visit",
        html='<img src="cid:visitor-pass-qr">',
        text="Your visit",
        inline_images=(InlineImage(content_id="visitor-pass-qr", filename="qr.png", content=b"\x89PNG qr"),),
        pass_url=pass_url,
    )
    OutboxProvider(tmp_path, clock=lambda: datetime(2026, 10, 5, 8, 30, tzinfo=UTC)).send(email)
    stem = "87654321-4321-8765-4321-876543218765"
    metadata = json.loads((tmp_path / f"{stem}.json").read_text(encoding="utf-8"))
    assert metadata["kind"] == "VISITOR_INVITATION"
    assert metadata["pass_url"] == pass_url and metadata["reset_url"] is None
    assert (tmp_path / f"{stem}-visitor-pass-qr.png").read_bytes() == b"\x89PNG qr"


def test_outbox_fail_domain_is_permanent(tmp_path: Path) -> None:
    provider = OutboxProvider(tmp_path, fail_domain="fail.test")
    with pytest.raises(EmailDeliveryError) as caught:
        provider.send(_email(to="someone@mx.fail.test"))
    assert caught.value.transient is False
    assert list(tmp_path.iterdir()) == []


def test_outbox_rejects_unsafe_content_ids(tmp_path: Path) -> None:
    image = InlineImage(content_id="../escape", filename="x.png", content=b"x")
    with pytest.raises(EmailDeliveryError):
        OutboxProvider(tmp_path).send(_email(images=[image]))


def test_memory_provider_failures_and_clear() -> None:
    provider = MemoryProvider()
    provider.fail_next(1, transient=False)
    with pytest.raises(EmailDeliveryError) as caught:
        provider.send(_email())
    assert caught.value.transient is False
    provider.send(_email())
    assert len(provider.sent) == 1 and provider.attempts == 2
    provider.clear()
    assert provider.sent == [] and provider.attempts == 0


def test_provider_factory() -> None:
    base = {"_env_file": None, "app_env": "development", "database_url": "postgresql://u:p@h/d"}
    assert isinstance(create_email_provider(Settings(**base, email_provider="outbox")), OutboxProvider)
    assert isinstance(create_email_provider(Settings(**base, email_provider="memory")), MemoryProvider)
    resend = create_email_provider(Settings(**base, email_provider="resend", resend_api_key="re_test_123"))
    assert isinstance(resend, ResendProvider)
    assert "re_test_123" not in repr(resend)
    settings_without_key = Settings(**base, email_provider="outbox").model_copy(
        update={"email_provider": "resend"}
    )
    with pytest.raises(ConfigurationError, match="RESEND_API_KEY"):
        create_email_provider(settings_without_key)


def test_error_sanitisation() -> None:
    assert sanitize_error("bad\r\nthing\x00") == "bad thing"
    assert len(sanitize_error("x" * 1000)) == 500
    assert sanitize_error("") == "Delivery failed."


# ---- SMTP provider selection and startup warnings (S10-1, S10-2) ----------------------------------

GMAIL = {
    "email_provider": "smtp",
    "smtp_host": "smtp.gmail.com",
    "smtp_username": "visitors.desk@gmail.com",
    "smtp_password": "abcd efgh ijkl mnop",
    "email_from": "Mawdoo3 <Visitors.Desk@gmail.com>",
    "app_base_url": "https://vms.example.com",
}


def _smtp_settings(**values) -> Settings:
    base = {"_env_file": None, "app_env": "development", "database_url": "postgresql://u:p@h/d"}
    return Settings(**{**base, **GMAIL, **values})


def test_the_factory_builds_the_smtp_provider() -> None:
    provider = create_email_provider(_smtp_settings())
    assert isinstance(provider, SmtpProvider) and provider.name == "smtp"
    assert repr(provider) == "SmtpProvider(host='smtp.gmail.com', port=587, security='starttls')"
    assert "abcd" not in repr(provider) and "abcdefghijklmnop" not in str(vars(provider))
    implicit = create_email_provider(_smtp_settings(smtp_security="ssl", smtp_timeout_seconds=5))
    assert repr(implicit) == "SmtpProvider(host='smtp.gmail.com', port=465, security='ssl')"
    settings_without_host = _smtp_settings().model_copy(update={"smtp_host": None})
    with pytest.raises(ConfigurationError, match="SMTP_HOST"):
        create_email_provider(settings_without_host)


@pytest.mark.parametrize(
    ("origin", "name"),
    [
        ("https://vms.example.com", "vms.example.com"),
        ("http://localhost:5173", "localhost"),
        ("http://192.168.1.20:5173", "[192.168.1.20]"),
        ("http://[::1]:5173", "[IPv6:::1]"),
    ],
)
def test_ehlo_names_the_applications_host(origin: str, name: str) -> None:
    assert ehlo_name(origin) == name


def test_no_warning_for_a_consistent_gmail_configuration() -> None:
    assert email_configuration_warnings(_smtp_settings()) == []  # EMAIL_FROM matches in any letter case


def test_a_gmail_sender_that_is_not_the_account_is_warned_about() -> None:
    other_sender = "Mawdoo3 <no-reply@company.example>"
    [warning] = email_configuration_warnings(_smtp_settings(email_from=other_sender))
    assert warning.startswith("EMAIL_FROM's address is not SMTP_USERNAME: Gmail sends")
    assert "company.example" not in warning and "visitors.desk" not in warning  # names, never values
    # Only Gmail rewrites the sender this way.
    other_server = _smtp_settings(smtp_host="smtp.example.com", email_from=other_sender)
    assert email_configuration_warnings(other_server) == []


@pytest.mark.parametrize(
    ("security", "port", "expected"),
    [
        ("starttls", "465", "SMTP_PORT=465 expects TLS from the first byte"),
        ("ssl", "587", "SMTP_PORT=587 expects STARTTLS"),
        ("ssl", "25", "SMTP_PORT=25 expects STARTTLS"),
    ],
)
def test_a_port_that_does_not_fit_the_security_mode_is_warned_about(
    security: str, port: str, expected: str
) -> None:
    [warning] = email_configuration_warnings(_smtp_settings(smtp_security=security, smtp_port=port))
    assert warning.startswith(expected)


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"])
def test_pass_links_that_only_open_on_this_computer_are_warned_about(origin: str) -> None:
    for values in ({}, {"email_provider": "resend", "resend_api_key": "re_test_123"}):
        [warning] = email_configuration_warnings(_smtp_settings(app_base_url=origin, **values))
        assert warning.startswith("QR_BASE_URL (APP_BASE_URL when it is not set) points to this computer")
    # The outbox sends nothing, so local links are what a developer wants.
    assert email_configuration_warnings(_smtp_settings(app_base_url=origin, email_provider="outbox")) == []
    # A reachable QR_BASE_URL beside a local APP_BASE_URL is fine.
    assert (
        email_configuration_warnings(
            _smtp_settings(app_base_url=origin, qr_base_url="http://192.168.1.20:5173")
        )
        == []
    )


def test_the_outbox_writes_every_inline_image_of_a_real_message(tmp_path: Path) -> None:
    """Phase 10 (B10-6): a message's logo is an inline image; the outbox writes it beside the HTML as
    `<id>-brand-logo.png`, and an invitation's QR code as `<id>-visitor-pass-qr.png`. Here the product's
    own logo, on a platform-level e-mail (B12-12)."""
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="development",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.example.com",
    )
    email = build_test_email(
        settings, EmailRenderer(), "desk@example.com", now=datetime(2026, 10, 5, tzinfo=UTC)
    )
    OutboxProvider(tmp_path).send(email)
    stem = str(email.message_id)
    assert (tmp_path / f"{stem}-{LOGO_CONTENT_ID}.png").read_bytes() == brand_logo().content
    assert (tmp_path / f"{stem}-{QR_CONTENT_ID}.png").read_bytes().startswith(b"\x89PNG")
    html = (tmp_path / f"{stem}.html").read_text(encoding="utf-8")
    for content_id in (LOGO_CONTENT_ID, QR_CONTENT_ID):
        assert f'src="cid:{content_id}"' in html


def test_the_outbox_writes_a_calendar_event_beside_the_message(tmp_path: Path) -> None:
    """Phase 14 (B14-7): `<id>.ics`, the event octet for octet, and `calendar` in the JSON file with its
    method, UID and version (what the E2E suite checks without parsing the file)."""
    content = b"BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n"
    calendar = CalendarPart(method="CANCEL", uid="visit-1-host", sequence=3, content=content)
    email = replace(_email(), kind=EmailKind.HOST_VISIT_CANCELLED, calendar=calendar)
    OutboxProvider(tmp_path, clock=lambda: datetime(2026, 10, 19, tzinfo=UTC)).send(email)
    stem = str(email.message_id)
    assert (tmp_path / f"{stem}.ics").read_bytes() == content
    metadata = json.loads((tmp_path / f"{stem}.json").read_text(encoding="utf-8"))
    assert metadata["kind"] == "HOST_VISIT_CANCELLED"
    assert metadata["calendar"] == {"method": "CANCEL", "uid": "visit-1-host", "sequence": 3}
    # A message without one has no file.
    other = tmp_path / "other"
    OutboxProvider(other).send(_email())
    assert not list(other.glob("*.ics"))


def test_the_memory_provider_keeps_the_event() -> None:
    calendar = CalendarPart(method="REQUEST", uid="u", sequence=0, content=b"BEGIN:VCALENDAR\r\n")
    provider = MemoryProvider()
    provider.send(replace(_email(), calendar=calendar))
    assert provider.sent[0].calendar == calendar
