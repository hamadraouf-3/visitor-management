from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.errors import Forbidden, LastAdmin
from app.core.request_context import SYSTEM_CONTEXT
from app.core.time import FakeClock
from app.models import Role, User
from app.schemas.users import UserUpdate
from app.security.sessions import AuthContext, SessionManager, SessionPolicy
from app.services.users import HostedVisitCancellation
from app.services.visit_hooks import HostedVisitCancellations
from tests.support import (
    DEFAULT_PASSWORD,
    Api,
    Factory,
    World,
    audit_rows,
    error_code,
    refreshed,
    users_service,
)

TEMP_PASSWORD = "Tmp-Kiwi-Lantern-2026"


@pytest.fixture
def admin(make_client, world: World) -> Api:
    api = Api(make_client())
    assert api.login(world.a.admin.email).status_code == 200
    return api


def _new_user(**overrides) -> dict:
    payload = {
        "full_name": "  New Person  ",
        "email": "New.Person@Example.com",
        "phone": " +962 79 111 2222 ",
        "roles": ["EMPLOYEE"],
        "temporary_password": TEMP_PASSWORD,
    }
    payload.update(overrides)
    return payload


# ---- hosts --------------------------------------------------------------------------------------


def test_hosts_lists_active_hosts_of_own_company(make_client, world: World, factory: Factory) -> None:
    factory.user(world.a.company, roles=(Role.EMPLOYEE,), full_name="Zed Inactive", is_active=False)
    both = factory.user(world.a.company, roles=(Role.MANAGEMENT, Role.EMPLOYEE), full_name="Both Roles")
    api = Api(make_client())
    api.login(world.a.receptionist.email)

    response = api.get("/users/hosts")
    assert response.status_code == 200
    ids = {item["id"] for item in response.json()}
    assert ids == {str(world.a.admin.id), str(world.a.employee.id), str(both.id)}
    employee = next(item for item in response.json() if item["id"] == str(world.a.employee.id))
    assert employee == {
        "id": str(world.a.employee.id),
        "full_name": world.a.employee.full_name,
        "phone": "+962 79 000 0001",
        "department": None,
    }


def test_hosts_search(make_client, world: World) -> None:
    api = Api(make_client())
    api.login(world.a.employee.email)
    response = api.get("/users/hosts", params={"q": "alpha adm"})
    assert [item["id"] for item in response.json()] == [str(world.a.admin.id)]
    assert api.get("/users/hosts", params={"q": "%"}).json() == []
    assert len(api.get("/users/hosts", params={"q": "   "}).json()) == 2  # blank means no filter


def test_host_search_never_matches_email_addresses(make_client, world: World, factory: Factory) -> None:
    """`Host` omits e-mail, so `q` must not match it: match/no-match would reveal the address."""
    host = factory.user(world.a.company, full_name="Plain Name", email="secret.local-part@example.com")
    for role_user in (world.a.receptionist, world.a.employee, world.a.manager):
        api = Api(make_client())
        api.login(role_user.email)
        for probe in ("secret", "local-part", "secret.local-part@example.com", "example.com"):
            ids = [item["id"] for item in api.get("/users/hosts", params={"q": probe}).json()]
            assert str(host.id) not in ids, (role_user.roles, probe)
        found = [item["id"] for item in api.get("/users/hosts", params={"q": "plain na"}).json()]
        assert found == [str(host.id)]


def test_admin_user_search_still_matches_email(admin: Api, factory: Factory, world: World) -> None:
    user = factory.user(world.a.company, full_name="Plain Name", email="findme.here@example.com")
    found = [item["id"] for item in admin.get("/users", params={"q": "findme"}).json()["items"]]
    assert found == [str(user.id)]


@pytest.mark.parametrize("path", ["/users/hosts", "/users"])
def test_search_rejects_control_characters(admin: Api, path: str) -> None:
    response = admin.get(path, params={"q": "a\x00b"})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {"q": "Remove unsupported control characters."}


def test_hosts_are_capped(make_client, factory: Factory) -> None:
    company = factory.company()
    users = [factory.user(company) for _ in range(55)]
    api = Api(make_client())
    api.login(users[0].email)
    assert len(api.get("/users/hosts").json()) == 50


# ---- list / get ---------------------------------------------------------------------------------


