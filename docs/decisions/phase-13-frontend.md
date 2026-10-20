# Phase 13 — frontend decisions (the appearance: light, dark, or the device's)

Date: 2026-10-14. Scope: `frontend/**` (the new `src/appearance/**` and `public/appearance.js`, the
stylesheet's dark rules, the logos, the document's head, the layouts that carry the switch, the account
menus, the e-mail texts' preview, the catalogs, the unit tests and `e2e/**`), `frontend/Dockerfile`'s
build guard, `deploy/verify/smoke_test.py`, the READMEs, `docs/security.md`, `docs/production-readiness.md`,
`docs/development.md` and this file. Contract: the Phase 13 contract, section A and the SPA's half of
section C (with its amendment of 2026-10-14, F13-11). The rules of the earlier phases hold: direction C with
the existing kit, Arabic (right to left, the default) and English from the catalogs, logical CSS properties
only, the style policy `style-src 'self'` and the script policy `script-src 'self'`, **no explanatory
notes**.

What the owner reported: the app had a complete dark colour scheme that only followed the device, and no
way to choose it; their computer is light, so they had never seen it. Now each device chooses.

Each entry records what was built and every interpretation of, or deviation from, the contract.

---

## The choice and the scheme

**F13-1 — One choice per device: Light, Dark or System.** `appearance/appearance.ts`:

- The choice is `system` (the default), `light` or `dark`, in `localStorage` under one key,
  `vms.appearance`: for every company and for the platform owner's area alike, never an account's
  preference (a receptionist's tablet and the same person's phone may want different things). Every read
  and write is in `try`/`catch`; a value that is none of the three, and storage that cannot be read, is
  System. A choice that storage refuses to keep (private browsing, a full quota) still holds for the page
  it was made on.
- **The scheme** a page is drawn in is the choice, or under System the device's own
  (`prefers-color-scheme`). `startAppearance()` (`main.tsx`, before the first render) keeps it on the
  document: after a choice on this page, a choice made in another tab (the `storage` event; a storage
  cleared there counts too) and, under System, a change of the device's scheme, live.
- Components read it with `useAppearance()` (the choice) and `useColorScheme()` (the scheme), both
  `useSyncExternalStore` on the store's notifications.

**F13-2 — Dark from the first frame: a script of its own, before anything is drawn.** The scheme has to be on
the document before the first paint, and the policy is `script-src 'self'`: no inline script, and no hash or
nonce was wanted for one. So `public/appearance.js`, a classic script of fourteen lines, is referenced in
`<head>` of `index.html` before the stylesheet and the app (render-blocking, as a classic script without
`async`/`defer` is). It reads the same key by the same rule and puts the scheme on the root element
(`data-scheme="light|dark"`) and in the `color-scheme` meta (in the dark scheme the browser chrome's dark
colour too, F13-19). The meta matters before the stylesheet applies: the browser paints its own canvas in
that scheme (in development the stylesheet arrives with the app's script; in a build it is render-blocking,
but the canvas behind the first frame is still the browser's).

Held three ways: `appearance.test.ts` runs the file itself in the test's document for every stored value
(none, the three, junk) on a light and a dark device and with blocked storage, and compares what it sets
with the store's own answer, so the two cannot drift; the same test reads `index.html` (the tag is a classic
`src` script in `<head>`, after the meta, before the app; no inline script anywhere); and
`e2e/phase13-appearance.spec.ts` records what the root carries at the browser's first animation frame and
measures every frame Chromium draws during a reload (its screencast, each frame's mean brightness): with Dark
stored on a light device the brightest frame of a reload of the sign-in page, a company page and a visitor's
pass is dark. With the script taken out (the file answered empty) the same reload drew one white frame
(mean brightness 255): the measurement sees the flash it is there to catch.

**F13-3 — One switch for every rule that means dark.** The stylesheet asks for the root's attribute and never
for the media feature. `index.css`'s `scheme-dark` variant is now
`@media screen { &:where(:root[data-scheme='dark'], :root[data-scheme='dark'] *) { … } }`: on screen only
(paper stays light), and inside `:where()`, so no selector it is added to gains specificity (the order of
the rules is what it was). Every dark rule goes through it:

- the whole app's dark tokens on the root (`:root { @variant scheme-dark { @apply theme-dark; … } }`);
- the coloured shell's deep step and the platform owner's slate shell (`@variant scheme-dark` inside
  `theme-shell` and `theme-shell-platform`);
- the logo plate's `scheme-dark:` classes.

The compiled stylesheet was read: no `prefers-color-scheme` is left in it, and each of these rules is
`:where(:root[data-scheme=dark], …)` under `@media screen`. In script the one switch is `useColorScheme()`:
`CompanyLogo`, `BrandLogo`, the identity page's preview, the browser chrome's colour (F13-5, F13-6). Two
guards in `appearance.test.ts` keep it so: no source but `appearance.ts` asks the device for its scheme
(`prefers-color-scheme` in code, comments aside), and no class uses Tailwind's own `dark:` variant, which
follows the device and not the choice. `designTokens.test.ts` and `test/designTokens.ts` read the new shape
of the stylesheet (the dark root block, the two shells).

**F13-4 — A change of scheme replaces the colours at once.** Buttons, links and tabs have colour transitions:
switching the scheme faded every one of them for 150 ms behind a page that had already changed. The
attribute that switches transitions off while a company's identity arrives (F12-37) is now set for a change
of scheme too (`withoutTransitions`, exported from `identity/document.ts`).

## What follows the scheme

**F13-5 — Logos.** `CompanyLogo` chooses by the scheme of the choice, not by a media attribute: in the dark
scheme a `<picture>` offers the logo for dark surfaces under `media="screen"`, and in the light scheme there
is no source at all. A page printed in the dark scheme therefore still puts the logo for light surfaces on
paper (print does not match `screen`), as before; the plate lets go of its fill with `scheme-dark:` classes,
which are on screen only. The same for `BrandLogo` (the product's white logo on the platform's sign-in page
in the dark scheme). The identity page's preview draws the shell and the content in the dark set when the
device's scheme is dark (`useColorScheme`, it used `useMediaQuery`). The mocked spec checks the file each
place shows (`currentSrc`) in both schemes, on a device whose own scheme is the other one, and on paper.

*On a light page, superseded in part by F13-26 (2026-10-19): in the light scheme the logo stands on the page
itself, and the page's plate is the dark scheme's alone, for a company without a logo for dark surfaces.*

**F13-6 — The browser chrome's colour is one meta.** `index.html` had two `theme-color` metas with
`media="(prefers-color-scheme: …)"`: the browser chose by the device. There is one now, without a media
query, and `applyDocumentIdentity(document, identity, scheme)` writes the colour of the scheme the page is
drawn in (the palette's `surface`, or `deep` in the dark scheme; the default teal and deep teal without a
palette; in the platform owner's area its own shell's colours, F13-24). The boot identity writes it before
the first render, and `IdentityController` again whenever the scheme changes.

**F13-7 — The reception screen.** It is dark by design (`DARK_SURFACE_HANDLE`, F10-29). Under System it stays
dark, on a light device too, exactly as before; under Dark it is dark (the whole app is); under Light it is
light: the coloured shell, the light canvas, no `data-surface` for its dialogs and toasts, because a person
who picks Light and opens the reception must see the choice there too. `useShellSurface()` answers the
surface the screen is drawn on (the route's, unless the device chose Light), so the layout and everything
that reads it follow. The camera's panel keeps its own tokens (`bg-media`, the picture of any brightness) and
is the same dark panel in both schemes. The light reception was checked like a page of its own: every tab
with axe at the three viewports and at 320 px, in both specs, and in the screenshots in both languages.

## The switch

**F13-8 — On the signed-out pages and the pass: a radio group of three, beside the language switch.**
`AppearanceSwitch` is native radios in a `fieldset` (`role="radiogroup"`, named by its legend «المظهر» /
"Appearance", visually hidden): one tab stop, the arrow keys move and choose in the reading direction (the
browser's own behaviour; in Arabic the next choice lies to the left), Tab leaves. On screen three joined
segments, each the symbol and the word (sun «فاتح» / "Light", moon «داكن» / "Dark", monitor «تلقائي» /
"System"), each 44 px tall, the focus ring on the segment. The chosen one is direction C's ink tile (the light
ink in the dark scheme): neutral, not the company's colour, which marks actions and which may be a pale yellow
that would not show a choice. It stands in `CenteredLayout`'s header (sign-in, a company's sign-in, the
password pages, the error pages, the platform's sign-in, which passes its own language switch) and in the
pass page's header, before the language switch, so the language switch keeps its corner. Where both do not
fit one row (English at 320 px, a larger text size, wider text spacing), the language switch takes a row of
its own (F13-17; this entry first said both stay on one row at 320 px, which held in Arabic only).

*Superseded by F13-25 (2026-10-19): one toggle beside the language switch; the radio group is gone.*

**F13-9 — In the account menus: a group of `menuitemradio`.** The company's account menu (every role, also
while a password change is required) and the platform owner's carry the same choice, first, set apart from
"Change password" and "Sign out" by a separator. "The platform owner's shell" is read as its account menu:
the place the company's people have it, and one choice for the device either way. `Menu` has a new kind of
entry, `MenuRadioGroup`: a `group` named through `aria-labelledby` by its visible heading (hidden from the
tree, so the name is read once), with one `menuitemradio` per choice and `aria-checked`. The keys follow the
WAI-ARIA menu pattern: Up and Down visit every item (the choices included), Left and Right move between the
choices in the reading direction, Space chooses and keeps the menu open (the effect is seen at once), Enter
chooses, closes and returns focus to the trigger, a click chooses and keeps it open. Arrow keys now go on
from the item that has the focus, also when a pointer put it there. The choices are tiles, the symbol over
the word, so the three fit the narrowest menu (14 rem in the sidebar) in either language (the first layout,
symbol beside word, cut «تلقائي» there: found in the screenshots). The chosen tile is the shell's
current-page pill (`bg-accent`): the menu opens from the shell and takes its tokens.

*Superseded by F13-25 (2026-10-19): the account menus hold no appearance, and `Menu` no group of choices (its
arrow keys still go on from the item that has the focus).*

**F13-10 — Words.** «المظهر»: «فاتح» «داكن» «تلقائي»; "Appearance": "Light" "Dark" "System"
(`common:appearance`). Nothing else: no description, no hint of what System means.

*Superseded by F13-25 (2026-10-19): «الوضع الداكن» / "Dark mode"; «فاتح» «داكن» / "Light" "Dark" stay for the
e-mail preview (F13-11).*

## The e-mail previews (section C)

**F13-11 — Light / Dark above the saved e-mail.** `EmailPreviewCard` (the company administrator's e-mail texts
editor and the platform owner's, which share it, F12-24) has a «فاتح / داكن» / "Light / Dark" switch, the
kit's segmented `RadioGroup` named «مظهر الرسالة» / "Email appearance" for assistive technology (F13-21),
Light by default. It stands directly above the saved e-mail's frame, in the "Saved email" tab: the draft tab
shows the subject and the text version, which have no colours, so a switch there would change nothing a
person sees. The card holds the choice, so it outlives a change of tab.

- **GET** `…/preview?language=…&scheme=light|dark`: the scheme is always named, also the default. The frame
  is a new document for each scheme (`key`), and takes the scheme itself (`color-scheme`, and its canvas
  white or the dark canvas while the document loads).
- **POST** `…/preview`: the draft's request carries no `scheme` (F13-22; it first did, which made the draft
  ask again after every change of the switch). **The test e-mail never carries it**: it is the real e-mail,
  both schemes inside (`toPreviewRequest` without it; a unit test reads the request).

*A finding, and the contract's amendment.* The contract had `light` return "the e-mail as sent". Checked in
Chromium before building on it: a document inside a frame matches `prefers-color-scheme: dark` whenever the
viewer's **device** is dark, whatever `color-scheme` the frame element or the page around it says (three
frames, light, dark and unset, all matched). So the e-mail as sent, whose dark rules sit in that media query,
would show its dark design under "Light" to anyone whose device is dark, and nothing in the page can change
what a sandboxed document sees. Reported to the lead at once; the contract was amended: `scheme=light`
returns the light design unconditionally (`color-scheme: light`, no dark rule that can match, the light logo
only). `e2e/flows/email-texts.spec.ts` holds it against the real server: on a device in its dark scheme the
Light frame is light and the Dark frame is dark (the mean brightness of the frame's own pixels), and on a
light device the Dark frame stays dark.

**F13-12 — Types.** `types/api.ts`: `EmailScheme` (`'light' | 'dark'`), `EmailTemplatePreviewRequest.scheme?`,
`EmailPreviewDocumentParams.scheme?`; `EmailScheme` is listed among the enum aliases the contract test checks
through the properties that use them.

## Static file, policy and deployment

**F13-13 — `public/appearance.js` in the build and in the deployment.** Nothing in the policy changes: the
file is `'self'`. It is a file of the build like the icons (Vite copies `public/` as is), so:

- the service worker precaches it with every other public file (`config/serviceWorkerPrecache.ts` lists
  `public/` itself; the offline app shell needs it), and a change of it is a new precache version;
- nginx serves it from `location /`: `no-cache` (revalidated, like `sw.js` and the icons; kept so, F13-23),
  the SPA's security headers, `application/javascript` (it must be JavaScript under `nosniff`, or the browser
  refuses it and every page starts light). `deploy/verify/smoke_test.py` now checks those three for it with
  `sw.js` and the precache list; nothing in the nginx template enumerates public files, so nothing there
  changed;
- `frontend/Dockerfile`'s build guard fails when `dist/appearance.js` is missing;
- the release-tree check needs nothing new (no credential, no artefact pattern), and
  `deploy/verify/test_brand_names.py`, which reads `frontend/public/*.js`, finds no retired name in it.

## Tests

**F13-14 — Unit tests** (Vitest). New: `appearance/appearance.test.ts` (the choice, the scheme, the document,
a choice in another tab, the device's scheme live, blocked storage, the script before the first paint against
the store, `index.html`, the two guards of F13-3) and `appearance/AppearanceSwitch.test.tsx` (names, symbols,
keys, the ink tile, Arabic, another tab). Extended: `components/ui/Menu.test.tsx` (the group: roles, names,
separator, keys including Space, Enter and right to left, one choice per activation),
`layouts/AppLayout.test.tsx` (the menu's group and its keys; the reception light for Light, dark for Dark and
System), `identity/document.test.ts` and `identityRuntime.test.tsx` (the one `theme-color`, by the scheme,
live), `components/app/CompanyLogo.test.tsx`, `BrandLockup.test.tsx`, `pages/PassPage.test.tsx` (the dark
logo only in the dark scheme of the choice, on screen; the choice over the device),
`features/platform/CompanyIdentityPage.test.tsx` (the preview in the device's scheme, live),
`features/admin/EmailTemplatesPage.test.tsx` and `features/platform/PlatformEmailTexts.test.tsx` (Light / Dark,
the requests, the frame), `designTokens.test.ts` (the shells' dark step through the variant). After the
review, each of F13-17 to F13-24 names the tests that hold it.

**F13-15 — End-to-end specs.**

- `e2e/phase13-appearance.spec.ts` (the API mocked, three viewports): the switch on the signed-out pages (its
  names, its place beside the language switch, 44 px, keys in both directions, Arabic, 320 px, axe); the
  choice across reloads, on a company's pages and the platform's, and in another tab at once; System
  following the device live and a choice holding against it; the first frame and every frame of a reload
  dark with Dark stored (F13-2); the logos and `theme-color` by the choice on a device of the other scheme,
  and paper light; a yellow company's shell (its logo on the plate) and the deep shell with the logo for dark
  surfaces; the two account menus by keyboard (Space keeps the menu open, Enter closes it, the page changes
  behind it, axe with the menu open, the platform's slate shell in the dark scheme); the reception under
  System, Light and Dark with each tab under axe and the camera panel's colour; the e-mail texts' Light /
  Dark frames in a dark app.
- `e2e/quality/appearance.spec.ts` (the real API): Dark on a light device for the signed-out pages and the
  pass, the administrator's main pages (dashboard, visits, a visit, invite, history, users, settings, audit,
  reports, the e-mail texts editor and its saved e-mail in both schemes), the reception's tabs, and the
  platform owner's companies, audit, a company's identity and e-mail texts; Light on a dark device for the
  reception's four tabs, with its camera panel. Each: the scheme on the root, the canvas, no serious or
  critical axe violation, no horizontal scroll at the viewport and at 320 px.
- Updated: `e2e/flows/email-texts.spec.ts` (the frame's address names the scheme; Light and Dark against the
  real server, F13-11), `e2e/phase12-identity.spec.ts` and `e2e/phase12-ux.spec.ts` (the one `theme-color`).
- After the review: the header at every width, text size and spacing (F13-17), forced colours (F13-18), the
  first frame's `theme-color` (F13-19), the e-mail switch's name and the draft without a scheme (F13-21,
  F13-22, also in `e2e/quality/appearance.spec.ts` and `e2e/flows/email-texts.spec.ts`), the platform's
  `theme-color` (F13-24).

## The backend's half, as met

**F13-16 — The e-mails of section B in the end-to-end suite.** The first full run on the backend's work had
four flows fail on what the e-mails now are (B13-2), none on the web application:

- every e-mail of a company with a logo for dark surfaces carries a second layout image,
  `cid:brand-logo-dark`. `e2e/support/outbox.ts` counted every inline image but `brand-logo` as content, so
  an invitation had two "content images" and the QR decoder read the dark logo
  (`acceptance.spec.ts`, `invitation-failure.spec.ts`, `pass-outcomes.spec.ts`). Both logos are the
  layout's now (`BRAND_LOGO_DARK_CID`, `brandLogoDarkImage`);
- `company-identity.spec.ts` compared the e-mail's logo byte for byte with the company's stored file. The
  logo now travels as renditions, so the spec holds what B13-2 promises instead: both renditions are there,
  both are opaque (no alpha channel, no `tRNS`: `pngFacts`), neither is larger than twice its 168 × 44 box
  with its plate of 16 image pixels on each side, the light one is the company's logo (its own colour is in
  it) on white, and the dark one stands on the dark header's `#182126`.

The contract snapshot the backend regenerated (`EmailScheme`, `scheme` on the preview request and the
preview document's query) matches `types/api.ts`: 89 of 89.

## The independent review's findings, and what each changed

An independent review of this phase's frontend (2026-10-14) reported the findings below; each was fixed as
the lead decided.

**F13-17 — The appearance never covers the language switch.** The public header was one row that did not
wrap, and the group could shrink (`min-w-0`) while its segments could not (one word each, no wrap): in English
at 320 px the segments ran 5 px past their own group to within 3 px of the language switch; with WCAG
1.4.12's text spacing they covered it, and at 390 px with a 20 px text size they overlapped it by 5 px. Now:

- `CenteredLayout`'s header and the pass page's wrap (`flex-wrap`, the same 8 px between rows as between the
  two), and the group never shrinks below its segments (`shrink-0`): where both do not fit one row the
  language switch moves to the next one, still in the inline-end corner. Where they fit (Arabic at 320 px,
  either language at 390 px and wider) nothing changed: the same row in the same place;
- the group is at most as wide as the header (`max-w-full`), and only when the three segments alone are
  wider than the whole header (English at 320 px with a 20 px text size: 301 px in 280) do they wrap, under
  each other, instead of running off the screen's start where no scroll reaches them (an aligned-to-the-end
  row overflows at its start). For that, each segment has all four edges, the next one's start edge laid
  over it (`-ms-px`, the row's 1 px start room taking the first one's): one 1 px line between two segments
  as before, and a wrapped segment is a closed box.

`e2e/phase13-appearance.spec.ts` measures the header of the sign-in page and of the pass, English and Arabic,
at 320 and 390 px, each with the browser's own text, WCAG 1.4.12's text spacing and a 20 px text size
(twenty-four layouts): no segment's box meets the language switch's; no segment's content outside it, no
segment outside its group, neither the group nor the language switch outside the header nor the header
outside the screen; the language switch in its corner; no sideways scroll; the three segments in one row
wherever one row of the header holds them; and both switches in one row at 390 px with the browser's own text. The first test's old check (one row at 320 px), which ran in Arabic only, is replaced by
this one. Screenshots of every case were looked at (the session scratchpad's `fix13f/`).

**F13-18 — In a forced-colours mode the chosen appearance shows.** The chosen segment (the ink tile) and the
chosen tile of the account menu (the accent pill) showed the choice by their fill alone, and a forced-colours
mode (Windows' contrast themes) draws every fill as the system's `Canvas`: the three looked the same. The kit
has no forced-colours rule to follow; its segmented `RadioGroup` adds a check mark to the chosen one, which
these two have no room for (each choice already has its symbol, and the switch's width is F13-17's). So the
chosen one takes the system's selection colours in that mode, `Highlight` under `HighlightText`
(`FORCED_COLORS_CHOSEN`, `components/ui/buttonStyles.ts`), with `forced-color-adjust: none`: checked in
Chromium, a system colour alone is kept, but the backplate the browser draws behind text in that mode is the
page's `Canvas`, and the word vanished on it (white on white). Its focus ring is then the system's text colour
(`CanvasText`), since the element no longer has its colours forced. Nothing changes outside that mode. The
spec opens the pass and the account menu with `forcedColors: 'active'`: the chosen one's fill is not its
neighbours', its word is not its fill, and on screen more than half of it is that fill and its word is drawn
on it, both for a choice made there.

*Superseded by F13-25 (2026-10-19): the toggle shows its state by its symbol, never by a fill, and
`FORCED_COLORS_CHOSEN` went with the two controls that needed it.*

**F13-19 — Dark from the first frame includes the browser's chrome.** With Dark stored, the first frame was
dark but its `theme-color` was `index.html`'s light teal until the app ran. `public/appearance.js` now also
sets `theme-color` in the dark scheme, to a neutral page's dark one (`#0f3b3f`, `DEFAULT_THEME_COLORS.dark`:
what `applyDocumentIdentity` writes for a neutral page; `index.html`'s light one is its light counterpart).
The boot identity puts the company's colour (or the platform's, F13-24) in its place before the first render,
as before. The script still knows nothing of the route (the open item on the reception holds). The unit test
that runs the file now also compares the meta it leaves with `documentIdentityOf(NEUTRAL, …).themeColors` of
the scheme, for every stored value on both devices and with blocked storage, and reads `index.html`'s meta
against the light one; the first-frame spec records the meta at the first animation frame (the dark one, never
the light teal).

**F13-20 — A logo for dark surfaces that does not load gives up only itself.** `CompanyLogo` remembered one
failed address, always the `<img>`'s own `src`, the logo for light surfaces, also when the file that failed
was the `<picture>`'s dark source: the wordmark stood where the light logo would have. It now keeps every
failed address and records the one the image was showing (`currentSrc`: the dark source's address when the
browser chose it, else the image's own), so a failed dark logo leaves the light one on its plate, as for a
company with one logo, and only both failing leaves the name. A list rather than one address: with one, a dark
logo and then the light one failing would have taken turns. Unit test: the dark source failing, then the light.

**F13-21 — The e-mail preview's switch is named for the e-mail.** Its group was named «المظهر» /
"Appearance", the name of the device's own appearance. It is «مظهر الرسالة» / "Email appearance" now
(`admin:emailTemplates.preview.scheme`), for assistive technology only (`sr-only`): nothing visible changed,
no note added.

**F13-22 — The draft is asked for without a scheme.** The draft's POST preview carried the scheme, so after
Dark under "Saved email" the draft tab asked the server again, behind a spinner, for the same subject and
text. The draft's request has no `scheme` now (the server's default, light; its `html` is not shown), so its
query does not depend on the switch; the saved e-mail's document is still asked for by scheme. Unit test and
spec: no scheme in any draft request, and back on the draft after Dark it is there at once and nothing is
asked again. (In development React's strict mode mounts twice and the first request is cancelled: the spec
counts the requests made after the switch, not all of them.)

**F13-23 — `appearance.js` stays `no-cache`: a deliberate trade-off.** The review raised the
render-blocking script's `no-cache`. The lead decided to keep nginx's `no-cache` (F13-13): a
release can never serve an old pre-paint script, whose rule must match the app's (`appearance.test.ts`), to a
browser without the service worker. The cost: such a browser revalidates the file on every page load, one
conditional request (a `304` of no body) before the first paint. A browser with the service worker takes it
from the precache (cache first), which a release replaces as a whole.

**F13-24 — The platform owner's area: the chrome in its own shell's colours.** The product's identity gave the
browser's chrome the companies' default colours (`#188086`, `#0f3b3f` in the dark scheme), but the platform's
shell is the deep teal `#0f3b3f`, and the slate `#33444e` in the dark scheme (`theme-shell-platform`, UX
review L10). `DocumentIdentity` now carries its `themeColors`: the platform's are `PLATFORM_THEME_COLORS`
(its sign-in page too, where the area's identity already applies); a company's are its palette's `surface` and
`deep`; a neutral page's are the default ones, unchanged: those pages belong to no company yet and draw no
shell, and the default teal is the shell a company without a colour gets, so nothing there was wrong.
`designTokens.test.ts` holds both pairs against the stylesheet's shells (`theme-shell`, `theme-shell-deep`,
`theme-shell-slate`); `document.test.ts` the values per identity and scheme; the account menus' spec reads the
meta in the platform's area in both schemes.

## Verification (2026-10-14)

**Gates**, on the final code:

| Gate | Result |
|---|---|
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run lint` (oxlint, warnings fail) | clean |
| `npm test` (Vitest) | 153 files, 2,081 tests, all passed (before this phase: 151 files, 2,052 tests) |
| `src/types/api.contract.test.ts` | 89 of 89 against the backend's regenerated snapshot (`EmailScheme`) |
| `npm run e2e:typecheck` | clean |
| `npm run build -- --outDir <scratch> --emptyOutDir` | built (the app chunk 324 kB, 93 kB gzipped; the stylesheet 107 kB, 19 kB gzipped); `appearance.js` in the build and in the precache list; no `prefers-color-scheme` in the compiled stylesheet |
| `npm run e2e -- --retries=0` (the real API on 8700, `vms_e2e`) | 546 passed, 66 skipped (specs that run on one project only), 0 failed, 29.3 min |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` (the backend's interpreter) | 46 tests, OK; `check_nginx_headers.mjs`: match (7 headers) |
| `deploy/verify/check_release_tree.py` | 1,092 files, no development artefact or credential |

The first full end-to-end run had five failures (541 passed): the four flows of F13-16, on the backend's new
e-mails, and the new reception test on the tablet, which ran past the project's minute while the suite ran
in parallel (three devices, twelve axe runs: it has a timeout of its own now). The suite was then run again
from its start on the final code: the row above.

**The layout specs that mock the API** (my own Vite on 5199, the API not running): every top-level spec,
158 passed and 49 skipped by viewport; the six tests among them that need the real API ran in the full
suite.

**Each safeguard taken out again.** Thirteen single changes, each run against the unit tests that hold it:
the pre-paint script ignoring the stored choice; it leaving the colour-scheme meta alone; the stylesheet's
variant asking the device again; the logo by the device's scheme; the reception ignoring Light; the browser
chrome's colour always the light one; the identity page's preview by the device; the saved e-mail asked
for without its scheme; the test e-mail sent with a scheme; Space in the menu also clicking; Left and Right
ignoring the reading direction; a choice not reaching the document; another tab's choice not heard. **A test
failed for each**, and the files were restored. In the browser, the pre-paint script answered empty made one
frame of a reload white (mean brightness 255); with it every frame is dark (18 to 27).

**The production build under the production policy.** `vite preview` of the build, with the headers of
`config/securityHeaders.ts` (nginx's, held by `deploy/verify`): the sign-in page for the three choices on a
light and on a dark device. No `securitypolicyviolation`; at the first animation frame the root already
carries the scheme and the canvas is the scheme's (`#101619` or `#f1f1f1`, the stylesheet being
render-blocking in a build); every frame of a reload in the scheme of the choice, also Light on a dark device.

**Visual check.** 240 screenshots against the real API (the suite's own global setup, `vms_e2e`): the
signed-out pages (the neutral and a company's sign-in, the password page, the pass, not found, the platform's
sign-in), the administrator's pages (dashboard, my visits, a visit, invite, users, settings, audit, reports,
history, the e-mail texts editor, the saved e-mail Light and Dark, the account menu open), the reception's
four tabs in Light, Dark and System on a light device, and the platform owner's pages (companies, a
company, its identity, its e-mail texts, the account menu open); Arabic and English, 1440 and 390 px, Light
and Dark. No horizontal scroll and no console error on any. What they showed, and what it changed: the
account menu's three choices, the symbol beside the word, cut «تلقائي» in the sidebar's 14 rem menu (now
tiles, F13-9); the pass page's logo sat 6 px under the wider header on a phone (its top room is 16 px now).
Screenshots: the session scratchpad's `phase13-shots/`.

**What assistive technology is given** (Playwright's accessibility tree, mocked API): on the sign-in page a
`radiogroup "Appearance"` («المظهر» in Arabic) with `radio "Light"`, `radio "Dark"`, `radio "System"
[checked]` beside `button "العربية"`; in the account menu `group "المظهر"` with three `menuitemradio`, the
chosen one `[checked]`, then a `separator` and the two `menuitem`s. In Arabic, Right from the first choice
reaches the last (the next choice lies to the left).

### After the review (F13-17 to F13-24)

| Gate | Result |
|---|---|
| `npx tsc -b` | clean |
| `npx oxlint --deny-warnings` | clean |
| `npx vitest run` | 153 files, 2,083 tests, all passed |
| `npm run e2e:typecheck` | clean |
| `npm run build -- --outDir <scratch> --emptyOutDir` | built (the app chunk 324 kB, 93 kB gzipped; the stylesheet 107 kB); `appearance.js` in the build and the precache list; the forced-colours rules compiled (`@media (forced-colors: active)`), no `prefers-color-scheme` |
| Targeted end-to-end (`phase13-appearance`, `quality/appearance` on the three viewports, `flows/email-texts`; the real API on 8700, `vms_e2e`) | 108 passed, 14 skipped (tests that run on one viewport only), 0 failed, 4.1 min |
| `npx playwright test --retries=0`, the whole suite, on the backend's final code (the API started by `python -m app.serve`, now `app.main:create_served_app`; 8700, `vms_e2e`) | 548 passed, 70 skipped (specs that run on one project only), 0 failed, 27.1 min. Before the review 546 and 66: the two new tests run on the desktop and are skipped on the tablet and the phone |

The backend's last changes (the e-mails' class names, 16-bit PNG logos refused, a light emblem's name beside
it in the e-mail header, the served application's factory) needed nothing in the end-to-end suite: the specs
read the inline images by their `cid:` addresses and order, which are unchanged; every logo they upload is an
8-bit PNG; the global setup starts the API with `python -m app.serve`, which runs the new factory.

**Each fix taken out again.** Six single changes against the unit tests: the pre-paint script leaving
`theme-color` alone; a failed logo always marking the light one; the draft asked for with a scheme; the
e-mail switch named "Appearance"; the platform's chrome in the default colours; the platform's dark chrome
not its shell. A test failed for each, and the files were restored. In the browser: the code as the review
found it (the header not wrapping, the group shrinking, segments that cannot wrap, no forced-colours rule)
fails both the header test ("System outside its group", English, 320 px) and the forced-colours test (the
chosen fill equal to its neighbours'); a header that does not wrap around a group that shrinks fails it too
("the segments wrap, though their 240.5 px fit the header's 288"). A group allowed to shrink inside the
wrapping header passes, rightly: there it can shrink only when it stands alone on its row, as `max-w-full`
lets it.

**Looked at.** The header of the sign-in page in English and Arabic at 320, 390 and 1440 px, with the
browser's own text, WCAG text spacing and a 20 px text size (eighteen screenshots): where both fit, the row
is what it was (against the same screenshots with the segments' former edges, 78 pixels differ, all in the
anti-aliasing of the group's rounded start corner and two corner pixels of one seam); English at 320 px puts the language switch under the group, in its corner;
at 320 px with 20 px text the segments wrap as closed boxes. The switch in a forced-colours mode with the
light and the dark system palettes (Highlight under HighlightText, the ring in the system's text colour), and
without one (unchanged). Screenshots: the session scratchpad's `fix13f/`.

## The owner's follow-up (2026-10-19): one toggle, and the logo without a plate

The owner asked for two changes: the three choices become one toggle button (a sun or a moon), and a
company's logo must not stand on a white box on the light pages (on production the bank's transparent navy
logo stood inside a white rounded box with an edge on the light grey sign-in page: "the logo has a
background"). Each entry records what was built and every interpretation.

**F13-25 — The appearance is one toggle beside the language switch** (supersedes F13-8, F13-9, F13-10 and
F13-18). `appearance/AppearanceToggle.tsx`:

- *Behaviour.* Until it is pressed the page follows the device, live, as System did: nothing is stored. A
  press draws the other scheme than the one shown and keeps that choice, `light` or `dark`, under the same
  key `vms.appearance`. Nothing in the interface leads back to System (accepted by the owner); a `system`
  the earlier build stored still means "follow the device". So the store (`appearance.ts`), the pre-paint
  script (`public/appearance.js`: its rule did not change, only its comment), the first frame, another
  tab's press and the device followed live are all as they were (F13-1, F13-2), and the unit test that runs
  the script against the store still holds them together.
- *What is shown.* The toggle's state is the scheme the person sees. On the reception, dark by design
  while nothing is chosen (F13-7), that is dark also on a light device, so `ShellFrame` passes its
  `darkSurface`: the toggle is pressed there, and a press keeps Light (the reception is then drawn light);
  the next press, Dark.
- *The control.* A `button` with `aria-pressed` (true while dark) and a constant name, «الوضع الداكن» /
  "Dark mode" (`common:appearance.darkMode`), which is also its `title`; no words on screen and no helper
  text. It has the language switch's own look and size: the classes moved to `SWITCH_BUTTON`
  (`components/ui/buttonStyles.ts`), used by both, at least 44 × 44 px, its outline on the surface it
  stands on (the page's tokens, or the shell's). Its focus ring is the app's own `:focus-visible` ring. In
  a forced-colours mode its edge and its symbol take the system's colours; its state was never a fill.
- *Its symbol* is the scheme a press leads to: the moon while light, the sun while dark. The kit has a
  convention for exactly this, the language switch beside it, which shows the language a press leads to
  («ع» in English, "EN" in Arabic); the toggle says the same kind of thing in the same place. (With
  `aria-pressed` and the constant name, assistive technology hears the state, not the symbol.)
- *Where.* Everywhere the language switch is, always right beside it on its inline-start side (left of it
  in English, right of it in Arabic), 8 px apart: the public pages' header (`CenteredLayout`: `/login`,
  `/c/{slug}`, the password pages, the error pages, `/platform/login`), the pass page's header, the company
  shell and the platform owner's shell (`ShellFrame`: both get it there). The public headers keep wrapping
  (F13-17), but two buttons fit the narrowest one with any text size: they always share a row.
- *The sidebar.* Its head was one row, the lockup and the language switch. The sidebar's content is
  220 px wide; a lockup takes up to 156 px (a wordmark), 152 px (a logo on its plate), 140 px (the bank's
  mark with its name beside it); with the second 44 px button only 112 px would be left. Rather than
  shrinking every company's logo by a third, the two switches now stand in the sidebar's top inline-end
  corner, as on every public page, and the lockup under them keeps the sidebar's whole width (the head is
  44 px taller; the navigation scrolls as before where the screen is short). Measured before and after:
  the lockups' widths are unchanged (bank 140, a yellow company's plate 112, a wordmark 87, the platform
  109 px).
- *The phone's top bar.* At 320 px the bar holds its menu button, the lockup, the toggle, the language
  switch and the account menu. With the toggle added the lockup had 60 px and a wide logo's plate ran
  under the toggle (seen in the screenshots). Now, below 384 px only: the bar's gaps are 6 px and its sides
  8 px, the account menu's trigger is its avatar alone (a 44 px target; the chevron returns from 384 px), and
  the platform's logo is 18 px tall instead of 22. A company's wide logo on the shell may give way, in its
  proportions (`CompanyLogo`: on the shell a logo that is not an emblem is `min-w-0`; an emblem keeps its
  size and its name is cut). The lockup has 100 px at 320 px; nothing is under anything, and at 390 px and
  wider the bar is as it was but for the toggle.
- *Removed with the radio groups*: `AppearanceSwitch` and its test, `appearance/options.ts`,
  `useAppearanceMenuGroup`, `Menu`'s `radio-group` entry (`MenuRadioGroup`, `MenuEntry`; `Menu` takes
  `MenuItem`s again, and keeps going on from the focused item), `FORCED_COLORS_CHOSEN`, and the catalog
  keys `appearance.label` and `appearance.system`. `appearance.light` and `appearance.dark` stay: the
  e-mail preview's Light / Dark switch (`EmailPreviewCard`, F13-11) uses them, and it is unchanged.

**F13-26 — A company's logo stands on a light surface itself** (supersedes, in the light scheme, F12-7's
light page, F12-23's white plate on the platform owner's pages and F12-32 (b); and F13-5's page plate).

- *The rule.* In the light scheme, on the neutral light surfaces, the logo for light surfaces stands on the
  surface: no fill, no edge, no visible box. That is the `page` surface (the sign-in pages, the password
  and error pages, the pass), `paper` (print; it already was), and the platform owner's light cards and
  header tiles. The white plate stays only where a logo for light surfaces would otherwise stand on a dark
  or coloured surface: the dark scheme for a company without a logo for dark surfaces, and the shells by
  their rules (`shellTone`, F12-29: a dark shell without a dark-surface logo, and every light-coloured
  shell, unchanged). The logo for dark surfaces never has a plate.
- *`CompanyLogo` on a page.* The logo's room (`PAGE_ROOM`, `data-logo-room`) keeps the plate's padding and
  a 1 px edge, transparent; only in the dark scheme, for a company without a logo for dark surfaces, is it
  painted white with the cards' edge (`scheme-dark:bg-white scheme-dark:border-border`,
  `data-logo-plate="dark-scheme"`; screen only, so paper stays plain). The room is the same in both schemes,
  so when the scheme changes nothing moves but the logo itself: the switches, the logo's place, the card
  (the 82 px kept for the logo while it arrives is the room's height, as before). For a company with a logo
  for dark surfaces the room is never painted; that logo replaces the other in the dark scheme (the bank's
  mark then has its name beside it, as it had).
- *The platform owner's pages.* `CompanyLogoTile` (the companies list, a company's header, its identity and
  e-mail pages): the logo on the card in the light scheme; in the dark scheme the company's logo for dark
  surfaces without a plate, or for a company without one the logo on the white plate with the cards' edge;
  the same box either way (the names beside the tiles still line up), and a file that does not load gives
  way to the other one, then to the building tile. The identity card's "Logo" fact (`CompanyIdentityCard`)
  shows the logo for light surfaces, as its name says: on the card in the light scheme, on its plate in the
  dark one.
- *Left as they were.* The identity editor's upload tiles (`IdentityAssetSlot`: the logo on white, the
  dark logo on the brand's colour) are previews of the files on their intended grounds, not
  `CompanyLogo`'s plate. The identity preview (`IdentityPreview`) draws the shell by the shell's rules and
  the e-mail's head on white (paper). Every other use was checked: `IdentityLockup` in `CenteredLayout`,
  `PassPage` (screen and paper), `AppLayout` (shell, deep shell), `PrintSheetHeader` and `PassActions`
  (paper); `BrandLogo` and `BrandLockup` (the product's logo, never on a plate).
- *What this gives up.* F12-32 (b) put the plate on the light pages so a logo saved with a background of its
  own (an opaque white rectangle) would look meant. Such a logo now shows its rectangle on the grey page in
  the light scheme. Uploads since Phase 12 have a flat near-white background taken away (F12-32 (a)), so
  this is a logo saved before that, or one with a tile of its own; the owner chose the plain logo.

**F13-27 — Tests.** Unit (Vitest): `appearance/AppearanceToggle.test.tsx` (new, in place of
`AppearanceSwitch.test.tsx`: the name, the tooltip, no words, the language switch's classes, the moon and
the sun; the device followed live until a press, nothing stored; a press stores the other scheme than the
one shown, again and again, and the device no longer decides; Enter and Space; a stored `system`; another
tab's press and a cleared storage; the reception's dark surface; Arabic);
`features/platform/CompanyLogoTile.test.tsx` (new: no plate in the light scheme, the dark logo without one,
the plate for a company with one logo, the same box, a failing file); `components/ui/Menu.test.tsx` (the
group's tests gone; the arrow keys from the focused item, with plain items); `layouts/AppLayout.test.tsx`
(the account menu without the appearance; the toggle beside the language switch, same classes, in the top
bar and the sidebar's corner; on the dark screen pressed until a choice, a press light, the next dark);
`components/app/CompanyLogo.test.tsx` (a page's room unpainted in the light scheme, the plate in the dark
scheme only and in the same room, the dark-surface logo never on one; a wide logo on the shell gives way,
an emblem does not); `pages/PassPage.test.tsx` (the toggle beside the language switch, the logo's room).
End-to-end, `e2e/phase13-appearance.spec.ts` (mocked API): the toggle on the signed-out pages (name,
tooltip, no words, moon and sun, 44 × 44 px, beside the language switch on its inline-start side 8 px
apart in both languages, the same look, the first tab stop with its ring, Enter and Space, axe in both
schemes); the header at 320 and 390 px with the browser's text, WCAG text spacing and a 20 px text size in
both languages on the sign-in page and the pass (the toggle never meets the language switch, the symbol
inside it, both at least 44 px, both inside the header, the language switch in its corner, one row, no
sideways scroll: twenty-four layouts, the overlap assertions of F13-17 kept); a press kept across reloads,
companies, the platform's sign-in and another tab; the device followed live until a press, a press holding
against it, a stored `system`; the first frame (unchanged); the logos and the chrome's colour; the bank's
logos as production has them, on the sign-in page and the pass: in the light scheme the room unpainted and
the page's own canvas at its corners, the logo's own white pixels inside its diamond; in the dark scheme
the mark with the name and no plate, or for the bank with one logo the white plate with the cards' edge;
the switches, the room and the card where they were; the shells (the toggle beside the language switch in
both, the account menus without the appearance, the platform's chrome and slate); the top bar at 320 px
in both languages for the bank, a yellow company's wide logo and the platform (nothing over anything, the
avatar a 44 px target, the logo in its proportions); forced colours (the symbol drawn in the system's
colour, the edge, the focus ring, the state after a press, on the pass and in the sidebar); the reception
(the toggle pressed on the dark screen with nothing chosen; a press draws it light, the next dark).
`e2e/phase12-ux.spec.ts`: the signed-out pages' logo (the ATLAS logo with its white rectangle) is
unpainted in the light scheme and on its plate in the dark one, the room and the picture in the same
place in both; the controls checked against the lockup include the toggle. `e2e/quality/appearance.spec.ts`
(the real API): the toggle pressed on a company's sign-in page and in the administrator's shell, kept
across a reload, axe and no sideways scroll in Dark.

### Verification (2026-10-19)

| Gate | Result |
|---|---|
| `npx tsc -b` | clean |
| `npm run e2e:typecheck` | clean |
| `npx oxlint --deny-warnings` | clean |
| `npx vitest run` | 154 files, 2,093 tests, all passed (before: 153 files, 2,083). Three later full runs on a loaded machine: 2,091 passed, and the e-mail texts editor's two typing tests ran past their 20 s (4.6 s and 3.1 s alone; 4.7 s and 4.2 s on the code before this follow-up) |
| `npm run build -- --outDir <scratch> --emptyOutDir` | built (the app chunk 322 kB, 92 kB gzipped; the stylesheet 107 kB, 19 kB gzipped); `appearance.js` in the build and the precache list; no `prefers-color-scheme` |
| `npx playwright test --retries=0`, the whole suite (8700, `vms_e2e`) | 630 tests: 554 passed, 73 skipped, 3 failed, 48.7 min. The three: the header test (desktop), whose page Vite reloaded when `frontend/README.md` was edited during the run, and two reception pages under axe (tablet, phone) whose modules took the dev server 11.5 s to serve on a machine at 100 % CPU (the API answered in at most 1.4 s) |
| The three again (`phase13-appearance.spec.ts:269`, `quality/appearance.spec.ts:120`, all projects) | 43 passed, 2 skipped, 0 failed, 2.2 min |

**Each safeguard taken out again.** Thirteen single changes against the unit tests: a press keeping the scheme
shown; the toggle ignoring the dark screen; no `aria-pressed`; the symbol of the scheme shown; the toggle
after the language switch on the pass and in the sidebar; the page's plate in the light scheme; the plate for
a company with a dark-surface logo; the room's padding in the dark scheme only (missed at first: the class
string is the same in both schemes; the test now allows no dark-scheme class but the plate's two); a wide
shell logo that cannot give way; the platform tile on a plate in the light scheme; the platform tile without
the dark logo; the toggle without the language switch's look. A test failed for each; the files were
restored.

**Looked at.** Screenshots in the session scratchpad's `toggle13/shots/`: the bank's sign-in page and pass
(the transparent navy wordmark with white pixels in its diamond, the mark for dark surfaces), a yellow
company with one logo and with both, a company without a logo, light and dark, Arabic and English, 1440,
390 and 320 px; the company shell (sidebar and top bar) and the platform owner's (companies, a company, its
identity page); the page right after a press; the header at 320 px with a 20 px text size and with text
spacing; forced colours; the reception before and after a press. No sideways scroll on any. What they
showed and changed: the 320 px top bar ran a wide logo's plate under the toggle (F13-25's narrow bar).

## The owner's follow-up (2026-10-20): the sidebar's switches in the screen's corner

In the sidebar's top inline-end corner the two switches stood at the sidebar's inner edge, about a fifth
of the way across the screen. The owner asked for them in the screen's corner: top left in English, top
right in Arabic. They now start the sidebar's head on its inline-start side (`justify-start`), in the same
order (the toggle, then the language switch), with the lockup still under them at the sidebar's whole
width. The public pages and the phone's top bar keep the switches in the inline-end corner, which there
is already the screen's.

## Open items

- **Under System on a light device the reception screen still loads through a light frame**: the page is
  light until the session is known and the dark screen is drawn, as before this phase. Under an explicit Dark
  it is dark from the first frame. Making it dark before the first paint would need the pre-paint script to
  know the route, which it should not.
- **The browser chrome's colour on the reception screen** is the company's shell colour of the scheme, not
  the deep shell drawn around the dark screen (as before this phase).
- **The identity page's e-mail preview** draws the e-mail's light design; its dark design is seen in the
  e-mail texts' Light / Dark preview, which the server renders.
- **Back to "follow the device"** is not in the interface (F13-25, accepted by the owner): a device that
  pressed the toggle keeps its choice until it is pressed again, or the site's data is cleared.
- **A forced-colours mode draws every shell on the system's `Canvas`**, so a company's logo for dark
  surfaces (white) on the shell all but disappears there (seen with the bank's mark: its red square alone).
  This was so before this follow-up, and the toggle beside it shows; a fix would give the shell's logo its
  own forced-colours rule.
