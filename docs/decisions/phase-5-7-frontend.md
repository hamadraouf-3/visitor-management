# Phases 5–7 — Frontend: decision log index and gate fixes (round 1)

Date: 2026-10-06 · Scope: `frontend/` (all of it: one frontend agent from this round on) · Contract: `docs/initial-assessment.md` revision 2

## Index

The orchestration contract asks for the frontend decisions of Phases 5–7 in `docs/decisions/phase-5-7-frontend.md` (§14 naming). Three builders worked at the same time and each kept its own file; this file is the entry point, and it records the gate fixes of round 1 (FX-n).

| File | Scope | Entries |
|---|---|---|
| [`phase-5-7-frontend-reception.md`](phase-5-7-frontend-reception.md) | Reception screen and scanner (`features/reception`, `src/scanner`) | FR5-1 … FR5-36 |
| [`phase-5-7-frontend-admin.md`](phase-5-7-frontend-admin.md) | Visit history, Inside now (evacuation list), administration, reports | F57A-1 … F57A-25 |
| [`phase-5-7-frontend-employee.md`](phase-5-7-frontend-employee.md) | Employee screens and the UI kit (Phase 2–4 carry-over, B57-03/B57-04 contract additions) | FE57-1 … FE57-24 |
| This file | Gate review round 1: 2 failing gate items, 45 findings | FX-1 … FX-32 |
| [`phase-5-7-frontend-round2.md`](phase-5-7-frontend-round2.md) | Gate review round 2: 11 findings, and the backend's round-2 hand-overs (B57-70, B57-71, B57-72) | FY-1 … FY-14 |

Entries in the three files that these fixes change carry an *(Amended in FX-n)* note.

## Gate review round 1 (2026-10-06)

Every finding was checked against the code first. All 45 were real; findings 3 and 6 and findings 1 and 10 are the same defects, and findings 9, 24 and 33 overlap. Where a fix differs from the suggestion, the entry says so and why. Each entry: **decision** — reason.

### Test suite (gate item 2, findings 3, 4, 6)

FX-1. **The documented hand-overs are applied (F57A-5, FR5-34).** — `guards.test.tsx` `signedInAs` adds `receptionRoutes()`, `adminDashboardRoutes()` and `reportsRoutes()`; `AppLayout.test.tsx` adds `adminDashboardRoutes()` to all four tests and `auditLogRoutes()` to the drawer test; `LoginPage.test.tsx` adds `reportsRoutes()` to the two MANAGEMENT tests and `receptionRoutes()` to the signed-in redirect; `ChangePasswordPage.test.tsx` adds `reportsRoutes()` to the forced-change test. The 11 "Unhandled request" failures are gone.

FX-2. **The Users page test pins the clock.** — `makeUser()` fixes `last_login_at` to 09:00 Amman on 5 Oct 2026 and the test expects "Today, 09:00"; it failed from midnight on. The describe block now fakes `Date` only (`vi.useFakeTimers({ now: 2026-10-05T10:00Z, toFake: ['Date'] })`, phase-2-4-frontend 30). The other admin, reports, history and inside tests were searched for fixed dates used with relative labels: the history and audit tests assert absolute dates only, and the dashboard, reports and inside tests already pin the clock.

FX-3. **Load tolerance is set once for every test file (closes the FE57-21 gate).** — `src/test/setup.ts` sets Testing Library's `asyncUtilTimeout` to 5 s and `vite.config.ts` sets Vitest's `testTimeout` to 20 s. The 16 per-file copies (`configure(...)`, `vi.setConfig(...)`, `LONG_FLOW_MS`) are removed. A lazy route such as `/reception` (FR5-34) no longer needs its own longer `findBy` timeout.

### Shared modules (findings 8, 11, 12, 13, 14, 28)

FX-4. **One hook per shared cache entry: `src/api/queries.ts`.** — `useInsideList({ enabled })` (`staleTime: 0`, polled every `LIST_POLL_MS` = 15 s), `fetchInsideListNow` (Refresh and Print: a user request, without the header), `isBackgroundFetch` (the one rule for `X-Background-Refresh: 1`: every fetch after a first answer), `useCompanySettings` and `useActiveDepartments`. The reception and Inside-page copies of the inside list, the admin and reception copies of the settings hook, admin's `useActiveDepartmentList` and the constants `RECEPTION_POLL_MS` / `INSIDE_REFRESH_MS` are deleted. The settings hook now uses the client's default freshness everywhere: walk-ins read `allow_walk_ins` when the Walk-in tab opens, and an administrator's change should show there. *(Amends F57A-11, F57A-14, FR5-20, FR5-27.)*

