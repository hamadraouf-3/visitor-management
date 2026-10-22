# Phase 16 — backend decisions (live tracking, allowed areas and area alerts; provider still off)

Date: 2026-10-21. Scope: `backend/` (revisions `0019` and `0020`, models, repositories, services, routes, CLI, e-mail
template, tests), the regenerated `frontend/src/types/backend-contract.json` (no other frontend file),
`deploy/verify/test_api_instances.py` (B16-23), `docs/api.md`, `docs/visitor-journey-design.md`,
`docs/security.md`, `docs/visitor-tracking-integration.md`, `README.md` and this file. The phase's contract is
the lead's `phase16-contract.md`; the web application's half is `phase-16-frontend.md` (F16-n).

**The owner's request (2026-10-21).** "A page with the visitors, where each one is now and what their path
was. If a visitor is invited to floor 2 and goes up to floor 4, an alert must arrive." And: "a **complete**
tracking system; the only missing piece is connecting the model." This phase builds everything around the
model: each visit's allowed areas, area alerts (in the application and by e-mail), their handling, the live
view and a journey's path. **Phase 15's rules hold unchanged**: no fabricated location (an alert comes only
from the location the journey itself shows), no images or biometric templates, the simulator never in
production, `TRACKING_PROVIDER=disabled` in production, and no claim that live tracking works with a real
model (Gate 3 and Gate 5 stay BLOCKED BY ENVIRONMENT).

**Contract changes.** Revision `0019` (two tables, five columns on three tables, one CHECK widened; additive,
B16-21) and revision `0020` (one nullable column, `tracking_alerts.escalated_at`; additive, B16-26). Six operations: `GET /journeys/live`, `PUT /visits/{visit_id}/access-areas`, `GET /tracking/alerts`,
`GET /tracking/alerts/summary`, `POST /tracking/alerts/{alert_id}/acknowledge`, `.../resolve` (106 operations
on 86 paths in all). Response fields: `ZoneRef.access` (in every `JourneyLocation`), `Zone.access`,
`Department.floor`, `Visit.access_areas`, `VisitPermissions.can_edit_access_areas`, `TrackingSettings`'s three
alert fields, `JourneyListItem.alert`, `JourneyEvent.allowed`, `VisitJourney.access_areas`,
`.can_edit_access_areas`, `.alerts`, `.path`. Request fields: `ZoneCreate/ZoneUpdate.access`,
`DepartmentCreate/DepartmentUpdate.floor_id`, `VisitCreate/WalkInCreate.access_areas`,
`TrackingSettingsUpdate`'s three. One error code (`ALERT_RESOLVED`), one e-mail kind (`TRACKING_ALERT`), five
audit actions, two rate-limit policies (constants, B16-15, B16-25). The shapes are exactly those of contract §C; no
shape was changed. What the contract left open is answered below and was handed to the frontend in the
scratchpad's `phase16-api-shapes-changes.md` (clarifications only: error paths, the order of refusals, the
simulator's timing).

---

## Allowed areas

**B16-1 — A zone's access level: COMMON, STANDARD (default), RESTRICTED.** `zones.access` varchar(10) NOT NULL
DEFAULT 'STANDARD', CHECK `ck_zones_access_valid`. COMMON is open to every visitor (reception, lobby,
lifts) and never alerts; STANDARD is allowed to a visitor whose areas name its floor or the zone itself;
RESTRICTED only to a visitor whose zones name it (an allowed floor is not enough). `ZoneCreate.access` is
optional (STANDARD), `ZoneUpdate.access` may not be null (422 `required`); an unknown value is 422
`invalid_choice`. A change is audited `LOCATION_UPDATED` with `changed_fields: ["access"]`. Every zone of a
location answers its level (`ZoneRef.access`: the zone's level **now**, like its name, B15-8). **A change of
level takes effect at the visit's next confirmed observation** (the alerts are not re-evaluated across the
company at once: that would be a burst of e-mails for an administrator's edit). *Held by*
`tests/integration/test_access_areas.py::test_a_zone_s_access_level`.

**B16-2 — A visit's allowed areas: one table, an area a row, removed rows kept.** `visit_access_areas`: `id`,
`company_id`, `visit_id`, `floor_id` / `zone_id` (exactly one: CHECK `one_area`), `created_at`, `removed_at`.
Composite foreign keys to `visits`, `floors`, `zones` over `(company_id, …)` (B15-3). **One table with exactly
one of floor/zone** rather than two side tables: one query reads a visit's areas, one partial index per kind
keeps a live area unique (`uq_visit_access_areas_live_floor`, `…_live_zone`, `WHERE removed_at IS NULL`).
**The runtime role cannot delete** (revision 0006), so changing the areas marks the taken-away rows
`removed_at` and inserts the new ones (an area given back is a new row); the rows also keep the history of a
visit's areas. "Not set" = no live row. Read for every `Visit` answer in three queries whatever the page's
size (the live rows, their floors with buildings, their zones with floors and buildings), so the reception
lists (250 visits) cost three queries more. Answered floors by building name (case-insensitive), then level;
zones by floor level, then name; each with `is_active` (itself, its floor and its building active).
`PUT /visits/{visit_id}/access-areas` (`VisitAccessAreasInput`):
- **who**: SYSTEM_ADMIN or RECEPTIONIST (`TRACK_VISITS`), or the visit's **host** holding EMPLOYEE, for their
  own visit — the contract's "the visit's host"; a visit's creator who is not its host may not (the
  e-mail-booking case of B10-24). MANAGEMENT reads. `VisitPermissions.can_edit_access_areas` and
  `VisitJourney.can_edit_access_areas` say the same (`visit_rules.can_edit_access_areas`);
