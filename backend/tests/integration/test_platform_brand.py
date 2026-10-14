"""A company's identity, set by the platform owner (Phase 12, B12-6, B12-7): its colour and its three
images; who may change them (the platform owner alone); what an upload may be; the audit rows in both
trails; and where the identity then shows (Me, the platform's company views, the company's e-mails)."""

import hashlib
import random
import re
import uuid
import zlib
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import NotAuthenticated
from app.core.palette import derive_palette
from app.core.png import sanitize_png
from app.core.rate_limit import DisabledRateLimiter, RatePolicies
from app.core.request_context import SYSTEM_CONTEXT
from app.core.time import FakeClock
from app.email.logos import light_rendition
from app.email.providers.memory import MemoryProvider
from app.email.service import LOGO_CONTENT_ID
from app.models import BrandAssetKind, Company, CompanyBrandAsset, PlatformAdmin, PlatformSession
from app.security.platform_sessions import PlatformAuthContext
from app.services.brand import IMAGE_LIMITS, PlatformBrandService, brand_version
from tests.conftest import TEST_START
from tests.memory_support import MIB, measured_memory
from tests.png_support import (
    SAMPLE_ICON,
    SAMPLE_LOGO,
    assemble,
    chunk,
    chunk_types,
    header,
    image_data,
    make_png,
    scanlines,
)
from tests.support import (
    Api,
    Factory,
    PlatformApi,
    World,
    audit_rows,
    create_visit,
    error_code,
    no_brand,
    platform_audit_rows,
    platform_signed_in,
    rate_limits,
    refreshed,
    signed_in,
)

PNG = {"Content-Type": "image/png"}
VIOLET = "#7c3aed"
IMAGE_URL = re.compile(
    r"/api/v1/public/companies/([a-z0-9-]+)/brand/(logo|logo_dark|icon)\.png\?v=([0-9a-f]{16})"
)
ACTION = "COMPANY_BRAND_UPDATED"


@pytest.fixture
def owner(factory: Factory) -> PlatformAdmin:
    return factory.platform_admin(email="owner@platform.test")


@pytest.fixture
def platform(make_client, owner: PlatformAdmin) -> PlatformApi:
    return platform_signed_in(make_client, owner)


def _brand(company: Company | uuid.UUID) -> str:
    return f"/platform/companies/{getattr(company, 'id', company)}/brand"


def _asset(company: Company | uuid.UUID, kind: str = "logo") -> str:
    return f"{_brand(company)}/assets/{kind}"


def _upload(api: Api, company: Company, kind: str = "logo", data: bytes = SAMPLE_LOGO) -> httpx.Response:
    return api.put(_asset(company, kind), content=data, headers=PNG)


def _codes(response: httpx.Response) -> dict:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert set(error["details"]["field_codes"]) == set(error["details"]["fields"])
    return dict(error["details"]["field_codes"])


def _noisy_png(width: int, height: int) -> bytes:
    """A valid 8-bit RGBA image whose pixels are noise: its file is about as large as its pixels."""
    noise = random.Random(12)
    raw = b"".join(b"\x00" + noise.randbytes(4 * width) for _ in range(height))
    return assemble(header(width, height), *image_data(raw), chunk(b"IEND"))


def _stored(db: Session, company: Company) -> dict[str, tuple]:
    """What the database holds of a company's images: per kind, the bytes and what describes them."""
    db.expire_all()
    rows = db.execute(
        select(
            CompanyBrandAsset.kind,
            CompanyBrandAsset.content,
            CompanyBrandAsset.byte_size,
            CompanyBrandAsset.width,
            CompanyBrandAsset.height,
            CompanyBrandAsset.sha256,
            CompanyBrandAsset.version,
        ).where(CompanyBrandAsset.company_id == company.id)
    )
    return {row[0]: tuple(row[1:]) for row in rows}


# ---- reading ---------------------------------------------------------------------------------------------


def test_a_company_without_an_identity_of_its_own(platform: PlatformApi, world: World) -> None:
    response = platform.get(_brand(world.a.company))
    assert response.status_code == 200
    assert response.json() == no_brand()
    assert response.headers["Cache-Control"] == "no-store"  # nothing of the platform's API is kept
    assert platform.get(_brand(uuid.uuid4())).status_code == 404
    assert platform.get("/platform/companies/not-an-id/brand").status_code == 404


@pytest.mark.parametrize(
    ("method", "path", "options"),
    [
        ("GET", "", {}),
        ("PATCH", "", {"json": {"color": VIOLET}}),
        ("PUT", "/assets/logo", {"content": SAMPLE_LOGO, "headers": PNG}),
        ("PUT", "/assets/logo", {"content": b"not a png", "headers": {"Content-Type": "text/html"}}),
        ("DELETE", "/assets/logo", {}),
    ],
)
def test_only_the_platform_owner_reaches_a_company_s_identity(
    make_client, world: World, db: Session, method: str, path: str, options: dict
) -> None:
    """Nobody signed in, and every role of the company itself (its administrator included): 401, before
    anything of the request is read, and nothing changes."""
    url = "/api/v1" + _brand(world.a.company) + path
    anonymous = make_client()
    response = anonymous.request(method, url, **options)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"
    for user in (world.a.admin, world.a.manager, world.a.receptionist, world.a.employee, world.b.admin):
        api = signed_in(make_client, user)
        headers = {**options.get("headers", {}), "X-CSRF-Token": api.csrf_token or ""}
        response = api.client.request(method, url, **{**options, "headers": headers})
        assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED", user.email
    assert refreshed(db, Company, world.a.company.id).brand_color is None
    assert _stored(db, world.a.company) == {}
    assert audit_rows(db, ACTION) == [] and platform_audit_rows(db, ACTION) == []