FX-5. **One refresh after any visit change: `refreshAfterVisitChange` (visits/queries).** — It now also invalidates the admin dashboard, and reception's `refreshAfterReceptionChange` is deleted. *Deviation:* no `{ adminDashboard }` option. Invalidating a query no screen shows only marks it stale, and a visit created on My visits changes the admin counts too.

FX-6. **One department rule for new visits.** — `inviteDepartmentChoice` takes `Pick<…, 'host' | 'departmentId'>` and serves the invite and walk-in forms; `walkInDepartmentChoice` is deleted (FR5-30's hand-over). *(Amends FR5-26, FR5-30.)*

FX-7. **Inside flags are worded once: `features/visits/insideFlags.ts` and `InsideFlagBadges`.** — "Previous day" (warning, calendar-clock icon) and "Overdue · due out 10:00" (warning, clock icon), both shown when both apply. When the visitor was due out on an earlier day, the overdue flag says only "Overdue": "Previous day" already gives the day, and a bare time would read as today's. The reception Inside tab, `/inside`, its printout and the Inside-page tile ("Previous day") use them. The reception tab's red "From a previous day", which hid "Overdue", is gone. *(Amends FR5-23, F57A-10.)*

FX-8. **Generic helpers moved out of the features.** — `utils/datetime`: `formatClockTime`, `formatDateAtClockTime`, and `formatTimeOnDay` (from `visits/format`). The last one replaces both inside's `formatCheckIn` and reception's `checkInTimeLabel`. Also `utils/number` `formatCount`, `utils/ids` `isUuid`, `utils/dateRange` `dateRangeError` (+ `dateRangeReadBack`, FX-27), `utils/phone` `telHref`, and `utils/text` `foldText` (used by `findMatch` and the reception filter). No feature imports another feature's internals for a generic helper any more. Domain dependencies on `features/visits` (format, pickers, labels, inside flags) stay: visits are the shared domain.

FX-9. **Promoted to the UI kit.** — `PhoneLink` (`components/ui`, now used by the reception lists, the walk-in form, the evacuation list, the visitor profile and the visit card), `DateRangeFields`, `FilterPanel` and `StatusFilter`. Reception's `TodayCounts` no longer copies the `StatTile` markup (FX-15). *(Amends F57A-3.)*

### Focus (gate item 1, findings 1, 2, 10, 26)

FX-10. **Lists keep keyboard focus when an action removes its own row: `hooks/useListFocusRecovery`.** — *Deviation from the suggested `returnFocusFallback` in `modal.ts`:* that covers only a trigger that is gone when the dialog closes. In the measured case the dialog returned focus to the row's button, and the list's refetch removed the row afterwards. The hook works in the list instead. On success the dialog's new `onDone` arms it with the row's key. After each render, a focus found lost to the document moves to the row now at that position: its `data-row-action` control (else its first button, else its first link), or the previous row when the last one went, else the list's filter field, else the page heading. The recovery ends when it has happened, or when the list's data changed without focus being lost. The bulk check-out arms it without a row (focus goes to "Filter visitors inside"). The hook is used by Expected, Inside and the visitor search. `SearchField` gained `inputRef` for the fallback. Measured in Chromium (desktop, tablet and phone, keyboard only): after an Inside check-out focus is on the next row's "Check out", after the bulk check-out on the filter, after an Expected check-in on the next "Verify ID & check in". Tests fail with the hook disabled.

FX-11. **The Scan tab takes focus "from nowhere" on touch screens too (finding 2).** — ScanPanel's focus effect focuses the "Enter or paste pass" button when focus was lost to the document: after a walk-in closes the Walk-in tab, and after "Scan next". Before, it did so only after a check-in or check-out. The page's landing heading keeps focus on arrival, so a screen-reader user still starts at the heading. Measured at 820 and 390 with touch: focus on "Enter or paste pass" after a walk-in.

FX-12. **No Tab trap at the pass field (finding 26).** — The fine-pointer "take focus when idle" rule now skips a focus change that follows a Tab key (within 100 ms, seen in the capture phase) and does nothing while `document.hasFocus()` is false. Tab past "Check pass" now continues: in Chromium, "All expected", the toast's dismiss button, the document, then "Skip to main content". A click on empty space still gives the field focus back. jsdom answers `hasFocus()` false until an element is focused, unlike a browser, so `src/test/setup.ts` stubs it to true; one test stubs it to false.

FX-13. **"Turn camera off" gives focus to "Start camera"** when it removes itself (it is no longer a separate row, FX-17). This happens only when the camera is turned off, not on arrival.

### Reception layout (findings 20, 22, 23, 31, 34, 43, 44)

FX-14. **"Find a visitor" is a dialog opened from a header button (finding 22).** — The results get the dialog's full width (672 px from `sm`, the screen width on phones) and scroll inside it. The first five show, the rest are behind "Show all n results". E-mail addresses use `EmailText` and break only at their separators. Escape and Close close the dialog, and so does a pass read by the camera (`useScanStation`'s new `onCameraScan`), so a result never appears behind it. *Deviation:* a modal dialog rather than an anchored, non-modal popover. A popover beside the field would need its own focus, Escape, outside-click and Tab handling. It would also have to stay open while a nested check-in dialog takes focus, and on a phone it would cover the screen anyway. The kit's `Dialog` already does all of this, nested dialogs included. The scanner never moves: measured, the camera's top is unchanged while the search is open.

