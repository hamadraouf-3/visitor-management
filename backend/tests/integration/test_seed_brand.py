"""The demo company's brand in the seeds (Phase 12, B12-15): `seed-demo` and `seed-e2e` give the demo
company the Mawdoo3 identity as a tenant's own (logo, dark-surface logo, icon, colour) and leave the second
tenant without one; a re-run changes nothing; and a seed never overrides a person, here the platform owner."""

import hashlib
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import cli
from app.core import time as app_time
from app.core.config import Settings
from app.core.palette import derive_palette
from app.core.png import sanitize_png
from app.email.logos import dark_rendition, light_rendition
from app.email.providers.memory import MemoryProvider
from app.models import BrandAssetKind, Company, CompanyBrandAsset, PlatformAdmin
from app.repositories.brand import CompanyBrandRepository
from app.security.passwords import PasswordHasherService
from app.services.brand import IMAGE_LIMITS
from app.services.seeding import (
    DEFAULT_DEMO_PASSWORD,
    DEMO_COMPANY,
    MAWDOO3_BRAND,
    OTHER_CORP,
    seed_id,
    seed_image,
)
from tests.conftest import TEST_START
from tests.support import (
    Api,
    Factory,
    PlatformApi,
    audit_rows,
    create_visit,
    no_brand,
    platform_signed_in,
    refreshed,
)

ACTION = "COMPANY_BRAND_UPDATED"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEMO = seed_id(DEMO_COMPANY.slug)
SIZES = {"logo": (462, 149), "logo_dark": (462, 149), "icon": (512, 512)}
PNG = {"Content-Type": "image/png"}


@pytest.fixture(autouse=True)
def _fast_hashing(monkeypatch: pytest.MonkeyPatch, hasher: PasswordHasherService) -> None:
    monkeypatch.setattr(cli, "PasswordHasherService", lambda **_kwargs: hasher)


@pytest.fixture
def platform(make_client, factory: Factory) -> PlatformApi:
    owner: PlatformAdmin = factory.platform_admin(email="owner@platform.test")
    return platform_signed_in(make_client, owner)


def _images(db: Session, company_id) -> dict[str, tuple]:
    db.expire_all()
    rows = db.execute(
        select(
            CompanyBrandAsset.kind,
            CompanyBrandAsset.content,
            CompanyBrandAsset.width,
            CompanyBrandAsset.height,
            CompanyBrandAsset.sha256,
            CompanyBrandAsset.version,
        ).where(CompanyBrandAsset.company_id == company_id, CompanyBrandAsset.content.is_not(None))
    )
    return {row[0]: tuple(row[1:]) for row in rows}


def _signed_in(make_client, email: str) -> Api:
    api = Api(make_client())
    login = api.login(email, DEFAULT_DEMO_PASSWORD)
    assert login.status_code == 200, login.text
    return api


# ---- the packaged images ---------------------------------------------------------------------------------


def test_the_packaged_images_are_files_the_api_would_store_as_they_are() -> None:
    """Each seed image passes the check of an upload unchanged: what the seed stores is byte for byte
    what the platform owner's upload of the same file would store."""
    assert MAWDOO3_BRAND.color == "#188086"
    assert {kind.value for kind in MAWDOO3_BRAND.images} == {"logo", "logo_dark", "icon"}
    for kind, name in MAWDOO3_BRAND.images.items():
        data = seed_image(name)
        checked = sanitize_png(data, IMAGE_LIMITS[kind])
        assert checked.data == data, name
        assert (checked.width, checked.height) == SIZES[kind.value]
        assert len(data) < 64 * 1024  # small enough to travel in every e-mail


