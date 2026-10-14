"""POST /visits/{id}/pass (B57-04: a new one-time pass link for the host, no e-mail) and
`Visit.last_notice` (B57-03: whether the visitor was told about a cancellation or reschedule)."""

from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.email.providers.memory import MemoryProvider
from app.models import Role
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    World,
    audit_rows,
    check_in,
    create_visit,
    create_visit_booked_by,
    error_code,
    pass_token,
    rate_limits,
    signed_in,
)

START = TEST_START + timedelta(hours=1)


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


def _scan(api: Api, pass_url: str):
    return api.post("/reception/scan", json={"token": pass_url})


# ---- POST /visits/{id}/pass -----------------------------------------------------------------------


def test_reissuing_a_pass_returns_a_new_link_once_and_sends_nothing(
    host: Api, world: World, make_client, db: Session, email_provider: MemoryProvider
) -> None:
    created = create_visit(host, world.a.employee.id, START, visitor={"full_name": "No Email Guest"})
    visit_id = created["visit"]["id"]
    response = host.post(f"/visits/{visit_id}/pass")
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"visit", "pass_url"}
    prefix = f"https://vms.test/pass?c={world.a.company.slug}#"  # the company in the query (B12-14)
    assert body["pass_url"].startswith(prefix) and body["pass_url"] != created["pass_url"]
    assert body["visit"]["pass"]["status"] == "ACTIVE"
    assert body["visit"]["invitation"]["status"] == "NOT_SENT"
    assert email_provider.sent == []
    reception = signed_in(make_client, world.a.receptionist)
    old = _scan(reception, created["pass_url"])
    assert old.status_code == 410 and error_code(old) == "PASS_REVOKED"
    assert _scan(reception, body["pass_url"]).json()["result"] == "READY"
    # Audited without the token: the old pass revoked (ROTATED), the new one issued, by the host.
    [revoked] = audit_rows(db, "PASS_REVOKED")
    assert revoked.meta["reason"] == "ROTATED" and revoked.actor_user_id == world.a.employee.id
    issued = audit_rows(db, "PASS_ISSUED")
    assert len(issued) == 2 and issued[-1].actor_user_id == world.a.employee.id
    assert pass_token(body["pass_url"]) not in str([row.meta for row in issued])
    assert audit_rows(db, "INVITATION_QUEUED") == []


def test_owners_and_administrators_may_reissue(
    make_client, world: World, factory: Factory, db: Session
) -> None:
    creator = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    # Booked by an employee for the host before B10-24: both own it.
    admin = signed_in(make_client, world.a.admin)
    created = create_visit_booked_by(db, admin, creator, world.a.employee.id, START)
    visit_id = created["visit"]["id"]
    for user in (creator, world.a.employee, world.a.admin):  # creator, host, administrator
        assert signed_in(make_client, user).post(f"/visits/{visit_id}/pass").status_code == 200, (
            user.full_name
        )
    stranger = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    assert signed_in(make_client, stranger).post(f"/visits/{visit_id}/pass").status_code == 404
    for user in (world.a.receptionist, world.a.manager):
        response = signed_in(make_client, user).post(f"/visits/{visit_id}/pass")
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    response = signed_in(make_client, world.b.admin).post(f"/visits/{visit_id}/pass")
    assert response.status_code == 404


def test_only_scheduled_visits_get_a_new_pass(host: Api, world: World, make_client) -> None:
    cancelled = create_visit(host, world.a.employee.id, START)
    host.post(f"/visits/{cancelled['visit']['id']}/cancel", json={})
    inside = create_visit(host, world.a.employee.id, START, visitor={"full_name": "Inside"})
    check_in(signed_in(make_client, world.a.receptionist), inside["visit"]["id"])
    for visit in (cancelled, inside):
        response = host.post(f"/visits/{visit['visit']['id']}/pass")
        assert response.status_code == 409 and error_code(response) == "VISIT_NOT_EDITABLE"


