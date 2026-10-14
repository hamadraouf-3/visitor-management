"""A company's identity in isolation (Phase 12): the addresses of its images, the version of a brand, the
entity tags of the public answers, the web app manifest, the schemas of a colour, and the settings."""

import hashlib
import json
import re
import threading
import time
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from app.core.config import GUESSING_LIMITS, Settings
from app.core.errors import AppError, PayloadTooLarge, ServiceBusy, ValidationFailed
from app.core.field_errors import FieldValueError
from app.core.middleware import is_api_path
from app.core.palette import ALGORITHM, derive_palette
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
from app.core.rate_limit import BucketScope, RatePolicies
from app.core.routing import PUBLIC_PREFIX, is_platform_path, is_public_path
from app.core.text import is_company_slug
from app.models import BrandAssetKind, Company
from app.models.brand import BRAND_ASSET_MAX_BYTES
from app.repositories.brand import BrandImageInfo
from app.schemas.brand import BrandImageQuery, BrandPaletteRequest, CompanyBrandUpdate
from app.services import brand as brand_module
from app.services.brand import (
    CACHE_CURRENT_VERSION,
    CACHE_OTHER_VERSION,
    CACHE_REVALIDATE,
    DEFAULT_BACKGROUND_COLOR,
    DEFAULT_THEME_COLOR,
    IMAGE_CHECK_CONCURRENCY,
    IMAGE_LIMITS,
    SHORT_NAME_MAX_LENGTH,
    brand_of,
    brand_version,
    checked_image,
    etag_matches,
    etag_of,
    image_problem,
    image_url,
    new_image_version,
    short_name,
    web_app_manifest,
)
from tests.png_support import SAMPLE_LOGO, assemble, chunk, header, make_png
from tests.unit.test_config import PRODUCTION, make

HEX16 = re.compile(r"[0-9a-f]{16}")


def _company(**changes) -> Company:
    values = {
        "id": uuid.uuid4(),
        "name": "Acme Holding",
        "name_ar": "أكمي القابضة",
        "slug": "acme",
        "timezone": "Asia/Amman",
        "default_language": "en",
    }
    values.update(changes)
    return Company(**values)


def _image(kind: BrandAssetKind, version: str = "0123456789abcdef", side: int = 256) -> BrandImageInfo:
    return BrandImageInfo(
        kind=kind, version=version, sha256="ab" * 32, byte_size=1234, width=side, height=side
    )


# ---- addresses and versions ------------------------------------------------------------------------


def test_an_image_s_address_is_a_same_origin_path_with_its_version() -> None:
    assert image_url("acme", _image(BrandAssetKind.LOGO)) == (
        "/api/v1/public/companies/acme/brand/logo.png?v=0123456789abcdef"
    )
    assert image_url("acme", _image(BrandAssetKind.LOGO_DARK)).startswith(
        "/api/v1/public/companies/acme/brand/logo_dark.png?v="
    )
    assert image_url("acme", _image(BrandAssetKind.ICON)).startswith(
        "/api/v1/public/companies/acme/brand/icon.png?v="
    )


@pytest.mark.parametrize(
    "slug", ["a/b", "../login", "a?b", "a#b", "a b", "//evil.test", "a%2f", 'a"onload="x', "شركة"]
)
def test_no_slug_can_make_an_image_s_address_point_elsewhere(slug: str) -> None:
    """A slug is letters, digits and hyphens (the database and the API hold it to that); whatever else
    a row might carry cannot become a second path segment, a query, a host or an attribute."""
    url = image_url(slug, _image(BrandAssetKind.LOGO))
    assert url.startswith(f"{PUBLIC_PREFIX}/companies/") and url.endswith(
        "/brand/logo.png?v=0123456789abcdef"
    )
    middle = url.removeprefix(f"{PUBLIC_PREFIX}/companies/").removesuffix(
        "/brand/logo.png?v=0123456789abcdef"
    )
    assert re.fullmatch(r"[A-Za-z0-9%._~-]+", middle), middle
    assert url.isascii() and url.count("?") == 1 and "#" not in url and '"' not in url


