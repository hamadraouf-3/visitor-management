# Initial Assessment & Implementation Plan (Phase 0)

Status: **Phase 0 deliverable, revision 2 (after the Gate 0 design review), amended as revision 3 in Phase 10 (2026-10-08), as revision 4 in Phase 11 (2026-10-12) and as revision 5 in Phase 12 (2026-10-13). This is the binding design contract for Phases 1–12.**
Every implementation agent follows it. A deviation is recorded in a decision file under `docs/decisions/` (see §14) with the reason — never silently.

**Product.** «زوار موضوع» in Arabic, "Mawdoo3 Visitors" in English: a visitor-pass system. The brand is Mawdoo3 («موضوع») with its logo; the demo tenant is the company Mawdoo3 («موضوع»). The interface and the e-mails are in Arabic (the default, right to left) and English. *(rev. 5)* The product's name and logo are shown in the platform owner's area only (and, *rev. 5, UX review*, on no e-mail but the test message of the command line): a company's staff and visitors see that company's own identity (below).

**Revision 3** applies the contract text that the Phase 10 decision records proposed: the product name, the two languages (§4, §7.2, §8, §8.1, §10), the SMTP provider and bilingual e-mail (§9), the per-field error codes (§8.2) and direction C's visual design (§10). On 2026-10-08 it also took in the user's two requests of that day: an invitation is made in the inviter's own name, and only an administrator invites on behalf of another host (§7.5, §8, §8.1, §10, D-02; B10-24, F10-dept-1); departments and the company's address have an Arabic version that the Arabic interface and the Arabic part of every e-mail show (revision `0012`: §4, §8, §8.1, §9, §10; B10-25 … B10-27, F10-dept-2 … 7). Passages it changed are marked *(rev. 3)*. It does not fold in the Phase 8 and 9 deviations: those remain in the decision files and in `docs/architecture.md` §14.

**Revision 4** (Phase 11, 2026-10-12; `docs/decisions/phase-11-backend.md`, B11-1 … B11-33) takes in the user's two requests of that day: a **platform owner**, a principal above every company with its own accounts, sessions, cookies, CSRF token and audit trail, who creates, renames, deactivates and reactivates companies and adds or helps their administrators, and sees per-company counts but none of a company's visitors, visits or audit details (§4, §7.4, §7.6, §8, §8.1, §8.2, §10, D-27, D-28); and **a company's own e-mail texts**, the words of the four visit e-mails edited by its administrators within fixed layouts, with an allow-list of variables, previews and a test e-mail to oneself (revision `0013`: §4, §7.5, §8, §8.1, §9, §10, D-29). Passages it changed are marked *(rev. 4)*.

**Revision 4, review** (2026-10-13; `docs/decisions/phase-11-backend.md`, B11-34 … B11-50) takes in what the security and UX reviews of Phase 11 changed (revision `0014`): the platform session honours background refreshes, a locked platform account has a recovery, a seed account never serves production, platform writes re-check their caller, a company's other administrators are told of platform actions on administrator accounts, a deactivated company's user is told so when the credentials are valid, and what a company's e-mail texts can render to is bounded (§4, §7.1, §7.6, §8.1, §8.2, §9). Passages it changed are marked *(rev. 4, review)*.

**Revision 5** (Phase 12, 2026-10-13; `docs/decisions/phase-12-backend.md`, B12-1 … B12-17) takes in the user's request of that day, **a company's own identity** ("white label"): every company has a logo for light surfaces, a logo for dark surfaces, a square icon and one colour, set by the **platform owner only**; its staff and visitors see them in the application, on the visitor's pass page and in every e-mail of the company, and never the product's name or the Mawdoo3 logo; each company has its own sign-in link; the platform owner also edits each company's e-mail texts (revision `0015`: §4, §6, §7.3, §7.4, §7.5, §7.6, §8, §8.1, §8.2, §9, §10, D-20, D-30 … D-32). Passages it changed are marked *(rev. 5)*.

