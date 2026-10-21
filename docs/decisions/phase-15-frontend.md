# Phase 15 — frontend decisions (the Visitor Journey, with the tracking provider off)

Date: 2026-10-20. Scope: `frontend/**` (the new `src/features/journey/**` and `src/features/admin/tracking/**`,
the kit's `Switch`, the platform owner's company page, the types and the API module, the catalogs, the
audit vocabulary, the unit tests and `e2e/**`), `frontend/README.md`, the interface's section of
`docs/visitor-journey-design.md` (§8) and this file. Contract: the Phase 15 contract, section F and the
frontend's parts of G and H, with the backend's settled shapes (`phase15-api-shapes.md`, first issue and its
E2E notes; `phase-15-backend.md`, B15-1 … B15-26). The rules of the earlier phases hold: direction C with the
existing kit, Arabic (right to left, the default) and English from the catalogs, logical CSS properties
only, `style-src 'self'` and `script-src 'self'`, a company's own identity, light and dark, **no explanatory
notes**.

What the owner decided on 2026-10-20: build the provider-neutral part of the Visitor Journey now, with the
tracking provider **off**. No tracking model exists (Gate 0, `docs/visitor-tracking-model-assessment.md`): a
real adapter and real validation stay **BLOCKED BY ENVIRONMENT**, and nothing in the interface claims that
live tracking works. The hard rules for the interface: no fabricated location, no fake footage, no fake
confidence, no simulated movement or sample visitors in production UI; the simulator's data always marked
«محاكاة» / "Simulated"; «غير معروف» / "Unknown" without a confirmed observation; no image capture, no camera
access, no image anywhere in the feature.

Each entry records what was built and every interpretation of, or deviation from, the contract.

---

## The tab and its states

**F15-1 — «رحلة الزائر» / "Visitor Journey": a tab for administrators, management and reception.**
`features/journey/routes.tsx`: `/journey` (the day's visits) and `/journey/:visitId` (a visit's journey),
lazy pages behind `RequireRole` with `SECTION_ACCESS.journey = ['SYSTEM_ADMIN', 'MANAGEMENT',
'RECEPTIONIST']`. The navigation entry is in the main section right after "Inside now" (order 55): the two
pages a receptionist reads about who is in the building stand together. A host (EMPLOYEE only) has no tab
and is sent to their own landing page; the API answers them 403 (least privilege, B15-13), and the
permissions spec holds both.

