"""The public identity endpoints (/api/v1/public, Phase 12, docs/decisions/phase-12-backend.md B12-9).

What a sign-in page and a visitor's pass page may know before anyone signs in: how an **active** company
is named, its language and its brand; its images; its web app manifest. Addressed by the company's slug
alone.

* **No session.** No dependency here reads a cookie, and no answer sets one: a signed-in person, the
  platform owner and a stranger get the same bytes.
* **One 404.** A slug nobody has, a deactivated company, a company without that image and an image name
  that does not exist all answer the same `404 NOT_FOUND`.
* **Counted.** Every request takes a slot of the client's budget before anything is looked up
  (`PublicBrandService.count_request`): 429 RATE_LIMITED with `Retry-After` beyond it.
* **Cacheable, by the API's own word.** These are the only API answers that are not `no-store` (the
  middleware lets only this prefix say so). An image under the address of its current version may be kept
  for a year (a new image has a new address); under any other address for a minute. The identity and the
  manifest change in place, so they are `no-cache`: kept, and checked with the server every time. Every
  answer has a strong entity tag, and a request naming it (`If-None-Match`) gets `304 Not Modified`.
  No answer depends on a request header, so there is nothing to `Vary` on.
* **Images are images.** `Content-Type: image/png` exactly, with `X-Content-Type-Options: nosniff` (on
  every API answer) and a policy that runs and loads nothing; the bytes are the ones the server wrote
  when the image was uploaded (`app.core.png`), never the ones that were sent.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from starlette.responses import Response

from app.api.deps import ContextDep, PublicBrandServiceDep
from app.models.enums import BrandAssetKind
from app.schemas.brand import BrandImageQuery, PublicCompanyBrand
from app.services.brand import CACHE_REVALIDATE, PublicDocument, etag_matches

router = APIRouter(prefix="/public", tags=["public"])

MANIFEST_MEDIA_TYPE = "application/manifest+json"
# Nothing in an image answer runs or loads anything, wherever it is opened.
IMAGE_POLICY = "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
IF_NONE_MATCH = "if-none-match"


def count_public_request(service: PublicBrandServiceDep, context: ContextDep) -> None:
    """Every request of this router takes a slot of the client's budget, before its path is even
    validated: an image name that does not exist counts like any other question."""
    service.count_request(context)


Counted = Depends(count_public_request)


def _answer(
    request: Request, content: bytes, *, media_type: str, etag: str, cache_control: str, **headers: str
) -> Response:
    """The answer, or `304 Not Modified` for a client that already has exactly these bytes. Both carry
    the entity tag and the caching rule (RFC 9110 §15.4.5)."""
    headers = {"ETag": etag, "Cache-Control": cache_control, **headers}
    if etag_matches(request.headers.get(IF_NONE_MATCH), etag):
        return Response(status_code=304, headers=headers)
    return Response(content, media_type=media_type, headers=headers)


def _json(request: Request, document: PublicDocument, media_type: str = "application/json") -> Response:
    return _answer(
        request, document.content, media_type=media_type, etag=document.etag, cache_control=CACHE_REVALIDATE
    )


@router.get("/companies/{slug}/brand", response_model=PublicCompanyBrand, dependencies=[Counted])
def public_company_brand(slug: str, request: Request, service: PublicBrandServiceDep) -> Response:
    return _json(request, service.brand(slug))


@router.get(
    "/companies/{slug}/brand/{kind}.png",
    dependencies=[Counted],
    response_class=Response,
    responses={200: {"content": {"image/png": {}}, "description": "The image"}},
)
def public_company_brand_image(
    slug: str,
    kind: BrandAssetKind,
    request: Request,
    service: PublicBrandServiceDep,
    query: Annotated[BrandImageQuery, Query()],
) -> Response:
    image = service.image(slug, kind, query.v)
    return _answer(
        request,
        image.content,
        media_type="image/png",
        etag=image.etag,
        cache_control=image.cache_control,
        **{"Content-Security-Policy": IMAGE_POLICY},
    )


@router.get(
    "/companies/{slug}/manifest.webmanifest",
    dependencies=[Counted],
    response_class=Response,
    responses={200: {"content": {MANIFEST_MEDIA_TYPE: {}}, "description": "The web app manifest"}},
)
def public_company_manifest(slug: str, request: Request, service: PublicBrandServiceDep) -> Response:
    return _json(request, service.manifest(slug), MANIFEST_MEDIA_TYPE)
