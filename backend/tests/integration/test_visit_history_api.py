"""The company-wide history page (D-25): GET /visits with `scope=all` for RECEPTIONIST, MANAGEMENT and
SYSTEM_ADMIN, with every filter of §8 (multi-value status, company-local dates, host, department,
visitor, `q` on the visit's snapshots) and stable paging."""

from datetime import UTC, datetime, timedelta

import pytest

from app.core.time import FakeClock
from app.models import Role
from tests.support import Api, Factory, World, check_in, check_out, create_visit, signed_in

COMPANY_WIDE = [Role.RECEPTIONIST, Role.MANAGEMENT, Role.SYSTEM_ADMIN]


@pytest.fixture
def history(make_client, world: World, factory: Factory, clock: FakeClock) -> dict:
    """Visits of two hosts across a company-local midnight (Asia/Amman, UTC+3) in every state."""
    colleague = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Colleague Host")
    host = signed_in(make_client, world.a.employee)
    other_host = signed_in(make_client, colleague)
    late_5th = datetime(2026, 10, 5, 20, 30, tzinfo=UTC)  # 23:30 on the 5th in Amman
    early_6th = datetime(2026, 10, 5, 21, 30, tzinfo=UTC)  # 00:30 on the 6th
    visits = {
        "late_5th": create_visit(
            host,
            world.a.employee.id,
            late_5th,
            visitor={"full_name": "Nadia Late", "company_name": "Orbit Ltd"},
        ),
        "early_6th": create_visit(
            other_host,
            colleague.id,
            early_6th,
            department_id=str(world.a.finance.id),
            visitor={"full_name": "Omar Early", "email": "omar.early@example.com"},
        ),
        "cancelled": create_visit(
            host, world.a.employee.id, early_6th, visitor={"full_name": "Cancelled Person"}
        ),
        "morning": create_visit(
            host,
            world.a.employee.id,
            datetime(2026, 10, 5, 7, 0, tzinfo=UTC),
            visitor={"full_name": "Morning Mo"},
        ),
    }
    host.post(f"/visits/{visits['cancelled']['visit']['id']}/cancel", json={})
    reception = signed_in(make_client, world.a.receptionist)
    check_in(reception, visits["morning"]["visit"]["id"])
    check_out(reception, visits["morning"]["visit"]["id"])
    clock.set(late_5th + timedelta(minutes=5))
    check_in(signed_in(make_client, world.a.receptionist), visits["late_5th"]["visit"]["id"])
    # Another company's visit, which nobody in company A may find.
    create_visit(
        signed_in(make_client, world.b.employee),
        world.b.employee.id,
        early_6th,
        visitor={"full_name": "Nadia Other"},
    )
    return {name: created["visit"]["id"] for name, created in visits.items()} | {"colleague": colleague}


def _ids(api: Api, **params) -> list[str]:
    response = api.get("/visits", params={"scope": "all", **params})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == len(body["items"])
    return [item["id"] for item in body["items"]]


@pytest.mark.parametrize("role", COMPANY_WIDE, ids=lambda role: role.value)
def test_company_wide_history_filters(make_client, world: World, history: dict, role: Role) -> None:
    api = signed_in(make_client, world.a.users_by_role[role])
    everything = _ids(api)
    assert set(everything) == {history[name] for name in ("late_5th", "early_6th", "cancelled", "morning")}
    assert everything[0] in (history["early_6th"], history["cancelled"])  # newest first by default
    # Several statuses at once, comma-separated or repeated.
    in_or_out = {history["late_5th"], history["morning"]}
    assert set(_ids(api, status="CHECKED_IN,CHECKED_OUT")) == in_or_out
    assert set(_ids(api, status=["CHECKED_IN", "CHECKED_OUT"])) == in_or_out
    # Company-local days: 23:30 on the 5th is the 5th, 00:30 on the 6th is the 6th.
    assert set(_ids(api, date_from="2026-10-05", date_to="2026-10-05")) == {
        history["late_5th"],
        history["morning"],
    }
    assert set(_ids(api, date_from="2026-10-06")) == {history["early_6th"], history["cancelled"]}
    assert _ids(api, date_to="2026-10-04") == []
    # Host, department and visitor.
    assert _ids(api, host_id=str(history["colleague"].id)) == [history["early_6th"]]
    assert _ids(api, department_id=str(world.a.finance.id)) == [history["early_6th"]]
    visitor_id = api.get(f"/visits/{history['early_6th']}").json()["visitor"]["id"]
    assert _ids(api, visitor_id=visitor_id) == [history["early_6th"]]
    # Free text on the visit's snapshots: visitor name, visitor company, host name.
    assert _ids(api, q="nadia") == [history["late_5th"]]  # not the other company's Nadia
    assert _ids(api, q="orbit") == [history["late_5th"]]
    assert _ids(api, q="colleague host") == [history["early_6th"]]
    # Filters combine.
    assert _ids(api, status="CANCELLED", date_from="2026-10-06", q="cancelled") == [history["cancelled"]]
    # Oldest first on request; ties broken by id so pages are stable.
    ascending = _ids(api, order="asc")
    assert ascending[0] == history["morning"] and set(ascending) == set(everything)


@pytest.mark.parametrize("role", COMPANY_WIDE, ids=lambda role: role.value)
def test_short_queries_search_the_same_fields(make_client, world: World, history: dict, role: Role) -> None:
    # One or two characters have no trigram to look up, so the search takes a single filtered pass
    # instead of the indexed parts; it must find exactly the same things.
    api = signed_in(make_client, world.a.users_by_role[role])
    assert _ids(api, q="ea") == [history["early_6th"]]  # "Omar Early", host "Colleague Host"
    assert _ids(api, q="@e") == [history["early_6th"]]  # only in the stored visitor's e-mail address
    assert _ids(api, q="ad") == [history["late_5th"]]  # "Nadia Late", not the other company's Nadia
    assert _ids(api, q="mo", status="CHECKED_OUT") == [history["morning"]]


@pytest.mark.parametrize("role", COMPANY_WIDE, ids=lambda role: role.value)
def test_company_wide_history_pages(make_client, world: World, history: dict, role: Role) -> None:
    api = signed_in(make_client, world.a.users_by_role[role])
    first = api.get("/visits", params={"scope": "all", "page_size": 3}).json()
    second = api.get("/visits", params={"scope": "all", "page_size": 3, "page": 2}).json()
    assert first["total"] == second["total"] == 4
    assert len(first["items"]) == 3 and len(second["items"]) == 1
    assert not {item["id"] for item in first["items"]} & {item["id"] for item in second["items"]}


def test_management_reads_history_but_changes_nothing(make_client, world: World, history: dict) -> None:
    manager = signed_in(make_client, world.a.manager)
    visit = manager.get(f"/visits/{history['early_6th']}").json()
    assert visit["permissions"] == {
        "can_edit": False,
        "can_cancel": False,
        "can_resend": False,
        "can_check_in": False,
        "can_check_out": False,
        "can_edit_access_areas": False,  # Phase 16: management reads (B16-2)
    }
    assert manager.post(f"/visits/{history['early_6th']}/cancel", json={}).status_code == 403


def test_an_employee_only_sees_their_own_history(make_client, world: World, history: dict) -> None:
    employee = signed_in(make_client, world.a.employee)
    ids = _ids(employee)  # scope=all is narrowed to visits they host or created
    assert set(ids) == {history["late_5th"], history["cancelled"], history["morning"]}
