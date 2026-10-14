"""A company's identity: its logo, its icon and its colour (Phase 12, docs/decisions/phase-12-backend.md).

Three parts, for three kinds of caller:

* `BrandReader` builds the `CompanyBrand` every client receives (in `Me`, in the platform owner's
  company views, on the public sign-in and pass pages): the addresses of the company's images, its
  colour, the palette derived from it and a version that changes with any of them.
* `PlatformBrandService` is the only way a brand changes, and only the **platform owner** reaches it
  (B12-7): an image stored or removed, the colour set or cleared. A company's own administrators cannot:
  no tenant endpoint takes a brand field, and `PATCH /company/settings` refuses unknown fields. Each
  change is audited as COMPANY_BRAND_UPDATED in both trails (B11-5), naming what changed and never the
  bytes; within RATE_LIMIT_BRAND_CHANGES_PER_HOUR per platform account.
* `PublicBrandService` answers the pages that have no session: a company's name, language and brand, its
  images and its web app manifest, for **active** companies only and by slug alone. Unknown slugs,
  deactivated companies and missing images are one and the same 404 (B12-9). Every request counts in the
  client's budget (per address, and per IPv6 /48), whatever it asks for.

An uploaded image is never stored as it came (B12-2): `app.core.png.sanitize_png` checks it and writes
it again from the parts that draw it. Each stored image gets a random `version`, which its public address
carries, so a new image has a new address; the answer for the current version may be kept for a year,
any other for a minute.
"""

import hashlib
import json
import secrets
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote
from uuid import UUID

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.client_ip import rate_limit_prefix, rate_limit_subject
from app.core.config import Settings
from app.core.errors import (
    AppError,
    NotFound,
    PayloadTooLarge,
    RateLimited,
    ServiceBusy,
    ValidationFailed,
)
from app.core.field_errors import FieldCode, FieldProblem
from app.core.palette import ALGORITHM as PALETTE_ALGORITHM
from app.core.palette import derive_palette
from app.core.png import (
    Png,
    PngError,
    PngLimits,
    PngNotSquare,
    PngProblem,
    PngTooLarge,
    PngTooSmall,
    sanitize_png,
)
from app.core.rate_limit import LimitKey, RateLimiter, RatePolicies, limiter_key
from app.core.request_context import RequestContext
from app.core.routing import PUBLIC_PREFIX
from app.core.text import is_company_slug
from app.email.headers import cut_short
from app.email.logos import LogoWarmUp
from app.models import BrandAssetKind, Company, Language
from app.models.brand import (
    BRAND_ASSET_MAX_BYTES,
    ICON_MAX_SIDE,
    ICON_MIN_SIDE,
    LOGO_MAX_HEIGHT,
    LOGO_MAX_WIDTH,
    LOGO_MIN_SIDE,
)
from app.repositories.brand import BrandImage, BrandImageInfo, BrandImages, CompanyBrandRepository
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.schemas.brand import BrandPalette, CompanyBrand, PublicCompanyBrand
from app.security.platform_sessions import PlatformAuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import require_platform_still_authorized
from app.services.scoping import require_found