**Revision 5, UX review** (2026-10-14; `docs/decisions/phase-12-backend.md`, B12-21 … B12-25) takes in what the UX review of Phase 12 changed, with no migration and no endpoint: **a company's own colour on its surfaces** (three roles more in `BrandPalette`: `surface`, `on_surface`, `surface_hover`; the bar and the button of a company's e-mails and the manifest's theme colour are the surface) (§8, §8.1, §9); **nothing of the product reaches a company's people** (the notice of a platform action is the company's own e-mail) (§9, D-30); e-mails that fit a phone, the Arabic wording of a window that crosses midnight, the Arabic prefix of a test e-mail, subjects that shorten the company's name before they lose their date, and a short `short_name` in a company's manifest (§8, §9). Passages it changed are marked *(rev. 5, UX review)*.

---

## 1. Discovery findings

| Item | Finding |
|---|---|
| Repository | None existed. New project at `C:\Users\User\visitor-management` (git initialized, branch `main`). Sibling projects (`sales-crm`, `hr-service-workflow`) are unrelated and must not be touched. |
| Existing code / auth / DB | None. Nothing to preserve or migrate. |
| OS | Windows 11 Pro, timezone `Asia/Amman` (UTC+3). |
| Python | 3.11.9, 3.14.6, 3.15.0rc1 available via `py`. **Backend uses 3.14** (`backend/.venv`). Core deps verified installable (FastAPI 0.142, SQLAlchemy 2.1, psycopg 3.3, Alembic 1.20, Pydantic 2.13, argon2-cffi 25.1, segno 1.6). The `python` on PATH belongs to an unrelated venv — always invoke `backend\.venv\Scripts\python.exe`. |
| Node | Node 24.19, npm 11.17 → **npm**. |
| PostgreSQL | Not installed. **User-approved decision: portable PostgreSQL 18.6** in `.local/pgsql` (gitignored), data `.local/pgdata`, port **5433**, managed by `scripts/db.ps1` (`init/start/stop/status/psql`). Cluster: UTF8, **builtin `C.UTF-8` collation provider + `LC_CTYPE=en-US`** (verified: `lower('ÉLODIE')='élodie'`, accented ILIKE works, Arabic text produces trigrams), server `timezone='UTC'`. Roles: **`vms_owner`** (owns schema, runs migrations, CREATEDB for test databases) and **`vms_app`** (runtime). Databases: `vms` (dev), `vms_e2e` (Playwright). Tests create and drop throwaway databases. No Windows service, no admin rights. |
| Docker | **Not installed** (no WSL). `Dockerfile`s and `docker-compose.yml` are written for deployment but **cannot be verified on this machine** — stated honestly in docs and the final report. |
| Git identity | No global identity. No commits unless the user asks. |
| Email | No Resend API key yet. Dev/test default provider is a local **outbox** (files). Resend is enabled purely by env vars. |
| Library facts verified in review | `typescript@7` breaks `typescript-eslint` (peer `<6.1`) → pin **TypeScript ~6.0** and use the create-vite default linter (oxlint). **react-router 8**: no `react-router-dom`; use `react-router` + `react-router/dom`. **Tailwind v4**: CSS-first `@theme`, no `tailwind.config.js`; needs Safari ≥16.4 / Chrome ≥111 / Firefox ≥128. **barcode-detector v3** loads zxing wasm from jsDelivr by default → must self-host. **FastAPI 0.142**: BackgroundTasks run *before* yield-dependency cleanup (see §3.2). Starlette TestClient's default client host `"testclient"` is not an IP. |

## 2. Constraints & things that must not break

- No pre-existing functionality. Constraints are environmental: no Docker, Windows paths, portable Postgres on 5433.
- Never run `pg_ctl start` with captured stdout (postmaster inherits the pipe → callers hang). Use `scripts/db.ps1`.
- Camera access needs a **secure context**: `localhost` works; LAN tablets need HTTPS (`npm run dev:https`) **and** their origin added to `ALLOWED_ORIGINS` (e.g. `https://192.168.1.20:5173`), because the Origin check (§7) rejects unknown origins.
- Ports: backend 8000 and frontend 5173 for manual dev. Automated agents/tests must pick their own ports and use `strictPort` so parallel runs never collide.

## 3. Architecture (modular monolith)

```
Browser (React SPA, PWA-capable)
   │  same-origin /api/v1/*  (Vite proxy in dev; nginx reverse proxy in prod — no CORS anywhere)
   ▼
FastAPI (Python 3.14) ── routes → services → repositories → SQLAlchemy 2 (sync, psycopg 3) → PostgreSQL 18
   ├─ security: Argon2id, server-side sessions, global CSRF + Origin middleware, RBAC, tenant scoping, rate limits
   ├─ passes:   opaque random tokens (SHA-256 at rest), segno QR PNG
   ├─ email:    EmailService → EmailProvider (Resend | SMTP | Outbox | Memory) + email_messages table
   └─ audit:    append-only audit_logs (statement trigger blocks UPDATE/DELETE/TRUNCATE; app role has INSERT/SELECT only)
```

| Concern | Choice | Rationale |
|---|---|---|
| ORM / DB access | SQLAlchemy 2.x **sync**, psycopg 3; every connection sets `timezone=UTC` | Simple, adequate for MVP, easy to test. |
| Migrations | Alembic run as `vms_owner` via `MIGRATION_DATABASE_URL`; **one initial revision with the full schema**, grants for `vms_app`; later changes = new revisions | One schema author avoids divergent heads; least privilege at runtime. |
| IDs | UUIDv4 PKs; `audit_logs` also has `seq bigint identity` for ordering | No enumerable IDs; deterministic audit order. |
| Sessions | Server-side (`user_sessions`), opaque cookie | Immediate revocation. |
| Frontend | React 19 + TypeScript ~6.0 + Vite, react-router 8 (data mode: `createBrowserRouter` + `RouterProvider` from `react-router/dom`), TanStack Query for server state, `useState` for UI state, Tailwind v4 (`@theme` in `src/index.css`) + in-house UI kit | Server/UI state separation; no global store. |
| Date/time in UI | `@date-fns/tz` + `date-fns` | Convert company-local wall time ⇄ UTC correctly regardless of browser timezone. |
| QR scanning | `getUserMedia` + native `BarcodeDetector` when `'BarcodeDetector' in window` and it supports `qr_code`, otherwise the `barcode-detector` ponyfill with **self-hosted** zxing wasm (`prepareZXingModule({overrides:{locateFile}})`, wasm imported via Vite `?url`, precached by the service worker) | Works on Windows Chrome / iPad Safari / offline LANs; no third-party runtime fetch. |
| QR rendering | Backend `segno` (PNG for email). Frontend `qrcode` (visitor pass page, host "Show QR") | Mature, light. |
| Email templating | Jinja2, autoescape on | No HTML injection from visitor-supplied text. |
| Resend | Direct `httpx` call in `ResendProvider` (no SDK) | Small adapter; SES adapter slots in the same way. |
| Rate limiting | `RateLimiter` interface, in-memory sliding window, stored on `app.state` (injectable/resettable) | Single-instance MVP; **run one worker per instance** until a Redis limiter exists (documented). |
| Logging | JSON structured logs; our own access log (uvicorn.access disabled) | No query strings / PII / tokens in logs. |

### 3.1 Repository layout

```
visitor-management/
├── backend/
│   ├── app/
│   │   ├── main.py                 # app factory, middleware, routers, exception handlers
│   │   ├── core/                   # config.py, logging.py, errors.py, middleware.py, rate_limit.py, time.py, client_ip.py
│   │   ├── security/               # passwords.py, tokens.py, sessions.py, csrf.py, permissions.py
│   │   ├── db/                     # base.py (DeclarativeBase, mixins, naming convention), session.py (engine, session_factory, get_db)
│   │   ├── models/                 # one module per aggregate; __init__ imports all
│   │   ├── schemas/                # Pydantic request/response models per resource (mirror §8.1)
│   │   ├── repositories/           # data access, ALWAYS company-scoped
│   │   ├── services/               # auth, users, departments, company, visitors, visits, passes, reception, dashboard, reports, audit
│   │   ├── email/                  # service.py, dispatcher.py, providers/{base,resend,smtp,outbox,memory}.py, i18n.py (bilingual catalog), templates/
│   │   ├── api/deps.py + api/routes/*.py
│   │   └── cli.py                  # seed-demo, seed-e2e, create-admin, mark-no-shows, e2e-time-travel (non-prod only)
│   ├── alembic/ + alembic.ini
│   ├── tests/{unit,integration}/ + conftest.py
│   ├── pyproject.toml, requirements*.txt, Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/                    # client.ts + one module per resource
│   │   ├── types/api.ts            # the TypeScript mirror of §8.1 (single source for the UI)
│   │   ├── auth/, components/ui/, layouts/, hooks/, utils/, scanner/, i18n/ (catalogs ar + en, rev. 3)
│   │   ├── features/<feature>/     # each feature exports its own routes.tsx + nav entries (router.tsx only composes them)
│   │   ├── pages/                  # thin route components
│   │   └── main.tsx, router.tsx, index.css
│   ├── public/                     # manifest.webmanifest, icons, sw.js
│   ├── e2e/                        # Playwright specs + global setup
│   └── Dockerfile (build → nginx with security headers)
├── scripts/db.ps1
├── docs/ (architecture, security, api, development, decisions/, security-audit, production-readiness)
├── docker-compose.yml, .env.example, README.md
```

### 3.2 Cross-cutting implementation rules (binding)

1. **Unit of work.** `get_db` yields a session and on exit only rolls back (if needed) and closes — it **never commits**. Services/routes call `db.commit()` explicitly. Background tasks (email delivery) are scheduled **only after** the commit. Declare the dependency so its cleanup runs before background tasks (FastAPI `Depends(get_db, scope="function")` if available in the installed version; verify). A guard asserts the session is not in a transaction when a delivery job is scheduled.
2. **One session factory.** All code (requests, dispatcher, security-event audit writer, CLI) obtains sessions from `app.db.session.session_factory`; tests override only that.
3. **Clock.** All business-time logic uses `app.core.time.now()` (aware UTC) bound as a parameter — never SQL `now()`/`CURRENT_TIMESTAMP`. ORM `created_at`/`updated_at` use the app clock (server default only as fallback). The test fake clock is strictly increasing (advances ≥1 µs per call).
4. **Visit mutations lock.** Every visit state change (check-in, check-out, cancel, reschedule, resend, no-show marking of a single visit, override) loads the visit with `SELECT … FOR UPDATE` scoped by `id` **and** `company_id`, then validates the transition, then writes. Pass revoke/issue happens under that lock. Audit rows and email jobs are created only after the guarded write. Concurrency tests use two real connections.
5. **Tenant scoping.** `company_id` comes only from the session user. Every ID in a request body or filter (`host_id`, `department_id`, `visitor_id`, …) is resolved through a company-scoped repository; not found → `404 NOT_FOUND` for path IDs, `422 VALIDATION_ERROR` (field error) for body IDs. The DB backs this with composite FKs (§4).
6. **Pagination.** Every paginated or "latest N" query ends with a unique tie-breaker (`…, id` or `seq`).
7. **Timestamps in API.** Requests use timezone-aware ISO-8601 (`AwareDatetime`; naive → 422). Responses are UTC `…Z`. Date-only filters are company-local `YYYY-MM-DD`.
8. **No PII/secrets in logs or audit metadata.** Audit metadata holds IDs, enums, counts and changed-field *names* — never names, emails, phones, purposes, tokens, passwords or attempted identifiers.
9. **Frontend contract.** `frontend/src/types/api.ts` mirrors §8.1 exactly; the backend Pydantic schemas mirror §8.1 exactly. Phase 1 creates both for the whole contract (not just Phase 1 endpoints).
10. **Shared files in parallel work.** Only one builder at a time edits the frontend. All frontend dependencies are installed in Phase 1 (later builders do not add dependencies without recording a decision). Features add routes via their own `routes.tsx`.

## 4. Data model (single initial migration)

Conventions: `id UUID PK` (uuid4 from Python); `created_at timestamptz NOT NULL`, mutable tables `updated_at timestamptz NOT NULL` (app clock). All timestamps UTC. Tenant tables have `company_id UUID NOT NULL`. Enums are `VARCHAR` + `CHECK`. Expression/partial uniqueness = `CREATE UNIQUE INDEX` with fixed names (services map `UniqueViolation.diag.constraint_name` to error codes). Text columns that are "lowercase, non-empty or NULL" carry `CHECK (col IS NULL OR (col <> '' AND col = lower(col)))`; services normalise `''` → NULL. Extension `pg_trgm` created in the migration.

**Composite tenant FKs.** `users`, `departments`, `visitors`, `visits` have `UNIQUE (company_id, id)`. Tenant references are composite: e.g. `FOREIGN KEY (company_id, host_id) REFERENCES users (company_id, id)`. Nullable references (`department_id`) use `ON DELETE RESTRICT` (nothing is ever deleted).

### companies
`name varchar(200)`, `slug varchar(80) UNIQUE`, `timezone varchar(64)` (validated against `zoneinfo` **and** `pg_timezone_names`), `address text NULL`, `email_domain varchar(255) NULL`, `pass_grace_before_minutes int default 60 CHECK 0..1440`, `pass_grace_after_minutes int default 60 CHECK 0..1440`, `notify_host_on_check_in bool default true`, `allow_walk_ins bool default true`. Grace changes apply to visits created or rescheduled afterwards (each visit stores its own window).
*(rev. 3, revision 0011)* `name_ar varchar(200) NULL` (CHECK not blank; the Arabic name; `name` is the English or only name), `default_language varchar(2) NOT NULL DEFAULT 'ar'` (CHECK `ar`/`en`; the interface language of users without a preference and the leading language of visitor e-mails).
*(rev. 3, revision 0012)* `address_ar text NULL` (the address in Arabic; `address` is the English or only address; no CHECK, as `address`).
*(rev. 4, revision 0013)* `is_active bool NOT NULL default true` and `deactivated_at timestamptz NULL`, changed together (CHECK `is_active = (deactivated_at IS NULL)`): the platform owner deactivates and reactivates a company (§7.6). A deactivated company's users cannot sign in, its sessions are revoked, its reset links are dead and its passes are refused like unknown ones (B11-10). Companies are never deleted.
*(rev. 5, revision 0015)* `brand_color varchar(7) NULL` (CHECK: NULL or exactly `#` and six lower-case hexadecimal digits, `^#[0-9a-f]{6}$`): the company's colour, set by the platform owner (§7.6); NULL means the product's palette. The shades people see are derived from it by the application (§8.1 `BrandPalette`, B12-4, B12-21), never stored. `slug` is now also the company's public address (`/c/{slug}`, `?c={slug}`, the public identity endpoints of §8); it never changes.

### departments
`company_id`, `name varchar(120)` (the English or only name), *(rev. 3, revision 0012)* `name_ar varchar(120) NULL` (CHECK not blank; the Arabic name), `is_active bool default true`. Unique indexes `uq_departments_company_name` on `(company_id, lower(name))` and *(rev. 3)* `uq_departments_company_name_ar` on `(company_id, lower(name_ar)) WHERE name_ar IS NOT NULL` (a duplicate is `409 CONFLICT` with `details.field` = `name` or `name_ar`). *(rev. 3, B10-29)* Across the two languages too: no value of a department (`name` or `name_ar`) may equal, ignoring case, a value of another department of the company, inactive ones included (a department's own two values may be equal), so two departments never read the same in either interface. A new `name` equal to another department's `name_ar` is `409 CONFLICT` on `name` ("A department with this Arabic name already exists."), a new `name_ar` equal to another department's `name` is `409 CONFLICT` on `name_ar` ("A department with this name already exists."); the same-language check comes first. The service enforces the cross-language part, holding the company row `FOR UPDATE` for every change that names a department; there is no index or constraint for it, because rows written before the rule may already break it (only a value that changes, other than in case, is checked).

### users
| column | type | notes |
|---|---|---|
| company_id | FK companies | |
| full_name | varchar(200) | |
| email | varchar(320) | lowercase CHECK; **`UNIQUE (email)` globally** (D-03) |
| phone | varchar(40) NULL | staff contact shown to reception (D-26) |
| password_hash | varchar(255) | Argon2id |
| roles | **text[]** | `CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['SYSTEM_ADMIN','EMPLOYEE','RECEPTIONIST','MANAGEMENT']::text[])`; services also reject duplicates. Raw SQL array predicates must cast literals to `text[]`. |
| department_id | NULL; composite FK `(company_id, department_id)` → departments | |
| is_active | bool default true | |
| must_change_password | bool default false | |
| password_expires_at | timestamptz NULL | set for admin-issued temporary passwords (72 h, D-11) |
| password_changed_at, last_login_at | timestamptz NULL | |
| preferred_language | varchar(2) NULL | *(rev. 3)* CHECK `ar`/`en`; the user's interface and e-mail language; NULL follows the company (revision 0011) |

### user_sessions
`user_id` (composite FK `(company_id, user_id)` ON DELETE CASCADE), `company_id`, `token_hash char(64) UNIQUE`, `csrf_token_hash char(64)`, `expires_at` (absolute), `last_seen_at`, `revoked_at NULL`, `ip_address inet NULL`, `user_agent varchar(400) NULL`. Index `(user_id)`.

### password_reset_tokens
`user_id FK CASCADE`, `token_hash char(64) UNIQUE`, `expires_at` (30 min), `used_at NULL`, `requested_ip inet NULL`. Consumption is atomic (`UPDATE … SET used_at=:now WHERE token_hash=:h AND used_at IS NULL AND expires_at > :now RETURNING user_id`). All unused tokens of a user are invalidated on password change, reset, deactivation and when a new one is issued.

### visitors
| column | type | notes |
|---|---|---|
| company_id | | |
| full_name | varchar(200) | |
| email | varchar(320) NULL | lowercase CHECK; `UNIQUE (company_id, email)` (NULLs distinct) → 409 VISITOR_EXISTS |
| phone | varchar(40) NULL | as entered, trimmed |
| phone_digits | varchar(40) NULL | digits only (derived by service) for search |
| company_name | varchar(200) NULL | |
| search_text | text | derived by service: casefolded, accent-stripped (NFKD minus combining marks), Arabic folding (أ/إ/آ→ا, ة→ه, ى→ي, tatweel and diacritics removed) of full_name + email + company_name |
| created_by_id | NULL, composite FK to users | |
Indexes: GIN trigram on `search_text` and on `phone_digits`; `(company_id, created_at, id)`.
Search: normalise the query the same way; match `search_text ILIKE '%q%'`; if the query has ≥ 6 digits also match `phone_digits LIKE '%' || <last 9 digits> || '%'` (handles `079…` vs `+96279…`).

### visits
| column | type | notes |
|---|---|---|
| company_id; visitor_id, host_id, created_by_id (composite FKs, RESTRICT); department_id NULL (composite FK) | | |
| purpose | varchar(500) | |
| scheduled_start, scheduled_end | timestamptz | CHECK end > start; service: ≤ 24 h, not in the past (5 min tolerance), ≤ 365 days ahead |
| window_start, window_end | timestamptz | `scheduled_start − grace_before`, `scheduled_end + grace_after` computed at create/reschedule. **The single source of truth for pass validity and NO_SHOW.** CHECK window_start ≤ scheduled_start AND window_end ≥ scheduled_end |
| status | varchar(16) | SCHEDULED, CHECKED_IN, CHECKED_OUT, CANCELLED, NO_SHOW |
| visitor_name, visitor_company_name (NULL), host_name, department_name (NULL), department_name_ar (NULL, *rev. 3, revision 0012*) | snapshots | set at creation; refreshed while SCHEDULED when the source changes (a department renamed in either language); frozen from check-in on (D-17) |
| is_walk_in | bool default false | |
| walk_in_reason | varchar(300) NULL | |
| check_in_at, checked_in_by_id (FK users), check_in_method, check_in_note (varchar 300) | | method ∈ QR, MANUAL, OVERRIDE, WALK_IN |
| check_out_at, checked_out_by_id, check_out_method, check_out_note | | method ∈ QR, MANUAL, CORRECTED, BULK |
| cancelled_at, cancelled_by_id (NULL), cancellation_reason (varchar 300) | | |
| no_show_at | timestamptz NULL | |
CHECKs (two-way):
- `(status IN ('CHECKED_IN','CHECKED_OUT')) = (check_in_at IS NOT NULL)`; `(check_in_at IS NULL) = (checked_in_by_id IS NULL)`; `(check_in_at IS NULL) = (check_in_method IS NULL)`
- `(status = 'CHECKED_OUT') = (check_out_at IS NOT NULL)`; same for `checked_out_by_id`, `check_out_method`; `check_out_at >= check_in_at`
- `(status = 'CANCELLED') = (cancelled_at IS NOT NULL)`
- `status <> 'NO_SHOW' OR no_show_at IS NOT NULL`
- `is_walk_in = (check_in_method IS NOT DISTINCT FROM 'WALK_IN')`; `(walk_in_reason IS NOT NULL) = is_walk_in`
- `check_in_method IS DISTINCT FROM 'OVERRIDE' OR check_in_note IS NOT NULL`; `check_out_method NOT IN ('CORRECTED','BULK') OR check_out_note IS NOT NULL` (NULL-safe form)
Unique index `uq_visits_visitor_inside` on `(company_id, visitor_id) WHERE status = 'CHECKED_IN'` → 409 VISITOR_ALREADY_INSIDE.
Trigger `visits_terminal_immutable`: `BEFORE UPDATE … FOR EACH ROW` raises when `OLD.status IN ('CHECKED_OUT','CANCELLED')`.
Indexes: `(company_id, scheduled_start, id)`, `(company_id, status)`, `(company_id, window_end) WHERE status = 'SCHEDULED'`, `(company_id, check_in_at)`, `(host_id, scheduled_start)`, `(created_by_id, scheduled_start)`, `(visitor_id, scheduled_start DESC, id)`.

### visitor_passes
`company_id`, `visit_id` (composite FK `(company_id, visit_id)` → visits), `token_hash char(64) UNIQUE`, `created_by_id NULL`, `revoked_at NULL`, `revoke_reason NULL` ∈ ROTATED, VISIT_CANCELLED, VISIT_COMPLETED, VISITOR_EMAIL_CHANGED; `CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))`. Unique index `uq_passes_active_visit` on `(visit_id) WHERE revoked_at IS NULL`. Validity comes from the visit's window.

### email_messages
`company_id`, `visit_id NULL` (composite FK), `recipient_user_id NULL`, `kind` ∈ VISITOR_INVITATION, VISIT_RESCHEDULED, VISIT_CANCELLED, HOST_ARRIVAL, PASSWORD_RESET (and PASSWORD_CHANGED since revision 0008, SEC-06; *(rev. 4, review, revision 0014)* PLATFORM_ACTION_NOTICE, B11-43); `to_email`, `subject varchar(300)`, `status` ∈ PENDING, SENT, FAILED; `provider varchar(32)`, `provider_message_id NULL`, `attempts int default 0`, `last_error varchar(500) NULL` (sanitized), `last_attempt_at NULL`, `sent_at NULL`. Indexes `(visit_id, created_at)`, `(status)`, `(company_id, created_by…)` not needed. Rendered bodies are not stored (they may contain a raw pass token).

### email_template_overrides *(rev. 4, revision 0013)*
A company's own text of one field of one e-mail kind in one language (B11-20): `company_id` (FK RESTRICT), `kind` (CHECK: VISITOR_INVITATION, VISIT_RESCHEDULED, VISIT_CANCELLED, HOST_ARRIVAL), `language` (CHECK `ar`/`en`), `field` (CHECK: subject, heading, greeting, intro, button, closing, footer_note), `text text NULL` (CHECK NULL or not blank and ≤ 2000 characters; **NULL means the product's text**, since the runtime role cannot delete), `updated_by_id NULL` (composite FK `(company_id, updated_by_id)` → users), `created_at`, `updated_at`. `UNIQUE (company_id, kind, language, field)`.

### company_brand_assets *(rev. 5, revision 0015)*
A company's brand images (B12-1), one row per (company, kind) that ever had an image: `company_id` (FK RESTRICT), `kind` (CHECK `logo`, `logo_dark`, `icon`), `content bytea NULL` (the PNG **as the server re-serialised it**, B12-2, never the bytes that were uploaded), `byte_size int`, `width int`, `height int`, `sha256 char(64)` (of `content`; the entity tag of the public answer), `version char(16)` (random per upload; part of the image's public address), `created_at`, `updated_at`. `UNIQUE (company_id, kind)`. A removed image is the row with `content` and the five describing columns NULL together (CHECK `content_described`: the runtime role cannot delete). The CHECKs repeat the limits of the service: a PNG signature and at most 524,288 bytes (`content_png`), logos 32–1200 by 32–600 pixels and the icon square and 192–512 (`dimensions_valid`), `sha256_hex`, `version_hex`. The runtime role holds SELECT, INSERT and UPDATE. The downgrade refuses while any company has a colour or an image.

