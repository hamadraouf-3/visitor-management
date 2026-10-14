# Phase 11 — backend decisions (the platform owner; a company's own e-mail texts)

Date: 2026-10-12. Scope: `backend/` (application code, revision `0013`, tests), `deploy/verify/test_api_instances.py`,
`.env.example`, `deploy/env/backend.env.example`, `frontend/src/types/backend-contract.json` (regenerated; no other
frontend file), `README.md`, `docs/initial-assessment.md` (revision 4), `docs/api.md`, `docs/security.md`,
`docs/development.md`, `docs/architecture.md` and this file.

The user's two requests, decided with the user:

1. a **platform owner** ("super system admin") above every company, who creates, renames, deactivates and
   reactivates companies, adds a company administrator and sends one a password-reset link, and sees per-company
   counts but none of a company's visitors, visits or audit details;
2. **editable e-mail texts**: each company's administrators change the words of the visit e-mails (subject,
   heading, greeting, body paragraphs, button, footer line) in Arabic and English, while the layout, the logo, the
   QR code, the details, the pass link and every security line stay the product's.

Each entry records an addition to, or a deviation from, `docs/initial-assessment.md` (now revision 4, which takes
these decisions into the contract text). **Contract changes:** migration `0013`; 22 endpoints; 9 response, 6
request and 3 query models and 2 paginated envelopes in the snapshot; 2 error codes (`COMPANY_INACTIVE`,
`ACCOUNT_INACTIVE`, 38 in all); 4 field codes (`unknown_placeholder`, `placeholder_required`,
`invalid_placeholder`, `markup_not_allowed`, 65 in all); 3 settings (`PLATFORM_SESSION_MAX_AGE_HOURS`,
`PLATFORM_SESSION_IDLE_MINUTES`, `RATE_LIMIT_TEMPLATE_TEST_SENDS_PER_HOUR`); 1 rate-limit policy
(`template_test_sends_per_user`); 1 CLI command (`create-platform-admin`); audit actions `COMPANY_DEACTIVATED`,
`COMPANY_REACTIVATED`, `PLATFORM_ADMIN_CREATED`, `PLATFORM_ADMIN_PASSWORD_SET`, `EMAIL_TEMPLATE_UPDATED`,
`EMAIL_TEMPLATE_RESET`, `EMAIL_TEMPLATE_TEST_SENT` and entity types `platform_admin`, `email_template`.

