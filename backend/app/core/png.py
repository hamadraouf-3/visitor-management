"""Strict validation and re-serialisation of an uploaded PNG, in pure Python (Phase 12, B12-2).

A company's logo and icon are uploaded by the platform owner's browser, which decodes whatever file was
chosen, resizes it and encodes a PNG. The server trusts none of that. It has no image library and gains
no native decoder for untrusted input: what it stores and serves is decided here, with the standard
library's `struct` and `zlib` only. `sanitize_png` accepts exactly this:

* the PNG signature, then chunks whose length fits the file and whose CRC-32 is right;
* `IHDR` first, 13 bytes: a colour type and bit depth that PNG defines, compression and filter method 0,
  and **no interlacing** (Adam7 is refused: nothing the product makes is interlaced, and it would be a
  second, rarely used way to lay out every image);
* dimensions inside the caller's limits, checked on the header alone, before anything is inflated;
* at most one `PLTE` (required for palette images, refused for grey ones) and at most one `tRNS`, each
  where and as long as PNG allows; `IDAT` chunks in one run; `IEND` last, empty, with nothing after it;
* no animation (`acTL`, `fcTL`, `fdAT`) and no critical chunk this module does not know;
* the `IDAT` data is one zlib stream that inflates to exactly the bytes the header implies: `height`
  scanlines of one filter byte and the packed pixels. Inflation stops one byte past that, so a stream
  that would expand further (a decompression bomb) costs no more memory than a valid image; a stream
  that ends early, or has anything after it, is refused. Every scanline's filter type is one PNG defines.

What is stored is written again from the parts that draw the image: the signature, `IHDR` (from the
parsed fields), `PLTE` (palette images only), `tRNS` (where the colour type allows one), the image data
as one `IDAT` chunk and `IEND`, each with a new CRC. Text, time stamps, ICC profiles, gamma, physical
size, EXIF and every other ancillary chunk are dropped, as is whatever followed `IEND`. The zlib stream
is carried over as it is (it was proven above to be exactly the image) rather than compressed again:
the output then depends on the input alone, not on the zlib that happens to be installed, and writing a
written file again changes nothing.

What this does not do: it does not decode pixels, so it cannot say what an image shows. Bytes an
attacker chose survive as pixel values (and as palette entries). They are served as `image/png` with
`X-Content-Type-Options: nosniff`, never as anything a browser would run (docs/security.md).

A caller's limits may also bound the bit depth (`PngLimits.max_bit_depth`, checked on the header too):
a logo is uploaded at 8 bits a channel since Phase 13 (B13-7), the depth a browser's canvas writes.

What a check costs (measured with `tracemalloc`, tests/unit/test_png.py holds the bound): for a moment
twice what the image inflates to, plus copies of the file; for the largest image at 16 bits a channel
(1200 x 600 pixels of 8 bytes, 5.5 MiB inflated: a logo stored before B13-7, which the e-mails still
decode) 11 MiB, 12 MiB with a file at the 512 KiB limit; for the largest logo an upload may be now (8
bits, 2.7 MiB inflated) half that; 4 MiB for the largest icon. A valid image, a bomb and every other
refusal cost the same, and none of it is kept once `sanitize_png` returns or raises: the inflated bytes
are let go of before a refusal is raised.

Drawing (Phase 13, B13-3). The e-mails show a company's logo as an opaque picture of their own
(`app.email.logos`), so the server now reads pixels too, still with the standard library alone:
`decode_png` turns an image that `sanitize_png` accepts into 8-bit RGBA, and `encode_rgb_png` writes an
opaque 8-bit RGB image. Decoding runs `sanitize_png` first, so it meets only what the check accepts (and
inflates no more than the header implies); it reads every colour type and bit depth PNG defines and the
five filter types. Average and Paeth are undone one byte at a time, which is what makes decoding slow in
Python: about 2 s for the largest logo an upload may be (1200 x 600, 8 bits, Paeth on every row), about
3.6 s for one at 16 bits stored before B13-7 (B13-3 and B13-7 have the measurements). That is why the
e-mails draw a logo once per process, ahead of the requests that send it, and keep what they drew.
"""