def test_an_upload_s_version_is_sixteen_random_hex_digits() -> None:
    versions = {new_image_version() for _ in range(200)}
    assert len(versions) == 200 and all(HEX16.fullmatch(version) for version in versions)


def test_a_brand_s_version_changes_with_every_part_of_it() -> None:
    logo, icon = _image(BrandAssetKind.LOGO), _image(BrandAssetKind.ICON)
    nothing = brand_version(None, {})
    variants = [
        nothing,
        brand_version("#188086", {}),
        brand_version("#188087", {}),
        brand_version(None, {BrandAssetKind.LOGO: logo}),
        brand_version(None, {BrandAssetKind.LOGO: _image(BrandAssetKind.LOGO, "f" * 16)}),
        # The same image under another name is another brand.
        brand_version(None, {BrandAssetKind.LOGO_DARK: _image(BrandAssetKind.LOGO_DARK)}),
        brand_version(None, {BrandAssetKind.ICON: icon}),
        brand_version("#188086", {BrandAssetKind.LOGO: logo, BrandAssetKind.ICON: icon}),
    ]
    assert len(set(variants)) == len(variants)
    assert all(HEX16.fullmatch(version) for version in variants)
    # ... and with nothing else: the same parts give the same version, in any order.
    assert brand_version("#188086", {BrandAssetKind.ICON: icon, BrandAssetKind.LOGO: logo}) == variants[-1]
    assert nothing == hashlib.sha256(f"{ALGORITHM}|-|logo=-|logo_dark=-|icon=-".encode()).hexdigest()[:16]


def test_a_brand_is_its_addresses_its_colour_and_the_palette_of_that_colour() -> None:
    company = _company(brand_color="#7c3aed")
    images = {
        BrandAssetKind.LOGO: _image(BrandAssetKind.LOGO),
        BrandAssetKind.ICON: _image(BrandAssetKind.ICON),
    }
    brand = brand_of(company, images)
    assert brand.logo_url == "/api/v1/public/companies/acme/brand/logo.png?v=0123456789abcdef"
    assert brand.logo_dark_url is None
    assert brand.icon_url == "/api/v1/public/companies/acme/brand/icon.png?v=0123456789abcdef"
    assert brand.color == "#7c3aed"
    assert brand.palette is not None and brand.palette.model_dump() == derive_palette("#7c3aed").as_dict()
    assert brand.version == brand_version("#7c3aed", images)

    plain = brand_of(_company(), {})
    assert plain.model_dump() == {
        "logo_url": None,
        "logo_dark_url": None,
        "icon_url": None,
        "color": None,
        "palette": None,
        "version": brand_version(None, {}),
    }


# ---- entity tags ------------------------------------------------------------------------------------

TAG = etag_of(b"the bytes")


def test_an_entity_tag_is_the_quoted_hash_of_the_bytes() -> None:
    assert f'"{hashlib.sha256(b"the bytes").hexdigest()}"' == TAG
    assert etag_of(b"other bytes") != TAG


@pytest.mark.parametrize(
    "header",
    [
        TAG,
        f"W/{TAG}",  # compared weakly (RFC 9110 §13.1.2)
        f'"other", {TAG}',
        f'"other",{TAG}',
        f'  "other" ,   W/{TAG}  ',
        "*",
        f'"a", *, {TAG}',
    ],
)
def test_if_none_match_naming_the_tag_matches(header: str) -> None:
    assert etag_matches(header, TAG)


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        " ",
        '"other"',
        'W/"other"',
        TAG.strip('"'),  # not an entity tag without its quotes
        TAG[:-2] + '"',  # a prefix of it
        TAG.upper(),
        f"w/{TAG}",  # the weakness marker is W/, nothing else
        f"{TAG}; q=1",
        f'"{TAG}"',
        "**",
    ],
)
def test_if_none_match_naming_anything_else_does_not(header: str | None) -> None:
    assert not etag_matches(header, TAG)


