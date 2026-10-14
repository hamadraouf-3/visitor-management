"""The strict PNG check and re-serialisation of an uploaded brand image (Phase 12, B12-2: `app.core.png`).

Everything here is bytes in, bytes or `PngError` out: no database, no HTTP. What the API makes of the
errors is tested in tests/integration/test_platform_brand_api.py.
"""

import random
import struct
import zlib
from dataclasses import replace
from pathlib import Path

import pytest

from app.core import png as png_module
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
from app.email.logos import LOGO_LIMITS
from app.models import BrandAssetKind
from app.models.brand import BRAND_ASSET_MAX_BYTES
from app.services.brand import IMAGE_LIMITS
from app.services.seeding import MAWDOO3_BRAND, seed_image
from tests.memory_support import MIB, measured_memory
from tests.png_support import (
    SIGNATURE,
    assemble,
    chunk,
    chunk_types,
    header,
    image_data,
    make_png,
    row_bytes,
    scanlines,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
LOGO = IMAGE_LIMITS[BrandAssetKind.LOGO]
ICON = IMAGE_LIMITS[BrandAssetKind.ICON]
# What the e-mails decode: a stored logo, at any bit depth (16 for one stored before B13-7). The
# largest image the check still meets is one of those: 1200 x 600 pixels at 16 bits a channel.
STORED_LOGO = LOGO_LIMITS
# Wide limits, for the tests that are not about them.
ANY = PngLimits(min_width=1, max_width=4096, min_height=1, max_height=4096, max_bytes=8 * 1024 * 1024)
END = chunk(b"IEND")
# Every colour type with every bit depth PNG allows for it.
ALLOWED = [
    (0, 1), (0, 2), (0, 4), (0, 8), (0, 16),
    (2, 8), (2, 16),
    (3, 1), (3, 2), (3, 4), (3, 8),
    (4, 8), (4, 16),
    (6, 8), (6, 16),
]  # fmt: skip


def _problem(data: bytes, limits: PngLimits = ANY) -> PngProblem:
    with pytest.raises(PngError) as caught:
        sanitize_png(data, limits)
    return caught.value.problem


def _valid(width: int = 48, height: int = 40, **shape: int) -> list[bytes]:
    """The chunks of a valid image: [IHDR, IDAT, IEND]."""
    raw = scanlines(width, height, **shape)
    return [header(width, height, **shape), *image_data(raw), END]


# ---- what is accepted, and what is written ---------------------------------------------------------


def test_a_plain_image_is_accepted_and_written_as_it_was() -> None:
    """IHDR, one IDAT, IEND, as a browser's canvas writes it: there is nothing to drop, so the bytes
    stored are the bytes that came."""
    data = make_png(240, 80)
    image = sanitize_png(data, LOGO)
    assert image == Png(data=data, width=240, height=80, bit_depth=8, colour_type=6)


@pytest.mark.parametrize(("colour_type", "bit_depth"), ALLOWED)
def test_every_colour_type_and_bit_depth_of_png_is_accepted(colour_type: int, bit_depth: int) -> None:
    """Greyscale, truecolour and palette images, with and without alpha, 1 to 16 bits: an icon exported
    by any tool, a logo stored before B13-7 (an upload of a logo has at most 8 bits a sample now)."""
    data = make_png(50, 37, bit_depth=bit_depth, colour_type=colour_type)
    image = sanitize_png(data, STORED_LOGO)
    assert (image.width, image.height, image.bit_depth, image.colour_type) == (50, 37, bit_depth, colour_type)
    expected = [b"IHDR", b"PLTE", b"IDAT", b"IEND"] if colour_type == 3 else [b"IHDR", b"IDAT", b"IEND"]
    assert chunk_types(image.data) == expected
    # The image data is exactly the rows the header implies.
    stream = image.data[image.data.index(b"IDAT") + 4 : -16]
    assert len(zlib.decompress(stream)) == 37 * (1 + row_bytes(50, bit_depth, colour_type))


@pytest.mark.parametrize(
    ("colour_type", "bit_depth"),
    [(0, 3), (0, 32), (2, 1), (2, 4), (3, 16), (4, 4), (6, 2), (1, 8), (5, 8), (7, 8), (255, 8)],
)
def test_a_colour_type_or_bit_depth_png_does_not_define_is_refused(colour_type: int, bit_depth: int) -> None:
    body = struct.pack(">IIBBBBB", 48, 40, bit_depth, colour_type, 0, 0, 0)
    assert _problem(assemble(chunk(b"IHDR", body), *image_data(b"\x00" * 4000), END)) is PngProblem.HEADER


def test_text_time_colour_profiles_and_every_other_extra_are_dropped() -> None:
    """Only the parts that draw the image are written again: IHDR, the image data, IEND."""
    secret = b"Author: someone@example.com; GPS 31.95N 35.93E"
    extras_before = [
        chunk(b"gAMA", struct.pack(">I", 45455)),
        chunk(b"cHRM", bytes(32)),
        chunk(b"sRGB", b"\x00"),
        chunk(b"iCCP", b"profile\x00\x00" + zlib.compress(secret)),
        chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1)),
        chunk(b"bKGD", bytes(6)),
        chunk(b"sBIT", bytes(4)),
        chunk(b"tEXt", b"Comment\x00" + secret),
        chunk(b"zTXt", b"Comment\x00\x00" + zlib.compress(secret)),
        chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00" + secret),
        chunk(b"tIME", struct.pack(">HBBBBB", 2026, 10, 13, 9, 0, 0)),
        chunk(b"eXIf", b"II*\x00" + secret),
        chunk(b"prVt", secret),  # a private chunk of some editor
    ]
    extras_after = [chunk(b"tEXt", b"Software\x00" + secret), chunk(b"tIME", bytes(7))]
    plain = make_png(240, 80)
    dressed = make_png(240, 80, before_data=extras_before, after_data=extras_after)
    assert len(dressed) > len(plain) + 400
    image = sanitize_png(dressed, LOGO)
    assert image.data == plain
    assert chunk_types(image.data) == [b"IHDR", b"IDAT", b"IEND"]
    for trace in (secret, b"someone@example.com", b"Comment", b"Software", b"XML:"):
        assert trace not in image.data


