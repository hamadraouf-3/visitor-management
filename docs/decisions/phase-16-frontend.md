# Phase 16 — frontend decisions (live tracking, allowed areas and area alerts; the provider still off in production)

Date: 2026-10-21. Scope: `frontend/**` (the live map and its panel, a visit's path, the tracking alerts and the
shell's watcher in `src/features/journey/**`; a visit's allowed areas in the new `src/features/accessAreas/**`;
the invitation and walk-in forms, a visit's page; the administration's access levels, department floors and
area-alert settings; the kit's `Sheet`, the toast's action, the navigation's count; the types, the API module,
the catalogs, the audit vocabulary, the unit tests and `e2e/**`), `frontend/README.md` and this file. Contract:
the Phase 16 contract, section D and the frontend's parts of E, with the backend's settled shapes (§C) and its
clarifications (`phase16-api-shapes-changes.md`, 2026-10-21 09:56 UTC: no shape change). The rules of the earlier
phases hold: direction C with the existing kit, Arabic (right to left, the default) and English from the
catalogs, logical CSS properties only, `style-src 'self'` and `script-src 'self'`, light and dark, 320 px to
desktop, 44 px targets, **no explanatory notes**; and Phase 15's hard rules: no fabricated location (the map and
the alerts use only the journey's confirmed place), no image, the simulator's data always marked «محاكاة» /
"Simulated", nothing that claims live tracking works with a real model.

Each entry records what was built and every interpretation of, or deviation from, the contract.

---

## /journey: the live map