# A logo is uploaded at 8 bits a channel at most (B13-7): the web application's pipeline only ever writes
# that (a canvas), and the e-mails draw every logo in pure Python, where a 16-bit one costs almost twice
# as long. Refused on the header, before anything is inflated. A logo stored before still decodes
# (`app.email.logos.LOGO_LIMITS`).
_LOGO = PngLimits(
    min_width=LOGO_MIN_SIDE,
    max_width=LOGO_MAX_WIDTH,
    min_height=LOGO_MIN_SIDE,
    max_height=LOGO_MAX_HEIGHT,
    max_bytes=BRAND_ASSET_MAX_BYTES,
    max_bit_depth=8,
)
# What each image may be (the contract's limits; `models.brand` repeats them as CHECKs).
IMAGE_LIMITS: Mapping[BrandAssetKind, PngLimits] = {
    BrandAssetKind.LOGO: _LOGO,
    BrandAssetKind.LOGO_DARK: _LOGO,
    BrandAssetKind.ICON: PngLimits(
        min_width=ICON_MIN_SIDE,
        max_width=ICON_MAX_SIDE,
        min_height=ICON_MIN_SIDE,
        max_height=ICON_MAX_SIDE,
        max_bytes=BRAND_ASSET_MAX_BYTES,
        square=True,
    ),
}
# The field of a brand that each image is, in `CompanyBrand` and in the audit rows (`changed_fields`).
COLOR_FIELD = "color"
_INVALID_IMAGE_MESSAGES = {
    PngProblem.INTERLACED: "Upload a PNG image that is not interlaced.",
    PngProblem.ANIMATED: "Upload a PNG image that is not animated.",
    PngProblem.BIT_DEPTH: "Upload a PNG image of 8 bits per channel.",
}
INVALID_IMAGE = "Upload a valid PNG image."
NOT_SQUARE = FieldProblem(
    FieldCode.IMAGE_NOT_SQUARE, "Upload a square image: its width must equal its height."
)
MISSING_IMAGE = FieldProblem(FieldCode.REQUIRED, "Upload a PNG image.")
# The one field of an upload (the body is the file itself).
IMAGE_FIELD = "file"
# Uploads checked at a time in one API process (B12-19). A check inflates the image: for a moment it
# costs twice what the image inflates to (5.5 MiB for the largest logo, 8 bits a channel since B13-7;
# 4 MiB for the largest icon at 16; `app.core.png`), whatever the file's fate. Requests run in a pool of
# threads, so without a bound as many uploads as the pool has threads would be inflated at once. A
# check takes a few milliseconds, so nobody waits long for a slot; an upload that still has none after
# IMAGE_CHECK_WAIT_SECONDS answers 503 SERVICE_BUSY, like a sign-in that finds no slot for its password
# hash.
IMAGE_CHECK_CONCURRENCY = 2
IMAGE_CHECK_WAIT_SECONDS = 2.0
_image_checks = threading.BoundedSemaphore(IMAGE_CHECK_CONCURRENCY)

# What the installed app and the browser show before a company has a colour: the product's own teal and
# canvas (the web application's manifest).
DEFAULT_THEME_COLOR = "#188086"
DEFAULT_BACKGROUND_COLOR = "#f1f1f1"
_MANIFEST_DESCRIPTION = {
    Language.AR: "تسجيل الزوار ودعواتهم واستقبالهم",
    Language.EN: "Visitor registration, invitations and reception check-in.",
}
# The most characters of a manifest's `short_name`: what fits under an installed app's icon on a phone's
# home screen (the length browsers' own guidance gives).
SHORT_NAME_MAX_LENGTH = 12
# What a short name does not end with once it is cut between two words: a sign or a word that only joins
# what followed it ("Marks &", "Bank of", «شركة و»).
_JOINING_SIGNS = (
    " ,;:&+/|-(\N{MIDDLE DOT}\N{BULLET}\N{EN DASH}\N{EM DASH}\N{ARABIC COMMA}\N{ARABIC SEMICOLON}"
)
_JOINING_WORDS = frozenset({"and", "of", "for", "the", "at", "in", "de", "و", "في", "من", "على", "إلى"})
# How long an answer of the public image endpoint may be kept (B12-9). The current version's address
# never shows other bytes: a new upload has a new version.
CACHE_CURRENT_VERSION = "public, max-age=31536000, immutable"
CACHE_OTHER_VERSION = "public, max-age=60"
# The company's identity and manifest change in place: kept, but checked against the server every time.
CACHE_REVALIDATE = "no-cache"


