"""E-mail provider contract (contract §9)."""

from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID

from app.models.enums import EmailKind


@dataclass(frozen=True, slots=True)
class InlineImage:
    """An image embedded in the HTML body and referenced as `cid:<content_id>`."""

    content_id: str
    filename: str
    content: bytes = field(repr=False)
    mime_type: str = "image/png"


# The file name of the calendar event a message carries (as Google Calendar names its own), and the
# iTIP methods a message may carry (Phase 14, B14-7).
CALENDAR_FILE = "invite.ics"
CALENDAR_METHODS = frozenset({"REQUEST", "CANCEL"})


@dataclass(frozen=True, slots=True)
class CalendarPart:
    """A visit as a calendar event that travels with the message (Phase 14, B14-1): an iCalendar object
    (`app.email.calendar.write_calendar`) and its iTIP method, which the providers put where mail clients
    look for an invitation (B14-7). It never holds a pass link or a token (B14-4)."""

    method: str  # REQUEST or CANCEL
    uid: str
    sequence: int
    content: bytes = field(repr=False)  # UTF-8, CRLF line ends, folded


@dataclass(frozen=True, slots=True)
class OutgoingEmail:
    """A fully rendered message. Never persisted: bodies and links may contain raw tokens."""

    message_id: UUID
    kind: EmailKind
    to: str
    subject: str
    html: str = field(repr=False)
    text: str = field(repr=False)
    sender: str = ""
    reply_to: str | None = None
    inline_images: tuple[InlineImage, ...] = ()
    calendar: CalendarPart | None = None
    # Development/E2E convenience for the outbox provider (contract §9); contain raw tokens.
    pass_url: str | None = field(default=None, repr=False)
    reset_url: str | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class ProviderResult:
    provider_message_id: str | None


class EmailDeliveryError(Exception):
    """Delivery failed. `transient` errors (rate limits, 5xx, timeouts) may be retried."""

    def __init__(self, message: str, *, transient: bool) -> None:
        super().__init__(message)
        self.transient = transient


class EmailProvider(Protocol):
    name: str

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        """Send `email`. A provider that calls a remote service gives up after about `timeout_seconds`
        (the time left before the message's delivery deadline), or its own default when None."""
        ...
