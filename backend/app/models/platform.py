"""The platform owner: a principal above every company (revision 0013, docs/decisions/phase-11-backend.md).

A platform administrator is not a tenant user. It has its own table, credentials, sessions and audit
trail, so `users.company_id` stays NOT NULL and every composite tenant key stays as it is (B11-1). It can
manage companies (create, rename, deactivate, add an administrator, send an administrator a reset link)
and read per-company counts, never a tenant's visitors, visits or audit rows (B11-2).
"""

import uuid
from datetime import datetime
from ipaddress import IPv4Address, IPv6Address
from typing import Any

from sqlalchemy import (
    CHAR,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import Language, sql_in_list
from app.security.device_trust import new_device_trust_epoch


class PlatformAdmin(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A platform owner account. Created only by `python -m app.cli create-platform-admin` (or the
    non-production seeds); there is no self-registration and no API that creates one."""

    __tablename__ = "platform_admins"
    __table_args__ = (
        CheckConstraint("email <> '' AND email = lower(email)", name="email_lowercase"),
        CheckConstraint("btrim(full_name) <> ''", name="full_name_not_blank"),
        CheckConstraint(
            f"preferred_language IS NULL OR preferred_language IN ({sql_in_list(Language)})",
            name="preferred_language_valid",
        ),
        # A tag exists only beside a temporary password, so it ends with the forced change (B11-35).
        CheckConstraint(
            "temporary_password_tag IS NULL OR must_change_password",
            name="temporary_password_tag_is_temporary",
        ),
    )

    # Unique among platform administrators; independent of `users.email` (another principal).
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    password_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The interface language of the platform pages (PATCH /platform/auth/preferences); NULL follows the
    # device.
    preferred_language: Mapped[str | None] = mapped_column(String(2))
    # Device cookies trust a browser while their entry carries this value (SEC-01, SEC-30), as for users.
    device_trust_epoch: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=new_device_trust_epoch, server_default=text("0")
    )
    # The tag of a temporary password that `create-platform-admin` generated (revision 0014, B11-35):
    # SHA-256 over its first characters, NULL otherwise. A sign-in whose password starts with them has a
    # failure budget of its own (`app.security.temporary_passwords`). Not a password hash: `password_hash`
    # covers the whole password, and the characters after the tagged ones carry its strength.
    temporary_password_tag: Mapped[str | None] = mapped_column(CHAR(64))


class PlatformSession(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A platform administrator's server-side session (the platform session cookie)."""

    __tablename__ = "platform_sessions"
    __table_args__ = (Index("ix_platform_sessions_platform_admin_id", "platform_admin_id"),)

    platform_admin_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("platform_admins.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    csrf_token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)  # absolute
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[IPv4Address | IPv6Address | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(400))


class PlatformAuditLog(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """The platform's own append-only audit trail (B11-4): every platform action and every platform
    sign-in, failure and denial. Like `audit_logs`: a statement trigger blocks UPDATE, DELETE and
    TRUNCATE, the runtime role may only SELECT and INSERT (not `seq`), and there are no foreign keys.
    `company_id` names the company an action was about, if any."""

    __tablename__ = "platform_audit_logs"

    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False, unique=True)
    actor_platform_admin_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    company_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    meta: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    ip_address: Mapped[IPv4Address | IPv6Address | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(400))
    request_id: Mapped[str | None] = mapped_column(String(64))


Index("ix_platform_audit_logs_company_id_seq", PlatformAuditLog.company_id, PlatformAuditLog.seq.desc())
Index("ix_platform_audit_logs_actor_platform_admin_id", PlatformAuditLog.actor_platform_admin_id)