def test_admin_lists_users_with_filters_and_pagination(admin: Api, world: World, factory: Factory) -> None:
    factory.user(world.a.company, roles=(Role.EMPLOYEE,), is_active=False, full_name="Alpha Zz Former")
    page = admin.get("/users", params={"page_size": 2})
    assert page.status_code == 200
    body = page.json()
    assert body["page"] == 1 and body["page_size"] == 2 and body["total"] == 5 and len(body["items"]) == 2

    receptionists = admin.get("/users", params={"role": "RECEPTIONIST"}).json()
    assert [item["id"] for item in receptionists["items"]] == [str(world.a.receptionist.id)]
    multiple = admin.get("/users", params={"role": "RECEPTIONIST,MANAGEMENT"}).json()
    assert multiple["total"] == 2
    inactive = admin.get("/users", params={"is_active": "false"}).json()
    assert [item["full_name"] for item in inactive["items"]] == ["Alpha Zz Former"]
    assert admin.get("/users", params={"q": "reception"}).json()["total"] == 1
    bad = admin.get("/users", params={"role": "ROOT"})
    assert bad.status_code == 422 and "role" in bad.json()["error"]["details"]["fields"]
    assert admin.get("/users", params={"role": " RECEPTIONIST, ,RECEPTIONIST"}).json()["total"] == 1
    assert admin.get("/users", params={"page_size": 101}).status_code == 422


def test_get_user_and_isolation(admin: Api, world: World) -> None:
    response = admin.get(f"/users/{world.a.employee.id}")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "id",
        "full_name",
        "email",
        "phone",
        "roles",
        "department",
        "is_active",
        "must_change_password",
        "last_login_at",
        "created_at",
        "updated_at",
    }
    assert body["created_at"].endswith("Z")
    assert admin.get(f"/users/{world.b.employee.id}").status_code == 404
    assert admin.get("/users/00000000-0000-0000-0000-000000000000").status_code == 404
    # Contract §3.2-5: an unresolvable path ID is 404 NOT_FOUND, malformed or not.
    malformed = admin.get("/users/not-a-uuid")
    assert malformed.status_code == 404 and error_code(malformed) == "NOT_FOUND"


# ---- create -------------------------------------------------------------------------------------


def test_create_user(admin: Api, world: World, db: Session, clock: FakeClock) -> None:
    response = admin.post("/users", json=_new_user(department_id=str(world.a.finance.id)))
    assert response.status_code == 201
    body = response.json()
    assert body["full_name"] == "New Person"
    assert body["email"] == "new.person@example.com"
    assert body["phone"] == "+962 79 111 2222"
    assert body["roles"] == ["EMPLOYEE"]
    assert body["department"] == {"id": str(world.a.finance.id), "name": "Finance", "name_ar": None}
    assert body["must_change_password"] is True and body["is_active"] is True
    assert "cancelled_visits" not in body

    created = refreshed(db, User, body["id"])
    assert created.company_id == world.a.company.id
    assert created.password_expires_at - clock.peek() < timedelta(hours=72)
    assert created.password_expires_at - clock.peek() > timedelta(hours=71)
    rows = audit_rows(db, "USER_CREATED", entity_id=created.id)
    assert rows[0].actor_user_id == world.a.admin.id
    assert rows[0].meta == {"roles": ["EMPLOYEE"], "department_id": str(world.a.finance.id)}
    assert "new.person" not in str(rows[0].meta)

    login = Api(TestClient(admin.client.app, base_url="https://testserver")).login(
        "new.person@example.com", TEMP_PASSWORD
    )
    assert login.status_code == 200 and login.json()["user"]["must_change_password"] is True


def test_temporary_password_expires_after_72_hours(admin: Api, make_client, clock: FakeClock) -> None:
    admin.post("/users", json=_new_user())
    clock.advance(hours=72, seconds=1)
    response = Api(make_client()).login("new.person@example.com", TEMP_PASSWORD)
    assert response.status_code == 401
    assert error_code(response) == "INVALID_CREDENTIALS"


@pytest.mark.parametrize("existing", ["same_company", "other_company"])
def test_create_user_with_taken_email(admin: Api, world: World, existing: str) -> None:
    email = world.a.employee.email if existing == "same_company" else world.b.employee.email
    response = admin.post("/users", json=_new_user(email=email.upper()))
    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "USER_EMAIL_UNAVAILABLE",
        "message": "This email address cannot be used.",
        "details": {},
    }


