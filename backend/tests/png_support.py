"""PNG files for the tests, built chunk by chunk with the standard library: valid ones of any shape, and the
parts to assemble invalid ones (Phase 12: `app.core.png` and the brand endpoints); since Phase 13 also an
encoder of PNG's five filters written apart from the decoder under test, and drawn logos of the shapes the
owner's report was about (a navy wordmark with a diamond, the diamond alone, a gold wordmark)."""

import hashlib
import struct
import uuid
import zlib
from collections.abc import Callable, Sequence
from functools import cache

from app.models import BrandAssetKind
from app.repositories.brand import BrandImage, BrandImageInfo

SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Colour type -> samples per pixel.
SAMPLES = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def chunk(kind: bytes, body: bytes = b"", *, crc: int | None = None) -> bytes:
    """One chunk; `crc` to write a wrong one."""
    checksum = zlib.crc32(kind + body) if crc is None else crc
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", checksum)


def header(
    width: int,
    height: int,
    *,
    bit_depth: int = 8,
    colour_type: int = 6,
    compression: int = 0,
    filtering: int = 0,
    interlace: int = 0,
) -> bytes:
    return chunk(
        b"IHDR",
        struct.pack(">IIBBBBB", width, height, bit_depth, colour_type, compression, filtering, interlace),
    )


def row_bytes(width: int, bit_depth: int, colour_type: int) -> int:
    return (width * SAMPLES[colour_type] * bit_depth + 7) // 8


def scanlines(
    width: int,
    height: int,
    *,
    bit_depth: int = 8,
    colour_type: int = 6,
    fill: int = 0x55,
    filter_type: int = 0,
) -> bytes:
    """The raw image data: per row a filter byte and the packed pixels (all of one value)."""
    return (bytes([filter_type]) + bytes([fill]) * row_bytes(width, bit_depth, colour_type)) * height


