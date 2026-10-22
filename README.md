# Mawdoo3 Visitors | زوار موضوع

Mawdoo3 Visitors («زوار موضوع» in Arabic) is a visitor-pass system for organisations that control who
enters their buildings: banks, corporates, hospitals and government offices. Employees invite visitors,
and each visitor receives a QR pass by e-mail. Reception scans the pass on a tablet, checks the visitor
in and out, and keeps a live list of who is inside. Every action ends up in a searchable history and an
append-only audit trail. The interface and the e-mails are in Arabic (the default, right to left) and
English. Every company shows **its own identity** to its staff and visitors (its logo, its colour, its
name as the sender of its e-mails), set by the platform owner; the product's own name and the Mawdoo3
logo appear only in the platform owner's area ([§1.5](#15-a-companys-own-identity)).

- **Backend:** FastAPI on Python 3.14, SQLAlchemy 2 (sync) and psycopg 3, PostgreSQL 18 (`backend/`).
- **Frontend:** React 19 + TypeScript single-page app in Arabic and English, installable as a PWA
  (`frontend/`).
- **Deployment:** Dockerfiles, nginx and Docker Compose (`deploy/`, `docker-compose.yml`).

The binding design contract is [docs/initial-assessment.md](docs/initial-assessment.md). Every deviation
from it, with the reason, is recorded in [docs/decisions/](docs/decisions/). This README describes the
system as implemented. For working on the code, see [docs/development.md](docs/development.md). For the
design in depth, see [docs/architecture.md](docs/architecture.md), and for the HTTP API,
[docs/api.md](docs/api.md).