FX-15. **The scanner leads on tablets and phones (finding 23).** — The header is the title, the date line and the "Find a visitor" button beside the title (`PageHeader` gained `actionsBesideTitle` and `compact`). The tabs follow, with today's other counts in one line beside them from `sm`: "Today: 7 checked out · 1 no-show · 2 walk-ins". The expected and inside counts stay as the tabs' badges. On phones the counts line is left out. The Scan tab is stacked below `lg`, with the camera across the whole width, and side by side from `lg`. On a phone the grid tabs are 44 px tall (the touch minimum) instead of 56 px. Measured: camera top 244 px at 820 × 1180 (target ≤ 250) and 284 px at 390 × 844 (≤ 300). While a pass is handled, the camera box below `lg` shrinks to a strip whatever the camera does; with the camera off, its message fits on one line. "Check in" then ends at 887 px on the tablet and 803 px on the phone, both without scrolling. *Deviation:* the four count tiles are gone at every width, not only below `lg`: at 1440 they repeated the tab badges as well. "Try again" for failed counts is the default size (finding 20).

FX-16. **The Expected list is grouped and compact (finding 31).** — Groups with counts: "Arriving now" (the pass is valid, or the visitor is late), "Later today" (the pass is not valid yet) and "No-shows today". A row has two lines: name, company and status, then time, host, phone, department and purpose cut to one line with its full text as the title. The one action sits on the right from `sm`. A later row offers "Check in anyway…" only in its "More actions" menu. Late and no-show visitors keep a visible "Check in anyway…": for them it is the way in. Inside rows use the same layout, and "Correct check-out time" moves to each row's menu (finding 34). `Menu` items are 44 px tall on touch screens.

FX-17. **Scan controls (finding 44).** — "Turn camera off" is a round button in the preview's corner. The camera picker and the beep switch share one row under the preview. Once "Enter or paste pass" opens the field, the button gives way to a "Hide pass field" button in the field's row, so the field has one control. The idle result pane shows "Expected next": up to three of today's scheduled visits whose pass has not expired, with "All expected" to open the tab.

FX-18. **The bulk check-out says who and when before it happens (finding 43).** — The dialog (now `lg`) lists each visitor from a previous day: host, check-in, and the check-out time the server will record (`bulkCheckOutAt`: the scheduled end, or the check-in if later, never after now, B57-16). Ten show at once, the rest behind "Show all n". It also says the check-out cannot be undone. *(Amended in [phase-5-7-frontend-round2.md](phase-5-7-frontend-round2.md) FY-12.)*

### Scan result (findings 9, 17, 19, 24, 25)

FX-19. **One action row for every outcome (findings 9, 24).** — "Scan next" (and "Check pass again") come first, then the outcome's actions with the primary last: on the right from `sm`, at the bottom on phones. The DOM order is the visual order. ALREADY_CHECKED_IN puts "Check out" (outlined) in that same row, so it no longer sits beside the name. §10 asks for check-out to be "styled/positioned differently". It is styled differently (outlined, not the solid primary), and it comes after the new headline (FX-20). With finding 24 the position stays the same for muscle memory. A check-in less than 5 minutes ago still needs a confirmation. `config/visualOrder.test.ts` fails on any `flex-row-reverse` or `flex-col-reverse` in a component. The walk-in footer ("Clear form", then "Check in walk-in") and the company settings footer (status, "Discard changes", "Save changes") no longer reverse (finding 33). *(Amends FR5-14.)* *(Amended in [phase-5-7-frontend-round2.md](phase-5-7-frontend-round2.md) FY-1.)*