def image_data(raw: bytes, *, pieces: int = 1, level: int = 9) -> list[bytes]:
    """`raw` deflated, as `pieces` IDAT chunks."""
    stream = zlib.compress(raw, level)
    size = max(1, -(-len(stream) // pieces))
    return [chunk(b"IDAT", stream[start : start + size]) for start in range(0, len(stream), size)]


def assemble(*chunks: bytes) -> bytes:
    return SIGNATURE + b"".join(chunks)


def make_png(
    width: int = 240,
    height: int = 80,
    *,
    bit_depth: int = 8,
    colour_type: int = 6,
    fill: int = 0x55,
    before_data: Sequence[bytes] = (),
    after_data: Sequence[bytes] = (),
    pieces: int = 1,
) -> bytes:
    """A valid PNG of that shape. A palette image gets a full palette; `before_data` and `after_data` are
    extra chunks around the image data."""
    entries = 3 * (1 << bit_depth)
    palette = [chunk(b"PLTE", bytes(value % 256 for value in range(entries)))] if colour_type == 3 else []
    raw = scanlines(width, height, bit_depth=bit_depth, colour_type=colour_type, fill=fill)
    return assemble(
        header(width, height, bit_depth=bit_depth, colour_type=colour_type),
        *palette,
        *before_data,
        *image_data(raw, pieces=pieces),
        *after_data,
        chunk(b"IEND"),
    )


def chunk_types(data: bytes) -> list[bytes]:
    """The chunk types of a PNG, in order."""
    position, kinds = len(SIGNATURE), []
    while position < len(data):
        (length,) = struct.unpack_from(">I", data, position)
        kinds.append(data[position + 4 : position + 8])
        position += 12 + length
    return kinds


def png_size(data: bytes) -> tuple[int, int]:
    """The width and height in a PNG's header."""
    width, height = struct.unpack_from(">II", data, len(SIGNATURE) + 8)
    return width, height


class CompanyLogos:
    """Where the e-mail service finds a company's logos, for tests without a database
    (`app.email.service.BrandImageSource`): every company has this logo, and this logo for dark surfaces
    when one is given (`dark`, a PNG whose size is read from its header)."""

    def __init__(self, content: bytes, width: int, height: int, *, dark: bytes | None = None) -> None:
        self.content, self.width, self.height = content, width, height
        self.dark = dark

    def image(self, company_id: uuid.UUID, kind: BrandAssetKind) -> BrandImage | None:
        if kind is BrandAssetKind.LOGO:
            content, width, height = self.content, self.width, self.height
        elif kind is BrandAssetKind.LOGO_DARK and self.dark is not None:
            content, (width, height) = self.dark, png_size(self.dark)
        else:
            return None
        digest = hashlib.sha256(content).hexdigest()
        info = BrandImageInfo(kind, "0" * 16, digest, len(content), width, height)
        return BrandImage(info, content)


# A logo (240 x 80, 8-bit RGBA) and a square icon (192 x 192), as a browser's canvas writes them.
SAMPLE_LOGO = make_png(240, 80)
SAMPLE_ICON = make_png(192, 192, fill=0x33)


# ---- drawn logos (Phase 13): pictures with transparent surroundings and soft edges ----------------------

type Rgba = tuple[int, int, int, int]
# A drawing: the colour at a point of the picture (in pixels, from its top left), or None where it is clear.
type Drawing = Callable[[float, float], Rgba | None]


def _paeth(left: int, above: int, corner: int) -> int:
    estimate = left + above - corner
    a, b, c = abs(estimate - left), abs(estimate - above), abs(estimate - corner)
    return left if a <= b and a <= c else above if b <= c else corner


def filtered(rows: Sequence[bytes], step: int, filter_types: Sequence[int]) -> bytes:
    """Scanlines of `rows` (raw samples, `step` bytes a pixel), row `y` filtered with
    `filter_types[y % len(filter_types)]`: the encoder's side of PNG's five filters, written apart from
    the decoder under test."""
    out, prior = [], bytes(len(rows[0]))
    for number, row in enumerate(rows):
        kind = filter_types[number % len(filter_types)]
        line = bytearray(len(row))
        for index, value in enumerate(row):
            left = row[index - step] if index >= step else 0
            above = prior[index]
            corner = prior[index - step] if index >= step else 0
            guess = (0, left, above, (left + above) // 2, _paeth(left, above, corner))[kind]
            line[index] = (value - guess) & 0xFF
        out.append(bytes([kind]) + bytes(line))
        prior = row
    return b"".join(out)


def rgba_png(width: int, height: int, rgba: bytes, *, filter_types: Sequence[int] = (1, 2, 3, 4, 0)) -> bytes:
    """An 8-bit RGBA PNG of `rgba`, its rows filtered in turn with each of `filter_types`."""
    stride = width * 4
    rows = [rgba[start : start + stride] for start in range(0, height * stride, stride)]
    return assemble(
        header(width, height),
        chunk(b"IDAT", zlib.compress(filtered(rows, 4, filter_types), 9)),
        chunk(b"IEND"),
    )


def drawn_rgba(width: int, height: int, drawing: Drawing, *, samples: int = 2) -> bytes:
    """RGBA pixels of `drawing`, each the mean of `samples` x `samples` points inside it (edges come out
    partly transparent, as a browser draws them)."""
    out = bytearray(width * height * 4)
    points = [(i + 0.5) / samples for i in range(samples)]
    whole = samples * samples
    for y in range(height):
        for x in range(width):
            red = green = blue = alpha = 0
            for dy in points:
                for dx in points:
                    colour = drawing(x + dx, y + dy)
                    if colour is not None:
                        red += colour[0] * colour[3]
                        green += colour[1] * colour[3]
                        blue += colour[2] * colour[3]
                        alpha += colour[3]
            offset = (y * width + x) * 4
            if alpha:
                out[offset : offset + 4] = bytes(
                    (round(red / alpha), round(green / alpha), round(blue / alpha), round(alpha / whole))
                )
    return bytes(out)


NAVY: Rgba = (0x1B, 0x3A, 0x6B, 255)
GOLD: Rgba = (0xC9, 0xA2, 0x4A, 255)
WHITE: Rgba = (255, 255, 255, 255)
SKY: Rgba = (0x4F, 0x9B, 0xE0, 255)


def _diamond(x: float, y: float, cx: float, cy: float, rx: float, ry: float) -> bool:
    return abs(x - cx) / rx + abs(y - cy) / ry <= 1


def _letters(x: float, y: float, start: float, end: float, top: float, bottom: float, count: int) -> bool:
    """Blocks of a wordmark: `count` letters between `start` and `end`, each a frame with a bar through
    it, so the word has counters and strokes like type."""
    pitch = (end - start) / count
    if not (start <= x < end and top <= y < bottom):
        return False
    within = (x - start) % pitch
    stroke = pitch * 0.18
    if within > pitch * 0.78:
        return False  # the space after the letter
    middle = (top + bottom) / 2
    return (
        within < stroke or within > pitch * 0.78 - stroke or abs(y - middle) < stroke / 2 or y < top + stroke
    )


def navy_wordmark(x: float, y: float) -> Rgba | None:
    """A bank's logo for light surfaces (609 x 159): a navy diamond and a navy wordmark, transparent
    around them (the logo of the owner's report)."""
    if _diamond(x, y, 78, 79.5, 64, 70):
        return NAVY
    return NAVY if _letters(x, y, 168, 600, 50, 110, 11) else None


def diamond_mark(x: float, y: float) -> Rgba | None:
    """The same bank's logo for dark surfaces (423 x 570): its diamond alone, in gold and sky blue, cut in
    four by opaque white lines."""
    cx, cy = 211.5, 285
    if not _diamond(x, y, cx, cy, 200, 270):
        return None
    if abs(x - cx) < 6 or abs(y - cy) < 6:
        return WHITE
    return GOLD if (x < cx) == (y < cy) else SKY


def gold_wordmark(x: float, y: float) -> Rgba | None:
    """A logo for dark surfaces that is a wordmark (661 x 109): gold type, transparent around it."""
    return GOLD if _letters(x, y, 8, 653, 16, 93, 14) else None


@cache
def drawn_logo(name: str) -> bytes:
    """One of the drawn logos as the stored PNG (sanitised as an upload is), drawn once per test run:
    `navy` (609 x 159), `mark` (423 x 570), `gold` (661 x 109)."""
    width, height, drawing = {
        "navy": (609, 159, navy_wordmark),
        "mark": (423, 570, diamond_mark),
        "gold": (661, 109, gold_wordmark),
    }[name]
    return rgba_png(width, height, drawn_rgba(width, height, drawing))
