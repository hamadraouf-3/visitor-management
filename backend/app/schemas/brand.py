"""Schemas of a company's identity (Phase 12, docs/decisions/phase-12-backend.md): its brand as every
client receives it, the platform owner's changes of it, and what the public sign-in and pass pages read.
"""

from typing import Annotated

from pydantic import BeforeValidator, StringConstraints

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.core.palette import is_color
from app.models.enums import Language
from app.schemas.common import QueryModel, RequestModel, ResponseModel

INVALID_COLOR = FieldProblem(
    FieldCode.INVALID_COLOR, "Enter a colour as # and six hexadecimal digits in lower case, e.g. #188086."
)


def _color(value: object) -> object:
    """A colour is exactly `#rrggbb` in lower case (B12-4): nothing is trimmed, folded or guessed, so
    what is stored can be written into a style sheet or an e-mail as it is. Everything else, of whatever
    type, is the one field error."""
    if not is_color(value):
        raise FieldValueError(INVALID_COLOR)
    return value


def _color_or_none(value: object) -> object:
    return None if value is None else _color(value)


BrandColor = Annotated[str, BeforeValidator(_color)]
OptionalBrandColor = Annotated[str | None, BeforeValidator(_color_or_none)]


class BrandPalette(ResponseModel):
    """The shades derived from a company's colour (`app.core.palette`), each `#rrggbb`. Text and its
    background are always one of these pairs: `on_surface` on `surface` or `surface_hover`; white
    (`on_strong`) on `strong`, `strong_hover` or `deep`; `on_bright` on `bright`; `bright` on `deep`;
    `strong` on white or on `tint`.

    `surface` is what the brand's surfaces are painted with (the application's shell, primary buttons):
    the chosen colour itself wherever white or the dark ink reads on it, otherwise `strong`. `strong`
    is the colour of text, links and icons on white (B12-21)."""

    strong: str
    strong_hover: str
    deep: str
    bright: str
    tint: str
    tint_border: str
    on_strong: str
    on_bright: str
    surface: str
    on_surface: str
    surface_hover: str


class CompanyBrand(ResponseModel):
    """A company's identity. The three addresses are same-origin paths of the public image endpoint,
    each carrying the version of its image (use them as they are); null where the company has no such
    image. `palette` is null exactly when `color` is. `version` changes whenever an image or the colour
    changes."""

    logo_url: str | None
    logo_dark_url: str | None
    icon_url: str | None
    color: str | None
    palette: BrandPalette | None
    version: str


class PublicCompanyBrand(ResponseModel):
    """GET /public/companies/{slug}/brand: what a sign-in page and a visitor's pass page may know of an
    active company before anyone signs in: how it is named, its language and its identity."""

    slug: str
    name: str
    name_ar: str | None
    default_language: Language
    brand: CompanyBrand


class BrandImageQuery(QueryModel):
    """GET /public/companies/{slug}/brand/{kind}.png: `v` is the image's version, as the addresses of a
    `CompanyBrand` carry it. It selects nothing (the image is always the current one): it only decides
    how long the answer may be kept."""

    v: Annotated[str, StringConstraints(max_length=64)] | None = None


class CompanyBrandUpdate(RequestModel):
    """PATCH /platform/companies/{id}/brand: the company's colour, or null for the product's palette."""

    color: OptionalBrandColor


class BrandPaletteRequest(RequestModel):
    """POST /platform/brand/palette: the palette a colour would give (nothing is saved)."""

    color: BrandColor
