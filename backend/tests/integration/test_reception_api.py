"""GET /reception/today, GET /reception/inside and POST /reception/walk-ins (contract §8, §8.1
`ReceptionToday`, `WalkInCreate`; D-07): company-local day bounds, exact counts with capped lists, the
stale/overdue flags on the fake clock, and walk-in registration with its refusals and audit rows."""

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import Role, Visit, Visitor
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    error_code,
    pass_token,
    refreshed,
    signed_in,
    visit_body,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)  # 07:00-08:00Z (10:00-11:00 Amman), window 06:00-09:00Z
EXPECTED_END = TEST_START + timedelta(hours=2)


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


def _guest(name: str) -> dict:
    return {"full_name": name, "email": f"{name.lower().replace(' ', '.')}@example.com"}


def _ids(items: list[dict]) -> list[str]:
    return [item["id"] for item in items]


# ---- today ----------------------------------------------------------------------------------------


def test_today_lists_and_counts_the_company_local_day(world: World, clock: FakeClock, make_client) -> None:
    # Yesterday (5 October in Amman): a visitor who never checked out, and a visit that was missed.
    yesterday_host = signed_in(make_client, world.a.employee)
    left_over = create_visit(yesterday_host, world.a.employee.id, START, visitor=_guest("Left Over"))
    create_visit(yesterday_host, world.a.employee.id, START + timedelta(hours=1), visitor=_guest("Missed"))
    assert check_in(signed_in(make_client, world.a.receptionist), left_over["visit"]["id"]).status_code == 200

    morning = datetime(2026, 10, 6, 6, 0, tzinfo=UTC)  # 6 October, 09:00 in Amman
    clock.set(morning)
    host = signed_in(make_client, world.a.employee)
    reception = signed_in(make_client, world.a.receptionist)
    at_ten = morning + timedelta(hours=1)
    expected_early = create_visit(host, world.a.employee.id, at_ten, visitor=_guest("Early Guest"))
    expected_late = create_visit(
        host, world.a.employee.id, at_ten + timedelta(hours=8), visitor=_guest("Late Guest")
    )
    inside = create_visit(host, world.a.employee.id, at_ten, visitor=_guest("Inside Guest"))
    gone = create_visit(host, world.a.employee.id, at_ten, visitor=_guest("Gone Guest"))
    cancelled = create_visit(host, world.a.employee.id, at_ten, visitor=_guest("Cancelled Guest"))
    no_show = create_visit(
        host, world.a.employee.id, morning + timedelta(minutes=5), visitor=_guest("No Show")
    )
    tomorrow = create_visit(
        host, world.a.employee.id, at_ten + timedelta(days=1), visitor=_guest("Tomorrow Guest")
    )
    host.post(f"/visits/{cancelled['visit']['id']}/cancel", json={})
    assert check_in(reception, inside["visit"]["id"]).status_code == 200
    assert check_in(reception, gone["visit"]["id"]).status_code == 200
    assert check_out(reception, gone["visit"]["id"]).status_code == 200
    walk_in = reception.post(
        "/reception/walk-ins", json=walk_in_body(world.a.employee.id, morning + timedelta(hours=4))
    )
    assert walk_in.status_code == 201
    clock.set(morning + timedelta(hours=2, minutes=10))  # 11:10: the 09:05 visit's window has ended
    reception = signed_in(make_client, world.a.receptionist)

    response = reception.get("/reception/today")
    assert response.status_code == 200, response.text
    today = response.json()
    assert today["date"] == "2026-10-06"
    assert today["counts"] == {
        "expected": 2,  # still SCHEDULED; the missed ones are no-shows, tomorrow's is not today's
        "inside": 3,  # yesterday's left-over, today's visitor and the walk-in
        "checked_out": 1,
        "no_show": 1,  # today's only: yesterday's missed visit belongs to yesterday
        "cancelled": 1,
        "walk_ins": 1,
    }
    assert _ids(today["expected"]) == [expected_early["visit"]["id"], expected_late["visit"]["id"]]
    assert set(_ids(today["inside"])) == {
        left_over["visit"]["id"],
        inside["visit"]["id"],
        walk_in.json()["id"],
    }
    assert _ids(today["inside"])[0] == left_over["visit"]["id"]  # earliest check-in first
    assert _ids(today["checked_out"]) == [gone["visit"]["id"]]
    assert _ids(today["no_show"]) == [no_show["visit"]["id"]]
    assert tomorrow["visit"]["id"] not in str(today)
    flags = {item["id"]: (item["is_stale"], item["is_overdue"]) for item in today["inside"]}
    assert flags[left_over["visit"]["id"]] == (True, True)
    assert flags[inside["visit"]["id"]] == (False, True)  # past its 11:00 end
    assert flags[walk_in.json()["id"]] == (False, False)


