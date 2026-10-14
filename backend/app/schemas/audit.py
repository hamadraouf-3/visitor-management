"""Audit log schema (contract §8 /audit-logs, §8.1 `AuditLog`)."""

from typing import Annotated, Any
from uuid import UUID

from pydantic import StringConstraints

from app.models import AuditLog as AuditLogRow
from app.schemas.common import DateRangeQuery, PageQuery, ResponseModel, UserRef, UTCDatetime

# Filter values have the shape of stored actions (`USER_UPDATED`) and entity types (`user`); the set
# grows with later phases, so any well-formed value is accepted and simply matches nothing if unknown.
AuditActionFilter = Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")]
EntityTypeFilter = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,31}$")]


class AuditLogQuery(PageQuery, DateRangeQuery):
    """GET /audit-logs (administrators): newest first by `seq`; dates are company-local."""

    action: AuditActionFilter | None = None
    actor_user_id: UUID | None = None
    entity_type: EntityTypeFilter | None = None
    entity_id: UUID | None = None


class AuditLog(ResponseModel):
    """Build with `from_row`, not `model_validate(row)`: the ORM attribute is `meta` (`metadata` is
    SQLAlchemy's MetaData on declarative classes), `ip_address` is an `ipaddress` object, and `actor`
    comes from a join the caller performs."""

    id: UUID
    seq: int
    created_at: UTCDatetime
    action: str
    actor: UserRef | None
    entity_type: str | None
    entity_id: UUID | None
    metadata: dict[str, Any]
    ip_address: str | None
    user_agent: str | None
    request_id: str | None

    @classmethod
    def from_row(cls, row: AuditLogRow, *, actor: UserRef | None) -> AuditLog:
        return cls(
            id=row.id,
            seq=row.seq,
            created_at=row.created_at,
            action=row.action,
            actor=actor,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            metadata=dict(row.meta),
            ip_address=str(row.ip_address) if row.ip_address is not None else None,
            user_agent=row.user_agent,
            request_id=row.request_id,
        )
