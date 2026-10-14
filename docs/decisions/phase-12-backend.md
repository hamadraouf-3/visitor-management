# Phase 12 — backend decisions (a company's own identity)

Date: 2026-10-13. Scope: `backend/` (application code, revision `0015`, tests), `deploy/` (the nginx template
and snippet, `deploy/verify`), `scripts/demo_brand.py`, `.env.example`, `deploy/env/backend.env.example`,
`docs/contract/pass-token-vectors.json`, `frontend/src/types/backend-contract.json` (regenerated; no other
frontend file), `README.md`, `docs/initial-assessment.md` (revision 5), `docs/api.md`, `docs/security.md`,
`docs/architecture.md`, `docs/development.md`, `deploy/README.md` and this file. Two rounds followed the
phase's own entries (B12-1 … B12-17): [after the security review](#after-the-security-review-2026-10-13)
(B12-18 … B12-20) and [after the UX review](#after-the-ux-review-2026-10-14) (B12-21 … B12-26).

The user's request, decided with the user (the shared contract of this phase):

1. **Full company identity.** A company's staff and visitors see that company's logo and name everywhere:
   the application, the e-mails, the visitor's pass page. The product's name («زوار موضوع» / "Mawdoo3
   Visitors") and the Mawdoo3 logo are never shown to them; they stay in the platform owner's area and on
   platform-level e-mails.
2. **One colour**, chosen by a person; the system derives the shades, so text reads whatever was chosen.
3. **The platform owner alone** sets a company's logo and colour. A company's administrator cannot.
4. **Each company has its own sign-in link** showing its identity; the general sign-in page is neutral.
5. **The platform owner edits each company's e-mail texts** too (the texts the company's administrator
   edits).

Each entry records an addition to, or a deviation from, `docs/initial-assessment.md` (now revision 5, which
takes these decisions into the contract text). **Contract changes:** migration `0015`; 15 endpoints (78
operations on 61 paths in all); 3 response, 2 request and 1 query model in the snapshot (`BrandPalette`,
`CompanyBrand`, `PublicCompanyBrand`; `CompanyBrandUpdate`, `BrandPaletteRequest`; `BrandImageParams`); two
fields added to `Me.company` (`slug`, `brand`) and one to `PlatformCompany` (`brand`); 1 error code
(`UNSUPPORTED_MEDIA_TYPE`, 39 in all); 5 field codes (`invalid_color`, `invalid_image`, `image_too_small`,
`image_too_large`, `image_not_square`, 72 in all); the first `PUT` and the first `DELETE` of the API; 3
settings (`RATE_LIMIT_PUBLIC_BRAND_PER_IP`, `RATE_LIMIT_PUBLIC_BRAND_PER_PREFIX`,
`RATE_LIMIT_BRAND_CHANGES_PER_HOUR`); 3 rate-limit policies (`public_brand_ip`, `public_brand_prefix`,
`brand_changes_per_user`); 1 audit action (`COMPANY_BRAND_UPDATED`) and 1 metadata key (`removed_fields`);
new link formats (B12-14).

Where the shared contract of this phase said "decide", the decision is in the entry and repeated in
[Deviations and decisions for the frontend](#deviations-and-decisions-for-the-frontend).

---

## Storage

**B12-1 — A colour on the company, one row per image.** Revision `0015`:

- `companies.brand_color varchar(7) NULL`, CHECK `ck_companies_brand_color_hex`: NULL or exactly `#` and six
  lower-case hexadecimal digits (`^#[0-9a-f]{6}$`). The value goes into style sheets and e-mails as it is, so
  nothing but that spelling can be stored, whatever writes the row. NULL: the product's palette.
- `company_brand_assets`: `id`, `company_id` (FK `companies`, RESTRICT), `kind` (CHECK `logo`, `logo_dark`,
  `icon`), `content bytea NULL`, `byte_size`, `width`, `height`, `sha256 char(64)`, `version char(16)`,
  `created_at`, `updated_at`; `UNIQUE (company_id, kind)`. The image lives in the database, with the company:
  one backup, one tenant boundary, no file store to secure, and the four API processes need no shared disk.
  At 512 KiB an image, three a company, that costs nothing. `content` is loaded only where the image itself
  is served or attached to an e-mail (a deferred column); every other read is of the description.
- **A removed image is an emptied row**: the runtime role cannot delete (revision 0006), so `content` and
  the five columns that describe it are NULL together (CHECK `content_described`: all six or none).
- The CHECKs repeat the application's limits, so nothing outside them can be stored whatever writes the
  row: `content_png` (the PNG signature, `byte_size = octet_length(content)`, at most 524,288 bytes),
  `dimensions_valid` (logos 32–1200 by 32–600 pixels, the icon square and 192–512), `sha256_hex`,
  `version_hex`.
- Privileges: the runtime role gets SELECT, INSERT and UPDATE on the new table, granted by name as well as
  through the schema's default privileges; no DELETE, as everywhere. The start-up privilege allow-list
  accepts exactly that.
- The downgrade locks both tables (SEC-39) and **refuses while any company has a colour or an image**: both
  would be lost and no upgrade brings them back. The refusal names the two statements that clear them.

## Images

**B12-2 — An upload is checked and written again in pure Python; nothing is stored as it came.**
`app.core.png.sanitize_png` (standard library `struct` and `zlib`; no image library, no new dependency)
accepts exactly: the signature; chunks whose length fits the file and whose CRC-32 is right; `IHDR` first,
with a colour type and bit depth PNG defines (1- to 16-bit, grey, palette, truecolour, with or without
alpha), compression and filter method 0; dimensions inside the limits, **checked on the header before
anything is inflated**; at most one `PLTE` and one `tRNS`, where and as long as PNG allows; `IDAT` chunks in
one run; `IEND` last, empty, **with nothing after it**; no critical chunk it does not know; the image data as
one zlib stream that inflates to **exactly** the bytes the header implies, each scanline with a filter type
PNG defines. Inflation is bounded at one byte beyond that size, so a decompression bomb costs no more memory
than a valid image. The largest logo (1200 × 600 pixels of 8 bytes at 16 bits a channel) inflates to
5.5 MiB and the largest icon to 2 MiB; **a check costs twice that for a moment**, 11 MiB and 4 MiB
(measured, B12-19; this entry first gave the inflated size as the cost).

- **Interlaced images are refused** (the contract left it open). Nothing the product makes is interlaced
  (the browser's canvas never writes Adam7), and it would be a second, rarely exercised way to lay out every
  image. The answer says so ("Upload a PNG image that is not interlaced."). Animated PNGs (`acTL`, `fcTL`,
  `fdAT`) are refused likewise.
- 16-bit and palette images are accepted: they are PNG, and the check does not depend on the depth.
- What is stored is written again from the parts that draw the image: signature, `IHDR` (from the parsed
  fields), `PLTE` (palette images), `tRNS` (where allowed), the image data as **one** `IDAT`, `IEND`, each
  with a new CRC. Text, time stamps, ICC profiles, gamma, physical size, EXIF, private chunks and whatever
  followed `IEND` are dropped: a polyglot's second half never reaches the database.
- The zlib stream is carried over, not compressed again: the output then depends on the input alone (not on
  the zlib that happens to be installed), and writing a written file again changes nothing (**byte-stable**).
- The check does not decode pixels, so bytes an attacker chose survive as pixel values. They are served only
  as `image/png` with `nosniff` (B12-9).

**B12-3 — What each image may be.** The contract's limits, in one place (`app.services.brand.IMAGE_LIMITS`,
repeated as CHECKs, B12-1): `logo` and `logo_dark` 32–1200 pixels wide and 32–600 high; `icon` square,
192–512; every file at most 512 KiB (`BRAND_ASSET_MAX_BYTES`). `logo` is drawn for light surfaces (the
application's light theme, the white header of an e-mail), `logo_dark` for dark ones; the e-mails use `logo`
only.

## The colour

**B12-4 — One derivation of the palette, on the server, with guarantees.** `app.core.palette.derive_palette`
is the only implementation: the API returns the palette with the brand (`CompanyBrand.palette`), the e-mails
are coloured with the same one, and the platform owner's form previews a colour through
`POST /platform/brand/palette`. Roles: `strong` (surfaces under white text; text and links on white),
`strong_hover`, `deep` (dark surfaces), `bright` (accents on dark, fills under dark text), `tint`,
`tint_border`, `on_strong` (white), `on_bright` (the product's ink `#1c262b`); since the UX review also
`surface`, `on_surface` and `surface_hover`, a company's own colour on its surfaces (**B12-21**, which
also narrows what `strong` is used for). Guaranteed for every input,
measured with the WCAG 2.x formula on the 8-bit colours returned: white on `strong` and on `strong_hover`
≥ 4.5; white on `deep` ≥ 10; `on_bright` on `bright` ≥ 4.5 and `bright` on `deep` ≥ 4.5; `strong` on `tint`
≥ 4.5, and the product's own text colours read on `tint` (its luminance is at least 0.80).
`tests/unit/test_palette.py` holds this over a grid of the whole RGB cube (18³ colours), every grey, named
awkward colours (black, white, yellow, neon green, near-white, near-black) and random ones;
`tests/unit/test_email_identity.py` holds every text and background pair of the e-mail templates over a
16³ grid.

Colours are moved in OKLCH (lightness changes while the hue a person sees stays; a yellow darkened in HSL
turns green). A colour with almost no chroma is a grey and stays grey in every role. The arithmetic is plain
floating point on 8-bit inputs with 8-bit results, so the same colour gives the same palette everywhere;
`ALGORITHM` (`"oklch-1"` then, `"oklch-2"` since B12-21) is part of every brand's `version`, so a change of
the derivation reaches every cached copy.

**B12-5 — Where the derivation departs from the simplest reading.**

- A colour that already carries white text (≥ 4.5:1) **is** `strong`, exactly as chosen. One that has to be
  darkened is darkened to **5:1**, not 4.5:1: at exactly 4.5:1 the only surface it reads on is white, which
  leaves no visible tint.
- `strong_hover` is darker than `strong`, except for a `strong` too dark to darken visibly (black, a very
  dark navy): there it is lighter. It is never `strong` itself, and white reads on it. (Since B12-21 the
  step is guaranteed to be one that can be seen: at least 0.06 of OKLCH lightness.)
- `bright` is the colour itself when it is light and vivid (a yellow, a neon green): the brand's own colour
  then shows on dark surfaces and under dark text instead of a derived neighbour.
- The colour is `#rrggbb` in lower case and nothing else: no upper case, no `#rgb`, no names, no alpha.
  Nothing is trimmed or folded; anything else is `invalid_color`.

## The platform owner

**B12-6 — An image is uploaded as the request's body.** `PUT /platform/companies/{id}/brand/assets/{kind}`
with `Content-Type: image/png` and the file as the body: no multipart parser (the API has none, and gains no
dependency), and the size is known from `Content-Length`. Anything but `image/png` (parameters and letter
case ignored) answers **415 `UNSUPPORTED_MEDIA_TYPE`**, a new error code; the header only opens the door,
the bytes are judged by B12-2. This one route has a body limit of its own, 512 KiB
(`BodySizeLimitMiddleware(route_limits=…)`, decided on the method and the route path): every other request
keeps `MAX_REQUEST_BODY_BYTES`. In order: a declared length above the limit (413, before anything else);
the CSRF check and authentication (403, 401: no byte of the body is read for anyone else); the media type
(415); the body itself (413 for one that declared no length and is too long; 408 for one that is not
complete after 30 seconds, B12-18); the budget (429); the company (404); and only then the file. A
refused file is one field error on `file`: `required` (an empty body), `invalid_image` (everything B12-2
refuses; the message names interlacing and animation, nothing else), `image_too_small` (`min_width`,
`min_height`), `image_too_large` (`max_width`, `max_height`), `image_not_square`.

**B12-7 — Only the platform owner changes a brand.** `GET` and `PATCH /platform/companies/{id}/brand`,
`PUT` and `DELETE …/brand/assets/{kind}`, `POST /platform/brand/palette`, all in the platform realm
(platform session, platform CSRF token). No endpoint of a company's own users takes a logo, an icon or a
colour: `PATCH /company/settings` refuses the fields like any unknown one (`not_allowed`).

- Every change answers the whole `CompanyBrand`. The same image or colour again changes nothing and audits
  nothing; removing what is not there likewise. A new image gets a new random `version`, hence a new address.
- Audited as `COMPANY_BRAND_UPDATED` in **both** trails (B11-5): `metadata.changed_fields` names the part
  (`logo`, `logo_dark`, `icon` or `color`), `metadata.removed_fields` the same part when it was removed;
  never the image, its size or the colour's value. The company's row has no actor, `source: "platform"`,
  `platform_admin_id`, and neither the platform owner's address nor browser (B11-37).
- Each attempt, refused or not, counts in `brand_changes_per_user` (`RATE_LIMIT_BRAND_CHANGES_PER_HOUR`,
  120 an hour per platform account): an upload is inflated and checked whatever its fate. Reading and the
  palette preview do not count.
- The file is checked before any lock is taken; then the company row is locked `FOR UPDATE` (two changes of
  one brand never interleave) and the caller is checked again (B11-38), so a session that ended meanwhile
  changes nothing.
- A deactivated company keeps its brand and the platform owner can still change it; the public endpoints
  do not answer for it (B12-9).

**B12-8 — A company's e-mail texts, for the platform owner.** The seven endpoints of
`/api/v1/email-templates` again under `/api/v1/platform/companies/{id}/email-templates`, on **the same
service** (`EmailTemplatesService` takes an editor: `AdministratorEditor` or `PlatformOwnerEditor`), so the
texts, checks, field codes, limits and answers cannot drift apart. What differs is who the editor is:

- the texts are the company's (its administrators read and change them again); `updated_by_id` is NULL
  when the platform owner saved one, and the audit rows say who did;
- audited in both trails (`EMAIL_TEMPLATE_UPDATED`, `EMAIL_TEMPLATE_RESET`, `EMAIL_TEMPLATE_TEST_SENT`), the
  company's row without address or browser;
- a **test e-mail goes to the platform owner's own address**, never to anyone of the company, within the
  same budget of five an hour, counted per platform account (`template_test_sends_per_user`, key
  `platform:<id>`), apart from every administrator's;
- the preview's sample host is a sample name («عمر خليل» / "Omar Khalil"), not a person of the company and
  not the platform owner;
- an unknown company is 404; a body that fails a text rule is 422 first, as every body check is.

## The public pages

**B12-9 — Three endpoints without a session.** `GET /public/companies/{slug}/brand`,
`…/brand/{kind}.png` and `…/manifest.webmanifest` answer what a sign-in page and a visitor's pass page may
know before anyone signs in: how an **active** company is named, its language and its brand.

- **Nothing else leaks.** The identity is `{slug, name, name_ar, default_language, brand}`: no ID, time
  zone, address, state or count.
- **One 404.** A slug nobody has, a deactivated company, a string no slug could be, a company without that
  image and an image name that does not exist all answer the same `404 NOT_FOUND`, in one database
  statement for the first two (no timing difference worth the name). Slugs are compared as they are: never
  folded, never used as anything but a value.
- **No session.** No dependency reads a cookie, no answer sets one; a signed-in person, the platform owner
  and a stranger get the same bytes, and no session is kept alive by them.
- **Counted.** Every request takes a slot per client address (`RATE_LIMIT_PUBLIC_BRAND_PER_IP`, 600 a
  minute) and per IPv6 /48 (`RATE_LIMIT_PUBLIC_BRAND_PER_PREFIX`, 6,000) before anything is looked up,
  whatever it asks for and whatever the answer. Whether a slug names an active company is public by design
  (the sign-in link shows it); the budget bounds how fast anyone can go through names. Production refuses
  more than ten times the defaults. The rejected request is audited like every `RATE_LIMITED` (the route
  template, never the slug).
- **Cacheable, by the API's own word.** These are the only answers that are not `no-store`. The middleware
  writes `no-store` over whatever a route set, except under `/api/v1/public/` and there only for a 200 or
  a 304: an error is never kept, whatever set its headers, and no other route can mark an answer
  cacheable by mistake (`tests/unit/test_cache_policy.py`). An image under
  the address of its **current** version: `public, max-age=31536000, immutable`. Under any other address
  (no `v`, an older one, a made-up one): the current image for `public, max-age=60`, so nobody can pin
  other bytes in a cache by asking for an address before it exists, and an old link heals within a minute.
  The identity and the manifest change in place: `no-cache` (kept, checked every time).
- **ETag and 304.** Every success has a strong entity tag (the quoted SHA-256 of its bytes).
  `If-None-Match` naming it (a list, `W/` prefixes and `*` as RFC 9110 says) answers `304 Not Modified`
  with the tag and the caching rule and no body. A 404 is never a 304.
- **No `Vary`.** No answer depends on a request header (not the cookie, not the language), so there is
  nothing to vary on and no way to poison one viewer's copy with another's.
- **Images are images.** `Content-Type: image/png` exactly; `X-Content-Type-Options: nosniff`;
  `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none';
  form-action 'none'`; `X-Frame-Options: DENY`; `Cross-Origin-Resource-Policy: same-origin`. The bytes are
  the ones the server wrote (B12-2).
- `v` is the only query parameter (at most 64 characters); another one is 422, like everywhere.

**B12-10 — A company's web app manifest.** `application/manifest+json`: `id` and `start_url` `/c/{slug}`,
`scope` `/`, `name` and `short_name` the company's name in its default language (since the UX review
`short_name` is a short form of at most 12 characters, B12-25), `lang` and `dir` of that
language, `display: standalone`, `theme_color` = `palette.strong` (since the UX review `palette.surface`,
B12-21) and `background_color` = `palette.tint`
(or the product's defaults `#188086` and `#f1f1f1` without a colour), and one icon: the company's own, with
its real size. **A company without an icon lists none** (`icons: []`): the product's icon is the Mawdoo3
mark, which a tenant must not show, and the web application's neutral icons are not the backend's to name.
Nothing in the manifest names the product.

**B12-11 — The brand in what clients already read.** `Me.company` gains `slug` and `brand`
(`CompanyBrand`), so the application shows the company's identity from the first answer after sign-in and
can build the company's own links. `PlatformCompany` gains `brand` (the list and the detail). `CompanyBrand`
is `{logo_url, logo_dark_url, icon_url, color, palette, version}`: the three addresses are same-origin paths
of the public image endpoint **with the image's version** (use them as they are), null without that image;
`palette` is null exactly when `color` is; `version` changes whenever an image, the colour or the
derivation changes (16 hexadecimal digits). An image's own `v` is random per upload and is **not**
`brand.version`.

## E-mail

**B12-12 — Whose e-mail a message is.** Two identities (`app.email.identity`). *Changed by the UX
review: the notice of a platform action is a company's e-mail now, and only the CLI's test e-mail is the
product's (**B12-22**); the bar and the primary button are the palette's `surface` (**B12-21**).*

- **A company's**: every visit e-mail, its users' password-reset and password-changed e-mails, and the
  previews and test e-mails of its texts. The header is white under a bar in the company's colour, with
  **its logo** inline (`cid:brand-logo`, shown inside a 168 × 44 box with its proportions kept, its text
  alternative the company's name) **or its name as a word mark** when it has no logo (20 px, 16 px for a
  name longer than 28 characters). The colours come from the palette of its colour (bar and primary button
  `strong`; the pass card `deep` with `bright` accents; the pass button `bright` with dark text; notices and
  the pill on `tint`), or the product's teal while it has none. The footer says "Sent by {company}." /
  «أُرسلت من {company}.». **No sentence, header, text alternative, image or colour names the product or
  shows the Mawdoo3 mark.** The plain-text part starts with the company's name.
- **The product's**: the notice of a platform action to a company's administrators (`PLATFORM_ACTION_NOTICE`)
  and the CLI's `send-test-email`. They keep the teal band, the Mawdoo3 logo and "Sent by Mawdoo3 Visitors
  on behalf of …". *(As first built. Since B12-22 the notice is the company's, and "on behalf of" is said
  nowhere.)*

The logo is used as it was stored (the server draws nothing), on white, which is what a logo "for light
surfaces" is for. A company with a logo sends it in every message (at most 512 KiB; the upload page prepares
far smaller files).

**B12-13 — The sender is the company, the address is the deployment's.** The display name of `From` is the
company's name (visitor e-mails in the company's leading language, staff e-mails in the recipient's); the
address stays the configured `EMAIL_FROM` address, always. The name is made safe before it becomes a
header (`app.email.headers.display_name`): line breaks and control characters out, direction controls out,
`<`, `>`, `"`, `@` and `\` replaced (a name cannot close the quoted string, carry an address of its own or
look like one; since B12-20 in their fullwidth and small forms too), `=?` broken (no RFC 2047 encoded
word), white space collapsed, at most 100 characters. The
providers encode non-ASCII names as before (the SMTP provider through `email.headerregistry.Address`, the
Resend provider as JSON).

**B12-14 — Links name the company; tokens stay in the fragment.**

| Link | Format |
|---|---|
| Visitor pass (the e-mail's button and address, the QR code, `pass_url` in API answers) | `{QR_BASE_URL}/pass?c={slug}#{token}` |
| Password reset | `{APP_BASE_URL}/reset-password?c={slug}#token={token}` |
| "Request a new link" in the password-changed e-mail | `{APP_BASE_URL}/forgot-password?c={slug}` |
| A company's sign-in page (the manifest's `start_url`) | `/c/{slug}` |

