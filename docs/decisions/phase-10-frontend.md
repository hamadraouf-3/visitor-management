# Phase 10 — Frontend foundation: Mawdoo3 brand, Arabic and English, direction C

Date: 2026-10-07 · Scope: `frontend/package.json` and the lockfile, `frontend/index.html`, `frontend/public/**`,
`frontend/scripts/generate-icons.mjs`, `frontend/src/index.css`, `src/i18n/**` (new), `src/brand.ts` (new),
`src/constants.ts`, `src/main.tsx`, `src/layouts/**`, `src/components/**`, `src/hooks/useDocumentTitle.ts`,
`src/utils/**` (formatting), `src/api/client.ts` and `src/api/auth.ts` (error messages, the preferences call),
`frontend/e2e/support/**`, `frontend/e2e/i18n-smoke.spec.ts` (new), and the tests of all of these. Feature
screens (`src/features/**`, `src/pages/**`) were left to the feature phase apart from the compile fixes listed
in F10-15. Contract: `docs/initial-assessment.md` revision 2, §10, and the phase 10 shared contract (below).

The product becomes «موضوع» (Arabic) / «Mawdoo3» (English), with its logo, in Arabic and English (user
switchable, Arabic by default for the demo company), in the visual direction C "Bold Modern" with the logo's
teal instead of C's lime. This phase builds the foundation the feature screens are translated and restyled on:
the i18n infrastructure, the design tokens, the UI kit, the app shell and the brand assets.

**Shared contract with the backend** (implemented on both sides): `Me.user.preferred_language` ('ar' | 'en' |
null), `Me.company.name_ar` (string | null) and `Me.company.default_language` ('ar' | 'en');
`PATCH /api/v1/auth/preferences {"language"}` → the updated `Me` (CSRF, allowed during a forced password change);
`CompanySettings.name_ar` / `default_language`. The backend builder regenerated `src/types/api.ts` and
`backend-contract.json` during this phase; the frontend reads the new fields through `src/i18n/session.ts`,
which checks every value at run time, so a `Me` without them (an older API, a mocked one) still works.

Checks at the end: `npm run typecheck` and `npm run lint` pass (no warning); `npm test`: 111 files, 1212 tests
passed; `npm run build` (into a scratch `--outDir`) passes; `npm run e2e:typecheck` passes; the full Playwright suite
(`npm run e2e -- --retries=0`, ports 5199/8700, database `vms_e2e`, against the backend builder's phase 10 API):
214 passed, 12 skipped (the 10 skipped by their project conditions before, and the Arabic smoke spec's 2 on the
tablet), 0 failed, 5.5 minutes. An earlier full run had 4 failures: one page reloaded by the dev server because a file
under `frontend/` was edited during the run (Tailwind rescans every source file), and three flow specs that read the
e-mails' single inline image, which the backend's new e-mail logo made two (fixed in the outbox helper, F10-15).
The production build was also checked in a `vite preview` server with the security headers: no CSP report, the
three self-hosted fonts and the logo load, `dir`/`lang`/title follow the language.

## Internationalisation

F10-1. **i18next + react-i18next.** — i18next 26 and react-i18next 17 (about 16 KB gzip together, in the
start-up `app` chunk). Chosen over a home-made `t()` because Arabic needs every CLDR plural category
(zero, one, two, few, many, other) and i18next resolves them with `Intl.PluralRules`; it also gives namespaces,
interpolation, a language fallback and type-checked keys (TypeScript resource augmentation) without code of
our own to maintain. One instance (`src/i18n/index.ts`, `createInstance()`), initialised synchronously with
every catalog (`initAsync: false`, `react.useSuspense: false`), in the device's language, so the first render is
already in it. `main.tsx` and the test render helper wrap the app in `I18nextProvider`. Components use
`useTranslation()`; plain functions (formatters, the API client) use `i18n.t(…, { lng })` and
`currentLanguage()`. `fallbackLng: 'en'`: a key missing in Arabic (which the catalog test forbids) would show
English rather than the key.

F10-2. **Catalogs: JSON per namespace and language, English is the type source.** — `src/i18n/locales/{ar,en}/`:
`common` (shell and UI kit), `errors` (every error code), `auth` (sign-in chrome, password policy), and empty
`reception`, `visits`, `visitors`, `history`, `inside`, `reports`, `admin`, `pass` for the feature phase. Both
languages are bundled (`resources.ts`): a few kilobytes now, no download when switching, and the service worker
precaches them with the app. If the feature catalogs grow large, the non-active language can become a lazy
chunk without changing any call site. `i18next.d.ts` declares `CustomTypeOptions.resources` as the English
catalogs: `t('nav.open')`, `t('codes.NOT_FOUND', { ns: 'errors' })` and `t('combobox.results', { count })` are
type-checked; a misspelt key fails `npm run typecheck`. English keeps the current English UI text verbatim
(tests and E2E selectors depend on it); only the brand changed.
   - `src/i18n/catalogs.test.ts`: every namespace exists in both languages; Arabic has exactly the English keys
     (no missing, no stale ones); every plural key has the English forms (one, other) and all six Arabic forms;
     no text is empty; each Arabic text uses the variables of its English text (a plural form may spell its
     number, "حرفين"); every error code of `backend-contract.json` and of `ApiErrorCode` (plus the client's
     `NETWORK_ERROR`, `UNEXPECTED_RESPONSE`) has a message in both languages; Arabic texts contain no Latin
     letters except "UTC".

F10-3. **Which language: the account, else the company, else the device.** — `src/i18n/languages.ts`,
`session.ts`, `useLanguage.ts`.
   - Signed in: `user.preferred_language`, else `company.default_language`. Before sign-in: the language this
     device last used (`localStorage['vms.language']`), else the first of `navigator.languages` the app speaks
     (`ar-*` → Arabic, `en-*` → English), else Arabic. *(Interpretation: the contract's "navigator.language
     starting with 'ar', else 'ar'" read literally always gives Arabic; an English browser now gets English
     until someone chooses, which is what the E2E suite and English-speaking visitors to the sign-in page
     need. Arabic stays the default for every other browser language.)*
   - `LanguageController` (mounted once in `RootLayout`) applies the session's language whenever *it* changes
     (sign-in, first load, a change saved elsewhere). It reads the cached `['auth','me']` without observing the
     query, so public pages (the visitor pass) still send no request. Only a change of the session's language
     is applied: a heartbeat that still names the old preference while a switch is being saved does not
     switch the screen back.
   - `useChangeLanguage()` switches at once (optimistic). Signed in it calls `PATCH /auth/preferences` and puts
     the answer in the `me` cache; on failure the previous language comes back and a danger toast says "Could
     not save your language" with the translated error. Signed out it only remembers the choice on the device.
   - Every applied language is also stored on the device, so a reload (or the sign-in page after signing out)
     starts in it without a flash. On a shared tablet the sign-in page therefore shows the last user's
     language, which any user changes with one tap.
   - `<html lang dir>` follow the language (`i18n.on('languageChanged')`); `index.html` starts as
     `lang="ar" dir="rtl"`, the product default. The document title is "<page> · Mawdoo3" or "<page> · موضوع"
     (`useDocumentTitle`, which follows a switch).

F10-4. **Hard-coded text and physical sides are tests, scoped per area.** — `src/i18n/hardcodedText.test.ts`
parses each checked source with the TypeScript compiler and reports JSX text, string literals rendered as JSX
children (also through `? :`, `&&`, `??`) and string values of the attributes people read or hear
(`aria-label`, `title`, `placeholder`, `alt`, `label`, `description`, `hint`, `legend`, …) that contain a letter.
`src/i18n/logicalProperties.test.ts` reports Tailwind classes that name a physical side (`ml-`, `pr-`, `left-`,
`text-right`, `rounded-r-`, `border-l`, …; `left-1/2` centring is allowed). Both check `components/`,
`layouts/`, `i18n/` (text) and the pages this phase touched; each has a self-check on a sample. The feature
phase adds each feature folder and its pages to the two `CHECKED` lists as it translates them. A test was
preferred to a lint rule: oxlint has no rule that understands the attribute list, and the per-area opt-in is
one line.

F10-5. **Dates in the Levantine calendar words, every number in Latin digits.** — `src/utils/datetime.ts`,
`number.ts`, `duration.ts`, `dateRange.ts`, `text.ts`, `forms.ts`, `passwordPolicy.ts`. Every formatter takes
an optional last `language` argument (default: the current one), so existing calls keep compiling and follow
the UI language.
   - English keeps the app's fixed formats ("Mon, 5 Oct 2026", "09:30", "1h 37m"), byte for byte.
   - Arabic dates come from `Intl.DateTimeFormat('ar-JO-u-nu-latn', { timeZone })`: the month names used across
     Jordan and the Levant ("كانون الثاني … تشرين الأول … كانون الأول", as in the mockups), the full weekday,
     Latin digits: "الثلاثاء، 6 تشرين الأول 2026", "… 2026، 09:30", "… الساعة 09:30". Bidi marks some `Intl`
     outputs carry are removed (the paragraph lays the text out).
   - **Latin digits everywhere** (`-u-nu-latn`): times, dates, counts, codes, phone numbers and percentages
     read the same in both languages, match what people type and what the scanner, e-mails and printed
     passes show, and the KPI numerals use Space Grotesk. The mockups do the same.
   - Times stay 24-hour "HH:mm". A time range "09:00–10:30" inside Arabic text is laid out by the bidi
     algorithm with the start on the right, which is how it reads right to left; it is not forced
     left-to-right. Phone numbers are (still) a left-to-right override (`PhoneNumber`), e-mail addresses an
     LTR isolate (`EmailText`), request references `dir="ltr"`.
   - New: `formatShortDate` ("Mon, 5 Oct" / "الاثنين، 5 تشرين الأول"), `formatRelativeTime` ("3 hours ago" /
     "قبل 3 ساعات", `Intl.RelativeTimeFormat`, largest whole unit), `formatNumber`, `formatPercent`.
     `relativeDayLabel` says "اليوم / غدًا / أمس"; `formatTimeZoneName` says "توقيت عمّان (UTC+3)" (Arabic
     place names of the region and major cities in `i18n/timeZonePlaces.ts`; others keep the English place);
     durations "1 س 37 د", "أقل من دقيقة"; character counts and length messages use Arabic plurals.
   - A component that only formats dates must still re-render on a switch: it calls `useTranslation()` or
     `useLanguage()` (every translated component does anyway).

F10-6. **Error messages: the server's English text in English, the catalog's text by error code in Arabic.**
— `src/i18n/errorMessages.ts`, used by `getErrorMessage` (so every `ApiErrorMessage`, `LoadErrorAlert`, toast
and form-level error follows). In English the server's own message is shown, as before: it is written for end
users (§8.2) and is sometimes more specific than the code ("A department with this name already exists." for
`CONFLICT`); the English catalog holds the default texts. In Arabic the `errors:codes.<CODE>` text is shown; a
response that never was an API answer says the service is unavailable (502/503/504) or something went wrong;
a code the catalog does not know keeps the server's message. Not translatable here: the per-field messages of a
422 (`details.fields`) and the scan warnings carry no code, so they stay English in the Arabic UI until the API
sends codes for them (open issue, hand-over).

F10-7. **Status labels are read when rendered.** — `VISIT_STATUS_META`, `INVITATION_STATUS_META`,
`INVITATION_STATUS_LONG_LABELS` and `PASS_STATUS_META` keep their shape, but each `label` is a getter that reads
the catalog, so every existing `META[status].label` in a feature is already in the UI language on its next
render. `StatusBadge` calls `useTranslation()` so it re-renders on a switch.

## Brand

F10-8. **«موضوع» / «Mawdoo3» everywhere; "Visitor Management" nowhere a person sees.** — `src/brand.ts`
(`BRAND.name`, the three logo files, the app icon; `brandName(language)`) replaces `APP_NAME`.
   - The logo (462 × 149, transparent) is in `public/brand/`: `logo-teal.png` (light surfaces: sign-in, the
     visitor pass, error pages), `logo-white.png` (the dark shell), `logo-ink.png` (print, single colour). Public
     paths, so the backend's e-mails can use the same files. `components/app/BrandLogo.tsx` renders it, sized
     by height, with the brand's name in the UI language as its text alternative (or decorative).
     `BrandMark` is now the square app icon (used by the printed pass until the feature phase moves it to the
     wordmark).
   - App icons are generated from the white logo by `npm run icons` (`scripts/generate-icons.mjs`, Node
     built-ins only: PNG decode with zlib, 4 × 4 supersampled bilinear resampling with premultiplied alpha,
     PNG encode; deterministic): `favicon-32.png`, `favicon-48.png`, `icon-192.png`, `icon-512.png` (rounded
     teal tile), `icon-maskable-512.png` (full bleed, the wordmark's corners inside the 40 % safe circle),
     `apple-touch-icon.png` (180, full bleed). The old SVG favicon and icon are removed (the wordmark has no
     vector source).
   - `manifest.webmanifest`: "موضوع | Mawdoo3", short name "Mawdoo3", `lang: ar`, `dir: rtl`, bilingual
     description, theme colour the shell navy, background the canvas. `index.html`: the same title and
     description, PNG favicons, a bilingual `<noscript>`. The service worker's header comment and the E2E
     e-mail sender ("Mawdoo3 <no-reply@demo.local>") follow.
   - `constants.ts` keeps only `PASS_INSTRUCTIONS` (used by the pass screens, which the feature phase moves to
     the `pass` catalog). The authorised-use notice moved to `auth:signIn.authorisedUse`.

## Design system (direction C with the logo teal)

F10-9. **Tokens: a navy shell, a light content area, a dark reception surface, the teal in accessible steps.**
— `src/index.css`, every ratio noted beside its token.
   - Brand teal #169897: ink text on it 5.38:1, white only 3.52:1. Hence two accents: on the light content
     area the accent is teal 600 #0f7c7b (white text 5.01:1; hover 700 #0b6564, 6.86:1; links 700 on white
     6.86:1; focus ring 600, 5.01:1 on white and 4.56:1 on the canvas); on dark surfaces the accent is the logo
     teal itself with ink text, as C's bright accent (the current page in the navigation, primary buttons
     on the reception screen). Teal steps 50–800 are tokens (`brand-*`).
   - Light content: canvas #f3f4f7, white surfaces, ink #0b1020 (18.93:1), secondary #3a4152 (10.20:1), muted
     #5a6275 (6.11:1, 5.55:1 on the canvas), placeholder #6b7385 (4.76:1), control borders #7c8599 (3.70:1).
   - **`theme-dark`** re-points the same token names to C's dark values for a subtree (screen only: on paper
     everything is black on white): the shell (sidebar, phone top bar, drawer) and, in the feature phase, the
     reception tablet. Every kit component therefore works on both without variants. The semantic colours are
     declared with `@theme static`, so every variable exists for the override.
   - Tones (alerts, toasts, badges, tile icons) and **visit status chips** in their own palette that differs in
     lightness as well as hue: Checked in solid green with white text (5.29:1), No-show saturated amber,
     Checked out mid grey, Scheduled pale blue with a ring, Cancelled white with a red ring.
   - Type: Readex Pro (Arabic and Latin) for everything, Space Grotesk (`font-numeric`) for KPI numerals,
     counts and codes. Both **self-hosted** from `@fontsource-variable/*` (variable weight, one file per
     subset), declared in `index.css` with the Arabic and Latin subsets only (U+0600… and U+0000-00FF…): 3
     WOFF2 files, 76 KB, bundled and precached. Letters outside them (Latin Extended) fall back to the system
     font. Scale: page title 34 px bold (26 px on phones, `text-page`/`text-page-sm`), KPI 52 px (36 px on
     phones, `text-kpi`/`text-kpi-sm`); radii: cards 18 px (`rounded-card`), panels 20, controls 12
     (`rounded-control`), navigation items 10 (`rounded-item`); flat cards with hairline edges, `shadow-pop`
     for popovers.

F10-10. **Right to left by logical properties.** — Every kit and shell class names sides by the reading
direction (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `text-start`/`text-end`, `rounded-e-`); the test of F10-4
keeps it so. Directional icons (back and next chevrons, the stat tile's link chevron, sign out, the "Checked
out" status icon) carry `mirror-rtl` (a utility: `scale: -1 1` under `[dir=rtl]`); icons of things (a clock, a
phone) are not mirrored. Tabs move with the arrow keys in the reading direction (Left is "next" in Arabic,
WAI-ARIA APG); the drawer opens from the inline start; menus align by start/end; the scroll shadows work in
either direction; e-mail, URL and phone inputs stay left to right inside Arabic forms. Table headers are aligned
to the start explicitly (a header cell centres its text otherwise, which `text-left` on the table used to
mask).

F10-11. **UI kit restyled to direction C, same APIs and behaviour.** — Additions are optional props only.
   - Button: 44 px tall (`md`), 12 px radius, semibold; primary teal 600 / white; new `dark` variant (C's ink
     button). Secondary keeps the 3.70:1 border (C's lighter border would not mark the control; the reception
     tests rely on the outlined style). Inputs, selects, comboboxes, search: 44 px, 12 px radius, logical
     paddings; the combobox toggle and the clear and show-password buttons are 44 px wide on every pointer.
   - Tabs: C's segmented control on a track; the selected segment is raised (white here, teal on dark) with a
     bolder label, its focus ring drawn in its text colour (ink on white 18.93:1, on teal 5.38:1). The phone
     grid layout and every keyboard rule are unchanged.
   - Badge / StatusBadge: compact chips (24 px, 12 px semibold, fits the 144 px status columns), visit statuses
     in their own palette (F10-9), `colorClassName` and `mirrorIcon` props.
   - StatTile: C's KPI tile (label, tinted icon tile from `sm`, 52 px Space Grotesk numeral, hint), new
     `variant="emphasis"` (the dark tile with the number in teal, for the one figure a screen is about). The
     DOM keeps label and value inside one element per tile (the feature tests read it so).
   - PageHeader: 34 px title, optional `eyebrow`; Card, EmptyState, Alert, Toast, Dialog, Drawer, Menu, Table,
     FilterPanel, StatusFilter, Pagination, SuggestionChips, CopyButton: C radii and weights, every string of
     their own translated (`common`). Drawer gained `header` and `panelClassName`; Menu items `mirrorIcon`.
   - Kept: every focus ring (2 px, 2 px out, on all four sides; the two-tone media ring), 44 px touch targets,
     the sticky action bar's measured scroll padding, the toast regions, the modal focus trap.

## App shell

F10-14. **Direction C's navigation shell.** — `layouts/AppLayout.tsx`, `Navigation.tsx`, `UserMenu.tsx`,
`CenteredLayout.tsx`, `RootLayout.tsx`, `components/app/LanguageSwitcher.tsx`.
   - Desktop (lg+): a dark navy sidebar on the inline start (left in English, right in Arabic), 256 px as
     before: the white logo and the language switch, the company block (initial, the company's name in the UI
     language, "Amman time (UTC+3)" / "توقيت عمّان (UTC+3)"), the grouped navigation (the current page a teal
     pill with ink text), and the account menu as C's user block (avatar, name, roles). Tablet and phone: a
     dark top bar (menu button, logo, language switch, account menu) and a dark navigation drawer.
   - Navigation labels are translated by path in the shell (`NAV_LABEL_KEYS`); a feature's own `label` remains
     the fallback for a path not listed.
   - The language switch (ع / EN) is one button that offers the other language under its own name in its own
     script (`lang`); its accessible name ("English", "العربية") contains the visible label (WCAG 2.5.3). It is
     in the shell, on the sign-in and error pages (`CenteredLayout`, in a banner landmark at the inline end),
     and works during a forced password change.
   - Public pages (sign-in, reset, errors) show the teal logo; the visitor's pass page too (F10-15).

## Tests and E2E

F10-12. **The existing suites read English; nothing of theirs changed but the brand.** — Unit tests: the setup
starts every test in English and clears the stored language; `makeMe` and the settings fixtures give the
company `default_language: 'en'`, `name_ar: null` and the user `preferred_language: null`. Tests that asserted
"· Visitor Management" now assert "· Mawdoo3". E2E: the global setup (`pinEnglish`) sets both companies'
`default_language` to English through their administrators (only when the API has the field) and writes the
device language `en` into every storage state; contexts made by `open()` have the `en-US` browser locale. The
seed keeps Arabic as the companies' default, as the product does; only the test run is pinned.

F10-13. **One Arabic smoke spec.** — `e2e/i18n-smoke.spec.ts`, desktop and phone (the tablet is skipped): the
sign-in page switches to Arabic (`dir=rtl`, `lang=ar`, title, the loaded teal logo named «موضوع», Readex Pro
loaded, the switch at the inline end), survives a reload, passes axe-core, and switches back; a user created
for the test switches the signed-in shell to Arabic (the PATCH answers 200 and `/auth/me` says `ar`), the white
logo and Arabic navigation and account menu show, the sidebar (desktop) or the drawer (phone) is on the right,
axe-core passes in Arabic, a reload stays Arabic, and switching back saves English. Seeded accounts are never
switched (every other spec reads them in English).

