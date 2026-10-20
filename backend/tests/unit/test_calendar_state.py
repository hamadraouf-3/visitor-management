"""What each calendar holds of a visit (`app.services.calendar_state`, Phase 14, B14-16, B14-18, B14-26):
the rules read from the events a visit's e-mails carried, as pure functions."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.repositories.email_messages import EventMessages, LatestEmail
from app.services.calendar_state import failed_calendar_invitation, holds_event, messages_to

START = datetime(2026, 10, 20, 7, 0, tzinfo=UTC)
VISIT = uuid.UUID("0b6f4f6e-6d1c-4f53-9a43-8f2b9c0f1a77")


def _email(
    kind: str, minute: int, *, status: str = "SENT", method: str | None = "REQUEST", to: str = "dana@x.test"
) -> LatestEmail:
    return LatestEmail(
        kind=kind,
        status=status,
        to_email=to,
        attempts=1,
        last_attempt_at=None,
        sent_at=None,
        last_error="refused" if status == "FAILED" else None,
        created_at=START + timedelta(minutes=minute),
        calendar_method=method,
    )


INVITATION = _email("VISITOR_INVITATION", 0, method=None)
CALENDAR = _email("VISITOR_CALENDAR", 1)
FAILED_CALENDAR = _email("VISITOR_CALENDAR", 1, status="FAILED")


@pytest.mark.parametrize(
    ("messages", "holds"),
    [
        ([], False),
        ([CALENDAR], True),
        ([FAILED_CALENDAR], True),  # it may have arrived: one CANCEL too many rather than one too few
        ([CALENDAR, _email("VISITOR_CALENDAR", 2, method="CANCEL")], False),  # withdrawn
        ([CALENDAR, _email("VISITOR_CALENDAR", 2, method="CANCEL"), _email("VISIT_RESCHEDULED", 3)], True),
        ([_email("VISIT_CANCELLED", 5, method="CANCEL")], False),
    ],
    ids=["nothing", "a request", "a failed request", "withdrawn", "back again", "cancelled"],
)
def test_a_calendar_holds_the_event_its_last_event_put_there(
    messages: list[LatestEmail], holds: bool
) -> None:
    assert holds_event(messages) is holds


@pytest.mark.parametrize(
    ("messages", "invitation", "failed"),
    [
        ([FAILED_CALENDAR], INVITATION, True),
        ([CALENDAR], INVITATION, False),
        ([FAILED_CALENDAR], _email("VISITOR_INVITATION", 0, status="FAILED", method=None), False),
        ([FAILED_CALENDAR], None, False),
        # A later REQUEST that went out (or is on its way) put the event there; one that failed did not.
        ([FAILED_CALENDAR, _email("VISIT_RESCHEDULED", 2)], INVITATION, False),
        ([FAILED_CALENDAR, _email("VISIT_RESCHEDULED", 2, status="PENDING")], INVITATION, False),
        ([FAILED_CALENDAR, _email("VISIT_RESCHEDULED", 2, status="FAILED")], INVITATION, True),
        # ... and a calendar invitation sent again alone that went out (B14-31).
        ([FAILED_CALENDAR, _email("VISITOR_CALENDAR", 2)], INVITATION, False),
        ([FAILED_CALENDAR, _email("VISITOR_CALENDAR", 2, status="FAILED")], INVITATION, True),
        # A failed REQUEST after a calendar invitation that went out is the notice's failure, not this.
        ([CALENDAR, _email("VISIT_RESCHEDULED", 2, status="FAILED")], INVITATION, False),
        # The calendar invitation of an earlier invitation is not the latest one's.
        ([FAILED_CALENDAR], _email("VISITOR_INVITATION", 3, method=None), False),
    ],
    ids=[
        "failed",
        "went out",
        "the invitation failed",
        "no invitation",
        "a later request went out",
        "a later request on its way",
        "a later request failed too",
        "sent again alone",
        "sent again alone and failed",
        "the notice failed",
        "an earlier invitation's",
    ],
)
def test_the_calendar_invitation_failed_until_a_request_reaches_the_calendar(
    messages: list[LatestEmail], invitation: LatestEmail | None, failed: bool
) -> None:
    found = failed_calendar_invitation(messages, invitation)
    assert (found is not None) is failed
    if found is not None:
        assert found.kind == "VISITOR_CALENDAR" and found.status == "FAILED"


def test_the_events_of_one_mailbox_are_read_in_any_spelling_and_in_order() -> None:
    """B14-21: an address's other spellings reach the same mailbox, so their events are one calendar's."""
    first = _email("VISITOR_CALENDAR", 1, to="dana.guest@gmail.com")
    later = _email("VISIT_RESCHEDULED", 3, to="danaguest@gmail.com")
    other = _email("VISITOR_CALENDAR", 2, to="someone@x.test")
    events: EventMessages = {
        VISIT: {"danaguest@gmail.com": [later], "dana.guest@gmail.com": [first], "someone@x.test": [other]}
    }
    assert messages_to(events, VISIT, "Dana.Guest+visits@googlemail.com") == [first, later]
    assert messages_to(events, VISIT, None) == [] and messages_to(events, uuid.uuid4(), "a@x.test") == []
