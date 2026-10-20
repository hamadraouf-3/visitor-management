# Phase 12 — frontend decisions (a company's own identity)

Date: 2026-10-13. Scope: `frontend/**` (the new `src/identity/**`, the layouts and shared components that
show whose page it is, the auth redirects, the platform owner's identity page and e-mail texts in
`src/features/platform/**`, the i18n catalogs, the static shell `index.html` and `public/icons/`, the unit
tests and `e2e/**`), `frontend/README.md` and this file. No backend file was changed, and
`src/types/backend-contract.json` is the backend's own. Contract: the Phase 12 contract (per-company
identity) and the backend's hand-over (`phase-12-backend.md`, B12-1 … B12-17). The rules of the earlier
phases hold: direction C with the existing kit, Arabic (right to left, the default) and English from the
catalogs with type-safe keys, logical CSS properties only, no explanatory notes, and the style policy
`style-src 'self'`.

The rule of this phase: **a company's staff and visitors see their company and nothing else**. The product's
name («زوار موضوع» / "Mawdoo3 Visitors") and the Mawdoo3 logo stay in the platform owner's area
(`/platform/…`) alone; a page that is nobody's shows no logo and no name.

Each entry records what was built and every interpretation of, or deviation from, the contract.

---

## Whose page it is

**F12-1 — One resolution of the identity, for every page.** `identity/identity.ts`:
`resolveIdentity({pathname, search, me, publicBrand, remembered})` answers `{identity, pending, linkSlug}`,
where the identity is the product's, a company's (`{slug, name, nameAr, brand}`) or neutral. In order:

1. `/platform` and below: the product, always, whatever session or link there is.
2. `/pass`: the company its link names (`?c={slug}`), from the public brand endpoint, **whoever uses the
   device**: a signed-in receptionist of another company opening a visitor's link sees the visitor's company.
   Without `c`, or for a slug nobody has: neutral.
3. A session: its company (`Me.company.slug`, `name`, `name_ar`, `brand`).
4. No session and a company in the address (`/c/{slug}`, `/c/{slug}/login`, `?c={slug}`): that company's
   public brand; neutral when no active company has the slug (the same page as `/login`, and no word about
   whether the company exists).
5. A page of the app while the session is not known yet (the first moment of a load): this device's own copy
   of the company it last signed in to, so the page does not start in the default colours and change.
6. Otherwise neutral.

`pending` is true while a company named by the address is still on its way and the device has no copy of it:
nothing of an identity is drawn meanwhile (not the neutral mark either), and the room for the logo is kept, so
the form does not move when it arrives. `useIdentity()` is the hook; it reads the session from the query
cache without asking for it, and asks the public endpoint only when rule 2 or 4 needs it (`needsPublicBrand`).

**F12-2 — The palette is set through the CSSOM, on the stylesheet's own tokens.** The style policy allows no
`<style>` element and no style attribute in markup, so nothing is injected. In `index.css` every token a brand
colours reads a custom property with the product's colour as its fallback:

```css
--color-accent: var(--brand-light-accent, #188086);
```

56 properties in four sets: `light` (15, the content area), `dark` (16, the dark colour scheme and dark
panels), `shell` (10, the coloured shell) and `deep` (15, the shell of the dark scheme and around the dark
reception screen). `identity/tokens.ts` computes their values for a palette (`brandTokens`) and
`applyBrandVariables` sets them with `element.style.setProperty` on the root element; with no palette every
property is removed and the stylesheet's own colours apply. Components keep their classes and know nothing of
it. Verified on the production build served with the production policy (see Verification): no violation
reported on 292 pages.

**F12-3 — The mapping uses the palette's roles as guaranteed, and computes the rest.** The contract guarantees
white on `strong`, `strong_hover` and `deep`; `on_bright` on `bright`; `bright` on `deep`; `strong` on `tint`
and on white. The app also puts brand colours on surfaces the palette knows nothing of (the grey canvas
`#f1f1f1`, the dark cards), so:

- **light**: `accent` and the shell are `strong`; `accent-hover` is `strong_hover` (a lighter step where a
  colour cannot get darker visibly: black); coloured text (`accent-text`) is the first of `strong`,
  `strong_hover`, `deep` that reads 4.5:1 on white, the canvas, the muted and sunken surfaces, the tint and a
  highlighted row (the product's own teal reads 4.16:1 on the canvas, so its text is `strong_hover`, as
  before this phase); focus rings, the tab indicator and the first chart series are the first role that
  reads 3:1 on the surfaces and the tab track; `selection` is `bright` under `on_bright`; the highlight
  numeral of the ink tile is `bright`, lightened only if it does not read on ink.
- **dark**: the accent is `bright` (lightened only until it shows 3:1 on every dark surface) under
  `on_bright`; its text form is lightened until 4.5:1; chosen options and the emphasis tile stand on `deep`
  (darkened only until the dark set's texts read on it).
- **shell**: `strong`, with `strong_hover` as its cards (a computed step where that is not white-safe or not
  distinguishable); the current page is a white pill with `strong` text; hover and the language switch's
  outline are `tint`.
- **deep**: `deep`, with lighter steps on which white keeps 7:1; its accent is `bright`.

A colour is only ever moved in the direction that adds contrast (`ensure`: towards white on dark surfaces,
towards black on light ones, 4 % at a time), and only when the palette's own role fails the pair. A palette is
used only after `paletteProblems` found it keeping the guarantees (`parseCompanyBrand`); one that does not is
dropped and the default colours stay, so no answer of the API can make a page unreadable.

**F12-4 — The mapping is held by tests on the server's real palettes and on palettes harder than those.**
`identity/tokens.test.ts` (Node environment) reads `index.css` and fails when the stylesheet and
`BRAND_TOKEN_NAMES` do not name the same properties, or when a neutral colour the mapping computes against
is not the stylesheet's. Then every text, boundary and focus pair that `designTokens.test.ts` holds for the
product's own colours, plus the pairs a brand adds, is computed (WCAG 2.x) for:

- **244 palettes of the server's own derivation** (`src/test/serverPalettes.json`: `app.core.palette`,
  algorithm `oklch-1`, written out with the backend's interpreter for the named colours, a ramp of greys and a
  grid of 6 steps a channel): each passes `paletteProblems` and every pair in the four sets;
- the named awkward colours (yellow `#f7b916`, black, white, a very light one, a grey, a neon green, …) and a
  grid of 9 steps a channel (729 colours) through `referencePalette`, a stand-in derivation of the tests;
- 3,000 random palettes that **only just** keep the guarantees, each role a hue of its own: harder than any
  palette derived from one colour, so the mapping relies on the guarantees and on nothing else.

**F12-5 — No flash of another identity.** `identity/storage.ts` keeps, per device, the slug of the company
last signed in to (`vms.company`) and the last six public brands seen (`vms.brands`, at most 64,000
characters, each entry validated on every read: a slug's shape, same-origin asset addresses of the one
allowed form, a palette that keeps the guarantees). `applyBootIdentity()` (`identity/boot.ts`) runs in
`main.tsx` before React renders and puts the device's copy on the document: the palette, the browser chrome's
colour, the tab's icon, the manifest link. The public brand query starts from that copy
(`initialData` with `initialDataUpdatedAt: 0`) and asks the server again at once; `IdentityController`
(mounted in `RootLayout`) keeps the document in step in a layout effect, stores the server's answer, and on a
404 drops the copy and forgets the company. What is stored is only what the public endpoint tells anyone:
names, a default language, addresses of public images, colours.