def test_a_visit_still_in_its_window_after_midnight_is_still_expected(
    host: Api, world: World, clock: FakeClock, make_client
) -> None:
    late = create_visit(
        host, world.a.employee.id, datetime(2026, 10, 5, 20, 15, tzinfo=UTC), minutes=30
    )  # 23:15
    clock.set(datetime(2026, 10, 5, 21, 20, tzinfo=UTC))  # 00:20 the next day; the window ends at 21:45Z
    today = signed_in(make_client, world.a.receptionist).get("/reception/today").json()
    assert today["date"] == "2026-10-06"
    assert _ids(today["expected"]) == [late["visit"]["id"]] and today["counts"]["expected"] == 1


def test_lists_are_capped_and_counts_exact(
    reception: Api, world: World, factory: Factory, db: Session
) -> None:
    visitor = Visitor(
        company_id=world.a.company.id,
        full_name="Bulk Guest",
        search_text="bulk guest",
        name_sort="bulk guest",
    )
    db.add(visitor)
    db.flush()
    db.add_all(
        Visit(
            company_id=world.a.company.id,
            visitor_id=visitor.id,
            host_id=world.a.employee.id,
            created_by_id=world.a.employee.id,
            purpose="Bulk",
            scheduled_start=START + timedelta(minutes=minute),
            scheduled_end=START + timedelta(minutes=minute + 30),
            window_start=START + timedelta(minutes=minute - 60),
            window_end=START + timedelta(minutes=minute + 90),
            status="SCHEDULED",
            visitor_name="Bulk Guest",
            host_name="Alpha Employee",
        )
        for minute in range(205)
    )
    db.commit()
    today = reception.get("/reception/today").json()
    assert today["counts"]["expected"] == 205 and len(today["expected"]) == 200


def test_today_is_for_reception_and_administrators(make_client, world: World) -> None:
    assert signed_in(make_client, world.a.admin).get("/reception/today").status_code == 200
    for user in (world.a.employee, world.a.manager):
        response = signed_in(make_client, user).get("/reception/today")
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"


# ---- inside ---------------------------------------------------------------------------------------


def test_inside_flags_overdue_and_stale_on_the_clock(
    host: Api, world: World, clock: FakeClock, make_client
) -> None:
    created = create_visit(
        host, world.a.employee.id, datetime(2026, 10, 5, 20, 30, tzinfo=UTC)
    )  # 23:30-00:30
    clock.set(datetime(2026, 10, 5, 20, 40, tzinfo=UTC))
    assert check_in(signed_in(make_client, world.a.receptionist), created["visit"]["id"]).status_code == 200

    def flags(at: datetime) -> tuple[bool, bool]:
        clock.set(at)
        body = signed_in(make_client, world.a.manager).get("/reception/inside").json()
        assert body["count"] == len(body["items"]) == 1
        item = body["items"][0]
        return item["is_stale"], item["is_overdue"]

    assert flags(datetime(2026, 10, 5, 20, 59, 59, tzinfo=UTC)) == (False, False)  # 23:59:59 local
    assert flags(datetime(2026, 10, 5, 21, 0, 1, tzinfo=UTC)) == (True, False)  # just after midnight
    assert flags(datetime(2026, 10, 5, 21, 30, 1, tzinfo=UTC)) == (True, True)  # past the 00:30 end


def test_inside_is_never_capped_and_is_company_scoped(
    reception: Api, world: World, make_client, db: Session
) -> None:
    for index in range(3):
        response = reception.post(
            "/reception/walk-ins",
            json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor={"full_name": f"Walker {index}"}),
        )
        assert response.status_code == 201
    other = signed_in(make_client, world.b.receptionist).post(
        "/reception/walk-ins", json=walk_in_body(world.b.employee.id, EXPECTED_END)
    )
    assert other.status_code == 201
    body = signed_in(make_client, world.a.manager).get("/reception/inside").json()
    assert body["count"] == 3 and other.json()["id"] not in _ids(body["items"])


