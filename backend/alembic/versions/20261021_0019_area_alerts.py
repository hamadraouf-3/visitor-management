"""Allowed areas and area alerts: the zones' access level, the departments' floor, each visit's allowed
areas, the tracking alerts and the companies' alert settings.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-21

Phase 16 (docs/decisions/phase-16-backend.md, docs/visitor-journey-design.md §9). The tracking provider is
still `disabled` in production; these tables let a company say where each visitor may be and keep the
alerts that the journey's own confirmed location raises once a provider is connected. Nothing here
stores an image, a crop, an embedding or a template.

* `zones.access` varchar(10) NOT NULL DEFAULT 'STANDARD', CHECK `ck_zones_access_valid` (COMMON,
  STANDARD, RESTRICTED; B16-1): every existing zone is STANDARD.
* `departments.floor_id` uuid NULL, composite foreign key `fk_departments_floor` (company_id, floor_id)
  → floors (B16-3): the default allowed floor of a new visit of the department.
* `company_tracking_settings`: `area_alerts_enabled` and `alert_notify_host` boolean NOT NULL DEFAULT true,
  `alert_emails` varchar(320)[] NOT NULL DEFAULT '{}' with CHECK `ck_company_tracking_settings_alert_emails_count`
  (at most 5; B16-13). A company without a settings row keeps the defaults.
* `email_messages.kind` gains TRACKING_ALERT (`ck_email_messages_kind_valid`; not editable, so the CHECK
  of `email_template_overrides.kind` does not change, B16-14).
* `visit_access_areas`: a visit's allowed floors and extra zones, one row each, exactly one of
  `floor_id` / `zone_id`; an area taken away keeps its row with `removed_at` (the runtime role cannot
  delete, B16-2); a live area of a visit is unique (partial unique indexes).
* `tracking_alerts`: at most one OPEN or ACKNOWLEDGED alert per visit (`uq_tracking_alerts_active_visit`,
  B16-6); its visit is its association's (composite key, ON DELETE CASCADE so that the association's
  retention also removes it, B16-17); its first and latest location as resolved then.

Every reference within a company is a composite foreign key over `(company_id, …)` (B15-3).

Additive only: the previous release's code (revision 0018's) runs unchanged on this schema. The new
columns have defaults (a constant default rewrites no table) or are nullable, the changed CHECK of
`email_messages` only admits one more value, and the old code never reads the new tables. Its
`prune-journeys` still works once alerts exist: deleting an association deletes its alerts
(ON DELETE CASCADE). `lock_timeout` is 5 s for the upgrade (B14-23): an upgrade that cannot get a lock
fails, leaving nothing behind (one transaction), and is run again. The CHECKs and the foreign key added to
existing tables are added NOT VALID and then validated, as in revisions 0016 and 0017.

Privileges: the runtime role gets SELECT, INSERT and UPDATE on the two new tables from the schema's
default privileges (revisions 0001 and 0006) and already holds them on the changed tables; it never
deletes (`cli prune-journeys` deletes alerts as the schema owner, B16-17).

Downgrade drops the new tables and columns and restores the CHECK of `email_messages`. After locking the
tables it reads (SEC-39) it refuses while any of them holds what somebody entered or the application
recorded: an alert, an allowed area, a zone that is not STANDARD, a department with a floor, alert
settings other than the defaults, or an alert e-mail in the e-mail log. Restore a backup taken before the
upgrade instead.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The longest the upgrade waits for a table's lock (B14-23).
LOCK_TIMEOUT = "5s"
MESSAGE_KINDS_BEFORE = (
    "VISITOR_INVITATION",
    "VISIT_RESCHEDULED",
    "VISIT_CANCELLED",
    "HOST_ARRIVAL",
    "PASSWORD_RESET",
    "PASSWORD_CHANGED",
    "PLATFORM_ACTION_NOTICE",
    "HOST_VISIT_SCHEDULED",
    "HOST_VISIT_RESCHEDULED",
    "HOST_VISIT_CANCELLED",
    "VISITOR_CALENDAR",
)
ALERT_KIND = "TRACKING_ALERT"
NEW_TABLES = ("visit_access_areas", "tracking_alerts")
CHANGED_TABLES = ("zones", "departments", "company_tracking_settings", "email_messages")
ACTIVE_ALERT = "status IN ('OPEN', 'ACKNOWLEDGED')"
LIVE_AREA = "removed_at IS NULL"


def _timestamp(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def _company_id(table: str) -> tuple[sa.Column, sa.ForeignKeyConstraint]:
    return (
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f(f"fk_{table}_company_id_companies"),
            ondelete="RESTRICT",
        ),
    )


def _same_company(
    columns: list[str], target: str, target_columns: list[str], name: str, *, ondelete: str = "RESTRICT"
) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        columns, [f"{target}.{column}" for column in target_columns], name=op.f(name), ondelete=ondelete
    )


def _check(table: str, name: str, condition: str) -> sa.CheckConstraint:
    return sa.CheckConstraint(condition, name=op.f(f"ck_{table}_{name}"))


def _add_check_not_valid(table: str, name: str, condition: str) -> None:
    """The CHECK `name` added without reading the table, then validated (B14-23)."""
    op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID")
    op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")


def _kinds(kinds: Sequence[str]) -> str:
    return "kind IN (" + ", ".join(f"'{kind}'" for kind in kinds) + ")"


def upgrade() -> None:
    # B14-23: no lock waited for longer than this; the session's own value again after the upgrade.
    op.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")

    # ---- the zones' access level, the departments' floor (B16-1, B16-3) ---------------------------
    op.add_column(
        "zones", sa.Column("access", sa.String(10), server_default=sa.text("'STANDARD'"), nullable=False)
    )
    _add_check_not_valid(
        "zones", op.f("ck_zones_access_valid"), "access IN ('COMMON', 'STANDARD', 'RESTRICTED')"
    )
    op.add_column("departments", sa.Column("floor_id", sa.Uuid(), nullable=True))
    op.execute(
        "ALTER TABLE departments ADD CONSTRAINT fk_departments_floor FOREIGN KEY (company_id, floor_id) "
        "REFERENCES floors (company_id, id) ON DELETE RESTRICT NOT VALID"
    )
    op.execute("ALTER TABLE departments VALIDATE CONSTRAINT fk_departments_floor")

    # ---- the companies' alert settings (B16-13) -------------------------------------------------------
    settings = "company_tracking_settings"
    op.add_column(
        settings,
        sa.Column("area_alerts_enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.add_column(
        settings,
        sa.Column("alert_notify_host", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.add_column(
        settings,
        sa.Column(
            "alert_emails",
            postgresql.ARRAY(sa.String(320)),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
    )
    _add_check_not_valid(
        settings, op.f(f"ck_{settings}_alert_emails_count"), "cardinality(alert_emails) <= 5"
    )

    # ---- the alert e-mail (B16-14) ------------------------------------------------------------------
    messages_check = op.f("ck_email_messages_kind_valid")
    op.drop_constraint(messages_check, "email_messages", type_="check")
    _add_check_not_valid("email_messages", messages_check, _kinds((*MESSAGE_KINDS_BEFORE, ALERT_KIND)))

    # ---- a visit's allowed areas (B16-2) -------------------------------------------------------------
    areas = "visit_access_areas"
    op.create_table(
        areas,
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id(areas),
        sa.Column("visit_id", sa.Uuid(), nullable=False),
        sa.Column("floor_id", sa.Uuid(), nullable=True),
        sa.Column("zone_id", sa.Uuid(), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        _timestamp("created_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_visit_access_areas")),
        _same_company(
            ["company_id", "visit_id"], "visits", ["company_id", "id"], "fk_visit_access_areas_visit"
        ),
        _same_company(
            ["company_id", "floor_id"], "floors", ["company_id", "id"], "fk_visit_access_areas_floor"
        ),
        _same_company(["company_id", "zone_id"], "zones", ["company_id", "id"], "fk_visit_access_areas_zone"),
        _check(areas, "one_area", "(floor_id IS NULL) <> (zone_id IS NULL)"),
        _check(areas, "removed_after_added", "removed_at IS NULL OR removed_at >= created_at"),
    )
    op.create_index(
        "uq_visit_access_areas_live_floor",
        areas,
        ["visit_id", "floor_id"],
        unique=True,
        postgresql_where=sa.text(LIVE_AREA),
    )
    op.create_index(
        "uq_visit_access_areas_live_zone",
        areas,
        ["visit_id", "zone_id"],
        unique=True,
        postgresql_where=sa.text(LIVE_AREA),
    )
    op.create_index(
        "ix_visit_access_areas_live_visit",
        areas,
        ["company_id", "visit_id"],
        postgresql_where=sa.text(LIVE_AREA),
    )

    # ---- the tracking alerts (B16-5 … B16-12) ------------------------------------------------------------
    alerts = "tracking_alerts"
    op.create_table(
        alerts,
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id(alerts),
        sa.Column("visit_id", sa.Uuid(), nullable=False),
        sa.Column("association_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("status", sa.String(12), server_default=sa.text("'OPEN'"), nullable=False),
        sa.Column("simulated", sa.Boolean(), nullable=False),
        sa.Column("first_building_id", sa.Uuid(), nullable=False),
        sa.Column("first_floor_id", sa.Uuid(), nullable=False),
        sa.Column("first_zone_id", sa.Uuid(), nullable=False),
        sa.Column("last_building_id", sa.Uuid(), nullable=False),
        sa.Column("last_floor_id", sa.Uuid(), nullable=False),
        sa.Column("last_zone_id", sa.Uuid(), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observations", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged_by_id", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_id", sa.Uuid(), nullable=True),
        sa.Column("resolution", sa.String(16), nullable=True),
        sa.Column("note", sa.String(300), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tracking_alerts")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_tracking_alerts_company_id_id")),
        _same_company(
            ["company_id", "association_id", "visit_id"],
            "tracking_associations",
            ["company_id", "id", "visit_id"],
            "fk_tracking_alerts_association",
            ondelete="CASCADE",
        ),
        _same_company(
            ["company_id", "first_building_id", "first_floor_id"],
            "floors",
            ["company_id", "building_id", "id"],
            "fk_tracking_alerts_first_floor",
        ),
        _same_company(
            ["company_id", "first_floor_id", "first_zone_id"],
            "zones",
            ["company_id", "floor_id", "id"],
            "fk_tracking_alerts_first_zone",
        ),
        _same_company(
            ["company_id", "last_building_id", "last_floor_id"],
            "floors",
            ["company_id", "building_id", "id"],
            "fk_tracking_alerts_last_floor",
        ),
        _same_company(
            ["company_id", "last_floor_id", "last_zone_id"],
            "zones",
            ["company_id", "floor_id", "id"],
            "fk_tracking_alerts_last_zone",
        ),
        _same_company(
            ["company_id", "acknowledged_by_id"],
            "users",
            ["company_id", "id"],
            "fk_tracking_alerts_acknowledger",
        ),
        _same_company(
            ["company_id", "resolved_by_id"], "users", ["company_id", "id"], "fk_tracking_alerts_resolver"
        ),
        _check(alerts, "type_valid", "type IN ('UNAUTHORIZED_AREA', 'RESTRICTED_AREA')"),
        _check(alerts, "status_valid", "status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')"),
        _check(
            alerts,
            "resolution_valid",
            "resolution IS NULL OR resolution IN ('RETURNED', 'AREAS_CHANGED', 'CHECKED_OUT', 'MANUAL')",
        ),
        _check(alerts, "resolved_status", "(status = 'RESOLVED') = (resolved_at IS NOT NULL)"),
        _check(alerts, "resolution_set", "(resolved_at IS NULL) = (resolution IS NULL)"),
        _check(alerts, "resolver_when_resolved", "resolved_at IS NOT NULL OR resolved_by_id IS NULL"),
        _check(alerts, "acknowledged_set", "status <> 'ACKNOWLEDGED' OR acknowledged_at IS NOT NULL"),
        _check(alerts, "open_unacknowledged", "status <> 'OPEN' OR acknowledged_at IS NULL"),
        _check(
            alerts,
            "acknowledger_when_acknowledged",
            "acknowledged_at IS NOT NULL OR acknowledged_by_id IS NULL",
        ),
        _check(alerts, "observations_positive", "observations >= 1"),
        _check(alerts, "seen_after_opened", "last_seen_at >= opened_at"),
        _check(alerts, "note_not_blank", "note IS NULL OR btrim(note) <> ''"),
    )
    op.create_index(
        "uq_tracking_alerts_active_visit",
        alerts,
        ["visit_id"],
        unique=True,
        postgresql_where=sa.text(ACTIVE_ALERT),
    )
    op.create_index("ix_tracking_alerts_company_status", alerts, ["company_id", "status"])
    op.create_index("ix_tracking_alerts_company_opened", alerts, ["company_id", "opened_at"])
    op.create_index("ix_tracking_alerts_visit", alerts, ["company_id", "visit_id", "opened_at"])
    op.create_index("ix_tracking_alerts_association", alerts, ["association_id"])
    op.create_index("ix_tracking_alerts_company_updated", alerts, ["company_id", "updated_at"])
    op.execute("SET LOCAL lock_timeout TO DEFAULT")


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a row being written is invisible to the counts and would be lost.
    op.execute(f"LOCK TABLE {', '.join((*NEW_TABLES, *CHANGED_TABLES))} IN ACCESS EXCLUSIVE MODE")
    held = {
        "tracking_alerts": "SELECT count(*) FROM tracking_alerts",
        "visit_access_areas": "SELECT count(*) FROM visit_access_areas",
        "zones not STANDARD": "SELECT count(*) FROM zones WHERE access <> 'STANDARD'",
        "departments with a floor": "SELECT count(*) FROM departments WHERE floor_id IS NOT NULL",
        "alert settings": (
            "SELECT count(*) FROM company_tracking_settings "
            "WHERE NOT area_alerts_enabled OR NOT alert_notify_host OR cardinality(alert_emails) > 0"
        ),
        "alert e-mails": f"SELECT count(*) FROM email_messages WHERE kind = '{ALERT_KIND}'",
    }
    counts = {name: connection.execute(sa.text(query)).scalar_one() for name, query in held.items()}
    present = {name: count for name, count in counts.items() if count}
    if present:
        raise RuntimeError(
            "revision 0019 cannot be downgraded: the allowed areas and area alerts hold data that would be "
            "lost (" + ", ".join(f"{name}: {count}" for name, count in present.items()) + "). Restore a "
            "backup taken before the upgrade instead."
        )
    for table in reversed(NEW_TABLES):
        op.drop_table(table)
    messages_check = op.f("ck_email_messages_kind_valid")
    op.drop_constraint(messages_check, "email_messages", type_="check")
    op.create_check_constraint(messages_check, "email_messages", _kinds(MESSAGE_KINDS_BEFORE))
    settings = "company_tracking_settings"
    op.drop_constraint(op.f(f"ck_{settings}_alert_emails_count"), settings, type_="check")
    for column in ("alert_emails", "alert_notify_host", "area_alerts_enabled"):
        op.drop_column(settings, column)
    op.drop_constraint("fk_departments_floor", "departments", type_="foreignkey")
    op.drop_column("departments", "floor_id")
    op.drop_constraint(op.f("ck_zones_access_valid"), "zones", type_="check")
    op.drop_column("zones", "access")
