"""The platform owner and the companies' own e-mail texts.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-12

Phase 11 (docs/decisions/phase-11-backend.md):

* B11-1: `platform_admins` and `platform_sessions`: the platform owner, a principal above every company,
  with its own credentials and server-side sessions. It is not a tenant user: `users.company_id` stays
  NOT NULL and the composite tenant keys are unchanged.
* B11-4: `platform_audit_logs`: the platform's own append-only trail, guarded exactly like `audit_logs`
  (revisions 0001 and 0008): a statement trigger refuses UPDATE, DELETE and TRUNCATE for every role, the
  runtime role may SELECT and INSERT every column but the identity `seq`, and holds nothing on its
  sequence.
* B11-10: `companies.is_active` (default true) and `companies.deactivated_at`, which change together
  (CHECK): a deactivated company's users cannot sign in and its passes are refused.
* B11-20: `email_template_overrides`: a company's own text for one field of one e-mail kind in one
  language; `text` NULL means the product's text (the runtime role cannot delete, revision 0006).

Privileges: the schema's default privileges (revisions 0001 and 0006) give the runtime role SELECT, INSERT
and UPDATE on the new tables and SELECT and USAGE on the new sequence. `platform_audit_logs` is narrowed
here to SELECT and column INSERT, with nothing on its sequence, so the production privilege check
(`app.db.privileges`) accepts it as it accepts `audit_logs`. Every new table is small; nothing is
rewritten (adding a column with a constant default does not rewrite `companies`).

Downgrade drops all of it. It refuses while that would lose data or widen access, after locking the
tables (SEC-39): a deactivated company (it would be active again), a company's own e-mail text, or any
platform account or platform audit row (the trail is append-only; a backup taken before the upgrade is
the way back).
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Every platform_audit_logs column but the identity `seq` (the runtime role's INSERT, as for audit_logs).
PLATFORM_AUDIT_INSERT_COLUMNS = (
    "id",
    "actor_platform_admin_id",
    "company_id",
    "action",
    "entity_type",
    "entity_id",
    "metadata",
    "ip_address",
    "user_agent",
    "request_id",
    "created_at",
)
EDITABLE_KINDS = ("VISITOR_INVITATION", "VISIT_RESCHEDULED", "VISIT_CANCELLED", "HOST_ARRIVAL")
TEMPLATE_FIELDS = ("subject", "heading", "greeting", "intro", "button", "closing", "footer_note")
TEMPLATE_TEXT_MAX_LENGTH = 2000


def _app_role() -> str:
    role = context.config.attributes.get("app_role") or "vms_app"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid application role name: {role!r}")
    return role


def _in(values: Sequence[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _updated_at() -> sa.Column:
    return sa.Column(
        "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    # ---- companies: activity (B11-10) -----------------------------------------------------------
    op.add_column(
        "companies", sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False)
    )
    op.add_column("companies", sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_companies_active_matches_deactivated_at"),
        "companies",
        "is_active = (deactivated_at IS NULL)",
    )

    # ---- the platform owner (B11-1) -------------------------------------------------------------
    op.create_table(
        "platform_admins",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("full_name", sa.String(200), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("must_change_password", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("password_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("preferred_language", sa.String(2), nullable=True),
        sa.Column("device_trust_epoch", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint(
            "email <> '' AND email = lower(email)", name=op.f("ck_platform_admins_email_lowercase")
        ),
        sa.CheckConstraint("btrim(full_name) <> ''", name=op.f("ck_platform_admins_full_name_not_blank")),
        sa.CheckConstraint(
            "preferred_language IS NULL OR preferred_language IN ('ar', 'en')",
            name=op.f("ck_platform_admins_preferred_language_valid"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_platform_admins")),
        sa.UniqueConstraint("email", name=op.f("uq_platform_admins_email")),
    )
    op.create_table(
        "platform_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("platform_admin_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.CHAR(64), nullable=False),
        sa.Column("csrf_token_hash", sa.CHAR(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ip_address", postgresql.INET(), nullable=True),
        sa.Column("user_agent", sa.String(400), nullable=True),
        _created_at(),
        sa.ForeignKeyConstraint(
            ["platform_admin_id"],
            ["platform_admins.id"],
            name=op.f("fk_platform_sessions_platform_admin_id_platform_admins"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_platform_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_platform_sessions_token_hash")),
    )
    op.create_index("ix_platform_sessions_platform_admin_id", "platform_sessions", ["platform_admin_id"])

    # ---- the platform's audit trail (B11-4) -----------------------------------------------------
    op.create_table(
        "platform_audit_logs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("actor_platform_admin_id", sa.Uuid(), nullable=True),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(32), nullable=True),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("ip_address", postgresql.INET(), nullable=True),
        sa.Column("user_agent", sa.String(400), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_platform_audit_logs")),
        sa.UniqueConstraint("seq", name=op.f("uq_platform_audit_logs_seq")),
    )
    op.create_index(
        "ix_platform_audit_logs_company_id_seq",
        "platform_audit_logs",
        ["company_id", sa.literal_column("seq DESC")],
    )
    op.create_index(
        "ix_platform_audit_logs_actor_platform_admin_id", "platform_audit_logs", ["actor_platform_admin_id"]
    )
    op.execute(
        """
        CREATE FUNCTION platform_audit_logs_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'platform_audit_logs is append-only: % is not allowed', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER platform_audit_logs_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_audit_logs
        FOR EACH STATEMENT
        EXECUTE FUNCTION platform_audit_logs_immutable()
        """
    )

    # ---- a company's own e-mail texts (B11-20) --------------------------------------------------
    op.create_table(
        "email_template_overrides",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("language", sa.String(2), nullable=False),
        sa.Column("field", sa.String(32), nullable=False),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("updated_by_id", sa.Uuid(), nullable=True),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint(
            f"kind IN ({_in(EDITABLE_KINDS)})", name=op.f("ck_email_template_overrides_kind_valid")
        ),
        sa.CheckConstraint(
            "language IN ('ar', 'en')", name=op.f("ck_email_template_overrides_language_valid")
        ),
        sa.CheckConstraint(
            f"field IN ({_in(TEMPLATE_FIELDS)})", name=op.f("ck_email_template_overrides_field_valid")
        ),
        sa.CheckConstraint(
            f"text IS NULL OR (btrim(text) <> '' AND char_length(text) <= {TEMPLATE_TEXT_MAX_LENGTH})",
            name=op.f("ck_email_template_overrides_text_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f("fk_email_template_overrides_company_id_companies"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["company_id", "updated_by_id"],
            ["users.company_id", "users.id"],
            name=op.f("fk_email_template_overrides_company_id_updated_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_template_overrides")),
        sa.UniqueConstraint(
            "company_id",
            "kind",
            "language",
            "field",
            name=op.f("uq_email_template_overrides_company_id_kind_language_field"),
        ),
    )

    # ---- runtime role privileges ----------------------------------------------------------------
    # The default privileges granted SELECT, INSERT, UPDATE on the new tables and SELECT, USAGE on the
    # identity sequence; the audit trail keeps only SELECT and INSERT without `seq` (SEC-21).
    role = _app_role()
    op.execute(f"REVOKE UPDATE, INSERT ON TABLE platform_audit_logs FROM {role}")
    op.execute(
        f"GRANT INSERT ({', '.join(PLATFORM_AUDIT_INSERT_COLUMNS)}) ON TABLE platform_audit_logs TO {role}"
    )
    op.execute(f"REVOKE ALL ON SEQUENCE platform_audit_logs_seq_seq FROM {role}")


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a write still in progress is invisible to the counts.
    op.execute(
        "LOCK TABLE companies, email_template_overrides, platform_admins, platform_audit_logs "
        "IN ACCESS EXCLUSIVE MODE"
    )
    inactive = connection.execute(sa.text("SELECT count(*) FROM companies WHERE NOT is_active")).scalar_one()
    texts = connection.execute(
        sa.text("SELECT count(*) FROM email_template_overrides WHERE text IS NOT NULL")
    ).scalar_one()
    admins = connection.execute(sa.text("SELECT count(*) FROM platform_admins")).scalar_one()
    trail = connection.execute(sa.text("SELECT count(*) FROM platform_audit_logs")).scalar_one()
    if inactive or texts or admins or trail:
        raise RuntimeError(
            "revision 0013 cannot be downgraded: "
            f"{inactive} deactivated company(ies) would become active again, {texts} company e-mail "
            f"text(s) would be lost, and {admins} platform account(s) and {trail} platform audit row(s) "
            "would be deleted. Reactivate the companies and reset their e-mail texts first, or restore a "
            "backup taken before the upgrade: the platform audit trail is append-only."
        )
    op.drop_table("email_template_overrides")
    op.execute("DROP TRIGGER IF EXISTS platform_audit_logs_immutable ON platform_audit_logs")
    op.execute("DROP FUNCTION IF EXISTS platform_audit_logs_immutable()")
    op.drop_index("ix_platform_audit_logs_actor_platform_admin_id", table_name="platform_audit_logs")
    op.drop_index("ix_platform_audit_logs_company_id_seq", table_name="platform_audit_logs")
    op.drop_table("platform_audit_logs")
    op.drop_index("ix_platform_sessions_platform_admin_id", table_name="platform_sessions")
    op.drop_table("platform_sessions")
    op.drop_table("platform_admins")
    op.drop_constraint(op.f("ck_companies_active_matches_deactivated_at"), "companies", type_="check")
    op.drop_column("companies", "deactivated_at")
    op.drop_column("companies", "is_active")
