"""Regenerate the logo of the e-mail header: the white Mawdoo3 wordmark on the header's teal.

    python scripts/email_logo.py            (from the repository root; any Python 3.12+)
    python scripts/email_logo.py --check    (exit 1 when the packaged file is not what this writes)

Reads frontend/public/brand/logo-white.png (462 x 149, 8-bit RGBA, transparent) and writes
backend/app/email/assets/brand-logo.png: the same pixels composited onto EMAIL_HEADER_TEAL, opaque RGB
(docs/decisions/phase-10-backend.md, B10-17). The colour is baked into the image so that the logo stays
readable in mail clients that recolour or invert the header's background (dark modes): the wordmark then
shows on its own teal tile instead of disappearing white on white. Standard library only (zlib), and
reproducible: the same input always gives the same bytes.
"""

import argparse
import struct
import sys
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = REPO_ROOT / "frontend" / "public" / "brand" / "logo-white.png"
TARGET = REPO_ROOT / "backend" / "app" / "email" / "assets" / "brand-logo.png"
# The header band of every e-mail (backend/app/email/templates/macros.html, HEADER): mawdoo3.com's
# side-navigation teal. White on it is 4.70:1.
EMAIL_HEADER_TEAL = (0x18, 0x80, 0x86)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG file")
    chunks, position = [], len(PNG_SIGNATURE)
    while position < len(data):
        (length,) = struct.unpack(">I", data[position : position + 4])
        kind = data[position + 4 : position + 8]
        chunks.append((kind, data[position + 8 : position + 8 + length]))
        position += 12 + length
    return chunks


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def decode_rgba(data: bytes) -> tuple[int, int, list[bytearray]]:
    """Width, height and rows of an 8-bit RGBA, non-interlaced PNG (what the brand files are)."""
    chunks = _chunks(data)
    width, height, depth, colour, _compression, _filter, interlace = struct.unpack(">IIBBBBB", chunks[0][1])
    if (depth, colour, interlace) != (8, 6, 0):
        raise ValueError("expected an 8-bit RGBA PNG without interlacing")
    raw = zlib.decompress(b"".join(body for kind, body in chunks if kind == b"IDAT"))
    stride, rows, previous = width * 4, [], bytearray(width * 4)
    for y in range(height):
        start = y * (stride + 1)
        kind, row = raw[start], bytearray(raw[start + 1 : start + 1 + stride])
        for x in range(stride):
            left = row[x - 4] if x >= 4 else 0
            up = previous[x]
            upper_left = previous[x - 4] if x >= 4 else 0
            if kind == 1:
                row[x] = (row[x] + left) & 0xFF
            elif kind == 2:
                row[x] = (row[x] + up) & 0xFF
            elif kind == 3:
                row[x] = (row[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                row[x] = (row[x] + _paeth(left, up, upper_left)) & 0xFF
        rows.append(row)
        previous = row
    return width, height, rows


def composite(rows: list[bytearray], background: tuple[int, int, int]) -> list[bytes]:
    """RGB rows of the RGBA rows drawn over an opaque background (straight alpha, rounded)."""
    result = []
    for row in rows:
        out = bytearray()
        for x in range(0, len(row), 4):
            alpha = row[x + 3]
            for channel in range(3):
                out.append((row[x + channel] * alpha + background[channel] * (255 - alpha) + 127) // 255)
        result.append(bytes(out))
    return result


def _filtered(row: bytes, previous: bytes, kind: int) -> bytes:
    out = bytearray(len(row))
    for x, value in enumerate(row):
        left = row[x - 3] if x >= 3 else 0
        up = previous[x]
        upper_left = previous[x - 3] if x >= 3 else 0
        predictor = (0, left, up, (left + up) // 2, _paeth(left, up, upper_left))[kind]
        out[x] = (value - predictor) & 0xFF
    return bytes(out)


def encode_rgb(width: int, height: int, rows: list[bytes]) -> bytes:
    """An 8-bit RGB PNG; each row with the filter whose output has the smallest sum (the usual heuristic)."""
    raw, previous = bytearray(), bytes(width * 3)
    for row in rows:
        candidates = [_filtered(row, previous, kind) for kind in range(5)]
        kind = min(range(5), key=lambda k: sum(v if v < 128 else 256 - v for v in candidates[k]))
        raw += bytes([kind]) + candidates[kind]
        previous = row

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    body = zlib.compress(bytes(raw), 9)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", body) + chunk(b"IEND", b"")


def build() -> bytes:
    width, height, rows = decode_rgba(SOURCE.read_bytes())
    return encode_rgb(width, height, composite(rows, EMAIL_HEADER_TEAL))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="compare instead of writing")
    arguments = parser.parse_args(argv)
    logo = build()
    if arguments.check:
        if TARGET.read_bytes() != logo:
            print(f"{TARGET} is out of date: run python scripts/email_logo.py")
            return 1
        print(f"{TARGET} is up to date")
        return 0
    TARGET.write_bytes(logo)
    print(f"Wrote {TARGET} ({len(logo)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