def image_url(slug: str, info: BrandImageInfo) -> str:
    """The public address of a stored image: a same-origin path with the image's version, so a new
    image has a new address."""
    return f"{PUBLIC_PREFIX}/companies/{quote(slug, safe='')}/brand/{info.kind.value}.png?v={info.version}"


def brand_version(color: str | None, images: BrandImages) -> str:
    """What changes whenever an image or the colour does (or the way a palette is derived)."""
    parts = [PALETTE_ALGORITHM, color or "-"]
    parts += [f"{kind.value}={images[kind].version if kind in images else '-'}" for kind in BrandAssetKind]
    return hashlib.sha256("|".join(parts).encode("ascii")).hexdigest()[:16]


def brand_of(company: Company, images: BrandImages) -> CompanyBrand:
    def url(kind: BrandAssetKind) -> str | None:
        return image_url(company.slug, images[kind]) if kind in images else None

    color = company.brand_color
    return CompanyBrand(
        logo_url=url(BrandAssetKind.LOGO),
        logo_dark_url=url(BrandAssetKind.LOGO_DARK),
        icon_url=url(BrandAssetKind.ICON),
        color=color,
        palette=BrandPalette(**derive_palette(color).as_dict()) if color is not None else None,
        version=brand_version(color, images),
    )


def new_image_version() -> str:
    """The version of one upload: random, so that nobody can name an image's next address before the
    image exists (and fill a cache for it)."""
    return secrets.token_hex(8)