def test_the_palette_preview_is_the_platform_owner_s_too(make_client, world: World) -> None:
    body = {"color": VIOLET}
    assert make_client().post("/api/v1/platform/brand/palette", json=body).status_code == 401
    response = signed_in(make_client, world.a.admin).post("/platform/brand/palette", json=body)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"


@pytest.mark.parametrize(
    ("method", "path", "options"),
    [
        ("PATCH", "", {"json": {"color": VIOLET}}),
        ("PUT", "/assets/logo", {"content": SAMPLE_LOGO, "headers": PNG}),
        ("DELETE", "/assets/logo", {}),
    ],
)
def test_a_change_of_identity_needs_the_platform_csrf_token(
    platform: PlatformApi, world: World, db: Session, factory: Factory, method: str, path: str, options: dict
) -> None:
    factory.brand(world.a.company, color="#111111", images={BrandAssetKind.LOGO: SAMPLE_ICON})
    before = _stored(db, world.a.company)
    response = platform.client.request(method, "/api/v1" + _brand(world.a.company) + path, **options)
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"
    # ... and from another site, whatever token it carries.
    headers = {**options.get("headers", {}), "Origin": "https://evil.example", "X-CSRF-Token": "x"}
    response = platform.client.request(
        method, "/api/v1" + _brand(world.a.company) + path, **{**options, "headers": headers}
    )
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"
    assert refreshed(db, Company, world.a.company.id).brand_color == "#111111"
    assert _stored(db, world.a.company) == before
    assert audit_rows(db, ACTION) == []


# ---- the colour ------------------------------------------------------------------------------------------


def test_setting_and_clearing_a_company_s_colour(
    platform: PlatformApi, owner: PlatformAdmin, world: World, db: Session
) -> None:
    company = world.a.company
    response = platform.patch(_brand(company), json={"color": VIOLET})
    assert response.status_code == 200, response.text
    brand = response.json()
    assert brand == {
        **no_brand(),
        "color": VIOLET,
        "palette": derive_palette(VIOLET).as_dict(),
        "version": brand_version(VIOLET, {}),
    }
    assert brand["version"] != no_brand()["version"]
    assert refreshed(db, Company, company.id).brand_color == VIOLET
    assert platform.get(_brand(company)).json() == brand
    assert platform.get(f"/platform/companies/{company.id}").json()["brand"] == brand

    # Both trails say which part changed; neither holds the colour.
    [row] = audit_rows(db, ACTION, company_id=company.id)
    assert (row.actor_user_id, row.entity_id) == (None, company.id)
    assert row.meta == {"changed_fields": ["color"], "source": "platform", "platform_admin_id": str(owner.id)}
    assert (row.ip_address, row.user_agent) == (None, None)  # B11-37
    [twin] = platform_audit_rows(db, ACTION, company_id=company.id)
    assert (twin.actor_platform_admin_id, twin.entity_id) == (owner.id, company.id)
    assert twin.meta == {"changed_fields": ["color"]}
    assert str(twin.ip_address) == "203.0.113.10" and twin.request_id == row.request_id
    assert (twin.entity_type, row.entity_type) == ("company", "company")

    # The same colour again changes and audits nothing.
    assert platform.patch(_brand(company), json={"color": VIOLET}).json() == brand
    assert len(audit_rows(db, ACTION)) == 1 and len(platform_audit_rows(db, ACTION)) == 1

    # Clearing it gives the product's palette back.
    cleared = platform.patch(_brand(company), json={"color": None})
    assert cleared.status_code == 200 and cleared.json() == no_brand()
    assert refreshed(db, Company, company.id).brand_color is None
    assert audit_rows(db, ACTION)[-1].meta == {
        "changed_fields": ["color"],
        "removed_fields": ["color"],
        "source": "platform",
        "platform_admin_id": str(owner.id),
    }
    assert platform_audit_rows(db, ACTION)[-1].meta == {
        "changed_fields": ["color"],
        "removed_fields": ["color"],
    }
    assert platform.patch(_brand(company), json={"color": None}).json() == no_brand()
    assert len(audit_rows(db, ACTION)) == 2
    # Another company's identity was never touched.
    assert platform.get(_brand(world.b.company)).json() == no_brand()


@pytest.mark.parametrize(
    "value",
    [
        "",
        "7c3aed",
        "#7C3AED",
        "#7c3ae",
        "#7c3aedd",
        "#7c3aeg",
        " #7c3aed",
        "#7c3aed ",
        "#fff",
        "violet",
        "rgb(124,58,237)",
        "#7c3aed;background:url(https://evil.test/x)",
        "#7c3aed}body{display:none}",
        '#7c3aed"><script>alert(1)</script>',
        8141549,
        ["#7c3aed"],
        {"value": "#7c3aed"},
        True,
    ],
)
def test_what_is_not_a_colour_is_refused(
    platform: PlatformApi, world: World, db: Session, value: object
) -> None:
    for response in (
        platform.patch(_brand(world.a.company), json={"color": value}),
        platform.post("/platform/brand/palette", json={"color": value}),
    ):
        assert _codes(response) == {"color": {"code": "invalid_color", "params": {}}}
        assert str(value) not in response.text or value in ("", True)  # the refused value is not echoed
    assert refreshed(db, Company, world.a.company.id).brand_color is None
    assert audit_rows(db, ACTION) == []


