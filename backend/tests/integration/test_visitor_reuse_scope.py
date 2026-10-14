"""Inline reuse of a visitor by e-mail (contract §7.5, D-05, decisions B24-15, B57-01 and B57-70).

An EMPLOYEE-only user who types the address and the name of a visitor they cannot read gets a visit
linked to that visitor, and nothing else: not the stored details (in the response, the profile, search,
or the visit's snapshot later), not the right to edit the record, and not a search oracle on its stored
fields. With another name the visit is refused, for every caller and for walk-ins as well as
invitations: nobody can put a visit, and with it a check-in, on someone's record under another name.
"""

import uuid
from datetime import timedelta

import httpx
import pytest
from sqlalchemy.orm import Session

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
    refreshed,
    signed_in,
    visit_body,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)
STORED = {
    "full_name": "Élodie Renamed-Gate",
    "email": "elodie.gate@example.com",
    "phone": "+962 79 555 1234",
    "company_name": "Acme Gate Testing",
}
# The stored name as an employee might type it: the same once folded (case, accents, spacing).
TYPED = {
    "full_name": "ELODIE  renamed-gate",
    "email": "ELODIE.GATE@example.com",
    "phone": "+1 555 0100",
    "company_name": "Typed Co",
}


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


@pytest.fixture
def employee(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def stored_id(reception: Api) -> str:
    """A visitor reception registered: it has no visits, so before B24-15 a reuse made it editable."""
    response = reception.post("/visitors", json=STORED)
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.fixture
def reused(employee: Api, world: World, stored_id: str) -> dict:
    result = create_visit(employee, world.a.employee.id, START, visitor=TYPED, send_invitation=True)
    assert result["visitor_match"] == {"reused": True}
    assert result["visit"]["visitor"]["id"] == stored_id
    return result


def _names(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["full_name"] for item in response.json()["items"]]


def test_the_response_reveals_nothing_stored(reused: dict) -> None:
    visit = reused["visit"]
    assert visit["visitor"]["full_name"] == TYPED["full_name"]
    assert visit["visitor"]["company_name"] == "Typed Co"
    for stored in ("Élodie", "Renamed-Gate", "555 1234", "Acme Gate"):
        assert stored not in str(reused)


def test_the_link_gives_no_read_access(employee: Api, reused: dict, stored_id: str) -> None:
    assert employee.get(f"/visitors/{stored_id}").status_code == 404
    assert employee.get(f"/visitors/{stored_id}/visits").status_code == 404
    for q in ("elodie", "renamed", "acme gate", "0795551234", "elodie.gate@example.com"):
        assert _names(employee.get("/visitors", params={"q": q})) == [], q


def test_the_link_gives_no_edit_access_and_cannot_be_reused_by_id(
    employee: Api, world: World, reused: dict, stored_id: str, db: Session
) -> None:
    denied = employee.patch(
        f"/visitors/{stored_id}", json={"full_name": "Taken Over", "email": "me@example.com"}
    )
    assert denied.status_code == 404
    stored = refreshed(db, Visitor, stored_id)
    assert (stored.full_name, stored.email) == ("Élodie Renamed-Gate", "elodie.gate@example.com")
    assert stored.phone == "+962 79 555 1234" and stored.company_name == "Acme Gate Testing"  # nothing filled
    by_id = employee.post("/visits", json=visit_body(world.a.employee.id, START, visitor_id=stored_id))
    assert by_id.status_code == 422 and set(by_id.json()["error"]["details"]["fields"]) == {"visitor_id"}
    filtered = employee.get("/visits", params={"visitor_id": stored_id})
    assert filtered.status_code == 422


def test_visit_search_matches_only_the_typed_snapshot(
    employee: Api, make_client, world: World, reused: dict
) -> None:
    visit_id = reused["visit"]["id"]
    for q in ("typed co", "elodie"):  # what the employee typed
        assert [item["id"] for item in employee.get("/visits", params={"q": q}).json()["items"]] == [visit_id]
    # The stored company and phone are no oracle for the employee, whether the query is long enough
    # for the trigram indexes or not ("ac" takes the single filtered pass) ...
    for q in ("acme gate", "0795551234", "555 1234", "ac"):
        assert employee.get("/visits", params={"q": q}).json()["items"] == [], q
    # ... while roles that read every visitor still find the visit through the stored record.
    admin = signed_in(make_client, world.a.admin)
    for q in ("acme gate", "ac"):
        found = [item["id"] for item in admin.get("/visits", params={"q": q}).json()["items"]]
        assert visit_id in found, q


def test_the_snapshot_keeps_what_was_typed(
    employee: Api, reception: Api, reused: dict, stored_id: str, db: Session
) -> None:
    visit_id = reused["visit"]["id"]
    # A change of the employee's own visit refreshes snapshots from their sources (D-17), but not from
    # a visitor record the employee may not read.
    changed = employee.patch(f"/visits/{visit_id}", json={"purpose": "Changed purpose"})
    assert changed.status_code == 200
    assert changed.json()["visitor"] == {
        "id": stored_id,
        "full_name": TYPED["full_name"],
        "company_name": "Typed Co",
    }
    # Nor does an edit of the stored record by someone who may make it.
    assert (
        reception.patch(
            f"/visitors/{stored_id}", json={"full_name": "Élodie Gate", "company_name": "Gate Ltd"}
        ).status_code
        == 200
    )
    visit = refreshed(db, Visit, visit_id)
    assert (visit.visitor_name, visit.visitor_company_name) == (TYPED["full_name"], "Typed Co")
    assert visit.visitor_link_in_scope is False


def test_the_invitation_goes_to_the_typed_address(reused: dict) -> None:
    assert reused["visit"]["invitation"]["to_email"] == "elodie.gate@example.com"


def test_reuse_is_audited(reused: dict, db: Session) -> None:
    [row] = audit_rows(db, "VISIT_CREATED", entity_id=reused["visit"]["id"])
    assert row.meta["visitor_reused"] is True and row.meta["visitor_link_in_scope"] is False


def test_a_visitor_in_scope_through_another_link_stays_readable(
    make_client, world: World, factory: Factory, stored_id: str, reused: dict
) -> None:
    """A colleague who may read the visitor invites them on the employee's behalf (D-02): that link is in
    scope, so the employee now reads the visitor as §7.5 says, and reuse fills nothing in their name."""
    colleague = factory.user(world.a.company, roles=(Role.SYSTEM_ADMIN,))
    on_behalf = create_visit(
        signed_in(make_client, colleague), world.a.employee.id, START, visitor_id=stored_id
    )
    employee = signed_in(make_client, world.a.employee)
    profile = employee.get(f"/visitors/{stored_id}")
    assert profile.status_code == 200 and profile.json()["full_name"] == "Élodie Renamed-Gate"
    history = {item["id"] for item in employee.get(f"/visitors/{stored_id}/visits").json()["items"]}
    assert history == {reused["visit"]["id"], on_behalf["visit"]["id"]}


# ---- another name (B57-01) ------------------------------------------------------------------------


@pytest.mark.parametrize("typed_name", ["Impostor Name", "Elodie Gate", "Élodie Renamed-Gate Junior"])
def test_another_name_is_refused_without_revealing_anything(
    employee: Api, world: World, stored_id: str, db: Session, typed_name: str
) -> None:
    response = employee.post(
        "/visits",
        json=visit_body(
            world.a.employee.id,
            START,
            visitor={**TYPED, "full_name": typed_name},
            send_invitation=True,
        ),
    )
    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "VISITOR_EXISTS" and error["details"] == {}
    assert "different name" in error["message"]
    for stored in ("Élodie", "Renamed-Gate", "555 1234", "Acme Gate", stored_id):
        assert stored not in response.text
    # Nothing was written: no visit, no fill, no invitation; the attempt itself is audited.
    assert db.query(Visit).filter(Visit.visitor_id == stored_id).count() == 0
    stored = refreshed(db, Visitor, stored_id)
    assert stored.phone == "+962 79 555 1234" and stored.company_name == "Acme Gate Testing"
    [row] = audit_rows(db, "VISITOR_LINK_REFUSED")
    assert row.entity_id is not None and str(row.entity_id) == stored_id
    assert row.actor_user_id == world.a.employee.id and row.company_id == world.a.company.id
    assert row.meta == {"reason": "name_mismatch"}
    assert audit_rows(db, "VISIT_CREATED") == []


def test_the_impostor_scenario_cannot_put_a_visit_on_the_real_record(
    employee: Api, reception: Api, world: World, stored_id: str
) -> None:
    """The verification finding: an employee who knows the address books a visit under another name,
    and reception's "Verify ID" would check the bearer against that name on the real person's record."""
    impostor = employee.post(
        "/visits",
        json=visit_body(
            world.a.employee.id,
            START,
            visitor={"full_name": "Impostor Name", "email": STORED["email"]},
        ),
    )
    assert impostor.status_code == 409
    history = reception.get(f"/visitors/{stored_id}/visits").json()
    assert history["total"] == 0


# ---- another name, for callers who read the visitor (B57-70) --------------------------------------

JANE = {"full_name": "Jane Realperson", "email": "jane.real@example.com"}
IMPOSTOR = {
    "full_name": "John Impostor",
    "email": JANE["email"],
    "phone": "+1 555 0100",
    "company_name": "Shady Ltd",
}


@pytest.fixture
def jane(employee: Api, world: World) -> dict:
    """A registered visitor without phone or company, with a SCHEDULED visit today."""
    return create_visit(employee, world.a.employee.id, START, visitor=JANE, send_invitation=True)


def _walk_in(api: Api, world: World, **source: object) -> httpx.Response:
    body = walk_in_body(world.a.employee.id, START + timedelta(hours=2), **source)
    return api.post("/reception/walk-ins", json=body)


def _refused_without_a_trace(
    response: httpx.Response, db: Session, jane: dict, *, actor_id: uuid.UUID
) -> None:
    """409 VISITOR_EXISTS, and nothing was linked or written: no visit, no filled field, no snapshot
    change; the refusal itself is audited."""
    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "VISITOR_EXISTS"
    visitor_id = jane["visit"]["visitor"]["id"]
    assert [visit.id for visit in db.query(Visit).filter(Visit.visitor_id == visitor_id)] == [
        uuid.UUID(jane["visit"]["id"])
    ]
    stored = refreshed(db, Visitor, visitor_id)
    assert (stored.full_name, stored.phone, stored.phone_digits, stored.company_name) == (
        JANE["full_name"],
        None,
        None,
        None,
    )
    scheduled = refreshed(db, Visit, jane["visit"]["id"])
    assert (scheduled.visitor_name, scheduled.visitor_company_name) == (JANE["full_name"], None)
    [row] = audit_rows(db, "VISITOR_LINK_REFUSED")
    assert str(row.entity_id) == visitor_id and row.actor_user_id == actor_id
    assert row.meta == {"reason": "name_mismatch"}
    assert audit_rows(db, "VISITOR_UPDATED") == []


def test_a_walk_in_under_another_name_is_not_put_on_the_registered_visitor(
    reception: Api, world: World, jane: dict, db: Session
) -> None:
    """The verification finding: reception registers "John Impostor" with Jane's address. Before, the
    walk-in was checked in as Jane, filled her empty phone and company (and with D-17 her scheduled
    visit's snapshot), listed her as inside and blocked her own check-in."""
    response = _walk_in(reception, world, visitor=IMPOSTOR)
    _refused_without_a_trace(response, db, jane, actor_id=world.a.receptionist.id)
    error = response.json()["error"]
    visitor_id = jane["visit"]["visitor"]["id"]
    assert error["details"] == {"visitor_id": visitor_id}  # reception reads every visitor (B24-14)
    assert error["message"] == (
        "This email address belongs to the registered visitor “Jane Realperson”. "
        "Select that visitor, or correct the email."
    )
    assert audit_rows(db, "WALK_IN_CREATED") == []
    assert reception.get("/reception/inside").json()["count"] == 0
    # Jane herself is not blocked, and "Use registered visitor" (the same walk-in by ID) works.
    assert check_in(reception, jane["visit"]["id"]).status_code == 200
    assert check_out(reception, jane["visit"]["id"]).status_code == 200
    by_id = _walk_in(reception, world, visitor=None, visitor_id=visitor_id)
    assert by_id.status_code == 201, by_id.text
    assert by_id.json()["visitor"] == {"id": visitor_id, "full_name": JANE["full_name"], "company_name": None}


def test_a_walk_in_under_the_registered_name_links_and_fills_empty_fields(
    reception: Api, world: World, jane: dict, db: Session
) -> None:
    """The same name, however it is typed (case, accents, spacing), is the registered visitor (D-05)."""
    response = _walk_in(reception, world, visitor={**IMPOSTOR, "full_name": "  JANE   realperson "})
    assert response.status_code == 201, response.text
    visitor_id = jane["visit"]["visitor"]["id"]
    assert response.json()["visitor"] == {
        "id": visitor_id,
        "full_name": JANE["full_name"],
        "company_name": "Shady Ltd",
    }
    stored = refreshed(db, Visitor, visitor_id)
    assert (stored.phone, stored.company_name) == ("+1 555 0100", "Shady Ltd")
    assert [row.meta["visitor_reused"] for row in audit_rows(db, "WALK_IN_CREATED")] == [True]
    assert audit_rows(db, "VISITOR_LINK_REFUSED") == []


@pytest.mark.parametrize("roles", [(Role.SYSTEM_ADMIN,), (Role.MANAGEMENT, Role.EMPLOYEE)])
def test_an_invitation_under_another_name_is_refused_for_readers_of_every_visitor(
    make_client, world: World, factory: Factory, jane: dict, db: Session, roles: tuple[Role, ...]
) -> None:
    """Callers who read every visitor (B24-76 linked under the stored name whatever was typed) are refused
    too: the invitation, its pass and the visit would otherwise go to the registered visitor's address and
    record for someone else. They are told whose address it is."""
    caller = factory.user(world.a.company, roles=roles)
    response = signed_in(make_client, caller).post(
        "/visits", json=visit_body(caller.id, START, visitor=IMPOSTOR, send_invitation=True)
    )
    _refused_without_a_trace(response, db, jane, actor_id=caller.id)
    error = response.json()["error"]
    assert error["details"] == {"visitor_id": jane["visit"]["visitor"]["id"]}
    assert "“Jane Realperson”" in error["message"]
    assert audit_rows(db, "VISIT_CREATED", actor_user_id=caller.id) == []
    assert audit_rows(db, "INVITATION_QUEUED", actor_user_id=caller.id) == []


def test_an_employee_who_reads_the_visitor_is_refused_without_details(
    employee: Api, world: World, jane: dict, db: Session
) -> None:
    """The employee invited Jane, so Jane is in their scope; §7.5 still gives EMPLOYEE-only callers a 409
    VISITOR_EXISTS without an ID or data. The visitor picker finds Jane for them."""
    response = employee.post("/visits", json=visit_body(world.a.employee.id, START, visitor=IMPOSTOR))
    _refused_without_a_trace(response, db, jane, actor_id=world.a.employee.id)
    error = response.json()["error"]
    assert error["details"] == {}
    assert "different name" in error["message"] and "Jane" not in error["message"]


# ---- a role change leaves no residual ownership (SEC-08) ------------------------------------------


def test_a_receptionist_moved_to_employee_keeps_nothing_registered_at_the_desk(
    make_client, world: World, db: Session
) -> None:
    """The finding: a receptionist registered walk-ins and visitors at the desk (created_by = them), was
    moved to an EMPLOYEE-only role, and kept reading and editing all of those people. Registration in a
    role that reads every visitor puts nothing in the registering user's own scope; a walk-in belongs
    to its host."""
    desk = signed_in(make_client, world.a.receptionist)
    walk_in = desk.post(
        "/reception/walk-ins",
        json=walk_in_body(
            world.a.admin.id,
            TEST_START + timedelta(hours=2),
            visitor={
                "full_name": "Desk Walker",
                "email": "desk.walker@example.com",
                "phone": "+962 79 000 1111",
            },
        ),
    )
    assert walk_in.status_code == 201, walk_in.text
    walker_id = walk_in.json()["visitor"]["id"]
    assert check_out(desk, walk_in.json()["id"]).status_code == 200
    standalone = desk.post("/visitors", json={"full_name": "Desk Registered", "phone": "+962 79 000 2222"})
    assert standalone.status_code == 201
    standalone_id = standalone.json()["id"]
    assert refreshed(db, Visitor, uuid.UUID(walker_id)).owned_by_creator is False

    admin = signed_in(make_client, world.a.admin)
    moved = admin.patch(f"/users/{world.a.receptionist.id}", json={"roles": ["EMPLOYEE"]})
    assert moved.status_code == 200, moved.text

    former = signed_in(make_client, world.a.receptionist)
    assert former.get("/visitors").json()["total"] == 0
    assert former.get("/visits").json()["total"] == 0
    for visitor_id in (walker_id, standalone_id):
        assert former.get(f"/visitors/{visitor_id}").status_code == 404
        assert former.patch(f"/visitors/{visitor_id}", json={"phone": "+962 79 999 0000"}).status_code == 404
    # The walk-in's host still has it; the administrator still reads everything.
    assert admin.get(f"/visitors/{walker_id}").status_code == 200
    assert admin.get(f"/visitors/{standalone_id}").status_code == 200

    # What the former receptionist creates as an employee is theirs, as before.
    own = former.post("/visitors", json={"full_name": "Own Contact"})
    assert own.status_code == 201
    assert former.get(f"/visitors/{own.json()['id']}").status_code == 200
    assert refreshed(db, Visitor, uuid.UUID(own.json()["id"])).owned_by_creator is True
