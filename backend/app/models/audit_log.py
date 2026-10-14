import uuid
from ipaddress import IPv4Address, IPv6Address
from typing import Any

from sqlalchemy import BigInteger, Identity, Index, String, Uuid, text
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, UUIDPrimaryKeyMixin


class AuditLog(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """Append-only audit trail.

    The database blocks UPDATE/DELETE/TRUNCATE with a statement trigger and the runtime role only has
    SELECT/INSERT. There are intentionally no foreign keys: an audit write must never fail because of
    the state of the rows it describes (e.g. a denied request whose own work was rolled back).
    """

    __tablename__ = "audit_logs"

    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False, unique=True)
    company_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)  # NULL only when unattributable
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # "metadata" is reserved on declarative classes, hence the attribute name.
    meta: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    ip_address: Mapped[IPv4Address | IPv6Address | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(400))
    request_id: Mapped[str | None] = mapped_column(String(64))


Index("ix_audit_logs_company_id_seq", AuditLog.company_id, AuditLog.seq.desc())
Index("ix_audit_logs_entity_type_entity_id", AuditLog.entity_type, AuditLog.entity_id)
Index("ix_audit_logs_actor_user_id", AuditLog.actor_user_id)
Index("ix_audit_logs_company_id_action_seq", AuditLog.company_id, AuditLog.action, AuditLog.seq.desc())
# GET /audit-logs date filters (revision 0010): the count and the page read only the range.
Index("ix_audit_logs_company_id_created_at", AuditLog.company_id, AuditLog.created_at)