def test_a_colour_change_names_the_colour_and_nothing_else(platform: PlatformApi, world: World) -> None:
    company = world.a.company
    assert _codes(platform.patch(_brand(company), json={})) == {"color": {"code": "required", "params": {}}}
    assert _codes(platform.patch(_brand(company), json={"color": VIOLET, "logo_url": "/x"})) == {
        "logo_url": {"code": "not_allowed", "params": {}}
    }
    assert _codes(
        platform.patch(_brand(company), json={"color": VIOLET, "palette": {"strong": "#000000"}})
    ) == {"palette": {"code": "not_allowed", "params": {}}}
    assert platform.patch(_brand(uuid.uuid4()), json={"color": VIOLET}).status_code == 404
    assert platform.get(_brand(company)).json() == no_brand()


def test_the_palette_preview_saves_nothing(platform: PlatformApi, world: World, db: Session) -> None:
    for color in (VIOLET, "#ffd400", "#000000", "#ffffff"):
        response = platform.post("/platform/brand/palette", json={"color": color})
        assert response.status_code == 200, response.text
        assert response.json() == derive_palette(color).as_dict()
    assert _codes(platform.post("/platform/brand/palette", json={})) == {
        "color": {"code": "required", "params": {}}
    }
    assert _codes(platform.post("/platform/brand/palette", json={"color": None})) == {
        "color": {"code": "invalid_color", "params": {}}
    }
    assert platform.post("/platform/brand/palette", json={"color": VIOLET}, csrf=False).status_code == 403
    assert refreshed(db, Company, world.a.company.id).brand_color is None
    assert audit_rows(db, ACTION) == [] and platform_audit_rows(db, ACTION) == []


# ---- the images ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "field", "data", "size"),
    [
        ("logo", "logo_url", SAMPLE_LOGO, (240, 80)),
        ("logo_dark", "logo_dark_url", make_png(64, 32, fill=0xEE), (64, 32)),
        ("icon", "icon_url", SAMPLE_ICON, (192, 192)),
    ],
)
def test_storing_and_removing_an_image(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    db: Session,
    make_client,
    kind: str,
    field: str,
    data: bytes,
    size: tuple[int, int],
) -> None:
    company = world.a.company
    response = _upload(platform, company, kind, data)
    assert response.status_code == 200, response.text
    brand = response.json()
    match = IMAGE_URL.fullmatch(brand[field])
    assert match is not None and match.group(1, 2) == (company.slug, kind)
    assert {name: value for name, value in brand.items() if name not in (field, "version")} == {
        name: value for name, value in no_brand().items() if name not in (field, "version")
    }
    assert brand["version"] != no_brand()["version"]
    # Stored as the server wrote it, with what describes it.
    [(content, byte_size, width, height, sha256, version)] = _stored(db, company).values()
    assert content == sanitize_png(data, IMAGE_LIMITS[BrandAssetKind(kind)]).data == data
    assert (byte_size, width, height) == (len(data), *size)
    assert sha256 == hashlib.sha256(data).hexdigest() and version == match.group(3)
    # ... and served to anyone under the address the brand names.
    public = make_client().get(brand[field])
    assert public.status_code == 200 and public.content == data
    assert public.headers["Content-Type"] == "image/png"

    [row] = audit_rows(db, ACTION, company_id=company.id)
    assert row.meta == {"changed_fields": [kind], "source": "platform", "platform_admin_id": str(owner.id)}
    assert (row.actor_user_id, row.ip_address, row.user_agent) == (None, None, None)
    [twin] = platform_audit_rows(db, ACTION, company_id=company.id)
    assert twin.meta == {"changed_fields": [kind]} and twin.actor_platform_admin_id == owner.id

    # The same image again: the same address, nothing audited.
    assert _upload(platform, company, kind, data).json() == brand
    assert len(audit_rows(db, ACTION)) == 1

    # Another image: another address, and the old one no longer names the current version.
    other = make_png(*size, fill=0x99)
    replaced = _upload(platform, company, kind, other).json()
    assert replaced[field] != brand[field] and IMAGE_URL.fullmatch(replaced[field])
    assert replaced["version"] != brand["version"]
    assert make_client().get(replaced[field]).content == other
    assert len(_stored(db, company)) == 1 and len(audit_rows(db, ACTION)) == 2

    removed = platform.delete(_asset(company, kind))
    assert removed.status_code == 200 and removed.json() == no_brand()
    assert audit_rows(db, ACTION)[-1].meta == {
        "changed_fields": [kind],
        "removed_fields": [kind],
        "source": "platform",
        "platform_admin_id": str(owner.id),
    }
    assert platform_audit_rows(db, ACTION)[-1].meta == {"changed_fields": [kind], "removed_fields": [kind]}
    # The row stays (the runtime role deletes nothing), emptied of the image and of everything about it.
    assert _stored(db, company) == {kind: (None, None, None, None, None, None)}
    for address in (brand[field], replaced[field]):
        assert make_client().get(address).status_code == 404
    # Removing what is not there changes and audits nothing.
    assert platform.delete(_asset(company, kind)).json() == no_brand()
    assert len(audit_rows(db, ACTION)) == 3
    # ... and the image can be stored again.
    again = _upload(platform, company, kind, data).json()
    assert IMAGE_URL.fullmatch(again[field]) and again[field] not in (brand[field], replaced[field])
    assert len(_stored(db, company)) == 1


