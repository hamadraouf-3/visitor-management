"""A small PNG reader for the QR codes the application draws (no image library): the module grid of a
QR PNG, to compare with segno's symbol for the expected payload (`app.core.qr.qr_matrix`)."""

import struct
import zlib

from app.core.qr import QR_QUIET_ZONE, QR_SCALE


def decode_png(data: bytes) -> list[list[int]]:
    """Pixels (0 = black) of a non-interlaced greyscale PNG with bit depth 1 or 8."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    position, idat, header = 8, b"", None
    while position < len(data):
        length, kind = struct.unpack(">I4s", data[position : position + 8])
        body = data[position + 8 : position + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        position += 12 + length
    assert header is not None
    width, height, depth, colour, _compression, _filter, interlace = header
    assert colour == 0 and interlace == 0 and depth in (1, 8)
    stride = (width * depth + 7) // 8
    raw = zlib.decompress(idat)
    rows: list[bytearray] = []
    previous = bytearray(stride)
    for y in range(height):
        kind, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for x in range(stride):
            left = line[x - 1] if x else 0
            up, up_left = previous[x], previous[x - 1] if x else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                estimate = left + up - up_left
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - up_left))
                predictor = (left, up, up_left)[distances.index(min(distances))]
                line[x] = (line[x] + predictor) & 0xFF
        rows.append(line)
        previous = line
    if depth == 8:
        return [list(row[:width]) for row in rows]
    return [[(row[x // 8] >> (7 - x % 8)) & 1 for x in range(width)] for row in rows]


def qr_modules(png: bytes) -> tuple[tuple[bool, ...], ...]:
    """The module grid of a QR PNG (dark = True), checking the scale and the quiet zone on the way."""
    pixels = decode_png(png)
    size = len(pixels)
    assert size == len(pixels[0]) and size % QR_SCALE == 0
    count = size // QR_SCALE
    grid = []
    for row in range(count):
        cells = []
        for column in range(count):
            block = {
                pixels[row * QR_SCALE + dy][column * QR_SCALE + dx]
                for dy in range(QR_SCALE)
                for dx in range(QR_SCALE)
            }
            assert len(block) == 1, "each module is a uniform 8x8 block"
            cells.append(block.pop() == 0)
        grid.append(cells)
    quiet = [*grid[:QR_QUIET_ZONE], *grid[-QR_QUIET_ZONE:]] + [
        row[:QR_QUIET_ZONE] + row[-QR_QUIET_ZONE:] for row in grid
    ]
    assert not any(any(row) for row in quiet), "a 4-module light quiet zone surrounds the symbol"
    return tuple(tuple(row[QR_QUIET_ZONE:-QR_QUIET_ZONE]) for row in grid[QR_QUIET_ZONE:-QR_QUIET_ZONE])