def test_the_caching_rules_of_the_public_answers() -> None:
    # A year, and never asked again: only for an address that cannot show other bytes.
    assert CACHE_CURRENT_VERSION == "public, max-age=31536000, immutable"
    # Anything else is kept for a minute at most, so a wrong or old address heals by itself.
    assert CACHE_OTHER_VERSION == "public, max-age=60"
    assert CACHE_REVALIDATE == "no-cache"
    for rule in (CACHE_CURRENT_VERSION, CACHE_OTHER_VERSION, CACHE_REVALIDATE):
        assert "private" not in rule and "no-store" not in rule


# ---- the web app manifest ----------------------------------------------------------------------------


def test_the_manifest_of_a_branded_company_is_all_its_own() -> None:
    company = _company(default_language="ar", brand_color="#7c3aed", slug="acme-holding")
    images = {BrandAssetKind.ICON: _image(BrandAssetKind.ICON, side=512)}
    manifest = web_app_manifest(company, brand_of(company, images), images)
    palette = derive_palette("#7c3aed")
    assert manifest == {
        "id": "/c/acme-holding",
        "name": "أكمي القابضة",
        "short_name": "أكمي القابضة",
        "description": "تسجيل الزوار ودعواتهم واستقبالهم",
        "lang": "ar",
        "dir": "rtl",
        "start_url": "/c/acme-holding",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": palette.tint,
        "theme_color": palette.surface,
        "icons": [
            {
                "src": "/api/v1/public/companies/acme-holding/brand/icon.png?v=0123456789abcdef",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any",
            }
        ],
    }
    # Nothing in it names the product ("visitors" as a word of the description is not its name).
    text = json.dumps(manifest, ensure_ascii=False)
    for word in ("Mawdoo3", "موضوع", "Visitors", "زوار موضوع"):
        assert word not in text


def test_the_manifest_of_a_company_without_a_brand_uses_the_product_s_colours_and_no_icon() -> None:
    company = _company(name_ar=None, default_language="ar")
    manifest = web_app_manifest(company, brand_of(company, {}), {})
    assert (manifest["name"], manifest["short_name"]) == ("Acme Holding", "Acme Holding")  # its only name
    assert (manifest["lang"], manifest["dir"]) == ("ar", "rtl")
    assert manifest["theme_color"] == DEFAULT_THEME_COLOR == "#188086"
    assert manifest["background_color"] == DEFAULT_BACKGROUND_COLOR == "#f1f1f1"
    assert manifest["icons"] == []
    english = web_app_manifest(_company(), brand_of(_company(), {}), {})
    assert (english["name"], english["lang"], english["dir"]) == ("Acme Holding", "en", "ltr")
    assert english["description"] == "Visitor registration, invitations and reception check-in."


def test_the_manifest_s_theme_colour_is_the_colour_of_the_shell() -> None:
    """The installed app's title bar is the application's shell: the palette's `surface`, the company's
    own colour wherever an ink reads on it (B12-21), not the darker step white text would need."""
    for color, theme in (("#f5b800", "#f5b800"), ("#ffffff", "#ffffff"), ("#000080", "#000080")):
        company = _company(brand_color=color)
        manifest = web_app_manifest(company, brand_of(company, {}), {})
        assert manifest["theme_color"] == theme == derive_palette(color).surface
    grey = _company(brand_color="#808080")  # a mid-tone: the strong step
    assert web_app_manifest(grey, brand_of(grey, {}), {})["theme_color"] == "#6f6f6f"
    assert derive_palette("#f5b800").strong == "#8e6900"  # what the theme colour was for a yellow


LONG_NAME = "International Company for Advanced Technological Solutions and Integrated Digital Services"
LONG_NAME_AR = "الشركة العالمية للحلول التقنية المتقدمة والخدمات الرقمية المتكاملة المحدودة"