**Security and UX review (2026-10-13).** The review of this phase found no critical or high problem and
demonstrated three medium and seven low ones; the UX review added four items. They are decided, fixed and
tested in [B11-34 … B11-50](#security-and-ux-review-2026-10-13-b11-34--b11-50) below, with revision `0014`.
Where one of them changes an entry above, the entry says so.

---

## The platform owner

**B11-1 — A principal of its own, not a tenant user.** Two tables, `platform_admins` (e-mail unique among
platform accounts, full name, Argon2id hash, `is_active`, `must_change_password`, `password_expires_at`,
`password_changed_at`, `last_login_at`, `preferred_language`, `device_trust_epoch`) and `platform_sessions`
(the shape of `user_sessions` without a company). `users.company_id` stays NOT NULL and every composite tenant
key is unchanged: no tenant query can ever see a platform account, and no platform query is tenant-scoped by a
NULL company. A platform account's e-mail may equal a user's: they are different principals with different
sign-in endpoints and cookies. Alternatives rejected: a NULL `company_id` user (it would break the composite keys
and every `company_id = :c` predicate's meaning) and a reserved "platform" company (it would make the platform
owner a tenant of itself, visible to tenant code paths and to the D-03 address rule).

**B11-2 — Privacy by default.** The platform owner reads the companies themselves (identity, activity) and two
aggregates per company, `counts.active_users` (active users) and `counts.visits_last_30_days` (visits whose
scheduled start falls in the 30 days up to now, any status), computed with two grouped queries per page. It also
reads a company's **administrators** (SYSTEM_ADMIN users: name, e-mail, activity, forced change, last sign-in),
which it needs to add one or to send one a reset link. Nothing else: no endpoint returns a visitor, a visit, a
department, a non-administrator user or a company audit row, and a platform session is refused (401) by every
tenant route (`get_session_auth` reads only the tenant cookie). A test signs in to the platform and gets 401 from
ten tenant reads.

**B11-3 — No self-registration; the CLI and the seeds.** `python -m app.cli create-platform-admin --email E
[--full-name N] [--password-stdin] [--reset]` (allowed in production). Without `--password-stdin` it generates a
20-character password (letters, digits, `-_.!@#%`, about 120 bits, re-drawn until the password policy accepts it)
and prints it once; with it, one line of stdin is the password (policy-checked, the account's name and the words
"platform" and "admin" refused as material). The password is temporary: `must_change_password = true`, expiry 72
hours (D-11). `--reset` gives an existing account a new temporary password the same way, revokes its sessions and
ends every browser's device trust (new epoch); an unknown address with `--reset`, or a known one without it, is
refused. Both write a platform audit row without an actor (`PLATFORM_ADMIN_CREATED` / `PLATFORM_ADMIN_PASSWORD_SET`,
`metadata.source = "cli"`). `seed-demo` and `seed-e2e` (non-production) create `platform@demo.local` with the seed
password (`Demo-Visitor-2026`), no forced change, seed ID `uuid5(seed namespace, "platform:platform@demo.local")`,
named «مالك المنصة» by `seed-demo` and "Platform Owner" by `seed-e2e`; a re-run leaves an existing account alone.
*Changed by the review:* a generated password has 32 characters and a failure budget of its own, `--reset`
takes no `--full-name` and checks the password against the account's own name (B11-35); the seeds' rows say
`metadata.source = "seed"`, and a seed account never serves production (B11-36).

**B11-4 — The platform's own audit trail.** `platform_audit_logs`: the columns of `audit_logs` with
`actor_platform_admin_id` for the actor and `company_id` for the company an action was about. The same
guarantees, by the same means (revisions 0001 and 0008): a statement trigger `platform_audit_logs_immutable`
refuses UPDATE, DELETE and TRUNCATE for every role, the runtime role holds SELECT and column INSERT (not `seq`)
and nothing on the identity sequence, there are no foreign keys, and metadata holds identifiers only
(`sanitize_metadata`). Every platform sign-in, sign-out, failure, lockout, password change, CSRF failure and rate
limit is written there: `SecurityEvent.platform` routes a failure event to it, and every event of a request
under `/api/v1/platform` is a platform event (`SecurityAudit.sink`, `csrf_failure`). The coalescing of
RATE_LIMITED and CSRF_FAILED rows keeps the platform's windows and budgets apart from the companies'. The
production privilege check (`app.db.privileges`) treats `platform_audit_logs` as it treats `audit_logs`.
`GET /api/v1/platform/audit-logs` lists it (newest first; filters `company_id`, `action`).

**B11-5 — A platform action that changes a company is also in the company's trail.** Creating a company and its
first administrator (`COMPANY_CREATED`, `USER_CREATED`), changing its identity (`COMPANY_SETTINGS_UPDATED` with
`changed_fields`), deactivating and reactivating it (`COMPANY_DEACTIVATED` with `revoked_sessions` and
`invalidated_reset_links`, `COMPANY_REACTIVATED`), adding an administrator (`USER_CREATED`) and sending a reset
link (`AUTH_PASSWORD_RESET_REQUESTED` with `email_message_id`) each write a row in the company's `audit_logs`
**without an actor** (no user of the company did it) and with `metadata.source = "platform"` and
`metadata.platform_admin_id`, and a row in the platform's trail with the platform administrator as the actor and
the same action name. The company's administrators therefore see in their own audit page what was done to their
company and by which platform account (an opaque ID; the platform account's name is not disclosed to tenants).
The seeds' rule "a person's change is never overwritten" (B10-15) counts these rows as a person's:
`AuditLogRepository.fields_changed_by_people` matches an actor **or** `source = "platform"`.

**B11-6 — Sessions, cookies and CSRF of the platform realm.** Cookies of its own, with the tenant cookies'
attributes: `__Host-vms_platform_session` (HttpOnly; Secure; SameSite=Lax; Path=/), `__Host-vms_platform_csrf`
(readable; Secure; SameSite=Strict; Path=/) and the device cookie `__Host-vms_platform_device` (HttpOnly; Secure;
SameSite=Strict; 90 days); with COOKIE_SECURE=false `vms_platform_session`, `vms_platform_csrf`,
`vms_platform_device`. Shorter lifetimes: `PLATFORM_SESSION_MAX_AGE_HOURS` (default 8, 1-24) and
`PLATFORM_SESSION_IDLE_MINUTES` (default 30, 5-1440); production refuses more than 12 hours and 60 minutes
(`_check_production`), the account manages every company. The CSRF middleware has realms (`CsrfRealm`): a request
under `/api/v1/platform` is checked against the platform session's own CSRF token (header `X-CSRF-Token`, as
for tenants) and only `POST /api/v1/platform/auth/login` is exempt; every other request against the tenant
session. A tenant cookie never vouches for a platform request, a platform cookie never for a tenant request, and
one realm's token never passes for the other's (tests in both directions, with a browser holding both
sessions). Origin and Sec-Fetch-Site checks apply alike. The per-user API budget is counted per platform
account under its own key (`platform:<id>`). The access log names the platform account (`platform_admin_id`)
instead of `user_id` / `company_id`. `cli prune-sessions` prunes ended platform sessions too.

**B11-7 — The same sign-in bar.** `PlatformAuthService` follows `AuthService` step by step: e-mail
normalisation; every failure budget reserved before any hashing (per address and typed e-mail under a key of
its own; per address and per IPv6 /48 **shared** with the tenant sign-in, one client one budget; per account
(10 / 15 min, then a 15-minute lockout) or, for a browser holding a valid platform device cookie for the
account, that device's own budget (SEC-01); the account's successful sign-ins (SEC-02)); exactly one Argon2id
verification on every path (dummy hash for an unknown address); account checks (inactive, temporary password
expired) after the verification; the account row locked and its hash re-checked before the session is created;
every failure the same `401 INVALID_CREDENTIALS`. A password change checks the policy first, then its failure and
success budgets (SEC-43), verifies the current password, compares and swaps under the row lock, revokes every
session including the caller's and issues a new one (SEC-04), and starts a new device-trust epoch (SEC-30).
`must_change_password` gates every platform endpoint but `GET /platform/auth/me`, `POST /platform/auth/logout`,
`POST /platform/auth/change-password` and `PATCH /platform/auth/preferences` (`403 PASSWORD_CHANGE_REQUIRED`).
`PATCH /platform/auth/preferences` stores the platform pages' language (`ar` | `en`; null follows the device); not
audited (B10-4).

**B11-8 — What the platform realm does not have.** No forgot-password: a platform account is recovered by an
operator with `create-platform-admin --reset` (a self-service reset would put the most privileged account's
recovery in a mailbox). No "your password was changed" e-mail (SEC-06): the e-mail outbox (`email_messages`)
belongs to companies (`company_id` NOT NULL), and the platform owner changes the password only right after an
operator handed over a temporary one. Recorded as an open item.

**B11-9 — Routing.** Every platform request, reads included, goes to the main API instance (the nginx map's
default, D9-36): sign-ins, writes, the shared sign-in budgets and the template test budget are counted there.
`deploy/verify/test_api_instances.py` lists every platform and e-mail-text route (`MAIN_ONLY_ROUTES`), requires
each to be declared by the backend and absent from the map, requires the list to be exactly the declared routes
under `/api/v1/platform/` and `/api/v1/email-templates`, and checks that none of their templates matches a routed
path in any letter case. The nginx template is unchanged.

**B11-10 — Deactivating a company.** `companies.is_active` (default true) and `companies.deactivated_at`, changed
together (CHECK `ck_companies_active_matches_deactivated_at`). `POST /platform/companies/{id}/deactivate` locks the
company row `FOR UPDATE`, sets both, revokes every live session of its users and invalidates their unused reset
links, in one transaction. From then on: a sign-in of its users is `401 INVALID_CREDENTIALS` (audited
`AUTH_LOGIN_FAILED` `reason = "company_inactive"`, after the usual single verification); a session lookup
(`SessionRepository.find_live`, used by every authenticated request and by the CSRF check) requires an active
company; forgot-password sends nothing; a reset link is `400 INVALID_RESET_TOKEN`; a pass of the company is
answered like an unknown pass (`PassRepository.find_by_hash` joins the company: `404 PASS_INVALID` at a scan,
the same at a QR check-in or check-out). The visitor's `/pass` page is static and makes no request (D-20), so a
visitor can still open it; the pass is refused wherever it is presented. A sign-in that verified the password
before the deactivation committed cannot survive it: the sign-in takes the company row `FOR KEY SHARE` before the
user row (the lock order of `repositories.locking`), so it either sees the deactivation or makes it wait and is
then revoked by it (a committed race test). Reactivation restores sign-in only; revoked sessions and invalidated
links stay so. Doing either twice changes and audits nothing. E-mails queued before the deactivation are still
delivered (open item). *Changed by the review:* a sign-in with the right password, whose only obstacle is the
deactivation, answers `409 COMPANY_INACTIVE` instead of the shared 401 (B11-46); a reset link requested while
the deactivation is under way cannot outlive it (B11-39).

**B11-11 — An administrator's reset link.** `POST /platform/companies/{id}/admins/{user_id}/password-reset` sends
the product's own reset e-mail (30 minutes, single use, the company's languages) to an **active SYSTEM_ADMIN** of an
**active** company, invalidating the account's earlier links, as if the administrator had asked for it. It answers
`202 {"sent_to": <address>}` and delivers after the commit. A user who is not an administrator of that company is
`404 NOT_FOUND`; an inactive administrator `409 ACCOUNT_INACTIVE`; a deactivated company `409 COMPANY_INACTIVE`
(new codes). It spends the account's forgot-password budget (3 / 15 min, shared with `POST /auth/forgot-password`),
beyond which it is `429 RATE_LIMITED`: the platform owner cannot flood an administrator's mailbox either.

