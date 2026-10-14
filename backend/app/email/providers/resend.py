"""Resend provider: `POST https://api.resend.com/emails` over httpx (contract §9; no SDK).

Request (Resend REST API, verified against https://resend.com/docs/api-reference/emails/send-email and
https://resend.com/docs/dashboard/emails/embed-inline-images on 2026-10-05):

* `Authorization: Bearer <RESEND_API_KEY>`, JSON body `{from, to: [..], subject, html, text, reply_to?,
  attachments?}`; the response of a 2xx is `{"id": "<uuid>"}`.
* An inline image is an attachment `{filename, content: <base64>, content_type, content_id}` referenced
  from the HTML as `<img src="cid:<content_id>">` (content IDs under 128 characters).
* `Idempotency-Key` (≤ 256 characters, kept for 24 hours) is the e-mail row's ID, so a retry after a
  timeout whose request did reach Resend cannot send the message twice.

Errors: 429 (rate limit or quota), 5xx, timeouts and connection failures are transient; so is 409
`concurrent_idempotent_requests` (the same key is still in flight). Other 4xx are permanent. Error
messages name the HTTP status and Resend's error type only: never the API key, never the response's
own message (it can repeat the recipient's address).
"""

import base64
import re
from typing import Any

import httpx
from pydantic import SecretStr

from app.email.providers.base import EmailDeliveryError, OutgoingEmail, ProviderResult

RESEND_EMAILS_URL = "https://api.resend.com/emails"
# Per attempt: at most 5 s to connect and 10 s for each read or write, and never beyond the time the
# dispatcher has left for the message (`timeout_seconds`): a provider that stops answering ends a
# message after about 20 s (two attempts) instead of 49 s.
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_ERROR_NAME = re.compile(r"[a-z_]{1,64}")
_TRANSIENT_CONFLICT = "concurrent_idempotent_requests"


class ResendProvider:
    name = "resend"

    def __init__(
        self,
        api_key: SecretStr,
        *,
        endpoint: str = RESEND_EMAILS_URL,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not api_key.get_secret_value().strip():
            raise ValueError("the Resend API key is empty")
        self._api_key = api_key
        self._endpoint = endpoint
        self._timeout = timeout
        self._transport = transport

    def __repr__(self) -> str:
        return f"ResendProvider(endpoint={self._endpoint!r})"

    @staticmethod
    def payload(email: OutgoingEmail) -> dict[str, Any]:
        body: dict[str, Any] = {
            "from": email.sender,
            "to": [email.to],
            "subject": email.subject,
            "html": email.html,
            "text": email.text,
        }
        if email.reply_to:
            body["reply_to"] = email.reply_to
        if email.inline_images:
            body["attachments"] = [
                {
                    "filename": image.filename,
                    "content": base64.b64encode(image.content).decode("ascii"),
                    "content_type": image.mime_type,
                    "content_id": image.content_id,
                }
                for image in email.inline_images
            ]
        return body

    def _headers(self, email: OutgoingEmail) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key.get_secret_value()}",
            "Idempotency-Key": f"vms-email-{email.message_id}",
            "Accept": "application/json",
        }

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        timeout = self._timeout if timeout_seconds is None else _within(self._timeout, timeout_seconds)
        try:
            # A client per message: background deliveries run concurrently in worker threads.
            with httpx.Client(timeout=timeout, transport=self._transport) as client:
                response = client.post(self._endpoint, json=self.payload(email), headers=self._headers(email))
        except httpx.TimeoutException:
            raise EmailDeliveryError("The email service did not respond in time.", transient=True) from None
        except httpx.TransportError:
            raise EmailDeliveryError("Could not connect to the email service.", transient=True) from None
        except httpx.HTTPError:
            raise EmailDeliveryError("The request to the email service failed.", transient=False) from None

        if response.is_success:
            return ProviderResult(provider_message_id=_message_id(response))
        raise _classify(response)


def _within(timeout: httpx.Timeout, seconds: float) -> httpx.Timeout:
    """`timeout` with no phase (connect, read, write, pool) longer than `seconds`."""
    limit = max(seconds, 0.1)

    def bounded(value: float | None) -> float:
        return limit if value is None else min(value, limit)

    return httpx.Timeout(
        connect=bounded(timeout.connect),
        read=bounded(timeout.read),
        write=bounded(timeout.write),
        pool=bounded(timeout.pool),
    )


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _message_id(response: httpx.Response) -> str | None:
    value = _json(response).get("id")
    return value[:255] if isinstance(value, str) and value else None


def _classify(response: httpx.Response) -> EmailDeliveryError:
    status = response.status_code
    name = _json(response).get("name")
    kind = name if isinstance(name, str) and _ERROR_NAME.fullmatch(name) else None
    label = f"HTTP {status}" if kind is None else f"{kind}, HTTP {status}"
    if status == 429:
        return EmailDeliveryError(f"The email service is limiting requests ({label}).", transient=True)
    if status >= 500:
        return EmailDeliveryError(f"The email service is unavailable ({label}).", transient=True)
    if status == 409 and kind == _TRANSIENT_CONFLICT:
        return EmailDeliveryError(
            f"The email service is still processing this message ({label}).", transient=True
        )
    if status in (401, 403):
        return EmailDeliveryError(f"The email service refused the credentials ({label}).", transient=False)
    return EmailDeliveryError(f"The email service rejected the message ({label}).", transient=False)
