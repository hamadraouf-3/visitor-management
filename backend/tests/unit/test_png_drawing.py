"""Reading and writing pixels in pure Python (Phase 13, B13-3): `app.core.png.decode_png` for every colour
type, bit depth and filter PNG defines, `app.core.png.encode_rgb_png`, and the three drawing steps of
`app.core.raster` (flatten, downscale by area averaging, frame). The images here are encoded by the
tests' own encoder (`tests.png_support.filtered`), written apart from the decoder."""

import random
import struct
import zlib

import pytest

from app.core.png import Pixels, PngError, PngLimits, decode_png, encode_rgb_png, sanitize_png
from app.core.raster import downscale, flatten, framed
from tests.png_support import (
    SAMPLES,
    assemble,
    chunk,
    chunk_types,
    filtered,
    header,
    make_png,
    rgba_png,
)

ANY = PngLimits(min_width=1, max_width=1200, min_height=1, max_height=600, max_bytes=512 * 1024)
FILTERS = (0, 1, 2, 3, 4)


def _packed(values: list[int], bit_depth: int) -> bytes:
    """Samples of fewer than 8 bits packed into bytes, the first in the highest bits (a row)."""
    per_byte = 8 // bit_depth
    out = bytearray()
    for start in range(0, len(values), per_byte):
        byte = 0
        for place, value in enumerate(values[start : start + per_byte]):
            byte |= value << (8 - bit_depth * (place + 1))
        out.append(byte)
    return bytes(out)