def test_the_evacuation_list_gives_each_visitors_current_phone(
    reception: Api, host: Api, world: World, make_client
) -> None:
    """B57-72: at the assembly point staff must be able to call a missing visitor, not only the host. The
    number is the visitor record's current one (like the host's), so a number added after check-in shows;
    the rest of the visitor stays the visit's snapshot (D-17). Only the evacuation list carries it."""
    walk_in = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            EXPECTED_END,
            visitor={"full_name": "Phone Walker", "phone": "+962 79 222 3333"},
        ),
    )
    assert walk_in.status_code == 201, walk_in.text
    invited = create_visit(host, world.a.employee.id, START, visitor=_guest("No Phone Yet"))
    assert check_in(reception, invited["visit"]["id"]).status_code == 200
    visitor_id = invited["visit"]["visitor"]["id"]
    assert reception.patch(f"/visitors/{visitor_id}", json={"phone": "+962 77 444 5555"}).status_code == 200

    for user in (world.a.receptionist, world.a.manager, world.a.admin):
        body = signed_in(make_client, user).get("/reception/inside").json()
        visitors = {item["id"]: item["visitor"] for item in body["items"]}
        assert visitors == {
            walk_in.json()["id"]: {
                "id": walk_in.json()["visitor"]["id"],
                "full_name": "Phone Walker",
                "company_name": None,
                "phone": "+962 79 222 3333",
            },
            invited["visit"]["id"]: {
                "id": visitor_id,
                "full_name": "No Phone Yet",
                "company_name": None,
                "phone": "+962 77 444 5555",
            },
        }
    # Other visit responses keep §8.1's visitor snapshot.
    today = reception.get("/reception/today").json()
    assert all("phone" not in item["visitor"] for item in today["inside"])
    assert "phone" not in reception.get(f"/visits/{invited['visit']['id']}").json()["visitor"]


def test_inside_is_for_reception_administrators_and_management(make_client, world: World) -> None:
    for user in (world.a.admin, world.a.receptionist, world.a.manager):
        assert signed_in(make_client, user).get("/reception/inside").status_code == 200
    response = signed_in(make_client, world.a.employee).get("/reception/inside")
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"


# ---- walk-ins -------------------------------------------------------------------------------------


def test_walk_in_registers_and_checks_in(
    reception: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    response = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            EXPECTED_END,
            visitor={
                "full_name": "Courier Kareem",
                "phone": "+962 79 111 2222",
                "company_name": "Fast Couriers",
            },
            reason="DELIVERY",
        ),
    )
    assert response.status_code == 201, response.text
    visit = response.json()
    assert visit["status"] == "CHECKED_IN" and visit["check_in_method"] == "WALK_IN" and visit["is_walk_in"]
    assert visit["walk_in_reason"] == "DELIVERY" and visit["check_in_note"] is None
    assert visit["scheduled_start"] == visit["check_in_at"]
    assert datetime.fromisoformat(visit["scheduled_end"]) == EXPECTED_END
    assert (
        visit["visitor"]["full_name"] == "Courier Kareem"
        and visit["visitor"]["company_name"] == "Fast Couriers"
    )
    assert visit["host"]["id"] == str(world.a.employee.id) and visit["created_by"]["id"] == str(
        world.a.receptionist.id
    )
    assert visit["checked_in_by"]["id"] == str(world.a.receptionist.id)
    assert visit["pass"]["status"] == "NONE" and visit["invitation"]["status"] == "NOT_SENT"
    assert visit["permissions"]["can_check_out"] is True

    [created] = audit_rows(db, "WALK_IN_CREATED")
    assert str(created.entity_id) == visit["id"] and created.actor_user_id == world.a.receptionist.id
    assert created.meta["reason"] == "DELIVERY" and created.meta["visitor_reused"] is False
    [checked_in] = audit_rows(db, "VISIT_CHECKED_IN")
    assert checked_in.meta["method"] == "WALK_IN" and checked_in.meta["host_notified"] is True
    assert len(audit_rows(db, "VISITOR_CREATED")) == 1
    assert audit_rows(db, "PASS_ISSUED") == []
    [arrival] = [email for email in email_provider.sent if email.kind == "HOST_ARRIVAL"]
    assert arrival.to == world.a.employee.email and "Courier Kareem" in arrival.subject


