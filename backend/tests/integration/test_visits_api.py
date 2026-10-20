"""Visits API (contract §5, §7.5, §8 /visits, D-14, D-16, D-22): creation, reading, scope, changes."""

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import AuditLog, EmailMessage, Role, Visit, Visitor, VisitorPass
from app.security.tokens import hash_token
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    audit_rows,
    create_visit,
    create_visit_booked_by,
    error_code,
    pass_token,
    rate_limits,
    refreshed,
    signed_in,
    visit_body,
)

START = TEST_START + timedelta(hours=1)  # 10:00 in Asia/Amman


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


# ---- creation -----------------------------------------------------------------------------------


def test_create_visit_with_inline_visitor(host: Api, world: World, db: Session, email_provider) -> None:
    body = visit_body(
        world.a.employee.id,
        START,
        visitor={"full_name": "Dana Guest", "email": "Dana.Guest@Example.com", "company_name": "Acme"},
        send_invitation=True,
    )
    response = host.post("/visits", json=body)
    assert response.status_code == 201, response.text
    result = response.json()
    visit = result["visit"]
    assert result["visitor_match"] == {"reused": False}
    assert visit["status"] == "SCHEDULED"
    assert visit["visitor"]["full_name"] == "Dana Guest" and visit["visitor"]["company_name"] == "Acme"
    assert visit["host"] == {
        "id": str(world.a.employee.id),
        "full_name": "Alpha Employee",
        "phone": "+962 79 000 0001",
    }
    assert visit["created_by"]["id"] == str(world.a.employee.id)
    assert visit["scheduled_start"] == "2026-10-05T07:00:00Z"
    # The window is the schedule widened by the company grace (60 minutes each side by default).
    assert visit["window_start"] == "2026-10-05T06:00:00Z" and visit["window_end"] == "2026-10-05T09:00:00Z"
    assert visit["pass"]["status"] == "ACTIVE" and visit["pass"]["revoke_reason"] is None
    assert (
        visit["invitation"]["status"] == "PENDING"
        and visit["invitation"]["to_email"] == "dana.guest@example.com"
    )
    assert visit["permissions"] == {
        "can_edit": True,
        "can_cancel": True,
        "can_resend": True,
        "can_check_in": False,
        "can_check_out": False,
    }
    # The pass URL is the QR payload: QR_BASE_URL/pass?c=<slug>#<token> (B12-14); only the token's
    # hash is stored.
    assert result["pass_url"].startswith(f"https://vms.test/pass?c={world.a.company.slug}#")
    token = pass_token(result["pass_url"])
    stored = db.scalars(select(VisitorPass).where(VisitorPass.visit_id == visit["id"])).one()
    assert stored.token_hash == hash_token(token) and token not in stored.token_hash
    # The invitation was delivered after the commit (background task) and carries the same pass URL;
    # its calendar invitation followed it (B14-10), and the host was told of the visit (B14-2).
    sent, calendar, host_notice = email_provider.sent
    assert [email.kind for email in email_provider.sent] == [
        "VISITOR_INVITATION",
        "VISITOR_CALENDAR",
        "HOST_VISIT_SCHEDULED",
    ]
    assert sent.to == calendar.to == "dana.guest@example.com" and sent.pass_url == result["pass_url"]
    assert calendar.pass_url is None and host_notice.to == world.a.employee.email
    assert refreshed(db, EmailMessage, sent.message_id).status == "SENT"
    for action in ("VISITOR_CREATED", "VISIT_CREATED", "PASS_ISSUED", "INVITATION_QUEUED", "INVITATION_SENT"):
        assert audit_rows(db, action), action
    sent_row = audit_rows(db, "INVITATION_SENT")[-1]
    assert sent_row.meta["recipient_domain"] == "example.com" and sent_row.actor_user_id is None


def test_pass_is_created_even_without_an_invitation(
    host: Api, world: World, db: Session, email_provider
) -> None:
    result = create_visit(host, world.a.employee.id, START, visitor={"full_name": "No Email"})
    visit = result["visit"]
    assert visit["pass"]["status"] == "ACTIVE"
    assert visit["invitation"] == {
        "status": "NOT_SENT",
        "to_email": None,
        "attempts": 0,
        "last_attempt_at": None,
        "sent_at": None,
        "error": None,
        "calendar_failed": False,
    }
    assert visit["permissions"]["can_resend"] is False  # no e-mail address to send to
    # The visitor is sent nothing; the host is told of the visit (B14-2).
    assert [email.kind for email in email_provider.sent] == ["HOST_VISIT_SCHEDULED"]
    assert db.scalars(select(VisitorPass).where(VisitorPass.visit_id == visit["id"])).one().revoked_at is None


def test_invitation_requires_an_email(host: Api, world: World, db: Session) -> None:
    body = visit_body(world.a.employee.id, START, visitor={"full_name": "No Email"}, send_invitation=True)
    response = host.post("/visits", json=body)
    assert response.status_code == 409 and error_code(response) == "VISITOR_EMAIL_REQUIRED"
    assert db.scalars(select(Visitor).where(Visitor.full_name == "No Email")).first() is None


def test_department_defaults_to_the_hosts_department(make_client, world: World) -> None:
    admin = signed_in(make_client, world.a.admin)
    visit = create_visit(admin, world.a.admin.id, START)["visit"]
    assert visit["department"] == {"id": str(world.a.finance.id), "name": "Finance", "name_ar": None}
    # An explicit department wins; an inactive one is refused.
    other = create_visit(admin, world.a.admin.id, START, department_id=str(world.a.finance.id))["visit"]
    assert other["department"]["id"] == str(world.a.finance.id)
    inactive = admin.post(
        "/visits", json=visit_body(world.a.admin.id, START, department_id=str(world.a.legacy.id))
    )
    assert inactive.status_code == 422
    assert inactive.json()["error"]["details"]["fields"] == {"department_id": "This department is inactive."}


# ---- the host is the caller, unless an administrator invites (B10-24) --------------------------------

HOST_MUST_BE_SELF = "You can only invite visitors you host yourself."


def _count(db: Session, model) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(model)) or 0


