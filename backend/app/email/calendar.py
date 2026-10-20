"""A visit in the visitor's and the host's calendars (Phase 14, B14-1 to B14-9).

The visit e-mails carry the visit as a calendar event: an iCalendar object (RFC 5545) sent as an iTIP
message (RFC 5546) by e-mail (iMIP, RFC 6047). Google Calendar and Gmail, Outlook and Apple Calendar
show it as an invitation that can be added with one action, and apply a later one with the same `UID`
to the entry already in the calendar:

* `REQUEST` when the visit is created (the visitor's invitation, the host's notice of a new visit) and
  again when it is rescheduled, with the same `UID` and a higher `SEQUENCE` (the visit's own counter,
  `visits.calendar_sequence`), so the entry moves;
* `CANCEL` when the visit is cancelled, with the same `UID` and a higher `SEQUENCE`, so the entry is
  removed.

The visitor's event and the host's are two calendar objects (`event_uid`: `visit-<id>-visitor` and
`visit-<id>-host`), each in the language that leads its e-mail. What one carries (B14-3): the visit's
times in UTC; a summary («زيارة إلى {company}» / "Visit to {company}" for the visitor, «زيارة: {visitor}» /
"Visit: {visitor}" for the host); the company's address as the location; who and what the visit is about
as the description, with the line about the pass at reception for the visitor. The host's event is
private (`CLASS:PRIVATE`, B14-19): a colleague who sees the host's calendar sees the time taken, not the
visitor. **Never a pass link or a pass token** (B14-4): calendars are synchronised, shared and delegated
far more widely than one e-mail, and the pass link is a bearer credential.

A visitor's address that changes takes the event from the old address's calendar (D-19, B14-17): a CANCEL
that uninvites that attendee alone (`CalendarEvent.withdrawn`), which says nothing of the visit but its
identity and times (RFC 5546 §3.2.5: no `STATUS`; no description, no location).

Who sends it (B14-5): the organizer is the address the e-mail is sent from (EMAIL_FROM), under the
company's name, as its `From` is; the recipient is the one attendee, who is asked for no reply
(`RSVP=FALSE`).

The writer is plain text by hand (no new dependency): `CRLF` line ends, every text escaped (`\\`, `;`, `,`
and line breaks), every line folded at 75 octets without splitting a character (RFC 5545 §3.1), times in
UTC (`…Z`), so no time zone definition is needed.
"""

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import quote
from uuid import UUID

import idna

from app.email.headers import display_name
from app.email.providers.base import CalendarPart

type CalendarMethod = Literal["REQUEST", "CANCEL"]
type CalendarRole = Literal["visitor", "host"]

# Who wrote the object (RFC 5545 §3.7.3: required, and read by no reader): nothing that names the product
# or a company (B12-22).
PRODID = "-//Visits//Visit calendar 1.0//EN"
# The longest content line, line break excluded (RFC 5545 §3.1); a continuation line starts with a space.
LINE_OCTETS = 75
# Control characters a TEXT value cannot hold (RFC 5545 §3.3.11: TSAFE-CHAR), other than the line
# breaks, which are escaped, and the tab, which becomes a space.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
# Explicit embeddings, overrides and isolates: in a calendar's one-line views nothing closes them.
_DIRECTION_CONTROLS = re.compile(
    "[\N{LEFT-TO-RIGHT EMBEDDING}-\N{RIGHT-TO-LEFT OVERRIDE}"
    "\N{LEFT-TO-RIGHT ISOLATE}-\N{POP DIRECTIONAL ISOLATE}]"
)
_LINE_BREAKS = re.compile("\r\n|[\r\n\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]")
# What a mailto: URI carries of a local part as it is (RFC 6068 §2: `atext` and the dot, less `%`, `/`,
# `?` and `#`, which are percent-encoded with everything else).
_MAILTO_SAFE = "!$&'*+-=^_`{|}~."


