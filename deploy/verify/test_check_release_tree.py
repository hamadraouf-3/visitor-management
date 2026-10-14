"""Tests of check_release_tree.py and of the repository's .gitignore guard (SEC-R3/SEC-R4).

    python3 -m unittest discover -s deploy/verify -p "test_*.py" -v

Each test builds a throwaway git work tree with isolated git configuration (no global or system ignore
files). Tokens, cookies and key headers are assembled at run time, so this file never trips the check
itself.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_release_tree

REPOSITORY_GITIGNORE = Path(__file__).resolve().parents[2] / ".gitignore"
# The directory of the real incident: EMAIL_OUTBOX_DIR=C:\Users\User\AppData\Local\Temp\...\fix3outbox
# after Git Bash removed the backslashes, resolved under backend/.
INCIDENT_DIR = (
    "backend/UsersUserAppDataLocalTempclaudeC--Users-Userdff0f53a-1a29-40dd-bed0-ff67f3f213d3"
    "scratchpadfix3outbox"
)
MESSAGE_ID = "17b4ee6d-1690-44d3-ad98-5b3b09edbee1"
SESSION_COOKIE = "vms_" + "session"
CSRF_COOKIE = "vms_" + "csrf"
PEM_PRIVATE_KEY = "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n"
PEM_RSA_PRIVATE_KEY = "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n"
PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


def token() -> str:
    return secrets.token_urlsafe(32)


class ReleaseTreeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.git = shutil.which("git")
        if self.git is None:
            self.skipTest("git is not on PATH")
        self.enterContext(
            mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        )
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="vms-release-tree-")))
        self.run_git("init", "-q")
        self.secrets: list[str] = []

    def run_git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed argument list, no shell
            [self.git, "-C", str(self.root), *args], capture_output=True, text=True, check=False
        )

    def write(self, path: str, content: str | bytes) -> None:
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            file.write_bytes(content)
        else:
            file.write_text(content, encoding="utf-8", newline="\n")

    def secret(self) -> str:
        value = token()
        self.secrets.append(value)
        return value

    def use_repository_gitignore(self) -> None:
        shutil.copyfile(REPOSITORY_GITIGNORE, self.root / ".gitignore")

    def check(self) -> tuple[int, str]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            status = check_release_tree.main(["--repo", str(self.root)])
        output = buffer.getvalue()
        for value in self.secrets:
            self.assertNotIn(value, output, "a matched secret value was printed")
        return status, output

    def findings(self, output: str) -> dict[str, str]:
        result = {}
        for line in output.splitlines():
            if line.startswith("FAIL  "):
                path, _, rules = line[len("FAIL  ") :].rpartition(": ")
                result[path] = rules
        return result

    def write_incident(self, directory: str) -> None:
        """The four files the development outbox writes for one invitation."""
        pass_url = "http://127.0.0.1:8731/pass#" + self.secret()
        self.write(
            f"{directory}/{MESSAGE_ID}.json",
            '{\n  "message_id": "' + MESSAGE_ID + '",\n  "kind": "VISITOR_INVITATION",\n'
            '  "to": "dana@example.com",\n  "pass_url": "' + pass_url + '",\n  "reset_url": null\n}\n',
        )
        self.write(f"{directory}/{MESSAGE_ID}.html", f'<p>Your pass:</p>\n<a href="{pass_url}">Open</a>\n')
        self.write(f"{directory}/{MESSAGE_ID}.txt", f"Open your pass:\n{pass_url}\n")
        self.write(f"{directory}/{MESSAGE_ID}-visitor-pass-qr.png", PNG_BYTES)


class IncidentTests(ReleaseTreeTestCase):
    def test_stray_outbox_is_reported_without_its_tokens(self) -> None:
        self.write("backend/app/main.py", "app = None\n")
        self.write_incident(INCIDENT_DIR)

        status, output = self.check()

        self.assertEqual(status, 1, output)
        findings = self.findings(output)
        self.assertEqual(len(findings), 4, output)
        for suffix in (".json", ".html", ".txt", "-visitor-pass-qr.png"):
            rules = findings[f"{INCIDENT_DIR}/{MESSAGE_ID}{suffix}"]
            self.assertIn("outbox-artefact", rules)
            self.assertIn("stripped-windows-path", rules)
            self.assertEqual("pass-link" in rules, suffix != "-visitor-pass-qr.png", rules)
        self.assertIn("pass-link (line 5)", findings[f"{INCIDENT_DIR}/{MESSAGE_ID}.json"])
        self.assertIn("4 of 5 files", output)

    def test_repository_gitignore_ignores_stray_outboxes_but_not_sources(self) -> None:
        self.use_repository_gitignore()
        self.write_incident(INCIDENT_DIR)  # both guard patterns match
        self.write_incident("backend/C-scratch-outbox")  # only /backend/*outbox*/
        self.write_incident("frontend/UsersYouAppDataLocalTempe2e")  # only *AppDataLocal*
        self.write_incident("backend/var/outbox")  # the designated outbox
        self.write("backups/vms-20261006T013000Z.dump", b"PGDMP\x01")
        self.write("backups/vms-20261006T073000Z.dump.partial", b"PGDMP\x01")
        legitimate = (
            "backend/app/email/providers/outbox.py",
            "frontend/e2e/support/outbox.ts",
            "backend/tests/unit/test_outbox_provider.py",
            ".env.example",
            "deploy/env/backend.env.example",
        )
        for path in legitimate:
            self.write(path, "# source\n")

        status, output = self.check()

        self.assertEqual(status, 0, output)
        self.assertIn(f"OK    {len(legitimate) + 1} files", output)  # + .gitignore
        ignored = self.run_git("check-ignore", "--no-index", *legitimate)
        self.assertEqual(ignored.returncode, 1, f"legitimate files are ignored: {ignored.stdout}")

    def test_without_the_guard_the_same_tree_fails(self) -> None:
        guard_free = [
            line
            for line in REPOSITORY_GITIGNORE.read_text(encoding="utf-8").splitlines()
            if line not in {"/backend/*outbox*/", "*AppDataLocal*", "*AppDataRoaming*"}
        ]
        self.assertNotEqual(
            len(guard_free), len(REPOSITORY_GITIGNORE.read_text(encoding="utf-8").splitlines())
        )
        (self.root / ".gitignore").write_text("\n".join(guard_free) + "\n", encoding="utf-8")
        self.write_incident(INCIDENT_DIR)
        self.write_incident("backend/C-scratch-outbox")

        status, output = self.check()

        self.assertEqual(status, 1, output)
        self.assertEqual(len(self.findings(output)), 8, output)


class RuleTests(ReleaseTreeTestCase):
    def test_each_credential_and_archive_rule(self) -> None:
        cases = {
            "logs/api.txt": (
                "reset-link",
                "x\nhttps://vms.example.com/reset-password#token=" + self.secret(),
            ),
            "logs/escaped.json": (
                "pass-link",
                '{"url": "https:\\/\\/vms.example.com\\/pass#' + self.secret(),
            ),
            "logs/encoded.txt": (
                "pass-link",
                "https://qr.example/?u=https%3A%2F%2Fh%2Fpass%23" + self.secret(),
            ),
            "logs/query.txt": ("pass-link", "https://h/pass/?utm_source=email#" + self.secret()),
            "har/session.har": (
                "session-cookie",
                # a HAR file: pretty-printed, so name and value are on separate lines
                json.dumps(
                    {"cookies": [{"name": "__Host-" + SESSION_COOKIE, "value": self.secret()}]}, indent=2
                ),
            ),
            "notes/headers.txt": ("session-cookie", f"Cookie: {CSRF_COOKIE}={self.secret()}; other=1"),
            "certs/server.pem": ("private-key", PEM_PRIVATE_KEY),
            "certs/tls.key": ("key-store", "not even PEM"),
            "certs/client.p12": ("key-store", "binary"),
            ".env": ("env-file", "SECRET_KEY=x\n"),
            ".env.local": ("env-file", "SECRET_KEY=x\n"),
            "deploy/env/backend.env": ("env-file", "DATABASE_URL=x\n"),
            "backups/vms-20261006T013000Z.dump": ("database-archive", "PGDMP"),
            "backups/vms-20261006T013000Z.dump.partial": ("database-archive", "PGDMP"),
        }
        for path, (_, content) in cases.items():
            self.write(path, content)

        status, output = self.check()

        self.assertEqual(status, 1, output)
        findings = self.findings(output)
        self.assertEqual(set(findings), set(cases), output)
        for path, (rule, _) in cases.items():
            self.assertIn(rule, findings[path], path)
        self.assertIn("reset-link (line 2)", findings["logs/api.txt"])

    def test_sources_fixtures_and_templates_pass(self) -> None:
        fixture_url = "https://visitors.example.com/pass#" + token()
        self.write("frontend/src/components/CopyButton.test.tsx", f"const url = '{fixture_url}'\n")
        self.write("backend/tests/unit/test_tokens.py", f'URL = "{fixture_url}"\n')
        self.write("frontend/e2e/flows/reset.spec.ts", f"const c = '{SESSION_COOKIE}={token()}'\n")
        self.write("docs/contract/pass-token-vectors.json", f'{{"valid": ["{fixture_url}"]}}\n')
        self.write("backend/app/security/tokens.py", 'PATTERN = r"/pass/?#([A-Za-z0-9_-]{32,128})"\n')
        self.write("docs/guide.md", "Links look like `https://host/pass#<token>`.\n")
        self.write(".env.example", "SECRET_KEY=change-me\n")
        self.write("deploy/env/backend.env.example", "SECRET_KEY=\n")
        self.write("frontend/src/assets/logo.png", PNG_BYTES)

        status, output = self.check()

        self.assertEqual(status, 0, output)
        self.assertIn("OK    9 files", output)

    def test_generated_files_in_test_folders_are_not_exempt(self) -> None:
        # a Playwright storage state (compact JSON)
        state = json.dumps({"cookies": [{"name": SESSION_COOKIE, "value": self.secret(), "path": "/"}]})
        self.write("frontend/e2e/.artifacts/run/state/admin.json", state)
        self.write("backend/tests/fixtures/mail.html", '<a href="https://h/pass#' + self.secret() + '">x</a>')
        self.write("backend/tests/unit/test_tls.py", f'KEY = """{PEM_RSA_PRIVATE_KEY}"""\n')

        status, output = self.check()

        self.assertEqual(status, 1, output)
        findings = self.findings(output)
        self.assertIn("session-cookie", findings["frontend/e2e/.artifacts/run/state/admin.json"])
        self.assertIn("pass-link", findings["backend/tests/fixtures/mail.html"])
        self.assertIn("private-key", findings["backend/tests/unit/test_tls.py"])

    def test_tracked_files_are_checked_even_when_ignored_later(self) -> None:
        self.write("notes/link.txt", "https://h/pass#" + self.secret() + "\n")
        self.assertEqual(self.run_git("add", "notes/link.txt").returncode, 0)
        self.write(".gitignore", "notes/\n")
        self.write("gone.txt", "x\n")
        self.assertEqual(self.run_git("add", "gone.txt").returncode, 0)
        (self.root / "gone.txt").unlink()  # still in the index, no longer in the work tree

        status, output = self.check()

        self.assertEqual(status, 1, output)
        self.assertEqual(list(self.findings(output)), ["notes/link.txt"], output)
        self.assertIn("1 of 2 files", output)

    def test_outside_a_work_tree_the_check_cannot_run(self) -> None:
        with tempfile.TemporaryDirectory() as outside:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                status = check_release_tree.main(["--repo", outside])
        self.assertEqual(status, 2, buffer.getvalue())
        self.assertIn("ERROR", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
