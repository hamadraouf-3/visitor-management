"""The Visitor Journey's provider-neutral boundary: the location registry, tracking associations, journey
events, provider keys, the companies' tracking settings and the provider's health.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-20

Phase 15 (docs/decisions/phase-15-backend.md, docs/visitor-journey-design.md). The tracking provider is
off by default everywhere (`TRACKING_PROVIDER=disabled`); these tables let a company prepare its
buildings, floors, zones and cameras, and hold what a provider reports once one is connected. Nothing
here stores an image, a crop, an embedding or a template.

* `buildings`, `floors` (unique `level` per building), `zones`, `tracking_cameras` (the provider's camera
  ID unique per company; a camera always has a zone; no credential, URL or address).
* `tracking_associations`: a visit's random reference for the provider (`trk_` + 32 base32 characters)
  and its lifecycle (PENDING, ACTIVE, ENDED with a reason); at most one PENDING or ACTIVE per visit
  (`uq_tracking_associations_open_visit`).
* `visitor_journey_events`: append-only (the runtime role's UPDATE is revoked, and the trigger
  `visitor_journey_events_immutable` refuses every UPDATE, also the schema owner's); the building, floor
  and zone resolved at ingest; unique per company, provider and provider event ID.
* `tracking_keys`: SHA-256 digests of the provider's keys; at most two unrevoked per company
  (`uq_tracking_keys_live_slot`).
* `company_tracking_settings` (B15-2: a side table, so `companies` is not altered), `tracking_health`,
  `tracking_health_counts` (a 24-slot hourly ring per company and reason, reused in place).

Every reference within a company is a composite foreign key over `(company_id, …)` (B15-3).

Additive only: no existing table, column or constraint changes, so the previous release (revision 0017's
code) keeps working on this schema; it never reads the new tables. Creating a foreign key takes a SHARE
ROW EXCLUSIVE lock on the table it references (`companies`, `users`, `visits`), which waits for the
writes in flight and holds new ones until this transaction commits: `lock_timeout` is 5 s for the
upgrade, as in revisions 0016 and 0017 (B14-23), so an upgrade that cannot get a lock fails, leaving
nothing behind, and is run again. The new tables are empty, so their constraints need no NOT VALID /
VALIDATE step.

Privileges: the runtime role gets SELECT, INSERT and UPDATE on the new tables from the schema's default
privileges (revisions 0001 and 0006), then loses UPDATE on `visitor_journey_events`. It never deletes:
`cli prune-journeys` deletes as the schema owner (B15-21).

Downgrade drops the new tables and the trigger function. After locking them (SEC-39) it refuses while any
of them holds what an operator entered or a provider reported (a location, a camera, an association, an
event, a key, or a company's tracking settings other than the defaults): that would be lost. Restore a
backup taken before the upgrade instead. Health rows are derived and are dropped.
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The longest the upgrade waits for a table's lock (B14-23).
LOCK_TIMEOUT = "5s"
VISIBLE_ASCII = "^[!-~]+$"
PROVIDER_NAME = "^[a-z][a-z0-9_]{0,31}$"
OPEN = "status IN ('PENDING', 'ACTIVE')"
NEW_TABLES = (
    "buildings",
    "floors",
    "zones",
    "tracking_cameras",
    "tracking_associations",
    "visitor_journey_events",
    "tracking_keys",
    "company_tracking_settings",
    "tracking_health",
    "tracking_health_counts",
)
# What the downgrade would lose: rows somebody entered or a provider reported.
GUARDED_TABLES = (
    "buildings",
    "floors",
    "zones",
    "tracking_cameras",
    "tracking_associations",
    "visitor_journey_events",
    "tracking_keys",
)


def _app_role() -> str:
    role = context.config.attributes.get("app_role") or "vms_app"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid application role name: {role!r}")
    return role


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
    columns: list[str], target: str, target_columns: list[str], name: str
) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        columns, [f"{target}.{column}" for column in target_columns], name=op.f(name), ondelete="RESTRICT"
    )


def _check(table: str, name: str, condition: str) -> sa.CheckConstraint:
    return sa.CheckConstraint(condition, name=op.f(f"ck_{table}_{name}"))


def _names(table: str) -> list[sa.SchemaItem]:
    return [
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("name_ar", sa.String(120), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        _check(table, "name_not_blank", "btrim(name) <> ''"),
        _check(table, "name_ar_not_blank", "name_ar IS NULL OR btrim(name_ar) <> ''"),
    ]


def upgrade() -> None:
    # B14-23: no lock waited for longer than this; the session's own value again after the upgrade.
    op.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")

    # ---- the location registry ------------------------------------------------------------------
    op.create_table(
        "buildings",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id("buildings"),
        *_names("buildings"),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_buildings")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_buildings_company_id_id")),
    )
    op.create_index(
        "uq_buildings_company_name", "buildings", ["company_id", sa.text("lower(name)")], unique=True
    )
    op.create_table(
        "floors",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id("floors"),
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        *_names("floors"),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_floors")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_floors_company_id_id")),
        sa.UniqueConstraint(
            "company_id", "building_id", "id", name=op.f("uq_floors_company_id_building_id_id")
        ),
        sa.UniqueConstraint("building_id", "level", name=op.f("uq_floors_building_id_level")),
        _same_company(["company_id", "building_id"], "buildings", ["company_id", "id"], "fk_floors_building"),
        _check("floors", "level_range", "level BETWEEN -20 AND 200"),
    )
    op.create_table(
        "zones",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id("zones"),
        sa.Column("floor_id", sa.Uuid(), nullable=False),
        *_names("zones"),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_zones")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_zones_company_id_id")),
        sa.UniqueConstraint("company_id", "floor_id", "id", name=op.f("uq_zones_company_id_floor_id_id")),
        _same_company(["company_id", "floor_id"], "floors", ["company_id", "id"], "fk_zones_floor"),
    )
    op.create_index("uq_zones_floor_name", "zones", ["floor_id", sa.text("lower(name)")], unique=True)
    op.create_table(
        "tracking_cameras",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id("tracking_cameras"),
        sa.Column("provider_camera_id", sa.String(128), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("zone_id", sa.Uuid(), nullable=False),
        sa.Column("is_enrollment_point", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tracking_cameras")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_tracking_cameras_company_id_id")),
        sa.UniqueConstraint(
            "company_id", "provider_camera_id", name=op.f("uq_tracking_cameras_company_id_provider_camera_id")
        ),
        _same_company(["company_id", "zone_id"], "zones", ["company_id", "id"], "fk_tracking_cameras_zone"),
        _check(
            "tracking_cameras", "provider_camera_id_visible_ascii", f"provider_camera_id ~ '{VISIBLE_ASCII}'"
        ),
        _check("tracking_cameras", "name_not_blank", "btrim(name) <> ''"),
    )

    # ---- associations and their events -------------------------------------------------------------
    associations = "tracking_associations"
    op.create_table(
        associations,
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id(associations),
        sa.Column("visit_id", sa.Uuid(), nullable=False),
        sa.Column("ref", sa.String(36), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("enrollment_camera_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(8), server_default=sa.text("'PENDING'"), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_reason", sa.String(24), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tracking_associations")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_tracking_associations_company_id_id")),
        sa.UniqueConstraint(
            "company_id", "id", "visit_id", name=op.f("uq_tracking_associations_company_id_id_visit_id")
        ),
        sa.UniqueConstraint("ref", name=op.f("uq_tracking_associations_ref")),
        _same_company(
            ["company_id", "visit_id"], "visits", ["company_id", "id"], "fk_tracking_associations_visit"
        ),
        _same_company(
            ["company_id", "enrollment_camera_id"],
            "tracking_cameras",
            ["company_id", "id"],
            "fk_tracking_associations_camera",
        ),
        _same_company(
            ["company_id", "created_by_id"], "users", ["company_id", "id"], "fk_tracking_associations_user"
        ),
        _check(associations, "ref_format", "ref ~ '^trk_[a-z2-7]{32}$'"),
        _check(associations, "provider_name", f"provider ~ '{PROVIDER_NAME}'"),
        _check(associations, "status_valid", "status IN ('PENDING', 'ACTIVE', 'ENDED')"),
        _check(
            associations,
            "ended_reason_valid",
            "ended_reason IS NULL OR ended_reason IN "
            "('CHECKED_OUT', 'REVOKED', 'EXPIRED', 'ENROLLMENT_FAILED', 'VISIT_CANCELLED')",
        ),
        _check(associations, "ended_status", "(status = 'ENDED') = (ended_at IS NOT NULL)"),
        _check(associations, "ended_reason_set", "(ended_at IS NULL) = (ended_reason IS NULL)"),
        _check(associations, "active_activated", "status <> 'ACTIVE' OR activated_at IS NOT NULL"),
        _check(associations, "pending_not_activated", "status <> 'PENDING' OR activated_at IS NULL"),
        _check(associations, "activated_after_created", "activated_at IS NULL OR activated_at >= created_at"),
        _check(associations, "ended_after_created", "ended_at IS NULL OR ended_at >= created_at"),
        _check(associations, "expires_after_created", "expires_at > created_at"),
    )
    op.create_index(
        "uq_tracking_associations_open_visit",
        associations,
        ["visit_id"],
        unique=True,
        postgresql_where=sa.text(OPEN),
    )
    op.create_index(
        "ix_tracking_associations_open_company",
        associations,
        ["company_id", "expires_at"],
        postgresql_where=sa.text(OPEN),
    )
    op.create_index(
        "ix_tracking_associations_visit_created", associations, ["company_id", "visit_id", "created_at"]
    )
    op.create_index(
        "ix_tracking_associations_ended",
        associations,
        ["company_id", "ended_at"],
        postgresql_where=sa.text("status = 'ENDED'"),
    )

    events = "visitor_journey_events"
    op.create_table(
        events,
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id(events),
        sa.Column("visit_id", sa.Uuid(), nullable=False),
        sa.Column("association_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("provider_event_id", sa.String(128), nullable=False),
        sa.Column("type", sa.String(8), nullable=False),
        sa.Column("camera_id", sa.Uuid(), nullable=True),
        sa.Column("building_id", sa.Uuid(), nullable=True),
        sa.Column("floor_id", sa.Uuid(), nullable=True),
        sa.Column("zone_id", sa.Uuid(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("match", sa.String(12), nullable=True),
        sa.Column("confidence", sa.Double(), nullable=True),
        sa.Column("model_version", sa.String(64), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_visitor_journey_events")),
        sa.UniqueConstraint(
            "company_id", "provider", "provider_event_id", name=op.f("uq_journey_events_provider_event")
        ),
        _same_company(
            ["company_id", "association_id", "visit_id"],
            associations,
            ["company_id", "id", "visit_id"],
            "fk_journey_events_association",
        ),
        _same_company(
            ["company_id", "camera_id"], "tracking_cameras", ["company_id", "id"], "fk_journey_events_camera"
        ),
        _same_company(
            ["company_id", "building_id", "floor_id"],
            "floors",
            ["company_id", "building_id", "id"],
            "fk_journey_events_floor",
        ),
        _same_company(
            ["company_id", "floor_id", "zone_id"],
            "zones",
            ["company_id", "floor_id", "id"],
            "fk_journey_events_zone",
        ),
        _check(events, "type_valid", "type IN ('ENROLLED', 'OBSERVED', 'LOST')"),
        _check(events, "match_valid", "match IS NULL OR match IN ('CONFIRMED', 'UNCERTAIN')"),
        _check(events, "match_of_observation", "(type = 'OBSERVED') = (match IS NOT NULL)"),
        _check(events, "camera_of_sighting", "type = 'LOST' OR camera_id IS NOT NULL"),
        _check(
            events,
            "location_complete",
            "(camera_id IS NULL) = (zone_id IS NULL) AND (zone_id IS NULL) = (floor_id IS NULL) "
            "AND (floor_id IS NULL) = (building_id IS NULL)",
        ),
        _check(events, "confidence_range", "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)"),
        _check(events, "provider_event_id_visible", f"provider_event_id ~ '{VISIBLE_ASCII}'"),
        _check(events, "provider_name", f"provider ~ '{PROVIDER_NAME}'"),
    )
    op.create_index("ix_journey_events_visit_observed", events, ["company_id", "visit_id", "observed_at"])
    op.create_index("ix_journey_events_camera_observed", events, ["company_id", "camera_id", "observed_at"])
    op.create_index("ix_journey_events_company_observed", events, ["company_id", "observed_at"])
    # Append-only (B15-9): history is never rewritten, by the runtime role or anyone else. The schema
    # owner still deletes what retention prunes (`cli prune-journeys`).
    op.execute(
        """
        CREATE FUNCTION visitor_journey_events_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'visitor_journey_events is append-only: % is not allowed', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER visitor_journey_events_immutable
        BEFORE UPDATE ON visitor_journey_events
        FOR EACH STATEMENT
        EXECUTE FUNCTION visitor_journey_events_immutable()
        """
    )
    op.execute(f"REVOKE UPDATE ON TABLE visitor_journey_events FROM {_app_role()}")

    # ---- the provider's keys ------------------------------------------------------------------------
    op.create_table(
        "tracking_keys",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_company_id("tracking_keys"),
        sa.Column("label", sa.String(100), nullable=False),
        sa.Column("prefix", sa.String(8), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("slot", sa.SmallInteger(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by_id", sa.Uuid(), nullable=True),
        _timestamp("created_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tracking_keys")),
        sa.UniqueConstraint("company_id", "id", name=op.f("uq_tracking_keys_company_id_id")),
        sa.UniqueConstraint("key_hash", name=op.f("uq_tracking_keys_key_hash")),
        _same_company(
            ["company_id", "created_by_id"], "users", ["company_id", "id"], "fk_tracking_keys_creator"
        ),
        _same_company(
            ["company_id", "revoked_by_id"], "users", ["company_id", "id"], "fk_tracking_keys_revoker"
        ),
        _check("tracking_keys", "key_hash_sha256", "key_hash ~ '^[0-9a-f]{64}$'"),
        _check("tracking_keys", "prefix_format", "prefix ~ '^vtk_[A-Za-z0-9_-]{4}$'"),
        _check("tracking_keys", "slot_valid", "slot IN (1, 2)"),
        _check("tracking_keys", "revoked_by_when_revoked", "revoked_at IS NOT NULL OR revoked_by_id IS NULL"),
        _check("tracking_keys", "label_not_blank", "btrim(label) <> ''"),
    )
    op.create_index(
        "uq_tracking_keys_live_slot",
        "tracking_keys",
        ["company_id", "slot"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    # ---- settings and health ------------------------------------------------------------------------
    settings = "company_tracking_settings"
    op.create_table(
        settings,
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("allowed", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("min_confidence", sa.Double(), nullable=True),
        sa.Column("stale_after_minutes", sa.Integer(), server_default=sa.text("15"), nullable=False),
        sa.Column("retention_days", sa.Integer(), server_default=sa.text("30"), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("company_id", name=op.f("pk_company_tracking_settings")),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f(f"fk_{settings}_company_id_companies"),
            ondelete="RESTRICT",
        ),
        _check(settings, "enabled_only_when_allowed", "allowed OR NOT enabled"),
        _check(
            settings,
            "min_confidence_range",
            "min_confidence IS NULL OR (min_confidence >= 0 AND min_confidence <= 1)",
        ),
        _check(settings, "stale_after_minutes_range", "stale_after_minutes BETWEEN 1 AND 240"),
        _check(settings, "retention_days_range", "retention_days BETWEEN 1 AND 90"),
    )
    op.create_table(
        "tracking_health",
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("last_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_accepted_event_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("company_id", name=op.f("pk_tracking_health")),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f("fk_tracking_health_company_id_companies"),
            ondelete="RESTRICT",
        ),
    )
    counts = "tracking_health_counts"
    op.create_table(
        counts,
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("slot", sa.SmallInteger(), nullable=False),
        sa.Column("hour_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("company_id", "reason", "slot", name=op.f("pk_tracking_health_counts")),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f(f"fk_{counts}_company_id_companies"),
            ondelete="RESTRICT",
        ),
        _check(counts, "slot_range", "slot BETWEEN 0 AND 23"),
        _check(counts, "count_positive", "count >= 1"),
        _check(counts, "reason_format", "reason ~ '^[A-Z][A-Z_]{0,31}$'"),
    )
    op.execute("SET LOCAL lock_timeout TO DEFAULT")


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): a row being written is invisible to the counts and would be lost.
    op.execute(f"LOCK TABLE {', '.join(NEW_TABLES)} IN ACCESS EXCLUSIVE MODE")
    held = {
        table: connection.execute(sa.text(f"SELECT count(*) FROM {table}")).scalar_one()
        for table in GUARDED_TABLES
    }
    held["company_tracking_settings"] = connection.execute(
        sa.text(
            "SELECT count(*) FROM company_tracking_settings WHERE allowed OR enabled OR min_confidence IS NOT NULL "
            "OR stale_after_minutes <> 15 OR retention_days <> 30"
        )
    ).scalar_one()
    present = {table: count for table, count in held.items() if count}
    if present:
        raise RuntimeError(
            "revision 0018 cannot be downgraded: the Visitor Journey's tables hold data that would be lost ("
            + ", ".join(f"{table}: {count}" for table, count in present.items())
            + "). Restore a backup taken before the upgrade instead."
        )
    for table in reversed(NEW_TABLES):
        op.drop_table(table)
    op.execute("DROP FUNCTION IF EXISTS visitor_journey_events_immutable()")
