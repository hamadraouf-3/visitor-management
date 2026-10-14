"""Reading the audit trail (contract §8 GET /audit-logs, §8.1 `AuditLog`; administrators only, D-13).

Rows of the caller's company only, newest first by `seq`. Filters: `action` and `entity_type` match
exactly (any well-formed value; an unknown one simply matches nothing), `actor_user_id` must be a user
of the company (otherwise a 422 field error, §3.2-5), `entity_id` matches the rows of that ID within the
company's own trail (it may name a visit, visitor, user, pass, e-mail, department, session or the
company, so it is not resolved), and `date_from` / `date_to` are company-local dates of `created_at`.
Each row names its actor with their current name.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.time import company_date_filter_bounds
from app.models import AuditLog
from app.repositories.audit_logs import AuditLogFilters, AuditLogRepository
from app.repositories.users import UserRepository
from app.schemas.audit import AuditLog as AuditLogOut
from app.schemas.audit import AuditLogQuery
from app.schemas.common import Paginated, UserRef
from app.security.sessions import AuthContext
from app.services.scoping import FieldErrors


def audit_log_views(db: Session, company_id: UUID, rows: Sequence[AuditLog]) -> list[AuditLogOut]:
    """§8.1 `AuditLog` for rows of `company_id`, with each actor's current name (two queries)."""
    actor_ids = {row.actor_user_id for row in rows if row.actor_user_id is not None}
    actors = UserRepository(db).summaries(company_id, actor_ids)
    views = []
    for row in rows:
        actor = None
        if row.actor_user_id is not None:
            summary = actors.get(row.actor_user_id)
            actor = UserRef(id=row.actor_user_id, full_name=summary.full_name if summary else "")
        views.append(AuditLogOut.from_row(row, actor=actor))
    return views


class AuditTrailService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.audit_logs = AuditLogRepository(db)
        self.users = UserRepository(db)

    def search(self, auth: AuthContext, query: AuditLogQuery) -> Paginated[AuditLogOut]:
        errors = FieldErrors()
        if query.actor_user_id is not None:
            errors.require(self.users.get_in_company(auth.company_id, query.actor_user_id), "actor_user_id")
        errors.raise_if_any()
        created_from, created_before = company_date_filter_bounds(
            query.date_from, query.date_to, auth.user.company.timezone
        )
        page = self.audit_logs.search(
            auth.company_id,
            filters=AuditLogFilters(
                action=query.action,
                actor_user_id=query.actor_user_id,
                entity_type=query.entity_type,
                entity_id=query.entity_id,
                created_from=created_from,
                created_before=created_before,
            ),
            page=query.page,
            page_size=query.page_size,
        )
        return Paginated[AuditLogOut](
            items=audit_log_views(self.db, auth.company_id, page.items),
            page=page.page,
            page_size=page.page_size,
            total=page.total,
        )
