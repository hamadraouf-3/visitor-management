"""POST /reception/scan: every row of the contract §6 table, with the fake clock, plus auditing, scoping
and the per-user rate limit."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import AuditLog, User, Visit
from tests.conftest import TEST_START
from tests.support import (
    Api,
    World,
    audit_rows,
    create_visit,
    error_code,
    pass_token,
    rate_limits,
    refreshed,
    signed_in,
)

START = TEST_START + timedelta(hours=1)  # visit 07:00-08:00Z (10:00-11:00 Amman), window 06:00-09:00Z
TOKEN = "Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A"


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


def _visit(host: Api, world: World, start: datetime = START, **kwargs) -> dict:
    return create_visit(host, world.a.employee.id, start, **kwargs)


def _scan(api: Api, raw: str):
    return api.post("/reception/scan", json={"token": raw})


def _scanned(db: Session) -> list[AuditLog]:
    return audit_rows(db, "PASS_SCANNED")


def _set_status(db: Session, visit_id: str, status: str, by: User, at: datetime) -> None:
    """Check-in/out arrive in Phase 5; until then the states are written directly."""
    by_id = by.id
    visit = refreshed(db, Visit, visit_id)
    with db.no_autoflush:
        visit.status = status
        visit.check_in_at, visit.checked_in_by_id, visit.check_in_method = at, by_id, "MANUAL"
        if status == "CHECKED_OUT":
            visit.check_out_at, visit.checked_out_by_id, visit.check_out_method = at, by_id, "MANUAL"
    db.commit()


# ---- row 9 / row 4: success -----------------------------------------------------------------------


def test_row_9_ready(host: Api, reception: Api, world: World, clock: FakeClock, db: Session) -> None:
    created = _visit(host, world)
    clock.set(START + timedelta(minutes=10))
    response = _scan(reception, created["pass_url"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["result"] == "READY"
    assert body["visit"]["id"] == created["visit"]["id"]
    assert body["warnings"] == []
    assert body["actions"] == {"check_in": True, "check_out": False}
    assert body["visit"]["permissions"]["can_check_in"] is True
    [row] = _scanned(db)
    assert row.meta["outcome"] == "READY"
    assert row.entity_id is not None and str(row.entity_id) == created["visit"]["id"]
    assert row.actor_user_id == world.a.receptionist.id
    assert pass_token(created["pass_url"]) not in str(row.meta)


def test_row_9_bare_token_and_outside_scheduled_time(
    host: Api, reception: Api, world: World, clock: FakeClock
) -> None:
    created = _visit(host, world)
    clock.set(START - timedelta(minutes=30))  # inside the window, before the scheduled start
    body = _scan(reception, f"  {pass_token(created['pass_url'])}\n").json()
    assert body["result"] == "READY"
    assert body["warnings"] == [
        {"code": "OUTSIDE_SCHEDULED_TIME", "message": "Visitor is outside the scheduled visit time."}
    ]


def test_row_4_already_checked_in(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session
) -> None:
    created = _visit(host, world, send_invitation=True)
    rotated = host.post(f"/visits/{created['visit']['id']}/invitation").json()
    _set_status(db, created["visit"]["id"], "CHECKED_IN", world.a.receptionist, START)
    clock.set(START + timedelta(minutes=20))
    body = _scan(reception, rotated["pass_url"]).json()
    assert body["result"] == "ALREADY_CHECKED_IN"
    assert body["actions"] == {"check_in": False, "check_out": True}
    assert body["warnings"] == []
    # Any pass of the visit, also a replaced one, and an overstay warning after the scheduled end.
    clock.set(START + timedelta(hours=1, minutes=5))
    late = _scan(reception, created["pass_url"]).json()
    assert late["result"] == "ALREADY_CHECKED_IN"
    assert [warning["code"] for warning in late["warnings"]] == ["OVERSTAYED"]
    assert late["visit"]["is_overdue"] is True


# ---- rows 2-8: errors -----------------------------------------------------------------------------


def _error(response, status: int, code: str, options: list[str]) -> dict:
    assert response.status_code == status, response.text
    error = response.json()["error"]
    assert error["code"] == code
    assert error["details"]["check_in_options"] == options
    return error


def test_row_2_cancelled(host: Api, reception: Api, world: World, db: Session) -> None:
    created = _visit(host, world)
    host.post(f"/visits/{created['visit']['id']}/cancel", json={})
    error = _error(_scan(reception, created["pass_url"]), 409, "VISIT_CANCELLED", [])
    assert error["message"] == "This visit has been cancelled."
    assert error["details"]["visit"]["id"] == created["visit"]["id"]
    assert error["details"]["visit"]["status"] == "CANCELLED"
    [row] = _scanned(db)
    assert row.meta["outcome"] == "VISIT_CANCELLED" and str(row.entity_id) == created["visit"]["id"]
    assert row.actor_user_id == world.a.receptionist.id and row.company_id == world.a.company.id


def test_row_3_completed(host: Api, reception: Api, world: World, db: Session) -> None:
    created = _visit(host, world)
    _set_status(db, created["visit"]["id"], "CHECKED_OUT", world.a.receptionist, START)
    error = _error(_scan(reception, created["pass_url"]), 409, "VISIT_COMPLETED", [])
    assert error["message"] == "This visit has already been completed."


def test_row_5_host_inactive(host: Api, reception: Api, world: World, clock: FakeClock, db: Session) -> None:
    created = _visit(host, world)
    # Written directly: deactivating through the API would cancel the visit (D-18).
    refreshed(db, User, world.a.employee.id).is_active = False
    db.commit()
    clock.set(START + timedelta(minutes=5))
    error = _error(_scan(reception, created["pass_url"]), 409, "HOST_INACTIVE", [])
    assert error["message"].startswith("The host for this visit is no longer active.")


def test_row_6_rotated_pass(host: Api, reception: Api, world: World, clock: FakeClock, make_client) -> None:
    created = _visit(host, world, send_invitation=True)
    host.post(f"/visits/{created['visit']['id']}/invitation")
    clock.set(START + timedelta(minutes=5))  # inside the window
    error = _error(_scan(reception, created["pass_url"]), 410, "PASS_REVOKED", ["MANUAL"])
    assert error["message"].startswith("This visitor pass has been replaced.")
    assert error["details"]["visit"]["pass"]["status"] == "ACTIVE"  # the replacement


def test_row_6_options_outside_the_window(host: Api, reception: Api, world: World, clock: FakeClock) -> None:
    later_today = _visit(host, world, START + timedelta(hours=4), send_invitation=True)  # window 10:00-13:00Z
    host.post(f"/visits/{later_today['visit']['id']}/invitation")
    _error(_scan(reception, later_today["pass_url"]), 410, "PASS_REVOKED", ["OVERRIDE"])
    tomorrow = _visit(host, world, START + timedelta(days=1), send_invitation=True)
    host.post(f"/visits/{tomorrow['visit']['id']}/invitation")
    _error(_scan(reception, tomorrow["pass_url"]), 410, "PASS_REVOKED", [])


def test_row_6_email_changed(host: Api, reception: Api, world: World, clock: FakeClock) -> None:
    created = _visit(host, world, visitor={"full_name": "Changing", "email": "before@example.com"})
    host.patch(f"/visitors/{created['visit']['visitor']['id']}", json={"email": "after@example.com"})
    clock.set(START + timedelta(minutes=5))
    _error(_scan(reception, created["pass_url"]), 410, "PASS_REVOKED", ["MANUAL"])


def test_row_7_expired_same_day(host: Api, world: World, clock: FakeClock, make_client, db: Session) -> None:
    created = _visit(host, world)
    clock.set(START + timedelta(hours=2, minutes=1))  # window ended: NO_SHOW is marked by the scan itself
    reception = signed_in(make_client, world.a.receptionist)
    error = _error(_scan(reception, created["pass_url"]), 410, "PASS_EXPIRED", ["OVERRIDE"])
    assert error["message"] == "This visitor pass has expired."
    assert error["details"]["visit"]["status"] == "NO_SHOW"
    assert audit_rows(db, "VISIT_MARKED_NO_SHOW")


def test_row_7_expired_on_a_later_day(host: Api, world: World, clock: FakeClock, make_client) -> None:
    created = _visit(host, world)
    clock.set(START + timedelta(days=1))
    reception = signed_in(make_client, world.a.receptionist)
    _error(_scan(reception, created["pass_url"]), 410, "PASS_EXPIRED", [])


def test_row_8_not_yet_valid(host: Api, reception: Api, world: World) -> None:
    later_today = _visit(host, world, START + timedelta(hours=4))  # window starts 10:00Z, now is 06:00Z
    error = _error(_scan(reception, later_today["pass_url"]), 409, "PASS_NOT_YET_VALID", ["OVERRIDE"])
    assert error["message"] == "This visitor pass is not valid yet."
    tomorrow = _visit(host, world, START + timedelta(days=1))
    _error(_scan(reception, tomorrow["pass_url"]), 409, "PASS_NOT_YET_VALID", [])


# ---- row 1: invalid -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw", ["", "not a pass", TOKEN[:20], TOKEN + "\x1d", "https://vms.test/other#" + TOKEN]
)
def test_row_1_malformed(reception: Api, db: Session, world: World, raw: str) -> None:
    response = _scan(reception, raw)
    assert response.status_code == 404
    assert response.json()["error"] == {
        "code": "PASS_INVALID",
        "message": "Invalid visitor pass.",
        "details": {},
    }
    [row] = _scanned(db)
    assert row.meta == {"outcome": "INVALID"}
    assert row.entity_id is None and row.entity_type is None
    assert row.actor_user_id == world.a.receptionist.id


def test_row_1_unknown_and_foreign_passes(make_client, host: Api, world: World, db: Session) -> None:
    created = _visit(host, world)
    other_reception = signed_in(make_client, world.b.receptionist)
    for raw in (TOKEN, created["pass_url"], f"https://vms.test/pass#{TOKEN}"):
        response = _scan(other_reception, raw)
        assert response.status_code == 404 and error_code(response) == "PASS_INVALID"
        assert "details" in response.json()["error"] and response.json()["error"]["details"] == {}
    rows = _scanned(db)
    assert len(rows) == 3
    assert all(row.entity_id is None and row.company_id == world.b.company.id for row in rows)
    stored = " ".join(str(row.meta) for row in db.scalars(select(AuditLog)))
    assert pass_token(created["pass_url"]) not in stored and TOKEN not in stored


# ---- access and rate limit ------------------------------------------------------------------------


def test_scan_requires_reception(make_client, host: Api, world: World) -> None:
    created = _visit(host, world)
    for user in (world.a.employee, world.a.manager):
        response = _scan(signed_in(make_client, user), created["pass_url"])
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    admin = signed_in(make_client, world.a.admin)
    assert _scan(admin, created["pass_url"]).status_code == 200


def test_scan_rate_limit_per_user(app, make_client, host: Api, world: World, db: Session) -> None:
    created = _visit(host, world)
    with rate_limits(app, scan_per_user=2):
        reception = signed_in(make_client, world.a.receptionist)
        statuses = [_scan(reception, created["pass_url"]).status_code for _ in range(3)]
        admin = signed_in(make_client, world.a.admin)
        other_user = _scan(admin, created["pass_url"]).status_code
    assert statuses == [200, 200, 429]
    assert other_user == 200  # the budget is per user
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "scan_per_user"