**B11-12 — Creating a company and changing its identity.** `POST /platform/companies` takes `name`, `name_ar`
(optional), `slug` (1-80 lowercase letters, digits and inner hyphens, `invalid_format` otherwise), `timezone`
(known to Python and PostgreSQL, `invalid_timezone`), `default_language` and the first administrator
(`full_name`, `email`, `temporary_password`). As in `POST /users`, the client supplies the temporary password (the
SPA's generator and its show-once screen apply); it must pass the password policy (field
`admin.temporary_password`; the account's name, the company's names and the slug are refused as material). The
administrator must change it at the first sign-in (72 hours). A taken slug is `409 CONFLICT` with
`details.field = "slug"`; a taken address (any company) `409 USER_EMAIL_UNAVAILABLE` (originally without a
budget, on the reasoning that the platform owner is above every company; the review disagreed, and the refusal
is audited and budgeted since B11-42). `PATCH /platform/companies/{id}` changes `name`,
`name_ar` (null clears it), `timezone` and `default_language`; the slug never changes (it is the seeds' key, and
the seed ID derives from it). The company's other settings (address, grace periods, walk-ins, e-mail domain)
stay its administrators'. `POST /platform/companies/{id}/admins` adds a SYSTEM_ADMIN with the same rules.

**B11-13 — No deletion.** Companies are never deleted (D-12); deactivation is the end of a company's use.

## A company's own e-mail texts

**B11-20 — Words only.** For VISITOR_INVITATION, VISIT_RESCHEDULED, VISIT_CANCELLED and HOST_ARRIVAL, a company's
administrators (ADMINISTER) may replace, per language, these texts:

| Field | Kinds | Lines | Max | Product's text |
|---|---|---|---|---|
| `subject` | all four | one | 150 | the catalog subject (`invitation.subject`, …); for visitor e-mails each language's half of the bilingual subject |
| `heading` | all four | one | 150 | the catalog heading |
| `greeting` | all four | one | 150 | "Hello {visitor_name}," / "Hello {host_name}," |
| `intro` | all four | many | 1000 | the first paragraph (`invitation.invited`, `rescheduled.intro`, `cancelled.intro`, `arrival.body`) |
| `button` | VISITOR_INVITATION | one | 40 | "Open my visitor pass" (both buttons of the HTML part) |
| `closing` | all four | many | 1000 | empty: an extra paragraph after the body when set |
| `footer_note` | all four | many | 300 | empty: an extra line in the footer when set |

