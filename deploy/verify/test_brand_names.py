"""The product's name wherever people and operators read it (phase 10, the brand sweep).

    python3 -m unittest discover -s deploy/verify -p "test_*.py" -v

The product is «زوار موضوع» / "Mawdoo3 Visitors"; the company (the tenant) is «موضوع» / "Mawdoo3". The
names of the old product must not come back where someone reads them: "Visitor Management", the demo's
"Demo Company", the abbreviation "VMS" and "Visitor" as a sender's name. The checked surfaces are the web
app as a person meets it (the page shell, the installed app, the service worker and the catalogs, which
hold every word of the screens: frontend/src/i18n/hardcodedText.test.ts), the API (its e-mails, messages,
OpenAPI title and command-line output), the image labels, the operator's scripts, the deployment's
configuration templates and checks, and the configuration examples.

Since phase 12 every company shows its own identity to its staff and visitors, and the product's name
stays in the platform owner's area: the page shell that everyone loads first (`frontend/index.html`: what a
link preview of a visitor's pass shows, whoever sent it) names neither the product nor a company, while
the manifest that ships with the build is the platform owner's installed app and keeps the product's name.
A company's own manifest comes from the API (`GET /api/v1/public/companies/{slug}/manifest.webmanifest`).

Internal identifiers stay as they are, because nobody reads them as a name: the `vms` database and roles,
the `VMS_*` settings, file and image names, cookie and storage keys, Message-IDs and the e-mails' CSS
classes. Documentation (docs/, the READMEs) has its own owner and is not checked here. Standard library
only.
"""

from __future__ import annotations

import json
import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

PRODUCT_EN = "Mawdoo3 Visitors"
PRODUCT_AR = "زوار موضوع"
# The brand's own name, in either script: part of the product's name, and the demo tenant's name.
BRAND_NAMES = ("Mawdoo3", "موضوع")

# Files and folders (searched recursively) where a person or an operator reads the product's name.
SURFACES = (
    "frontend/index.html",
    "frontend/public",
    "frontend/src/i18n/locales",
    "frontend/Dockerfile",
    "backend/app",
    "backend/Dockerfile",
    "backend/pyproject.toml",
    "scripts",
    "deploy/env",
    "deploy/nginx",
    "deploy/postgres",
    "deploy/verify/smoke_test.py",
    "deploy/verify/check_release_tree.py",
    "deploy/verify/check_nginx_headers.mjs",
    "docker-compose.yml",
    ".env.example",
)
TEXT_SUFFIXES = frozenset(
    {".conf", ".example", ".html", ".js", ".json", ".mjs", ".ps1", ".py", ".sh", ".template", ".toml", ".txt"}
    | {".webmanifest", ".yml"}
)
TEXT_NAMES = frozenset({"Dockerfile"})
SKIPPED_DIRECTORIES = frozenset({"__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"})

RETIRED_NAMES = (
    ("Visitor Management", re.compile(r"visitor\s+management", re.IGNORECASE)),
    ("Demo Company", re.compile(r"\bDemo\s+Company\b")),
    # The abbreviation as a word: `VMS_SERVER_NAME`, `vms-backend` and `vms.conf` are identifiers.
    ("VMS", re.compile(r"\bVMS\b(?![_-])")),
    # The old wordmark as the display name of a mailbox ("Visitor <no-reply@...>").
    ("Visitor as a sender", re.compile(r"(?<![\w-])Visitor\s*<[^<>\s]*@")),
)

# (file, retired name): the one place a retired name must stay, and why.
ALLOWED = {
    # The demo company's former seed name, which `seed-demo` recognises and renames to Mawdoo3 (B10-10).
    ("backend/app/services/seeding.py", "Demo Company"),
}


def surface_files() -> list[Path]:
    files: list[Path] = []
    for surface in SURFACES:
        path = ROOT / surface
        if path.is_file():
            files.append(path)
            continue
        for candidate in sorted(path.rglob("*")):
            if SKIPPED_DIRECTORIES.intersection(candidate.relative_to(path).parts[:-1]):
                continue
            if candidate.is_file() and (candidate.suffix in TEXT_SUFFIXES or candidate.name in TEXT_NAMES):
                files.append(candidate)
    return files


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


