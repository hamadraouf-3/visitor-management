# Phase 11 — frontend decisions (the platform owner's area; a company's e-mail texts)

Date: 2026-10-13. Scope: `frontend/src/**` (types, API client, auth, i18n catalogs, layouts, the new
`features/platform/**`, the e-mail texts in `features/admin/**`, the audit log), `frontend/e2e/**`,
`frontend/config/chunking.test.ts`, `frontend/README.md`, `README.md`, `docs/development.md` and this file. No
backend file was changed. Contract: `docs/initial-assessment.md` revision 4 §7.6, `docs/api.md` §2.1, §10.10
and §10.11, and the backend's hand-over (`phase-11-backend.md`). The rules of Phase 10 hold: direction C with
the existing kit, Arabic (right to left, the default) and English from the catalogs with type-safe keys,
logical CSS properties only, and no explanatory notes (labels, errors and validation, data, and one short
line before an irreversible action).

Each entry records what was built and every interpretation of, or deviation from, the hand-over.

---

## Contract and catalogs

**F11-1 — `api.ts` follows the regenerated snapshot.** New response types `PlatformMe`, `PlatformCompany`,
`PlatformCompanyAdmin`, `PlatformCompanyCreated`, `AdminPasswordResetSent`, `PlatformAuditLog`,
`EmailTemplate`, `EmailPreview`, `EmailTestSent`; requests `PlatformCompanyCreate`, `PlatformCompanyUpdate`,
`CompanyAdminCreate`, `EmailTemplateUpdate`, `EmailTemplateReset`, `EmailTemplatePreviewRequest`; queries
`PlatformCompanyListParams`, `PlatformAuditLogListParams`, `EmailPreviewDocumentParams`; envelopes
`PlatformCompanyPage`, `PlatformAuditLogPage`; error codes `COMPANY_INACTIVE`, `ACCOUNT_INACTIVE`; field
codes `unknown_placeholder`, `placeholder_required`, `invalid_placeholder`, `markup_not_allowed`. The two enum
aliases `EmailTemplateKind` and `EmailTemplateFieldName` are exported and checked through the models that use
them (`CHECKED_INDIRECTLY` in `api.contract.test.ts`, as `Role` is); the shapes the backend does not name as
models of their own (a template's field, one language's texts) are not exported, since every exported name
must be a backend model: code reads them as `EmailTemplate['fields'][number]` and
`EmailTemplatePreviewRequest['ar']`. `api.contract.test.ts` lists the two new envelopes and three new queries.

