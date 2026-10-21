import uuid
from types import SimpleNamespace

import pytest

from app.api.deps import AdminAuth, require_capability
from app.core.errors import Forbidden
from app.security.permissions import (
    CAPABILITY_ROLES,
    Capability,
    Role,
    has_any_role,
    has_capability,
    is_available_host,
    is_employee_only,
    is_host,
    is_visit_owner,
    parse_roles,
)
from app.security.sessions import INSECURE_COOKIE_NAMES, SECURE_COOKIE_NAMES, cookie_names

ME = uuid.uuid4()
OTHER = uuid.uuid4()


def test_cookie_names() -> None:
    assert cookie_names(True) == SECURE_COOKIE_NAMES
    assert (SECURE_COOKIE_NAMES.session, SECURE_COOKIE_NAMES.csrf) == (
        "__Host-vms_session",
        "__Host-vms_csrf",
    )
    assert cookie_names(False) == INSECURE_COOKIE_NAMES
    assert (INSECURE_COOKIE_NAMES.session, INSECURE_COOKIE_NAMES.csrf) == ("vms_session", "vms_csrf")


def test_role_predicates() -> None:
    assert is_host({Role.EMPLOYEE}) and is_host({Role.SYSTEM_ADMIN})
    assert not is_host({Role.RECEPTIONIST, Role.MANAGEMENT})
    assert has_any_role({Role.MANAGEMENT, Role.EMPLOYEE}, Role.EMPLOYEE)
    assert not has_any_role({Role.MANAGEMENT}, Role.EMPLOYEE, Role.SYSTEM_ADMIN)


@pytest.mark.parametrize(
    ("is_active", "roles", "expected"),
    [
        (True, {Role.EMPLOYEE}, True),
        (True, {Role.SYSTEM_ADMIN, Role.MANAGEMENT}, True),
        (False, {Role.EMPLOYEE}, False),  # deactivated
        (True, {Role.RECEPTIONIST}, False),  # host roles removed (D-18 cancels only SCHEDULED visits)
        (True, {Role.MANAGEMENT}, False),
    ],
)
def test_available_host_is_active_and_holds_a_host_role(
    is_active: bool, roles: set[Role], expected: bool
) -> None:
    assert is_available_host(is_active=is_active, roles=roles) is expected


@pytest.mark.parametrize(
    ("roles", "expected"),
    [
        ({Role.EMPLOYEE}, True),
        ({Role.EMPLOYEE, Role.MANAGEMENT}, False),
        ({Role.EMPLOYEE, Role.SYSTEM_ADMIN}, False),
        ({Role.RECEPTIONIST}, False),
    ],
)
def test_employee_only(roles: set[Role], expected: bool) -> None:
    assert is_employee_only(roles) is expected


@pytest.mark.parametrize(
    ("roles", "host_id", "created_by_id", "expected"),
    [
        ({Role.EMPLOYEE}, ME, OTHER, True),
        ({Role.EMPLOYEE}, OTHER, ME, True),
        ({Role.EMPLOYEE}, OTHER, OTHER, False),
        ({Role.SYSTEM_ADMIN}, ME, OTHER, True),
        ({Role.RECEPTIONIST}, ME, ME, False),  # must hold a host role
        ({Role.MANAGEMENT}, ME, OTHER, False),
        ({Role.MANAGEMENT, Role.EMPLOYEE}, OTHER, ME, True),
    ],
)
def test_visit_owner(roles, host_id, created_by_id, expected) -> None:
    assert is_visit_owner(user_id=ME, roles=roles, host_id=host_id, created_by_id=created_by_id) is expected


A, E, R, M = Role.SYSTEM_ADMIN, Role.EMPLOYEE, Role.RECEPTIONIST, Role.MANAGEMENT