def test_walk_in_reuses_an_existing_visitor(reception: Api, host: Api, world: World, db: Session) -> None:
    invited = create_visit(
        host, world.a.employee.id, START + timedelta(days=1), visitor=_guest("Returning Guest")
    )
    visitor_id = invited["visit"]["visitor"]["id"]
    by_id = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor=None, visitor_id=visitor_id),
    )
    assert by_id.status_code == 201, by_id.text
    assert by_id.json()["visitor"]["id"] == visitor_id
    assert check_out(reception, by_id.json()["id"]).status_code == 200
    by_email = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            EXPECTED_END,
            visitor={
                "full_name": "returning GUEST",  # the registered name, typed differently (B57-70)
                "email": "returning.guest@example.com",
                "phone": "+962 79 1",
            },
        ),
    )
    assert by_email.status_code == 201, by_email.text
    assert by_email.json()["visitor"] == {
        "id": visitor_id,
        "full_name": "Returning Guest",
        "company_name": None,
    }
    assert refreshed(db, Visitor, visitor_id).phone == "+962 79 1"  # reception may fill empty fields
    assert [row.meta["visitor_reused"] for row in audit_rows(db, "WALK_IN_CREATED")] == [False, True]


@pytest.mark.parametrize(
    ("reason", "note", "walk_in_reason", "check_in_note"),
    [
        ("OTHER", "Contractor without a booking", "OTHER", "Contractor without a booking"),
        ("OTHER", "DELIVERY", "OTHER", "DELIVERY"),  # a note that spells a code is still a note
        ("LOST_PASS", "Phone left at the hotel", "LOST_PASS", "Phone left at the hotel"),
        ("EARLY_ARRIVAL", None, "EARLY_ARRIVAL", None),
    ],
)
def test_walk_in_reason_and_note(
    reception: Api,
    world: World,
    reason: str,
    note: str | None,
    walk_in_reason: str,
    check_in_note: str | None,
) -> None:
    extra: dict[str, object] = {"reason_note": note} if note else {}
    if reason == "LOST_PASS":  # a lost pass belongs to a visitor on record (SEC-32)
        registered = reception.post("/visitors", json={"full_name": "Pass Loser"})
        assert registered.status_code == 201, registered.text
        extra |= {"visitor": None, "visitor_id": registered.json()["id"]}
    response = reception.post(
        "/reception/walk-ins", json=walk_in_body(world.a.employee.id, EXPECTED_END, reason=reason, **extra)
    )
    assert response.status_code == 201, response.text
    assert (response.json()["walk_in_reason"], response.json()["check_in_note"]) == (
        walk_in_reason,
        check_in_note,
    )


def test_walk_in_for_another_reason_needs_a_note(reception: Api, world: World) -> None:
    response = reception.post(
        "/reception/walk-ins", json=walk_in_body(world.a.employee.id, EXPECTED_END, reason="OTHER")
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "reason_note": "Describe the reason for this walk-in."
    }


def test_walk_ins_can_be_disabled(reception: Api, world: World, make_client, db: Session) -> None:
    admin = signed_in(make_client, world.a.admin)
    assert admin.patch("/company/settings", json={"allow_walk_ins": False}).status_code == 200
    response = reception.post("/reception/walk-ins", json=walk_in_body(world.a.employee.id, EXPECTED_END))
    assert response.status_code == 409 and error_code(response) == "WALK_INS_DISABLED"
    assert response.json()["error"]["message"] == "Walk-in registration is disabled for this company."
    [row] = audit_rows(db, "WALK_IN_REFUSED")
    assert row.meta == {"code": "WALK_INS_DISABLED"} and row.entity_id == world.a.company.id
    assert db.query(Visit).filter(Visit.company_id == world.a.company.id).count() == 0


