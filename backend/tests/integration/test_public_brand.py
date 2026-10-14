"""The public identity endpoints (Phase 12, B12-9, B12-10): what a sign-in page and a visitor's pass page
read before anyone signs in. Only of active companies, only their name, language and brand; one 404 for
everything else; no session and no cookie; answers that may be kept exactly as long as they are true; a
budget per client."""

import hashlib
import json
import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.palette import derive_palette
from app.models import AuditLog, BrandAssetKind, Company, PlatformAdmin, UserSession
from app.repositories.brand import CompanyBrandRepository
from app.services.brand import brand_of, web_app_manifest
from tests.png_support import SAMPLE_ICON, SAMPLE_LOGO, make_png
from tests.support import (
    Factory,
    PlatformApi,
    World,
    audit_rows,
    error_code,
    no_brand,
    platform_audit_rows,
    platform_signed_in,
    rate_limits,
    signed_in,
)

VIOLET = "#7c3aed"
IMMUTABLE = "public, max-age=31536000, immutable"
A_MINUTE = "public, max-age=60"
IMAGE_POLICY = "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
NOT_FOUND = {"code": "NOT_FOUND", "message": "The requested item was not found.", "details": {}}


@pytest.fixture
def owner(factory: Factory) -> PlatformAdmin:
    return factory.platform_admin(email="owner@platform.test")


@pytest.fixture
def platform(make_client, owner: PlatformAdmin) -> PlatformApi:
    return platform_signed_in(make_client, owner)


def _public(slug: str, rest: str = "/brand") -> str:
    return f"/api/v1/public/companies/{slug}{rest}"


def _etag(content: bytes) -> str:
    return f'"{hashlib.sha256(content).hexdigest()}"'


def _branded(factory: Factory, company: Company) -> None:
    factory.brand(
        company,
        color=VIOLET,
        images={
            BrandAssetKind.LOGO: SAMPLE_LOGO,
            BrandAssetKind.LOGO_DARK: make_png(240, 80, fill=0xEE),
            BrandAssetKind.ICON: SAMPLE_ICON,
        },
    )


def _assert_api_headers(response: httpx.Response) -> None:
    """What every answer of the API carries, these included."""
    headers = response.headers
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["Referrer-Policy"] == "no-referrer"
    assert headers["Cross-Origin-Resource-Policy"] == "same-origin"
    assert len(headers["X-Request-ID"]) == 32
    assert "Set-Cookie" not in headers
    assert "Vary" not in headers  # no answer depends on a request header


# ---- the identity ------------------------------------------------------------------------------------------


def test_the_identity_of_a_company_without_a_brand(make_client, world: World) -> None:
    response = make_client().get(_public(world.a.company.slug))
    assert response.status_code == 200, response.text
    assert response.json() == {
        "slug": world.a.company.slug,
        "name": "Alpha",
        "name_ar": None,
        "default_language": "en",
        "brand": no_brand(),
    }
    assert response.headers["Content-Type"] == "application/json"
    assert response.headers["Cache-Control"] == "no-cache"  # kept, and checked every time
    assert response.headers["ETag"] == _etag(response.content)
    assert response.headers["Content-Security-Policy"].startswith("default-src 'none'")
    _assert_api_headers(response)


def test_the_identity_of_a_branded_company_is_what_its_people_read_in_me(
    make_client, world: World, factory: Factory, platform: PlatformApi
) -> None:
    company = factory.company("Nova Labs", name_ar="نوفا لابز", default_language="ar", slug="nova-labs")
    user = factory.user(company)
    _branded(factory, company)
    body = make_client().get(_public("nova-labs")).json()
    # Exactly this, and nothing else of the company: no id, time zone, address, state or count.
    assert set(body) == {"slug", "name", "name_ar", "default_language", "brand"}
    assert (body["slug"], body["name"], body["name_ar"], body["default_language"]) == (
        "nova-labs",
        "Nova Labs",
        "نوفا لابز",
        "ar",
    )
    brand = body["brand"]
    assert set(brand) == {"logo_url", "logo_dark_url", "icon_url", "color", "palette", "version"}
    assert brand["color"] == VIOLET and brand["palette"] == derive_palette(VIOLET).as_dict()
    for name, kind in (("logo_url", "logo"), ("logo_dark_url", "logo_dark"), ("icon_url", "icon")):
        assert brand[name].startswith(f"/api/v1/public/companies/nova-labs/brand/{kind}.png?v=")
    assert str(company.id) not in json.dumps(body)
    # The same brand, byte for byte, as the company's people and the platform owner read.
    assert signed_in(make_client, user).get("/auth/me").json()["company"]["brand"] == brand
    assert platform.get(f"/platform/companies/{company.id}/brand").json() == brand
    # Another company's identity is its own.
    assert make_client().get(_public(world.a.company.slug)).json()["brand"] == no_brand()


