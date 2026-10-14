# Phase 13 — backend decisions (e-mails that read in dark mode)

Date: 2026-10-14. Scope: `backend/` (application code, templates, tests; no migration), the regenerated
`frontend/src/types/backend-contract.json` (no other frontend file), `README.md`, `docs/security.md`,
`docs/production-readiness.md`, `docs/api.md` and this file. Sections B and C (its backend half) of the
phase's shared contract; the web application's half (the appearance choice) is `phase-13-frontend.md`.

What the owner reported (2026-10-14): the Jordan Kuwait Bank invitation, opened in **Apple Mail on an
iPhone in dark mode**, showed its logo faded or not at all. The stored logo was right (a transparent PNG,
a navy wordmark beside a diamond). The e-mail declared `color-scheme: light` only and put that logo on a
white header; iOS darkened the message itself and the navy sank into the dark background. The bank also
has a logo for dark surfaces (`logo_dark`, its diamond alone), which no e-mail used.

**Contract changes.** One enum and one optional field in two models: `EmailScheme` (`light` | `dark`),
`EmailTemplatePreviewRequest.scheme` and `EmailPreviewDocumentQuery.scheme` (`EmailPreviewDocumentParams`
in the snapshot), both defaulting to `light` (B13-5). No migration, no endpoint, no response field, no
setting, no error code and no field code (an unknown scheme is the existing `invalid_choice`). What a
client or a test may have relied on changed in the e-mails themselves: [the list](#what-a-client-or-a-test-may-have-relied-on).

**After the review** (B13-7 to B13-12, the same day): no contract change either. A logo uploaded at 16
bits a channel is refused with the existing `invalid_image` field code (B13-7); the e-mails' markup is
lighter (B13-8) and writes the name beside a light emblem (B13-12).

---

## The dark design

**B13-1 — Every e-mail has a light design and a dark one.** A mail client that honours
`prefers-color-scheme` (Apple Mail on iOS and macOS, the Outlook apps) shows the dark one; every other
client shows the light one, as before.

- **Declared.** `<meta name="color-scheme" content="light dark">`, `supported-color-schemes` likewise,
  and `:root { color-scheme: light dark }`. A client that is told a message has a dark design of its own
  shows that design instead of darkening the light one by itself.
- **Drawn with classes.** The templates keep their inline light styles (many clients keep nothing else).
  Every element painted in the light design carries a class (`vms-canvas`, `vms-card`, `vms-surface`,
  `vms-sunken`, `vms-bar`, `vms-divider`, `vms-ink`, `vms-body`, `vms-muted`, `vms-link`, `vms-pill`,
  `vms-button`, `vms-button-outline` and their `-text`, `vms-grid`, `vms-grid-cell`, `vms-step`,
  `vms-notice`, `vms-notice-attention`, `vms-pass`), and `dark_rules` (`templates/macros.html`) gives each
  its dark value with `!important`.
- **Three style sheets of their own**, each one block: the phone's layout (as before), the dark rules
  inside `@media (prefers-color-scheme: dark)`, and the same rules under Outlook.com's `[data-ogsc]` (a
  text colour it changed) and `[data-ogsb]` (a background), for its own dark mode. A client that refuses
  a media feature or an attribute selector and drops a whole style sheet (Gmail's habit) keeps the
  others. The dark sheet comes after the phone's, so its colour wins where both set one (the line under
  a stacked details cell). `:root` stands in a fourth, one-line sheet, for the same reason.
- **The neutrals** are the web application's dark ones (`index.css`, theme-dark): canvas `#101619`,
  card and header `#182126`, footer `#12191c`, lines `#2a373e` and `#222d33`, ink `#eef2f4`, running text
  `#c3ced5`, muted `#99a9b2`, and its warning surface `#2d2408` for a notice of what no longer holds.