Everything else stays the product's: the layout, the logo, the colours, the QR code, the details grid (date,
time, host, department, address, purpose, "Invited by", the cancellation reason), the pass link and its fallback
address, the check-in window, the arrival steps, the reply instructions, "This pass is personal", "Your existing
QR code remains valid", "Your visitor pass for this visit is no longer valid", "Please meet your visitor at
reception", the language headings and the "Sent by … on behalf of …" line. An `intro` replaces the "on behalf of"
wording too (the grid's "Invited by" row still names whoever booked the visit). The plain-text part keeps its own
pass sentence ("Show the QR code … Open your pass here:"): a button label is not a sentence. Storage:
`email_template_overrides` (company, kind, language, field, text, `updated_by_id` with a composite key to the
company's users, timestamps), unique per (company, kind, language, field); `text` NULL means the product's text,
because the runtime role cannot delete (revision 0006) and "reset" is therefore an UPDATE.

**B11-21 — The security e-mails are not editable.** PASSWORD_RESET and PASSWORD_CHANGED keep the product's
texts (their paths answer `404 NOT_FOUND`). They are the channel an account is recovered and defended through:
words chosen by whoever holds an administrator account (or took one over) could send users to another address,
drop "If you did not make this change, reset your password now", or make a phishing message look like the real
one; and users learn to recognise them only if they never change. They also go to staff, whose language and
wording the product already chooses.

**B11-22 — Variables.** A fixed allow-list per kind, the same for every field of the kind:

| Kind | Variables |
|---|---|
| VISITOR_INVITATION, VISIT_RESCHEDULED, VISIT_CANCELLED | `visitor_name`, `company`, `host_name`, `date`, `time`, `timezone`, `department`, `purpose` |
| HOST_ARRIVAL | `host_name`, `visitor_name`, `visitor_company`, `company`, `date`, `time`, `timezone`, `purpose` |

`company` is the company's name in the section's language (`name_ar` in Arabic when set); `department` likewise
(the visit's snapshots; empty when the visit has none); `date` the visit's date in the section's language;
`time` the visit's time range ("10:00–11:00") for visitor e-mails and the **check-in time** for HOST_ARRIVAL;
`timezone` the zone label ("Amman time, UTC+3"); `visitor_company` the visitor's company (empty when none);
`purpose` as typed by the host. A placeholder is `{name}` (lowercase letters, digits, underscores). *Changed by
the review (B11-40):* `purpose` is not a variable of a subject, and a variable appears at most three times in
one text.

**B11-23 — The defaults.** The product's text of a field is the catalog text of `app.email.i18n` with its
placeholders renamed to the documented variables (`{host}` → `{host_name}`, `{visitor}` → `{visitor_name}`,
`{zone}` → `{timezone}`, `{name}` → `{visitor_name}` / `{host_name}`): what the API shows as `default` is exactly
what an unedited e-mail says. `closing` and `footer_note` default to "" (no line). A field without a company text
renders through the catalog exactly as before (a unit test compares an e-mail without texts to the product's,
byte for byte); the existing e-mail tests pass unchanged.

**B11-24 — Checks and field codes.** A submitted text is normalised (CRLF and CR to LF, white space at both ends
removed); empty or null means "back to the product's text". Otherwise, in this order, the first problem is a 422
field error at `<language>.<field>` (`ar.subject`, `en.intro`, …): `too_long` (`max`); `line_breaks` (a line
break or tab in a one-line field); `control_characters` (C0 other than LF, DEL, C1, U+2028/2029, a tab in a
multi-line field); `bidi_controls` (embeddings, overrides, isolates); **`markup_not_allowed`** (a tag opener `<x`,
`</`, `<!`, `<?` or a character reference `&name;`, `&#n;`, `&#xh;`: a lone `<` or `&` in words stays text);
**`invalid_placeholder`** (a brace that is not part of a `{variable}`: `{{x}}`, `{X}`, `{x.attr}`, `{x!r}`,
`{x:>9}`, a lone brace); **`unknown_placeholder`** (params `name`, the first unknown variable, and `allowed`, the
kind's list); **`placeholder_required`** (param `name`, B11-25). A field the kind does not have is `not_allowed`
(`ar.button` for VISIT_RESCHEDULED). Nothing is saved when any field is refused. A text's placeholders are parsed
by the backend's own pattern and never handed to `str.format`, so no attribute or format specification can run.

**B11-25 — Required variables.** A visitor e-mail's subject must contain `{company}` and a host arrival's subject
`{visitor_name}`: a recipient must be able to tell from the inbox who writes (a visitor, an anti-phishing cue) and
who has arrived (a host). No other field requires a variable.

**B11-26 — Texts are read at enqueue time, which is send time.** `EmailService` renders every message when it is
queued (as before) and now reads the company's texts there (`TemplateTextSource`, the repository). The rendered
message lives in its `DeliveryJob` until the dispatcher's attempts end (up to three, within 20 s); bodies are
never stored (`email_messages` keeps no body, contract §4). Retries therefore send exactly what was first
rendered, and a later edit changes only later e-mails; a user-triggered resend (a new invitation) renders again
with the texts current then.

**B11-27 — Escaping and direction.** A company's text is plain text: escaped in HTML (line breaks become `<br>`),
every value escaped on its own and isolated in its own direction exactly as the catalog's values are (names,
companies, departments, purposes in a `<span dir>` in HTML and FSI/PDI in plain text; dates, times and the zone
inserted as they are, B10-14), and a value that ends a sentence takes the place of the text's full stop. A
subject gets its values as they are and loses every control and line-break character (`sanitize_header`, now in
`app.email.headers`); an SMTP subject's `=?` is broken as before (S10-13). *Changed by the review:* every
subject is finished in one place for every provider (`subject_line`: also no direction controls, no encoded
word, at most 250 characters; B11-40, B11-41), and a value that holds a time range stays on one line in HTML
(B11-47).

**B11-28 — Preview.** `POST /email-templates/{kind}/preview` with `{language, ar?, en?}` renders the kind with
sample data and the saved texts, or a draft over them (the rules of PATCH, errors at `ar.<field>` / `en.<field>`),
and returns `{kind, language, subject, html, text}` without sending, queueing or saving anything. `language` is the
leading language (the e-mail is bilingual). Sample data: visitor «سارة أحمد» / "Sara Ahmad" of «شركة المثال
للتجارة» / "Example Trading", the caller as host (with their department, or "Finance" / «المالية»), tomorrow
10:00–11:00 in the company's time zone with its grace periods, purpose «اجتماع إطلاق المشروع» / "Project kickoff
meeting", and the sample QR code of the CLI's test e-mail (`…/pass#sample-not-a-visitor-pass`, not a pass). The
returned `html` is a full document whose images are `data:` URIs. The SPA's own policy (`style-src 'self'`) would
strip the e-mail's inline styles in a `srcdoc` frame (a `srcdoc` or `blob:` document inherits the embedding page's
policy), so `GET /email-templates/{kind}/preview?language=` serves the **saved** texts' HTML as a document of its
own, with `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none';
form-action 'none'; frame-ancestors 'self'; sandbox` and `X-Frame-Options: SAMEORIGIN`, for an
`<iframe sandbox src=…>` of the application's own pages: nothing in it can run, load or navigate. The API's
default policy stays on every other response; the middleware lets a route set its own CSP (`_ROUTE_DECIDES`).

**B11-29 — Test e-mail.** `POST /email-templates/{kind}/test` (the preview's body) renders the same way and queues
it to the **caller's own address** (there is no recipient field: `not_allowed`), with "[Test] " / «[تجربة] »
before the subject in the leading language. `202 {"sent_to": <caller's address>}`; delivered after the commit; an
`email_messages` row of the kind with `recipient_user_id` = the caller and no visit. Budget
`RATE_LIMIT_TEMPLATE_TEST_SENDS_PER_HOUR` (default 5, 1-100) per administrator and hour, then `429 RATE_LIMITED`
with `Retry-After`; a refused draft spends nothing. Audited `EMAIL_TEMPLATE_TEST_SENT` (`kind`, `language`,
`email_message_id`, `draft`).

**B11-30 — Audit: field names, not texts.** `EMAIL_TEMPLATE_UPDATED` (`kind`, `changed`, `reset`: sorted
`<language>.<field>` names) and `EMAIL_TEMPLATE_RESET` (`kind`, `reset`), entity type `email_template`, actor the
administrator. The texts themselves are not audited: audit metadata holds identifiers only (§3.2-8,
`sanitize_metadata` refuses free text), and the current texts, with `updated_by_id` and `updated_at`, are in the
table. A change that changes nothing writes no row.

**B11-31 — The e-mail texts API.** All under ADMINISTER (other roles `403 FORBIDDEN`, audited ACCESS_DENIED):
`GET /email-templates` (the four kinds), `GET /email-templates/{kind}`, `PATCH /email-templates/{kind}`
(`{ar?: Texts, en?: Texts}`, a field left out is unchanged), `POST /email-templates/{kind}/reset` (`{language?}`,
no body or null: both languages), the two previews and the test. `{kind}` is one of the four kinds; anything else,
the security kinds included, is `404 NOT_FOUND`. Writes take the company row `FOR KEY SHARE` and re-check the
caller (`lock_company_for_change`, SEC-07).

## Shared

**B11-32 — Migration `0013`.** One revision: the company columns and CHECK, the three platform tables, the
platform trail's trigger and narrowed grants, and `email_template_overrides` with its CHECKs (kind, language,
field, `text` NULL or 1-2000 characters and not blank). The new tables get the schema's default privileges (SELECT,
INSERT, UPDATE); `platform_audit_logs` is narrowed to SELECT and column INSERT without `seq`, nothing on its
sequence. Downgrade refuses, after locking the tables (SEC-39), while a company is deactivated (it would become
active again), a company text is set (lost), or a platform account or platform audit row exists (lost; the trail
is append-only, restore a backup taken before the upgrade). `test_downgrade_then_upgrade_is_clean` compares only
the tables that exist at `0005` now.

**B11-33 — Gates.** The contract snapshot is regenerated; `frontend/src/types/api.contract.test.ts` and
`src/i18n/fieldMessages.test.ts` fail until the frontend adds the new types to `api.ts` and the four field codes'
texts (the frontend builder's work, from this hand-over).

## Verification (2026-10-12)

On the reference machine (Windows 11, Python 3.14.6, PostgreSQL 18.6 on port 5433), from `backend/`:

| Gate | Result |
|---|---|
| `ruff check .` | all checks passed |
| `ruff format --check .` | 276 files already formatted |
| `mypy` (strict) | no issues in 149 source files |
| `pytest` | 3,236 passed, 0 failed, 3 skipped (the opt-in volume checks), 296.28 s; 3,038 before this phase |
| `pytest --committed-first` | 3,236 passed, 0 failed, 3 skipped, 317.96 s |
| contract snapshot (`tests/unit/test_contract_snapshot.py`, in the runs above) | passed: the committed snapshot is the regenerated one |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` (repository root) | 35 tests OK, none skipped |
| `deploy/verify/check_release_tree.py`; `ruff check deploy`; `ruff format --check deploy` | 917 files, no artefact or credential; clean; 6 files formatted |

New tests: `tests/unit/test_email_editable.py` (fields, checks, rendering, the service with texts),
`tests/unit/test_platform_units.py` (settings and production ceilings, CSRF realms, cookies, coalescing),
`tests/integration/test_email_templates_api.py`, `test_platform_auth.py`, `test_platform_companies.py`,
`test_platform_cli.py`, `test_platform_database_rules.py` (append-only trail as the runtime role and the owner,
grants, CHECKs, the guarded downgrade and the round trip of `0013`), a committed race in
`test_credential_races.py` (a sign-in held in its verification while the company is deactivated), and
additions to `test_migrations.py`, `test_runtime_privileges.py`, `test_database_rules.py`, `test_cli.py`
(prune-sessions) and `deploy/verify/test_api_instances.py`. The frontend's `src/types/api.contract.test.ts` and
`src/i18n/fieldMessages.test.ts` fail (25 tests) until the frontend follows the snapshot (B11-33).

## Hand-over

The frontend builder's specification is the final report of this phase; `docs/api.md` §10.10 and §10.11 are its
reference. Open items:

1. no "password changed" e-mail for platform accounts (B11-8);
2. a platform account cannot be deactivated through the CLI or the API (only `UPDATE platform_admins SET
   is_active = false` as the schema owner, which ends its sessions at their next request); a second operator
   account is the remedy for a lost one;
3. e-mails queued for a company before its deactivation are still delivered (B11-10);
4. the visitor's static `/pass` page still shows a deactivated company's QR code (D-20; refused at the desk);
5. one platform role only (no read-only platform account).

---

## Security and UX review (2026-10-13): B11-34 … B11-50

Scope: `backend/` (application code, revision `0014`, tests), `frontend/src/types/backend-contract.json`
(regenerated; no other frontend file), `README.md`, `docs/` and this file. The security review of Phase 11
(the platform owner and the companies' e-mail texts) found no critical or high problem. It demonstrated
three medium findings (M1 to M3), seven low ones (L1 to L7) and three minor points; the UX review of the same
day added four backend items (UX-M5, UX-L18 to UX-L20). Each is fixed at its cause with a test that fails on
the code as it was. None of the findings was wrong.

**Contract changes of this round:** migration `0014`; no endpoint, no setting, no error code; 2 field codes
(`placeholder_not_allowed`, `placeholder_repeated`: 67 in all); 2 response fields
(`EmailTemplate.max_variable_uses`, `EmailTemplateField.forbidden_variables`); `POST /auth/login` can answer
`409 COMPANY_INACTIVE`; `POST /platform/companies` and `…/admins` can answer `429`; 1 e-mail kind
(`PLATFORM_ACTION_NOTICE`, not part of the API contract); audit vocabulary: `metadata.source = "seed"`,
`reason = "seed_account"`, `metadata.notified_admins`, and `USER_CHANGE_REFUSED` and `ACCESS_DENIED` in the
platform's trail. The full list for the frontend is B11-50.

### The platform owner

**B11-34 — A background refresh never extends the platform session (M1).** `PlatformSessionManager.touch`
had no `background` parameter, so every authenticated platform request wrote `last_seen_at`, the pages'
heartbeat (every 60 seconds, with `X-Background-Refresh: 1`) included: a platform tab left open never
reached `PLATFORM_SESSION_IDLE_MINUTES`. It now takes the parameter the tenant manager takes, and both
dependencies read the header through one function (`api.deps.is_background_refresh`), so the two realms
cannot drift apart again. A request with the header is served like any other and counts as no activity.
Tests: the twin of the tenant test (29 heartbeats, then 401 one second after the thirtieth minute, and
`last_seen_at` never written), and that only a request without the header extends the window.

**B11-35 — Recovering a platform account that strangers keep locked (M2).** A platform account has no
forgot-password (B11-8): the operator's `create-platform-admin --reset` is its recovery. Anyone who knows
the address can spend the account's sign-in budget (ten failures, then fifteen minutes of 429 for every
browser that is not trusted, and from several addresses again at once), and the reset made that worse: it
ended every browser's device trust, while the budget, which lives in the API process and cannot be cleared by
a command in another process, stayed spent. Four changes, none of which makes a guess cheaper:

1. *The budgets belong to a password.* The account's failure budget and the budget of wrong current
   passwords at a password change are keyed by the account **and its device-trust epoch**. The epoch is new
   after every reset and every password change, so what was counted against the old password is not held
   against its successor (which is not what was being guessed). A new account has a new ID and so starts
   clean as it always did. This needs no call between processes: the reset changes the key.
2. *A generated temporary password has a failure budget of its own.* The review suggested a one-time
   enrolment code printed beside the password, which would make one browser trusted. That needs a second
   secret to hand over and a second field on the sign-in page that is used once per account. The same proof
   is put **inside the generated password** instead: it is 32 random characters (was 20), and a tag of the
   first 12 (SHA-256 with a label and the account's ID, `platform_admins.temporary_password_tag`, revision
   `0014`) is stored beside the Argon2id hash of all 32. A sign-in whose password starts with the tagged
   characters is judged by that temporary password's own budget (the numbers and the policy of a trusted
   browser, `login_failures_device`) instead of the account's. So whoever was handed the password signs in
   whatever strangers do, from any browser, with nothing new to type; and a new account, which has no
   trusted browser yet, is reachable too. Why this weakens nothing: without the 12 characters an attempt is
   on the account's budget as before; with them it has ten guesses at the other 20, then that budget is
   blocked as well; trying to find the 12 by guessing is a sign-in attempt each (about 73 bits); and the tag
   is no second, weaker hash of the password, because the tagged characters are extra ones in front of the
   20 that alone carry its strength (about 122 bits), which only Argon2id covers. The tag exists only beside
   a temporary password (CHECK), is removed by the forced change, and is not honoured once the password has
   expired. A password the operator types (`--password-stdin`) has no tag: the reset still starts its
   budget clean (1), but strangers can spend it again, so the generated password is the one to use for an
   account under attack (the command says so, and `docs/security.md` §3.7 has the procedure).
3. *The forced change is outside the budget of changes.* The change that completes an operator-issued
   temporary password takes no slot of `password_changes_per_user` (five an hour, SEC-43): it is the only
   request such an account can make, it can happen once per run of the command, and a budget spent before
   the reset would otherwise leave the owner behind `PASSWORD_CHANGE_REQUIRED` for up to an hour.
4. *What a reset is.* `--reset` changes the password and nothing else. `--reset --full-name N` silently
   ignored the name (minor b); the combination is refused with exit code 2 and a message. A reset judges
   the new password against the **account's own name**; it used the command's default name ("Platform
   Owner"), so a password built from the real name passed.

The per-address and per-prefix budgets, the single Argon2id verification on every path and the 401 that
every failure shares are unchanged. Tests (`test_platform_recovery.py`): the review's scenario end to end
(locked, reset, locked again, the owner signs in from a new and from the formerly trusted browser and
completes the change; the strangers stay blocked); a new account under attack; a reset with a typed password;
the temporary password's budget is a budget (a look-alike password is refused, ten wrong endings block the
real one); the tag's life; the two change budgets; the command's rules and output. Six of them fail with
the old keys and without the tag (checked by putting the old rules back).

**B11-36 — The seeds' demo accounts never serve production (M3).** `seed-demo` and `seed-e2e` create
accounts with a published password that never has to be changed and never expires, `platform@demo.local`
above every company among them, and the only guard was the commands' own refusal with
`APP_ENV=production`. A database seeded before it became production's, a demo database restored over it, or
a seed run from a workstation against the production `DATABASE_URL` were not caught. Now:

- *At start-up.* In production the application's lifespan, after the runtime-role check, refuses to serve
  while a seed account exists (`services.seed_guard.require_no_seed_accounts`), with a `ConfigurationError`
  that names the accounts by the seeds' published addresses and says what to do. Platform account and
  company users alike (one of each role in the two demo companies): the check is two lookups by primary
  key.
- *At sign-in.* In production both sign-ins refuse a seed account, after the one password verification
  every attempt gets, as `401 INVALID_CREDENTIALS` (audited `AUTH_LOGIN_FAILED`, `reason = "seed_account"`,
  and counted like any failure). This covers a seed run while the API is up.
- *How a seed account is recognised: by its ID, not by its address.* The seeds derive every account's ID
  from a fixed namespace and its address (`SEED_USER_IDS`, `SEED_PLATFORM_ADMIN_IDS`). No other code path
  produces such an ID, and no API lets anyone choose one. The reserved domains (`demo.local`,
  `other.local`), which the finding offered as an alternative, are deliberately not the test: an
  administrator of any company can create a user with such an address, so an address test would let one
  tenant stop the platform from starting; and an address says nothing about the password behind it (an
  account created by `create-platform-admin --email platform@demo.local` has a random temporary one).
- *Existence, not activity.* A deactivated seed user still refuses the start: a company's administrator can
  reactivate it, and that must not be what decides whether production starts next time.
- *Audit.* Rows written by a seed say `metadata.source = "seed"`; `create-admin` and
  `create-platform-admin`, which are allowed in production, keep `"cli"`. `Seeder` takes the source, since
  `create-admin` shares its helpers.

A seeded database is therefore not a production database; `docs/production-readiness.md` §13.5 says how to
remove a seed's rows from a production database that was seeded by mistake. Tests (`test_seed_guard.py`):
which IDs are the seeds'; an unseeded and a seeded database (both commands); an address alone is not a seed
account; a deactivated one still counts; a database that cannot be checked reports no driver text;
production starts without and refuses with seed accounts, development does not care; the sign-in refusals;
the audit sources.

**B11-37 — A company does not learn where the platform owner works from (L1).** The rows a platform action
leaves in a company's trail (B11-5) were written with the platform request's context, so every
administrator of every company could read the platform owner's network address and browser in their audit
page. `audit.record_platform_change` writes both rows of such an action: the company's with the request ID
only (`without_network_details`), the platform's with the full context. Test: all seven kinds of row, and
what a company's administrator reads through `GET /audit-logs`.

**B11-38 — A platform write re-checks its caller once it holds its locks (L2).** A request that waited for
the company row carried on after its session had been ended (a sign-out in another tab, a password change,
the operator's reset). `require_platform_still_authorized` is the platform's counterpart of
`require_still_authorized` (SEC-07): called once the company row is locked, and by the two creations after
they hashed the temporary password, it requires the session to be live, the account active and not under a
forced change; otherwise `401 NOT_AUTHENTICATED` (audited `ACCESS_DENIED`, `reason = "session_ended"`, in
the platform's trail) or `403 PASSWORD_CHANGE_REQUIRED`, and nothing is written. A user's deactivation
holds the company row, which is what makes the tenant re-check exact; nothing of the kind serialises the end
of a platform session with a write, so the re-check holds the **session row** `FOR SHARE` until the write
commits (`PlatformSessionRepository.hold_live`): every way a session ends is an UPDATE of that row, which
then waits for the write, or the write waits for it and finds the session revoked. The lock comes after the
company row and no transaction takes it before one, so the lock order gains no cycle. `create_admin` now
hashes before it locks, as `POST /users` does. Tests: on committed connections, each of the four writes on an
existing company held behind the company row while the session is signed out elsewhere (401, the company's
state unchanged, the refusal in the platform's trail), and both creations held in their hashing; the third
order, a write held between its re-check and its commit while the sign-out arrives (the sign-out waits for
the write's commit, and the write's audit row precedes the sign-out's: this is the test that fails when the
re-check only reads the session row); the checks themselves (revoked, expired, inactive account, forced
change). One consequence of the lock: another request of the same session that is due to record its
activity (an UPDATE of the same row) waits for the write's commit; it holds nothing the write needs.

**B11-39 — A reset link cannot be issued through a deactivation (L3).** `PasswordResetIssuer._issue` locked
only the user row, so a request in flight while the platform owner deactivated the company wrote its token
after the deactivation had invalidated the company's links, and the link worked after a reactivation. It
now takes the company row `FOR KEY SHARE` first, as the sign-in and the reset do, and requires the company
to be active under that lock. Tests on committed connections, both orders: the issue first (the
deactivation waits and then invalidates the new token), and the deactivation first (the issue waits and
then issues nothing).

**B11-42 — "This address cannot be used" is audited and budgeted for the platform owner too (L6).**
`POST /platform/companies` and `POST /platform/companies/{id}/admins` answered
`409 USER_EMAIL_UNAVAILABLE` for an address held in any company, without a record and without a bound. As
for an administrator (SEC-05): the refusal is written to the platform's trail (`USER_CHANGE_REFUSED`,
`code`, `operation = "create"`, the company the administrator was meant for; never the address or the
account that holds it), and a platform account has ten such refusals an hour (the policy and the setting of
`user_email_refusals_per_user`, under a key of its own, for both endpoints together). A slot is taken before
the address is looked up, kept for a refusal and given back otherwise; with none left the request answers
`429 RATE_LIMITED` before the lookup, for a free address as well, so the 429 says nothing about any address.

**B11-43 — A company's other administrators are told what the platform owner did to an administrator
account (L7).** The platform owner can read a company by adding itself an administrator, or by sending a
reset link to a mailbox it controls; the only trace was an audit row that nobody is told to read. When an
administrator is **added to an existing company** or one is **sent a reset link**, every other active
administrator of that company receives a security notice by e-mail: who ("the platform owner", never the
platform account's name, address or ID: B11-5), what and about which account (name and address), and when
(the company's time zone). It carries no credential, no link and no network address. A new e-mail kind,
`PLATFORM_ACTION_NOTICE` (revision `0014`), which is not editable (B11-21, and the CHECK of
`email_template_overrides.kind` is unchanged): like the other security notices it leads with the
recipient's language, is complete in both, and isolates the names it shows. Not at a company's creation:
there is nobody else yet. Each recipient gets at most five such notices an hour (the numbers of
`password_notices_per_user`, under a key of its own): beyond that the action is still done and audited and
only that e-mail is left out, so a platform account cannot flood a mailbox either. Both audit rows of the
action say how many were told (`metadata.notified_admins`); the e-mail log names each recipient.

### A company's own e-mail texts

**B11-40 — What bounds the e-mail a company's texts can make (L4).** The limits of B11-20 count the text; a
variable's value can be far longer than its name (`{purpose}` is nine characters, a purpose up to 500).
The review rendered a 15,071-character subject and 329 KiB of HTML from one field. Five rules:

1. *Every subject is at most 250 characters* (`headers.subject_line`, applied by the renderer to every
   e-mail, the product's own too: two 200-character company names made a 460-character subject). The cut
   ends with an ellipsis and never falls inside what a reader sees as one character (a letter and its
   vowel signs, an emoji with its selector, joiner or skin tone, a flag, a surrogate pair). In a bilingual
   subject each language keeps at least half of the room. Explicit direction controls are removed from
   every subject: in a header nothing closes them, and one typed into a value would reorder the rest of the
   subject, the other language's half included.
2. *A variable appears at most three times in one text* (`placeholder_repeated`, params `name`, `max`).
3. *`{purpose}` is not a variable of a subject* (`placeholder_not_allowed`, param `name`). It is free text
   that any host types for one visit; a subject names who writes and about what, is stored in the e-mail
   log, and is the one place where the text would appear without the label that says who provided it.
4. *A text renders to at most twice its own limit, values included* (`editable.rendered_limit`): the bound
   that no value's length can move. Beyond it the text is cut with an ellipsis; a value is cut before it is
   escaped and isolated, so the markup and the isolate characters around it stay whole.
5. *A saved text is used only while it passes the checks* (`editable.usable_texts`): one saved before a
   rule existed gives way to the product's text, so the bounds hold for every e-mail whatever is stored.
   The editor still shows it, and saving it again is refused.

With every field of a kind at its worst (the longest texts that can be saved, every value at the longest
the API stores and made of `&`, which is five characters in HTML) an invitation is 91 KiB of HTML and 15 KiB
of text (72 KiB and 13 KiB for the other three kinds), of which 47 KiB and 7 KiB are the product's own
layout around those values; a test holds each kind below 100 KiB and 16 KiB.

**B11-41 — No encoded word in a subject, whichever provider sends it (L5).** Text typed as
`=?utf-8?q?…?=` was neutralised only by the SMTP provider; Resend, the development outbox, the e-mail log
and the preview carried it as typed, and a mail client would decode it into other text than the
administrator saw. `headers.literal_text` (a space after each `=?`) is now part of `subject_line`, so every
provider is handed the same subject, for a company's text and for every value (company names, visitor
names). The SMTP provider keeps its own step for a message built without the renderer.

**B11-47 — A time range in a sentence stays on one line (UX-L18).** «…الساعة 13:30 –» / «14:30.»: the
range's no-break spaces did not hold it together, because a line may break after an en dash even when a
no-break space follows it (UAX #14, LB12a). In an HTML sentence a formatted value that holds a range is now
wrapped in `<span style="white-space:nowrap;">` (`formatting.on_one_line`), through the one function that
both a company's texts and the product's own sentences insert their dates, times and zones with. The word
joiner (U+2060) that the web application uses is not put into e-mails: a mail client whose font lacks it
shows a box. Plain text has no such markup and keeps the no-break spaces. A date already kept its day,
month and year together (and may still break after the weekday's comma); a host arrival's `{time}` is a
moment, not a range; no variable is a duration.

**B11-48 — The closing is a paragraph of its own (UX-L19).** In the plain-text part the closing followed
the paragraph before it without a blank line (in the rescheduled and cancelled e-mails on the very same
line). It now has one blank line before and after it, in both language sections of all four kinds; in the
HTML of the rescheduled and cancelled e-mails, where it follows a line without space below it, it brings
its own. Without a closing every e-mail is byte for byte what it was.

**B11-44 — Minor points.** (a) The preview replaced every `cid:visitor-pass-qr` of the HTML with the
image's data, a company's words included; only an image's own `src="cid:…"` attribute is replaced now (a
typed `"` is escaped, so text can never form it). (b) is in B11-35. (c) is decided in B11-46.

### Shared

**B11-45 — Migration `0014`.** `ck_email_messages_kind_valid` gains `PLATFORM_ACTION_NOTICE`;
`platform_admins.temporary_password_tag` char(64) NULL with CHECK
`ck_platform_admins_temporary_password_tag_is_temporary` (`temporary_password_tag IS NULL OR
must_change_password`). No grant: the runtime role's table privileges cover a new column and a changed
CHECK, and the downgrade-then-upgrade test compares the privileges. Downgrade refuses, after locking the
tables (SEC-39), while a `PLATFORM_ACTION_NOTICE` row exists (the older schema cannot represent it); it
drops the tags, which loses nothing an upgrade must restore (a pending temporary password still signs in,
without a budget of its own). The whole downgrade is one transaction, so a refusal of revision `0013` further
down also undoes `0014`'s part.

**B11-46 — A deactivated company's user is told so, with valid credentials only (UX-M5; settles minor c).**
Such a user typed the right password and read "Invalid email or password". When the password verified, the
account is active and its password current, and the **only** obstacle is the company's deactivation, the
sign-in answers `409 COMPANY_INACTIVE` ("This company is deactivated."): the code that exists, with the
one status it has everywhere (a 403 would have given one code two statuses). Enumeration-safe: a wrong
password and an unknown address get the same `401 INVALID_CREDENTIALS` as ever, after the same single
Argon2id verification, so the answer is reachable with valid credentials only; an inactive account or an
expired temporary password in a deactivated company still gets the 401; forgot-password stays silent.
Audited as before (`AUTH_LOGIN_FAILED`, `reason = "company_inactive"`). It is **not a failed attempt**: its
failure slots are given back, so retrying while the company is deactivated locks nobody out after its
reactivation (minor c asked whether those attempts should count: they did, to give no oracle for the
company's state; with an answer of its own there is nothing left to hide from someone who has the
password). Wrong passwords still count and still lock. The refusal takes a slot of the account's verified
sign-ins instead (`login_successes_account`, 30 in 15 minutes, then 429 before any hashing), which bounds
what a credential holder can make the server verify and write. The platform sign-in knows no such answer.

**B11-49 — A reset link that the platform owner sent says so (UX-L20).** The e-mail of
`POST /platform/companies/{id}/admins/{user_id}/password-reset` read "We received a request … If you did
not request this, ignore this email", to someone who had requested nothing. The two sentences that say who
asked have a second wording for this case, in both languages: "The platform owner sent you a link to set a
new password for your {company} account." and "If you do not need a new password, ignore this email. Your
password will not change." The link, the expiry line, the subject and the layout are the same, and it is
as little editable as the other one.

**B11-50 — What the frontend must mirror.**

| Change | Where |
|---|---|
| Field codes `placeholder_not_allowed` (`name`) and `placeholder_repeated` (`max`, `name`): 67 codes | `FieldErrorCode` in `api.ts`; a text in both catalogs (`errors:fieldCodes.*`) |
| `EmailTemplate.max_variable_uses: number` (3) and `EmailTemplateField.forbidden_variables: string[]` (`["purpose"]` for every subject, `[]` otherwise) | `api.ts`; the editor's client-side check and its variable chips |
| `POST /auth/login` → `409 COMPANY_INACTIVE` | the sign-in page shows the code's message (the catalogs have it); the E2E platform scenario expects "Invalid email or password." for a deactivated company's administrator |
| `POST /platform/companies`, `POST …/admins` → `429 RATE_LIMITED` (`user_email_refusals_per_user`) | error handling of the two forms |
| Audit vocabulary: `source: "seed"`; `reason: "seed_account"`; key `notified_admins` (a count); in the platform's trail the actions `USER_CHANGE_REFUSED` (`code`, `operation`) and `ACCESS_DENIED` (`reason: "session_ended"`), and `policy: "user_email_refusals_per_user"` / `"login_failures_device"` on platform rows | the audit catalogs (`auditVocabulary.test.ts` reads the values from the backend's source) and the platform audit page's action labels |
| A company's rows of platform actions have `ip_address: null`, `user_agent: null` | nothing to change if the page shows a missing address as empty |
| Platform session: a request with `X-Background-Refresh: 1` no longer counts as activity | the SPA already sends it for the heartbeat and refetches; user-initiated requests must not |

Unchanged for the frontend: every endpoint and model besides the two fields; the error codes (38); the
platform audit rows' `entity_id` of a user (the frontend resolves it to a name through
`GET /platform/companies/{id}/admins`).