A device that has **never** seen the company has no copy: a visitor opening a pass for the first time, someone
following a sign-in link. The page would paint the default colours (the primary button, the pass card's
head) and change them a moment later, which is the first thing a visitor would see of the company. So
`primeBootIdentity()` asks for the public brand **before the first render** and `main.tsx` renders once it is
on the document, or after 800 ms at the latest (on a slow connection the form comes first, without an
identity, and takes it when it arrives: the room for the logo is kept, nothing moves). The request is the
page's own query (`publicBrandQuery`), so nothing is asked twice. Every other page renders at once: an
address that names no company, and a company the device has a copy of. The mocked layout spec records what
the root element carries at the moment the first heading is in the document, and fails without the wait.

**F12-6 — The static shell is nobody's.** `index.html` has no product name: the title is
«الزوار | Visitors» until the app sets its own, the description is generic in both languages, the icon links
are the neutral ones, and there is **no manifest link** (a browser must not offer to install "Mawdoo3
Visitors" from a company's sign-in page). `IdentityController` then sets, per identity: a company's own icon
(`brand.icon_url`, or the neutral set when it has none) and its manifest
(`/api/v1/public/companies/{slug}/manifest.webmanifest`; none on the visitor's pass, where the public brand
and its files are all the page asks for); the product's icons and `/manifest.webmanifest` in the platform
owner's area (`start_url` is now `/platform`); the neutral icons and no manifest otherwise. The neutral icons
(`public/icons/neutral-16/32/48/192.png`, `neutral-apple-touch-icon.png`: a visitor's outline in white on
slate `#33444e`) are drawn by `scripts/generate-icons.mjs`; the product's icons are byte-identical to before.
`theme-color` follows the shell: `strong` in the light scheme, `deep` in the dark one.

**F12-7 — Logos.** `components/app/CompanyLogo.tsx`, by where it stands:

- the shell and other dark surfaces: `logo_dark_url`; else the light logo **on a white plate**
  (`[data-logo-plate]`); else the company's name as a text wordmark;
- a light page (sign-in, password pages, errors, the visitor's pass): the light logo; in the dark colour
  scheme the dark-surface logo through `<picture>`, or the white plate when the company has none;
- paper: the light logo.

A logo keeps its proportions inside a box per place (a wide wordmark and a square emblem both fit), is named
by the company in the UI language (`alt`), and falls back to the name when its file does not load. It never
falls back to the product's logo: a company without a logo is its own name, in the default colours.
`IdentityLockup` is what a page uses: the company's logo, the product's lockup in the platform area, or the
page's `neutral` content.

*The light page changed by F13-26 (2026-10-19): in the light scheme the logo stands on the page itself, without a
plate.*

**F12-8 — The neutral sign-in page.** No logo, no name. In the logo's place stands direction C's dark tile
with the page's own symbol (`NeutralMark`: a lock on the sign-in page, a key on the password pages), in
`bg-emphasis` with the highlight colour, so the page has the product's shape without anybody's mark. The
title is the page's alone ("Sign in"). A slug nobody has shows exactly this page (the mocked layout spec
compares the two screenshots).

**F12-9 — The product's brand cannot leave the platform area: three guards.**

1. By construction: `BrandLockup` and `BrandLogo` render nothing unless the address is under `/platform`
   (`BrandLockup.test.tsx`).
2. In the source (`productBrandGuard.test.tsx`): only seven listed files may import `BrandLockup`,
   `BrandLogo`, `BRAND`, `brandName`, `productName` or `useProductName`; no source outside `brand.ts` writes
   the product's name or its logo files; no catalog text names the product.
3. On screen (the same file, 52 tests): every kind of page outside the platform area (sign-in, the company
   sign-in pages, password pages, the pass, the shell's pages, error pages, the printed sheets) is rendered
   for a company with an identity, one without, and nobody, in both languages, and nothing of the product is
   in the document: not in the text, the title, an image, the tab's icon or the manifest link.

Eight mutations were run against them (the lockup rendering everywhere; a tenant layout importing it; a page
of nobody falling back to the product; a catalog text naming the product; a company page showing the lockup;
a company title ending with the product's name; a company page keeping the product's icons and manifest; the
neutral page keeping them): each one failed between 1 and 57 tests, and the suite passed again without it.

## Addresses and the device's company

**F12-10 — A company's own sign-in page.** `/c/{slug}` and `/c/{slug}/login` show the sign-in page in the
company's identity; `/login`, `/forgot-password`, `/reset-password` and `/pass` take `?c={slug}`. The links
between the signed-out pages keep the company (`withCompany(path, linkSlug)`; `c` is always the first
parameter and never repeated), and the links the server writes arrive with it (`/pass?c={slug}#{token}`,
`/reset-password?c={slug}#token=…`, `/forgot-password?c={slug}`, B12-14). `isCompanySlug` is the server's
shape for a slug; anything else in `c` is no company. `safeNextPath` never accepts `/c/…` as a place to
return to, as it never accepted `/login`.

**F12-11 — The device remembers its company.** After a sign-in the company's slug and brand are stored
(F12-5). From then on `signInPath()` (`auth/redirect.ts`) is `/c/{slug}`: a sign-out, an expired session,
another tab's sign-out and a guarded page opened without a session all lead there (with `?next=` as before),
and `/login` itself redirects there, keeping its query. A company that no longer answers (deactivated, or a
slug that is gone: the public endpoint's one 404) is forgotten on the spot: the page is the neutral one and
`/login` is the plain page again. The form is the same on every sign-in page (an address and a password, and
the server finds the account): a person of another company can sign in on a company's page, and the device
then remembers theirs. Nothing on a company's page offers "another company": its people never need it.

**F12-12 — The visitor's pass asks for the public brand and nothing else.** `api/publicBrand.ts` fetches
`GET /public/companies/{slug}/brand` with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`: no
session cookie goes with it, and the pass page makes no other request to the API (no session check, no
manifest). The token stays in the fragment, which no request carries; it is not stored, and the QR code the
page draws encodes the same link with the company in it (`/pass?c={slug}#{token}`). The scanner and every
parser of pass links accept both forms (the shared vectors of `docs/contract/pass-token-vectors.json`, 63
cases). The flow spec records every request of a visitor's pass page and fails on any that carries the token
or is not the public brand or one of its files.

**F12-13 — A company's default language, for a device that has none.** On a company's signed-out page, a
device that has chosen no language and whose browser speaks neither Arabic nor English takes the company's
`default_language`. A choice made on the device, and the browser's own language, still come first.

## A company's pages

**F12-14 — Everything that showed the product shows the company.** The shell (sidebar, top bar, drawer), the
sign-in, forgot-password and reset-password pages, the visitor's pass (page and printed pass), the headers of
the printed evacuation list and of printed reports, the error pages inside the shell, and every document
title (`<page> · <company>` in the UI language; the page alone on a neutral page) go through
`IdentityLockup` / `useDocumentTitle`. A company's administrator has no control over the identity: no
navigation entry, no page, and the settings page is unchanged.

**F12-15 — The sidebar's user block no longer repeats the company.** The shell's head now is the company (its
logo or its name), so the line with the company's name under the user's name was the same words twice. It
stays in the account menu's header, where the account is described.

**F12-16 — Status colours never follow the brand; the first chart series does.** A status is always the same
colour, in every company (a red brand must not make "Checked in" red, nor a green one make "Cancelled" look
fine). Charts: the first series (`chart-1`) takes the brand's mark colour (`strong`, or a darker role where
that would not show 3:1 on the canvas; `bright` in the dark scheme, with `chart-2` a lighter step of it), so a
company's reports are in its colour; the other series keep the neutral ramp.

## The API in the client

**F12-17 — Types and calls.** `types/api.ts`: `BrandPalette`, `CompanyBrand`, `PublicCompanyBrand`,
`CompanyBrandUpdate`, `BrandPaletteRequest`, `BrandImageParams`; `Me.company.slug` and `.brand`;
`PlatformCompany.brand`; the error code `UNSUPPORTED_MEDIA_TYPE`; the field codes `invalid_color`,
`invalid_image`, `image_too_small` {min_width, min_height}, `image_too_large` {max_width, max_height},
`image_not_square`, each with a text in both catalogs. `api.contract.test.ts` passes against the backend's
regenerated snapshot (89 of 89). `api/client.ts` can send a binary body (`binary: {body, contentType}`);
`api/platform.ts` has the brand calls (read, `PUT`/`DELETE` an image, `PATCH` the colour, preview a palette)
and the seven e-mail text calls under `/platform/companies/{id}/email-templates`.

**F12-18 — A brand from the API is checked before it is used** (`identity/brand.ts`, `parseCompanyBrand`,
`parsePublicBrand`). An image address must be exactly the public image endpoint's for that kind, with at most
the one `v` parameter (`/api/v1/public/companies/{slug}/brand/{kind}.png?v=…`): it goes into `src`, `href`
and `localStorage`, and nothing else may. The colour and the palette come together or not at all, and the
palette must keep the guarantees (F12-3). What fails is left out (no logo, the default colours); the rest of
the brand is still used. Addresses are used as given (they carry the image's own version, B12-11).

**F12-18a — A brand's files are its own company's (the security review of this phase).** The review planted
a copy for `evil-co` in the device's storage whose logo was `demo-company`'s, and `/c/evil-co` showed that
logo: the address was a valid brand file, only not that company's. Now every parser takes the company's slug
(`parseCompanyBrand(value, slug)`, `isBrandAssetUrl(value, kind, slug)`; `parsePublicBrand` uses the brand's
own `slug`) and an address is kept only when the company in its path **is** that slug: for the device's copy,
for the public endpoint's answer, for a session's company and for the platform owner's lists alike. A brand
whose company is not known has no files. And the server's answer always replaces what the device held:
the public brand is asked for again on every load (the copy is stale from the start), a 404 drops the copy,
and `writeCachedBrand` rewrites the entry unless storage already holds exactly the answer's words, compared
as they are stored (before, an entry that only *read* the same after validation, because its planted logo
had been refused, stayed in storage as it was). Regression tests: `brand.test.ts`, `storage.test.ts` and
`identityRuntime.test.tsx` ("a copy on the device that somebody planted": the foreign logo is never drawn,
not even until the server answers; the server's answer replaces the page and the storage; a forged session
brand shows the company's name instead). Four mutations that undo one part of this each fail them. The rest
of what the review attacked held as built: the pass page sends only the slug; planted copies with foreign,
`javascript:` and `data:` addresses, CSS in a colour and markup in a name draw nothing; `next` and `c` stay
same-origin.

## The platform owner

**F12-19 — "Identity" / «الهوية», a page of a company** (`/platform/companies/{id}/identity`). One column of
cards (logo and icon, colour, sign-in link) and the live preview beside it from `xl` (it follows the page
while scrolling), under it on smaller screens. The model:

- **A draft, then one save.** Chosen pictures and the colour are staged on the page; the status line says
  "You have unsaved changes." and leaving asks first (`UnsavedChangesGuard`). *Save identity* sends a file per
  request (logo, icon, dark-surface logo), then the colour; a step that fails leaves what is not saved yet on
  the page, with its problem at its own control.
- **Taking away something saved is its own action**, at once, after one line: "Remove the logo?" /
  "Reset to the default colour?" (an `alertdialog`). Dropping a picture that is only staged asks nothing:
  nothing is lost.
- The square icon is **made from the logo** when a logo is chosen (the logo at 76 % of a white tile), labelled
  "Made from the logo", and can be replaced by a picture chosen by hand, which a later logo then leaves alone.

**F12-20 — Every picture is prepared in the browser; the original bytes never leave the device**
(`identity/imagePipeline.ts`). A chosen file of any type is decoded through an `<img>` (an SVG is rasterised
by the browser, at the size it states or its viewBox's), the transparent room around the drawing is cut away,
and it is drawn on a canvas inside the contract's limits and encoded as PNG: a logo 32–1200 px wide and
32–600 px high (a raster picture is only ever made smaller; one that is too small is enlarged as far as the
limits allow and given transparent room), an icon square, 192–512 px, on white. A PNG above 512 KiB (a
photograph as a logo) is drawn smaller, a fifth at a time, and refused as "too much detail for a logo" when
that is not enough. A file above 25 MB is refused before it is decoded; one the browser cannot decode is
refused with "This file cannot be read as an image. Choose a PNG, JPEG, WebP, SVG file." Nothing of the
original (metadata, an SVG's script, a second file after the first) can reach the server, which checks the PNG
strictly all the same (B12-2). The geometry and the colours are pure functions with unit tests; the DOM part
is tested with a fake `Image` and canvas, and by the mocked layout spec with the real ones (the request body
is a PNG of the fitted size, never the chosen file).

**F12-21 — Suggested colours come from the logo's own pixels** (`extractColours`). Transparent, near-white
and near-black pixels are left out (a background, a plate, black text); the rest is counted in 5-bit shades,
shades closer than a threshold are one colour (an antialiased edge, a JPEG's noise), a colour under 2 % of the
coloured pixels is dropped, and up to five are offered, the most used and most vivid first, each as a swatch
with its hex value. A saved logo's colours are read the same way from the API's own file. One tap takes a
colour; the hex field (three or six digits, any case, normalised to lower-case `#rrggbb`) and the native
colour input do the same.

**F12-22 — The preview is the server's palette on the app's own classes.** The colour in the field is sent to
`POST /platform/brand/palette` once it has stayed the same for 300 ms (the saved colour's palette came with
the company and is not asked for again), and the answer is put on the preview alone
(`useTokenScope`: the same mapping as F12-3, set on the preview's elements, in this device's colour scheme),
so the platform owner's own page keeps the product's colours. It shows a small shell with the logo and the
current page's pill, a primary button, a chip and a link on the content area, and the head of an e-mail as
the server lays it out (B12-12: the bar in `strong`, the logo or the name on white, the kind of message on
`tint`, the primary button in `strong` under white). `strong` may differ from the colour typed (a yellow is
darkened until white reads on it): the preview shows what people will see, not the swatch.

**F12-23 — The company in the platform's lists.** The companies list and a company's page show its logo on a
white plate (a building tile where it has none), and a company's page has an identity card: the logo, the
colour's swatch and value, the sign-in link with a copy button (`{origin}/c/{slug}`), and the ways to
"Edit identity" and "Email texts".

*Changed by F13-26 (2026-10-19): in the light scheme the logo stands on the card, without the plate; in the dark
scheme it is the company's logo for dark surfaces, or the logo on its plate for a company without one.*

**F12-24 — "Email texts" of a company, for the platform owner**
(`/platform/companies/{id}/email-templates[/{kind}]`). The Phase 11 list and editor serve both: they read
where their data comes from, which query keys they use and where their links lead from an
`EmailTemplatesSource` (`features/admin/emailTemplatesSource.ts`), the company's own endpoints by default and
the platform's under `/platform/…` (`platformEmailTemplatesSource`). List, editor with the server's checks
while typing, the draft's preview, the saved e-mail in its sandboxed frame, reset, and "Send test": the test
goes to the platform owner's own address (the page says where it went), never to anyone of the company
(B12-8). The texts are the company's: its administrators see and change the same ones.

**F12-25 — The audit logs** name the new action (`COMPANY_BRAND_UPDATED`: "Company identity updated" /
«تحديث هوية الشركة») and have words for its metadata (`changed_fields`, `removed_fields`; `logo`,
`logo_dark`, `icon`, `color`) and for the new rate-limit policies, in both trails.

## Texts

**F12-26 — Both catalogs, natural Arabic.** Every new text is in `locales/{en,ar}/platform.json`,
`errors.json` and `admin.json`: «الهوية», «الشعار والأيقونة», «شعار الخلفيات الداكنة», «أيقونة التطبيق»,
«ألوان من الشعار», «معاينة», «رابط تسجيل الدخول», «نصوص الرسائل», «البريد الإلكتروني». No Latin word stands in
an Arabic text (formats and examples are variables), and the page has no explanatory notes: labels, the size
of a picture, problems, and one line before something is lost.

## Tests

**F12-27 — Unit tests** (Vitest; counts under Verification). New: `identity/brand.test.ts`,
`identity.test.ts`, `storage.test.ts`, `document.test.ts`, `tokens.test.ts`, `imagePipeline.test.ts`,
`identityRuntime.test.tsx` (the company sign-in pages, the links that keep the company, the remembered
company, sign-out, a company that is gone, the shell's palette, the language of a device without one),
`components/app/CompanyLogo.test.tsx`, `productBrandGuard.test.tsx`,
`features/platform/CompanyIdentityPage.test.tsx`, `PlatformEmailTexts.test.tsx`. The existing tests of the
pages that showed the product's lockup now assert the company's identity and the absence of the product.

**F12-28 — End-to-end specs.**

- `e2e/flows/company-identity.spec.ts` (the real API): the platform owner chooses a logo file, takes the
  colour found in it and saves; the company's sign-in link shows its identity; its administrator signs in
  and the shell has the palette (computed custom properties and the shell's background) and the logo; an
  invitation in the outbox carries the company's logo and colour and nothing of the product; the visitor's
  pass is in the company's identity and sends the token nowhere; sign-out leads to the company's page; the
  general `/login` is nobody's; Other Corp is its name in the default colours; the seeded company keeps the
  identity its seed gave it.
- `e2e/quality/identity-colours.spec.ts` (the real API): a company whose colour is the yellow `#f7b916`,
  black and a very light colour, in English and Arabic, signed out and signed in, light and dark: no serious
  or critical axe violation and no horizontal scroll, on the desktop and the phone; and the platform owner's
  pages of that company.
- `e2e/phase12-identity.spec.ts` (the API mocked): the shell in three colours with and without a logo for
  dark surfaces, in both schemes and languages; a company without an identity; no flash while the session
  check or the public brand is on its way; a first visit that opens in the company's colours; a copy planted
  in storage that cannot lend another company's logo; the neutral page and an unknown slug as one page; the
  upload as the canvas's PNG.
- Updated to the new rule: `e2e/i18n-smoke.spec.ts` (the neutral sign-in page; the shell with the seeded
  company's own logo and its Arabic name in the title), `flows/platform-owner.spec.ts` (an ended session of a
  deactivated company lands on its sign-in page, which is neutral, and the device forgets the company),
  `flows/email-texts.spec.ts` (a company's e-mail is headed by its name; nothing names the product),
  `flows/acceptance.spec.ts` (a pass link names its company), `quality/accessibility.spec.ts` (a company's
  signed-out pages and the platform's identity and e-mail text pages), the mocked `Me` and `PlatformCompany`
  of eight layout specs, and the global setup's warm-up.

## The backend's hand-over, as met

Built against the contract while the backend was written, then compared with `phase-12-backend.md` and the
regenerated snapshot. Nothing had to change in behaviour; what was mirrored afterwards:

- the error code `UNSUPPORTED_MEDIA_TYPE` (415 for a brand image that is not sent as `image/png`), the five
  field codes of F12-17 and the query `BrandImageParams`, with their catalog texts and the contract test's
  list of queries;
- the e-mail fixtures of the tests and of the mocked layout spec: a company's e-mail is headed by the
  company's name ("Mawdoo3 | موضوع", or the one name where both are the same) and ends "Sent by {company}." /
  «أُرسلت من {company}.», one line per language with nothing between them (B12-12);
- the preview's e-mail (F12-22) follows the server's own header;
- `e2e/support/env.ts` pins the three new budgets (public brand per address and per prefix, brand changes per
  platform account) at their defaults, as it pins the others.

Decisions of the backend that the SPA depends on, each covered by a test here:

- `strong` may differ from the colour (darkened to 5:1 where white would not read), `strong_hover` is lighter
  than `strong` for a near-black colour, `bright` is the colour itself when it is light and vivid (B12-5):
  the mapping draws with the roles and never with `color`, shows a hover that differs from the fill whichever
  way it went, and `paletteProblems` does not require `strong_hover` to be darker;
- image addresses carry the image's own version and are used as given (B12-11): the SPA builds none;
- a company without an icon has a manifest without icons (B12-10): the tab shows the SPA's neutral icon;
- an upload's problems arrive on the field `file` (B12-6): the page says them in its own words under the
  picture they concern; 413 and 415 (which the page's own pipeline never causes) have a text too, and
  nginx's 503 while eight uploads are in progress shows the server's message;
- an interlaced or animated PNG is refused (B12-2): a canvas writes neither;
- a deactivated company answers the public endpoints like one nobody has (B12-9): F12-11.

## Verification (2026-10-13)

**Gates**, on the final code:

| Gate | Result |
|---|---|
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run lint` (oxlint, warnings fail) | clean |
| `npm test` (Vitest) | 149 files, 1,937 tests, all passed (before this phase: 138 files, 1,574 tests) |
| `src/types/api.contract.test.ts` | 89 of 89 against the backend's regenerated snapshot |
| `npm run e2e:typecheck` | clean |
| `npm run build -- --outDir <scratch> --emptyOutDir` | built (the app chunk 312 kB, 89 kB gzipped) |
| `npm run e2e -- --retries=0` (the real API on 8700, `vms_e2e`) | 401 passed, 49 skipped (specs that run on one project only), 0 failed, 22.7 min |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` (the backend's interpreter) | 46 tests, OK |

The first full end-to-end run had four failures, all in the new specs themselves: the colour spec's tests
need more than the project's 60 s for their dozen pages (they have a timeout of their own now); a locator
named "Colour" also matched the native colour input; a check for the word "manifest" met a comment of
`index.html`; and the recorder of brand changes counted the palette preview. One of them led to a real
change: the sign-in button's colour was read while it was still turning from the default teal to the
company's colour, which is what a first-time visitor saw too (F12-5, the wait before the first render).

**The layout specs that mock the API** (my own Vite on 5931, nothing else running):
`e2e/phase12-identity.spec.ts`, 14 tests on three viewports: 42 passed; the eight existing layout specs:
56 passed, 28 skipped by viewport. The mocked API answers the server's own palettes for the colours used
(`mockPalette`).

**The production build under the production policy.** `vite preview` serves `dist` with the headers of
`frontend/config/securityHeaders.ts` (identical to nginx's, held by `deploy/verify`), among them
`style-src 'self'`. 292 pages were opened on it with the API mocked: the sign-in pages, the shell and its
drawer, the dashboard, the visitor's pass, the identity page with a real file chosen, a colour taken and the
preview drawn, and the platform's lists, for three brands with and without a logo for dark surfaces, a
company without an identity and the neutral page, in Arabic and English, at 1440 and 390 px, light and dark.
Every page came with the policy; no `securitypolicyviolation` event and no console error on any of them, and
the 56 brand properties were on the root element of the 168 pages of a company with a colour.

**Visual check.** The same 292 scenes on the dev server, with the server's own palettes (dark blue
`#1e3a8a`, orange `#f97316`, the yellow `#f7b916`): axe (WCAG 2.0, 2.1 and 2.2, A and AA) without a
violation, no horizontal scroll, no broken image, nothing of the product outside the platform area.
Screenshots: the session scratchpad's `phase12-shots/ui/`.

**Live check.** My own API on 8931 and Vite on 5931 against a throwaway database (`vms_p12live_<hex>`:
created, migrated to `0015`, `seed-demo`, dropped afterwards; both servers stopped), with Playwright's
Chromium. The platform owner gave "Petra Logistics" an identity through the page: an SVG as the logo (the
browser drew it at 891 × 336 px), a PNG for dark surfaces, the icon made from the logo (512 × 512), the
colour found in the logo (`#f97316`, for which the server answered `strong` `#b85000`); "Sahara Sun" a logo
for light surfaces only and the yellow typed in upper case (saved as `#f7b916`, `strong` `#8f6900`,
`bright` the yellow itself); "Atlas Trading" nothing (a text file was refused there, a photograph was
prepared and discarded). Then: the six signed-out pages (neutral, an unknown slug, the three companies and
the seeded one) in both languages, at both widths, light and dark; Petra's administrator signing in on
`/c/petra` with the temporary password; the shell and its pages for the four companies; an invitation in
the outbox (the company's logo inline, byte for byte the public file; its colour; headed and signed by the
company; nothing of the product) rendered at 700 and 390 px; the visitor's pass in both languages and
schemes, asking for the public brand and its files only, without the token and without a cookie; the
company's manifest; sign-out leading to `/c/petra`; an icon removed and a colour reset after their one line
each; both audit trails. 162 screenshots and 205 checks without a finding, and 17 more of the platform
owner's pages in Arabic (the first part's had all been in English: the owner's stored language won). The
printed evacuation list and report carry the company's logo (the PDF Chromium prints embeds it).
Screenshots: `phase12-shots/live/`.

**Mutations.** Eight against the guards of F12-9, four against F12-18a and one against the first-visit wait
of F12-5: each fails the tests that hold the rule, and the suites pass again without it.

## Open items

- **A company without an icon** has a manifest without one (B12-10) and the neutral icon in the tab.
  Whether a browser offers to install such an app is the browser's decision; with an icon it does.
- **The logo for dark surfaces is not used in e-mails**: the server shows the logo for light surfaces on a
  white header (B12-12), so the identity page's e-mail preview does the same.
- **Without the network** the device's validated copy of a company's identity is what a signed-out page
  shows; it is replaced as soon as the server answers.
- **The device's company** is one per device: on a device shared by two companies, `/login` leads to the page
  of the one that signed in last (anyone can still sign in there, F12-11).
- `docs/development.md` (§2.4 and §2.5, the language conventions and the design tokens) says nothing yet of
  a company's palette on the tokens; `frontend/README.md` does ("Whose page it is").
- The end-to-end runs sometimes log "wasm streaming compile failed" from the dev server: the reception
  page's QR decoder was still loading when a test closed its page. No test fails on it, and it is older than
  this phase.

---

## The UX review of Phase 12 (2026-10-14)

A review of the finished phase with seven made-up companies (a yellow, a pastel, a neon, a navy, a red, a
black one and one with a very long name; logos of every shape, a JPEG, white versions, an SVG) found fourteen
things. Each entry says what was wrong, what its cause was, what was built and which test holds it. One
decision of the review's own is the lead's: a company's colour is shown **as itself** on its surfaces (a
contract addition, B12-21).

**F12-29 — A company's own colour on its surfaces (review 1).** The palette had `strong` for everything
under white text, so a light colour never appeared: the yellow `#f5b800` gave an olive shell and olive
buttons (`#8e6900`), a pastel pink a mauve, a neon green a dark green. `BrandPalette` now has three more
roles (`surface`, `on_surface`, `surface_hover`: the colour itself wherever white or the dark ink reads on
it at 4.5:1, its ink, its hover step; the darkened `strong` only for the mid-tones on which neither reads),
and the mapping (`identity/tokens.ts`) uses them:

- **light**: `accent` (the fill of primary buttons and of a chosen segment) is `surface`, `on-accent` its
  ink, `accent-hover` `surface_hover`. What needs 3:1 on white as a line or a mark, and was `accent` before,
  is a token of its own now, `accent-strong` (with `accent-strong-hover`): the border of a chosen chip or
  option, the native checkboxes and radios (`accent-color`), the meter of a KPI, the hovered bar of a chart.
  Seventeen class names in fifteen files moved; `accent` is a fill under `on-accent` and nothing else
  (F12-41 holds that). Coloured text, the focus ring, the tab indicator and the first chart series stay on
  `strong`, as before.
- **shell**: `surface` under `on_surface`, and **nothing on it is a fixed white any more**. Every token the
  shell's utility wrote as white reads a brand property: its three text colours, the current page's pill
  (`accent`: the ink itself, with the shell's colour as its text, the mirror of the white pill with teal
  text), the pill's hover, the dividers and the outline of tinted elements (the ink laid over the shell at
  22 %, 14 % and 30 %: `rgb(28 38 43 / 0.22)` on a yellow shell, `rgb(255 255 255 / 0.22)` on a navy one),
  the focus ring, the accent text, the text of a neutral chip, the danger text of a menu (the light set's
  red on a light shell's near-white menu). The signed-in user's tile (`highlight`) is declared in the shell
  and the deep set too: on a light shell it is an ink tile with the shell's colour as its letters, since the
  bright step under it would be the shell's own colour.
- **the hover fill** of a light shell is the ink laid thinly over whatever is below (`rgb(28 38 43 / 0.1)`),
  as light surfaces show a pointer: one solid step dark enough to show on the yellow was a heavy block on the
  near-white menu. Where the ink would no longer read on it (a surface that only just carries the ink: an
  orange), it is a solid step, chosen so it can be told from the shell, from its cards and from its menus (a
  step that went back to the shell's own colour was found by the test over the server's palettes).
- **`color-scheme`** of the shell follows (`--brand-shell-scheme`): a light shell's scrollbars are light.
- **a boundary where one is needed**: a shell that would blend into the grey canvas (white, a near-white)
  ends at a line (`shell-edge`, the ink at 16 %, on the sidebar's inline end and under the phone's top bar),
  and a primary button that would blend into its white card has an edge (`accent-edge`, an inset ring of
  1.5 px, so nothing moves). Both are no colour for every other company; "would blend" is a distance in RGB
  under 40, not a luminance ratio: a pastel and a grey of the same lightness are still two colours.
  **The button's edge is its ink, not `strong`.** The e-mails draw every button's edge in `strong` (B12-21),
  and the same was considered here. In an e-mail the button stands alone on the card. In the app a white
  company's primary button stands beside the secondary one, which is white with a grey edge already: an edge
  in `strong` (`#6f6f6f` for white) made the two the same button, and "Send invitation" could not be told
  from "Cancel" (`phase12-shots/fix/live/app-invite-pearl-en-1440-light.png` shows the pair as built). The
  ink is the heaviest line the button's own colours have, so the primary action stays the heavier one.
- **the dark colour scheme and the dark reception screen keep `deep` and `bright`**, as before.
- `theme-color` (the browser's chrome on a phone) is `surface`, as the manifest's is (B12-21).
- **the identity page's preview** is drawn through the same mapping, so it shows exactly this; its e-mail
  mirrors the server's (`app/email/identity.py`): the bar and the button in `surface` under `on_surface`,
  the button's edge, the name and the pill's text in `strong`.

A palette without the three roles (a copy a device kept from before; a process that was not restarted) is
completed as it was drawn then, `strong` under white with `strong_hover` as its step, and the server's next
answer replaces it: no device starts in the default teal because of the change. A palette that names some
of the three and not all is no palette. For the palettes of `oklch-2` nothing is computed here: the hover
step is the server's own for all 254 of the fixture (a test says so), since the derivation now keeps it
0.06 of OKLCH lightness from its surface.

*Deviation from the review's text, with its evidence.* The review asked for the logo for light surfaces
**directly** on a light shell. A company's colour is its logo's own: it is offered from the logo's pixels.
Drawn on that colour, the logo loses exactly what was drawn in it: the sun of the yellow company's logo, the
whole word of the neon one, the disc of the pastel one (`phase12-shots/fix/_direct-or-plate.png`, the
review's own three logos, both ways). So the logo for light surfaces stands **on its white plate on every
coloured shell**, light or dark; on a white shell the plate is not seen, which is the "directly" the review
meant. What the review's rule is for is kept: a light shell never carries the logo for dark surfaces (a
white logo on yellow): that one is drawn on a dark shell, on the deep shell and in the dark colour scheme
only (`CompanyLogo` `shellTone`, from the palette; `<picture>` hands the dark scheme its file without
script).

Held by `tokens.test.ts` (the 254 palettes of the server's derivation, 131 of them light surfaces under the
dark ink and 123 under white, 31 of those the mid-tones painted with `strong`: every pair of the four sets,
both kinds of shell counted apart; the hover veil checked on each surface it lies on; cards, hover fills and
menus told from the shell; the stylesheet's shell block may hold no fixed colour but three aliases),
`brand.test.ts`, `document.test.ts`, `AppLayout.test.tsx`, `CompanyLogo.test.tsx`,
`CompanyIdentityPage.test.tsx` (the preview and its e-mail), and in the browser by `e2e/phase12-ux.spec.ts`
(yellow, pastel, neon, near-white on three viewports in both languages: the computed colours of the shell,
its texts, the pill, the hover, the dividers, the focus ring, the user's tile, the boundary; axe; a navy and
a mid-grey under white).

**F12-30 — The account menu on a phone (review 2).** With a long company name the menu was 598 px wide at
390 px: its popup had a least width and no greatest one, and the company's line could not wrap, so the line
set the menu's width and "Change password" and "Sign out" lay off the screen. The popup of every `Menu` is
at most `min(20rem, 100vw − 1.5rem)` wide, and the company's line wraps and is cut after its second line.
Held at 390, 820 and 1440 px in both languages: the popup's box inside the screen, a tap in the middle of
each item reaches it, the name on two lines; and, since the wrapping alone already keeps today's menu
narrow, the popup's own limit is shown apart: with the name forced back onto one line the popup is as
narrow (`phase12-ux.spec.ts`). The classes in `AppLayout.test.tsx`.

**F12-31 — A logo is checked for the place it is chosen for (review 3, 7).** A white logo in the "Logo"
place was taken without a word and was a white box everywhere; a 27:1 strip was 136 × 5 px in the sidebar, a
1:4 column 8 × 32 px, a 36 px mark was enlarged. `prepareLogo(file, ground)` now refuses, with a message
under the place:

- `too-light`: nearly all of what is drawn (85 %, each pixel counted by how opaque it is) is near-white
  (it would show under 1.25:1 on white), with the place it belongs in: "…Choose a dark version here, and
  use this one as the “Logo for dark surfaces”." The mirror, `too-dark`, for the logo for dark surfaces
  (nearly all of it darker than about `#303030`): "…use this one as the “Logo”." The app icon too
  (`too-light-icon`: a white mark on the white tile is a blank icon). A picture **without** transparency is
  judged as the rectangle it is: only when all of it (98 %) is light, since nine tenths of a dark wordmark on
  a cream scan are the cream and it reads perfectly.
- `too-wide` beyond 8:1, `too-tall` under 1:2, `too-small` under 96 px on the longer side of what is drawn
  (a raster picture only; a vector one is drawn at any size). The app icon is not held to a shape: it is
  set on a square tile whatever it is, as before.

The measures are of the drawing, after its empty room and its flat background are gone. Pure functions
(`toneShares`, `toneProblem`, `shapeProblem`) with unit tests; the review's own seventeen files through the
real canvas; `phase12-ux.spec.ts` chooses drawn files on the page, and the live check the review's files.

**F12-32 — A JPEG's white background is taken away, and a logo with a background stands on a plate (review
4).** (a) `clearFlatBackground`: a picture without transparency whose four edges are one flat near-white
colour (99.5 % of the edge pixels within 26 of their median; every channel at least 236) is cleared of that
colour from its edges inwards (within 36 of it, so a JPEG's noise goes too); what the drawing encloses, the
inside of a letter, stays. The pixels where the drawing meets the background, which are a mix of the two,
get the drawing's colour and the mix's share as their alpha, so no white fringe is left. For the logo for
dark surfaces the same with near-black. **A background of any other colour is left alone**: it may be the
logo's own tile, and what is drawn on it (white letters on a red square) would not stand without it, and
would then be refused as too light; the review's "(or uniform solid)" is not built for that reason. (b) On
the sign-in, password, pass and error pages the logo stands on a white plate with the cards' edge and room
around it, in the light scheme as it did in the dark one, so a logo saved before, or one with a tile of its
own, looks meant; with a logo for dark surfaces the plate lets go of its fill in the dark scheme. The room
kept for the logo while it is on its way is the plate's height (82 px), so the form still does not move
(the existing spec found that it did, by 9 to 18 px, before the room was made).

*(b) changed by F13-26 (2026-10-19): in the light scheme the logo stands on the page itself, no plate; the plate
is the dark scheme's alone, for a company without a logo for dark surfaces, in the same room.*

**F12-33 — The app icon of a wordmark is the company's letter on its colour (review 6, 9).** The icon made
from a logo was the logo at 76 % of a white tile: for a wordmark a speck in a browser tab. For a logo wider
than 2:1 the page now draws (`letterIcon`) a 512 px tile in the palette's `surface` with the first letter of
the company's name in `on_surface`, in the app's own bold face, its ink centred and half the tile large;
the neutral slate under white for a company without a colour. The letter is the first letter or digit of
the name the company's people read first (its Arabic name when its default language is Arabic and it has
one), after the Arabic article («البنك العربي» is «ب»). The tile is drawn again when the colour's palette is
known, and *Save identity* waits for it (the icon is never saved in the colour before); a tile that cannot
be drawn holds nothing back. "Replace" stays.

Where an icon came from is the page's memory for one visit (`IconOrigin`): the server has no such fact, and
none was added. So: an icon the page made during the visit follows the colour, also after it was saved; an
icon chosen by hand is left alone by a new logo and by a new colour; an icon saved before the visit is
nobody's to redraw. **Removing the logo removes the icon with it**, in a second request, and the one line of
confirmation says so ("…and the app icon is removed with it."), unless the icon was chosen by hand during
the visit. When the second request fails, the logo is gone and the icon is not: the dialog closes, the page
shows what is left, and "Remove" on the icon asks its own question.

**F12-34 — An emblem has the company's name beside it (review 8).** A square logo left a page without the
company's name. `CompanyLogo` measures the file once it has loaded (or as it is placed, when the browser
already holds it) and, for a logo at most 1.4 times as wide as tall, writes the company's name beside it: in
the shell (two lines in the sidebar, one in the phone's top bar), on the signed-out pages and the pass, on
the printed pass. The picture then has no text alternative: the name is read once. The printed sheets' and
the host's printed pass's headers already write the name beside the logo and are left alone
(`nameBeside={false}`).

**F12-35 — Whose identity or texts the platform owner is changing (review 5).** The three pages about one
company (its identity, its e-mail texts, one e-mail's texts) had the company only as a small way back or a
muted fact, and one tab title for every company. Each is now headed by the company's logo tile and, right
above the title, its name (`PageHeader`'s `leading` and a new `subject`), and names the company in the tab's
title: «الهوية · فنادق شمس الصحراء · زوار موضوع».

**F12-36 — The colours offered from a logo (review 10).** `#ffffd2` was offered for a navy and gold logo:
the pale halo a JPEG leaves between the gold and the white. A very light colour (one that would not show on
white) or a very dark one is offered only when a fifth of the logo has it; and two clusters a person would
call one colour (of one hue within 14°, about as light and as vivid, or closer than 66 in RGB) are one, under
the more used one. With the background gone (F12-32) the halo's pixels are mostly not there to be counted
either: the review's file now offers `#0a1f4a` and `#caa22a`, and nothing else.

**F12-37 — A slow first visit (review 11).** A device that had never seen the company, on a connection
slower than the 800 ms the first render waits, drew the form in the default teal and then faded to the
company's colour. While a company named by the address is on its way, the page is drawn with a palette of
its own, `PENDING_PALETTE` (the slate of the app's text: nobody's colour), through the same mapping as any
palette; and whenever the colours on the document change, transitions are off for two frames
(`data-identity-change` on the root, and one rule of the stylesheet), so a colour is replaced, never faded.
In the browser: the sign-in button's colour is read on every frame from its first one, and has exactly two
values, the slate and the company's (`phase12-ux.spec.ts`; the live check reads `--color-accent` the same
way against the real API held back for 2.5 s).

**F12-38 — The password pages follow the device's company (review 12).** `/forgot-password` and an older
`/reset-password` link without `c` were neutral on a device whose `/login` and 404 were its company's. Both
now lead to themselves with `?c={slug}` of the device's company (replacing the entry, as `/login` does).
The unit test caught what this could have done: the router's location still holds a reset link's fragment
after the loader has taken it out of the address bar, and carrying the location along wrote **the token
back into the address**. The redirect carries the path and the query, never the fragment; the test reads
every address written to the history.

**F12-39 — Touch targets, hit-tested (review 13).** The review listed four patterns as under 44 px by the
size of their boxes. Measured as a tap lands, with a coarse pointer (`e2e/support/touch-targets.ts`: the run
of points through a control, across and down, where `elementFromPoint` reaches it or its label), three were
never under 44 px for a finger: a row's name link (20 px of text; its hit area is the whole card), the back
link and the e-mail texts' variable chips (44 px tall on a touch screen: `pointer-coarse:`; the review's
figures are their heights with a fine pointer). **The checkbox was**: its box was a 24 px target of its own
with 12 px of nothing between it and its label. `Checkbox` is one target now: the label holds the box, the
gap and the words, 44 px tall on a touch screen. `e2e/touch-targets.spec.ts` measures every control of six
of a company's pages on the phone and the tablet and fails on any that is reached over less than 44 px.

**F12-40 — Arabic wording (review 14).** Each of the six is a validation message, a state or the one line
before something is lost, so each stays, reworded: «تعذّر قبول هذه الصورة. اختر ملفًا آخر.»; «أدخل رمز اللون
بهذه الصيغة: #188086.» (the same words now for the server's `invalid_color`); «يظهر الشعار على خلفية بيضاء في
المساحات الداكنة.»; «أُنشئت من الشعار» (and «أُنشئت من الاسم» for a letter tile); «تظهر أيقونة عامة في تبويب
المتصفح وفي التطبيق المثبَّت.»; and a list of formats is joined with the language's own comma
(«PNG، JPEG، WebP، SVG», `joinList`).

**F12-41 — The brand's fill is used as a fill only.** Nothing held the split of F12-29 in the components: a
class that went back to `border-accent` would draw a yellow company's chosen option in yellow on white, and
every test of the tokens would still pass. `identity/accentUse.test.ts` reads every source: the bare
`accent` may be a background in a class list that sets `text-on-accent`, the border of that same fill, or
the text of the inverse pair (`text-accent` on `bg-on-accent`, the disc of a scan result); any other use is
named with its file and line.

### The backend's round, as met (B12-21 … B12-26)

- **`BrandPalette` has eleven fields**; `types/api.ts` and the contract test agree with the regenerated
  snapshot. `src/test/serverPalettes.json` was written again from the final derivation
  (`derive_palette`, read-only, the backend's interpreter): `oklch-2`, byte for byte the file written while
  the backend was still being built, and the lead's examples are in it as given (`#f5b800`, `#f9c6d0`,
  `#39ff14`, `#ffffff`, `#ff6600`, `#188086`, `#000000`, `#808080`, `#ff0000`).
- **The manifest and the browser's bar** are `surface` (`themeColors`); the live check reads both.
- **The notice of a platform action is the company's e-mail** (B12-22): `e2e/flows/platform-owner.spec.ts`
  expects the company's name as the first line, "Sent by {company}." and no word of the product;
  `e2e/support/outbox.ts` says so. The live check: with the company's logo for a company that has one, and
  no `brand-logo` file for one that has none.
- **«[رسالة تجريبية] »** (B12-25) in `e2e/flows/email-texts.spec.ts` and the live check.
- The Arabic sentence of a window on another day, the subjects of long names and the e-mails' markup
  (B12-23, B12-24) touch no text or test of the web application: it shows an e-mail as the server renders it.
- No new endpoint, error code or field code: nothing to add to the catalogs.

## Verification (2026-10-14)

**Gates**, on the final code:

| Gate | Result |
|---|---|
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run lint` (oxlint, warnings fail) | clean |
| `npm test` (Vitest) | 151 files, 2,052 tests, all passed (before this round: 149 files, 1,937 tests) |
| `src/types/api.contract.test.ts` | 89 of 89 against the backend's regenerated snapshot (eleven palette roles) |
| `npm run e2e:typecheck` | clean |
| `npm run build -- --outDir <scratch> --emptyOutDir` | built (the app chunk 319 kB, 91 kB gzipped) |
| `npm run e2e -- --retries=0` (the real API on 8700, `vms_e2e`) | 442 passed, 56 skipped (specs that run on one project only), 0 failed, 28.2 min |
| the layout specs that mock the API (my own Vite on 5931; eleven spec files, three viewports) | 139 passed, 35 skipped by viewport, 0 failed |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` (the backend's interpreter) | 46 tests, OK |
| `deploy/verify/check_release_tree.py` | 1,075 files, no development artefact or credential |

The first full end-to-end run had one failure (441 passed), in a flow spec's own expectation:
`e2e/flows/company-identity.spec.ts` still expected the identity page's tab title of before ("Identity ·
Mawdoo3 Visitors"). The title names the company since F12-35; the spec says so now, and reads the name above
the page's title too. The suite was then run again from its start on the final code: the row above.

**Each safeguard taken out again.** 34 single changes each removed one thing this round added (the surface
as the fill; the two edges; the shell's ink; the switch that stops a fade and its rule in the stylesheet;
the pending palette; the remembered company and the fragment kept out of its address; each of the five
refusals and the icon's; the flat background; the two rules of the offered colours; the emblem's name; the
logo for dark surfaces kept off a light shell; the page's plate; the icon removed with its logo; the letter
tile, its colour, its label and the save that waits for it; the company in the platform pages' header and
title; a palette from before; a mark drawn in the fill colour; the checkbox's row; the menu's width and its
wrapping line; the room kept for the logo on the sign-in page). **A test failed for each.** Two passed at
first and got their assertion: the stylesheet's rule (the unit test held the attribute, not what it
switches), and the menu's own width (the wrapping line alone kept the menu narrow, so the limit could not
be seen until the spec took the wrapping away).

**Visual check.** My own Vite with the API mocked and the server's palettes: 384 scenes (eight companies:
yellow, pastel, neon, navy, red, black, near-white, mid-grey; each with a wordmark, an emblem, a logo with a
background of its own and none; Arabic and English; 1440, 820 and 390 px; light and dark; the visits page
and the sign-in page) and 60 more (the account menu, the drawer, focus and hover, the password page, the
pass, the 404, the platform's identity page): axe (WCAG 2.0, 2.1 and 2.2, A and AA) without a violation, no
horizontal scroll, no broken image, the shell in the expected colour, nothing of the product outside the
platform area, no console error. Screenshots and contact sheets: the session scratchpad's
`phase12-shots/fix/`.

**Live check.** My own API on 8931 and Vite on 5931 against a throwaway database
(`vms_p12uxlive_<hex>`: created, migrated to `0015`, `seed-demo`, dropped afterwards; the API stopped), with
Playwright's Chromium and the review's own files. The platform owner, through the page: the white version
of a logo refused in the "Logo" place with the place it belongs in, a strip, a column and a 40 px mark
refused, a black logo refused for dark surfaces; a wordmark taken, its icon "Made from the name" (the
uploaded PNG is a 512 px tile of `#f5b800`), the yellow typed in upper case and answered by the server as
its own surface under `#1c262b`; a JPEG's white background gone from the prepared logo (its corners
transparent) and `#0a1f4a` and `#caa22a` offered; a white company with a name of 90 characters; a navy one
with a square emblem. Their people: the shell in the company's own colour and the filled button under its
ink in both languages at 1440 and 390 px, the deep shell in the dark scheme, `theme-color` the surface, the
white company's shell and button with their edges, the emblem with the company's name beside it, the
account menu inside a 390 px screen. The e-mails in the outbox: the invitation's bar and button `#F5B800`
under `#1C262B` with the edge `#8E6900`, the company's logo byte for byte; the notice of a new
administrator headed and signed by the company, with its logo, and without a logo file for the company that
has none; «[رسالة تجريبية] » before an Arabic-led test. The manifests: `theme_color` the surface,
`short_name` at most 12 characters. A device that remembers its company: `/forgot-password` and
`/reset-password` lead to its pages, the token never in the address. A first visit with the brand held back
for 2.5 s: `--color-accent` read on every frame is the slate, then the yellow, never the teal. Removing
the logo after its one line: the icon gone with it. **72 screenshots and 170 checks without a finding**
(a first run reported four: the check read the shell's edge on the root element, where the shell's tokens
are not declared; the second run reads it on the shell). Screenshots: `phase12-shots/fix/live/`.

## Open items (after the review)

- **A white or near-white company's primary button** differs from a secondary one by its edge only (1.5 px
  of the ink against 1 px of grey): that is what a white brand colour is. A company that wants a filled
  button chooses a colour.
- **Where an icon came from** is known for one visit to the identity page (F12-33). An icon saved earlier
  is removed with its logo, since the page cannot know it was chosen by hand; the line of confirmation says
  that the icon goes.
- **A logo on a coloured tile of its own** (white letters on a red square, no transparency) keeps its tile:
  only a flat white (or, for dark surfaces, black) background is taken away (F12-32).
- `src/auth/sessionSync.test.tsx` ("clears the cache of a tab on a public page…") timed out once in one
  full run of the unit tests on a loaded machine and passed in every other run, alone and in the suite; it
  is older than this round and was not changed.
- `docs/development.md` (§2.4 and §2.5) still says nothing of a company's palette on the tokens;
  `frontend/README.md` does.
