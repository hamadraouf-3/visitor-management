# Security Audit Report: Mawdoo3 Visitors

| | |
|---|---|
| **Audit date** | 2026-10-06 (Phase 8 of the implementation plan, `docs/initial-assessment.md` §15) |
| **System** | Mawdoo3 Visitors («زوار موضوع»): FastAPI + SQLAlchemy + PostgreSQL 18 backend (`backend/`), React + TypeScript PWA (`frontend/`). At the time of the audit the product had not yet been named; Phase 10 named it and made it bilingual |
| **Code state audited** | Database migration head `0009`. The repository has no commits yet, so the state is identified by the migration head and the final test counts in Appendix A. |
| **Binding design contract** | `docs/initial-assessment.md` (revision 2). Deviations are recorded in `docs/decisions/*.md`. |
| **Readers** | Customer security reviewers (CISO office of a bank or government body) and the engineering team |
| **Result** | 0 critical, 0 high. 51 confirmed finding reports covering 49 distinct issues: 47 fixed and verified, 1 deferred with a mitigation, 1 accepted risk. 10 candidate findings were refuted. Completion Gate 8 **holds** (§8). |
| **Later notes** | Phase 9 closure, 2026-10-07: dated notes on SEC-15, R-1, R-10 and recommendation 5 record the four-process deployment and its engineering security review ([§6, R-1 closure note](#r-1-phase-9-closure-2026-10-07)). Phase 10, 2026-10-08: [Appendix D](#appendix-d-phase-10-note-2026-10-08) lists what Phase 10 changed that this audit did not cover, and how it was reviewed. The Phase 8 text above each note is unchanged. |

---

## 1. Summary

### 1.1 Scope

The audit covered the whole application: the API, the single-page application and its service worker,
the database schema, roles and migrations, the e-mail pipeline, configuration validation, logging, and
the dependency locks. It covered the 20 areas named in the Phase 8 brief (§2.2). The product has no file
upload feature; §2.2 and §5.14 explain how that was checked.

Not in scope, because it does not exist yet: the production deployment. The Dockerfiles,
`docker-compose.yml`, the nginx reverse-proxy configuration and TLS termination are Phase 9 deliverables
(§6, R-4). Every control in this report that will depend on nginx was verified against `vite preview` and
against the API directly.

### 1.2 Method

- **Eight independent lenses**, each run by a separate auditor with its own throwaway database and
  server: (1) authentication and sessions; (2) authorization, RBAC and tenant isolation; (3) QR pass
  tokens and reception; (4) injection, CSRF, XSS and browser security headers; (5) rate limiting and
  denial of service; (6) secrets, logging, PII and error responses; (7) supply chain and database
  privileges; (8) frontend, PWA and browser storage.
- **Three rounds.** Each round re-ran all eight lenses against the code as fixed by the previous round.
  Round 1 reported SEC-01 to SEC-29, round 2 SEC-30 to SEC-41 and round 3 SEC-42 to SEC-51. Most
  later-round findings were gaps in, or bypasses of, earlier fixes. Examples: SEC-30 (device trust from
  SEC-01 was never revoked), SEC-31 and SEC-37 (holes in SEC-07's re-check), SEC-32 (a bypass of SEC-09),
  SEC-43 (SEC-02's budget applied to login only) and SEC-48 (a gap in SEC-40).
- **Two-skeptic adversarial verification.** Every candidate finding went to two independent verifiers.
  Each tried to refute it and reproduced it, live where possible, against their own throwaway database.
  Only findings that survived both were confirmed. Ten candidates were refuted (§4).
- **Fixes with regression tests.** Each confirmed finding was fixed at its root cause, and a regression
  test was added. Each fix was then undone on its own to check that its test failed without it (mutation
  check). The decisions and trade-offs are recorded in `docs/decisions/phase-8-backend.md` and
  `docs/decisions/phase-8-frontend.md`.
- **Regression verification.** After round 3 an independent verifier did three things: re-ran the
  backend and frontend suites, re-checked every finding, and checked the reasoning behind every non-fix.
  Findings were re-checked live against a fresh database where possible, in-process where the check
  needs production settings, and otherwise by inspecting the fix and running its regression tests.
  **No fix failed regression verification.**

### 1.3 Headline counts

Two pairs of reports describe the same issue: SEC-14 duplicates SEC-02, and SEC-16 duplicates SEC-12.
Distinct issues are counted at the higher of the two ratings, so SEC-02/SEC-14 counts once, as medium.

| Severity | Distinct issues | Fixed and verified | Deferred (mitigated) | Accepted risk |
|---|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 | 0 |
| High | 0 | 0 | 0 | 0 |
| Medium | 5 | 5 | 0 | 0 |
| Low | 34 | 33 | 1 (SEC-05) | 0 |
| Info | 10 | 9 | 0 | 1 (SEC-29) |
| **Total** | **49** | **47** | **1** | **1** |

Counted as the 51 reports: 5 medium, 36 low and 10 info. By round: round 1 had 29 reports (3 medium),
round 2 had 12 (1 medium) and round 3 had 10 (1 medium).

### 1.4 What the audit found, by theme

| Theme | Findings | Outcome |
|---|---|---|
| Account lockout abuse and its recovery path | SEC-01, SEC-30 | Device-trust cookies, revoked when credentials change or the account is deactivated. A reset now lifts the block. |
| In-flight requests outliving revocation | SEC-07, SEC-31, SEC-37 | Authorization is re-checked under the company row lock on every administrative and visit or visitor write. READ COMMITTED is pinned. |
| Resource exhaustion through *successful* operations | SEC-02/14, SEC-15, SEC-42, SEC-43, SEC-44 | Success budgets for sign-in and password change, a budget of written audit rows, and an honest 422 for requests that can never succeed. |
| Weak passwords | SEC-03 | Dictionary, leetspeak and account-word rules; a 1,305-entry breached list. |
| Session hygiene | SEC-04, SEC-06 | Rotation on password change, and a "password changed" notice. |
| Database runtime-role hardening | SEC-21, SEC-22, SEC-23, SEC-38, SEC-49 | Column-level grants, no TEMPORARY, and an allowlist privilege check at production startup. |
| Production configuration guardrails | SEC-17, SEC-18, SEC-35, SEC-36, SEC-40, SEC-46, SEC-47, SEC-48 | Production refuses unsafe proxies, secrets, database URLs, missing TLS to the database, and limits that switch limiting off. |
| Log and audit integrity | SEC-11, SEC-12/16, SEC-19, SEC-45 | Inert log lines, server-attested request IDs, DETAIL redaction, and no WebSocket header dumps. |
| Shared-device data remanence in the SPA | SEC-20, SEC-26, SEC-27, SEC-28, SEC-41, SEC-50, SEC-51 | Search text kept out of URLs, cross-tab sign-out, session heartbeat, a back/forward-cache check and a toast reset. |
| Visitor-pass and reception logic | SEC-09, SEC-32 | A reported-lost pass can no longer admit a second person through a walk-in. |
| Unicode spoofing (bidi, digits, line breaks) | SEC-10, SEC-33, SEC-34 | Names and phone numbers display, dial and e-mail what they store. |
| Authorization scope edge cases | SEC-08, SEC-24, SEC-39 | Ownership through creation is limited; downgrades cannot widen scope. |
| Supply chain and redirects | SEC-25, SEC-13 | Hash-pinned Python locks; no trailing-slash redirects. |
| Enumeration | SEC-05 | Deferred (needs a contract change); bounded to 10 confirmations per administrator per hour. |
| Reset token in the browser's saved history | SEC-29 | Accepted. No page can remove it; mitigated by the token's lifetime and the shared-device policy. |

### 1.5 Overall assessment

The application code shows a deliberate defence-in-depth design:

- server-side sessions with immediate revocation;
- a global CSRF and Origin middleware, and no CORS;
- 256-bit opaque tokens stored only as hashes;
- composite tenant foreign keys;
- an append-only audit trail enforced by database triggers and grants;
- a runtime database role that cannot delete, run DDL or alter the audit order;
- production startup checks that refuse unsafe configurations.

Across three rounds, eight lenses and more than 3,000 live authorization requests, no critical or high
issue was found. All medium issues are fixed and verified.

**This is not yet a production readiness sign-off.** TLS, the reverse proxy, the container images,
secrets management, monitoring and an independent penetration test of the deployed stack are still open
(§7). Several controls in this report depend on the Phase 9 nginx configuration being written exactly as
specified.

### 1.6 Completion Gate 8

**Holds.** No critical or high issue was confirmed, so none remains unresolved. The two open items are
SEC-05 (low, deferred with a mitigation) and SEC-29 (info, accepted). Both carry explicit justification.
See §8.

---

## 2. Scope and method

### 2.1 System under test

- **Backend:** Python 3.14, FastAPI, SQLAlchemy 2 (sync) and psycopg 3. It runs as
  `python -m app.serve` (uvicorn, `workers=1`, `proxy_headers=False`, `server_header=False`, its own access
  log, `ws="none"`).
- **Database:** PostgreSQL 18.6. `vms_owner` owns the schema and runs migrations; `vms_app` is the
  runtime role.
- **Frontend:** React 19 + TypeScript SPA built with Vite. TanStack Query holds server state. A service
  worker precaches static assets. The QR decoder is a self-hosted zxing WebAssembly module.
- **E-mail:** Jinja2 templates; the Resend HTTP API in production, a local outbox in development.
- **Tenancy:** many companies share one database; `company_id` comes only from the session user.

### 2.2 Areas in scope (Phase 8 brief)

| Area | Lenses | Report sections |
|---|---|---|
| Authentication | 1, 5 | SEC-01, -03, -06, -30; §5.1 |
| Authorization | 2 | SEC-07, -08, -24, -31, -37; §5.4 |
| RBAC (role matrix §7.5) | 2, 8 | §5.4 |
| Tenant isolation | 2, 3, 7 | §5.4, §5.5, §5.11 |
| QR token security | 3 | SEC-09, -32; §5.5 |
| Session security | 1, 8 | SEC-04, -26, -50, -51; §5.2 |
| Password storage | 1, 7 | §5.1 |
| CSRF | 4 | §5.3 |
| XSS | 4, 8 | SEC-33; §5.6 |
| SQL injection | 4 | §5.6 |
| Rate limiting | 5 | SEC-01, -02/14, -15, -42, -43, -44, -46; §5.7 |
| Secrets | 6, 7 | SEC-17, -35, -36, -47; §5.9 |
| CORS | 4 | §5.3 (no CORS anywhere, by design) |
| Security headers | 4, 8 | SEC-13; §5.8 |
| PII exposure | 6, 8 | SEC-20, -27, -28, -41; §5.10 |
| Logs | 6 | SEC-11, -12/16, -19, -45; §5.10 |
| Error responses | 6 | §5.10 |
| File uploads | 4, 6 | **Not applicable: the product has no file upload.** No endpoint takes a file (there is no `UploadFile` or `File` parameter in `backend/app`). Bodies are JSON only; form and multipart bodies answer 422, and bodies are capped at 64 KiB. The only binary data is the QR PNG the server generates (§5.14). |
| Email injection | 4 | SEC-34; §5.6 |
| Enumeration | 1, 2, 3, 5 | SEC-05; §5.15 |

### 2.3 Test environment

- Windows 11 with a portable PostgreSQL 18.6 on localhost. Every lens and verifier created its own
  throwaway databases (migrated as `vms_owner` and seeded with `python -m app.cli seed-e2e`: two
  companies, every role) and dropped them afterwards.
- The API ran as `python -m app.serve` on per-agent ports, with `EMAIL_PROVIDER=outbox`. Production-only
  checks were exercised by starting the server with `APP_ENV=production`, or in-process.
- The SPA was exercised as a production build behind `vite preview` (which sends the §10 header set) in
  Playwright's Chromium. Persistent browser profiles were used where browser storage was examined.
- The project's own suites were run at the end of each round: pytest against real PostgreSQL, Vitest,
  and Playwright (by the frontend fixer). The final regression pass re-ran pytest and Vitest
  (Appendix A).

### 2.4 Limitations

- **Round 2 rate-limiting lens:** an automated safety classifier stopped its live login probing. Only
  one live test ran in that pass; the rest of that lens's round-2 results come from code review. Round 1
  of the same lens and the regression verification (SEC-01, SEC-02, SEC-30, SEC-43) exercised the login
  and password limits live. Round 3 of that lens probed the password-change, body-size and proxy-header
  limits live.
- **No production stack.** nginx, TLS termination, the containers and a real Resend account were not
  available. The Resend adapter was tested against a local fake server.
- **One browser.** Only Chromium was used. Safari/iPadOS and Firefox are supported browsers (§10) and
  were not exercised, notably for back/forward-cache and cross-tab behaviour.
- **No load testing.** Denial-of-service findings come from targeted probes and code review, not
  sustained load. This was not an external penetration test, and infrastructure and network were out of
  scope (§7, recommendation 7).

### 2.5 Pre-audit hardening (Phase 5–7 leftovers closed in Phase 8)

Before round 1, the last Phase 5–7 verification round was closed (records: L-BE-n in
`phase-8-backend.md`, L-FE-n in `phase-8-frontend.md`). These are not counted in §1.3, but five of them
are security-relevant:

- **L-BE-1:** request text made only of invisible characters (U+200B, U+FEFF, U+2060, the Hangul fillers,
  U+2800) is treated as empty. `strip_invisible` (`backend/app/schemas/common.py`) trims Unicode's
  default-ignorable characters at both ends, and keeps interior ZWNJ and ZWJ. Before this, a checked-in
  visitor could have no visible name on the evacuation list and the "Verify ID" cue. 49 new tests fail
  with the old trimming.
- **L-FE-38:** the client mirrors L-BE-1 (`isBlankText`).
- **L-BE-2:** refused MANUAL, OVERRIDE and CORRECTED attendance changes and refused walk-ins have a
  budget of 30 per user per minute (`RATE_LIMIT_ATTENDANCE_REFUSALS_PER_MINUTE`). Before, a scripted
  reception session could append about 600 uncoalesced audit rows a minute.
- **L-BE-3:** six two-connection tests prove the lock-order claims for bulk stale check-out and for host
  deactivation racing a check-in.
- **L-FE-3:** filters show only names the server returns for an ID. A crafted URL can no longer make the
  audit-log or history filter display an arbitrary name.

The other 36 frontend items were usability, accessibility and print-layout fixes.

---

## 3. Findings

Severity scale used in this report:

- **Critical:** remote compromise of data or the system without credentials.
- **High:** significant data exposure, privilege escalation or broad outage with low privileges or none.
- **Medium:** a meaningful authorization, integrity or availability impact that needs one realistic
  precondition (a known e-mail address, one valid account, a race the attacker can widen).
- **Low:** needs significant preconditions (an insider, an operator misconfiguration, a leaked
  credential) or has a limited impact; defence-in-depth gaps.
- **Info:** hardening or hygiene with no demonstrated exploit path.

### 3.1 Findings table

Status values: **Fixed, verified** means a root-cause fix, a regression test that fails without it, and a
pass in the final regression verification.

| ID | Sev | Title | Area | Status |
|---|---|---|---|---|
| SEC-01 | Medium | Anonymous attacker can keep any known account locked out indefinitely; reset made it worse | Authentication / rate limiting | Fixed, verified |
| SEC-02 | Low | Successful logins unthrottled: unbounded Argon2 work and append-only row growth | Rate limiting / DoS | Fixed, verified |
| SEC-03 | Low | Password blocklist too small: spray passwords such as Welcome@2026 accepted | Authentication | Fixed, verified |
| SEC-04 | Low | Current session not rotated on password change | Session | Fixed, verified |
| SEC-05 | Low | Global e-mail uniqueness lets a tenant admin test whether an address has an account elsewhere | Enumeration | **Deferred (mitigated)** |
| SEC-06 | Low | No notification when a password is changed or reset | Authentication | Fixed, verified |
| SEC-07 | Medium | A deactivated or demoted admin's in-flight request still commits after revocation | Authorization | Fixed, verified |
| SEC-08 | Low | Former receptionist keeps access to every visitor registered at the desk | Authorization | Fixed, verified |
| SEC-09 | Low | LOST_PASS walk-in leaves the reported-lost pass valid | QR pass | Fixed, verified |
| SEC-10 | Low | Bidi overrides make displayed phone/name differ from stored/dialled | Output integrity | Fixed, verified |
| SEC-11 | Low | Logs carry raw C1 controls and line separators; records dropped on Windows | Logging | Fixed, verified |
| SEC-12 | Low | Client-chosen X-Request-ID written to audit rows | Logging / audit integrity | Fixed, verified |
| SEC-13 | Info | Trailing-slash redirect builds Location from the Host header | Configuration | Fixed, verified |
| SEC-14 | Medium | Successful authentication has no rate limit (duplicate of SEC-02) | Rate limiting / DoS | Fixed, verified |
| SEC-15 | Low | Non-coalesced security audit rows grow an un-prunable table | Logging / DoS | Fixed, verified (attributed part) |
| SEC-16 | Low | Any client can choose its request ID (duplicate of SEC-12) | Logging / audit integrity | Fixed, verified |
| SEC-17 | Low | Rejected database URL echoed with its password at startup | Secrets | Fixed, verified |
| SEC-18 | Low | Production accepts catch-all TRUSTED_PROXIES | Configuration | Fixed, verified |
| SEC-19 | Info | Unhandled-exception logs carry PostgreSQL DETAIL with PII | Logging / PII | Fixed, verified |
| SEC-20 | Info | Visitor search terms in the page URL stay in browser history | PII (browser) | Fixed, verified |
| SEC-21 | Low | Runtime role can choose audit_logs.seq: forge order or block audit writes | DB privileges | Fixed, verified |
| SEC-22 | Low | No-TEMPORARY rule for the runtime role not enforced by the migration | DB privileges | Fixed, verified |
| SEC-23 | Low | Production accepts the schema-owner role as DATABASE_URL | Configuration / DB | Fixed, verified |
| SEC-24 | Low | Revision 0003 downgrade loses data and widens EMPLOYEE scope | Authorization / migrations | Fixed, verified |
| SEC-25 | Info | Python lock files not hash-pinned | Supply chain | Fixed, verified |
| SEC-26 | Low | Sign-out or sign-in in another tab leaves the previous user's data on screen | Session (browser) | Fixed, verified |
| SEC-27 | Low | Visitor names in page titles and search text in URLs persist in browser history | PII (browser) | Fixed, verified |
| SEC-28 | Info | Back-link labels in history.state carry names across sign-out | PII (browser) | Fixed, verified |
| SEC-29 | Info | Reset token remains in the browser's saved history | Secrets (browser) | **Accepted risk** |
| SEC-30 | Medium | Device trust is never revoked: farmed cookies survive reset and deactivation | Authentication | Fixed, verified |
| SEC-31 | Low | SEC-07 gap: revoked admin's in-flight POST /users mints a SYSTEM_ADMIN | Authorization | Fixed, verified |
| SEC-32 | Low | SEC-09 bypass: lost-pass walk-in typed as a new visitor | QR pass | Fixed, verified |
| SEC-33 | Low | Arabic-Indic phone numbers: empty or wrong tel: links, reversed display | Output integrity (browser) | Fixed, verified |
| SEC-34 | Info | Single-line names accept CR/LF/TAB: forged lines in system e-mails | E-mail injection | Fixed, verified |
| SEC-35 | Low | Production SECRET_KEY check accepts human-made keys | Secrets / configuration | Fixed, verified |
| SEC-36 | Low | Malformed DATABASE_URL leaks a password fragment in the startup log | Secrets | Fixed, verified |
| SEC-37 | Low | Revocation re-checks only work under READ COMMITTED, which was not pinned | Authorization | Fixed, verified |
| SEC-38 | Low | Runtime role can plant lasting defaults on its own sessions | Configuration / DB | Fixed, verified |
| SEC-39 | Low | Downgrade guards can miss in-flight rows | Migrations | Fixed, verified |
| SEC-40 | Low | Production accepts database URLs without verified TLS | Configuration | Fixed, verified |
| SEC-41 | Low | A visitor's name in an error toast survives sign-out into the next session | PII (browser) | Fixed, verified |
| SEC-42 | Info | Empty bulk stale check-out writes a permanent audit row every call | DoS / audit growth | Fixed, verified |
| SEC-43 | Medium | Successful password changes unthrottled: bypasses SEC-02's budget | Rate limiting / DoS | Fixed, verified |
| SEC-44 | Low | Visitor with >50 scheduled visits can never change e-mail; misleading 429 | Availability | Fixed, verified |
| SEC-45 | Low | WebSocket handshakes bypass log hygiene; DEBUG logs cookies | Logging | Fixed, verified |
| SEC-46 | Info | Production accepts limit values that switch limiting off | Configuration | Fixed, verified (partial by design) |
| SEC-47 | Info | Production accepts SECRET_KEYs published in the test suite | Secrets | Fixed, verified |
| SEC-48 | Low | DB TLS requirement bypassed through a libpq service file | Configuration | Fixed, verified |
| SEC-49 | Low | Runtime-role startup check was a denylist; misses attributes and memberships | DB privileges | Fixed, verified |
| SEC-50 | Low | After the server-side idle timeout, most screens keep showing data indefinitely | Session (browser) | Fixed, verified |
| SEC-51 | Low | Back/forward cache restores the previous user's data after the session ended | Session (browser) | Fixed, verified |

### 3.2 Finding details

File references are to the code at the time of the finding; line numbers have moved since and are left
out. "Live" results come from the final regression verification. For browser findings they come from the
fixer's live browser check, recorded in `docs/decisions/phase-8-frontend.md`.

#### SEC-01: Anonymous attacker can keep any known account locked out indefinitely
Medium · Authentication / rate limiting · Round 1 · `backend/app/services/auth.py`, `backend/app/core/rate_limit.py`

- **Scenario.** The attacker needs only the victim's e-mail address (host addresses reach every visitor
  through Reply-To, and corporate addresses follow patterns). Ten wrong passwords from two source
  addresses blocked the account for every browser, the correct password included, for 15 minutes.
  Attempts during the block were not counted, so relocking cost 10 requests per 15 minutes. Two IPv4
  addresses could keep about 18 accounts locked around the clock; one IPv6 /48 about 90. Targets: every
  SYSTEM_ADMIN and the reception account. The natural recovery made things worse: a password reset did
  not lift the block, and it revoked the reception tablet's still-working session. There was no admin
  unlock. Only a process restart cleared the in-memory lockouts.
- **Fix.** OWASP-style device cookies (`backend/app/security/device_trust.py`). After a successful login
  or reset, the browser receives `__Host-vms_device` (HttpOnly, Secure, SameSite=Strict, 90 days, up to
  5 accounts per cookie, HMAC-signed with a key derived from `SECRET_KEY`). A browser presenting a valid
  entry for the account uses its own budget, `login_failures_device` (10 per 15 minutes), instead of the
  account's. Unknown clients are limited as before. A successful reset clears the account block. Round 2
  added revocation (SEC-30).
- **Not done.** An admin unlock action and alerting on `AUTH_ACCOUNT_THROTTLED`: unlock is a contract
  change (new §8 endpoint and UI), and alerting is an operations concern (§7). Residuals are in §6, R-8.
- **Verification.** `tests/integration/test_device_trust.py` and `tests/unit/test_device_trust.py`.
  Live: five plus five wrong passwords from two X-Forwarded-For addresses blocked the account, and a
  stranger's correct password got 429. The victim's earlier browser still got 200; its cookie is
  HttpOnly, SameSite=Strict, Max-Age=7776000. A new browser recovered through forgot/reset: reset 204,
  then login 200, and the block was lifted.

#### SEC-02: Successful logins are unthrottled (Argon2 work and append-only row growth)
Low · Rate limiting / DoS · Round 1 · `backend/app/services/auth.py`, `backend/app/api/deps.py` · Duplicate: SEC-14 (rated medium)

- **Scenario.** Login budgets counted failures only, and the 600-per-minute API budget never saw
  `/auth/login`. One valid credential could log in repeatedly. Each success ran Argon2id (64 MiB),
  inserted a `user_sessions` row and inserted an append-only `AUTH_LOGIN_SUCCEEDED` row (the runtime role
  cannot delete, B57-60). SEC-14's verifier measured a bystander's login latency rising from 117 ms to
  about 2,246 ms. A few accounts together would push all authentication to 503 `SERVICE_BUSY`.
  Estimates of the growth from one credential ranged from about a million to about 12 million
  permanent rows a day.
- **Fix.**
  - A per-account success budget, `login_successes_account` (`RATE_LIMIT_LOGIN_SUCCESSES_PER_ACCOUNT`,
    30 per 15 minutes). It is reserved before hashing and counted only on commit. Beyond it the request
    gets 429 and nothing is written.
  - `revoke_all_for_user` touches only live sessions: deactivation had held the company lock for 15 s
    with 300,000 old sessions.
  - New owner-role command `python -m app.cli prune-sessions` (default 30 days, minimum 1) deletes
    long-ended sessions.
  - Change-password checks the new password's policy before Argon2.
- **Not done.** A per-IP success budget (office NAT), a live-session cap (already bounded by the
  budget), and coalescing of `AUTH_LOGIN_SUCCEEDED`. Residual: while an account's budget is spent, which
  takes its password, a 429 reveals that the account exists.
- **Verification.** `test_auth_login::test_successful_logins_of_one_account_have_a_budget`,
  `::test_successful_logins_do_not_consume_ip_budget`,
  `test_cli::test_prune_sessions_deletes_only_sessions_that_ended_long_ago`. Live: 30 sign-ins from
  three addresses got 200. The 31st (a fourth address) got 429 with no new session or audit row, a wrong
  password also got 429 before hashing, and other accounts were unaffected.

#### SEC-03: Password blocklist too small (spray passwords accepted)
Low · Authentication · Round 1 · `backend/app/security/passwords.py`, `common_passwords.txt`

- **Scenario.** The policy rejected only 184 exact strings. "Welcome@2026", "Password@2026",
  "Admin@123456", "Spring2026!!" and passwords built from the user's own name passed, including
  admin-issued temporary passwords. Nine guesses per account per window is enough for password spraying.
- **Fix.** `password_policy_error` now refuses passwords built from a common word (`common_words.txt`
  plus the letters of every blocklist entry) or from the account's own words, with digits, years or
  symbols added. The account's words are the e-mail local part and domain labels, the full name, and the
  company name and slug. Leetspeak is undone, the password is also checked with its leading and trailing
  digits and symbols stripped, and at least 4 other letters must remain. The exact list grew to 1,305
  entries: every 12+ character entry of the NCSC/HIBP top-100k list. The rules apply to temporary
  passwords, change, reset and `create-admin`. The development seed checks only the basic rules, and
  seeding is refused in production. Not done: a 1M-entry corpus.
- **Verification.** `tests/unit/test_passwords.py` (includes 5,000 passwords from the admin form's
  generator, none refused); `test_password_flows::test_spray_shaped_passwords_are_refused_everywhere`.
  Live: Welcome@2026, Password@2026, Admin@123456, Spring2026!!, W3lc0me@2026, Otherc0rp@2026 (company
  word) and JaneDoe@2026 (name) all got 422 as temporary passwords, and a random one got 201. Changing to
  Password@2026 got 422.

#### SEC-04: Current session not rotated on password change
Low · Session · Round 1 · `backend/app/services/auth.py`, `backend/app/api/routes/auth.py`

- **Scenario.** A user who suspects a copied session cookie changes their password from the same
  browser. Every other session was revoked, but the current token was kept, so the attacker's copy kept
  full access, CSRF token included, for up to 12 hours.
- **Fix.** Change-password revokes the current session as well and issues a new session and CSRF token
  on the 204. Since SEC-30 it also issues a new device cookie. `AUTH_PASSWORD_CHANGED` metadata records
  the new `session_id`.
- **Verification.** `test_password_flows::test_change_password_replaces_the_current_session`, and the
  updated race test. Live: a copy of the old cookie gets 401 on `GET /auth/me`, and on an unsafe request
  with the old CSRF token. The changing browser continues.

#### SEC-05: Global e-mail uniqueness reveals whether an address has an account in another tenant
Low · Enumeration · Round 1 · `backend/app/services/users.py` · **Status: deferred, mitigated**

- **Scenario.** E-mail addresses are unique across tenants (D-03). A SYSTEM_ADMIN of tenant A calling
  `POST /users` with an address gets 409 `USER_EMAIL_UNAVAILABLE` if an account exists anywhere, and 201
  otherwise. That confirms live accounts in other tenants as targets for spraying and phishing. Probes
  that miss create real, audited users, so the oracle is noisy.
- **Why deferred.** The root cause is in the binding contract: global uniqueness (D-03) combined with
  synchronous user creation (§8 `POST /users`). A real fix is either an invitation flow, where every
  create answers 202, or per-tenant uniqueness with tenant-qualified sign-in. Both change the contract
  for backend and frontend.
- **Mitigation shipped.** `user_email_refusals_per_user` (`RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR`,
  default 10 per administrator per hour). Once spent, the request gets 429 before the lookup. §8.2's "no
  existence oracle" wording has been flagged to the contract owner as overstated.
- **Verification.**
  `test_admin_gate::test_refusals_for_taken_addresses_have_a_budget_per_administrator`. Live: 10 taken
  addresses (both tenants) got 409; the 11th got 429, and so did a free address once the budget was
  spent.

#### SEC-06: No notification when a password is changed or reset
Low · Authentication · Round 1 · `backend/app/models/enums.py`, `backend/app/services/auth.py`

- **Scenario.** An attacker with brief mailbox or session access could reset or change a password and
  the victim would not be told (ASVS 2.2.3).
- **Fix.** New e-mail kind `PASSWORD_CHANGED` (migration `0008`), with templates and
  `EmailService.queue_password_changed`. The notice is queued in the change's transaction and delivered
  after commit. It contains the company-local time, the client IP and a link to `/forgot-password`, never
  a secret. There is a budget of 5 notices per account per hour; beyond it the audit row records
  `notice: limited`.
- **Verification.** `test_password_flows::test_a_password_change_and_a_reset_notify_the_account`,
  `::test_password_change_notices_have_an_hourly_budget`. Live: a reset queued the notice, and a change
  delivered one to the outbox with the link and no password or token.

#### SEC-07: A deactivated or demoted admin's in-flight request still commits after revocation
Medium · Authorization · Round 1 · `backend/app/services/users.py`, `backend/app/services/company.py`, `backend/app/api/deps.py`

- **Scenario.** Authorization was decided once, before the service ran. A request waiting on the
  company row lock held by a deactivation carried on with the revoked user's stale context once the lock
  was released. A compromised admin being removed during incident response could reactivate themselves
  (`PATCH /users/{self} {"is_active": true}`), promote a puppet account to SYSTEM_ADMIN, or change
  company settings, while the defender received 200. The attacker can widen the window: hosting many
  visits made the deactivation's D-18 cancellation slower (150 visits gave 0.8–1.6 s).
- **Fix.** `services/authorization.require_still_authorized` runs after the company lock in
  `UsersService.update_user`, `CompanyService.update_settings` and `begin_visit_change` (every visit and
  visitor change). The session must still be live, the account active, and no role removed. Otherwise
  the request gets 401 or 403, audited as `ACCESS_DENIED`, and nothing is written. Admins can no longer
  change their own `is_active` (`SELF_MODIFICATION`). LAST_ADMIN stays as a backstop. Completed by SEC-31
  and SEC-37.
- **Verification.** `tests/integration/test_stale_authorization.py` uses two committed connections; 5
  of its 6 tests fail without the fix. `test_users_api::test_last_admin_guard_with_stale_authorization`
  and `test_committed::test_concurrent_admin_demotions_keep_one_admin` also cover it. Regression: the
  file passes on both a default and a REPEATABLE READ database.

#### SEC-08: Former receptionist keeps access to every visitor registered at the desk
Low · Authorization · Round 1 · `backend/app/repositories/scope.py`, `backend/app/security/permissions.py`

- **Scenario.** Ownership counted `created_by = me` whenever the user held a host role. A receptionist
  moved to EMPLOYEE in a routine rotation suddenly "owned" every walk-in and visitor they had registered
  at the desk, possibly thousands of people. They could read their names, e-mail addresses and phone
  numbers, and edit their records, indefinitely.
- **Fix.** A walk-in belongs only to its host: `owned_by` counts the creator only for visits that are
  not walk-ins. A new column `visitors.owned_by_creator` (migration `0008`) is true only when the creator
  could see only their own visitors at the time (an EMPLOYEE-only creator). The edit rule uses the same
  predicate.
- **Verification.**
  `test_visitor_reuse_scope::test_a_receptionist_moved_to_employee_keeps_nothing_registered_at_the_desk`.
  Live: after reception@ was moved to EMPLOYEE, the desk visitor, the walk-in visitor, the invited
  visitor and both walk-in visits all got 404; search and `/visits` were empty; PATCH got 404.

#### SEC-09: LOST_PASS walk-in leaves the reported-lost QR pass valid
Low · QR pass · Round 1 · `backend/app/services/attendance.py`, `backend/app/services/scan.py`

- **Scenario.** A visitor with a SCHEDULED visit today reports their pass lost, and reception registers
  a walk-in with reason LOST_PASS. The original pass stays active. Once the walk-in is checked out, the
  lost pass scans READY and admits a second person. This also bypasses D-09 (no re-entry after
  check-out).
- **Fix.** A LOST_PASS walk-in for a visitor with a SCHEDULED visit starting today (company-local) gets
  422 on `reason`, pointing reception to MANUAL or OVERRIDE check-in on that visit. Checking in consumes
  the visit, and the check-out revokes the lost pass. No enum or contract change was needed. Completed by
  SEC-32.
- **Verification.**
  `test_reception_api::test_a_lost_pass_walk_in_for_a_visitor_expected_today_points_to_the_visit` and
  `::test_a_lost_pass_walk_in_is_allowed_without_an_expected_visit`. Live: by ID or by known e-mail,
  422; without a visit today, 201. The documented flow leaves the lost pass at 409 `VISIT_COMPLETED`.

#### SEC-10: Bidirectional overrides make the shown phone number or name differ from what is stored or dialled
Low · Output integrity · Round 1 · `backend/app/schemas/common.py`, `frontend/src/utils/phone.ts`

- **Scenario.** Any employee could store a phone of `+962 79 <RLO>2001 005`. It displays as `+962 79
  500 1002` but the `tel:` link dials +962792001005, so an evacuation roll call or a reception call goes
  to an attacker-chosen number. A name such as `A<RLO>htims ecil` displays as "Alice smith", including in
  the "Verify ID" cue, and evades search.
- **Fix.** Single-line name types refuse bidi embeddings, overrides and isolates (U+202A–U+202E,
  U+2066–U+2069) inside the text. They are trimmed at the ends, and LRM/RLM/ALM stay allowed for Arabic.
  Phone has a strict grammar: an optional "+"; ASCII, Arabic-Indic or Extended Arabic-Indic digits;
  separators; at least 3 digits; an optional extension. The frontend part is SEC-33.
- **Verification.** `tests/unit/test_schemas.py` and
  `test_invisible_text_input::test_direction_overrides_in_visitor_names_and_phones_are_refused`. Live: a
  phone with an interior RLO, names with RLO and LRI/PDI, and a phone with letters all got 422. An
  Arabic-Indic phone was accepted, and an RLO at the edge was trimmed.

#### SEC-11: Logs carry raw C1 controls and line separators; records dropped on Windows
Low · Logging · Round 1 · `backend/app/core/logging.py`, `backend/app/core/middleware.py`, `backend/app/core/errors.py`

- **Scenario.** JSON escapes only U+0000–U+001F. U+009B (8-bit CSI), U+0085 and U+2028 in a request
  path or an unknown body key reached stdout raw. Terminals could execute escape sequences, and
  line-oriented tooling would split records. On Windows (cp1252 stdout) such records could not be
  encoded and were dropped, which hides reconnaissance.
- **Fix.** Both formatters escape DEL, C1 controls and U+2028/2029 as `\uXXXX`; the text format also
  escapes C0. The handler writes characters its stream cannot encode as backslash escapes instead of
  dropping the record. Unknown keys in logged validation locations are cut to 64 characters.
- **Verification.** `tests/unit/test_logging.py`, `tests/integration/test_log_hygiene.py`. Live: escaped
  in the path and in an unknown key, keys cut to 64, nothing dropped, 0 tracebacks on cp1252. (The
  formatter's own truncation ellipsis is written as byte 0x85 in cp1252; it is not attacker-chosen and is
  not a control character there.)

#### SEC-12: Client-supplied X-Request-ID written to audit rows
Low · Logging / audit integrity · Round 1 · `backend/app/core/request_context.py` · Duplicate: SEC-16

- **Scenario.** Any unauthenticated client could choose the request ID that is stored in
  `audit_logs.request_id`, written to every log line and shown to users as "Reference". An attacker could
  file probes under a real administrator's request ID, or give all of theirs one ID. Correlating audit,
  application and proxy records then becomes misleading, which weakens the trail's evidential value.
- **Fix.** An incoming `X-Request-ID` (still only in the safe format) is accepted only when the direct
  peer is in `TRUSTED_PROXIES`; otherwise the server generates one. Phase 9: nginx sets
  `X-Request-ID $request_id`.
- **Verification.** `test_http_behaviour::test_a_clients_own_request_id_is_never_adopted`,
  `::test_request_id_from_a_trusted_proxy_is_kept`. Live: a direct client's
  "forged-admin-request-0001" was ignored in both the response and the `AUTH_LOGIN_FAILED` row.

#### SEC-13: Trailing-slash redirect builds its Location from the Host header
Info · Configuration · Round 1 · `backend/app/main.py`

- **Scenario.** `GET /api/v1/visits/` answered 307 with a Location built from the client's Host header,
  and with `http` behind a TLS proxy. This is not a browser open redirect, but it matters for
  cache-poisoning setups and HSTS. No client uses trailing slashes.
- **Fix.** `FastAPI(redirect_slashes=False)`.
- **Verification.** `test_http_behaviour::test_trailing_slash_is_not_redirected`. Live with
  `Host: evil.example`: 404 in the envelope, no Location.

#### SEC-14: Successful authentication has no rate limit
Medium · Rate limiting / DoS · Round 1 · Duplicate of SEC-02

The same root cause as SEC-02, reported by a second lens, which measured the bystander latency
(117 ms → 2,246 ms at the 2 s acquire timeout) and estimated about 12 million rows a day per table. Same
fix and verification as SEC-02. The verifier's 15 s deactivation lock came from revoking long-expired
sessions; revocation now touches only live sessions.

#### SEC-15: Non-coalesced security audit rows grow an un-prunable append-only table
Low · Logging / DoS · Round 1 · `backend/app/services/audit.py`

- **Scenario.** Only `RATE_LIMITED` and `CSRF_FAILED` were coalesced. Attributed refusals
  (`ACCESS_DENIED`, `VISITOR_LINK_REFUSED`, `USER_CHANGE_REFUSED`) were bounded only by the API limit of
  600 per user per minute. Unattributed `AUTH_PASSWORD_RESET_FAILED` rows grow with the number of source
  addresses.
- **Fix (attributed part).** `SecurityEventCoalescer` keeps a per-user budget of written rows for those
  three actions: 10 per action per 60-second window, then one overflow summary row
  (`deferred, overflow, coalesced: n`). Responses are unchanged.
- **Not changed, deliberately.** Unattributed failures. They are limited per source (B1-33, B1-35) and
  grow only with attacker-controlled addresses. The same change would also thin out `AUTH_LOGIN_FAILED`,
  the forensic record §7.4 requires. See §6, R-10.
- **Verification.** `tests/unit/test_security_audit.py`. Live: 25 forbidden `GET /users` requests by
  one MANAGEMENT user wrote 10 `ACCESS_DENIED` rows and one overflow summary (`coalesced: 14`, covering
  15 events). All responses stayed 403.
- **Phase 9 closure, 2026-10-07.** The budget lives in the memory of each API process. The shipped
  deployment runs four processes, and the three read processes can each write `ACCESS_DENIED` rows
  (a role without the capability calling a routed read). One user can therefore cause up to
  4 × (10 + 1) = 44 `ACCESS_DENIED` rows a minute instead of 11. The summaries still count every
  event. `VISITOR_LINK_REFUSED` and `USER_CHANGE_REFUSED` come only from writes, which reach the main
  process alone, so their bound is unchanged. Accepted with R-1 (§6, R-1 Phase 9 closure note).

#### SEC-16: Any client can choose its X-Request-ID
Low · Logging / audit integrity · Round 1 · Duplicate of SEC-12

The same issue as SEC-12, reported by another lens. Same fix and verification.

#### SEC-17: Rejected database URL echoed with its password at startup
Low · Secrets · Round 1 · `backend/app/core/config.py`

- **Scenario.** A common but unsupported URL scheme (`postgresql+psycopg2://`, `asyncpg`, `mysql`) made
  pydantic print `input_value=<URL>` to stderr and from there into central logging. Short URLs leaked the
  whole password. `repr(Settings)` also showed both database passwords.
- **Fix.** `hide_input_in_errors=True`. `DATABASE_URL` and `MIGRATION_DATABASE_URL` are `SecretStr`;
  the clear value is read only through `Settings.runtime_url` / `migration_url` when an engine is
  created.
- **Verification.** `test_config::test_a_rejected_database_url_is_not_echoed`,
  `::test_a_refused_production_configuration_echoes_no_input`,
  `::test_database_passwords_are_not_exposed_in_repr`. Checked again in-process.

#### SEC-18: Production accepts catch-all TRUSTED_PROXIES
Low · Configuration · Round 1 · `backend/app/core/config.py`

- **Scenario.** With `TRUSTED_PROXIES=0.0.0.0/0,::/0`, the leftmost `X-Forwarded-For` entry is used
  (B1-18). Any client could then choose the IP recorded in audit rows and rotate past every per-IP and
  per-/48 limit.
- **Fix.** Production refuses networks wider than /8 (IPv4) or /32 (IPv6). It also refuses the
  published `*local_dev*` database passwords.
- **Verification.** `test_config::test_production_refuses_catch_all_trusted_proxies`,
  `::test_production_accepts_scoped_trusted_proxies`,
  `::test_production_refuses_the_published_local_database_passwords`. In-process: 0.0.0.0/0, ::/0, both
  /1 halves and a /7 are refused; a /8 is accepted.

#### SEC-19: Unhandled-exception logs carry PostgreSQL DETAIL with PII
Info · Logging / PII · Round 1 · `backend/app/core/middleware.py`, `backend/app/core/logging.py`

- **Scenario.** A traceback of an unmapped constraint error includes the server's DETAIL, such as
  `Key (company_id, email)=(…)` or `Failing row contains (…)`: names, e-mail addresses, phone numbers.
  `hide_parameters=True` does not cover DETAIL. No API input reached this path; it is defence in depth.
- **Fix.** The formatters replace the DETAIL of every psycopg error in the exception chain with
  `[redacted]`. The catch-all also logs the driver error class, SQLSTATE and constraint name
  (`db.errors.database_error_summary`).
- **Verification.** `tests/integration/test_log_hygiene.py`: real unique and NOT NULL violations, and an
  unmapped violation through the catch-all.

#### SEC-20: Visitor search terms in the page URL stay in browser history
Info · PII (browser) · Round 1 · `frontend/src/hooks/useUrlParams.ts`, `frontend/src/paths.ts`

- **Scenario.** On a shared reception tablet, searches such as `/visitors?q=jane.doe@corp.example` stay
  in browser history after sign-out, and are visible to any proxy that logs full URLs.
- **Fix.** `q` and the history page's `hostName` are private parameters (`PRIVATE_PARAMS`). They live in
  the history entry's state, tagged with the signed-in user's ID, and never in the query string. This
  covers `/visitors`, `/visits`, `/history` and `/admin/users`. Old `?q=` links still work and are moved
  out of the address at once. `safeNextPath` drops private parameters from `?next=`. Another user's
  state is ignored.
- **Verification.** `useUrlParams.test.tsx`, `redirect.test.ts`, and the Visitors, My visits and History
  page tests, which record every address the router showed. All of them fail with the fix reverted. Live:
  the Chromium History database held no search text. Residual: Chromium's session-restore files keep the
  owner-tagged search text, without names (§6, R-12).

#### SEC-21: Runtime role can choose audit_logs.seq values
Low · DB privileges · Round 1 · `backend/alembic/versions/20261005_0001_initial_schema.py`

- **Scenario.** This needs a leaked runtime credential, the threat B57-60 defends against. With
  table-level INSERT, `vms_app` could write the `GENERATED ALWAYS` column `seq` through
  `OVERRIDING SYSTEM VALUE` or `COPY`. It could then place back-dated forged rows anywhere in the
  deterministic audit order, or claim future values so that every later audited write, security events
  included, failed with a unique violation.
- **Fix.** Migration `0008` grants INSERT on every `audit_logs` column except `seq` and revokes all
  privileges on `audit_logs_seq_seq`. The downgrade restores the old grants.
- **Verification.** `test_database_rules` (5 new tests), and the privilege and migration round-trip tests
  updated to check column and sequence ACLs. Live as `vms_app`: `OVERRIDING SYSTEM VALUE` and `COPY` with
  `seq` got "permission denied for table audit_logs", and `nextval`/`setval` got "permission denied for
  sequence". A normal insert still gets its `seq`.

#### SEC-22: The no-TEMPORARY rule for the runtime role was not enforced by the migration
Low · DB privileges · Round 1 · `backend/alembic/versions/20261005_0001_initial_schema.py`

- **Scenario.** Only the dev script and the test harness revoked TEMPORARY. A DBA provisioning with
  `CREATE DATABASE … OWNER vms_owner` and `alembic upgrade head` got a runtime role that could run
  `CREATE TEMP TABLE audit_logs (LIKE public.audit_logs)`. Because `pg_temp` is searched first, that
  table shadows the real one on a pooled connection, and audit writes vanish silently.
- **Fix.** Migration `0008` revokes TEMPORARY on the current database from PUBLIC and from the app role
  (in a DO block). The SEC-23 startup check also refuses the privilege, which covers databases the
  migration role does not own.
- **Verification.**
  `test_migrations::test_a_freshly_migrated_database_gives_the_runtime_role_no_temporary_objects`
  (a database created without the harness's REVOKE). Live: TEMPORARY is false, and
  `CREATE TEMP TABLE audit_logs` is refused.

#### SEC-23: Production accepts the schema-owner role as DATABASE_URL
Low · Configuration / DB · Round 1 · `backend/app/core/config.py`, `backend/app/db/privileges.py` (new)

- **Scenario.** With one credential for both URLs, the API ran as the table owner. A SQL injection or a
  leaked credential could then disable the audit and terminal-visit triggers, delete history or run DDL,
  with nothing to show it.
- **Fix.** Production refuses a `DATABASE_URL` whose user equals the migration user. At production
  startup, `app.db.privileges.require_runtime_privileges` refuses to start if the role:
  - is a superuser or bypasses RLS;
  - owns, or is a member of the owner of, objects in `public`;
  - can create objects in the schema or database, or temporary objects;
  - can update, delete, truncate or add triggers on `audit_logs`, or insert `seq`;
  - can delete or truncate any table.

  The error names the failing checks only. Extended by SEC-49.
- **Verification.** `tests/integration/test_runtime_privileges.py`. Live: run against `vms_owner`, the
  check raised `ConfigurationError` listing `member_of_roles`, `owns_schema_objects`,
  `creates_temporary_objects`, `changes_audit_rows`, `chooses_audit_order`, `deletes_rows` and more.

#### SEC-24: Revision 0003 downgrade loses data and widens EMPLOYEE scope
Low · Authorization / migrations · Round 1 · `backend/alembic/versions/20261005_0003_visit_visitor_link_scope.py`

- **Scenario.** Rolling back past `0003` dropped `visits.visitor_link_in_scope`. The next upgrade reset
  every link to true, which permanently gave EMPLOYEE users read and edit access to visitors outside
  their scope (B24-72).
- **Fix.** The `0003` downgrade refuses while any visit has `visitor_link_in_scope = false`. The `0008`
  downgrade likewise refuses while any visitor has `owned_by_creator = false` or a `PASSWORD_CHANGED`
  e-mail exists. Such databases are restored from backup instead. SEC-39 hardened both guards.
- **Verification.** `test_migrations::test_visit_link_scope_cannot_be_lost_by_a_downgrade` and
  `::test_visitor_ownership_cannot_be_lost_by_a_downgrade`. Live: `alembic downgrade 0007` on a probe
  database raised an error and rolled back completely; the database stayed at 0009 with both columns.

#### SEC-25: Python lock files not hash-pinned
Info · Supply chain · Round 1 · `backend/requirements.txt`, `backend/requirements-dev.txt`

- **Scenario.** Versions were pinned without hashes, so an install trusted whatever the index or a
  mirror served. The npm lockfile already carried integrity hashes.
- **Fix.** Every pin carries the sha256 of each file a Python 3.14 install may choose (Windows, Linux
  and macOS wheels, plus the sdist), generated from the PyPI JSON API by `scripts/lock_hashes.py`
  (idempotent). The file headers say to install with `--require-hashes`.
- **Verification.** `tests/unit/test_dependency_locks.py`. Live: 39 runtime pins with 199 hashes and 16
  dev pins with 103 hashes, none unhashed. `pip download --require-hashes --no-deps` fetched all 39
  runtime wheels, and every hash matched.

#### SEC-26: Sign-out or sign-in in another tab leaves the previous user's data on screen
Low · Session (browser) · Round 1 · `frontend/src/auth/AuthProvider.tsx`, `useAuth.ts`, `session.ts`

- **Scenario.** On a shared PC, user A signs out in tab 2 and user B signs in. Tab 1 still showed A's
  cached visitor profile and A's name in the account menu. B's refetches got 404 or 403 rather than 401,
  so the cache was never cleared. This broke §7.2 ("logout clears the cache").
- **Fix.**
  - `auth/authSync.ts` broadcasts `signed-in` and `signed-out` on `BroadcastChannel('vms-auth')`, with a
    `storage` event as fallback. Messages carry no user data.
  - On `signed-out`, a tab ends its session and goes to `/login`. On `signed-in`, it re-checks
    `/auth/me`.
  - An identity check (company and user) clears every other query and mutation and restarts the tab at
    `/` when `/auth/me` names someone else.
  - `/auth/me` refetches whenever the tab becomes visible.
  - The query cache drops a query's data when a refetch is refused with 404 or 403.
- **Verification.** `auth/sessionSync.test.tsx` (9 cases). Live with two tabs, including a silent user
  switch sent straight to the API.

#### SEC-27: Visitor names in page titles and search text in URLs persist in browser history
Low · PII (browser) · Round 1 · `frontend/src/features/visits/VisitDetail.tsx`, `features/visitors/VisitorProfile.tsx`

- **Scenario.** Saved history (Ctrl+H, address-bar suggestions, browser sync, 90-day retention) kept
  titles such as "Visit of <visitor name>" and URLs containing search text after sign-out. Anyone at the
  device could read them, and sync could carry them to a personal account.
- **Fix.** Generic document titles ("Visitor profile", "Visit details"); the name appears only in the
  on-screen h1. Search text stays out of URLs (SEC-20). A shared-device browser policy was written up for
  Phase 9 (`SavingBrowserHistoryDisabled`, `SyncDisabled`, no session restore,
  `ClearBrowsingDataOnExitList`, guest or kiosk profiles; recommendation 9).
- **Verification.** The VisitDetail and VisitorProfile title tests fail with the old titles. Live: the
  History database's titles are generic.

#### SEC-28: Back-link labels in history.state carry visitor names across sign-out
Info · PII (browser) · Round 1 · `frontend/src/hooks/useBackLink.ts`, `features/visitors/VisitorProfile.tsx`

- **Scenario.** After a sign-out and another user's sign-in in the same tab, pressing Back showed "Back
  to <visitor name>" from the previous user's router state, even though the server answered 404.
- **Fix.** `backLinkState` tags each link with its owner, and `useBackLink` ignores links from another
  user's session. Labels kept in history are generic. `VisitDetail` names the visitor only from the visit
  it has just loaded.
- **Verification.** Hook owner test; VisitDetail with a foreign back link and a 404 shows the default
  label and no name. Live: the next user walking Back through the previous user's entries saw no names.

#### SEC-29: Reset token remains in the browser's saved history
Info · Secrets (browser) · Round 1 · `frontend/src/features/auth/resetToken.ts` · **Status: accepted risk**

- **Scenario.** A user opens a reset link on a shared device and does not finish. For up to 30 minutes,
  anyone who can read the browser's history can open `/reset-password#token=…` and set a new password.
  The page's `history.replaceState` removes the token from the address bar and the tab's entry, but not
  from saved history.
- **Why accepted.** The browser records the opened URL before any script runs, so no page code can
  remove it. The fragment link is required by contract §7.2 because it keeps the token out of server and
  proxy logs and out of Referer. The token is single-use, lasts 30 minutes and is replaced by any newer
  request, and the same link sits in the mailbox on the same device anyway. Exchanging the token on page
  load was rejected: mail scanners that run scripts, or a reload, would use it up before the user acts,
  and it needs server state. The actual overclaim was the `captureResetToken` doc comment, which now
  states the limit. The residual and the shared-device policy are documented in `phase-8-frontend.md`.
- **Verification.** The regression verifier confirmed that the reasoning is correct.

#### SEC-30: Device trust is never revoked
Medium · Authentication · Round 2 · `backend/app/security/device_trust.py`, `backend/app/services/auth.py`, `backend/app/services/users.py`

- **Scenario.** This corrects SEC-01. An attacker who briefly had a password signed in from many cookie
  jars, each receiving its own 90-day device entry, up to the success budget of 30 per 15 minutes. After
  the standard incident response (a reset, or deactivation and reactivation), each farmed cookie still
  had its own 10 guesses per window against the new password: 10×N guesses where the contract bounds the
  account to 10. A farmed cookie plus the correct new password also got 200 while strangers were
  blocked. Only rotating `SECRET_KEY` revoked trust, and that hits every tenant.
- **Fix.** Migration `0009` adds `users.device_trust_epoch`, a random 63-bit value. Device entries (format
  v2) carry the epoch under the HMAC, and are trusted only while it matches the account's current epoch.
  Password change, reset and deactivation set a new random epoch. The browser that made the change or
  reset gets a fresh entry; change-password now sets the device cookie too. The epoch is random rather
  than a counter, so a downgrade and upgrade round trip ends all trust instead of reviving old entries.
  Not done: an admin "sign out everywhere" endpoint (a contract change; deactivate then reactivate has
  the same effect), and OWASP's permanent per-device lockout.
- **Verification.** `test_device_trust.py` covers scenario A (farmed jars, then a reset), scenario B
  (deactivation), change-password, and an unrelated rename that keeps trust. Unit tests cover the epoch;
  `test_migrations` covers the 0009 round trip. Live: three farmed jars, then a reset. Ten guesses from
  the jars counted on `login_failures_account` (401 ×10, then 429). Each jar's correct new password got
  429, and the resetting browser got 200. Deactivate and reactivate changed the epoch, and the old cookie
  got 429 while the account was blocked.

#### SEC-31: Revoked admin's in-flight POST /users mints a SYSTEM_ADMIN (SEC-07 gap)
Low · Authorization · Round 2 · `backend/app/services/users.py`, `backend/app/services/departments.py`

- **Scenario.** SEC-07 covered updates but not creation. An admin deactivated while a `POST /users` was
  in flight still created a new SYSTEM_ADMIN with a temporary password of their choosing. That account
  outlives the revocation of the attacker's own account: privilege retention after off-boarding.
  Department create and update had the same gap, with lower impact.
- **Fix.** `services.authorization.lock_company_for_change` (locks the company row `FOR KEY SHARE`, then
  calls `require_still_authorized`) runs in:
  - `POST /users`, after the address lookup and the Argon2 hash, so the lock covers only the insert;
  - `POST` and `PATCH /departments`;
  - `POST /visitors`.

  `update_user` now always locks the company row: `FOR UPDATE` for role or activity changes,
  `FOR KEY SHARE` for anything else.
- **Verification.** `test_stale_authorization.py` covers a deactivated and a demoted admin creating a
  SYSTEM_ADMIN, departments, a rename and visitor registration, on both the default and the REPEATABLE
  READ databases. Live: psql held the company row `FOR UPDATE` while deactivating the admin. The
  in-flight `POST /users` waited about 3 s and then got 401. No user was created, and an
  `ACCESS_DENIED {reason: session_ended}` row was written.

#### SEC-32: Lost-pass walk-in typed as a new visitor bypasses SEC-09
Low · QR pass · Round 2 · `backend/app/services/attendance.py`

- **Scenario.** The receptionist chose LOST_PASS and typed the visitor's name and phone without the
  e-mail. Visitors are deduplicated by e-mail only (D-05), so this created a duplicate record with no
  visits, and the SEC-09 guard passed. The lost pass then scanned READY and checked a second person in
  while the real visitor was inside. `VISITOR_ALREADY_INSIDE` is per record, so it did not fire either.
- **Fix.** A LOST_PASS walk-in that would register a new visitor (inline details without an e-mail, or
  with an unknown address) gets 422 on `reason`, pointing to the returning-visitor record or the
  Expected list. Nothing is written. Once the record is named, SEC-09 applies. This was chosen over fuzzy
  name or phone matching because a pass always belongs to a visit whose visitor is on record. Residual:
  picking another reason or the wrong record is a staff error the backend cannot catch (§6, R-3).
- **Verification.**
  `test_reception_api::test_a_lost_pass_walk_in_cannot_register_the_visitor_anew` (3 cases) and
  `::test_other_walk_in_reasons_may_register_new_visitors`. Live: LOST_PASS with name and phone, name
  only, or an unknown e-mail got 422, and no duplicate was written. NO_INVITATION with new details got
  201.

#### SEC-33: Arabic-Indic phone numbers get empty or wrong tel: links and reversed display
Low · Output integrity (browser) · Round 2 · `frontend/src/utils/phone.ts`, `frontend/src/components/ui/PhoneLink.tsx`

- **Scenario.** The server accepts Arabic-Indic digits (SEC-10), but `telHref` used JavaScript's ASCII
  `\d`. A number entirely in Arabic-Indic digits dialled nothing, for example from the evacuation list.
  A mixed number displayed one number and dialled another. Bidi rules also displayed the digit groups in
  reverse order. The round-1 hand-over for this had not been implemented.
- **Fix.**
  - `telHref` mirrors the server grammar and maps U+0660–0669 and U+06F0–06F9 to ASCII. An extension is
    shown but not dialled; the old code appended its digits into a wrong, longer number.
  - Text outside the grammar gets no link and is shown as plain text, so no link can dial a number
    other than the one shown.
  - Every phone number renders in a new `PhoneNumber` component (`<bdo dir="ltr">` with
    `unicode-bidi: isolate-override`). The suggested `<bdi>`/`dir="ltr"` was measured to be
    insufficient.
- **Verification.** `helpers.test.ts` (Arabic-Indic, Extended, mixed, extensions, 15 undialable
  strings), `PhoneLink.test.tsx`, and `InsidePage.test.tsx` (the digits in each href equal the digits
  shown). Live in Chromium: every number displayed in stored order and dialled what it showed.

#### SEC-34: Single-line names accept CR/LF/TAB, so system e-mails can carry forged lines
Info · E-mail injection · Round 2 · `backend/app/schemas/common.py`, `backend/app/email/service.py`

- **Scenario.** A visitor named `Sam Lee\r\nCompany: Ministry of Interior (security clearance
  verified)\r\n…` produced forged labelled lines in the host's arrival e-mail, which carries the
  organisation's sender identity. The Subject was safe (`sanitize_header`). This is limited to insider
  content spoofing.
- **Fix.** Name types refuse TAB, LF, CR, VT, FF, NEL, U+2028 and U+2029 inside the text. As defence in
  depth for rows stored earlier, `email.service.one_line` collapses whitespace in names in e-mail bodies
  and subjects. Multi-line fields (purpose, reasons, notes, address) keep their line breaks by design.
- **Verification.** `test_invisible_text_input.py` (seven separators across six endpoints; a stored
  forged name shown on one line in `HOST_ARRIVAL`). Live: CRLF, TAB and U+2028 in visitor, organisation,
  department, company and user names all got 422.

#### SEC-35: Production SECRET_KEY check accepts human-made keys
Low · Secrets / configuration · Round 2 · `backend/app/core/config.py`, `backend/app/security/secret_strength.py` (new)

- **Scenario.** `SECRET_KEY` keys the device-trust HMAC and the limiter's key derivation. The check
  accepted any 32+ character value with 10 distinct characters and no placeholder word: for example
  "BankVMS-Production-2026-Key-Amman", which started in production mode during the audit. An insider can
  attack such a key offline from their own device cookie, and with it forge device-trust entries that
  exempt a guessing browser from the account lockout.
- **Fix.** Production requires at least 43 characters (the length of `token_urlsafe(32)`) and an
  estimated 128 bits. The estimate is the cheapest reading of the key as common words (undoing
  substitutions), years, runs, keyboard stretches, repetitions and word-shaped letters. Generated keys of
  43+ characters scored at least 151 bits in 20,000 samples each; the finding's keys score 16 to 98.
  Limits: no check proves randomness, and a 32-character hex key is now refused by length.
- **Verification.** `test_config` (8 guessable keys the old rule accepted, the length rule, 600
  generated keys accepted) and `tests/unit/test_secret_strength.py`. In-process: the word, digit-run,
  keyboard-walk, alphabet and passphrase keys are refused; 200 `token_urlsafe(32)` and 100
  `token_hex(32)` keys are accepted.

#### SEC-36: Malformed DATABASE_URL leaks a password fragment in the startup log
Low · Secrets · Round 2 · `backend/app/db/session.py`, `backend/app/core/config.py`

- **Scenario.** A password with an unencoded `@` passed validation, because Python's `urlsplit` and
  libpq split userinfo differently. The connection error then named the misparsed host, which was the
  tail of the password, and uvicorn printed it in its plain-text "Application startup failed" traceback.
  The production credential checks were also reading different credentials from the ones used to
  connect.
- **Fix.**
  1. `config.parse_database_url` refuses, in every environment and without echoing the value, any URL
     that SQLAlchemy's `make_url` (the engine's parser) and `urlsplit` read differently, or that either
     cannot parse. The credential checks now use the engine's parser.
  2. A startup connection failure becomes a `ConfigurationError` carrying only the driver error class
     and SQLSTATE, raised `from None`.
- **Verification.** `test_config` (6 ambiguous URL shapes on both URLs, percent-encoded URLs accepted)
  and `test_runtime_privileges::test_a_failed_startup_connection_does_not_print_the_database_url`.
  In-process: an unencoded `@` or `#` is refused without echo; an unreachable URL gives a
  `ConfigurationError` with no driver text.

#### SEC-37: Revocation re-checks only work under READ COMMITTED, which was not pinned
Low · Authorization · Round 2 · `backend/app/db/session.py`, `backend/app/services/authorization.py`

- **Scenario.** A database, role or server default of REPEATABLE READ is a legitimate hardening-baseline
  setting. Under it, `require_still_authorized` read a snapshot taken before the lock wait. A
  just-demoted admin could still grant SYSTEM_ADMIN, and two admins demoting each other could both
  succeed, leaving the company with no admin.
- **Fix.** `app.db.session.SESSION_SETTINGS` are sent as libpq startup options by every engine: the
  API's, the CLI's and Alembic's. They pin `default_transaction_isolation=read committed`, which
  overrides server, database and role defaults. Production startup also refuses a connection that is not
  READ COMMITTED. `FOR SHARE` re-reads were not added, because they introduce a lock-order hazard against
  change-password.
- **Verification.** All of `test_stale_authorization.py` also runs on a database set to REPEATABLE READ;
  12 of its 13 scenarios fail without the fix. Live: with REPEATABLE READ planted as a role-in-database
  default, the application's engine still reports READ COMMITTED, and production startup refuses the
  setting.

#### SEC-38: Runtime role can plant lasting defaults on its own sessions
Low · Configuration / DB · Round 2 · `backend/app/db/privileges.py`, `backend/app/db/session.py`

- **Scenario.** A leaked runtime credential runs `ALTER ROLE vms_app SET default_transaction_read_only =
  on` (or another isolation level, or a different `search_path`). PostgreSQL lets any role do this, and
  it survives app restarts, password rotation and a dump restore. Every login became a 500 while
  `/health` reported "ok" and the SEC-23 check passed.
- **Fix.** The engines pin `timezone`, `client_encoding`, `DateStyle`, `IntervalStyle`, `bytea_output`,
  `search_path=public`, `transform_null_equals`, READ COMMITTED and read-write. Production refuses a
  runtime role with its own `pg_db_role_setting` rows, naming only the parameters. `.env.example` adds
  `ALTER ROLE … RESET ALL` to the credential-rotation steps. Timeouts and `synchronous_commit` are
  deliberately not pinned.
- **Verification.** `test_runtime_privileges` (planted read-only, REPEATABLE READ and `search_path` do
  not reach the app's connections; production refuses the role). Live: with all three planted, the app
  engine ran read-write, READ COMMITTED, with `search_path=public`, and an insert succeeded; the startup
  check named the three parameters.

#### SEC-39: Downgrade guards can miss in-flight rows
Low · Migrations · Round 2 · `backend/alembic/versions/20261006_0008_security_audit_round_1.py`, `20261005_0003_visit_visitor_link_scope.py`

- **Scenario.** A downgrade run while the API is serving counted the blocking rows without a table
  lock. An uncommitted row was invisible to the count. DROP COLUMN then waited for it and dropped its
  value, and the next upgrade widened scope (the SEC-24 exposure).
- **Fix.** The downgrades take `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` (0008: `visitors`,
  `email_messages`; 0003: `visits`) before counting. `.env.example` says to run downgrades with the API
  stopped.
- **Verification.** Two `test_migrations` tests: an uncommitted write is in flight, the downgrade waits
  for the lock, the write commits, and the downgrade refuses with nothing dropped. Both tests fail
  without the fix.

#### SEC-40: Production accepts database URLs without verified TLS
Low · Configuration · Round 2 · `backend/app/core/config.py`

- **Scenario.** Without `sslmode`, libpq uses `prefer`: it never verifies the server certificate and
  falls back to plain text. Anyone on the network path could read or alter visitor PII, password hashes,
  token hashes and audit rows.
- **Fix.** Production refuses each database URL unless libpq will verify the server certificate
  (`sslmode=verify-full` or `verify-ca`, in the URL or in `PGSSLMODE`), or the database is reached over
  a Unix socket or loopback. `require` and `prefer` are refused. There is an explicit opt-out,
  `DB_REQUIRE_TLS=false`, for a single-host network the deployment controls. `channel_binding=require`
  is not enforced. Completed by SEC-48.
- **Verification.** `test_config` (no mode, prefer, require and disable refused for each URL; verified
  or local accepted; `PGSSLMODE`, `PGHOST` and the opt-out honoured). Also checked in-process.

#### SEC-41: A visitor's name in an error toast survives sign-out into the next session
Low · PII (browser) · Round 2 · `frontend/src/main.tsx`, `frontend/src/components/ui/Toast.tsx`, `frontend/src/auth/session.ts`

- **Scenario.** A refused one-tap check-out showed a danger toast "<visitor> was not checked out". Error
  toasts never expire (WCAG 2.2.1), and the toast provider sits above the router. The toast therefore
  stayed on the public-facing sign-in screen and into the next user's session, whatever their role.
- **Fix.** `ToastApi.reset()` removes every toast and starts a new generation, so API objects handed out
  earlier show nothing afterwards. `AuthProvider` resets the toasts whenever the session identity
  changes: sign-in, sign-out, a 401, another tab's broadcast, or a reset. It schedules the reset through
  TanStack Query's notification batch. Finite lifetimes for error toasts were rejected for accessibility
  reasons.
- **Verification.** `Toast.test.tsx` (2 cases) and `auth/sessionToasts.test.tsx` (sign-out followed by an
  employee's sign-in, a 401, a sign-out in another tab, another user's sign-in, a check-out that itself
  gets 401, and a same-user re-check that keeps the toast). Live: in all four scenarios (S1–S4) the
  toast was gone.

#### SEC-42: Empty bulk stale check-out writes a permanent audit row on every call
Info · DoS / audit growth · Round 3 · `backend/app/services/attendance.py`

- **Scenario.** A scripted or stolen reception session looping `POST /reception/check-out-stale` wrote
  one `STALE_VISITS_CHECKED_OUT{count: 0}` row per call: about 860,000 a day per account, pushing real
  events out of the admin dashboard's recent list. A verifier saw 100 calls write 100 rows in 1.3 s.
- **Fix.** The first empty run of a user's company-local day is still audited; repeats that day write
  nothing (policy `stale_check_out_empty_runs`). Runs that check visits out are always audited. A
  429 run budget was not added, because it could only block a real end-of-day run.
- **Verification.**
  `test_check_out_api::test_an_empty_stale_check_out_is_audited_once_per_user_and_day`. Live: 5 empty
  calls wrote exactly 1 row.

#### SEC-43: Successful password changes are unthrottled (SEC-02's budget bypassed)
Medium · Rate limiting / DoS · Round 3 · `backend/app/services/auth.py`

- **Scenario.** The holder of any account alternates between two strong passwords with `POST
  /auth/change-password`; each response carries the new cookies, so a script just continues. One client
  managed about 6 changes a second, each costing two Argon2id operations plus session, user and audit
  writes. That is roughly 500,000 audit and session rows a day, and Argon2 load on the hash semaphore
  every tenant's logins share (503 for others).
- **Fix.** A per-account budget, `password_changes_per_user` (`RATE_LIMIT_PASSWORD_CHANGES_PER_HOUR`,
  default 5). It is reserved after the policy check and before Argon2, and counted only on commit;
  wrong, unchanged or lost-race attempts give the slot back. Beyond it the request gets 429 with
  `Retry-After` before any hashing or write, the session is kept, and a reset still works. A one-entry
  password history was not added: a third password defeats it.
- **Verification.**
  `test_password_flows::test_successful_password_changes_have_a_budget_per_account` (a hasher spy shows
  no Argon2 call on the 6th attempt) and `::test_a_spent_change_budget_leaves_the_password_reset`.
  Live: 5 changes got 204, the 6th got 429 with `Retry-After: 3598`, and a wrong current password also
  got 429. The session was kept, and exactly 5 `AUTH_PASSWORD_CHANGED` rows were written.

#### SEC-44: A visitor with more than 50 scheduled visits can never have their e-mail changed
Low · Availability · Round 3 · `backend/app/services/visitors.py`, `backend/app/core/rate_limit.py`

- **Scenario.** D-19 reserves one invitation per scheduled visit in the editor's daily budget. With more
  than `INVITATION_DAILY_LIMIT` (50) visits the reservation could never fit. Every editor, SYSTEM_ADMIN
  included, got 429 with `Retry-After: 86400` forever. Any employee could cause this with 51 ordinary
  bookings, after which a mistyped address could not be corrected.
- **Fix.** The limiter reports `exceeds_limit` with no retry hint for a reservation larger than its
  policy's limit. The visitor update turns this into 422 on `email`, which explains the count, the limit
  and what to do: cancel visits, or clear the address, which withdraws all passes at once. Nothing is
  written or spent. A batch that fits the budget but not today's remainder still gets a correct 429.
- **Verification.**
  `test_visitors_api::test_more_re_sends_than_the_daily_budget_holds_are_refused_with_what_to_do` and
  `test_rate_limit::test_more_slots_than_the_limit_never_fit`. Live: with 51 visits, 422 with no
  Retry-After; with 50 visits and 49 invitations left, a correct 429; with 49 visits, 200 and 49
  re-invitations.

#### SEC-45: WebSocket handshakes bypass log hygiene; DEBUG logs cookies
Low · Logging · Round 3 · `backend/app/serve.py`, `backend/app/core/logging.py`, `backend/app/core/config.py`

- **Scenario.** `uvicorn[standard]` installs `websockets`, so the server took upgrade handshakes before
  the application. It logged `"WebSocket <path>?<query>" 403` with the query string, and at
  `LOG_LEVEL=DEBUG` (accepted in production) every request header, cookies included. Behind a load
  balancer that forwards Upgrade, any same-site page could make a browser send its session, CSRF and
  device cookies into central logs.
- **Fix.** `ws="none"`, so upgrade requests are ordinary HTTP going through the app's middleware and
  access log. The `uvicorn`, `uvicorn.error` and `websockets` loggers are pinned at INFO or above
  whatever `LOG_LEVEL` says. Refusing DEBUG in production was not needed: nothing at DEBUG writes request
  data any more.
- **Verification.** `tests/unit/test_serve.py` (a real uvicorn server on loopback at DEBUG, with a
  handshake carrying cookies and a query). Live at DEBUG: the upgrade reached the app (404 with
  `X-Request-ID`), and the log held no cookie, no query and no "WebSocket" line.

#### SEC-46: Production accepts limit values that switch limiting off
Info · Configuration · Round 3 · `backend/app/core/config.py` · **Partial by design**

- **Scenario.** Production refused `RATE_LIMIT_ENABLED=false` but accepted `10^9` login failures per
  account. A relaxed E2E or staging file promoted to production would have run with no lockout.
- **Fix.** Production refuses ten guessing and recovery limits above 10× their defaults: login per
  IP+e-mail, per IP, per account and per prefix; change-password failures; forgot-password per e-mail,
  per IP and per prefix; reset per IP and per prefix. The message names the setting and the ceiling,
  never the value.
- **Not changed, deliberately.** Throughput budgets (API, scans, invitations, sign-ins, password changes)
  have no ceiling, since large sites raise them. Session lifetimes within their field bounds (720 h,
  1,440 min) are a deployment's policy (§6, R-11).
- **Verification.** Four `test_config` tests, including one that keeps the template within the
  ceilings. In-process: 10^9, 301, 201, 31 and 51 are refused for their settings; 10× the default is
  accepted.

#### SEC-47: Production accepts SECRET_KEYs published in the test suite
Info · Secrets · Round 3 · `backend/tests/unit/test_config.py`, `backend/tests/integration/test_runtime_privileges.py`, `backend/app/core/config.py`

- **Scenario.** Two high-entropy keys hard-coded in the tests passed the production check. An operator
  copying a "known-good" key would deploy one that anyone with the source knows, and with one device
  cookie an attacker could then forge device-trust entries.
- **Fix.** The tests generate keys at run time (`secrets.token_urlsafe(48)`). Production refuses the
  SHA-256 digests of the two formerly published keys:
  - `b12419b61003e9c0bab9811c707747ce32344b8c85d712559c0ed621844e6acd`
  - `3d666ae5e870a1810e585947a4445d4678293904caf32914cca577d98f209d07`
- **Verification.** `test_config::test_production_refuses_published_secret_keys`, and
  `::test_no_production_valid_secret_key_is_written_in_the_code`, an AST scan of `backend/app`,
  `backend/tests` and `scripts` for key literals the production check would accept.

#### SEC-48: Database TLS requirement bypassed through a libpq service file
Low · Configuration · Round 3 · `backend/app/core/config.py`

- **Scenario.** A URL such as `…@/vms?service=vmsprod`, or `PGSERVICE` with a host-less URL, was taken
  for the local Unix socket and accepted, while libpq read a remote host from `pg_service.conf` and
  connected with `prefer`. A verifier's fake server received both roles' passwords in plain text through
  the production startup path. The SEC-40 note had wrongly said such URLs were "not inspected".
- **Fix.** With a service (in the URL or `PGSERVICE`), only `sslmode=verify-full`/`verify-ca` in the URL
  itself counts, because the service entry outranks `PGSSLMODE`. `PGHOSTADDR` counts as a target. The
  precedence was checked against libpq itself.
- **Verification.** Six `test_config` tests, including
  `test_libpq_reads_a_service_entry_before_the_environment`, which uses a temporary `pg_service.conf`
  resolved by libpq. In-process: service URLs without a verifying sslmode in the URL are refused, as are
  `PGSERVICE` and a remote `PGHOSTADDR`.

#### SEC-49: Runtime-role startup check was a denylist
Low · DB privileges · Round 3 · `backend/app/db/privileges.py`

- **Scenario.** The SEC-23 check missed REPLICATION, CREATEROLE and CREATEDB, membership in
  `pg_execute_server_program` and `pg_read/write_server_files`, and SET-only memberships. With those, a
  SQL injection or leaked credential could run OS commands (`COPY … TO PROGRAM`), stream the WAL of every
  database, or reach privileges `has_table_privilege` does not see. An owner logged in with
  `-c role=vms_app` passed the check.
- **Fix.** The check judges `session_user` and is effectively an allowlist. New refusals:
  `switched_role`, `replicates`, `creates_roles`, `creates_databases`, `member_of_roles` (any
  membership, whatever its INHERIT and SET options) and `uses_server_files_or_programs`.
  `owns_schema_objects` now covers functions, types and the `public` schema itself. Role defaults are
  read for both the login and the current role.
- **Verification.** Five `test_runtime_privileges` tests (bootstrap superuser attributes, the three
  predefined server roles, `pg_monitor` and owner memberships, the `-c role=` switch, a role-default
  switch). Live: `vms_owner` is refused with `member_of_roles` and `creates_databases`.

#### SEC-50: After the server-side idle timeout, most screens keep showing data indefinitely
Low · Session (browser) · Round 3 · `frontend/src/auth/useAuth.ts`, `frontend/src/auth/AuthProvider.tsx`

- **Scenario.** Only `/reception` and `/inside` polled. A visitor profile, the history, the users list
  and other screens learned of a session end only from their next request, and a kiosk screen that stays
  visible never refocuses. After `SESSION_IDLE_MINUTES` the server ended the session, but the PII stayed
  readable and the account menu still named the user, for example overnight.
- **Fix.** `useSessionHeartbeat` refetches `/auth/me` every 60 s while signed in. It is mounted once in
  `RequireAuth`, so it never runs on public pages, and it runs in hidden tabs too. A 401 goes through the
  existing path: end the session, reset the toasts, go to `/login`. Every re-check sends
  `X-Background-Refresh: 1`, so the heartbeat never extends the idle timeout; this also stops a kiosk
  that wakes up from extending it. A client-side expiry timer was rejected: it misses deactivation,
  resets and revocation, and depends on the device clock.
- **Verification.** `auth/sessionExpiry.test.tsx` (expiry to `/login` with no PII; header sequence
  `[null,'1','1','1']`; one beat per minute; none while signed out). Live: screens reached `/login` 55 s
  after the idle limit, and `last_seen_at` did not move while the heartbeat ran. Residual: up to 60 s of
  stale screen (§6, R-12).

#### SEC-51: Back/forward cache restores the previous user's data after the session ended
Low · Session (browser) · Round 3 · `frontend/src/auth/AuthProvider.tsx`, `frontend/src/auth/session.ts`

- **Scenario.** On a shared device, a document left by a bookmark or a typed address sits in the
  back/forward cache. If the session then ended without a sign-out in this browser, Back restored the
  previous user's visitor profile. Offline, it stayed on screen indefinitely, and its links opened the
  cached Visitors list.
- **Fix.** On `pageshow` with `persisted`, a tab with a known session calls `forgetSession`, which
  removes every query except `['auth','me']` and the mutation cache, and resets `me` to unknown. It also
  resets the toasts, all in one batch. `RequireAuth` then shows its loader until the server answers.
  `location.reload()` was not used, because a dirty form's `beforeunload` prompt could cancel it.
  Phase 9 gate: nginx serves `index.html` and the SPA fallback with `Cache-Control: no-store`.
- **Verification.** `sessionExpiry.test.tsx` (4 back/forward-cache cases) and a toast case in
  `sessionToasts.test.tsx`. Live in Chromium with the back/forward cache allowed: the PII was gone by
  the first animation frame after `pageshow` in the offline, online-ended and same-user cases. The
  pre-fix build still showed the PII and the account menu at 8 s.

---

## 4. Refuted candidate findings

Each of these was reproduced by a verifier and then refuted as a vulnerability. Where the recorded
reasoning names a contract rule or decision, it is cited.

| # | Candidate (claimed severity) | What reproduced | Why refuted |
|---|---|---|---|
| 1 | C1 controls and Unicode line terminators (NEL, U+2028/2029) accepted in request text and reaching e-mail Subject headers unsanitised (low) | Walk-in names containing NEL followed by "Bcc: …", 8-bit CSI or U+2028 got 201 and were kept in `HOST_ARRIVAL` subjects; ESC got 422. | The facts reproduce but the claimed harms do not. Header injection needs a CR or LF, which `sanitize_header` strips, and the provider receives a JSON payload rather than raw MIME. Hygiene follow-ups landed anyway: SEC-34 refuses NEL, U+2028, U+2029, CR, LF and TAB inside names, and SEC-11 escapes C1 controls in logs. Other C1 characters are still accepted in names. |
| 2 | Session and reset-token network metadata (IP, user agent) never purged (low) | Revoked `user_sessions` rows keep the IP and UA, and reset-token rows keep `requested_ip`; the runtime role cannot delete. | The facts are correct, but the claimed privacy impact and the fix built on it do not hold. Since SEC-02, `cli prune-sessions` (owner role) removes long-ended sessions. Retention of the remaining metadata is a policy item (§7, recommendation 13). |
| 3 | A withdrawn pass (rotated, or revoked after an address change) can still check its visitor out (low) | A rotated pass scans 410 `PASS_REVOKED` for check-in, but can check out a visitor who is inside. | Documented and tested behaviour. It gives nobody a capability they do not already have: reception can check any visitor out. |
| 4 | Default privileges give future database objects more than the audit_logs pattern (info) | `pg_default_acl` grants SELECT, INSERT and UPDATE (tables) and USAGE/SELECT (sequences) to `vms_app` for future objects. | Describes a possible mistake in a future migration, not a defect today. The defaults are a documented choice (B57-60), and the proposed fix would not block the main risk. The SEC-23/49 startup check refuses DELETE, TRUNCATE and audit-log privileges whatever the defaults. |
| 5 | Strangers share an account's forgot-password budget, so the victim's own request is dropped and each stranger request invalidates the earlier link (low) | 3 stranger requests used the account's 3-per-15-minute budget; the victim's request got 202 but no e-mail. | The binding contract specifies this (§7.3: per e-mail 3 per 15 minutes, silently dropped; a newer token supersedes older ones), and it does not block recovery. |
| 6 | SEC-08 gap: one visit booked with a wider read scope gives the booker lasting EMPLOYEE read, search and edit access to a chosen visitor, surviving demotion and cancellation (medium) | A MANAGEMENT+EMPLOYEE user booked visitor Y with themselves as host and cancelled; after demotion to EMPLOYEE they still read and could edit Y. | Refuted as a vulnerability. §7.5 grants an EMPLOYEE the visitors linked to a visit they own, and the user was that visit's host. The user also held read access to every visitor when booking. |
| 7 | Visits a user booked for another host outlive the booker's deactivation or demotion, and the pass link they were shown keeps admitting people (medium) | After the booker's deactivation, the visit stayed SCHEDULED with an active pass, which scanned READY and checked in. | Refuted. A visit is owned by its host as well as its creator (D-02), and the host is still active. D-18 cancels only the departing user's *hosted* visits. A pass proves an invitation, not identity, and reception verifies ID (§12, R-3). |
| 8 | Correcting a visitor's e-mail does not withdraw the pass of a visit that is CHECKED_IN or NO_SHOW (low) | The CHECKED_IN visit's pass stayed active and could check the visitor out. | The binding contract specifies this: D-19 revokes the passes of SCHEDULED visits. The claimed root cause has no effect; such a pass can at most check out the visitor who is inside (as in #3). |
| 9 | An EMPLOYEE sees the current e-mail of a visitor outside their scope through `invitation.to_email` and `last_notice.to_email` on their own visit (medium) | Reproduced. | A documented, reasoned trade-off (B24-72, residual 2). The visit's owner is inviting that person and needs to know where the pass went. The reasoning holds (§6, R-9). |
| 10 | The runtime role can create persistent large objects outside the migrated schema (info) | Reproduced in a throwaway database (stock PostgreSQL behaviour). | Large objects give an attacker nothing beyond the role's sanctioned grants, one key claim is false in this provisioning, and the proposed "refuse to start" fix would add a denial-of-service lever. |

---

## 5. Controls verified

This section summarises the controls the eight lenses verified across the three rounds, deduplicated.
"Live" means probed against a running server or a real browser; "code review" marks items checked only by
reading the code. The project's own regression suites are listed in Appendix A.

### 5.1 Authentication and password storage

- **Argon2id with explicit parameters** (`backend/app/security/passwords.py`): time_cost 3, 64 MiB,
  parallelism 4, 32-byte hash, 16-byte salt. `check_needs_rehash` runs on login; live, a weak hash was
  upgraded to t=3, m=64 MiB, p=4 on sign-in. A process-wide semaphore with a 2 s acquire timeout answers
  503 `SERVICE_BUSY`, which never counts as a failure. NFKC normalisation is applied the same way on
  hash, verify and policy. Login passwords are capped at 1,024 characters, new ones at 128.
- **Password policy:** 12–128 characters, not the e-mail address, not on the 1,305-entry breached list,
  and not built from common words or the account's own words (SEC-03). All writers apply it: temporary
  passwords, change, reset and `create-admin`. A check costs about 1 ms even at 128 characters
  (measured), so it is not a CPU lever.
- **Login flow** (`backend/app/services/auth.py`):
  - The e-mail is normalised (NFKC, strip, lowercase) before the lookup and the limiter key; live,
    `'  RECEPTION@demo.local '` signs in.
  - The client budgets are reserved before any database work, and the account, unknown-address, device
    and success budgets before any Argon2 work.
  - Exactly one Argon2 verification runs on every path (a dummy hash from the same hasher for unknown
    addresses). Unknown, wrong, inactive and expired-temporary-password attempts all get the same 401
    `INVALID_CREDENTIALS`.
  - Timing parity was measured live three separate times: 90.7 vs 86.7 ms median (n=28), about 120 ms
    for both (medians within 10 ms), and 83.2 vs 87.9 ms (n=48). No usable oracle.
  - Unknown addresses get the same lockout budget and the same 429 message as real accounts.
- **Credential races:** login re-checks the verified hash under the user-row lock, change-password is a
  compare-and-swap with a session-liveness re-check, and reset takes the user lock first
  (`test_credential_races`).
- **Forced password change:** with `must_change_password`, every route except `GET /auth/me`,
  `POST /auth/change-password` and `POST /auth/logout` answers 403 `PASSWORD_CHANGE_REQUIRED` (route
  enumeration plus live probes). An expired temporary password (72 h, D-11) gets 401.
- **Forgot-password:**
  - Identical 202 body and headers for existing and unknown addresses (live medians 9.5 vs 14.3 ms; the
    next request on the same keep-alive connection is not delayed).
  - The account lookup, token and e-mail run in a background task, and the e-mail goes to the stored
    address, never the typed string.
  - Per-account budget: 6 requests from 6 IPs produced 3 e-mails.
- **Reset tokens:** 256-bit, stored as hashes, 30-minute TTL, `#token=` fragment link.
  - Consumption is atomic: 12 concurrent uses of one token gave exactly one 204 and eleven 400s.
  - A replay gets 400, and a newer request supersedes the token.
  - Change-password, reset and deactivation invalidate unused tokens, and invalidation is terminal.
  - A policy failure (422) leaves the token usable.
  - A completed reset revokes all sessions, renews the device-trust epoch, lifts the account block and
    sends a notice.
- **Device-trust cookie** (`backend/app/security/device_trust.py`): HMAC-SHA256 (128-bit tag) over user,
  issue time, epoch and nonce, with a key derived from `SECRET_KEY` and a label. Forged, foreign,
  oversized and expired entries earn nothing.
- **CLI:** `create-admin` reads the password from a prompt or stdin, never from argv, and applies the
  full policy.

### 5.2 Sessions and cookies

- Session and CSRF tokens are 256-bit `secrets.token_urlsafe` values. Only their SHA-256 is stored,
  malformed tokens are rejected before hashing, and tokens never appear in response bodies or logs
  (`backend/app/security/sessions.py`, `backend/app/repositories/sessions.py`).
- **Cookies (live, `COOKIE_SECURE=true`, `backend/app/api/cookies.py`):**
  - `__Host-vms_session`: HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=43200, no Domain.
  - `__Host-vms_csrf`: Secure, SameSite=Strict, readable by script.
  - `__Host-vms_device`: HttpOnly, Secure, SameSite=Strict, 90 days.

  A plain `vms_session` cookie is ignored in secure mode, and production refuses `COOKIE_SECURE=false`.
- **Session fixation:** a planted cookie is never adopted. Login revokes a still-live session cookie
  that the same browser presents (live: the old cookie gets 401).
- **Expiry:** idle (240 min) and absolute (12 h) limits are enforced server-side in one lookup
  (`find_live`, which also requires an active user); live, 241 idle minutes gives 401.
  `last_seen_at` is written at most once a minute, and never for `X-Background-Refresh: 1`; this was
  verified live through database timestamps.
- **Logout** requires the CSRF token (403 without it), revokes the session server-side (a replayed
  cookie gets 401) and clears the cookies.
- **Revocation:** change-password rotates the current session and revokes the others (SEC-04).
  Deactivation and reset revoke every session, unused reset tokens and the device trust. Roles are
  re-read on every request, so a role removal takes effect on the next request. Reactivation does not
  revive sessions.
- **SPA session hygiene** (`frontend/src/auth/`): the TanStack Query cache is cleared on sign-in,
  sign-out, a 401, a cross-tab broadcast and an identity change. Refused refetches drop their data. A
  heartbeat, a back/forward-cache restore check and a toast reset complete it (SEC-26/41/50/51).

### 5.3 CSRF, Origin and CORS

- **Global `CsrfOriginMiddleware`** (`backend/app/core/middleware.py`, `backend/app/security/csrf.py`)
  checks every unsafe method under `/api/v1`:
  - `Sec-Fetch-Site: cross-site` is rejected, and `same-site` needs an allowed Origin.
  - An Origin header must be in `ALLOWED_ORIGINS`.
  - Authenticated requests need `X-CSRF-Token`. It is checked against the session's stored SHA-256
    with `hmac.compare_digest` (a per-session synchroniser token, not double-submit, so tossing the
    CSRF cookie gains nothing).

  Only login, forgot-password and reset-password are exempt from the token check, and they still get the
  Origin and `Sec-Fetch-Site` checks.
- **Live matrices:**
  - Round 1: 115 requests, every unsafe route with no token, a wrong token, a foreign Origin, cross-site
    and Origin `null`; all got 403 `CSRF_FAILED`.
  - Round 2: all 22 unsafe routes, enumerated from `/openapi.json`.
  - Round 3: allowed and refused combinations, including an Origin with userinfo, a wrong port, a
    trailing slash and a same-site request without Origin.
- Path variants cannot route around the check: dot segments, `%2F`, `%00`, `;params`, `//`,
  absolute-form targets and case variants are checked (403) or not routed (404). `root_path`
  deployments do not fail open, and with `redirect_slashes=False` there are no 307s.
- **Login CSRF through simple requests** is impossible: `text/plain` and form bodies get 422.
- **No CORS anywhere** (by design, §3): a preflight gets 405 with no `Access-Control-*` headers, a GET
  with a foreign Origin gets no ACAO, and Vite has `cors:false`. `vite preview` refuses a foreign Host
  header with 403 (DNS-rebinding protection).
- **SPA side** (`frontend/src/api/client.ts`): `readCsrfToken` prefers `__Host-vms_csrf`, the token is
  sent only on unsafe methods, and fetch uses `credentials: 'same-origin'` and `cache: 'no-store'`.

### 5.4 Authorization, RBAC and tenant isolation

- **Live role matrices**, reported with no deviations from §7.5 except the findings reported:
  - Round 1: 936 cells (all 40 API operations × 13 principals), plus 78 cells on allowed mutation paths
    and about 95 targeted probes.
  - Round 2: about 1,250 requests across 15 principals (1,153 in the coarse matrix and 81 deep
    probes).
  - Round 3: 1,185 cells across 15 principals (seeded users from both companies, four multi-role users
    and no session), about 190 targeted requests and 6 concurrent races.
- Route capabilities match §7.5 `CAPABILITY_ROLES` exactly (`backend/app/security/permissions.py`), and
  the SPA's `SECTION_ACCESS` (`frontend/src/auth/roles.ts`) matches them. A per-role crawl of the UI
  made no request the server refused.
- **Tenant isolation:**
  - `company_id` comes only from the session.
  - Another company's ID in a path gets 404, identical to an unknown ID; the capability check (403) runs
    before any lookup, so there is no existence oracle.
  - In bodies and filters, another company's ID is a 422 field error with the same "does not exist"
    text as a random UUID.
  - Lists, dashboards, reports, the host directory, the reception lists and the audit log are
    company-scoped (checked against both tenants' counts).
  - The database backs this with composite `(company_id, x)` foreign keys (§5.11).
- **EMPLOYEE scope is forced:** `scope=all` is intersected with owned visits, filters only narrow, an
  out-of-scope `visitor_id` is a 422, and `q` never matches stored data of visitors the caller cannot
  read. Duplicate query parameters resolve last-wins and are validated. UUID variants (upper case,
  braces, `urn:`), `../` and encoded slashes get 404.
- **Visitor scope and edit rule** (B24-13, SEC-08): `VISITOR_EXISTS` returns details only to callers
  who read every visitor. Inline reuse of an out-of-scope visitor grants no scope (B24-72). An e-mail
  match under a different name is refused (B57-70).
- **Role-specific limits:** MANAGEMENT is read-only (403 on every write). RECEPTIONIST cannot
  administer. Visit management needs ownership as creator or host, and walk-ins belong to their host.
- **Mass assignment:** unknown or protected fields (`company_id`, `email`, `must_change_password`,
  `status`, `slug`, `created_by_id`, …) get 422 (`extra=forbid`).
- **Self-modification and last-admin:** an admin cannot remove their own SYSTEM_ADMIN role or change
  their own activity (409 `SELF_MODIFICATION`). In 12 live races (round 1) and 6 (round 3) of two admins
  demoting each other, at least one active admin always remained.
- **Revocation is atomic for in-flight writes:** `require_still_authorized` and
  `lock_company_for_change` (`backend/app/services/authorization.py`) cover every administrative and
  visit or visitor write (SEC-07/31/37).
- Audit logs are readable by SYSTEM_ADMIN only (D-13), and unattributed rows are never listed to a
  tenant's admins.

### 5.5 QR pass tokens and reception

- **Tokens:** `secrets.token_urlsafe(32)` (256 bits). Only the SHA-256 is stored
  (`visitor_passes.token_hash CHAR(64) UNIQUE`), lookups filter by hash *and* `company_id`, and a visit
  has at most one active pass (`uq_passes_active_visit`). Sources: `backend/app/security/tokens.py`,
  `backend/app/repositories/passes.py`.
- **The raw token is never stored or logged.** Live searches of a full `pg_dump`, the JSON logs, audit
  metadata and `email_messages` found no issued token. `IssuedPass` and `OutgoingEmail` hide tokens and
  URLs from `repr`. Only the development outbox writes `pass_url`, and production refuses that
  provider.
- **One-time link:**
  - The pass URL is `{QR_BASE_URL}/pass#<token>`, with the token in the fragment.
  - `/pass` makes no API call and shows no PII, with `Referrer-Policy: no-referrer` (live, on a
    production build).
  - `pass_url` appears only in the `POST /visits`, `/invitation` and `/pass` responses, which carry
    `Cache-Control: no-store`; GET responses never contain it.
  - The SPA keeps it in component state only (mutations use `gcTime 0`). A grep of a persistent Chromium
    profile found no token.
- **No cross-tenant oracle:** a tenant-B receptionist scanning a tenant-A token gets the same 404
  `PASS_INVALID` as a random token (same 128-byte body and headers). Median timing was 9.60 vs 9.51 ms
  in round 1 and 14.13 vs 14.22 ms in round 3. The audit row stays in B's company, with no entity.
- A pass presented for another visit of the same company gets 404 `PASS_INVALID`, and neither visit
  changes.
- **§6 scan order** was verified live for all nine rows. Replay is refused after check-out
  (`VISIT_COMPLETED`), cancellation (`VISIT_CANCELLED`), rotation and an e-mail change
  (`PASS_REVOKED`). The OVERRIDE and MANUAL window rules hold, and invisible-only reasons are refused.
- **Concurrency (live, parallel HTTP):** each of these races always ended with exactly one consistent
  outcome, and no visit ever had more than one active pass:
  - triple check-in (QR, MANUAL and OVERRIDE at once);
  - check-in against cancel, and check-in against rotation;
  - one visitor on two visits, and two concurrent walk-ins;
  - double check-out;
  - rotation, resend and an e-mail change at the same time.
- **Shared token grammar:** differential fuzzing of the backend `extract_pass_token` against the
  frontend `parsePassToken` (`frontend/src/scanner/parsePassToken.ts`) found 0 disagreements over 46,009
  inputs (round 1) and 30,210 (round 3). Both suites share the vectors in
  `docs/contract/pass-token-vectors.json`, and the patterns are linear (no ReDoS).
- **Camera:** frames are decoded on the device, and a QR code that is not a pass is sent as a
  placeholder, never its content. The zxing wasm is self-hosted (a `locateFile` override, SHA-256 pinned
  by a test). Capture is video only, and tracks stop on route change, sign-out, `visibilitychange` and
  `pagehide`.
- **Budgets:** scans cost 120 per minute per user, counted before any lookup, and QR check-in and
  check-out share that budget. Attendance refusals have a budget of 30 per minute. Rotations and resends
  are limited to 3 per visit per hour. Walk-ins issue no pass. The bulk stale check-out is
  company-scoped and needs a reason.

### 5.6 Injection and output encoding

- **SQL injection:**
  - Data access goes through the ORM with bound parameters. The only `text()` statements are static or
    bound: the health `SELECT 1`, the `pg_timezone_names` lookup and the privilege check.
  - The reports' `AT TIME ZONE` takes a bound timezone that must exist in both `zoneinfo` and
    `pg_timezone_names`. ORDER BY is fixed per query.
  - LIKE input is escaped (`escape_like` in `backend/app/core/text.py`, `ESCAPE '\'`).
  - Live fuzzing (72 requests in round 1, broader in round 3) with quotes, `pg_sleep`, UNION, comment
    payloads, `$$`, `E''`, NUL, full-width characters and Arabic caused no 500, no delay and no
    widened results; `%` and `_` match literally.
- **XSS:**
  - The SPA source has no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `document.write` or
    `iframe`.
  - Stored payloads (`<img onerror>`, `<script>`, `</title><script>`, `javascript:` hrefs) in visitor,
    company, department, user, purpose, address, reason and note fields rendered as text. This was
    checked across the main screens in round 1 and on 17 pages in round 3, for admin, reception and
    management, with no dialog, no injected element and no CSP violation.
  - Audit metadata, user agents and IPs are rendered as text.
- **Link sinks:** `telHref` produces only a grammar-checked `tel:` with digits and "+" (SEC-33).
  `mailtoHref` percent-encodes the local part and the domain, so no extra headers can be added.
  `pass_url` is never used as an href, and there are no `target=_blank` links.
- **Open redirect:** `safeNextPath` (`frontend/src/auth/redirect.ts`) accepts only normalised,
  same-origin, root-relative paths. Live in Chromium, `//evil`, `%2F%2F`, `/.//`, `/x/..//`, backslash,
  tab, `javascript:` and `https:` payloads all landed on the app's origin. The backend sends no
  redirects at all.
- **E-mail HTML** (`backend/app/email/rendering.py`):
  - Jinja2 autoescape is on for `.html`, with `StrictUndefined`. There is no `|safe`, `Markup` or
    `from_string`, so no template injection; SSTI payloads stay literal.
  - Outbox output showed payloads escaped in the body, `<title>`, preheader and `alt` attribute.
  - Every href is built from `APP_BASE_URL` or `QR_BASE_URL`. Live, forged `Host`, `X-Forwarded-Host`
    and `Forwarded` headers did not change the reset link.
- **E-mail headers:**
  - `sanitize_header` strips CR, LF and other C0 controls from Subject and From.
  - Recipients and Reply-To are validated with `email_validator` (no display names, quoted local parts
    or domain literals); live, CRLF, commas, angle brackets, U+2028, NEL and bidi controls in addresses
    are refused.
  - From is configuration only, and Resend receives JSON, not raw MIME.
  - Names are single-line and free of bidi controls (SEC-10/34).
- **Request input hygiene:** C0 controls are rejected (B1-36), and invisible-only text is empty
  (L-BE-1). JSON nested 30,000 levels deep gets 400 in 2.7 ms. The backend has no `eval`, `pickle`,
  `yaml` or `subprocess` sinks.

### 5.7 Rate limiting and resource exhaustion

Current default budgets (`backend/app/core/rate_limit.py`, `.env.example`). The limiter reserves a slot
and settles it afterwards, so there is no check-then-record race (`test_throttle_concurrency`):

| Budget | Default |
|---|---|
| Login failures per (IP, e-mail) / per IP / per IPv6 /48 | 5 / 30 / 300 per 5 min |
| Login failures per account (untrusted clients) and per trusted device | 10 per 15 min, then a 15-min block |
| Successful logins per account | 30 per 15 min |
| Change-password: wrong current password / successful changes | 5 per 15 min (the session is revoked at the limit) / 5 per hour |
| Forgot-password per e-mail / per IP / per /48 | 3 / 10 / 100 per 15 min (202, silently dropped) |
| Reset-password per IP / per /48 | 20 / 200 per 15 min |
| Authenticated API per user | 600 per min |
| Scans and QR check-in/out per user | 120 per min |
| Refused attendance changes per user | 30 per min |
| Invitations per user / resends and rotations per visit | 50 per day / 3 per hour |
| Reschedule notices per user / per visit; host arrivals per user | 50 per day / 3 per hour; 500 per day |
| Password-changed notices per account | 5 per hour |
| Taken-address refusals per admin | 10 per hour |
| Written attributed-refusal audit rows per user and action | 10 per min, then a summary |

- **Live:** the 6th failure per (IP, e-mail) got 429 with `Retry-After: 300`. The account lockout held
  across addresses, and a correct password during the lockout still got 429 (one
  `AUTH_ACCOUNT_THROTTLED` row). Addresses within one IPv6 /64 share a bucket. Case, whitespace, NBSP
  and full-width variants of an e-mail normalise to the same bucket. The 601st API request, the 121st
  scan, the 51st invitation and the 4th resend all got 429.
- **Request size:** `BodySizeLimitMiddleware` (`backend/app/core/middleware.py`) caps bodies at 64 KiB:
  a declared length over the limit is refused before reading, chunked bodies are counted while read, and
  an understated `Content-Length` reads only the declared bytes. Live, a 70 KB chunked body got 413.
- **Query bounds:** `page_size` 1–100, `page` up to 100,000, `q` up to 100 characters, multi-value
  filters up to 500, report ranges up to 366 days.
- **Limiter memory is bounded.** The NETWORK and EMAIL scopes are capped at 100,000 buckets each; at the
  cap, new keys are admitted untracked rather than locking everyone out (B1-66). Idle buckets are swept.
  Keys are HMAC-SHA256 digests, so no raw address or e-mail is held in memory.
- **Audit flood control:** `RATE_LIMITED` and `CSRF_FAILED` are coalesced, unattributed events share a
  budget of 10 written rows per window, and attributed refusals have their own budget (SEC-15).
- **Client IP:** `X-Forwarded-For` is honoured only from `TRUSTED_PROXIES`, using the rightmost
  untrusted entry; an unparsable entry or a zone ID gives no IP (`backend/app/core/client_ip.py`).
  uvicorn runs with `proxy_headers=False`. Live with no trusted proxies, spoofed XFF was ignored.
  Production refuses catch-all proxies (SEC-18).
- **Limitation:** in round 2 this lens's live login probing was stopped (§2.4), so that round's items
  are code review. Round 1 and the regression pass exercised the login limits live.

### 5.8 Security headers and clickjacking

- **API** (`backend/app/core/middleware.py`), checked on 200, 403, 404, 405 and 413 responses:
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`;
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`;
  - `Cache-Control: no-store`;
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none';
    form-action 'none'`;
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`;
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production;
  - no `Server` header.
- **SPA** (`frontend/config/securityHeaders.ts`, the list nginx must serve), verified through
  `vite preview`:
  - `Content-Security-Policy`: `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`,
    `connect-src 'self'`, `img-src 'self' data: blob:`, `style-src 'self'`, `worker-src 'self' blob:`,
    `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`;
  - `Permissions-Policy: camera=(self), microphone=(), geolocation=()`;
  - HSTS, `no-referrer`, `nosniff`, `DENY` and COOP.
- **CSP compatibility:** zero `securitypolicyviolation` events across 21 routes × 5 roles, plus dialogs,
  the reports, the QR views and the reception scan flow. The built `index.html` has no inline script or
  style, the bundles contain no `eval` or `new Function`, and no source maps are shipped.
- **Clickjacking:** both the SPA and the API send `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Production** disables `/docs`, `/openapi.json`, `/redoc` and `/docs/oauth2-redirect` (404 in the
  standard envelope).
- **Caveat:** the production nginx does not exist yet, so the SPA headers have been verified only
  through `vite preview` (R-4).

### 5.9 Secrets and configuration

- **No secrets in the repository.** Greps for key formats (`re_`, `sk_`, AKIA, `ghp_`, PEM, JWT, long
  literals) found only test fixtures and documented local defaults. `.env`, `.local/`, `backend/var/`,
  `dist` and the E2E artefacts are git-ignored (checked with `git check-ignore`). `.env.example` ships an
  empty `SECRET_KEY` and `RESEND_API_KEY`. The test suite carries no production-valid key (SEC-47).
- `APP_ENV` is required and has no default, so a deployment that omits it fails closed (B1-29).
- **Production refuses to start** (`backend/app/core/config.py`) with any of the following. Refusal
  messages never echo values.
  - **Secrets:** a dev, weak, guessable or published `SECRET_KEY` (under 43 characters or under an
    estimated 128 bits).
  - **Cookies and limits:** `COOKIE_SECURE=false`; `RATE_LIMIT_ENABLED=false`; guessing or recovery
    limits above 10× their defaults.
  - **E-mail:** `EMAIL_PROVIDER` outbox or memory; `EMAIL_FAIL_DOMAIN` set; Resend without a key.
  - **URLs and proxies:** an http `APP_BASE_URL`, `QR_BASE_URL` or allowed origin; catch-all
    `TRUSTED_PROXIES`.
  - **Database URLs:** the published `*local_dev*` passwords; the owner role as `DATABASE_URL`; an
    ambiguous URL; a remote database without verified TLS (service files included).
  - **Database role:** a runtime role that fails the privilege check (§5.11).
- **Secret handling:** `SECRET_KEY`, `RESEND_API_KEY`, `SEED_DEMO_PASSWORD` and both database URLs are
  `SecretStr`, and pydantic runs with `hide_input_in_errors=True`.
  - `ResendProvider`'s `repr` shows only the endpoint.
  - Provider errors carry only the HTTP status and a whitelisted error type.
  - httpx exceptions are re-raised `from None`, so a key containing a newline never reaches logs (tested
    against a local fake Resend server).
- **CLI:** `seed-demo`, `seed-e2e` and `e2e-time-travel` exit 2 under `APP_ENV=production`, and
  `prune-sessions` uses the owner URL.
- **Frontend build:** only `import.meta.env.PROD` is read, there are no `VITE_` secrets, and `dist`
  contains no credentials and no source maps.

### 5.10 Logging, PII and error responses

- **Logs carry no PII or secrets.** Structured JSON logs from full live flows were checked in three
  rounds. The flows covered sign-in success and failure, forgot/reset and change password, invitations,
  scans, check-in and check-out, walk-ins, cancellation, user administration, CSRF failures, 403s and
  validation errors. The logs contained no e-mail address, name, phone, purpose, reason, password
  (wrong and temporary ones included), token, user agent or query string.
- **Access log:** the app's own access log records the path only, and uvicorn's access log is
  disabled.
- **DEBUG level** adds no sensitive lines: `sqlalchemy.engine` is pinned at WARNING, the engine uses
  `hide_parameters=True`, and the protocol loggers stay at INFO (SEC-45).
- **Log hygiene** (`backend/app/core/logging.py`): sensitive extra keys are redacted, C0, C1 and line
  separators are escaped, PostgreSQL DETAIL is scrubbed, and records are never dropped
  (SEC-11/19). `X-Request-ID` has a strict format and is accepted only from trusted proxies (SEC-12).
- **Audit metadata** (`sanitize_metadata` in `backend/app/services/audit.py`) accepts only
  identifier-shaped strings. All 85 rows of a live run held only IDs, enums, counts, changed-field
  names and recipient domains. Unknown-account failures store no identifier.
- **Stored data:** `email_messages` stores the kind, recipient, subject, status and a sanitised error,
  never bodies or links. A database dump holds no raw session, CSRF, reset or pass token, no plaintext
  password and no attempted login identifier.
- **Error responses:**
  - About 40 fuzz cases in round 2, and about 13,000 GET requests across 11 list endpoints plus
    malformed raw requests in round 3. The raw requests covered invalid UTF-8, a BOM, UTF-16, lone
    surrogates, `NaN`/`1e999999`, deep nesting, form and multipart bodies, bad gzip, oversize bodies and
    odd cookies.
  - Every response was a clean 400, 401, 404, 405, 413 or 422 envelope with no stack trace, SQL or
    driver text, and no 5xx at all. 422 messages never echo input.
  - With the database down, the API answers 503 `SERVICE_BUSY`.
  - SPA error boundaries show generic text and a reference ID only.
- **Data minimisation:** there is no national ID, document number, photo or date of birth in the
  schema, and extra fields are refused.

### 5.11 Database privileges and migrations

- **`vms_app` is a plain LOGIN role**: no superuser, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS, and
  no role memberships.
  - It has SELECT, INSERT and UPDATE on the nine business tables, with no DELETE, TRUNCATE, TRIGGER or
    REFERENCES (B57-60).
  - On `audit_logs` it has SELECT plus column-level INSERT excluding `seq`, and no sequence privileges
    (SEC-21).
  - It has no access to `alembic_version`, no CREATE on the schema or database, and no TEMPORARY
    (SEC-22).
- **Refused as `vms_app`, live:**
  - DDL: CREATE TABLE, VIEW, FUNCTION, INDEX, SCHEMA and EXTENSION; replacing the trigger function;
    `ALTER TABLE … DISABLE TRIGGER` (named and ALL); `ENABLE REPLICA TRIGGER`.
  - Role and session switching: `SET session_replication_role`, `SET ROLE vms_owner`,
    `SET SESSION AUTHORIZATION`.
  - Server files and programs: `COPY TO/FROM PROGRAM`, `pg_read_file`, `lo_import`.
  - Maintenance and ownership: ALTER OWNER, CLUSTER, REINDEX; ANALYZE and VACUUM on `audit_logs` are
    skipped with "permission denied".
- **Audit immutability:** UPDATE, DELETE, TRUNCATE, `SELECT FOR UPDATE`, `ON CONFLICT DO UPDATE`,
  MERGE, `OVERRIDING SYSTEM VALUE`, `nextval`/`setval` and locks above ACCESS SHARE are all refused. The
  `audit_logs_immutable` statement trigger also blocks the owner's UPDATE, DELETE and TRUNCATE.
  `visits_terminal_immutable` blocks every change to CHECKED_OUT and CANCELLED visits, including through
  MERGE, upserts and writable CTEs.
- **Composite tenant foreign keys:** all 20 FKs were reviewed. Every tenant reference is
  `(company_id, x)`, and live cross-tenant inserts were rejected. The only exceptions are as specified:
  `password_reset_tokens` (no `company_id`) and `audit_logs` (no FKs, B1-01).
- **Default privileges** for future tables are SELECT, INSERT and UPDATE only.
- **Production startup check** (`backend/app/db/privileges.py`): an allowlist judged on the login role
  (SEC-23/49), plus pinned session settings and READ COMMITTED (`backend/app/db/session.py`,
  SEC-37/38).
- **Migrations:**
  - `alembic check` reports no drift, and there is a single head (`0009`).
  - Downgrade and upgrade round trips restore identical table, column and sequence ACLs.
  - Downgrade guards lock before counting and refuse lossy rollbacks (SEC-24/39), and offline `--sql`
    downgrades fail closed.
  - `DB_APP_ROLE` is regex-validated wherever it is interpolated.
  - There are no SECURITY DEFINER functions, and `search_path` is pinned, so function planting is not
    possible.
  - `prune-sessions` uses a parameterised delete, runs as the owner and keeps at least 1 day.

### 5.12 Supply chain

- **npm:** `npm audit` reports 0 vulnerabilities across 48 production and 244 total packages.
  `npm audit signatures` verified registry signatures for all 180 installed packages, 77 of them with
  attestations. Every lockfile (v3) entry has an integrity hash and resolves from `registry.npmjs.org`.
  The only install script is `fsevents` (dev, optional, macOS only).
- **Python:** `pip-audit` 2.10.1, run with `--require-hashes` from a throwaway venv outside the project
  against both PyPI and OSV, reports no known vulnerabilities in `requirements.txt` (39 packages) or
  `requirements-dev.txt`. The installed venv matches the lock exactly. Hash pinning is SEC-25.
- **Versions** include the fixes for known CVEs: h11 0.16.0 (CVE-2025-43859), Jinja2 3.1.6
  (CVE-2025-27516), dnspython 2.8.0 (CVE-2023-29483) and starlette 1.7.0. Also pinned: uvicorn 0.54.0
  and psycopg 3.3.6 (bundling libpq 18.4). Python's OpenSSL is 3.5.7, and the server is
  PostgreSQL 18.6.
- Unusual development dependencies were checked and are legitimate: `httpx2`/`httpcore2` (from the
  pydantic organisation, used by Starlette's test client) and `ast-serialize`/`librt` (mypy).

### 5.13 Frontend, PWA and browser storage

- **Service worker** (`frontend/public/sw.js`, `frontend/config/serviceWorkerPrecache.ts`):
  - It never intercepts `/api`: the bail-out runs before `respondWith`. Live, across 5 roles × 21 routes,
    no API response came from the service worker.
  - Cache Storage held only the versioned precache (21 static build files). Navigations are
    network-first and HTML is never cached at runtime; offline, only the static shell is served.
  - The cache version is a content hash, and old caches are deleted on activate.
  - It is registered only in production builds, with `updateViaCache: 'none'`, and `sw.js` is served
    `no-cache`.
- **Browser storage:** `localStorage` holds only scanner preferences and a transient auth-sync key,
  `sessionStorage` only router scroll positions, and there are no IndexedDB databases (checked live for
  six accounts).
- **Shared-device remanence controls** (SEC-20/26/27/28/41/50/51):
  - Search text stays out of URLs, and page titles are generic.
  - Router state is owner-tagged.
  - Sign-in and sign-out reach every tab, with an identity check.
  - A 60 s heartbeat runs while signed in.
  - Restores from the back/forward cache are checked first.
  - Toasts are reset with the session.
  - In Chromium, an explicit sign-out also evicts back/forward-cached documents.
- **Reset and pass tokens:** the reset token is stripped from the address bar before the first render.
  It is never in the DOM, storage or router state, and it is sent only in the POST body. The pass token
  travels only in the fragment.
- **Route guards and actions:** route guards match the backend capabilities, and visit and visitor
  actions are driven by server-computed permissions.
- **Credential fields:** autocomplete attributes are correct, and PII fields, search boxes and the pass
  entry use `autocomplete=off`. Chromium persisted no submitted or generated password. The temporary
  password generator uses `crypto.getRandomValues` with rejection sampling (about 116 bits).
- **Third parties:** no request leaves the app's origin for any role or flow. Scripts, styles, fonts,
  icons and the wasm are all self-hosted.

### 5.14 File uploads

The product has no file upload. Checked:

- No endpoint declares an `UploadFile` or `File` parameter in `backend/app`.
- All request bodies are JSON; form, multipart and text bodies get 422.
- Bodies are capped at 64 KiB before parsing.
- The only binary artefact is the QR PNG the server generates with `segno`.
- The outbox provider names files only by message UUID and a validated content ID, so there is no path
  traversal.

### 5.15 Enumeration (cross-cutting)

The following give no existence oracle:

- login responses, timing and lockouts;
- forgot-password (same response and timing, background work);
- reset tokens (256-bit);
- cross-tenant path, body and filter IDs (the same 404 or 422 as unknown IDs, with capability checks
  before lookups);
- pass scans (byte-identical `PASS_INVALID`, same timing);
- `VISITOR_EXISTS` (no details for EMPLOYEE-only callers).

The remaining documented signals are listed in §6, R-9, and SEC-05 in R-6.

---

## 6. Residual risks and accepted trade-offs

| # | Residual risk or trade-off | Source | Why accepted | Compensating control / required action |
|---|---|---|---|---|
| R-1 | **The rate limiter is in memory, in one process.** Budgets and lockouts live in the process. A restart resets them all (lockouts and daily e-mail budgets included). Several instances or workers would multiply every budget. | Contract §3, §12; `app/serve.py` (`workers=1`) | Single-instance MVP. | Run exactly one application process per deployment. Implement the documented shared (Redis) limiter before any horizontal scaling. Treat unplanned restarts as security-relevant events in monitoring. *Phase 9 closure, 2026-10-07: amended for the shipped four-process layout, which the engineering security review accepted with conditions. See the R-1 closure note below this table.* |
| R-2 | **E-mail delivery runs as in-process FastAPI BackgroundTasks.** A crash or restart loses queued deliveries: invitations, reset links, password-changed notices. | Contract §9, §12 | Rows stay PENDING or FAILED and visible ("Needs attention"). Senders can resend; users can request a new reset. | Monitor PENDING and FAILED `email_messages`. A worker queue is the documented upgrade path. |
| R-3 | **QR passes are bearer credentials.** A pass proves an invitation, not identity; whoever holds a forwarded or stolen pass can present it. The LOST_PASS guards (SEC-09/32) nudge an honest desk, but a wrong reason or a wrong record chosen by staff is not caught. | Contract §12, D-10; SEC-32 | Inherent to emailed passes. | The "Verify ID: <name>" cue on every scan. An e-mail change and a resend revoke the old pass. Passes are bound to a time window, a company and a visit. Staff procedure: always verify ID. |
| R-4 | **Deployment artefacts are neither written nor verified.** Dockerfiles, `docker-compose.yml` and the nginx configuration are Phase 9 deliverables. Docker is not installed on the build machine, so they cannot be verified there. TLS termination, HSTS from nginx, the `X-Forwarded-For` overwrite, `no-store` on `index.html`, Host handling and blocking Upgrade have not been tested end to end. | Contract §1, §12, §15 | Environment constraint. | Recommendations 1, 2 and 7. Repeat the header, proxy and TLS checks of §5.3, §5.7 and §5.8 against the deployed stack. |
| R-5 | **Tenant isolation has no row-level security.** Reads are isolated by application-level scoping; a future defect in a repository query would not be caught by the database for reads. | Contract §3.2-5 | Design choice. Composite FKs stop cross-tenant references on writes. | Three live role matrices (more than 3,000 requests) and the project's RBAC and isolation suites. Keep these suites mandatory in CI. |
| R-6 | **SEC-05:** with global e-mail uniqueness, an administrator can learn whether an address has an account in another tenant. | D-03, §8 `POST /users` | Fixing it needs a contract change (invitation flow or per-tenant uniqueness). | Limited to 10 confirmations per administrator per hour, every miss creates an audited user, and the §8.2 wording has been flagged. Decide at the next contract revision. |
| R-7 | **SEC-29:** a reset link opened on a shared device stays in the browser's saved history for up to the token's 30-minute life. | Contract §7.2 | No page can remove a recorded visit. | Single use, 30-minute TTL, superseded by any newer request; the shared-device browser policy (recommendation 9). |
| R-8 | **Account lockout residuals.** A browser that never signed in stays blocked until a reset. An attacker on the victim's own network address can spend that address's per-IP budgets. There is no admin unlock, "sign out everywhere" or alerting. | SEC-01, SEC-30 | Unlock and sign-out-everywhere need §8 endpoints and UI (a contract change). Deactivating and reactivating the account has the same effect. | Device trust plus forgot/reset recovery. Alert on `AUTH_ACCOUNT_THROTTLED` (recommendation 6). |
| R-9 | **Documented account and data signals.** (a) While an account's success budget is spent, which takes its password, a 429 reveals that it exists (SEC-02). (b) When the EMAIL limiter scope is full (about 830 IPv4 addresses at full budget), unknown addresses get no lockout budget, so 10 failures per candidate can tell real accounts from unknown ones. This is audited, and it locks the real accounts (B1-66). (c) A whole-name equality check exists for someone who already knows a visitor's address; each try is audited and budgeted (B57-01, SEC-15). (d) `invitation.to_email` shows a visit's owner the new address after reception changes it (B24-72 residual 2). | Decision files cited | Each was weighed against usability or a larger risk and recorded with reasons. | Audit rows for each; monitoring (recommendation 6). |
| R-10 | **The append-only audit table grows.** Unattributed `AUTH_LOGIN_FAILED` and `AUTH_PASSWORD_RESET_FAILED` stay one row per response (forensic evidence, §7.4), bounded per source address. Other successful writes are bounded only by the 600-per-minute API budget. The runtime role cannot delete; only the owner can prune, and only sessions have a prune command. | SEC-15, SEC-42, L-BE-2, B57-60 | Evidence over volume; a DDoS-scale attacker could flood the service directly anyway. | Monitor the table's growth; define audit retention and archiving (recommendation 13). *Phase 9 closure, 2026-10-07: the SEC-15 row budget and the `RATE_LIMITED` coalescing apply per API process. With the four shipped processes, one user can cause up to 44 `ACCESS_DENIED` rows a minute and 8 `RATE_LIMITED` rows for the per-user API budget (11 and 2 with one process). Successful writes still reach only the main process, so their 600-per-minute bound is unchanged (R-1 closure note).* |
| R-11 | **Some production settings are policy, not refusals.** Throughput budgets and session lifetimes up to 720 h and 1,440 min are not capped (SEC-46). The `SECRET_KEY` estimate cannot prove randomness (SEC-35/47). `channel_binding=require` is not enforced (SEC-40). `DB_REQUIRE_TLS=false` is an explicit opt-out for a single-host network. | Decision files | Operator choices within sane bounds. | Deployment runbook values (recommendations 3 and 4). |
| R-12 | **Shared-device remanence in the browser.** Up to 60 s of stale screen after the server ends a session (SEC-50). A tab frozen by the browser and shown again while offline keeps its last screen (SEC-51 known limit). Chromium's session-restore files keep owner-tagged search text, without names (SEC-20). One browser profile holds one session at a time. | `phase-8-frontend.md`, Known limits | Browser constraints. | The shared-device browser policy (recommendation 9); explicit sign-out; separate profiles per person. |
| R-13 | **PII retention.** Visitors and visits are never deleted (D-12). Visitor anonymisation is a documented future feature. Session and reset-token rows keep IP and user agent. | Contract §12, D-12 | MVP scope. | Define a retention policy and an owner-role maintenance path before go-live (recommendation 13). |
| R-14 | **Password-only authentication.** The contract has no MFA or SSO. | Contract §7 | Out of the contracted scope. | Recommendation 11. |
| R-15 | **Only Chromium was tested.** Safari/iPadOS and Firefox are supported (§10) but were not exercised, notably for back/forward-cache restores and cross-tab broadcast. | §2.4 | Tooling scope. | Recommendation 7. |
| R-16 | **The contract document is out of date.** Deviations from `docs/initial-assessment.md` made in Phase 8 are recorded only in `docs/decisions/phase-8-*.md`; the owner has not yet revised the contract. | Decision hand-overs | Ownership rules. | Recommendation 10. |

### R-1: Phase 9 closure, 2026-10-07

The R-1 row above is the Phase 8 finding as it was written. This note records what Phase 9 shipped
instead and how it was reviewed.

**What shipped.** Phase 9 did not implement the shared limiter. Under the heavy "stress B" load, one API
process missed the 300 ms budget for scans and check-ins, because it runs all its requests in one Python
interpreter (`docs/production-readiness.md` §3.4). The Compose deployment therefore runs four
single-worker API processes of the same image and the same `deploy/env/backend.env`
(`docs/decisions/phase-9-deploy.md` D9-34, D9-35, D9-36):

| Service | Processes | What nginx sends it |
|---|---|---|
| `backend` | exactly one, never replicated | every sign-in, every write (scans and check-ins included), password recovery, every method other than GET, and every request not listed below |
| `backend-reception` | two replicas (`least_conn`) | `GET /api/v1/reception/today` and `GET /api/v1/reception/inside` |
| `backend-reports` | one | `GET /api/v1/reports/summary`, `/api/v1/audit-logs`, `/api/v1/dashboard/admin` and `/api/v1/visits` |

nginx chooses the process with a map on `"$request_method $vms_request_path"`
(`deploy/nginx/templates/vms.conf.template`). `$vms_request_path` is the path exactly as the client sent
it, without the query string. nginx forwards those same bytes, and the API dispatches on them. Only the
six GET requests above, spelled exactly as the API routes them, leave `backend`. This departs from the
required action "run exactly one application process per deployment", so the layout went through an
engineering security review. Two independent reviewers each used a throwaway database, four real
`python -m app.serve` processes and the official nginx 1.30.5 for Windows running the repository's
routing map and proxy snippet. Both returned the verdict **acceptable with conditions**.

**What the review confirmed (each point demonstrated live or by test):**

- **Budgets that guard sign-in and recovery stay single-counted.** The sign-in failure and success
  budgets, lockouts, password-change and recovery budgets, and the e-mail, scan, attendance and
  taken-address budgets are consulted only on POST and PATCH flows. nginx always sends those to
  `backend`, so these budgets are counted once, as before. HEAD and OPTIONS go to `backend` too.
- **The routed reads consult only the per-user API budget.** A recording limiter showed that each of the
  six routed reads makes exactly one limiter call, a `hit` of `api_per_user`, for every role. This held
  for 200, 403, 422 and 429 answers and for background polls (`X-Background-Refresh: 1`). Without a
  session the reads consult no budget, because the 401 comes first. The read processes therefore hold no
  per-address or per-e-mail buckets.
- **Revocation reaches every process.** Sessions are database rows, checked on every request, and roles
  and `is_active` are re-read on every request. A sign-out, a password change, a deactivation and a role
  removal on `backend` were each honoured by both list replicas and by `backend-reports` on the next
  request (401 or 403).
- **Settings and the client address are the same everywhere.** All API services use the same env file.
  Compose overrides only `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE` on the read services. nginx
  overwrites `X-Forwarded-For` in the same way for every pool. A spoofed header was replaced by the real
  peer address in the audit rows that all four processes wrote.
- **The reads' side effects are coordinated in the database.** These are the NO_SHOW marking, the
  session's `last_seen_at` touch and the sweep of interrupted e-mail deliveries. A concurrent burst over
  both list replicas and `backend-reports` marked 12 expired visits exactly once each.

**What changes, and is accepted:**

- **The per-user API budget is counted per process.** Each process counts `RATE_LIMIT_API_PER_MINUTE`
  (600 by default) for the requests it receives. One user can make up to 2,400 API requests a minute in
  all, 1,200 of them on the two list paths. Writes stay at most 600 a minute, because they all reach
  `backend`. With the limit set to 30, one session got 120 answers, 30 from each process. Each process
  is protected as before. But one account, or a stolen session, can now cause about four times the read
  work on the one shared PostgreSQL (2 CPUs in Compose), over up to 50 database connections instead of
  20. The database impact was inferred from the budgets and pool sizes; it was not load-tested.
- **The SEC-15 refusal-row budget is counted per process.** The budget of 10 written `ACCESS_DENIED`
  rows per user and minute, and the coalescing of `RATE_LIMITED`, live in each process. One user can
  cause up to 4 × (10 + 1) = 44 `ACCESS_DENIED` rows a minute and 8 `RATE_LIMITED` rows for the
  per-user API budget, against 11 and 2 with one process. Measured: 150 forbidden GETs within a minute
  wrote 44 rows through the four processes and 11 on one process. In both cases the summaries
  accounted for all 150 events.
- **A restart resets only that process's counters.** A restart of `backend` still resets every budget
  and lockout. A restart of a read process resets only its per-user API counts and its refusal-row
  budgets.

**What the review found wrong, and how it was fixed (D9-36).** nginx used to choose the process from
`$uri`, the normalised path, but it forwarded the raw path. The API resolves no dot segments, so
`GET /api/v1/visitors/../visits` matched the key for `/api/v1/visits` and ran on `backend-reports` as
the route `/api/v1/visitors/{visitor_id}/visits`, after authentication. No budget was affected,
because every GET route consults only `api_per_user`. But the statement that only the six routed reads
leave `backend` was false. The map now uses the raw path. Every percent-encoded, dot-segment or
doubled-slash spelling now runs on `backend`, which counts every budget. A letter-case variant such as
`/api/v1/Reception/today` still reaches a read process, because nginx compares map keys without regard
to case. It matches no route there and gets a 404 before authentication, with no budget consulted.

**Why the trade is acceptable.** The product runs on premises for one organisation, and every API
route except sign-in, recovery and health needs a signed-in staff session. Every budget that guards
authentication, recovery, e-mail, scans and attendance is still counted once, on `backend`. No lockout
or recovery limit can be bypassed through the read processes. What grows is bounded, and only an
authenticated insider can cause it: up to four times the read throughput and about four times the
refusal rows. The API's access log and the audit trail name the user, and no evidence is lost. In
return, heavy reads no longer queue in the interpreter that serves the desk's scans and check-ins. One
process could not prevent that under stress B. With two list processes, every reception p95 stayed
under 300 ms in all 24 stress B runs. The trade is acceptable once the conditions below are met.

**Conditions and their status:**

| # | Condition | Status |
|---|---|---|
| 1 | A backend regression test, with a recording limiter, that the routed reads consult no budget but `api_per_user` for every role and answer, tied to the routing map | **Done.** `backend/tests/integration/test_routed_reads.py` has 61 cases (`docs/decisions/phase-9-backend.md` RT-01, D9-36). `deploy/verify/test_api_instances.py` fails unless the test's `ROUTED_READS` lists exactly the map's keys. The first reviewer asked for every GET route to be tested. That was not added: with the map on the raw path no other route runs on a read process, and the deploy tests keep it so. They check the map's source variable, that every key is canonical, and that no other route matches a routed path in any letter case. |
| 2 | Route on the raw path, or document that other GET routes can run on the read processes | **Done** (D9-36). Verified on nginx 1.30.5 for Windows. Not yet verified in the Linux container or over HTTP/2. |
| 3 | Correct the documentation of the trade, then have it signed off and R-1 and recommendation 5 reworded | **Documentation done:** D9-36, this note, recommendation 5, SEC-15, R-10, `docs/security.md` §9.1 and `deploy/README.md` §4. **Open:** sign-off of these per-process budgets by the deploying organisation's security owner, a go-live item (`docs/production-readiness.md` §15 H). |
| 4 | A compose test that the read services override no setting except `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE` (and `RATE_LIMIT_API_PER_MINUTE`, if lower read budgets are adopted) | **Done** (D9-37, 2026-10-07). `deploy/verify/test_api_instances.py` (`test_the_read_services_share_the_program_and_the_settings_of_the_main_one`) requires the same image, build, command, entrypoint and env file list for all three API services. A read service may set only the keys in `READ_SERVICE_OVERRIDES` (today `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE`), and every other `environment` key must equal the main service's. All 15 mutants failed it, among them a read service setting `SESSION_IDLE_MINUTES`, `COOKIE_SECURE` or `RATE_LIMIT_API_PER_MINUTE`, and `TRUSTED_PROXIES` on `backend` only. Lowering `RATE_LIMIT_API_PER_MINUTE` on the read services now also means adding it to that allow-list. |
| 5 | Keep "exactly one main process" as an operator rule that also covers `docker compose up --scale` and other orchestrators. Alert on unplanned restarts of each API process and on spikes of 429 per API pool and of `ACCESS_DENIED` | **Documented** in recommendation 5 and in `docs/production-readiness.md` §5.3. Connecting the alerts is the operator's task. The deploy test reads the compose file, so it catches `replicas` or `scale` there but not a `--scale` on the command line. |

Recommendation 5 now states the requirement in this form. The shared (Redis) limiter is still the only
way to run more than one main process. It is also the only exact fix for the per-process budgets above.

---

## 7. Recommendations before production

**Must, before any production traffic** (items 1–6; several are Phase 9 gate items already handed over
in the decision files):

1. **TLS end to end.**
   - Terminate TLS at the reverse proxy with a current protocol and cipher configuration, and redirect
     http to https.
   - Keep `COOKIE_SECURE=true` (enforced) and https base URLs and origins (enforced).
   - Connect to PostgreSQL with `sslmode=verify-full` and a pinned root CA (`sslrootcert`); prefer
     `channel_binding=require` where the server supports it. Use `DB_REQUIRE_TLS=false` only for a
     single-host network.
   - Use HTTPS for reception tablets on the LAN too (camera access requires a secure context).
2. **Reverse proxy (nginx) exactly as specified:**
   - Serve the §10 header set identical to `frontend/config/securityHeaders.ts`; `server_tokens off`.
   - Overwrite `X-Forwarded-For $remote_addr`, and set `TRUSTED_PROXIES` to the proxy's own addresses
     only.
   - Set `proxy_set_header X-Request-ID $request_id` and `proxy_set_header Host $host`.
   - Declare an explicit `server_name` with a default server that rejects unknown hosts.
   - Do not forward `Upgrade` or `Connection: upgrade`.
   - Log `$uri`, never `$request` or query strings.
   - Serve `index.html` and every SPA fallback response with `Cache-Control: no-store`; `sw.js` with
     `no-cache`; the wasm as `application/wasm`.
   - Set a request-body limit consistent with the API's 64 KiB.
   - Then re-run the §5.3, §5.7 and §5.8 checks against the deployed stack.
3. **Secrets management.**
   - Generate `SECRET_KEY` with `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
   - Keep `SECRET_KEY`, `RESEND_API_KEY` and both database passwords in a secret manager or vault and
     inject them at run time; never bake them into images, compose files or the repository.
   - Percent-encode reserved characters in database URLs.
   - Document rotation: rotating `SECRET_KEY` ends all device trust and resets limiter keys.
   - Never set `SEED_DEMO_PASSWORD` in production.
4. **Database role separation in production.**
   - The migration and owner role is used only by the migration job and `prune-sessions`, from a
     separate credential.
   - The runtime role is a plain LOGIN role with no attributes, no memberships (predefined roles such as
     `pg_monitor` included), no `role` option and no role defaults. The startup check enforces this; do
     not weaken it.
   - Include `ALTER ROLE <runtime> RESET ALL` (and `… IN DATABASE <db> RESET ALL`) in every credential
     rotation.
   - Run Alembic downgrades only with the API stopped, and keep tested backups (lossy downgrades are
     refused by design).
5. **Single application process** per deployment until a shared limiter exists (R-1). Use a
   restart-on-failure supervisor, and alert on unexpected restarts.

   *Phase 9 closure, 2026-10-07.* Reworded for the shipped four-process layout, which the engineering
   security review accepted with conditions ([R-1 closure note](#r-1-phase-9-closure-2026-10-07)). The
   requirement is now:
   - **Exactly one main application process** (`backend`) per deployment until a shared limiter
     exists. Do not add replicas or workers, do not run `docker compose up --scale backend=N`, and do
     not let an orchestrator service or DNS name resolve to more than one main process: nginx would
     use every address it gets.
   - **Further processes only as the shipped read processes.** They receive only the six routed GET
     reads, matched on the raw path, and those reads consult no budget except the per-user API budget.
     `backend/tests/integration/test_routed_reads.py` and `deploy/verify/test_api_instances.py`
     enforce this.
   - **The same settings in every API process:** one env file. Compose overrides only the Argon2 slots
     and the database pool size on the read services; `deploy/verify/test_api_instances.py` fails on
     any other override (condition 4 of the R-1 note, D9-37).
   - **A restart-on-failure supervisor** (`restart: unless-stopped` in Compose). Alert on unexpected
     restarts of each API process; a restart of `backend` is security-relevant. Also alert on spikes of
     429 per API pool and of `ACCESS_DENIED`.
   - **Sign-off** of the per-process budgets (R-1 note) by the deploying organisation's security owner
     before production traffic.
6. **Monitoring and alerting.**
   - Ship the JSON logs and audit trail to the SIEM.
   - Alert on `AUTH_ACCOUNT_THROTTLED`; overflow summary rows (`overflow: true`); spikes of `CSRF_FAILED`,
     `RATE_LIMITED` and `ACCESS_DENIED{reason: session_ended}`; 503 `SERVICE_BUSY`; FAILED or stuck
     PENDING e-mails; startup refusals; and audit-table growth.
   - Schedule `python -m app.cli prune-sessions`. Monitor `/api/v1/health`.

**Should, before go-live with a bank or government customer:**

7. **Independent penetration test** of the deployed stack (nginx, TLS, containers, real Resend) by a
   third party. It should include Safari/iPadOS and Firefox on reception tablets (R-15) and a load test
   of the Argon2 semaphore and limiter behaviour under concurrency.
8. **Dependency and supply-chain scanning in CI.**
   - Install with `pip install --require-hashes --no-deps -r requirements.txt` and `npm ci`.
   - Run `pip-audit` (with `--require-hashes`), `npm audit --omit=dev` and `npm audit signatures` on every
     build, and fail on new advisories.
   - Enable automated update PRs, re-running `scripts/lock_hashes.py` after any pin change.
   - Scan the container images, and produce an SBOM.
   - Keep the full backend gate (ruff, mypy, pytest including `--committed-first`) and frontend gate
     (typecheck, lint, Vitest, Playwright) mandatory.
9. **Shared-device browser policy** for reception tablets and kiosks (handed to Phase 9
   `docs/security.md`):
   - managed `SavingBrowserHistoryDisabled` and `SyncDisabled`;
   - `RestoreOnStartup` not set to restore the previous session;
   - `ClearBrowsingDataOnExitList` covering history, cookies and session storage;
   - or a guest, kiosk or ephemeral profile, and one profile per person where possible.

   Staff sign out explicitly; the idle timeout is a backstop, not the control.
10. **Revise the contract** (`docs/initial-assessment.md`) to record every Phase 8 deviation listed in
    the hand-overs of `phase-8-backend.md` and `phase-8-frontend.md`: device trust; the success, change
    and refusal budgets; session rotation; the password rules; creator scope; new columns and grants;
    the LOST_PASS rules; single-line names; and the production configuration rules. Correct §8.2's
    `USER_EMAIL_UNAVAILABLE` wording (SEC-05), and decide SEC-05's long-term fix.

**Consider:**

11. **MFA or SSO**, at least for SYSTEM_ADMIN accounts (R-14). This is outside the current contract, but
    commonly expected by bank and government customers.
12. **E-mail sender authentication:** SPF, DKIM and DMARC for the sending domain, so that invitations
    and password notices cannot be convincingly spoofed.
13. **Retention and anonymisation:** define retention periods for visitors, visits, audit logs, sessions
    and reset-token metadata, an archive-and-prune path for `audit_logs` run by the owner role, and the
    visitor anonymisation feature anticipated in §12 (R-10, R-13).
14. **Operator features:** an audited admin "unlock account" and "sign out everywhere" (R-8), and a
    company-level visitor contact address (B24-71).
15. **Housekeeping before the first commit:** delete the stray directory
    `backend/UsersUserAppDataLocalTempclaudeC--Users-Userdff0f53a-1a29-40dd-bed0-ff67f3f213d3scratchpadfix3outbox`.
    It holds 56 development outbox e-mails (invitations with pass links and password-changed notices)
    from a throwaway test database, and it is **not** git-ignored. Confirm that `.env` stays untracked.

---

## 8. Completion Gate 8

> *Gate 8: no critical or high issue may remain unresolved without explicit justification.*

**The gate holds.**

- No finding was confirmed at critical or high severity in any of the three rounds, and none of the
  refuted candidates claimed it.
- All five medium issues are fixed and verified: SEC-01, SEC-07, SEC-02/SEC-14, SEC-30 and SEC-43.
- Of the 49 distinct issues, 47 are fixed with regression tests (each checked by reverting its fix) and
  re-verified in the final regression pass. That pass found no fix that failed.
- The two open items carry explicit justification:
  - **SEC-05** (low, deferred): the root cause is in the binding contract. It is mitigated by a
    per-administrator budget and flagged to the contract owner.
  - **SEC-29** (info, accepted): no code fix is possible. The residual is bounded by the token's single
    use and 30-minute lifetime and is covered by the shared-device policy.

The gate covers the application code. It does not certify the production deployment, which depends on
the Phase 9 artefacts and on recommendations 1–6 above.

---

## Appendix A: Evidence summary

**Final regression verification (after round 3):**

- **Backend:** `ruff check` passes; `ruff format --check` reports 223 files formatted; `mypy` finds no
  issues in 128 source files. `pytest` passed 2,012 tests with 2 skipped (opt-in performance checks) in
  210 s, and `pytest --committed-first` gave the same result in 144 s.
- **Frontend:** `npm run typecheck` and `npm run lint` (oxlint `--deny-warnings`) pass. Vitest passed
  1,125 tests in 100 files, and `npm run build` succeeded. A targeted security subset (auth, URL
  parameters, phone, toast and evacuation tests) passed 127 tests in 10 files. The round-3 frontend
  fixer's gate also ran Playwright: 5 passed and 10 skipped by project, as designed.
- **Re-checks:** every confirmed finding was re-checked. Live probes ran against a fresh throwaway
  database (`regv_8199`, migrated to `0009`, seeded) and an API on port 8199. Production-only checks ran
  in-process, and the remaining findings were checked by inspecting the fix and running its regression
  tests. The results are quoted under "Verification" in §3.2. The database was dropped and the server
  stopped afterwards.

**Test growth through Phase 8:**

| Point | Backend tests passed | Frontend tests |
|---|---:|---:|
| Before Phase 8 | 1,667 | 1,036 |
| After the pre-audit leftovers | 1,724 | 1,077 |
| After round-1 fixes | 1,860 | 1,099 |
| After round-2 fixes | 1,969 | 1,115 |
| After round-3 fixes (final) | 2,012 | 1,125 |

**Mutation checks:** every fix was undone on its own and its regression tests failed. The individual
results are listed in the "Verification" sections of `docs/decisions/phase-8-backend.md` and
`docs/decisions/phase-8-frontend.md`.

**Hygiene of the audit itself:** every lens, verifier and fixer used its own throwaway databases and
ports, dropped and stopped them afterwards, and left `vms` and `vms_e2e` untouched (apart from the
documented dev upgrade to `0008`). No commits were made.

## Appendix B: Decision records

| File | Contents relevant to security |
|---|---|
| `docs/decisions/phase-8-backend.md` | L-BE-1..3; SEC-01–SEC-49 backend fixes, rejected alternatives, residuals, hand-overs to the frontend, Phase 9 and the contract owner |
| `docs/decisions/phase-8-frontend.md` | L-FE-1..38; SEC-20/26/27/28/29/33/41/50/51; the shared-device policy; known limits |
| `docs/decisions/phase-1-backend.md` | B1-01 (audit has no FKs), B1-07/33/55/59 (security-event writer and coalescing), B1-13, B1-16, B1-18 (client IP), B1-29 (production checks), B1-32 (change-password throttle), B1-35, B1-36, B1-66 (limiter caps) |
| `docs/decisions/phase-2-4-backend.md` | B24-13/14 (visitor edit rule and `VISITOR_EXISTS`), B24-16/70 (D-19 and e-mail budgets), B24-71 (Reply-To), B24-72 (out-of-scope reuse) |
| `docs/decisions/phase-5-7-backend.md` | B57-01/70 (name-mismatch refusal), B57-12/13 (scan budget, attendance auditing), B57-60 (no DELETE for the runtime role), B57-63 (host availability) |
| `docs/decisions/phase-9-deploy.md` | Phase 9 closure of R-1: D9-34 and D9-35 (the four-process layout), D9-36 (routing on the raw path; the per-process refusal-row bound) and their verification |
| `docs/decisions/phase-9-backend.md` | RT-01 (the regression test of the routed reads' budgets and writes) |
| `docs/decisions/phase-10-backend.md` | S10-1 to S10-13 (the SMTP provider, its credentials, deadline and error handling, and its review fixes), B10-3/B10-4 (the language preference endpoint, not audited), B10-14 (direction isolation and escaping of e-mail values), B10-18 (the 422 field codes) |

## Appendix C: Functional observations (not security issues)

- A MANAGEMENT+EMPLOYEE user cannot edit a visitor they have just created with `POST /visitors`
  (`can_edit` is false and PATCH gets 403). This follows from SEC-08's `owned_by_creator` rule: their
  read scope is company-wide, so the visitor is not "theirs".

## Appendix D: Phase 10 note (2026-10-08)

Phase 10 named the product (Mawdoo3 Visitors, «زوار موضوع»), made it bilingual (Arabic and English) and
added SMTP delivery. **No independent multi-lens audit like this one covered those changes.** Each
security-relevant change had an adversarial review instead, and every defect a review demonstrated was
fixed with tests that fail without the fix
([`docs/decisions/phase-10-backend.md`](decisions/phase-10-backend.md)).

| Change | Security relevance | Review and status |
|---|---|---|
| `PATCH /api/v1/auth/preferences` (the caller's language) | A new unsafe endpoint, allowed during a forced password change | Covered by the global CSRF and Origin checks; changes only the caller's own row; spends only the per-user API budget; not audited by design (B10-4). Tested for every role, CSRF, Origin and the forced-change state |
| SMTP provider (`EMAIL_PROVIDER=smtp`) | New credentials (`SMTP_PASSWORD`) and a new outbound connection | TLS only, with the certificate verified (`none` refused in production and never with credentials); the password a secret, never logged or echoed. The review found 4 defects (2 medium: an attempt could outlast its deadline; an unchecked EHLO reply. 2 low: several sign-in attempts per message; RFC 2047 encoded words in addresses and the subject), all fixed (S10-10 to S10-13) |
| Bilingual e-mail templates | Names and free text inside sentences of two directions | Values escaped one by one and isolated in their own direction; header values free of every kind of line break (S10-5, B10-14). The review found 2 low defects (direction of values; a seed undoing an administrator's choice), both fixed (B10-14, B10-15) |
| 422 field codes (`details.field_codes`) | More detail in error responses | The parameters are the API's own limits and allowed values, never the rejected input (B10-18) |
| Brand and product name settings | Configured text in subjects, footers and the OpenAPI title | One line of visible text, 1–60 characters; the value is never echoed in a refusal |

What R-1 to R-16 of §6 say is unchanged, except R-16: the contract was revised for Phase 10 (revision 3)
and still lacks the Phase 8 and 9 changes. SMTP adds its own residuals (no idempotency key, App
Passwords instead of OAuth2, no custom CA; `docs/security.md` §19). The Phase 10 gate (2026-10-08)
passed the full backend suite (2,971 tests; 2,974 when re-run after the gap closure), the deploy checks, the nginx smoke test with four
production-mode API processes, `npm audit` (0 vulnerabilities) and `pip-audit` (none known)
([`docs/production-readiness.md`](production-readiness.md) §10.1 and §13.1).