def test_the_image_data_becomes_one_chunk_whatever_its_pieces_were() -> None:
    one = make_png(240, 80, pieces=1)
    many = make_png(240, 80, pieces=7)
    assert chunk_types(many).count(b"IDAT") == 7
    assert sanitize_png(many, LOGO).data == sanitize_png(one, LOGO).data == one


def test_empty_pieces_of_image_data_are_allowed() -> None:
    chunks = _valid()
    spread = assemble(chunks[0], chunk(b"IDAT"), chunks[1], chunk(b"IDAT"), END)
    assert sanitize_png(spread, ANY).data == assemble(*chunks)


def test_a_palette_and_its_transparency_are_kept_and_a_suggested_palette_is_not() -> None:
    palette = chunk(b"PLTE", bytes(range(48)))  # 16 entries
    transparency = chunk(b"tRNS", bytes([0, 128, 255]))
    raw = scanlines(48, 40, bit_depth=4, colour_type=3)
    indexed = assemble(
        header(48, 40, bit_depth=4, colour_type=3), palette, transparency, *image_data(raw), END
    )
    image = sanitize_png(indexed, ANY)
    assert chunk_types(image.data) == [b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"]
    assert image.data == indexed
    # In a truecolour image PLTE only suggests colours for displays that cannot show them all.
    raw = scanlines(48, 40, colour_type=2)
    suggested = assemble(header(48, 40, colour_type=2), palette, *image_data(raw), END)
    assert chunk_types(sanitize_png(suggested, ANY).data) == [b"IHDR", b"IDAT", b"IEND"]


@pytest.mark.parametrize(
    ("colour_type", "bit_depth", "body"), [(0, 8, b"\x00\x7f"), (2, 8, bytes(6)), (0, 16, b"\xff\xff")]
)
def test_the_transparent_colour_of_a_grey_or_truecolour_image_is_kept(
    colour_type: int, bit_depth: int, body: bytes
) -> None:
    raw = scanlines(48, 40, bit_depth=bit_depth, colour_type=colour_type)
    data = assemble(
        header(48, 40, bit_depth=bit_depth, colour_type=colour_type),
        chunk(b"tRNS", body),
        *image_data(raw),
        END,
    )
    image = sanitize_png(data, ANY)
    assert chunk_types(image.data) == [b"IHDR", b"tRNS", b"IDAT", b"IEND"] and image.data == data


@pytest.mark.parametrize("filter_type", [0, 1, 2, 3, 4])
def test_every_filter_type_of_png_is_accepted(filter_type: int) -> None:
    raw = scanlines(48, 40, filter_type=filter_type)
    assert sanitize_png(assemble(header(48, 40), *image_data(raw), END), ANY).height == 40


def test_the_output_is_byte_stable() -> None:
    """The same file always gives the same bytes; writing a written file again changes nothing; and the
    bytes do not depend on how the upload was compressed or cut into chunks."""
    raw = scanlines(240, 80)
    variants = [
        assemble(header(240, 80), *image_data(raw, level=level, pieces=pieces), END)
        for level in (1, 6, 9)
        for pieces in (1, 3)
    ]
    for data in variants:
        first = sanitize_png(data, LOGO).data
        assert sanitize_png(data, LOGO).data == first  # the same again
        assert sanitize_png(first, LOGO).data == first  # and its own output
        assert sanitize_png(first + b"", LOGO).data == first
    # The zlib stream is carried over, not compressed again: each compression level keeps its own bytes
    # (whatever zlib is installed), and the pieces make no difference.
    outputs = [sanitize_png(data, LOGO).data for data in variants]
    assert outputs[0] == outputs[1] and outputs[2] == outputs[3] and outputs[4] == outputs[5]
    assert all(zlib.decompress(out[out.index(b"IDAT") + 4 : -16]) == raw for out in outputs)


def test_the_output_is_never_larger_than_the_input() -> None:
    for data in (make_png(240, 80), make_png(240, 80, pieces=9, before_data=[chunk(b"tEXt", b"k\x00v")])):
        assert len(sanitize_png(data, LOGO).data) <= len(data)


def test_the_demo_brand_s_images_pass_and_are_stored_as_they_are() -> None:
    """The files the seeds give the demo company (B12-15) are files the API would store, byte for byte."""
    for kind, name in MAWDOO3_BRAND.images.items():
        packaged = seed_image(name)
        image = sanitize_png(packaged, IMAGE_LIMITS[kind])
        assert image.data == packaged, name
        assert (image.bit_depth, image.colour_type) == (8, 6)
        assert (image.width, image.height) == ((512, 512) if kind is BrandAssetKind.ICON else (462, 149))


def test_the_packaged_demo_images_are_the_web_application_s_brand_files() -> None:
    """scripts/demo_brand.py copies them from frontend/public (skipped where the frontend is not here)."""
    sources = {
        "logo.png": REPO_ROOT / "frontend" / "public" / "brand" / "logo-teal.png",
        "logo_dark.png": REPO_ROOT / "frontend" / "public" / "brand" / "logo-white.png",
        "icon.png": REPO_ROOT / "frontend" / "public" / "icons" / "icon-512.png",
    }
    if not all(source.is_file() for source in sources.values()):
        pytest.skip("the frontend's brand files are not here")
    assert set(sources) == set(MAWDOO3_BRAND.images.values())
    for name, source in sources.items():
        assert seed_image(name) == source.read_bytes(), name


# ---- limits -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(("width", "height"), [(32, 32), (1200, 600), (1200, 32), (32, 600), (462, 149)])
def test_a_logo_inside_the_limits_is_accepted(width: int, height: int) -> None:
    assert sanitize_png(make_png(width, height, colour_type=0, bit_depth=1), LOGO).width == width


@pytest.mark.parametrize(
    ("width", "height", "error"),
    [
        (31, 32, PngTooSmall),
        (32, 31, PngTooSmall),
        (1, 1, PngTooSmall),
        (1201, 32, PngTooLarge),
        (32, 601, PngTooLarge),
        (1201, 601, PngTooLarge),
        (31, 601, PngTooLarge),  # too large is said first
    ],
)
def test_a_logo_outside_the_limits_is_refused(width: int, height: int, error: type[PngError]) -> None:
    with pytest.raises(error):
        sanitize_png(make_png(width, height, colour_type=0, bit_depth=1), LOGO)


@pytest.mark.parametrize("side", [192, 256, 512])
def test_a_square_icon_inside_the_limits_is_accepted(side: int) -> None:
    assert sanitize_png(make_png(side, side, colour_type=0, bit_depth=1), ICON).height == side


@pytest.mark.parametrize(
    ("width", "height", "error"),
    [(191, 191, PngTooSmall), (513, 513, PngTooLarge), (200, 201, PngNotSquare), (512, 192, PngNotSquare)],
)
def test_an_icon_must_be_square_and_inside_the_limits(width: int, height: int, error: type[PngError]) -> None:
    with pytest.raises(error):
        sanitize_png(make_png(width, height, colour_type=0, bit_depth=1), ICON)


def test_the_limits_are_the_contract_s() -> None:
    assert IMAGE_LIMITS[BrandAssetKind.LOGO_DARK] == LOGO
    # A logo is uploaded at 8 bits a sample at most (B13-7); an icon at any depth; a stored logo of any
    # depth is decoded by the e-mails.
    assert LOGO.max_bit_depth == 8 and ICON.max_bit_depth == 16
    assert replace(LOGO, max_bit_depth=16) == STORED_LOGO
    assert (LOGO.min_width, LOGO.max_width, LOGO.min_height, LOGO.max_height) == (32, 1200, 32, 600)
    assert (ICON.min_width, ICON.max_width, ICON.min_height, ICON.max_height) == (192, 512, 192, 512)
    assert ICON.square and not LOGO.square
    assert LOGO.max_bytes == ICON.max_bytes == BRAND_ASSET_MAX_BYTES == 512 * 1024


@pytest.mark.parametrize("colour_type", [0, 2, 4, 6])
def test_a_logo_of_16_bits_a_sample_is_refused_on_its_header(
    colour_type: int, inflations: list[tuple[int, int]]
) -> None:
    """B13-7: the web application only ever uploads 8 bits a sample (a canvas), and the e-mails draw a
    16-bit logo in almost twice the time. Refused on the header, before anything is inflated, for both
    logos; an icon, which no e-mail draws, keeps every depth."""
    logo = make_png(240, 80, bit_depth=16, colour_type=colour_type)
    for limits in (LOGO, IMAGE_LIMITS[BrandAssetKind.LOGO_DARK]):
        assert _problem(logo, limits) is PngProblem.BIT_DEPTH
    assert inflations == []
    assert sanitize_png(make_png(240, 80, colour_type=colour_type), LOGO).bit_depth == 8
    assert sanitize_png(make_png(192, 192, bit_depth=16, colour_type=colour_type), ICON).bit_depth == 16


def test_a_file_above_the_byte_limit_is_refused_before_it_is_read() -> None:
    limits = PngLimits(min_width=1, max_width=100, min_height=1, max_height=100, max_bytes=200)
    padded = make_png(48, 40, before_data=[chunk(b"tEXt", b"k\x00" + bytes(300))])
    assert _problem(padded, limits) is PngProblem.SIZE
    assert _problem(b"x" * 201, limits) is PngProblem.SIZE  # not even a PNG: the size is said first


# ---- not a PNG, or not a whole one --------------------------------------------------------------------


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"\x89PNG",
        b"GIF89a" + bytes(40),
        b"\xff\xd8\xff\xe0" + bytes(40),  # JPEG
        b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        b"<!DOCTYPE html><script>alert(1)</script>",
        b"PK\x03\x04" + bytes(40),  # ZIP
        b"\x89PNG\r\n\x1a\r" + bytes(40),  # one byte of the signature wrong
        b"\x00" + make_png(48, 40),  # something before the signature
        b"\xef\xbb\xbf" + make_png(48, 40),  # a byte order mark before it
    ],
)
def test_what_does_not_start_with_the_png_signature_is_refused(data: bytes) -> None:
    assert _problem(data) is PngProblem.SIGNATURE