def etag_of(content: bytes) -> str:
    """A strong entity tag: the quoted SHA-256 of the answer's bytes."""
    return f'"{hashlib.sha256(content).hexdigest()}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Whether a request's `If-None-Match` names `etag` (RFC 9110 §13.1.2: a list of entity tags or `*`,
    compared weakly, so `W/"x"` matches `"x"`)."""
    if not if_none_match:
        return False
    candidates = [candidate.strip() for candidate in if_none_match.split(",")]
    if "*" in candidates:
        return True
    return etag in {candidate.removeprefix("W/") for candidate in candidates}


class BrandReader:
    """The `CompanyBrand` of companies, from their rows and what describes their images."""

    def __init__(self, db: Session) -> None:
        self.brands = CompanyBrandRepository(db)

    def of(self, company: Company) -> CompanyBrand:
        return brand_of(company, self.brands.images(company.id))

    def of_many(self, companies: Sequence[Company]) -> dict[UUID, CompanyBrand]:
        images = self.brands.images_of([company.id for company in companies])
        return {company.id: brand_of(company, images.get(company.id, {})) for company in companies}


# ---- the platform owner ------------------------------------------------------------------------------


def image_problem(error: PngError, limits: PngLimits) -> FieldProblem:
    """The field error of a refused upload."""
    if isinstance(error, PngTooSmall):
        return FieldProblem(
            FieldCode.IMAGE_TOO_SMALL,
            f"Upload an image of at least {limits.min_width} by {limits.min_height} pixels.",
            {"min_width": limits.min_width, "min_height": limits.min_height},
        )
    if isinstance(error, PngTooLarge):
        return FieldProblem(
            FieldCode.IMAGE_TOO_LARGE,
            f"Upload an image of at most {limits.max_width} by {limits.max_height} pixels.",
            {"max_width": limits.max_width, "max_height": limits.max_height},
        )
    if isinstance(error, PngNotSquare):
        return NOT_SQUARE
    return FieldProblem(FieldCode.INVALID_IMAGE, _INVALID_IMAGE_MESSAGES.get(error.problem, INVALID_IMAGE))


def _refusal(error: PngError, limits: PngLimits) -> AppError:
    """What the API answers for a refused upload: the field error of `file`, or 413 for a file above the
    byte limit (the body limit refuses that one first). It keeps nothing of `error`."""
    if error.problem is PngProblem.SIZE:
        return PayloadTooLarge()
    return ValidationFailed({IMAGE_FIELD: image_problem(error, limits)})


def checked_image(data: bytes, limits: PngLimits) -> Png:
    """`data` as the image that is stored (`sanitize_png`), within the process's bound on checks at a
    time; or the refusal the API answers (`ValidationFailed` on `file`, `PayloadTooLarge`), or
    `ServiceBusy` when no check could start in time.

    The refusal is raised after the handler of the `PngError`, not inside it. Raised inside, it would
    carry the `PngError` as its context (`raise ... from None` hides a context, it does not drop it),
    and with it the frames of the check and every local in them: the upload, its image data and, until
    `app.core.png` was changed to let go of it, the inflated image. A refusal lives until the garbage
    collector ends the reference cycles the request left behind, so every refused upload kept megabytes
    until then (B12-19). Only the answer leaves the handler."""
    if not _image_checks.acquire(timeout=IMAGE_CHECK_WAIT_SECONDS):
        raise ServiceBusy()
    try:
        return sanitize_png(data, limits)
    except PngError as error:
        refusal = _refusal(error, limits)
    finally:
        _image_checks.release()
    raise refusal


class PlatformBrandService:
    def __init__(
        self,
        db: Session,
        *,
        limiter: RateLimiter,
        policies: RatePolicies,
        logo_warm_up: LogoWarmUp | None = None,
    ) -> None:
        self.db = db
        self.limiter = limiter
        self.policies = policies
        self.companies = CompanyRepository(db)
        self.brands = CompanyBrandRepository(db)
        # Draws the e-mails' renditions of a logo once its change is committed (B13-7), so that the next
        # e-mail does not; None where e-mails draw on demand (an application built without it: tests).
        self.logo_warm_up = logo_warm_up

    def get(self, company_id: UUID) -> CompanyBrand:
        return self._view(require_found(self.companies.get(company_id)))

    def put_image(
        self,
        auth: PlatformAuthContext,
        company_id: UUID,
        kind: BrandAssetKind,
        data: bytes,
        context: RequestContext,
    ) -> CompanyBrand:
        """Store the company's `kind` image from an uploaded PNG. The same image again changes and audits
        nothing."""
        self._count_change(auth)
        require_found(self.companies.get(company_id))  # an unknown company before any work on the file
        limits = IMAGE_LIMITS[kind]
        if not data:
            raise ValidationFailed({IMAGE_FIELD: MISSING_IMAGE})
        # Checked and written again before any lock is taken: this is the request's slow part.
        image = checked_image(data, limits)
        digest = hashlib.sha256(image.data).hexdigest()
        company = self._lock(auth, company_id)
        current = self.brands.images(company.id).get(kind)
        if current is None or current.sha256 != digest:
            self.brands.put(
                company.id,
                kind,
                content=image.data,
                width=image.width,
                height=image.height,
                sha256=digest,
                version=new_image_version(),
                now=app_time.now(),
            )
            self._audit(auth, company, context, changed=kind.value)
            self.db.commit()
            self._logos_changed(company, kind)
        return self._view(company)

    def remove_image(
        self, auth: PlatformAuthContext, company_id: UUID, kind: BrandAssetKind, context: RequestContext
    ) -> CompanyBrand:
        """Remove the company's `kind` image; removing what is not there changes and audits nothing."""
        self._count_change(auth)
        company = self._lock(auth, company_id)
        if kind in self.brands.images(company.id):
            self.brands.clear(company.id, kind, now=app_time.now())
            self._audit(auth, company, context, changed=kind.value, removed=True)
            self.db.commit()
            self._logos_changed(company, kind)
        return self._view(company)

    def set_color(
        self, auth: PlatformAuthContext, company_id: UUID, color: str | None, context: RequestContext
    ) -> CompanyBrand:
        """Set the company's colour (`#rrggbb`, checked by the schema), or clear it with None."""
        self._count_change(auth)
        company = self._lock(auth, company_id)
        if company.brand_color != color:
            company.brand_color = color
            self._audit(auth, company, context, changed=COLOR_FIELD, removed=color is None)
            self.db.commit()
        return self._view(company)

    def _logos_changed(self, company: Company, kind: BrandAssetKind) -> None:
        """After a committed change of a logo: its e-mails' renditions drawn in the background."""
        if self.logo_warm_up is not None and kind is not BrandAssetKind.ICON:
            self.logo_warm_up.company(company.id)

    def _count_change(self, auth: PlatformAuthContext) -> None:
        """One slot of the platform account's hourly budget of brand changes, for every attempt: a
        refused file costs the server as much as a stored one."""
        policy = self.policies.brand_changes_per_user
        decision = self.limiter.hit(policy, f"platform:{auth.platform_admin_id}")
        if not decision.allowed:
            raise RateLimited(retry_after=decision.retry_after, policy=policy.name)

    def _lock(self, auth: PlatformAuthContext, company_id: UUID) -> Company:
        """The company row `FOR UPDATE` (two changes of one brand never interleave), then the caller
        again (B11-38): a session that ended while the request waited or checked its file changes
        nothing. An ended session answers 401 whether or not the company exists."""
        company = self.companies.get(company_id, lock=RowLock.UPDATE)
        require_platform_still_authorized(self.db, auth, now=app_time.now())
        return require_found(company)

    def _view(self, company: Company) -> CompanyBrand:
        return brand_of(company, self.brands.images(company.id))

    def _audit(
        self,
        auth: PlatformAuthContext,
        company: Company,
        context: RequestContext,
        *,
        changed: str,
        removed: bool = False,
    ) -> None:
        """Both rows of the change (B11-5): which part of the brand changed, and whether it was removed.
        Never the image, its size or the colour's value."""
        metadata: dict[str, object] = {"changed_fields": [changed]}
        if removed:
            metadata["removed_fields"] = [changed]
        audit.record_platform_change(
            self.db,
            action=AuditAction.COMPANY_BRAND_UPDATED,
            context=context,
            platform_admin_id=auth.platform_admin_id,
            company_id=company.id,
            entity_type=AuditEntity.COMPANY,
            entity_id=company.id,
            metadata=metadata,
        )