- **refusals, in this order**: 404 (another company's or unknown visit, and, as on every visit endpoint, a
  visit an EMPLOYEE-only caller neither hosts nor created) → 403 `FORBIDDEN` → 409 `VISIT_NOT_EDITABLE` (the
  existing code) unless SCHEDULED or CHECKED_IN (a SCHEDULED visit past its window is marked NO_SHOW first,
  under the lock) → 422 on `floor_ids` / `zone_ids`: `not_found` (unknown or another company's), 
  `location_archived` (the place, or its floor or building, archived), `duplicates` (**the existing code**,
  B10-18, not a new `duplicate`), `too_many_items` (`max` 50), `required`;
- **unchanged sets** (in any order): 200, nothing written, nothing audited; otherwise
  `VISIT_ACCESS_AREAS_CHANGED` (entity `visit`, `added_floor_ids`, `removed_floor_ids`, `added_zone_ids`,
  `removed_zone_ids`: IDs only, at most 50 each), then the visit's alert re-evaluated (B16-8);
- **locks**: `begin_visit_change` (the company row `FOR KEY SHARE`), the visit `FOR UPDATE`, its open
  association `FOR UPDATE`, then its alert (B16-7); the IDs are checked under the company row, which every
  change of the registry holds `FOR UPDATE`.
*Held by* `test_access_areas.py::test_who_changes_a_visit_s_areas`,
`::test_the_areas_change_while_scheduled_or_checked_in`,
`::test_a_change_is_audited_and_an_unchanged_set_writes_nothing`, `::test_every_visit_answer_carries_its_areas`,
`::test_the_areas_a_request_names_are_checked`, `tests/unit/test_area_rules.py::test_who_changes_a_visit_s_allowed_areas`.

**B16-3 — A department's floor, and a new visit's default areas.** `departments.floor_id` uuid NULL, composite
foreign key `fk_departments_floor` (company, floor). `DepartmentCreate/DepartmentUpdate.floor_id` (null
clears it): an active floor in an active building of the company, else 422 `floor_id` `not_found` /
`location_archived`; setting the same value again is no change. `Department.floor` answers it with its
building and `is_active`. **Archiving a floor a department names is not refused** (the contract's preference:
administrators are not blocked); the department keeps it (`is_active: false`) and new visits skip it. At
creation (an invitation, `POST /visits`, and a walk-in, `POST /reception/walk-ins`): the request's
`access_areas` when sent (an explicit `{"floor_ids": [], "zone_ids": []}` means "not set" and overrides the
default); omitted or null, **the floor of the visit's department** (the department the request names, else the
host's, exactly as the visit's own department is chosen, `visit_references.visit_department`) while that floor
is active, else nothing. Errors of `access_areas` are answered on `access_areas.floor_ids` /
`access_areas.zone_ids`. The initial areas are in the creation's audit row (`VISIT_CREATED` /
`WALK_IN_CREATED`: `access_floor_ids`, `access_zone_ids`), so no separate change row is written. Audited
department changes name `floor_id` in `changed_fields`. *Held by* `test_access_areas.py::test_a_department_s_floor`,
`::test_a_new_visit_gets_its_department_s_floor_unless_it_names_its_areas`, `::test_a_walk_in_gets_the_same_default`.

**B16-4 — The rule** (`tracking_rules.violation`, pure). For a confirmed location (building, floor, zone) and
a visit's areas: a COMMON zone, or a zone the visit's zones name → allowed; a RESTRICTED zone otherwise →
`RESTRICTED_AREA` (whether the areas are set or not); a STANDARD zone on one of the visit's floors → allowed;
otherwise → `UNAUTHORIZED_AREA` **only while the areas are set** ("not set" never alerts for a STANDARD zone).
The zone's access level is its level now; the floor is the event's (as resolved when it arrived, which is the
zone's: a zone never changes floor). *Held by* `tests/unit/test_area_rules.py::test_the_violation_table` (16
cases).

---

## Alerts

**B16-5 — The trigger: inside ingestion, from the journey's own computation.** The function that computes a
visit's state and last location was moved out of `JourneyService` into `journey_current.current_journeys`;
the list, a visit's journey, the live view **and the alerts** all call it, so an alert can never come from a
location the journey would not show. After an ingested batch stores at least one confirmed OBSERVED event
with a location for an ACTIVE association, each such visit is evaluated **in the batch's transaction**, only
when its journey is `ACTIVE` (fresh, confirmed, no conflict within 60 s, B15-30) **and** `last_location` is not
null **and** the latest confirmed observation is one this batch stored. Hence: an old event arriving late
never opens or resolves anything; a late sighting of an ended association never alerts (the journey is
ENDED, or the latest association is another); a null threshold confirms nothing and alerts nothing; an
unconfirmed, below-threshold or confidence-less observation alerts nothing; tracking off rejects the events
(`TRACKING_OFF`); a company with `area_alerts_enabled` false is not evaluated (its active alerts stay as they
are). **Found while testing `simulate-journey --cameras`:** the first version evaluated before writing the
batch's contact (`tracking_health.last_contact_at`), so a batch that ended more than 5 minutes of the
provider's silence read the journey as UNAVAILABLE and never alerted. The batch **is** the provider's contact:
it is now recorded before the evaluation, so the alert reads exactly the journey the API shows once the batch
commits. *Held by* `tests/integration/test_tracking_alerts.py` (`…another_floor_opens_an_alert…`,
`…nothing_unconfirmed_or_switched_off_alerts` ×6, `…two_floors_within_the_conflict_window…`,
`…a_late_old_event…`, `…a_late_sighting_of_an_ended_association…`, `…alerts_off_leaves_an_active_alert…`,
`…a_batch_after_the_provider_s_silence_is_its_contact_and_alerts`).