def test_an_image_is_stored_as_the_server_wrote_it_never_as_it_came(
    platform: PlatformApi, world: World, db: Session, make_client
) -> None:
    """Text, colour profiles, time stamps and private chunks of an upload are not stored or served, and
    the image data arrives as one chunk (B12-2)."""
    raw = scanlines(240, 80)
    upload = assemble(
        header(240, 80),
        chunk(b"tEXt", b"Comment\x00<script>alert(document.cookie)</script>"),
        chunk(b"iCCP", b"profile\x00\x00" + b"\x00" * 40),
        chunk(b"pHYs", b"\x00\x00\x0b\x13\x00\x00\x0b\x13\x01"),
        chunk(b"prVt", b"<html><body onload=alert(1)>"),
        *image_data(raw, pieces=5),
        chunk(b"tIME", b"\x07\xea\x0a\x0d\x0c\x00\x00"),
        chunk(b"IEND"),
    )
    brand = _upload(platform, world.a.company, "logo", upload).json()
    served = make_client().get(brand["logo_url"]).content
    assert chunk_types(served) == [b"IHDR", b"IDAT", b"IEND"]
    assert b"script" not in served and b"<html" not in served and served != upload
    assert served == sanitize_png(upload, IMAGE_LIMITS[BrandAssetKind.LOGO]).data
    [(content, byte_size, *_)] = _stored(db, world.a.company).values()
    assert content == served and byte_size == len(served) < len(upload)
    # The clean file of the same image is the same image: nothing changes, nothing is audited.
    assert _upload(platform, world.a.company, "logo", served).json() == brand
    assert len(audit_rows(db, ACTION)) == 1


def test_the_three_images_and_the_colour_make_one_identity(
    platform: PlatformApi, world: World, make_client
) -> None:
    company = world.a.company
    _upload(platform, company, "logo", SAMPLE_LOGO)
    _upload(platform, company, "logo_dark", make_png(240, 80, fill=0xEE))
    _upload(platform, company, "icon", SAMPLE_ICON)
    brand = platform.patch(_brand(company), json={"color": VIOLET}).json()
    assert all(IMAGE_URL.fullmatch(brand[name]) for name in ("logo_url", "logo_dark_url", "icon_url"))
    assert len({brand["logo_url"], brand["logo_dark_url"], brand["icon_url"]}) == 3
    assert brand["palette"] == derive_palette(VIOLET).as_dict()
    # Everyone of the company reads it in Me; nobody of another company does.
    for user in (world.a.admin, world.a.employee, world.a.receptionist):
        me = signed_in(make_client, user).get("/auth/me").json()
        assert me["company"]["brand"] == brand and me["company"]["slug"] == company.slug
    assert signed_in(make_client, world.b.admin).get("/auth/me").json()["company"]["brand"] == no_brand()
    # The platform's list carries each company's own.
    listed = {item["id"]: item["brand"] for item in platform.get("/platform/companies").json()["items"]}
    assert listed[str(company.id)] == brand and listed[str(world.b.company.id)] == no_brand()


def test_a_deactivated_company_keeps_its_identity_for_the_platform_owner_alone(
    platform: PlatformApi, world: World, make_client
) -> None:
    company = world.a.company
    brand = _upload(platform, company).json()
    assert platform.post(f"/platform/companies/{company.id}/deactivate").status_code == 200
    assert platform.get(_brand(company)).json() == brand
    assert make_client().get(brand["logo_url"]).status_code == 404  # public only while active (B12-9)
    # It can still be prepared for the day the company returns.
    changed = platform.patch(_brand(company), json={"color": VIOLET}).json()
    assert changed["color"] == VIOLET and changed["logo_url"] == brand["logo_url"]
    assert platform.post(f"/platform/companies/{company.id}/reactivate").status_code == 200
    assert make_client().get(brand["logo_url"]).status_code == 200


# ---- what an upload may be ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "content_type",
    [
        None,
        "",
        "application/octet-stream",
        "application/json",
        "image/jpeg",
        "image/svg+xml",
        "image/apng",
        "image/png2",
        "text/html",
        "multipart/form-data; boundary=x",
        "image/*",
        "png",
    ],
)
def test_an_upload_must_say_that_it_is_a_png(
    platform: PlatformApi, world: World, db: Session, content_type: str | None
) -> None:
    headers = {"X-CSRF-Token": platform.csrf_token or ""}
    if content_type is not None:
        headers["Content-Type"] = content_type
    response = platform.client.put("/api/v1" + _asset(world.a.company), content=SAMPLE_LOGO, headers=headers)
    assert response.status_code == 415, response.text
    assert response.json()["error"] == {
        "code": "UNSUPPORTED_MEDIA_TYPE",
        "message": "Upload the image as a PNG file (Content-Type: image/png).",
        "details": {},
    }
    assert _stored(db, world.a.company) == {} and audit_rows(db, ACTION) == []


