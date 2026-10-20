"""What each calendar holds of a visit (Phase 14, B14-16 to B14-18, B14-26, B14-27).

A visit's e-mails record the iTIP method of the event each one carried (`EmailMessage.calendar_method`): a
REQUEST put the visit in the recipient's calendar or moved it there, a CANCEL took it out. Read per
mailbox (one person's addresses in any spelling, `mailbox_key`), oldest first:

* **A calendar holds the event** when the last event it was sent is a REQUEST, whatever became of that
  e-mail: a REQUEST that failed may still have arrived (a reply lost on the way), so the rule sends one
  CANCEL too many rather than one too few (B14-16). The visitor's calendar invitation, the notice of a
  new time and the cancellation carry the visitor's event; the host's three e-mails the host's.
* **The calendar invitation failed** when the calendar invitation that followed the visit's latest
  invitation failed, and nothing sent to that calendar since put the event there: no later REQUEST that
  went out or is on its way, no CANCEL (B14-18).
"""

from collections.abc import Sequence
from uuid import UUID

from app.email.service import mailbox_key
from app.models import EmailKind, EmailStatus, EventMethod
from app.repositories.email_messages import EventMessages, LatestEmail

_REQUEST = EventMethod.REQUEST.value
_FAILED = EmailStatus.FAILED.value


def messages_to(events: EventMessages, visit_id: UUID, address: str | None) -> list[LatestEmail]:
    """The events of `events` (`EmailMessageRepository.event_messages`) sent to `address`'s mailbox for
    the visit, oldest first: every spelling of that address that reaches the same mailbox (B14-21)."""
    if address is None:
        return []
    key = mailbox_key(address)
    found = [
        message
        for to_email, messages in events.get(visit_id, {}).items()
        if mailbox_key(to_email) == key
        for message in messages
    ]
    return sorted(found, key=lambda message: message.created_at)


def holds_event(messages: Sequence[LatestEmail]) -> bool:
    """Whether the calendar `messages` (one mailbox's events of a visit, oldest first) went to holds the
    event: the last one carried a REQUEST, whatever became of it."""
    return bool(messages) and messages[-1].calendar_method == _REQUEST


def failed_calendar_invitation(
    messages: Sequence[LatestEmail], invitation: LatestEmail | None
) -> LatestEmail | None:
    """The calendar invitation that followed the visit's latest invitation (`invitation`) to the mailbox
    of `messages` (its events, oldest first) when it FAILED and nothing sent there since put the event in
    that calendar (no later REQUEST that went out or is on its way, no CANCEL); None otherwise, and when
    the invitation itself failed: that is the invitation's failure (B14-18)."""
    if invitation is None or invitation.status == _FAILED:
        return None
    for position in range(len(messages) - 1, -1, -1):
        message = messages[position]
        if message.created_at <= invitation.created_at:
            return None
        if message.kind != EmailKind.VISITOR_CALENDAR.value or message.calendar_method != _REQUEST:
            continue
        if message.status != _FAILED:
            return None
        later = messages[position + 1 :]
        reached = any(m.calendar_method != _REQUEST or m.status != _FAILED for m in later)
        return None if reached else message
    return None
