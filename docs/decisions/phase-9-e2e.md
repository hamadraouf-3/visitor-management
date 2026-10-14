# Phase 9 — Full-stack E2E suite (Playwright)

Date: 2026-10-06 · Scope: `frontend/e2e/**`, `frontend/playwright.config.ts`, the `e2e*` scripts of `frontend/package.json` · Contract: `docs/initial-assessment.md` revision 2, §11 (E2E) and the brief's §40 acceptance scenario

The committed Playwright suite now runs the real stack: a freshly migrated and seeded `vms_e2e` database, the API (`python -m app.serve`) on its own port with the outbox e-mail provider, and the Vite dev server proxying `/api` to it. It holds the §40 acceptance scenario (steps 1–28), the negative and edge cases of §11, a real-camera spec, and quality specs (axe, horizontal scroll, dialog footers, scan timing) at the three viewports. The three mocked layout specs of earlier phases still run unchanged. No application code was changed, and no spec is marked `fixme`: every check passed against the application as it is. Each entry below: **decision**, then the reason.

## How to run (to be moved into `docs/development.md`)

**Prerequisites** (all local, no Docker):

1. PostgreSQL running: `./scripts/db.ps1 start` (port 5433; `db.ps1 init` created the roles `vms_owner`/`vms_app` and the database `vms_e2e`).
2. The backend virtual environment `backend/.venv` with `requirements-dev.txt` installed (the suite runs Alembic, the CLI and the server with it, and `segno` for the camera video).
3. In `frontend/`: `npm ci` and `npx playwright install chromium`, which installs the headless shell used by most specs and the full Chromium the camera spec needs.
4. Ports 8700 (API) and 5199 (Vite) free.

**Commands** (in `frontend/`):

| Command | What it runs |
|---|---|
| `npm run e2e` | Everything: 4 projects, 187 tests, about 5 minutes with 4 workers |
| `npm run e2e:flows` | The `flows` project: §40 acceptance and the negative scenarios (16 tests) |
| `npm run e2e:quality` | The `desktop`, `tablet` and `mobile` projects: axe and overflow, dialogs, scan timing, the camera spec (tablet), the mocked layout specs |
| `npx playwright test e2e/flows/acceptance.spec.ts` | One spec (any path or `-g "<title>"`) |
| `npx playwright test --project=tablet e2e/camera` | The real-camera spec |
| `npm run e2e:typecheck` | `tsc` over the suite (Playwright itself only strips types) |
| `npm run e2e:report` | Opens the HTML report of the last run |

Useful options: `--headed`, `--debug`, `--ui`; `E2E_WORKERS=<n>` (default 4). Environment overrides, all optional: `VMS_PG_PORT`, `VMS_PG_HOST`, `VMS_PG_OWNER_PASSWORD`, `VMS_PG_APP_PASSWORD` (as `scripts/db.ps1`), `VMS_E2E_DATABASE` (default `vms_e2e`), `VMS_E2E_PYTHON`, `VMS_E2E_PG_BIN`, `SEED_DEMO_PASSWORD`.

**What a run does.** Playwright starts Vite (`npx vite --port 5199 --strictPort --host 127.0.0.1` with `VMS_API_PROXY_TARGET=http://127.0.0.1:8700`). Then the global setup (`e2e/support/global-setup.ts`, about 16 s):

1. stops an API server left by an interrupted run (PID file), and fails clearly if port 8700 is still taken;
2. drops and recreates the `public` schema of `vms_e2e` as `vms_owner` (E9-1), runs `alembic upgrade head` and `python -m app.cli seed-e2e`;
3. starts `python -m app.serve --port 8700` with the environment of E9-2, its output in `e2e/.artifacts/run/backend.log`, and waits for `GET /api/v1/health` directly and through the Vite proxy;
4. signs in the eight seeded accounts once through the proxy and saves their storage states (E9-4);
5. creates the visits the quality specs look at (E9-6);
6. opens the lazily loaded routes once, so Vite has transformed them before the first test (E9-3).

