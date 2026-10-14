# Phase 9 — Deployment artefacts: decisions and verification

Date: 2026-10-06. Scope: the deployment deliverables of contract §15 (Dockerfiles, nginx, compose,
PostgreSQL provisioning, backup/restore). Application code was not changed (readiness round 1 changed
the run command `backend/app/serve.py`: D9-32; re-audit rounds 1 and 2 changed no application code:
D9-34, D9-35; the security review of the layout changed the nginx routing map and tests only: D9-36).
Operator steps are in
`deploy/README.md`; this file records why things are the way they are and what was verified.

**Docker is not installed on this machine (contract §1, §12).** No image was built and no container
was run. Everything that could be exercised without Docker was: the nginx configuration on the
official nginx 1.30.5 for Windows in front of the real API in production mode, the PostgreSQL
provisioning and the backup/restore scripts against PostgreSQL 18.6, the image build steps in
equivalent local form, and static checks of every file. The NOT VERIFIED list below is explicit.

## Files

| Path | Purpose |
|---|---|
| `backend/Dockerfile`, `backend/.dockerignore` | API image: Python 3.14.8 slim (digest-pinned), venv from the hash-pinned lock, uid 10001, health check, `python -m app.serve` |
| `frontend/Dockerfile`, `frontend/.dockerignore` | Node 24.21 build (`npm ci --ignore-scripts`, `npm run build`) → nginx-unprivileged 1.30.5 (uid 101) |
| `deploy/nginx/nginx.conf`, `templates/vms.conf.template`, `snippets/*.conf`, `docker-entrypoint.d/25-vms-check-config.sh` | nginx main config, virtual servers (rendered at start), header/proxy/TLS snippets, startup check |
| `docker-compose.yml` | postgres → migrate (one-shot) → backend, backend-reception (two replicas), backend-reports → frontend |
| `deploy/postgres/initdb/10-vms-roles.sh`, `deploy/postgres/pg_hba.conf` | roles, database and grants on first start; client authentication |
| `deploy/env/*.env.example` | production environment templates (real files are git-ignored by `deploy/.gitignore`) |
| `deploy/verify/smoke_test.py`, `deploy/verify/check_nginx_headers.mjs` | post-deployment smoke test; header drift check (CI) |
| `deploy/verify/check_release_tree.py`, `deploy/verify/test_check_release_tree.py` | release hygiene check of what `git add -A` would commit (CI, release checklist) and its tests |
| `deploy/verify/test_api_instances.py` | the API layout (D9-34, D9-35, D9-36): routing map on the raw path, upstreams and their balancing, startup check, image defaults, backend routes, the backend test's list of routed reads, compose services and replicas in step |
| `deploy/ruff.toml` | lint/format settings for `deploy/**/*.py` (the backend rule set, Python 3.12 target) |
| `scripts/backup.ps1`, `scripts/restore.ps1`, `scripts/backup.sh`, `scripts/restore.sh` | backups (pg_dump custom format) and verified restores into a new database |
| `deploy/README.md` | operator runbook |
| `deploy/.gitattributes` | LF line endings for everything under `deploy/` (read inside Linux containers) |

## Decisions

**Images**

- **D9-01 Base images pinned by tag and digest** (multi-arch OCI indexes, checked against the
  registry on 2026-10-06): `python:3.14.8-slim-trixie@sha256:3353bb7e…2b01d8`,
  `node:24.21.0-trixie-slim@sha256:173f1258…781fb66`,
  `nginxinc/nginx-unprivileged:1.30.5-alpine3.24-slim@sha256:3af0c10d…2406f0` (stable branch; the
  `-slim` variant has no dynamic modules), `postgres:18.6-trixie@sha256:fc973eb9…dfe8cf`. Tag and
  digest are updated together (Renovate/Dependabot); a digest alone would hide which release runs.
- **D9-02 Python dependencies**: `pip install --require-hashes --no-deps --only-binary=:all:` from
  `backend/requirements.txt` (SEC-25), then `pip check`, then pip is uninstalled from the venv and
  from the runtime image's system Python. `--only-binary` means no package's build code runs; the
  build stage is the same slim image (no compiler is needed, so none is present in either stage).
- **D9-03 One image, several commands**: the image's `CMD` is `python -m app.serve` and there is no
  custom `ENTRYPOINT`, so the same image runs `python -m alembic upgrade head` (migrate) and
  `python -m app.cli …` (operations) without `--entrypoint` overrides. `app.serve` fixes the server
  options (one worker, `proxy_headers=False`, no Server header, no uvicorn access log, `ws="none"`), so
  nothing in the image can drift from them. The contract's "entrypoint" is satisfied by the default
  command.
- **D9-04 Runtime hardening**: uid/gid 10001 without home or shell; application files root-owned;
  bytecode compiled at build time and `PYTHONDONTWRITEBYTECODE=1`, so the root filesystem is
  read-only in compose (`/tmp` tmpfs only); compose adds `cap_drop: [ALL]`, `no-new-privileges`,
  `init: true`, memory/CPU/pids limits. No `.env` can enter the image (allowlist `.dockerignore`;
  `Settings` looks for `/.env` and `/app/.env`, which do not exist).
- **D9-05 Health checks**: backend `GET /api/v1/health` through a proxy-less urllib opener (an
  `HTTP_PROXY` set for e-mail egress must not capture the loopback call); frontend
  `GET http://127.0.0.1:8080/healthz` on the default HTTP server, answered only to loopback.
- **D9-06 Frontend build context**: the context is `frontend/` (so `frontend/.dockerignore`
  applies); two BuildKit named contexts supply files that live elsewhere: `vms_contract`
  (`docs/contract`, because `tsc -b` type-checks `parsePassToken.test.ts`, which imports the shared
  vectors — verified: without the file `tsc -b` fails with TS2307) and `vms_nginx` (`deploy/nginx`).
  The image runs the real `npm run build`, so it fails on type errors like CI; build guards fail on a
  missing `index.html`/`sw.js`/precache list/wasm and on any shipped source map. Requires BuildKit
  (Docker 23+) / Compose 2.17+.
- **D9-07 nginx configuration baked into the image**, server names injected at start: the official
  image's envsubst renders `templates/vms.conf.template` with `NGINX_ENVSUBST_FILTER` restricted to
  `VMS_*` and `NGINX_LOCAL_RESOLVERS`, so no nginx variable can be clobbered by an environment
  variable. `25-vms-check-config.sh` stops the container when `VMS_SERVER_NAME` or `VMS_API_UPSTREAM`
  is missing or malformed, a placeholder survived, or the certificate is unreadable (an unset name
  would otherwise silently become a literal `server_name`).

**nginx (contract §10; security-audit recommendation 2)**

- **D9-08 Header set** = `frontend/config/securityHeaders.ts`, in `snippets/security-headers.conf`,
  included in every static location (nginx does not inherit `add_header` into a location that sets
  its own) with `always`, so 404/405 responses carry them too. `check_nginx_headers.mjs` imports the TS
  module and fails on any difference (mutation-tested: changed CSP, removed header, extra header,
  missing `always`, changed app list — each exits 1).