def test_every_truncation_of_a_valid_file_is_refused() -> None:
    """Cut anywhere: inside the signature, a length, a type, a body, a CRC, or just before IEND."""
    data = make_png(40, 33, pieces=2, before_data=[chunk(b"tEXt", b"k\x00v")])
    assert sanitize_png(data, ANY)
    for length in range(len(data)):
        with pytest.raises(PngError):
            sanitize_png(data[:length], ANY)


def test_a_file_without_its_end_is_refused() -> None:
    chunks = _valid()
    assert _problem(assemble(*chunks[:-1])) is PngProblem.TRUNCATED
    assert _problem(SIGNATURE) is PngProblem.TRUNCATED
    assert _problem(assemble(chunks[0])) is PngProblem.TRUNCATED


@pytest.mark.parametrize("position", [0, 1, 2])
def test_a_wrong_crc_is_refused_in_every_chunk(position: int) -> None:
    kinds = (b"IHDR", b"IDAT", b"IEND")
    chunks = _valid()
    body = chunks[position][8:-4]
    chunks[position] = chunk(kinds[position], body, crc=zlib.crc32(kinds[position] + body) ^ 1)
    assert _problem(assemble(*chunks)) is PngProblem.CHUNK


def test_a_wrong_crc_is_refused_in_a_chunk_that_would_be_dropped() -> None:
    chunks = _valid()
    assert _problem(assemble(chunks[0], chunk(b"tEXt", b"k\x00v", crc=0), *chunks[1:])) is PngProblem.CHUNK


