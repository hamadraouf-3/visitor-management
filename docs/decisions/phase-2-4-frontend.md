# Phases 2–4 — Employee frontend: decisions and deviations

Date: 2026-10-05 · Scope: `frontend/` · Contract: `docs/initial-assessment.md` revision 2

Each entry: **decision** — reason. Items marked *(gate)* need confirmation or a matching choice on the backend side. Numbering continues the Phase 1 file with the prefix F2.

## Phase 1 carry-over

1. **`Menu` is named by its trigger and keeps its header outside `role="menu"`.** — The popup now wraps an optional header and the menu element; the menu has `aria-labelledby` = the trigger's id, so it is announced as e.g. "Account menu for Lina Haddad". A menu may only own menu items, and arrow keys never visit the header. `Menu.test.tsx` (new) covers the name, the header placement, keyboard movement, actions and all close paths; the AppLayout test asserts the account summary is visible but not inside the menu.

## Structure and build

2. **The five new pages are regular (eager) routes; only the QR encoder is loaded on demand.** — Lazy route chunks were tried first: the first navigation into such a route in each test file paid about 4 s of on-demand module transforms, more than Testing Library's 1 s `findBy` timeout, so existing guard and login tests failed intermittently. The heavy and rarely used part is the `qrcode` encoder: `components/qr/useLazyQrCode` imports `QrCode` on first use (state, not Suspense, so the page knows when the code is on screen, e.g. before printing). It shares one chunk with `/pass`. Reception stays a lazy route (Phase 1 decision 13).
3. **Vendor chunk groups in the production build** (`build.rolldownOptions.output.codeSplitting.groups`: react, router, query, dates, icons). — The libraries change far less often than the app, so they stay cached across deployments and in the service-worker precache (the manifest plugin lists every emitted chunk; verified in `dist/sw-precache-manifest.js`). The app chunk is about 127 kB; before, one 512 kB chunk exceeded Vite's 500 kB advisory. No dependency change.
4. **Thin pages.** — `src/pages/*Page.tsx` read `me` and route parameters and compose `PageHeader` + one feature component (§3.1, Phase 1 decision 36). On the detail pages the header lives in the feature, because its title is the loaded visitor's name; the loading, loaded and error states render `PageHeader` at the same position, so the `h1` the layout focused after navigation stays the same element and keeps focus while the data arrives.

## My visits (`/visits`)

