# Deploying Mawdoo3 Visitors

Operator runbook for the single-host Docker Compose deployment of Mawdoo3 Visitors («زوار موضوع»). Why
it is built this way, and what was verified, is in `docs/decisions/phase-9-deploy.md`; the e-mail
providers and the product's names are in the root `README.md` §10 and §5.4.

```
 clients ──443/80──▶ frontend (nginx, uid 101)        network "app" 172.30.47.0/24
                      │  TLS, security headers, SPA, /api proxy (X-Forwarded-For overwritten);
                      │  API requests shared out by method and path (§4)
                      ▼
       ┌──────────────┼───────────────────────┐
       ▼              ▼                       ▼
     backend        backend-reception ×2    backend-reports      (python -m app.serve, uid 10001,
     sign-ins,      GET reception lists     GET reports, audit,   one worker each)
     all writes,    (least busy replica)    admin dashboard,
     the rest                               visit history
       │  ── e-mail ──▶ Resend (HTTPS) or an SMTP server (TLS)
       │              │                       │                   network "db" (internal, no egress)
       └──────────────┼───────────────────────┘
                     migrate (one-shot: alembic upgrade head, schema owner)
                      ▼
                     postgres 18 (volume pgdata)
```

| Service | Image | Published | Runs as | Notes |
|---|---|---|---|---|
| `postgres` | `postgres:18.6-trixie` (digest-pinned) | nothing | postgres (999) | roles and database created on first start by `deploy/postgres/initdb/10-vms-roles.sh`; client authentication in `deploy/postgres/pg_hba.conf` |
| `migrate` | `vms-backend:local` | nothing | 10001 | `python -m alembic upgrade head` with `MIGRATION_DATABASE_URL`; must exit 0 before the API starts |
| `backend` | `vms-backend:local` | nothing | 10001 | the main API instance: every sign-in, every write (scans and check-ins included) and every request not listed below; one worker; read-only root filesystem; refuses to start with an unsafe production configuration |
| `backend-reception` | `vms-backend:local` | nothing | 10001 | the same API in two replicas (two processes), sent only `GET /api/v1/reception/today` and `/inside` by nginx, each request to the replica with the fewest requests in progress (§4) |
| `backend-reports` | `vms-backend:local` | nothing | 10001 | the same API, sent only `GET /api/v1/reports/summary`, `/audit-logs`, `/dashboard/admin` and `/visits` by nginx (§4) |
| `frontend` | `vms-frontend:local` | 80, 443 | nginx (101) | read-only root filesystem; the only service reachable from outside |

Requirements: Docker Engine 24+ with Compose v2.24+ (BuildKit named build contexts, `env_file` with
`required`), a DNS name for the application, and a TLS certificate for it.

## 1. First start

1. **Secrets** (never commit them; `deploy/env/*.env` and `deploy/tls/` are git-ignored):

   ```sh
   for f in postgres backend migrate frontend; do cp deploy/env/$f.env.example deploy/env/$f.env; done
   chmod 600 deploy/env/*.env
   openssl rand -base64 32        # POSTGRES_PASSWORD, VMS_OWNER_PASSWORD, VMS_APP_PASSWORD (one each)
   python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # SECRET_KEY
   ```

   - `postgres.env`: the three passwords.
   - `backend.env`: `DATABASE_URL` with `VMS_APP_PASSWORD`, `SECRET_KEY`, the public origin in
     `APP_BASE_URL`, `QR_BASE_URL` and `ALLOWED_ORIGINS`, and the e-mail: `RESEND_API_KEY`, or
     `EMAIL_PROVIDER=smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME` and
     `SMTP_PASSWORD`; `EMAIL_FROM` with the display name "Mawdoo3 Visitors". The product and brand
     names (`PRODUCT_NAME_*`, `BRAND_NAME_*`) keep their defaults unless the deployment carries another
     organisation's name.
   - `migrate.env`: `MIGRATION_DATABASE_URL` with `VMS_OWNER_PASSWORD`.
   - `frontend.env`: `VMS_SERVER_NAME`, the public host name(s).

   Passwords inside URLs must be percent-encoded
   (`python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" '<pw>'`).
   Avoid `$` in values: Compose interpolates it in env files.

2. **TLS certificate**: the full chain as `deploy/tls/tls.crt` and the key as `deploy/tls/tls.key`.
   nginx runs as uid/gid 101, so the key must be readable by group 101:

   ```sh
   mkdir -p deploy/tls && chmod 750 deploy/tls && sudo chgrp 101 deploy/tls
   sudo chgrp 101 deploy/tls/tls.key && chmod 640 deploy/tls/tls.key && chmod 644 deploy/tls/tls.crt
   ```

3. **Build and start**:

   ```sh
   docker compose build
   docker compose up -d
   docker compose ps -a       # postgres, backend, backend-reception-1 and -2, backend-reports, frontend
                              # healthy; migrate "exited (0)" (-a: stopped containers too)
   docker compose logs migrate backend backend-reception backend-reports frontend
   ```

   A refused configuration stops the API instances with a message naming the setting (never its
   value); the frontend stops with `25-vms-check-config.sh: ERROR: ...` when `VMS_SERVER_NAME` or the
   certificate is missing, or an API instance address (`VMS_API_*_UPSTREAM`, §3) is malformed.