# ---- the public pages --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PublicImage:
    """A company's image as the public endpoint answers it."""

    content: bytes
    etag: str
    cache_control: str


@dataclass(frozen=True, slots=True)
class PublicDocument:
    """A JSON answer of a public endpoint, serialised once: its bytes and their entity tag."""

    content: bytes
    etag: str


def _document(value: Any) -> PublicDocument:
    content = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return PublicDocument(content=content, etag=etag_of(content))


def short_name(name: str) -> str:
    """A company's name where there is little room, under an installed app's icon: the manifest's
    `short_name` (B12-25). The name itself while it has at most `SHORT_NAME_MAX_LENGTH` characters;
    otherwise as many of its first words as fit, without the sign or the small word that only joined
    them to the rest; and, where no word boundary serves (one long first word, or nothing before it but
    "The"), the start of the name. No ellipsis: a short name is a name, not a cut sentence, and the
    full one is the manifest's `name`."""
    words = name.split()
    name = " ".join(words)
    if len(name) <= SHORT_NAME_MAX_LENGTH:
        return name
    kept: list[str] = []
    for word in words:
        if len(" ".join([*kept, word])) > SHORT_NAME_MAX_LENGTH:
            break
        kept.append(word)
    while kept and (kept[-1].casefold() in _JOINING_WORDS or not kept[-1].strip(_JOINING_SIGNS)):
        kept.pop()
    short = " ".join(kept).rstrip(_JOINING_SIGNS)
    if short:
        return short
    # The start of the name, never half of a character (`cut_short` ends with an ellipsis, which a
    # short name leaves out).
    return cut_short(name, SHORT_NAME_MAX_LENGTH + 1)[:-1]