def event_uid(visit_id: UUID, role: CalendarRole) -> str:
    """The `UID` of a visit's event in the visitor's or the host's calendar: stable for the visit's life,
    globally unique (a visit's ID is a random UUID), and without a domain or anything that identifies a
    person (RFC 7986 §5.3). The web application writes the same `UID` into the events it offers for
    download, so an import meets the entry the e-mail made instead of adding a second one."""
    return f"visit-{visit_id}-{role}"


@dataclass(frozen=True, slots=True)
class CalendarMailbox:
    """An organizer or an attendee: the name a calendar shows and the address it writes to."""

    name: str
    address: str


@dataclass(frozen=True, slots=True)
class CalendarEvent:
    """One iTIP message about a visit: everything its iCalendar object says.

    `private`: the event is the attendee's own business (`CLASS:PRIVATE`: the host's, B14-19).
    `withdrawn`: a CANCEL that takes the event from this attendee alone, whose address the visit no longer
    has (D-19, B14-17), rather than cancelling the visit: RFC 5546 §3.2.5 then forbids `STATUS`."""

    method: CalendarMethod
    uid: str
    sequence: int
    stamp: datetime  # DTSTAMP: when this message was written
    start: datetime
    end: datetime
    summary: str
    location: str | None
    description: str | None
    organizer: CalendarMailbox
    attendee: CalendarMailbox
    private: bool = False
    withdrawn: bool = False


@dataclass(frozen=True, slots=True)
class VisitEvent:
    """What an e-mail about a visit says of it as a calendar event, before the e-mail is addressed: the
    e-mail service writes it when it renders the e-mail, and completes it with the recipient's address and
    the moment it is queued (`addressed`)."""

    method: CalendarMethod
    uid: str
    sequence: int
    start: datetime
    end: datetime
    summary: str
    location: str | None
    description: str | None
    organizer: CalendarMailbox
    attendee_name: str
    private: bool = False
    withdrawn: bool = False

    def addressed(self, address: str, *, stamp: datetime) -> CalendarEvent:
        return CalendarEvent(
            method=self.method,
            uid=self.uid,
            sequence=self.sequence,
            stamp=stamp,
            start=self.start,
            end=self.end,
            summary=self.summary,
            location=self.location,
            description=self.description,
            organizer=self.organizer,
            attendee=CalendarMailbox(self.attendee_name, address),
            private=self.private,
            withdrawn=self.withdrawn,
        )


def utc_stamp(moment: datetime) -> str:
    """A DATE-TIME in UTC (`20261020T070000Z`, RFC 5545 §3.3.5, form #2): no time zone definition is
    needed, and every calendar shows it in its own zone. Seconds are whole."""
    if moment.tzinfo is None:
        raise ValueError("a calendar time must be aware")
    return moment.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def text_value(value: str) -> str:
    """`value` as an iCalendar TEXT (RFC 5545 §3.3.11): a backslash, a semicolon and a comma escaped, a
    line break as `\\n`; no control or direction-control character (a tab is a space)."""
    value = _LINE_BREAKS.sub("\n", value).replace("\t", " ")
    value = _DIRECTION_CONTROLS.sub("", _CONTROL.sub("", value))
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def common_name(name: str) -> str | None:
    """A `CN` parameter's value: the name as a sender's display name is made safe (one line, no quote,
    backslash, angle bracket or `@`, bounded), in double quotes, so `:`, `;` and `,` stay text (RFC 5545
    §3.2: a quoted-string holds anything but a double quote and a control character), with every caret
    doubled (RFC 6868 §3: a reader that decodes parameter values reads `^n` as a line break and `^'` as a
    double quote, so a name that holds them as typed is written `^^n`, `^^'`). None when nothing is
    left."""
    shown = display_name(name)
    return '"' + shown.replace("^", "^^") + '"' if shown else None


