import uuid
from datetime import datetime
from ipaddress import IPv4Address, IPv6Address

from sqlalchemy import (
    CHAR,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, INET
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.company import Company
from app.models.department import Department
from app.models.enums import Language, Role, sql_in_list
from app.security.device_trust import new_device_trust_epoch

ROLES_SQL_ARRAY = f"ARRAY[{sql_in_list(Role)}]::text[]"


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        ForeignKeyConstraint(
            ["company_id", "department_id"],
            ["departments.company_id", "departments.id"],
            ondelete="RESTRICT",
        ),
        CheckConstraint("email <> '' AND email = lower(email)", name="email_lowercase"),
        CheckConstraint(f"cardinality(roles) > 0 AND roles <@ {ROLES_SQL_ARRAY}", name="roles_valid"),
        CheckConstraint("btrim(full_name) <> ''", name="full_name_not_blank"),
        CheckConstraint(
            f"preferred_language IS NULL OR preferred_language IN ({sql_in_list(Language)})",
            name="preferred_language_valid",
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Globally unique (D-03); duplicates map to 409 USER_EMAIL_UNAVAILABLE.
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    phone: Mapped[str | None] = mapped_column(String(40))
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    roles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    department_id: Mapped[uuid.UUID | None] = mapped_column()
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    password_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The user's own choice of interface and e-mail language (PATCH /auth/preferences); NULL follows the
    # company's `default_language` (B10-1).
    preferred_language: Mapped[str | None] = mapped_column(String(2))
    # Device cookies (SEC-01) trust a browser only while their entry carries this value (SEC-30): a new
    # random value on every password change and reset and on deactivation ends the trust of every browser
    # that signed in before. Rows inserted without it (raw SQL) get 0, a value like any other.
    device_trust_epoch: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=new_device_trust_epoch, server_default=text("0")
    )

    company: Mapped[Company] = relationship(lazy="joined", viewonly=True)
    department: Mapped[Department | None] = relationship(
        foreign_keys=[company_id, department_id], lazy="joined", viewonly=True
    )

    @property
    def role_set(self) -> frozenset[Role]:
        return frozenset(Role(role) for role in self.roles)


class UserSession(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    __tablename__ = "user_sessions"
    __table_args__ = (
        ForeignKeyConstraint(["company_id", "user_id"], ["users.company_id", "users.id"], ondelete="CASCADE"),
        Index("ix_user_sessions_user_id", "user_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    company_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    csrf_token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)  # absolute
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[IPv4Address | IPv6Address | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(400))


class PasswordResetToken(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A token ends at most one way: consumed (`used_at`) or invalidated (`invalidated_at`), both
    terminal. `expires_at` is only the natural end of its lifetime."""

    __tablename__ = "password_reset_tokens"
    __table_args__ = (
        Index("ix_password_reset_tokens_user_id", "user_id"),
        CheckConstraint("used_at IS NULL OR invalidated_at IS NULL", name="single_outcome"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    requested_ip: Mapped[IPv4Address | IPv6Address | None] = mapped_column(INET)