@pytest.mark.parametrize(
    "content_type", ["image/png", "IMAGE/PNG", "image/png; charset=binary", " image/png "]
)
def test_the_media_type_is_read_as_a_media_type(
    platform: PlatformApi, world: World, content_type: str
) -> None:
    response = platform.put(
        _asset(world.a.company), content=SAMPLE_LOGO, headers={"Content-Type": content_type}
    )
    assert response.status_code == 200, response.text


def _png(*chunks: bytes) -> bytes:
    return assemble(*chunks)


REFUSED_UPLOADS = {
    "not an image": b"<!doctype html><script>alert(1)</script>",
    "a JPEG": b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 64,
    "a GIF": b"GIF89a" + b"\x00" * 64,
    "an SVG": b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    "the signature alone": SAMPLE_LOGO[:8],
    "truncated": SAMPLE_LOGO[:-20],
    "a wrong checksum": SAMPLE_LOGO[:-5] + bytes([SAMPLE_LOGO[-5] ^ 0xFF]) + SAMPLE_LOGO[-4:],
    "HTML after the end": SAMPLE_LOGO + b"<script>alert(1)</script>",
    "a ZIP after the end": SAMPLE_LOGO + b"PK\x03\x04" + b"\x00" * 26,
    "one byte after the end": SAMPLE_LOGO + b"\x00",
    "interlaced": _png(header(240, 80, interlace=1), *image_data(scanlines(240, 80)), chunk(b"IEND")),
    "animated": _png(
        header(240, 80),
        chunk(b"acTL", b"\x00\x00\x00\x02\x00\x00\x00\x00"),
        *image_data(scanlines(240, 80)),
        chunk(b"IEND"),
    ),
    "less data than its size": _png(header(240, 80), *image_data(scanlines(240, 79)), chunk(b"IEND")),
    "more data than its size": _png(header(240, 80), *image_data(scanlines(240, 81)), chunk(b"IEND")),
    "no image data": _png(header(240, 80), chunk(b"IEND")),
    "an unknown critical chunk": _png(
        header(240, 80), chunk(b"XXXX", b"x"), *image_data(scanlines(240, 80)), chunk(b"IEND")
    ),
}


@pytest.mark.parametrize("name", REFUSED_UPLOADS)
def test_what_is_not_a_clean_png_is_refused(
    platform: PlatformApi, world: World, db: Session, name: str
) -> None:
    response = _upload(platform, world.a.company, "logo", REFUSED_UPLOADS[name])
    assert _codes(response) == {"file": {"code": "invalid_image", "params": {}}}
    expected = {
        "interlaced": "Upload a PNG image that is not interlaced.",
        "animated": "Upload a PNG image that is not animated.",
    }.get(name, "Upload a valid PNG image.")
    assert response.json()["error"]["details"]["fields"] == {"file": expected}
    assert _stored(db, world.a.company) == {} and audit_rows(db, ACTION) == []


@pytest.mark.parametrize("kind", ["logo", "logo_dark"])
def test_a_logo_of_16_bits_a_sample_is_refused(
    platform: PlatformApi, world: World, db: Session, kind: str
) -> None:
    """B13-7: a logo is uploaded at 8 bits a sample at most (what the web application's canvas writes);
    the e-mails draw a 16-bit one in almost twice the time. The field code is the existing one, and its
    message says what to upload. An icon keeps every depth."""
    response = _upload(platform, world.a.company, kind, make_png(240, 80, bit_depth=16))
    assert _codes(response) == {"file": {"code": "invalid_image", "params": {}}}
    assert response.json()["error"]["details"]["fields"] == {
        "file": "Upload a PNG image of 8 bits per channel."
    }
    assert _stored(db, world.a.company) == {} and audit_rows(db, ACTION) == []
    icon = make_png(192, 192, bit_depth=16)
    assert _upload(platform, world.a.company, "icon", icon).status_code == 200


def test_an_empty_upload_is_a_missing_file(platform: PlatformApi, world: World) -> None:
    response = _upload(platform, world.a.company, "logo", b"")
    assert _codes(response) == {"file": {"code": "required", "params": {}}}


@pytest.mark.parametrize(
    ("kind", "size", "code", "params"),
    [
        ("logo", (31, 32), "image_too_small", {"min_width": 32, "min_height": 32}),
        ("logo", (32, 31), "image_too_small", {"min_width": 32, "min_height": 32}),
        ("logo_dark", (16, 16), "image_too_small", {"min_width": 32, "min_height": 32}),
        ("logo", (1201, 100), "image_too_large", {"max_width": 1200, "max_height": 600}),
        ("logo_dark", (100, 601), "image_too_large", {"max_width": 1200, "max_height": 600}),
        ("icon", (191, 191), "image_too_small", {"min_width": 192, "min_height": 192}),
        ("icon", (513, 513), "image_too_large", {"max_width": 512, "max_height": 512}),
        ("icon", (256, 192), "image_not_square", {}),
        ("icon", (192, 256), "image_not_square", {}),
    ],
)
def test_an_image_outside_its_limits_is_refused_with_the_limits(
    platform: PlatformApi,
    world: World,
    db: Session,
    kind: str,
    size: tuple[int, int],
    code: str,
    params: dict,
) -> None:
    response = _upload(platform, world.a.company, kind, make_png(*size))
    assert _codes(response) == {"file": {"code": code, "params": params}}
    assert _stored(db, world.a.company) == {}


