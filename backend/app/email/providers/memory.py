"""In-memory provider for tests: records sent messages and can simulate failures."""

import threading
from collections import deque

from app.email.providers.base import EmailDeliveryError, OutgoingEmail, ProviderResult
from app.email.providers.common import recipient_domain_matches


class MemoryProvider:
    name = "memory"

    def __init__(self, *, fail_domain: str | None = None) -> None:
        self.fail_domain = fail_domain
        self.sent: list[OutgoingEmail] = []
        self.attempts = 0
        self._failures: deque[bool] = deque()  # queued failures; True = transient
        self._lock = threading.Lock()

    def fail_next(self, count: int = 1, *, transient: bool = True) -> None:
        with self._lock:
            self._failures.extend([transient] * count)

    def clear(self) -> None:
        with self._lock:
            self.sent.clear()
            self._failures.clear()
            self.attempts = 0

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        with self._lock:
            self.attempts += 1
            if self.fail_domain and recipient_domain_matches(email.to, self.fail_domain):
                raise EmailDeliveryError("Recipient domain is configured to fail.", transient=False)
            if self._failures:
                transient = self._failures.popleft()
                raise EmailDeliveryError("Simulated delivery failure.", transient=transient)
            self.sent.append(email)
            return ProviderResult(provider_message_id=f"memory-{email.message_id}")
