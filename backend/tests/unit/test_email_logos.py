"""A company's logo as its e-mails send it (Phase 13, B13-2 to B13-4): opaque renditions on a plate,
made smaller by area averaging to at most twice the header's box, drawn once per process and kept by the
SHA-256 of the stored bytes."""

import logging
import struct
import threading
import time
import uuid

import pytest

from app.core.palette import to_rgb
from app.core.png import PngError, decode_png
from app.email import logos
from app.email.identity import fitted
from app.email.logos import (
    DARK_HEADER,
    DENSITY,
    EMBLEM_MAX_RATIO,
    LIGHT_HEADER,
    LOGO_LIMITS,
    PLATE,
    RenditionCache,
    dark_rendition,
    draw,
    is_mark,
    light_rendition,
)
from tests.png_support import (
    NAVY,
    CompanyLogos,
    chunk_types,
    drawn_logo,
    drawn_rgba,
    make_png,
    png_size,
    rgba_png,
)


def _rgb(rendition_content: bytes) -> tuple[int, int, bytes]:
    pixels = decode_png(rendition_content, LOGO_LIMITS)
    assert pixels.rgba[3::4] == b"\xff" * (pixels.width * pixels.height)
    return pixels.width, pixels.height, bytes(b for i, b in enumerate(pixels.rgba) if i % 4 != 3)


def _border(width: int, height: int, rgb: bytes, depth: int) -> set[bytes]:
    """The colours of the outer `depth` pixels on every side."""
    colours = set()
    for y in range(height):
        for x in range(width):
            if min(x, y, width - 1 - x, height - 1 - y) < depth:
                start = (y * width + x) * 3
                colours.add(rgb[start : start + 3])
    return colours