@pytest.mark.parametrize("kind", [b"ID\x00T", b"1DAT", b"IDA ", b"tE<t", b"\xc3\x89Xt"])
def test_a_chunk_type_that_is_not_four_letters_is_refused(kind: bytes) -> None:
    chunks = _valid()
    assert _problem(assemble(chunks[0], chunk(kind, b"x"), *chunks[1:])) is PngProblem.CHUNK


def test_a_chunk_type_with_the_reserved_bit_set_is_refused() -> None:
    chunks = _valid()
    # The third letter's case is reserved: it must be upper case in every chunk of today's PNG.
    assert _problem(assemble(chunks[0], chunk(b"tExt", b"k\x00v"), *chunks[1:])) is PngProblem.CHUNK
    assert sanitize_png(assemble(chunks[0], chunk(b"teXt", b"k\x00v"), *chunks[1:]), ANY)


@pytest.mark.parametrize("length", [2**31, 2**32 - 1, 10_000_000])
def test_a_chunk_longer_than_the_file_is_refused(length: int) -> None:
    chunks = _valid()
    lying = struct.pack(">I", length) + b"tEXt" + b"k\x00v" + bytes(4)
    assert _problem(assemble(chunks[0], lying, *chunks[1:])) is PngProblem.TRUNCATED


def test_an_unknown_critical_chunk_is_refused() -> None:
    """A critical chunk says "this image cannot be shown without me": one this check does not know means
    the image is not what the header and the data alone say."""
    chunks = _valid()
    assert _problem(assemble(chunks[0], chunk(b"CgBI", bytes(4)), *chunks[1:])) is PngProblem.UNKNOWN_CRITICAL
    assert _problem(assemble(chunks[0], chunk(b"JDAT", bytes(4)), *chunks[1:])) is PngProblem.UNKNOWN_CRITICAL


# ---- the header ---------------------------------------------------------------------------------------


def test_the_header_must_come_first_and_only_once() -> None:
    chunks = _valid()
    assert _problem(assemble(chunks[1], chunks[0], chunks[2])) is PngProblem.HEADER  # IDAT first
    assert _problem(assemble(chunk(b"tEXt", b"k\x00v"), *chunks)) is PngProblem.HEADER
    assert _problem(assemble(chunks[0], chunks[0], *chunks[1:])) is PngProblem.HEADER
    assert _problem(assemble(*chunks[:2], chunks[0], chunks[2])) is PngProblem.HEADER
    assert _problem(assemble(chunk(b"IEND"))) is PngProblem.HEADER


@pytest.mark.parametrize("body", [bytes(12), bytes(14), b""])
def test_a_header_of_another_length_is_refused(body: bytes) -> None:
    chunks = _valid()
    assert _problem(assemble(chunk(b"IHDR", body), *chunks[1:])) is PngProblem.HEADER


@pytest.mark.parametrize(
    "fields",
    [
        {"compression": 1},
        {"filtering": 1},
        {"interlace": 2},
        {"interlace": 255},
    ],
)
def test_an_unknown_compression_filter_or_interlace_method_is_refused(fields: dict[str, int]) -> None:
    chunks = _valid()
    assert _problem(assemble(header(48, 40, **fields), *chunks[1:])) is PngProblem.HEADER


@pytest.mark.parametrize(("width", "height"), [(0, 40), (48, 0), (0, 0), (2**31, 40), (48, 2**32 - 1)])
def test_dimensions_png_does_not_allow_are_refused(width: int, height: int) -> None:
    body = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    assert _problem(assemble(chunk(b"IHDR", body), *_valid()[1:])) is PngProblem.HEADER


def test_an_interlaced_image_is_refused_even_when_it_is_a_valid_one() -> None:
    """Decided (B12-2): Adam7 is refused. Here with the data a real interlaced 8 x 8 image has: seven
    passes of 1, 1, 2, 2 and 4 rows, each row a filter byte and its pixels."""
    pass_rows = [(1, 1), (1, 1), (2, 1), (2, 2), (4, 2), (4, 4), (8, 4)]  # (pixels per row, rows)
    raw = b"".join((b"\x00" + bytes(4 * pixels)) * rows for pixels, rows in pass_rows)
    data = assemble(header(8, 8, interlace=1), *image_data(raw), END)
    assert _problem(data) is PngProblem.INTERLACED
    # The limits of the image are still said first: an interlaced file of the wrong size is "too small".
    with pytest.raises(PngTooSmall):
        sanitize_png(data, LOGO)


