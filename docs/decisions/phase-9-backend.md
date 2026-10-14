# Phase 9 — backend decisions (final security sweep)

Date: 2026-10-06. Scope: `backend/` (application code and tests; not `backend/Dockerfile` or
`backend/.dockerignore`), `.env.example`, `scripts/db.ps1`: the backend findings of the final security sweep
(SEC-R1, SEC-R2, SEC-R5, SEC-R6, SEC-R7, SEC-R8). Each finding was reproduced or confirmed in the code
before it was fixed, and every fix has a regression test that fails without it (checked by undoing each
fix on its own; see the verification below). Ids are the sweep's. Each entry records a deviation from, or
an interpretation of, `docs/initial-assessment.md` (revision 2) or an amendment of an earlier decision.

**Contract and configuration.** No migration, no new error code, no §8.1 schema change: the contract
snapshot (`frontend/src/types/backend-contract.json`) is unchanged. What changes for clients: which visits
`ReceptionToday.expected` and `VisitorSearchItem.today_visits` contain (SEC-R2), two new 422 messages on a
LOST_PASS walk-in's `reason` (SEC-R2), and a new 429 `RATE_LIMITED` policy name in audit metadata,
`user_email_refusals_per_company` (SEC-R1). One new setting, `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_COMPANY_PER_HOUR`
(default 20, documented in `.env.example`). New production refusals: the two taken-address refusal budgets
above ten times their defaults, either limiter bucket cap below a tenth of its default (SEC-R5), a
published password or the owner role given through `?password=`, `?user=`, PGPASSWORD or PGUSER, and at
startup a connection that signed in with a published password from any source (SEC-R6), and table
privileges beyond the migrations' grants (SEC-R7). In every environment, a relative `EMAIL_OUTBOX_DIR`
outside `backend/var` is refused (SEC-R8). The repository's `.env` was not changed. `scripts/db.ps1` needed
no change. `docs/security-audit.md` and `docs/initial-assessment.md` belong to other owners and were not
edited; the wording they need is in the hand-over below.

