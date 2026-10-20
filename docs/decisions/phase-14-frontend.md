# Phase 14 — frontend decisions (a visit in the host's calendar; the host's e-mails in the e-mail texts)

Date: 2026-10-19. Scope: `frontend/**` (the visit page's and the invitation's "Add to my calendar", a
small iCalendar writer, the kit's menu, the e-mail texts' three new kinds, the types, the catalogs, the
unit tests and `e2e/**`), the READMEs and this file. Contract: the Phase 14 contract, section B as amended
by the lead (no control on `/pass`), with the backend's settled shapes (`phase-14-backend.md`, B14-12 …
B14-14 and its "Deviations and decisions for the frontend"). The rules of the earlier phases hold: direction
C with the existing kit, Arabic (right to left, the default) and English from the catalogs, logical CSS
properties only, `style-src 'self'` and `script-src 'self'`, **no explanatory notes**.

What the owner asked for: the visitor and the host get the visit in their calendar, by the invitation in
the e-mail (the backend's half). The app's half is a way for the host to add the visit from the visit
page, and the host's new e-mails among the texts a company may change.

Each entry records what was built and every interpretation of, or deviation from, the contract.

---

## The host's calendar

**F14-1 — "Add to my calendar" / «أضف إلى تقويمي»: the kit's menu button, beside the visit's time.**
`features/visits/AddToCalendar.tsx`. A secondary button with the calendar-plus symbol opens the kit's
`Menu` (WAI-ARIA menu button: Enter, Space or Down open it on the first item, Up on the last, the arrows,
Home and End move, Escape and Tab close, the focus returns to the trigger) with three items:

- «تقويم Google» / "Google Calendar": Google Calendar's new-event form in a new tab (F14-4);
- «Outlook» / "Outlook": Outlook on the web's new-event form in a new tab (F14-4);
- «تقويم Apple وغيره (ملف ics)» / "Apple and others (.ics)": the event as a file (F14-6), for Apple
  Calendar, Outlook on the desktop and every other calendar.

The two links carry the external-link symbol, the file the download symbol: what each does is seen, not
explained. A screen reader hears that a link opens a new tab: its name is the visible words followed by
«(يُفتح في علامة تبويب جديدة)» / "(opens in a new tab)" (`aria-label`, beginning with the visible words, so
voice control finds it by what is shown). No other words: no note on what the file is or that the e-mail
already brings the visit.

Where it stands:

- **The visit page**: at the end of the sunken strip that shows the visit's time, at the top of "Visit
  details" (`VisitFactsCard`'s new `scheduleAction`): the action about the time stands by the time. On
  phones (below `sm`) it takes a row of its own under the time, full width, as the page's other actions
  there; its popup opens under it, aligned to its end.
- **The invitation's outcome** ("Visit scheduled"): in the row of what comes next, after "View visit",
  before "Invite another visitor" (full width on phones, as the other two). The host who just booked the
  visit adds it there without opening it. Shown as long as the visit is (F14-2); gone with a cancellation
  from the same page.

The kit's menu gained two things for it (F14-8). Checked open in both languages and both schemes at 1440,
820 and 390 px (`e2e/phase14-calendar.spec.ts`, and the screenshots below), and closed at 320 px too (the
accessibility spec's visit page, as its host).

**F14-2 — Offered to the visit's host, for a scheduled visit that has not ended.** `offersHostCalendar`:
the signed-in user is the visit's host, the visit is `SCHEDULED` (so not begun, not cancelled, not a
no-show) and not a walk-in, and its scheduled end is still ahead (`useNow`, refreshed each minute). Read
from the lead's brief, "for the host … the host's own event":

- **Not to an administrator, a receptionist or a manager** who opens someone else's visit: the event is
  the host's calendar object (its `UID` is the host's, F14-3), and "my calendar" would be the wrong one. An
  administrator who books for a host has the host told by e-mail (`HOST_VISIT_SCHEDULED`).
- **Not once the visitor is inside** (`CHECKED_IN`): the visit has begun; adding it then serves nothing.
- **Never for a walk-in** (the contract), which begins inside and is never scheduled.

**F14-3 — The same calendar object as the host's e-mail.** `features/visits/hostCalendar.ts` builds the
event from the visit on the page and the session's company:

- `UID` `visit-<visit id>-host` (backend `event_uid`), `SEQUENCE` the visit's `calendar_sequence`,
  `DTSTART` / `DTEND` the scheduled start and end in UTC, `PRODID` the backend's
  (`-//Visits//Visit calendar 1.0//EN`, naming neither the product nor a company). A file imported into a
  calendar that already has the e-mailed entry meets it instead of adding a second one, and the e-mails
  that follow (a new time: `REQUEST` with a higher `SEQUENCE`; a cancellation: `CANCEL`) move or remove
  what was imported.
- **The words are the backend's** (B14-3): `SUMMARY` «زيارة: {visitor}» / "Visit: {visitor}"; `LOCATION`
  the company's address in the UI's language (`address_ar` in Arabic, else `address`; `address` in English,
  else `address_ar`; `GET /auth/me`'s new `company.address` / `address_ar`), its lines joined by the
  language's comma («، » / ", ") and trimmed of a closing comma or semicolon (the backend's
  `one_line_address`); `DESCRIPTION` a "Label: value" line for the visitor, their company, the department
  (its Arabic name in Arabic when set), the purpose and «الحجز بواسطة» / "Booked by" when the visit was
  booked by someone other than the host, each only when it has a value. Names on one line, white space
  runs as one space (the backend's `one_line`).
- `HOST_EVENT_TEXTS` holds the catalog's words in both languages; `hostCalendar.test.ts` reads the
  backend's source (`app/email/i18n.py`, `service.py`'s `_host_event`, `calendar.py`), as
  `auditVocabulary.test.ts` does, and fails when the words, the order of the details, the `UID` or the
  `PRODID` differ there. The E2E suite compares the downloaded file with the e-mailed event, property by
  property, read by a real parser (F14-12).
- **In the UI's language.** The backend writes the host's event in the language that leads the host's
  e-mail: the host's preference, else the company's default. That is the language the app shows the host
  (`LanguageController`; a switch of the language is saved as the preference); a host who switches the app's language gets the event in the language the
  page is in, the one he reads.
- **`DTSTAMP` is when the visit last changed** (`visit.updated_at`): without `METHOD`, `DTSTAMP` is the
  event's last revision (RFC 5545 §3.8.7.2), and it makes the file a function of the visit alone (the same
  visit, the same bytes).

**F14-4 — The calendars' links.** Built from the same event (`googleCalendarUrl`, `outlookCalendarUrl`),
the text as a calendar holds it (`calendarText`: line breaks as line feeds, no control or direction
character), the description as HTML (F14-18), each value `encodeURIComponent`-encoded (a space is `%20`,
never `+`), empty values left out, the whole link at most 2,000 characters (F14-17):

- **Google Calendar**: `https://calendar.google.com/calendar/render?action=TEMPLATE` with `text`, `dates`
  (`20261021T070000Z/20261021T080000Z`, UTC), `details` and `location`. Google's long-standing template
  link; it opens the signed-in account's new-event form.