@pytest.mark.parametrize(
    ("name", "background"), [("navy", LIGHT_HEADER), ("mark", DARK_HEADER), ("gold", DARK_HEADER)]
)
def test_a_rendition_is_an_opaque_picture_on_its_plate(name: str, background: str) -> None:
    """The owner's report: a transparent navy wordmark sank into a darkened header. A rendition has no
    alpha at all (8-bit truecolour, no tRNS), and the logo stands on PLATE pixels of the plate's colour."""
    stored = drawn_logo(name)
    rendition = draw(stored, background)
    content = rendition.content
    assert struct.unpack(">BB", content[24:26]) == (8, 2)  # 8-bit truecolour: no alpha channel
    assert b"tRNS" not in chunk_types(content)
    width, height, rgb = _rgb(content)
    source_width, source_height = png_size(stored)
    shown = fitted(source_width, source_height)
    # Shown with its plate; drawn at most DENSITY image pixels per CSS pixel, never larger than the source.
    assert (rendition.width, rendition.height) == (shown[0] + 2 * PLATE, shown[1] + 2 * PLATE)
    assert width <= DENSITY * rendition.width and height <= DENSITY * rendition.height
    assert width - 2 * round(PLATE * DENSITY) <= source_width
    # The plate is exactly the background, all the way round.
    margin = (width - (width * shown[0] // rendition.width)) // 2
    assert _border(width, height, rgb, max(1, margin - 2)) == {bytes(to_rgb(background))}
    # And the logo is on it.
    assert len({rgb[i : i + 3] for i in range(0, len(rgb), 3)}) > 4


def test_the_light_rendition_of_the_owner_s_logo() -> None:
    """609 x 159 is shown 168 x 44: drawn at 336 x 88 with 16 pixels of white round it."""
    rendition = light_rendition(drawn_logo("navy"))
    width, height, rgb = _rgb(rendition.content)
    assert (rendition.width, rendition.height) == (168 + 2 * PLATE, 44 + 2 * PLATE)
    assert (width, height) == (336 + 4 * PLATE, 88 + 4 * PLATE)
    # Navy where the diamond is solid, after area averaging.
    centre = ((2 * PLATE + 44) * width + (2 * PLATE + 44)) * 3
    assert rgb[centre : centre + 3] == bytes(NAVY[:3])
    assert not rendition.mark


def test_a_small_logo_is_not_enlarged() -> None:
    small = rgba_png(100, 40, drawn_rgba(100, 40, lambda x, y: NAVY if 20 < x < 80 else None))
    rendition = draw(small, LIGHT_HEADER)
    width, height, _pixels = _rgb(rendition.content)
    assert (rendition.width, rendition.height) == (100 + 2 * PLATE, 40 + 2 * PLATE)
    assert (width, height) == (100 + 2 * PLATE, 40 + 2 * PLATE)  # one image pixel per CSS pixel


def test_a_clear_picture_is_its_plate() -> None:
    clear = make_png(120, 60, fill=0)  # every pixel transparent black
    width, height, rgb = _rgb(draw(clear, DARK_HEADER).content)
    assert rgb == bytes(to_rgb(DARK_HEADER)) * (width * height)


@pytest.mark.parametrize(
    ("size", "mark"),
    [
        ((140, 100), True),
        ((141, 100), False),
        ((200, 100), False),
        ((423, 570), True),
        ((512, 512), True),
        ((7, 5), True),
        ((1200, 858), True),
        ((1200, 857), False),
        ((609, 159), False),
    ],
)
def test_a_logo_at_most_1_4_times_as_wide_as_tall_is_a_mark(size: tuple[int, int], mark: bool) -> None:
    """The web application's rule (CompanyLogo.tsx, EMBLEM_MAX_RATIO = 1.4), compared in integers so that
    the boundary is exact (B13-12)."""
    assert EMBLEM_MAX_RATIO == 7 / 5
    assert is_mark(*size) is mark


def test_the_dark_rendition_of_a_mark_says_so() -> None:
    assert dark_rendition(drawn_logo("mark")).mark
    assert not dark_rendition(drawn_logo("gold")).mark


def test_the_largest_logo_is_drawn() -> None:
    """1200 x 600 (the limit) is shown 88 x 44 and drawn at 176 x 88. Half-transparent grey on white:
    every pixel of the logo is (128 * 128 + 127 * 255) / 255, rounded."""
    rendition = draw(make_png(1200, 600, fill=0x80), LIGHT_HEADER)
    width, height, rgb = _rgb(rendition.content)
    assert (rendition.width, rendition.height) == (88 + 2 * PLATE, 44 + 2 * PLATE)
    assert (width, height) == (176 + 4 * PLATE, 88 + 4 * PLATE)
    centre = (height // 2 * width + width // 2) * 3
    assert rgb[centre : centre + 3] == bytes((191, 191, 191))


def test_bytes_that_are_no_logo_are_refused() -> None:
    with pytest.raises(PngError):
        draw(b"\x89PNG\r\n\x1a\n not an image", LIGHT_HEADER)
    with pytest.raises(PngError):
        draw(make_png(1300, 100), LIGHT_HEADER)  # wider than a logo may be


# ---- drawn once --------------------------------------------------------------------------------------


def test_a_rendition_is_drawn_once_per_logo_and_background() -> None:
    cache = RenditionCache()
    stored = drawn_logo("navy")
    first = cache.rendition(stored, LIGHT_HEADER)
    assert cache.rendition(bytes(bytearray(stored)), LIGHT_HEADER) is first  # the same bytes, another object
    assert cache.drawn == 1
    cache.rendition(stored, DARK_HEADER)
    assert cache.drawn == 2  # another background is another picture
    cache.rendition(drawn_logo("gold"), DARK_HEADER)
    assert cache.drawn == 3


def test_two_requests_for_one_rendition_draw_it_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """The second waits for the first and takes its picture: no e-mail and no preview draws one twice."""
    calls = []
    real = logos.draw

    def slow(content: bytes, background: str):
        calls.append(background)
        time.sleep(0.2)
        return real(content, background)

    monkeypatch.setattr(logos, "draw", slow)
    cache = RenditionCache()
    stored = drawn_logo("gold")
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(cache.rendition(stored, DARK_HEADER)))
        for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert calls == [DARK_HEADER] and cache.drawn == 1
    assert len({id(result) for result in results}) == 1


def test_a_rendition_found_does_not_wait_for_one_being_drawn(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = RenditionCache()
    navy = drawn_logo("navy")
    found = cache.rendition(navy, LIGHT_HEADER)
    started, release = threading.Event(), threading.Event()
    real = logos.draw

    def blocked(content: bytes, background: str):
        started.set()
        release.wait(5)
        return real(content, background)

    monkeypatch.setattr(logos, "draw", blocked)
    drawing = threading.Thread(target=lambda: cache.rendition(drawn_logo("mark"), DARK_HEADER))
    drawing.start()
    assert started.wait(5)
    began = time.perf_counter()
    assert cache.rendition(navy, LIGHT_HEADER) is found
    assert time.perf_counter() - began < 1
    release.set()
    drawing.join()


def test_the_store_is_bounded_by_bytes_least_recently_used_first_out() -> None:
    navy, gold = drawn_logo("navy"), drawn_logo("gold")
    sizes = [len(draw(navy, LIGHT_HEADER).content), len(draw(gold, DARK_HEADER).content)]
    cache = RenditionCache(limit=max(sizes) + min(sizes) - 1)  # room for one of them only
    cache.rendition(navy, LIGHT_HEADER)
    cache.rendition(gold, DARK_HEADER)
    assert cache.drawn == 2
    cache.rendition(gold, DARK_HEADER)  # still there
    assert cache.drawn == 2
    cache.rendition(navy, LIGHT_HEADER)  # pushed out by the other
    assert cache.drawn == 3


def test_what_was_read_last_is_kept_and_the_least_recently_used_goes() -> None:
    """B13-10. Room for two of three renditions: A, then B, then A read again, then C. B goes, not A,
    though A came first: reading a rendition makes it the most recent."""
    a, b, c = (
        (drawn_logo("navy"), LIGHT_HEADER),
        (drawn_logo("gold"), DARK_HEADER),
        (drawn_logo("mark"), DARK_HEADER),
    )
    sizes = [len(draw(*key).content) for key in (a, b, c)]
    cache = RenditionCache(limit=sum(sizes) - 1)  # any two, never three
    first_a = cache.rendition(*a)
    cache.rendition(*b)
    assert cache.rendition(*a) is first_a and cache.drawn == 2  # read, not drawn
    cache.rendition(*c)
    assert cache.drawn == 3
    assert cache.rendition(*a) is first_a and cache.drawn == 3  # kept
    cache.rendition(*b)
    assert cache.drawn == 4  # gone: drawn again


# ---- drawn ahead (B13-7) -----------------------------------------------------------------------------


class _Brands:
    """`CompanyBrandRepository` for the warm-up, without a database: companies' logos by ID."""

    def __init__(
        self, logos: dict[uuid.UUID, CompanyLogos], *, failing: frozenset[uuid.UUID] = frozenset()
    ) -> None:
        self.logos, self.failing = logos, failing
        self.sessions_open = 0  # sessions not yet closed
        self.drawing_with_a_session = False

    def companies_with_logo(self) -> list[uuid.UUID]:
        return list(self.logos)

    def image(self, company_id: uuid.UUID, kind):
        if company_id in self.failing:
            raise RuntimeError("the database went away")
        return self.logos[company_id].image(company_id, kind)


class _Session:
    def __init__(self, brands: _Brands) -> None:
        self.brands = brands

    def __enter__(self) -> _Session:
        self.brands.sessions_open += 1
        return self

    def __exit__(self, *exc: object) -> None:
        self.brands.sessions_open -= 1


@pytest.fixture
def warm_brands(monkeypatch: pytest.MonkeyPatch) -> _Brands:
    navy, mark, gold = drawn_logo("navy"), drawn_logo("mark"), drawn_logo("gold")
    brands = _Brands(
        {
            uuid.uuid4(): CompanyLogos(navy, *png_size(navy), dark=mark),
            uuid.uuid4(): CompanyLogos(gold, *png_size(gold)),
        }
    )
    monkeypatch.setattr(logos, "CompanyBrandRepository", lambda session: session.brands)
    real = logos.draw

    def watched(content: bytes, background: str):
        brands.drawing_with_a_session = brands.drawing_with_a_session or brands.sessions_open > 0
        return real(content, background)

    monkeypatch.setattr(logos, "draw", watched)
    return brands


def test_every_company_s_logos_are_drawn_ahead_without_a_session_held(warm_brands: _Brands) -> None:
    cache = RenditionCache()
    warm_up = logos.LogoWarmUp(lambda: _Session(warm_brands), cache)
    thread = warm_up.everything()
    assert warm_up.everything() is thread  # once per process
    thread.join(10)
    assert not thread.is_alive() and thread.daemon
    # The renditions the e-mails take: the light one of each logo, the dark one where there are both.
    assert cache.drawn == 3
    navy, mark, gold = drawn_logo("navy"), drawn_logo("mark"), drawn_logo("gold")
    for content, background in ((navy, LIGHT_HEADER), (mark, DARK_HEADER), (gold, LIGHT_HEADER)):
        cache.rendition(content, background)
    assert cache.drawn == 3
    assert not warm_brands.drawing_with_a_session and warm_brands.sessions_open == 0


def test_a_company_whose_logos_cannot_be_read_does_not_stop_the_others(
    warm_brands: _Brands, caplog: pytest.LogCaptureFixture
) -> None:
    first = next(iter(warm_brands.logos))
    warm_brands.failing = frozenset({first})
    cache = RenditionCache()
    with caplog.at_level(logging.ERROR, logger="app.email"):
        logos.LogoWarmUp(lambda: _Session(warm_brands), cache).everything().join(10)
    assert cache.drawn == 1  # the second company's logo
    [record] = [record for record in caplog.records if record.name == "app.email"]
    assert record.company_id == str(first) and record.exc_info is not None  # type: ignore[attr-defined]


def test_one_company_s_logos_are_drawn_after_a_change(warm_brands: _Brands) -> None:
    cache = RenditionCache()
    company = next(iter(warm_brands.logos))
    logos.LogoWarmUp(lambda: _Session(warm_brands), cache).company(company).join(10)
    assert cache.drawn == 2  # its light and its dark rendition


def test_a_request_for_a_rendition_being_drawn_ahead_waits_for_it(
    warm_brands: _Brands, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The e-mail that needs a logo the warm-up is drawing takes the warm-up's picture: drawn once."""
    started, release = threading.Event(), threading.Event()
    real = logos.draw

    def held(content: bytes, background: str):
        started.set()
        release.wait(5)
        return real(content, background)

    monkeypatch.setattr(logos, "draw", held)
    cache = RenditionCache()
    company = list(warm_brands.logos)[1]  # the gold logo alone
    drawing = logos.LogoWarmUp(lambda: _Session(warm_brands), cache).company(company)
    assert started.wait(5)
    found: list[object] = []
    request = threading.Thread(target=lambda: found.append(cache.rendition(drawn_logo("gold"), LIGHT_HEADER)))
    request.start()
    time.sleep(0.1)
    assert request.is_alive()  # waiting for the drawing in progress
    release.set()
    request.join(5)
    drawing.join(5)
    assert cache.drawn == 1 and found == [cache.rendition(drawn_logo("gold"), LIGHT_HEADER)]