def test_the_identity_changes_its_entity_tag_when_anything_of_it_changes(
    make_client, world: World, platform: PlatformApi
) -> None:
    slug, company = world.a.company.slug, world.a.company.id
    client = make_client()
    tags = [client.get(_public(slug)).headers["ETag"]]
    platform.patch(f"/platform/companies/{company}/brand", json={"color": VIOLET})
    tags.append(client.get(_public(slug)).headers["ETag"])
    platform.put(
        f"/platform/companies/{company}/brand/assets/logo",
        content=SAMPLE_LOGO,
        headers={"Content-Type": "image/png"},
    )
    tags.append(client.get(_public(slug)).headers["ETag"])
    platform.patch(f"/platform/companies/{company}", json={"name": "Alpha Group", "name_ar": "ألفا"})
    tags.append(client.get(_public(slug)).headers["ETag"])
    assert len(set(tags)) == 4
    # Unchanged, it is the same tag again.
    assert client.get(_public(slug)).headers["ETag"] == tags[-1]
    assert client.get(_public(slug)).json()["name_ar"] == "ألفا"


# ---- one 404 ---------------------------------------------------------------------------------------


def _not_found(response: httpx.Response) -> dict:
    """The 404 of the public endpoints, reduced to what must be identical between any two of them."""
    assert response.status_code == 404, response.text
    assert response.headers["Cache-Control"] == "no-store"  # never kept: the company may exist tomorrow
    assert "ETag" not in response.headers
    _assert_api_headers(response)
    body = response.json()
    assert set(body) == {"error", "request_id"}
    headers = {
        name: value
        for name, value in response.headers.items()
        if name.lower() not in ("x-request-id", "content-length")
    }
    return {"error": body["error"], "headers": headers, "length": len(response.content)}


def test_unknown_deactivated_and_impossible_companies_are_one_and_the_same_404(
    make_client, world: World, factory: Factory, platform: PlatformApi
) -> None:
    _branded(factory, world.b.company)
    gone = world.b.company.slug
    assert make_client().get(_public(gone)).status_code == 200
    assert platform.post(f"/platform/companies/{world.b.company.id}/deactivate").status_code == 200
    client = make_client()
    for rest in ("/brand", "/manifest.webmanifest", "/brand/logo.png", "/brand/icon.png?v=0123456789abcdef"):
        answers = [
            _not_found(client.get(_public(slug, rest)))
            for slug in (
                gone,  # exists, deactivated, has every image
                "nobody-has-this-slug",
                "x" * 80,
                "Alpha",  # no slug has a capital letter, and none is folded to one that exists
                world.a.company.slug.upper(),
                "a_b",
                "-a",
                "%2e%2e",
                "x" * 81,
                "x" * 400,
                str(uuid.uuid4()),
                str(world.a.company.id),  # a company's id is not its address
            )
        ]
        assert all(answer == answers[0] for answer in answers), rest
        assert answers[0]["error"] == NOT_FOUND
    # Reactivated, it is there again.
    assert platform.post(f"/platform/companies/{world.b.company.id}/reactivate").status_code == 200
    assert client.get(_public(gone)).status_code == 200
    assert client.get(_public(gone, "/brand/logo.png")).status_code == 200


