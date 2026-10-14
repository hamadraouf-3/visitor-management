"""Visitors API (contract §4 search, §7.5 scope and edit rule, §8 /visitors, D-05, D-17, D-19)."""

from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import Role, Visit, Visitor, VisitorPass
from app.security.tokens import hash_token
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    audit_rows,
    create_visit,
    error_code,
    pass_token,
    rate_limits,
    refreshed,
    signed_in,
    visit_body,
)

START = TEST_START + timedelta(hours=1)
ALEF_HAMZA = "\N{ARABIC LETTER ALEF WITH HAMZA ABOVE}"
ALEF = "\N{ARABIC LETTER ALEF}"
TEH_MARBUTA = "\N{ARABIC LETTER TEH MARBUTA}"
HEH = "\N{ARABIC LETTER HEH}"
FATHA = "\N{ARABIC FATHA}"
TATWEEL = "\N{ARABIC TATWEEL}"


def _arabic(*letters: str) -> str:
    return "".join(letters)


# Names written with the letter variants and marks that search folds away.
AHMAD_STORED = _arabic(
    ALEF_HAMZA, FATHA, "\N{ARABIC LETTER HAH}", "\N{ARABIC LETTER MEEM}", "\N{ARABIC LETTER DAL}"
)
AHMAD_TYPED = _arabic(
    ALEF, "\N{ARABIC LETTER HAH}", TATWEEL, "\N{ARABIC LETTER MEEM}", "\N{ARABIC LETTER DAL}"
)
FATIMA_STORED = _arabic(
    "\N{ARABIC LETTER FEH}", ALEF, "\N{ARABIC LETTER TAH}", "\N{ARABIC LETTER MEEM}", TEH_MARBUTA
)
FATIMA_TYPED = _arabic("\N{ARABIC LETTER FEH}", ALEF, "\N{ARABIC LETTER TAH}", "\N{ARABIC LETTER MEEM}", HEH)
ARABIC_INDIC_PHONE = "".join(chr(0x0660 + int(digit)) for digit in "0791234567")


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


def _create(api: Api, **body) -> dict:
    response = api.post("/visitors", json={"full_name": "Guest Person", **body})
    assert response.status_code == 201, response.text
    return response.json()


# ---- create -------------------------------------------------------------------------------------


def test_create_visitor(reception: Api, world: World, db: Session) -> None:
    visitor = _create(
        reception,
        full_name="  Élodie Martin ",
        email="ELODIE@Example.com",
        phone="+962 79 123 4567",
        company_name="",
    )
    assert visitor["full_name"] == "Élodie Martin"
    assert visitor["email"] == "elodie@example.com"
    assert visitor["company_name"] is None  # '' becomes NULL
    assert visitor["stats"] == {"total_visits": 0, "last_visit_at": None}
    assert visitor["permissions"] == {"can_edit": True}
    stored = refreshed(db, Visitor, visitor["id"])
    assert stored.phone_digits == "962791234567"
    assert stored.search_text == "elodie martin elodie@example.com"
    assert audit_rows(db, "VISITOR_CREATED", entity_id=stored.id)[-1].meta == {
        "source": "visitors_api",
        "has_email": True,
    }


def test_duplicate_email_reveals_the_id_only_to_company_wide_roles(make_client, world: World) -> None:
    reception = signed_in(make_client, world.a.receptionist)
    existing = _create(reception, email="dup@example.com")
    response = reception.post("/visitors", json={"full_name": "Someone Else", "email": "DUP@example.com"})
    assert response.status_code == 409 and error_code(response) == "VISITOR_EXISTS"
    assert response.json()["error"]["details"] == {"visitor_id": existing["id"]}
    employee = signed_in(make_client, world.a.employee)
    hidden = employee.post("/visitors", json={"full_name": "Someone Else", "email": "dup@example.com"})
    assert hidden.status_code == 409 and hidden.json()["error"]["details"] == {}
    # Another company may have a visitor with the same address.
    other = signed_in(make_client, world.b.receptionist)
    assert (
        other.post("/visitors", json={"full_name": "B Guest", "email": "dup@example.com"}).status_code == 201
    )


def test_visitors_without_email_never_collide(reception: Api) -> None:
    first, second = _create(reception), _create(reception)
    assert first["id"] != second["id"]


def test_management_cannot_create_visitors(make_client, world: World) -> None:
    response = signed_in(make_client, world.a.manager).post("/visitors", json={"full_name": "Nope"})
    assert response.status_code == 403


# ---- search (§4) --------------------------------------------------------------------------------