import struct
import zlib
from dataclasses import dataclass
from enum import StrEnum
from itertools import accumulate

SIGNATURE = b"\x89PNG\r\n\x1a\n"
# The largest chunk PNG allows; a real limit comes from the size of the file.
_MAX_CHUNK_LENGTH = 2**31 - 1
# Colour type -> (samples per pixel, bit depths PNG allows for it).
_COLOUR_TYPES: dict[int, tuple[int, tuple[int, ...]]] = {
    0: (1, (1, 2, 4, 8, 16)),  # greyscale
    2: (3, (8, 16)),  # truecolour
    3: (1, (1, 2, 4, 8)),  # palette
    4: (2, (8, 16)),  # greyscale with alpha
    6: (4, (8, 16)),  # truecolour with alpha
}
_PALETTE = 3
_ANIMATION_CHUNKS = frozenset({b"acTL", b"fcTL", b"fdAT"})
_ASCII_LETTERS = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_FILTER_TYPES = 5  # None, Sub, Up, Average, Paeth


class PngProblem(StrEnum):
    """Why a file was refused. For tests and logs; the API reports one field code for all of them
    (`invalid_image`), with a message for the two a person can act on (interlaced, animated)."""

    SIZE = "size"  # more bytes than the limit
    SIGNATURE = "signature"  # not a PNG
    TRUNCATED = "truncated"  # the file ends inside a chunk, or before IEND
    CHUNK = "chunk"  # a chunk's length, type or CRC
    HEADER = "header"  # IHDR missing, misplaced, repeated or invalid
    TOO_SMALL = "too_small"  # a valid header, smaller than the limits
    TOO_LARGE = "too_large"  # a valid header, larger than the limits
    NOT_SQUARE = "not_square"  # a valid header of an image that must be square
    INTERLACED = "interlaced"
    ANIMATED = "animated"
    BIT_DEPTH = "bit_depth"  # a valid header, more bits a sample than the limits allow
    ORDER = "order"  # a chunk where PNG does not allow it
    PALETTE = "palette"  # PLTE or tRNS missing, forbidden or of the wrong size
    UNKNOWN_CRITICAL = "unknown_critical"  # a critical chunk this module does not know
    DATA = "data"  # the image data is not exactly the image the header describes
    TRAILING = "trailing"  # bytes after IEND


class PngError(ValueError):
    """The bytes are not a PNG this product stores."""

    def __init__(self, problem: PngProblem) -> None:
        super().__init__(f"not an acceptable PNG ({problem.value})")
        self.problem = problem


class PngTooSmall(PngError):
    def __init__(self) -> None:
        super().__init__(PngProblem.TOO_SMALL)


class PngTooLarge(PngError):
    def __init__(self) -> None:
        super().__init__(PngProblem.TOO_LARGE)


class PngNotSquare(PngError):
    def __init__(self) -> None:
        super().__init__(PngProblem.NOT_SQUARE)


@dataclass(frozen=True, slots=True)
class PngLimits:
    """What an image may be: its dimensions in pixels (inclusive), whether it must be square, the most
    bytes the file may have, and the most bits a sample may have."""

    min_width: int
    max_width: int
    min_height: int
    max_height: int
    max_bytes: int
    square: bool = False
    max_bit_depth: int = 16


@dataclass(frozen=True, slots=True)
class Png:
    """An accepted image: `data` is the re-serialised file, the only bytes to store or serve."""

    data: bytes
    width: int
    height: int
    bit_depth: int
    colour_type: int


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def _check_transparency(colour_type: int, bit_depth: int, body: bytes, palette_entries: int) -> None:
    """`tRNS` as PNG allows it: an alpha per palette entry (never more than there are entries), or the
    one transparent sample value of a grey or truecolour image, inside the bit depth's range."""
    if colour_type == _PALETTE:
        if not 1 <= len(body) <= palette_entries:
            raise PngError(PngProblem.PALETTE)
        return
    if colour_type not in (0, 2) or len(body) != (2 if colour_type == 0 else 6):
        raise PngError(PngProblem.PALETTE)  # images with an alpha channel have no tRNS
    if any(sample >> bit_depth for (sample,) in struct.iter_unpack(">H", body)):
        raise PngError(PngProblem.PALETTE)