# ---- the order of the chunks ----------------------------------------------------------------------------


def test_the_image_data_must_be_one_run() -> None:
    chunks = _valid()
    stream = chunks[1][8:-4]
    first, second = chunk(b"IDAT", stream[:20]), chunk(b"IDAT", stream[20:])
    split = assemble(chunks[0], first, chunk(b"tEXt", b"k\x00v"), second, END)
    assert _problem(split) is PngProblem.ORDER
    assert sanitize_png(assemble(chunks[0], first, second, END), ANY)


def test_a_palette_must_come_before_the_image_data_and_only_once() -> None:
    palette = chunk(b"PLTE", bytes(48))
    raw = scanlines(48, 40, bit_depth=4, colour_type=3)
    head, data = header(48, 40, bit_depth=4, colour_type=3), image_data(raw)
    assert _problem(assemble(head, *data, palette, END)) is PngProblem.ORDER
    assert _problem(assemble(head, palette, palette, *data, END)) is PngProblem.ORDER
    assert _problem(assemble(head, *data, END)) is PngProblem.PALETTE  # a palette image without one


def test_transparency_must_follow_the_palette_and_precede_the_image_data() -> None:
    palette, transparency = chunk(b"PLTE", bytes(48)), chunk(b"tRNS", bytes(3))
    raw = scanlines(48, 40, bit_depth=4, colour_type=3)
    head, data = header(48, 40, bit_depth=4, colour_type=3), image_data(raw)
    assert _problem(assemble(head, transparency, palette, *data, END)) is PngProblem.ORDER
    assert _problem(assemble(head, palette, *data, transparency, END)) is PngProblem.ORDER
    assert _problem(assemble(head, palette, transparency, transparency, *data, END)) is PngProblem.ORDER
    assert _problem(assemble(head, palette, transparency, palette, *data, END)) is PngProblem.ORDER


def test_nothing_may_follow_the_end() -> None:
    data = make_png(48, 40)
    assert _problem(data + chunk(b"tEXt", b"k\x00v")) is PngProblem.TRAILING
    assert _problem(data + END) is PngProblem.TRAILING
    assert _problem(data + chunk(b"IDAT", b"x")) is PngProblem.TRAILING
    assert _problem(data + b"\x00") is PngProblem.TRAILING


def test_the_end_chunk_is_empty() -> None:
    chunks = _valid()
    assert _problem(assemble(*chunks[:2], chunk(b"IEND", b"x"))) is PngProblem.CHUNK


# ---- palettes and transparency ---------------------------------------------------------------------------


@pytest.mark.parametrize("colour_type", [0, 4])
def test_a_grey_image_has_no_palette(colour_type: int) -> None:
    raw = scanlines(48, 40, colour_type=colour_type)
    data = assemble(header(48, 40, colour_type=colour_type), chunk(b"PLTE", bytes(48)), *image_data(raw), END)
    assert _problem(data) is PngProblem.PALETTE


@pytest.mark.parametrize("body", [b"", bytes(47), bytes(49), bytes(3 * 257)])
def test_a_palette_is_one_to_256_colours_of_three_bytes(body: bytes) -> None:
    raw = scanlines(48, 40, colour_type=3)
    data = assemble(header(48, 40, colour_type=3), chunk(b"PLTE", body), *image_data(raw), END)
    assert _problem(data) is PngProblem.PALETTE


def test_a_palette_has_no_more_colours_than_the_bit_depth_can_index() -> None:
    raw = scanlines(48, 40, bit_depth=2, colour_type=3)
    head = header(48, 40, bit_depth=2, colour_type=3)
    assert sanitize_png(assemble(head, chunk(b"PLTE", bytes(12)), *image_data(raw), END), ANY)
    assert _problem(assemble(head, chunk(b"PLTE", bytes(15)), *image_data(raw), END)) is PngProblem.PALETTE


@pytest.mark.parametrize("colour_type", [4, 6])
def test_an_image_with_an_alpha_channel_has_no_transparency_chunk(colour_type: int) -> None:
    raw = scanlines(48, 40, colour_type=colour_type)
    data = assemble(header(48, 40, colour_type=colour_type), chunk(b"tRNS", bytes(2)), *image_data(raw), END)
    assert _problem(data) is PngProblem.PALETTE


@pytest.mark.parametrize(
    ("colour_type", "bit_depth", "body"),
    [
        (0, 8, b"\x00"),  # one byte for a two-byte sample
        (0, 8, bytes(6)),
        (2, 8, bytes(2)),
        (0, 4, b"\x00\x10"),  # 16 does not fit four bits
        (2, 8, b"\x01\x00" + bytes(4)),  # 256 does not fit eight
        (3, 4, b""),
        (3, 4, bytes(17)),  # more alphas than the palette has colours
    ],
)
def test_a_transparency_chunk_of_the_wrong_shape_is_refused(
    colour_type: int, bit_depth: int, body: bytes
) -> None:
    palette = [chunk(b"PLTE", bytes(48))] if colour_type == 3 else []
    raw = scanlines(48, 40, bit_depth=bit_depth, colour_type=colour_type)
    data = assemble(
        header(48, 40, bit_depth=bit_depth, colour_type=colour_type),
        *palette,
        chunk(b"tRNS", body),
        *image_data(raw),
        END,
    )
    assert _problem(data) is PngProblem.PALETTE