The global teardown stops the API's whole process tree (`taskkill /T /F` on Windows: the venv `python.exe` is a launcher with the real interpreter as its child) and waits until port 8700 is free. Playwright then stops Vite.

**Artefacts** (all gitignored): `frontend/e2e/.artifacts/run/` holds `backend.log`, the per-run `outbox/` (each e-mail as `.json`, `.html`, `.txt` and inline `.png`), `state/` (storage states), `camera/` (Y4M videos) and `quality-data.json`. It is replaced at the start of the next run and kept after a run for inspection. `frontend/e2e/.artifacts/results.json` is the JSON report, with every test's annotations, including the recorded timings. `frontend/playwright-report/` is the HTML report. `frontend/test-results/` holds traces and screenshots of failures.

**Troubleshooting.**
- "Could not reset the vms_e2e database": PostgreSQL is not running.
- "Port 8700 is in use": another process holds the port. The setup only stops a server it started itself, using the PID file `e2e/.artifacts/backend.pid`.
- Vite logs `[vite] (client) [console.error] wasm streaming compile failed … falling back to ArrayBuffer instantiation`. This is the browser console of pages that close while the reception page is still downloading the zxing WebAssembly decoder: a test that ends right after opening `/reception` aborts that download. It is not a failure, and no test depends on it.

## Suite layout

| Path | Contents |
|---|---|
| `e2e/support/` | `paths.ts` (ports, folders), `env.ts` (backend environment), `processes.ts` (spawn, health wait, Windows-safe tree kill), `db.ts` (schema reset, read-only SQL checks via psql), `global-setup.ts`, `global-teardown.ts`, `accounts.ts` (seeded accounts, storage-state files), `api.ts` (JSON API helper with CSRF), `outbox.ts` (outbox reader), `qr.ts` (zxing-wasm decoding in Node), `cli.ts` (`e2e-time-travel`), `time.ts` (company wall time), `fixtures.ts` (`open` and `apiAs` fixtures, viewports), `ui.ts` (sign-in, forced password change, date-time fields, comboboxes, scanning, radios, navigation, overflow), `quality-data.ts`, `make_y4m.py` (Y4M writer) |
| `e2e/flows/acceptance.spec.ts` | §40 steps 1–28 |
| `e2e/flows/pass-outcomes.spec.ts` | expired pass and override (time travel), cancelled visit, invalid pass, pass replaced by a resend, visitor already inside, visit already completed |
| `e2e/flows/walk-in.spec.ts` | walk-in end to end on the tablet |
| `e2e/flows/invitation-failure.spec.ts` | `visitor.<tag>@fail.test` fails, the visit is kept, the corrected address gets a new pass |
| `e2e/flows/permissions.spec.ts` | signed out, employee, reception, management, administrator: navigation, guarded URLs, API refusals |
| `e2e/flows/cross-company.spec.ts` | Other Corp against Demo Company: UI, path IDs (404), body IDs (422), pass (PASS_INVALID) |
| `e2e/flows/stale-check-out.spec.ts` | bulk check-out of visitors left from previous days |
| `e2e/camera/camera-scan.spec.ts` | real camera path (Y4M), tablet |
| `e2e/quality/accessibility.spec.ts` | axe and horizontal scroll: 48 page checks per viewport |
| `e2e/quality/dialogs.spec.ts` | every dialog: panel in the viewport, footer buttons in the panel, axe (1440 and 820 only) |
| `e2e/quality/scan-timing.spec.ts` | scan → check-in → ready under 10 s, per viewport |
| `e2e/*.spec.ts` | the three mocked layout specs of earlier phases (unchanged apart from an import extension) |

**Projects** (`playwright.config.ts`):

