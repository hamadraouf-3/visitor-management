"""A company's brand images (revision 0015, B12-1): what describes them, and the bytes where they are
served or sent.

Every read of a company's own data is scoped by `company_id`. The two lookups by slug are the public
ones (the sign-in page and the visitor's pass page know only the slug): they answer for **active**
companies alone, in one statement, so an unknown slug and a deactivated company are the same "nothing"
(B12-9). One read spans companies, and returns their IDs only: `companies_with_logo`, for the e-mails'
drawing ahead (B13-7).

The image bytes are selected only by `image` and `public_image`; every other read is of the columns that
describe an image (`BrandImageInfo`).
"""

from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import BrandAssetKind, Company, CompanyBrandAsset
from app.repositories.ids import any_of

_UNIQUE = "uq_company_brand_assets_company_id_kind"
_DESCRIPTION = (
    CompanyBrandAsset.kind,
    CompanyBrandAsset.version,
    CompanyBrandAsset.sha256,
    CompanyBrandAsset.byte_size,
    CompanyBrandAsset.width,
    CompanyBrandAsset.height,
)


@dataclass(frozen=True, slots=True)
class BrandImageInfo:
    """A stored image without its bytes."""

    kind: BrandAssetKind
    version: str  # of this upload: part of the image's public address
    sha256: str  # of the stored bytes
    byte_size: int
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class BrandImage:
    """A stored image: the PNG as `app.core.png.sanitize_png` wrote it."""

    info: BrandImageInfo
    content: bytes


type BrandImages = dict[BrandAssetKind, BrandImageInfo]


def _info(row: Sequence[Any]) -> BrandImageInfo:
    """`_DESCRIPTION` of one row."""
    kind, version, sha256, byte_size, width, height = row[:6]
    return BrandImageInfo(BrandAssetKind(kind), version, sha256, byte_size, width, height)


def _image(row: Sequence[Any] | None) -> BrandImage | None:
    """`_DESCRIPTION` and the content of one row."""
    return None if row is None else BrandImage(_info(row), bytes(row[6]))


class CompanyBrandRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def images(self, company_id: UUID) -> BrandImages:
        """The company's images, by kind (a removed image is none)."""
        return self.images_of([company_id]).get(company_id, {})

    def images_of(self, company_ids: Collection[UUID]) -> dict[UUID, BrandImages]:
        """`images` of several companies in one query (the platform owner's list of companies)."""
        if not company_ids:
            return {}
        statement = select(CompanyBrandAsset.company_id, *_DESCRIPTION).where(
            any_of(CompanyBrandAsset.company_id, company_ids), CompanyBrandAsset.content.is_not(None)
        )
        found: dict[UUID, BrandImages] = {}
        for company_id, *description in self.db.execute(statement):
            info = _info(description)
            found.setdefault(company_id, {})[info.kind] = info
        return found

    def companies_with_logo(self) -> list[UUID]:
        """The active companies that have a logo for light surfaces: those whose e-mails carry one, which
        the e-mails draw ahead (`app.email.logos.LogoWarmUp`, B13-7). Every company's: this is the
        process's own preparation, and it reads no image."""
        statement = (
            select(CompanyBrandAsset.company_id)
            .join(Company, Company.id == CompanyBrandAsset.company_id)
            .where(
                Company.is_active.is_(True),
                CompanyBrandAsset.kind == BrandAssetKind.LOGO.value,
                CompanyBrandAsset.content.is_not(None),
            )
            .order_by(CompanyBrandAsset.company_id)
        )
        return list(self.db.scalars(statement))

    def image(self, company_id: UUID, kind: BrandAssetKind) -> BrandImage | None:
        """One image with its bytes (the logo an e-mail carries)."""
        statement = select(*_DESCRIPTION, CompanyBrandAsset.content).where(
            CompanyBrandAsset.company_id == company_id,
            CompanyBrandAsset.kind == kind.value,
            CompanyBrandAsset.content.is_not(None),
        )
        return _image(self.db.execute(statement).one_or_none())

    def put(
        self,
        company_id: UUID,
        kind: BrandAssetKind,
        *,
        content: bytes,
        width: int,
        height: int,
        sha256: str,
        version: str,
        now: datetime,
    ) -> None:
        """Store (or replace) one image: one row per (company, kind), inserted the first time and updated
        afterwards (the runtime role cannot delete)."""
        values = {
            "content": content,
            "byte_size": len(content),
            "width": width,
            "height": height,
            "sha256": sha256,
            "version": version,
            "updated_at": now,
        }
        statement = insert(CompanyBrandAsset).values(
            company_id=company_id, kind=kind.value, created_at=now, **values
        )
        self.db.execute(statement.on_conflict_do_update(constraint=_UNIQUE, set_=values))

    def clear(self, company_id: UUID, kind: BrandAssetKind, *, now: datetime) -> None:
        """Remove one image: its row stays, empty (see `put`)."""
        statement = (
            update(CompanyBrandAsset)
            .where(CompanyBrandAsset.company_id == company_id, CompanyBrandAsset.kind == kind.value)
            .values(
                content=None,
                byte_size=None,
                width=None,
                height=None,
                sha256=None,
                version=None,
                updated_at=now,
            )
        )
        self.db.execute(statement)

    # ---- public: by slug, active companies only ---------------------------------------------------

    def active_company(self, slug: str) -> Company | None:
        """The active company with exactly this slug. A deactivated company is not found, like a slug
        nobody has."""
        statement = select(Company).where(Company.slug == slug, Company.is_active.is_(True))
        return self.db.scalars(statement).one_or_none()

    def public_image(self, slug: str, kind: BrandAssetKind) -> BrandImage | None:
        """One image of the active company with this slug, with its bytes; None for an unknown slug, a
        deactivated company and a company without that image alike."""
        statement = (
            select(*_DESCRIPTION, CompanyBrandAsset.content)
            .join(Company, Company.id == CompanyBrandAsset.company_id)
            .where(
                Company.slug == slug,
                Company.is_active.is_(True),
                CompanyBrandAsset.kind == kind.value,
                CompanyBrandAsset.content.is_not(None),
            )
        )
        return _image(self.db.execute(statement).one_or_none())
