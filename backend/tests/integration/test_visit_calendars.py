"""A visit in the visitor's and the host's calendars, through the API (Phase 14, B14-1 to B14-23).

What creating, rescheduling and cancelling a visit queues for whom, with which calendar event: the
visitor's invitation and the calendar invitation that follows it (VISITOR_CALENDAR, B14-10), the notices
of a new time and of a cancellation, and the host's three e-mails (HOST_VISIT_*, B14-2), each event read
back by an iCalendar parser that is not ours. Who receives what follows the rules the visit e-mails
already had: a visitor never invited by e-mail and a walk-in get nothing; a host is told only while the
account is active (and of the cancellations its deactivation causes), and of a change only when they were
told of the visit. No calendar data ever holds the pass link or its token (B14-4). The review's fixes: the
budgets of the host's e-mails and of a company's calendar e-mails (B14-15), a cancelled visit always
leaving the visitor's calendar (B14-16), an old address's calendar losing the visit (B14-17), and a failed
calendar invitation needing attention (B14-18)."""

from datetime import timedelta

import icalendar
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.base import OutgoingEmail
from app.email.providers.memory import MemoryProvider
from app.models import EmailMessage, Role, User, VisitorPass
from app.security.tokens import hash_token
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    audit_rows,
    check_in,
    create_visit,
    error_code,
    pass_token,
    rate_limits,
    signed_in,
    visit_body,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)  # 10:00 in Asia/Amman


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


def _kinds(provider: MemoryProvider) -> list[str]:
    return [email.kind.value for email in provider.sent]


def _calendars(provider: MemoryProvider) -> list[tuple[str, str | None]]:
    """Each e-mail's kind and the iTIP method of the event it carries (None: no event)."""
    return [(email.kind.value, email.calendar.method if email.calendar else None) for email in provider.sent]


def _event(email: OutgoingEmail) -> tuple[str, icalendar.Event]:
    """The method and the one event of the calendar part of `email`."""
    assert email.calendar is not None
    calendar = icalendar.Calendar.from_ical(email.calendar.content)
    [event] = calendar.walk("VEVENT")
    assert calendar["METHOD"] == email.calendar.method
    assert (str(event["UID"]), event["SEQUENCE"]) == (email.calendar.uid, email.calendar.sequence)
    return str(calendar["METHOD"]), event