| Project | Viewport | Runs |
|---|---|---|
| `desktop` | 1440 × 900 | layout specs, `quality/**` |
| `tablet` | 820 × 1180, touch | layout specs, `quality/**`, `camera/**` |
| `mobile` | 390 × 844, touch | layout specs, `quality/**` except `dialogs.spec.ts` |
| `flows` | 1440 × 900; each scenario opens one context per person with that person's device (reception on the tablet) | `flows/**` |

## §40 acceptance scenario: what each step asserts

Every step is a `test.step` titled `§40 step N: …`. Four browser contexts take part: the administrator and the new employee on desktops, the new receptionist on a tablet (820 × 1180, touch, `pointer: coarse` asserted), and further contexts for the step 28 users.

| Step | Assertions |
|---|---|
| 1 | UI sign-in of `admin@demo.local`; lands on `/admin` ("Admin dashboard"); `/auth/me` has SYSTEM_ADMIN |
| 2 | Departments → Add department: `POST /departments` 201, toast, listed, active in `GET /departments` |
| 3–4 | Users → Add user, generated temporary password, role Employee (with the new department) / Reception: `POST /users` 201, "User created" shows the same temporary password once, `must_change_password: true` |
| 5 | The employee signs in with the temporary password: forced to `/change-password`; other API calls answer 403 PASSWORD_CHANGE_REQUIRED; after the change, lands on My visits with `must_change_password: false`; the temporary password no longer signs in (401) |
| 6 | Invite visitor with a new visitor "Hamad Raouf" (company, phone, email), pass shared by the host, tomorrow 10:00–11:00: `POST /visits` 201; the visitor record holds the details; the visitor is found in the employee's visitor search. This visit is the "previous visit" of step 26 |
| 7–8 | Invite visitor again: Hamad picked from the returning-visitor typeahead, invitation by email, host = the employee (default), the new department, next 15-minute slot, purpose. Request body and response checked (visitor, host, department, purpose, exact start and end instants) |
| 9 | `pass_url` is `http://127.0.0.1:5199/pass#<43 chars of [A-Za-z0-9_-]>` with no query string; the token decodes to 32 random bytes and differs from the first visit's; the URL contains no name, email, phone, company, department or ID; the database stores exactly `sha256(token)` as the active pass; the "Pass link" field shows the same URL; the "Show QR code" dialog's QR (screenshot, decoded with zxing-wasm) is exactly the URL |
| 10–11 | The outbox has exactly one VISITOR_INVITATION to Hamad; its `pass_url` is the visit's; the text names the visitor, host, department, purpose and link; the one inline PNG (`cid:`) decodes to exactly the pass URL; the visit's invitation is SENT and the success view says so |
| 12 | The receptionist signs in on the tablet, changes the temporary password, lands on `/reception` |
| 13–15 | Scan tab selected, "Ready to scan"; the pass link entered in the handheld/paste field; `POST /reception/scan` sends only `{token}` and answers 200 READY for this visit |
| 16 | The result shows "Valid pass – ready to check in", the name, "Verify ID: Hamad Raouf", company, host, department, purpose |
| 17 | Check in: `POST /visits/{id}/check-in` `{method: QR, pass_token}` 200, "Checked in", back to "Ready to scan" without a tap; the time from scan to ready is recorded as an annotation and must be under 10 s |
| 18 | API: CHECKED_IN, method QR, checked in by the receptionist, `check_in_at` within the test's time window; the database row holds the same `check_in_at` |
| 19 | The outbox has exactly one HOST_ARRIVAL to the employee: "Your visitor Hamad Raouf has arrived and checked in…" |
| 20 | Inside tab lists the visitor with the host; `GET /reception/inside` contains the visit |
| 21 | Check out from the Inside tab: the confirmation for a check-in under 5 minutes ago, `{method: MANUAL}` 200, toast, the row disappears |
| 22–24 | API: CHECKED_OUT, MANUAL, checked out by the receptionist, `check_out_at ≥ check_in_at`, `duration_seconds` = the difference, pass REVOKED (VISIT_COMPLETED); the database row matches; the visit page shows "Checked out" and "Time on site" formatted as the app formats it |
| 25 | The visitor profile's "Visit history" table has both visits; the main visit's row says Checked out, department and purpose; the API history holds both |
| 26 | The first visit is unchanged: every durable field equals its creation response (status, schedule, window, snapshots, `updated_at`, invitation, pass); the database still has its active pass and the same `updated_at`; its history row says Scheduled |
| 27 | Audit log page, filtered by record or by actor: Department created; User created and Password changed (both users); Signed in (both); Visitor created; Visit created (both visits); for the main visit Visit created, Invitation queued, Invitation sent, Visitor pass scanned, Visitor checked in, Visitor checked out; Visitor pass issued (employee) and revoked (receptionist). Through the API: one scan with outcome READY, check-in and check-out by the receptionist, pass issue and revoke for this visit, and no name, email, phone, purpose, token or password in any of these events' metadata |
| 28 | Employee B (`host2@demo.local`): "Visit not found" page, 404 for the visit and the visitor, no Hamad in their search. Management: reads the first visit without any action button; cancel, edit, resend, check-in and scan answer 403 FORBIDDEN; `/visits/new` leads to Reports. The receptionist: `/admin`, `/admin/users`, `/admin/audit` lead to `/reception`; `/users`, `/audit-logs`, `/dashboard/admin` answer 403. Other Corp: "Visit not found" and "Visitor not found" pages, 404s, empty searches and audit, and its reception gets PASS_INVALID for a Demo pass. Finally, step 26's check is repeated |

