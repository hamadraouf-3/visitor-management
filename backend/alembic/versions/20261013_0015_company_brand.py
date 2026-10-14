"""A company's own identity: its colour, its logo and its icon.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-13

Phase 12 (docs/decisions/phase-12-backend.md, B12-1): every company shows its own logo and colour to its
staff and visitors, set by the platform owner.

* `companies.brand_color` varchar(7) NULL: the company's colour as `#rrggbb` in lower case (CHECK
  `ck_companies_brand_color_hex`: exactly that, so the value can go into a style sheet or an e-mail as it
  is). NULL: the product's own palette. The shades people see are derived from it by the application.
* `company_brand_assets`: one row per (company, kind) that ever had an image, `kind` being `logo` (light
  surfaces), `logo_dark` (dark surfaces) or `icon` (square). `content` is the PNG as the application
  re-serialised it, with its `byte_size`, `width`, `height`, `sha256` and `version` (a random value per
  upload, part of the image's public address). A removed image is a row whose `content` and description
  are NULL together (CHECK `content_described`): the runtime role cannot delete (revision 0006). The
  CHECKs repeat the application's limits: a PNG signature, at most 512 KiB, logos 32-1200 by 32-600
  pixels, the icon square and 192-512 pixels.

Privileges: the runtime role gets SELECT, INSERT and UPDATE on the new table, as on every other table
(the schema's default privileges of revisions 0001 and 0006 give exactly that; it is also granted here
by name, so the table is usable whichever role ran the earlier revisions). No DELETE, as everywhere. The
new column of `companies` is covered by that table's privileges. Adding a nullable column rewrites no
table.

Downgrade drops the table and the column. It refuses, after locking both tables (SEC-39), while a
company has a colour or an image: both would be lost, and nothing the next upgrade does brings them back.
Remove them first (the platform owner's page, or the statements the refusal names), or restore a backup
taken before the upgrade.
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS = ("logo", "logo_dark", "icon")
MAX_BYTES = 512 * 1024
DESCRIBED = ("byte_size", "width", "height", "sha256", "version")


def _app_role() -> str:
    role = context.config.attributes.get("app_role") or "vms_app"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid application role name: {role!r}")
    return role


def upgrade() -> None:
    op.add_column("companies", sa.Column("brand_color", sa.String(7), nullable=True))
    op.create_check_constraint(
        op.f("ck_companies_brand_color_hex"),
        "companies",
        "brand_color IS NULL OR brand_color ~ '^#[0-9a-f]{6}$'",
    )
    op.create_table(
        "company_brand_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=True),
        sa.Column("byte_size", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("sha256", sa.CHAR(64), nullable=True),
        sa.Column("version", sa.CHAR(16), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "kind IN (" + ", ".join(f"'{kind}'" for kind in KINDS) + ")",
            name=op.f("ck_company_brand_assets_kind_valid"),
        ),
        sa.CheckConstraint(
            "num_nulls(content, " + ", ".join(DESCRIBED) + f") IN (0, {len(DESCRIBED) + 1})",
            name=op.f("ck_company_brand_assets_content_described"),
        ),
        sa.CheckConstraint(
            f"content IS NULL OR (byte_size = octet_length(content) AND byte_size <= {MAX_BYTES} "
            r"AND substring(content from 1 for 8) = '\x89504e470d0a1a0a'::bytea)",
            name=op.f("ck_company_brand_assets_content_png"),
        ),
        sa.CheckConstraint(
            "width IS NULL OR CASE WHEN kind = 'icon' "
            "THEN width = height AND width BETWEEN 192 AND 512 "
            "ELSE width BETWEEN 32 AND 1200 AND height BETWEEN 32 AND 600 END",
            name=op.f("ck_company_brand_assets_dimensions_valid"),
        ),
        sa.CheckConstraint(
            "sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'", name=op.f("ck_company_brand_assets_sha256_hex")
        ),
        sa.CheckConstraint(
            "version IS NULL OR version ~ '^[0-9a-f]{16}$'",
            name=op.f("ck_company_brand_assets_version_hex"),
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f("fk_company_brand_assets_company_id_companies"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_company_brand_assets")),
        sa.UniqueConstraint("company_id", "kind", name=op.f("uq_company_brand_assets_company_id_kind")),
    )
    # What the default privileges give every new table; by name as well (see the module).
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON TABLE company_brand_assets TO {_app_role()}")


def downgrade() -> None:
    connection = op.get_bind()
    # Locked before counting (SEC-39): an upload or a colour still being saved is invisible to the
    # counts, and the drop would wait for it and then lose it.
    op.execute("LOCK TABLE companies, company_brand_assets IN ACCESS EXCLUSIVE MODE")
    colours = connection.execute(
        sa.text("SELECT count(*) FROM companies WHERE brand_color IS NOT NULL")
    ).scalar_one()
    images = connection.execute(
        sa.text("SELECT count(*) FROM company_brand_assets WHERE content IS NOT NULL")
    ).scalar_one()
    if colours or images:
        raise RuntimeError(
            "revision 0015 cannot be downgraded: "
            f"{colours} company colour(s) and {images} company logo or icon image(s) would be lost. Remove "
            "them first (UPDATE companies SET brand_color = NULL; UPDATE company_brand_assets SET content = "
            "NULL, byte_size = NULL, width = NULL, height = NULL, sha256 = NULL, version = NULL), or restore "
            "a backup taken before the upgrade."
        )
    op.drop_table("company_brand_assets")
    op.drop_constraint(op.f("ck_companies_brand_color_hex"), "companies", type_="check")
    op.drop_column("companies", "brand_color")