4. **First administrator** (prompts for the password; or `--password-stdin`):

   ```sh
   docker compose exec backend python -m app.cli create-admin \
     --email admin@example.com --full-name "Jane Admin" \
     --company-slug acme --company-name "Acme Bank" --timezone Asia/Amman
   ```

5. **Verify the deployment** from any machine with Python 3.12+ (standard library only):

   ```sh
   python3 deploy/verify/smoke_test.py --base-url https://vms.example.com --http-url http://vms.example.com
   # optional: client address / request ID as the API records them (a SYSTEM_ADMIN account)
   VMS_SMOKE_PASSWORD='...' python3 deploy/verify/smoke_test.py --base-url https://vms.example.com \
     --admin-email admin@example.com --expect-client-ip <your public address>
   ```

   It checks the security headers, caching, SPA fallback, wasm type, body limit, unknown-host
   rejection, HTTP→HTTPS, the proxy headers, and that each of the three API services answers the
   paths nginx sends it (about 80 checks). For the two list replicas that proves only that one of
   them answers, because nginx passes a failed list request on to the other: `docker compose ps`
   shows each replica's health. Run it after every deployment.

6. **Check the e-mail** (after a change of the e-mail settings, also run `docker compose up -d`, so the
   API containers use them):

   ```sh
   docker compose run --rm --no-deps backend python -m app.cli send-test-email --to you@example.com
   ```

   It prints any configuration warning (for example a `QR_BASE_URL` that phones cannot reach, or a port
   that does not match `SMTP_SECURITY`), then where the message went or the classified error, never a
   credential. Open the message: the Mawdoo3 logo heads it and the sample QR code shows inside it.
   `--language en` puts English first. It needs no database and writes no audit row.

7. **Company languages.** A company created by `create-admin` starts with Arabic as its default language
   and no Arabic name. Its administrator sets the Arabic name and the default language in *Settings*;
   each user can switch the language for themselves (the «ع» / **EN** button).

## 2. Operations

| Task | Command | When |
|---|---|---|
| Upgrade | the procedure below ("Upgrading a running deployment"): backup, build, `migrate` while the old API serves, then the API and the frontend | each release |
| E-mail check | `docker compose run --rm --no-deps backend python -m app.cli send-test-email --to <address>` | after changing the e-mail settings |
| Backup | `scripts/backup.sh --compose --out-dir /srv/vms-backups --retention-days 14` | cron, see below |
| Restore drill | `scripts/restore.sh --compose --file /srv/vms-backups/vms-<stamp>.dump --target-db vms_restore_test`, then drop it | quarterly |
| Prune old sessions | `docker compose run --rm migrate python -m app.cli prune-sessions` | weekly |
| Mark no-shows (optional; also done on every visit read) | `docker compose exec backend python -m app.cli mark-no-shows` | nightly |
| Certificate renewal | replace `deploy/tls/tls.crt` / `tls.key`, then `docker compose exec frontend nginx -s reload` | before expiry |
| Header drift check (CI) | `node deploy/verify/check_nginx_headers.mjs` | every change of either header list |
| Release hygiene (CI) | `python3 deploy/verify/check_release_tree.py`: fails on development artefacts (e-mail outbox files, raw pass/reset links), cookies, private keys, `.env` files or database archives among the files `git add -A` would commit. Full checklist: `docs/decisions/phase-9-deploy.md` | every push; before every release tag |

**Upgrading a running deployment** (each release; the auditor's runbook of Phase 14, B14-34). Every
`docker compose` command reads the env files, which are mode 600 and owned by the account that wrote
them (root on a server set up with `sudo`): run them as that account, with `sudo` below.

1. **The new tree.** From a checkout, write the release as LF text whatever the checkout's settings (a
   Windows checkout with `core.autocrlf=true` turns the shell scripts' line ends into CRLF, which the
   containers cannot run):

   ```sh
   git -c core.autocrlf=input archive --format=tar --output=vms-<tag>.tar <tag>
   ```

   Unpack it next to the running tree and copy it over with `rsync --delete`, protecting what the
   release does not carry: the secrets, the certificate, local tooling, any root `.env` and Compose
   override files. Run it with `--dry-run` first and read the list of deletions:

   ```sh
   rsync -a --delete --dry-run \
     --filter='protect /deploy/env/*.env' --filter='protect /deploy/tls/***' \
     --filter='protect /.local/***' --filter='protect /.env' --filter='protect /*override*.y*ml' \
     vms-<tag>/ /opt/vms/
   ```

   Then the same command without `--dry-run`.

   Never `chown -R` or `chmod -R` over the tree: `deploy/tls/tls.key` must stay mode 640, group 101
   (nginx), and `deploy/tls/` mode 750 (§1, step 2).