def _image(
    width: int,
    height: int,
    colour_type: int,
    bit_depth: int,
    samples: list[list[int]],
    *,
    palette: bytes = b"",
    transparency: bytes = b"",
    filter_types: tuple[int, ...] = FILTERS,
) -> bytes:
    """A PNG of `samples` (per row, every sample of every pixel, at the bit depth's own range)."""
    rows = []
    for row in samples:
        if bit_depth < 8:
            rows.append(_packed(row, bit_depth))
        elif bit_depth == 16:
            rows.append(b"".join(struct.pack(">H", value) for value in row))
        else:
            rows.append(bytes(row))
    step = max(1, SAMPLES[colour_type] * bit_depth // 8)
    parts = [header(width, height, bit_depth=bit_depth, colour_type=colour_type)]
    if palette:
        parts.append(chunk(b"PLTE", palette))
    if transparency:
        parts.append(chunk(b"tRNS", transparency))
    parts += [chunk(b"IDAT", zlib.compress(filtered(rows, step, filter_types))), chunk(b"IEND")]
    return assemble(*parts)


def _random_samples(rng: random.Random, width: int, height: int, count: int, top: int) -> list[list[int]]:
    return [[rng.randrange(top + 1) for _ in range(width * count)] for _ in range(height)]


# ---- decoding ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("filter_type", FILTERS, ids=["none", "sub", "up", "average", "paeth"])
def test_every_filter_is_undone(filter_type: int) -> None:
    rng = random.Random(filter_type)
    width, height = 37, 9
    rgba = bytes(rng.randrange(256) for _ in range(width * height * 4))
    pixels = decode_png(rgba_png(width, height, rgba, filter_types=(filter_type,)), ANY)
    assert (pixels.width, pixels.height, pixels.rgba) == (width, height, rgba)


def test_paeth_under_a_clear_row_is_left_alone() -> None:
    """Paeth under a row of zeros (a transparent band) is Sub, which the decoder takes as a shortcut."""
    rng = random.Random(7)
    width = 25
    rows = [bytes(rng.randrange(256) for _ in range(width * 4)), bytes(width * 4)]
    rows += [bytes(rng.randrange(256) for _ in range(width * 4)) for _ in range(3)]
    rgba = b"".join(rows)
    assert decode_png(rgba_png(width, 5, rgba, filter_types=(4,)), ANY).rgba == rgba


def _expected_grey(value: int, bit_depth: int) -> int:
    if bit_depth == 16:
        return value >> 8
    return value * 255 // ((1 << bit_depth) - 1)


@pytest.mark.parametrize("bit_depth", [1, 2, 4, 8, 16])
@pytest.mark.parametrize("keyed", [False, True], ids=["opaque", "with a transparent grey"])
def test_grey_images_of_every_depth(bit_depth: int, keyed: bool) -> None:
    rng = random.Random(bit_depth)
    width, height, top = 13, 6, (1 << bit_depth) - 1
    samples = _random_samples(rng, width, height, 1, top)
    key = samples[0][0]
    transparency = struct.pack(">H", key) if keyed else b""
    pixels = decode_png(_image(width, height, 0, bit_depth, samples, transparency=transparency), ANY)
    expected = bytearray()
    for row in samples:
        for value in row:
            grey = _expected_grey(value, bit_depth)
            expected += bytes((grey, grey, grey, 0 if keyed and value == key else 255))
    assert pixels.rgba == bytes(expected)


@pytest.mark.parametrize("bit_depth", [8, 16])
def test_grey_with_alpha(bit_depth: int) -> None:
    rng = random.Random(bit_depth + 40)
    width, height = 11, 5
    samples = _random_samples(rng, width, height, 2, (1 << bit_depth) - 1)
    pixels = decode_png(_image(width, height, 4, bit_depth, samples), ANY)
    expected = bytearray()
    shift = 8 if bit_depth == 16 else 0
    for row in samples:
        for grey, alpha in zip(row[0::2], row[1::2], strict=True):
            expected += bytes((grey >> shift,) * 3 + (alpha >> shift,))
    assert pixels.rgba == bytes(expected)


@pytest.mark.parametrize("bit_depth", [8, 16])
@pytest.mark.parametrize("keyed", [False, True], ids=["opaque", "with a transparent colour"])
def test_truecolour_images(bit_depth: int, keyed: bool) -> None:
    rng = random.Random(bit_depth + 60)
    width, height = 9, 7
    samples = _random_samples(rng, width, height, 3, (1 << bit_depth) - 1)
    key = tuple(samples[1][3:6])
    transparency = struct.pack(">HHH", *key) if keyed else b""
    pixels = decode_png(_image(width, height, 2, bit_depth, samples, transparency=transparency), ANY)
    shift = 8 if bit_depth == 16 else 0
    expected = bytearray()
    for row in samples:
        for start in range(0, len(row), 3):
            colour = tuple(row[start : start + 3])
            alpha = 0 if keyed and colour == key else 255
            expected += bytes((*(value >> shift for value in colour), alpha))
    assert pixels.rgba == bytes(expected)


def test_truecolour_with_alpha_at_16_bits_keeps_the_high_byte() -> None:
    rng = random.Random(80)
    width, height = 8, 4
    samples = _random_samples(rng, width, height, 4, 65535)
    pixels = decode_png(_image(width, height, 6, 16, samples), ANY)
    assert pixels.rgba == bytes(value >> 8 for row in samples for value in row)


@pytest.mark.parametrize("bit_depth", [1, 2, 4, 8])
def test_palette_images_with_and_without_transparency(bit_depth: int) -> None:
    rng = random.Random(bit_depth + 90)
    width, height, entries = 15, 6, 1 << bit_depth
    palette = bytes(rng.randrange(256) for _ in range(entries * 3))
    alphas = bytes(rng.randrange(256) for _ in range(max(1, entries // 2)))
    samples = _random_samples(rng, width, height, 1, entries - 1)
    for transparency in (b"", alphas):
        data = _image(width, height, 3, bit_depth, samples, palette=palette, transparency=transparency)
        expected = bytearray()
        for row in samples:
            for index in row:
                alpha = transparency[index] if index < len(transparency) else 255
                expected += palette[index * 3 : index * 3 + 3] + bytes((alpha,))
        assert decode_png(data, ANY).rgba == bytes(expected)


def test_an_index_past_the_palette_is_opaque_black() -> None:
    """PNG does not allow one, and the check does not look at pixels: the decoder must not fail on it."""
    data = _image(4, 1, 3, 8, [[0, 1, 2, 3]], palette=bytes((10, 20, 30, 40, 50, 60)))
    assert decode_png(data, ANY).rgba == bytes((10, 20, 30, 255, 40, 50, 60, 255)) + bytes((0, 0, 0, 255)) * 2


@pytest.mark.parametrize(
    "data",
    [
        b"not a png",
        make_png(40, 40)[:-12],  # no IEND
        assemble(header(40, 40, interlace=1), chunk(b"IDAT", zlib.compress(b"\x00" * 10)), chunk(b"IEND")),
        assemble(header(40, 40), chunk(b"IDAT", zlib.compress(b"\x00" * 99)), chunk(b"IEND")),  # too short
    ],
    ids=["no signature", "truncated", "interlaced", "wrong data length"],
)
def test_what_the_check_refuses_is_not_decoded(data: bytes) -> None:
    with pytest.raises(PngError):
        decode_png(data, ANY)


def test_decoding_applies_the_caller_s_limits() -> None:
    with pytest.raises(PngError):
        decode_png(make_png(240, 80), PngLimits(32, 200, 32, 600, 512 * 1024))


# ---- encoding ----------------------------------------------------------------------------------------


def test_an_encoded_image_is_opaque_rgb_and_reads_back_exactly() -> None:
    rng = random.Random(3)
    width, height = 31, 12
    rgb = bytes(rng.randrange(256) for _ in range(width * height * 3))
    data = encode_rgb_png(width, height, rgb)
    # 8-bit truecolour without alpha, and no tRNS: nothing in it can be transparent.
    assert struct.unpack(">IIBB", data[16:26]) == (width, height, 8, 2)
    assert chunk_types(data) == [b"IHDR", b"IDAT", b"IEND"]
    assert sanitize_png(data, ANY).data == data  # what the server writes passes its own check unchanged
    decoded = decode_png(data, ANY).rgba
    assert decoded[3::4] == b"\xff" * (width * height)
    assert bytes(b for index, b in enumerate(decoded) if index % 4 != 3) == rgb


def test_encoding_is_reproducible() -> None:
    rgb = bytes(range(256)) * 3
    assert encode_rgb_png(16, 16, rgb) == encode_rgb_png(16, 16, bytes(rgb))


@pytest.mark.parametrize(("width", "height", "length"), [(0, 1, 0), (2, 2, 11), (2, 2, 13)])
def test_encoding_refuses_pixels_that_are_not_the_size_given(width: int, height: int, length: int) -> None:
    with pytest.raises(ValueError, match="width \\* height"):
        encode_rgb_png(width, height, bytes(length))


# ---- flatten, downscale, frame -----------------------------------------------------------------------


def test_flattening_lays_every_alpha_over_the_background_exactly() -> None:
    background = (0x18, 0x21, 0x26)
    rgba = bytes(
        value for alpha in range(256) for colour in (0, 77, 255) for value in (colour, 255 - colour, 9, alpha)
    )
    pixels = Pixels(width=256 * 3, height=1, rgba=rgba)
    rgb = flatten(pixels, background)
    for index in range(256 * 3):
        red, green, blue, alpha = rgba[index * 4 : index * 4 + 4]
        for got, value, under in zip(
            rgb[index * 3 : index * 3 + 3], (red, green, blue), background, strict=True
        ):
            assert got == (alpha * value + (255 - alpha) * under + 127) // 255
    # Transparent is the background, opaque is the colour itself.
    assert rgb[:3] == bytes(background) and rgb[-3:] == bytes((255, 0, 9))


def test_area_averaging_counts_each_source_pixel_by_how_much_of_it_is_covered() -> None:
    # Three pixels to two: each new one covers one whole source pixel and half of the middle one.
    row = bytes((0, 0, 0, 90, 90, 90, 180, 180, 180))
    assert downscale(row, 3, 1, 2, 1) == bytes((30, 30, 30, 150, 150, 150))
    # Four by two to two by one: the means of two-by-two blocks.
    rgb = bytes((10, 20, 30) * 2 + (50, 60, 70) * 2 + (30, 40, 50) * 2 + (70, 80, 90) * 2)
    assert downscale(rgb, 4, 2, 2, 1) == bytes((20, 30, 40, 60, 70, 80))
    # One colour stays exactly that colour at any ratio.
    flat = bytes((0x1B, 0x3A, 0x6B)) * (609 * 159)
    assert downscale(flat, 609, 159, 336, 88) == bytes((0x1B, 0x3A, 0x6B)) * (336 * 88)


def test_area_averaging_keeps_the_mean() -> None:
    rng = random.Random(11)
    width, height = 97, 43
    rgb = bytes(rng.randrange(256) for _ in range(width * height * 3))
    small = downscale(rgb, width, height, 31, 17)
    assert len(small) == 31 * 17 * 3
    for channel in range(3):
        before = sum(rgb[channel::3]) / (width * height)
        after = sum(small[channel::3]) / (31 * 17)
        assert abs(before - after) < 0.6  # rounding only


def test_downscaling_neither_enlarges_nor_empties() -> None:
    rgb = bytes(12)
    assert downscale(rgb, 2, 2, 2, 2) is rgb
    for size in ((3, 2), (2, 3), (0, 1), (1, 0)):
        with pytest.raises(ValueError, match="smaller"):
            downscale(rgb, 2, 2, *size)


def test_a_frame_surrounds_the_image_on_every_side() -> None:
    rgb = bytes((1, 2, 3)) * 6  # 3 x 2
    out = framed(rgb, 3, 2, 2, (255, 255, 255))
    assert len(out) == 7 * 6 * 3
    rows = [out[y * 21 : (y + 1) * 21] for y in range(6)]
    white = b"\xff\xff\xff"
    assert rows[0] == rows[1] == rows[4] == rows[5] == white * 7
    assert rows[2] == rows[3] == white * 2 + bytes((1, 2, 3)) * 3 + white * 2