FX-20. **ALREADY_CHECKED_IN opens with what happened (finding 25).** — An info alert above the name: "Already checked in at 13:03 (59m ago)", with the date for an earlier day. A check-in under 5 minutes ago reads "This is probably the same visitor scanning again. Check out only if they are leaving. If someone else is arriving with this pass, verify their ID." Otherwise it reads "Check the visitor out if they are leaving. If someone is arriving with this pass, verify their ID: it was already used to come in." A forwarded QR (§12) no longer looks like a fresh arrival. The live region says "is already checked in".

FX-21. **One clock for the 5-minute rule (finding 17).** — The flow stores when a result arrived (`shownAt`, set in the event handler). `useResultClock` returns the later of that and a clock that ticks every 10 s and moves exactly when the shown check-in turns 5 minutes old. ScanPanel judges the result's actions with it, and the panel shows them. Enter (in the empty field, or with nothing focused) now triggers the action the panel shows: `actPrimary(primary)` takes it as an argument instead of working it out again with `Date.now()`. A boundary test fails with either half removed.

FX-22. **A result about a visit changed elsewhere is left (finding 19).** — `useScanStation` gained `dismissIfAbout(predicate)`. The screen calls it when a list or the search checks a visitor in or out (the same visit id), and after the bulk check-out (any visitor from a previous day). *Deviation:* results are not dismissed whenever the Scan tab is left. A receptionist may look something up and come back to the result, and the visitor search is open over the Scan tab anyway.

### Scanner privacy (finding 5)

FX-23. **A camera code that is not a pass is sent as `unrecognised-qr` (amends FR5-11).** — For camera detections, `scanPayload(input, 'camera')` sends `UNRECOGNISED_QR_PLACEHOLDER` instead of the decoded text. It is not a well-formed token, so the server answers 404 PASS_INVALID and audits `PASS_SCANNED{INVALID}` as before. The repeat gate still keys on the decoded text. A Wi-Fi password, a contact card or a payment code in view never leaves the tablet. Typed, pasted and handheld-scanner input is a deliberate entry and is still sent as entered (trimmed, at most 4,096 characters).

### Walk-in and invite (findings 7, 16, 45)

FX-24. **A walk-in from a scanned visit is saved under the department it shows (finding 7).** — `walkInPrefillFromVisit` no longer builds a host whose department is the visit's. It returns `hostRef` (id and name) and the visit's department as an explicit choice. The form looks the host up in the host directory: `GET /users/hosts?q=<name>`, matched by id, since the directory has no lookup by id. The department field then follows the shared rule (FX-6). The new `departmentChosen` flag means a department set on purpose (the scanned visit's, or one picked in the field) is always sent, also when it is the host's own. A department only taken over from the host is left to the server's default (B24-23). Case 1 (visit in X, host in Y) now saves X, as shown. Case 2 (visit without a department) shows and saves the host's department. A host renamed or deactivated since the visit is not found; the field then says so and asks for a host. *(Amends FR5-17, FR5-26.)*

FX-25. **409 VISITOR_EXISTS on invite goes to the visitor field (B57-01 hand-over).** — It shows on Email for a new visitor, or on the returning-visitor field, with the server's message, and that field takes focus. The message names the address that is already registered under another name.

FX-26. **Copy (finding 45).** — The settings time zone reads "Los Angeles — America/Los_Angeles (UTC-7)" (`timeZoneLabel`). The host picker has no placeholder; its field hint says "Search by name." The audit filters are "Record type" with "All records" and "Record ID", and the event details say "Record".

### Dates, tables, print, touch (findings 27, 29, 30, 32, 35, 36, 37, 39, 40, 42)

FX-27. **Native date inputs are read back in the app's format (finding 39).** — `DateRangeFields` adds the chosen range to its time-zone line: "From Mon, 5 Oct 2026 to Sun, 11 Oct 2026. Days follow Amman time (UTC+3)." This covers history, audit and reports. `DateTimeField` gained `readBack` (used for the walk-in's expected end and the corrected check-out time). Date inputs are at most 12 rem wide. *Not done:* `lang` on the inputs. Chromium formats date inputs by the browser's UI language, whatever `lang` says.