| # | Decision | Reason |
|---|---|---|
| SEC-R1 | **Taken-address refusals of POST /users are bounded per company as well as per administrator (amends SEC-05's mitigation; §7.3 addition).** New policy `user_email_refusals_per_company`: `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_COMPANY_PER_HOUR` (default 20) per company and hour, BOUNDED scope (keyed by the company ID). `UsersService._address_refusals` reserves one slot of each budget in one atomic reservation before the lookup (`per_user` first, so it is the one reported when both are spent); both are kept for USER_EMAIL_UNAVAILABLE and given back for anything else, as before. With either spent, every POST /users of that administrator or company answers 429 `RATE_LIMITED{policy: <the budget>}` with `Retry-After`, before the lookup, so the 429 says nothing about the address. **Bound:** at most 20 confirmations per company and hour, however many administrator accounts the company has; at most 10 per administrator. **Default 20, not 10:** with 10 per administrator and 20 per company, one administrator alone cannot spend the company budget, so a single rogue or compromised account cannot block the other administrators' user creations for an hour; it takes a second administrator account, whose creation is an audited USER_CREATED row with its roles. **Not done:** a budget of successful creations per company (the sweep's "consider"): with the company budget, a new administrator account no longer adds confirmations, so minting accounts gains nothing for this oracle; a creation budget would throttle legitimate onboarding (the contract has no bulk import), and every creation is already an audited row bounded by the API budget. SEC-05 itself stays deferred (contract change). Tests: `test_admin_gate.py::test_refusals_for_taken_addresses_have_a_budget_per_company` (an administrator creates a SYSTEM_ADMIN at no cost; two administrators spend 20 refusals; a third gets 429 `user_email_refusals_per_company` for a taken and for a free address, no lookup answered, no user created; another company unaffected; free again after the hour), `test_rate_limit.py` (default, window, scope). | Confirmed in the code: the only key was the administrator's user ID, and the sweep measured 20 confirmations in an hour for one company with one extra administrator account (21 USER_CHANGE_REFUSED rows); each further account added 10. |
| SEC-R2 | **"Expected today" is decided by the pass window, not by the scheduled start (amends SEC-09 and B57's Expected list; §8.1 `ReceptionToday.expected`, `VisitorSearchItem.today_visits`).** A pass is valid from `window_start` (the schedule widened by the grace periods), so a visit starting at 00:10 tomorrow is admitted by its pass from 23:10 tonight at the default 60 minutes, and with `pass_grace_before_minutes` up to 1440 any visit of tomorrow can be. One rule, `VisitRepository._expected_by(end)`, now selects the expected visits: SCHEDULED with `window_start` before the end of the company-local day (after the NO_SHOW marking every SCHEDULED window is still open). It is used by the Expected list (`expected_until`), its exact count (`reception_counts`) and the SEC-09 guard (`expected_of_visitor`), so the guard's pointer ("Expected") always leads to the visit. The visitor search's `today_visits` (`actionable_for_visitors`, which runs without the NO_SHOW marking) keeps today's SCHEDULED visits (OVERRIDE applies all day) and adds those whose window opens before the end of the day and has not ended (`window_end >= now`). **The LOST_PASS guard** refuses with 422 on `reason` whenever such a visit exists, and says what reception can do now: a visit of today keeps the SEC-09 message (MANUAL in its window, OVERRIDE outside it); a pass valid now for a visit of another day: "This visitor's pass for a visit is valid now. Check them in on that visit instead (Expected), …" (MANUAL); a pass that becomes valid later today for a visit of tomorrow, which no check-in can consume yet (OVERRIDE needs the visit's own day, §6): "This visitor's pass for a visit becomes valid at HH:MM today. Check them in on that visit from then (Expected), …" (company-local time). A visit whose window opens only tomorrow is not expected today and the walk-in is registered (D-08 "other days → walk-in"), as before. **Index:** every writer derives the window with a grace of at most `GRACE_MINUTES_MAX` (the companies CHECK constraints), so `_expected_by` also bounds `scheduled_start < end + 1440 min`: that bound is the index condition on `ix_visits_company_id_scheduled_start_id_scheduled` and `window_start` a filter (EXPLAIN), and on the 60,000-visit volume check the slowest statement of GET /reception/today took 3.65 ms. **Chosen over** revoking the reported-lost pass (the sweep's alternative, which closes the whole class): it needs a new revoke reason, a §8.1 enum and CHECK change across both owners; recommended for the next contract revision. **Accepted:** for the third case the honest desk waits until the window opens (at most until midnight, and at the default grace at most 60 minutes before a visit just after midnight); picking another reason remains the R-3 staff residual. With a long grace period the Expected list also shows tomorrow's visits whose passes work today, which is what reception can face today. Tests: `test_reception_api.py::test_a_visit_after_midnight_whose_pass_is_valid_is_expected_and_guarded` (23:30, visit at 00:10: scan READY; in Expected with its count and in `today_visits`; walk-in 422 "valid now", nothing written; MANUAL check-in and check-out; the lost pass then 409 VISIT_COMPLETED), `::test_a_pass_that_becomes_valid_later_today_points_to_the_time` (23:00: 00:40 visit expected, 422 "becomes valid at 23:40 today"; 01:10 visit not expected, walk-in 201), `::test_with_a_day_of_grace_tomorrows_passes_are_guarded_today` (grace 1440: 08:00 and 10:00 tomorrow both expected at 09:00; 422 "valid now" and "becomes valid at 10:00 today"). The SEC-09/SEC-32 tests and `test_a_visit_still_in_its_window_after_midnight_is_still_expected` are unchanged and pass. | Reproduced with the sweep's test (`assert 201 == 422`) before the fix: the guard filtered `scheduled_start` within today, so a visit after midnight whose pass was already valid was missing from Expected and `today_visits`, the walk-in was registered, and once it checked out the reported-lost pass checked a second person in on the original visit (also past D-09). |
| SEC-R5 | **Production caps the taken-address refusal budgets and puts a floor under the limiter's bucket caps (extends SEC-46).** `GUESSING_LIMITS` now also holds `rate_limit_user_email_refusals_per_hour` (ceiling 100) and the new `rate_limit_user_email_refusals_per_company_per_hour` (ceiling 200): they are the only control on the deferred SEC-05 existence check. New `BUCKET_CAPS` (`RATE_LIMIT_MAX_NETWORK_BUCKETS`, `RATE_LIMIT_MAX_EMAIL_BUCKETS`): production refuses values below a tenth of the default (10,000). The messages name the setting and the bound, never the value. **The floor's effect** (B1-66's numbers scaled by ten): filling the NETWORK scope at 10,000 takes about 3,300 IPv4 addresses or 17 IPv6 /48s each spending its budgets continuously, instead of about 100 single-failure clients at a cap of 100; the EMAIL scope's R-9(b) residual needs about 83 IPv4 addresses instead of 830. Operators keep a factor of ten to trade memory (about 200 MB with both caps full at the default) against coverage. **Not changed:** the throughput budgets SEC-46 left uncapped. Tests: `test_config.py::test_production_caps_the_budgets_of_the_sec_05_existence_check`, `::test_production_refuses_guessing_limits_beyond_ten_times_their_default` (now also both refusal budgets), `::test_production_refuses_bucket_caps_below_a_tenth_of_their_default`, `::test_the_template_stays_within_the_production_ceilings` (floors too). | Confirmed in the code (neither a ceiling nor a floor existed) and by the sweep: production accepted `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR=10**9` and bucket caps of 100 in-process, and live a cap of 100 let 40 failed logins from a new client through without a 429. |
| SEC-R6 | **Production judges the database password and user that libpq will use, and checks the password the connection actually used at startup (extends SEC-18 and SEC-23).** Configuration (`_database_problems`): the candidate passwords are every `password` query value (SQLAlchemy's psycopg dialect passes query parameters over the URL's user:password part: `test_the_engine_passes_query_credentials_over_the_urls_own`), the user:password part, and PGPASSWORD when the URL gives none; any published one is refused. The effective user for the owner-role check is the last `user` query value, then the URL's user name, then PGUSER (unless a connection service applies, whose entry comes before PGUSER and cannot be read: then the startup check decides). Startup (`app.db.privileges.runtime_password_is_published`, called by `require_runtime_privileges` after the privilege and role-default checks): the password libpq's PQpass reports for the runtime connection, which also covers a password file (`passfile`, PGPASSFILE, `~/.pgpass`) and a service entry. The message never contains the password, the role or the source's value. **Not done:** refusing `passfile=` or `service=` without an explicit password in production (the sweep's option): a password file is a legitimate way to keep the password out of environment variables, and the PQpass check covers it. **Limit:** the migration URL's password from a password file is not checked by the API (it never connects with that URL); the PostgreSQL provisioning script refuses the published passwords when it creates the roles. Tests: `test_config.py::test_production_refuses_published_passwords_however_libpq_gets_them` (five cases), `::test_pgpassword_counts_only_when_the_url_gives_no_password`, `::test_production_refuses_the_owner_role_however_libpq_gets_it` (three), `::test_pguser_fills_in_only_what_the_url_leaves_out`; `test_runtime_privileges.py::test_production_refuses_to_start_with_a_published_password`, `::test_production_refuses_a_published_password_wherever_libpq_takes_it` (PGPASSWORD and a password file, with a URL without password). The libpq variables PGUSER and PGPASSWORD are cleared for every configuration test. Two tests about the other startup checks accept the test cluster's published passwords explicitly (`local_passwords_accepted`). | Confirmed in the code (`_url_credentials` read only the user:password part) and in-process: with that reading restored, the five `?password=` and PGPASSWORD cases were accepted. The sweep started production with both and served logins. |
| SEC-R7 | **The runtime role's table privileges are an allowlist of the migrations' grants (extends SEC-49).** A second query lists every privilege the judged role holds on a relation of `public` (tables, partitioned tables, views, materialized views, foreign tables, sequences) or on one of their columns, granted to it or to PUBLIC (`aclexplode` of the ACL, or of the owner's default ACL when none is set; memberships are refused on their own). Allowed: SELECT, INSERT, UPDATE on every table but two (the nine business tables and, through the schema's default privileges, any table a later migration adds); on `audit_logs` SELECT and INSERT on every column but `seq`; SELECT and USAGE on sequences other than the one behind `audit_logs.seq` (default privileges again), nothing on that one; nothing on `alembic_version`. Anything else is refused and named: `deletes_rows`, `changes_audit_rows`, `chooses_audit_order` (as before, now also column UPDATE on `audit_logs` and any privilege on the audit sequence), and new `maintains_tables` (MAINTAIN), `adds_triggers` (TRIGGER), `references_tables` (REFERENCES), `accesses_migration_state` (`alembic_version`), and `holds_unexpected_privileges` for everything else, so a privilege type a later PostgreSQL adds is refused until the check knows it. The SEC-23/49 attribute and membership checks are unchanged. The classification is a pure function (`privileges_beyond_the_migrations`). Tests: `test_runtime_privileges.py::test_grant_all_then_revoking_what_the_error_named_is_still_refused` (the finding's steps; the startup error names the four properties, not the role), `::test_privileges_beyond_the_migrations_grants_are_refused` (ten single grants, three to PUBLIC; restored after each), `::test_the_migrations_grants_and_default_privileges_pass` (a later table and sequence, a column subset, PUBLIC SELECT); `tests/unit/test_privilege_allowlist.py` (29 cases, including an unknown privilege type). | Confirmed by the sweep, and here with the allowlist removed (its regression test then failed: the check passed): after GRANT ALL and revoking exactly what the error named, `vms_app` kept `rxm` on `audit_logs` and `arwxtm` on `visits` and `alembic_version` (the same ACLs on the live probe's database). |
| SEC-R8 | **A relative EMAIL_OUTBOX_DIR must stay inside `backend/var` (audit recommendation 15; any environment).** `Settings._outbox_dir` resolves a relative path against `backend/` as before and refuses one that resolves outside `backend/var`, the only git-ignored place there; absolute paths are taken as given (the E2E suite uses an absolute directory under `frontend/e2e/.artifacts`). The root cause of the stray folder was a Windows path given unquoted in Git Bash: without its backslashes it is drive-relative (`C:UsersUser…`), not absolute, and was resolved to `backend/UsersUser…`. The message says to quote Windows paths. **The folder itself** (per the sweep: 218 files, among them 50 invitations with pass links and 6 password-changed notices from a throwaway database) was present at the start of this session and was gone a minute later; this fixer did not delete it (presumably another fixer working concurrently did); nothing of it remains under `backend/` (`git status` shows only source files). The `.gitignore` safety net and the release-tree check (`deploy/verify/check_release_tree.py`, which flags outbox files and stripped Windows paths) belong to other owners. Tests: `test_config.py::test_a_relative_outbox_outside_var_is_refused` (the stray folder's own value and four others), `::test_a_relative_outbox_inside_var_is_resolved_against_the_backend`, `::test_an_absolute_outbox_is_taken_as_given`. | Confirmed: a relative or drive-relative EMAIL_OUTBOX_DIR wrote outbox files (raw pass links, names, addresses) beside the source code, outside every ignore rule. |

## Verification (2026-10-06)

- Backend gate: `ruff check .`, `ruff format --check .`, `mypy` (128 source files), `pytest` and
  `pytest --committed-first`: all green, 2088 passed and 2 skipped (the opt-in performance checks) in both
  orders; 76 test items were added (2012 before).
- The sweep's own reproduction (`sweep_tests/test_lost_pass_midnight.py`): its "is refused" test, which
  failed with `assert 201 == 422`, now passes, and its "as it behaves today" test now stops at the walk-in
  (422).
- Opt-in volume check (`pytest --performance -s tests/performance`, 60,000 visits), for the Expected-list
  query that now selects by `window_start`: GET /reception/today median 45.7 ms, slowest statement
  3.65 ms; scan p95 37.4 ms and QR check-in p95 48.4 ms (budget 300 ms); both checks passed.
- Each fix was undone on its own and its regression tests failed: SEC-R1 (1 of 1), SEC-R2 (the window
  rule: 3 of 3; `today_visits`: 1 of 1; the answer's three cases: 2 of 2), SEC-R5 (the refusal budgets'
  ceiling: 1 of 1; the bucket floors: 2 of 2), SEC-R6 (`?password=` and PGPASSWORD: 5 of 5; the `user`
  parameter: the 2 owner-role cases that use it; PGUSER: the third; the startup PQpass check: 3 of 3),
  SEC-R7 (31 of 40; the 9 that still passed expect no problem, or a DELETE that the SQL check also sees),
  SEC-R8 (5 of 5).
- Live probe against `python -m app.serve` (development on port 8765, production starts on 8766) on a
  throwaway database migrated to `0009` and seeded with `seed-e2e`, dropped afterwards:
  - SEC-R1 (company budget set to 15 for the run): admin@demo.local created a SYSTEM_ADMIN (201), which
    changed its password (204); admin got 10 × 409 then 429; the new administrator 5 × 409 then 429, and
    429 for a free address (no user created); Other Corp's administrator still got 409. Audit: 15
    USER_CHANGE_REFUSED, one RATE_LIMITED for each policy.
  - SEC-R2 (company timezone set so that it was 23:20 local): a visit at 00:10 scanned READY, was in
    `/reception/today` expected (count 1) and in `/visitors?q=` `today_visits`; the LOST_PASS walk-in got
    422 "…valid now…"; MANUAL check-in 200, check-out 200, then the lost pass scanned 409 VISIT_COMPLETED
    and its QR check-in 409. With grace 1440 at 12:20 local: tomorrow 11:20 scanned READY and the walk-in
    got 422 "valid now"; tomorrow 13:20 scanned PASS_NOT_YET_VALID and the walk-in got 422 "…becomes valid
    at 13:20 today…".
  - SEC-R6: production with `?password=vms_app_local_dev`, and with PGPASSWORD, exited 1 at validation
    ("DATABASE_URL uses a published local-development password …"); with a password file and a URL
    without password it passed validation and exited 3 at startup ("DATABASE_URL signs in with a published
    local-development password …"); `?user=vms_owner` exited 1 ("must use the runtime role"). No log
    contained a password.
  - SEC-R5: `RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR=1000000` and `RATE_LIMIT_MAX_NETWORK_BUCKETS=100`
    each exited 1 with the setting and the bound named.
  - SEC-R7: after GRANT ALL and the revokes the old error named (ACLs `audit_logs` `vms_app=rxm`,
    `visits` and `alembic_version` `vms_app=arwxtm`), production exited 3: "… the connected role has:
    maintains_tables, adds_triggers, references_tables, accesses_migration_state".
  - SEC-R8: a development start with `EMAIL_OUTBOX_DIR=C:UsersUserAppDataLocalTempscratchpadoutbox`
    exited 1 with the EMAIL_OUTBOX_DIR message, and no folder appeared under `backend/`.

## Hand-over to the frontend owner

- **SEC-R2:** `ReceptionToday.expected` (and its count) and `VisitorSearchItem.today_visits` can now hold a
  SCHEDULED visit that starts tomorrow: one just after midnight whose pass already works or works later
  today, and, with a long `pass_grace_before_minutes`, any visit of tomorrow whose pass works today. The
  Expected rows show `formatTimeRange(scheduled_start, scheduled_end)` without a date; show the date (or
  "tomorrow") when `scheduled_start` is not on the company-local today, so "00:10–01:10" is not read as a
  visit that has passed. The "Later today" group's text ("Their pass is not valid yet") still holds. The
  row actions follow `permissions.can_check_in` and need no change.
- **SEC-R2:** a LOST_PASS walk-in can answer two new 422 messages on `reason` ("This visitor's pass for a
  visit is valid now. …" and "This visitor's pass for a visit becomes valid at HH:MM today. …"); the walk-in
  form already shows server field errors.
- **SEC-R1:** POST /users can answer 429 `RATE_LIMITED` once the company's 20 taken-address refusals of the
  hour are spent, also for an administrator who has refused nothing; the generic rate-limit message
  applies. New audit metadata value: `RATE_LIMITED{policy: user_email_refusals_per_company}`.

## Hand-over to the security audit owner (`docs/security-audit.md`)

- §1.4 (Enumeration row) and R-6: "bounded to 10 confirmations per administrator per hour" → "bounded to
  20 confirmations per company and hour (10 per administrator), whatever the number of administrator
  accounts" (SEC-R1); SEC-05's "Mitigation shipped" and "Verification" likewise
  (`test_admin_gate::test_refusals_for_taken_addresses_have_a_budget_per_company`).
- SEC-09 and §1.4 (Visitor-pass row): the guard and the Expected list are decided by the pass window
  (SEC-R2).
- SEC-46, §5.9 and R-11: the taken-address refusal budgets are capped (ceilings 100 and 200), and the
  bucket caps have a production floor of 10,000 (SEC-R5).
- SEC-18 and §5.9 ("Database URLs"): the published passwords are refused wherever libpq takes them from
  (URL, `?password=`, PGPASSWORD at configuration; a password file or service entry at startup), and the
  owner role also through `?user=` and PGUSER (SEC-R6).
- SEC-49 and §5.11: the table-privilege check is now an allowlist (MAINTAIN, TRIGGER, REFERENCES and
  `alembic_version` access refused; SEC-R7).
- Recommendation 15: the folder is gone, and a relative EMAIL_OUTBOX_DIR outside `backend/var` is refused
  (SEC-R8).

## Hand-over to Phase 9 deployment and the contract owner

- **Production mode against the local development cluster** is no longer possible with the published
  local passwords from any source (URL, `?password=`, PGPASSWORD, a password file): give the runtime role
  a password of its own on a throwaway cluster, or run in development mode.
- **Database roles:** the runtime role must hold exactly the migrations' table grants; do not `GRANT ALL`
  and trim, and do not grant MAINTAIN, TRIGGER or REFERENCES, or anything on `alembic_version`.
- **Contract (`docs/initial-assessment.md`):** record §7.3 (taken-address refusals per company), §8.1
  (`expected` and `today_visits` follow the pass window), §6/D-10 (the LOST_PASS answers), and the
  production configuration rules above. Consider a revoke reason for a reported-lost pass (for example
  `REPORTED_LOST`): it would let reception register the walk-in and stop the lost pass, closing the SEC-09
  class for every timing instead of pointing the desk to the visit.


# Readiness round 1 — backend fixes (2026-10-06)

Scope: the backend findings of the first production-readiness round (performance, resilience, operability),
in `backend/`, `.env.example` and this file. Each finding was reproduced or confirmed before it was fixed
(numbers below). Every code fix has a regression test that fails without it (each undone on its own; see
the verification); for the two indexes and the report's disk spill the regression checks are plan
assertions of the opt-in volume check, verified against the plans before and after. Ids are this file's
(RR1-xx).

**Contract and configuration.** One migration, `0010` (two indexes; no table or column change). No §8.1
schema change, no new error code: the contract snapshot (`frontend/src/types/backend-contract.json`) is
unchanged. What changes for clients and operators: an e-mail row can now become FAILED with
`last_error` "Sending was interrupted before it completed." (lost delivery, RR1-04) or "Replaced by a newer
invitation." (an invitation still PENDING when a resend replaced it), with an INVITATION_FAILED audit row
whose metadata has a new key `reason` (`interrupted` / `superseded`); a full connection pool answers 503
SERVICE_BUSY instead of 500 INTERNAL_ERROR; GET /health answers 503 within 3 s when the database does not
answer; access-log lines carry `route`, `user_id` and `company_id`, and `duration_ms` is the response time.
Five new settings, documented in `.env.example`: `DB_CONNECT_TIMEOUT_SECONDS` (5), `DB_POOL_TIMEOUT_SECONDS`
(5), `DB_STATEMENT_TIMEOUT_MS` (30000), `DB_LOCK_TIMEOUT_MS` (10000), `EMAIL_DELIVERY_CONCURRENCY` (4).
`scripts/db.ps1` needed no change (no role or grant change). `docs/initial-assessment.md`,
`docs/security-audit.md`, the root README and `docs/*.md` belong to other owners and were not edited; the
wording they need is in the hand-over below.

| # | Decision | Reason |
|---|---|---|
| RR1-01 | **Index `ix_visitor_passes_company_id_visit_id` on `visitor_passes (company_id, visit_id)` (revision 0010).** `PassRepository.current_for_visits` (the current pass of every visit on a page: every list of visits, both reception lists, a visitor's history, the dashboards) has no `revoked_at` condition, so the partial `uq_passes_active_visit` cannot serve it. The index also covers the composite foreign key's columns. Plain `CREATE INDEX … IF NOT EXISTS`, like 0007: a deployment with a large table creates it `CONCURRENTLY` first under the same name (the statement is in the migration's docstring). | Reproduced: `Seq Scan on visitor_passes` in every visit list on the volume seed (60,032 passes), 20–25 ms a list under load and 6–7 ms quiet, growing with all passes ever issued; with the index an index scan of 0.1–0.2 ms. |
| RR1-02 | **E-mail deliveries no longer run in the request worker threads; each message has a 20 s deadline (amends §9's dispatcher).** `schedule_delivery` adds `EmailDispatcher.deliver_in_background(job)`, an async background task that runs `deliver` in a worker thread holding one of the dispatcher's own slots (`EMAIL_DELIVERY_CONCURRENCY`, default 4; an anyio `CapacityLimiter` per event loop), never a token of anyio's default limiter (40), which every sync route and dependency uses. The forgot-password background task does its database work in a request thread and its delivery in a slot (`PasswordResetIssuer.issue_and_deliver`). Resend timeouts are now 5 s to connect and 10 s per read/write (was 15 s), and every attempt is bounded by the time left of the message's 20 s deadline (`EmailProvider.send(…, timeout_seconds=)`); no retry starts with less than 2 s left. Quick transient errors keep their three attempts (1 s, 3 s backoff); a provider that does not answer ends a message after about 20 s (two attempts) instead of 49.5 s. Messages beyond the slots wait as coroutines (no thread). **Not done:** a bounded queue that refuses deliveries beyond N (a refused message would need its own FAILED handling; RR1-04 already fails a message that waited too long), and the DB-backed outbox worker (the documented upgrade path, R-2). | Reproduced in a unit test with the default limiter's 40 tokens taken: the old `add_task(dispatcher.deliver, job)` never ran (`TimeoutError`). Live (black-holed HTTPS proxy in front of the real `ResendProvider`): 60 invitations, all 201 in ≤ 2.9 s on a loaded host; GET /health stayed 200 (max 1.5 s, CPU contention) and GET /auth/me answered in 0.01 s while the deliveries hung; each message ended FAILED after 2 attempts in 20.4 s, four at a time. |
| RR1-03 | **Bounded waits for the database (amends the SESSION_SETTINGS rule "timeouts are left to the database").** The application's engine (`create_app_engine`, also the CLI's) passes libpq `connect_timeout` (`DB_CONNECT_TIMEOUT_SECONDS`), TCP keepalives (idle 30 s, interval 10 s, count 3) and `tcp_user_timeout` 30 s (Linux; ignored elsewhere), uses `pool_timeout` `DB_POOL_TIMEOUT_SECONDS`, and pins `statement_timeout` / `lock_timeout` in the startup options with `SESSION_SETTINGS` (`DatabaseTimeouts`); libpq parameters already in the URL's query string are left as given. Migrations and the owner-role maintenance engine get none of these (an index build can take long). A pool timeout (`sqlalchemy.exc.TimeoutError`) is answered 503 SERVICE_BUSY like an `OperationalError` (it was a 500 with a traceback), also in the CSRF middleware. **GET /health** is now an async route whose database check (`services.health.DatabaseProbe`) runs outside the request threads on a connection of its own (NullPool, `connect_timeout` 2 s, `statement_timeout` 2 s, the engine's URL), answers within 3 s whatever the check is doing, and reuses a result for 1 s (an anonymous endpoint must not be a way to open database connections at will). | Reproduced the finding's numbers in kind, live against a TCP port that accepts and never answers: before, connections waited for psycopg's 130 s; now 45 concurrent GET /health all answered 503 in at most 2.2 s, 45 logins 503 (or 429) in at most 5.7 s, and GET /auth/me (no database) 401 in 0.28 s while they waited. Not measured: a query on an already pooled half-open connection after a failover (keepalives and the TCP user timeout bound it by reasoning; `pool_pre_ping` runs on such a connection first). |
| RR1-04 | **A delivery lost with its process is failed and shows under Needs attention (§12 "Rows stay PENDING/FAILED and visible", R-2).** `deliver` now claims its row (`UPDATE … SET updated_at = now WHERE status = 'PENDING'`) instead of reading it, and every failed attempt refreshes `updated_at`, so a live delivery's row is never older than one attempt plus a backoff. `email.dispatcher.fail_interrupted` marks FAILED ("Sending was interrupted before it completed.") every PENDING row untouched for 5 minutes, with INVITATION_FAILED (`reason: interrupted`, no actor) for invitations; the lifespan runs it before serving and every 60 s. A queued job whose row was failed meanwhile is skipped by its claim. When an invitation is (re)sent, the visit's invitations still PENDING are closed first ("Replaced by a newer invitation.", INVITATION_FAILED `reason: superseded`, the resend's request ID): they carry the pass the resend rotated, so a delivery not yet started must not send them. Needs attention, the dashboard count and the invitation status shown need no change: they read the row. **Not done:** a stale-PENDING condition in `needs_attention()` itself (the sweep makes the row true within a minute of the threshold; two sources of truth otherwise). | Reproduced live: a kill during attempt 1 left the row PENDING, attempts 0, error NULL. After the fix, the same kill, five minutes later (simulated by moving `updated_at` back six minutes) a restart failed the row, wrote INVITATION_FAILED `interrupted`, the visit was listed by `needs_attention=true` and counted on the dashboard; the resend was SENT. Unplanned: the 44 queued invitations of an earlier probe run whose server was killed were failed the same way by the next run. |
| RR1-05 | **GET /reception/today: the SQL cost is fixed (RR1-01); the payload is unchanged (contract).** Measured after RR1-01 on the ordinary day of the volume seed (250 visits, 366 KB): in-process 49 ms to build (17.5 ms of it SQL, including round trips) and 7 ms to serialise; HTTP median 58.6 ms, p95 105 ms. At the 200-per-list caps (1.17 MB): median 146 ms, p95 223 ms, max 255 ms (the finding: 198 / 295 / 374 ms). **Not done here, each a contract change for its owners (hand-over):** a slim list item instead of the full `Visit`, dropping or making opt-in the `inside` and `checked_out` lists (the reception screen reads only `expected`, `no_show` and the counts; the Inside tab uses GET /reception/inside), and a counts-only answer for background polls. **Rejected:** ETag / 304 (API responses are `Cache-Control: no-store` by §10 so a browser never revalidates, and the server would still build the whole body to hash it). **Tried and reverted:** binding the view builder's ID lists as one `uuid[]` parameter (`= ANY(:ids)`) instead of `IN (…)`: no measurable difference (A/B, 40 requests each). | The finding's Python cost is the view building and serialisation of every visit in four lists, linear in the visits shown; it is within the 300 ms budget at the caps on this host and only a smaller payload removes it. |
| RR1-06 | **The report reads its range in two statements instead of five, without spilling to disk.** `ReportRepository.totals` counts the distinct visitors who came from the set of their IDs (`SELECT count(*) FROM (SELECT DISTINCT visitor_id …)`, a hash aggregate, as an InitPlan of the same statement) instead of `count(DISTINCT …)`, whose sort spilled about 3 MB to disk at the default `work_mem` on a year of visits. `ReportRepository.breakdowns` replaces the four per-dimension queries: one pass with `GROUPING SETS (day, hour, department, host)`, current department and host names joined, hosts ranked in SQL (`row_number()`, ties by PostgreSQL's `lower(name)` then ID, as before) and limited to 10. `work_mem` is not raised. **Not done:** caching per (company, range) and a daily rollup table (state and invalidation for a management report; the next step if a site's yearly volume grows several-fold). | Reproduced: `Sort Method: external merge Disk: 3048kB` in the totals statement. A/B on the volume seed, alternating 30 rounds: 270 → 214 ms median on a loaded host, 163 → 147 ms quiet; the remaining cost is the per-row timezone conversion and hashing of one pass (plus, on this Windows host, parallel-worker start-up for the totals statement). The existing report tests (13) pass unchanged. |
| RR1-07 | **Audit log: an index for the date filter, and no count for a page that tells the total (revision 0010).** `ix_audit_logs_company_id_created_at` on `audit_logs (company_id, created_at)`: GET /audit-logs with `date_from`/`date_to` reads only the range. `paginate()` (every paginated list) reads the page first and counts only when the page is full or past the end: a partial page is the last one, its total is its offset plus its length. **Rejected:** capping the count ("10,000+") or keyset pagination: `Paginated<T>.total` is exact by §8 and the screens page by it (contract change). The unfiltered first page (and any full page) still counts every audit row of the company: 75 ms quiet before the index (parallel sequential scan), 85–190 ms after it (parallel index-only scan) for 196,000 rows on this host, much of it Windows parallel-worker start-up; the index does not make that count cheaper, only a contract change does. The parallel-query settings of the database host belong to the deployment owner. | Reproduced: the 7-day filter read the whole trail (Parallel Seq Scan, 78 ms quiet, 373 ms under load); with the index 0.8 ms (Index Only Scan). |
| RR1-08 | **The opt-in volume check represents a reception day.** `tests/performance/volume.py` now seeds a pass for every non-walk-in visit (revoked at check-out or cancellation; 3 % with an earlier rotated pass), invitations for 60 % of the visitors with an address (5 % of the scheduled ones failed), cancellation notices, host-arrival e-mails for half the check-ins, an audit trail in time order (creation, pass, check-in, check-out), and a company-local today of 120 expected, 45 inside (distinct visitors), 70 checked out and 15 no-shows (history visits on that day move two days back). `test_volume.py` adds: no `Seq Scan on visitor_passes` in any endpoint's plans, no `Seq Scan on audit_logs` for the 7-day filter, no `Disk:` in the year-long report, GET /reception/today p95 < 300 ms over 50 requests, and the needs-attention, visitor-history and audit page-1000 endpoints in the report. | As the finding said: no passes or e-mails were seeded and today held only the test's own visits, so RR1-01's cost was invisible to it. |
| RR1-09 | **Access-log lines carry `route` (the template, e.g. `/api/v1/visits/{visit_id}`, or `unmatched`), `user_id` and `company_id`** (IDs only, §3.2-8; from the authentication dependency's `request.state.auth`, null when not signed in). `route_template` skips non-selected routes before matching their patterns once routing has happened. | Confirmed: 0 of 36 lines carried them. |
| RR1-10 | **The access line is written when the response's last body message is sent**, so `duration_ms` is the response time and the line precedes background work (e-mail delivery); a request that ends without a complete response is still logged once, from the `finally`. Background time is visible in the dispatcher's own lines. | Reproduced in a test (a 1 s background task: the old line said ≥ 1000 ms and came after the task's log); live, POST /visits lines now show 0.5–2.5 s with the client measuring the same, during the provider hang that previously logged 49,157 ms. |
| RR1-11 | **The Phase 9 documentation deliverables (root `README.md`, `docs/architecture.md`, `docs/security.md`, `docs/api.md`, `docs/development.md`, `docs/production-readiness.md`) are confirmed missing but are not this owner's files.** Not written here: the owner list of this round gives the backend fixer `backend/`, `.env.example`, `scripts/db.ps1` and this file only, and other fixers work on the rest concurrently. The backend facts those documents need are in the hand-over below. | Confirmed by a file-existence check at the end of this round: all six still missing. |

## Verification (readiness round 1)

- Backend gate: `ruff check .`, `ruff format --check .`, `mypy` (128 source files), `pytest` and
  `pytest --committed-first`: all green, 2118 passed and 3 skipped (the opt-in performance checks, one of
  them new) in both orders (2088 passed and 2 skipped before this round). One flaky clean-up surfaced on
  the loaded host and was fixed: `test_a_freshly_migrated_database_gives_the_runtime_role_no_temporary_
  objects` dropped its database without the harness's retry, so an autovacuum worker still in the new
  database made `DROP DATABASE … WITH (FORCE)` fail; it now uses `_drop_database`. Two existing tests
  were adapted, not weakened: the 0008-downgrade race test compares the version left behind with the
  script's head instead of the literal "0009", and the health-outage test breaks the probe's connection
  instead of `session_factory` (which GET /health no longer uses).
- Each fix undone on its own, its regression tests then failed (13 checks): `paginate` always counting
  (`test_pagination.py`, the four cases without a count); deliveries as sync background tasks
  (`test_email_dispatch.py::test_scheduled_deliveries_run_while_every_request_thread_is_busy`, TimeoutError);
  `deliver_in_background` in the default limiter (`::test_a_hanging_provider_holds_only_the_delivery_slots`,
  five at a time); no deadline (`test_committed.py::test_no_retry_starts_after_the_message_deadline`, three
  attempts); Resend not bounded by the time left (`test_resend.py::test_an_attempt_never_outlasts_…`); no
  sweep (three tests of `test_email_delivery_recovery.py`); a claim that only reads
  (`::test_a_delivery_under_way_is_left_alone`); no startup sweep (`::test_startup_fails_…`); a resend that
  leaves the replaced invitation PENDING (`::test_a_resend_closes_…`); no statement/lock timeouts (two tests
  of `test_database_timeouts.py`); no pool-timeout handler (`::test_an_exhausted_pool_answers_service_busy`,
  500); a sync GET /health (`::test_health_answers_while_every_request_thread_waits`, TimeoutError); the
  access line in the `finally` without IDs (both tests of `test_access_log.py`). The index assertions of the
  volume check were checked against the same plans on the probe database before and after revision 0010
  (`Seq Scan on visitor_passes` / `on audit_logs` before, index scans after) rather than by re-running the
  whole volume check without the migration.
- Volume check (`pytest --performance -s tests/performance`, 60,250 visits, 60,032 passes, 46,271
  e-mails, 195,957 audit rows; quiet host): 3 passed. Medians: reception today 58.6 ms (slowest statement
  2.9 ms), reception inside 23.3 ms, needs attention 40.6 ms, visitor history 18.2 ms, report 30 days
  32.4 ms, report 366 days 167.8 ms (slowest statement 72.9 ms), audit first page 109.2 ms, audit 7 days
  10.1 ms, audit page 1000 110.6 ms. GET /reception/today (366,148 bytes) median 59.7 ms, p95 105.4 ms;
  scan p95 22.5 ms; QR check-in p95 31.5 ms.
- Live probes against `python -m app.serve` (development mode, ports 18791/18792, black holes on
  18891/18892) on a throwaway database migrated to 0010 and seeded with `seed-e2e`, dropped afterwards: the
  numbers in RR1-02, RR1-03, RR1-04 and RR1-10. Not measured live: graceful-shutdown time with deliveries
  in flight (uvicorn waits for running background tasks; anything it cannot finish is failed by RR1-04 at
  the next start).

## Hand-over (readiness round 1)

**Documentation owner (RR1-11).** `docs/development.md` should state, for the backend: the checks
(`ruff check .`, `ruff format --check .`, `mypy`, `pytest`, `pytest --committed-first`, the opt-in
`pytest --performance -s tests/performance`); the run command `python -m app.serve`; the five new settings
and what they bound (`.env.example` has the text); that GET /health checks the database on a connection
of its own and answers within 3 s. `docs/production-readiness.md` / `docs/architecture.md`: e-mail
delivery runs after the response in up to `EMAIL_DELIVERY_CONCURRENCY` threads of its own, 20 s per
message; lost deliveries become FAILED within about 6 minutes (Needs attention, resend); the database
waits are bounded (connect 5 s, pool 5 s, statement 30 s, lock 10 s; 503 SERVICE_BUSY); access-log lines
carry `route`, `user_id`, `company_id` for per-tenant investigation; revision 0010 creates two indexes
(on large tables create them `CONCURRENTLY` first, statements in the migration).

**Contract owner and frontend (RR1-05, RR1-07).** To shrink GET /reception/today (1.17 MB at the caps,
uncompressed by design): a slim list item for the reception lists, and dropping or making opt-in
`ReceptionToday.inside` and `.checked_out` (the reception screen does not read them), or a counts-only
answer for `X-Background-Refresh` polls. `Paginated<T>.total` could become an estimate or a capped count
for the audit log if its trail grows to millions of rows. Both are §8.1 changes and need the frontend.
The invitation `error` text can now be "Sending was interrupted before it completed." or "Replaced by a
newer invitation." (shown like any other error; the replaced row is never the visit's latest).

**Security audit owner (`docs/security-audit.md`) and contract §12.** R-2's mitigation: "Rows stay
PENDING or FAILED and visible" → a PENDING row nobody delivers is marked FAILED ("Sending was interrupted
before it completed.", INVITATION_FAILED `reason: interrupted`) at startup and every minute once it is 5
minutes old, so it shows under Needs attention; a resend closes the invitation it replaces. "Monitor
PENDING and FAILED `email_messages`": a PENDING row older than about 6 minutes now means the sweep is not
running. §12 "BackgroundTasks lost on crash" likewise. New INVITATION_FAILED metadata key `reason`.

**Deployment owner.** The container HEALTHCHECK (5 s) now gets an answer within 3 s even when the
database hangs. With `stop_grace_period` 30 s, uvicorn's shutdown can wait for deliveries in flight (each
at most about 20 s); what it cannot finish is failed at the next start (RR1-04). `DATABASE_URL` query
parameters (`connect_timeout`, keepalives) override the new defaults if the deployment sets them. The
database host's parallel-query settings (the audit count's parallel index-only scan) are its own; on the
Windows development cluster worker start-up dominates that count. (Re-audit round 1: the audit count now
runs serially whatever these settings say, RA1-02.)


# Re-audit round 1 — backend fixes (2026-10-06)

Scope: the three backend findings of the first re-audit (performance and operations), in `backend/` and
this file. Each was reproduced before it was fixed (numbers below). Ids are this file's (RA1-xx).

**Contract and configuration.** No migration, no new setting (`.env.example` unchanged), no §8.1 schema
change, no new error code: the contract snapshot (`frontend/src/types/backend-contract.json`) is unchanged
(`test_contract_snapshot.py` passes against it). Response bodies are byte-identical: GET /reception/today
(366,331 bytes) and GET /reception/inside (67,586 bytes) were fetched back to back from an old-code and a
new-code server on one database, 5 of 5 pairs identical each.
What changes for operators: during a database outage the interrupted-delivery sweep logs one WARNING line,
`closing interrupted e-mail deliveries skipped: database unavailable (<error class>)`, instead of an ERROR
with a traceback (RA1-03); the audit log's count runs without parallel workers (RA1-02). No other owner's
file was edited; what the documentation needs is in the hand-over below.

| # | Decision | Reason |
|---|---|---|
| RA1-01 | **GET /reception/today costs about 35–45 % less CPU per poll, without a contract change; the payload is unchanged (amends RR1-05).** (a) The view builder's lookups select only the columns a visit response shows, as rows (`CurrentPass`, `LatestEmail` named tuples) instead of ORM entities, and bind each batch of IDs as one `uuid[]` parameter (`repositories.ids.any_of`: `= ANY(:ids)`) instead of an IN list with one parameter per ID, whose SQL differed with the batch's length, so SQLAlchemy rendered it and psycopg parsed it again on every poll (too long for psycopg's statement cache). RR1-05 had tried `= ANY` alone and measured no wall-clock difference; measured as CPU with column rows it is about 2 ms per 250-ID lookup. (b) The four reception lists (also the evacuation list) load `VisitRecord` rows (31 columns) instead of ORM entities: no identity map, no attribute instrumentation (about 4 ms for 250 visits). (c) The view builder builds once per response what repeats across its visits (user references, departments, permission sets, the "not sent" invitation; `_SharedParts`) and once per list the company-local day (`visit_rules.CompanyDay`, which `visit_permissions` and `is_stale` now use, so each rule keeps one implementation). (d) `UTCDatetime` converts an instant to UTC when the model is built (`AfterValidator`, a no-op for what the database and the clock give) and lets Pydantic render it, instead of a Python serialiser per instant (about 2,100 per poll); the wire format (UTC, `Z`, microseconds when present) and the published schema (`WithJsonSchema`, serialization mode) are unchanged. **Not done here (contract and frontend, handed over again):** dropping or making opt-in `ReceptionToday.inside` and `.checked_out` (49 % of the bytes; the screen reads only `expected`, `no_show` and the counts), a slim list item, a counts-only answer for background polls: the remaining cost is still linear in the visits shown; the two lists hold 115 of the volume day's 250 visits, so dropping them would remove a large part of what remains (estimate, not measured). **Rejected:** caching the response between polls (each view's permissions and flags depend on the caller and the clock, and a cache per instance would serve stale lists behind a load balancer). | Reproduced the finding's per-poll CPU on the volume day (366 KB): in-process 50–58 ms a request before the fix (test client included). Measured after the fix, on a host shared with concurrent work (absolute numbers vary with that load, so old and new were measured alternately): API-process CPU per poll (sequential polls, `GetProcessTimes` of the server, 4 × 50 requests) 66.9 and 70.8 ms old, 37.0 and 46.6 ms new; in-process A/B in one process, alternating batches, without (d): 65.2 → 39.1 and 55.1 → 38.7 ms; (d) alone: 250 visits serialise in 5.0 ms instead of 8.9–10.3 ms. Stress B in kind (one `app.serve` process; 6 tablets polling every second as background refreshes, the desk scanning, checking in and refetching back to back, 3 analysts on reports, visit lists, audit pages and the dashboard with no think time; 60 s per run, two runs each, alternating; a fresh copy of the same database each run; 367–379 KB a poll): poll p50/p95 old 164/480 and 173/250 ms, new 110/170 and 107/170 ms; the desk's refetch p95 257/240 → 151/154 ms; analysts' requests served 1,712/1,806 → 2,791/2,609, desk cycles 137/146 → 240/227. The process still runs at 108 % CPU in this scenario: analysts without think time take whatever is left. |
| RA1-02 | **The audit log's count runs without parallel workers (amends RR1-07).** `paginate(…, serial_count=True)`, used by GET /audit-logs only, runs `SET LOCAL max_parallel_workers_per_gather = 0` before the count and `SET LOCAL max_parallel_workers_per_gather TO DEFAULT` after it, so nothing else in the transaction is affected (if the count fails, the transaction is rolled back with the setting). The count's statement is only ever run this way, so the plan psycopg's prepared statement keeps (prepared after five executions on a connection; PostgreSQL does not re-plan a cached plan when a setting changes) is serial too. Only this list: it is the one that counts hundreds of thousands of rows, and the other counts were not measured to suffer from parallel plans. **Still linear** in the trail, which is append-only and never pruned: a capped or estimated total (or keyset pagination on `seq`) is the contract change that removes it (handed over, as RR1-07 did). On a Linux host, worker start-up is cheaper (fork), but the serial plan still costs one core instead of three; the deployment owner should re-check the count's plan there. | Reproduced: on 196,000 audit rows the count's plan was a Parallel Index Only Scan with 2 workers, 75.7, 78.6 and 186.2 ms (psql), 110.8–150.7 ms median through the runtime engine; serially 20.4–20.8 ms and 15.1–17.7 ms. GET /audit-logs in-process (40 requests each, alternating): first page p50/p95 103.9/224.5 and 128.7/225.6 ms → 25.3/29.3 and 24.8/29.5 ms; page 1000 115.1/236.8 and 125.3/237.8 ms → 30.9/46.7 and 29.4/39.8 ms. Volume check medians: first page 109.2 → 22.3 ms, page 1000 110.6 → 29.4 ms. |
| RA1-03 | **During a database outage the interrupted-delivery sweep logs one WARNING line without a traceback (amends RR1-04).** `main._fail_interrupted_deliveries` (startup and every 60 s) catches `sqlalchemy.exc.OperationalError` and the pool's `TimeoutError` and logs `closing interrupted e-mail deliveries skipped: database unavailable (<class>)`, the class of the driver's error (`OperationalError`, `ConnectionTimeout`, …) or `TimeoutError` for the pool, never its text (which names the server and the database), like `core.errors`, the CSRF middleware and GET /health. Any other exception keeps `logger.exception` (a defect). | Reproduced in a test and live: with a missing database the startup sweep wrote an ERROR record with a two-part traceback. After the fix, live (`python -m app.serve`, missing database and a black-holed port): health 503 `database: unavailable`, login 503 `SERVICE_BUSY`, the log had one WARNING from the sweep (`(OperationalError)` and `(ConnectionTimeout)`), 0 ERROR records, 0 tracebacks, no password. The periodic runs use the same function (tested directly); a 60 s run was not observed live. |

## Verification (re-audit round 1)

- Backend gate: `ruff check .`, `ruff format --check .`, `mypy` (129 source files), `pytest` and
  `pytest --committed-first`: all green, 2134 passed and 3 skipped (the opt-in performance checks) in both
  orders; 16 test items were added (2118 before).
- Regression tests, each failing without its fix (undone on its own): RA1-03 —
  `test_database_timeouts.py::test_an_outage_at_startup_is_one_warning_without_traceback` (the app's
  lifespan against a missing database; also 503 from GET /health and login), `::test_a_hung_database_is_one_warning_without_traceback`
  (black-holed port, `ConnectionTimeout`), `::test_a_full_pool_is_one_warning_without_traceback` (3 of 3
  failed with the ERROR record; `::test_an_unexpected_sweep_failure_keeps_its_traceback` guards the other
  side). RA1-02 — `test_audit_logs_api.py::test_the_trail_is_counted_without_parallel_workers`
  (`debug_parallel_query` puts a Gather on every plan that may run in parallel: the plan the audit count gets
  with the settings in force when it runs has none, in each of eight requests, while a user-list count's
  has one; the setting is back to its default afterwards; failed without the fix). The plan psycopg's
  prepared statement keeps was checked by time instead: over 80 requests on a pool of five connections
  (beyond the prepare threshold of five) the count stayed at 15 ms median, `tests/unit/test_pagination.py`
  (the statements in order, and none when no count runs). RA1-01 — `test_visit_views.py::test_the_reception_day_runs_the_same_statements_whatever_its_size`
  (failed with IN lists), `::test_a_view_from_a_record_is_the_view_from_the_entity` (every list state, four
  kinds of caller, records against entities), `tests/unit/test_schemas.py::test_response_instants_render_as_utc_on_the_wire`,
  and the existing contract snapshot and reception tests unchanged.
- Opt-in volume check (`pytest --performance -s tests/performance`): 3 passed. It now explains each
  statement with the `SET LOCAL`s that ran before it and asserts that the audit count has no Gather; GET
  /reception/today (366,148 bytes) median 48.9 ms, p95 82.6 ms, 37.5 ms CPU per request in-process (test
  client included; host shared with other work); audit first page 22.3 ms, page 1000 29.4 ms; scan p95 38.7 ms, QR
  check-in p95 53.3 ms.
- Measurements: the scripts and throwaway databases (a copy of the volume seed per run) lived in the
  session's scratch directory and were dropped; servers ran on ports 18931–18936 and were stopped.

## Hand-over (re-audit round 1)

**Documentation owner.** `docs/production-readiness.md` §3.5 (audit pagination row) and L-7: a full page's
count is serial now, about 15–21 ms on 196,000 rows instead of 85–190 ms, still linear in the trail;
GET /audit-logs first page p95 about 30 ms instead of about 225 ms on this host (RA1-02).
L-6 and the per-poll figures: GET /reception/today costs about 35–45 % less CPU per poll (no contract change;
RA1-01's numbers); the payload and its size are unchanged, so L-6's bandwidth and Expected-tab rendering
points stand. Logging/operations text: during a database outage the delivery sweep writes one WARNING line
per run (startup, then every 60 s), `closing interrupted e-mail deliveries skipped: database unavailable
(<class>)`; an ERROR from that logger now means a defect.

**Contract owner and frontend (RA1-01, RA1-02).** Unchanged from RR1-05/RR1-07 and still recommended:
drop (or make opt-in) `ReceptionToday.inside` and `.checked_out`, or give the lists a slim item, or answer
background polls with counts only (most of the remaining per-poll CPU is per visit shown); a capped or estimated
`Paginated<T>.total` (or keyset pagination on `seq`) for the audit log.

**Deployment owner (RA1-02).** The audit count no longer uses parallel workers whatever the database's
settings; re-check its plan and time on the production host.


# Routed reads — regression test (2026-10-07)

Scope: the backend hand-over of D9-34 and D9-35 (`docs/decisions/phase-9-deploy.md`, Hand-over): a suite
test that the six GET endpoints nginx sends to the read processes consult only the per-user API budget.
One new test module, `tests/integration/test_routed_reads.py`; no application code, migration, setting or
contract change. Ids are this file's (RT-xx).

| # | Decision | Reason |
|---|---|---|
| RT-01 | **One test module pins both properties the four-process layout relies on.** A `RecordingLimiter` (records every call with its budget and key, then passes it to a real limiter) is given to a second application built by `create_app`, as a read process is built; sessions are signed in on the shared application, because no sign-in reaches a read process. (a) Budgets: for every role, each of the six endpoints, whether it answers 200 or 403, makes exactly one limiter call, a `hit` of `api_per_user` keyed by the user (24 cases). Without a session it consults no budget (401); a pending password change (403) and a spent budget (429) consult only `api_per_user`. (b) Writes: a successful read writes only the session's `last_seen_at` (§7.2): once when the last touch is a minute old, not again within the minute, and not for `X-Background-Refresh: 1` (the 13 allowed endpoint and role pairs). With a visit whose window has ended, the only other writes are the §5 NO_SHOW marking: one `visits` update and one VISIT_MARKED_NO_SHOW audit row. PostgreSQL counts the writes (`pg_stat_xact_user_tables`, compared before and after each request inside the test's transaction), so a write rolled back to a savepoint counts too. **No second sync test against the nginx map:** `deploy/verify/test_api_instances.py` (`EXPECTED_ROUTES`) already pins the map to the same six keys, and the test's list refers to it in a comment. **Not checked:** the security events a refusal writes (ACCESS_DENIED, RATE_LIMITED), coalesced per process, which D9-34 accepts. | D9-34 checked the budgets with a recording limiter in a scratch script, not in the suite, and D9-34 and D9-35 handed the regression test to the backend. Without it, a new budget on a routed endpoint would be counted once per process and no test would fail. |

**Verification.** Backend gate: `ruff check .`, `ruff format --check .`, `mypy` (129 source files),
`pytest` and `pytest --committed-first`: all green, 2180 passed and 3 skipped (the opt-in performance
checks) in both orders; the 46 new test items are the only change (2134 passed and 3 skipped before). Each
property was broken on its own by a scratch pytest plugin that patched the code before any application was
built (no application file was edited), and the test failed where it should: a second budget on GET
/visits (5 failures: its 4 role cases and the spent-budget test); a budget consulted when a 403 is answered
(12: the 11 refused endpoint and role pairs and the password-change test); an uncommitted row update in the
report (3; the request rolled the update back and it still counted); a touch for background refreshes
(13); an audit row of its own on GET /reception/inside (4).

**Hand-over.** Documentation owner: `docs/security.md` §9.1 ("not yet a test in the backend suite"),
`docs/production-readiness.md` §7.2 (row "Rate limits on the routed paths") and §16 (the Backend item),
and the hand-over in `docs/decisions/phase-9-deploy.md` (re-audit rounds 1 and 2) can now name
`backend/tests/integration/test_routed_reads.py`. Deployment owner: the comment above `EXPECTED_ROUTES` in
`deploy/verify/test_api_instances.py` could name this test, so that a change to the routing table leads
to both lists.