@pytest.mark.parametrize(
    ("kind", "size"),
    [
        ("logo", (32, 32)),
        ("logo", (1200, 600)),
        ("logo_dark", (1200, 32)),
        ("icon", (192, 192)),
        ("icon", (512, 512)),
    ],
)
def test_an_image_at_its_limits_is_stored(
    platform: PlatformApi, world: World, kind: str, size: tuple[int, int]
) -> None:
    assert _upload(platform, world.a.company, kind, make_png(*size)).status_code == 200


def test_an_image_that_claims_a_huge_size_is_refused_on_its_header(
    platform: PlatformApi, world: World
) -> None:
    """A few bytes that claim 2 147 483 647 pixels a side: refused on the header, before any of its data
    is inflated (B12-2)."""
    bomb = _png(header(2**31 - 1, 2**31 - 1), *image_data(b"\x00" * 64), chunk(b"IEND"))
    assert len(bomb) < 200
    assert _codes(_upload(platform, world.a.company, "logo", bomb)) == {
        "file": {"code": "image_too_large", "params": {"max_width": 1200, "max_height": 600}}
    }


def test_data_that_inflates_beyond_its_image_is_refused(platform: PlatformApi, world: World) -> None:
    """A decompression bomb inside an image of allowed size: 64 MiB of zeros deflate to a few kilobytes;
    the server stops inflating at the size the header implies."""
    bomb = _png(header(240, 80), *image_data(b"\x00" * (64 * 1024 * 1024)), chunk(b"IEND"))
    assert len(bomb) < 100 * 1024
    assert _codes(_upload(platform, world.a.company, "logo", bomb)) == {
        "file": {"code": "invalid_image", "params": {}}
    }


def test_refused_uploads_leave_no_inflated_image_behind(platform: PlatformApi, world: World) -> None:
    """A refused upload's answer is an exception, and what a request leaves behind in reference cycles
    lives until the garbage collector next runs. The answer used to carry the check's own error as its
    context, and with it the frame that held the inflated image: 5.5 MiB for each refused upload of the
    largest size, until a collection (40 at once took the reviewed server from 127 to 415 MiB, where it
    stayed). Measured here with the collector off: eight refused uploads together keep less than one
    inflated image (B12-19). The largest a logo upload inflates to is 8 bits a channel since B13-7 (one of
    16 is refused on its header, before anything is inflated)."""
    inflated = 600 * (1 + 1200 * 4)  # the largest logo at 8 bits a channel: 2.7 MiB
    bomb = _png(header(1200, 600), chunk(b"IDAT", zlib.compress(bytes(4 * inflated), 9)), chunk(b"IEND"))
    wrong_filter = bytearray(scanlines(1200, 600))
    wrong_filter[0] = 9
    unknown_filter = _png(
        header(1200, 600), chunk(b"IDAT", zlib.compress(bytes(wrong_filter), 1)), chunk(b"IEND")
    )
    assert max(len(bomb), len(unknown_filter)) < 64 * 1024  # the files themselves are small
    refused = {"file": {"code": "invalid_image", "params": {}}}
    assert _codes(_upload(platform, world.a.company, "logo", bomb)) == refused  # everything is loaded
    with measured_memory() as memory:
        for data in (bomb, unknown_filter) * 4:
            assert _codes(_upload(platform, world.a.company, "logo", data)) == refused
        kept = memory.grown()
    assert kept < inflated, f"{kept / MIB:.1f} MiB kept after 8 refused uploads"


def test_an_upload_may_be_larger_than_any_other_request_and_no_larger_than_512_kib(
    platform: PlatformApi, world: World, db: Session, settings: Settings
) -> None:
    company = world.a.company
    large = _noisy_png(300, 100)
    assert settings.max_request_body_bytes < len(large) < 512 * 1024
    response = _upload(platform, company, "logo", large)
    assert response.status_code == 200, response.text
    assert _stored(db, company)["logo"][0] == large
    # The same bytes to any other endpoint are refused for their size.
    response = platform.patch(_brand(company), content=large, headers={"Content-Type": "application/json"})
    assert response.status_code == 413 and error_code(response) == "PAYLOAD_TOO_LARGE"
    response = platform.post(_asset(company), content=large, headers=PNG)
    assert response.status_code == 413

    huge = _noisy_png(1200, 120)
    assert len(huge) > 512 * 1024
    response = _upload(platform, company, "logo", huge)
    assert response.status_code == 413 and error_code(response) == "PAYLOAD_TOO_LARGE"
    assert response.headers["Cache-Control"] == "no-store"

    def pieces():
        for start in range(0, len(huge), 50_000):
            yield huge[start : start + 50_000]

    response = platform.put(_asset(company), content=pieces(), headers=PNG)  # no declared length
    assert response.status_code == 413 and error_code(response) == "PAYLOAD_TOO_LARGE"
    assert _stored(db, company)["logo"][0] == large  # still the image stored before


