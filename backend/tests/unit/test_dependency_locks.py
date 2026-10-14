"""The lock files pin every dependency to a version and to the hashes of its files (SEC-25): an install
(`pip install --require-hashes`, the Phase 9 Dockerfile and CI) accepts no other file, whatever an index
or a mirror serves."""

import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]
REQUIREMENT = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^\s;]+)")
HASH = re.compile(r"--hash=sha256:[0-9a-f]{64}")


def _requirements(path: Path) -> list[str]:
    """The file's requirements, each with its continuation lines joined."""
    joined, current = [], ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("#") or not line.strip():
            continue
        current += line.rstrip().removesuffix("\\") + " "
        if not line.rstrip().endswith("\\"):
            joined.append(current.strip())
            current = ""
    return joined


@pytest.mark.parametrize("name", ["requirements.txt", "requirements-dev.txt"])
def test_every_requirement_is_pinned_and_hashed(name: str) -> None:
    requirements = [line for line in _requirements(BACKEND / name) if not line.startswith("-r ")]
    assert requirements
    for line in requirements:
        assert REQUIREMENT.match(line), f"not pinned with ==: {line}"
        assert HASH.search(line), f"no sha256 hash: {line.split()[0]}"