### platform_admins, platform_sessions *(rev. 4, revision 0013)*
The platform owner (§7.6, B11-1), not a tenant user (`users.company_id` stays NOT NULL). `platform_admins`: `email varchar(320)` (lowercase CHECK, `UNIQUE` among platform accounts; independent of `users.email`), `full_name varchar(200)` (not blank), `password_hash` (Argon2id), `is_active`, `must_change_password`, `password_expires_at`, `password_changed_at`, `last_login_at`, `preferred_language` (CHECK `ar`/`en`, NULL), `device_trust_epoch bigint`, *(rev. 4, review, revision 0014)* `temporary_password_tag char(64) NULL` (the SHA-256 tag of the first 12 characters of a generated temporary password, B11-35; CHECK: only while `must_change_password`), `created_at`, `updated_at`. `platform_sessions`: the columns of `user_sessions` with `platform_admin_id` (FK CASCADE) instead of the user and company. Created only by the CLI and the non-production seeds.

### platform_audit_logs (append-only) *(rev. 4, revision 0013)*
The platform's own trail (B11-4): the columns of `audit_logs` with `actor_platform_admin_id` (the platform account, NULL for the CLI and unattributed events) and `company_id` (the company an action was about, NULL for none). Statement trigger `platform_audit_logs_immutable` (UPDATE/DELETE/TRUNCATE refused for every role); the runtime role holds SELECT and INSERT on every column but `seq`, nothing on its sequence; no foreign keys. Indexes `(company_id, seq DESC)`, `(actor_platform_admin_id)`.

### audit_logs (append-only)
`id UUID`, `seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE`, `company_id NULL` (null only when unattributable), `actor_user_id NULL`, `action varchar(64)`, `entity_type varchar(32) NULL`, `entity_id UUID NULL`, `metadata jsonb default '{}'`, `ip_address inet NULL`, `user_agent varchar(400) NULL`, `request_id varchar(64) NULL`, `created_at`.
Indexes `(company_id, seq DESC)`, `(entity_type, entity_id)`, `(actor_user_id)`, `(company_id, action, seq DESC)`.
Trigger `audit_logs_immutable`: `BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs FOR EACH STATEMENT` raises. Grants: `vms_app` gets `SELECT, INSERT` only on `audit_logs` (+ sequence usage); `SELECT, INSERT, UPDATE, DELETE` on other tables; no TRUNCATE, no DDL. `ALTER DEFAULT PRIVILEGES` in the migration so future tables follow. A test connects as `vms_app` and asserts UPDATE/DELETE/TRUNCATE/`ALTER TABLE … DISABLE TRIGGER` on `audit_logs` all fail.

## 5. Visit lifecycle

```
                    ┌──────────► CANCELLED   (owner/admin; host deactivation; only from SCHEDULED; revokes pass)
SCHEDULED ──────────┼──────────► CHECKED_IN ──► CHECKED_OUT   (reception/admin)
     │              └──────────► NO_SHOW  ──(same company-local day, OVERRIDE with reason)──► CHECKED_IN
     └─(window_end passed: system)─┘
```
- Allowed: `SCHEDULED→CHECKED_IN|CANCELLED|NO_SHOW`, `NO_SHOW→CHECKED_IN` (override only, same company-local day as `scheduled_start`), `CHECKED_IN→CHECKED_OUT`. Anything else → `409 INVALID_STATE_TRANSITION` (or the specific code in §8.2). Pure function `assert_transition(current, target, *, method)` with full-matrix unit tests, always used under the row lock (§3.2-4).
- **NO_SHOW** = `status='SCHEDULED' AND window_end < :now`. Marked by `mark_no_shows(company_id, now)`: one `UPDATE visits SET status='NO_SHOW', no_show_at=:now WHERE company_id=:c AND status='SCHEDULED' AND window_end < :now RETURNING id` + one `VISIT_MARKED_NO_SHOW` audit row per visit (actor NULL). Called at the start of every visit-reading or visit-mutating service call for that company (cheap, index-backed), and by `cli mark-no-shows`. Each single-visit transition also re-checks the deadline under the lock.
- **Reschedule** (PATCH schedule while SCHEDULED, window not ended): recompute window with current grace, **keep the same pass** (no rotation, D-22), send a `VISIT_RESCHEDULED` email (no QR; "your existing QR code remains valid"). Cannot reschedule NO_SHOW/terminal visits.
- **Cancel**: revoke pass (`VISIT_CANCELLED`); optional `notify_visitor` (default true) → `VISIT_CANCELLED` email with the optional reason.
- **Check-out**: revoke pass (`VISIT_COMPLETED`). Terminal; re-entry is a new visit or walk-in (D-09).
- Duration = `check_out_at − check_in_at` (`duration_seconds`). Reports exclude `CORRECTED`/`BULK` from averages.
- Visits and visitors are never deleted (D-12).

## 6. Visitor pass (QR)

- Token: `secrets.token_urlsafe(32)`; stored as `sha256(token).hexdigest()`; lookup by unique hash. A pass row is **always** created with the visit (even without an email).
- QR payload *(rev. 5)*: `{QR_BASE_URL}/pass?c=<slug>#<token>` — the company's slug in the query, the token in the URL **fragment**, never sent to a server or written to logs. `/pass` is an unauthenticated, lazily-loaded SPA route that renders the QR client-side. It **sends the server only the company's slug, never the token**: with `c` it reads that company's public identity (`GET /public/companies/{slug}/brand` and its images, §8) to show the company's logo, name and colours; without `c` (every link sent before revision 5: `{QR_BASE_URL}/pass#<token>`) it is neutral and makes no API call at all. There is still no pass-status endpoint (D-20).
- The raw token / pass URL is shown to staff **exactly once**: in the `POST /visits` and `POST /visits/{id}/invitation` responses (`pass_url`), so the host can "Copy link / Show QR / Print" when email fails. It is never retrievable later (PASS_ISSUED audited).
- Scanner input parsing (pure, unit-tested on both sides): full pass URL or bare token; token alphabet `[A-Za-z0-9_-]{32,128}`. *(rev. 5)* A pass URL is read in both forms, with `?c=<slug>` and without a query: the path must be exactly `/pass` (or `/pass/`), the query is never read (the token alone decides, and the scan checks the company server-side as before), and the token is the whole fragment (`docs/contract/pass-token-vectors.json`, 63 cases shared by both suites; B12-14).
- **Server-side scan validation** `POST /reception/scan` — evaluated in this order:

| # | Condition | Response |
|---|---|---|
| 1 | malformed input, unknown hash, or pass belongs to another company | `404 PASS_INVALID` "Invalid visitor pass." — audit `PASS_SCANNED{outcome:'INVALID'}` with `entity_id` NULL, nothing from the input stored |
| 2 | (run `mark_no_shows`) visit `CANCELLED` | `409 VISIT_CANCELLED` "This visit has been cancelled." + `details.visit` |
| 3 | visit `CHECKED_OUT` | `409 VISIT_COMPLETED` "This visit has already been completed." + `details.visit` |
| 4 | visit `CHECKED_IN` (any pass of that visit, any time) | `200 {result:'ALREADY_CHECKED_IN', actions.check_out:true}`, warning `OVERSTAYED` if now > scheduled_end |
| 5 | host inactive | `409 HOST_INACTIVE` "The host for this visit is no longer active. Register the visitor as a walk-in with a current host." `check_in_options: []` |
| 6 | pass revoked (ROTATED / VISITOR_EMAIL_CHANGED), visit SCHEDULED | `410 PASS_REVOKED` "This visitor pass has been replaced. Ask the visitor for their latest invitation, or verify their ID and check in manually." `check_in_options: ['MANUAL']` if inside window, `['OVERRIDE']` if same day outside window, else `[]` |
| 7 | visit `NO_SHOW` or (SCHEDULED and now > window_end) | `410 PASS_EXPIRED` "This visitor pass has expired." `check_in_options: ['OVERRIDE']` if same company-local day, else `[]` |
| 8 | SCHEDULED and now < window_start | `409 PASS_NOT_YET_VALID` "This visitor pass is not valid yet." `check_in_options: ['OVERRIDE']` if same day, else `[]` |
| 9 | SCHEDULED within window | `200 {result:'READY', actions.check_in:true}`; warning `OUTSIDE_SCHEDULED_TIME` ("Visitor is outside the scheduled visit time.") when now ∉ [scheduled_start, scheduled_end] |

  Rows 2–8 put the visit summary in `error.details.visit` (reception is authorized to see it) plus `error.details.check_in_options`. Every outcome is audited (`PASS_SCANNED` with `outcome`); failure outcomes via the security-event writer (§7.4). Rate limit per user (§7.3).
- **Check-in** `POST /visits/{id}/check-in`: `QR` (re-validates the token server-side, must be row 9 and belong to this visit); `MANUAL` (identity verified by reception; visit SCHEDULED, inside window — used from the Expected list and for row 6); `OVERRIDE` (reason required; SCHEDULED or NO_SHOW; same company-local day; host active). Concurrent check-ins: one wins, the other gets `409 VISIT_ALREADY_CHECKED_IN`.
- **Client scanner rules** (§10): pause decoding while a result is shown; ignore the same token for 5 s; one request per detection.

## 7. Authentication, sessions, CSRF, RBAC

### 7.1 Passwords & login
- Argon2id via argon2-cffi `PasswordHasher` with explicit, documented parameters (time_cost=3, memory_cost=64 MiB, parallelism=4 unless benchmarking says otherwise); `check_needs_rehash` on login. A process-wide semaphore (≈ CPU count) limits concurrent hash operations; saturation → `503 SERVICE_BUSY`.
- Policy: 12–128 chars, not equal to the email, not in an embedded common-password list → `422 VALIDATION_ERROR` with field message.
- Login flow: normalise email (strip, NFKC, lowercase) → rate-limit checks (before any hashing) → load user → **always** run one verify (real hash, or a precomputed dummy built with the same hasher) → then check `is_active`, `password_expires_at`. Every failure: `401 INVALID_CREDENTIALS` "Invalid email or password." Audit: `AUTH_LOGIN_FAILED` with `company_id`/`actor_user_id` only when the user exists (`metadata.reason` ∈ bad_password, inactive, password_expired); unknown email → company NULL, no identifier stored.
- On success: create session, set cookies, `AUTH_LOGIN_SUCCEEDED`, return the `Me` payload.
- *(rev. 4, review, B11-46)* One refusal has an answer of its own: when the password verified, the account is active and its password current, and the only obstacle is that the company is deactivated, the answer is `409 COMPANY_INACTIVE` (audited `AUTH_LOGIN_FAILED`, `reason` company_inactive). It is reachable with valid credentials only (a wrong password or unknown address still gets the 401 after the same single verification), counts towards no failure budget, and takes a slot of the account's successful sign-ins instead. *(B11-36)* In production a seed account's sign-in is a failure like any other (`reason` seed_account).

### 7.2 Sessions, cookies, CSRF
- Cookies (when `COOKIE_SECURE=true`, the default): `__Host-vms_session` (HttpOnly; Secure; SameSite=Lax; Path=/) and `__Host-vms_csrf` (not HttpOnly; Secure; SameSite=Strict; Path=/). When `COOKIE_SECURE=false` (local http dev / tests only; refused in production) the names are `vms_session` / `vms_csrf`. The frontend reads whichever CSRF cookie exists.
- Lifetime: absolute `SESSION_MAX_AGE_HOURS` (12), idle `SESSION_IDLE_MINUTES` (240). `last_seen_at` updated at most once per minute and **not** for requests carrying `X-Background-Refresh: 1` (reception polling), so idle timeout still works on shared tablets. Logout clears the TanStack Query cache client-side.
- **Global middleware** (not per-route) for every unsafe method under `/api/v1`: (a) reject `Sec-Fetch-Site: cross-site` (and `same-site` unless the origin is allowed); (b) if `Origin` present it must be in `ALLOWED_ORIGINS` (config rejects `*`); (c) authenticated requests must send `X-CSRF-Token` matching the session (hash compare with `hmac.compare_digest`) → else `403 CSRF_FAILED`. Explicit exemption list for (c) only: `POST /auth/login`, `/auth/forgot-password`, `/auth/reset-password`. No `CORSMiddleware` (same-origin app).
- Revocation: logout (this session); password change (all other sessions); password reset & deactivation (all sessions + unused reset tokens).
- `must_change_password` → every endpoint except `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout` and *(rev. 3)* `PATCH /auth/preferences` returns `403 PASSWORD_CHANGE_REQUIRED`.
- Forgot/reset: `POST /auth/forgot-password` always `202` with identical body; the existing-user work (token + email) runs in the background task so both branches do the same synchronous work. Reset link `{APP_BASE_URL}/reset-password#token=<raw>`; the page strips the fragment with `history.replaceState` before rendering.

### 7.3 Client IP & rate limits
- `client_ip(request)`: if the direct peer is in `TRUSTED_PROXIES` (CIDR list, default empty) use the **rightmost** untrusted `X-Forwarded-For` entry, else the peer address; parse with `ipaddress`; invalid/missing → `None` (stored as NULL). Production nginx sets `X-Forwarded-For $remote_addr` (overwrite, not append). Vite dev proxy uses `xfwd`.
- Limits (env-configurable; `RATE_LIMIT_ENABLED` can be false only outside production):

| Key | Limit | Response |
|---|---|---|
| login failures per (IP, normalised email) | 5 / 5 min | 429 RATE_LIMITED |
| login failures per IP | 30 / 5 min (failures only, so office NAT logins are fine) | 429 |
| login failures per account (any IP) | 10 / 15 min → account login blocked 15 min | 429 "Too many attempts. Try again later." (audited `AUTH_ACCOUNT_THROTTLED`) |
| forgot-password per email / per IP | 3 / 15 min, 10 / 15 min | 202 (silently dropped) |
| scan per user | 120 / min | 429 |
| invitations created per user per day | `INVITATION_DAILY_LIMIT` 50 | 429 INVITATION_LIMIT |
| invitation resends per visit | 3 / hour | 429 INVITATION_LIMIT |
| authenticated API per user | 600 / min | 429 |
| public identity endpoints per client address / per IPv6 /48 *(rev. 5)* | 600 / min, 6,000 / min (`RATE_LIMIT_PUBLIC_BRAND_PER_IP`, `_PER_PREFIX`; every request counts, whatever the answer; production refuses more than ten times these) | 429 |
| brand changes per platform account *(rev. 5)* | 120 / hour (`RATE_LIMIT_BRAND_CHANGES_PER_HOUR`; every attempt counts, refused uploads included) | 429 |
  429 responses include `Retry-After`.