def _refused_as_not_self(response) -> None:
    assert response.status_code == 422, response.text
    assert response.json()["error"]["details"] == {
        "fields": {"host_id": HOST_MUST_BE_SELF},
        "field_codes": {"host_id": {"code": "host_must_be_self", "params": {}}},
    }


@pytest.mark.parametrize(
    "roles",
    [(Role.EMPLOYEE,), (Role.EMPLOYEE, Role.MANAGEMENT), (Role.EMPLOYEE, Role.RECEPTIONIST)],
    ids=["employee", "employee+management", "employee+receptionist"],
)
def test_a_caller_who_is_not_an_administrator_invites_only_as_the_host(
    make_client, world: World, factory: Factory, db: Session, email_provider: MemoryProvider, roles
) -> None:
    """The user's rule: every employee invites only in their own name. Nothing is created: no visit, no
    visitor, no e-mail, no VISIT_CREATED row."""
    caller = factory.user(world.a.company, roles=roles, department=world.a.finance)
    colleague = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Colleague Host")
    api = signed_in(make_client, caller)
    visits, visitors = _count(db, Visit), _count(db, Visitor)
    guest = {"full_name": "Dana Guest", "email": "dana.guest@example.com"}
    body = visit_body(colleague.id, START, send_invitation=True, visitor=guest)
    _refused_as_not_self(api.post("/visits", json=body))
    assert (_count(db, Visit), _count(db, Visitor)) == (visits, visitors)
    assert audit_rows(db, "VISIT_CREATED") == [] and email_provider.sent == []
    # In their own name it works, with their department by default.
    own = create_visit(api, caller.id, START)["visit"]
    assert own["host"]["id"] == own["created_by"]["id"] == str(caller.id)
    assert own["department"]["id"] == str(world.a.finance.id)


@pytest.mark.parametrize("kind", ["admin", "receptionist", "inactive", "unknown", "other_company"])
def test_an_employee_is_refused_another_host_before_it_is_looked_up(
    host: Api, world: World, factory: Factory, kind: str
) -> None:
    """Whoever the other ID names (an administrator, a non-host, an inactive user, nobody, another
    company's employee), the answer is the same, so it says nothing about that user."""
    host_id = {
        "admin": world.a.admin.id,
        "receptionist": world.a.receptionist.id,
        "inactive": factory.user(world.a.company, is_active=False).id,
        "unknown": world.a.company.id,  # any UUID that is not a user of this company
        "other_company": world.b.employee.id,
    }[kind]
    _refused_as_not_self(host.post("/visits", json=visit_body(host_id, START)))


@pytest.mark.parametrize("roles", [(Role.SYSTEM_ADMIN,), (Role.SYSTEM_ADMIN, Role.EMPLOYEE)])
def test_an_administrator_may_invite_on_behalf_of_any_active_host(
    make_client, world: World, factory: Factory, email_provider: MemoryProvider, roles
) -> None:
    administrator = factory.user(world.a.company, roles=roles, full_name="Office Manager")
    colleague = factory.user(
        world.a.company, roles=(Role.EMPLOYEE,), full_name="Colleague Host", department=world.a.finance
    )
    api = signed_in(make_client, administrator)
    visit = create_visit(api, colleague.id, START, send_invitation=True)["visit"]
    assert visit["host"]["full_name"] == "Colleague Host"
    assert visit["created_by"]["id"] == str(administrator.id)
    assert visit["department"]["id"] == str(world.a.finance.id)  # the host's department, as before
    assert visit["permissions"]["can_edit"] is True
    # The invitation says who booked it on the host's behalf (B57-02), and so does the host's notice.
    invitation, _calendar, host_notice = email_provider.sent
    assert invitation.kind == "VISITOR_INVITATION" and host_notice.kind == "HOST_VISIT_SCHEDULED"
    assert host_notice.to == colleague.email and "Office Manager" in host_notice.text
    assert "Office Manager" in invitation.text and "Colleague Host" in invitation.text
    # The host owns it too (D-02).
    detail = signed_in(make_client, colleague).get(f"/visits/{visit['id']}").json()
    assert detail["permissions"]["can_edit"] is True


@pytest.mark.parametrize("kind", ["receptionist", "inactive", "unknown", "other_company"])
def test_host_must_be_an_active_host_of_the_company(
    make_client, world: World, factory: Factory, kind: str
) -> None:
    """For an administrator, who may name another host (B10-24)."""
    host_id = {
        "receptionist": world.a.receptionist.id,
        "inactive": factory.user(world.a.company, is_active=False).id,
        "unknown": world.a.company.id,  # any UUID that is not a user of this company
        "other_company": world.b.employee.id,
    }[kind]
    admin = signed_in(make_client, world.a.admin)
    response = admin.post("/visits", json=visit_body(host_id, START))
    assert response.status_code == 422
    codes = response.json()["error"]["details"]["field_codes"]
    assert codes == {
        "host_id": {
            "code": "not_found" if kind in ("unknown", "other_company") else "host_unavailable",
            "params": {},
        }
    }


def test_a_visit_keeps_its_host_when_it_is_changed(host: Api, world: World, factory: Factory) -> None:
    """A visit's host is never changed afterwards: PATCH has no `host_id` (unchanged by B10-24)."""
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    colleague = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    response = host.patch(f"/visits/{visit_id}", json={"host_id": str(colleague.id)})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["field_codes"] == {
        "host_id": {"code": "not_allowed", "params": {}}
    }