@pytest.mark.parametrize(
    ("name", "short"),
    [
        # A name of at most twelve characters is its own short name.
        ("Acme", "Acme"),
        ("Acme Holding", "Acme Holding"),
        ("أكمي القابضة", "أكمي القابضة"),
        ("  Acme   Holding ", "Acme Holding"),
        # A longer one: as many of its first words as fit.
        ("Acme Holdings", "Acme"),
        ("Nabd Medical Center", "Nabd Medical"),
        ("Sahara Sun Hotels", "Sahara Sun"),
        ("مركز نبض الطبي", "مركز نبض"),
        ("شركة النور للتجارة العامة", "شركة النور"),
        (LONG_NAME_AR, "الشركة"),
        # ... without the sign or the small word that only joined them to the rest.
        ("Marks & Spencer Group", "Marks"),
        ("Bank of America Corporation", "Bank"),
        ("Hill and Knowlton Strategies", "Hill"),
        ("Acme, Inc. (Amman)", "Acme, Inc."),
        ("Acme - Trading and Contracting", "Acme"),
        ("Acme, International Holdings", "Acme"),
        ("Al-Noor: Trading Company", "Al-Noor"),
        ("دار النشر و التوزيع المتحدة", "دار النشر"),
        # No word boundary serves: the start of the name, without an ellipsis.
        (LONG_NAME, "Internationa"),
        ("Supercalifragilistic Ltd", "Supercalifra"),
        ("The International Bank", "The Internat"),
        ("x" * 40, "x" * 12),
    ],
)
def test_a_short_name_has_at_most_twelve_characters_and_ends_between_two_words(name: str, short: str) -> None:
    assert SHORT_NAME_MAX_LENGTH == 12
    assert short_name(name) == short
    assert len(short_name(name)) <= SHORT_NAME_MAX_LENGTH
    assert "\N{HORIZONTAL ELLIPSIS}" not in short_name(name) and short_name(name) == short_name(name).strip()
    assert short_name(short_name(name)) == short_name(name)


def test_a_short_name_never_ends_inside_a_character() -> None:
    """A cut never separates an Arabic letter from its vowel signs, or the halves of an emoji."""
    vowelled = "قَدَّمَتْ الشَّرِكَةُ العَالَمِيَّةُ"
    assert short_name(vowelled) == "قَدَّمَتْ"
    # The 13th character is the vowel sign of the 12th: the letter goes with it.
    assert short_name("ابتكارالمستقَبل للتقنية") == "ابتكارالمست"
    family = "\N{MAN}\N{ZERO WIDTH JOINER}\N{WOMAN}\N{ZERO WIDTH JOINER}\N{GIRL}"
    assert short_name("Acme-Family" + family + "Holdings") == "Acme-Family"


def test_the_manifest_of_a_company_with_a_long_name_has_a_short_one() -> None:
    """The review: `short_name` was the whole name, 76 characters under a phone's icon (B12-25). The
    full name is still the manifest's `name`."""
    for language, name, short in (("en", LONG_NAME, "Internationa"), ("ar", LONG_NAME_AR, "الشركة")):
        company = _company(name=LONG_NAME, name_ar=LONG_NAME_AR, default_language=language)
        manifest = web_app_manifest(company, brand_of(company, {}), {})
        assert (manifest["name"], manifest["short_name"]) == (name, short)


def test_a_logo_is_never_a_manifest_s_icon() -> None:
    company = _company()
    images = {
        BrandAssetKind.LOGO: _image(BrandAssetKind.LOGO),
        BrandAssetKind.LOGO_DARK: _image(BrandAssetKind.LOGO_DARK),
    }
    assert web_app_manifest(company, brand_of(company, images), images)["icons"] == []


# ---- what an image may be -----------------------------------------------------------------------------


def test_the_limits_of_each_image_are_the_contract_s() -> None:
    logo, dark, icon = (IMAGE_LIMITS[kind] for kind in BrandAssetKind)
    assert logo == dark
    assert (logo.min_width, logo.min_height, logo.max_width, logo.max_height, logo.square) == (
        32,
        32,
        1200,
        600,
        False,
    )
    assert (icon.min_width, icon.min_height, icon.max_width, icon.max_height, icon.square) == (
        192,
        192,
        512,
        512,
        True,
    )
    assert logo.max_bytes == icon.max_bytes == BRAND_ASSET_MAX_BYTES == 512 * 1024