The slug is percent-encoded as a query value (a slug is letters, digits and hyphens; nothing else a row
might hold can add a parameter, a fragment or a path). The token is in the fragment and nowhere else, so
the pass page **sends the server only the company's slug, never the token**. Every parser of pass links
accepts both forms, with `?c=…` and, as every link sent before, without a query: the path must be exactly
`/pass` (or `/pass/`), the query is never read, and the token is the whole fragment
(`docs/contract/pass-token-vectors.json` gained 14 cases, 63 in all, shared with the frontend's parser).

## Seeds

**B12-15 — The demo company carries the Mawdoo3 identity as a tenant's own.** `seed-demo` and `seed-e2e`
give `demo-company` the logo (`frontend/public/brand/logo-teal.png`, 462 × 149), the dark-surface logo
(`logo-white.png`, 462 × 149), the icon (`icons/icon-512.png`, 512 × 512) and the colour `#188086`;
`other-corp` (seed-e2e) gets none, so each kind of company exists. The three files pass the check of B12-2
**unchanged** (8-bit RGBA, `IHDR`, one `IDAT`, `IEND`), so no conforming copies had to be produced:
`scripts/demo_brand.py` writes them into `backend/app/seed_assets/` (package data) through the very check an
upload goes through, and `--check` fails when one is stale. A seed stores them as an upload would, audits
`COMPANY_BRAND_UPDATED` with `source: "seed"`, and is idempotent (the same versions, hence the same
addresses, on a re-run). **A seed never overrides a person** (B10-15): it brands the company only while it
still carries the seed's names, and never once the platform owner set or removed any part of its brand.

## Deployment

**B12-16 — Every new request goes to the main process; nginx lets one larger body through.**

- None of the 15 routes is in nginx's routing map: the platform owner's count the per-account budgets
  (B12-7, B12-8) and the public ones the per-address budgets (B12-9), which live in the main process's
  memory. `deploy/verify/test_api_instances.py` lists every one of them and fails when a route under
  `/platform/`, `/email-templates` or `/public/` is added without a decision.
- **nginx sets no caching rule and keeps no copy** of the public answers: the API alone says how long one
  may be kept, and nginx passes that through (tested: no `add_header`, `expires` or `proxy_cache` on the way
  to the API).
- nginx refuses bodies above 64 KiB before the API does, so the upload needed a rule: a location nested in
  `/api/` for exactly the upload's paths, with `client_max_body_size 512k` (the API's limit) and a bound on
  the uploads in progress. `client_max_body_size` moved from the shared snippet into the locations, because
  nginx refuses a directive given twice. nginx matches locations on the normalised path and cannot tell the
  method, so it is only the outer bound: the API decides on the path it receives and on the method.
  **How the uploads in progress are bounded was changed after the security review (B12-18):** as first
  built (`client_body_buffer_size 512k`, `limit_conn vms_brand_upload 8`, the body read by nginx before
  the API saw the request), strangers could hold all eight places.