def test_an_unknown_image_or_company_is_not_found(platform: PlatformApi, world: World, db: Session) -> None:
    for kind in ("favicon", "logo.png", "LOGO", "logo-dark", "background"):
        assert _upload(platform, world.a.company, kind).status_code == 404, kind
        assert platform.delete(_asset(world.a.company, kind)).status_code == 404, kind
    assert _upload(platform, Company(id=uuid.uuid4())).status_code == 404
    assert platform.delete(_asset(uuid.uuid4())).status_code == 404
    assert (
        platform.put(
            "/platform/companies/not-an-id/brand/assets/logo", content=SAMPLE_LOGO, headers=PNG
        ).status_code
        == 404
    )
    # An unknown company is not found before the file is looked at.
    response = _upload(platform, Company(id=uuid.uuid4()), "logo", b"not a png")
    assert response.status_code == 404
    assert db.scalar(select(func.count()).select_from(CompanyBrandAsset)) == 0


# ---- limits and the session ------------------------------------------------------------------------


def test_brand_changes_have_an_hourly_budget_per_platform_account(
    app: FastAPI,
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    db: Session,
    factory: Factory,
    make_client,
) -> None:
    """Every attempt counts (a refused file costs as much as a stored one); reading and the palette
    preview do not."""
    company = world.a.company
    with rate_limits(app, brand_changes_per_user=4):
        assert _upload(platform, company).status_code == 200
        assert _upload(platform, company, "logo", b"not a png").status_code == 422
        assert platform.patch(_brand(company), json={"color": VIOLET}).status_code == 200
        assert platform.delete(_asset(company, "icon")).status_code == 200  # nothing to remove: counted
        for _ in range(3):
            assert platform.get(_brand(company)).status_code == 200
            assert platform.post("/platform/brand/palette", json={"color": VIOLET}).status_code == 200
        for response in (
            platform.patch(_brand(company), json={"color": None}),
            _upload(platform, company, "icon", SAMPLE_ICON),
            platform.delete(_asset(company)),
        ):
            assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
            assert int(response.headers["Retry-After"]) >= 1
        assert platform_audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "brand_changes_per_user"
        # Another platform account has its own budget.
        second = platform_signed_in(make_client, factory.platform_admin(email="second@platform.test"))
        assert second.patch(_brand(company), json={"color": None}).status_code == 200
    assert refreshed(db, Company, company.id).brand_color is None
    assert set(_stored(db, company)) == {"logo"}