def _reschedule(api: Api, visit_id: str, hours: int) -> dict:
    start = START + timedelta(hours=hours)
    response = api.patch(
        f"/visits/{visit_id}",
        json={
            "scheduled_start": start.isoformat(),
            "scheduled_end": (start + timedelta(hours=1)).isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_a_visit_s_life_in_both_calendars(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """Created, rescheduled, cancelled: the visitor's event and the host's, each with its own UID, one
    version newer at every change, in the order the e-mails are delivered."""
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    token = pass_token(created["pass_url"])
    assert created["visit"]["calendar_sequence"] == 0
    assert _kinds(email_provider) == ["VISITOR_INVITATION", "VISITOR_CALENDAR", "HOST_VISIT_SCHEDULED"]
    invitation, visitor_calendar, host_notice = email_provider.sent
    assert invitation.calendar is None  # the pass's e-mail carries no event (B14-10)
    assert visitor_calendar.to == invitation.to and host_notice.to == world.a.employee.email
    method, event = _event(visitor_calendar)
    assert (method, str(event["UID"]), event["SEQUENCE"]) == ("REQUEST", f"visit-{visit_id}-visitor", 0)
    assert event.decoded("DTSTART") == START and str(event["ATTENDEE"]) == f"mailto:{invitation.to}"
    assert str(event["SUMMARY"]) == "Visit to Alpha"
    method, event = _event(host_notice)
    assert (method, str(event["UID"]), event["SEQUENCE"]) == ("REQUEST", f"visit-{visit_id}-host", 0)
    assert str(event["SUMMARY"]) == "Visit: Dana Guest"
    assert str(event["ATTENDEE"]) == f"mailto:{world.a.employee.email}"
    email_provider.clear()

    moved = _reschedule(host, visit_id, 3)
    assert moved["calendar_sequence"] == 1
    assert _kinds(email_provider) == ["VISIT_RESCHEDULED", "HOST_VISIT_RESCHEDULED"]
    for email, role in zip(email_provider.sent, ("visitor", "host"), strict=True):
        method, event = _event(email)
        assert (method, str(event["UID"]), event["SEQUENCE"]) == ("REQUEST", f"visit-{visit_id}-{role}", 1)
        assert event.decoded("DTSTART") == START + timedelta(hours=3)
    assert audit_rows(db, "VISIT_RESCHEDULED", entity_id=visit_id)[-1].meta["host_notified"] is True
    email_provider.clear()

    cancelled = host.post(f"/visits/{visit_id}/cancel", json={"reason": "Plans changed"})
    assert cancelled.status_code == 200 and cancelled.json()["calendar_sequence"] == 2
    assert _kinds(email_provider) == ["VISIT_CANCELLED", "HOST_VISIT_CANCELLED"]
    for email, role in zip(email_provider.sent, ("visitor", "host"), strict=True):
        method, event = _event(email)
        assert (method, str(event["UID"]), event["SEQUENCE"]) == ("CANCEL", f"visit-{visit_id}-{role}", 2)
        assert str(event["STATUS"]) == "CANCELLED"
    # The e-mail log knows each one, the host's with the host as its recipient.
    rows = db.scalars(select(EmailMessage).where(EmailMessage.visit_id == visit_id)).all()
    assert sorted(row.kind for row in rows) == sorted(
        [
            "VISITOR_INVITATION",
            "VISITOR_CALENDAR",
            "HOST_VISIT_SCHEDULED",
            "VISIT_RESCHEDULED",
            "HOST_VISIT_RESCHEDULED",
            "VISIT_CANCELLED",
            "HOST_VISIT_CANCELLED",
        ]
    )
    assert {row.recipient_user_id for row in rows if row.kind.startswith("HOST_")} == {world.a.employee.id}
    # No calendar part of any of them holds the pass link or its token (B14-4).
    for email in email_provider.sent:
        assert email.calendar is not None and token.encode() not in email.calendar.content


def test_a_visitor_never_invited_by_e_mail_is_sent_nothing_and_the_host_is_told(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    """A pass the host shares himself (no invitation e-mail): the visitor gets no calendar invitation, no
    new time and no cancellation, as before; the host gets all three (B14-2)."""
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    _reschedule(host, visit_id, 2)
    host.post(f"/visits/{visit_id}/cancel", json={"notify_visitor": True})
    assert _kinds(email_provider) == [
        "HOST_VISIT_SCHEDULED",
        "HOST_VISIT_RESCHEDULED",
        "HOST_VISIT_CANCELLED",
    ]
    assert {email.to for email in email_provider.sent} == {world.a.employee.email}
    assert [_event(email)[1]["SEQUENCE"] for email in email_provider.sent] == [0, 1, 2]


def test_an_administrator_s_booking_tells_the_host_in_the_host_s_language(
    make_client, world: World, factory: Factory, email_provider: MemoryProvider
) -> None:
    colleague = factory.user(
        world.a.company, roles=(Role.EMPLOYEE,), full_name="Colleague Host", preferred_language="ar"
    )
    admin = signed_in(make_client, world.a.admin)
    visit_id = create_visit(admin, colleague.id, START, send_invitation=True)["visit"]["id"]
    [notice] = [email for email in email_provider.sent if email.kind == "HOST_VISIT_SCHEDULED"]
    assert notice.to == colleague.email  # the host, not who booked it
    assert notice.subject.startswith("زيارة جديدة: Dana Guest")
    _, event = _event(notice)
    assert str(event["UID"]) == f"visit-{visit_id}-host" and str(event["SUMMARY"]) == "زيارة: Dana Guest"
    assert "الحجز بواسطة: Alpha Admin" in str(event["DESCRIPTION"])
    # The visitor's calendar invitation is in the company's language (English here).
    [calendar] = [email for email in email_provider.sent if email.kind == "VISITOR_CALENDAR"]
    assert str(_event(calendar)[1]["SUMMARY"]) == "Visit to Alpha"


def test_a_walk_in_sends_no_calendar(
    make_client, world: World, clock, email_provider: MemoryProvider
) -> None:
    reception = signed_in(make_client, world.a.receptionist)
    response = reception.post(
        "/reception/walk-ins", json=walk_in_body(world.a.employee.id, clock.now() + timedelta(hours=1))
    )
    assert response.status_code == 201, response.text
    assert response.json()["calendar_sequence"] == 0
    assert all(email.calendar is None for email in email_provider.sent)
    assert not {"VISITOR_CALENDAR", "HOST_VISIT_SCHEDULED"} & set(_kinds(email_provider))


def test_a_host_s_arrival_notice_carries_no_event(
    make_client, host: Api, world: World, clock, email_provider: MemoryProvider
) -> None:
    visit = create_visit(host, world.a.employee.id, clock.now() + timedelta(minutes=10))["visit"]
    email_provider.clear()
    assert check_in(signed_in(make_client, world.a.receptionist), visit["id"]).status_code == 200
    assert _kinds(email_provider) == ["HOST_ARRIVAL"] and email_provider.sent[0].calendar is None


def test_a_host_never_told_of_a_visit_is_not_told_of_its_changes(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """A visit booked before the host's e-mails existed has no HOST_VISIT_SCHEDULED in its log: its new
    time and its cancellation reach only the visitor, as before (B24-25's rule, for hosts)."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    # As the log of a visit booked before Phase 14: no notice to the host.
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.visit_id == visit_id, EmailMessage.kind == "HOST_VISIT_SCHEDULED")
        .values(kind="HOST_ARRIVAL")
    )
    db.commit()
    email_provider.clear()
    _reschedule(host, visit_id, 2)
    host.post(f"/visits/{visit_id}/cancel", json={})
    assert _kinds(email_provider) == ["VISIT_RESCHEDULED", "VISIT_CANCELLED"]
    assert audit_rows(db, "VISIT_RESCHEDULED", entity_id=visit_id)[-1].meta["host_notified"] is False
    assert audit_rows(db, "VISIT_CANCELLED", entity_id=visit_id)[-1].meta["host_notified"] is False


def test_a_deactivated_host_is_told_of_the_cancellations_it_causes(
    app: FastAPI, make_client, world: World, factory: Factory, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-20: the visits a deactivation cancels (D-18) leave the calendar of the account it stops, within
    the budgets of the administrator who deactivates it (B14-15); nothing is sent to it afterwards."""
    host_user = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Leaving Host")
    api = signed_in(make_client, host_user)
    invited = create_visit(api, host_user.id, START, send_invitation=True)["visit"]["id"]
    others = [create_visit(api, host_user.id, START + timedelta(days=day))["visit"]["id"] for day in (1, 2)]
    email_provider.clear()
    admin = signed_in(make_client, world.a.admin)
    with rate_limits(app, host_visit_notices_per_user_day=2):
        response = admin.patch(f"/users/{host_user.id}", json={"is_active": False})
    assert response.status_code == 200 and response.json()["cancelled_visits"] == 3
    told = [email for email in email_provider.sent if email.kind == "HOST_VISIT_CANCELLED"]
    assert sorted(_kinds(email_provider)) == ["HOST_VISIT_CANCELLED"] * 2 + ["VISIT_CANCELLED"]
    assert {email.to for email in told} == {host_user.email}
    for email in told:
        method, event = _event(email)
        assert method == "CANCEL" and event["SEQUENCE"] == 1 and str(event["UID"]).endswith("-host")
    rows = [audit_rows(db, "VISIT_CANCELLED", entity_id=visit_id)[-1].meta for visit_id in (invited, *others)]
    assert sorted(row["host_notified"] for row in rows) == [False, True, True]
    assert {row["host_notice_limited_by"] for row in rows if not row["host_notified"]} == {
        "host_visit_notices_per_user_day"
    }


def test_a_host_who_loses_the_host_role_is_told_of_each_cancellation(
    make_client, world: World, factory: Factory, email_provider: MemoryProvider
) -> None:
    """Still an active account: the cancelled visits leave the user's calendar (D-18, B14-2)."""
    host_user = factory.user(world.a.company, roles=(Role.EMPLOYEE, Role.RECEPTIONIST), full_name="Moving On")
    api = signed_in(make_client, host_user)
    first = create_visit(api, host_user.id, START)["visit"]["id"]
    second = create_visit(api, host_user.id, START + timedelta(days=1))["visit"]["id"]
    email_provider.clear()
    admin = signed_in(make_client, world.a.admin)
    response = admin.patch(f"/users/{host_user.id}", json={"roles": ["RECEPTIONIST"]})
    assert response.status_code == 200 and response.json()["cancelled_visits"] == 2
    assert _kinds(email_provider) == ["HOST_VISIT_CANCELLED"] * 2
    assert {str(_event(email)[1]["UID"]) for email in email_provider.sent} == {
        f"visit-{first}-host",
        f"visit-{second}-host",
    }
    assert all("Host is no longer available" in email.text for email in email_provider.sent)


def test_the_host_s_notice_of_a_new_time_is_not_in_the_reschedule_budgets(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-15: the visitor's notice of a new time is in the reschedule budgets, the host's in the host's
    e-mails; a correction beyond the visit's budget still moves the host's calendar, and a new time that
    tells only the host spends nothing of the reschedule budgets. The new time always stands and always
    raises the event's version (B14-6)."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    email_provider.clear()
    with rate_limits(app, reschedule_notices_per_visit=1, reschedule_notices_per_user_day=1):
        _reschedule(host, visit_id, 2)
        limited = _reschedule(host, visit_id, 3)
        # A visit whose visitor is not e-mailed: its new times tell the host only, and spend nothing.
        shared = create_visit(host, world.a.employee.id, START)["visit"]["id"]
        _reschedule(host, shared, 4)
    assert limited["calendar_sequence"] == 2
    assert _kinds(email_provider) == [
        "VISIT_RESCHEDULED",
        "HOST_VISIT_RESCHEDULED",
        "HOST_VISIT_RESCHEDULED",
        "HOST_VISIT_SCHEDULED",
        "HOST_VISIT_RESCHEDULED",
    ]
    last = audit_rows(db, "VISIT_RESCHEDULED", entity_id=visit_id)[-1].meta
    assert last["visitor_notified"] is False and last["notice_limited_by"] == "reschedule_notices_per_visit"
    assert last["host_notified"] is True and last["host_notice_limited_by"] is None
    assert [_event(email)[1]["SEQUENCE"] for email in email_provider.sent[1:3]] == [1, 2]
    # The cancellation, one version newer than the last new time, reaches both calendars.
    email_provider.clear()
    host.post(f"/visits/{visit_id}/cancel", json={})
    assert [_event(email)[1]["SEQUENCE"] for email in email_provider.sent] == [3, 3]


def test_a_purpose_change_sends_nothing_and_keeps_the_version(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    email_provider.clear()
    response = host.patch(f"/visits/{visit_id}", json={"purpose": "Contract signing"})
    assert response.status_code == 200 and response.json()["calendar_sequence"] == 0
    assert email_provider.sent == []


def test_a_resend_sends_the_calendar_invitation_again(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    _reschedule(host, visit_id, 2)
    email_provider.clear()
    assert host.post(f"/visits/{visit_id}/invitation").status_code == 200
    assert _kinds(email_provider) == ["VISITOR_INVITATION", "VISITOR_CALENDAR"]
    # The same event at its current version: a calendar that has it changes nothing.
    method, event = _event(email_provider.sent[1])
    assert (method, str(event["UID"]), event["SEQUENCE"]) == ("REQUEST", f"visit-{visit_id}-visitor", 1)


def test_the_sending_mailbox_is_never_invited_to_its_own_event(
    app: FastAPI,
    make_client,
    world: World,
    factory: Factory,
    db: Session,
    email_provider: MemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B14-5: EMAIL_FROM's address organizes every event. A host whose address it is gets the e-mails
    without the event; a visitor whose address it is gets the invitation and no calendar invitation."""
    settings = app.state.service_environment.settings
    monkeypatch.setattr(settings, "email_from", "Alpha Visits <frontdesk@example.com>")
    mailbox_host = factory.user(
        world.a.company, roles=(Role.EMPLOYEE,), email="frontdesk@example.com", full_name="Front Desk"
    )
    api = signed_in(make_client, mailbox_host)
    visit_id = create_visit(api, mailbox_host.id, START)["visit"]["id"]
    _reschedule(api, visit_id, 2)
    assert _kinds(email_provider) == ["HOST_VISIT_SCHEDULED", "HOST_VISIT_RESCHEDULED"]
    assert all(email.calendar is None for email in email_provider.sent)
    assert "attached for your calendar" not in email_provider.sent[0].text
    email_provider.clear()
    visitor = {"full_name": "Self Visitor", "email": "FrontDesk@example.com"}
    create_visit(api, mailbox_host.id, START, visitor=visitor, send_invitation=True)
    assert _kinds(email_provider) == ["VISITOR_INVITATION", "HOST_VISIT_SCHEDULED"]
    assert all(email.calendar is None for email in email_provider.sent)
    # Anyone else is invited as before.
    email_provider.clear()
    create_visit(signed_in(make_client, world.a.employee), world.a.employee.id, START, send_invitation=True)
    assert all(email.calendar is not None for email in email_provider.sent[1:])
    assert db.scalars(select(User).where(User.id == mailbox_host.id)).one().email == "frontdesk@example.com"


def test_the_company_address_is_in_me(make_client, world: World, db: Session) -> None:
    world.a.company.address = "Building 14\nKing Abdullah II Street"
    world.a.company.address_ar = "مبنى 14"
    db.commit()
    company = signed_in(make_client, world.a.employee).get("/auth/me").json()["company"]
    assert company["address"] == "Building 14\nKing Abdullah II Street"
    assert company["address_ar"] == "مبنى 14"
    other = signed_in(make_client, world.b.employee).get("/auth/me").json()["company"]
    assert other["address"] is None and other["address_ar"] is None


# ---- the review's fixes (B14-15 to B14-20) -------------------------------------------------------------


def test_the_host_s_e_mails_have_a_daily_budget_per_acting_user(
    app: FastAPI, make_client, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-15: a user who creates and cancels visits sends the host's e-mails within a daily budget of
    their own, whoever the host is; beyond it the visit is still created or cancelled and the audit says
    which e-mail was left out and why. Another user (an administrator booking) has a budget of their own."""
    with rate_limits(app, host_visit_notices_per_user_day=2):
        visit_ids = [
            create_visit(host, world.a.employee.id, START + timedelta(hours=hour))["visit"]["id"]
            for hour in range(3)
        ]
        for visit_id in visit_ids:
            assert host.post(f"/visits/{visit_id}/cancel", json={}).status_code == 200
        create_visit(signed_in(make_client, world.a.admin), world.a.employee.id, START)
    assert _kinds(email_provider) == ["HOST_VISIT_SCHEDULED"] * 3  # two of the user's, one of the admin's
    created = [audit_rows(db, "VISIT_CREATED", entity_id=visit_id)[-1].meta for visit_id in visit_ids]
    assert [row["host_notified"] for row in created] == [True, True, False]
    assert [row["host_notice_limited_by"] for row in created] == [
        None,
        None,
        "host_visit_notices_per_user_day",
    ]
    cancelled = [audit_rows(db, "VISIT_CANCELLED", entity_id=visit_id)[-1].meta for visit_id in visit_ids]
    assert [row["host_notified"] for row in cancelled] == [False, False, False]
    # The third visit's host was never told of it, so its cancellation needs no budget (B24-25's rule).
    assert [row["host_notice_limited_by"] for row in cancelled] == ["host_visit_notices_per_user_day"] * 2 + [
        None
    ]


def test_every_e_mail_budget_bounds_what_creating_and_cancelling_sends(
    app: FastAPI, host: Api, world: World, email_provider: MemoryProvider
) -> None:
    """The review's probe (H1): with every budget at 1, fifteen visits created and cancelled by one user
    used to send the host thirty e-mails; now one."""
    with rate_limits(
        app,
        invitations_per_user_day=1,
        reschedule_notices_per_user_day=1,
        reschedule_notices_per_visit=1,
        host_arrivals_per_user_day=1,
        host_visit_notices_per_user_day=1,
        calendar_emails_per_company_day=1,
    ):
        for hour in range(15):
            visit_id = create_visit(host, world.a.employee.id, START + timedelta(hours=hour))["visit"]["id"]
            assert host.post(f"/visits/{visit_id}/cancel", json={}).status_code == 200
    assert _kinds(email_provider) == ["HOST_VISIT_SCHEDULED"]


def test_the_calendar_e_mails_have_a_daily_budget_per_company(
    app: FastAPI, make_client, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-15, B14-28: every company's e-mails leave through one mailbox, so a company's calendar events
    are bounded per day. Beyond the budget the change is still made: an e-mail that is only the event
    (the visitor's calendar invitation, the host's notice of a new visit) is left out, a notice (of a new
    time) goes without its event, and an event that takes the visit out of a calendar is never left out.
    The audit says what was left out and by what. Another company's budget is its own."""
    limited = "calendar_emails_per_company_day"
    with rate_limits(app, calendar_emails_per_company_day=3):
        first = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]  # 2 events
        _reschedule(host, first["id"], 2)  # the visitor's event takes the third; the host's goes without
        second = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
        _reschedule(host, second["id"], 3)  # the visitor is told, without the event
        other = signed_in(make_client, world.b.employee)
        create_visit(other, world.b.employee.id, START, send_invitation=True)
        cancelled = host.post(f"/visits/{first['id']}/cancel", json={"notify_visitor": False})
        host.post(f"/visits/{second['id']}/cancel", json={"notify_visitor": False})
    assert _calendars(email_provider) == [
        ("VISITOR_INVITATION", None),
        ("VISITOR_CALENDAR", "REQUEST"),
        ("HOST_VISIT_SCHEDULED", "REQUEST"),
        ("VISIT_RESCHEDULED", "REQUEST"),
        ("HOST_VISIT_RESCHEDULED", None),  # told, without the event
        ("VISITOR_INVITATION", None),  # the second visit: its pass, without the calendar invitation
        ("VISIT_RESCHEDULED", None),  # ... its new time, without the event
        ("VISITOR_INVITATION", None),  # the other company
        ("VISITOR_CALENDAR", "REQUEST"),
        ("HOST_VISIT_SCHEDULED", "REQUEST"),
        ("VISIT_CANCELLED", "CANCEL"),  # the first visit leaves both calendars whatever the budget says
        ("HOST_VISIT_CANCELLED", "CANCEL"),
    ]
    moved = audit_rows(db, "VISIT_RESCHEDULED", entity_id=first["id"])[-1].meta
    assert (moved["visitor_notified"], moved["calendar_sent"], moved["notice_limited_by"]) == (
        True,
        True,
        None,
    )
    assert (moved["host_notified"], moved["host_calendar_sent"], moved["host_notice_limited_by"]) == (
        True,
        False,
        limited,
    )
    queued = audit_rows(db, "INVITATION_QUEUED", entity_id=second["id"])[-1].meta
    assert queued["calendar_sent"] is False and queued["notice_limited_by"] == limited
    created = audit_rows(db, "VISIT_CREATED", entity_id=second["id"])[-1].meta
    assert created["host_notified"] is False and created["host_notice_limited_by"] == limited
    second_moved = audit_rows(db, "VISIT_RESCHEDULED", entity_id=second["id"])[-1].meta
    assert (second_moved["visitor_notified"], second_moved["calendar_sent"]) == (True, False)
    assert second_moved["notice_limited_by"] == limited and second_moved["host_notified"] is False
    assert first["visitor_calendar_sent"] is True and second["visitor_calendar_sent"] is False
    gone = audit_rows(db, "VISIT_CANCELLED", entity_id=first["id"])[-1].meta
    assert gone["visitor_notified"] is True and gone["host_notified"] is True
    assert cancelled.json()["status"] == "CANCELLED"
    # The second visitor's calendar never had the visit: `notify_visitor: false` is honoured.
    assert audit_rows(db, "VISIT_CANCELLED", entity_id=second["id"])[-1].meta["visitor_notified"] is False


def test_a_cancelled_visit_always_leaves_the_visitor_s_calendar(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-16, the owner's decision: once the visitor's calendar was sent the visit, its cancellation
    reaches the visitor whatever `notify_visitor` says; `visitor_calendar_sent` tells the web
    application so. A visitor whose calendar never had it is told only when asked."""
    sent = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    never = create_visit(host, world.a.employee.id, START)["visit"]
    assert sent["visitor_calendar_sent"] is True and never["visitor_calendar_sent"] is False
    assert host.get(f"/visits/{sent['id']}").json()["visitor_calendar_sent"] is True
    email_provider.clear()
    assert host.post(f"/visits/{sent['id']}/cancel", json={"notify_visitor": False}).status_code == 200
    assert _kinds(email_provider) == ["VISIT_CANCELLED", "HOST_VISIT_CANCELLED"]
    method, event = _event(email_provider.sent[0])
    assert (method, str(event["UID"]), event["SEQUENCE"]) == ("CANCEL", f"visit-{sent['id']}-visitor", 1)
    assert audit_rows(db, "VISIT_CANCELLED", entity_id=sent["id"])[-1].meta["visitor_notified"] is True
    email_provider.clear()
    assert host.post(f"/visits/{never['id']}/cancel", json={"notify_visitor": False}).status_code == 200
    assert _kinds(email_provider) == ["HOST_VISIT_CANCELLED"]


def test_a_new_address_takes_the_visit_out_of_the_old_address_s_calendar(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-17 (D-19): the calendar of the address the visitor no longer has loses the visit, by a CANCEL
    that uninvites it, one version newer, and says nothing of the visit; the new address's calendar
    invitation is one version newer still (B14-30). The withdrawal counts against the editor's
    invitations. A removed address takes the visit out of the last one's calendar, and the visitor is
    then sent nothing."""
    person = {"full_name": "Moving Guest", "email": "old@example.com"}
    with rate_limits(app, invitations_per_user_day=3):
        created = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)
        visit_id, visitor_id = created["visit"]["id"], created["visit"]["visitor"]["id"]
        email_provider.clear()
        assert host.patch(f"/visitors/{visitor_id}", json={"email": "new@example.com"}).status_code == 200
        # One invitation, its re-send and the withdrawal: the budget of three is spent.
        refused = host.post("/visits", json=visit_body(world.a.employee.id, START, send_invitation=True))
    assert refused.status_code == 429 and error_code(refused) == "INVITATION_LIMIT"
    assert [(email.kind, email.to) for email in email_provider.sent] == [
        ("VISITOR_CALENDAR", "old@example.com"),
        ("VISITOR_INVITATION", "new@example.com"),
        ("VISITOR_CALENDAR", "new@example.com"),
    ]
    withdrawal, _, invitation = email_provider.sent
    method, event = _event(withdrawal)
    assert (method, str(event["UID"]), event["SEQUENCE"]) == ("CANCEL", f"visit-{visit_id}-visitor", 1)
    assert "STATUS" not in event and "DESCRIPTION" not in event and "LOCATION" not in event
    assert str(event["SUMMARY"]) == "Visit" and "CN" not in event["ATTENDEE"].params
    assert withdrawal.reply_to == app.state.service_environment.settings.email_reply_to  # never the host's
    assert pass_token(created["pass_url"]) not in withdrawal.html + withdrawal.text
    assert "Moving Guest" not in withdrawal.html + withdrawal.text and "Alpha Employee" not in withdrawal.text
    method, event = _event(invitation)
    assert (method, event["SEQUENCE"]) == ("REQUEST", 2)
    visit = host.get(f"/visits/{visit_id}").json()
    assert visit["calendar_sequence"] == 2 and visit["visitor_calendar_sent"] is True
    assert visit["invitation"]["to_email"] == "new@example.com" and visit["invitation"]["status"] == "SENT"

    email_provider.clear()
    assert host.patch(f"/visitors/{visitor_id}", json={"email": None}).status_code == 200
    [withdrawal] = email_provider.sent
    assert withdrawal.to == "new@example.com" and _event(withdrawal)[1]["SEQUENCE"] == 3
    # A withdrawal that fails is no failed invitation: the visit has no address to resend to.
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.id == withdrawal.message_id)
        .values(status="FAILED", sent_at=None, last_error="Refused.")
    )
    db.commit()
    visit = host.get(f"/visits/{visit_id}").json()
    assert visit["calendar_sequence"] == 3 and visit["visitor_calendar_sent"] is False
    assert visit["invitation"]["status"] == "SENT"
    assert host.get("/visits", params={"needs_attention": "true"}).json()["items"] == []
    email_provider.clear()
    assert host.post(f"/visits/{visit_id}/cancel", json={"notify_visitor": False}).status_code == 200
    assert _kinds(email_provider) == ["HOST_VISIT_CANCELLED"]


def test_a_failed_calendar_invitation_needs_attention_like_a_failed_invitation(
    host: Api, world: World, db: Session, email_provider: MemoryProvider, clock: FakeClock
) -> None:
    """B14-18, B14-31: the visitor has the pass without the event. The visit shows the failure as its
    invitation's, under Needs attention, saying that it is the calendar invitation's
    (`invitation.calendar_failed`), and the host's resend sends the calendar invitation alone again: the
    same version of the event, a new DTSTAMP, no new pass (`pass_url` null) and no new invitation. A
    host's e-mail that fails stays in the e-mail log only."""
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    first_calendar = next(email for email in email_provider.sent if email.kind == "VISITOR_CALENDAR")
    for kind, error in (("HOST_VISIT_SCHEDULED", "Host refused."), ("VISITOR_CALENDAR", "Calendar refused.")):
        db.execute(
            update(EmailMessage)
            .where(EmailMessage.visit_id == visit_id, EmailMessage.kind == kind)
            .values(status="FAILED", sent_at=None, last_error=error)
        )
    db.commit()
    visit = host.get(f"/visits/{visit_id}").json()
    assert (visit["invitation"]["status"], visit["invitation"]["error"]) == ("FAILED", "Calendar refused.")
    assert visit["invitation"]["calendar_failed"] is True and visit["visitor_calendar_sent"] is True
    attention = host.get("/visits", params={"needs_attention": "true"}).json()["items"]
    assert [item["id"] for item in attention] == [visit_id]
    assert attention[0]["invitation"]["calendar_failed"] is True
    assert host.get("/dashboard/employee").json()["counts"]["needs_attention"] == 1

    email_provider.clear()
    clock.advance(minutes=5)
    resent = host.post(f"/visits/{visit_id}/invitation")
    assert resent.status_code == 200 and resent.json()["pass_url"] is None
    [calendar] = email_provider.sent
    assert calendar.kind == "VISITOR_CALENDAR" and calendar.to == first_calendar.to
    method, event = _event(calendar)
    _, first_event = _event(first_calendar)
    assert (method, event["UID"], event["SEQUENCE"]) == (
        "REQUEST",
        first_event["UID"],
        first_event["SEQUENCE"],
    )
    assert event.decoded("DTSTAMP") > first_event.decoded("DTSTAMP")
    # The pass the visitor has stays valid: nothing was revoked or issued.
    [visitor_pass] = db.scalars(select(VisitorPass).where(VisitorPass.visit_id == visit_id)).all()
    assert visitor_pass.revoked_at is None
    assert visitor_pass.token_hash == hash_token(pass_token(created["pass_url"]))
    queued = audit_rows(db, "INVITATION_QUEUED", entity_id=visit_id)[-1].meta
    assert queued["pass_id"] is None and queued["calendar_sent"] is True
    assert queued["email_message_id"] == str(calendar.message_id)
    visit = host.get(f"/visits/{visit_id}").json()
    assert visit["invitation"]["status"] == "SENT" and visit["invitation"]["error"] is None
    assert visit["invitation"]["calendar_failed"] is False
    assert host.get("/visits", params={"needs_attention": "true"}).json()["items"] == []
    # Now that the calendar invitation went out, a resend is a resend again: a new pass.
    again = host.post(f"/visits/{visit_id}/invitation").json()
    assert again["pass_url"] is not None


@pytest.mark.parametrize("calendar", ["SENT", "FAILED"])
def test_a_failed_invitation_is_the_invitation_s_failure_whatever_its_calendar_invitation_did(
    host: Api, world: World, db: Session, calendar: str
) -> None:
    """B14-18: when the invitation itself failed, the visit shows its failure, not the calendar
    invitation's (`calendar_failed` false): the visitor has no pass."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    for kind, status, error in (
        ("VISITOR_INVITATION", "FAILED", "Invitation refused."),
        ("VISITOR_CALENDAR", calendar, "Calendar refused."),
    ):
        if status == "FAILED":
            db.execute(
                update(EmailMessage)
                .where(EmailMessage.visit_id == visit_id, EmailMessage.kind == kind)
                .values(status="FAILED", sent_at=None, last_error=error)
            )
    db.commit()
    invitation = host.get(f"/visits/{visit_id}").json()["invitation"]
    assert (invitation["status"], invitation["error"]) == ("FAILED", "Invitation refused.")
    assert invitation["calendar_failed"] is False
    attention = host.get("/visits", params={"needs_attention": "true"}).json()["items"]
    assert [item["id"] for item in attention] == [visit_id]
    assert host.post(f"/visits/{visit_id}/invitation").status_code == 200
    invitation = host.get(f"/visits/{visit_id}").json()["invitation"]
    assert (invitation["status"], invitation["calendar_failed"]) == ("SENT", False)


def test_a_failed_calendar_invitation_of_an_earlier_invitation_is_not_the_visit_s(
    app: FastAPI, host: Api, world: World, db: Session
) -> None:
    """B14-18: what a visit shows is its latest invitation and the calendar invitation that followed it.
    A resend (here of a failed invitation) whose calendar invitation the company's budget leaves out (its
    audit row says so) is shown as the resend went, not with the earlier calendar invitation's failure."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    db.execute(
        update(EmailMessage)
        .where(
            EmailMessage.visit_id == visit_id,
            EmailMessage.kind.in_(["VISITOR_INVITATION", "VISITOR_CALENDAR"]),
        )
        .values(status="FAILED", sent_at=None, last_error="Refused.")
    )
    db.commit()
    with rate_limits(app, calendar_emails_per_company_day=2):  # spent by the calendar and the host's
        assert host.post(f"/visits/{visit_id}/invitation").status_code == 200
    visit = host.get(f"/visits/{visit_id}").json()
    assert visit["invitation"]["status"] == "SENT" and visit["visitor_calendar_sent"] is True
    assert visit["invitation"]["calendar_failed"] is False
    assert host.get("/visits", params={"needs_attention": "true"}).json()["items"] == []
    assert audit_rows(db, "INVITATION_QUEUED", entity_id=visit_id)[-1].meta["calendar_sent"] is False


def test_a_calendar_that_has_the_visit_loses_it_even_after_a_resend_without_one(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-16: a resend whose calendar invitation the company's budget leaves out sends the pass again;
    the visitor's calendar still has the visit from the first calendar invitation, so its cancellation
    still goes, whatever `notify_visitor` says."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    email_provider.clear()
    with rate_limits(app, calendar_emails_per_company_day=2):  # spent by the calendar and the host's
        assert host.post(f"/visits/{visit_id}/invitation").status_code == 200
        assert _kinds(email_provider) == ["VISITOR_INVITATION"]
        visit = host.get(f"/visits/{visit_id}").json()
        assert visit["visitor_calendar_sent"] is True and visit["invitation"]["status"] == "SENT"
        email_provider.clear()
        assert host.post(f"/visits/{visit_id}/cancel", json={"notify_visitor": False}).status_code == 200
    # Both calendars lose the visit: a removal is never left out (B14-28).
    assert _calendars(email_provider) == [("VISIT_CANCELLED", "CANCEL"), ("HOST_VISIT_CANCELLED", "CANCEL")]
    queued = audit_rows(db, "INVITATION_QUEUED", entity_id=visit_id)[-1].meta
    assert queued["calendar_sent"] is False
    assert queued["notice_limited_by"] == "calendar_emails_per_company_day"