- **Outlook: the work and school deeplink** (`https://outlook.office.com/calendar/0/deeplink/compose?path=
  /calendar/action/compose&rru=addevent` with `subject`, `startdt` / `enddt` in UTC ISO 8601, `body` and
  `location`). The contract asked to pick between it and `outlook.live.com` (personal Microsoft accounts)
  and record why: the hosts are a company's people, whose Outlook calendars are Microsoft 365 accounts. A
  host with a personal Outlook.com calendar adds the file (F14-6); offering both would put two items named
  "Outlook" in front of everyone for a case that has its own way. The deeplink form on every device, as
  add-to-calendar-button sends it today (F14-18).
- Both open in a new tab with `rel="noopener noreferrer"`: the calendar's page cannot reach this one, and
  learns nothing of its address (the site's `Referrer-Policy: no-referrer` says the same).
- **A link cannot carry a `UID`**: the event a link creates is a new entry of its own, beside the one the
  host's e-mail may have added. The e-mail stays the way that follows the visit (a new time, a
  cancellation); the link is for a host who wants it now. Recorded under Open items, not explained on the
  page.

**F14-5 — No pass link and no token, anywhere** (B14-4). The visit page never has the pass link (it is
returned once, by the request that creates or re-sends it); on the invitation's outcome it is on screen,
but the event is built from the visit and the company only, and nothing in `hostCalendar.ts` reads a pass.
Unit tests (`hostCalendar.test.ts`, `InviteVisitorPage.test.tsx`, beside a real pass link on the page),
the mocked E2E spec and the flows spec (the pass token of the visit, in the links and in the file) hold
it.