def _inflate(stream: bytes, expected: int) -> bytes:
    """The image data, which must inflate to exactly `expected` bytes. At most one byte more is ever
    produced: a stream that goes on (a decompression bomb) is refused at that byte.

    While zlib works this costs up to twice `expected` (the pieces it inflates into, then the one
    object they become); afterwards `expected`. A refusal gives all of it back before it is raised: an
    exception keeps the frames it passed through alive, with every local in them, for as long as
    anything keeps the exception (a handler's `as` name, a later exception's `__context__`, a reference
    cycle that only the garbage collector ends). The inflated bytes must not be among those locals."""
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(stream, expected + 1)
    except zlib.error:
        raise PngError(PngProblem.DATA) from None
    exact = (
        len(raw) == expected and inflater.eof and not inflater.unconsumed_tail and not inflater.unused_data
    )
    if not exact:
        del raw, inflater  # the inflated bytes, and what the stream had left
        raise PngError(PngProblem.DATA)
    return raw


def sanitize_png(data: bytes, limits: PngLimits) -> Png:
    """`data` as an image the product stores (see the module), or `PngError`: `PngTooSmall`,
    `PngTooLarge` and `PngNotSquare` for a valid header outside `limits`, the base class for everything
    else."""
    if len(data) > limits.max_bytes:
        raise PngError(PngProblem.SIZE)
    if data[: len(SIGNATURE)] != SIGNATURE:
        raise PngError(PngProblem.SIGNATURE)

    position = len(SIGNATURE)
    header: tuple[int, int, int, int] | None = None  # width, height, bit depth, colour type
    palette: bytes | None = None
    transparency: bytes | None = None
    image_data: list[bytes] = []
    data_ended = False  # a chunk followed the IDAT run
    ended = False
    while position < len(data):
        if ended:
            raise PngError(PngProblem.TRAILING)
        if len(data) - position < 12:
            raise PngError(PngProblem.TRUNCATED)
        length, kind = struct.unpack_from(">I4s", data, position)
        if any(byte not in _ASCII_LETTERS for byte in kind) or not kind[2:3].isupper():
            raise PngError(PngProblem.CHUNK)  # not a chunk type (the third letter is reserved: upper case)
        if length > _MAX_CHUNK_LENGTH or length > len(data) - position - 12:
            raise PngError(PngProblem.TRUNCATED)
        body = data[position + 8 : position + 8 + length]
        (crc,) = struct.unpack_from(">I", data, position + 8 + length)
        if crc != zlib.crc32(kind + body):
            raise PngError(PngProblem.CHUNK)
        position += 12 + length

        if header is None:
            if kind != b"IHDR" or length != 13:
                raise PngError(PngProblem.HEADER)
            width, height, bit_depth, colour_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if colour_type not in _COLOUR_TYPES or bit_depth not in _COLOUR_TYPES[colour_type][1]:
                raise PngError(PngProblem.HEADER)
            if compression != 0 or filtering != 0 or interlace not in (0, 1):
                raise PngError(PngProblem.HEADER)
            if not (1 <= width <= _MAX_CHUNK_LENGTH and 1 <= height <= _MAX_CHUNK_LENGTH):
                raise PngError(PngProblem.HEADER)
            # The limits before anything else of the file is looked at: a header that promises a huge
            # image is refused here, whatever its data would inflate to.
            if width > limits.max_width or height > limits.max_height:
                raise PngTooLarge()
            if width < limits.min_width or height < limits.min_height:
                raise PngTooSmall()
            if limits.square and width != height:
                raise PngNotSquare()
            if bit_depth > limits.max_bit_depth:
                raise PngError(PngProblem.BIT_DEPTH)
            if interlace:
                raise PngError(PngProblem.INTERLACED)
            header = (width, height, bit_depth, colour_type)
            continue

        width, height, bit_depth, colour_type = header
        if kind == b"IHDR":
            raise PngError(PngProblem.HEADER)
        if kind in _ANIMATION_CHUNKS:
            raise PngError(PngProblem.ANIMATED)
        if kind == b"IDAT":
            if data_ended:
                raise PngError(PngProblem.ORDER)  # the IDAT chunks are one run
            image_data.append(body)
            continue
        if image_data:
            data_ended = True
        if kind == b"IEND":
            if length:
                raise PngError(PngProblem.CHUNK)
            ended = True
        elif kind == b"PLTE":
            if palette is not None or transparency is not None or image_data:
                raise PngError(PngProblem.ORDER)
            entries, rest = divmod(length, 3)
            if colour_type in (0, 4) or rest or not 1 <= entries <= 256:
                raise PngError(PngProblem.PALETTE)
            if colour_type == _PALETTE and entries > 1 << bit_depth:
                raise PngError(PngProblem.PALETTE)
            palette = body
        elif kind == b"tRNS":
            if transparency is not None or image_data:
                raise PngError(PngProblem.ORDER)
            if colour_type == _PALETTE and palette is None:
                raise PngError(PngProblem.ORDER)  # after the palette it refers to
            _check_transparency(colour_type, bit_depth, body, len(palette or b"") // 3)
            transparency = body
        elif kind[:1].isupper():
            raise PngError(PngProblem.UNKNOWN_CRITICAL)
        # Any other ancillary chunk (text, time, colour space, physical size, ...): checked, dropped.

    if header is None or not ended:
        raise PngError(PngProblem.TRUNCATED)
    width, height, bit_depth, colour_type = header
    if colour_type == _PALETTE and palette is None:
        raise PngError(PngProblem.PALETTE)
    if not image_data:
        raise PngError(PngProblem.DATA)

    samples = _COLOUR_TYPES[colour_type][0]
    stride = 1 + (width * samples * bit_depth + 7) // 8  # the filter byte and the packed pixels
    stream = b"".join(image_data)
    raw = _inflate(stream, height * stride)
    filters_defined = max(raw[::stride]) < _FILTER_TYPES
    # Nothing else is read from the pixels, and nothing below may keep them: not the file that is
    # written next, and not a refusal's traceback (see `_inflate`).
    del raw
    if not filters_defined:
        raise PngError(PngProblem.DATA)

    parts = [
        SIGNATURE,
        _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, bit_depth, colour_type, 0, 0, 0)),
    ]
    if colour_type == _PALETTE and palette is not None:
        parts.append(_chunk(b"PLTE", palette))  # a truecolour image's suggested palette is dropped
    if transparency is not None:
        parts.append(_chunk(b"tRNS", transparency))
    parts += [_chunk(b"IDAT", stream), _chunk(b"IEND", b"")]
    return Png(data=b"".join(parts), width=width, height=height, bit_depth=bit_depth, colour_type=colour_type)


