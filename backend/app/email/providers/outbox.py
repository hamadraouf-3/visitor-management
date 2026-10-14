"""Outbox provider: writes each message to EMAIL_OUTBOX_DIR (development and E2E only; refused in
production by configuration validation).

Files per message (contract §9): `<message_id>.html`, `<message_id>.txt`, inline images
`<message_id>-<cid>.png`, and `<message_id>.json` with
`{message_id, kind, to, subject, created_at, pass_url, reset_url}`. The JSON file is written last, so a
reader that sees it can rely on the other files being complete.
"""

import json
import os
import tempfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from app.core import time as app_time
from app.email.providers.base import EmailDeliveryError, OutgoingEmail, ProviderResult
from app.email.providers.common import SAFE_CONTENT_ID, recipient_domain_matches


def _atomic_write(path: Path, data: bytes) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        Path(temporary).replace(path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


class OutboxProvider:
    name = "outbox"

    def __init__(
        self,
        directory: Path,
        *,
        fail_domain: str | None = None,
        clock: Callable[[], datetime] = app_time.now,
    ) -> None:
        self.directory = directory
        self.fail_domain = fail_domain
        self._clock = clock

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        # Local files: nothing to time out.
        if self.fail_domain and recipient_domain_matches(email.to, self.fail_domain):
            raise EmailDeliveryError(
                "Recipient domain is configured to fail (EMAIL_FAIL_DOMAIN).", transient=False
            )
        for image in email.inline_images:
            if not SAFE_CONTENT_ID.fullmatch(image.content_id):
                raise EmailDeliveryError("Inline image has an invalid content id.", transient=False)

        stem = str(email.message_id)
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            _atomic_write(self.directory / f"{stem}.html", email.html.encode("utf-8"))
            _atomic_write(self.directory / f"{stem}.txt", email.text.encode("utf-8"))
            for image in email.inline_images:
                _atomic_write(self.directory / f"{stem}-{image.content_id}.png", image.content)
            metadata = {
                "message_id": stem,
                "kind": email.kind.value,
                "to": email.to,
                "subject": email.subject,
                "created_at": self._clock().isoformat().replace("+00:00", "Z"),
                "pass_url": email.pass_url,
                "reset_url": email.reset_url,
            }
            _atomic_write(self.directory / f"{stem}.json", json.dumps(metadata, indent=2).encode("utf-8"))
        except OSError as exc:
            raise EmailDeliveryError(
                f"Could not write to the outbox ({type(exc).__name__}).", transient=True
            ) from exc
        return ProviderResult(provider_message_id=f"outbox-{stem}")
