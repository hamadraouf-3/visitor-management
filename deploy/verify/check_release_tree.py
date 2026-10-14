"""Release hygiene check: fails when a file that would be committed is a development artefact or holds a
credential.

    python3 deploy/verify/check_release_tree.py [--repo PATH]

Standard library only (Python 3.12+) plus git. Run it before the first commit, before every release tag
and in CI. "Would be committed" means what `git add -A` would take: tracked files plus untracked files
that no ignore rule excludes (`git ls-files --cached --others --exclude-standard`). Ignored files are not
examined, because they never reach the repository.

Rules (security audit recommendation 15, findings SEC-R3/SEC-R4):

* outbox-artefact: a file named the way the development e-mail outbox names its output
  (backend/app/email/providers/outbox.py): `<message uuid>.html|.txt|.json` or
  `<message uuid>-<content id>.png`.
* stripped-windows-path: a path component that is a Windows path whose backslashes a POSIX shell removed
  (`UsersYouAppDataLocalTemp...`). It means a path setting was resolved somewhere it should not have been.
* pass-link / reset-link: a raw one-time token in a pass link (`/pass#<token>`) or in a password-reset
  link (`/reset-password#token=<token>`). Only SHA-256 digests of tokens are ever stored (contract §5.5).
* session-cookie: a value of the session, CSRF or device cookie, as found in a saved browser state, a
  HAR file or a log of request headers.
* private-key: a PEM private key in any file (no exemption).
* key-store: a key or key-store file by name (.key, .p12, .pfx, .jks).
* env-file: a `.env` file other than an `*.example` template. Real configuration lives in git-ignored
  env files.
* database-archive: a pg_dump archive (`*.dump`, `*.dump.partial`, as scripts/backup.* write them). Such
  archives hold personal data, password hashes and the audit trail.

Test sources (`*.py`, `*.ts`, ... under backend/tests/ and frontend/e2e/, `*.test.ts(x)`) and the
shared contract vectors (docs/contract/) are exempt from the pass-link, reset-link and session-cookie
rules only, because they contain hand-made fixture tokens. Generated files in those folders, such as
JSON or HTML, are not exempt.

Findings name the file, the line and the rule. They never include the matched value, so the output is
safe to keep in CI logs. Exit status: 0 clean, 1 findings, 2 the check could not run (git missing, not a
work tree).
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path, PurePosixPath

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# The outbox provider's file names (content ids are limited to [A-Za-z0-9._-]{1,64} there).
OUTBOX_FILE_NAME = re.compile(rf"{_UUID}(?:\.(?:html|txt|json)|-[A-Za-z0-9._-]{{1,64}}\.png)", re.IGNORECASE)
# "C:\Users\You\AppData\Local\Temp\x" after a POSIX shell ate the backslashes: "C:UsersYouAppDataLocalTempx".
STRIPPED_WINDOWS_PATH = re.compile(r"AppData(?:Local|Roaming)")

# Tokens are secrets.token_urlsafe(32) (43 characters); the API accepts [A-Za-z0-9_-]{32,128}. The
# separators also match JSON-escaped (`\/`) and percent-encoded (`%2F`, `%23`, `%3D`) spellings, e.g. a
# pass link carried inside another URL's query.
_TOKEN = rb"[A-Za-z0-9_-]{32,128}"
_SLASH = rb"(?:/|\\/|%2F)"
_QUERY = rb"(?:\?[^#\s\"'<>]*)?"
PASS_LINK = re.compile(_SLASH + rb"pass" + _SLASH + rb"?" + _QUERY + rb"(?:#|%23)" + _TOKEN, re.IGNORECASE)
RESET_LINK = re.compile(
    rb"reset-password" + _SLASH + rb"?" + _QUERY + rb"(?:#|%23)token(?:=|%3D)" + _TOKEN, re.IGNORECASE
)
_COOKIE = rb"(?:__Host-)?vms_(?:session|csrf|device)"
SESSION_COOKIE = re.compile(
    _COOKIE
    + rb"=[A-Za-z0-9_.-]{20,}"  # Cookie / Set-Cookie header, document.cookie
    + rb"|\"name\"\s*:\s*\""
    + _COOKIE
    + rb"\"\s*,\s*\"value\"\s*:\s*\"[^\"]{20,}\""  # storage state, HAR
)
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")

CONTENT_RULES: tuple[tuple[str, re.Pattern[bytes], bool], ...] = (
    # (rule, pattern, test sources exempt)
    ("pass-link", PASS_LINK, True),
    ("reset-link", RESET_LINK, True),
    ("session-cookie", SESSION_COOKIE, True),
    ("private-key", PRIVATE_KEY, False),
)
KEY_STORE_SUFFIXES = (".key", ".p12", ".pfx", ".jks")
TEST_SOURCE_FOLDERS = ("backend/tests/", "frontend/e2e/")
SOURCE_SUFFIXES = (".py", ".ts", ".tsx", ".js", ".mjs", ".cjs")
TEST_FILE_SUFFIXES = (".test.ts", ".test.tsx")
CONTRACT_VECTORS = "docs/contract/"


class CheckError(Exception):
    """The check could not run."""


def is_test_source(path: str) -> bool:
    if path.startswith(CONTRACT_VECTORS) or path.endswith(TEST_FILE_SUFFIXES):
        return True
    return path.startswith(TEST_SOURCE_FOLDERS) and path.endswith(SOURCE_SUFFIXES)


def name_rules(path: str) -> list[str]:
    parts = PurePosixPath(path).parts
    name = parts[-1]
    rules = []
    if OUTBOX_FILE_NAME.fullmatch(name):
        rules.append("outbox-artefact")
    if any(STRIPPED_WINDOWS_PATH.search(part) for part in parts):
        rules.append("stripped-windows-path")
    if name.endswith(KEY_STORE_SUFFIXES):
        rules.append("key-store")
    if (name == ".env" or name.startswith(".env.") or name.endswith(".env")) and not name.endswith(
        ".example"
    ):
        rules.append("env-file")
    if name.endswith((".dump", ".dump.partial")):
        rules.append("database-archive")
    return rules


def content_rules(path: str, data: bytes) -> list[str]:
    exempt = is_test_source(path)
    rules = []
    for rule, pattern, test_exempt in CONTENT_RULES:
        if test_exempt and exempt:
            continue
        match = pattern.search(data)
        if match:
            line = data.count(b"\n", 0, match.start()) + 1
            rules.append(f"{rule} (line {line})")
    return rules


def _git(git: str, repo: Path, *args: str) -> bytes:
    completed = subprocess.run(  # noqa: S603 - fixed argument list, no shell
        [git, "-C", str(repo), *args], capture_output=True, check=False
    )
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", "replace").strip()
        raise CheckError(f"git {args[0]} failed: {message}")
    return completed.stdout


def candidate_files(repo: Path) -> tuple[Path, list[str]]:
    """The repository root and the paths (relative, '/'-separated) that `git add -A` would commit."""
    git = shutil.which("git")
    if git is None:
        raise CheckError("git is not on PATH")
    root = Path(_git(git, repo, "rev-parse", "--show-toplevel").decode("utf-8").strip())
    listing = _git(git, root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    paths = (raw.decode("utf-8", "surrogateescape") for raw in listing.split(b"\0") if raw)
    return root, list(dict.fromkeys(paths))


def check(repo: Path) -> tuple[int, dict[str, list[str]]]:
    """Return the number of files examined and the findings per path."""
    root, paths = candidate_files(repo)
    findings: dict[str, list[str]] = {}
    examined = 0
    for path in paths:
        file = root / path
        if not file.is_file():  # deleted from the work tree but still in the index
            continue
        examined += 1
        rules = name_rules(path) + content_rules(path, file.read_bytes())
        if rules:
            findings[path] = rules
    return examined, findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="any folder inside the work tree to check (default: the repository holding this script)",
    )
    args = parser.parse_args(argv)
    out = sys.stdout
    if hasattr(out, "reconfigure"):
        out.reconfigure(errors="backslashreplace")  # odd file names on a legacy console code page
    try:
        examined, findings = check(args.repo)
    except CheckError as exc:
        out.write(f"ERROR {exc}\n")
        return 2
    for path, rules in findings.items():
        out.write(f"FAIL  {path}: {', '.join(rules)}\n")
    if not findings:
        out.write(f"OK    {examined} files that would be committed: no development artefact or credential\n")
        return 0
    totals = Counter(rule.split(" (")[0] for rules in findings.values() for rule in rules)
    out.write(
        f"\n{len(findings)} of {examined} files that would be committed are development artefacts or "
        f"hold credentials ({', '.join(f'{rule} {count}' for rule, count in sorted(totals.items()))}).\n"
        "Delete them, or git-ignore them if they belong in the work tree. Matched values are not shown.\n"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
