# Phase 8 — Frontend: the Phase 5–7 leftovers before the security audit

Date: 2026-10-06 · Scope: `frontend/` (one frontend owner) · Contract: `docs/initial-assessment.md` revision 2

The third verification round of Phases 5–7 left two failing gate items and 32 frontend findings. This file records how each was closed. The IDs (L-FE-n) are the ones the fix report uses; the backend side of the round is in [`phase-8-backend.md`](phase-8-backend.md) (L-BE-n). Each entry: **decision** — reason. Every finding was checked against the code first, and the layout findings were also measured in a real browser. All 32 were real, and none was rejected. The two gate items duplicate two of the findings (VisitFacts, the report printout), so each pair is one entry. Entries of earlier files that these fixes change are listed under "Amends" at the end, because those files belong to earlier rounds and were not edited.

## Failing gate items

L-FE-1. **Reception shows why a visitor was let in (B57-64 hand-over; gate contract#3.1 and the VisitFacts finding).** — `VisitFacts` adds `check_in_note` as written (`whitespace-pre-wrap`). For a walk-in it is "Note", right under "Walk-in: Other" (any reason; required for OTHER since B57-64). For an OVERRIDE it is "Reason given", right under "Checked in". A note of white space only is left out. The scan result, the check-out confirmation and the override dialog use `VisitFacts`, so all three show it. The correction dialog shows only the check-in and the scheduled end; it is about when the visitor left, and it never showed the visit's facts. Tests: `VisitFacts.test.tsx` (order of the facts, OTHER plus note, override reason, blank note); `ReceptionLists.test.tsx` "shows why a walk-in was let in when checking them out".

L-FE-2. **The printed report is two pages (FY-10; gate ux#3.1 and the ReportBody finding).** — Reproduced first with eight departments and `beforeprint` dispatched: three A4 pages, with 22 %, 31 % and 48 % of each page blank. Changes:
   - The department and hour charts stand side by side on paper (`print:grid-cols-2`). Each is drawn at `PRINT_HALF_CHART_WIDTH` (290 px); the daily chart keeps `PRINT_CHART_WIDTH`.
   - Charts are shorter on paper: daily 180 px, hourly 170 px (240 on screen). The bar chart's stacked rows are 34 px with 12 px bars (44 and 16 on screen); its labels stay above the bars, so they are never cut off.
   - `useElementWidth` became `useChartSize` (`charts/useChartSize.ts`, with `usePrinting`). It returns the width and whether the page is printing, and still switches synchronously inside `beforeprint`.
   - The tiles are compact on paper (`StatTile`: `print:p-2`, labels `text-xs` without the decorative icon, value `text-xl`, hint 10 px), so no label wraps in a fifth of the page.
   - The "Visits booked" hint is "Incl. 14 cancelled and 37 walk-ins": words instead of a "·", so a wrap never strands a separator, at 1440 or on paper.
   - The period footnote is screen-only (the sheet's header says it), and chart cards have `print:p-4`.
   - Every card keeps `break-inside-avoid`, so the browser decides only where page 2 starts.
   - Measured as PDFs: A4 with no margins, A4 with 10 mm margins and Letter with 10 mm margins are two pages each with 8 departments, with 12 departments (the chart shows at most eight bars, the rest as "Other departments") and for a 90-day range (line chart). On A4, page 1 holds the header, tiles, daily chart and both side-by-side charts (96 % used) and page 2 the top hosts. On Letter the side-by-side charts move to page 2, ahead of the top hosts.
   - `ReportsPage.test.tsx` pins the paper widths and heights per chart and the side-by-side grid.

## Reception

L-FE-4. **"Find a visitor" offers today's no-shows (medium).** — `withTodayNoShows` (`visitActions.ts`, unit-tested) adds the screen's polled `today.no_show` to each found visitor's visits, matched by `visitor.id` and deduplicated. `orderSearchResults` then ranks such a visitor as actionable. The visit's row shows "No-show · pass expired 07:30" and, through `rowAction`, "Check in anyway…" (OVERRIDE). The server's own refusal (e.g. `HOST_INACTIVE`) still shows "Check-in not available" with a walk-in. `LATE_ARRIVALS_NOTE` is shown only while today's no-shows are not all known here: still loading, failed, or capped at 200. No backend change was needed. Tests: Sara Haddad's NO_SHOW visit gets "Check in anyway…" and sends OVERRIDE, with no "Register walk-in" and no note; the note shows when the count exceeds the list.

L-FE-6. **One-tap "Check out" on the Inside tab, as §10 says (amends FR5-23).** — A tap checks the visitor out (MANUAL) at once. The button shows a spinner and keeps focus, a success toast names the visitor, and focus moves to the next row as before (`useListFocusRecovery`). A refusal shows a danger toast with the server's message (and reference) and refreshes the lists. The only exception is the scanner's 5-minute rule: a check-in less than 5 minutes ago (`isRecentCheckIn`, judged at the tap) opens the confirmation, with Cancel focused, because that visitor is probably arriving. The check-out from "Find a visitor" keeps its confirmation: there the visitor was found by name, as for a check-in (FR5-22). The component doc no longer contradicts itself. Tests: a one-tap check-out sends MANUAL without a dialog; a check-in 3 minutes ago asks first; a refusal is shown and refreshes the list; the focus test now runs without a dialog.

L-FE-16. **A refused walk-in refreshes what it proves stale.** — `useCreateWalkIn` calls `refreshAfterRefusal` on 409/404/403/410, like every other reception mutation. On `WALK_INS_DISABLED` it also invalidates `companySettings`, so the Walk-in tab turns into "Walk-in registration is turned off". Both behaviours are tested, and both tests fail without the change.

L-FE-17. **`checkOutStale`'s doc states B57-71's rule**: CHECKED_IN visits checked in before company-local today whose scheduled end has passed, each at max(check_in_at, scheduled_end).

L-FE-20. **The Inside tab's "Check out" is outlined** (`secondary`, `lg`), like the scan result's and the search's. Solid primary now means a check-in everywhere. Tested by class.

L-FE-21. **A valid pass opens with its verdict.** — A success alert, "Valid pass – ready to check in" ("Valid pass" when the server allows no check-in), comes above the name. The visit's "Scheduled" badge is left out in this state: it is the visit's status, not the scan's outcome, and `VisitorHeading` gained `showStatus`. The early/late notice and the live region are unchanged. Tests: tone `success`, position before the name, no "Scheduled" badge.

L-FE-22. **When the camera cannot scan, the pass entry looks like the way to scan.** — When the camera is in an error state, "Enter or paste pass" takes the primary style (`PassInput` `emphasised`). It still does not open by itself, so no on-screen keyboard appears. The idle panel then reads "Camera unavailable – use a handheld scanner or paste the pass link." With the beep switch moved (L-FE-30), the toggle sits right under the camera's message. Measured in Chromium's headless shell with a Y4M camera (NotSupportedError, L-FE-36) at 820 and 390 with touch: primary, 16 px under the camera box, closed, no "Try again". Tests: primary when blocked, outlined while the camera works, and the copy.

L-FE-23. **On phones a row's "More actions" sits in the card's top-right corner.** — `VisitRow` is `relative`. Its menu is absolutely placed below `sm`, and the details get `pr-11` so they never run under it. A row without a button has no action line on phones (its group is `max-sm:contents`). From `sm` the menu stays beside the action. Measured at 390: the menu 5 px from the corner, and the card ends 13 px under its last detail line (before, the menu had a 50 px line of its own).

L-FE-24. **One wording for the check-in time: "Checked in 10:51 · 2h 2m inside".** — `checkedInLabel` and `checkInTimeAndStay` (`visitActions.ts`, unit-tested) serve the Inside tab (was "In 10:51 · 2h 2m"), "Find a visitor" (was "In since 11:19") and the "Checked in" fact of the scan result and dialogs (now "09:02 · 8m inside", was "inside for"). The evacuation list keeps its "Checked in" column (a time under a header). The history keeps "In … · Out …", where the check-in is paired with the check-out. The ALREADY_CHECKED_IN headline keeps "Already checked in at 13:03 (59m ago)".

L-FE-26. **Refusal titles add facts instead of repeating the server's message.** — `refusalGuidance(outcome, now, timeZone)` titles each refusal with what the message leaves out:
   - "Pass expired at 11:00" (or "on Tue, 6 Oct 2026, 11:00");
   - "Pass valid from 08:00";
   - "Checked out at 10:00";
   - "Visit cancelled by Omar Khalil";
   - "Host no longer active: Omar Khalil";
   - "Pass replaced at 08:40".

   Without a visit the bare situation is the title. The server's message follows once, then the next step. An invalid pass has no client title: its message, "Invalid visitor pass.", is the title, the next step follows directly, and the live region reads the message once. Tests: unit tests for every code, and scanner tests that read the message exactly once.

L-FE-30. **The beep switch comes last.** — It moved out of `CameraView` into `ScanPanel` as the grid's third item. From `lg` it sits under the pass entry in the left column (`lg:grid-rows-[auto_1fr]`, the result spanning both rows); stacked, it comes below the result. It never stands between the camera and the fallback scan control. On a phone the result also starts about 40 px higher (READY's "Check in" ends at 767 px of 844). The DOM order is the reading order (camera, entry, result, switch). The camera picker stays under the preview. `e2e/reception-axe-narrow.spec.ts` still passes.

L-FE-31. **A fresh page load on a touch screen leaves focus where it is.** — On coarse pointers `ScanPanel` takes focus from `<body>` only after a pass was handled since the tab opened (result, action, "Scan next"), or when the screen asks for it. The screen asks after a walk-in closes the Walk-in tab (FX-11: `focusPassEntryOnOpen`, set by `walkInCreated`). A kiosk reload or a bookmark therefore shows no focus ring, and a screen reader starts at the top. Fine pointers are unchanged: the field takes focus whenever nothing has it, which is what a handheld scanner needs. Measured: focus on BODY after load at 820 and 390. Test: no focus after a load, then focus after "Scan next" (it fails with the old rule); the walk-in test still guards FX-11.

L-FE-35. **Toasts on phones are at the top (medium).** — Below `sm` the toast stack is `top-0`, with the safe-area inset, over the app bar. From `sm` it stays at the bottom right. The bottom of a phone screen holds the actions: the scan result's full-width "Check in", the walk-in's sticky bar, and the confirm buttons of bottom-sheet dialogs. Toasts still render above modals, so a dialog never hides an error. *Deviation:* no hiding of non-error toasts while a modal is open; at the top they no longer cover a sheet's footer. Measured at 390 × 844 with touch: the toast takes y 16–74, and `elementFromPoint` at the centre of the correction dialog's "Save check-out" and of READY's "Check in" returns those buttons while the toast shows. `e2e/toast-placement.spec.ts` (mobile project, mocked API) asserts the same. Against the old placement it fails (toast at y = 779).

L-FE-5. **The repeat gate remembers every recent code.** — `createRepeatGate` keeps a `Map<key, lastSeenAt>`. A key seen less than 5 s ago is refused, whichever keys came in between, and every sighting renews it. Expired keys are pruned on each call. `refresh()` renews the last admitted key, and `reset()` forgets all keys. A, B, A within 5 s no longer scans A twice. Tests: A-B-A, two codes alternating for 20 s, refresh of the last key only, reset; the old "A again after B" test asserted the defect and was replaced.

L-FE-36. **`NotSupportedError` is "unsupported"** (no "Try again"): the browser has no capture backend (some kiosk WebViews, Chromium's headless shell), so neither a retry nor a reload can help. Tests: the mapping table and the camera hook.

## Administration, history, Inside, reports

L-FE-3. **Filters show names the server gives for an ID, never a name from the URL.** — Audit log: the URL holds only `actor` (an ID). `ActorFilter` shows the server's `full_name` from `GET /users/{id}` (`useUser`, not retried, cached a minute). It shows "Unknown user" on 404/422, "Selected user" on another failure, and "Loading user…" until the answer. A record picked in the search is put in that cache, so picking costs no second request. History: `hostName` stays in the URL, but only as `nameHint` to search the host directory by (`GET /users/hosts` has no lookup by ID, and management and reception cannot read `GET /users`). `useHostById` (`api/queries.ts`, shared with the walk-in's host pre-fill, which replaces reception's `useHostLookup`) shows a name only when the directory returns that ID; otherwise "Selected host". A host just picked is shown as picked. The lists always filter by the ID.
   - **Kit fix found on the way:** `Combobox` adopted an outside change only when the selected key changed. It now also adopts a new label for the same key, unless the user is typing over it, so the placeholder gives way to the loaded name (tested).
   - Tests: a crafted `actor=<Sami>&actorName=Lina%20Haddad` shows "Sami Admin"; a 404 shows "Unknown user"; picking writes no `actorName` and makes no `GET /users/{id}`; a crafted `hostName` shows "Selected host"; a real one shows the server's name.

L-FE-7. **Thin pages again (§3.1, Phase 1 decision 36; F57A-1's claim now holds).** — Each page now reads `me` and renders one feature component:
   - `UsersPage` → `UserDirectory`;
   - `DepartmentsPage` → `DepartmentList`;
   - `AuditLogPage` (header and `AuditTrail`);
   - `AdminDashboardPage` (header and `AdminDashboard`);
   - `InsidePage` → `EvacuationScreen`, with Refresh and Print-when-fresh in `features/inside/usePrintWhenFresh.ts`.

   Where the header's actions depend on the feature's state (Add user, Add department, Refresh/Print), the feature component renders the header, as `ReceptionScreen` does.

L-FE-8. **One visitor card for the invite and walk-in forms.** — `features/visitors/VisitorSourceFields.tsx` holds the returning-visitor picker with one hint ("Search by name, phone, email or company."), the chosen visitor's summary, the "or enter a new visitor" divider, the new visitor's fields (full name, company, phone, email), and "Select the registered visitor" after B57-70's 409. Its props cover the invite's emailed pass (Email required, with its hint) and the walk-in's collapsible contact details (focus moves to Company on "Add contact details"). `SelectedVisitorSummary.tsx` lists company, phone and email in the fields' order (the invite listed email before phone). Copy uses typographic apostrophes. The walk-in's opened contact grid now runs two per row with the name (was name alone, then three).

L-FE-9. **One department select.** — `DepartmentSelect` (`features/visits/pickers.tsx`) gained `markInactive`: `current` is labelled "(inactive)" once the active list loaded without it. It also always sets `aria-busy` while loading. The user dialogs use it, and `UserDepartmentSelect` is deleted.

L-FE-10. **`readDateParam` and `readUuidParam`** (`hooks/useUrlParams.ts`, unit-tested) replace the copies in `historyFilters.ts` and `auditFilters.ts` and serve `readReportRange`.

L-FE-11. **`components/ui/LoadErrorAlert`** (`title`, `error`, `onRetry`, `retrying`) replaces the danger "could not be loaded … Try again" alert in 15 places: admin dashboard, audit log, settings, departments, users, history, Inside now, reception Expected and Inside, reports, visitor profile (twice), visitor search, visit detail, My visits. Not replaced, because they are not that alert: the Inside page's stale-list warning (warning tone, a status); the inline count retries of reception and My visits; the camera's own "Try again".

L-FE-12. **One visitor cell and one method vocabulary.** — `features/visits/VisitLinkCell.tsx` (the stretched link with the back-link state, the name, the company, and optional lines under them) serves My visits' `VisitTable`, `HistoryTable` and `EvacuationList`. The method words live in `features/visits/labels.ts`: long phrases for the timeline (`CHECK_IN_METHOD_LABELS`, `CHECK_OUT_METHOD_LABELS`), short forms (`VISIT_METHOD_SHORT_LABELS`) and descriptions (`VISIT_METHOD_DESCRIPTIONS`). `history/visitMethods.ts` and `admin/auditFormat.ts` import them, so the audit log now says "Corrected check-out" and "Bulk check-out" like the history's badges (was "Corrected", "Bulk"; tested).

L-FE-13. **`components/print/PrintSheetHeader`** (company, title, optional lines, "Generated …, <zone>.", optional "Printed by …", optional emphasis such as the headcount, `paperOnly`) heads both the evacuation list and the report; `PrintableReportHeader` is deleted. The report's "Generated" line now also names the time zone.

L-FE-14. **`maxLengthMessage` is in `utils/forms.ts`** (tested); `checkOutForms`, `walkInForm`, `inviteForm`, `visitEdit` and `visitorFields` import it from there (FX-8).

L-FE-15. **One refresh after a visit change, also for D-18 and D-17 (FX-5).** — `useUpdateUser` calls `refreshAfterVisitChange` when `cancelled_visits` > 0, which adds visitor searches to what was refreshed, so "Find a visitor" drops the cancelled visits. It also invalidates `visits.all` for the details. `useRefreshAfterDepartmentChange` does the same after a rename or a (de)activation. Tests: `features/admin/queries.test.tsx` (fails without the change).

L-FE-18. **The history searches from three characters (B57-65 hand-over).** — `isHistorySearchable` counts the folded text, so an accent is not a character. A shorter text is still kept in the URL but not sent, it is not counted as a filter, and the search hint says "Type at least 3 characters to search." Arabic and digits count like letters. Tests: unit tests and a page test (two characters send no `q`, three do).

L-FE-19. **The evacuation list's visitor phone has its own line** (`data-visitor-phone` block, `mt-0.5`), also when there is no company line between it and the name. Measured at 820 and 390; tested with Adam Noor (no company, a phone).

L-FE-27. **A card without flags leaves the flags out.** — The flags column has `isEmpty`. The kit's `Table` now honours `isEmpty` for `inline` cells too (before, only `row` cells), so the card has no blank band; the table keeps its sr-only "None" (tests in `Table.test.tsx` and `InsidePage.test.tsx`).

L-FE-28. **Departments flag only the exception**, as Users do (FY-8): the Status column is gone, and an inactive department's name is muted with an "Inactive" badge.

L-FE-29. **The combobox toggle is 44 px wide on coarse pointers** (`pointer-coarse:w-11`, the text `pointer-coarse:pr-11`).

L-FE-32. **Company settings: minutes fields and a save bar in reach.** — The grace periods are narrow number fields (`max-w-28`) with a "min" suffix. The suffix is shown, not read; the hint says the minutes in words. The Save/Discard bar is sticky at the bottom, edge to edge, like the walk-in's (FY-5). **Found on the way:** with a sticky bar, a field reached with Tab could sit under it (WCAG 2.4.11). `index.css` gives `html:has([data-sticky-actions])` a 6rem `scroll-padding-bottom`, and both bars carry the attribute. Measured at 1440 × 900: Save ends at 888 px, and tabbing from the time zone to the reception checkboxes never leaves focus under the bar (it did before).

L-FE-33. **Link tiles look like links at rest**: `StatTile` with `to` shows a trailing chevron (decorative, hidden in print) beside its label.

L-FE-34. **Report polish.** — "Point at or tab to a mark in a chart to read its value. “Show table” lists a chart’s figures." is said once, above the charts. The readout line is empty until a mark is hovered or focused. The top hosts table fills its card, and the visits column gains a bar scaled to the busiest host (SVG, decorative, hidden on phones). Below `sm` "Show table" sits under the summary, which keeps the card's width (measured at 390: 324 px, no page overflow). The stranded "·" is L-FE-2's "and".

## Kit and other

L-FE-25. **"No-show" everywhere.** — The NO_SHOW status label (badge, history status chip, audit values) now matches the counts, reports and lists.

L-FE-37. **The Phase 9 camera launch is recorded in `playwright.config.ts`**: the real-camera spec must launch `channel: 'chromium'` with the fake-device and Y4M flags and camera permission. Checked here with Playwright 1.63 and Chromium 153.0.8010.12: with a Y4M file the headless shell rejects `getUserMedia` with NotSupportedError, granted or not, and `channel: 'chromium'` opens it at 640×480@30. The shell's built-in fake device without a file does work.

L-FE-38. **The client mirrors L-BE-1 (backend hand-over).** — `isBlankText` (`utils/text.ts`, tested) treats text made only of white space, Unicode's Default_Ignorable_Code_Point set (U+200B, U+2060, U+FEFF, the bidirectional marks, the Hangul fillers, …) and U+2800 as empty. That is the set the server now strips; JavaScript's `trim()` keeps most of it. The following now say they are missing before anything is sent: the OVERRIDE reason, the CORRECTED note and the bulk reason (`validateReason`), the walk-in's OTHER note and purpose, a new visitor's full name, and the invite and edit purposes. Text with anything visible is never blank, so a ZWNJ inside a Persian word is kept.

## Security audit, round 1 (SEC-n)

The frontend findings of the first security audit. Each was reproduced or confirmed against the code first; the IDs are the audit's. The shared-device setting the findings assume is the one the contract names (§7.2: idle timeout "on shared tablets"; logout clears the query cache), and `session.ts` states the rule they test: one user's server data is never shown to the next user of a shared device.

SEC-20 and SEC-27. **Search text and visitor names stay out of the browser's saved history.**
   - **The problem.** The browser records every address a tab shows, also those written with `history.replaceState`, together with the page title. It keeps them after sign-out in its saved history (Ctrl+H, address-bar suggestions, sync to the browser account, 90 days by default). So `/visitors?q=jane.doe@corp.example`, `/history?q=%2B962…`, "Visit of Zainab … · Visitor Management" and `/login?next=%2Fvisitors%3Fq%3D…` were all readable later by anyone at the device. No page can remove an entry once the browser has recorded it, so the fix is never to write one.
   - **Private parameters** (`PRIVATE_PARAMS` in `paths.ts`): `q` (the text typed into a search box: names, email addresses, phone numbers) and the history's `hostName` hint. `useUrlParams` keeps them in the history entry's state (`location.state.view = { owner, values }`), never in the query string. Tab, page, status, dates and IDs stay in the query string, so a view is still bookmarkable apart from its search. The back button, a reload and every "Back to …" link still restore the search: a back link now carries the router state of the page it returns to (`useBackLinkToHere`, `BackLink.state`, passed on by `PageHeader` and the error views). Affected pages: Visitors, My visits, Visit history and Users.
   - **Old links.** A link from an earlier version with `?q=` still opens its search, and the text leaves the address at once (an effect moves it into the state with a replace navigation). `safeNextPath` drops private parameters, so `?next=` (`loginPath` and post-login) never carries them, also from a crafted link.
   - **Owner tag.** The state is tagged with the signed-in user's ID (`useSessionUserId`). After a sign-out and another user's sign-in in the same tab, the back button reaches the earlier entries, but their search text is ignored, and the next user sees an empty search box.
   - **Generic titles.** The two detail pages' titles are "Visitor profile" and "Visit details". The page heading (h1) still shows the name; only the title is kept by the browser. WCAG 2.4.2 still holds, since the title names the page's purpose.
   - **Why the entry's state.** Component state would lose the search on Back, which decision phase-2-4-frontend #6 chose the URL for. `sessionStorage` would be one value per tab rather than per entry, so the sidebar's "Visitors" link would reopen the last search.
   - **Found on the way.** `useUrlParams` dropped the entry's other state on every change: paging a visitor's history lost the back link the profile had been handed. It now keeps it. Each change also builds on the previous one before that navigation has rendered, for example when data arrives between two changes. The migration of an old `?q=` link exposed this in `UsersPage.test.tsx`.
   - **Residual risk.** Chromium also writes each entry's state into its session-restore files (`Sessions/Session_*`, `Tabs_*`) for as long as the tab's history exists. Measured: the typed search text is there (UTF-16), and no visitor name is. Those files are not shown in the history page or the address bar and are not synced. The app ignores another user's state from them (also after Ctrl+Shift+T). Reading them takes file access to the browser profile. The shared-device policy below removes them.
   - **Tests.** `useUrlParams.test.tsx` covers the search out of the address, even for a moment (`recordAddresses`); Back restoring it; the migration of an old link; another user's state being ignored; the kept back link; and changes building on each other. `redirect.test.ts` covers `?next=` without private parameters. The page tests for Visitors, My visits and Visit history check that no address the router showed contained `q=`, and Visitors checks the round trip through a profile. The detail-page tests check the generic titles.

SEC-26. **A sign-in or sign-out in one tab reaches every tab of the browser.**
   - **The problem.** All tabs share the session cookie, but each tab has its own query cache, and only `endSession` in the tab that signed out cleared it. After user B signed in elsewhere, user A's stale tab got 404 or 403 instead of 401, so the global 401 handler never ran. TanStack Query keeps the last data when a refetch fails, so A's visitor stayed on screen, and the account menu showed A for up to 5 minutes.
   - **Broadcast** (`auth/authSync.ts`). After a local sign-in or sign-out, the tab posts `signed-in` or `signed-out` on `BroadcastChannel('vms-auth')`. Where the API is missing, it writes a `storage` event and removes the key at once. The message carries only the kind of change, never user data. One channel object per tab sends and receives, because a channel never gets its own messages.
   - **Receiving tabs** (`AuthProvider`):
     - On `signed-out`, a tab with a session runs `endSession` and goes to plain `/login`. There is no `next`, because the next person may be someone else.
     - On `signed-in`, the tab re-checks `/auth/me`. A tab on the sign-in page then continues as the new user. A tab of the same user stays where it is: signing in again elsewhere does not bounce the user's other tabs.
     - A public page (`/pass`, the password pages) has its cache cleared but is not navigated away from.
   - **Identity check.** Whenever `['auth','me']` answers with another user or company than the tab held (`sessionIdentity`), every other query and the mutation cache are removed, and the tab starts again at `/`, which unmounts the previous user's page and its component state. A local sign-in or sign-out goes through an empty cache, so it never triggers the check.
   - **Missed messages.** `meQueryOptions` refetches with `refetchOnWindowFocus: 'always'`: `/auth/me` is asked again every time the tab becomes visible, however fresh it is (one request per tab switch). A tab that missed a message, or a session changed without one, is caught before anyone uses it.
   - **Refused refetches drop their data.** The query cache (`createQueryCache`, also used by the test client) removes a query's data when a refetch is refused with 404, or with 403 other than `PASSWORD_CHANGE_REQUIRED`. The page then shows its "not found" or "no access" state instead of the last data. This also covers a record deleted, or moved out of scope, while it is open.
   - **Not broadcast.** A 401 is not broadcast: the tab that saw it may lose a race with a fresh sign-in elsewhere and would sign that user out. The other tabs find out themselves on their next request or when shown again. A password reset is not broadcast either: it may be for an account other than the one this browser is signed in as. The tab that reset still ends its own session.
   - **Tests.** `auth/sessionSync.test.tsx` uses a second `BroadcastChannel` as "the other tab". It covers sign-out elsewhere; sign-in elsewhere as another user, including Back to a page of the previous user; the same user signing in again; a public page; the check when the tab is shown again; a refused refetch; both broadcasts; and the `storage` fallback. Each fails with its part of the fix reverted.

SEC-28. **Back links in the browser's history hold no names and only work for the user who made them.**
   - `backLinkState` tags the handed-over link with the user who wrote it. `useBackLink` ignores a link from another user's session and uses the page's default ("Back to My visits" or "Back to Visitors"), so an error view reached with Back shows nothing of the previous user.
   - Labels in the state are generic: the profile hands its visits "Back to visitor profile". The visit page names the visitor ("Back to Élodie Martin") only from the visit it has just loaded, when the link leads to that visitor's profile (`visitBackLink`). A 404 keeps the generic words.
   - Error views keep a handed-over link of the same user rather than always the default: a user's own 404 (a cancelled or reassigned visit) still leads back to where they came from.
   - Tests: the hook ignores another user's link; the visit page, reached with a foreign link and a 404, shows the default and no name; the profile hands over a state without the name, and the visit page shows the name.

SEC-29. **The reset token in the browser's saved history: not changed in code (rejected), comment corrected.**
   - Confirmed: the browser records the opened link `/reset-password#token=…` in its saved history when it loads the page, before any script runs. The loader's `replaceState` (decision phase-1-frontend #16) removes the token from the address bar, the tab's back/forward entry, the DOM, storage and router state, but no page can remove the recorded visit.
   - The overclaim was the doc comment of `captureResetToken` ("does not stay … in history"), not decision #16. It now states the limit.
   - **Why no code change.** The fragment link is the contract's (§7.2) and keeps the token out of server and proxy logs and the Referer header. The token is single-use, expires after 30 minutes, and is replaced by any newer request. The same link sits in the email on the same device.
   - The proposed exchange on page load (token → reset session) is rejected: a mail scanner that runs scripts, or a reload, would use up the token before the user acts. It also needs server state and a backend change outside this owner's scope.
   - What remains is covered by the shared-device policy below.

**Shared-device policy (hand-over to Phase 9, `docs/security.md`).**
   - Reception tablets, kiosks and any browser profile used by more than one person should run with:
     - managed browser policy that stops saved history and sync: Chrome/Edge `SavingBrowserHistoryDisabled` and `SyncDisabled`;
     - session restore turned off: `RestoreOnStartup` not 1;
     - `ClearBrowsingDataOnExitList` covering browsing history, cookies and session storage;
     - or a guest, kiosk or ephemeral profile.
   - Where possible, give each person their own OS account or browser profile. All tabs of one profile share one session, so two people need two profiles to be signed in at once.
   - Staff sign out explicitly when leaving a shared device. The idle timeout (§7.2) is the backstop, not the control.

## Security audit, round 2 (SEC-n)

Both findings were reproduced against the code first and confirmed live afterwards (see Verification). The IDs are the audit's.

SEC-33. **Phone numbers are dialled and read as stored, Arabic-Indic digits too (the SEC-10 hand-over in `phase-8-backend.md`, round 1).**
   - **The problem.** The server accepts phone numbers in ASCII, Arabic-Indic (U+0660–U+0669) and Extended Arabic-Indic (U+06F0–U+06F9) digits, also mixed, which is what Arabic and Persian keyboards type.
     - **Dialling.** `telHref` kept `\d`, which matches ASCII digits only. "+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢" dialled `tel:+`, which is nothing. "+962 79 ٥٠٠ 1003" dialled +962791003, a different number from the one shown.
     - **Display.** Arabic-Indic digits are "Arabic numbers" to the bidirectional algorithm, so a space between two groups of them resolves right to left. The groups therefore showed in reverse order: "+١٠٠٢ ٥٠٠ ٧٩ ٩٦٢".
     - **Where it hurt.** Both problems appeared on the evacuation list, which staff use to call hosts.
   - **Dialling** (`utils/phone.ts`).
     - `telHref` mirrors the server's phone grammar (`_PHONE` in `backend/app/schemas/common.py`): an optional leading "+", at least three digits with the separators (space, no-break space, narrow no-break space, `( ) . / -`), and an optional extension.
     - It maps both Arabic-Indic digit sets to ASCII (`asciiDigits`) and dials the digits in stored order.
     - Text that does not follow the grammar returns null, and `PhoneLink` shows it as plain text. Such text comes only from rows stored before SEC-10: words, a second number, direction controls or marks, other scripts' digits, or fewer than three digits. So no link can dial a number other than the one shown. This also covers the hand-over's "build `tel:` only when the text has no Bidi_Control characters".
   - **Extensions (found on the way).**
     - "(06) 555-0101 ext. 4" dialled 0655501014: the extension's digits ran on into a longer, wrong number. The old test asserted this.
     - The link now dials the main number. The extension is shown but not dialled.
     - Why not dial the extension: diallers read `;ext=` and the pause characters (`,` `;`) differently, and some strip them, which gives the same wrong number again.
   - **Display** (`PhoneNumber` in `components/ui/PhoneLink.tsx`).
     - Every phone number shown is a `<bdo dir="ltr">` with `unicode-bidi: isolate-override`. Each character is laid out left to right in stored order, whatever the text around it, and the number does not reorder the text next to it.
     - **The isolate that the audit and the hand-over proposed (`dir="ltr"`, `<bdi>`) does not fix the display.** The page is already left to right, and the reversal happens inside a left-to-right paragraph.
     - Measured in Chromium: a plain span, `<span dir="ltr">` and `<bdi dir="ltr">` all show "+١٠٠٢ ٥٠٠ ٧٩ ٩٦٢". The override shows "+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢", also inside right-to-left text.
     - The override is safe for phone numbers: the grammar allows only digits, separators, "+" and "x"/"ext.", and none of them needs reordering.
   - **Where it applies.**
     - `PhoneLink`: the evacuation list's cards and table, the visit facts, the reception rows, the visit cards, the visitor profile, the find-a-visitor dialog and the walk-in's host.
     - The printed evacuation list, the Visitors list and the selected-visitor summary.
     - The visitor and host pickers. The search match stays highlighted inside the number.
   - **Not done.**
     - The client validators do not mirror the grammar. The server answers 422 on the field with its own message, and the forms show it.
     - Stored rows are not rewritten (the server's decision). A row that does not follow the grammar is shown as plain text.
   - **Tests.**
     - `helpers.test.ts` covers both Arabic-Indic digit sets, mixed scripts, extensions, and 15 strings that must not be dialled. The same strings were checked against the server's `Phone` type, and the server refuses each one except a leading LRM, which it trims before storing.
     - `PhoneLink.test.tsx` covers the link and its override, the plain-text fallback, and a highlighted match inside the override.
     - `InsidePage.test.tsx` checks that every call link on the evacuation list dials exactly the digits it shows, and that the printed list shows the phone numbers in the override.

SEC-41. **Toasts end with the session.**
   - **The problem.**
     - `ToastProvider` sits above the router, and an error toast stays until it is dismissed (WCAG 2.2.1).
     - A refused one-tap check-out ("Zainab Haddad was not checked out") therefore stayed on the sign-in screen after any end of the session: a sign-out, a session that ended on the server, or a sign-out in another tab. It then carried over into the next user's session.
     - Success toasts that name people stayed for their 6 s.
     - Round 1 cleared the query cache, history entries, titles and history state, but not toasts.
   - **`ToastApi.reset()`** removes every toast and starts a new generation. After a reset, the API object handed out before it shows nothing. So a callback of the previous session that still holds one cannot bring a toast back, for example a request that settles after the change.
   - **When the reset runs.**
     - `AuthProvider` follows `['auth','me']`, where every change of who is signed in shows up: a sign-in or sign-out in this tab, a sign-out or another user's sign-in in another tab, a session that ended on the server (401), and a password reset.
     - When the identity (`sessionIdentity`: company and user) changes, including to or from "signed out", it resets the toasts.
     - A re-check that answers with the same user keeps them: a refetch, a password change, or the same user signing in again elsewhere.
     - The reset lives in one place instead of being called on each session path, so a new path cannot forget it.
   - **Timing (found on the way).**
     - The reset runs with TanStack Query's own notifications of the change (`notifyManager.schedule`), not immediately.
     - When it ran immediately, it re-rendered the components that show toasts before `RequireAuth` saw the signed-out state. A page of the previous user that re-renders on its own fetches its cleared queries again.
     - A toast requested before the reset runs is in the list the reset clears. One requested later, from an API object of the previous generation, is dropped.
     - The 401 case needs both parts. The tap that first learns the session has ended gets the 401, the session ends, and the check-out's error handler runs a moment later.
   - **Rejected: a finite lifetime for error toasts, or row errors shown inline instead.** Errors stay until dismissed so that they are never missed (WCAG 2.2.1). The session reset is the control for the shared-device risk.
   - **Tests.**
     - `Toast.test.tsx`: a reset removes every toast, errors included, and a kept API object shows nothing after a reset.
     - `auth/sessionToasts.test.tsx` uses the real routes and reception page, starting each case from a refused one-tap check-out:
       - sign-out through the menu, then an employee's sign-in;
       - a 401 on the session re-check;
       - a sign-out in another tab;
       - another user's sign-in in another tab;
       - a check-out that is itself answered with 401;
       - a re-check that finds the same user and keeps the toast.
   - **Found on the way (test).**
     - `sessionSync.test.tsx` "signs this tab out when another tab signs out" failed now and then under load: 4 of 10 parallel runs, with or without this change.
     - The cause: its mock served the visitor's profile without a session, so a refetch by the old page before it was replaced put the visitor back in the cache.
     - The real server answers 401 there, and the mock now does as well. It then passed 10 of 10 under the same load.

## Security audit, round 3 (SEC-n)

Both findings were confirmed against the code and live (see Verification). They have one root: the client learned that its session had ended only from a request that came back 401. A page that sends no request of its own, or a document that the browser froze and later restored, therefore kept the previous user's data on screen. That breaks the rule in `session.ts`: one user's server data is never shown to the next user of a shared device. The IDs are the audit's.

SEC-50. **A session heartbeat: a screen left open leaves within a minute of the server ending its session.**
   - **The problem.** Only the reception lists and the evacuation list poll (every 15 s). Every other page sent nothing while it sat on screen. Examples are a visitor's profile, the Visitors list, the history, the users list and a visit. `['auth','me']` was refetched only when the tab was shown again, and that never happens on a screen that stays visible. When the server's idle timeout (§7.2) or absolute lifetime ended the session, the page kept the visitor's email address and phone number on screen, and the account menu kept the user's name. SEC-41's toast reset did not run either. This lasted until someone touched the screen, for example overnight. The idle timeout is the shared-device backstop (the policy under SEC-29), so it has to clear the screen.
   - **The heartbeat** (`useSessionHeartbeat` in `auth/useAuth.ts`). While someone is signed in, `/auth/me` is asked every `SESSION_HEARTBEAT_MS` (60 s). A 401 goes through the existing path: `AuthProvider` runs `endSession`, the toasts are reset, and the tab goes to `/login?next=<page>` (private parameters are dropped, SEC-20). An answer that names another user goes through the identity check (SEC-26). Measured live: the screens left 55 s after the server's idle limit passed.
   - **One observer per tab.** `RequireAuth` mounts the heartbeat, so it runs on every authenticated route and on none of the public ones: `/pass` stays request-free. Every page reads `useAuth()`, but `refetchInterval` is not part of the shared `meQueryOptions`, so no page starts a timer of its own. The observer has `notifyOnChangeProps: []`, so it never re-renders `RequireAuth`. The interval runs only while a user is known (`query.state.data`). It does not run on the sign-in page, and it does not run behind "We could not load your session", where "Try again" is the person's to press.
   - **Hidden tabs beat too** (`refetchIntervalInBackground`). A tab in the background that is online when the session ends finds out within a minute. When it is shown again later, it is already at `/login`, even if the device is offline by then. The cost is one small request a minute per open tab. That is far under the per-user API limit (`RATE_LIMIT_API_PER_MINUTE`, 600). Browsers throttle hidden timers to about once a minute, which matches.
   - **The session check is not user activity.** `fetchMe` now sends every re-check with `X-Background-Refresh: 1` (`isBackgroundFetch`, the rule the polled lists already follow). That covers the heartbeat, the tab being shown again, and another tab's sign-in. Only the first check, a page load, is the user's own request. Without this the heartbeat would keep every idle session alive, and the idle timeout would never fire. It also closes a smaller gap of the same kind: a kiosk screen that wakes up (a visibility change) no longer extends the previous user's session on its own. Real use still extends it: page loads, the first load of each page's data, every mutation and a person's Refresh. Measured live: with the heartbeat running, `last_seen_at` stayed where it was.
   - **Rejected: the expiry sent in `Me` with a client-side timer (the audit's option 2).** A timer sees only the idle and absolute limits. It misses every other end of a session: deactivation, a password reset or change, an administrator's revocation, and a sign-in as someone else. It also depends on the device clock and needs a backend change to `Me`. The heartbeat covers all of these with the endpoint that already exists.
   - **Tests** (`auth/sessionExpiry.test.tsx`): a profile goes to `/login?next=…` within a minute of the server ending the session, with no visitor data, no account menu and no cached detail left. The heartbeat that found it carried the header. The headers are `[null, '1', '1', '1']` for the first check, a beat, a beat in a hidden tab, and the check when the tab is shown again. There is one beat a minute however many components read the session. Nothing is sent while signed out, and nothing behind the session-check error.

SEC-51. **A page restored from the back/forward cache shows nothing of the session until the server confirms it.**
   - **The problem.** The browser keeps a document it has left in its back/forward cache, frozen, with its query cache, component state and toasts. The app never leaves a document itself, but a typed address, a bookmark or a shortcut in the same tab does. If the session ended meanwhile without a sign-out in this browser, Back brought the previous user's visitor profile back. Possible causes are the absolute lifetime, deactivation, a password reset or a change elsewhere. A sign-out through the menu is broadcast, and the broadcast evicts the frozen document; a 401 is not broadcast (SEC-26). The only re-check was the refetch of `/auth/me` when the tab was shown. Online that left the profile up for one round trip. Offline, or with the API unreachable, the check failed, `useAuth` kept the last known user, and the profile stayed on screen. Its links even opened the cached Visitors list with names, emails and phone numbers.
   - **The fix** (`AuthProvider`, `forgetSession` in `auth/session.ts`). On `pageshow` with `persisted`, a tab that knows a session forgets it. Every query except `['auth','me']` is removed, and so is the mutation cache. `['auth','me']` is reset to "not known yet" and refetched. The toasts are reset in the same notification batch, so all of it lands in one render. `RequireAuth` then shows "Checking your session…" in place of the page until the server answers:
     - the same user carries on from data loaded again;
     - a 401 goes to `/login?next=<page>`;
     - another user goes through the identity check;
     - offline, the loader or "We could not load your session" stays, with nothing of the session behind it.
     A page without a known session (the sign-in page, a public page) is left as it is, and so is a normal page show (`persisted: false`). Measured in Chromium: the visitor's details are still in the restored DOM when `pageshow` fires and gone by the first animation frame after it, so no frame painted after the restore shows them.
   - **Why not `location.reload()`, as the audit suggested.** A reload does the same reset with a full document load. But the company settings form adds a `beforeunload` warning while it has unsaved changes. A reload would then ask "Leave site?", and Cancel there would keep the restored page and the previous session in place. The in-place reset cannot be cancelled and keeps the app shell.
   - **The trade-off.** The same user loses a restored page's component state, a half-filled form for example, because the page is rendered again from fresh data. Restores happen only after the user has left the app for another document and come back with Back, so this is rare.
   - **Not done here: a `pagehide` handler.** A frozen document runs no code, so data dropped on `pagehide` would still be in its DOM until the restore. The restore is the only point where it can be shown again, and that is where the reset runs.
   - **Hand-over to Phase 9 (nginx) *(gate)*.** Serve `index.html`, and every SPA fallback response, with `Cache-Control: no-store`. Most browsers then do not keep authenticated documents in the back/forward cache at all. Newer Chromium versions may keep some `no-store` pages, but they evict them when a cookie changes. A sign-in or sign-out changes the cookie; a session ended on the server does not (the backend clears cookies only at sign-out). In the Chromium the audit's verifier used, no restore took place with `no-store`. The hashed assets, `sw.js` and the manifest keep their own caching rules (phase-1-frontend #12). The app's reset stays as the control for browsers and configurations that do restore such pages. `vite preview` is unchanged (`no-cache`): it is where the restore can still be reproduced.
   - **Tests** (`auth/sessionExpiry.test.tsx`, `auth/sessionToasts.test.tsx`):
     - Restored offline after the session ended: the loader, no visitor data, no account menu and an empty query cache, still so later. Back online, `/login?next=<profile>`.
     - The same user: the profile is loaded again.
     - A normal page show and a restored sign-in page send nothing.
     - A refused check-out's toast is gone after an offline restore.

## Amends

SEC round 1: phase-2-4-frontend #6 (the search text left the URL; tab and page stay), phase-5-7-frontend-admin #6, #7 and #16 (`q` and `hostName` are private; a shared history link names its host "Selected host"), L-FE-3 (the same), phase-1-frontend #16 (the token's limit in saved history), #17 and #18 (sign-in and sign-out reach every tab; refused refetches drop their data).

SEC round 2: D-26 and the tap-to-call link (`PhoneLink`): a number with an extension dials its main number, and a stored number that does not follow the phone grammar is not a link (SEC-33). The toasts (an error stays until dismissed) now last only as long as the session that showed them (SEC-41).

SEC round 3:
- **SEC-26 "Missed messages".** The claim "a session changed without [a message] is caught before anyone uses it" was argued for a tab that is online and shown again. Two cases now also hold: a running tab, visible or hidden, finds out within a minute through the heartbeat (SEC-50), and a restored document is checked before it shows anything (SEC-51). The case still open is listed under Known limits.
- **SEC-26 "Not broadcast".** Other tabs still find out on their own, but now within a minute.
- **FX-4.** `isBackgroundFetch` now also covers the session check: every `/auth/me` after the first is a background refresh (SEC-50).

FR5-9 (the gate, L-FE-5) · FR5-17 (refusal titles, L-FE-26) · FR5-23 (one-tap check-out and its style, L-FE-6, L-FE-20) · FR5-24 (the search includes today's no-shows, L-FE-4) · FX-11 (touch focus on arrival, L-FE-31) · FX-17 (the beep switch's place, L-FE-30) · F57A-1 (thin pages, L-FE-7) · F57A-7 and F57A-6 (the history host name is a hint, L-FE-3; search from three characters, L-FE-18) · FY-9 (the tile hint, L-FE-2) · FY-10 (the printed report, L-FE-2) · FY-5 (the sticky-bar scroll padding, L-FE-32).

## Verification

- `npm run typecheck`, `npm run lint` (`--deny-warnings`), `npm test` and `npm run build` pass; the test and file counts are in the fix report. All three Playwright specs pass (`npx playwright test`; the new toast spec in the mobile project), and the toast spec fails against the old toast placement.
- Mutation checks: the walk-in refusal tests, the admin refresh tests, the touch-focus test and the toast spec each fail with their fix reverted.
- Real-browser checks (Vite on port 5243, API mocked by Playwright route interception, Playwright's Chromium; tablet and phone with touch, `pointer: coarse` confirmed):
   - the report printout as PDFs (above);
   - the phone toast hit tests, the one-tap check-out without a dialog, the row menu in the corner and the scan layout at 1440, 820 and 390;
   - focus after a page load, the camera-unsupported state, the evacuation cards at 820 and 390;
   - settings at 1440 × 900 (sticky bar, Tab focus), the dashboard chevrons, the departments list and the history hint;
   - axe on 12 screens at 1440 and 390 (reception's four tabs, Inside now, reports, admin dashboard, settings, departments, users, audit log, history): no serious or critical violation.
- Scripts, screenshots and PDFs lived in the session's scratch directory, outside the repository. The Vite server was stopped, and Playwright's `test-results` and `playwright-report` folders were removed.
- **SEC round 1:**
   - `npm run typecheck`, `npm run lint`, `npm test` (97 files, 1099 tests; 1077 before) and `npm run build` pass. The three Playwright specs still pass.
   - Mutation checks: each part of the SEC-20/26/27/28 fixes was reverted on its own, 16 in all, and its tests failed every time. The parts: private parameters written to the URL; an old link not moved; state not owner-checked; `next` keeping private parameters; the names in both titles; the back link not owner-checked; a name in the back-link state; the cross-tab listener; the identity check; `me` not re-checked on focus; refused data kept; each broadcast; the public-page guard; the pending-navigation guard.
   - **Live check** against the real API: a throwaway database seeded with `seed-e2e`, the built SPA from `vite preview` (CSP headers on), and Chromium (`channel: 'chromium'`) with a persistent profile. 17 of 17 checks passed:
     - Reception searched Visitors by email and the history by phone; the address never had the text.
     - The profile and visit titles are generic, and the visit page shows "Back to <name>" while `history.state` has no name.
     - The back links and a reload restore the search; Back after sign-out lands on `/login?next=%2Fvisitors`.
     - Lina (no access) then signed in in the same tab and walked Back through every entry: no name, email, phone or search text appeared.
     - The profile's saved `History` database, read after closing, held only paths with IDs and generic titles. The session files held the search text, but no name (see SEC-20's residual risk).
     - Two tabs: a sign-out in tab 2 took tab 1 to `/login` at once, without its data. Lina's sign-in in tab 2 moved tab 1 on to her landing page. A sign-in sent straight to the API (no message) was caught when tab 1 became visible: Omar's profile left the screen, and the menu named Lina.
   - The throwaway database, both servers, the browser profile and the scripts were removed afterwards.
- **SEC round 2:**
   - **Gate.** `npm run typecheck`, `npm run lint`, `npm test` (99 files, 1115 tests; 1099 before) and `npm run build` pass. The three Playwright specs still pass (5 passed, 10 skipped by project, as before).
   - **Mutation checks.** Each part was reverted on its own, and its tests failed every time:
     - SEC-33: `telHref` without the digit mapping (3 tests); phone numbers without the override (4).
     - SEC-41: no reset (5); a reset on every answer from `/auth/me`, including the same user's (1); no guard against an earlier generation's API object (1); a reset that leaves the list (1).
   - **Load.** The session tests and the reception lists ran in 10 parallel processes, 10 of 10 green, twice. At 8 or more parallel processes of the larger set, a cold load of the lazy reception route can exceed the 5 s `findBy` wait in `guards.test.tsx` and `ReceptionLists.test.tsx`. Neither file is changed by this round, and neither fails in a normal run. `sessionToasts.test.tsx` loads that module in `beforeAll`.
   - **Live check (SEC-33).**
     - Setup: a throwaway database seeded with `seed-e2e`, the API, the built SPA from `vite preview` (CSP headers on), and Chromium (`channel: 'chromium'`).
     - Data created through the API: a visitor "+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢" (201), one "۰۷۹ ۵۰۰ ۱۰۰۴" (201), a walk-in "+962 79 ٥٠٠ 1003", and the host phone "٠٧٩ ٥٠٠ ١٠٠٢" (PATCH 200).
     - Screens checked at 1440 and 390 px: `/inside` (screen and print), the reception Inside tab, the visitor profile and the visit page.
     - Method: each phone number's characters were sorted by their measured position (line, then x).
     - Result: every number showed in stored order, and every link dialled the digits shown (`tel:+962795001002`, `tel:0795001002`, `tel:0795001004`, `tel:+962795001003`).
     - The first 390 px print measurement sorted by x only, which a number wrapped onto several lines defeats. Measured line by line, 14 of 14 passed, at 390 px and at A4 width.
     - A row set directly in the database to "079 500 1002 or 1003" showed as plain text with no link. The Visitors list shows its phone numbers in the override.
   - **Live check (SEC-41).** The tablet's clock was set 10 minutes ahead so that a fresh walk-in is a one-tap check-out. In each case a colleague had already checked the visitor out, so the tablet's one-tap check-out got 409 and showed "<name> was not checked out". Then:
     - S1: sign-out through the menu. `/login` had no toast 8 s later, and an employee who signed in next (`/visits`) saw no toast and no name.
     - S2: the session was revoked from another client (204). The poll took the tablet to `/login?next=…` with no toast.
     - S3: sign-out in a second tab. Tab 1 reached `/login` with no toast.
     - S4: the session was revoked and the check-out itself got 401. `/login` showed no toast.
   - **Cleanup.** The database was dropped, the servers on ports 8771/8772 were stopped, and Playwright's output folders were removed. The scripts and screenshots stayed in the session's scratch directory.
- **SEC round 3:**
   - **Gate.** `npm run typecheck`, `npm run lint`, `npm test` (100 files, 1125 tests; 1115 before) and `npm run build` pass. The three Playwright specs still pass (5 passed, 10 skipped by project).
   - **Mutation checks.** Each part was reverted on its own (11 in all), and at least one test failed every time:
     - SEC-50: no heartbeat (3 tests); beats without the header (2); no beat in a hidden tab (1); beats without a known user (1); the interval in the shared `meQueryOptions` (2).
     - SEC-51: no `pageshow` handler (3); `persisted` ignored (1); no session guard (1); toasts kept (1); data kept (2); `['auth','me']` kept (3).
   - **Load.** The three session test files ran in 8 parallel processes: 8 of 8 green.
   - **Live check.** Setup: a throwaway database seeded with `seed-e2e`, the API on 8791, the built SPA from `vite preview` on 8792, and Chromium (`channel: 'chromium'`, with the back/forward cache allowed; Playwright's default flags turn it off, and the headless shell did not restore pages). Reception had a visitor's profile open (name, email, phone), and an administrator had the users list open. 24 of 24 checks passed:
     - SEC-50, the beat: the sessions were set 200 minutes idle. Within 65 s each screen sent exactly one `/auth/me` with `X-Background-Refresh: 1` and nothing else, and `last_seen_at` did not move.
     - SEC-50, the expiry: the sessions were then set 241 minutes idle. Both screens were at `/login` 55 s later, the profile at `?next=<profile>`, with no visitor data, no users list and no account menu. The sign-in page then sent nothing for 65 s.
     - SEC-51: the profile (D1) was left for `/reception` with `page.goto` (D2). In the first two cases the session was then revoked in the database, and D2's poll took the tab to `/login`. In all three cases Back restored D1 (`pageshow` with `persisted`). The visitor's details were in the DOM at `pageshow` and gone at the first animation frame.
       - Offline: no visitor data and no account menu at 3 s and 8 s, only "We could not load your session". Back online, "Try again" led to `/login?next=<profile>`.
       - Online with the session ended: `/login`, with no visitor data.
       - Online as the same user (nothing revoked): the profile came back, loaded again.
   - **The same script against a build without the fix** (heartbeat and `pageshow` handler removed, built into the scratch directory): no beat in 65 s, and the profile had still not left for `/login` 75 s after the idle limit passed. After an offline Back, the restored profile showed "Adam Noor", the email and the phone, with the account menu, at the first frame, at 3 s and at 8 s. Back online it was still there 30 s later, because nothing checked the session again.
   - **Cleanup.** The database was dropped, both servers were stopped (8791 and 8792 refuse connections), and Playwright's output folders were removed. The scripts stayed in the session's scratch directory.

## Known limits

- The history's host filter can name only an active host whose current name matches the hint; otherwise it says "Selected host" (the list is still filtered by the host's ID). Since SEC-20 the hint is private, so a bookmarked or shared history view always says "Selected host"; Back, a reload and the back links keep the name. A lookup by ID for non-administrators would need a new endpoint.
- A bookmarked or shared list view no longer carries its search text (SEC-20); its tab, page and filters still apply.
- Chromium's session-restore files keep the search text of a tab's history entries (owner-tagged state, no names) until the tab's history is gone; the shared-device policy under SEC-29 removes them (SEC-20).
- Two people cannot be signed in at once in two tabs of one browser profile: the session cookie is shared, and every tab now follows the latest sign-in (SEC-26). Separate profiles are needed for that.
- On Letter paper the department and hour charts start page 2 (page 1 is about two thirds full); the report is still two pages.
- On a phone, a toast at the top can cover the Close button of a dialog tall enough to reach the top of the screen for its 6 s; Cancel in the dialog's footer and Escape still work.
- A phone number stored before the server's phone grammar (SEC-10) that does not follow it is shown without a call link. An extension is shown but not dialled (SEC-33).
- Between a change of session and TanStack Query's next notification flush (one task), a toast that a component requests through its current API object is shown and then cleared with the others (SEC-41).
- After the server ends a session, a screen that sends nothing keeps showing what it showed for up to a minute (the heartbeat interval). The server also writes `last_seen_at` at most once a minute, so the idle timeout fires up to a minute after the last activity it counted (SEC-50).
- A tab that runs no code when its session ends, and is shown again while the device is offline, keeps showing what it showed. Such a tab is frozen by the browser (energy saver, a discarded or suspended tab) or sits on a sleeping device. Its re-check cannot be answered, and a failed re-check keeps the last known user (`useAuth`, for flaky networks). A tab that was running and online when the session ended, even a hidden one, is already at `/login` by then (SEC-50). A document in the back/forward cache is checked on restore (SEC-51). A sign-out through the menu is broadcast to every tab. The shared-device policy under SEC-29 remains the control.
- A page restored from the back/forward cache is rendered again from fresh data, also for the same user, so a half-filled form on it is lost (SEC-51). Between the browser's restore and the `pageshow` handler the frozen document is what the browser shows; measured in Chromium, the previous session's data is gone by the first animation frame after `pageshow`. The Phase 9 `no-store` gate keeps such documents out of the cache in most browsers.