5. *(gate: backend dashboard)* **Tab → `GET /visits` filters** (`features/visits/myVisitsTabs.ts`, unit-tested around company-local midnight): Today = `date_from = date_to = today`, every status, ascending; Upcoming = `status=SCHEDULED`, `date_from = tomorrow`, ascending; Past = `date_to = yesterday`, every status, descending; Needs attention = `needs_attention=true`, ascending. Always `scope=mine` (administrators otherwise read every visit) and an explicit `order` (the backend defaults it per view). Days are company-local keys from `companyToday`/`shiftDateKey`. — The tab badges show `counts.today`, `counts.upcoming` and `counts.needs_attention` from `/dashboard/employee`; the backend should count exactly these sets so badge and list agree. A cancelled future visit appears in no tab (only in the visitor's history), which is deliberate for a "what is coming" list. *(Gate closed in 32: Today lists every status but CANCELLED, exactly what `counts.today` counts (B24-31); cancelled visits are found with the new status choice.)*
6. **Tab, search and page live in the URL** (`?tab=&q=&page=`). — `useUrlParams` applies several changes in one navigation (two `setSearchParams` calls in one tick would overwrite each other), `useSearchInput` debounces the search box (300 ms) from the change handler rather than from an effect (an effect would write stale typed text back over a URL changed by the back button). A new tab or search starts at page 1. While a page or search of the same tab loads, the previous rows stay (marked busy); another tab starts empty, so rows of one tab never show under another.
7. **Count tiles link to their tab; "Inside now" has no link; Past has no badge.** — No tab lists checked-in visits across days (the evacuation list is `/inside`, not an employee screen), and the dashboard's 30-day counts do not describe "Past". The 30-day completed/cancelled counts are shown as one line under the tiles. On phones the tiles use two columns (four stacked tiles pushed the list off the first screen in the browser check, see 31). *(Superseded in 33: the tiles are gone.)*

## Invite visitor (`/visits/new`)

8. **The success headline states the delivery status the server reports.** — "Invitation sent to <email>" appears once the polled status is SENT; while PENDING it reads "Sending the invitation to <email>…", on FAILED "The invitation to <email> could not be sent", and after the polling window "… is still being sent" with a "Check again" button. Without an invitation it is "Visit created — no invitation sent". A polite live region announces each status change. *(Superseded in 38: the heading is always "Visit scheduled for <name>"; the status is the line under it.)* — §10 polls because delivery is asynchronous (background task after commit); claiming "sent" before it is would mislead the host into not sharing the pass.
9. **Invitation polling: every 2 s for 30 s, on the success view and on the visit page.** — `useVisitDetail` polls only while the invitation is PENDING and the window is open; the window opens on mount and again after a resend or "Check again", and TanStack pauses it in a hidden tab. §10 states no limit for the visit page; it is bounded there too, because a lost background task leaves a row PENDING indefinitely (§12) and an unbounded 2 s poll would run for as long as the page stays open. These requests do not send `X-Background-Refresh`: they run only within 30 s of a user action, so they cannot keep an idle shared device signed in (§7.2).
10. **Returning visitors.** — The typeahead searches from 2 characters (10 suggestions, scoped by the server); picking a visitor replaces the new-visitor fields with a summary and sends `visitor_id` only. A returning visitor without an email plus "Send invitation email" is refused on the visitor field before sending; the server's `VISITOR_EMAIL_REQUIRED` is mapped to the same field (to the Email field for a new visitor).
11. **The department follows every host change**; the host's own department is always offered as an option, even while the department list loads or if it is no longer in the active list, so the default is visible. The server validates the department. *(Superseded in 34: an inactive host department is no longer the default, and "No department" is offered only when the server can honour it.)*
12. **Client rules mirror the server** (`inviteForm.ts`, `schedule.ts`, `visitors/visitorFields.ts`): purpose 1–500 characters after trimming, full name 1–200, email required only when sending (permissive pattern that accepts `.local`/`.test`, B1-22), phone ≤ 40, company ≤ 200; end after start, at most 24 h, start not more than 5 minutes in the past, at most 365 days ahead (D-14). — No `maxLength` attributes: a pasted text would be cut silently. Purpose and reason fields show a character count in their hint. Server field messages (`details.fields`, e.g. `visitor.email`, `scheduled_start`) go to their fields; anything else (e.g. `body`) to the form alert (Phase 1 decision 46).
13. **The request carries UTC instants** (`…Z`), which are timezone-aware as §3.2-7 requires. — `DateTimeField` converts the company wall time typed by the user; tests run the payload with the browser in Los Angeles and Auckland while the company is in Amman. Empty optional fields and "No department" are left out.
14. **The one-time pass link never outlives the page that shows it.** — It lives in component state only (never in the URL, browser storage or the query cache); the create and resend mutations use `gcTime: 0`, so the mutation cache drops it when the form or dialog that sent the request unmounts; "Invite another visitor" and leaving the page discard it. `PassActions` offers a read-only link field (the manual-copy fallback the CopyButton failure message refers to), Copy link, Show QR code (dialog) and Print pass. Printing uses a print-only, `aria-hidden` portal copy of the pass (company, visitor, date and time with the timezone, host, QR code, instructions) and `body:has(> [data-print-pass]) > :not([data-print-pass]) { display: none }`; the Print button is enabled once the QR renderer has loaded, so the paper never lacks the code.

## Visit detail (`/visits/:id`)

15. **Actions come only from `visit.permissions`** (`can_edit` → "Edit or reschedule", `can_resend` → "Resend invitation" or "Send invitation" when none was sent, `can_cancel` → "Cancel visit"). `can_check_in`/`can_check_out` belong to the reception screens (Phase 5). Tests show a MANAGEMENT user with `can_cancel` sees the action and an EMPLOYEE owner with no permissions sees none. The back link returns to the exact list view the user came from (`backLinkState`/`useBackLink`, in-app paths only), else to My visits, or to Visitors for roles without My visits.
16. **Edit sends only what changed.** — An unchanged schedule is not sent, so editing the purpose does not email the visitor; "not in the past" applies to a changed start only (a visit that has just started can still get a new purpose); a cleared department is `null` (Phase 1 gate 26); without changes the dialog closes without a request. A new start keeps the visit's length, as on the invite form.
17. **Cancel and resend.** — Cancel: optional reason (≤ 300, left out when blank), `notify_visitor` always sent (default true), described as not undoable. Resend: a confirmation with the warning "The previous QR code will stop working" before anything happens; afterwards the one-time pass actions appear above the details until "Done". After a refused change (409, 404, 403) the visit is reloaded so its status and permissions are current. Every error shows the server's message.
18. **Invitation failure in plain words.** — The card says the email could not be delivered to the address, to check it and resend or share the pass; the provider's sanitised error (e.g. "Recipient domain is configured to fail (EMAIL_FAIL_DOMAIN).") sits under "Technical details". A failed invitation offers "Resend invitation" in the card when `can_resend`. *(Superseded in 39: the failure is a banner under the page header with "Correct email and resend" and "Resend to same address".)*
19. **Focus.** — The success heading takes focus after creating; "Invite another visitor" focuses the first field; after a cancellation the dialog's trigger no longer exists, so focus moves to the page heading (`focusPageHeading`); after a resend it moves to the new pass panel, and "Done" returns to the heading.

## Visitors (`/visitors`, `/visitors/:id`)

20. **Search lists in-scope visitors also without a search text** (server order, 25 per page), with today's SCHEDULED/CHECKED_IN visits linking to the visit. A scope note is shown to holders of only EMPLOYEE (`hasScopedVisitorAccess`: none of SYSTEM_ADMIN, RECEPTIONIST, MANAGEMENT, §7.5); the profile says "Only visits you host or created are shown." and labels the count accordingly.
21. *(gate: backend D-19)* **Visitor edit sends only changed fields** (emptied optional fields as `null`), compares email addresses case-insensitively (they are stored lowercase), and shows a warning as soon as the email differs: invitations are re-sent to the new address and QR codes sent to the old one stop working. For an email cleared to empty, the warning says the old QR codes stop working and no new invitation can be emailed; the backend should confirm that clearing the email revokes like a change does. `VISITOR_EXISTS` is shown on the Email field.
22. **The history loads after the profile** (20 per page, `?page=`), so a missing visitor gives one 404, not two.

## Kit, hooks and helpers

23. **Additions:** `SearchField` and `DescriptionList` (UI kit); hooks `useUrlParams` (+ `readPageParam`, `readEnumParam`, `pageParamValue`), `useSearchInput`, `useBackLink`/`backLinkState`, `useNow`; `utils/focus` `focusPageHeading`/`isFocusLost`; `utils/text` `characterCountLabel`; `auth/roles` `COMPANY_WIDE_VISITOR_ROLES`/`hasScopedVisitorAccess`; `queryKeys.visits.lists` (refresh lists without refetching a detail just set from a response). Test helpers: `src/test/fixtures.ts`; `renderRoutes` accepts router `InitialEntry` values (a location with state).
24. **`useNow()` instead of `Date.now()` during render** (the React purity lint rule). — It refreshes every minute, so "Today" labels and the company-local date in list filters roll over on a page left open past midnight.
25. **Table columns come from module-level factories** (`visitColumns(context)`), as the lint rule against components defined during render requires.
26. **Links to today's visits in the visitor search are named "<time> with <host>" by `aria-label`.** — The name starts with the visible text (WCAG 2.5.3); visually hidden text lost its separating space in accessible-name computation.
27. **The QR dialog's footer button is "Done".** — The dialog header already has "Close"; two buttons with one name in a dialog are ambiguous for screen-reader users.

## Contract

28. **`ApiErrorCode` gained `PAYLOAD_TOO_LARGE`.** — The backend builder regenerated `backend-contract.json` during this phase (413 from its body-size middleware); `api.contract.test.ts` failed until `api.ts` followed. No other contract change.

## Tests and verification

29. **Existing tests that land on the real pages now mock their endpoints** (`myVisitsRoutes()`, `visitorsRoutes()`). The PASSWORD_CHANGE_REQUIRED guard test triggers the 403 from `GET /visits`, because `/visitors` now loads data on mount.
30. **Page tests fake only the clock** (`vi.useFakeTimers({ now, toFake: ['Date'] })`), so debounces and queries run on real timers; polling tests use `shouldAdvanceTime` with `vi.advanceTimersByTimeAsync`. The suite has 523 tests (was 398).
31. **Real-browser layout check.** — With the dev server on port 5181 and the API mocked by Playwright route interception, the five screens, the success view, the QR dialog and print media were rendered in the system Chrome (`channel: 'chrome'`; no Playwright browsers were downloaded) at 390×844, 820×1180 and 1440×900: no horizontal page overflow, no console errors, tables stack below `md`, print output is the pass alone. The script and screenshots were throwaway files under the ignored `frontend/test-results/` and were removed; the server was stopped.

## Gate review round 1 (2026-10-05)

Fixes for the 34 frontend findings of the first Phase 2–4 gate. Each finding was checked against the code first. All were real; parts of six are rejected below, each with its reason. Findings 1 and 3 are the same defect.

### My visits

32. **Today lists what the Today badge counts: every status except CANCELLED (findings 1, 3; closes gate 5).** — `visitListParamsForTab('today')` sends `status=SCHEDULED,CHECKED_IN,CHECKED_OUT,NO_SHOW` (`TODAY_STATUSES`), which is B24-31's `counts.today`. The fix is on the frontend: the dashboard's own `today` list also leaves cancelled visits out, and `tests/integration/test_dashboard_api.py` already pins `today=3` on the backend side. `myVisitsTabs.test.ts` and `MyVisitsPage.test.tsx` pin the statuses on this side.
    **Cancelled visits can be found again (finding 18; changes 5):** each tab except Needs attention has a "Show" choice, kept in `?show=`. Today offers *All but cancelled* or *Cancelled*. Upcoming offers *Scheduled* or *Cancelled*. Past offers *All statuses*, *Attended*, *No-shows* or *Cancelled*. The default is always the set the badge counts. A choice belongs to its tab and is reset when the tab changes, like the page.
    *Rejected:* linking the 30-day completed and cancelled counts to a list. Those counts go by `check_out_at` / `cancelled_at`, but `GET /visits` filters by the scheduled date. A linked list would show a number different from the one clicked, which is the defect of finding 1 again.
33. **The count tiles are gone (finding 15; supersedes 7).** — Today, Upcoming and Needs attention were shown twice, once as tiles and once as tab badges. What remains is one summary line above the tabs: an "N inside now" badge and "Last 30 days: N completed · N cancelled". The line keeps its height while loading ("Loading counts…"), so the list no longer jumps. A Needs attention badge above 0 uses the warning tone. If the counts fail, the line says so and offers one retry. If the counts and the list both fail, one alert ("My visits could not be loaded") offers a single retry that reloads both (finding 29). The page description names the time zone once (finding 32).

### Invite visitor

34. **The department default follows the server's rule (finding 4), which also fixes a defect found while checking it.** — On create, a missing `department_id` makes the server use the host's department (B24-23). The contract has no way to ask for "none": `VisitCreate.department_id` is an optional string, and the backend reads `null` as missing. The form behaved as if it could:
    - The form's "No department" option silently produced the host's department.
    - A host department that had been deactivated stayed the default, and the visit was refused with "This department is inactive."
    `inviteDepartmentChoice` (pure, tested) now drives the field:
    - "No department" is offered only when the host has no active department.
    - A host department that is not in the active list shows as "No department", which is what the server then applies.
    - While the list loads, the host's department is listed.
    `toVisitCreate` leaves out `department_id` when it is the host's own department, so the server's default also covers a department deactivated after the form loaded. A page test covers a host whose department is missing from the active list.
    *(gate: contract owner)* Choosing "no department" for a host who has one needs a contract change, such as `department_id: null` meaning none on create. Until then the visit can be cleared afterwards with Edit (PATCH accepts `null`).
35. **The schedule is one group with a read-back (findings 11, 12).** — `ScheduleFields` (visits feature) is used by both the invite form and the edit dialog. It renders Starts / Ends without per-field hints. Below them is a polite live line that reads the range back in the app's format, e.g. "Mon, 5 Oct 2026 · 20:30–21:30 (1h)" (`scheduleReadBack`, pure, tested). Under that, one group hint ("Times in Amman time (UTC+3). A visit can last up to 24 hours.") is linked to both inputs with `aria-describedby`. `DateTimeField` gained `showTimeZone` and `describedBy` for this. *Not done:* replacing the native input with a separate date input and 24-hour time select. The read-back removes the ambiguity, and a custom picker would be a new dependency or a large widget. *(Superseded in 55: a native date input plus a 24-hour time `Select`, no dependency.)*
36. **Returning or new visitor (finding 24).** — A divider, "or enter a new visitor", now separates the two ways in. The visitor search has no placeholder, because the hint below says what to type, and it uses a magnifier instead of select chevrons. Suggestions highlight the matched text, ignoring case and accents (`findMatch` + `HighlightMatch`, a span rather than `<mark>`, which screen readers announce in every option). Matches the server makes more loosely, such as Arabic letter variants or phone digits, are simply not highlighted. Once a visitor is picked, the summary shows company, email and phone but not the name, which the field already shows. "Enter a new visitor instead" uses a neutral icon. *Deviation from the suggested fix:* the combobox stays instead of being replaced by the summary. Replacing it would remove the focused control right after a selection, and it would detach the field that `useFormErrors` focuses for the "no email address" error.
37. **"Invite again" from the visitor profile (finding 26).** — The profile's primary action, shown to roles that may invite, links to `/visits/new?visitor=<id>` (`paths.inviteVisitorAgain`). The form resolves the visitor through the scoped `GET /visitors/{id}` and starts with them selected. A visitor that cannot be loaded falls back to the empty form with a warning. "Invite another visitor" clears the parameter.

### Invitation outcome, failure and recovery

38. **The success view leads with the visit (findings 10, 21, 22, 33).** — The heading is always "Visit scheduled for <name>"; the address never appears in a heading. Below it, one polite status line gives the invitation's state, with a spinner while it is sent instead of a trailing ellipsis. SENT reads "Invitation sent to <address>.": SENT only means the provider accepted the message, so "delivered" and the "Delivered" field are gone everywhere. The page has one primary action:
    - When the email carries the pass (pending or sent): "View visit".
    - When it does not (failed, or no invitation): "Copy link". The pass panel then says "Share this pass with the visitor now … this is the only way they get their QR code."
    The reuse note names the address the match was made on, which is only what the host typed (§7.5), and says saved details were not overwritten. On phones the buttons form one full-width column.
39. **A failed invitation can be fixed where it is seen (findings 7, 8, 25).**
    - **Visit page.** A banner directly under the header says "The invitation email to <address> could not be sent" and gives the advice. Its actions are "Correct email and resend" (primary) and "Resend to same address". The header's own Resend is left out while the invitation has failed, so the action is not duplicated. The header shows the invitation state next to the visit status ("Invitation failed").
    - **Correcting the address.** "Correct email and resend" opens `EditVisitorDialog` with `intent="correct-email"`: its own title, focus on the Email field, and "Save and send invitation". It is offered only when the visitor's own `permissions.can_edit` allows it. `useCorrectableVisitor` loads `GET /visitors/{id}` for this, only when the invitation failed or the visitor has no address. The server re-sends the invitation to the new address by itself (D-19), and the page then restarts polling.
    - **Resend dialog.** After a failure it offers "Correct email and resend" as well, next to "Resend to same address".
    - **Success view.** It offers the same two actions, except "Correct email" after an inline reuse (D-05). The address is then the one the match was made on, and loading the existing record into a form right away would show stored details of a visitor who was outside the caller's scope until a moment ago (§7.5, B24-15). A resend there replaces the shown pass link with the new one and says so. A corrected address withdraws the shown link, because D-19 revoked that pass and emailed a new one. A cleared address does the same.
    - **Primary action, a deviation between findings 7 and 10.** On the success view the pass link is on screen, so "Copy link" stays the primary action and the two email fixes are secondary. On the visit page, where the link can no longer be shown, "Correct email and resend" is primary.
    - **Invitation card.** It is one line, e.g. "Sent to x on Mon, 5 Oct 2026 at 20:01." Attempts appear only when there was a failure or more than one attempt, and the provider error sits under "Technical details". For a visitor without an address, the card says so and offers "Add an email address". The card's line is a live region that stays mounted while its text changes, and it stays silent while the resent-pass panel announces the same invitation.
    - **Cancelled and no-show visits.** A banner under the header says who cancelled, when and why, or when the visit was marked a no-show. On every finished visit the pass card comes before the invitation card, and the "shown only once" note appears only for an ACTIVE pass.
    *Rejected:* showing "Visitor notified by email" for a cancellation. `Visit` carries no such fact (the backend audits `visitor_notified` but does not expose it), and inferring it would repeat the over-promising of finding 5.
40. **No email is promised that the server will not send (finding 5).** — The pure helpers in `visitEdit.ts` and `visitorFields.ts` derive the wording:
    - `visitorHasEmail(visit)` is `permissions.can_resend`. The server grants it exactly to callers who manage a SCHEDULED visit whose visitor has an address (B24-30), and only such callers can open these dialogs.
    - `rescheduleEmailsVisitor` additionally requires an invitation status other than NOT_SENT: a requested invitation always leaves one (B24-25).
    - The edit dialog's note and the reschedule confirmation say when no email goes out, and why.
    - The cancel dialog drops the notify checkbox for a visitor without an address and says they are not notified. Its reason hint reads "Saved with the visit; included in the email if the visitor is notified." The confirmation says what really happened. *(Corrected in 53: also for a visitor who was never invited, B24-70.)*
    - The visitor-saved confirmation no longer claims invitations are being sent: "Any scheduled visits of <name> get a new invitation and QR code at <address>."
41. **The visitor's email link cannot add mail headers (finding 2).** — The link is built with `mailtoHref`: the local part and the domain are percent-encoded and the `@` between them stays literal. `a?cc=evil@example.com` now yields `mailto:a%3Fcc%3Devil@example.com`, which has no query. The helper and the profile page each have a test. *Not done here:* rejecting `?`, `&` and `=` in visitor addresses server-side. RFC 5322 allows them, so that is a backend rule for its owner to decide on.

### UI kit

42. **Tabs and URL state (findings 6, 14).** — `useSearchParamState` was deleted. `Tabs.tsx` now documents `useUrlParams` + `readEnumParam`, and `Tabs.test.tsx` uses them. Below `sm` the tab list scrolls sideways:
    - The selected tab is scrolled into view by setting the list's `scrollLeft`. `scrollIntoView` could also scroll the page.
    - The reveal runs again on resize (`ResizeObserver` on the list and the tabs). The browser check found this was needed: the badges arrive with the counts after mount and only then make the list overflow.
    - CSS edge shadows (`@utility scroll-shadow-x`) show that more tabs lie beyond.
    Tabs are 44 px tall. A badge can take the warning tone (`badgeTone`). A space before the badge makes the accessible name "Today 2" rather than "Today2".
43. **Tables (findings 9, 16, 30).**
    - `Table` gained `stackBelow` (`md` | `lg`). The class sets for each breakpoint are spelled out in `tableStyles.ts`, because Tailwind only generates classes it finds in the source.
    - Each column chooses how it appears in the stacked card: `stacked: 'row' | 'inline' | 'hidden'`.
    - `tableRowLinkProps` turns the row's main link into a stretched link, so the whole card is one tap target. Other links in the card sit above it.
    - Header cells do not wrap.
    - **Visit lists stack below `lg`.** A card shows name and company, then the time with the visit and invitation badges on one line, then the host. The department is left out of the card. It was about 240 px per visit and is now about 174 px. The Host column is left out while every listed visit is the user's own.
    - **The visitor history stacks below `lg` and is not nested in a card.** Check-in, check-out and duration are one Attendance cell (`formatAttendance`, e.g. "In 09:02 · Out 10:15 · 1h 13m"), and the status sits next to the date.
    - `Pagination` shows only "Showing 1–5 of 5" when everything fits on one page.
    - Every empty value is "—" (no more "None" or "Never"). *(Changed in 58: stacked cards leave empty lines out, and values sit left-aligned beside their labels.)*
    *Rejected:* `table-fixed` with stable column widths. At the `lg` breakpoint the content area is 704 px (1024 minus sidebar and padding). Fixed widths for six columns there would truncate the status badges, while the auto layout keeps them whole. With headers that do not wrap, columns now move only as much as their content differs.
44. **Email addresses break at their separators (finding 20).** — `EmailText` inserts `<wbr>` after the `@` and before each dot of the domain, with `overflow-wrap: anywhere` as the last resort; `break-all` is gone. In table cells an address is cut with an ellipsis and its full text is the title. Sentences that name an address are built as `TextPart[]` (`utils/text`) and rendered with `TextWithEmails`, so pure helpers still return testable text.
45. **Forms and controls (findings 11, 13, 23, 27, 28, 31).**
    - **Field.** A hint now sits under its control, above the error, so controls side by side in a grid line up.
    - **Combobox, `select` variant.** A click opens the popup. Opening while the field still shows the selected option browses the full list: the query is `''`, and the selected option becomes active once the list shows. Filtering starts with the first typed character, and `renderOption` receives that filter. Decision 38 still holds: only visible options are reachable.
    - **Combobox, `search` variant.** It has a magnifier and no toggle, and it opens when the user types. It does not open on focus, because tabbing through the form would then open popups and fire a search on every pass. Keyboard users open it with ArrowDown.
    - **Scroll padding.** `html { scroll-padding-top }` is 6.5 rem below `lg` (the 4 rem sticky bar plus the field's label) and 1.5 rem from `lg` on, where there is no top bar (see 47). The suggested 5 rem still hid most of the label.
    - **Date inputs.** They keep the focus ring with `:focus`, because focus on Chromium's calendar button does not match `:focus-visible`. *(Corrected in 54: that stop does not match `:focus` either; the rule uses `:focus-within`.)*
    - **Touch targets (`pointer-coarse:`).** Buttons of size `sm` and `md`, text controls and tabs are 44 px tall. The checkbox is 24 px and its label is padded to 44 px. The back link, the "Technical details" summary and the visit-time links grow as well. Recovery actions are never `size="sm"`.
    - **Search fields.** Every one has a visible label, a hint below and no placeholder. The scope notes on Visitors and on the profile are plain muted lines instead of info alerts, and each is stated once.
46. **Destructive actions and dialogs (findings 17, 33).**
    - A new button variant, `danger-outline` (red-700 border, 6.4:1), is used for "Cancel visit" on the page. The solid red style stays for the confirmation inside the dialog.
    - Below `sm`, `PageHeader` stacks its actions full width in the given order. *(Since 56 a page can pass `mobileActions` instead; the visit page and My visits do.)*
    - `Dialog` footers keep reading order when they stack on phones: the safe choice first, the primary action last. The previous `flex-col-reverse` put "Cancel visit" above "Keep visit". This changes every dialog.
    - **Copy.**
      - The QR dialog talks to the host and shows the visitor's name and the date and time; the visitor-addressed instruction is gone from it.
      - The edit dialog's description is "<name> · <date and time>".
      - The resend dialog says "<name> will receive a new invitation…".
      - "Created by" reads "<name> on <date> at <time>" (`formatDateAtTime`).
47. **Shell (finding 34).** — On `lg+` the top bar is gone. The account menu sits at the foot of the sidebar (`Menu` gained `placement="top"`, `UserMenu` gained `placement="sidebar"`). `useMediaQuery('(min-width: 64rem)')` renders exactly one account menu. The sign-in page has an authorised-use notice in a footer (`AUTHORISED_USE_NOTICE`: "This system is for authorised users only. Sign-ins and actions are recorded and may be reviewed."). The audit log makes "recorded" true.
    *Rejected:*
    - A tenant name or logo on the sign-in page. Sign-in is by a globally unique email (D-03), so the tenant is unknown before sign-in; a single-tenant deployment setting would be new configuration with no contract behind it.
    - A support contact. No setting for one exists.
    - A version line. 0.1.0 tells nobody anything, and showing it would need a build-time define.
    - Changing the uppercase table headers. That is the kit's design, not a defect.
48. **Error references (finding 29).** — `getErrorReference` returns the `request_id` only for server failures (5xx) and for answers that were never an API response. A 4xx already says what to change, and a network error never reached the server. `ApiErrorMessage` shows "Reference: <id>" in monospace under the message. It is used on the load-error alerts of My visits, Visitors, the visit, the visitor, the history, the resend dialog and the invite preselection. The 404 pages give guidance ("Check the link, or find the visit in My visits.") instead of repeating "not found" three times.
49. **The time zone is named for people, once per screen (finding 32).** — `formatTimeZoneName` gives "Amman time (UTC+3)" from the IANA name and `formatShortUtcOffset`; zones without a place, such as UTC and `Etc/…`, show the offset alone. It appears once per screen:
    - My visits: in the page description.
    - Visit page: in the "When" item ("Times on this page are …"). The pass card no longer repeats the zone.
    - Invite form and edit dialog: in the schedule group hint.
    - Success view: under "When".
    - Printed pass and `DateField`: in their own line.
    `formatTimeZoneLabel` ("Asia/Amman (UTC+03:00)") was removed.
50. **Visitor statistics have names that cannot contradict each other (finding 19).** — The labels come from `VISITOR_STAT_LABELS` and are the same on the list and the profile: "All visits" (every status in scope) and "Last check-in" (B24-12). On the profile, an employee's scope is stated in the history's description line ("…shown here and counted above"). *Not done:* "N visits · M attended". `Visitor.stats` carries no attended count.

### Tests and verification

51. **Tests.** — The suite has 581 tests (was 523). New unit tests cover `mailtoHref` / `emailBreakParts`, `findMatch`, `formatTimeZoneName` / `formatShortUtcOffset` / `formatDateAtTime`, `getErrorReference`, `scheduleReadBack`, `formatAttendance`, `inviteDepartmentChoice`, the email-promise helpers, `visitorSavedMessage`, the tab status choices, Combobox browsing and the search variant, Tabs scrolling and badges, the Table stacking options, and single-page Pagination. New page tests cover:
    - the Today filter and the cancelled choice
    - merged errors with the reference
    - the Host column rule
    - an inactive host department and the omitted default
    - opening the host list on click
    - Invite again and its fallback
    - the failure banner
    - correcting the address from the visit page, the success view and the resend dialog
    - resending from the success view, and no correction there after an inline reuse
    - a visitor without an address
    - the no-show banner and card order
    - the honest reschedule and cancel wording
    - the encoded mailto link
    - the authorised-use notice
    - the desktop account menu
    `npm run typecheck`, `lint`, `test` and `build` pass.
52. **Real-browser check.** — I ran the dev server on port 5191 with the API mocked by Playwright route interception, in the system Chrome (`channel: 'chrome'`). The Phase 2–4 screens and the failed-invitation success view were rendered at 390×844, 820×1180 and 1440×900:
    - No horizontal page overflow and no console errors.
    - The selected tab is visible at 390.
    - Stacked visit cards are about 174 px.
    - With a real clock and the browser in Los Angeles, times show in Amman time.
    The script, its screenshots and the server were temporary: they lived in the session's scratch directory, outside the repository, and the server was stopped.

## Gate review round 2 (2026-10-05)

Fixes for the nine frontend findings of the second Phase 2–4 gate. Each was checked against the code first; all nine were real. Where the fix differs from the suggestion, the entry says so.

53. **The cancel dialog promises an email only when the server sends one (finding 1; corrects 40).** — Since B24-70 the server emails a cancellation only when an invitation was requested for the visit, and ignores `notify_visitor` otherwise. The dialog still decided with `visitorHasEmail` (= `can_resend`) alone. A visit created with "share the pass myself" for a visitor who has an address therefore showed the ticked "Notify the visitor by email" box and the hint "included in the email", and the toast then said "The visitor is being notified by email." No email went out.
    - `visitEdit.ts` now has `cancelEmailsVisitor(visit)`: the visitor has an address and the invitation status is not NOT_SENT. This is the same rule as `rescheduleEmailsVisitor`, and both call one private predicate, so they cannot drift apart.
    - `cancelNoEmailNotice`, `cancelReasonHint` and `cancelledMessage` derive the dialog's explanation, the reason hint and the toast from it. A visitor with an address who was never invited gets: "No invitation was sent for this visit, so the visitor is not emailed. Let them know yourself." The toast says "…so the visitor was not notified."
    - Tests: unit cases with a NOT_SENT visit (and FAILED and PENDING, which do notify), and a page test with a NOT_SENT visit whose visitor has an address. That test checks the checkbox is absent, checks the wording, and checks `notify_visitor: false` is sent. It fails with the old predicate.
54. **The date input keeps its focus ring at every inner stop (finding 2; amends 45).** — In Chromium, Tab reaches the calendar-picker button inside a date input. At that stop the input matches neither `:focus-visible` nor `:focus`, only `:focus-within`, so 45's `:focus` rule left no visible indicator (WCAG 2.4.7). The rule in `index.css` is now `input:is([type='date'],[type='datetime-local'],[type='time']):focus-within`.
    - Verified in Chrome: tabbing through the start date gives four stops (month, day, year, picker). At the picker `:focus` is false and `:focus-within` is true, and the outline is `solid 2px`.
    - *(gate: Phase 9)* Add a Playwright assertion that tabs to the picker stop of a date input and expects an outline other than `none`. jsdom computes no layout and does not apply the Tailwind stylesheet, so a unit test cannot check this.
55. **Date and time are a date input plus a 24-hour time list (finding 3; supersedes the "not done" part of 35 and the `datetime-local` part of Phase 1 decision 4).** — The native `datetime-local` input showed the browser's format, e.g. "10/05/2026 09:30 PM" in en-US. It sat 20 px above the app's own 24-hour read-back and cost seven keyboard stops per field.
    - `DateTimeField` is now a labelled group: a native `type="date"` input and a `Select` of company-local times "HH:mm" every `stepMinutes` (default 15). Its API is unchanged (UTC instant in and out, company time zone, hint, error, `showTimeZone`, `describedBy`), so `ScheduleFields` and later screens (Phase 5 walk-in "expected end") need no change. The unused `min`, `max` and `name` props were removed.
    - Accessible names come from `aria-labelledby` (the visible label plus a hidden "date"/"time"). Chrome's accessibility tree shows `Date "Starts date"` and `combobox "Starts time"`, and the group is `group "Starts"`. Both controls carry the hint, error, `aria-invalid` and `aria-required`. The field's `id` is the date input's, so a failed submit focuses it.
    - Pure helpers in `utils/datetime.ts`, unit-tested:
      - `wallTimeSlots(date, zone, { stepMinutes, include })` lists the day's times. It leaves out times that a spring-forward gap removes; New York on 8 Mar 2026 has 92 slots. Gaps are checked per slot only when the zone's offset can change over that local day, which is detected over a window that also catches a transition at midnight. `include` adds the current value when it is off the grid, e.g. a visit created at 09:07.
      - `toWallParts` splits an instant into the date and the time.
      - `isTimeOfDay` validates "HH:mm".
    - While the date is cleared or incomplete the value is null, and the chosen time is kept until the date is complete. If a new date puts the kept time into a DST gap, the time moves forward and the existing warning explains it. An ambiguous fall-back time is offered once and resolves to its first occurrence (Phase 1 decision 29).
    - The read-back line stays, because the native date part still shows the browser's date format.
    - Measured in Chrome: each field now has 5 stops (4 in the date input, 1 in the list), down from 7. The finding expected 2; Chromium's date input alone has month, day, year and picker stops.
    - Test note: the two lists add 192 `option` elements to the invite form, and an unscoped `findByRole('option')` names every one of them on each retry. Under full-suite load that pushed four invite tests past the 1 s `findBy` timeout. Those tests now look for typeahead options inside the open listbox (`popupOption`). No other test needed changing for this.
56. **On phones the visit page's actions are one menu beside the title (finding 4).** — Below `sm`, three full-width buttons stood above the content. On a failed invitation the destructive "Cancel visit" came before the banner that explains the problem and holds the real recovery action.
    - `PageHeader` has a new `mobileActions` slot. It shows below `sm` in the title row, and `actions` are then hidden there. The h1 and the slot share a row; the description keeps the full width.
    - `VisitDetail` builds its actions once (`headerActions`, from `permissions` only). On `sm` and up they render as buttons, as before. On phones they are the items of an "Actions" `Menu` (Cancel visit in the danger tone). The failure banner is then the first thing after the header, and its two buttons are the only prominent ones.
    - *Deviation from the suggestion:* there is no single full-width primary button in the header on phones. This page has no primary action of its own (edit, resend and cancel are all secondary), and the failure banner already carries the one primary recovery action. Phones also always get the menu, even for one action: the destructive action is then never a prominent button, and the DOM never holds the same button twice (the menu items exist only while it is open).
    - Verified in Chrome at 390 px: the only visible header control is "Actions", and the banner starts at y = 227.
57. **A failed invitation on the success view is one alert (finding 5).** — The card said the same thing four times, in three tones: a red status line, a red alert, a "Share the pass now" heading and an amber "Share this pass" alert, under an amber triangle icon.
    - The heading keeps the success check: the visit exists and its pass works, whatever the email does.
    - A single danger alert follows, titled "Invitation not delivered to <address>" (`invitationFailedTitle`). Its one-line body comes from `failedInvitationNextStep` and names only the ways out the view offers, e.g. "Share the pass below, or correct the address and resend." or "…or resend the invitation." after an inline reuse. The two recovery buttons stay secondary, and Copy link stays the primary action.
    - The status line stays mounted as the polite live region that announces sending → failed, but is `sr-only` while the alert shows the failure. Removing it would have lost that announcement, and showing both would repeat it.
    - `PassActions` always has the neutral h3 "Visitor pass" and no alert. Under the link field is one muted note (`passLinkNote`): "Shown only once. Copy, show or print it now. Anyone with this link can use the pass." While the email carries the QR code, the middle sentence is "The visitor also gets the QR code by email." The old info alert's resend advice is left to the resend dialog, which states it.
    - For one wording of one fact, the visit page's failure banner uses the same title. The old success-view constant `FAILED_INVITATION_ADVICE_WITH_PASS` was removed.
58. **Stacked table cards keep label and value together (finding 6; changes 43).**
    - In the stacked layout each labelled value is a two-column line, `grid-cols-[minmax(6rem,8rem)_minmax(0,1fr)]`. The value is left-aligned and wrapped in one grid item. `align: 'end'` now applies to the table layout only. `justify-between` and `text-right` are gone, as are the per-column `max-md:items-end` and `max-lg:text-right` in VisitorSearch and the history.
    - A new column option `isEmpty(row)` leaves the line out of the card. The table layout still shows its "—". Uses: Contact, Today and Last check-in in the visitor search; Department and Attendance in the history.
    - Tables that stack below `lg` (visit lists, visitor history) show their cards in two columns between `md` and `lg`. The media ranges are disjoint, so no two display utilities compete.
    - Primary and action cells have their own class sets. Columns with `stacked: 'hidden'` no longer render a label that could never be shown.
    - Re-checked together in Chrome:
      - Visitor search at 390: a visitor with no contact, no visits today and no check-in is a 90 px card. Before, every card carried three "—" lines.
      - Visitor history at 820: two columns of cards; labels at x = 41, values at x = 181.
      - My visits: unchanged, because its rows use inline cells.
      - No horizontal overflow anywhere.
59. **My visits on phones (finding 7).**
    - "Invite visitor" sits beside the title (`mobileActions`), not in a full-width row of its own.
    - The summary is one line: "Last" is dropped below `sm`, giving "30 days: 12 completed · 2 cancelled".
    - The tabs use the new `Tabs` option `phoneLayout="grid"`: two per row below `sm`, as outlined segments. The selected tab has a 2 px accent border, so it is not marked by color alone. Focus rings are not clipped. "Needs attention" is never cut off.
    - Search and the Show choice share one row. `SearchField` has a new `hintVisibility="sm"`, so on phones the hint is only the input's accessible description.
    - Measured at 390 × 844 with the counts loaded: the first card starts at y = 440 (finding: 560). All four tabs lie within the viewport.
    - *Deviation from the suggestion:* the short tab label ("Attention") was not used. Even with it, four tabs with two-digit counts need about 376 px against 358 available, so the list would still scroll. The grid shows everything at the cost of one 44 px row.
60. **The no-show banner is worded from the pass window, and finished visits offer "Invite again" (finding 8).** — `no_show_at` is when the server noticed: marking is lazy (§5). The banner said "Marked as a no-show on Mon … 21:14, when the pass expired", which contradicted the pass card ("valid until Sat … 11:00").
    - The banner now reads "The visitor did not check in before the pass expired on {window_end}." The marking time stays in the timeline ("Marked as no-show").
    - Cancelled and no-show banners offer "Invite again" (`paths.inviteVisitorAgain`, the profile's icon) to roles that may invite. The invite form already resolves the visitor through the scoped endpoint and falls back to an empty form with a warning (37), which also covers B24-72's out-of-scope links.
61. **How the visitor gets the pass is chosen right under Email, and only optional fields are marked (finding 9).**
    - The "Send invitation email" checkbox, alone in a card at the end of the form, is replaced by the radio group "How will the visitor get their pass?" with "Email the invitation" (default) and "I'll share the pass myself". It sits in the Visitor card, after Email, and also under a picked returning visitor.
    - The new visitor's fields are ordered Full name, Company, Phone, Email, so Email directly precedes the choice in the one-column phone layout too.
    - Email shows "(optional)" when the pass is shared and the hint "Needed to email the invitation." when it is emailed. The empty-email error now names the way out: "…to email the invitation, or choose "I'll share the pass myself"." So does the returning-visitor error. The labels and `passDelivery` live in `inviteForm.ts`.
    - **Kit-wide:** `Field` and `RadioGroup` no longer draw a red asterisk. `required` still sets `aria-required`. Optional fields carry "(optional)", which now follows a real space (`OptionalMarker`), so the accessible name is "Phone (optional)" rather than "Phone(optional)". Before this, only the Phase 2–4 forms drew asterisks; the auth forms never marked required fields. Every form now follows the long-form government convention. Phases 5–7 must mark their optional fields with `optional`.
62. **Tests and verification.**
    - The suite has 609 tests (was 581). New or changed tests cover:
      - the cancel-email rule
      - the `DateTimeField` group (names, descriptions, the 24-hour grid, an off-grid time, a cleared date, a DST gap)
      - `wallTimeSlots`, `toWallParts` and `isTimeOfDay`
      - the invitation text helpers (new `invitationText.test.ts`)
      - the stacked label/value lines, `isEmpty` and the two-column range
      - the `Tabs` grid layout
      - the phone actions menu
      - the no-show wording and "Invite again"
      - the success view's single alert
      - the delivery choice and the marking convention
      - the My visits phone layout classes
    - `npm run typecheck`, `lint`, `test` and `build` pass. The built CSS contains the new arbitrary and range classes.
    - Real-browser check: the dev server ran on port 5193 with the API mocked by Playwright route interception, in the system Chrome (`channel: 'chrome'`, locale en-US, browser in Los Angeles). Checked at 390 × 844, 820 × 1180 and 1440 × 900: My visits, the failed and no-show visit pages, the actions menu, the edit dialog, the invite form and its failed success view, the visitor search and the visitor profile. There was no horizontal overflow and no console error. The measurements are in 54–59.
    - The script and screenshots lived in the session's scratch directory, outside the repository. The server process was stopped and port 5193 is closed.

## Known limits

- The Phase 2–4 backend endpoints were being built at the same time; the screens were verified against mocks typed by `api.ts` (checked against the backend's contract snapshot), not against the running backend. End-to-end coverage is Phase 9.
- At 390 px the tab list scrolls horizontally inside itself (UI kit behaviour); the page itself never scrolls sideways. *(Since 42 the selected tab is scrolled into view and edge shadows show that the list scrolls. Since 59 My visits uses the two-column phone grid instead.)*
- The native date input shows its value in the browser's locale format (Phase 1 decision 4); the timezone hint names the company zone. *(Since 35 the chosen range is read back under the inputs in the app's own format. Since 55 only the date part is native; times are a 24-hour list.)*