# ---- drawing (Phase 13, B13-3) -----------------------------------------------------------------------

# The low byte of an int: the sum of two samples as PNG adds them (modulo 256).
_LOW_BYTE = (255).__and__
# Grey samples of fewer than 8 bits, scaled to 8: 0 is black and the largest value white.
_GREY_SCALE = {1: 255, 2: 85, 4: 17}


@dataclass(frozen=True, slots=True)
class Pixels:
    """A decoded image: `width * height` pixels, row after row, each four 8-bit samples (red, green,
    blue, alpha). Alpha is straight (not premultiplied) and 255 is opaque."""

    width: int
    height: int
    rgba: bytes


def _parts(written: bytes) -> tuple[bytes, bytes, bytes]:
    """The palette, the transparency and the image data of a file `sanitize_png` wrote (a known shape:
    at most one chunk of each, with correct lengths)."""
    parts = {b"PLTE": b"", b"tRNS": b"", b"IDAT": b""}
    position = len(SIGNATURE)
    while position < len(written):
        length, kind = struct.unpack_from(">I4s", written, position)
        if kind in parts:
            parts[kind] = written[position + 8 : position + 8 + length]
        position += 12 + length
    return parts[b"PLTE"], parts[b"tRNS"], parts[b"IDAT"]


def _added(first: bytes, second: bytes, low: int, high: int) -> bytes:
    """Byte by byte, `first + second` modulo 256, as one addition of two integers: the low seven bits of
    every byte are added (no carry leaves a byte), the top bit is the exclusive or of the three."""
    a, b = int.from_bytes(first), int.from_bytes(second)
    return (((a & low) + (b & low)) ^ ((a ^ b) & high)).to_bytes(len(first))


