"""Write the demo company's brand images that the seeds use (Phase 12, B12-15).

    backend\\.venv\\Scripts\\python.exe scripts/demo_brand.py            (from the repository root)
    backend\\.venv\\Scripts\\python.exe scripts/demo_brand.py --check    (exit 1 when a file is stale)

`seed-demo` and `seed-e2e` give the demo company the Mawdoo3 identity as its brand: the brand's own files
of the web application, which this script copies into the backend package so that the seeds need nothing
outside `backend/app`:

    frontend/public/brand/logo-teal.png   ->  backend/app/seed_assets/logo.png        (light surfaces)
    frontend/public/brand/logo-white.png  ->  backend/app/seed_assets/logo_dark.png   (dark surfaces)
    frontend/public/icons/icon-512.png    ->  backend/app/seed_assets/icon.png        (the square icon)

Each file goes through the very check an upload goes through (`app.core.png.sanitize_png` with the limits
of its kind, `app.services.brand.IMAGE_LIMITS`), and what is written is that check's output: a file here
is a file the API would store, byte for byte. The script fails if a source is not acceptable. Needs the
backend's environment (it imports the backend's own code); reproducible: the same input always gives the
same bytes.
"""

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.core.png import PngError, sanitize_png  # noqa: E402 - after the path of the backend's code
from app.models.enums import BrandAssetKind  # noqa: E402
from app.services.brand import IMAGE_LIMITS  # noqa: E402

PUBLIC = REPO_ROOT / "frontend" / "public"
TARGET = REPO_ROOT / "backend" / "app" / "seed_assets"
SOURCES = {
    BrandAssetKind.LOGO: PUBLIC / "brand" / "logo-teal.png",
    BrandAssetKind.LOGO_DARK: PUBLIC / "brand" / "logo-white.png",
    BrandAssetKind.ICON: PUBLIC / "icons" / "icon-512.png",
}


def target(kind: BrandAssetKind) -> Path:
    return TARGET / f"{kind.value}.png"


def build() -> dict[BrandAssetKind, bytes]:
    """Each kind's image as the API would store it. Raises ValueError when a source is not acceptable."""
    images = {}
    for kind, source in SOURCES.items():
        try:
            images[kind] = sanitize_png(source.read_bytes(), IMAGE_LIMITS[kind]).data
        except PngError as error:
            raise ValueError(
                f"{source.relative_to(REPO_ROOT)} is not an acceptable {kind.value}: {error}"
            ) from None
    return images


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare only; exit 1 when a file is stale")
    arguments = parser.parse_args()
    images = build()
    stale = [
        kind
        for kind, data in images.items()
        if not target(kind).is_file() or target(kind).read_bytes() != data
    ]
    if arguments.check:
        for kind in stale:
            print(
                f"{target(kind).relative_to(REPO_ROOT)} is stale: run scripts/demo_brand.py", file=sys.stderr
            )
        return 1 if stale else 0
    TARGET.mkdir(parents=True, exist_ok=True)
    for kind, data in images.items():
        target(kind).write_bytes(data)
        state = "written" if kind in stale else "unchanged"
        print(f"{target(kind).relative_to(REPO_ROOT)}: {len(data)} bytes ({state})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