- **The brand's colours on them** follow the rules of the web application's dark set
  (`frontend/src/identity/tokens.ts`, `darkTokens`), ported to Python in `app.email.identity`
  (`dark_colors`): `accent` (the bright step, moved towards white until it shows 3:1 on every dark
  surface) for the bar, the primary button, every button's edge, the steps' squares and a notice's
  edge; `on_accent` (`on_bright`) on it; `accent_text` (the accent, moved until text reads 4.5:1 on every
  dark surface it meets) for the word mark, links, the pill's text and an outline button; `accent_surface`
  (the deep step, moved towards black until the ink and the muted text read on it) for the pill and an
  information notice; `accent_border` for the pass card's edge. A company without a colour gets the same
  rules on the product's own colours (`DEFAULT_COLORS`: its card, its accent and the ink on it). **The
  port was compared with the web application's own code** (tokens.ts run under Node's type stripping) on
  412 palettes (the contract's spread, the demo colours and 400 random ones): the five values agreed for
  every one. Five of them are pinned in `tests/unit/test_email_dark.py`.
- **What stays as it is**, deliberately: the pass card (already dark; it gains a 1-pixel edge in
  `accent_border` so that it stands off the dark card), its button, the QR code on its white tile, the
  yellow pill of a change to notice (ink on `#f7b916` reads on both), and the product's teal band with its
  logo baked onto it (the CLI's test e-mail, which has the dark design otherwise).
- **Every pair reads**, measured on the 8-bit colours: ink, running text and muted text on the canvas,
  the card, the footer, the pill and both notices 4.5:1; `accent_text` on the card and on the pill 4.5:1;
  `on_accent` on `accent` 4.5:1; `accent` and the attention edge on the card 3:1. Held for the product's
  colours, the contract's spread (yellow, white, black, navy, pastel, `#007ac3`, `#a18e78`, the bank's
  navy, a neon and a mid grey) and a 16³ grid of the cube.

*Held by.* `tests/unit/test_email_dark.py`: the neutrals; the pinned port; the pairs over the grid; the
declarations and the three style sheets in every e-mail of four identities and both leading languages;
**every element painted in the light design has a dark rule** (an HTML walk that fails when a class is
removed: checked by removing three, one at a time), and every rule is for something there is; the
company's colours in the rules; the dark sheet after the phone's.

## The logo

**B13-2 — The logo travels as opaque renditions, never as it was stored.** `app.email.logos`.

- **The light rendition** (`cid:brand-logo`, `brand-logo.png`): the logo for light surfaces laid on
  white, with `PLATE` = 8 CSS pixels of white round it, written as an 8-bit RGB PNG with **no alpha
  channel and no `tRNS`**: no client can show it on black or let a darkened background through. It is
  shown by default, and it is the only logo the Gmail apps and Outlook for Windows ever show.
  - On the white light header the plate cannot be seen. The header's padding gives the plate back (18 −
    8 above, 16 − 8 below, 32 − 8 at the start; 18 − 8 at the start on a phone, where the pill's cell
    gives it back under the logo), so the logo's own edge stays exactly where the text starts, as before.
  - Where a client darkens the message by itself, the plate is a white tile with rounded corners
    (`border-radius:10px` on the image, which Outlook for Windows ignores: there the header is white).
- **The dark rendition** (`cid:brand-logo-dark`, `brand-logo-dark.png`), when the company has a logo for
  dark surfaces: that logo laid on the exact colour of the dark header (`#182126`), framed the same way,
  opaque, seamless there. Only the dark design shows it: it is in a `<div class="vms-dark-only"
  style="display:none; max-height:0; overflow:hidden; mso-hide:all;">` inside `<!--[if !mso]><!-->`, and
  the dark rules hide the light one (`vms-light-only`) and show it.
- **A mark beside its name** (the rule as B13-12 made it). A logo at most `EMBLEM_MAX_RATIO` (1.4) times
  as wide as it is tall is an emblem, a mark: beside whichever logo a design shows that is one, the
  header writes the company's name (18 pixels, 15 for a name of more than 28 characters, in that design's
  ink), and the image's own text alternative is empty, since the name is there. The bank's diamond
  (423 × 570) is one; a wordmark (661 × 109) stands alone with the name as its text alternative. (Until
  B13-12: the dark logo alone, at `WORDMARK_MIN_RATIO`, 2.)
- **Without a logo for dark surfaces** the dark design keeps the light rendition, deliberately: a white,
  rounded, padded tile on the dark header, which reads.