def _sub(row: bytes, step: int) -> bytes:
    """A row filtered with Sub (each byte less the one a pixel to its left): running sums, one sample
    of the pixel at a time."""
    line = bytearray(len(row))
    for start in range(step):
        line[start::step] = bytes(map(_LOW_BYTE, accumulate(row[start::step])))
    return bytes(line)


def _average(row: bytes, prior: bytes, step: int) -> bytes:
    """A row filtered with Average (each byte less the mean of the one on the left and the one above)."""
    line = bytearray(row)
    for index in range(min(step, len(line))):
        line[index] = (line[index] + (prior[index] >> 1)) & 255
    for index in range(step, len(line)):
        line[index] = (line[index] + ((line[index - step] + prior[index]) >> 1)) & 255
    return bytes(line)


def _paeth(row: bytes, prior: bytes, step: int) -> bytes:
    """A row filtered with Paeth (each byte less whichever of left, above and upper left is nearest to
    left + above - upper left; on a tie in that order)."""
    if not any(prior):
        # Above and upper left are 0 (the first row, a transparent band): left is always the nearest.
        return _sub(row, step)
    line = bytearray(row)
    for index in range(min(step, len(line))):
        line[index] = (line[index] + prior[index]) & 255  # nothing on the left: the byte above is nearest
    for index in range(step, len(line)):
        left, above, corner = line[index - step], prior[index], prior[index - step]
        from_left, from_above = above - corner, left - corner  # the estimate less left, less above
        from_corner = abs(from_left + from_above)
        from_left, from_above = abs(from_left), abs(from_above)
        if from_left <= from_above and from_left <= from_corner:
            line[index] = (line[index] + left) & 255
        elif from_above <= from_corner:
            line[index] = (line[index] + above) & 255
        else:
            line[index] = (line[index] + corner) & 255
    return bytes(line)


def _unfiltered(raw: bytes, height: int, length: int, step: int) -> bytes:
    """The scanlines of `raw` with their filters undone and their filter bytes dropped: `height` rows of
    `length` bytes. `step` is the bytes of one pixel (one, for pixels smaller than a byte)."""
    rows: list[bytes] = []
    prior = bytes(length)
    low, high = int.from_bytes(b"\x7f" * length), int.from_bytes(b"\x80" * length)
    for start in range(0, height * (length + 1), length + 1):
        kind, row = raw[start], raw[start + 1 : start + 1 + length]
        if kind == 1:
            row = _sub(row, step)
        elif kind == 2:
            row = _added(row, prior, low, high)
        elif kind == 3:
            row = _average(row, prior, step)
        elif kind == 4:
            row = _paeth(row, prior, step)
        rows.append(row)
        prior = row
    return b"".join(rows)


def _unpacked(data: bytes, width: int, height: int, bit_depth: int) -> bytes:
    """Samples of fewer than 8 bits, one byte each (their value, not scaled), row after row."""
    per_byte, mask = 8 // bit_depth, (1 << bit_depth) - 1
    table = [
        bytes((value >> (8 - bit_depth * (place + 1))) & mask for place in range(per_byte))
        for value in range(256)
    ]
    length = (width * bit_depth + 7) // 8
    return b"".join(
        b"".join(map(table.__getitem__, data[start : start + length]))[:width]
        for start in range(0, height * length, length)
    )


def _keyed_alpha(samples: bytes, size: int, key: bytes) -> bytes:
    """The alpha of an image with one transparent colour (`tRNS` of a grey or truecolour image): 0
    where a pixel's `size` bytes are exactly `key`, 255 everywhere else."""
    return bytes(0 if samples[start : start + size] == key else 255 for start in range(0, len(samples), size))