def test_the_packaged_images_are_the_web_application_s_own_brand_files() -> None:
    """scripts/demo_brand.py writes them from frontend/public; `--check` fails when one is stale."""
    if not (REPO_ROOT / "frontend" / "public" / "brand" / "logo-teal.png").is_file():
        pytest.skip("the web application's sources are not in this tree")
    result = subprocess.run(  # noqa: S603 - our own script, with the running interpreter
        [sys.executable, str(REPO_ROOT / "scripts" / "demo_brand.py"), "--check"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr


# ---- seeding ---------------------------------------------------------------------------------------------


def test_seed_demo_gives_the_demo_company_its_brand_once(db: Session, settings: Settings, capsys) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert f"companies branded:   {DEMO_COMPANY.slug}" in capsys.readouterr().out
    company = refreshed(db, Company, DEMO)
    assert company.brand_color == "#188086"
    stored = _images(db, DEMO)
    assert set(stored) == {"logo", "logo_dark", "icon"}
    for kind, name in MAWDOO3_BRAND.images.items():
        content, width, height, sha256, version = stored[kind.value]
        assert content == seed_image(name)
        assert (width, height) == SIZES[kind.value]
        assert sha256 == hashlib.sha256(content).hexdigest() and len(version) == 16
    [row] = audit_rows(db, ACTION, company_id=DEMO)
    assert row.actor_user_id is None and row.entity_id == DEMO
    assert row.meta == {"changed_fields": ["logo", "logo_dark", "icon", "color"], "source": "seed"}

    # A re-run stores nothing again: the same versions (so the same addresses), nothing audited.
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert "companies branded" not in capsys.readouterr().out
    assert _images(db, DEMO) == stored
    assert len(audit_rows(db, ACTION)) == 1


def test_seed_e2e_brands_the_demo_company_and_leaves_the_second_tenant_plain(
    db: Session, settings: Settings, make_client, capsys
) -> None:
    assert cli.main(["seed-e2e"], settings=settings) == 0
    assert f"companies branded:   {DEMO_COMPANY.slug}\n" in capsys.readouterr().out
    other = seed_id(OTHER_CORP.slug)
    assert refreshed(db, Company, other).brand_color is None and _images(db, other) == {}
    assert audit_rows(db, ACTION, company_id=other) == []
    assert set(_images(db, DEMO)) == {"logo", "logo_dark", "icon"}

    # What the sign-in pages of the two companies read.
    client = make_client()
    plain = client.get(f"/api/v1/public/companies/{OTHER_CORP.slug}/brand").json()
    assert (plain["name"], plain["name_ar"], plain["default_language"]) == ("Other Corp", None, "en")
    assert plain["brand"] == no_brand()
    demo = client.get(f"/api/v1/public/companies/{DEMO_COMPANY.slug}/brand").json()
    assert (demo["name"], demo["name_ar"], demo["default_language"]) == ("Mawdoo3", "موضوع", "ar")
    brand = demo["brand"]
    assert brand["color"] == "#188086" and brand["palette"] == derive_palette("#188086").as_dict()
    assert brand["palette"]["strong"] == "#188086"  # white already reads on the brand's teal
    for field, name in (
        ("logo_url", "logo.png"),
        ("logo_dark_url", "logo_dark.png"),
        ("icon_url", "icon.png"),
    ):
        response = client.get(brand[field])
        assert response.status_code == 200 and response.content == seed_image(name)
        assert response.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    manifest = client.get(f"/api/v1/public/companies/{DEMO_COMPANY.slug}/manifest.webmanifest").json()
    assert manifest["name"] == "موضوع" and manifest["start_url"] == "/c/demo-company"
    assert manifest["icons"] == [
        {"src": brand["icon_url"], "sizes": "512x512", "type": "image/png", "purpose": "any"}
    ]
    assert (
        client.get(f"/api/v1/public/companies/{OTHER_CORP.slug}/manifest.webmanifest").json()["icons"] == []
    )
    # ... and what their people read once signed in.
    assert _signed_in(make_client, "host@demo.local").get("/auth/me").json()["company"]["brand"] == brand
    assert (
        _signed_in(make_client, "host@other.local").get("/auth/me").json()["company"]["brand"] == no_brand()
    )

    # Re-running either seed changes nothing.
    assert cli.main(["seed-e2e"], settings=settings) == 0
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert "companies branded" not in capsys.readouterr().out
    assert client.get(f"/api/v1/public/companies/{DEMO_COMPANY.slug}/brand").json()["brand"] == brand
    assert len(audit_rows(db, ACTION)) == 1


def test_the_demo_company_s_e_mails_carry_its_brand(
    db: Session, settings: Settings, make_client, email_provider: MemoryProvider
) -> None:
    assert cli.main(["seed-e2e"], settings=settings) == 0
    host = _signed_in(make_client, "host@demo.local")
    me = host.get("/auth/me").json()
    create_visit(host, me["user"]["id"], TEST_START.replace(hour=12), send_invitation=True)
    invitation = email_provider.sent[-1]
    # The demo's two logos, as e-mails send them since Phase 13 (B13-2): the light rendition, and the
    # one for the dark design.
    assert {image.content_id: image.content for image in invitation.inline_images} == {
        "visitor-pass-qr": invitation.inline_images[0].content,
        "brand-logo": light_rendition(seed_image("logo.png")).content,
        "brand-logo-dark": dark_rendition(seed_image("logo_dark.png")).content,
    }
    assert invitation.sender == '"موضوع" <no-reply@localhost>'
    assert "Mawdoo3 Visitors" not in invitation.html and "زوار موضوع" not in invitation.html
    other = _signed_in(make_client, "host@other.local")
    create_visit(
        other, other.get("/auth/me").json()["user"]["id"], TEST_START.replace(hour=12), send_invitation=True
    )
    plain = email_provider.sent[-1]
    assert [image.content_id for image in plain.inline_images] == ["visitor-pass-qr"]
    assert plain.sender == '"Other Corp" <no-reply@localhost>'


# ---- a seed never overrides a person (B10-15) --------------------------------------------------------------


def test_a_demo_company_from_before_phase_12_gets_the_brand(db: Session, settings: Settings) -> None:
    db.add(Company(id=DEMO, slug=DEMO_COMPANY.slug, name="Mawdoo3", name_ar="موضوع", timezone="Asia/Amman"))
    db.commit()
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert refreshed(db, Company, DEMO).brand_color == "#188086"
    assert set(_images(db, DEMO)) == {"logo", "logo_dark", "icon"}


def test_a_demo_company_still_carrying_the_former_name_is_renamed_and_branded(
    db: Session, settings: Settings
) -> None:
    db.add(Company(id=DEMO, slug=DEMO_COMPANY.slug, name="Demo Company", timezone="Asia/Amman"))
    db.commit()
    assert cli.main(["seed-demo"], settings=settings) == 0
    company = refreshed(db, Company, DEMO)
    assert (company.name, company.name_ar, company.brand_color) == ("Mawdoo3", "موضوع", "#188086")
    assert set(_images(db, DEMO)) == {"logo", "logo_dark", "icon"}


def test_a_company_someone_renamed_is_not_given_the_demo_brand(db: Session, settings: Settings) -> None:
    """It carries the demo's slug, but it is no longer the demo of this brand: another company's logo
    over its own name would be wrong on every page and in every e-mail."""
    db.add(
        Company(
            id=DEMO,
            slug=DEMO_COMPANY.slug,
            name="Acme Jordan",
            name_ar="أكمي الأردن",
            timezone="Asia/Amman",
            default_language="en",
        )
    )
    db.commit()
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert cli.main(["seed-e2e"], settings=settings) == 0
    assert refreshed(db, Company, DEMO).brand_color is None
    assert _images(db, DEMO) == {} and audit_rows(db, ACTION) == []


def test_a_seed_never_changes_a_brand_the_platform_owner_changed(
    db: Session, settings: Settings, platform: PlatformApi, capsys
) -> None:
    assert cli.main(["seed-demo"], settings=settings) == 0
    seeded = _images(db, DEMO)
    base = f"/platform/companies/{DEMO}/brand"
    # The platform owner gives the company another colour and takes its dark-surface logo away.
    assert platform.patch(base, json={"color": "#7c3aed"}).status_code == 200
    assert platform.delete(f"{base}/assets/logo_dark").status_code == 200
    capsys.readouterr()

    for command in ("seed-demo", "seed-e2e", "seed-demo"):
        assert cli.main([command], settings=settings) == 0
    assert "companies branded" not in capsys.readouterr().out
    assert refreshed(db, Company, DEMO).brand_color == "#7c3aed"
    assert _images(db, DEMO) == {kind: seeded[kind] for kind in ("logo", "icon")}
    rows = audit_rows(db, ACTION, company_id=DEMO)
    assert [row.meta.get("source") for row in rows] == ["seed", "platform", "platform"]

    # Even back at the seed's own values, the brand stays the platform owner's to decide.
    assert platform.patch(base, json={"color": None}).status_code == 200
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert refreshed(db, Company, DEMO).brand_color is None
    assert "logo_dark" not in _images(db, DEMO)


def test_a_brand_the_platform_owner_set_first_is_not_completed_by_a_seed(
    db: Session, settings: Settings, platform: PlatformApi
) -> None:
    db.add(Company(id=DEMO, slug=DEMO_COMPANY.slug, name="Mawdoo3", name_ar="موضوع", timezone="Asia/Amman"))
    db.commit()
    assert platform.patch(f"/platform/companies/{DEMO}/brand", json={"color": "#7c3aed"}).status_code == 200
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert refreshed(db, Company, DEMO).brand_color == "#7c3aed"
    assert _images(db, DEMO) == {}  # no logo was asked for: none is given


def test_a_seed_completes_its_own_unfinished_brand(db: Session, settings: Settings, capsys) -> None:
    """What only a seed ever wrote, a seed may complete: an image that is missing (an interrupted run, or
    a seed image added by a later version) is stored, and only that."""
    assert cli.main(["seed-demo"], settings=settings) == 0
    seeded = _images(db, DEMO)
    CompanyBrandRepository(db).clear(DEMO, BrandAssetKind.ICON, now=app_time.now())
    db.commit()
    capsys.readouterr()
    assert cli.main(["seed-demo"], settings=settings) == 0
    assert f"companies branded:   {DEMO_COMPANY.slug}" in capsys.readouterr().out
    completed = _images(db, DEMO)
    assert completed["logo"] == seeded["logo"] and completed["logo_dark"] == seeded["logo_dark"]
    assert completed["icon"][:4] == seeded["icon"][:4] and completed["icon"][4] != seeded["icon"][4]
    assert audit_rows(db, ACTION)[-1].meta == {"changed_fields": ["icon"], "source": "seed"}