@pytest.mark.parametrize(
    ("start_offset", "minutes", "field", "message"),
    [
        (timedelta(hours=1), 0, "scheduled_end", "The end time must be after the start time."),
        (timedelta(hours=1), -30, "scheduled_end", "The end time must be after the start time."),
        (timedelta(hours=1), 24 * 60 + 1, "scheduled_end", "A visit can last at most 24 hours."),
        (-timedelta(minutes=6), 60, "scheduled_start", "The start time must not be in the past."),
        (timedelta(days=366), 60, "scheduled_start", "A visit can be scheduled at most 365 days ahead."),
    ],
)
def test_schedule_rules(
    host: Api, world: World, start_offset, minutes: int, field: str, message: str
) -> None:
    body = visit_body(world.a.employee.id, TEST_START + start_offset, minutes=minutes)
    response = host.post("/visits", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"][field] == message


def test_schedule_tolerances(host: Api, world: World) -> None:
    create_visit(host, world.a.employee.id, TEST_START - timedelta(minutes=4))  # 5-minute tolerance
    create_visit(host, world.a.employee.id, TEST_START + timedelta(days=364), minutes=24 * 60)


def test_naive_datetimes_are_rejected(host: Api, world: World) -> None:
    body = visit_body(world.a.employee.id, START)
    body["scheduled_start"] = "2026-10-05T10:00:00"
    response = host.post("/visits", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "scheduled_start": "Include a time zone, e.g. 2026-10-05T09:00:00+03:00."
    }


def test_all_field_problems_are_reported_together(host: Api, world: World) -> None:
    body = visit_body(world.b.employee.id, START, minutes=0, department_id=str(world.b.finance.id))
    response = host.post("/visits", json=body)
    assert set(response.json()["error"]["details"]["fields"]) == {"host_id", "department_id", "scheduled_end"}


def test_daily_invitation_limit(app, host: Api, world: World) -> None:
    with rate_limits(app, invitations_per_user_day=2):
        for _ in range(2):
            create_visit(host, world.a.employee.id, START, send_invitation=True)
        response = host.post("/visits", json=visit_body(world.a.employee.id, START, send_invitation=True))
        # Visits without an invitation are not limited.
        create_visit(host, world.a.employee.id, START)
    assert response.status_code == 429 and error_code(response) == "INVITATION_LIMIT"
    assert int(response.headers["Retry-After"]) > 0


# ---- visitor matching (D-05, §7.5) --------------------------------------------------------------


def test_one_visitor_many_visits(host: Api, world: World, db: Session) -> None:
    person = {"full_name": "Repeat Guest", "email": "repeat@example.com"}
    first = create_visit(host, world.a.employee.id, START, visitor=person)
    later = [
        create_visit(host, world.a.employee.id, START + timedelta(days=day), visitor=person) for day in (1, 2)
    ]
    assert first["visitor_match"] == {"reused": False}
    assert all(result["visitor_match"] == {"reused": True} for result in later)
    visitor_id = first["visit"]["visitor"]["id"]
    assert {result["visit"]["visitor"]["id"] for result in later} == {visitor_id}
    history = host.get(f"/visitors/{visitor_id}/visits").json()
    assert history["total"] == 3
    starts = [item["scheduled_start"] for item in history["items"]]
    assert starts == sorted(starts, reverse=True)  # newest first
    assert len(db.scalars(select(Visitor).where(Visitor.email == "repeat@example.com")).all()) == 1


def test_reuse_fills_only_empty_fields_in_scope(host: Api, world: World, db: Session) -> None:
    created = create_visit(
        host, world.a.employee.id, START, visitor={"full_name": "Fill Me", "email": "fill@example.com"}
    )
    again = create_visit(
        host,
        world.a.employee.id,
        START,
        visitor={
            "full_name": "FILL  me",  # the registered name, typed differently (B57-70)
            "email": "fill@example.com",
            "phone": "079 123 4567",
            "company_name": "NewCo",
        },
    )
    assert again["visitor_match"] == {"reused": True}
    visitor = refreshed(db, Visitor, created["visit"]["visitor"]["id"])
    assert visitor.full_name == "Fill Me"  # never overwritten
    assert visitor.phone == "079 123 4567" and visitor.phone_digits == "0791234567"
    assert visitor.company_name == "NewCo"
    assert audit_rows(db, "VISITOR_UPDATED", entity_id=visitor.id)[-1].meta == {
        "changed_fields": ["phone", "company_name"],
        "source": "visit_inline",
    }


def test_reuse_out_of_scope_links_without_filling_or_revealing(
    make_client, world: World, factory: Factory, db: Session
) -> None:
    other_employee = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    owner = signed_in(make_client, other_employee)
    original = create_visit(
        owner, other_employee.id, START, visitor={"full_name": "Stored Name", "email": "private@example.com"}
    )
    employee = signed_in(make_client, world.a.employee)
    result = create_visit(
        employee,
        world.a.employee.id,
        START,
        visitor={"full_name": "stored NAME", "email": "private@example.com", "phone": "+1 555 0100"},
    )
    assert result["visitor_match"] == {"reused": True}
    assert result["visit"]["visitor"]["id"] == original["visit"]["visitor"]["id"]
    # Nothing stored is revealed: the snapshot is what the caller typed.
    assert result["visit"]["visitor"]["full_name"] == "stored NAME"
    assert "Stored Name" not in str(result)
    visitor = refreshed(db, Visitor, original["visit"]["visitor"]["id"])
    assert visitor.phone is None  # not filled: the visitor was outside the caller's scope
    # Under another name the visit is not linked (B57-01).
    refused = employee.post(
        "/visits",
        json=visit_body(
            world.a.employee.id, START, visitor={"full_name": "Typed Name", "email": "private@example.com"}
        ),
    )
    assert refused.status_code == 409 and error_code(refused) == "VISITOR_EXISTS"
    assert refused.json()["error"]["details"] == {}


FILL_ATTEMPT = {"phone": "+1 555 0199", "company_name": "Evil Corp"}


def test_reuse_fills_nothing_in_a_readable_visitor_the_caller_may_not_edit(
    make_client, world: World, factory: Factory, db: Session
) -> None:
    """Filling empty fields is an edit (§7.5 edit rule, D-05). The employee created the visitor, so they
    read it, but an administrator booked it for a colleague, so it is no longer theirs to edit; a filled-in
    company would also have reached the colleague's visit through its snapshot (D-17)."""
    employee = signed_in(make_client, world.a.employee)
    person = {"full_name": "Shared Guest", "email": "shared-fill@example.com"}
    created = employee.post("/visitors", json=person)
    assert created.status_code == 201, created.text
    visitor_id = created.json()["id"]
    colleague = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    booked = create_visit(signed_in(make_client, world.a.admin), colleague.id, START, visitor_id=visitor_id)
    denied = employee.patch(f"/visitors/{visitor_id}", json=FILL_ATTEMPT)
    assert denied.status_code == 403

    result = create_visit(employee, world.a.employee.id, START, visitor={**person, **FILL_ATTEMPT})
    assert result["visitor_match"] == {"reused": True}
    # The employee reads the visitor, so the new visit carries the stored details.
    assert result["visit"]["visitor"] == {"id": visitor_id, "full_name": "Shared Guest", "company_name": None}
    visitor = refreshed(db, Visitor, visitor_id)
    assert (visitor.phone, visitor.phone_digits, visitor.company_name) == (None, None, None)
    assert refreshed(db, Visit, booked["visit"]["id"]).visitor_company_name is None
    assert audit_rows(db, "VISITOR_UPDATED", entity_id=visitor.id) == []
    assert refreshed(db, Visit, result["visit"]["id"]).visitor_link_in_scope is True


def test_reuse_by_a_reader_of_every_visitor_fills_only_visitors_they_may_edit(
    make_client, world: World, factory: Factory, db: Session
) -> None:
    """MANAGEMENT + EMPLOYEE reads every visitor but edits only visitors in their own scope as an owner
    (B24-13); reusing anyone else's visitor links it and fills nothing."""
    owner = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    person = {"full_name": "Owned Guest", "email": "owned-fill@example.com"}
    owned = create_visit(signed_in(make_client, owner), owner.id, START, visitor=person)["visit"]
    visitor_id = owned["visitor"]["id"]
    manager = factory.user(world.a.company, roles=(Role.MANAGEMENT, Role.EMPLOYEE))
    reader = signed_in(make_client, manager)
    assert reader.patch(f"/visitors/{visitor_id}", json=FILL_ATTEMPT).status_code == 403

    result = create_visit(reader, manager.id, START, visitor={**person, **FILL_ATTEMPT})
    assert result["visitor_match"] == {"reused": True}
    assert result["visit"]["visitor"] == {"id": visitor_id, "full_name": "Owned Guest", "company_name": None}
    visitor = refreshed(db, Visitor, visitor_id)
    assert (visitor.phone, visitor.company_name) == (None, None)
    assert refreshed(db, Visit, owned["id"]).visitor_company_name is None

    # A visitor of their own is filled as before.
    own = {"full_name": "Own Guest", "email": "own-fill@example.com"}
    own_id = create_visit(reader, manager.id, START, visitor=own)["visit"]["visitor"]["id"]
    again = create_visit(reader, manager.id, START, visitor={**own, **FILL_ATTEMPT})
    assert again["visit"]["visitor"]["company_name"] == "Evil Corp"
    filled = refreshed(db, Visitor, own_id)
    assert (filled.phone, filled.company_name) == ("+1 555 0199", "Evil Corp")


def test_visitor_id_outside_the_scope_is_a_field_error(make_client, world: World, factory: Factory) -> None:
    other_employee = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    foreign = create_visit(signed_in(make_client, other_employee), other_employee.id, START)
    visitor_id = foreign["visit"]["visitor"]["id"]
    employee = signed_in(make_client, world.a.employee)
    response = employee.post("/visits", json=visit_body(world.a.employee.id, START, visitor_id=visitor_id))
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "visitor_id": "The selected item does not exist."
    }
    # Company-wide roles may use it.
    admin = signed_in(make_client, world.a.admin)
    assert (
        admin.post("/visits", json=visit_body(world.a.admin.id, START, visitor_id=visitor_id)).status_code
        == 201
    )