*The tab is always there for those roles*, whatever the deployment's provider: the contract says the
Disabled state is shown when the provider is `disabled` (production's value). So on production every such
person sees the tab, and it says «التتبّع غير مفعّل» / "Tracking is off". Hiding it there would be cleaner
for an owner who never turns tracking on, and needs only the status in the shell; recorded under Open
questions, not built.

*Superseded by F15-24 (the lead's decision): the tab and the administration's entry are offered only while
the company's tracking is allowed (`Me.company.tracking_allowed`).*

**F15-2 — The journey state as a chip** (`journeyStates.ts`, `JourneyStateBadge`). The server computes the
state (B15-12); the page only names it, with an icon and words on a tone, never colour alone, and status tones
never follow the company's colour (F12-16):

| State | English | Arabic | Tone, icon |
|---|---|---|---|
| `ACTIVE` | Active | نشط | green, a pin |
| `UNCERTAIN` | Uncertain | غير مؤكد | amber, a question mark |
| `STALE` | Not recent | قديم | amber, a clock |
| `UNAVAILABLE` | Not connected | غير متصل | red, a pulled plug |
| `PENDING` | Starting | قيد البدء | blue, an hourglass |
| `NOT_ENROLLED` | Not started | لم يبدأ | grey, a dashed circle |
| `ENDED` | Ended | انتهى | grey, a stop |
| `DISABLED` | Off | غير مفعّل | grey, a crossed circle |

"Stale" is a developer's word; "Not recent" says what it means to a receptionist (a floor seen, but not lately).
"Not started" rather than "Not enrolled": enrolment is the system's word, starting tracking the person's
(F15-10). The list's filter offers the states with the tracked ones first (Active, Uncertain, Not recent,
Not connected, Starting) and the others after. Each state has its own icon, so two of one tone still differ.
*The table has the lead's words (F15-26, F15-38); the first build had «غير حديث» for STALE, «غير متاح» /
"Unavailable" for UNAVAILABLE and «متوقف» for DISABLED.*

**F15-3 — «محاكاة» / "Simulated", wherever the simulator made something.** `SimulatedBadge` (`data-simulated`,
so the end-to-end suite finds every one): on every row of the list whose latest association is the
simulator's (`simulated`), in a visit's header and on its tracking card (`association.simulated`), beside the
provider "Simulator" in the administration, and in the page's one line while the deployment's provider is
the simulator (F15-4). On a visit whose journey is the simulator's the line leaves the mark out
(`simulatedShown`): the header already says it, and three "Simulated" chips on one screen were clutter
(seen in the screenshots).

*Superseded by F15-35: Simulated is said once a page: in the line while the simulator is the provider (the
rows then leave it out), in a visit's header for its journey (the line and the tracking card leave it out).*

**F15-4 — One line about tracking, from `GET /tracking/status`** (`TrackingStatusBanner`, `trackingStatus.ts`):
«التتبّع غير مفعّل» / "Tracking is off" when the deployment has no provider, the platform owner has not allowed
it or the administrator has not turned it on; «مزوّد التتبّع غير متصل» / "The tracking provider is not
connected" when it is on but not healthy (no contact within 5 min); «محاكاة» / "Simulated" while the provider
is the simulator, with either line or alone; nothing for a healthy real provider. The backend's suggested rule,
as given. A `region` named «التتبّع» / "Tracking", one row (it wraps on a phone), no paragraph under it.

*Amended by F15-33 (a fourth line, «لا يوجد مزوّد تتبّع» / "No tracking provider", when the deployment has
none) and F15-35 (the Simulated mark alone stands without the line's frame).*

## Where a visitor was

**F15-5 — «موقع مُستنتج» / "Inferred location", and «غير معروف» / "Unknown" without a confirmed observation.**
The card's title is the label the spec asks for (a visible sign that the place is inferred, not guaranteed);
in it the last confirmed floor › zone in large type, the building under it, then "Observed 11:56 · 4m ago".
The place comes only from `last_location`, which the server gives from a confirmed observation only: the page
never derives one from the timeline, and an uncertain observation never becomes the last place. Without it
the card says «غير معروف» / "Unknown" and nothing else. The state's chip stands beside the title, so a
"Not recent" or "Uncertain" place is never read as current.

- **How long ago** is the server's `freshness_seconds` counted on from when it answered (`dataUpdatedAt`),
  not the device's clock, which may be off; the list, which has no such field, uses the device's clock.
  *The list's rows now have it too, and use it the same way (F15-27).*
- **For a sighting of today only** (the company's day): "26h ago" says nothing on a past day. A detail's
  sighting of another day shows its date instead; the list (which is one day) never does. *Superseded by
  F15-40: a list row of a visit seen last on an earlier day says its date too.*
- **floor › zone** (`LocationPath`): each name in its own isolate, the chevron mirrored in Arabic, and a
  visually hidden comma for a screen reader ("Floor 3, Lobby"). A place's name in the UI language follows
  the departments' rule: its Arabic name in Arabic when it has one (`locationNames.ts`).

**F15-6 — The list** (`JourneyList`, `JourneyTable`, `journeyFilters.ts`). The day's visits as the server
gives them (inside during that day, newest check-in first): the visitor (the row's link; an avatar, dark for
one inside), the company under it, the state and Simulated, the host, the last location with its building,
time and how long ago, or "Unknown". The rows of an Active journey are tinted (direction C's highlighted
row; the chip says why). A table from 1024 px, cards below it (two a row on a tablet), as the history's.
Filters: search (the visitor's name or company), the state (a select; the API takes a list, the page sends
one), the day (today unless another is chosen; a later day cannot be picked); the day and the state in the
address (`day`, `state`), the search in the history entry's state, never in the address (`PRIVATE_PARAMS`).
The header says how many visits and which day. Asked again every 30 s while open (paused in a background
tab), the status each minute. Loading, empty (a day without visits; filters that match nothing; a page past
the last), error with "Try again", and a 403 of its own («لا تملك صلاحية الوصول إلى رحلة الزائر»).
*Amended by F15-31 (the column is «موقع مُستنتج» / "Inferred location"), F15-30 (how long ago while the next
rows load) and F15-35 (no Simulated on the rows while the page's line says it).*

**F15-7 — A visit's journey: a page, not a panel** (`JourneyDetail`). A panel beside the list would not fit a
tablet in portrait, where reception works; a page has its own address (a link from the list keeps the list's
view for "Back to Visitor Journey"). The header is the visitor, the state, Simulated and the visitor's
company; the tab's title never names the visitor (§7.2). Wide screens: the inferred location and the timeline
in the main column, the tracking and the visit beside them; one column: the location, the tracking and its
actions, the visit, then the long timeline. The visit's card has the host, the visit's status, check-in and
check-out, and "Open visit" (whose page's back link returns to the journey). Asked again every 15 s. 404 and
403 have their own states, as on a visit's page. *Amended by F15-35: the header has no state chip (the
Inferred location card has it), and Simulated only for the simulator's journey.*

**F15-8 — The timeline** (`JourneyTimelineCard`): every event in the server's order (by when it was observed,
oldest first, as the visit's own timeline reads: a journey is a story); the time (with its date when the events
span days); an observation's floor › zone and its mark, «مؤكد» / "Confirmed" when the server counts it
(`confirmed`, **not** the provider's `match`: with a null threshold nothing is confirmed, whatever the provider
said) or «غير مؤكد» / "Uncertain"; the camera's name; «الثقة 91%» / "Confidence 91%" **only when the provider
sent one**. The other two kinds are "Tracking started" (with the reception camera) and «خارج نطاق الرصد» /
"Out of sight". The server answers the latest 500: with more, one line says "Latest 500 of 812" (a fact, not a
note), and the card's count is the total.

*Superseded by F15-25 (newest first) and F15-26 («فُقد الأثر» for LOST).*

## Starting and stopping

**F15-9 — The server decides; the page says why not** (`trackingActions.ts`). From `can_enroll`,
`enroll_blocker` and `can_revoke`:

- a running association: **Stop tracking** (reception and administrators), after one line («إيقاف تتبّع
  {name}؟» / "Stop tracking {name}?": it cannot be undone for this association); the focus goes on from the
  page's heading once the button is gone;
- `can_enroll`: **Start tracking** at the company's reception camera, with a choice «كاميرا الاستقبال» /
  "Reception camera" only when there are several (the contract); the cameras are asked for only then
  (reception's read gives its active enrollment points; an administrator's every active camera, of which the
  enrollment points are kept); none (archived since): "No reception camera";
- otherwise a disabled "Start tracking", focusable, with the server's reason beside it as a short state, its
  description for assistive technology: `PROVIDER_DISABLED` "No tracking provider", `NOT_ALLOWED` "Tracking not
  allowed", `NOT_ENABLED` "Tracking is off", `NOT_CHECKED_IN` "Not inside", `NO_ENROLLMENT_POINT` "No
  reception camera". `ALREADY_ENROLLED` and `NOT_PERMITTED` show no disabled button (a stop is offered, or the
  person reads only). *The backend dropped `WINDOW_ENDED` (any visit inside may be started) and its words went
  with it (F15-29); a reason the page's line already says is read out only (F15-35); the cameras' load failure
  has its own state (F15-36).*

Management reads the journey and has no action, also checked in the page (`TRACKING_ACTION_ROLES`) whatever
reason the server lists first. A start or a stop answers with the journey, which replaces the page's copy;
every list of journeys is asked again. A refusal is said in the card (or in the dialog) with the server's
message, and the journey is asked again. *Amended by F15-39 (a refused start stays said in the card), F15-36
(a 422 says its field's message) and F15-32 (the focus follows the action).*

**F15-10 — Words.** «بدء التتبّع» / "Start tracking" for enrolment and «إيقاف التتبّع» / "Stop tracking" for a
revoke: "enrol" is the system's word, and «تسجيل» is checking in throughout the app (`catalogs.test.ts`
holds that term), so it could not name another act. The contract's own words are used as given:
«رحلة الزائر», «موقع مُستنتج», «غير معروف», «محاكاة», «التتبّع غير مفعّل», «مزوّد التتبّع غير متصل». A key is
revoked with «إبطال» (to invalidate), since «إلغاء» is every dialog's "Cancel". The end reasons: Checked out
«خرج الزائر», Stopped «أُوقف», Expired «انتهت مدته», Could not start «تعذّر البدء», Visit cancelled «أُلغيت
الزيارة». *The lead's words for three states and an event: F15-26.*

## Administration

**F15-11 — One page, three tabs** (`TrackingAdminPage`): «تتبّع الزوار» / "Visitor tracking" in the
administration section (after "Email texts"), tabs Settings, Locations, Cameras, the tab in the address
(`?tab=`). One entry rather than three: the three are one setting-up task, and the administration section
already has six. The thresholds being edited are kept by the page, so a look at another tab loses nothing;
leaving the page with unsaved thresholds asks first (`UnsavedChangesGuard`).

**F15-12 — A switch in the kit** (`components/ui/Switch.tsx`; there was none). A `button` with `role="switch"`
and `aria-checked` (Space and Enter), the track and the words one target at least 44 px tall. On is the
status green under a thumb in the surface's colour (4.98:1, 6.75:1 dark), never the company's colour (a pale
yellow would not show a state on a white card, F12-29's reason); off an outlined track with a grey thumb at the
start; the thumb's place says the state in a forced-colours mode too (system colours). While it cannot change
it stays focusable (`aria-disabled`), so its reason, described by it, is heard where it is. Chosen over a
checkbox because the change takes effect at once (turning off asks first), where the company settings'
checkboxes are saved with their form.

**F15-13 — Settings** (`TrackingSettingsPanel`).
- **The switch** "Visitor tracking": on at once; off after one line («يتوقف تتبّع كل زائر يجري تتبّعه الآن.»:
  it ends every running association). While the platform owner has not allowed it, it is disabled with
  «غير مسموح به» / "Not allowed" beside it. The provider is a fact under it: "Simulator" with its Simulated
  mark, or «لا يوجد» / "None" (`disabled`; the company can still prepare its places and cameras).
- **The provider's health** (`settings.health`): last contact, last accepted event, refusals by reason and
  the provider's errors over 24 hours, each with its count, or "None": what an administrator needs to see the
  provider is not answering. Reasons only, never a payload (the API has none).
- **Thresholds and retention**: the minimum confidence as a **percentage** (87.5 % is sent 0.875; empty is
  none: nothing is confirmed), "Not recent after" 1–240 minutes, "Keep journeys for" 1–90 days; typed in
  either digits; checked at their fields; only what changed is sent. No note about where the threshold must
  come from (the docs say it); the field is "optional" and empty by default, as the server's.

*Amended by F15-34 (the units read out, the percentage in the label, below 1 % refused) and F15-38
(TRACKING_OFF «التتبّع غير مفعّل»; the new refusal NOT_ACTIVE, F15-29).*

**F15-14 — Provider keys, the key shown once** (`TrackingKeys.tsx`). Listed by label and prefix (`vtk_Ab3d…`,
left to right), by whom and when, last used, "In use" or "Revoked". "Create key" asks for a label (one line,
at most 100), then shows the key **once** in a dialog as a new account's temporary password is (D-11): the
one line «يظهر المفتاح مرة واحدة فقط.» / "The key is shown only once.", the key read-only and selected on open,
a copy button, "Done". It lives in that dialog's state only; the mutation that brought it is dropped from the
cache when the dialog closes (`gcTime: 0`), and nothing shows it after. "Revoke" after one line. At two keys
in use (the server's limit, for rotation) "Create key" is disabled with «مفتاحان قيد الاستخدام» / "Two keys
in use" beside it. *Amended by F15-32 (the focus after a revoke) and F15-38 (the label isolated in the
Arabic titles; «أبطِل» in the limit's message).*

**F15-15 — Locations: buildings → floors → zones** (`LocationsPanel`). A card per building, its floors by
level (the server's order) with the level in a small tile, each floor's zones under it; each place's name in
the UI language with the other language's muted under it (data the administrator manages, as departments);
one menu per place (add the next level down, edit, archive or restore): the building's outlined, the floors'
and zones' quieter, so the tree reads before its buttons. A dialog adds or edits a place: its name, its
Arabic name (typed right to left), a floor's level (−20 to 200, unique in its building; `−` and Arabic digits
taken). **Nothing is deleted** (the API has no delete: a camera or an event may name a place); archiving asks
first, and a place that still has active places or cameras is refused with the server's message in the
dialog (409 `LOCATION_IN_USE`). Archived places on request ("Show archived"), restored from their menu.
Duplicates are caught before sending (a building's name in the company, a zone's in its floor, any case),
and the server's 409 lands on its field. *Amended by F15-32 and F15-36 (the focus after an archive; a refused
restore in its own words).*

**F15-16 — Cameras** (`CamerasPanel`). A table from 1024 px: the name and, under it, the provider's camera ID
(left to right, monospace, broken anywhere: IDs such as `shaheen/floor-3/lobby-east-0003`), building › floor
› zone, «كاميرا استقبال» / "Reception camera" for an enrollment point; edit, archive (after one line) and
restore. The dialog: the provider's camera ID (visible characters, no space, unique in the company), the
name, the zone (grouped by building › floor; active zones only; a camera's archived zone stays its current
choice so an edit of its name does not move it), and "Reception camera". **No address, stream, credential
or picture**: those stay with the provider (the contract), and the page asks for none. With no active zone
yet, the page says «أضف منطقة قبل إضافة كاميرا» / "Add a zone before adding a camera" with the way to the
locations, and "Add camera" waits. *Amended by F15-32 and F15-36, as the places.*

**F15-17 — The platform owner's "Tracking allowed"** (`CompanyTrackingCard` on a company's page, under its
identity): a switch; allowed at once; stopping it after one line («يُوقف التتبّع في الشركة، ويتوقف تتبّع كل
زائر يجري تتبّعه الآن.»: it turns the company's own switch off and ends every running association);
`PATCH /platform/companies/{id}/tracking`, its answer the company (`tracking_allowed`). *Amended by F15-39:
its Cancel clears a refusal as Escape does.*

## The API in the client

**F15-18 — Types, mirrored from the backend's names** (`types/api.ts`). The responses, requests, queries and
the envelope the snapshot names (`TrackingStatus`, `TrackingSettings`, `TrackingKey`, `TrackingKeyCreated`,
`TrackingCamera`, `LocationTree`, `Building`, `Floor`, `Zone`, `VisitJourney`, `JourneyListItem`; the
requests; `JourneyListParams`, `TrackingCameraListParams`; `JourneyPage`), the enums as aliases checked
through the models that use them (`JourneyState`, `TrackingProviderName`, `TrackingAssociationStatus`,
`TrackingEndReason`, `JourneyEventType`, `ObservationMatch`, `EnrollBlocker`, `TrackingRejectReason`,
`TrackingProviderOperation`, added to `CHECKED_INDIRECTLY`), `PlatformCompany.tracking_allowed`, the error codes
`TRACKING_NOT_AVAILABLE`, `TRACKING_KEY_LIMIT`, `LOCATION_IN_USE` and the field code `location_archived` with
their texts in both catalogs. The shapes the API nests (`JourneyLocation`, `TrackingAssociation`,
`JourneyEvent`, the tree's nodes) are not exported, as before (a name the snapshot does not list fails the
contract test); the feature reads them from the responses that carry them (`features/journey/types.ts`), so
they cannot drift. `api/tracking.ts` has every call; the ingestion endpoint is never called from the browser.
Built first against the contract with provisional names, then aligned with the shapes file: no field was
invented, and nothing the interface needed was missing, so no request was made.

**F15-19 — The caches.** Keys under `tracking` (status, settings, keys, cameras, locations) and `journeys`
(lists, a visit's). A check-out or a cancellation anywhere ends the visit's tracking in the same transaction,
so the one refresh after a visit change (`refreshAfterVisitChange`) now asks every journey again; a change of
the settings asks the status and the journeys again (turning off ends them); a change of a place or a camera
asks the cameras, the tree and the journeys again (a camera's place, a journey's names).

**F15-20 — The audit log** has words for everything the backend records (its source is read by the tests): a
group «تتبّع الزوار» / "Visitor tracking" with the sixteen actions (seventeen with F15-29's list read; a visit's tracking requested, started,
ended, stopped; a journey opened; tracking turned on, off, allowed, no longer allowed; settings; keys created
and revoked; cameras added and updated; places added and updated), the record types (building, floor, zone,
camera, provider key), the metadata keys (`association_id`, `camera_id`, `provider`, `revoked`,
`ended_tracking`, `was_enabled`), and the values (the end reasons and triggers, the providers, the fields a
change names, the two new rate-limit policies), in Arabic without Latin letters. `auditVocabulary.test.ts`
now also reads `TrackingEndReason`, `TrackingProviderName` and the new update requests. The platform's trail
offers "Tracking allowed" and "Tracking no longer allowed" in its filter.

## Tests

**F15-21 — Unit tests (Vitest).** New: `features/journey/journeyLogic.test.ts` (every state's chip, the order,
the Arabic words, the blockers' words, the banner's rule, what the page offers per role and answer, the
filters in the address and the request, a place's name), `JourneyPage.test.tsx` (the list: rows, Simulated,
"Unknown" and no floor, the banner's three lines, the filters in the request and the address with the search
never in it, empty and 403, Arabic; a visit: the inferred location with when and how long ago, "Unknown", the
timeline's marks and the confidence only when sent, Simulated twice, stopping after one line, starting at a
chosen camera and at the only one, a disabled start with its reason, management without an action, 404 and
403, "Latest 3 of 812", Arabic), `noImages.test.ts` (no image, video, canvas, picture or camera API in any
source of the feature), `features/admin/tracking/trackingForms.test.ts` (percentages and whole numbers in
either digits, the thresholds' checks and the update that sends only what changed, a place's and a camera's
checks, the zones a camera can be put in, a key's label) and `TrackingAdminPage.test.tsx` (the switch on at
once and off after one line, disabled while not allowed with its reason, the provider, the thresholds saved and
refused, the health, a key shown once and gone after Done, the limit of two, a revoke; the tree, adding a
building, a floor with its level and a taken one, a place in use; the cameras, adding one, no zone yet),
`components/ui/Switch.test.tsx`. Extended: `sectionAccess.test.tsx` (the tab for the three roles, none for a
host, "Visitor tracking" for administrators only, the redirects), `AppLayout.test.tsx` (the navigation's
order), `PlatformPages.test.tsx` (the switch; the platform trail's twenty-one events), `api.contract.test.ts`
(the new names), `catalogs.test.ts` (the error codes), `auditVocabulary.test.ts`.

**F15-22 — End-to-end (Playwright).**
- **The environment**: the API runs with `TRACKING_PROVIDER=simulator` and the two new rate limits at their
  defaults, set in `e2e/support/env.ts` so a developer's `.env` cannot change them. The global setup
  (`e2e/support/tracking.ts`, `prepareTracking`) has the platform owner allow the main company's tracking and
  its administrator turn it on with a threshold of 0.5, and creates "Mawdoo3 HQ" with two floors, four zones, a
  reception camera and two cameras on floor 2; the quality data's inside visitor is tracked and observed.
  Observations come from the backend's `simulate-journey` (confidence 0.9), through the ingestion service.
  Other Corp is never allowed.
- **`e2e/flows/visitor-journey.spec.ts`** (the real API, six tests): reception reaches the tab, starts a
  visitor's tracking at the reception camera, the simulator's two observations appear in the timeline,
  confirmed with their confidence and camera, the inferred location is the latest one's with how long ago,
  the list says the same, axe on both; the check-out ends it (`CHECKED_OUT`), a later simulation is refused,
  the page says "Checked out" and offers no stop; in Arabic on a phone, the list as cards, «موقع مُستنتج», a
  stop after one line; an administrator adds a building, a floor, a zone and a camera through the pages,
  archives the camera, creates a key that is shown once, which the ingestion then accepts (a heartbeat) and a
  session cookie does not replace, and which is refused once revoked; the platform owner allows a new
  company's tracking on its page, its administrator turns it on, and stopping it turns that off; Other Corp:
  "Tracking is off", a disabled start with "Tracking not allowed", the switch disabled with "Not allowed"; a
  host without the tab and refused by the API, management without an action, another company refused (404).
- **`e2e/flows/permissions.spec.ts`**: the two new links in every role's navigation, the redirects, and the
  refusals (a host's journeys and status, reception's settings and keys and places, management's start, stop
  and settings).
- **`e2e/quality/accessibility.spec.ts`** and **`appearance.spec.ts`**: the journey list and a journey for the
  three roles that have them, the three tabs of the administration, at the three viewports and 320 px, and in
  Dark.
- **`e2e/phase15-journey.spec.ts`** (the API mocked; only Vite): the list, a journey, the administration's
  three tabs and the platform owner's switch, in both languages and schemes at the three viewports, with axe,
  no sideways scroll at the viewport and at 320 px, and every control a tap reaches over at least 44 px on the
  tablet and the phone; a manager without an action; cards below 1024 px. With `P15_SHOTS` set it saves its
  scenes (the visual check below).

**F15-23 — What the simulator does, as the E2E suite found it** (the backend's E2E notes, then confirmed): the
simulator's walk moves to the next camera only once more than the conflict window (60 s) has passed, so the
observations of a fresh association all land on its first camera. The specs therefore assert a place of the
walk and the latest observation's place, not a movement; two cameras on one floor keep any later move from
being a conflict. Right after enrolment, before any observation, the backend's final rule (the lead,
2026-10-20) answers ACTIVE with no last location (it becomes "Not recent" only once `stale_after_minutes`
pass since activation without a confirmed observation): the page then shows the Active chip over «غير معروف» /
"Unknown", which the unit tests hold (`last_location` null is "Unknown" whatever the state), and the flows
assert no state between the start and the first observations, only the stop that is then offered.

## The lead's decisions (2026-10-20, evening)

On the open items below, with two fields the backend added for them (`Me.company.tracking_allowed`,
`JourneyListItem.freshness_seconds`; both in the regenerated snapshot, `api.contract.test.ts` passes).

**F15-24 — The tab and the administration's entry only while the company's tracking is allowed.** A
`NavEntry` may say `requiresTracking`; the shell (`AppLayout`) offers such an entry only when the person's
roles allow it **and** `me.company.tracking_allowed` is true: «رحلة الزائر» / "Visitor Journey" and «تتبّع
الزوار» / "Visitor tracking". Their routes are guarded the same way as a role-gated route
(`auth/RequireTrackingAllowed.tsx`, inside `RequireRole`): `/journey`, `/journey/:visitId` and
`/admin/tracking` lead to the person's own landing page (or say "No access" on that page itself, as
`RequireRole` does). Once allowed, both are there as before, with "Tracking is off" while the administrator has
not turned it on or the deployment has no provider. The flag comes with the session (`/auth/me`, asked again
whenever the window regains focus), so a change by the platform owner shows once the session is asked again
(back to the window, or a reload); the API answers DISABLED in the meantime. The platform owner's switch stays on every company's
page (F15-17). Supersedes F15-1's "always there".

**F15-25 — The timeline newest first.** `JourneyTimelineCard` turns the server's order (oldest first, the
latest 500) round, so a live view has its latest event at the top; "Latest 500 of 812" and the count are
unchanged. Supersedes F15-8's order.

**F15-26 — Words.** STALE «قديم» (English stays "Not recent"), and the setting «يصبح الموقع قديمًا بعد»
(its audit field too); UNAVAILABLE «غير متصل» / "Not connected", as the banner's «مزوّد التتبّع غير متصل»; the
LOST event «فُقد الأثر» (English stays "Out of sight"). «إبطال» is kept for a key. No «غير حديث» is left;
«غير متاح» stays only in the refusal `TRACKING_NOT_AVAILABLE` («التتبّع غير متاح الآن.»), which is not a state.

**F15-27 — "How long ago" in the list from the server.** A row's `freshness_seconds` counted on from when the
list was answered (`features/journey/freshness.ts`, `agoSeconds`, the list query's `dataUpdatedAt`), as a
visit's page already did (F15-5), so the two agree on a device whose clock is off. The device's clock is used
only if a row had a time without a freshness (the server gives both from the same confirmed observation).

**F15-28 — The floors keep the server's order** (by level, ground first; F15-15 unchanged).

**Tests for these.** Vitest: `makeMe` takes the company's fields (`tracking_allowed` false by default, as a
new company's); the journey's and the administration's page tests sign in as an allowed company
(`makeTrackedMe`); `sectionAccess.test.tsx` holds no tab, no "Visitor tracking" and the redirects while not
allowed, and the three roles' tabs once allowed; `AppLayout.test.tsx` the order with both entries;
`journeyLogic.test.ts` the new words; `JourneyPage.test.tsx` the timeline newest first and the list's "10m
ago" from the server's freshness. E2E: in `flows/visitor-journey.spec.ts` the platform owner's test now has a
new company's administrator (in a browser of their own) without either entry, then with both and "Tracking is
off" (axe), then the simulator's line once turned on, then neither once stopped; Other Corp's reception has no
tab and its pages lead home, its administrator no "Visitor tracking", and `/auth/me` says not allowed; the
latest observation is the timeline's first row. `phase15-journey.spec.ts` signs in allowed and adds a manager
of a company not allowed (no link, `/journey` leads to Reports); the specs with a session of their own say
`tracking_allowed: false`. The main company is allowed in the global setup, so `permissions.spec.ts`,
`accessibility.spec.ts` and `appearance.spec.ts` keep their links and pages.

## After the independent review (2026-10-20, night)

An independent review of the interface (it ran the unit tests and read the code) found the defects below; the
lead confirmed them, with the fixes as proposed, and approved four more changes. The backend's own review
changed the contract at 21:05 (`phase15-api-shapes.md`); its final snapshot is the one checked.

**F15-29 — The backend's last contract.** `TrackingRejectReason` gains `NOT_ACTIVE` (a sighting for an
association not yet started: «لم يبدأ بعد» / "Not started yet" in the health's refusals). `EnrollBlocker` loses
`WINDOW_ENDED` (any visit inside may be started, whatever its schedule): its words and test uses are gone. The
audit action `JOURNEY_LIST_VIEWED` (the list read when it shows someone's place, once an hour a person): «فُتحت
قائمة رحلات الزوار» / "Journey list viewed" in the tracking group, with its metadata `day` «اليوم» / "Day" and
`located` «بموقع» / "With a location". Behaviour the page needed nothing new for: two confirmed sightings
within 60 s on different floors give no place (shown "Unknown"); an association still starting ends after 10
min, a running one 12 h after it started; only a started association's events are shown.

**F15-30 — "How long ago" while the next rows load.** With `keepPreviousData` the query reports
`dataUpdatedAt` 0 while it shows the previous rows, so a changed filter showed "497913h ago". The list's
answer now carries its own time (`AnsweredJourneyPage.answeredAt`, set when the answer arrives), so the rows on
screen count on from when they were answered; `agoSeconds` takes the server's figure alone for an unknown
time (0).

**F15-31 — The list's column is «موقع مُستنتج» / "Inferred location"** (and so the phone card's label), as the
visit's card: the place is inferred there too.

**F15-32 — The focus follows the action.** On a visit's page, when the action changes under a keyboard
user's focus (a start becomes a stop, a stop a start, a refused start a disabled one, or nothing is left), the
focus goes to the new action, else to the page's heading. In the three administration lists the shared
`useListFocusRecovery` keeps it: a revoked key keeps its row but loses its button (the focus goes to the next
key in use, else "Create key"); an archived camera or place leaves the list while "Show archived" is off (the
focus goes to the next camera's archive button or the next place's menu, else "Add camera" / "Add building").

**F15-33 — A fourth line: «لا يوجد مزوّد تتبّع» / "No tracking provider"** (approved), when the deployment has
none (`TrackingStatus.available` false: the provider is disabled). "Tracking is off" stays for a company that
has not turned it on (or is not allowed) while a provider exists; the status tells the two apart.

**F15-34 — The units are read, and a share is not taken for a percentage.** "Minimum confidence (%)" /
«الحد الأدنى للثقة (%)» has the unit in its label; the minutes and the days, shown beside their fields,
describe them (`aria-describedby`), so a screen reader says "15, min". A non-empty confidence below 1 is
refused at its field, «أدخل نسبة من 1 إلى 100.» / "Enter a percentage from 1 to 100.": "0.8" would have been
0.8 %, stored 0.008, and confirmed nearly everything.

**F15-35 — Simulated once, and no state twice.** While the simulator is the provider the page's line says
Simulated and the list's rows do not (a row says it only when the page does not); on a visit, the header says
it for the simulator's journey and the line and the tracking card do not. The mark alone (no line) stands
without the line's border, background and padding (`data-tracking-banner="simulated"` kept). The visit's
header has no state chip (the Inferred location card keeps it). A disabled start's reason that the line says
already (`NOT_ENABLED` under "Tracking is off", `PROVIDER_DISABLED` under "No tracking provider") is read out
(the button's description) but not shown again.

**F15-36 — Refusals outside a form say what they are.** A 422 without a form to show its fields said "Please
correct the highlighted fields". `ApiErrorMessage outsideForm` and `actionErrorMessage` (`utils/forms.ts`)
give the fields' own messages, translated: a start at a camera no longer usable, a place restored under an
archived one, a camera restored into an archived zone (`location_archived`), and the confirmations' alerts. A
refused start asks for the reception cameras again. A failed load of the cameras is said in the tracking card
(«تعذّر تحميل كاميرات الاستقبال» / "The reception cameras could not be loaded", with "Try again"), never as "No
reception camera".

**F15-37 — A path never ends a line with a chevron.** `LocationPath` keeps each chevron with the name after
it, so "Floor 3 › Meeting rooms" wraps as "Floor 3" / "› Meeting rooms" (seen at 320 px).

**F15-38 — Words.** DISABLED «غير مفعّل» (English stays "Off"); the health's TRACKING_OFF «التتبّع غير مفعّل»;
the key limit «يوجد مفتاحان قيد الاستخدام. أبطِل أحدهما أولًا.» (the key verb, not «ألغِ»); an empty timeline
«لا يوجد رصد» (English "No observations" unchanged); a starting association «طُلب البدء» / "Requested" with its
request time, instead of "Started" (approved and asked). The key's label in the Arabic dialog titles is wrapped
in FSI … PDI (U+2068 … U+2069, escaped in the catalog): «أُنشئ المفتاح «Shaheen pilot»» now keeps the label whole
and its guillemets on their sides when it wraps (seen at 390 and 320 px).

**F15-39 — Refusals stay said; Cancel clears them.** A refused start was said in the start's own block, which
the refetched journey replaced at once (the alert flashed and vanished): the start's mutation now lives in the
tracking card, which says the refusal until the next attempt or the page is left, whatever the action below it.
The two confirmations of a switch (turning tracking off; the platform owner's stop) clear a refusal on Cancel,
as on Escape, the close button and the backdrop.

**F15-40 — Small ones.** The Play icon is not mirrored (a play symbol does not point the reading way). A list
row says the date of a sighting of an earlier day (`withDate`), and "4m ago" never breaks inside («قبل 4 د»).

**F15-41 — Tests that could pass broken, and the new paths.** Vitest: exact Simulated counts (one a page; none
in a visit's line or tracking card; a row's only while the page has none); the line's four cases and the mark
alone without a frame; the mutation cache holds no key after "Done"; a visit's freshness from the server (600 s
→ "10m ago"); the filters-match-nothing state and its Clear; a filter change with a delayed answer keeps "4m
ago"; `agoSeconds` with an unknown time; a refused start (409 with the server's message, kept after the
refetch; 422 with the field's own message, the cameras asked again); the focus after a start, a stop, a refused
start, a key revoked, a camera and a place archived; the cameras' load failure and its retry; "Requested"; a
reason read out but not repeated; the confidence's label and the units' descriptions, below 1 % refused; Cancel
clearing a refusal (settings and the platform owner's card); a restore refused under an archived place, and of
a camera into an archived zone; `NOT_ACTIVE`; the Arabic words. Fixtures: an observation is confirmed with a
confidence (0.9) by default, as the server gives it (`testRoutes.ts`, `e2e/phase15-journey.spec.ts`). E2E:
the journey flow and the mocked spec count Simulated exactly (one a page; none on a row while the line says
it); the mocked spec checks the "Inferred location" column and, with `P15_SHOTS`, saves each scene at 320 px
too.

## Verification (2026-10-20, on the backend's final code)

| Gate | Result |
|---|---|
| `npx tsc -b` | clean |
| `npm run e2e:typecheck` | clean |
| `npx oxlint --deny-warnings` | clean |
| `npx vitest run` | 166 files, 2,291 tests, all passed (before this phase: 160 files, 2,187); `api.contract.test.ts` against the backend's regenerated snapshot, `auditVocabulary.test.ts` and `auditLabels.test.ts` against its final source |
| `npm run build -- --outDir <scratch> --emptyOutDir` | built; the journey's pages are chunks of their own (`JourneyPage` 6.3 kB, `JourneyDetailPage` 9.9 kB, `TrackingAdminPage` 36.4 kB); the app chunk 349 kB (99 kB gzipped; 323 kB after Phase 14: the catalogs are bundled, both languages, F10) |
| The image-equivalent build (the `.dockerignore` allowlist and its "never" patterns, `config/e2e*.test.ts` left out, the contract file beside it; `npm ci --ignore-scripts && npm run build` and the Dockerfile's guards) | 186 packages, built, `dist/index.html`, `sw.js`, `appearance.js`, `sw-precache-manifest.js`, a `.wasm`, no `.map`: 155 files. No source of `src/` or `config/` imports `e2e/` (the image's own tree is searched; only `config/e2eCalendarLines.test.ts`, which the image leaves out, does in the repository) |
| `npx playwright test --retries=0`, the whole suite (8700, `vms_e2e`) | 754 tests: 677 passed, 77 skipped (specs that run on one project only), 0 failed, 34.9 min (after Phase 14: 670 tests, 593 passed). The new ones: the journey’s flows (6), the permissions spec’s new checks, the accessibility spec’s journey and tracking pages for three roles on three viewports, the appearance spec’s four in Dark, and the mocked layout spec (39) |
| The mocked layout spec (`e2e/phase15-journey.spec.ts`, my own run of Vite on 5199, the API not running) | 39 passed (13 a viewport) |

The first full run (before the backend's last rule) had 754 tests: 674 passed, 77 skipped, 3 failed, 38.6 min.
The three were one test on the three viewports, broken by this phase: `quality/appearance.spec.ts` opens the last
page of its administrator's list as the e-mail texts editor ("the saved e-mail"), and the journey's pages had
been added after it. They now come before it; the test passed again on the three viewports, with the journey's
pages in Dark (15 passed). The journey's flows were run again after the backend's rule of 19:16 (ACTIVE with no
place right after the start): 6 passed, the new assertion included.

**Looked at.** The mocked spec's scenes with `P15_SHOTS` set (72: the list, a journey, the three tabs of the
administration and the platform owner's company page, in English and Arabic, light and dark, at 1440, 820 and
390 px), and 28 more of my own (the off state of a company not allowed in a yellow company's colours: the
banner, a disabled start with "Tracking not allowed", the switch with "Not allowed", the empty locations and
cameras; the key shown once in its dialog; a start with two reception cameras under "The tracking provider is
not connected"; 1440 and 390 px, English light and Arabic dark). What they changed: three Simulated marks on a
journey (the line no longer repeats the header's, F15-3); the visit card's "Open visit" lost an external-link
icon it should not have had and now returns to the journey; the floors' and zones' menus are quieter than the
building's (F15-15). Screenshots: the session scratchpad's `p15f/shots/mock/` and `p15f/shots/extra/`.

**After the lead's decisions (F15-24 … F15-28), the same evening.** `npx tsc -b`, `npm run e2e:typecheck` and
`npx oxlint --deny-warnings` clean; `npx vitest run` 166 files, 2,297 tests, all passed (`api.contract.test.ts`
against the snapshot with the two new fields); the affected E2E specs with `--retries=0` on 8700 / `vms_e2e`:
`flows/visitor-journey.spec.ts` and `flows/permissions.spec.ts` 11 passed; `quality/accessibility.spec.ts`,
`quality/appearance.spec.ts`, `phase15-journey.spec.ts` and the nine mocked specs whose sessions gained
`tracking_allowed`, on the three viewports, 473 passed, 28 skipped, 0 failed; the mocked spec alone 42 passed
(14 a viewport). The whole suite is left to the verification round. Looked at again: the mocked spec's 72 scenes
(the timeline newest first, «قديم», the list's "4m ago" from the server) and 16 new ones (`p15f/shots/extra2/`:
a company not allowed, whose shell has neither entry and whose `/journey` lands on Reception; allowed but off,
with the tab and "Tracking is off"; «غير متصل» / "Not connected" under the provider's line; 1440 and 390 px).

**After the independent review (F15-29 … F15-41), on the backend's final code and snapshot (20:57).**

| Gate | Result |
|---|---|
| `npx tsc -b`, `npm run e2e:typecheck`, `npx oxlint --deny-warnings` | clean |
| `npx vitest run` | 166 files, 2,318 tests, all passed (`api.contract.test.ts` against the final snapshot; `auditVocabulary.test.ts` and `auditLabels.test.ts` against the backend's final source, `JOURNEY_LIST_VIEWED` and its `day` and `located` included) |
| `npm run build` (to a scratch folder) | built |
| The image-equivalent build | 186 packages, built, the Dockerfile's guards passed: 156 files in `dist` (`JourneyPage` 6.5 kB, `JourneyDetailPage` 10.4 kB, `TrackingAdminPage` 37.3 kB); no source of `src/` or `config/` imports `e2e/` |
| `npx playwright test --retries=0`, the whole suite (8700, `vms_e2e`) | 757 tests: 680 passed, 77 skipped (specs that run on one project only), 0 failed, 34.0 min |
| The mocked layout spec alone (Vite on 5199) | 42 passed |

**Looked at.** The mocked spec's 144 scenes (`p15f/shots/review/`: each at its viewport and at 320 px, both
languages and schemes): Simulated once a page, no chip in a visit's header, the "Inferred location" column,
a wrapped path with its chevron on the next line, «قديم» and the other chips at 320 px, the settings with
"(%)" in the label and the units beside their fields. And 8 of the key dialogs (`p15f/shots/extra3/`, 390 and
320 px, Arabic and English): the isolated label keeps «Shaheen pilot» whole between its guillemets when the
title wraps. One fix came from them: «قبل 4 د» broke after «قبل» at 320 px (F15-40).

## Open items

- *Settled by the lead (F15-24 … F15-28): the tab on production (only while allowed), "how long ago" in the
  list (the server's), a long journey's order (newest first), the floors (the server's order), and the words
  for STALE, UNAVAILABLE, LOST and a key.*
- **The other Arabic words of this phase** («لم يبدأ», «قيد البدء», «طُلب البدء», «لم يبدأ بعد») are worth a
  native reviewer's look, as earlier phases' were.
- **A platform owner's change reaches an open session** when `/auth/me` is asked again (the window regains
  focus, or a reload), not at once; the API is the guard meanwhile (F15-24).
- *A key's label inside the Arabic title: isolated (FSI … PDI) since the review (F15-38). Other Arabic
  sentences of the app with a Latin name in them are as before.*
- **A refused start is said until the next attempt** (F15-39): after a refusal whose cause then goes away by
  itself, the card still says it until the page is left or started again.
- **No real provider exists** (BLOCKED BY ENVIRONMENT): nothing here was seen against real cameras or a real
  model; the screens are checked against the simulator and mocked answers only.
