# Phases 5–7 — Employee screens and UI kit: carry-over decisions

Date: 2026-10-05 · Scope: `frontend/src/features/visits`, `frontend/src/features/visitors`, the visits and visitors pages in `frontend/src/pages`, `frontend/src/components/ui`, plus two additive contract mirrors in `src/types/api.ts` and `src/api/visits.ts` · Contract: `docs/initial-assessment.md` revision 2

This file closes the open Phase 2–4 verification items of the round-3 gate (3 failing gate checks, 18 findings) for the employee screens and the shared UI kit, and builds the UI side of two backend contract additions made at the same time (B57-03 `Visit.last_notice`, B57-04 `POST /visits/{id}/pass`). Each entry: **decision** — reason. Numbering: FE57-n. Items marked *(gate)* need a matching choice elsewhere.

## Emails the screens promise

1. **A reschedule never promises every email (gate contract 3.1, finding "reschedule toast").** — Since B24-70 the server saves a reschedule beyond the notice budgets (3 per visit and hour, `RESCHEDULE_NOTICE_DAILY_LIMIT` per user and day) and leaves the email out.
   - Before saving, the edit dialog says: "If you change the date or time, the visitor is emailed the new schedule, except after several changes in a short time." The exact budgets are server configuration, so the copy names the rule, not the numbers.
   - After saving, the confirmation is read from the PATCH response (`rescheduleEmailOutcome`, `rescheduledConfirmation` in `visitEdit.ts`). A notice the server queues is still PENDING in the response, because delivery runs after it. So a pending VISIT_RESCHEDULED `last_notice` that was not pending before means "being emailed". No pending reschedule notice means the budget left it out: a warning toast says "This change was not emailed: the limit for emails about changes was reached. Let the visitor know the new time yourself." When an earlier change's email was still pending, the two cannot be told apart, and the toast falls back to the caveat wording plus "the timeline shows the latest email".
   - *Deviation from the suggested fix:* the suggestion was wording only, or a `visitor_notified` field (a contract change). B57-03's `last_notice` already carries the fact, so the confirmation states it where it can and uses the caveat only for the ambiguous case. The finding's decision entry belongs in this file, not in `phase-2-4-frontend.md`, because that phase is closed.
   - *(gate: backend)* The rule depends on the PATCH and cancel responses being built after the notice is queued, and delivery running after the response (B24-25/B57-03). Both hold in `services/visits.py` today.
2. **A cancellation confirmation is read from the response too.** — `cancelledMessage(before, after, notify)` says "The visitor is being notified by email." only when the response's `last_notice` is the VISIT_CANCELLED email. A visit is cancelled once, so such a notice can only come from this request. Otherwise it says why not (no address, never invited, not asked to notify). If the visitor should have been notified but no email was queued, it says "The visitor was not emailed. Let them know yourself." It never claims an email the server did not queue.
3. **Whether the visitor was told about a change is visible afterwards (B57-03).** — `Visit.last_notice` is mirrored in `api.ts`, inline like `invitation`. `api.contract.test.ts` passes against the regenerated snapshot.
   - **Timeline:** "Cancellation email sent / could not be sent / Sending the cancellation email" and "Email about the new time sent / could not be sent / …", with the recipient. A failed one adds "Let them know yourself." `VisitNotice` records `sent_at` only. So a sent notice is dated by `sent_at`, and an unsent cancellation email by `cancelled_at` (queued in the same transaction). An unsent reschedule email has no time on the visit. It is shown without a time and placed before the first step after which a visit cannot be rescheduled (check-in, check-out, cancellation, no-show), or last. *(gate: backend, optional)* A `created_at` on `VisitNotice` would date every notice.
   - **Cancelled banner:** a second line, "The cancellation was emailed to x." / "…is being emailed to x." / "The cancellation email to x could not be sent. Let the visitor know yourself." (emphasised), or "The visitor was not emailed about the cancellation."
   - **Invitation card:** on CANCELLED and NO_SHOW visits the card is titled "Original invitation" and its badge is neutral (StatusBadge `tone`), so a green "Sent" does not read as current. Checked-out visits keep "Invitation": the visit took place.
   - **Polling:** `useVisitDetail` polls while the invitation or the latest notice is PENDING (`emailPollDelay`, same 2 s / 30 s window), and the window restarts after a reschedule or cancellation.