# ---- reading and scope --------------------------------------------------------------------------


def test_employee_isolation(make_client, world: World, factory: Factory, db: Session) -> None:
    """host vs host2 vs creator-on-behalf vs MANAGEMENT (read-only) vs RECEPTIONIST."""
    host2 = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Second Host")
    creator = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Assistant")
    host = signed_in(make_client, world.a.employee)
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    # Booked by an employee for the host before B10-24 (now only administrators book for others).
    admin = signed_in(make_client, world.a.admin)
    on_behalf = create_visit_booked_by(db, admin, creator, world.a.employee.id, START)["visit"]

    other = signed_in(make_client, host2)
    for path in (f"/visits/{visit['id']}",):
        assert other.get(path).status_code == 404
    for method, path, body in (
        ("patch", f"/visits/{visit['id']}", {"purpose": "Hijacked"}),
        ("post", f"/visits/{visit['id']}/cancel", {}),
        ("post", f"/visits/{visit['id']}/invitation", None),
    ):
        response = getattr(other, method)(path, json=body)
        assert response.status_code == 404, (method, path)
    listed = other.get("/visits", params={"scope": "all", "host_id": str(world.a.employee.id)}).json()
    assert listed["items"] == [] and listed["total"] == 0

    # The host sees both visits: the one they created and the one created on their behalf.
    mine = {item["id"] for item in host.get("/visits").json()["items"]}
    assert {visit["id"], on_behalf["id"]} <= mine
    # The creator on behalf owns their visit too, but not the host's other one.
    assistant = signed_in(make_client, creator)
    assert assistant.get(f"/visits/{on_behalf['id']}").json()["permissions"]["can_edit"] is True
    assert assistant.get(f"/visits/{visit['id']}").status_code == 404

    # MANAGEMENT reads everything, changes nothing.
    management = signed_in(make_client, world.a.manager)
    detail = management.get(f"/visits/{visit['id']}").json()
    assert not any(detail["permissions"].values())
    assert management.patch(f"/visits/{visit['id']}", json={"purpose": "x"}).status_code == 403
    assert management.post(f"/visits/{visit['id']}/cancel", json={}).status_code == 403
    assert management.post("/visits", json=visit_body(world.a.employee.id, START)).status_code == 403

    # RECEPTIONIST reads everything; visit changes are not theirs either.
    reception = signed_in(make_client, world.a.receptionist)
    assert reception.get(f"/visits/{visit['id']}").status_code == 200
    assert reception.post(f"/visits/{visit['id']}/invitation").status_code == 403
    assert reception.get("/visits", params={"scope": "all"}).json()["total"] >= 2