2. **A backup**, and the images to go back to:

   ```sh
   sudo scripts/backup.sh --compose --out-dir /srv/vms-backups
   sudo docker tag vms-backend:local vms-backend:previous
   sudo docker tag vms-frontend:local vms-frontend:previous
   ```

3. **Build** while the old containers keep serving. On a small VM (2 GB of memory or less) the
   frontend's build can run out of memory; add a temporary swap file for it and remove it afterwards:

   ```sh
   sudo fallocate -l 2G /swapfile.build && sudo chmod 600 /swapfile.build \
     && sudo mkswap /swapfile.build && sudo swapon /swapfile.build
   sudo docker compose build
   sudo swapoff /swapfile.build && sudo rm /swapfile.build
   ```

4. **Migrate first, while the old API serves.** A plain `docker compose up -d` would stop every API
   container before it runs `migrate` (the API depends on it), so the site would be down for the whole
   migration. Run it on its own instead (Phase 14's revisions, `0016` and `0017`, leave the running
   API working on the migrated schema; read a release's upgrade note below before relying on that for
   another):

   ```sh
   sudo docker compose run --rm migrate
   ```

   It fails, and changes nothing, if a table's lock is not granted within 5 seconds (revisions `0016`
   and `0017`, B14-23); run it again once the long transaction that held it (a report, a backup) has
   ended.
5. **The API, then the frontend**, without running `migrate` again, then a plain `up -d`, which finds
   everything up to date:

   ```sh
   sudo docker compose up -d --no-deps backend backend-reception backend-reports
   sudo docker compose up -d --no-deps frontend
   sudo docker compose up -d
   sudo docker compose ps -a
   ```

6. **Verify**: the smoke test (§1, step 5) and, after a change of the e-mail settings, `send-test-email`.

**Rolling back** to the previous release keeps the database as it is (revisions `0016` and `0017` only
add columns with a default or none, and widen CHECKs, which the previous release's API reads and writes
as before). The previous images cannot run `migrate`: their Alembic does not know the database's
revision and fails, which a plain `up -d` would wait for. Put the previous images back and start the
services without it:

```sh
sudo docker tag vms-backend:previous vms-backend:local
sudo docker tag vms-frontend:previous vms-frontend:local
sudo docker compose up -d --no-build --no-deps backend backend-reception backend-reports frontend
```

Do not downgrade the schema to go back: the downgrades refuse while the log holds what the older schema
cannot (B14-11), and restoring the backup of step 2 loses everything written since.

**Upgrading from a release before Phase 10.** `migrate` applies revision `0011`: three language
columns, without rewriting a table. Every existing company becomes Arabic by default and has no Arabic
name; set both in each company's *Settings* where its users expect English or an Arabic name. Set
`EMAIL_FROM` to the display name "Mawdoo3 Visitors". It then applies revision `0012`: the Arabic
versions of a department's name, the company's address and a visit's department name, all empty, with
one partial unique index on `departments` (small). Give each department its Arabic name in
*Departments* and the company its Arabic address in *Settings* where the Arabic interface should show
them.

