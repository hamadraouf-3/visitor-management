# Visitor Journey: design

Phase 15. Date: 2026-10-20. Backend: [`decisions/phase-15-backend.md`](decisions/phase-15-backend.md)
(B15-n). The provider-facing contract: [`visitor-tracking-integration.md`](visitor-tracking-integration.md).
Gate 0: [`visitor-tracking-model-assessment.md`](visitor-tracking-model-assessment.md).

## 1. What this is, and what it is not

**The request.** A "Visitor Journey" tab: an existing multi-camera person re-identification (Re-ID) model
would infer the floor or zone of a checked-in visitor; the application would show the last observed floor
or zone, its time, the tracking state and a timeline. Floor and zone only, never coordinates.

**Gate 0 found no such model.** No model, code, interface or documentation was available; the only
documents (the "Shaheen" hardware plans) describe per-camera analytics, not cross-camera Re-ID. The
owner decided on 2026-10-20 to build the **provider-neutral part now, with the provider off**:

| Built (Phase 15) | Not built |
|---|---|
| The location registry: buildings, floors, zones, cameras | A model adapter (Gate 3: **BLOCKED BY ENVIRONMENT**) |
| A random per-visit tracking association and its lifecycle | Image capture, image or template storage, face recognition |
| The authenticated, idempotent, tenant-checked ingestion contract | Real validation on site footage (Gate 5: **BLOCKED BY ENVIRONMENT**) |
| The journey state, computed on the server | Any claim that live tracking works |
| The read, configuration and action API; the platform owner's switch | |
| A development-only simulator, always marked Simulated | |

**Off by default everywhere.** `TRACKING_PROVIDER=disabled` is the default and production's value;
`simulator` is for development and E2E only, and production refuses to start with it. While disabled:
enrollment is refused (409 `TRACKING_NOT_AVAILABLE`, reason `PROVIDER_DISABLED`), the ingestion endpoint
answers 404 as if absent (for every method, B15-38), and every journey shows DISABLED. The registry stays editable, so a company's
administrator can prepare buildings, floors, zones and cameras.

## 2. Architecture

