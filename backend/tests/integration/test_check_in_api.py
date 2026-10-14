"""POST /visits/{id}/check-in (contract §6): QR, MANUAL and OVERRIDE with every refusal code of §8.2,
auditing of successes and refusals, the host-arrival e-mail, the shared scan budget and the budget of
refused attempts without a pass."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import EmailMessage, User, Visit
from tests.conftest import TEST_START
from tests.support import (
    Api,
    World,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    error_code,
    pass_token,
    rate_limits,
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


def _visit(host: Api, world: World, start: datetime = START, **kwargs) -> dict:
    return create_visit(host, world.a.employee.id, start, **kwargs)


def _refused(response, status: int, code: str, options: list[str] | None = None) -> dict:
    assert response.status_code == status, response.text
    error = response.json()["error"]
    assert error["code"] == code
    if options is not None:
        assert error["details"]["check_in_options"] == options
    return error


def _arrivals(email_provider: MemoryProvider) -> list:
    return [email for email in email_provider.sent if email.kind == "HOST_ARRIVAL"]


# ---- QR -------------------------------------------------------------------------------------------


def test_qr_check_in(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session, email_provider: MemoryProvider
) -> None:
    created = _visit(host, world)
    clock.set(START + timedelta(minutes=10))
    assert reception.post("/reception/scan", json={"token": created["pass_url"]}).json()["result"] == "READY"
    response = check_in(reception, created["visit"]["id"], "QR", pass_token=created["pass_url"])
    assert response.status_code == 200, response.text
    visit = response.json()
    assert visit["status"] == "CHECKED_IN" and visit["check_in_method"] == "QR"
    assert visit["checked_in_by"] == {"id": str(world.a.receptionist.id), "full_name": "Alpha Reception"}
    assert visit["check_in_at"] is not None and visit["check_in_note"] is None
    assert visit["permissions"]["can_check_in"] is False and visit["permissions"]["can_check_out"] is True
    assert visit["pass"]["status"] == "ACTIVE"  # revoked only by the check-out

    [row] = audit_rows(db, "VISIT_CHECKED_IN")
    assert str(row.entity_id) == created["visit"]["id"] and row.actor_user_id == world.a.receptionist.id
    assert row.meta["method"] == "QR" and row.meta["from_status"] == "SCHEDULED"
    assert row.meta["pass_id"] is not None and "id_verified" not in row.meta
    assert row.meta["host_notified"] is True
    assert pass_token(created["pass_url"]) not in str(row.meta)

    # The host is told once, after the commit, in a message bound to the visit.
    [arrival] = _arrivals(email_provider)
    assert arrival.to == world.a.employee.email
    assert arrival.subject == "Your visitor Dana Guest has arrived"
    message = refreshed(db, EmailMessage, arrival.message_id)
    assert message.status == "SENT" and str(message.visit_id) == created["visit"]["id"]
    assert row.meta["email_message_id"] == str(arrival.message_id)


def test_qr_check_in_accepts_a_bare_token(host: Api, reception: Api, world: World) -> None:
    created = _visit(host, world)
    response = check_in(
        reception, created["visit"]["id"], "QR", pass_token=f" {pass_token(created['pass_url'])}\n"
    )
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("raw", ["", "not a pass", "https://vms.test/pass#short"])
def test_qr_check_in_with_an_invalid_pass(
    host: Api, reception: Api, world: World, db: Session, raw: str
) -> None:
    created = _visit(host, world)
    response = check_in(reception, created["visit"]["id"], "QR", pass_token=raw)
    assert response.status_code == 404 and error_code(response) == "PASS_INVALID"
    [row] = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert row.meta == {"method": "QR", "code": "PASS_INVALID"}
    assert str(row.entity_id) == created["visit"]["id"] and row.actor_user_id == world.a.receptionist.id
    assert refreshed(db, Visit, created["visit"]["id"]).status == "SCHEDULED"


def test_qr_check_in_needs_a_pass_of_this_visit(host: Api, reception: Api, world: World, db: Session) -> None:
    first = _visit(host, world)
    second = _visit(host, world, visitor={"full_name": "Other Guest", "email": "other.guest@example.com"})
    response = check_in(reception, first["visit"]["id"], "QR", pass_token=second["pass_url"])
    assert response.status_code == 404 and error_code(response) == "PASS_INVALID"
    assert refreshed(db, Visit, first["visit"]["id"]).status == "SCHEDULED"
    assert refreshed(db, Visit, second["visit"]["id"]).status == "SCHEDULED"


def test_qr_check_in_with_a_replaced_pass_offers_manual(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session
) -> None:
    created = _visit(host, world, send_invitation=True)
    rotated = host.post(f"/visits/{created['visit']['id']}/invitation").json()
    clock.set(START + timedelta(minutes=5))
    error = _refused(
        check_in(reception, created["visit"]["id"], "QR", pass_token=created["pass_url"]),
        410,
        "PASS_REVOKED",
        ["MANUAL"],
    )
    assert error["details"]["visit"]["id"] == created["visit"]["id"]
    [row] = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert row.meta == {"method": "QR", "code": "PASS_REVOKED"}
    # After an ID check the visitor is checked in by hand; the new pass would have worked too.
    assert check_in(reception, created["visit"]["id"], "MANUAL").status_code == 200
    assert rotated["pass_url"] != created["pass_url"]


def test_qr_check_in_before_the_window_offers_an_override(host: Api, reception: Api, world: World) -> None:
    later_today = _visit(host, world, START + timedelta(hours=4))  # window opens at 10:00Z
    _refused(
        check_in(reception, later_today["visit"]["id"], "QR", pass_token=later_today["pass_url"]),
        409,
        "PASS_NOT_YET_VALID",
        ["OVERRIDE"],
    )


# ---- MANUAL ---------------------------------------------------------------------------------------


def test_manual_check_in_inside_the_window(host: Api, reception: Api, world: World, db: Session) -> None:
    created = _visit(host, world)
    response = check_in(reception, created["visit"]["id"])
    assert response.status_code == 200, response.text
    assert response.json()["check_in_method"] == "MANUAL"
    [row] = audit_rows(db, "VISIT_CHECKED_IN")
    assert row.meta["method"] == "MANUAL" and row.meta["id_verified"] is True and "pass_id" not in row.meta


def test_manual_check_in_before_the_window(host: Api, reception: Api, world: World, db: Session) -> None:
    later_today = _visit(host, world, START + timedelta(hours=4))
    error = _refused(check_in(reception, later_today["visit"]["id"]), 409, "PASS_NOT_YET_VALID", ["OVERRIDE"])
    assert error["details"]["visit"]["status"] == "SCHEDULED"
    tomorrow = _visit(host, world, START + timedelta(days=1))
    _refused(check_in(reception, tomorrow["visit"]["id"]), 409, "PASS_NOT_YET_VALID", [])
    rows = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert [row.meta for row in rows] == [{"method": "MANUAL", "code": "PASS_NOT_YET_VALID"}] * 2


def test_manual_check_in_after_the_window(
    host: Api, world: World, clock: FakeClock, make_client, db: Session
) -> None:
    created = _visit(host, world)
    clock.set(START + timedelta(hours=2, minutes=1))  # the window ended at 09:00Z
    reception = signed_in(make_client, world.a.receptionist)
    error = _refused(check_in(reception, created["visit"]["id"]), 410, "PASS_EXPIRED", ["OVERRIDE"])
    assert error["details"]["visit"]["status"] == "NO_SHOW"


# ---- OVERRIDE -------------------------------------------------------------------------------------


def test_override_checks_in_a_no_show_on_its_day(
    host: Api, world: World, clock: FakeClock, make_client, db: Session
) -> None:
    created = _visit(host, world)
    clock.set(START + timedelta(hours=5))  # 15:00 in Amman, same day
    reception = signed_in(make_client, world.a.receptionist)
    response = check_in(reception, created["visit"]["id"], "OVERRIDE", reason="Stuck in traffic, ID checked")
    assert response.status_code == 200, response.text
    visit = response.json()
    assert visit["status"] == "CHECKED_IN" and visit["check_in_method"] == "OVERRIDE"
    assert visit["check_in_note"] == "Stuck in traffic, ID checked" and visit["no_show_at"] is not None
    [row] = audit_rows(db, "VISIT_CHECKED_IN")
    assert row.meta["method"] == "OVERRIDE" and row.meta["from_status"] == "NO_SHOW"
    assert row.meta["id_verified"] is True
    assert "traffic" not in str(row.meta)  # the reason is free text: on the visit, never in the audit


def test_override_before_the_window_on_the_same_day(host: Api, reception: Api, world: World) -> None:
    later_today = _visit(host, world, START + timedelta(hours=4))
    response = check_in(reception, later_today["visit"]["id"], "OVERRIDE", reason="Early for the meeting")
    assert response.status_code == 200, response.text


def test_override_on_another_day_is_not_allowed(
    host: Api, world: World, clock: FakeClock, make_client, db: Session
) -> None:
    created = _visit(host, world)
    tomorrow = _visit(host, world, START + timedelta(days=1))
    clock.set(START + timedelta(days=1, hours=-6))  # the next day, 04:00 in Amman
    reception = signed_in(make_client, world.a.receptionist)
    _refused(
        check_in(reception, created["visit"]["id"], "OVERRIDE", reason="Came a day late"),
        409,
        "OVERRIDE_NOT_ALLOWED",
        [],
    )
    [row] = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert row.meta == {"method": "OVERRIDE", "code": "OVERRIDE_NOT_ALLOWED"}
    # The same-day rule is about the visit's own day: tomorrow's visit is today's now.
    assert check_in(reception, tomorrow["visit"]["id"], "OVERRIDE", reason="Very early").status_code == 200


def test_override_needs_a_reason(host: Api, reception: Api, world: World) -> None:
    created = _visit(host, world)
    for body in ({}, {"reason": "   "}):
        response = check_in(reception, created["visit"]["id"], "OVERRIDE", **body)
        assert response.status_code == 422
        assert set(response.json()["error"]["details"]["fields"]) == {"reason"}


# ---- refusals common to every method --------------------------------------------------------------


@pytest.mark.parametrize("method", ["QR", "MANUAL", "OVERRIDE"])
def test_a_cancelled_visit_cannot_be_checked_in(
    host: Api, reception: Api, world: World, db: Session, method: str
) -> None:
    created = _visit(host, world)
    host.post(f"/visits/{created['visit']['id']}/cancel", json={})
    body = (
        {"pass_token": created["pass_url"]}
        if method == "QR"
        else {"reason": "x"}
        if method == "OVERRIDE"
        else {}
    )
    error = _refused(check_in(reception, created["visit"]["id"], method, **body), 409, "VISIT_CANCELLED", [])
    assert error["details"]["visit"]["status"] == "CANCELLED"
    [row] = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert row.meta == {"method": method, "code": "VISIT_CANCELLED"}


@pytest.mark.parametrize("method", ["QR", "MANUAL", "OVERRIDE"])
def test_checking_in_twice(host: Api, reception: Api, world: World, method: str) -> None:
    created = _visit(host, world)
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    body = (
        {"pass_token": created["pass_url"]}
        if method == "QR"
        else {"reason": "x"}
        if method == "OVERRIDE"
        else {}
    )
    error = _refused(
        check_in(reception, created["visit"]["id"], method, **body), 409, "VISIT_ALREADY_CHECKED_IN"
    )
    assert error["details"]["visit"]["status"] == "CHECKED_IN"


@pytest.mark.parametrize("method", ["QR", "MANUAL", "OVERRIDE"])
def test_a_completed_visit_cannot_be_checked_in_again(
    host: Api, reception: Api, world: World, method: str
) -> None:
    created = _visit(host, world)
    check_in(reception, created["visit"]["id"])
    assert check_out(reception, created["visit"]["id"]).status_code == 200
    body = (
        {"pass_token": created["pass_url"]}
        if method == "QR"
        else {"reason": "x"}
        if method == "OVERRIDE"
        else {}
    )
    _refused(check_in(reception, created["visit"]["id"], method, **body), 409, "VISIT_COMPLETED", [])


@pytest.mark.parametrize("method", ["QR", "MANUAL", "OVERRIDE"])
def test_an_inactive_host_blocks_the_check_in(
    host: Api, reception: Api, world: World, db: Session, method: str
) -> None:
    created = _visit(host, world)
    # Written directly: deactivating through the API would cancel the visit (D-18).
    refreshed(db, User, world.a.employee.id).is_active = False
    db.commit()
    body = (
        {"pass_token": created["pass_url"]}
        if method == "QR"
        else {"reason": "x"}
        if method == "OVERRIDE"
        else {}
    )
    error = _refused(check_in(reception, created["visit"]["id"], method, **body), 409, "HOST_INACTIVE", [])
    assert error["message"].startswith("The host for this visit is no longer active.")


def test_a_host_who_lost_the_host_role_cannot_receive_an_overridden_no_show(
    host: Api, world: World, clock: FakeClock, make_client, db: Session, email_provider: MemoryProvider
) -> None:
    # §7.5: hosts are active users with EMPLOYEE or SYSTEM_ADMIN. D-18 cancels only SCHEDULED visits
    # when the role is removed, so the visit that became NO_SHOW today stays, with a host who is none.
    created = _visit(host, world)
    visit_id = created["visit"]["id"]
    clock.set(START + timedelta(hours=5))  # 15:00 in Amman, the same day: NO_SHOW
    admin = signed_in(make_client, world.a.admin)
    demoted = admin.patch(f"/users/{world.a.employee.id}", json={"roles": ["RECEPTIONIST"]})
    assert demoted.status_code == 200, demoted.text
    reception = signed_in(make_client, world.a.receptionist)

    visit = reception.get(f"/visits/{visit_id}").json()
    assert visit["status"] == "NO_SHOW" and visit["permissions"]["can_check_in"] is False
    scan = reception.post("/reception/scan", json={"token": created["pass_url"]})
    _refused(scan, 409, "HOST_INACTIVE", [])  # §6 row 5 before row 7: no override is offered
    error = _refused(
        check_in(reception, visit_id, "OVERRIDE", reason="Late, ID checked"), 409, "HOST_INACTIVE", []
    )
    assert error["details"]["visit"]["status"] == "NO_SHOW"
    assert refreshed(db, Visit, visit_id).status == "NO_SHOW"
    assert _arrivals(email_provider) == []
    [row] = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert row.meta == {"method": "OVERRIDE", "code": "HOST_INACTIVE"}


def test_a_visitor_inside_on_another_visit(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session
) -> None:
    first = _visit(host, world)
    visitor_id = first["visit"]["visitor"]["id"]
    second = _visit(host, world, START + timedelta(minutes=30), visitor_id=visitor_id)
    clock.set(START + timedelta(minutes=5))  # inside both windows
    assert check_in(reception, first["visit"]["id"]).status_code == 200
    error = _refused(check_in(reception, second["visit"]["id"]), 409, "VISITOR_ALREADY_INSIDE")
    assert error["message"] == "This visitor is already checked in on another visit."
    assert error["details"]["visit"]["id"] == second["visit"]["id"]
    assert error["details"]["visit"]["status"] == "SCHEDULED"
    [row] = audit_rows(db, "VISIT_CHECK_IN_REFUSED")
    assert row.meta == {"method": "MANUAL", "code": "VISITOR_ALREADY_INSIDE"}
    # Once the first visit is over, the second one can start.
    assert check_out(reception, first["visit"]["id"]).status_code == 200
    assert check_in(reception, second["visit"]["id"]).status_code == 200


def test_unknown_and_foreign_visits_are_not_found(host: Api, world: World, make_client) -> None:
    created = _visit(host, world)
    other_reception = signed_in(make_client, world.b.receptionist)
    for visit_id in (created["visit"]["id"], "00000000-0000-4000-8000-000000000000", "not-a-uuid"):
        response = check_in(other_reception, visit_id)
        assert response.status_code == 404 and error_code(response) == "NOT_FOUND"


# ---- host arrival e-mail --------------------------------------------------------------------------


def test_no_arrival_email_when_the_company_does_not_want_one(
    host: Api, reception: Api, world: World, make_client, db: Session, email_provider: MemoryProvider
) -> None:
    admin = signed_in(make_client, world.a.admin)
    assert admin.patch("/company/settings", json={"notify_host_on_check_in": False}).status_code == 200
    created = _visit(host, world)
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    assert _arrivals(email_provider) == []
    [row] = audit_rows(db, "VISIT_CHECKED_IN")
    assert row.meta["host_notified"] is False and row.meta["email_message_id"] is None


def test_the_arrival_email_goes_out_exactly_once(
    host: Api, reception: Api, world: World, email_provider: MemoryProvider
) -> None:
    created = _visit(host, world)
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    for method, body in (
        ("MANUAL", {}),
        ("OVERRIDE", {"reason": "again"}),
        ("QR", {"pass_token": created["pass_url"]}),
    ):
        assert check_in(reception, created["visit"]["id"], method, **body).status_code == 409
    assert check_out(reception, created["visit"]["id"]).status_code == 200
    assert len(_arrivals(email_provider)) == 1


def test_a_failed_arrival_email_does_not_undo_the_check_in(
    host: Api, reception: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    created = _visit(host, world)
    email_provider.fail_next(1, transient=False)
    response = check_in(reception, created["visit"]["id"])
    assert response.status_code == 200
    assert refreshed(db, Visit, created["visit"]["id"]).status == "CHECKED_IN"
    [message] = [
        message
        for message in db.query(EmailMessage).filter(EmailMessage.kind == "HOST_ARRIVAL").all()
        if str(message.visit_id) == created["visit"]["id"]
    ]
    assert message.status == "FAILED"


def test_arrival_emails_have_a_daily_budget_per_checking_in_user(
    app, host: Api, world: World, make_client, db: Session, email_provider: MemoryProvider
) -> None:
    visits = [_visit(host, world)["visit"]["id"] for _ in range(3)]
    with rate_limits(app, host_arrivals_per_user_day=2):
        reception = signed_in(make_client, world.a.receptionist)
        for visit_id in visits:
            assert check_in(reception, visit_id).status_code == 200  # the check-in itself always succeeds
        assert len(_arrivals(email_provider)) == 2
        limited = audit_rows(db, "VISIT_CHECKED_IN", entity_id=visits[-1])[-1].meta
        assert limited["host_notified"] is False and limited["email_message_id"] is None
        assert limited["notice_limited_by"] == "host_arrivals_per_user_day"
        notified = audit_rows(db, "VISIT_CHECKED_IN", entity_id=visits[0])[-1].meta
        assert notified["host_notified"] is True and notified["notice_limited_by"] is None

        # Walk-ins spend the same budget; another user who checks visitors in has a budget of their own.
        walk_in = reception.post(
            "/reception/walk-ins", json=walk_in_body(world.a.employee.id, START + timedelta(hours=1))
        )
        assert walk_in.status_code == 201, walk_in.text
        assert (
            audit_rows(db, "VISIT_CHECKED_IN", entity_id=walk_in.json()["id"])[-1].meta["notice_limited_by"]
            == "host_arrivals_per_user_day"
        )
        admin = signed_in(make_client, world.a.admin)
        assert check_out(admin, visits[0]).status_code == 200
        other_desk = admin.post(
            "/reception/walk-ins",
            json=walk_in_body(
                world.a.employee.id, START + timedelta(hours=1), visitor={"full_name": "Second"}
            ),
        )
        assert other_desk.status_code == 201, other_desk.text
        assert len(_arrivals(email_provider)) == 3


def test_refused_or_unwanted_arrival_emails_do_not_spend_the_budget(
    app, host: Api, world: World, make_client, email_provider: MemoryProvider
) -> None:
    first, second = (_visit(host, world)["visit"]["id"] for _ in range(2))
    with rate_limits(app, host_arrivals_per_user_day=1):
        reception = signed_in(make_client, world.a.receptionist)
        admin = signed_in(make_client, world.a.admin)
        assert admin.patch("/company/settings", json={"notify_host_on_check_in": False}).status_code == 200
        assert check_in(reception, first).status_code == 200  # no e-mail wanted: nothing spent
        assert admin.patch("/company/settings", json={"notify_host_on_check_in": True}).status_code == 200
        assert check_in(reception, first).status_code == 409  # refused: nothing spent
        assert check_in(reception, second).status_code == 200
    assert len(_arrivals(email_provider)) == 1


# ---- scan budget ----------------------------------------------------------------------------------


def test_qr_check_ins_share_the_scan_budget(app, host: Api, world: World, make_client, db: Session) -> None:
    created = _visit(host, world)
    with rate_limits(app, scan_per_user=1):
        reception = signed_in(make_client, world.a.receptionist)
        assert reception.post("/reception/scan", json={"token": created["pass_url"]}).status_code == 200
        response = check_in(reception, created["visit"]["id"], "QR", pass_token=created["pass_url"])
        assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
        # MANUAL does not look a token up and is not limited by the scan budget.
        assert check_in(reception, created["visit"]["id"]).status_code == 200
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "scan_per_user"


# ---- refusal budget (L-BE-2) ----------------------------------------------------------------------


def _limited(response) -> None:
    assert response.status_code == 429, response.text
    assert error_code(response) == "RATE_LIMITED" and int(response.headers["Retry-After"]) >= 1


def test_refused_attendance_changes_have_a_budget_per_user(
    app, host: Api, world: World, make_client, clock: FakeClock, db: Session
) -> None:
    """Every refusal writes an audit row of its own, so refusals without a pass (which spend no scan) have a
    per-user budget: beyond it the request is answered 429 before any lock, and the repeated 429s share
    one coalesced row (B1-33) instead of one refusal row each."""
    cancelled = _visit(host, world)["visit"]["id"]
    assert host.post(f"/visits/{cancelled}/cancel", json={"notify_visitor": False}).status_code == 200
    ready = _visit(host, world, visitor={"full_name": "Ready Guest"})["visit"]["id"]
    with rate_limits(app, attendance_refusals_per_user=3):
        reception = signed_in(make_client, world.a.receptionist)
        assert check_in(reception, cancelled).status_code == 409  # MANUAL
        assert check_in(reception, cancelled, "OVERRIDE", reason="Late bus").status_code == 409
        assert check_out(reception, cancelled).status_code == 409  # MANUAL
        # The budget is spent: every attempt without a pass waits for the window, also one that would
        # succeed, and nothing is locked, changed or audited as a refusal.
        corrected = {"check_out_at": START.isoformat(), "note": "Left by the side door"}
        for response in (
            check_in(reception, cancelled),
            check_in(reception, ready),
            check_out(reception, cancelled, "CORRECTED", **corrected),
            reception.post("/reception/walk-ins", json=walk_in_body(world.a.employee.id, START)),
        ):
            _limited(response)
        assert refreshed(db, Visit, ready).status == "SCHEDULED"
        # Another account has a budget of its own.
        admin = signed_in(make_client, world.a.admin)
        assert check_in(admin, cancelled).status_code == 409
        # A minute later the receptionist's refusals are answered again.
        clock.advance(seconds=61)
        assert check_in(reception, cancelled).status_code == 409
        assert check_in(reception, ready).status_code == 200

    refusals = audit_rows(db, "VISIT_CHECK_IN_REFUSED") + audit_rows(db, "VISIT_CHECK_OUT_REFUSED")
    by_actor = sorted((row.actor_user_id == world.a.admin.id, row.meta["code"]) for row in refusals)
    assert by_actor == [
        (False, "VISIT_CANCELLED"),
        (False, "VISIT_CANCELLED"),
        (False, "VISIT_CANCELLED"),
        (False, "VISIT_NOT_CHECKED_IN"),
        (True, "VISIT_CANCELLED"),
    ]
    assert audit_rows(db, "WALK_IN_CREATED") == []
    limited = [row for row in audit_rows(db, "RATE_LIMITED") if not row.meta.get("deferred")]
    assert [(row.meta["policy"], row.actor_user_id) for row in limited] == [
        ("attendance_refusals_per_user", world.a.receptionist.id)
    ]


def test_only_refusals_spend_the_refusal_budget(
    app, host: Api, world: World, make_client, clock: FakeClock, db: Session
) -> None:
    """Successful MANUAL, OVERRIDE, CORRECTED and walk-in requests cost nothing; neither do 422s or QR
    attempts, which spend the scan budget instead (B57-12)."""
    first = _visit(host, world)["visit"]["id"]
    second = _visit(host, world, visitor={"full_name": "Second Guest"})["visit"]["id"]
    with rate_limits(app, attendance_refusals_per_user=1):
        reception = signed_in(make_client, world.a.receptionist)
        clock.set(START + timedelta(minutes=5))
        assert check_in(reception, first).status_code == 200  # MANUAL
        assert check_in(reception, second, "OVERRIDE", reason="Visitor lost the pass").status_code == 200
        assert check_out(reception, first).status_code == 200  # MANUAL
        clock.advance(minutes=10)
        corrected = {"check_out_at": (START + timedelta(minutes=7)).isoformat(), "note": "Left earlier"}
        assert check_out(reception, second, "CORRECTED", **corrected).status_code == 200
        expected_end = START + timedelta(hours=2)
        walk_in = reception.post("/reception/walk-ins", json=walk_in_body(world.a.employee.id, expected_end))
        assert walk_in.status_code == 201, walk_in.text
        too_early = {"check_out_at": (START - timedelta(hours=1)).isoformat(), "note": "Before check-in"}
        assert check_out(reception, walk_in.json()["id"], "CORRECTED", **too_early).status_code == 422
        assert check_in(reception, first, "QR", pass_token="not a pass").status_code == 404
        # The one slot is still there for a refusal; the next attempt is over the budget.
        assert check_in(reception, first).status_code == 409
        _limited(check_in(reception, first))
    assert len(audit_rows(db, "VISIT_CHECK_IN_REFUSED")) == 2  # the QR attempt and the MANUAL one


def test_refused_walk_ins_spend_the_refusal_budget(app, world: World, make_client, db: Session) -> None:
    admin = signed_in(make_client, world.a.admin)
    assert admin.patch("/company/settings", json={"allow_walk_ins": False}).status_code == 200
    body = walk_in_body(world.a.employee.id, START + timedelta(hours=2))
    with rate_limits(app, attendance_refusals_per_user=1):
        reception = signed_in(make_client, world.a.receptionist)
        refused = reception.post("/reception/walk-ins", json=body)
        assert refused.status_code == 409 and error_code(refused) == "WALK_INS_DISABLED"
        _limited(reception.post("/reception/walk-ins", json=body))
    assert [row.meta["code"] for row in audit_rows(db, "WALK_IN_REFUSED")] == ["WALK_INS_DISABLED"]