F10-15. **Changes outside this phase's files (compile fixes and one-line brand fixes).** — The regenerated
`types/api.ts` made the new fields required, so these fixtures gained them (English, no Arabic name):
`src/test/api.ts` (`makeMe`), `src/features/admin/testRoutes.ts`, `src/features/reception/testing/receptionFixtures.ts`,
`src/features/admin/settingsForm.test.ts`, and the mocked `Me` of five E2E specs (`camera-focus-ring`,
`history-layout`, `inside-touch-targets`, `reception-axe-narrow`, `toast-placement`). `APP_NAME` and
`AUTHORISED_USE_NOTICE` left `constants.ts`, so `pages/LoginPage.tsx` takes its title and notice from the
`auth` catalog and `pages/PassPage.tsx` shows the teal logo instead of the old mark and name. `auth/RequireAuth.tsx`
translates its loading label. Test updates for the brand and the restyle: `LoginPage.test` (notice text),
`PassPage.test` (the logo is an image too: the "no QR code" checks name the QR code), three page tests (document
title), `StatusBadge.test`, `Table.test` and `Combobox.test` (status chip colours, `text-end`, logical sides).
   - `e2e/support/outbox.ts`: the backend's e-mails now carry the brand logo as a second inline image
     (`cid:brand-logo`, backend B10-6) before an invitation's QR code. Three flow specs read "the" inline image
     (`inlineImages(message)[0]`, a length of 1) and failed against it. `inlineImages` now returns the content
     images only (the logo is the layout's); `brandLogoImage(message)` returns the logo. The specs are unchanged.

F10-16. **Size.** — The start-up `app` chunk grew from 54 kB raw / 17 kB gzip (phase 9) to 132 kB / 42.5 kB: i18next
and react-i18next, both languages' catalogs, the formatting and shell code. The stylesheet is 66 kB / 12.8 kB
gzip. The three font files are 76 kB and load only for the characters on screen (`unicode-range`); the logos 37 kB,
the icons 54 kB. All are precached by the service worker with the rest of the build.

## Integration of the frontend and backend foundations (2026-10-07)

The two builders' work was checked together against the shared contract: `Me.user.preferred_language`,
`Me.company.name_ar` and `default_language`, and `CompanySettings.name_ar` / `default_language` in
`src/types/api.ts` match the regenerated `backend-contract.json` (`api.contract.test.ts` passes, and the
backend's snapshot staleness test passes); the language switch calls the real `PATCH /auth/preferences`;
the language rules are those of F10-3.

F10-17. **The company's displayed name comes from one hook, `useCompanyName(company)`.** — The contract
says the UI shows `name_ar` when it is Arabic and `name_ar` is set, else `name`. The shell followed it
(`companyDisplayName`), but six feature screens still read `me.company.name` and showed «Mawdoo3» in the
Arabic UI: the admin dashboard's description, the history page's description, the printed evacuation list,
the printed report's header and the printed visitor pass (invitation success and visit detail).
`src/i18n/useLanguage.ts` now exports `useCompanyName(company)` (the display rule, re-rendering on a switch;
`''` before the session is known, so it can be called before an early return), and those screens use it.
Feature screens name the company only through it. Test: `InsidePage.test.tsx` "names the company by its
Arabic name on paper when the UI is Arabic", which fails with `me.company.name`.

F10-18. **The E2E English pin is checked.** — `pinEnglish` (global setup) no longer skips a company whose
settings lack `default_language` (the tolerance for an API from before phase 10): it patches both companies
and fails the setup unless the API answers `default_language: 'en'`, so a regression cannot leave the
English specs facing an Arabic UI.

Brand metadata outside the UI: the frontend image's OCI description and header comment
(`frontend/Dockerfile`), the smoke test's `--help` line (`deploy/verify/smoke_test.py`) and the documented
`EMAIL_FROM` default in the root `README.md` (`Mawdoo3 <no-reply@localhost>`, the backend's actual default)
now name Mawdoo3.

**Gates after the integration.** Backend: `ruff check` clean; `ruff format --check` 245 files formatted;
`mypy` clean (132 files); `pytest` 2646 passed, 3 skipped (250.7 s); `pytest --committed-first` 2646 passed,
3 skipped (328.2 s). Frontend: `typecheck`, `lint` (0 warnings) and `e2e:typecheck` pass; `npm test` 111
files, 1213 tests passed; `npm run build` (scratch `--outDir`) passes. Full Playwright suite
(`npm run e2e -- --retries=0`): 214 passed, 12 skipped, 0 failed (6.0 min). Deployment:
`unittest discover -s deploy/verify` 27 OK; `check_release_tree.py` OK (837 files); the nginx header check
in sync (7 headers).

**Live check.** An API on 8930 and Vite on 5930 against a throwaway database (migrated to 0011, `seed-demo`,
dropped afterwards), signed in as `admin@demo.local`: 35 checks passed. The sign-in page of an `en-US`
browser is English and of an `ar-JO` browser Arabic; after sign-in the shell follows the company default
(Arabic, right to left, title "… · موضوع", the white logo loaded on the right, the company block «موضوع»);
the switch saves `en` (PATCH 200), mirrors the shell (logo on the left, «Mawdoo3»), survives a reload and
applies in a fresh browser after sign-in; switching back saves `ar`. `PATCH /auth/preferences` answers 422
`VALIDATION_ERROR` on `language` for `fr` and 403 `CSRF_FAILED` without the header. An invitation through
the outbox has the subject «زيارتك إلى موضوع يوم الأربعاء، 7 تشرين الأول 2026 | Your visit to Mawdoo3 on …»,
both inline images (`cid:brand-logo`, `cid:visitor-pass-qr`), an Arabic right-to-left section first, and no
"Visitor Management". Tablet (820 px): the dark top bar with the logo, the drawer from the right in Arabic,
the switch and its persistence. No script error on the pages.

## Review fixes: the whole app in Arabic, the logo and the layout details (2026-10-07)

The design review of the integrated phase found every feature screen still English inside the right-to-left
shell, the pass and printed sheets without the logo or cut off in Arabic, and a set of layout details. All
were fixed at their cause, each with a regression test. Scope: frontend files; in the backend only the e-mail
catalog (`backend/app/email/i18n.py`) and the tests that quote it. English UI text is unchanged (the existing
tests read it), apart from the brand.

F10-19. **Every screen reads the catalogs; the source tests cover all of `src/`.** — The feature screens
(`features/**`, `pages/**`, `auth/roles.ts`, `scanner/cameraErrors.ts`, `useCameraStream.ts`) take every text
from the catalogs, including page titles, chart axes and readouts, table captions, toasts, dialog texts,
validation messages and the accessible names of controls. `src/i18n/hardcodedText.test.ts` and
`logicalProperties.test.ts` now scan every source under `src/` (tests excepted), so a new screen cannot ship
English or a physical side into the Arabic UI; their `ALLOWED` maps (a file and the reason) are empty.
`src/constants.ts` is gone: `PASS_INSTRUCTIONS` is the `pass` catalog's instructions list.
   - Text built outside a component follows the language when it is read: `lazyTexts({...})`
     (`src/i18n/lazyTexts.ts`, getters) replaced the module-level strings (`SCHEDULE_MESSAGES`,
     `REASON_MESSAGES`, `INVITE_MESSAGES`, `WALK_IN_MESSAGES`, `SEARCH_NOTES`, `REPORT_TEXTS`, label tables),
     or a function (`failedInvitationAdvice()`, `previousDayLabel()`). `SEARCH_NOTES` and `REPORT_TEXTS` live
     in modules of their own (`reception/searchNotes.ts`, `reports/reportTexts.ts`), so component files export
     only components.
   - Codes from the API (audit actions and metadata, scan warnings, enum values) are looked up with
     `catalogText(ns, key, options)`, which returns null for a code the catalog does not know, so a newer
     server's code still reads sensibly (humanised in English). It checks the key with the same options it
     translates with: a counted key exists only as its plural forms, and without `count` the lookup missed them
     (found by `fieldMessages.test.ts`).
   - A sentence with elements inside (a count kept on one line, a link, an e-mail address) is one catalog
     sentence split around invisible markers (U+2063) by `withParts` (React nodes) or `textWithParts` (plain
     text with e-mail parts), so each language orders its own words and Arabic writes «و» against the next
     word.
   - The 422 field messages of the API carry no code (§8.2). `translateFieldMessage`
     (`src/i18n/fieldMessages.ts`, called by `resolveServerErrors`) maps every message the backend writes
     (exactly, or by pattern for counts, times and lists) to `errors:fields.*` in Arabic and keeps the server's
     words for a message it does not know. *Interpretation: matching English text is brittle; a code per
     field would be the proper contract (open item for the backend).*
   - The report's "No department" row (the API's English name for visits without one) is named from the
     catalog (`charts.departments.unassigned`). The password-reset request shows the catalog's confirmation in
     Arabic rather than the server's English sentence.
   - Catalog rules (`catalogs.test.ts`): Arabic has all six plural forms; the variables match (plural forms
     may drop `count` and `formatted`); Arabic has no Latin word but UTC and QR, so names, key names and
     e-mail examples are `{{variables}}`.

F10-20. **Right to left everywhere, charts included.** — The timeline's connector was `left-[5px]` and ran
down the far side of the Arabic timeline: it is `start-[5px]` (through the dots, on the right in Arabic).
Every other physical class went too (the camera frame's corners, the temporary-password field's button, the
reception row's menu, the password requirements' indent `ps-6`). The SVG charts take the UI's `direction`;
in Arabic time runs from the right and the value axis stands on the right: the geometry is laid out left to
right and mirrored, the marks and hit targets through `matrix(-1 0 0 1 width 0)`, the texts by their x and
never mirrored themselves; the arrow keys move the way time runs (`useChartCursor(..., { rtl })`). The bar
chart's bars grow from the right. Tests: `ColumnChart.test.tsx`, `BarChart.test.tsx`.

F10-21. **The pass page and printed sheets carry the logo, in the visitor's language.** — `PassPage` is in
Arabic or English with the language switch in its header (a visitor's own device: it remembers the choice),
the instructions list indented on the reading side (`ps-5`), the teal logo on screen and the ink (black) logo
on paper. The printed pass (`PassActions`) and the printed sheets' header (`PrintSheetHeader`: evacuation
list, report) show the ink logo at the inline end.

F10-22. **The Arabic evacuation list is no longer cut off on paper.** — The printable list undid the sidebar's
room with a physical `lg:print:-ml-64`; in Arabic the room is on the right, so the sheet was pulled 256 px past
the paper's left edge. The layout now drops the room itself on paper (`lg:ps-64 print:ps-0`) and the list
has no offset. Its cells are `text-start`, its columns and the printed-by line translated. New E2E spec
`e2e/evacuation-print-rtl.spec.ts` (desktop, API mocked, print media): the sheet has equal margins, every
cell lies on the page, the columns run from the right, the words are Arabic.

F10-23. **Company settings edit the Arabic name and the default language.** — The API had `name_ar` and
`default_language` (shared contract) but the form did not: "Arabic name" (optional, typed right to left,
`lang="ar"`; emptied, it is sent as null so the company name is used again) and "Default language" (a radio
group, each language named in its own script). Only changed fields are sent, as before.

F10-24. **The language chosen on the sign-in page is kept.** — Choosing a language before signing in, then
signing in to an account without a language of its own, used to switch to the company's default. The choice
is now noted for the tab (`sessionStorage['vms.language.chosen']`, set by the switch while signed out) and
taken by `LanguageController` at sign-in: for an account without a preference it is applied and saved
(`PATCH /auth/preferences`), so it holds on the next sign-in too. An account's own language still wins
(F10-3). The note is taken at every sign-in, used or not, so a choice never reaches the next person on a
shared tablet. Unit tests in `src/i18n/arabicUi.test.tsx`; the E2E smoke spec now signs in through the
Arabic sign-in page and checks the PATCH and `/auth/me`.

F10-25. **Layout details.** —
   - Tabs: the selected segment was white on a light grey track (1.2:1). It now has an inset 1 px ring in
     `--color-tab-indicator` (`#0f7c7b`: 5.0:1 on the segment, 4.2:1 on the track; WCAG 1.4.11 asks 3:1); in
     the dark theme the selected segment itself is `#169897`, 5.09:1 on the track. The track hugs its tabs
     (`w-fit max-w-full`) instead of stretching across the page; grid tabs fill the width on phones only.
   - The mobile drawer had two background utilities (`bg-surface` from the kit won over `bg-shell` by
     stylesheet order, a lighter navy than the bar): `Drawer` takes `surfaceClassName`, the shell passes
     `bg-shell`.
   - Status chips: `Badge` has `sm` (24 px, 12 px text) and `md` (28 px, 13 px text); visit statuses use `md`
     by default, invitation and pass statuses `sm`.
   - The sign-in page's language switch sits in the window's inline-end corner (a full-width header), not at
     the edge of a centred column.
   - Date ranges: each date input keeps at least 10.5 rem (`repeat(auto-fill, minmax(10.5rem, 1fr))`), so its
     placeholder clears the calendar button, and "To" wraps under "From" when both do not fit.
   - History: the Arabic date column is wide enough for the date and time on one line at 1280 px and up.
   - Favicon: the 16, 32 and 48 px icons show the logo's compact mark «ع» (cropped from `logo-white.png` by
     `scripts/generate-icons.mjs`), legible in a browser tab where the whole word was a smudge; the PWA and
     Apple icons keep the whole logo. `index.html` links the new 16 px icon.
   - Avatars: Arabic initials skip the article «ال» and are kept apart by a zero-width non-joiner (plain
     concatenation turned «ليلى الحسن» into «لا», the word "no").

F10-26. **Arabic wording.** — Printed sheets say who printed them without a gendered verb («الطباعة: {{name}}.»,
«تاريخ الإنشاء: …»). The visit statuses read the same everywhere («تم الدخول», «تم الخروج», «لم يحضر الزائر»).
Under a minute is «< 1 د». Tanween fath is written on the letter before the alif («مرحبًا», «أيضًا»,
«صالحًا»), in the UI catalogs and now in the e-mails too (`backend/app/email/i18n.py`, 13 strings; backend
test `test_arabic_texts_write_tanween_as_the_interface_does`; the e-mail tests that quote the greeting
follow).

**Gates.** Frontend: `npm run typecheck`, `npm run lint` (0 warnings) and `npm run e2e:typecheck` pass;
`npm test` 116 files, 1252 tests passed; `npm run build` (scratch `--outDir`) passes. The start-up `app`
chunk is 305 kB / 85.7 kB gzip (132 / 42.5 before): both languages' catalogs for every namespace (215 kB raw,
about 48 kB gzip), loaded up front by design (F10-1: no flash, works offline); loading only the UI language's
catalogs is a follow-up. Backend: the e-mail unit tests (370) and `test_email_languages.py` /
`test_preferences_api.py` (26) pass; `ruff check` and `ruff format --check` clean on the changed files.
Full Playwright suite (`npm run e2e -- --retries=0`, ports 5199/8700, `vms_e2e`): 215 passed, 14 skipped, 0 failed (6.0 min); the two more skips and the one more pass are the new print spec, which runs on the desktop only. The Arabic smoke spec passes on the desktop and the phone with its new sign-in-in-Arabic path.

**Live check.** An API on 8951 and Vite on 5951 against a throwaway database (`seed-demo` plus generated
visits; dropped afterwards), at 1440 and 1600 px, Arabic and English, every screen: in Arabic the only Latin
text left is data (names, the seeded English department names, e-mail addresses), "UTC", and a provider's
raw error inside the invitation's «تفاصيل تقنية»; titles are Arabic; the charts run from the right; the
timeline's connector joins the dots on the right; the selected tab is visible; the history date fits one line.

**Not done here.** A dark reception screen (the direction C mockup) stays a follow-up. The pass page follows
the visitor's device (and their switch); the invitation link carries no language hint.

## Brand pass: «زوار موضوع» / Mawdoo3 Visitors in mawdoo3.com's colours (2026-10-07)

Scope: `frontend/src/index.css`, `src/brand.ts`, `src/components/**`, `src/layouts/**`, `src/hooks/useDocumentTitle.ts`,
`src/i18n/useLanguage.ts` and the `common` and `auth` catalogs, `src/pages/{Login,ForgotPassword,ResetPassword,
ChangePassword,NotFound}Page.tsx`, `src/features/auth/**`, `frontend/index.html`, `frontend/public/{manifest.webmanifest,
sw.js}`, `frontend/README.md`, `frontend/e2e/support/env.ts`, `frontend/e2e/i18n-smoke.spec.ts`, and the tests of these.
The user's product decisions of 2026-10-07 supersede the foundation where they differ: (1) the product is «زوار موضوع» /
"Mawdoo3 Visitors", the company (tenant) stays «موضوع» / "Mawdoo3"; (2) mawdoo3.com's own colours, the navy shell
gone; (3) no explanatory notes; (4) direction C with turquoise and teal for its lime and navy; (5) Arabic and English.
This pass builds the brand, the tokens, the shell and the kit; the feature screens follow it next (their own notes,
the reception's dark screen).

F10-27. **Product, brand and company are three names.** — `src/brand.ts`: `BRAND.productName` {ar «زوار موضوع»,
en "Mawdoo3 Visitors"} and `productName(language)`; `BRAND.name` stays the brand (the logo's text alternative where the
logo stands alone, e.g. print); the company is a tenant named through `useCompanyName` (F10-17), never through the brand.
   - The product names: the document title ("<page> · Mawdoo3 Visitors" / "<page> · زوار موضوع", `useDocumentTitle`
     through `useProductName()`), the web manifest, `index.html` (title, description, `<noscript>`), and the lockup beside
     the logo on the sign-in and error pages, the shell and (next, the visits agent) the visitor pass.
   - `BrandLockup` (`components/app/BrandLockup.tsx`): the logo over the product's name, the logo decorative (`alt=""`)
     beside its name so the lockup reads once, as the product; `surface="shell"` white logo, `surface="page"` the teal
     logo, white in the dark scheme (`BrandLogo variant="auto"`, a `<picture>` with a `prefers-color-scheme: dark`
     source); sizes `sm` (top bar), `md` (sidebar, drawer), `lg` (public pages, centred). Phrasing content only, so it
     can be a heading's text (the drawer's title). The product's name is set in `font-display` (Space Grotesk for its
     Latin letters, direction C's wordmark face; Readex Pro for the Arabic).
   - `useProductName()` (`i18n/useLanguage.ts`) is the hook for a screen that names the product in its own words (the
     pass page).
   - `isBrandCompany(company)`: whether a tenant is the brand itself (its name or Arabic name is «موضوع» / "Mawdoo3",
     case, spacing and Arabic marks aside). The shell leaves that company's name out beside the logo (F10-29).
   - The web manifest: name "زوار موضوع | Mawdoo3 Visitors", short name «زوار موضوع» (Arabic is the default, `lang: ar`;
     10 characters fit a home-screen label), theme colour the side-nav teal #188086, background the canvas #f1f1f1.
     `index.html`: theme colour #188086, #0f3b3f in the dark scheme, `color-scheme: light dark`. The app icons keep the
     logo teal tile (they never used the navy; `npm run icons` unchanged). The E2E e-mail sender is
     "Mawdoo3 Visitors <no-reply@demo.local>" (the backend names its own default).