def web_app_manifest(company: Company, brand: CompanyBrand, images: BrandImages) -> dict[str, Any]:
    """The company's web app manifest (B12-10): its own name, start page, colours and icon. Nothing in
    it names the product. A company without an icon lists none: the browser then draws its own. The
    theme colour is the colour of the application's shell, the palette's `surface` (B12-21)."""
    language = Language(company.default_language)
    name = (company.name_ar if language is Language.AR else None) or company.name
    start = f"/c/{quote(company.slug, safe='')}"
    icon = images.get(BrandAssetKind.ICON)
    return {
        "id": start,
        "name": name,
        "short_name": short_name(name),
        "description": _MANIFEST_DESCRIPTION[language],
        "lang": language.value,
        "dir": "rtl" if language is Language.AR else "ltr",
        "start_url": start,
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": brand.palette.tint if brand.palette else DEFAULT_BACKGROUND_COLOR,
        "theme_color": brand.palette.surface if brand.palette else DEFAULT_THEME_COLOR,
        "icons": (
            [
                {
                    "src": image_url(company.slug, icon),
                    "sizes": f"{icon.width}x{icon.height}",
                    "type": "image/png",
                    "purpose": "any",
                }
            ]
            if icon is not None
            else []
        ),
    }


class PublicBrandService:
    def __init__(
        self, db: Session, *, settings: Settings, limiter: RateLimiter, policies: RatePolicies
    ) -> None:
        self.settings = settings
        self.limiter = limiter
        self.policies = policies
        self.brands = CompanyBrandRepository(db)

    def count_request(self, context: RequestContext) -> None:
        """Every request of a public identity endpoint, before anything is looked up: one slot of the
        client's budget per address and per IPv6 /48, or 429 RATE_LIMITED. What is asked for and what
        the answer will be make no difference, so the budget bounds probing for companies as much as
        load."""
        secret = self.settings.secret_key.get_secret_value()
        keys = [
            LimitKey(
                self.policies.public_brand_ip,
                limiter_key(secret, "public-brand-ip", rate_limit_subject(context.ip_address)),
            )
        ]
        prefix = rate_limit_prefix(context.ip_address)
        if prefix is not None:
            keys.append(
                LimitKey(
                    self.policies.public_brand_prefix, limiter_key(secret, "public-brand-prefix", prefix)
                )
            )
        reservation = self.limiter.reserve(keys)
        if reservation.denied_by is not None:
            raise RateLimited(retry_after=reservation.retry_after, policy=reservation.denied_by.name)
        self.limiter.settle(reservation, counted=True)

    def _company(self, slug: str) -> Company:
        """The active company of `slug`, or the 404 that an unknown slug, a deactivated company and a
        slug no company could have all get."""
        company = self.brands.active_company(slug) if is_company_slug(slug) else None
        if company is None:
            raise NotFound()
        return company

    def brand(self, slug: str) -> PublicDocument:
        company = self._company(slug)
        view = PublicCompanyBrand(
            slug=company.slug,
            name=company.name,
            name_ar=company.name_ar,
            default_language=Language(company.default_language),
            brand=brand_of(company, self.brands.images(company.id)),
        )
        return _document(view.model_dump(mode="json"))

    def manifest(self, slug: str) -> PublicDocument:
        company = self._company(slug)
        images = self.brands.images(company.id)
        return _document(web_app_manifest(company, brand_of(company, images), images))

    def image(self, slug: str, kind: BrandAssetKind, version: str | None) -> PublicImage:
        """The image and how long it may be kept: for a year under the address of its current version,
        for a minute under any other (no version, an older one, a made-up one)."""
        found: BrandImage | None = self.brands.public_image(slug, kind) if is_company_slug(slug) else None
        if found is None:
            raise NotFound()
        current = version == found.info.version
        return PublicImage(
            content=found.content,
            etag=f'"{found.info.sha256}"',
            cache_control=CACHE_CURRENT_VERSION if current else CACHE_OTHER_VERSION,
        )