def _rgba(png: Png, palette: bytes, transparency: bytes, data: bytes) -> bytes:
    """8-bit RGBA from the unfiltered samples of any colour type and bit depth."""
    colour_type, bit_depth = png.colour_type, png.bit_depth
    if bit_depth < 8:
        samples = _unpacked(data, png.width, png.height, bit_depth)
    elif bit_depth == 16:
        samples = data[0::2]  # the high byte of each sample
    else:
        samples = data
    if colour_type == 6:
        return samples
    rgba = bytearray(b"\xff" * (png.width * png.height * 4))
    if colour_type == _PALETTE:
        # An index past the palette (PNG does not allow one, and the check does not look) is opaque black.
        entries = palette + bytes(3 * 256 - len(palette))
        for channel in range(3):
            rgba[channel::4] = samples.translate(entries[channel::3])
        rgba[3::4] = samples.translate(transparency + b"\xff" * (256 - len(transparency)))
        return bytes(rgba)
    if colour_type in (0, 4):
        grey = samples[0 :: _COLOUR_TYPES[colour_type][0]]
        if colour_type == 0 and transparency and bit_depth == 16:
            rgba[3::4] = _keyed_alpha(data, 2, transparency)
        elif colour_type == 0 and transparency:
            (key,) = struct.unpack(">H", transparency)
            rgba[3::4] = grey.translate(bytes(0 if value == key else 255 for value in range(256)))
        if bit_depth < 8:
            grey = grey.translate(bytes(min(255, value * _GREY_SCALE[bit_depth]) for value in range(256)))
        for channel in range(3):
            rgba[channel::4] = grey
        if colour_type == 4:
            rgba[3::4] = samples[1::2]
        return bytes(rgba)
    # Truecolour without alpha, perhaps with one transparent colour.
    for channel in range(3):
        rgba[channel::4] = samples[channel::3]
    if transparency:
        if bit_depth == 16:
            rgba[3::4] = _keyed_alpha(data, 6, transparency)
        else:
            rgba[3::4] = _keyed_alpha(samples, 3, transparency[1::2])
    return bytes(rgba)


def decode_png(data: bytes, limits: PngLimits) -> Pixels:
    """The pixels of `data`, which must pass `sanitize_png` under `limits` (whatever it refuses raises
    what it raises): every colour type and bit depth as 8-bit RGBA, a 16-bit sample by its high byte,
    and a transparent colour (`tRNS`) compared at its full depth."""
    png = sanitize_png(data, limits)
    palette, transparency, stream = _parts(png.data)
    bits = _COLOUR_TYPES[png.colour_type][0] * png.bit_depth
    length = (png.width * bits + 7) // 8
    raw = _inflate(stream, png.height * (length + 1))
    unfiltered = _unfiltered(raw, png.height, length, max(1, bits // 8))
    del raw
    return Pixels(png.width, png.height, _rgba(png, palette, transparency, unfiltered))


def encode_rgb_png(width: int, height: int, rgb: bytes) -> bytes:
    """An opaque PNG of `rgb` (`width * height` pixels of three 8-bit samples, row after row): 8-bit
    truecolour without alpha and without `tRNS`, so no pixel of it is transparent in any viewer. Every
    row is filtered with Sub (a logo's flat colours become runs of zeros) and deflated at level 9: the
    same pixels always give the same bytes."""
    if width < 1 or height < 1 or len(rgb) != width * height * 3:
        raise ValueError("rgb must hold width * height pixels of three samples")
    stride = width * 3
    rows = []
    for start in range(0, len(rgb), stride):
        row = rgb[start : start + stride]
        # Each byte less the one a pixel to its left, modulo 256; the first pixel as it is.
        rows.append(
            b"\x01" + row[:3] + bytes(map(_LOW_BYTE, map(int.__sub__, row[3:], row[:-3], strict=True)))
        )
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"".join(
        (
            SIGNATURE,
            _chunk(b"IHDR", header),
            _chunk(b"IDAT", zlib.compress(b"".join(rows), 9)),
            _chunk(b"IEND", b""),
        )
    )
