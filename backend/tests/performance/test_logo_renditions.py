"""What drawing an e-mail's logo costs (opt-in: `pytest --performance -s tests/performance`; Phase 13,
B13-3 and B13-7).

The largest logo a company may have, 1200 x 600 pixels of RGBA, is drawn as an e-mail draws it
(`app.email.logos.draw`: decoded, laid on its plate, made smaller by area averaging, framed and written
again), with every row filtered by one of PNG's five filters in turn, by each filter alone (the slowest
is Paeth on every row), and as a browser's canvas writes such a picture (libpng's choice per row: the
filter whose bytes add up to the least). At 8 bits a channel, the most an upload may have since B13-7;
and at 16, which an upload is refused now but a logo stored before may have: the e-mails still decode
it. The numbers are printed and recorded in docs/decisions/phase-13-backend.md; the bound below is
generous, for a busy machine: the point of the cache (`RenditionCache`) and of drawing ahead
(`LogoWarmUp`) is that this is paid once per logo and process, and not by a request.
"""

import time
import zlib
from collections.abc import Sequence

import pytest

from app.core.png import PngError, PngProblem, sanitize_png
from app.email.logos import LIGHT_HEADER, RenditionCache, draw
from app.models import BrandAssetKind
from app.services.brand import IMAGE_LIMITS
from tests.png_support import _paeth, assemble, chunk, header

pytestmark = pytest.mark.performance

WIDTH, HEIGHT = 1200, 600


def _picture() -> list[bytes]:
    """A logo-like picture: navy shapes on transparency, with soft edges."""
    rows = []
    for y in range(HEIGHT):
        row = bytearray(WIDTH * 4)
        for x in range(WIDTH):
            if (x // 40 + y // 30) % 3 == 0 or abs(x - WIDTH // 2) + abs(y - HEIGHT // 2) < HEIGHT // 3:
                row[x * 4 : x * 4 + 4] = bytes((0x1B, 0x3A, 0x6B, 255))
            elif (x + y) % 97 < 2:
                row[x * 4 : x * 4 + 4] = bytes((0x1B, 0x3A, 0x6B, 128))
        rows.append(bytes(row))
    return rows


def _deeper(rows: Sequence[bytes]) -> list[bytes]:
    """The same picture at 16 bits a channel: each sample twice (0x1B becomes 0x1B1B)."""
    return [bytes(byte for value in row for byte in (value, value)) for row in rows]


def _filtered_row(row: bytes, prior: bytes, kind: int, step: int) -> bytes:
    line = bytearray(len(row))
    for index, value in enumerate(row):
        left = row[index - step] if index >= step else 0
        above = prior[index]
        corner = prior[index - step] if index >= step else 0
        guess = (0, left, above, (left + above) // 2, _paeth(left, above, corner))[kind]
        line[index] = (value - guess) & 0xFF
    return bytes(line)


def _encoded(rows: Sequence[bytes], choose: str | int, bit_depth: int) -> bytes:
    step = 4 * bit_depth // 8
    out, prior = [], bytes(len(rows[0]))
    for number, row in enumerate(rows):
        if choose == "adaptive":
            options = [(kind, _filtered_row(row, prior, kind, step)) for kind in range(5)]
            kind, line = min(options, key=lambda option: sum(b if b < 128 else 256 - b for b in option[1]))
        else:
            kind = number % 5 if choose == "cycle" else int(choose)
            line = _filtered_row(row, prior, kind, step)
        out.append(bytes([kind]) + line)
        prior = row
    return assemble(
        header(WIDTH, HEIGHT, bit_depth=bit_depth),
        chunk(b"IDAT", zlib.compress(b"".join(out), 9)),
        chunk(b"IEND"),
    )


@pytest.mark.parametrize(
    ("choose", "bit_depth"),
    [("adaptive", 8), ("cycle", 8), (0, 8), (1, 8), (2, 8), (3, 8), (4, 8), ("adaptive", 16), (4, 16)],
)
def test_drawing_the_largest_logo(choose: str | int, bit_depth: int) -> None:
    rows = _picture()
    data = _encoded(rows if bit_depth == 8 else _deeper(rows), choose, bit_depth)
    if bit_depth == 16:
        # Refused as an upload (B13-7): only a logo stored before can be one of these.
        with pytest.raises(PngError) as refused:
            sanitize_png(data, IMAGE_LIMITS[BrandAssetKind.LOGO])
        assert refused.value.problem is PngProblem.BIT_DEPTH
    timings = []
    for _ in range(3):
        began = time.perf_counter()
        draw(data, LIGHT_HEADER)
        timings.append(time.perf_counter() - began)
    cache = RenditionCache()
    cache.rendition(data, LIGHT_HEADER)  # drawn once
    began = time.perf_counter()
    for _ in range(100):
        cache.rendition(data, LIGHT_HEADER)
    found = (time.perf_counter() - began) / 100
    print(
        f"\n1200 x 600 RGBA at {bit_depth} bits, filters {choose}: {len(data):,} bytes; "
        f"drawn in {min(timings):.3f} s (best of 3, all {', '.join(f'{t:.2f}' for t in timings)}); "
        f"found again in {found * 1000:.2f} ms"
    )
    assert cache.drawn == 1
    assert min(timings) < 10