def test_a_visitor_already_inside_cannot_walk_in_again(
    reception: Api, host: Api, world: World, db: Session
) -> None:
    invited = create_visit(host, world.a.employee.id, START, visitor=_guest("Inside Already"))
    assert check_in(reception, invited["visit"]["id"]).status_code == 200
    visitor_id = invited["visit"]["visitor"]["id"]
    response = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor=None, visitor_id=visitor_id),
    )
    assert response.status_code == 409 and error_code(response) == "VISITOR_ALREADY_INSIDE"
    [row] = audit_rows(db, "WALK_IN_REFUSED")
    assert row.meta == {"code": "VISITOR_ALREADY_INSIDE"} and str(row.entity_id) == visitor_id
    assert audit_rows(db, "WALK_IN_CREATED") == []
    assert db.query(Visit).filter(Visit.visitor_id == visitor_id).count() == 1


def test_walk_in_host_and_department_must_be_usable(
    reception: Api, world: World, factory: Factory, db: Session
) -> None:
    inactive = factory.user(world.a.company, roles=(Role.EMPLOYEE,), is_active=False)
    cases = {
        str(world.a.receptionist.id): "Choose an active host.",  # not a host role
        str(inactive.id): "Choose an active host.",
        str(world.b.employee.id): "The selected item does not exist.",  # another company's host
        str(uuid.uuid4()): "The selected item does not exist.",
    }
    for host_id, message in cases.items():
        response = reception.post(
            "/reception/walk-ins",
            json={**walk_in_body(world.a.employee.id, EXPECTED_END), "host_id": host_id},
        )
        assert response.status_code == 422, host_id
        assert response.json()["error"]["details"]["fields"] == {"host_id": message}
    for department_id, message in (
        (world.a.legacy.id, "This department is inactive."),
        (world.b.finance.id, "The selected item does not exist."),
    ):
        response = reception.post(
            "/reception/walk-ins",
            json=walk_in_body(world.a.employee.id, EXPECTED_END, department_id=str(department_id)),
        )
        assert response.json()["error"]["details"]["fields"] == {"department_id": message}
    assert db.query(Visit).filter(Visit.company_id == world.a.company.id).count() == 0


def test_walk_in_takes_the_hosts_department(reception: Api, world: World, factory: Factory) -> None:
    hosting = factory.user(world.a.company, roles=(Role.EMPLOYEE,), department=world.a.finance)
    response = reception.post("/reception/walk-ins", json=walk_in_body(hosting.id, EXPECTED_END))
    assert response.json()["department"] == {
        "id": str(world.a.finance.id),
        "name": "Finance",
        "name_ar": None,
    }


def test_a_walk_in_names_any_active_host_while_an_invitation_does_not(
    make_client, world: World, factory: Factory
) -> None:
    """B10-24 restricts invitations only: the desk registers a walk-in for whichever colleague the visitor
    came to see, also when the person at the desk holds EMPLOYEE as well and could not invite for them."""
    desk = factory.user(world.a.company, roles=(Role.RECEPTIONIST, Role.EMPLOYEE))
    colleague = factory.user(world.a.company, roles=(Role.EMPLOYEE,), department=world.a.finance)
    api = signed_in(make_client, desk)
    walk_in = api.post("/reception/walk-ins", json=walk_in_body(colleague.id, EXPECTED_END))
    assert walk_in.status_code == 201, walk_in.text
    assert walk_in.json()["host"]["id"] == str(colleague.id)
    assert walk_in.json()["created_by"]["id"] == str(desk.id)
    invitation = api.post("/visits", json=visit_body(colleague.id, START))
    assert invitation.status_code == 422
    assert invitation.json()["error"]["details"]["field_codes"] == {
        "host_id": {"code": "host_must_be_self", "params": {}}
    }
    # An administrator registers walk-ins for anyone, as before.
    admin = signed_in(make_client, world.a.admin)
    other = admin.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor={"full_name": "B"}),
    )
    assert other.status_code == 201 and other.json()["host"]["id"] == str(world.a.employee.id)


@pytest.mark.parametrize(
    ("expected_end", "message"),
    [
        (TEST_START - timedelta(minutes=1), "The expected end must be in the future."),
        (TEST_START + timedelta(hours=25), "A visit can last at most 24 hours."),
    ],
)
def test_walk_in_expected_end(reception: Api, world: World, expected_end: datetime, message: str) -> None:
    response = reception.post("/reception/walk-ins", json=walk_in_body(world.a.employee.id, expected_end))
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {"expected_end": message}


