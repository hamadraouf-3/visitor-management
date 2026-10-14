"""Add the PyPI sha256 hashes of every pinned file to the backend's lock files (SEC-25).

    backend/.venv/Scripts/python.exe scripts/lock_hashes.py          (Windows; python3 elsewhere)

For each `name==version` line of backend/requirements.txt and backend/requirements-dev.txt, the PyPI
JSON API (https://pypi.org/pypi/<name>/<version>/json) lists the release's files with their sha256
digests. Every file a Python 3.14 install on any platform could choose is kept: the source
distribution and the wheels tagged py3, cp314 or abi3 (Windows, Linux and macOS wheels alike), so one
lock file installs everywhere. pip then checks every downloaded file against these hashes
(`pip install --require-hashes -r requirements.txt`; any `--hash` in the file switches pip into that
mode), so a compromised index, mirror or a file added later to an already pinned release cannot slip
in. Comments, markers and `-r` lines are kept. Run it again after changing a pin; it replaces the old
hashes. The Phase 9 Dockerfile and CI install with `--require-hashes --no-deps`.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK_FILES = (ROOT / "backend" / "requirements.txt", ROOT / "backend" / "requirements-dev.txt")
PIN = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^\s;\\]+)(?P<marker>\s*;[^\\]*)?")
OLD_HASH = re.compile(r"\s+--hash=\S+")
# Wheel file name: name-version(-build)?-python-abi-platform.whl
WHEEL_TAGS = re.compile(r"-(?P<python>[^-]+)-(?P<abi>[^-]+)-(?P<platform>[^-]+)\.whl$")
TARGET_PYTHON = (3, 14)


def _usable_on_target(filename: str) -> bool:
    if not filename.endswith(".whl"):
        return filename.endswith((".tar.gz", ".zip"))  # the source distribution
    match = WHEEL_TAGS.search(filename)
    if match is None:
        return False
    pythons, abis = match["python"].split("."), match["abi"].split(".")
    if any(tag in {"py3", "py2.py3"} or tag.startswith("py3") for tag in pythons):
        return True
    cpython = [int(tag[3:]) for tag in pythons if re.fullmatch(r"cp3\d+", tag)]
    target = TARGET_PYTHON[1]
    if "abi3" in abis:
        return any(minor <= target for minor in cpython)
    return target in cpython and any(abi == f"cp3{target}" for abi in abis)


def _hashes(name: str, version: str) -> list[str]:
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    with urllib.request.urlopen(url, timeout=30) as response:
        release = json.load(response)
    digests = sorted(
        {file["digests"]["sha256"] for file in release["urls"] if _usable_on_target(file["filename"])}
    )
    if not digests:
        raise SystemExit(f"{name}=={version}: no file usable on Python 3.{TARGET_PYTHON[1]}")
    return digests


def _logical_lines(text: str) -> list[str]:
    """The file's lines with backslash continuations (old hashes) joined."""
    joined, current = [], ""
    for line in text.splitlines():
        if line.rstrip().endswith("\\"):
            current += line.rstrip()[:-1] + " "
            continue
        joined.append(current + line)
        current = ""
    if current:
        joined.append(current)
    return joined


def rewrite(path: Path) -> None:
    output: list[str] = []
    for line in _logical_lines(path.read_text(encoding="utf-8")):
        line = OLD_HASH.sub("", line)
        match = PIN.match(line.strip())
        if match is None:
            output.append(line)
            continue
        requirement = f"{match['name']}=={match['version']}{(match['marker'] or '').rstrip()}"
        digests = _hashes(match["name"], match["version"])
        output.append(requirement + " \\")
        output += [
            f"    --hash=sha256:{digest}" + (" \\" if index < len(digests) - 1 else "")
            for index, digest in enumerate(digests)
        ]
        print(f"{path.name}: {match['name']}=={match['version']} ({len(digests)} files)")  # noqa: T201
    path.write_text("\n".join(output) + "\n", encoding="utf-8")


def main() -> None:
    for path in LOCK_FILES:
        rewrite(path)


if __name__ == "__main__":
    sys.exit(main())
