"""Writes a Y4M video (YUV 4:2:0, 8-bit) showing one QR code, for Chromium's fake camera.

Run with the backend's virtual environment (segno is a backend dependency):

    backend/.venv/Scripts/python.exe frontend/e2e/support/make_y4m.py --text URL --out FILE

Chromium plays the file in a loop as the camera (`--use-file-for-fake-video-capture`), so a few
identical frames are enough. The code is drawn black on white, centred, with its quiet zone, on a
mid-grey background, at a whole number of pixels per module.
"""

import argparse
from pathlib import Path

import segno

# Limited-range luma (BT.601): 16 = black, 235 = white; 128 = neutral chroma.
BLACK = 16
WHITE = 235
GREY = 126
NEUTRAL_CHROMA = 128


def frame_luma(text: str, width: int, height: int, fill: float) -> bytes:
    qr = segno.make(text, error="m", micro=False)
    rows = [list(row) for row in qr.matrix_iter(scale=1, border=4)]
    modules = len(rows)
    scale = max(1, int(min(width, height) * fill) // modules)
    size = modules * scale
    left = (width - size) // 2
    top = (height - size) // 2
    luma = bytearray([GREY]) * (width * height)
    for y, row in enumerate(rows):
        line = bytes(BLACK if dark else WHITE for dark in row for _ in range(scale))
        for dy in range(scale):
            start = (top + y * scale + dy) * width + left
            luma[start : start + size] = line
    return bytes(luma)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--text", required=True, help="what the QR code encodes")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--frames", type=int, default=5)
    parser.add_argument("--fill", type=float, default=0.8, help="share of the shorter side the code covers")
    args = parser.parse_args()
    if args.width % 2 or args.height % 2:
        parser.error("4:2:0 needs an even width and height")

    luma = frame_luma(args.text, args.width, args.height, args.fill)
    chroma = bytes([NEUTRAL_CHROMA]) * ((args.width // 2) * (args.height // 2))
    header = f"YUV4MPEG2 W{args.width} H{args.height} F30:1 Ip A1:1 C420jpeg\n".encode("ascii")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("wb") as handle:
        handle.write(header)
        for _ in range(args.frames):
            handle.write(b"FRAME\n")
            handle.write(luma)
            handle.write(chroma)
            handle.write(chroma)
    print(args.out)


if __name__ == "__main__":
    main()