FX-28. **The printed evacuation list fits the paper (finding 27).** — A named page, `@page evacuation-list { size: landscape; margin: 10mm }` in `index.css` (page `[page:evacuation-list]`), on A4 or Letter as the printer has. The table uses `table-fixed` with column widths (# 4 %, Present 9 %). Body text is 9 pt and headers 8 pt, so a header word never breaks. Long values wrap; an earlier day's check-in puts its date on its own line. Measured in print emulation, the table ends exactly at the printable edge at A4 landscape (277 mm) and in the portrait fallback at A4 (190 mm) and Letter (196 mm). This holds with 40-character visitor, company, host and department values. *(Amends F57A-13.)*

FX-29. **Evacuation list on tablets (findings 30, 32).** — Below `lg` it is a card list whose whole card links to the visit, so the 19 px name link is gone. Phone numbers never break (`PhoneLink` is `whitespace-nowrap`). Measured at 820: every number on one line.

FX-30. **History columns (finding 29).** — Visitor names and hosts stay on one line from `lg` (the company may wrap), and the Visitor column is at least 14 rem. The purpose is cut to one line, with its full text as the title. Check-in, check-out and duration are one "Attendance" column up to `2xl` and in the cards; from `2xl` they get their own three columns. Measured at 1440: 65 px rows (were 70–85). *(Amended in [phase-5-7-frontend-round2.md](phase-5-7-frontend-round2.md) FY-7.)*

FX-31. **Touch targets and accessibility (findings 32, 35, 36, 37, 40, 42).** — On coarse pointers these grow to 44 px: the dialog and drawer Close buttons, the alert and toast dismiss buttons, checkbox labels (`py-3 -my-3`), navigation links, the account menu, menu items, `RadioGroup` list options and the search field's clear button. Audit entity links are at least 24 px (WCAG 2.5.8), and 44 px on touch with the line height unchanged. In `Combobox` the listbox scrolls itself and has `tabIndex={-1}` (axe `scrollable-region-focusable`). Every `SearchField` landmark is named by its label (`aria-labelledby`). The audit details use a labelled section instead of an `h3`. "Deactivate" on the departments page is the neutral secondary style; the confirmation keeps the danger tone. `StatTile` is compact below `sm` and `StatGrid` is two per row. `/inside` shows the headcount across the phone and the two flag counts beside each other; `/reports` shows its five tiles two per row. axe (Chromium) on the reception Scan, Expected and Inside tabs at all three sizes, and on `/admin/audit` with "Performed by" open and an event expanded: no violations.

FX-32. **Audit summaries name things, not IDs (finding 38); report charts (finding 41).** — The event line no longer shows the 8-character ID: "Visit · Open visit". It says "Own account" when a user acted on their own account ("Signed in"). Metadata values read as words: "PASS_EXPIRED" → "Pass expired" (the badge's words), "QR" → "QR code", roles and visit statuses by their labels, field names humanised. The raw JSON still shows the codes. *Partial:* a visit's visitor name cannot be shown. `AuditLog` carries no snapshot, and §3.2-8 keeps names out of metadata. Charts: axis text is 12 px. The hour axis keeps a regular rhythm to its end ("… 18 21"); the date axis still names the period's last day. The hour summary reads "by hour of the day in Amman time (UTC+3)", with no nested parentheses and the zone kept on one line. When today is the busiest day, the summary says "today, … so far". *(Amended in [phase-5-7-frontend-round2.md](phase-5-7-frontend-round2.md) FY-9.)*

### Removed

- `src/pages/PlaceholderPage.tsx` (finding 15): nothing imported it.

### Verification

- `npm run typecheck`, `npm run lint`, `npm test` (93 files, 997 tests) and `npm run build` pass.
- Real-browser check: the Vite dev server ran on port 5197 with the API mocked by Playwright route interception. Chromium is Playwright's own build; the tablet and phone runs emulate touch (`pointer: coarse` confirmed). The measurements are quoted above.
- The probe script, its screenshots and the PDF lived in the session's scratch directory, outside the repository. The server was stopped.

## Known limits

- The visitor-search dialog closes on a camera scan but not on a handheld-scanner entry: while the dialog is open, keys go to its search field (the dialog owns the keyboard, FR5-13).
- The walk-in host lookup searches the directory by the visit's host name. A host renamed since the visit was booked is not found, and the receptionist picks the host.
- Browsers without CSS named pages print the evacuation list in portrait. It still fits, with narrower columns.