def test_a_brand_change_re_checks_the_session_once_it_holds_the_company(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    db: Session,
    settings: Settings,
    factory: Factory,
) -> None:
    """B11-38: a request that was let in and then waited (for the company's row, or on its file) changes
    nothing if the session ended meanwhile; and says so whether or not the company exists."""
    factory.brand(world.a.company, color="#111111", images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    before = _stored(db, world.a.company)
    session = db.scalars(select(PlatformSession).where(PlatformSession.platform_admin_id == owner.id)).one()
    auth = PlatformAuthContext.build(owner, session)
    service = PlatformBrandService(
        db, limiter=DisabledRateLimiter(), policies=RatePolicies.from_settings(settings)
    )
    assert platform.post("/platform/auth/logout").status_code == 204
    company = world.a.company.id
    for change in (
        lambda: service.set_color(auth, company, VIOLET, SYSTEM_CONTEXT),
        lambda: service.put_image(auth, company, BrandAssetKind.LOGO, SAMPLE_ICON, SYSTEM_CONTEXT),
        lambda: service.put_image(auth, company, BrandAssetKind.ICON, SAMPLE_ICON, SYSTEM_CONTEXT),
        lambda: service.remove_image(auth, company, BrandAssetKind.LOGO, SYSTEM_CONTEXT),
        lambda: service.set_color(auth, uuid.uuid4(), VIOLET, SYSTEM_CONTEXT),
        lambda: service.remove_image(auth, uuid.uuid4(), BrandAssetKind.LOGO, SYSTEM_CONTEXT),
    ):
        with pytest.raises(NotAuthenticated):
            change()
    assert refreshed(db, Company, company).brand_color == "#111111"
    assert _stored(db, world.a.company) == before
    assert audit_rows(db, ACTION) == [] and platform_audit_rows(db, ACTION) == []


class _RecordedWarmUp:
    """`LogoWarmUp` that records the companies it was asked to draw, and what was stored by then."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.companies: list[tuple[uuid.UUID, set[str]]] = []

    def company(self, company_id: uuid.UUID) -> None:
        stored = _stored(self.db, Company(id=company_id))
        self.companies.append((company_id, {kind for kind, (content, *_) in stored.items() if content}))


def test_a_changed_logo_is_drawn_for_the_e_mails_after_the_change_is_stored(
    platform: PlatformApi, owner: PlatformAdmin, world: World, db: Session, settings: Settings
) -> None:
    """B13-7: once a logo for light or dark surfaces is stored or removed, the e-mails' renditions are
    drawn in the background (`LogoWarmUp.company`), so that the next e-mail, often inside a check-in,
    does not draw them. An icon, which no e-mail shows, and an upload that changes nothing ask for
    nothing."""
    session = db.scalars(select(PlatformSession).where(PlatformSession.platform_admin_id == owner.id)).one()
    auth = PlatformAuthContext.build(owner, session)
    warm_up = _RecordedWarmUp(db)
    service = PlatformBrandService(
        db,
        limiter=DisabledRateLimiter(),
        policies=RatePolicies.from_settings(settings),
        logo_warm_up=warm_up,  # type: ignore[arg-type]
    )
    company = world.a.company.id
    service.put_image(auth, company, BrandAssetKind.LOGO, SAMPLE_LOGO, SYSTEM_CONTEXT)
    service.put_image(auth, company, BrandAssetKind.LOGO, SAMPLE_LOGO, SYSTEM_CONTEXT)  # the same again
    service.put_image(auth, company, BrandAssetKind.LOGO_DARK, make_png(120, 120), SYSTEM_CONTEXT)
    service.put_image(auth, company, BrandAssetKind.ICON, SAMPLE_ICON, SYSTEM_CONTEXT)
    service.remove_image(auth, company, BrandAssetKind.LOGO_DARK, SYSTEM_CONTEXT)
    service.remove_image(auth, company, BrandAssetKind.LOGO_DARK, SYSTEM_CONTEXT)  # nothing to remove
    # Each after its change: the logo stored, then the dark one too, then the dark one gone.
    assert warm_up.companies == [
        (company, {"logo"}),
        (company, {"logo", "logo_dark"}),
        (company, {"logo", "icon"}),
    ]


# ---- a company's own people ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"brand_color": VIOLET},
        {"color": VIOLET},
        {"brand": {"color": VIOLET}},
        {"logo_url": "https://evil.test/logo.png"},
        {"palette": {"strong": "#000000"}},
        {"slug": "other"},
    ],
)
def test_a_company_s_administrator_cannot_change_its_identity(
    make_client, world: World, db: Session, body: dict
) -> None:
    """No endpoint of a company's own users takes a logo, an icon, a colour or a slug: the settings
    refuse the field, and nothing else of the request is applied."""
    admin = signed_in(make_client, world.a.admin)
    response = admin.patch("/company/settings", json={**body, "name": "Renamed"})
    [field] = body
    assert _codes(response) == {field: {"code": "not_allowed", "params": {}}}
    company = refreshed(db, Company, world.a.company.id)
    assert (company.brand_color, company.name, company.slug) == (None, "Alpha", world.a.company.slug)
    # ... and reading the settings shows no way in either.
    settings_view = admin.get("/company/settings").json()
    assert not {"brand", "brand_color", "color", "logo_url"} & set(settings_view)


# ---- where the identity shows ---------------------------------------------------------------------


def test_a_branded_company_s_invitation_carries_its_logo_and_its_colour(
    platform: PlatformApi, world: World, make_client, email_provider: MemoryProvider, clock: FakeClock
) -> None:
    company = world.a.company
    _upload(platform, company, "logo", SAMPLE_LOGO)
    platform.patch(_brand(company), json={"color": VIOLET})
    host = signed_in(make_client, world.a.employee)
    created = create_visit(host, world.a.employee.id, TEST_START + timedelta(hours=2), send_invitation=True)
    assert created["pass_url"].startswith(f"https://vms.test/pass?c={company.slug}#")
    invitation = email_provider.sent[-1]
    logos = [image for image in invitation.inline_images if image.content_id == LOGO_CONTENT_ID]
    # The logo as e-mails send it since Phase 13 (B13-2): its opaque rendition on a white plate.
    assert [logo.content for logo in logos] == [light_rendition(SAMPLE_LOGO).content]
    assert "#7C3AED" in invitation.html and "#188086" not in invitation.html
    assert invitation.sender == '"Alpha" <no-reply@localhost>'
    # Another company's e-mails are untouched by it.
    other = signed_in(make_client, world.b.employee)
    create_visit(other, world.b.employee.id, TEST_START + timedelta(hours=2), send_invitation=True)
    plain = email_provider.sent[-1]
    assert LOGO_CONTENT_ID not in {image.content_id for image in plain.inline_images}
    assert "#7C3AED" not in plain.html and "#188086" in plain.html


@pytest.mark.parametrize(
    ("typed", "sender_name"),
    [
        ("support\N{FULLWIDTH COMMERCIAL AT}paypal.com", "support paypal.com"),
        ("service\N{SMALL COMMERCIAL AT}bank.example", "service bank.example"),
        (
            "Bank \N{FULLWIDTH LESS-THAN SIGN}ceo@bank.example\N{FULLWIDTH GREATER-THAN SIGN}",
            "Bank ceo bank.example",
        ),
        ("Work@Home", "Work Home"),
    ],
)
def test_a_company_renamed_to_read_as_an_address_sends_under_a_name_that_does_not(
    world: World, make_client, email_provider: MemoryProvider, typed: str, sender_name: str
) -> None:
    """The security review's steps (B12-20): a company's own administrator renames the company, then
    invites someone outside. The name is the company's to choose and is stored as typed (an "@" in a
    company's name is no error, so no company that has one is locked out of its settings); what cannot
    be chosen is what the sender's name reads as, and whose address the e-mail comes from."""
    admin = signed_in(make_client, world.a.admin)
    renamed = admin.patch(
        "/company/settings", json={"name": typed, "name_ar": None, "default_language": "en"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == typed
    create_visit(admin, world.a.admin.id, TEST_START + timedelta(hours=2), send_invitation=True)
    invitation = email_provider.sent[-1]
    assert invitation.sender == f'"{sender_name}" <no-reply@localhost>'
    assert typed in invitation.subject