- Verified with nginx 1.30.5 for Windows (see Verification): `nginx -t` on the canonical rendering, the
  limits and the routing against stand-in upstreams, and the whole flow and the smoke test against three
  API processes.

**B12-17 — Settings.** `RATE_LIMIT_PUBLIC_BRAND_PER_IP` (600) and `RATE_LIMIT_PUBLIC_BRAND_PER_PREFIX`
(6,000) are among the budgets production holds to ten times their default (SEC-46): they are all that
bounds going through company names. `RATE_LIMIT_BRAND_CHANGES_PER_HOUR` (120) is bounded by the field
itself (1–10,000). The image limits are not settings: they are the contract's, and the database repeats
them.

---

## Deviations and decisions for the frontend

1. **`strong` may differ from `color`**: it is the colour itself only when white already reads on it;
   otherwise darker, to 5:1 (B12-5). Always draw with the palette's roles, never with `color`. **Since
   the UX review, paint surfaces with `surface` / `on_surface` / `surface_hover`** and keep `strong` for
   text, links and icons on white (B12-21).
2. **Use the image addresses as given** (`logo_url`, …): they carry the image's own `v`, which is not
   `brand.version`. `brand.version` is for the client's own caches of the whole brand.
3. **A manifest without icons** when the company has no icon (B12-10).
4. **Upload**: `PUT`, the PNG as the body, `Content-Type: image/png`; errors on the field `file` (B12-6).
   415 for another media type, 413 above 512 KiB (from nginx or the API, same envelope), 503 `SERVICE_BUSY`
   from nginx when eight uploads are already in progress on the site or four from the caller's address
   (B12-18), and from the API when no check could start within 2 s (B12-19). Since B12-18 also 408
   `BAD_REQUEST` for a body that is not complete after 30 seconds. Removing an image is never refused
   for uploads in progress.
5. **Interlaced and animated PNGs are refused** (`invalid_image`), with a message that says which.
6. **A colour is lower case** `#rrggbb`; `PATCH …/brand` needs the key `color` (`null` clears it).
7. **The public image endpoint answers 422 for an unknown query parameter**; only `v` is known.
8. **Audit vocabulary**: action `COMPANY_BRAND_UPDATED`; metadata key `removed_fields`; values `logo`,
   `logo_dark`, `icon`, `color` in `changed_fields` and `removed_fields`.
9. **The password-changed e-mail** links to `/forgot-password?c={slug}`.
10. **The platform notice keeps the product's identity** (it is the platform's e-mail). *No longer:
    since B12-22 it is the company's own e-mail, with the company's logo file when it has one.*
11. **An outbox message of a company without a logo has no `brand-logo` image file** (Other Corp in the
    E2E seed); the demo company's has the seed logo.
12. **Preview documents** carry the company's logo as inline data beside the sample QR code: two images
    for a company with a logo, one without.
13. **A 422 comes before a 404** on the platform's e-mail-text writes when the body breaks a text rule.

## Verification (2026-10-13)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 304 files already formatted |
| `mypy` (`backend/`) | no issues in 159 source files |
| `pytest` (`backend/`) | 4,100 passed, 3 skipped (the opt-in volume checks), 547.68 s |
| `pytest --committed-first` (`backend/`) | 4,100 passed, 3 skipped, 647.37 s |
| contract snapshot (`tests/unit/test_contract_snapshot.py`, snapshot regenerated) | 6 passed; the committed snapshot is byte for byte what the generator writes |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 42 tests OK, none skipped |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,066 files, no development artefact or credential |
| `scripts/demo_brand.py --check` | the three packaged images are current |

New tests of this phase: `tests/unit/test_png.py` (152), `test_palette.py` (89), `test_brand.py` (90),
`test_email_identity.py` (39), `test_pass_links.py` (24), `test_cache_policy.py` (12), `test_body_limit.py`
(25 added, 30 in all);
`tests/integration/test_platform_brand.py` (97), `test_public_brand.py` (23),
`test_platform_email_texts.py` (22), `test_brand_database_rules.py` (56), `test_seed_brand.py` (11);
`deploy/verify` 42 (7 added: the upload's location and limits, no caching by nginx, a neutral page shell).
The rest of the suite's growth (3,426 tests before this phase) is in existing files: the shared pass-link
vectors, the settings' ceilings, the e-mail tests that now hold a company's identity.

**Safeguards taken out again.** In a private copy of the backend, 75 single changes each removed one
safeguard of this phase: 27 of the PNG check (bytes after `IEND`, a wrong CRC, the bound on inflation, the
exact length, interlacing, animation, unknown critical chunks, each limit, the filter types, the chunk
order, the reserved bit, the palette rules, the merged `IDAT`), 7 of the palette and the colour's spelling,
8 of the brand's helpers (entity tags, the brand's version, the encoded slug, the manifest), 2 of the
sender's name, 4 of the middleware (who may set a caching rule, errors never kept, the body limit of one
method and one path), 1 of the links, and 26 that only the API, the database or the seeds show (an image
kept for a year under any address, the two budgets, the re-check of the session, each audit row, a
deactivated company's identity and images, the media type, the 304, the image's own policy, the seeds'
three rules, the e-mails' sender and logo, the upload's body limit, the downgrade's guard and its lock, who
is recorded beside a text). A test failed for 72 of them. One passed at first (every platform account's test
e-mails on one budget key) and got an assertion: a second platform account keeps its own budget. The other
three never change an output: the 10:1 bound of `deep`, the luminance floor of `tint` and "hover is never
`strong` itself" are guards behind targets that already meet them (over the whole grid the first try gives
at least 11.7:1, a luminance of 0.87 and a different colour), so they are kept as guards and the tests
hold the guarantees themselves.

**E-mails, looked at.** Every template (invitation, rescheduled, cancelled, host arrival, password reset,
password changed, platform notice, and the test e-mail) rendered for seven identities (a company with a
logo and a colour, one without either, yellow `#ffd400`, black, near-white `#f4f6f8`, a square logo, an
80-character name) in both leading languages, in Chromium at 680 and 375 pixels: 100 e-mails, 200
screenshots, none wider than its window. All read; the yellow company's e-mail is drawn in a dark olive
with yellow accents and a yellow pass button with dark text, the black one in black, the near-white one in
a mid grey. One change came out of looking: a long name as a word mark is set in 16 px so that it and the
pill fit a phone.