**F16-1 — Two views, the live map first.** `/journey` opens on «الخريطة الحية» / "Live map"; «القائمة» / "List"
is Phase 15's list, `?view=list` (`journeyView.ts`). The switch is the kit's tabs under the title (a tab list and
its panel, as the tracking administration's), and a switch drops the list's page from the address (a page of the
list means nothing on the map); the list's day and state stay. A row's link keeps `?view=list` in its back link.

**F16-2 — One building at a time, in the address.** The map shows one building (`?building=`); the live answer
is the whole company's, `GET /journeys/live` without `building_id`, and the map places each visitor in their
building itself (since the review, F16-36: asked for one building, the server left out a visitor last seen in a
building the map cannot show, and "No location" and "Not tracked" changed with the building). The cap of 1000
applies to the company. The default is the first active building that has an active floor, in the server's order
(by name); the building select is shown only when there are several. Asked again every 15 s (paused in a
background tab); the first load is the person's request, every later one a background refresh
(`X-Background-Refresh: 1`), so a map left open on a reception screen still reaches the session's idle timeout,
as the evacuation list does; the page's tracking line and an open panel's journey poll the same way (F16-37). The
header says "Updated 13:50:52" (the server's `generated_at`, company time, to the second, `LiveIndicator`) and how
many are inside (the company); `truncated` adds "First n shown" (a fact).

**F16-3 — Where a visitor is drawn** (`liveMapModel.ts`, from the server's state and confirmed place only):

| State | Place | Drawn |
|---|---|---|
| ACTIVE, STALE, UNCERTAIN | a confirmed place | in its zone's tile (STALE and UNCERTAIN as "not recent", F16-5) |
| ACTIVE, UNCERTAIN | none | «بدون موقع» / "No location" |
| PENDING, UNAVAILABLE | any | «بدون موقع» / "No location" |
| NOT_ENROLLED, ENDED, DISABLED | any | counted in «غير متتبَّع» / "Not tracked" |

The contract names NOT_ENROLLED for "Not tracked"; ENDED (stopped or expired) and DISABLED (tracking off) are
counted there too: a place they once had is history, not where the visitor is now. UNAVAILABLE is in "No
location" even with a place, as the contract lists it: the provider is not connected, its last place cannot be
relied on. A visitor seen in a zone or on a floor archived since gets a tile (or a band) of its own, marked
«مؤرشفة» / "Archived", and is never dropped; one last seen in a building the map cannot show (archived, or every
floor of it archived) gets a band of its own on every building's map, headed "building › floor" (F16-36). "No
location" and "Not tracked" are the company's, whichever building is shown.

**F16-4 — Floors and zones.** The building's active floors stacked highest level first, each a card (a band) with
its name and its visitors' count («زائران») (no level beside the name since the owner's follow-up, F16-32); its active zones as tiles in the server's order (by
name), two a row from 640 px, three from 1536 px; an empty zone a quieter tile. A zone's access level
(`ZoneAccessBadge`, `zoneAccess.ts`): «عامة» / "Common" (blue, a door) and «مقيّدة» / "Restricted" (amber, a
lock) are marked, "Standard" (the default) is not. Restricted is amber, never the alerts' red: it says something
about a place, an alert about a person.

**F16-5 — A visitor's chip** (`LiveVisitorChip`): a button, at least 44 px, with the initials and the name (cut at
12 rem, the whole name in its accessible name), which opens the visitor's panel. An active alert (open or
acknowledged, as the contract asks) makes it the alerts' red with a warning sign; STALE is dashed and quieter
with a clock and how long ago ("25m": the server's freshness counted on, F15-27), UNCERTAIN dashed with a question
mark. Not "dimmed" with opacity: the text keeps its contrast. A simulated visitor has a flask only when the page's
line does not say Simulated already (F15-35: once a page). Each sign has its words for assistive technology
("Omar Saleh, Alert"; «Omar Saleh، تنبيه»). In a tile, visitors with an alert come first, then by name.

**F16-6 — Empty states.** No active building with a floor: «لا توجد أماكن بعد» / "No locations yet", with «إعداد
الأماكن» / "Set up locations" (`/admin/tracking?tab=locations`) for an administrator only; no live request is
made. Nobody inside: «لا أحد في الداخل» / "Nobody inside" — when nobody is inside the company (the answer is the
company's, F16-36; while another building has visitors, the shown building's empty floors are drawn). A failed
load: the kit's error with "Try again".

**F16-7 — A visitor's panel** (`LiveVisitorPanel`, in the new kit `Sheet`): a modal side panel on the inline-end
side from 1024 px (left in Arabic), a bottom sheet below; the panel itself takes the focus (its name is read
first, nothing is pressed by mistake); Escape and the close button give the focus back to the chip (the
visitor's chip where it is now, F16-41). It reads the visit's journey (`GET /visits/{id}/journey`, audited as a
journey's opening, asked again every 15 s as a background refresh, F16-37): the state's
chip and the company under the name; the active alert in a red frame with its actions (reception and
administrators); the host; the place under «موقع مُستنتج» / "Inferred location" (the contract says "current
location": the place is inferred, F15-5 asks for the visible sign everywhere it is shown) with when and how long
ago; the allowed areas with "Edit" when the server allows it (F16-14); the path (F16-8); «الرحلة الكاملة» / "Full
journey" in the footer, which returns to the map.

**F16-8 — The path** (`JourneyPath`): the stays as the server collapses them, oldest first (read as a route; the
timeline stays newest first, F15-25): floor › zone, its access level when marked, from–to (or one time) and how
many observations; a stay outside the visit's allowed areas (as they are now) in the alerts' red, a red dot and
«خارج المسموح» / "Outside allowed area" (icon and words, never the colour alone). Without a stay: «لا يوجد موقع
مؤكد بعد» / "No confirmed place yet".

## A visit's journey

**F16-9 — Its allowed areas, alerts and path.** The side column gains «المناطق المسموحة» / "Allowed areas" (between
the tracking and the visit), "Edit" when `can_edit_access_areas`; the main column the visit's alerts after the
inferred location (only when the visit has had one; the active one first, then the server's order) and the path
before the timeline. On one column: the location and the alerts, the tracking, the areas and the visit, then the
path and the timeline. An alert on its visit's own journey (and panel) shows neither the visitor's name nor
"Open journey", nor the allowed floors (the Allowed areas card is beside it). The timeline's confirmed places
outside the allowed areas (`allowed === false`) have a red dot, their place in red and «خارج المسموح».

## /journey/alerts: the tracking alerts

**F16-10 — The page** (`TrackingAlertsPage`): «تنبيهات التتبّع» / "Tracking alerts", the page's tracking line
(Simulated once), tabs «النشطة» / "Active" (open and acknowledged, any day) and «حسب اليوم» / "By day" (a day's,
any status; the date field, today by default, no later day), both in the address (`?scope=day&day=`), 20 a page,
asked again every 15 s. A card an alert: the visitor and the company, the type chip and the status chip, the host,
«المكان» / "Where" (where it opened → where the visitor was seen last, the building once when it is the same one,
a restricted zone marked), since and last seen (the time; with the date on another day), the observations, the
allowed floors, the latest note, who acknowledged it and when, how it was resolved, by whom and when
(«تلقائيًا» / "Automatically" when the system did), its actions, and «فتح الرحلة» / "Open journey" (back to the
alerts). An open alert's card has the alerts' red edge. Empty: «لا توجد تنبيهات نشطة» / «لا توجد تنبيهات في هذا
اليوم»; a 403 has its own state.

**F16-11 — Acting on an alert** (`AlertActions`): «تأكيد الاطلاع» / "Acknowledge" while open, «إغلاق» /
"Resolve" while not resolved, for reception and administrators (`can_act`); management reads only. Each asks in a
dialog for an optional note (one line, at most 300 characters, counted; a longer one is refused at the field) and
sends `{ note }` (null without one). A refusal (409 `ALERT_RESOLVED`: resolved meanwhile) is said in the dialog in
the server's words; the alerts and journeys are asked again at once after a success, and after a refusal once its
dialog is closed (F16-33). The dialog belongs to the list that shows the alert, so it stays while the alert leaves
the list. When an action takes away the focused button, the focus goes on to the one left, else to the page's
heading (F15-32); when it takes away the whole card, to the card now in its place, else the heading (the panel
itself in the live map's panel, F16-34).

**F16-12 — Words** (`alertLabels.ts`; the contract's where it gave them): types «منطقة غير مسموحة» / "Unauthorized
area" (a crossed pin) and «منطقة مقيّدة» / "Restricted area" (a shield), both red; statuses «مفتوح» / "Open" (red,
a bell), «اطُّلع عليه» / "Acknowledged" (amber, an eye), «مُغلق» / "Resolved" (grey, a check); resolutions «عاد إلى
منطقة مسموحة», «تغيّرت المناطق المسموحة», «خرج الزائر», «أغلقه الموظف» / "Returned to an allowed area", "Allowed
areas changed", "Checked out", "Resolved by staff"; `ALERT_RESOLVED` «أُغلق هذا التنبيه من قبل.» «تنبيهات التتبّع»
is written with the shadda, as «التتبّع» everywhere in the app (the contract wrote it without). In the Arabic
sentences that carry a name («تنبيه: {name} في {place}», the dialogs' titles, «{name}، {when}») the name and the
place are isolated (FSI … PDI, escaped in the catalog, F15-38), so a Latin name keeps its comma and time in place.

## The shell: the navigation's count and the alert watcher

**F16-13 — «تنبيهات التتبّع» in the navigation, with a count.** A second entry after "Visitor Journey" (order 56,
the same roles and the same `requiresTracking`). `NavEntry.badge` (new) is a component the feature draws, which
reads its own data: `TrackingAlertsNavBadge` renders the kit's new `NavBadge` with the **active** count, in the
status red with white figures while any alert is **open**, quiet (the shell's tint) while every one is
acknowledged, nothing at zero; the figure is hidden from assistive technology and its words are read instead
("Tracking alerts 3 active alerts"). It reads the watcher's cache entry and asks for nothing itself. The
navigation now marks only the most specific matching entry as the current page (`currentEntry.ts`): on
/journey/alerts "Tracking alerts", on /journey/{visit} "Visitor Journey", never both.

**F16-14 — Shell extensions.** `FeatureModule.shell` (new): a component a feature runs on every page of the company
shell, mounted by `AppLayout` for the roles it names (and only while tracking is allowed, when it says so), never
while a password change is required, keyed by the person (a new session starts it afresh). The journey feature's
is the alert watcher.

**F16-15 — The watcher** (`TrackingAlertWatcher`, `alertWatch.ts`): `GET /tracking/alerts/summary` every 15 s, also
in a background tab, always as a background refresh (`X-Background-Refresh: 1`: never the person's activity; the
backend's clarification 7). The first answer after the shell starts only sets the count and the title. Then an
open alert not told of before — by its id, **and again when it is escalated** (its type becomes Restricted area:
the server opens it again and e-mails again; an addition to the contract's "id not seen before") — is told of
once: a danger toast «تنبيه: {visitor} في {floor › zone}» (kept until dismissed, said in the assertive region,
"Simulated" under it for the simulator's), with «عرض» / "View" (the visit's journey); one short beep for the
answer that brought news, when the viewer's sound is on; a notification of the operating system when the viewer
turned them on and the browser granted it (tagged with the alert's id; a click focuses the tab and opens the
journey; closed when the watcher goes, F16-39). While alerts are open the tab's title starts with "(n) " (n open).
What was told is kept for the mounted session (memory): a reload starts again from the first answer, which tells
nothing; when that answer could not name every open alert (more than 5), one never seen that sorts before its last
(by `escalated_at ?? opened_at`, the summary's order) is taken in without a word (F16-38).

**F16-16 — The toast's action** (kit): `ToastOptions.action` (label, callback), a small secondary button under the
text that acts and dismisses the toast. The toasts live above the router, so the watcher navigates.

**F16-17 — The title's prefix** (`hooks/documentTitle.ts`): the page's title (`useDocumentTitle`) and the shell's
prefix are kept apart and written whole, so neither overwrites the other; a title written directly (the first
page's HTML, a test) becomes the page's part.

**F16-18 — The sound** (`beep.ts`): a two-note tone (880 then 660 Hz, about half a second, at a moderate level) made
with the Web Audio API; no sound file is shipped or fetched. Browsers allow a page's sound only after a gesture on
it: the audio context is created at the page's first press or key, and a new alert before that is shown and
notified without a sound. No dependency.

**F16-19 — The viewer's settings** (`alertPreferences.ts`, `AlertSettings`): «صوت التنبيه» / "Alert sound" (on by
default) and «إشعارات المتصفح» / "Browser notifications" (off by default), switches that take effect at once
(F15-12) on the alerts page, kept in local storage under the person's id (`vms.trackingAlerts.{sound|notifications}.{user}`:
two people sharing a reception tablet keep their own), every read and write guarded; when the storage refuses, the
choice holds for the page's life; another tab's change is followed. Turning notifications on asks the browser's
permission; refused or absent, the switch stays off, disabled, with «محظورة في المتصفح» / "Blocked by the browser"
or «غير مدعومة» / "Not supported" beside it (its description).

## A visit's allowed areas

**F16-20 — One picker** (`AccessAreasPicker`, `accessAreas.ts`): a group «المناطق المسموحة» / "Allowed areas";
the floors as checkboxes by building (the building named only when there are several) in level order, two a row
from 640 px, 24 px apart on touch screens so each 44 px row stays whole; then «مناطق إضافية» / "Extra zones": the
kit's combobox over the active zones (each "floor › zone", a restricted or common one marked), searched by the
zone's names in either language, its floor and its building (case, Arabic diacritics and alef forms ignored);
a chosen zone becomes a chip with its own remove button («إزالة …»; the focus then goes on to the next chip's,
else the search, F16-44). Only active places are offered (an archived one is refused by the server), and only
those are held: a place archived after it was chosen drops out of what is shown and sent (F16-43). Shown nowhere
while the company has no active floor.

**F16-21 — The forms.** The invitation (a host, an administrator) and the walk-in (reception) show the field only
while `me.company.tracking_allowed` and the company has an active floor (`useFormAccessAreas`; `GET /locations`,
which every role reads since Phase 16, a host the active places only). It starts from the chosen department's
floor (an archived floor is skipped, as the server does) and follows a new department **until the person changes
the field** (the form keeps `accessAreas: null` until then: no stored copy to go stale). It is sent only while
shown, and then always as it shows (`access_areas`, explicit even when it equals the default, so what is sent is
what was seen). The server's refusals on `access_areas.floor_ids` / `.zone_ids` are said at the field, which gets
the focus, and the places are asked for again (F16-43). The walk-in's "Clear form" starts it from the department
again.

**F16-22 — Changing a visit's areas** (`AccessAreasDialog`, `AllowedAreasCard`): "Edit" when the server says
`can_edit_access_areas` (an administrator, reception, or the visit's host, while scheduled or inside) and the company
has a floor to allow; a dialog with the picker, starting from the visit's **active** areas (an archived one cannot
be sent again, and nothing is observed there); the visit's very sets (archived places included) close it without a
request, so a visit holding an archived place is saved without it, and can be cleared (F16-42); a change is sent
(`PUT /visits/{id}/access-areas`), «حُفظت المناطق المسموحة» / "Allowed areas saved"; the answer (the visit)
replaces the page's, and the journeys, the live map and the alerts are asked again (a change may resolve the active
alert or raise one; since the backend's review, only reception's and an administrator's change can open or escalate
one, a host's can only resolve it: the page needs nothing for that). A refusal (a 422 on `floor_ids`/`zone_ids`) is
said in the dialog in the server's words, and the places are asked for again (F16-43); a visit that ended meanwhile
(409 `VISIT_NOT_EDITABLE`, whose general words are about a scheduled visit's edit) in the dialog's own (F16-42).

**F16-23 — Showing them** (`AllowedAreasList`): the floors, then the extra zones as floor › zone with their access
level when marked; the building named only when they span several; an archived one marked; «غير محددة» / "Not set"
when there is none. On a visit's page («المناطق المسموحة» in the side column, after the pass) only while the
company's tracking is allowed: nothing reads them otherwise.

## Administration (built in the same tree by a second agent of this phase, reviewed here)

**F16-24 — A zone's access level.** The zone dialog has «الوصول» / "Access" (Standard, Common, Restricted; Standard on
create), sent as `access`; floors and buildings have none. The locations editor shows every zone's level, Standard
included (the administrator sets them; the map marks only the exceptions, F16-4).

**F16-25 — A department's floor.** While tracking is allowed, the departments list has «الطابق» / "Floor": a select
a department («طابق المالية» / "Floor of Finance"), saved when chosen (`PATCH /departments/{id}` `floor_id`, null for
«بدون طابق» / "No floor"), busy (never disabled: it keeps the focus) while saving, the answer written into the list
at once (F16-45), a toast either way; a refusal puts the saved floor back with the field's own message. The options: no floor, then the active floors by level, grouped by building only when there are
several; a current floor that is archived (or not offered) stays listed, «(مؤرشف)». With the column, the rows
become cards below 1280 px (five columns crowded the buttons at 1024). Without tracking nothing changes and
`/locations` is not asked for.

**F16-26 — Area alerts' settings.** A card «تنبيهات التتبّع» / "Tracking alerts" in the settings: «تنبيهات المناطق» /
"Area alerts" and «إبلاغ المضيف بالبريد» / "Email the host", switches that save at once (turning alerts off ends
nothing, so no confirmation); «بريد التنبيهات» / "Alert emails", a list of at most five addresses with its own Save and
Discard (sent only when the list changed): an address is checked when added (valid, lower-cased, not listed twice,
five at most; at five the field and "Add" wait with «5 عناوين على الأكثر», "Add" taking the focus, F16-46), each has
its remove button (the focus goes
on to the next, else to the field); the server's refusal at `alert_emails.<index>` is said at the field (the backend's
clarification 1). The list's Save and Discard keep their visible words and are named "Save changes to alert
emails" / "Discard changes to alert emails", so the page has no two buttons of one name. Leaving with the list
unsaved asks first, as the thresholds.

**F16-27 — The audit log** has words for the five new actions in the tracking group (`TRACKING_ALERT_OPENED`
«فتح تنبيه تتبّع», `…_ESCALATED` «تصعيد تنبيه تتبّع», `…_ACKNOWLEDGED` «الاطلاع على تنبيه تتبّع», `…_RESOLVED`
«إغلاق تنبيه تتبّع», `VISIT_ACCESS_AREAS_CHANGED` «تغيير المناطق المسموحة لزيارة»), the new metadata keys and values
the backend writes (the alert types, statuses and resolutions, the access levels, the new changed fields, the live
view `view: LIVE` «الخريطة الحية» of `JOURNEY_LIST_VIEWED`, the rate-limit policies `tracking_alert_emails_per_company_day`
and `tracking_alert_notices_per_visit` «رسائل تنبيهات التتبّع لكل زيارة في الساعة» / "Tracking alert emails per visit
per hour", the lead's words), all in Arabic without Latin letters
(`auditVocabulary.test.ts` reads them from the backend's source and enums). No "Tracking alert" record type in the
filter: the backend files the alert events on the visit.

## The API in the client

**F16-28 — Types** (`types/api.ts`): the snapshot's new names (`TrackingAlert`, `TrackingAlertSummary`,
`LiveJourneys`, `VisitAccessAreasInput`, `TrackingAlertAction`, `TrackingAlertListParams`, `LiveJourneyParams`,
`TrackingAlertPage`), the enums as aliases checked through their models (`ZoneAccess`, `TrackingAlertType`,
`TrackingAlertStatus`, `TrackingAlertResolution`), the changed shapes (`ZoneRef` with `access`, `Zone`,
`Department.floor`, `Visit.access_areas`, `can_edit_access_areas`, `VisitCreate`/`WalkInCreate.access_areas`, the three
settings, `JourneyListItem.alert`, `VisitJourney`'s four fields, `JourneyEvent.allowed`), `ALERT_RESOLVED`. The nested
shapes are not exported (F15-18) and the features name them from the responses (`journey/types.ts`). Built against
§C before the backend existed; its snapshot then matched on the first run (124 contract tests), so nothing was
asked of it. `api/tracking.ts` and `api/visits.ts` have the six new calls; the query keys `tracking.alerts.*` and
`journeys.live`. `GET /locations` is one cache entry for the administration, the map and the pickers.

**F16-29 — No new dependency.** The sound is the Web Audio API, the notifications the browser's, the sheet the kit's
modal behaviour.

## Tests

**F16-30 — Unit tests (Vitest).** New: `journey/liveMapModel.test.ts` (each state's placement, floors highest first,
zones in order, counts, alerts first, archived tiles and bands, another building left out, the default building),
`journey/LiveMap.test.tsx` (the map with its marks and counts, "Updated 12:00:00", the alert and not-recent chips,
Simulated once or on the chip, the buildings in the request and the address, both empty states, the switch to the list
and back, a failed load; the panel with its path, alert and areas, acknowledging with a note, editing the areas,
management without actions, Arabic), `journey/alerts/alertWatch.test.ts` (first answer, new id, escalation, the
title's prefix), `alertPreferences.test.ts` (defaults, per person, a refusing storage, notifications' support and
permission), `TrackingAlertsPage.test.tsx` (the cards' facts, the day tab in the request and the address, acknowledge
then resolve with the focus on the action left, a 409 in the dialog, a note too long, management, the empty states,
the two switches and a blocked browser, Arabic), `TrackingAlertWatcher.test.tsx` (the first answer, a toast whose
View opens the journey and a beep, once; escalation; sound off and a notification; the quiet badge and the title;
the current page; nobody else runs it), `accessAreas/accessAreas.test.ts` (what is offered, the department's
default, a visit's active areas, toggles, the request, the search), `components/ui/Sheet.test.tsx`,
`layouts/currentEntry.test.ts`, `hooks/documentTitle.test.ts`, the toast's action. Extended:
`JourneyPage.test.tsx` (the list at `?view=list`; a visit's areas, path, alerts, timeline marks, management),
`InviteVisitorPage.test.tsx` (the field hidden while not allowed or without a floor, the department's floor followed
until changed, extra zones added and removed, a refusal at the field), `ReceptionWalkIn.test.tsx`,
`VisitDetailPage.test.tsx` (the card, «Not set», an archived area, editing, a refusal), `AppLayout.test.tsx` (the
order), `api.contract.test.ts`, `catalogs.test.ts`, `noImages.test.ts` (now also `accessAreas/`), and the
administration's (F16-24 … F16-27).

**F16-31 — End-to-end (Playwright).**
- **`e2e/flows/area-alerts.spec.ts`** (the real API, serial, five tests) in **a company of its own**
  (`e2e/support/area-alerts.ts`: the platform owner creates and allows it; its administrator turns tracking on with
  a threshold of 0.5 and an alert address, and makes a building with a common reception, floor 2 and floor 4 with a
  server room, a camera a zone, a department and its people): the shell's watcher of the seeded company's reception
  and administrators runs in every other spec, and an alert there would toast over their pages. The administrator
  marks the server room restricted and puts the department on floor 2 through the pages; a host of that department
  invites a visitor (the picker starts from floor 2; the host has no alerts tab and the API refuses them), reception
  checks in and starts the tracking, and `simulate-journey --cameras` walks the visitor onto floor 4 (one floor a
  run: two floors within 60 s would make the journey uncertain): the toast, the count, the title, the red chip on
  floor 4, the panel's red stay, the toast's View, acknowledge with a note then resolve on the alerts page, and the
  e-mails (the alert address with the journey's link and "[Simulated]", the host without it); the server room
  escalates an acknowledged alert (said again) and widening the areas on the journey resolves it (`AREAS_CHANGED`);
  the check-out resolves the active one (`CHECKED_OUT`, by whoever checked out: the backend records the actor);
  management reads without an action; Arabic on a phone (map, panel, alerts); axe and no sideways scroll on each.
- **`e2e/phase16-alerts.spec.ts`** (mocked, only Vite): the map and the panel, the alerts and a journey, the
  invitation's areas, the administration's access levels, department floors and alert settings, in both languages
  and schemes at the three viewports, with axe, no sideways scroll at the viewport and at 320 px, and every control
  a tap reaches over 44 px on the tablet and the phone; management without actions. With `P16_SHOTS` it saves each
  scene.
- **Changed**: the journey flows (the map first, the list with its tab; a company without places: «لا توجد أماكن
  بعد»; the retention's "Save changes" named exactly), `permissions.spec.ts` (the new link for reception, management
  and administrators; a host refused the live map and the alerts, and reading the active places only; management
  refused acknowledging, resolving and changing areas), `accessibility.spec.ts` and `appearance.spec.ts` (the map,
  the list and the alerts page), `phase15-journey.spec.ts` (the list at `?view=list`, the summary mocked), the
  mocked visits and departments of the layout specs (their new fields), the global setup's warm-up.

## The owner's follow-up (2026-10-21)

**F16-32 — No floor level as a bare number.** Each floor band of the live map had the floor's level in a small
rounded chip beside its name (4, 2, 0); it read as a visitor count ("0" on a floor that holds a visitor). The chip
is gone: the band's header is the floor's name and its visitors' count, as before. The same rule elsewhere: the
locations editor showed each floor's level as a bare number in a tile beside the floor; it is now a chip in words
beside the name, «المستوى 4» / "Level 4" (the administrator sets the level, so it stays shown). No other screen
shows a level. Vitest holds both (the band's header has only the name and the count; the editor's floor says
"Level 3"); the live map's and the editor's screenshots were taken again.

## Review fixes (2026-10-21)

A review of the phase's frontend found these; each is fixed with a test that fails without it (checked by putting
the old code back for each one), and none changes an API shape.

**F16-33 — The action dialog belongs to the alert's list, and stays while the alert leaves it.** The acknowledge
and resolve dialog was the card's (`AlertActions`), and the card goes when its alert does: on the Active tab once
resolved, on a journey the actions once resolved, in the live map's panel the whole alert. A 409 `ALERT_RESOLVED`
asked for the alerts again at once, and one round trip later the dialog, with the refusal it was saying, was gone
and the focus on the page's body; the same with the 15 s refresh while a note was being typed. Now
`AlertActionDialog` is rendered by the list that shows the alert (the alerts page, a journey's alerts card, the
panel), which keeps the alert asked about; the card's buttons only say which action (`onAct`). A refusal asks for
nothing until its dialog is closed (`useRefreshAlerts` on closing; a success still asks at once), so the card the
person acted on stays behind the dialog until they have read why. *Tests*: the 409 on the alerts page, on a journey
and in the panel, with the list's (journey's) refresh coming back without the active alert while the dialog is
open; the list is asked again only once the refused dialog is closed.

**F16-34 — The focus after an action that takes the alert away.** The focus's way on lived in `AlertActions`' own
effect, which does not run once the card or the panel's alert has gone with it: after a resolve the focus fell to
the page's body. Now: on the alerts page the list keeps it (`useListFocusRecovery`, each card a row, no fallback
field: the card now in its place, its first action, else the page's heading), armed when the dialog closes after a
success or a refusal, or while its alert has left the list; on a journey the actions stay mounted (drawing nothing
when none is left) so their effect gives the heading the focus, and the alerts card gives it the heading when a
dialog closed onto a button gone meanwhile; in the panel, the panel itself takes it (the page's heading is behind
the modal sheet), checked after each render. *Tests*: two cards resolved one after the other (the next card's
Acknowledge, then the heading); a journey's resolve (the heading); the panel's resolve and refusal (the panel).

**F16-35 — Past the alerts' last page.** An empty page with alerts beyond it (the last one's alerts resolved, an old
link) said «لا توجد تنبيهات نشطة» / "No active alerts" without the pages. Now, as the journeys' list: «هذه الصفحة
فارغة» / "Nothing on this page" with «الانتقال إلى الصفحة الأولى» / "Go to the first page" (the list's own
words), and the pages whenever there are alerts. *Test*: `?page=3` of 21.

**F16-36 — The live answer is the company's; the map places the visitors itself.** Asked for one building, the
server left out every visitor last seen elsewhere: one last seen in a building the map cannot show (archived, or
every floor of it archived) was in no building's answer, nowhere on the page and not counted ("Nobody inside" with a
visitor inside), and those under "No location" (UNAVAILABLE) and "Not tracked" (ENDED, DISABLED) with a place in
another building changed with the building shown, although the model says that place is unusable history. Now
`GET /journeys/live` is asked without `building_id` (one cache entry, `journeys.live`); `liveMapModel` takes the
buildings the map shows and draws a visitor of another one on that building's map, and one of a building it cannot
show on every building's map, in a band headed "building › floor" marked «مؤرشفة» / "Archived"; "No location" and
"Not tracked" are the company's, and "Nobody inside" means nobody in the company (F16-6). *Tests*: the model (a
shown building's visitor left out, an archived building's band, the aside's counts), the map (one request without
`building_id` for both buildings, the archived building's band, the counts unchanged by the building, no "Nobody
inside" while another building has visitors, the truncated line).

**F16-37 — Every poll after the first load is a background refresh.** The tracking line's status (every 60 s, on
the map, the alerts and a journey), a journey's own poll (15 s, also an open panel's) and the day's list were sent
as the person's own requests, so a screen left open never reached the session's idle timeout (the map's own poll
had the header; the status poll beside it cancelled it). Now `useTrackingStatus`, `useVisitJourney` and
`useJourneyList` send `X-Background-Refresh: 1` on every fetch after their first answer (`isBackgroundFetch`, as
the reception lists). *Tests*: the map, the status and the panel's journey (the first without the header, every
later one with it), and the list.

**F16-38 — The watcher's cut-off.** The summary names the five newest open alerts. With more open at the first
answer, an older one moved up into the five when a newer one was acknowledged, and was told of as new (a toast, a
beep, a notification for an alert older than the session). Now the first answer keeps a cut-off when it could not
name every open alert: its last brief's sort key, **`escalated_at ?? opened_at`, the key the summary is ordered by**
(B16-26), so every alert it left out sorts before it. An alert never seen whose key is older than the cut-off is
taken in silently; a new opening is told (its key is newer); an escalation is told, because its key (its
escalation) is newer than the cut-off, also for an alert the first answer left out, or because a seen alert's type
became Restricted area, whatever its key (an escalation by the previous release keeps a null `escalated_at`). The
cut-off was first the last brief's `opened_at`, the summary's order then. Once the summary sorted by escalation,
that went wrong twice with more than five open (B16-26): an escalation as the first answer's last brief put the
cut-off at its opening, before its place in the order, so an alert left out that opened between the two was told
as new when it moved up; and an alert left out that escalated during the session came first but was taken in
silently. The brief's `escalated_at` (an additive field, B16-26) fixed both. The review also proposed seeding from
the whole active list: the cut-off makes it unnecessary (no extra request at each start). A key exactly equal to
the cut-off counts as newer (the summary breaks such a tie by id, which the watcher does not mirror). *Tests*: the
pure step (the cut-off only when some alert was left out; an older one moving up; a new one still told; an
escalation of one seen older than the cut-off; an escalation as the first answer's last brief, the cut-off its
escalation, an alert opened between its opening and its escalation taken in silently when it moves up; an alert
left out of the first answer told once when it escalates; the last two each failed on the previous step) and the
watcher with six open, one acknowledged.

**F16-39 — The operating system's notifications end with the session.** A notification («تنبيه: {visitor} في
{floor › zone}») stayed in the system's notification centre after signing out on a shared computer (the in-app
toasts are reset at an identity change; these were not), and its click still opened the journey. Now the page
keeps the notifications it showed (until clicked or closed by the system) and the watcher closes them when it goes:
signing out, the session's end, another person, tracking withdrawn. *Tests*: the watcher (a notification's click
opens the journey; unmounting closes those shown); the notifications themselves (nothing when the permission is no
longer granted, a constructor that throws, the click, closing all but those the system closed).

**F16-40 — The view switch keeps the focus.** The map and the list are different pages under one tab list, so a
switch unmounted the tab that had the focus. Now a switch made on the tabs gives the new view's selected tab the
focus (never a page's first load). *Test*: arrow keys from "Live map" to "List" and back.

**F16-41 — Closing the panel gives the focus to the visitor's chip where it is now.** The sheet returned the focus to
the chip it was opened from; when the refresh had moved the visitor to another tile (or "No location"), that chip
was gone and the focus on the page's body. Now the map gives the focus to the visitor's chip, wherever it is, else
the page's heading (checked out meanwhile). *Test*: the visitor moved to the server room while the panel was open.

**F16-42 — Changing a visit's areas.** (1) The dialog compared the choice with the visit's *active* areas, so a
visit whose only areas were archived could never be cleared (nothing checked equalled nothing active: no request,
the alerts kept coming). It now compares with the visit's very sets; a visit holding an archived place is saved
without it. (2) The 409 `VISIT_NOT_EDITABLE` of a visit that checked out meanwhile said «لا يمكن تعديل إلا الزيارات
المجدولة.» / "Only scheduled visits can be changed." (the visit edit's words), wrong for areas, which a checked-in
visit may change: now «انتهت هذه الزيارة؛ لم يعد بالإمكان تغيير مناطقها المسموحة.» / "This visit has ended; its
allowed areas can no longer be changed." *Tests*: clearing a visit whose only floor is archived; the 409's words.

**F16-43 — A place archived after it was chosen.** The places are kept for minutes; a floor or zone archived since
it was chosen stayed in what the form or the dialog held but was drawn nowhere (an extra zone's chip vanished), so
every submit was refused with nothing to remove. Now the picker holds only what it offers (`offeredSelection`, in
`useFormAccessAreas` and the dialog), and a 422 naming `floor_ids` / `zone_ids` (`access_areas.…` in a new visit)
asks for the places again (`refreshPlacesAfterRefusal`, after a change of the areas, an invitation and a walk-in).
*Tests*: the dialog (refused, the places asked again, the floor no longer offered, the visit's own sets then close
it); the walk-in (an extra zone archived after it was chosen is neither shown nor sent; a refusal said at the field
with the focus, the places asked again; the field follows a new department until changed); the invitation (the
places asked again, the floor no longer offered).

**F16-44 — Removing an extra zone keeps the focus.** The chip's remove button took the focus with it. Now it goes on
to the chip now in its place, else the previous one, else the zones' search (`useListFocusRecovery`). *Test*: two
chips removed in turn.

**F16-45 — A department's floor.** (1) The select was natively disabled while saving: the browser moved the focus to
the page's body. It is now `aria-disabled` (busy, a change meanwhile ignored), and keeps the focus. (2) After a
success the select showed the list's old floor until the list was asked again (the mutation ended before it): the
answer is now written into every list of departments at once. *Tests*: the focus and the attributes while saving;
the saved floor shown while the list's refetch is held.

**F16-46 — The fifth alert e-mail.** Added with Enter, the fifth address disabled the field that had the focus, and
the focus fell to the page's body. "Add", which stays focusable and says why it waits («5 عناوين على الأكثر»), takes
it first. *Test*: Enter on the fifth.

**F16-47 — Words for assistive technology and direction.** (1) An alert's "Where" read its two places as one list
("Floor 4, Open office, Floor 4, Server room"): the arrow between them is said «إلى» / "to". (2) The English
«{name}, {when}» did not isolate the name, so an Arabic name pulled the comma and the time before it; it is isolated
as in Arabic (FSI … PDI). *Tests*: the card's "Where" text; an Arabic name in English.

**F16-48 — Tests the review asked for** (no code changed): an uncertain place drawn dashed with its sign and an
acknowledged alert's chip still red; the alerts page's 403 state (the server's words, no "Try again"); several new
alerts in one answer (oldest first, one beep); an Arabic toast (the isolates, «عرض»); the watcher not running while
a password change is required; the title's count gone when the watcher goes; the panel's change of the areas
(another journey and live request, the new floors shown, the resolved alert gone). The mocked end-to-end spec
(`e2e/phase16-alerts.spec.ts`) adds the allowed areas' dialog on a journey and the walk-in's allowed areas (a host
of a department on a floor, an extra zone), in both languages and schemes at the three viewports, with axe, no
sideways scroll at the viewport and at 320 px, and the 44 px targets on the tablet and the phone; its live mock
answers the whole company, as the server now is asked. The walk-in's scene found one target short on touch screens:
the chosen host's phone link under the host field reached 12 px up into the field's 6 px gap, so the host's input
took the top of its tap area (41 px left); the link now has room above it there (the walk-in's own markup, the kit's
`PhoneLink` unchanged).

## Verification (2026-10-21, on the backend's final code and snapshot)

| Gate | Result |
|---|---|
| `npx tsc -b` | clean |
| `npm run e2e:typecheck` | clean |
| `npx oxlint --deny-warnings` | clean (exit 0, no finding) |
| `npx vitest run` | 177 files, 2,434 tests, all passed (after Phase 15: 166 files, 2,318); `api.contract.test.ts` 124 against the regenerated snapshot (passed at its first run against it), `auditLabels.test.ts` and `auditVocabulary.test.ts` against the backend's final source. Under the machine's load two runs each had a timing test time out (`sessionSync`'s pass page at 5 s; three e-mail-texts editor flows at 20 s); each passes alone, and the last two full runs passed whole |
| `npm run build` (to a scratch folder) | built: `JourneyPage` 22.4 kB (the map and its panel; 6.5 kB after Phase 15), `JourneyDetailPage` 11.7 kB, `TrackingAlertsPage` 4.3 kB (its own chunk), `TrackingAdminPage` 42.6 kB, the app chunk 371 kB (105.7 kB gzipped; 349 kB after Phase 15: the picker shared by three pages, the watcher, both catalogs' new words) |
| The image-equivalent build (the `.dockerignore` allowlist and its "never" patterns, `config/e2e*.test.ts` left out, the contract file beside it; `npm ci --ignore-scripts && npm run build` and the Dockerfile's guards) | 186 packages, built, the guards passed, 165 files in `dist`; no source of `src/` or `config/` imports `e2e/` |
| `npx playwright test --retries=0`, the whole suite (8700, `vms_e2e`, 3 workers) | 837 tests: 760 passed, 77 skipped (specs that run on one project only), 0 failed, 51.5 min (after Phase 15: 757 tests, 680 passed). New: the area alerts' flows (5), the mocked Phase 16 spec (51: 17 a viewport), the accessibility and appearance specs' map, list and alerts pages |
| The mocked Phase 16 spec alone (Vite on 5199, the API not running) | `phase16-alerts.spec.ts` 51 passed (with and without `P16_SHOTS`); `phase15-journey.spec.ts` passed in the whole suite |

The first full run was stopped at 230 of 837 (no failure so far) for the owner's follow-up (F16-32); the run above is
on the final code but for the policy's label (a catalog word, checked by Vitest after it).

**After the review fixes (F16-33 … F16-48), on the same backend:**

| Gate | Result |
|---|---|
| `npx tsc -b` | clean |
| `npm run e2e:typecheck` | clean |
| `npx oxlint --deny-warnings` | clean (exit 0, no finding) |
| `npx vitest run` | 177 files, 2,475 tests, all passed (2,434 before the fixes). The first full run had one failure, `config/sourceEncoding.test.ts`: a new test held a raw FSI and PDI, now written as escapes; the second full run passed whole |
| `npm run build` (to a scratch folder) | built: `JourneyPage` 23.3 kB, `JourneyDetailPage` 11.9 kB, `TrackingAlertsPage` 4.8 kB, `TrackingAdminPage` 42.6 kB, the app chunk 372.0 kB (106.0 kB gzipped) |
| The image-equivalent build (the `.dockerignore` allowlist and its "never" patterns, `config/e2e*.test.ts` left out, the contract file beside it; `npm ci --ignore-scripts && npm run build` and the Dockerfile's guards) | 186 packages, built, the guards passed, 164 files in `dist`; no source of `src/` or `config/` imports `e2e/` |
| `npx playwright test --retries=0` (8700, `vms_e2e`, `TRACKING_PROVIDER=simulator`, 3 workers): `flows/area-alerts`, `flows/visitor-journey`, `flows/permissions`, `phase16-alerts`, `phase15-journey`, `quality/accessibility` | 364 passed, 0 failed, 14.4 min (area alerts 5, the journey flows 6, permissions 5, the mocked Phase 16 spec 63: 21 a viewport, the Phase 15 spec 42, accessibility 243). A first run found the walk-in's host phone link short on the tablet and the phone (F16-48); `toast-placement` and `touch-targets` passed again after its fix (11 passed, 4 skipped: projects they do not run in) |

**After the brief's `escalated_at` (B16-26, F16-38), on the regenerated snapshot:**

| Gate | Result |
|---|---|
| `npx tsc -b`; `npm run e2e:typecheck`; `npx oxlint --deny-warnings` | clean; clean; clean (exit 0, no finding) |
| `npx vitest run` | 177 files, 2,477 tests, all passed (2,475 before: the two new pure steps); `api.contract.test.ts` against the regenerated snapshot |
| Regression proof | `alertWatch.test.ts` run against the previous pure step (a scratch Vitest config aliasing `./alertWatch`, the tree untouched): the two new tests failed (an alert opened between the last brief's opening and its escalation told as new; the escalation of an alert left out taken in silently), the other eight passed |
| `npm run build` (to a scratch folder) | built: `JourneyPage` 23.3 kB, `TrackingAlertsPage` 4.8 kB, the app chunk 372.0 kB (106.0 kB gzipped) |
| `npx playwright test e2e/phase16-alerts.spec.ts e2e/flows/area-alerts.spec.ts --retries=0` (8700, `vms_e2e`, 3 workers) | **68 passed** (5.3 min): the mocked spec 63 (its escalated alert now carries `escalated_at`), the area alerts' flows 5 (the toast at an opening and again at an escalation, against the server) |

**Looked at.** The mocked spec's scenes with `P16_SHOTS` (192: the map, a visitor's panel, the alerts, a journey,
the invitation's areas, the administration's settings, locations and departments, in English and Arabic, light and
dark, at 1440, 820 and 390 px and each at 320 px; the session scratchpad's `phase16-shots/`). What they changed:
an alert repeated the allowed floors beside the Allowed areas card on a visit's journey and panel (gone, F16-9);
"Where" named the same building twice (once now, F16-10); the floor checkboxes' 44 px rows overlapped on touch
screens (24 px apart now, F16-20); a Latin name pulled the comma and the time of «{name}، {when}» out of order in
Arabic (isolated, F16-12); the alert addresses hugged the left edge in Arabic (now at the row's start); and the
owner's level chip (F16-32).

## Open items

- **No real provider exists** (BLOCKED BY ENVIRONMENT, as in Phase 15): the map, the alerts and the sound were seen
  against the simulator and mocked answers only.
- **A sound needs a gesture first** (F16-18): a reception screen reloaded and never touched stays silent (the toast and
  the notification still say it). Browsers allow no other way.
- **Browser notifications on Chrome for Android** need a service worker's `showNotification`; the page's constructor is
  refused there, so only the toast and the sound say it (F16-19).
- **The words of this phase** («اطُّلع عليه», «أغلقه الموظف», «غير متتبَّع», «تصعيد تنبيه تتبّع») are worth a native
  reviewer's look, as earlier phases' were.
- ~~**The summary's order**~~ **Resolved** (B16-26, F16-38). `latest` was ordered by `opened_at`, the first
  violating observation's time, kept on an escalation: with five or more open alerts, an escalation of an older
  one never entered the five, and the watcher could not tell of it. The backend now orders `latest` by
  `coalesce(escalated_at, opened_at)` (revision 0020) and names `escalated_at` on each brief, and the watcher's
  cut-off compares with the same key: an escalation as the first answer's last brief no longer makes an older
  alert look new, and an alert left out of the first answer is told when it escalates. What stays: a new alert
  from a late observation sorts by its `opened_at` (that observation's time), so with five or more newer alerts
  open it may stay out of the five, or sort before the cut-off, and is then not told (the count and the title
  still change).