- **Without a logo for light surfaces** there is no image in the header, whatever else the company has:
  its name is the word mark in both designs (as the web application's `CompanyLogo` does on a page).
- **Smaller.** Each rendition is made smaller by area averaging to at most `DENSITY` (2) image pixels per
  CSS pixel of the size it is shown at (the header's 168 × 44 box, B12-12), never enlarged. The bank's
  609 × 159 logo is shown 168 × 44 and drawn at 336 × 88 (plus 16 pixels of plate): 3,784 bytes. A
  company's e-mail no longer carries its stored logo in full (up to 512 KiB, Phase 12 open item 3).
- **A logo that cannot be drawn** (which no stored logo should be: it passed the same check at upload) is
  sent as it was stored, without a plate and without a dark rendition, and a warning is logged with the
  kind and the problem; the e-mail goes either way.

*Held by.* `tests/unit/test_email_logos.py` (opaque 8-bit RGB without `tRNS`; the plate exactly the
background all round; at most twice the shown size; the owner's logo pixel for pixel where its diamond is
solid; a small logo not enlarged; a clear picture is its plate; the largest logo; the mark rule at its
boundary); `tests/unit/test_email_dark.py` (the mark with the name beside it in both leading languages, a
wordmark alone, the white tile without a dark logo, the name without a logo, a dark logo without a light
one not shown); `tests/unit/test_email_templates.py` (the plate's padding at both widths; a logo that
cannot be drawn); `test_smtp.py`, `test_resend.py`, `test_email_identity.py` (the rendition is what is
sent).

**B13-3 — Pixels in pure Python.** The server still has no image library and gains none.

- `app.core.png.decode_png` runs `sanitize_png` first (B12-2: so it meets only what the upload's check
  accepts, and inflates no more than the header implies), then undoes the five filters and gives 8-bit
  RGBA for every colour type and bit depth PNG defines: a 16-bit sample by its high byte, a transparent
  colour (`tRNS`) compared at its full depth, an index past the palette as opaque black. Up is undone as
  one addition of two integers (seven bits a byte, the eighth by exclusive or), Sub with running sums per
  sample (`itertools.accumulate`); Average and Paeth one byte at a time, which is what costs; Paeth under
  a row of zeros (a transparent band) is Sub and takes that path.
- `app.core.png.encode_rgb_png` writes 8-bit truecolour without alpha, every row filtered with Sub,
  deflated at level 9: reproducible, and what it writes passes `sanitize_png` unchanged.
- `app.core.raster`: `flatten` lays RGBA on an opaque colour through a lookup table per sample
  (`alpha * 256 + value`), `downscale` averages areas exactly in integers (each source pixel weighed by
  how much of it a new pixel covers; rows summed as integers with a 32-bit lane per sample, columns as
  differences of running sums), `framed` adds the plate.

*Measured* (`tests/performance/test_logo_renditions.py`, opt-in: `pytest --performance -s`; a 1200 × 600
RGBA logo, the largest a company may have, at 8 bits a channel and, since B13-7, at 16; measured again
after the review on the development machine, its processor 6 % busy when the run began; best of 3, each
run's three within 25 % of each other):

| How the file's rows are filtered | File | Drawn (decode, flatten, downscale, frame, encode; best of 3) | Found again |
|---|---|---|---|
| As a browser's canvas writes it (libpng's choice per row) | 12,035 bytes | 0.355 s | 0.05 ms |
| None on every row | 21,214 bytes | 0.276 s | 0.09 ms |
| Sub on every row | 22,467 bytes | 0.711 s | 0.08 ms |
| Up on every row | 12,884 bytes | 0.401 s | 0.06 ms |
| Average on every row | 24,359 bytes | 1.026 s | 0.10 ms |
| **Paeth on every row (the worst case an upload may be)** | 12,808 bytes | **1.958 s** | 0.03 ms |
| The five in turn | 19,588 bytes | 0.813 s | 0.08 ms |
| 16 bits a channel, as a canvas writes it (refused as an upload since B13-7) | 15,980 bytes | 0.400 s | 0.07 ms |
| **16 bits, Paeth on every row** (refused as an upload since B13-7; a logo stored before) | 16,902 bytes | **3.691 s** | 0.07 ms |

The first table of this record (written while the web application's builder kept the machine about
half busy) gave 1.891 s for Paeth at 8 bits, and had no 16-bit row; the reviewer measured 3.5 to 3.7 s
for 16 bits with Paeth throughout, and about 2 s at 8 (a picture whose rows are all Paeth over a first
row of ones). `app.core.png` said "up to about a second". All of it is corrected here, and the cost no
longer falls on a request (B13-7).

The shapes of the owner's report, drawn by the tests with their rows filtered by the five filters in
turn: the navy wordmark (609 × 159) 0.13 s, the diamond alone (423 × 570) 0.34 s, a gold wordmark
(661 × 109) 0.16 s; their renditions are 3,784, 2,114 and 2,149 bytes. Memory (`tracemalloc`) at the peak of one
drawing: 10.4 MiB for the largest logo at 8 bits a channel, 16.6 MiB at 16, 1.6 MiB for the bank's;
nothing is kept but the rendition (a few KiB).

*Held by.* `tests/unit/test_png_drawing.py` (43): every filter alone; Paeth under a clear row; grey at
1, 2, 4, 8 and 16 bits with and without a transparent grey; grey with alpha; truecolour at 8 and 16 bits
with and without a transparent colour; RGBA at 16 bits; palettes at 1 to 8 bits with and without alpha;
an index past the palette; refusals and limits; encoding opaque, exact and reproducible; flattening every
alpha exactly; area averaging by coverage, of a flat colour and of the mean. The images are written by
the tests' own encoder (`tests/png_support.py`), apart from the decoder.

**B13-4 — Drawn once per process, kept by the SHA-256 of the stored bytes; nothing stored.** The
contract asked for one of two: renditions stored at upload with a lazy fill for logos stored before, or a
cache by content hash. **Decided: the cache** (`RenditionCache`, one per process).

- A rendition depends on the stored bytes and on the colour it is laid on, and on nothing else: the key
  is `(sha256(content), background)`. A new image is a new key; nothing has to be told that anything
  changed, and a logo stored before this phase needs no fill.
- **No e-mail and no preview draws one twice.** At most one rendition is drawn at a time in a process;
  a second request for the same one waits for the first and takes its result (held with four threads at
  once). A request whose rendition is already there never waits for one being drawn (held).
- Bounded by bytes (8 MiB, least recently used first out: a rendition found again counts as used, B13-10):
  a rendition is a few KiB, so that is room for thousands. Its cost, paid once per logo per process, and
  since B13-7 ahead of the requests that send it: the table above.
- Storing was not chosen because it buys little and costs much: a migration (a table or six columns with
  their CHECKs, privileges, the downgrade's guard), a write in the path of a sent e-mail for the logos
  stored before (or a backfill to run at deployment), and the demonstration database to migrate. What it
  would save is about 2 s per logo and process (3.7 s for a 16-bit logo stored before B13-7); the cache
  already saves every send after the first, and B13-7 draws the first ahead.

*Held by.* `tests/unit/test_email_logos.py` (drawn once per logo and background, by content not by
object; two requests at once draw once; a found rendition does not wait; the bound in bytes, least
recently used out).

## Previews

**B13-5 — A preview is one design alone.** `POST …/email-templates/{kind}/preview` (the company's and the
platform owner's) takes `"scheme": "light" | "dark"` in its body, and `GET …/preview` takes
`?scheme=light|dark`; both default to `light`, and anything else is 422 (`invalid_choice` on `scheme`).

- **`dark`**: the same e-mail with its dark rules applied **unconditionally** (no media query round them,
  no Outlook.com sheet), `color-scheme: dark` in the meta and on `:root`, the dark logo shown: what a
  client in dark mode shows, whatever the scheme of the device the preview is looked at on.
- **`light`** (an amendment of the contract, agreed with the web application's builder while this phase
  was built): **the light design alone**, `color-scheme: light` in the meta and on `:root`, no dark style
  sheet and no dark logo. A document in a frame matches `prefers-color-scheme: dark` whenever the device
  is dark, whatever `color-scheme` the frame or the page around it has (the web application's builder
  tried light, dark and none in Chromium), and the sandboxed document cannot be restyled from outside:
  the e-mail as sent would show its dark design in a "light" preview on a dark device. The light preview
  has no rule that `prefers-color-scheme: dark` can match (held by a test, and by a screenshot under dark
  emulation: it stays light).
- **The e-mail as sent** (every real send, and every test e-mail) carries both designs. `/test` accepts
  the preview's body, `scheme` included, and ignores `scheme`: the web application can send the same
  body to both.
- In the renderer `scheme` is `None` (as sent), `"light"` or `"dark"`; the four `prepare_…` methods take
  it, and the service passes it from the request.

*Held by.* `tests/unit/test_email_dark.py` (both previews of the four editable kinds in both leading
languages: the light one has no `prefers-color-scheme`, no dark rule and no dark logo; the dark one has
its rules outside any media query); `tests/integration/test_email_templates_api.py` and
`test_platform_email_texts.py` (both schemes through both APIs, in the body and the query; the default;
a refused scheme; a test e-mail with both designs and three images).

**B13-6 — A process that started before this phase keeps sending.** As B12-26: the user's demonstration
server reads changed templates with the code it started with. Every value this phase added has a
default in the templates (`identity.dark`, `identity.plate`, `identity.logo_dark`, `scheme`), and with
none of them a template draws what it drew before: the light design alone (`color-scheme: light`), the
logo as given without a plate. *Held by* `test_a_process_that_started_before_the_dark_design_still_sends_the_light_one`
(all eight e-mails, both leading languages); the round's own older-process test still passes.

## After the review (2026-10-14)

An independent review of this phase found what drawing a logo costs, and where; an e-mail too close to
Gmail's clipping; two safeguards no test held; a fault the e-mails did not survive; and a rule the
e-mails applied differently from the web application. Each is fixed below.

**B13-7 — What drawing a logo costs is paid off the request path.** The review measured 3.5 to 3.7 s for
the largest logo at 16 bits a channel with Paeth on every row, and about 2 s at 8; `app.core.png` said "up
to about a second". It was paid by the first e-mail of each logo in a process, inside the request: a
check-in renders the host's notice while it holds the visit's row (`attendance.py`), and every e-mail
asks `identity_of`, then `company_identity`, behind one drawing lock per process.

- **A logo is uploaded at 8 bits a channel at most.** `PngLimits.max_bit_depth` (16 unless a caller says
  otherwise) is judged on the header, with the dimensions, before anything is inflated
  (`PngProblem.BIT_DEPTH`); the upload limits of `logo` and `logo_dark` say 8. The web application's
  pipeline only ever uploads 8 bits (a canvas writes them). The API answers the existing field code,
  `invalid_image` on `file`, with the message "Upload a PNG image of 8 bits per channel."; the web
  application already shows "The server refused this image. Choose another file." for that code, which
  fits: **no new code**. An icon keeps every depth (no e-mail draws one). A logo stored before at 16 bits
  is still decoded (`app.email.logos.LOGO_LIMITS`) and drawn ahead like any other; a check of the largest
  upload now inflates 2.7 MiB, not 5.5.
- **Drawn ahead** (`app.email.logos.LogoWarmUp`), in daemon threads, through the e-mails' own store:
  - after a logo for light or dark surfaces is stored or removed, once the change is committed
    (`PlatformBrandService`), that company's renditions; an icon and an upload that changes nothing ask
    for nothing;
  - once per process, every active company's (those with a logo for light surfaces, the only ones whose
    e-mails carry one), from **the process's first write** (`app.core.middleware.FirstWrite`, the
    innermost middleware: a request with an unsafe method calls it once, and goes on without waiting).
- **Why from the first write, not at start.** The deployment runs four API processes of one image with
  one command and one configuration: a read service may set only `PASSWORD_HASH_CONCURRENCY` and
  `DB_POOL_SIZE` of its own (security review condition 4, D9-37, `deploy/verify/test_api_instances.py`;
  docs/security.md §16, item 9). At start nothing tells the main instance from the three read
  processes, which send no e-mail; drawing every company's logos there would cost each of them about a
  second of processor per company at every restart, beside the reception lists' 300 ms budget. Nginx
  sends them only the GETs of its map, and every e-mail follows a write (or is a preview, on the main
  instance): the process that takes writes is the one that sends e-mails. After a restart its first write
  is a sign-in or a scan, ahead of the first e-mail. Nothing runs at start, so start-up never waits. A
  compose setting that switched the warm-up off in the read services was the alternative; it would
  change the security review's condition, which is not this round's to change.
- **Sessions and failures.** Each company's logos are read in a session of its own, closed before
  anything is drawn; the list of companies in one more (IDs only, `CompanyBrandRepository.companies_with_logo`).
  A failure is logged with the company's ID and its traceback, and the next company is drawn; whatever is
  missing, the e-mails draw on demand as before.
- **A request and the warm-up.** A request that needs a rendition being drawn ahead waits for that
  drawing and takes its result (the store's second look under its drawing lock); one that needs another
  waits at most for the drawing in progress, then draws its own.
- **Only where `python -m app.serve` runs** (`app.main.create_served_app`, the factory of
  `app.serve.APP_FACTORY`); an application a test builds (`create_app`, `warm_email_logos=False`) draws
  nothing ahead. In the tests every session shares one connection inside a rolled-back transaction,
  which a thread of its own must not use.
- **The numbers** in B13-3 (16-bit rows added), `app.core.png`, `app.email.logos`, the open items below,
  README §10 and §15, and docs/security.md §9.3, §10.4 and §19.

*Held by.* `tests/unit/test_png.py` (16 bits refused on the header for both logos, nothing inflated; an
icon and a stored logo of every depth accepted; the limits); `tests/integration/test_platform_brand.py`
(the API's answer for both logos, an icon at 16 bits stored; the warm-up asked once per committed change
of a logo, never for an icon or an unchanged upload; refused uploads keep nothing, now at 8 bits);
`tests/unit/test_email_logos.py` (every company's logos drawn ahead, once per process, with no session
held while drawing; a company that fails does not stop the others; one company after a change; a
request waits for the drawing it needs and takes it); `tests/integration/test_email_logo_warm_up.py`
(committed: a read starts nothing, the first write starts it in a daemon thread, the bank's renditions
drawn, a deactivated company's and a dark logo without a light one not, once per process; a test's
application draws nothing ahead); `tests/unit/test_serve.py` (the run command's factory; `FirstWrite`
calls back once, on a write, and a failing callback stops no request);
`tests/performance/test_logo_renditions.py` (the 16-bit rows, and that an upload refuses them).

**B13-8 — An e-mail stays clear of Gmail's clipping.** Gmail clips a message whose HTML passes about
102 KB (the rest, the pass's QR code and the footer with it, behind "[Message clipped]"). The review
measured the worst invitation (B11-40's worst inputs: every text and value at its longest, of the
character that grows most when escaped) at 101,655 bytes with a logo and a dark mark; the guard
(`test_the_largest_e_mail_a_company_s_texts_can_make`) used no logo, and allowed 100 KiB.

- **The guard** now renders every editable kind in both leading languages with the two heaviest headers
  (a wordmark for light surfaces with a mark for dark ones; an emblem for light surfaces with a wordmark
  for dark ones: the name twice in each), and allows **95 KiB (97,280 bytes)**.
- **The markup cut, nothing a client draws changed:**
  - class names of three or four letters (`vcv` the canvas, `vik` ink, `vlo` / `vdo` the swap, ...; the
    legend heads `macros.html`);
  - the dark rules grouped by colour, one rule per colour with every class that takes it, and the three
    style sheets without spaces: the dark one 1,520 → 861 bytes, Outlook.com's 1,629 → 1,069;
  - inline styles without a space after `;` (or after a `%}` that opens a declaration), and the font
    stacks written as they are (`'` is plain text in a double-quoted attribute; it was escaped as
    `&#39;`), without spaces after their commas;
  - an HTML template is read without the indentation of its lines and without a line break beside a
    block's or a table's tag (`app.email.rendering.compact_html`, at load): HTML draws neither. It runs on
    the template's own text, before any value is put in; a line break between two inline tags (a space
    HTML draws) stays. A plain-text template is read as it is.
- **The name in the header** stands once where both logos are emblems (one name serves both designs,
  B13-12), and twice otherwise: an image's text alternative in one design and the name beside an emblem
  in the other, which each design needs.
- **Result:** the worst invitation 101,655 → 96,686 bytes (wordmark and dark mark) and 96,782 (emblem and
  dark wordmark, the heaviest header since B13-12): 498 bytes under the guard, 7.7 KB under 102 KiB; the
  other kinds under 82,000 bytes. The e-mails people receive are 15 to 17 % lighter (the bank's invitation,
  30,651 → 25,598 bytes). What is left is the values (72 KB of the worst invitation) and the inline
  styles and attributes the clients need (the font stack on every block for Outlook for Windows, `valign`
  beside `vertical-align`, `bgcolor` beside `background-color`, the tables' attributes); the guard's margin
  is small by design: a later round that adds to every message has to make room first.
- **Looked at, and compared.** 52 e-mails (the four identities of B13-3's screenshots and three with a
  light emblem, invitation, arrival and cancellation in both leading languages, the light and dark
  previews, the product's test e-mail) rendered before and after this round by the real templates,
  screenshot with Playwright in Chromium and WebKit at 600 and 320 pixels, in light, under
  `colorScheme: 'dark'` and under the forced inversion: 592 pages each time, none wider than its window.
  **392 are byte for byte the same before and after**; the 200 that differ are exactly the pages of the
  three light-emblem identities where a light emblem shows (B13-12); 132 header crops of those at twice
  the density were looked at.

*Held by.* the guard (16 cases); every test of B13-1, B13-2 and B13-5, unchanged in what it holds (their
strings follow the new class names and the spaces taken out); `test_an_html_template_loses_only_the_white_space_html_does_not_draw`
(both line endings) and `test_an_e_mail_keeps_the_white_space_of_its_values` (`test_email_templates.py`).

**B13-9 — The logo's swap cannot leak out of the dark media query.** The rules that hide the light
rendition and show the dark one (`.vlo`, `.vdo`) apply only inside `@media (prefers-color-scheme: dark)`:
anywhere else they would hide the logo where no dark design is shown. Outlook.com's sheet does not swap
the logo, and every selector in it starts with `[data-ogsb] ` or `[data-ogsc] `. *Held by*
`test_the_logo_s_swap_stays_inside_the_dark_media_query` (`test_email_dark.py`, the e-mail as sent, four
identities, both leading languages), which fails for the reviewer's mutation (`macros.html`
`{% if not outlook %}` made `{% if true %}`).

**B13-10 — The store keeps what was used last.** `RenditionCache` evicts the least recently *used*
rendition: one found again moves to the end (`move_to_end`), which no test held (removing it passed).
*Held by* `test_what_was_read_last_is_kept_and_the_least_recently_used_goes`: room for two of three; A,
B, A read again, C: B goes, A stays.

**B13-11 — A fault while drawing never fails a request.** `_drawn` caught `PngError` only: any other fault
of the drawing (a defect in `app.core.raster`, a memory error) would have failed the visit's creation,
check-in or cancellation that rendered the e-mail. It now catches every exception, logs it with its
traceback (the logo's kind and the fault's class), and the stored logo goes instead, as for an image
that cannot be decoded. *Held by* `test_a_fault_while_drawing_never_stops_an_e_mail`.

**B13-12 — The name beside an emblem, as the web application writes it.** `CompanyLogo.tsx` writes the
company's name beside a logo that is an emblem, `naturalWidth / naturalHeight <= EMBLEM_MAX_RATIO` (1.4),
measured on whichever image is shown. The e-mails used the contract's `WORDMARK_MIN_RATIO` (2), and only
for the dark logo.

- `app.email.logos.is_mark`: `5 * width <= 7 * height`, the ratio 1.4 compared exactly in integers
  (`EMBLEM_MAX_RATIO` documents it); for the sizes a logo may have it decides as the browser's floating
  point does. 140 × 100 is an emblem, 141 × 100 and 200 × 100 are not; 423 × 570 and 512 × 512 are.
- `Identity.logo_mark`: the logo for light surfaces is an emblem (from its rendition, or from the stored
  sizes when it cannot be drawn). The light header then puts the logo and the name in a table of two
  cells, as the dark header did for a dark mark: the name 12 pixels from the emblem's own edge (its plate
  is part of them), in the ink (`#1E2A32`; `vik`, so the dark design's ink there), 18 pixels or 15 for a
  long name, and the image's text alternative empty.
- With a logo for dark surfaces: both emblems, one name for both designs (outside the dark-only block);
  a light emblem with a dark wordmark, the name hidden by the dark design (`vik vlo`) and the wordmark's
  text alternative the name; a light wordmark with a dark emblem, as before (the name inside the dark-only
  block). Without one, the dark design keeps the white tile, and the name beside it.
- On a phone the header stacks as before: the logo and its name on one line, the kind of message under
  them.
- A process that started with this phase's first code (the demonstration server) reads these templates
  without `logo_mark`: a light emblem stands alone there, as that code drew it (`| default(false)`).

*Held by* `tests/unit/test_email_logos.py` (the rule at its boundary, nine sizes),
`tests/unit/test_email_dark.py` (a light emblem alone, two emblems sharing one name, an emblem with a dark
wordmark, both leading languages; the bank's case unchanged, its name once in the dark block; a process
without `logo_mark`); the screenshots of B13-8.

---

## Deviations and decisions for the frontend

1. **`scheme`** in `EmailTemplatePreviewRequest` (optional, default `light`) and in the preview
   document's query (`EmailPreviewDocumentParams.scheme`, optional); a new enum `EmailScheme`
   (`'light' | 'dark'`) in the snapshot. `api.ts` needs the field and the type for the parity test.
2. **The light preview is the light design alone** (B13-5), the dark preview the dark design alone.
3. **Images in a preview document**: the sample QR code, the light rendition when the company has a logo,
   and in a **dark** preview also the dark rendition when it has a logo for dark surfaces (1, 2 or 3).
4. **The outbox** of a company with both logos has `<id>-brand-logo.png` (the light rendition, **not**
   the stored file any more) and `<id>-brand-logo-dark.png`. The E2E helpers that take every inline
   image but `brand-logo` as content (`e2e/support/outbox.ts` `inlineImages`) must leave out
   `brand-logo-dark` too: the demo company has both logos, and an invitation's images are now
   `[brand-logo, brand-logo-dark, visitor-pass-qr]` in the order the HTML names them. A test that compares
   the e-mail's logo with the stored one byte for byte (`company-identity.spec.ts`) must compare it with
   an opaque PNG instead.
5. **The mark rule** is the application's `EMBLEM_MAX_RATIO` (1.4) since B13-12, beside the logo of
   either design, as `CompanyLogo` does. (Before: the contract's `WORDMARK_MIN_RATIO` (2), in the dark
   design only.)
6. **A logo uploaded at 16 bits a channel** is refused (B13-7) with the existing field code
   `invalid_image` on `file` and the message "Upload a PNG image of 8 bits per channel.". The identity
   editor's mapping of `invalid_image` fits, and its pipeline only uploads 8 bits: nothing to change.
7. **The run command's factory** is `app.main:create_served_app` (`create_app` with the logos drawn
   ahead, B13-7); the E2E server starts through `python -m app.serve` as before.

## What a client or a test may have relied on

1. **The logo image** of every company e-mail is the light rendition: an opaque RGB PNG of the logo on
   white with 16 image pixels of plate (8 CSS pixels at the usual density), not the stored bytes; shown
   16 CSS pixels wider and taller than before (`width`/`height` attributes), with `border-radius:10px`.
2. **The header's padding** beside a logo is `18 − 8 / 16 − 8 / 32 − 8` (start) instead of `18 32 16 32`,
   and its class is `vms-px-plate vms-surface` (`vms-px vms-surface` without a logo); the pill's cell has
   `padding-{start}: 4px` beside a logo.
3. **Classes** on most elements (see B13-1), between the attributes before them and `style`.
4. **Four style sheets** instead of one; the meta says `light dark`.
5. **A second image**, `brand-logo-dark`, for a company with a logo for dark surfaces.
6. Since B13-8: **the class names** are short (`vms-surface` is `vsf`, `vms-px` is `vpx`, ...: the legend
   in `macros.html`); inline styles have no space after `;`; the style sheets have no spaces and group
   their selectors; the font stacks are written with `'` and without spaces after commas; the HTML has no
   indentation and no line break beside a block's or a table's tag. `src="cid:…"` is unchanged, and the
   images come in the same order.
7. Since B13-12: beside a logo for light surfaces that is an emblem, the logo stands in a table with the
   company's name, and its text alternative is empty.

## Verification (2026-10-14)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 312 files already formatted |
| `mypy` (`backend/`) | no issues in 161 source files |
| `pytest` (`backend/`) | 4,363 passed, 10 skipped (the opt-in performance checks: the 3 volume checks and the 7 of B13-3), 621.86 s |
| `pytest --committed-first` (`backend/`) | 4,363 passed, 10 skipped, 603.93 s |
| contract snapshot (`tests/unit/test_contract_snapshot.py`, snapshot regenerated) | 6 passed; the web application's parity test (`api.contract.test.ts`, run once read-only) 89 passed against it |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,092 files, no development artefact or credential |
| `scripts/demo_brand.py --check`, `node deploy/verify/check_nginx_headers.mjs` | the three packaged images are current; 7 headers in sync |
| `pytest --performance -s tests/performance/test_logo_renditions.py` (opt-in) | 7 passed; the table of B13-3 |

New tests: `tests/unit/test_png_drawing.py` (43), `test_email_logos.py` (18), `test_email_dark.py` (56),
`tests/performance/test_logo_renditions.py` (7, opt-in); 6 more in existing files
(`test_email_templates.py` 2, `tests/integration/test_email_templates_api.py` 3,
`test_platform_email_texts.py` 1). Existing tests changed where the markup or the logo they pinned
changed (classes between `dir` and `style`, the plate's padding and size, the rendition instead of the
stored bytes: [what a client or a test may have relied on](#what-a-client-or-a-test-may-have-relied-on)).

**One timing test measured rendering too.** `tests/unit/test_smtp.py` times how long a send to a server
that never answers takes against a bound (for example 1.9 to 2.6 s for a 2 s deadline), and built the
invitation inside the timed span: a fresh renderer compiling the templates, 0.2 to 0.3 s on an idle machine.
Under the load of the web application's end-to-end suite running alongside, one run went past the bound
(and so did one of three runs of the test alone). The five timed tests now render the invitation before the
clock starts, so they time the attempt only; three runs of the file in a row passed.

**Each safeguard taken out again.** In a private copy of the backend, 30 single changes each removed one
thing this phase added: 11 of the templates (the meta's `light dark`, the media query, the light preview's
lack of a dark sheet, the dark preview's lack of one, hiding the dark logo, the name beside a mark, hiding
the light logo, the footer's and a notice's dark values, the whole dark design, the plate given back by the
padding), 7 of the renditions and their cache (no plate, no downscale, the wrong dark colour, the mark rule
at its boundary, a key by object instead of by content, no drawing lock, no eviction), 6 of decoding and
drawing (a Paeth tie, the Paeth shortcut on every row, the low byte of a 16-bit sample, a transparent
colour ignored, the blend's rounding, the area weights), 3 of the dark colours (the accent and the text not
moved, Python's rounding instead of JavaScript's), 3 of the service (no dark logo read, the stored logo
sent, the preview's scheme dropped). **A test failed for 28.** Three passed at first and got a test: the
wrong dark colour (the dark rendition is now held to the colour the dark rules paint the header with), and
the accent and the text not moved (no palette the server derives needs them moved, over 70,849 colours, so
the rules are now held on made-up inputs that do, with tokens.ts's values for them: 604 such inputs
agreed). The preview's scheme is caught by the integration tests. The other two change no output, and
cannot: a Paeth tie between left and above with left ≠ above means left + above = 2 × upper left, where the
upper left is nearest whichever way the tie goes; and the mixes of the dark rules move by `k / 25` (or
0.6), where no channel can land on a half, so half up and half to even agree (none of 70,849 palettes and
20,000 made-up inputs differs). They are kept as written, as the web application's code is.

**E-mails, rendered and looked at.** Every kind (invitation, new time, cancellation, a visitor's arrival,
password reset, password changed, the notice of a platform action) in both leading languages for four
identities (the bank's navy wordmark with its diamond for dark surfaces, a navy wordmark with a gold
wordmark for dark surfaces, a logo for light surfaces only, no logo and no colour), the product's test
e-mail, and the previews of both designs (74 documents), rendered by the real templates through the real
service to static files with their images inline. Screenshot with Playwright 1.63 in **Chromium and WebKit
26.6** at 600 and 320 pixels, in light, under `colorScheme: 'dark'` and under a forced inversion like the
Gmail app's (`html{filter:invert(1) hue-rotate(180deg)} img{filter:invert(1) hue-rotate(180deg)}`): 824
full pages, **none wider than its window**, and 824 header crops at twice the density on 40 contact
sheets. Looked at: the contact sheets of every identity at both widths and in both engines, and about
twenty full pages. What was looked at reads. The logo: invisible plate in light; the bank's diamond with
its name beside it, seamless on the dark header; a white rounded tile with the navy wordmark under
inversion and in the dark design without a logo for dark surfaces. The light preview stays light under a
dark device scheme, and the dark preview is dark under a light one.

Not run here: the end-to-end suite and the web application's own suites (its builder's gate, running on
this machine at the same time), anything in Docker, any real mail client.

### After the review (B13-7 to B13-12)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 313 files already formatted |
| `mypy` (`backend/`) | no issues in 161 source files |
| `pytest` (`backend/`, the default order) | 4,415 passed, 12 skipped (the opt-in performance checks: the 3 volume checks and the 9 of B13-3), 585.57 s |
| contract snapshot (`tests/unit/test_contract_snapshot.py`, in the run above) | passed, **not regenerated**: no schema changed (`frontend/src/types/backend-contract.json` untouched) |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,093 files, no development artefact or credential |
| `scripts/demo_brand.py --check`, `node deploy/verify/check_nginx_headers.mjs` | the packaged images are current; 7 headers in sync |
| `pytest --performance -s tests/performance/test_logo_renditions.py` (opt-in) | 9 passed; the table of B13-3 |

The first full run of this round failed three tests, each a test that had to learn of the change: the
messages of a refused image (one more), the list of repository reads that span companies (one more,
`companies_with_logo`), and a log assertion of a new test that counted another logger's records under
the full suite. All three fixed; the run above is the second.

New tests: 54 (`test_png.py` 4, `test_email_logos.py` 9, `test_email_dark.py` 16, `test_email_templates.py`
4, `test_email_review.py` 12 (the guard's cases, 4 before and 16 now), `test_serve.py` 2,
`tests/integration/test_platform_brand.py` 3, `tests/integration/test_email_logo_warm_up.py` 2, the
performance checks 2). Changed: the tests that pinned the markup (class names and the spaces taken out), and
`test_refused_uploads_leave_no_inflated_image_behind`, now with 8-bit logos (a 16-bit one is refused before
anything is inflated).

**Each fix taken out again**, in a private copy of the backend, one at a time: the reviewer's mutation
(the swap in Outlook.com's sheet), no `move_to_end`, `_drawn` catching `PngError` alone, the old mark rule,
no `logo_mark`, 16 bits accepted for a logo, the warm-up drawing with its session open, the warm-up
stopping at the first failing company, the shared name hidden from the dark design, and line breaks
joined beside inline tags: **a test failed for all 10** (for its own reason: checked for the fault's
traceback).

**Looked at:** the 592 screenshots of B13-8 before and after (392 byte for byte the same, the other 200
the light-emblem identities), and header crops of those at twice the density in both engines, all three
modes and both widths, among them: the emblem with the name beside it in light, under inversion (the
white tile and the name) and in dark without a logo for dark surfaces (the tile and the name), two
emblems sharing one name, an emblem with a dark wordmark (the wordmark alone in dark), the light preview
of an emblem on a dark device (light), and the bank's headers, unchanged. The final templates render
these 52 e-mails byte for byte as shot.

## Open after this phase

1. **Real mail clients.** Looked at in Chromium and WebKit (Playwright 1.63's WebKit 26.6, the engine
   closest to Apple Mail) with `colorScheme: 'dark'` emulation and a forced inversion like the Gmail
   app's; not in Apple Mail, Outlook or the Gmail apps themselves (production-readiness L-24 stands).
2. **The warm-up starts at the main process's first write**, not at its start (B13-7): no setting tells
   the four processes apart, by the security review's condition. A compose setting for it would be the
   way to start at start; it needs that condition changed.
3. **Gmail's own dark mode** (its apps) darkens the light design by itself; the logo then stands on its
   white tile, the QR code on its own white quiet zone. Gmail does not apply a dark design of a message's
   own.
4. **A request that arrives while the warm-up draws** waits for the drawing in progress: about 2 s at
   most for the largest logo an upload may be filtered with Paeth throughout (3.7 s for a 16-bit logo
   stored before B13-7), typically well under half a second, and only in the seconds after a process's
   first write or a logo's change. Paying it inside no request at all would need the renditions stored,
   which B13-4 did not choose.
5. **A process that started before this review** (the demonstration server runs this phase's first
   code) sends these templates without the name beside a light emblem and without the lighter markup's
   loader, until it is restarted (B13-12, B13-8); one from before this phase sends the light design
   alone (B13-6). The defaults and their tests can go once no such process runs.
6. **The weight guard's margin is about 500 bytes** at the heaviest header (B13-8): what is left is the
   values and the inline styles the clients need. A later round that adds to every message makes room
   first, or lowers what the worst inputs allow.