**B16-6 — One active alert per visit.** `tracking_alerts` (company, visit, association, `type`, `status`,
`simulated`, first and last building/floor/zone as resolved, `opened_at` and `last_seen_at` — the
`observed_at` of the first and the latest violating observation —, `observations`, `acknowledged_at/by`,
`resolved_at/by`, `resolution`, `note`, timestamps). Active = OPEN or ACKNOWLEDGED; the partial unique index
`uq_tracking_alerts_active_visit` is the database's half; the lock order (B16-7) is the engine's: two batches
for one visit serialise on the association, and the second moves the first's alert on. CHECKs tie status,
resolution, resolver and acknowledgement together (`resolved_status`, `resolution_set`,
`resolver_when_resolved`, `acknowledged_set`, `open_unacknowledged`, `acknowledger_when_acknowledged`),
`observations ≥ 1`, `last_seen_at ≥ opened_at`, a note not blank. **Its visit is its association's**: the
composite key `(company, association, visit)` → `tracking_associations`, not a key to `visits` (writing an
alert so takes no lock on the visit row; B16-7). *Held by*
`tests/integration/test_tracking_alert_races.py::test_two_batches_for_one_visit_never_make_two_active_alerts`
(real connections; the second batch is seen waiting for the first's lock),
`tests/integration/test_area_alerts_database_rules.py` (the index, the keys, the CHECKs).

**B16-7 — The lock order: a visit before its association, and its alert after it.** An ingested batch takes
the company row `FOR KEY SHARE`, the key, **the visits its refs name `FOR KEY SHARE` (ID order)**, its
associations `FOR UPDATE` (ID order), its contact's health row, then the alerts of those visits, then the
rejection counts. A check-out and a change of a visit's areas take the company row, the visit `FOR UPDATE`,
its association, then its alert. A receptionist's acknowledge or resolve takes the company row
(`lock_company_for_change`, `FOR KEY SHARE`, the caller re-checked, SEC-07) and the alert only. **Found in
review:** an alert's e-mail row (`email_messages`) refers to the visit, and its foreign key takes the visit
`FOR KEY SHARE`; with the batch taking that lock only when it wrote the e-mail (after its association), a
check-out that held the visit and then asked for the association deadlocked with it — PostgreSQL reported
`DeadlockDetected` in the regression test with the fix taken out. The batch now holds its visits first, so a
check-out and a batch meet at the visit, in the same order (this also removes the Phase 15 interleaving of
the bulk end-of-day check-out, which locks visits in ID order and their associations after, with a batch
naming two of them). Only the holder of an association's lock opens or moves its visit's alert, so a batch
waiting for an alert while holding the health row waits for nobody who needs that row. *Held by*
`test_tracking_alert_races.py::test_a_check_out_holding_the_visit_and_a_batch_that_e_mails_do_not_deadlock`,
`::test_a_batch_opening_an_alert_and_a_visit_change_do_not_deadlock[check-out|areas change]`, and Phase 15's
`test_tracking_races.py` unchanged.

**B16-8 — An alert's life.** For a violation and no active alert: OPEN (first and last location the current
one, first and last seen its `observed_at`, one observation), audited `TRACKING_ALERT_OPENED` without an
actor, e-mailed. For a violation and an active alert: its last location, `last_seen_at` and observations move
on (no audit row per observation); a `RESTRICTED_AREA` violation of an `UNAUTHORIZED_AREA` alert
**escalates** it (type RESTRICTED_AREA, OPEN again, its acknowledgement cleared, the note kept), audited
`TRACKING_ALERT_ESCALATED` (`from_type`) and e-mailed again. **An alert never backs down** (a RESTRICTED one
seen again in a non-allowed STANDARD zone stays RESTRICTED: the more serious fact stands until it is
resolved). No violation and an active alert: RESOLVED `RETURNED`, no actor. **Check-out** resolves the
active alert `CHECKED_OUT` in its transaction, after the association, by the checking-out user (every
check-out method, the bulk one included: `AttendanceService._record_check_out`): that user is the alert's
`resolved_by`, whose name the interface shows beside «خرج الزائر» / "Checked out" (F16-10). **A change of the areas**
(B16-2) re-evaluates the journey's current location when its state is ACTIVE (and area alerts are on):
RESOLVED `AREAS_CHANGED` by the editor when now allowed; when it now violates them, **opened** (or
escalated) by the editor (`trigger: AREAS_CHANGED`, e-mailed) **only when the editor is an administrator or
a receptionist** — a host's change never opens or escalates an alert, the next confirmed observation does
(amended in review, B16-25); a re-evaluation counts no observation. A revoke, an expiry, tracking
switched off or disallowed, and the company's deactivation leave the alert as it is. **After a manual
resolve, the next violating observation opens a new alert** (the visitor is still where they may not be).
*Held by* `test_tracking_alerts.py` (`…moves_on_and_returning_resolves_it`, `…escalates_the_alert…`,
`…only_restricted_zones_alert_and_common_zones_never`, `…a_listed_zone_is_allowed…`,
`…the_check_out_resolves…`, `…changing_the_areas_resolves_the_alert_or_opens_one`,
`…a_host_s_change_of_the_areas_resolves_but_never_raises_an_alert`,
`…an_areas_change_with_alerts_off_or_without_a_location…`, `…a_revoke_or_tracking_switched_off_leaves_the_alert`,
`…acknowledge_and_resolve_by_reception`).

**B16-9 — Reception and administrators act; management reads.** `GET /tracking/alerts` and
`/tracking/alerts/summary` (VIEW_JOURNEYS); `POST /tracking/alerts/{id}/acknowledge` and `/resolve`
(TRACK_VISITS). Acknowledge: OPEN → ACKNOWLEDGED (by, at, the note when given); an ACKNOWLEDGED alert is
answered unchanged (its note too: idempotent); a RESOLVED one → **409 `ALERT_RESOLVED`** (new code). Resolve:
→ RESOLVED `MANUAL` (by, at, the note when given; without one the latest note stays); a RESOLVED alert is
answered unchanged. The body (`TrackingAlertAction`) is optional; `note` is one line of at most 300 characters,
trimmed, blank = none (`too_long`, `line_breaks`, `bidi_controls`). Another company's or an unknown alert →
404. `TrackingAlert.can_act` = TRACK_VISITS and not RESOLVED. Audited `TRACKING_ALERT_ACKNOWLEDGED`
(`alert_id`, `noted`) and `TRACKING_ALERT_RESOLVED` (`alert_id`, `resolution`, `noted`; the actor, or none for
the system) — never the note's text. *Held by* `test_tracking_alerts.py::test_acknowledge_and_resolve_by_reception`,
`::test_unknown_and_other_companies_alerts_are_not_found`.

**B16-10 — A journey's areas, path, alerts and `allowed`.** `VisitJourney` adds `access_areas`,
`can_edit_access_areas`, `alerts` (the visit's latest 20, newest `opened_at` first) and `path`: the confirmed
OBSERVED events with a location of **the same latest 500 events as the timeline** (`TIMELINE_LIMIT`; a path
needs no second, unbounded read), oldest first, consecutive ones in the same zone collapsed into one stay
(`from`, `to`, `observations`), each with `allowed` under the visit's **current** areas. The path is history:
it lists what was confirmed, as the timeline marks it; the current location keeps B15-30's rule. Each
timeline event's `allowed` is the same judgement for a confirmed observation with a location, null for every
other event. *Held by* `test_tracking_alerts.py::test_a_journey_shows_its_areas_path_alerts_and_what_is_allowed`.

**B16-11 — The live view, the list and the summary.** `GET /journeys/live` (VIEW_JOURNEYS): every CHECKED_IN
visit of the company, **newest check-in first, at most `LIVE_VISITORS_LIMIT` = 1000** (`truncated` beyond; the
cap applies before the building filter, so a filtered answer may be shorter than the cap), each with its
state, simulated mark, last location, `last_observed_at`, `freshness_seconds` (the server's clock), active
alert and areas, computed in a fixed number of queries. `building_id` keeps the visitors located in that
building **and every visitor without a location**; a `building_id` that is not a building of the company →
422 `building_id` `not_found`. It ends expired associations first, like every read. **Audited like the list**:
`JOURNEY_LIST_VIEWED` with `view: "LIVE"` and `located`, in the same per-user hourly window (one action rather
than a new one: reading where people are is one kind of access, and the audit screen needs no new label).
`JourneyListItem.alert` is the visit's active alert. `GET /tracking/alerts`: `scope=active` (default: OPEN and
ACKNOWLEDGED, any day) or `scope=day` (opened during the company-local `day`, default today, any status);
`day` with another scope → 422 `day` `not_allowed`; `visit_id` not a visit of the company → 422 `visit_id`
`not_found`; newest `opened_at` first; paginated. `GET /tracking/alerts/summary`: `open`, `active` and the
latest five OPEN alerts (the newest opened or escalated first since B16-26, each brief naming its
`escalated_at`; `TrackingAlertBrief.location` is
the **latest** violating location), **all zeros
while the deployment has no provider or the company is not allowed tracking** (a company allowed but switched
off still sees its alerts). **The summary does not count as activity** when the shell sends
`X-Background-Refresh: 1`, the rule of the `/auth/me` heartbeat (`get_session_auth`), which needed no change.
**Neither the alerts list nor the summary is audited**: the summary is the shell's background poll (an hourly
row per open browser would record presence, not reading), and the alerts list shows only alerts, each of
which is audited when it opens; a journey opened from either is audited (`JOURNEY_VIEWED`). *Held by*
`test_tracking_alerts.py::test_the_live_view`, `::test_the_list_and_the_summary`,
`::test_the_summary_is_empty_while_tracking_is_not_allowed_or_there_is_no_provider`,
`::test_the_summary_poll_does_not_extend_the_session`.

