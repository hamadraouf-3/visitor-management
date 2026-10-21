# Security architecture

This document describes the security controls of Mawdoo3 Visitors («زوار موضوع») **as implemented**:
what each control does, where it lives in the code, how it is configured, and how to check it. It is
written for the customer's IT and security teams and for the engineers who run and extend the system.

| | |
|---|---|
| **Code state** | Database migration head `0015`; backend FastAPI on Python 3.14, PostgreSQL 18; frontend React 19 PWA in Arabic and English |
| **Written** | 2026-10-06 (Phase 9). Updated 2026-10-07 for the engineering security review of the four-process layout and its conditions ([§9.1](#91-design), [§11.3](#113-nginx-proxy-and-tls-behaviour), [§16](#16-production-hardening-checklist)), and for the final release gate ([§17](#17-checking-the-controls), [§18](#18-verification-status)). Updated 2026-10-08 for Phase 10: the language preference endpoint, the SMTP provider and its credentials, the bilingual e-mail content, the 422 field codes and the name settings; and for the host rule (only an administrator invites on behalf of another host, B10-24) and revision `0012`. Updated 2026-10-13 for Phase 12, a company's own identity: uploaded images, the colour, the public identity endpoints and per-company e-mails ([§10.4](#104-a-companys-identity-uploads-the-colour-and-the-public-endpoints-phase-12)) |
| **Findings and residual risks** | [`docs/security-audit.md`](security-audit.md) (Phase 8 audit, 51 findings, with dated Phase 9 and 10 notes), the Phase 9 security sweep in [`docs/decisions/phase-9-backend.md`](decisions/phase-9-backend.md) (SEC-R1 to SEC-R8), the Phase 10 review fixes in [`docs/decisions/phase-10-backend.md`](decisions/phase-10-backend.md) (S10-10 to S10-13, B10-14, B10-15), and the Phase 11 security review of 2026-10-13 (3 medium and 7 low findings, all fixed) in [`docs/decisions/phase-11-backend.md`](decisions/phase-11-backend.md) (B11-34 to B11-50); the decisions of Phase 12 in [`docs/decisions/phase-12-backend.md`](decisions/phase-12-backend.md) (B12-1 to B12-17; not yet reviewed by a second party) |
| **Design contract** | [`docs/initial-assessment.md`](initial-assessment.md) (revision 5; the text below still says revision 3 where it describes the Phase 10 state). Where this document and the contract differ, the implementation and the decision records in [`docs/decisions/`](decisions/) are authoritative (audit residual R-16: revision 3 added the Phase 10 changes, but not yet the Phase 8 and 9 ones) |
| **Operations runbook** | [`deploy/README.md`](../deploy/README.md) (Docker Compose deployment, backups, rotation) |
| **Related** | [`README.md`](../README.md) (configuration reference), [`docs/architecture.md`](architecture.md), [`docs/api.md`](api.md) (endpoints, error codes, cookies) |

**How this document was checked.** Every statement was compared with the code and configuration. The
commands marked **Verified** were run on the build machine (Windows 11, PostgreSQL 18.6 on port 5433)
against a throwaway database migrated to `0010`, which was dropped afterwards. See
[§18](#18-verification-status) for the full list. Docker is not installed on the build machine. The
container deployment (images, Compose, nginx inside a container, TLS to PostgreSQL) is **not verified**
here, and every command that needs Docker is marked as such. The Phase 10 statements were compared with
the code and the Phase 10 decision records; their checks are listed in [§18](#18-verification-status).

---

## Contents

1. [System context and trust boundaries](#1-system-context-and-trust-boundaries)
2. [Threat model summary](#2-threat-model-summary)
3. [Authentication](#3-authentication)
4. [Sessions, cookies, CSRF and Origin checks](#4-sessions-cookies-csrf-and-origin-checks)
5. [Authorization (RBAC)](#5-authorization-rbac)
6. [Tenant isolation](#6-tenant-isolation)
7. [QR visitor pass security](#7-qr-visitor-pass-security)
8. [Audit logging](#8-audit-logging)
9. [Rate limiting and resource limits](#9-rate-limiting-and-resource-limits)
10. [Input and output validation](#10-input-and-output-validation)
11. [Security headers and caching](#11-security-headers-and-caching)
12. [Secrets management](#12-secrets-management)
13. [Logging and PII rules](#13-logging-and-pii-rules)
14. [Data minimisation and retention](#14-data-minimisation-and-retention)
15. [Database role model](#15-database-role-model)
16. [Production hardening checklist](#16-production-hardening-checklist)
17. [Checking the controls](#17-checking-the-controls)
18. [Verification status](#18-verification-status)
19. [Residual risks and known limits](#19-residual-risks-and-known-limits)

---

## 1. System context and trust boundaries

```
 Browser (staff SPA / PWA)          Visitor's phone or e-mail client
   │  HTTPS, same origin                │  opens {QR_BASE_URL}/pass?c=<slug>#<token> (static page; asks only for that company's public identity)
   ▼                                    ▼
 ┌───────────────────────── TB1: Internet / LAN ──────────────────────────────────────────────┐
 │ nginx (frontend container)   TLS 1.2/1.3, security headers, SPA files, /api reverse proxy  │
 │   overwrites X-Forwarded-For and X-Request-ID, drops Upgrade, 64 KiB body limit            │
 └───────────────┬────────────────────────────────────────────────────────────────────────────┘
                 │ TB2: proxy → API (API trusts only TRUSTED_PROXIES for client address / request ID)
 ┌───────────────▼───────────────────────────────────────────────┐        ┌─────────────────────┐
 │ API: python -m app.serve (one uvicorn worker)                 │ TLS    │ Resend or SMTP      │
 │  CSRF/Origin middleware → auth → capability → service scoping │───────▶│ TB4: third party    │
 │  in-memory rate limiter, Argon2id, audit writer               │        └─────────────────────┘
 └───────────────┬───────────────────────────────────────────────┘
                 │ TB3: runtime role vms_app (no DELETE, no DDL, append-only audit)
 ┌───────────────▼───────────────────────────────────────────────┐
 │ PostgreSQL 18   owner role vms_owner (migrations, prune only)  │
 │  triggers: audit_logs_immutable, visits_terminal_immutable     │
 └────────────────────────────────────────────────────────────────┘
```

| Boundary | What crosses it | Controls |
|---|---|---|
| TB1 Browser ↔ nginx | Staff traffic, visitor pass page | TLS, HSTS, CSP and other headers ([§11](#11-security-headers-and-caching)), unknown hosts refused, cookies `__Host-` + Secure |
| TB2 nginx ↔ API | Proxied API calls | Client address and request ID believed only from `TRUSTED_PROXIES`; API refuses catch-all proxy ranges in production ([§9.4](#94-client-ip-and-trusted-proxies)) |
| TB3 API ↔ PostgreSQL | All data | Least-privilege runtime role checked at every production start; TLS with certificate verification required for a remote database ([§15](#15-database-role-model)) |
| TB4 API ↔ e-mail provider | Invitations with pass links, reset links, notices | HTTPS to `api.resend.com` with an API key, or SMTP over STARTTLS or implicit TLS with the server's certificate verified and AUTH credentials ([§12.1](#121-inventory)); rendered bodies never stored ([§14.1](#141-what-is-collected)) |
| E-mail / pass link | Bearer QR token, reset token | Tokens in the URL fragment, 256-bit, hashed at rest, single active pass, time window ([§7](#7-qr-visitor-pass-security)) |

---

## 2. Threat model summary

### 2.1 Assets

| Asset | Why it matters |
|---|---|
| Visitor personal data (names, e-mail addresses, phone numbers, organisations, visit purposes, presence history) | Privacy and regulatory exposure; presence data reveals who was on site and when |
| Staff accounts, especially SYSTEM_ADMIN | Full control of a tenant: users, roles, settings, audit log |
| QR visitor passes | A valid pass at reception leads to a check-in (physical access workflow) |
| Audit trail | Evidence for investigations; must not be altered or deleted |
| The "who is inside" list | Evacuation roll call; must be available and correct |
| Tenant separation | Several companies share one database |
| Secrets | `SECRET_KEY`, database passwords, Resend API key or SMTP password, TLS key |

### 2.2 Threats and the controls that answer them

| # | Threat | Main controls | Residual (see [§19](#19-residual-risks-and-known-limits)) |
|---|---|---|---|
| T1 | Online password guessing, credential stuffing, password spraying | Argon2id; password policy with breached-password list and dictionary rules; layered failure budgets per (IP, e-mail), IP, IPv6 /48 and account; audit rows | Password-only authentication (no MFA/SSO) |
| T2 | Locking a known account out on purpose | Device-trust cookies: browsers that signed in before keep their own budget; a password reset lifts the block | A browser that never signed in stays blocked until a reset |
| T3 | Session theft, fixation, replay after sign-out | Opaque server-side sessions (hash stored), `HttpOnly`/`Secure`/`__Host-` cookies, idle and absolute expiry, rotation on sign-in and password change, revocation on reset and deactivation | Up to 60 s of stale screen on a shared device after the server ends a session |
| T4 | Cross-site request forgery, cross-origin calls | Global middleware: `Sec-Fetch-Site`, Origin allowlist, per-session synchroniser token; `SameSite` cookies; no CORS | — |
| T5 | Cross-site scripting, clickjacking | React escaping, no raw-HTML sinks, strict CSP without inline script, `frame-ancestors 'none'`, Jinja2 autoescape in e-mails | — |
| T6 | Privilege escalation, broken access control | One capability matrix for every route; row-level ownership and scope rules in services; authorization re-checked under a lock for administrative and visit writes | — |
| T7 | Cross-tenant access | `company_id` only from the session; company-scoped repositories; composite `(company_id, id)` foreign keys; identical 404/422 for foreign and unknown IDs | No row-level security for reads |
| T8 | Forged, replayed or shared visitor passes | 256-bit random tokens stored as SHA-256; validity window; revocation on rotation, cancellation, completion and e-mail change; scan budget; "Verify ID" cue | A pass is a bearer token and proves an invitation, not identity |
| T9 | Account and data enumeration | Uniform login and forgot-password responses; one Argon2 verification on every path; identical answers for foreign IDs and invalid passes | SEC-05: an administrator can learn that an address has an account in another tenant (budgeted) |
| T10 | Tampering with or erasing the audit trail | Runtime role has `SELECT` + column-level `INSERT` only; statement trigger blocks `UPDATE`/`DELETE`/`TRUNCATE` for every role; failures audited in their own transaction | The schema owner can disable the trigger (it owns the table) |
| T11 | Injection (SQL, e-mail header, log, template) | ORM with bound parameters, escaped `LIKE`, header sanitising, inert log formatting, Jinja2 autoescape with `StrictUndefined` and no `safe` filter | — |
| T12 | Denial of service and resource exhaustion | Body limit, rate limits, bounded Argon2 concurrency, database timeouts, bounded limiter memory, audit-row budgets | No volumetric DDoS protection in nginx (by design); in-memory limiter is per process |
| T13 | Leaked runtime database credential, SQL injection impact | Runtime role cannot delete, run DDL, create temporary objects, change audit rows or switch roles; production refuses to start with anything more | — |
| T14 | Network interception | TLS at nginx; HSTS; production requires `sslmode=verify-full`/`verify-ca` for a remote database | TLS to PostgreSQL not verified on the build machine |
| T15 | Spoofed client address or request ID | `X-Forwarded-For` and `X-Request-ID` honoured only from `TRUSTED_PROXIES`; nginx overwrites both | — |
| T16 | Secrets or PII leaking through logs, URLs, caches or shared devices | No query strings in logs; sensitive keys redacted; tokens in URL fragments; `Referrer-Policy: no-referrer`; `Cache-Control: no-store`; SPA session hygiene | Browser history on shared devices needs a managed browser policy |
| T17 | Unsafe production configuration | The API refuses to start with weak or published secrets, http origins, insecure cookies, disabled limits, unverified database TLS, or an over-privileged database role | Some values (session lifetimes, throughput budgets) are policy, not refused |
| T18 | Supply-chain compromise | Hash-pinned Python lock files installed with `--require-hashes`; npm lockfile integrity; digest-pinned base images; all browser assets self-hosted | Image scanning and SBOM are CI recommendations, not implemented here |
| T19 | A hostile file uploaded as a company's logo: a polyglot (PNG + HTML, script or ZIP), a decompression bomb, a parser exploit, stored XSS through an image, hidden data in metadata (Phase 12) | Only the platform owner uploads; PNG only; checked and **written again** by the server in pure Python (no image library, no native decoder); size judged on the header before anything is inflated, inflation bounded to the image's own size; nothing after the image's end; served as `image/png` with `nosniff` and a sandboxing policy ([§10.4](#104-a-companys-identity-uploads-the-colour-and-the-public-endpoints-phase-12)) | Pixels are not decoded: what an image shows is the platform owner's responsibility |
| T20 | Abuse of the endpoints that need no session (Phase 12): going through company names, reading more than an identity, poisoning a cache, loading the server | Active companies only and one 404 for everything else; only name, language and brand; a budget per client address and IPv6 /48 on every request; caching rules set by the API alone, an image's version in its address, no `Vary`, errors never stored | Whether a slug names an active company is public by design |
| T21 | A company impersonating another sender, or injecting through its name or colour into e-mails and pages (Phase 12) | The colour is exactly `#rrggbb` (a CHECK in the database too); names are escaped in HTML and stripped of everything that could end a display name, carry an address or start an encoded word; the sender's address is always the deployment's | A company's name is shown as the sender's name as it is ("Your Bank") |

### 2.3 Assumptions and out of scope

- The Docker host, its operating system, the container runtime and physical access to servers are secured by
  the operator.
- Reception staff verify the identity of the person presenting a pass. The product shows the cue
  ("Verify ID: &lt;name&gt;") but cannot check identity itself.
- Volumetric DDoS protection comes from the network in front of nginx. nginx deliberately has no per-IP
  rate limit, because branch offices behind one NAT address would be throttled together
  (`phase-9-deploy.md` D9-17).
- The e-mail provider (Resend, or the SMTP server and whatever relays it uses) and the recipients'
  mailboxes are outside the system. Anyone who can read
  an invitation can use its pass, and anyone who can read a reset e-mail can reset the password.
- No file uploads exist (audit §5.14).

---

## 3. Authentication

Staff sign in with an e-mail address and a password. There is no MFA or SSO in the current product
(audit residual R-14). Visitors never sign in.

### 3.1 Password storage

Source: `backend/app/security/passwords.py`.

| Parameter | Value |
|---|---|
| Algorithm | Argon2id (`argon2-cffi`, `Type.ID`) |
| `time_cost` | 3 |
| `memory_cost` | 65,536 KiB (64 MiB) |
| `parallelism` | 4 |
| Hash length / salt length | 32 bytes / 16 bytes |
| Normalisation | NFKC before hashing, verifying and policy checks |
| Re-hash | `check_needs_rehash` on every successful sign-in; an outdated hash is replaced |
| Concurrency | Process-wide semaphore of `PASSWORD_HASH_CONCURRENCY` slots (default: CPU count; the Compose template sets 4 to fit the 1 GiB memory limit). A request waits at most 2 s for a slot, then gets `503 SERVICE_BUSY` (not counted as a failure) |
| Input bounds | New passwords 12–128 characters; a sign-in password longer than 1,024 characters is refused with 422 before any hashing |

### 3.2 Password policy

Applied by every writer of a password: an administrator's temporary password, change-password, reset,
and `python -m app.cli create-admin`. A refused password answers `422 VALIDATION_ERROR` on the field.

1. 12 to 128 characters (after NFKC normalisation).
2. Not equal to the account's e-mail address.
3. Not on the embedded breached-password list (`app/security/common_passwords.txt`, 1,305 entries: the
   project's own list plus every 12–128 character entry of the NCSC top-100,000 Pwned Passwords list).
4. Not built from a common word (`app/security/common_words.txt` plus the letters of every breached
   entry) with digits, a year or symbols added. Common substitutions are undone first (`0→o`, `1/!→i`
   or `l`, `3→e`, `4/@→a`, `5/$→s`, `7/+→t`, …). At least four other letters must remain.
5. Not built from the account's own words in the same way: the e-mail local part and domain labels, the
   full name, and the company name and slug.

Examples refused: `Welcome@2026`, `Spring2026!!`, `JaneDoe@2026` (for Jane Doe). The development seed's
published demo password is checked with rules 1–3 only; seeding is refused in production.

### 3.3 Sign-in flow

Source: `AuthService.login` in `backend/app/services/auth.py`.

1. The e-mail address is normalised (strip, NFKC, lowercase). It is never validated at sign-in: unusual
   input simply fails.
2. The client's budgets are reserved before any database work: per (IP, e-mail), per IP, and per IPv6
   /48 ([§9](#9-rate-limiting-and-resource-limits)). A spent budget answers `429 RATE_LIMITED` with
   `Retry-After`.
3. The account is looked up. Then the account's failure budget is reserved (or the device's budget, see
   [§3.5](#35-device-trust)), together with the account's success budget. Unknown addresses get an
   identical failure budget keyed by the typed address, so a lockout reveals nothing.
4. **Exactly one Argon2 verification runs on every path.** For an unknown address it runs against a
   dummy hash made by the same hasher (timing parity; measured in the audit, §5.1).
5. Inactive accounts and expired temporary passwords fail after the verification. So does, in
   production, a demo account of the seeds ([§12.3](#123-production-configuration-refusals), B11-36).
6. On success the user row is locked (`FOR NO KEY UPDATE`) and the stored hash must still be the one that
   was verified. A password change or reset that committed in the meantime defeats the sign-in
   (`credentials_changed`).
7. A still-valid session cookie presented by the same browser is revoked, a new session is created, the
   cookies are set, and `AUTH_LOGIN_SUCCEEDED` is audited in the same transaction.

Every failure answers `401 INVALID_CREDENTIALS` "Invalid email or password." Failures are audited as
`AUTH_LOGIN_FAILED` with `metadata.reason` ∈ `bad_password`, `inactive`, `password_expired`,
`credentials_changed`, `unknown_account`, `seed_account`, `company_inactive`. For an unknown address the
row has no company, no actor and no identifier.

**One refusal has an answer of its own** (Phase 11 review, B11-46). When the password verified, the account
is active and its password current, and the only obstacle is that the platform owner deactivated the
company, the sign-in answers `409 COMPANY_INACTIVE` "This company is deactivated." instead of telling a
person that their correct password is wrong. This is not an enumeration channel: the answer is reachable
with valid credentials only. A wrong password and an unknown address get the 401 above after the same
single verification, an inactive account or an expired temporary password in a deactivated company gets it
too, and forgot-password stays silent. The refusal is audited (`reason = "company_inactive"`) and is not a
failed attempt: its failure slots are given back, so retrying while a company is deactivated locks nobody
out after the reactivation. Wrong passwords still count, and a locked account answers 429 before any
hashing whatever the company's state. The verified refusal takes a slot of the account's successful
sign-ins instead (30 per 15 minutes), which bounds what a credential holder can make the server verify and
write.

**Verified:** five wrong passwords for one account answered 401, the sixth `429` with
`Retry-After: 300`; an unknown address answered the same 401 body; the audit rows carried only
`reason` (and `unknown_account` had no company or actor).

### 3.4 Authentication-related budgets

| Event | Default budget | Effect when spent |
|---|---|---|
| Failed sign-ins per (client IP, e-mail) | 5 per 5 min | 429 |
| Failed sign-ins per client IP (IPv4 address or IPv6 /64) | 30 per 5 min (failures only, so office NAT is fine) | 429 |
| Failed sign-ins per IPv6 /48 | 300 per 5 min | 429 |
| Failed sign-ins per account (untrusted browsers) | 10 per 15 min, then the account is blocked for 15 min | 429 "Too many attempts. Try again later.", audited `AUTH_ACCOUNT_THROTTLED` once |
| Failed sign-ins per trusted browser and account | same numbers, blocks only that browser | as above, `policy: login_failures_device` |
| Successful sign-ins per account | 30 per 15 min | 429 before any hashing |
| Wrong current password on change-password | 5 per 15 min per user; the attempt that reaches the limit **also ends the session** | 429 afterwards |
| Successful password changes | 5 per hour per account | 429 before any hashing; a reset still works |
| Forgot-password per existing account / per IP / per /48 | 3 / 10 / 100 per 15 min | Silently dropped (the answer is always the same 202) |
| Reset-password attempts per IP / per /48 | 20 / 200 per 15 min | 429 before the token lookup |
| "Password changed" notices per account | 5 per hour (fixed) | Change still made; only the e-mail is left out |

All values except the last are settings ([§9.2](#92-budgets-and-their-settings)).

### 3.5 Device trust

Source: `backend/app/security/device_trust.py` (findings SEC-01, SEC-30).

A per-account lockout on its own would let anyone keep a known account (an administrator, the shared
reception account) locked indefinitely. Following OWASP's "device cookies" pattern, the account block
applies only to browsers that have not proven the password before.

- A successful sign-in, a completed password reset and a successful password change set
  `__Host-vms_device` (HttpOnly, Secure, SameSite=Strict, Path=/, 90 days). It is kept across sign-out.
  One cookie holds up to five accounts (a shared desk), newest first.
- Each entry is `<user id>.<issued at>.<epoch>.<nonce>.<MAC>`. The MAC is HMAC-SHA256 truncated to
  128 bits, with a key derived from `SECRET_KEY` and a version label. The cookie is stateless.
- An entry is trusted only while its epoch equals the account's `users.device_trust_epoch`. A password
  change, a password reset and a deactivation set a new random 63-bit epoch. This ends the trust of every
  browser that signed in before, including any a former holder of the password collected.
- A trusted browser is judged by its own failure budget (`login_failures_device`, same numbers as the
  account's). Every other client is judged by the account's budget.
- Forged, foreign, expired and oversized cookies (over 1,024 characters) earn nothing.
- Rotating `SECRET_KEY` ends every device's trust.

### 3.6 Temporary passwords, change and reset

| Flow | Behaviour |
|---|---|
| Admin-created user | Temporary password (policy applies, including the new user's name and company), valid **72 h**, `must_change_password = true`. Until changed, every endpoint except `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout` and `PATCH /auth/preferences` (the language, so the forced-change screen can switch it) answers `403 PASSWORD_CHANGE_REQUIRED` |
| Change password (`POST /auth/change-password`) | Policy checked before any hashing; current password verified; compare-and-swap under the user-row lock; **every session of the user is revoked, including the current one, and a new session and CSRF token are issued** on the 204; unused reset tokens invalidated; new device-trust epoch; "your password was changed" e-mail |
| Forgot password (`POST /auth/forgot-password`) | Always `202` with an identical body. The account lookup, token and e-mail run in a background task. The e-mail goes to the stored address, never the typed string |
| Reset token | 256-bit `secrets.token_urlsafe(32)`, stored as SHA-256, valid **30 min**, link `{APP_BASE_URL}/reset-password?c=<slug>#token=<raw>` (the token in the fragment: never sent to a server, kept out of logs and `Referer`; the query names only the account's company, since Phase 12). Issuing a new token invalidates older ones. Consumption is one atomic `UPDATE … RETURNING`. Invalidation is terminal (`invalidated_at`), so a clock step back cannot revive a token |
| Reset password (`POST /auth/reset-password`) | Policy checked **before** the token is consumed (a weak choice does not burn the link); all sessions revoked; unused tokens invalidated; account block lifted; new device-trust epoch; the resetting browser receives a device cookie; notice e-mail |
| Deactivation | All sessions and unused reset tokens revoked; new device-trust epoch; the user's SCHEDULED hosted visits are cancelled and the visitors notified (D-18) |

**Verified:** `create-admin --password-stdin` refused `Welcome@2026` with the "common word" message
(exit 2) and accepted a passphrase.

### 3.7 The platform owner (Phase 11)

The platform owner manages companies and is the most privileged account of a deployment. It is a
separate principal (`platform_admins`, `platform_sessions`; not a user of any company, B11-1) held to the
same bar as a company's sign-in (B11-7):

| Control | Platform owner |
|---|---|
| Creation | Only `python -m app.cli create-platform-admin` (or the non-production seeds, whose account never serves production: [§12.3](#123-production-configuration-refusals)): no self-registration, no API. The temporary password is generated (32 random characters, printed once) or read from stdin, must be changed at the first sign-in and expires after 72 h. `--reset` issues a new temporary password and ends every session and device trust; it changes nothing else (`--full-name` with it is refused) |
| Password storage and policy | Argon2id as [§3.1](#31-password-storage); the policy of [§3.2](#32-password-policy) with the account's name and the words "platform" and "admin" as personal material |
| Sign-in | `POST /api/v1/platform/auth/login`: budgets reserved before hashing (per address and typed e-mail; per address and /48 **shared with the companies' sign-in**; per account with a 15-minute lockout or the trusted device's own budget; successful sign-ins), one Argon2id verification on every path, one `401 INVALID_CREDENTIALS`, the row re-checked under its lock before the session is created |
| Session | Own cookies (`__Host-vms_platform_session`, `__Host-vms_platform_csrf`, `__Host-vms_platform_device`), shorter lifetimes (8 h absolute, 30 min idle; production refuses more than 12 h / 60 min), own CSRF token; a company session is never accepted on `/api/v1/platform` and a platform session never on a company endpoint |
| Password change | As [§3.6](#36-temporary-passwords-change-and-reset): every session revoked and a new one issued, new device-trust epoch, failure and success budgets |
| Recovery | No forgot-password: an operator runs `create-platform-admin --reset` (a mailbox is not a recovery path for this account). It works while strangers keep the account locked (below, B11-35). No "password changed" e-mail (B11-8) |
| Writes | Each re-checks the caller once it holds the company's row: a request whose session ended while it waited writes nothing ([§4.4](#44-revocation), B11-38) |
| Transparency | A company's other administrators are e-mailed when the platform owner adds an administrator to their company or sends one a reset link ([§6.4](#64-the-platform-owner), B11-43); a company's audit rows of platform actions carry no network address or browser of the platform owner (B11-37) |
| Audit | Its own append-only trail `platform_audit_logs` ([§8.7](#87-the-platform-owners-trail)) |
| Reach | Companies, two counts per company and each company's administrators; never visitors, visits, departments, other users or company audit rows ([§6.4](#64-the-platform-owner)) |

**A locked platform account and its recovery** (Phase 11 review, B11-35). Anyone who knows a platform
account's address can spend its sign-in budget: ten failures, then every browser that is not trusted gets
429 for fifteen minutes, and from several addresses the budget is spent again at once. A browser that
signed in before is not affected (its device cookie, [§3.5](#35-device-trust)). For everything else the
operator's reset is the recovery, and it is built to work under that attack:

- The account's failure budget and the budget of wrong current passwords are counted per account **and
  password** (the key carries the account's device-trust epoch, which a reset and every change renew). A
  reset therefore starts them afresh, although the reset runs in another process than the limiter.
- A temporary password that the command **generates** has a failure budget of its own. It is 32 random
  characters; a SHA-256 tag of the first 12 (with the account's ID) is stored beside the Argon2id hash of
  all 32. A sign-in whose password starts with those 12 characters is judged by that budget (ten failures,
  then fifteen minutes) instead of the account's, so its holder signs in from any browser whatever
  strangers do. Nothing gets easier for a stranger: without the 12 characters an attempt is on the
  account's budget, with them it has ten guesses at the other 20, and the tag says nothing about those 20
  (about 122 bits), which only Argon2id covers. The tag is removed by the forced change and is not honoured
  after the password's 72 hours.
- The change that completes the temporary password is outside the hourly budget of changes.

*Operator procedure for an account that cannot sign in* (lost password, or locked from outside):

1. On the server: `python -m app.cli create-platform-admin --email <address> --reset` (Compose:
   `docker compose exec backend python -m app.cli …`). Do not add `--password-stdin`: only a generated
   password has the budget of its own.
2. Hand the printed password to the owner over a channel you trust. It is shown once, valid 72 hours.
3. The owner signs in at `/platform/login` with it, from any browser, and chooses a new password at once.
   That browser is trusted from then on.
4. If the account stays under attack, the alert on platform `AUTH_ACCOUNT_THROTTLED` rows
   ([§16](#16-production-hardening-checklist) item 23) shows it; the trusted browser keeps working.

*Residual:* a temporary password typed by the operator (`--password-stdin`) has no budget of its own, so
strangers can lock it out again; and an owner who has no trusted browser left needs another reset.

---

## 4. Sessions, cookies, CSRF and Origin checks

### 4.1 Session model

Source: `backend/app/security/sessions.py`, `backend/app/repositories/sessions.py`.

- Sessions are server-side rows in `user_sessions`. The browser holds an opaque 256-bit token; only its
  SHA-256 is stored. Malformed tokens are rejected before hashing.
- A session is live while it is not revoked, before its absolute expiry (`SESSION_MAX_AGE_HOURS`,
  default **12 h**), used within the idle timeout (`SESSION_IDLE_MINUTES`, default **240 min**), and its
  user is active. All four are checked in one query on every request.
- `last_seen_at` is written at most once a minute, and never for requests that carry
  `X-Background-Refresh: 1` (the reception screens' 15-second polling), so the idle timeout still works
  on a shared tablet that nobody touches. The platform owner's session follows the same rule (B11-34: its
  manager used to count the pages' one-minute heartbeat as activity, so an open platform tab never timed
  out); both dependencies read the header through one function.
- Roles are read from the user row on every request, so a role removal applies to the next request.

### 4.2 Cookies

Source: `backend/app/api/cookies.py`. With `COOKIE_SECURE=true` (the default; production refuses
`false`):

| Cookie | Attributes | Purpose |
|---|---|---|
| `__Host-vms_session` | HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200 (= session lifetime); no Domain | Session token |
| `__Host-vms_csrf` | Secure; SameSite=Strict; Path=/; Max-Age=43200; **readable by script** | CSRF token the SPA copies into `X-CSRF-Token` |
| `__Host-vms_device` | HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=7776000 (90 days) | Device trust ([§3.5](#35-device-trust)) |

With `COOKIE_SECURE=false` (plain-http local development only) the names are `vms_session`, `vms_csrf`
and `vms_device` without `Secure`. **Verified** live: the three `Set-Cookie` headers above on a
successful sign-in.

### 4.3 CSRF and Origin enforcement

Source: `CsrfOriginMiddleware` in `backend/app/core/middleware.py`, `backend/app/security/csrf.py`.

A global ASGI middleware (not per route) checks every unsafe request (`POST`, `PUT`, `PATCH`, `DELETE`)
under `/api/v1`. Path decisions use the router's path (`route_path`), so a deployment under a
`root_path` cannot route around them.

| Check | Rule | Failure |
|---|---|---|
| (a) Fetch metadata | `Sec-Fetch-Site: cross-site` is refused; `same-site` is accepted only with an allowed Origin | `403 CSRF_FAILED` |
| (b) Origin | If an `Origin` header is present it must be in `ALLOWED_ORIGINS` (exact, normalised; `*` is rejected at startup; `Origin: null` is refused) | `403 CSRF_FAILED` |
| (c) Token | A request carrying a live session must send `X-CSRF-Token` matching that session's stored CSRF hash (`hmac.compare_digest`). It is a per-session synchroniser token, not double-submit, so overwriting the CSRF cookie gains nothing | `403 CSRF_FAILED` |

Only `POST /auth/login`, `/auth/forgot-password` and `/auth/reset-password` are exempt from (c); (a) and
(b) still apply to them. `PATCH /auth/preferences` (Phase 10) is not exempt: a language change needs the
token like any other unsafe request (403 `CSRF_FAILED` without it, verified in the Phase 10 live check
and by `tests/integration/test_preferences_api.py`). There is no `CORSMiddleware`: the SPA and the API
share one origin, a preflight gets `405` without `Access-Control-*` headers. JSON bodies are required, so
a cross-site form or `text/plain` post to the sign-in endpoint gets `422` (login CSRF through simple
requests is not possible). Every failure is audited as `CSRF_FAILED` with `reason` ∈ `cross_site`,
`origin_not_allowed`, `token_mismatch`, attributed to the session's user when a live session cookie was
sent. If the session lookup cannot reach the database, the middleware answers `503 SERVICE_BUSY`.

**Verified** live (authenticated `POST /departments`): no token, wrong token, foreign Origin,
`Sec-Fetch-Site: cross-site` and `Origin: null` each answered 403; the correct token with an allowed
Origin answered 201; `text/plain` sign-in 422; `OPTIONS` preflight 405 with no `Access-Control-*`
header; logout without the token 403.

### 4.4 Revocation

| Event | Sessions | Reset tokens | Device trust |
|---|---|---|---|
| Sign-out | This session (cookies cleared; a replayed cookie gets 401) | — | Kept |
| Sign-in on a browser with a live session | That browser's previous session | — | Entry refreshed |
| Password change | **All**, including the current one; a new session is issued to the changing browser | All unused | New epoch; changing browser re-trusted |
| Password reset | All | All unused | New epoch; resetting browser trusted |
| Deactivation | All | All unused | New epoch |
| Role removed | Session kept; the next request is authorized with the new roles | — | — |
| Reactivation | Old sessions are not revived | — | — |

Administrative writes and every visit or visitor write re-check, **after taking the company row lock**,
that the caller's session is still live, the account still active and the roles still held
(`services/authorization.py`, SEC-07/SEC-31). A deactivation or demotion holds that lock until it commits,
so an in-flight request of the revoked user waits and is then refused (401 or 403, nothing written).
Every connection runs `READ COMMITTED` whatever the database default, which these re-checks rely on
(SEC-37).

**Emergency: end every session.** The product has no "sign out everyone" endpoint (audit R-8). In an
incident, the schema owner can revoke all live sessions directly. This is not audited by the
application: record it in your change log. **Verified** (a signed-in session answered 401 afterwards):

```sql
UPDATE user_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND expires_at > now();
```

The platform owner's sessions are revoked the same way in `platform_sessions`; deactivating a company
(`POST /api/v1/platform/companies/{id}/deactivate`) revokes every session of its users and invalidates
their unused reset links in one transaction (B11-10). A reset link requested while that transaction is
under way cannot outlive it: the issuer takes the company row `FOR KEY SHARE` first, so it either waits
and finds the company deactivated or makes the deactivation wait and be the one that invalidates the new
link (B11-39).

**Platform writes re-check their caller too** (B11-38). Each of the platform owner's writes, once it holds
the company's row (a creation: after it hashed the temporary password), requires its session to be live
and its account active and not under a forced change; otherwise 401 or 403 and nothing written. No company
lock serialises the end of a platform session with such a write, so the re-check holds the session row
`FOR SHARE` until the write commits: a sign-out, a password change or the operator's reset then waits for
the write, or the write waits for it and finds the session revoked.

---

## 5. Authorization (RBAC)

### 5.1 Model

- Four roles: `SYSTEM_ADMIN`, `EMPLOYEE`, `RECEPTIONIST`, `MANAGEMENT`. A user holds a **set** of roles
  (at least one; database CHECK). A capability is granted when **any** role grants it (D-04).
- Routes name exactly one **capability** through `require_capability(...)`; neither routes nor services
  list roles. The single source of truth is `CAPABILITY_ROLES` in
  `backend/app/security/permissions.py`, checked cell by cell by `tests/unit/test_permissions.py`.
- Row-level rules (visit ownership, the EMPLOYEE visitor scope, the visitor edit rule) are applied by the
  services on top of the route capability.
- A missing capability answers `403 FORBIDDEN` and is audited as `ACCESS_DENIED` with the route template.
  The capability check runs before any lookup, so a 403 never reveals whether an ID exists.

### 5.2 Capability matrix (from `CAPABILITY_ROLES`)

| Capability | SYSTEM_ADMIN | EMPLOYEE | RECEPTIONIST | MANAGEMENT |
|---|:-:|:-:|:-:|:-:|
| `OWN_PROFILE` (own profile, change own password) | ✓ | ✓ | ✓ | ✓ |
| `READ_DIRECTORY` (host directory, active departments, company settings read) | ✓ | ✓ | ✓ | ✓ |
| `READ_VISITS` (list and read visits) | ✓ | ✓ owned only | ✓ | ✓ |
| `READ_ALL_VISITS` (the unnarrowed scope of `READ_VISITS`) | ✓ | – | ✓ | ✓ |
| `CREATE_VISIT` (with the caller as the host) | ✓ | ✓ | – | – |
| `INVITE_FOR_ANY_HOST` (`POST /visits` naming another host; B10-24) | ✓ | – | – | – |
| `MANAGE_OWN_VISITS` (update, cancel, resend invitation, reissue pass of SCHEDULED visits it owns) | ✓ | ✓ | – | – |
| `MANAGE_ALL_VISITS` (the same for any visit) | ✓ | – | – | – |
| `READ_VISITORS` (search, profile, history) | ✓ | ✓ own scope | ✓ | ✓ |
| `READ_ALL_VISITORS` | ✓ | – | ✓ | ✓ |
| `CREATE_VISITOR` | ✓ | ✓ | ✓ | – |
| `EDIT_VISITOR` | ✓ | ✓ ownership rule | ✓ | – |
| `EDIT_ANY_VISITOR` | ✓ | – | ✓ | – |
| `RECEPTION` (scan, check-in/out, bulk stale check-out, today, walk-in) | ✓ | – | ✓ | – |
| `VIEW_INSIDE` (evacuation list) | ✓ | – | ✓ | ✓ |
| `VIEW_HISTORY` (company-wide history) ¹ | ✓ | – | ✓ | ✓ |
| `EMPLOYEE_DASHBOARD` | ✓ | ✓ | – | – |
| `ADMIN_DASHBOARD` | ✓ | – | – | – |
| `VIEW_REPORTS` | ✓ | – | – | ✓ |
| `ADMINISTER` (users, departments, company settings write) | ✓ | – | – | – |
| `READ_AUDIT` (audit log) | ✓ | – | – | – |

¹ `VIEW_HISTORY` is defined with the same roles as `READ_ALL_VISITS`, but no route names it. The
company-wide history page reads `GET /visits`, whose unnarrowed scope is `READ_ALL_VISITS`.

MANAGEMENT is read-only: it holds no write capability. A user with MANAGEMENT and EMPLOYEE (for example
the seeded `manager@demo.local`) reads company-wide and may also create and manage visits it owns.

### 5.3 Endpoint map

| Endpoints (`/api/v1`) | Capability / access |
|---|---|
| `GET /health` | Public (no data beyond database status) |
| `POST /auth/login`, `/auth/forgot-password`, `/auth/reset-password` | Public (CSRF-token exempt; Origin checks apply) |
| `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout`, `PATCH /auth/preferences` | Any signed-in user, **including** one who must change the password. The preference changes only the caller's own row |
| `GET /company/settings`, `GET /departments`, `GET /users/hosts` | Any signed-in user (`?include_inactive=true` on departments needs `ADMINISTER`, else 403) |
| `PATCH /company/settings`; `POST /departments`, `PATCH /departments/{id}`; `GET`/`POST /users`, `GET`/`PATCH /users/{id}` | `ADMINISTER` |
| `GET /visits`, `GET /visits/{id}` | `READ_VISITS` (EMPLOYEE-only callers forced to owned visits) |
| `POST /visits` | `CREATE_VISIT` |
| `PATCH /visits/{id}`, `POST /visits/{id}/cancel`, `/invitation`, `/pass` | `MANAGE_OWN_VISITS` + ownership in the service (`MANAGE_ALL_VISITS` skips it) |
| `POST /visits/{id}/check-in`, `/check-out`; `POST /reception/scan`, `GET /reception/today`, `POST /reception/check-out-stale`, `POST /reception/walk-ins` | `RECEPTION` (walk-ins also need the company's `allow_walk_ins`) |
| `GET /reception/inside` | `VIEW_INSIDE` |
| `GET /visitors`, `GET /visitors/{id}`, `GET /visitors/{id}/visits` | `READ_VISITORS` (EMPLOYEE-only callers scoped) |
| `POST /visitors` | `CREATE_VISITOR` |
| `PATCH /visitors/{id}` | `EDIT_VISITOR` + the edit rule (`EDIT_ANY_VISITOR` skips it) |
| `GET /dashboard/employee` / `GET /dashboard/admin` | `EMPLOYEE_DASHBOARD` / `ADMIN_DASHBOARD` |
| `GET /reports/summary` | `VIEW_REPORTS` |
| `GET /audit-logs` | `READ_AUDIT` |

The API documentation endpoints (`/docs`, `/openapi.json`) exist only outside production; `/redoc` is
never served. **Verified** in-process with a production configuration: all three answer `404`.

### 5.4 Row-level rules

Sources: `backend/app/security/permissions.py`, `backend/app/repositories/scope.py`,
`backend/app/services/visit_rules.py`, `backend/app/services/visitors.py`.

- **Visit owner** = holds EMPLOYEE or SYSTEM_ADMIN **and** is the visit's host or creator. A walk-in
  belongs to its host only (reception registers it on the host's behalf; SEC-08).
- **EMPLOYEE-only read scope** (EMPLOYEE without any company-wide role): visits it owns; visitors it
  created while its own scope was limited (`visitors.owned_by_creator`), or linked to a visit it owns,
  except links made by reusing an out-of-scope visitor through the invitation form
  (`visits.visitor_link_in_scope = false`). Filters such as `scope=all` or `host_id` are intersected with
  this scope, never widened. An out-of-scope `visitor_id` in a body is a 422 field error.
- **Visitor edit rule** for callers without `EDIT_ANY_VISITOR` (EMPLOYEE, also when combined with
  MANAGEMENT): the visitor must be in the caller's own scope as an owner (created by it while its scope
  was limited, or linked to a visit it owns), and no visit of that visitor may belong to another owner.
- **`409 VISITOR_EXISTS`** returns the existing visitor's ID only to callers who read every visitor.
- **Hosts** = active users holding EMPLOYEE or SYSTEM_ADMIN.
- **Self-modification and last administrator**: an administrator cannot remove its own SYSTEM_ADMIN role
  or change its own activity (`409 SELF_MODIFICATION`); the last active SYSTEM_ADMIN of a company cannot
  be demoted or deactivated (`409 LAST_ADMIN`). Both are decided under `SELECT … FOR UPDATE` on the
  company row.
- **Mass assignment**: every request model forbids unknown fields (`extra="forbid"`), so fields such as
  `company_id`, `status`, `must_change_password` or `created_by_id` in a body answer 422.

### 5.5 Frontend guards

`frontend/src/auth/roles.ts` (`SECTION_ACCESS`) hides navigation and guards routes per role. This is
**cosmetic**; every permission is enforced by the API. The audit crawled the UI per role and found no
request the server refused (audit §5.4).

**Verified** live (spot check): RECEPTIONIST got 403 on `/audit-logs`, `/reports/summary`, `/users`,
`/dashboard/admin`, `/dashboard/employee` and 200 on `/reception/today`, `/reception/inside`;
MANAGEMENT got 200 on `/reports/summary` and `/reception/inside` and 403 on `/reception/today`; EMPLOYEE
got 403 on every reception, report and admin route; an EMPLOYEE calling `POST /reception/scan` got 403.

---

## 6. Tenant isolation

Each company is a tenant. Isolation has two layers.

### 6.1 Application scoping

- The tenant (`company_id`) comes **only** from the authenticated session (`AuthContext.company_id`).
  No endpoint accepts a company ID from the client.
- Every repository method takes `company_id`. A unit test fails if a repository method outside a short
  documented allow-list has no `company_id` parameter.
- Every ID in a path, body or filter is resolved through a company-scoped repository:
  - an unknown or foreign ID **in the path** answers `404 NOT_FOUND`, identical to an unknown ID;
  - an unknown or foreign ID **in a body or filter** answers `422 VALIDATION_ERROR` on that field, with
    the same "does not exist" text as a random UUID;
  - malformed path IDs answer 404.
- Visit locks (`SELECT … FOR UPDATE`) are scoped by `id` **and** `company_id`.
- Pass lookups filter by token hash **and** `company_id`; another tenant's pass answers exactly like an
  invalid one ([§7](#7-qr-visitor-pass-security)).
- The audit log lists only the caller's company. Rows without a company (unattributable events such as
  sign-in failures for unknown addresses) are never shown to a tenant administrator.

**Verified** live: a second tenant's administrator requesting the first tenant's user ID got the same
`404 NOT_FOUND` body as for a random UUID; a second tenant's receptionist scanning the first tenant's pass
got `404 PASS_INVALID`, and the audit row was written to the scanning tenant with no entity.

### 6.2 Database layer: composite foreign keys

`users`, `departments`, `visitors` and `visits` carry `UNIQUE (company_id, id)`. Every reference from one
tenant row to another is a composite foreign key on `(company_id, <id>)`, so the database rejects a row
that points into another company even if application code were wrong. **Verified** on a database
migrated to `0010` (20 foreign keys in total):

| Table | Composite references `(company_id, …)` |
|---|---|
| `users` | `department_id` → departments |
| `user_sessions` | `user_id` → users (ON DELETE CASCADE) |
| `visitors` | `created_by_id` → users |
| `visits` | `visitor_id` → visitors; `host_id`, `created_by_id`, `checked_in_by_id`, `checked_out_by_id`, `cancelled_by_id` → users; `department_id` → departments |
| `visitor_passes` | `visit_id` → visits; `created_by_id` → users |
| `email_messages` | `visit_id` → visits; `recipient_user_id` → users |

Exceptions by design: `password_reset_tokens` references `users(id)` only (it has no `company_id`
column), and `audit_logs` has no foreign keys at all, so an audit write can never fail because of the
state of the rows it describes (B1-01).

### 6.4 The platform owner

The platform owner is above every company but deliberately does not see into them (privacy by default,
B11-2): `GET /api/v1/platform/companies` returns each company's identity, activity and two aggregates
(active users, visits scheduled in the last 30 days); `GET …/admins` returns its SYSTEM_ADMIN users only.
There is no platform endpoint for visitors, visits, departments, other users or a company's audit rows,
and the platform session is refused by every company endpoint (tested for ten company reads). A company's
administrators see what the platform owner did to their company in their own audit log (rows without an
actor, `metadata.source = "platform"`, B11-5; without the platform owner's network address and browser,
B11-37).

The platform owner **can** reach into a company by a detour: it may add an administrator (itself, under
another address) or send an administrator's reset link to a mailbox it controls. That is inherent in being
able to create and recover administrators. It is made visible instead (B11-43): when an administrator is
added to an existing company, or one is sent a reset link, every other active administrator of the company
receives a security notice by e-mail (who: "the platform owner"; what and about which account; when; no
credential and no link), at most five an hour per recipient, and both audit rows of the action record how
many were told. The reset e-mail itself says that the platform owner sent it (B11-49).

**A company's identity is the platform owner's to set, and nobody else's** (Phase 12, B12-7). Its logo,
icon and colour change only through `/api/v1/platform/companies/{id}/brand…`, in the platform realm; a
company's own administrator has no endpoint for them, and `PATCH /company/settings` refuses the fields
like any unknown one (tested for every role and for six field names, with nothing of the request applied).
A brand is read per company (`Me.company.brand` from the session's company; the public endpoints by the
slug in the path), stored per company (`company_brand_assets.company_id`), and tests check that one
company's images, colour and e-mail identity never show for another. The platform owner also edits a
company's e-mail texts (B12-8), through the same service as the company's administrators; the texts stay
the company's.

A company's e-mail texts (`email_template_overrides`) are scoped like every tenant table: by the
session's company, with a composite key from the author to the company's users; tests check that one
company's texts never reach another's e-mails or editor.

### 6.3 What is not there

There is no PostgreSQL row-level security. A future defect in a read query would not be stopped by the
database (audit residual R-5). The RBAC and isolation test suites (`test_rbac*.py`,
`test_tenant_isolation_reception.py`, the two-company cases in the API tests) must stay mandatory in CI.

---

## 7. QR visitor pass security

Sources: `backend/app/security/tokens.py`, `backend/app/services/passes.py`,
`backend/app/services/scan.py`, `frontend/src/scanner/parsePassToken.ts`,
`docs/contract/pass-token-vectors.json`.

### 7.1 Token and storage

- Token: `secrets.token_urlsafe(32)` (256 bits, 43 characters). Stored only as its SHA-256 hex digest
  (`visitor_passes.token_hash CHAR(64) UNIQUE`). The raw token is never stored, logged or written to
  audit metadata.
- At most one active pass per visit (partial unique index `uq_passes_active_visit`).
- A pass is created with every visit booked through `POST /visits`, also when no invitation e-mail is
  sent. Walk-ins get no pass.
- Revocation reasons (`revoke_reason`): `ROTATED` (resend or reissue), `VISIT_CANCELLED`,
  `VISIT_COMPLETED` (check-out), `VISITOR_EMAIL_CHANGED` (D-19: changing a visitor's address revokes the
  passes of its SCHEDULED visits and re-sends the invitations to the new address).
- Validity comes from the visit: `window_start` = scheduled start minus the company's grace period
  (default 60 min, maximum 1,440), `window_end` = scheduled end plus grace. Rescheduling keeps the pass and
  moves the window.

**Verified:** after a visit was created and its pass scanned, neither a full `pg_dump` of the database nor
the API log contained the raw token.

### 7.2 Where the token travels

- The pass URL is `{QR_BASE_URL}/pass?c=<slug>#<token>` (Phase 12; before it, `{QR_BASE_URL}/pass#<token>`,
  which every parser still accepts). The token is in the **fragment**: browsers never send it to a server,
  so it is absent from server and proxy logs and from `Referer`. The query carries only the company's
  slug, which is public (the company's sign-in link shows it) and is no secret of the visitor's.
- `/pass` is a static page of the SPA. It renders the QR code on the visitor's device and shows no
  personal data (D-20). **It sends the server only the company's slug, never the token** (Phase 12): with
  `?c=<slug>` it reads that company's public identity (name, language, logo and colours,
  [§10.4](#104-a-companys-identity-uploads-the-colour-and-the-public-endpoints-phase-12)) to show the
  company's own page; without it, it is neutral and makes no API call at all. It does not register the
  service worker. There is no public pass-status endpoint, so there is no token oracle: nothing the page
  asks the server depends on the token. The pass link parser reads the token from the fragment only and
  never reads the query (`docs/contract/pass-token-vectors.json`, 63 shared cases).
- The raw pass URL is returned to staff **once**, in the responses of `POST /visits`,
  `POST /visits/{id}/invitation` and `POST /visits/{id}/pass` (all `Cache-Control: no-store`). It is
  never returned by a `GET`. The SPA keeps it in component state only. **Verified:** `GET /visits/{id}`
  did not contain `pass_url`.
- The invitation e-mail carries the QR as an inline image (`cid:`) plus the link. E-mail bodies are not
  stored ([§14.1](#141-what-is-collected)).

### 7.3 Scanner input and server-side validation

- Scanner or pasted input is parsed by one shared grammar on both sides (a bare
  `[A-Za-z0-9_-]{32,128}` token, or `http(s)://host[:port]/pass[/][?query]#<token>` without user info,
  spaces or control characters). Both test suites run the same vector file; the audit's differential
  fuzzing found no disagreement. Input is capped at 4,096 characters; anything else is an invalid pass.
- `POST /reception/scan` evaluates in a fixed order (contract §6): invalid, unknown or another
  company's pass → `404 PASS_INVALID` (the audit measured byte-identical answers and equal timing);
  cancelled; completed;
  already inside; host inactive; revoked (`410 PASS_REVOKED`); expired (`410 PASS_EXPIRED`); not yet
  valid; ready. The refusals after the first carry the visit summary in `error.details`; only callers
  with the `RECEPTION` capability (reception and administrators) can reach the endpoint.
- QR check-in re-validates the token server-side and requires it to belong to that visit. MANUAL
  check-in requires the window; OVERRIDE requires a reason and the visit's company-local day.
  Concurrent check-ins: exactly one wins (row lock).
- Every scan outcome is audited (`PASS_SCANNED{outcome}`); invalid ones with no entity and nothing from
  the input.
- Budget: 120 scans per minute per user, counted before the lookup; QR check-in and check-out share it.
- Rotation (resend or reissue) is limited to 3 per visit per hour.
- A LOST_PASS walk-in for a visitor whose pass is valid today is refused with a pointer to the expected
  visit (SEC-09, SEC-32, SEC-R2), so the lost pass is consumed by that visit's check-in and revoked at
  check-out.

### 7.4 Limits of a bearer pass

A pass proves that an invitation exists, not who holds it. Anyone holding a forwarded or stolen pass can
present it within its window. Controls: every scan result shows "Verify ID: &lt;name&gt;"; a resend or an
address change revokes the old pass; passes are bound to one company, one visit and a time window.
**Staff procedure: always verify identity** (audit residual R-3).

---

## 8. Audit logging

Sources: `backend/app/services/audit.py`, `backend/app/models/audit_log.py`, migrations `0001` and
`0008`.

### 8.1 What is recorded

Each row: `seq` (identity, the order), `id`, `company_id` (NULL only when unattributable),
`actor_user_id`, `action`, `entity_type`, `entity_id`, `metadata` (JSON), `ip_address`, `user_agent`
(max 400 characters), `request_id`, `created_at`.

Actions (`AuditAction`):

| Area | Actions |
|---|---|
| Authentication | `AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGIN_FAILED`, `AUTH_ACCOUNT_THROTTLED`, `AUTH_LOGOUT`, `AUTH_PASSWORD_CHANGED`, `AUTH_PASSWORD_CHANGE_FAILED`, `AUTH_PASSWORD_RESET_REQUESTED`, `AUTH_PASSWORD_RESET_COMPLETED`, `AUTH_PASSWORD_RESET_FAILED` |
| Denials | `ACCESS_DENIED`, `CSRF_FAILED`, `RATE_LIMITED` |
| Administration | `USER_CREATED`, `USER_UPDATED`, `USER_ROLES_CHANGED`, `USER_DEACTIVATED`, `USER_REACTIVATED`, `USER_CHANGE_REFUSED`, `DEPARTMENT_CREATED`, `DEPARTMENT_UPDATED`, `COMPANY_CREATED`, `COMPANY_SETTINGS_UPDATED` |
| Visitors | `VISITOR_CREATED`, `VISITOR_UPDATED`, `VISITOR_LINK_REFUSED` |
| Visits and reception | `VISIT_CREATED`, `VISIT_UPDATED`, `VISIT_RESCHEDULED`, `VISIT_CANCELLED`, `VISIT_MARKED_NO_SHOW`, `VISIT_CHECKED_IN`, `VISIT_CHECK_IN_REFUSED`, `VISIT_CHECKED_OUT`, `VISIT_CHECK_OUT_REFUSED`, `STALE_VISITS_CHECKED_OUT`, `WALK_IN_CREATED`, `WALK_IN_REFUSED`, `VISIT_TIME_SHIFTED` (non-production E2E command only) |
| Passes and e-mail | `PASS_ISSUED`, `PASS_REVOKED`, `PASS_SCANNED`, `INVITATION_QUEUED`, `INVITATION_SENT`, `INVITATION_FAILED` |

Phase 10 added no audit action. A user's **language change** (`PATCH /auth/preferences`) is deliberately
not audited: a display preference changes no access and no data, and an append-only row per switch
would let one session add rows at the per-user API rate (B10-4). The company's Arabic name and default
language are settings like the others: `COMPANY_SETTINGS_UPDATED` names them in `changed_fields`, never
their values. The seed commands audit the renames they make without an actor (`source: cli`), and
`send-test-email` writes no row (it changes nothing and belongs to no company).

Phase 11 adds `COMPANY_DEACTIVATED`, `COMPANY_REACTIVATED`, `PLATFORM_ADMIN_CREATED`,
`PLATFORM_ADMIN_PASSWORD_SET`, `EMAIL_TEMPLATE_UPDATED`, `EMAIL_TEMPLATE_RESET` and `EMAIL_TEMPLATE_TEST_SENT`.
A company's e-mail text changes are audited with the kind and the changed and reset field names
(`ar.subject`), never the texts (B11-30).

The Phase 11 review added no action. Rows written by `seed-demo` / `seed-e2e` now say
`metadata.source = "seed"` (`"cli"` stays for `create-admin` and `create-platform-admin`, B11-36); a
platform action that told a company's other administrators records how many (`notified_admins`, B11-43);
and `AUTH_LOGIN_FAILED` has the reason `seed_account` (production only).

Phase 12 adds `COMPANY_BRAND_UPDATED`: a change of a company's logo, dark-surface logo, icon or colour,
written in both trails like every platform action. `metadata.changed_fields` names the part (`logo`,
`logo_dark`, `icon`, `color`) and `metadata.removed_fields` the same part when it was removed; **never the
image, its size, its hash or the colour's value**. The same image or colour again writes no row. The
platform owner's changes of a company's e-mail texts are written in both trails with the metadata of an
administrator's change. Requests of the public identity endpoints write no audit row, except the coalesced
`RATE_LIMITED` row of a client beyond its budget, which names the route template and never the slug.

### 8.2 How rows are written

- **Successful business events** are written inside the business transaction (`audit.record`): the
  change and its audit row commit or roll back together.
- **Failures and denials** (`AUTH_LOGIN_FAILED`, `AUTH_ACCOUNT_THROTTLED`, `ACCESS_DENIED`, `CSRF_FAILED`,
  `RATE_LIMITED`, failed scans, refused attendance changes, …) are written by
  `audit.record_security_event` through **their own session and an immediate commit**, after the
  request's own transaction was rolled back, so the rollback cannot erase them.
- **Request IDs** in audit rows are generated by the server, or taken from nginx's `X-Request-ID` only
  when the direct peer is in `TRUSTED_PROXIES` (SEC-12). A client cannot file its requests under another
  request's ID. The nginx access log, the API log and the audit row of a request share that ID.

### 8.3 Metadata rules (no PII)

`sanitize_metadata` accepts only `None`, booleans, numbers, UUIDs, enums and strings matching
`[A-Za-z0-9_.:/{}-]{1,100}` (lists up to 50 items, keys up to 64 characters). E-mail addresses, names
with spaces, phone numbers and free text raise an error instead of being stored. Metadata therefore
holds IDs, enum values, counts, route templates (`/api/v1/users/{user_id}`, never the concrete path) and
changed-field names. **Verified:** the sign-in, CSRF, scan and visit rows of the live probe held only
such values.

### 8.4 Immutability

| Layer | Control | Verified |
|---|---|---|
| Grants (migration `0008`) | The runtime role has `SELECT` on `audit_logs` and `INSERT` on every column **except `seq`**, no privilege on the identity sequence, no `UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER` | As `vms_app`: `UPDATE`, `DELETE`, `TRUNCATE`, `INSERT … OVERRIDING SYSTEM VALUE` and `nextval('audit_logs_seq_seq')` → permission denied; `ALTER TABLE … DISABLE TRIGGER` → "must be owner" |
| Trigger (migration `0001`) | `audit_logs_immutable`: `BEFORE UPDATE OR DELETE OR TRUNCATE … FOR EACH STATEMENT` raises, for **every** role while enabled | `UPDATE` and `DELETE` as the owner `vms_owner` → "audit_logs is append-only" |
| Startup check (production) | The API refuses to start if its role could change audit rows or choose `seq` ([§15.3](#153-startup-privilege-check-production)) | Unit and integration tests; in-process check against `vms_app` and `vms_owner` |
| Visit history | `visits_terminal_immutable`: no `UPDATE` of a CHECKED_OUT or CANCELLED visit, for any role. The runtime role has no `DELETE` on any table (migration `0006`) | Trigger present and enabled; `DELETE FROM visits` as `vms_app` → permission denied |

The schema owner owns the table and could disable the trigger, and a PostgreSQL superuser can bypass
ordinary triggers (`session_replication_role = replica`). Keep the owner credential out of the API
container (the Compose layout does: it is only in `migrate.env`), keep the superuser on the local socket
only (as `deploy/postgres/pg_hba.conf` does), and monitor DDL on `audit_logs`.

### 8.5 Flood control

An append-only table that the runtime role cannot prune must not grow at an attacker's request rate:

- `RATE_LIMITED` and `CSRF_FAILED` are **coalesced**: one row per (action, source, policy or reason) and
  60-second window; repeats are counted in `metadata.coalesced` on the next row or in a deferred summary
  row (`deferred: true`), also written at shutdown. Responses are unchanged: every request still gets
  its 429 or 403. **Verified:** five CSRF rejections within a minute wrote three rows (one per reason).
- Unattributed denials share a budget of 10 written rows per (action, policy or reason) and minute,
  whatever their source, then one summary row (`overflow: true`).
- Attributed refusals (`ACCESS_DENIED`, `VISITOR_LINK_REFUSED`, `USER_CHANGE_REFUSED`) are written up to
  10 per user, action and minute, then summarised.
- Refused attendance changes have their own budget (30 per user and minute, then 429).
- `AUTH_LOGIN_FAILED` and `AUTH_PASSWORD_RESET_FAILED` stay one row per response (forensic evidence),
  bounded per source by the sign-in and reset budgets.
- These row budgets and the coalescing live in the memory of each API process, so each process writes
  its own rows and summaries. With the Compose layout's four processes, one user can cause up to 44
  `ACCESS_DENIED` rows a minute and 8 `RATE_LIMITED` rows for `api_per_user`, against 11 and 2 with one
  process ([§9.1](#91-design)). Every refusal is still counted in the summaries.

### 8.7 The platform owner's trail

`platform_audit_logs` (migration `0013`, B11-4) holds every platform sign-in, sign-out, failure,
lockout, password change, CSRF failure, rate limit and action, with `actor_platform_admin_id` and the
`company_id` the action was about. It has the guarantees of `audit_logs`: the trigger
`platform_audit_logs_immutable` refuses UPDATE, DELETE and TRUNCATE for every role, the runtime role has
SELECT and column INSERT without `seq` and nothing on its sequence (the startup check refuses more), no
foreign keys, the same metadata rules, and coalescing of RATE_LIMITED / CSRF_FAILED rows in windows of
its own. Every request under `/api/v1/platform` writes its failures there, never in a company's trail.
A platform action that changes a company is written in both trails (B11-5): the company's row with the
request ID but without the platform owner's network address and browser, which a company's administrators
would otherwise read in their audit page (B11-37); the platform's row with both. The platform's trail also
records a refused creation for a taken address (`USER_CHANGE_REFUSED`, B11-42) and a write refused because
its session had ended (`ACCESS_DENIED`, `reason = "session_ended"`, B11-38). It is read with
`GET /api/v1/platform/audit-logs` (platform owner only).

### 8.6 Who can read it

`GET /audit-logs` requires `READ_AUDIT` (SYSTEM_ADMIN only, D-13) and returns the caller's company only,
newest first by `seq`. The product has no audit export endpoint. A SIEM can ingest the API's JSON logs;
if your policy requires the audit rows themselves off the database, read them with a separate read-only
database role created for that purpose (not the runtime role).

---

## 9. Rate limiting and resource limits

### 9.1 Design

Source: `backend/app/core/rate_limit.py`.

- In-memory sliding-window limiter in each API process; `python -m app.serve` fixes `workers=1`.
  **Run exactly one main API process per deployment** (`backend` in Compose): it receives every
  sign-in and every write, so every budget below except `api_per_user` is counted there only, and a
  second copy would double them (audit residual R-1). That also rules out `docker compose up --scale
  backend=N` and an upstream name that resolves to more than one main process. A restart of it resets
  all budgets and lockouts.
- The Compose deployment adds three read processes of the same image and env file (D9-34, D9-35,
  D9-36): two `backend-reception` replicas for `GET /reception/today` and `/inside`, and
  `backend-reports` for `GET /reports/summary`, `/audit-logs`, `/dashboard/admin` and `/visits`.
  nginx routes by method and by the path exactly as the client sent it
  ([§11.3](#113-nginx-proxy-and-tls-behaviour)). Only these six GET requests, spelled as the API routes
  them, leave the main process. They consult only `api_per_user`, for every role and answer: the suite
  test is `backend/tests/integration/test_routed_reads.py`, and `deploy/verify/test_api_instances.py`
  keeps its list equal to the nginx map. Two things are therefore counted per process:
  - `api_per_user`: up to 600 requests a minute per user on each process, 2,400 in all and 1,200 on
    the two list paths. At most 600 of them are writes.
  - The refusal-row budgets of [§8.5](#85-flood-control): up to 44 `ACCESS_DENIED` rows a minute per
    user and 8 `RATE_LIMITED` rows for `api_per_user`, against 11 and 2 with one process.
- The engineering security review of this layout (2026-10-07) found the trade **acceptable with
  conditions**. Every budget that guards sign-in, recovery, e-mail, scans and attendance stays on the
  main process. What grows is limited to a signed-in user's read throughput and refusal rows, and no
  evidence is lost. The verdict, its evidence and the status of its conditions are in the audit's
  [R-1 Phase 9 closure note](security-audit.md#r-1-phase-9-closure-2026-10-07).
  - Condition 4, a compose test of the read services' settings, was met after that note was written
    (D9-37); the note still lists it as open. `deploy/verify/test_api_instances.py` requires the read
    services to keep `backend`'s image, build, command, entrypoint and env file, and to set no
    `environment` key except `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE`. A lower
    `RATE_LIMIT_API_PER_MINUTE` on the read services must be added to that test's allow-list
    (`READ_SERVICE_OVERRIDES`) in the same change.
  - One condition is open: the deploying organisation's security owner's sign-off of the per-process
    budgets before production traffic
    ([`docs/production-readiness.md` §15 H](production-readiness.md#h-security-and-compliance)).
- `reserve` + `settle`: slow outcomes (wrong passwords) take an in-flight slot atomically before the work,
  so concurrent attempts cannot exceed a limit (no check-then-record race).
- Keys derived from typed e-mail addresses and client addresses are `HMAC-SHA256(SECRET_KEY, …)`
  digests, so no raw e-mail address or IP address sits in the limiter's memory. Authenticated budgets
  are keyed by user, visit or company ID.
- Memory is bounded. Buckets keyed by anonymous input are capped: network keys
  (`RATE_LIMIT_MAX_NETWORK_BUCKETS`, default 100,000) and typed e-mail addresses
  (`RATE_LIMIT_MAX_EMAIL_BUCKETS`, default 100,000), about 200 MB with both full. At the cap a new key is
  admitted untracked (judged by its other budgets) instead of refusing everyone. Live buckets are never
  evicted.
- Every 429 carries `Retry-After` and is audited as `RATE_LIMITED{policy}` (coalesced).
- `RATE_LIMIT_ENABLED=false` exists for development only; production refuses it.

### 9.2 Budgets and their settings

| `policy` in audit rows | Default | Setting | Production bound |
|---|---|---|---|
| `login_failures_ip_email` | 5 / 5 min | `RATE_LIMIT_LOGIN_PER_IP_EMAIL` | ≤ 50 |
| `login_failures_ip` | 30 / 5 min | `RATE_LIMIT_LOGIN_PER_IP` | ≤ 300 |
| `login_failures_prefix` (IPv6 /48) | 300 / 5 min | `RATE_LIMIT_LOGIN_PER_PREFIX` | ≤ 3,000 |
| `login_failures_account`, `…_unknown_account`, `…_device` | 10 / 15 min, then 15 min block | `RATE_LIMIT_LOGIN_PER_ACCOUNT` | ≤ 100 |
| `login_successes_account` | 30 / 15 min | `RATE_LIMIT_LOGIN_SUCCESSES_PER_ACCOUNT` | — |
| `password_change_failures` | 5 / 15 min | `RATE_LIMIT_PASSWORD_CHANGE_PER_USER` | ≤ 50 |
| `password_changes_per_user` | 5 / hour | `RATE_LIMIT_PASSWORD_CHANGES_PER_HOUR` | — |
| `forgot_password_account` | 3 / 15 min per existing account | `RATE_LIMIT_FORGOT_PER_EMAIL` | ≤ 30 |
| `forgot_password_ip` / `…_prefix` | 10 / 100 per 15 min | `RATE_LIMIT_FORGOT_PER_IP` / `…_PER_PREFIX` | ≤ 100 / ≤ 1,000 |
| `reset_password_ip` / `…_prefix` | 20 / 200 per 15 min | `RATE_LIMIT_RESET_PER_IP` / `…_PER_PREFIX` | ≤ 200 / ≤ 2,000 |
| `user_email_refusals_per_user` / `…_per_company` (POST /users for a taken address) | 10 / 20 per hour | `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR` / `…_PER_COMPANY_PER_HOUR` | ≤ 100 / ≤ 200 |
| `api_per_user` (every authenticated request, the language preference included: it has no budget of its own) | 600 / min | `RATE_LIMIT_API_PER_MINUTE` | — |
| `scan_per_user` (scans, QR check-in/out) | 120 / min | `RATE_LIMIT_SCAN_PER_MINUTE` | — |
| `attendance_refusals_per_user` (refused MANUAL/OVERRIDE/CORRECTED/walk-in) | 30 / min | `RATE_LIMIT_ATTENDANCE_REFUSALS_PER_MINUTE` | — |
| `invitations_per_user_day` | 50 / 24 h (`429 INVITATION_LIMIT`) | `INVITATION_DAILY_LIMIT` | — |
| `invitation_resends_per_visit` (resend and pass reissue) | 3 / hour | `RATE_LIMIT_RESENDS_PER_VISIT_HOUR` | — |
| `reschedule_notices_per_user_day` / `…_per_visit` | 50 / 24 h; 3 / hour (change kept, e-mail left out) | `RESCHEDULE_NOTICE_DAILY_LIMIT` / `RATE_LIMIT_RESCHEDULE_NOTICES_PER_VISIT_HOUR` | — |
| `host_arrivals_per_user_day` | 500 / 24 h (check-in kept, e-mail left out) | `HOST_ARRIVAL_DAILY_LIMIT` | — |
| `host_visit_notices_per_user_day` (the host's e-mails of scheduled visits, per acting user, Phase 14) | 200 / 24 h (change kept, e-mail left out) | `HOST_VISIT_NOTICE_DAILY_LIMIT` | — |
| `calendar_emails_per_company_day` (calendar events the e-mails carry, per company, Phase 14) | 500 / 24 h (change kept; a calendar invitation left out, a notice sent without its event; a removal always sent) | `CALENDAR_EMAIL_COMPANY_DAILY_LIMIT` | — |
| `password_notices_per_user` | 5 / hour (fixed) | — | — |
| `stale_check_out_empty_runs` | 1 audit row per user and company-local day for an empty bulk check-out (fixed; not a refusal) | — | — |
| `template_test_sends_per_user` (test e-mails of a company's texts, to the administrator's own address) | 5 / hour | `RATE_LIMIT_TEMPLATE_TEST_SENDS_PER_HOUR` | ≤ 100 (field bound) |
| `public_brand_ip` / `public_brand_prefix` (every request of the public identity endpoints, whatever the answer; Phase 12) | 600 / 6,000 per minute | `RATE_LIMIT_PUBLIC_BRAND_PER_IP` / `…_PER_PREFIX` | ≤ 6,000 / ≤ 60,000 |
| `brand_changes_per_user` (changes of companies' brands by one platform account, refused uploads included; Phase 12) | 120 / hour | `RATE_LIMIT_BRAND_CHANGES_PER_HOUR` | ≤ 10,000 (field bound) |
| Bucket caps | 100,000 each | `RATE_LIMIT_MAX_NETWORK_BUCKETS`, `RATE_LIMIT_MAX_EMAIL_BUCKETS` | ≥ 10,000 |

"Production bound" values are enforced at startup: a guessing or recovery limit above ten times its
default, or a bucket cap below a tenth of its default, stops the API with a message naming the setting.
Throughput budgets have no ceiling, so large sites can raise them.

The platform sign-in uses the login policies above with keys of its own (account, typed e-mail, device)
and shares `login_failures_ip` / `login_failures_prefix` with the companies' sign-in, so a client that
guesses at both pays one budget. A platform reset link for a company administrator spends that
account's `forgot_password_account` budget. Since the Phase 11 review: a platform account's failure
budgets are counted per account and password, and a generated temporary password has a
`login_failures_device` budget of its own ([§3.7](#37-the-platform-owner-phase-11), B11-35); the platform
owner's creations refused for a taken address share `user_email_refusals_per_user` per platform account
(10 an hour, B11-42); and each administrator receives at most 5 notices of platform actions an hour (B11-43).

### 9.3 Other resource limits

| Limit | Value | Where |
|---|---|---|
| Request body | 64 KiB (`MAX_REQUEST_BODY_BYTES`); a declared larger length is refused before reading, chunked bodies are counted while read → `413 PAYLOAD_TOO_LARGE`. nginx enforces the same limit first (`client_max_body_size 64k`). **One exception** (Phase 12): the upload of a company's brand image, 512 KiB, for exactly that method and route (`BodyLimit`); nginx lets that path through with the same limit and passes the body on while it arrives, holding none of it (B12-18) | `BodySizeLimitMiddleware`, `deploy/nginx/templates/vms.conf.template` |
| Uploads in progress | 8 on the site and 4 from one client address, counted by nginx for `PUT` on the upload's path alone → `503 SERVICE_BUSY`, `Retry-After: 5`. A place is taken before authentication, so no request can keep one without being signed in: the API answers it without reading its body, and nginx closes the connection with that answer ([§11.3](#113-nginx-proxy-and-tls-behaviour), B12-18) | `deploy/nginx/templates/vms.conf.template` |
| An upload's body, in time | all of it within 30 s of the request reaching the API, else `408` (code `BAD_REQUEST`); nginx bounds only the pause between two reads (15 s) | `api/deps.py` (`PNG_UPLOAD_SECONDS`) |
| An uploaded image | at most 512 KiB as a file; 1200 × 600 pixels (logos) or 512 × 512 (icon), judged on the header; a logo at most 8 bits a channel since Phase 13 (B13-7: also judged on the header, `invalid_image`); inflated to at most the image's own size plus one byte: 2.7 MiB for the largest logo, 2 MiB for the largest icon (5.5 MiB for a logo at 16 bits, which only one stored before B13-7 can be, and which the e-mails still decode). **A check costs twice that for a moment**, 5.5 MiB and 4 MiB (11 MiB, 12 MiB with a file at the 512 KiB limit, for the 16-bit logo; measured, B12-19), whether the file is accepted or refused, and keeps none of it. At most 2 files are checked at a time in one API process (2 s wait → `503 SERVICE_BUSY`) | `core/png.py`, `services/brand.py` |
| Pagination | `page_size` 1–100, `page` ≤ 100,000; search text ≤ 100 characters; multi-value filters ≤ 500 characters; report ranges ≤ 366 days | `schemas/common.py` |
| Database waits | connect 5 s, pool 5 s, statement 30 s, lock 10 s → `503 SERVICE_BUSY` (`DB_*_TIMEOUT_*` settings). `GET /health` answers within 3 s on a connection of its own | `db/session.py`, `services/health.py` |
| Argon2 | `PASSWORD_HASH_CONCURRENCY` slots, 2 s wait → 503 | [§3.1](#31-password-storage) |
| E-mail delivery | `EMAIL_DELIVERY_CONCURRENCY` (4) threads of its own, 20 s per message | `email/dispatcher.py` |
| Graceful shutdown | 20 s, then the lifespan writes the coalesced audit counts | `app/serve.py` |

**Verified:** a 70 KB body with a declared length and the same body chunked both got `413`.

### 9.4 Client IP and trusted proxies

Source: `backend/app/core/client_ip.py`.

- If the direct peer is in `TRUSTED_PROXIES` (CIDR list, empty by default), the client is the
  **rightmost** `X-Forwarded-For` entry that is not itself a trusted proxy; otherwise it is the peer
  address. Unparsable entries, entries with a port, and scoped IPv6 addresses give "no address" (stored as
  NULL) rather than a guess.
- uvicorn's own proxy-header handling is off (`proxy_headers=False`), so `TRUSTED_PROXIES` is the only
  rule.
- Per-IP limits use the IPv4 address or the IPv6 /64; the secondary limits use the IPv6 /48. Audit rows
  and sessions keep the full address.
- nginx sets `X-Forwarded-For $remote_addr` (**overwrite**, never append) and the Compose deployment sets
  `TRUSTED_PROXIES=172.30.47.10/32` (nginx's fixed address).
- Production refuses networks wider than /8 (IPv4) or /32 (IPv6), such as `0.0.0.0/0`.
- A request from a trusted address **without** `X-Forwarded-For` has no client address; all such requests
  share one per-IP budget. Do not let other services call the API from the proxy's address.

**Verified:** with no trusted proxies, a spoofed `X-Forwarded-For` was ignored (audit rows recorded the
real peer) and a client-chosen `X-Request-ID` was replaced by a server-generated one.

---

## 10. Input and output validation

### 10.1 Input

| Rule | Detail |
|---|---|
| Schemas | Every request body and every query string is a Pydantic model with `extra="forbid"` (unknown fields or parameters → 422). Strings are capped (10,000 characters at most; most fields far lower) |
| JSON only | Form, multipart and `text/plain` bodies are refused (422); there is no file upload |
| Control characters | C0 controls and DEL are refused in every request string except tab, LF and CR (and those are refused inside single-line names, below) → "Remove unsupported control characters." Scanner input is exempt and classified by the pass parser instead |
| Invisible text | Leading and trailing invisible characters (zero-width, BOM, bidi marks and isolates, Hangul fillers, blank braille) are trimmed; a required field that shows nothing is "required" |
| Names | Single line (no TAB, CR, LF, VT, FF, NEL, U+2028/2029 inside) and no bidirectional overrides or embeddings (U+202A–202E, U+2066–2069) |
| Phone numbers | Grammar: optional `+`, digits (ASCII, Arabic-Indic, Extended Arabic-Indic), spaces, `( ) . / -`, at least 3 digits, optional extension |
| E-mail addresses | `email-validator` rules, stored lowercase (`.local` and `.test` accepted for development and seeds). Sign-in input is only normalised |
| Timestamps | Timezone-aware ISO-8601 required (naive → 422) |
| IDs | UUIDs; malformed path IDs → 404 |
| Database backstop | A PostgreSQL data error (e.g. NUL) → 422 without a traceback in the log |
| Languages (Phase 10) | `language` and `default_language` accept exactly `ar` or `en` (enum, database `CHECK`); the company's `name_ar` follows the rules of names (one line, no control or direction characters, at most 200 characters; blank clears it) |
| E-mail addresses (Phase 10) | A local part containing `=?` (also in fullwidth form) is refused, so no address can carry an RFC 2047 encoded word (S10-13) |

Validation messages name the field and the rule; they **never echo the rejected input**. Since Phase 10
each 422 also carries a code per field (`details.field_codes`); its parameters are the API's own limits
and allowed values (`max`, `min`, `choices`, a time of day for the lost-pass rule, counts), never the
rejected input (B10-18).

### 10.2 Output and injection

- **SQL:** data access goes through SQLAlchemy with bound parameters; the few `text()` statements are
  static or bound. `LIKE` input is escaped (`escape_like`). `ORDER BY` is fixed per query. The engine runs
  with `hide_parameters=True`.
- **HTML in the browser:** React escapes all text; the SPA has no `dangerouslySetInnerHTML`,
  `innerHTML`, `eval` or `document.write`. The CSP has no `'unsafe-inline'` or `'unsafe-eval'`
  ([§11](#11-security-headers-and-caching)). Redirect targets after sign-in are same-origin relative
  paths only (`frontend/src/auth/redirect.ts`).
- **E-mail:** Jinja2 with autoescape for HTML and `StrictUndefined`; no template uses the `safe`
  filter or `from_string`. Since Phase 10 the texts come from one bilingual catalog
  (`app/email/i18n.py`): in HTML, `t` escapes the catalog text and every value on its own
  (`Markup.format`) and wraps each value in a `<span dir>` of its own direction (`app/email/bidi.py`); in
  plain text, values are wrapped in isolate characters. A value cannot leave its span (tested with
  `</span><script>`), and a direction override typed into a purpose ends at its value (B10-14). Header
  values have control characters and line breaks of every kind replaced (CR, LF, C0 and C1 controls,
  DEL, U+2028, U+2029: S10-5); recipients and Reply-To are validated addresses; an address with `=?` is
  refused and an `=?` in a Subject cannot open an encoded word, whichever provider sends it: the
  renderer finishes every subject in one place (one line, no direction controls, `=?` written `= ?`, at
  most 250 characters), so Resend, SMTP, the outbox, the e-mail log and the preview carry the same text
  (S10-13, B11-40, B11-41). Every link is built from
  `APP_BASE_URL`/`QR_BASE_URL`, never from request headers. Resend receives JSON, not raw MIME; the SMTP
  provider builds the MIME message with the `email` package. Messages load no remote resource: the logo
  and the QR code are inline images, and there is no web font or tracking pixel.
- **Errors:** every non-2xx response uses the envelope
  `{"error": {"code", "message", "details"}, "request_id"}`. Unhandled errors answer
  `500 INTERNAL_ERROR` with no stack trace, SQL or driver text. Database outages answer
  `503 SERVICE_BUSY`.
- **Redirects:** the API sends none (`redirect_slashes=False`; `/visits/` answers 404 instead of a 307
  built from the `Host` header). **Verified.**

### 10.3 A company's e-mail texts (Phase 11)

Administrators may change words of the visit e-mails, never the structure (B11-20 … B11-29):

- **Plain text only.** A tag opener (`<b`, `</`, `<!`, `<?`) or a character reference (`&amp;`, `&#60;`) is
  refused (`markup_not_allowed`); control, line-break (in one-line fields) and text-direction characters
  are refused; every field has a length limit. The text is escaped in the HTML part and values are
  escaped on their own, so nothing typed can become markup even if a check were bypassed.
- **Placeholders** are `{name}` from a fixed allow-list per kind, parsed by the backend's own pattern and
  never passed to `str.format` (no attribute access, no format specification). Unknown names and stray
  braces are refused on save.
- **Headers.** Subjects are one line, values are inserted as they are and the result is finished by
  `headers.subject_line`, as every subject is: CR, LF, C0, C1 and U+2028/2029 removed; explicit direction
  controls removed (nothing closes them in a header); `=?` written `= ?` for every provider (B11-41); at
  most 250 characters, cut with an ellipsis and never inside a character, each language of a bilingual
  subject keeping at least half (B11-40). A subject that is too long now gives up part of the company's
  name before its end (B12-24: the name cut short where it stands, to no fewer than 12 characters); the
  bound of 250 characters holds either way, and the name is finished like the subject before it is
  measured. A test e-mail's prefix is counted in the same 250.
- **Size.** The limits count a text, and a value can be far longer than its name: the review rendered a
  15,071-character subject and 329 KiB of HTML from one field. Now a variable appears at most three times
  in one text, `{purpose}` (free text typed for one visit) is not a variable of a subject, a text renders
  to at most twice its own limit (cut with an ellipsis, outside any markup), and a text saved before a
  rule existed is not used (the product's text is). With every field at its worst and every value at its
  longest, made of the character that grows most when escaped, an invitation is 91 KiB of HTML and 15 KiB
  of text; a test holds every kind below 100 KiB and 16 KiB (B11-40).
- **Fixed security content.** The pass link and its target, the QR code, the details grid, the reply
  and sender lines, "This pass is personal" and the validity window cannot be edited; the password-reset
  and password-changed e-mails cannot be edited at all (B11-21), so they keep the words users learn to
  trust and an account taken over cannot redirect them.
- **Anti-phishing cue.** A visitor e-mail's subject must contain `{company}`; a host arrival's
  `{visitor_name}` (B11-25).
- **Preview isolation.** The preview document is served with its own policy
  (`default-src 'none'; img-src data:; style-src 'unsafe-inline'; … frame-ancestors 'self'; sandbox`) and
  `X-Frame-Options: SAMEORIGIN`, so nothing in it can run, load or navigate (B11-28). Its inline images
  replace only the images' own `src` attributes, not words of a text that name one (B11-44).
- **The notice of a platform action** (`PLATFORM_ACTION_NOTICE`, B11-43) is a security e-mail like the two
  above and as little editable. Since B12-22 it is drawn in the company's own identity (its logo or
  name, its colours, its name as the sender, "Sent by {company}."), as every e-mail a company's people
  receive is; it used to carry the product's logo and name. What marks it is therefore its words, which
  no company can change: the yellow «تنبيه أمني» / "Security notice" pill and "the platform owner …".
  The four e-mails whose words a company's administrators can change are the visit e-mails (to visitors
  and to the host of a visit), in fixed layouts under their own pills; none of them can be given this
  pill, this kind or these recipients.
- **Test e-mails** go only to the caller's own address, 5 per hour (B11-29).

### 10.4 A company's identity: uploads, the colour and the public endpoints (Phase 12)

Each company has a logo, a logo for dark surfaces, a square icon and one colour
([`phase-12-backend.md`](decisions/phase-12-backend.md)). This is the first place where the system takes a
**file** from a person and gives it to other people's browsers and mail clients, and the first set of
endpoints that answer **without a session**. Both are kept narrow.

**Who.** Only the platform owner uploads and changes (platform session, platform CSRF token; 401 for
everyone else before any byte of a body is read). The uploader is therefore a trusted operator; the
controls below assume the file may be hostile anyway (a compromised operator account, a file the operator
was handed by a customer).

**The upload threat model.**

| Threat | Control |
|---|---|
| **Not an image at all** (HTML, SVG with script, a JPEG, an executable) | The body must be sent as `image/png` (else 415), and then the bytes decide: the PNG signature, every chunk's length and CRC-32, a valid header. Everything else is `422 invalid_image`. SVG, GIF, JPEG and WebP are never accepted |
| **A polyglot**: a valid PNG with HTML, JavaScript or a ZIP archive after its end, or inside a text or private chunk | Nothing may follow `IEND` (refused). And the server **never stores the file as it came**: it writes a new one from the header fields, the palette and transparency where the colour type has them, and the image data, as `IHDR`, [`PLTE`], [`tRNS`], one `IDAT`, `IEND`. Text, comments, ICC profiles, EXIF, time stamps and private chunks do not survive |
| **A decompression bomb**: a few kilobytes that inflate to gigabytes | The dimensions are checked on the header **before anything is inflated** (a header that claims 2³¹ pixels a side is refused in microseconds). The data is then inflated with a hard bound: the bytes the header implies, plus one. A stream that would expand further is refused at that bound; 64 MiB of zeros inside a 240 × 80 image costs no more memory than the image. That cost is twice what the image inflates to, for the moment zlib works: 5.5 MiB for the largest logo an upload may be (8 bits a channel since B13-7; a 16-bit one is refused on its header), 11 MiB for a 16-bit logo stored before, which the e-mails decode (measured; [§9.3](#93-other-resource-limits)). A refusal gives the inflated bytes back before it is raised and carries nothing of the check with it, so refused uploads do not pile up between two runs of the garbage collector (they did: 40 refused files at once took a server from 127 to 415 MiB until the next collection, B12-19), and at most two files are checked at a time |
| **A parser exploit** in an image library | There is no image library and no native decoder for untrusted input: the check is fewer than 300 lines of Python on `struct` and `zlib`. zlib inflates within the bound above. The upload's check decodes no pixels. Since Phase 13 the e-mails do, to draw their own copy of a stored logo (below), and the same holds there: pure Python (no native code but `zlib`), and only for an image that passes this very check again first, within the logo's limits |
| **A rarely used corner of the format** (interlacing, animation, unknown critical chunks) | Refused: Adam7 interlacing, APNG (`acTL`, `fcTL`, `fdAT`), any critical chunk the check does not know, a palette or transparency chunk where PNG does not allow one |
| **Stored XSS through the image**: a browser sniffing the bytes as HTML, or the image opened directly as a document | `Content-Type: image/png` exactly; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`; `X-Frame-Options: DENY`; `Cross-Origin-Resource-Policy: same-origin`. The same origin serves the image, so these headers, not a separate domain, are what keeps bytes an attacker chose from running |
| **Oversized uploads** as a load on the server | 512 KiB for exactly this request, refused from the declared length before reading (413), by nginx first; a body without a declared length is counted while it is read, by nginx and by the API; all of a body within 30 s (408); 120 changes an hour per platform account, refused files included |
| **Uploads that nobody is signed in for**, sent to keep the platform owner out | nginx lets 8 uploads be in progress on the site and 4 from one address, and takes a place before anyone is asked who they are. A request cannot keep its place unless it is the platform owner's: nginx hands it to the API with its header, before the body (`proxy_request_buffering off`); the API answers 401, 403 or 415 without reading a byte of the body; and nginx closes the connection with that answer (`lingering_close off`) instead of waiting for the rest of the body with the place still taken. Only `PUT` is counted, so removing an image is never refused. Measured: such a request has its place for 2 to 42 ms (median 6 ms), where eight connections that sent a byte every five seconds had held all eight places for as long as they stayed ([§11.3](#113-nginx-proxy-and-tls-behaviour), B12-18) |
| **An image stored outside its limits by another path** | The database repeats the limits as CHECKs (PNG signature, size, dimensions, the hash's and version's form): the seeds and any future writer cannot store what the API would refuse |
| **Hidden data or tracking** in what visitors receive | Only pixels, palette and transparency survive; the stored file's bytes depend on the upload alone (the image data's zlib stream is carried over, proven to be exactly the image) |

What the check does **not** do: it does not decode pixels, so it cannot tell what an image shows, and bytes
an attacker chose survive as pixel values. They are only ever served as an image (above). An e-mail does not
carry the stored file at all since Phase 13: it carries a picture drawn from its pixels (laid on a plate,
averaged down to at most twice the size it is shown at, and written again as opaque RGB), so neither the
stored bytes nor anything that survived as a pixel value reaches a mailbox as it was uploaded.

**Drawing a logo for e-mails** (Phase 13, B13-2 to B13-4, B13-7). The server decodes a stored logo in
pure Python (`app.core.png.decode_png`), after running the upload's check on it again. Its cost is bounded
by the logo's limits: about 2 seconds of one processor and 10.4 MiB at the peak for the largest logo an
upload may be (1200 × 600 at 8 bits a channel, every row filtered the slowest way); about 3.7 seconds and
16.6 MiB for one at 16 bits, which an upload is refused since B13-7 and only a logo stored before can be.
At most one drawing at a time in a process, once per logo and process (the result is kept, by the
SHA-256 of the stored bytes, within 8 MiB), and **ahead of the requests that send it** (B13-7): a
company's logos are drawn in a background thread once a change of them is committed, and every active
company's from the first write a server process takes (the process that takes writes is the one that
sends e-mails; the read services take GETs only). A request that needs a logo being drawn waits for that
drawing and takes its result. Only the platform owner stores logos (120 changes an hour). A logo that
cannot be drawn, whatever the fault, is sent as it was stored, and the e-mail goes (B13-11).

**The colour.** One value per company, exactly `#` and six lower-case hexadecimal digits: enforced by the
schema (any other value, of any type, is `invalid_color`; nothing is trimmed or folded) and by a CHECK on
the column. It is written into style sheets and e-mail markup as it is, so nothing else can be stored.
The shades are derived by the server alone (`core/palette.py`), with contrast guaranteed for every
possible colour (tested over a grid of the whole RGB cube), so a hostile or careless choice cannot make a
page or an e-mail unreadable, for example to hide a warning. Since B12-21 a brand surface (the
application's shell, a primary button, the bar and the button of an e-mail) may be the chosen colour
itself; it always comes with the ink that reads on it at 4.5:1 (`surface` with `on_surface`: white, or
the dark ink on a light colour), and a colour on which neither ink reads is not used as a surface. The
same grid holds those pairs.

**The public endpoints** (`/api/v1/public/companies/{slug}/…`: identity, image, manifest).

| Concern | Control |
|---|---|
| **What is public** | For **active** companies: the slug, the two names, the default language and the brand. No ID, time zone, address, state, count, user or visit. Tested by the exact key set of the answer |
| **Slug enumeration** | A slug nobody has, a deactivated company, a string no slug could be, a missing image and an image name that does not exist answer one identical `404` (same body, same headers; the first two in one database statement). Whether a slug names an active company is **public by design** (the company's sign-in link shows its identity); what is bounded is the speed: 600 requests a minute per client address and 6,000 per IPv6 /48, counted for every request before anything is looked up, whatever the answer. Production refuses more than ten times these |
| **Injection through the slug** | A slug is matched against the slug grammar (lower-case letters, digits, inner hyphens, at most 80 characters) before any query, never folded, and only ever compared as a bound value. In addresses the API builds it is percent-encoded |
| **Sessions** | None is read, extended or created; no cookie is set; a signed-in person, the platform owner and a stranger receive identical bytes. A request there cannot be used to keep a session alive or to learn whether one exists |
| **Cache poisoning and stale identities** | The API alone sets the caching rule (nginx adds none and stores nothing). An image's address carries a **random version per upload**: `immutable` for a year only under the current version's address; any other address (no version, an old one, one made up ahead of time) gets the current image for 60 seconds, so no address can be filled with other bytes before an image exists, and a wrong link heals by itself. The identity and the manifest are `no-cache`. No answer depends on a request header, so there is no `Vary` and no way to serve one viewer's variant to another. Errors (404, 422, 429) are `no-store` |
| **ETag and 304** | A strong entity tag (the quoted SHA-256 of the body). `If-None-Match` is compared as RFC 9110 says; a 304 carries the same tag and caching rule and no body; what does not exist is 404 whatever the request header says |
| **Load** | The budgets above; images are at most 512 KiB; every answer is one or two indexed reads |

**E-mails of a company** carry its logo as an inline image (since Phase 13 an opaque copy drawn by the
server, and in the dark design its logo for dark surfaces likewise) and its name as the sender's display
name ([§10.2](#102-output-and-injection), B12-12, B12-13). Their style sheets (the phone's layout and the
dark design, B13-1) hold class names and colours the server derived (`#RRGGBB`), and no text of a company
or a person. The name is escaped wherever it is written into HTML
(the word mark, the logo's text alternative) and, as a header, stripped of line breaks, control and
direction characters, of `<`, `>`, `"`, `@` and `\` (it cannot close the quoted name, carry an address or
look like one), has `=?` broken (no RFC 2047 encoded word) and is cut at 100 characters. The address is
always the deployment's `EMAIL_FROM` address. Links in a company's e-mails add `?c=<slug>` and keep every
token in the fragment.

**The sender's name, exactly** (B12-20). A company's administrator can rename the company, and the name
becomes the display name of `From`. What is prevented, and what is not:

| | |
|---|---|
| **Prevented:** the name closing its quotes, carrying a second mailbox, or reading as an address | `<`, `>`, `"`, `@` and `\` are replaced by a space **in every form Unicode treats as the same character for compatibility** (NFKC): the nine fullwidth and small variants (U+FF20 ＠ and U+FE6B ﹫ of `@`; U+FF1C, U+FF1E, U+FE64, U+FE65 of `<` and `>`; U+FF02 of `"`; U+FF3C and U+FE68 of `\`) as well as the five themselves. A company named `support＠paypal.com` used to send as `"support＠paypal.com" <no-reply@…>`; it sends as `"support paypal.com" <no-reply@…>`. A test goes through every code point and holds that neither the sender's name nor its normalised form contains one of the five, a line break or a direction control |
| **Prevented:** another address than the deployment's | The address is `EMAIL_FROM`'s, whatever the name is |
| **Not changed:** the rest of the name | Every other character stays as typed (a fullwidth letter, a ligature, a half-width kana), so the sender's name is the name the e-mail shows |
| **Not prevented:** a misleading name | A company can be named "Bank Support" or after another organisation, and its e-mails are sent under that name, from the deployment's address. Names are free text and nobody reviews them ([§19](#19-residual-risks-and-known-limits)) |
| **Not prevented:** a look-alike that is not a compatibility form | A character that merely resembles `@` (a circled "a", a letter of another script) is a letter like any other |
| **Not refused:** `@` in a company's name | The name is stored and shown as typed in the application, the e-mail's subject and its text, where it is text and nothing else. Only the header is judged, for every company, whenever its name was set |

**Checked by** `tests/unit/test_png.py` (160 cases: truncation at every chunk boundary, wrong checksums,
chunk order, interlacing, APNG, a huge header with tiny data, data that inflates beyond its bound,
trailing bytes, polyglots with HTML, script and ZIP, every colour type and bit depth, dropped text and ICC
chunks, byte-stable output; what a check costs and that a refusal keeps nothing inflated),
`test_png_upload.py` (nothing of a body is read for a stranger, the body's 30 seconds, a sender that goes
away), `test_palette.py`, `test_email_identity.py` (the sender's name over every code point),
`tests/integration/test_platform_brand.py` (who may change a brand, the upload's refusals through the API,
both audit trails; live memory after refused uploads with the garbage collector off; a company renamed to
read as an address), `test_public_brand.py` (the one 404, no cookies, the caching rules, 304, the budgets)
and `test_brand_database_rules.py` (the CHECKs as the runtime role, the downgrade guard). The upload's
places are held by `deploy/verify/test_api_instances.py` (the location's directives, the keys that count
only `PUT`) and, on a deployment, by `deploy/verify/smoke_test.py` (an upload nobody is signed in for is
answered before its body arrives, and eight of them in a row keep no place).

### 10.5 Calendar invitations (Phase 14)

The visit e-mails carry the visit as a calendar event (iCalendar, an iTIP REQUEST or CANCEL;
[phase-14-backend.md](decisions/phase-14-backend.md)). Calendars are synchronised to phones and computers,
shared and delegated far more widely than one e-mail, and the pass link is a bearer credential, so:

- **No link and no token in any calendar data** (B14-4): an event says when, where (the company's
  address), who and what for, and "show your visitor pass at reception"; it holds no URL at all. Tests
  look for the token, `/pass`, `?c=` and `http` in every event and in the e-mails that carry one.
- **The pass's own e-mail carries no event** (B14-10). Outlook makes the e-mail that carries an event the
  body of the calendar entry ([MS-STANOICAL] V0346: "Outlook uses the first 'text/html' child of a
  'multipart/alternative' parent to replace the DESCRIPTION property"), so an invitation with an event
  would have put the pass link, its address and the QR code into Outlook calendars. The visitor's event
  comes in a short e-mail of its own (`VISITOR_CALENDAR`) that holds no link and no QR code; the notices
  of a new time and of a cancellation never held the pass link.
- **Values are text.** The writer escapes every value (backslash, semicolon, comma, line breaks), removes
  control and direction-control characters, folds lines on octets, and makes a name in `CN` safe as a
  sender's display name is (no quote, angle bracket, backslash or `@` in any compatibility form, B12-20):
  a visitor's name or a purpose cannot add a property, a parameter or an attendee. An address goes into
  `mailto:` with its domain in IDNA form and its local part percent-encoded where a URI may not carry it.
  Carets in a `CN` are doubled (RFC 6868), so a name cannot spell a line break or a quote for a reader
  that decodes them.
- **The organizer is the deployment's sending address** (`EMAIL_FROM`), the same as `From` and the
  envelope, under the company's name: a company cannot make an event come from another address. Each
  event has exactly one attendee, the recipient, asked for no reply (`RSVP=FALSE`). The sending mailbox
  itself is never sent an event, in any spelling of its address (letter case, a `+tag`, Gmail's dots;
  B14-21). On production that mailbox must host nobody and its domain sign with its own DKIM: a release
  gate (production-readiness §15 E, B14-24).
- **The host's event is private** (`CLASS:PRIVATE`, B14-19): a colleague who sees a host's shared
  calendar is shown the time taken, not who visits (Outlook; Google's handling is unverified).
- **E-mail volume is bounded** (B14-15, B14-28): the host's e-mails per acting user and day, the calendar
  events per company and day (one sending mailbox serves every company, and a provider that stops it for
  the day stops every company's invitations). Beyond them the change is made, audited: an e-mail that is
  only the event is left out, a notice goes without its event. The events that take a visit out of a
  calendar are never left out, and each follows a counted event.
- **A switch keeps calendar e-mails off** (`CALENDAR_INVITATIONS_ENABLED`, B14-27) until the sending
  mailbox is a dedicated one whose domain authenticates it (SPF, its own DKIM, DMARC): an unauthenticated
  sender of invitations is what spoofing looks like, to filters and to people. Off, no calendar gets a
  new entry; the calendars that hold a visit are still kept right.
- **A visitor's former address loses the event** (D-19, B14-17): it is sent a CANCEL that uninvites it,
  naming nothing of the visit (no description, no location, a summary "Visit"), with replies never routed
  to the host; a REQUEST still waiting to go there is not sent (B14-29). A cancelled visit always leaves
  the visitor's calendar (B14-16), and the cancellation sent for that reason alone carries no reason
  text, which the canceller did not mean for the visitor (B14-32).
- **`UID`s name nobody** (`visit-<visit id>-visitor`, `visit-<visit id>-host`; RFC 7986 §5.3).
- **Test e-mails carry no event** (B14-14): a sample visit is not put into an administrator's calendar.
- **The app's "Add to my calendar"** (F14-1 … F14-6) builds the host's event in the browser from the
  visit and the company only, never from a pass: no pass link or token in Google's or Outlook's link or in
  the `.ics`, whose name holds the visit's day and nothing about the people. The links open in a new tab
  without an opener or a referrer. Offered to the visit's host only.

What is not prevented: Gmail offers Yes / No / Maybe whatever `RSVP` says, so a recipient's answer reaches
`EMAIL_FROM`'s mailbox (a calendar REPLY: the recipient's address, their answer, the event; no link);
an event added to a calendar keeps what it said when it was sent (a purpose changed later stays as it
was in the calendar until the next new time); a host whose e-mail address changes keeps the event at the
old address; an e-mail left out by a budget leaves that calendar as it was.

*Held by.* `tests/unit/test_email_calendar.py`, `tests/unit/test_smtp.py`, `tests/unit/test_resend.py`,
`tests/integration/test_visit_calendars.py`, `tests/integration/test_smtp_delivery.py`; in the app
`features/visits/hostCalendar.test.ts`, `pages/InviteVisitorPage.test.tsx` and `e2e/flows/calendar.spec.ts`.

---

## 11. Security headers and caching

### 11.1 API responses

Set by `RequestContextMiddleware` (`backend/app/core/middleware.py`) on every response of the API
process, errors included:

| Header | Value | Scope |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | all |
| `Referrer-Policy` | `no-referrer` | all |
| `X-Frame-Options` | `DENY` | all |
| `Cross-Origin-Opener-Policy` | `same-origin` | all |
| `X-Request-ID` | the request's ID | all |
| `Cache-Control` | `no-store` | `/api/v1/*`. Written over whatever a route set, except for **successful** answers under `/api/v1/public/` (Phase 12), which set their own ([§11.4](#114-caching)) |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | `/api/v1/*` (a route may set its own: the e-mail preview documents, and a public brand image, which adds `sandbox`) |
| `Cross-Origin-Resource-Policy` | `same-origin` | `/api/v1/*` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | `/api/v1/*` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | all, **production only** |

No `Server` header is sent (`server_header=False`). **Verified** live (development: all but HSTS) and
in-process with a production configuration (HSTS present).

### 11.2 SPA (nginx)

`deploy/nginx/snippets/security-headers.conf`, included with `always` in every static location. It must
stay identical to `frontend/config/securityHeaders.ts` (which `vite preview` serves);
`node deploy/verify/check_nginx_headers.mjs` fails when they differ (**Verified:** "match … (7 headers)").

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| `Permissions-Policy` | `camera=(self), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

`'wasm-unsafe-eval'` is needed only to compile the self-hosted zxing WebAssembly QR decoder. All scripts,
styles, fonts, icons and the wasm are served from the application's origin; no request leaves it.

The page's colour scheme is set before its first paint by a classic script in `<head>` (Phase 13): it is
a file of the build, `/appearance.js`, not inline code, so the policy needs no `'unsafe-inline'`, hash or
nonce for it. It reads one `localStorage` key (`vms.appearance`: `light` or `dark`, which the appearance
toggle writes; `system`, which an earlier build wrote, and anything else count as no choice) and writes
one attribute on the root element and the `color-scheme` meta;
nothing of a person, a session or a company. It is served like every other file of the build (`no-cache`,
the headers of this section, `application/javascript` under `nosniff`) and precached by the service
worker; `deploy/verify/smoke_test.py` checks its type and caching.
`includeSubDomains` applies HSTS to every subdomain of the configured host name: confirm that all of them
serve HTTPS before going live.

Errors nginx answers itself on `/api/` (413, and 502/503/504 as `503 SERVICE_BUSY` with
`Retry-After: 5`) use the API's JSON envelope and the API's header set
(`snippets/api-error-headers.conf`).

### 11.3 nginx proxy and TLS behaviour

From `deploy/nginx/` (verified in Phase 9 on nginx 1.30.5 for Windows in front of the API in production
mode, 78/78 smoke-test checks, and 81/81 after the API was split into four processes (D9-34, D9-35);
the raw-path routing of D9-36 with 35 raw HTTP/1.1 request targets, not over HTTP/2;
`phase-9-deploy.md`. Re-run on the final configuration in the final release gate of 2026-10-07: 81/81
from two client addresses, and 34 of 34 raw request targets answered by the expected process
([`docs/production-readiness.md` §7.2](production-readiness.md#72-verified-on-this-machine)). **Not**
run inside a container, and not re-run for this document):

- TLS 1.2 and 1.3 only, ECDHE with AEAD ciphers (Mozilla intermediate without DHE), no session tickets,
  HTTP/2. Certificates are mounted read-only, never baked into the image.
- Explicit `server_name`. The default HTTPS server refuses the TLS handshake for unknown SNI or IP
  access (`ssl_reject_handshake on`); unknown `Host` headers get no answer (444). Plain HTTP for the real
  names redirects to HTTPS.
- `server_tokens off`; `X-Forwarded-For` and `X-Request-ID` overwritten; `Forwarded`, `X-Real-IP`,
  `X-Forwarded-Host/Port/Prefix` cleared; `Upgrade`/`Connection` never forwarded; `X-Accel-*` from the
  API ignored.
- `gzip off` on `/api/` (responses mix one-time pass links with reflected input: BREACH). Static files
  are compressed.
- Access log: JSON with `$uri` and the path without query string; never `$request`, `$args` or the
  referer. `api_pool` records which API group answered.
- API requests are shared out by an exact match on the method and the path exactly as the client sent
  it (`$vms_api_pool` on `$vms_request_path`, not on the normalised `$uri`; D9-36). nginx forwards that
  same path, and the API dispatches on it. Only the six routed GET reads, spelled as the API routes
  them, go to the read processes. Every other spelling of those paths (percent-encoded, `.` or `..`
  segments, doubled or trailing slashes), every sign-in, every write and every other request goes to
  the main process, where all budgets but `api_per_user` are counted ([§9.1](#91-design)). nginx
  compares map keys without regard to case, so `/api/v1/Reception/today` reaches a list replica. The
  API's routes are case-sensitive, so it matches no route there and gets a 404 before authentication.
- Phase 12: the platform owner's brand and e-mail-text endpoints and the three public identity endpoints
  are not in the routing map: all of them go to the main process, which counts their budgets
  (`deploy/verify/test_api_instances.py` lists each one). The upload of a brand image has a location of its
  own nested in `/api/`, for exactly that route's paths, with `client_max_body_size 512k` (the API's
  limit). nginx matches locations on the normalised path and cannot tell the method: it is the outer bound
  only, and the API, which decides on the path it receives and on the method, refuses everything above
  64 KiB that is not this upload. nginx adds no caching header to API answers and keeps no copy of them.
- **Uploads in progress** (B12-18). That location also counts: 8 uploads at a time on the site
  (`limit_conn vms_brand_upload 8`) and 4 from one client address (`limit_conn vms_brand_upload_client 4`);
  one more gets 503 in the API's envelope with `Retry-After: 5`. nginx takes a place before the API has
  said who is asking, so the rule is that **no request keeps a place without being signed in**:
  - `proxy_request_buffering off` (there only): the request goes to the API as soon as its header is
    read. The API answers 401, 403 or 415 without reading a byte of the body
    ([§10.4](#104-a-companys-identity-uploads-the-colour-and-the-public-endpoints-phase-12)), so a
    request that is not the platform owner's is over in milliseconds. As first built, nginx read the whole
    body before the API saw the request, and `client_body_timeout` is only the longest pause between two
    reads: the security review held all eight places with eight anonymous connections that sent one byte
    every five seconds, and the platform owner's uploads and removals answered 503 for as long as the
    connections stayed.
  - `lingering_close off` (there only): with nginx's default, a request whose body nginx did not read to
    the end is kept, with its place, for up to 30 seconds after the answer as long as the client keeps
    sending. With request buffering off alone, connections that sent a byte a second and were opened
    again when they ended still held every place (measured). Now the connection is closed with the answer.
  - The keys of both counts are empty for every method but `PUT` (a `map` on `$request_method`), and
    nginx counts nothing under an empty key: `DELETE` on the same path removes an image and is never
    refused because uploads are in progress.
  - nginx holds no body: at most 64 KiB of one are on their way (`client_body_buffer_size`), nothing is
    written under `/tmp`. The API bounds a slow body itself: all of it within 30 seconds, else 408
    ([§9.3](#93-other-resource-limits)).

  What remains. Someone signed in to the platform can keep a place for as long as their body arrives (30
  seconds at the most per request). A flood of requests nobody is signed in for takes places only for
  the milliseconds each needs to be answered (measured: 2 to 42 ms, median 6 ms): to fill eight places
  that way takes the kind of load that the one main API process, which answers every one of them,
  would feel on every request. The count per address tells IPv6 addresses apart in full, so a client
  with a routed prefix has many; the site's count bounds them together. And over HTTP/1.1 a client that
  is refused before its body was read may see the connection reset instead of the answer (nginx closes
  while the client is still sending): browsers speak HTTP/2 to this nginx, where only the stream ends.
- Verified with nginx 1.30.5 for Windows. On 2026-10-13, Phase 12 as first built: `nginx -t` on the
  canonical rendering, 46 checks of the limits, the bound on uploads, the routing and the caching headers
  against stand-in upstreams, 28 checks of the whole flow against three API processes, and the smoke test
  (78/78). The same day after B12-18: `nginx -t` on both renderings; the review's attack before and after
  (HTTP/1.1 and HTTP/2), 62 checks against stand-in upstreams, the 28 checks of the whole flow, 19 checks
  of what someone signed in meets (sizes, a chunked upload, the 408, a sender that goes away, the count
  per address, a removal meanwhile), and the smoke test (79/79); the record is in
  [`phase-12-backend.md`](decisions/phase-12-backend.md).

### 11.4 Caching

| Resource | `Cache-Control` |
|---|---|
| API responses | `no-store` |
| A company's brand image under the address of its current version (`…/brand/{kind}.png?v=<version>`) | `public, max-age=31536000, immutable` (a new image has a new address) |
| The same image under any other address | `public, max-age=60` |
| A company's public identity and its web app manifest | `no-cache`, with an `ETag` |
| Errors of those three endpoints (404, 422, 429) | `no-store` |
| `index.html` and every SPA fallback (deep links, `/pass`, `/reset-password`) | `no-store` (no copy of a signed-in page outlives the session) |
| `sw.js`, `sw-precache-manifest.js`, `appearance.js`, favicon, icons, web manifest | `no-cache` |
| `/assets/*` (content-hashed) | `public, max-age=31536000, immutable` |

The service worker never intercepts `/api` and caches only the versioned static build.

---

## 12. Secrets management

### 12.1 Inventory

| Secret | Used for | Where it lives (Compose deployment) | Rotation |
|---|---|---|---|
| `SECRET_KEY` | HMAC key of device-trust cookies; derivation of rate-limiter keys. **Not** used for sessions, CSRF, reset or pass tokens (those are random and stored as hashes) | `deploy/env/backend.env` | Restart the API. Ends every browser's device trust (users sign in normally); sessions stay valid |
| Runtime DB password (`vms_app`, in `DATABASE_URL`) | API connections | `backend.env` | `ALTER ROLE vms_app PASSWORD …` **and** `ALTER ROLE vms_app RESET ALL` (+ `… IN DATABASE vms RESET ALL`), update the URL, restart the API |
| Owner DB password (`vms_owner`, in `MIGRATION_DATABASE_URL`) | Migrations, `prune-sessions` | `migrate.env` only; never in the API container | `ALTER ROLE vms_owner PASSWORD …`, update the URL |
| `POSTGRES_PASSWORD` | PostgreSQL superuser; reachable only over the container's local socket | `postgres.env` | `ALTER ROLE postgres PASSWORD …` |
| `RESEND_API_KEY` | E-mail delivery | `backend.env` | Rotate at the provider, restart the API |
| `SMTP_PASSWORD` (with `SMTP_USERNAME`) | E-mail delivery with `EMAIL_PROVIDER=smtp`. A `SecretStr`: masked in `repr`, never in a log record, an error message (`last_error`, the CLI's output) or an audit row; sent only inside TLS (STARTTLS, which must be offered, or implicit TLS), to a server whose certificate matches `SMTP_HOST` (`ssl.create_default_context()`); `SMTP_SECURITY=none` takes no credentials and is refused in production. For Gmail an App Password of a dedicated account, never the account password | `backend.env` | Revoke the App Password (or change the password) at the provider, set the new one, restart the API, check with `send-test-email` |
| TLS certificate and key | nginx | `deploy/tls/` mounted read-only (key readable by group 101) | Replace, `nginx -s reload` |
| `SEED_DEMO_PASSWORD` | Development seeds only | **Never set in production** (seeding is refused there anyway) | — |

Stored per user, never in clear: password hashes (Argon2id); session, CSRF, reset and pass tokens
(SHA-256).

Rules:

- `deploy/env/*.env`, `deploy/tls/`, `.env` and `.local/` are git-ignored; the templates
  (`*.env.example`, `.env.example`) ship empty secrets. `docker-compose.yml` uses no `${…}`
  interpolation, and no `.env` can enter an image (allowlist `.dockerignore`).
- The settings loader masks secrets (`SecretStr`) and never echoes a rejected value
  (`hide_input_in_errors=True`). Startup refusals name the setting, never its value. A failed database
  connection at startup reports the driver error's class and SQLSTATE only, because libpq messages can
  quote parts of the URL (SEC-36).
- Passwords never go on a command line: `create-admin` prompts or reads `--password-stdin`; the
  PostgreSQL provisioning script passes them through psql's environment.
- The API reads its secrets from environment variables (in Compose: the env files above); it does not
  read `*_FILE` variables. "Restart the API" in the table above means recreating all four API
  containers with `docker compose up -d`: `docker compose restart` keeps the old environment
  (`deploy/README.md` §2). The PostgreSQL provisioning script `10-vms-roles.sh` also accepts
  `VMS_OWNER_PASSWORD_FILE` / `VMS_APP_PASSWORD_FILE` (Docker secrets). Where the platform offers a
  secret manager, inject the variables from it at run time instead of keeping plain files on the host.
- `python deploy/verify/check_release_tree.py` fails when the files `git add -A` would commit contain
  outbox e-mails, raw pass or reset links, cookie values, private keys, `.env` files or database dumps.
  **Verified:** "OK … files that would be committed: no development artefact or credential" (the file
  count follows the working tree: 760 when this document was written, 765 at a re-check the same day).

### 12.2 Generating secrets

`SECRET_KEY` (production needs at least 43 characters and passes an entropy estimate; this gives 64):

```sh
# Linux / macOS
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

```powershell
# Windows (any Python 3; the backend venv works)
.\backend\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

Database passwords: at least 24 characters (`10-vms-roles.sh` refuses shorter ones). `token_urlsafe`
output (`A–Z a–z 0–9 _ -`) needs no percent-encoding inside a database URL:

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(32))"      # Linux
```

```powershell
.\backend\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"   # Windows
```

If a password contains any of `@ : / ? # [ ] %`, percent-encode it in the URL
(`urllib.parse.quote(password, safe='')`); an ambiguous URL is refused at startup.

### 12.3 Production configuration refusals

With `APP_ENV=production` the API (and every CLI command) refuses to start when any of the following
holds (`_check_production` in `backend/app/core/config.py`, plus the startup database check):

| Area | Refused |
|---|---|
| Environment | `APP_ENV` missing (it has no default) |
| Secret | `SECRET_KEY` empty or the development default; shorter than 43 characters; fewer than 10 distinct characters; contains a placeholder marker (`change-me`, `example`, `replace`, `placeholder`, …); estimated below 128 bits (words, dates, keyboard walks, repetitions); one of the two keys the test suite once contained (quoted in the audit report) |
| Cookies and limits | `COOKIE_SECURE=false`; `RATE_LIMIT_ENABLED=false`; guessing or recovery limits above 10× their default; bucket caps below 1/10 of their default |
| Platform owner (Phase 11) | `PLATFORM_SESSION_MAX_AGE_HOURS` above 12 or `PLATFORM_SESSION_IDLE_MINUTES` above 60 (B11-6) |
| E-mail | `EMAIL_PROVIDER` `outbox` or `memory`; `EMAIL_FAIL_DOMAIN` set; `smtp` with `SMTP_SECURITY=none`. In every environment: `resend` without `RESEND_API_KEY`; `smtp` without `SMTP_HOST`, with only one of `SMTP_USERNAME` and `SMTP_PASSWORD`, with credentials over `none`, with non-ASCII credentials or with an `EMAIL_FROM` that holds no address; an `SMTP_HOST` that is not a host name or IP address, whatever the provider |
| Names (Phase 10) | `PRODUCT_NAME_AR`/`_EN` and `BRAND_NAME_AR`/`_EN` that are not one line of visible text of 1–60 characters (controls, direction and zero-width marks, line and paragraph separators and unassigned characters are refused), in every environment |
| URLs | `APP_BASE_URL`, `QR_BASE_URL` or any `ALLOWED_ORIGINS` entry not `https`; `*` in `ALLOWED_ORIGINS` (refused in every environment); base URLs with a path, query or credentials (every environment) |
| Proxies | `TRUSTED_PROXIES` wider than /8 (IPv4) or /32 (IPv6) |
| Database URLs | Ambiguous URLs (every environment); the runtime URL using the owner's role (also via `?user=` or `PGUSER`); a published local-development password (in the URL, `?password=`, `PGPASSWORD`, and at startup a password file or service entry); a remote database without `sslmode=verify-full` or `verify-ca` (in the URL itself when a connection service is used), unless `DB_REQUIRE_TLS=false` |
| Database role (at startup) | Any problem of [§15.3](#153-startup-privilege-check-production) |
| Demo accounts (at startup, Phase 11 review) | A seed account in the database: the platform owner's `platform@demo.local` or a user of the demo companies, created by `seed-demo` / `seed-e2e` with a published password that never has to be changed (B11-36, below) |

**Demo accounts** (B11-36). The seed commands refuse to run with `APP_ENV=production`, which guards only
the process that seeds: a database seeded before it became production's, a demo database restored over
it, or a seed run from a workstation whose `DATABASE_URL` names the production database would leave
`platform@demo.local` / `Demo-Visitor-2026`, an account above every company, in production. Therefore:

- the API refuses to start in production while a seed account exists (after the role check, with a
  message that names the accounts by the seeds' published addresses and nothing read from the database);
- both sign-ins refuse a seed account in production (`401 INVALID_CREDENTIALS`, audited
  `reason = "seed_account"`), which covers a seed run while the API is up;
- a seed account is recognised by its **ID**, which the seeds derive from a fixed namespace and the
  account's address. No other code path produces such an ID and no API lets anyone choose one, so the test
  is exact and no tenant can plant a row that stops the platform from starting. The reserved addresses
  (`@demo.local`, `@other.local`) are deliberately not the test: any company's administrator can create a
  user with such an address, and an address says nothing about the password behind it;
- existence counts, not activity: a deactivated seed user can be reactivated by its company's
  administrator.

Removing a seed's rows from a production database that was seeded by mistake is described in
[`production-readiness.md` §13.5](production-readiness.md#135-demo-accounts-in-a-production-database).

**Pre-flight check of a configuration** (reads the environment and the repository's `.env` files the
same way the API does; does not connect to the database). **Verified** on Windows and Git Bash: a
development configuration with `APP_ENV=production` was refused with a list of problems and no values;
a complete production-like configuration printed "configuration OK"; `TRUSTED_PROXIES=0.0.0.0/0` and
`sslmode=require` to a remote host were refused.

```sh
# Linux (from backend/, with the production variables exported)
APP_ENV=production python -c "from app.core.config import get_settings; get_settings(); print('configuration OK')"
```

```powershell
# Windows PowerShell (from backend\)
$env:APP_ENV = 'production'
.\.venv\Scripts\python.exe -c "from app.core.config import get_settings; get_settings(); print('configuration OK')"
Remove-Item Env:APP_ENV
```

In Windows PowerShell 5.1, assigning an empty string to `$env:NAME` removes the variable, so the value
from `.env` applies instead; test an empty value from Git Bash or a file. In the Compose deployment the
equivalent is `docker compose run --rm --no-deps backend python -c "…"` (**not verified**: no Docker on
the build machine). The startup database check ([§15.3](#153-startup-privilege-check-production)) runs
only when the API itself starts in production mode.

---

## 13. Logging and PII rules

Source: `backend/app/core/logging.py`, `RequestContextMiddleware`.

| Rule | Implementation |
|---|---|
| Format | JSON lines on stdout (`LOG_JSON=true`), one per record, with `request_id` |
| Access log | The application's own: method, path **without query string**, route template, status, duration, client IP, `user_id`, `company_id`. uvicorn's access log is disabled |
| No PII or secrets | No names, e-mail addresses, phone numbers, purposes, reasons, passwords, tokens, cookies or user agents in API log lines. Values under keys matching `pass(word)`, `token`, `secret`, `cookie`, `authorization`, `csrf`, `api_key`, `credential` are replaced by `[REDACTED]` wherever they appear in structured fields |
| Database details | `sqlalchemy.engine` is pinned at WARNING and the engine hides bound parameters. The PostgreSQL `DETAIL` of any error (which quotes row values) is replaced by `[redacted]` in formatted exceptions |
| Inert lines | DEL, C1 controls and U+2028/2029 are escaped; characters the stream cannot encode are escaped, never dropped |
| Protocol loggers | `uvicorn`, `uvicorn.error` and `websockets` never log below INFO, even with `LOG_LEVEL=DEBUG`; the server runs with `ws="none"` so a WebSocket handshake cannot log headers or query strings (SEC-45) |
| Tokens | Pass and reset tokens travel in URL fragments, which never reach a server log |

**Verified:** after sign-ins (successful, failed, unknown address), a sign-in with
`?email=…&token=…` in the query string, and two forgot-password requests, the API log contained no
e-mail address, password or query string.

**nginx logs** (Compose) contain the client address, user agent, host, path without query string,
the request ID and the API group that answered (`api_pool`). nginx **error** lines (level `error`) can
quote a failed request's request line, **query string included**; treat nginx error logs as sensitive
in the log pipeline.

**Application logs and the audit trail contain personal data** in the regulatory sense (client IP
addresses, user IDs, user agents in audit rows). Apply the same access control and retention to the log
store and SIEM as to the database.

---

## 14. Data minimisation and retention

### 14.1 What is collected

| Data | Where | Required? |
|---|---|---|
| Visitor name | `visitors.full_name`; snapshot in `visits.visitor_name` | Yes |
| Visitor e-mail | `visitors.email` | Only to send an invitation (D-16) |
| Visitor phone, organisation | `visitors.phone` (+ derived `phone_digits`), `visitors.company_name`; organisation snapshot in visits | No |
| Derived search text | `visitors.search_text` (folded name, e-mail, organisation) | Derived |
| Visit details | `visits`: purpose, schedule, host and department snapshots, check-in/out times and staff, reasons and notes for overrides, corrections, cancellations and walk-ins | Purpose required; notes required only for exceptions |
| Staff | `users`: name, e-mail, optional phone (shown to reception), password hash, roles, last sign-in, and (Phase 10) the interface language `preferred_language` (`ar`, `en` or none) | Yes; the language is optional |
| Sessions | `user_sessions`: IP address, user agent (≤ 400 characters), times | Yes |
| Reset requests | `password_reset_tokens`: requesting IP, token hash, times | Yes |
| E-mail log | `email_messages`: recipient address, subject, status, sanitised error. **Bodies and links are never stored.** Subjects contain the company name (visitor e-mails in both languages); host-arrival subjects contain the visitor's name | Yes |
| Audit trail | `audit_logs`: IDs, enums, counts, IP address, user agent, request ID | Yes |

**Not collected:** national ID or document numbers, photos, biometric templates (no image, crop,
embedding or template of a person is received, stored or logged, Visitor Journey included), dates of
birth, signatures or vehicle data; there is no custom-field mechanism.

**Visitor Journey (Phase 15; off by default).** With an external tracking provider configured
(`TRACKING_PROVIDER`; `disabled` by default and in production) and allowed and enabled for a company, the
application stores, per enrolled visit: a random association reference, its lifecycle, and the **floor and
zone observations** the provider reports (`visitor_journey_events`: time, camera, building, floor, zone,
the provider's match judgement and confidence). That is **personal movement data**: it is kept for the
company's `journey_retention_days` (1–90, default 30; `cli prune-journeys`), read only by administrators,
management and reception (hosts get 403), and every opening of a visit's journey is audited
(`JOURNEY_VIEWED`, at most once per user and visit an hour), as is reading the day's list when it shows
anyone's location (`JOURNEY_LIST_VIEWED`, at most once per user an hour). Rejected events are counted,
never stored: unknown people (refs), unknown cameras, and every sighting of an association the provider
never activated (still PENDING, or ended without ever being active), which binds nobody; the journey and
its timeline ignore any such event. The provider processes camera images on its side, under its own
policy; enrollment is a binding request (a reference and a camera ID), never an image. Provider keys are
stored as SHA-256 digests and shown once; refs, keys and event payloads are never logged. No real provider
is connected (BLOCKED BY ENVIRONMENT). Real use requires the privacy owner's approval (purpose, lawful basis
under Jordan's PDPL, notice, access, retention) and an evaluation-based confidence threshold
([production-readiness.md](production-readiness.md) §15 J); see
[visitor-journey-design.md](visitor-journey-design.md) §6. A QR code carries only the pass link
(`{QR_BASE_URL}/pass?c=<slug>#<token>`: the company's public slug and the token), never personal data. The e-mails load nothing remote, so opening one
tells no third party that it was read. Request models refuse unknown fields, so a client cannot store extra
data. Free text exists only in the fields listed above (purpose, reasons, notes, company address).

### 14.2 Lifecycle as implemented

| Data | Lifecycle in the product |
|---|---|
| Visitors and visits | **Never deleted** (D-12). The runtime role has no `DELETE` privilege. Visitor edits overwrite the visitor row; visit snapshots are frozen from check-in, and checked-out or cancelled visits cannot be updated by any role (`visits_terminal_immutable`) |
| Staff accounts, departments | Deactivated, never deleted |
| Sessions | Revoked or expired rows remain until `python -m app.cli prune-sessions` deletes those that ended more than N days ago (default 30, minimum 1; runs as the schema owner) |
| Visitor journeys (Phase 15) | Journey events are append-only (no UPDATE for the runtime role, a trigger refuses it for anyone). `python -m app.cli prune-journeys` (schema owner) deletes events observed, and ended associations that ended, more than the company's `journey_retention_days` ago (default 30, 1–90). Rejected events (sightings of an association the provider never activated among them) are never stored |
| Reset tokens | Remain (hash, times, requesting IP); no prune command |
| E-mail log | Remains |
| Audit trail | Append-only; neither the runtime role nor the owner can update or delete rows while the trigger is enabled ([§8.4](#84-immutability)); no prune command |
| Backups | `scripts/backup.sh --retention-days N` (PowerShell: `scripts/backup.ps1 -RetentionDays N`) deletes older archives of the same database, always keeping the newest |
| Development outbox | Files with raw pass and reset links; development and E2E only (production refuses the provider) |

**Verified** (`prune-sessions`): `--older-than-days 30` ran and reported the count; `--older-than-days 0`
was refused ("the retention period must be at least one day", exit 2).

```sh
# Compose deployment (weekly; from deploy/README.md; not verified here: no Docker)
docker compose run --rm migrate python -m app.cli prune-sessions --older-than-days 30
```

```powershell
# Local/Windows, with MIGRATION_DATABASE_URL set (from backend\)
.\.venv\Scripts\python.exe -m app.cli prune-sessions --older-than-days 30
```

### 14.3 Retention guidance

The product does not yet implement visitor anonymisation or audit archiving (audit residual R-13,
recommendation 13). Before go-live, the data controller should decide and document:

1. **Retention periods** for visitor records and visit history, the audit trail, sessions and reset
   metadata, e-mail logs, application and nginx logs, and backups. Banks and public bodies usually have
   sector rules for access logs; align with them.
2. **Session pruning:** schedule `prune-sessions` (the runbook's example is weekly) with the chosen
   period.
3. **Removing a visitor's personal data** (erasure requests, end of retention): there is no supported
   tool yet. Because visit history and audit rows are protected at the database level for every role
   while the triggers are enabled, any removal is a privileged change to be designed, reviewed, executed
   as the schema owner and recorded; it is not an ad hoc SQL task. Plan the anonymisation feature
   anticipated in contract §12 if erasure requests are expected.
4. **Backups** hold everything above, including password hashes: encrypt them, keep them off-host and
   delete them on the same schedule.
5. **Collect less:** leave optional visitor fields (phone, organisation, e-mail when no invitation is
   needed) empty where the site does not need them, and keep visit purposes and notes factual. They are
   shown to reception, hosts and on the evacuation list.

---

## 15. Database role model

### 15.1 Roles

| Role | Attributes | Used by | Privileges |
|---|---|---|---|
| `vms_owner` (schema owner) | `LOGIN` (development cluster also `CREATEDB` and membership in `vms_app`, for the test harness; the Compose script creates neither) | Alembic migrations, `prune-sessions`, the test harness | Owns the database, the `public` schema and every table |
| `vms_app` (runtime, `DB_APP_ROLE`) | Plain `LOGIN`; no other attribute; member of no role; no role defaults | The API, CLI commands other than `prune-sessions`, the e-mail dispatcher | `SELECT, INSERT, UPDATE` on the business tables; `SELECT` + column-level `INSERT` (all columns but `seq`) on `audit_logs`; nothing on `audit_logs_seq_seq` or `alembic_version`; `USAGE` on schema `public`; no `CREATE` on the schema or database; no `TEMPORARY`; no `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES` or `MAINTAIN` anywhere |
| `postgres` (superuser) | Superuser | Provisioning, restores, emergencies | Compose: local socket only (`pg_hba.conf` refuses it over the network) |

Provisioning:

- **Development** (`scripts/db.ps1 init`): creates both roles and the databases `vms` and `vms_e2e`
  owned by `vms_owner`; revokes `CREATE` on `public` and `TEMPORARY` from `PUBLIC`.
- **Compose** (`deploy/postgres/initdb/10-vms-roles.sh`, on the first start of an empty volume): both
  roles `LOGIN` only, passwords at least 24 characters, different, never the published development
  ones, passed through the environment (never argv or the server log); the database is owned by the owner;
  `REVOKE ALL ON DATABASE … FROM PUBLIC`, then `CONNECT` for the two roles; schema `public` owned by the
  owner with `USAGE` for the runtime role. `pg_hba.conf`: `scram-sha-256` for the two roles to `vms` only,
  everything else over the network rejected.
- **Table privileges come from the migrations only** (`0001`, `0006`, `0008`), granted to the role named
  by `DB_APP_ROLE`. Migration `0008` also revokes `TEMPORARY` on the migrated database from `PUBLIC` and
  the runtime role. Never `GRANT ALL` and trim: the startup check refuses any privilege beyond the
  migrations' grants.

### 15.2 Connection settings pinned by the application

Every connection the application opens (API, CLI, migrations) sets, as libpq startup options (which
override server, database and role defaults): `timezone=UTC`, `client_encoding=UTF8`, `DateStyle=ISO`,
`IntervalStyle=postgres`, `bytea_output=hex`, `search_path=public`, `transform_null_equals=off`,
`default_transaction_isolation=read committed`, `default_transaction_read_only=off`. The API's and
CLI's runtime connections also set `statement_timeout`, `lock_timeout`, `connect_timeout` and TCP
keepalives; migrations and `prune-sessions` do not get the statement timeout. A leaked runtime
credential therefore cannot make every write fail or weaken the authorization re-checks by planting
role defaults (SEC-37, SEC-38).

**TLS to PostgreSQL:** production requires `sslmode=verify-full` or `verify-ca` for any database not
reached over a Unix socket or loopback (`require` and `prefer` are refused: they accept any
certificate). Add `&sslrootcert=/path/ca.pem` (or `sslrootcert=system`) to both URLs and use `hostssl`
lines in `pg_hba.conf`. `DB_REQUIRE_TLS=false` is an explicit opt-out for a database on a network the
deployment controls end to end; the Compose template uses it for its internal single-host `db` network
(no egress). TLS to PostgreSQL was **not verified** on the build machine (its cluster has `ssl=off`).

### 15.3 Startup privilege check (production)

Source: `backend/app/db/privileges.py`. In production the API's lifespan refuses to serve unless the
connection's **login role** passes an allowlist. The error lists the failing properties only (never role
names, passwords or setting values):

| Property in the error | Meaning |
|---|---|
| `switched_role` | The connection runs as another role (startup option or role default) |
| `superuser`, `bypasses_row_security`, `replicates`, `creates_roles`, `creates_databases` | A role attribute beyond LOGIN |
| `member_of_roles`, `uses_server_files_or_programs` | Any role membership (predefined roles such as `pg_monitor` included) |
| `owns_schema_objects` | Owns a table, sequence, view, function, type or the `public` schema |
| `creates_in_schema`, `creates_schemas`, `creates_temporary_objects` | DDL or temporary objects possible |
| `changes_audit_rows`, `chooses_audit_order` | UPDATE/DELETE/TRUNCATE/TRIGGER on `audit_logs`, or INSERT on `seq` / any privilege on its sequence |
| `deletes_rows`, `maintains_tables`, `adds_triggers`, `references_tables`, `accesses_migration_state`, `holds_unexpected_privileges` | Any table privilege beyond the migrations' grants |
| `not_read_committed` | The connection is not READ COMMITTED |
| (separate messages) | The role has defaults of its own (`ALTER ROLE … SET`); the connection signed in with a published development password |

**Verified** in-process against the throwaway database: `vms_app` had no problem and no role settings;
`vms_owner` was reported with 13 problems (`creates_databases`, `member_of_roles`,
`owns_schema_objects`, `creates_in_schema`, `creates_schemas`, `creates_temporary_objects`,
`changes_audit_rows`, `chooses_audit_order`, `deletes_rows`, `maintains_tables`, `adds_triggers`,
`references_tables`, `accesses_migration_state`).

### 15.4 Checking a database by hand

Save as `check-roles.sql` and run it as the schema owner or superuser. **Verified** against a database
migrated to `0010`; the expected results are in the comments.

```sql
-- 1. Role attributes and memberships (vms_app: all false, member_of {}).
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
       ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
             WHERE m.member = r.oid) AS member_of
FROM pg_roles r WHERE rolname IN ('vms_owner', 'vms_app') ORDER BY 1;

-- 2. Runtime role's table and sequence privileges (business tables INSERT,SELECT,UPDATE;
--    audit_logs SELECT; alembic_version and audit_logs_seq_seq '-').
SELECT c.relname AS relation,
       coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
                FILTER (WHERE a.grantee = 'vms_app'::regrole), '-') AS vms_app
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')
GROUP BY c.relname ORDER BY 1;

-- 3. Column-level INSERT on audit_logs (every column except seq: {vms_app=a/vms_owner}).
SELECT attname, attacl FROM pg_attribute
WHERE attrelid = 'public.audit_logs'::regclass AND attnum > 0 AND attacl IS NOT NULL ORDER BY attnum;

-- 4. Immutability triggers present and enabled (tgenabled = 'O').
SELECT tgname, tgrelid::regclass AS on_table, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;

-- 5. Database ACL: no TEMPORARY ('T') for anyone but the owner.
SELECT datname, datacl FROM pg_database WHERE datname = current_database();

-- 6. No defaults on the runtime role (no rows).
SELECT r.rolname, s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
WHERE r.rolname = 'vms_app';
```

```powershell
# Windows, development cluster
$env:PGPASSWORD = '<owner password>'
& .\.local\pgsql\bin\psql.exe -h localhost -p 5433 -U vms_owner -d vms -X -f check-roles.sql
Remove-Item Env:PGPASSWORD
```

```sh
# Linux, development cluster (psql prompts for the password; verified with Git Bash)
psql "host=localhost port=5433 dbname=vms user=vms_owner" -X -f check-roles.sql
# Linux, a remote production server over verified TLS (standard libpq syntax; not run here)
psql "host=db.example.internal port=5432 dbname=vms user=vms_owner sslmode=verify-full" -X -f check-roles.sql
# Compose deployment (not verified here: no Docker)
docker compose exec -T postgres psql -U postgres -d vms -X -f - < check-roles.sql
```

Append-only proof as the runtime role (each statement must fail; nothing is changed):

```sh
psql "host=localhost port=5433 dbname=vms user=vms_app" -X \
  -c "UPDATE audit_logs SET action = action WHERE false" \
  -c "DELETE FROM visits WHERE false" \
  -c "CREATE TEMP TABLE probe (x int)"
# ERROR: permission denied for table audit_logs
# ERROR: permission denied for table visits
# ERROR: permission denied to create temporary tables in database "vms"
```

```powershell
$env:PGPASSWORD = '<runtime password>'
& .\.local\pgsql\bin\psql.exe -h localhost -p 5433 -U vms_app -d vms -X -c "UPDATE audit_logs SET action = action WHERE false"
Remove-Item Env:PGPASSWORD
# psql.exe : ERROR:  permission denied for table audit_logs   (PowerShell reports it as a NativeCommandError)
```

---

## 16. Production hardening checklist

"Enforced" means the API refuses to start otherwise; everything else is the operator's responsibility.
Items 1–9 should be complete before any production traffic.

| # | Item | Enforced? | Reference |
|---|---|---|---|
| 1 | `APP_ENV=production` | Yes (required setting) | [§12.3](#123-production-configuration-refusals) |
| 2 | `SECRET_KEY` generated with `secrets.token_urlsafe(48)`, stored in a secret store, never in images or the repository | Strength yes; storage no | [§12](#12-secrets-management) |
| 3 | HTTPS everywhere: `APP_BASE_URL`, `QR_BASE_URL`, `ALLOWED_ORIGINS` https; `COOKIE_SECURE=true`; certificate from a trusted CA; reception tablets on the LAN also use HTTPS (camera needs a secure context) | URLs and cookies yes | [§4.2](#42-cookies), [§11.3](#113-nginx-proxy-and-tls-behaviour) |
| 4 | `ALLOWED_ORIGINS` lists exactly the public origin(s) | `*` and http refused | [§4.3](#43-csrf-and-origin-enforcement) |
| 5 | Reverse proxy as shipped in `deploy/nginx/` (headers, `X-Forwarded-For` overwrite, request ID, no Upgrade, `$uri` logs, `no-store` shell, 64 KiB body limit); `TRUSTED_PROXIES` = the proxy's own address only | Catch-all proxies refused | [§9.4](#94-client-ip-and-trusted-proxies), [§11](#11-security-headers-and-caching) |
| 6 | Run `deploy/verify/smoke_test.py` against the deployed stack after every deployment | No | [§17](#17-checking-the-controls) |
| 7 | Database: separate owner and runtime credentials; runtime role exactly as migrated (plain LOGIN, no memberships, no defaults); owner URL only in the migration container | Runtime role: yes (startup check). Keeping the owner URL out of the API container: no | [§15](#15-database-role-model) |
| 8 | Database TLS with `sslmode=verify-full` and a pinned CA for any database off the host (or `DB_REQUIRE_TLS=false` only for the single-host internal network) | Yes, unless `DB_REQUIRE_TLS=false` | [§15.2](#152-connection-settings-pinned-by-the-application) |
| 9 | Exactly one main API process (`backend`: no replicas, no extra workers, no `docker compose up --scale`) until a shared rate limiter exists; further processes only for the GET reads nginx routes to them, as Compose ships them, with the same env file and no overrides beyond `PASSWORD_HASH_CONCURRENCY`, `DB_POOL_SIZE` and a lower `RATE_LIMIT_API_PER_MINUTE` if one is chosen (then also added to the compose test's allow-list); the per-process budgets this leaves signed off by the security owner | No (`app.serve` fixes one worker per process; `deploy/verify/test_api_instances.py` fails if the compose file replicates `backend`, or if a read service changes `backend`'s image, command or env file or sets an `environment` key other than `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE` (D9-37); it cannot see a command-line `--scale`) | [§9.1](#91-design) |
| 10 | `EMAIL_PROVIDER=resend` with a key, or `smtp` over TLS with a dedicated sending account; SPF, DKIM and DMARC on the sending domain so invitations and reset e-mails cannot be convincingly spoofed; `QR_BASE_URL` the public https origin | Provider and TLS yes; DNS no | Audit recommendation 12 |
| 11 | `LOG_LEVEL=INFO`, `LOG_JSON=true`; logs shipped to a SIEM with access control; nginx error logs treated as sensitive | No | [§13](#13-logging-and-pii-rules) |
| 12 | Alerts on: `AUTH_ACCOUNT_THROTTLED`; summary rows with `overflow: true`; spikes of `CSRF_FAILED`, `RATE_LIMITED`, `ACCESS_DENIED` (incl. `reason: session_ended`); spikes of 429 per API pool (`api_pool` in the nginx access log); `503 SERVICE_BUSY`; FAILED or long-PENDING e-mails; startup refusals; unexpected restarts of any of the four API processes (a restart of the main process resets all budgets); audit-table growth | No | Audit recommendations 5 and 6 |
| 13 | Schedule `prune-sessions`; decide retention periods; encrypted off-host backups with a quarterly restore drill | No | [§14](#14-data-minimisation-and-retention), `deploy/README.md` |
| 14 | Credential rotation procedure includes `ALTER ROLE vms_app RESET ALL` (and `… IN DATABASE vms RESET ALL`); Alembic downgrades only with the API stopped | Role defaults refused at startup | [§12.1](#121-inventory) |
| 15 | Keep limits within their defaults unless measured otherwise; never set `SEED_DEMO_PASSWORD` | Guessing limits capped at 10× | [§9.2](#92-budgets-and-their-settings) |
| 16 | Session lifetime policy: `SESSION_MAX_AGE_HOURS` (default 12, max 720) and `SESSION_IDLE_MINUTES` (default 240, max 1,440) fit your policy; shorter idle times for shared desks | Field bounds only | [§4.1](#41-session-model) |
| 17 | Shared reception tablets and kiosks run a managed browser policy: Chrome/Edge `SavingBrowserHistoryDisabled` and `SyncDisabled`; `RestoreOnStartup` not set to restore the last session; `ClearBrowsingDataOnExitList` covering browsing history, cookies and session storage; or a guest, kiosk or ephemeral profile. One profile per person where possible. Staff sign out explicitly; the idle timeout is a backstop | No | Audit recommendation 9 |
| 18 | Accurate time (NTP) on the API and database hosts: token, session and pass windows depend on the clock | No | — |
| 19 | Volumetric DDoS protection upstream of nginx (load balancer, WAF or provider) | No | [§2.3](#23-assumptions-and-out-of-scope) |
| 20 | Supply chain in CI: `pip install --require-hashes --no-deps`, `npm ci`, `pip-audit`, `npm audit`, image scanning, SBOM; re-run `scripts/lock_hashes.py` after any pin change; keep base-image tag and digest updated together | Hash-pinned install in the Dockerfile | Audit recommendation 8 |
| 21 | Before a release: `check_release_tree.py` exits 0; `check_nginx_headers.mjs` in sync | No | [§17](#17-checking-the-controls) |
| 22 | Independent penetration test of the deployed stack (incl. Safari/iPadOS and Firefox on tablets); consider MFA/SSO for administrators | No | Audit recommendations 7, 11 |
| 23 | Platform owner (Phase 11): create the account with `create-platform-admin` on the server (the generated password is printed once: hand it over, change it at the first sign-in); recover a lost or locked account with `--reset` and a generated password, never `--password-stdin` for an account under attack; keep at least two platform accounts; alert on platform `AUTH_ACCOUNT_THROTTLED`, `COMPANY_DEACTIVATED`, `PLATFORM_ADMIN_PASSWORD_SET` and `USER_CHANGE_REFUSED`; `PLATFORM_SESSION_*` within policy | Session ceilings yes | [§3.7](#37-the-platform-owner-phase-11) |
| 24 | Never seed the production database (`seed-demo`, `seed-e2e`), and never restore a demo database over it: start from `alembic upgrade head`, `create-platform-admin` and `create-admin` | Yes: the API refuses to start while a seed account exists, and refuses its sign-in | [§12.3](#123-production-configuration-refusals) |

---

## 17. Checking the controls

| Check | Command | Status on the build machine |
|---|---|---|
| Configuration pre-flight | [§12.3](#123-production-configuration-refusals) | **Verified** |
| Database roles and append-only rules | [§15.4](#154-checking-a-database-by-hand) | **Verified** (development cluster) |
| nginx headers match the SPA list | `node deploy/verify/check_nginx_headers.mjs` | **Verified** |
| Release tree free of artefacts and credentials | `python deploy/verify/check_release_tree.py` (Linux: `python3`) | **Verified** |
| Deployed stack (headers, caching, TLS, body limit, unknown hosts, client address, request ID, one check per API service) | `python3 deploy/verify/smoke_test.py --base-url https://vms.example.com --http-url http://vms.example.com` | Needs a deployment. Against nginx for Windows: 78/78 in Phase 9, 81/81 with the four API processes, and 81/81 on the final configuration in the final release gate (2026-10-07) and in the Phase 10 gate (2026-10-08, with the SMTP provider configured). **Not run for this document** |
| Backend security test subset | see below | **Verified**: 1,105 passed in the final release gate (2026-10-07), the 28 files below. The 27 files without `test_routed_reads.py` passed 1,044, for this document and again in that gate. The subset was not run on its own for Phase 10; every file of it is part of the full suite, which passed on 2026-10-08 (2,971 passed; 2,974 after the gap closure). |

Security-focused backend tests. They run in a development or CI environment, not against production:
the harness creates and drops its own throwaway database through `MIGRATION_DATABASE_URL`, whose role
needs `CREATEDB` (the development cluster's `vms_owner`, as created by `scripts/db.ps1`, has what the
harness needs).

```sh
cd backend
.venv/bin/python -m pytest -q \
  tests/unit/test_permissions.py tests/unit/test_csrf_middleware.py tests/unit/test_passwords.py \
  tests/unit/test_tokens.py tests/unit/test_device_trust.py tests/unit/test_config.py \
  tests/unit/test_privilege_allowlist.py tests/unit/test_logging.py tests/unit/test_security_audit.py \
  tests/unit/test_rate_limit.py tests/unit/test_client_ip.py tests/unit/test_secret_strength.py \
  tests/unit/test_audit_metadata.py tests/unit/test_body_limit.py \
  tests/integration/test_csrf.py tests/integration/test_rbac.py tests/integration/test_rbac_reception.py \
  tests/integration/test_rbac_visits.py tests/integration/test_database_rules.py \
  tests/integration/test_runtime_privileges.py tests/integration/test_sessions.py \
  tests/integration/test_tenant_isolation_reception.py tests/integration/test_device_trust.py \
  tests/integration/test_log_hygiene.py tests/integration/test_http_behaviour.py \
  tests/integration/test_security_events.py tests/integration/test_stale_authorization.py \
  tests/integration/test_routed_reads.py
```

`test_routed_reads.py` (61 tests) checks that the six GET reads nginx sends to the read processes
consult only `api_per_user` ([§9.1](#91-design)). The Phase 10 controls have tests of their own, all
part of the full suite: `tests/integration/test_preferences_api.py` (every role, CSRF and Origin, the
forced-change screen, own row only, no audit row, the per-user budget), `tests/unit/test_smtp.py`
(TLS and certificate checks, the deadline, header injection through every user-controlled field, no
credential in any log, error or exception chain), `tests/integration/test_smtp_delivery.py`,
`tests/unit/test_email_bidi.py` and `test_email_templates.py` (escaping and isolation of values), and
`tests/unit/test_field_codes.py` with `tests/integration/test_field_codes_api.py`. On Windows use
`.\.venv\Scripts\python.exe -m pytest -q` with the same file list (PowerShell line continuation is a
backtick, or put the list on one line). The full gate (`ruff check .`, `ruff format --check .`,
`mypy`, `pytest`, `pytest --committed-first`) covers everything; its last results are in
[`docs/production-readiness.md` §10.1](production-readiness.md#101-final-results-phase-10-gate-2026-10-08).

---

## 18. Verification status

**Run for this document on 2026-10-06** (Windows 11, PostgreSQL 18.6, throwaway database
`vms_secdoc_*` migrated to `0010` and seeded with `seed-e2e`, API via `python -m app.serve` in
development mode on a dedicated port with `COOKIE_SECURE=true`; the database was dropped and the server
stopped afterwards):

- Cookie names and attributes on sign-in; logout requires the CSRF token, revokes the session and clears
  the cookies.
- CSRF matrix (no token, wrong token, foreign Origin, `Origin: null`, cross-site, valid); `text/plain`
  sign-in 422; preflight 405 without CORS headers.
- Sign-in throttle (sixth failure 429, `Retry-After: 300`); identical 401 for an unknown address; audit
  row contents.
- RBAC spot checks for RECEPTIONIST, MANAGEMENT, EMPLOYEE and both tenants' administrators;
  cross-tenant user ID → 404 identical to a random ID.
- Pass issuance (URL shape, token in fragment, 43 characters), one-time `pass_url`, scan READY,
  cross-tenant scan `PASS_INVALID`, EMPLOYEE scan 403; raw pass and reset tokens absent from a
  `pg_dump` and the API log; reset token present only as its SHA-256.
- API headers (development) and production-mode headers, `/docs`, `/openapi.json`, `/redoc` → 404
  (in-process); 413 for declared and chunked oversize bodies; no slash redirect; spoofed
  `X-Forwarded-For` and client `X-Request-ID` ignored.
- Log hygiene of the API log.
- Database: runtime-role ACLs, audit column grants, triggers, database ACL, 20 foreign keys; every
  refusal listed in [§8.4](#84-immutability) as `vms_app`; owner `UPDATE`/`DELETE` on `audit_logs`
  blocked by the trigger; the startup privilege check for both roles; the SQL and PowerShell commands of
  [§15.4](#154-checking-a-database-by-hand); the emergency session revocation.
- Configuration refusals and the pre-flight command (Git Bash and PowerShell).
- CLI: `create-admin --password-stdin` (policy refusal and success), `prune-sessions` (success and
  refusal of 0 days).
- `check_nginx_headers.mjs`, `check_release_tree.py`, and the security test subset (1,044 passed, with
  the 27 files the list had before `test_routed_reads.py` was added).

**Re-run in the final release gate (2026-10-07; the Phase 9 gate, summarised in
[`docs/production-readiness.md` §10.1](production-readiness.md#101-final-results-phase-10-gate-2026-10-08)):**
the security test subset of [§17](#17-checking-the-controls) (1,105 passed in 28 files; 1,044 in the
27 without `test_routed_reads.py`), `check_nginx_headers.mjs` (7 headers in sync),
`check_release_tree.py` (777 files, exit 0), the deploy unit tests (27 passed, D9-37's compose test
included), and the smoke test and a routing probe against nginx 1.30.5 for Windows in front of the
production-mode API with the final configuration (81/81 from two client addresses; 34 of 34 raw
request targets).

**Phase 10 (2026-10-07 and 08).** The Phase 10 statements of this document were compared with the code
(`app/api/routes/auth.py`, `app/schemas/`, `app/core/config.py`, the `app/email/` package and its
providers, `app/core/field_errors.py`) and the decision records. Measured, as recorded there and in
[`docs/production-readiness.md` §10](production-readiness.md#10-testing):

- against an API of the Phase 10 code on a throwaway database: `PATCH /auth/preferences` answered 200,
  422 for an unknown language and 403 `CSRF_FAILED` without the token;
- the SMTP provider against real SMTP servers (aiosmtpd) with a throwaway certificate: an untrusted
  certificate refused, a wrong password a single refused sign-in, no credential in any log record,
  error text, `repr` or exception chain; the adversarial review's probes re-run after its fixes;
- the Phase 10 gate (2026-10-08): the full backend suite (2,971 passed; 2,974 when re-run after the gap
  closure), the deploy checks (33 tests, 883 files without an artefact or credential, 885 after the gap
  closure, 7 headers in sync), production-mode start-up with
  `EMAIL_PROVIDER=smtp` and `SMTP_SECURITY=ssl`, the nginx smoke test (81/81 from two client addresses),
  an access log without query strings, `npm audit` (0) and `pip-audit` (no known vulnerabilities);
- the Arabic acceptance run: the audit metadata held no personal data, token or password; another
  company saw nothing and got `PASS_INVALID`; no request left the app's origin.

**Phase 11 review (2026-10-13).** What this document says about the fixes of the security and UX
reviews (§3.3, [§3.7](#37-the-platform-owner-phase-11), §4.1, §4.4, §6.4, §8.1, §8.7, §9.2, §10.2, §10.3,
[§12.3](#123-production-configuration-refusals)) was compared with the code, and each statement is held by a
test of the full suite: `tests/integration/test_platform_recovery.py` (11 tests: the recovery of a locked
platform account), `test_seed_guard.py` (16: seed accounts in production, at start-up and at sign-in),
`test_company_inactive_sign_in.py` (9), `tests/unit/test_email_review.py` (62: what a subject and an e-mail
can hold, encoded words, the notice of a platform action), and additions to `test_platform_auth.py`,
`test_platform_companies.py`, `test_credential_races.py` (on committed connections: a reset link against a
deactivation, a platform write whose session ends under it), `test_email_templates_api.py` and
`test_platform_database_rules.py` (revision `0014`). Measured that day: `ruff` and `mypy` clean; the full
backend suite 3,426 passed and 3 skipped in both orders; the deploy checks (35 tests, 981 files without an
artefact or credential, 7 headers in sync). Each fix was also taken out again in a private copy of the
backend (41 single changes), and every time a test failed
([`phase-11-backend.md`](decisions/phase-11-backend.md), Verification). Not run for the review: the security
test subset of [§17](#17-checking-the-controls) on its own (its files are part of the full suite), the
smoke test against nginx, and everything that needs a browser.

**Phase 12 (2026-10-13).** The statements of [§10.4](#104-a-companys-identity-uploads-the-colour-and-the-public-endpoints-phase-12)
were written from the code and are held by the tests named there. Measured that day: `ruff` and `mypy`
clean; the full backend suite in both orders and the deploy checks (42 tests) as recorded in
[`phase-12-backend.md`](decisions/phase-12-backend.md), Verification; nginx 1.30.5 for Windows with the
repository's configuration in front of three API processes on a throwaway database: the upload's limits,
the public endpoints' headers and 304s, both audit trails, and the smoke test 78/78. Not done then: a
second party's security review of this phase; anything in a browser (the frontend's gate).

**Phase 12, after its security review (2026-10-13).** The review demonstrated three problems, and each
was reproduced before it was fixed (B12-18 to B12-20 in
[`phase-12-backend.md`](decisions/phase-12-backend.md), with the measurements). Strangers could hold
every place among the uploads in progress: reproduced with nginx 1.30.5 for Windows over HTTP/1.1 and
HTTP/2 (the owner's uploads and removals 503 for as long as eight slow connections stayed), and gone
after the change (200 throughout; a request nobody is signed in for has its place for 2 to 42 ms). A
refused upload kept its inflated image until the next garbage collection: 45 MiB alive after eight
refused uploads with the collector off, 0.8 MiB after the change. The sender's name could read as an
address through U+FF20 and U+FE6B: now replaced, with the other seven compatibility forms of the five
characters. Measured that day: `ruff` and `mypy` clean; the backend suite in both orders and the deploy
checks (46 tests) as recorded there; the new tests fail on the code as it was; 26 single changes that
each remove one of the new safeguards are all caught by a test; and against nginx the 62 checks with
stand-in upstreams, the 28 of the whole flow, 19 of what someone signed in meets over HTTP/1.1, 14 of the
owner's uploads over HTTP/2 and the smoke test 79/79. Not done: a second look by the reviewer at these
changes; anything in a browser; anything in Docker (nginx ran with one worker, on Windows).

**Taken from earlier verification and not re-run here:** nginx behaviour, TLS policy and the 78-check
smoke test (Phase 9, nginx 1.30.5 for Windows: `phase-9-deploy.md`); browser-side controls (CSP
compatibility, service worker, shared-device session hygiene, timing parity measurements, differential
fuzzing of the pass grammar) from the Phase 8 audit (`security-audit.md` §5).

**Not verified on this machine (no Docker, no TLS-enabled PostgreSQL, no Resend key):** building and
running the images; Compose ordering, networks, read-only filesystems, dropped capabilities and resource
limits; the PostgreSQL first-start provisioning inside the container; every `docker compose …` command in
this document; PostgreSQL over TLS with `verify-full`; real e-mail delivery through Resend; SMTP delivery
from a container (the demo's delivery through Gmail on port 465 was checked by hand: Gmail accepted the
current invitation on 2026-10-08); the e-mails in real mail clients.

---

## 19. Residual risks and known limits

The full list with reasoning is in [`docs/security-audit.md` §6](security-audit.md#6-residual-risks-and-accepted-trade-offs)
and the recommendations in §7. In short:

| Ref | Residual risk | Mitigation in place / action |
|---|---|---|
| R-1 | Rate limiter is in memory in each process; restarts reset budgets and lockouts; replicas multiply budgets | One main API process per deployment, which counts every budget but `api_per_user`. The three read processes of the Compose layout count only `api_per_user` and their own refusal-row budgets; the engineering security review accepted this with conditions, and the security owner signs it off before go-live ([§9.1](#91-design)). Alert on restarts of each API process and on 429 spikes per pool; shared (Redis) limiter before scaling the main process |
| R-2 | E-mail delivery runs in the API process; a crash loses in-flight deliveries | Lost deliveries become FAILED within about six minutes and show under "Needs attention"; resend |
| R-3 | QR passes are bearer credentials | "Verify ID" cue; revocation on resend and address change; staff must check identity |
| R-4 | Container deployment not verified on the build machine | Run the smoke test and a penetration test on the deployed stack |
| R-5 | No row-level security for reads | Scoped repositories, composite FKs on writes, mandatory RBAC/isolation suites |
| R-6 (SEC-05) | An administrator can learn whether an address has an account in another tenant (global e-mail uniqueness) | 10 refusals per administrator and 20 per company per hour; a contract change is needed to remove it |
| R-7 (SEC-29) | A reset link opened on a shared device stays in browser history for its 30-minute life | Single use, short TTL; shared-device browser policy |
| R-8 | No admin "unlock account" or "sign out everywhere" endpoint | Device trust and reset recover users; deactivate and reactivate; emergency SQL in [§4.4](#44-revocation) |
| R-9 | Documented account signals (e.g. a 429 while an account's success budget is spent) | Audited; monitoring |
| R-10 | The append-only audit table grows; no archive-and-prune path; the refusal-row budgets apply per API process ([§8.5](#85-flood-control)) | Monitor growth; define audit retention and an owner-run archive procedure |
| R-11 | Session lifetimes and throughput budgets are policy, not refused; the `SECRET_KEY` estimate cannot prove randomness | Runbook values; generate keys as shown |
| R-12 | Shared-device remanence in the browser (up to 60 s of stale screen after the server ends a session; frozen offline tabs) | Managed browser policy; explicit sign-out |
| R-13 | Visitor PII is never deleted; no anonymisation feature | Retention decision and a reviewed maintenance procedure ([§14.3](#143-retention-guidance)) |
| R-14 | Password-only authentication | MFA/SSO recommended for administrators (outside the current contract) |
| R-15 | Only Chromium was tested end to end | Test Safari/iPadOS and Firefox on reception tablets |
| R-16 | The contract document lags the Phase 8 and 9 changes (revision 3 added Phase 10's) | This document and the decision records describe the implemented behaviour |
| Platform owner (Phase 11) | One all-powerful platform role; no MFA; no "password changed" e-mail; a platform account is disabled only in SQL; e-mails queued before a company's deactivation are still sent; the static `/pass` page still shows a deactivated company's QR code (refused at the desk) | Two operator accounts, the alerts of checklist item 23, MFA/SSO as future work (B11-8, B11-10) |
| Platform owner, after the review (2026-10-13) | The platform owner can still add itself an administrator of a company: it is made visible (an e-mail to the company's other administrators, both audit trails), not impossible, and a notice does not reach an administrator whose mailbox the platform owner controls. A temporary password typed by the operator has no failure budget of its own. A company's text whose rendering exceeds twice its limit is cut, not refused | The notices and audit rows (B11-43); generated passwords for recovery ([§3.7](#37-the-platform-owner-phase-11)); the preview shows the cut (B11-40) |
| A company's identity (Phase 12) | A company's name is the sender's display name of its e-mails: "Your Bank" is not refused, and a company's own administrators can rename it. Whether a slug names an active company is public (600 questions a minute per address). The image check does not decode pixels: what a logo shows is the platform owner's responsibility. *(Since Phase 13 an e-mail's logo is an opaque copy on a white plate, which reads where a mail client forces a dark background, and is a few KiB: drawn by the server once per logo and process, ahead of the requests that send it, in about 2 s of one processor for the largest an upload may be; 3.7 s for a 16-bit one stored before uploads were limited to 8 bits, B13-7.)* After a logo changes, an address without the current version can show the old image for up to 60 seconds | Companies are created by the platform owner; the sender's name cannot delimit, carry or read as an address, and the address is always the deployment's ([§10.4](#104-a-companys-identity-uploads-the-colour-and-the-public-endpoints-phase-12)); SPF, DKIM and DMARC of the sending domain are unaffected; the budgets of [§9.2](#92-budgets-and-their-settings); the upload page prepares small files |
| A company's identity, after the review (2026-10-13) | The review's three findings are closed (B12-18 to B12-20). What stays: a name that misleads by what it says, and characters that only resemble `@` without being a compatibility form of it; someone signed in to the platform can keep one of the eight upload places for up to 30 seconds per request; a flood of requests nobody is signed in for can take places for the milliseconds each needs; the count per address tells IPv6 addresses apart in full; over HTTP/1.1 a request refused before its body was read may see the connection reset instead of the answer; a refused upload's own file (at most 512 KiB) stays in memory until the garbage collector next runs, as every refused request body does | No review of names (the platform owner sees them in the list of companies); the upload's time limit and the hourly budget of brand changes; the site's count beside the per-address one; browsers speak HTTP/2 to nginx; [§11.3](#113-nginx-proxy-and-tls-behaviour) |
| Calendar invitations (Phase 14) | Gmail sends recipients' answers (Yes / No / Maybe) to `EMAIL_FROM`'s mailbox whatever `RSVP` says; one sending mailbox organizes every company's events, so abuse reported against it affects all of them; an event already in a calendar keeps what it said, and a host's at a former address of the host stays there; a budget that leaves an e-mail out leaves that calendar as it was; Resend carries the event as an attachment only (Outlook does not apply a new time or a cancellation by itself) | No link or token in any event, and none in the e-mail that carries one (§10.5); the host's event private; a visitor's former address loses the event; per-user and per-company budgets (B14-15); a sending mailbox that is nobody's host, signed with its domain's DKIM: a release gate (production-readiness §15 E) |
| SMTP (Phase 10) | No idempotency key: a retry after a final reply lost in transit can deliver a second copy (same `Message-ID`, same pass); Gmail through App Passwords only (no OAuth2); the system's trusted certificates only; DKIM, SPF and DMARC are the sending domain's (S10-9) | Resend (idempotent) or the organisation's mail server for production; a dedicated sending account whose App Password is revoked on rotation ([§12.1](#121-inventory)) |

Known limits from the deployment (`phase-9-deploy.md`): nginx error-log lines can quote a request line
with its query string; requests nginx rejects before location processing (400/414/494) carry no security
headers (they have no content); Docker's userland proxy hides IPv6 client addresses behind the bridge
gateway, so enable IPv6 on the network or disable the userland proxy before serving IPv6 clients;
cancelling a request blocked inside PostgreSQL at shutdown waits for the statement (bounded by the 30 s
statement and 10 s lock timeouts; measured exits 9.2 s for a 60 s row lock and 25.4 s for a hung
connection, inside the 45 s grace period), and a request cancelled at the 20 s shutdown limit gets
uvicorn's plain-text 500 instead of the error envelope.
