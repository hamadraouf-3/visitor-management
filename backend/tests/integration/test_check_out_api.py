"""POST /visits/{id}/check-out (QR, MANUAL, CORRECTED) and POST /reception/check-out-stale (BULK): the
pass is revoked, every success and refusal is audited, corrected times stay between the check-in and
now, and the bulk action closes only visits from an earlier day whose scheduled end has passed."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import Visit, VisitorPass
from tests.conftest import TEST_START
from tests.support import (
    Api,
    World,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    error_code,
    refreshed,
    signed_in,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)  # 07:00-08:00Z (10:00-11:00 Amman), window 06:00-09:00Z


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


def _inside(
    host: Api, reception: Api, world: World, start: datetime = START, *, tenant: str = "a", **kwargs
) -> dict:
    created = create_visit(host, getattr(world, tenant).employee.id, start, **kwargs)
    response = check_in(reception, created["visit"]["id"])
    assert response.status_code == 200, response.text
    return created


def _passes(db: Session, visit_id: str) -> list[VisitorPass]:
    db.expire_all()
    return list(
        db.query(VisitorPass).filter(VisitorPass.visit_id == visit_id).order_by(VisitorPass.created_at)
    )


# ---- single check-out -----------------------------------------------------------------------------


def test_manual_check_out(host: Api, reception: Api, world: World, clock: FakeClock, db: Session) -> None:
    created = _inside(host, reception, world)
    clock.advance(minutes=45)
    response = check_out(reception, created["visit"]["id"])
    assert response.status_code == 200, response.text
    visit = response.json()
    assert visit["status"] == "CHECKED_OUT" and visit["check_out_method"] == "MANUAL"
    assert visit["checked_out_by"]["id"] == str(world.a.receptionist.id)
    assert 45 * 60 <= visit["duration_seconds"] < 46 * 60
    assert visit["pass"] == {
        "status": "REVOKED",
        "issued_at": visit["pass"]["issued_at"],
        "revoke_reason": "VISIT_COMPLETED",
    }
    assert visit["permissions"]["can_check_out"] is False
    [row] = audit_rows(db, "VISIT_CHECKED_OUT")
    assert row.meta["method"] == "MANUAL" and row.meta["duration_seconds"] == visit["duration_seconds"]
    assert str(row.entity_id) == created["visit"]["id"] and row.actor_user_id == world.a.receptionist.id
    [revoked] = audit_rows(db, "PASS_REVOKED")
    assert revoked.meta["reason"] == "VISIT_COMPLETED"
    # The pass no longer opens anything: a scan says the visit is over.
    scanned = reception.post("/reception/scan", json={"token": created["pass_url"]})
    assert scanned.status_code == 409 and error_code(scanned) == "VISIT_COMPLETED"


def test_qr_check_out_accepts_any_pass_of_the_visit(
    host: Api, reception: Api, world: World, db: Session
) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    host.post(f"/visits/{created['visit']['id']}/invitation")  # the first pass is replaced
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    response = check_out(reception, created["visit"]["id"], "QR", pass_token=created["pass_url"])
    assert response.status_code == 200, response.text
    assert response.json()["check_out_method"] == "QR"
    [row] = audit_rows(db, "VISIT_CHECKED_OUT")
    assert row.meta["pass_id"] == str(_passes(db, created["visit"]["id"])[0].id)
    assert all(visitor_pass.revoked_at is not None for visitor_pass in _passes(db, created["visit"]["id"]))


def test_qr_check_out_needs_a_pass_of_this_visit(
    host: Api, reception: Api, world: World, db: Session
) -> None:
    inside = _inside(host, reception, world)
    other = create_visit(
        host, world.a.employee.id, START, visitor={"full_name": "Other", "email": "other.out@example.com"}
    )
    for raw in (other["pass_url"], "garbage"):
        response = check_out(reception, inside["visit"]["id"], "QR", pass_token=raw)
        assert response.status_code == 404 and error_code(response) == "PASS_INVALID"
    rows = audit_rows(db, "VISIT_CHECK_OUT_REFUSED")
    assert [row.meta for row in rows] == [{"method": "QR", "code": "PASS_INVALID"}] * 2
    assert refreshed(db, Visit, inside["visit"]["id"]).status == "CHECKED_IN"


def test_corrected_check_out(host: Api, reception: Api, world: World, clock: FakeClock, db: Session) -> None:
    created = _inside(host, reception, world)
    checked_in_at = datetime.fromisoformat(
        refreshed(db, Visit, created["visit"]["id"]).check_in_at.isoformat()
    )
    clock.advance(hours=3)
    left_at = checked_in_at + timedelta(minutes=50)
    response = check_out(
        reception,
        created["visit"]["id"],
        "CORRECTED",
        check_out_at=left_at.isoformat(),
        note="Left without checking out; host confirmed the time",
    )
    assert response.status_code == 200, response.text
    visit = response.json()
    assert visit["check_out_method"] == "CORRECTED" and visit["duration_seconds"] == 50 * 60
    assert visit["check_out_note"] == "Left without checking out; host confirmed the time"
    assert datetime.fromisoformat(visit["check_out_at"]) == left_at.astimezone(UTC)
    [row] = audit_rows(db, "VISIT_CHECKED_OUT")
    assert row.meta["method"] == "CORRECTED" and "host confirmed" not in str(row.meta)


@pytest.mark.parametrize(
    ("offset", "message"),
    [
        (timedelta(minutes=-1), "The check-out time must not be before the check-in time."),
        (timedelta(hours=5), "The check-out time must not be in the future."),
    ],
)
def test_corrected_time_must_lie_between_check_in_and_now(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session, offset: timedelta, message: str
) -> None:
    created = _inside(host, reception, world)
    checked_in_at = refreshed(db, Visit, created["visit"]["id"]).check_in_at
    clock.advance(hours=1)
    response = check_out(
        reception,
        created["visit"]["id"],
        "CORRECTED",
        check_out_at=(checked_in_at + offset).isoformat(),
        note="n",
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {"check_out_at": message}
    assert refreshed(db, Visit, created["visit"]["id"]).status == "CHECKED_IN"


def test_corrected_check_out_needs_a_note_and_an_aware_time(host: Api, reception: Api, world: World) -> None:
    created = _inside(host, reception, world)
    missing_note = check_out(reception, created["visit"]["id"], "CORRECTED", check_out_at=START.isoformat())
    assert set(missing_note.json()["error"]["details"]["fields"]) == {"note"}
    naive = check_out(
        reception, created["visit"]["id"], "CORRECTED", check_out_at="2026-10-05T10:00:00", note="n"
    )
    assert naive.json()["error"]["details"]["fields"] == {
        "check_out_at": "Include a time zone, e.g. 2026-10-05T09:00:00+03:00."
    }


@pytest.mark.parametrize("state", ["SCHEDULED", "CHECKED_OUT", "CANCELLED"])
def test_only_checked_in_visits_can_be_checked_out(
    host: Api, reception: Api, world: World, db: Session, state: str
) -> None:
    created = create_visit(host, world.a.employee.id, START)
    visit_id = created["visit"]["id"]
    if state == "CHECKED_OUT":
        check_in(reception, visit_id)
        check_out(reception, visit_id)
    elif state == "CANCELLED":
        host.post(f"/visits/{visit_id}/cancel", json={})
    for method, body in (("MANUAL", {}), ("QR", {"pass_token": created["pass_url"]})):
        response = check_out(reception, visit_id, method, **body)
        assert response.status_code == 409 and error_code(response) == "VISIT_NOT_CHECKED_IN"
        assert response.json()["error"]["details"]["visit"]["status"] == state
    rows = audit_rows(db, "VISIT_CHECK_OUT_REFUSED")
    assert [row.meta["code"] for row in rows] == ["VISIT_NOT_CHECKED_IN"] * 2


def test_foreign_visits_are_not_found(host: Api, reception: Api, world: World, make_client) -> None:
    created = _inside(host, reception, world)
    other_reception = signed_in(make_client, world.b.receptionist)
    response = check_out(other_reception, created["visit"]["id"])
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"


def test_a_walk_in_without_a_pass_checks_out_by_hand(reception: Api, world: World) -> None:
    created = reception.post(
        "/reception/walk-ins", json=walk_in_body(world.a.employee.id, START + timedelta(hours=1))
    )
    assert created.status_code == 201, created.text
    response = check_out(reception, created.json()["id"])
    assert response.status_code == 200
    assert response.json()["pass"] == {"status": "NONE", "issued_at": None, "revoke_reason": None}


# ---- stale check-out ------------------------------------------------------------------------------


def test_stale_check_out_closes_yesterdays_visits_at_their_scheduled_end(
    host: Api, world: World, clock: FakeClock, make_client, db: Session
) -> None:
    reception = signed_in(make_client, world.a.receptionist)
    stale = _inside(host, reception, world)  # 10:00-11:00 Amman, checked in at ~09:00
    late = create_visit(
        host, world.a.employee.id, START, visitor={"full_name": "Late", "email": "late@example.com"}
    )
    clock.set(START + timedelta(hours=2))  # after its window: checked in late with an override
    assert check_in(reception, late["visit"]["id"], "OVERRIDE", reason="Arrived late").status_code == 200
    clock.set(datetime(2026, 10, 6, 6, 0, tzinfo=UTC))  # the next day, 09:00 in Amman
    reception = signed_in(make_client, world.a.receptionist)
    today = create_visit(
        signed_in(make_client, world.a.employee),
        world.a.employee.id,
        datetime(2026, 10, 6, 6, 30, tzinfo=UTC),
        visitor={"full_name": "Today", "email": "today@example.com"},
    )
    assert check_in(reception, today["visit"]["id"]).status_code == 200

    inside = {item["id"]: item for item in reception.get("/reception/inside").json()["items"]}
    assert (
        inside[stale["visit"]["id"]]["is_stale"] is True and inside[today["visit"]["id"]]["is_stale"] is False
    )

    response = reception.post("/reception/check-out-stale", json={"reason": "Not checked out yesterday"})
    assert response.status_code == 200, response.text
    assert response.json() == {"checked_out": 2}
    first = refreshed(db, Visit, stale["visit"]["id"])
    assert first.status == "CHECKED_OUT" and first.check_out_method == "BULK"
    assert first.check_out_at == first.scheduled_end  # checked in before the scheduled end
    assert first.check_out_note == "Not checked out yesterday"
    second = refreshed(db, Visit, late["visit"]["id"])
    assert second.check_out_at == second.check_in_at  # checked in after its scheduled end: never before it
    assert refreshed(db, Visit, today["visit"]["id"]).status == "CHECKED_IN"
    [summary] = audit_rows(db, "STALE_VISITS_CHECKED_OUT")
    assert summary.meta == {"count": 2, "checked_in_before": "2026-10-06"}
    assert summary.entity_id == world.a.company.id and summary.actor_user_id == world.a.receptionist.id
    rows = audit_rows(db, "VISIT_CHECKED_OUT")
    assert sorted(str(row.entity_id) for row in rows) == sorted([stale["visit"]["id"], late["visit"]["id"]])
    assert {row.meta["method"] for row in rows} == {"BULK"}
    assert "yesterday" not in str([row.meta for row in rows])
    # Nothing is left to do.
    again = reception.post("/reception/check-out-stale", json={"reason": "Again"})
    assert again.json() == {"checked_out": 0}
    assert [row.meta["count"] for row in audit_rows(db, "STALE_VISITS_CHECKED_OUT")] == [2, 0]


def test_stale_check_out_leaves_visitors_whose_visit_has_not_ended(
    world: World, clock: FakeClock, make_client, db: Session
) -> None:
    """The verification finding (B57-71): a walk-in registered at 23:30 in Amman and expected until 07:30
    is "from a previous day" after midnight, but still on site. An end-of-day routine at 00:10 must not
    take them off the evacuation list; once their visit has ended, the bulk action closes it at its end."""
    clock.set(datetime(2026, 10, 5, 20, 30, tzinfo=UTC))  # 23:30 in Amman
    reception = signed_in(make_client, world.a.receptionist)
    walk_in = reception.post(
        "/reception/walk-ins",
        json=walk_in_body(world.a.employee.id, datetime(2026, 10, 6, 4, 30, tzinfo=UTC), reason="DELIVERY"),
    )
    assert walk_in.status_code == 201, walk_in.text
    visit_id = walk_in.json()["id"]

    clock.set(datetime(2026, 10, 5, 21, 10, tzinfo=UTC))  # 00:10 on 6 October
    reception = signed_in(make_client, world.a.receptionist)
    [item] = reception.get("/reception/inside").json()["items"]
    assert (item["is_stale"], item["is_overdue"]) == (True, False)
    response = reception.post("/reception/check-out-stale", json={"reason": "End of day"})
    assert response.status_code == 200, response.text
    assert response.json() == {"checked_out": 0}
    assert refreshed(db, Visit, visit_id).status == "CHECKED_IN"
    assert reception.get("/reception/inside").json()["count"] == 1
    assert audit_rows(db, "VISIT_CHECKED_OUT") == []
    assert [row.meta["count"] for row in audit_rows(db, "STALE_VISITS_CHECKED_OUT")] == [0]

    clock.set(datetime(2026, 10, 6, 4, 29, tzinfo=UTC))  # 07:29: due out in a minute
    reception = signed_in(make_client, world.a.receptionist)
    assert reception.post("/reception/check-out-stale", json={"reason": "Morning"}).json() == {
        "checked_out": 0
    }

    clock.set(datetime(2026, 10, 6, 5, 0, tzinfo=UTC))  # 08:00: overdue
    reception = signed_in(make_client, world.a.receptionist)
    [item] = reception.get("/reception/inside").json()["items"]
    assert (item["is_stale"], item["is_overdue"]) == (True, True)
    response = reception.post("/reception/check-out-stale", json={"reason": "Morning round"})
    assert response.json() == {"checked_out": 1}
    visit = refreshed(db, Visit, visit_id)
    assert visit.status == "CHECKED_OUT" and visit.check_out_method == "BULK"
    assert visit.check_out_at == visit.scheduled_end == datetime(2026, 10, 6, 4, 30, tzinfo=UTC)
    assert reception.get("/reception/inside").json()["count"] == 0


def test_stale_check_out_needs_a_reason(reception: Api) -> None:
    for body in ({}, {"reason": ""}):
        response = reception.post("/reception/check-out-stale", json=body)
        assert response.status_code == 422
        assert set(response.json()["error"]["details"]["fields"]) == {"reason"}


def test_stale_check_out_leaves_other_companies_alone(
    world: World, clock: FakeClock, make_client, db: Session
) -> None:
    host_b = signed_in(make_client, world.b.employee)
    reception_b = signed_in(make_client, world.b.receptionist)
    other = _inside(
        host_b,
        reception_b,
        world,
        tenant="b",
        visitor={"full_name": "B guest", "email": "b.guest@example.com"},
    )
    clock.set(datetime(2026, 10, 6, 6, 0, tzinfo=UTC))
    reception_a = signed_in(make_client, world.a.receptionist)
    assert reception_a.post("/reception/check-out-stale", json={"reason": "Daily"}).json() == {
        "checked_out": 0
    }
    assert refreshed(db, Visit, other["visit"]["id"]).status == "CHECKED_IN"


def test_an_empty_stale_check_out_is_audited_once_per_user_and_day(
    host: Api, world: World, clock: FakeClock, make_client, db: Session
) -> None:
    """SEC-42: a run that checks out nobody wrote a permanent row on every call, so a scripted or stolen
    reception session looping on the action appended rows to the append-only log at the API rate (and
    pushed real events off the dashboard's recent list). The first empty run of a user's company-local
    day is still recorded (the desk ran the end-of-day action and found nothing); a repeat that day only
    says the same again and writes nothing. Runs that check visits out are always recorded."""
    reception = signed_in(make_client, world.a.receptionist)
    left_over = _inside(host, reception, world)  # checked in today: not stale yet
    for _ in range(5):
        response = reception.post("/reception/check-out-stale", json={"reason": "End of day"})
        assert response.status_code == 200 and response.json() == {"checked_out": 0}
    admin = signed_in(make_client, world.a.admin)  # another account records its own run
    assert admin.post("/reception/check-out-stale", json={"reason": "End of day"}).json() == {
        "checked_out": 0
    }

    clock.set(datetime(2026, 10, 6, 6, 0, tzinfo=UTC))  # the next day, 09:00 in Amman
    reception = signed_in(make_client, world.a.receptionist)
    assert reception.post("/reception/check-out-stale", json={"reason": "Morning"}).json() == {
        "checked_out": 1
    }
    for _ in range(3):
        assert reception.post("/reception/check-out-stale", json={"reason": "Again"}).json() == {
            "checked_out": 0
        }

    rows = audit_rows(db, "STALE_VISITS_CHECKED_OUT")
    assert [(row.actor_user_id, row.meta["count"], row.meta["checked_in_before"]) for row in rows] == [
        (world.a.receptionist.id, 0, "2026-10-05"),
        (world.a.admin.id, 0, "2026-10-05"),
        (world.a.receptionist.id, 1, "2026-10-06"),
        (world.a.receptionist.id, 0, "2026-10-06"),
    ]
    assert refreshed(db, Visit, left_over["visit"]["id"]).check_out_method == "BULK"