**F14-6 — The file.** `hostCalendarFile` writes the event (F14-7) and `downloadTextFile` (`utils/
download.ts`) saves it: a `Blob` of type `text/calendar;charset=utf-8` (UTF-8, no byte order mark), an
object URL followed through a hidden `<a download>`, clicked inside the person's own click on the item
(no wait before it), the URL revoked 40 s later (as FileSaver.js waits). Its name is the visit's day in
the company's time zone, `visit-2026-10-21.ics`: nothing about the people (a downloads folder is often
shared or synchronised). Apple Calendar (macOS, and iOS Safari's "Add to Calendar"), Outlook on the
desktop and other calendars open it as an event to add.

*iPhone and iPad (the review, finding 9).* The reviewer expected a `blob:` address with `download` to go to
Files on iOS, and suggested opening the file in the same tab instead, as a `data:` address if that works.
What the sources say, and what this page does:

- **A `Blob` typed `text/calendar` opens the "Add to Calendar" sheet; an untyped one goes to Files.**
  tsml-ui (a widely used meeting finder) moved to exactly this file path in October 2026, a typed `Blob`, a
  temporary `<a download>` and `click()` in the tap's handler, "typed blob download opens the Add to
  Calendar sheet on iOS", after its untyped one was saved silently to Files › Downloads
  (code4recovery/tsml-ui issue 560 and PR 562). add-to-calendar-button 3 does the same on iOS: the `.ics`
  item is a real `<a>` whose address is a `blob:` URL of a `Blob` typed `text/calendar;charset=utf-8`,
  with `download`, in the same tab (`src/ui/ics-links.ts`; confirmed on an iPhone with iOS 27 in its issue
  834, which also found iPadOS needs the same path).
- **A `data:` address no longer works on iOS.** add-to-calendar-button 2 used one (`data:text/calendar…`,
  `target="_self"` on phones); its author confirmed in August 2026 that "iOS 26.6 (26.5 works) broke the
  ics file generation" and moved to the `blob:` address in version 3 (issue 823); tsml-ui saw its
  `location = 'data:text/calendar…'` stop with iOS 26.5 ("security updates that prevent data: navigations in
  Safari", issue 560). Safari already blocks other top-level navigations to `data:` (MDN browser-compat-data,
  `http/data-url.json`, `top_level_navigation_blocked`, Safari 14). The suggested change would have broken
  the file on current iPhones.
- So the file path stays as it was; the review made its conditions explicit (`download.ts`, its unit test
  `download.test.ts`): the type exactly `text/calendar;charset=utf-8`, the click synchronous in the item's
  click (the menu's fetch, F14-15, happens when it opens, never between the tap and the file), the same tab
  (no `target`), the address kept 40 s. Desktop and Android browsers download it, as before.
- Not done: add-to-calendar-button shows Chrome and Firefox on iOS, and in-app browsers, a dialog that says
  to open the page in Safari (those cannot open a generated file as an event). An explanatory dialog is
  what the owner does not want; recorded under Open items.

## The iCalendar writer

**F14-7 — By hand, in `utils/icalendar.ts`, to the backend's rules.** No dependency (the contract: "simple
enough to write by hand, with tests"):

- **Lines end with CRLF**, the last one too (RFC 5545 §3.1).
- **Folded at 75 octets**: a longer line is cut into lines of at most 75 octets, each continuation
  starting with one space that counts towards its 75. Octets of UTF-8, counted per code point, so a cut
  never falls inside a character: an Arabic letter's two octets, an emoji's four (and its two UTF-16
  units) stay together.
- **TEXT values** (§3.3.11): the backslash, the semicolon and the comma escaped, every line break (CRLF,
  CR, LF, U+2028, U+2029) written `\n`, a tab a space, and no C0 or C1 control or direction control (an
  embedding, override or isolate that a calendar's one-line views never close), exactly as the backend's
  `text_value`. Arabic is written as it is.
- **Times in UTC** (`…Z`, §3.3.5 form 2): no `VTIMEZONE` needed. A time the browser cannot read throws
  (`RangeError`); F14-19 keeps that from the page.
- **`SEQUENCE`** a whole number of zero or more; a missing or non-finite one is 0, never `NaN` (F14-19).
- **The person's own copy, not an invitation**: no `METHOD`, `ORGANIZER` or `ATTENDEE`. A `PUBLISH`
  message must name an organizer (RFC 5546 §3.2.1), and the browser does not know the sending address
  (`EMAIL_FROM`), nor should a host's own copy look like a meeting someone sent. `STATUS:CONFIRMED`,
  `TRANSP:OPAQUE` (busy), as the e-mailed event.
- The properties are written in the backend writer's order, which no reader needs but which makes the two
  easy to compare.

## The kit

**F14-8 — The menu: links out, and a popup as wide as its items.** `components/ui/Menu.tsx`:

- **An `href` item** (an address outside the app): a native `<a role="menuitem">` with `target="_blank"`
  and `rel="noopener noreferrer"`, named by its words and «(يُفتح في علامة تبويب جديدة)» / "(opens in a
  new tab)" (`common:actions.opensInNewTab`); choosing it closes the menu and returns the focus to the
  trigger, as after an action (the page stays). The items `to` (a page of the app) and `onSelect` (an
  action) are unchanged.
- **`fitContent`**: the popup takes its longest item's width (`w-max`) within its usual limits (at least
  14 rem, at most 20 rem and the screen's width less 1.5 rem), instead of the room its trigger leaves it.
  Found in the screenshots: beside the narrow trigger the popup was 14 rem and «تقويم Apple وغيره (ملف ics)»
  broke over two lines. Off by default: the other menus keep their behaviour.
- After the review (F14-20): `loadItems` (items made when the menu opens, the trigger busy meanwhile),
  `triggerIcon`, Space on a link item, and `href` typed `` `https://${string}` ``; after the verifier
  (F14-28): `controlRef` (a caller closes the menu), and repeated keydowns ignored.

## Not on the pass page

**F14-9 — No calendar control on `/pass`** (the lead's decision, B14-12). The page is static by design
(D-20): it holds only the token, and knows nothing of the visit. Visitors invited by e-mail get the
calendar invitation (`VISITOR_CALENDAR`); a visitor whose pass the host shares himself is not covered.
Nothing on the page changed.

## The e-mail texts

**F14-10 — The host's three e-mails, first-class wherever the other kinds are.** `HOST_VISIT_SCHEDULED`,
`HOST_VISIT_RESCHEDULED` and `HOST_VISIT_CANCELLED` (B14-2):

- **The type and the list of kinds**: `EmailTemplateKind` (`types/api.ts`) and `EMAIL_TEMPLATE_KINDS`
  (`emailTemplateForm.ts`; an address with another kind is "Email not found"); `templateRecipient` says
  "host" for every `HOST_…` kind.
- **Names** (`admin:emailTemplates.kinds`, and the same words for the audit log's values, where an
  `EMAIL_TEMPLATE_*` event names its kind): «زيارة جديدة (المضيف)» / "New visit (host)", «تغيير موعد
  الزيارة (المضيف)» / "Visit rescheduled (host)", «إلغاء الزيارة (المضيف)» / "Visit cancelled (host)". The
  visitor's two e-mails of a new time and a cancellation are «تغيير موعد الزيارة» / "Visit rescheduled"
  and «إلغاء الزيارة» / "Visit cancelled": the host's need names of their own, or a list (and a screen
  reader's list of links) would hold two links of one name to two editors. The words in parentheses are
  the shortest that tell them apart.
- **Descriptions**: the list and the editor's header say whom each e-mail goes to, «إلى المضيف» / "To the
  host", as for every kind. The brief's "descriptions" were read as this line: nothing more is written
  about a kind (no explanatory notes).
- **Icons** (decorative): the new visit the calendar with a plus; a new time and a cancellation the same
  icons as the visitor's (a clock, a cross): the icon says what happened, the name and the line whom it
  tells.
- **Fields, variables, defaults, rules**: all from the API, as for the other kinds (subject, heading,
  greeting, opening paragraph, closing paragraph, footer line; no button). The subject must hold
  `{visitor_name}` and may not hold `{purpose}`; the department is among the variables; the defaults are
  the API's `default`. The previews (the draft's, and the saved e-mail in Light and Dark) and the test go
  through the same components; the backend sends a test without an event (B14-14).
- **The platform owner's editor** of a company's texts is the same list and editor (`EmailTemplatesSource`,
  Phase 12): it shows the seven kinds too.
- `VISITOR_CALENDAR` is not editable (B14-2, B14-10) and appears nowhere in the app.

## Types and catalogs

**F14-11 — The contract.** `Visit.calendar_sequence: number` (so `InsideVisit` too), `Me.company.address`
and `address_ar` (`string | null`, the backend's `MeCompany`), and the three kinds. The backend regenerated
`types/backend-contract.json`; `api.contract.test.ts` passes unchanged. Every typed fixture and mocked
response that builds a `Visit` or a `Me` has the new fields (`test/fixtures.ts`, `test/api.ts`,
`e2e/support/mock-company.ts` and the mocked layout specs).

**F14-12 — The calendars' names in Arabic.** «تقويم Google», «Outlook», «تقويم Apple وغيره (ملف ics)»: a
product's name stays as its maker writes it, as Arabic interfaces write these. `i18n/catalogs.test.ts`
allowed only `UTC` and `QR` among Latin words in the Arabic catalogs; it now allows `Google`, `Outlook`,
`Apple` and `ics` too, and nothing else. The Arabic file label was checked in the screenshots for its
direction: the brackets pair around «ملف ics» and read right to left.

## After the review (2026-10-19)

An independent review of this phase's frontend reported two medium and seven low findings (its probes in
the session scratchpad's `review14f/`). The lead decided each; this is what was built.

**F14-15 — Written from the visit as it is when the menu opens** (finding 1, medium). The page's copy of
the visit is up to 30 s old (`staleTime`) and is not polled once the e-mails are sent: a new time or a
cancellation made elsewhere (another tab, an administrator, the API) would have gone into the calendar
with the old times and the old `SEQUENCE`, or added back a cancelled visit. Now:

- Opening the menu fetches the visit again (`fetchVisitNow` in `useVisitDetail.ts`: `fetchQuery` on the
  page's own query key with `staleTime: 0`), so the page's copy is updated by the same request. Meanwhile
  the trigger shows the kit's loading state (the spinner in place of its icon, `aria-busy` and
  `aria-disabled` while it keeps the focus, as the loading `Button`).
- The menu opens on items written from that visit, and only when it still qualifies (`offersHostCalendar`
  on it, at that moment): the links and the file come from the same fresh visit.
- **No longer qualifies** (cancelled, begun, ended, another host's): nothing opens. The control goes at
  once (and the page, its copy refreshed, drops it and shows why: the cancellation's banner, the new
  status); the focus, when it was on the trigger, goes on from the page's heading, as after a
  cancellation from the page.
- **A failure**: the kit's error toast («تعذّر تحميل الزيارة» / "The visit could not be loaded", with the
  error's own message), and nothing opens; the page keeps the visit it shows. A 404 or 403 also empties the
  page's copy (the existing `forgetRefusedData`), and the page shows its "not found" or "no access" state.
- A load overtaken by Escape, a click outside or the focus leaving the trigger opens nothing (F14-20).
- Tests: `VisitDetailPage.test.tsx` (a new time made since: the links, the file and the page; the loading
  state; cancelled, ended, begun and another host's: nothing opens, the control goes, the heading has the
  focus; the error toast), `InviteVisitorPage.test.tsx` (a visit cancelled elsewhere: the outcome turns to
  "Visit cancelled", its title focused), `Menu.test.tsx`, the mocked E2E (the loading state, a new time,
  a cancellation) and the flows spec (the page left open over a real new time and a real cancellation).

**F14-16 — A visitor's name goes into the summary as it is** (finding 3). `"Visit: {visitor}".replace(
'{visitor}', name)` read `$&`, `$$`, `` $` `` and `$'` in the name as replacement patterns (`A$&B` became
`Visit: A{visitor}B`). The name now goes in by a function. The whole frontend (`src`, `e2e`, `scripts`,
`config`) was searched for `.replace(` and `.replaceAll(` whose replacement is not a plain literal: the
other two are a constant (`datetime.ts`'s no-break space) and the acceptance spec's deliberate `'\\$&'` in
a regular-expression escape. Test: `$&`, `$$`, `` $` ``, `$'` and `$1` in both languages.

**F14-17 — The links at most 2,000 characters** (finding 4). A visit's texts may be long (a name, company
and booker of 200 letters, a department of 120, a purpose of 500, an address of 1,000): in Arabic, six
characters a letter once encoded, about 15,000 characters a link. `fittedLink` measures the link as
written and, while it is longer than `MAX_LINK_LENGTH` (2,000), cuts the description, then the location,
then the summary, each to its longest beginning that fits (found by halving), between code points (half a
surrogate pair cannot be encoded: `encodeURIComponent` throws, add-to-calendar-button issue 692), ended
with «…»; a text none of which fits is left out. Cut before the description is made HTML (F14-18), so an
entity is never cut. The `.ics` file carries everything. Why 2,000:

- A signed-out person goes through the calendar's sign-in, which carries the whole link again. A probe
  (this session, 2026-10-19, the scratchpad's `fix14f/scripts/probe3.py`): `calendar.google.com` itself took
  links up to about 16,300 characters, but Google's sign-in, where it sends a signed-out person with the link
  inside (about three times as long once encoded again), refused an Arabic-heavy link from about 5,500
  (5,000 worked) and an ASCII one between 8,000 and 12,000. Microsoft's sign-in was not measurable from a
  script (Outlook answers 417 to one).
- Servers commonly refuse a request line over 8 KB (Apache's `LimitRequestLine` 8,190; nginx's
  `large_client_header_buffers` 8k), and RFC 9110 §4.1 asks only for 8,000 octets.
- The add-to-calendar docs (InteractionDesignFoundation/add-event-to-calendar-docs, `services/
  outlook-web.md`, checked 2026-08-19) measured Outlook on the web up to about 31,000 characters but advise
  links "under a couple of thousand".
- 2,000 stays under all of them, with the sign-in's tripling, and keeps an ordinary visit whole (a typical
  Arabic visit is about 1,100). add-to-calendar-button and calendar-link do not cut; The Events Calendar
  (WordPress) cuts its description at 996 characters "so we don't exceed the browser's URL limits".
- Tests: the longest Arabic visit (each link at most 2,000 and within 60 of it, the description cut with
  «…», the summary and location whole, the file whole); a 1,000-letter address (the description left out,
  the address cut, the summary whole); an emoji at every cut position; a short visit never cut.

**F14-18 — What the links carry, as add-to-calendar-button sends it** (finding 2). The reviewer compared
add-to-calendar-button 2.6.21; its current version is 3.4.3 (rewritten, `src/generators/*.ts`), and the
practice changed in between:

- **The description is HTML in both links**: `&`, `<`, `>` and `"` escaped, then each line break a `<br>`
  (`htmlText`). Outlook's `body` is HTML ("HTML is accepted and rendered", the add-to-calendar docs'
  `outlook-web.md`) and drops bare line feeds (Microsoft Q&A 4573601); Google's `details` takes HTML too
  (the docs' `google.md`). add-to-calendar-button sends both as HTML with `<br>` (version 3:
  `generators/google.ts`, `generators/outlook.ts`, `core/decorate-dates.ts`); it strips tags from its own
  input, where the visit's words are escaped here, so a `<` or `&` in a purpose reads as written. Both forms
  use the same text, so the two calendars show the same lines. *Not verified in a real account*: that
  Google and Outlook show `&amp;` as `&` follows from their reading HTML, but no source tests it (Open items).
- **The subject (Outlook) and the title (Google) stay plain text**, their `&` as `%26`. The lead's brief
  asked to neutralise `&` in Outlook's subject as 2.6.21 does (`&#xFF06;`). That was a workaround for an
  Outlook bug that showed `&` as `&amp;` in the subject (add-to-calendar-button issue 529, December 2023);
  Microsoft fixed it, and the library removed the workaround in 2.9.0 ("Microsoft365 no longer appears to
  require this workaround", PR 700, confirmed for Outlook.com by its author, May 2025). Following it now
  would put a full-width «＆» or the reference itself into the host's calendar, so the current practice is
  followed. A Microsoft MVP found `%26` read right in the location and body all along (Microsoft Q&A 860833).
- **The location is plain text** in both.
- **Outlook's path: the deeplink form on every device** (`/calendar/0/deeplink/compose?path=/calendar/
  action/compose&rru=addevent`, as before). The brief asked to consider 2.6.21's `/calendar/action/compose?
  rru=addevent` for desktops. Its history: 2.2.8 moved desktops to it when Microsoft's deeplink hung
  (issue 386, May 2023); 2.9.0 had to change it to `/calendar/0/action/compose` because Outlook's redirect
  encoded its fields twice (`%2520`, issue 702); 3.0 went back to the deeplink form on every device, where
  3.4.3 still is. The add-to-calendar docs found in August 2026 that the deeplink form works with or without
  `/0`, and that `/calendar/action/compose` without `path` lands on the week view with no form (discussion
  47). spatie/calendar-links (May 2026) also sends the deeplink form. Microsoft's move of Outlook on the web
  to `outlook.cloud.microsoft` keeps the old addresses working (message center MC1188995).
- Tests (`hostCalendar.test.ts`): a description of several lines with `&`, `<`, `>`, `"`, a tag and Arabic,
  in both links (no `%0A` left), the subject and title plain, no `FF06`, the file's plain text; the flows
  spec compares both links with the e-mailed event's description made HTML the same way.

**F14-19 — Nothing is written while the page renders; `SEQUENCE` never `NaN`** (finding 5). The event,
the links and the file are written when the menu opens (F14-15), inside its error handling: a time the
browser cannot read (`formatUtc` and the links' `iso` throw `RangeError`) shows the error toast and opens
nothing, and the page renders as before. Before, the links were written in the page's render, where a
bad `scheduled_start` would have taken the page down. `writeCalendar` writes `SEQUENCE` as
`Number.isFinite(sequence) ? Math.max(0, Math.trunc(sequence)) : 0`. Tests: `icalendar.test.ts` (`NaN`,
±`Infinity`, `undefined`, `null` → 0; 2.9 → 2), `VisitDetailPage.test.tsx` (a visit whose `updated_at`
cannot be read: the toast, no menu, the page whole).

**F14-20 — The kit's menu** (findings 7 and 10, and F14-15's loading). `components/ui/Menu.tsx`:

- **`loadItems`** (instead of `items`): the items, made when the menu is opened. Meanwhile the trigger is
  busy (`aria-busy`, `aria-disabled`, the kit's spinner in place of `triggerIcon`), keeps the focus and
  ignores another activation; the menu opens on what comes back, on its first or last item as asked
  (Enter, Space, Down; Up). Null, or a failure (the caller shows it), opens nothing; so does a load
  overtaken by Escape on the trigger, a click outside or the focus leaving the trigger (each opening and
  each closing takes a new number; a load that comes back with an old one is dropped).
- **`triggerIcon`**: the trigger's leading icon, as the `Button`'s `icon`, for the spinner to take its
  place.
- **Space on a link item** (`to`, `href`) chooses it, as it does a button item (WAI-ARIA menu pattern): it
  is clicked when Space comes up on it, as a button is, and only by a press that began on it, so the Space
  that opened the menu from the trigger on a link does not choose it. Before, Space did nothing there (and
  would have scrolled the page).
- **`href` is typed `` `https://${string}` ``**: a `javascript:` or `data:` address cannot be put in a menu
  that opens it in a new tab. `googleCalendarUrl` and `outlookCalendarUrl` return that type.
- Tests (`Menu.test.tsx`): Space on a link and on a page item, not by the opening Space; the loading state,
  a second press, opening on the last loaded item; null, a failure, Escape, a click outside and Tab.

**F14-21 — The invitation's outcome row wraps** (finding 8). "View visit", "Add to my calendar" and
"Invite another visitor" never wrap their words; from `sm` they were one `flex` row, which at 640 to 720 px
with the text at 20 px is wider than the content. The row is `sm:flex-wrap` (its `gap-2` spaces the lines
too). Checked with a probe (session scratchpad `fix14f/probe/`, the API mocked, `html { font-size: 20px }`):
in English at 640, 680 and 720 px the third button goes to a second line, at 760 px one line; in Arabic one
line at every width; no sideways scroll and no button outside the row anywhere.

**F14-22 — The file on iPhone and iPad** (finding 9): kept as it was, its conditions made explicit; the
research and the sources are under F14-6.

**F14-23 — The calendar files' lines read as octets** (finding 6). `e2e/support/icalendar.ts`'s
`lineProblems` took text read as UTF-8, where a character cut in two by a fold had already become U+FFFD and
could not be seen. It now takes the file's octets (`calendarBytes` in `e2e/support/outbox.ts`, the
download's `readFileSync` without an encoding), splits them at CRLF octets, and decodes each line with a
fatal `TextDecoder`; a bare CR or LF anywhere, the first and last octet included, is found too. Checked
with a probe (a fold inside «ز»: both halves reported; the same octets read as text showed none).

**F14-24 — A cancellation always tells a visitor who has the visit in their calendar** (the owner's
decision, given with the review's fixes). A visitor who was sent the visit's calendar invitation is always
sent the cancellation (`VISIT_CANCELLED`, with the event's `CANCEL`), whatever `notify_visitor` says, so
the visit always leaves their calendar (the backend's half). The `Visit` response says so in a new boolean,
`visitor_calendar_sent` (on `InsideVisit` too; confirmed by the lead with the backend's final API).

- The cancel dialog (`CancelVisitDialog`, also the invitation outcome's) offers «إبلاغ الزائر بالبريد
  الإلكتروني» / "Notify the visitor by email" only when the server would follow the choice: the visitor
  can be e-mailed (`cancelEmailsVisitor`, as before) and was not sent the calendar invitation
  (`cancelAlwaysEmailsVisitor`). When they were, the dialog shows neither the box nor any words about it
  (no explanatory text), and asks with `notify_visitor: true`, which is what happens.
- «لن يُبلَّغ الزائر بالبريد الإلكتروني.» / "The visitor will not be emailed." is shown only when no
  e-mail can go out and the visitor was not sent the calendar invitation: never a promise the server would
  break.
- The confirmation stays the response's (`cancelledMessage`): «جارٍ إبلاغ الزائر بالبريد الإلكتروني.» /
  "The visitor is being notified by email." when the response's latest notice is the cancellation e-mail,
  else «لم يُبلَّغ الزائر.» / "The visitor was not notified."
- The type (`Visit.visitor_calendar_sent`, so `InsideVisit` too) and every typed fixture and mocked visit
  (`test/fixtures.ts`, `e2e/support/mock-company.ts`, four mocked layout specs) have it; the backend
  regenerated `types/backend-contract.json`, and `api.contract.test.ts` passes.
- Tests: `visitEdit.test.ts` (`cancelAlwaysEmailsVisitor`; no line for such a visitor, also with no address
  on file now), `VisitDetailPage.test.tsx` (no box and no words about e-mail, `notify_visitor: true`, "The
  visitor is being notified by email."; with no address now, the response's "The visitor was not
  notified."), and `flows/pass-outcomes.spec.ts` (a host cancelling an invited visit in the UI: no box,
  the confirmation, the `VISIT_CANCELLED` e-mail), and `flows/calendar.spec.ts` (F14-26).

**F14-25 — Words for the backend's two new e-mail budgets** (found by `auditVocabulary.test.ts`, which
reads the backend's source, while the backend's fixes were under way: B14-15). A refused e-mail's audit
event names its budget; the two new ones are worded as their neighbours (`admin:audit.values`):
`host_visit_notices_per_user_day` «رسائل زيارات المضيفين اليومية» / "Host visit emails per day", and
`calendar_emails_per_company_day` «رسائل التقويم اليومية لكل شركة» / "Calendar emails per company per day"
(the names are final). The backend's final API added three audit metadata keys, labelled the same way
(`admin:audit.metadataKeys`): `calendar_sent` (on `INVITATION_QUEUED` and `VISIT_RESCHEDULED`) «أُرسل حدث
التقويم» / "Calendar event sent", `host_calendar_sent` «أُرسل حدث تقويم المضيف» / "Host calendar event sent",
and `host_notice_limited_by` (on `VISIT_CREATED`, `VISIT_RESCHEDULED` and `VISIT_CANCELLED`, a budget's name
or nothing) «الحدّ الذي قيّد إشعار المضيف» / "Host notice limited by", as `notice_limited_by` «الحدّ الذي قيّد
الإشعار» / "Notice limited by" is. Their values are the budgets' words above, and `auditVocabulary.test.ts`
holds them all. A limited-by of `calendar_emails_per_company_day` beside a `…_notified` of yes means the
notice went without its event, so the Arabic words of both limited-by keys no longer say "not sent"
(«لم يُرسل … بسبب») but "the limit that restricted the notice", true either way; "Calendar event sent" says
what it says on an invitation and on a new time alike (on a new time the event is the update, not an
invitation).

**F14-26 — The E2E suite and the backend's final e-mails.** What the backend's fixes changed in the outbox:

- **`VISITOR_CALENDAR` may now carry a `CANCEL`**: the withdrawal of the visitor's event from an address the
  visitor no longer has (D-19, B14-17). `e2e/support/outbox.ts` says so, and every spec that waits for the
  visitor's calendar invitation asks for `calendar.method` `REQUEST`.
- **A cancellation reaches the visitor who has the visit in their calendar whatever `notify_visitor`
  says** (F14-24): `flows/calendar.spec.ts` now cancels with `notify_visitor: false` and still finds
  `VISIT_CANCELLED` (`CANCEL`, `SEQUENCE` 2) before `HOST_VISIT_CANCELLED`; `flows/pass-outcomes.spec.ts`
  cancels in the UI, where there is no box to clear.
- **A new address** (new test in `flows/calendar.spec.ts`, through the API): the old address is sent the
  withdrawal (`CANCEL`, `SEQUENCE` N + 1 = 1, read by the parser, no pass and no name in it), before the new
  address's invitation and its calendar invitation (`REQUEST`, N + 2 = 2, as the backend's final API has
  it); the visit then says `calendar_sequence` 2 and `visitor_calendar_sent` true. A removed address is sent
  only the withdrawal (`SEQUENCE` 3), and the visit says `visitor_calendar_sent` false.
- The E2E backend runs with `CALENDAR_INVITATIONS_ENABLED=true` set in `e2e/support/env.ts` (the default;
  only the production template sets it false), so a developer's `.env` cannot turn off what it checks.
- The rest (a host's deactivation tells the host of each cancelled visit, a new time past the visit's
  reschedule budget still tells the host, an invitation shown `FAILED` when its calendar invitation
  failed, Resend's attachment type) changes no count or order a spec reads: every helper picks messages by
  kind and recipient.

**F14-27 — A calendar invitation that did not arrive is said to be that** (the lead's answer to the
question F14-26 left: `VisitInvitation.calendar_failed`, B14-18). The invitation of a visit shows FAILED
when the calendar invitation that followed its latest invitation failed while the invitation itself went
out or is on its way; `calendar_failed` then says so, and `to_email`, `attempts`, `last_attempt_at` and
`error` are the calendar invitation's. The visitor has the pass; only the event is missing. So wherever
the FAILED state is worded, that case has its own words (`calendarInvitationFailed` in `invitationText.ts`):

- **The failure's title** (the visit page's banner, the invitation outcome's alert): «لم تصل دعوة التقويم إلى
  {{email}}» / "The calendar invitation did not reach {{email}}" (without an address «لم تصل دعوة التقويم» /
  "Calendar invitation not delivered"), instead of "Invitation not delivered to …".
- **The status line and the invitation card's summary**: «لم تصل دعوة التقويم إلى {{recipient}}.» / "The
  calendar invitation did not reach {{recipient}}."
- **The badges** (`StatusBadge`'s new `calendarFailed`, with a calendar-and-cross icon): on their own (the
  visit page's header, the lists on phones) the lead's «لم تصل دعوة التقويم» / "Calendar invitation not
  delivered"; under an "Invitation" heading (the invitation card, the lists' Invitation column) «لم يصل
  التقويم» / "Calendar failed", short as "Failed" beside it is (the lead accepted it). The lists' Invitation
  column, fixed from 1280 px, is now 160 px (`xl:w-40`, as the Status column): at 144 px a probe found
  "Calendar failed" cut by 13 px and «لم يصل التقويم» by 8 px. Checked again with the probe (the session
  scratchpad's `fix14f/probe/specs/calendar-badge.spec.ts`, the API mocked): no badge cut on the Needs
  attention list or the visit page at 1440, 1280, 1024, 820, 390 and 320 px, in English and Arabic, also
  with the Host column shown at 1280 and 1440 px, and no sideways scroll.
- **The timeline**: «لم تصل دعوة التقويم» / "Calendar invitation not delivered", at the calendar
  invitation's attempt.
- **The resend dialog**: its line is the same sentence; the resend is offered as before and its label stays
  ("Resend invitation": a resend sends both e-mails again).
- **No address correction** for this case (`wantsVisitorCorrection`, the outcome's `useCorrectableVisitor`,
  the resend dialog): the invitation reached that same address, so «تصحيح البريد وإعادة الإرسال» / "Correct
  email and resend" would suggest a wrong address that is not; the page no longer loads the visitor for it.
- **The pass link is not the only channel** (`passIsOnlyChannel`): the invitation e-mail carries the pass, so
  on the invitation's outcome "View visit" stays the primary action, not "Copy link".
- The Needs attention list (the lists' badges), the visit page and the outcome are where the state shows; no
  toast and no dashboard count words it. No other note.
- The type (`Visit.invitation.calendar_failed`, so `InsideVisit` too), the fixtures (`test/fixtures.ts`) and
  every mocked visit of the E2E suite (`mock-company.ts`, five mocked specs) have it.
- Tests: `invitationText.test.ts` (the helper, only in FAILED; the title with and without an address, the
  status line and the summary, in English and Arabic; not the only channel), `visitDetailModel.test.ts`
  (no correction, the banner still), `visitTimeline.test.ts`, `StatusBadge.test.tsx` (short, long, the icon,
  only for FAILED), `VisitDetailPage.test.tsx` (header, banner, card, timeline, one resend, no visitor
  loaded, the dialog's description, the resend), `InviteVisitorPage.test.tsx` (the alert, no correction,
  "View visit" primary) and `MyVisitsPage.test.tsx` (the Needs attention row beside a failed invitation's).
- Not covered: a host on the invitation's outcome sees "Invitation sent to …" once the invitation is sent
  and polling stops; a calendar invitation failing a few seconds later shows from the next load of the
  visit (the Needs attention list, the visit page), since nothing in the API says a calendar invitation is
  still on its way.

### The verifier's round (2026-10-20)

An independent verifier checked the review's fixes (its probes, a mutation harness and logs in the session
scratchpad's `verify14f/`): 13 of 14 held. What it found, and what was done:

**F14-28 — "Add to my calendar" stays true to the visit while it is open, offline and on a refused visit.**

- **A visit that changes while the menu is open closes it** (its probe: the page at the new time, the
  menu's links still at the old dates with `SEQUENCE` 0). `AddToCalendar` keeps the version its items were
  written from (`updated_at` and `calendar_sequence`) and listens to the page's copy of the visit in the
  query cache: a copy of another version closes the menu, through the kit's new `controlRef`
  (`MenuControl.close`), and the focus it had goes back to the trigger. Opened again, the menu fetches the
  visit and says the new time. A refetch that finds the same version keeps it open. Closing was chosen
  over rewriting the open menu in place: the link under the pointer never changes under it.
- **A request of the page already on its way is replaced** (its probe: a poll that left before the change
  answered the menu with the old visit): `fetchVisitNow` cancels it (`cancelQueries`, that query only) and
  asks again.
- **Offline, the request fails at once** (its probe: the trigger busy for ever, the query paused until the
  connection came back, when the menu would have opened by itself): `networkMode: 'always'` and no retry
  for this request, so the kit's error toast says so now, and nothing opens later.
- **A 404 or 403 on the menu's request** turns the visit page to "Visit not found" or "No access to this
  visit" and drops the control under the focus (its probe: the focus on `<body>`). The control knows
  whether it holds the focus (its trigger or its menu); dropped while it does, the focus goes on from the
  page's heading, which is then that state's. The same covers a visit cancelled or begun while its menu is
  open, which the page drops.
- **No toast after leaving**: a request that fails once the control has left the page shows nothing; the
  page then shown is about something else.
- **A held key chooses nothing** (its probe: a held Space, repeated by the OS, chose the first item). The
  kit's menu ignores repeated keydowns of Enter and Space, on the trigger and in the menu (`event.repeat`):
  the repeats of the press that opened the menu reach its first item, where Enter would follow a link on
  its keydown and a button would take a repeated Space as a press. A press of its own still chooses.
- Tests: `VisitDetailPage.test.tsx` (a new time while open: closed, the focus on the trigger, the new time
  when opened again; the same version: still open; a request on its way: asked again; offline: the toast
  at once, nothing opens later; a 404 and a 403: the state's heading has the focus), `AddToCalendar.test.tsx`
  (no toast after leaving), `Menu.test.tsx` (a held Space and a held Enter on a link and a button item; a
  press of its own; `controlRef` closing an open menu and stopping a load).

**F14-29 — The visit page's file is private, as the host's e-mailed event** (the backend verifier's parity
finding). The host's event carries `CLASS:PRIVATE` (B14-19: a colleague who sees the host's calendar sees
the time taken, not the visitor); the file of "Add to my calendar" now does too (`CalendarEvent.private`,
written before `STATUS`, as the backend's writer does). **Google's and Outlook's links cannot carry it**:
neither form has a parameter for it, so an entry made by a link is as the host's calendar makes new
entries (the host can mark it private there). Tests: `icalendar.test.ts`, `hostCalendar.test.ts` (the
event, the file, and `private=True` read from the backend's `_host_event`), the mocked E2E (the file's
`CLASS:PRIVATE` before `STATUS`), and the flows spec (the parser reads `CLASS`: the visitor's event none,
the host's `PRIVATE`, and the page's file equal to the e-mailed one).

**F14-30 — A link is cut between characters as a reader sees them** (its probe: a cut inside a family
emoji joined by ZWJ, a flag, a skin tone, a keycap, an Arabic letter and its vowel mark). The cut of F14-17
now walks the grapheme clusters (`Intl.Segmenter`, granularity `grapheme`; code points where it is
missing). Tests (`hostCalendar.test.ts`): for each of six kinds of cluster, a lead of 0 to 15 characters
moves the cut across every code point of the clusters after it, and each cut, in both links, ends where a
cluster of the description ends; without `Intl.Segmenter`, a cut never leaves half a surrogate pair.

**F14-31 — The breaks the verifier's mutations showed no test would catch**, each now caught (checked with
the same mutations, the session scratchpad's `fix14f/mutate/`):

- the invitation outcome's `sm:flex-wrap` (`InviteVisitorPage.test.tsx`, and a mocked E2E at 640, 680 and
  720 px with the text at 20 px: no button outside the row, no sideways scroll);
- the 160 px Invitation column (`MyVisitsPage.test.tsx`, and a mocked E2E at 1280 and 1440 px in both
  languages: the chip's words never cut). The verifier's own mutation of it changed the Status column
  (the first `xl:w-40` in the file), not this one;
- the company identity card's logo plate, in the dark scheme only (`CompanyIdentityCard.test.tsx`);
- `Menu`'s `href` type (`components/ui/Menu.typetest.ts`, checked by `tsc -b`: a script's or data address,
  plain HTTP, any string and a concatenation are each an expected error);
- the E2E suite's `lineProblems` (`config/e2eCalendarLines.test.ts`: a fold inside a letter and inside an
  emoji, the same octets read as text, an overlong form, an encoded surrogate, a long line, every bad line
  end, a view into a larger buffer).

**F14-32 — A calendar invitation sent again alone** (the backend's final API, B14-31). When only the
calendar invitation had failed (`invitation.calendar_failed`), `POST /visits/{id}/invitation` sends that one
alone, the same version with a new `DTSTAMP`: no new pass, no invitation e-mail, and its new result
`VisitResendResult` has `pass_url` null (`types/api.ts`; a full resend is as before, a new pass and both
e-mails, `pass_url` set). So:

- the failure's button and the dialog are about the calendar invitation: «إعادة إرسال دعوة التقويم» /
  "Resend calendar invitation", «إرسال دعوة التقويم مرة أخرى؟» / "Send the calendar invitation again?", its
  line «لم تصل دعوة التقويم إلى …» / "The calendar invitation did not reach …", and **no word of a new pass or
  QR code** (the warning is not shown, and the dialog is described by its line alone); its other button is
  «ليس الآن» / "Not now" (nothing is kept or replaced; the dialog's own "Close" is beside it);
- on success no new pass is shown (the visit page's panel, the outcome's replaced link and its "The visitor
  pass was replaced"): the handlers show one only for a `pass_url`; a toast says «جارٍ إرسال دعوة التقويم
  إلى …» / "Sending the calendar invitation to …", the failure's banner goes, and its focus goes on from the
  page's heading (on the visit page and the outcome alike, as whenever a failure's banner goes while it holds
  the focus);
- spent invitation budget: 429 `INVITATION_LIMIT` in the dialog, as for any resend, nothing sent.

Tests: `VisitDetailPage.test.tsx` (the button, the dialog's title, description and buttons, no new pass, the
toast, the banner gone and the heading focused; the 429 in the dialog) and `InviteVisitorPage.test.tsx` (the
same from the outcome, the pass link on screen kept, no "replaced").

**Calendar e-mails switched off at first.** Production starts with the calendar e-mails off
(`CALENDAR_INVITATIONS_ENABLED=false` in its deploy template): no visitor calendar invitations and no host
notices until the owner's mailbox and DNS are ready. Nothing in the app assumes they arrive:
`visitor_calendar_sent` is then false (the cancel dialog offers its choice as before), `calendar_failed`
never true, and "Add to my calendar" is the browser's own.

## Tests

**F14-13 — Unit (Vitest).** As first built; the review's tests are listed under F14-15 … F14-24.

- `utils/icalendar.test.ts` (new): UTC times from any offset; escaping (backslash first, the four line
  breaks and the two separators, tab, C0/C1 and direction controls dropped, Arabic and colons kept, undone by
  an RFC 5545 reader); folding (a 75-octet line kept, longer ones into lines of at most 75 octets with a
  leading space, Arabic cut between letters only with each physical line valid UTF-8 on its own and filled,
  a four-octet character whole); the object (CRLF everywhere and no bare line feed, the properties in
  order, read back to the same values, no `METHOD`/`ORGANIZER`/`ATTENDEE`, empty description and location
  left out, a whole non-negative `SEQUENCE`, an Arabic event folded and read back).
- `features/visits/hostCalendar.test.ts` (new): the English and Arabic event (summary, location from a
  multi-line address, description, department's Arabic name), "Booked by" and missing values, the same
  `UID` with a higher `SEQUENCE` after a new time, the file's name, the location's language fallbacks,
  when it is offered (host only; not begun, ended, cancelled, no-show, walk-in), Google's and Outlook's
  links (every parameter, `%20`, Arabic), no pass token or `/pass` in links or file, and the backend's
  catalog, details order, `UID` and `PRODID` read from its source.
- `pages/VisitDetailPage.test.tsx`: the menu in the schedule's card (items, names with "(opens in a new
  tab)", the first item focused, the links, the download's name, type and content, the focus back on the
  trigger), the keyboard (Enter, Up, Escape), the Arabic event and labels, and not offered for a cancelled,
  checked-in, ended or walk-in visit or another host's visit seen by an administrator.
- `pages/InviteVisitorPage.test.tsx`: the menu after "View visit" on the outcome, never the pass token in
  its links or file; not offered when an administrator invites for another host.
- `components/ui/Menu.test.tsx`: an `href` item (an anchor, a new tab without opener or referrer, its
  name, the focus back on the trigger) and `fitContent`.
- The e-mail texts: the seven kinds in the administrator's and the platform owner's lists (names, "To the
  host", links), each host kind's editor (title, recipient, no button field, the subject's rules and
  chips, the department, the preview, the test), `isEmailTemplateKind` and `templateRecipient`
  (`VISITOR_CALENDAR` is not a kind). The fixtures make the host kinds with their own texts and variables.

**F14-14 — End-to-end (Playwright).** As first built; the review's are listed under F14-15 … F14-24.

- `e2e/flows/calendar.spec.ts` (new, the real API and outbox): a visit created with an invitation sends the
  visitor `VISITOR_INVITATION` without an event and `VISITOR_CALENDAR` with `REQUEST`, `visit-<id>-visitor`,
  0 (no link, no QR code, no token), and the host `HOST_VISIT_SCHEDULED` with `REQUEST`,
  `visit-<id>-host`, 0; every `.ics` has CRLF lines of at most 75 octets, no token, and is read by the
  backend's `icalendar` (`e2e/support/icalendar.ts`, the backend virtual environment's test dependency,
  isolated mode) to the method, `UID` and `SEQUENCE` of its message's JSON. The visit page's links are
  well formed (every parameter compared with the e-mailed event) and its downloaded file, parsed, **is the
  e-mailed event** but for `METHOD`, `ORGANIZER` and `ATTENDEE`. A new time sends `VISIT_RESCHEDULED` and
  `HOST_VISIT_RESCHEDULED` with `REQUEST` and `SEQUENCE` 1 and the new times, and the page's file follows;
  a cancellation sends `VISIT_CANCELLED` and `HOST_VISIT_CANCELLED` with `CANCEL`, 2 and
  `STATUS:CANCELLED`, and the page offers nothing. A pass the host shares sends the visitor nothing and the
  host his event. The host kinds in the e-mail texts: seven rows, each host kind's editor (placeholder from
  the API's default, no button field, the subject's two rules, the draft's preview, the saved preview in
  Light and Dark, a test with no event and no `.ics`), reset afterwards; the platform owner's list of the
  same company and one editor.
- `e2e/phase14-calendar.spec.ts` (new, API mocked, at 1440, 820 and 390 px): in Arabic and English, Light
  and Dark: the trigger at the end of the strip (on phones a row of its own), at least 44 px, opened from
  the keyboard on its first item, the items' words and names, the popup inside the screen, items at least
  40 px, no serious axe finding with the menu open, no sideways scroll, Up and Escape; the file saved in each
  language (name, lines, `UID`, `SEQUENCE`, summary, no `METHOD`/`ORGANIZER`/`ATTENDEE`).
- `e2e/quality/accessibility.spec.ts` and `appearance.spec.ts`: one host kind's editor beside the
  invitation's (axe and reflow, light and dark). The visit page as the host (the employee's quality data)
  already ran axe with the control on it.
- `e2e/support/outbox.ts`: the kinds `VISITOR_CALENDAR` and `HOST_VISIT_*`, the JSON's `calendar`, and
  `calendarFile(message)` (the `.ics`). Every helper and spec already picked messages by kind, so the
  extra messages broke none.

### Verification (2026-10-19)

| Gate | Result |
|---|---|
| `npx tsc -b` | clean |
| `npm run e2e:typecheck` | clean |
| `npx oxlint --deny-warnings` | clean |
| `npx vitest run` | 156 files, 2,134 tests, all passed (Phase 13 ended at 2,093) |
| `npm run build` | built (to the scratchpad); the calendar code is in the visits chunk, not in the app chunk (323 kB) or the pass page |
| `npx playwright test --retries=0`, the whole suite (8700, `vms_e2e`) | 657 tests: 584 passed, 73 skipped, 0 failed, 31.6 min (Phase 13: 630 tests). The new: `flows/calendar.spec.ts` 3, `phase14-calendar.spec.ts` 18 (6 a project), and the host kind editor in the accessibility and appearance specs |

**Looked at.** Screenshots in the session scratchpad's `p14f/shots/out/`: the visit page at 1440 and 390 px,
Arabic and English, Light and Dark, with the menu closed, open and an item focused; the Arabic menu at
twice the resolution; the invitation's outcome with the menu open (1440 English Light, 390 English Dark,
1440 Arabic Dark); the e-mail texts list (1440 English Light, 390 Arabic Light) and a host kind's editor
(390 English Dark, 390 Arabic Dark). What they changed: the menu's `fitContent` (F14-8).

### Verification after the review and the verifier's round (2026-10-20, the backend final)

The backend final (its full pytest 4,727 passed, migration 0017, its contract snapshot regenerated with
`VisitResendResult`), and nothing else running on the machine.

| Gate | Result |
|---|---|
| `npx tsc -b` | clean (with `Menu.typetest.ts`) |
| `npm run e2e:typecheck` | clean |
| `npx oxlint --deny-warnings` | clean |
| `npx vitest run` | 160 files, 2,187 tests, all passed (2,134 before the review), `api.contract.test.ts` and `auditVocabulary.test.ts` on the final backend |
| `npx vite build` | built (to the scratchpad) |
| `npx playwright test --retries=0`, the whole suite (8700, `vms_e2e`) | 670 tests: 593 passed, 77 skipped, 0 failed, 38.4 min. The new ones: the two layout checks of F14-31 (desktop; the 4 more skipped are those two on the tablet and the phone), the `CLASS:PRIVATE` checks, the new address's sequences (1, 2, then 3) |
| The mutations of the verifier's round | each break a new test is for, applied in memory with the verifier's harness (the session scratchpad's `fix14f/mutate/`), fails that test: the menu kept open over a change, the paused offline request, no focus rescue, no cancel of a request on its way, a toast after leaving, no repeat guard, a code-point cut, no wrap, the Invitation column at 144 px, the card's plate in light |

Earlier in the round: the whole suite on 2026-10-20 before the verifier's round, 664 tests: 590 passed, 73
skipped, 1 failed. The failure was `quality/accessibility.spec.ts` on the tablet, "audit log with event details
open": the page's first render outlasted the 10 s wait under the whole suite's load (the page loaded in 5 s,
the list's request answered 13 s after the navigation began). It passed alone (198 passed), and its waits now
take the suite's first-render allowance (`FIRST_RENDER`, 30 s); the spec again: 198 passed, and the whole
suite above. One full Vitest run that day failed `auth/sessionSync.test.tsx` "clears the cache of a tab on a
public page" (a 5 s wait under load, never touched in this phase; Open items); the later ones passed it.

## Open items

- **Real calendars.** No link was opened in a real Google or Microsoft account and no file imported into a
  real Apple or Outlook calendar from here; the lead's real-client check covers the e-mails (B14 open item
  1). Outlook on the web's deeplink in particular has changed form before (`/calendar/0/deeplink/compose`
  is redirected to `/calendar/0/action/compose` today). Worth one look in each: a purpose with `&`, `<` and
  two lines shows as written (F14-18), and the file opens the "Add to Calendar" sheet on an iPhone and an
  iPad (F14-6).
- **`auth/sessionSync.test.tsx`, "clears the cache of a tab on a public page"** (Phase 10, SEC-26) fails
  now and then in a full Vitest run on a loaded machine (a 5 s wait), twice in ten full runs over two
  days; never alone or in a run of 61 files. Not touched in this phase; worth a look on its own.
- **iOS browsers other than Safari, and in-app browsers**, may not open the file as an event (F14-6);
  add-to-calendar-button tells them to open Safari, an explanatory note this app does not show.
- **A link makes a second entry.** Google's and Outlook's forms take no `UID`: a host who adds the visit by
  a link and also accepts the e-mailed invitation has it twice, and the e-mails move and cancel only the
  second. The file has the e-mail's `UID` and does not have this problem.
- **Personal Outlook.com calendars** are served by the file, not by a link (F14-4).
- **A visitor whose pass the host shares himself** has no way to add the visit (F14-9; possible later with
  a token-hash lookup, B14-12 (c)).