def _search(api: Api, q: str) -> list[str]:
    response = api.get("/visitors", params={"q": q})
    assert response.status_code == 200, response.text
    return [item["full_name"] for item in response.json()["items"]]


def test_search_normalisation(reception: Api) -> None:
    _create(reception, full_name="Élodie Martin", company_name="Société Générale")
    _create(reception, full_name=AHMAD_STORED)
    _create(reception, full_name=FATIMA_STORED, phone=ARABIC_INDIC_PHONE)
    _create(reception, full_name="Phone Person", phone="+962 79 765 4321")
    assert _search(reception, "ELODIE") == ["Élodie Martin"]
    assert _search(reception, "societe gen") == ["Élodie Martin"]
    assert _search(reception, AHMAD_TYPED) == [AHMAD_STORED]
    assert _search(reception, FATIMA_TYPED) == [FATIMA_STORED]
    # Phone: the last nine digits match whatever prefix either side was typed with.
    assert _search(reception, "0797654321") == ["Phone Person"]
    assert _search(reception, "+962797654321") == ["Phone Person"]
    assert _search(reception, "0791234567") == [FATIMA_STORED]
    assert _search(reception, "12345") == []  # fewer than six digits: no phone match
    assert _search(reception, "100%") == []  # LIKE wildcards are literal


def test_search_scope_and_today_visits(make_client, world: World, factory: Factory) -> None:
    employee = signed_in(make_client, world.a.employee)
    mine = create_visit(
        employee, world.a.employee.id, START, visitor={"full_name": "Scope Guest", "email": "s@example.com"}
    )
    create_visit(
        employee,
        world.a.employee.id,
        START + timedelta(days=1),
        visitor={"full_name": "Scope Guest", "email": "s@example.com"},
    )
    other_employee = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    create_visit(
        signed_in(make_client, other_employee),
        other_employee.id,
        START,
        visitor={"full_name": "Scope Hidden"},
    )

    employee_view = employee.get("/visitors", params={"q": "scope"}).json()
    assert [item["full_name"] for item in employee_view["items"]] == ["Scope Guest"]
    [item] = employee_view["items"]
    assert [visit["id"] for visit in item["today_visits"]] == [mine["visit"]["id"]]  # tomorrow's is not today
    assert item["stats"]["total_visits"] == 2

    reception = signed_in(make_client, world.a.receptionist)
    names = [
        entry["full_name"] for entry in reception.get("/visitors", params={"q": "scope"}).json()["items"]
    ]
    assert names == ["Scope Guest", "Scope Hidden"]


def test_visitors_are_listed_by_folded_name(reception: Api, db: Session) -> None:
    """Accented and Arabic names sort where a reader looks for them, not by code point (B24-78): the
    database's C.UTF-8 collation put `Élodie` after `Sarah`, and alef with hamza before the bare alef."""
    ibrahim = _arabic(ALEF, "\N{ARABIC LETTER BEH}", "\N{ARABIC LETTER REH}", ALEF)
    bashir = _arabic(
        "\N{ARABIC LETTER BEH}", "\N{ARABIC LETTER SHEEN}", "\N{ARABIC LETTER YEH}", "\N{ARABIC LETTER REH}"
    )
    names = (
        "Sarah Johnson",
        "Élodie Marchand",
        "Daniel Smith",
        "karim Haddad",
        bashir,
        AHMAD_STORED,
        ibrahim,
    )
    ids = {name: _create(reception, full_name=name)["id"] for name in names}

    def listed() -> list[str]:
        response = reception.get("/visitors")
        assert response.status_code == 200, response.text
        return [item["full_name"] for item in response.json()["items"]]

    assert listed() == [
        "Daniel Smith",
        "Élodie Marchand",
        "karim Haddad",
        "Sarah Johnson",
        ibrahim,
        AHMAD_STORED,
        bashir,
    ]
    assert refreshed(db, Visitor, ids["Élodie Marchand"]).name_sort == "elodie marchand"

    renamed = reception.patch(f"/visitors/{ids['Sarah Johnson']}", json={"full_name": "Aïsha Johnson"})
    assert renamed.status_code == 200, renamed.text
    assert refreshed(db, Visitor, ids["Sarah Johnson"]).name_sort == "aisha johnson"
    assert listed()[0] == "Aïsha Johnson"


def test_search_is_paginated_with_a_stable_order(reception: Api) -> None:
    for _ in range(3):
        _create(reception, full_name="Same Name")
    first = reception.get("/visitors", params={"q": "same", "page_size": 2}).json()
    second = reception.get("/visitors", params={"q": "same", "page_size": 2, "page": 2}).json()
    assert first["total"] == 3 and len(first["items"]) == 2 and len(second["items"]) == 1
    assert {item["id"] for item in first["items"]}.isdisjoint({item["id"] for item in second["items"]})