def test_pass_replacements_share_the_resend_budget_of_the_visit(
    app, host: Api, world: World, db: Session
) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    other = create_visit(host, world.a.employee.id, START, visitor={"full_name": "Other Visit"})
    visit_id = created["visit"]["id"]
    with rate_limits(app, invitation_resends_per_visit=2):
        assert host.post(f"/visits/{visit_id}/pass").status_code == 200
        assert host.post(f"/visits/{visit_id}/invitation").status_code == 200
        limited = host.post(f"/visits/{visit_id}/pass")
        assert limited.status_code == 429 and error_code(limited) == "RATE_LIMITED"
        assert int(limited.headers["Retry-After"]) >= 1
        resend = host.post(f"/visits/{visit_id}/invitation")
        assert resend.status_code == 429 and error_code(resend) == "INVITATION_LIMIT"
        assert host.post(f"/visits/{other['visit']['id']}/pass").status_code == 200  # per visit
    assert audit_rows(db, "RATE_LIMITED")[0].meta["policy"] == "invitation_resends_per_visit"


# ---- Visit.last_notice ----------------------------------------------------------------------------


def test_a_cancellation_notice_is_reported_on_the_visit(
    host: Api, world: World, email_provider: MemoryProvider
) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    assert created["visit"]["last_notice"] is None
    cancelled = host.post(f"/visits/{visit_id}/cancel", json={"reason": "Meeting moved online"})
    assert cancelled.status_code == 200
    queued = cancelled.json()["last_notice"]
    assert queued["kind"] == "VISIT_CANCELLED" and queued["status"] == "PENDING"
    assert queued["sent_at"] is None and queued["error"] is None
    assert queued["to_email"] == created["visit"]["invitation"]["to_email"]
    delivered = host.get(f"/visits/{visit_id}").json()["last_notice"]
    assert delivered["status"] == "SENT" and delivered["sent_at"] is not None
    assert [email.kind for email in email_provider.sent][-1] == "VISIT_CANCELLED"


def test_a_failed_notice_shows_why(host: Api, world: World, email_provider: MemoryProvider) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    email_provider.fail_next(1, transient=False)
    host.post(f"/visits/{created['visit']['id']}/cancel", json={})
    notice = host.get(f"/visits/{created['visit']['id']}").json()["last_notice"]
    assert notice["status"] == "FAILED" and notice["sent_at"] is None
    assert notice["error"] == "Simulated delivery failure."


def test_the_latest_notice_wins(host: Api, world: World) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    visit_id = created["visit"]["id"]
    new_start = START + timedelta(hours=3)
    rescheduled = host.patch(
        f"/visits/{visit_id}",
        json={
            "scheduled_start": new_start.isoformat(),
            "scheduled_end": (new_start + timedelta(hours=1)).isoformat(),
        },
    )
    assert rescheduled.json()["last_notice"]["kind"] == "VISIT_RESCHEDULED"
    assert host.get(f"/visits/{visit_id}").json()["last_notice"]["status"] == "SENT"
    host.post(f"/visits/{visit_id}/cancel", json={})
    assert host.get(f"/visits/{visit_id}").json()["last_notice"]["kind"] == "VISIT_CANCELLED"


def test_no_notice_for_a_visitor_who_was_never_invited(host: Api, world: World) -> None:
    created = create_visit(host, world.a.employee.id, START)
    cancelled = host.post(f"/visits/{created['visit']['id']}/cancel", json={"notify_visitor": True})
    assert cancelled.json()["last_notice"] is None


def test_invitations_and_arrival_emails_are_not_notices(host: Api, world: World, make_client) -> None:
    created = create_visit(host, world.a.employee.id, START, send_invitation=True)
    check_in(signed_in(make_client, world.a.receptionist), created["visit"]["id"])
    visit = host.get(f"/visits/{created['visit']['id']}").json()
    assert visit["invitation"]["status"] == "SENT" and visit["last_notice"] is None