def test_walk_in_needs_exactly_one_visitor_source(reception: Api, world: World) -> None:
    neither = walk_in_body(world.a.employee.id, EXPECTED_END, visitor=None)
    neither.pop("visitor")
    response = reception.post("/reception/walk-ins", json=neither)
    assert response.json()["error"]["details"]["fields"] == {
        "visitor": "Choose an existing visitor or enter the visitor's details."
    }


def test_walk_in_of_a_visitor_from_another_company_is_a_field_error(
    reception: Api, world: World, make_client
) -> None:
    other = signed_in(make_client, world.b.receptionist).post("/visitors", json={"full_name": "B Visitor"})
    response = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor=None, visitor_id=other.json()["id"]),
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "visitor_id": "The selected item does not exist."
    }


# ---- a lost pass of an expected visit (SEC-09) ----------------------------------------------------


def test_a_lost_pass_walk_in_for_a_visitor_expected_today_points_to_the_visit(
    reception: Api, host: Api, world: World, db: Session
) -> None:
    """The finding's sequence: a visitor expected today reports their pass lost. Registering them as a
    LOST_PASS walk-in left the lost pass valid (scan READY, and a QR check-in on the original visit once
    the walk-in checked out). Reception is pointed to the expected visit instead; checking in on it
    consumes it, and its pass stops working at check-out."""
    invited = create_visit(host, world.a.employee.id, START, visitor=_guest("Lost Pass Person"))
    visit_id = invited["visit"]["id"]
    lost_pass = invited["pass_url"].split("#", 1)[1]
    visitor_id = invited["visit"]["visitor"]["id"]
    for body in (
        walk_in_body(
            world.a.employee.id, EXPECTED_END, visitor=None, visitor_id=visitor_id, reason="LOST_PASS"
        ),
        walk_in_body(
            world.a.employee.id,
            EXPECTED_END,
            visitor={"full_name": "Lost Pass Person", "email": "lost.pass.person@example.com"},
            reason="LOST_PASS",
        ),
    ):
        refused = reception.post("/reception/walk-ins", json=body)
        assert refused.status_code == 422, refused.text
        assert "visit today" in refused.json()["error"]["details"]["fields"]["reason"]
    assert audit_rows(db, "WALK_IN_CREATED") == []

    assert check_in(reception, visit_id).status_code == 200  # MANUAL, after the ID check
    assert check_out(reception, visit_id).status_code == 200
    scan = reception.post("/reception/scan", json={"token": lost_pass})
    assert scan.status_code == 409 and error_code(scan) == "VISIT_COMPLETED"
    again = check_in(reception, visit_id, "QR", pass_token=lost_pass)
    assert again.status_code == 409


@pytest.mark.parametrize(
    "visitor",
    [
        {"full_name": "Lina Haddad", "phone": "+962 79 123 4567"},  # the finding's quickest path
        {"full_name": "Lina Haddad"},
        {"full_name": "Lina Haddad", "email": "lina.private@example.com"},  # an address not on record
    ],
)
def test_a_lost_pass_walk_in_cannot_register_the_visitor_anew(
    reception: Api, host: Api, world: World, db: Session, visitor: dict
) -> None:
    """SEC-32: typed without the invited address, the details created a second visitor record with no
    visits, so the SEC-09 check saw nothing expected; the lost pass then scanned READY and checked a
    second person in on the original visit while the visitor was inside (a second record is not "already
    inside"). A lost pass belongs to a visitor on record: the walk-in must name that record."""
    invited = create_visit(host, world.a.employee.id, START, visitor=_guest("Lina Haddad"))
    lost_pass = invited["pass_url"].split("#", 1)[1]
    created_before = len(audit_rows(db, "VISITOR_CREATED"))

    refused = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor=visitor, reason="LOST_PASS"),
    )
    assert refused.status_code == 422, refused.text
    assert "select their record" in refused.json()["error"]["details"]["fields"]["reason"]
    assert audit_rows(db, "WALK_IN_CREATED") == []
    assert len(audit_rows(db, "VISITOR_CREATED")) == created_before  # no second record
    assert reception.get("/reception/inside").json()["count"] == 0

    # Named by its record, the visitor is pointed to the expected visit (SEC-09).
    by_record = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            EXPECTED_END,
            visitor=None,
            visitor_id=invited["visit"]["visitor"]["id"],
            reason="LOST_PASS",
        ),
    )
    assert by_record.status_code == 422
    assert "visit today" in by_record.json()["error"]["details"]["fields"]["reason"]
    scan = reception.post("/reception/scan", json={"token": lost_pass})
    assert scan.status_code == 200 and scan.json()["result"] == "READY"  # nobody is inside on it