class RetiredNamesTest(unittest.TestCase):
    def test_finds_the_surfaces_to_check(self) -> None:
        names = {relative(path) for path in surface_files()}
        for expected in (
            "frontend/index.html",
            "frontend/public/manifest.webmanifest",
            "frontend/public/sw.js",
            "frontend/src/i18n/locales/ar/common.json",
            "frontend/src/i18n/locales/en/common.json",
            "backend/app/email/i18n.py",
            "backend/app/email/templates/base.html",
            "backend/app/email/templates/base.txt",
            "backend/app/cli.py",
            "backend/app/main.py",
            "backend/Dockerfile",
            "frontend/Dockerfile",
            "scripts/backup.ps1",
            "scripts/restore.sh",
            "deploy/env/backend.env.example",
            "deploy/nginx/templates/vms.conf.template",
            "deploy/nginx/docker-entrypoint.d/25-vms-check-config.sh",
            "deploy/postgres/initdb/10-vms-roles.sh",
            "docker-compose.yml",
            ".env.example",
        ):
            self.assertIn(expected, names)
        self.assertFalse(any("__pycache__" in name or name.endswith(".png") for name in names))

    def test_no_retired_name_where_people_or_operators_read_it(self) -> None:
        findings: list[str] = []
        for path in surface_files():
            name = relative(path)
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                for retired, pattern in RETIRED_NAMES:
                    if pattern.search(line) and (name, retired) not in ALLOWED:
                        findings.append(f"{name}:{line_number}: {retired}")
        self.assertEqual(findings, [])

    def test_the_patterns_find_the_old_names_and_leave_identifiers_alone(self) -> None:
        def found(text: str) -> list[str]:
            return [retired for retired, pattern in RETIRED_NAMES if pattern.search(text)]

        self.assertEqual(
            found("# Visitor Management System - environment configuration."), ["Visitor Management"]
        )
        self.assertEqual(
            found("an automated message from the Demo Company visitor management system"),
            [
                "Visitor Management",
                "Demo Company",
            ],
        )
        self.assertEqual(found('LABEL title="VMS backend"'), ["VMS"])
        self.assertEqual(found("EMAIL_FROM=Visitor <no-reply@demo.local>"), ["Visitor as a sender"])
        for identifier in (
            "VMS_SERVER_NAME=vms.example.com",
            "image: vms-backend:local",
            "ssl_session_cache shared:VMS_TLS:10m;",
            'name = "visitor-management-backend"',
            "EMAIL_FROM=Mawdoo3 Visitors <no-reply@demo.local>",
            "seed the demo company (non-production)",
            '"label.visitor": {EN: "Visitor", AR: "الزائر"}',
        ):
            self.assertEqual(found(identifier), [], identifier)


class ProductNameTest(unittest.TestCase):
    def test_the_platform_owner_s_installed_app_is_named_by_the_product(self) -> None:
        # The manifest of the build is the platform area's (phase 12): a company's own comes from the API.
        manifest = json.loads(
            (ROOT / "frontend" / "public" / "manifest.webmanifest").read_text(encoding="utf-8")
        )
        self.assertIn(PRODUCT_AR, manifest["name"])
        self.assertIn(PRODUCT_EN, manifest["name"])
        self.assertEqual(manifest["short_name"], PRODUCT_AR)

    def test_the_page_shell_names_neither_the_product_nor_a_company(self) -> None:
        # What every visitor of every company loads first, and what a link preview of a pass shows
        # (phase 12): a title and a description in both languages, and nobody's name in them. The app
        # sets the company's own title, icon and manifest once it knows the company.
        page = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        title = re.search(r"<title>(.*?)</title>", page, re.DOTALL)
        if title is None:
            self.fail("frontend/index.html has no <title>")
        self.assertTrue(title.group(1).strip())
        described = re.findall(
            r'<meta\s+name="(?:description|application-name|apple-mobile-web-app-title)"[^>]*>', page
        )
        for text in (title.group(1), *described):
            for name in BRAND_NAMES:
                self.assertNotIn(name, text)
        # No manifest and no product icon is linked before the app knows whose page this is.
        head = re.sub(r"<!--.*?-->", "", page, flags=re.DOTALL)
        self.assertNotRegex(head, r'rel="manifest"')
        for name in BRAND_NAMES:
            self.assertNotIn(name, head)

    def test_the_images_are_labelled_with_the_product(self) -> None:
        for dockerfile in (ROOT / "backend" / "Dockerfile", ROOT / "frontend" / "Dockerfile"):
            labels = dict(
                re.findall(
                    r'org\.opencontainers\.image\.(title|description)="([^"]*)"',
                    dockerfile.read_text("utf-8"),
                )
            )
            with self.subTest(dockerfile=relative(dockerfile)):
                self.assertEqual(set(labels), {"title", "description"})
                self.assertTrue(labels["title"].startswith(PRODUCT_EN), labels["title"])
                self.assertTrue(labels["description"].startswith(PRODUCT_EN), labels["description"])

    def test_the_backend_package_and_the_smoke_test_name_the_product(self) -> None:
        project = tomllib.loads((ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8"))["project"]
        self.assertTrue(project["description"].startswith(PRODUCT_EN), project["description"])
        # The first line of the docstring is the smoke test's --help description.
        smoke_test = (ROOT / "deploy" / "verify" / "smoke_test.py").read_text(encoding="utf-8")
        self.assertIn(f"a deployed {PRODUCT_EN} stack", smoke_test.splitlines()[0])


if __name__ == "__main__":
    unittest.main()