@pytest.mark.parametrize(
    ("department", "message"),
    [
        ("other_company", "does not exist"),
        ("missing", "does not exist"),
        ("inactive", "inactive"),
    ],
)
def test_create_user_department_must_be_assignable(
    admin: Api, world: World, department: str, message: str
) -> None:
    department_id = {
        "other_company": world.b.finance.id,
        "missing": "00000000-0000-0000-0000-000000000000",
        "inactive": world.a.legacy.id,
    }[department]
    response = admin.post("/users", json=_new_user(department_id=str(department_id)))
    assert response.status_code == 422
    assert message in response.json()["error"]["details"]["fields"]["department_id"]


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"roles": []}, "roles"),
        ({"roles": ["EMPLOYEE", "EMPLOYEE"]}, "roles"),
        ({"roles": ["SUPERUSER"]}, "roles.0"),
        ({"email": "not-an-email"}, "email"),
        ({"temporary_password": "short"}, "temporary_password"),
        ({"temporary_password": "new.person@example.com"}, "temporary_password"),
        ({"full_name": "   "}, "full_name"),
        ({"unexpected": True}, "unexpected"),
    ],
)
def test_create_user_validation(admin: Api, overrides: dict, field: str) -> None:
    response = admin.post("/users", json=_new_user(**overrides))
    assert response.status_code == 422
    assert field in response.json()["error"]["details"]["fields"]


# ---- update -------------------------------------------------------------------------------------