```
            ┌──────────────────────────── Mawdoo3 Visitors API (one main process) ─────────────────────────────┐
 reception  │  POST /visits/{id}/tracking/enroll ──► JourneyService.enroll ──(commit PENDING)──► provider.enroll │──► provider
 desk       │  POST /visits/{id}/check-out ─────────► AttendanceService ── ends the association in the same   │    (binding
            │                                         transaction ──(commit)──► provider.revoke(ref)           │◄── request,
            │  GET /journeys, GET /visits/{id}/journey ► JourneyService (expiry sweep, state, access audit)      │    no image)
 provider ──┼─► POST /tracking/events (Bearer key) ──► TrackingIngestion (per-event outcomes, health counts)     │
            │  simulator (development only) ─────────► the same TrackingIngestion, model_version "simulator"    │
            └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Module | Role |
|---|---|
| `app/models/tracking.py`, revision `0018` | The tables (§3) |
| `app/services/tracking_rules.py` | Pure rules: the state machine and its constants, refs, keys, expiry |
| `app/services/tracking_provider.py` | The typed `TrackingProvider` protocol (`enroll`, `revoke`, `health`), `DisabledProvider`, `SimulatorProvider` |
| `app/services/tracking_lifecycle.py` | Ending associations (check-out, revoke, expiry, switch-offs); provider calls after the commit |
| `app/services/tracking_ingestion.py` | Key authentication, per-event resolution, health |
| `app/services/journeys.py` | The list, a visit's journey, enroll and revoke |
| `app/services/tracking_settings.py`, `locations.py` | Settings, status, keys, cameras; the registry |
| `app/services/tracking_maintenance.py` | `cli prune-journeys`, `cli simulate-journey` |

The provider is part of the application's one `ServiceEnvironment` (`tracking`), built from
`TRACKING_PROVIDER` by `create_app`. The existing visit state machine is not replaced: the check-out code
path (QR, manual, corrected and the bulk end-of-day check-out) ends the association in its own transaction,
and nothing else about a visit changes.

**Provider calls after the commit.** `enroll` and `revoke` are made once the application's change is
committed, so no database lock is held while the provider answers (B15-18). A request the provider does not
take ends the association (`ENROLLMENT_FAILED`) and is counted; a failed revoke is counted and changes
nothing (the association stays ended, and its later events are rejected). Counting is bookkeeping: if it
fails too, it is logged by the error's class and the committed change stands (B15-37).

**Lock order: the company row first, always** (B15-18, corrected after the independent review, B15-29). A
visit change takes it `FOR KEY SHARE`, then the visit, then its association; a company-wide change (tracking
switched off, a key revoked, the platform owner's switch, a deactivation) takes it `FOR UPDATE`, then the
settings or key row, then the open associations in ID order; an ingested batch takes it `FOR KEY SHARE`,
checks its key again under it, then locks the associations it names in ID order and writes the health rows
last.

## 3. Data model (revision 0018, additive)

Every row carries `company_id`, and every reference within a company is a composite foreign key over
`(company_id, …)`: a child can never point at another company's parent (B15-3). Revision 0018 only adds
tables; the previous release runs unchanged on it (tested: every table, column, constraint and index of
0017 is identical after the upgrade).

| Table | Columns (beyond `id`, `company_id`, timestamps) | Rules |
|---|---|---|
| `buildings` | `name`, `name_ar`, `is_active` | name unique per company (case-insensitive) |
| `floors` | `building_id`, `name`, `name_ar`, `level` (−20…200), `is_active` | `(building_id, level)` unique |
| `zones` | `floor_id`, `name`, `name_ar`, `is_active` | name unique per floor (case-insensitive) |
| `tracking_cameras` | `provider_camera_id` (≤ 128 visible ASCII), `name`, `zone_id` (required), `is_enrollment_point`, `is_active` | provider ID unique per company; **no credential, URL, IP or stream address** |
| `tracking_associations` | `visit_id`, `ref`, `provider`, `enrollment_camera_id`, `status` (PENDING, ACTIVE, ENDED), `created_by_id`, `activated_at`, `ended_at`, `ended_reason`, `expires_at` | one PENDING/ACTIVE per visit (partial unique index); `ref` matches `trk_[a-z2-7]{32}` and is unique; CHECKs tie status, `ended_at` and `ended_reason` together |
| `visitor_journey_events` | `visit_id`, `association_id`, `provider`, `provider_event_id`, `type` (ENROLLED, OBSERVED, LOST), `camera_id`, `building_id`, `floor_id`, `zone_id` (as resolved at ingest), `observed_at`, `received_at`, `match`, `confidence` (0–1 or null), `model_version` | **append-only**: the runtime role has no UPDATE (and no DELETE, like every table) and a trigger refuses any UPDATE; `(company_id, provider, provider_event_id)` unique; the event's visit is its association's, its floor is in its building, its zone on its floor (composite keys); no payload column |
| `tracking_keys` | `label`, `prefix`, `key_hash` (SHA-256), `slot` (1 or 2), `created_by_id`, `last_used_at`, `revoked_at`, `revoked_by_id` | at most two unrevoked per company (partial unique index on the slot) |
| `company_tracking_settings` | `allowed`, `enabled`, `min_confidence`, `stale_after_minutes` (1–240, default 15), `retention_days` (1–90, default 30) | `enabled` only when `allowed`; a side table, so `companies` is not altered (B15-2); no row = the defaults |
| `tracking_health` | `last_contact_at`, `last_accepted_event_at` | one row per company |
| `tracking_health_counts` | `reason`, `slot` (0–23), `hour_start`, `count` | a ring of 24 hourly slots per company and reason, reused in place: bounded, never deleted by the runtime role |

Indexes: events by `(company, visit, observed_at)`, by `(company, camera, observed_at)` and by
`(company, observed_at)` (retention); associations open per visit (unique), open per company by expiry,
by `(company, visit, created_at)`, ended by `(company, ended_at)`; refs unique.

Nothing in the schema can hold an image, a crop, an embedding, a template or a provider payload.

## 4. The association's lifecycle and the journey state

### 4.1 Enrollment (receptionists and administrators)

Allowed only when all hold: the provider is not `disabled`; the company has tracking **allowed** (platform
owner) and **enabled** (its administrator); the visit is CHECKED_IN, whatever its schedule says (a late
OVERRIDE check-in or an overstay is still inside the building; B15-34, after the independent review: the
first version refused a visit whose pass window had ended, `WINDOW_ENDED`, which no longer exists); no
PENDING/ACTIVE association exists; the camera is an **active enrollment point** of the company. It creates
a PENDING association, commits, then asks the provider `enroll(ref, provider_camera_id, at)`. A retry
returns the existing association, never a second one. The simulator answers at once with an ENROLLED
event through the ingestion service, so the answer already shows ACTIVE.

### 4.2 The end

| Ends at | Reason | Notes |
|---|---|---|
| Check-out (any method, the bulk one included) | `CHECKED_OUT` | in the check-out's transaction; at the check-out time (never before the association's creation). If the association had already expired by then and nothing swept it: `EXPIRED` at `expires_at` (B15-35) |
| Explicit revoke; tracking switched off; disallowed by the platform owner; the company deactivated | `REVOKED` | audited per association with its trigger |
| `expires_at` passed | `EXPIRED` | checked on every read and ingest (not by a job); at `expires_at` |
| The provider's `ENROLLMENT_FAILED`, or an enroll request it did not take | `ENROLLMENT_FAILED` | reception may enroll again (a new association, a new ref) |
| Cancellation of the visit | `VISIT_CANCELLED` | reserved: a checked-in visit cannot be cancelled, so it never happens today |

**Expiry rule (B15-15, replaced after the independent review by B15-34):** a PENDING association expires
**10 minutes** after its creation if the provider has not activated it (`PENDING_TIMEOUT`), so a lost
ENROLLED (the enrollment camera archived meanwhile, the provider restarted) never blocks the visit: reception
can start again at once. Once ACTIVE it expires **12 hours after its activation** (`ASSOCIATION_MAX_LIFETIME`);
the check-out, the bulk end-of-day check-out, a revoke and the switches end it sooner. The visit's schedule
plays no part (the first version used `min(window_end, enrollment + 12 h)` and refused enrollment after the
window). An association never becomes active again; a late sighting observed before the end of an
association the provider **had activated** is appended to history without changing anything; one observed
after the end, or of an association that never activated (it ended PENDING or `ENROLLMENT_FAILED`), is
rejected (B15-28).

### 4.3 The state

Computed on the server at every read, one value per visit, from its latest association and that
association's events:

| State | When |
|---|---|
| `DISABLED` | the provider is `disabled`, or the company has tracking not allowed or not enabled |
| `NOT_ENROLLED` | no association |
| `PENDING` | the association is PENDING |
| `ENDED` | the association ended, or its expiry has passed |
| `UNAVAILABLE` | ACTIVE, and no provider contact for more than **5 min** |
| `STALE` | ACTIVE, and the latest sighting is a LOST, or nothing has been confirmed for more than `stale_after_minutes`: since the latest confirmed observation's `observed_at`, or, while there is none yet, since the association's `activated_at` |
| `UNCERTAIN` | ACTIVE, and the latest observation is fresh (within `stale_after_minutes`) but not confirmed (UNCERTAIN, a confidence below the threshold, no confidence, or a null threshold), or a confirmed observation within **60 s** of the latest confirmed one names another floor (a **conflict**) |
| `ACTIVE` | otherwise: the latest confirmed observation (or, before the first, the activation) is fresh and nothing contradicts it. **A freshly activated association with no observation yet is ACTIVE**, with no location ("Unknown") |

The checks run in the table's order from UNAVAILABLE down: a LOST, then a fresh unconfirmed or contested
latest observation (UNCERTAIN), then the freshness anchor (STALE), else ACTIVE. So right after enrollment
the journey is ACTIVE and "Unknown", and turns STALE only if `stale_after_minutes` pass without a
confirmed observation; a fresh uncertain sighting reads UNCERTAIN, an old one STALE (B15-12, as the lead
decided on 2026-10-20).

- **"Latest" orders by `observed_at`** (then `received_at`, then the row ID), never by arrival.
- **Confirmed** means `match = CONFIRMED` and `confidence ≥ min_confidence`. With `min_confidence` null —
  the default, until an evaluation on site footage sets it — nothing is confirmed.
- **The last known floor and zone come only from a confirmed observation** (of the latest association),
  shown with its time and freshness. With none, the interface says "Unknown" («غير معروف»).
- **A conflict answers no location** (B15-30, after the independent review): when two confirmed
  observations within the conflict window name different floors, neither is reliable, so `last_location`,
  `last_observed_at` and `freshness_seconds` are null in the journey and in the list ("Unknown", with the
  UNCERTAIN chip). When the state is UNCERTAIN only because the **latest observation is not confirmed**, the
  last confirmed location is still answered: it is still a reliable, timestamped observation.
- **Only an association the provider activated has sightings** (B15-28): nobody is bound to a PENDING
  association, nor to one whose enrollment failed, so their sightings are refused at ingestion
  (`NOT_ACTIVE`, `ASSOCIATION_ENDED`), and the journey, the list and the timeline ignore any event of an
  association that never activated (rows stored before this rule included).

### 4.4 Constants, all placeholders pending real footage (B15-16)

| Constant | Value | Where |
|---|---|---|
| Conflict window | 60 s | `tracking_rules.CONFLICT_WINDOW` |
| Provider contact timeout (UNAVAILABLE) | 5 min | `PROVIDER_CONTACT_TIMEOUT` |
| Clock skew tolerated (IN_FUTURE, BEFORE_ASSOCIATION) | 2 min | `CLOCK_SKEW_TOLERANCE` |
| Time to activate (a PENDING association expires) | 10 min after its creation | `PENDING_TIMEOUT` |
| Association's longest life | 12 h after its activation | `ASSOCIATION_MAX_LIFETIME` |
| Stale after (per company), from the latest confirmed observation or, before the first, from the activation | default 15 min, 1–240 | `company_tracking_settings.stale_after_minutes` |
| Retention (per company) | default 30 days, 1–90 | `retention_days` |
| Minimum confidence (per company) | **none** (null) | `min_confidence` |
| Timeline answered | the latest 500 events | `TIMELINE_LIMIT` |
| Journey access audit | one row per user and visit per 60 min | `JOURNEY_VIEW_AUDIT_WINDOW` |
| Journey list audit | one row per user per 60 min, when the answer shows a location | `JOURNEY_LIST_AUDIT_WINDOW` |

## 5. Ingestion

`POST /api/v1/tracking/events`, a Bearer tracking key only, at most 100 events in 64 KiB, per-event
outcomes (`accepted`, `duplicate`, `rejected` with a reason), 200 even with rejections, 422 for a
malformed body. The company comes from the key; associations are resolved by ref within that company,
cameras by the provider's ID within that company. The whole contract, with the reason codes, is in
[`visitor-tracking-integration.md`](visitor-tracking-integration.md).

## 6. Privacy and security controls

| Control | How |
|---|---|
| No images or templates | No column, field or endpoint takes one; unknown fields are refused; enrollment is a binding request (B15-7) |
| No fabricated location | Locations only from confirmed observations of an association the provider activated; two confirmed observations that disagree → no location; no threshold → no location; unknown cameras never yield a floor; the label "Inferred location" |
| Off by default | `TRACKING_PROVIDER=disabled`; tracking per company needs the platform owner's `allowed` and the administrator's `enabled` |
| Least privilege | Journeys: SYSTEM_ADMIN, MANAGEMENT, RECEPTIONIST (hosts who are only employees get 403); actions: SYSTEM_ADMIN, RECEPTIONIST; configuration: SYSTEM_ADMIN; `allowed`: the platform owner |
| Tenant isolation | Every query scoped by the session's (or the key's) company; composite foreign keys in the database; tests on every endpoint, ingestion included |
| Secrets | Keys shown once, stored as SHA-256, compared by digest; refs never answered, logged or audited |
| Rejected events | Counted by reason, never stored: unknown references and cameras, and any sighting of an association the provider never activated (B15-28) |
| Logs | Never images, refs, keys, tokens or event payloads (tests capture the logs) |
| Audit | Enrollment requested, activated, ended (reason, trigger), revoked; tracking enabled/disabled/allowed/disallowed; settings; keys; cameras; locations; opening a journey (`JOURNEY_VIEWED`, coalesced per user and visit an hour); reading a list that shows anyone's location (`JOURNEY_LIST_VIEWED`, coalesced per user an hour, B15-31) — IDs and enums only |
| Retention | `cli prune-journeys` (schema owner) deletes events and ended associations past each company's `retention_days` |
| Append-only history | The runtime role cannot update or delete events; a trigger refuses updates by anyone |

**Gate for real use** ([`production-readiness.md`](production-readiness.md)): the privacy owner's approval
(purpose, lawful basis under Jordan's PDPL, notice, access, retention) and an evaluation-based
`min_confidence`, before any real visitor is enrolled.

## 7. What is blocked

| Gate | Status |
|---|---|
| Gate 0: model assessment | BLOCKED BY ENVIRONMENT (no model, code, interface or documentation) |
| Gates 1–2: provider-neutral design and build | Done (this phase) |
| Gate 3: a real adapter | **BLOCKED BY ENVIRONMENT** ([`visitor-tracking-integration.md`](visitor-tracking-integration.md) §9) |
| Gate 4: the interface | the frontend's part of this phase (`decisions/phase-15-frontend.md`) |
| Gate 5: validation on real footage | **BLOCKED BY ENVIRONMENT**; never reported as passed |

## 8. The interface

Frontend decisions: [`decisions/phase-15-frontend.md`](decisions/phase-15-frontend.md) (F15-n). Arabic (right to
left, the default) and English, light and dark, 320 px to desktop, in the company's own identity; no
explanatory notes: short states and chips. **No image, no camera access and no picture anywhere in this
feature**: the cameras are names and the provider's IDs, never a stream.

### 8.1 Where it is, and who sees it

| Page | Address | Roles | Navigation |
|---|---|---|---|
| «رحلة الزائر» / "Visitor Journey": the day's visits | `/journey` | SYSTEM_ADMIN, MANAGEMENT, RECEPTIONIST, of a company whose tracking is allowed | main section, after "Inside now" |
| A visit's journey | `/journey/{visit_id}` | the same | from the list (and its "Back to Visitor Journey") |
| «تتبّع الزوار» / "Visitor tracking": settings and keys, locations, cameras | `/admin/tracking` (`?tab=locations`, `?tab=cameras`) | SYSTEM_ADMIN, of a company whose tracking is allowed | administration section |
| The platform owner's "Tracking allowed" | a company's page, `/platform/companies/{id}` | the platform owner | the company's card «تتبّع الزوار» |

**Only while the platform owner allows the company's tracking** (`Me.company.tracking_allowed`; the lead's
decision): otherwise neither the tab nor the administration's entry is offered, and their pages lead to the
person's own landing page, as a role guard does. Once allowed they are there as described, with the line
"Tracking is off" while the administrator has not turned it on, or "No tracking provider" while the
deployment has none (`TRACKING_PROVIDER=disabled`). A host (EMPLOYEE only) never has the tab, and the API answers them 403 (least
privilege). The platform owner's switch is on every company's page.

### 8.2 The one line about tracking

From `GET /tracking/status`, above the list and a visit's journey, one line and nothing under it:

| Status | Line |
|---|---|
| No provider on the deployment (`available` false) | «لا يوجد مزوّد تتبّع» / "No tracking provider" |
| A provider, but not `allowed` or not `enabled` | «التتبّع غير مفعّل» / "Tracking is off" |
| On, but not `healthy` (no contact within 5 min) | «مزوّد التتبّع غير متصل» / "The tracking provider is not connected" |
| The provider is the simulator | «محاكاة» / "Simulated" (with a line, or alone without the line's frame) |
| On, healthy, a real provider | no line |

### 8.3 The states as chips

Every state is the server's (`state`), named by a chip with an icon and words, never by colour alone. Status
colours never follow the company's colour.

| State | English | Arabic | Tone |
|---|---|---|---|
| `ACTIVE` | Active | نشط | green |
| `UNCERTAIN` | Uncertain | غير مؤكد | amber |
| `STALE` | Not recent | قديم | amber |
| `UNAVAILABLE` | Not connected | غير متصل | red |
| `PENDING` | Starting | قيد البدء | blue |
| `NOT_ENROLLED` | Not started | لم يبدأ | grey |
| `ENDED` | Ended | انتهى | grey |
| `DISABLED` | Off | غير مفعّل | grey |

Whatever the simulator made carries «محاكاة» / "Simulated" (a chip), said once a page: the list's line while
the simulator is the provider (else each row whose latest association is the simulator's), and a visit's
header for the simulator's journey (not again in its line or its tracking card). An observation in the timeline is
marked «مؤكد» / "Confirmed" when the server counts it (`confirmed`), else «غير مؤكد» / "Uncertain".

### 8.4 The list

The company's visits of a day (today unless another is chosen) that were inside that day, newest check-in
first: the visitor (the row's link), the company, the host, the state, and under «موقع مُستنتج» /
"Inferred location" the last **confirmed** floor › zone with the building, the time (with its date for an
earlier day) and, for today, how long ago ("4m ago", from the server's `freshness_seconds`, counted on from
when that answer arrived, also while the next rows load). Without a confirmed observation (or while two
recent ones disagree): «غير معروف» / "Unknown", never a floor. Filters: search (the visitor's name or
company), the state, the day; kept in the address (the search text in the history entry's state, never in
the address). A table from 1024 px, cards below it. Asked again every 30 s while open.

### 8.5 A visit's journey

- **The header**: the visitor, Simulated for the simulator's journey, the visitor's company. The tab's title
  never names the visitor.
- **«موقع مُستنتج» / "Inferred location"** (the card's title, as the spec asks: a visible sign that the place
  is inferred, not guaranteed): the last confirmed floor › zone and its building, when it was seen and how
  long ago (the server's `freshness_seconds`, counted on from when it answered); «غير معروف» / "Unknown"
  without one. The state's chip beside the title.
- **Tracking**: when it was requested («طُلب البدء» / "Requested", while the provider has not started it) or
  started, when it ended and why (Checked out, Stopped, Expired, Could not start, Visit cancelled); the
  actions (8.6).
- **Visit**: the host, the visit's status, check-in and check-out times, the way to the visit's own page.
- **The timeline**: every event, **newest first** (the server answers by when each was observed, oldest
  first, at most the latest 500, said so when there are more; the page turns it round): the time, for an
  observation its floor › zone and its mark, the camera's name, the confidence only when the provider sent one
  ("Confidence 91%"); "Tracking started" and «فُقد الأثر» / "Out of sight" for the other two kinds; «لا يوجد
  رصد» / "No observations" when there is none.
- Asked again every 15 s while open. 404 and 403 have their own states, as on a visit's page.

### 8.6 Starting and stopping

Reception and administrators only; management reads. The server decides (`can_enroll`, `enroll_blocker`,
`can_revoke`):

- **Stop tracking** while an association runs, after one line («إيقاف تتبّع {name}؟»).
- **Start tracking** when the server says it can be made, at the company's reception camera (a choice
  «كاميرا الاستقبال» / "Reception camera" when there are several).
- Otherwise a disabled "Start tracking" with the server's reason beside it, as a short state: "No tracking
  provider", "Tracking not allowed", "Tracking is off", "Not inside", "No reception camera" (a reason the
  page's line already says is read out, not shown twice). A running association and a role that cannot start
  one show no disabled button.
- A refused start stays said in the tracking card, in the server's words (a field's own message for a 422); a
  failed load of the reception cameras is said with "Try again". When the action changes under the focus
  (start → stop, stop → start), the focus goes to the new one.

### 8.7 Administration

- **Settings**: the switch "Visitor tracking" (on at once; off after one line, since it ends every running
  tracking), disabled with «غير مسموح به» / "Not allowed" while the platform owner has not allowed it; the
  provider (Simulator with its Simulated mark, or None); the provider's health (last contact, last accepted
  event, refusals by reason and provider errors over 24 h); the thresholds: the minimum confidence as a
  percentage, "Minimum confidence (%)", 1–100 (empty: none, so nothing is confirmed; below 1 refused, as a
  share typed by mistake), "Not recent after" in minutes (1–240), "Keep journeys for" in days (1–90), each unit
  read with its field, saved together.
- **Provider keys**: listed by label and prefix, by whom and when, last use, in use or revoked; "Create key"
  shows the new key **once** in a dialog, selected, with a copy button, as a new account's temporary password
  is (and nowhere after); "Revoke" after one line; at two keys in use "Create key" waits, with the reason
  beside it.
- **Locations**: each building (a card) with its floors by level and each floor's zones; add, rename,
  archive and restore (never delete); both names, the other language's muted under the first; "Show
  archived".
- **Cameras**: name, the provider's camera ID (left to right), building › floor › zone, the reception mark;
  add (active zones only), edit, archive and restore; with no zone yet the way to the locations first.
- **The platform owner**: "Tracking allowed" on a company's page; off after one line (it also turns the
  company's own switch off and ends every running tracking).