**B16-12 — Simulated alerts.** `tracking_alerts.simulated` = the association was the simulator's; answered
`simulated` in `TrackingAlert`, `TrackingAlertBrief` and the live view; the e-mail's subject starts with
«[محاكاة] » / "[Simulated] " and its body says "Simulated data, not from a real tracking provider." in both
languages. *Held by* `tests/unit/test_tracking_alert_email.py::test_the_simulator_s_alert_says_so`,
`test_tracking_alerts.py::test_who_gets_the_e_mails_in_which_language_with_which_link`.

**B16-13 — The company's alert settings.** In `company_tracking_settings` (B15-2's side table):
`area_alerts_enabled` (default true), `alert_notify_host` (default true), `alert_emails` varchar(320)[]
(default empty, CHECK `cardinality ≤ 5`). `TrackingSettingsUpdate` takes the three (not null: 422
`required`); `alert_emails` is validated as the users' and visitors' addresses are (`EmailAddress`), stored
lower case, deduplicated in the order given (the order is the order the e-mails go out in, so another order
is another value); a bad address is answered **at `alert_emails.<index>`** with the existing code
`invalid_email` (the convention of every list item path: field codes carry fixed parameters, so no
`params.index`); more than five → `too_many_items`. A change is audited `TRACKING_SETTINGS_UPDATED` with the
changed field names only, never an address. A company without a settings row has the defaults. *Held by*
`test_access_areas.py::test_the_alert_settings`, `test_tracking_admin.py::test_settings_have_the_defaults…`.

