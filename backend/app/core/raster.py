"""Drawing with decoded pixels, in pure Python (Phase 13, B13-3): what the e-mails need to make a logo of
their own from a company's stored one (`app.email.logos`). The pixels come from `app.core.png.decode_png`
(8-bit RGBA, straight alpha) and go back out through `app.core.png.encode_rgb_png` (opaque RGB).

* `flatten`: the image laid on an opaque colour, so nothing of it is transparent any more. Every pixel
  is `alpha * colour + (255 - alpha) * background`, divided by 255 and rounded, per sample.
* `downscale`: the image made smaller by **area averaging**: each new pixel is the mean of the source
  area it covers, every source pixel counted by how much of it lies inside, in exact integer
  arithmetic (a box filter for any ratio, not only whole ones). Never larger: a box filter does not
  enlarge.
* `framed`: the image with a margin of one colour around it.

The three work on whole rows with `bytes`, `bytearray` slices, `map` and lookup tables, never one pixel
at a time where that can be avoided: an image of 1200 x 600 pixels is 720,000 of them.
"""

import sys
from array import array
from functools import cache
from itertools import accumulate

from app.core.png import Pixels

type RGB = tuple[int, int, int]


@cache
def _blend_table(background: int) -> bytes:
    """Sample `background` under a sample of every value at every alpha: the byte at
    `alpha * 256 + value` is `(alpha * value + (255 - alpha) * background) / 255`, rounded."""
    return bytes(
        (alpha * value + (255 - alpha) * background + 127) // 255
        for alpha in range(256)
        for value in range(256)
    )


def flatten(pixels: Pixels, background: RGB) -> bytes:
    """`pixels` laid on `background`: opaque RGB, three samples a pixel, row after row."""
    count = pixels.width * pixels.height
    alpha = pixels.rgba[3::4]
    rgb = bytearray(count * 3)
    pairs = bytearray(count * 2)
    # Each sample's place in the table, `alpha * 256 + value`, as one unsigned 16-bit number a pixel.
    high, low = (1, 0) if sys.byteorder == "little" else (0, 1)
    pairs[high::2] = alpha
    for channel in range(3):
        pairs[low::2] = pixels.rgba[channel::4]
        places = array("H")
        places.frombytes(pairs)
        rgb[channel::3] = bytes(map(_blend_table(background[channel]).__getitem__, places))
    return bytes(rgb)


def _spans(source: int, target: int) -> list[list[tuple[int, int]]]:
    """For each of `target` new cells, the source cells under it and how much of each: source cell `i`
    is `[i * target, (i + 1) * target)` and new cell `j` is `[j * source, (j + 1) * source)`, so the
    weights are whole numbers and every new cell's weights add up to `source`."""
    spans = []
    for cell in range(target):
        start, end = cell * source, (cell + 1) * source
        first, last = start // target, (end - 1) // target
        spans.append(
            [
                (index, min(end, (index + 1) * target) - max(start, index * target))
                for index in range(first, last + 1)
            ]
        )
    return spans


def _lanes(row: bytes) -> int:
    """`row` as one integer with each byte in a 32-bit lane of its own: weighted sums of whole rows are
    then a few multiplications and additions of integers (no lane overflows into the next: the largest
    sum, 255 times the 600 rows a logo may have, needs 18 bits)."""
    spread = bytearray(len(row) * 4)
    spread[3::4] = row  # big-endian lanes: each byte in the lowest byte of its own
    return int.from_bytes(spread)


def _unlaned(total: int, count: int) -> array[int]:
    """The `count` 32-bit lanes of `total` (see `_lanes`) as numbers."""
    values = array("I")
    values.frombytes(total.to_bytes(count * 4))
    if sys.byteorder == "little":
        values.byteswap()  # the lanes were written big-endian
    return values


def downscale(rgb: bytes, width: int, height: int, to_width: int, to_height: int) -> bytes:
    """`rgb` (`width * height` pixels of three samples) at `to_width * to_height` by area averaging. The
    new size may not be larger than the old one either way."""
    if not (1 <= to_width <= width and 1 <= to_height <= height):
        raise ValueError("a downscale makes an image smaller, and keeps at least one pixel")
    if (to_width, to_height) == (width, height):
        return rgb
    stride = width * 3
    # Rows first: each new row is the weighted sum of the source rows it covers (weights add to `height`).
    lanes: dict[int, int] = {}
    rows: list[array[int]] = []
    for span in _spans(height, to_height):
        total = 0
        for index, weight in span:
            if index not in lanes:
                lanes[index] = _lanes(rgb[index * stride : (index + 1) * stride])
            total += weight * lanes[index]
        rows.append(_unlaned(total, stride))
        last = span[-1][0]
        lanes = {last: lanes[last]}  # a source row under two new rows is the last of the first
    # Then columns, one sample of the pixel at a time: the source cells a new cell covers whole weigh
    # `to_width` each, so their sum is a difference of running sums; the two cells at its ends weigh
    # less. The sum is divided by the whole weight (`width * height`) and rounded.
    columns = [(span[0], span[-1], span[0][0] + 1, span[-1][0]) for span in _spans(width, to_width)]
    whole = width * height
    half = whole // 2
    out = bytearray(to_width * to_height * 3)
    position = 0
    for row in rows:
        channels = [row[channel::3] for channel in range(3)]
        running = [[0, *accumulate(values)] for values in channels]
        for (first, first_weight), (last, last_weight), inner_start, inner_end in columns:
            for values, sums in zip(channels, running, strict=True):
                total = first_weight * values[first]
                if last != first:
                    total += last_weight * values[last] + to_width * (sums[inner_end] - sums[inner_start])
                out[position] = (total + half) // whole
                position += 1
    return bytes(out)


def framed(rgb: bytes, width: int, height: int, margin: int, background: RGB) -> bytes:
    """`rgb` (`width * height` pixels) with `margin` pixels of `background` on every side: an image of
    `(width + 2 * margin) * (height + 2 * margin)` pixels."""
    colour = bytes(background)
    outer = width + 2 * margin
    blank = colour * (outer * margin)
    side = colour * margin
    stride = width * 3
    body = b"".join(side + rgb[start : start + stride] + side for start in range(0, height * stride, stride))
    return blank + body + blank