### Verification (2026-10-13)

On the reference machine (Windows 11, Python 3.14.6, PostgreSQL 18.6 on port 5433), from `backend/`. The
machine was shared with other work, which is why the runs took longer than those of 2026-10-12.

| Gate | Result |
|---|---|
| `ruff check .` (0.16.10) | all checks passed |
| `ruff format --check .` | 283 files already formatted |
| `mypy` (2.4.0, strict) | no issues in 151 source files |
| `pytest` (9.1.1) | 3,426 passed, 0 failed, 3 skipped (the opt-in volume checks), 436.59 s; 3,236 before this round |
| `pytest --committed-first` | 3,426 passed, 0 failed, 3 skipped, 537.36 s |
| contract snapshot (`tests/unit/test_contract_snapshot.py`, in the runs above) | passed: the committed snapshot is the regenerated one |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` (repository root) | 35 tests OK, none skipped |
| `deploy/verify/check_release_tree.py`; `check_nginx_headers.mjs`; `ruff check deploy`; `ruff format --check deploy` | 981 files, no artefact or credential; 7 headers in sync; clean; 6 files formatted |

New test files: `tests/integration/test_platform_recovery.py` (11 tests), `test_seed_guard.py` (16),
`test_company_inactive_sign_in.py` (9) and `tests/unit/test_email_review.py` (62). Extended:
`test_platform_auth.py` (background refreshes), `test_platform_companies.py` (the company's row without
network details, the branches of the re-check, the budget and the audit of refused addresses, the notices),
`test_credential_races.py` (on committed connections: a reset link against a deactivation in both orders; a
platform write whose session ends while it waits for the company row, while it hashes, and after its
re-check), `test_email_templates_api.py` (the two codes, the preview's `cid:` text, a text saved before a
rule), `test_platform_database_rules.py` (revision `0014`: the CHECKs, the guarded downgrade, the round
trip), `test_platform_cli.py` and `test_cli.py` (the generated password, `source = "seed"`).

**Every fix fails a test when it is taken out again.** In a private copy of `backend/` (the working tree was
not touched), 41 single changes each took one fix, or one part of one, out, and the test files named for
it were run. The unchanged copy passed those files first (268 tests); then all 41 changes were caught.
Each entry says how the code then behaves and how many tests fail:

| Finding | The code with the fix taken out: number of tests that then fail (their files) |
|---|---|
| M1 | a background refresh extends the platform session: 2 (`test_platform_auth.py`) |
| M2 | a generated temporary password has no budget of its own: 3 (`test_platform_recovery.py`); the account's failure budget is not keyed by the epoch: 2 (`test_platform_recovery.py`); the forced change takes a slot of the hourly changes: 1 (`test_platform_recovery.py`); wrong current passwords are counted across a reset: 1 (`test_platform_recovery.py`); the tag outlives its temporary password's expiry: 1 (`test_platform_recovery.py`) |
| M3 | production starts on a seeded database: 2 (`test_seed_guard.py`); a seed account signs in in production: 1 (`test_seed_guard.py`); only active seed accounts count: 1 (`test_seed_guard.py`); a seed's rows say cli: 5 (`test_cli.py`, `test_seed_guard.py`) |
| L1 | the company's row carries the platform owner's address and browser: 1 (`test_platform_companies.py`) |
| L2 | platform writes do not re-check their caller: 9 (`test_credential_races.py`, `test_platform_companies.py`); the re-check does not hold the session row: 1 (`test_credential_races.py`); a platform write goes on under a forced password change: 1 (`test_platform_companies.py`); a platform write goes on for a deactivated platform account: 1 (`test_platform_companies.py`) |
| L3 | a reset link is issued without the company row: 2 (`test_credential_races.py`); a reset link is issued for a deactivated company once its row is free: 1 (`test_credential_races.py`) |
| L4 | a variable may repeat without bound: 7 (`test_email_review.py`, `test_email_templates_api.py`); {purpose} is a variable of subjects: 10 (`test_email_review.py`, `test_email_templates_api.py`); a rendered text is not bounded: 4 (`test_email_review.py`); a subject is not bounded: 6 (`test_email_review.py`); a saved text is used whatever the checks say: 2 (`test_email_review.py`, `test_email_templates_api.py`); direction controls stay in a subject: 1 (`test_email_review.py`); a bilingual subject gives the leading language all the room: 6 (`test_email_review.py`); a test e-mail's prefix is added after the subject was finished: 1 (`test_email_review.py`) |
| L5 | an encoded word stays in the subject (outside the SMTP provider): 5 (`test_email_review.py`) |
| L6 | address refusals are not counted: 1 (`test_platform_companies.py`); address refusals are not audited: 1 (`test_platform_companies.py`) |
| L7 | the other administrators are not told: 3 (`test_platform_companies.py`); the notices have no budget: 1 (`test_platform_companies.py`); the notice also goes to the administrator it is about and to inactive ones: 5 (`test_platform_companies.py`); a reset link's notices are not counted in the audit rows: 2 (`test_platform_companies.py`) |
| Minor a | the preview replaces every cid: text: 1 (`test_email_templates_api.py`) |
| Minor b | --reset ignores --full-name without a word: 1 (`test_platform_recovery.py`); a reset judges the password by another name than the account's: 1 (`test_platform_recovery.py`) |
| Minor c | the verified refusal counts as a failed attempt: 1 (`test_company_inactive_sign_in.py`) |
| UX-M5 | a deactivated company's user gets the 401: 5 (`test_company_inactive_sign_in.py`); the verified refusal of a deactivated company is not bounded: 1 (`test_company_inactive_sign_in.py`) |
| UX-L18 | a time range may break at its dash: 8 (`test_email_review.py`) |
| UX-L19 | the closing is glued to the paragraph before it: 8 (`test_email_review.py`) |
| UX-L20 | the platform owner's reset link reads like a requested one: 3 (`test_email_review.py`, `test_platform_companies.py`) |

The first run of these checks found one part without a test: with the re-check reading the session row
instead of locking it (L2), every test still passed. The third order of B11-38 was added for it
(`test_a_sign_out_waits_for_a_platform_write_that_passed_its_re_check`).

Until the frontend follows B11-50, 10 of its tests fail, in three files (run read-only at this gate):
`src/types/api.contract.test.ts` (2: the two fields of `EmailTemplate`, the two field codes),
`src/i18n/fieldMessages.test.ts` (2: no text for the two codes, in either language) and
`src/features/admin/auditVocabulary.test.ts` (6: the key `notified_admins`, the values `seed` and
`seed_account`). Not run in this round: Playwright (the frontend's gate runs the E2E suite), the coverage
run, the volume checks and the smoke test against nginx.

### Open after this round

1. A platform account with a **typed** temporary password (`--password-stdin`) has no budget of its own:
   strangers who know the address can keep it locked until the operator issues a generated one (B11-35).
2. A notice of a platform action is e-mail: an administrator whose mailbox the platform owner controls is
   not told by it (the audit row in the company's trail still is there), and the sixth notice within an
   hour to one recipient is left out (B11-43).
3. A company's text whose rendering exceeds twice its limit is cut with an ellipsis rather than refused at
   save time, because the length depends on each visit's values; the preview shows the cut (B11-40).
4. A seeded database cannot become a production database without removing the seed's rows as the schema
   owner (`docs/production-readiness.md` §13.5); there is no command for it (B11-36).
5. The open items of the hand-over above stand, except that a platform account's lockout now has a recovery.
