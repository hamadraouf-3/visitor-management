"""Declarative base, constraint naming convention and common column mixins."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, MetaData, Uuid, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core import time as app_time

# Deterministic names: migrations and services refer to constraints by name (e.g. mapping
# UniqueViolation.diag.constraint_name to an API error code).
NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def _app_now() -> datetime:
    # Resolved at call time so a test clock installed later is honoured.
    return app_time.now()


class UUIDPrimaryKeyMixin:
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, sort_order=-100)


class CreatedAtMixin:
    # The server default is only a fallback for rows written outside the ORM.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_app_now, server_default=func.now(), sort_order=100
    )


class TimestampMixin(CreatedAtMixin):
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_app_now,
        onupdate=_app_now,
        server_default=func.now(),
        sort_order=101,
    )