def test_other_walk_in_reasons_may_register_new_visitors(reception: Api, world: World) -> None:
    """Only LOST_PASS needs a record: a walk-in without an invitation is usually a new visitor."""
    response = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, EXPECTED_END, visitor={"full_name": "Lina Haddad"}),
    )
    assert response.status_code == 201, response.text


def test_a_lost_pass_walk_in_is_allowed_without_an_expected_visit(
    reception: Api, host: Api, world: World
) -> None:
    """Tomorrow's visit is not expected today, and other reasons never look at the visitor's visits (a
    visitor may come today for another host)."""
    tomorrow = create_visit(
        host, world.a.employee.id, START + timedelta(days=1), visitor=_guest("Early Bird")
    )
    visitor_id = tomorrow["visit"]["visitor"]["id"]
    lost = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id, EXPECTED_END, visitor=None, visitor_id=visitor_id, reason="LOST_PASS"
        ),
    )
    assert lost.status_code == 201, lost.text
    assert check_out(reception, lost.json()["id"]).status_code == 200
    today = create_visit(host, world.a.employee.id, START, visitor=_guest("Second Meeting"))
    other_reason = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id,
            EXPECTED_END,
            visitor=None,
            visitor_id=today["visit"]["visitor"]["id"],
            reason="EARLY_ARRIVAL",
        ),
    )
    assert other_reason.status_code == 201, other_reason.text


# ---- a pass that works before its visit's day (SEC-R2) --------------------------------------------
# A pass is valid from its window's start, not from the scheduled start. Asia/Amman is UTC+3 all year,
# and the grace periods default to 60 minutes.

LATE_EVENING = datetime(2026, 10, 5, 20, 30, tzinfo=UTC)  # 23:30 on 5 October


def _signed_in_at(instant: datetime, clock: FakeClock, make_client, world: World) -> tuple[Api, Api]:
    """The host and reception, signed in at `instant` (a session ends after four idle hours)."""
    clock.set(instant)
    return signed_in(make_client, world.a.employee), signed_in(make_client, world.a.receptionist)


def _lost_pass_walk_in(
    reception: Api, world: World, visitor_id: str, expected_end: datetime
) -> httpx.Response:
    return reception.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.employee.id, expected_end, visitor=None, visitor_id=visitor_id, reason="LOST_PASS"
        ),
    )


def test_a_visit_after_midnight_whose_pass_is_valid_is_expected_and_guarded(
    clock: FakeClock, make_client, world: World, db: Session
) -> None:
    """The finding: invited for 00:10-01:10 tomorrow, the visitor arrives at 23:30, when the pass has been
    valid since 23:10. The visit starts tomorrow, so it was on neither the Expected list nor the visitor
    search's `today_visits`, and the SEC-09 guard let a LOST_PASS walk-in through. Once the walk-in had
    checked out, the reported-lost pass checked a second person in on the original visit under the
    visitor's name (and past D-09's "no re-entry after check-out")."""
    host, reception = _signed_in_at(LATE_EVENING, clock, make_client, world)
    invited = create_visit(
        host, world.a.employee.id, LATE_EVENING + timedelta(minutes=40), visitor=_guest("Lina Lostpass")
    )  # 00:10 on 6 October
    visit_id, lost_pass = invited["visit"]["id"], pass_token(invited["pass_url"])
    scan = reception.post("/reception/scan", json={"token": lost_pass})
    assert scan.status_code == 200 and scan.json()["result"] == "READY"  # the pass works right now

    today = reception.get("/reception/today").json()
    assert today["date"] == "2026-10-05"
    assert _ids(today["expected"]) == [visit_id] and today["counts"]["expected"] == 1
    [found] = reception.get("/visitors", params={"q": "Lostpass"}).json()["items"]
    assert _ids(found["today_visits"]) == [visit_id]

    refused = _lost_pass_walk_in(
        reception, world, invited["visit"]["visitor"]["id"], LATE_EVENING + timedelta(hours=1)
    )
    assert refused.status_code == 422, refused.text
    assert "valid now" in refused.json()["error"]["details"]["fields"]["reason"]
    assert audit_rows(db, "WALK_IN_CREATED") == []
    assert reception.get("/reception/inside").json()["count"] == 0

    # The flow the answer points to: MANUAL check-in on the visit after the ID check. Its check-out
    # revokes the pass, so the lost pass admits nobody afterwards.
    assert check_in(reception, visit_id).status_code == 200
    assert check_out(reception, visit_id).status_code == 200
    clock.advance(timedelta(minutes=20))
    scan = reception.post("/reception/scan", json={"token": lost_pass})
    assert scan.status_code == 409 and error_code(scan) == "VISIT_COMPLETED"
    assert check_in(reception, visit_id, "QR", pass_token=lost_pass).status_code == 409