### 7.4 Audit writing
- Successful business events: `audit.record(db, …)` inside the business transaction.
- Failure/denial events (`AUTH_LOGIN_FAILED`, `AUTH_ACCOUNT_THROTTLED`, `PASS_SCANNED` failures, `ACCESS_DENIED` for 403 FORBIDDEN, `CSRF_FAILED`, `RATE_LIMITED`): `audit.record_security_event(…)` writes through its own session from `session_factory` and commits immediately, so the request rollback cannot erase it. Tests assert an audit row exists after each such response.
- *(rev. 4)* Every event of the platform realm (`/api/v1/platform`, §7.6) goes to `platform_audit_logs`, never to a company's trail. A platform action that changes a company is written **twice** (B11-5): in the platform's trail with the platform account as actor, and in the company's `audit_logs` without an actor and with `metadata.source = "platform"` and `metadata.platform_admin_id`. A company's e-mail text changes are audited as `EMAIL_TEMPLATE_UPDATED` / `EMAIL_TEMPLATE_RESET` / `EMAIL_TEMPLATE_TEST_SENT` with field names, never the texts (B11-30).
- *(rev. 5)* A change of a company's identity is `COMPANY_BRAND_UPDATED` (entity: the company), written in both trails like every platform action: `metadata.changed_fields` names the part (`logo`, `logo_dark`, `icon` or `color`) and `metadata.removed_fields` the same part when it was removed; never the image, its size or the colour's value. The same image or colour again writes nothing (B12-7). The platform owner's changes of a company's e-mail texts are written in both trails too, with the same metadata as an administrator's (B12-8). A seed's brand is audited with `source = "seed"` (B12-15).

### 7.5 Role/permission matrix
Roles are a set per user (D-04); a permission is granted if **any** role grants it. **Owner of a visit** = caller holds EMPLOYEE or SYSTEM_ADMIN **and** (`host_id = me` OR `created_by_id = me`).

| Capability | SYSTEM_ADMIN | EMPLOYEE | RECEPTIONIST | MANAGEMENT |
|---|---|---|---|---|
| Own profile, change own password | ✓ | ✓ | ✓ | ✓ |
| Host directory, active departments, company settings (read) | ✓ | ✓ | ✓ | ✓ |
| Create visit / invitation *(rev. 3)* | ✓ (any host) | ✓ (themselves as host only) | – | – |
| Read visits | all | owned only (forced; `scope`/`host_id` filters are intersected, never widen) | all | all (read-only) |
| Update / cancel / resend | all SCHEDULED | owned SCHEDULED | – | – |
| Read visitor + history | all | visitors created by me or linked to an owned visit; history filtered to owned visits | all | all |
| Edit visitor | ✓ | only if (created_by = me OR linked to an owned visit) AND no visit of that visitor belongs to another owner | ✓ | – |
| Scan, check-in, check-out, bulk stale check-out | ✓ | – | ✓ | – |
| Reception today, walk-in | ✓ | – | ✓ | – |
| Inside / evacuation list, company-wide history page | ✓ | – | ✓ | ✓ |
| Visitor search | all | own scope | all | all |
| Reports | ✓ | – | – | ✓ |
| Users, departments, company settings (write) | ✓ | – | – | – |
| Company e-mail texts: read, change, reset, preview, test to oneself *(rev. 4)* | ✓ | – | – | – |
| Company identity (logo, dark-surface logo, icon, colour): read, in `Me` and on the public pages *(rev. 5)* | ✓ | ✓ | ✓ | ✓ |
| Company identity: change *(rev. 5)* | – | – | – | – (the platform owner only, §7.6) |
| Audit logs | ✓ | – | – | – |

- *(rev. 4)* The platform owner (§7.6) holds no role and is outside this matrix: a platform session is refused (401) by every endpoint above, and a tenant session by every `/platform` endpoint.
- *(rev. 5)* No endpoint of a company's own users takes a logo, an icon, a colour or a slug: `PATCH /company/settings` refuses such a field like any unknown one (422, field code `not_allowed`) and applies nothing of the request (B12-7). The public identity endpoints (§8) need no session and no role.
- Hosts = active users with EMPLOYEE or SYSTEM_ADMIN.
- *(rev. 3, B10-24)* An invitation is made in the inviter's own name: only SYSTEM_ADMIN invites on behalf of another active host (capability `INVITE_FOR_ANY_HOST`); anyone else naming another `host_id` gets `422 VALIDATION_ERROR` on `host_id`, field code `host_must_be_self`, whatever that ID names. Walk-ins (reception) still name any active host; visits booked for a colleague earlier keep both owners; a visit's host never changes.
- Admin cannot remove own SYSTEM_ADMIN role or deactivate self; the last active SYSTEM_ADMIN cannot be demoted/deactivated — enforced after `SELECT … FROM companies WHERE id=:c FOR UPDATE` (serialises concurrent admin changes).
- Deactivating a user, or removing their last host role, **cancels their SCHEDULED hosted visits** in the same transaction (reason "Host is no longer available", visitor notified, audited) (D-18). Scan also checks host activity (row 5).
- EMPLOYEE-only callers: `409 VISITOR_EXISTS` returns **no** id or data; `visitor_id` outside read scope → `422` field error; inline reuse of an out-of-scope visitor (matched by email) links the visit but **does not** fill or reveal stored fields (response says only `visitor_match.reused = true`).