def test_management_employee_reads_all_but_changes_only_own(
    make_client, world: World, factory: Factory
) -> None:
    both = factory.user(world.a.company, roles=(Role.MANAGEMENT, Role.EMPLOYEE))
    visit = create_visit(signed_in(make_client, world.a.employee), world.a.employee.id, START)["visit"]
    api = signed_in(make_client, both)
    assert api.get(f"/visits/{visit['id']}").status_code == 200
    denied = api.patch(f"/visits/{visit['id']}", json={"purpose": "Not mine"})
    assert denied.status_code == 403 and error_code(denied) == "FORBIDDEN"
    assert api.get("/visits", params={"scope": "mine"}).json()["total"] == 0


def test_list_filters_and_order(host: Api, world: World, factory: Factory) -> None:
    a = create_visit(
        host, world.a.employee.id, START, visitor={"full_name": "Élodie Martin", "company_name": "Zeta"}
    )
    b = create_visit(
        host, world.a.employee.id, START + timedelta(days=1), visitor={"full_name": "Omar Saleh"}
    )
    c = create_visit(
        host, world.a.employee.id, START + timedelta(days=2), visitor={"full_name": "Third Person"}
    )
    host.post(f"/visits/{c['visit']['id']}/cancel", json={"notify_visitor": False})

    def ids(**params) -> list[str]:
        response = host.get("/visits", params=params)
        assert response.status_code == 200, response.text
        return [item["id"] for item in response.json()["items"]]

    assert ids() == [c["visit"]["id"], b["visit"]["id"], a["visit"]["id"]]  # newest first by default
    assert ids(order="asc") == [a["visit"]["id"], b["visit"]["id"], c["visit"]["id"]]
    assert ids(status="SCHEDULED") == [b["visit"]["id"], a["visit"]["id"]]
    assert ids(status="CANCELLED,SCHEDULED", order="asc")[-1] == c["visit"]["id"]
    # Company-local dates: 2026-10-06 in Asia/Amman.
    assert ids(date_from="2026-10-06", date_to="2026-10-06") == [b["visit"]["id"]]
    assert ids(date_from="2026-10-06") == [c["visit"]["id"], b["visit"]["id"]]
    assert ids(date_to="2026-10-05") == [a["visit"]["id"]]
    # Search folds accents and case, on the visitor and on the snapshots.
    assert ids(q="elodie") == [a["visit"]["id"]]
    assert ids(q="ZETA") == [a["visit"]["id"]]
    assert ids(visitor_id=b["visit"]["visitor"]["id"]) == [b["visit"]["id"]]
    assert ids(host_id=str(world.a.employee.id), status="SCHEDULED", order="asc") == [
        a["visit"]["id"],
        b["visit"]["id"],
    ]


@pytest.mark.parametrize("name", ["host_id", "department_id", "visitor_id"])
def test_filter_ids_of_another_company_are_field_errors(host: Api, world: World, name: str) -> None:
    other = {
        "host_id": world.b.employee.id,
        "department_id": world.b.finance.id,
        "visitor_id": world.b.company.id,
    }[name]
    response = host.get("/visits", params={name: str(other)})
    assert response.status_code == 422
    assert set(response.json()["error"]["details"]["fields"]) == {name}


def test_needs_attention(host: Api, world: World, email_provider: MemoryProvider) -> None:
    ok = create_visit(host, world.a.employee.id, START, send_invitation=True)
    email_provider.fail_next(1, transient=False)
    failed = create_visit(host, world.a.employee.id, START, send_invitation=True)
    create_visit(host, world.a.employee.id, START)  # no invitation requested
    assert failed["visit"]["invitation"]["status"] == "PENDING"
    detail = host.get(f"/visits/{failed['visit']['id']}").json()
    assert detail["invitation"]["status"] == "FAILED"
    assert detail["invitation"]["error"] == "Simulated delivery failure."
    attention = host.get("/visits", params={"needs_attention": "true"}).json()
    assert [item["id"] for item in attention["items"]] == [failed["visit"]["id"]]
    assert ok["visit"]["id"] not in {item["id"] for item in attention["items"]}
    assert host.get("/dashboard/employee").json()["counts"]["needs_attention"] == 1


def test_visit_of_another_company_is_not_found(make_client, world: World) -> None:
    visit = create_visit(signed_in(make_client, world.b.employee), world.b.employee.id, START)["visit"]
    admin = signed_in(make_client, world.a.admin)
    for response in (
        admin.get(f"/visits/{visit['id']}"),
        admin.patch(f"/visits/{visit['id']}", json={"purpose": "x"}),
        admin.post(f"/visits/{visit['id']}/cancel", json={}),
        admin.post(f"/visits/{visit['id']}/invitation"),
    ):
        assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert admin.get("/visits/not-a-uuid").status_code == 404


# ---- update / reschedule (D-22) -----------------------------------------------------------------