# ---- animation -------------------------------------------------------------------------------------------


def test_an_animated_png_is_refused() -> None:
    """APNG: an animation control chunk, frame controls and frame data around an ordinary image. A
    viewer that knows APNG would show other frames than the one that was checked."""
    chunks = _valid()
    control = chunk(b"acTL", struct.pack(">II", 2, 0))
    frame = chunk(b"fcTL", bytes(26))
    frame_data = chunk(b"fdAT", struct.pack(">I", 2) + chunks[1][8:-4])
    assert (
        _problem(assemble(chunks[0], control, frame, chunks[1], frame, frame_data, END))
        is PngProblem.ANIMATED
    )
    assert _problem(assemble(chunks[0], control, *chunks[1:])) is PngProblem.ANIMATED
    assert _problem(assemble(chunks[0], frame, *chunks[1:])) is PngProblem.ANIMATED
    assert _problem(assemble(*chunks[:2], frame_data, END)) is PngProblem.ANIMATED


# ---- the image data ----------------------------------------------------------------------------------------


_decompressobj = zlib.decompressobj


class _WatchedInflater:
    """`zlib.decompressobj()` that records how much it was asked for and how much it gave."""

    calls: list[tuple[int, int]] = []

    def __init__(self) -> None:
        self._inflater = _decompressobj()

    def decompress(self, data: bytes, max_length: int = 0) -> bytes:
        out = self._inflater.decompress(data, max_length)
        self.calls.append((max_length, len(out)))
        return out

    def __getattr__(self, name: str) -> object:
        return getattr(self._inflater, name)


@pytest.fixture
def inflations(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int]]:
    _WatchedInflater.calls = []
    monkeypatch.setattr(png_module.zlib, "decompressobj", _WatchedInflater)
    return _WatchedInflater.calls


def test_a_huge_header_with_a_tiny_image_is_refused_before_anything_is_inflated(
    inflations: list[tuple[int, int]],
) -> None:
    """The limits are applied to the header alone: 2 147 483 647 pixels each way is refused without a
    look at the data, whatever it would inflate to."""
    for width, height in ((2**31 - 1, 2**31 - 1), (1200, 2**31 - 1), (100_000, 100_000)):
        body = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
        tiny = assemble(chunk(b"IHDR", body), *image_data(b"\x00" * 5), END)
        with pytest.raises(PngTooLarge):
            sanitize_png(tiny, LOGO)
    assert inflations == []


def test_a_decompression_bomb_is_stopped_one_byte_past_the_image(inflations: list[tuple[int, int]]) -> None:
    """64 MiB of zeros deflate to a few dozen kilobytes. The header promises a 32 x 32 image (4 128 bytes
    of rows): inflation is asked for one byte more than that, gets it, and the file is refused."""
    bomb = zlib.compress(bytes(64 * 1024 * 1024), 9)
    assert len(bomb) < 100 * 1024
    data = assemble(header(32, 32), chunk(b"IDAT", bomb), END)
    assert len(data) < LOGO.max_bytes
    assert _problem(data, LOGO) is PngProblem.DATA
    expected = 32 * (1 + 32 * 4)
    assert inflations == [(expected + 1, expected + 1)]


def test_a_bomb_as_large_as_the_largest_logo_allows_costs_no_more_than_that_logo(
    inflations: list[tuple[int, int]],
) -> None:
    widest = 600 * (1 + 1200 * 8)  # 1200 x 600 pixels, 16-bit RGBA: the most any image checked inflates to
    bomb = zlib.compress(bytes(256 * 1024 * 1024), 9)
    data = assemble(header(1200, 600, bit_depth=16), chunk(b"IDAT", bomb), END)
    assert len(data) < STORED_LOGO.max_bytes
    assert _problem(data, STORED_LOGO) is PngProblem.DATA
    assert inflations == [(widest + 1, widest + 1)] and widest < 6 * 1024 * 1024


def test_the_largest_logo_is_accepted(inflations: list[tuple[int, int]]) -> None:
    raw = scanlines(1200, 600, bit_depth=16)
    data = assemble(header(1200, 600, bit_depth=16), *image_data(raw, level=1), END)
    assert sanitize_png(data, STORED_LOGO).data == data
    assert inflations == [(len(raw) + 1, len(raw))]


@pytest.mark.parametrize("change", [-1, 1, -200, 200])
def test_image_data_of_another_length_than_the_header_implies_is_refused(change: int) -> None:
    raw = scanlines(48, 40)
    wrong = raw[:change] if change < 0 else raw + bytes(change)
    assert _problem(assemble(header(48, 40), *image_data(wrong), END)) is PngProblem.DATA


def test_an_image_without_data_is_refused() -> None:
    assert _problem(assemble(header(48, 40), END)) is PngProblem.DATA
    assert _problem(assemble(header(48, 40), chunk(b"IDAT"), END)) is PngProblem.DATA


def test_a_stream_that_ends_early_or_goes_on_is_refused() -> None:
    raw = scanlines(48, 40)
    stream = zlib.compress(raw, 9)
    head = header(48, 40)
    assert _problem(assemble(head, chunk(b"IDAT", stream[:-1]), END)) is PngProblem.DATA  # no checksum
    assert _problem(assemble(head, chunk(b"IDAT", stream[:-5]), END)) is PngProblem.DATA
    assert _problem(assemble(head, chunk(b"IDAT", stream + b"\x00"), END)) is PngProblem.DATA
    assert _problem(assemble(head, chunk(b"IDAT", stream + b"<script>"), END)) is PngProblem.DATA
    assert (
        _problem(assemble(head, chunk(b"IDAT", stream + stream), END)) is PngProblem.DATA
    )  # a second stream
    # ... also when what follows the stream is in a chunk of its own.
    assert (
        _problem(assemble(head, chunk(b"IDAT", stream), chunk(b"IDAT", b"<script>"), END)) is PngProblem.DATA
    )