**F11-2 — Texts for the new codes, in both catalogs.** `errors:codes.COMPANY_INACTIVE` / `ACCOUNT_INACTIVE`
(the server's words in English) and the four field codes. Two wordings differ from the server's English on
purpose, because the editor shows the catalog's text for its own checks in both languages (F11-15):
`unknown_placeholder` is "“{{name}}” is not a variable of this e-mail." (the parameter `allowed` is not
repeated: the variables are the chips under the field), and `placeholder_required` is "Include “{{name}}” in
this text.", where the editor passes the variable's label ("Company", «الشركة») instead of its raw name. A
422 from the server still shows the server's own message in English (F10-6) and these texts in Arabic.

## The API client and the two sessions

**F11-3 — Each realm's own CSRF cookie.** `api/client.ts`: `PLATFORM_CSRF_COOKIE_NAMES`
(`__Host-vms_platform_csrf`, `vms_platform_csrf`), `isPlatformPath(path)` and `csrfCookieNamesFor(path)`;
`apiRequest` sends the platform token for an unsafe request under `/platform` and the company's for every
other one, and no token when that realm has no cookie (the company's token never vouches for a platform
request, nor the reverse). `ApiError.retryAfter` (seconds, from a 429's `Retry-After`; `parseRetryAfter`) and
`apiUrl(path, query)` (the address of an API document for a frame) are new. API functions:
`api/platform.ts`, `api/emailTemplates.ts`.

**F11-4 — The two principals never mix.** A browser may hold a company session and a platform session, and a
tab keeps both in one query cache, so each side's handling is scoped:
   - every platform query key and mutation key starts with `queryKeys.platform` (`['platform', …]`).
     `auth/session.ts` (`startSession`, `endSession`, `forgetSession`, the new `dropPreviousSessionData`)
     removes only the company's entries; `features/platform/platformSession.ts` only the platform's. Before,
     the company's sign-in and sign-out cleared the whole cache;
   - `AuthProvider` ignores API errors of `/platform/…` requests (a platform 401 or 403
     `PASSWORD_CHANGE_REQUIRED` never ends or redirects the company session) and never navigates a platform
     page (another tab's company sign-out, another user's answer). `PlatformAuthProvider` (mounted around
     every `/platform` page) does the same for the platform: 401 → the platform's cache is cleared and the
     page goes to `/platform/login?next=…`; 403 → `/platform/change-password`; another platform account →
     its data and toasts go; a restore from the back/forward cache forgets the platform session until the
     server answers (SEC-51);
   - messages between tabs have a channel per realm (`createAuthSync`; `platformAuthSync` on
     `vms-platform-auth`), so a platform sign-out in one tab ends the platform session of the others and
     nothing else;
   - `safeNextPath` refuses platform pages (never a company sign-in's destination); `safePlatformNextPath`
     accepts only platform pages, with the same checks (`normalisedNextPath`);
   - `isRefusal` leaves the platform session check alone, as it leaves `/auth/me`;
   - the platform session has its own check (`usePlatformAuth`, 401 → nobody) and heartbeat (every 60 s as a
     background refresh, SEC-50; the platform's idle timeout is 30 minutes).

## The platform owner's area

**F11-5 — Routes of its own, outside the company app.** `features/platform/routes.tsx` contributes public
routes: `/platform` → `PlatformRoot` (the platform session's reactions and language) → `/platform/login`,
and behind `RequirePlatformAuth` and `PlatformLayout`: `/platform/companies`, `/platform/companies/new`,
`/platform/companies/:companyId`, `/platform/audit`, `/platform/change-password`, and a not-found page inside
the shell. Every module is lazy (also the root, the guard and the layout): a company user's browser never
downloads the area (`config/chunking.test.ts` lists them). A company user who opens `/platform/…` sees the
platform sign-in (the guard asks only the platform session); the platform owner who opens a company page sees
the company sign-in. *Deviation from the suggested pages:* the companies are at `/platform/companies` and
`/platform` redirects there, so the "Companies" navigation item stays current on a company's page and on the
new-company page (a `/platform` item would either match every platform page or none below it).

**F11-6 — A shell that is the product's but not a company's.** `layouts/ShellFrame.tsx` is the frame
extracted from `AppLayout` (sidebar from `lg`, top bar and drawer below, skip link, focus on the new page's
heading), shared by `AppLayout` (unchanged DOM and behaviour; its tests pass as they were) and
`PlatformLayout`. The platform shell is the **deep teal** (`theme-shell-deep`, the shell token set that
already exists for dark screens: white text 12.23:1, the current page a turquoise pill with ink text 7.31:1)
with the product's lockup and a **"Platform" / «المنصة»** label (a shield icon and the word in a pill; on the
sign-in page in the accent tint). No new colour token. On phones the top bar shows the logo and the label (the
product's name is read by assistive technology, not shown) and below 384 px the label is its shield alone with
the word read: the label, the language switch and the account menu fit 320 px. The account block shows the
platform account's name and e-mail address (the demo account's name is the role's own words, «مالك المنصة»),
its menu the role "Platform owner", *Change password* and *Sign out*.

**F11-7 — Language and time.** The platform pages follow `PlatformMe.admin.preferred_language`
(`PlatformLanguageController`), else the device's language; the switch there saves through
`PATCH /platform/auth/preferences` (`usePlatformChangeLanguage`; `LanguageSwitchButton` is the presentational
button, `useSwitchLanguage` the shared optimistic switch that `useChangeLanguage` now uses too). A language
picked on the platform sign-in page is saved to an account without a preference at sign-in, as for company
users (F10-24). Dates and times on platform pages use the **device's time zone** (`platformTimeZone()`): the
platform owner belongs to no company, so there is no company time zone to follow (the rule "never the
browser's zone" is the company app's). Lists below `PlatformLayout` keep their view state under the platform
account through `SessionOwnerContext` (`platform:<id>`), so `useUrlParams` and `useBackLink` never ask
`/auth/me` there.

**F11-8 — Sign-in and password change.** `/platform/login`: `CenteredLayout` with the lockup, the label and
the platform's language switch; no forgot-password link (there is none for platform accounts, B11-8). The
forced change uses the company's form (`PasswordChangeForm`, extracted from `ChangePasswordForm`, which now
passes its own mutation and landing page): while `must_change_password` is true the guard allows only
`/platform/change-password` and the navigation is hidden; afterwards the page continues to the companies.

**F11-9 — Companies.** `/platform/companies`: one list card as the users list (search by name or slug in the
history entry's state, never in the address; a state filter and the page in the address), each company with a
building tile, its name in the UI language (`name_ar` in Arabic when set) over its slug, the state as a chip
with icon and text (Active / Deactivated), the two counts in the numeral face and the creation date; the row
is the link. Below `xl` each company is a card.

**F11-10 — A new company is a page.** `/platform/companies/new` (a dialog would hold eight fields and the
password rules): "Company" (name, Arabic name typed right to left, slug, default language, time zone) and
"First administrator" (name, e-mail, `TemporaryPasswordField` reused with its generator). The slug is
suggested from the English name (`suggestSlug`: accents dropped, hyphens between words, at most 80
characters) until it is typed; an Arabic-only name suggests nothing. After creation the page shows the
company, "Pass the temporary password on now: it is shown only once." (the one line before leaving loses it),
the address and the password read-only with *Copy password*, then *Open company*. The password lives in the
page's state and a mutation with `gcTime: 0`. A taken slug (409 `CONFLICT`) and a taken address (409
`USER_EMAIL_UNAVAILABLE`) show on their fields; the 422 paths `admin.full_name`, `admin.email` and
`admin.temporary_password` map to theirs.

**F11-11 — Forms re-check as they are corrected.** `useFormErrors` gained `refresh(clientErrors)` and
`attempted`: after a refused submit the platform forms validate again on every change, so a message goes as
soon as its field is right; `refresh` never moves focus. (The live check showed a filled form still carrying
"Enter the company name." under every field until the next submit.) Existing forms are unchanged.

**F11-12 — A company's page.** Header: the name, the state chip, the slug and "Created …" / "Deactivated …"
as facts; *Audit log* (the platform's log narrowed to the company), *Edit*, and *Deactivate* or *Reactivate*
(on phones the three in one menu beside the title). Two KPI tiles (active users, visits in the last 30 days),
the identity as facts, and the administrators (name, "Inactive" or "Temporary password", address, last
sign-in) with *Add administrator* (a dialog; the password shown once more, focused) and *Send reset link* for
an active administrator of an active company (the toast says where it went; 409 and 429 say why not).
Deactivation asks first with one line, "Its users are signed out and can no longer sign in or use their
passes."; reactivation does not ask (it only allows sign-in again). *Edit* changes the names, time zone and
default language and sends only what changed; the slug is shown, never edited.

**F11-13 — The platform's audit log.** `/platform/audit` reuses the company log's list
(`AuditEventList`, now generic over the row, with an optional company column, no links to company pages and
its own accessible name): time, event, the company as a link to its page, who. Filters: the event (the 16
actions of the platform's trail) and a company (`?company=<id>` from a company's page, shown as a chip with
the company's name). Events without an actor from the command line (`metadata.source = "cli"`) read
"Command line" / «سطر الأوامر» instead of "System or anonymous": that also applies to the company log's seed
rows, which are the same case.

## A company's audit log

**F11-14 — Phase 11 in the audit vocabulary.** Actions `COMPANY_DEACTIVATED`, `COMPANY_REACTIVATED` (group
Administration) and `EMAIL_TEMPLATE_UPDATED`, `EMAIL_TEMPLATE_RESET`, `EMAIL_TEMPLATE_TEST_SENT` (a new group
"E-mail texts" in the action filter); `PLATFORM_ADMIN_CREATED` and `PLATFORM_ADMIN_PASSWORD_SET` have words
(the platform's log shows them) but are not offered in a company's filter, where they cannot appear
(`PLATFORM_ACCOUNT_ACTIONS`). Entity types `email_template` and `platform_admin`. A row without an actor whose
`metadata.source` is `"platform"` shows **"Platform owner" / «مالك المنصة»** with a shield tile, in the list,
the details and the dashboard's latest events (`isPlatformSourced`). Metadata: `platform_admin_id`,
`invalidated_reset_links`, `language`, `draft`, `changed`, `reset` have labels; the values `platform`,
`company_inactive` ("Deactivated company", so a refused sign-in's chip does not read like the action
"Company deactivated"), `template_test_sends_per_user`, `ar` / `en` and the e-mail kinds have words; a text
named `ar.subject` reads "Subject (Arabic)" / «الموضوع (العربية)» (`templateFieldText`). The backend-reading
tests (`auditLabels.test.ts`, `auditVocabulary.test.ts`) pass.

## A company's e-mail texts

**F11-15 — The server's checks, mirrored.** `features/admin/emailTemplateForm.ts` `checkTemplateText` makes
the checks of the backend's `check_text` in its order and with its codes (after the same normalisation: line
ends, trimming): `too_long` (in characters), `line_breaks`, `control_characters`, `bidi_controls`,
`markup_not_allowed`, `invalid_placeholder`, `unknown_placeholder`, `placeholder_required`. A problem shows
under its field once the field is edited (every problem after a refused save or test), in the UI language, from
`errors:fieldCodes`. The server stays the judge: a 422's `ar.<field>` / `en.<field>` errors land on the same
fields and the first one is focused; editing a field clears the server's message for it.

**F11-16 — List and editor.** *Administration → E-mail texts* (`/admin/email-templates`, after Company
settings): the four e-mails with whom each goes to, how many texts the company changed (or "Product texts")
and when. `/admin/email-templates/:kind` (any other kind: "E-mail not found"): **both languages are on the
page at once**, Arabic then English, side by side from `xl` and stacked below. *Interpretation:* tabs would
hide the other language's fields, and an error there (from the server, or a missing variable) could not be
shown or focused; side by side the same field lines up in both languages for whoever translates. Each field:
its label ("Changed" when the company has its own text; the accessible name says the language, "Subject
(English)"), a one-line or multi-line control with `dir` and `lang` of its language (Arabic right to left,
English left to right), the product's text as the placeholder, *Edit default text* (start from it) or *Use
default* (empty the field: the product's text applies), the required variable as a rule with its state
("Must include Company", icon and text), the character count, and the error. The variables are chips under
the field being edited in each language ("Variables", each named in the UI language, `{name}` as the tooltip);
a chip inserts at the caret or over the selection and returns focus there (a pointer never takes the caret;
by keyboard the chips follow the field in tab order).

**F11-17 — Save, reset, test.** *Save* (a sticky bar with the state and *Discard changes*) sends only the
fields that changed, an emptied one as `null`; leaving with unsaved changes asks first
(`UnsavedChangesGuard`, moved out of the company settings form for both). *Reset to default* asks with one
line, "Every text of this e-mail goes back to the product's, in both languages.", and sends no language
(*interpretation:* one language's or one field's reset is *Use default* on the fields; the API's `language`
parameter is not used). *Send test* sends the draft (valid by the client's checks) with the UI language
leading and says where it went ("To <address>"); after the hourly limit it says how long to wait from
`Retry-After` ("Too many test e-mails. Try again in 25m.").

**F11-18 — Preview.** A card under the editor, with which language leads: **Draft** renders the unsaved
texts with `POST …/preview` (600 ms after the last change, the previous rendering kept meanwhile, nothing when
the draft has a problem) and shows the subject and the text version, each line in the direction of most of
its letters (`lineDirection`: `dir="auto"` put an English sentence starting with an Arabic name on the
right). **Saved e-mail** is `<iframe sandbox src="/api/v1/email-templates/{kind}/preview?language=…">`, the
backend's document with its own policy, remounted after every save and reset: the e-mail exactly as a mail
client shows it. The returned `html` is never put into the page (the SPA's `style-src 'self'` would strip its
inline styles). Checked in the live run and through `vite preview` with the production headers: the API's own
`Content-Security-Policy` and `X-Frame-Options: SAMEORIGIN` reach the browser and the frame renders.

**F11-19 — No explanatory notes.** The sentences on the new screens are: the deactivation's and the reset's
one line each, "Pass the temporary password on now: it is shown only once." after creating an account (as for
*Add user*), the rules ("Must include Company", the character counts, the password rules of the reused
field), errors and validation, and data. No page, card or empty-state descriptions.

## Tests

**F11-20 — Unit tests.** New: `api/platformRealm.test.ts` (the CSRF cookie per realm, `Retry-After`, the
preview address), `features/platform/companyForm.test.ts` (slug, validation, request bodies, the platform
sign-in's destinations), `PlatformArea.test.tsx` (the guard for a company user, sign-in and `next`, the
forced change, a platform 401 that leaves the company session, sign-out of the platform only, the realms'
tab messages, the language preference and Arabic), `PlatformPages.test.tsx` (companies, creation with its
errors in both languages, a company's page and its actions, the audit log), `features/admin/
emailTemplateForm.test.ts` (every check, the bodies, insertion), `EmailTemplatesPage.test.tsx` (the list, the
editor's validation, insertion, save, the server's errors on their fields, reset, test and its limit, both
previews, Arabic), `auditPlatform.test.tsx` ("Platform owner", the new actions and values in both
languages), and a `refresh` test in `useFormErrors.test.tsx`. Updated: the two navigation lists (the new item),
`catalogs.test.ts` (the two error codes), `api.contract.test.ts` (F11-1), `config/chunking.test.ts` (the new
lazy pages).

**F11-21 — E2E.** The global setup signs in the platform owner (`platform@demo.local`; storage state
`platform.json`; it fails if the account has a language of its own) and warms up the new routes;
`open({ platform: true })` and `Api.platform()`; the API helper sends the platform CSRF cookie for `/platform`
requests. Specs:
   - `flows/platform-owner.spec.ts`: sign-in at `/platform/login`, a company with its first administrator
     (slug suggested, password shown once), that administrator's sign-in and forced change, deactivation
     (their session ends and sign-in is refused), reactivation (sign-in works), the platform's audit log for
     the company, "Platform owner" in the company's own log; and each session refused by the other's pages;
   - `flows/email-texts.spec.ts`: the invitation's texts edited (validation, a variable from its chip), the
     draft preview, save, the saved e-mail in its frame, a test e-mail in the outbox ("[Test] "), a real
     invitation in the company's words, reset. *Interpretation:* it runs as Other Corp's administrator, not
     Mawdoo3's: the texts are company-wide and the other flow specs read Mawdoo3's invitations in parallel
     (the suite's rule for company-wide changes); a `finally` resets the texts;
   - `phase11-arabic.spec.ts` (desktop and phone): the platform's sign-in, companies, new company and audit
     log, and the e-mail texts list and editor in Arabic, with axe-core and no horizontal scroll. No seeded
     account's language changes: the platform pages follow a device set to Arabic, and the e-mail texts are
     read by an administrator the spec creates;
   - `quality/accessibility.spec.ts`: the two e-mail texts pages for the administrator, the platform's four
     pages and a company's page with the platform session, and the platform sign-in signed out (axe-core and
     reflow at the project's width and 320 px, on the three devices);
   - `flows/permissions.spec.ts`: the new navigation item and page for the administrator, refused to others.

**F11-22 — Changes outside the new files.** `hooks/useFormErrors.ts` (F11-11), `features/auth/
ChangePasswordForm.tsx` (F11-8), `features/admin/CompanySettingsForm.tsx` (the guard moved), `AuditEventList`
and `AuditEventSummary` (F11-13, F11-14), `i18n/session.ts` (`companyDisplayName` takes any named company),
`components/app/LanguageSwitcher.tsx` and `i18n/useLanguage.ts` (F11-7), `layouts/CenteredLayout.tsx` (a
`languageSwitch` slot; `eyebrow` may hold an element), `layouts/AppLayout.tsx` (F11-6), `auth/useAuth.ts`
(`SessionOwnerContext`), `auth/authSync.ts`, `auth/redirect.ts`, `auth/session.ts`, `auth/AuthProvider.tsx`
and `api/queryClient.ts` (F11-4).

## Verification (2026-10-13)

On the reference machine (Windows 11, Node 24.19, Python 3.14.6, PostgreSQL 18.6 on port 5433), from
`frontend/`, on the final state of the files:

| Gate | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run lint` (oxlint 1.86.0, warnings fail) | 0 findings on 551 files, 231 rules |
| `npm test` (Vitest 5.0.3) | 136 files, 1,495 tests passed, 0 failed, 132.27 s (129 files and 1,383 tests before this phase; `api.contract.test.ts`, `fieldMessages.test.ts`, `auditLabels.test.ts` and `auditVocabulary.test.ts`, 33 failing tests at the start, pass) |
| `npm run e2e:typecheck` | 0 errors |
| `npm run build -- --outDir <scratch> --emptyOutDir` (Vite 8.3.2) | succeeded, no warnings, 2,757 modules; start-up `app` chunk 280.79 kB / 79.37 kB gzip (259.00 / 73.61 before: the `platform` catalog and the new `admin` keys in both languages), stylesheet 91.99 / 16.62; the platform area and the e-mail texts are chunks of their own |
| `npm run e2e -- --retries=0` (ports 5199/8700, database `vms_e2e`) | 293 tests: 273 passed, 20 skipped by their project conditions, 0 failed, 8.5 min (253 tests, 235 run before this phase) |
| backend `pytest` | not run: no backend file changed (3,236 passed at the backend's gate) |
| `deploy/verify/check_release_tree.py`; `unittest discover -s deploy/verify` | 968 files, no artefact or credential; 35 tests OK |

Two earlier full runs of the suite on the same day: one had a single failure, `[tablet] administrator ·
inside now` of the accessibility spec, a blank page whose trace shows three module requests aborted with
`net::ERR_NETWORK_CHANGED` (the machine's network changed during the run; not a page this phase touched); the
next run, before the last layout detail (F11-12's facts line stacked on phones), was 273 passed, 20 skipped,
0 failed in 10.3 min.

**Live check.** An API on 8931 and Vite on 5931 against a throwaway database (`vms_p11live`: created,
migrated to `0013`, `seed-demo`, dropped afterwards; both servers stopped), with Playwright's Chromium, in
Arabic and English at 1440 and 390 px: the platform sign-in, the companies, the new company (empty, with its
errors, filled, created), a company's page (active, the confirmation, deactivated, its phone menu, the edit and
add-administrator dialogs), the platform's audit log and password change; as `admin@demo.local` the e-mail
texts list, the editor (as loaded, with problems, the draft preview, the saved e-mail in its frame, the reset
confirmation) and the audit log after the platform owner sent a reset link and added an administrator
("Platform owner" / «مالك المنصة» with the shield). 82 screenshots in the session scratchpad's
`phase11-shots/`. No horizontal scroll on any of them and no script error; the only failed requests are the
session checks of a signed-out browser (401). Found and fixed there: client messages that stayed after their
field was corrected (F11-11), the status filter's option cut off, the phone top bar 2 px too wide with the
label (F11-6), three stacked full-width actions on a company's page on phones (F11-12), an English line of
the text version starting with an Arabic name set right to left (F11-18), facts lines whose separator dot
was stranded on phones. Also checked through `vite preview` (production headers) with the same API: the
saved-preview document arrives with the API's own `Content-Security-Policy` (… `frame-ancestors 'self';
sandbox`) and `X-Frame-Options: SAMEORIGIN`.

## Open items

1. **For the backend (observations, nothing blocking).** The audit vocabulary test did not see the metadata
   keys `platform_admin_id`, `language`, `draft`, `changed` and `reset` (they are written through a helper and
   keyword arguments its reader does not parse); they have words in both catalogs anyway. `Retry-After` is
   only a header (the client now reads it). The preview's `html` field is not used by the SPA (F11-18).
2. `POST /email-templates/{kind}/reset` with one `language` is not offered (F11-17): one language's texts
   are reset field by field.
3. The platform pages show dates in the device's time zone (F11-7); a time zone of the platform's own would
   need a backend setting.
4. A deactivated company's page lists its administrators without "Send reset link" (the server would answer
   409 `COMPANY_INACTIVE`); nothing else is disabled there.
5. The platform owner's account has no page of its own beyond the password change (name and e-mail come from
   the CLI); a second platform account is created with the CLI (the backend's open item 2).
6. In production the framed preview relies on nginx passing the API's own headers for `/api/` (it does: the
   `/api/` locations add no SPA headers); this was read in the nginx template, not run in a container.
7. The other forms of the app keep a client message until the next submit; `useFormErrors.refresh` (F11-11)
   is there for them.

---

## Review fixes: the UX, i18n and accessibility review of the Phase 11 screens (2026-10-13)

Scope: `frontend/src/**` (the platform owner's area, the e-mail texts editor, the audit list, `MetaLine`,
`index.css`, the `admin`, `common`, `errors` and `platform` catalogs in both languages), `frontend/e2e/**`,
`frontend/README.md` and this file. No backend file was changed. The review demonstrated one high, six
medium and seventeen low findings and a list of Arabic wordings; each was fixed at its cause with a
regression test. Where an entry above says otherwise, these entries hold: F11-6 (the shell's colour:
F11-34), F11-10 and F11-19 (the line on the created screen: F11-38), F11-12 (the deactivation's line and
the link's name: F11-25, F11-31), F11-16 (the editor's layout and the chips: F11-28), F11-17 (which
language a test leads with, how the limit is worded: F11-32, F11-33), F11-18 (`lineDirection` is gone:
F11-32). After the fixes the backend's final contract was mirrored (F11-42 to F11-49, below), which also
holds over the entries above: F11-2 (a server refusal that names a variable: F11-42), F11-13 (eighteen
events, a seed's rows: F11-46), F11-15 (ten checks, and when a problem shows: F11-42), F11-16 and F11-17
(the English name of the default texts: F11-48). Outside the Phase 11 screens, the gate runs found two
races in older tests; their fixes touch `features/reception/useResultClock.ts` and eight test files
(F11-50).

**F11-23 — H1: the platform's audit log keeps the stacked row until `xl`.** `AuditEventList` had five
tracks from `md` when it shows a company (`COLUMNS_WITH_COMPANY`: 560 px of fixed and capped tracks plus
gaps). Beside the sidebar a tablet or a small laptop leaves the list 678 to 830 px, so the event kept 38
to 114 px and its title was drawn over the company. The layouts are now two named sets of classes
(`LAYOUTS.plain`, `LAYOUTS.withCompany`): a company's own log is unchanged (columns from `md`); with a
company column the row stays stacked (event, time, company, actor, the Details button beside them) until
`xl`, and from there the tracks are `12rem minmax(12rem,1.3fr) minmax(0,1fr) minmax(0,1fr) 7.5rem`: the
event never under 12rem, the company and the actor sharing the rest. *Interpretation:* of the two fixes the
review offered, both are applied where each fits (stacked below `xl`, fractional tracks from it); a
five-column row at 768 to 1279 px would leave the company and the actor about 140 px each. Measured live
in both languages from 390 to 1920 px: no cell over another, nothing spilling; the event 214 px at 1280,
277 px at 1440.

**F11-24 — M1: the unsaved-changes dialog says what would be lost in the page's own words.**
`UnsavedChangesGuard` takes a required `description`; its own words moved to `admin:unsavedChanges` (title,
stay, leave). The company settings say "Your changes to the company settings have not been saved.", the
editor "Your changes to this email's texts have not been saved." / «لم تُحفظ تغييراتك على نصوص هذه
الرسالة.».

**F11-25 — M2 and the Arabic wording: «رسالة» and "email", one name for the default texts.** The new
screens said «الإيميل / الإيميلات» twenty times and "E-mail" twenty times; every older screen says «رسالة» /
«البريد الإلكتروني» and "email". All forty are changed in the four catalogs (navigation and page «نصوص
الرسائل» / "Email texts", the audit actions, entities and values, toasts and errors), and the route's
fallback label. The default texts have one Arabic name, «النصوص الأصلية» («استعادة النص الأصلي», «تعديل النص
الأصلي», «استعادة النصوص الأصلية؟», «أُعيدت النصوص الأصلية», the list's «النصوص الأصلية»; «نصوص المنتج» is
gone). The other wordings of the review are applied as written: «إرسال رسالة تجريبية», «أُرسلت الرسالة
التجريبية», «يجب أن يتضمن المتغيّر «الشركة»» (the label a value), «اكتب نصًا عاديًا دون وسوم أو رموز
برمجية.», «الزيارات (آخر 30 يومًا)», «أُنشئت يوم …» / «عُطّلت يوم …», «بإمكان {{name}} تسجيل الدخول الآن»
(also in *Add user*, where it came from), and the deactivation's line in both languages ("Its users are
signed out and cannot sign in, and its visitor passes stop working."). «المتغيّر» is written with its
shadda everywhere. English has one name too, "default text(s)", since the lead's decision on the interim
report (F11-48).

**F11-26 — M3: braces by their Arabic name, with the example as a value.** `errors:fieldCodes.
invalid_placeholder` said «قوسين معقوفين», which are square brackets. It is «اكتب المتغيّر بين حاصرتين،
هكذا: {{example}}. الحاصرتان للمتغيّرات فقط.», and the English text takes the same `{{example}}`. The
server sends no parameter for it, so `fieldCodeValues` supplies the texts' own values per code
(`OWN_VALUES`: `{visitor_name}`; a parameter of that name from a newer server wins). *Found on the way:*
`fieldMessages.test.ts` checked that each text uses only its code's parameters with a pattern that had
lost its backslashes (`/{{s*(w+)s*}}/`) and so read no variable at all; it is repaired, has a test of its
own, and the catalogs pass it.

**F11-27 — M4: an administrator added to a deactivated company is not told they can sign in now.**
`TemporaryPasswordReveal` takes `companyActive`: "… can sign in once the company is reactivated" / «بإمكان
… تسجيل الدخول بعد إعادة تفعيل الشركة», as an information alert, otherwise the success line as before.

**F11-28 — M6, L7, L8: the editor by field, each text's variables always under it, as a toolbar.**
   - *By field (L8).* Each field is a group (`role="group"`, an `h2` with the field's name) holding its
     Arabic and its English text, side by side from `md` and one right under the other on phones; a text's
     visible label is its language, its accessible name both ("Subject (Arabic)"). Before, the languages
     were two whole blocks, side by side only from `xl`: on a phone a field's two languages were about
     1,400 px apart, now 266 px. The order of the fields in the page is also the order in which a refused
     save focuses the first problem.
   - *No movement (L7).* The chips moved with the field being edited, and the form jumped 78 px under the
     pointer. Of the three ways the review offered, each text now **shows its variables permanently**. A
     fixed bar would be one tab stop away from only one of fourteen texts (a keyboard user inserts at the
     caret by Tab from the text and back), and reserved empty space costs the same height as the chips.
     Nothing appears or moves when a text takes focus; the row above a text has one height with or without
     its "Use default text" button (on touch screens the button reaches 44 px through negative margins).
   - *A toolbar (M6).* The eight chips of a text are `role="toolbar"` named for their text ("Variables:
     Subject (Arabic)", `aria-controls` the text): one tab stop, the arrow keys in the reading direction
     (mirrored in Arabic), Home and End, the stop remembered (`hooks/useRovingToolbar.ts`). From the first
     text to Save: 41 presses of Tab, from 138. Enter on a chip inserts at the caret and returns to the
     text, as a pointer does.
   - *Touch screens.* Chips are 44 px tall there; fourteen wrapped rows of them would add about 2,000 px
     to a phone's page, so on a coarse pointer a text's chips are one row that scrolls sideways (edge
     shadows; its content is focusable). With a mouse they wrap.
   - *The cost, measured.* Showing every text's variables makes the page longer: 3,887 px at 1440 px
     (3,171 before) and about 5,900 px at 390 px (about 5,550 before; 6,236 before the rows were
     tightened on phones). The review's complaint at 390 px was the distance between a field's two
     languages, which is gone; the height is the price of L7's fix and is recorded here.

**F11-29 — M7: an event's raw metadata.** `dir="ltr"` (in the Arabic page each line's brace, colon and
comma stood at the wrong end) and no height cap: it wraps inside its box (`wrap-anywhere`) at its full
height, so it is no scroll box of its own and needs no tab stop (axe `scrollable-region-focusable`).

**F11-30 — L1: touch targets on the platform's audit log.** The company chip's clear button is 44 × 44 px
(it was 36) and a row's company link 44 px tall on touch screens without a taller line (it was 18 px).
*Found on the way:* the same pattern on the company log's record link ("Events for this user") gave 42 px
with its 13 px text; it is 46 px.

**F11-31 — L2, L4: names.** A control's accessible name starts with the words on it (WCAG 2.5.3): "Edit
default text: Subject (Arabic)", "Use default text: …", and, found on the way, "Send reset link to Nadia
Haddad" (it was "Send a password reset link to …", which does not hold the visible "Send reset link").
The link from a company's page to the log narrowed to it reads "This company's audit log" / «سجل تدقيق
هذه الشركة», on the button and in the phone's menu: two links named "Audit log" no longer go to different
places.

**F11-32 — L3, L5, L6: the draft preview by language section.** `lineDirection` counted each line's
letters, so an English line holding an Arabic name was set right to left and an Arabic one holding a
Latin value left to right. `previewTextSections` (`emailTemplateForm.ts`) reads the text as the backend
lays it out (`templates/base.txt`): the leading language's section from the top to the other language's
title (its name between two rules), the other's from there to the footer's mark (`--`, the last one), and
in the footer, where the two languages follow each other unmarked, each line by its own letters with the
values the e-mail isolates (U+2066 to U+2069) left aside, or as the line before it. A text without that
title is read line by line the same way, so a change of the backend's layout degrades to that. Each
section is one element with its `dir` and `lang`; the subject is set in the leading language's direction
with each half in its own language when it has the one separator. The editor holds the preview's "First
language", and *Send test* sends with it (it sent the UI's language). *For the backend:* the mark before a
test's subject is the leading language's («[تجربة] » when Arabic leads); the UI now says «رسالة تجريبية».

**F11-33 — L9 and the wording of waits.** `formatWaitDuration` (`utils/duration.ts`) says a wait in words
with each unit's plural: "25 minutes", "1 hour 5 minutes" / «25 دقيقة», «دقيقتين», «ساعة واحدة و5 دقائق»
(the Arabic forms are those after «بعد»), rounded up to a whole minute and never less than one: a wait is
not promised short. The test e-mail's limit says "Too many test emails. Try again in 25 minutes." / «بلغت
الحد المسموح من الرسائل التجريبية. حاول مجددًا بعد 59 دقيقة.», and the reset link's limit, which showed
the generic message although the API sends `Retry-After`, "Too many reset links for this account. Try
again in 15 minutes." (the budget is the account's, shared with forgot-password). Without the header the
server's own message stays.

**F11-34 — L10: the platform's shell in the dark colour scheme.** There a company's shell is the deep
teal, which was also the platform's. `theme-shell-platform` is the deep teal in the light scheme and
`theme-shell-slate` in the dark one: mawdoo3.com's own slate #33444e, another hue than the teal #0f3b3f
(1.21:1 apart in lightness, so the hue carries it) and a step above the dark content (1.81:1 against the
canvas). White 10.11:1, secondary text 7.53:1, muted 6.88:1 (4.76:1 on the hovered account block: axe
found 4.29:1 there with the first value), the current page's turquoise pill 4.05:1 against the shell with
ink text 7.31:1, focus 5.18:1; every pair is in `designTokens.test.ts`, which also holds that the two
shells differ in both schemes.

**F11-35 — L11: the account menu does not repeat the role under a name that is the role.** The demo
account is named «مالك المنصة»; the menu's header then shows the name and the address only, whichever
language the UI is in (the name is compared with the role's words in both).

**F11-36 — L12: the platform's audit rows say which administrator.** For the companies whose rows on the
page concern a user, and no others, the page asks `GET /platform/companies/{id}/admins` (one request per
company, shared with the company's page, kept a minute) and the row reads "User: Nadia Haddad" /
«مستخدم: …» (the name isolated); the details show the name over the ID. A user the company no longer lists
keeps "User".

**F11-37 — L13: a line of facts never strands a separator.** `MetaLine`'s dots were elements between the
facts, so a wrap left one at a line's end. Each fact now carries its dot in the room before it, the row
starts that room outside the line, and the line clips there (`overflow-x: clip`, 4 px out on both sides
for focus rings): the first fact of every line shows no dot, at any width. A fact with a direction of its
own that wraps (the slug, `dir="ltr"`) keeps its lines on the reading side: `text-align-parent`
(`index.css`; Chromium knows `match-parent` only as `-webkit-match-parent`, found in the live check). Every
other screen with a line of facts was checked (dashboard, history, reports, reception, inside, users,
departments, audit).

**F11-38 — L14, L15: the created screen.** The address is text in a box that grows (`ReadOnlyField` in
the kit, with `EmailText`), not a read-only input, which cut a long address off at 390 px; *Add user*'s
dialog had the same input and got the same fix. The second sentence under the password is gone.
*Interpretation:* *Add user*'s one line says both facts ("shown only once and expires after 72 hours"),
so the platform's line does too rather than lose the expiry: "Pass the temporary password on now: it is
shown only once and expires after 72 hours." / «سلّم كلمة المرور المؤقتة الآن، فهي لا تُعرض إلا مرة
واحدة وتنتهي صلاحيتها بعد 72 ساعة.» (the review's wording with the hint's clause).

**F11-39 — L16: the companies table's columns.** The created date had 15 % and the Arabic date («الثلاثاء،
13 تشرين الأول 2026», 171 px) broke after the weekday. The shares are 31 / 12 / 15 / 14 / 23 / 5 %: the
date is on one line from 1280 px, and "Active users" in Arabic no longer spills 6 px out of its header at
1280 px.

**F11-40 — L17: the company log's record-type filter** no longer offers "Platform account"
(`PLATFORM_ENTITY_TYPES`, `companyAuditEntityTypes`); a link that names such a type still shows it as
chosen.

**F11-41 — Tests.**
   - Unit: `hooks/useRovingToolbar.test.tsx` (new), `utils/duration.test.ts` (waits), `i18n/
     fieldMessages.test.ts`, `designTokens.test.ts` (the slate shell, the two shells apart),
     `components/ui/directionC.test.tsx` (`MetaLine`), `features/admin/emailTemplateForm.test.ts` (sections,
     mixed-script lines, the subject), `EmailTemplatesPage.test.tsx` (by field, permanent toolbars, the
     keyboard, names, the guard, the test's language, both wordings of the limit, the preview's sections),
     `AuditLogPage.test.tsx`, `CompanySettingsPage.test.tsx`, `UsersPage.test.tsx`, `auditPlatform.test.tsx`,
     `features/platform/PlatformPages.test.tsx` and `PlatformArea.test.tsx`.
   - E2E: `e2e/phase11-review.spec.ts` (new; the API mocked, both languages): the audit log's layout at
     eleven widths from 768 to 1440 px, the raw metadata with axe, 44 px targets on touch, the two shells
     in both colour schemes, the long slug's line, the long address, the Arabic date's line at four widths,
     the editor's keyboard (45 presses at most, mirrored arrows), no movement on focus, the two languages
     of a field together, the preview's lines on their section's side. The specs that read the changed
     words follow (`flows/email-texts`, which also sends a test with Arabic first, `flows/platform-owner`,
     `flows/permissions`, `phase11-arabic`, `quality/accessibility`).
   - *The spec bites.* Ten of the review's defects were put back one at a time (the five fixed columns, the
     scrolling box, the 36 px button, the one shell colour, the slug's own alignment, separators without
     the clip, the 15 % column, every chip a stop, two columns only from `2xl`, one direction for every
     line): the spec failed each time.

### The backend's final contract, mirrored (2026-10-13)

The backend's own review round (B11-34 to B11-50) ended after the fixes above. B11-50 lists what the
frontend mirrors; every row of it is done below, each with a test. `src/types/backend-contract.json` is the
backend's regenerated snapshot and was not edited here.

**F11-42 — The rules of a text's variables come with the template (B11-40).** `api.ts` has
`EmailTemplate.max_variable_uses` (3) and `fields[].forbidden_variables` (`["purpose"]` for every subject,
empty otherwise); the SPA holds neither as a constant. `checkTemplateText(field, rules, value)` makes the
backend's `check_text` checks in its order, now ten: after an unknown variable come a variable the text
may not hold (`placeholder_not_allowed`) and one used more often than `max_variable_uses`
(`placeholder_repeated`), then a required one that is missing. A text's chips are
`fieldVariables(field, template.variables)`: a subject offers seven variables and no "Purpose", every other
text all eight; what a text would be refused for is not offered under it.
   - *Found on the way: a text saved before a rule.* The backend leaves a saved text that fails today's
     checks out of the e-mails and uses the default text instead (`usable_texts`), and still sends it to
     the editor "so the administrator can correct it". The editor showed a text's problem only once the
     text was typed in or a save was refused: such a text looked in use, and the draft preview said
     "Correct the highlighted fields." with nothing highlighted. `refusedSavedTexts(template)` names those
     texts and their problem shows from the start.
   - *Found on the way: a refusal of the server names the variable as the page does.* A 422 for one of
     the three codes that name a variable of the kind (`placeholder_required`, `placeholder_not_allowed`,
     `placeholder_repeated`) read "{purpose} cannot be used in this text." in English and held the raw
     Latin name inside the Arabic sentence. `serverProblemMessage` gives these three the catalog's text
     with the variable's label in both languages, the words the page's own check uses for the same
     problem. This narrows F11-2's sentence about the server's English: every other code keeps it (F10-6).

**F11-43 — Field codes 65 → 67.** `FieldErrorCode` and both catalogs: `placeholder_not_allowed` (`name`)
"“Purpose” cannot be used in this text." / «لا يمكن استخدام «الغرض» في هذا النص.», and
`placeholder_repeated` (`max`, `name`), counted by `max` (`COUNTED_BY`): "Use “Company” at most 3 times in
this text." / «استخدم «الشركة» 3 مرات على الأكثر في هذا النص.», with "only once" for one and the six
Arabic forms. Both name the variable by its label, as `placeholder_required` does
(`NAMES_A_KNOWN_VARIABLE`); an unknown variable has no label and keeps its name.

**F11-44 — A deactivated company's sign-in says so (B11-46).** `POST /auth/login` answers `409
COMPANY_INACTIVE` to the right credentials of a deactivated company's user. No code changed: a code that
is no field error is the form's alert with the code's own catalog text ("This company is deactivated." /
«هذه الشركة معطّلة.»). `pages/LoginPage.test.tsx` holds, in both languages, that it is the form's alert
and no field's error, that no wording of wrong credentials or of a limit appears, that the form keeps its
values and its button, and that the same form signs in once the company is reactivated. The platform
scenario expects it with the right password and "Invalid email or password." with a wrong one (F11-49).

**F11-45 — The limit on refused addresses (B11-42).** `POST /platform/companies` and `POST
/platform/companies/{id}/admins` answer `429 RATE_LIMITED` with `Retry-After` (the policy
`user_email_refusals_per_user`). Both forms say the wait as the reset link does (F11-33): "Too many
attempts. Try again in 42 minutes." / «محاولات كثيرة جدًا. حاول مجددًا بعد 42 دقيقة.» as the form's
error, the form staying filled; without the header the server's own message stays. One reader for every
such place: `rateLimitWaitSeconds(error)` in `api/client.ts` (the test e-mail and the reset link use it
too).

**F11-46 — The audit vocabulary and the platform's trail.**
   - Words in both catalogs for the metadata key `notified_admins` ("Administrators notified" / «مديرو
     النظام المبلَّغون»: how many of the company's other administrators were told, B11-43), the values
     `seed` ("Demo data seed" / «تهيئة بيانات العرض») and `seed_account` ("Demo account" / «حساب العرض»,
     the reason of a sign-in refused to a seed's account in production, B11-36), and the policies
     `user_email_refusals_per_user` and `login_failures_device`. `auditVocabulary.test.ts` reads the
     backend's source and passes.
   - A row without an actor that a seed wrote (`metadata.source = "seed"`) reads "Demo data seed", as a
     command-line row reads "Command line" (F11-13), not "System or anonymous".
   - The platform's audit page offers eighteen events (sixteen in F11-13): `USER_CHANGE_REFUSED` (an
     address that cannot be used; `code`, `operation`) and `ACCESS_DENIED` (`reason: session_ended`) are
     in `PLATFORM_AUDIT_ACTIONS`, labelled in both languages.
   - A company's rows of what the platform owner did have no network address and no browser (B11-37).
     The details show "Not recorded" / «غير مسجّل» for both, as for every row without them; no term is
     left without a value (`auditPlatform.test.tsx`).

**F11-47 — What counts as activity on the platform's routes (B11-34).** The server no longer counts a
platform request sent with `X-Background-Refresh: 1`. Read in the code and held by tests: the only
platform request that carries the header is the re-check of `GET /platform/auth/me` (the heartbeat every
60 seconds, and returning to the tab); the page's first session check, every list and page the platform
owner opens, every refetch after an action and every mutation go without it. An idle tab is signed out
by the SPA within a minute of the server ending its session: the re-check answers 401, the platform's
cached data is dropped, the company session of the same browser is untouched, and the tab is at
`/platform/login?next=…` to come back to where it was; the sign-in page sends no further re-checks.
`features/platform/platformSessionExpiry.test.tsx` (new), the same in a browser with the clock moved
(`e2e/phase11-review.spec.ts`), and the real scenario, which records every platform request it makes and
finds no marked one besides the session's re-check.

**F11-48 — One English name for the default texts.** By the lead's decision on the interim report:
"Default texts" (the list's badge), "Use default text", "Edit default text", "Reset to default texts",
"Reset to the default texts?", "Every text of this email goes back to its default text, in both
languages.", "Default texts restored". "The product's texts" is gone from the catalogs, and a test holds
that the page does not say it. The mark before a test e-mail's subject stays the leading language's
(«[تجربة] » / "[Test] "), also by that decision.

**F11-49 — E2E.** `e2e/support/outbox.ts` knows the kind `PLATFORM_ACTION_NOTICE`.
`flows/platform-owner.spec.ts`: the deactivated company's administrator reads "This company is
deactivated." with the right password and "Invalid email or password." with a wrong one; the platform
owner adds a second administrator through the dialog and the first one gets the notice (no password and
no link in it); a reset link for the first administrator arrives with the platform's own wording ("The
platform owner sent you a link to set a new password for your … account.", B11-49) and the second
administrator gets the notice; the audit rows name both administrators; no request the platform owner
made was marked a background refresh. `flows/email-texts.spec.ts`: `{purpose}` in a subject is refused
with the variable's label, a subject has no "Insert Purpose" chip and the closing has one, and the reset
reads the one English name. `quality/dialogs.spec.ts` follows the reset's name. No helper of the suite
assumes the length of a generated temporary password (32 characters from the CLI now): the forced-change
helpers type what the page or the seed gives them.
`e2e/phase11-review.spec.ts` has the idle platform session in a browser whose clock is moved (F11-47).
`e2e/phase11-arabic.spec.ts`: the check that the navigation names the section «نصوص الرسائل», added with
the review fixes, looked for the link on the page; on a phone the navigation is a drawer behind its
button, which the suite's first full run showed (1 failed of 341). The test opens the drawer where there
is one, and checks the page in Arabic with it open too.

**F11-50 — Two races in older tests, found by the gate runs.** Two full unit runs on the shared machine
each failed one test that this work had not touched. Both are fixed at their cause.
   - *Reception: the one-key Check out at five minutes.* `useResultClock` set one timer for the moment a
     recent check-in turns five minutes old and judged the result by the clock when the timer fired. A
     timer that fired while the clock was still short of that moment changed nothing, and the panel
     kept "Check out…" (with its confirmation: the safe side) until its next 10-second refresh. That
     happens when a device's clock is set back, and in the tests, where only the clock is faked and
     stands still until the test moves it: `ReceptionScanner.test.tsx` passed only while its own steps
     took under 200 ms. The timer now waits for the rest while the clock is short of the moment. A new
     test holds it; without the change it fails with the gate run's error.
   - *Document titles.* `useDocumentTitle` sets the title in an effect, after the commit that shows the
     heading a test waited for. Sixteen assertions in eight test files read `document.title` at once
     and passed while the effect happened to have run (the gate run read `''`). They wait for it, as
     `PassPage.test.tsx` already did.

### Verification of the review fixes and the mirrored contract (2026-10-13, final)

From `frontend/`, on the final state of the files:

| Gate | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run lint` (oxlint 1.86.0, warnings fail) | 0 findings on 556 files, 231 rules |
| `npm test` (Vitest 5.0.3) | 138 files, 1,574 tests passed, 0 failed, 151.20 s (136 files and 1,495 tests before the review fixes; 137 and 1,552 at the interim report, where ten tests that read the backend's changing contract failed: `api.contract.test.ts`, `fieldMessages.test.ts`, `auditVocabulary.test.ts` pass) |
| `npm run e2e:typecheck` | 0 errors |
| `npm run build -- --outDir <scratch> --emptyOutDir` (Vite 8.3.2) | succeeded, no warnings, 2,759 modules; start-up `app` chunk 283.74 kB / 79.98 kB gzip (280.79 / 79.37 before the review fixes), stylesheet 95.97 / 17.07 (91.99 / 16.62) |
| `npm run e2e -- --retries=0` (ports 5199/8700, database `vms_e2e`: its global setup recreates the schema, migrates it to `0014` and seeds it) | 341 tests: 305 passed, 36 skipped by their project conditions, 0 failed, 11.0 min (293 tests, 273 passed, before the review fixes) |
| backend `pytest` | not run here: no backend file changed (3,426 passed at the backend's gate, B11's verification) |

**Earlier runs of the same day, and what each one showed.**
   - Unit: two full runs passed (1,567 and 1,573 tests, as tests were added); then two runs each failed
     one older test, a different one each time (F11-50); the run in the table is the one after those
     fixes.
   - E2E: the first full run was 341 tests, 304 passed, 36 skipped, 1 failed
     (`[mobile] phase11-arabic.spec.ts › a company's e-mail texts in Arabic`: the navigation's link on a
     phone, F11-49). Before it, the specs this round changed were run alone: 63 tests, 46 passed, 16
     skipped, 1 failed (the new idle-session test counted the session checks of the page's load, which
     the development build makes twice; it counts the marked requests now).
   - The interim gates of the review fixes, before the contract was mirrored: typecheck 0, lint 0 on 555
     files, build 2,759 modules, `e2e/phase11-review.spec.ts` alone 45 tests (31 passed, 14 skipped),
     and ten mutations of the fixes, each caught by that spec (F11-41).

**Live check.** An API on 8931 and Vite on 5931 against a throwaway database (`vms_p11uxfix`: created,
migrated to `0014`, `seed-demo`, more companies through the platform API, dropped afterwards; both
servers stopped), with Playwright's Chromium in Arabic and English at 1440, 820 and 390 px, light and
dark, twice: after the review fixes and after the contract was mirrored.
   - *After the review fixes:* the measurements quoted in the entries above, axe-core with the WCAG 2.2
     AA rules on every state (clean at the pages' own states; one `target-size` note where a button
     stood half under the sticky action bar at one scroll position), no horizontal scroll, no script
     error. Found and fixed there: `match-parent` unknown to Chromium (F11-37), 4.29:1 on the slate
     shell's hovered account block (F11-34), the 42 px record link of the company log (F11-30), the
     phone's page 700 px longer before its rows were tightened (F11-28).
   - *After the mirror:* the editor as loaded and with the two new problems typed (a subject offers
     seven variables, every other text eight; "“Purpose” cannot be used in this text." / «لا يمكن
     استخدام «الغرض» في هذا النص.»; "Use “Company” at most 3 times in this text." / «استخدم «الشركة» 3
     مرات على الأكثر في هذا النص.»), "Use default text" on a changed text (132 × 28 px, 44 px tall on
     touch) and the reset's confirmation; the sign-in of a deactivated company's administrator (409:
     "This company is deactivated." / «هذه الشركة معطّلة.», no field marked, the button enabled; a
     wrong password 401 with the usual sentence); after ten refused addresses *Add company* and *Add
     administrator* answered 429 with `Retry-After` and say "Too many attempts. Try again in 1 hour." /
     «… بعد ساعة واحدة.» and "… in 58 minutes." / «… بعد 58 دقيقة.», the forms still filled; the
     platform's audit log with those rows ("User change refused · User email unavailable", "Too many
     requests · Refused account email addresses (user)", eighteen events offered, the seed's row "Demo
     data seed"); the company's own log with the platform owner's row (IP address and user agent "Not
     recorded" / «غير مسجّل», "Administrators notified 1", no term without a value) and the seed's rows
     ("By Demo data seed" / «بواسطة تهيئة بيانات العرض»). axe, horizontal scroll, 44 px targets on the
     phone and the browser's console: nothing found.
   - 168 screenshots in the session scratchpad's `phase11-shots/fix/` (132 after the review fixes, 36
     named `s2-…` after the mirror).

### Open items after the review

8. With a company column the audit list is the stacked row from 768 to 1279 px (F11-23): readable, and
   longer than a table. A two-line row for those widths would be the next step if the platform's log is
   read much on small laptops.
9. The editor's page is longer with every text's variables in view (F11-28).
10. axe's `target-size` (WCAG 2.2, not in the suite's default rules) reports a small control that stands
    half under a sticky action bar at a given scroll position; this holds for every page with such a bar.
11. A text saved before a rule shows its problem in the editor (F11-42), but the list of e-mails still
    counts it among the changed texts: the list does not say that one of them is not in use. No such
    text exists unless a database holds texts from before the rules.
12. The E2E log shows the browser's "wasm streaming compile failed … falling back to ArrayBuffer
    instantiation" a few times while the reception scenarios run: the QR decoder's loader says so when
    its download is cut off (a page that leaves or closes while it loads), and the dev server relays
    the page's console. No test fails on it. This is read from the messages and their place in the
    log, not from a trace.
13. *For the backend.* No backend bug was found in this round, and no backend file was edited. The two
    decisions on the interim report stand: English says "default text(s)" (F11-48), and the mark before
    a test e-mail's subject stays the leading language's.