## Decisions

E9-1. **The schema is recreated, not the database.** — The global setup runs, as `vms_owner` on `vms_e2e`: terminate other sessions of the two roles, `DROP SCHEMA public CASCADE`, `CREATE SCHEMA public AUTHORIZATION vms_owner`, USAGE for PUBLIC and `vms_app`, and the `db.ps1` revocations (no CREATE for PUBLIC, no TEMPORARY on the database). Alembic then builds everything (extension, tables, triggers, grants, default privileges) from nothing. — It needs only the owner role, as the contract says ("drop schema → migrate → cli seed-e2e"). The resulting privileges are the ones `scripts/db.ps1 init` gives, checked against `pg_namespace`/`pg_database` before the change.

E9-2. **The backend environment is explicit, and no rate limit is relaxed.** — `e2e/support/env.ts` sets every relevant variable instead of relying on the developer's `.env`: `APP_ENV=development`, the `vms_e2e` URLs for both roles, a random `SECRET_KEY` per run, `APP_BASE_URL`/`QR_BASE_URL` = `http://127.0.0.1:5199`, `ALLOWED_ORIGINS` with that origin, `TRUSTED_PROXIES` loopback (the Vite proxy sends X-Forwarded-For), `COOKIE_SECURE=false`, `EMAIL_PROVIDER=outbox` with the per-run folder, `EMAIL_FAIL_DOMAIN=fail.test`, and every rate limit at its `.env.example` default. — The suite stays inside every budget without relaxing any: one sign-in per seeded account per run, plus one UI sign-in of `admin@demo.local` (limit 30 per account per 15 min), UI sign-ins otherwise only for the two accounts the acceptance scenario creates, two password changes (limit 5 per account per hour), six invitation e-mails for the busiest host (limit 50 per day), four refused attendance actions for Other Corp's receptionist (limit 30 per minute), and no failed sign-in beyond the one deliberate 401 of step 5.

E9-3. **The Vite dev server, not `vite preview`.** — It is the `webServer` already in the config (Phase 5–7 FY-13), the mocked specs rely on it, and no build step is needed. Playwright starts it before the global setup. The setup's warm-up opens the lazily loaded routes (`/reception`, `/pass`, `/reports`, …) once. Otherwise the first test to open one could be reloaded by a dependency re-optimisation. The production build with its security headers (CSP, `wasm-unsafe-eval`) was checked live in Phase 8; this suite does not repeat that.