def test_a_stream_that_is_not_zlib_is_refused() -> None:
    raw = scanlines(48, 40)
    head = header(48, 40)
    stream = bytearray(zlib.compress(raw, 9))
    wrong_checksum = bytes(stream[:-1]) + bytes([stream[-1] ^ 1])
    assert _problem(assemble(head, chunk(b"IDAT", wrong_checksum), END)) is PngProblem.DATA
    assert _problem(assemble(head, chunk(b"IDAT", raw), END)) is PngProblem.DATA  # not compressed at all
    assert (
        _problem(assemble(head, chunk(b"IDAT", b"\x1f\x8b\x08" + bytes(30)), END)) is PngProblem.DATA
    )  # gzip
    raw_deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    headerless = raw_deflate.compress(raw) + raw_deflate.flush()
    assert _problem(assemble(head, chunk(b"IDAT", headerless), END)) is PngProblem.DATA
    with_dictionary = zlib.compressobj(9, zlib.DEFLATED, 15, zdict=b"dictionary")
    preset = with_dictionary.compress(raw) + with_dictionary.flush()
    assert _problem(assemble(head, chunk(b"IDAT", preset), END)) is PngProblem.DATA


@pytest.mark.parametrize("row", [0, 17, 39])
def test_a_scanline_with_an_unknown_filter_type_is_refused(row: int) -> None:
    stride = 1 + row_bytes(48, 8, 6)
    raw = bytearray(scanlines(48, 40))
    raw[row * stride] = 5
    assert _problem(assemble(header(48, 40), *image_data(bytes(raw)), END)) is PngProblem.DATA


# ---- what a check costs, and what a refusal keeps (B12-19) -----------------------------------------

# What the largest image the product accepts inflates to: 1200 x 600 pixels of 8 bytes, a filter byte a row.
LARGEST_INFLATED = 600 * (1 + 1200 * 8)


def _largest_logo(fault: str | None = None) -> bytes:
    """A logo of the largest size at 16 bits a channel: a valid one, or one whose image data is wrong in
    the named way. Each is refused only after its data was inflated."""
    raw = scanlines(1200, 600, bit_depth=16)
    stream = zlib.compress(raw, 1)
    if fault == "bomb":  # 64 MiB behind a header that promises 5.5
        stream = zlib.compress(bytes(64 * 1024 * 1024), 9)
    elif fault == "one byte more":
        stream = zlib.compress(raw + b"\x00", 1)
    elif fault == "one row less":
        stream = zlib.compress(raw[: -(1 + 1200 * 8)], 1)
    elif fault == "bytes after the stream":
        stream += b"<script>alert(1)</script>"
    elif fault == "unknown filter type":
        wrong = bytearray(raw)
        wrong[299 * (1 + 1200 * 8)] = 7
        stream = zlib.compress(bytes(wrong), 1)
    return assemble(header(1200, 600, bit_depth=16), chunk(b"IDAT", stream), END)


def _largest_bytes_kept(error: BaseException) -> int:
    """The longest run of bytes among the locals of the frames `error` passed through: what stays alive
    for as long as anything keeps the error."""
    longest = 0
    traceback = error.__traceback__
    while traceback is not None:
        for value in traceback.tb_frame.f_locals.values():
            if isinstance(value, bytes | bytearray | memoryview):
                longest = max(longest, len(value))
        traceback = traceback.tb_next
    return longest


@pytest.mark.parametrize(
    "fault", ["bomb", "one byte more", "one row less", "bytes after the stream", "unknown filter type"]
)
def test_a_refusal_keeps_nothing_that_was_inflated(fault: str) -> None:
    """An exception keeps the frames it passed through, with their locals, for as long as anything keeps
    the exception. The inflated image (megabytes) must not be one of those locals: a refusal holds on to
    nothing longer than the file itself."""
    data = _largest_logo(fault)
    assert len(data) < STORED_LOGO.max_bytes
    with pytest.raises(PngError) as caught:
        sanitize_png(data, STORED_LOGO)
    assert caught.value.problem is PngProblem.DATA
    assert _largest_bytes_kept(caught.value) <= len(data) < LARGEST_INFLATED // 10


def test_a_check_costs_twice_what_the_image_inflates_to_and_keeps_none_of_it() -> None:
    """The figure the documents give (11 MiB for the largest image, a logo at 16 bits a channel): while zlib
    inflates, its pieces and the one object they become are both alive. Once the check returns, only the
    file that will be stored is."""
    data = _largest_logo()
    with measured_memory() as memory:
        image = sanitize_png(data, STORED_LOGO)
        peak, kept = memory.peak(), memory.grown()
    assert image.data == data
    assert LARGEST_INFLATED == 5_760_600
    assert peak <= 2 * LARGEST_INFLATED + len(data) + MIB // 2 < 12 * MIB
    assert kept <= len(data) + MIB // 8