## A visitor who shares the pass themselves (B57-04)

4. **"Issue a new pass link" on the pass card.** — A visit created with "I'll share the pass myself" had a dead end once the success view was left: the visit page offered only "Add an email address".
   - `canIssuePassLink(visit)` = `can_edit` (the server's own rule for the endpoint: the caller manages the SCHEDULED visit) and no invitation email carries the pass. That is, the invitation is NOT_SENT, or the visitor has no address (also after D-19 removed it).
   - The action sits on the Visitor pass card, next to the note that explains why it exists ("If the visitor does not have it, issue a new link; the current QR code then stops working."). It is not in the page header, which keeps edit, resend and cancel.
   - `IssuePassDialog` is an alertdialog with the same rotation warning as the resend ("The previous QR code will stop working"), "Keep current pass" / "Issue new pass link", and the server's message on refusal (429 budget, 409).
   - The result is shown in the panel the resend uses (renamed `NewPassPanel`, generalised to `{ passUrl, emailed }`) with `PassActions`. There is no delivery line, "Copy link" is primary, and focus moves to "New visitor pass".
   - `issueVisitPass` (api) returns `VisitPassResult` (api.ts). `useIssuePass` uses `gcTime: 0` like the other one-time links (Phase 2–4 decision 14).
   - `PASS_REVOKE_REASON_LABELS.ROTATED` now reads "A newer invitation or pass link replaced this QR code."

## Visit page

5. **Visit-state rules are a pure, unit-tested module: `visitDetailModel.ts`.** — `visitHeaderActions` (ids, labels and tones; the component maps ids to icons and dialogs), `hasFailedInvitation`, `visitorHasNoEmailOnFile`, `wantsVisitorCorrection`, `canIssuePassLink`, `isFinishedVisit`, `invitationCardTitle` and `isOriginalInvitation`. `VisitDetail.tsx` is composition only. `visitDetailModel.test.ts` covers FAILED, NOT_SENT, no-address, permission-less and finished visits.
6. **One card order everywhere: Visit details, Invitation, Visitor pass, Timeline.**
   - In one column (below lg) the two status cards a host checks first come before the long timeline. On desktop, Invitation and Pass form the side column next to details and timeline.
   - Built with DOM order plus grid placement (`lg:grid-rows-[auto_1fr]`, side column `lg:row-span-2`), so the left column is not split by the side column's height.
   - Phase 2–4 decision 39's "pass card first on finished visits" is withdrawn: the order no longer changes with state.
   - Verified in Chrome at 1440, 820 and 390.
7. **The pass card dates its window** (gate UX 3.1). — "Valid Wed, 7 Oct 2026, 03:12–06:12, including the arrival margin." comes from `formatVisitDateRange` (FE57-13). Before, `formatTimeRange` dropped the date whenever the window fell within one day.
8. **The header's invitation badge uses the long form** ("Invitation not sent", FE57-11) through `StatusBadge standalone`. `labels.ts` no longer has its own `INVITATION_HEADER_LABELS`.

## Dialogs and forms

9. **The resend dialog keeps its buttons in the panel** (gate UX 3.1, high finding).
   - With three actions ("Keep current invitation", "Resend to same address", "Correct email and resend") it is `size="lg"`.
   - The kit `Dialog` footer gained `sm:flex-wrap`, so any dialog whose buttons do not fit one row wraps them instead of overflowing the panel. This changes every dialog, and none had overflowed until then.
   - Measured in Chrome: at 1440 and 820 the three buttons share one row inside the 672 px panel; at 390 they stack inside it.
   - The cancel label stays "Keep current invitation": with the wider panel it fits, and the longer label says what is kept.
   - A Dialog test pins the footer classes and reading order. *(gate: Phase 9)* Add a Playwright check that every footer button lies inside its dialog panel at 820 and 1440.
10. **The client mirrors "the end must not be in the past" (B24-24)** (finding `validateSchedule`).
    - `validateSchedule` adds `endInPast` after the end-after-start and 24-hour checks. It applies also when the start is not checked, as on the server.
    - The client's wording is "The end cannot be in the past.", matching its own "The start cannot be in the past." rather than the server's "The end time must not be in the past.": one form, one voice. The server's field message still shows when it answers.
    - **Also fixed:** `validateVisitEdit` now applies the schedule rules only when the schedule changed, as the server does (`schedule_problems` runs only when `rescheduled`). Before, a visit in its grace period after the end could not get a new purpose on the client. A cleared field counts as a change.
    - Tests: `schedule.test.ts`, `visitEdit.test.ts`, and a visit-page case (moving the end of a visit under way to 09:00 at 09:10 is refused without a request). *(gate: backend)* The finding also asks for a backend integration test (PATCH only `scheduled_end` into the past on an under-way visit gives 422 on `fields.scheduled_end`); that is the backend's suite.
11. **One invitation vocabulary (kit rule).** — "Invitation sent", "Invitation not sent", "Invitation failed" and "Sending invitation" are used wherever no "Invitation" heading names the subject: the visit header and the phone card of the visit list. The short words ("Sent", "Not sent", …) appear only under an "Invitation" column header or card title. The rule is documented on `INVITATION_STATUS_META`. `INVITATION_STATUS_LONG_LABELS` and `StatusBadge`'s `standalone` prop implement it. The visit list renders the short badge in the table layout and the long one in the stacked card (`max-lg:hidden` / `lg:hidden`, one shown at a time).
12. **A hint the error repeats is hidden while the error shows; copy uses typographic quotes.**
    - `Field` gained `hideHintOnError` (default off; character counts and format hints still help while correcting). The invite form's Email field uses it, so "Needed to email the invitation." no longer sits above an error that says the same.
    - The visits and visitors copy constants and JSX texts now use “…” and ’: the delivery choice "I’ll share the pass myself", the email-required errors, "visitor’s", the cancel dialog and the revoke reasons.
    - `inviteForm.test.ts` checks the two error constants contain no straight quote.
13. **The invite form's footer reads and tabs in one order** (finding, WCAG 2.4.3). — The DOM order is Cancel, then the submit button, with `flex flex-col gap-2 sm:flex-row sm:justify-end`, and there is no `row-reverse` anywhere in the code base.
    - *Deviation from the suggestion* (`flex-col-reverse` to keep Submit on top on phones): that would reverse visual and focus order on phones instead. The kit's dialog rule (Phase 2–4 decision 46) already puts the safe choice first and the primary action last in both layouts; the form now follows it.
    - Verified in Chrome: at 1440, Cancel x=844 and Send x=928, and Tab goes from Cancel to Send.

## Invite success view

14. **The page title is the outcome; the card names the visitor** (finding "header/visitor line").
    - The page header moved from `InviteVisitorPage` into the feature (`InviteVisitor` for the form, `InviteSuccess` for the outcome), the pattern of the detail pages (Phase 2–4 decision 4). The form keeps "Invite visitor" with "Schedule a visit and email the visitor their QR pass, or share the pass yourself."
    - The success view's title is "Visit scheduled", with no description, or "Visit cancelled" after a cancellation from the view. The h1 takes focus.
    - The card's heading is the visitor's name with the company on a muted second line, as in `VisitCards`. The Visitor row of the description list is gone; it repeated the heading.
15. **A reused visitor with another name is a warning, first** (finding "inline reuse replaced the typed name").
    - `InviteVisitorForm.onCreated` now passes the request, so the view knows the name and address typed.
    - `reusedVisitorMismatch` (invitationText.ts) compares names folded as the server folds them (`foldPersonName` in `visitorFields.ts`: NFKD, case, marks, the Arabic letter variants of B24-10, spacing). On a mismatch, a warning alert titled "Check who this visit is for" comes before the delivery status. Its text: You entered “Karim Fail”, but visitor@fail.test already belongs to an existing visitor, so this visit was created for “Sami Nasser”. If that is the wrong person, cancel this visit and invite “Karim Fail” with their own email address. It replaces the neutral reuse note.
    - The stored name is the visit's own snapshot, which the heading already shows, so nothing more is revealed (§7.5). An out-of-scope reuse keeps the typed name in the snapshot (B24-15), so it never warns.
    - "Cancel this visit" (with `can_cancel`) opens the regular cancel dialog. Afterwards the view withdraws the pass link (the pass was revoked), shows "The visit was cancelled … To invite “Karim Fail”, use their own email address." with "Invite another visitor" as the primary action, and moves focus to the "Visit cancelled" heading.
    - `CancelVisitDialog` gained `onCancelled` and `EditVisitDialog` `onSaved` for this. Both are optional, so the APIs are unchanged.

## Lists and dates

16. **Stable My visits columns from xl on** (finding `VisitTable`).
    - The kit `Table` gained `layout="fixed-xl"` (`xl:table-fixed`); the existing `fixed` is unchanged. The visit table fixes its columns there: Status and Invitation 9 rem (their longest badge), Date and time 22 % (20 % with Host), Department 16 % (14 % with Host), Host 14 %, Visitor the rest. The Department name truncates on one line from xl with its full name as `title`, and wraps below.
    - *Deviation:* the suggested percentages from lg (e.g. Status 14 %) would truncate badges at 1024 px, where the content area is 704 px (the reason Phase 2–4 decision 43 rejected `table-fixed`). Between lg and xl the content-sized layout stays.
    - Measured at 1440: the same widths on Today and Past (Visitor 405, Date and time 246, Status 144, Invitation 144, Department 179 px), and "Executive Office" on one 20 px line.
17. **Visits across midnight read like the others** (findings `format.ts`, `VisitorHistoryTable`, visitor search).
    - `formatVisitDateRange` gives "Mon, 5 Oct 2026, 22:42 – Tue, 6 Oct, 00:42": the end day in short form, the year only when it changes. It is used on the visit page, the pass card, the dialogs, the success view, the QR dialog, the printed pass, the schedule read-back and the visitor history.
    - `formatVisitWhen` (lists) gives "Today, 22:42 – Tomorrow, 00:42" or "Fri, 9 Oct 2026, 22:00 – Sat, 10 Oct, 01:00".
    - *Kept:* the spaced en dash for these ranges. Both sides contain spaces, so a closed dash would bind "22:42–Tomorrow"; one-day ranges keep the closed dash.
    - The visitor search's Today column shows only the time ("09:00–10:00", "from 22:42", "until 01:00"). A visitor still inside from an earlier day is dated relative to today.
    - The history's date link is `lg:whitespace-nowrap`, so it wraps in the phone card. Measured at 390: the link's right edge is 338 px, inside the card content edge (358 px).
    - `src/utils/datetime.ts` is unchanged; the helpers live in `features/visits/format.ts`.
18. **Visitors page** (finding "VisitorSearch").
    - The employee's scope is stated once, in the page description (`visitorSearchDescription`): "Search the visitors you added or invited, and see who is expected today. Only visits you host or have created are shown." The separate note between the header and the search is gone.
    - The no-results state offers "Invite a new visitor" next to "Clear search" to roles that may invite.
19. **My visits copy** (finding). — The description reads "Visits you host or have created." (the visitor profile's scope note now uses the same tense). The search empty state is worded per tab ("No past visits match “orbit”", from `searchEmptyTitle`) with "Try another name, company or email address." The kit `Table` loading label ends with "…" ("Loading today’s visits…").
20. **The typeahead's match is bold, not underlined** (finding `HighlightMatch`). — An underline in an option list reads as a link. Verified in Chrome: font-weight 600, text-decoration none.

## Tests and verification

21. **The previously flaky Invite tests are load-tolerant** (finding).
    - `fillNewVisitor` fills plain text fields with one change event each instead of a render per keystroke.
    - The page test files of this scope (Invite, Visit detail, My visits, Visitors, Visitor profile) and `Combobox.test.tsx` set `configure({ asyncUtilTimeout: 5000 })` and `vi.setConfig({ testTimeout: 20_000 })`. The 1 s wait and 5 s test budget are about test-runner speed, not product speed, and failed under a loaded CPU.
    - **Confirmed under load.** Two concurrent full runs of `src/features/visits src/features/visitors src/pages src/components` stand in for "the full suite next to pytest". In two such rounds (four runs), every test of this scope passed, and the Invite file passed 27/27 in every run, including two runs of it alone next to two full runs.
    - Three concurrent full runs are much harsher. Without these settings, the first route test of the Visit detail and Visitor profile files failed there. With them, the only failure in this scope was once the first test of `Dialog.test.tsx`: cold module transforms on a starved CPU passed 5 s.
    - *(gate: shared test setup)* A global `testTimeout` (Vitest config) and `asyncUtilTimeout` (`src/test/setup.ts`) would make every file load-tolerant. Those files are shared, so they were not changed here. Outside this scope under the same load, `PassPage.test.tsx` (lazy chunk) times out, and `LoginPage.test.tsx` / `ChangePasswordPage.test.tsx` fail deterministically: the reception and reports landing pages built concurrently now load `/reception/today`, `/company/settings` and `/reports/summary`, which those tests do not mock. *(Amended in [phase-5-7-frontend.md](phase-5-7-frontend.md) FX-3.)*
22. **New and changed tests:**
    - Unit tests: `visitDetailModel.test.ts` (new), `Field.test.tsx` (new: hint hiding and HighlightMatch), the outcome-based confirmations in `visitEdit.test.ts`, `schedule.test.ts` (rules and the cross-midnight read-back), `format.test.ts` (all range forms), the notice events in `visitTimeline.test.ts`, the mismatch, notice and title texts in `invitationText.test.ts`, the name folding and description in `visitorFields.test.ts`, and the long labels and tone override in `StatusBadge.test.tsx`.
    - Kit tests: the Dialog footer and the Table `fixed-xl` layout.
    - Page tests: the card order, the dated pass window, the left-out reschedule email, the end-in-past refusal, the notified cancellation and its banner line, the failed cancellation email with the "Original invitation" card, issuing a pass link and its refusal, the name-mismatch warning and cancel flow, the footer order, the email hint, the stable-column and long-badge classes, the per-tab search title, the scope description, the "from 22:42" link, the invite action without matches, and the cross-midnight history link.
    - `test/fixtures.ts` `makeVisit` sets `last_notice: null` (additive, so other builders' fixtures keep compiling).
23. **Real-browser check.** — The dev server ran on port 5184 with the API mocked by Playwright route interception, in the system Chrome (`channel: 'chrome'`, browser in Los Angeles, company in Amman). Checked at 1440×900, 820×1180 and 390×844: the measurements in 9, 13, 16, 17 and 20, plus:
    - The card order (6), the visit-page flows (4) and the success-view warning (15).
    - No horizontal overflow on any checked screen, and no console errors.
    - Playwright's fake clock (`clock.setFixedTime`) makes `@date-fns/tz` report hours in the browser's zone, so the check used fixture times relative to the real clock instead. This is a property of the fake `Date`, not of the app: with the real clock the same page shows Amman time. Phase 9 E2E should not use `clock.setFixedTime` for screens that show times.
    - The script and screenshots lived in the session's scratch directory, outside the repository. The server was stopped.

## Contract mirror

24. **`api.ts` gained `Visit.last_notice` (inline object) and `VisitPassResult`; `api/visits.ts` gained `issueVisitPass`.** — These are additions only, matching the backend's regenerated snapshot (B57-03, B57-04); `api.contract.test.ts` passes. `VisitNotice` is not exported as a named type: the contract test requires every exported type to be compared with a backend model, and the snapshot publishes it only inside `Visit` (`$defs`).
