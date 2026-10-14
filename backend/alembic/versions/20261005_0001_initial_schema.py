"""Initial schema: every table of the contract (section 4), triggers and runtime-role grants.

Revision ID: 0001
Revises:
Create Date: 2026-10-05

Hand-written and reviewed. Notable points:
* Tenant tables expose UNIQUE (company_id, id) and tenant references are composite foreign keys, so a
  row can never point at another company's row.
* Enumerations are VARCHAR + CHECK; lifecycle consistency on visits is enforced by two-way CHECKs.
* `visits_terminal_immutable` blocks any UPDATE of a CHECKED_OUT/CANCELLED visit.
* `audit_logs_immutable` blocks UPDATE/DELETE/TRUNCATE on audit_logs for every role (statement level);
  the runtime role additionally only holds SELECT/INSERT there.
* The runtime role (Config.attributes["app_role"], DB_APP_ROLE, default vms_app) gets DML on business
  tables, no TRUNCATE and no DDL; default privileges make future tables follow the same rule.
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BUSINESS_TABLES = (
    "companies",
    "departments",
    "users",
    "user_sessions",
    "password_reset_tokens",
    "visitors",
    "visits",
    "visitor_passes",
    "email_messages",
)


def _app_role() -> str:
    role = context.config.attributes.get("app_role") or "vms_app"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid application role name: {role!r}")
    return role


def _id() -> sa.Column:
    return sa.Column("id", sa.Uuid(), nullable=False)


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _updated_at() -> sa.Column:
    return sa.Column(
        "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _user_fk(column: str, table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["company_id", column],
        ["users.company_id", "users.id"],
        name=f"fk_{table}_company_id_{column}_users",
        ondelete="RESTRICT",
    )


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # ---- companies ------------------------------------------------------------------------------
    op.create_table(
        "companies",
        _id(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("slug", sa.String(80), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("email_domain", sa.String(255), nullable=True),
        sa.Column("pass_grace_before_minutes", sa.Integer(), server_default=sa.text("60"), nullable=False),
        sa.Column("pass_grace_after_minutes", sa.Integer(), server_default=sa.text("60"), nullable=False),
        sa.Column("notify_host_on_check_in", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("allow_walk_ins", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        _created_at(),
        _updated_at(),
        sa.PrimaryKeyConstraint("id", name="pk_companies"),
        sa.UniqueConstraint("slug", name="uq_companies_slug"),
        sa.CheckConstraint(
            "pass_grace_before_minutes BETWEEN 0 AND 1440", name=op.f("ck_companies_pass_grace_before_range")
        ),
        sa.CheckConstraint(
            "pass_grace_after_minutes BETWEEN 0 AND 1440", name=op.f("ck_companies_pass_grace_after_range")
        ),
        sa.CheckConstraint(
            "email_domain IS NULL OR (email_domain <> '' AND email_domain = lower(email_domain))",
            name=op.f("ck_companies_email_domain_lowercase"),
        ),
        sa.CheckConstraint("slug <> '' AND slug = lower(slug)", name=op.f("ck_companies_slug_lowercase")),
    )

    # ---- departments ----------------------------------------------------------------------------
    op.create_table(
        "departments",
        _id(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        _created_at(),
        _updated_at(),
        sa.PrimaryKeyConstraint("id", name="pk_departments"),
        sa.UniqueConstraint("company_id", "id", name="uq_departments_company_id_id"),
        sa.ForeignKeyConstraint(
            ["company_id"], ["companies.id"], name="fk_departments_company_id_companies", ondelete="RESTRICT"
        ),
        sa.CheckConstraint("btrim(name) <> ''", name=op.f("ck_departments_name_not_blank")),
    )
    op.create_index(
        "uq_departments_company_name",
        "departments",
        ["company_id", sa.literal_column("lower(name)")],
        unique=True,
    )

    # ---- users ----------------------------------------------------------------------------------
    op.create_table(
        "users",
        _id(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("full_name", sa.String(200), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("phone", sa.String(40), nullable=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("roles", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("must_change_password", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("password_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        _updated_at(),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("company_id", "id", name="uq_users_company_id_id"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.ForeignKeyConstraint(
            ["company_id"], ["companies.id"], name="fk_users_company_id_companies", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["company_id", "department_id"],
            ["departments.company_id", "departments.id"],
            name="fk_users_company_id_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint("email <> '' AND email = lower(email)", name=op.f("ck_users_email_lowercase")),
        sa.CheckConstraint(
            "cardinality(roles) > 0 AND roles <@ "
            "ARRAY['SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST', 'MANAGEMENT']::text[]",
            name=op.f("ck_users_roles_valid"),
        ),
        sa.CheckConstraint("btrim(full_name) <> ''", name=op.f("ck_users_full_name_not_blank")),
    )

    # ---- user_sessions --------------------------------------------------------------------------
    op.create_table(
        "user_sessions",
        _id(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.CHAR(64), nullable=False),
        sa.Column("csrf_token_hash", sa.CHAR(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ip_address", postgresql.INET(), nullable=True),
        sa.Column("user_agent", sa.String(400), nullable=True),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_user_sessions"),
        sa.UniqueConstraint("token_hash", name="uq_user_sessions_token_hash"),
        sa.ForeignKeyConstraint(
            ["company_id", "user_id"],
            ["users.company_id", "users.id"],
            name="fk_user_sessions_company_id_user_id_users",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])

    # ---- password_reset_tokens ------------------------------------------------------------------
    op.create_table(
        "password_reset_tokens",
        _id(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.CHAR(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_ip", postgresql.INET(), nullable=True),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_password_reset_tokens"),
        sa.UniqueConstraint("token_hash", name="uq_password_reset_tokens_token_hash"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_password_reset_tokens_user_id_users", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"])

    # ---- visitors -------------------------------------------------------------------------------
    op.create_table(
        "visitors",
        _id(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("full_name", sa.String(200), nullable=False),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("phone", sa.String(40), nullable=True),
        sa.Column("phone_digits", sa.String(40), nullable=True),
        sa.Column("company_name", sa.String(200), nullable=True),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=True),
        _created_at(),
        _updated_at(),
        sa.PrimaryKeyConstraint("id", name="pk_visitors"),
        sa.UniqueConstraint("company_id", "id", name="uq_visitors_company_id_id"),
        sa.UniqueConstraint("company_id", "email", name="uq_visitors_company_id_email"),
        sa.ForeignKeyConstraint(
            ["company_id"], ["companies.id"], name="fk_visitors_company_id_companies", ondelete="RESTRICT"
        ),
        _user_fk("created_by_id", "visitors"),
        sa.CheckConstraint(
            "email IS NULL OR (email <> '' AND email = lower(email))",
            name=op.f("ck_visitors_email_lowercase"),
        ),
        sa.CheckConstraint(
            "phone_digits IS NULL OR phone_digits ~ '^[0-9]+$'", name=op.f("ck_visitors_phone_digits_only")
        ),
        sa.CheckConstraint("btrim(full_name) <> ''", name=op.f("ck_visitors_full_name_not_blank")),
    )
    op.create_index(
        "ix_visitors_search_text_trgm",
        "visitors",
        ["search_text"],
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_visitors_phone_digits_trgm",
        "visitors",
        ["phone_digits"],
        postgresql_using="gin",
        postgresql_ops={"phone_digits": "gin_trgm_ops"},
    )
    op.create_index("ix_visitors_company_id_created_at_id", "visitors", ["company_id", "created_at", "id"])

    # ---- visits ---------------------------------------------------------------------------------
    op.create_table(
        "visits",
        _id(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("visitor_id", sa.Uuid(), nullable=False),
        sa.Column("host_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("purpose", sa.String(500), nullable=False),
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scheduled_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), server_default=sa.text("'SCHEDULED'"), nullable=False),
        sa.Column("invitation_requested", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("visitor_name", sa.String(200), nullable=False),
        sa.Column("visitor_company_name", sa.String(200), nullable=True),
        sa.Column("host_name", sa.String(200), nullable=False),
        sa.Column("department_name", sa.String(120), nullable=True),
        sa.Column("is_walk_in", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("walk_in_reason", sa.String(300), nullable=True),
        sa.Column("check_in_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_in_by_id", sa.Uuid(), nullable=True),
        sa.Column("check_in_method", sa.String(16), nullable=True),
        sa.Column("check_in_note", sa.String(300), nullable=True),
        sa.Column("check_out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_out_by_id", sa.Uuid(), nullable=True),
        sa.Column("check_out_method", sa.String(16), nullable=True),
        sa.Column("check_out_note", sa.String(300), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by_id", sa.Uuid(), nullable=True),
        sa.Column("cancellation_reason", sa.String(300), nullable=True),
        sa.Column("no_show_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        _updated_at(),
        sa.PrimaryKeyConstraint("id", name="pk_visits"),
        sa.UniqueConstraint("company_id", "id", name="uq_visits_company_id_id"),
        sa.ForeignKeyConstraint(
            ["company_id"], ["companies.id"], name="fk_visits_company_id_companies", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["company_id", "visitor_id"],
            ["visitors.company_id", "visitors.id"],
            name="fk_visits_company_id_visitor_id_visitors",
            ondelete="RESTRICT",
        ),
        _user_fk("host_id", "visits"),
        _user_fk("created_by_id", "visits"),
        _user_fk("checked_in_by_id", "visits"),
        _user_fk("checked_out_by_id", "visits"),
        _user_fk("cancelled_by_id", "visits"),
        sa.ForeignKeyConstraint(
            ["company_id", "department_id"],
            ["departments.company_id", "departments.id"],
            name="fk_visits_company_id_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "status IN ('SCHEDULED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW')",
            name=op.f("ck_visits_status_valid"),
        ),
        sa.CheckConstraint(
            "check_in_method IS NULL OR check_in_method IN ('QR', 'MANUAL', 'OVERRIDE', 'WALK_IN')",
            name=op.f("ck_visits_check_in_method_valid"),
        ),
        sa.CheckConstraint(
            "check_out_method IS NULL OR check_out_method IN ('QR', 'MANUAL', 'CORRECTED', 'BULK')",
            name=op.f("ck_visits_check_out_method_valid"),
        ),
        sa.CheckConstraint("scheduled_end > scheduled_start", name=op.f("ck_visits_schedule_order")),
        sa.CheckConstraint(
            "window_start <= scheduled_start AND window_end >= scheduled_end",
            name=op.f("ck_visits_window_covers_schedule"),
        ),
        sa.CheckConstraint(
            "(status IN ('CHECKED_IN', 'CHECKED_OUT')) = (check_in_at IS NOT NULL)",
            name=op.f("ck_visits_check_in_status"),
        ),
        sa.CheckConstraint(
            "(check_in_at IS NULL) = (checked_in_by_id IS NULL)", name=op.f("ck_visits_check_in_by")
        ),
        sa.CheckConstraint(
            "(check_in_at IS NULL) = (check_in_method IS NULL)", name=op.f("ck_visits_check_in_method_set")
        ),
        sa.CheckConstraint(
            "(status = 'CHECKED_OUT') = (check_out_at IS NOT NULL)", name=op.f("ck_visits_check_out_status")
        ),
        sa.CheckConstraint(
            "(check_out_at IS NULL) = (checked_out_by_id IS NULL)", name=op.f("ck_visits_check_out_by")
        ),
        sa.CheckConstraint(
            "(check_out_at IS NULL) = (check_out_method IS NULL)", name=op.f("ck_visits_check_out_method_set")
        ),
        sa.CheckConstraint("check_out_at >= check_in_at", name=op.f("ck_visits_check_out_after_check_in")),
        sa.CheckConstraint(
            "(status = 'CANCELLED') = (cancelled_at IS NOT NULL)", name=op.f("ck_visits_cancelled_status")
        ),
        sa.CheckConstraint(
            "cancelled_at IS NOT NULL OR (cancelled_by_id IS NULL AND cancellation_reason IS NULL)",
            name=op.f("ck_visits_cancel_fields"),
        ),
        sa.CheckConstraint(
            "status <> 'NO_SHOW' OR no_show_at IS NOT NULL", name=op.f("ck_visits_no_show_at_set")
        ),
        sa.CheckConstraint(
            "is_walk_in = (check_in_method IS NOT DISTINCT FROM 'WALK_IN')",
            name=op.f("ck_visits_walk_in_method"),
        ),
        sa.CheckConstraint(
            "(walk_in_reason IS NOT NULL) = is_walk_in", name=op.f("ck_visits_walk_in_reason")
        ),
        sa.CheckConstraint(
            "check_in_method IS DISTINCT FROM 'OVERRIDE' OR check_in_note IS NOT NULL",
            name=op.f("ck_visits_override_note"),
        ),
        sa.CheckConstraint(
            "check_out_method IS NULL OR check_out_method NOT IN ('CORRECTED', 'BULK') "
            "OR check_out_note IS NOT NULL",
            name=op.f("ck_visits_check_out_note"),
        ),
        sa.CheckConstraint("btrim(purpose) <> ''", name=op.f("ck_visits_purpose_not_blank")),
    )
    op.create_index(
        "uq_visits_visitor_inside",
        "visits",
        ["company_id", "visitor_id"],
        unique=True,
        postgresql_where=sa.text("status = 'CHECKED_IN'"),
    )
    op.create_index(
        "ix_visits_company_id_scheduled_start_id", "visits", ["company_id", "scheduled_start", "id"]
    )
    op.create_index("ix_visits_company_id_status", "visits", ["company_id", "status"])
    op.create_index(
        "ix_visits_company_id_window_end_scheduled",
        "visits",
        ["company_id", "window_end"],
        postgresql_where=sa.text("status = 'SCHEDULED'"),
    )
    op.create_index("ix_visits_company_id_check_in_at", "visits", ["company_id", "check_in_at"])
    op.create_index("ix_visits_host_id_scheduled_start", "visits", ["host_id", "scheduled_start"])
    op.create_index("ix_visits_created_by_id_scheduled_start", "visits", ["created_by_id", "scheduled_start"])
    op.create_index(
        "ix_visits_visitor_id_scheduled_start_id",
        "visits",
        ["visitor_id", sa.literal_column("scheduled_start DESC"), "id"],
    )

    # ---- visitor_passes -------------------------------------------------------------------------
    op.create_table(
        "visitor_passes",
        _id(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("visit_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.CHAR(64), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoke_reason", sa.String(32), nullable=True),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_visitor_passes"),
        sa.UniqueConstraint("token_hash", name="uq_visitor_passes_token_hash"),
        sa.ForeignKeyConstraint(
            ["company_id", "visit_id"],
            ["visits.company_id", "visits.id"],
            name="fk_visitor_passes_company_id_visit_id_visits",
            ondelete="RESTRICT",
        ),
        _user_fk("created_by_id", "visitor_passes"),
        sa.CheckConstraint(
            "revoke_reason IS NULL OR revoke_reason IN "
            "('ROTATED', 'VISIT_CANCELLED', 'VISIT_COMPLETED', 'VISITOR_EMAIL_CHANGED')",
            name=op.f("ck_visitor_passes_revoke_reason_valid"),
        ),
        sa.CheckConstraint(
            "(revoked_at IS NULL) = (revoke_reason IS NULL)",
            name=op.f("ck_visitor_passes_revocation_consistent"),
        ),
    )
    op.create_index(
        "uq_passes_active_visit",
        "visitor_passes",
        ["visit_id"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    # ---- email_messages -------------------------------------------------------------------------
    op.create_table(
        "email_messages",
        _id(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("visit_id", sa.Uuid(), nullable=True),
        sa.Column("recipient_user_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("to_email", sa.String(320), nullable=False),
        sa.Column("subject", sa.String(300), nullable=False),
        sa.Column("status", sa.String(16), server_default=sa.text("'PENDING'"), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("provider_message_id", sa.String(255), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        _updated_at(),
        sa.PrimaryKeyConstraint("id", name="pk_email_messages"),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name="fk_email_messages_company_id_companies",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["company_id", "visit_id"],
            ["visits.company_id", "visits.id"],
            name="fk_email_messages_company_id_visit_id_visits",
            ondelete="RESTRICT",
        ),
        _user_fk("recipient_user_id", "email_messages"),
        sa.CheckConstraint(
            "kind IN ('VISITOR_INVITATION', 'VISIT_RESCHEDULED', 'VISIT_CANCELLED', 'HOST_ARRIVAL', "
            "'PASSWORD_RESET')",
            name=op.f("ck_email_messages_kind_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('PENDING', 'SENT', 'FAILED')", name=op.f("ck_email_messages_status_valid")
        ),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_email_messages_attempts_non_negative")),
        sa.CheckConstraint(
            "(status = 'SENT') = (sent_at IS NOT NULL)", name=op.f("ck_email_messages_sent_at_set")
        ),
    )
    op.create_index("ix_email_messages_visit_id_created_at", "email_messages", ["visit_id", "created_at"])
    op.create_index("ix_email_messages_status", "email_messages", ["status"])

    # ---- audit_logs -----------------------------------------------------------------------------
    op.create_table(
        "audit_logs",
        _id(),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("actor_user_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(32), nullable=True),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("ip_address", postgresql.INET(), nullable=True),
        sa.Column("user_agent", sa.String(400), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_audit_logs"),
        sa.UniqueConstraint("seq", name="uq_audit_logs_seq"),
    )
    op.create_index(
        "ix_audit_logs_company_id_seq", "audit_logs", ["company_id", sa.literal_column("seq DESC")]
    )
    op.create_index("ix_audit_logs_entity_type_entity_id", "audit_logs", ["entity_type", "entity_id"])
    op.create_index("ix_audit_logs_actor_user_id", "audit_logs", ["actor_user_id"])
    op.create_index(
        "ix_audit_logs_company_id_action_seq",
        "audit_logs",
        ["company_id", "action", sa.literal_column("seq DESC")],
    )

    # ---- triggers -------------------------------------------------------------------------------
    op.execute(
        """
        CREATE FUNCTION visits_terminal_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'visit % is % and can no longer be modified', OLD.id, OLD.status
                USING HINT = 'Checked-out and cancelled visits are immutable.';
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER visits_terminal_immutable
        BEFORE UPDATE ON visits
        FOR EACH ROW
        WHEN (OLD.status IN ('CHECKED_OUT', 'CANCELLED'))
        EXECUTE FUNCTION visits_terminal_immutable()
        """
    )
    op.execute(
        """
        CREATE FUNCTION audit_logs_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_logs_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
        FOR EACH STATEMENT
        EXECUTE FUNCTION audit_logs_immutable()
        """
    )

    # ---- runtime role privileges ----------------------------------------------------------------
    role = _app_role()
    op.execute(f"GRANT USAGE ON SCHEMA public TO {role}")
    tables = ", ".join(BUSINESS_TABLES)
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {tables} TO {role}")
    op.execute(f"GRANT SELECT, INSERT ON TABLE audit_logs TO {role}")
    op.execute(f"GRANT USAGE ON SEQUENCE audit_logs_seq_seq TO {role}")
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {role}"
    )
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {role}")


def downgrade() -> None:
    role = _app_role()
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM {role}"
    )
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM {role}")
    # USAGE on the schema is left in place: the schema predates this revision and provisioning
    # (scripts/db.ps1) grants it independently.

    op.execute("DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs")
    op.execute("DROP FUNCTION IF EXISTS audit_logs_immutable()")
    op.execute("DROP TRIGGER IF EXISTS visits_terminal_immutable ON visits")
    op.execute("DROP FUNCTION IF EXISTS visits_terminal_immutable()")

    for table in (
        "audit_logs",
        "email_messages",
        "visitor_passes",
        "visits",
        "visitors",
        "password_reset_tokens",
        "user_sessions",
        "users",
        "departments",
        "companies",
    ):
        op.drop_table(table)  # drops the table's indexes and constraints with it

    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
