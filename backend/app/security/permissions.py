"""Roles and permission predicates (contract §7.5).

Users hold a set of roles (D-04); a capability is granted when ANY role grants it. `CAPABILITY_ROLES`
is the single source of truth for the matrix: routes use `api.deps.require_capability` and services use
`has_capability`; neither lists roles directly. Row-level rules (visit ownership, employee scope) are
the predicates below. All are pure functions over roles and IDs, usable without a database.
"""

from collections.abc import Collection
from enum import StrEnum
from uuid import UUID

from app.models.enums import Role

__all__ = [
    "CAPABILITY_ROLES",
    "HOST_ROLES",
    "Capability",
    "Role",
    "has_any_role",
    "has_capability",
    "is_available_host",
    "is_employee_only",
    "is_host",
    "is_visit_owner",
    "parse_roles",
]

HOST_ROLES: frozenset[Role] = frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE})


class Capability(StrEnum):
    """One capability per distinct role list in §7.5/§8. A route names exactly one; where the contract
    adds a row-level rule (visit ownership, employee visitor scope), the service applies it on top."""

    OWN_PROFILE = "own_profile"  # /auth/me, change own password
    READ_DIRECTORY = "read_directory"  # hosts, active departments, company settings (read)
    READ_VISITS = "read_visits"  # GET /visits, /visits/{id}; EMPLOYEE narrowed to owned visits
    READ_ALL_VISITS = "read_all_visits"  # the unnarrowed scope of READ_VISITS
    CREATE_VISIT = "create_visit"  # POST /visits, with the caller as the host
    INVITE_FOR_ANY_HOST = "invite_for_any_host"  # POST /visits with another active host (B10-24)
    MANAGE_OWN_VISITS = "manage_own_visits"  # update/cancel/resend SCHEDULED visits the caller owns
    MANAGE_ALL_VISITS = "manage_all_visits"  # update/cancel/resend any SCHEDULED visit
    READ_VISITORS = "read_visitors"  # visitor search, profile, history; EMPLOYEE narrowed to own scope
    READ_ALL_VISITORS = "read_all_visitors"  # the unnarrowed scope of READ_VISITORS
    CREATE_VISITOR = "create_visitor"  # POST /visitors
    EDIT_VISITOR = "edit_visitor"  # PATCH /visitors/{id}; EMPLOYEE only under the §7.5 ownership rule
    EDIT_ANY_VISITOR = "edit_any_visitor"  # PATCH /visitors/{id} without the ownership rule
    RECEPTION = "reception"  # scan, check-in/out, bulk stale check-out, today, walk-in
    VIEW_INSIDE = "view_inside"  # GET /reception/inside (evacuation list)
    VIEW_HISTORY = "view_history"  # company-wide read-only visit history (D-25)
    EMPLOYEE_DASHBOARD = "employee_dashboard"  # GET /dashboard/employee
    ADMIN_DASHBOARD = "admin_dashboard"  # GET /dashboard/admin
    VIEW_REPORTS = "view_reports"  # GET /reports/summary
    ADMINISTER = "administer"  # users, departments, company settings (write)
    READ_AUDIT = "read_audit"  # GET /audit-logs


_ALL = frozenset(Role)
_HOSTS = HOST_ROLES  # owners of visits are hosts (EMPLOYEE or SYSTEM_ADMIN)
_ADMIN = frozenset({Role.SYSTEM_ADMIN})
_COMPANY_WIDE_READERS = frozenset({Role.SYSTEM_ADMIN, Role.RECEPTIONIST, Role.MANAGEMENT})
CAPABILITY_ROLES: dict[Capability, frozenset[Role]] = {
    Capability.OWN_PROFILE: _ALL,
    Capability.READ_DIRECTORY: _ALL,
    Capability.READ_VISITS: _ALL,
    Capability.READ_ALL_VISITS: _COMPANY_WIDE_READERS,
    Capability.CREATE_VISIT: _HOSTS,
    Capability.INVITE_FOR_ANY_HOST: _ADMIN,
    Capability.MANAGE_OWN_VISITS: _HOSTS,
    Capability.MANAGE_ALL_VISITS: _ADMIN,
    Capability.READ_VISITORS: _ALL,
    Capability.READ_ALL_VISITORS: _COMPANY_WIDE_READERS,
    Capability.CREATE_VISITOR: frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE, Role.RECEPTIONIST}),
    Capability.EDIT_VISITOR: frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE, Role.RECEPTIONIST}),
    Capability.EDIT_ANY_VISITOR: frozenset({Role.SYSTEM_ADMIN, Role.RECEPTIONIST}),
    Capability.RECEPTION: frozenset({Role.SYSTEM_ADMIN, Role.RECEPTIONIST}),
    Capability.VIEW_INSIDE: _COMPANY_WIDE_READERS,
    Capability.VIEW_HISTORY: _COMPANY_WIDE_READERS,
    Capability.EMPLOYEE_DASHBOARD: frozenset({Role.SYSTEM_ADMIN, Role.EMPLOYEE}),
    Capability.ADMIN_DASHBOARD: _ADMIN,
    Capability.VIEW_REPORTS: frozenset({Role.SYSTEM_ADMIN, Role.MANAGEMENT}),
    Capability.ADMINISTER: _ADMIN,
    Capability.READ_AUDIT: _ADMIN,
}


def parse_roles(values: Collection[str]) -> frozenset[Role]:
    """Roles from stored strings; unknown values are ignored (the DB CHECK already rejects them)."""
    known = {role.value for role in Role}
    return frozenset(Role(value) for value in values if value in known)


def has_any_role(roles: Collection[Role], *required: Role) -> bool:
    return not set(roles).isdisjoint(required)


def has_capability(roles: Collection[Role], capability: Capability) -> bool:
    return not CAPABILITY_ROLES[capability].isdisjoint(roles)


def is_host(roles: Collection[Role]) -> bool:
    """Hosts are users holding EMPLOYEE or SYSTEM_ADMIN (activity is checked separately)."""
    return has_any_role(roles, *HOST_ROLES)


def is_available_host(*, is_active: bool, roles: Collection[Role]) -> bool:
    """§7.5 "Hosts = active users with EMPLOYEE or SYSTEM_ADMIN": whether a user can host a visit now
    (be chosen as host, have visitors checked in, be told of their arrival). A deactivated user and one
    whose host roles were removed are both unavailable; D-18 cancels only their SCHEDULED visits."""
    return is_active and is_host(roles)


def is_employee_only(roles: Collection[Role]) -> bool:
    """EMPLOYEE without any role that widens visitor/visit visibility (contract §7.5 last bullet)."""
    return Role.EMPLOYEE in roles and set(roles) <= {Role.EMPLOYEE}


def is_visit_owner(*, user_id: UUID, roles: Collection[Role], host_id: UUID, created_by_id: UUID) -> bool:
    """Owner = holds EMPLOYEE or SYSTEM_ADMIN and is the visit's host or creator."""
    return is_host(roles) and user_id in (host_id, created_by_id)