# ---- read scope ---------------------------------------------------------------------------------


def test_visitor_profile_and_history_are_scoped(make_client, world: World, factory: Factory) -> None:
    employee = signed_in(make_client, world.a.employee)
    other_employee = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    other = signed_in(make_client, other_employee)
    shared = {"full_name": "Shared Guest", "email": "shared@example.com"}
    mine = create_visit(employee, world.a.employee.id, START, visitor=shared)
    visitor_id = mine["visit"]["visitor"]["id"]
    theirs = create_visit(other, other_employee.id, START + timedelta(days=1), visitor=shared)
    assert theirs["visit"]["visitor"]["id"] == visitor_id

    # Each employee sees the visitor (linked to a visit they own) but only their own visits.
    profile = employee.get(f"/visitors/{visitor_id}").json()
    assert profile["stats"]["total_visits"] == 1
    assert [item["id"] for item in employee.get(f"/visitors/{visitor_id}/visits").json()["items"]] == [
        mine["visit"]["id"]
    ]
    admin = signed_in(make_client, world.a.admin)
    assert admin.get(f"/visitors/{visitor_id}").json()["stats"]["total_visits"] == 2
    assert admin.get(f"/visitors/{visitor_id}/visits").json()["total"] == 2

    stranger = signed_in(make_client, factory.user(world.a.company, roles=(Role.EMPLOYEE,)))
    assert stranger.get(f"/visitors/{visitor_id}").status_code == 404
    assert stranger.get(f"/visitors/{visitor_id}/visits").status_code == 404
    assert signed_in(make_client, world.b.admin).get(f"/visitors/{visitor_id}").status_code == 404


# ---- edit rule (§7.5) ---------------------------------------------------------------------------


def test_edit_rule(make_client, world: World, factory: Factory) -> None:
    employee = signed_in(make_client, world.a.employee)
    own = create_visit(employee, world.a.employee.id, START)["visit"]["visitor"]["id"]
    created = _create(employee, full_name="Created By Me")["id"]
    other_employee = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    shared = {"full_name": "Shared", "email": "edit-shared@example.com"}
    shared_id = create_visit(employee, world.a.employee.id, START, visitor=shared)["visit"]["visitor"]["id"]
    create_visit(signed_in(make_client, other_employee), other_employee.id, START, visitor=shared)

    assert employee.get(f"/visitors/{own}").json()["permissions"]["can_edit"] is True
    assert employee.patch(f"/visitors/{own}", json={"phone": "+1 555 0101"}).status_code == 200
    assert employee.patch(f"/visitors/{created}", json={"full_name": "Renamed"}).status_code == 200
    # A visitor who also has a visit owned by someone else is not the employee's to edit.
    assert employee.get(f"/visitors/{shared_id}").json()["permissions"]["can_edit"] is False
    denied = employee.patch(f"/visitors/{shared_id}", json={"full_name": "Mine Now"})
    assert denied.status_code == 403 and error_code(denied) == "FORBIDDEN"

    reception = signed_in(make_client, world.a.receptionist)
    assert reception.get(f"/visitors/{shared_id}").json()["permissions"]["can_edit"] is True
    assert reception.patch(f"/visitors/{shared_id}", json={"full_name": "Fixed Name"}).status_code == 200
    management = signed_in(make_client, world.a.manager)
    assert management.get(f"/visitors/{shared_id}").json()["permissions"]["can_edit"] is False
    assert management.patch(f"/visitors/{shared_id}", json={"full_name": "x"}).status_code == 403
    stranger = signed_in(make_client, factory.user(world.a.company, roles=(Role.EMPLOYEE,)))
    assert stranger.patch(f"/visitors/{own}", json={"full_name": "x"}).status_code == 404


def test_edit_validation_and_conflicts(reception: Api, world: World) -> None:
    first = _create(reception, email="one@example.com")
    second = _create(reception, email="two@example.com")
    conflict = reception.patch(f"/visitors/{second['id']}", json={"email": "One@example.com"})
    assert conflict.status_code == 409 and error_code(conflict) == "VISITOR_EXISTS"
    assert conflict.json()["error"]["details"] == {"visitor_id": first["id"]}
    assert reception.patch(f"/visitors/{second['id']}", json={"full_name": None}).status_code == 422
    assert reception.patch(f"/visitors/{second['id']}", json={"email": "not-an-email"}).status_code == 422
    cleared = reception.patch(f"/visitors/{second['id']}", json={"email": None, "phone": ""})
    assert cleared.status_code == 200 and cleared.json()["email"] is None and cleared.json()["phone"] is None