**Upgrading to Phase 12 (a company's own identity).** `migrate` applies revision `0015`: one nullable
column on `companies` and one new table, without rewriting anything. Rebuild **both** images: the nginx
configuration changed with the API (a location of its own for the upload of a company's logo, below), and
an old nginx in front of the new API answers 413 to every logo above 64 KiB. After the upgrade every
company is shown by its name and the default colours until the platform owner gives it a logo, an icon and
a colour (`/platform/companies`, the company's page; the root README §1.5 shows the API calls). Each
company then has its own sign-in link, `https://<host>/c/<slug>`; give it to the company's people. New
e-mails name the company as their sender (the address stays `EMAIL_FROM`'s) and no longer name the
product; pass and reset links carry `?c=<slug>`, and links sent before the upgrade keep working. Three new
settings have safe defaults and need no line in `backend.env` (`RATE_LIMIT_PUBLIC_BRAND_PER_IP`,
`RATE_LIMIT_PUBLIC_BRAND_PER_PREFIX`, `RATE_LIMIT_BRAND_CHANGES_PER_HOUR`; the repository's `.env.example`
describes them). A downgrade to `0014` refuses while any company has a colour or an image.

**Upgrading to Phase 14 (calendar invitations).** `migrate` applies revision `0016`: the e-mail kinds of
the host's three e-mails and of the visitor's calendar invitation (the CHECKs on `email_messages` and
`email_template_overrides`) and `visits.calendar_sequence`, an integer with a constant default, so no
table is rewritten. Then revision `0017`: `email_messages.calendar_method`, a nullable column (the event
each e-mail carried; the rows before it are marked by their kind, B14-26). The CHECKs on `email_messages`
and `visits` are added `NOT VALID` and then validated, which reads each of the two tables once. Each
revision waits at most **5 seconds** for a table's lock (`lock_timeout`): while a long transaction holds
one (a long report, a backup being taken), it fails and leaves the database exactly as it was; run
`migrate` again once that transaction has ended. Three new settings: `HOST_VISIT_NOTICE_DAILY_LIMIT` and
`CALENDAR_EMAIL_COMPANY_DAILY_LIMIT` have safe defaults and need no line in `backend.env`;
**`CALENDAR_INVITATIONS_ENABLED=false`** must be in it (`deploy/env/backend.env.example` has it), and is
a **release gate**: keep it false until `EMAIL_FROM` is a mailbox of the system's own that hosts nobody
and its domain publishes SPF, signs with its own DKIM key and has DMARC
(`docs/production-readiness.md` §15 E). While it is false no calendar gets a new entry; the e-mails are
sent as before. A downgrade to `0016` drops the new column; one to `0015` refuses while an e-mail of the
new kinds is in the log, a company has a text of a host's e-mail, or a scheduled visit's event has a
version above 0.

**A deployment of Phase 12 from before its security review (B12-18 to B12-20).** Rebuild **both** images
once more; there is no migration and no new setting. The nginx image carries the change that matters
most: until it is replaced, anyone can keep the platform owner from uploading and removing logos by
holding eight slow connections on the upload's path (§4, "Uploads in progress"). The API image carries
the time limit of an upload's body, which the new nginx relies on, so do not run the new nginx in front
of the old API for longer than the upgrade takes. Run the smoke test afterwards: on the old nginx
configuration it fails with "an upload nobody is signed in for is answered before its body arrives".

Example crontab (UTC):

```
15 1,7,13,19 * * *  cd /opt/vms && scripts/backup.sh --compose --out-dir /srv/vms-backups --retention-days 14 >> /var/log/vms-backup.log 2>&1
30 3 * * 0          cd /opt/vms && docker compose run --rm migrate python -m app.cli prune-sessions >> /var/log/vms-maintenance.log 2>&1
```

Copy every archive (with its `.sha256`) off the host, encrypted; the archives hold personal data,
password hashes and the audit trail. Recovery objectives and a WAL-archiving setup for tighter RPO:
`docs/decisions/phase-9-deploy.md`.

**Restoring for real** (after an incident): restore into a new database with
`scripts/restore.sh --compose --file ... --target-db vms_restored` (it verifies schema version,
triggers and the runtime role's privileges), then
`docker compose stop frontend backend backend-reception backend-reports` (both list replicas), rename the
databases (`ALTER DATABASE vms RENAME TO vms_broken; ALTER DATABASE vms_restored RENAME TO vms;` as
`postgres` over `docker compose exec postgres psql -U postgres`), and `docker compose up -d`. The API
refuses to start if the restored grants are wrong.

**Rotating secrets**: `SECRET_KEY` (ends every browser's device trust); database passwords
(`ALTER ROLE vms_app PASSWORD '...'` and `ALTER ROLE vms_app RESET ALL` as `postgres`, then update
`DATABASE_URL`; the same for `vms_owner` and `MIGRATION_DATABASE_URL`); `RESEND_API_KEY`;
`SMTP_PASSWORD` (revoke the old App Password or password at the mail provider, set the new one, then
check with `send-test-email`). After
editing `backend.env`, run `docker compose up -d`: it recreates the four API containers with the new
values (`docker compose restart` would keep the old environment).

**Logs**: every service logs to stdout (json-file driver, 5 × 10 MB per container). nginx writes one
JSON object per request (`uri` and `path` never contain the query string; `api_pool` names the API
instance that answered: `vms_api`, `vms_api_reception` (either list replica) or `vms_api_reports`);
each API process writes JSON lines (`docker compose logs backend-reception` prefixes each line with
the replica's container name).
nginx's own error lines can quote a failed request's full request line: treat them as sensitive.
Ship both to the SIEM and alert as listed in `docs/production-readiness.md` §5.3 (security audit
recommendation 6, plus the latency signals of §4 below).

## 3. Variants

- **TLS terminated by a load balancer in front of nginx**: keep nginx on HTTPS if possible. If the
  load balancer must talk HTTP, $remote_addr becomes the balancer's address: add
  `set_real_ip_from <balancer CIDR>; real_ip_header X-Forwarded-For; real_ip_recursive on;` to the
  server block, so `X-Forwarded-For $remote_addr` again carries the real client, and keep HSTS. The
  count of uploads per client address (§4, "Uploads in progress") uses the same address: without those
  lines every upload shares the balancer's four places.
- **Database on another host** (managed PostgreSQL): remove the `postgres` service, provision the
  roles with the same SQL as `deploy/postgres/initdb/10-vms-roles.sh`, set `DB_REQUIRE_TLS=true` and
  `?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.crt` on both URLs (mount the CA file).
- **TLS inside the compose network**: see the comments in `docker-compose.yml` (`ssl=on`) and
  `deploy/postgres/pg_hba.conf` (`hostssl`).
- **API instances elsewhere** (another orchestrator, other names): nginx finds the API services
  through `VMS_API_UPSTREAM`, `VMS_API_RECEPTION_UPSTREAM` and `VMS_API_REPORTS_UPSTREAM` (`host:port`;
  defaults `backend:8000`, `backend-reception:8000`, `backend-reports:8000`), set in `frontend.env`.
  nginx re-resolves each name every 10 s and uses every address it returns. So the reception name must
  resolve to one address per list process (Docker's DNS does this for replicas; elsewhere, a headless
  service or a DNS round-robin name), and the main name to exactly one process. Each must be a
  separate process of the same image and configuration; the routing and its effect on the rate limits
  are in §4.
- **Address collision**: the `app` network uses 172.30.47.0/24 with nginx fixed at .10. To change it,
  edit the subnet and `ipv4_address` in `docker-compose.yml` and `TRUSTED_PROXIES` in `backend.env`.
- **IPv6 clients**: with Docker's default userland proxy, IPv6 clients reach nginx from the bridge
  gateway address, so they would share one per-IP rate-limit bucket. Enable IPv6 on the `app` network
  (or disable the userland proxy) before serving IPv6 clients.
- Clients must use the configured host name: requests for an IP address or another name get no
  answer, and TLS handshakes without a matching SNI are refused.

## 4. Capacity and tuning

**Four API processes, one worker each.** Every API process runs one uvicorn worker, because the rate
limiter, the account lockouts, the daily e-mail budgets and the coalescing of security events live in
its memory (contract §3). One process runs all its requests in one Python interpreter. With a single
process, the desk's scans and check-ins (15–25 ms of work each) therefore queued behind the reception
list that every open reception page polls every 15 s, and behind the analysts' reports, audit pages and
history searches. Compose runs three API services of the same image and configuration, four processes
in all, and nginx shares the API requests out by method and path (`$vms_api_pool` in
`deploy/nginx/templates/vms.conf.template`):

| Service | nginx sends it | Processes and limits (compose) |
|---|---|---|
| `backend` | every sign-in, every write (scans and check-ins included) and every request not listed below | exactly one process; 2 CPUs, 1 GiB; `PASSWORD_HASH_CONCURRENCY` 4, `DB_POOL_SIZE` 10 |
| `backend-reception` | `GET /api/v1/reception/today` (polled by every open reception page, reloaded by the desk after each check-in) and `GET /api/v1/reception/inside`, each request to the replica with the fewest requests in progress (`least_conn`) | two replicas, each 1 CPU, 512 MiB; 1 and 5 |
| `backend-reports` | `GET /api/v1/reports/summary`, `/api/v1/audit-logs`, `/api/v1/dashboard/admin` and `/api/v1/visits` (the visit list and history search) | one process; 1 CPU, 512 MiB; 1 and 5 |

Every other method on those paths goes to `backend`, and so does every other spelling of them
(percent-encoded, `.` or `..` segments, doubled or trailing slashes): nginx matches the path exactly as
the client sent it, which is the path it forwards and the API dispatches on (D9-36). A letter-case
variant such as `/api/v1/Reception/today` reaches a list replica, because nginx compares the keys
without regard to case. It matches no API route there and gets a 404 before authentication. nginx
resolves each service name every 10 s and uses every address it gets, one per replica. A list request
that finds a replica gone is passed on to the other. The access log's `api_pool` names the group that
answered.

**A company's identity (Phase 12).** The platform owner's brand and e-mail-text endpoints
(`/api/v1/platform/…`) and the three public identity endpoints (`/api/v1/public/companies/{slug}/…`: a
company's name and brand, its images, its web app manifest, read by its sign-in and pass pages without a
session) all go to `backend`: none is in the routing map, because their budgets (brand changes per
platform account, public requests per client address and IPv6 /48) are counted in the main process.
`deploy/verify/test_api_instances.py` lists each of these routes and fails when one is added without a
decision.

- **Caching.** The public endpoints are the only API answers that are not `no-store`: an image under the
  address of its current version may be kept for a year (a new image has a new address), under any other
  address for a minute; the identity and the manifest are `no-cache`. **The API alone decides this**: nginx
  adds no caching header to API answers and stores nothing. Do not put a caching proxy or CDN rule in
  front of `/api/` that overrides those headers; one that honours them is fine.
- **The one larger body.** nginx refuses request bodies above 64 KiB before the API sees them
  (`client_max_body_size 64k`, the API's `MAX_REQUEST_BODY_BYTES`). The upload of a company's logo or icon
  (`PUT /api/v1/platform/companies/{id}/brand/assets/{kind}`, a PNG of at most 512 KiB) has a location of
  its own nested in `/api/`, with `client_max_body_size 512k`. nginx matches the location on the
  normalised path and cannot tell the method, so the API remains the judge: it gives the larger limit to
  exactly that method and route. If you change `MAX_REQUEST_BODY_BYTES`, change the two
  `client_max_body_size 64k` of the API locations with it; the upload's 512k is the API's fixed limit for
  images and does not follow that setting.
- **Uploads in progress.** The same location lets 8 uploads be in progress on the site and 4 from one
  client address (`limit_conn vms_brand_upload 8`, `limit_conn vms_brand_upload_client 4`); one more gets
  `503 SERVICE_BUSY` with `Retry-After: 5`. nginx takes a place before anyone is asked who they are, so
  four things in the configuration make sure a place cannot be kept without being signed in. **Keep them
  together** (`docs/decisions/phase-12-backend.md` B12-18; `deploy/verify/test_api_instances.py` and the
  smoke test hold them):
  - `proxy_request_buffering off`: this one request goes to the API as soon as its header is read, and
    the API answers 401 without reading the body. Every other location says `on`: nginx reads those
    bodies first, so a slow client never ties up an API worker. With `on` here, eight connections that
    send a byte every few seconds hold every place for as long as they like.
  - `lingering_close off`: the connection is closed with the answer. With nginx's default, a request
    whose body was not read to the end keeps its place for up to 30 seconds more.
  - The two `map` blocks above the servers make the counts' keys empty for every method but `PUT`, so
    removing an image (`DELETE` on the same path) is never refused because uploads are in progress.
  - No `client_body_buffer_size` of its own: nginx holds at most 64 KiB of an upload on its way, and
    nothing of it under `/tmp`.

  What follows from it:
  - The API, not nginx, bounds an upload that arrives slowly: the whole body within 30 seconds, else
    `408` (`PNG_UPLOAD_SECONDS` in `backend/app/api/deps.py`; `client_body_timeout 15s` is only the
    longest pause between two reads). The API also checks at most two images at a time (12 MiB each for a
    moment at the very most) and answers `503 SERVICE_BUSY` to an upload that waited two seconds for it.
  - The count per address needs the client's address. Behind a load balancer that speaks HTTP to nginx,
    every upload comes from the balancer's address and shares its four places until `set_real_ip_from`
    and `real_ip_header` are set (§3).
  - Over HTTP/1.1, a client that is refused before its body was read (nobody signed in, a wrong
    `Content-Type`) may see the connection reset instead of the 401 or 415, because nginx closes while
    the client is still sending. Browsers speak HTTP/2 to nginx, where only that stream ends. A load
    balancer in front that speaks HTTP/1.1 to nginx may turn such a reset into a 502 of its own: the
    page then says that the service is unavailable, and the next request shows that nobody is signed in.
  - In the access log, an upload nobody was signed in for is a `PUT` on that path with status 401 and
    a `request_time` of milliseconds. Many of them from one `remote_addr`, or 503s on that path, are
    someone trying.
- **Database size.** Images are stored in PostgreSQL with their company: at most three per company and
  512 KiB each, so 1.5 MiB a company at the very most (the upload page prepares far smaller files). They
  are part of every backup.
- **Check after deploying**: `deploy/verify/smoke_test.py` begins an upload of 524,288 bytes without
  sending any of its body and expects the API's 401 at once (not nginx's 413, and not silence: the request
  reached the API before its body); begins seven more and leaves all eight connections open (the 401
  every time, never 503: none of them kept a place); sends one byte more than the limit (413); and asks
  the public endpoints for a company that does not exist (the API's 404, `no-store`).

**Rate limits with four processes.** The routed requests are reads, and they consult one budget only:
the per-user API budget (`RATE_LIMIT_API_PER_MINUTE`, 600 per minute by default). Every other budget
(sign-in failures and lockouts, password recovery, e-mail, scans, attendance) is counted only by
requests that reach `backend`, so none of them is multiplied. Each process counts the per-user API
budget for the requests nginx sends it:

- one user can make up to 600 requests a minute on `backend`, 600 on `backend-reports` and 600 on
  each list replica (1,200 list requests);
- that is 2,400 in all, and at most 600 of them are writes.

Each process also keeps its own budget of written refusal rows (security audit SEC-15) and its own
coalescing of `RATE_LIMITED` events. One user can therefore cause up to 44 `ACCESS_DENIED` rows a
minute and 8 `RATE_LIMITED` rows for the per-user API budget, against 11 and 2 with one process. The
summary rows still count every refusal. Restarting one process resets only its counters. The
engineering security review accepted these per-process budgets with conditions (security audit R-1,
Phase 9 closure note). The deploying organisation's security owner signs them off before production
traffic (`docs/production-readiness.md` §15 H).

Never run a second copy of `backend` or more workers: no `replicas` or `scale` in the compose file, no
`docker compose up --scale backend=N`, and no name for `VMS_API_UPSTREAM` that resolves to more than
one address. That would double every budget. `deploy/verify/test_api_instances.py` fails on the compose
file, but it cannot see a command-line `--scale`. Keep the read services on the same `backend.env`, and
override nothing in their `environment` except `PASSWORD_HASH_CONCURRENCY`, `DB_POOL_SIZE` and, if
you choose lower budgets for the reads, `RATE_LIMIT_API_PER_MINUTE` (D9-36): the processes must agree
on sessions, cookies and trusted proxies. The same test checks this (D9-37): it fails when a read
service's image, command or env file differs from `backend`'s, or when its `environment` sets a key
outside `READ_SERVICE_OVERRIDES` (`PASSWORD_HASH_CONCURRENCY` and `DB_POOL_SIZE`). If you adopt lower
read budgets, add `RATE_LIMIT_API_PER_MINUTE` to that list in the same change. Sharing all traffic over
several processes needs a shared rate limiter (Redis, the scale path of contract §3), which does not
exist yet.

**The 300 ms budget** covers the scans and check-ins (contract §11) and every other reception
endpoint, the list polls and the desk's list reload included (`docs/production-readiness.md` §3.1).

**Measured** on 2026-10-06 on the reference machine, a 6-core/12-thread laptop shared with other test
runs, with 60,000 visits and 20,000 visitors. The scenario is the readiness review's "stress B":

- 6 clients poll the reception list every second, about 90 open reception pages;
- one desk scans and checks in visitors back to back (120 per run) and reloads the list after each
  check-in;
- 3 administrators run history searches, audit pages and the dashboard without pause.

Every request went through nginx 1.30.5 with this repository's configuration, which found the list
replicas through DNS as in compose. Each run used a fresh copy of the database and the same warm-up,
and the layouts were interleaved. The table gives p95 in ms (range over the runs):

| Layout | All four p95 < 300 ms | Scan | Check-in | Desk's list reload | List poll | Host CPU (median) |
|---|---|---|---|---|---|---|
| One list process (the previous layout) | 6 of 8 runs | 32–68 | 42–85 | 149–495 | 160–528 | 36–54 % |
| Two list replicas, `least_conn` (this layout) | 8 of 8 | 32–53 | 40–70 | 118–176 | 140–206 | 36–54 % |
| Two list replicas, round-robin | 8 of 8 | 33–50 | 44–71 | 110–177 | 127–199 | 37–51 % |
| One list process, 5 CPU-spinning processes added | 4 of 4 | 35–40 | 43–48 | 168–199 | 179–227 | 78–79 % |
| Two list replicas, `least_conn`, 5 spinning processes added | 4 of 4 | 33–40 | 43–50 | 128–158 | 146–186 | 79–80 % |

- The one-process layout missed in the two runs with the most load from other test runs (52–54 %
  host CPU): poll p95 528 and 329 ms. The list process's own `duration_ms` p95 was 473 and 263 ms:
  the requests queue inside that process.
- The re-audit measured that layout in 12 runs through nginx, at host loads up to 94 % from other
  test runs. The poll p95 was 293–697 ms, under 300 ms in 1 of the 12. In its runs with two list
  processes (round-robin), all four were under 300 ms in 4 of 4 (poll p95 196–249 ms).
- Two replicas held all four in every run here, with a worst poll p95 of 206 ms.
- Round-robin did as well as `least_conn`, because both replicas were equally fast. `least_conn` is
  kept because it sends fewer requests to a replica that is still busy, for example with a list at
  the 200-row caps (about 100 ms).
- The spinning processes slowed the lists less than the other test runs did. Load from other test
  runs cannot be reproduced, so the table shows both.

How the API layout got here, with the measurements of each step, is recorded in
`docs/decisions/phase-9-deploy.md` (D9-33 to D9-35).

**Capacity.** The re-audit measured one list process at 24–26 normal-day lists a second (4 clients
in a closed loop). A 370 KB list costs about 38 ms of CPU, and a list at the 200-row caps about 101 ms.
The poll rate matters less to the list's p95 than bursts and CPU contention, because one process
builds one list at a time.

At 12 polls a second (about 180 open reception pages), with the desk and the analysts as in stress
B, the poll p95 was:

| List processes | Poll p95 (ms) |
|---|---|
| one | 212–249 |
| two | 169–182 |
| three | 149–173 |

Those were 3 runs per layout on a quiet host (39–42 % CPU), and all four p95 stayed under 300 ms in
every run.

- `backend-reception`: two replicas are measured here up to about 180 open reception pages on a quiet
  host, and up to about 90 at up to 80 % host CPU. Beyond that, or on slower CPUs, add a replica and
  re-measure on your release and hardware.
- `backend-reports`: a 366-day report or a long audit search slows only the other analysts.
- `backend`: scans, check-ins, sign-ins, visit creation and the employees' pages.

**What to watch.** Watch `duration_ms` in the API's access log:

- `POST /api/v1/reception/scan` and `…/check-in` on `backend` (nginx: `upstream_response_time` with
  `api_pool` `vms_api`);
- `GET /api/v1/reception/today` on each list replica (`docker compose logs backend-reception`; nginx:
  `api_pool` `vms_api_reception`).

When the list's p95 nears 300 ms at the busiest hour, raise `replicas` of `backend-reception` in
`docker-compose.yml` and run `docker compose up -d`. nginx sends the new replica requests once it has
looked up the name again, which it does every 10 s (a replica added to DNS in the verification served
after 13 s). Each replica adds:

- 1 CPU and 512 MiB of limits;
- 10 database connections (keep the PostgreSQL memory budget below within its limit; the compose test
  checks it);
- another 600 list requests a minute per user.

A cheaper list (a backend and frontend change, handed over in D9-35) would lower the cost for every
layout.

**PostgreSQL settings** (`command` of the `postgres` service). They are sized for its 2 GiB memory
limit and SSD storage. PostgreSQL's stock values assume a small machine with spinning disks.

| Setting | Value | Rule | Why |
|---|---|---|---|
| `shared_buffers` | 512MB | about 25 % of the memory limit | stock 128MB |
| `effective_cache_size` | 1536MB | about 75 % of the memory limit | the planner's estimate of cached data; the stock 4GB exceeds the container |
| `random_page_cost` | 1.1 | 1.1 on SSD/NVMe; 4 only on spinning disks | at 4 the history search for a common surname scanned all of `visits` (19–42 ms per statement on 60,000 visits); at 1.1 it uses the index (6–12 ms) |
| `work_mem` | 16MB | per sort or hash step of a query; the API opens at most 50 connections (`DB_POOL_SIZE` 10 + 10 overflow on `backend`, 5 + 5 on each list replica and on `backend-reports`) | at 4MB a year of report totals (`count(DISTINCT …)`) sorted on disk |

The memory budget is `shared_buffers` + API connections × `work_mem` + 3 × 64 MB for autovacuum:
512 + 50 × 16 + 192 = 1,504 MB of the 2 GiB limit. `deploy/verify/test_api_instances.py` fails when
the replicas and pool sizes in `docker-compose.yml` no longer fit it.

When you change the memory limit, scale `shared_buffers` and `effective_cache_size` with it, then
apply the change with `docker compose up -d postgres`. It recreates the container, and the API
reconnects by itself. A managed PostgreSQL (§3) needs the same settings in its parameter group.

**Stopping and redeploying.** `docker compose stop`, or a `docker compose up -d` that recreates an
API container, sends the API process SIGTERM, and it stops accepting connections. nginx passes a list
request that finds one list replica gone on to the other, and answers `503 SERVICE_BUSY` with
`Retry-After: 5` for a service's paths while none of its processes answers. Requests in flight and
their e-mail deliveries get up to 20 s to finish (`GRACEFUL_SHUTDOWN_SECONDS` in `app.serve`). After
that the process cancels what still runs, writes the coalesced security-event counts to the audit log
and exits. Compose kills a container that is still running after 45 s (`stop_grace_period`), which
leaves 25 s for that last step (`docs/decisions/phase-9-deploy.md`, D9-32).

Requests normally finish in milliseconds, and the API bounds the waits that could hold up a stop:

- a request blocked inside PostgreSQL, for example on a row lock held by a forgotten `psql` session,
  gets `503 SERVICE_BUSY` after 10 s of waiting for the lock (`DB_LOCK_TIMEOUT_MS`), and PostgreSQL
  cancels any statement of the API after 30 s (`DB_STATEMENT_TIMEOUT_MS`);
- each e-mail has a delivery deadline of 20 s from its first attempt, retries included.

A statement still running when the 20 s are up can delay the exit until it ends, because the
request's database session is closed on the process's event loop (D9-32; `docs/production-readiness.md`
L-8). The lock and statement timeouts bound that delay, and re-audit round 1's hung-connection drills
did not reproduce it. These bounds assume the default timeouts, which `backend.env.example` does not
change: a timeout raised close to 45 s would let a blocked request outlast the grace period again.

Measured stops (`docs/production-readiness.md` §4.5; plain processes on Windows, stopped with
CTRL_BREAK, which takes uvicorn's SIGTERM path):

- nothing in flight: exit after 0.2 s;
- a request in flight: it finished (200), and the process exited 0.07–0.23 s later;
- a request waiting on a row lock held for 60 s: the lock timeout answered it 503, and the process
  exited 9.1–9.2 s after the stop, with the counts written;
- a sign-in while the database never answered: exit after 4.2 s, the sign-in got 503;
- a request on a pooled connection whose database stopped answering mid-request: cancelled at 20 s,
  exit after 25.2–25.4 s;
- e-mails retrying against a mail service that does not answer: exit after 18.0 s with one delivery,
  20.3–20.4 s with ten.

Every stop with a stuck request or delivery took 4.2–25.4 s, inside the 45 s. What a stop can still
lose:

- a request cancelled at 20 s gets a plain-text 500 from uvicorn, not the API's JSON error; nginx
  passes it through;
- an e-mail cut off at 20 s (6 of the ten above) stays PENDING. The sweep that every API process runs
  at start-up and every 60 s marks it FAILED once it has been untouched for 5 minutes (5–6 minutes
  after it was created, in the drill); an invitation then shows under Needs attention and can be
  resent;
- the coalesced counts, when the database cannot be reached at shutdown (as in the hung-connection
  stops above) or the container is killed.

None of this has run in a container yet. On staging, check that `docker compose stop` ends every API
container in under 45 s and that the counts reach the audit log (`docs/production-readiness.md`
§15, section B).