def test_a_missing_image_and_an_image_that_cannot_exist_are_the_same_404(
    make_client, world: World, factory: Factory
) -> None:
    factory.brand(world.a.company, images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    slug = world.a.company.slug
    client = make_client()
    assert client.get(_public(slug, "/brand/logo.png")).status_code == 200
    answers = [
        _not_found(client.get(_public(slug, rest)))
        for rest in (
            "/brand/logo_dark.png",  # the company has none
            "/brand/icon.png",
            "/brand/favicon.png",  # nobody has one
            "/brand/logo.svg.png",
            "/brand/LOGO.png",
            "/brand/logo.jpg",
            "/brand/logo",
            "/brand/.png",
            "/brand/logo.png/extra",
            "/brand/",
            "/unknown",
            "",
        )
    ]
    unknown_company = _not_found(client.get(_public("nobody-has-this-slug", "/brand/logo.png")))
    assert all(answer == unknown_company for answer in answers)


def test_a_slug_is_only_ever_compared(make_client, world: World, db: Session) -> None:
    """Nothing of a slug reaches a query as anything but a value, and nothing that is not a slug reaches
    the database at all."""
    client = make_client()
    for slug in (
        "' OR '1'='1",
        "a%27--",
        "%25",
        "a%00b",
        "..%2f..%2fauth%2fme",
        "a%20b",
        "%D8%B4%D8%B1%D9%83%D8%A9",
    ):
        for rest in ("/brand", "/manifest.webmanifest", "/brand/logo.png"):
            response = client.get(_public(slug, rest))
            assert response.status_code == 404, (slug, rest, response.text)
    assert db.scalar(select(func.count()).select_from(Company)) >= 2  # still there


# ---- no session ------------------------------------------------------------------------------------


def test_everyone_gets_the_same_answer_and_nobody_gets_a_cookie(
    make_client, world: World, factory: Factory, platform: PlatformApi, db: Session
) -> None:
    _branded(factory, world.a.company)
    slug = world.a.company.slug
    logo = make_client().get(_public(slug)).json()["brand"]["logo_url"]
    member = signed_in(make_client, world.a.employee)
    outsider = signed_in(make_client, world.b.admin)
    stranger = make_client()
    stale = make_client(cookies={"__Host-vms_session": "not-a-session", "__Host-vms_csrf": "x"})
    seen_before = db.scalar(
        select(UserSession.last_seen_at).where(UserSession.user_id == world.a.employee.id)
    )
    for path in (_public(slug), _public(slug, "/manifest.webmanifest"), logo):
        answers = [
            client.get(path) for client in (stranger, member.client, outsider.client, platform.client, stale)
        ]
        for response in answers:
            assert response.status_code == 200
            assert "Set-Cookie" not in response.headers
        assert len({response.content for response in answers}) == 1, path
        assert len({response.headers["ETag"] for response in answers}) == 1
        assert len({response.headers["Cache-Control"] for response in answers}) == 1
    # No session was read or kept alive by it, and nothing was audited.
    db.expire_all()
    seen_after = db.scalar(select(UserSession.last_seen_at).where(UserSession.user_id == world.a.employee.id))
    assert seen_after == seen_before
    assert stranger.cookies.jar.__len__() == 0


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_the_public_endpoints_only_answer_reads(make_client, world: World, method: str) -> None:
    for rest in ("/brand", "/brand/logo.png", "/manifest.webmanifest"):
        response = make_client().request(method, _public(world.a.company.slug, rest))
        assert response.status_code == 405 and error_code(response) == "METHOD_NOT_ALLOWED", rest
        assert response.headers["Cache-Control"] == "no-store"


def test_reading_an_identity_leaves_no_trace_in_the_audit_trails(
    make_client, world: World, factory: Factory, db: Session
) -> None:
    _branded(factory, world.a.company)
    before = db.scalar(select(func.max(AuditLog.seq)))
    client = make_client()
    for path in (
        _public(world.a.company.slug),
        _public(world.a.company.slug, "/brand/logo.png"),
        _public(world.a.company.slug, "/manifest.webmanifest"),
        _public("nobody-has-this-slug"),
        _public("nobody-has-this-slug", "/brand/logo.png"),
    ):
        client.get(path)
    db.expire_all()
    assert db.scalar(select(func.max(AuditLog.seq))) == before
    assert platform_audit_rows(db, "ACCESS_DENIED") == []


# ---- the images ------------------------------------------------------------------------------------


def test_an_image_under_its_current_address_may_be_kept_for_a_year(
    make_client, world: World, factory: Factory
) -> None:
    _branded(factory, world.a.company)
    slug = world.a.company.slug
    client = make_client()
    brand = client.get(_public(slug)).json()["brand"]
    for name, data in (
        ("logo_url", SAMPLE_LOGO),
        ("logo_dark_url", make_png(240, 80, fill=0xEE)),
        ("icon_url", SAMPLE_ICON),
    ):
        response = client.get(brand[name])
        assert response.status_code == 200 and response.content == data
        assert response.headers["Content-Type"] == "image/png"  # exactly: no parameter, no guess
        assert response.headers["Content-Length"] == str(len(data))
        assert response.headers["Cache-Control"] == IMMUTABLE
        assert response.headers["ETag"] == _etag(data)
        # Opened directly, it runs and loads nothing and cannot be framed.
        assert response.headers["Content-Security-Policy"] == IMAGE_POLICY
        assert "Content-Disposition" not in response.headers
        _assert_api_headers(response)


def test_an_image_under_any_other_address_is_kept_for_a_minute(
    make_client, world: World, factory: Factory
) -> None:
    """Without a version, with an older one or with one somebody made up, the answer is the current
    image, briefly: an address that might show other bytes tomorrow is never kept for long, so nobody can
    pin a wrong image in a cache by asking for an address first."""
    factory.brand(world.a.company, images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    slug = world.a.company.slug
    client = make_client()
    current = client.get(_public(slug)).json()["brand"]["logo_url"]
    version = current.rpartition("=")[2]
    for query in (
        "",
        "?v=",
        "?v=0000000000000000",
        f"?v={version[:-1]}",
        f"?v={version}0",
        f"?v={version.upper()}x",
    ):
        response = client.get(_public(slug, "/brand/logo.png") + query)
        assert response.status_code == 200 and response.content == SAMPLE_LOGO, query
        assert response.headers["Cache-Control"] == A_MINUTE, query
        assert response.headers["ETag"] == _etag(SAMPLE_LOGO)
    assert client.get(current).headers["Cache-Control"] == IMMUTABLE


def test_a_new_image_has_a_new_address_and_the_old_address_stops_being_kept(
    make_client, world: World, platform: PlatformApi
) -> None:
    slug, company = world.a.company.slug, world.a.company.id
    upload = f"/platform/companies/{company}/brand/assets/logo"
    first = platform.put(upload, content=SAMPLE_LOGO, headers={"Content-Type": "image/png"}).json()
    client = make_client()
    old = client.get(first["logo_url"])
    assert old.headers["Cache-Control"] == IMMUTABLE and old.content == SAMPLE_LOGO
    other = make_png(240, 80, fill=0x11)
    second = platform.put(upload, content=other, headers={"Content-Type": "image/png"}).json()
    assert second["logo_url"] != first["logo_url"]
    assert client.get(_public(slug)).json()["brand"]["logo_url"] == second["logo_url"]
    new = client.get(second["logo_url"])
    assert new.content == other and new.headers["Cache-Control"] == IMMUTABLE
    # The old address now shows the new image (a copy still held somewhere shows the old one until it
    # is asked for again), for a minute at a time, and the old entity tag no longer matches.
    again = client.get(first["logo_url"], headers={"If-None-Match": old.headers["ETag"]})
    assert again.status_code == 200 and again.content == other
    assert again.headers["Cache-Control"] == A_MINUTE and again.headers["ETag"] == _etag(other)


def test_the_image_endpoint_takes_its_version_and_nothing_else(
    make_client, world: World, factory: Factory
) -> None:
    factory.brand(world.a.company, images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    path = _public(world.a.company.slug, "/brand/logo.png")
    client = make_client()
    for query in ("?x=1", "?v=1&cache=bust", "?V=1", "?v=" + "x" * 65):
        response = client.get(path + query)
        assert response.status_code == 422 and error_code(response) == "VALIDATION_ERROR", query
        assert response.headers["Cache-Control"] == "no-store"
    assert client.get(path + "?v=" + "x" * 64).status_code == 200


# ---- entity tags -----------------------------------------------------------------------------------


def test_a_client_that_has_the_answer_is_told_so(make_client, world: World, factory: Factory) -> None:
    _branded(factory, world.a.company)
    slug = world.a.company.slug
    client = make_client()
    logo = client.get(_public(slug)).json()["brand"]["logo_url"]
    for path in (
        logo,
        _public(slug, "/brand/logo.png"),
        _public(slug),
        _public(slug, "/manifest.webmanifest"),
    ):
        full = client.get(path)
        tag = full.headers["ETag"]
        assert tag == _etag(full.content)
        for header in (tag, f"W/{tag}", f'"something-else", {tag}', "*"):
            response = client.get(path, headers={"If-None-Match": header})
            assert response.status_code == 304, (path, header)
            assert response.content == b""
            # A 304 carries what the 200 would: the tag and the caching rule (RFC 9110 §15.4.5).
            assert response.headers["ETag"] == tag
            assert response.headers["Cache-Control"] == full.headers["Cache-Control"]
            assert "Set-Cookie" not in response.headers
            assert response.headers["X-Content-Type-Options"] == "nosniff"
        for header in ('"something-else"', tag.strip('"'), tag[:-2] + '"', f'W/"{tag}"', ""):
            response = client.get(path, headers={"If-None-Match": header})
            assert response.status_code == 200 and response.content == full.content, (path, header)


def test_a_304_is_never_the_answer_for_what_is_not_there(make_client, world: World) -> None:
    client = make_client()
    for path in (_public("nobody-has-this-slug"), _public(world.a.company.slug, "/brand/logo.png")):
        response = client.get(path, headers={"If-None-Match": "*"})
        assert response.status_code == 404 and response.json()["error"] == NOT_FOUND


# ---- the manifest ----------------------------------------------------------------------------------


def test_the_manifest_of_a_branded_company(make_client, factory: Factory, db: Session) -> None:
    company = factory.company("Nova Labs", name_ar="نوفا لابز", default_language="ar", slug="nova-labs")
    _branded(factory, company)
    response = make_client().get(_public("nova-labs", "/manifest.webmanifest"))
    assert response.status_code == 200, response.text
    assert response.headers["Content-Type"] == "application/manifest+json"
    assert response.headers["Cache-Control"] == "no-cache"
    assert response.headers["ETag"] == _etag(response.content)
    _assert_api_headers(response)
    manifest = response.json()
    images = CompanyBrandRepository(db).images(company.id)
    assert manifest == web_app_manifest(company, brand_of(company, images), images)
    palette = derive_palette(VIOLET)
    assert (manifest["name"], manifest["short_name"], manifest["lang"], manifest["dir"]) == (
        "نوفا لابز",
        "نوفا لابز",
        "ar",
        "rtl",
    )
    assert (manifest["id"], manifest["start_url"], manifest["scope"]) == ("/c/nova-labs", "/c/nova-labs", "/")
    assert (manifest["theme_color"], manifest["background_color"]) == (palette.surface, palette.tint)
    [icon] = manifest["icons"]
    assert icon == {
        "src": make_client().get(_public("nova-labs")).json()["brand"]["icon_url"],
        "sizes": "192x192",
        "type": "image/png",
        "purpose": "any",
    }
    assert make_client().get(icon["src"]).content == SAMPLE_ICON
    # Written as it is read: Arabic as Arabic, not as escapes.
    assert "نوفا لابز".encode() in response.content
    for word in ("Mawdoo3", "موضوع", "Visitors"):
        assert word not in response.text


def test_the_manifest_of_a_light_company_with_a_long_name(make_client, factory: Factory) -> None:
    """The colour of its shell is its own colour (B12-21), and the name under its icon is a short one
    (B12-25); the full name is still there."""
    name = "International Company for Advanced Technological Solutions and Integrated Digital Services"
    name_ar = "الشركة العالمية للحلول التقنية المتقدمة والخدمات الرقمية المتكاملة المحدودة"
    company = factory.company(name, name_ar=name_ar, default_language="ar", slug="long-name")
    factory.brand(company, color="#f5b800")
    manifest = make_client().get(_public("long-name", "/manifest.webmanifest")).json()
    assert (manifest["name"], manifest["short_name"]) == (name_ar, "الشركة")
    assert (manifest["theme_color"], manifest["background_color"]) == ("#f5b800", "#f9f2e2")
    palette = make_client().get(_public("long-name")).json()["brand"]["palette"]
    assert (palette["surface"], palette["on_surface"], palette["surface_hover"]) == (
        "#f5b800",
        "#1c262b",
        "#daa300",
    )
    assert palette["strong"] == "#8e6900"  # the colour of text and links on white, as before


def test_the_manifest_of_a_company_without_a_brand(make_client, world: World) -> None:
    manifest = make_client().get(_public(world.a.company.slug, "/manifest.webmanifest")).json()
    assert manifest["name"] == manifest["short_name"] == "Alpha"
    assert (manifest["lang"], manifest["dir"]) == ("en", "ltr")
    assert (manifest["theme_color"], manifest["background_color"]) == ("#188086", "#f1f1f1")
    assert manifest["icons"] == []
    assert manifest["start_url"] == f"/c/{world.a.company.slug}"


# ---- the budget --------------------------------------------------------------------------------------


def test_every_public_request_counts_in_the_client_s_budget(
    app: FastAPI, make_client, world: World, factory: Factory, db: Session
) -> None:
    """Whatever is asked for and whatever the answer: found, not found, not modified, refused. So the
    budget bounds probing for companies as much as it bounds load."""
    factory.brand(world.a.company, images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    slug = world.a.company.slug
    client = make_client()
    tag = _etag(SAMPLE_LOGO)
    with rate_limits(app, public_brand_ip=6):
        assert client.get(_public(slug)).status_code == 200
        assert client.get(_public("nobody-has-this-slug")).status_code == 404
        assert client.get(_public(slug, "/brand/logo.png"), headers={"If-None-Match": tag}).status_code == 304
        assert client.get(_public(slug, "/brand/favicon.png")).status_code == 404
        assert client.get(_public(slug, "/brand/logo.png?x=1")).status_code == 422
        assert client.get(_public(slug, "/manifest.webmanifest")).status_code == 200
        for path in (_public(slug), _public("nobody-has-this-slug"), _public(slug, "/brand/logo.png")):
            blocked = client.get(path)
            assert blocked.status_code == 429 and error_code(blocked) == "RATE_LIMITED"
            assert int(blocked.headers["Retry-After"]) >= 1
            assert blocked.headers["Cache-Control"] == "no-store"
        # A signed-in person shares the address's budget: the endpoints know no session.
        assert signed_in(make_client, world.a.employee).client.get(_public(slug)).status_code == 429
        # Another address has its own.
        assert make_client(client=("198.51.100.77", 40000)).get(_public(slug)).status_code == 200
    [row] = audit_rows(db, "RATE_LIMITED")  # coalesced into one row, which names the route, never the slug
    assert row.meta["policy"] == "public_brand_ip" and row.company_id is None and row.actor_user_id is None
    assert row.meta["route"].startswith("/api/v1/public/companies/{slug}")
    assert slug not in json.dumps(row.meta)


def test_addresses_of_one_ipv6_site_share_a_budget(
    app: FastAPI, make_client, world: World, db: Session
) -> None:
    slug = world.a.company.slug
    with rate_limits(app, public_brand_prefix=5):
        for network in range(5):
            response = make_client(client=(f"2001:db8:5:{network}::1", 40000)).get(_public(slug))
            assert response.status_code == 200
        blocked = make_client(client=("2001:db8:5:ffff::9", 40000)).get(_public(f"guess-{uuid.uuid4().hex}"))
        assert blocked.status_code == 429 and error_code(blocked) == "RATE_LIMITED"
        assert make_client(client=("2001:db8:6::1", 40000)).get(_public(slug)).status_code == 200
        assert make_client(client=("198.51.100.78", 40000)).get(_public(slug)).status_code == 200
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "public_brand_prefix"


def test_the_public_budget_is_separate_from_the_sign_in_budgets(
    app: FastAPI, make_client, world: World
) -> None:
    """Loading a company's sign-in page many times does not lock anybody out of signing in, and the
    other way round."""
    slug = world.a.company.slug
    client = make_client()
    with rate_limits(app, public_brand_ip=2):
        assert [client.get(_public(slug)).status_code for _ in range(3)] == [200, 200, 429]
        assert signed_in(make_client, world.a.employee).get("/auth/me").status_code == 200