def calendar_address(address: str) -> str:
    """`mailto:` and the address (RFC 6068): the domain in its ASCII form, the local part as typed where a
    URI may carry it and percent-encoded where it may not."""
    local, _, domain = address.strip().rpartition("@")
    try:
        ascii_domain = idna.encode(domain).decode("ascii") if not domain.isascii() else domain
    except idna.IDNAError, UnicodeError:
        ascii_domain = quote(domain, safe=".-")
    return f"mailto:{quote(local, safe=_MAILTO_SAFE)}@{ascii_domain.lower()}"


def fold(line: str) -> bytes:
    """A content line in UTF-8, folded so that no line is longer than 75 octets: each continuation starts
    with one space, and a cut never falls inside a character's octets (RFC 5545 §3.1), so a reader that
    unfolds octet by octet and one that unfolds text both get the line back."""
    data = line.encode("utf-8")
    pieces: list[bytes] = []
    start, room = 0, LINE_OCTETS
    while len(data) - start > room:
        cut = start + room
        while data[cut] & 0xC0 == 0x80:  # a continuation octet: its character started before the cut
            cut -= 1
        pieces.append(data[start:cut])
        start, room = cut, LINE_OCTETS - 1  # the space that starts the next line is one of its octets
    pieces.append(data[start:])
    return b"\r\n ".join(pieces)


def _mailbox_line(name: str, mailbox: CalendarMailbox, *parameters: str) -> str:
    cn = common_name(mailbox.name)
    leading = (f"CN={cn}",) if cn else ()
    return f"{';'.join((name, *leading, *parameters))}:{calendar_address(mailbox.address)}"


def write_calendar(event: CalendarEvent) -> bytes:
    """The iCalendar object of `event` (RFC 5545), as an iMIP body carries it: UTF-8, `CRLF` line ends,
    folded lines.

    A REQUEST is a confirmed, busy event; a CANCEL repeats what identifies it (`UID`, the organizer, the
    attendee) with a higher `SEQUENCE` and `STATUS:CANCELLED` (RFC 5546 §3.2.2, §3.2.5), and its times
    and summary, which the clients show in the notice of the cancellation. A withdrawal (a CANCEL that
    uninvites its attendee, not one of the visit) has no `STATUS`, which §3.2.5 forbids then."""
    if event.sequence < 0:
        raise ValueError("SEQUENCE is never negative")
    if event.end <= event.start:
        raise ValueError("an event ends after it starts")
    if event.withdrawn and event.method != "CANCEL":
        raise ValueError("only a CANCEL withdraws an event from an attendee")
    lines = [
        "BEGIN:VCALENDAR",
        f"PRODID:{PRODID}",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        f"METHOD:{event.method}",
        "BEGIN:VEVENT",
        f"UID:{text_value(event.uid)}",
        f"SEQUENCE:{event.sequence}",
        f"DTSTAMP:{utc_stamp(event.stamp)}",
        f"DTSTART:{utc_stamp(event.start)}",
        f"DTEND:{utc_stamp(event.end)}",
        f"SUMMARY:{text_value(event.summary)}",
    ]
    if event.location:
        lines.append(f"LOCATION:{text_value(event.location)}")
    if event.description:
        lines.append(f"DESCRIPTION:{text_value(event.description)}")
    lines += [
        _mailbox_line("ORGANIZER", event.organizer),
        _mailbox_line(
            "ATTENDEE",
            event.attendee,
            "CUTYPE=INDIVIDUAL",
            "ROLE=REQ-PARTICIPANT",
            "PARTSTAT=NEEDS-ACTION",
            "RSVP=FALSE",
        ),
    ]
    if event.private:
        lines.append("CLASS:PRIVATE")
    if not event.withdrawn:
        lines.append(f"STATUS:{'CANCELLED' if event.method == 'CANCEL' else 'CONFIRMED'}")
    lines += ["TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR"]
    return b"".join(fold(line) + b"\r\n" for line in lines)


def calendar_part(event: CalendarEvent) -> CalendarPart:
    """`event` as the providers carry it (`OutgoingEmail.calendar`)."""
    return CalendarPart(
        method=event.method, uid=event.uid, sequence=event.sequence, content=write_calendar(event)
    )