def test_a_refused_image_is_one_field_error_with_the_limits_it_missed() -> None:
    logo, icon = IMAGE_LIMITS[BrandAssetKind.LOGO], IMAGE_LIMITS[BrandAssetKind.ICON]
    small = image_problem(PngTooSmall(), icon)
    assert (small.code, small.params) == ("image_too_small", {"min_width": 192, "min_height": 192})
    large = image_problem(PngTooLarge(), logo)
    assert (large.code, large.params) == ("image_too_large", {"max_width": 1200, "max_height": 600})
    square = image_problem(PngNotSquare(), icon)
    assert (square.code, square.params) == ("image_not_square", {})
    # Every other refusal says the same and no more: what exactly is wrong with a file is nobody's hint.
    messages = set()
    for problem in PngProblem:
        if problem in (PngProblem.TOO_SMALL, PngProblem.TOO_LARGE, PngProblem.NOT_SQUARE):
            continue
        found = image_problem(PngError(problem), logo)
        assert (found.code, found.params) == ("invalid_image", {})
        messages.add(found.message)
    assert messages == {
        "Upload a valid PNG image.",
        "Upload a PNG image that is not interlaced.",
        "Upload a PNG image that is not animated.",
        "Upload a PNG image of 8 bits per channel.",  # a logo (B13-7)
    }


# ---- checking an upload: what a refusal carries, and how many at a time (B12-19) -----------------------

LOGO = IMAGE_LIMITS[BrandAssetKind.LOGO]


def _frames(error: BaseException) -> list[str]:
    """The functions `error` passed through, outermost first."""
    names = []
    traceback = error.__traceback__
    while traceback is not None:
        names.append(traceback.tb_frame.f_code.co_name)
        traceback = traceback.tb_next
    return names


def test_a_checked_upload_is_the_file_the_check_wrote() -> None:
    image = checked_image(SAMPLE_LOGO, LOGO)
    assert (image.data, image.width, image.height) == (SAMPLE_LOGO, 240, 80)


REFUSALS: dict[str, tuple[bytes, type[AppError], str | None]] = {
    "not a png": (b"not a png", ValidationFailed, "invalid_image"),
    "too small": (make_png(16, 16), ValidationFailed, "image_too_small"),
    "too large": (make_png(1201, 80), ValidationFailed, "image_too_large"),
    # Refused only after its data was inflated: the refusal that used to keep megabytes.
    "a megabyte behind a small header": (
        assemble(header(240, 80), chunk(b"IDAT", zlib.compress(bytes(1024 * 1024), 9)), chunk(b"IEND")),
        ValidationFailed,
        "invalid_image",
    ),
    "one byte above the limit": (bytes(BRAND_ASSET_MAX_BYTES + 1), PayloadTooLarge, None),
}


@pytest.mark.parametrize("name", REFUSALS)
def test_a_refusal_carries_nothing_of_the_check_that_refused_it(name: str) -> None:
    """The API's answer is raised after the handler of the check's own error, not inside it. It has no
    context and no cause, and passed through no frame of the check: nothing the check held (the upload's
    image data, what it inflated to) lives for as long as the answer does."""
    data, answer, code = REFUSALS[name]
    with pytest.raises(answer) as caught:
        checked_image(data, LOGO)
    error = caught.value
    assert error.__context__ is None and error.__cause__ is None
    assert _frames(error) == [
        test_a_refusal_carries_nothing_of_the_check_that_refused_it.__name__,
        "checked_image",
    ]
    if isinstance(error, ValidationFailed):
        assert {path: problem.code for path, problem in error.fields.items()} == {"file": code}


def test_refusals_give_their_place_back() -> None:
    """More refusals than there are places, one after the other: none waits, and a valid image is still
    checked afterwards."""
    started = time.perf_counter()
    for _ in range(IMAGE_CHECK_CONCURRENCY + 3):
        with pytest.raises(ValidationFailed):
            checked_image(b"not a png", LOGO)
    assert checked_image(SAMPLE_LOGO, LOGO).data == SAMPLE_LOGO
    assert time.perf_counter() - started < brand_module.IMAGE_CHECK_WAIT_SECONDS