def test_reschedule_keeps_the_pass_and_tells_the_visitor(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    new_start = START + timedelta(hours=3)
    response = host.patch(
        f"/visits/{visit_id}",
        json={
            "scheduled_start": new_start.isoformat(),
            "scheduled_end": (new_start + timedelta(hours=2)).isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    visit = response.json()
    assert visit["window_start"] == "2026-10-05T09:00:00Z" and visit["window_end"] == "2026-10-05T13:00:00Z"
    assert visit["pass"]["status"] == "ACTIVE"
    passes = db.scalars(select(VisitorPass).where(VisitorPass.visit_id == visit_id)).all()
    assert len(passes) == 1 and passes[0].token_hash == hash_token(pass_token(created["pass_url"]))
    kinds = [email.kind for email in email_provider.sent]
    assert kinds == [
        "VISITOR_INVITATION",
        "VISITOR_CALENDAR",
        "HOST_VISIT_SCHEDULED",
        "VISIT_RESCHEDULED",
        "HOST_VISIT_RESCHEDULED",
    ]
    notice = email_provider.sent[3]
    assert "existing QR code remains valid" in notice.text
    # No QR code (the raw token is never stored), and no logo: this company has none (B12-12).
    assert notice.inline_images == ()
    assert audit_rows(db, "VISIT_UPDATED", entity_id=visit["id"])[-1].meta == {
        "changed_fields": ["scheduled_start", "scheduled_end"]
    }
    assert audit_rows(db, "VISIT_RESCHEDULED", entity_id=visit["id"])[-1].meta["visitor_notified"] is True


def _move_end(api: Api, visit_id: str, minutes: int):
    end = START + timedelta(hours=1, minutes=minutes)
    response = api.patch(f"/visits/{visit_id}", json={"scheduled_end": end.isoformat()})
    assert response.status_code == 200, response.text
    assert response.json()["scheduled_end"] == end.isoformat().replace("+00:00", "Z")  # always saved
    return response


def test_reschedule_notices_are_limited_per_visit(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """Repeated reschedules of one visit cannot bury its visitor in e-mail: 3 notices per visit and hour
    (B24-70); later reschedules are still saved, only without a notice. The host's notices are not in
    that budget (B14-15): every quick correction still moves the host's calendar."""
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    email_provider.clear()
    for minutes in range(1, 6):
        _move_end(host, visit_id, minutes)
    assert [email.kind for email in email_provider.sent] == [
        "VISIT_RESCHEDULED",
        "HOST_VISIT_RESCHEDULED",
    ] * 3 + ["HOST_VISIT_RESCHEDULED"] * 2
    rows = audit_rows(db, "VISIT_RESCHEDULED", entity_id=visit_id)
    assert [row.meta["visitor_notified"] for row in rows] == [True, True, True, False, False]
    assert [row.meta["host_notified"] for row in rows] == [True] * 5
    assert rows[-1].meta["notice_limited_by"] == "reschedule_notices_per_visit"
    assert rows[0].meta["notice_limited_by"] is None
    assert {row.meta["host_notice_limited_by"] for row in rows} == {None}


def test_reschedule_notices_are_limited_per_user(
    app, host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    with rate_limits(app, reschedule_notices_per_user_day=2):
        visits = [
            create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
            for _ in range(3)
        ]
        email_provider.clear()
        for visit_id in visits:
            _move_end(host, visit_id, 30)
    assert [email.kind for email in email_provider.sent] == [
        "VISIT_RESCHEDULED",
        "HOST_VISIT_RESCHEDULED",
    ] * 2 + ["HOST_VISIT_RESCHEDULED"]
    last = audit_rows(db, "VISIT_RESCHEDULED", entity_id=visits[-1])[-1].meta
    assert (
        last["visitor_notified"] is False and last["notice_limited_by"] == "reschedule_notices_per_user_day"
    )
    assert last["host_notified"] is True and last["host_notice_limited_by"] is None


def test_reschedule_notices_do_not_spend_the_invitation_budget(
    app, host: Api, world: World, email_provider: MemoryProvider
) -> None:
    with rate_limits(app, invitations_per_user_day=1):
        visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
        _move_end(host, visit_id, 15)
        refused = host.post("/visits", json=visit_body(world.a.employee.id, START, send_invitation=True))
    assert refused.status_code == 429 and error_code(refused) == "INVITATION_LIMIT"
    assert [email.kind for email in email_provider.sent] == [
        "VISITOR_INVITATION",
        "VISITOR_CALENDAR",
        "HOST_VISIT_SCHEDULED",
        "VISIT_RESCHEDULED",
        "HOST_VISIT_RESCHEDULED",
    ]


def test_reschedule_without_requested_invitation_tells_only_the_host(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    end = START + timedelta(hours=4)
    assert host.patch(f"/visits/{visit_id}", json={"scheduled_end": end.isoformat()}).status_code == 200
    assert [email.kind for email in email_provider.sent] == ["HOST_VISIT_SCHEDULED", "HOST_VISIT_RESCHEDULED"]


def test_update_purpose_and_department(host: Api, world: World, db: Session) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    response = host.patch(
        f"/visits/{visit_id}", json={"purpose": "Contract signing", "department_id": str(world.a.finance.id)}
    )
    assert response.status_code == 200
    assert response.json()["purpose"] == "Contract signing"
    assert response.json()["department"] == {
        "id": str(world.a.finance.id),
        "name": "Finance",
        "name_ar": None,
    }
    cleared = host.patch(f"/visits/{visit_id}", json={"department_id": None})
    assert cleared.json()["department"] is None
    assert host.patch(f"/visits/{visit_id}", json={"purpose": None}).status_code == 422
    other = host.patch(f"/visits/{visit_id}", json={"department_id": str(world.b.finance.id)})
    assert other.status_code == 422 and set(other.json()["error"]["details"]["fields"]) == {"department_id"}


def test_reschedule_validation(host: Api, world: World) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    response = host.patch(f"/visits/{visit_id}", json={"scheduled_end": START.isoformat()})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "scheduled_end": "The end time must be after the start time."
    }
    past = host.patch(
        f"/visits/{visit_id}", json={"scheduled_start": (TEST_START - timedelta(hours=1)).isoformat()}
    )
    assert (
        past.json()["error"]["details"]["fields"]["scheduled_start"]
        == "The start time must not be in the past."
    )


def test_a_visit_under_way_can_have_its_end_moved(host: Api, world: World, clock: FakeClock) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    clock.set(START + timedelta(minutes=30))
    response = host.patch(
        f"/visits/{visit_id}", json={"scheduled_end": (START + timedelta(hours=3)).isoformat()}
    )
    assert response.status_code == 200, response.text


def test_only_scheduled_visits_can_be_changed(host: Api, world: World) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    assert host.post(f"/visits/{visit_id}/cancel", json={}).status_code == 200
    response = host.patch(f"/visits/{visit_id}", json={"purpose": "Too late"})
    assert response.status_code == 409 and error_code(response) == "VISIT_NOT_EDITABLE"
    again = host.post(f"/visits/{visit_id}/cancel", json={})
    assert again.status_code == 409 and error_code(again) == "INVALID_STATE_TRANSITION"
    resend = host.post(f"/visits/{visit_id}/invitation")
    assert resend.status_code == 409 and error_code(resend) == "VISIT_NOT_EDITABLE"


# ---- cancel -------------------------------------------------------------------------------------


def test_cancel_revokes_the_pass_and_notifies(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    response = host.post(f"/visits/{visit_id}/cancel", json={"reason": "Meeting moved online"})
    assert response.status_code == 200
    visit = response.json()
    assert visit["status"] == "CANCELLED"
    assert visit["cancellation_reason"] == "Meeting moved online"
    assert visit["cancelled_by"] == {"id": str(world.a.employee.id), "full_name": "Alpha Employee"}
    assert visit["pass"] == {
        "status": "REVOKED",
        "issued_at": visit["pass"]["issued_at"],
        "revoke_reason": "VISIT_CANCELLED",
    }
    assert not any(visit["permissions"].values())
    cancelled_mail, host_mail = email_provider.sent[-2:]
    assert cancelled_mail.kind == "VISIT_CANCELLED" and "Meeting moved online" in cancelled_mail.text
    assert host_mail.kind == "HOST_VISIT_CANCELLED" and "Meeting moved online" in host_mail.text
    assert audit_rows(db, "PASS_REVOKED")[-1].meta["reason"] == "VISIT_CANCELLED"
    assert audit_rows(db, "VISIT_CANCELLED", entity_id=visit["id"])[-1].meta == {
        "trigger": "user",
        "reason_given": True,
        "visitor_notified": True,
        "email_message_id": str(cancelled_mail.message_id),
        "host_notified": True,
        "host_notice_limited_by": None,
    }


def test_cancel_without_body_or_notification(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    first = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    email_provider.clear()
    assert host.post(f"/visits/{first}/cancel").status_code == 200  # no body: notify by default
    assert [email.kind for email in email_provider.sent] == ["VISIT_CANCELLED", "HOST_VISIT_CANCELLED"]
    second = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    email_provider.clear()
    assert host.post(f"/visits/{second}/cancel", json={"notify_visitor": False}).status_code == 200
    # The visitor's calendar was sent the visit: a cancelled visit always leaves it (B14-16), and the
    # host's calendar entry goes either way (B14-2).
    assert [email.kind for email in email_provider.sent] == ["VISIT_CANCELLED", "HOST_VISIT_CANCELLED"]


def test_cancel_tells_only_visitors_who_were_invited(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """B24-25: a visitor who never got an invitation e-mail gets no cancellation e-mail out of nowhere,
    whatever `notify_visitor` says. Each cancellation notice therefore follows a counted invitation, so
    visits created without one cannot turn cancellations into unmetered e-mails to any address."""
    for _ in range(3):
        visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]  # the visitor has an address
        response = host.post(f"/visits/{visit_id}/cancel", json={"reason": "x" * 300, "notify_visitor": True})
        assert response.status_code == 200
        assert audit_rows(db, "VISIT_CANCELLED", entity_id=visit_id)[-1].meta["visitor_notified"] is False
    assert {email.kind for email in email_provider.sent} == {"HOST_VISIT_SCHEDULED", "HOST_VISIT_CANCELLED"}


def test_history_is_not_rewritten_by_later_changes(host: Api, world: World, make_client) -> None:
    person = {"full_name": "History Guest", "email": "history@example.com", "company_name": "OldCo"}
    first = create_visit(host, world.a.employee.id, START, visitor=person)["visit"]
    second = create_visit(host, world.a.employee.id, START + timedelta(days=1), visitor=person)["visit"]
    third = create_visit(host, world.a.employee.id, START + timedelta(days=2), visitor=person)["visit"]
    host.post(f"/visits/{first['id']}/cancel", json={"reason": "Postponed"})
    host.patch(f"/visits/{second['id']}", json={"purpose": "Changed purpose"})
    after = {
        item["id"]: item for item in host.get(f"/visitors/{first['visitor']['id']}/visits").json()["items"]
    }
    assert after[first["id"]]["status"] == "CANCELLED" and after[first["id"]]["purpose"] == "Quarterly review"
    assert after[second["id"]]["purpose"] == "Changed purpose"
    assert after[third["id"]] | {"updated_at": None} == third | {"updated_at": None}
    # A visitor edit refreshes SCHEDULED visits only; the cancelled one keeps its facts (D-17).
    admin = signed_in(make_client, world.a.admin)
    admin.patch(f"/visitors/{first['visitor']['id']}", json={"company_name": "NewCo"})
    refreshed_visits = {
        item["id"]: item for item in host.get(f"/visitors/{first['visitor']['id']}/visits").json()["items"]
    }
    assert refreshed_visits[first["id"]]["visitor"]["company_name"] == "OldCo"
    assert refreshed_visits[third["id"]]["visitor"]["company_name"] == "NewCo"


# ---- resend (rotation) --------------------------------------------------------------------------


def test_resend_rotates_the_pass(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    response = host.post(f"/visits/{visit_id}/invitation")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["pass_url"] != created["pass_url"]
    passes = db.scalars(
        select(VisitorPass).where(VisitorPass.visit_id == visit_id).order_by(VisitorPass.created_at)
    ).all()
    assert [p.revoke_reason for p in passes] == ["ROTATED", None]
    assert passes[1].token_hash == hash_token(pass_token(result["pass_url"]))
    invitations = [email for email in email_provider.sent if email.kind == "VISITOR_INVITATION"]
    assert [email.pass_url for email in invitations] == [created["pass_url"], result["pass_url"]]
    # Each invitation is followed by its calendar invitation (B14-10), the same event both times.
    calendars = [email.calendar for email in email_provider.sent if email.kind == "VISITOR_CALENDAR"]
    assert [(event.method, event.uid, event.sequence) for event in calendars if event is not None] == [
        ("REQUEST", f"visit-{visit_id}-visitor", 0)
    ] * 2
    assert result["visit"]["invitation"]["status"] == "PENDING"
    assert host.get(f"/visits/{visit_id}").json()["invitation"]["status"] == "SENT"


def test_resend_limit_per_visit(host: Api, world: World) -> None:
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    for _ in range(3):
        assert host.post(f"/visits/{visit_id}/invitation").status_code == 200
    limited = host.post(f"/visits/{visit_id}/invitation")
    assert limited.status_code == 429 and error_code(limited) == "INVITATION_LIMIT"
    assert "Retry-After" in limited.headers


def test_resend_requires_an_email_and_an_open_window(
    host: Api, world: World, clock: FakeClock, db: Session
) -> None:
    no_email = create_visit(host, world.a.employee.id, START, visitor={"full_name": "No Email"})["visit"][
        "id"
    ]
    response = host.post(f"/visits/{no_email}/invitation")
    assert response.status_code == 409 and error_code(response) == "VISITOR_EMAIL_REQUIRED"
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    clock.set(START + timedelta(hours=2, minutes=1))  # past the window end (scheduled end + 60 min)
    expired = host.post(f"/visits/{visit_id}/invitation")
    assert expired.status_code == 409 and error_code(expired) == "VISIT_NOT_EDITABLE"
    assert host.get(f"/visits/{visit_id}").json()["status"] == "NO_SHOW"


def test_email_failure_keeps_the_visit_and_resend_works(
    host: Api, world: World, db: Session, email_provider: MemoryProvider, sleeps: list[float]
) -> None:
    email_provider.fail_next(3, transient=True)
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    detail = host.get(f"/visits/{visit_id}").json()
    assert detail["status"] == "SCHEDULED"
    assert detail["invitation"]["status"] == "FAILED" and detail["invitation"]["attempts"] == 3
    assert sleeps == [1.0, 3.0]
    failed = audit_rows(db, "INVITATION_FAILED", entity_id=visit_id)[-1]
    assert failed.meta["attempts"] == 3 and failed.meta["recipient_domain"] == "example.com"
    resent = host.post(f"/visits/{visit_id}/invitation")
    assert resent.status_code == 200
    assert host.get(f"/visits/{visit_id}").json()["invitation"]["status"] == "SENT"


# ---- isolation and audit hygiene ----------------------------------------------------------------


def test_every_referenced_id_of_another_company_is_refused(make_client, world: World) -> None:
    other_visit = create_visit(signed_in(make_client, world.b.employee), world.b.employee.id, START)["visit"]
    admin = signed_in(make_client, world.a.admin)
    body = visit_body(
        world.b.employee.id,
        START,
        visitor_id=other_visit["visitor"]["id"],
        department_id=str(world.b.finance.id),
    )
    response = admin.post("/visits", json=body)
    assert response.status_code == 422
    assert set(response.json()["error"]["details"]["fields"]) == {"host_id", "visitor_id", "department_id"}
    assert admin.get(f"/visitors/{other_visit['visitor']['id']}/visits").status_code == 404
    assert (
        admin.patch(f"/visitors/{other_visit['visitor']['id']}", json={"full_name": "x"}).status_code == 404
    )


def test_audit_metadata_holds_no_personal_data(host: Api, world: World, db: Session) -> None:
    person = {
        "full_name": "Private Visitor",
        "email": "private.visitor@example.com",
        "phone": "+962 79 987 6543",
        "company_name": "Secret Holdings",
    }
    created = create_visit(
        host, world.a.employee.id, START, visitor=person, send_invitation=True, purpose="Secret merger"
    )
    visit_id = created["visit"]["id"]
    host.patch(f"/visits/{visit_id}", json={"scheduled_end": (START + timedelta(hours=2)).isoformat()})
    host.post(f"/visits/{visit_id}/invitation")
    host.patch(f"/visitors/{created['visit']['visitor']['id']}", json={"email": "moved.visitor@example.com"})
    host.post(f"/visits/{visit_id}/cancel", json={"reason": "Confidential reason"})
    dumped = " ".join(f"{row.action} {row.meta}" for row in db.scalars(select(AuditLog)))
    for fragment in (
        "Private Visitor",
        "private.visitor",
        "moved.visitor",
        "987 6543",
        "Secret",
        "Confidential",
        pass_token(created["pass_url"]),
    ):
        assert fragment not in dumped, fragment
    for action in (
        "VISIT_UPDATED",
        "VISIT_RESCHEDULED",
        "PASS_REVOKED",
        "VISITOR_UPDATED",
        "VISIT_CANCELLED",
    ):
        assert action in dumped, action


# ---- NO_SHOW ------------------------------------------------------------------------------------


def test_no_show_visits_cannot_be_changed(host: Api, world: World, clock: FakeClock) -> None:
    visit_id = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]["id"]
    clock.set(START + timedelta(hours=2, minutes=1))
    assert host.get(f"/visits/{visit_id}").json()["status"] == "NO_SHOW"
    patch = host.patch(f"/visits/{visit_id}", json={"purpose": "Too late"})
    assert patch.status_code == 409 and error_code(patch) == "VISIT_NOT_EDITABLE"
    cancel = host.post(f"/visits/{visit_id}/cancel", json={})
    assert cancel.status_code == 409 and error_code(cancel) == "INVALID_STATE_TRANSITION"
    resend = host.post(f"/visits/{visit_id}/invitation")
    assert resend.status_code == 409 and error_code(resend) == "VISIT_NOT_EDITABLE"


def test_expired_visits_become_no_shows_when_read(
    host: Api, world: World, clock: FakeClock, db: Session
) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    clock.set(START + timedelta(hours=2, minutes=1))  # window end = scheduled end + 60 min
    visit = host.get(f"/visits/{visit_id}").json()
    assert visit["status"] == "NO_SHOW" and visit["no_show_at"] is not None
    assert visit["pass"]["status"] == "EXPIRED"
    [row] = audit_rows(db, "VISIT_MARKED_NO_SHOW", entity_id=visit["id"])
    assert row.actor_user_id is None
    host.get("/visits")
    assert len(audit_rows(db, "VISIT_MARKED_NO_SHOW", entity_id=visit["id"])) == 1  # marked once


def test_window_end_is_the_deadline(host: Api, world: World, clock: FakeClock, db: Session) -> None:
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    clock.set(START + timedelta(hours=2) - timedelta(seconds=1))
    assert host.get(f"/visits/{visit_id}").json()["status"] == "SCHEDULED"
    assert refreshed(db, Visit, visit_id).status == "SCHEDULED"