**The deployed layout, run.** With nginx 1.30.5 for Windows and the repository's configuration (only
paths, ports, names and upstream addresses substituted, each substitution asserted): `nginx -t` passed on
the canonical rendering (the three upstreams with `resolve`) and on the test rendering; 46 checks against
stand-in upstreams (the upload passes with 524,288 bytes and gets nginx's 413 with one more, declared or
chunked; nine other requests keep 64 KiB; eight uploads in progress and the ninth gets 503 while every
other request is served; the new requests go to the main instance and the routed reads to theirs; the
API's caching headers arrive unchanged); 28 checks of the whole flow against three real API processes on a
throwaway database (sign-in, a 120 KiB logo stored, 413, 415, a polyglot refused, the public answers with
their caching rules and 304s, Me, the tenant's refusals, both audit trails); and
`deploy/verify/smoke_test.py`: 78 passed, 0 failed (6 checks added for the upload's limit and the public
endpoints; run without its optional `--http-url` and `--admin-email` checks). The throwaway database was
dropped afterwards.

Not run here: Playwright (the frontend's gate runs the E2E suite) and the frontend's own tests.

## Open after this phase

1. **A company chooses its sender name.** The display name of `From` is the company's name (B12-13), made
   safe as a header but not as a claim: a company named "Your Bank" sends e-mail that says so, from the
   deployment's address. Companies are created and renamed by the platform owner and their administrators;
   there is no review of names. SPF, DKIM and DMARC of the sending domain are unaffected.
2. **A transparent logo on a mail client's forced dark background** may lose contrast: the logo is sent as
   stored, on a white header that some clients repaint. The product's own logo is baked onto its teal for
   that reason (B10-17); the server cannot do the same without drawing.
3. **The logo travels in every e-mail** of a company that has one, up to 512 KiB a message. The upload page
   prepares small files; the server does not shrink them.
4. **Installability without an icon.** A company without an icon has a manifest without icons (B12-10),
   and browsers that require one will not offer to install its app. An icon is one image (192–512 pixels);
   browsers that ask for several sizes get the one.
5. **Whether a slug names an active company is public** (B12-9), at 600 questions a minute per address.
6. **nginx was verified on Windows**, not in the production image (the same nginx version; the Linux build
   differs in nothing the changed directives touch). `nginx -t` runs at every container start.
7. **A stale copy for up to a minute.** After a logo changes, an address without the current version shows
   the old image for up to 60 seconds wherever it was cached; the application uses the new address at once.

---

## After the security review (2026-10-13)

A security review of this phase demonstrated three problems. Each entry says what was shown, what was
wrong underneath, what changed and what holds it now. **The contract did not change**: no migration, no
endpoint, no model, no setting, no error code and no field code (39 error codes and 72 field codes as
before; the snapshot is byte for byte the committed one). What a client can newly meet: `408` on the
upload (with the existing code `BAD_REQUEST`), and nginx's 503 on the upload for four uploads in progress
from one address as well as for eight on the site.

**B12-18 — No request keeps a place among the uploads in progress without being signed in.**

*Shown.* Eight anonymous connections, each `PUT …/brand/assets/…` with `Content-Length: 500000` and then
one byte every five seconds, held all eight places of `limit_conn vms_brand_upload 8`. The signed-in
platform owner got `503 SERVICE_BUSY` for every upload and for every removal of an image, for 90 seconds
and for as long as the connections stayed.

*Underneath.* Three things together. nginx took a place before the API had said who was asking, and kept
it while it read the body, because it read every body before it passed a request on
(`proxy_request_buffering on`). `client_body_timeout 15s` is the longest pause between two reads, not a
time for a body: a byte every five seconds never runs into it. And the location matches the path whatever
the method, so removing an image was counted as an upload.

*Changed in nginx* (the upload's location in `deploy/nginx/templates/vms.conf.template`):

1. **`proxy_request_buffering off`**, in this location only. The request goes to the API as soon as its
   header is read and the body follows as it arrives. The API answers 401, 403 or 415 without reading a
   byte of the body (B12-6; `tests/unit/test_png_upload.py` holds it for a body that never arrives), so
   a request that is not the platform owner's is over in milliseconds. The directive left the shared
   snippet, because nginx refuses a directive given twice in one location: every other API location now
   says `on` itself, and a slow client still never ties up an API worker there.
2. **`lingering_close off`**, in this location only. This is what reproducing the attack added to the
   plan. With request buffering off alone, the API's 401 came at once, but nginx's default kept each
   request for up to 30 seconds more (it waits for the rest of a body it did not read, as long as the
   client keeps sending), and a request keeps its place until it is closed. Connections that sent a byte
   a second and were opened again when they ended still held all eight places: the owner got 503 at +2,
   +30 and +60 seconds, and each connection had its place for 30 to 31 seconds. With lingering off the
   connection is closed with the answer.
3. **Only `PUT` is counted.** The counts' keys come from two `map` blocks on `$request_method` that are
   empty for every other method, and nginx counts nothing under an empty key. Removing an image is never
   refused because uploads are in progress.
4. **A count per client address beside the site's**: `limit_conn vms_brand_upload_client 4` beside
   `limit_conn vms_brand_upload 8`. No single address has more than half the places; four are room for
   the page that saves a company's images one after the other and for colleagues behind the same address.
5. **nginx holds no body.** `client_body_buffer_size 512k` is gone: at most the ordinary 64 KiB of an
   upload are on their way, and nothing is written under `/tmp` (checked in the error log and the
   temporary path after every run).

*Changed in the API.* With the body passed on while it arrives, the API meets what nginx used to absorb.

- **A time for the whole body**: 30 seconds from the moment the request reaches `read_png_upload`
  (`PNG_UPLOAD_SECONDS`; 512 KiB in 30 seconds is 17 KiB a second), then **408**. The envelope's code is
  `BAD_REQUEST`, the code of every 4xx outside the contract's list (`RequestTimeout`), so the vocabulary
  of codes did not grow; the message is "The upload did not arrive in time. Please try again.". Measured
  through nginx: a signed-in upload that sent one byte a second was answered 408 after 30 seconds, and
  its place was free at once.
- **A sender that goes away** in the middle of a body is an ordinary 400 in the access log (as FastAPI
  answers a JSON body that ends early), not an unhandled error with a traceback. nginx itself causes
  this now: when a body without a declared length grows past 512 KiB, nginx answers 413 and drops its
  connection to the API.
- **The size** was already the API's own: a declared length above the limit is refused before anything
  else, and a body without one is counted while it is read. nginx now passes such a body on as it comes
  (chunked, without a length), so that count is what holds for it; both were run through nginx at 524,288
  and 524,289 bytes.

*Before and after*, with nginx 1.30.5 for Windows and the repository's configuration (TLS) in front of
three API processes on a throwaway database:

| | Before | After |
|---|---|---|
| The review's attack: 8 connections, 1 byte every 5 s, HTTP/1.1. The owner's upload at +2, +30, +60, +90 s | 503, 503, 503, 503 | 200, 200, 200, 200 |
| … the removal of an image at the same times | 503 each time | 200 each time |
| … the eight connections | open after 92 s, 19 bytes sent each, never answered | all ended by the server: five answered 401 by the API, three 503 by nginx, being more than four at once from one address |
| The same over HTTP/2: 8 streams, 1 byte a second, 25 s | all 8 open after 25 s; the owner's four uploads and four removals 503 | all 8 ended within 0.1 s (four 401; four 503, being more than four at once from one address); the owner's four uploads and four removals 200 |
| A stranger who does not give up: 8 connections from two other addresses, 1 byte a second, opened again when ended, 60 s | (not run) | 484 connections, all answered 401; the owner's uploads and removals 200 at +2, +30, +60 s |
| A flood: 32 connections from four addresses, each opened again as soon as it was answered, 30 s | (not run) | 2,402 requests (79 a second): 2,397 answered 401, 5 answered 503 (more than four at once from one address); the owner's 27 uploads and 27 removals all 200, the slowest pair in 0.18 s |
| How long nginx had a request nobody was signed in for | 92 s (until the client left) | 2 to 42 ms, median 6 ms (493 requests) |

*What remains.*

- Someone signed in to the platform can keep a place for as long as their body arrives: 30 seconds at
  the most per request, and four places from one address.
- A flood takes places for the milliseconds each request needs. To fill eight places that way takes a
  load that the one main API process, which answers every one of those requests, would feel everywhere.
- The count per address tells IPv6 addresses apart in full; a client with a routed prefix has many. The
  site's count bounds them together.
- **Over HTTP/1.1, a client refused before its body was read may see the connection reset instead of
  the answer**, because nginx closes while the client is still sending (in the two HTTP/1.1 attack
  runs above, 3 of the 489 connections that the API answered 401 read a reset instead). An upload is
  refused that early only when nobody is signed in, the CSRF token is missing or the body is not sent as
  a PNG. Browsers speak HTTP/2 to this nginx, where only the stream ends. A load balancer that speaks
  HTTP/1.1 to nginx may turn such a reset into a 502 of its own (`deploy/README.md` §4).
- nginx's own 503 for an upload beyond the counts is answered from another location, where nginx's
  default lingering stays: such a request has no place to keep (shown with refused uploads left open).

*Held by.* `deploy/verify/test_api_instances.py` (46 tests, 5 of them new: the upload's body is passed on
and no other body is; the API has a time for the body; only an upload takes a place and no address takes
them all; a request gives its place back with its answer; the location is these directives and nothing
else); `deploy/verify/smoke_test.py` (79 checks: an upload nobody is signed in for is answered before any
of its body is sent, and eight of them in a row, every connection left open, keep no place);
`tests/unit/test_png_upload.py` (10). The smoke test fails on the configuration as first built (no
answer while the body is awaited) and on request buffering off alone (the fifth to eighth get 503).

**B12-19 — A refused upload keeps nothing, checks are bounded, and what a check really costs.**

*Shown.* 40 refused uploads at once (500 KiB files whose image data would inflate to 500 MiB behind the
largest logo's header) took the API process from 127 to 415 MiB, and it stayed there until a later
garbage collection.

*Underneath.* A refusal is an exception. `PlatformBrandService.put_image` raised it inside the handler of
the check's own error (`raise ValidationFailed(...) from None`), and `from None` hides a context, it does
not drop it: the answer carried the `PngError`, its traceback, and the frames of `sanitize_png` and
`_inflate` with every local in them, among them the inflated image. An answer does not go away with its
request either: a request leaves reference cycles behind (an exception, its traceback, frames that refer
back to it) which only the cyclic collector frees, whenever it next runs. Until then every refused upload
of the largest size kept 5.5 MiB.

*Changed.*

- `app.core.png`: `_inflate` lets go of the inflated bytes (and of the inflater, which holds what the
  stream had left) before it raises; `sanitize_png` lets go of them as soon as the filter types are read,
  before the file is written and before a refusal for an unknown filter type.
- `app.services.brand.checked_image`: the API's answer is made inside the handler of the `PngError` and
  raised after it. It has no context, no cause and passed through no frame of the check.
  `read_png_upload` raises its 408 and 400 the same way.
- **At most two files are checked at a time** in one API process (`IMAGE_CHECK_CONCURRENCY`; requests run
  in a pool of threads, which would otherwise inflate as many files at once as it has threads). A check
  takes about 5 ms, so nobody waits; an upload that has no place after 2 seconds answers
  `503 SERVICE_BUSY`, like a sign-in that finds no place for its password hash.

*The cost of a check, measured* (`tracemalloc`; B12-2 gave the inflated size, half of it):

| File | Peak while it is checked | Kept afterwards |
|---|---|---|
| The largest logo, 1200 × 600 at 16 bits a channel (inflates to 5,760,600 bytes, 5.49 MiB), a 7 KiB file | 11.04 MiB | 0.01 MiB (the file that is stored) |
| The same image as a 300 KiB file | 11.32 MiB | 0.29 MiB |
| The largest logo at 8 bits a channel | 5.54 MiB | |
| The largest icon, 512 × 512 at 16 bits a channel | 4.05 MiB | |
| A logo of the demo's shape, 462 × 149 at 8 bits | 0.57 MiB | |
| 64 MiB of zeros behind the largest logo's header (a 71 KiB file), refused | 11.16 MiB | 0 |
| The review's file: 500 MiB of zeros behind that header, 500 KiB, refused | 12.00 MiB | 0 |

Twice what the image inflates to, because zlib inflates into pieces that then become one object, plus
copies of the file. So: **11 MiB for the largest logo, 12 MiB with a file at the 512 KiB limit, 4 MiB for
the largest icon**; with two checks at a time, 24 MiB at the very most in one process.

*Before and after.* Eight refused uploads of the largest size through the API, the garbage collector off:
45 MiB still alive before (5.7 MiB each), 0.8 MiB after.

*What remains.* A refused upload's own file (at most 512 KiB) and the request's small objects stay until
the collector next runs, as with every refused request: the answer's traceback passes through the frames
that hold the request's body. Only the platform owner can send such a request, 120 times an hour.

*Held by.* `tests/unit/test_png.py` (160, 8 new: a refusal's traceback holds no bytes longer than the
file, for five ways image data can be wrong; the peak and what is kept, for a valid image and two
refusals); `tests/unit/test_brand.py` (99, 9 new: a refusal has no context, no cause and no frame of the
check; refusals give their place back; two checks at a time; 503 after the wait);
`tests/integration/test_platform_brand.py::test_refused_uploads_leave_no_inflated_image_behind` (live
memory after eight refused uploads through the API with the collector off: less than one inflated image).

**B12-20 — The sender's name in every compatibility form of five characters; a company's name stays free
text.**

*Shown.* A company's administrator renamed the company to `support＠paypal.com`, with U+FF20 FULLWIDTH
COMMERCIAL AT, and the `From` of its invitations read `"support＠paypal.com" <no-reply@…>`. U+FE6B SMALL
COMMERCIAL AT passed too.

*Underneath.* `display_name` (B12-13) replaced the five characters `<`, `>`, `"`, `@` and `\` as typed.
Unicode has other characters that are the same ones for compatibility: a reader takes them for the
character itself, and software that normalises text turns them into it.

*Changed.* Each character of the name is judged by its compatibility (NFKC) form: one whose form
contains one of the five is replaced by a space, as the five are. Today those are nine characters, the
small and fullwidth variants: U+FE64 and U+FF1C of `<`, U+FE65 and U+FF1E of `>`, U+FF02 of `"`, U+FE6B
and U+FF20 of `@`, U+FE68 and U+FF3C of `\`. The company of the review now sends as
`"support paypal.com" <no-reply@…>`. Judging one character at a time misses nothing that normalising the
whole name would find (normalisation decomposes each character on its own, and composing never produces
one of the five); a test goes through every code point.

**The name itself is not normalised.** Every other character stays as it was typed: a fullwidth letter,
a ligature or a half-width kana in a company's name is not an attack, and the sender's name should be
the name the e-mail shows.

**Decided: a company's name stays free text, with no new field code.** Refusing `@` (and its forms) in
the schema was considered and left out:

- The header is the one place where a name can be mistaken for an address, and there it is judged for
  every company, whenever and by whichever path its name was set. A schema rule would only see new names.
- Real names contain `@`. A rule on new values would also have to let stored ones through, or a company
  whose name has one could not save its settings (the page sends the name with every change).
- It would not prevent the thing that matters more: a company can be named after someone else.
- A field code is a contract change the web application would have to mirror; nothing here needs one.

*What is and is not prevented*, exactly ([`docs/security.md` §10.4](../security.md)): the sender's name
cannot close its quotes, carry a second mailbox or read as an address, in any compatibility form, and the
address is always the deployment's. **Not prevented:** a name that misleads by what it says ("Bank
Support", another organisation's name: open item 1 above stands); a character that merely resembles `@`
without being a compatibility form of it; and `@` in the name where it is only text (the application,
the e-mail's subject and body).

*Held by.* `tests/unit/test_email_identity.py` (62, 23 new: the review's two names and the other forms;
every code point, as typed and normalised; the nine forms by name; other compatibility characters stay
as typed; applying the rule twice changes nothing; a company named like an address, through the e-mail
service) and `tests/integration/test_platform_brand.py` (4 new: a company's administrator renames the
company through the API and invites someone; the name is stored as typed and the sender's name is not an
address).

### Verification of this round (2026-10-13)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 306 files already formatted (2 new: `tests/memory_support.py`, `tests/unit/test_png_upload.py`) |
| `mypy` (`backend/`) | no issues in 159 source files |
| `pytest` (`backend/`) | 4,155 passed, 3 skipped (the opt-in volume checks), 519.01 s |
| `pytest --committed-first` (`backend/`) | 4,155 passed, 3 skipped, 927.39 s (beside the frontend's E2E run) |
| contract snapshot (`tests/unit/test_contract_snapshot.py`) | 6 passed; **not regenerated**: what the generator writes is byte for byte the committed file |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK, none skipped |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,068 files, no development artefact or credential |
| `scripts/demo_brand.py --check`, `node deploy/verify/check_nginx_headers.mjs` | the three packaged images are current; 7 headers in sync |

The suite grew by 55 tests (4,100 before): `tests/unit/test_png.py` 8 (160), `test_brand.py` 9 (99),
`test_png_upload.py` 10 (new), `test_email_identity.py` 23 (62) and
`tests/integration/test_platform_brand.py` 5 (102). `deploy/verify` has 46 tests (42 before: 5 added, 1
replaced by them).

**One test fails on a busy machine, and not because of this round.** Two runs of `pytest` in the default
order, made while the frontend's E2E suite kept all twelve processors at 100 %, had 4,154 passed and 1
failed: `tests/integration/test_access_log.py::test_the_response_time_excludes_background_work`, which
asserts that a response takes less than half a second (it took 0.89 and 0.97 s; the test is the third of
the suite in that order). The tree as the review found it failed the same test under the same load
(1.19 s), and both trees pass it on a quiet machine (this one three times in a row, that one once). The
run in the table was made once the E2E suite had ended.

**Each fails on the code before.** Run against a copy of the tree as the review found it: 5 of the new
tests of `test_png.py` (5,760,600 bytes kept by a refusal's traceback), 3 of `test_png_upload.py` (no
time for the body: the request is never answered; a sender that goes away is an unhandled
`ClientDisconnect`), 10 of `test_email_identity.py` (the review's names and the walk through every code
point, which names U+FE64, U+FE65, U+FE68 and U+FE6B first), 4 of the integration tests (45 MiB kept
after eight refused uploads; three company names); `test_brand.py` cannot be imported there (the function
it tests did not exist); 6 of `deploy/verify` (the 5 new and the one that holds what an API location may
say); and the smoke test, 77 passed and 1 failed.

**Each new safeguard taken out again.** In private copies of the new tree, 26 single changes each removed
one: the two places where the inflated bytes are let go of, the refusal raised inside the handler, the
bound on checks (no bound, three at a time, a wait without end, a refusal that keeps its place), the
body's time, the handling of a sender that goes away, 408 answered as 400, the body read before the media
type is looked at, the compatibility forms (none judged, only those of `@`, the whole name normalised
instead), and eleven of the nginx location (the body read first, lingering left on, every method counted,
`DELETE` counted, a key that is never empty, no count per address, eight places for one address, a
buffer of its own, another location passing its body on, lingering off for the whole server, an hour for
a body). A test failed for all 26.

**The deployed layout, run.** nginx 1.30.5 for Windows with the repository's configuration (only paths,
ports, names and upstream addresses substituted, each substitution asserted; one worker), TLS, HTTP/1.1
and HTTP/2:

- `nginx -t` passed on the canonical rendering (the three upstreams with `resolve`) and on the test
  rendering.
- The review's attack, before and after, and the stronger ones: the table of B12-18.
- 62 checks against stand-in upstreams, 0 failed (46 before): the earlier ones (the sizes on exactly the
  upload's path and 64 KiB everywhere else, the routing, the caching headers) and the new ones (a
  request that the upstream refuses unread is answered while its body is awaited and leaves its place;
  four uploads in progress from one address and the fifth gets 503 while another address, a removal and
  another method are served; eight from two addresses and the ninth, from a third, gets 503; refused
  uploads left open take no place; a chunked upload arrives chunked; no body in a temporary file).
- 28 checks of the whole flow against three API processes on a throwaway database, as in the phase's
  own verification: all passed.
- 19 checks of what someone signed in meets over HTTP/1.1 (524,288 and 524,289 bytes, declared and
  chunked; a body a byte a second answered 408 after 30 seconds and its place free at once; a sender
  that goes away, one access line with 400 and no error in the API's log; four uploads in progress from
  one address, the fifth 503, a removal served, another address served): all passed.
- 14 checks of the platform owner's uploads over HTTP/2, the protocol browsers use: small and large
  files, a file sent in pieces over two seconds, one without a declared length, the limit and one byte
  more, and the refusals that come before the body is read (403, 415, 401), each **read whole while the
  body was still being sent**, with the connection good for the next request: all passed.
- `deploy/verify/smoke_test.py`: 79 passed, 0 failed (78 before; run with `--connect-to 127.0.0.1` and
  without its optional `--http-url` and `--admin-email` checks). The same script against the
  configuration as first built: 77 passed, 1 failed (no answer while the body is awaited); against
  request buffering off alone: its second upload check fails (four 401, then four 503).

The throwaway database was dropped afterwards. Not run: Playwright and the frontend's own suites (the
frontend's gate, running on this machine at the same time), anything in Docker.

### Open after this round

1. **A company chooses its name** (open item 1 of the phase stands, narrowed by B12-20): the sender's
   name cannot read as an address in any compatibility form, but it can say anything, and a character
   that only resembles `@` is a letter. The name is shown as typed in the subject and the text.
2. **HTTP/1.1 and a refusal before the body** (B12-18): the connection may be reset before the client has
   read the 401, 403, 415 or 408. Browsers speak HTTP/2 to nginx. Behind a load balancer that speaks
   HTTP/1.1 to nginx this can surface as the balancer's own 502.
3. **Someone signed in** can keep one of the eight places for 30 seconds per request, four from one
   address. A compromised platform account can do far worse.
4. **A flood** of uploads nobody is signed in for takes places for milliseconds each; enough of it at
   once would refuse the owner's upload now and then. The count per address does not group IPv6
   addresses of one prefix.
5. **408 has no code of its own** (`BAD_REQUEST`). A client that wants its own sentence for it has the
   status; a code of its own would be a contract change.
6. **A refused upload's file** (at most 512 KiB) stays in memory until the garbage collector next runs,
   as every refused request's body does.
7. **nginx was verified on Windows with one worker** (open item 6 of the phase stands). The counts live
   in shared memory zones, which nginx for Windows does not share between workers: two workers were not
   exercised here. `nginx -t` runs at every container start.
8. **The web application's record** (`phase-12-frontend.md`) says that nginx's 503 comes "while eight
   uploads are in progress": it now also comes for four from one address. The page shows the server's
   message either way; nothing in the web application has to change for this round.

---

## After the UX review (2026-10-14)

A UX review of this phase asked for four groups of changes on the backend's side (B12-21 … B12-25); one
more thing was found while they were built (B12-26). Each entry says what was shown, what was wrong
underneath, what changed and what holds it now.

**Contract changes.** `BrandPalette` has three more fields (`surface`, `on_surface`, `surface_hover`), an
addition agreed with the web application's builder, who implements the same names; the snapshot was
regenerated. The derivation is named `oklch-2`, so `brand.version` of every company with a colour changed.
No migration, no endpoint, no setting, no error code and no field code (78 operations on 61 paths, 39 error
codes and 72 field codes as before). Two values of the manifest changed (`short_name`, `theme_color`),
and some e-mail texts: [what a client or a test may have relied on](#what-a-client-or-a-test-may-have-relied-on)
lists every one.

**B12-21 — A company's own colour on its surfaces.**

*Shown.* A light colour never appeared as itself. A yellow company (`#f5b800`) had a shell, buttons and an
e-mail in `#8e6900`, an olive brown; a pastel one (`#f9c6d0`) in `#90636d`; a neon one (`#39ff14`) in
`#138100`. The user had asked for "the colour according to each company's logo".

*Underneath.* `strong` had two jobs: the colour of text and links **on white**, and the colour **surfaces**
are painted with under white text (B12-4). The second job fixed the ink, and a fixed white ink forces every
light colour dark. A surface does not need white text; it needs text that reads.

*Changed.* Three roles more (`app.core.palette`), each guaranteed for every input like the others:

| Role | What it is | How it is derived |
|---|---|---|
| `surface` | what brand surfaces are painted with: the application's shell, primary buttons, the bar and the button of an e-mail | the chosen colour **itself** when white reaches 4.5:1 on it, or else when the dark ink does; otherwise `strong` |
| `on_surface` | the ink of text and icons on `surface` and on `surface_hover` | `#ffffff` where white reaches 4.5:1 on the colour (white is tried first); the dark ink `#1c262b` (the value of `on_bright`) where only that does; `#ffffff` where the surface is `strong`. On `surface` ≥ 4.5 |
| `surface_hover` | the hover and pressed step of `surface` | the same hue at another lightness: `on_surface` on it ≥ 4.5, and at least **0.06 of OKLCH lightness** away from `surface` |

- **Which colours are their own surface.** White reads on a colour whose relative luminance is at most
  0.1833, the dark ink on one of at least 0.2563; the two never both read. Of the 5,832 colours of the test
  grid, 2,102 are their own surface under white, 2,937 under the dark ink, and 793 (14 %, the mid-tones
  between: a mid grey, a pure red) are painted with `strong`, which is what the contract asked for there.
- **The hover step** (`_hover`, one function for `strong_hover` and `surface_hover`). Darker by 0.07 of
  OKLCH lightness wherever `on_surface` still reads on the darker colour: what a pressed surface looks
  like. Lighter where darker cannot be: a colour too dark to darken visibly (OKLCH lightness below 0.25:
  by 0.16, to at least 0.28, as `strong_hover` always did), and a light surface only just light enough for
  the dark ink (by 0.07: an orange `#ff6600` has `#ff9162`). Over the grid 5,017 steps go darker, 78
  lighter from near black and 737 lighter above the dark ink's threshold.
- **The least difference: 0.06 of OKLCH lightness**, `HOVER_MIN_DIFFERENCE`, measured like every guarantee
  on the 8-bit colours returned. It is three times the 0.02 that is commonly taken as just noticeable, and
  it is a measure in which the same step looks the same on a dark and on a light surface (a WCAG contrast
  ratio between two neighbours is not: the same step is 1.14:1 on a very dark violet, 1.23:1 on white
  and 1.35:1 on a mid grey). The step aims at 0.07; rounding to 8 bits leaves 0.066 at the least over
  the grid. The derivation checks it, and moves on in steps of 0.002 where it does not hold.
- **The existing roles did not move.** `strong_hover` is now derived by the same function as
  `surface_hover`, and its guarantee is the stronger one (0.06 of lightness instead of "not `strong`
  itself"). Compared with the derivation before over 36,088 colours (the grid, every grey, 30,000 random
  ones): no value of the eight existing roles differs. Where `surface` is `strong`, `on_surface` is
  `on_strong` and `surface_hover` is `strong_hover`, so nothing changes for a dark company.
- **`ALGORITHM` is `oklch-2`.** The palette a client receives changed, so every brand's `version` did
  (B12-4): a stored copy of a brand is replaced.

| `color` | `surface` | `on_surface` | `surface_hover` | `strong` | `on_surface` on `surface`, on `surface_hover` |
|---|---|---|---|---|---|
| `#f5b800` yellow | `#f5b800` | `#1c262b` | `#daa300` | `#8e6900` | 8.62, 6.77 |
| `#f9c6d0` pastel | `#f9c6d0` | `#1c262b` | `#e2b0ba` | `#90636d` | 10.29, 8.19 |
| `#39ff14` neon | `#39ff14` | `#1c262b` | `#2ce500` | `#138100` | 11.38, 9.05 |
| `#ffffff` white | `#ffffff` | `#1c262b` | `#e8e8e8` | `#6f6f6f` | 15.42, 12.59 |
| `#ff6600` orange | `#ff6600` | `#1c262b` | `#ff9162` | `#bf4a00` | 5.25, 6.96 |
| `#188086` teal | `#188086` | `#ffffff` | `#006a70` | `#188086` | 4.70, 6.37 |
| `#000080` navy | `#000080` | `#ffffff` | `#000055` | `#000080` | 16.01, 18.56 |
| `#e11d48` red | `#e11d48` | `#ffffff` | `#c20038` | `#e11d48` | 4.70, 6.27 |
| `#000000` black | `#000000` | `#ffffff` | `#292929` | `#000000` | 21.00, 14.55 |
| `#808080` mid grey | `#6f6f6f` | `#ffffff` | `#5b5b5b` | `#6f6f6f` | 5.02, 6.79 |
| `#ff0000` pure red | `#e00000` | `#ffffff` | `#bc0000` | `#e00000` | 5.04, 6.69 |

*In the e-mails* (`app.email.identity.EmailColors`, `templates/macros.html`, `base.html`):

- **The bar of the header and the primary button are `surface`, the button's text is `on_surface`.** A
  yellow company's button is yellow with dark text. Without a colour the product's teal stays, with white.
- **Links and small coloured text on white stay `strong`**: the pill, the word mark, the name of the other
  language, an outline button's text. The yellow itself cannot be read there.
- **The edge of every button is `strong`** (decided when the e-mails were looked at). For a dark company
  that is the fill, as before. For a light one it is a 2-pixel line of its own hue around the fill, and it
  is what keeps a white company's button a button on the white card: `strong` reads on white at 4.5:1 for
  every colour. With the fill as its own edge, a white company's primary button was bold text and nothing
  else.
- The pass card (`deep` with `bright` accents, the pass button `bright` under dark text) is as it was; for
  a light vivid colour `bright` is the colour itself already (B12-5), so a yellow company's pass button
  was yellow before.
- **The manifest's `theme_color` is `surface`** (it was `strong`): it is the colour of the installed
  application's title bar, which is the shell's. `background_color` stays `tint`.

*Held by.* `tests/unit/test_palette.py` (114 tests, 25 new): the three guarantees in the
check that walks the grid of 18³ colours, every grey, the named awkward colours (black, white, yellow, the
review's yellow and pastel, neon green, pink and cyan, an orange, the greys on both sides of both
thresholds) and 3,000 random ones; the colours around the dark ink's threshold; which greys are painted
how, in order; the direction of every grey's hover step; the pinned palettes of the review's three
colours. `tests/unit/test_email_identity.py`: the text of every button on its fill and its edge on white
over a grid of the cube; the bar and the button of four light and four dark companies and of one without
a colour. `tests/unit/test_brand.py` and `tests/integration/test_public_brand.py`: the manifest's theme
colour and the palette as the public endpoint answers it.

**B12-22 — Nothing of the product reaches a company's people: the notice of a platform action is the
company's e-mail.** *(Changes B12-12.)*

*Shown.* `PLATFORM_ACTION_NOTICE`, the notice to a company's other administrators when the platform owner
adds an administrator or sends one a reset link, carried the Mawdoo3 logo on the teal band, a text part
that began «زوار موضوع | Mawdoo3 Visitors» and the footer "Sent by Mawdoo3 Visitors on behalf of …".

*Underneath.* B12-12 kept two identities and called this notice "the platform's message about the
company". The user decided otherwise: nothing of Mawdoo3 reaches a company's people.

*Changed.* `EmailService.queue_platform_notice` builds the notice like every other e-mail of the company:
its logo inline or its name as a word mark, its colours (B12-21), the company's name as the sender's
display name (B12-13; the address is the deployment's), the text part headed by the company's name, and
"Sent by {company}." / «أُرسلت من {company}.». **The wording did not change**: it says "the platform
owner", by role (B11-5). The pill is still the yellow "Security notice" / «تنبيه أمني».

- **The product's identity is left on one message**: the test e-mail of `python -m app.cli
  send-test-email`, which goes to whoever runs the deployment.
- "Sent by {product} on behalf of {company}." is said nowhere any more: the catalog's `footer.sent_for`,
  the rule that recognised the brand's own company (`is_brand_company`) and the service's `brand` and
  `product` attributes are removed. `PRODUCT_NAME_*` and `BRAND_NAME_*` name the test e-mail (and the
  OpenAPI title) only.
- A test goes through the catalog: no text but `footer.sent`, `test.subject` and `test.intro` (the test
  e-mail's) takes a product, a brand or a sender, and none contains "Mawdoo3" or «موضوع».

*What follows from it.* The notice no longer looks different from the company's other e-mails. Its reader
tells it by its words, which nobody of the company can edit (B11-21); `docs/security.md` §10.3 says so.

*Held by.* `tests/unit/test_email_identity.py` (both actions, both leading languages, with and without a
logo: the company's bar, logo, sender, masthead and footer; none of the product's colours or words),
`test_email_templates.py` (every e-mail of a company now counts eight; the brand's own company is a
company like any other), `test_email_review.py`, `test_email_i18n.py`, and through the API
`tests/integration/test_platform_companies.py` (the notices of both actions for a company with a logo and
a yellow colour).

**B12-23 — E-mails on a phone, and the Arabic sentence of a window that crosses midnight.**

*Shown.* (1) The password-reset e-mail of a company with a wide logo was 389 pixels wide at 375, 360 and
320: the header held a 160-pixel logo beside the pill «إعادة تعيين كلمة المرور» (155 pixels, on one line).
Logos 168 pixels wide overflowed by 2 to 5 pixels at 320 in other kinds. (2) An invitation whose pass
window crosses midnight was 421 pixels wide at 375: two cells of half the card each held «الأربعاء، 14
تشرين الأول، الساعة 01:57» in 26-pixel figures with no-break spaces. (3) That text read «تنتهي صلاحية
بطاقتك عند الأربعاء، 14 تشرين الأول، الساعة 01:57»: "at Wednesday, …", with a list's commas in a sentence.

*Underneath.* The header was one row of two cells whatever the width, and neither cell could give way: an
image has its width, and the pill was `nowrap`. The code's own note on the logo's box said "a wide logo
and the pill beside it fit a 375-pixel phone"; the longest pill beside the widest logo had not been
measured (335 pixels, where a phone's header has 313). The window's cells were
drawn for two times, and a moment on another day is not a time. And one string served two places: under a
label a moment is a list (`Tue, 6 Oct, 00:30`), in a sentence it is part of the sentence.

*Changed.*

1. **The header stacks on a phone** (`base.html`). Below 480 pixels the two cells become blocks: the kind
   of message goes under the logo or the name, both at the start of the line (right in an Arabic-led
   e-mail). This is the templates' own pattern (a class and one rule in the small style sheet for phones,
   as the details grid has), for every kind. **Without the style sheet** the desktop row stays, and there
   the pill beside a logo may now wrap (`white-space:normal`; its corners are 13 pixels, half of one
   line's height, so it is the same pill on one line and a rounded box on two). Beside a name the pill
   stays on one line: the name wraps.
2. **A window with a date is two rows in smaller type** (`visitor_invitation.html`). When either end of
   the window falls on another day (`VisitTimes.dated`), the two ends stand one under the other, each
   across the card, in 18-pixel type; a window on one day keeps its two 26-pixel figures side by side.
   This needs no style sheet, so it holds in every client. A value may break anywhere before it would
   push the card wider (`word-break:break-word`), which nothing measured needed.
3. **An Arabic sentence says another day's moment as a sentence does** (`app.email.formatting`,
   `VisitTimes.from_phrase` and `until_phrase`): «وتنتهي صلاحية بطاقتك **يوم الأربعاء 14 تشرين الأول
   الساعة 01:57** (بتوقيت عمّان).», the pattern of the catalog's other sentences («يوم {date} الساعة
   {time}»). The same after «ابتداءً من» for a window that starts the evening before, and in the notice of
   a new time. The day and its month, «يوم» and the weekday, and «الساعة» and the time are joined by
   no-break spaces. Under its label on the pass card the moment is still the list the interface writes
   («الأربعاء، 14 تشرين الأول، الساعة 01:57»).
   **Decided: a time on the visit's own day is worded as before** («… وتنتهي صلاحية بطاقتك عند 12:00»),
   so the sentence of nearly every e-mail is unchanged; the Arabic preposition now comes with the value
   (`until_phrase` is «عند 12:00» or «يوم … الساعة …»), as the zone's does («بتوقيت عمّان»). **English is
   unchanged** ("Your pass expires at Wed, 14 Oct, 01:57"): the review named the Arabic.

*Measured* (Chromium, the documents as files; `document.documentElement.scrollWidth` and the left and
right edge of every element): **250 e-mails at 320, 360, 375, 414, 480, 481, 540 and 680 pixels: every one
exactly as wide as its window, none wider.** They are every kind (invitation, new time, cancellation, a
visitor's arrival, password reset, password changed, both notices of a platform action, and the product's
test e-mail) in both leading languages for: eight colours, with and without logos (128 e-mails); a logo
shown 168 pixels wide and 42 high, one 168 by 11, one that fills the 168 by 44 box, a company named in
90 Latin and 75 Arabic characters, that name with the widest logo, each with a window that ends after
midnight, one that starts before it and one on a single day (122 e-mails). The same 250 were rendered
with the tree as the review found it:

| How many of the 250 are wider than the window (and the widest) | 320 | 360 | 375 | 414 | 480 – 680 |
|---|---|---|---|---|---|
| Before | 113 (421) | 47 (421) | 18 (421) | 12 (421) | 0 |
| **Now** | **0** | **0** | **0** | **0** | **0** |
| Before, the style sheet removed (a client that drops it) | 156 (449) | 86 (449) | 85 (449) | 18 (449) | 0 |
| Now, the style sheet removed | 128 (368) | 14 (368) | 0 | 0 | 0 |

Before, a password reset with a logo shown 168 pixels wide was 397 pixels wide at 375, 360 and 320 (the
review measured 389 with a 160-pixel logo), and an Arabic-led invitation across midnight 421 up to 414.

*What remains.* A mail client that drops the style sheet shows the desktop layout, which now fits from
375 pixels up. Narrower than that it does not always: at 360 the 14 are the English-led notice of a new
time (the pill "Visit rescheduled", whose longest word cannot wrap, beside a logo shown 166 or 168 pixels
wide), 6 to 8 pixels too wide; at 320 they are the e-mails of companies whose logo is shown about 135
pixels wide or wider, by 2 to 48 pixels. Closing that would take a header that wraps by itself (floated
tables in place of one row), which changes the header for every client and could be tried here in one
engine only; it was left.

*Held by.* `tests/unit/test_email_templates.py`: the header's two stacking cells and the rule that stacks
them at the start of each leading language, for all eight e-mails with and without a logo; the pill that
may wrap beside a logo and may not beside a name; the window as two rows in 18-pixel type across midnight
and as two halves in 26 on one day; the Arabic sentence in the invitation and the notice of a new time,
in both parts, with its no-break spaces; `VisitTimes` for both languages and both ends. The widths
themselves are measurements, not tests: the backend's suite has no browser.

**B12-24 — A long name gives way inside the subject; the date stays.**

*Shown.* The subject of an invitation of a company with a long name ended "… and Integrated Digital
Services on Wednesday, 14 Octo…".

*Underneath.* Each language's half was built whole and then cut at its end to its share of 250 characters
(B11-40). The end of the English half is the date, the one thing a subject has to say besides who writes.
A test e-mail made it worse: its "[Test] " was put before a subject that already filled the room, and the
subject was cut again.

*Changed* (`app.email.service`).

- **`subject_within`**: a subject that is too long gives up some of the company's name first. The name is
  cut short where it stands, with an ellipsis, by as much as the subject is too long (shared by the
  name's places when a company's own subject names it twice), never inside a character and to no fewer
  than 12 characters (`SUBJECT_NAME_MIN`). The review's subject is now "… | Your visit to International
  Company for Advanced Technological Solutions and Integrated Digital… on Wednesday, 14 October 2026"
  (249 characters; the Arabic half fitted and is whole). A subject that is still too long (another value
  is the long one, the name would keep fewer than 12 characters, or the subject does not name the
  company) is cut at its end, as before.
- A company's own subject (B11-20) is shortened the same way, wherever it put `{company}`.
- **A test e-mail's prefix is part of the room.** The four editable e-mails take the prefix when they
  are rendered (`prepare_…(subject_prefix=…)`), so the subject is built for 250 characters less the
  prefix: the prefix costs the name a few characters and never the end. The document's `<title>` is the
  subject as it is sent. `queue_prepared` no longer takes a prefix.
- Each language still keeps at least half of the room (B11-40), and every subject is still finished by
  `subject_line` (one line, no direction controls, no encoded word, at most 250 characters).

*Held by.* `tests/unit/test_email_review.py` (69 tests, 7 new): the review's company; names of
200 characters in both languages, each half ending with its date; a company's own subject that names the
company twice; the arithmetic of `subject_within` (one character too long, no space before the ellipsis,
an Arabic letter with its vowel signs, the least a name keeps, a subject without the name); a name that
ends a sentence; the prefix of every editable kind in both languages.

**B12-25 — Two small texts: the Arabic test prefix, and the manifest's short name.**

- **«[رسالة تجريبية] »** is the Arabic prefix of a test e-mail of a company's texts (it was «[تجربة] »,
  "an experiment"): the words of the product's own test message («رسالة تجريبية»). English stays
  "[Test] ". The two are `app.email.service.TEST_SUBJECT_PREFIX`.
- **A manifest's `short_name` is short** (it was the whole name: 76 characters under a phone's icon for
  the review's company). `app.services.brand.short_name`: the name itself while it has at most 12
  characters; otherwise as many of its first words as fit in 12, without the sign or the small word that
  only joined them to the rest ("Bank of America Corporation" → "Bank", "Marks & Spencer Group" →
  "Marks", «مركز نبض الطبي» → «مركز نبض»); and where no word boundary serves (one long first word, or
  nothing before it but "The"), the first 12 characters of the name, never half of a character
  ("International Company …" → "Internationa"). No ellipsis: a short name is a name. `name` is the whole
  name, as before. The joining words are a short list in both languages (`and`, `of`, `for`, `the`, `at`,
  `in`, `de`; «و», «في», «من», «على», «إلى»).

*Held by.* `tests/unit/test_brand.py` (20 names and what each becomes; a vowelled Arabic name and a joined
emoji; the manifest of a long-named company in both languages), `tests/integration/test_public_brand.py`,
`tests/integration/test_email_templates_api.py` and `test_platform_email_texts.py` (the Arabic prefix
through both APIs, and no prefix on a preview).

**B12-26 — A process that started before this round keeps sending e-mail.**

*Found while building.* The user's demonstration server was running: started before this round, and not
to be stopped. A running API process compiles a template once and reads it again whenever its file
changes (Jinja's `auto_reload`), with the code it started with. As soon as `macros.html` read
`colors.surface`, every e-mail of that process failed to render ("EmailColors object has no attribute
'surface'"), and with it every request that queues one, an invitation first of all. Reproduced with the
tree as the review found it and the templates of this round: all eight e-mails failed.

*Changed.* The templates give each value this round added a default: `colors.surface |
default(colors.strong)`, `colors.on_surface | default("#FFFFFF")`, `times[…].dated | default(false)`, and
a window's two phrases default to the values under the card's labels. Today's code always passes the
values (they are required fields of `EmailColors` and `VisitTimes`), so the defaults never apply to it:
250 e-mails rendered with and without them are byte for byte the same. An older process draws the new
layout with what it knows: the strong step on the bar and the button, a window in two halves, the
sentence as it was.

*What it is not.* Not a rule that templates stay readable by older code: a deployment from the images
replaces code and templates together. The defaults and their test go together once no process from before
2026-10-14 runs (open item 11).

*Not done.* The running server was not restarted: it is the user's. Until it is, it answers as before
this round (a palette without `surface`, the notice in the product's identity, «[تجربة] »).

*Held by.* `tests/unit/test_email_templates.py::test_a_process_that_started_before_this_round_still_renders_every_e_mail`
(all eight e-mails in both leading languages with the values of before; it fails with an undefined value
when a default is taken out).

### What a client or a test may have relied on

1. **`BrandPalette` has eleven fields.** The three new ones are required in the snapshot. The algorithm
   named in the web application's fixture of the server's palettes is `oklch-2`.
2. **`brand.version` changed** for every company with a colour (the seeded demo company among them); the
   addresses of images did not.
3. **The manifest**: `theme_color` is `palette.surface`; `short_name` differs from `name` for a name of
   more than 12 characters. For the demo company («موضوع» / "Mawdoo3", `#188086`) neither value changed.
4. **`PLATFORM_ACTION_NOTICE` e-mails** (the development outbox, the E2E suite):
   - sender `"<company>" <address>` instead of EMAIL_FROM's own name;
   - the text part starts with the company's name ("Alpha"; "Name | الاسم" when the two differ, the
     leading language's first) instead of «زوار موضوع | Mawdoo3 Visitors» / "Mawdoo3 Visitors | زوار موضوع";
   - the footer is "Sent by {company}." / «أُرسلت من {company}.» (then "Please do not reply to this
     email." / «يُرجى عدم الرد على هذه الرسالة.» as before) instead of "Sent by Mawdoo3 Visitors on behalf
     of {company}." / «أُرسلت عبر زوار موضوع نيابةً عن {company}.»;
   - the image file is the company's logo when it has one, and **there is no `brand-logo` file when it
     has none** (there always was one: the product's);
   - the HTML has the company's header (the 6-pixel bar, the logo or the name) instead of the teal band;
   - subjects, headings, bodies ("The platform owner added …", "The platform owner sent a
     password-reset link …") and the yellow pill are unchanged.
5. **The Arabic prefix of a test e-mail**: «[رسالة تجريبية] » instead of «[تجربة] » (the E2E suite's
   `email-texts.spec.ts` asserts the old one). "[Test] " is unchanged.
6. **The Arabic sentence of a window on another day**, in `VISITOR_INVITATION` (text part, and the Arabic
   part of an English-led HTML) and `VISIT_RESCHEDULED` (both parts): «… وتنتهي صلاحية بطاقتك يوم الأربعاء
   14 تشرين الأول الساعة 01:57 (بتوقيت عمّان).» instead of «… عند الأربعاء، 14 تشرين الأول، الساعة 01:57 …»
   (and «ابتداءً من يوم الثلاثاء 13 تشرين الأول الساعة 23:50» for a window that starts the day before). In
   the bodies the words of the moment are joined by no-break spaces as shown in B12-23. **Unchanged:**
   the sentence of a window on the visit's day («… عند 12:00 …»), every English sentence, and the value
   under the pass card's label.
7. **Subjects of companies with very long names** have the ellipsis inside the name instead of at the
   end; a subject that fitted in 250 characters is unchanged.
8. **Markup of the e-mails**: the header's cells carry `class="vms-head"` / `"vms-head vms-head-kind"`;
   the pill's corners are `border-radius:13px` (was `999px`), and beside a logo it is
   `white-space:normal`; the primary button's text colour is `on_surface` and its fill `surface`; a
   window with a date has two rows instead of two `width="50%"` cells.
9. **`EmailService.queue_prepared` has no `subject_prefix`**; the four `prepare_…` methods have one.

### Verification of this round (2026-10-14)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 306 files already formatted (no file was added) |
| `mypy` (`backend/`) | no issues in 159 source files |
| `pytest` (`backend/`) | 4,240 passed, 3 skipped, 763.47 s (the opt-in volume checks are the 3) |
| `pytest --committed-first` (`backend/`) | 4,240 passed, 3 skipped, 821.83 s |
| contract snapshot (`tests/unit/test_contract_snapshot.py`, snapshot regenerated) | 6 passed; the committed snapshot is byte for byte what the generator writes |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK, none skipped |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,074 files, no development artefact or credential (1,068 before; the web application's builder was adding files at the same time) |
| `scripts/demo_brand.py --check`, `node deploy/verify/check_nginx_headers.mjs` | the three packaged images are current; 7 headers in sync |

The suite grew by 85 tests (4,158 collected before, 4,243 now): `tests/unit/test_palette.py` 25 (114),
`test_brand.py` 25 (124), `test_email_identity.py` 18 (80), `test_email_review.py` 7 (69),
`test_email_templates.py` 8 (74), `test_email_i18n.py` 2 fewer (470: one catalog text less, which every
per-text test counted, and two tests more), and one each in `tests/integration/test_public_brand.py` (24),
`test_platform_companies.py` (36), `test_email_templates_api.py` (39) and `test_platform_email_texts.py`
(23). Nothing under `deploy/` changed.

**Each safeguard taken out again.** In a private copy of the backend, 56 single changes each removed one
thing this round added: 11 of the palette (a light colour not its own surface, a mid-tone its own, the
dark ink's threshold at 3:1, `on_surface` always white, the hover step of a light surface taken from
`strong`, a hover step that need not read, a step of 0.05, no lighter step above the dark ink's
threshold, the derivation's old name), 7 of the e-mails' colours (the bar, the button's fill, its text,
its edge, links drawn with the surface colour), 4 of the notice (the product's logo and band, EMAIL_FROM's
own name, the product's context, the product's footer alone), 13 of the layout and the Arabic sentence (no
stacking rule, stacked at the end, the pill's cell not stacking, a pill that never wraps or always does,
the window's halves kept, the large type kept, `dated` never set, the list's commas in a sentence, no
preposition on the visit's day, the sentence's own «عند» kept, a day parted from its month, the card's
values in the sentence), 9 of the subjects and the prefix, 6 of the manifest and the 6 defaults of
B12-26. **A test failed for 54.**
Two passed at first and got assertions (the excess shared by a name's two places; a short name that ends
with a sign). The other two change no output: "white before the dark ink" never chooses, because no
colour carries both (the grid's check now says so), and the comparison with `HOVER_MIN_DIFFERENCE` inside
the derivation is a guard behind a target that already meets it (0.065 at the least over 36,088 colours),
kept as a guard while the tests hold the guarantee itself.

**E-mails, rendered and looked at.** The 250 e-mails of B12-23 in Chromium as files (no server): every
kind for eight companies (yellow `#f5b800`, pastel `#f9c6d0`, neon `#39ff14`, navy `#000080`, red
`#e11d48`, black, white and a mid grey `#808080`, four of them with a logo) in both leading languages at
680 and 375 pixels (256 screenshots), and the layout cases at 680, 375 and 320 (366 screenshots). All 250
were measured; about eighty of the screenshots were looked at, on contact sheets: every kind, each of the
eight colours, both leading languages and all three widths among them. What was looked at reads. The
yellow company's bar and buttons are its yellow with dark text and an olive edge; the pastel and the neon
ones likewise; the white one's buttons are outlines in its grey; navy, red, black and the mid grey are as
they were. One decision came out of looking: every button's edge is `strong` (B12-21).

Not run here: Playwright and the web application's own suites (its builder runs them), anything in
Docker, any real mail client.

### Open after this round

1. **A mail client that drops the style sheet, on a phone narrower than 375 pixels** (B12-23): the
   desktop layout is 6 to 8 pixels too wide at 360 for one kind in one language beside a wide logo, and up
   to 48 pixels at 320 for companies with a logo shown about 135 pixels wide or wider. Closing it needs a
   header that wraps by itself, to be tried in real mail clients.
2. **The e-mails were looked at in one engine** (Chromium). The new rules are of the kinds the templates
   already used (a class and a `display:block` rule for phones, inline styles, table rows), and Outlook
   for Windows, which ignores the style sheet, shows the desktop layout at desktop widths.
3. **A mid-tone is still not its own surface.** 14 % of colours (a pure red `#ff0000`, a mid grey) carry
   neither ink at 4.5:1 and are painted with `strong`, a little darker (`#e00000`), as the contract asks.
4. **A white or nearly white company has no visible bar** in its e-mails (white on the white header), and
   its primary button is an outline. The web application has to give such a `surface` an edge of its own.
5. **A light surface only just light enough for the dark ink lightens on hover** (an orange `#ff6600`:
   `#ff9162`), and a vivid one loses some chroma there; darker would not carry its text.
6. **The notice of a platform action is told from the company's other e-mails by its words only**
   (B12-22).
7. **A short name can be an ordinary word.** «الشركة العالمية …» becomes «الشركة», and a name whose first
   word has more than 12 characters is cut inside it ("Internationa"). A short name chosen by the platform
   owner would be a new field.
8. **English still says "Your pass expires at Wed, 14 Oct, 01:57"** for a window on another day; the
   review named the Arabic.
9. **A subject whose company name cannot keep 12 characters is cut at its end**, as before; that takes
   another long value in the same half (a company's own subject with a long visitor's name in it).
10. **The web application's fixture of the server's palettes** names the derivation (`oklch-2`) and has to
    be written again whenever it changes ([`development.md`](../development.md), the contract snapshot).
11. **The templates' defaults for an older process** (B12-26) and their test can be removed once the
    demonstration server has been restarted. What made them necessary stays: a running process reads a
    changed template with the code it started with. Outside development that could be switched off
    (`auto_reload`), which would not help a template that was not yet read when its file changed.
