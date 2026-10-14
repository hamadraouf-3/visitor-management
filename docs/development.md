# Development guide

This guide is for engineers who run, change and extend Mawdoo3 Visitors («زوار موضوع»). It assumes the
local setup of the root [README](../README.md#4-quick-start) is done: a running PostgreSQL cluster, the
backend virtual environment and `npm ci` in `frontend/`. The product is in Arabic and English: every
change that adds text adds it in both languages (§2.4).

Three sources are binding, in this order:

1. [docs/initial-assessment.md](initial-assessment.md): the design contract (architecture, data model,
   API, schemas, security model, testing strategy).
2. [docs/decisions/](decisions/): every interpretation of, or deviation from, the contract, with the
   reason. A change that departs from the contract is recorded there in
   `phase-<n>-<area>.md` (date, decision, reason). It is never made silently.
3. The tests. Many rules below are enforced by a test that fails when the rule is broken. The test is
   named next to the rule.

For how the system is built, see [architecture.md](architecture.md). The endpoints are in
[api.md](api.md), and the security controls in [security.md](security.md).

Commands are given for Windows PowerShell, which is what the reference machine runs. On Linux or macOS,
replace `.\.venv\Scripts\python.exe` with `.venv/bin/python`; nothing else in these commands changes.
The Linux forms were not run on the reference machine.

## Contents

1. [Repository layout](#1-repository-layout)
2. [Binding rules and conventions](#2-binding-rules-and-conventions)
3. [Everyday commands](#3-everyday-commands)
4. [Adding things end to end](#4-adding-things-end-to-end)
5. [Quality gates](#5-quality-gates)
6. [Backend test harness](#6-backend-test-harness)
7. [End-to-end suite (Playwright)](#7-end-to-end-suite-playwright)
8. [Contract snapshot workflow](#8-contract-snapshot-workflow)
9. [Troubleshooting](#9-troubleshooting)
10. [Release hygiene](#10-release-hygiene)

---

## 1. Repository layout

```
visitor-management/
├── backend/                         FastAPI application (Python 3.14)
│   ├── app/
│   │   ├── main.py                  create_app(): settings, engine, middleware, routers, exception handlers, lifespan
│   │   ├── serve.py                 python -m app.serve: the only run command (fixed uvicorn options)
│   │   ├── cli.py                   python -m app.cli: seed-demo, seed-e2e, create-admin, create-platform-admin, mark-no-shows, prune-sessions, e2e-time-travel, send-test-email
│   │   ├── contract.py              python -m app.contract: the API contract snapshot for the frontend
│   │   ├── core/                    config, errors and 422 field codes (field_errors.py), logging, middleware, rate limiter, client IP, clock (time.py), text and search normalisation,
│   │   │                            png.py (the check and rewrite of an uploaded PNG, no image library; since Phase 13 also decoding and an opaque
│   │   │                            RGB writer), raster.py (flatten, area-averaged downscale, frame), palette.py (a company's palette from its colour)
│   │   ├── security/                passwords (Argon2id), tokens, sessions, CSRF, permissions (capability matrix), device trust
│   │   ├── db/                      Base and naming convention, session factory and get_db, startup privilege checks
│   │   ├── models/                  SQLAlchemy models, one module per aggregate; enums.py
│   │   ├── schemas/                 Pydantic request, query and response models (mirror contract §8.1)
│   │   ├── repositories/            data access; every method is scoped by company_id
│   │   ├── services/                business logic, transactions, authorization rules, audit
│   │   ├── email/                   EmailService, dispatcher, providers (resend, smtp, outbox, memory), Jinja2 templates,
│   │   │                            i18n.py (the Arabic and English catalog), bidi.py, formatting.py, assets/brand-logo.png,
│   │   │                            identity.py (whose e-mail a message is: a company's logo, colours and name, or the product's;
│   │   │                            the dark design's colours), logos.py (the logo's opaque renditions, drawn once per process)
│   │   ├── seed_assets/             the demo company's logo, dark-surface logo and icon (written by scripts/demo_brand.py)
│   │   └── api/                     deps.py (sessions, auth, capabilities, services) and routes/*.py (platform.py: the platform owner's;
│   │                                public.py: a company's identity without a session)
│   ├── alembic/                     env.py and versions/ (0001 … 0015)
│   ├── tests/                       unit/, integration/, performance/ (opt-in), conftest.py, support.py, smtp_support.py, qr_png.py,
│   │                                png_support.py (PNG files built chunk by chunk, valid and invalid),
│   │                                memory_support.py (live memory with the garbage collector off)
│   ├── var/                         runtime output (development e-mail outbox); git-ignored
│   ├── pyproject.toml               ruff, mypy, pytest and coverage configuration
│   ├── requirements.txt             runtime lock (pinned, sha256-hashed)
│   ├── requirements-dev.txt         development lock (adds pytest, ruff, mypy, …)
│   └── Dockerfile
├── frontend/                        React 19 + TypeScript SPA (Vite 8)
│   ├── src/
│   │   ├── api/                     client.ts (fetch, CSRF header, error envelope), one module per resource, queryKeys, queryClient
│   │   ├── appearance/              the device's appearance (Light, Dark, System), its colour scheme on the document, the switch
│   │   ├── auth/                    AuthProvider, guards (RequireAuth, RequireRole), roles.ts (SECTION_ACCESS, landing pages)
│   │   ├── components/              ui/ (design system), qr/, print/, app/ (logo lockup, language switch, error boundaries, status screens)
│   │   ├── i18n/                    i18next instance, catalogs locales/{ar,en}/<namespace>.json, language rules, catalog and source tests
│   │   ├── features/<feature>/      routes.tsx (routes + navigation), pages, components, queries.ts, pure logic + tests
│   │   ├── pages/                   thin route components (auth, My visits, invite, visit detail, pass)
│   │   ├── scanner/                 pass-token parser, self-hosted zxing decoder, preload
│   │   ├── pwa/                     service-worker registration
│   │   ├── types/                   api.ts (TypeScript mirror of §8.1), backend-contract.json (generated), api.contract.test.ts
│   │   ├── test/                    Vitest setup, mockApi, fixtures, render helpers, appRoutes.ts
│   │   ├── router.tsx, paths.ts, main.tsx, brand.ts (product, brand, logo files), index.css (design tokens, Tailwind v4 theme)
│   ├── public/                      manifest.webmanifest, brand/ (logo in teal, white and ink), icons/ (generated), sw.js, appearance.js
│   ├── config/                      security headers, service-worker precache plugin, build tests
│   ├── e2e/                         Playwright: support/, flows/, quality/, camera/, top-level specs
│   ├── scripts/                     contract-snapshot.mjs, generate-icons.mjs
│   ├── playwright.config.ts, vite.config.ts, package.json, Dockerfile
│   └── README.md                    frontend scripts, layout and conventions
├── deploy/                          nginx config, PostgreSQL init script and pg_hba, env templates, verification tools, runbook (README.md)
├── docker-compose.yml               postgres → migrate → backend → frontend
├── scripts/
│   ├── db.ps1                       portable PostgreSQL cluster: init | start | stop | status | psql
│   ├── backup.ps1 / backup.sh       pg_dump archives with checksums
│   ├── restore.ps1 / restore.sh     verified restore into a new database
│   ├── lock_hashes.py               adds PyPI sha256 hashes to the backend lock files
│   ├── email_logo.py                writes the e-mail header logo from frontend/public/brand/logo-white.png
│   └── demo_brand.py                writes the demo company's brand images into backend/app/seed_assets/ (through the upload's own check)
├── docs/
│   ├── initial-assessment.md        the binding contract
│   ├── decisions/                   decision log per phase and area
│   ├── contract/pass-token-vectors.json   pass-token grammar shared by the backend and frontend tests
│   └── architecture.md, api.md, security.md, security-audit.md, development.md, …
├── .env.example                     every setting, documented
└── .local/                          portable PostgreSQL binaries and data (git-ignored)
```

Request path through the backend: `api/routes/*.py` → a service from `api/deps.py` → repositories →
models. Routes parse input, declare the capability they need, call one service method and schedule the
e-mail deliveries the service returns. They contain no business logic.

---

## 2. Binding rules and conventions

### 2.1 The cross-cutting rules (contract §3.2)

| # | Rule | Where it lives and what enforces it |
|---|---|---|
| 1 | **Unit of work.** `get_db` yields a session and on exit only rolls back and closes; it never commits. Services call `db.commit()` explicitly. E-mail delivery is scheduled only after the commit. | `app/db/session.py` (`get_db`). `api/deps.py` declares `DbSession = Depends(get_db, scope="function")`, so the cleanup runs before background tasks (`tests/unit/test_dependency_ordering.py`). `email.dispatcher.schedule_delivery` calls `ensure_committed(db)`, which raises if the session is still in a transaction. |
| 2 | **One session factory.** Requests, the dispatcher, the security-event writer and the CLI all get their sessions from `app.db.session.session_factory`. | Tests override only that object (§6). |
| 3 | **Clock.** Business time comes from `app.core.time.now()` (aware UTC), never `datetime.now()` or SQL `now()`. | `FakeClock` in tests (§6). Ruff's `DTZ` rules reject naive datetimes. |
| 4 | **Visit mutations lock the visit.** Every state change loads the visit with `SELECT … FOR UPDATE` by `id` and `company_id` (`VisitRepository.lock`), then validates the transition (`services/visit_rules.assert_transition`), then writes. Audit rows and e-mail jobs come after the guarded write. | Concurrency tests on two real connections (`tests/integration/test_visit_concurrency.py`, `test_reception_concurrency.py`). |
| 5 | **Tenant scoping.** `company_id` comes only from the session user. Every ID in a body or filter is resolved through a company-scoped repository: a path ID that is not found answers 404 `NOT_FOUND`, a body ID 422 `VALIDATION_ERROR` on that field. | `services/scoping.py` (`require_found`, `FieldErrors`). `tests/unit/test_service_helpers.py` fails if a public repository method has no `company_id` parameter and is not on its documented allow-list. The database has composite tenant foreign keys. |
| 6 | **Pagination.** Every paginated or "latest N" query ends its `ORDER BY` with a unique tie-breaker (`…, id` or `seq`). | the repositories' queries; `repositories/pagination.py` (`paginate`) |
| 7 | **Timestamps.** Requests use timezone-aware ISO 8601 (a naive value answers 422). Responses are UTC (`…Z`). Date-only filters are company-local `YYYY-MM-DD`. | `AwareDatetime` in the schemas; `core/time.py` (`company_day_bounds` and friends) |
| 8 | **No PII or secrets in logs or audit metadata.** Audit metadata holds IDs, enums, counts and changed-field names only. | `services/audit.py` accepts metadata strings only if they look like identifiers. `tests/integration/test_log_hygiene.py` checks the logs. |
| 9 | **Frontend contract.** `frontend/src/types/api.ts` mirrors §8.1, and so do the Pydantic schemas. | The contract snapshot (§8): a backend test and a frontend test. |
| 10 | **Shared files.** One builder at a time edits the frontend. Dependencies are not added without a recorded decision. Features add routes in their own `routes.tsx`. | `router.tsx` only composes the feature modules. |

### 2.2 Backend conventions

- **Authorization by capability.** A route declares one of the `…Auth` dependencies from `api/deps.py`
  (`AdminAuth`, `ReceptionAuth`, `ReportsAuth`, …), built with `require_capability(Capability.X)`.
  Roles never appear in routes. The matrix is `CAPABILITY_ROLES` in `app/security/permissions.py`,
  checked against the contract's §7.5 table by `tests/unit/test_permissions.py`. Row-level rules (visit
  ownership, an employee's visitor scope) live in the services.
- **Errors.** Raise the `AppError` subclasses of `app/core/errors.py`. Each maps to one code of contract
  §8.2 and the standard envelope `{"error": {"code", "message", "details"}, "request_id"}`. A 403
  `FORBIDDEN` is audited as `ACCESS_DENIED` automatically. A field problem is a `FieldProblem` (a code
  from `core/field_errors.FieldCode`, the English message and the code's parameters): schema validators
  raise `FieldValueError(problem)`, services collect problems in `FieldErrors` and raise them together.
  Every 422 then carries `details.fields` and `details.field_codes` for the same paths (B10-18;
  `tests/unit/test_field_codes.py` fails on an uncoded `raise` in the schemas). A new code reaches the
  contract snapshot's `field_error_codes` and needs a text in both frontend catalogs
  (`errors:fieldCodes.<code>`).
- **Input models.** Request bodies extend `RequestModel`, which rejects unknown fields and control
  characters and trims invisible characters. Query parameters are one `QueryModel` per endpoint,
  declared as `query: Annotated[Model, Query()]` (`schemas/common.py`). PATCH fields that may be
  omitted but not null use the `NotNull` marker.
- **Audit.** A successful business event is written with `audit.record(db, …)` inside the business
  transaction. Denials and failures go through the security-event writer, which commits on its own
  session so the request's rollback cannot erase them. The `AppError` handler does this for you.
- **Text.** Visitor search text is normalised (casefolded, accents stripped, Arabic folded; see
  `core/search.py`), and the same folding is applied to the query.
- **Style.** Ruff (rule set and per-file ignores in `pyproject.toml`; line length 110; absolute imports
  only) and mypy in strict mode for `app/`. No `type: ignore` without an error code.
- **Python 3.14.** The code uses 3.14 syntax (PEP 695 generics, `except A, B:`), so an older interpreter
  cannot even import it.

### 2.3 Frontend conventions

[frontend/README.md](../frontend/README.md#conventions) lists them in full. The ones most often missed:

- Server state lives only in TanStack Query, UI state in `useState`. There is no other global store.
- The UI is Arabic (right to left) and English. Every text a person reads comes from the catalogs in
  `src/i18n/locales/{ar,en}/` through `t()`, in both languages; layouts use logical classes (`ms-`, `pe-`,
  `start-`, `text-end`), never left/right. See §2.4 and
  [phase-10-frontend.md](decisions/phase-10-frontend.md).
- No explanatory notes: no page, card or empty-state descriptions and no time-zone sentences. Facts go
  in the page header's `meta` line. Errors, validation, data, counts, the password rules and one short
  line before an irreversible action stay.
- Dates are shown and entered in the **company** time zone (`me.company.timezone`) through
  `src/utils/datetime.ts`, never the browser's, and in the UI language (Levantine month names, Latin digits in
  Arabic). Render code takes the current time from `useNow()`.
- Use the semantic design tokens of `src/index.css` (`bg-surface`, `text-fg-muted`, …), never raw palette
  colours (§2.5). Status is always icon plus text.
- A one-time pass link (`pass_url`) lives only in component state, never in the URL, browser storage
  or the query cache.
- Actions on a record appear only when its `permissions` allow them. Roles decide navigation only.
- Sources are UTF-8 without a BOM. Invisible characters are written as `\uXXXX` escapes
  (`config/sourceEncoding.test.ts`).

### 2.4 Languages: Arabic and English

The web application and the e-mails are bilingual. Arabic is the default and is written right to left.
The language rules themselves (account, else company, else device) are in contract §10 and
[phase-10-frontend.md](decisions/phase-10-frontend.md) F10-3 and F10-24.

**Frontend catalogs.** `frontend/src/i18n/locales/{ar,en}/<namespace>.json`, one file per namespace and
language: `common` (shell, UI kit, role names), `errors` (every error code and every 422 field code),
`auth`, `reception`, `visits`, `visitors`, `history`, `inside`, `reports`, `admin`, `pass` and `platform`
(the platform owner's area, Phase 11). Both
languages are bundled (`resources.ts`) and loaded at start-up, so a switch fetches nothing.

**Type-safe keys.** `src/i18n/i18next.d.ts` declares the English catalogs as the resource type. In a
component with `useTranslation('visits')`, `t('detail.title')`, `t('common:actions.close')` and
`t('list.count', { count })` are checked by `npm run typecheck`: a misspelt or missing key fails it.
English is the type source; Arabic must have exactly the same keys. English texts are what the unit
tests and the E2E selectors read, so change one only on purpose.

**The tests that hold the rules** (all part of `npm test`, or of `pytest` for the e-mails):

| Test | Fails when |
|---|---|
| `src/i18n/catalogs.test.ts` | a namespace or key exists in one language only; a counted key lacks a plural form (English `_one`, `_other`; Arabic all six: `_zero`, `_one`, `_two`, `_few`, `_many`, `_other`); a text is empty; an Arabic text uses other variables than its English text; an Arabic text holds a Latin word other than UTC and QR; an error code of the contract snapshot has no message; an Arabic term rule is broken (checking a visitor in is «تسجيل الدخول»; a role beside a person is a job title) |
| `src/i18n/hardcodedText.test.ts` | a source under `src/` (tests excepted) renders literal text: JSX text, a string rendered as a child (also through `? :`, `&&`, `??`), or a string in an attribute people read or hear (`aria-label`, `title`, `placeholder`, `alt`, `label`, …). Its `ALLOWED` map (file and reason) is empty |
| `src/i18n/logicalProperties.test.ts` | a Tailwind class names a physical side (`ml-`, `pr-`, `left-`, `text-right`, `rounded-r-`, `border-l`, …; `left-1/2` centring is allowed) |
| `src/i18n/fieldMessages.test.ts` | the `errors:fieldCodes.*` texts differ from the snapshot's `field_error_codes`: one text per code in each language, only the code's parameters, plural forms exactly for the counted codes |
| `src/features/admin/auditVocabulary.test.ts` | an audit metadata key or value the backend writes (read from its source) has no words in a language |
| `backend/tests/unit/test_email_i18n.py` | an e-mail catalog key lacks a language; the two languages have different placeholders; an Arabic text does not start with an Arabic word, or holds invisible characters or Arabic-Indic digits |
| `backend/tests/unit/test_email_bidi.py` | a placeholder of the e-mail catalog is in none, or more than one, of the direction sets of `email/i18n.py` |

**Adding a string to the web application:**

1. Add the key to the English catalog of the namespace the component uses
   (`src/i18n/locales/en/<namespace>.json`). Write a fact, a label, an error or an action, never an
   explanatory note.
2. Add the same key to `src/i18n/locales/ar/<namespace>.json`, in Modern Standard Arabic: names, e-mail
   addresses and codes as `{{variables}}` (no Latin words), all six plural forms for a counted text, and
   no gendered verb or adjective in a sentence whose subject is a person's name («أُلغيت بواسطة
   {{name}}»).
3. Use it: `const { t } = useTranslation('<namespace>')`, then `t('<key>', { … })`. Outside a component,
   read the text when it is needed (`lazyTexts({...})` or a function), never into a module-level
   constant; a key built from an API code goes through `catalogText(namespace, key)`, which returns null
   for an unknown code so the caller can fall back.
4. A sentence with an element inside (a link, a count kept on one line, an e-mail address) is one catalog
   sentence split by `withParts` (React) or `textWithParts` (plain text), so each language orders its own
   words.
5. Run `npm run typecheck` and `npx vitest run src/i18n`.

**Formatting.** Format dates, times, numbers and durations only with `src/utils/datetime.ts`, `number.ts`
and `duration.ts`; they follow the UI language: Levantine month names in Arabic («تشرين الأول»), Latin
digits in both languages, 24-hour times, the company's time zone. Build a time range with
`joinTimeRange` / `joinSpacedRange`, never with a bare dash: an Arabic date and a range must not break
across lines. Items of data in one line go through `DataLine`, which isolates each value (`<bdi>`). The
company is named through `useCompanyName`, a department through `useDepartmentName()` (its Arabic name in
the Arabic UI when it has one; `src/i18n/departmentNameGuard.test.ts` fails on a direct `department.name`),
the product through `useProductName()` / `BrandLockup`.

**Adding a string to the e-mails.** Add the key to `MESSAGES` in `backend/app/email/i18n.py` with both
`EN` and `AR`, using `{placeholders}`. A new placeholder goes into one of `ISOLATED_VALUES` (names,
typed by people), `LEFT_TO_RIGHT_VALUES` (addresses, links) or `FORMATTED_VALUES` (dates and times the
service writes in the sentence's language). Templates render it with `t(language, key, …)`, which
escapes the text and each value. Run `pytest tests/unit/test_email_i18n.py tests/unit/test_email_bidi.py
tests/unit/test_email_templates.py`. The English text part keeps the strings the E2E suite reads
(`Hello <name>`, `Host: <name>`, the pass URL, `Your visitor <name> has arrived and checked in`).

### 2.5 Design tokens

The colours, type scale and radii are tokens in `frontend/src/index.css` (Tailwind v4 `@theme`), in
mawdoo3.com's palette: side-nav teal `#188086`, turquoise `#27b5bb`, light turquoise `#49cbd2`, slate
`#33444e`, yellow `#f7b916`, greys `#f8f8f8` and `#f1f1f1`. The logo's own teal `#169897` is used only
for the logo and the app-icon tile.

| Token set | Where it applies |
|---|---|
| `@theme static` (light) | the content area: canvas `#f1f1f1`, white surfaces, slate text |
| `theme-dark` | the whole app in the dark colour scheme, and dark surfaces inside a light page (the reception tablet, emphasis tiles) |
| `theme-shell` | the teal shell: sidebar, top bar, drawer |
| `theme-shell-deep` | the shell in the dark scheme and around a dark screen (`#0f3b3f`) |

Components use the semantic names only (`bg-surface`, `text-fg-muted`, `bg-accent`, `text-accent-text`,
`bg-attention`, `bg-highlight`, tones, `status-*`, `chart-*`), so each works in every set. A route that
is dark from edge to edge declares `handle: DARK_SURFACE_HANDLE` (`layouts/shellSurface.ts`); it is
drawn light on a device that chose Light.

**The dark colour scheme is the device's appearance** (Phase 13): Light, Dark or System (the device's own
`prefers-color-scheme`). It is `data-scheme="light|dark"` on the root element, put there before the first
paint by `public/appearance.js` and kept by `src/appearance/appearance.ts`. Everything that means dark
goes through one switch: the `scheme-dark` variant of `index.css` (`@variant scheme-dark { … }` in CSS,
`scheme-dark:` on a class), and `useColorScheme()` in script. Never write `@media (prefers-color-scheme)`
or Tailwind's own `dark:`, which follow the device and not the choice; `appearance/appearance.test.ts`
fails on either.

**A choice shown by its fill alone** (the appearance's segments, a menu's choice tiles) also takes
`FORCED_COLORS_CHOSEN` (`components/ui/buttonStyles.ts`): a forced-colours mode (Windows' contrast themes)
draws every fill as the system's `Canvas`, and the chosen one would look like the others (Phase 13, F13-18).

**Contrast notes** (WCAG 2.x, written beside each token):

- White text reads only on `#188086` and darker: 4.70:1 there, but 3.52:1 on the logo teal and 2.50:1 on
  turquoise. Primary buttons, links and the focus ring therefore use `#188086`; hover and link text
  `#136a6f` (white 6.33:1; 5.60:1 on the canvas).
- Turquoise, light turquoise and yellow are fills behind ink text (6.18:1, 7.90:1, 8.74:1), indicators,
  chart marks with a label, or large accents; never a colour for small white text.
- Light text: `#1c262b` 15.42:1, slate `#33444e` 10.11:1, muted `#4d616c` 6.48:1 (5.73:1 on the canvas),
  placeholder `#627883` 4.63:1; control borders `#718691` 3.80:1.
- On the teal shell only pure white reads; the current page is a white pill with teal text (6.33:1).

`src/designTokens.test.ts` parses `index.css` and checks every text pair (at least 4.5:1) and every
boundary, indicator and focus pair (at least 3:1) in each of the four sets: a token edit that breaks
contrast fails `npm test`. Add a new pair to that test with its ratio beside the token.

**Fonts** are Readex Pro (Arabic and Latin) and Space Grotesk (KPI numerals, counts, codes), self-hosted
from `@fontsource-variable` with the Arabic and Latin subsets only.

**E-mails** have their own palette in `backend/app/email/templates/` (header `#188086` with the white
logo, ink `#1E2A32`, slate `#33444E`, muted `#5A6872`, teal text `#146E73`, notices `#E5F6F7` and
`#FEF5DC`; B10-17), checked by `tests/unit/test_email_design.py`. That palette is the product's own (the
test e-mail of the command line) and the default of a company without a colour. A company with a colour
has its own (`backend/app/email/identity.py::colors_of`, from `app.core.palette`): the bar of the header
and the primary button are the palette's `surface` with `on_surface` text, the company's colour as it was
chosen wherever an ink reads on it (B12-21); text in the brand's colour on white and the edge of every
button are `strong`; `tests/unit/test_email_identity.py` holds every pair over a grid of the RGB cube.
After a change of the templates, look at them: no e-mail may be wider than a phone (B12-23; the
measurements of 2026-10-14 are in [phase-12-backend.md](decisions/phase-12-backend.md)). **A running API
process reads a changed template at once, with the code it started with** (B12-26): a template that needs
a value the running code does not pass makes every e-mail of that process fail until it is restarted. So
restart the API after changing a template and its code together, or give the new value a `default(...)`
in the template for as long as an older process may be running. The header logo is
`backend/app/email/assets/brand-logo.png`: `frontend/public/brand/logo-white.png` composited onto the
header teal, so it stays readable where a mail client inverts the background. After changing the white
logo, run `python scripts/email_logo.py` from the repository root; `--check` exits 1 when the packaged
file is out of date (the backend test checks the same). The app icons come from the same logo:
`npm run icons` in `frontend/`.

---

## 3. Everyday commands

| Task | Command (run from) |
|---|---|
| Start, stop, check PostgreSQL | `./scripts/db.ps1 start` / `stop` / `status` (repository root) |
| psql on the dev database as the owner | `./scripts/db.ps1 psql` (repository root) |
| Migrate the dev database | `.\.venv\Scripts\python.exe -m alembic upgrade head` (`backend/`) |
| Demo data | `.\.venv\Scripts\python.exe -m app.cli seed-demo` (`backend/`): the company Mawdoo3, Arabic by default: users named in Arabic, departments and the address in English and Arabic. `seed-e2e` creates the same company with English names only, plus "Other Corp" in English. Both create the platform owner's demo account `platform@demo.local` (same password; sign in at `/platform/login`) |
| API | `.\.venv\Scripts\python.exe -m app.serve` (`backend/`): <http://127.0.0.1:8000> |
| SPA | `npm run dev` (`frontend/`): <http://localhost:5173>, proxying `/api` to port 8000 |
| SPA against an API on another port | `$env:VMS_API_PROXY_TARGET = 'http://127.0.0.1:8010'; npx vite --port 5180 --strictPort` (`frontend/`). Add `http://localhost:5180` to `ALLOWED_ORIGINS` of that API, or every sign-in and other unsafe request from the page answers 403 `CSRF_FAILED` |
| Read the development e-mails | `backend\var\outbox\*.json` (`message_id`, `kind`, `to`, `subject`, `pass_url`, `reset_url`, `created_at`) and the `.html` files |
| Send a real test e-mail | `.\.venv\Scripts\python.exe -m app.cli send-test-email --to you@example.com` (`backend/`); Arabic leads, `--language en` puts English first; see §3.1 |
| Regenerate the e-mail header logo | `backend\.venv\Scripts\python.exe scripts/email_logo.py` (repository root; `--check` only compares) |
| Regenerate the demo company's brand images | `backend\.venv\Scripts\python.exe scripts/demo_brand.py` (repository root; `--check` only compares): copies the logo, the white logo and the 512-pixel icon from `frontend/public` into `backend/app/seed_assets/` through `sanitize_png`, so the seeds store what an upload would |
| Brand a company | as the platform owner, on the company's identity page (`/platform/companies/<id>/identity`), or with the API ([README §1.5](../README.md#15-a-companys-own-identity)). `seed-demo` gives `demo-company` the Mawdoo3 identity; `seed-e2e` also creates `other-corp` without one |
| Look at the e-mails of a branded company | brand it, then read `backend\var\outbox\*.html` (the company's logo is `<message_id>-brand-logo.png`; a company without a logo has no such file) |
| Regenerate the app icons | `npm run icons` (`frontend/`) |
| Reset the dev database | see below |

The `.env` at the repository root configures the API, the CLI, Alembic and the backend tests. Use
variables in the shell for one-off changes: they take precedence over `.env`.

**Resetting the development database.** Stop the API first. Then, from the repository root (this is
the schema reset the E2E setup performs):

```powershell
$env:PGPASSWORD = 'vms_owner_local_dev'
.\.local\pgsql\bin\psql.exe -h localhost -p 5433 -U vms_owner -d vms -v ON_ERROR_STOP=1 `
  -c "DROP SCHEMA public CASCADE" -c "CREATE SCHEMA public AUTHORIZATION vms_owner" `
  -c "GRANT USAGE ON SCHEMA public TO PUBLIC, vms_app" -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
Remove-Item Env:PGPASSWORD
cd backend
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m app.cli seed-demo
```

### 3.1 Sending real e-mail

With `EMAIL_PROVIDER=outbox` (the development default) nothing leaves the computer: invitations are
files in `backend\var\outbox`. To see what a visitor really receives, use the SMTP provider.

**A local capture server** (no account, nothing leaves the computer; the message is printed in full):

```powershell
# terminal 1 (backend/): aiosmtpd is a development dependency
.\.venv\Scripts\python.exe -u -m aiosmtpd -n -l 127.0.0.1:1025

# terminal 2 (backend/): one-off settings in the shell override .env
$env:EMAIL_PROVIDER = 'smtp'; $env:SMTP_HOST = '127.0.0.1'; $env:SMTP_PORT = '1025'; $env:SMTP_SECURITY = 'none'
.\.venv\Scripts\python.exe -m app.cli send-test-email --to you@example.com
Remove-Item Env:EMAIL_PROVIDER, Env:SMTP_HOST, Env:SMTP_PORT, Env:SMTP_SECURITY
```

Verified for this guide: the command printed `test e-mail to you@example.com accepted by the mail
server 127.0.0.1:1025 (none)`, and terminal 1 printed the message (`multipart/alternative`, the text
part, then the HTML with the inline QR code). `SMTP_SECURITY=none` is accepted only outside production
and never with credentials. Start the API with the same variables to capture every e-mail it sends.

**A real mailbox through Gmail** (README §10 has the full steps):

1. Turn on 2-Step Verification for the Google account, then create an App Password at
   myaccount.google.com/apppasswords.
2. In the repository's `.env`: `EMAIL_PROVIDER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`,
   `SMTP_SECURITY=ssl`, `SMTP_USERNAME=<the Gmail address>`, `SMTP_PASSWORD=<the App Password>`,
   `EMAIL_FROM=Mawdoo3 Visitors <the same Gmail address>`. Where outbound port 587 is open,
   `SMTP_PORT=587` with `SMTP_SECURITY=starttls` works too; the port and the mode must match. The
   password belongs in `.env` only (git-ignored): never on a command line, in a script or in a chat.
3. Run `.\.venv\Scripts\python.exe -m app.cli send-test-email --to <your address>` and open the
   message: the logo heads it, and the sample QR code shows inside it. Then restart the API so that
   invitations use the same settings.
4. For a visitor's phone to open the pass, `QR_BASE_URL` must be an address the phone can reach (see
   "Tablets on the LAN" in §9). With `localhost` the command and the API print a warning.

On failure the command prints the classified error, the same text an invitation shows under *Needs
attention*: for example `test e-mail not sent (permanent): The mail server refused the SMTP sign-in
(SMTP 535 5.7.8); check SMTP_USERNAME and SMTP_PASSWORD.` (the account's own password instead of an App
Password, or a typo), or `test e-mail not sent (temporary: a real message would be retried): Could not
connect to the mail server …` (a wrong host or port, or a firewall). It never prints a password, and it
needs no database.

---

## 4. Adding things end to end

Start from the contract. A new endpoint, field or table is a contract change: update
`docs/initial-assessment.md` (§4, §8, §8.1) or record a decision in `docs/decisions/` before the code.

### 4.1 A migration

1. **Change the model** in `backend/app/models/`. Follow the conventions of contract §4:
   - UUIDv4 primary keys;
   - `created_at` / `updated_at` from the app clock;
   - `company_id` on tenant tables, with composite foreign keys `(company_id, x_id)`;
   - enums as `VARCHAR` + `CHECK`;
   - partial or expression uniqueness as named unique indexes. Services map
     `UniqueViolation.diag.constraint_name` to error codes, so the name matters.
2. **Write a new revision.** Do not edit an applied one.

   ```powershell
   cd backend
   .\.venv\Scripts\python.exe -m alembic revision -m "short description" --rev-id 0016
   ```

   (The next free number is `0016`: revision `0013` is Phase 11's, `0014` its security review's and `0015`
   Phase 12's, a company's brand.) This writes
   `alembic/versions/<yyyymmdd>_<rev-id>_short_description.py` with `down_revision` set to the current head.
   Keep the four-digit numbering of the existing files, and run `ruff format` on the new file.
   `--autogenerate` (it needs `MIGRATION_DATABASE_URL`) can draft the operations. Review what it
   writes: grants, triggers, extensions and `CHECK` details need hand-written SQL.
3. **Privileges.** The runtime role gets privileges only from migrations. The default privileges set
   by `0001` (narrowed by `0006`) give every new table `SELECT, INSERT, UPDATE`, and every new
   sequence `SELECT, USAGE`, to the role named by `DB_APP_ROLE`. A table that needs anything else must
   say so explicitly in the migration.
   Production refuses to start if the runtime role holds privileges beyond the allowlist in
   `app/db/privileges.py` (no `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES`, `MAINTAIN`, nothing on
   `alembic_version`, no `UPDATE` on `audit_logs`). A deliberate new kind of privilege is therefore a
   change to that allowlist and its tests too.
4. **Downgrade.** Every revision has one. If a downgrade would lose data or widen access, refuse it
   with a guard, as `0003`, `0008`, `0011`, `0012`, `0013`, `0014` and `0015` do (lock the tables before
   counting, SEC-39: `0015` locks `companies` and `company_brand_assets`). A revision that changes an
   enumeration's `CHECK` (a new e-mail kind, as `0008` and `0014`) refuses its downgrade while a row holds the
   new value. The whole downgrade is one transaction: when an older revision refuses, the newer ones'
   steps are undone with it. New columns of an existing table need no
   grant: the table-level privileges cover them (`test_migrations.py` writes `0012`'s columns as the
   runtime role).
5. **Large tables.** Plain `CREATE INDEX` blocks writes. Use `if_not_exists=True` and give the
   `CREATE INDEX CONCURRENTLY` statement in the docstring for operators (see `0010`).
6. **Run and test:**

   ```powershell
   .\.venv\Scripts\python.exe -m alembic upgrade head
   .\.venv\Scripts\python.exe -m pytest tests/integration/test_migrations.py
   ```

   `test_models_match_migration` fails if autogenerate still finds a difference between the models and
   the migrated schema, or if a schema built from the models differs from the migrated one (columns,
   defaults, constraint definitions, indexes). `test_downgrade_then_upgrade_is_clean` goes down to
   `0005` and to `base`, then up again, and compares the schema and the grants.

### 4.2 An endpoint

Take `GET /api/v1/departments` (`app/api/routes/departments.py`) as the smallest complete example.

1. **Schemas** (`app/schemas/<resource>.py`): a `RequestModel` for the body, a `QueryModel` for query
   parameters, and response models whose names match the TypeScript names in §8.1.
2. **Repository** (`app/repositories/<resource>.py`): every public method takes `company_id`. A new
   repository class must be added to `REPOSITORIES` in `tests/unit/test_service_helpers.py`;
   `test_every_repository_is_covered` fails until it is.
3. **Service** (`app/services/<resource>.py`):
   - check capabilities with `has_capability` and apply the row-level rules;
   - resolve every ID through the repositories (rule 5);
   - take the row lock for visit changes (rule 4);
   - write audit rows with `audit.record`;
   - call `db.commit()` explicitly;
   - return any `DeliveryJob`s instead of sending e-mail.
4. **Capability**: use an existing `…Auth` alias from `api/deps.py`. If the endpoint needs a role set
   that no capability covers, add a `Capability` and its `CAPABILITY_ROLES` entry, and update the
   expected matrix in `tests/unit/test_permissions.py`.
5. **Route** (`app/api/routes/<resource>.py`): declare the body, the `…Auth` dependency, the service
   dependency and `ContextDep`, then call the service. If the service returned delivery jobs, add
   `db: DbSession`, `dispatcher: EmailDispatcherDep` and `background_tasks: BackgroundTasks`, and call
   `schedule_deliveries(background_tasks, db, dispatcher, jobs)` after the service call (see
   `routes/visits.py`). A new route module is included in `app/api/routes/__init__.py`. Unsafe methods
   are covered by the CSRF and Origin middleware automatically. Only the three anonymous auth
   endpoints are exempt from the token check (`app/security/csrf.py`).
6. **Contract registration** (`app/contract.py`): add new response models to `RESPONSES`, bodies to
   `REQUESTS`, query models to `QUERIES`, and the `(method, path)` of a route with query parameters to
   `QUERY_ROUTES`. `tests/integration/test_query_contract.py` fails if a route declares query
   parameters that are not exactly its registered model's. Then regenerate the snapshot (§8).
7. **Tests** (`tests/integration/`):
   - the role matrix: every role, allowed and refused;
   - two-company isolation for every ID the endpoint accepts (404 for path IDs, 422 for body IDs);
   - an audit row for success and for refusal;
   - for visit changes, a concurrency test with the `committed` marker (§6).

   The existing `test_rbac*.py` and `test_tenant_isolation_*.py` files show the patterns.
8. **Frontend**: the TypeScript types in `src/types/api.ts` (§8), then an API function and a page
   (§4.3).

Three kinds of endpoint have rules of their own:

- **The platform owner's** (`routes/platform.py`, Phase 11): `PlatformAuth` instead of a capability; a
  write locks the company row and calls `require_platform_still_authorized` before it changes anything
  (B11-38); audit with `audit.record_platform_change`, which writes the platform's row and the company's
  (without address or browser). Add the route to `MAIN_ONLY_ROUTES` in
  `deploy/verify/test_api_instances.py`: every platform request stays on the main process.
- **Without a session** (`routes/public.py`, Phase 12): no dependency may read a cookie; every route
  depends on `Counted` (the client's budget, before anything is looked up); only **active** companies,
  by slug, and one 404 for everything else; a response sets its own `Cache-Control` and `ETag` through
  `_answer` (the middleware lets only `/api/v1/public/` do so, and only where the route did: errors stay
  `no-store`). Think twice before adding one: whatever it answers is public. It goes into
  `MAIN_ONLY_ROUTES` too.
- **A body that is not JSON** (the upload of a brand image, Phase 12): read it in a dependency that
  depends on the authentication dependency (`read_png_upload`), so nothing is read for a caller who is
  refused; give the route its own `BodyLimit` in `create_app` when it needs more than
  `MAX_REQUEST_BODY_BYTES`, and nginx a matching location (`deploy/nginx/templates/vms.conf.template`;
  `deploy/verify/test_api_instances.py::BrandUploadTests` holds the two together). Never trust the
  declared media type for what the bytes are: an image goes through `core/png.py`.

### 4.3 A page

1. **API function** in `src/api/<resource>.ts` with `apiRequest` from `src/api/client.ts`. It sends
   the CSRF header, parses the error envelope into `ApiError` and encodes path segments (`segment(id)`).
2. **Query key** in `src/api/queryKeys.ts`, hierarchical so that invalidating a prefix refreshes every
   list and detail below it. Put the hooks (`useQuery`, `useMutation`) in `features/<feature>/queries.ts`.
3. **Page**: put the components and pure logic in `features/<feature>/`. The page component stays thin
   (document title, layout, the feature component). Every text comes from the feature's catalog
   namespace, added in English and Arabic (§2.4); the document title is translated too. Forms use
   `useFormErrors` to merge client validation with the server's 422 field errors, which it shows by
   their field codes in Arabic.
4. **Route and navigation** in `features/<feature>/routes.tsx`:
   - a **lazy** route (`lazy: async () => ({ Component: (await import('./XPage')).XPage })`), wrapped in
     `<RequireRole roles={SECTION_ACCESS.x} />`;
   - a nav entry with `to`, `label`, `icon`, `roles`, `section` and `order`;
   - the path in `src/paths.ts`;
   - a new section of `SECTION_ACCESS` in `src/auth/roles.ts`;
   - a new feature module in the `features` array of `src/router.tsx`.

   `config/chunking.test.ts` checks that lazy pages stay out of the start-up chunks.
5. **Unit tests** (Vitest + Testing Library):
   - mock the API with `mockApi({ 'GET /path': () => jsonResponse(…) })` from `src/test/api.ts`. An
     unmatched request fails the test;
   - build data with the fixtures in `src/test/fixtures.ts`;
   - tests that render the whole app import `routes` from `src/test/appRoutes.ts`, which preloads the
     lazy pages;
   - fake only the clock (`vi.useFakeTimers({ now, toFake: ['Date'] })`).
6. **E2E**:
   - the suite reads the English UI: its global setup pins both companies to English, so a spec that
     needs Arabic switches a user it created itself (as `e2e/i18n-smoke.spec.ts` and
     `e2e/quality/arabic-reflow.spec.ts` do), never a seeded account;
   - add the page to the axe and overflow list (`PAGES` in `e2e/quality/accessibility.spec.ts`) for
     every role that may open it;
   - add a dialog to `e2e/quality/dialogs.spec.ts`;
   - a page of the platform owner's area uses the platform session: `open({ platform: true })`,
     `Api.platform()` and `platformStorageStatePath()` (the global setup signs `platform@demo.local` in once);
     never sign it out or change its password or language;
   - add the route to the global setup's warm-up list (`e2e/support/global-setup.ts`), so the first
     test that opens it is not hit by a Vite re-optimisation.

---

## 5. Quality gates

Run all of these before handing over a change. The backend results below are from the Phase 12 backend
gate of 2026-10-13 (revision `0015`, a company's own identity,
[phase-12-backend.md](decisions/phase-12-backend.md); the gate of the Phase 11 security and UX review of
the same day, revision `0014`, had 3,426 tests in 437 s and 537 s, and the Phase 11 backend gate of
2026-10-12, revision `0013`, 3,236 tests in 296 s and 318 s); the frontend results
are from the Phase 11 frontend gate of 2026-10-13 (the platform owner's area and the e-mail texts page,
[phase-11-frontend.md](decisions/phase-11-frontend.md)), on the reference machine (Windows 11, Python 3.14.6, Node 24.19,
PostgreSQL 18.6 on port 5433). The coverage rows are from the Phase 10 gate, before those requests.

**Backend** (`backend/`):

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -m mypy
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m pytest --committed-first
```

| Check | Result (2026-10-14, after the UX review of Phase 12) |
|---|---|
| `ruff check .` (ruff 0.16.10) | all checks passed |
| `ruff format --check .` | 306 files already formatted |
| `mypy` (2.4.0, strict) | no issues in 159 source files |
| `pytest` (9.1.1) | 4,240 passed, 0 failed, 3 skipped, 763.47 s (the machine was shared with the frontend's work). On 2026-10-13, while the frontend's E2E suite kept every processor busy, two runs had 1 failed: `test_the_response_time_excludes_background_work` asserts that a response takes less than half a second, and it took 0.9 to 1.0 s. That is the machine, not the code: the unchanged code failed the same test under the same load |
| `pytest --committed-first` | 4,240 passed, 0 failed, 3 skipped, 821.83 s (the machine was shared with the frontend's work) |
| `pytest tests/unit/test_contract_snapshot.py` | 6 passed; the committed file is byte for byte what the generator writes (regenerated in that round for the three new fields of `BrandPalette`) |
| `pytest --cov=app --cov-branch` (Phase 10 gate, before revision `0012`) | 2,974 passed, 3 skipped, 314.64 s. Lines 97.97 % (8,483 of 8,659), branches 93.56 % (1,641 of 1,754), combined 97.22 %; 134 files, 85 fully covered |

The lowest-covered backend files are `app/services/no_shows.py` (84 %), `app/cli.py`,
`app/core/time.py`, `app/email/providers/outbox.py` and `app/serve.py` (90 % each). The 3 skipped tests
are the opt-in volume checks:

```powershell
.\.venv\Scripts\python.exe -m pytest --performance -s tests/performance
```

The volume check seeds about 60,000 visits into its own throwaway database. It asserts the query plans
(no sequential scans on `visitor_passes` or on `audit_logs` for the date filter, no parallel plan for
the audit log's count, no report spilling to disk) and latency budgets (`GET /reception/today`, scan
and QR check-in p95 under 300 ms). It was not run for this guide. Its last recorded results are in
[phase-9-backend.md](decisions/phase-9-backend.md) (re-audit round 1) and
[production-readiness.md](production-readiness.md) §3.5 (both performance re-audits: 3 passed).

Useful pytest selections: `pytest tests/unit`, `pytest tests/integration/test_scan_api.py -k expired`,
`pytest -x --lf`.

**Frontend** (`frontend/`):

```powershell
npm run typecheck      # tsc -b
npm run lint           # oxlint --deny-warnings
npm test               # Vitest (includes the catalog, source and design-token tests of §2.4 and §2.5)
npm run test:coverage  # the same tests with v8 coverage
npm run build          # tsc -b && vite build
npm run e2e:typecheck  # tsc over the Playwright suite
```

| Check | Result (2026-10-13) |
|---|---|
| `npm run typecheck`, `npm run e2e:typecheck` | 0 errors |
| `npm run lint` (oxlint 1.86.0) | 0 warnings, 0 errors on 551 files, 231 rules |
| `npm test` (Vitest 5.0.3) | 136 files, 1,495 tests passed, 0 failed, 132.27 s |
| `npm run test:coverage` (Phase 10 gate, before the requests of 2026-10-08) | 1,349 passed. Statements 95.16 % (6,200 of 6,515), branches 91.10 % (5,103 of 5,601), functions 94.71 % (2,008 of 2,120), lines 96.55 % (5,405 of 5,598) |
| `npm run build` (Vite 8.3.2) | succeeded with no warnings, 2,757 modules |

`npm run build` writes `frontend/dist/`; to build somewhere else, append
`-- --outDir <folder> --emptyOutDir`. The build's sizes (Vite's kB, raw / gzip): the start-up `app`
chunk 280.79 / 79.37, `react` 218.84 / 68.25, the stylesheet 91.99 / 16.62; everything `index.html`
loads (7 JavaScript files and the stylesheet) 771.95 / 221.37. The `app` chunk carries both languages'
catalogs, by design (no download on a switch); the platform owner's area and the e-mail texts pages are
lazy chunks of their own. The zxing decoder (1,093.28 / 463.82) loads only on staff
devices that scan.

**Dependency audits** (not part of the scripts; run before a release):

```powershell
npm audit --omit=dev                                  # frontend/: 0 vulnerabilities in 56 production dependencies
```

pip-audit is not installed in the backend's virtual environment. On 2026-10-08 pip-audit 2.10.1 was run
from a separate install with the backend's interpreter: no known vulnerabilities in `requirements.txt`
(39 hashed pins) or `requirements-dev.txt`. The full npm tree (250 packages, development included) also
had 0. Adding both audits to CI is go-live checklist item A
([production-readiness.md](production-readiness.md) §15).

**Deployment files** (repository root; use the backend's interpreter, or `python3` on Linux):

```powershell
backend\.venv\Scripts\python.exe deploy/verify/check_release_tree.py
backend\.venv\Scripts\python.exe -m unittest discover -s deploy/verify -p "test_*.py"
node deploy/verify/check_nginx_headers.mjs     # nginx headers == frontend/config/securityHeaders.ts
backend\.venv\Scripts\python.exe -m ruff check deploy
backend\.venv\Scripts\python.exe -m ruff format --check deploy
```

All passed on 2026-10-13 (Phase 12): 1,066 files checked, no development artefact or credential; 42 unit tests OK,
none skipped (7 added in Phase 12: the upload's nginx location and limits, no caching by nginx, the new routes on the main process, a neutral page shell); 7 headers in sync; `ruff` clean, 6 files formatted. The unit tests include:

- `deploy/verify/test_api_instances.py`, which keeps the nginx routing map, the upstreams, the backend
  test's list of routed reads and the API services and replicas of `docker-compose.yml` in step. It also
  requires the read services to run `backend`'s image, command and env file and to override only
  `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE` (D9-37). Its 7 compose tests are skipped when PyYAML is
  not installed (the backend's development environment has it). Since Phase 12 it also lists every
  platform and public route as a route of the main process (`MAIN_ONLY_ROUTES`), and `BrandUploadTests`
  holds nginx's one larger body limit to the API's: the nested location matches exactly what the upload
  route matches and no other route, its limit is `BRAND_ASSET_MAX_BYTES`, the body stays in memory, uploads
  in progress are bounded, and nginx sets no caching rule on the way to the API.
- `deploy/verify/test_brand_names.py` (F10-final-2): no retired product name ("Visitor Management",
  the old demo company's name, "VMS" as a word, "Visitor" as a sender's name) where a person or an
  operator reads the product's name: the page shell, the manifest, the service worker, the catalogs,
  the e-mails, the CLI, the scripts, the deployment templates and the image labels. Its `SURFACES` list
  and its `ALLOWED` exemptions (file and reason) are where to extend it. Internal identifiers (`vms`,
  `VMS_*`, `vms-backend`) are not names. Documentation is not checked by it. Since Phase 12 the page
  shell (`frontend/index.html`) must name **neither** the product nor a company (it is what a link preview
  of a visitor's pass shows), while the manifest of the build, the platform owner's installed app, keeps
  the product's name.

`python scripts/email_logo.py --check` (repository root) exits 1 when the e-mail header logo is out of
date with the white logo; the backend test `tests/unit/test_email_design.py` checks the same.
`python scripts/demo_brand.py --check` does the same for the demo company's brand images in
`backend/app/seed_assets/`; `tests/integration/test_seed_brand.py` runs it.

**The nginx configuration against a real nginx** (optional; Phase 12 did it with nginx 1.30.5 for Windows,
[phase-12-backend.md](decisions/phase-12-backend.md), Verification): render `deploy/nginx` with test paths,
ports and upstream addresses, run `nginx -t`, start it in front of the API on a throwaway database and run
`deploy/verify/smoke_test.py --base-url https://localhost:<port> --insecure --no-hsts`. The smoke test
includes the upload's body limit and the public endpoints.

---

## 6. Backend test harness

The harness is in `backend/tests/conftest.py` and `backend/tests/support.py`.

### 6.1 Throwaway databases

- The session-scoped `create_database` fixture connects as the **owner** role and runs
  `CREATE DATABASE "<prefix>_<random hex>"`. It revokes `TEMPORARY` from `PUBLIC`, as `db.ps1` does
  for `vms` and `vms_e2e`, then runs `alembic upgrade head` programmatically. Logging is left alone
  (`configure_logging=False`). The application connects to that database as the **runtime** role.
- All databases are dropped at the end of the session (`DROP DATABASE … WITH (FORCE)`, retried for up to
  10 s while an autovacuum worker finishes). The suite never touches `vms` or `vms_e2e`.
- Connection settings come from `VMS_TEST_MIGRATION_DATABASE_URL` and `VMS_TEST_DATABASE_URL` (and
  `VMS_TEST_DB_APP_ROLE`, default `vms_app`) when both URLs are set, otherwise from
  `MIGRATION_DATABASE_URL` and `DATABASE_URL` in `.env`. Only the database name is replaced. To run the
  suite against another cluster:

  ```powershell
  $env:VMS_TEST_MIGRATION_DATABASE_URL = 'postgresql+psycopg://vms_owner:vms_owner_local_dev@localhost:5487/vms'
  $env:VMS_TEST_DATABASE_URL = 'postgresql+psycopg://vms_app:vms_app_local_dev@localhost:5487/vms'
  .\.venv\Scripts\python.exe -m pytest
  ```

  This exact form ran the full suite on a separate throwaway cluster for this guide. Provision the
  roles as `db.ps1 init` does: the owner has `CREATEDB` and is a member of the runtime role
  (`GRANT vms_app TO vms_owner`; the script grants it for the tests that create databases).
- Test settings are built explicitly (`_test_settings`): `APP_ENV=test`, `https://vms.test` origins,
  `COOKIE_SECURE=true`, the in-memory e-mail provider, and rate limits on. The developer's `.env` does
  not change the behaviour under test.

### 6.2 One rolled-back transaction per test

Most tests share one migrated database (`vms_test_*`). The `connection` fixture opens a connection,
begins an outer transaction, and overrides `session_factory` with a sessionmaker bound to that
connection (`join_transaction_mode="create_savepoint"`). Every session in the test therefore joins the
outer transaction: the requests through `TestClient`, the security-event writer, the e-mail dispatcher
and the CLI. Their `commit()` calls only release savepoints, and the whole transaction is rolled back
when the test ends.

- `client` is a `TestClient` with `base_url="https://testserver"`, so `Secure` cookies are sent, and
  client address `203.0.113.10`, a real IP. `make_client(**kwargs)` builds more clients, for example a
  second user or another address.
- `factory` (`tests/support.Factory`) creates companies, departments, users and visits. `world` builds
  two companies (`world.a`, `world.b`), each with an administrator, an employee, a receptionist, a
  manager and an active and an inactive department. Argon2 runs with cheap parameters (`FAST_ARGON2`).
  The production parameters are asserted in unit tests.
- The factory makes **English** companies by default (`Factory.company(default_language="en")`), so the
  many assertions on English subjects keep their meaning; pass `default_language="ar"` or
  `Factory.user(preferred_language=...)` to test the Arabic e-mails (B10-11). The column's real default
  (Arabic) is covered by the migration, seed and language tests.
- `audit_rows(...)` returns only rows the current test wrote: it reads above a `seq` watermark taken
  when the test started.
- Per test, the `app` fixture resets the rate limiter, the security-event coalescer, the memory e-mail
  provider and the recorded retry sleeps. `rate_limits(app, scan_per_user=2)` temporarily lowers a
  policy.

### 6.3 The fake clock

An autouse fixture installs `FakeClock(TEST_START)` through `app.core.time.using_clock`.
`TEST_START` is 2026-10-05 06:00 UTC, which is 09:00 in `Asia/Amman`. The clock is **strictly
increasing**: every reading advances it by at least 1 µs, so two timestamps are never equal and
"strictly later" checks stay meaningful. Tests move it with `clock.advance(minutes=…)` or
`clock.set(instant)`. Both refuse to go backwards, and `clock.peek()` reads without advancing. This is
why business code must call `app.core.time.now()` (rule 3): code that calls `datetime.now()` or SQL
`now()` escapes the fake clock and becomes untestable. NO_SHOW marking, pass windows, company-local
days and rate-limit windows are all tested by moving this clock.

### 6.4 Two-connection (committed) tests

Locking, races and deliveries after commit cannot be tested inside one rolled-back transaction. Tests
marked `@pytest.mark.committed` (or with `pytestmark = pytest.mark.committed`) use real commits on
separate connections:

- They get their **own** database (`committed_database`, `committed_settings`, `committed_engine`,
  `committed_session_factory`), because their committed rows, append-only audit rows included, must
  never reach the rolled-back tests.
- Collection fails with a `UsageError` if a committed test requests a shared-database fixture (`db`,
  `connection`, `app`, `settings`, …), or if an unmarked test requests a committed fixture.
- A typical race test commits a scenario and starts two threads, each with its own session from
  `committed_session_factory`. It lets them collide on the row lock and asserts that exactly one wins.
  Examples: `test_reception_concurrency.py` (double check-in, check-in against cancellation, walk-in
  against check-in), `test_visit_concurrency.py` (double resend, cancel against reschedule),
  `test_credential_races.py`, `test_throttle_concurrency.py`.
- `pytest --committed-first` runs these tests before all others. The gate runs both orders, so a test
  that only passes because of file order fails there.

### 6.5 Other fixtures and conventions

- E-mail: `email_provider` is a `MemoryProvider`; read sent messages from it. `sleeps` records the
  dispatcher's retry back-off instead of sleeping.
- SMTP: `tests/smtp_support.py` starts real SMTP servers on 127.0.0.1 (aiosmtpd, with STARTTLS,
  implicit TLS or plain text, AUTH, and replies a test can script per command or slow down) and raw TCP
  listeners for silent servers and refused greetings. `make_certificate` generates a throwaway
  self-signed certificate per test session (no key is ever committed: the release-tree check refuses
  one); its `client_context()` is the production context trusting only that certificate.
  `ScriptedServer` runs a test's own function per connection (a reply spread out over time, a hang-up
  after a reply). `tests/qr_png.py` decodes a received QR PNG back to its module grid.
- E-mail rendering: the template tests read the text a reader sees (`_plain`, `_read`: the direction
  spans dropped and the isolate characters removed), so a wording assertion does not depend on the
  bidirectional markup.
- Brand images: `tests/png_support.py` builds PNG files chunk by chunk with the standard library
  (`make_png` for valid ones of any size, depth and colour type; `chunk`, `header`, `scanlines`,
  `image_data` and `assemble` for the invalid ones: wrong checksums, misplaced chunks, bombs, polyglots).
  `Factory.brand(company, color=, images=)` gives a company a brand as the platform owner's uploads store
  it; `no_brand()` is the `CompanyBrand` of a company without one; `CompanyLogos` hands the e-mail service a
  logo without a database. `Api.put` and `Api.delete` exist for the brand endpoints.
- Memory: `tests/memory_support.py` (`measured_memory()`) traces allocations for a block with the cyclic
  garbage collector off: `peak()` is the most that was alive at once, `grown()` what is still alive. What
  only a collection frees is what these tests look for: an exception in a reference cycle keeps the frames
  it passed through, and their locals, until then (B12-19). A code path that raises a refusal inside the
  handler of another error shows up there as megabytes.
- A request body that arrives slowly, never or not to its end: `tests/unit/test_png_upload.py` calls the
  application as raw ASGI, so each test says how the body arrives (`_Body`: in pieces, then the end, a
  stall, a trickle or a disconnect). Every such call has a time limit of its own, so a request that is
  never answered fails its test instead of stopping the suite.
- The `performance` marker is skipped unless `--performance` is given.
- `pytest` runs with `filterwarnings = error`, `--strict-markers` and `xfail_strict`: a new warning
  fails the suite.

---

## 7. End-to-end suite (Playwright)

The design and every spec's assertions are recorded in [phase-9-e2e.md](decisions/phase-9-e2e.md).
This section is the how-to.

### 7.1 Prerequisites

1. PostgreSQL running (`./scripts/db.ps1 start`). `db.ps1 init` created `vms_e2e`.
2. The backend virtual environment with `requirements-dev.txt`. The suite runs Alembic, the CLI and the
   API with it, and `segno` for the camera video.
3. In `frontend/`: `npm ci` and `npx playwright install chromium`. This installs the headless shell
   most specs use and the full Chromium the camera spec needs.
4. Ports **8700** (API) and **5199** (Vite) free. They are fixed in `playwright.config.ts` and
   `e2e/support/paths.ts`, and they differ from the manual development ports (8000, 5173).

### 7.2 Commands (in `frontend/`)

| Command | What it runs |
|---|---|
| `npm run e2e` | everything: 4 projects, 293 tests (273 run, 20 skip by their project conditions), 8.5 minutes with 4 workers in the Phase 11 frontend gate of 2026-10-13 (253 tests and 7.7 minutes at revision `0012`) |
| `npm run e2e:flows` | the `flows` project: the §40 acceptance scenario, the negative scenarios, the platform owner's scenario and a company's e-mail texts (21 tests) |
| `npm run e2e:quality` | `desktop`, `tablet`, `mobile`: axe and overflow checks (overflow also at 320 px), dialogs, focus visibility, touch targets, scan timing, the Arabic reflow at 360 and 320 px (phone), the camera spec (tablet), the top-level specs (`e2e/*.spec.ts`: mocked layouts, the camera's focus ring, the Arabic smoke spec, the right-to-left evacuation print) |
| `npx playwright test e2e/flows/acceptance.spec.ts` | one spec (or `-g "<title>"`) |
| `npx playwright test --project=tablet e2e/camera` | the real-camera spec |
| `npm run e2e:typecheck` | `tsc` over the suite (Playwright only strips types) |
| `npm run e2e:report` | opens the HTML report of the last run |

Options: `--headed`, `--debug`, `--ui`; `E2E_WORKERS=<n>` (default 4). There are no retries (`retries:
0`): a flaky test is a failure to fix.

Environment overrides, all optional: `VMS_PG_HOST` (default `localhost`), `VMS_PG_PORT`,
`VMS_PG_OWNER_PASSWORD` and `VMS_PG_APP_PASSWORD` (the last three as for `scripts/db.ps1`),
`VMS_E2E_DATABASE` (default `vms_e2e`),
`VMS_E2E_PYTHON` (default `backend/.venv`'s interpreter), `VMS_E2E_PG_BIN` (default `.local/pgsql/bin`)
and `SEED_DEMO_PASSWORD`. For this guide, `npm run e2e:flows` (16 passed, 85 s) and the camera spec
(1 passed, 34 s) ran against a separate throwaway cluster with `$env:VMS_PG_PORT = '5487'`.

### 7.3 What a run does

Playwright starts Vite (`npx vite --port 5199 --strictPort --host 127.0.0.1`, with
`VMS_API_PROXY_TARGET=http://127.0.0.1:8700`). Then the global setup (`e2e/support/global-setup.ts`,
18.6 s in the Phase 9 final release gate):

1. stops an API server left by an interrupted run (PID file `e2e/.artifacts/backend.pid`), and fails
   clearly if port 8700 is still taken;
2. as `vms_owner`, drops and recreates the `public` schema of `vms_e2e`, then runs
   `alembic upgrade head` and `python -m app.cli seed-e2e`;
3. starts `python -m app.serve --port 8700` with an explicit environment (`e2e/support/env.ts`):
   `APP_ENV=development`, a random `SECRET_KEY` per run, `EMAIL_PROVIDER=outbox` in a fresh per-run
   folder, `EMAIL_FAIL_DOMAIN=fail.test`, and every rate limit at its `.env.example` default. Your
   `.env` does not influence it;
4. signs in eight seeded accounts once and saves their storage states;
5. pins the UI to English (`pinEnglish`): it sets both companies' `default_language` to `en` through
   their administrators, fails the setup unless the API answers `en`, and writes the device language
   `en` into every storage state. `seed-e2e` keeps Arabic as the demo company's default, as the
   product does; only the test run is pinned;
6. creates the visits the quality specs read;
7. opens the lazily loaded routes once, so Vite has transformed them before the first test.

The teardown stops the API's whole process tree (`taskkill /T /F` on Windows) and waits until port 8700
is free.

**Artefacts** (git-ignored, replaced by the next run):

| Path | Contents |
|---|---|
| `frontend/e2e/.artifacts/run/` | `backend.log`, `outbox/` (each e-mail as `.json`, `.html`, `.txt`, `.png`), `state/` (storage states), `camera/` (Y4M videos), `quality-data.json` |
| `frontend/e2e/.artifacts/results.json` | JSON report with every test's annotations, including the scan → check-in → ready timings |
| `frontend/playwright-report/` | HTML report |
| `frontend/test-results/` | traces and screenshots of failures |

### 7.4 Projects

| Project | Viewport | Runs |
|---|---|---|
| `desktop` | 1440 × 900 | top-level specs, `quality/**` |
| `tablet` | 820 × 1180, touch | top-level specs, `quality/**`, `camera/**` |
| `mobile` | 390 × 844, touch | top-level specs, `quality/**` except the dialog spec |
| `flows` | 1440 × 900; each scenario opens one context per person with that person's device (reception on the tablet). The browser runs in `America/Los_Angeles`, the company in `Asia/Amman`. | `flows/**` |

### 7.5 Writing specs

- Use the fixtures from `e2e/support/fixtures.ts`: `open()` (a browser context for one account and
  device) and `apiAs(account)` (a JSON API helper that sends the session's CSRF header).
- **Never sign out, change the password of, or deactivate a seeded account.** The storage states are
  shared by every test of a run. Create a user in the test if it needs one.
- **Own your data.** Tests share one database. Tag names and e-mail addresses with a random value, never
  assert company-wide counts, and do company-wide or destructive changes in Other Corp, as the dialog
  spec does.
- Compute times in the company's time zone with `e2e/support/time.ts`; the browser deliberately runs in
  another zone.
- Expire a pass with `cli e2e-time-travel` (`e2e/support/cli.ts`), and handle both sides of the
  same-company-day rule explicitly (E9-7).
- Read e-mails from the outbox (`e2e/support/outbox.ts`), and decode QR codes with the app's own zxing
  WebAssembly (`e2e/support/qr.ts`). Every e-mail carries the logo as an inline image too:
  `inlineImages(message)` returns the content images only (an invitation's QR code), and
  `brandLogoImage(message)` the logo. Check storage with read-only SQL as `vms_app` (`e2e/support/db.ts`).
- **Language.** Specs read the English UI and English e-mail text. A spec about Arabic switches a user
  it created (`e2e/i18n-smoke.spec.ts`, `e2e/quality/arabic-reflow.spec.ts`) or mocks the API
  (`e2e/evacuation-print-rtl.spec.ts`); it never switches a seeded account.
- Record timings as `timing` annotations. Failing slow is a failure.
- Measuring focus beside a sticky action bar (company settings, walk-in): `StickyActionBar` scrolls a
  field that Tab (or the app) focused fully above the bar one animation frame after the focus moves
  (phase-9-frontend F9-8). Wait one frame before reading positions
  (`page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))`); right after the key
  press you still see the browser's own scroll position, which the page never paints.

---

## 8. Contract snapshot workflow

The backend owns the API contract, and the frontend mirrors it in `src/types/api.ts`. Two tests keep
them in step:

| Test | Fails when |
|---|---|
| `backend/tests/unit/test_contract_snapshot.py` | `frontend/src/types/backend-contract.json` differs from what the backend's Pydantic models generate (compared as data) |
| `frontend/src/types/api.contract.test.ts` | a name, field, type or nullability in `api.ts` differs from the snapshot. Request bodies and query models are compared in request mode, responses and envelopes in response mode, and every error code is listed. |

After changing a schema, a query model or an error code:

```powershell
cd frontend
npm run contract:snapshot                        # runs the backend's: python -m app.contract --out src/types/backend-contract.json
npx vitest run src/types/api.contract.test.ts    # update src/types/api.ts until this passes
```

From `backend/` the equivalent is
`.\.venv\Scripts\python.exe -m app.contract --out ..\frontend\src\types\backend-contract.json`. Commit
the regenerated JSON together with the backend change and the `api.ts` change. The snapshot holds
`responses`, `requests`, `queries` (`*Params` in TypeScript), `envelopes` (the error envelope and each
`Paginated<T>`), `error_codes`, `field_error_codes` (each 422 field error code with its parameters, B10-18) and one shared `$defs` table. Its names come from the maps in
`app/contract.py`, so a new model must be registered there (§4.2 step 6). On 2026-10-06 the generator
reproduced the committed file byte for byte, and the frontend contract test passed (61 tests). Since
Phase 10 the frontend test also compares `FieldErrorCode` in `api.ts` with the snapshot's
`field_error_codes`, and `src/i18n/fieldMessages.test.ts` requires a text in both languages for exactly
those codes: a new field code is a backend change, a snapshot, an `api.ts` change and two catalog texts.
Phase 11 (2026-10-12) regenerated the snapshot for the platform owner's and the e-mail texts' models, 2
error codes and 4 field codes (65 in all); `api.ts` and the catalogs followed it on 2026-10-13
([phase-11-frontend.md](decisions/phase-11-frontend.md) F11-1, F11-2), and both frontend tests pass.
The review of 2026-10-13 regenerated it once more: two response fields of the e-mail texts
(`max_variable_uses`, `forbidden_variables`) and 2 field codes (67 in all;
[phase-11-backend.md](decisions/phase-11-backend.md) B11-40). At the backend gate of that day `api.ts` and
the catalogs had not followed yet; B11-50 lists what they need.
Phase 12 (2026-10-13) regenerated it for a company's identity: 3 response models (`BrandPalette`,
`CompanyBrand`, `PublicCompanyBrand`), 2 request models (`CompanyBrandUpdate`, `BrandPaletteRequest`), 1
query model (`BrandImageParams`), `slug` and `brand` in `Me.company`, `brand` in `PlatformCompany`, 1 error
code (`UNSUPPORTED_MEDIA_TYPE`, 39 in all) and 5 field codes (72 in all;
[phase-12-backend.md](decisions/phase-12-backend.md)). The frontend was built in parallel from the same
shared contract.
The UX review of 2026-10-14 regenerated it for three fields more in `BrandPalette` (`surface`,
`on_surface`, `surface_hover`; B12-21): no model, error code or field code was added (39 and 72 as
before). The frontend's fixture of the server's own palettes (`src/test/serverPalettes.json`) is written
from `app.core.palette` and names the derivation, now `oklch-2`: regenerate it with the backend's
interpreter whenever `ALGORITHM` changes.

The pass-token grammar has its own shared contract:
[docs/contract/pass-token-vectors.json](contract/pass-token-vectors.json). The backend
(`tests/unit/test_tokens.py`) and the frontend scanner tests both run every vector. A change to the
grammar is a change to that file. Phase 12 added no grammar change but 14 vectors (63 in all): a pass link
now names its company in the query (`/pass?c=<slug>#<token>`), and the grammar already ignored the query;
the vectors hold that both forms parse and that a token in the query, or a company's sign-in page, is
not a pass.

---

## 9. Troubleshooting

### PostgreSQL

- **A command hangs after starting PostgreSQL.** Never start the cluster with
  `pg_ctl start` while capturing its output, for example in a script, a CI step or a tool that reads
  stdout. The long-lived postmaster inherits the output pipe, so the caller waits for it to close,
  that is, forever. `scripts/db.ps1 start` avoids this by launching `pg_ctl` with `Start-Process`
  (no pipe) and waiting only for `pg_ctl` itself. Use it, or start `pg_ctl` with its output
  redirected to a file (`-l <logfile>`) and no pipe attached. This rule comes from the contract (§2)
  and the comment in `db.ps1`; the hang was not reproduced for this guide.
- **"PostgreSQL binaries not found in …\.local\pgsql\bin"**: the zip was not extracted into `.local\`
  (README §4.1). After extraction, `.local\pgsql\bin\pg_ctl.exe` must exist. The SHA-256 of the EDB
  zip downloaded on 2026-10-06 was
  `fbe23da234ee31547bf8a36d29dfd81e82b849df2d2b78d2eecb43d360252f8c`. EDB may republish the file.
- **Connection refused on port 5433**: the cluster is not running. Run `./scripts/db.ps1 status` and
  `./scripts/db.ps1 start`. The server log is `.local\postgres.log`. The E2E setup reports the same
  problem as "Could not reset the vms_e2e database".
- **Another port.** `$env:VMS_PG_PORT = '5434'` before `db.ps1 init` or `db.ps1 start`; then change
  both URLs in `.env` and use the same variable for the E2E suite.
- **"running scripts is disabled on this system"**: run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or
  `powershell -ExecutionPolicy Bypass -File .\scripts\db.ps1 <command>`.
- **Production mode against the local cluster is refused** ("uses a published local-development
  password"). This is intended. To try `APP_ENV=production` locally, give the roles of a throwaway
  cluster passwords of their own, or stay in development mode.

### Ports

The dev servers bind strict ports and stop instead of moving to another port:

| Message | Meaning |
|---|---|
| `Error: Port 5173 is already in use` (Vite) | another Vite, or another app, holds the port. Stop it, or run `npx vite --port <free port> --strictPort` and add that origin to `ALLOWED_ORIGINS` |
| `[Errno 10048] error while attempting to bind on address ('127.0.0.1', 8000)` (API, exit code 3) | another API holds the port. Stop it, or use `python -m app.serve --port <free port>` together with `VMS_API_PROXY_TARGET` for Vite |
| `Port 8700 is in use` (E2E setup) | an API not started by the suite holds the E2E port. The setup only stops a server it started itself (PID file) |

To find the process: `Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object OwningProcess`
(Windows) or `lsof -iTCP:8000 -sTCP:LISTEN` (Linux/macOS). The manual development ports (8000, 5173)
and the E2E ports (8700, 5199) can be used at the same time. Two E2E runs cannot.

### Tablets on the LAN (camera, HTTPS, `ALLOWED_ORIGINS`)

Browsers allow camera access only in a secure context. `http://localhost` qualifies; a LAN address
such as `http://192.168.1.20:5173` does not. To test the scanner on a real tablet:

1. Start the SPA over HTTPS on all interfaces: `npm run dev:https` (`frontend/`). It uses a self-signed
   certificate and port 5173, and prints the `Network:` URLs.
2. Add the tablet-facing origin to `ALLOWED_ORIGINS` and restart the API. Without it, every sign-in and
   every other unsafe request from the tablet answers 403 `CSRF_FAILED` ("Your session could not be
   verified …"), because the browser's `Origin` header is not on the list.

   ```dotenv
   ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://192.168.1.20:5173
   ```

3. If visitors' phones should open pass links on the LAN, set `APP_BASE_URL` and `QR_BASE_URL` to the
   same `https://192.168.1.20:5173`. Invitations created before the change keep their old links.
4. On the tablet, open `https://192.168.1.20:5173` and accept the certificate warning.
5. Allow inbound TCP 5173 in the development machine's firewall if the tablet cannot connect.

Verified for this guide on the development machine itself, through its LAN address: the page loaded
over HTTPS, and a sign-in from the allowed LAN origin answered 200 while an unlisted origin got 403
`CSRF_FAILED`. Not verified: a physical tablet, its certificate prompt, its camera, and the firewall
step. The paste and handheld-scanner field works without a camera, in any context.

### API behaviour during development

- **429 `RATE_LIMITED` while testing by hand.** The limits are counted in the API's memory, and
  restarting the API clears them. Do not switch limiting off in shared environments; production refuses
  that anyway.
- **Every direct call to port 8000 shares one rate-limit budget and has no client IP.** That is the
  development `TRUSTED_PROXIES` value at work (README §7.1). Go through the Vite proxy, or empty
  `TRUSTED_PROXIES` while you work against port 8000.
- **The API refuses to start and names a setting.** The configuration is invalid, or unsafe for
  production. The message names the setting and never its value.
- **E-mails "disappear".** With `EMAIL_PROVIDER=outbox` nothing is sent (§3.1): the outbox is
  `EMAIL_OUTBOX_DIR`, relative to `backend/` (default `backend\var\outbox`). In Git Bash, quote Windows paths: `EMAIL_OUTBOX_DIR='C:\Temp\outbox'`. Unquoted,
  the shell strips the backslashes, and the API refuses the resulting relative path (it must stay
  inside `backend/var`).
- **An invitation shows "failed".** Its error names what the mail server answered, without the
  server's own text. `SMTP 535 5.7.8` or `534 5.7.9` from Gmail: the App Password is missing or wrong.
  `could not be verified`: `SMTP_HOST` is not a name on the server's certificate. `does not offer
  STARTTLS` or a `TLS handshake` failure: `SMTP_SECURITY` and `SMTP_PORT` do not match (587 is
  `starttls`, 465 is `ssl`). The API log has one `SMTP configuration problem` line saying what to check.
  Fix the setting, restart the API, check with `send-test-email`, then resend the invitation.
- **`send-test-email` times out on port 587.** Some networks block outbound 587. Use `SMTP_PORT=465`
  with `SMTP_SECURITY=ssl`, as the demo does.
- **The pass link in a real e-mail does not open on a phone.** `QR_BASE_URL` is `localhost`; the API and
  `send-test-email` warn about it. Set it to an address the phone can reach ("Tablets on the LAN"
  below), restart the API and resend the invitation: invitations sent earlier keep their old link.
- **Wrong Python.** A `python` on the PATH may belong to another project. Always call
  `backend\.venv\Scripts\python.exe`, or `.venv/bin/python` on Linux and macOS.

### Frontend and E2E

- **"A new version is available — Reload page"** after a deployment: a page chunk of the build the tab
  was running is no longer on the server. Reload the page.
- **Vite logs `wasm streaming compile failed … falling back to ArrayBuffer instantiation`** during E2E
  runs. A test closed the reception page while the zxing decoder was still downloading. It is not a
  failure.
- **The first test of a run is reloaded by "Re-optimizing dependencies"**: a lazy route is missing from
  the global setup's warm-up list (§4.3 step 6).
- **The app opens in Arabic.** That is the demo company's default. Press **EN** (in the sidebar, or the
  top bar on a tablet or phone): the choice is saved to your account. To make English the default for
  everyone without a choice of their own, change *Default language* in the company settings.
- **The E2E setup fails with "Pinning … to English failed".** The API did not store
  `default_language`: it runs older code, or the database is older than revision `0011`. The specs are
  written against the English UI and are not started in Arabic.
- **`hardcodedText.test.ts` or `logicalProperties.test.ts` fails.** A component renders literal text,
  or uses a physical side (`ml-`, `text-right`, …). Move the text to both catalogs (§2.4) or use the
  logical class; the test names the file and line.
- **A Vite page reloads during an E2E run.** A file under `frontend/` was edited while the suite ran
  (Tailwind rescans every source file). Do not edit the frontend during a run.

---

## 10. Release hygiene

Before the first commit and before every release tag (the full checklist is in
[phase-9-deploy.md](decisions/phase-9-deploy.md#release-checklist-repository-hygiene)):

1. `python3 deploy/verify/check_release_tree.py` (on Windows: `backend\.venv\Scripts\python.exe
   deploy/verify/check_release_tree.py`) exits 0. It checks exactly what `git add -A` would commit
   for these, and prints the path, line and rule, never the value:
   - development outbox files;
   - raw pass and reset links;
   - cookie values;
   - private keys;
   - `.env` files other than `*.example`;
   - database archives.
2. `git status --porcelain --ignored`: every ignored entry belongs to a known family (`.env`, `.local/`,
   caches, `backend/var/`, `frontend/dist/`, test reports, `frontend/e2e/.artifacts/`, `node_modules/`,
   `deploy/env/*.env`, `deploy/tls/`).
3. After changing a pin in `backend/requirements*.txt`, run `python scripts/lock_hashes.py` from the
   repository root to refresh the sha256 hashes. Install with `--require-hashes`.
4. The deploy unit tests pass, including `deploy/verify/test_brand_names.py`: no retired product name
   where a person or an operator reads the product's name (§5).
