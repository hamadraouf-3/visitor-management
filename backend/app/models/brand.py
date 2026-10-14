"""A company's brand images (revision 0015, docs/decisions/phase-12-backend.md B12-1).

One row per (company, kind) that ever had an image: its logo for light surfaces, its logo for dark
surfaces, its square icon. `content` is the PNG exactly as `app.core.png.sanitize_png` wrote it, never
the bytes that were uploaded. Removing an image clears the row (the runtime role cannot delete, revision
0006): `content` and what describes it become NULL together.

`version` names one upload: a random value given when the image is stored, carried in the image's public
address (`…/brand/logo.png?v=<version>`), so a new image has a new address and an address is never served
with other bytes under a long-lived cache entry. `sha256` is the digest of `content` (the entity tag of
the public response, and what tells an upload of the same image from a change).

The CHECKs repeat the limits the service applies (contract: logos 32-1200 by 32-600 pixels, the icon
square and 192-512, at most 512 KiB), so nothing outside them can be stored whatever writes the row.
"""

import uuid

from sqlalchemy import CHAR, CheckConstraint, ForeignKey, Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import BrandAssetKind, sql_in_list

# The contract's limits (phase 12): what a brand image may be.
BRAND_ASSET_MAX_BYTES = 512 * 1024
LOGO_MIN_SIDE = 32
LOGO_MAX_WIDTH = 1200
LOGO_MAX_HEIGHT = 600
ICON_MIN_SIDE = 192
ICON_MAX_SIDE = 512
# The first eight bytes of every PNG.
_PNG_SIGNATURE = r"\x89504e470d0a1a0a"
_DESCRIBED = ("byte_size", "width", "height", "sha256", "version")


class CompanyBrandAsset(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "company_brand_assets"
    __table_args__ = (
        UniqueConstraint("company_id", "kind"),
        CheckConstraint(f"kind IN ({sql_in_list(BrandAssetKind)})", name="kind_valid"),
        # An image and what describes it are there together, or not at all (a removed image).
        CheckConstraint(
            "num_nulls(content, " + ", ".join(_DESCRIBED) + f") IN (0, {len(_DESCRIBED) + 1})",
            name="content_described",
        ),
        CheckConstraint(
            f"content IS NULL OR (byte_size = octet_length(content) AND byte_size <= {BRAND_ASSET_MAX_BYTES} "
            f"AND substring(content from 1 for 8) = '{_PNG_SIGNATURE}'::bytea)",
            name="content_png",
        ),
        CheckConstraint(
            "width IS NULL OR CASE WHEN kind = 'icon' "
            f"THEN width = height AND width BETWEEN {ICON_MIN_SIDE} AND {ICON_MAX_SIDE} "
            f"ELSE width BETWEEN {LOGO_MIN_SIDE} AND {LOGO_MAX_WIDTH} "
            f"AND height BETWEEN {LOGO_MIN_SIDE} AND {LOGO_MAX_HEIGHT} END",
            name="dimensions_valid",
        ),
        CheckConstraint("sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'", name="sha256_hex"),
        CheckConstraint("version IS NULL OR version ~ '^[0-9a-f]{16}$'", name="version_hex"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Loaded only where the image itself is served or attached to an e-mail (`deferred`): every other
    # read is of the columns that describe it.
    content: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    byte_size: Mapped[int | None] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    sha256: Mapped[str | None] = mapped_column(CHAR(64))
    version: Mapped[str | None] = mapped_column(CHAR(16))