- **D9-09 Caching**: `index.html` and every SPA fallback `no-store` (SEC-51 gate; stricter than the
  task's "no-cache"), `sw.js` and `sw-precache-manifest.js` `no-cache`, `/assets/*` `public,
  max-age=31536000, immutable` without `always` (a 404 must not become immutable), other public files
  (favicon, icons, manifest) `no-cache`. `application/manifest+json` is added to the stock MIME table;
  `.wasm` is `application/wasm` in it already.
- **D9-10 SPA fallback** via a named location that rewrites to `/index.html` (so the shell's headers
  apply); a path whose last segment has an extension answers 404 instead of the HTML shell (no SPA
  route has a dot; a missing chunk must not be served as HTML). `/assets/` misses are 404 directly.
- **D9-11 Proxy**: `X-Forwarded-For $remote_addr` (overwrite), `X-Request-ID $request_id`
  (overwrite; the API adopts it from TRUSTED_PROXIES only, so nginx log, API log and audit rows share
  one ID), `Host $host`, `X-Forwarded-Proto $scheme`; `Forwarded`, `X-Real-IP`, `X-Forwarded-Host/
  Port/Prefix` cleared; `Upgrade`/`Connection` never forwarded (keep-alive with `Connection ""`);
  `X-Accel-*` from the upstream ignored; request buffering on (a slow client never holds the single
  worker); timeouts connect 5 s / send 30 s / read 60 s; upstream keep-alive 4 s (below uvicorn's 5 s).
  The upstream uses `server backend:8000 resolve` with the container's resolver, so a recreated
  backend container is found again without restarting nginx (nginx ≥ 1.27.3 open source).
- **D9-12 Body limit** `client_max_body_size 64k` = `MAX_REQUEST_BODY_BYTES` 65536: nginx refuses
  first, the API's own limit remains. nginx's own 413 and 502/503/504 are answered in the API's JSON
  envelope (`PAYLOAD_TOO_LARGE`, `SERVICE_BUSY` + `Retry-After: 5`) with the API's headers; the API's
  own error responses pass through untouched (`proxy_intercept_errors` off).
- **D9-13 No compression of API responses** (`gzip off` on `/api/`): responses mix secrets (one-time
  pass links) with reflected input (BREACH). Static files are gzipped.
- **D9-14 Hosts**: explicit `server_name`; the default HTTPS server uses `ssl_reject_handshake on`
  (no certificate for unknown SNI or IP-address access) and `return 444`; the default HTTP server
  answers only `/healthz` to loopback and 444 otherwise; the HTTP server for the real names redirects
  301 to `https://$host$request_uri` (assumes public port 443). Consequence: clients must use the DNS
  name (documented). `/healthz` uses `if ($remote_addr != "127.0.0.1") { return 444; }` because
  `allow`/`deny` cannot guard a `return` (rewrite phase runs before access phase — found by gixy,
  confirmed: the `allow/deny` form answered 200 to 127.0.0.2).
- **D9-15 TLS** (Mozilla intermediate without DHE): TLS 1.2/1.3, AEAD suites only, session cache,
  no tickets, groups left to OpenSSL 3.5 (hybrid X25519MLKEM768 first). The policy is included at the
  http level so the default server, which receives the ClientHello, enforces it too (also a gixy
  finding). HTTP/2 on. Certificates are mounted, never in the image.
- **D9-16 Logging**: JSON access log with `uri` ($uri, the contract field) and `path` (the original
  path from `$request_uri` up to `?`, because after the SPA fallback `$uri` is `/index.html`); never
  `$request`, `$args`, `$request_uri` or the referer. `log_not_found off`. `error_log … error`
  (residual: nginx error lines quote the failed request's request line, query included — see below).
  `server_tokens off`.
- **D9-17 No nginx rate limiting**: the API limits per user and per IP with NAT-aware budgets
  (§7.3); a per-IP nginx limit would throttle whole branch offices behind one address.

**Compose and PostgreSQL**

- **D9-18 Locale** (`POSTGRES_INITDB_ARGS`): UTF8, builtin provider `C.UTF-8` (same `lower()`/ILIKE
  behaviour as the development cluster) and `LC_CTYPE=en_US.UTF-8` (generated in the Debian postgres
  image). Reason: in PostgreSQL 18 pg_trgm decides "word characters" with the C library's
  `iswalnum()` under the database's LC_CTYPE, and treats every non-ASCII character as a non-word
  character when LC_CTYPE is `C`/`POSIX` (`src/backend/tsearch/ts_locale.c`, `database_ctype_is_c`,
  REL_18_STABLE) — Arabic and accented names would produce no trigrams. On the dev cluster
  (`en-US` ctype) `show_trgm(U&'\062D\062F\0627\062F')` returns 5 trigrams and `lower('É')='é'`.
- **D9-19 Roles and grants** (`10-vms-roles.sh`, the dev model of `scripts/db.ps1` minus test
  conveniences): `vms_owner` LOGIN (no CREATEDB in production; not a member of `vms_app`),
  `vms_app` LOGIN only; database owned by `vms_owner`, `REVOKE ALL … FROM PUBLIC` then CONNECT for the
  two roles (no TEMPORARY for anyone else), public schema owned by `vms_owner`, USAGE for `vms_app`.
  Table privileges come from the migrations. Passwords come from env or `*_FILE` (Docker secrets),
  reach psql through its environment (`\getenv`), never argv; the session sets
  `log_min_error_statement=panic` so a failing `CREATE ROLE … PASSWORD` is not written to the server
  log. The script refuses short (< 24), identical or published (`local_dev`) passwords and non-plain
  identifiers, and works whether the entrypoint executes or sources it (body in a subshell).
- **D9-20 Client authentication** via `-c hba_file=/etc/postgresql/pg_hba.conf` (a reviewed file,
  applied on every start, also during first-start initialisation): local socket trust (only
  `docker compose exec` reaches it), `host vms vms_owner,vms_app … scram-sha-256`, everything else
  rejected (no superuser over the network).
- **D9-21 DB TLS off on the compose `db` network** (`DB_REQUIRE_TLS=false` in `backend.env.example`):
  an internal Docker bridge on one host that only postgres, migrate and backend join — the explicit
  SEC-40 opt-out case. Remote databases must use `verify-full` (documented; the app refuses
  otherwise).
- **D9-22 Networks**: `db` (internal: no egress) and `app` (fixed subnet 172.30.47.0/24, nginx at
  .10). `TRUSTED_PROXIES=172.30.47.10/32`: only nginx may vouch for the client address and request ID.
  Postgres and the API publish no ports.
- **D9-23 Secrets only in env files** (`deploy/env/*.env`, git-ignored): the owner URL is in
  `migrate.env`, which only the migrate container reads; the API container never holds it. No
  `${…}` interpolation in `docker-compose.yml` (the repository root `.env` is the dev configuration,
  which Compose would read for interpolation).
- **D9-24 Ordering**: postgres healthy (pg_isready over TCP, so the socket-only init server never
  counts) → migrate exits 0 → backend healthy → frontend. `PASSWORD_HASH_CONCURRENCY=4` with a 1 GiB
  limit (the default is the host's CPU count, which a container limit does not change: 32 × 64 MiB of
  Argon2 would exceed it).
- **D9-25 Postgres 18 volume** at `/var/lib/postgresql` (the 18 image keeps PGDATA in
  `/var/lib/postgresql/18/docker` and refuses a mount at `…/data`), `shm_size 256m`, SIGINT stop.

**Backup and restore**

- **D9-26 Logical dumps** (`pg_dump --format=custom`, as the schema owner, `--lock-wait-timeout=60s`):
  one consistent snapshot, portable across hosts/architectures, restorable selectively; written to
  `.partial` and renamed only after `pg_restore --list` proves the archive readable and that it holds
  `alembic_version`, `audit_logs` data and the `audit_logs_immutable` trigger; `.sha256` in
  `sha256sum` format; owner-only permissions (NTFS ACL / umask 077); optional retention that only
  touches this database's archives and always keeps the newest.
- **D9-27 Restores never overwrite**: target must not exist; database created from `template0`
  (cluster locale), the database-level grants of D9-19 applied (they are not part of a non-`--create`
  archive), archive restored with `--single-transaction --exit-on-error` (on failure the new database
  is dropped), application tables analysed, then verified (schema version present, both triggers
  enabled, runtime role privileges exactly as migrated); a failed verification keeps the database for
  inspection. Switching the application over is a separate, documented step.
- **D9-28 Roles are not in the archives** (cluster objects): provisioning first (init script) — then
  the same role names. Compose mode (`--compose`) runs pg_dump/pg_restore inside the postgres
  container (server-matching version, local socket); the dump streams to the host, the restore
  archive is copied in (`docker compose cp`), never piped (pg_restore needs a seekable archive).

**Release hygiene (security audit recommendation 15; SEC-R3/SEC-R4)**

- **D9-29 Stray development outbox removed, guard in `.gitignore`**: an earlier tool run passed
  `EMAIL_OUTBOX_DIR=C:\Users\…\fix3outbox` through Git Bash, which stripped the backslashes.
  `C:UsersUser…` is a drive-relative Windows path, not an absolute one, so `Settings` resolved it under
  `backend/`. That wrote 218 untracked, unignored files there: 56 rendered e-mails, 50 of them with raw
  pass links, and their QR PNGs. The first `git add -A` would have committed them, contradicting
  §5.5 ("the raw token is never stored"). The directory is deleted. `.gitignore` now ignores
  `/backend/*outbox*/` (directories only and only directly under `backend/`, so `outbox.py` and
  `outbox.ts` stay committable), `*AppDataLocal*` and `*AppDataRoaming*` (the remains of a stripped
  Windows profile path, wherever a tool resolves it), plus `*.dump` and `*.dump.partial` (pg_dump
  archives, should `--out-dir` point into the work tree). The root cause sits in application
  configuration and is handed over (below).
- **D9-30 Executable release check instead of a manual grep**: `check_release_tree.py` examines exactly
  what `git add -A` would commit (`git ls-files --cached --others --exclude-standard`). Tracked files
  count even if an ignore rule covers them later. It fails on development outbox files (by the
  provider's `<uuid>.html|txt|json` / `<uuid>-<cid>.png` names), stripped-Windows-path components, raw
  pass/reset links (including JSON-escaped and percent-encoded spellings), session/CSRF/device cookie
  values (cookie headers, storage state, HAR), PEM private keys, key stores, `.env` files other than
  `*.example`, and pg_dump archives. Hand-made fixture tokens in test sources (`*.py`/`*.ts`/… under
  `backend/tests/` and `frontend/e2e/`, `*.test.ts(x)`) and in `docs/contract/` are exempt from the
  token and cookie rules only. Generated files in those folders (JSON, HTML, a storage state) are not
  exempt, and private keys never are. Output names the path, line and rule, never the value, so CI logs
  stay clean. Standard library only, Python 3.12+.

**Readiness round 1 (2026-10-06; this round also changed `backend/app/serve.py`, the run command)**

- **D9-31 PostgreSQL settings for the container** (finding: PostgreSQL ran with stock settings). The
  `postgres` service now starts with `shared_buffers=512MB`, `effective_cache_size=1536MB`,
  `random_page_cost=1.1` and `work_mem=16MB`, as `-c` options like `hba_file`, so they apply at
  every start without editing `postgresql.conf` in the volume. They are sized for the service's 2 GiB
  limit and SSD storage. The scaling rule is in `deploy/README.md` §4.
  - `random_page_cost` decides the history search plan. On the 60,000-visit data the search for
    "Garcia" scanned all of `visits` at 4, whatever `effective_cache_size` was (1536MB or the stock
    4GB). At 1.1 it used the index, even with `effective_cache_size=512MB`.
  - `work_mem`: the earlier 366-day totals query (`count(DISTINCT visitor_id)`) sorted on disk at 4MB.
    This round's report query no longer has that shape (a backend fix); at this volume it needs about
    1.5 MB. 16MB is headroom for larger sites.
  - Memory budget: 512MB of shared buffers, at most 20 API connections × 16MB per sort or hash step
    (hash steps up to twice that), and autovacuum (3 × 64MB). The rest of the 2 GiB stays page cache.
  - Not set: `max_connections` (DB_POOL_SIZE may go up to 100), JIT (cannot be checked on this
    machine) and `maintenance_work_mem`.
- **D9-32 Bounded graceful shutdown** (finding: graceful shutdown outlasted the 30 s grace period, and
  the SIGKILL skipped the lifespan shutdown, which writes the coalesced security-event counts).
  - `app.serve` passes `timeout_graceful_shutdown=20` (`GRACEFUL_SHUTDOWN_SECONDS`). After 20 s uvicorn
    cancels what still runs, runs the lifespan shutdown (the flush) and re-raises the signal. The
    signal's default action ends the process even while a worker thread is busy.
  - That last step depends on `init: true`. As PID 1 the interpreter would ignore the re-raised
    SIGTERM and wait for the thread.
  - The API's `stop_grace_period` goes from 30 s to 45 s, which leaves 25 s for the lifespan shutdown.
  - `backend/tests/unit/test_serve.py` fails when the option is missing, when the grace period is less
    than 20 s + 20 s, when `init` is not set, or when compose replaces the image's command.
  - The value is a constant, not a setting, so the compose grace period cannot fall below it.
- **D9-33 Capacity per instance documented; no second API instance in compose** (finding: one worker
  misses the 300 ms scan/check-in budget under heavy mixed load). *Superseded by D9-34 (re-audit
  round 1): the "analysts on a second instance" path alone did not hold the budget, and compose now
  runs three instances.*
  - `deploy/README.md` §4 gives the measured throughput of one worker and a rule of thumb (about 100
    open reception pages). It also names the signal to watch (scan and check-in `duration_ms`) and the
    two scale paths: a second instance for analyst traffic, or a shared rate limiter (contract §3).
  - A second instance is not built into compose. Each instance would keep its own rate-limit counters,
    which weakens the per-user budgets. The nginx path split could not be exercised without Docker.
  - Lowering the per-request cost belongs to the backend findings of this round.

**Re-audit round 1 (2026-10-06)**

- **D9-34 Three API instances, the requests shared out by path** (finding: stress B still broke the
  300 ms scan and check-in budget with one worker, in 5 of 8 runs for check-in; D9-33's first scale path,
  the analysts on a second instance, held it in only 2 of 6 runs; a layout with the reception polls
  split over two processes and the analysts on a third held it, but needs a shared rate limiter).
  - Cause, as the finding measured it: one API process runs its requests in one Python interpreter.
    The desk's scans and check-ins (15–25 ms of work) were time-sliced with the reception list that
    every open reception page polls (about 80 ms of work; 12.4 per second saturate one process) and
    with the analysts' reads. Moving only the analysts left the polls with the desk.
  - Decision: `docker-compose.yml` runs three single-worker instances of the same image and
    configuration (a shared `x-api` anchor): `backend`, `backend-reception` and `backend-reports`.
    nginx picks the upstream with a `map` on `"$request_method $uri"` (`$vms_api_pool`,
    `templates/vms.conf.template`): `GET /api/v1/reception/today` and `/inside` go to
    `backend-reception`; `GET /api/v1/reports/summary`, `/audit-logs`, `/dashboard/admin` and
    `/visits` (the list and history search) go to `backend-reports`; everything else, every other
    method on those paths included, goes to `backend`. The desk's own reload of the list after a
    check-in goes to the list instance too; the scan and the check-in stay on the main instance.
  - Why by path and not more workers or a round-robin: the rate limiter is in memory (contract §3).
    Only GET requests leave the main instance, and those six endpoints consult one budget, the
    per-user API budget (`api_per_user`), also when they refuse a role with 403 (checked with a
    recording limiter, below). So every sign-in, password-recovery, lockout, e-mail, scan and
    attendance budget is still counted in one place, the main instance, and none of them is
    multiplied, which is the concern of the security audit's R-1. What changes:
    - each instance counts the per-user API budget (`RATE_LIMIT_API_PER_MINUTE`, 600 per minute) for
      its own paths: one user can make up to 600 requests a minute on each instance, 1,800 in all;
      writes stay at most 600, since they all reach the main instance;
    - coalesced security-event summaries (for example `ACCESS_DENIED` for a role calling a report) are
      written per instance: up to one summary row per instance and window;
    - a restart of one instance resets only that instance's counters.
    `docs/security.md` §9.1 and the audit's R-1 still say "exactly one API process per deployment"
    (hand-over below). *Done: both now describe the four processes (the audit's R-1 closure note).*
  - No business data is cached in a process (the process-level caches hold static word lists,
    timezone names, the settings, route patterns and the health probe's last result), and sessions
    live in the database: a sign-out on the main instance ends the session on the read instances at
    once (checked live). What the read paths write is plain database work that was already safe
    between the threads of one process, and so is between processes: the NO_SHOW marking and the
    sweep of interrupted e-mail deliveries (which every instance runs) are single
    `UPDATE … RETURNING` statements, and the session's `last_seen_at` touch is a one-row update where
    the last write wins.
  - Read instances: 1 CPU, 512 MiB, `PASSWORD_HASH_CONCURRENCY=1` (no sign-in reaches them) and
    `DB_POOL_SIZE=5` (5 + 5 overflow). The API now opens at most 40 connections instead of 20, and
    the PostgreSQL memory budget of D9-31 becomes 512 MB + 40 × 16 MB + 3 × 64 MB = 1,344 MB of the
    2 GiB limit. `max_connections` stays 100.
  - nginx details:
    - `map_hash_bucket_size 128` in `nginx.conf`, before the first `map`. Without it `nginx -t` failed
      on this machine with "could not build map_hash, you should increase map_hash_bucket_size: 32".
      The default is the CPU's cache line; on 64-bit Linux with 64-byte lines today's keys would fit,
      but the configuration should not depend on the host.
    - Map strings match without regard to case, so `/api/v1/Reception/today` also reaches the list
      instance and gets the API's 404 there. `$uri` is the normalised path (no query string;
      percent-encoding and dot segments resolved).
    - The access log records the instance as `api_pool` (`$proxy_host`; empty for static files).
    - `VMS_API_RECEPTION_UPSTREAM` and `VMS_API_REPORTS_UPSTREAM` join `VMS_API_UPSTREAM` with image
      defaults (`backend-reception:8000`, `backend-reports:8000`) and the same `host:port` check in
      `25-vms-check-config.sh`, which now also refuses a second colon.
  - `deploy/verify/smoke_test.py` checks that each instance answers its paths: an unauthenticated
    `GET` of one path per instance must get the API's own 401 with nginx's request ID; nginx answers
    503 `SERVICE_BUSY` for an instance it cannot reach.
  - What remains for larger sites: the list instance saturates at 12.4 (the review's measurement) to
    18.9 (this round's, on newer backend code) list loads per second, about 190 to 280 open reception
    pages polling every 15 s. More than that, or a second main instance,
    needs the shared (Redis) rate limiter of contract §3, which is not implemented. Lowering the cost
    of one list load (the backend finding of this round) raises that ceiling for every layout.
    *Partly superseded by D9-35: the list instance now runs as two replicas.*
    *Partly superseded by D9-36: the map matches the path as the client sent it, not `$uri`, and the
    budget of written refusal rows is per process, not only the summary row.*

**Re-audit round 2 (2026-10-06)**

- **D9-35 Two reception-list replicas behind `least_conn`; the lists are inside the 300 ms budget**
  (finding: under stress B `GET /reception/today` still missed the 300 ms reception p95 in D9-34's
  layout. Through nginx the polls' p95 was 300–697 ms, under 300 ms in 0 of 8 runs, and the desk's
  reload 203–530 ms. The re-audit's 4 later runs, interleaved with its runs of two list processes,
  bring that to 293–697 ms and 1 of 12 runs (`docs/production-readiness.md` §3.4). The list instance's
  own `duration_ms` p95 was 385 ms, so the time was spent queueing inside the one process).
  - Cause: one interpreter builds one list at a time. A normal-day list (370 KB) costs about 38 ms of
    server CPU, 101 ms at the 200-row caps. The six tablets' polls and the desk's reload arrive close
    together, and the k-th request waits about (k − 1) × 40 ms. Throughput is not the limit: one
    process builds 24–26 lists a second in a closed loop, and stress B asks for about 7.
  - The budget: `docs/production-readiness.md` §3.1 sets "Other reception endpoints: p95 < 300 ms",
    and the audit measures the lists against it. Round 1's `deploy/README.md` §4 said the list polls
    and the desk's reload were not part of the 300 ms budget. No owner had approved that exception,
    and it is withdrawn: the runbook now states that the 300 ms budget covers the lists, and measures
    the layout against it.
  - Decision: `backend-reception` runs `deploy.replicas: 2`, so two processes build the lists.
    - The nginx group keeps one line, `server ${VMS_API_RECEPTION_UPSTREAM} resolve;`. With `resolve`
      in a zone, every address the name resolves to becomes a server of the group, and nginx follows the
      name every 10 s (`resolver … valid=10s`). Docker's DNS returns one address per replica.
    - `least_conn` sends each list request to the replica with the fewest requests in progress. The
      count is shared by nginx's workers through the zone. Requests differ in cost (a `today` list about
      40 ms, `inside` about 12 ms, a list at the caps about 100 ms), and a burst should not queue behind
      a replica that is still busy.
    - `least_conn` precedes `keepalive`, the order nginx's documentation of `keepalive` requires. On
      nginx 1.30.5 the reverse order also worked in a check here: `nginx -t` passed, connections were
      reused and `least_conn` was in effect. The test keeps the documented order. It does not guard
      against a failure observed here.
  - Result (verification below): two list replicas held all four reception p95 under 300 ms in every
    stress B run, 20 here and the re-audit's 4. The worst poll p95 was 206 ms here, against 528 ms with
    one list process.
  - Why replicas of one service, not a second service: one name, one template line and one startup
    check. The number of list processes is a single compose value, which is also how an operator
    scales the lists. A replica whose process is down is passed over (nginx retries a failed `GET` on
    the other server). A removed replica leaves the group at the next re-resolution.
  - Why `least_conn` rather than round-robin:
    - Under stress B the two were equal within the run-to-run noise. Both held all four budgets in 8 of
      8 runs (poll p95 140–206 ms against 127–199 ms), because both replicas were equally fast.
    - `least_conn` is kept for the unequal case. In a check with one replica slowed to 300 ms per
      request and the other at 10 ms (dummy replicas behind the same configuration, 4 clients × 25
      requests), `least_conn` gave the slow replica 15 of 100 requests and round-robin gave it 50.
    - A list at the 200-row caps (about 100 ms) or a replica on a busier CPU is that case.
  - Rate limits: this is the trade D9-34 accepted, applied to one more process. Each list replica counts
    the per-user API budget for the list requests it receives. One user can make up to 600 list
    requests a minute on each replica, 1,200 in all, and 2,400 API requests a minute over the four
    processes. Writes stay at most 600 a minute, and every other budget is still counted on the main
    instance only. Per process the protection is unchanged: one user can occupy a list interpreter no
    more than before. Coalesced security-event summaries: up to one per process and window.
    *Corrected by D9-36: the budget of written ACCESS_DENIED rows is per process too.*
  - Guards (`deploy/verify/test_api_instances.py`):
    - `backend` must run exactly one process (no `replicas`, no `scale`);
    - `backend-reception` must run at least two;
    - replicas are allowed only on a service whose nginx group balances its servers (`BALANCED`);
    - every group has exactly one `server … resolve` line;
    - the balancing method precedes `keepalive`;
    - database connections are counted per replica against `max_connections` and PostgreSQL's memory
      budget.
  - Resources: one more process with 1 CPU and 512 MiB of limits, and 10 more database connections.
    That is 50 at most, and the PostgreSQL budget of D9-31 becomes 512 MB + 50 × 16 MB + 3 × 64 MB =
    1,504 MB of the 2 GiB limit.
  - Not done here (handed over): the finding's option 2, a contract change. It would drop the `inside`
    and `checked_out` arrays from `ReceptionToday` or make them opt-in (49 % of the bytes, which the
    screen does not read), or answer `X-Background-Refresh` polls with a slim item or counts only.
    That cuts the cost of every list for every layout, and it belongs to the backend and frontend
    owners.

**Security review of the four-process layout (2026-10-07)**

Two reviewers tested the trade of D9-34 and D9-35. Their findings: (1) the routed reads' budgets were
checked by a scratch script only (RT-01 of phase-9-backend.md has since added a suite test for the six
routes, but nothing tied its list to the map); (2) nginx chose the process from the normalised `$uri` but
forwarded the raw path, so GET routes other than the six could run on a read process; (3) the SEC-15
budget of written ACCESS_DENIED rows and the RATE_LIMITED coalescing are counted per process, which
D9-34 called "one summary row per instance"; (4) one user's aggregate API rate is four times the
per-process budget. All four were reproduced here (verification below).

- **D9-36 nginx routes on the path the API receives; the refusal-row bound is stated per process**
  - Cause of (2): `$uri` has percent-encoding decoded, dot segments resolved and duplicate slashes
    merged. `proxy_pass http://$vms_api_pool` has no URI part, so nginx forwards the request URI as the
    client sent it. uvicorn percent-decodes that path and resolves nothing else, and Starlette
    dispatches on it. `GET /api/v1/visitors/../visits` therefore matched "GET /api/v1/visits" and ran
    as `/api/v1/visitors/{visitor_id}/visits` on `backend-reports`, after authentication and the
    `api_per_user` hit. No budget was affected today, because every GET route consults only
    `api_per_user`. But the statement "only the six listed GETs leave the main instance" was false.
  - Decision: the map keys on `"$request_method $vms_request_path"`. `$vms_request_path` (nginx.conf,
    already used by the access log) is `$request_uri` up to the first `?`. These are the bytes nginx
    forwards, neither decoded nor normalised.
    - Each key is a canonical path: lowercase letters, digits and hyphens, with no `%`, no `.` segment,
      no empty segment and no trailing slash. The bytes that match a key are therefore the path the API
      dispatches.
    - Every other spelling misses the map and goes to the main instance, which counts every budget, as
      in the one-process layout. These are percent-encoded letters (`%74oday`), `%2e%2e`, `./`, `../`,
      `//`, `;x` and a fragment.
    - The SPA is not affected: browsers resolve dot segments and do not percent-encode letters. D9-34's
      verification sent `/api/v1/reception/%74oday` to the list instance; it now goes to the main one.
  - Letter case: nginx compares map strings without regard to case, so `/api/v1/Reception/today` still
    reaches a list replica. The API's routes are case-sensitive, so the request matches no route there
    and gets a 404 before any authentication. Checked live: route `unmatched`, no `user_id`. Regex keys
    (`~`) would send such requests to the main instance too. This was not done: the keys stay hashed
    strings, and a test (below) keeps any other route from matching a routed path in another case.
  - Not done: refusing non-normalised API paths with 400, in nginx or in the API (the second reviewer's
    alternative). With the raw-path map they reach only the main instance, where they behave as in the
    one-process layout. Refusing them would change the API's answers on every instance and add nothing
    to this trade.
  - Guards for (1) and (2):
    - `deploy/verify/test_api_instances.py`, 4 new tests:
      - the map's source is `$request_method $vms_request_path`, nginx.conf defines that variable as
        the raw path, and the two API locations only include `api-proxy.conf`, which has no `rewrite`
        (a rewrite would make nginx forward the normalised URI);
      - every routed path is canonical as defined above;
      - no other declared route matches a routed path in any letter case;
      - `ROUTED_READS` of `backend/tests/integration/test_routed_reads.py` lists exactly the map's keys,
        so a request added to the map must be added to the backend test.
    - `backend/tests/integration/test_routed_reads.py` (phase-9-backend.md RT-01), 15 new cases:
      - an unknown query parameter on each routed read (422 on the three with query models, 200 on the
        others) consults only `api_per_user`;
      - an `X-Background-Refresh: 1` poll of each routed read consults only `api_per_user`;
      - letter-case variants of the six paths, sent with a session cookie, run no route on a read
        process and consult no budget;
      - two read processes each write their own 10 ACCESS_DENIED rows and one overflow summary, and
        their own RATE_LIMITED row and deferred summary. The counts cover every event.
      - The module docstring's "up to one summary row per process" is corrected.
    - Not added: a budget test for every GET route (the first reviewer's suggestion). With the map on
      the raw path, a read process runs only the six routes, or none for a letter-case variant, and
      the deploy tests above keep it so. The other GET routes run on the main instance, as before.
  - (3) Refusal rows: the accounting is corrected; the behaviour is not changed.
    - Each process keeps SEC-15's budget in memory: 10 written rows per action, user and 60-second
      window, then one overflow summary. It also coalesces RATE_LIMITED: one row per user, budget and
      window, with the repeats counted on the next row or in a deferred summary.
    - A read process can write only two refusal events: ACCESS_DENIED (a role without the
      capability) and RATE_LIMITED (`api_per_user` spent). No write reaches it, so it writes no
      CSRF_FAILED, VISITOR_LINK_REFUSED or USER_CHANGE_REFUSED. A 401 is not audited.
    - Per user and minute that is up to 4 × (10 + 1) = 44 ACCESS_DENIED rows (11 with one process),
      and about one RATE_LIMITED row per process, plus a deferred summary per process when the
      refusals stop (8 in all, 2 with one process). Each list replica added raises both by one
      process's share. No event is lost: the summaries carry the counts.
    - Why not changed: an exact bound needs a store the processes share (the Redis limiter of
      contract §3, or the database). That is a backend design change.
    - A smaller budget on the read processes would replace evidence (full rows) with counts. It could
      not restore 11 either, since every process writes at least one row and one summary.
    - The table's growth per user stays bounded: R-10 already lets a signed-in user add about 600
      audit rows a minute through successful writes on the main instance. The 33 extra refusal rows a
      minute are small against that.
    - The security owner should accept this bound together with the API budget (hand-over).
  - (4) Aggregate API budget: accepted, not changed.
    - This is the trade D9-34 and D9-35 declared: up to 4 × `RATE_LIMIT_API_PER_MINUTE` per user in
      all, 2 × on the list paths, writes at most 1 ×. Each process is protected as before.
    - Database: one user can keep all the API's database connections busy, 50 now (D9-35) as 20
      before. What grows is the database work one account can cause, with four interpreters instead
      of one. The risk is insider-only: every routed read needs a session, and the access log and
      audit trail name the user.
    - Lower budgets on the read services (the reviewer's option, for example 150 per list replica and
      300 for reports) are not set by default. A shared reception account polls the list 4 times a
      minute per open page, so 150 per replica would allow about 75 pages per account. The
      one-process layout allowed about 150 (600 for everything).
    - An owner who wants the old aggregate can set `RATE_LIMIT_API_PER_MINUTE` per service in
      compose (`environment:`). The signals to watch are per-pool 429s (`api_pool` and `status` in the
      access log) and the list and report p95 (`deploy/README.md` §4).
  - Files: `deploy/nginx/templates/vms.conf.template` (map source and comment), `deploy/nginx/nginx.conf`
    and `snippets/api-proxy.conf` (comments), `deploy/verify/test_api_instances.py`,
    `backend/tests/integration/test_routed_reads.py`. No application code, compose service or setting
    changed.

**Security review, condition 4 (2026-10-07)**

- **D9-37 The read services run the main instance's program with its settings** (condition 4 of the
  review, `docs/security-audit.md` §6, R-1 closure note: no test kept the read services' configuration
  equal to `backend`'s, and a session, cookie, proxy, origin or limiter setting given to one service
  would make the processes disagree on the idle timeout, the cookie, the client address or a budget).
  - Decision: one compose test in `deploy/verify/test_api_instances.py`. Each read service
    (`backend-reception`, `backend-reports`) must have `backend`'s `image`, `build`, `command`,
    `entrypoint` and `env_file` list. In `environment` it may set only the keys of
    `READ_SERVICE_OVERRIDES`, and outside those keys its `environment` must equal `backend`'s.
    - The second rule also catches a key given to `backend` alone or to the `x-api` anchor. `<<: *api`
      merges one level deep, so each read service's own `environment` replaces the anchor's.
    - The allow-list is `PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE`, the only keys compose sets on
      the read services. `RATE_LIMIT_API_PER_MINUTE` is not in it, because compose does not set it. An
      owner who adopts lower read budgets (D9-36) adds it to the list in the same change.
    - `environment` is read in either compose syntax (a map or `KEY=value` items). The Argon2 and
      database-connection tests now use the same reader.
  - Verified:
    - Deploy unit tests: 27, all pass (26 and the new one), with PyYAML. ruff check and format on
      `deploy/`: clean.
    - Mutants, each on a scratch copy of the files the tests read (the repository was not edited). All
      15 failed the new test. Nine failed only the new test: a read service setting
      `SESSION_IDLE_MINUTES`, `COOKIE_SECURE`, `RATE_LIMIT_API_PER_MINUTE`, a lower-case
      `trusted_proxies`, `LOG_LEVEL` passed through from the shell, or `ALLOWED_ORIGINS` in list syntax;
      `TRUSTED_PROXIES` on `backend` alone; `SESSION_IDLE_MINUTES` in the `x-api` anchor; and
      `required: false` on a read service's env file. Six also failed existing tests: a second env file,
      a `command` on a read service and on `backend`, an `entrypoint`, another `image` and another
      Dockerfile.
    - Controls, all passing: the unmodified copy, `PASSWORD_HASH_CONCURRENCY` on `backend`, a read
      service's two keys in list syntax, and `RATE_LIMIT_API_PER_MINUTE` on both read services with the
      key added to the allow-list.
  - Hand-over (*Docs*): condition 4 is met. These passages still call it open: the audit's R-1 closure
    note (conditions table, row 4) and recommendation 5; `docs/security.md` §9.1 and §16 row 9;
    `docs/production-readiness.md` §13.1 and §16 (Deployment row).
  - Files: `deploy/verify/test_api_instances.py`. No compose service or setting changed.

## Verification on this machine (2026-10-06)

Environment: Windows 11, portable PostgreSQL 18.6 (port 5433), nginx 1.30.5 for Windows (zip from
nginx.org, PGP signature verified: key D678 6CE3 03D9 A902 2998 DC6C C846 4D54 9AF7 5C0A, Sergey
Kandaurov, nginx.org/keys/pluknet.key), Chromium via Playwright 1.63. Throwaway roles `vms_p9_owner`/
`vms_p9_app` and databases `vms_p9_*` were created for the run and dropped afterwards. Ports: API
127.0.0.1:8710, nginx HTTPS 127.0.0.1:8711 and HTTP 127.0.0.3:8711 (same assigned port, own loopback
address; one negative control briefly bound 127.0.0.1:8712 for its moved default server).

**Image-equivalent steps**

- Frontend build stage: the `.dockerignore` allowlist copied to a temp tree with
  `docs/contract/pass-token-vectors.json` beside it, `npm ci --ignore-scripts` (180 packages) and
  `npm run build` (tsc -b + vite) succeeded; the Dockerfile's guards passed; output byte-identical to
  the project's `dist`. Without the contract file `tsc -b` fails (TS2307): the named context is needed.
- Backend dependencies: `pip download --only-binary=:all: --require-hashes --no-deps` with Linux
  platform tags (manylinux 2.17–2.41, cp314/abi3) resolved all 38 locked distributions for
  linux/amd64 and linux/arm64 with every hash checked; a `pip check` equivalent (Requires-Dist
  evaluated for Linux markers) found no missing or conflicting requirement.
- Backend file set: the API, Alembic and the CLI were run only from a copy laid out as the image's
  `/app` (`app/`, `alembic/`, `alembic.ini`), so no repository `.env` was read. The HEALTHCHECK command
  itself: exit 0 against the healthy API (with a bogus `HTTP_PROXY` set), exit 1 with nothing listening.

**PostgreSQL provisioning**: `10-vms-roles.sh` refused 7 bad inputs (short, published or identical
passwords, `vms;drop`, identical role names, VAR+VAR_FILE, missing password) creating nothing; run
sourced by a `set -Eeo pipefail` bash (as the image's entrypoint does) it created the roles/database
and leaked no shell option or variable; the result: plain LOGIN roles, no memberships or settings,
datacl `{owner=CTc, app=c}`, schema owned by the owner; no `CREATE ROLE` statement in the server log.
Migrations 0001→0009 ran as that owner in production mode; the production API then **started** with
that runtime role, i.e. the startup privilege allowlist (SEC-23/38/49) accepts the provisioning.

**nginx + production-mode API** (APP_ENV=production, strong SECRET_KEY, https origins,
COOKIE_SECURE=true, TRUSTED_PROXIES=127.0.0.1/32, Resend provider with a placeholder key and host
notifications disabled for the run): `nginx -t` passed on the canonical structure (resolver,
`backend:8000 resolve`, ports 8080/8443) and on the test rendering (only paths, ports, names and the
upstream address substituted, each substitution asserted). `smoke_test.py`: **78 passed, 0 failed**
from 127.0.0.2 and from 127.0.0.1 (headers on 8 HTML routes incl. `/pass`, `/reset-password`, deep
links; no-store/no-cache/immutable; all 21 precached URLs 200; wasm `application/wasm`; gzip + Vary;
404 for missing files and `/openapi.json`; API headers once each + HSTS; nginx request ID; Upgrade →
200; 65,536-byte body reaches the API, 65,537 and an 80 KiB chunked body → 413 envelope; unknown SNI
→ handshake refused; unknown Host → no answer; HTTP→HTTPS 301 keeping path and query; audit row of
the admin sign-in records 127.0.0.2 / 127.0.0.1 and nginx's request ID, not the spoofed
`203.0.113.77` / `X-Request-ID`; 20 KiB API response uncompressed). Negative controls (config mutated,
nginx restarted — Windows nginx cannot reload with shared-memory zones): XFF appended (client in a
trusted range) → recorded 203.0.113.77, FAIL; client request ID passed → FAIL; index.html no-cache →
8 FAIL; webmanifest type removed → FAIL; CSP without `'wasm-unsafe-eval'` → 13 FAIL; SPA fallback
for files → FAIL; API gzip on → FAIL; default server answering → FAIL; app server as default → 2
FAIL. Two mutants survived for documented reasons: appending XFF from an untrusted client is still
safe because the API takes the rightmost untrusted entry (so the overwrite matters when a client's
own address is trusted — the control above), and `/assets/` falling back to `@spa` is equivalent
(the extension rule answers 404). Access log: 0 lines with a query string; 413s have empty
`upstream_status` (refused before the API). API log: 0 query strings; an Upgrade sent directly to
the API logs "Unsupported upgrade request.", none arrived through nginx. With the API stopped:
503 `SERVICE_BUSY` JSON with the API headers and `Retry-After: 5`. TLS: 1.3 and 1.2-GCM accepted;
1.2-CBC (alert 40), 1.1 and 1.0 (alert 70) refused even when offered. Browser traffic used HTTP/2.

**Browser flow** (Chromium, `channel: 'chromium'`, fake camera, certificate trusted by SPKI — no
`ignoreHTTPSErrors`): reception signs in through the UI, lands on `/reception`, the camera plays
(1280×720), the zxing wasm loads (`200 application/wasm immutable`), the pass link pasted → "Verify
ID: Layla Haddad" → Check in → `POST …/check-in 200` → "Checked in"; the visit is CHECKED_IN by QR;
the service worker activated with all 21 precache entries; `/pass` renders the QR with no API call
and keeps the fragment client-side; `/reset-password` strips the fragment. **CSP violations: 0**;
requests leaving the origin: 0; console errors: only the expected 401 of `/auth/me` before sign-in.

**Production configuration** (`python -m app.serve`, 28 cases, all as expected, no secret in any
output): starts with the production-like configuration; refuses missing APP_ENV; empty, placeholder
or 40-character SECRET_KEY; COOKIE_SECURE=false; http APP_BASE_URL; QR_BASE_URL with a path; an http
origin; `*`; TRUSTED_PROXIES=0.0.0.0/0; outbox e-mail; resend without key; RATE_LIMIT_ENABLED=false;
a login limit above 10× default; the owner as runtime role (config check, and at startup when
MIGRATION_DATABASE_URL is absent); the published dev password; a remote database without sslmode, with
`sslmode=require`, via `?service=`; and at startup a runtime role that is a member of pg_monitor, has
`ALTER ROLE … SET`, CREATEDB, or TEMPORARY. A remote `sslmode=verify-full` URL and a remote URL with
`DB_REQUIRE_TLS=false` pass the configuration check and fail only at connecting (no such host here).
CLI in production mode: `create-admin --password-stdin` OK; `prune-sessions` OK with the owner URL
(migrate.env) and refused without it; `mark-no-shows` OK; `seed-e2e` refused.

**Backup/restore drill** (208 MB database: 300,078 audit rows, 60,002 visitors with trigram indexes,
plus real flow data): archive 27.5 MiB (124 TOC entries); `backup.ps1` 7.9–9.1 s, `backup.sh` 4–11 s;
`restore.ps1` 7.8–24.3 s and `restore.sh` 23 s including verification (the machine was shared with
other agents). Refusals: existing target, tampered archive (checksum), bad identifier; an unknown
runtime role failed provisioning and the new database was dropped; a failed dump (wrong password)
left no file. Retention deleted the 30-day-old archive and kept another database's file. Comparison
source ↔ restored (both scripts): identical tables, 137 columns, 167 constraints, 49 indexes, 2
triggers, functions, extensions, effective table/sequence ACLs, 11 column ACLs (audit_logs INSERT
without `seq`), schema owner/ACL, default privileges, database ACL, locale, identity sequence, Alembic
version 0009, and per-table md5 of every row. On the restored copy: the runtime role cannot UPDATE/
DELETE/TRUNCATE audit_logs, DELETE visits, create tables or temporary tables, or choose `seq`; the
owner cannot UPDATE/DELETE audit rows (trigger); CHECK constraints and the terminal-visit trigger fire;
new audit rows continue the sequence. The production API started on the restored database (privilege
check passed) and the smoke test passed (78/78) against it. Note for schema diffs: a dump round trip
re-spells `varchar IN (…)` checks (`ARRAY[('x'::varchar)::text]` instead of
`(ARRAY['x'::varchar])::text[]`) and drops ACLs equal to the owner default — same semantics.

**Static checks**: `docker-compose.yml` parses and validates against the official Compose
Specification JSON schema (compose-spec main, draft 2020-12; negative controls: unknown key and bad
`depends_on` condition are caught) plus reference checks (services, networks, volumes, bind sources,
build contexts, env templates, no inline secrets, no interpolation, TRUSTED_PROXIES = nginx address,
`db` internal, no published DB/API ports). hadolint 2.15.1: 0 findings (DL3022 suppressed with a
comment: named build contexts are not stages). shellcheck 0.11.0: 0 findings (all optional checks
only style/info). PSScriptAnalyzer 1.25.0: 0 warnings/errors; PowerShell parser: 0 errors. gixy-ng
0.2.55 on the canonical structure: 7 medium findings of 5 kinds; after the fixes (D9-14, D9-15,
`open_file_cache`) one remains, "missing HSTS", which concerns the `/api/` locations, whose HSTS comes from the API (checked once, exactly, by the smoke test) — an
nginx copy would duplicate it. ruff `check` and `format --check` on `deploy/` with `deploy/ruff.toml`:
clean. That file is the backend rule set without T201 (`print` is a command-line tool's output; with
the backend's own configuration those were the only findings in `smoke_test.py`) and without PT009
(stdlib `unittest` assertions); its target is Python 3.12. `check_nginx_headers.mjs`: in sync
(7 headers).

**Release hygiene (SEC-R3/SEC-R4)**: before the fix, `backend/UsersUser…fix3outbox/` held 218 files
(56 `.html`/`.json`/`.txt` each for 50 VISITOR_INVITATION and 6 PASSWORD_CHANGED messages, 50 QR PNGs).
They were untracked and not ignored (`git check-ignore` exit 1). The 50 raw pass tokens, hashed as
`hash_token` does (SHA-256), matched no `visitor_passes` or `password_reset_tokens` row in any database
on the cluster (`vms`, `vms_e2e`; the sweep databases named in the findings no longer existed). The
tokens are dead and the recipients are synthetic `example.com` addresses. `check_release_tree.py` on
that tree: exit 1, exactly those 218 files (outbox-artefact 218, stripped-windows-path 218, pass-link
150), nothing else, no token in the output. After the `.gitignore` guard was added:

- `git check-ignore` reports the directory ignored and `outbox.py`/`outbox.ts` not ignored.
- The list `git ls-files --others --exclude-standard` lost exactly the 218 files and nothing else.
- The directory was then deleted. No stray-path directory and no UUID-named outbox file remains
  anywhere in the work tree outside the two ignored outboxes (`backend/var/outbox`,
  `frontend/e2e/.artifacts/run/outbox`).
- Final tree: exit 0 (744 files).

Unit tests: 8 pass (`python -m unittest discover -s deploy/verify -p "test_*.py"`). 17 mutants were
each killed by at least one test: every rule disabled or weakened (no `%2F`, header-only cookies),
exemptions removed or widened to whole test folders, private keys exempt in tests, `--cached` dropped,
a matched value printed, `*.example` flagged, each `.gitignore` guard line removed, and the guard
broadened to `*outbox*` (which would hide `outbox.py`). The tests ran with isolated git configuration;
the mutants patched the imported module and pointed the tests at modified copies of `.gitignore`, so
the real file was never altered. The check also found a cookie-shaped literal in its own first test
draft, which now builds those strings at run time. Python 3.12 itself is not installed here: the
scripts ran on 3.14, and ruff with target 3.12 found no newer syntax.

**Readiness round 1 (2026-10-06).** Throwaway databases `vms_dfr1_*` and roles `vms_dfr1_owner`/
`vms_dfr1_app` were created for the run and dropped afterwards. Ports: drill API 8792, silent proxy
8793, production API 8794 (8796 on the restored database), nginx HTTPS 127.0.0.1:8795 and HTTP
127.0.0.3:8795, throwaway cluster 5491.

*Shutdown drill.* The real API ran in development mode in its own process group. The drill sent it
CTRL_BREAK, which is SIGBREAK on Windows and takes uvicorn's `handle_exit`, the same path as SIGTERM
in a container. Exit code 3 is Windows' default action for the re-raised signal. The "unbounded"
column ran the same server options without `timeout_graceful_shutdown`, which is the code before the
fix. "Summary" is the deferred CSRF_FAILED row that the flush writes. Each scenario sent four
cross-site POSTs before the stop: one row was written, and the flush carried `coalesced: 2`.

| Scenario | Unbounded | With the fix |
|---|---|---|
| No request in flight | (not run) | exit 0.2 s; summary at 0.2 s |
| An invitation retrying against an HTTPS proxy that never answers | exit 48.3 s; summary at 48.2 s; e-mail FAILED after 3 attempts | exit 20.3 s; summary at 20.3 s; e-mail PENDING after 1 attempt (cut off) |
| A cancel blocked on a row lock that another session held for 45 s | exit 45.3 s, when the lock was released; summary at 45.3 s; 200, visit CANCELLED | exit 45.2 s; summary at 45.2 s; client 500, visit SCHEDULED |
| The same, with `lock_timeout = 30s` set on the database | (not run) | exit 28.9 s; summary at 28.8 s |

In the third row the request was cancelled at 20 s, as intended, but the lifespan shutdown still
waited for the lock. A thread dump (`faulthandler`, 36 s after start) showed the cause: the event-loop
thread itself was blocked in `get_db` → `Session.rollback()`.

1. FastAPI's `contextmanager_in_threadpool` catches `Exception` only. On cancellation the
   request-scoped session generator is therefore closed on the event-loop thread.
2. Its rollback waits for the psycopg connection, which the still-running worker thread holds.
3. So the whole event loop stalls until that statement ends.

This is application code, so it is handed over below. With a database timeout the stuck statement
ends by itself, and the shutdown fits the grace period (fourth row).

*Regression tests.* `tests/unit/test_serve.py` has 8 tests and all pass. Ruff, the format check and
mypy pass on `app/serve.py`. Three mutants were each killed:

- the server options without the timeout: 3 failures, including the behavioural test, where the
  lifespan shutdown waited for a request stuck in a worker thread;
- the compose grace period back at 30 s;
- `init` removed from the compose file.

*PostgreSQL settings.*
- A throwaway PostgreSQL 18.6 cluster started with exactly the compose arguments (`hba_file`
  replaced by a local file). Every setting reported `source = command line` with the expected value,
  and the server log had no warning.
- Plans on a 60,000-visit, 20,000-visitor throwaway database (the review's seed). The planner settings
  were set per session on the shared cluster; `shared_buffers` cannot be set that way, and it does not
  change plans. Two alternating runs per profile:
  - history "Garcia", stock settings: `Seq Scan on visits` in both statements, 22.7–23.3 ms (page)
    and 19.5–42.3 ms (count);
  - history "Garcia", compose settings: index plans, 7.2–11.7 ms and 5.6–10.9 ms;
  - the old totals query at 4MB: `external merge Disk: 3024kB`; at 16MB: `quicksort Memory: 5088kB`;
  - the current 366-day report: no spill under either profile, and the same sequential scan (it reads
    366 of 400 days).
  - Endpoint timings moved within the noise of a shared laptop.

*Area checks, all green.*
- Static checks: deploy unit tests 8/8; ruff check and format on `deploy/`; header drift check in
  sync (7 headers); `docker-compose.yml` passes the Compose Specification schema and the reference
  checks; hadolint 0 findings; shellcheck 0 findings; `check_release_tree.py` OK (753 files).
- Production stack:
  - `10-vms-roles.sh` provisioned the roles and database through the dev cluster's superuser.
  - Migrations 0001→0010 ran as the owner from an image-layout copy of the backend (no repository
    `.env`).
  - `create-admin` worked in production mode, and the production-mode API started with the runtime
    role.
  - `nginx -t` passed on the canonical rendering and the test rendering.
  - `smoke_test.py`: 78 passed, 0 failed, from 127.0.0.2 and from 127.0.0.1.
  - With the API stopped, nginx answered 503 `SERVICE_BUSY` JSON with `Retry-After: 5` and HSTS.
  - The nginx access log had 111 lines and no query string.
- Backup and restore:
  - `backup.sh` and `backup.ps1` each wrote an archive (126 entries).
  - `restore.sh` and `restore.ps1 -RequireChecksum` each restored into a new database and verified it:
    schema 0010, both triggers, runtime-role privileges, row counts.
  - Refused as expected: an existing target, and a tampered archive (checksum mismatch).
  - The production API started on the restored database and stopped in 0.2 s.

**Re-audit round 1 (2026-10-06, D9-34).** Throwaway databases `vms_dfx_ra1_*` (a 60,000-visit,
20,000-visitor seed, the review's seed script, copied per run) and roles `vms_dfx_ra1_owner`/
`vms_dfx_ra1_app` were created for the run and dropped afterwards. Ports: API 8961 (main), 8962
(reception lists), 8963 (reports); nginx 1.30.5 for Windows HTTPS 127.0.0.1:8964 and HTTP
127.0.0.3:8964.

*nginx.*
- `nginx -t` passed on the canonical rendering (the three upstreams with `resolve`) and on the test
  rendering. Before `map_hash_bucket_size` was set it failed: "could not build map_hash, you should
  increase map_hash_bucket_size: 32".
- Live routing, three development-mode API processes behind nginx with the repository's
  configuration (`TRUSTED_PROXIES` = nginx, so the API adopts nginx's request ID): 27 checks passed,
  0 failed. Each request's instance was found by its request ID in the three API logs and matched
  the access log's `api_pool`:
  - `GET` today, inside, reports, audit, admin dashboard and the visit list/search reach their read
    instance with 200, unauthenticated ones with the API's 401, and a percent-encoded path
    (`/api/v1/reception/%74oday`) reaches the list instance too;
  - `HEAD` and `POST` on the list path, a trailing slash, `GET /visits/{id}`, `POST /visits`, scan,
    sign-in, `/auth/me`, the employee dashboard, visitor search, health and `/api` reach the main
    instance;
  - `/api/v1/Reception/today` reaches the list instance and gets the API's 404 (map strings ignore
    case);
  - a static file has an empty `api_pool`;
  - a sign-out on the main instance makes the list instance answer 401 at once.

*Budgets on the routed paths.* The real application with a limiter that records every policy it is
asked about: each of the six routed endpoints consulted only `hit:api_per_user`, for every role that
may call it (receptionist, administrator, management, host) and for the 403 answers to roles that may
not. An anonymous call consulted nothing. The positive control, a scan, consulted `api_per_user` and
`scan_per_user`. 15 of 15 checks passed.

*Stress B* (the review's scenario, `deploy/README.md` §4). The four layouts were interleaved: one
instance; the analysts on a second instance; three instances with each client sent straight to its
instance; three instances through nginx. Each run used a fresh database copy, and every round but the
first began with the same warm-up. Results:

| Layout | Frozen code: 3 runs, both ≤ 300 ms | scan p95 | check-in p95 | Code changing during the runs: 5 runs, both ≤ 300 ms | scan p95 | check-in p95 |
|---|---|---|---|---|---|---|
| One instance | 3 | 198–209 | 187–281 | 3 | 190–330 | 229–403 |
| Analysts on a second instance | 3 | 82–99 | 98–131 | 4 | 110–208 | 119–312 |
| Three instances, direct | 3 | 43–51 | 57–62 | 5 | 44–65 | 65–80 |
| Three instances, nginx | 3 | 42–73 | 58–98 | 5 | 31–63 | 44–98 |

- About the two halves of the table: another fixer's backend changes landed during the first 20
  runs, which the API processes picked up at their next start. The last 12 runs ran a copy of the
  backend frozen at 18:16.
- No request failed in any run.
- Host CPU (median per run) was 31–77 %. The three-instance runs held the budget at 77 %.
- The list polls and the desk's reload (p95 163–777 ms over all three-instance runs) stayed in the
  range of the single-instance runs (244–618 ms).

*Throughput of one process* (4 clients, 20 s, frozen code): `/reception/today` 18.9 requests/s,
`/reception/inside` 56.3, `/auth/me` 262.2. The review measured 12.4, 25.5 and 202.2 on the code
before this round's backend fixes. Working sets: about 110–120 MB per instance under stress B, peak
176 MB on the main instance after Argon2 sign-ins. These figures are the basis of the memory rule
in the compose test.

*Production-mode stack* (an image-layout copy of the backend, no repository `.env`).
- `10-vms-roles.sh` provisioned the throwaway roles and database through the dev cluster's
  superuser, migrations 0001→0010 ran as the owner, and `create-admin --password-stdin` succeeded.
- Three production-mode instances (`APP_ENV=production`, Resend with a placeholder key,
  `TRUSTED_PROXIES` = nginx) started with the runtime role and ran behind nginx.
- `smoke_test.py` with the client-address check: **81 passed, 0 failed**. That is 78 plus one check
  per instance. Its admin check signs in on the main instance and reads the audit log on the reports
  instance.
- Negative controls:
  - with `backend-reception` stopped, exactly one check failed, that instance's (503
    `SERVICE_BUSY` from nginx);
  - with `backend-reports` stopped, its own check and the audit-log lookup of the client-address check
    failed (75 passed, 2 failed);
  - after each instance came back: 81 passed, 0 failed.
- Access log: 484 lines, none with a query string in `uri` or `path`. Each API request carried its
  `api_pool`, and static files an empty one.

*Area checks, all green.*
- Deploy unit tests: 20, all pass. The 12 new ones in `test_api_instances.py` pass with PyYAML; without
  it the 5 compose tests are skipped.
- 22 mutants, each killed by at least one test: a write routed away, `/auth/me` routed away, a routed
  path that is no API route, a dropped route, the default upstream changed, `resolve` removed,
  `keepalive_timeout` 5 s, `proxy_pass` to the main upstream only, no `map_hash_bucket_size`, a size
  of 32, `api_pool` not logged, an upstream variable not checked at start, a wrong image default,
  nginx not waiting for one instance, the read instances' pool at 10, a read instance at 256m, the
  main instance at 640m, `migrate.env` on a read instance, `init: false`, a `command`, a published
  port, and a 30 s grace period.
- `backend/tests/unit/test_serve.py`: 8, all pass.
- ruff check and format on `deploy/`: clean.
- shellcheck 0.11.0: 0 findings with the default checks. With `-o all` there are only style and info
  findings.
- hadolint 2.15.1: 0 findings.
- `check_nginx_headers.mjs`: in sync (7 headers).
- `check_release_tree.py`: exit 0.
- `docker-compose.yml` parses (PyYAML; the merge keys resolve as intended).

**Re-audit round 2 (2026-10-06, D9-35).** Throwaway databases `vms_dfx_ra2_*` (the review's
60,000-visit, 20,000-visitor seed, copied per run) and, for the production-mode stack, roles
`vms_dfx_ra2_owner`/`vms_dfx_ra2_app` were created for the run and dropped afterwards.

- API ports: main 127.0.0.1:9261, reports 127.0.0.1:9263. The two list replicas listened on
  127.0.0.21:9262 and 127.0.0.22:9262: the same port on loopback addresses of their own, like two
  containers on port 8000.
- nginx 1.30.5 for Windows: one prefix per layout, HTTPS on 127.0.0.1:9264/9266/9267/9268.
- A stand-in for Docker's DNS: a small authoritative responder (A records from a JSON file, re-read
  on every query) on 127.0.0.1:9265. nginx's `resolver` pointed at it, and the upstreams kept their
  names and `resolve`. Round 1's test rendering had replaced them with fixed addresses.

*nginx.*
- `nginx -t` passed on the canonical rendering and on every test rendering.
- A Windows-only finding: with `worker_processes 2`, an nginx worker crashed (exit code C0000005) at
  re-resolutions of the `resolve` upstreams.
  - It crashed 24 times in 25 s with one address per name, round 1's layout, and also with two
    addresses. Round 1 never ran `resolve` live.
  - On Windows, nginx's shared memory is not mapped at one address in every worker, and only one
    worker accepts work there anyway.
  - The test renderings therefore run one worker, with the error log at `notice`, the level at which
    the master reports a crashed worker.
  - No worker crashed in any run below. On Linux the master maps the zones before it forks the
    workers, so every worker sees them at the same address. Not verified here (NOT VERIFIED below).
- Live routing, four development-mode API processes behind the repository's configuration
  (`TRUSTED_PROXIES` = nginx; each request's process found by nginx's request ID in the four API logs):
  11 checks passed, 0 failed.
  - One name, two addresses, two servers: 10 sequential `GET /reception/today` went 5 and 5, 6
    `GET /reception/inside` went 3 and 3, and 5 bursts of 8 concurrent list loads went 20 and 20.
  - Visit creation, scan, check-in, `HEAD` on the list path and `/auth/me` reached the main instance.
    The audit log, admin dashboard and visit list reached the reports instance.
  - The second address removed from DNS: 13 s later all 8 list GETs reached the first replica.
    Added back: both served again after 13 s.
  - The second replica's process stopped while DNS still listed it: 10 of 10 list GETs answered 200
    from the first. The first request's `upstream_status` was `502, 200`: nginx passed it on.
  - The access log's `api_pool` values were `vms_api`, `vms_api_reception` and `vms_api_reports`.
- Balancing, with dummy replicas (one slowed to 300 ms per request, one at 10 ms) behind the same
  configuration, 4 clients × 25 requests:
  - `least_conn`: 15 slow / 85 fast;
  - round-robin: 50 / 50;
  - `least_conn` placed after `keepalive`: 5 / 95, with upstream connections reused (4 for 100
    requests) and `nginx -t` passing;
  - 100 sequential requests used 2 upstream connections in either order.

*Stress B* (the review's scenario: 6 polls a second, the desk scanning, checking in and reloading the
list back to back, 120 times per run, and 3 analysts without pause).
- Setup: every request went through nginx with the repository's rendering, and the list replicas were
  found through the stand-in DNS. The layouts were interleaved, with their order rotated every round.
  Each run had a fresh database copy and the same warm-up.
- p95 in ms; "list process" is the `duration_ms` p95 of `GET /reception/today` in each list
  process's own log:

| Layout | Runs | All four < 300 | Scan | Check-in | Desk reload | Poll | List process | Host CPU |
|---|---|---|---|---|---|---|---|---|
| One list process (D9-34) | 8 | 6 | 32–68 | 42–85 | 149–495 | 160–528 | 138–473 | 36–54 % |
| Two replicas, `least_conn` | 8 | 8 | 32–53 | 40–70 | 118–176 | 140–206 | 115–179 | 36–54 % |
| Two replicas, round-robin | 8 | 8 | 33–50 | 44–71 | 110–177 | 127–199 | 100–165 | 37–51 % |
| One list process, 5 spinning processes | 4 | 4 | 35–40 | 43–48 | 168–199 | 179–227 | 149–189 | 78–79 % |
| Two replicas, `least_conn`, 5 spinning | 4 | 4 | 33–40 | 43–50 | 128–158 | 146–186 | 132–155 | 79–80 % |

- No request failed, nginx answered only 2xx in all 32 runs, and no nginx worker crashed.
- The one-process layout missed in rounds 1 and 2, the two runs with the most load from other test
  runs (52–54 % host CPU). The re-audit's runs on a host loaded by other test runs (33–94 %) are less
  favourable to it: through nginx, list polls under 300 ms in 0 of 8 runs. With its 4 later runs
  (18–37 %) that is 1 of 12 (`docs/production-readiness.md` §3.4). Two list processes held all four
  in all 4 of the re-audit's runs and in all 20 runs here.
- 12 polls a second, about 180 open reception pages, 3 runs per layout on a quiet host (39–42 % CPU).
  Poll p95: one list process 212–249 ms, two 169–182 ms, three 149–173 ms. All four were under
  300 ms in 9 of 9 runs.
  - The 12 pollers share two receptionist accounts. Six simultaneous sign-ins of one account from one
    address exceed the per-(address, e-mail) sign-in budget, whose slots stay reserved while a
    password is being verified.
  - The first attempt lost 1–2 pollers per run to 429 and was discarded. The repeat raised that
    budget in the harness, as the review's harness had.

*Production-mode stack.*
- Setup: an image-layout copy of the backend (`APP_ENV=production`, Resend with a placeholder key,
  `TRUSTED_PROXIES` = nginx). `10-vms-roles.sh` provisioned the throwaway roles and database,
  migrations ran 0001→0010, and `create-admin` succeeded. The main instance, the two list replicas and
  the reports instance ran behind the repository's configuration, which resolved them through the
  stand-in DNS.
- `smoke_test.py` with the client-address check: **81 passed, 0 failed**.
- With one list replica stopped: 81 passed, 0 failed. nginx passed the list request on
  (`upstream_status` `502, 401`).
- With both stopped: 80 passed, 1 failed, the reception-list check (503 `SERVICE_BUSY` from nginx).
- Both restarted: 81 passed, 0 failed. No nginx worker crashed.

*Area checks, all green.*
- Deploy unit tests: 22, all pass, including the 2 new ones and the extended upstream and connection
  tests (with PyYAML).
- 13 mutants, each killed by at least one test, run on a copy of the files (the repository was not
  edited):
  - the list replicas removed, or set to 1;
  - replicas or `scale` on the main instance;
  - replicas on the reports instance, whose group does not balance;
  - three list replicas at pool 10 (beyond the PostgreSQL memory budget);
  - the compose comment's connection count left at 40;
  - `least_conn` removed, placed after `keepalive`, replaced by `random`, or added to the main group;
  - a second `server` line for the lists;
  - `resolve` dropped on the list group.
- `backend/tests/unit/test_serve.py`: 8, all pass.
- Linters:
  - ruff check and format on `deploy/`: clean;
  - shellcheck 0.11.0 and hadolint 2.15.1: 0 findings;
  - `check_nginx_headers.mjs`: in sync (7 headers);
  - `check_release_tree.py`: exit 0.

**Security review of the layout (2026-10-07, D9-36).** Throwaway database `vms_fixsplit_dd417b9c`
(migrated, `seed-demo`) was created for the run and dropped afterwards.

- API: four development-mode `python -m app.serve` processes with `TRUSTED_PROXIES` = nginx: main on
  127.0.0.1:9481, the list replicas on 9482 and 9483, reports on 9484.
- nginx 1.30.5 for Windows on 9480, with the repository's `$vms_request_path` map, routing map, upstream
  blocks and `api-proxy.conf` taken verbatim (servers at fixed addresses).
- A second nginx on 9490 in front of four echo upstreams (9491–9494), which return the method and the
  raw request target they received.
- Requests were sent as raw HTTP/1.1 request lines, so no client normalised them.

*Before the fix (map on `$uri`).*
- Echo probe, 35 request targets: 24 reached a read pool, 16 of them non-canonical spellings, each
  forwarded unchanged. These were dot segments, `%2e%2e` and `%2E%2E`, `%74oday`, `//`, a fragment,
  `/static/../api/v1/visits` and letter case. HEAD, OPTIONS, POST, a trailing slash, `;x`, `%3F` and
  `%2F` went to main.
- Real stack, administrator session:
  - `GET /api/v1/visitors/../visits` and `/api/v1/visitors/%2e%2e/visits` ran on the reports process
    as `/api/v1/visitors/{visitor_id}/visits` (404);
  - `/api/v1/reception/%74oday` ran `/reception/today` on a list replica (200);
  - `reception/scan/../today`, `users/../audit-logs`, `auth/me/../../reports/summary` and `//` reached
    read processes and got 404 there.
- Refusal rows: one EMPLOYEE sent 150 forbidden GETs within a minute through nginx, 25 each to
  `/users`, `/reports/summary`, `/audit-logs`, `/reception/today`, `/reception/inside` and
  `/dashboard/admin`.
  - Through nginx: 40 full ACCESS_DENIED rows, then 4 overflow summaries after the window (coalesced
    14, 64, 14, 14), 44 rows in all.
  - A second EMPLOYEE sent the same 150 straight to the main process: 10 rows and 1 summary
    (coalesced 139), 11 rows.
  - Both account for all 150 events.
- Aggregate budget: with `RATE_LIMIT_API_PER_MINUTE=30` on all four processes, one MANAGEMENT session
  got 120 answers of 200 in 3 s: main 30, reports 30, the two list replicas 60. Every further request
  got 429 from its own process.

*After the fix (map on `$vms_request_path`).*
- Echo probe: 10 of the 35 targets reached a read pool. These were the 8 canonical ones (with and
  without query strings, one in absolute form) and the 2 letter-case variants. No other non-canonical
  spelling did, and HEAD still went to main (access log).
- Real stack:
  - every dot-segment, percent-encoded and doubled-slash spelling ran on the main process,
    `/api/v1/visitors/../visits` there as `/visitors/{visitor_id}/visits`;
  - the canonical paths ran on their read processes;
  - the letter-case variants reached read processes as route `unmatched`: 404 in 1–2 ms, without a
    `user_id`.
- `nginx -t` passed on the canonical rendering (round 2's renderer: upstream names with `resolve`, the
  production resolver address).
- nginx for Windows: `nginx -s reload` could not map the `vms_api` zone ("MapViewOfFileEx … failed
  (487)") and kept the old configuration. A stop and start loaded the new one. This is the Windows
  shared-memory limit of round 2's verification.

*Tests.*
- Deploy unit tests: 26, all pass (22 and the 4 new ones), with PyYAML. ruff check and format on
  `deploy/`: clean.
- Backend gate: ruff check, ruff format --check and mypy (129 source files): clean. `pytest` and
  `pytest --committed-first`: 2195 passed and 3 skipped (the opt-in performance checks) in both orders,
  against 2180 and 3 before. `test_routed_reads.py`: 61 items (46 and the 15 new ones).
- Mutants, each on a scratch copy (the repository was not edited). Each was killed by the intended
  tests and no others.
  - Backend, 6:
    - a background poll consulting a second budget (the 6 background-poll cases);
    - a 422 answer consulting a budget (the 3 routes with query models);
    - a router that ignores letter case (1);
    - one coalescer shared by all processes, which is what a shared store would do (both refusal-row
      tests);
    - ACCESS_DENIED without its row budget (1);
    - RATE_LIMITED not coalesced (1).
  - Deploy, 7:
    - the map back on `$uri` (all 12 routing tests: the map is not found);
    - `$vms_request_path` built from `$uri` (1);
    - a `rewrite` in the `/api/` location (1);
    - `proxy_pass` with `$uri` (1, an existing test);
    - a key with a trailing slash in the map, `EXPECTED_ROUTES` and the backend test (2);
    - a key missing from the backend test (1);
    - a new route `GET /reception/{kind}` (1).

## NOT VERIFIED (requires Docker or production infrastructure)

- Readiness round 1: the shutdown in a Linux container. SIGTERM through `init`, exit 143, and the
  45 s grace period are reasoned from uvicorn's code and Linux signal rules for PID 1; they were
  observed on Windows only, with CTRL_BREAK.
- Readiness round 1: the PostgreSQL settings inside the container (memory under the 2 GiB cgroup
  limit), and plans on production data and hardware.
- Re-audit round 1: three API services in compose. Not run: four services that build or use the one
  `vms-backend:local` image (`build` sits in the shared anchor, as it already did for `migrate`), the
  `resolve` of the two new service names through Docker's DNS, `depends_on` on three health checks, and
  the read instances under their 1 CPU / 512 MiB limits. The routing, the three processes and their
  settings were exercised outside containers (verification above).
- Re-audit round 1: the layout's latency on production hardware. The stress runs used a laptop shared
  with other agents' test runs.
- Re-audit round 2 (D9-35):
  - `deploy.replicas: 2` under Docker Compose: two containers of `backend-reception`, Docker's DNS
    answering the service name with both addresses, and `depends_on: service_healthy` waiting for
    both. Here a stand-in DNS server gave nginx the two addresses.
  - nginx's `resolve` with two workers on Linux. On Windows a second worker crashes at each
    re-resolution, so the verification ran one worker (below).
  - The stress B result under the compose CPU limits (1 CPU per list replica) on Linux. Re-measure
    on the production host: `deploy/README.md` §4 names what to watch.
- Security review (D9-36):
  - The raw-path map in the Linux container. It was run on nginx 1.30.5 for Windows only.
  - HTTP/2 requests. The probes used HTTP/1.1, and neither curl nor Python here speaks HTTP/2.
    nginx builds the request URI of an HTTP/2 request from `:path` and parses it as it does an
    HTTP/1.1 request line. This is reasoned from nginx's source.

- `docker build` of both images and `docker compose config/build/up` (no Docker): the BuildKit named
  contexts, `--chmod` copies, the npm cache mount, the pip install inside the image (only simulated
  with Linux wheels), uninstalling pip, the non-root users' permissions.
- Container runtime: read-only root filesystems with the tmpfs mounts, `cap_drop: ALL`,
  `no-new-privileges`, resource/pids limits, the image entrypoint's envsubst rendering,
  `15-local-resolvers.envsh` and the `resolve` re-resolution against Docker's DNS, the health checks
  inside containers, depends_on ordering, the fixed-address network.
- The postgres image's first-start initialisation with this init script and `hba_file`, the
  `en_US.UTF-8` ctype on Linux glibc (reasoned from the PostgreSQL source; trigram behaviour verified
  on the Windows `en-US` cluster only), the 18-image volume layout.
- `backup.sh`/`restore.sh --compose` (exercised only in direct mode under Git Bash; there `chmod` and
  `umask` do not map to NTFS ACLs, so the 0600/0700 modes were not observable).
- PostgreSQL over TLS with `sslmode=verify-full` (the shared local cluster has `ssl=off` and was not
  restarted); a certificate from a public CA; real Resend delivery.
- Performance under production load and on production hardware (the drill's timings are a laptop
  shared with other runs).

## Release checklist (repository hygiene)

Before the first commit, and before every release tag:

1. `python3 deploy/verify/check_release_tree.py` exits 0. Its tests:
   `python3 -m unittest discover -s deploy/verify -p "test_*.py"`.
2. `git status --porcelain --ignored`: every `!!` entry belongs to a known family (`.env`, `.local/`,
   caches and `__pycache__/`, `backend/var/`, `frontend/dist/`, test reports, `frontend/e2e/.artifacts/`,
   `node_modules/`, `deploy/env/*.env`, `deploy/tls/`). Delete an unknown ignored entry; do not leave
   it behind. One the stray-path guard of D9-29 hides is a symptom of a mistyped path setting.
3. `git check-ignore -v .env deploy/env/backend.env deploy/tls/tls.key` names a rule for each path.
4. Review the list of files the commit adds (`git diff --cached --stat`). The check recognises
   artefacts by name and shape only.

## RPO / RTO guidance

- **RPO with logical dumps alone** equals the dump interval: the runbook's example runs every 6 hours
  (RPO ≤ 6 h); nightly gives ≤ 24 h. Each archive is one consistent snapshot.
- **Banks and government deployments should add continuous WAL archiving** (pgBackRest or WAL-G to
  off-host object storage, weekly base backups, `archive_timeout` 60 s) for point-in-time recovery:
  RPO ≈ 1 minute. Keep the logical dumps as the independent second line (portable, verifiable by the
  restore script, immune to physical corruption being replicated).
- **RTO** ≈ detection and decision + provisioning (roles; minutes) + restore + verification + switch
  (stop API, rename databases, start: about a minute). Restore time grows with data plus index size
  (GIN trigram index builds dominate): the drill restored a 208 MB database in 8–24 s on this laptop;
  extrapolate per GB from your own quarterly drill on production hardware, and size the target from
  it (e.g. a database under 20 GB: RTO under one hour is realistic).
- **Practice**: restore the newest archive into a scratch database at least quarterly
  (`restore.sh --target-db vms_restore_test` verifies it), record the time, drop it. Keep archives
  encrypted off-host for the retention period the data-protection policy sets for visitor personal
  data and the audit trail; deletion of old archives is part of that policy.

## Residual risks and known limits

- nginx error-log lines (level `error`) quote the failed request's request line, query string
  included (e.g. "client intended to send too large body … request: "POST /api/v1/…""). They are rare;
  treat nginx error logs as sensitive in the log pipeline.
- Requests rejected by nginx before location processing (400/414/494) carry no security headers;
  they have no content.
- HTTP→HTTPS assumes public port 443; clients must use the configured name (IP-address access gets
  no TLS handshake).
- Docker's userland proxy hides IPv6 clients' addresses behind the bridge gateway (one shared
  per-IP budget); enable IPv6 on the network or disable the userland proxy before serving IPv6.
- Logical backups alone bound the RPO by the dump interval (above).
- Shutdown (D9-32):
  - A request blocked inside PostgreSQL holds up the lifespan shutdown until its statement ends (see
    the readiness drill). If that takes longer than 45 s, the SIGKILL still loses the coalesced counts.
    Since RR1-03 (phase-9-backend.md) the database bounds such a statement: every connection of the
    API's engine sets `lock_timeout` (`DB_LOCK_TIMEOUT_MS`, 10 s) and `statement_timeout`
    (`DB_STATEMENT_TIMEOUT_MS`, 30 s) in its startup options (`backend/app/core/config.py`,
    `backend/app/db/session.py`). The measured stops with a stuck request or delivery took 4.2–25.4 s
    against the 45 s `stop_grace_period` (`docs/production-readiness.md` §4.5). This assumes the
    default timeouts, which `backend.env.example` does not change: a timeout raised close to 45 s would
    let a blocked request outlast the grace period again. The session clean-up on the event loop
    (hand-over below) is still open.
  - An e-mail delivery still running after 20 s is cut off. Its row stays PENDING with the attempts
    made so far.
  - uvicorn answers a request cancelled at 20 s with a plain-text 500, not the API's JSON envelope.
    nginx passes it through.

## Hand-over

- **Repository root**: add `*.sh text eol=lf` (and ideally `Dockerfile text eol=lf`) to a root
  `.gitattributes`: with `core.autocrlf=true` (this machine) `scripts/backup.sh`/`restore.sh` would be
  checked out with CRLF. `deploy/` has its own `.gitattributes`.
- **CI**: build both images (`docker compose build`), start the stack with test certificates, run
  `deploy/verify/smoke_test.py`, `node deploy/verify/check_nginx_headers.mjs`, hadolint, shellcheck;
  scan images and produce an SBOM (security audit recommendation 8). Also, on every push:
  `python3 deploy/verify/check_release_tree.py`, its unit tests, and `ruff check deploy`.
- **Backend (root cause of SEC-R3/SEC-R4; app code, not changed here)**: `Settings._outbox_dir`
  (`backend/app/core/config.py`) resolves every non-absolute `EMAIL_OUTBOX_DIR` under `backend/`,
  including a Windows drive-relative path such as `C:UsersYou…`, which is what an unquoted `C:\…`
  becomes in a POSIX shell. It should refuse a path with a drive but no root (`value.drive and not
  value.root`), and preferably any relative path that resolves outside `backend/var/`. The
  `.gitignore` guard and the release check only contain the damage.
- **Security audit owner**: recommendation 15 is done. The directory was deleted on 2026-10-06;
  prevention is D9-29/D9-30. `.env` stays untracked (ignored by `.gitignore:5`).
- **Backend (app code, not changed here)**: `python -m app.cli prune-sessions` without
  `MIGRATION_DATABASE_URL` ends with a raw traceback whose message says "required to run migrations";
  catching `ConfigurationError` in `app/cli.py` would print one clear line.
- **Contract owner**: §10/§15 say "no-cache" for `index.html`; SEC-51 and this deployment use
  `no-store` (stricter).
- **Docs**: link `deploy/README.md` from the root README / `docs/development.md`.
- **Readiness round 1, backend (app code, not changed here)**:
  - The request-scoped session's teardown runs on the event-loop thread when a request is cancelled.
    FastAPI's `contextmanager_in_threadpool` only handles `Exception`, so the `get_db` generator is
    closed by garbage collection there. Its `rollback()` then waits for the psycopg connection that
    the still-running worker thread holds, and the whole loop stalls (D9-32, thread dump in the
    drill). Possible fixes: do that cleanup in a worker thread, or skip blocking I/O on the loop thread.
  - A statement and lock timeout for the API's connections (the DB-timeout finding) would also bound
    this. With `lock_timeout` 30 s the drill stopped in 28.9 s. *Done: RR1-03 in phase-9-backend.md
    (`DB_LOCK_TIMEOUT_MS` 10 s, `DB_STATEMENT_TIMEOUT_MS` 30 s).*
  - E-mail dispatcher: let deliveries see the shutdown (skip the backoff sleep, stop retrying, record
    FAILED "interrupted by shutdown" or a recoverable state). Today a delivery is cut off at 20 s and
    stays PENDING.
- **Readiness round 1, docs**: `docs/production-readiness.md` (contract §15) does not exist yet. It
  should carry or link `deploy/README.md` §4 (capacity per instance, PostgreSQL settings, shutdown).
- **Re-audit round 1 (D9-34)**:
  - *Security documentation*: `docs/security.md` §9.1 ("run exactly one API process per deployment"),
    the hardening table row 9, the audit's R-1 and recommendation 5 (`docs/security-audit.md`), and
    `docs/architecture.md` ("exactly one API process per deployment") describe the one-process layout.
    The deployment now runs three processes. No sign-in, recovery, lockout, e-mail, scan or attendance
    budget is multiplied, but the per-user API budget is counted per instance for the routed reads
    (up to 3 × `RATE_LIMIT_API_PER_MINUTE` in all, writes unchanged), and coalesced security summaries
    are per instance. The security owner should confirm this trade and reword those passages.
    *Done: the audit's R-1 closure note (with dated notes on recommendation 5, SEC-15 and R-10),
    `docs/security.md` §9.1 and §16 row 9, and `docs/architecture.md`'s process model. The engineering
    security review accepted the trade with conditions. The sign-off by the deploying organisation's
    security owner is a go-live item (`docs/production-readiness.md` §15 H).*
  - *Backend*: a regression test that the six routed endpoints consult only `api_per_user` (this round
    checked it with a recording limiter in a scratch script, not in the suite). A new budget on one of
    them would silently be counted per instance; `deploy/verify/test_api_instances.py` lists the
    routed paths and states that rule. *Done: RT-01 in phase-9-backend.md
    (`backend/tests/integration/test_routed_reads.py`), tied to the map by D9-36.*
  - *Backend*: the shared (Redis) rate limiter remains the only way to run more than one main instance.
    (Sharing the list polls over several processes is D9-35's trade: only the per-user API budget is
    counted per process.)
- **Re-audit round 2 (D9-35)**:
  - *Security owner*: the deployment now runs four API processes. As in D9-34, no sign-in, recovery,
    lockout, e-mail, scan or attendance budget is multiplied. The per-user API budget is counted per
    process for the routed reads: up to 2 × `RATE_LIMIT_API_PER_MINUTE` for the two list paths, and 4 ×
    in all. Writes are unchanged. The passages listed under round 1 should say so. *Done: the R-1
    closure note and `docs/security.md` §9.1 give these figures.*
  - *Backend*: the regression test that the routed endpoints consult only `api_per_user` (round 1's
    hand-over) is still missing from the backend suite. With replicas, a new budget on a list path
    would be counted once per replica. *Done: RT-01 in phase-9-backend.md
    (`backend/tests/integration/test_routed_reads.py`), tied to the map by D9-36.*
  - *Backend and frontend (contract change)*: the finding's option 2 (D9-35, "Not done here"). It
    lowers the cost of each list for every layout, and it would let one list replica hold the budget
    again.
  - *Docs*:
    - `docs/production-readiness.md`: §3.4 and L-1 (capacity per instance; "about 100 open reception
      pages"), the alert table (add `GET /api/v1/reception/today` `duration_ms` p95 > 300 ms on the
      list replicas) and the performance summary (stress B).
    - The capacity line of the root `README.md`, and `docs/architecture.md`'s process model.
    - All of these should describe the two list replicas, and say that the 300 ms budget of §3.1
      covers the list polls and the desk's reload (`deploy/README.md` §4).
- **Readiness round 1, development cluster**: `scripts/db.ps1` keeps PostgreSQL's stock planner
  settings (`random_page_cost` 4). Plans can therefore differ from production, for example in
  `tests/performance/test_volume.py`'s "no `Seq Scan on visits`" assertion for a common surname. Set
  the compose planner values on the development cluster, or `SET LOCAL` them in that test.
- **Security review of the layout (D9-36)**:
  - *Security owner*: accept the per-process bound on refusal rows together with the API budget. With
    four API processes, one user can cause up to 44 ACCESS_DENIED rows a minute (11 with one process)
    and 8 RATE_LIMITED rows (2). Then reword these passages (*Done: all three below are reworded. The
    sign-off is open, a go-live item: `docs/production-readiness.md` §15 H.*):
    - `docs/security.md` §9.1, the bullet on the read processes. The backend tests now exist
      (`backend/tests/integration/test_routed_reads.py`, tied to the map by
      `deploy/verify/test_api_instances.py`). The refusal-row budget itself is per process, not only
      the summaries.
    - `docs/security.md` §11.3: the map matches the path as the client sent it, not the normalised
      path. Only the canonical spelling of a routed GET leaves the main process.
    - `docs/security-audit.md` SEC-15 and R-10: the 10-row budget applies per API process.
  - *Deployment documentation* (*Done: `deploy/README.md` §4 now says both, below its service table
    and under its rate limits.*): `deploy/README.md` §4 needs the same correction of the sentence on
    coalesced summaries. It should also say that any other spelling of a routed path (percent-encoded,
    dot segments, doubled or trailing slashes) is served by `backend`.