E9-4. **One session per seeded account, signed in through the proxy by the global setup, and never signed out.** — Storage states (`e2e/.artifacts/run/state/<account>.json`) are shared by every test of a run, so no test may sign out, change the password of, or deactivate a seeded account (that would end the shared session). Accounts whose password changes are created by the acceptance scenario. The API helper (`Api.as`, `Api.of(context)`) sends the CSRF header from the session's cookie and no Origin, as a same-origin fetch.

E9-5. **In the `flows` project the browser runs in America/Los_Angeles, the company in Asia/Amman.** — Every time the scenarios enter (invite form, walk-in) or read (results, visit pages) must be company wall time, whatever the device's zone (§10). The specs compute wall times in the company's zone with `Intl` (`e2e/support/time.ts`), independently of both.

E9-6. **Tests share one database, so each owns its data.** — Names and e-mail addresses carry a random tag. No test asserts a company-wide count. The bulk stale check-out is the only company-wide action, and only its spec makes Demo Company visits stale. The dialog spec, which changes passes and creates users, works in Other Corp. The quality specs' pages show three Demo Company visits created once by the global setup (`quality-data.ts`): one scheduled tomorrow with a sent invitation, one inside, one expected now. The flow specs never count these.

E9-7. **Expired passes use `cli e2e-time-travel`, and the same-day rule is asserted both ways.** — The visit is moved back until its window closed two minutes ago. An override is allowed only on the visit's company-local day (§5, D-08). If a run happens within the first hour or so after company-local midnight, the moved visit falls on the previous day. The spec computes which case applies, asserts `check_in_options` and the offered buttons accordingly, and records an annotation when the override part is not reachable. Nothing is skipped silently. The dialog spec does the same for the "Check in anyway" dialog.

E9-8. **E-mails are read from the outbox files, and QR codes are decoded in the test process with the app's own zxing-wasm.** — `outbox.ts` returns the latest message of a kind to a recipient, optionally narrowed by content. Several specs mail the same seeded host, so the walk-in spec matches on the visitor's name. `qr.ts` passes the local `zxing_reader.wasm` to `prepareZXingModule` (`wasmBinary`), so nothing is fetched from the package's default CDN. The same decoder reads the e-mail's inline PNG and a screenshot of the host's "Show QR code" dialog.

E9-9. **Storage is checked in the database itself (read-only, as `vms_app`).** — Steps 9, 18, 22 and 26 compare the API with the rows: pass hash, check-in and check-out instants, `updated_at`, active passes. The invitation-failure and rotation specs read `email_messages` and `visitor_passes`. `db.ts` runs `psql` with `json_agg`, and every ID is validated as a UUID before it goes into SQL.

E9-10. **The camera spec launches its own Chromium (`channel: 'chromium'`) with a generated Y4M.** — `make_y4m.py` (backend venv, `segno`) draws the pass URL's QR at 640 × 480, 4:2:0, centred at whole pixels per module on a grey frame. The context has camera permission, so the scanner starts without a tap. The spec asserts a live 640 × 480 video, exactly one `POST /reception/scan` with the token, READY, check-in, back to "Ready to scan" under 10 s, still exactly one scan after 7 more seconds with the code in view (the 5 s repeat window), and that every request went to `http://127.0.0.1:5199` (or `data:`/`blob:`), the WebAssembly decoder included. The reason for the channel is the comment in `playwright.config.ts` (L-FE-37).

E9-11. **Axe: every rule axe runs by default, failing on serious and critical impact only.** — Each page waits for its own content, for every loading spinner to disappear, and for network idle before the scan, then checks `scrollWidth ≤ clientWidth`. Signed out: sign-in, forgot password, both reset-password states, the pass page with and without a token, 404. Each role gets every page it may open, with all four reception tabs. Run at three viewports, that is 144 page checks. A throwaway spec (deleted afterwards) confirmed that these checks catch an injected `<img>` without `alt`, a 3000 px element, and a footer button pushed out of its dialog.

