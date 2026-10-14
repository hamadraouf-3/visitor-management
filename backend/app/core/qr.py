"""QR code images (contract §6, §9): segno, error correction M, at least 8 px per module, a 4-module quiet
zone. The payload is exactly the text given; for visitor passes that is the pass URL, which carries no
personal data."""

import io

import segno

QR_ERROR_CORRECTION = "m"
QR_SCALE = 8  # pixels per module: crisp on phone screens and in print
QR_QUIET_ZONE = 4  # modules (the minimum ISO/IEC 18004 requires)


def qr_png(payload: str) -> bytes:
    # boost_error=False keeps the requested level M (segno would otherwise raise it when the version has
    # room), so the symbol is exactly what the contract specifies.
    code = segno.make(payload, error=QR_ERROR_CORRECTION, boost_error=False, micro=False)
    buffer = io.BytesIO()
    code.save(buffer, kind="png", scale=QR_SCALE, border=QR_QUIET_ZONE)
    return buffer.getvalue()


def qr_matrix(payload: str) -> tuple[tuple[bool, ...], ...]:
    """The module matrix (dark = True) `qr_png` draws for `payload`, without the quiet zone."""
    code = segno.make(payload, error=QR_ERROR_CORRECTION, boost_error=False, micro=False)
    return tuple(tuple(bool(module) for module in row) for row in code.matrix)
