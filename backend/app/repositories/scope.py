"""Read-scope predicates of contract §7.5, shared by the visit and visitor repositories.

* A user owns a visit they host or created, except a walk-in, which belongs to its host only:
  reception registers it on the host's behalf (SEC-08).
* An EMPLOYEE-only user reads the visitors they created while their own read scope was limited to
  their own (`visitors.owned_by_creator`, SEC-08) or that are linked to a visit they own, except
  through links made by reusing a visitor outside their scope (`visits.visitor_link_in_scope` false,
  B24-15): typing a known e-mail address into the invitation form must not open the stored record.

Without the two SEC-08 conditions, a receptionist moved to an EMPLOYEE-only role kept reading (and
editing) every visitor and walk-in they had registered at the desk, indefinitely.
"""

from uuid import UUID

from sqlalchemy import ColumnElement, and_, exists, or_
from sqlalchemy.orm import aliased

from app.models import Visit, Visitor


def owned_by(owner_id: UUID, visit: type[Visit] = Visit) -> ColumnElement[bool]:
    return or_(visit.host_id == owner_id, and_(visit.created_by_id == owner_id, visit.is_walk_in.is_(False)))


def visitor_readable_by(owner_id: UUID) -> ColumnElement[bool]:
    """Correlated to `Visitor`: the visitor is in the read scope of the EMPLOYEE-only user `owner_id`.

    The linked visit is an alias, so the predicate also works inside a query on `Visit` (whose own row
    is not the linked one)."""
    linked = aliased(Visit)
    return or_(
        and_(Visitor.created_by_id == owner_id, Visitor.owned_by_creator.is_(True)),
        exists().where(
            linked.company_id == Visitor.company_id,
            linked.visitor_id == Visitor.id,
            owned_by(owner_id, linked),
            linked.visitor_link_in_scope.is_(True),
        ),
    )
