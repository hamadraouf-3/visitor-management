# Phase 15 — backend decisions (Visitor Journey: the provider-neutral boundary, provider off)

Date: 2026-10-20. Scope: `backend/` (revision `0018`, models, services, routes, CLI, tests), the regenerated
`frontend/src/types/backend-contract.json` (no other frontend file), `deploy/verify/test_api_instances.py`,
`.env.example`, `deploy/env/backend.env.example`, `README.md`, `deploy/README.md`, `docs/api.md`,
`docs/security.md`, `docs/architecture.md`, `docs/production-readiness.md`, the new
`docs/visitor-journey-design.md` (backend parts; the interface section is the frontend's) and
`docs/visitor-tracking-integration.md`, and this file. Sections A–E and G (backend) and H (backend) of the
phase's contract; the web application's half is `phase-15-frontend.md`.

**The owner's decision (2026-10-20).** Gate 0 ([`visitor-tracking-model-assessment.md`](../visitor-tracking-model-assessment.md))
found no tracking model, code, interface or documentation. Build the provider-neutral part now, with the
provider **off**: the location registry, the per-visit tracking association and its lifecycle, the
authenticated ingestion contract, the journey service and the interface. **Not built:** a model adapter,
image capture, image or template storage, face recognition. Gate 3 (a real adapter) and Gate 5 (real
validation) stay **BLOCKED BY ENVIRONMENT**; no real-model test exists or is reported as passed.

**Contract changes.** Revision `0018` (ten new tables, nothing else changed). 22 operations: the location
registry (7), tracking status, settings, keys, cameras and the provider's ingestion (10), journeys and the
tracking actions (4), the platform owner's switch (1): 100 operations on 80 paths in all. One response
field on an existing type: `PlatformCompany.tracking_allowed` (and, after the lead's review, B15-27,
`MeCompany.tracking_allowed` and `JourneyListItem.freshness_seconds`). Three error codes (`TRACKING_NOT_AVAILABLE`,
`TRACKING_KEY_LIMIT`, `LOCATION_IN_USE`), one field code (`location_archived`), two capabilities
(`VIEW_JOURNEYS`, `TRACK_VISITS`), two rate-limit policies and their settings, one deployment setting
(`TRACKING_PROVIDER`), 17 audit actions (`JOURNEY_LIST_VIEWED` after the independent review), five audit
entity types, two CLI commands. The exact shapes are in
[`api.md` §10.14](../api.md#1014-the-visitor-journey); the frontend was given them early
(scratchpad `phase15-api-shapes.md`; its change log lists the later additions: the freshness anchor of
B15-12, the two fields of B15-27 and the changes after the independent review, B15-28 … B15-38).

---

## The provider and the off switch

**B15-1 — `TRACKING_PROVIDER`: `disabled` by default everywhere; `simulator` never in production.**
A deployment setting (`Literal["disabled", "simulator"]`, default `disabled`), in `.env.example` and
`deploy/env/backend.env.example` as `TRACKING_PROVIDER=disabled`. Settings validation refuses `simulator`
when `APP_ENV=production` ("TRACKING_PROVIDER=simulator is for development and E2E tests only"); any other
value is refused everywhere (no real adapter exists to name). `create_app` builds the provider once
(`create_tracking_provider`) into the application's one `ServiceEnvironment` (`tracking`), so every service,
the check-out included, uses the same instance; tests swap it like the rate-limit policies.
While `disabled`:
- enrollment answers 409 `TRACKING_NOT_AVAILABLE` (`reason: PROVIDER_DISABLED`);
- `POST /api/v1/tracking/events` answers **404 `NOT_FOUND` before anything else** (the route behaves as
  absent: no key is looked up, no body read), and so does every other method on the path (B15-38);
- every journey is `DISABLED`;
- the registry, cameras, keys and settings stay editable (a company prepares before tracking exists).
`enabled: true` is accepted while the provider is disabled (the company is ready; the state stays DISABLED).
*Held by* `tests/unit/test_config.py` (production refusal, defaults, the template line),
`test_tracking_ingestion.py::test_the_route_is_absent_while_the_provider_is_disabled`,
`test_tracking_lifecycle.py::test_enrollment_is_refused_while_the_provider_is_disabled`,
`test_journeys_api.py::test_journeys_are_disabled_while_tracking_is_off`.

**B15-7 — The provider protocol: `enroll`, `revoke`, `health`; enrollment is a binding request.**
`app/services/tracking_provider.py`: `TrackingProvider` (a typed `Protocol`: `name`, `enabled`,
`enroll(*, company_id, ref, provider_camera_id, at)`, `revoke(*, company_id, ref)`, `health() →
ProviderHealth(reachable)`), raising `ProviderError` on failure. Two implementations and no other:
`DisabledProvider` (enroll raises, revoke does nothing, unreachable) and `SimulatorProvider`.
- **Deviation:** the contract's `enroll(ref, provider_camera_id, at)` gains `company_id` (and `revoke`
  too). Keys are per company, so the provider must know which company's key to post the association's
  events with; the ref alone tells it nothing (it is random by design, B15-6). The company's ID is an
  internal identifier, not personal data.
- **No image ever crosses the boundary.** Enrollment says "the person at camera *C* now is association
  *A*"; the provider captures on its side. No column, field or endpoint can carry an image, a crop, an
  embedding or a template; unknown fields are refused everywhere (a camera's `rtsp_url`, an event's
  `crop`: 422 `not_allowed`). A future model needing an upload is a separate design and privacy review.
- **The simulator** enrolls at once by sending an `ENROLLED` event **through the same ingestion service**
  (`ingest_simulated`, a session of its own, after the enrollment's commit), with `model_version`
  "simulator" and a random event ID (nothing of the ref in it). Its associations are `provider:
  "simulator"`, answered `simulated: true`; `TrackingStatus.simulated` is true while it is the
  deployment's provider. `revoke` has nothing to forget; `health` is reachable.
*Held by* `tests/unit/test_tracking_rules.py` (the two providers, the factory),
`test_tracking_lifecycle.py::test_the_simulator_enrolls_at_once_and_marks_it_simulated`,
`test_tracking_lifecycle.py::test_events_are_stored_without_images_or_payloads`,
`test_tracking_admin.py::test_cameras` (no URL field).

**B15-18 — Provider calls after the commit; failures counted, never undone.** Every `enroll` and
`revoke` is made once the application's change has committed, so no database lock is held while a
provider answers (the e-mail rule of contract §3.2-1, applied here). `TrackingLifecycle` collects the refs
it ended and `after_commit()` calls `revoke` for each: best effort, a failure is logged by the exception's
class only (never the ref or the provider's message) and counted in the company's health record
(`PROVIDER_REVOKE_FAILED`) in a transaction of its own; the association stays ended, so the provider's
later events for it are rejected. An `enroll` the provider does not take ends the association at once
(`ENROLLMENT_FAILED`, counted `PROVIDER_ENROLL_FAILED`), so reception can try again; a provider that takes
it and answers later leaves it PENDING (until its 10-minute timeout, B15-34). If counting a failure fails
too, the committed change stands (B15-37). **Lock order: the company row first, always** (corrected after
the independent review, B15-29): a visit change (check-out, enroll, revoke) takes it `FOR KEY SHARE`, then
the visit, then its association; a company-wide change (switch-off, key revoke, the platform owner's
switch, deactivation) takes it `FOR UPDATE`, then its settings or key row, then the open associations in
ID order; an ingested batch and an expiry sweep take it `FOR KEY SHARE`, then the key row, then the
associations in ID order, and write the health rows last. *(The first version said ingestion took no
company lock; the event's foreign keys took one anyway, last, which deadlocked with a switch-off.)* *Held
by* `test_tracking_lifecycle.py` (provider failures, the pending provider, revokes after check-out, expiry,
switch-offs), `test_tracking_races.py`.

---

## The data model (revision 0018)

**B15-2 — The companies' tracking settings are a side table; `allowed` is the platform owner's.**
`company_tracking_settings` (one row per company, created by the first change; **no row means the
defaults**, so a read writes nothing) rather than columns of `companies`: every visit change takes the
company row `FOR KEY SHARE`, and altering that table would take its ACCESS EXCLUSIVE lock; a side table
leaves `companies` and the previous release untouched. Columns: `allowed` (default false), `enabled`
(default false; CHECK `allowed OR NOT enabled`), `min_confidence` (null), `stale_after_minutes` (15,
1–240), `retention_days` (30, 1–90). `allowed` is set only by `PATCH /platform/companies/{id}/tracking`
(a small new endpoint rather than a field of the company's identity PATCH: it has its own audit actions
and side effects); disallowing switches `enabled` off and ends the company's open associations in the
same transaction. `PlatformCompany` answers `tracking_allowed`. Both trails are written
(`record_platform_change`, B11-5): `TRACKING_ALLOWED` / `TRACKING_DISALLOWED` (`was_enabled`,
`ended_tracking`). *Held by* `test_tracking_admin.py::test_the_platform_owner_allows_tracking_per_company`,
`::test_settings_have_the_defaults_and_enabling_needs_the_platform_owner`.

**B15-3 — Tenant isolation in the schema: composite foreign keys everywhere, and event consistency.**
Every row has `company_id`; every same-company reference is a composite foreign key over
`(company_id, …)` to a `UNIQUE (company_id, id)` target (floors → buildings, zones → floors, cameras →
zones, associations → visits, cameras and users, keys → users). Events go further: `(company_id,
association_id, visit_id)` references the association (an event's visit is its association's),
`(company_id, building_id, floor_id)` the floor (the floor is in that building) and `(company_id,
floor_id, zone_id)` the zone (the zone is on that floor). Long constraint names are given explicitly
(`fk_journey_events_association`, …) so the migration and the models agree under PostgreSQL's 63-byte
limit. Every repository method takes `company_id` but two, listed in `tests/unit/test_service_helpers.py`
`UNSCOPED`: the key lookup by digest (it is the authentication) and the platform owner's `allowed` of
the companies it lists. *Held by* `test_tracking_database_rules.py::test_composite_keys_keep_every_reference_in_its_company`
and the cross-company tests of every endpoint (`test_tracking_admin.py::test_nothing_of_another_company_is_reachable`,
`test_tracking_lifecycle.py::test_another_company_s_visit_is_not_found`,
`test_tracking_ingestion.py::test_another_company_s_key_cannot_reach_this_company_s_associations`,
`::test_unknown_cameras_and_refs_are_rejected_and_only_counted`, `test_journeys_api.py::test_roles_and_tenants`).

**B15-4 — Cameras: the provider's ID, a zone, nothing else.** `provider_camera_id` is 1–128 **visible
ASCII** characters (`!`–`~`: no space, no control or look-alike character; compared exactly, never trimmed),
unique per company (409 `CONFLICT` `provider_camera_id`; another company may use the same ID). `zone_id` is
required (a camera without a zone cannot exist) and must be an active zone (422 `not_found` /
`location_archived`). No credential, URL, IP or stream address is stored or accepted. Names follow the
department rules (1–120, one line). Archive / restore with `is_active`. Receptionists read **only the active
enrollment points in active zones**; `include_archived` is administrators' (403 otherwise, like
`GET /departments?include_inactive`). *Held by* `test_tracking_admin.py::test_cameras`.

**B15-5 — The registry is archived, never deleted.** The contract allowed "a hard delete only when
unused"; **not provided**: the runtime role holds no `DELETE` (revision 0006, checked at production start
by `db.privileges`), and granting it on these tables would weaken that guarantee for a convenience.
Archiving (`is_active: false`) is the only removal:
- refused while the location holds active children (a building with an active floor, a floor with an
  active zone, a zone with an active camera): **409 `LOCATION_IN_USE`**;
- a child cannot be created in, or restored under, an archived parent: **422 `location_archived`** (new
  field code, no parameters) on `building_id`, `floor_id`, `zone_id` or `is_active`.
So an active camera always stands in an active zone on an active floor in an active building, and an
archived camera or zone never places anyone. Names are unique per parent, ignoring case (a building's in
the company, a zone's on its floor: 409 `CONFLICT` `name`); `(building_id, level)` is unique (409
`CONFLICT` `level`). Arabic names are optional and not unique (unlike departments, B10-29: two zones of one
floor rarely share a name, and the check would add a cross-language rule for little). `level` is an
integer from −20 to 200 (a placeholder range, B15-16). A change locks the company row `FOR UPDATE`
(serialising the uniqueness checks of one company) and re-checks the caller (SEC-07). Audited
`LOCATION_CREATED` / `LOCATION_UPDATED` (`changed_fields`), entity `building`, `floor` or `zone`. *Held by*
`test_tracking_admin.py` (the tree, uniqueness, archiving).

**B15-6 — The ref: random, unrelated, never answered.** `trk_` + base32 of 20 random bytes (160 bits,
32 characters), CHECK `ref ~ '^trk_[a-z2-7]{32}$'`, globally unique. Nothing of the visit, the visitor, an
e-mail, a phone number, a name or a pass goes into it. It is stored as it is (the provider's events name it
and it must be found; it is not a credential: without a key it reaches nothing), and it is **never answered
by the API, logged or audited** (`TrackingAssociation` has no `ref` field; audit rows carry the
association's ID). A re-enrollment gets a new ref; the old one stays dead. *Held by*
`tests/unit/test_tracking_rules.py::test_refs_are_random_and_say_nothing`,
`test_tracking_lifecycle.py::test_re_enrollment_makes_a_new_association_and_the_old_ref_stays_dead`,
`test_tracking_ingestion.py::test_the_logs_carry_no_ref_key_or_payload`.

**B15-8 — Events keep the location they arrived with.** Each OBSERVED, ENROLLED or LOST with a known camera
stores `camera_id`, `building_id`, `floor_id` and `zone_id` **as registered when it arrived**: moving a camera
to another zone later never rewrites history. Names are not copied: the timeline shows a location's current
name (a rename is a correction; a move is a change of fact). *Held by*
`test_tracking_database_rules.py` (the consistency keys) and the timeline assertions of
`test_tracking_ingestion.py`.

**B15-10 — Keys: shown once, stored as SHA-256, two at most.** `vtk_` + `secrets.token_urlsafe(32)` (256
bits, 47 characters). Stored: its SHA-256 (`key_hash`, CHECK hex), a display `prefix` (its first 8
characters, `vtk_` + 4), a `label`, the creator, `last_used_at` (each authenticated request), `revoked_at`
and the revoker. The key is in the `POST` answer only (`TrackingKeyCreated.secret`). "At most two unrevoked
per company" is a database rule: each live key holds `slot` 1 or 2 under a partial unique index
`(company_id, slot) WHERE revoked_at IS NULL`; a third answers 409 `TRACKING_KEY_LIMIT`. Revocation is
`DELETE /tracking/keys/{id}` (the row stays, listed as revoked; idempotent). A key of a deactivated company is
refused like a wrong one. Audit rows name the key's ID only, never its prefix. *Held by*
`test_tracking_admin.py::test_keys_are_shown_once_stored_as_digests_and_limited_to_two`,
`test_tracking_ingestion.py::test_a_revoked_key_is_401`, `::test_a_deactivated_company_s_key_is_401`,
`test_tracking_database_rules.py::test_two_live_keys_at_most_and_the_settings_invariant`.

**B15-11 — Health: the last contact, the last accepted event, and counts by reason in a 24-hour ring.**
`tracking_health` (one row per company): `last_contact_at` (**any** request with a valid key, a
heartbeat-only one or an all-rejected one included; the simulator's ingestion too) and
`last_accepted_event_at`, never moved back (`greatest`). `tracking_health_counts`: per company and reason, 24
hourly slots (`slot = hour mod 24`, `hour_start`, `count`) upserted in place: a slot last used 24 hours ago
starts again. The table never grows and the runtime role never deletes. Reasons are the rejection codes and
`PROVIDER_ENROLL_FAILED` / `PROVIDER_REVOKE_FAILED`. Exposed to administrators only, in
`TrackingSettings.health` (`rejected_last_24h`, `provider_errors_last_24h`; counts only, never an event).
`TrackingStatus.healthy` (every journey role, for the banner) = the provider is not disabled, the company has
tracking allowed and enabled, `health()` is reachable, and the last contact is within 5 minutes.

**B15-23 — Revision 0018: additive, locked briefly, guarded on the way down.** Ten new tables, their
indexes, the trigger `visitor_journey_events_immutable` (BEFORE UPDATE, for every role) and `REVOKE UPDATE ON
visitor_journey_events FROM <runtime role>` (the runtime role gets SELECT, INSERT, UPDATE on the new tables
from the default privileges of revisions 0001/0006, then loses UPDATE on events; `db.privileges` accepts
fewer privileges than the allowlist). **No existing table, column or constraint changes**, so the previous
release's code runs on the migrated schema unchanged; no constraint is added to an existing table, so the
`NOT VALID` / `VALIDATE` step of 0016/0017 has nothing to apply to (the new tables are empty). Creating the
foreign keys takes SHARE ROW EXCLUSIVE on `companies`, `users` and `visits` for the transaction: `SET LOCAL
lock_timeout = '5s'` as in 0016/0017 (B14-23). Downgrade locks the new tables (SEC-39) and refuses while any
location, camera, association, event or key exists, or a company's settings differ from the defaults
(restore the pre-upgrade backup instead); it drops the derived health rows. *Held by*
`test_tracking_database_rules.py::test_revision_0018_only_adds_and_goes_back_cleanly` (every 0017 table,
column, constraint and index identical after the upgrade; downgrade back to the 0017 schema; upgrade again),
`::test_the_downgrade_refuses_to_lose_what_was_entered`,
`::test_the_0018_upgrade_gives_up_a_lock_it_cannot_get_and_leaves_nothing_behind` (B15-32),
`test_migrations.py` (round trip from base, models match the migration, the trigger list),
`test_runtime_privileges.py`.

---

## Lifecycle and ingestion

**B15-14 — Enrollment, and the association's ends, inside the existing state machine.**
- **Enrollment** (receptionists and administrators): `begin_visit_change` (NO_SHOW marking, the company row
  `FOR KEY SHARE`, the caller re-checked), the visit `FOR UPDATE`, the company's expired associations ended,
  then in order: provider disabled / not allowed / not enabled → 409 `TRACKING_NOT_AVAILABLE` with
  `details.reason`; **an open association → 200 with it (idempotent, never a second)**; not CHECKED_IN → 409
  `VISIT_NOT_CHECKED_IN` (the existing code; any CHECKED_IN visit is accepted whatever its schedule, B15-34:
  the first version refused one whose pass window had ended, `WINDOW_ENDED`); the camera not an active
  enrollment point of the company in an active zone → 422
  `camera_id` `not_found` (the existing scoped-reference answer, so another company's camera is answered
  like a missing one). The PENDING association is committed with `TRACKING_ENROLLMENT_REQUESTED`, then the
  provider is asked (B15-18). The answer is the visit's journey (`VisitJourney`), so the interface needs no
  second request. The partial unique index `uq_tracking_associations_open_visit` is the database's half of
  the idempotency.
- **Check-out ends it in the same transaction**: `AttendanceService._record_check_out`, the one code path
  of every check-out (QR, MANUAL, CORRECTED and the bulk end-of-day one), calls
  `TrackingLifecycle.end_for_check_out` after revoking the pass: reason `CHECKED_OUT`, `ended_at` the
  check-out time (never before the association's creation: a CORRECTED or BULK time can be earlier); one that
  had already expired by then, unswept, ends `EXPIRED` at its expiry (B15-35). The provider is asked to
  forget it after the commit. A refused check-out changes nothing.
- **Revoke**: `POST /visits/{id}/tracking/revoke` (idempotent; `TRACKING_ASSOCIATION_REVOKED` with the
  actor); the administrator switching tracking off; the platform owner disallowing it; **the company's
  deactivation** (an addition: nobody of the company can check its visitors out any more, and its key is
  refused; the deactivation's audit row gets `ended_tracking` when it ended any). Reason `REVOKED`; each
  association's `TRACKING_ASSOCIATION_ENDED` names its `trigger` (`USER`, `TRACKING_DISABLED`,
  `TRACKING_DISALLOWED`, `COMPANY_DEACTIVATED`).
- **Cancellation**: a checked-in visit **cannot** be cancelled (`visit_rules`: only SCHEDULED → CANCELLED),
  and only a checked-in visit has an association, so no hook is needed; `VISIT_CANCELLED` stays in the reason
  enumeration (the contract lists it) as reserved.
- **Re-entry** follows the existing policy: a new visit, so a new association.
*Held by* `test_tracking_lifecycle.py`.

**B15-15 — Expiry: 10 minutes to activate, 12 hours once active; checked on reads, not by a job.**
*Replaced after the independent review by B15-34.* The first rule was `expires_at = min(visit.window_end,
enrolled_at + 12 h)` with enrollment refused once the window had ended (`WINDOW_ENDED`); it ended the
tracking of a visitor still inside (a late OVERRIDE check-in, an overstay). Now a PENDING association gets
`expires_at = created_at + 10 min` (`pending_expiry`), and accepting its ENROLLED sets `expires_at =
activated_at + 12 h` (`active_expiry`); the visit's schedule plays no part. Every read and ingest of a
company first ends its open associations whose expiry has passed (`TrackingLifecycle.expire_due`: a cheap
EXISTS, then the company row `FOR KEY SHARE` and the rows locked in ID order, ended at `expires_at`,
`trigger: EXPIRY`, no actor), commits, and asks the provider to forget them; a check-out does the same for
its visit's association (B15-35); the state function also treats an unswept expired association as ENDED.
*Held by* the tests listed under B15-34.

**B15-9 — Ingestion: per-event outcomes; rejected events counted, never stored; history append-only.**
`POST /api/v1/tracking/events` (`app/services/tracking_ingestion.py`; contract: `visitor-tracking-integration.md`):
- **Transport.** `Authorization: Bearer <key>` only, the scheme exactly `Bearer`. The route is in the CSRF
  exemption list (a cookie cannot ride on it; a provider sends no token) and ignores cookies: a signed-in
  browser without the key gets 401. The key is accepted **before** the body is read (the dependency reads and
  parses it itself, so a stranger's body is never parsed); `Content-Type` must be `application/json` (415
  otherwise); a body that is not JSON, not UTF-8 or nested past the parser's depth is 422 `invalid_json`.
  64 KiB (the API's limit), 1–100 events (422 beyond).
- **Malformed → 422 for the whole batch, nothing applied**: unknown fields; `association_ref` present on a
  HEARTBEAT or absent elsewhere; `camera_id` missing on ENROLLED or OBSERVED; `match` missing on OBSERVED or
  present elsewhere; IDs not visible ASCII or too long; `observed_at` without an offset; `confidence` outside
  0–1 or not finite. A ref that is well-formed text but not a ref is answered per event
  (`UNKNOWN_ASSOCIATION`), so a provider learns nothing from the shape check.
- **Per event** (the batch's ENROLLED and ENROLLMENT_FAILED first, then the others in order, B15-28; the
  outcomes in the batch's order), the first that applies: HEARTBEAT → accepted; a known event ID (read once
  the batch's associations are locked, B15-33) → `duplicate` (no new row; `INSERT … ON CONFLICT DO NOTHING`
  also settles two batches racing); then rejected with `TRACKING_OFF`, `IN_FUTURE` (> 2 min ahead: a
  per-event answer, not 422, since it depends on the server's clock), `TOO_OLD` (before the company's
  retention), `UNKNOWN_ASSOCIATION`, `ASSOCIATION_ENDED`, `NOT_ACTIVE` (a sighting of a PENDING association,
  B15-28), `BEFORE_ASSOCIATION`, `UNKNOWN_CAMERA`, `ALREADY_ENROLLED`, `CAMERA_MISMATCH`. Four reasons are
  additions to the contract's list: `NOT_ACTIVE`, `BEFORE_ASSOCIATION` (an event observed more than 2 minutes before the association was
  created: older footage is never attributed to a visit), `ALREADY_ENROLLED` (a second ENROLLED, or an
  ENROLLMENT_FAILED, for an ACTIVE association: it changes nothing and would duplicate the timeline) and
  `CAMERA_MISMATCH` (ENROLLED at another camera than the one the binding request named: the provider may have
  bound someone else).
- **Late events**: an OBSERVED or LOST observed before its association ended is appended and changes nothing,
  **if the association had been activated and did not end `ENROLLMENT_FAILED`** (B15-28); one observed after
  the end, or of an association that never activated, is `ASSOCIATION_ENDED`. ENROLLMENT_FAILED repeated for
  an association it ended is a `duplicate` (it is not stored, so this keeps its retry idempotent).
- **Not stored**: rejected events (counted by reason, B15-11: rows of people who are not enrolled visitors
  would be surveillance data), ENROLLMENT_FAILED (it ends the association) and HEARTBEAT (it records contact).
  The stored types are ENROLLED, OBSERVED, LOST.
- **Append-only**: no UPDATE for the runtime role, and the trigger refuses UPDATE for anyone; the schema
  owner's DELETE is retention (B15-21).
- The company is always the key's; cameras resolve within it to **active** cameras in active zones (B15-5).
*Held by* `test_tracking_ingestion.py`, `test_tracking_races.py`, `test_tracking_database_rules.py`, `test_tracking_cli.py::test_the_runtime_role_cannot_delete_or_rewrite_journey_events`.

**B15-17 — The ingestion endpoint's budgets, process and contract.** Two policies, in `.env.example`:
`tracking_requests_per_key` (`RATE_LIMIT_TRACKING_REQUESTS_PER_MINUTE`, 120 a minute per key, bounded scope)
and `tracking_key_failures_ip` (`RATE_LIMIT_TRACKING_KEY_FAILURES_PER_IP`, 30 per 5 minutes per client
address, network scope, checked before the lookup and counted only for a wrong key: B15-36; the first
version reserved it for every request, so many valid requests in flight could exhaust it). Not guessing limits (a key
has 256 bits); they bound load and audit rows (`RATE_LIMITED` is coalesced as usual, attributed to the key's
company for the per-key policy). The endpoint and every `/api/v1/tracking/…` route stay on the main API
instance (`deploy/verify/test_api_instances.py`: a new main-only prefix, each route listed), since the
budgets live in its memory. The provider-facing models (`TrackingEventBatch`, `TrackingEventResults`) are
**not** in the frontend's contract snapshot: the web application never calls the endpoint.

**B15-12 — What counts as confirmed, and the journey state.** (`app/services/tracking_rules.py`.)
- **Confirmed** = `match = CONFIRMED` **and** `confidence ≥ min_confidence`. A **null threshold confirms
  nothing** (the default: it must come from an evaluation on site footage, never an arbitrary number); an
  observation **without a confidence is never confirmed** (it cannot be compared). Confidence and threshold
  are `double precision`, not `numeric`, so the provider's value is stored exactly as sent and the threshold
  needs no rounding rule.
- **The last known location** comes only from a confirmed observation of the visit's **latest
  association**, and only once the provider has activated it (B15-28) (an earlier, ended association's
  observations are history in the timeline, never the current location: a re-enrolled visitor is "Unknown"
  until confirmed again). It is answered with its time and `freshness_seconds` (never negative) in every
  state (an UNCERTAIN or STALE chip says how far to trust it) **except a conflict**: while a confirmed
  observation within 60 s of the latest confirmed one names another floor, the location, its time and its
  freshness are null (amended after the independent review, B15-30); null means "Unknown".
- **The state**, for an ACTIVE association, in order: UNAVAILABLE (no contact for 5 min) → STALE if the
  latest sighting is a LOST → UNCERTAIN if the latest observation is **fresh** (within
  `stale_after_minutes`) and not confirmed, or a confirmed observation within 60 s of the latest confirmed
  one names another floor → STALE if nothing has been confirmed for more than `stale_after_minutes`, the
  **freshness anchor** being the latest confirmed observation's `observed_at`, or the association's
  `activated_at` while there is no confirmed observation yet → ACTIVE.
- **Changed after the lead's review (2026-10-20).** The first version made an association with no
  observation yet STALE, so the journey read STALE right after every enrollment, which looks like a fault.
  The lead decided: anchor freshness on the latest confirmed observation, or on `activated_at` before the
  first one. A freshly activated association is now **ACTIVE with `last_location` null** ("Unknown"), and
  turns STALE only once `stale_after_minutes` pass since the activation without a confirmed observation.
  A LOST still gives STALE (the provider says it lost the person; the last confirmed location stays as
  history). A fresh uncertain sighting reads UNCERTAIN; an old one (beyond the threshold, with nothing
  confirmed since) reads STALE. The provider's outage outranks everything. "Latest" orders by
  `observed_at`, then `received_at`, then the row ID. No API shape changed.
- The interface marks each timeline entry from `JourneyEvent.confirmed`, not from `match`.
*Held by* `tests/unit/test_tracking_rules.py::test_journey_state` (28 cases, the activation anchor's
boundaries included), `test_tracking_ingestion.py` (the state tests: a fresh enrollment ACTIVE, then STALE
after 15 minutes without a confirmed observation; active, out-of-order, uncertain / below threshold / no
confidence / null threshold, conflicting floors, stale, lost, outage and recovery), and
`test_tracking_lifecycle.py::test_the_simulator_enrolls_at_once_and_marks_it_simulated` (ACTIVE right
after enrollment).

---

## Reads, roles, audit, retention

**B15-13 — Roles: journeys for the company-wide readers, never for hosts.** Two capabilities in the §7.5
matrix (`CAPABILITY_ROLES`, unit-tested): `VIEW_JOURNEYS` = SYSTEM_ADMIN, MANAGEMENT, RECEPTIONIST (the
list, a visit's journey, the status banner, the location tree) and `TRACK_VISITS` = SYSTEM_ADMIN,
RECEPTIONIST (enroll, revoke, the enrollment cameras). Configuration (settings, keys, cameras' writes, the
registry's writes) is `ADMINISTER`. **A host who is only an employee gets 403, even for the visit they
host**: least privilege, a host has no need for a visitor's movements. `VisitJourney.can_enroll`,
`enroll_blocker` (`NOT_PERMITTED` for management) and `can_revoke` tell the interface what the server will
accept. *Held by* `tests/unit/test_permissions.py`, `test_journeys_api.py::test_roles_and_tenants`,
`test_tracking_lifecycle.py::test_only_reception_and_administrators_enroll_and_revoke`.

**B15-20 — The journey reads.**
- `GET /journeys`: the visits **inside at some time of the company-local `day`** (default today): checked in
  before the day's end and not checked out before its start. So today's list holds everyone inside now
  (from whatever day) and everyone checked out today; a past day's, everyone who was inside that day. Search
  `q` on the visitor's name or company snapshot (`ILIKE`, the existing trigram indexes); newest check-in
  first, then ID. Without a `state` filter the page is read in SQL and only its visits' states are computed;
  with one, the day's visits are computed and filtered (a state is computed, not stored; a day's visits of
  one company are a bounded set).
- The states of a page are computed in one query per part, not per visit: the latest association per visit
  (`DISTINCT ON`), then one query with three LATERAL subqueries per association (its latest sighting, its
  latest confirmed observation, and whether a conflicting confirmed one exists), each reading
  `ix_journey_events_visit_observed` backwards.
- `GET /visits/{id}/journey`: the visit, the state, the latest association, the last location and the
  timeline — **the latest 500 events** in ascending `observed_at` with `timeline_total` (the contract said
  "all events"; a placeholder cap so a long visit cannot make one answer unbounded, B15-16).
- `enroll_blocker`: the first of `NOT_PERMITTED`, `PROVIDER_DISABLED`, `NOT_ALLOWED`, `NOT_ENABLED`,
  `ALREADY_ENROLLED`, `NOT_CHECKED_IN`, `NO_ENROLLMENT_POINT` — a short state, not a note (`WINDOW_ENDED`
  was removed after the independent review, B15-34).
- Only activated associations are summarised, and the timeline keeps only their events (B15-28).
- Both reads first end the company's expired associations (B15-15); the journey's answer is not cached.
*Held by* `test_journeys_api.py`, `test_tracking_lifecycle.py`.

**B15-19 — Audit: IDs and enums only; opening a journey coalesced per user, visit and hour; the list per
user and hour.** New actions:
`TRACKING_ENROLLMENT_REQUESTED`, `TRACKING_ASSOCIATION_ACTIVATED`, `TRACKING_ASSOCIATION_ENDED` (`reason`,
`trigger`), `TRACKING_ASSOCIATION_REVOKED`, `TRACKING_ENABLED`, `TRACKING_DISABLED` (`revoked`),
`TRACKING_ALLOWED`, `TRACKING_DISALLOWED`, `TRACKING_SETTINGS_UPDATED` (`changed_fields`),
`TRACKING_KEY_CREATED`, `TRACKING_KEY_REVOKED`, `TRACKING_CAMERA_CREATED`, `TRACKING_CAMERA_UPDATED`,
`LOCATION_CREATED`, `LOCATION_UPDATED`, `JOURNEY_VIEWED`, `JOURNEY_LIST_VIEWED` (B15-31); new entity types `building`, `floor`, `zone`,
`tracking_camera`, `tracking_key`. Association rows are filed on their **visit** (entity `visit`,
`association_id` in metadata), so a visit's audit history shows its tracking. Never a ref, a key, a key's
prefix or an event. **Journey access**: `GET /visits/{id}/journey` writes `JOURNEY_VIEWED` unless the same
user already has one for the same visit in the last **60 minutes** (a rolling window, checked in
`audit_logs` itself on `ix_audit_logs_entity_type_entity_id`, so it survives restarts and holds across
processes; two simultaneous first opens may both write, which over-records and never under-records). The
day's list is not an opening of a journey and is not audited per visit; **amended after the independent
review (B15-31)**: a list answer that shows anyone's location writes `JOURNEY_LIST_VIEWED` (entity
`company`, `day`, `located`), at most once per user in 60 minutes, the same way. *Held by*
`test_journeys_api.py::test_opening_a_journey_is_audited_once_an_hour_per_user_and_visit`,
`::test_a_list_that_shows_locations_is_audited_once_an_hour_per_user` and the audit assertions throughout.

**B15-21 — Retention: `cli prune-journeys`, as the schema owner, daily.** Deletes the events observed more
than the company's `retention_days` ago (default 30 for a company without settings) and the ENDED
associations that ended more than that ago and hold no event any more; one statement each for all companies,
on the owner's connection (MIGRATION_DATABASE_URL), like `prune-sessions`; it prints the counts and writes no
audit row (the audit rows name IDs only and stay). Allowed in production. A daily crontab line sits next to
the backup and `prune-sessions` lines in `deploy/README.md`. Ingestion refuses events older than the
retention (`TOO_OLD`), so nothing arrives only to be pruned. *Held by*
`test_tracking_cli.py::test_prune_journeys_keeps_each_company_s_retention`.

**B15-22 — `cli simulate-journey` (non-production).** `--visit <id>` `[--steps N (1–99, default 3)]`
`[--interval-seconds S (default 120)]` `[--match CONFIRMED|UNCERTAIN]` `[--confidence X]`. Refused with
`APP_ENV=production` and unless `TRACKING_PROVIDER=simulator`; needs the visit's open association to be the
simulator's. It sends a HEARTBEAT and the steps **through `TrackingIngestion`** with `model_version`
"simulator", walking the company's active non-enrollment cameras by name. Steps are placed up to now and
**never before the association existed** (they are squeezed closer for a fresh one), and the walk moves to
the next camera only after more than the conflict window, so the simulator never makes a journey UNCERTAIN
by itself. **No confidence unless `--confidence` is given**: synthetic data implies nothing about a real
model, and with the company's threshold unset nothing is confirmed anyway. *Held by* `test_tracking_cli.py`.

**B15-16 — Every constant is a placeholder pending real footage.** No model could be measured; each value
is named once (`tracking_rules`, the model and the settings defaults) and must be reviewed against the
cameras' analysis classes and an evaluation on site footage before real use
(`production-readiness.md` §15 J):

| Constant | Value | Where | Why this value for now |
|---|---|---|---|
| Conflict window | 60 s | `CONFLICT_WINDOW` | the contract's |
| Provider contact timeout (UNAVAILABLE) | 5 min | `PROVIDER_CONTACT_TIMEOUT` | the contract's |
| Clock skew tolerated (`IN_FUTURE`, `BEFORE_ASSOCIATION`) | 2 min | `CLOCK_SKEW_TOLERANCE` | the contract's 2 min, used both ways |
| Time to activate (a PENDING association expires) | 10 min after its creation | `PENDING_TIMEOUT` | long enough for a provider's round trip, short enough that a lost ENROLLED does not block the visit (B15-34) |
| Association's longest life | 12 h after its activation | `ASSOCIATION_MAX_LIFETIME` | the contract's upper bound (from the activation since B15-34) |
| Stale after | default 15 min, 1–240 | `company_tracking_settings` | the contract's default; the range is ours. Counted from the latest confirmed observation, or from the activation before the first (the lead's decision, B15-12) |
| Retention | default 30 days, 1–90 | `company_tracking_settings` | the contract's |
| Minimum confidence | **none** (null) | `company_tracking_settings` | no arbitrary default (the contract) |
| Floor level range | −20 … 200 | `FLOOR_LEVEL_MIN/MAX` | wide enough for any building met; ordering only |
| Timeline answered | the latest 500 events | `TIMELINE_LIMIT` | bounds one answer |
| Journey access audit | 1 row / user / visit / 60 min | `JOURNEY_VIEW_AUDIT_WINDOW` | the contract's example |
| Journey list audit | 1 row / user / 60 min, when a location is shown | `JOURNEY_LIST_AUDIT_WINDOW` | as the journey's (B15-31) |
| Events per batch | 100 | `MAX_EVENTS_PER_BATCH` | the contract's |
| Requests per key | 120 / min | `RATE_LIMIT_TRACKING_REQUESTS_PER_MINUTE` | 2 a second, 12,000 events a minute |
| Wrong keys per address | 30 / 5 min | `RATE_LIMIT_TRACKING_KEY_FAILURES_PER_IP` | the sign-in per-IP budget's size |
| Health ring | 24 hourly slots | `HEALTH_SLOTS` | "the last 24 h" |
| Simulator interval | 120 s | `cli simulate-journey` | more than the conflict window |

**B15-24 — No new dependency.** Everything is the standard library, SQLAlchemy, Pydantic and FastAPI already
in use; `base64`, `secrets` and `hashlib` make refs and keys.

**B15-25 — The contract snapshot.** `app/contract.py` publishes, under the names in `api.md` §10.14: 11
responses (`TrackingStatus`, `TrackingSettings`, `TrackingKey`, `TrackingKeyCreated`, `TrackingCamera`,
`LocationTree`, `Building`, `Floor`, `Zone`, `VisitJourney`, `JourneyListItem`), 12 requests
(`TrackingSettingsUpdate`, `TrackingKeyCreate`, `TrackingCameraCreate`, `TrackingCameraUpdate`,
`BuildingCreate`, `BuildingUpdate`, `FloorCreate`, `FloorUpdate`, `ZoneCreate`, `ZoneUpdate`,
`TrackingEnrollRequest`, `PlatformTrackingUpdate`), 2 queries (`JourneyListParams`, `TrackingCameraListParams`,
both in `QUERY_ROUTES`) and 1 envelope (`JourneyPage`); `PlatformCompany` gained `tracking_allowed`; the three
error codes and the field code are in its vocabularies. `frontend/src/types/backend-contract.json` is
regenerated; `api.contract.test.ts` fails until the frontend mirrors them (the frontend's part).

**B15-27 — Two fields the interface needs (the lead's request, 2026-10-20).**
- `MeCompany.tracking_allowed` (`GET /auth/me`, and the `Me` answered by sign-in and
  `PATCH /auth/preferences`): the platform owner's switch for the signed-in user's company, read from
  `company_tracking_settings` (false without a row). The navigation shows the Visitor Journey tab and
  the tracking administration only while it is true; the API's own checks are unchanged (journeys of a
  company not allowed answer DISABLED, enrollment 409). The platform owner's `PlatformMe` is not
  affected.
- `JourneyListItem.freshness_seconds`: whole seconds since `last_observed_at` at the server's clock,
  computed exactly as `VisitJourney.freshness_seconds` (`tracking_rules.freshness_seconds`, never
  negative), null without a confirmed location, so the list never relies on the device's clock.
*Held by* `test_auth_login.py` and `test_preferences_api.py` (the exact `Me` shapes),
`test_tracking_admin.py::test_the_platform_owner_allows_tracking_per_company` (true for the allowed
company, false for another and after disallowing), `test_journeys_api.py::test_the_day_s_visits_with_their_state`
(the list's freshness equals the journey's; null without a location).

**B15-26 — No "VMS" where people read it.** The product's surfaces avoid the retired abbreviation
(`deploy/verify/test_brand_names.py`): the code says "the application". The contract and Gate 0's report use
"VMS"; the new documents mostly do not.

---

## After the independent review (2026-10-20)

An independent review of this backend found eight defects, each shown by a probe (a throwaway test against
the code). All are fixed below; each probe is now a regression test in the suite, named under its decision.
The decisions they change are amended in place and point here. The interface's contract changed in two
enumerations (`EnrollBlocker` lost `WINDOW_ENDED`; `TrackingRejectReason` gained `NOT_ACTIVE`), one audit
action (`JOURNEY_LIST_VIEWED`) and three behaviours (a conflict answers no location; the expiry rule; every
method of the ingestion path is 404 while disabled); the shapes file's change log has the line.

**B15-28 — Only an association the provider activated has sightings (HIGH).** The review found that an
OBSERVED or LOST for a PENDING association was accepted and stored, and the late-sighting branch accepted one
for an association ended `ENROLLMENT_FAILED`; the journey then answered it as the visitor's last location —
a floor attributed to a visit with nobody bound to it. Now:
- a batch applies its `ENROLLED` and `ENROLLMENT_FAILED` events **first** (a stable sort; the others keep
  their order; the outcomes stay in the batch's order), so a provider may send the first sightings in the
  batch that confirms the enrollment;
- an OBSERVED or LOST for a PENDING association is rejected with the new reason **`NOT_ACTIVE`** (after
  `ASSOCIATION_ENDED`, before `BEFORE_ASSOCIATION`), counted and never stored;
- the late-sighting branch requires `activated_at IS NOT NULL` and `ended_reason <> ENROLLMENT_FAILED`;
  any other sighting of an ended association is `ASSOCIATION_ENDED`, whenever it was observed;
- the journey's summary, the list and the timeline (`AssociationRepository.summaries` is given only
  activated associations; `JourneyEventRepository.timeline` and `count_for_visit` keep only events of an
  activated association) ignore every event of an association that never activated, so a row stored before
  this rule shows nowhere.
README §1.6 and `security.md` §14 now say so ("counted and dropped, never stored" covers these sightings).
*Held by* `test_tracking_ingestion.py::test_sightings_of_an_association_that_never_activated_are_refused_and_never_shown`,
`::test_a_batch_applies_its_enrollment_before_its_sightings`,
`::test_a_stored_sighting_of_a_never_activated_association_is_not_shown`, `::test_enrollment_events`.

**B15-29 — The company row first, in ingestion too (MEDIUM).** The review found a deadlock: a batch locked its
key row and associations and only then reached the company row (the event's foreign keys take `FOR KEY
SHARE` on it), while switching tracking off, revoking a key, the platform owner's disallowing and the
company's deactivation lock the company row `FOR UPDATE` first and the associations after it. Now
`TrackingIngestion.ingest` starts with `CompanyRepository.get(company_id, lock=KEY_SHARE)` and, under it,
checks again that the key is unrevoked and the company active (the SEC-07 pattern: a revocation or a
deactivation that committed while the batch waited wins, 401), then touches the key, sweeps expiry, locks
the associations in ID order and writes the health rows last. The refused-enrollment path of
`JourneyService._ask_provider` and `TrackingLifecycle.expire_due` take the company row the same way. B15-18
and the `repositories/tracking.py` docstring state the corrected order. *Held by* the committed-connection
tests `test_tracking_races.py::test_a_batch_and_a_company_wide_change_do_not_deadlock` (switch-off and key
revoke; the old order fails it with `DeadlockDetected`, checked by reverting the lock) and
`::test_a_key_revoked_while_its_batch_waits_for_the_company_row_is_refused`.

**B15-30 — Conflicting floors answer no location (MEDIUM).** The review found that a journey UNCERTAIN
because two confirmed observations within 60 s name different floors still answered the latest one as the
last location, which the screen shows as a fact. Now, in that case, `last_location`, `last_observed_at` and
`freshness_seconds` are **null** in `VisitJourney` and in `JourneyListItem` ("Unknown", with the UNCERTAIN
chip): neither observation is reliable. When the state is UNCERTAIN only because the latest observation is
not confirmed, the last confirmed location is still answered (a reliable, timestamped observation; the chip
says how far to trust it). B15-12 is amended. *Held by*
`test_tracking_ingestion.py::test_two_confirmed_floors_within_a_minute_are_uncertain` (journey and list) and
`::test_uncertain_and_below_threshold_observations_never_become_the_last_floor` (the unconfirmed case keeps
the floor).

**B15-31 — Reading the list is audited: `JOURNEY_LIST_VIEWED` (MEDIUM).** The review found that `GET
/journeys` reveals every visitor's last floor and zone without leaving any trace, while opening one journey
does. Now a list answer that carries at least one `last_location` writes **`JOURNEY_LIST_VIEWED`** (entity
`company`, metadata `day` and `located`: how many rows of that answer showed a location), at most once per
user in a rolling 60 minutes (`JOURNEY_LIST_AUDIT_WINDOW`, checked in `audit_logs` like B15-19); an answer
without any location reveals nothing and writes nothing. B15-19 is amended. *Held by*
`test_journeys_api.py::test_a_list_that_shows_locations_is_audited_once_an_hour_per_user`.

**B15-32 — The migration under a live write: no defect, the probe kept.** The review's migration probe
upgraded 0017 → 0018 while a runtime transaction held a write on `visits`: the upgrade gave up after its 5 s
`lock_timeout` with nothing left behind (still 0017, no new table), succeeded when run again, and left the
runtime role SELECT, INSERT, UPDATE on the nine new tables and SELECT, INSERT on `visitor_journey_events`;
an UPDATE of an event was refused even to the owner. Kept as
`test_tracking_database_rules.py::test_the_0018_upgrade_gives_up_a_lock_it_cannot_get_and_leaves_nothing_behind`.

**B15-33 — A concurrent redelivery is a duplicate (LOW).** The review found that two deliveries of the same
ENROLLED racing each other answered the second `rejected ALREADY_ENROLLED` instead of `duplicate` (it read
the known event IDs before it waited for the association's lock). The known IDs are now read **after**
`lock_by_refs`, so the waiting batch sees what the first one stored. *Held by*
`test_tracking_races.py::test_a_concurrent_redelivery_of_the_same_enrolled_event_is_a_duplicate`.

**B15-34 — The expiry rule replaced (LOW, and the lead's decision).** B15-15 tied the association to the
visit's pass window: enrollment was refused once the window had ended (`WINDOW_ENDED`), and an association
expired at the window's end. But a visitor checked in late with an OVERRIDE, or staying past the window, is
still inside the building. Now:
- **any CHECKED_IN visit may be enrolled**; `WINDOW_ENDED` is gone from `EnrollBlocker` and from the
  `TRACKING_NOT_AVAILABLE` reasons;
- a **PENDING** association expires **10 minutes after its creation** (`PENDING_TIMEOUT`, a placeholder in
  B15-16), so a lost ENROLLED (the enrollment camera archived meanwhile, the provider restarted) never blocks
  the visit for hours: reception can start again;
- an **ACTIVE** association expires **12 hours after its activation** (`expires_at` is reset when ENROLLED is
  accepted); the check-out, the bulk end-of-day check-out, a revoke and the switches end it sooner.
Expiry is still checked on every read, ingest and check-out (B15-35), never by a job. *Held by*
`test_tracking_lifecycle.py::test_any_checked_in_visit_is_enrolled_whatever_its_schedule`,
`::test_an_active_association_expires_twelve_hours_after_its_activation`,
`::test_a_pending_association_expires_after_ten_minutes_and_reception_can_start_again`,
`::test_a_long_visit_s_association_also_expires_twelve_hours_after_activation`,
`tests/unit/test_tracking_rules.py::test_a_pending_association_expires_after_ten_minutes_an_active_one_after_twelve_hours`.

**B15-35 — A check-out after an unswept expiry (LOW).** The review found that a check-out made after the
association had expired, with no read in between to sweep it, ended it `CHECKED_OUT` at the check-out time,
later than it really ended. Now `end_for_check_out` ends it **`EXPIRED` at `expires_at`** (trigger
`EXPIRY`, no actor) when the expiry is not after the check-out's time (`check_out_at`, so a CORRECTED
check-out recorded as earlier than the expiry still ends it `CHECKED_OUT` at that time). *Held by*
`test_tracking_lifecycle.py::test_a_check_out_after_an_unswept_expiry_ends_it_at_its_expiry`.

**B15-36 — The wrong-key budget counts failures only (small).** The reviewer suspected, rightly, that
`tracking_key_failures_ip` was **reserved** for every request before the lookup and released only for a
valid key once it was settled, so more than 30 concurrent valid requests from one address (a provider
sending batches in parallel) got 429. Now the budget is **checked** before the lookup and **counted** only
for a wrong, revoked or absent key (or a deactivated company's). Concurrent wrong keys may pass the check
together and overrun it by their number: it bounds load, not guessing (a key has 256 bits). B15-17 is
amended. *Held by* `test_tracking_ingestion.py::test_a_check_of_the_failure_budget_takes_nothing_from_it`
(31 valid authentications with a budget of 1, none settled) and
`::test_valid_requests_never_spend_the_address_s_failure_budget`.

**B15-37 — Counting a provider failure never fails a committed change (small).** `after_commit` counted a
failed `revoke` in a transaction of its own; had that counting failed (the database unreachable for a
moment), the error would have turned an already committed check-out or switch-off into a 500. Now the
counting is caught: rolled back, logged by the error's class only, and the change answers as done. The
refused-enrollment path commits the association's end first and counts after it, the same way. *Held by*
`test_tracking_lifecycle.py::test_a_failure_to_count_a_provider_failure_never_fails_the_committed_change`
(check-out, switch-off, refused enrollment).

**B15-38 — Every method of the ingestion path is absent while disabled (small).** `GET /tracking/events`
answered 405 while the provider was `disabled`, revealing the path. Now every other method (`GET`, `HEAD`,
`PUT`, `PATCH`, `DELETE`, `OPTIONS`) has a route outside the OpenAPI document that answers 404 while the
provider is disabled and 405 otherwise; `PUT`, `PATCH` and `DELETE` on the path join the CSRF exemption list
(they only ever answer 404 or 405). *Held by*
`test_tracking_ingestion.py::test_every_other_method_is_absent_too_while_the_provider_is_disabled`.

---

## What a client or a test may have relied on

- `PlatformCompany` has one more field (`tracking_allowed`): an exact-shape assertion changes
  (`test_platform_companies.py` was updated). So does `Me.company` (`tracking_allowed`, B15-27:
  `test_auth_login.py`, `test_preferences_api.py`).
- `COMPANY_DEACTIVATED` audit rows carry `ended_tracking` when the deactivation ended any tracking
  association (none before this phase).
- The CSRF exemption list has four more entries (`POST`, and after the independent review `PUT`, `PATCH`
  and `DELETE`, on `/api/v1/tracking/events`, B15-38).
- After the independent review: `EnrollBlocker` and the `TRACKING_NOT_AVAILABLE` reasons no longer hold
  `WINDOW_ENDED`; the rejection reasons hold `NOT_ACTIVE`; `JOURNEY_LIST_VIEWED` is a new audit action (the
  interface's audit labels need it); a conflict answers `last_location` null; an association expires 10
  minutes after its creation while PENDING and 12 hours after its activation (B15-28 … B15-38).
- `tests/unit/test_body_limit.py` pinned the brand upload as the API's only `PUT`; the ingestion path's
  other-method route (B15-38) is a second one that never reads a body, and the test now names it.
- `ServiceEnvironment` has one more field (`tracking`, default `DisabledProvider`); `create_app` takes
  `tracking_provider`; `PlatformCompaniesService` takes `tracking` (default disabled).
- `RatePolicies` has two more policies; `.env.example` three more settings; the migration trigger list one
  more trigger; the runtime role holds no UPDATE on `visitor_journey_events`.
- The head revision is `0018`: the database-rule tests of earlier phases that pin it
  (`test_brand_database_rules.py`, `test_calendar_database_rules.py`, `test_platform_database_rules.py`) and the
  exact grants of `test_database_rules.py::test_runtime_role_privileges_match_contract` (22 tables with SELECT,
  INSERT, UPDATE; `visitor_journey_events` SELECT, INSERT) were updated; every earlier downgrade now passes
  through 0018's, which refuses only when Visitor Journey data exists.
- `GET /api/v1/platform/companies/{id}/tracking` is not a route (only `PATCH`): the company's `tracking_allowed`
  is read from `PlatformCompany`.

## Verification (2026-10-20)

Commands (from `backend/`, `backend\.venv\Scripts\python.exe`, PostgreSQL 18 on 5433, throwaway databases
created and dropped by the test harness; the `vms` database untouched):

| Gate | Command | Result |
|---|---|---|
| Full test suite | `python -m pytest -q` | **4,873 passed, 1 failed, 12 skipped** (4,886 collected; 27 min 51 s). The one failure is `tests/integration/test_access_log.py::test_the_response_time_excludes_background_work`, a timing bound (the first request of a fresh application under 500 ms) that measured 607 ms on a loaded machine; run alone it fails on the **pre-Phase-15 code (HEAD) as well** (940 ms and 824 ms, an exported copy of HEAD against the same cluster), so it is the machine's load (the frontend's builds and E2E ran at the same time), not this phase. Every other test passed, the 22 the first run's revision pins and grant list broke included (fixed: B15-23, "relied on") |
| Phase 15 tests | `python -m pytest tests/integration/test_tracking_admin.py tests/integration/test_tracking_lifecycle.py tests/integration/test_tracking_ingestion.py tests/integration/test_journeys_api.py tests/integration/test_tracking_cli.py tests/integration/test_tracking_database_rules.py tests/unit/test_tracking_rules.py -q` | **118 passed** (11 + 23 + 28 + 4 + 6 + 8 + 38) after the freshness-anchor change (B15-12); 111 before it. The full-suite numbers above are from before that change; the verification round runs the suite again |
| Lint | `python -m ruff check app alembic tests`; `python -m ruff format --check app alembic tests` | all checks passed; 347 files formatted |
| Types | `python -m mypy` (as configured) | no issues in 179 source files |
| Deploy checks | `python -m pytest ../deploy/verify -q` (also `python -m unittest discover -s deploy/verify -p "test_*.py"`) | **46 passed** (61 subtests) |
| Contract snapshot | `python -m app.contract --out ../frontend/src/types/backend-contract.json`; `tests/unit/test_contract_snapshot.py` | regenerated; 6 passed |
| Operations | `app.openapi()` | 100 operations on 80 paths |

**After the independent review (2026-10-20, 21:10), as the lead asked (not the full suite; the final
verification runs it):**

| Gate | Command | Result |
|---|---|---|
| Phase 15 tests, the review's regression tests included | the seven files above plus `tests/integration/test_tracking_races.py` | **140 passed** (11 + 28 + 39 + 6 + 9 + 5 + 4 + 38) |
| The shared files' tests | `test_check_out_api.py`, `test_check_in_api.py`, `test_reception_api.py`, `test_reception_concurrency.py`, `test_platform_companies.py`, `test_auth_login.py`, `test_preferences_api.py`, `test_rate_limit_abuse.py`, `test_http_behaviour.py`, `test_query_contract.py`, `test_audit_trail.py`, `test_csrf.py`, `tests/unit/test_rate_limit.py`, `test_csrf_middleware.py`, `test_routing.py`, `test_config.py`, `test_errors.py`, `test_contract_snapshot.py` | **654 passed** |
| Unit tests | `python -m pytest tests/unit -q` | 3,145 passed, 1 failed: `test_body_limit.py`'s pin of the only `PUT` (see "relied on"); updated, that file then 30 passed. `test_routed_reads.py` 61 passed |
| Lint, types | `ruff check`, `ruff format --check` (app, alembic, tests); `mypy` | all checks passed, 348 files formatted; no issues in 179 source files |
| Deploy checks | `python -m pytest ../deploy/verify -q` | 46 passed (61 subtests) |
| Contract snapshot | regenerated | `EnrollBlocker` without `WINDOW_ENDED`, `TrackingRejectReason` with `NOT_ACTIVE`; nothing else changed |

**Not run, and not claimed:** any test against a real tracking model (Gate 5, BLOCKED BY ENVIRONMENT); the
Playwright E2E suite (the frontend's; it owns ports 8700/5199 and `vms_e2e`).

## Open after this phase

1. **The real adapter** (Gate 3) and its validation (Gate 5): BLOCKED BY ENVIRONMENT; what they need is
   `visitor-tracking-integration.md` §9.
2. **The privacy owner's approval and the evaluation-based threshold** before any real use
   (`production-readiness.md` §15 J).
3. **Shared cameras across companies** (Gate 0 question 8): each company registers its own cameras today.
4. **The placeholder constants** (B15-16), with the cameras' analysis classes.
5. A provider-side **heartbeat cadence** is recommended (every minute) but not enforced.