# Written from contract §7.5 and the §8 endpoint table, independently of CAPABILITY_ROLES.
EXPECTED_MATRIX: dict[Capability, set[Role]] = {
    Capability.OWN_PROFILE: {A, E, R, M},  # own profile, change own password
    Capability.READ_DIRECTORY: {A, E, R, M},  # hosts, active departments, company settings (read)
    Capability.READ_VISITS: {A, E, R, M},  # GET /visits, /visits/{id}: "scoped"
    Capability.READ_ALL_VISITS: {A, R, M},  # "all"; EMPLOYEE "owned only"
    Capability.CREATE_VISIT: {A, E},  # POST /visits
    Capability.INVITE_FOR_ANY_HOST: {A},  # POST /visits for another host: EMPLOYEE "themselves only" (B10-24)
    Capability.MANAGE_OWN_VISITS: {A, E},  # PATCH/cancel/invitation: owner
    Capability.MANAGE_ALL_VISITS: {A},  # PATCH/cancel/invitation: admin, any SCHEDULED visit
    Capability.READ_VISITORS: {A, E, R, M},  # GET /visitors, /visitors/{id}, /visitors/{id}/visits
    Capability.READ_ALL_VISITORS: {A, R, M},  # EMPLOYEE: own scope
    Capability.CREATE_VISITOR: {A, E, R},  # POST /visitors
    Capability.EDIT_VISITOR: {A, E, R},  # PATCH /visitors/{id}: rule §7.5 (MANAGEMENT -)
    Capability.EDIT_ANY_VISITOR: {A, R},  # without the employee ownership rule
    Capability.RECEPTION: {A, R},  # scan, check-in/out, stale check-out, today, walk-ins
    Capability.VIEW_INSIDE: {A, R, M},  # GET /reception/inside
    Capability.VIEW_HISTORY: {A, R, M},  # company-wide history page (D-25)
    Capability.EMPLOYEE_DASHBOARD: {A, E},  # GET /dashboard/employee
    Capability.ADMIN_DASHBOARD: {A},  # GET /dashboard/admin
    Capability.VIEW_REPORTS: {A, M},  # GET /reports/summary
    Capability.ADMINISTER: {A},  # users, departments, company settings (write)
    Capability.READ_AUDIT: {A},  # GET /audit-logs
    # Phase 15 (B15-13): journeys, the tracking status and the location tree; hosts are refused.
    Capability.VIEW_JOURNEYS: {A, R, M},
    Capability.TRACK_VISITS: {A, R},  # enroll, revoke, the enrollment cameras
}


def test_capability_matrix_matches_contract() -> None:
    assert set(EXPECTED_MATRIX) == set(Capability)
    for capability, roles in EXPECTED_MATRIX.items():
        assert CAPABILITY_ROLES[capability] == roles, capability


@pytest.mark.parametrize("capability", list(Capability), ids=lambda capability: capability.value)
def test_has_capability_is_the_union_of_roles(capability: Capability) -> None:
    for role in Role:
        assert has_capability({role}, capability) is (role in EXPECTED_MATRIX[capability])
    # D-04: a capability is granted when ANY of the roles grants it.
    assert has_capability(set(Role), capability)
    assert not has_capability(set(), capability)


def test_multi_role_examples() -> None:
    assert has_capability({Role.MANAGEMENT, Role.EMPLOYEE}, Capability.CREATE_VISIT)
    # Inviting on behalf of another host is the administrator's alone, whatever else a user holds (B10-24).
    assert not has_capability({Role.MANAGEMENT, Role.EMPLOYEE}, Capability.INVITE_FOR_ANY_HOST)
    assert not has_capability({Role.RECEPTIONIST, Role.EMPLOYEE}, Capability.INVITE_FOR_ANY_HOST)
    assert has_capability({Role.SYSTEM_ADMIN, Role.EMPLOYEE}, Capability.INVITE_FOR_ANY_HOST)
    assert not has_capability({Role.MANAGEMENT}, Capability.EDIT_ANY_VISITOR)
    assert not has_capability({Role.MANAGEMENT}, Capability.CREATE_VISITOR)
    assert has_capability({Role.RECEPTIONIST}, Capability.CREATE_VISITOR)
    assert not has_capability({Role.RECEPTIONIST}, Capability.EMPLOYEE_DASHBOARD)


def test_parse_roles_ignores_unknown_values() -> None:
    assert parse_roles(["EMPLOYEE", "ROOT"]) == frozenset({Role.EMPLOYEE})


@pytest.mark.parametrize("capability", list(Capability), ids=lambda capability: capability.value)
@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
def test_require_capability_enforces_the_matrix(capability: Capability, role: Role) -> None:
    check = require_capability(capability)
    auth = SimpleNamespace(roles=frozenset({role}))
    if role in CAPABILITY_ROLES[capability]:
        assert check(auth) is auth  # type: ignore[arg-type]
    else:
        with pytest.raises(Forbidden):
            check(auth)  # type: ignore[arg-type]


def test_admin_routes_are_gated_by_the_administer_capability() -> None:
    dependency = AdminAuth.__metadata__[0].dependency
    assert dependency.__name__ == "require_administer"
    with pytest.raises(Forbidden):
        dependency(SimpleNamespace(roles=frozenset({Role.MANAGEMENT, Role.EMPLOYEE, Role.RECEPTIONIST})))
