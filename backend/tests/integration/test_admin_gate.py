"""Gate 7 for the Phase 1 administration endpoints (users, departments, company settings): only
SYSTEM_ADMIN writes, every change is in the audit trail the administrator reads (GET /audit-logs), and
refused changes that guard the company's own administration are on record too."""

from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.core.errors import LastAdmin
from app.core.request_context import SYSTEM_CONTEXT
from app.core.time import FakeClock
from app.models import Department, Role, User
from app.schemas.users import UserUpdate
from app.security.sessions import AuthContext
from tests.support import Api, Factory, World, audit_rows, error_code, refreshed, signed_in, users_service

ADMIN_WRITES = [
    (
        "users_create",
        "post",
        lambda w: "/users",
        {
            "full_name": "Gate Seven",
            "email": "gate.seven@example.com",
            "roles": ["EMPLOYEE"],
            "temporary_password": "Indigo-Walrus-Password-1",
        },
    ),
    ("users_roles", "patch", lambda w: f"/users/{w.a.employee.id}", {"roles": ["EMPLOYEE", "RECEPTIONIST"]}),
    ("users_deactivate", "patch", lambda w: f"/users/{w.a.employee.id}", {"is_active": False}),
    ("departments_create", "post", lambda w: "/departments", {"name": "Gate Dept"}),
    ("departments_update", "patch", lambda w: f"/departments/{w.a.finance.id}", {"is_active": False}),
    ("settings_update", "patch", lambda w: "/company/settings", {"pass_grace_after_minutes": 30}),
]


@pytest.mark.parametrize(
    "role", [Role.MANAGEMENT, Role.RECEPTIONIST, Role.EMPLOYEE], ids=lambda role: role.value
)
@pytest.mark.parametrize("write", ADMIN_WRITES, ids=lambda write: write[0])
def test_only_administrators_write(make_client, world: World, db: Session, write, role: Role) -> None:
    _name, method, path, body = write
    user = world.a.users_by_role[role]
    response = getattr(signed_in(make_client, user), method)(path(world), json=body)
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    assert audit_rows(db, "ACCESS_DENIED", actor_user_id=user.id)
    # Nothing changed.
    assert refreshed(db, User, world.a.employee.id).is_active is True
    assert refreshed(db, User, world.a.employee.id).roles == ["EMPLOYEE"]
    assert refreshed(db, Department, world.a.finance.id).is_active is True
    assert db.query(User).filter(User.email == "gate.seven@example.com").count() == 0


def _trail(admin: Api, action: str, **params) -> list[dict]:
    response = admin.get("/audit-logs", params={"action": action, **params})
    assert response.status_code == 200, response.text
    return response.json()["items"]


def test_every_administration_change_is_in_the_trail(make_client, world: World) -> None:
    admin = signed_in(make_client, world.a.admin)
    me = {"id": str(world.a.admin.id), "full_name": "Alpha Admin"}
    created = admin.post("/users", json=ADMIN_WRITES[0][3])
    assert created.status_code == 201
    user_id = created.json()["id"]
    [row] = _trail(admin, "USER_CREATED", entity_id=user_id)
    assert row["actor"] == me and row["metadata"]["roles"] == ["EMPLOYEE"]

    assert admin.patch(f"/users/{user_id}", json={"roles": ["RECEPTIONIST"]}).status_code == 200
    [roles] = _trail(admin, "USER_ROLES_CHANGED", entity_id=user_id)
    assert roles["actor"] == me and roles["metadata"] == {"added": ["RECEPTIONIST"], "removed": ["EMPLOYEE"]}
    assert _trail(admin, "USER_UPDATED", entity_id=user_id)[0]["metadata"] == {"changed_fields": ["roles"]}

    assert admin.patch(f"/users/{user_id}", json={"is_active": False}).status_code == 200
    [deactivated] = _trail(admin, "USER_DEACTIVATED", entity_id=user_id)
    assert deactivated["actor"] == me and "revoked_sessions" in deactivated["metadata"]
    assert admin.patch(f"/users/{user_id}", json={"is_active": True}).status_code == 200
    assert len(_trail(admin, "USER_REACTIVATED", entity_id=user_id)) == 1

    department = admin.post("/departments", json={"name": "Gate Dept"}).json()
    [dept_created] = _trail(admin, "DEPARTMENT_CREATED", entity_id=department["id"])
    assert dept_created["actor"] == me
    admin.patch(f"/departments/{department['id']}", json={"name": "Gate Department", "is_active": False})
    [dept_updated] = _trail(admin, "DEPARTMENT_UPDATED", entity_id=department["id"])
    assert dept_updated["metadata"] == {"changed_fields": ["name", "is_active"]}

    assert (
        admin.patch("/company/settings", json={"allow_walk_ins": False, "address": "Somewhere 1"}).status_code
        == 200
    )
    [settings] = _trail(admin, "COMPANY_SETTINGS_UPDATED", entity_id=str(world.a.company.id))
    assert settings["actor"] == me and settings["metadata"] == {
        "changed_fields": ["address", "allow_walk_ins"]
    }
    # No personal data in the trail (§3.2-8).
    everything = str(admin.get("/audit-logs", params={"page_size": 100}).json())
    for personal in ("gate.seven@example.com", "Gate Seven", "Somewhere 1", "Indigo-Walrus-Password-1"):
        assert personal not in everything