> **What was verified on the reference machine (Windows 11, 2026-10-06; Phase 10 on 2026-10-07 and
> 08).** The Windows commands in this README were run there, against throwaway clusters, databases,
> folders and ports, so that the developers' own `vms` database and ports 8000 and 5173 were left alone.
> The Linux commands and everything that needs Docker were **not** run there: Docker is not installed on
> that machine. Each such section says so. [Verification status](#15-verification-status) lists exactly
> what was run.

## Contents

1. [What the system does](#1-what-the-system-does)
2. [Architecture overview](#2-architecture-overview)
3. [Requirements](#3-requirements)
4. [Quick start](#4-quick-start)
5. [Environment variables](#5-environment-variables)
6. [Database setup and migrations](#6-database-setup-and-migrations)
7. [Running the backend and frontend](#7-running-the-backend-and-frontend)
8. [Running the tests](#8-running-the-tests)
9. [Docker setup](#9-docker-setup)
10. [E-mail provider configuration](#10-e-mail-provider-configuration)
11. [Demo users](#11-demo-users)
12. [Security considerations](#12-security-considerations)
13. [Deployment considerations](#13-deployment-considerations)
14. [Documentation map](#14-documentation-map)
15. [Verification status](#15-verification-status)

---

## 1. What the system does

### 1.1 The visit flow

1. **An employee invites a visitor** (*Invite visitor*, `/visits/new`). The employee picks or enters
   the visitor, the department, the purpose and the time; the invitation is in their own name (they are
   the host, shown read-only). Only an administrator may choose another host and invite on someone's
   behalf. The time is entered in the company's time zone, whatever the device's zone is.
2. **The system issues a pass.** Every visit gets a pass: a random 256-bit token. Only its SHA-256
   hash is stored. The pass is valid during the visit's *window*: the scheduled time widened by the
   company's grace periods (60 minutes before and after by default).
3. **The visitor receives an invitation e-mail,** in Arabic and English (the company's language
   first), under the company's own logo (or its name; [§1.5](#15-a-companys-own-identity)). It contains
   the date and time with the time-zone label, the check-in window, the host, the department, the purpose,
   an inline QR code and a link to the pass page (`/pass?c=<company>#<token>`). The token travels in the
   URL fragment, so it never reaches a server log. The pass page draws the QR code in the browser and
   sends the server only the company's name in the link (to show that company's logo and colours), never
   the token. The host sees the same pass
   link **once**, right after creating the visit (*Copy link*, *Show QR code*, *Print pass*), in case
   the e-mail does not arrive. A short second e-mail follows the invitation with the visit for the
   visitor's calendar (Google Calendar, Outlook, Apple Calendar), and the host gets one with the visit for
   theirs; a new time moves both entries and a cancellation removes them. No calendar entry holds the
   pass link ([§10](#10-e-mail-provider-configuration), Phase 14).
4. **Reception scans the pass** (`/reception`, *Scan* tab). The tablet camera, a handheld scanner or a
   pasted link all work. The server validates the pass and answers *ready*, *already checked in*,
   *expired*, *not yet valid*, *replaced*, *cancelled*, *completed*, *host no longer active* or
   *invalid*. Each answer comes with the actions reception may take, such as a manual check-in after
   an ID check, or a check-in with a reason on the same day.
5. **Check-in.** The result panel shows *Verify ID: <name>* with the visitor's company, host,
   department and purpose. One tap checks the visitor in, and the host gets an e-mail (*Your visitor …
   has arrived*) unless the company switched it off. The scanner is ready for the next visitor without
   another tap. Walk-ins without an invitation are registered and checked in in one step (*Walk-in*
   tab).
6. **Inside and evacuation.** The *Inside* tab and the printable evacuation list (`/inside`) show
   everyone checked in, with a headcount, hosts and phone numbers. Overdue visitors and visitors left
   from previous days are flagged. Those left from previous days can be checked out in bulk, with a
   reason.
7. **Check-out.** Reception checks the visitor out by scanning the pass again or from the list. A
   visitor who left without checking out can be checked out with the actual time and a note (a
   *corrected* check-out). The pass is revoked at check-out.
8. **History.** Each visitor's profile holds their visit history. Administrators, management and
   reception can search a company-wide history (`/history`). Management and administrators see reports
   (`/reports`); administrators see the audit log (`/admin/audit`). Visits and visitors are never
   deleted.

A visit nobody attended becomes **NO_SHOW** once its window has ended. Reception can still check such a
visitor in on the same company-local day, with a reason (an *override*).

| Status | Meaning | Next possible status |
|---|---|---|
| `SCHEDULED` | Invited, not yet arrived | `CHECKED_IN`, `CANCELLED`, `NO_SHOW` |
| `CHECKED_IN` | On site | `CHECKED_OUT` |
| `CHECKED_OUT` | Visit completed (final) | none |
| `CANCELLED` | Cancelled by the visit's host or creator or by an administrator, or because the host was deactivated (final) | none |
| `NO_SHOW` | The pass window ended without a check-in | `CHECKED_IN` (override, same day only) |

### 1.2 Roles

A user holds one or more roles, and a permission is granted when any of the user's roles grants it. The
server enforces every permission. The navigation only hides what a user cannot open.

| Role | Shown as (English / Arabic) | What it is for | Main pages | Lands on |
|---|---|---|---|---|
| `EMPLOYEE` | Employee / «موظف» | Hosts visitors: invites in **their own** name only (they are the host), and reschedules, cancels and resends invitations for their own visits (as host or creator) | My visits, Invite visitor, Visitors (own scope) | `/visits` |
| `RECEPTIONIST` | Reception / «موظف استقبال» | Front desk: scans passes, checks visitors in and out, registers walk-ins, keeps the inside list | Reception, Visitors, History, Inside now | `/reception` |
| `MANAGEMENT` | Management / «الإدارة العليا» | Read-only oversight | Reports, History, Inside now, Visitors | `/reports` |
| `SYSTEM_ADMIN` | Administrator / «مدير النظام» | Everything above for the whole company, plus users, departments, company settings and the audit log; the only role that may invite on behalf of another host (it chooses the host on *Invite visitor*) | Admin dashboard, Users, Departments, Settings, Audit log | `/admin` |

The Arabic names above are a role beside one person (the account menu, the users list). Where people are
counted or filtered by role, Arabic names the team: «الموظفون», «الاستقبال», «الإدارة العليا», «إدارة النظام».

**The platform owner** (Phase 11) is not a role and not a user of any company. It is a separate account,
created only from the command line (`create-platform-admin`, [§7.1](#71-backend)), that signs in at
`/platform/login` with its own session and audit trail. It lists companies with two counts (active users,
visits in the last 30 days), creates a company with its first administrator, renames it, deactivates and
reactivates it (a deactivated company's users cannot sign in, their sessions end and its passes are
refused; a user who types the right password is told "This company is deactivated."), adds an
administrator and sends one a password-reset link. It never sees a company's visitors, visits or audit
log; what it does to a company appears in that company's audit log, where it is named "Platform owner" /
«مالك المنصة», and when it adds an administrator to a company or sends one a reset link, the company's
other administrators are told by e-mail ([phase-11-backend.md](docs/decisions/phase-11-backend.md)).

In the web application the platform owner's area is `/platform/…`, apart from every company's pages: sign in
at `/platform/login`, then **Companies** (`/platform/companies`: search, state, counts, *Add company*), a
company's page (its identity, *Edit*, *Deactivate* / *Reactivate*, its administrators, *Add administrator*,
*Send reset link*) and the platform's **Audit log** (`/platform/audit`). Its shell is the deep teal with the
label "Platform" / «المنصة» beside the product's name. A company user who opens `/platform/…` sees the
platform sign-in, and the platform owner who opens a company page sees the company sign-in: the two sessions
are separate and a browser may hold both ([phase-11-frontend.md](docs/decisions/phase-11-frontend.md)).

**E-mail texts** (Phase 11): an administrator can change, in Arabic and English, the words of the four visit
e-mails (invitation, rescheduled, cancelled, visitor arrived): the subject, heading, greeting, first
paragraph, the invitation's button, and an extra closing paragraph and footer line, with variables such as
`{visitor_name}`, `{company}`, `{host_name}`, `{date}` and `{time}`. The layout, logo, QR code, visit
details, pass link and security lines stay fixed, and the password e-mails cannot be edited. Each kind has a
preview with sample data and a test e-mail to the administrator's own address. In the web application:
**Administration → E-mail texts** (`/admin/email-templates`), then one e-mail's editor with both languages
side by side, the variables as chips, the draft's preview and the saved e-mail as it will arrive. The
platform owner can edit each company's texts as well, from the platform area (Phase 12); a test e-mail then
goes to the platform owner's own address.

A user with several roles lands on the first page of this order: reception, admin, My visits, reports.
The full permission matrix is §7.5 of the [contract](docs/initial-assessment.md). Every company is a
separate tenant. A user only ever sees their own company's data, and the database backs this with
composite tenant foreign keys.

### 1.3 Languages and right to left

The whole product is in **Arabic** and **English**. Arabic is the default and is laid out right to left:
the sidebar is on the right, tables and forms read from the right, directional icons and charts are
mirrored. Data keeps its own direction inside the other language (an English purpose in an Arabic list,
an Arabic name in an English e-mail).

- **Switching.** The language button shows the other language: «ع» in English, **EN** in Arabic. It is in
  the sidebar on a desktop, in the top bar on a tablet or phone, on the sign-in and error pages, and on the
  visitor's pass page. The switch is immediate. Signed in, it is saved to your account
  (`PATCH /api/v1/auth/preferences`) and follows you to other devices; signed out, the device remembers it.
- **Which language you see.** Signed in: your own choice, else your company's default language (company
  settings, Arabic for a new company). Before sign-in: the language this device last used, else the
  browser's language if it is Arabic or English, else Arabic. A language chosen on the sign-in page is
  kept at sign-in and saved for an account that has no choice of its own.
- **Company settings** hold the company's **Arabic name** and **Arabic address** (shown in the Arabic
  interface and the Arabic part of every e-mail; the English one is used when it is empty) and its
  **default language**.
- **Departments** have a name (the English or only one) and an optional **Arabic name**
  (*Administration → Departments*). The Arabic interface and the Arabic part of an e-mail show the Arabic
  name when there is one; the English interface and the English part show the name. Names people type
  (visitors, staff, companies, purposes) are shown as typed.
- **Dates and numbers.** Arabic dates use the Levantine month names («تشرين الأول»); every number,
  time, code and phone number uses Latin digits, 24-hour times, in the company's time zone.
- **E-mails** are bilingual: visitor e-mails lead with the company's language and name both languages in
  the subject; e-mails to staff (a visitor's arrival, password reset and change) lead with the
  recipient's language ([§10](#10-e-mail-provider-configuration)).
- **Errors.** In English the API's own message is shown; in Arabic the message for its error code, and a
  form's field errors through their field codes ([docs/api.md](docs/api.md) §4.4).

### 1.4 Brand and design

The product is **Mawdoo3 Visitors** («زوار موضوع»): in the platform owner's area the browser tab, the
installed app and the lockup under the Mawdoo3 logo say so (since Phase 12 a company's own pages show the
company's identity instead, [§1.5](#15-a-companys-own-identity)). The design is direction C ("Bold Modern") in mawdoo3.com's colours: a teal
`#188086` sidebar with the white logo, a light content area with slate text, turquoise `#27b5bb` and
yellow `#f7b916` accents behind dark text, big KPI numerals, and a dark reception tablet. Each device
has its **appearance**: the device's own colour scheme, followed live, until the person presses the
appearance toggle, «الوضع الداكن» / "Dark mode" (a sun or a moon beside the language switch, on the
signed-out pages, the visitor's pass and in both shells); a press keeps the other scheme, light or dark
(Phase 13, [phase-13-frontend.md](docs/decisions/phase-13-frontend.md)). The choice is kept on the
device, for every company and the platform owner's area; a page is drawn in it from its first frame. The
reception screen is dark until a choice, as it always was, and follows an explicit light or dark. Screens carry no explanatory notes: only errors,
validation, data, and one short line before an irreversible action. Every colour pair is
contrast-tested to WCAG AA ([docs/development.md](docs/development.md) §2.5).

### 1.5 A company's own identity

Since Phase 12 every company (tenant) has an identity of its own, and its staff and visitors never see
the product's name or the Mawdoo3 logo ([phase-12-backend.md](docs/decisions/phase-12-backend.md)):

| What | Where it shows |
|---|---|
| **Logo** (for light surfaces), **logo for dark surfaces**, a square **icon** | The application's shell and sign-in page, the visitor's pass page, the browser tab and the installed app, the header of every e-mail of the company (an opaque copy of the logo on a white plate; the logo for dark surfaces in the e-mail's dark design, [§10](#10-e-mail-provider-configuration)). A company without a logo is shown by its **name** as a word mark, never by another logo |
| **One colour** | The application's shell and buttons and the e-mails' bar and button are **that colour itself** wherever white or dark text reads on it: a yellow company is yellow, with dark text (a mid-tone on which neither reads is shown a little darker). Nobody chooses shades: the server derives the rest of the palette from the colour (the darker step for text and links on white, tints, the dark pass card) so that text stays readable **whatever was chosen** (a grey, black, white, yellow, a neon colour). A company without a colour has the product's teal |
| **The company's name** | The sender's display name of its e-mails (the address stays the deployment's `EMAIL_FROM` address) and "Sent by <company>." in their footer; the name under the installed app's icon is a short form of it (at most 12 characters) |
| **Its own sign-in link** | `https://<host>/c/<slug>` shows the company's identity before anyone signs in; the general `/login` is neutral. Pass and reset links carry the company too: `/pass?c=<slug>#<token>`, `/reset-password?c=<slug>#token=…` (older links without `c` keep working, on a neutral page) |

**Only the platform owner sets a company's identity.** A company's own administrator cannot change the
logo, icon or colour (they still edit the company's e-mail texts and settings). Each change is recorded in
the platform's audit log and in the company's, naming what changed and never the image.

**How the platform owner brands a company.** In the web application: sign in at `/platform/login`, open
**Companies**, open the company, and go to its identity page (`/platform/companies/<id>/identity`: the
logo, the dark-surface logo, the icon, and the colour with a live preview of the palette). The company's
e-mail texts are next to it (`/platform/companies/<id>/email-templates`). The browser prepares each image
(it converts and resizes the chosen file to a PNG), and the server checks every upload again and stores
its own rewritten copy. With the API directly (Git Bash; `$BASE` is the origin, `$JAR` a cookie
file):

```bash
# 1. Sign in as the platform owner and read the CSRF token (docs/api.md §3 shows the pattern).
curl -sS -c "$JAR" -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -d '{"email":"platform@demo.local","password":"Demo-Visitor-2026"}' "$BASE/api/v1/platform/auth/login"
CSRF=$(awk '$6 ~ /platform_csrf/ {print $7}' "$JAR")
# 2. Find the company.
curl -sS -b "$JAR" "$BASE/api/v1/platform/companies?q=other"            # -> items[].id, items[].brand
# 3. Upload its images: the body is the PNG itself. logo, logo_dark: 32-1200 x 32-600 px; icon: square, 192-512 px.
curl -sS -b "$JAR" -X PUT "$BASE/api/v1/platform/companies/$COMPANY/brand/assets/logo" \
  -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: image/png' --data-binary @logo.png
curl -sS -b "$JAR" -X PUT "$BASE/api/v1/platform/companies/$COMPANY/brand/assets/icon" \
  -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: image/png' --data-binary @icon.png
# 4. Preview a colour's palette (nothing is saved), then set it. A colour is #rrggbb in lower case.
curl -sS -b "$JAR" -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"color":"#7c3aed"}' "$BASE/api/v1/platform/brand/palette"
curl -sS -b "$JAR" -X PATCH -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"color":"#7c3aed"}' "$BASE/api/v1/platform/companies/$COMPANY/brand"
# 5. What everyone now sees, without signing in:
curl -sS "$BASE/api/v1/public/companies/other-corp/brand"
```

To undo: `DELETE …/brand/assets/<kind>` removes an image, and `{"color": null}` returns to the product's
palette. Limits and answers: a file is a PNG of at most 512 KiB; interlaced and animated PNGs, damaged
files and anything with data after the image's end are refused with a field error on `file`; other media
types answer 415 and larger files 413 ([docs/api.md](docs/api.md) §10.12). The seeds give the demo company
(`demo-company`) the Mawdoo3 identity as a tenant's own; "Other Corp" (`seed-e2e`) has none, so both kinds
can be seen.

### 1.6 Visitor Journey (off by default)

Phase 15. An optional integration with an external tracking provider
(`TRACKING_PROVIDER`, `disabled` everywhere unless configured, and production's value) would record the
**floor and zone** where a checked-in, enrolled visitor was observed. Those observations are **personal
movement data**, with their own retention (`journey_retention_days`, 1–90 days, pruned by
`python -m app.cli prune-journeys`) and access rules (administrators, management and reception; not hosts).
The provider processes camera images **on its side, under its own policy**; the application only sends it a
random reference and a camera ID. It keeps only the observations of an association the provider has
activated; everything else the provider sends (unknown references or cameras, sightings of an enrollment
that never took) is counted and dropped, never stored. No real provider is connected: the adapter is **BLOCKED BY ENVIRONMENT**
([docs/visitor-tracking-model-assessment.md](docs/visitor-tracking-model-assessment.md)), and only a
development simulator exists, always marked Simulated. Real use requires the privacy owner's approval and an
evaluation-based confidence threshold ([docs/production-readiness.md](docs/production-readiness.md) §15 J).
Design: [docs/visitor-journey-design.md](docs/visitor-journey-design.md); provider contract:
[docs/visitor-tracking-integration.md](docs/visitor-tracking-integration.md).

The registry (buildings, floors, zones, cameras), the per-visit tracking association and its lifecycle (a
check-out, a revoke or its expiry ends it), the authenticated ingestion endpoint and the journey views exist;
with the provider `disabled` every journey shows the Disabled state and the registry stays editable.

**Allowed areas and area alerts (Phase 16).** Each zone is COMMON, STANDARD or RESTRICTED; each visit has
**allowed areas** (floors and extra zones), set when it is created (the request's, else its department's
floor) and changed by reception, an administrator or its host. When the journey's own confirmed location is
outside them (or in a restricted zone), a **tracking alert** opens: shown to administrators, management and
reception, acknowledged and resolved by reception and administrators, resolved by itself when the visitor
returns, at check-out or when the areas change, and **e-mailed** (on its opening and escalation only) to the
addresses the company chooses and to the visit's host; in the application, staff who read alerts are told of a
new one by a count in the navigation, a toast and a short sound (and, if they turn it on, the browser's
notification). A **live map** shows everyone inside on their building's floors and zones, and a journey shows
the visitor's **path**. Everything still comes only from a
connected provider: with none, there are no locations and no alerts
([docs/visitor-journey-design.md](docs/visitor-journey-design.md) §9).

### 1.7 Not included

These are documented as future work in the contract and are not implemented: CSV export (D-24),
anonymisation of visitor personal data (§12), and a shared rate limiter (Redis) that would allow
several API workers or instances to share all traffic (§3).

Outside the product's scope, and not planned: SMS or WhatsApp notifications, billing and AI features.
The product collects no national ID numbers, and a QR code never carries personal data: it holds only the
pass link. **It stores no photos and no biometric templates**: no image, crop, embedding or template of a
person is received, stored or logged, anywhere.

---

## 2. Architecture overview

```
Browser (React SPA, PWA)  ── same origin: /api/v1/* ──┐   dev: Vite dev server proxy (port 5173)
                                                      │   prod: nginx (TLS, security headers, SPA, proxy)
                                                      ▼
FastAPI (python -m app.serve, one worker per process; Compose runs four processes, §13)
   routes → services → repositories → SQLAlchemy 2 (sync, psycopg 3) → PostgreSQL 18
   ├─ security: Argon2id, server-side sessions, CSRF + Origin middleware, RBAC by capability,
   │            tenant scoping, in-memory rate limits
   ├─ passes:   opaque random tokens (SHA-256 at rest), QR codes (segno PNG in e-mail, qrcode in the SPA)
   ├─ e-mail:   email_messages table + delivery after the response → provider: Resend | SMTP | outbox | memory
   └─ audit:    append-only audit_logs (trigger blocks UPDATE/DELETE/TRUNCATE; runtime role has
                INSERT/SELECT only)
```

| Part | Implementation |
|---|---|
| API | FastAPI 0.142, Pydantic 2. One app factory (`backend/app/main.py`); the routes live in `backend/app/api/routes/`. |
| Run command | `python -m app.serve` is the only supported way to start the API, in development, E2E runs and the container. It fixes the server options: one worker, no `Server` header, the app's own JSON access log without query strings, no WebSocket handling, uvicorn's proxy-header handling off, and a 20 s graceful shutdown. |
| Database | PostgreSQL 18 with `pg_trgm` (visitor and history search). The `vms_owner` role owns the schema and runs migrations. The API connects as `vms_app`, which may insert, read and update rows, but cannot delete them, change audit rows or run DDL. |
| Migrations | Alembic, 11 revisions (`backend/alembic/versions/`), always run as the schema owner. |
| Sessions | Server-side sessions behind an opaque cookie, so revocation is immediate. A CSRF token is required on every authenticated unsafe request. There is no CORS: the browser reaches the API on the same origin. |
| E-mail | Rendered with Jinja2 (autoescape on) from one Arabic and English catalog, with the logo and the QR code inline, and delivered after the HTTP response in worker threads of their own: up to `EMAIL_DELIVERY_CONCURRENCY` at a time, at most 3 attempts within 20 s per message. A failed invitation never fails the visit. It shows under *Needs attention* and can be resent. |
| Frontend | React 19, TypeScript ~6.0, Vite 8, react-router 8 (data mode), TanStack Query, Tailwind CSS v4, i18next with type-checked catalogs in Arabic and English. QR scanning uses the browser's `BarcodeDetector` where it is available, otherwise a self-hosted zxing WebAssembly decoder. Fonts (Readex Pro, Space Grotesk) are self-hosted; no third-party request is made at run time. |
| Production | nginx serves the built SPA with the security headers (CSP, HSTS, Permissions-Policy), terminates TLS and proxies `/api/` to the API, sharing the requests out over the API services by method and path. Docker Compose runs PostgreSQL, a one-shot migration, the API as four processes (a main instance, two reception-list replicas and a reports instance) and nginx (§9). |

**Supported browsers:** Chrome and Edge 111+, Safari and iPadOS 16.4+, Firefox 128+ (the Tailwind v4
baseline). The automated E2E suite runs Chromium only.

**Capacity:** one worker per API process, because the rate limiter lives in its memory. Compose runs
four processes: `backend` (every sign-in and write, exactly one process), two `backend-reception`
replicas for the reception lists that every open reception page polls, and `backend-reports` for
reports, the audit log and history. Two list replicas were measured up to about 180 open reception
pages on a quiet host and about 90 under heavy CPU load; add replicas beyond that
([deploy/README.md](deploy/README.md) §4).

---

## 3. Requirements

| | Development on Windows (verified) | Development on Linux or macOS (not verified) | Production with Docker (not verified) |
|---|---|---|---|
| OS | Windows 10/11 with Windows PowerShell 5.1 | Any OS with the tools below | Linux host |
| Python | **3.14** (3.14.6 used); `requires-python = ">=3.14"` | 3.14 | in the image (3.14.8) |
| Node.js / npm | Node 24 (24.19 used; `engines` requires ≥ 22.22.0), npm 11 | the same | in the build image (Node 24.21) |
| PostgreSQL | 18.6, portable, managed by `scripts/db.ps1` (no installer, no Windows service, no admin rights) | 18, with the `pg_trgm` extension (part of PostgreSQL's contrib modules) | `postgres:18.6` image |
| Docker | not needed | not needed | Docker Engine 24+ with Compose v2.24+ (BuildKit named build contexts) |
| Other | Git; Playwright's Chromium for the E2E suite (`npx playwright install chromium`) | the same | a DNS name and a TLS certificate for it; a Resend account with a verified domain, or an SMTP server |

On Windows, always call the backend's own interpreter (`backend\.venv\Scripts\python.exe`). A `python`
on the PATH may belong to another environment.

---

## 4. Quick start

### 4.1 Windows (portable PostgreSQL, verified)

Run these in Windows PowerShell from the repository root.

**1. PostgreSQL binaries.** Download the EDB "binaries" zip of PostgreSQL 18.6 and extract it into
`.local\`, so that `.local\pgsql\bin\pg_ctl.exe` exists. The folder is git-ignored. The zip is about
344 MB, about 0.9 GB extracted.

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell's progress bar slows large downloads a lot
Invoke-WebRequest https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip -OutFile .local\pgsql.zip -UseBasicParsing
tar -xf .local\pgsql.zip -C .local      # Windows' own tar.exe reads zip files
Remove-Item .local\pgsql.zip
```

**2. Create and start the local cluster.** This step creates the roles `vms_owner` and `vms_app` and the
databases `vms` (development) and `vms_e2e` (Playwright). The cluster listens on port **5433**.

```powershell
./scripts/db.ps1 init      # one time; it also starts the cluster
./scripts/db.ps1 status    # later: start | stop | status | psql
```

If PowerShell answers "running scripts is disabled on this system", run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or call the script as
`powershell -ExecutionPolicy Bypass -File .\scripts\db.ps1 init`.

**3. Configuration.** The template's values match `scripts/db.ps1`. An empty `SECRET_KEY` selects a
built-in development key, which production refuses.

```powershell
Copy-Item .env.example .env
```

**4. Backend environment, migrations and demo data.**

```powershell
py -3.14 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install --require-hashes -r backend\requirements-dev.txt
cd backend
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m app.cli seed-demo     # the demo company Mawdoo3, in Arabic (§11)
.\.venv\Scripts\python.exe -m app.serve        # API on http://127.0.0.1:8000; keep this terminal open
```

**5. Frontend** (in a second terminal, from the repository root):

```powershell
cd frontend
npm ci
npm run dev        # http://localhost:5173; /api is proxied to http://localhost:8000
```

**6. Sign in** at <http://localhost:5173> as `admin@demo.local` with the password `Demo-Visitor-2026`.
The sign-in page follows your browser's language. After sign-in the app follows your account's language,
else the demo company's default, Arabic; press **EN** to switch
([§1.3](#13-languages-and-right-to-left)). The other demo accounts are listed in [§11](#11-demo-users).
E-mails are written to `backend\var\outbox\` (see [§10](#10-e-mail-provider-configuration)).

### 4.2 Linux or macOS with your own PostgreSQL 18 (not verified on Linux or macOS)

`scripts/db.ps1` is Windows-only. With a PostgreSQL 18 server of your own, create what `db.ps1 init`
creates. The SQL below was run on PostgreSQL 18.6 on Windows, with the Windows locale name `en-US`
instead of `en_US.UTF-8`. The rest of this section was not run.

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE vms_owner LOGIN CREATEDB PASSWORD 'vms_owner_local_dev';
CREATE ROLE vms_app LOGIN PASSWORD 'vms_app_local_dev';
GRANT vms_app TO vms_owner;            -- lets the test harness hand throwaway databases to vms_app
CREATE DATABASE vms OWNER vms_owner TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LC_COLLATE 'C' LC_CTYPE 'en_US.UTF-8';
CREATE DATABASE vms_e2e OWNER vms_owner TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LC_COLLATE 'C' LC_CTYPE 'en_US.UTF-8';
\connect vms
REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMPORARY ON DATABASE vms FROM PUBLIC;
ALTER SCHEMA public OWNER TO vms_owner; GRANT USAGE ON SCHEMA public TO vms_app;
\connect vms_e2e
REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMPORARY ON DATABASE vms_e2e FROM PUBLIC;
ALTER SCHEMA public OWNER TO vms_owner; GRANT USAGE ON SCHEMA public TO vms_app;
SQL
```

- **Locale.** `LC_CTYPE` must be a UTF-8 locale, not `C` or `POSIX`. Under `C`, `pg_trgm` produces no
  trigrams for Arabic or accented names, and search misses them. The backend test suite creates its
  throwaway databases from `template1`, so the **cluster's** default locale matters as well. A cluster
  created with `initdb --encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C
  --lc-ctype=en_US.UTF-8` matches the development and Docker clusters.
- **Port.** `.env.example` uses port 5433. Change both URLs in `.env` if your server listens on 5432.
- **Time zone.** `scripts/db.ps1` also sets `timezone = 'UTC'` in `postgresql.conf`. The API sets UTC
  on each of its connections anyway.

Then:

```bash
cp .env.example .env               # adjust the port in DATABASE_URL / MIGRATION_DATABASE_URL if needed
python3.14 -m venv backend/.venv
backend/.venv/bin/python -m pip install --require-hashes -r backend/requirements-dev.txt
cd backend
.venv/bin/python -m alembic upgrade head
.venv/bin/python -m app.cli seed-demo
.venv/bin/python -m app.serve
# second terminal
cd frontend && npm ci && npm run dev
```

### 4.3 Other machines with Docker

The Compose file is a **production** deployment. It needs a DNS name, a TLS certificate and a Resend API
key or an SMTP server, and it refuses development settings. See [§9](#9-docker-setup). It was not run on the reference
machine.

---

## 5. Environment variables

The API reads its settings once at startup, from the process environment, then from `.env` at the
repository root, then from `backend/.env`. Environment variables win. Names are case-insensitive, and
unknown names are ignored. [`.env.example`](.env.example) documents every setting. A unit test
(`test_env_example_documents_exactly_the_settings`) fails if the template and the code ever disagree.
A setting outside its allowed range stops the API at startup with a message that names the setting.
The message never echoes the value.

**Defaults.** The "Default" column is the value in the code. Where `.env.example` sets a different value
for local development, the column shows it as well. "Production rule" lists what `APP_ENV=production`
refuses at startup.

### 5.1 Application and database

| Variable | Default | Allowed | Production rule |
|---|---|---|---|
| `APP_ENV` | **required** | `development`, `test`, `production` | `production` switches on every rule in this column, disables `/docs` and `/openapi.json`, and makes the seeding and time-travel CLI commands refuse to run |
| `DATABASE_URL` | **required** | `postgresql://`, `postgres://` or `postgresql+psycopg://` URL; percent-encode `@ : / ? # [ ] %` in user name and password | Must not be the migration owner's role. Must not use a published local password (`…local_dev`) from the URL, a `?password=` parameter or `PGPASSWORD`. Must verify the server's certificate (`sslmode=verify-full` or `verify-ca`, in the URL or `PGSSLMODE`) unless it connects over a Unix socket or loopback, or `DB_REQUIRE_TLS=false`. At startup the connected role must be a plain `LOGIN` role: no other attributes, no role memberships, no role defaults, no `TEMPORARY`, and exactly the migrations' table privileges. Its password must not be a published one from any source, a password file included. |
| `MIGRATION_DATABASE_URL` | unset (`.env.example`: `vms_owner` on port 5433) | as above | Not needed by the API. Needed by Alembic, `prune-sessions` and the test harness. Same password and TLS rules as `DATABASE_URL`. In Compose only the migrate container receives it. |
| `DB_APP_ROLE` | `vms_app` | lowercase identifier | the role the migrations grant runtime privileges to |
| `DB_POOL_SIZE` | `10` | 1–100 | pooled connections per API process, as many again as overflow. Compose: 10 on `backend`, 5 on each read process (at most 50 API connections). |
| `DB_CONNECT_TIMEOUT_SECONDS` | `5` | 2–60 | |
| `DB_POOL_TIMEOUT_SECONDS` | `5` | 1–60 | a full pool answers 503 `SERVICE_BUSY` |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | 1000–600000 | not applied to migrations |
| `DB_LOCK_TIMEOUT_MS` | `10000` | 100–600000 | |
| `DB_REQUIRE_TLS` | `true` | boolean | set `false` only for a database on a network the deployment controls end to end (the Compose `db` network does) |

### 5.2 Security, origins and sessions

| Variable | Default | Allowed | Production rule |
|---|---|---|---|
| `SECRET_KEY` | empty → built-in development key | any string | At least 43 characters and 10 distinct characters. Placeholder words, human-made keys (words, dates, keyboard walks, repetitions) and the keys published in the test suite are refused. Generate one with `python -c "import secrets; print(secrets.token_urlsafe(48))"`. It keys the device-trust cookies and the rate-limiter identifiers. |
| `APP_BASE_URL` | `http://localhost:5173` | an origin (`scheme://host[:port]`), no path | `https://` only; reset links are `{APP_BASE_URL}/reset-password?c=<slug>#token=…`, a company's sign-in page `{APP_BASE_URL}/c/<slug>` |
| `QR_BASE_URL` | = `APP_BASE_URL` | an origin | `https://` only; pass links are `{QR_BASE_URL}/pass?c=<slug>#<token>` |
| `ALLOWED_ORIGINS` | `http://localhost:5173` (`.env.example` adds `http://127.0.0.1:5173`) | comma-separated exact origins; `*` is rejected | `https://` only. Unsafe requests from any other `Origin` answer 403 `CSRF_FAILED`. |
| `TRUSTED_PROXIES` | empty (`.env.example`: `127.0.0.1/32,::1/128`, the Vite proxy) | comma-separated CIDRs | No network wider than /8 (IPv4) or /32 (IPv6). Only these peers' `X-Forwarded-For` and `X-Request-ID` are believed. |
| `COOKIE_SECURE` | `true` (`.env.example`: `false`) | boolean | Must be `true`. `true` gives the cookies `__Host-vms_session` / `__Host-vms_csrf` (Secure); `false` gives `vms_session` / `vms_csrf`, for plain-http development. |
| `SESSION_MAX_AGE_HOURS` | `12` | 1–720 | absolute session lifetime |
| `SESSION_IDLE_MINUTES` | `240` | 5–1440 | idle timeout; reception's background polling does not keep a session alive |
| `PLATFORM_SESSION_MAX_AGE_HOURS` | `8` | 1–24 | the platform owner's absolute session lifetime; production refuses more than 12 |
| `PLATFORM_SESSION_IDLE_MINUTES` | `30` | 5–1440 | the platform owner's idle timeout; production refuses more than 60 |
| `PASSWORD_HASH_CONCURRENCY` | the CPU count | 1–64 | Argon2id hashes at the same time, 64 MiB each; beyond that, 503 `SERVICE_BUSY`. Compose sets 4 on `backend` and 1 on the read processes, which receive no sign-ins. |
| `MAX_REQUEST_BODY_BYTES` | `65536` | 1024–10485760 | Larger bodies answer 413. nginx's `client_max_body_size` is 64k to match. One request has a fixed limit of its own, whatever this value is: the upload of a company's brand image, 512 KiB (nginx: a location of its own). |
| `SERVER_HOST` / `SERVER_PORT` | `127.0.0.1` / `8000` | | used by `python -m app.serve`; `--host` and `--port` override them |

### 5.3 E-mail

| Variable | Default | Allowed | Production rule |
|---|---|---|---|
| `EMAIL_PROVIDER` | `outbox` | `resend`, `smtp`, `outbox`, `memory` | `resend` or `smtp` (`outbox` and `memory` are refused) |
| `RESEND_API_KEY` | unset | | required when `EMAIL_PROVIDER=resend`, in every environment |
| `SMTP_HOST` | unset | a host name or IP address, no scheme or port | required when `EMAIL_PROVIDER=smtp`, in every environment |
| `SMTP_PORT` | by `SMTP_SECURITY`: `587`, `465` or `25` | 1–65535 | |
| `SMTP_SECURITY` | `starttls` | `starttls`, `ssl` (TLS from the first byte), `none` | `none` is refused (development and tests only) |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | unset | printable ASCII; both or neither | `SMTP_PASSWORD` is a secret: never logged or echoed. Refused with `SMTP_SECURITY=none` in every environment. |
| `SMTP_TIMEOUT_SECONDS` | `10` | 1–60 | the connection and each wait for the server, within the message's 20 s deadline |
| `EMAIL_FROM` | `Mawdoo3 Visitors <no-reply@localhost>` (`.env.example`: `Mawdoo3 Visitors <no-reply@demo.local>`) | `Display name <address>`; with `smtp` it must contain an address | with Resend: an address on a domain verified in Resend; with Gmail: the Gmail address (§10). Keep the display name "Mawdoo3 Visitors": it is the sender recipients see. |
| `EMAIL_REPLY_TO` | unset | an e-mail address | |
| `EMAIL_OUTBOX_DIR` | `var/outbox` (that is, `backend/var/outbox`) | an absolute path, or a relative path that stays inside `backend/var` | Outbox files contain raw pass and reset links, so a relative path outside `backend/var` is refused in every environment. In Git Bash, quote Windows paths: unquoted, the shell strips their backslashes. |
| `EMAIL_FAIL_DOMAIN` | unset | a domain name | Recipients at this domain fail permanently, for testing failure handling. Must not be set in production. |
| `EMAIL_DELIVERY_CONCURRENCY` | `4` | 1–32 | deliveries running at the same time |

### 5.4 Names

The product and the brand in the e-mails and the API. One line of visible text each, 1–60 characters
(control, direction and zero-width characters are refused). A company (tenant) is never named here: its
English and Arabic names are company settings.

| Variable | Default | Used for |
|---|---|---|
| `PRODUCT_NAME_EN` / `PRODUCT_NAME_AR` | `Mawdoo3 Visitors` / `زوار موضوع` | the product, where it speaks for itself: the test e-mail of `send-test-email` (its footer "Sent by Mawdoo3 Visitors." and the first line of its plain text), `EMAIL_FROM`'s default display name, and the OpenAPI title ("Mawdoo3 Visitors API"). No e-mail to a company's staff or visitors names it: those are the company's own ([§1.5](#15-a-companys-own-identity)) |
| `BRAND_NAME_EN` / `BRAND_NAME_AR` | `Mawdoo3` / `موضوع` | the organisation behind the product's logo: the logo's text alternative in the test e-mail |

The web application names the product from its own catalogs and `frontend/src/brand.ts`, not from these
settings: another deployment changes both.

### 5.5 Rate limits

All limits are counted in the API process's memory (one worker per process). In the Compose
deployment, every limit except `RATE_LIMIT_API_PER_MINUTE` is counted only by `backend`, which
receives every sign-in and write. The per-user API budget is counted by each of the four processes for
the requests nginx sends it ([deploy/README.md](deploy/README.md) §4). A refused request
answers 429 with `Retry-After`. In production, `RATE_LIMIT_ENABLED=false` is refused. The limits marked
**G** guard against password guessing, account-recovery abuse and probing for accounts; production
refuses values above ten times their default. The two bucket caps have a production floor of 10000.

| Variable | Default | Counts |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_LOGIN_PER_IP_EMAIL` **G** | `5` | failed sign-ins per (client address, e-mail) / 5 min |
| `RATE_LIMIT_LOGIN_PER_IP` **G** | `30` | failed sign-ins per client address (IPv6: per /64) / 5 min |
| `RATE_LIMIT_LOGIN_PER_ACCOUNT` **G** | `10` | failed sign-ins per account / 15 min; then a 15-minute lockout for browsers the account has not signed in from |
| `RATE_LIMIT_LOGIN_PER_PREFIX` **G** | `300` | failed sign-ins per IPv6 /48 / 5 min |
| `RATE_LIMIT_LOGIN_SUCCESSES_PER_ACCOUNT` | `30` | successful sign-ins per account / 15 min |
| `RATE_LIMIT_PASSWORD_CHANGE_PER_USER` **G** | `5` | wrong current passwords per user / 15 min; the attempt that reaches the limit also ends the session |
| `RATE_LIMIT_PASSWORD_CHANGES_PER_HOUR` | `5` | successful password changes per account / hour |
| `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR` **G** | `10` | `POST /users` refused for an address already taken, per administrator / hour |
| `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_COMPANY_PER_HOUR` **G** | `20` | the same per company / hour |
| `RATE_LIMIT_FORGOT_PER_EMAIL` **G** | `3` | reset e-mails per existing account / 15 min |
| `RATE_LIMIT_FORGOT_PER_IP` **G** | `10` | forgot-password requests per client address / 15 min |
| `RATE_LIMIT_FORGOT_PER_PREFIX` **G** | `100` | the same per IPv6 /48 |
| `RATE_LIMIT_RESET_PER_IP` **G** | `20` | reset-password attempts per client address / 15 min |
| `RATE_LIMIT_RESET_PER_PREFIX` **G** | `200` | the same per IPv6 /48 |
| `RATE_LIMIT_MAX_NETWORK_BUCKETS` | `100000` | limiter entries keyed by client addresses (minimum 100; production minimum 10000) |
| `RATE_LIMIT_MAX_EMAIL_BUCKETS` | `100000` | limiter entries keyed by typed e-mail addresses (the same bounds) |
| `RATE_LIMIT_SCAN_PER_MINUTE` | `120` | pass scans per user / min |
| `RATE_LIMIT_ATTENDANCE_REFUSALS_PER_MINUTE` | `30` | refused check-ins, check-outs and walk-ins without a scanned pass, per user / min |
| `RATE_LIMIT_RESENDS_PER_VISIT_HOUR` | `3` | invitation resends per visit / hour |
| `RATE_LIMIT_API_PER_MINUTE` | `600` | authenticated API requests per user / min |
| `INVITATION_DAILY_LIMIT` | `50` | invitation e-mails per user / 24 h; then 429 `INVITATION_LIMIT` |
| `RESCHEDULE_NOTICE_DAILY_LIMIT` | `50` | rescheduling e-mails per user / 24 h (beyond it, the change is saved without an e-mail) |
| `RATE_LIMIT_RESCHEDULE_NOTICES_PER_VISIT_HOUR` | `3` | rescheduling e-mails per visit / hour (the same) |
| `HOST_ARRIVAL_DAILY_LIMIT` | `500` | "your visitor has arrived" e-mails per checking-in user / 24 h. Set it above the busiest desk account's daily check-ins. |
| `HOST_VISIT_NOTICE_DAILY_LIMIT` | `200` | the host's e-mails of scheduled visits (a new visit, its new time, its cancellation) that one user's actions send / 24 h, whoever the hosts are (beyond it, the change is made without the host's e-mail) |
| `CALENDAR_EMAIL_COMPANY_DAILY_LIMIT` | `500` | calendar events (the visitor's calendar invitation, new time and cancellation, the host's three) per company / 24 h. Beyond it the change is made: a calendar invitation and the host's notice of a new visit are left out, a notice of a new time goes without its event, and a cancellation that takes the visit out of a calendar is always sent. Keep the companies' budgets together, with the invitations and the other e-mails, below the sending mailbox's daily cap (Gmail 500, Google Workspace 2,000). |
| `CALENDAR_INVITATIONS_ENABLED` | `true` | `false`: no new calendar entry (no calendar invitation, no host's notice of a new visit, no event for a calendar that does not hold the visit); calendars that hold a visit still get its new time and its removal. **Keep `false` on production** until the sending mailbox is a dedicated one with SPF, its own DKIM and DMARC (`deploy/env/backend.env.example` has it false; production-readiness §15 E). |
| `TRACKING_PROVIDER` | `disabled` | The Visitor Journey's tracking provider (Phase 15): `disabled` (enrollment refused, the ingestion endpoint answers 404, every journey shows Disabled) or `simulator` (development and E2E only, marked Simulated). **Production refuses `simulator`**; no real provider adapter exists (BLOCKED BY ENVIRONMENT). |
| `RATE_LIMIT_TEMPLATE_TEST_SENDS_PER_HOUR` | `5` | test e-mails of a company's edited e-mail texts, to the administrator's own address, per administrator / hour (1–100); the platform owner's test e-mails count per platform account |
| `RATE_LIMIT_PUBLIC_BRAND_PER_IP` **G** | `600` | requests of the public identity endpoints (a company's name, brand, images and manifest, read by its sign-in and pass pages without a session) per client address / min; every request counts, whatever the answer |
| `RATE_LIMIT_PUBLIC_BRAND_PER_PREFIX` **G** | `6000` | the same per IPv6 /48 |
| `RATE_LIMIT_BRAND_CHANGES_PER_HOUR` | `120` | changes of companies' identities (an image stored or removed, a colour) per platform account / hour, refused uploads included (1–10000) |
| `RATE_LIMIT_TRACKING_REQUESTS_PER_MINUTE` | `120` | the tracking provider's ingestion requests per tracking key / min (Phase 15) |
| `RATE_LIMIT_TRACKING_KEY_FAILURES_PER_IP` | `30` | ingestion requests with a wrong, revoked or absent tracking key per client address / 5 min |

### 5.6 Logging and seeding

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `INFO` | `CRITICAL`, `ERROR`, `WARNING`, `INFO`, `DEBUG`. `DEBUG` applies to the application's own loggers only: uvicorn's stay at INFO, because their debug output contains raw headers and cookies. |
| `LOG_JSON` | `true` | one JSON object per line |
| `SEED_COMPANY_TIMEZONE` | `Asia/Amman` | IANA name; the time zone of seeded companies and of companies created by `create-admin` without `--timezone` |
| `SEED_DEMO_PASSWORD` | unset → `Demo-Visitor-2026` | password of every seeded user; seeding is refused in production |

### 5.7 Variables read by other tools

| Variable | Read by | Purpose |
|---|---|---|
| `PGSSLMODE`, `PGHOST`, `PGHOSTADDR`, `PGSERVICE`, `PGUSER`, `PGPASSWORD` | libpq, and the production checks above | how and as whom the database is reached |
| `VMS_PG_PORT`, `VMS_PG_OWNER_PASSWORD`, `VMS_PG_APP_PASSWORD`, `VMS_PG_SUPER_PASSWORD` | `scripts/db.ps1`; the E2E suite reads the first three | port (5433) and passwords of the local cluster |
| `VMS_API_PROXY_TARGET` | `frontend/vite.config.ts` | where the dev/preview proxy sends `/api` (default `http://localhost:8000`) |
| `VMS_TEST_MIGRATION_DATABASE_URL`, `VMS_TEST_DATABASE_URL`, `VMS_TEST_DB_APP_ROLE` | backend test harness | the server and roles for throwaway test databases ([development guide](docs/development.md#6-backend-test-harness)) |
| `VMS_E2E_DATABASE`, `VMS_E2E_PYTHON`, `VMS_E2E_PG_BIN`, `VMS_PG_HOST`, `E2E_WORKERS` | Playwright suite | [development guide](docs/development.md#7-end-to-end-suite-playwright) |
| `VMS_SERVER_NAME` | the nginx container | public host name(s) (`deploy/env/frontend.env`) |
| `VMS_API_UPSTREAM`, `VMS_API_RECEPTION_UPSTREAM`, `VMS_API_REPORTS_UPSTREAM` | the nginx container | `host:port` of the three API services; defaults `backend:8000`, `backend-reception:8000`, `backend-reports:8000` (set only when the services run under other names) |

---

## 6. Database setup and migrations

| Role | Purpose | Privileges |
|---|---|---|
| `vms_owner` | owns the schema; runs migrations and maintenance (`prune-sessions`). Locally also creates the test databases (`CREATEDB`; not in production). | owner |
| `vms_app` | the API, the CLI's business commands and e-mail delivery | Granted by the migrations: `SELECT`, `INSERT`, `UPDATE` on the business tables; `SELECT` and `INSERT` (without the `seq` column) on `audit_logs`; nothing on `alembic_version`. No `DELETE`, `TRUNCATE` or DDL, and no `TEMPORARY`. |

| Database | Use |
|---|---|
| `vms` | development (local) and production |
| `vms_e2e` | the Playwright suite; its schema is dropped and rebuilt on every run |
| `vms_test_*`, `vms_committed_*`, … | throwaway databases of the backend tests, dropped when the run ends |

**Migrations** run from `backend/` as the owner (`MIGRATION_DATABASE_URL`):

```powershell
cd backend
.\.venv\Scripts\python.exe -m alembic upgrade head    # Linux: .venv/bin/python -m alembic upgrade head
.\.venv\Scripts\python.exe -m alembic current         # prints e.g. "0012 (head)"
.\.venv\Scripts\python.exe -m alembic history
```

- The revisions are `0001` (the whole contract schema, triggers and runtime grants) to `0012`. Every
  revision has a downgrade. Run downgrades with the API stopped.
- Revision `0012` (Phase 10) adds the Arabic versions: `departments.name_ar` (unique per company,
  ignoring case), `companies.address_ar` and the visits' `department_name_ar` snapshot. Its downgrade
  refuses while any of them holds a value, and names the statements that clear them.
- Revision `0011` (Phase 10) adds the languages: `users.preferred_language`, and the company's
  `default_language` (Arabic for every existing company) and `name_ar`. Its downgrade refuses while a
  language choice or an Arabic name exists, and names the statements that clear them.
- Revision `0010` adds two indexes with a plain `CREATE INDEX`, which blocks writes while it builds. On
  a database with large tables, create them `CONCURRENTLY` first; the statements are in the
  migration's docstring.
- In Compose, the one-shot `migrate` service runs `alembic upgrade head` before the API starts.
- A test compares the migrated schema with the SQLAlchemy models, and another downgrades to `base` and
  upgrades again. A schema change therefore always needs a migration
  ([development guide](docs/development.md#41-a-migration)).

**Backups:** `scripts/backup.ps1` / `scripts/restore.ps1` (Windows) and `scripts/backup.sh` /
`scripts/restore.sh` (Linux; `--compose` for the Docker deployment). They take `pg_dump` custom-format
archives as the schema owner and write a `.sha256` file beside each. A restore always goes into a **new**
database and is verified there: schema version, triggers and the runtime role's privileges. Example
(Windows, verified against a throwaway cluster):

```powershell
$env:PGPASSWORD = 'vms_owner_local_dev'          # local cluster only
./scripts/backup.ps1 -OutputDir D:\vms-backups
./scripts/restore.ps1 -File D:\vms-backups\vms-<stamp>.dump -TargetDatabase vms_restored -RequireChecksum
```

Recovery objectives (RPO and RTO) and WAL archiving are covered in
[docs/decisions/phase-9-deploy.md](docs/decisions/phase-9-deploy.md#rpo--rto-guidance).

---

## 7. Running the backend and frontend

### 7.1 Backend

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.serve                 # SERVER_HOST:SERVER_PORT (127.0.0.1:8000)
.\.venv\Scripts\python.exe -m app.serve --port 8010     # another port; --host 0.0.0.0 to listen on all interfaces
```

- `GET /api/v1/health` answers `{"status":"ok","database":"ok"}`, or 503 within 3 s when the database
  does not answer. It checks the database on a connection of its own.
- Outside production, the OpenAPI UI is at `http://127.0.0.1:8000/docs` and the schema at `/openapi.json`.
  The UI loads Swagger UI's scripts from cdn.jsdelivr.net.
- **Direct calls and `TRUSTED_PROXIES`.** With the development value `TRUSTED_PROXIES=127.0.0.1/32,::1/128`,
  a request sent straight to port 8000 from the same machine (curl, `/docs`) has no client address. It is
  logged and audited with `client_ip` null, and all such requests share one per-address rate-limit
  budget. Requests through the Vite proxy carry the real address. Leave `TRUSTED_PROXIES` empty if you
  work against port 8000 directly.
- Logs are JSON lines on the console. Access-log lines have `method`, `path`, `route`, `status`,
  `duration_ms`, `client_ip`, `user_id` and `company_id`, and never the query string.
- While the database is unreachable, the e-mail sweep (at start-up, then every minute) writes one
  WARNING line, `closing interrupted e-mail deliveries skipped: database unavailable (<error class>)`,
  without a traceback.

**Operational commands** (`python -m app.cli <command>`, from `backend/`):

| Command | What it does | In production |
|---|---|---|
| `seed-demo` | The demo company Mawdoo3 («موضوع», Arabic by default) with six users named in Arabic and five departments named in English and Arabic ([§11](#11-demo-users)); adds only what is missing | refused; and the API refuses to start in production on a database that holds a seed account, wherever it was seeded ([§11](#11-demo-users)) |
| `seed-e2e` | The same company with the English names the E2E suite reads, plus "Other Corp" (four users, English by default), for cross-tenant tests. Both seeds give the demo company the Mawdoo3 logo, icon and colour as its own identity (Phase 12); Other Corp has none | refused (as above) |
| `create-admin --email … --full-name … --company-slug … [--company-name …] [--timezone …] [--password-stdin]` | creates a `SYSTEM_ADMIN`, and the company if the slug is new. The password comes from a prompt or stdin, never from the command line. | allowed |
| `create-platform-admin --email … [--full-name …] [--password-stdin] [--reset]` | creates the platform owner's account (Phase 11). Without `--password-stdin` it generates a temporary password (32 characters) and prints it **once**; with it, the password is one line of stdin. The password must be changed at the first sign-in (`/platform/login`) and expires in 72 hours. `--reset` gives an existing account a new temporary password and ends its sessions; it changes nothing else, so `--full-name` is refused with it. A **generated** password signs in even while failed sign-ins from elsewhere keep the account locked (it has a failure budget of its own), which makes `--reset` without `--password-stdin` the way to recover a locked account ([security.md](docs/security.md) §3.7). | allowed |
| `mark-no-shows` | marks expired `SCHEDULED` visits `NO_SHOW` in every company. Optional: every visit read and write does this for its own company. | allowed |
| `prune-sessions [--older-than-days 30]` | deletes sessions (users' and the platform owner's) that ended more than N days ago; needs `MIGRATION_DATABASE_URL` (owner role) | allowed |
| `prune-journeys` | deletes tracking alerts (Phase 16), visitor journey events and ended tracking associations older than each company's `journey_retention_days` (default 30; Phase 15); needs `MIGRATION_DATABASE_URL` (owner role) | allowed |
| `simulate-journey --visit … [--steps 3] [--cameras CAM1,CAM2,…] [--interval-seconds 120] [--match CONFIRMED\|UNCERTAIN] [--confidence …]` | sends synthetic observations for a visit's simulator tracking association through the ingestion service, marked Simulated (`TRACKING_PROVIDER=simulator`; development and E2E); `--cameras` (Phase 16) walks those provider camera IDs in order, one observation each, the last one now, and the command e-mails the area alerts it raises | refused |
| `e2e-time-travel --visit-id … --minutes …` | moves a visit and its passes into the past (E2E tests) | refused |
| `send-test-email --to … [--language ar\|en]` | sends one short bilingual message with a sample QR code and the logo through the configured provider (Arabic first by default; `--language en` puts English first) and prints the result or the classified error (never a credential). Needs no database and writes no audit row. | allowed |

### 7.2 Frontend

Run these from `frontend/`:

| Command | Purpose |
|---|---|
| `npm run dev` | dev server on <http://localhost:5173> (strict port); `/api` is proxied to `VMS_API_PROXY_TARGET` (default `http://localhost:8000`) |
| `npm run dev:https` | the same over HTTPS with a self-signed certificate, listening on all interfaces, for tablets on the LAN ([camera access](docs/development.md#9-troubleshooting)) |
| `npm run build` | type-check, then production build into `dist/` (including the zxing `.wasm` and the service-worker precache list) |
| `npm run preview` | serves `dist/` on <http://localhost:4173> with the production security headers and the `/api` proxy |
| `npm run typecheck`, `npm run lint` | `tsc -b`; oxlint, where warnings fail |
| `npm test` | Vitest unit and component tests |

The service worker registers only in production builds, and never on the visitor's `/pass` page.

---

## 8. Running the tests

| Suite | Command (directory) | Result on the reference machine, 2026-10-08 |
|---|---|---|
| Backend lint and format | `.\.venv\Scripts\python.exe -m ruff check .` and `… -m ruff format --check .` (`backend/`) | clean (252 files) |
| Backend types | `.\.venv\Scripts\python.exe -m mypy` (`backend/`) | no issues, 134 source files (strict) |
| Backend unit + integration | `.\.venv\Scripts\python.exe -m pytest` (`backend/`) | 3,028 passed, 3 skipped (the opt-in performance checks), 252 s |
| Backend isolation order | `.\.venv\Scripts\python.exe -m pytest --committed-first` | 3,028 passed, 3 skipped, 285 s |
| Backend volume check (opt-in) | `.\.venv\Scripts\python.exe -m pytest --performance -s tests/performance` | not part of the gate; 3 passed in both performance re-audits of Phase 9 ([production-readiness.md](docs/production-readiness.md) §3.5) |
| Frontend | `npm run typecheck`, `npm run lint`, `npm test` (`frontend/`) | pass (0 lint warnings); Vitest 1,383 tests in 129 files, 96 s |
| E2E (Playwright, Chromium) | `npm run e2e` (`frontend/`) | full suite with `--retries=0`: 253 tests, 235 passed, 18 skipped by the specs' own project conditions, 0 failed, 0 flaky, 7.7 min |
| Deployment files | `deploy/verify` unit tests, `check_release_tree.py`, `check_nginx_headers.mjs` (repository root) | 33 tests OK; 892 files, no artefact or credential; 7 headers in sync |

The backend rows were measured again at the Phase 12 backend gate of 2026-10-13 (a company's own identity,
revision `0015`): `ruff` clean (304 files), `mypy` no issues in 159 source files, `pytest` 4,100 passed and
3 skipped (548 s), `pytest --committed-first` 4,100 passed and 3 skipped (647 s), the deployment files 42 tests OK and
1,066 files without an artefact or credential
([phase-12-backend.md](docs/decisions/phase-12-backend.md), Verification). And once more the same day,
after the security review of Phase 12 (B12-18 to B12-20): `ruff` clean (306 files), `mypy` no issues in
159 source files, `pytest` 4,155 passed and 3 skipped (519 s), `pytest --committed-first` 4,155 passed and
3 skipped (927 s, beside the frontend's E2E run), the deployment files 46 tests OK and 1,068 files without an artefact or credential (the same
record, "Verification of this round"). And on 2026-10-14, after the UX review of Phase 12 (B12-21 to
B12-26: a company's own colour on its surfaces, every e-mail of a company in the company's identity,
e-mails that fit a phone): `ruff` clean (306 files), `mypy` no issues in 159 source files, `pytest`
4,240 passed and 3 skipped (763 s), `pytest --committed-first` 4,240 passed and 3 skipped
(821 s), the deployment files 46 tests OK and 1,074 files without an artefact or credential (the same record,
"After the UX review"). The frontend and E2E rows are the frontend's to restate after its own Phase 12
gate.

These are the results of the integration gate of 2026-10-08 for the host rule and the departments in both
languages (revision `0012`; [phase-10-backend.md](docs/decisions/phase-10-backend.md), INT-dept-1 to 4). The
earlier Phase 10 gate, with coverage and the build, is in
[production-readiness.md](docs/production-readiness.md) §10.1.

The backend tests need the PostgreSQL cluster running. They create and drop their own databases as
`vms_owner`, and they never touch `vms` or `vms_e2e`. The E2E suite recreates the `vms_e2e` schema and
starts its own API (port 8700) and Vite (port 5199). Details, single-test commands, the fake clock and
the two-connection tests are in [docs/development.md](docs/development.md#5-quality-gates).

---

## 9. Docker setup

> **Not verified on the reference machine:** Docker is not installed there, so no image was built and no
> container was run. What could be checked without Docker was: the nginx configuration in front of the
> production-mode API, the PostgreSQL provisioning script, the backup and restore scripts, the image
> build steps in equivalent local form, and static validation of the Compose file and Dockerfiles. That
> verification, and the explicit NOT VERIFIED list, is in
> [docs/decisions/phase-9-deploy.md](docs/decisions/phase-9-deploy.md).

`docker-compose.yml` describes a single-host production deployment:

```
postgres (healthy) → migrate (one-shot: alembic upgrade head as vms_owner, must exit 0)
                   → backend, backend-reception (×2), backend-reports (python -m app.serve, healthy)
                   → frontend (nginx, publishes 80 and 443, shares the API requests out by method
                               and path; only GET requests leave backend)
```

The operator runbook is [deploy/README.md](deploy/README.md). In short (Linux host, from the repository
root):

```bash
for f in postgres backend migrate frontend; do cp deploy/env/$f.env.example deploy/env/$f.env; done
chmod 600 deploy/env/*.env
# fill in the passwords, SECRET_KEY, the public https origin, RESEND_API_KEY (or SMTP_*) / EMAIL_FROM and VMS_SERVER_NAME
# put the certificate chain and key in deploy/tls/tls.crt and deploy/tls/tls.key (readable by gid 101)
docker compose build
docker compose up -d
docker compose ps        # postgres, backend, backend-reception-1 and -2, backend-reports, frontend
                         # healthy; migrate "exited (0)"
docker compose exec backend python -m app.cli create-platform-admin --email owner@example.com
                         # prints a temporary password once; sign in at /platform/login and change it
docker compose exec backend python -m app.cli create-admin \
  --email admin@example.com --full-name "Jane Admin" --company-slug acme --company-name "Acme Bank"
python3 deploy/verify/smoke_test.py --base-url https://vms.example.com --http-url http://vms.example.com
```

| Service | Image | Published | Notes |
|---|---|---|---|
| `postgres` | `postgres:18.6-trixie` (digest-pinned) | nothing | Roles and database are created on first start by `deploy/postgres/initdb/10-vms-roles.sh`, with the same text locale as the development cluster. Tuned for a 2 GiB limit. |
| `migrate` | `vms-backend:local` | nothing | the only container that receives the owner's URL (`deploy/env/migrate.env`) |
| `backend` | `vms-backend:local` | nothing | the main API instance: every sign-in, every write (scans and check-ins included) and every request not listed below. Exactly one process; uid 10001, read-only root filesystem, one worker, `TRUSTED_PROXIES=172.30.47.10/32` (nginx) |
| `backend-reception` | `vms-backend:local` | nothing | the same API in two replicas, sent only `GET /api/v1/reception/today` and `/inside` (each request to the less busy replica) |
| `backend-reports` | `vms-backend:local` | nothing | the same API, sent only `GET /api/v1/reports/summary`, `/audit-logs`, `/dashboard/admin` and `/visits` |
| `frontend` | `vms-frontend:local` | 80, 443 | nginx uid 101; TLS, security headers, SPA fallback, `/api` proxy routed by method and path; answers only the configured host names |

Secrets live only in the git-ignored `deploy/env/*.env` files. The Compose file uses no `${…}`
interpolation, so the repository's development `.env` cannot leak into it.

---

## 10. E-mail provider configuration

The system sends eleven kinds of e-mail: `VISITOR_INVITATION` (with the inline QR code),
`VISITOR_CALENDAR` (the short e-mail that follows every invitation with the visit for the visitor's
calendar), `VISIT_RESCHEDULED`, `VISIT_CANCELLED`, `HOST_VISIT_SCHEDULED`, `HOST_VISIT_RESCHEDULED` and
`HOST_VISIT_CANCELLED` (the host's: a new visit, its new time, its cancellation), `HOST_ARRIVAL`,
`PASSWORD_RESET`, `PASSWORD_CHANGED` and `PLATFORM_ACTION_NOTICE` (to a company's other administrators
when the platform owner adds an administrator or sends one a reset link). Each message is a row in
`email_messages` (`PENDING` → `SENT` or `FAILED`). The rendered body is not stored, because it can contain
a pass link.

**What a message looks like.** Every e-mail is in Arabic and English and is **the company's own**
([§1.5](#15-a-companys-own-identity)): its logo as an inline image (`cid:brand-logo`) on a white header, or
its name when it has no logo; a bar and a button in its own colour; its name as the sender. Nothing in an
e-mail to a company's staff or visitors names the product or shows the Mawdoo3 logo, the notice of what
the platform owner did included. Only the test message of `send-test-email` is the product's (the white
Mawdoo3 logo on the teal header).

- E-mails to **visitors** (invitation, reschedule, cancellation) lead with the company's default
  language. Their subject names both languages, the company's first, for example «زيارتك إلى موضوع يوم
  الخميس، 8 تشرين الأول 2026 | Your visit to Mawdoo3 on Thursday, 8 October 2026».
- E-mails to **staff** (a visitor's arrival, password reset and change) lead with the recipient's own
  language, else the company's, and their subject is in that language only.
- Each language's section is complete, and so is the plain-text part, which opens with the company's
  name. The footer says who sent it: "Sent by <company>." («أُرسلت من <الشركة>.»).
- A subject has at most 250 characters. One that would be longer gives up some of the company's name
  first ("Your visit to International Company for Advanced Technological Solutions and Integrated
  Digital… on Wednesday, 14 October 2026"), so that it still says when.
- On a phone the kind of message ("Visit invitation") goes under the logo, and two-column details become
  one column: no e-mail is wider than the screen, from 320 pixels up. (A mail client that ignores an
  e-mail's style sheet shows the desktop layout, which fits from 375 pixels up.)
- Nothing in a message is loaded from the internet (no remote image, font or tracking pixel), so a mail
  client shows it without "load remote images" and calls no third party.
- **Light and dark** (Phase 13, [phase-13-backend.md](docs/decisions/phase-13-backend.md)). Every e-mail
  has a light design and a dark one, and says so (`color-scheme: light dark`). A mail client in dark mode
  that honours it (Apple Mail on the iPhone and the Mac, the Outlook apps) shows the dark design: the web
  application's dark colours, the company's colour adapted to them as the application adapts it, and the
  company's **logo for dark surfaces** in the header. Beside a logo that is an emblem (at most 1.4 times
  as wide as tall, the application's own rule), in either design, the company's name. Every other
  client shows the light design. The logo is never sent as it was stored: it is
  an **opaque** copy on a white plate (`brand-logo`), invisible on the white header and a white rounded
  tile where a client darkens the message itself (the Gmail apps), so the logo reads everywhere; the
  logo for dark surfaces is an opaque copy on the dark header's colour (`brand-logo-dark`), shown by the
  dark design only. Both are drawn once per server process from the stored logos, at most twice the size
  they are shown at, and ahead of the e-mails that carry them: after a logo changes, and from the first
  write a server process takes (the largest logo takes about 2 seconds to draw in pure Python, so no
  check-in waits for it). The preview of a company's e-mail texts shows either design alone (`scheme`).
  The worst e-mail the texts and values allow stays below 95 KiB, clear of Gmail's clipping at about
  102 KB.
- **Calendars** (Phase 14, [phase-14-backend.md](docs/decisions/phase-14-backend.md)). The visit goes into
  the visitor's and the host's calendars (Google Calendar, Outlook, Apple Calendar) as a calendar
  invitation in the e-mail (iCalendar, an iTIP `REQUEST`), with no connection to anyone's calendar.
  - **The visitor**: every invitation is followed by a short e-mail, `VISITOR_CALENDAR`, that carries
    the event; the invitation itself carries none, because Outlook keeps the text of the e-mail that
    carries an event in the calendar entry, and the pass link must not end up in a calendar. The notice
    of a new time carries the event moved (same `UID`, a higher `SEQUENCE`), the notice of a cancellation
    a `CANCEL`. A visitor whose pass the host shares himself, and a walk-in, get nothing, as before.
  - **A cancelled visit always leaves the visitor's calendar**: once the visitor's calendar holds the
    visit (its calendar invitation or a notice of a new time put it there), the cancellation is e-mailed
    whatever "Notify the visitor" says, without the reason, which was not meant for the visitor (the
    visit says so, `visitor_calendar_sent`, and the app does not offer the choice then). Each e-mail
    records the event it carried (`email_messages.calendar_method`, revision `0017`).
  - **A visitor's new address**: the old address's calendar loses the visit (a `VISITOR_CALENDAR` message
    whose `CANCEL` names nothing of the visit), one version newer, before the new address is invited
    one version newer still; a calendar invitation still waiting to go to the old address is not sent.
    Removing the address does the same. Another spelling of the same mailbox (letter case, a `+tag`,
    Gmail's dots) loses nothing: its new invitation updates the entry.
  - **The host** gets `HOST_VISIT_SCHEDULED` for every scheduled visit booked for them, then
    `HOST_VISIT_RESCHEDULED` and `HOST_VISIT_CANCELLED`, each with the host's own event (another `UID`),
    while the account is active, and the cancellations a deactivation causes. The host's event is
    private (`CLASS:PRIVATE`): a colleague who sees the host's calendar sees the time taken. A company
    edits their words like the other visit e-mails.
  - **Budgets**: the host's e-mails count per user whose action sends them (`HOST_VISIT_NOTICE_DAILY_LIMIT`)
    and every calendar event per company (`CALENDAR_EMAIL_COMPANY_DAILY_LIMIT`), since every company's
    e-mails leave through the one sending mailbox. Beyond them the visit is still created, moved or
    cancelled: an e-mail that is only the event (a calendar invitation, the host's notice of a new visit)
    is left out, a notice of a new time goes without its event, and a cancellation that takes the visit
    out of a calendar is always sent; the audit log says what was left out.
  - **The switch** (`CALENDAR_INVITATIONS_ENABLED`, false on production until the release gate): off, no
    calendar gets a new entry, and the e-mails go as before; the calendars that already hold a visit
    still get its new time and its removal, so switching it off leaves no wrong entry.
  - A calendar invitation that fails shows as a failed invitation, under *Needs attention*, marked as
    the calendar invitation's (`invitation.calendar_failed`: the visitor has the pass); resending then
    sends the calendar invitation alone again, and the pass stays as it is. It is put right too by a later
    notice of a new time that reaches the calendar. A host's e-mail that fails stays in the e-mail log.
  - The event says when (in UTC), where (the company's address), who and what for; **never a link or a
    token**. The organizer is `EMAIL_FROM`'s address under the company's name; the recipient is asked for
    no reply (`RSVP=FALSE`, which Outlook honours; Gmail still offers Yes / No / Maybe, and those answers
    reach `EMAIL_FROM`'s mailbox).
  - `EMAIL_FROM`'s own address, in any spelling that reaches it (letter case, a `+tag`, Gmail's dots), is
    never sent an event: it organizes them all, and a calendar does not add an invitation to its own
    organizer.
  - **Before calendar events go to production** (until then `CALENDAR_INVITATIONS_ENABLED=false`):
    `EMAIL_FROM` must be **a dedicated mailbox that hosts nobody** (no person's mailbox, and no address
    of one), and its domain must publish SPF and DMARC and sign its mail with **its own DKIM key** (Admin
    console → Gmail → Authenticate email), so that `From`, the envelope sender and the organizer are one
    authenticated address. The release gate is [production-readiness.md](docs/production-readiness.md)
    §15 E.
  - **In the app** ([phase-14-frontend.md](docs/decisions/phase-14-frontend.md)): the host of a scheduled
    visit that has not ended also has "Add to my calendar" on the visit page and after booking it: Google
    Calendar's and Outlook on the web's (Microsoft 365) new-event forms, and an `.ics` file for Apple
    Calendar and the rest, built in the browser from the visit as it is when the menu opens (fetched
    again). The file is the host's e-mailed event (same `UID` and `SEQUENCE`), so the e-mails that follow
    move or remove it; a link makes an entry of its own, and is at most 2,000 characters (the file carries
    everything). No pass link in any of them. The visitor's pass page has no such control.

| Provider | Use | Behaviour |
|---|---|---|
| `outbox` | development and the E2E suite | Writes each message to `EMAIL_OUTBOX_DIR` as `<id>.json` (`message_id`, `kind`, `to`, `subject`, `pass_url`, `reset_url`, `created_at`, `calendar`: `{method, uid, sequence}` of the calendar event, or `null`), `<id>.html`, `<id>.txt`, inline images `<id>-<cid>.png` (the logo is `<id>-brand-logo.png`, the logo for the dark design `<id>-brand-logo-dark.png` when the company has one, an invitation's QR code `<id>-visitor-pass-qr.png`) and the calendar event `<id>.ics` when the message carries one. These files contain live pass and reset links: keep them inside `backend/var/` (git-ignored). |
| `resend` | production (recommended) | `POST https://api.resend.com/emails` with the API key as a bearer token. The logo and the QR code are inline attachments referenced as `cid:`. The `Idempotency-Key` is derived from the message's ID (`vms-email-<id>`), so a retry cannot send it twice. 429, 5xx and timeouts are retried; other 4xx fail at once. **A calendar event can only be an attachment** (`invite.ics`, content type plain `text/calendar`: Resend's documentation names no parameters for it, and the object names its method itself): Resend's API has no way to add it as an alternative part. Gmail and Apple Mail read it as an invitation; Outlook shows the file to open, and does not move or remove the entry by itself on a new time or a cancellation. |
| `smtp` | production with your own mail server, or a quick start with Gmail | Python's `smtplib` over TLS (465, `ssl`) or STARTTLS (587), with the server's certificate checked against `SMTP_HOST`. Text and HTML alternatives, the logo and the QR code as inline images in a `multipart/related` part, referenced as `cid:` (Gmail, Outlook and Apple Mail show them inside the message). A calendar event is the last alternative, `text/calendar; method=REQUEST` (or `CANCEL`), and the same object as an `invite.ics` attachment: the tree Google Calendar sends and Outlook processes. Connection failures, timeouts and 4xx replies are retried; 5xx replies and a refused sign-in fail at once. Retries carry the same `Message-ID` (`vms-email-<id>@<sender's domain>`). |
| `memory` | backend tests only | keeps messages in memory |

**The sender.** The address of `EMAIL_FROM` is what every message is sent from. With Resend it is on
your verified domain; with Gmail it is the signed-in Gmail address. Its display name
(`Mawdoo3 Visitors <address>` by default; see [§5.4](#54-names)) shows on the test message only: a
company's e-mails are sent under the company's own name, from that same address. It is also the
organizer of every calendar event (Phase 14): give the system a mailbox of its own, not a person's, since
a host whose address it is gets the host's e-mails without the event, and Gmail sends the answers to the
invitations (Yes / No / Maybe) there. For calendar events this is a release condition (see
"Calendars" above).

**Switching to Resend (production):**

1. **Verify a sending domain in Resend** (Resend dashboard → Domains → Add Domain). Resend recommends a
   subdomain, such as `notifications.example.com`, rather than the root domain. Add the DNS records Resend
   shows to your DNS zone: SPF and DKIM (`TXT` records, the DKIM one at `resend._domainkey`) and an `MX`
   or `CNAME` record for the return path (`send.<your domain>` by default). Verification usually takes
   minutes and can take up to 72 hours. Add a DMARC record once the domain is verified. *This summary
   follows Resend's documentation as of 2026-10-06 (resend.com/docs/add-a-domain); always follow the
   values the dashboard shows.*
2. **Create an API key** in Resend, with permission to send.
3. **Configure the API:**

   ```dotenv
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=<the key>
   EMAIL_FROM=Mawdoo3 Visitors <no-reply@notifications.example.com>   # an address on the verified domain
   EMAIL_REPLY_TO=reception@example.com                                # optional
   ```

   The API refuses to start with `EMAIL_PROVIDER=resend` and no key. It does not check the domain: a
   sender on an unverified domain is rejected by Resend, and the invitation then shows as **failed**.
4. **Make the links public.** `QR_BASE_URL` (pass links in invitations) and `APP_BASE_URL` (reset links)
   must be the public `https://` origin that visitors and staff can open.
5. **Send a test message** with `send-test-email`, as in step 4 below.

**Switching to SMTP (Gmail with an App Password):**

1. **Turn on 2-Step Verification** for the Google account that will send the invitations
   (myaccount.google.com → Security).
2. **Create an App Password** at myaccount.google.com/apppasswords. Google shows 16 letters, in four
   groups; you can paste them with or without the spaces. Never use the account's own password: Gmail
   refuses it for SMTP (`535 5.7.8` or `534 5.7.9`).
3. **Configure the API** (`.env` for development, `deploy/env/backend.env` in Compose). Put the App
   Password in that file yourself: never on a command line, in a script or in a chat.

   ```dotenv
   EMAIL_PROVIDER=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURITY=ssl
   SMTP_USERNAME=visitors.yourcompany@gmail.com
   SMTP_PASSWORD=<the 16-letter App Password>
   EMAIL_FROM=Mawdoo3 Visitors <visitors.yourcompany@gmail.com>   # the same address
   ```

   Port 465 with `SMTP_SECURITY=ssl` is TLS from the first byte. The demo uses it because its network
   blocks outbound port 587. Where 587 is open, `SMTP_PORT=587` with `SMTP_SECURITY=starttls` works the
   same way. The port and the mode must match: the API warns at startup about 465 with `starttls`, or 25
   or 587 with `ssl`. Gmail sends every message from the signed-in account: if `EMAIL_FROM` names
   another address, Gmail replaces it (unless it is one of the account's verified "Send mail as"
   addresses), and the API logs a startup warning saying so. Another mail server works the same way
   with its own host, port and credentials.
4. **Restart the API, then send yourself a test message** (from `backend/`):

   ```powershell
   .\.venv\Scripts\python.exe -m app.cli send-test-email --to you@example.com                 # Arabic first
   .\.venv\Scripts\python.exe -m app.cli send-test-email --to you@example.com --language en   # English first
   ```

   It prints the startup warnings, then `test e-mail to … accepted by the mail server
   smtp.gmail.com:465 (ssl)`, the `Message-ID` and the sample's pass address; or the classified error
   with exit code 2, for example `test e-mail not sent (permanent): The mail server refused the SMTP
   sign-in (SMTP 535 5.7.8); check SMTP_USERNAME and SMTP_PASSWORD.` Open the message: the logo heads
   it and the sample QR code shows inside it, as a visitor's pass will. The sample's link opens the pass
   page as an invalid pass, by design. The command needs no database and writes no audit row.
5. **Make the links reachable.** The QR code and the pass link open `QR_BASE_URL/pass?c=…#…` on the visitor's
   phone. `http://localhost:5173` opens nothing there (the API warns at startup when an e-mail provider
   that really sends is combined with a local `QR_BASE_URL`). On a local network use this computer's
   address (for example `https://192.168.1.20:5173` with `npm run dev:https`; see
   [docs/development.md](docs/development.md) §3.1 and "Tablets on the LAN"); in production, the
   public `https://` origin.

The API refuses to start with `EMAIL_PROVIDER=smtp` and no `SMTP_HOST`, with only one of
`SMTP_USERNAME` and `SMTP_PASSWORD`, with credentials and `SMTP_SECURITY=none`, or with an `EMAIL_FROM`
that holds no address; production also refuses `SMTP_SECURITY=none`. The messages name the setting,
never its value. A refused sign-in, a missing STARTTLS or AUTH, an unverifiable certificate or a refused
sender is logged once as `SMTP configuration problem: …` (ERROR, naming the settings to check) until a
message goes through again. Google's published limit for a personal Gmail account is 500 messages a
day (checked 2026-10-07): enough for a pilot; a busy site should use Resend or its organisation's mail
server with its own domain (SPF, DKIM and DMARC, so invitations do not land in spam).

**Delivery behaviour.** Delivery starts after the HTTP response and never slows down or fails the
request. Each message gets at most 3 attempts within 20 s, with 1 s and 3 s between attempts. Resend:
5 s to connect and 10 s per read or write. SMTP: `SMTP_TIMEOUT_SECONDS` (10 s) for the connection and
each reply, and no wait past the 20 s. Up to `EMAIL_DELIVERY_CONCURRENCY` messages are delivered at the
same time. A message still `PENDING` 5 minutes after its last activity is marked `FAILED` ("Sending was
interrupted before it completed."). That happens when its delivery was lost to a restart or crash. The
check runs at startup and every minute. A failed invitation shows under *Needs attention*, and the host
can resend it. A resend replaces the pass, and the previous QR code stops working.

**Testing failures locally:** set `EMAIL_FAIL_DOMAIN=fail.test`. Invitations to `anyone@fail.test` then
fail permanently. This is refused in production.

*What was verified.* No automated check sends real mail. The Resend adapter is covered by unit tests
against a mocked transport, and its request format was checked against Resend's API reference on
2026-10-05 ([phase-2-4-backend.md](docs/decisions/phase-2-4-backend.md), B24-50). The SMTP adapter is
covered by tests against a real SMTP server (aiosmtpd) with STARTTLS, TLS and AUTH, which parse the
message as a mail client receives it and decode its QR code; Gmail's settings were checked against
Google's help pages on 2026-10-07 ([phase-10-backend.md](docs/decisions/phase-10-backend.md)). The demo
delivered through Gmail on port 465 (`ssl`), checked by hand: `send-test-email` and real invitations on
2026-10-07, and the current invitation (final bilingual templates, inline logo) on 2026-10-08, each
accepted by Gmail (`SENT` after one attempt). How it renders in the Gmail inbox is for the mailbox owner
to confirm, and the demo's `QR_BASE_URL` is still `localhost`, so its pass link opens only on the demo
computer ([production-readiness.md](docs/production-readiness.md), L-4 and L-26). Every template was rendered in
both leading languages and checked in Chromium at phone and desktop widths, not in Outlook, Gmail's apps,
Apple Mail or another real mail client.

---

## 11. Demo users

`python -m app.cli seed-demo` creates the company **Mawdoo3** («موضوع» in Arabic, Arabic by default; slug
`demo-company`, time zone `SEED_COMPANY_TIMEZONE`, default `Asia/Amman`), its five departments and six
users. The users are named in Arabic; the departments and the company's address have an English name and
an Arabic one, so the English interface shows English and the Arabic interface Arabic. All of them use
the password **`Demo-Visitor-2026`**, or `SEED_DEMO_PASSWORD` if it is set, and none has to change it at
first sign-in. `seed-e2e` creates the same company with the same addresses, roles and IDs but English
names only, which the E2E suite reads.

| E-mail | Name (`seed-demo`) | Name (`seed-e2e`) | Roles | Department (English / Arabic) |
|---|---|---|---|---|
| `admin@demo.local` | أمل حداد | Amal Haddad | SYSTEM_ADMIN | IT / تقنية المعلومات |
| `host@demo.local` | عمر خليل | Omar Khalil | EMPLOYEE | Finance / المالية |
| `host2@demo.local` | لينا صالح | Lina Saleh | EMPLOYEE | Operations / العمليات |
| `reception@demo.local` | رامي ناصر | Rami Nasser | RECEPTIONIST | none |
| `manager@demo.local` | دينا فرح | Dina Farah | MANAGEMENT + EMPLOYEE (a deliberate multi-role user) | Executive Office / المكتب التنفيذي |
| `management@demo.local` | نور عباس | Nour Abbas | MANAGEMENT (read-only) | Executive Office / المكتب التنفيذي |

Both seeds also create the **platform owner's** demo account, `platform@demo.local` with the same password
(«مالك المنصة» with `seed-demo`, "Platform Owner" with `seed-e2e`), no forced change. Sign in to it at
`/platform/login`; it is not a user of any company and cannot sign in at `/login`.

The fifth department is Human Resources («الموارد البشرية»). `seed-e2e` gives the departments no Arabic
names. The company's address is "Building 14, King Abdullah II Street, Amman 11953, Jordan", and with
`seed-demo` also «مبنى رقم 14، شارع الملك عبدالله الثاني، عمّان 11953، الأردن» in Arabic. The sign-in
addresses keep the reserved `demo.local` domain, so no message to a seeded user can reach a real mailbox
while the demo sends real e-mail.

Both seeds give the demo company **its identity** (Phase 12): the Mawdoo3 logo for light surfaces, the
white one for dark surfaces, the square icon and the colour `#188086`, stored exactly as the platform
owner's uploads would be (`backend/app/seed_assets/`, written from `frontend/public/brand` and
`frontend/public/icons` by `scripts/demo_brand.py`). Its sign-in page is `/c/demo-company`. A re-run
stores nothing again, and a seed never changes an identity the platform owner changed, or one of a company
someone renamed.

`seed-e2e` adds **Other Corp** (`other-corp`, English by default and without an Arabic name):
`admin@other.local`, `host@other.local`, `reception@other.local` and `management@other.local`, with the
same password. The E2E suite uses this second company for its cross-tenant checks. It has no logo, icon
or colour: it is shown by its name and the default palette (`/c/other-corp`).

**Running a seed again** never duplicates anything. On a database seeded earlier, `seed-demo` renames
the demo company and its users to the names above, gives each department its English name with the
Arabic one beside it (a department an earlier `seed-demo` named in Arabic only gets its English name
back), fills in the Arabic company name and gives the address in both languages, unless a person changed
that name or setting in the app; each change is audited without an actor and listed
([phase-10-backend.md](docs/decisions/phase-10-backend.md), B10-10, B10-15, B10-20, B10-27).

> **Local use only.** The demo password is published in this repository. Seeding is refused when
> `APP_ENV=production`, and a seeded database is refused as well: in production the API does not start
> while a demo account exists (they are recognised by the IDs the seeds give them), and it refuses their
> sign-in ([production-readiness.md](docs/production-readiness.md) §13.5). Production starts with
> `create-platform-admin` (the platform owner then creates companies and their first administrators) or
> `create-admin`, and every other user is created in the app with a temporary password that must be
> changed at first sign-in.

---

## 12. Security considerations

A summary for security reviewers. The full description of the controls is in
[docs/security.md](docs/security.md), and the Phase 8 audit with every finding and its fix is in
[docs/security-audit.md](docs/security-audit.md).

- **Authentication.** Passwords are hashed with Argon2id (64 MiB, time cost 3, parallelism 4). The
  policy requires 12–128 characters and rejects a breached-password list, dictionary words and
  account-specific words. Sign-in answers identically for unknown accounts, wrong passwords and inactive
  accounts. Admin-issued temporary passwords expire after 72 hours and must be changed at first sign-in.
- **Sessions.** Sessions are server-side (12 h absolute, 4 h idle) behind `__Host-` cookies (HttpOnly,
  Secure, SameSite). Logout, a password change or reset, and deactivation revoke them immediately.
- **CSRF.** A global middleware checks every unsafe request: `Sec-Fetch-Site`, the `Origin` allowlist,
  and a CSRF token tied to the session. There is no CORS: the SPA and the API share one origin.
- **Authorization and tenancy.** Routes check capabilities, never role lists, and the capabilities come
  from one unit-tested permission matrix. Services add the row-level rules, such as visit ownership.
  Every ID is resolved within the caller's company, and composite foreign keys back this in the
  database.
- **Visitor passes.** A pass is a 256-bit random token; only its SHA-256 hash is stored. It is valid
  only within its visit's window and only for that visit and company. A pass is revoked at check-out,
  on cancellation, on a resend and when the visitor's e-mail address changes. **A QR pass proves an
  invitation, not identity:** reception is prompted to verify ID on every scan.
- **Audit trail.** `audit_logs` is append-only. A database trigger blocks `UPDATE`, `DELETE` and
  `TRUNCATE`, and the runtime role may only insert and read. Denials, failed sign-ins and invalid
  scans are recorded too. Audit metadata holds only IDs, enum values, counts and field names: never
  names, e-mail addresses, phone numbers, purposes, tokens or passwords.
- **Least-privilege database role.** In production the API refuses to start if its role can do more
  than the migrations grant.
- **Fail-closed configuration.** Production refuses unsafe settings at startup: weak or published
  secrets, plain-http origins, insecure cookies, development e-mail providers, SMTP without TLS,
  disabled or ineffective rate limits, over-wide trusted proxies, unverified database TLS and published
  database passwords.
- **E-mail.** SMTP runs only over TLS with the server's certificate verified; the SMTP password and the
  Resend key are secrets that never appear in a log, an error or an audit row. Templates escape every
  value and keep each value in its own text direction; header values lose control characters and line
  breaks of every kind. Messages load nothing remote.
- **A company's identity (Phase 12).** Only the platform owner uploads a logo or icon. Uploads are PNG
  only and are checked and **written again** by the server in pure Python, without an image library: the
  size is judged on the file's header before anything is inflated, inflation is bounded to the image's own
  size (no decompression bombs), nothing may follow the image's end (no polyglots), and text, profiles
  and other extras are dropped. Images are served as `image/png` with `nosniff` and a sandboxing policy.
  The colour is exactly `#rrggbb`, in the database too. The endpoints that need no session answer only
  for active companies, with one 404 for everything else, only the name, language and brand, within a
  budget per client address; they are the only API answers a cache may keep, with the image's version in
  its address. A company's name is the display name of its e-mails' sender, stripped of everything that
  could end the name, carry an address or read as one (`@` and the like in their fullwidth and small
  forms too); the address is always the deployment's. What a name says is not judged: a company chooses
  its name. Uploads in progress are counted by nginx (eight on the site, four from one address), and
  no request keeps a place without being signed in: the API answers it before its body arrives, and
  removing an image is never counted (`docs/security.md` §10.4 and §11.3).
- **Headers.** The SPA is served with a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no inline
  scripts: the one script that runs before the first paint, `/appearance.js`, is a file of its own),
  HSTS, `Referrer-Policy: no-referrer` and `frame-ancestors 'none'`. Its Permissions-Policy is
  `camera=(self), microphone=(), geolocation=()`. API responses are `no-store`, except the successful
  answers of the three public identity endpoints.
- **Open items from the audit:** SEC-05 is deferred. Because e-mail addresses are unique system-wide,
  `POST /users` can reveal that an address exists in another tenant; this is bounded to 20 answers per
  company and hour. SEC-29 is accepted: a reset token can remain in the browser's saved history. The
  audit is not a production sign-off. The deployed stack still needs an independent penetration test
  and monitoring ([security audit](docs/security-audit.md) §1.5 and §7).

---

## 13. Deployment considerations

The full production checklist is in [docs/production-readiness.md](docs/production-readiness.md), and the
operator runbook is in [deploy/README.md](deploy/README.md). The points that most affect planning:

- **Four API processes, one worker each.** The rate limiter and the coalescing of security events live
  in process memory. Every budget except the per-user API budget is counted only by `backend`, so it
  must stay one process; the read processes count only the per-user API budget for the requests they
  receive. Under heavy load a single process missed the 300 ms reception budget; the shipped layout
  held it in every stress run ([production-readiness.md](docs/production-readiness.md) §3.4). Two list
  replicas were measured up to about 180 open reception pages on a quiet host. Watch `duration_ms` of
  `POST /api/v1/reception/scan` and `…/check-in` on `backend`, and of `GET /api/v1/reception/today` on
  the list replicas (target p95 under 300 ms); add list replicas when the list nears it. Replicating
  `backend` needs a shared rate limiter, which does not exist yet ([deploy/README.md](deploy/README.md)
  §4).
- **TLS everywhere.** Camera access needs HTTPS. Production refuses http origins, and needs a verified
  TLS connection to any database not on a network the deployment controls.
- **Host names.** nginx answers only the names in `VMS_SERVER_NAME`. Clients must use the DNS name, never
  the IP address.
- **E-mail.** You need a Resend account with a verified sending domain, or an SMTP server that accepts
  your sender over TLS (§10). Set `EMAIL_FROM` with the display name "Mawdoo3 Visitors", check the
  settings with `send-test-email`, and make `QR_BASE_URL` an address visitors' phones can reach. Monitor
  `email_messages` rows in `FAILED` state.
- **Backups.** Take scheduled `pg_dump` archives (the runbook's example: every 6 hours) and copy them off
  the host, encrypted. Practise a restore every quarter. Banks and government deployments should add WAL
  archiving for point-in-time recovery
  ([phase-9-deploy.md](docs/decisions/phase-9-deploy.md#rpo--rto-guidance)).
- **Maintenance jobs.** Run `prune-sessions` weekly and `prune-journeys` daily (as the owner, from the
  `migrate` service). Before
  each release, run `python3 deploy/verify/check_release_tree.py`; it refuses commits that contain
  development artefacts or credentials.
- **Retention.** Visitors and visits are never deleted; there is no anonymisation feature yet. Set the
  retention periods for visitor data, the audit trail and backups in your data-protection policy.

---

## 14. Documentation map

| Document | Content |
|---|---|
| [docs/initial-assessment.md](docs/initial-assessment.md) | The binding contract: architecture, data model, visit lifecycle, pass rules, security model, API and schemas, testing strategy |
| [docs/decisions/](docs/decisions/) | Every implementation decision and deviation, per phase and area |
| [docs/architecture.md](docs/architecture.md) | How the system is built: layers, request lifecycle, data model, visit state machine, pass design, e-mail pipeline, tenancy, concurrency, frontend |
| [docs/api.md](docs/api.md) | HTTP API reference: endpoints, schemas, error codes, cookies |
| [docs/development.md](docs/development.md) | Repository layout, binding rules, how to add an endpoint, migration or page, the test harness, E2E, troubleshooting |
| [docs/security.md](docs/security.md) | Security controls as implemented, with where each lives and how to check it |
| [docs/security-audit.md](docs/security-audit.md) | Phase 8 security audit report, with dated notes for Phases 9 and 10 |
| [docs/production-readiness.md](docs/production-readiness.md) | Production readiness: gate results, measurements, known limits, go-live checklist |
| [docs/visitor-journey-design.md](docs/visitor-journey-design.md) | Visitor Journey (Phase 15, off by default): data model, state machine, privacy controls, what is blocked |
| [docs/visitor-tracking-integration.md](docs/visitor-tracking-integration.md) | The tracking provider's contract: authentication, events, outcomes, reason codes, what a real adapter needs |
| [docs/visitor-tracking-model-assessment.md](docs/visitor-tracking-model-assessment.md) | Gate 0: the tracking model is not available (BLOCKED BY ENVIRONMENT) |
| [deploy/README.md](deploy/README.md) | Operator runbook for the Docker Compose deployment |
| [frontend/README.md](frontend/README.md) | Frontend scripts, layout and conventions |

---

## 15. Verification status

Run on the reference machine (Windows 11, PowerShell 5.1, Python 3.14.6, Node 24.19, PostgreSQL 18.6)
on 2026-10-06, in throwaway clusters, databases and folders:

- The download command of §4.1 (`Invoke-WebRequest`, 45 s) fetched the PostgreSQL 18.6 EDB zip, and
  `tar` extracted it into the expected `pgsql\` layout. `scripts/db.ps1 init`, `status` and `stop`
  work on a fresh cluster built from it (UTF-8, builtin `C.UTF-8`, server time zone UTC, accented
  `lower()` folding). `-ExecutionPolicy Bypass -File` works as well.
- A fresh virtual environment from `requirements-dev.txt` installs with `--require-hashes`, and
  `pip check` is clean. `npm ci` installs the lock file (180 packages).
- `.env.example` loads as a valid development configuration. `alembic upgrade head` runs `0001`–`0010`,
  and `seed-demo` creates the users of §11 (a second run changes nothing). `create-admin
  --password-stdin`, `mark-no-shows` and `prune-sessions` work.
- `python -m app.serve`, and Vite with the API proxy (also with a `http://localhost:<port>` target, as
  in the default configuration): health directly and through the proxy, and one full flow through the
  proxy. The host invited a visitor; the outbox received the invitation with the
  pass link; reception scanned it (READY), checked the visitor in (the host-arrival e-mail followed) and
  out (pass revoked). The visitor's history showed the visit, management's cancel attempt got 403
  `FORBIDDEN`, and the audit log held the visit's events in order.
- `npm run dev:https` on the LAN address: the page loads over HTTPS, a sign-in from that origin succeeds
  when it is in `ALLOWED_ORIGINS`, and one from an origin that is not gets 403 `CSRF_FAILED`.
- `APP_ENV=production` with the development `.env` refuses to start and names every unsafe setting.
- The backend and frontend suites (§8 gives their later results, from the Phase 10 gate of
  2026-10-08). `npm run e2e:flows` and the camera spec ran against a throwaway cluster through
  `VMS_PG_PORT`. `npm run build`, `vite preview` security headers, `npm run contract:snapshot`
  (byte-identical output) and the backup and restore scripts all work.

**Phase 10 (2026-10-07 and 08), on the same machine:**

- The Phase 10 gate (2026-10-08): every suite of §8, the coverage runs, the production build, the
  deployment checks, `npm audit` and `pip-audit` (0 known vulnerabilities), and nginx 1.30.5 for Windows
  in front of four production-mode API processes configured with `EMAIL_PROVIDER=smtp` and
  `SMTP_SECURITY=ssl` (smoke test 81/81 from two client addresses)
  ([production-readiness.md](docs/production-readiness.md) §10.1).
- An acceptance run in Arabic through the real UI, with its own API, Vite and throwaway database
  (`seed-demo`, outbox provider): all 28 steps of the contract's §40 scenario pass in Arabic, and so do
  the e-mails, the pass page, a walk-in, refused passes, the evacuation list, history, reports, the audit
  log and a switch to English and back. axe ran 138 times at 1440, 820 and 390 px with 0 violations.
  It found three layout defects, listed in [production-readiness.md](docs/production-readiness.md) §14
  (L-21 to L-23) and fixed since.
- `send-test-email` through the SMTP provider to a local capture server (aiosmtpd) printed the
  acceptance line, and the server printed the whole message
  ([phase-10-backend.md](docs/decisions/phase-10-backend.md), verification of S10).

**Phase 12 (2026-10-13), the backend, on the same machine:** the backend gates above; every e-mail
template rendered for seven company identities (with and without a logo and a colour; yellow, black and
near-white colours; a square logo; a very long name) in both leading languages and looked at in Chromium at
680 and 375 pixels (200 screenshots, none wider than its window); and the deployed layout with nginx 1.30.5
for Windows and the repository's configuration in front of three API processes on a throwaway database:
`nginx -t`, the upload's 512 KiB limit on exactly its path and 64 KiB everywhere else, eight uploads in
progress at the most, the public endpoints' caching headers and 304s arriving unchanged, the whole
branding flow of §1.5 with both audit trails, and the smoke test (78 of 78; without its optional
`--http-url` and `--admin-email` checks). Not run for it: Playwright and the frontend's own suites (the
frontend's gate), anything in Docker, and the e-mails in real mail clients.

**Phase 12 after its security review (2026-10-13), on the same machine:** the three findings were
reproduced before they were fixed. With the same nginx and three API processes: eight connections that
nobody was signed in for, each sending one byte every five seconds, kept the platform owner's uploads and
removals at 503 for as long as they stayed (HTTP/1.1 and HTTP/2); after the change every upload and
removal answered 200, also against connections that were opened again as soon as they ended and against
a flood of 79 requests a second. Then `nginx -t` on both renderings, 62 checks against stand-in upstreams,
the 28 checks of the branding flow, 19 checks of what someone signed in meets over HTTP/1.1 (the sizes, a
slow body answered 408 after 30 seconds, the count per address, a removal meanwhile), 14 of the owner's
uploads over HTTP/2, and the smoke test (79 of 79). Live memory after eight refused uploads with the
garbage collector off: 45 MiB before, 0.8 MiB after. Not run: Playwright and the frontend's suites,
anything in Docker ([phase-12-backend.md](docs/decisions/phase-12-backend.md), "After the security
review").

**Phase 12 after its UX review (2026-10-14), the backend, on the same machine:** the backend gates above;
250 e-mails (every kind, both leading languages: eight company colours from yellow to black; a logo as
wide as the header allows, a company named in 90 characters, a pass window that crosses midnight)
rendered with the tree before and after the changes and measured in Chromium at eight widths from 320
to 680 pixels: before, 113 of them were wider than a 320-pixel window and 18 wider than a 375-pixel one
(up to 421 pixels); after, none at any width. 622 screenshots were taken and about eighty looked at, on
contact sheets. Not run for it: Playwright and the frontend's own suites, anything in Docker, and the
e-mails in real mail clients ([phase-12-backend.md](docs/decisions/phase-12-backend.md), "After the UX
review").

**Phase 13 (2026-10-14), the backend (e-mails that read in dark mode), on the same machine:** `ruff`,
`ruff format`, `mypy` clean; `pytest` 4,363 passed and 10 skipped (the opt-in performance checks) in
the default order, and the same with `--committed-first`; the contract snapshot regenerated (one enum,
one optional field in two models); `deploy/verify` 46 OK; the release tree clean. 74 e-mails (every kind
in both leading languages for four kinds of company, the product's test e-mail, and the previews of both
designs) rendered by the real templates and screenshot in Chromium and WebKit at 600 and 320 pixels, in
light, in dark and under a forced inversion like the Gmail app's: 824 pages, none wider than its window,
and 824 header crops on contact sheets, looked at. The largest logo is drawn in 0.3 to 2.0 seconds once
per process (3.7 at 16 bits, which uploads refuse since the review round below). 28 of 30 safeguards
taken out one at a time made a test fail; the other two cannot change an output. Not run for it:
Playwright E2E and the frontend's own suites (its builder's gate), anything in Docker, and the e-mails in
real mail clients ([phase-13-backend.md](docs/decisions/phase-13-backend.md)).

**Phase 13, after its review (2026-10-14, B13-7 to B13-12):** `ruff`, `ruff format`, `mypy` clean;
`pytest` 4,415 passed and 12 skipped (the opt-in performance checks) in the default order; the contract
snapshot unchanged; `deploy/verify` 46 OK; the release tree clean. Logos are uploaded at 8 bits a channel
and drawn ahead of the requests that send them; the worst e-mail is 96,782 bytes with the heaviest logos
(101,655 before), under a 95 KiB guard; the company's name stands beside an emblem in either design. 592
screenshots before and after: 392 byte for byte the same, the rest the light emblems' new header. 10 of
10 fixes taken out one at a time made a test fail ([phase-13-backend.md](docs/decisions/phase-13-backend.md),
"After the review").

**Phase 14 (2026-10-19), the backend (calendar invitations), on the same machine:** `ruff`, `ruff format`,
`mypy` clean; `pytest` 4,635 passed, 12 skipped and 1 failed in the default order (the load-sensitive
timing check of a test-only route, which passed 3 of 3 alone and in the run before), and 4,636 passed and 12 skipped with `--committed-first`; the
contract snapshot regenerated; `deploy/verify` 46 OK; the release tree clean. Every calendar object the
tests write is read back by an independent parser (`icalendar`, a test-only dependency); the messages are
parsed as a real SMTP server (aiosmtpd) receives them. 34 of 34 safeguards taken out one at a time made a
test fail. 12 of the new e-mails screenshot in Chromium and WebKit, light and dark, at 600 and 375 pixels
(96 pages, none wider than its window). No real e-mail was sent: the check in Gmail and Outlook is the
release's ([phase-14-backend.md](docs/decisions/phase-14-backend.md), production-readiness L-29).

**Phase 14, after its review (2026-10-20, B14-15 to B14-25):** `ruff`, `ruff format`, `mypy` clean;
`pytest` 4,688 passed and 12 skipped in the default order (the run before failed one Phase 11 test
whenever a generated temporary password started with "x"; fixed); the contract snapshot regenerated
(`Visit.visitor_calendar_sent`, `VisitInvitation.calendar_failed`); `deploy/verify` 46 OK; the release
tree clean. 28 of 28 fixes taken out one at a time made a test fail. The new withdrawal e-mail
screenshot in Chromium and WebKit, light and dark, at 600 and 375 pixels (32 pages, none wider than its
window).

**Phase 14, after its verification (2026-10-20, B14-26 to B14-34):** `ruff`, `ruff format`, `mypy` clean;
`pytest` 4,727 passed and 12 skipped in the default order (the run before failed only the load-sensitive
timing check of a test-only route, which passed 3 of 3 alone); the contract snapshot regenerated
(`VisitResendResult`); `deploy/verify` 46 OK; the release tree clean. 16 of 16 fixes taken out one at a time
made a test fail; the verifiers' probes pass (one, which assumed a withdrawal that B14-30 removes, prints
the new behaviour).

Run in an equivalent form only: `npm run dev` and `npm run preview` themselves. The same Vite
configuration was started with `npx vite --port …` and `npx vite preview --outDir …` on other ports,
to leave ports 5173 and 4173 to the developers. `Set-ExecutionPolicy` was not run (the machine's
policy already allowed scripts).

Not run there: anything that needs Docker (§9), the Linux and macOS commands (§4.2), real Resend
delivery, an automated check of real Gmail delivery (the demo's was checked by hand, §10), the e-mails in real mail clients, and a physical tablet or camera. The full E2E suite
and the opt-in volume check were not run for this README's own checks. The Phase 10 gate (2026-10-08) executed the full E2E suite on the
same machine, and both performance re-audits of Phase 9 ran the volume check (§8,
[production-readiness.md](docs/production-readiness.md) §10.1).