@pytest.mark.parametrize("fault", ["bomb", "unknown filter type"])
def test_a_refused_image_costs_no_more_than_a_valid_one_and_leaves_nothing(fault: str) -> None:
    data = _largest_logo(fault)
    with measured_memory() as memory:
        with pytest.raises(PngError) as caught:
            sanitize_png(data, STORED_LOGO)
        problem = caught.value.problem
        del caught
        peak, kept = memory.peak(), memory.grown()
    assert problem is PngProblem.DATA
    assert peak <= 2 * LARGEST_INFLATED + 3 * len(data) + MIB // 2 < 12 * MIB
    assert kept <= MIB // 8


# ---- polyglots ---------------------------------------------------------------------------------------

HTML = b"<!DOCTYPE html><html><body><script>fetch('/api/v1/auth/me')</script></body></html>"
SCRIPT = b"/*\x89PNG*/alert(document.cookie)//"
# The end of a ZIP archive: what makes a file open as one, wherever the archive starts.
ZIP = b"PK\x03\x04" + bytes(26) + b"PK\x05\x06" + bytes(18)


@pytest.mark.parametrize(
    "payload", [HTML, SCRIPT, ZIP, b"\n", b"%PDF-1.7\n", b"<?php system($_GET['c']); ?>"]
)
def test_a_png_with_something_appended_is_refused(payload: bytes) -> None:
    """PNG + HTML, PNG + JavaScript, PNG + ZIP: a valid image and, after its end, a second file that
    another parser would read."""
    assert _problem(make_png(240, 80) + payload, LOGO) is PngProblem.TRAILING


@pytest.mark.parametrize("payload", [HTML, SCRIPT, ZIP])
def test_a_payload_in_a_chunk_that_is_not_drawn_does_not_reach_the_stored_file(payload: bytes) -> None:
    """The same payloads inside the file, where PNG lets any tool put bytes: a text chunk, a private
    chunk, an ICC profile. They are valid PNG, so the file is accepted, and written again without them."""
    carriers = [
        chunk(b"tEXt", b"Comment\x00" + payload),
        chunk(b"prVt", payload),
        chunk(b"iCCP", b"x\x00\x00" + payload),
    ]
    image = sanitize_png(make_png(240, 80, before_data=carriers[:2], after_data=carriers[2:]), LOGO)
    assert payload not in image.data and b"<script>" not in image.data and b"PK\x05\x06" not in image.data
    assert image.data == make_png(240, 80)


def test_a_payload_between_the_chunks_is_refused() -> None:
    chunks = _valid()
    assert _problem(assemble(chunks[0], HTML, *chunks[1:])) in (PngProblem.CHUNK, PngProblem.TRUNCATED)


# ---- no input makes it do anything else --------------------------------------------------------------


def _rebuilt(kinds_and_bodies: list[tuple[bytes, bytes]]) -> bytes:
    return assemble(*(chunk(kind, body) for kind, body in kinds_and_bodies))


def test_mutated_files_are_refused_or_written_as_a_file_that_passes_again() -> None:
    """Thousands of damaged files, with their CRCs made right again so that the damage reaches every
    check: each one is either refused with `PngError`, or accepted and written as a file that is accepted
    again and stays the same. Never another exception, never an output that would not pass."""
    generator = random.Random(20261013)
    seeds = [
        make_png(48, 40, pieces=2, before_data=[chunk(b"tEXt", b"k\x00v")]),
        make_png(40, 36, bit_depth=4, colour_type=3, before_data=[chunk(b"tRNS", bytes(5))]),
        make_png(36, 34, bit_depth=16, colour_type=2, before_data=[chunk(b"tRNS", bytes(6))]),
        make_png(33, 33, bit_depth=1, colour_type=0, after_data=[chunk(b"tIME", bytes(7))]),
    ]
    accepted = refused = 0
    for seed in seeds:
        parts = []
        position = len(SIGNATURE)
        while position < len(seed):
            (length,) = struct.unpack_from(">I", seed, position)
            parts.append((seed[position + 4 : position + 8], seed[position + 8 : position + 8 + length]))
            position += 12 + length
        for _ in range(1500):
            mutated = [(kind, bytearray(body)) for kind, body in parts]
            for _ in range(generator.randint(1, 3)):
                action = generator.random()
                index = generator.randrange(len(mutated))
                kind, body = mutated[index]
                if action < 0.55 and body:
                    body[generator.randrange(len(body))] = generator.randrange(256)
                elif action < 0.65:
                    del body[generator.randrange(len(body) + 1) :]
                elif action < 0.75:
                    body.extend(generator.randbytes(generator.randint(1, 9)))
                elif action < 0.85:
                    mutated.insert(generator.randrange(len(mutated) + 1), (kind, bytearray(body)))
                elif action < 0.92 and len(mutated) > 1:
                    del mutated[index]
                else:
                    other = generator.randrange(len(mutated))
                    mutated[index], mutated[other] = mutated[other], mutated[index]
            data = _rebuilt([(kind, bytes(body)) for kind, body in mutated])
            try:
                image = sanitize_png(data, ANY)
            except PngError:
                refused += 1
                continue
            accepted += 1
            again = sanitize_png(image.data, ANY)
            assert again == image
            assert chunk_types(image.data)[0] == b"IHDR" and chunk_types(image.data)[-1] == b"IEND"
            assert set(chunk_types(image.data)) <= {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}
    assert refused > 3000 and accepted > 50  # both happen: the test reaches both sides


def test_random_bytes_after_the_signature_are_refused() -> None:
    generator = random.Random(12)
    for _ in range(500):
        with pytest.raises(PngError):
            sanitize_png(SIGNATURE + generator.randbytes(generator.randint(0, 200)), ANY)
