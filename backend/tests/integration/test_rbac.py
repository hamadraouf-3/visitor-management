"""Role-based access for every Phase-1 endpoint and every role (contract §7.5 / §8)."""

from collections.abc import Callable

import pytest
from sqlalchemy.orm import Session

from app.models import Role
from tests.support import Api, Factory, World, audit_rows

ALL = frozenset(Role)
ADMIN = frozenset({Role.SYSTEM_ADMIN})

# (name, method, path builder, json body, roles allowed, expected success status)
Endpoint = tuple[str, str, Callable[[World], str], dict | None, frozenset[Role], int]

ENDPOINTS: list[Endpoint] = [
    ("me", "get", lambda w: "/auth/me", None, ALL, 200),
    ("hosts", "get", lambda w: "/users/hosts", None, ALL, 200),
    ("departments", "get", lambda w: "/departments", None, ALL, 200),
    ("departments_inactive", "get", lambda w: "/departments?include_inactive=true", None, ADMIN, 200),
    ("company_get", "get", lambda w: "/company/settings", None, ALL, 200),
    ("users_list", "get", lambda w: "/users", None, ADMIN, 200),
    ("users_get", "get", lambda w: f"/users/{w.a.employee.id}", None, ADMIN, 200),
    (
        "users_create",
        "post",
        lambda w: "/users",
        {
            "full_name": "RBAC Probe",
            "email": "rbac.probe@example.com",
            "roles": ["EMPLOYEE"],
            "temporary_password": "Indigo-Walrus-Password-1",
        },
        ADMIN,
        201,
    ),
    ("users_patch", "patch", lambda w: f"/users/{w.a.employee.id}", {"phone": "+1 555 0100"}, ADMIN, 200),
    ("departments_create", "post", lambda w: "/departments", {"name": "RBAC Dept"}, ADMIN, 201),
    ("departments_patch", "patch", lambda w: f"/departments/{w.a.finance.id}", {"name": "Fin"}, ADMIN, 200),
    ("company_patch", "patch", lambda w: "/company/settings", {"allow_walk_ins": False}, ADMIN, 200),
]


def _call(api: Api, method: str, path: str, body: dict | None):
    if method == "get":
        return api.get(path)
    return getattr(api, method)(path, json=body)


@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda endpoint: endpoint[0])
def test_role_matrix(make_client, world: World, db: Session, endpoint: Endpoint, role: Role) -> None:
    name, method, path, body, allowed, success = endpoint
    user = world.a.users_by_role[role]
    api = Api(make_client())
    assert api.login(user.email).status_code == 200

    response = _call(api, method, path(world), body)

    if role in allowed:
        assert response.status_code == success, (name, role, response.text)
    else:
        assert response.status_code == 403, (name, role, response.text)
        assert response.json()["error"]["code"] == "FORBIDDEN"
        assert audit_rows(db, "ACCESS_DENIED", actor_user_id=user.id), "denial must be audited"


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda endpoint: endpoint[0])
def test_unauthenticated_requests_get_401(make_client, world: World, endpoint: Endpoint) -> None:
    _name, method, path, body, _allowed, _success = endpoint
    response = _call(Api(make_client()), method, path(world), body)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"


def test_union_of_roles_grants_access(make_client, factory: Factory, world: World) -> None:
    user = factory.user(world.a.company, roles=(Role.MANAGEMENT, Role.SYSTEM_ADMIN))
    api = Api(make_client())
    api.login(user.email)
    assert api.get("/users").status_code == 200


def test_denied_request_with_invalid_body_still_gets_403(make_client, world: World) -> None:
    api = Api(make_client())
    api.login(world.a.employee.email)
    response = api.post("/users", json={"nonsense": True})
    assert response.status_code == 403


@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
def test_session_endpoints_work_for_every_role(make_client, world: World, role: Role) -> None:
    user = world.a.users_by_role[role]
    api = Api(make_client())
    assert api.login(user.email).status_code == 200

    me = api.get("/auth/me")
    assert me.status_code == 200 and me.json()["user"]["id"] == str(user.id)
    wrong = {"current_password": "wrong-password-xx", "new_password": "Whatever-Kiwi-Lantern-123"}
    change = api.post("/auth/change-password", json=wrong)
    assert change.status_code == 400 and change.json()["error"]["code"] == "INVALID_CURRENT_PASSWORD"
    logout = api.post("/auth/logout")
    assert logout.status_code == 204 and logout.content == b""
    assert api.get("/auth/me").status_code == 401