def test_only_a_few_uploads_are_checked_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """A check inflates the image, 11 MiB for the largest; the requests' threads would otherwise run as
    many at once as there are threads."""
    lock = threading.Lock()
    running = most = 0

    def slow_check(data: bytes, limits: PngLimits) -> Png:
        nonlocal running, most
        with lock:
            running += 1
            most = max(most, running)
        time.sleep(0.05)
        with lock:
            running -= 1
        return sanitize_png(data, limits)

    monkeypatch.setattr(brand_module, "sanitize_png", slow_check)
    with ThreadPoolExecutor(8) as pool:
        images = list(pool.map(lambda _: checked_image(SAMPLE_LOGO, LOGO), range(8)))
    assert [image.data for image in images] == [SAMPLE_LOGO] * 8
    assert most == IMAGE_CHECK_CONCURRENCY == 2


def test_an_upload_that_finds_no_place_in_time_is_told_to_try_again(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(brand_module, "IMAGE_CHECK_WAIT_SECONDS", 0.05)
    checking = threading.Semaphore(0)
    finish = threading.Event()

    def held_check(data: bytes, limits: PngLimits) -> Png:
        checking.release()
        assert finish.wait(10)
        return sanitize_png(data, limits)

    monkeypatch.setattr(brand_module, "sanitize_png", held_check)
    with ThreadPoolExecutor(IMAGE_CHECK_CONCURRENCY + 1) as pool:
        held = [pool.submit(checked_image, SAMPLE_LOGO, LOGO) for _ in range(IMAGE_CHECK_CONCURRENCY)]
        try:
            for _ in held:
                assert checking.acquire(timeout=10)
            # In a thread of its own, so that an upload that waited without end would fail this test
            # instead of stopping the suite.
            late = pool.submit(checked_image, SAMPLE_LOGO, LOGO)
            with pytest.raises(ServiceBusy) as caught:
                late.result(timeout=5)
            assert (caught.value.status_code, caught.value.code) == (503, "SERVICE_BUSY")
        finally:
            finish.set()
        assert [future.result(timeout=10).data for future in held] == [SAMPLE_LOGO] * IMAGE_CHECK_CONCURRENCY
    # The places are free again.
    assert checked_image(SAMPLE_LOGO, LOGO).data == SAMPLE_LOGO


# ---- the schemas --------------------------------------------------------------------------------------


@pytest.mark.parametrize("color", ["#188086", "#000000", "#ffffff", "#0a0b0c"])
def test_a_colour_is_a_number_sign_and_six_lower_case_hexadecimal_digits(color: str) -> None:
    assert CompanyBrandUpdate(color=color).color == color
    assert BrandPaletteRequest(color=color).color == color


@pytest.mark.parametrize(
    "value",
    [
        "",
        "188086",
        "#18808",
        "#1880866",
        "#18808G",
        "#ABCDEF",  # upper case is not folded: what is stored is what was sent
        " #188086",
        "#188086 ",
        "#188086\n",
        "#fff",
        "#188086ff",
        "red",
        "rgb(24,128,134)",
        "#188086;background:url(//evil.test)",
        "#188086}body{display:none",
        'x" onload="alert(1)',
        "#\u0661\u0662\u0663\u0664\u0665\u0666",  # Arabic-Indic digits
        1605766,
        True,
        ["#188086"],
        {"hex": "#188086"},
    ],
)
def test_nothing_else_is_a_colour(value: object) -> None:
    for model in (CompanyBrandUpdate, BrandPaletteRequest):
        with pytest.raises((ValidationError, FieldValueError)) as caught:
            model(color=value)
        assert "invalid_color" in str(caught.value) or "colour" in str(caught.value)


def test_a_company_s_colour_can_be_cleared_but_must_be_named() -> None:
    assert CompanyBrandUpdate(color=None).color is None
    with pytest.raises(ValidationError):
        CompanyBrandUpdate()  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        CompanyBrandUpdate(color="#188086", logo_url="/x")  # type: ignore[call-arg]
    # The preview needs a colour.
    with pytest.raises((ValidationError, FieldValueError)):
        BrandPaletteRequest(color=None)  # type: ignore[arg-type]


def test_an_image_s_version_parameter_is_optional_and_bounded() -> None:
    assert BrandImageQuery().v is None
    assert BrandImageQuery(v="0123456789abcdef").v == "0123456789abcdef"
    assert BrandImageQuery(v="x" * 64).v == "x" * 64
    with pytest.raises(ValidationError):
        BrandImageQuery(v="x" * 65)
    with pytest.raises(ValidationError):
        BrandImageQuery(v="1", w="2")  # type: ignore[call-arg]


# ---- slugs, paths and settings ------------------------------------------------------------------------


@pytest.mark.parametrize("slug", ["acme", "a", "a1", "acme-corp", "a-b-c", "0", "x" * 80])
def test_a_company_slug(slug: str) -> None:
    assert is_company_slug(slug)


@pytest.mark.parametrize(
    "slug",
    [
        "",
        "-acme",
        "acme-",
        "Acme",
        "a_b",
        "a b",
        "a.b",
        "a/b",
        "..",
        "%61",
        "acme\n",
        "x" * 81,
        "شركة",
        "a\u0661",  # an Arabic-Indic digit is a digit to `str.isdigit`, not to a slug
    ],
)
def test_what_is_not_a_company_slug(slug: str) -> None:
    assert not is_company_slug(slug)


def test_the_public_prefix_is_part_of_the_api_and_of_no_realm() -> None:
    assert PUBLIC_PREFIX == "/api/v1/public"
    for path in ("/api/v1/public/", "/api/v1/public/companies/acme/brand"):
        assert is_public_path(path) and is_api_path(path) and not is_platform_path(path)
    for path in (
        "/api/v1/public",  # no endpoint: nothing decides its own caching there
        "/api/v1/publicity",
        "/api/v1/platform/public/x",
        "/api/v1/auth/me",
        "/public/x",
        "/api/v1",
    ):
        assert not is_public_path(path)


def test_the_settings_of_a_company_s_identity() -> None:
    settings = make(database_url=PRODUCTION["database_url"])
    assert settings.rate_limit_public_brand_per_ip == 600
    assert settings.rate_limit_public_brand_per_prefix == 6000
    assert settings.rate_limit_brand_changes_per_hour == 120
    # Asking for a company's identity answers whether a slug names an active company: its budgets are
    # among those production holds to ten times their default (SEC-46).
    assert {"rate_limit_public_brand_per_ip", "rate_limit_public_brand_per_prefix"} <= set(GUESSING_LIMITS)
    with pytest.raises(ValidationError) as caught:
        make(**{**PRODUCTION, "rate_limit_public_brand_per_ip": 6001})
    assert "RATE_LIMIT_PUBLIC_BRAND_PER_IP must be at most 6000 " in str(caught.value)
    for name, value in (
        ("rate_limit_public_brand_per_ip", 0),
        ("rate_limit_public_brand_per_prefix", 0),
        ("rate_limit_brand_changes_per_hour", 0),
        ("rate_limit_brand_changes_per_hour", 10_001),
    ):
        with pytest.raises(ValidationError):
            make(database_url=PRODUCTION["database_url"], **{name: value})


def test_the_policies_of_a_company_s_identity() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        rate_limit_public_brand_per_ip=7,
        rate_limit_public_brand_per_prefix=70,
        rate_limit_brand_changes_per_hour=3,
    )
    policies = RatePolicies.from_settings(settings)
    per_ip, per_prefix, changes = (
        policies.public_brand_ip,
        policies.public_brand_prefix,
        policies.brand_changes_per_user,
    )
    assert (per_ip.limit, per_ip.window_seconds, per_ip.scope) == (7, 60, BucketScope.NETWORK)
    assert (per_prefix.limit, per_prefix.window_seconds, per_prefix.scope) == (70, 60, BucketScope.NETWORK)
    assert (changes.limit, changes.window_seconds) == (3, 3600)
    assert len({per_ip.name, per_prefix.name, changes.name}) == 3
