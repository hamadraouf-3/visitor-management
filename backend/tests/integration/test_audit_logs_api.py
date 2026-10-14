"""GET /audit-logs (administrators, D-13) and GET /dashboard/admin (contract §8.1 `AuditLog`,
`AdminDashboard`): company scoping, filters, company-local date bounds, ordering, actor references."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import Connection, event, text
from sqlalchemy.orm import Session

from app.core.request_context import SYSTEM_CONTEXT
from app.core.time import FakeClock
from app.models import Role
from app.services import audit
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    check_in,
    create_visit,
    error_code,
    signed_in,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)


@pytest.fixture
def admin(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.admin)


def _logs(api: Api, **params) -> dict:
    response = api.get("/audit-logs", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_trail_is_the_companys_newest_first(admin: Api, world: World, make_client) -> None:
    created = admin.post("/departments", json={"name": "Audit Dept"}).json()
    signed_in(make_client, world.b.admin).post("/departments", json={"name": "Other Company Dept"})
    page = _logs(admin)
    seqs = [item["seq"] for item in page["items"]]
    assert seqs == sorted(seqs, reverse=True) and len(set(seqs)) == len(seqs)
    latest = page["items"][0]
    assert latest["action"] == "DEPARTMENT_CREATED" and latest["entity_id"] == created["id"]
    assert latest["entity_type"] == "department"
    assert latest["actor"] == {"id": str(world.a.admin.id), "full_name": "Alpha Admin"}
    assert latest["ip_address"] == "203.0.113.10" and latest["request_id"]
    assert latest["created_at"].endswith("Z") and isinstance(latest["metadata"], dict)
    assert set(latest) == {
        "id", "seq", "created_at", "action", "actor", "entity_type", "entity_id", "metadata",
        "ip_address", "user_agent", "request_id",
    }  # fmt: skip
    # The other company's rows (and their actors) never appear.
    actors = {item["actor"]["id"] for item in page["items"] if item["actor"]}
    assert str(world.b.admin.id) not in actors
    assert page["total"] == len(page["items"])  # one page holds everything this test wrote


def test_filters(admin: Api, world: World, make_client) -> None:
    host = signed_in(make_client, world.a.employee)
    visit = create_visit(host, world.a.employee.id, START)
    check_in(signed_in(make_client, world.a.receptionist), visit["visit"]["id"])
    by_action = _logs(admin, action="VISIT_CHECKED_IN")["items"]
    assert [item["entity_id"] for item in by_action] == [visit["visit"]["id"]]
    by_actor = _logs(admin, actor_user_id=str(world.a.employee.id))["items"]
    assert by_actor and all(item["actor"]["id"] == str(world.a.employee.id) for item in by_actor)
    by_entity = _logs(admin, entity_type="visit", entity_id=visit["visit"]["id"])["items"]
    assert {item["action"] for item in by_entity} >= {"VISIT_CREATED", "VISIT_CHECKED_IN"}
    assert all(item["entity_id"] == visit["visit"]["id"] for item in by_entity)
    assert _logs(admin, action="NO_SUCH_ACTION")["items"] == []
    assert _logs(admin, entity_id=str(uuid.uuid4()))["total"] == 0


def test_dates_are_company_local_days(world: World, clock: FakeClock, make_client, db: Session) -> None:
    def record_at(instant: datetime, marker: str) -> None:
        clock.set(instant)
        audit.record(
            db,
            action="COMPANY_SETTINGS_UPDATED",
            context=SYSTEM_CONTEXT,
            company_id=world.a.company.id,
            actor_user_id=world.a.admin.id,
            metadata={"marker": marker},
        )
        db.commit()

    record_at(datetime(2026, 10, 5, 20, 59, 59, tzinfo=UTC), "late_on_the_5th")  # 23:59:59 in Amman
    record_at(datetime(2026, 10, 5, 21, 0, 0, tzinfo=UTC), "early_on_the_6th")  # 00:00 on the 6th
    admin = signed_in(make_client, world.a.admin)

    def markers(**params) -> list[str]:
        items = _logs(admin, action="COMPANY_SETTINGS_UPDATED", **params)["items"]
        return [item["metadata"]["marker"] for item in items]

    assert markers(date_from="2026-10-05", date_to="2026-10-05") == ["late_on_the_5th"]
    assert markers(date_from="2026-10-06") == ["early_on_the_6th"]
    assert markers(date_to="2026-10-05") == ["late_on_the_5th"]
    assert markers() == ["early_on_the_6th", "late_on_the_5th"]


def test_pagination(admin: Api) -> None:
    for index in range(3):
        admin.post("/departments", json={"name": f"Paged {index}"})
    first = _logs(admin, action="DEPARTMENT_CREATED", page_size=2)
    second = _logs(admin, action="DEPARTMENT_CREATED", page_size=2, page=2)
    assert first["total"] == second["total"] == 3
    assert len(first["items"]) == 2 and len(second["items"]) == 1
    assert first["items"][-1]["seq"] > second["items"][0]["seq"]


@pytest.mark.parametrize(
    ("params", "fields"),
    [
        ({"actor_user_id": "not-a-uuid"}, {"actor_user_id": "Enter a valid ID."}),
        ({"action": "visit created"}, {"action": "Enter a value in the expected format."}),
        ({"entity_type": "Visit"}, {"entity_type": "Enter a value in the expected format."}),
        (
            {"date_from": "2026-10-06", "date_to": "2026-10-05"},
            {"date_to": "The end date must not be before the start date."},
        ),
        ({"page_size": "101"}, {"page_size": "Enter a value of at most 100."}),
        ({"sort": "seq"}, {"sort": "This field is not allowed."}),
    ],
)
def test_invalid_filters(admin: Api, params: dict, fields: dict) -> None:
    response = admin.get("/audit-logs", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == fields


def test_an_actor_of_another_company_is_a_field_error(admin: Api, world: World) -> None:
    for actor in (world.b.admin.id, uuid.uuid4()):
        response = admin.get("/audit-logs", params={"actor_user_id": str(actor)})
        assert response.status_code == 422
        assert response.json()["error"]["details"]["fields"] == {
            "actor_user_id": "The selected item does not exist."
        }


def test_unattributed_rows_are_not_listed(admin: Api, world: World, db: Session) -> None:
    audit.record(db, action="CSRF_FAILED", context=SYSTEM_CONTEXT, company_id=None, actor_user_id=None)
    db.commit()
    assert _logs(admin, action="CSRF_FAILED")["items"] == []


def test_only_administrators_read_the_trail(make_client, world: World) -> None:
    for user in (world.a.employee, world.a.receptionist, world.a.manager):
        response = signed_in(make_client, user).get("/audit-logs")
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"


# ---- administrator dashboard ----------------------------------------------------------------------


def test_admin_dashboard(admin: Api, world: World, factory: Factory, make_client, clock: FakeClock) -> None:
    factory.user(world.a.company, roles=(Role.MANAGEMENT, Role.EMPLOYEE))  # counts for both roles
    factory.user(world.a.company, roles=(Role.EMPLOYEE,), is_active=False)  # inactive: not counted
    host = signed_in(make_client, world.a.employee)
    today = create_visit(host, world.a.employee.id, START)
    create_visit(host, world.a.employee.id, START + timedelta(days=2), visitor={"full_name": "Later"})
    cancelled = create_visit(host, world.a.employee.id, START, visitor={"full_name": "Cancelled"})
    host.post(f"/visits/{cancelled['visit']['id']}/cancel", json={})
    reception = signed_in(make_client, world.a.receptionist)
    check_in(reception, today["visit"]["id"])
    reception.post("/reception/walk-ins", json=walk_in_body(world.a.employee.id, START + timedelta(hours=1)))
    signed_in(make_client, world.b.receptionist).post(
        "/reception/walk-ins", json=walk_in_body(world.b.employee.id, START + timedelta(hours=1))
    )

    response = admin.get("/dashboard/admin")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["counts"] == {
        "visitors_total": 4,  # three invited, one walk-in
        "visits_total": 4,
        "inside_now": 2,
        "visits_today": 2,  # today's invitation and the walk-in; not the cancelled one
        "employees": 2,
        "receptionists": 1,
        "management": 2,
        "admins": 1,
    }
    recent = body["recent_audit"]
    assert len(recent) == 10
    assert [item["seq"] for item in recent] == sorted((item["seq"] for item in recent), reverse=True)
    assert recent == _logs(admin, page_size=10)["items"]


def test_admin_dashboard_is_for_administrators(make_client, world: World) -> None:
    for user in (world.a.employee, world.a.receptionist, world.a.manager):
        response = signed_in(make_client, user).get("/dashboard/admin")
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"


def test_the_trail_is_counted_without_parallel_workers(admin: Api, connection: Connection) -> None:
    """Re-audit round 1: a full page counts the whole trail, and PostgreSQL planned that count in
    parallel from about 80,000 rows, at 76-186 ms against 21 ms serially on the development cluster
    (worker start-up). `debug_parallel_query` makes PostgreSQL put a Gather on every plan that may run in
    parallel, so the plan of each count shows whether parallel workers were allowed."""
    for index in range(3):
        assert admin.post("/departments", json={"name": f"Counted {index}"}).status_code == 201
    connection.execute(text("SET LOCAL debug_parallel_query = on"))
    default = connection.execute(text("SHOW max_parallel_workers_per_gather")).scalar_one()
    plans: list[str] = []

    def explain_counts(conn, cursor, statement: str, parameters, context, executemany: bool) -> None:
        if statement.lstrip().startswith("SELECT count(*)"):
            with cursor.connection.cursor() as explainer:
                explainer.execute("EXPLAIN " + statement, parameters)
                plans.append("\n".join(row[0] for row in explainer.fetchall()))

    event.listen(connection, "after_cursor_execute", explain_counts)
    try:
        for _ in range(8):  # beyond psycopg's prepare threshold (5) on the same connection
            page = _logs(admin, action="DEPARTMENT_CREATED", page_size=2)
            assert page["total"] == 3 and len(page["items"]) == 2  # a full page: counted
        audit_plans = list(plans)
        users = admin.get("/users", params={"page_size": 1})  # a list whose count may run in parallel
        assert users.status_code == 200 and users.json()["total"] > 1
    finally:
        event.remove(connection, "after_cursor_execute", explain_counts)

    assert len(audit_plans) == 8 and not any("Gather" in plan for plan in audit_plans), audit_plans
    assert "Gather" in plans[-1]  # the setting does force a parallel plan where one is allowed
    # Put back after the count: the rest of the transaction plans as configured.
    assert connection.execute(text("SHOW max_parallel_workers_per_gather")).scalar_one() == default != "0"
