"""ResendProvider against `httpx.MockTransport`: the request (endpoint, headers, payload, inline image)
and how responses and transport failures are classified (contract §9)."""

import base64
import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.email.logos import light_rendition
from app.email.providers.base import EmailDeliveryError, InlineImage, OutgoingEmail
from app.email.providers.resend import RESEND_EMAILS_URL, ResendProvider
from app.email.rendering import EmailRenderer
from app.email.service import (
    LOGO_CONTENT_ID,
    NO_TEMPLATE_TEXTS,
    QR_CONTENT_ID,
    EmailService,
)
from app.models import Company, EmailKind, Visit
from tests.png_support import SAMPLE_LOGO as COMPANY_LOGO
from tests.png_support import CompanyLogos

API_KEY = "re_live_SuperSecretKey_0123456789"
MESSAGE_ID = uuid.UUID("12345678-1234-5678-1234-567812345678")
PNG = b"\x89PNG\r\n\x1a\nfake-image-bytes"


def _email(**changes) -> OutgoingEmail:
    values = {
        "message_id": MESSAGE_ID,
        "kind": EmailKind.VISITOR_INVITATION,
        "to": "guest@example.com",
        "subject": "Your visit to Mawdoo3 on Monday, 5 October 2026",
        "html": '<p>Hello</p><img src="cid:visitor-pass-qr" alt="QR">',
        "text": "Hello",
        "sender": "Mawdoo3 <visitors@demo.example>",
        "reply_to": "reception@demo.example",
        "inline_images": (
            InlineImage(content_id="visitor-pass-qr", filename="visitor-pass-qr.png", content=PNG),
        ),
        "pass_url": "https://vms.example/pass#token",
    }
    values.update(changes)
    return OutgoingEmail(**values)


