"""Role-based access for every Phase 5-7 endpoint and every role (contract §7.5 / §8): allowed roles
succeed, the others get 403 FORBIDDEN with an ACCESS_DENIED audit row, anonymous callers 401, and unsafe
methods need the CSRF token."""

from collections.abc import Callable
from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.models import Role
from tests.conftest import TEST_START
from tests.support import Api, World, audit_rows, check_in, create_visit, signed_in, walk_in_body

ALL = frozenset(Role)
HOSTS = frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE})
RECEPTION = frozenset({Role.SYSTEM_ADMIN, Role.RECEPTIONIST})
INSIDE = frozenset({Role.SYSTEM_ADMIN, Role.RECEPTIONIST, Role.MANAGEMENT})
REPORTS = frozenset({Role.SYSTEM_ADMIN, Role.MANAGEMENT})
ADMIN = frozenset({Role.SYSTEM_ADMIN})
START = TEST_START + timedelta(hours=1)

type Builder = Callable[[World, dict], object]
# (name, method, path(world, visits), body(world, visits), roles allowed, success status)
ENDPOINTS: list[tuple[str, str, Builder, Builder, frozenset[Role], int]] = [
    (
        "check_in",
        "post",
        lambda w, v: f"/visits/{v['scheduled']['visit']['id']}/check-in",
        lambda w, v: {"method": "MANUAL"},
        RECEPTION,
        200,
    ),
    (
        "check_out",
        "post",
        lambda w, v: f"/visits/{v['inside']['visit']['id']}/check-out",
        lambda w, v: {"method": "MANUAL"},
        RECEPTION,
        200,
    ),
    (
        "reissue_pass",
        "post",
        lambda w, v: f"/visits/{v['scheduled']['visit']['id']}/pass",
        lambda w, v: None,
        HOSTS,
        200,
    ),
    ("reception_today", "get", lambda w, v: "/reception/today", lambda w, v: None, RECEPTION, 200),
    ("reception_inside", "get", lambda w, v: "/reception/inside", lambda w, v: None, INSIDE, 200),
    (
        "check_out_stale",
        "post",
        lambda w, v: "/reception/check-out-stale",
        lambda w, v: {"reason": "End of day"},
        RECEPTION,
        200,
    ),
    (
        "walk_in",
        "post",
        lambda w, v: "/reception/walk-ins",
        lambda w, v: walk_in_body(w.a.employee.id, START + timedelta(hours=1)),
        RECEPTION,
        201,
    ),
    ("dashboard_admin", "get", lambda w, v: "/dashboard/admin", lambda w, v: None, ADMIN, 200),
    ("reports_summary", "get", lambda w, v: "/reports/summary", lambda w, v: None, REPORTS, 200),
    ("audit_logs", "get", lambda w, v: "/audit-logs", lambda w, v: None, ADMIN, 200),
    # GET /visits for the company-wide history page (D-25): every role, scoped for employees.
    (
        "history",
        "get",
        lambda w, v: "/visits?scope=all&status=SCHEDULED,CHECKED_IN",
        lambda w, v: None,
        ALL,
        200,
    ),
]


@pytest.fixture
def visits(make_client, world: World) -> dict:
    owner = signed_in(make_client, world.a.employee)
    scheduled = create_visit(owner, world.a.employee.id, START, visitor={"full_name": "Scheduled RBAC"})
    inside = create_visit(owner, world.a.employee.id, START, visitor={"full_name": "Inside RBAC"})
    assert check_in(signed_in(make_client, world.a.receptionist), inside["visit"]["id"]).status_code == 200
    return {"scheduled": scheduled, "inside": inside}


def _call(api: Api, method: str, path: str, body: object):
    if method == "get":
        return api.get(path)
    return getattr(api, method)(path, json=body)


@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda endpoint: endpoint[0])
def test_role_matrix(make_client, world: World, visits: dict, db: Session, endpoint, role: Role) -> None:
    name, method, path, body, allowed, success = endpoint
    user = world.a.users_by_role[role]
    response = _call(signed_in(make_client, user), method, path(world, visits), body(world, visits))
    if role in allowed:
        assert response.status_code == success, (name, role, response.text)
    else:
        assert response.status_code == 403, (name, role, response.text)
        assert response.json()["error"]["code"] == "FORBIDDEN"
        [denied] = audit_rows(db, "ACCESS_DENIED", actor_user_id=user.id)
        assert denied.meta["method"] == method.upper() and denied.company_id == world.a.company.id


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda endpoint: endpoint[0])
def test_unauthenticated_requests_get_401(make_client, world: World, visits: dict, endpoint) -> None:
    _name, method, path, body, _allowed, _success = endpoint
    response = _call(Api(make_client()), method, path(world, visits), body(world, visits))
    assert response.status_code == 401 and response.json()["error"]["code"] == "NOT_AUTHENTICATED"


@pytest.mark.parametrize(
    "endpoint", [e for e in ENDPOINTS if e[1] != "get"], ids=lambda endpoint: endpoint[0]
)
def test_unsafe_requests_need_the_csrf_token(make_client, world: World, visits: dict, endpoint) -> None:
    _name, method, path, body, _allowed, _success = endpoint
    api = signed_in(make_client, world.a.admin)
    response = getattr(api, method)(path(world, visits), json=body(world, visits), csrf=False)
    assert response.status_code == 403 and response.json()["error"]["code"] == "CSRF_FAILED"


def test_a_user_with_several_roles_gets_the_union(make_client, world: World, factory, visits: dict) -> None:
    """D-04: MANAGEMENT + RECEPTIONIST reads reports and checks visitors in."""
    user = factory.user(world.a.company, roles=(Role.MANAGEMENT, Role.RECEPTIONIST))
    api = signed_in(make_client, user)
    assert api.get("/reports/summary").status_code == 200
    assert check_in(api, visits["scheduled"]["visit"]["id"]).status_code == 200
    assert api.get("/audit-logs").status_code == 403
