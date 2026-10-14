"""Role-based access for every Phase 2-4 endpoint and every role (contract §7.5 / §8). Row-level scope is
covered by the visit and visitor tests; here the employee acts on a visit they own."""

from collections.abc import Callable
from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.models import Role
from tests.conftest import TEST_START
from tests.support import Api, World, audit_rows, create_visit, signed_in, visit_body

ALL = frozenset(Role)
HOSTS = frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE})
VISITOR_WRITERS = frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE, Role.RECEPTIONIST})
RECEPTION = frozenset({Role.SYSTEM_ADMIN, Role.RECEPTIONIST})
START = TEST_START + timedelta(hours=1)

# (name, method, path builder(world, visit), body builder(world, visit), roles allowed, success status)
type Builder = Callable[[World, dict], object]
ENDPOINTS: list[tuple[str, str, Builder, Builder, frozenset[Role], int]] = [
    ("visitors_search", "get", lambda w, v: "/visitors?q=dana", lambda w, v: None, ALL, 200),
    (
        "visitors_create",
        "post",
        lambda w, v: "/visitors",
        lambda w, v: {"full_name": "RBAC Visitor"},
        VISITOR_WRITERS,
        201,
    ),
    (
        "visitors_get",
        "get",
        lambda w, v: f"/visitors/{v['visit']['visitor']['id']}",
        lambda w, v: None,
        ALL,
        200,
    ),
    (
        "visitors_patch",
        "patch",
        lambda w, v: f"/visitors/{v['visit']['visitor']['id']}",
        lambda w, v: {"phone": "+962 79 555 0000"},
        VISITOR_WRITERS,
        200,
    ),
    (
        "visitors_history",
        "get",
        lambda w, v: f"/visitors/{v['visit']['visitor']['id']}/visits",
        lambda w, v: None,
        ALL,
        200,
    ),
    ("visits_list", "get", lambda w, v: "/visits", lambda w, v: None, ALL, 200),
    (
        "visits_create",
        "post",
        lambda w, v: "/visits",
        lambda w, v: visit_body(w.a.employee.id, START),
        HOSTS,
        201,
    ),
    ("visits_get", "get", lambda w, v: f"/visits/{v['visit']['id']}", lambda w, v: None, ALL, 200),
    (
        "visits_patch",
        "patch",
        lambda w, v: f"/visits/{v['visit']['id']}",
        lambda w, v: {"purpose": "RBAC"},
        HOSTS,
        200,
    ),
    ("visits_cancel", "post", lambda w, v: f"/visits/{v['visit']['id']}/cancel", lambda w, v: {}, HOSTS, 200),
    (
        "visits_resend",
        "post",
        lambda w, v: f"/visits/{v['visit']['id']}/invitation",
        lambda w, v: None,
        HOSTS,
        200,
    ),
    ("scan", "post", lambda w, v: "/reception/scan", lambda w, v: {"token": v["pass_url"]}, RECEPTION, 200),
    ("dashboard_employee", "get", lambda w, v: "/dashboard/employee", lambda w, v: None, HOSTS, 200),
]


@pytest.fixture
def visit(make_client, world: World) -> dict:
    owner = signed_in(make_client, world.a.employee)
    return create_visit(
        owner,
        world.a.employee.id,
        START,
        visitor={"full_name": "Dana RBAC", "email": "dana.rbac@example.com"},
    )


def _call(api: Api, method: str, path: str, body: object):
    if method == "get":
        return api.get(path)
    return getattr(api, method)(path, json=body)


@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda endpoint: endpoint[0])
def test_role_matrix(make_client, world: World, visit: dict, db: Session, endpoint, role: Role) -> None:
    name, method, path, body, allowed, success = endpoint
    user = world.a.users_by_role[role]
    response = _call(signed_in(make_client, user), method, path(world, visit), body(world, visit))
    if role in allowed:
        assert response.status_code == success, (name, role, response.text)
    else:
        assert response.status_code == 403, (name, role, response.text)
        assert response.json()["error"]["code"] == "FORBIDDEN"
        assert audit_rows(db, "ACCESS_DENIED", actor_user_id=user.id), "denial must be audited"


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda endpoint: endpoint[0])
def test_unauthenticated_requests_get_401(make_client, world: World, visit: dict, endpoint) -> None:
    _name, method, path, body, _allowed, _success = endpoint
    response = _call(Api(make_client()), method, path(world, visit), body(world, visit))
    assert response.status_code == 401 and response.json()["error"]["code"] == "NOT_AUTHENTICATED"


@pytest.mark.parametrize(
    "endpoint", [e for e in ENDPOINTS if e[1] != "get"], ids=lambda endpoint: endpoint[0]
)
def test_unsafe_requests_need_the_csrf_token(make_client, world: World, visit: dict, endpoint) -> None:
    _name, method, path, body, _allowed, _success = endpoint
    api = signed_in(make_client, world.a.admin)
    response = getattr(api, method)(path(world, visit), json=body(world, visit), csrf=False)
    assert response.status_code == 403 and response.json()["error"]["code"] == "CSRF_FAILED"