def test_update_profile_fields(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(
        f"/users/{world.a.employee.id}",
        json={"full_name": "Renamed", "phone": None, "department_id": str(world.a.finance.id)},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["full_name"] == "Renamed" and body["phone"] is None
    assert body["department"] == {"id": str(world.a.finance.id), "name": "Finance", "name_ar": None}
    rows = audit_rows(db, "USER_UPDATED", entity_id=world.a.employee.id)
    assert rows[-1].meta == {"changed_fields": ["full_name", "phone", "department_id"]}

    cleared = admin.patch(f"/users/{world.a.employee.id}", json={"department_id": None})
    assert cleared.json()["department"] is None


def test_update_without_changes_writes_no_audit(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(f"/users/{world.a.employee.id}", json={"full_name": world.a.employee.full_name})
    assert response.status_code == 200
    assert audit_rows(db, "USER_UPDATED", company_id=world.a.company.id) == []


def test_update_rejects_null_for_required_fields(admin: Api, world: World) -> None:
    response = admin.patch(f"/users/{world.a.employee.id}", json={"roles": None, "is_active": None})
    assert response.status_code == 422
    assert set(response.json()["error"]["details"]["fields"]) == {"roles", "is_active"}


def test_update_role_change_is_audited(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(f"/users/{world.a.employee.id}", json={"roles": ["RECEPTIONIST", "EMPLOYEE"]})
    assert response.status_code == 200
    assert response.json()["roles"] == ["EMPLOYEE", "RECEPTIONIST"]
    rows = audit_rows(db, "USER_ROLES_CHANGED", entity_id=world.a.employee.id)
    assert rows[-1].meta == {"added": ["RECEPTIONIST"], "removed": []}


def test_update_department_from_other_company(admin: Api, world: World) -> None:
    response = admin.patch(f"/users/{world.a.employee.id}", json={"department_id": str(world.b.finance.id)})
    assert response.status_code == 422
    assert "department_id" in response.json()["error"]["details"]["fields"]


def test_update_user_of_other_company_is_not_found(admin: Api, world: World) -> None:
    response = admin.patch(f"/users/{world.b.employee.id}", json={"full_name": "Hijacked"})
    assert response.status_code == 404


@pytest.mark.parametrize("change", [{"roles": ["EMPLOYEE"]}, {"is_active": False}])
def test_admin_cannot_demote_or_deactivate_self(admin: Api, world: World, change: dict) -> None:
    response = admin.patch(f"/users/{world.a.admin.id}", json=change)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SELF_MODIFICATION"


def test_admin_can_edit_own_profile_and_keep_admin_role(admin: Api, world: World) -> None:
    response = admin.patch(
        f"/users/{world.a.admin.id}", json={"full_name": "Chief", "roles": ["SYSTEM_ADMIN", "EMPLOYEE"]}
    )
    assert response.status_code == 200


def test_deactivation_revokes_sessions_and_is_audited(
    admin: Api, make_client, world: World, db: Session
) -> None:
    victim = Api(make_client())
    victim.login(world.a.employee.email)

    response = admin.patch(f"/users/{world.a.employee.id}", json={"is_active": False})
    assert response.status_code == 200 and response.json()["is_active"] is False
    assert victim.get("/auth/me").status_code == 401
    assert victim.login(world.a.employee.email).status_code == 401
    rows = audit_rows(db, "USER_DEACTIVATED", entity_id=world.a.employee.id)
    assert rows[-1].meta == {"revoked_sessions": 1}

    assert admin.patch(f"/users/{world.a.employee.id}", json={"is_active": True}).status_code == 200
    assert len(audit_rows(db, "USER_REACTIVATED", entity_id=world.a.employee.id)) == 1
    assert victim.login(world.a.employee.email).status_code == 200


def test_another_admin_can_be_demoted_while_one_remains(admin: Api, world: World, factory: Factory) -> None:
    second = factory.user(world.a.company, roles=(Role.SYSTEM_ADMIN,))
    response = admin.patch(f"/users/{second.id}", json={"roles": ["EMPLOYEE"]})
    assert response.status_code == 200


def _authenticated(db: Session, user: User, clock: FakeClock) -> AuthContext:
    """The context a request authenticated now would carry (a live session)."""
    issued = SessionManager(db, SessionPolicy(timedelta(hours=12), timedelta(hours=4))).create(
        user, now=clock.now(), ip_address=None, user_agent=None
    )
    db.commit()
    return AuthContext.build(user, issued.session, frozenset(user.role_set))


def test_last_admin_guard_with_stale_authorization(
    db: Session, factory: Factory, hasher, settings, clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Admin B was authorised before A demoted B. B's request is refused by the re-check of its
    authorization (SEC-07) before anything else; the LAST_ADMIN guard stays as the backstop."""
    company = factory.company()
    admin_a = factory.user(company, roles=(Role.SYSTEM_ADMIN,))
    admin_b = factory.user(company, roles=(Role.SYSTEM_ADMIN,))
    service = users_service(db, hasher, settings)
    auth_a = _authenticated(db, admin_a, clock)
    auth_b = _authenticated(db, admin_b, clock)

    service.update_user(auth_a, admin_b.id, UserUpdate(roles=[Role.EMPLOYEE]), SYSTEM_CONTEXT)
    with pytest.raises(Forbidden):
        service.update_user(auth_b, admin_a.id, UserUpdate(roles=[Role.EMPLOYEE]), SYSTEM_CONTEXT)
    db.rollback()
    monkeypatch.setattr("app.services.users.require_still_authorized", lambda *args, **kwargs: None)
    with pytest.raises(LastAdmin):
        service.update_user(auth_b, admin_a.id, UserUpdate(roles=[Role.EMPLOYEE]), SYSTEM_CONTEXT)
    db.rollback()
    with pytest.raises(LastAdmin):
        service.update_user(auth_b, admin_a.id, UserUpdate(is_active=False), SYSTEM_CONTEXT)


# ---- D-18 hook ----------------------------------------------------------------------------------


class RecordingCanceller:
    def __init__(self, cancelled: int) -> None:
        self.cancelled = cancelled
        self.calls: list[tuple[str, str]] = []

    def cancel_hosted_visits(
        self, db, *, host, actor, context, now: datetime, quota
    ) -> HostedVisitCancellation:
        self.calls.append((str(host.id), str(actor.user_id)))
        return HostedVisitCancellation(cancelled=self.cancelled)


@pytest.mark.parametrize(
    ("change", "expected_calls"),
    [
        ({"is_active": False}, 1),
        ({"roles": ["RECEPTIONIST"]}, 1),  # loses the last host role
        ({"roles": ["EMPLOYEE", "MANAGEMENT"]}, 0),  # still a host
        ({"full_name": "Just Renamed"}, 0),
    ],
)
def test_hosted_visit_cancellation_hook(
    app, admin: Api, world: World, change: dict, expected_calls: int
) -> None:
    canceller = RecordingCanceller(cancelled=2)
    original = app.state.hosted_visit_canceller
    app.state.hosted_visit_canceller = canceller
    try:
        response = admin.patch(f"/users/{world.a.employee.id}", json=change)
    finally:
        app.state.hosted_visit_canceller = original
    assert response.status_code == 200
    assert len(canceller.calls) == expected_calls
    if expected_calls:
        assert canceller.calls[0] == (str(world.a.employee.id), str(world.a.admin.id))
        assert response.json()["cancelled_visits"] == 2
    else:
        assert "cancelled_visits" not in response.json()


def test_deactivating_a_host_without_scheduled_visits_reports_nothing(admin: Api, world: World) -> None:
    response = admin.patch(f"/users/{world.a.employee.id}", json={"is_active": False})
    assert "cancelled_visits" not in response.json()


def test_new_user_password_hash_is_argon2(admin: Api, db: Session) -> None:
    body = admin.post("/users", json=_new_user()).json()
    stored = refreshed(db, User, body["id"])
    assert stored.password_hash.startswith("$argon2id$")
    assert DEFAULT_PASSWORD not in stored.password_hash


def test_production_wiring_of_the_hosted_visit_canceller(
    settings, app_engine, hasher, email_provider
) -> None:
    """D-18 must not depend on a test injecting the canceller: the factory wires the visit service's."""
    from app.main import create_app

    app = create_app(settings, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    assert isinstance(app.state.hosted_visit_canceller, HostedVisitCancellations)