def _provider(handler) -> tuple[ResendProvider, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return ResendProvider(SecretStr(API_KEY), transport=httpx.MockTransport(record)), seen


def test_request_shape() -> None:
    provider, seen = _provider(
        lambda request: httpx.Response(200, json={"id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"})
    )
    result = provider.send(_email())
    assert result.provider_message_id == "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
    [request] = seen
    assert request.method == "POST" and str(request.url) == RESEND_EMAILS_URL
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.headers["Idempotency-Key"] == f"vms-email-{MESSAGE_ID}"
    assert request.headers["Content-Type"] == "application/json"
    body = json.loads(request.content)
    assert body == {
        "from": "Mawdoo3 <visitors@demo.example>",
        "to": ["guest@example.com"],
        "subject": "Your visit to Mawdoo3 on Monday, 5 October 2026",
        "html": '<p>Hello</p><img src="cid:visitor-pass-qr" alt="QR">',
        "text": "Hello",
        "reply_to": "reception@demo.example",
        "attachments": [
            {
                "filename": "visitor-pass-qr.png",
                "content": base64.b64encode(PNG).decode("ascii"),
                "content_type": "image/png",
                "content_id": "visitor-pass-qr",
            }
        ],
    }
    # Development-only fields never reach the provider.
    assert "pass_url" not in body and "https://vms.example/pass#token" not in request.content.decode()


def test_optional_fields_are_left_out() -> None:
    provider, seen = _provider(lambda request: httpx.Response(200, json={"id": "x"}))
    provider.send(_email(reply_to=None, inline_images=()))
    body = json.loads(seen[0].content)
    assert "reply_to" not in body and "attachments" not in body


def test_success_without_an_id() -> None:
    provider, _ = _provider(lambda request: httpx.Response(200, text="not json"))
    assert provider.send(_email()).provider_message_id is None


@pytest.mark.parametrize(
    ("status", "name", "transient"),
    [
        (429, "rate_limit_exceeded", True),
        (429, "daily_quota_exceeded", True),
        (500, "application_error", True),
        (502, None, True),
        (503, "service_unavailable", True),
        (409, "concurrent_idempotent_requests", True),
        (409, "invalid_idempotent_request", False),
        (400, "validation_error", False),
        (401, "missing_api_key", False),
        (403, "validation_error", False),
        (422, "invalid_attachment", False),
    ],
)
def test_response_classification(status: int, name: str | None, transient: bool) -> None:
    payload = {"statusCode": status, "message": "The `to` field has guest@example.com", "name": name}
    provider, seen = _provider(lambda request: httpx.Response(status, json=payload))
    with pytest.raises(EmailDeliveryError) as caught:
        provider.send(_email())
    assert caught.value.transient is transient
    message = str(caught.value)
    assert f"HTTP {status}" in message
    if name:
        assert name in message
    # Never the key, never the provider's own message (it can repeat the recipient).
    assert API_KEY not in message and "guest@example.com" not in message
    assert len(seen) == 1


def test_unrecognisable_error_names_are_not_echoed() -> None:
    provider, _ = _provider(lambda request: httpx.Response(400, json={"name": "<script>x</script>"}))
    with pytest.raises(EmailDeliveryError) as caught:
        provider.send(_email())
    assert str(caught.value) == "The email service rejected the message (HTTP 400)."


@pytest.mark.parametrize(
    ("failure", "transient"),
    [
        (httpx.ConnectTimeout("connect timed out"), True),
        (httpx.ReadTimeout("read timed out"), True),
        (httpx.ConnectError("connection refused"), True),
        (httpx.RemoteProtocolError("server disconnected"), True),
        (httpx.WriteError("broken pipe"), True),
    ],
)
def test_transport_failures_are_transient(failure: Exception, transient: bool) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise failure

    provider, _ = _provider(fail)
    with pytest.raises(EmailDeliveryError) as caught:
        provider.send(_email())
    assert caught.value.transient is transient
    assert API_KEY not in str(caught.value)
    assert caught.value.__cause__ is None and caught.value.__suppress_context__


def test_an_attempt_never_outlasts_the_time_the_dispatcher_has_left() -> None:
    provider, seen = _provider(lambda request: httpx.Response(200, json={"id": "x"}))
    provider.send(_email())
    provider.send(_email(), timeout_seconds=30.0)
    provider.send(_email(), timeout_seconds=3.5)
    default, roomy, short = (request.extensions["timeout"] for request in seen)
    assert default == {"connect": 5.0, "read": 10.0, "write": 10.0, "pool": 10.0}
    assert roomy == default  # the defaults are already shorter
    assert short == {"connect": 3.5, "read": 3.5, "write": 3.5, "pool": 3.5}


def test_the_key_is_never_shown() -> None:
    provider = ResendProvider(SecretStr(API_KEY))
    assert API_KEY not in repr(provider) and API_KEY not in str(vars(provider))
    with pytest.raises(ValueError, match="empty"):
        ResendProvider(SecretStr("  "))


def test_a_real_invitation_carries_its_qr_code_and_the_company_s_logo_inline() -> None:
    """Phase 10 (B10-6), Phase 12 (B12-12, B12-13): Resend receives both inline images, each with the
    Content-ID the HTML names, the bilingual subject and bodies as rendered, and the company's name as the
    sender's name beside the configured address."""

    class _Messages:
        def add(self, message):
            return message

    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.test",
        email_from="Mawdoo3 <visitors@demo.example>",
    )
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=settings,
        renderer=EmailRenderer(),
        provider_name="resend",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=CompanyLogos(COMPANY_LOGO, 240, 80),
    )
    service.messages = _Messages()  # type: ignore[assignment]
    company = Company(
        id=uuid.uuid4(),
        name="Mawdoo3",
        name_ar="موضوع",
        slug="demo",
        timezone="Asia/Amman",
        default_language="ar",
    )
    start = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
    visit = Visit(
        id=uuid.uuid4(),
        visitor_name="Dana Guest",
        host_name="Omar Khalil",
        purpose="Review",
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=1),
        window_start=start - timedelta(hours=1),
        window_end=start + timedelta(hours=2),
    )
    email = service.queue_visitor_invitation(
        visit, "T" * 43, company=company, recipient="guest@example.com", host_email=None
    ).email
    provider, seen = _provider(lambda request: httpx.Response(200, json={"id": "abc"}))
    provider.send(email)
    payload = json.loads(seen[0].content)
    # The company's name in the e-mail's leading language, the configured address.
    assert payload["from"] == email.sender == '"موضوع" <visitors@demo.example>'
    assert payload["subject"] == email.subject and payload["subject"].startswith("زيارتك إلى موضوع")
    assert payload["html"] == email.html and payload["text"] == email.text
    attachments = {attachment["content_id"]: attachment for attachment in payload["attachments"]}
    assert set(attachments) == {QR_CONTENT_ID, LOGO_CONTENT_ID}
    logo = attachments[LOGO_CONTENT_ID]
    assert logo["filename"] == "brand-logo.png" and logo["content_type"] == "image/png"
    assert base64.b64decode(logo["content"]) == light_rendition(COMPANY_LOGO).content
    for content_id in attachments:
        assert f'src="cid:{content_id}"' in payload["html"]
