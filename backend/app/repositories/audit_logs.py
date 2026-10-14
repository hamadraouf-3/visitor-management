"""Audit rows: appended by the services, read by administrators of the row's company (GET /audit-logs,
the administrator dashboard). Rows with no company (unattributable denials) are never listed."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import AuditLog
from app.repositories.pagination import Page, paginate


@dataclass(frozen=True, slots=True)
class AuditLogFilters:
    action: str | None = None
    actor_user_id: UUID | None = None
    entity_type: str | None = None
    entity_id: UUID | None = None
    created_from: datetime | None = None  # inclusive
    created_before: datetime | None = None  # exclusive


class AuditLogRepository:
    """Append-only: the runtime role cannot UPDATE/DELETE audit rows, so there are no such methods."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, entry: AuditLog) -> AuditLog:
        self.db.add(entry)
        return entry

    def search(
        self, company_id: UUID, *, filters: AuditLogFilters, page: int, page_size: int
    ) -> Page[AuditLog]:
        """Newest first by `seq` (unique, so pages are stable)."""
        statement = select(AuditLog).where(AuditLog.company_id == company_id)
        if filters.action is not None:
            statement = statement.where(AuditLog.action == filters.action)
        if filters.actor_user_id is not None:
            statement = statement.where(AuditLog.actor_user_id == filters.actor_user_id)
        if filters.entity_type is not None:
            statement = statement.where(AuditLog.entity_type == filters.entity_type)
        if filters.entity_id is not None:
            statement = statement.where(AuditLog.entity_id == filters.entity_id)
        if filters.created_from is not None:
            statement = statement.where(AuditLog.created_at >= filters.created_from)
        if filters.created_before is not None:
            statement = statement.where(AuditLog.created_at < filters.created_before)
        # The unfiltered count reads the whole trail, which is append-only and never pruned: serially,
        # as worker start-up costs more than parallel workers save on it (`pagination._SERIAL_PLAN`).
        return paginate(
            self.db,
            statement.order_by(AuditLog.seq.desc()),
            page=page,
            page_size=page_size,
            serial_count=True,
        )

    def fields_changed_by_people(self, company_id: UUID, action: str, entity_id: UUID) -> set[str]:
        """The `changed_fields` of every `action` row about `entity_id` that a person wrote: one with an
        actor, or one the platform owner's change left (`metadata.source = "platform"`, B11-5). Rows
        written by the CLI or the system have neither."""
        statement = select(AuditLog.meta).where(
            AuditLog.company_id == company_id,
            AuditLog.action == action,
            AuditLog.entity_id == entity_id,
            or_(AuditLog.actor_user_id.is_not(None), AuditLog.meta["source"].astext == "platform"),
        )
        return {
            name
            for meta in self.db.scalars(statement)
            for name in meta.get("changed_fields", ())
            if isinstance(name, str)
        }

    def changed_by_people(self, company_id: UUID, action: str, entity_id: UUID) -> bool:
        """Whether a person ever wrote an `action` row about `entity_id`, whatever it changed: one with an
        actor, or one the platform owner's change left (`fields_changed_by_people`). A seed gives a
        company its demo brand only while this is false (B12-15)."""
        statement = (
            select(AuditLog.id)
            .where(
                AuditLog.company_id == company_id,
                AuditLog.action == action,
                AuditLog.entity_id == entity_id,
                or_(AuditLog.actor_user_id.is_not(None), AuditLog.meta["source"].astext == "platform"),
            )
            .limit(1)
        )
        return self.db.scalar(statement) is not None

    def latest(self, company_id: UUID, *, limit: int) -> list[AuditLog]:
        statement = (
            select(AuditLog)
            .where(AuditLog.company_id == company_id)
            .order_by(AuditLog.seq.desc())
            .limit(limit)
        )
        return list(self.db.scalars(statement))