def test_refused_self_modification_is_audited(make_client, world: World, db: Session) -> None:
    admin = signed_in(make_client, world.a.admin)
    for body in ({"is_active": False}, {"roles": ["EMPLOYEE"]}):
        response = admin.patch(f"/users/{world.a.admin.id}", json=body)
        assert response.status_code == 409 and error_code(response) == "SELF_MODIFICATION"
    rows = audit_rows(db, "USER_CHANGE_REFUSED")
    assert [row.meta for row in rows] == [{"code": "SELF_MODIFICATION", "operation": "update"}] * 2
    assert all(row.entity_id == world.a.admin.id and row.actor_user_id == world.a.admin.id for row in rows)


def test_refused_address_is_audited_without_the_address(make_client, world: World, db: Session) -> None:
    admin = signed_in(make_client, world.a.admin)
    body = {**ADMIN_WRITES[0][3], "email": world.b.employee.email}  # another company's user
    response = admin.post("/users", json=body)
    assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
    [row] = audit_rows(db, "USER_CHANGE_REFUSED")
    assert row.meta == {"code": "USER_EMAIL_UNAVAILABLE", "operation": "create"} and row.entity_id is None
    assert world.b.employee.email not in str(row.meta)


def test_the_last_administrator_refusal_carries_its_audit_event(
    db: Session, factory: Factory, hasher, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LAST_ADMIN is reachable only with a stale authorisation (the caller is an administrator), which the
    re-check of SEC-07 now refuses first; as the backstop it is checked at the service, and the error
    carries the event the error handler writes."""
    monkeypatch.setattr("app.services.users.require_still_authorized", lambda *args, **kwargs: None)
    company = factory.company()
    admin_a = factory.user(company, roles=(Role.SYSTEM_ADMIN,))
    admin_b = factory.user(company, roles=(Role.SYSTEM_ADMIN,))
    service = users_service(db, hasher, settings)
    roles = frozenset({Role.SYSTEM_ADMIN})
    auth_a = AuthContext(admin_a, None, roles, admin_a.id, company.id, admin_a.id)  # type: ignore[arg-type]
    auth_b = AuthContext(admin_b, None, roles, admin_b.id, company.id, admin_b.id)  # type: ignore[arg-type]
    service.update_user(auth_a, admin_b.id, UserUpdate(roles=[Role.EMPLOYEE]), SYSTEM_CONTEXT)
    with pytest.raises(LastAdmin) as refused:
        service.update_user(auth_b, admin_a.id, UserUpdate(is_active=False), SYSTEM_CONTEXT)
    [event] = refused.value.security_events
    assert event.action == "USER_CHANGE_REFUSED" and event.entity_id == admin_a.id
    assert event.metadata == {"code": "LAST_ADMIN", "operation": "update"}


def test_refusals_for_taken_addresses_have_a_budget_per_administrator(
    make_client, world: World, db: Session, clock: FakeClock
) -> None:
    """SEC-05: a refusal confirms that the address has an account in some company (D-03 makes addresses
    unique system-wide). An administrator gets 10 such refusals an hour; then 429, before the lookup.
    Accepted creations and other refusals do not spend the budget."""
    admin = signed_in(make_client, world.a.admin)
    taken = [world.b.employee.email, world.b.admin.email, world.a.employee.email]
    body = ADMIN_WRITES[0][3]
    for index in range(10):
        response = admin.post("/users", json={**body, "email": taken[index % len(taken)]})
        assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
    refused = admin.post("/users", json={**body, "email": world.b.receptionist.email})
    assert refused.status_code == 429 and error_code(refused) == "RATE_LIMITED"
    assert int(refused.headers["Retry-After"]) > 0
    assert len(audit_rows(db, "USER_CHANGE_REFUSED")) == 10
    [limited] = audit_rows(db, "RATE_LIMITED", actor_user_id=world.a.admin.id)
    assert limited.meta["policy"] == "user_email_refusals_per_user"
    # Another administrator is unaffected, and the budget frees up with the hour.
    other = signed_in(make_client, world.b.admin)
    assert other.post("/users", json={**body, "email": world.a.admin.email}).status_code == 409
    clock.advance(timedelta(hours=1, seconds=1))
    assert admin.get("/auth/me").status_code == 200
    again = admin.post("/users", json={**body, "email": world.b.receptionist.email})
    assert again.status_code == 409


def test_refusals_for_taken_addresses_have_a_budget_per_company(
    make_client, world: World, db: Session, clock: FakeClock, factory: Factory
) -> None:
    """SEC-R1: the person SEC-05's budget guards against is a company's administrator, who can create
    more administrators, and a creation with a free address costs nothing from the budget. With a budget
    per administrator only, every such account brought ten more confirmations an hour. The company's
    refusals are bounded as well (20 an hour): once they are spent, every administrator of the company
    gets 429 before the lookup, also for a free address, while another company is unaffected."""
    admin = signed_in(make_client, world.a.admin)
    body = ADMIN_WRITES[0][3]
    puppet = admin.post(
        "/users", json={**body, "email": "puppet.admin@example.com", "roles": ["SYSTEM_ADMIN"]}
    )
    assert puppet.status_code == 201  # a new administrator, at no cost from either budget
    taken = [world.b.employee.email, world.b.admin.email, world.b.receptionist.email, world.a.employee.email]
    second_admin, third_admin = (factory.user(world.a.company, roles=(Role.SYSTEM_ADMIN,)) for _ in range(2))
    second = signed_in(make_client, second_admin)
    for prober in (admin, second):
        for index in range(10):
            response = prober.post("/users", json={**body, "email": taken[index % len(taken)]})
            assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
    assert len(audit_rows(db, "USER_CHANGE_REFUSED")) == 20

    third = signed_in(make_client, third_admin)
    for email in (world.b.manager.email, "free.address@example.com"):
        refused = third.post("/users", json={**body, "email": email})
        assert refused.status_code == 429 and error_code(refused) == "RATE_LIMITED"
        assert int(refused.headers["Retry-After"]) > 0
    assert db.query(User).filter(User.email == "free.address@example.com").count() == 0
    assert len(audit_rows(db, "USER_CHANGE_REFUSED")) == 20  # no lookup was answered
    limited = audit_rows(db, "RATE_LIMITED", actor_user_id=third_admin.id)
    assert {row.meta["policy"] for row in limited} == {"user_email_refusals_per_company"}
    # Another company keeps its own budget; this one's frees up with the hour.
    other = signed_in(make_client, world.b.admin)
    assert other.post("/users", json={**body, "email": world.a.admin.email}).status_code == 409
    clock.advance(timedelta(hours=1, seconds=1))
    assert third.get("/auth/me").status_code == 200
    assert third.post("/users", json={**body, "email": world.b.manager.email}).status_code == 409
