# Production readiness

Production-readiness audit of Mawdoo3 Visitors («زوار موضوع»; contract `docs/initial-assessment.md`
§15, Phase 9). Date: 2026-10-06. Updated the same day after two independent re-audit rounds and the
final acceptance run. Updated on 2026-10-07 after the engineering security review of the four-process
layout (§13.1), the fixes that followed the review and re-audit round 2, and the Phase 9 final release
gate. Updated on 2026-10-08 for Phase 10 (the product name and the Mawdoo3 brand, Arabic and English,
the SMTP provider, bilingual e-mail): the Phase 10 gate (§10.1), the acceptance run in Arabic (§10.2)
and the limits it left open (§14). Updated on 2026-10-13 for the security review of Phase 11 (the platform
owner and the companies' e-mail texts, [phase-11-backend.md](decisions/phase-11-backend.md) B11-34 to
B11-50): what production now refuses about demo accounts and how a platform account is recovered (§13.5),
and the go-live items that follow from it (§15 D). The rest of this report describes the system as audited
in Phase 10; Phase 11 itself is described in [security.md](security.md) §3.7, §6.4 and §10.3.

This report is for two readers: a customer's CISO or CTO deciding on go-live, and the operations team
that will run the system. Each statement rests on a measurement or check recorded in this repository,
or says plainly that it was **not verified**. Numbers come from a developer laptop, not from production
hardware.

