"""Two-company isolation of every Phase 5-7 endpoint (contract §3.2-5): another company's IDs are 404 in
paths and 422 field errors in bodies and filters, its passes are invalid, and lists, counts, reports and
the audit trail never include its rows."""

from datetime import timedelta

import pytest

from tests.conftest import TEST_START
from tests.support import (
    World,
    check_in,
    check_out,
    create_visit,
    error_code,
    signed_in,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)
EXPECTED_END = START + timedelta(hours=1)


def _populate(make_client, tenant) -> dict:
    host = signed_in(make_client, tenant.employee)
    reception = signed_in(make_client, tenant.receptionist)
    name = tenant.company.name
    scheduled = create_visit(host, tenant.employee.id, START, visitor={"full_name": f"{name} Expected"})
    inside = create_visit(host, tenant.employee.id, START, visitor={"full_name": f"{name} Inside"})
    assert check_in(reception, inside["visit"]["id"]).status_code == 200
    walk_in = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(tenant.employee.id, EXPECTED_END, visitor={"full_name": f"{name} Walker"}),
    )
    assert walk_in.status_code == 201
    return {"scheduled": scheduled, "inside": inside, "walk_in": walk_in.json()}


@pytest.fixture
def both(make_client, world: World) -> dict:
    return {"a": _populate(make_client, world.a), "b": _populate(make_client, world.b)}


def test_paths_naming_another_companys_visit_are_not_found(make_client, world: World, both: dict) -> None:
    reception_b = signed_in(make_client, world.b.receptionist)
    admin_b = signed_in(make_client, world.b.admin)
    a = both["a"]
    responses = [
        check_in(reception_b, a["scheduled"]["visit"]["id"]),
        check_in(reception_b, a["scheduled"]["visit"]["id"], "OVERRIDE", reason="x"),
        check_out(reception_b, a["inside"]["visit"]["id"]),
        check_out(reception_b, a["walk_in"]["id"]),
        admin_b.post(f"/visits/{a['scheduled']['visit']['id']}/pass"),
    ]
    for response in responses:
        assert response.status_code == 404 and error_code(response) == "NOT_FOUND", response.text


def test_another_companys_pass_is_invalid(make_client, world: World, both: dict) -> None:
    reception_b = signed_in(make_client, world.b.receptionist)
    own_visit = both["b"]["scheduled"]["visit"]["id"]
    foreign_pass = both["a"]["scheduled"]["pass_url"]
    response = check_in(reception_b, own_visit, "QR", pass_token=foreign_pass)
    assert response.status_code == 404 and error_code(response) == "PASS_INVALID"
    response = check_out(
        reception_b, both["b"]["inside"]["visit"]["id"], "QR", pass_token=both["a"]["inside"]["pass_url"]
    )
    assert response.status_code == 404 and error_code(response) == "PASS_INVALID"


def test_walk_in_references_of_another_company_are_field_errors(
    make_client, world: World, both: dict
) -> None:
    reception_b = signed_in(make_client, world.b.receptionist)
    body = walk_in_body(
        world.a.employee.id, EXPECTED_END, department_id=str(world.a.finance.id), visitor=None
    )
    body["visitor_id"] = both["a"]["scheduled"]["visit"]["visitor"]["id"]
    response = reception_b.post("/reception/walk-ins", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "host_id": "The selected item does not exist.",
        "department_id": "The selected item does not exist.",
        "visitor_id": "The selected item does not exist.",
    }


def test_lists_and_counts_hold_one_company(make_client, world: World, both: dict) -> None:
    a_ids = {
        both["a"]["scheduled"]["visit"]["id"],
        both["a"]["inside"]["visit"]["id"],
        both["a"]["walk_in"]["id"],
    }
    reception_b = signed_in(make_client, world.b.receptionist)
    today = reception_b.get("/reception/today").json()
    assert (
        today["counts"]["expected"] == 1
        and today["counts"]["inside"] == 2
        and today["counts"]["walk_ins"] == 1
    )
    inside = signed_in(make_client, world.b.manager).get("/reception/inside").json()
    assert inside["count"] == 2
    history = signed_in(make_client, world.b.manager).get("/visits", params={"scope": "all"}).json()
    assert history["total"] == 3
    for body in (today, inside, history):
        assert not a_ids & set(_all_ids(body))
    dashboard = signed_in(make_client, world.b.admin).get("/dashboard/admin").json()
    assert dashboard["counts"]["visits_total"] == 3 and dashboard["counts"]["inside_now"] == 2
    assert dashboard["counts"]["visitors_total"] == 3
    report = signed_in(make_client, world.b.manager).get("/reports/summary").json()
    assert report["totals"]["visits"] == 3 and report["totals"]["walk_ins"] == 1


def test_the_audit_trail_holds_one_company(make_client, world: World, both: dict) -> None:
    admin_b = signed_in(make_client, world.b.admin)
    items = admin_b.get("/audit-logs", params={"page_size": 100}).json()["items"]
    a_ids = {str(world.a.company.id), both["a"]["scheduled"]["visit"]["id"], both["a"]["walk_in"]["id"]}
    assert items and not a_ids & {item["entity_id"] for item in items}
    a_users = {str(user.id) for user in world.a.users_by_role.values()}
    assert not a_users & {item["actor"]["id"] for item in items if item["actor"]}
    # Filtering by another company's visit finds nothing; by its user is a field error.
    by_entity = admin_b.get("/audit-logs", params={"entity_id": both["a"]["scheduled"]["visit"]["id"]}).json()
    assert by_entity["total"] == 0
    by_actor = admin_b.get("/audit-logs", params={"actor_user_id": str(world.a.receptionist.id)})
    assert by_actor.status_code == 422


def _all_ids(body: dict) -> list[str]:
    ids: list[str] = []
    for key in ("items", "expected", "inside", "checked_out", "no_show"):
        ids += [item["id"] for item in body.get(key, [])]
    return ids