F10-28. **Tokens: mawdoo3.com's palette in accessible steps; four token sets, every pair computed and tested.** —
`src/index.css` notes each ratio beside its token; `src/designTokens.test.ts` parses the file and checks every text pair
(≥ 4.5:1) and every boundary, indicator and focus pair (≥ 3:1) in each set, so a token edit cannot break contrast
silently. mawdoo3.com's colours (taken from its stylesheet): turquoise #27b5bb, dark teal #1d8387, side-nav teal
#188086, theme #009999, light turquoise #49cbd2, slate #33444e, yellow #f7b916, greys #f8f8f8 / #f1f1f1; logo #169897.
   - White reads only on the side-nav teal and darker: on #188086 4.70:1, on #1d8387 4.52:1, on the logo teal 3.52:1, on
     #009999 3.49:1, on turquoise 2.50:1. Hence: primary buttons, links and focus in #188086 (white text 4.70:1; ring 4.70:1
     on white, 4.16:1 on the canvas), hover and link text one step darker (#136a6f: white 6.33:1, 5.60:1 on the canvas);
     turquoise, light turquoise and yellow only as fills behind ink text (6.18:1, 7.90:1, 8.74:1), indicators, chart
     marks with labels and large accents.
   - **Light** (content area): canvas #f1f1f1 and table headers #f8f8f8 (mawdoo3's greys), white surfaces; text in the
     slate family: fg #1c262b (15.42:1; 13.66:1 on the canvas), secondary #33444e (mawdoo3's slate, 10.11:1), muted
     #4d616c (6.48:1; 5.73:1 on the canvas), placeholder #627883 (4.63:1), control borders #718691 (3.80:1 / 3.37:1).
     New: `attention` (#f7b916 with ink text: what needs action), `highlight` (#49cbd2 with ink text: the user's avatar,
     live dots), `selection` (text selection in light turquoise), `emphasis` (direction C's dark tile: ink here),
     `row-highlight` (#f0f9f9: a highlighted row, fg 14.41:1), `chart-1…3`, `chart-muted`, `chart-grid` (series 1 the
     teal 4.70:1; turquoise 2.50:1 and yellow 1.76:1 only with a label or legend naming the mark).
   - Tones and status chips re-checked on the new surfaces: info in mawdoo3's link blue (#185c91, 6.28:1), success
     #0c6a3f, warning #7a5300, danger #b4232a, neutral slate; chips: Scheduled pale blue, Checked in solid green
     (#137a4a, white 5.37:1; hue 153° kept apart from the teal's 183°), Checked out grey, Cancelled white with a red ring,
     No-show mawdoo3's yellow with ink text (8.74:1). Tabs: the selected white segment with a teal edge (4.70:1 against it,
     3.85:1 against the track), its focus ring in ink (15.42:1). Shadows and overlays in the slate, never navy.
   - **Dark** (`theme-dark`; the whole app in the dark colour scheme): a deep slate/teal family from #33444e: canvas
     #101619, surface #182126, raised #1f2a30, fg #eef2f4 (14.51:1), muted #99a9b2 (6.75:1); the accent is turquoise with ink
     text (7.31:1; 6.55:1 against the surface), links and focus light turquoise (8.93:1, 8.37:1), the selected tab
     turquoise on a raised well (6.11:1), danger buttons #d6383f (white 4.67:1), the green chip bright with ink text
     (8.08:1). The emphasis tile is ink in light, deep teal #0f3b3f in the dark scheme (turquoise numeral 7.90:1 / 6.26:1).
   - **Teal shell** (`theme-shell`): background #188086; only pure white reads on it (even #f6f8f9 is 4.41:1), so every
     text is white and the hierarchy comes from size and weight; darker teal steps are its cards (#146f74, white 5.91:1),
     hover (#116166, 7.18:1) and menus (#0f5357, 8.77:1); the switch's outline #cdeef0 (3.82:1); the current page a white
     pill (4.70:1 against the shell) with teal text (6.33:1); the focus ring white (4.70:1).
   - **Deep shell** (`theme-shell-deep`; the shell in the dark scheme and around a dark screen): #0f3b3f, white 12.23:1,
     muted #a9d8db (7.88:1), the current page a turquoise pill (4.90:1 against the shell) with ink text (7.31:1), focus
     light turquoise (6.26:1).
   - Contract kept: every semantic token name the feature screens use is still there (`bg-shell`, `bg-ink`, `brand-*`,
     tones, `status-*`, `media`); `--color-on-brand` went (only the old navigation used it). The `theme-dark` utility
     kept its name and was re-pointed to the deep slate family, so the reception screen and any dark panel use it as
     before. The camera's media tokens are the darkest slate (#0e1316), its two-tone ring unchanged.

F10-29. **The shell in Mawdoo3 teal, the brand once.** — `layouts/AppLayout.tsx`, `Navigation.tsx`, `UserMenu.tsx`.
   - Sidebar (lg+), phone and tablet top bar and the navigation drawer are `theme-shell bg-shell`: mawdoo3's side-nav
     teal, as one surface (the drawer has one background utility, F10-25). The sidebar opens with the lockup (white
     logo over «زوار موضوع») and the language switch; the top bar with the menu button and the small lockup; the
     drawer is named by the product (its title is the lockup).
   - The company block (initial, company name, "Amman time (UTC+3)") is gone: beside the logo it repeated the brand for
     the Mawdoo3 tenant, and the time zone is the kind of note decision 3 removes. The company is named in the account
     menu's header (name, e-mail, roles, company) always, and in the sidebar's user block under the roles when it is not
     the brand's own (`isBrandCompany`), so a user of «Other Corp» always sees whose data they are in and Mawdoo3's
     users never see «موضوع» twice.
   - Navigation: white labels, hover darkens the teal, the current page a white pill with teal text and a bolder label
     (`bg-accent text-on-accent`, which the shell themes re-point), the white focus ring drawn on the shell around it.
     The user block: a light turquoise avatar with ink initials (`Avatar tone="highlight"`), name, roles.
   - Dark screens: a route declares `handle: DARK_SURFACE_HANDLE` (`layouts/shellSurface.ts`, `useShellSurface()`
     reads the deepest match). The layout then draws the deep shell and puts `data-surface="dark"` on its root;
     `body:has([data-surface='dark'])` applies `theme-dark` to the body, so the page and everything it opens on top of
     itself (dialogs, toasts, the drawer, portals on `<body>`) are dark, edge to edge, as direction C's reception tablet.
     The reception route itself is the reception feature's to mark (next stage).

F10-30. **The dark colour scheme.** — `@media screen and (prefers-color-scheme: dark)` applies the dark set to `:root`
(`@apply theme-dark`) and the deep shell to the shell; print is never affected (screen only). The public pages' logo
follows (`variant="auto"`). The feature screens use semantic tokens only (README), so they follow without changes; the
printed pass and sheets keep their own black on white. Playwright and the E2E suite run in the light scheme.

F10-31. **Direction C's kit for the feature screens.** — New, exported from `components/ui`:
   - `Avatar({ name, size: 'sm'|'md'|'lg', tone: 'neutral'|'highlight'|'emphasis' })`: initials tile (decorative).
   - `IconTile({ icon, tone, size: 'sm'|'md'|'lg', mirrorIcon })`: the tinted icon square of KPI tiles and list rows.
   - `CountBadge({ children: number | node, tone: 'neutral'|'attention'|'accent' })`: Space Grotesk count pill.
   - `CellStack({ primary, secondary, leading, numeric })`: the two-line table cell / list text (14.5 px semibold over
     12.5 px muted), optionally after an avatar; `numeric` for times.
   - `RowList({ label, inCard })` + `ListRow({ title, detail, meta, icon, tone, leading, trailing, action, highlighted })`:
     direction C's "needs attention" and activity rows (put the list in a `Card bodyClassName="p-0"`).
   - `SectionHeader({ title, count, actions, headingLevel, id })`: an 18 px section title with a count and actions, no
     description.
   - `StatTile` gained `aside` (beside the number, e.g. `LiveIndicator`) and `footer` (above the hint, e.g.
     `StatMeter`); tiles stretch to their row with the foot aligned; `variant="emphasis"` is the dark tile with the
     numeral in light turquoise. `StatMeter({ segments: [{ value, tone: 'strong'|'attention'|'accent'|'muted' }] })`:
     the stacked bar under a KPI (decorative: the hint says the numbers). `LiveIndicator({ label, tone })`: the pulsing
     dot (stops under reduced motion).
   - `MetaLine({ items })` and `PageHeader`'s new `meta` slot: the line of facts under a title ("Wed 7 Oct 2026 ·
     Updated 11:20") that replaces descriptions.
   - `Card` gained `count`, `titleId` (names the region) and `variant="emphasis"` (the dark panel).
   - `Table` gained `isRowHighlighted(row)` (the teal tint, in the table and as stacked cards; `data-highlighted`).
   - `Tabs`: a `badgeTone="warning"` count is now the attention yellow with ink text. `EmptyState`: page level
     (`headingLevel="h1"`) is a solid card with a 24 px title; `figure` shows a big numeral instead of the icon (the
     404 page).
   - Type tokens `text-section` (18 px) and `text-meta` (13 px); `font-display`; the `animate-live` pulse.
   - Kept for compatibility, no longer to be used for notes: `PageHeader`/`Card`/`EmptyState` `description`.

F10-32. **No explanatory notes in this pass's files (decision 3).** — Removed, with their keys in both languages:
the sign-in page's authorised-use footer (`CenteredLayout` lost its `footer` slot) and description; the descriptions of
the reset request, the new-password and change-password pages; "Did not receive it?…"; the invalid-link and
reset-done sentences; the forced change's explanation (the warning keeps its title, "Choose a new password to
continue"); the password-changed toast's sentence; the 404, access-denied and error-page sentences (title, icon or
numeral, action); "Days follow Amman time" under date filters (`DateField` lost its `timeZone` prop;
`DateRangeFields.timeZone` is optional and unused, marked deprecated for the feature agents to drop); the status
filter's "Showing every status"; the shell's time zone. `DateTimeField` names the time zone only when asked
(`showTimeZone` now defaults to false). Kept: errors and validation, the reset request's confirmation, the password
rules, the date range's read-back of the chosen dates (data), "Showing 1–6 of 6", "Loading…" and every accessible name.
Catalog keys removed: `common` `dates.daysFollow`, `filters.everyStatus`, `filters.selectedStatuses`,
`errorPage.newVersionDescription`, `errorPage.unexpectedDescription`, `accessDenied.description`,
`notFound.description`; `auth` `signIn.authorisedUse`, `signIn.description`, `forgot.description`, `forgot.notReceived`,
`reset.description`, `reset.invalidDescription`, `reset.doneDescription`, `change.description`,
`change.forcedDescription`, `change.changedDescription`.

F10-33. **Tests.** — New: `src/designTokens.test.ts` (contrast of all four token sets, the palette's own colours, no
navy), `components/app/BrandLockup.test.tsx` (product name, titles, lockup, `isBrandCompany`),
`components/ui/directionC.test.tsx` (the kit of F10-31, `EmptyState`, `StatusFilter`), `components/app/StatusScreens.test.tsx`.
Updated for the intended changes: `AppLayout.test` (teal shell, drawer named by the product, company in the menu and
for other tenants only, the current page's pill, the dark surface handle), `LanguageSwitcher.test`, `arabicUi.test`,
`LoginPage.test`, `ResetPasswordPage.test`, `Tabs.test`, `DateField.test`, `DateRangeFields.test`,
`DateTimeField.test`; E2E `i18n-smoke.spec.ts` (titles, the lockup instead of a named logo, no footer).
   - Outside this pass's files, one assertion line each, consequences of the brand and the kit only: the document title
     suffix in `pages/InviteVisitorPage.test.tsx`, `PassPage.test.tsx` (2), `VisitDetailPage.test.tsx`,
     `VisitorProfilePage.test.tsx`, and the attention badge class in `MyVisitsPage.test.tsx`.

**Gates.** `npm run typecheck`, `npm run lint` (0 warnings) and `npm run e2e:typecheck` pass; `npm run build` into a scratch
`--outDir` passes (stylesheet 77.0 kB / 14.3 kB gzip; start-up `app` chunk 298 kB / 83.2 kB gzip). `npm test`: 120 files,
1289 passed, 1 failed: `src/types/api.contract.test.ts` "compares every section of the backend snapshot", because
`src/types/backend-contract.json` gained a `field_error_codes` section at 20:23, written by the backend builder working
in parallel (field error codes); not this pass's files, left to that work (at the start of this pass all 1252 passed).
Full Playwright suite (`npm run e2e -- --retries=0`, ports 5199/8700, `vms_e2e`): 215 passed, 14 skipped, 0 failed
(7.1 min).

**Live check.** An API on 8821 and Vite on 5821 against a throwaway database (`vms_brandpass_p10b`: migrated, `seed-demo`,
dropped afterwards), `admin@demo.local`: the sign-in, 404 and signed-in shell (sidebar, user menu, keyboard focus on the
current page; top bar and drawer) in Arabic and English at 1440, 820 and 390 px, in the light and the dark scheme, and
the reception screen with the dark surface applied (deep shell, dark tokens). Titles end with «زوار موضوع» /
"Mawdoo3 Visitors"; no script error. Screenshots: the scratchpad's `phase10b-shots/brand/` (`dark-scheme/`,
`dark-surface-preview/`).

**Next (feature screens).** Drop the page, card and empty-state descriptions and the time-zone sentences the screens
still pass (`PageHeader`/`Card`/`EmptyState` `description`, the reception's group descriptions, the settings' toggle
descriptions) and their keys; put facts in `meta`; stop passing `DateRangeFields.timeZone`; mark the reception route
with `DARK_SURFACE_HANDLE` and build its screen on the dark tokens; name the product on the pass page with
`BrandLockup surface="page" size="lg"` (and `useProductName()`); use the F10-31 kit for C's tiles, tables and lists.

## Reception and inside now: direction C's dark reception tablet (2026-10-07)

Scope: `frontend/src/features/reception/**`, `src/features/inside/**`, the `reception` and `inside` catalogs (ar, en) and
the tests of these. No kit, layout, `index.css` or other catalog was edited; where the kit fell short on the dark
surface, the fix is local (F10-reception-4) and noted for the kit's owner. No E2E spec needed a change: none asserts a
text that was removed (checked: "Ready to scan", "Scan or paste a pass", "Enter or paste pass", "Point the camera at the
visitor's QR code", the region "Scan result", the list "Visitors inside", every button and dialog name stay verbatim).

F10-reception-1. **The reception screen is dark from edge to edge.** — The `reception` route declares
`handle: DARK_SURFACE_HANDLE` (`routes.tsx`, test `routes.test.tsx`): the shell turns deep teal, the page, its dialogs,
toasts and the drawer take `theme-dark` (F10-29). Every colour on the screen is a semantic token, so the screen needed
no colour of its own; the ratios below are the dark set's, noted in `index.css` and checked by `designTokens.test.ts`.

F10-reception-2. **Header: the date and the desk's clock, no time-zone sentence.** — `PageHeader` with the title, a
`MetaLine` with today's date (company time zone), and at the inline end direction C's clock (Space Grotesk 28 px,
`HH:mm` in the company time zone, refreshed every 10 s, a `<time>`; hidden on phones, which show their own clock) and
"Find a visitor". "{{date}} · Times are {{zone}}." is gone.

F10-reception-3. **Today's numbers as C's KPI strip.** — `TodayCounts.tsx`: five compact tiles in a `<dl>` named
"Today at reception" (Expected, Inside, Checked out, No-shows, Walk-ins), label and tinted icon tile over a Space
Grotesk numeral (24 px, 32 px from `sm`); Inside in turquoise (accent text 8.93:1) with a `LiveIndicator` ("Live"),
No-shows' icon tile in the warning tone when there are any. Phones show three tiles (checked out, no-shows,
walk-ins): expected and inside are the tabs' badges right under them, and the camera stays near the top. The tiles keep
their place while loading ("–", `aria-busy`, an sr-only "Loading today's counts…") and on failure (the line "Today's
counts are unavailable." with Try again). Not a live region (the 15 s poll would speak). Icon tiles from `lg` only.

F10-reception-4. **Tabs: C's full-width segmented track with icons.** — Scan · Expected · Inside · Walk-in with
decorative icons, segments sharing the track's width from `sm` (`sm:[&_[role=tab]]:flex-1` on the track). Kit issue
found on the dark surface, fixed locally: in the phone grid (`phoneLayout="grid"`) the selected segment lost its fill
(`max-sm:bg-surface` wins), leaving its ink label at about 1.1:1 on the dark surface, and its focus ring, drawn outside
the segment there, in the same ink on the dark canvas. The reception's track re-points both on phones: the selected
segment keeps `bg-tab-selected` (ink on turquoise 7.31:1) and its ring takes `outline-focus` (light turquoise, 9.35:1 on
the canvas); measured on the live page (390 px: ring #49cbd2 outside; 1440 px: ink ring inside the segment). The kit's
`Tabs` should do the same for every dark surface (open issue for the kit).

F10-reception-5. **The Scan tab: camera column and result panel side by side, the panel as tall as the column.** —
`ScanPanel.tsx`: from `lg` two equal columns, from `xl` the camera `1fr` and the result panel 28 rem (C's 468 px);
grid items stretch, so the result panel ends with the camera column (pass entry and beep switch under the camera).
`CameraView.tsx`: a 20 px panel with a hairline edge; 4:3, 16:10 from `xl` (so the whole scan screen fits a 1440 × 900
window); direction C's square frame of four rounded corners in turquoise (`border-accent`, centred with `left-1/2` and
its translation, 58 % of the height, slightly above the middle so the caption never touches it); a "Live" chip at the
top start while scanning (status, light turquoise dot), "Turn camera off" at the top end (12 px in, room for its two-tone
ring); "The camera is off" with Start camera in a quiet disc. "The browser may ask for permission…" is gone; the camera
errors keep their messages (they are errors). `PassInput.tsx`: C's form bar under the camera, one row from `sm` (icon and
label, the field, "Check pass"), the label above on phones; on touch screens the collapsed "Enter or paste pass" is a
full-width button (primary when the camera cannot scan, the bar's edge turquoise then). The hint sentence under the
field is gone (its accessible description with it).

F10-reception-6. **The result panel: C's verdict band, the visitor large, facts in a framed grid, the actions at the
foot.** — `ScanResultPanel.tsx`.
   - The verdict band across the top (`data-tone` names it, as an `Alert` does): an icon disc and the verdict in 20–24 px
     bold, the server's message under it when the verdict says something else. Tones, all token pairs of the dark set:
     valid pass turquoise with ink text (7.31:1); already inside the info tint with its text (8.73:1); a refusal that
     still allows a check-in mawdoo3's yellow with ink text (8.74:1); a refusal or no verdict the solid red with white
     text (4.67:1; the band's title is large, its line 14 px semibold). The disc inverts its band.
   - The visitor: an initials tile (dark tile, turquoise letters, decorative), the name in 28–32 px bold (still the
     `h3` the tests and E2E name), the company under it with its icon, the status chip and inside flags above the name
     where they add to the verdict. "Verify ID: name" is a framed row in turquoise (`border-accent`, 6.55:1 against the
     panel; `bg-accent-surface` with fg text 12.19:1, its icon in accent text 7.50:1). Other new pairs: the initials tile
     (light turquoise on the ink tile, 7.90:1, decorative), the info disc's icon (6.54:1), the no-visit figure (danger
     text on its tint, 8.28:1), facts in dialogs (muted term on the raised surface 6.06:1, phone link 8.01:1).
   - Facts: `VisitFacts` as C's grid (F10-reception-7), without the company (it is under the name).
   - Actions at the panel's foot (`mt-auto`): the `start` group (Scan next, Check pass again, an inside visitor's Check
     out) and the `end` group taking the rest of the row (C's wide primary: Check in in `xl`, 56 px). DOM, Tab and visual
     order unchanged; a check-out still never takes the `end` group; Scan next is outlined now (C's second button)
     instead of ghost. No keyboard hint inside the button: the E2E reads its text content.
   - A result about no visit (an invalid pass, no verdict) shows the verdict's symbol large and quiet in the body
     (a ticket with a cross, a cloud), decorative, where a visit's facts would be, so the tall panel is balanced
     without a sentence. Ready (nothing scanned): a turquoise disc with the QR icon and "Ready to scan", then "Expected
     next" as C's list (time range in Space Grotesk, name, company · host) with "All expected". Checking: a turquoise
     spinner. Success: a 96 px turquoise disc with an ink check, "Checked in"/"Checked out", the name; the panel's edge
     turquoise for the 1.5 s.
   - Kept: the live region's sentence, focus on the primary action, Escape, the 5-minute check-out rule, every label.

F10-reception-7. **`VisitFacts`: a framed grid of facts with icons.** — Each fact an icon and a 13 px muted term over a
15 px semibold value; one column on phones, two from `sm`, hairlines between the cells (`gap-px` on a `bg-border` grid).
Free text (purpose, a note) takes a whole row, and a short fact that would stand alone in a row takes it too
(`fullRows`), so no cell is left empty; a pass window across midnight (two dates) takes a whole row. New props:
`showCompany` (the scan result shows it under the name) and `surface: 'surface' | 'raised'` (dialogs). Order: company,
host, scheduled, department, pass window, purpose, walk-in reason, note, checked in, override reason (the scheduled time
moved before the department so it pairs with the host; the walk-in → note → checked-in → override order is kept).

F10-reception-8. **Lists in C's style.** — `VisitRow.tsx`: an initials avatar (the dark tile with turquoise letters for a
visitor inside), name (16 px semibold), company and chips, then time (Space Grotesk for a time range), host · department,
phone and purpose; rows in one framed card with hairlines (`VisitList`), the action at the end from `sm`, full width under
the details on phones, the menu in the row's corner. Expected: group titles at 18 px with a `CountBadge` inside the
heading (the accessible name stays "Arriving now 3"), the no-shows' count in mawdoo3's yellow; their descriptions are
gone. Inside: the "N visitors inside" count with a pulsing light-turquoise dot. The filters are search boxes with a
hidden label (the accessible name unchanged) and a placeholder that says what they search ("Visitor, company, host or
purpose"), instead of a hint under the field. The truncation line keeps its numbers only. Sign-in and sign-out icons
carry `mirror-rtl` (rows, dialogs, the menu item).

F10-reception-9. **Find a visitor.** — Each visitor with an initials avatar (ringed, so it shows on the dialog's raised
surface), name, company, e-mail and phone; their visits as a `VisitList`. Removed: the two notes about late and early
arrivals (`search.lateArrivals`, `search.earlyArrivals`; `searchNotes.ts` deleted, and the dialog's `noShowsComplete`
prop with them), the field's hint (now the placeholder "Name, phone, email or company"), and the advice in the capped
line ("Showing 50 of 120 visitors.").

F10-reception-10. **No explanatory notes (decision 3).** — Removed with their keys, both languages: the page's
time-zone description; the Expected groups' three descriptions and its empty-state sentence; the Inside tab's
"They probably left without checking out." and empty-state sentence; the refused passes' next-step sentences
(`scan.next.*` but the button; `refusalGuidance` no longer has `nextStep`: the panel's actions are the next step);
"probably the same visitor scanning again…" and "Check the visitor out if they are leaving…"; the idle panel's
"Scan the visitor's QR code…" and "Camera unavailable – …"; the camera's permission note; the pass field's hint; the
walk-in's visitor-card description, the host's "Search by name." and the disabled walk-ins' sentence; the check-in
dialog's "Compare the visitor's photo ID…"; the override dialog's "Verify the visitor's ID, then give the reason…" (its
description is the reason the pass cannot be used, data); the correction dialog's "{{name}} left without checking out.
Record when they left." (the dialog shows the name large and the check-in and scheduled end, data); "Saved with the
check-in/each check-out." and "Why the time is corrected." before the character counts (the counts stay: a constraint);
the bulk check-out's "Nobody to check out" toast sentence. Kept, as decision 3 allows: one sentence per irreversible
dialog: the bulk check-out "This cannot be undone." (its list says who and when), a check-out "The visitor leaves the
building now and their pass stops working.", and for a check-out minutes after the check-in the warning "Make sure the
visitor is leaving, not arriving." with "Checked in 3m ago" as the alert's title (the scanner's dialog now reads the same
as the list's); errors, the camera's error messages, "Not reading? Hold the code steady…" (shown only when scanning
stalls), "Leaves about 10:10 if checked in now." (the stay's read-back), "No phone number on record.", the counts.
English changed only where a note left: `search.capped`, `expected.truncated`, `search.placeholder` and
`filterPlaceholder` (were hints), `stale.description` (one sentence, no plural forms), `inside.updatedAt`,
`inside.print.footer`. New keys: `counts.expected|inside|checkedOut|noShows|walkIns|live`, `camera.live`.

F10-reception-11. **Inside now (/inside) in C's style, light, and its printout.** — The evacuation list stays on the
light content area (it is an office screen and the sheet that is printed). Header: the title, the meta line
"● Updated 09:31:05" (a `LiveIndicator`: the list refreshes every 15 s; after a failed refresh the time without the dot,
the warning alert says the rest), Refresh and Print list. Tiles: Headcount as C's dark emphasis tile (turquoise
numeral), Overdue and Previous day beside it (warning icon tile when not 0); their three hints are gone. Table: the
check-in cell is C's two-line cell, the time (Space Grotesk for today's) over the time inside ("1h 13m"). No avatar in
the visitor cell, although `VisitLinkCell` now takes one: with a mouse (the table) an avatar centred beside a one-line
name puts the visitor's phone line 9 px under the name, where `e2e/inside-touch-targets.spec.ts` and the touch-target
audit require it right under it (≤ 2 px). The printed sheet is unchanged (black on white, landscape) but for its footer:
"Printed by {{name}}." (the sentence about visitors who left without checking out went with decision 3).

F10-reception-12. **Tests.** — Updated for the intended changes: `ReceptionLists.test.tsx` (the KPI tiles' label and
number, no search notes, the bulk dialog's one sentence), `ReceptionScanner.test.tsx` (company under the name, the
invalid pass's band without a next step, the collapsed field full width, no idle sentences, the refusal band's text, the
override dialog's description), `scanOutcome.test.ts` (no `nextStep`), `VisitFacts.test.tsx` (the order; new: the grid
fills every row, `showCompany`, `surface`), `InsidePage.test.tsx` (the meta line instead of the sentence, the emphasis
tile; one line followed `VisitLinkCell`'s new class from the visits area). New: `routes.test.tsx` (the dark surface
handle).

**Gates.** `npm run typecheck` and `npm run e2e:typecheck` pass; `npm run lint` passes (0 warnings); `npm test`: 122
files, 1298 passed, 1 failed: `src/types/api.contract.test.ts` (the backend's new `field_error_codes` section, not these
files; known from the brand pass). Earlier runs during the work also failed in `pages/InviteVisitorPage`,
`VisitDetailPage`, `VisitorProfilePage`, `HistoryPage` and `i18n/arabicUi` tests while the other areas were mid-edit;
the last run had only the contract test. Playwright was not run here (shared ports; the integrator runs it).

**Live check.** An API on 8831 and Vite on 5831 against a throwaway database (`vms_receptionpass_p10b`: migrated,
`seed-demo`, realistic visits created through the API: arriving now, late, later today, a no-show, inside now, overdue,
from the previous day (moved with `e2e-time-travel`), checked out, a walk-in; dropped afterwards), signed in as
`reception@demo.local`, Chromium with a fake camera: the Scan tab idle, a valid pass, a visitor already inside, a pass not
valid yet, an invalid pass, the success state, the Expected, Inside and Walk-in tabs, Find a visitor and /inside, in
Arabic and English at 1440, 820 (touch) and 390 (touch), and at 1440 in the dark colour scheme. Screenshots: the
scratchpad's `phase10b-shots/reception/` (`dark-scheme/`). No script error; the only failed requests are the expected
ones (401 before sign-in, 404 and 409 for the invalid and not-yet-valid passes).

## Analytics: the reports and the visit history in direction C (2026-10-07)

Scope: `src/features/reports/**`, `src/features/history/**`, the `reports` and `history` catalogs (both languages) and
the tests of these files. No E2E spec read a text these screens changed, so none was edited. The user's decisions of
2026-10-07 apply: Mawdoo3's palette through the semantic tokens of F10-28, no explanatory notes, direction C's
dashboard (big KPI numerals, clean charts, compact chips), Arabic first and English.

F10-analytics-1. **The report's figures as direction C's KPI block.** — `ReportKpis.tsx`.
   - The figure the report is about, the visits booked, is the dark emphasis tile (`StatTile variant="emphasis"`, its
     numeral in the turquoise, 72 px from xl where the tile spans two rows). Under it a meter of the visits' outcomes and
     the outcomes with their counts: arrived (`totals.checked_in`), no-show, cancelled and, only while some remain, still
     expected (`visits − checked_in − no_show − cancelled`: today's visitors not yet arrived). The four add up to the
     visits booked, so the tile says what "booked" means with numbers instead of the old explanation paragraph. Meter
     and swatches use StatMeter's tones (ink/light, yellow, muted grey, turquoise); the list is the meter's text (the
     meter is decorative). On paper the meter is left out and the outcomes print as one line, each label kept with its
     count (`whitespace-nowrap`).
   - Four tiles beside it (2 × 2 from xl; below xl the dark tile takes a row and the others sit two per row, one per
     row under 360 px; five in one compact row on paper): unique visitors with "5.8 visits per visitor"
     (`checked_in / unique_visitors`, one decimal: data where the note "People who came in person" was); checked in with
     "212 checked out" and "14 walk-ins" on two lines (no separator to strand); the no-show rate with its share as a meter
     (no-shows in the attention yellow against the rest of the rate's base, `checked_in + cancelled`) and "21 no-shows";
     the average duration alone (its note "Without corrected or bulk check-outs" went). Icon tiles in the tones info,
     success, warning, neutral, as C's tiles.

F10-analytics-2. **Charts in direction C's cards, the series in Mawdoo3 teal.** — `charts/ChartFigure.tsx`,
`charts/ChartLegend.tsx` (new), `charts/ColumnChart.tsx`, `charts/BarChart.tsx`, `charts/ChartReadout.tsx`.
   - A chart card is the title and one headline figure in a row (the daily average "8.4"; the busiest hour "10:00", its
     start, so the half-width card keeps one header line at 1280 px; the range stays in the table and the summary), the
     drawing, then the legend and "Show table" at the card's foot (the button left the header, which wrapped beside a
     figure). The summary sentence ("94 visits over 30 days. The busiest full day …") is the figure's
     `aria-describedby` only, visually hidden (decision 3: a chart keeps a title and an accessible summary).
   - Marks in `chart-1` (#188086 on white 4.70:1; the turquoise in the dark scheme, 6.55:1 on its surface), the hovered or
     focused mark `accent-hover`; solid hairline gridlines in `chart-grid`, the baseline one step stronger; ticks, peak and
     bar values in Space Grotesk (`font-numeric`), hour labels too; today's label bold. Today's mark stays hatched (texture,
     not colour alone) and is named by a legend under the plot, "Full days" / "Today, so far" (a line and a hollow point
     when the period is drawn as a line, above 62 days). `ChartLegend` carries its own texture definition, so it can stand
     in the card's foot.
   - The right-to-left rules of F10-20 are unchanged (marks mirrored, texts placed, arrows the way time runs).
   - "Point at or tab to a mark…" went: the readout above the plot appears on hover and focus, and the table is one click
     away. "Today, so far" replaced "today, so far: includes visits still expected" in marks, readout and table.

F10-analytics-3. **Top hosts as C's table in a card.** — `TopHosts.tsx` (new). Rank in the numeral face, the host with
an avatar (decorative; the busiest host's dark with a turquoise initial), the visits as a number in a column of its own
width and a bar on a track that fills the rest of the column (SVG, so it prints without background graphics; it grows
from the reading start: `x` mirrored in Arabic, tested), the share. Below `sm` the avatars and bars give way to the
numbers. The card's note ("The ten hosts with the most visits in the period.") went.

F10-analytics-4. **The period: one row of controls, read back as facts in the header.** — `ReportsPage.tsx`,
`ReportRangeControls.tsx`.
   - The header names the period as `MetaLine` facts ("Tue, 8 Sep 2026 – Wed, 7 Oct 2026 · 30 days") instead of a
     description; on phones the facts stack, one per line, without separators, so a wrap never strands a dot.
   - Period, From and To sit in one row with their labels level (a card like the history's filter panel); the dates are a
     fieldset named "Dates" for assistive technology (`sr-only` legend). The kit's `DateRangeFields` drew a second label
     row and a read-back line under the dates, which the header now says; a report's dates are always set, so each input
     keeps 9.5rem and the two sit side by side from a 390 px phone up.
   - The printed sheet's header keeps the period sentence; "Days and hours follow Amman time (UTC+3)." went (the kit's
     "Generated …, Amman time (UTC+3)" line still names the zone on paper), and so did the footer under the report.

F10-analytics-5. **The visit history in direction C's table.** — `VisitHistory.tsx`, `HistoryTable.tsx`,
`HistoryPage.tsx`.
   - The page header (now rendered by `VisitHistory`) has no description ("Every visit of …, newest first. Times are …");
     its facts are the number of visits the view holds and, when the dates are filtered, the dates read back ("66 visits ·
     From Thu, 1 Oct 2026 to Wed, 7 Oct 2026"), the line keeping its height while the first page loads.
   - Filters in one row of labels and one of controls: the search says what it searches in its placeholder ("Visitor,
     company, host", «زائر، شركة، مضيف»), and only the three-character minimum is said under it, when it applies; the
     dates are the same From/To pair as the report's (fieldset "Scheduled date", read back in the header); the host
     field's note went.
   - Rows: a 32 px avatar before the visitor's link (dark with turquoise initials while the visitor is inside), the date
     over the time range and the host over the department as two-line cells (13 px muted second lines, times in the
     numeral face), the purpose in the slate. Visitors inside now are tinted (`isRowHighlighted`; their status chip says
     why). A date of this year is shown without its year ("Wed, 7 Oct", «الأربعاء، 7 تشرين الأول»; `useNow`), an older
     one with it.
   - Column widths from measured content, per language (Chromium, 1280 and 1440 px): the Arabic status chip is at most
     131 px («لم يحضر الزائر»), the Arabic date 156 px, the Arabic attendance 168 px («دخول 14:48 · خروج 15:21», which
     wrapped onto three lines in 160 px); at 1280 px the Arabic purpose now gets 123 px instead of 47 px. The purpose is
     `dir="auto"` with `text-align: match-parent` (and Chromium's `-webkit-match-parent`): an English purpose in the
     Arabic table is cut at its own end ("Quarterly busi…", not "…ness review") and still aligned like its cell.
   - The legend of method badges under the table went (decision 3: mechanics explanations); a badge's meaning stays
     its tooltip, and the visit page tells the rest. An end date before the start date is said once, under "To": the
     "Check the dates" state no longer repeats it.

F10-analytics-6. **Notes removed and keys deleted (both languages).** — `reports`: `summary.explanation`,
`summary.uniqueVisitorsHint`, `summary.averageDurationHint`, `summary.includes`, `summary.cancelledCount_*`,
`topHosts.description`, `charts.interactionHint`, `charts.daily.partialLegend`, `empty.description`, `footer`,
`daysAndHoursFollow`. New: `meta.range`, `meta.days_*`, `charts.daily.average`, `charts.daily.legendDays`,
`charts.daily.legendToday`, `charts.hourly.busiest`, `summary.outcomes`, `summary.arrived`, `summary.noShow`,
`summary.cancelled`, `summary.expected`, `summary.visitsPerVisitor`. Changed: `charts.todaySoFar` ("today, so far"),
`charts.dailyToday` ("Today so far: {{visits}}."), `charts.hourly.summary` (no time zone). `history`: `description`,
`filters.searchHint`, `filters.hostHint`, `empty.pageDescription`, `empty.filteredDescription`, `empty.description`.
New: `count_*`, `filters.searchPlaceholder`. Kept: every error and validation message (range, search minimum, load
errors), counts ("Showing 1–25 of 635"), status labels, the chart summaries (for assistive technology) and every
accessible name. `REPORT_TEXTS` and `MethodLegend` are gone.

F10-analytics-7. **Tests and checks.** — `ReportsPage.test.tsx`: the KPI block (outcomes adding up, both meters, the
facts of each tile), the header's period facts and the "Dates" group, a test that no note is on screen (and the summary
is `sr-only`), the headline figures, the legend, the paper outcome line, the host bars; `TopHosts.test.tsx` (new): bars
from the reading start in both languages, the Arabic columns, the empty case; `HistoryPage.test.tsx`: the header's count
and date read-back, the "Scheduled date" group, no notes (description, zone, hints, empty-state sentences), the tooltip in
place of the legend, the year rule, the tinted rows of visitors inside; `chartData.test.ts`: today's sentence.
   - Live check: an API on 8833 and Vite on 5833 against `vms_analytics_p10b` (migrated, `seed-demo`, nine more hosts
     and 635 visits over 90 days through the API: invitations, manual, override and walk-in check-ins, manual and
     corrected check-outs, cancellations; then each visit moved to its planned day and hour on that database only, with
     the time-travel UPDATE of the E2E CLI, no-shows marked by `mark-no-shows` and stale visits checked out in bulk
     through the API; dropped afterwards). Screens in Arabic and English at 1440, 1280, 820 and 390 px, in the light and
     dark schemes, the paper layout, a 90-day range, an empty period, the range errors and an empty history: no
     horizontal overflow, no script error. axe-core (as the E2E spec runs it, signed in as management): 0 violations on
     /reports (a chart table shown, a mark focused), /history and an empty history, in both languages, both schemes, at
     1440 and 390 px. The E2E history-layout check, replicated against Vite 5833 with its mocked API: no scroll and the
     attendance inside the card at 1024, 1280 and 1440 px, in English and Arabic. The report prints on two A4 pages in
     both languages. Screenshots: the scratchpad's `phase10b-shots/analytics/` (`dark-scheme/`, `print/`, `states/`).

## Administration: the dashboard, users, departments, company settings and audit log in direction C (2026-10-07)

Scope: `src/features/admin/**`, the `admin` catalog (both languages) and the tests of these files; one assertion line of
`src/i18n/arabicUi.test.tsx` that read the dashboard's removed description now reads its «مباشر» ("Live"). No E2E spec
read a text these screens changed (the selectors they use, "Admin dashboard", "Add user", "Create user", "User created",
"Temporary password", "Edit {name}", "Rename …", "Deactivate …?", "Audit events, newest first", "Details: …", "Company
name", "Leave without saving?", kept their words), so none was edited. The user's decisions of 2026-10-07 apply:
Mawdoo3's palette through the semantic tokens of F10-28, no explanatory notes, direction C, Arabic first and English.

F10-admin-1. **The admin dashboard as direction C's board.** — `AdminDashboard.tsx` (the page component only mounts it),
`auditVisuals.ts`, `roleVisuals.ts` (new).
   - Header: the title, a `MetaLine` with today's company date and "Updated 21:23" (when the figures were read), and C's
     dark "Invite visitor" action (an administrator hosts too; compact and without its icon beside the title on phones,
     so the title keeps one line). The description ("{company}: visits, visitors and accounts at a glance") went.
   - The visit figures are four KPI tiles (big numerals, each tile a link to the list behind it, as before), the people
     inside now on the dark emphasis tile with C's "● Live". The dashboard query now polls every 30 s
     (`ADMIN_DASHBOARD_REFRESH_MS`; TanStack pauses it in a background tab), so "Live" holds. Every hint under a number
     ("Checked in, any day", "Since the start", …) and the accounts note ("A person with several roles is counted under
     each of them.") went; the visible "Visits" heading became an `sr-only` h2 (the tiles name themselves).
   - C's 2/3 + 1/3 grid: the latest audit events as activity rows (an icon tile per kind of event, a red shield for
     security denials, an amber warning for other failures; the event, a qualifier chip, what it concerns with its link;
     the time and the actor at the row's end from `sm`, a third line on phones; one DOM), "Open audit log" at the card's
     foot. Beside it the active accounts by role as rows (role icon tile, name, a 26 px numeral, chevron; each a link to the
     filtered users) and a **Company settings** card: the settings that apply to everyone as facts (default language in its
     own script, time zone "Amman time (UTC+3)", walk-ins allowed or not, the pass window "60 min before · 60 min after")
     with "Edit settings". *(Interpretation: the facts are data, not the removed time-zone sentence; the card balances C's
     side column, which the four account rows alone left about 500 px shorter than the activity. The dashboard now also
     reads `GET /company/settings`, which `adminDashboardRoutes()` mocks for every test that lands on /admin.)* On tablets
     the two side cards share a row under the activity.

F10-admin-2. **Users as C's table.** — `UserDirectory.tsx`.
   - Columns: the person (C's cell: initials tile, the name with "(you)", "Inactive" or "Temporary password", the e-mail
     address under it), roles as chips, department, **last sign-in** (now a column of its own: "Today, 09:00" / "Never
     signed in"), Edit. Fixed widths from `xl`; below 1280 px every account is a card, two per row from `md` (five columns
     do not fit the 704 px a 1024 px screen leaves beside the sidebar). Cells are centred vertically, as in C.
   - An inactive account's initials tile has a dashed edge. *(The first version faded it to 60 %; axe-core found its
     initials below 4.5:1.)*
   - The header counts the accounts ("13 accounts", the list's total); the description ("Accounts, roles and departments.
     People are deactivated, never deleted.", the user's own example) went. The search box's hint became its placeholder
     ("Name or email address"); the status filter is wide enough for "Active and inactive"; the filtered empty state is its
     title and "Clear filters".

F10-admin-3. **The user dialogs: no notes, roles as C's option tiles.** — `CreateUserDialog.tsx`, `EditUserDialog.tsx`,
`RoleCheckboxes.tsx`, `TemporaryPasswordField.tsx`, `userForm.ts`.
   - Add user: no description; no hints under e-mail and phone. The roles are a fieldset of four bordered tiles (native
     checkbox, the role's icon tile, its name; a check mark and the teal edge and tint when chosen; the tile is the tap
     target and draws the focus ring); their descriptions and the "roles combine" hint went. Two tiles per row from 416 px.
   - The temporary password keeps its rules: the length and "different from the email address" checked live, and "Must not
     be a commonly used password." (`auth:password.notCommon`, as `PasswordRequirements` lists it) in place of the long note.
   - User created: the one-time warning stays as the dialog's description ("Pass the temporary password on now: it is shown
     only once."); then "{name} can now sign in", the e-mail address and the password read-only, the password's constraint
     as its hint ("Expires after 72 hours."), Copy password. The sign-in sentence and the share advice went. The password is
     focused (and selected) on open, as before.
   - Edit user: the description is the account's sign-in address alone (data; it cannot be changed). "Account is active" has
     its label only; a locked control keeps its reason ("You cannot remove your own administrator role.", now under the role
     tiles and describing that checkbox; "You cannot deactivate your own account."). The warning before a change that
     cancels hosted visits keeps its title and one sentence (the "told by email. This cannot be undone." note went); the
     reactivation note went; the toast after it says only "3 scheduled visits hosted by … were cancelled."
   - Fix: deactivating someone who cannot host (reception, management) no longer warns that their hosted visits will be
     cancelled; they have none (a host who lost the role had them cancelled then). `cancelsHostedVisits` checks the
     account's current roles; tested.

F10-admin-4. **Departments.** — `DepartmentList.tsx`, `DepartmentNameDialog.tsx`. The name with a building tile (teal; grey
with the "Inactive" chip for an inactive one), "Last changed", the actions; fixed column widths. The header counts "7 active
departments · 1 inactive" in place of "Departments people and visits belong to. They are deactivated, never deleted."; the
add and rename dialogs lost their descriptions; the empty states are a title and "Add department". The deactivation
confirmation keeps one short sentence, "It can no longer be chosen for new users or visits." (a destructive action's
confirmation; the rest of the old paragraph went). The kit's `Dialog` renders its body for any child but `undefined`, so
the error slot now passes `undefined` rather than `false` (a title-only dialog drew an empty band).

F10-admin-5. **Company settings: four titled cards, labels only.** — `CompanySettingsForm.tsx`, `CompanySettingsPage.tsx`.
"Company" (name, Arabic name typed right to left, e-mail domain, address), "Language and time zone" (one card: the default
language a segmented choice, each language in its own script; the time zone combobox), and "Visitor passes" beside
"Reception" from `lg`. Gone: the page and card descriptions, every field hint (English name, Arabic name, domain example,
address use, the language and time-zone explanations), the time-zone change warning, the pass-window note, both toggles'
descriptions. Kept: validation, "All changes are saved." / "You have unsaved changes.", the saved toast's "Dates and times
now follow {zone}." (feedback), the minutes read back in words under the pass fields ("90 minutes (1 hour 30 min)": data,
and it gives the "min" unit to assistive technology), and the one sentence of "Leave without saving?". On phones the
sticky bar puts the status over the two buttons side by side (each wraps to its own row at 320 px).

F10-admin-6. **The audit log as C's table card.** — `AuditTrail.tsx` (now renders the page header), `AuditLogPage.tsx`,
`AuditEventList.tsx`, `AuditEventSummary.tsx`.
   - Header: "Audit log" and the count of events the filters match ("96 events"); "Append-only record … Times are Amman time
     (UTC+3)." went. The filters lost their hints ("Any account, active or not.", "The full ID of …"; the incomplete-ID error
     stays) and no longer pass `DateRangeFields`' deprecated `timeZone`.
   - Rows: the time to the second in the numeral face over the date, the event with its kind's icon tile (shared with the
     dashboard), the actor with an initials tile (a neutral tile for the system), "Details". One grid template is shared by
     the header row and the rows, every column fixed but the event's (an `auto` details column was 0 px in the header and
     shifted "By" by 100 px); the time column holds an Arabic date on one line from `xl`. The DOM reads the event first, then
     when and by whom; on phones the time and the actor stand under the event, "Details" beside them.
   - The details panel is a sunken card; "No further details were recorded." became "None"; the empty page state lost its
     sentence. Eight metadata keys the backend writes (`session_id`, `email_message_id`, `revoked_sessions`, `minutes`,
     `department_id`, `coalesced`, `checked_in_before`, `deferred`) had no catalog words, so the Arabic details showed
     "Session id"; they are in both languages now (English unchanged), and `auditLabels.test.ts` lists every key.

F10-admin-7. **Catalog.** — Removed from both languages (59 keys): `audit.description`, `audit.filters.performedByHint`,
`audit.filters.recordIdHint`, `audit.empty.pageDescription`, `audit.details.noMetadata`; `dashboard.description`,
`dashboard.audit.emptyDescription`, `dashboard.audit.description`, `dashboard.visits.{insideNow,today,all,visitors}Hint`,
`dashboard.accounts.{employees,reception,management,admins}Hint`, `dashboard.accounts.note`; `users.roleDescriptions.*` (4),
`users.description`, `users.search.hint`, `users.empty.filteredDescription`,
`users.form.{rolesHint,temporaryPasswordNote,emailHint,phoneHint}`, `users.created.{signsInWith,shareAdvice}`,
`users.createDescription`, `users.editDialog.{description,activeDescription,cancelsVisitsNote,reactivating}`;
`departments.{description,renameDescription,addDescription}`, `departments.empty.{noneActiveDescription,description}`;
`settings.description`, `settings.company.{description,nameHint,nameArHint,emailDomainHint,addressHint}`,
`settings.language.{title,description,hint}`, `settings.timezone.{title,description,hint,changingTitle,changingDescription}`,
`settings.passes.{description,minutesHint,note}`, `settings.reception.{notifyHostDescription,walkInsDescription}`. Added:
`dashboard.{updated,live}`, `dashboard.company.*`, `users.search.placeholder`, `users.total`,
`departments.{activeTotal,inactiveTotal}`, `audit.total`, `settings.region.title` and the eight `audit.metadataKeys`.
Shortened to their first sentence: `users.cancelledVisits`, `users.created.passwordHint`, `departments.deactivateDescription`.

F10-admin-8. **Kit observations (not changed here: the kit belongs to the brand pass).** `Card`'s `bodyClassName="p-0"`,
which `ListRow`'s docs suggest, does not remove the body padding: `cn` joins without merging and Tailwind emits `px-4`
after `p-0`, so the padding wins; the admin cards pass `p-0!`. A `Dialog` whose only child is `false` renders an empty body.

**Checks.** `npm run typecheck` passes; `npm run lint` reports nothing in these files (three warnings in other areas' files
at the time); every admin test passes (10 files, 87 tests), and so do `src/i18n` (catalogs, hard-coded text, logical
properties, the Arabic UI), `src/layouts`, `src/auth` and `components/app`. The full suite's failures at the time were in
other areas' files under concurrent work (visits pages, the reception scanner) and the known `api.contract.test.ts`. Live
check against an API on 8834 and Vite on 5834 (throwaway database `vms_adminpass_p10b`: migrated, `seed-demo`, Arabic
departments and accounts, visits checked in and out, a cancelled one, failed sign-ins; dropped afterwards): every admin
screen and dialog in Arabic and English at 1440, 820 and 390 px and in the dark scheme at 1440 and 390; axe-core on the five
pages and four dialogs in both languages and both schemes at 1440 and 390 (72 checks): no serious or critical violation; no
horizontal scroll at 320 px on any admin page or dialog. Screenshots: the scratchpad's `phase10b-shots/admin/` (`states/`:
the user created, the deactivation warning; `dark-scheme/`; `tablet-820/`).

## Visits, visitors and the visitor pass in direction C (2026-10-07)

Scope: `frontend/src/features/visits/**`, `src/features/visitors/**`, `src/features/pass/**`, `src/pages/{MyVisits,
InviteVisitor,VisitDetail,Visitors,VisitorProfile,Pass}Page.tsx`, the `visits`, `visitors` and `pass` catalogs (ar, en)
and the tests of these. No kit, layout, `index.css` or other catalog was edited; where the kit fell short, the fix is local
and noted below for the kit's owner. No E2E spec needed a change: none asserts a text that was removed (checked: "Visit
scheduled" and the visitor's name as h1/h2, "Pass link", "Show QR code", the dialog "Visitor pass QR code" and its image
"Visitor pass QR code for …", "Done", "Invitation sent to", "Invitation not delivered to …", "Sent to …", "Time on site"
as a `dt` with its `dd`, "Timeline", "Visit history", "This visit was cancelled", "The previous QR code will stop working",
"This pass link is incomplete or invalid", every field label, button and dialog name stay verbatim). Three components of
this area are shared with other areas and keep their APIs: `VisitLinkCell` (history, evacuation list), `VisitorSourceFields`
and `SelectedVisitorSummary` (the reception's walk-in form).

F10-visits-1. **Lists as one card: `ListPanel`.** — `features/visits/ListPanel.tsx`: direction C's "Today's visits" card for
My visits, Visitors and a visitor's history: the toolbar (search, status choice) as the card's header, the table edge to
edge under a hairline (`Table framed={false}`), the pagination ("Showing 1–6 of 6") under another. From the table's
`stackBelow` on (`lg` for visits, `md` for visitors); below it the rows are the kit's stacked cards and the panel draws no
frame (a card of cards costs a phone its width). The table's loading box and an empty list's placeholder lose their own
frame inside the panel (one frame, not two).

F10-visits-2. **Direction C's rows.** — Visits: the visitor after an avatar of their initials (`VisitLinkCell` gained an
optional `leading`; without it the cell is unchanged for the history and the evacuation list), a 14.5 px name over a 12.5 px
company in the table only (the stacked card keeps its larger title); the time in Space Grotesk over what happened ("In
09:04 · Out 09:51", `attendanceLines`, data); a cancelled visit's time struck through and muted; compact chips; a visitor
inside the building now as the highlighted row (`isRowHighlighted`) with the dark emphasis avatar; cells centred on the
avatar (`lg:align-middle`). Fixed widths from `xl` rebalanced so "Mon, 12 Oct 2026, 09:30–10:15" keeps one line at 1440 px
and the status column fits "Checked out" (`xl:w-40`; at `xl:w-38` the English chip was cut). Visitors: the same row (avatar,
name, company), contact as two lines, today's visits as Space Grotesk links with their chips, the visit count in Space
Grotesk; a visitor inside now highlighted; the last check-in keeps one line in the table only (a long Arabic date
overflowed a 320 px card by 20 px).

F10-visits-3. **My visits: the summary is the title's line of facts.** — `MyVisits` renders its `PageHeader` (the page is
thin): `meta` is the dashboard's summary ("● 1 inside now · Last 30 days: 4 completed · 2 cancelled"), a live dot while
anyone is inside; on phones the two facts take a line each (no dot between, "Last" kept). The description with the time
zone is gone. The tabs stay the kit's segmented control above the card (2 × 2 on phones); the card's header holds the search
(label visually hidden, its placeholder naming what it searches: "Visitor name, company or email address"; on a phone,
where it shares the row with the status choice, one word: "Search") and the status choice (a `Select` named "Show" by
`aria-label`; its current option says what is shown). Kit issue fixed locally (the reception's fix, F10-reception-4): in the
phone grid the selected tab lost its fill, and its ink label was about 1.1:1 in the dark scheme (axe found it); the track
keeps `bg-tab-selected` and the focus colour for the selected segment on phones.

F10-visits-4. **The visit page.** — Header: the visitor's name, then the visit and invitation chips, the walk-in badge and
the company (with a building icon) as `meta`. "Visit details" opens with the schedule on a sunken strip (icon tile, "When",
the date and times in Space Grotesk), then `FactList` (`features/visits/FactList.tsx`, direction C's detail style: a 13 px
muted term over a 15 px value; `dt`/`dd` pairs as before). The invitation's and the pass's state are chips at the end of
their cards' headers. The timeline: 12 px dots ringed with the surface on a 2 px connector (still `start-[5px]`), 14.5 px
titles, Space Grotesk times. The failed-invitation banner keeps its title and its two ways out, without the advice. The new
pass after a resend or a new link: a section with its heading, "The previous QR code no longer works." and Done, over the
pass card (F10-visits-5).

F10-visits-5. **The pass card (`PassActions`).** — Direction C's pass card from the e-mail mockup, in mawdoo3's teal
(`theme-shell`: the side-nav teal, white text 4.70:1, the deep teal in the dark scheme): "Visitor pass", the visitor and
the time, the link field ("Pass link", `dir="ltr"`: an address reads from its start in Arabic too) with one short line,
"Shown only once." (kept like the one-time temporary password; "Anyone with this link…" and "the visitor also gets it by
email" went), Copy link (white with teal text when it is the primary action), Show QR code, Print pass, and behind a dashed
perforation the QR code itself on a white tile. That picture is `aria-hidden` (one image of the pass for assistive
technology: the large one "Show QR code" opens, named "Visitor pass QR code for …"). The QR dialog lost its description.
The printed pass: a black-on-white card with the ink logo over the product's name, the company, "Visitor pass", the visitor,
the QR code, the date and times, the host, the instruction and the photo-ID line; no time-zone line.

F10-visits-6. **Invite and its outcome.** — The form: no page or card description, no hint that restates its label (host),
no "Needed to email the invitation." (the field's error says why when it is missing), the delivery choice as two plain radios
named by what they do (the segmented `RadioGroup` was tried; its visually hidden input breaks the acceptance spec's
`getByRole('radio').check()`, which this area may not edit: the integrator can switch that line to the suite's `chooseRadio`
and the form to `variant="segmented"`), the schedule without the time-zone and 24-hour note (the read-back stays, with a
check icon, in Space Grotesk), the purpose's hint only its length ("0 of 500 characters"). The returning-visitor search
names what it searches in its placeholder instead of a hint (`VisitorPicker` gained `placeholder`; the walk-in form gets the
same field; `pickerHint` still shows a status such as "Loading the visitor…"). The success view: the outcome as the title,
alerts first (another visitor's name, a failed delivery with its ways out, a replaced pass), the visit as a card (avatar,
name, company, chip, the invitation's live status line, When · Host · Department), the pass card, then View visit / Invite
another visitor. Removed: the reuse note, the cancelled alert (the title says "Visit cancelled"), the next-step sentences.

F10-visits-7. **The public pass page.** — `PassPage`: the product lockup (`BrandLockup surface="page" size="lg"`, the logo
over «زوار موضوع» / "Mawdoo3 Visitors"), then the pass as a ticket: a teal head with the h1 "Visitor pass", the QR code on a
white tile overlapping it (up to 296 px, black on white with its quiet zone; on a 390 px phone about 300 px), the
instruction in bold, a perforation with notches, two things to have ready as icon rows (photo ID; keep the page open or take
a screenshot; the brightness tip went), Print pass. On paper: the ink logo and product name, a black-bordered card, no
tips but the photo ID. The invalid link: one sentence ("Open the link from your invitation email again."). Language switch
and the static, request-free behaviour unchanged.

F10-visitors-1. **Visitors and the profile.** — The search page: the title alone (the scope sentence went: the server scopes
the list), the list card with the search as its header (placeholder "Name, email address, company or phone number"). The
profile: the company as the title's line of facts, Contact details as a `FactList`, the visit count as the kit's KPI tile
(`StatTile`, accent icon, the last check-in at its foot), the history under a section title with its count (`SectionHeader`)
in a list card. The edit-visitor dialog lost its descriptions and the email hint; a changed address shows one warning
("The visitor gets new invitations" + "QR codes sent to the previous address stop working."; a removed one: that sentence as
its title). `SelectedVisitorSummary` (invite and walk-in) uses the sunken surface and the control radius.

F10-visits-8. **Decision 3 in these catalogs.** — Removed in both languages: `visits` `myVisits.description`,
`myVisits.empty.{searchHint,todayDescription,upcomingDescription,pastDescription,attentionDescription,pageDescription}`,
`myVisits.search.hint`, `invite.{description,visitorCard.description,emailHint,deliveryEmailDescription,
deliveryShareDescription,hostHint,purposeHint,visitorLoadErrorHint}`, `schedule.hint`, `edit.{rescheduleNoticeEmailed,
rescheduleNoticeNoInvitation,rescheduleNoticeNoEmail,purposeHint}`, `cancel.{noEmailNoInvitation,noEmailNoAddress,
reasonHintEmailed,reasonHint,reasonHintWithCount,notifyDescription,doneNoAddress,doneNoInvitation,doneNotEmailed}`,
`timeline.noShowDetail`, `detail.facts.timesIn`, `detail.pass.{shownOnceIssue,shownOnce}`, `detail.notFound.description`,
`invitationText.{failedAdvice,nextStepCorrect,nextStepResend,nextStepShare,passLinkNoteShare,passLinkNoteEmailed,
reusedNote,reusedNoteNoAddress}`, `inviteSuccess.{cancelledTitle,cancelledDescription,cancelledInviteTyped,
passReplacedEmailCleared,passReplacedResent}`, `passActions.qrDialogDescription`, `issuePass.{description,warning}`,
`resend.warning`; `visitors` `search.{descriptionScoped,description,noMatchesDescription,emptyDescription,hint}`,
`edit.intents.{edit,correctEmail}.description`, `edit.{emailHint,newInvitationsTo,emailRemoved}`,
`profile.notFound.description`, `profile.history.{description,descriptionScoped,emptyDescription}`, `profile.visits`,
`fields.returningHint`; `pass` `tips.brightness`. Added: `visits` `myVisits.search.{placeholder,placeholderShort}`,
`cancel.notEmailed`, `inviteSuccess.passReplacedPrevious`, `passActions.shownOnce`; `visitors` `search.placeholder`,
`edit.previousQrStops`, `fields.returningPlaceholder`. English shortened where a sentence kept its fact and lost its
explanation: the reschedule toasts ("The visitor was not emailed.", "…is being emailed the new date and time.", "…the limit
for emails about changes was reached.", "The timeline shows the latest email to the visitor."), the cancel dialog ("{{name}},
{{when}}. The visitor's QR code stops working." — the one sentence a destructive confirmation keeps), the cancel toasts
(notified, or "The visitor was not notified."; `cancelledMessage(after)`), "Valid {{window}}", "The invitation to … is still
being sent.", "The visitor has no email address.", the other-name warning, "A new invitation is being sent to …", "The last
invitation to … could not be sent.", "No matching visitor.", the invalid pass link. Kept, as data, status or consequence:
the revoke reasons, the cancellation e-mail lines, "The visitor was not told. Let them know yourself." in the timeline, the
outcome banners, "The previous QR code will stop working" (resend and new link: the title alone), "The previous QR code no
longer works.", the password-like "Shown only once.", the counts, every error and validation message, the pass page's
instruction and its two lines. Left to their areas (they render them): the inside flags' tooltip descriptions
(`insideFlags.*Description`, reception and the evacuation list) and the method descriptions (`methodDescriptions`, the
history's legend).

F10-visits-9. **Tests.** — Updated for the intended changes: `pages/{MyVisits,InviteVisitor,VisitDetail,Visitors,
VisitorProfile,Pass}Page.test.tsx`, `features/visits/{invitationText,visitEdit}.test.ts`,
`features/visitors/visitorFields.test.ts` (`visitorSearchDescription` is gone). New assertions: no description, hint or
time-zone sentence where they were; the summary in the header and its phone layout; the avatar row (decorative initials); the
highlighted visitor inside; the pass card's decorative QR picture, `dir="ltr"` link and one-line note; the product name on the
printed pass and the pass page; the empty states without a sentence.

**Gates.** `npm run typecheck` and `npm run lint` (0 warnings) pass. `npm test`: 122 files, 1298 passed, 1 failed: the
known `src/types/api.contract.test.ts` (the backend's `field_error_codes` section, not this area). Playwright was not run
(shared ports; the integrator runs the suite).

**Live check.** An API on 8832 and Vite on 5832 against a throwaway database (`vms_visits_p10v`: migrated, `seed-demo`, 16
visits through the API as `host@demo.local` with reception check-ins and check-outs, a failed invitation, a shared pass, a
cancellation, a no-show, visits moved into the past; dropped afterwards): My visits (all tabs, the empty search), invite
(form, validation, success with the pass card and QR dialog, the print view), the visit page (scheduled, inside, failed,
cancelled, no-show, completed, shared pass) and its dialogs, Visitors, the profile and the public pass (valid, invalid,
print) in Arabic and English at 1440, 820 and 390 px, a dark-scheme set, and the success view at 320 px. axe-core
(wcag2a/aa, 2.1, 2.2 AA, best practices) on 19 pages and dialogs × 2 languages × 2 schemes × 1440/390 px (152 checks): no
serious or critical violation after the tab fix (F10-visits-3). No horizontal scroll at 320 px on any of these pages in
either language after the date fix (F10-visits-2). Screenshots: the scratchpad's `phase10b-shots/visits/final/`
(`dark-scheme/`; `before/` the screens before this pass).

## Integration: field error codes, one kit across the areas, the gates and the live check (2026-10-07)

Scope: the integration of the brand pass (F10-27…33), the backend's B10-16…21 and the four feature areas above
(reception, visits, analytics, admin), which worked in parallel. Files: `src/types/api.ts` and its contract test,
`src/api/client.ts`, `src/i18n/fieldMessages.ts`, `src/utils/forms.ts`, the `errors` catalogs; the kit
(`Tabs`, `Card`, `Dialog`, `MetaLine`, `DateRangeFields`, `ListPanel` (moved here), `PageHeader`, `buttonStyles`);
screens of every area where the same element was built differently; the catalogs (decision 3 sweep);
`e2e/flows/acceptance.spec.ts` (one line); `frontend/README.md`, `docs/development.md` §8; the tests of these.
The user's decisions of 2026-10-07 apply unchanged. No backend file was changed.

F10-integration-1. **A 422's field errors are translated by their code (B10-18).** —
   - `api.ts`: `FieldErrorCode` (the 60 codes), `FieldErrorCodeEntry {code, params}`,
     `ValidationErrorDetails.field_codes`. `api.contract.test.ts` handles the snapshot's new `field_error_codes`
     section and checks `FieldErrorCode` against its keys (it failed in every area's run since 20:23).
   - `client.ts`: `getFieldErrorCodes(error)`, beside `getFieldErrors`, keyed by the same paths; it reads the
     wire defensively (an entry that is not `{code: string, params: object}` is left out, a parameter that is not
     a number, text or list of text is dropped) and types `code` as `FieldErrorCode | string`, since a newer
     server may send a code this build does not know.
   - `fieldMessages.ts`: `translateFieldError(message, entry, language)`, used by `resolveServerErrors` (so by
     every form through `useFormErrors`, the form-level alert included). English shows the server's own message,
     as for whole errors (F10-6: it is written for people and sometimes more specific than its code, "Email
     address is too long." is `too_long`). Arabic shows `errors:fieldCodes.<code>` filled with the code's
     parameters: a list is joined («ar، en»), and the parameter that counts (`min`, `max`, `max_days`,
     `max_hours`, `count`) is also i18next's `count`, so the six Arabic plural forms apply (12 → «12 حرفًا»,
     320 → «320 حرفًا», 101 → «101 حرف»). A code the catalog does not know, a field without a code (an older
     server) or a counted code whose number did not arrive keeps the server's words: nothing is hidden.
   - *Interpretation: the English message-matching table is gone, not kept as a second fallback.* It was the
     brittle workaround the codes replace (it broke silently on any rewording, the reason for B10-18); the SPA and
     the API ship together, and a mismatched pair still shows the server's words. Its `errors:fields.*` group (with
     keys that never matched a field error at all: `departmentTaken` and `visitorRegisteredElsewhere` are 409s)
     became `errors:fieldCodes.*`, one key per code, the English text the server's default wording; the
     Arabic texts were carried over, plus `invalid_json`, `offset_required`, `offset_not_allowed`,
     `out_of_range`, `unstorable_value`, `password_unchanged`, `duplicates` (generic now) and `visit_too_long`
     (counted now).
   - Scan warnings were already translated by their code (`reception:scan.warnings.<code>`, `scanNotices`);
     unchanged.
   - Tests: `fieldMessages.test.ts` (rewritten: English unchanged; Arabic by code, also for reworded server
     messages; parameters and plurals; unknown code, no code, missing count; and the catalog against the
     snapshot: both languages have a text for exactly the contract's codes, each uses only its code's
     parameters, plural forms exactly for the counted codes), `client.test.ts` (parsing, malformed entries),
     `forms.test.ts` (Arabic by code per path and in the form alert; English untouched), `arabicUi.test.tsx`
     (its 422 mock now carries `field_codes`, as the real server does), `api.contract.test.ts` (63 tests).

F10-integration-2. **Kit fixes for what the areas worked around locally; the local copies removed.** —
   - `Tabs`, phone grid (`phoneLayout="grid"`): the selected segment keeps its raised fill below `sm` (the
     surface colour had left its ink label at about 1.1:1 on dark surfaces), its focus ring, drawn outside the
     segment there, takes the focus colour, and the list draws no scroll shadows (their cover, the track's
     colour, painted bands at both edges of the grid on the bare page, in both schemes). The reception's and My
     visits' track classes (F10-reception-4, F10-visits-3) are gone. Measured live at 390 px in the dark scheme
     on My visits and Reception: selected segment #27b5bb with ink text, ring #49cbd2 2 px outside.
   - `Card flush`: the body without its padding. `bodyClassName="p-0"` could not remove it (`cn` joins without
     merging; Tailwind emits `px-4` after `p-0`): the reports' Top hosts table sat inset by 16/20 px with its
     header band inside the padding, and the admin cards needed `p-0!` / `py-1!`. All four use `flush` now.
   - `Dialog`: a body only for content that renders (`Children.toArray`), so `{error && <Alert/>}` no longer
     draws an empty band, and without a body the footer drops its hairline (the header's separates).
   - `MetaLine stackOnPhones` replaces the two copies of `META_STACKED_ON_PHONES` (reports, history).
   - `DateRangeFields` is the one From/To pair again: its legend is visually hidden (the group's name for
     assistive technology), "From" and "To" are the visible labels, level with the rest of a filter row, a
     required range takes 9.5rem per date (always set), an optional one 10.5rem; the read-back is the group's
     description (sr-only) and the screen shows it as a header fact (`dateRangeFact`). The reports' and the
     history's own copies (F10-analytics-4/5) use it again, and the audit log, whose visible legend pushed its
     dates below the other filters, now has a level row and reads the dates back in its header too ("96 events ·
     From … to …", stacked on phones). The deprecated `timeZone` prop is gone.
   - `ListPanel` moved from `features/visits/` to `components/ui/` (exported) and gained an `xl` frame: it is the
     list card every searchable list uses (My visits, Visitors, a visitor's history and now Users and
     Departments).
   - Removed, unused: `PageHeader`/`Card` `description` (no caller after decision 3; `EmptyState.description`
     stays for server errors) and the Button `dark` variant (its one caller below). The `ink` tokens stay.

F10-integration-3. **The same element, one style, in every area.** —
   - Primary actions are the teal `primary` everywhere: the admin dashboard's "Invite visitor" was C's dark ink
     button while My visits' was teal.
   - Lists: Users and Departments were the only lists with their filters on the bare page above a separate
     table card; they are list cards now, as My visits and Visitors: the search (label visually hidden, a
     placeholder) and the selects (named by `aria-label`, showing their current option) as the card's header row,
     the rows, the pagination. The accessible names are unchanged ("Search users", "Role", "Status").
   - Quick choices are segmented everywhere: the invitation's delivery ("Email the invitation" / "I'll share the
     pass myself") joins the walk-in stay and reason and the default language. `e2e/flows/acceptance.spec.ts`
     chooses it with the suite's `chooseRadio` (the native radio is visually hidden), as the visits area proposed.
   - Search placeholders worded alike: the three searches of the same visitor records (Visitors, the
     returning-visitor picker, reception's Find a visitor) all say "Name, email, phone or company" («الاسم أو
     البريد الإلكتروني أو الهاتف أو الشركة»; they said it three ways, one with "Search by …"); Users "Name or
     email", My visits "Visitor, company or email". The history keeps its measured "Visitor, company, host"
     («زائر، شركة، مضيف»): "Visitor, company or host" was cut at 1440 px in the live check. Three unit-test lines
     followed; no E2E spec reads a placeholder.
   - Today's lists at reception (the Expected tab, "Expected next" on the Scan tab) time a visit that ends after
     midnight as "from 23:15" (`formatTodayVisitTime`, as the visitor search does) instead of two full dates,
     which wrapped into six lines on a phone.
   - A visit across midnight in the history's date cell: the times under the date read "23:45 – Thu, 8 Oct, 00:30"
     (`formatVisitTimes`, only the later day named) instead of both dates in full over four lines.
   - The reception's "Checked in" fact of a visitor who has left (a refused scan of a completed visit, Find a
     visitor) read "09:02 · 8h 3m inside", counted up to now: it reads "09:02 · out 09:50" (`inside.timeAndOut`,
     both languages), and `timeInside` stops at the check-out (the reception area's own follow-up).
   - The audit log's details read the catalog in English too ("Arabic name", "Session ID", "Check-in method",
     "Merged events" instead of the humanised codes "Name ar", "Session id", "Check in method", "Coalesced");
     an unknown key still reads as words.

F10-integration-4. **Decision 3, swept across both catalogs and the source.** — Every English text was read
(1,314 keys) and every key checked for a reference in the source (none unreferenced). Removed in both languages:
the badge tooltips, which explained mechanics (`visits:insideFlags.previousDayDescription`, `overdueDescription`,
`methodDescriptions.*`; `InsideFlag.description`, `VisitMethodBadge.description` and `VISIT_METHOD_DESCRIPTIONS`
went with them: a badge is its icon and name); the department deactivation's sentence (`admin:departments.
deactivateDescription`: a deactivation is undone by Reactivate, so it is not the irreversible action decision 3
allows one sentence for); the resend dialog's description (`visits:resend.description`: with "The previous QR code
will stop working" it made two sentences; the warning is the one kept); the pass page's reason in "Keep this page
open or take a screenshot, so you can show the code without a connection." Kept, as decision 3 allows: errors and
validation, data and counts, status lines, one sentence per irreversible confirmation (cancel a visit, check out,
bulk check-out, leave without saving), the one-time password warning, the password rules, the camera's error
recoveries, the pass page's instruction and its two things to have ready.

F10-integration-5. **Tests changed for the intended changes.** — `Tabs.test` (selected fill, ring colour, no
scroll shadows in the phone grid), `DateRangeFields.test` (hidden legend, visible From/To, sr-only read-back,
`dateRangeFact`, 9.5rem when required), `directionC.test` (`Card flush`, `MetaLine stackOnPhones`), `Dialog.test`
(no empty body, no second hairline), `HistoryPage.test` (no tooltip), `DepartmentsPage.test` (title-only
deactivation), `VisitDetailPage.test` (one warning in the resend dialog), `AdminDashboardPage.test` (comment),
`auditLabels.test` / `AuditLogPage.test` (English labels from the catalog), `ReceptionLists.test` (new: a visit
past midnight), `visitActions.test` (new: the stay and check-out of a visitor who left), `format.test` (new:
`formatVisitTimes`), placeholders in `UsersPage`, `InviteVisitorPage`, `VisitorsPage` tests.

F10-integration-6. **Gates (2026-10-07, reference machine).** —
   - Backend (`backend/`, no backend file changed by this work): `ruff check .` all checks passed; `ruff format
     --check .` 251 files already formatted; `mypy` no issues in 134 source files; `pytest` 2872 passed, 3 skipped
     (the opt-in volume checks), 261.5 s; `pytest --committed-first` 2872 passed, 3 skipped, 261.2 s.
   - Frontend (`frontend/`): `npm run typecheck` and `npm run e2e:typecheck` pass; `npm run lint` 0 warnings;
     `npm test` 122 files, 1315 tests passed (run twice on the final tree, both green; at the start of this work
     1 failed, the contract test); `npm run build -- --outDir <scratchpad> --emptyOutDir` passes (stylesheet
     89.1 kB / 16.2 kB gzip; start-up `app` chunk 250.3 kB / 71.8 kB gzip).
   - Playwright, the full suite (`npm run e2e -- --retries=0`, ports 5199/8700, `vms_e2e`): 215 passed, 14 skipped,
     0 failed (6.7 min); after the last three fixes again on the final tree: 215 passed, 14 skipped, 0 failed
     (6.6 min).
   - Deployment files: `unittest discover -s deploy/verify` 27 tests OK; `check_nginx_headers.mjs` 7 headers in
     sync; `check_release_tree.py` OK, 879 files.

F10-integration-7. **Live check.** — An API on 8930 and Vite on 5930 against a throwaway database
(`vms_integration_p10b`: migrated, `seed-demo`, then realistic visits through the API: completed visits moved to
earlier days on that database only, two no-shows by `e2e-time-travel` and `mark-no-shows`, visitors inside now, one
from the previous day and one overdue, a delivery walk-in, expected visits with a failed invitation, upcoming and
cancelled ones; dropped afterwards, with its outbox), the outbox e-mail provider. In Arabic, then in English (the
switch in the sidebar at 1440 px; the account preference at 390 px): sign in as `host@demo.local`, invite a visitor
through the form, open the pass page from the link in the outbox's invitation (a fresh browser, no session), sign in as
`reception@demo.local` and check the visitor in by pasting the pass link (Chromium with a fake camera); sign in as
`manager@` and `admin@demo.local` for the history, the reports and the administration. Every flow passed in both
languages at both widths. Every main screen (sign-in, My visits, invite, invite success, visit detail, visitors,
visitor profile, pass, reception: idle, valid pass, checked in, Expected; inside, history, reports, admin dashboard,
users, departments, settings, audit log, 404) in Arabic and English at 1440 and 390 px: 84 screenshots in the
scratchpad's `phase10b-shots/final/` (`<language>-<width>-<nn>-<screen>.png`), and the phone tabs in the dark scheme
in `final/dark-scheme/`. No script error, no failed API call (5xx), no horizontal overflow on any of them. Titles end
with «زوار موضوع» / "Mawdoo3 Visitors". The invitation limit was met once by the many invitations of this check (the
form said «بلغت الدعوات الحد المسموح…», as it should); the throwaway API was restarted with a higher
`INVITATION_DAILY_LIMIT`. What looked unfinished was fixed and re-shot (F10-integration-3: the users and departments
cards, the admin's dark button, today's lists at reception, the history's date cell and placeholder, the tab bands).
The demo on 8000/5173, `vms` and the root `.env` were not touched.

**Left open (not this work's to change).** The project documents still say "Visitor Management" in places and
`docs/development.md` §5 still quotes the phase 9 gate counts (the docs phase, as the backend hand-over says).
Native date inputs show the browser's format (mm/dd/yyyy in an English Chromium); the app reads every chosen date back
in its own format. E-mails were seen in Chromium only (B10-17), the camera with Chromium's fake device only. The demo's
restart after `seed-demo` and its `EMAIL_FROM` are the lead's (backend hand-over).

## Review fixes: line breaks, Arabic wording, the audit vocabulary and the last layout details (2026-10-08)

Scope: the frontend (`src/utils/datetime.ts`, `src/features/**`, `src/components/ui/{Dialog,Alert,StatTile,DataLine,tableStyles}`,
`src/layouts/AppLayout.tsx`, `src/pages/ResetPasswordPage.tsx`, every catalog in both languages, the tests of these, three E2E
specs and one new one) and, for the e-mails, `backend/app/email/{formatting,i18n}.py`, the invitation template and the e-mail
tests that quote them. The user's decisions of 2026-10-07 apply unchanged. English wording is unchanged except where a finding
asked for it (named below); every E2E selector still matches. Each fix is at its cause, each with a regression test.

F10-rf-1. **A date or a time range never breaks in the middle (findings "Arabic dates and time ranges break", twice).** —
The en dash is a line-break opportunity (UAX #14 class BA) and the Levantine month names are two words, so an Arabic cell read
«…، 00:00–» / «00:45» or «8 تشرين» / «الأول».
   - `utils/datetime.ts`: an Arabic date keeps its day, month and year together with no-break spaces (U+00A0; the space after
     the weekday's comma stays a break opportunity), in every formatter that writes one (`formatDate`, `formatShortDate`,
     `formatDateKey`, `formatDayMonth`, and so everything built on them). `joinTimeRange` writes a closed range with a word
     joiner (U+2060) after the dash, `joinSpacedRange` a spaced one with a no-break space before it (the dash stays with the
     start; the line may break after it). `formatTimeRange`, `features/visits/format.ts` (`formatVisitTimes`,
     `formatVisitDateRange`, `formatVisitWhen`, `formatTodayVisitTime`) and the reports' hour labels use them. A line can now
     break only after a comma: after the weekday, and between a date and its time.
   - *Interpretation: the range binding applies in English too* (the same "00:00–" / "00:45" break exists there at narrow
     widths; the characters are invisible and ignored by screen readers); English dates keep their fixed format (one-word
     months), so the English text reads byte for byte as before apart from those invisible characters. Testing Library and
     Playwright read a no-break space as a space; the unit tests that compare formatted ranges exactly now spell the joiner
     (`'09:00–⁠10:00'`).
   - E-mails (`app/email/formatting.py`): the same rule for Arabic dates and the zone label («بتوقيت عمّان، UTC+3», which wrapped
     inside its brackets), and a time range with no-break spaces around its dash. Another day's time now has a separator: «الثلاثاء،
     6 تشرين الأول، الساعة 00:30» / "Tue, 6 Oct, 00:30" (it read «… الأول 00:30»). Subjects keep plain spaces (`translate`
     replaces the no-break ones): a header is one line, and people search their mailbox for «تشرين الأول» as they type it. The
     pass card's two big window values follow the section's direction instead of `dir="ltr"`, which put an Arabic date's time
     first.
   - Found in the live check: an Arabic duration split between a number and its unit («(قبل 2 س 26» / «د)» in the scan's
     headline). The Arabic duration texts join each number to its unit with a no-break space («2 س 26 د» may break only
     between the hours and the minutes); English unchanged.
   - Tests: `datetime.test.ts` "never breaks an Arabic date or a time range across lines" (the break opportunities of a formatted
     Arabic date and range are only after its two commas), the Arabic expectations with their no-break spaces, `momentOnDay`;
     backend `test_email_templates.py` (dates, zone label, spans and the window values with their no-break spaces; `_read`
     reads a no-break space as the space it looks like).

F10-rf-2. **«الساعة» only before a time (finding "«الساعة» placed before a full date").** — A sentence that names a moment on
the reference day or on another has two keys, so each language words both: `scan.alreadyInAt` / `scan.alreadyInOn`,
`walkIn.stay.hint` / `walkIn.stay.hintOn`, and `scan.onDay` now takes the date and the time. `momentOnDay(value, referenceDay,
zone)` (utils/datetime) gives `{ sameDay, date, time }`. English reads exactly as before ("Already checked in at Mon, 5 Oct 2026,
21:48 (11h 22m ago)"); Arabic says «سبق تسجيل الدخول يوم الاثنين، 5 تشرين الأول 2026 الساعة 21:48 (قبل 11 س 22 د)» and «المغادرة
يوم … نحو الساعة …». *Checked and left as they are:* `override.contextExpired` and `override.contextNotYet`, which the finding
also names, are only ever filled with a time of the day (`visitActions.ts`, `formatTime`): the override is offered for a visit of
the current company day only (E9-7), so their «الساعة {{time}}» is right. Tests: `ReceptionScanner.test` (an earlier day's
check-in in English and in Arabic, and no «الساعة» before a weekday), `scanOutcome.test` (the Arabic refusal titles).

F10-rf-3. **Arabic without a man's grammar for a named person; one term for checking in; the wording the review read as a
translation (findings "Masculine wording", "Two Arabic terms for check-in", "Arabic wording that reads like a translation",
"The Arabic No-show chip is cut off").** — Arabic catalog edits only; English unchanged.
   - A sentence whose subject is a person's name is worded without gender (the pattern `timeline.by` already used): «أُلغيت الزيارة
     بواسطة {{name}}», «أُلغيت بواسطة {{name}} يوم {{when}}.», «سُجّل الدخول بواسطة {{name}}» / «سُجّل الخروج بواسطة {{name}}», «سبق تسجيل دخول
     {{name}}.», «سبق تسجيل الدخول…», «سُجّل الخروج {{when}}», «الدخول {{when}}», «يمكن تسجيل دخول {{name}}. تحقّق من الهوية.», «الحساب نفسه»,
     «أُنشئت بواسطة», «طُبعت بواسطة {{name}}.», «لم يُسجَّل الدخول قط», the user dialogs' «باستضافة {{name}}» and «حساب {{name}}», and the
     visitor-neutral reception lines («وصول مبكر: …», «حان الموعد», «بعد الموعد · …», «ما زالت الزيارة جارية بعد انتهاء موعدها.», the
     override reasons «وصول متأخر – بتأكيد المضيف», the examples «المغادرة دون تسجيل الخروج»). The generic «الزائر» and «المضيف» keep
     the grammatical masculine, as Arabic interfaces do.
   - Roles are named as functions and teams, as English names "Reception" and "Management": «إدارة النظام»، «الموظفون»، «الاستقبال»،
     «الإدارة العليا» (they were «مدير النظام»، «موظف»، «موظف استقبال»: a man's job title on a woman's row). *Interpretation:* "Employee"
     became the team «الموظفون», like the dashboard's own «الموظفون» count, rather than a function noun that English does not say.
   - Checking a visitor in is «تسجيل الدخول» everywhere, as in every button, chip, timeline and report: the five error messages that
     said «تسجيل الوصول / وصوله» (`VISIT_ALREADY_CHECKED_IN`, `VISIT_NOT_CHECKED_IN`, `VISITOR_ALREADY_INSIDE`, `PASS_REVOKED`,
     `OVERRIDE_NOT_ALLOWED`) and the e-mails («تسجيل الدخول من», «يمكنك تسجيل الدخول ابتداءً من…», «سيسجّل الاستقبال دخولك…»). The host's
     e-mail: subject «زائرك {visitor} في الاستقبال», heading «زائرك في الاستقبال», body «زائرك {visitor} في الاستقبال، وقد سُجّل الدخول الساعة …».
     The arrival ("وصول") stays the word for arriving, not for the act of checking in.
   - Wording: «عدد الزوار المختلفين» (Unique visitors; «الفعليون» meant "actual"), the outcomes in one subject, the visit («حضرها الزائر /
     لم يحضرها الزائر / أُلغيت / ما زالت متوقعة»), «عمليات الدخول» and «… عمليات خروج», «زائر مسجّل» (Returning visitor; «سابق» read
     "former"), «صالحة يوم …» and «صدرت يوم …» on the pass card, «داخل المبنى الآن» in the navigation (as the page and the KPI), «المضيف: … ·
     الدخول …» with its colon, «قد يُطلب منك في الاستقبال إبراز هوية…» on the visitor's pass.
   - The No-show chip is «لم يحضر», as short as «مجدولة / تم الدخول / تم الخروج / ملغاة» (it was cut to «لم يحضر الز…» in My visits'
     status column); My visits' "Attended" / "No-shows" options are «حضر الزائر» / «لم يحضر».
   - Tests: `catalogs.test.ts` "say «تسجيل الدخول» for checking a visitor in…" (no «تسجيل الوصول», no «مسجّل دخوله», no «حسابه الخاص»
     in any Arabic text), backend `test_email_i18n.py` `test_arabic_texts_say_checking_in_as_the_interface_does`, the e-mail tests
     that quote the arrival e-mail, the live check's DOM scan for truncated chips (none).

F10-rf-4. **The audit log speaks Arabic for every key and value the backend writes (finding "English text in the Arabic audit
log").** — `admin:audit.metadataKeys` gained the 19 keys the backend writes that had no words (`duration_seconds`, `from_status`,
`has_email`, `host_id`, `host_notified`, `id_verified`, `invitation_requested`, `notice`, `notice_limited_by`, `reason_given`,
`recipient_domain`, `trigger`, `visitor_link_in_scope`, `visitor_notified`, `visitor_reused`, `added`, `removed`,
`session_revoked`, `overflow`), and `audit.values` the values: the 26 rate-limit policies, the CSRF reasons, the sign-in
reasons the backend really writes (`inactive`, `password_expired`; the catalog had `inactive_account`, which it never wrote),
`ROTATED` and `VISITOR_EMAIL_CHANGED` (the catalog had a lower-case `rotated`), `interrupted`, `cli`, `visit_inline`,
`visitors_api`, `user`, `host_unavailable`, `create`, `update`, `limited`, and short words for the refusal codes («سبق تسجيل الدخول»
for `VISIT_ALREADY_CHECKED_IN`, …). An error code the vocabulary does not know reads as its `errors:codes` message (without its
full stop) before it would be humanised (`auditCodeText`); walk-in reasons read through the visits' table; HTTP methods
(`GET`, `PATCH`, …) stay as written, a company-local date (`checked_in_before`) is a date and `duration_seconds` a duration
(`metadataValueText`, `formatMetadataValue(value, key)`).
   - Test `auditVocabulary.test.ts` reads the backend's source, as `auditLabels.test.ts` reads its action names: the keys of
     every audit metadata dict (`metadata={…}`, `metadata: … = {…}`, `event_metadata`, the dicts given to `_audit*(…)`, the
     `*metadata*()` helpers, `metadata["…"] =`, the coalescer's `_emit(…, overflow=True)`), and the values (those dicts' strings,
     the `reason=`/`operation=`/`trigger=` literals, the sign-in and password-change reasons, the enums written as values, every
     contract error code, every field of the update requests). Every key has words in both languages, every value has words and
     none of the Arabic ones a Latin letter (QR and UTC aside). A new key or value in the backend fails it until the catalog has
     words for it. *Interpretation: the finding proposed a list exported by the backend (a contract section or a constant); this
     work stays in the frontend (and the e-mails), so the test reads the source instead. A backend constant would make it simpler.*

F10-rf-5. **Data in another script keeps its place (finding "an Arabic host name and department run together").** —
`components/ui/DataLine` renders items of data with " · " between them, each in a `<bdi>` (an isolate), so two Arabic values in
the English UI no longer merge into one right-to-left run ("Host العمليات · عمر خليل"). Used for the reception rows' host and
department (the host's name isolated inside "Host …" too, through `withParts`), "Expected next", the returning-visitor picker's
details, the host picker's department and phone, and the visit timeline's facts. `<bdi>` rather than U+2068/U+2069 in the
catalog: the text content stays as it was, so `toContainText('Host Lina Haddad')` (walk-in flow) still matches. Test:
`ReceptionLists.test` (two isolates, in order).

F10-rf-6. **Dialogs (findings "lopsided header", "confirmations do not announce their one consequence sentence").** —
   - `Dialog`: the close button keeps its 44 px target but adds no height (`-my-2.5`): a title-only header has 16 px above and
     below the title, the button's centre level with the title's first line (it was 16 px above and 36 px below, the icon 10 px
     lower). The dialogs E2E spec now measures every dialog's header: the same space above and below the title block (±1.5 px)
     and the close button's centre on the title's first line (±2 px), at 1440 and 820 px.
   - `Dialog describedBy` and `Alert id`: the resend and issue-pass alertdialogs are described by their warning, «سيتوقف رمز QR
     السابق عن العمل», kept in its yellow style (and the resend after a failure by the failure line too), so a screen reader hears it
     with the title though focus starts on "Keep". Tests: `Dialog.test`, `VisitDetailPage.test` (`toHaveAccessibleDescription`
     on both).

F10-rf-7. **Layout details.** —
   - My visits' status choice is as wide as its longest option on phones (it was a fixed 160 px that cut "All but cancelled" and
     «الكل عدا الملغاة» mid-word); the search takes the rest. E2E (phone): every option fits the select's text area at 390, 360 and
     320 px, in English and Arabic (measured with the select's own font; the old width fails it: 127 px needed, 104 px of room).
   - History's host filter says "All hosts" / «كل المضيفين» when empty (`HostPicker placeholder`, `history:filters.hostAll`), as
     the department's says "All departments".
   - Audit log filters: "Clear filters" is the last cell of the grid, at its end (two rows of three from xl, no third row); "Record
     ID" lost its "(optional)" (every filter is optional).
   - Reports: a period without visits shows the five tiles in one row from xl, the dark tile one row tall with a numeral the size of
     the others (`data-empty-period`), instead of a 366 px dark block holding a lone 0.
   - Reception: the Checked out tile's sign-out icon is mirrored in Arabic (`CountTile.mirrorIcon`), as on the chips and buttons.
   - Reception's Expected row: on phones the action may wrap, centred, inside the row (`min-w-0`, `whitespace-normal`, the icon
     kept whole); «التحقق من الهوية وتسجيل الدخول» (314 px) crossed its 360 px card and the 320 px screen. The Inside filter's Arabic
     placeholder is «زائر، شركة، مضيف، غرض» (the history's style), whole at 360 px.
   - New E2E spec `e2e/quality/arabic-reflow.spec.ts` (phone project): a user of its own with the reception and employee roles,
     in Arabic, opens eight pages at 360 and 320 px; no page scrolls sideways, and no visible control lies outside the screen or
     outside the card around it (an RTL page's overflow to the left makes no scroll, which is why the English 320 px check could
     not see it). Against the old row it reports the review's numbers ("spans 33..347, outside 16..344"). It also found a phone
     number in the evacuation list's stacked card 8 px past a 320 px card: below 360 px the stacked tables' label column is 6 rem
     instead of 8 (`tableStyles`), and the number fits.

F10-rf-8. **Focus (findings "focus ring of the dark Inside now tile", "skip link").** —
   - `StatTile variant="emphasis"`: the dark set (`theme-dark`) applies to the tile's content, not to the tile; a linked tile's
     ring, drawn outside it on the page, is the page's teal (#188086, 4.16:1 on the canvas; it was the dark set's light
     turquoise, 1.73:1). E2E (focus-visibility): the ring of the admin dashboard's tile is at least 3:1 on all four sides.
   - Skip link: its padding is set with `focus:` after `focus:not-sr-only` (which resets padding to 0) and its ring lies inside the
     pill (`outline-offset: -5px`), in the page's focus colour on the pill (4.70:1), since the teal shell around it hid a teal
     ring. E2E: padding 8/16 px, the ring inside, ≥ 3:1 against the pill.

F10-rf-9. **The last notes, and a title.** — `visits:detail.outcome.noShowDescription` became `passExpiredOn`, the fact alone:
"Pass expired on {{when}}." / «انتهت صلاحية البطاقة يوم {{when}}.» (English changed, as the finding asked). The reschedule toast
whose e-mail cannot be told is its title alone ("Visit rescheduled"): `edit.rescheduledUnknown` is gone from both catalogs. The
reset-password page's document title follows its state ("Link invalid or expired", "Your password has been reset", or "Choose a
new password"), set by the form. Tests: `VisitDetailPage.test`, `visitEdit.test`, `ResetPasswordPage.test`.

F10-rf-10. **Found in the live check and fixed with the rest.** — The admin dashboard's count of administrators read «مديرو
النظام» beside the other rows' role names; it is «إدارة النظام», as the role. A wrapped Expected-row action is balanced
(`text-balance`: «التحقق من الهوية» / «وتسجيل الدخول», not a lone «الدخول»). An English purpose in the Arabic reception lists was cut
at its start ("…uct demo for the editorial team"): it is in its own direction (`dir="auto"`, aligned with `match-parent`, as the
history's purpose), so it loses its end. Test: `ReceptionLists.test`.

F10-rf-11. **Findings that repeat each other.** "Arabic dates and time ranges break…" is reported twice (the second adds the
e-mails), and "History's Host filter…" twice; each pair has one fix (F10-rf-1, F10-rf-7).

F10-rf-12. **Tests added or changed.** — New: `features/admin/auditVocabulary.test.ts` (6), `datetime.test.ts` (the break
rule, `momentOnDay`), `Dialog.test` (balanced header, `describedBy`), `directionC.test` (the emphasis link's focus colour),
`AppLayout.test` (the skip link), `ReceptionLists.test` (isolates, the purpose's direction, the mirrored sign-out icon, the
wrapping action), `ReceptionScanner.test` (an earlier day's check-in in English and Arabic), `scanOutcome.test` (Arabic titles),
`ReportsPage.test` (the empty period), `HistoryPage.test` ("All hosts"), `AuditLogPage.test` (no "(optional)", "Clear filters" in
the grid), `ResetPasswordPage.test` (titles), `MyVisitsPage.test` (the select's width), `catalogs.test.ts` (the check-in term);
E2E `quality/arabic-reflow.spec.ts` (new), `quality/dialogs.spec.ts` (header balance), `quality/focus-visibility.spec.ts` (the
dashboard tile's ring, the skip link); backend `test_email_i18n.py` (the check-in term). Changed for the intended changes: the
English tests that compare a formatted time range exactly (the joiner), the Arabic date and duration expectations (no-break
spaces), `visitEdit.test`, `VisitDetailPage.test`, `InsidePage.test`, `LanguageSwitcher.test`, `DateRangeFields.test`,
`ReportsPage.test` (the tiles' outer element), `AuditLogPage.test` ("Record ID"), and the backend e-mail tests that quote the
arrival e-mail and the Arabic dates (`test_email_templates.py`, `test_email_bidi.py`, `test_email_languages.py`).

**Gates (2026-10-08, reference machine).** Frontend: `npm run typecheck` and `npm run e2e:typecheck` pass, `npm run lint` 0
warnings, `npm test` 123 files, 1333 tests passed (1315 before this work);
`npm run build -- --outDir <scratchpad> --emptyOutDir` passes (stylesheet 89.8 kB / 16.3 kB gzip, start-up `app` chunk 258.5 kB /
73.7 kB gzip). Playwright, the full suite (`npm run e2e -- --retries=0`, ports 5199/8700, `vms_e2e`): 223 passed, 18 skipped, 0
failed (6.8 min), on the final tree; an earlier full run during the work had the same counts (7.1 min). The 8 more passes and 4
more skips are the new specs (the reflow spec runs on the phone project only; the two focus tests on all three). Backend (the
e-mail files changed): `ruff check .` clean, `ruff format --check .` 251 files formatted, `mypy` clean on 134 source files,
`pytest` 2970 passed, 3 skipped (the opt-in volume checks), 321 s.

**Live check.** An API on 8970 and Vite on 5970 against a throwaway database (`vms_fefix_p10d`: migrated, `seed-demo`, realistic
visits through the API: completed ones moved to earlier days, one across midnight, two no-shows, visitors inside, one since the
previous evening, a delivery walk-in, a refused check-in, a visit cancelled by a host with a woman's name; dropped afterwards,
twice). Every main screen in Arabic and English at 1440 and 390 px and the Arabic set in the dark scheme, plus the states of the
findings (the reset page's invalid link, the resend dialog, a no-show and a cancelled visit, the two scans, the Expected tab at 360
and 320 px, the empty report period) and the invitation and host-arrival e-mails at 640 and 390 px: 220 screenshots in the
scratchpad's `phase10b-shots/final/` (`dark-scheme/`; `email-*`). Each screen was measured in the page: no horizontal overflow, no
truncated status chip, no control outside its card, document titles ending with «زوار موضوع» / "Mawdoo3 Visitors", no script error
and no 5xx. The demo on 8000/5173, `vms` and the root `.env` were not touched.

**Left open.** Two older English dark-scheme screenshots in `final/dark-scheme/` (`en-390-my-visits-dark.png`,
`en-390-reception-dark.png`, from the integration pass) were not retaken: the dark set of this check is the Arabic one. A backend
list of the audit metadata vocabulary (a contract section) would let `auditVocabulary.test.ts` drop its source reading.

## Final touches: a role beside a person, and the brand sweep (2026-10-08)

Scope: the `common` and `admin` catalogs (both languages), `src/auth/roles.ts`, `src/layouts/UserMenu.tsx`,
`src/features/admin/{UserDirectory.tsx,userForm.ts,auditFormat.ts}` and their tests; for the brand sweep the image labels
(`frontend/Dockerfile`, `backend/Dockerfile`), `backend/pyproject.toml`, `deploy/verify/smoke_test.py`, one docstring and one
Arabic e-mail sentence of `backend/app/email/i18n.py` (backend B10-22), and a new repository check
`deploy/verify/test_brand_names.py`. English UI text is unchanged; no E2E spec reads a changed text.

F10-final-1. **A role has two names: beside a person, and as a group.** — F10-rf-3 named every role as a team («الموظفون»,
«الاستقبال», «إدارة النظام»). Under one person's name that reads wrongly («عمر خليل · الموظفون»). Lead decision, applied:
   - `common:roles.person.*`: beside one person, the job title in the singular: «مدير النظام», «موظف», «موظف استقبال»,
     «الإدارة العليا» (the generic masculine, the standard professional form of a job title). Used by the shell's user block and
     the account menu's header (`UserMenu`), the role chips of the users list, the role tiles of the add and edit dialogs
     (`ROLE_OPTIONS`), and the roles in the audit log's details. *Interpretation: the lead did not name the audit log; its role
     values (`roles`, `previous_roles`, `added`, `removed`) are always one account's, so they read as beside a person:
     «الأدوار المضافة: موظف، موظف استقبال».*
   - `common:roles.group.*`: where people are counted or picked out by their role, the teams: «إدارة النظام», «الموظفون»,
     «الاستقبال», «الإدارة العليا». Used by the users list's role filter beside «كل الأدوار». The admin dashboard's counts keep
     their own keys (`admin:dashboard.accounts.*`, already the teams), so a dashboard row and the filtered list it opens say the
     same word.
   - English is the same in both sets ("Administrator", "Employee", "Reception", "Management"), as before.
   - In code, `ROLE_LABELS` became `PERSON_ROLE_LABELS` and `GROUP_ROLE_LABELS` (`auth/roles.ts`), so every caller chooses the
     context; nothing reads a role's name without one.
   - The user dialogs' sentences name a role as its tile does: «لا يمكنك إزالة دور مدير النظام عن نفسك.» and «دون دور «موظف»
     أو «مدير النظام» لا يعود حساب {{name}} مضيفًا: …» (they quoted the teams).
   - The password-changed e-mail's «وأبلغ مسؤول النظام» is now «وأبلغ مدير النظام»: one Arabic word for the administrator as a
     person, as the interface and the `LAST_ADMIN` error («مدير نظام نشط») say it (backend B10-22).
   - Tests (each fails when the team names stand beside a person, checked by restoring them): `catalogs.test.ts` (both sets in
     both languages; the dialogs' sentences quote the person names), `AppLayout.test.tsx` (an Arabic administrator's user block
     and menu header read «مدير النظام · موظف · موظف استقبال», no team name; the dashboard's accounts card keeps the teams),
     `UsersPage.test.tsx` (the chips in the singular, the filter's options the teams; the dialogs' tiles, the locked role's
     reason and the host-role warning), `auditLabels.test.ts` (an account's roles in Arabic).

F10-final-2. **Brand sweep: what still was not the product's name.** — The whole repository (without `node_modules`, `.venv`,
`dist` and the decision history) was searched for "Visitor Management", "Demo Company", "Visitor" as a brand or a sender's
name, and "VMS" shown to people: the catalogs, the manifest, `index.html`, the service worker, the e-mail templates, catalog and
subjects, the command-line output and help, the scripts' messages, the deployment configuration and its headers, the OpenAPI
title, the image labels and the configuration examples. The earlier passes (F10-8, F10-27, backend B10-5, B10-16, B10-21) had
fixed every user-visible one; what was left named the brand where the product is meant, or an identifier where a title is shown:
   - Image labels: `org.opencontainers.image.title` was the image name (`vms-backend`, `vms-frontend`); it is "Mawdoo3 Visitors
     API" / "Mawdoo3 Visitors web", the human-readable title registries and `docker inspect` show. The descriptions and the
     Dockerfiles' header comments say "Mawdoo3 Visitors API …" / "Mawdoo3 Visitors web application …" instead of the brand alone
     ("Mawdoo3 visitor-pass API", "Mawdoo3 web application"). The image names (`vms-backend:local`) stay identifiers.
   - `backend/pyproject.toml`'s description is "Mawdoo3 Visitors API (FastAPI + PostgreSQL)"; the smoke test's `--help` line is
     "Smoke test of a deployed Mawdoo3 Visitors stack …".
   - `backend/app/email/i18n.py`'s module docstring no longer quotes the old name.
   - Kept, as identifiers nobody reads as a name (B10-5, B10-21): the `vms` database, roles and compose project, the `VMS_*`
     settings, the `vms-*` file, image and cache names, cookie and storage keys, Message-IDs, the e-mails' CSS classes, the smoke
     test's User-Agent, the package names `visitor-management-*`, and the example host `vms.example.com` of the configuration
     examples (a placeholder an operator replaces; tests and documents use it too).
   - Regression test `deploy/verify/test_brand_names.py` (standard library, part of `unittest discover -s deploy/verify`): no
     retired name in any of those surfaces (one documented exception: the seed recognises "Demo Company" as the demo company's
     former name, B10-10); a self-check of the patterns (they find the old names and leave `VMS_SERVER_NAME`,
     `vms-backend:local`, `visitor-management-backend` and "Mawdoo3 Visitors <…>" alone); the manifest and the page title name the
     product in both languages; the images' title and description, the package description and the smoke test's help line start
     with or name "Mawdoo3 Visitors". It fails on the previous labels, package description and docstring (checked by restoring
     them).
   - Not edited here (other owners): the documents (`README.md`, `deploy/README.md`, `docs/architecture.md`,
     `docs/development.md`, `docs/security.md`, `docs/security-audit.md` and `docs/production-readiness.md` still say "Visitor
     Management" in titles or prose; `README.md` §10 and `docs/development.md` still show `EMAIL_FROM=Mawdoo3 <…>` where the
     default is `Mawdoo3 Visitors <…>`); the root `.env`'s header comment ("Visitor Management System"; its `EMAIL_FROM` already
     says "Mawdoo3 Visitors"); generated files (`backend/var/outbox/*` from before phase 10, `frontend/e2e/.artifacts/`); and
     the E2E spec titles and comments that call the demo tenant "Demo Company" (test names, not shown to users).

**Gates (2026-10-08).** Frontend: `npm run typecheck`, `npm run lint` (0 warnings) and `npm run e2e:typecheck` pass; `npm test`
123 files, 1338 tests passed (1333 before, plus the 5 new). Backend: `ruff check .` clean, `ruff format --check .` 251 files
formatted, `mypy` clean on 134 source files; the affected modules pass (`test_email_i18n.py`, `test_email_templates.py`,
`test_email_bidi.py`, `test_email_design.py`, `test_email.py`, `test_dependency_locks.py`, `test_config.py`,
`test_send_test_email.py`, `tests/integration/test_http_behaviour.py`), and the full `pytest`: 2971 passed, 3 skipped (the
opt-in volume checks; 2970 before, plus the new e-mail test), 233 s, on throwaway databases. Deployment: `ruff check deploy` and
`ruff format --check deploy` clean; `unittest discover -s deploy/verify -p "test_*.py"` 33 tests OK (27 plus the 6 new);
`check_release_tree.py` OK (883 files); `check_nginx_headers.mjs` 7 headers in sync. The full E2E suite was not run here (the
verifier runs it). No live check was made: the changes are catalog words in components whose rendering the unit tests read. The
demo on 8000/5173, `vms` and the root `.env` were not touched.

## Gap closure: the Arabic acceptance run's defects and the critic's findings (2026-10-08)

Scope: the findings of the final critic and the open issues of the Arabic acceptance run (production-readiness L-21 to
L-23, L-25, L-28, L-4). Files: `components/ui/{Toast.tsx,Checkbox.tsx}`, `features/admin/{auditFormat.ts,auditLabels.ts,
AuditEventSummary.tsx,TemporaryPasswordField.tsx,CreateUserDialog.tsx,EditUserDialog.tsx,RoleCheckboxes.tsx}`,
`features/reception/{ScanResultPanel.tsx,scanOutcome.ts,scanAnnouncement.ts,CameraView.tsx,ScanPanel.tsx,
useScanStation.ts,visitActions.ts,VisitActionDialog.tsx}`, `scanner/useQrDecodeLoop.ts`, `utils/duration.ts`,
`pages/PassPage.tsx`, `features/visits/PassActions.tsx`, the `common`, `admin`, `reception` and `pass` catalogs (both
languages), their tests, two new E2E specs and the changed E2E expectations. Backend: B10-23 (phase-10-backend.md).

F10-gap-1. **Toasts at the top centre at every width (L-21, "a toast covers the next visitor's check-in button").** —
From 640 px a toast sat for 6 s at the bottom inline-end corner. The acceptance run saw it over part of Check in on the
820 px tablet. Measured afterwards with the API mocked (a check-out toast, then a scan, at scroll top and scrolled to the
end, both languages), the defect was wider than reported: the toast covered Check in at 820 × 1180 (top), 1024 × 768,
1180 × 820, 1280 × 800 and 1440 × 900 (the whole button and Scan next there: from `lg` the result panel's action row ends
the inline-end column at the bottom of the screen); only 1920 × 1080 and the phone were clear. So "top up to `lg`" would
have left every desktop and landscape tablet broken. *Decision:* the phone's placement at every width: the region is
`fixed inset-x-0 top-0`, centred, with the safe-area inset; no breakpoint moves it. Below `lg` it lies over the app bar
(at 820 px its edge touches the language button by 4 px; the button's centre stays free), from `lg` over the middle of the
page header, which holds nothing to press. The bottom and the inline end are where this product's actions are: the
sticky action bars (walk-in, settings), dialog footers and the scan result. Measured again: no overlap at any of the
seven sizes, in either language, at either scroll position.
   - E2E `toast-placement.spec.ts`, new test in all three projects (1440, 820 and 390 px) and both languages: register a
     walk-in (its toast has a title and a description, the tallest the reception shows), scan the next pass while the
     toast is up, then, as the scan left the page and scrolled to the end, Check in and Scan next do not intersect the
     toast and no tap at their centre or 4 px inside a corner lands on it; the toast is centred in the top quarter.
     Against the old classes it fails at 820 and 1440 px in both languages ("Check in under the toast"). The phone test
     is unchanged. `Toast.test.tsx`: the region and its live regions carry no class that moves it to the bottom or an end.

F10-gap-2. **The audit chip words a value as the details do (L-22, "all six walk-in reasons show as English chips").** —
`auditEventQualifier` looked a value up in `audit.values` and the error codes only, then humanised it; the details
(`metadataValueText`) look in the app's own tables first (methods, roles, statuses, walk-in reasons). None of the six
walk-in reasons (`NO_INVITATION` … `OTHER`) is in `audit.values`, so every walk-in row of the Arabic list had an English
chip over «السبب: توصيل». *Root cause:* two lookups for one value. *Fix:* `auditEventQualifier` moved to `auditFormat.ts`
and returns `formatMetadataValue(value, key)`, the details' own words; `auditCodeLabel` is gone. Test
`auditVocabulary.test.ts`: every value the backend writes (the source reading of F10-rf-4), under each of `outcome`,
`reason`, `code` and `policy`, gives the chip exactly the details' words, in both languages, and no Latin letter in
Arabic; the six walk-in reasons in Arabic are «بدون دعوة»، «وصول مبكر»، «وصول متأخر»، «بطاقة مفقودة»، «توصيل»، «سبب آخر». With
the old lookup the test lists the walk-in reasons and the methods, roles and statuses whose chip differed from their
details ("System admin" over "Administrator", "Qr" over "QR code").

F10-gap-3. **The temporary password and its show/hide button are one left-to-right control (L-23).** — The input is
`dir="ltr"` (a password reads left to right), so its `pe-12` put the room for the button on the right, while the button's
`end-0` followed the right-to-left page and sat on the left, over the first two characters (critic's measure at 1440 px:
button 552.7–596.7, text from about 567). *Fix:* the box holding the input and the button is `dir="ltr"`, so both name the
right; the button sits at the end of the left-to-right text in both languages. (A physical `pl-12` for Arabic is ruled out
by the logical-properties rule of F10-10.) Tests: `TemporaryPasswordField.test.tsx` (new; in English and Arabic the
input's padding and the button's position resolve against the same direction, one box with `dir="ltr"`); E2E
`temporary-password-field.spec.ts` (new, API mocked, three projects, both languages): after Generate the button lies
wholly outside the input's content box (the box less its padding and border) and the password fits that box. Against the
old markup it fails in Arabic at all three widths with the critic's numbers (1440: button 552.7–596.7, content from 567.7).

F10-gap-4. **The kept explanatory notes go (the user's request 8; the critic: "the user never approved them").** —
Request 8 allows errors, validation, data and one short line before an irreversible action. The exceptions earlier passes
kept (F10-reception-10, F10-visits-7, F10-integration-4) were not that, and the user could not be asked here, so the rule
was applied:
   - The visitor's pass page (`PassPage`) and the pass the host prints (`PassActions`): no "Please present this QR code
     at reception when you arrive.", "Reception may ask you to show photo identification." or "Keep this page open or take
     a screenshot." The page is the product lockup, the "Visitor pass" card, the QR code, a perforation and Print; on paper
     the ink logo, the card and the code. The invitation e-mail that links to the page says what to do and what to bring
     (`invitation.step_*`). Keys `pass:instructions` and `pass:tips.*` removed. *Supersedes* the contract's "renders the
     QR client-side with generic instructions" (initial-assessment §6; hand-over to the contract owner).
   - Reception's camera: no "Not reading? Hold the code steady, about 15–20 cm from the camera, in good light." Its timer
     ran whenever nobody stood at the camera, so for most of an idle day the live label was that yellow advice. The hint
     state left `useQrDecodeLoop`, `useScanStation`, `ScanPanel` and `CameraView`; the label says "Point the camera at the
     visitor's QR code" or "Scanning paused", and the camera's errors stay. *Supersedes* the contract's "poor-lighting
     hint after 8 s without a decode" (initial-assessment §10; hand-over).
   - The new account's dialog: the description and the field hint ("Pass the temporary password on now: it is shown only
     once." and "Expires after 72 hours.") became one line, the one request 8 allows before closing loses the password for
     good: "The temporary password is shown only once and expires after 72 hours." / «تُعرض كلمة المرور المؤقتة مرة واحدة
     فقط، وتنتهي صلاحيتها بعد 72 ساعة.» (a no-break space keeps 72 with its unit). `users.created.passwordHint` removed.
   - Editing one's own account: «لا يمكنك إزالة دور مدير النظام عن نفسك.» and «لا يمكنك تعطيل حسابك.» no longer stand under
     the controls. Each disabled control shows a lock (the role's tile, beside "Account is active") and keeps the sentence
     as its accessible description, read by screen readers with the control (`Checkbox hiddenDescription`, a visually
     hidden reason in `RoleCheckboxes`).
   - Kept, as request 8 allows: errors and their recoveries (the camera's errors), validation and the password rules,
     data and counts ("Leaves about 10:10 if checked in now.", "No phone number on record."), status lines, the "shown
     only once" line of the pass link and of the password, and one sentence per irreversible confirmation. Each removal
     is a catalog and component change of its own; restoring one is a revert if the user wants it back.
   - Tests: `PassPage.test` (the card holds only its title and Print, no list; Arabic too), `InviteVisitorPage.test` (the
     printed pass has no instructions), `CameraView.test` (a minute of scanning without a decode keeps the label and speaks
     nothing), `useQrDecodeLoop.test` (the hint test removed), `UsersPage.test` (the created dialog's one description, the
     password field without one; the locks and the visually hidden reasons as the controls' descriptions).

F10-gap-5. **A reception refusal is its title alone (request 8, "the refusal banners repeat the title as a subtitle").** —
The verdict showed the computed title and the server's message under it: «أُلغيت الزيارة بواسطة يارا حداد» over «أُلغيت هذه
الزيارة.», «انتهت صلاحية البطاقة الساعة 03:32» over «انتهت صلاحية بطاقة الزيارة هذه.». For four of the six refusal codes the
message only restates the title; for `HOST_INACTIVE` and `PASS_REVOKED` it adds advice the panel's actions give ("Register
the visitor as a walk-in…", "…verify their ID and check in manually"). *Decision:* the title alone for every refusal; the
server's message stays the title of an invalid pass, which has no computed title, and the override dialog's description
(why the pass cannot be used). The live region says the title once (it said title and message). Tests:
`ReceptionScanner.test` (in Arabic, a cancelled visit and an expired pass: the band reads exactly the title and the panel
does not contain the restated message; the status region the same; the English replaced, expired and completed cases),
`scanOutcome.test` (the announcement), E2E `flows/pass-outcomes.spec.ts` (the titles with their times; the messages absent).

F10-gap-6. **Under a minute in words in Arabic sentences (acceptance run: «قبل < 1 د» reads awkwardly).** — F10-26 made
the short duration «< 1 د», right in tables and figures but read as a formula inside a sentence: «سبق تسجيل الدخول الساعة 09:09
(قبل < 1 د)», «09:09 · منذ < 1 د في الداخل», «سُجّل الدخول قبل < 1 د», «يبدأ بعد < 1 د». `utils/duration` gained
`formatDurationInText` (under a minute: `duration.lessThanMinuteInText`, «أقل من دقيقة» / "< 1m") and `formatAgo` /
`formatIn` ("{{duration}} ago" / «قبل {{duration}}», "in {{duration}}" / «بعد {{duration}}»); the five templates take the
phrase (`scan.alreadyInAt|On`, `scan.notices.early|late`, `checkOutDialog.recentTitle`) and `timeInside` reads in text.
English reads byte for byte as before ("(< 1m ago)", "(starts in 10m)", "Checked in 3m ago"); Arabic changes only under a
minute: «قبل أقل من دقيقة», «بعد أقل من دقيقة», «منذ أقل من دقيقة في الداخل». Tables, the evacuation list, reports and the audit
keep «< 1 د». Tests: `duration.test.ts` (both languages, the dash for an unknown time), `ReceptionScanner.test` (in Arabic,
a check-in 30 s ago: the headline, the visit's facts and the check-out confirmation's title, no «<» anywhere).

F10-gap-7. **Checked and left as it is: one Arabic term for signing in and checking in.** — «تسجيل الدخول» / «تسجيل الخروج»
name both the staff's sign-in and sign-out and a visitor's check-in and check-out (acceptance run, "Low wording"). F10-rf-3
chose them for checking in on purpose: they are the terms Arabic interfaces and reception desks use for both, and the
contexts never meet: the staff's sign-out is only in the account menu, the sign-in only on the sign-in page, and every
visitor action stands in the visitor's row, scan result or dialog, under the visitor's name. Not a defect; no change.

F10-gap-8. **Not done here, and why.** —
   - Real delivery through Gmail (critic: "request 3 not verified end to end"). Sending through the demo's mailbox needs
     the mailbox owner's consent and the demo's credentials, which live in the root `.env` this work may not touch; the
     check, its order and what to look at are in production-readiness L-4 and README §10, and the dates of the earlier
     check are now stated wherever it is cited (README §10 and §15, production-readiness §1, §4, L-4, security.md §18).
   - The running demo's API (port 8000) was started at 02:28 and serves the code from before backend B10-22 («وأبلغ مدير
     النظام») and B10-23; Vite reloads the frontend by itself. Restarting it, `seed-demo` (which now also gives the demo
     company its Arabic address) and setting `QR_BASE_URL` to an address a phone can open are the lead's or the user's
     (hand-over below).
   - The seed's `demo.local` domain is kept (critic: "consider a neutral seed domain"): the six addresses are the demo's
     sign-in names, written in the README and the E2E suite, and `.local` is reserved, so no message to a seeded user can
     reach a stranger while the demo sends real e-mail. Changing them is the user's call (it changes how they sign in).

**Hand-over.** *Lead / user:* restart the demo API on 8000 at a convenient moment and run `python -m app.cli seed-demo` on
`vms` first (the Arabic address, audited, unless someone set an address in Settings); with the user's consent run
`send-test-email` and one real invitation through Gmail 465/ssl and record it (L-4); set `QR_BASE_URL` in the root `.env`
to the demo machine's LAN address or a public `https://` origin (L-26). *Contract owner:* initial-assessment.md's `/pass`
"generic instructions" (§6, D-20) and the camera's "poor-lighting hint after 8 s" (§10) are superseded by request 8
(F10-gap-4).

**Gates (2026-10-08, reference machine, the final tree, one at a time).** Frontend: `npm run typecheck` and
`npm run e2e:typecheck` pass; `npm run lint` 0 warnings and 0 errors on 497 files, 231 rules; `npm test` 124 files, 1349
tests passed (1338 before: the new `TemporaryPasswordField.test.tsx` 2, `auditVocabulary.test.ts` 3, `ReceptionScanner.test`
3, `duration.test.ts` 4, less the decode loop's hint test; 104.87 s); `npm run test:coverage` the same 1349, lines 96.55 %, branches
91.10 %; `npm run build` into a scratch folder: no warnings, 2,718 modules, the `app` chunk 258.24 / 73.46 kB (258.99 /
73.78 before), the stylesheet 89.75 / 16.27 kB. Playwright, the full suite (`npm run e2e -- --retries=0`, ports 5199/8700,
`vms_e2e`): 253 tests, 235 passed, 18 skipped, 0 failed, 0 flaky, 7.2 min; desktop 77 + 3, tablet 71 + 10, mobile 71 + 5,
flows 16 (the 12 more passes are the two new tests of `toast-placement.spec.ts` and the two of
`temporary-password-field.spec.ts` in three projects each). Backend (B10-23): `ruff check .` clean, `ruff format --check .`
251 files formatted, `mypy` clean on 134 source files, `pytest` 2974 passed and 3 skipped (304 s), `pytest
--committed-first` the same (309 s), `pytest --cov=app --cov-branch` the same, lines 97.97 %, branches 93.56 %. Deployment:
33 unit tests OK, `check_release_tree.py` 885 files, nginx headers 7 in sync, `ruff` on `deploy` clean. Afterwards the
cluster holds only `postgres`, `vms` and `vms_e2e`.

One full run failed once in `PassPage.test` ("expected '' to be 'Visitor pass · Mawdoo3 Visitors'"): the title is set by an
effect that can run a moment after the lazy page's first paint, a race the test had before this work (its synchronous
assertions after `findByRole` are the same); both title assertions now wait for it (`waitFor`). Three runs of the file and
the final full run passed.

**Live check.** Vite on 5991 with its proxy pointed away from the demo and the API mocked: the toast measured at 390 × 844,
820 × 1180, 1024 × 768, 1180 × 820, 1280 × 800, 1440 × 900 and 1920 × 1080 in both languages before and after the fix (the
numbers of F10-gap-1); the pass page at 390 and 1440 px in Arabic and English, on screen and in print media; Users → Add
user → Generate, the created dialog and the edit-own-account dialog in Arabic at 1440 px; a cancelled visit's and an
expired pass's scan in Arabic at 820 px (one line each: «أُلغيت الزيارة بواسطة يارا حداد», «انتهت صلاحية البطاقة الساعة 05:22»).
The screenshots are in the session scratchpad's `toastfix/` (`before/`, `after/`, `screens/`). The demo on 8000/5173,
`vms` and the root `.env` were not touched.

## The user's requests of 2026-10-08: invitations in one's own name, departments in the UI's language

Scope: `src/types/api.ts`, `src/i18n/departmentName.ts` (new), `src/features/visits/{inviteForm.ts,InviteVisitorForm.tsx,
pickers.tsx,InviteSuccess.tsx,VisitCards.tsx,VisitTable.tsx}`, `src/features/admin/{departmentForm.ts,DepartmentNameDialog.tsx,
DepartmentList.tsx,UserDirectory.tsx,settingsForm.ts,CompanySettingsForm.tsx}`, `src/features/history/{DepartmentFilter.tsx,
departmentFilterOptions.ts,HistoryTable.tsx}`, `src/features/inside/{EvacuationList.tsx,PrintableEvacuationList.tsx}`,
`src/features/reception/{VisitFacts.tsx,VisitRow.tsx,visitActions.ts}`, `src/features/visitors/VisitorHistoryTable.tsx`,
`src/features/reports/chartData.ts`, the `admin` and `errors` catalogs (both languages), the tests, five E2E specs' mock data and
two steps of `e2e/flows/acceptance.spec.ts`; `frontend/README.md` and one sentence of `docs/development.md`. The user's words:
«كل موظف بس يعمل invitation على اسمه ما يقدر يعمل على الباقيين» and «لما يكون محطوط انجليزي حتى ال department بدي اياه
انجليزي». Shared contract with the backend (backend B10-24 to B10-27): a caller without SYSTEM_ADMIN must send their own
`host_id` (else 422 on `host_id`, field code `host_must_be_self`); `name_ar` on every department and department count,
`address_ar` on the company settings; the UI shows `name_ar` / `address_ar` when it is Arabic and they are set.

F10-dept-1. **An employee invites in their own name; only an administrator chooses the host.** — `inviteForm.ts`
`canChooseHost(user)` (SYSTEM_ADMIN, §7.5; any other role combination is the host of the visits it creates).
   - Invite visitor, for everyone else: the Visit card keeps its two columns, "Host" / «المضيف» and the department, but the
     host is a read-only text field with the signed-in person's name (`readOnly`, sunken `read-only:bg-surface-muted`, not
     `aria-required`, still focusable and read with its label). *Interpretation (the contract allowed it or no field):* kept,
     because it states in whose name the invitation goes out (the user's own words, «على اسمه»), it keeps direction C's
     two-column row instead of a lone half-width department select, and it gives the server's refusal a field to stand on
     (the error is linked to it and focus moves to it, as for any field). The style is local, not the kit's: the read-only
     copy fields (the pass link, the new account's password) keep their look.
   - The request carries `hostFromMe(me.user).id` whatever the form state holds, and the form no longer asks
     `GET /users/hosts` for these users. The department still defaults to theirs (and is still a choice of the visit).
   - An administrator keeps the host picker, themselves by default (lead decision of the contract: administrators invite on
     behalf of others). Reception's walk-in form still names any host; visit edit never changed the host; the ownership rule
     for existing visits is the server's and unchanged.
   - The new field code in both catalogs: English is the server's "You can only invite visitors you host yourself."; Arabic
     «يمكنك دعوة الزوار باسمك فقط.» (the user's «على اسمه», and no verb that agrees with a man: «يمكنك» and «باسمك» are written
     the same for anyone).

F10-dept-2. **A department is named in the UI's language, by one module.** — `src/i18n/departmentName.ts`:
`departmentDisplayName(department, language)` (`name_ar` in Arabic when it is set and not blank, else `name`; a missing field,
from a mock or an older API, counts as unset), the hook `useDepartmentName()` (returns the labelling function and re-renders on a
switch; `''` for no department, so each caller keeps its own "—" or leaves the item out of a `DataLine`),
`departmentOtherName` (the name in the other language, for the administrators' list), `departmentSearchNames` and
`compareDepartmentNames(language)` (`Intl.Collator` of the UI language, digits by value; in Arabic the Arabic script sorts
before Latin, the language's own order). Applied wherever a department is shown: the invite and walk-in department select and
the user dialogs' (`DepartmentSelect`, sorted by the shown name), the host picker's option line, the visit tables and cards, the
visit page's facts and the invitation's outcome, reception's rows and scan facts, Inside now and its printed roll call, the
visit history and its department filter, a visitor's history, the users list, the reports' department chart, its data table and
"busiest" line (`departmentRows(items, language)`), and the administrators' department list, dialogs and toasts.
   - Finding by typing matches either name (the history's department filter, reception's inline filter of the Expected and
     Inside tabs): the Arabic UI still finds "Finance".
   - Not translated, as the contract says: what people type (visitor and host names, companies, purposes). The audit log shows
     the values the backend recorded (a department change records `changed_fields`, whose `name_ar` and `address_ar` have
     words in both languages).
   - The company's address is shown nowhere in the UI but its settings (the e-mails are the backend's, B10-26), so it needs
     no display helper.

F10-dept-3. **A test fails when a source reads a department's `name` itself.** — `src/i18n/departmentNameGuard.test.ts` builds a
TypeScript program of every non-test source under `src/` with `tsconfig.app.json`'s options and reports each `.name`,
`['name']` or destructured `name` whose property is declared by `DepartmentRef`, `Department` or `ReportSummary.by_department`
(in `api.ts`) or the helper's `DepartmentNames`, whatever the variable is called (`visit.department?.name`, `item.name`,
`({ id, name }) => …`, an intersection such as `DepartmentRef & { inactive }`). The company's `name`/`name_ar` is not a
department and is not reported. Exceptions (`ALLOWED`, with reasons): the helper itself and `features/admin/departmentForm.ts`
(the dialog edits the stored names and finds duplicates by them). A self-check compiles a sample source in memory and expects
exactly its six reads (and not `company.name` or `host.full_name`); a stale exception fails too. Before this change it listed
38 reads in 16 files; it runs in about 4 s (the program is built once). Tests and test support (`src/test/`, `testing/`,
`testRoutes.ts`) are not checked.

F10-dept-4. **Departments: two names in the dialog, both in the list.** — `DepartmentNameDialog.tsx`, `departmentForm.ts`,
`DepartmentList.tsx`.
   - The add and rename dialog has "Name" / «الاسم» (required, the default English name) and "Arabic name" / «الاسم بالعربية»
     (optional, typed right to left, `lang="ar"`), labels only, as the company settings' name and Arabic name.
   - Validation before sending: the name required; both at most 120 characters; neither may be another department's, compared
     trimmed and ignoring case (§4 and migration 0012's unique indexes), an inactive one saying it can be reactivated
     ("A department with this Arabic name already exists." / «يوجد قسم بهذا الاسم بالعربية.», and the inactive variant).
     A 409 from the server lands on the field its `details.field` names (`conflictField`).
   - Create sends `name_ar` only when one was typed; rename sends only what changed, a cleared Arabic name as `null`, and
     nothing when nothing changed (as before for the name). The toast says "Renamed to {name}" when the name people see
     changed, "{name} saved" / «حُفظ قسم {{name}}» when only the other language's name did (adding the Arabic name in the
     English UI is not a rename).
   - The list shows the name of the UI language, sorted by it, with the other language's name under it, muted, in its own
     language and direction (`lang`, `dir="auto"`, aligned with the cell; normal weight in the phone card too). A department
     with one name shows it alone. Titles and button names ("Rename Finance" / «تغيير اسم المالية») use the shown name.

F10-dept-5. **Company settings: the Arabic address.** — `settingsForm.ts`, `CompanySettingsForm.tsx`. The Company card reads
name | Arabic name, address | Arabic address, then the e-mail domain. "Arabic address" / «العنوان بالعربية» is a right-to-left
textarea with the address's rules (at most 1000 characters); a cleared one is sent as `null`; a settings answer without the
field (an older API, a mock) counts as none. *Wording:* the Arabic labels of the Arabic versions now read alike: the company's
«الاسم العربي» became «الاسم بالعربية», and so did the audit log's word for `name_ar`; `address_ar` has «العنوان بالعربية» in
the audit vocabulary (English "Arabic name", "Arabic address"). English UI text that existed is unchanged.

F10-dept-6. **`api.ts`.** — `DepartmentRef.name_ar` and `Department.name_ar` (`string | null`),
`ReportSummary.by_department[].name_ar`, `CompanySettings.address_ar`, `DepartmentCreate.name_ar?: string` (stricter than the
backend's `string | null`, which `api.contract.test.ts` allows for requests: the form never sends null on create),
`DepartmentUpdate.name_ar?: string | null`, `FieldErrorCode` `host_must_be_self`, and the host rule documented on
`VisitCreate.host_id`. `Me.company` carries no address, so it gained nothing. The backend's regenerated `backend-contract.json`
(13:00) matches: the contract test and the field-code catalog test pass against it.

F10-dept-7. **Tests.** — New: `i18n/departmentName.test.tsx` (7: both languages with and without an Arabic name, blank and
missing, the other name, sorting, the hook following a switch), `i18n/departmentNameGuard.test.ts` (3),
`features/visits/pickers.test.tsx` (2: the select's options and order in both languages, the host option's department),
`features/history/departmentFilterOptions.test.ts` (3), `features/admin/departmentForm.test.ts` (7). Added:
`InviteVisitorPage.test` (an employee's read-only host, no host lookup and their own id in the request; the server's
`host_must_be_self` on the Host field with focus; an administrator's picker sending the chosen host; the three host-picking
tests now sign in as an administrator), `DepartmentsPage.test` (the dialog's two fields; create with both names; change and
clear the Arabic name alone, no request without a change, "saved"; Arabic-name duplicates before sending and the server's 409 on
that field; the list in Arabic and English, sorted, with the other name), `CompanySettingsPage.test` (set and clear the Arabic
address; its limit), `InsidePage.test` (a department's Arabic name on screen and on paper in Arabic, its English name in
English), `chartData.test` (the report's department names and order per language), `inviteForm.test` (`canChooseHost`),
`fieldMessages.test` (the new code in Arabic and English). Fixtures gained `name_ar: null` / `address_ar: null`.
   - E2E (not run here; the integrator runs the suite): `flows/acceptance.spec.ts` §40 steps 7–8 expect the employee's
     read-only "Host" with their name and no host combobox (the request's `host_id` was already asserted), and step 2 fills
     the department dialog's "Name" with `exact: true` (Playwright's label match is a substring, and "Arabic name (optional)"
     contains it). The mocked specs' data gained the new fields; `evacuation-print-rtl.spec.ts` now gives its department
     `name: 'Finance', name_ar: 'المالية'`, so the Arabic sheet shows the same «المالية» through the new rule. `seed-e2e` has no
     Arabic names, so every English text the specs read is unchanged; no spec picked another host as an employee.

**Gates (2026-10-08).** `npm run typecheck` passes; `npm run lint` 0 warnings, 0 errors; `npm test` 129 files, 1383 tests
passed (1349 before, plus 34); `npm run e2e:typecheck` passes; `vite build` into a scratch folder: no warnings, 2,719 modules,
the `app` chunk 259.00 / 73.61 kB (258.24 / 73.46 before). Playwright was not run (the backend changed in parallel). Live check:
Vite on 5937 with its proxy pointed at a closed port and the API mocked in the browser (Playwright `route`), Arabic and English
at 1440 and 390 px: the employee's invite form (read-only host «عمر خليل», department «العمليات» / "Operations", no host
combobox), the administrator's host picker (each host's department in the UI language), the departments list (Arabic:
«العمليات» over "Operations", «المالية» over "Finance", … "Human Resources" alone; English sorted by the English names with the
Arabic under them), the rename dialog, the settings' Arabic address; no page error, no horizontal scroll. axe-core on those four
screens in both languages, both colour schemes, at 1440 and 390 px (32 checks): no violation. One defect found and fixed there:
in the phone card the other language's name inherited the card title's semibold weight. Screenshots: the session scratchpad's
`deptcheck/shots/`. The demo on 8000/5173, `vms` and the root `.env` were not touched.

**Hand-over.** *Integrator:* run the full E2E suite against the backend's B10-24 to B10-27. *Contract owner:*
initial-assessment §7.5's row "Create visit / invitation" becomes "SYSTEM_ADMIN ✓ (any host); EMPLOYEE ✓ (themselves as host
only)" (the frontend follows it already). *User:* after the backend's `seed-demo` converts the demo's departments (English names
with their Arabic names), the English UI shows "Finance", "IT", … and the Arabic UI «المالية»، «تقنية المعلومات»، … with no
further step.

### Integration with the backend's B10-24 to B10-28 (2026-10-08)

The integrator joined F10-dept-1 to 7 with the backend's work (phase-10-backend.md, B10-24 to B10-28 and its integration notes
INT-dept-1 to 4). No source file under `frontend/` changed: `api.ts` matched the backend's regenerated `backend-contract.json`
as delivered, and every gate passed on the first run.

- **Contract.** The snapshot was regenerated into a scratch file and is byte-identical to the one in `src/types/`.
  `api.contract.test.ts`, `fieldMessages.test.ts` (`host_must_be_self` in both catalogs) and `auditVocabulary.test.ts` pass.
- **Gates.**
  - `npm run typecheck` and `npm run e2e:typecheck`: 0 errors. `npm run lint`: 0 warnings and 0 errors on 503 files.
  - `npm test`: 129 files, 1,383 tests passed in 95.67 s.
  - `npm run build -- --outDir <scratchpad>`: 2,719 modules, no warning; `app` 259.00 / 73.61 kB.
  - `npm run e2e -- --retries=0`: 253 tests, 235 passed, 18 skipped, 0 failed, 7.7 minutes. This includes `flows/acceptance.spec.ts`
    §40 steps 7–8 with the employee's read-only "Host" and no host combobox, and step 2's exact "Name".
  - `cross-company.spec.ts` still passes its foreign `host_id` probe. Other Corp's employee naming Mawdoo3's host now gets
    `host_must_be_self` on `host_id`; the spec asserts only the field.
- **Live check** (API 8930, Vite 5930, a throwaway database that rehearsed the conversion of `vms`, both languages at 1440 and
  390 px; details in phase-10-backend.md, INT-dept-2 and 3, and its live check):
  - The employee's invite form shows the read-only host «عمر خليل» and no picker. The department select reads "Finance" in
    English (English options only) and «المالية» in Arabic.
  - The administrator's form keeps the picker. Choosing a host moves the department to that host's, in the UI language.
  - The departments list shows the UI-language name with the other language's name under it. Renaming only the Arabic name
    sends `{name_ar}` alone and toasts "Legal saved".
  - The settings' "Arabic address" saves `address_ar` alone.
  - These pages showed departments only in the UI language: *My visits*, the visit page, reception's Expected list (dark
    tablet) and the reports' department chart. The exception is a legacy visit checked out before the conversion: its
    snapshot holds only the Arabic name (backend INT-dept-4).
  - 104 per-page checks and 43 functional checks passed. axe ran 66 times (8 pages × 2 languages × 2 widths × 2 colour schemes,
    plus the rename dialog in both languages) and found no violation. No page had a page error or horizontal scroll.
  - Screenshots: the session scratchpad's `dept-host-shots/`.
- **Seen, not changed.** In the Arabic UI the department dialog's "Name" («الاسم») field holds the English name in a
  right-to-left input, right-aligned. The company settings' "Company name" does the same, so the two stay consistent. `dir="auto"`
  on both would align a Latin name to the left; this is left as a possible polish item.

## No two departments read the same, in either language (backend B10-29), and the audit details' landmark (2026-10-11)

Scope: `src/features/admin/{departmentForm.ts,AuditEventList.tsx}`, `departmentForm.test.ts`, `DepartmentsPage.test.tsx`,
`AuditLogPage.test.tsx`, `e2e/quality/accessibility.spec.ts`. No catalog text, `api.ts` or `backend-contract.json` change:
the server's rule adds no field, field code, error code or message (a 409 `CONFLICT` with `details.field`, as before), and
the regenerated snapshot is byte-identical.

F10-dept-8. **The department dialog compares across the languages, as the server does.** — `validateDepartment` keeps its
two checks (the name against names, the Arabic name against Arabic names) and adds the other language: a name that is
another department's Arabic name is refused on the name with "A department with this Arabic name already exists." /
«يوجد قسم بهذا الاسم بالعربية.», and an Arabic name that is another department's name on the Arabic name with "A department
with this name already exists." / «يوجد قسم بهذا الاسم.» (the inactive variants say it can be reactivated, as before);
trimmed, ignoring case, inactive departments included; the same language is reported first, as on the server. A
department's own names never count, and in a rename a value that only changes case is not compared across the languages
(the server's rule for departments saved before B10-29). The existing messages state the fact exactly, so no new text was
needed; two keys added for an earlier draft of the rule (the Arabic label only) were removed again.
   - One old assertion encoded the defect ("An Arabic name is compared with Arabic names only": `nameAr: 'Finance'` beside
     Finance / «المالية» passed); it now expects the name's message on the Arabic name.
   - Tests: `departmentForm.test.ts` +5 (a name equal to another department's Arabic name, with or without an Arabic name,
     inactive, and the review's «العمليات» / "Operations" refused on both fields; an Arabic name equal to another
     department's name, ignoring case and spaces, inactive; renames in either language, a cleared Arabic name passing; own
     names, swapping them, a case-only change of a legacy shared value; the same language first);
     `DepartmentsPage.test.tsx` +1 (the dialog refuses Name «المالية» beside Finance / «المالية» and the Arabic names
     "finance" and "Archive" before sending, sends nothing, and puts the server's 409 for a department added elsewhere on the
     Arabic name). The page test's server mock applies the rule.

F10-a11y-audit. **An open audit event's "Recorded details" is a group, not a landmark.** — `AuditEventList.tsx` rendered
each open event's metadata in a `<section aria-labelledby>` named "Recorded details" / «التفاصيل المسجّلة»: a region
landmark, so two open events gave the page two landmarks with one name (axe `landmark-unique`, moderate, in both languages;
found by the UX review). It is now a `<div role="group">` with the same label: still announced with its name when entered,
no longer a landmark, and nothing else changes on screen. Tests: `AuditLogPage.test.tsx` +1 (three open events: three groups
named "Recorded details", no region and no `<section>` in the list; it fails with the old `<section>`, checked);
`e2e/quality/accessibility.spec.ts` +1 test per quality project (desktop, tablet, mobile): the administrator opens two events
and axe reports no serious or critical violation and no `landmark-unique` (the page checks block on serious and critical
only, which is why they did not catch this moderate rule).

**Also:** the review's leftover database `vms_uxrev_dept` (no connection, its API and Vite on 8950/5950 gone) was dropped;
the cluster holds `postgres`, `vms` and `vms_e2e`.

**Gates (2026-10-11, with the backend's B10-29).**

Final gate run, after the lead's widening to both languages and the audit-details fix (reference machine; throwaway
backend databases; E2E on 8700/5199 against `vms_e2e`):

- Backend (`backend/`): `ruff check .` all checks passed; `ruff format --check .` 253 files already formatted; `mypy` no
  issues in 134 source files.
- `pytest`: 3,038 passed, 3 skipped (the opt-in volume checks), 0 failed, 667.81 s. `pytest --committed-first`: 3,038
  passed, 3 skipped, 0 failed, 722.34 s. (Before: 3,028 + 3.) The machine was busy during these runs; the same suite took
  271.70 s earlier the same day. One earlier full run under that load failed `test_access_log.py::
  test_the_response_time_excludes_background_work` (a trivial request took 530.6 ms against its 500 ms bound; no
  department code on that path); the file passed alone (3 passed) and the whole suite passed on the rerun above.
- Frontend (`frontend/`): `npm run typecheck` and `npm run e2e:typecheck` exit 0; `npm run lint` (oxlint --deny-warnings)
  exit 0, no diagnostics; `npm test` 129 files, 1,390 tests passed, 0 failed, 110.61 s (before: 1,383).
- `npm run e2e -- --retries=0`: 256 tests, 238 passed, 18 skipped (by their project conditions), 0 failed, 6.9 minutes
  (before: 253 / 235 / 18). The 3 new tests are the audit-details axe check in desktop, tablet and mobile.
- `python -m unittest discover -s deploy/verify -p "test_*.py"`: 33 tests OK.
- Afterwards the cluster holds `postgres`, `vms` and `vms_e2e`.
