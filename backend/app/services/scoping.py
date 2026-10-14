"""Tenant-scoped ID resolution (contract §3.2-5).

`company_id` always comes from the authenticated user. IDs supplied by the client are looked up through
company-scoped repositories; a miss means "not yours or not there", answered as:
* path IDs  -> 404 NOT_FOUND (`require_found`)
* body/filter IDs -> 422 VALIDATION_ERROR with a field error (`FieldErrors.require`)
Both answers are identical for "does not exist" and "belongs to another company" (no existence oracle).

`FieldErrors` collects every field problem of a request (unresolvable references and other rule
violations) so the client sees them all at once:

    errors = FieldErrors()
    host = errors.require(users.get_in_company(company_id, data.host_id), "host_id")
    department = errors.require(departments.get(company_id, data.department_id), "department_id")
    errors.raise_if_any()
"""

from uuid import UUID

from app.core.errors import NotFound, ValidationFailed
from app.core.field_errors import FieldCode, FieldProblem
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext

REFERENCE_NOT_FOUND = FieldProblem(FieldCode.NOT_FOUND, "The selected item does not exist.")


def visit_read_owner(auth: AuthContext) -> UUID | None:
    """The owner filter for reading visits (contract §7.5): None (the whole company) for roles that read
    every visit, otherwise the caller, who then sees only visits they host or created."""
    return None if has_capability(auth.roles, Capability.READ_ALL_VISITS) else auth.user_id


def visitor_read_owner(auth: AuthContext) -> UUID | None:
    """The owner filter for reading visitors: None for roles that read every visitor, otherwise the
    caller, who then sees visitors they created or that are linked to a visit they own."""
    return None if has_capability(auth.roles, Capability.READ_ALL_VISITORS) else auth.user_id


def require_found[T](entity: T | None) -> T:
    if entity is None:
        raise NotFound()
    return entity


class FieldErrors:
    def __init__(self) -> None:
        self._fields: dict[str, FieldProblem] = {}

    def add(self, field: str, problem: FieldProblem) -> None:
        """Record a problem (its code and message); the first problem per field wins."""
        self._fields.setdefault(field, problem)

    def require[T](
        self, entity: T | None, field: str, problem: FieldProblem = REFERENCE_NOT_FOUND
    ) -> T | None:
        """Pass a scoped lookup result through, recording a field error when it found nothing."""
        if entity is None:
            self.add(field, problem)
        return entity

    def include(self, other: FieldErrors) -> None:
        """Record the problems another collector found (e.g. for a reference resolved before it was
        known whether the request changes it); the first problem per field still wins."""
        for field, problem in other._fields.items():
            self.add(field, problem)

    def __bool__(self) -> bool:
        return bool(self._fields)

    def raise_if_any(self) -> None:
        if self._fields:
            raise ValidationFailed(dict(self._fields))