> **Verdict: ready for a staging deployment and a supervised pilot. Not yet signed off for production
> traffic.**
>
> The application is in good shape. Every automated gate is green in the Phase 10 gate (2026-10-08).
> The contract's §40 acceptance scenario passes all 28 steps, in English in the E2E suite and in Arabic
> through the real UI. Performance targets are met on a dataset of 60,000 visits. Under the heavy
> "stress B" load, a single API process misses the 300 ms reception budget; the shipped layout (four
> API processes behind nginx, two of them for the reception lists) held every reception p95 under
> 300 ms in all 24 stress-B runs with two list processes. No critical or high security finding is
> open. The Arabic acceptance run found three layout defects; they are fixed, each with a regression
> test (§14, L-21 to L-23).
>
> The deployment is a different matter. The Docker images and the Compose stack have **never been
> built or run**, because Docker is not installed on the build machine. That includes the four API
> processes and the list replicas, which were exercised only as plain processes behind nginx for
> Windows. Five more things have not been exercised either: real e-mail delivery through Resend (the
> SMTP path through Gmail was checked by hand in the demo only, with the final templates on 2026-10-08),
> database TLS with `verify-full`, a
> public certificate, monitoring, and an independent penetration test. The e-mails were checked in
> Chromium, not in real mail clients. These are blocking items in the
> [go-live checklist](#15-go-live-checklist). The first staging deployment is where they get closed.

---

## Contents

1. [Summary](#1-summary)
2. [Scope, sources and test environment](#2-scope-sources-and-test-environment)
3. [Performance](#3-performance)
4. [Reliability](#4-reliability)
5. [Logging and monitoring](#5-logging-and-monitoring)
6. [Error handling](#6-error-handling)
7. [Deployment: Docker, nginx and Compose](#7-deployment-docker-nginx-and-compose)
8. [Environment configuration](#8-environment-configuration)
9. [Documentation](#9-documentation)
10. [Testing](#10-testing)
11. [Accessibility](#11-accessibility)
12. [Mobile and tablet responsiveness](#12-mobile-and-tablet-responsiveness)
13. [Security](#13-security)
14. [Known limitations](#14-known-limitations)
15. [Go-live checklist](#15-go-live-checklist)
16. [Open items by owner](#16-open-items-by-owner)

---

## 1. Summary

### 1.1 Status by area

| Area | Status | Key evidence | Main gap |
|---|---|---|---|
| Functional acceptance (contract §40) | **Verified**, in English and in Arabic | All 28 steps pass through the UI, with API and database checks where they matter. The E2E spec passed on the first attempt (retries 0) in every recorded run, the Phase 10 gate included. On 2026-10-08 an acceptance run in Arabic through the real UI passed all 28 steps and the e-mail, pass-page, walk-in, refusal, evacuation, history, report, audit and language-switch checks (§10.2). Its three layout defects are fixed (L-21 to L-23). | Chromium only |
| Automated tests | **Verified** | Phase 10 gate, re-run after the gap closure (2026-10-08): backend 2,974 passed (3 opt-in skips) in both test orders, lines 97.97 % and branches 93.56 % covered. Frontend 1,349 passed, lines 96.55 % covered. E2E 253 tests: 235 passed, 18 skipped by their project conditions, 0 failed, 0 flaky. Deploy unit tests 33 passed. | No CI pipeline in the repository yet |
| Languages and brand (Phase 10) | **Verified** | Arabic (right to left) and English throughout: catalog, hard-coded-text and logical-property tests over all of `src/`; Arabic E2E specs (sign-in and shell, reflow at 360 and 320 px, the printed evacuation list); the Arabic acceptance run. No page, e-mail or subject names "Visitor Management" or the old demo company (that run, and `deploy/verify/test_brand_names.py`). The demo seed's address is Arabic (B10-23). | One wording observation kept (L-28) |
| E-mail (Phase 10) | **Verified against a test server** | Bilingual e-mails with the logo inline, checked through the outbox in the E2E suite and the Arabic run. The SMTP provider is tested against a real SMTP server (aiosmtpd: STARTTLS, TLS, AUTH, the received QR decoded); production mode starts with `EMAIL_PROVIDER=smtp` and `SMTP_SECURITY=ssl`. The demo delivered through Gmail on port 465, checked by hand; Gmail accepted the current invitation (final templates, inline logo) on 2026-10-08. The worst e-mail the texts and values allow stays below 95 KiB with the heaviest logos, clear of Gmail's clipping at about 102 KB (held by a test, phase-13-backend.md B13-8). | Its rendering in the inbox not yet confirmed by the mailbox owner (L-4); no automated real delivery; not seen in real mail clients (L-24; since Phase 13 every e-mail also has a dark design, looked at in Chromium and WebKit only); Gmail's sending limit |
| Calendar invitations (Phase 14) | **Verified against a test server and an independent parser** | The visitor's and the host's events (iTIP REQUEST, then REQUEST with a higher SEQUENCE, then CANCEL) travel as the tree Google Calendar sends and Outlook processes; tested through a real SMTP server, read back by `icalendar`, with no link or token in any event or in the e-mail that carries one ([phase-14-backend.md](decisions/phase-14-backend.md)). | Not seen in Gmail, Outlook or Apple Mail (L-29); with Resend the event is an attachment only; switched off on production (`CALENDAR_INVITATIONS_ENABLED=false`) until a dedicated sending mailbox with SPF, its own DKIM and DMARC (§15 E) |
| Performance | **Targets met**, including the stress scenario with the shipped layout | On 60,000 visits, sequential runs: every endpoint met its p95 budget in all seven re-audit runs. Scan p95 ≤ 55 ms and QR check-in p95 ≤ 67 ms in the last three (target 300 ms). Stress B: one API process misses (check-in p95 up to 823 ms); two list processes held all four reception p95 under 300 ms in 24 of 24 runs. The reception page is interactive in 1.4 s median on a throttled tablet profile (target 3 s). | Laptop numbers on a shared host. The shipped layout was never run in containers or under the Compose CPU limits. |
| Reliability | **Verified after fixes, re-audited twice** | Migrations round-trip with identical data. Backup and restore verified in five drills. When the database hangs, health answers 503 in about 2.1 s. E-mail failures never lose the visit, and lost deliveries become FAILED and visible. Every graceful stop with a stuck request or delivery ended within 26 s, inside the 45 s grace period. | Container shutdown and restart observed only outside containers (Windows, CTRL_BREAK) |
| Logging and monitoring | **Ready to integrate** | JSON logs with no secrets, personal data or query strings. Tenant and user IDs on every authenticated access line. nginx logs which API process group answered (`api_pool`). Health answers within 3 s. A database outage logs one WARNING line a minute, no traceback. Alert list in §5. | No SIEM, alerting or metrics wired up; that is the operator's integration |
| Error handling | **Verified** | One JSON error envelope with a request ID; since Phase 10 a code per field on every 422. 0 server errors in about 135,000 requests of the two performance re-audits and in the E2E backend log; no 5xx in the Phase 10 gate's API logs or the Arabic run. | The API's own 503 has no `Retry-After` header (nginx's does). A request cancelled at the 20 s shutdown limit gets a plain-text 500. |
| Deployment artefacts | **Partially verified** | nginx 1.30.5 (official Windows build) ran in front of the production-mode API: 78/78 smoke checks with one API process, 81/81 with the four-process layout, and 81/81 again on the final configuration (raw-path routing) in the Phase 9 final release gate and in the Phase 10 gate (2026-10-08, with the SMTP provider configured). TLS policy enforced, browser flow with 0 CSP violations. Image build steps ran in equivalent local form. | `docker build` and `docker compose up` were never run; Compose replicas and Docker's DNS never exercised |
| Configuration | **Verified** | Production refuses unsafe settings: 28 of 28 cases, each naming the setting and never its value. Phase 10 added the SMTP refusals (`SMTP_SECURITY=none`, incomplete credentials), each unit-tested | Storing the secrets is the operator's job |
| Documentation | **Verified** | README, architecture, API, development and security guides, operator runbook, all updated to the four-process layout in Phase 9 and to the Phase 10 product (names, languages, e-mail, gates) on 2026-10-08. The API index matches the OpenAPI document (41 operations on 33 paths, re-counted on 2026-10-08). The contract was revised for Phase 10 (revision 3). | The contract and parts of the Phase 8 audit report lag the Phase 8 and 9 changes (§9, §13.3) |
| Accessibility | **Verified** (automated and keyboard checks, WCAG 2.2 AA), **re-audited twice** in Phase 9 | axe finds 0 violations of any severity in 366 page and state checks (Phase 9) and in 138 runs in Arabic and English at 1440, 820 and 390 px (Arabic acceptance, 2026-10-08). Every design-token pair is contrast-tested in all four token sets. The five round-1 defects and the two defects of re-audit round 1 are fixed and were re-measured by the independent re-audit. The two low findings of re-audit round 2 are fixed too (F9-10, F9-11); their E2E checks passed in the Phase 10 gate. | Phase 9's round-2 fixes and Phase 10's screens were not re-audited independently (§11). No screen-reader session. |
| Mobile and tablet | **Verified in emulation** | 0 px horizontal scroll at 1440, 1180, 820, 390 and 320 px, and in Arabic at 360 and 320 px (E2E) and at 1440, 820 and 390 px (Arabic acceptance). Primary touch targets are at least 44 px. The evacuation-list exception on phones and portrait tablets that re-audit round 2 found is fixed (F9-10, §12). Toasts sit at the top centre at every width, clear of the scan result's actions (L-21, E2E at 1440, 820 and 390 px in both languages). | No physical tablet, no Safari/iPadOS |
| Security | **No critical or high finding open** | Phase 8: 49 issues, 47 fixed, 1 deferred (low), 1 accepted (info). Phase 9 sweep: 6 distinct issues, all fixed. Engineering security review of the four-process layout: acceptable with conditions; its routing defect is fixed, its budget property is a suite test, and the read services' settings are pinned by a deploy test (§13.1). Phase 10: adversarial reviews of the SMTP provider and of the language work found 6 defects (2 medium, 4 low), all fixed with tests (§13.1). `npm audit` and `pip-audit`: 0 known vulnerabilities (2026-10-08). | Penetration test of the deployed stack; MFA is outside the contract; sign-off of the layout's per-process budgets by the deploying organisation's security owner (§15 H); Phase 10 was not covered by an independent security audit |

### 1.2 Recommendation

1. **Staging deployment first** on the customer's Linux Docker host, with test certificates. Close
   section B of the [go-live checklist](#15-go-live-checklist): build, compose (both reception-list
   replicas included), smoke test, browser flow and container hardening. Real e-mail delivery
   (section E) is checked on the same stack.
2. **Supervised pilot** at one reception desk with the real tablets, the real mail domain and monitoring
   connected. Re-measure scan, check-in and reception-list latency on production hardware with the
   planned number of open reception pages ([deploy/README.md](../deploy/README.md) §4). Open real
   invitations in the mail clients the visitors and staff use, in Arabic and English. Gmail over SMTP
   suits the pilot;
   production mail should come from Resend or the organisation's own mail server on its own domain.
3. **Production** once every blocking item of §15 is ticked. For banks and government deployments this
   includes the independent penetration test and WAL archiving.

---

## 2. Scope, sources and test environment

### 2.1 Sources

| Source | What it contributed | Recorded in |
|---|---|---|
| Readiness round 1: four independent audits | (a) all quality gates and the full E2E suite; (b) performance on 60,000 visits; (c) operations drills (migrations, backups, outages, e-mail failures, shutdown, logs); (d) accessibility and responsive sweep | Findings summarised here. The fixes are in the three decision files below. |
| Fixes after round 1 | Backend RR1-01 to RR1-11; frontend F9-1 to F9-7; deployment D9-31 to D9-33 | [decisions/phase-9-backend.md](decisions/phase-9-backend.md), [decisions/phase-9-frontend.md](decisions/phase-9-frontend.md), [decisions/phase-9-deploy.md](decisions/phase-9-deploy.md) |
| Readiness round 2 | Every gate and the full E2E suite re-run on the code after the round-1 fixes | This document |
| Re-audit round 1: performance, operations, accessibility | Independent re-measurement of every round-1 finding, with round 1's methods, scripts and seed | Findings summarised here |
| Fixes after re-audit round 1 | Backend RA1-01 to RA1-03; frontend F9-8 and F9-9; deployment D9-34 | The three decision files |
| Re-audit round 2: performance, operations, accessibility | The same three lenses on the code after those fixes | Findings summarised here |
| Fixes after re-audit round 2 | Deployment D9-35 (two reception-list replicas); frontend F9-10 and F9-11 (its two low accessibility findings) and F9-12 (a test-only change). No backend application code changed. | [decisions/phase-9-deploy.md](decisions/phase-9-deploy.md), [decisions/phase-9-frontend.md](decisions/phase-9-frontend.md) |
| Final acceptance run (2026-10-06) | Every gate, the full E2E suite and each §40 step on the code of that day | Superseded by the final release gate |
| Engineering security review of the layout, and its fixes | Verdict and conditions; deployment D9-36 (routing on the raw path) and D9-37 (the read services' settings), backend RT-01 (the routed-reads test) | §13.1; [security-audit.md](security-audit.md) R-1 closure note; the decision files |
| Final release gate (2026-10-07) | Every gate, the full E2E suite, each §40 step, the deploy checks and the nginx smoke test on the final code and configuration | §10 |
| Phase 10 builds, reviews and integration (2026-10-07 and 08) | The product name and brand, Arabic and English, direction C, bilingual e-mail, the SMTP provider, per-field error codes; two adversarial reviews (SMTP; brand and languages) and a design review, each with fixes | [decisions/phase-10-backend.md](decisions/phase-10-backend.md), [decisions/phase-10-frontend.md](decisions/phase-10-frontend.md) |
| Phase 10 gate (2026-10-08) | Every gate, coverage, the build, the full E2E suite, the deploy checks, the nginx smoke test with four production-mode API processes, `npm audit` and `pip-audit`, on the final Phase 10 code | §10.1 |
| Arabic acceptance run (2026-10-08) | The §40 scenario and the e-mail, pass, walk-in, refusal, evacuation, history, report and audit checks in Arabic through the real UI; axe in both languages | §10.2 |
| Phase 9 deployment verification | nginx, PostgreSQL provisioning, backup and restore, image-equivalent build steps, static checks | [decisions/phase-9-deploy.md](decisions/phase-9-deploy.md), [../deploy/README.md](../deploy/README.md) |
| Phase 9 E2E suite | Playwright: the §40 scenario, negative paths, real-camera path, quality checks | [decisions/phase-9-e2e.md](decisions/phase-9-e2e.md) |
| Phase 9 final security sweep | SEC-R1 to SEC-R8 | [decisions/phase-9-backend.md](decisions/phase-9-backend.md), [decisions/phase-9-deploy.md](decisions/phase-9-deploy.md) (D9-29, D9-30) |
| Documentation accuracy check | README and `docs/*.md` claims checked against the running system | §9 |
| Phase 8 security audit | Threat-driven audit of the application | [security-audit.md](security-audit.md) |

**Note on timing.** Round 1 numbers were measured **before** the fixes, and they appear below as
"before" values. Both re-audit rounds repeated the performance benchmark, the operations drills and the
accessibility sweep with round 1's methods, on the code after each set of fixes. Re-audit round 2 is the
last independent measurement:

- It ran on the final backend application code. The changes after it: D9-35 and D9-36 touched Compose
  and nginx (and comments); RT-01 and D9-37 added tests; F9-10 and F9-11 changed the frontend to fix
  the re-audit's two low accessibility findings, and F9-12 changed two frontend tests.
- D9-35's layout was measured by its author. Re-audit round 2 measured the same layout with nginx's
  default round-robin balancing, before `least_conn` was added.
- F9-10 and F9-11 were measured by their author, with the re-audit's method, and are checked by E2E
  specs. They were not re-audited independently.
- The final acceptance run (2026-10-06) re-ran every gate, the full E2E suite and the §40 steps on the
  code of that day. The final release gate (2026-10-07) re-ran them after all of the changes above,
  together with the deploy checks and the nginx smoke test on the final configuration.
- Phase 10 changed the frontend throughout and the backend's e-mail, settings and error details, and
  added one endpoint (`PATCH /auth/preferences`). It did not change the deployment layout or the
  endpoints whose latency the performance audits measured. The Phase 10 gate (2026-10-08) re-ran every
  gate and the nginx smoke test (§10.1). The performance benchmark, the operations drills and the tablet
  load timings were **not** re-run after Phase 10.

### 2.2 Test environment

- Windows 11 laptop, Intel i7-9750H (6 cores, 12 threads).
- PostgreSQL 18.6 (portable) on localhost:5433 with the stock settings (`random_page_cost` 4,
  `work_mem` 4MB, `shared_buffers` 128MB), not the Compose settings. Python 3.14.6, Node 24.19,
  Playwright 1.63 with Chromium. nginx 1.30.5 for Windows for the layout measurements.
- No Docker.
- The machine was shared with other test runs during most measurements. Where that matters, the host
  CPU load is stated.
- The performance, operations and accessibility audits each used throwaway databases and their own
  ports. The E2E suite uses its own `vms_e2e` database and fixed ports (8700, 5199).

---

## 3. Performance

### 3.1 Targets

| Target | Source |
|---|---|
| `POST /reception/scan` and check-in: p95 < 300 ms on seeded data | Contract §11 |
| Other reception endpoints: p95 < 300 ms. All other endpoints: p95 < 800 ms. | Readiness budget |
| Scan → check-in → ready for the next visitor: < 10 s | Contract §10 |
| Reception page interactive: < 3 s on a tablet | Readiness budget |

The 300 ms reception budget covers the reception list that every open reception page polls and the
desk's reload of it, as well as scans and check-ins. The runbook ([deploy/README.md](../deploy/README.md)
§4) now says the same. Round 1's runbook had exempted the list; no owner had approved that, and D9-35
withdrew it.

### 3.2 Dataset and method

- **Seed** (the same generator in every round):
  - 20,000 visitors: 2,000 with Arabic names, 2,000 with accented Latin names (Müller, García,
    Ødegaard) and 3 rare names;
  - 60,000 visits over 401 company-local days (2025-10-01 to 2026-11-05);
  - about 59,900 passes, 54,400 e-mails and 211,200 audit rows;
  - 30 users: 22 hosts, 3 receptionists, 2 management and 3 administrators;
  - a busy "today": 120 expected, 45 inside, 70 checked out, 15 no-shows and 10 cancelled;
  - six frequent visitors with 219–238 visits each;
  - Argon2 hashing with the production parameters.
- **Server:** `python -m app.serve`, one worker per process, development mode. Rate limiting was on;
  only the API and scan per-minute budgets were raised so that the benchmark was not throttled. (Re-audit
  round 1 also raised the successful sign-ins per account, which affects sign-in only.)
- **Client:** httpx keep-alive client, 3 warm-up calls and then 60 timed calls per endpoint. Round 1 ran
  three full runs, re-audit round 1 four and re-audit round 2 three. "Normal day" runs first reset the
  visits the benchmark scripts had created.
- **CPU load from other test suites:** round 1 had a "quiet" run (median 21 %), a "moderate" one (44 %)
  and a "saturated" one (about 100 %). In the re-audits the host load was 14–94 %, recorded per run.

### 3.3 API latency (p95, milliseconds)

Worst p95 of each round's runs. Round 1 is before the fixes.

| Endpoint | Budget | Round 1 (3 runs) | Re-audit 1 (4 runs) | Re-audit 2 (3 runs) | Status |
|---|---:|---:|---:|---:|---|
| `POST /reception/scan` (READY) | 300 | 54.4 | 175.1 | 54.8 | Met |
| `POST /visits/{id}/check-in` (QR; host e-mail queued) | 300 | 63.1 | 179.2 | 66.6 | Met |
| `POST /visits/{id}/check-out` (QR) | 300 | 56.2 | 215.7 | 48.8 | Met |
| `POST /reception/scan` (ALREADY_CHECKED_IN) | 300 | – | 166.9 | 41.1 | Met |
| `POST /reception/walk-ins` | 300 | – | – | 44.3 | Met |
| `GET /users/hosts` (host picker) | 300 | – | – | 13.5 | Met |
| `GET /visits/{id}`, `GET /visitors/{id}` | 300 | – | – | 24.5, 9.4 | Met |
| `GET /reception/today`, normal day (250 visits, about 370 KB) | 300 | 240 | 220.1 | 72.6 | Met |
| `GET /reception/today` at the 200-row list caps (1.19 MB) | 300 | 295 (max 374) | 265 (max 314) | 208 (max 283) | Met. Narrowly before the fixes. |
| `GET /reception/inside` (45 inside) | 300 | 62.9 | 110.4 | 42.7 | Met (215 inside: 100 and 82) |
| `GET /visitors?q=`: reception lookup, worst query | 300 | 70.4 (two letters) | 99.8 (Arabic) | 70.7 (Arabic) | Met |
| `POST /auth/login` | 800 | 562 | 340.9 | 106.6 | Met |
| `GET /auth/me` | 800 | 15.1 | 24.9 | 7.8 | Met |
| `GET /visits?scope=all`: worst filter | 800 | 241 | 272.6 (`q=Garcia`) | 358.1 (`q=` Arabic) | Met |
| `GET /visitors/{id}/visits` (frequent visitor, about 235 visits) | 800 | 102 | 49.2 | 42.6 | Met |
| `GET /reports/summary`, 30 days | 800 | 120.3 | 61.2 | 79.4 | Met |
| `GET /reports/summary`, 366 days | 800 | 777 (max 885) | 439.3 | 380.1 | Met. Near miss under saturation before the fixes. |
| `GET /audit-logs`, first page | 800 | 370 (max 1,024) | 258 | 63.3 | Met |
| `GET /audit-logs`, last 7 days | 800 | 534 | 31 | 31.4 | Met |
| `GET /audit-logs`, page 1,000 | 800 | 661 | 230 | 80.7 | Met |
| `GET /dashboard/admin` | 800 | 113.0 | 74 | 54.5 | Met |

- **Re-audit round 1's highest reception values** (scan 175, check-in 179, check-out 216 ms) are from
  its fourth run, at 52 % host load. Its other three runs stayed at or below 65 ms.
- **Re-audit round 2's 358 ms** for an Arabic history search was one run; a later probe gave p50 57 ms.
- **Visitor search** used the trigram indexes for Latin, accented, case-folded, Arabic and phone
  queries. "Müller" and "muller" return the same rows.
- **No 5xx responses** in about 15,000 round-1 benchmark requests, nor in about 67,000 (re-audit 1) and
  68,000 (re-audit 2) requests including the stress runs.

### 3.4 Concurrency and capacity

Every API process runs one worker, because the rate limiter lives in its memory, and one Python
process runs all its requests in one interpreter. Under load, the desk's scans and check-ins (15–25 ms
of work each) and the reception list (38 ms of server CPU per normal-day list, 101 ms at the caps)
queue behind each other and behind the analysts' reads. The layout therefore changed twice after round
1 (D9-34, D9-35). Compose now runs four API processes, and nginx shares the requests out by method and
path:

| Service | nginx sends it | Processes |
|---|---|---|
| `backend` | every sign-in, every write (scans and check-ins included) and every request not listed below | exactly one |
| `backend-reception` | `GET /api/v1/reception/today` and `/inside`, each to the replica with the fewest requests in progress (`least_conn`) | two replicas |
| `backend-reports` | `GET /api/v1/reports/summary`, `/audit-logs`, `/dashboard/admin` and `/visits` | one |

**Other scenarios:**

| Scenario | Result | Status |
|---|---|---|
| **A, realistic:** 10 tablets polling every 15 s, 2 analysts with a 2 s pause, desk scanning | Round 1: scan p95 38 ms, check-in 45 ms. Re-audit 1 (one process, 4 runs): scan 31–52, check-in 41–81 ms. Re-audit 2 (47 runs over all layouts): scan 28–75, check-in 29–94 ms. | Met |
| A synchronised burst of 10 "today" polls | p50 675 ms (round 1), 599–966 ms (re-audit 1) | Information |
| About 100 open reception pages on one process: 20 tablets every 3 s with jitter (6.7 polls/s), 2 analysts with a 2 s pause, desk back to back (re-audit 1, 2 runs) | scan p95 116 and 124, check-in 125 and 126, desk reload 155 and 267, list poll 247 and 348 ms | Scan and check-in met; list poll over 300 ms in one run |
| Login burst: 30 simultaneous correct sign-ins | 30 × 200 in every round; p95 2.1–2.3 s (round 1), 1.81–1.88 s (re-audit 1), 2.0–2.1 s (re-audit 2) | Met |
| Login burst: 60 simultaneous from one IP address | 38, 40 and 30 × 200, the rest 429 (round 1, re-audit 1, re-audit 2) | See §14 (L-10) |

**Stress B:** 6 tablets poll `/reception/today` every second (about 90 open reception pages); the desk
scans, checks in and reloads the list back to back; 3 analysts run history searches, audit pages and
the dashboard with no pause. p95 in ms, range over the runs. The last column counts the runs in which
all four (scan, check-in, desk reload, list poll) were under 300 ms, unless it says otherwise.

| Layout | Measured by | Runs | Scan | Check-in | Desk reload | List poll | All four < 300 ms |
|---|---|---:|---|---|---|---|---|
| One process, before the fixes | Round 1 | – | 368.5 | 478.6 | – | 546–654 | **Missed** |
| One process | Re-audit 1 | 8 | 198–491 | 215–823 | 276–744 | 369–1,169 | 0 (scan alone 5, check-in alone 3) |
| One process | Re-audit 2 | 8 | 98.5–442.1 | 184.0–695.4 | 205–455 | 258–776 | at most 1 (scan 6, check-in 4, poll 1) |
| Analysts on a second process (round-1 advice, D9-33) | Re-audit 1 | 6 | 142–628 | 163–744 | 248–746 | 340–1,416 | 0 (scan and check-in both: 2) |
| Analysts on a second process | Re-audit 2 (quiet host, 18–48 %) | 6 | 77–142 | 89–187 | 138–206 | 269–441 | 2 |
| Three processes behind nginx (D9-34) | Re-audit 2 | 8 + 4 | 33–89 | 39–91 | 203–530 | 293–697 | 1 of 12 (scan and check-in: 12 of 12) |
| Three processes, clients sent straight to each | Re-audit 2 | 8 | 38.0–62.3 | 46.8–89.4 | 194–552 | 289–617 | at most 1 (scan and check-in: 8) |
| Two list processes behind nginx, round-robin | Re-audit 2 | 4 | 39.8–44.5 | 48.2–53.2 | 142–185 | 196–249 | **4** |
| One list process (D9-34), interleaved with the rows below | D9-35 author | 8 | 32–68 | 42–85 | 149–495 | 160–528 | 6 |
| The same, with 5 CPU-spinning processes (78–79 % host CPU) | D9-35 author | 4 | 35–40 | 43–48 | 168–199 | 179–227 | 4 |
| **Two list replicas, `least_conn` (shipped, D9-35)** | D9-35 author | 8 | 32–53 | 40–70 | 118–176 | 140–206 | **8** |
| The same, with 5 CPU-spinning processes (79–80 % host CPU) | D9-35 author | 4 | 33–40 | 43–50 | 128–158 | 146–186 | **4** |
| Two list replicas, round-robin | D9-35 author | 8 | 33–50 | 44–71 | 110–177 | 127–199 | **8** |

- **One process fails under stress B.** In both re-audits, scan and check-in missed the 300 ms budget
  in a quarter to nearly two thirds of the runs, and the list poll in 15 of 16. The time is spent queueing
  inside a process: in re-audit 2's three-process runs, the one list process's own `duration_ms` p95 for
  `/reception/today` was 385 ms (6,057 requests).
- **Three processes (D9-34)** fixed scan and check-in: 12 of 12 re-audit runs, at host loads up to 94 %.
  The list poll still missed in 11 of 12. D9-34's author had measured scan and check-in within budget
  in all 16 of its own three-process runs, direct and through nginx (scan p95 31–73 ms, check-in
  44–98 ms).
- **Two list processes (D9-35)** held all four in every run: 4 of 4 in the re-audit (round-robin) and
  20 of 20 by D9-35's author (12 with `least_conn`, 8 round-robin). The one-list-process runs
  interleaved with them missed in 2 of 8, at 52–54 % host CPU (load from other test runs; with
  artificial CPU-spinning load they held in 4 of 4). The shipped `least_conn` form was
  **not** re-audited independently.
- **Method notes.** The audits' stress harness, unchanged since round 1 for comparability, made all
  three analysts administrators, so the 366-day report never ran during their stress B runs. No request failed
  and no database pool timed out in any stress run.

**Throughput and cost of one process** (4 clients in a closed loop for 20 s; CPU measured on the API
process):

| Measure | Round 1 | Re-audit 1 | D9-34 author (frozen code) | Re-audit 2 |
|---|---:|---:|---:|---:|
| `/reception/today`, requests/s | 9.5 | 12.4 | 18.9 | 24.3–26.3 |
| `/reception/inside`, requests/s | 23.7 | 25.5 | 56.3 | 61.8–63.4 |
| `/auth/me`, requests/s | 211.6 | 202.2 | 262.2 | 261.0–269.6 |
| Server CPU per normal-day `today` list (370 KB) | – | 46.1 ms | – | 38.3 ms |
| Server CPU per `today` list at the caps (1.19 MB) | – | 143 ms | – | 100.8 ms |

**Capacity guidance.** [deploy/README.md](../deploy/README.md) §4 is the single source. In short:

- Two list replicas were measured up to about 180 open reception pages on a quiet host. At 12 polls a
  second, the poll p95 was 212–249 ms with one list process, 169–182 ms with two and 149–173 ms with
  three, and all four p95 stayed under 300 ms in every run.
- Two replicas were measured up to about 90 open reception pages at up to 80 % host CPU.
- Beyond that, add a replica: each adds 1 CPU, 512 MiB, 10 database connections and another 600 list
  requests a minute per user.
- Watch `duration_ms` of scan and check-in on `backend`, and of `GET /reception/today` on each list
  replica (§5.3).

These figures come from plain processes on a shared laptop. Re-measure on production hardware with the
Compose limits.

### 3.5 Database plans: findings and fixes

"After" values are from the two re-audits.

| Finding | Before | Fix | After |
|---|---|---|---|
| Every visit list sequentially scanned **all** passes ever issued, so the cost grew with history (round 1) | 8.73 ms per list at 60,000 passes (extrapolated: about 90 ms at 600,000) | Index `(company_id, visit_id)` on `visitor_passes`, revision 0010 (RR1-01) | Index scan: 0.12–0.16 ms for 25 visits, 1.1–1.2 ms for 300. The prepared (generic) plan is the same index scan. |
| The audit log's date filter had no index (round 1) | 147 ms for a 7-day count | Index `(company_id, created_at)` on `audit_logs`, revision 0010 (RR1-07) | Index-only scan, 0.9–1.0 ms. Endpoint p95 15–31 ms (was up to 534 ms). |
| Audit pagination counted every row on every page (round 1) | 311 ms (parallel sequential scan of 211,000 rows) | Counts only when the page is full or past the end (RR1-07). The count then runs without parallel workers (RA1-02, after re-audit 1). | After RR1-07: parallel index-only scan, median 84–92 ms, single runs up to 201 ms. After RA1-02: serial index-only scan, 15–24 ms; first page p95 47–63 ms. Still linear in the trail (L-7). |
| The 366-day report made five passes over a year and spilled to disk (round 1) | External merge sort of 3 MB, about 96 ms for the totals alone | Two statements with `GROUPING SETS` and a hash-based distinct count (RR1-06) | Two statements, no disk spill at `work_mem` 4MB. Totals 74–76 ms, breakdowns 69–75 ms; endpoint p95 293–439 ms. The Compose settings do not regress it (74 vs 79 ms). |
| History search for a common surname scanned all of `visits` (round 1) | 18.9–42 ms per statement at `random_page_cost` 4 | Compose PostgreSQL settings: `random_page_cost` 1.1, `work_mem` 16MB, `shared_buffers` 512MB, `effective_cache_size` 1536MB (D9-31) | On the stock development cluster it still scans (18–36 ms per statement, two statements per request). With the Compose planner settings applied per session: index plans, 6.6–12 ms. Not checked on a live server with those settings. |
| Needs-attention list: two correlated subplans (round 1) | 54–77 ms | Not changed | 20–31 ms (bounded by open SCHEDULED visits, not by history); endpoint p95 66–98 ms |
| `GET /reception/today`: building the views dominated the per-poll CPU (re-audit 1) | 46.1 ms of server CPU per normal-day list, 143 ms at the caps | Column rows instead of ORM entities, one array parameter per lookup, shared parts built once per response, UTC rendered by Pydantic (RA1-01). Response bytes identical. | 38.3 ms and 100.8 ms (re-audit 2). The fixer measured 35–45 % less in alternating runs. Slowest statement 3.5 ms. The payload is unchanged (L-6). |

The opt-in volume check seeds passes, e-mails and a realistic reception day (RR1-08). It asserts:

- no plan reads `visitor_passes` sequentially, nor `audit_logs` for the 7-day filter;
- the audit count's plan has no parallel `Gather` (RA1-02);
- the year-long report never spills to disk;
- `/reception/today`, scan and QR check-in stay under p95 300 ms.

It passed (3 tests) in both performance re-audits, in 39.7 s and 45.2 s. Their `/reception/today`
p95 was 108.9 and 66.1 ms, scan p95 21.6 and 37.2 ms, and QR check-in p95 34.0 and 50.3 ms.

### 3.6 Frontend load

Measured on a tablet profile: 820 × 1180, device pixel ratio 2, CPU throttled ×4, no network
throttling unless stated. Ten runs each (five at the caps, six with the Wi-Fi profile). Round 1
measured the build before the F9 bundle changes; the re-audits measured the F9 build.

| Measure (ms) | Round 1 | Re-audit 1 | Re-audit 2 | Target | Status |
|---|---|---|---|---|---|
| `/login` first and largest contentful paint, median / p95 | 696 / 917 | 526 / 661 | 618 / 985 | (report) | Good; total blocking time 0 ms |
| `/reception` (signed in) interactive, pass entry and today's counts shown, median / p95 | 1,392 / 1,722 | 1,184 / 1,257 | 1,362 / 1,426 | < 3 s | Met |
| `/reception` at the list caps (1.19 MB "today"), median / max | 1,676 / 1,769 | 1,271 / 1,488 | 1,305 / 1,419 | < 3 s | Met |
| `/reception` with a Wi-Fi profile (20/5 Mbit/s, 40 ms RTT), median / p95 | 1,804 / 1,896 | 1,474 / 1,554 | 1,636 / 1,732 | < 3 s | Met |
| Main-thread cost of the 15 s poll, Scan tab (normal day / caps) | none / 116 | none / 88 + 87 | none / 95 | No long input blocking | Information (L-6) |
| The same, Expected tab (normal day / caps) | 271 + 163 / 658 + 96 | 232 / 611 + 83 | 215 + 282 / 567 + 85 | | Information (L-6) |

One re-audit-1 set taken under heavy host load, on a day the stress scripts had bloated to an 823 KB
list, gave `/reception` interactive median 2,708 ms and p95 4,817 ms. It is outside the comparable set.

**Download size after F9-1 and F9-2:**

| Measure | Before | After (re-audits) |
|---|---|---|
| Start-up set for `/login` (raw / gzip) | 710.6 / 209.7 KiB | 489.6 / 146.7 KiB (126.9 KiB brotli), 11 requests |
| Entry chunk (raw / gzip) | 268 / 78 kB | 10 / 3.4 kB |
| First `/login` visit: files the service worker fetched a second time | 709 KiB | none (the HTTP cache answered) |
| A deploy that changes one page | 2,207 KiB downloaded again | 22.8 KB compressed in a simulated one-page deploy. A real deploy between two builds (16 renamed files): 85,626 B in 24 requests. The wasm was not downloaded again. |
| The visitor's `/pass` page on their own phone | 2,681 KiB and a service worker installed | 13 requests, 160,970 B transferred, no service worker |

- The self-hosted zxing decoder is 1,093,289 bytes (462,406 gzip). Only staff devices fetch it, once
  per decoder version, not once per deploy.
- All JavaScript is 835.6 KiB raw and 283.1 KiB gzip in 74 chunks (round 1: 804.3 / 247.1 KiB in 10
  chunks). The many small chunks caused no load-time regression; nginx serves HTTP/2.

**The Phase 10 build** (2026-10-08, after the gap closure; Vite's kB, raw / gzip; not comparable byte for byte with the KiB
figures above, and not measured on the tablet profile):

| Measure | Size |
|---|---|
| Everything `index.html` loads: 7 JavaScript files and the stylesheet | 742.13 / 213.95 kB (JavaScript 652.38 / 197.68) |
| Start-up `app` chunk, with both languages' catalogs | 258.24 / 73.46 kB |
| `react` / `router` / `query` / icons chunks | 218.84 / 68.25, 97.34 / 31.97, 34.92 / 10.21, 32.08 / 9.89 kB |
| Entry chunk | 10.38 / 3.54 kB |
| Stylesheet | 89.75 / 16.27 kB |
| zxing decoder (staff devices that scan) | 1,093.28 / 463.82 kB |
| The whole `dist/` | 96 files, 2,462,796 bytes; 77 hashed JavaScript chunks, 1,097,225 bytes |

The start-up set grew in Phase 10: both languages' catalogs ship in the `app` chunk so that the first
render is already in the right language and a switch downloads nothing (F10-1), and the two
self-hosted fonts load only for the characters on screen. The tablet timings above were measured on the
Phase 9 build and were **not** re-measured; loading only the UI language's catalogs is a possible
follow-up.

### 3.7 Reception end to end

The time from scan to check-in to "ready for the next visitor" was measured in every E2E run.

| Measurement | Result | Final release gate |
|---|---|---|
| §40 scenario (pasted pass, tablet) | 2.9–3.3 s | 2.9 s |
| Real-camera path (tablet) | 2.5–3.2 s | 3.2 s |
| Scan-timing spec at 1440, 820 and 390 px | 2.50–2.97 s | 2.76–2.85 s |

- Every run is far below the 10 s target.
- Each figure includes the app's deliberate success display of about 1.5 s.
- The browser-measured scan response, through the Vite development proxy with 4 parallel workers, was
  278–556 ms (339–488 ms in the scan-timing spec of the final release gate).

### 3.8 Not measured

- Production hardware.
- Linux containers with the Compose resource limits (1 CPU per list replica), and Docker's DNS handing
  nginx the replica addresses.
- A managed PostgreSQL, and the Compose PostgreSQL settings on a live server (they were applied per
  session for the plan comparisons).
- Real network latency between the tablets and the server.
- The 366-day report during stress B (see the method notes in §3.4).
- An independent re-audit of the shipped `least_conn` balancing.
- A login storm with the Compose value `PASSWORD_HASH_CONCURRENCY=4`; the benchmark had 12 hash slots.
- Anything after Phase 10: the benchmark and the tablet load timings ran on the Phase 9 code. The Arabic
  acceptance run measured one scan-to-ready time in Arabic on the 820 px tablet: 2.4 s.

---

## 4. Reliability

### 4.1 Migrations

There are 11 Alembic revisions (0001–0011). Migrations run as the schema owner in a one-shot
container, never as the API's runtime role. The drills below ran at head 0010. Revision 0011 (Phase 10:
three language columns, a nullable column or one with a constant default, so no table rewrite) is
covered by the suite's migration tests: the model-and-schema comparison, the downgrade-then-upgrade test
with its privilege comparison, the CHECKs as the runtime role, and its downgrade guard for each kind of
value (B10-1).

| Check | Round 1 | Re-audits 1 and 2 (head 0010) |
|---|---|---|
| Empty database → head | 1.79 s (then at 0009) | 2.23–2.28 s (0001 → 0010) |
| Downgrade head → 0005 on a volume database | 1.71 s (141 MB: 60,006 visits, 20,006 visitors, 120,063 audit rows) | 1.78–3.59 s (60,253 visits, 20,003 visitors, 195,997 audit rows, 60,035 passes, 46,275 e-mails) |
| Upgrade back to head | 2.07 s | 2.84–3.45 s |
| Data through that round trip | Counts and per-row MD5 identical in 10 of 10 tables | The same. Only `users.device_trust_epoch` is re-randomised, by design (revision 0009). |
| Schema catalog before and after the round trip (columns, constraints, indexes, triggers, functions, ACLs) | 0 differences | 0 differences |
| `alembic check` | No drift between the models and the migrations | No drift |
| Lossy downgrade with blocking data present | Refused atomically: the database stays at the newer revision and its data and schema are unchanged | Refused atomically with a walk-in visitor and a PASSWORD_CHANGED row present, the 0010 and 0009 steps included |

**Operational notes:**

- Run downgrades only with the API stopped. Lossy downgrades are refused by design.
- Revision 0010 uses plain `CREATE INDEX`, which blocks writes to the table while it builds. Before
  upgrading a deployment that already holds large tables, create both indexes `CONCURRENTLY` first. The
  statements are in the migration's docstring; the migration then leaves them as they are.

### 4.2 Backups and restore drill

- **Scripts:** `scripts/backup.ps1` / `backup.sh` take a `pg_dump` custom-format archive plus a
  `.sha256` checksum. `scripts/restore.ps1` / `restore.sh` restore **only into a new database**. They
  then verify the checksum, the schema revision, both triggers, the runtime role's privileges and the
  row counts. Each script has a `--compose` mode for the Docker host.
- The archives hold personal data, password hashes and the audit trail. Copy them off the host,
  encrypted.

| Drill | Result |
|---|---|
| Deployment verification, 208 MB database | 27.5 MiB archive. Backups 4–11 s, restores 8–24 s. Both script families restored identical per-table data checksums, constraints, triggers, indexes, grants and append-only rules. The production-mode API ran on the restored copy and passed the 78-check smoke test. |
| Operations audit (round 1), 141 MB volume database | `backup.ps1`: 5.7 s, 15.8 MiB. `restore.ps1`: 13.4 s including verification. 10 of 10 tables identical. Runtime-role refusals, audit trigger and terminal-visit trigger all work. Passes issued before the backup scan with the correct outcomes. |
| Deployment readiness round, at revision 0010 | Both scripts on both platforms restored and verified revision 0010. The production API started on the restored database. |
| Re-audits 1 and 2, volume database at 0010 (60,253 visits, 196,000 audit rows, 60,035 passes) | `backup.ps1`: 6.1–9.8 s, about 29 MiB, 125–126 archive entries, `.sha256` written. `restore.ps1`: 14.7–25 s including verification (checksum, revision 0010, both triggers, runtime privileges, row counts); the 25 s run shared the host with other test runs. An independent comparison found 10 of 10 tables identical. The catalog differed only cosmetically, plus the restore's intended hardening (`PUBLIC` CONNECT replaced by the runtime role's grant). The runtime role's refusals and both triggers work on the copy. The API served sign-ins there and scanned passes from before the backup with the correct five outcomes. |
| Refusals | An existing target database and a tampered archive (checksum mismatch) are refused, and nothing is created. Confirmed again in both re-audits. |
| **Not verified** | `--compose` mode (needs Docker). Linux file modes 0600/0700 (NTFS has no equivalent). |

**Recovery objectives** ([decisions/phase-9-deploy.md](decisions/phase-9-deploy.md), "RPO / RTO
guidance"):

- **RPO with logical dumps alone** equals the dump interval. The runbook's example runs every 6 hours.
- **Banks and government** should add continuous WAL archiving (pgBackRest or WAL-G) for an RPO of about
  1 minute, and keep the logical dumps as an independent second line.
- **RTO** is detection, then provisioning, then restore (8–25 s for databases of 141–208 MB on the
  laptop), then the switch-over. Measure it per GB in your own quarterly drill on production hardware.

### 4.3 Database outages

| Scenario | Round 1 (before the fixes) | Re-audits 1 and 2 (after RR1-03 and RA1-03) |
|---|---|---|
| Database missing | 503 `SERVICE_BUSY` in 90–253 ms, no traceback, no credentials in the log | 503 in 11–211 ms; sign-in 503 in 70–198 ms; no credentials. Re-audit 1 found one ERROR record with a traceback from the new interrupted-delivery sweep. After RA1-03 (re-audit 2): one WARNING line, 0 ERROR records, 0 tracebacks. |
| Connections reset, then the database returns | 503 in 17–43 ms, no 500s. Healthy again 0.2 s after the database returned. Sessions survived. | 503 in 3–44 ms on six endpoints, 0 × 500, 0 tracebacks. Healthy again 0.15–1.03 s after the database returned (the health result is reused for 1 s). Sessions survived. |
| Database accepts TCP but never answers: `GET /health`, 45 concurrent | 503 only after 30–130 s; 40 worker threads blocked | 45 × 503 in 1.99–2.11 s |
| Same, sign-in, 45 concurrent | – | 30 × 503 and 15 × 429 in 0.16–10.46 s (median 5.16 s). The worst case is about `DB_POOL_TIMEOUT_SECONDS` + `DB_CONNECT_TIMEOUT_SECONDS`: waiters get a pool slot when the first connects fail, then wait for their own. (The fixer's first figure, ≤ 5.7 s, was too low.) |
| Same, an endpoint that needs no database | 25.2 s | `GET /auth/me` 401 in 19–40 ms |
| Same, log output over 130–140 s with no traffic | – | Re-audit 1: three ERROR records with a 145-line traceback each, from the sweep. Re-audit 2: one WARNING line per sweep run (at start-up, +65 s, +130 s), 0 tracebacks. |
| Connection pool exhausted | 500 `INTERNAL_ERROR` with a traceback | 503 `SERVICE_BUSY`. 40 concurrent heavy reads: all 200 (max 3.1–3.7 s). 80 concurrent: all 200 in re-audit 2; 79 × 200 and 1 × 503 in re-audit 1, which is intended load shedding far above the planned load. |
| Production start with the database unavailable | Exit code 3 in 2.3–2.9 s; the message names no URL or password | Exit code 3: 2.3–2.6 s for a missing database or a wrong password, 6.8–9.3 s for a refused port or a black hole. The message names no URL or password. |

- On this Windows host, a connection to `localhost` with the 5 s connect timeout can take 10 s,
  because libpq tries `::1` and then `127.0.0.1`. A development start against a database that never
  answers serves after about 7 s, because the start-up sweep waits out the connect timeout first.
- Two ERROR records with a traceback remain during a black-holed outage, and they are deliberate:
  "could not write security audit event", when a security event cannot be stored (a `RATE_LIMITED`
  event and the shutdown flush). `app/services/audit.py` logs a lost audit event with its traceback on
  purpose.

**Bounds now in place** (defaults, all configurable):

| Setting | Default |
|---|---|
| `DB_CONNECT_TIMEOUT_SECONDS` | 5 |
| `DB_POOL_TIMEOUT_SECONDS` | 5 |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 |
| `DB_LOCK_TIMEOUT_MS` | 10000 |
| TCP keepalives | idle 30 s, interval 10 s, count 3 |
| `tcp_user_timeout` | 30 s (Linux) |

**Not measured:** a query on an already pooled, half-open connection after a database failover. The
keepalives, the TCP user timeout and the statement timeout bound it by reasoning.

### 4.4 E-mail failure handling

**Design:**

- Creating a visit writes a PENDING `email_messages` row in the same transaction. Delivery runs after
  the response, in up to `EMAIL_DELIVERY_CONCURRENCY` (4) threads reserved for e-mail. Request threads
  are never used for it (RR1-02).
- Transient errors (429, 5xx, timeouts) get 3 attempts with 1 s and 3 s backoff and the same
  Idempotency-Key. Each message has an overall deadline of 20 s.
- Permanent errors stop after 1 attempt.
- A visit is never lost because of an e-mail. Real Resend delivery was simulated with a scripted
  endpoint, never sent for real.

| Case | Result |
|---|---|
| Resend answers 503 three times | Visit created (201) in 265–506 ms. Row FAILED after about 4.2 s with 3 attempts, backoff 1.02–1.03 s and 3.02–3.04 s, one Idempotency-Key. The same in round 1 and both re-audits. |
| 429 three times | FAILED after 3 attempts (about 4.1–4.2 s) |
| 422 or 401 (permanent) | FAILED after 1 attempt |
| 503, then 200 | SENT after 2 attempts |
| Provider never answers | **Before:** each message took 49.5 s, and 40 hanging deliveries froze the whole API (`/health` took 43.2 s; the 41st `POST /visits` got no answer within 30 s). **After RR1-02, in both re-audits** (60 invitations through a black-holed proxy to the real Resend adapter): every `POST /visits` got 201 (the first 40: median 44–83 ms). `/health` stayed 200 throughout the 307–309 s drain. With 40 deliveries hanging, the 41st `POST /visits` got 201 in 55–58 ms, and a burst of 19 concurrent ones all got 201. Each message ended FAILED after 2 attempts in 20.0–20.1 s, four at a time. The sweep closed none of them early. |
| The visit when its invitation failed | Stays SCHEDULED, its pass scans READY, and it is listed under **Needs attention** (4 of 4 cases). INVITATION_FAILED is audited with the recipient's domain only. |
| Manual resend after a failure | SENT. The old pass answers 410 `PASS_REVOKED`, the new pass scans READY, and the visit leaves Needs attention. |
| Wrong address corrected (development fail domain) | FAILED, then re-sent automatically after the correction: SENT. The E2E invitation-failure spec covers this too. |
| Process killed during a delivery | **Before:** the row stayed PENDING forever and never appeared under Needs attention. **After RR1-04, in both re-audits:** PENDING and not listed for the first 5 minutes, by design. A sweep at start-up and every 60 s then marked it FAILED ("Sending was interrupted before it completed."), 305–313 s after the kill, and audited INVITATION_FAILED with `reason: interrupted`. The visit then showed under Needs attention and on the dashboard count, and the resend worked. |
| Resend while an older invitation is still PENDING | **Before:** the old row stayed PENDING forever. **After:** it is closed as FAILED ("Replaced by a newer invitation.", `reason: superseded`) and does not show under Needs attention. |
| Several API processes sweeping at once (Compose runs four) | Three sweeps forced to overlap on a held row lock: one closed all three rows, the others none; exactly one INVITATION_FAILED per message (re-audit 2). The sweep's query is an index scan of 0.56 ms on the volume database. |

No API key, recipient address or provider message appeared in the logs or the audit metadata.

**The SMTP provider (Phase 10)** uses the same dispatcher, slots, deadline and retries
([decisions/phase-10-backend.md](decisions/phase-10-backend.md), S10-1 to S10-13):

- **Transient:** refused or reset connections, DNS failures, timeouts, TLS handshake failures other than
  certificate verification, and every 4xx reply (Gmail's `421 4.7.0` included). **Permanent:** every 5xx
  reply, a refused sign-in (`535`, Gmail's `534 5.7.9`), no STARTTLS or AUTH offered, and an
  unverifiable certificate. The stored error names the stage and the reply code only, never the
  server's text (which repeats the address) or a credential.
- **The deadline is absolute:** every wait gets at most the time left of the message's 20 s, also for a
  server that trickles its reply. The review fixes measured it with the production values: a greeting
  trickled over 45 s now ends FAILED after 20.0 s instead of SENT after 45 s (S10-10).
- **One sign-in attempt per message:** a wrong App Password costs one refused AUTH per message, logged
  once as `SMTP configuration problem: …` with what to check, until a message is sent again (S10-4,
  S10-12).
- **Duplicates:** SMTP has no idempotency key. A retry after a reply lost in transit can deliver a second
  copy with the same `Message-ID` and pass (S10-9).
- **Verified** against real SMTP servers on the test machine (aiosmtpd: STARTTLS, implicit TLS, AUTH,
  scripted replies, silent and slow servers): the received message parsed, its logo and QR images
  present and the QR decoded to the pass URL. Through the API and the database: an invitation SENT with
  the provider's `Message-ID`, a 550 FAILED at once under Needs attention, a 451 at DATA retried and
  sent, a silent server ended at the deadline. The Phase 10 gate started the four production-mode API
  processes with `EMAIL_PROVIDER=smtp` and `SMTP_SECURITY=ssl`. Real delivery: through Gmail on port 465
  in the demo, checked by hand on 2026-10-07, before the final bilingual templates (L-4); no automated
  check sends real mail.

### 4.5 Restart, crash and shutdown

| Scenario | Result |
|---|---|
| `kill -9` during an e-mail delivery | Process tree gone in 0.11–0.25 s. No leftover PostgreSQL backends and no idle-in-transaction sessions. Healthy again 1.5–3.7 s after restart. Sessions survive, because they live in the database. |
| Graceful stop, nothing in flight | Exit 0.2 s after the stop signal. The coalesced security-event counts are written to the audit log. |
| Graceful stop with a request in flight | New connections refused at once. The in-flight request finishes (200), and the process exits 0.07–0.23 s later. |
| Graceful stop while e-mails retry against a silent provider | **Before:** 48.3 s, beyond the 30 s Compose grace period, so the SIGKILL lost the flush. **After D9-32** (`timeout_graceful_shutdown` 20 s, `stop_grace_period` 45 s, `init: true`), in both re-audits: with one delivery, exit after 18.0 s, the message FAILED within its 20 s deadline. With ten, exit after 20.3–20.4 s: 4 FAILED, 6 cut off and left PENDING, failed by the next process's sweep 5–6 minutes after they were created. The flush was written every time. |
| Graceful stop with a request hung in the database | **Before:** 128.2 s (database never answering) and 45.2 s (row lock held for 45 s). **After RR1-03 and D9-32, in both re-audits:** database never answering, sign-in in flight: exit after 4.2 s, the sign-in got 503. Row lock held for 60 s: the request got 503 at 10.2 s (`lock_timeout`), exit after 9.1–9.2 s, flush written. Pooled connection whose database stops answering mid-request (4 drills): exit after 25.2–25.4 s. The request was cancelled at 20 s and got a plain-text 500 (L-11), and the flush could not be written because the database was unreachable. |

Every stop with a stuck request or delivery took 4.2–25.4 s, inside the 45 s grace period. The
event-loop stall that D9-32 had recorded (the request session's clean-up on the loop thread) did not
reproduce in re-audit 1's two hung-connection drills.

**What a restart loses:**

- the restarted process's in-memory rate-limit counters (security audit R-1). On `backend` that is
  every budget, lockout and daily e-mail budget; on a read process only its per-user API counts;
- coalesced security-event counts not yet flushed: on a kill, or when the database is unreachable at
  shutdown;
- deliveries in flight, which become FAILED and visible within about 6 minutes.

**Not verified (no Docker):** SIGTERM through `init` in a Linux container, exit code 143, and the 45 s
grace period. These were observed on Windows only, with CTRL_BREAK, which takes the same uvicorn path.
Compose restarts `postgres`, the four API processes and `frontend` with `unless-stopped`.

### 4.6 Scheduled and automatic jobs

| Job | How | Status |
|---|---|---|
| NO_SHOW marking | Happens lazily on reads. Optionally also `python -m app.cli mark-no-shows` nightly. | Verified in every round: marks only expired visits, in every company. A rerun changes nothing. 1.6–2.1 s on 60,000 visits. The audit row has no actor. |
| Session pruning | `python -m app.cli prune-sessions` weekly, as the schema owner, from the `migrate` service | Verified (success, and the refusal of 0 days) |
| Journey pruning (Phase 15) | `python -m app.cli prune-journeys` daily, as the schema owner, from the `migrate` service: each company's `journey_retention_days` | Verified by the backend suite (`test_tracking_cli.py`); nothing to prune while tracking is off |
| Interrupted e-mail sweep | Inside every API process, at start-up and every 60 s | Verified (RR1-04), including three overlapping sweeps (§4.4) |
| Backups | Cron on the host (runbook example: every 6 hours) | Scripts verified; scheduling is the operator's |

---

## 5. Logging and monitoring

### 5.1 Health endpoints

| Endpoint | Answers | Used by |
|---|---|---|
| `GET /api/v1/health` (public) | 200 `{"status":"ok","database":"ok"}`, or 503 `SERVICE_BUSY` with `details.database = "unavailable"`. Always within 3 s (measured 1.99–2.11 s against a database that never answers): the check runs on its own connection (connect and statement timeouts of 2 s), outside the request threads. A result is reused for 1 s. | Backend image HEALTHCHECK on each API process: every 30 s, 5 s timeout, 3 retries |
| `GET /healthz` on nginx's default HTTP server | Answered to loopback only | Frontend image HEALTHCHECK |
| `pg_isready` over TCP | – | PostgreSQL service health, Compose start-up order |

### 5.2 Logs

- **API:** one JSON object per line on stdout, with fields `ts`, `level`, `logger` and `message`, plus
  structured extras. Each API process logs on its own; `docker compose logs backend-reception` prefixes
  each line with the replica's container name.
- **Access lines** (logger `app.access`) carry:
  - `request_id`, `method`, `path` (never the query string) and `route` (the template, such as
    `/api/v1/visits/{visit_id}`);
  - `status`, `duration_ms` (the response time, excluding background e-mail work) and `client_ip`;
  - `user_id` and `company_id` (IDs only).

  RR1-09 added `route`, `user_id` and `company_id`. RR1-10 corrected `duration_ms`: it used to include
  background delivery and logged 49,157 ms for a 60 ms response. Re-audited: every field on every line
  (524 of 524 and 120 of 120 lines), both IDs on all 276 authenticated lines of re-audit 1, and
  `duration_ms` within about 1 ms of the client's measurement, written before the delivery's own lines.
- **Request IDs:** the request ID is returned in `X-Request-ID`, included in every error body and stored
  on audit rows.
- **What is never logged** (operations audit and both re-audits, full flows including failures; 1,036
  lines in 23 logs in re-audit 1):
  - 0 of 12–13 secret values: session, CSRF and device cookies, pass tokens and reset tokens, the API
    key, passwords;
  - 0 of 13–23 personal-data and password strings;
  - 0 query strings and 0 e-mail-shaped strings;
  - no provider message.

  Control characters are written escaped, so a log line cannot be forged (SEC-11).
- **During a database outage** the interrupted-delivery sweep writes one WARNING line per run (at
  start-up, then every 60 s): `closing interrupted e-mail deliveries skipped: database unavailable
  (<error class>)`, without a traceback (RA1-03). An ERROR from logger `app.main` now means a defect. A
  security event that cannot be stored is logged as ERROR "could not write security audit event", with
  its traceback, on purpose.
- **E2E backend log, round 2:** 1,122 lines, 0 ERROR and 0 HTTP 5xx. There were 4 expected warnings:
  three deliberate invitation failures and one per-user audit refusal budget.
- **Phase 10 (2026-10-08):** the four production-mode API processes behind nginx logged no ERROR, no
  traceback and no 5xx; their 8 WARNING lines were all expected (7 for a `QR_BASE_URL` on this computer,
  1 security-event coalescing notice). The Arabic acceptance run's API log had 748 lines, all INFO.
- **E-mail configuration warnings** (Phase 10): at startup the API logs, naming settings only, an
  `EMAIL_FROM` that Gmail would replace, a port that does not match `SMTP_SECURITY`, and a
  `QR_BASE_URL` on this computer while a real provider is configured (pass links that no visitor's
  phone can open). An `SMTP configuration problem: …` ERROR (logger `app.email`) means the mail server
  refused the sign-in, the sender or the certificate.
- **nginx:** a JSON access log using `$uri`, so no query string. `api_pool` names the API group that
  answered (`vms_api`, `vms_api_reception` or `vms_api_reports`; empty for static files), and
  `upstream_status` shows a list request passed on to the other replica (`502, 200`). **Treat nginx
  error logs as sensitive:** an error line can quote the failed request line, query string included.
- **Audit trail** (database, append-only): security events such as `AUTH_ACCOUNT_THROTTLED`,
  `RATE_LIMITED`, `CSRF_FAILED`, `ACCESS_DENIED` and `INVITATION_FAILED`, alongside every business
  event. Floods are coalesced into summary rows, marked `deferred`, `coalesced: <n>` or
  `overflow: true`. Each API process keeps its own row budgets and writes its own summary rows (§13.1).
- **Compose:** every container logs through the json-file driver, 5 × 10 MB. Not verified, because it
  needs Docker.

### 5.3 What to alert on

The thresholds are suggested starting points; tune them to the site's baseline after the pilot. Items
marked (R6) come from security audit recommendation 6.

| Signal | Source | Suggested condition | Meaning / first action |
|---|---|---|---|
| API unhealthy | `/api/v1/health`, container health of each of the four API processes | Non-200 or no answer on 3 consecutive checks | Database or pool trouble; check `SERVICE_BUSY` lines |
| Unexpected API restart | Restart count of each of the four API containers, start-up log lines | Any restart outside a deployment | Security-relevant on `backend`: every rate-limit budget and lockout was reset (R-1). A read process resets only its per-user API counts. Find the cause, for example OOM within the memory limit. |
| Start-up refusal | Backend exit code 1 (configuration) or 3 (database privileges, connectivity) | Any | The message names the setting or property, never the value |
| Desk latency | `backend` access log (nginx `api_pool` = `vms_api`), `route` = `/api/v1/reception/scan` and `/api/v1/visits/{visit_id}/check-in` | p95 `duration_ms` > 300 ms over 15 minutes | Capacity: [deploy/README.md](../deploy/README.md) §4 |
| Reception-list latency | Access log of each `backend-reception` replica (nginx `api_pool` = `vms_api_reception`), `route` = `/api/v1/reception/today` | p95 `duration_ms` > 300 ms over 15 minutes at the busiest hour | Add a list replica ([deploy/README.md](../deploy/README.md) §4) |
| Server errors | API and nginx access logs; ERROR records of logger `app.main` | Any 500; 502/504 from nginx; 503 rate above baseline; any `app.main` ERROR | 503 means the database, the pool or the Argon2 slots are saturated. An `app.main` ERROR is a defect. |
| E-mail failures (R6) | `email_messages.status = 'FAILED'` | Rising count, or any failed password e-mail | Resend status, the sending domain, Needs attention |
| Mail server configuration (Phase 10) | API log: ERROR `SMTP configuration problem: …` (logger `app.email`); startup WARNING lines about `QR_BASE_URL` or the SMTP port | Any | Fix the named setting (App Password, `EMAIL_FROM`, `SMTP_SECURITY` and `SMTP_PORT`, `QR_BASE_URL`), restart, check with `send-test-email`, resend the failed invitations |
| Stuck e-mail (R6) | `email_messages` PENDING with `updated_at` older than 10 minutes | > 0 | The interrupted-delivery sweep is not running: the API is unhealthy |
| Account lockouts (R6) | Audit `AUTH_ACCOUNT_THROTTLED` | Any, or a spike | Someone is guessing that account's password |
| Floods (R6) | Audit rows with `overflow: true`; spikes of `CSRF_FAILED`, `RATE_LIMITED`, `ACCESS_DENIED` (including `reason: session_ended`) | Above baseline | Attack or misconfigured client; check `client_ip` |
| Refusals per API pool (security audit R-1, recommendation 5) | nginx access log: `status` 429 by `api_pool`; API access log `user_id` | Above baseline on any pool | One account spending the per-user API budget on several processes (up to 4 × in all), or a stolen session. Each process counts its own budget (§13.1). |
| Audit growth (R6) | Size of `audit_logs` | Weekly trend | Retention and archiving policy (R-10) |
| Backups | Backup job exit code; age of the newest archive | Non-zero exit, or older than the interval plus a margin | RPO at risk |
| Certificate | TLS certificate expiry | < 21 days | Renew, then `nginx -s reload` |
| Disk | PostgreSQL volume, backup directory, log volume | > 80 % | – |

### 5.4 Queries for monitoring

Run these with a separate read-only monitoring role that has `SELECT` on the tables involved. Never add
memberships (such as `pg_monitor`) or extra grants to the runtime role `vms_app`: production refuses to
start if it has them.

```sql
-- E-mails that failed in the last hour, by kind
SELECT kind, count(*) FROM email_messages
WHERE status = 'FAILED' AND updated_at > now() - interval '1 hour'
GROUP BY kind;

-- PENDING e-mails that no delivery has touched for 10 minutes (the sweep should have failed them)
SELECT count(*) FROM email_messages
WHERE status = 'PENDING' AND updated_at < now() - interval '10 minutes';

-- Security events in the last 15 minutes (coalesced rows count all the events they stand for)
SELECT action, sum(1 + coalesce((metadata->>'coalesced')::int, 0)) AS events
FROM audit_logs
WHERE created_at > now() - interval '15 minutes'
  AND action IN ('AUTH_ACCOUNT_THROTTLED', 'RATE_LIMITED', 'CSRF_FAILED', 'ACCESS_DENIED')
GROUP BY action;

-- Flood summary rows in the last hour
SELECT count(*) FROM audit_logs
WHERE created_at > now() - interval '1 hour' AND metadata @> '{"overflow": true}';

-- Audit trail size
SELECT pg_size_pretty(pg_total_relation_size('audit_logs'));
```

These queries follow the schema in `backend/app/models/`. They were not run against a production-like
monitoring setup.

### 5.5 Not in place

- No metrics endpoint (Prometheus or similar). Latency and error rates come from the access logs.
- No log shipping, dashboards or alert rules are delivered. They depend on the customer's SIEM.
- No tracing.

---

## 6. Error handling

- **One envelope:** `{"error": {"code", "message", "details"}, "request_id"}`.
  [api.md](api.md) §4 lists 36 error codes, and the documentation check confirmed that statuses and
  messages match the code. Since Phase 10 every 422 also carries a code per field
  (`details.field_codes`, 60 codes, [api.md](api.md) §4.4); the Arabic interface translates errors by
  their codes, and the English one shows the server's message.
- **Database trouble is retryable, not a defect.** Connection loss, deadlocks and serialisation failures
  answer 503 `SERVICE_BUSY`, and since RR1-03 so does an exhausted pool. Before that fix, the pool
  case was a 500 with a traceback.
- **Unexpected exceptions** answer 500 `INTERNAL_ERROR` with no internals. The logged PostgreSQL DETAIL
  is redacted, because it can carry personal data (SEC-19).
- **At the proxy:**
  - nginx's own 413, 502, 503 and 504 use the API's JSON envelope, and its 503 carries
    `Retry-After: 5`;
  - while no process of an API service answers, nginx answers 503 `SERVICE_BUSY` for that service's
    paths; a list request that finds one replica gone is passed on to the other;
  - an oversize body (> 64 KiB, declared or chunked) gets 413 `PAYLOAD_TOO_LARGE` before it reaches
    the API.
- **E-mail** never fails a business operation (§4.4).
- **Frontend:**
  - field errors set `aria-invalid` and `aria-describedby`, and focus moves to the first invalid field;
  - server errors are announced in a live region;
  - a lazily loaded page whose chunk vanished after a deploy shows "A new version is available —
    Reload page" rather than a blank screen.
- **Observed:** 0 server errors in about 15,000 round-1 benchmark requests, in about 135,000 requests of
  the two performance re-audits (stress runs included) and in the round-2 E2E backend log. 0 × 500
  during the database-outage drills. The only 500s seen in any drill were requests cancelled at the
  20 s shutdown limit (below).
- **Open (minor):**
  - The API's own 503 `SERVICE_BUSY` carries no `Retry-After` header. Only nginx's does.
  - A request still running when the 20 s shutdown timeout cancels it gets uvicorn's plain-text 500,
    not the envelope. Both re-audits reproduced it with a database connection that stopped answering.
  - `python -m app.cli prune-sessions` without `MIGRATION_DATABASE_URL` ends with a raw traceback
    instead of one clear line.

---

## 7. Deployment: Docker, nginx and Compose

### 7.1 What exists

The full description is in [../deploy/README.md](../deploy/README.md) and
[decisions/phase-9-deploy.md](decisions/phase-9-deploy.md).

- **`backend/Dockerfile`:**
  - Python 3.14.8 slim, pinned by tag and digest;
  - dependencies from the hash-pinned lock, binary wheels only, then `pip check`, then pip removed;
  - runs as uid 10001 with a read-only root filesystem;
  - HEALTHCHECK on `/api/v1/health`; default command `python -m app.serve`, with one worker and fixed
    server options. Compose runs this image as four API processes (§7.4).
- **`frontend/Dockerfile`:**
  - Node 24.21 runs `npm ci --ignore-scripts` and `npm run build`;
  - nginx-unprivileged 1.30.5 (uid 101) serves the result;
  - a start-up check stops the container when the server name or the certificate is missing, or an API
    address (`VMS_API_UPSTREAM`, `VMS_API_RECEPTION_UPSTREAM`, `VMS_API_REPORTS_UPSTREAM`) is malformed.
- **`deploy/nginx/`:**
  - the exact security headers of `frontend/config/securityHeaders.ts`; caching: `no-store` on the HTML
    shell, `no-cache` on `sw.js`, `immutable` on hashed assets;
  - SPA fallback with 404 for missing files; `application/wasm`; `X-Forwarded-For` and `X-Request-ID`
    overwritten;
  - API requests shared out by method and by the path exactly as the client sent it (the
    `$vms_api_pool` map, D9-34; on the raw path since D9-36) over three upstream groups whose names are
    re-resolved every 10 s. The reception-list group balances its replicas with `least_conn` (D9-35);
  - no Upgrade forwarding, a 64 KiB body limit, no gzip on API responses (BREACH);
  - a query-free JSON access log with `api_pool`; TLS 1.2 (GCM) and 1.3 only;
  - unknown hosts and SNI rejected; HTTP redirected to HTTPS.
- **`docker-compose.yml`:**
  - services: postgres 18.6 (roles and grants created on first start; C.UTF-8 collation with
    en_US.UTF-8 ctype, so trigram search works for Arabic), then a one-shot `migrate`, then the API
    services `backend`, `backend-reception` (two replicas) and `backend-reports`, then `frontend`;
  - an internal `db` network and a fixed nginx address named in `TRUSTED_PROXIES`;
  - secrets only in git-ignored env files;
  - `cap_drop: ALL`, `no-new-privileges`, resource limits, health checks and ordering conditions.
- **Tools:**
  - backup and restore scripts;
  - `deploy/verify/smoke_test.py`, 81 checks against a deployed stack, one of them per API service;
  - `deploy/verify/test_api_instances.py`, which keeps the routing map (on the raw path, canonical
    keys), upstreams, start-up check, image defaults, the backend test's list of routed reads, compose
    services and replicas in step (`backend` must stay one process). It also requires the read services
    to run `backend`'s image, command and env file and to override only `PASSWORD_HASH_CONCURRENCY` and
    `DB_POOL_SIZE` (D9-37);
  - `check_nginx_headers.mjs`, a drift check between the nginx and SPA header lists;
  - `check_release_tree.py`, which refuses development artefacts or credentials in a commit.

### 7.2 Verified on this machine

| Check | Result |
|---|---|
| nginx configuration (`nginx -t`, official nginx 1.30.5 for Windows, PGP-verified) | Syntax OK on the canonical rendering and on the test renderings, after each layout change, and again on the final configuration in the final release gate (2026-10-07) |
| Smoke test, nginx in front of the API in **production mode** | 78/78 with one API process, from two client addresses, and again in the readiness round. 81/81 with three processes (D9-34) and with four, the two list replicas found through a stand-in DNS server (D9-35). With one list replica stopped: 81/81 (nginx passed the request on). With both stopped: 80/81 (the list check got nginx's 503). **Final release gate** (2026-10-07), the first smoke run on the raw-path map of D9-36: 81/81 from 127.0.0.1 and from 127.0.0.2. With one list replica stopped 81/81; with both stopped 80 passed and 1 failed (the list check, 503 `SERVICE_BUSY`); with `backend-reports` stopped 75 passed and 2 failed (the reporting check and the audit-row lookup); 81/81 after each restart. No nginx worker crashed. |
| API routing by method and path | D9-34: 27 of 27 live checks; each request's process was found by its request ID in the API logs. D9-35: 11 of 11, including an even spread over two replicas, a replica removed from DNS dropped within 13 s, and a stopped replica passed over. D9-36 (raw request lines, 35 targets): with the old `$uri` map, 24 reached a read pool, 16 of them non-canonical spellings, and `GET /api/v1/visitors/../visits` ran on `backend-reports`. With the raw-path map, only the 8 canonical targets and 2 letter-case variants did; the letter-case variants matched no route there (404 before authentication). **Final release gate:** 34 of 34 raw request targets, each request's process found by nginx's request ID. The 9 canonical routed reads (with and without a query string, and one in absolute form) reached their read process and got 200. The 2 letter-case variants reached a read process and got the API's 404. Every other spelling and method, and `auth/me`, `users` and `visitors`, reached `backend`. 10 sequential list requests went 5 to each replica. |
| **Phase 10 gate (2026-10-08)**, the same method, four production-mode API processes started with `EMAIL_PROVIDER=smtp` and `SMTP_SECURITY=ssl` (pointed at a closed local port; production start-up accepted it) | `nginx -t` OK on the test and the canonical renderings (only the Windows build's "PCRE2 library does not support JIT" warning). Smoke test 81/81 from 127.0.0.1 and 81/81 from 127.0.0.2. Routing probe 34 of 34 raw request targets; 10 sequential list loads went 5 to each replica. One list replica stopped: 81/81; both stopped: 80 passed, 1 failed (the list check, 503 `SERVICE_BUSY`); replicas back: 81/81; reports instance stopped: 75 passed, 2 failed (the reporting check and the audit-row lookup); after the restart 81/81. Access log 961 lines, 0 query strings (`page_size=` and `tab=today` 0 times each; the probe's deliberate `GET /api/v1/visits%3Fx` is logged with its decoded path, which is not a query string). No nginx worker crashed. The throwaway database and roles were dropped. |
| Rate limits on the routed paths | A recording limiter showed the six routed GET endpoints consult only the per-user API budget, for every role and for their 403 answers (15 of 15). Now a suite test: `backend/tests/integration/test_routed_reads.py` (phase-9-backend.md RT-01, D9-36) covers every role, 200, 401, 403, 422 and 429 answers, background polls, letter-case variants and the per-process refusal-row bound. Re-run on 2026-10-07: 61 passed, and again in the final release gate. |
| Negative controls (configuration deliberately broken) | Every regression was caught except two that are harmless by design: appending `X-Forwarded-For` from an untrusted client, and an equivalent `/assets/` fallback. The layout tests killed 22 (D9-34) and 13 (D9-35) broken configurations, 7 deploy and 6 backend mutants (D9-36), and 15 of 15 compose mutants (D9-37). |
| Deploy unit tests | 27 pass with PyYAML (`test_api_instances.py`, `test_check_release_tree.py`): 22 before D9-36, 4 added by it, and 1 added by D9-37 (the read services' settings). Final release gate: 27 passed, none skipped. Phase 10 added `test_brand_names.py` (6 tests: no retired product name where people or operators read it); Phase 10 gate: 33 passed, none skipped (PyYAML 6.0.3). |
| Security headers identical to the SPA list | `check_nginx_headers.mjs` in sync (7 headers), also re-run for this report and in the final release gate. It fails on each of 6 deliberate changes. A CSP without `'wasm-unsafe-eval'` failed 13 smoke checks. |
| TLS policy (`openssl s_client`) | TLS 1.3 and TLS 1.2 with GCM accepted. TLS 1.2 with CBC, 1.1 and 1.0 refused, even when offered. The browser used HTTP/2 over TLS 1.3. |
| Client IP and request ID | A spoofed `X-Forwarded-For: 203.0.113.77` was ignored. The audit row recorded the real peer and nginx's request ID. |
| Body limit | 65,536 bytes reach the API. 65,537 bytes and an 80 KiB chunked body get 413 in the API's JSON format. |
| API down behind nginx | 503 `SERVICE_BUSY` JSON with `Retry-After: 5` and HSTS |
| Browser flow through nginx (Chromium) | Sign-in, fake camera, pasted pass, "Verify ID", check-in 200. Service worker active with 21 precached files. 0 CSP violations. 0 requests leaving the origin. `/pass` makes no API call. |
| Two configuration bugs found during verification | `/healthz` was not actually restricted (nginx runs `return` before access checks), and the TLS policy did not apply to the default server. Both were fixed and retested. |
| PostgreSQL provisioning script | 7 bad inputs refused without creating anything. Roles created as plain LOGIN roles with no memberships. Migrations 0001 → 0010 ran as the provisioned owner. The production API's privilege check accepted the runtime role. |
| Image build steps, in equivalent local form | Frontend: build output byte-identical to `frontend/dist`. Backend: all 38 locked distributions resolved and hash-checked for linux/amd64 and linux/arm64. |
| Static checks | Compose schema: 0 errors. hadolint, shellcheck, PSScriptAnalyzer and ruff: clean, also after D9-34 and D9-35. gixy: 6 of 7 findings fixed, 1 explained. |
| Compose PostgreSQL settings | A throwaway cluster started with exactly the Compose arguments. Every setting was reported from the command line, with no warning. |
| Windows only: nginx `resolve` with two workers | A worker crashed (exit code C0000005) at each re-resolution, also with round 1's configuration. The verification ran one worker, and no worker crashed then. Linux is not expected to be affected; not verified. |

`check_release_tree.py` was also re-run for this report: exit 0, 770 files. In the final release gate,
after the E2E run: exit 0, 777 files. In the Phase 10 gate, after the E2E run: exit 0, 883 files, and
885 after the gap closure (two new test files), no development artefact or credential (the e-mail logo is not an outbox artefact, and the SMTP tests'
certificate is generated at run time).

### 7.3 Not verified (requires Docker or production infrastructure)

- `docker build` of either image, and `docker compose config`, `build` and `up`: BuildKit named
  contexts, `--chmod` copies, the pip install inside the image, the non-root users' permissions.
- Container runtime behaviour:
  - read-only root filesystems with tmpfs mounts, `cap_drop`, `no-new-privileges` and resource limits;
  - envsubst rendering and nginx's re-resolution of the API services through Docker's DNS;
  - `deploy.replicas: 2` creating two `backend-reception` containers, and Docker's DNS answering the
    service name with both addresses;
  - in-container health checks, `depends_on` ordering on three API services and the fixed network
    address;
  - the read processes under their 1 CPU / 512 MiB limits, and nginx's `resolve` with two workers on
    Linux;
  - the raw-path routing map in the Linux container, and over HTTP/2 (D9-36);
  - SIGTERM through `init`.
- The postgres image's first-start initialisation with the init script and `hba_file`. Arabic trigram
  search with the en_US.UTF-8 ctype on Linux glibc was verified on the Windows cluster only.
- The PostgreSQL memory settings inside the 2 GiB container limit, and query plans on production data
  and hardware.
- `backup.sh` and `restore.sh` in `--compose` mode, and their Linux file modes.
- PostgreSQL over TLS with `sslmode=verify-full`: the setting is accepted, but no connection was made,
  because the shared cluster runs with `ssl=off`.
- A certificate from a public CA.
- Real Resend delivery, and SMTP delivery from inside a container (egress, the system's trusted
  certificates in the image).

These are blocking items in [§15](#15-go-live-checklist), section B. Security audit R-4 and
recommendation 7 ask for the same.

### 7.4 Resource sizing in Compose

| Service | CPU | Memory | Notes |
|---|---:|---:|---|
| `postgres` | 2 | 2 GiB | `shared_buffers` 512MB, `effective_cache_size` 1536MB, `random_page_cost` 1.1 (SSD), `work_mem` 16MB. Memory budget: 512 MB + 50 API connections × 16 MB + 3 × 64 MB for autovacuum = 1,504 MB. Scale the memory settings with the limit (runbook §4). |
| `migrate` | 1 | 512 MiB | One-shot. The only container that receives the owner's URL. |
| `backend` | 2 | 1 GiB, 256 pids | Exactly one process, never replicated: every sign-in, every write and every request not routed elsewhere. `PASSWORD_HASH_CONCURRENCY=4` (4 × 64 MiB Argon2id), `DB_POOL_SIZE` 10 (+10 overflow). Stop grace period 45 s. |
| `backend-reception` | 1 each | 512 MiB, 128 pids each | Two replicas: `GET /reception/today` and `/inside`. `PASSWORD_HASH_CONCURRENCY=1`, `DB_POOL_SIZE` 5 (+5). |
| `backend-reports` | 1 | 512 MiB, 128 pids | Reports, audit log, admin dashboard and visit list reads. Same overrides as the list replicas. |
| `frontend` | 1 | 256 MiB, 128 pids | The only service published (ports 80 and 443) |

The API opens at most 50 database connections (20 in round 1); PostgreSQL's `max_connections` stays
100.

---

## 8. Environment configuration

- **Templates:**
  - `.env.example` documents every setting, with development values;
  - `deploy/env/backend.env.example`, `migrate.env.example`, `postgres.env.example` and
    `frontend.env.example` hold the production values for Compose;
  - the real files (`deploy/env/*.env`, `deploy/tls/`) are git-ignored.
- **Reference:** the full table is in the [root README](../README.md) §5, and the production refusals
  are in [security.md](security.md) §12.3.
- **Fail-closed production mode.** With `APP_ENV=production`, the API refuses to start, naming the
  setting but never its value, in 28 of 28 tested cases, including:
  - a weak, placeholder, short or published `SECRET_KEY`;
  - `COOKIE_SECURE=false`, http origins, `*` origins, or catch-all `TRUSTED_PROXIES`;
  - outbox or memory e-mail, or Resend without a key;
  - rate limiting off, or limits that switch it off;
  - the owner role as the runtime role, or a published development password;
  - a remote database without `verify-full`;
  - at start-up: a runtime role that is a member of `pg_monitor`, has role defaults (`ALTER ROLE … SET`),
    `CREATEDB` or `TEMPORARY`.

  The final security sweep then added further refusals, each with its own tests: published passwords
  from any libpq source (SEC-R6), ceilings and floors for limit settings (SEC-R5), and table privileges
  beyond the migrations' grants (SEC-R7). Phase 10 added, with unit tests: `SMTP_SECURITY=none` in
  production; in every environment, with `EMAIL_PROVIDER=smtp`, a missing `SMTP_HOST`, only one of
  `SMTP_USERNAME` and `SMTP_PASSWORD`, credentials over `none`, non-ASCII credentials and an
  `EMAIL_FROM` without an address; and product and brand names that are not one line of visible text.
  The Phase 10 gate started production mode with `smtp` over `ssl`.

**Settings that matter most at go-live:**

| Setting | Production value |
|---|---|
| `APP_ENV` | `production` |
| `SECRET_KEY` | `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`, kept in a secret store |
| `APP_BASE_URL`, `QR_BASE_URL`, `ALLOWED_ORIGINS` | The public `https://` origin; the host must be one of `VMS_SERVER_NAME` |
| `TRUSTED_PROXIES` | nginx's address only (`172.30.47.10/32` in Compose). Add a load balancer's address only with the `real_ip` setup of runbook §3. |
| `DATABASE_URL` / `MIGRATION_DATABASE_URL` | Runtime role / owner role, separate credentials, percent-encoded. The owner URL goes only into `migrate.env`. |
| `DB_REQUIRE_TLS` | `false` only on the internal Compose network. A remote database needs `true` and `?sslmode=verify-full&sslrootcert=…`. |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` | `resend`, a real key, an address on a verified sending domain; or `smtp` with the organisation's mail server over TLS (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` `ssl` or `starttls`, `SMTP_USERNAME`, `SMTP_PASSWORD`). `EMAIL_FROM` with the display name "Mawdoo3 Visitors" ([README](../README.md) §10). Check with `send-test-email`. |
| `PRODUCT_NAME_*`, `BRAND_NAME_*` | The defaults («زوار موضوع» / "Mawdoo3 Visitors", «موضوع» / "Mawdoo3"), unless the deployment carries another organisation's name ([README](../README.md) §5.4) |
| `PASSWORD_HASH_CONCURRENCY` | 4 in `backend.env`; keep it × 64 MiB inside the backend's memory limit. Compose sets 1 on the read services, which receive no sign-ins. |
| `DB_POOL_SIZE` | 10 in `backend.env`; Compose sets 5 on the three read processes. At most 50 API connections, which the PostgreSQL memory budget assumes. |
| `DB_*_TIMEOUT*`, `EMAIL_DELIVERY_CONCURRENCY` | Defaults apply (5 s, 5 s, 30 s, 10 s, 4); they are not in the template |
| Rate limits | Keep the defaults. Production also refuses guessing budgets above 10 × default, taken-address budgets above their ceilings, and limiter bucket caps below 10,000. |
| `LOG_LEVEL`, `LOG_JSON` | `INFO`, `true` |
| `SEED_DEMO_PASSWORD` | Never set; seeding is refused in production anyway |
| `VMS_SERVER_NAME` (`frontend.env`) | The public host name(s). Clients must use the DNS name, not the IP address. |
| `VMS_API_UPSTREAM`, `VMS_API_RECEPTION_UPSTREAM`, `VMS_API_REPORTS_UPSTREAM` (`frontend.env`) | Unset with Compose (image defaults `backend:8000`, `backend-reception:8000`, `backend-reports:8000`). Elsewhere, the reception name must resolve to one address per list process, and the main name to exactly one. |

The development `.env` cannot leak into Compose: the Compose file uses no `${…}` interpolation, and
the images contain no `.env`.

---

## 9. Documentation

| Document | Content | Status |
|---|---|---|
| [../README.md](../README.md) | Overview, quick start, configuration, tests, Docker, e-mail, demo users, security and deployment summaries | Verified against a running system (README §15). Updated after the re-audits: four-process layout. Phase 10 (2026-10-08): the product name, the languages and how to switch them, the e-mail setup (Resend; SMTP with Gmail on 465), the name settings, the Arabic demo seed; gate counts from the Phase 10 gate. |
| [architecture.md](architecture.md) | Layers, request lifecycle, data model, state machine, pass design, e-mail pipeline, tenancy, concurrency, frontend, operational limits | Verified. Process model updated to the four-process layout. Phase 10 (2026-10-08): revision 0011, the e-mail languages and names, the frontend's languages, brand and design tokens (§11.6), checked against the code; the diagrams changed only in text and were not rendered again. In Phase 9 its nine Mermaid diagrams, the only ones in the repository's documentation, render without error with the official renderer (mermaid-cli 12.0.0, Mermaid 12.1.0) and with Mermaid 11.17.2 and 12.1.0 in Chromium. Two deliberately broken blocks failed in all three checks. The system-context diagram matches `docker-compose.yml`: four API processes behind nginx, routed by method and path. |
| [api.md](api.md) | Endpoints, schemas, error codes, rate limits, curl and PowerShell walkthroughs | Index matched the live OpenAPI in Phase 9 (40 operations, 0 mismatches); Phase 10 added the preferences endpoint, the language fields and the 422 field codes (§4.4), and the count was taken again from `app.openapi()`: 41 operations on 33 paths. Walkthroughs run as written. One error (audit `entity_type` values) found and fixed. Rate-limit scope updated to the four processes. |
| [development.md](development.md) | Repository layout, conventions, gates, test harness, E2E how-to, troubleshooting, release hygiene | Verified. Phase 10 (2026-10-08): gate counts, durations and coverage of the Phase 10 gate; the languages (catalogs, type-safe keys, the tests that guard them, adding a string in both languages) and the design tokens (§2.4, §2.5); the Arabic seed; `scripts/email_logo.py`. |
| [security.md](security.md) | Every control, where it lives, how to check it; production hardening checklist; current residual risks | Verified (§18 of that file). Its security test subset (§17, now with `test_routed_reads.py`): 1,105 passed in the final release gate. Describes the four-process layout, routing on the raw path, and the per-process budgets that the engineering security review accepted with conditions (§13.1). Phase 10 (2026-10-08): the preferences endpoint, the SMTP credentials and transport, the e-mail content rules. |
| [security-audit.md](security-audit.md) | Phase 8 audit report | Accurate for Phase 8. R-1, recommendation 5, SEC-15 and R-10 carry dated Phase 9 closure notes with the review's verdict, evidence and conditions. Its condition 4 is marked done (D9-37, 2026-10-07). The other Phase 9 changes are not yet folded in (§13.3). A dated Phase 10 note lists what Phase 10 changed and how it was reviewed (no independent audit). |
| [../deploy/README.md](../deploy/README.md) | Operator runbook: first start, operations, variants, capacity and tuning | Rewritten for D9-34 and D9-35; Docker commands not runnable here. Re-checked after re-audit round 2 against `docker-compose.yml`, the nginx configuration, the env examples and §4.5. §4 "Stopping and redeploying" now gives the bounded shutdown: 20 s for requests and e-mails, the lock, statement and e-mail timeouts, and the measured stops of 0.2–25.4 s inside the 45 s grace period. Four other statements were corrected: the one-list-process poll result (1 of 12 runs), the replica re-resolution (13 s measured), `docker compose ps -a`, and the alert pointer (now §5.3 here). §4's rate-limit passage now gives the per-process refusal-row bound, the raw-path routing (D9-36) and the compose settings test (D9-37). The deploy unit tests pass (27). Phase 10 (2026-10-08): the product name, the SMTP option and `send-test-email`, the name settings. |
| [decisions/](decisions/) | Every decision and deviation, per phase and area, with verification | Authoritative change log |
| This file | Production readiness | – |

The documentation accuracy check found 92 of 92 behavioural claims true, plus 10 of 10 in a second set.
It also found that the README linked to this file before it existed; that link now resolves. After the
re-audits, the changed statements in this file, the README, `architecture.md`, `api.md`,
`development.md` and `security.md` were checked against the code, `docker-compose.yml` and the nginx
configuration. After the engineering security review of the layout (2026-10-07), the passages on it in
this file, `security.md`, `security-audit.md` and `deploy/README.md` were checked against the nginx
configuration, `docker-compose.yml`, `backend/app/services/audit.py`, the tests and D9-36. After the
final release gate (2026-10-07), the test counts and statuses quoted in this file, the README,
`development.md`, `security.md`, `architecture.md` and `deploy/README.md` were updated to its results.
For Phase 10 (2026-10-08) every document was brought to the finished product: the name, the languages,
the e-mail, the contract's revision 3 and the Phase 10 gate's results. The new statements were checked
against the code, the decision records and the measured results of the gate and the Arabic run.

**Open:**

- The binding contract `docs/initial-assessment.md` was revised once since Phase 0: revision 3 (Phase 10)
  added the Phase 10 changes. The Phase 8 and 9 deviations are still not folded in (security audit R-16
  and recommendation 10); the decision files and [architecture.md](architecture.md) §14 record them.

---

## 10. Testing

### 10.1 Final results (Phase 10 gate, 2026-10-08)

The Phase 10 gate ran every check on the final Phase 10 code, one check at a time, on the reference
machine (Windows 11, Python 3.14.6, Node 24.19, PostgreSQL 18.6 on port 5433). No project file needed a
change. The gap closure that followed (phase-10-frontend.md F10-gap-1 to F10-gap-8, phase-10-backend.md
B10-23) changed code, so every check below was run again on its final tree, one at a time, on the same
machine, except the nginx run and the dependency audits (no dependency, header or routing changed); the
table holds those results.

| Suite | Command (directory) | Result |
|---|---|---|
| Backend lint and format | `ruff check .` (ruff 0.16.10), `ruff format --check .` (`backend/`) | All checks passed; 251 files formatted |
| Backend types | `mypy` (2.4.0, strict, on a fresh cache) | No issues in 134 source files |
| Backend unit and integration | `pytest` | **2,974 passed**, 0 failed, 3 skipped (the opt-in performance checks in `tests/performance/test_volume.py`); 303.84 s |
| Backend, isolation order | `pytest --committed-first` | 2,974 passed, 0 failed, 3 skipped; 309.13 s |
| Backend coverage | `pytest --cov=app --cov-branch` | Lines 97.97 % (8,483 of 8,659; 176 missed), branches 93.56 % (1,641 of 1,754; 97 partial), combined 97.22 %; 134 files, 85 fully covered; 2,974 passed in the same run (314.64 s). Lowest: `app/services/no_shows.py` 84 %; `app/cli.py`, `app/core/time.py`, `app/email/providers/outbox.py` and `app/serve.py` 90 % |
| Backend volume check (opt-in) | `pytest --performance -s tests/performance` | 3 passed in both performance re-audits of Phase 9 (39.7 s and 45.2 s); not part of the gate |
| Frontend types and lint | `npm run typecheck`, `npm run lint` (oxlint 1.86.0, `--deny-warnings`) | 0 errors; 0 warnings and 0 errors on 497 files, 231 rules |
| Frontend unit | `npm test` (Vitest 5.0.3) | **1,349 passed** in 124 files, 0 failed; 104.87 s |
| Frontend coverage | `npm run test:coverage` (v8) | Statements 95.16 % (6,200 of 6,515), branches 91.10 % (5,103 of 5,601), functions 94.71 % (2,008 of 2,120), lines 96.55 % (5,405 of 5,598); the same 1,349 passed |
| Frontend build | `npm run build` (Vite 8.3.2, into a scratch folder) | Succeeds with no warnings; 2,718 modules; 17 s (sizes in §3.6) |
| E2E typecheck | `npm run e2e:typecheck` | 0 errors |
| **E2E (Playwright, Chromium)** | `npm run e2e -- --retries=0` (4 workers, ports 5199/8700, `vms_e2e`) | **253 tests: 235 passed, 18 skipped, 0 failed, 0 flaky**, 0 retries; 7.2 min (431 s) |
| · project `desktop` (1440 × 900) | | 77 passed, 3 skipped |
| · project `tablet` (820 × 1180, touch) | | 71 passed, 10 skipped |
| · project `mobile` (390 × 844, touch) | | 71 passed, 5 skipped |
| · project `flows` (§40 and negative scenarios) | | 16 passed, 0 skipped |
| Deployment checks | the deploy unit tests; `check_release_tree.py`; `check_nginx_headers.mjs`; `ruff check deploy`, `ruff format --check deploy` | 33 passed, none skipped (PyYAML 6.0.3); 885 files, no development artefact or credential; 7 headers in sync; clean, 6 files formatted |
| nginx in front of the production-mode API (nginx 1.30.5 for Windows, four API processes with `EMAIL_PROVIDER=smtp` and `SMTP_SECURITY=ssl`) | `nginx -t`; `deploy/verify/smoke_test.py`; a routing probe; negative controls | `nginx -t` OK on both renderings. Smoke test 81/81 from two client addresses. Routing 34 of 34. Negative controls as expected; no query string in the access log (§7.2) |
| Dependency audits | `npm audit --omit=dev`; pip-audit 2.10.1 (installed separately, run with the backend's interpreter) | 0 vulnerabilities in 56 production npm dependencies, and 0 in the full tree of 250 packages; no known vulnerabilities in `requirements.txt` (39 hashed pins; PyPI with hash checking, and OSV) or in `requirements-dev.txt` |

The E2E run logged 6 Vite lines `wasm streaming compile failed … falling back to ArrayBuffer
instantiation`. They are the benign case of [development.md](development.md) §9, not failures.

**The 18 E2E skips are the specs' own project conditions** (`test.skip(project.name …)`): history
layout 3 + 3, reception narrow-axe 1 + 1 and toast placement 1 + 1 (Phase 9,
[decisions/phase-9-e2e.md](decisions/phase-9-e2e.md), E9-16), and from Phase 10 the Arabic reflow spec
2 + 2 (it runs on phones only), the right-to-left evacuation print 1 + 1 (desktop only) and the Arabic
smoke spec 2 (skipped on the tablet).

**Coverage since the Phase 9 gate:** the backend grew from 7,662 to 8,659 statements; lines moved from
98.1 % to 97.97 % and branches from 93.9 % to 93.56 %. Frontend lines moved from 96.2 % to 96.55 % and
branches from 90.5 % to 91.10 %.

**Stability:** eight full E2E runs of Phase 9 are on record, all with 0 failed and 0 flaky. Six ran the
187-test suite (177 passed): three during Phase 9, one in each readiness round, and the final acceptance
run. Their durations were 4 min 44 s to 6 min 49 s; the slowest run shared the machine with other
suites. Two ran the 220-test suite (210 passed): the run that added the F9-10 and F9-11 checks, and the
Phase 9 final release gate (5.4 min). The full runs recorded during Phase 10
([decisions/phase-10-frontend.md](decisions/phase-10-frontend.md)) ended with 0 failed on their final
trees; the gate's run had 0 failed, 0 flaky and 0 retries.

**The Phase 9 final release gate (2026-10-07)** ran the same checks on the Phase 9 code: backend 2,195
passed and 3 skipped in both orders (229 s each), lines 98.1 % and branches 93.9 % covered; frontend
1,153 passed (lines 96.2 %, branches 90.5 %); E2E 220 tests, 210 passed, 10 skipped, 0 failed (5.4 min);
the deploy unit tests 27; the nginx smoke test 81/81. Statements elsewhere in this report that cite "the
final release gate" refer to it.

### 10.2 §40 acceptance scenario, in English and in Arabic

`frontend/e2e/flows/acceptance.spec.ts` runs steps 1–28 in 22 `test.step` blocks, in the English UI.
Each step checks the UI, the API and, where a step is about storage, the database. It passed on the
first attempt in round 1 (99 s), in round 2 (64.7 s), in the final acceptance run (66.9 s) and in the
Phase 9 final release gate (65.2 s), with no error in any of its 22 blocks, and again in the Phase 10
gate (the `flows` project: 16 of 16 passed). Steps 7–8, 10–11, 13–15 and 22–24 are each one block, so
they share one result and duration. The table gives the Phase 9 final release gate's durations.

| Steps | What is checked | Final release gate |
|---|---|---|
| 1–4 | Administrator signs in, creates a department, an employee and a receptionist, each with a temporary password | Passed (2.6, 2.0, 2.5 and 2.9 s) |
| 5 | The employee is forced to replace the temporary password; the old one then gets 401 | Passed (4.7 s) |
| 6–8 | The employee creates visitor Hamad Raouf and a visit with host, department, purpose, date and time | Passed (4.5 s; steps 7–8 3.7 s) |
| 9 | A secure pass: an opaque 43-character token in the URL fragment, no personal data, only its SHA-256 stored, and the QR decodes to the URL | Passed (0.8 s) |
| 10–11 | Invitation e-mail SENT; its inline PNG QR decodes to exactly the pass URL | Passed (1.8 s) |
| 12–17 | Receptionist on the tablet viewport: scanner, pass entered, server validates (READY), visitor details shown, check-in; scan → ready in 2.9–3.3 s | Passed (6.0, 0.5, 0.2 and 2.3 s); scan → ready 2.9 s |
| 18–20 | Check-in time stored (API and database row), host notified by e-mail, visitor listed under "Currently inside" | Passed (0.5, 0.5 and 0.6 s) |
| 21–24 | Check-out, its time stored, status CHECKED_OUT, pass revoked, duration shown | Passed (0.8 s; steps 22–24 2.4 s) |
| 25–26 | The visitor's history shows the visit; Hamad Raouf's earlier visit is unchanged field by field | Passed (1.4 and 0.3 s) |
| 27 | The audit log (admin UI and API) holds every event, with no personal data, token or password in the metadata | Passed (10.8 s) |
| 28 | Unauthorised users (another employee, management, reception, another company) cannot reach restricted information | Passed (12.7 s) |

**In Arabic through the real UI (2026-10-08).** The same scenario was run in the Arabic interface, with
its own API (port 8981) and Vite (5981), a throwaway database created, migrated, seeded with `seed-demo`
and dropped at the end, and the outbox e-mail provider. All 28 steps pass in
Arabic, and so do the e-mail checks, the visitor's pass page, a walk-in, four refused cases, reception
search, the evacuation list, history, reports, the audit log and a switch to English and back. Of its
45 recorded checks, 42 pass; the 3 that fail are layout defects, not workflow failures (L-21 to L-23 in
§14), fixed since with regression tests (phase-10-frontend.md, F10-gap-1 to F10-gap-3).

| Check | Result |
|---|---|
| Sign-in and shell (S01) | Arabic shell, teal `#188086`, the white logo with «زوار موضوع», the sidebar on the right; page titles end with «زوار موضوع» or "Mawdoo3 Visitors" |
| Users and the forced password change (S02–S05) | Department, employee and receptionist created; 403 `PASSWORD_CHANGE_REQUIRED` before the change, 401 for the old password after it |
| Pass and invitation (S06–S11) | A 43-character token in the URL fragment, no personal data, its SHA-256 stored, the QR decoding to the link. The e-mail's subject «زيارتك إلى موضوع يوم الخميس، 8 تشرين الأول 2026 \| Your visit to Mawdoo3 on Thursday, 8 October 2026»; Arabic before English; HTML `lang="ar" dir="rtl"`; the logo (462 × 149, byte-identical to the packaged file) and the QR (360 × 360, decoding to the pass URL) inline; the footer «أُرسلت عبر زوار موضوع.» / "Sent by Mawdoo3 Visitors." |
| Pass page (X-PASS) | Arabic at 390 and 1440 px, English for an English browser, no API request, the QR decodes |
| Reception on the 820 px tablet (S12–S24) | The dark reception screen; a pasted link sends only the token; READY; check-in by QR with scan → ready in 2.4 s; the host-arrival e-mail Arabic first; a second scan «سبق تسجيل الدخول» and 409 `VISIT_ALREADY_CHECKED_IN`; check-out, the pass revoked, the time on site in Arabic |
| History and audit (S25–S27) | The profile history; the first visit unchanged field by field; every event in the Arabic audit log, with no personal data, token or password in the metadata |
| Refusals and isolation (S28, X-*) | 404 for another host, read-only management (403s, no action buttons), reception kept out of administration, another company sees nothing and gets `PASS_INVALID`; cancelled (409 `VISIT_CANCELLED`), forged and garbage (404 `PASS_INVALID`) and expired (410 `PASS_EXPIRED`, then NO_SHOW and "check in anyway" with a reason) passes |
| Language (X-LANG) | English saved to the account, kept on reload and at a new sign-in, back to Arabic and kept |
| Quality | axe 138 times (96 in Arabic, 42 in English) on 42 page and language pairs at 1440, 820 and 390 px: 0 violations of any impact and no horizontal scroll. No script error, no 5xx, no request leaving the app's origin. Arabic time ranges put the start time on the right, in the UI and in the e-mails. No page, e-mail or subject names "Visitor Management" or the old demo company |

Not verified in that run: real delivery through Gmail (it used the outbox), the `From` header (the
outbox does not record it), and the camera path (passes were pasted).

### 10.3 What else the E2E suite covers

- **Negative paths:**
  - an expired pass, then "check in anyway" (time travel);
  - cancelled, invalid and replaced passes;
  - a visitor already inside, and a visit already completed;
  - a walk-in end to end;
  - invitation failure and recovery;
  - per-role permissions in the UI and the API;
  - cross-company attempts;
  - bulk check-out of visitors left from previous days.
- **Real-camera path:** Chromium's fake camera plays a 640 × 480 video of the pass. The spec asserts
  exactly one `/reception/scan` request, still one after 7 more seconds with the code in view; check-in;
  "Ready to scan" in under 10 s; and no request leaving the origin.
- **Quality:**
  - axe (no serious or critical violations) and no horizontal scroll on 48 pages per viewport, at 1440,
    820 and 390 px: 144 checks per run;
  - no horizontal scroll at 320 px either, on every page and for every role (F9-7);
  - every dialog (22 checks covering all 16 dialog components) fits the viewport with its footer inside
    the panel;
  - focus visibility: the selected tab's ring on `/reception` and `/visits` shows on all four sides
    (6.2:1) at 1440, 820 and 390 px (F9-3), and Tab walks of the company settings and the walk-in at
    320 × 720 and 390 × 700 leave no focused control under the sticky action bar, measured one
    animation frame after each Tab (F9-4, F9-8);
  - the evacuation list's touch targets for administrators, reception and management: the visitor's
    phone covers no pixel row of the name, in the cards at 390 and 820 px, the touch table at
    1180 × 820 and the mouse table at 1440 (F9-9, F9-10). A mocked spec covers every combination of
    company and phone, and a wrapping name, at 320, 390, 768, 820 and 1024 px with touch and at 1024
    and 1440 px with a mouse;
  - the camera controls' focus ring keeps at least 3:1 on all four sides over a near-white, a white, a
    mid-grey and a black frame (measured 4.5:1 to 21:1 in the final release gate; F9-11).

  A temporary spec confirmed these checks can fail: a missing `alt`, a 3,000 px element and a pushed-out
  footer button were each detected.
- **Phase 10 additions:**
  - `e2e/i18n-smoke.spec.ts` (desktop and phone): the sign-in page in Arabic (`dir=rtl`, `lang=ar`, the
    title, the logo lockup, Readex Pro loaded, axe), a reload, a sign-in through the Arabic page that
    saves the language (`PATCH /auth/preferences` and `/auth/me`), the Arabic shell with the sidebar or
    drawer on the right, axe in Arabic, and the switch back to English;
  - `e2e/quality/arabic-reflow.spec.ts` (phone): eight pages in Arabic at 360 and 320 px, no sideways
    scroll and no visible control outside the screen or its card;
  - `e2e/evacuation-print-rtl.spec.ts` (desktop, print media): the Arabic evacuation list on the page,
    columns from the right, Arabic words;
  - the dialogs spec measures every dialog header's balance, and the focus spec the dashboard tile's ring
    and the skip link;
  - the flow specs read the e-mails' content images apart from the inline logo.

### 10.4 Test quality

- Every fix in Phase 8, the Phase 9 sweep, readiness round 1 and both re-audit rounds has a regression
  test. Each was checked by undoing its fix on its own and watching the test fail: 13 checks for RR1,
  every RA1 fix, the F9-8 guards, every SEC-R fix, and the E2E checks for F9-3, F9-4 and F9-8, F9-7,
  F9-9, F9-10 and F9-11. The one exception is the walk-in Tab walk, which does not fail without the
  F9-8 reveal at its two sizes; the company-settings walk does. The deployment layout tests killed
  every deliberately broken configuration (22 for D9-34, 13 for D9-35) and every mutant (7 deploy and
  6 backend for D9-36, 15 compose for D9-37).
- The backend tests run against real PostgreSQL. Each run uses throwaway databases, and the runtime role
  is the one the migrations create.
- Phase 10's fixes were checked the same way: each SMTP and language fix, and each review fix, was undone
  on its own and its tests failed (tables in [decisions/phase-10-backend.md](decisions/phase-10-backend.md));
  the final role-name and brand tests fail on the previous texts and labels
  ([decisions/phase-10-frontend.md](decisions/phase-10-frontend.md), F10-final-1 and 2).
- The SMTP provider is tested against real SMTP servers on the test machine (aiosmtpd) with a
  certificate generated per test session, never a committed key.

### 10.5 Not covered

- **Other browsers:** Safari/iPadOS and Firefox (contract §10 lists them as supported) and physical
  cameras. Chromium only, as contract §11 specifies.
- **The after-midnight branch of the expired-pass spec:** it never ran. It needs a run within about the
  first hour after company-local midnight (phase-9-e2e.md, E9-7). The final release gate reached that
  spec at 01:44 Amman time, too late, and took the same-day branch.
- **No CI configuration exists yet.** The gates run on a developer machine.
- **E-mails in real mail clients:** every template was rendered in both leading languages and checked in
  Chromium only (L-24; since Phase 13 also in WebKit, and in their dark design and under a forced
  inversion); no automated test sends real mail.
- **Arabic in the E2E suite** is limited to the specs above; the other specs read the English UI (both
  companies are pinned to English in the global setup). The Arabic acceptance run (§10.2) covered the
  rest once, on 2026-10-08; it is not part of the repeatable suite.

---

## 11. Accessibility

**Target:** WCAG AA (contract §10). The checks used the WCAG 2.2 AA rule sets. The independent sweep ran
three times (round 1 and both re-audits) with the same scripts, on a production build with realistic
data: long, accented and Arabic names, every visit state, and every route for every role. The figures
below are from re-audit round 2. It measured the frontend before F9-10 and F9-11, the fixes of its two
low findings, which are described after the table.

| Check | Result | Status |
|---|---|---|
| axe-core | **0** violations of any severity on 280 page checks (70 at each of 1440, 820 and 390 px and 1180 × 820 landscape) and 86 interactive-state checks (dialogs, menus, drawer, validation errors, scan results) | Pass |
| Colour contrast | 0 axe violations in 280 checks. 560 nodes axe could not decide were checked by pixel sampling: all ≥ 4.5:1, or ≥ 3:1 for large text. | Pass |
| Keyboard | Skip link is the first Tab stop. Focus moves to the h1 on 40 of 41 navigations; the exception, desktop admin to Reception, focuses the pass field by design. Dialogs trap focus (Tab and Shift+Tab) and return it to the trigger. On the reception keyboard flow (§10), Enter checks in and focus goes back to the pass field. | Pass |
| Visible focus | 291 Tab stops at 1440, 820 and 390 px (pixel diff, focused against unfocused): 0 defects | Pass |
| Headings | Exactly one h1 per page, no skipped levels (350 page checks) | Pass |
| Forms and errors | `aria-invalid` with `aria-describedby`. Focus goes to the first invalid field, inside the viewport and clear of the sticky bar and the header. Server errors are announced in a live region. | Pass |
| Live regions | Scan result, "<name> checked in." and "Invalid visitor pass." use `role=status` | Pass |
| Reduced motion | 0 moving animations under `prefers-reduced-motion: reduce`; the sticky-bar reveal (F9-8) scrolls instantly | Pass |
| Print | Evacuation list: landscape A4 with a repeated header (29 visitors on 2 pages). Report: A4 portrait, 2 pages. Pass: one page. No overflow. | Pass |
| **Round-1 defects, fixed and re-audited twice** | F9-3: the selected tab's focus ring changes 4 of 4 sides at 6.2:1 (56 of 56 cases). F9-4: no Tab stop fully hidden behind a sticky Save bar (692 stops), none partly under a bar in a stricter 25-walk check. F9-5: white focus ring at 17.8:1 on the dark camera panel, 4 sides, five widths. F9-6: invite radios 718 × 44 and 324 × 62 px, table and text links at least 44 px (re-audit round 2 found one exception in the evacuation list's cards; F9-10 fixed it, below). F9-7: 0 of 70 pages overflow at 320 px. | Fixed and verified |
| **Re-audit round 1 defects, fixed and re-audited** | F9-8: text areas and segmented radios beside a sticky action bar are scrolled fully above it one animation frame after focus. In 468 walks (6 widths × 39 heights, 5,850 stops), 0 controls partly or fully under the bar in the first painted frame; a control run with the reveal blocked detected the overlap. F9-9: the evacuation list's visitor link on touch table layouts is at least 46 px; 0 such links under 44 px at 1180 × 820. | Fixed and verified |
| **Re-audit round 2 defects, fixed after it** | F9-10: the visitor's phone covers no pixel row of the name in the evacuation list, in the cards and the tables, at 320 to 1440 px with touch and with a mouse; the name's band is 60 px in the cards (was 30) and 56 px in the touch table (was 46). F9-11: the camera controls' two-tone focus ring keeps 4.5:1 to 21:1 on all four sides over near-white, white, mid-grey and black frames (was 1.14:1 over near-white). Details below. | Fixed; measured by the fixer and checked by E2E specs that passed in the final release gate. Not re-audited independently. |

F9-8 acts one animation frame after the focus moves. A script that reads positions right after the key
press still sees the browser's own scroll position (103 stops then look partly covered), which the page
never paints. Measure one frame later.

**Fixed after re-audit round 2** (both low; measured by the fixer with on-screen hit tests and pixel
diffs, as the re-audit measured them, and not re-audited independently;
[decisions/phase-9-frontend.md](decisions/phase-9-frontend.md), F9-10 and F9-11):

- **Evacuation list, card layout on touch screens (L-19, F9-10).** Re-audit round 2 found that in rows
  where the visitor has a phone and no company, the phone link's tap area reached 12 px up, above the
  card-wide row link. It covered the lower 8 px of the 21 px name line, so a tap on the lower part of
  the name dialled the visitor instead of opening the visit. The probe counted these name links at
  106–113 × 30 px (6 at 820 and 6 at 390 px: two rows for each of three roles). F9-9 had fixed the
  overlap only for the table layout. Now the name and company block keeps the phone's reach clear on
  every touch layout. After the fix, no row loses a pixel row of the name at 320, 390, 768, 820, 1024
  and 1440 px, with touch or with a mouse. The name's band is 60 px in the cards and 56 px in the touch
  table, and each phone link is 44 px tall with 0 px of overlap. In the final release gate the E2E
  checks measured the same for Grace Lee (a phone, no company) for administrators, reception and
  management: a 60 px band at 390 and 820 px and 56 px at 1180 × 820, 0 name rows lost.
- **"Turn camera off" focus ring over a bright camera picture (L-20, F9-11).** Re-audit round 2
  measured the white ring (F9-5) at 1.14:1 against a near-white frame, 0 of 4 sides visible at five
  widths. The camera controls now have a two-tone ring: the white outline and a 6 px dark shadow, so the
  white ring lies between dark bands. For any frame colour, one of the two tones has at least 4.4:1.
  Measured at 1440, 820 and 390 px on all four sides: 17.6:1 on near-white, 20.2:1 on white, 4.5:1 on
  mid-grey `#767676` (the weakest case) and 21:1 on black. "Start camera" measures 17.8:1 on the
  panel. The E2E check `e2e/camera-focus-ring.spec.ts` measured the same values in all three viewport
  projects of the final release gate.

**Phase 10 (2026-10-08).** Every screen was rebuilt in direction C and in two languages, and the
independent sweep above was not repeated on them. What was measured instead:

- the E2E suite's axe and overflow checks on every page per viewport, and the focus, dialog and touch
  specs, passed in the Phase 10 gate; the Arabic smoke spec runs axe in Arabic;
- the Arabic acceptance run: axe 138 times (96 in Arabic, 42 in English) on 42 page and language pairs
  at 1440, 820 and 390 px, 0 violations of any impact, no horizontal scroll (§10.2);
- `src/designTokens.test.ts`: every text pair at least 4.5:1 and every boundary, indicator and focus pair
  at least 3:1, in the light, dark, teal-shell and deep-shell token sets;
- focus: the ring of the dashboard's dark tile at least 3:1 on all four sides, and the skip link's ring
  inside its pill on the teal shell (E2E, F10-rf-8);
- language: `<html lang dir>` follow the UI language; each e-mail section carries its own `lang` and
  `dir`; the language button's accessible name contains its visible label (WCAG 2.5.3).

The Arabic run found three layout defects, all fixed since with regression tests: a toast over the
check-in button on the 820 px tablet (and, measured afterwards, at 1024 to 1440 px too), English chips for
the walk-in reasons in the Arabic audit log, and a button over the start of a generated password in Arabic
(§14, L-21 to L-23).

**Open (information only):**

- On desktop, the sidebar's section headings (h2) come before the page h1 (36 admin and management
  pages). This does not fail WCAG.
- At 390 px, the Add user dialog's "Show password" and "Generate" sit below the fold of its scrolling
  body, as in round 1.
- The printed report shortens long department names with an ellipsis.
- The dark colour scheme (Phase 10) was checked in the builders' screenshots; the E2E suite and the axe
  runs use the light scheme. Since Phase 13 the scheme is each device's (its own until the appearance
  toggle is pressed, then Light or Dark), and the E2E suite also runs axe on the main pages in Dark
  (sign-in, a company's sign-in, the pass, the dashboards, visits, the administrator's pages, reports, the
  e-mail texts, the platform owner's pages) and on the reception screen in Light, at the three viewports
  and at 320 px
  (`e2e/quality/appearance.spec.ts`; [phase-13-frontend.md](decisions/phase-13-frontend.md)).

**Not done:** a session with a real screen reader (NVDA, JAWS or VoiceOver); only the accessibility tree
(CDP) and axe were inspected. No real camera hardware, no browser other than Chromium. Printed pages were
checked with print-media screenshots and PDF page counts, not rendered PDF images.

---

## 12. Mobile and tablet responsiveness

| Check | Result |
|---|---|
| Horizontal page scroll at 1440, 1180 × 820, 820 and 390 px | **0 px** on 280 page checks and 115 state checks (re-audit 2), with no inner sideways-scrolling areas. Tables reflow into cards below the breakpoint. Re-checked in every E2E run (48 pages at each of 1440, 820 and 390 px). |
| 320 px (small phones; 1280 px desktop at 400 % zoom) | Before: 3 of 70 page checks (the walk-in tab and the admin dashboard) overflowed by 1–5 px. After F9-7: 0 of 70 in both re-audits. The E2E suite now checks 320 px on every page and for every role too; it passed in the final release gate. |
| Landscape tablet, 1180 × 820 | axe 0, overflow 0 on all 70 page checks. Touch targets: only the skip link and the report chart elements are under 44 px (2,008 targets). |
| Dialogs | Panel inside the viewport and focus inside it (56 dialogs and menus), footer buttons inside the panel at 1440, 820 and 390 px. Phones use bottom sheets. |
| Touch targets (coarse pointer) | Buttons, inputs, tabs, navigation, menu items, dialog footers, the invite radios, table links and text links are ≥ 44 px. Re-audit 2 probed 1,618 targets at 820 × 1180 and 1,586 at 390 × 844. Under 44 px were: the keyboard-only skip link (63 each); the report chart elements, which have a "Show table" equivalent (6 and 4); and 6 evacuation-list name links each at 30 px (§11, L-19), since fixed by F9-10 (60 px). Before F9-6: 194 and 96 targets under 44 px. |
| Reception on touch devices | The pass field does not autofocus and stays collapsed, so no on-screen keyboard opens. On a desktop with a handheld scanner, the field takes focus. |
| Visitor's pass page on a phone | 13 requests, 160,970 B transferred, no service worker installed (F9-1) |
| Arabic (right-to-left) names in the left-to-right interface | No overflow in lists, profiles, reports or the printed sheet |
| The Arabic interface (Phase 10) | E2E: eight pages at 360 and 320 px, no sideways scroll and no visible control outside the screen or its card (`arabic-reflow`); the printed Arabic evacuation list on the page with its columns from the right. The Arabic acceptance run: no horizontal scroll at 1440, 820 and 390 px on any page; the phone drawer opens from the right |
| Toasts on the reception tablet | **Fixed (L-21).** A toast used to sit for 6 s at the bottom inline-end corner from 640 px, over the next visitor's check-in button: part of it at 820 px, all of it at 1440 × 900 (the result panel's action row ends the inline-end column there). Toasts are at the top centre at every width now; `e2e/toast-placement.spec.ts` registers a walk-in, scans the next pass and taps the centre and corners of Check in and Scan next at 1440, 820 and 390 px in English and Arabic (it fails on the old placement) |

**Not verified:** physical tablets and phones; Safari on iPadOS or iOS (supported per contract §10, never
run); and a real camera with real lighting. Chromium's device emulation is the only evidence. The Arabic
acceptance run pasted passes instead of using a camera.

---

## 13. Security

### 13.1 Assessments

- **Phase 8 security audit** ([security-audit.md](security-audit.md)):
  - scope: three rounds, eight lenses, more than 3,000 live authorization requests;
  - **49 distinct issues:** 0 critical, 0 high, 5 medium, 34 low, 10 info;
  - 47 fixed with regression tests, each checked by reverting its fix;
  - **SEC-05** (low) deferred: global e-mail uniqueness lets an administrator learn whether an address
    has an account in another tenant. It now has a budget per company and per administrator, and its
    fix needs a contract change;
  - **SEC-29** (info) accepted: a reset link stays in the browser's history for its 30-minute life;
  - Completion Gate 8 holds.
- **Phase 9 final security sweep:**
  - 8 confirmed reports, 1 refuted. They come to 6 distinct issues, all fixed with tests that fail
    without the fix:
    - **SEC-R1** (low): the SEC-05 budget was per administrator only; it is now also 20 per company and
      hour;
    - **SEC-R2** (low): the lost-pass walk-in guard missed passes valid before local midnight; the
      Expected list and the guard now follow the pass window;
    - **SEC-R6** (low): production accepted published database passwords given through `?password=` or
      PGPASSWORD; they are now refused wherever libpq takes them from, a password file included;
    - **SEC-R5** (info): limit ceilings and floors in production;
    - **SEC-R7** (info): the runtime-role table-privilege check is now an allowlist;
    - **SEC-R3, R4 and R8** (info, one issue): a stray development outbox with 50 raw pass links sat
      untracked in `backend/`. It was deleted. Relative outbox paths outside `backend/var` are now
      refused, and `.gitignore` plus `check_release_tree.py` guard against a repeat.
- **Deployed-stack controls** (§7.2), verified on nginx for Windows in front of the production-mode API:
  headers, TLS policy, client-IP and request-ID handling, body limit, unknown hosts, query-free logs.
- **Configuration guardrails:** 28 of 28 production refusals (§8).
- **Deployment layout (D9-34, D9-35, D9-36):** four API processes. Every sign-in, write, lockout,
  password recovery, e-mail, scan and attendance budget is still counted only on `backend`, which must
  stay one process. nginx routes on the method and the path exactly as the client sent it, so only the
  six routed GET reads, spelled as the API routes them, reach the three read processes. They consult
  only the per-user API budget, so it is counted per process: up to 2,400 requests a minute per user in
  all, 1,200 of them on the list paths, and still at most 600 writes. The SEC-15 budget of written
  refusal rows is per process too. One user can cause up to 44 `ACCESS_DENIED` rows a minute and 8
  `RATE_LIMITED` rows for the per-user API budget, against 11 and 2 with one process; the summaries
  still count every refusal.
- **Engineering security review of the layout (2026-10-07): acceptable with conditions.** Two
  independent reviewers ran four real API processes behind nginx 1.30.5 with the repository's routing.
  - **Confirmed:** every GET route, for every role, consults only the per-user API budget. Sign-out,
    password change, deactivation and role removal take effect on the read processes at the next
    request. Every process records the same client address. An expired visit is marked NO_SHOW once,
    however many processes read it at the same time.
  - **Found and fixed (D9-36):** nginx chose the process from the normalised path but forwarded the
    raw one, so `GET /api/v1/visitors/../visits` ran another GET route on `backend-reports`. The map
    now uses the raw path.
  - **Accepted:** the per-process budgets above. They are bounded and need a signed-in session, and
    every sign-in, recovery and write budget stays single-counted.
  - **Now a suite test:** the budget property is pinned by
    `backend/tests/integration/test_routed_reads.py`, which `deploy/verify/test_api_instances.py` ties
    to the nginx map (§7.2).
  - **Now a deploy test (condition 4, D9-37):** `deploy/verify/test_api_instances.py`
    (`test_the_read_services_share_the_program_and_the_settings_of_the_main_one`) requires the read
    services to keep `backend`'s image, build, command, entrypoint and env file, and to set no
    `environment` key except `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE`. Adopting a lower
    `RATE_LIMIT_API_PER_MINUTE` on them means adding it to the test's allow-list in the same change. The
    test passed in the final release gate. The audit's R-1 note still lists this condition as open
    (§13.3).
  - **Still open:** sign-off of the per-process budgets by the deploying organisation's security owner
    (§15 H).
  - The verdict, evidence and conditions are in the audit's
    [R-1 Phase 9 closure note](security-audit.md#r-1-phase-9-closure-2026-10-07).
- **Phase 10 (2026-10-07 and 08).** No independent security audit covered Phase 10. Its security-relevant
  changes each had an adversarial review whose demonstrated defects were fixed with tests that fail
  without the fix ([decisions/phase-10-backend.md](decisions/phase-10-backend.md)):
  - **SMTP provider** (S10-10 to S10-13): a reply trickled over time could stretch an attempt past its
    20 s deadline (medium); an EHLO error reply was unchecked and misread as a configuration problem
    (medium); a wrong password cost several sign-in attempts per message (low); an RFC 2047 encoded word
    in an address or the subject could show a recipient other than the envelope's, or put line breaks
    into the decoded subject (low);
  - **brand and languages** (B10-14, B10-15): values took the direction of the sentence around them in
    the other language (low); a re-run seed undid an administrator's choice of language or Arabic name
    (low);
  - **new surface:** `PATCH /auth/preferences` (CSRF and Origin checks, the per-user API budget, the
    caller's own row only, allowed during a forced password change, not audited by design: B10-4); the
    SMTP credentials (a secret, only over verified TLS, never logged); the bilingual templates (values
    escaped and direction-isolated, header values free of every kind of line break); the 422 field codes
    (parameters are the API's own limits and choices, never the rejected input);
  - **dependencies:** `npm audit --omit=dev` 0 vulnerabilities (56 production dependencies) and
    pip-audit no known vulnerabilities in either lock file, on 2026-10-08. The SMTP provider uses the
    standard library; the new development dependencies (aiosmtpd, cryptography) are pinned and hashed.

### 13.2 Controls in brief

[security.md](security.md) has the full description.

- **Passwords and sign-in:**
  - Argon2id with 64 MiB, time cost 3 and parallelism 4;
  - a policy of 12–128 characters with a breached-password list;
  - identical answers for unknown and wrong accounts;
  - device trust against lockout abuse.
- **Sessions and CSRF:**
  - server-side sessions (12 h absolute, 4 h idle) behind `__Host-` cookies;
  - revoked immediately on logout, password change and deactivation;
  - a global CSRF and Origin middleware, and no CORS.
- **Tenancy and authorization:**
  - capability checks from one permission matrix, plus row-level rules in the services;
  - every ID resolved within the caller's company, backed by composite foreign keys.
- **Visitor passes:**
  - 256-bit random tokens; only the SHA-256 is stored, and the token travels in the URL fragment;
  - bound to the visit, the company and a time window;
  - revoked on check-out, cancellation, resend and e-mail change;
  - "Verify ID" is shown on every scan.
- **Audit trail:**
  - append-only: a database trigger blocks UPDATE, DELETE and TRUNCATE, and the runtime role may only
    insert and read;
  - no personal data in the metadata.
- **Least privilege:** the runtime role cannot delete, run DDL or choose the audit order. Production
  refuses to start if it can do more than the migrations grant.
- **Browser:**
  - a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no inline script: the colour scheme set before
    the first paint is a file of the build, `/appearance.js`), HSTS, `frame-ancestors 'none'` and
    `Referrer-Policy: no-referrer`;
  - `no-store` on the API and the HTML shell;
  - shared-device hygiene: cross-tab sign-out, a session heartbeat and a back/forward-cache check.
- **E-mail:** Resend over HTTPS, or SMTP only over TLS with the certificate verified (`SMTP_SECURITY=none`
  refused in production); the API key and the SMTP password never logged; templates escaped, values
  direction-isolated, header values free of line breaks of every kind; no remote content in a message.
- **Supply chain:** hash-pinned Python locks, `npm ci`, and base images pinned by digest.

### 13.3 Where security-audit.md is out of date

[security-audit.md](security-audit.md) is the Phase 8 report. R-1, recommendation 5, SEC-15 and R-10
now carry dated Phase 9 closure notes in the report itself: the four-process layout and the engineering
review of it (§13.1). The points below changed in Phase 9 and are not yet folded into the report.
[security.md](security.md) §19 has the current residual list.

| Item in security-audit.md | Current state |
|---|---|
| R-2: lost deliveries stay PENDING or FAILED | Lost deliveries are failed automatically within about 6 minutes and listed under Needs attention (RR1-04) |
| R-4: deployment artefacts neither written nor verified | Written. nginx verified on Windows in front of the production-mode API, with one and with four API processes. Containers still unverified (§7.3). |
| R-6, §1.4: SEC-05 bounded to 10 per administrator per hour | 10 per administrator **and** 20 per company per hour (SEC-R1) |
| SEC-09: lost-pass guard | Decided by the pass window, including visits just after midnight (SEC-R2) |
| SEC-46, SEC-49, SEC-18: configuration and privilege checks | Extended by SEC-R5, SEC-R7 and SEC-R6 |
| Recommendation 15: delete the stray outbox directory | Done; prevention in D9-29, D9-30 and SEC-R8 |

### 13.4 Residual risks

| Ref | Residual risk | Mitigation / required action |
|---|---|---|
| R-1 | Rate limiter and lockouts in process memory; a restart resets them, and extra processes multiply the budgets they count | Exactly one main API process (`backend`), which counts every budget but the per-user API budget. The three read processes count only that one (up to 4 × in all) and their own refusal-row budgets (up to 4 ×). Accepted with conditions by the engineering security review (§13.1); signed off by the security owner before go-live (§15 H). Alert on restarts of each API process and on 429 spikes per pool (§5.3). A shared (Redis) limiter before scaling the main instance. |
| R-2 | E-mail delivery runs inside the API process | Lost deliveries become FAILED and visible; resend. A durable worker queue is the upgrade path. |
| R-3 | QR passes are bearer credentials | "Verify ID" on every scan. Revocation on resend and e-mail change. **Staff procedure: always check identity.** |
| R-4 | Containers not verified | §15 section B. Penetration test of the deployed stack. |
| R-5 | No row-level security for reads | Scoped repositories, composite foreign keys on writes, mandatory RBAC and isolation suites |
| R-6 | SEC-05 cross-tenant address check | Budgets per administrator and per company. Contract change to remove it. |
| R-7 | SEC-29: a reset link stays in the browser's history | Single use, 30-minute lifetime, shared-device browser policy |
| R-8 | No admin "unlock" or "sign out everywhere" | Device trust, password reset, deactivate and reactivate |
| R-9 | Documented account signals (for example a 429 while an account's success budget is spent) | Audited; monitoring |
| R-10 | The append-only audit table grows; no archive path; the refusal-row budgets apply per API process (§13.1) | Monitor growth; define retention and an owner-run archive procedure |
| R-11 | Some limits are policy, not refusals | Runbook values |
| R-12 | Shared-device remanence in the browser | Managed browser policy; explicit sign-out |
| R-13 | Visitor personal data is never deleted; no anonymisation | Retention policy and an owner-role maintenance procedure before go-live |
| R-14 | Password-only authentication | MFA or SSO for administrators recommended (outside the contract) |
| R-15 | Chromium only | Test Safari/iPadOS and Firefox on the reception tablets |
| R-16 | The contract document lags the Phase 8 and 9 changes (revision 3 added Phase 10's) | The decision files and [architecture.md](architecture.md) §14 |

Recommendations 1–6 of security audit §7 are **musts before any production traffic**: TLS end to end,
the reverse proxy as specified, secrets management, database role separation, a single process (as
reworded in Phase 9: a single main API process, with the read processes of the shipped layout and the
security owner's sign-off of their per-process budgets), and monitoring. They are part of §15 below.

### 13.5 Demo accounts in a production database

Phase 11 security review, 2026-10-13 ([phase-11-backend.md](decisions/phase-11-backend.md) B11-36;
[security.md](security.md) §12.3).

`seed-demo` and `seed-e2e` create demo accounts that all share one published password
(`Demo-Visitor-2026`, or `SEED_DEMO_PASSWORD`), which never has to be changed and never expires: one user
per role in the demo company "Mawdoo3" (`…@demo.local`), four in "Other Corp" (`…@other.local`, `seed-e2e`
only), and the platform owner's `platform@demo.local`, which manages every company. Both commands refuse to
run with `APP_ENV=production`. That guards the process that seeds, not the database: one that was seeded
before it became production's, a demo database restored over it, or a seed run from a workstation whose
`DATABASE_URL` names the production database would leave those accounts in production.

**What production does about it** (covered by `backend/tests/integration/test_seed_guard.py`):

| When | What happens |
|---|---|
| The API starts with `APP_ENV=production` and a seed account exists | It refuses to serve. The log line (a `ConfigurationError`, after the database-role check) reads "this database holds demo accounts created by seed-demo or seed-e2e (platform account platform@demo.local; 6 company user(s): admin@demo.local, …)" and names what to do. A deactivated seed account refuses the start as well |
| A seed account appears while the API runs | Its sign-in is refused like a wrong password (`401 INVALID_CREDENTIALS`; audit `AUTH_LOGIN_FAILED` with `reason: seed_account`), for company users and for the platform owner; the next start is refused |
| Any other account uses a seed's address | Nothing: an account is a seed account by the ID the seeds give it, not by its address, so no company's administrator can create a row that stops the API from starting |

Audit rows written by a seed carry `metadata.source = "seed"` (`"cli"` is `create-admin` and
`create-platform-admin`), in the company trails and in the platform's.

**A production database is one that was never seeded.** Create it with `alembic upgrade head`, then
`create-platform-admin` and (or, through the platform owner's pages) the companies and their
administrators.

**If the API refuses to start because of seed accounts**, decide which case it is:

1. *The wrong database* (a demo or staging database behind the production URL): point `DATABASE_URL` and
   `MIGRATION_DATABASE_URL` at the right one. Nothing else.
2. *The production database, seeded by mistake* (a seed run against it from a workstation). The seed adds
   rows and changes none of yours: the platform account, and, where the slugs `demo-company` /
   `other-corp` did not exist, those companies with their departments and users. Find when it ran
   (`SELECT min(created_at) FROM platform_audit_logs WHERE metadata->>'source' = 'seed'`, and the same in
   `audit_logs`), then either restore the backup taken before it (the clean way; rows written since are
   lost), or remove the seed's rows as the **schema owner**, with the API stopped. The runtime role cannot
   delete, and the audit rows of the seed stay (the trails are append-only), which is the record that it
   happened. Not run on the build machine against a production database; the statements were checked
   against a freshly seeded throwaway database:

   ```sql
   BEGIN;
   -- The platform owner's demo account (its sessions go with it).
   DELETE FROM platform_admins WHERE email = 'platform@demo.local';
   -- The demo companies' users (their sessions and reset links go with them), departments and the
   -- companies themselves. A DELETE fails if anything still refers to the rows (a visit, a visitor, an
   -- e-mail, a company text): then the accounts were used, and this is an incident to investigate, not
   -- a clean-up. ROLLBACK and restore instead.
   DELETE FROM users WHERE company_id IN (SELECT id FROM companies WHERE slug IN ('demo-company', 'other-corp'));
   DELETE FROM departments WHERE company_id IN (SELECT id FROM companies WHERE slug IN ('demo-company', 'other-corp'));
   DELETE FROM companies WHERE slug IN ('demo-company', 'other-corp');
   COMMIT;
   ```

   Only when both slugs were created by the seed: if `demo-company` is a company of yours that the seed
   merely added users to, delete those users by the addresses the refusal names instead of the company.
   Treat the published password as used: read the platform's and the companies' audit rows since the seed
   ran (`AUTH_LOGIN_SUCCEEDED` for the seed accounts' IDs) before deciding that nothing happened.
3. *A demo or pilot database that is meant to become production.* Not supported as it is: move the real
   companies to a fresh database, or remove the seed's rows as in case 2 where nothing refers to them.

**Recovering a platform account** (B11-35) is in [security.md](security.md) §3.7: `create-platform-admin
--email <address> --reset` on the server, with the generated password, also while strangers keep the
account locked.

---

## 14. Known limitations

| # | Limitation | Impact | Mitigation / path |
|---|---|---|---|
| L-1 | **One worker per API process.** The rate limiter, lockouts, daily e-mail budgets and coalesced security events live in each process's memory. Compose runs four processes: `backend` and three read processes. | A restart of `backend` resets every budget and lockout. The per-user API budget is counted per process (up to 2,400 requests a minute per user in all, 1,200 on the list paths; writes at most 600). Two list replicas were measured up to about 180 open reception pages on a quiet host, and about 90 at up to 80 % host CPU. | Add list replicas (runbook §4); never replicate `backend`. A shared limiter (Redis) before scaling the main instance. Cheaper lists (L-6). |
| L-2 | **E-mail is delivered inside the API process** (background work with 4 dedicated slots), not through a durable queue | A crash loses deliveries in flight. They become FAILED after about 5 minutes and need a manual resend; reset links must be requested again. | DB-backed outbox worker (documented upgrade path) |
| L-3 | **Docker images and Compose never built or run** | Container-specific defects, including the replicas and Docker's DNS, would surface only at the first deployment | §15 section B |
| L-4 | Real Resend delivery, `verify-full` database TLS and a public certificate not exercised. SMTP delivery through Gmail was checked by hand in the demo only: Gmail accepted the current invitation (final bilingual templates, inline logo) on 2026-10-08, `SENT` after one attempt | Deliverability, the mail domain's reputation and the TLS handshake are unproven beyond that; the invitation's rendering in the Gmail inbox is not yet confirmed (mail-client rendering: L-24) | The mailbox owner checks the received invitation: the sender "Mawdoo3 Visitors", the inline logo and QR, Arabic first; then, with `QR_BASE_URL` set to an address a phone opens (L-26), that the link opens. §15 sections C and E |
| L-5 | **Chromium only**; no physical tablet, phone or camera. The camera path ran only with Chromium's fake camera; the Arabic acceptance run pasted passes | Safari/iPadOS camera and PWA behaviour, and a physical tablet camera in real light, unknown | Pilot on the real devices; penetration test including Safari and Firefox |
| L-6 | `GET /reception/today` returns four full visit lists: about 370 KB on a normal day, up to 1.19 MB at the caps, uncompressed by design (no gzip on the API, because of BREACH). The screen reads only `expected`, `no_show` and the counts; `inside` and `checked_out` are 49 % of the bytes. | Bandwidth on busy days. 38 ms of server CPU per normal-day poll and 101 ms at the caps (46 and 143 ms before RA1-01), which decides how many list replicas a site needs. Long main-thread tasks on the Expected tab (215–611 ms at CPU × 4). | Drop or make opt-in `inside` and `checked_out`, a slim list item, or counts-only polls (contract change, handed over) |
| L-7 | Audit pages count all of the company's audit rows on every full page | The cost grows with the trail. Since RA1-02 the count runs serially: 15–24 ms at 211,000 rows (84–201 ms with parallel workers before); first page p95 47–63 ms. | A capped or estimated total, or keyset pagination (contract change). Re-check the serial plan on the Linux host. |
| L-8 | A request blocked inside PostgreSQL at shutdown ends only when its statement ends or times out; the request session's clean-up runs on the event loop | Bounded by the 10 s lock and 30 s statement timeouts, and measured: exit after 9.2 s (row lock held for 60 s) and 25.2–25.4 s (pooled connection hung), inside the 45 s grace period. The D9-32 event-loop stall did not reproduce. With the database unreachable, the coalesced counts cannot be written. | Do that clean-up off the event loop (application change, handed over) |
| L-9 | An e-mail cut off by shutdown stays PENDING until the sweep fails it | 5–6 minutes before it shows under Needs attention | Let deliveries see the shutdown (handed over) |
| L-10 | More than 30 **simultaneous** sign-in attempts from one client IP get 429, even with correct passwords (each attempt in flight holds a slot of the per-IP failure budget) | A shift-start login storm behind one NAT address or an unlisted proxy | Put the real proxy in `TRUSTED_PROXIES`; size `PASSWORD_HASH_CONCURRENCY` (2 s wait, then 503) |
| L-11 | The API's own 503 has no `Retry-After`; requests cancelled at the 20 s shutdown limit get a plain-text 500 (reproduced in both re-audits) | Clients and probes get no retry hint from the API itself; a cancelled request is outside the error envelope | nginx's 503 carries `Retry-After: 5`. Optionally answer a cancelled request with the 503 envelope (handed over). |
| L-12 | The Resend endpoint is not configurable | Provider-outage drills need an HTTPS proxy and a custom CA | Optional non-production setting |
| L-13 | Expected-list rows show only the time range. Visits just after midnight (and, with a long grace period, tomorrow's) can be listed without a date. | A receptionist could misread "00:10–01:10" | Show the date or "tomorrow" (frontend, handed over) |
| L-14 | No admin unlock, sign-out-everywhere, MFA, SSO, anonymisation or audit archiving | Operational and compliance gaps for some customers | Security recommendations 11, 13 and 14 |
| L-15 | nginx error logs can contain query strings. Requests nginx rejects before routing (400/414/494) carry no security headers. IPv6 clients behind Docker's userland proxy share one per-IP budget. | Log sensitivity; IPv6 rate limiting | Treat error logs as sensitive; enable IPv6 on the network before serving IPv6 |
| L-16 | No CI pipeline, image scanning or SBOM. The repository has no commits yet; the root `.gitattributes` (LF for `*.sh`, `Dockerfile` and `docker-compose.yml`) exists but is not committed. | Gates depend on discipline; without the attributes, `.sh` scripts would be checked out with CRLF where `core.autocrlf=true` | §15 section A |
| L-17 | Performance figures are from a shared laptop with plain processes. Stress B and throughput were re-measured in both re-audits; the shipped `least_conn` layout only by its author, and its round-robin form also by the re-audit. | Capacity on production hardware and under the Compose CPU limits is unconfirmed | Re-measure in the pilot (runbook §4, "What to watch") |
| L-18 | `prune-sessions` without `MIGRATION_DATABASE_URL` prints a raw traceback | Confusing operator output only | Catch the configuration error in `app/cli.py` |
| L-19 | **Fixed (F9-10).** Evacuation list, card layout on touch screens (below 1024 px): in rows with a visitor phone and no company, the phone link's tap area covered the lower part of the visitor's name | None since the fix: the phone covers no pixel row of the name in any layout, and the name's band is 60 px in the cards (§11) | Checked by `e2e/inside-touch-targets.spec.ts` and `e2e/quality/touch-targets.spec.ts`, which passed in the final release gate. Not re-audited independently. |
| L-20 | **Fixed (F9-11).** "Turn camera off" had a white focus ring, which measured 1.14:1 over a bright camera picture | None since the fix: a two-tone ring keeps 4.5:1 to 21:1 on all four sides over near-white, white, mid-grey and black frames (§11) | Checked by `e2e/camera-focus-ring.spec.ts`, which passed in the final release gate. Not re-audited independently. |
| L-21 | **Fixed (F10-gap-1).** A toast (6 s, at the bottom inline-end corner from 640 px wide) covered the next visitor's primary check-in button: part of it on the 820 px tablet (Arabic acceptance run: after a walk-in, after the first sign-in's password change, and in English after a check-out), and all of it at 1024 to 1440 px, measured afterwards | None since the fix: toasts sit at the top centre at every width | `e2e/toast-placement.spec.ts` (walk-in, then a scan; 1440, 820 and 390 px; English and Arabic) and `Toast.test.tsx` |
| L-22 | **Fixed (F10-gap-2).** The Arabic audit log showed the walk-in event's reason chip in English while its details said «السبب: توصيل»: all six walk-in reasons (NO_INVITATION, EARLY_ARRIVAL, LATE_ARRIVAL, LOST_PASS, DELIVERY, OTHER) had no words in `audit.values`, and the chip and the details used two lookups | None since the fix: the chip words every value as the details do | `auditVocabulary.test.ts` checks every value the backend writes under `outcome`, `reason`, `code` and `policy` through the chip, in both languages |
| L-23 | **Fixed (F10-gap-3).** In Arabic, *Users → Add user → Generate*: the show/hide button covered the first two characters of the generated temporary password (the input's padding resolved against its own left-to-right direction, the button's position against the page's right to left) | None since the fix: the field and its button are one left-to-right control | `TemporaryPasswordField.test.tsx` and `e2e/temporary-password-field.spec.ts` (the button outside the text's box at 1440, 820 and 390 px, both languages) |
| L-24 | **E-mails checked in browser engines only**, not in Outlook, Gmail's apps, Apple Mail or another real mail client. Since Phase 13 in Chromium and WebKit (Playwright's, the engine closest to Apple Mail), each in the light design, under a dark colour scheme (the e-mails' own dark design, [phase-13-backend.md](decisions/phase-13-backend.md) B13-1) and under a forced inversion like the Gmail app's, at 600 and 320 pixels. Outlook for Windows ignores `border-radius` and the `<style>` blocks (square corners, the desktop layout on phones, the light design only), and some clients ignore `dir` on table cells | The text stays complete and in order (Unicode's bidirectional algorithm), but the layout may differ; a client's own darkening may differ from the inversion simulated (the logo is an opaque white tile there, so it reads either way) | Open real invitations, reschedules, cancellations, arrivals and password e-mails, in both leading languages, in the clients the site uses, in light **and dark** mode (Apple Mail on an iPhone in dark mode in particular: the owner's report of 2026-10-14) (§15 E) |
| L-25 | **Native date inputs follow the browser's locale**, not the UI language: mm/dd/yyyy in headless Chromium regardless of the UI language (an `ar-JO` context showed «10/09/2026» in the Arabic edit-visit dialog too) | A date field can look unlike the app's own dates | The app reads every chosen date back in its own format; a date picker of its own would be a separate change |
| L-26 | **`QR_BASE_URL` must be reachable from visitors' phones.** With the development default (`localhost`) the pass links and QR codes open nothing on a phone | Invitations whose pass does not open. The demo's own configuration still has `http://localhost:5173` (2026-10-08), so an invitation it delivers through Gmail opens nothing on the visitor's phone | The public `https://` origin in production; the API and `send-test-email` warn at startup about a local address. For the demo: the machine's LAN address (`npm run dev:https`, development.md §9 "Tablets on the LAN"), set by its operator in the root `.env` (hand-over, phase-10-backend.md B10-23) |
| L-27 | **SMTP limits** (S10-9): no idempotency key, so a retry after a lost final reply can deliver a second, identical invitation; Gmail through App Passwords only (no OAuth2); the system's trusted certificates only (no setting for a private CA); one connection per message; Gmail's published limit of 500 messages a day for a personal account | A rare duplicate carries the same pass; Gmail suits a pilot | Resend or the organisation's mail server for production; a CA-bundle setting if a private CA is needed |
| L-29 | **Calendar invitations seen in no real mail client** (Phase 14). The iTIP messages follow RFC 5545/5546/6047 and the structure Google Calendar sends and Microsoft's [MS-STANOICAL] describes, checked by parsing what a real SMTP server received and by an independent iCalendar parser; Google documents none of Gmail's iMIP handling. With **Resend** the event is an attachment only (its API has no alternative parts): Outlook does not process it as an invitation. Also unverified: whether Google Calendar honours `CLASS:PRIVATE` on the host's invited event (Outlook marks such an item private; B14-19), and how each client applies the withdrawal from an old address, a CANCEL that uninvites one attendee without `STATUS` (B14-17) | Gmail's card, Outlook's meeting bar and Apple Mail's invitation may differ from the specification's reading; Outlook users of a Resend deployment open the `.ics` themselves, and its entry does not move or go by itself | The real-client check of §15 E with the owner's consent ([phase-14-backend.md](decisions/phase-14-backend.md), open items 1 to 3, 8, 11, 12); production sends through SMTP |
| L-28 | Wording (Arabic acceptance run). **Fixed:** the demo company's address is seeded in Arabic (B10-23; it was English in the Arabic part of the e-mails and in settings); a reception refusal shows its title alone («أُلغيت الزيارة بواسطة …» over «أُلغيت هذه الزيارة.» said one fact twice; F10-gap-5); under a minute reads «قبل أقل من دقيقة» and «منذ أقل من دقيقة في الداخل», not «قبل < 1 د» (F10-gap-6). **Kept, deliberate:** «تسجيل الدخول» and «تسجيل الخروج» name both the staff's sign-in and sign-out and a visitor's check-in and check-out (F10-rf-3: the standard Arabic terms; the staff's sign-out is only in the account menu, and every visitor action stands in the visitor's row, result or dialog) | Cosmetic | — |

---

## 15. Go-live checklist

**B** = blocking for production traffic. **R** = recommended. **(B for bank/gov)** = blocking for bank
and government deployments.

### A. Repository and release

- [ ] **B** Commit the root `.gitattributes` with the first commit. It exists (`*.sh`, `Dockerfile` and
  `docker-compose.yml` with `eol=lf`; `git check-attr` confirms the rules apply) but nothing is committed
  yet.
- [ ] **B** `python3 deploy/verify/check_release_tree.py` exits 0. Every `!!` entry in
  `git status --porcelain --ignored` belongs to a known family. The full list is in
  [decisions/phase-9-deploy.md](decisions/phase-9-deploy.md), "Release checklist".
- [ ] **B** Set up a CI pipeline that runs, on every push:
  - the backend gate: ruff, the format check, mypy, `pytest` and `pytest --committed-first`;
  - the frontend gate: typecheck, lint, Vitest and build;
  - the Playwright suite;
  - `check_nginx_headers.mjs`, `check_release_tree.py` and the deploy unit tests (with PyYAML), hadolint, shellcheck and `ruff check deploy`.

  CI needs PostgreSQL with the `vms_owner`/`vms_app` roles and the `vms_e2e` database
  (`scripts/db.ps1 init`), the backend virtual environment, and `npx playwright install chromium`.
- [ ] **R** Add `pip-audit`, `npm audit --omit=dev`, image scanning and an SBOM to CI (audit
  recommendation 8).
- [ ] **R** Fold the Phase 8 and 9 changes into the contract (its revision 3 covers Phase 10 only) and
  the Phase 9 changes into `security-audit.md` (§13.3).

### B. Build and verify the containers (never done on the build machine)

- [ ] **B** `docker compose build` on the Linux target or a CI runner; record the image digests.
- [ ] **B** `docker compose up -d` on staging with test certificates: `postgres`, `backend`, both
  `backend-reception` replicas, `backend-reports` and `frontend` healthy; `migrate` exited 0.
- [ ] **B** `python3 deploy/verify/smoke_test.py --base-url https://<name> --http-url http://<name>`
  passes. Also run it with `--admin-email … --expect-client-ip <your address>`, so that the recorded
  client IP and request ID are checked.
- [ ] **B** Both list replicas serve: Docker's DNS answers `backend-reception` with two addresses, and
  nginx's access log shows list requests answered by both (the smoke test proves only that one
  replica answers).
- [ ] **B** Routing on the raw path in the container (D9-36): non-canonical spellings of a routed read,
  for example `GET /api/v1/visitors/../visits` and `GET /api/v1/reception/%74oday` sent with
  `curl --path-as-is`, show `api_pool` `vms_api` in nginx's access log.
- [ ] **B** Browser flow on staging: sign-in, camera scan, check-in and check-out, with no CSP
  violations in the console.
- [ ] **B** Container hardening as configured:
  - non-root users, read-only root filesystems, `cap_drop: ALL`, health checks;
  - `docker compose stop` finishes in under 45 s for every API process, and the flush rows appear in
    the audit log.
- [ ] **B** PostgreSQL first start: roles and grants as `deploy/postgres/initdb/10-vms-roles.sh`
  defines them. A visitor search for an Arabic name returns results (trigram index with the
  en_US.UTF-8 ctype).
- [ ] **B** `scripts/backup.sh --compose` and `scripts/restore.sh --compose` drill on staging; the
  archive files are mode 0600.

### C. Infrastructure and TLS

- [ ] **B** A DNS name, a certificate from a trusted CA in `deploy/tls/` (key readable by gid 101),
  `VMS_SERVER_NAME` set, and a renewal procedure.
- [ ] **B** Reception tablets reach the system over HTTPS with the DNS name. The camera needs a secure
  context.
- [ ] **B** If the database is on another host: `DB_REQUIRE_TLS=true` and
  `sslmode=verify-full&sslrootcert=…` on both URLs, and a verified connection.
- [ ] **B** NTP on the API and database hosts. Pass, session and token windows depend on the clock.
- [ ] **B** If a load balancer terminates TLS in front of nginx: the `real_ip` setup of runbook §3, and
  `TRUSTED_PROXIES` still names only nginx.
- [ ] **R** IPv6: enable it on the `app` network, or disable Docker's userland proxy, before serving
  IPv6 clients.
- [ ] **R** Volumetric DDoS protection upstream of nginx.
- [ ] **R** Host sized for the Compose limits (§7.4) on SSD storage; PostgreSQL memory settings scaled
  if the limit or the number of list replicas changes.

### D. Configuration and secrets

- [ ] **B** Secrets generated as the runbook shows, held in a secret store, and injected into
  `deploy/env/*.env` (mode 600). Never in images, compose files or the repository.
- [ ] **B** The API services start in production mode with the final environment: no refusal in
  `docker compose logs backend backend-reception backend-reports`.
- [ ] **B** `TRUSTED_PROXIES` = nginx's address only. `ALLOWED_ORIGINS`, `APP_BASE_URL` and
  `QR_BASE_URL` = the public https origin.
- [ ] **B** First administrator created with `create-admin` (password via prompt or `--password-stdin`),
  with the correct company timezone. No demo seed: the database was never seeded and is not a restored
  demo (the API refuses to start otherwise, §13.5).
- [ ] **B** The platform owner's account created with `create-platform-admin` on the server (the generated
  password handed over once and changed at the first sign-in); a second platform account for recovery;
  the recovery procedure (`--reset` with a generated password, [security.md](security.md) §3.7) known to
  the on-call team.
- [ ] **B** A credential rotation procedure that includes `ALTER ROLE vms_app RESET ALL`.
- [ ] **R** Session lifetimes reviewed against the customer's policy (shorter idle time for shared
  desks).

### E. E-mail

- [ ] **B** A Resend account with a verified sending domain and `EMAIL_FROM` on that domain, or the
  organisation's own mail server with `EMAIL_PROVIDER=smtp` over TLS (`ssl` on 465 or `starttls` on
  587). Gmail with an App Password suits a pilot only (L-27). `EMAIL_FROM` with the display name
  "Mawdoo3 Visitors"; credentials only in `deploy/env/backend.env`.
- [ ] **B** SPF, DKIM and DMARC for the sending domain.
- [ ] **B** Egress from the API containers to `api.resend.com`, or to the SMTP server's port, allowed
  through the firewall or proxy.
- [ ] **B** `send-test-email` from the API container (README §10): the test message arrives with the
  logo and the sample QR code.
- [ ] **B** `QR_BASE_URL` is the public `https://` origin and opens on a visitor's phone (L-26).
- [ ] **B** Real delivery test in the customer's mail clients (Outlook for Windows included), with the
  company's default language and with the other one, each in light and in dark mode (L-24):
  - the company's logo readable in the header (in dark mode: its logo for dark surfaces where the company
    has one, else the logo on a white tile);
  - an invitation whose inline QR displays and scans at the desk;
  - the pass-page fallback link;
  - the host-arrival e-mail;
  - the password-reset e-mail.
- [ ] **B** **Calendar invitations** (Phase 14, L-29) in a Gmail or Workspace mailbox and an Outlook
  mailbox (Microsoft 365 or outlook.com), each opened on the web and on a phone: the visitor's calendar
  invitation (it follows the invitation) and the host's notice of a new visit show an invitation that is
  added with one action; a new time moves the entry; a cancellation removes it (Outlook may keep
  "Canceled: …" until it is removed). No link appears in the calendar entry. Also: the host's entry is
  private in a calendar shared with a colleague (Outlook; Google's handling of `CLASS:PRIVATE` is
  unverified), and a visitor's address changed in the app takes the entry out of the old address's
  calendar. The procedure that sends one sample invitation, its new time and its cancellation without
  the database is in the final report of the Phase 14 backend.
- [ ] **B** **Release gate for calendar events (Phase 14, B14-24, B14-27): `CALENDAR_INVITATIONS_ENABLED`
  stays `false` (as `deploy/env/backend.env.example` has it) until a dedicated sending mailbox, with SPF,
  its own DKIM and DMARC.** Production is deployed with calendar e-mails off: the e-mails go as before,
  and no calendar gets a new entry. Switch it on (`true`, then `docker compose up -d` to recreate the API
  containers) only when all of the following hold; switching it off again later leaves no wrong entry
  (the calendars that hold a visit still get its new time and its removal). Before calendar invitations
  are sent from production:
  - `EMAIL_FROM` is **a mailbox of the system's own that hosts nobody** (for example `visits@<domain>` in
    the same Workspace, with its own App Password): not a person's mailbox, and no alias, `+tag` or other
    address of one. It organizes every calendar event; a host whose address it is gets the host's e-mails
    without the event (no calendar adds an invitation to its own organizer; the system recognises the
    address in any spelling, but not an alias of another account), and Gmail sends recipients' answers
    (Yes / No / Maybe) to it. On the current production `EMAIL_FROM` is a person's mailbox
    (`hamad.raouf@salma.ai`), which fails this gate.
  - The Google Workspace domain **signs with its own DKIM key** (Admin console → Apps → Google Workspace
    → Gmail → Authenticate email; the `google._domainkey` TXT record published and authentication
    started), not only Google's default signature, so that `From`, the envelope sender and the
    `ORGANIZER` of every event are one address of a domain that authenticates itself: Outlook shows a
    sender that differs from the organizer as "on behalf of", and clients may refuse an invitation whose
    sender they cannot tie to its organizer ([phase-14-backend.md](decisions/phase-14-backend.md) B14-5).
  - The sending domain publishes **SPF** (Google's `include:_spf.google.com` for Workspace) and a
    **DMARC** record (`_dmarc.<domain>`; `p=none` with reports while it is new, then `quarantine`), so
    that receivers can authenticate the mailbox the invitations come from. Today salma.ai has neither
    SPF, nor its own DKIM, nor DMARC.
  - `CALENDAR_EMAIL_COMPANY_DAILY_LIMIT` times the number of companies, with the invitations and the
    other e-mails, stays below the mailbox's daily cap (Google Workspace: 2,000 messages a day).

### F. Monitoring and logging

- [ ] **B** API and nginx logs shipped to the SIEM with access control. nginx error logs are classed as
  sensitive.
- [ ] **B** Alerts from §5.3 in place, at least: health, unexpected restarts of each API process,
  start-up refusals, desk latency, reception-list latency, 5xx, FAILED and stuck e-mails,
  `AUTH_ACCOUNT_THROTTLED`, flood rows, 429 spikes per API pool, backup failures and certificate expiry.
- [ ] **B** A read-only monitoring role for the §5.4 queries. Never grant extra rights to `vms_app`.

### G. Operations

- [ ] **B** Backups scheduled (runbook example: every 6 hours), copied off the host encrypted, with a
  retention period set.
- [ ] **B** A restore drill on production hardware, with the RTO recorded. Repeated quarterly.
- [ ] **(B for bank/gov)** Continuous WAL archiving (pgBackRest or WAL-G) for point-in-time recovery,
  RPO about 1 minute.
- [ ] **B** `prune-sessions` scheduled weekly. **R** `mark-no-shows` nightly (optional).
- [ ] **B** `prune-journeys` scheduled daily (Phase 15; deploy/README.md), even while tracking is off.
- [ ] **B** Upgrade procedure: back up first. For an existing large database, create the revision-0010
  indexes `CONCURRENTLY` before migrating. Downgrade only with the API stopped.
- [ ] **B** Incident runbook available to the on-call team: restore and rename, secret rotation, the
  emergency session revocation SQL ([security.md](security.md) §4.4).

### H. Security and compliance

- [ ] **B** The deploying organisation's security owner signs off the per-process budgets of the
  four-process layout. This is an organisational decision; no engineer can tick it. The engineering
  security review is done: it found the trade acceptable with conditions, and R-1 and recommendation 5
  of `security-audit.md` are reworded (§13.1). What is signed off:
  - one user can make up to 4 × `RATE_LIMIT_API_PER_MINUTE` API requests a minute in all (2,400 by
    default; writes at most 600);
  - one user can cause up to 44 `ACCESS_DENIED` audit rows a minute and 8 `RATE_LIMITED` rows for the
    per-user API budget, against 11 and 2 with one process;
  - the operating rule "exactly one `backend` process", which also forbids
    `docker compose up --scale backend=N`.
- [ ] **(B for bank/gov)** An independent penetration test of the deployed stack: nginx, TLS,
  containers, real Resend, and Safari/iPadOS and Firefox on the reception tablets.
- [ ] **B** A managed browser policy on shared reception tablets and kiosks (security.md §16, item 17).
  Staff sign out explicitly.
- [ ] **B** Reception procedure and training: **verify the visitor's ID on every scan**. A QR pass
  proves an invitation, not identity.
- [ ] **B** Data-retention policy for visitors, visits, the audit trail, sessions and backups, plus any
  DPIA the customer requires. There is no automated deletion or anonymisation.
- [ ] **R** A decision on MFA or SSO for administrators.
- [ ] **R** A decision on SEC-05's long-term fix at the next contract revision.

### I. Devices, accessibility and performance acceptance

- [ ] **B** A pilot on the actual reception tablets: camera start and lighting, the handheld scanner if
  used, and the browser the customer uses (iPadOS Safari has never been tested).
- [ ] **B** On production hardware during the pilot, with the planned number of open reception pages:
  scan and check-in p95 < 300 ms on `backend`, and `GET /reception/today` p95 < 300 ms on the list
  replicas. Capacity confirmed, or replicas added per runbook §4.
- [x] **B** Fix the three layout defects of the Arabic acceptance run (L-21 to L-23) and re-check them in
  Arabic on the reception tablet's width (820 px) and in the Add user dialog (F10-gap-1 to F10-gap-3,
  with E2E checks at 1440, 820 and 390 px in both languages). Re-check on the real tablet in the pilot.
- [ ] **R** A login storm at shift start, through the real network address translation.
- [ ] **R** A screen-reader spot check (NVDA or VoiceOver) of sign-in, invite and reception.

### J. Visitor Journey (Phase 15): before any real visitor is tracked

The Visitor Journey ships **off** (`TRACKING_PROVIDER=disabled`; [visitor-journey-design.md](visitor-journey-design.md)).
None of these is needed to go live without it; every one is blocking before a company's tracking is
allowed with a real provider:

- [ ] **B** A real provider adapter exists, reviewed and tested on site. Today it is **BLOCKED BY
  ENVIRONMENT** ([visitor-tracking-model-assessment.md](visitor-tracking-model-assessment.md); what it still
  needs: [visitor-tracking-integration.md](visitor-tracking-integration.md) §9). No real-model test has run.
- [ ] **B** The **privacy owner's written approval** of: the purpose; the lawful basis under Jordan's
  Personal Data Protection Law (No. 24 of 2023); the notice visitors are given before enrollment; who may
  see journeys (the product allows administrators, management and reception); the retention
  (`journey_retention_days`, 1–90) and the provider's own retention of images, crops and galleries; and,
  where required, a privacy impact assessment. The building's and tenants' contracts allow the camera use.
- [ ] **B** An **evaluation-based confidence threshold**: the model's true and false match rates measured on
  this site's footage, and from them the company's `min_confidence`. Until it is set, no observation counts
  as confirmed and no location is shown (by design).
- [ ] **B** The placeholder constants reviewed against the cameras' analysis classes and the evaluation:
  the 60-second conflict window, the 5-minute contact timeout, the 2-minute clock tolerance, the
  10-minute time to activate an enrollment, the 12-hour association limit after activation, the stale
  threshold (decisions/phase-15-backend.md B15-16).
- [ ] **B** `TRACKING_PROVIDER` never `simulator` on production (the API refuses to start with it); the
  provider's key created by the company's administrator, stored only in the provider's secret store, and
  rotated through the two-key slot.
- [ ] **B** Reception trained: enrollment binds "the person at the reception camera now"; the screen shows an
  **inferred** location, never a guaranteed one.

---

## 16. Open items by owner

These are hand-overs recorded in the decision files and the re-audits that this report did not change.

| Owner | Item | Source |
|---|---|---|
| Repository | Commit the root `.gitattributes` (present, LF for `*.sh`, `Dockerfile` and `docker-compose.yml`); CI pipeline | phase-9-deploy.md, Hand-over |
| Backend | Request-session clean-up off the event loop on cancellation (L-8); deliveries aware of shutdown (L-9); `Retry-After` on the API's 503, and the envelope for a request cancelled at shutdown (L-11); a clear message for `prune-sessions` without the owner URL (L-18); optional `RESEND_API_URL` for drills (L-12) | phase-9-deploy.md; readiness round 1; re-audit rounds 1 and 2 |
| Frontend | Show the date or "tomorrow" on Expected rows that are not today (L-13). The two findings of re-audit round 2 (L-19, L-20) are fixed: F9-10 and F9-11, and so are the three layout defects of the Arabic acceptance run (L-21 to L-23) and its wording observations but one (L-28). | phase-9-backend.md, SEC-R2 hand-over; phase-9-frontend.md; Arabic acceptance run (2026-10-08) |
| Contract and frontend | Slim `/reception/today` items, drop or make opt-in `inside` and `checked_out`, or counts-only polls (L-6; it also lowers the number of list replicas a site needs); a capped or estimated audit total (L-7); a `REPORTED_LOST` revoke reason (closes the SEC-09 class) | phase-9-backend.md, RR1-05, RR1-07, RA1-01, RA1-02, SEC-R2; D9-35 |
| E2E | Consider warming the newly lazy routes (`/admin`, `/admin/users`, `/admin/departments`, `/admin/settings`, `/visits` and the detail pages) in the global setup. The regression checks the hand-over asked for (320 px, focus under sticky bars one animation frame after each Tab, tab focus rings, the evacuation list's hit areas at 1180 × 820 with touch) are done and passed in the final release gate (§10.3). | phase-9-frontend.md, Hand-over and Re-audit round 2 |
| Deployment | Re-check the serial audit count's plan and stress B under the Compose CPU limits on the Linux host. The raw-path routing in the Linux container and over HTTP/2 (§15 B). Condition 4 of the security review, the compose test of the read services' settings, is done (D9-37, §13.1). | Re-audit round 2 (operations, performance); RA1-02; D9-36; D9-37 |
| Security owner (deploying organisation) | Sign off the per-process budgets of the four-process layout (§15 H). The engineering review and the rewording of R-1 and recommendation 5 are done. Fold the remaining Phase 9 changes into `security-audit.md` (§13.3). | security-audit.md R-1 closure note; phase-9-deploy.md D9-34 to D9-37; phase-9-backend.md |
| Contract owner | Revise `docs/initial-assessment.md` further (revision 3 added Phase 10 only): Phase 8 deviations, §3 process model (four API processes), §7.3 budgets, §8.1 window-based Expected list, §9 dispatcher, `no-store` for `index.html` | Decision files; audit recommendation 10 |
| Development cluster | Optionally apply the Compose planner settings (`random_page_cost` 1.1) to `scripts/db.ps1`, so local plans match production. The leftover throwaway database `vms_migration_temp_e82431bc`, from an interrupted test run, was dropped on 2026-10-07; the final release gate found no leftover database on the cluster. | phase-9-deploy.md; readiness round 2; final release gate |
