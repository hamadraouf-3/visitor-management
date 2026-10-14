import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import CheckInMethod, CheckOutMethod, VisitStatus, sql_in_list


def _user_fk(column: str) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(["company_id", column], ["users.company_id", "users.id"], ondelete="RESTRICT")


class Visit(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "visits"
    __table_args__ = (
        UniqueConstraint("company_id", "id"),
        ForeignKeyConstraint(
            ["company_id", "visitor_id"], ["visitors.company_id", "visitors.id"], ondelete="RESTRICT"
        ),
        _user_fk("host_id"),
        _user_fk("created_by_id"),
        _user_fk("checked_in_by_id"),
        _user_fk("checked_out_by_id"),
        _user_fk("cancelled_by_id"),
        ForeignKeyConstraint(
            ["company_id", "department_id"], ["departments.company_id", "departments.id"], ondelete="RESTRICT"
        ),
        CheckConstraint(f"status IN ({sql_in_list(VisitStatus)})", name="status_valid"),
        CheckConstraint(
            f"check_in_method IS NULL OR check_in_method IN ({sql_in_list(CheckInMethod)})",
            name="check_in_method_valid",
        ),
        CheckConstraint(
            f"check_out_method IS NULL OR check_out_method IN ({sql_in_list(CheckOutMethod)})",
            name="check_out_method_valid",
        ),
        CheckConstraint("scheduled_end > scheduled_start", name="schedule_order"),
        CheckConstraint(
            "window_start <= scheduled_start AND window_end >= scheduled_end", name="window_covers_schedule"
        ),
        # Two-way consistency between status and the lifecycle columns (contract §4).
        CheckConstraint(
            "(status IN ('CHECKED_IN', 'CHECKED_OUT')) = (check_in_at IS NOT NULL)", name="check_in_status"
        ),
        CheckConstraint("(check_in_at IS NULL) = (checked_in_by_id IS NULL)", name="check_in_by"),
        CheckConstraint("(check_in_at IS NULL) = (check_in_method IS NULL)", name="check_in_method_set"),
        CheckConstraint("(status = 'CHECKED_OUT') = (check_out_at IS NOT NULL)", name="check_out_status"),
        CheckConstraint("(check_out_at IS NULL) = (checked_out_by_id IS NULL)", name="check_out_by"),
        CheckConstraint("(check_out_at IS NULL) = (check_out_method IS NULL)", name="check_out_method_set"),
        CheckConstraint("check_out_at >= check_in_at", name="check_out_after_check_in"),
        CheckConstraint("(status = 'CANCELLED') = (cancelled_at IS NOT NULL)", name="cancelled_status"),
        CheckConstraint(
            "cancelled_at IS NOT NULL OR (cancelled_by_id IS NULL AND cancellation_reason IS NULL)",
            name="cancel_fields",
        ),
        CheckConstraint("status <> 'NO_SHOW' OR no_show_at IS NOT NULL", name="no_show_at_set"),
        CheckConstraint(
            "is_walk_in = (check_in_method IS NOT DISTINCT FROM 'WALK_IN')", name="walk_in_method"
        ),
        CheckConstraint("(walk_in_reason IS NOT NULL) = is_walk_in", name="walk_in_reason"),
        CheckConstraint(
            "check_in_method IS DISTINCT FROM 'OVERRIDE' OR check_in_note IS NOT NULL", name="override_note"
        ),
        CheckConstraint(
            "check_out_method IS NULL OR check_out_method NOT IN ('CORRECTED', 'BULK') "
            "OR check_out_note IS NOT NULL",
            name="check_out_note",
        ),
        CheckConstraint("btrim(purpose) <> ''", name="purpose_not_blank"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    visitor_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    host_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    department_id: Mapped[uuid.UUID | None] = mapped_column()
    purpose: Mapped[str] = mapped_column(String(500), nullable=False)

    scheduled_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    scheduled_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # scheduled +/- the company grace at creation/reschedule: the single source of truth for pass
    # validity and NO_SHOW.
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=VisitStatus.SCHEDULED.value, server_default=text("'SCHEDULED'")
    )
    # Whether the creator asked for an invitation e-mail (drives "needs attention" when none exists).
    invitation_requested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # False when the creator reused an existing visitor outside their read scope (matched by e-mail):
    # such a link gives its owners no access to the stored visitor, and the visitor snapshot keeps the
    # details as typed (B24-15).
    visitor_link_in_scope: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )

    # Snapshots (D-17): refreshed while SCHEDULED, frozen from check-in on.
    visitor_name: Mapped[str] = mapped_column(String(200), nullable=False)
    visitor_company_name: Mapped[str | None] = mapped_column(String(200))
    host_name: Mapped[str] = mapped_column(String(200), nullable=False)
    department_name: Mapped[str | None] = mapped_column(String(120))
    # The department's Arabic name beside `department_name`, the same kind of snapshot (revision 0012).
    department_name_ar: Mapped[str | None] = mapped_column(String(120))

    is_walk_in: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    walk_in_reason: Mapped[str | None] = mapped_column(String(300))

    check_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checked_in_by_id: Mapped[uuid.UUID | None] = mapped_column()
    check_in_method: Mapped[str | None] = mapped_column(String(16))
    check_in_note: Mapped[str | None] = mapped_column(String(300))

    check_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checked_out_by_id: Mapped[uuid.UUID | None] = mapped_column()
    check_out_method: Mapped[str | None] = mapped_column(String(16))
    check_out_note: Mapped[str | None] = mapped_column(String(300))

    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by_id: Mapped[uuid.UUID | None] = mapped_column()
    cancellation_reason: Mapped[str | None] = mapped_column(String(300))

    no_show_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


Index(
    "uq_visits_visitor_inside",
    Visit.company_id,
    Visit.visitor_id,
    unique=True,
    postgresql_where=text("status = 'CHECKED_IN'"),
)
Index("ix_visits_company_id_scheduled_start_id", Visit.company_id, Visit.scheduled_start, Visit.id)
Index("ix_visits_company_id_status", Visit.company_id, Visit.status)
Index(
    "ix_visits_company_id_window_end_scheduled",
    Visit.company_id,
    Visit.window_end,
    postgresql_where=text("status = 'SCHEDULED'"),
)
Index("ix_visits_company_id_check_in_at", Visit.company_id, Visit.check_in_at)
# Reception lists (revision 0005): today's check-outs, and the SCHEDULED visits in start order.
Index("ix_visits_company_id_check_out_at", Visit.company_id, Visit.check_out_at)
Index(
    "ix_visits_company_id_scheduled_start_id_scheduled",
    Visit.company_id,
    Visit.scheduled_start,
    Visit.id,
    postgresql_where=text("status = 'SCHEDULED'"),
)
# History search (revision 0007): `q` matches the name snapshots with ILIKE; trigram indexes let it read
# only the matching visits instead of every visit of the company.
Index(
    "ix_visits_visitor_name_trgm",
    Visit.visitor_name,
    postgresql_using="gin",
    postgresql_ops={"visitor_name": "gin_trgm_ops"},
)
Index(
    "ix_visits_visitor_company_name_trgm",
    Visit.visitor_company_name,
    postgresql_using="gin",
    postgresql_ops={"visitor_company_name": "gin_trgm_ops"},
)
Index(
    "ix_visits_host_name_trgm",
    Visit.host_name,
    postgresql_using="gin",
    postgresql_ops={"host_name": "gin_trgm_ops"},
)
Index("ix_visits_host_id_scheduled_start", Visit.host_id, Visit.scheduled_start)
Index("ix_visits_created_by_id_scheduled_start", Visit.created_by_id, Visit.scheduled_start)
Index("ix_visits_visitor_id_scheduled_start_id", Visit.visitor_id, Visit.scheduled_start.desc(), Visit.id)