**B16-14 — The alert e-mail.** `EmailKind.TRACKING_ALERT`; **product texts, not editable** (like the security
e-mails, B11-21: `email_template_overrides.kind` does not admit it). Sent on an **opening and an escalation
only**, queued in the transaction that opens or escalates the alert and delivered after its commit through the
existing dispatcher (contract §3.2-1): the ingestion route, the areas PUT and the CLI schedule what was
queued. Recipients: each of the company's `alert_emails` in the company's language, with **a link to the
visitor's journey** (`/journey/{visit_id}?c=<slug>`); with `alert_notify_host`, the visit's host while their
account is active, in their language (else the company's), with **a link to the visit's page**
(`/visits/{visit_id}?c=<slug>`), never to the journey (B15-13: a host who is only an employee cannot open it).
An address that is both (compared by `mailbox_key`, B14-21) gets the alert addresses' e-mail once. Content: the
visitor's name and company, the host, where (building › floor › zone in the reader's language, "(Restricted)"
beside a restricted zone), when (the company's time zone, with its label), the visit's allowed floors or «غير
محددة» / "Not set" (and the extra zones when there are any), "Please check on this visitor.", the button.
The subject is in the reader's language only (staff e-mails, B10-9): "Tracking alert: {visitor} is outside the
allowed areas" / "… is in a restricted area". **Never a pass link, a token, a tracking reference or a key.**
The company's identity as every company e-mail (B12-12); the yellow "attention" pill. The template
(`tracking_alert.html`/`.txt`) is an e-mail layout; no image of anyone is involved. *Held by*
`tests/unit/test_tracking_alert_email.py` (6), `test_tracking_alerts.py::test_who_gets_the_e_mails…` (the
host who is also an alert address gets the alert addresses' copy in the company's language, not their own),
`::test_an_alert_address_reads_the_company_s_language` (a company whose default is Arabic: the Arabic subject
and place), `::test_no_host_e_mail_when_the_company_says_so_and_none_for_an_inactive_host` (`alert_notify_host`
off; then on, with the host deactivated through `PATCH /users/{id}`: only the alert address, `notified` 1),
`::test_a_batch_that_fails_sends_nothing_and_opens_nothing` (sent only after the commit: a batch that fails
after queueing leaves no alert, no e-mail row and sends nothing). The three cases between the first and the
last were added in review (the inactive host's case had been named but not exercised).

**B16-15 — The alert e-mails' budget.** One policy, `tracking_alert_emails_per_company_day`:
**`TRACKING_ALERT_EMAILS_PER_COMPANY_DAY` = 500** per company and 24 hours, one slot per recipient. Every
company's e-mails leave through the one sending mailbox, so a noisy provider (or a misplaced camera) must not
use up the other companies' day. A **constant**, like `PASSWORD_NOTICES_PER_HOUR` (not a setting: no new
environment variable). Slots count once the transaction committed (`EmailQuota.unit`). Beyond it the alert
still opens or escalates and the e-mails that do not fit are left out; its audit row says so (`notified`,
`notice_limited_by`). The CLI's `simulate-journey` counts in its own process's limiter (development only).
**A visit's hourly budget of e-mailed openings and escalations was added in review (B16-25).** *Held by*
`test_tracking_alerts.py::test_the_company_s_daily_budget_of_alert_e_mails`,
`tests/unit/test_rate_limit.py` (its scope).

**B16-16 — Audit.** New actions, each filed on the visit (entity `visit`, so a visit's history shows them;
no new entity type), IDs and enums only: `VISIT_ACCESS_AREAS_CHANGED` (B16-2), `TRACKING_ALERT_OPENED` and
`TRACKING_ALERT_ESCALATED` (`alert_id`, `type`, `building_id`, `floor_id`, `zone_id`, `simulated`, `trigger`
OBSERVATION | AREAS_CHANGED, `notified`, `notice_limited_by` — `tracking_alert_emails_per_company_day` or,
since B16-25, `tracking_alert_notices_per_visit`; `from_type` for an escalation; the actor is none for an
observation, the editor — an administrator or a receptionist, B16-25 — for an areas change),
`TRACKING_ALERT_ACKNOWLEDGED`, `TRACKING_ALERT_RESOLVED` (B16-9). `JOURNEY_LIST_VIEWED` gains `view: "LIVE"` (B16-11). The interface needs a
label for each new action (the frontend's part).

**B16-17 — Retention.** `cli prune-journeys` (schema owner) now deletes, per company's `retention_days`:
**first the alerts last changed (`updated_at`) longer ago, whatever their status**, then the events, then
the ended associations that hold **no event and no alert** any more (so an association stays while a recent
alert refers to it). The alert's key to its association is **ON DELETE CASCADE** (every other key is
RESTRICT): revision 0018's `prune-journeys` knows nothing of the alerts, and a previous release running on
this schema must still delete an old association that an alert refers to (tested with 0018's statement
verbatim). The alerts keep no key to events (their locations are copied). A visit's allowed areas are part
of the visit and are not pruned. The command prints `tracking alerts deleted: n; …`. **Lock order (found in
review):** deleting the alerts before the associations was the reverse of a batch's order (its associations,
an ended one it names included — locked before such a ref is refused —, then its visits' alerts, B16-7): a
batch holding an old ended association and waiting for an old alert the prune had just deleted, while the
prune waited for that association, deadlocked. **The prune now first locks the ended associations past
retention `FOR UPDATE`, in ID order** (`_LOCK_ENDED_ASSOCIATIONS`, the batch's order), then deletes the
alerts, the events and those associations; it so waits for such a batch before it touches an alert, and
nothing waits for the prune while it holds what that batch needs. *Held by*
`test_area_alerts_database_rules.py::test_prune_journeys_deletes_old_alerts_first_and_keeps_an_association_a_recent_one_needs`,
`::test_the_previous_release_s_prune_still_works_once_alerts_exist`,
`::test_the_prune_locks_an_ended_association_before_deleting_its_alert` (real connections: a transaction takes
the batch's locks in its order while the prune runs; with the fix taken out PostgreSQL reported
`DeadlockDetected` "while deleting tuple … in relation tracking_associations"), Phase 15's
`test_tracking_cli.py::test_prune_journeys_keeps_each_company_s_retention`.

**B16-18 — Constants** (placeholders like B15-16's, named once):

| Constant | Value | Where | Why |
|---|---|---|---|
| Allowed floors / zones a visit may name | 50 each | `tracking_rules.ACCESS_AREAS_MAX` | far more than a building has; bounds a request and an audit row (the audit's list cap is 50) |
| A journey's alerts answered | the latest 20 | `VISIT_ALERTS_LIMIT` | a visit raises few; bounds the answer |
| Live view | 1000 visitors inside | `LIVE_VISITORS_LIMIT` | the contract's cap; computed in a fixed number of queries |
| Summary's latest | 5 OPEN alerts | `SUMMARY_LATEST_LIMIT` | the contract's |
| Alert addresses | 5 | `models.tracking.ALERT_EMAILS_MAX` | the contract's |
| Alert note | 300 characters, one line | `ALERT_NOTE_MAX_LENGTH` | the contract's |
| Alert e-mails | 500 per company / 24 h | `rate_limit.TRACKING_ALERT_EMAILS_PER_COMPANY_DAY` | B16-15 |
| E-mailed alert openings and escalations | 3 per visit / 1 h, whatever the recipients | `rate_limit.TRACKING_ALERT_NOTICES_PER_VISIT_HOUR` | B16-25; as many as an invitation's resends or a reschedule's notices per visit |
| Zone access default | STANDARD | `zones.access` | the contract's |
| Simulator walk interval | 120 s (as Phase 15) | `cli simulate-journey --interval-seconds` | more than the 60 s conflict window |

**B16-19 — The locations for every role; active only for hosts.** `GET /locations` is now readable by every
role of the company (`CurrentAuth`, like `GET /departments`): the invitation form offers the allowed areas. A
caller without `VIEW_JOURNEYS` (a host who is only an employee) gets **the active buildings, floors and zones
only** (archiving keeps a child under an active parent, so filtering each level is enough); nobody but
administrators and receptionists reads a camera (unchanged: `GET /tracking/cameras`). Writes stay
ADMINISTER. Phase 15's test that an employee got 403 now asserts 200. *Held by*
`test_access_areas.py::test_every_role_reads_the_locations_and_a_host_only_the_active_ones` (an archived
building, an archived zone and, added in review, a floor archived inside the active building: the host's
tree omits it, the administrator's, management's and reception's list it with `is_active: false`),
`test_tracking_admin.py::test_administrators_build_the_tree_and_every_journey_role_reads_it`.

**B16-20 — `simulate-journey --cameras CAM1,CAM2,…`** (non-production, `TRACKING_PROVIDER=simulator`, as
before). The provider camera IDs of the visit's company, walked **in the order given, one observation each,
the last one now**, `--interval-seconds` apart (default 120), squeezed after the association's creation when
it is younger than the walk (never before it, B15-22). `--steps` defaults to their number; another number is
refused; an ID that is not one of the company's cameras is refused (an archived camera is sent and the
ingestion answers `UNKNOWN_CAMERA`, as for a provider); an empty item is refused by the argument parser. **Two
cameras on different floors observed within 60 s of each other make the journey UNCERTAIN** (no location, so
no alert), exactly as a real provider's observations would: the simulator does not hide B15-30. For a freshly
enrolled visitor, walk floors in separate runs at least 61 s apart, or one camera per run; cameras of one
floor need no gap. The area alerts it raises are e-mailed by the command (`tracking alert e-mails: n (n
delivered)`) through the configured provider. *Held by* `tests/integration/test_simulate_cameras.py` (3), and
Phase 15's simulator tests unchanged.

---

## Schema, contract, tests

**B16-21 — Revision 0019: additive; the previous release keeps working.** `zones.access` (NOT NULL DEFAULT, so
the previous release's inserts get STANDARD), `departments.floor_id` (NULL) with its key, the three settings
columns (defaults), `ck_email_messages_kind_valid` admitting `TRACKING_ALERT`, and the two new tables with
their indexes (`uq_visit_access_areas_live_floor/zone`, `ix_visit_access_areas_live_visit`;
`uq_tracking_alerts_active_visit`, `ix_tracking_alerts_company_status`, `…_company_opened`, `…_visit`,
`…_association`, `…_company_updated`). The CHECKs and the key added to existing tables are added NOT VALID
and validated (B14-23); `lock_timeout` 5 s. The runtime role gets SELECT, INSERT, UPDATE on the new tables
from the default privileges (24 tables in all) and deletes nothing. Downgrade locks what it reads (SEC-39) and
refuses while an alert, an area, a non-STANDARD zone, a department with a floor, alert settings other than the
defaults or an alert e-mail exists; restore the pre-upgrade backup instead. Every 0018 column, constraint and
index is identical after the upgrade except the widened kinds CHECK (PostgreSQL 18 also lists the new NOT NULL
columns' constraints, `…_not_null`). *Held by*
`test_area_alerts_database_rules.py::test_revision_0019_only_adds_and_goes_back_cleanly`,
`::test_the_0019_downgrade_refuses_to_lose_what_was_entered` (×4), `test_migrations.py` (models match, round
trip from base), `test_database_rules.py::test_runtime_role_privileges_match_contract`.

**B16-22 — The contract snapshot; no new dependency.** `app/contract.py` publishes responses `TrackingAlert`,
`TrackingAlertSummary`, `LiveJourneys`; requests `VisitAccessAreasInput`, `TrackingAlertAction`; queries
`TrackingAlertListParams`, `LiveJourneyParams` (both in `QUERY_ROUTES`); envelope `TrackingAlertPage`; the
nested models in `$defs`; `ALERT_RESOLVED` in `error_codes`. `frontend/src/types/backend-contract.json` is
regenerated. Nothing new is installed: the standard library, SQLAlchemy, Pydantic, Jinja and FastAPI already
in use.

**B16-23 — `deploy/verify/test_api_instances.py` (outside this agent's listed files).** Its route tables pin
the backend's routes: every route under `/api/v1/tracking/` must be listed as main-only, and it asserted that
the brand upload was the API's only PUT. The four alert routes were added to `MAIN_ONLY_ROUTES` (they stay on
the main instance like every `/tracking/` route), and `PUT /api/v1/visits/{visit_id}/access-areas` to a new
`OTHER_PUTS` (a small JSON body under the default limit, outside the upload's location, whose paths no other
route matches: nginx counts no upload place for it). No nginx file changed. Done to keep the deploy gate green;
reported to the lead.

**B16-24 — Existing tests updated** (what a client may have relied on): the Phase 15 test that an employee
gets 403 on `GET /locations` (B16-19); the exact `TrackingSettings` defaults (three fields); the exact
`VisitPermissions` of two tests (`can_edit_access_areas`); the exact keys of `Department` (`floor`); the head
revision pins `"0018"` → `"0019"` of three database-rule files and 0018's own migration tests (upgrade to
`0018`, not `head`); the runtime grants (24 tables); `test_body_limit.py`'s list of PUT routes;
`test_service_helpers.py`'s repository list; `test_rate_limit.py`'s scopes; `test_contract_snapshot.py`'s
envelopes; `test_schemas.py`'s `Department` samples. `JourneyEventRepository.add` answers the stored event's ID
(None for a duplicate) instead of a boolean.

---

## Review fixes

**B16-25 — A host's change of the areas never raises an alert; a visit's hourly budget of alert e-mails
(found in review).** The first build let any editor's change of a visit's areas open an alert when the
current location now violated them (B16-8). A host (an EMPLOYEE editing their own visit, B16-2) could so
toggle `PUT /visits/{id}/access-areas` again and again: each change that made the visitor's current place a
violation opened an alert and e-mailed every alert address and the host, with no cooldown. The company's
500 alert e-mails a day (B16-15) could be drained, and the host learned the visitor's exact zone on demand
(the e-mail names it; a host who is only an employee may not read journeys, B15-13). Now:
- **Only an editor who tracks visits** (`TRACK_VISITS`: SYSTEM_ADMIN, RECEPTIONIST) **opens or escalates an
  alert by changing the areas** (`TrackingAlerts.after_areas_change(raises=…)`, from
  `VisitsService.set_access_areas`). A host's change still **resolves** the active alert when the current
  location is now allowed (`AREAS_CHANGED`, by the host, as specified; the answer, a `Visit`, says nothing of
  the alert, and a resolution sends no e-mail). When it now violates them the alert stays as it is (absent, or
  not escalated), and **the next confirmed observation opens or escalates it** (by the system, `trigger:
  OBSERVATION`), as after a change of a zone's level (B16-1); a host cannot cause an observation. The host's
  change is audited `VISIT_ACCESS_AREAS_CHANGED` as before.
- **A visit's hourly budget:** policy `tracking_alert_notices_per_visit`,
  **`TRACKING_ALERT_NOTICES_PER_VISIT_HOUR` = 3** e-mailed openings or escalations per visit and hour,
  whatever their number of recipients (a constant like B16-15's; the per-visit pattern of
  `reschedule_notices_per_visit`, D-22; keyed by the visit: bounded). A notice's slot is reserved **with its
  first recipient's company slot, both or neither** (`QuotaUnit.tracking_alert_notice`); its other recipients
  take a company slot each, and those that do not fit are left out (B16-15 unchanged). Beyond the visit's
  budget the alert still opens or escalates, **nothing of that notice is queued** (no e-mail row), and its
  audit row says `notified: 0`, `notice_limited_by: "tracking_alert_notices_per_visit"`. It bounds an
  administrator's or a receptionist's repeated changes and a visitor walking in and out of a forbidden zone
  (each return resolves, each entry opens). Counted once the transaction committed (`EmailQuota.unit`); a
  notice without a recipient takes no slot; the CLI simulator counts in its own process (B16-15).
- **No API shape changed.** The audit screen meets a new `notice_limited_by` value: the frontend's catalog
  (`admin.json`, both languages; `auditVocabulary.test.ts` reads `PolicyName` from this source) needs a label
  for `tracking_alert_notices_per_visit`. No frontend file was touched by this fix (the E2E suite was running
  against the tree); it was handed to the lead.
*Held by* `test_tracking_alerts.py::test_a_host_s_change_of_the_areas_resolves_but_never_raises_an_alert` (the
host's change does not escalate an alert after its zone became RESTRICTED, resolves it when the zone is
allowed, opens nothing over three more toggles and e-mails nobody; the next observation opens it, by the
system), `::test_a_visit_s_hourly_budget_of_alert_notices` (3, 3, 3 then 0 e-mails with the visit's policy
named, the fourth alert opened all the same; the company slot the fourth did not take goes to the fifth
opening an hour later), `::test_changing_the_areas_resolves_the_alert_or_opens_one` (a receptionist's change
opens), `tests/unit/test_rate_limit.py` (the new policy's scope). Each failed with the fix taken out (the code
before the fix loaded in the test process only).

**B16-26 — The summary names an escalation among the newest: `tracking_alerts.escalated_at` (revision 0020;
the frontend's open item of F16-38).** `latest` of `GET /tracking/alerts/summary` (the five newest OPEN alerts,
B16-11) was ordered by `opened_at`, the first violating observation's time, which an escalation keeps (B16-8).
With five or more newer alerts open, an escalated alert (RESTRICTED_AREA, OPEN again, e-mailed again) never
entered the five, so the shell's watcher never showed its toast or rang; the e-mail, the count and the title
did change. Now:
- **Revision 0020** adds `tracking_alerts.escalated_at` timestamptz NULL; revision 0019 is not edited (local
  databases already ran it). Additive: nullable without a default (no table rewritten); every other column,
  constraint and index unchanged; the runtime role's table-level SELECT, INSERT and UPDATE cover the column,
  so nothing is granted. The previous release (0019's code) runs unchanged on it: it never names the column,
  and an alert it escalates keeps NULL and sorts by `opened_at`, as in that release. The upgrade reads the
  alerts escalated before it back from the audit log (the `TRACKING_ALERT_ESCALATED` row whose `alert_id`
  names the alert, of the companies that hold alerts, through `ix_audit_logs_company_id_action_seq`). The
  downgrade drops the column without a guard: 0019's code does not read it, only the order depended on it,
  and the escalations stay in the audit log, from which an upgrade reads them back again. `lock_timeout` 5 s
  (B14-23).
- **Set on an escalation only** (`TrackingAlerts._evaluate`), to the server's time of the escalation (the
  batch's or the areas change's `now`, like `acknowledged_at` and `resolved_at`). An opening leaves it NULL;
  an alert escalates once at most (it never backs down), so a later observation leaves it. The server's time,
  not the escalating observation's `observed_at`: an escalation by a change of the areas (B16-8) judges an
  observation that may be minutes old, and what the summary orders by is when the alert became news.
- **`latest_open` orders by `coalesce(escalated_at, opened_at)` desc, then `id` desc.** The two clocks meet
  here (the server's escalation, the provider's observation): an observation may be stamped up to
  `CLOCK_SKEW_TOLERANCE` (2 min) after the server's time, so an alert opened just after an escalation may
  sort before it; both are among the newest either way.
- **No new index.** The summary reads the company's OPEN alerts through `ix_tracking_alerts_company_status`
  (at most one per checked-in visit, B16-6) and sorts those few, as it sorted them by `opened_at`.
- **The order itself changed no API shape.** `TrackingAlertBrief` kept its fields (its `opened_at` is still
  the opening's); the contract snapshot was byte-identical after regeneration. The alerts list and a
  journey's alerts keep newest `opened_at` first.
- **Then one additive field, the order's key on the answer (the lead's call on the item below; nothing is
  deployed yet).** `escalated_at: UTCDatetime | None` on `TrackingAlertBrief` and, for consistency, on
  `TrackingAlert` (the alerts list, a journey's alerts, the acknowledge and resolve answers), read from the
  column: null until the alert escalates (also on an alert opened as RESTRICTED_AREA), then the escalation's
  server time, unchanged after. The summary's order is unchanged. The regenerated snapshot differs from one
  rendered without the field (the field taken out in memory, the tree untouched) by exactly these two
  properties and their `required` entries.
- **What the shell's watcher could not tell — resolved by that field (F16-38).** Its cut-off was the first
  answer's last brief's `opened_at`, taken as the oldest order key of the five. (1) When that brief was an
  escalation, its order key is its escalation, later than its `opened_at`: an alert left out of the first
  five whose opening fell between the two, moving up later, was told as new. (2) An alert left out of the
  first five (older than the cut-off, never seen) that escalated during the session came first but was taken
  in silently, never having been seen as UNAUTHORIZED_AREA. The watcher now takes its cut-off and compares
  with the brief's `escalated_at ?? opened_at`, the key the summary sorts by: (1) is taken in silently, (2)
  is told.
- The head revision pins `"0019"` → `"0020"` of four database-rule files (`test_brand_…`, `test_calendar_…`,
  `test_platform_…`, `test_tracking_database_rules.py`) and of the 0019 refusal test.
*Held by* `test_tracking_alerts.py::test_an_escalation_comes_first_in_the_summary_whatever_its_opening` (six
open; the five newest openings named; the oldest escalates and comes first, the four newest openings after
it, its brief's `opened_at` still its opening's; every brief's `escalated_at` null before, the escalated
brief's equal to the column after, the others' null), `::test_a_restricted_zone_escalates_the_alert_and_e_mails_again`
(NULL at the opening, the batch's time at the escalation, unchanged by a later observation; the same on the
summary's brief and the alerts list at each step, and on the acknowledge answer and the journey's alert),
`::test_the_list_and_the_summary` (`escalated_at` null on an alert opened as RESTRICTED_AREA, in the summary
and the list),
`test_area_alerts_database_rules.py::test_revision_0020_only_adds_escalated_at_and_goes_back_cleanly` (one
nullable column without a default, nothing else changed, the runtime role's column privileges, down and up
again identical), `::test_revision_0020_reads_an_earlier_escalation_back_from_the_audit_log` (another action's
row and another company's escalation name nothing), the prune tests on an escalated alert
(`::test_the_previous_release_s_prune_still_works_once_alerts_exist`,
`::test_prune_journeys_deletes_old_alerts_first_and_keeps_an_association_a_recent_one_needs`), and
`test_migrations.py` (models match, round trip from base). The new summary test failed with the code before
the fix loaded in the test process only: with the old order, the oldest alert's escalation was not named
(the five newest openings came back); with `escalated_at` never set, the alert had none. No other code copies
an alert's columns (the prune deletes by `updated_at`; the answers name each field).

---

## Verification (2026-10-21)

Commands (from `backend/`, `backend\.venv\Scripts\python.exe`, PostgreSQL 18 on 5433, throwaway databases
created and dropped by the test harness; the `vms` database and the root `.env` untouched, ports 8000 and 5173
unused):

| Gate | Command | Result |
|---|---|---|
| Full test suite (final tree) | `python -m pytest -q -rfE` | **5,086 passed, 1 failed, 12 skipped** (5,099 collected; 15 min 29 s, 10:24–10:40 UTC). The one failure is the pre-existing timing bound `tests/integration/test_access_log.py::test_the_response_time_excludes_background_work` (755 ms against 500 ms); see below |
| Full test suite (first run) | the same, started before the last two tests were added | 5,085 passed, the same 1 failed (607 ms), 12 skipped |
| Phase 16 tests | `tests/unit/test_area_rules.py`, `tests/unit/test_tracking_alert_email.py`, `tests/integration/test_tracking_alerts.py`, `test_access_areas.py`, `test_tracking_alert_races.py`, `test_area_alerts_database_rules.py`, `test_simulate_cameras.py` | **106**, all passed in the full run (33 + 6 + 32 + 11 + 4 + 17 + 3) |
| Lint | `python -m ruff check app alembic tests`; `python -m ruff format --check app alembic tests` | all checks passed; 359 files already formatted |
| Types | `python -m mypy` (as configured) | no issues in 182 source files |
| Deploy checks | `python -m pytest ../deploy/verify -q`; `python -m unittest discover -s deploy/verify -p "test_*.py"` (repository root) | **46 passed** (65 subtests); unittest: 46 tests OK |
| Release tree, nginx headers | `python deploy/verify/check_release_tree.py`; `node deploy/verify/check_nginx_headers.mjs` | OK, 1,256 files; 7 headers in sync |
| Contract snapshot | `python -m app.contract --out ../frontend/src/types/backend-contract.json`; `tests/unit/test_contract_snapshot.py` | regenerated, byte-identical on the last regeneration; passed |
| Operations | `app.openapi()` | 106 operations on 86 paths |

**After the review fixes** (B16-25, the B16-17 lock order, the e-mail and location test gaps; 11:32–11:38 UTC;
a targeted run, the full suite being the lead's while another agent runs the E2E suite on this machine):

| Gate | Command | Result |
|---|---|---|
| Phase 15/16 selection | `python -m pytest -q -p no:cacheprovider` on the 31 files under `tests/` whose names contain tracking, journey, access_area, area_rules, location, department, visit, attendance, reception or maintenance | **743 passed** (5 min 41 s) |
| Also changed | `tests/unit/test_rate_limit.py`, `tests/integration/test_area_alerts_database_rules.py` | **56 passed** |
| Regression proof | each new or extended test run against the code without its fix (loaded in the test process only, the tree untouched) | each failed: the host's change escalated and opened; the fourth notice sent 1 e-mail; the deactivated host was e-mailed; a company-language address got English, a user-preference variant Arabic; the employee saw the archived floor; the prune deadlocked (`DeadlockDetected`) |
| Lint, types | `ruff check app alembic tests`; `ruff format --check app alembic tests`; `mypy` | all checks passed; 359 files already formatted; no issues in 182 source files |

**After B16-26** (revision 0020; 15:15–15:20 UTC; a targeted run):

| Gate | Command | Result |
|---|---|---|
| Phase 16 selection | `python -m pytest -q -p no:cacheprovider` on the 17 files under `tests/` whose names contain tracking, journey, alert, access_area, area, migration, model, schema or maintenance | **412 passed** (2 min 53 s) |
| Also changed | `test_brand_database_rules.py`, `test_calendar_database_rules.py`, `test_platform_database_rules.py` (head pins), `test_database_rules.py` (grants), `tests/unit/test_contract_snapshot.py` | **182 passed** |
| Regression proof | the new summary test with the code before the fix loaded in the test process only (a pytest plugin, the tree untouched) | failed both ways: the old order (the oldest alert's escalation not named), `escalated_at` never set |
| Lint, types | `ruff check app alembic tests`; `ruff format --check app alembic tests`; `mypy` | all checks passed; 360 files already formatted; no issues in 182 source files |
| Contract snapshot | `python -m app.contract --out ../frontend/src/types/backend-contract.json` | byte-identical (the same SHA-256, the same `git diff --stat` before and after) |
| `vms_e2e` | `alembic upgrade head` with the E2E suite's database settings | 0019 → 0020; its one escalated alert read back from the audit log (equal to its audit row's time) |

**After the brief's `escalated_at`** (B16-26's additive field; 15:27–15:30 UTC; a targeted run):

| Gate | Command | Result |
|---|---|---|
| Selection | `python -m pytest -q -p no:cacheprovider -rfE` on the 14 files under `tests/` whose names contain tracking, journey, alert or contract | **220 passed** (1 min 54 s) |
| Lint, types | `ruff check app alembic tests`; `ruff format --check app alembic tests`; `mypy` | all checks passed; 360 files already formatted; no issues in 182 source files |
| Contract snapshot | `python -m app.contract --out ../frontend/src/types/backend-contract.json`, then diffed against a rendering with the field taken out in memory | only `escalated_at` on `TrackingAlert` and `TrackingAlertBrief` (the property and its `required` entry, each) |

**The timing test** (pre-existing, not this phase; B15's verification met it too): it bounds a trivial
response at half the background task's sleep (500 ms). On this machine (CPU at 100 %; the lead's demo
`vite` dev server alone uses about 0.8 of a core continuously) it fails **run alone, on the current tree
(5 of 5: 1,544–1,723 ms) and on an exported copy of HEAD, the Phase 15 code (5 of 5: 660–1,743 ms)**, against
the same cluster. With the copy's background sleep raised to 4 s the same test passes 3 of 3 (the response
under 2 s, the access line before the background work's), so the measured time is the loaded machine's
response time, not background work leaking into it. No Phase 16 change touches the middleware or the access
log.

**Not run, and not claimed:** any test against a real tracking model (Gate 5, BLOCKED BY ENVIRONMENT); the
Playwright E2E suite (the frontend agent's).

## Open after this phase

1. **The real adapter** (Gate 3) and its validation (Gate 5): BLOCKED BY ENVIRONMENT, as before. Nothing in
   this phase changes the provider's contract (`visitor-tracking-integration.md` §6 gains a note on what the
   application does with confirmed locations).
2. **The privacy owner's approval** now also covers the alert e-mails (a visitor's location sent to the host
   and to configured addresses, `security.md` §14) before any real use.
3. A change of a zone's access level is not re-evaluated across the visits inside at once (B16-1); nor is a
   host's change of the areas that makes the current place a violation (B16-25): the next confirmed
   observation raises the alert.
4. The CLI simulator's e-mail budget is its own process's (B16-15); production never runs it.
5. The audit screen's label for `notice_limited_by: tracking_alert_notices_per_visit` (B16-25, both
   languages) is the frontend's.
6. ~~The shell watcher's cut-off and the summary's new order (B16-26)~~ **Resolved**: the brief (and the
   alert) carry `escalated_at`, and the watcher's cut-off compares with `escalated_at ?? opened_at`, the
   summary's order key (B16-26, F16-38).
7. Revision 0020 on the `vms` database is the lead's (`alembic upgrade head`); `vms_e2e` was upgraded
   (0019 → 0020, its one escalated alert read back from the audit log), and the E2E global setup runs
   `alembic upgrade head` on a fresh schema at every run anyway.
