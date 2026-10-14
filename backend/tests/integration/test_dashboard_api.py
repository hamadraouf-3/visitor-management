"""GET /dashboard/employee (contract §8.1 EmployeeDashboard, D-23)."""

from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import Role, Visit
from tests.conftest import TEST_START
from tests.support import Factory, World, create_visit, refreshed, signed_in

START = TEST_START + timedelta(hours=1)


def test_employee_dashboard_counts_own_visits(
    make_client, world: World, factory: Factory, db: Session, email_provider: MemoryProvider
) -> None:
    host = signed_in(make_client, world.a.employee)
    today = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    create_visit(host, world.a.employee.id, START + timedelta(hours=2))
    create_visit(host, world.a.employee.id, START + timedelta(days=3))
    email_provider.fail_next(1, transient=False)
    create_visit(host, world.a.employee.id, START + timedelta(days=4), send_invitation=True)
    cancelled = create_visit(host, world.a.employee.id, START + timedelta(hours=3))["visit"]["id"]
    host.post(f"/visits/{cancelled}/cancel", json={})
    inside = create_visit(host, world.a.employee.id, START + timedelta(hours=4))["visit"]["id"]
    visit = refreshed(db, Visit, inside)
    receptionist_id = world.a.receptionist.id
    with db.no_autoflush:
        visit.status = "CHECKED_IN"
        visit.check_in_at, visit.checked_in_by_id, visit.check_in_method = START, receptionist_id, "MANUAL"
    db.commit()
    # Someone else's visit never counts.
    other = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    create_visit(signed_in(make_client, other), other.id, START)

    response = host.get("/dashboard/employee")
    assert response.status_code == 200
    body = response.json()
    assert body["counts"] == {
        "today": 3,  # two scheduled today and the checked-in one; the cancelled one is left out
        "upcoming": 2,
        "inside": 1,
        "completed_30d": 0,
        "cancelled_30d": 1,
        "needs_attention": 1,
    }
    assert len(body["today"]) == 3 and body["today"][0]["id"] == today
    assert [item["scheduled_start"] for item in body["today"]] == sorted(
        item["scheduled_start"] for item in body["today"]
    )


def test_dashboard_marks_no_shows(make_client, world: World, clock: FakeClock) -> None:
    host = signed_in(make_client, world.a.employee)
    create_visit(host, world.a.employee.id, START)
    clock.set(START + timedelta(hours=2, minutes=1))
    body = host.get("/dashboard/employee").json()
    assert [item["status"] for item in body["today"]] == ["NO_SHOW"]


def test_dashboard_access(make_client, world: World) -> None:
    assert signed_in(make_client, world.a.admin).get("/dashboard/employee").status_code == 200
    for user in (world.a.receptionist, world.a.manager):
        assert signed_in(make_client, user).get("/dashboard/employee").status_code == 403
