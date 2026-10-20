"""Which calendars hold a visit's event, and what they are sent (Phase 14 after its verification, B14-26 to
B14-33), through the API.

Every e-mail records the iTIP method of the event it carried (`email_messages.calendar_method`), so a
calendar that holds the visit is known whichever e-mail put it there: a calendar invitation or a notice
of a new time (B14-26). The switch that keeps new calendar entries from being made while the calendars
that hold a visit are still kept right (B14-27); the company's calendar events, beyond which a notice
goes without its event (B14-28); an address change that leaves no REQUEST waiting for the old address
(B14-29) and none for another spelling of the same mailbox, with the new address's event newer than the
withdrawal (B14-30); the calendar invitation sent again alone (B14-31); a cancellation the visitor was not
to be told of, which carries no reason (B14-32). The verification's probes are among them."""

from datetime import timedelta

import icalendar
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.dispatcher import ADDRESS_CHANGED_ERROR
from app.email.providers.base import OutgoingEmail
from app.email.providers.memory import MemoryProvider
from app.email.service import DeliveryJob
from app.models import EmailMessage, Role
from tests.conftest import TEST_START
from tests.support import Api, Factory, World, audit_rows, create_visit, error_code, rate_limits, signed_in

START = TEST_START + timedelta(hours=1)  # 10:00 in Asia/Amman
COMPANY_BUDGET = "calendar_emails_per_company_day"


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def calendars_off(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    """CALENDAR_INVITATIONS_ENABLED=false (B14-27)."""
    monkeypatch.setattr(app.state.service_environment.settings, "calendar_invitations_enabled", False)


def _sent(provider: MemoryProvider) -> list[tuple[str, str, str | None, int | None]]:
    """Each e-mail's kind, recipient, and the method and version of the event it carries."""
    return [
        (
            email.kind.value,
            email.to,
            email.calendar.method if email.calendar else None,
            email.calendar.sequence if email.calendar else None,
        )
        for email in provider.sent
    ]


def _event(email: OutgoingEmail) -> icalendar.Event:
    assert email.calendar is not None
    [event] = icalendar.Calendar.from_ical(email.calendar.content).walk("VEVENT")
    return event


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


def _next_day(app: FastAPI) -> None:
    """The budgets' day is over: every slot is free again."""
    app.state.service_environment.limiter.reset()


# ---- B14-27: the calendar switch -------------------------------------------------------------------------


@pytest.mark.usefixtures("calendars_off")
def test_with_calendar_invitations_off_no_calendar_gets_a_new_entry(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """Off: no calendar invitation, no host's notice of a new visit, no event attached for a calendar that
    does not hold the visit. The visitor is told as before; the two flags keep their meaning (false)."""
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    assert _sent(email_provider) == [("VISITOR_INVITATION", email_provider.sent[0].to, None, None)]
    assert created["visitor_calendar_sent"] is False and created["invitation"]["calendar_failed"] is False
    queued = audit_rows(db, "INVITATION_QUEUED", entity_id=created["id"])[-1].meta
    assert queued["calendar_sent"] is False and queued["notice_limited_by"] is None
    made = audit_rows(db, "VISIT_CREATED", entity_id=created["id"])[-1].meta
    assert made["host_notified"] is False and made["host_notice_limited_by"] is None
    email_provider.clear()
    moved = _reschedule(host, created["id"], 2)
    assert [(kind, method) for kind, _, method, _ in _sent(email_provider)] == [("VISIT_RESCHEDULED", None)]
    meta = audit_rows(db, "VISIT_RESCHEDULED", entity_id=created["id"])[-1].meta
    assert (meta["visitor_notified"], meta["calendar_sent"], meta["notice_limited_by"]) == (True, False, None)
    assert moved["visitor_calendar_sent"] is False and moved["calendar_sequence"] == 1
    email_provider.clear()
    assert host.post(f"/visits/{created['id']}/cancel", json={"notify_visitor": True}).status_code == 200
    assert [(kind, method) for kind, _, method, _ in _sent(email_provider)] == [("VISIT_CANCELLED", None)]
    # Not told: nothing at all, the calendar never had it.
    other = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    email_provider.clear()
    assert host.post(f"/visits/{other['id']}/cancel", json={"notify_visitor": False}).status_code == 200
    assert email_provider.sent == []


def test_switching_calendar_invitations_off_keeps_the_entries_already_made_right(
    app: FastAPI,
    host: Api,
    world: World,
    db: Session,
    email_provider: MemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Off after events went out: the calendars that hold a visit still get its new time and its removal,
    the visitor's and the host's; an address change still takes the event out of the old address's
    calendar, and the new address, which has no entry, gets none; a new visit gets none."""
    person = {"full_name": "Kept Guest", "email": "kept@example.com"}
    first = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)["visit"]
    second = create_visit(host, world.a.employee.id, START + timedelta(days=1), send_invitation=True)["visit"]
    monkeypatch.setattr(app.state.service_environment.settings, "calendar_invitations_enabled", False)
    email_provider.clear()
    _reschedule(host, first["id"], 2)
    assert [(kind, method, sequence) for kind, _, method, sequence in _sent(email_provider)] == [
        ("VISIT_RESCHEDULED", "REQUEST", 1),
        ("HOST_VISIT_RESCHEDULED", "REQUEST", 1),
    ]
    email_provider.clear()
    visitor_id = first["visitor"]["id"]
    assert host.patch(f"/visitors/{visitor_id}", json={"email": "moved@example.com"}).status_code == 200
    assert [(kind, to, method) for kind, to, method, _ in _sent(email_provider)] == [
        ("VISITOR_CALENDAR", "kept@example.com", "CANCEL"),
        ("VISITOR_INVITATION", "moved@example.com", None),
    ]
    assert host.get(f"/visits/{first['id']}").json()["visitor_calendar_sent"] is False
    email_provider.clear()
    assert host.post(f"/visits/{second['id']}/cancel", json={"notify_visitor": False}).status_code == 200
    assert [(kind, method) for kind, _, method, _ in _sent(email_provider)] == [
        ("VISIT_CANCELLED", "CANCEL"),
        ("HOST_VISIT_CANCELLED", "CANCEL"),
    ]
    email_provider.clear()
    create_visit(host, world.a.employee.id, START, send_invitation=True)
    assert [kind for kind, *_ in _sent(email_provider)] == ["VISITOR_INVITATION"]


# ---- B14-26: an event a notice of a new time put in the calendar (the verification's M1 and M2) ---------


def test_an_event_a_notice_of_a_new_time_put_in_the_calendar_leaves_it_at_the_cancellation(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """The calendar invitation was left out by the company's budget; the next day a new time sends the
    visitor a REQUEST, which puts the visit in the calendar. Its cancellation then goes whatever
    `notify_visitor` says (B14-16)."""
    with rate_limits(app, calendar_emails_per_company_day=1):  # the host's notice takes the one slot
        visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    assert [kind for kind, *_ in _sent(email_provider)] == ["VISITOR_INVITATION", "HOST_VISIT_SCHEDULED"]
    assert visit["visitor_calendar_sent"] is False
    _next_day(app)
    email_provider.clear()
    moved = _reschedule(host, visit["id"], 2)
    assert _sent(email_provider)[0][2:] == ("REQUEST", 1)
    assert moved["visitor_calendar_sent"] is True
    email_provider.clear()
    assert host.post(f"/visits/{visit['id']}/cancel", json={"notify_visitor": False}).status_code == 200
    assert [(kind, method) for kind, _, method, _ in _sent(email_provider)] == [
        ("VISIT_CANCELLED", "CANCEL"),
        ("HOST_VISIT_CANCELLED", "CANCEL"),
    ]
    assert audit_rows(db, "VISIT_CANCELLED", entity_id=visit["id"])[-1].meta["visitor_notified"] is True


def test_a_visit_booked_before_the_calendars_and_rescheduled_leaves_the_calendar(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """Its log has no calendar invitation (as a visit booked before Phase 14); a new time after the
    release sends the visitor a REQUEST, so its cancellation goes whatever `notify_visitor` says."""
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.visit_id == visit["id"], EmailMessage.kind == "VISITOR_CALENDAR")
        .values(kind="HOST_ARRIVAL", calendar_method=None)
    )
    db.commit()
    assert host.get(f"/visits/{visit['id']}").json()["visitor_calendar_sent"] is False
    _reschedule(host, visit["id"], 2)
    email_provider.clear()
    assert host.post(f"/visits/{visit['id']}/cancel", json={"notify_visitor": False}).status_code == 200
    assert ("VISIT_CANCELLED", "CANCEL") in [(kind, method) for kind, _, method, _ in _sent(email_provider)]


def test_an_old_address_that_got_the_event_by_a_notice_of_a_new_time_loses_it(
    app: FastAPI, host: Api, world: World, email_provider: MemoryProvider
) -> None:
    person = {"full_name": "Moving Guest", "email": "old-m2@example.com"}
    with rate_limits(app, calendar_emails_per_company_day=1):
        created = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)
    visit_id, visitor_id = created["visit"]["id"], created["visit"]["visitor"]["id"]
    _next_day(app)
    _reschedule(host, visit_id, 2)  # REQUEST, version 1, to old-m2@example.com
    email_provider.clear()
    assert host.patch(f"/visitors/{visitor_id}", json={"email": "new-m2@example.com"}).status_code == 200
    assert _sent(email_provider) == [
        ("VISITOR_CALENDAR", "old-m2@example.com", "CANCEL", 2),
        ("VISITOR_INVITATION", "new-m2@example.com", None, None),
        ("VISITOR_CALENDAR", "new-m2@example.com", "REQUEST", 3),  # newer than the withdrawal (B14-30)
    ]


def test_a_failed_calendar_invitation_is_put_right_by_a_later_request(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-18 after the verification: once a later REQUEST to the same address went out, the calendar
    holds the visit and the invitation no longer shows the calendar invitation's failure; a later REQUEST
    that fails too leaves it shown."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.visit_id == visit_id, EmailMessage.kind == "VISITOR_CALENDAR")
        .values(status="FAILED", sent_at=None, last_error="Calendar refused.")
    )
    db.commit()
    assert host.get(f"/visits/{visit_id}").json()["invitation"]["calendar_failed"] is True
    _reschedule(host, visit_id, 2)  # delivered: SENT
    visit = host.get(f"/visits/{visit_id}").json()
    assert visit["invitation"]["status"] == "SENT" and visit["invitation"]["calendar_failed"] is False
    assert host.get("/visits", params={"needs_attention": "true"}).json()["items"] == []
    # A REQUEST that fails as well does not put it right.
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.visit_id == visit_id, EmailMessage.kind == "VISIT_RESCHEDULED")
        .values(status="FAILED", sent_at=None, last_error="Refused.")
    )
    db.commit()
    assert host.get(f"/visits/{visit_id}").json()["invitation"]["calendar_failed"] is True
    attention = host.get("/visits", params={"needs_attention": "true"}).json()["items"]
    assert [item["id"] for item in attention] == [visit_id]


# ---- B14-29, B14-30: an address change ------------------------------------------------------------------


def test_a_request_still_waiting_for_the_old_address_is_not_sent_after_the_change(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """The host corrects a mistyped address seconds after booking, while the calendar invitation to the
    wrong one still waits for a delivery slot (PENDING). It is closed with the change, so its delivery,
    when the slot comes, sends nothing after the withdrawal."""
    person = {"full_name": "Typo Guest", "email": "typo@example.com"}
    created = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)
    visit_id, visitor_id = created["visit"]["id"], created["visit"]["visitor"]["id"]
    first_calendar = next(email for email in email_provider.sent if email.kind == "VISITOR_CALENDAR")
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.visit_id == visit_id, EmailMessage.to_email == "typo@example.com")
        .values(status="PENDING", sent_at=None, attempts=0)
    )
    db.commit()
    email_provider.clear()
    assert host.patch(f"/visitors/{visitor_id}", json={"email": "right@example.com"}).status_code == 200
    assert _sent(email_provider)[0] == ("VISITOR_CALENDAR", "typo@example.com", "CANCEL", 1)
    db.expire_all()
    closed = db.execute(
        select(EmailMessage.status, EmailMessage.last_error).where(
            EmailMessage.id == first_calendar.message_id
        )
    ).one()
    assert tuple(closed) == ("FAILED", ADDRESS_CHANGED_ERROR)
    email_provider.clear()
    status = app.state.email_dispatcher.deliver(
        DeliveryJob(message_id=first_calendar.message_id, email=first_calendar)
    )
    assert status is None and email_provider.sent == []


def test_another_spelling_of_the_same_mailbox_keeps_the_event(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    """dana.guest@gmail.com and danaguest@gmail.com are one mailbox (B14-21): no withdrawal, which could
    take the visit out of the very calendar the new spelling's invitation updates (B14-30)."""
    person = {"full_name": "Dana Guest", "email": "dana.guest@gmail.com"}
    created = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)
    email_provider.clear()
    visitor_id = created["visit"]["visitor"]["id"]
    assert host.patch(f"/visitors/{visitor_id}", json={"email": "danaguest@gmail.com"}).status_code == 200
    assert _sent(email_provider) == [
        ("VISITOR_INVITATION", "danaguest@gmail.com", None, None),
        ("VISITOR_CALENDAR", "danaguest@gmail.com", "REQUEST", 0),
    ]
    visit = host.get(f"/visits/{created['visit']['id']}").json()
    assert visit["calendar_sequence"] == 0 and visit["visitor_calendar_sent"] is True


def test_each_calendar_is_sent_newer_versions_only(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    """New times, two address changes back to the first address, a removed address and a cancellation:
    every address is sent the visit's versions in order, never an older one after a newer one."""
    person = {"full_name": "Round Trip", "email": "a-rt@example.com"}
    created = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)
    visit_id, visitor_id = created["visit"]["id"], created["visit"]["visitor"]["id"]
    _reschedule(host, visit_id, 2)
    assert host.patch(f"/visitors/{visitor_id}", json={"email": "b-rt@example.com"}).status_code == 200
    _reschedule(host, visit_id, 3)
    assert host.patch(f"/visitors/{visitor_id}", json={"email": "a-rt@example.com"}).status_code == 200
    assert host.patch(f"/visitors/{visitor_id}", json={"email": None}).status_code == 200
    assert host.post(f"/visits/{visit_id}/cancel", json={"notify_visitor": False}).status_code == 200
    versions: dict[str, list[tuple[str, int]]] = {}
    for kind, to, method, sequence in _sent(email_provider):
        if method is not None and sequence is not None and not kind.startswith("HOST_"):
            versions.setdefault(to, []).append((method, sequence))
    assert versions == {
        "a-rt@example.com": [("REQUEST", 0), ("REQUEST", 1), ("CANCEL", 2), ("REQUEST", 6), ("CANCEL", 7)],
        "b-rt@example.com": [("REQUEST", 3), ("REQUEST", 4), ("CANCEL", 5)],
    }


# ---- B14-32: a cancellation the visitor was not to be told of -------------------------------------------


def test_a_cancellation_the_visitor_was_not_to_be_told_of_carries_no_reason(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    other = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    reason = "Internal: flagged by security, do not tell the visitor"
    email_provider.clear()
    assert (
        host.post(
            f"/visits/{visit['id']}/cancel", json={"notify_visitor": False, "reason": reason}
        ).status_code
        == 200
    )
    [cancelled] = [email for email in email_provider.sent if email.kind == "VISIT_CANCELLED"]
    assert reason not in cancelled.text + cancelled.html and cancelled.calendar is not None
    [host_notice] = [email for email in email_provider.sent if email.kind == "HOST_VISIT_CANCELLED"]
    assert reason in host_notice.text  # the host is told why, as before
    email_provider.clear()
    assert (
        host.post(
            f"/visits/{other['id']}/cancel", json={"notify_visitor": True, "reason": reason}
        ).status_code
        == 200
    )
    [told] = [email for email in email_provider.sent if email.kind == "VISIT_CANCELLED"]
    assert reason in told.text


# ---- B14-15, B14-28: the budgets -------------------------------------------------------------------------


def test_one_user_s_host_notices_do_not_silence_another_visitor_s_notice_of_a_new_time(
    app: FastAPI, make_client, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """The verification's probe: an employee's host notices spend the company's calendar events; the
    administrator then moves an invited visit of another host. The visitor is still told of the new
    time, without its event (B14-28)."""
    employee = signed_in(make_client, world.a.employee)
    admin = signed_in(make_client, world.a.admin)
    invited = create_visit(admin, world.a.admin.id, START + timedelta(days=1), send_invitation=True)["visit"]
    _next_day(app)
    email_provider.clear()
    with rate_limits(app, calendar_emails_per_company_day=4, host_visit_notices_per_user_day=4):
        for hour in range(2):
            visit_id = create_visit(employee, world.a.employee.id, START + timedelta(hours=hour))["visit"][
                "id"
            ]
            assert employee.post(f"/visits/{visit_id}/cancel", json={}).status_code == 200
        start = START + timedelta(days=1, hours=3)
        moved = admin.patch(
            f"/visits/{invited['id']}",
            json={
                "scheduled_start": start.isoformat(),
                "scheduled_end": (start + timedelta(hours=1)).isoformat(),
            },
        )
    assert moved.status_code == 200
    meta = audit_rows(db, "VISIT_RESCHEDULED", entity_id=invited["id"])[-1].meta
    assert (meta["visitor_notified"], meta["calendar_sent"], meta["notice_limited_by"]) == (
        True,
        False,
        COMPANY_BUDGET,
    )
    [notice] = [email for email in email_provider.sent if email.kind == "VISIT_RESCHEDULED"]
    assert notice.calendar is None


def test_a_deactivation_beyond_the_budget_still_removes_every_visitor_event(
    app: FastAPI, make_client, world: World, factory: Factory, db: Session, email_provider: MemoryProvider
) -> None:
    host_user = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Busy Host")
    api = signed_in(make_client, host_user)
    visit_ids = [
        create_visit(api, host_user.id, START + timedelta(days=day), send_invitation=True)["visit"]["id"]
        for day in range(4)
    ]
    _next_day(app)
    email_provider.clear()
    admin = signed_in(make_client, world.a.admin)
    with rate_limits(app, calendar_emails_per_company_day=3, host_visit_notices_per_user_day=10):
        assert admin.patch(f"/users/{host_user.id}", json={"is_active": False}).status_code == 200
    sent = _sent(email_provider)
    assert (
        sorted((kind, method) for kind, _, method, _ in sent)
        == [("HOST_VISIT_CANCELLED", "CANCEL")] * 4 + [("VISIT_CANCELLED", "CANCEL")] * 4
    )
    assert all(
        audit_rows(db, "VISIT_CANCELLED", entity_id=visit_id)[-1].meta["visitor_notified"]
        for visit_id in visit_ids
    )


def test_in_a_new_visit_the_host_s_notice_is_reserved_before_the_calendar_invitation(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-15: with one calendar event left in the company's day, the host's notice of the new visit takes
    it, and the visitor's calendar invitation is left out (the invitation itself goes)."""
    create_visit(host, world.a.employee.id, START)  # the host's notice: one event
    email_provider.clear()
    with rate_limits(app, calendar_emails_per_company_day=2):
        visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    assert [(kind, method) for kind, _, method, _ in _sent(email_provider)] == [
        ("VISITOR_INVITATION", None),
        ("HOST_VISIT_SCHEDULED", "REQUEST"),
    ]
    queued = audit_rows(db, "INVITATION_QUEUED", entity_id=visit["id"])[-1].meta
    assert queued["calendar_sent"] is False and queued["notice_limited_by"] == COMPANY_BUDGET


def test_a_withdrawal_is_never_refused(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B14-17: with the editor's invitations and the company's calendar events spent, an address change
    still takes the event out of the old address's calendar (its re-invitation keeps its own budget, so
    one is left for it here), and a removed address does too."""
    person = {"full_name": "Spent Guest", "email": "spent-old@example.com"}
    first = create_visit(host, world.a.employee.id, START, visitor=person, send_invitation=True)["visit"]
    second_person = {"full_name": "Cleared Guest", "email": "cleared@example.com"}
    second = create_visit(host, world.a.employee.id, START, visitor=second_person, send_invitation=True)[
        "visit"
    ]
    email_provider.clear()
    # Two invitations and four calendar events spent: the next invitation is the last one.
    with rate_limits(app, invitations_per_user_day=3, calendar_emails_per_company_day=4):
        moved = host.patch(f"/visitors/{first['visitor']['id']}", json={"email": "spent-new@example.com"})
        cleared = host.patch(f"/visitors/{second['visitor']['id']}", json={"email": None})
    assert moved.status_code == 200 and cleared.status_code == 200
    assert _sent(email_provider) == [
        ("VISITOR_CALENDAR", "spent-old@example.com", "CANCEL", 1),
        ("VISITOR_INVITATION", "spent-new@example.com", None, None),  # its calendar invitation: no room
        ("VISITOR_CALENDAR", "cleared@example.com", "CANCEL", 1),
    ]
    queued = audit_rows(db, "INVITATION_QUEUED", entity_id=first["id"])[-1].meta
    assert queued["calendar_sent"] is False and queued["notice_limited_by"] == COMPANY_BUDGET


# ---- B14-31: the calendar invitation sent again alone ----------------------------------------------------


def test_the_calendar_invitation_alone_is_sent_again_within_its_budgets(
    app: FastAPI, host: Api, world: World, db: Session, email_provider: MemoryProvider, clock: FakeClock
) -> None:
    """When only the calendar invitation failed, the resend sends it alone, counted in the visit's
    resends, the user's invitations and the company's calendar events, all or none: 429 INVITATION_LIMIT
    beyond them, and nothing sent. With calendar invitations off it is still sent (the calendar was sent
    the visit while they were on, B14-27)."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.visit_id == visit_id, EmailMessage.kind == "VISITOR_CALENDAR")
        .values(status="FAILED", sent_at=None, last_error="Calendar refused.")
    )
    db.commit()
    email_provider.clear()
    with rate_limits(app, calendar_emails_per_company_day=2):  # the calendar invitation and the host's
        refused = host.post(f"/visits/{visit_id}/invitation")
    assert refused.status_code == 429 and error_code(refused) == "INVITATION_LIMIT"
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == COMPANY_BUDGET
    assert email_provider.sent == []
    assert host.get(f"/visits/{visit_id}").json()["invitation"]["calendar_failed"] is True
    _next_day(app)
    app.state.service_environment.settings.calendar_invitations_enabled = False
    try:
        clock.advance(minutes=1)
        resent = host.post(f"/visits/{visit_id}/invitation")
    finally:
        app.state.service_environment.settings.calendar_invitations_enabled = True
    assert resent.status_code == 200 and resent.json()["pass_url"] is None
    assert [(kind, method) for kind, _, method, _ in _sent(email_provider)] == [
        ("VISITOR_CALENDAR", "REQUEST")
    ]