def test_visitor_edit_refreshes_scheduled_snapshots(make_client, world: World, db: Session) -> None:
    employee = signed_in(make_client, world.a.employee)
    visit = create_visit(
        employee, world.a.employee.id, START, visitor={"full_name": "Old Name", "company_name": "Old Co"}
    )
    visitor_id = visit["visit"]["visitor"]["id"]
    response = employee.patch(
        f"/visitors/{visitor_id}", json={"full_name": "New Name", "company_name": "New Co"}
    )
    assert response.status_code == 200
    detail = employee.get(f"/visits/{visit['visit']['id']}").json()
    assert detail["visitor"] == {"id": visitor_id, "full_name": "New Name", "company_name": "New Co"}
    assert audit_rows(db, "VISITOR_UPDATED", entity_id=visitor_id)[-1].meta == {
        "changed_fields": ["full_name", "company_name"]
    }


# ---- D-19 ---------------------------------------------------------------------------------------


def test_email_change_revokes_and_reissues_passes(
    make_client, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    employee = signed_in(make_client, world.a.employee)
    person = {"full_name": "Moving Guest", "email": "old@example.com"}
    first = create_visit(employee, world.a.employee.id, START, visitor=person, send_invitation=True)
    second = create_visit(employee, world.a.employee.id, START + timedelta(days=1), visitor=person)
    cancelled = create_visit(employee, world.a.employee.id, START + timedelta(days=2), visitor=person)
    employee.post(f"/visits/{cancelled['visit']['id']}/cancel", json={"notify_visitor": False})
    email_provider.clear()
    visitor_id = first["visit"]["visitor"]["id"]

    response = employee.patch(f"/visitors/{visitor_id}", json={"email": "new@example.com"})
    assert response.status_code == 200, response.text
    # Both SCHEDULED visits: old pass revoked (VISITOR_EMAIL_CHANGED), new pass sent to the new address.
    assert sorted(email.to for email in email_provider.sent) == ["new@example.com", "new@example.com"]
    for result in (first, second):
        visit_id = result["visit"]["id"]
        passes = db.scalars(
            select(VisitorPass).where(VisitorPass.visit_id == visit_id).order_by(VisitorPass.created_at)
        ).all()
        assert [p.revoke_reason for p in passes] == ["VISITOR_EMAIL_CHANGED", None]
        assert passes[0].token_hash == hash_token(pass_token(result["pass_url"]))
        detail = employee.get(f"/visits/{visit_id}").json()
        assert detail["invitation"]["to_email"] == "new@example.com"
        assert detail["invitation"]["status"] == "SENT"
    sent_urls = {email.pass_url for email in email_provider.sent}
    assert first["pass_url"] not in sent_urls and second["pass_url"] not in sent_urls
    # The cancelled visit is untouched.
    cancelled_passes = db.scalars(
        select(VisitorPass).where(VisitorPass.visit_id == cancelled["visit"]["id"])
    ).all()
    assert [p.revoke_reason for p in cancelled_passes] == ["VISIT_CANCELLED"]


def test_email_change_beyond_the_invitation_budget_writes_and_counts_nothing(
    app, make_client, world: World, db: Session
) -> None:
    """D-19 re-sends are reserved together (B24-16): a refusal leaves the visitor, the passes and the
    editor's remaining invitation budget exactly as they were."""
    employee = signed_in(make_client, world.a.employee)
    person = {"full_name": "Budget Guest", "email": "budget@example.com"}
    with rate_limits(app, invitations_per_user_day=3):
        first = create_visit(employee, world.a.employee.id, START, visitor=person, send_invitation=True)
        for day in (1, 2):  # without an invitation: no budget spent
            create_visit(employee, world.a.employee.id, START + timedelta(days=day), visitor=person)
        visitor_id = first["visit"]["visitor"]["id"]

        refused = employee.patch(f"/visitors/{visitor_id}", json={"email": "moved@example.com"})
        assert refused.status_code == 429 and error_code(refused) == "INVITATION_LIMIT"  # 3 re-sends, 2 left
        assert employee.get(f"/visitors/{visitor_id}").json()["email"] == "budget@example.com"
        assert employee.get(f"/visits/{first['visit']['id']}").json()["pass"]["status"] == "ACTIVE"

        for _ in range(2):  # both remaining invitations are still there
            create_visit(employee, world.a.employee.id, START, send_invitation=True)
        spent = employee.post("/visits", json=visit_body(world.a.employee.id, START, send_invitation=True))
    assert spent.status_code == 429


def test_more_re_sends_than_the_daily_budget_holds_are_refused_with_what_to_do(
    app, make_client, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    """SEC-44: a visitor with more SCHEDULED visits than INVITATION_DAILY_LIMIT (visits booked without an
    invitation cost nothing) needs more re-sends (D-19) than the editor's daily budget can ever hold.
    The address change answered 429 INVITATION_LIMIT with a Retry-After of a day, for every editor and
    for good. It is now a 422 on `email` that says what to do; nothing is written or spent."""
    employee = signed_in(make_client, world.a.employee)
    admin = signed_in(make_client, world.a.admin)
    person = {"full_name": "Long Contract", "email": "contract@example.com"}
    with rate_limits(app, invitations_per_user_day=3):
        visits = [
            create_visit(employee, world.a.employee.id, START + timedelta(days=day), visitor=person)["visit"]
            for day in range(4)
        ]
        visitor_id = visits[0]["visitor"]["id"]
        email_provider.clear()

        refused = admin.patch(f"/visitors/{visitor_id}", json={"email": "contract.correct@example.com"})
        assert refused.status_code == 422 and error_code(refused) == "VALIDATION_ERROR", refused.text
        assert "Retry-After" not in refused.headers
        message = refused.json()["error"]["details"]["fields"]["email"]
        assert "4 scheduled visits" in message and "at most 3 invitations" in message
        assert admin.get(f"/visitors/{visitor_id}").json()["email"] == "contract@example.com"
        assert {admin.get(f"/visits/{visit['id']}").json()["pass"]["status"] for visit in visits} == {
            "ACTIVE"
        }
        assert email_provider.sent == [] and audit_rows(db, "VISITOR_UPDATED") == []
        assert audit_rows(db, "RATE_LIMITED") == []

        # Once the visits fit the budget, the change is made and spends it (the refusal spent nothing).
        admin.post(f"/visits/{visits[3]['id']}/cancel", json={"notify_visitor": False})
        changed = admin.patch(f"/visitors/{visitor_id}", json={"email": "contract.correct@example.com"})
        assert changed.status_code == 200, changed.text
        assert len([sent for sent in email_provider.sent if sent.to == "contract.correct@example.com"]) == 3
        spent = admin.post("/visits", json=visit_body(world.a.employee.id, START, send_invitation=True))
        assert spent.status_code == 429 and error_code(spent) == "INVITATION_LIMIT"


def test_visitor_edit_marks_ended_visits_before_refreshing_snapshots(
    make_client, world: World, db: Session, clock: FakeClock
) -> None:
    """§5: the edit marks visits whose window ended NO_SHOW first; their snapshot stays as it was."""
    employee = signed_in(make_client, world.a.employee)
    person = {"full_name": "Before Rename", "email": "rename@example.com"}
    ended = create_visit(employee, world.a.employee.id, START, visitor=person)["visit"]
    upcoming = create_visit(employee, world.a.employee.id, START + timedelta(days=1), visitor=person)["visit"]
    clock.set(START + timedelta(hours=2, minutes=1))  # past the first window; nothing has read it since
    response = employee.patch(f"/visitors/{ended['visitor']['id']}", json={"full_name": "After Rename"})
    assert response.status_code == 200, response.text
    expired = refreshed(db, Visit, ended["id"])
    assert (expired.status, expired.visitor_name) == ("NO_SHOW", "Before Rename")
    assert refreshed(db, Visit, upcoming["id"]).visitor_name == "After Rename"


def test_clearing_the_email_only_revokes(make_client, world: World, db: Session, email_provider) -> None:
    employee = signed_in(make_client, world.a.employee)
    result = create_visit(
        employee, world.a.employee.id, START, visitor={"full_name": "Gone", "email": "gone@example.com"}
    )
    email_provider.clear()
    response = employee.patch(f"/visitors/{result['visit']['visitor']['id']}", json={"email": None})
    assert response.status_code == 200
    assert email_provider.sent == []
    detail = employee.get(f"/visits/{result['visit']['id']}").json()
    assert (
        detail["pass"]["status"] == "REVOKED" and detail["pass"]["revoke_reason"] == "VISITOR_EMAIL_CHANGED"
    )
    assert detail["permissions"]["can_resend"] is False


def test_other_changes_keep_the_passes(make_client, world: World, db: Session) -> None:
    employee = signed_in(make_client, world.a.employee)
    result = create_visit(employee, world.a.employee.id, START)
    employee.patch(f"/visitors/{result['visit']['visitor']['id']}", json={"phone": "+962 79 000 1111"})
    assert employee.get(f"/visits/{result['visit']['id']}").json()["pass"]["status"] == "ACTIVE"