def test_a_pass_that_becomes_valid_later_today_points_to_the_time(
    clock: FakeClock, make_client, world: World
) -> None:
    """At 23:00, a visit at 00:40 tomorrow has a pass valid from 23:40: expected today, but neither MANUAL
    (before the window) nor OVERRIDE (another day, §6) can check the visitor in yet. A walk-in would leave
    the lost pass working from 23:40, so the answer says from when the visit can be checked in. A pass
    whose window opens only tomorrow is not expected today, and the walk-in is registered (D-08)."""
    host, reception = _signed_in_at(LATE_EVENING - timedelta(minutes=30), clock, make_client, world)
    soon = create_visit(
        host, world.a.employee.id, LATE_EVENING + timedelta(minutes=70), visitor=_guest("Omar Soon")
    )  # 00:40, valid from 23:40
    tomorrow = create_visit(
        host, world.a.employee.id, LATE_EVENING + timedelta(minutes=100), visitor=_guest("Tala Tomorrow")
    )  # 01:10, valid from 00:10 tomorrow
    scan = reception.post("/reception/scan", json={"token": pass_token(soon["pass_url"])})
    assert scan.status_code == 409 and error_code(scan) == "PASS_NOT_YET_VALID"
    today = reception.get("/reception/today").json()
    assert _ids(today["expected"]) == [soon["visit"]["id"]] and today["counts"]["expected"] == 1

    expected_end = LATE_EVENING + timedelta(minutes=30)
    refused = _lost_pass_walk_in(reception, world, soon["visit"]["visitor"]["id"], expected_end)
    assert refused.status_code == 422, refused.text
    assert "becomes valid at 23:40 today" in refused.json()["error"]["details"]["fields"]["reason"]
    allowed = _lost_pass_walk_in(reception, world, tomorrow["visit"]["visitor"]["id"], expected_end)
    assert allowed.status_code == 201, allowed.text


def test_with_a_day_of_grace_tomorrows_passes_are_guarded_today(
    host: Api, reception: Api, world: World, make_client
) -> None:
    """The finding's second run: with pass_grace_before_minutes = 1440 (the maximum), a visit at 08:00
    tomorrow has a pass valid since 08:00 today. At 09:00 it is expected today and a LOST_PASS walk-in is
    refused (MANUAL applies); a visit at 10:00 tomorrow is refused with the time its pass becomes valid."""
    admin = signed_in(make_client, world.a.admin)
    assert admin.patch("/company/settings", json={"pass_grace_before_minutes": 1440}).status_code == 200
    valid = create_visit(
        host, world.a.employee.id, TEST_START + timedelta(hours=23), visitor=_guest("Early Ezra")
    )  # 08:00 tomorrow
    later = create_visit(
        host, world.a.employee.id, TEST_START + timedelta(hours=25), visitor=_guest("Later Lea")
    )  # 10:00 tomorrow
    scan = reception.post("/reception/scan", json={"token": pass_token(valid["pass_url"])})
    assert scan.status_code == 200 and scan.json()["result"] == "READY"
    today = reception.get("/reception/today").json()
    assert _ids(today["expected"]) == [valid["visit"]["id"], later["visit"]["id"]]
    assert today["counts"]["expected"] == 2

    refused = _lost_pass_walk_in(reception, world, valid["visit"]["visitor"]["id"], EXPECTED_END)
    assert refused.status_code == 422 and "valid now" in refused.text
    refused = _lost_pass_walk_in(reception, world, later["visit"]["visitor"]["id"], EXPECTED_END)
    assert refused.status_code == 422 and "becomes valid at 10:00 today" in refused.text
