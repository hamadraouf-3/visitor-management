"""The production hooks end to end: D-18 (deactivating a host cancels their SCHEDULED visits and tells the
visitors) and D-17 (renames refresh SCHEDULED visits; checked-in and later visits stay frozen)."""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import Role, Visit, VisitorPass
from tests.conftest import TEST_START
from tests.support import (
    Factory,
    World,
    audit_rows,
    create_visit,
    create_visit_booked_by,
    refreshed,
    signed_in,
)

START = TEST_START + timedelta(hours=1)


def test_deactivating_a_host_cancels_their_scheduled_visits(
    make_client, world: World, factory: Factory, db: Session, email_provider: MemoryProvider
) -> None:
    host_user = factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Leaving Host")
    host = signed_in(make_client, host_user)
    with_email = create_visit(host, host_user.id, START, send_invitation=True)["visit"]["id"]
    without_email = create_visit(host, host_user.id, START, visitor={"full_name": "No Email"})["visit"]["id"]
    # An address, but no invitation was ever sent: no notice out of nowhere (B24-25).
    never_invited = create_visit(host, host_user.id, START)["visit"]["id"]
    # A visit the user booked for another host (before B10-24) stays: only hosted visits are cancelled.
    admin = signed_in(make_client, world.a.admin)
    for_colleague = create_visit_booked_by(db, admin, host_user, world.a.employee.id, START)["visit"]["id"]
    email_provider.clear()

    response = admin.patch(f"/users/{host_user.id}", json={"is_active": False})
    assert response.status_code == 200
    assert response.json()["cancelled_visits"] == 3

    for visit_id in (with_email, without_email, never_invited):
        visit = refreshed(db, Visit, visit_id)
        assert visit.status == "CANCELLED"
        assert visit.cancellation_reason == "Host is no longer available"
        assert visit.cancelled_by_id == world.a.admin.id
        passes = db.scalars(select(VisitorPass).where(VisitorPass.visit_id == visit.id)).all()
        assert [p.revoke_reason for p in passes] == ["VISIT_CANCELLED"]
    assert refreshed(db, Visit, for_colleague).status == "SCHEDULED"
    # The invited visitor is told, after the commit. The host has left, so replies cannot go to them.
    [notice] = [email for email in email_provider.sent if email.kind == "VISIT_CANCELLED"]
    assert "Host is no longer available" in notice.text
    assert notice.reply_to is None and "please contact Alpha." in notice.text
    # The host is told of each, so the entries leave the calendar of the account that stops (B14-20).
    told = [email for email in email_provider.sent if email.kind == "HOST_VISIT_CANCELLED"]
    assert len(told) == 3 and {email.to for email in told} == {host_user.email}
    assert len(email_provider.sent) == 4
    rows = audit_rows(db, "VISIT_CANCELLED")
    assert {row.meta["trigger"] for row in rows} == {"host_unavailable"}
    assert {row.actor_user_id for row in rows} == {world.a.admin.id}


def test_the_hook_and_the_requests_share_one_service_environment(app) -> None:
    assert app.state.hosted_visit_canceller.env is app.state.service_environment


def test_losing_the_host_role_cancels_too(make_client, world: World, factory: Factory, db: Session) -> None:
    host_user = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    visit_id = create_visit(signed_in(make_client, host_user), host_user.id, START)["visit"]["id"]
    admin = signed_in(make_client, world.a.admin)
    response = admin.patch(f"/users/{host_user.id}", json={"roles": ["RECEPTIONIST"]})
    assert response.json()["cancelled_visits"] == 1
    assert refreshed(db, Visit, visit_id).status == "CANCELLED"


def test_expired_hosted_visits_become_no_shows_instead(
    make_client, world: World, factory: Factory, db: Session, clock: FakeClock
) -> None:
    host_user = factory.user(world.a.company, roles=(Role.EMPLOYEE,))
    visit_id = create_visit(signed_in(make_client, host_user), host_user.id, START)["visit"]["id"]
    clock.set(START + timedelta(hours=3))
    admin = signed_in(make_client, world.a.admin)
    response = admin.patch(f"/users/{host_user.id}", json={"is_active": False})
    assert "cancelled_visits" not in response.json()
    assert refreshed(db, Visit, visit_id).status == "NO_SHOW"


def test_renames_refresh_scheduled_visits_only(make_client, world: World, db: Session) -> None:
    admin = signed_in(make_client, world.a.admin)
    scheduled = create_visit(admin, world.a.admin.id, START)["visit"]["id"]
    inside = create_visit(admin, world.a.admin.id, START)["visit"]["id"]
    # Checked in (Phase 5 writes this; set directly here): its snapshots are frozen from now on.
    visit = refreshed(db, Visit, inside)
    receptionist_id = world.a.receptionist.id
    with db.no_autoflush:
        visit.status = "CHECKED_IN"
        visit.check_in_at, visit.checked_in_by_id, visit.check_in_method = START, receptionist_id, "MANUAL"
    db.commit()

    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name": "Treasury"}).status_code == 200
    assert admin.patch(f"/users/{world.a.admin.id}", json={"full_name": "Amal Renamed"}).status_code == 200

    fresh = admin.get(f"/visits/{scheduled}").json()
    assert fresh["department"]["name"] == "Treasury" and fresh["host"]["full_name"] == "Amal Renamed"
    frozen = admin.get(f"/visits/{inside}").json()
    assert frozen["department"]["name"] == "Finance" and frozen["host"]["full_name"] == "Alpha Admin"
    # References show the current name (created_by is not a snapshot).
    assert frozen["created_by"]["full_name"] == "Amal Renamed"