### 7.6 The platform owner *(rev. 4)*
- A principal of its own (B11-1): `platform_admins` and `platform_sessions`, no company, no role. No self-registration: `python -m app.cli create-platform-admin --email … [--full-name …] [--password-stdin] [--reset]` creates the account with a temporary password (generated and printed once, or read from stdin) that must be changed at the first sign-in and expires after 72 h; `--reset` gives an existing account a new one and ends its sessions (B11-3).
- Sign-in `POST /platform/auth/login`: the rules of §7.1 and §7.3 (budgets reserved before hashing, the per-address budgets shared with the tenant sign-in, account lockout or the trusted device's own budget, successful sign-ins budgeted, one Argon2id verification on every path, one `401 INVALID_CREDENTIALS`) (B11-7). No forgot-password and no password-changed e-mail (B11-8).
- Cookies `__Host-vms_platform_session` (HttpOnly; Secure; SameSite=Lax), `__Host-vms_platform_csrf` (readable; Secure; SameSite=Strict) and `__Host-vms_platform_device`; `vms_platform_*` with `COOKIE_SECURE=false`. Lifetimes `PLATFORM_SESSION_MAX_AGE_HOURS` (8) and `PLATFORM_SESSION_IDLE_MINUTES` (30); production refuses more than 12 h and 60 min. The CSRF middleware checks `/api/v1/platform` requests against the platform session's token (`X-CSRF-Token`), exempting only the sign-in; the two realms never accept each other's cookie or token (B11-6). `must_change_password` gates every platform endpoint but `GET /platform/auth/me`, `POST /platform/auth/logout`, `POST /platform/auth/change-password` and `PATCH /platform/auth/preferences`.
- What it may do (B11-2, B11-9 … B11-13): list and read companies with `counts.active_users` and `counts.visits_last_30_days`, create a company with its first SYSTEM_ADMIN (temporary password supplied by the client, as `POST /users`), change `name`, `name_ar`, `timezone` and `default_language` (never the slug), deactivate and reactivate it, list its administrators (SYSTEM_ADMIN users only), add one, send one a password-reset link (within the account's forgot-password budget), and read the platform's audit trail. Nothing about a company's visitors, visits, departments, other users or audit rows.
- Every platform request goes to the main API instance (B11-9).
- *(rev. 5)* **A company's identity** (B12-6, B12-7): the platform owner, and nobody else, stores and removes a company's three images (`PUT` / `DELETE /platform/companies/{id}/brand/assets/{kind}`; the body is the PNG itself, `Content-Type: image/png`, at most 512 KiB, the one request with a body limit of its own) and sets or clears its colour (`PATCH /platform/companies/{id}/brand`); `POST /platform/brand/palette` shows the palette a colour would give without saving anything. An upload is checked and written again by the server before it is stored (pure Python, no image library; interlaced and animated PNGs, anything after the image's end and data that inflates beyond the image are refused, B12-2). Every change answers the whole `CompanyBrand`, is audited in both trails (§7.4), counts in the hourly budget of brand changes (§7.3) and re-checks the session once the company row is locked (B11-38). A deactivated company keeps its identity, which only the platform owner still sees.
- *(rev. 5)* **A company's e-mail texts** (B12-8): the seven endpoints of `/email-templates` again under `/platform/companies/{id}/email-templates`, on the same service, with the same checks, field codes and limits. The texts are the company's (its administrators read and change them again; `updated_by_id` is NULL for a text the platform owner saved). A test e-mail goes to the platform owner's own address, within five an hour per platform account; the preview's sample host is a sample name.
- *(rev. 4, review)* What the review of 2026-10-13 added:
  - The platform session's idle window is extended only by the person's own requests, never by one carrying `X-Background-Refresh: 1` (B11-34), as for a company session (§7.2).
  - Recovery (B11-35): `create-platform-admin --reset` is the account's only recovery and works while its sign-in budget is spent from outside. The account's failure budgets are counted per account and device-trust epoch (a reset or change starts them afresh); a **generated** temporary password (32 characters) has a failure budget of its own, selected by a stored tag of its first 12 characters; the change that completes a temporary password is outside the hourly budget of changes. `--reset` takes no `--full-name`.
  - Seed accounts (B11-36): production refuses to start while an account created by `seed-demo` / `seed-e2e` exists (recognised by its deterministic ID), and refuses its sign-in; a seed's audit rows say `source = "seed"`.
  - A company's audit rows of platform actions carry no `ip_address` or `user_agent` (B11-37). Each platform write re-checks its session and account once the company row is locked (B11-38). A reset link cannot be issued while its company is being deactivated (B11-39).
  - `USER_EMAIL_UNAVAILABLE` from the two creations is audited in the platform's trail (`USER_CHANGE_REFUSED`) and bounded per platform account by `user_email_refusals_per_user` (B11-42).
  - When the platform owner adds an administrator to an existing company or sends one a reset link, the company's other active administrators receive a security notice by e-mail (`PLATFORM_ACTION_NOTICE`, not editable; at most five an hour per recipient; `metadata.notified_admins` in both audit rows) (B11-43), and the reset e-mail says the platform owner sent it (B11-49). *(rev. 5, UX review, B12-22)* Both are the company's own e-mails (§9): the notice names "the platform owner" in its text and shows nothing of the product.

## 8. API contract (`/api/v1`, JSON, cookie auth)

Error envelope (every non-2xx):
```json
{ "error": { "code": "PASS_EXPIRED", "message": "This visitor pass has expired.", "details": {} }, "request_id": "..." }
```
Pagination: `?page=1&page_size=25` (max 100) → `Paginated<T> = { items: T[], page, page_size, total }`. Multi-value filters are comma-separated (`status=SCHEDULED,CHECKED_IN`).

| Method & path | Roles | Request → Response |
|---|---|---|
| GET `/health` | public | `{status:'ok', database:'ok'}` (503 if DB down) |
| POST `/auth/login` | public | `{email, password}` → `Me` + cookies |
| POST `/auth/logout` | auth | → 204 |
| GET `/auth/me` | auth | → `Me` |
| POST `/auth/change-password` | auth | `{current_password, new_password}` → 204 |
| PATCH `/auth/preferences` *(rev. 3)* | auth (also while a password change is required) | `{language: 'ar' \| 'en'}` → `Me` (not audited) |
| POST `/auth/forgot-password` | public | `{email}` → 202 `{message}` |
| POST `/auth/reset-password` | public | `{token, new_password}` → 204 |
| GET `/users/hosts` | auth | `?q` → `Host[]` (max 50) |
| GET `/users` | admin | `?q&role&is_active&page&page_size` → `Paginated<User>` |
| POST `/users` | admin | `{full_name, email, phone?, roles[], department_id?, temporary_password}` → 201 `User` |
| GET / PATCH `/users/{id}` | admin | PATCH `{full_name?, phone?, department_id?, roles?, is_active?}` → `User` (+ `cancelled_visits` count when hosted visits were cancelled) |
| GET `/departments` | auth | `?include_inactive` (admin only) → `Department[]` |
| POST `/departments`, PATCH `/departments/{id}` | admin | `{name, name_ar?}` / `{name?, name_ar?, is_active?}` → `Department` *(rev. 3: `name_ar`; null or blank clears it)* |
| GET / PATCH `/company/settings` | GET auth, PATCH admin | → `CompanySettings` (PATCH: the fields of §8.1, *rev. 3* `name_ar`, `address_ar`, `default_language` included) |
| GET `/visitors` | scoped | `?q&page&page_size` → `Paginated<VisitorSearchItem>` |
| POST `/visitors` | admin, employee, reception | `{full_name, email?, phone?, company_name?}` → 201 `Visitor` |
| GET `/visitors/{id}` | scoped | → `Visitor` |
| PATCH `/visitors/{id}` | rule §7.5 | `{full_name?, email?, phone?, company_name?}` → `Visitor`; email change re-issues invitations (D-19) |
| GET `/visitors/{id}/visits` | scoped | `?page&page_size` → `Paginated<Visit>` (newest first) |
| GET `/visits` | scoped | `?scope=mine|all&status&date_from&date_to&host_id&visitor_id&department_id&needs_attention&q&order=asc|desc&page&page_size` → `Paginated<Visit>` |
| POST `/visits` | admin, employee | `VisitCreate` → 201 `VisitCreateResult` (*rev. 3*: `host_id` is the caller's own ID unless the caller is an administrator, §7.5) |
| GET `/visits/{id}` | scoped | → `Visit` |
| PATCH `/visits/{id}` | owner/admin, SCHEDULED | `{purpose?, department_id?, scheduled_start?, scheduled_end?}` → `Visit` |
| POST `/visits/{id}/cancel` | owner/admin | `{reason?, notify_visitor?: true}` → `Visit` |
| POST `/visits/{id}/invitation` | owner/admin | → `VisitCreateResult` (rotates pass, sends invitation; requires visitor email) |
| POST `/visits/{id}/check-in` | reception, admin | `{method:'QR', pass_token}` \| `{method:'MANUAL'}` \| `{method:'OVERRIDE', reason}` → `Visit` |
| POST `/visits/{id}/check-out` | reception, admin | `{method:'QR', pass_token}` \| `{method:'MANUAL'}` \| `{method:'CORRECTED', check_out_at, note}` → `Visit` |
| POST `/reception/scan` | reception, admin | `{token}` → `ScanResult` or §6 errors |
| GET `/reception/today` | reception, admin | → `ReceptionToday` |
| GET `/reception/inside` | reception, admin, management | → `{count, items: Visit[]}` (all CHECKED_IN, any date; `is_stale`, `is_overdue` flags) |
| POST `/reception/check-out-stale` | reception, admin | `{reason}` → `{checked_out: n}` (CHECKED_IN visits whose check-in is before today; `check_out_at = max(check_in_at, scheduled_end)`, method BULK) |
| POST `/reception/walk-ins` | reception, admin (if `allow_walk_ins`) | `WalkInCreate` → 201 `Visit` (created CHECKED_IN, method WALK_IN) |
| GET `/dashboard/employee` | employee, admin | → `EmployeeDashboard` |
| GET `/dashboard/admin` | admin | → `AdminDashboard` |
| GET `/reports/summary` | management, admin | `?date_from&date_to` (company-local dates, default last 30 days, max 366) → `ReportSummary` |
| GET `/audit-logs` | admin | `?action&actor_user_id&entity_type&entity_id&date_from&date_to&page&page_size` → `Paginated<AuditLog>` (by `seq` desc) |
| GET `/email-templates` *(rev. 4)* | admin | → `EmailTemplate[]` (the four editable kinds) |
| GET / PATCH `/email-templates/{kind}` *(rev. 4)* | admin | PATCH `EmailTemplateUpdate` → `EmailTemplate`; `{kind}` other than the four (the security e-mails included) → 404 |
| POST `/email-templates/{kind}/reset` *(rev. 4)* | admin | `{language?}` (none: both) → `EmailTemplate` |
| POST `/email-templates/{kind}/preview` *(rev. 4)* | admin | `EmailTemplatePreviewRequest` → `EmailPreview` (sample data, saved texts or a draft; nothing sent; *(Phase 13, B13-5)* `scheme`: `light` (default) or `dark`, one design alone) |
| GET `/email-templates/{kind}/preview` *(rev. 4)* | admin | `?language` (and *(Phase 13)* `?scheme=light\|dark`) → the saved texts' HTML document (text/html, sandboxing CSP, frameable by the application only) |
| POST `/email-templates/{kind}/test` *(rev. 4)* | admin | `EmailTemplatePreviewRequest` → 202 `EmailTestSent` (to the caller's own address; 5/h) |
| POST `/platform/auth/login` *(rev. 4)* | public | `{email, password}` → `PlatformMe` + platform cookies |
| POST `/platform/auth/logout` *(rev. 4)* | platform | → 204 |
| GET `/platform/auth/me` *(rev. 4)* | platform | → `PlatformMe` |
| POST `/platform/auth/change-password` *(rev. 4)* | platform | `{current_password, new_password}` → 204 + new platform cookies |
| PATCH `/platform/auth/preferences` *(rev. 4)* | platform | `{language}` → `PlatformMe` |
| GET `/platform/companies` *(rev. 4)* | platform | `?q&is_active&page&page_size` → `Paginated<PlatformCompany>` |
| POST `/platform/companies` *(rev. 4)* | platform | `PlatformCompanyCreate` → 201 `PlatformCompanyCreated` |
| GET / PATCH `/platform/companies/{id}` *(rev. 4)* | platform | PATCH `PlatformCompanyUpdate` → `PlatformCompany` |
| POST `/platform/companies/{id}/deactivate`, `/reactivate` *(rev. 4)* | platform | → `PlatformCompany` |
| GET / POST `/platform/companies/{id}/admins` *(rev. 4)* | platform | → `PlatformCompanyAdmin[]`; POST `CompanyAdminCreate` → 201 `PlatformCompanyAdmin` |
| POST `/platform/companies/{id}/admins/{user_id}/password-reset` *(rev. 4)* | platform | → 202 `AdminPasswordResetSent` |
| GET `/platform/audit-logs` *(rev. 4)* | platform | `?company_id&action&page&page_size` → `Paginated<PlatformAuditLog>` |
| GET / PATCH `/platform/companies/{id}/brand` *(rev. 5)* | platform | PATCH `{color: '#rrggbb' \| null}` → `CompanyBrand` |
| PUT / DELETE `/platform/companies/{id}/brand/assets/{kind}` *(rev. 5)* | platform | `{kind}` = `logo` \| `logo_dark` \| `icon`; PUT: the body is the PNG (`Content-Type: image/png`, ≤ 512 KiB; else 415 `UNSUPPORTED_MEDIA_TYPE`, 413) → `CompanyBrand`; a refused file is a 422 on the field `file` |
| POST `/platform/brand/palette` *(rev. 5)* | platform | `{color}` → `BrandPalette` (nothing saved) |
| GET `/platform/companies/{id}/email-templates`, GET / PATCH `…/{kind}`, POST `…/{kind}/reset`, POST / GET `…/{kind}/preview`, POST `…/{kind}/test` *(rev. 5)* | platform | as the seven `/email-templates` endpoints, for the company in the path; the test e-mail goes to the platform owner |
| GET `/public/companies/{slug}/brand` *(rev. 5)* | public, no session | → `PublicCompanyBrand` (`Cache-Control: no-cache`, `ETag`); active companies only, every other slug the same 404 |
| GET `/public/companies/{slug}/brand/{kind}.png` *(rev. 5)* | public, no session | `?v` → the PNG (`image/png`, `nosniff`, `ETag`); `Cache-Control: public, max-age=31536000, immutable` when `v` is the image's current version, else `public, max-age=60`; 404 without that image |
| GET `/public/companies/{slug}/manifest.webmanifest` *(rev. 5)* | public, no session | → the company's web app manifest (`application/manifest+json`, `no-cache`, `ETag`). *(rev. 5, UX review)* `name` is the company's whole name; `short_name` has at most 12 characters, cut between two words where it can be and without an ellipsis (B12-25); `theme_color` is `palette.surface` (B12-21) |

OpenAPI docs (`/docs`, `/openapi.json`) are disabled when `APP_ENV=production`.

*(rev. 5)* The three public endpoints are the only ones whose answers may be kept by a browser or a cache, and only their successes: every other answer of the API, and every error of these, is `Cache-Control: no-store`. They read no cookie and set none, answer `304 Not Modified` to `If-None-Match` naming the current entity tag, send no `Vary`, and count every request in the client's budget (§7.3) before anything is looked up. All of them, and every platform endpoint, are served by the main API process (B12-9, B12-16).

### 8.1 Schemas (backend Pydantic ⇄ `frontend/src/types/api.ts`)

`?` = optional in requests; `| null` = nullable in responses. IDs are UUID strings; datetimes ISO-8601 UTC strings.

```ts
type Role = 'SYSTEM_ADMIN' | 'EMPLOYEE' | 'RECEPTIONIST' | 'MANAGEMENT'
type VisitStatus = 'SCHEDULED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW'
type CheckInMethod = 'QR' | 'MANUAL' | 'OVERRIDE' | 'WALK_IN'
type CheckOutMethod = 'QR' | 'MANUAL' | 'CORRECTED' | 'BULK'
type InvitationStatus = 'NOT_SENT' | 'PENDING' | 'SENT' | 'FAILED'
type PassStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'NONE'
type PassRevokeReason = 'ROTATED' | 'VISIT_CANCELLED' | 'VISIT_COMPLETED' | 'VISITOR_EMAIL_CHANGED'
type Language = 'ar' | 'en'   // rev. 3; Arabic is the product's default

interface UserRef { id: string; full_name: string }
interface DepartmentRef { id: string; name: string; name_ar: string | null }   // rev. 3: name_ar (in a visit: snapshots)
interface Me {
  user: { id: string; full_name: string; email: string; phone: string | null; roles: Role[];
          department: DepartmentRef | null; must_change_password: boolean;
          preferred_language: Language | null }                 // rev. 3; null follows the company
  company: { id: string; name: string; name_ar: string | null; slug: string; timezone: string;
             default_language: Language; brand: CompanyBrand }  // rev. 3: name_ar, default_language; rev. 5: slug, brand
}
// rev. 5 (B12-4, B12-11): a company's identity. The three addresses are same-origin paths of the public image
// endpoint, each with its image's own version (use them as they are); null without that image. `palette` is
// null exactly when `color` is. `version` changes whenever an image, the colour or the derivation changes.
// rev. 5, UX review (B12-21): `surface` is what brand surfaces are painted with (the shell, primary buttons,
// an e-mail's bar and button): the chosen colour ITSELF wherever white or the dark ink reaches 4.5:1 on it,
// otherwise `strong`. `on_surface` is the ink on it and on `surface_hover`: '#ffffff' where white reads
// (preferred), else the dark ink of `on_bright`; 4.5:1 on both. `surface_hover` is its hover and pressed
// step, at least 0.06 of OKLCH lightness away. `strong` stays the colour of text, links and icons on white.
interface BrandPalette { strong: string; strong_hover: string; deep: string; bright: string; tint: string;
  tint_border: string; on_strong: string; on_bright: string;
  surface: string; on_surface: string; surface_hover: string }  // each '#rrggbb'; derived by the server only
interface CompanyBrand { logo_url: string | null; logo_dark_url: string | null; icon_url: string | null;
  color: string | null; palette: BrandPalette | null; version: string }
interface PublicCompanyBrand { slug: string; name: string; name_ar: string | null; default_language: Language;
  brand: CompanyBrand }                                         // GET /public/companies/{slug}/brand
interface CompanyBrandUpdate { color: string | null }           // PATCH /platform/companies/{id}/brand; the key is required
interface BrandPaletteRequest { color: string }                 // POST /platform/brand/palette
interface BrandImageParams { v?: string }                       // GET /public/companies/{slug}/brand/{kind}.png
interface PreferencesUpdate { language: Language }              // rev. 3: PATCH /auth/preferences
interface User { id: string; full_name: string; email: string; phone: string | null; roles: Role[];
  department: DepartmentRef | null; is_active: boolean; must_change_password: boolean;
  last_login_at: string | null; created_at: string; updated_at: string; cancelled_visits?: number }
interface Host { id: string; full_name: string; phone: string | null; department: DepartmentRef | null }
interface Department { id: string; name: string; name_ar: string | null;   // rev. 3: name_ar
  is_active: boolean; created_at: string; updated_at: string }
// POST /departments: { name: string; name_ar?: string | null }; PATCH: { name?: string; name_ar?: string | null;
// is_active?: boolean }. name_ar has the rules of name (trimmed, ≤ 120 characters, one line); null or blank clears it.
interface CompanySettings { id: string; name: string; name_ar: string | null; default_language: Language;   // rev. 3
  timezone: string; address: string | null; address_ar: string | null; email_domain: string | null;    // rev. 3: address_ar
  pass_grace_before_minutes: number; pass_grace_after_minutes: number; notify_host_on_check_in: boolean; allow_walk_ins: boolean }
// PATCH /company/settings also accepts name_ar?: string | null (the rules of name; blank or null clears it),
// address_ar?: string | null (the rules of address; blank or null clears it) and default_language?: Language (not null).
// Display rule (rev. 3): the Arabic interface shows a department's name_ar and the company's address_ar when they
// are set, else name and address; English shows name and address. Names people type are shown as typed.

interface Visitor { id: string; full_name: string; email: string | null; phone: string | null; company_name: string | null;
  created_at: string; updated_at: string;
  stats: { total_visits: number; last_visit_at: string | null }   // within the caller's scope
  permissions: { can_edit: boolean } }
interface VisitorSearchItem extends Visitor { today_visits: Visit[] }   // SCHEDULED/CHECKED_IN visits today, in scope

interface Visit {
  id: string; status: VisitStatus
  visitor: { id: string; full_name: string; company_name: string | null }   // snapshot
  host: { id: string; full_name: string; phone: string | null }              // name = snapshot, phone = current
  department: DepartmentRef | null                                           // name, name_ar = snapshots
  purpose: string
  scheduled_start: string; scheduled_end: string; window_start: string; window_end: string
  is_walk_in: boolean; walk_in_reason: string | null
  check_in_at: string | null; check_in_method: CheckInMethod | null; check_in_note: string | null; checked_in_by: UserRef | null
  check_out_at: string | null; check_out_method: CheckOutMethod | null; check_out_note: string | null; checked_out_by: UserRef | null
  cancelled_at: string | null; cancellation_reason: string | null; cancelled_by: UserRef | null
  no_show_at: string | null
  duration_seconds: number | null
  is_overdue: boolean        // CHECKED_IN and now > scheduled_end
  is_stale: boolean          // CHECKED_IN and check-in before company-local today
  created_by: UserRef; created_at: string; updated_at: string
  invitation: { status: InvitationStatus; to_email: string | null; attempts: number;
                last_attempt_at: string | null; sent_at: string | null; error: string | null }   // latest VISITOR_INVITATION
  pass: { status: PassStatus; issued_at: string | null; revoke_reason: PassRevokeReason | null }
  permissions: { can_edit: boolean; can_cancel: boolean; can_resend: boolean; can_check_in: boolean; can_check_out: boolean }
}
interface VisitCreate {
  visitor_id?: string
  visitor?: { full_name: string; email?: string; phone?: string; company_name?: string }   // exactly one of visitor_id / visitor
  host_id: string                                     // rev. 3: the caller's own ID unless the caller is an administrator
  department_id?: string; purpose: string
  scheduled_start: string; scheduled_end: string      // timezone-aware ISO
  send_invitation: boolean                            // true requires a visitor email
}
interface VisitCreateResult { visit: Visit; pass_url: string; visitor_match: { reused: boolean } }
interface WalkInCreate {
  visitor_id?: string
  visitor?: { full_name: string; email?: string; phone?: string; company_name?: string }
  host_id: string; department_id?: string; purpose: string
  expected_end: string                                // default now + 1h in UI
  reason: 'NO_INVITATION' | 'EARLY_ARRIVAL' | 'LATE_ARRIVAL' | 'LOST_PASS' | 'DELIVERY' | 'OTHER'
  reason_note?: string                                // required when reason = OTHER
}
interface ScanWarning { code: 'OUTSIDE_SCHEDULED_TIME' | 'OVERSTAYED'; message: string }
interface ScanResult { result: 'READY' | 'ALREADY_CHECKED_IN'; visit: Visit; warnings: ScanWarning[];
  actions: { check_in: boolean; check_out: boolean } }
interface ScanErrorDetails { visit?: Visit; check_in_options?: ('MANUAL' | 'OVERRIDE')[] }

interface ReceptionToday { date: string;   // company-local YYYY-MM-DD
  counts: { expected: number; inside: number; checked_out: number; no_show: number; cancelled: number; walk_ins: number }
  expected: Visit[]; inside: Visit[]; checked_out: Visit[]; no_show: Visit[]   // each list capped at 200 (counts exact)
}
interface EmployeeDashboard {
  counts: { today: number; upcoming: number; inside: number; completed_30d: number; cancelled_30d: number; needs_attention: number }
  today: Visit[] }
interface AuditLog { id: string; seq: number; created_at: string; action: string; actor: UserRef | null;
  entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown>;
  ip_address: string | null; user_agent: string | null; request_id: string | null }
interface AdminDashboard {
  counts: { visitors_total: number; visits_total: number; inside_now: number; visits_today: number;
            employees: number; receptionists: number; management: number; admins: number }
  recent_audit: AuditLog[] }   // 10
interface ReportSummary { date_from: string; date_to: string; timezone: string
  totals: { visits: number; unique_visitors: number; checked_in: number; checked_out: number; no_show: number; cancelled: number; walk_ins: number }
  no_show_rate: number | null              // no_show / (visits that reached a final or checked-in state)
  avg_duration_seconds: number | null       // excludes CORRECTED and BULK check-outs
  visits_per_day: { date: string; count: number }[]
  by_department: { department_id: string | null; name: string; name_ar: string | null; count: number }[]   // rev. 3: name_ar (current; null for "No department")
  top_hosts: { host_id: string; full_name: string; count: number }[]   // top 10
  check_ins_by_hour: { hour: number; count: number }[] }               // 0..23, company timezone

// rev. 3: the details of every 422 VALIDATION_ERROR (B10-18). Both maps have exactly the same paths.
interface ValidationErrorDetails {
  fields: Record<string, string>                                       // path → English message
  field_codes: Record<string, { code: FieldErrorCode; params: Record<string, number | string | string[]> }>
}   // FieldErrorCode: the 61 codes of the contract snapshot's field_error_codes (rev. 3 added host_must_be_self, §7.5);
    // params holds exactly the code's parameters
```
*(rev. 4)* The platform owner and a company's e-mail texts (B11-1 … B11-31):
```ts
interface PlatformMe { admin: { id: string; full_name: string; email: string; must_change_password: boolean;
  preferred_language: Language | null } }
interface CompanyCounts { active_users: number; visits_last_30_days: number }
interface PlatformCompany { id: string; name: string; name_ar: string | null; slug: string; timezone: string;
  default_language: Language; is_active: boolean; deactivated_at: string | null; created_at: string;
  updated_at: string; counts: CompanyCounts; brand: CompanyBrand }   // rev. 5: brand
interface PlatformCompanyAdmin { id: string; full_name: string; email: string; is_active: boolean;
  must_change_password: boolean; last_login_at: string | null; created_at: string }
interface PlatformCompanyCreated { company: PlatformCompany; admin: PlatformCompanyAdmin }
interface CompanyAdminCreate { full_name: string; email: string; temporary_password: string }
interface PlatformCompanyCreate { name: string; name_ar?: string | null; slug: string; timezone: string;
  default_language: Language; admin: CompanyAdminCreate }
interface PlatformCompanyUpdate { name?: string; name_ar?: string | null; timezone?: string; default_language?: Language }
interface AdminPasswordResetSent { sent_to: string }
interface PlatformAuditLog { id: string; seq: number; created_at: string; action: string;
  actor: { id: string; full_name: string } | null; company: { id: string; name: string; name_ar: string | null } | null;
  entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown>;
  ip_address: string | null; user_agent: string | null; request_id: string | null }
type EditableEmailKind = 'VISITOR_INVITATION' | 'VISIT_RESCHEDULED' | 'VISIT_CANCELLED' | 'HOST_ARRIVAL'
type TemplateField = 'subject' | 'heading' | 'greeting' | 'intro' | 'button' | 'closing' | 'footer_note'
interface EmailTemplate { kind: EditableEmailKind; variables: string[]; max_variable_uses: number;  // rev. 4, review
  updated_at: string | null;
  fields: { name: TemplateField; multiline: boolean; max_length: number; required_variables: string[];
            forbidden_variables: string[];  // rev. 4, review: ['purpose'] for a subject
            default: { ar: string; en: string }; override: { ar: string | null; en: string | null } }[] }
interface EmailTemplateTexts { subject?: string | null; heading?: string | null; greeting?: string | null;
  intro?: string | null; button?: string | null; closing?: string | null; footer_note?: string | null }
interface EmailTemplateUpdate { ar?: EmailTemplateTexts | null; en?: EmailTemplateTexts | null }
interface EmailTemplateReset { language?: Language | null }
interface EmailTemplatePreviewRequest extends EmailTemplateUpdate { language: Language }
interface EmailPreview { kind: EditableEmailKind; language: Language; subject: string; html: string; text: string }
interface EmailTestSent { sent_to: string }
```
*(rev. 4)* `ValidationErrorDetails.field_codes` gains `unknown_placeholder` (params `name`, `allowed`), `placeholder_required` (`name`), `invalid_placeholder` and `markup_not_allowed`: 65 codes. *(rev. 4, review, B11-40)* It gains `placeholder_not_allowed` (`name`) and `placeholder_repeated` (`max`, `name`): 67 codes.

`needs_attention` = SCHEDULED visits whose latest invitation is FAILED (or NOT_SENT with `send_invitation` requested), within scope.

### 8.2 Error codes

| HTTP | code | message (user-facing) |
|---|---|---|
| 401 | NOT_AUTHENTICATED | Please sign in. |
| 401 | INVALID_CREDENTIALS | Invalid email or password. |
| 403 | FORBIDDEN | You do not have permission to perform this action. |
| 403 | CSRF_FAILED | Your session could not be verified. Please refresh the page and try again. |
| 403 | PASSWORD_CHANGE_REQUIRED | You must change your password before continuing. |
| 400 | INVALID_RESET_TOKEN | This password reset link is invalid or has expired. |
| 400 | INVALID_CURRENT_PASSWORD | Your current password is incorrect. |
| 404 | NOT_FOUND | The requested item was not found. |
| 409 | CONFLICT | generic uniqueness (`details.field`) e.g. department name |
| 409 | USER_EMAIL_UNAVAILABLE | This email address cannot be used. (also for other-tenant emails; no existence oracle) |
| 409 | LAST_ADMIN | The company must keep at least one active administrator. |
| 409 | SELF_MODIFICATION | You cannot remove your own administrator access or deactivate yourself. |
| 409 | VISITOR_EXISTS | A visitor with this email already exists. (`details.visitor_id` only for non-EMPLOYEE-only callers) |
| 409 | INVALID_STATE_TRANSITION | This action is not allowed for the visit's current status. |
| 409 | VISIT_NOT_EDITABLE | Only scheduled visits can be changed. |
| 409 | VISIT_ALREADY_CHECKED_IN | This visitor is already checked in. |
| 409 | VISIT_NOT_CHECKED_IN | This visitor is not checked in. |
| 409 | VISITOR_ALREADY_INSIDE | This visitor is already checked in on another visit. |
| 409 | VISIT_CANCELLED / VISIT_COMPLETED / HOST_INACTIVE / PASS_NOT_YET_VALID | see §6 |
| 410 | PASS_EXPIRED / PASS_REVOKED | see §6 |
| 404 | PASS_INVALID | Invalid visitor pass. |
| 409 | VISITOR_EMAIL_REQUIRED | The visitor needs an email address to receive an invitation. |
| 409 | WALK_INS_DISABLED | Walk-in registration is disabled for this company. |
| 409 | OVERRIDE_NOT_ALLOWED | This visit cannot be checked in with an override. |
| 409 | COMPANY_INACTIVE *(rev. 4)* | This company is deactivated. (a reset link for an administrator of a deactivated company; *(rev. 4, review)* a sign-in with valid credentials to a deactivated company, B11-46) |
| 409 | ACCOUNT_INACTIVE *(rev. 4)* | This account is deactivated. (a reset link for an inactive administrator) |
| 415 | UNSUPPORTED_MEDIA_TYPE *(rev. 5)* | Upload the image as a PNG file (Content-Type: image/png). (the upload of a brand image with any other media type; the default message of the code is "This type of content is not supported here.") |
| 422 | VALIDATION_ERROR | Please correct the highlighted fields. (`details.fields: {path: message}` and, *rev. 3*, `details.field_codes: {path: {code, params}}` for the same paths; the vocabulary is the snapshot's `field_error_codes`, B10-18; schedule rules, password policy, out-of-scope IDs) |
| 429 | RATE_LIMITED | Too many requests. Please wait and try again. |
| 429 | INVITATION_LIMIT | Invitation limit reached. Please try again later. |
| 503 | SERVICE_BUSY | The service is busy. Please try again. |
| 500 | INTERNAL_ERROR | Something went wrong. Please try again. (never a stack trace) |

*(rev. 5)* Field codes of a company's identity (39 error codes and 72 field codes in the snapshot): `invalid_color` on `color` (anything but `#` and six lower-case hexadecimal digits); on `file`, the uploaded image: `required` (an empty body), `invalid_image` (not a PNG the server accepts: damaged, interlaced, animated, with anything after its end, or with data that is not exactly the image), `image_too_small` (`min_width`, `min_height`), `image_too_large` (`max_width`, `max_height`) and `image_not_square` (the icon). `413 PAYLOAD_TOO_LARGE` for that upload means more than 512 KiB.

## 9. Email

- `EmailService` (business-facing): `queue_visitor_invitation(visit, raw_token)`, `queue_visit_rescheduled(visit)`, `queue_visit_cancelled(visit, reason)`, `queue_host_arrival(visit)`, `queue_password_reset(user, raw_token)`. Each renders subject/html/text (Jinja2, autoescape), creates the `email_messages` row (PENDING) in the caller's transaction, and returns a `DeliveryJob(message_id, OutgoingEmail)`; the caller commits, then schedules `dispatcher.deliver(job)` as a background task.
- `EmailProvider.send(OutgoingEmail) -> ProviderResult(provider_message_id)`; raises `EmailDeliveryError(transient: bool)`. Providers:
  - `ResendProvider`: `POST https://api.resend.com/emails` with bearer `RESEND_API_KEY`, `from=EMAIL_FROM`, optional `reply_to`; inline QR as attachment with `content_id` referenced via `cid:` in HTML (**verify the current Resend inline-attachment API from official docs**); 429/5xx/timeouts = transient.
  - *(rev. 3)* `SmtpProvider`: `smtplib` over STARTTLS or implicit TLS (certificate verified; `none` only outside production, without credentials) with optional AUTH; text and HTML alternatives with the QR as an inline related part (`cid:`); 4xx, timeouts and connection errors transient, 5xx and a refused sign-in permanent; every wait within the message's deadline (S10-1 to S10-4, S10-10 to S10-13).
  - `OutboxProvider` (dev/E2E; refused when `APP_ENV=production`): writes `<message_id>.json|.html|.txt` and inline images `<message_id>-<cid>.png` into `EMAIL_OUTBOX_DIR`; JSON = `{message_id, kind, to, subject, created_at, pass_url, reset_url}` (null when not applicable). `EMAIL_FAIL_DOMAIN` (non-production only): recipients at that domain fail permanently (for E2E/manual testing of failure handling).
  - `MemoryProvider` (tests).
- *(rev. 3)* `python -m app.cli send-test-email --to <address> [--language ar|en]`: one message with a sample QR code through the configured provider; no database, no audit row (S10-6).
- Dispatcher: loads the row `WHERE id=:id AND status='PENDING'` via `session_factory`; up to 3 attempts for transient errors (backoff 1 s, 3 s) within the task; then SENT (provider id, sent_at) or FAILED (attempts, sanitized `last_error`, `last_attempt_at`). Visit creation never fails because of email. **No `retry-emails` CLI** (D-21): invitation retry = `POST /visits/{id}/invitation` (rotates pass, warns "The previous QR code will stop working").
- Templates *(rev. 3; the identity of a company's e-mails is rev. 5, below)*: professional table-based HTML + plain text, **bilingual** (Arabic and English: the leading language first and complete, then the other, also complete), with the brand logo inline (`cid:brand-logo`) in every message. Visitor e-mails lead with the company's `default_language` and carry both languages in the subject; staff e-mails lead with the recipient's `preferred_language`, else the company's, with the subject in that language. Arabic dates use Levantine month names and Latin digits in the company's time zone. The Arabic text names the company by `name_ar` when set, else by `name`; *(rev. 3, B10-26)* likewise the department by the visit's Arabic department name and the company's address by `address_ar` when they are set, while the English text uses `name` and `address` (an English text whose company has only `address_ar` shows that one rather than none). Invitation: company name and address, visitor name, host, department, date and time **with time-zone label**, the check-in window, purpose labelled as provided by the host, inline QR, arrival steps, the pass-page link with its address, "This pass is personal". No explanatory filler (B10-19). No internal IDs. Every template shares the base layout: the white logo on the teal `#188086` header. The footer says who sent the message: the product (`PRODUCT_NAME_*`), on behalf of the company unless it is the brand's own. `BRAND_NAME_AR` / `BRAND_NAME_EN` name the brand (the logo's text alternative); `PRODUCT_NAME_AR` / `PRODUCT_NAME_EN` name the product (footers, the plain text's first line, `EMAIL_FROM`'s default display name, the OpenAPI title).
- Header safety *(rev. 3)*: line breaks of every kind (CR, LF, C1 controls, U+2028/2029) and other control characters are replaced in all header values; recipients validated as e-mails; an address containing `=?` is refused, and an `=?` in the SMTP Subject is broken so it cannot start an encoded word (S10-5, S10-13).
- *(rev. 4)* A company's own texts (B11-20 … B11-29): for VISITOR_INVITATION, VISIT_RESCHEDULED, VISIT_CANCELLED and HOST_ARRIVAL its administrators may replace, per language, the subject, heading, greeting, first paragraph (`intro`), the invitation's button label, and add a closing paragraph and a footer line. The layout, logo, colours, QR code, details grid, pass link, window of validity and every security line stay the product's; PASSWORD_RESET and PASSWORD_CHANGED are not editable. Texts are plain text with `{variable}` placeholders from a per-kind allow-list, checked on save, read when the e-mail is queued (= rendered) and escaped and direction-isolated like the catalog's values.
- *(rev. 4, review)* What bounds a company's texts (B11-40): a variable appears at most 3 times in one text; `purpose` is not a variable of a subject; a text renders to at most twice its own limit, cut with an ellipsis; a text saved before a rule existed is not used. Every subject, the product's own too, is finished in one place for every provider: one line, no direction controls, no RFC 2047 encoded word (`=?` written `= ?`, B11-41), at most 250 characters with each language of a bilingual subject keeping at least half. A time range in a sentence stays on one line in HTML (B11-47); a closing is a paragraph of its own (B11-48). *(rev. 5, UX review, B12-24)* A subject that is too long gives up some of the company's name first: the name is cut short where it stands, with an ellipsis, to no fewer than 12 characters, so that the date after it stays and each language's half is a whole sentence; only then is the subject cut at its end. A test e-mail's prefix ("[Test] ", «[رسالة تجريبية] » when Arabic leads; B12-25) is part of the room the subject is built for.
- *(rev. 4, review)* `queue_platform_notice(recipient, action, about, when)`: the security notice of a platform action on an administrator account (B11-43), bilingual, led by the recipient's language, not editable, without link or credential; *(rev. 5, UX review, B12-22)* in the company's own identity, like every e-mail its people receive. `queue_password_reset(user, raw_token, sent_by_platform_owner)` words a link the platform owner sent accordingly (B11-49).
- *(rev. 5)* **Whose e-mail a message is** (B12-12 … B12-14). A company's e-mails (the four visit e-mails, its users' password-reset and password-changed e-mails, the previews and test e-mails of its texts, and *(rev. 5, UX review, B12-22)* the notice of a platform action to its administrators: every e-mail its people and visitors receive) show that company and nothing of the product: a white header under a bar in the company's colour with **its logo inline** (`cid:brand-logo`, at most 168 × 44 CSS pixels, its text alternative the company's name) or **its name as a word mark** when it has no logo; the colours of its palette (the product's teal while it has no colour), which keep every text readable whatever colour was chosen; the footer "Sent by {company}." / «أُرسلت من {company}.»; and the company's name as the **display name of the sender** (the address stays the configured `EMAIL_FROM` address; the name is stripped of everything that could end the name, carry an address or start an encoded word, and cut at 100 characters). No sentence, header, image or colour of such an e-mail names the product or shows the Mawdoo3 logo. *(rev. 5, UX review)* The product's identity is left on one message, which no company's people receive: the CLI's `send-test-email` (until B12-22 `PLATFORM_ACTION_NOTICE` carried it too, with "Sent by Mawdoo3 Visitors on behalf of …"). **The company's own colour** (B12-21): the bar of the header and the primary button are the palette's `surface` with `on_surface` as the button's text, so a yellow company's button is yellow with dark text; what is written on white in the brand's colour (links, the pill, the word mark, an outline button) and the edge of every button stay `strong`. **On a phone** (B12-23): below 480 pixels the kind of message goes under the logo or the name; beside a logo the pill may wrap; a pass window that crosses midnight is shown one end under the other in smaller type; an Arabic sentence says another day's moment as «يوم الأربعاء 14 تشرين الأول الساعة 01:57», not as the list its label shows. In a client that honours the style sheet no e-mail is wider than a 320-pixel screen (measured in Chromium). Links name the company and keep every token in the fragment: the pass link and QR code `{QR_BASE_URL}/pass?c={slug}#{token}`, the reset link `{APP_BASE_URL}/reset-password?c={slug}#token={token}`, and the password-changed e-mail's link `{APP_BASE_URL}/forgot-password?c={slug}`. An outbox message of a company without a logo has no `brand-logo` image. *(Phase 13, B13-1 … B13-5)* **Light and dark**: every e-mail declares `color-scheme: light dark` and carries a dark design (the web application's dark colours, the company's palette adapted to them by the web application's rules), which mail clients that honour `prefers-color-scheme` show; the logo is never sent as stored but as opaque renditions drawn once per process: on a white plate (`cid:brand-logo`, shown by default and where a client darkens the message itself) and, for a company with a logo for dark surfaces, on the dark header's colour (`cid:brand-logo-dark`, shown by the dark design only, with the company's name beside a mark). A preview shows one design alone (`scheme`).
- Host arrival: "Your visitor {name} has arrived and checked in." — only if `notify_host_on_check_in` and the host is active; once per check-in.

## 10. Frontend

**Routes**
- Public: `/login`, `/forgot-password`, `/reset-password` (token from `#token=`), `/pass` (visitor pass from `#<token>`, lazy chunk; *(rev. 5)* it sends only the company's slug, never the token: with `?c=<slug>` it reads that company's public identity, without it no API at all). *(rev. 5)* `/c/{slug}` is a company's own sign-in page, and `?c={slug}` on the public pages names the company whose identity they show; without a company, or with a slug that names none, they are neutral (no logo, no product name). The frontend's decisions of this phase follow in `docs/decisions/phase-12-frontend.md`.
- `/change-password` (forced or voluntary).
- Employee: `/visits` (**My visits**: counts header from `/dashboard/employee`; tabs Today · Upcoming · Past · Needs attention; search), `/visits/new` (**Invite visitor**), `/visits/:id`.
- Reception: `/reception` — one screen with tabs **Scan** (default) · **Expected** (inline filter, MANUAL check-in) · **Inside** (one-tap Check out, overdue/stale flags, bulk "Check out remaining from previous days") · **Walk-in**; plus a visitor search box returning today's actionable visits.
- Shared: `/visitors` (search), `/visitors/:id` (profile + history), `/history` (company-wide read-only visit history with filters — admin, management, reception), `/inside` (evacuation list, printable, headcount + hosts — admin, management, reception).
- Admin: `/admin` (dashboard), `/admin/users`, `/admin/departments`, `/admin/settings`, `/admin/audit`.
- Management: `/reports`.
- *(rev. 4)* Admin: `/admin/email-templates` (the four kinds; edit per language with the variables, preview, test to oneself, reset).
- *(rev. 4)* Platform owner, a separate area with its own sign-in: `/platform/login`, `/platform/change-password`, `/platform` (companies), `/platform/companies/:id` (identity, activity, administrators), `/platform/audit`. It uses `GET /api/v1/platform/auth/me` to know who is signed in and the platform CSRF cookie for its unsafe requests.
- Landing by role priority: RECEPTIONIST → `/reception`, SYSTEM_ADMIN → `/admin`, EMPLOYEE → `/visits`, MANAGEMENT → `/reports`. Nav shows only allowed sections (cosmetic; backend enforces).

**Reception scanner (target < 10 s)** — a small state machine: `idle → starting → scanning → validating → result → acting → success (≈1.5 s, green check + text + optional beep/vibration) → scanning` (auto-resume, no extra tap).
- Keep the `MediaStream` open for the session; only pause decoding. Auto-start once permission was granted before. Camera picker (front/rear/desktop) with deviceId remembered in `localStorage` (try/catch). `getUserMedia({video:{facingMode:{ideal:'environment'}}})` — never `exact`.
- Preload the decoder (self-hosted wasm) when `/reception` mounts.
- De-duplication: pause decoding while a result is shown; ignore the same token for 5 s; exactly one `/reception/scan` request per detection.
- Result panel: big visitor name with **"Verify ID: <name>"** cue, company, host (+ phone), department, purpose, scheduled time, status, warnings; one primary action (Check in — or Check out for ALREADY_CHECKED_IN, styled/positioned differently and, if check-in was < 5 min ago, shown as a secondary action needing confirmation). Enter triggers the primary action. Error results show the server message plus `check_in_options` actions (Verify ID & check in / Check in anyway with reason).
- Handheld-scanner/paste input: on fine-pointer devices it is focused when nothing else has focus; on `(pointer: coarse)` devices it is a collapsed "Enter or paste pass" field (no auto-focus, so no on-screen keyboard). After a result, focus moves to the primary action; after the action, back to the input.
- Camera errors with clear messages: permission denied, no camera, camera in use (`NotReadableError`), insecure context, unsupported browser, poor-lighting hint after 8 s without a decode, invalid/expired server results.
- Lists poll every 15 s with `X-Background-Refresh: 1` and refresh after mutations.

**Invite visitor form** — defaults: host = me (*rev. 3*: an administrator may choose another active host; anyone else has no host picker and sees their own name, read-only, as the host), department = host's department, start = next half hour (company TZ), end = start + 1 h, send invitation = on. Visitor typeahead (in-scope `/visitors?q`); if the server reports `visitor_match.reused`, show "An existing visitor record was used." Success screen: "Invitation sent to <email>" (status polled every 2 s up to 30 s while PENDING) + **Copy link / Show QR / Print** using the one-time `pass_url`. Visit detail polls while PENDING; FAILED shows a clear "Invitation failed — Resend" action (with the rotation warning).

**Walk-in form** — lookup first (name/phone) to reuse a visitor; host typeahead with phone; reason quick-pick; expected end default now + 1 h; ≤ 4 inputs for a returning visitor.

**Languages** *(rev. 3)* — Arabic (the default, right to left) and English, switchable at any time.
- Which language: signed in, `user.preferred_language`, else `company.default_language`. Before sign-in: the language this device last used, else the first of the browser's languages the app speaks (`ar-*` → Arabic, `en-*` → English), else Arabic. A language chosen on the sign-in page is applied at sign-in to an account without a preference of its own and saved to it; an account's own preference always wins (F10-3, F10-24).
- The switch (ع / EN) is in the shell, on the sign-in and error pages and on the visitor's pass page. Signed in, it saves the choice with `PATCH /auth/preferences`; signed out, it is remembered on the device. `<html lang dir>` and the document title follow the language.
- Every text a person reads comes from typed catalogs in both languages (no hard-coded text, a test checks it); layouts use logical properties only, and directional icons mirror. Dates use the Levantine month names (`ar-JO`), every number Latin digits, times 24-hour. Error messages are translated by error code, a 422's field errors by field code; the server's English message is shown in English.
- The company is named by `name_ar` in the Arabic interface when it is set, else by `name`; *(rev. 3)* a department likewise by its `name_ar`, through one helper (`useDepartmentName`; a test fails on any other read of a department's `name`), and the company's address by `address_ar` in its settings. Names people type (visitors, hosts, companies, purposes) are shown as typed. The visitor's pass page follows the visitor's device and their own switch; the invitation link carries no language hint.

**Product name** *(rev. 3)* — «زوار موضوع» / "Mawdoo3 Visitors" in document titles ("<page> · Mawdoo3 Visitors"), the installed app and the lockup under the Mawdoo3 logo; the company is a tenant, named through its own settings, never through the brand. "Visitor Management" names nothing a person sees.

**Visual design** *(rev. 3; replaces the Phase 0 indigo design)* — direction C "Bold Modern" in mawdoo3.com's palette: a side-nav teal `#188086` shell (sidebar, top bar, drawer) carrying the white logo; a light content area (greys `#f1f1f1` and `#f8f8f8`, white surfaces, text in the slate family of `#33444e`); teal primary buttons, links and focus; turquoise `#27b5bb`, light turquoise `#49cbd2` and yellow `#f7b916` only as fills behind ink text, indicators and large accents (white text reads only on `#188086` and darker, 4.70:1); a dark reception tablet; the whole app dark in the device's dark colour scheme; big KPI numerals in Space Grotesk, Readex Pro for Arabic and Latin text (both self-hosted). Semantic status colours (Scheduled blue, Checked in green, Checked out grey, Cancelled red ring, No-show yellow), never colour alone (icons/text). No explanatory notes: only errors, validation, data and one short line before an irreversible action. Minimal motion (`prefers-reduced-motion`), WCAG AA (every token pair is contrast-tested), visible focus, labelled inputs, `aria-describedby` errors, `aria-live` scan results. Print stylesheets for `/inside`, the report and the pass: black on white with the ink logo.

**Supported browsers** — Chrome/Edge ≥ 111, Safari/iPadOS ≥ 16.4, Firefox ≥ 128 (Tailwind v4 baseline).

**PWA** — `manifest.webmanifest` (scope `/`), icons, service worker: precache built static assets incl. the zxing wasm; network-first for navigations; never cache `/api`; versioned cleanup; registered in production builds only.

**Security headers (nginx in prod; Vite preview for testing)** — `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`, HSTS, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. API responses: `Cache-Control: no-store`. nginx logs `$uri` (no query string).

## 11. Testing strategy

- **Backend** (pytest, real PostgreSQL): the session fixture creates a throwaway database `vms_test_<random>` as `vms_owner`, runs `alembic upgrade head` (and one test runs downgrade→upgrade), then the app connects as `vms_app`; the database is dropped at session end. Each test runs inside an outer transaction rolled back at the end (`join_transaction_mode="create_savepoint"`) by overriding `session_factory` (requests, dispatcher, security-event writer, CLI). Alembic `env.py` must not disable existing loggers (`disable_existing_loggers=False` / skip `fileConfig` when invoked programmatically). TestClient: `base_url="https://testserver"`, `client=("203.0.113.10", 50000)` (real IP, Secure cookies sent). Rate limiter reset per test; fake clock fixture. A small set of tests uses committed data on separate connections (concurrency, dispatcher-after-commit).
  - Unit: token gen/hash/parse, window computation, state machine matrix, permission predicates, password policy, search normalisation (accented + Arabic + phone digits), client IP derivation, rate limiter, email rendering (no PII in QR payload; escaping), day bounds around midnight/DST.
  - Integration: everything in §6–§9 incl. RBAC per endpoint per role, two-company isolation for every referenced ID, audit rows for success *and* failure outcomes, audit immutability as `vms_app`, concurrency (double check-in, check-in vs cancel, double resend, last-admin race), email failure → visit kept → resend works, NO_SHOW + override via fake clock.
- **Frontend** (Vitest + Testing Library): token parsing, formatting/timezone conversion (browser TZ ≠ company TZ), StatusBadge, guards, scanner state machine + de-duplication + error mapping, forms' validation and defaults.
- **E2E** (Playwright, Chromium): globalSetup recreates `vms_e2e` (drop schema → migrate → `cli seed-e2e`: two companies, all roles), starts backend + Vite on dedicated ports with `EMAIL_PROVIDER=outbox` (fresh outbox dir), `EMAIL_FAIL_DOMAIN=fail.test`, rate limits relaxed; reuses `storageState` per role. Specs: full acceptance scenario (brief §40) via the handheld/paste input; one **real camera-path** spec (the test writes a 640×480 4:2:0 Y4M of the QR with a pure-Python writer and launches Chromium itself with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=…` + camera permission) asserting exactly one scan request and scan→check-in→ready-for-next within a time budget on the tablet viewport; negatives (expired via `cli e2e-time-travel`, cancelled, invalid, rotated, unauthorized employee, already in/out, walk-in, email failure, cross-company); assertion that no request leaves the app origin. Viewports: 1440×900, 820×1180, 390×844.
- *(rev. 3)* Languages: backend tests for the e-mail catalog (both languages, the same placeholders), bidirectional isolation of values, the leading language per recipient, and SMTP against a real SMTP server (aiosmtpd); frontend tests for the catalogs (same keys, every Arabic plural form, placeholders), no hard-coded text and no physical sides in `src/`, and the contrast of every design-token pair. The E2E suite reads English (the global setup pins both companies to English); its Arabic specs use users of their own.
- Performance targets: `/reception/scan` and check-in p95 < 300 ms on seeded data (measured in the Phase 9 audit).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Docker unavailable locally | Compose/Dockerfiles written carefully, documented as unverified. |
| LAN devices need HTTPS for camera | `dev:https`, `ALLOWED_ORIGINS` doc, handheld/paste input fallback. |
| Email deliverability / blocked images | CID inline QR + pass-page link + one-time "Copy link / Show QR / Print" for the host + resend. |
| In-memory rate limiter | One worker per instance; Redis implementation documented as the scale path. |
| BackgroundTasks lost on crash | Row stays PENDING/FAILED and visible ("Needs attention"); resend; upgrade path to a worker queue documented. |
| Timezone errors | One day-bounds helper, AwareDatetime inputs, UTC sessions, browser-TZ ≠ company-TZ tests. |
| Bearer QR forwarded to someone else | "Verify ID" cue, documented that a QR proves an invitation, not identity; email change revokes. |
| Visitors who leave without checking out | Overdue/stale flags, bulk stale check-out, corrected check-out time. |
| PII retention | Retention guidance documented; visitor anonymisation is a documented future feature (needs a privileged maintenance path because of history immutability). |

## 13. Decisions on ambiguous requirements

- **D-01** "Expired" is a pass property; an unattended SCHEDULED visit becomes **NO_SHOW**. Statuses: SCHEDULED, CHECKED_IN, CHECKED_OUT, CANCELLED, NO_SHOW.
- **D-02** *(revised in rev. 3, B10-24)* An invitation is made in the inviter's own name: only an administrator picks another active host (the user's request of 2026-10-08); creator **and** host own the visit. Default host = self. Walk-ins name any active host.
- **D-03** User email is globally unique; duplicate (incl. other tenant) → generic `USER_EMAIL_UNAVAILABLE`.
- **D-04** Multiple roles per user; permissions are the union.
- **D-05** Visitor dedupe by email within a company (`INSERT … ON CONFLICT (company_id, email) DO NOTHING` then select). Reuse never overwrites; only empty fields are filled, and only when the visitor is in the caller's scope.
- **D-06** Employees see visitors linked to their own visits; history filtered to their own visits.
- **D-07** Walk-ins are created and checked in in one step by reception (reason quick-pick, host required). Email optional.
- **D-08** *(revised)* Same-day early/late/no-show arrivals: reception may **check in anyway (OVERRIDE, reason required)** on the existing visit; inside the window but outside the scheduled time → allowed with a warning; other days → walk-in.
- **D-09** No re-entry after check-out; a new walk-in is required.
- **D-10** *(revised)* The raw token is never stored. **Resend rotates** the pass (old QR stops working; UI warns). **Reschedule keeps** the pass (window updated). A revoked-by-rotation pass presented in-window can be handled by MANUAL check-in after an ID check.
- **D-11** Admin-created users get a temporary password (expires in 72 h) and must change it at first login.
- **D-12** Visitors and visits are never deleted; users/departments are deactivated.
- **D-13** Audit logs readable by SYSTEM_ADMIN only.
- **D-14** Visit ≤ 24 h, not in the past (5-min tolerance), ≤ 365 days ahead.
- **D-15** Company timezone seeded from `SEED_COMPANY_TIMEZONE` (default `Asia/Amman`); admin-editable; changing it does not rewrite stored UTC instants (no stored local dates exist).
- **D-16** *(revised)* A visitor email is required only when `send_invitation` is true. A pass is always created; its link is shown once to the host.
- **D-17** Visits snapshot visitor name/company, host name and department name; history shows the facts as of the visit (frozen at check-in).
- **D-18** Deactivating a host (or removing their host roles) cancels their SCHEDULED hosted visits and notifies the visitors.
- **D-19** Changing a visitor's email revokes active passes of their SCHEDULED visits (`VISITOR_EMAIL_CHANGED`) and automatically re-sends invitations to the new address.
- **D-20** No public pass-status endpoint; `/pass` is fully static (no token oracle, no PII). *(rev. 5)* Still no pass-status endpoint and no token oracle: the pass page may read the public identity of the company named in the link's query (its name, language and brand, which the company's sign-in link shows to anyone), and sends the server that slug only, never the token (B12-9, B12-14).
- **D-21** No `retry-emails` CLI; invitation retry is the user-facing resend.
- **D-22** Reschedule sends a `VISIT_RESCHEDULED` email (no QR) — the existing QR stays valid.
- **D-23** Employee dashboard = counts + today list; lists live on the My visits page (`GET /visits`).
- **D-24** No CSV export in the MVP (documented future work).
- **D-25** Company-wide read-only history (`/history`) and evacuation list (`/inside`) for admin, management and reception.
- **D-26** Staff phone (`users.phone`, optional) is shown to reception for contacting hosts.
- **D-27** *(rev. 4)* The platform owner is a separate principal (own tables, sessions, cookies, CSRF token and audit trail), created only from the command line, never a tenant user (B11-1, B11-3).
- **D-28** *(rev. 4)* The platform owner sees companies, two counts and each company's administrators, never its visitors, visits or audit rows; companies are deactivated, never deleted (B11-2, B11-10, B11-13).
- **D-29** *(rev. 4)* A company edits the words of its four visit e-mails within fixed layouts; the security e-mails keep the product's words (B11-20, B11-21).
- **D-30** *(rev. 5)* Every company shows its own identity (logo, dark-surface logo, icon, one colour) to its staff and visitors; the product's name and the Mawdoo3 logo stay in the platform owner's area (B12-12). *(rev. 5, UX review, B12-22)* No e-mail to a company's people shows them: the notice of a platform action is the company's own e-mail, and only the command line's test e-mail is the product's.
- **D-31** *(rev. 5)* Only the platform owner sets a company's identity; images are PNG only, checked and written again by the server without an image library; the shades are derived from one colour by the server, with contrast guaranteed for every colour (B12-2, B12-4, B12-7).
- **D-32** *(rev. 5)* A company's name, language and brand are public for active companies, by slug; nothing else is, unknown and deactivated companies are indistinguishable, and links carry the slug in the query and every token in the fragment (B12-9, B12-14).

## 14. Decision log

Implementation agents write deviations to `docs/decisions/phase-<n>-<area>.md` (date, decision, reason). Those files are the authoritative decision log; this section indexes them.

- **Phase 1** (2026-10-05): `docs/decisions/phase-1-backend.md` (B1-1 … B1-66) and `docs/decisions/phase-1-frontend.md`. Notable: `visits.invitation_requested` column (needed for "needs attention"); audit_logs has no FKs (an audit write can never fail); failure audits written by the error handler after rollback; RATE_LIMITED/CSRF_FAILED audit rows are coalesced per window with counts (flood protection); login/change-password lock the user row (credential races); per-scope caps on rate-limit buckets + IPv6 /48 secondary limits; `vms_app` has no TEMPORARY privilege; base URLs must be bare origins; shared pass-token grammar in `docs/contract/pass-token-vectors.json` tested by both suites; backend-owned contract snapshot (`python -m app.contract`) with a staleness test; TypeScript ~6.0 + oxlint; react-router 8 data mode.
- **Phases 2–4** (visitors, visits, passes, e-mail): `docs/decisions/phase-2-4-backend.md` and `docs/decisions/phase-2-4-frontend.md`.
- **Phases 5–7** (reception, scanner, check-in/out, walk-ins, search, dashboards, reports): `docs/decisions/phase-5-7-backend.md` and the frontend files `phase-5-7-frontend.md`, `-admin`, `-employee`, `-reception` and `-round2`.
- **Phase 8** (security audit; report in `docs/security-audit.md`): `docs/decisions/phase-8-backend.md` and `docs/decisions/phase-8-frontend.md`.
- **Phase 9** (E2E, deployment, production readiness; report in `docs/production-readiness.md`): `docs/decisions/phase-9-backend.md` (including RT-01, the routed-reads test), `docs/decisions/phase-9-frontend.md` (F9-1 … F9-12), `docs/decisions/phase-9-e2e.md` and `docs/decisions/phase-9-deploy.md` (D9-34 … D9-37: the four-process API layout, the raw-path routing map and the read-services settings guard). The four-process layout supersedes the single-process rule of §3 and §12 for read traffic only. Every budget except the per-user API budget is still counted in exactly one main process (`docs/security-audit.md`, the R-1 Phase 9 closure note).
- **Phase 10** (2026-10-07 and 08: product name and brand, Arabic and English, direction C, SMTP delivery; revision 3 of this contract): `docs/decisions/phase-10-backend.md` (S10-1 … S10-13: the SMTP provider, `send-test-email` and the review fixes; B10-1 … B10-23: migration 0011, the preferences endpoint, bilingual e-mail with the logo, the brand and product name settings, the per-field error codes, the Arabic demo seed; B10-24 … B10-28: the host rule, migration 0012 and the departments and address in both languages) and `docs/decisions/phase-10-frontend.md` (F10-1 … F10-33: i18n, the brand, the design tokens, the shell and the kit; then the areas F10-reception-1 … 12, F10-visits-1 … 9, F10-visitors-1, F10-analytics-1 … 7 and F10-admin-1 … 8; F10-integration-1 … 7, F10-rf-1 … 12, F10-final-1 and 2, F10-gap-1 … 8; F10-dept-1 … 7: the invite form's host, the department names by language). Their integration notes (2026-10-08) close each file. Notable: the product is «زوار موضوع» / "Mawdoo3 Visitors" and the demo tenant «موضوع» / Mawdoo3; the language follows the account, else the company, else the device; e-mails are bilingual, visitor e-mails led by the company's language; a language change is not audited (B10-4); 422 field errors carry codes (B10-18); `seed-demo` names its people in Arabic and its departments and address in both languages, and `seed-e2e` is English (B10-20, B10-27); the E2E suite pins both companies to English (F10-12, F10-18); only an administrator invites on behalf of another host (B10-24).

- **Phase 11** (2026-10-12: the platform owner and a company's own e-mail texts; revision 4 of this contract): `docs/decisions/phase-11-backend.md` (B11-1 … B11-13 the platform owner, B11-20 … B11-31 the e-mail texts, B11-32 and B11-33 the migration and the gates). The frontend's decisions follow in their own file.
- **Phase 12** (2026-10-13: a company's own identity; revision 5 of this contract): `docs/decisions/phase-12-backend.md` (B12-1 storage and migration 0015, B12-2 and B12-3 the PNG check and the image limits, B12-4 and B12-5 the palette, B12-6 … B12-8 the platform owner's endpoints, B12-9 … B12-11 the public endpoints, the manifest and `Me`, B12-12 … B12-14 e-mail identity, the sender and the links, B12-15 the seeds, B12-16 and B12-17 the deployment and the settings; after the security review B12-18 … B12-20; after the UX review of 2026-10-14 B12-21 the surface roles, B12-22 the notice in the company's identity, B12-23 e-mails on a phone and the Arabic window, B12-24 subjects, B12-25 the test prefix and the manifest's short name, B12-26 templates that a process started before the change can still render). The frontend's decisions follow in `docs/decisions/phase-12-frontend.md`.

## 15. Implementation plan

| Phase | Scope | Orchestration |
|---|---|---|
| 0 | Environment + this contract + independent 4-lens design review (done) | inline + review workflow |
| 1 | Backend foundation: config, DB, **full schema migration**, roles/grants, auth/sessions/CSRF/RBAC, client IP, rate limits, middleware, errors, logging, audit (incl. security events), email base (outbox/memory, password reset), users/departments/company settings, seed CLI, test harness. Frontend foundation: Vite/React/TS ~6/Tailwind v4/react-router 8/TanStack Query, **all FE dependencies**, UI kit, `types/api.ts` for the whole contract, API client, auth pages, layout, guards, `/pass`, PWA shell. | backend builder ∥ frontend builder → gate verify/fix loop |
| 2–4 | Visitors (search normalisation), visits (state machine, locking, NO_SHOW, reschedule, cancel), passes, email (Resend provider, all templates, dispatcher retries), employee UI (My visits, Invite, Visit detail), visitor profile UI | backend builder ∥ frontend builder → gate verify/fix loop |
| 5–7 | Reception (scan, check-in/out incl. override/corrected/bulk, today, inside, walk-in), history page, evacuation list, admin UI (users, departments, settings, audit), dashboards, reports | backend builder ∥ frontend builder (single FE builder) → gate verify/fix loop |
| 8 | Security audit: multi-lens find → adversarial verify → fix → `docs/security-audit.md` | review workflow |
| 9 | E2E (Playwright incl. camera path), responsive checks, performance check, docs, `docs/production-readiness.md`, final report | workflow |
| 10 | Product name and Mawdoo3 brand, Arabic and English with right to left, direction C in mawdoo3.com's palette, bilingual e-mail with the logo, SMTP delivery, per-field error codes, Arabic demo seed; no explanatory notes in the UI | foundation (backend ∥ frontend) → feature areas → integration → review fixes → verification (gates, Arabic acceptance) |
| 11 | The platform owner (companies, administrators, deactivation, its own sign-in and audit trail) and a company's own e-mail texts (edit, preview, test), revision `0013` | backend (contract, migration, API, tests) → frontend from the backend's hand-over |
| 12 | A company's own identity: logo, icon and colour set by the platform owner, the derived palette, the public identity endpoints and manifest, per-company e-mails and links, the platform owner's editing of e-mail texts, revision `0015` | backend ∥ frontend from one shared contract → integration → gates |

**Deliverable ownership** (so nothing falls through):
- Phases 2–4 must wire the Phase 1 hand-over hooks: the D-18 `HostedVisitCanceller` (replacing the Phase 1 no-op, tripwire test B1-42), the D-17 `VisitSnapshotRefresher` (department rename / user name change), the scanner-input classification helper (malformed input → `PASS_INVALID` + audit), `cli mark-no-shows` and `cli e2e-time-travel`.
- Every backend schema change regenerates the shared contract snapshot (`npm run contract:snapshot`, backend-owned dump + staleness test).
- Phase 9 delivers: `backend/Dockerfile` (run with `--no-server-header --no-access-log`, single worker), `frontend/Dockerfile` + nginx config (§10 headers, SPA fallback, `application/wasm`, no-cache for `sw.js`, `server_tokens off`, `$uri` logs, `X-Forwarded-For $remote_addr`), `docker-compose.yml` (Postgres with matching locale/roles), root `README.md`, `docs/architecture.md`, `docs/security.md`, `docs/api.md`, `docs/development.md`.