E9-12. **A dialog is measured once it has settled.** — A dialog's content can load after it opens (the QR code is rendered lazily), which resizes the panel. One full run measured the "Done" button against the panel's size before the QR appeared and failed spuriously. The geometry (viewport, panel, footer buttons) is now read in one `evaluate` and repeated every 150 ms until two readings agree. Dialogs are closed with Escape, except where the next dialog needs the action (Add user → User created; Issue a new pass link → Show QR code). The resend dialog with three footer buttons is included. The spec makes 22 dialog checks, each at 1440 and 820, covering all 16 components that render a `Dialog`.

E9-13. **Timings are annotations, and failing slow is a failure.** — The scan → check-in → ready time is recorded (`type: timing`) by the acceptance scenario (paste path, tablet), the camera spec and the timing spec (each viewport). Each must stay under 10 s. The JSON report keeps the annotations.

E9-14. **No retries; 4 workers.** — A flaky test is a failure to fix, not to hide (`retries: 0`). Four workers keep the single-process API, a Vite dev server and up to four browsers responsive on this machine. `E2E_WORKERS` overrides the number. `actionTimeout` is 15 s and `navigationTimeout` 30 s, so a missing element fails in seconds, not at the test timeout.

E9-15. **The `flows` scenarios assert the effective department, not the request field.** — The invite form leaves `department_id` out when it is the host's own department, and the server then uses the host's (B24-23, `toVisitCreate`). Step 7–8 asserts `department_id ?? host's department` and the department of the created visit.

E9-16. **The existing mocked specs are kept as they were**, apart from `'../src/types/api'` becoming `'../src/types/api.ts'` (type-only imports), so `npm run e2e:typecheck` can check the whole folder under `module: nodenext`. They still skip themselves outside their own project: 10 of the 187 tests are these intentional skips. `npm run e2e` no longer passes `--pass-with-no-tests` (phase-1-frontend #9).

## Results (2026-10-06)

Two consecutive full runs (`npx playwright test`, 4 workers, Windows 11, other agents' servers running on the same machine):

| | Run 1 | Run 2 |
|---|---|---|
| desktop | 57 passed, 1 skipped | 57 passed, 1 skipped |
| tablet | 54 passed, 5 skipped | 54 passed, 5 skipped |
| mobile | 50 passed, 4 skipped | 50 passed, 4 skipped |
| flows | 16 passed | 16 passed |
| **Total** | **177 passed, 10 skipped, 0 failed, 0 flaky** | **177 passed, 10 skipped, 0 failed, 0 flaky** |
| Duration (incl. ~16 s setup) | 4 min 54 s | 4 min 44 s |

Scan → check-in → ready (recorded annotations, run 1 / run 2): paste path 2.62 / 2.50 s at 1440, 2.58 / 2.65 s at 820, 2.60 / 2.67 s at 390; acceptance scenario (tablet) 3.1 / 3.3 s; real camera (tablet) 2.9 / 2.6 s. Each includes the app's ≈1.5 s success display.

A third full run, after the last change to the global setup (the PostgreSQL hint), also passed: 177 passed, 10 skipped, 0 failed, 0 flaky, in 5 min 26 s. After that, only the dialog spec's measuring function was reshaped for the linter, and its 8 tests passed again in both projects. `npm run lint`, `npx tsc -b` and `npm run e2e:typecheck` pass.

## Known limits

- Chromium only, as §11 specifies. No Safari/iPadOS or Firefox run, and no physical camera.
- If a run spans company-local midnight, the quality data's "inside" visit becomes a previous-day visit. The stale spec's bulk check-out would then also check it out, and the inside-list page checks expect it to be listed. The suite recreates its data every run, so the next run is unaffected.
- The suite and a manual `npm run dev` can run side by side (5173/8000 vs 5199/8700), but two E2E runs cannot share the fixed ports and database.
