# Phase 14 — backend decisions (a visit in the visitor's and the host's calendars)

Date: 2026-10-19. Scope: `backend/` (application code, revision `0016`, templates, tests, one test-only
dependency), the regenerated `frontend/src/types/backend-contract.json` (no other frontend file),
`README.md`, `docs/api.md`, `docs/security.md`, `docs/production-readiness.md` and this file. Section A
of the phase's shared contract, and the API fields section B needs; the web application's half (the
"Add to calendar" control of the visit page, the editor's new kinds) is `phase-14-frontend.md`.

The owner's decisions (2026-10-19): the visitor **and** the host get the visit in their calendar, by a
calendar invitation that travels with the e-mail (iCalendar, RFC 5545, as iTIP, RFC 5546, by e-mail,
iMIP, RFC 6047), for Google Calendar and Gmail, Outlook and Apple Calendar; no OAuth and no connection
to anyone's calendar; a new time moves the entry and a cancellation removes it.

**Contract changes.** Migration `0016`. Four e-mail kinds: `HOST_VISIT_SCHEDULED`,
`HOST_VISIT_RESCHEDULED`, `HOST_VISIT_CANCELLED` (editable: `EditableEmailKind` has seven values) and
`VISITOR_CALENDAR` (not editable, not in the API's enums). Three response fields: `Visit.calendar_sequence`
(so `InsideVisit` too), `MeCompany.address`, `MeCompany.address_ar`. No endpoint, no request field, no
setting, no error code, no field code, no audit action; one audit metadata key used in more rows
(`host_notified`, which existed, now also on `VISIT_RESCHEDULED` and `VISIT_CANCELLED`). The development
outbox writes `<id>.ics` and a `calendar` key in `<id>.json`. What a client or a test may have relied
on: [the list](#what-a-client-or-a-test-may-have-relied-on).

**After the independent review** (same day; [the review's fixes](#the-reviews-fixes), B14-15 to B14-25):
two more response fields (`Visit.visitor_calendar_sent`, so `InsideVisit` too, and
`VisitInvitation.calendar_failed`), two settings
(`HOST_VISIT_NOTICE_DAILY_LIMIT`, `CALENDAR_EMAIL_COMPANY_DAILY_LIMIT`) with their rate-limit policies
(`host_visit_notices_per_user_day`, `calendar_emails_per_company_day`), two audit metadata keys
(`calendar_sent`, `host_notice_limited_by`), one template (`visitor_withdrawn`); revision `0016` changed in
place to the same end state; no endpoint, no request field, no error code, no e-mail kind.

**After the verification** (2026-10-20; [after the verification](#after-the-verification), B14-26 to
B14-34): revision `0017` (`email_messages.calendar_method`); one setting (`CALENDAR_INVITATIONS_ENABLED`,
false in the production template: a release gate); one response type (`VisitResendResult`, the answer of
`POST /visits/{id}/invitation`, whose `pass_url` is null when only the calendar invitation was sent
again); one audit metadata key (`host_calendar_sent`, and `calendar_sent` on `VISIT_RESCHEDULED` too); no
endpoint, no request field, no error code, no e-mail kind.

Sources were read on 2026-10-19. Where Google publishes nothing (how Gmail parses an iMIP message) the
entry says so; the real-client check is the lead's, with the owner's consent (open item 1).

---

## What is sent, to whom

**B14-1 — Every visit e-mail carries the visit as an event, versioned.** `app.email.calendar` writes the
iCalendar object; `EmailService` puts it on the message (`OutgoingEmail.calendar`, a `CalendarPart`).

| E-mail | To | iTIP method | `UID` | `SEQUENCE` |
|---|---|---|---|---|
| `VISITOR_INVITATION` (the pass) | visitor | **none** (B14-10) | | |
| `VISITOR_CALENDAR` (follows every invitation) | visitor | `REQUEST` | `visit-<id>-visitor` | the visit's |
| `VISIT_RESCHEDULED` | visitor | `REQUEST` | `visit-<id>-visitor` | the visit's |
| `VISIT_CANCELLED` | visitor | `CANCEL` | `visit-<id>-visitor` | the visit's |
| `HOST_VISIT_SCHEDULED` | host | `REQUEST` | `visit-<id>-host` | the visit's |
| `HOST_VISIT_RESCHEDULED` | host | `REQUEST` | `visit-<id>-host` | the visit's |
| `HOST_VISIT_CANCELLED` | host | `CANCEL` | `visit-<id>-host` | the visit's |
| `HOST_ARRIVAL`, the password e-mails, the platform notice | | none | | |

Who receives what follows the rules the visit e-mails already had, unchanged for the visitor:

- **The visitor** gets the calendar invitation after every invitation (a new visit with
  `send_invitation`, a resend, the re-invitations after an address change, D-19) and only then; the notice
  of a new time and of a cancellation only when an invitation was requested for the visit (B24-25). So a
  visitor whose pass the host shares himself, and a walk-in, get nothing, as before. Once the visitor's
  calendar was sent the visit, its cancellation goes whatever `notify_visitor` says (B14-16); an address
  the visitor no longer has is sent the event's withdrawal (B14-17).
- **The host** (B14-2) is told of every scheduled visit booked for them, by themselves or by an
  administrator, with or without an invitation to the visitor; of its new time and its cancellation when
  they were told of the visit (its `HOST_VISIT_SCHEDULED` is in the e-mail log: a visit booked before
  this phase sends the host no notice of a change out of nowhere, B24-25's rule for hosts) and the
  account is active (a deactivated user is sent nothing, as everywhere, but the cancellations its
  deactivation causes, B14-20). A walk-in tells the host by its arrival notice only, as before.
- **Budgets** (B14-15): the host's e-mails per acting user and day, every e-mail carrying an event per
  company and day; beyond them the e-mail is left out, but never one that takes the visit out of a
  visitor's calendar.
- **The sending mailbox itself** is never sent an event (B14-5).
- **A test e-mail** of a company's texts carries none (B14-14).

In one request the jobs are queued, and delivered after the commit one after the other, in this order:
the invitation, its calendar invitation, the host's e-mail (a reschedule: the visitor's notice, then the
host's; a cancellation likewise; an address change, per visit: the withdrawal from the old address, then
the new address's invitation and calendar invitation).

*Held by.* `tests/integration/test_visit_calendars.py` (13: a visit's life in both calendars, read back
by a parser that is not ours; a visitor never invited; an administrator's booking in the host's
language; a walk-in; an arrival; a host never told; an inactive host; a host who loses the role; the
budgets; a purpose change; a resend; the sending mailbox; Me; 21 after the review, which rewrote the
inactive host's and the budgets' tests, B14-15 to B14-20), and the integration tests of visits, passes,
visitors, e-mail texts, SMTP delivery and the races, which now say what each request sends.

**B14-2 — The host's three e-mails: three kinds, each editable.** The contract left open "the same new
kind for update and cancel, or separate kinds". **Decided: three kinds**, mirroring the visitor's three:
`HOST_VISIT_SCHEDULED` (pill "New visit" / «زيارة جديدة»), `HOST_VISIT_RESCHEDULED` and
`HOST_VISIT_CANCELLED` (the yellow pills "Visit rescheduled" / «تغيير موعد الزيارة» and "Visit cancelled" /
«إلغاء الزيارة»).

- One kind is one e-mail with one set of texts (B11-20), as the editor, the API and the e-mail log already
  have it. A subject or an introduction written for "a new visit" would be wrong on the cancellation;
  texts per moment of one kind would be a new concept in the editor. The cost is two more entries in the
  editor (seven kinds).
- **Editable** like the host's arrival notice: `subject` (required `{visitor_name}`, B11-25; `{purpose}`
  not allowed, B11-40), `heading`, `greeting`, `intro`, `closing`, `footer_note`; no button. Variables:
  `host_name`, `visitor_name`, `visitor_company`, `company`, `date`, `time` (the visit's time range),
  `timezone`, `department`, `purpose`. The defaults (`app.email.i18n`, `host_scheduled.*`,
  `host_rescheduled.*`, `host_cancelled.*`): "New visit: {visitor_name} on {date}", "You have a new
  visit", "Hello {host_name},", "You have a visit from {visitor_name} on {date}, {time} ({timezone})." and
  the like; in Arabic «زيارة جديدة: {visitor_name} يوم {date}», «لديك زيارة من {visitor_name} يوم {date}،
  {time} ({timezone}).», worded without gender for a named person as the catalog does.
- **One template**, `host_visit.html` / `.txt`, for the three: the heading, the greeting, the
  introduction, the visit's details (visitor, the visitor's company, date, time, department, "Booked by" /
  «الحجز بواسطة» when an administrator booked it, purpose, and the reason of a cancellation), and for a new
  visit the line that the event is attached (B14-3). The company's identity in both designs, as every
  company e-mail (Phases 12 and 13). The host's own language, else the company's (B10-9); Reply-To the
  deployment's `EMAIL_REPLY_TO` if any, as the arrival notice.
- **Budgets.** *Superseded by B14-15 after the review.* (Was: the two notices of one new time took one
  slot of the reschedule budgets together, and a new visit and a cancellation had no budget of their own.)
  Now the host's three count against the acting user's `host_visit_notices_per_user_day`, and every
  calendar e-mail against the company's `calendar_emails_per_company_day`; the reschedule budgets are the
  visitor's notices' alone.
- **D-18.** A host who loses the host role is still active and is told of each cancellation, so the
  entries leave their calendar; so is a host being deactivated, of the cancellations the deactivation
  causes (B14-20, after the review; it was sent nothing).

**B14-3 — What an event says.** In the language that leads its e-mail (the visitor's: the company's; the
host's: the host's), written by the e-mail service (`_visitor_event`, `_host_event`):

| Property | Visitor's event | Host's event |
|---|---|---|
| `SUMMARY` | «زيارة إلى {company}» / "Visit to {company}" | «زيارة: {visitor}» / "Visit: {visitor}" |
| `DTSTART`, `DTEND` | the visit's scheduled start and end, in UTC (`…Z`) | the same |
| `LOCATION` | the company's address in that language (`address_ar` in Arabic when set, else `address`, and the other way round), its lines joined by the language's comma: a location is looked up on a map | the same |
| `DESCRIPTION` | "Host: …", "Department: …" (when there is one), "Purpose: …", then «اعرض بطاقة زيارتك عند الاستقبال لدى وصولك.» / "Show your visitor pass at reception when you arrive." | "Visitor: …", "Company: …" (the visitor's), "Department: …", "Purpose: …", "Booked by: …" (when not the host); each only when it has a value |
| `ORGANIZER`, `ATTENDEE` | B14-5 | B14-5 |
| `STATUS` | `CONFIRMED`; `CANCELLED` in a CANCEL | the same |
| `TRANSP` | `OPAQUE` (busy) | the same |

- The labels are the e-mails' own (`label.host`, `label.purpose`, ...), the values the visit's snapshots
  (D-17).
- **Plain text, no isolates**: a calendar draws no markup, and the Unicode isolates the e-mails' plain
  text uses (B10-14) can show as boxes in a calendar's one-line views; direction controls are removed
  from every value (`text_value`).
- **`CLASS:PRIVATE` on the host's event** (B14-19, after the review); the visitor's has none (the
  calendar's own default applies).
- **Not written:** an alarm (`VALARM`: clients ignore or
  question an organizer's reminder), an HTML description (`X-ALT-DESC`: Exchange converts it, Google
  ignores it; Outlook replaces `DESCRIPTION` with the e-mail's HTML anyway, B14-10), a `VTIMEZONE` (every
  time is UTC, RFC 5545 §3.6.5), Microsoft's `X-MICROSOFT-CDO-*` (none is needed: without
  `X-MICROSOFT-CDO-INTENDEDSTATUS` the attendee's copy is busy by default,
  https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/df1c7988-9908-4ee6-95b0-fcd180b02b44).
- `PRODID` is `-//Visits//Visit calendar 1.0//EN`: required, read by no reader, and naming neither the
  product nor a company (B12-22).
- One line in the e-mails that carry a new visit's event (the calendar invitation and the host's notice of
  a new visit), muted, in both languages: "The visit is attached for your calendar." / «الزيارة مرفقة
  لإضافتها إلى تقويمك.». Apple Mail shows an invitation as a file at the bottom; Gmail and Outlook show
  their own card or meeting bar. No other text was added.

**B14-4 — No pass link and no token in any calendar data.** The event holds no URL at all: no pass link,
no token, no sample link. Calendars are synchronised to phones and computers, shared with colleagues and
family, and delegated: Google Calendar's sharing lets people "find all details, like event names, times,
places, and descriptions" (https://support.google.com/calendar/answer/15716974), and a Workspace
administrator can see every event's details
(https://knowledge.workspace.google.com/admin/calendar/set-google-calendar-sharing-options); in Outlook a
delegate "receives copies of meeting-related messages" and "Can view all details" exposes them
(https://support.microsoft.com/office/share-and-access-a-calendar-with-edit-or-delegate-permissions-in-outlook-532e6410-ee80-42b5-9b1b-a09345ccef1b).
The pass link is a bearer credential to a building: who has it checks in. B14-10 is what keeps it out of
Outlook's calendar entries too. *Held by* tests that look for the token, `/pass`, `?c=` and `http` in the
calendar objects and in the e-mails that carry them.

**B14-5 — The organizer is the sending address; the recipient is the one attendee, asked for no reply.**

```
ORGANIZER;CN="<the company's name>":mailto:<EMAIL_FROM's address>
ATTENDEE;CN="<recipient's name>";CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:<recipient>
```

- **ORGANIZER = the `From` address, `CN` = the `From` name** (the company's, B12-13). The CalConnect
  developer guide: "Use the organizer's email address as both the SMTP MAIL FROM and the ORGANIZER
  property value" and "Check that the SMTP envelope sender and the ORGANIZER email address are consistent"
  (https://devguide.calconnect.org/imip/best-practices/, https://devguide.calconnect.org/imip/security/);
  Cronofy: "some calendar services and clients can refuse to process invites where the sender of the
  email does not match" the organizer
  (https://docs.cronofy.com/developers/smart-invites/organizer-email/index.md). Exchange shows a sender
  that differs from the organizer as "… on behalf of …"
  (https://learn.microsoft.com/zh-hk/previous-versions/office/developer/exchange-server-2010/bb856541(v=exchg.140)).
  Outlook keeps only `CN` from `ORGANIZER`
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/53a78491-8010-40fe-875a-34a18c48bce8).
  On production `EMAIL_FROM` is a Google Workspace mailbox sent through Gmail SMTP (signed with the
  domain's DKIM when the Workspace has it on), so `From`, the envelope and `ORGANIZER` are one address. No
  `SENT-BY`: Outlook ignores it.
- **The recipient is the one `ATTENDEE`**, its address exactly the `To`: RFC 5546 §3.2.2 requires at least
  one in a REQUEST, and Gmail offers its answers only to someone on the guest list (a third-party
  account: https://ithelp.brown.edu/kb/articles/rsvp-for-a-calendar-event). `PARTSTAT=NEEDS-ACTION` (the
  default, RFC 5545 §3.2.12): what the recipient answers is theirs.
- **`RSVP=FALSE`**: Outlook takes only `RSVP=TRUE` as asking for an answer
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/8fb40fed-1bed-42f4-b365-96166490ebd3),
  sets "response requested" to false otherwise
  (https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/71cfba9d-1eb6-449c-b755-87b264d80fc0),
  and then sends no answer
  (https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/2bc03497-6c3b-48af-92ad-61a6a90d74fe).
  **Gmail is not known to honour it**: its card offers Yes / No / Maybe, and "when you respond to an
  invitation, the organizer gets a notification" (https://support.google.com/calendar/answer/37135), so
  some answers reach `EMAIL_FROM`'s mailbox (open item 3). `METHOD:PUBLISH` (no attendee, no answer) was
  rejected: Outlook does not import a `text/calendar` part whose method is not REQUEST, REPLY, CANCEL or
  COUNTER
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/2637212b-2ddc-4706-8202-c796fb3f748b,
  V0002), RFC 5546 §3.2.1 forbids attendees in it, and a later CANCEL has nothing to cancel.
- **Never to the sending mailbox itself** (`EmailService.sends_from`; since the review in any spelling
  that reaches it: letter case, a `+tag`, Gmail's dots, B14-21). A host or a
  visitor whose address is `EMAIL_FROM`'s would be invited to an event they organize: Outlook answers "As
  the meeting organizer, you do not need to respond" and adds nothing (a community report,
  https://community.sap.com/t5/crm-and-cx-q-a/ics-file-auto-add-to-outlook-calendar/qaq-p/700966, and the
  rule that the client "SHOULD NOT send a Meeting Response object if … The attendee is also the meeting
  organizer",
  https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/2bc03497-6c3b-48af-92ad-61a6a90d74fe); Google's handling of it is undocumented, and Gmail does not put mail sent to one's own alias
  in the inbox ("Gmail doesn't deliver messages that you send to your own alias … to your inbox",
  https://knowledge.workspace.google.com/admin/support/troubleshooting/messages-sent-to-email-alias-or-group-arent-in-my-inbox).
  So: that host gets the host's e-mails **without** the event and without the line that says it is
  attached; that visitor gets the invitation and no calendar invitation; and the provider never carries
  an event to that address (`_queue`, a second guard). This matters on production, where the sending
  mailbox (`hamad.raouf@salma.ai`) is a person's: if that person hosts a visit, their calendar does not
  get it. **The fix is a sending mailbox that is nobody's host** (production-readiness §15 E): Google's own
  calendar guidance asks for an organizer address per organizer, not a generic one, because "any abuse
  might impact all users who send invitations from that address"
  (https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events); one
  mailbox organizing every tenant's visits is that case (open item 4). A `+tag` of that mailbox
  (`hamad.raouf+x@…`) is recognised as it since the review (B14-21); another address of the same account
  (an alias) is not (open item 5). A dedicated mailbox is now a release gate (B14-24).

**B14-6 — The event's version: `visits.calendar_sequence`.** RFC 5546 orders the messages about one
`UID` by `SEQUENCE`, the highest winning and `DTSTAMP` breaking a tie (§2.1.5); the organizer "MUST"
increment it when the start, the end or the status change and at every CANCEL (§2.1.4, §3.2.5). Outlook
"uses the UID and RECURRENCE-ID properties to … correlate a meeting request/response/cancellation … with
a Calendar object", "uses the SEQUENCE property to determine which revision is the latest" and "uses the
DTSTAMP property to break ties"
(https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/3bd7ca8e-293c-42be-9a86-fbc46193a44d,
V0239, V0240, V0242).

- A column of the visit (revision `0016`): 0 at creation, **one more at every new time** (in the
  transaction that moves the visit, whether or not anyone is told) and **one more at the cancellation**.
  A counter, not a timestamp: two changes in one second still differ, and it never goes back when a clock
  does. RFC 5545's INTEGER holds 2³¹ − 1.
- A purpose or department change sends nothing, as before, and does not raise it: the description in
  the calendars keeps the old purpose until the next new time (open item 6).
- `DTSTAMP` is the moment the e-mail is queued (UTC).
- The response field `Visit.calendar_sequence` lets the web application write a downloaded `.ics` with the
  same `UID` and a version no older than what the e-mails sent.

**B14-7 — The message: the tree Google sends and Outlook processes.** The SMTP provider:

```
multipart/mixed
├── multipart/alternative
│   ├── text/plain                                   (quoted-printable)
│   ├── multipart/related                            (when there are images)
│   │   ├── text/html                                (quoted-printable)
│   │   └── image/png …                              (the logo renditions, the QR code)
│   └── text/calendar; method="REQUEST"|"CANCEL"; charset="UTF-8"   (base64, no Content-Disposition)
└── application/ics; name="invite.ics"               (base64, Content-Disposition: attachment)
```

- **The `text/calendar` part is the last alternative, without a disposition, with the method.** Outlook:
  "MIME parts that contain iMIP data MUST have a Content-Type header of 'text/calendar'"
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/9d214cb7-ca3e-4dbf-8bb8-6ca47a83ce82,
  V0341), and a part without the method, or with another, "is not imported as an iCalendar entity"
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/2637212b-2ddc-4706-8202-c796fb3f748b,
  V0002); "if the
  Content-Disposition property is set to 'attachment' … Outlook treats it as an attachment and does not
  process it as iMIP data"
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/4b8e8747-f889-4e40-89ce-2ab51cfe9cd3,
  V0348); Outlook 2010 and later "search in all children of a 'multipart/mixed' MIME part for iMIP data"
  (https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/9d214cb7-ca3e-4dbf-8bb8-6ca47a83ce82,
  V0343); "Outlook can import 'text/calendar' MIME parts that are encoded with base64 encoding" (V0004,
  the §8.1 page above). RFC 6047 §2.4: the `method` parameter "MUST" be present and equal
  `METHOD`, `charset` "MUST" be UTF-8 for non-ASCII text, and the scheduling message "SHOULD" have a
  human-readable alternative (https://www.rfc-editor.org/rfc/rfc6047.html). RFC 2046 §5.1.4 makes the
  last alternative the preferred one; Google, Exchange and nodemailer all put the calendar last, and Gmail,
  Outlook and Apple Mail show the HTML with their card. Nodemailer builds this very tree
  (https://nodemailer.com/message/calendar-events).
- **The `.ics` attachment is the same object**, `application/ics` as Google's own invitations carry it
  (third-party captures; Cronofy recommends the pair:
  https://docs.cronofy.com/developers/smart-invites/sending/index.md). Outlook does not take it as iMIP
  (it is not `text/calendar`), so it is an attachment there; it is what a client that only looks at
  attachments opens. No duplicate event has been reported for the pair with one `UID`.
- **Base64** for both: the object's CRLF line ends and folded lines arrive octet for octet, and the body
  stays 7-bit (no server needs 8BITMIME).
- Python's `email` package writes the parameters as quoted strings (`method="REQUEST"`); RFC 2045 §5.1
  makes a quoted and an unquoted value the same value. Google writes `method=REQUEST`; the real-client
  check (open item 1) covers it.
- The QR code and the logo renditions keep their places inside `multipart/related`; a message without an
  event is the tree it was.
- **Resend** has no way to add an alternative part: its API takes `html`, `text` and `attachments`
  (https://resend.com/docs/api-reference/emails/send-email, https://resend.com/docs/dashboard/emails/attachments).
  The event goes as the attachment `invite.ics`, `content_type` `text/calendar` (plain since the review,
  B14-22; it was `text/calendar; method=…; charset=UTF-8`). Gmail and Apple Mail read a `text/calendar`
  attachment;
  Outlook (V0348) shows the file to open, and does not apply a new time or a cancellation by itself.
  Production sends through SMTP; the limit is in README §10 and production-readiness L-29.
- **The outbox** writes `<id>.ics` and `"calendar": {"method", "uid", "sequence"}` in `<id>.json`.
- An event with another method than REQUEST or CANCEL is refused by both providers, permanently.

*Held by.* `tests/unit/test_smtp.py` (the tree through a real SMTP server with STARTTLS, for a REQUEST
and a CANCEL, both copies octet for octet; a message without an event unchanged; an unknown method),
`tests/integration/test_smtp_delivery.py` (through the API: the invitation, its calendar invitation and
the host's notice as the mail server receives them), `tests/unit/test_resend.py` (the attachment, its
content type, no `content_id`), `tests/unit/test_email.py` (the outbox, the memory provider).

**B14-8 — Gmail's clipping: what counts is the HTML part.** Gmail clips a message whose HTML passes about
102 KB; the limit "applies to the HTML source of the email body — not attachments, images, or other MIME
parts" (https://help.echobox.com/what-is-gmail-email-clipping; Google documents no figure). The calendar
parts beside it do not count. The guard (`test_the_largest_e_mail_a_company_s_texts_can_make`, B13-8) now
renders the host's three and the calendar invitation too, with every text and value at its worst and the
two heaviest headers, below 95 KiB. The worst HTML of each, measured: the invitation 96,782 bytes
(unchanged: it carries no event), the host's new visit 84,705, its new time 83,401, its cancellation
83,361, the visitor's new time 77,247, cancellation 75,759, a visitor's arrival 81,290, the calendar
invitation 30,382. The calendar objects at those values are about 2 KB.

**B14-9 — The writer by hand; an independent parser for the tests only.** iCalendar is written by
`app.email.calendar` (no runtime dependency): `CRLF` line ends; `TEXT` escaped (`\\`, `\;`, `\,`, a line
break as `\n`; control characters out, a tab a space, direction controls out); every content line folded
at 75 octets, a continuation starting with one space, **never inside a character's UTF-8 octets** (RFC
5545 §3.1 calls such a fold improper); times in UTC (`…Z`, form #2 of §3.3.5), whole seconds; `CN` as a
quoted string made safe as a sender's name is (`headers.display_name`); `mailto:` with the domain in its
IDNA form and the local part percent-encoded where a URI may not carry it (RFC 6068).

- **Test-only dependency: `icalendar` 7.3.0** (with `python-dateutil` 2.9.0.post0 and `six` 1.17.0),
  pinned with hashes in `requirements-dev.txt` and listed under `[project.optional-dependencies] dev`. It
  reads back every object the tests write, so the writer is held by a parser that is not ours. Not in
  `requirements.txt`, so not in the image.
- **`UID`**: `visit-<visit id>-visitor` and `visit-<visit id>-host`. Stable for the visit's life, globally
  unique (a visit's ID is a random UUID), and without a domain or anything that identifies a person: RFC
  7986 §5.3 says a `UID` "MUST NOT include any data that might identify a user, host, domain" and
  recommends a random UUID (https://www.rfc-editor.org/rfc/rfc7986.html). The web application builds the
  same `UID`s.

*Held by.* `tests/unit/test_email_calendar.py` (67): read back whole by `icalendar`; a CANCEL names the same
event, newer; `CRLF` and no bare line break; escaping (13 cases) and texts read back as written (Arabic,
emoji, joiners); folding of Arabic, emoji, accented and ASCII lines, each physical line ≤ 75 octets and
whole UTF-8, and at its boundaries (75, 76, a cut that would fall inside a letter); UTC from another zone;
a naive time refused; malformed events refused; `UID`s stable and distinct; `CN`s; `mailto:` URIs (IDN,
special characters, a non-ASCII local part); and the e-mails' events (B14-1 to B14-5, B14-10, B14-14).

**B14-10 — The visitor's event comes in an e-mail of its own, without the pass.** Found by the research,
decided by the lead (option S). Outlook makes the e-mail that carries an event the body of the calendar
entry: "On import, Outlook uses the first 'text/html' child of a 'multipart/alternative' parent to replace
the DESCRIPTION property of the iMIP data"
(https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/9d214cb7-ca3e-4dbf-8bb8-6ca47a83ce82,
V0346); Google invitations seen in Outlook carry Google's whole e-mail that way. Had the invitation carried
the event, every Outlook user's calendar entry, shared and delegated, would have held the "Open my visitor
pass" link, the address under it and the QR code: what B14-4 forbids.

- **The invitation is unchanged**: the pass, no calendar part. The **calendar invitation**
  (`VISITOR_CALENDAR`) follows it, after every invitation (a new visit, a resend, the re-invitations of
  D-19) and never without one: the invitation's subject (so the two stand together in a mail client), the
  company's header in both designs, the invitation's heading, the date and time, the host and the
  department, the address, and the line that the event is attached. No link, no QR code: in Outlook this
  is the calendar entry's body.
- **Not editable**, and not another entry in the editor: it takes the invitation's company texts (its
  subject, its heading, its footer note), so the editor keeps seven kinds.
- It is delivered after the invitation (one request's jobs run in order). The two are delivered on their
  own: a refused address refuses both; an invitation that fails transiently three times while its
  calendar invitation goes through leaves the visitor an event without a pass, which the host's resend
  (shown under Needs attention) puts right; since the review, so does a calendar invitation that fails
  while its invitation goes through (B14-18).
- The notices of a new time and of a cancellation carry no pass link (they never did, D-22), so they carry
  the event themselves. So do the host's three.

**B14-11 — Revision `0016`.**

- `ck_email_messages_kind_valid` gains `HOST_VISIT_SCHEDULED`, `HOST_VISIT_RESCHEDULED`,
  `HOST_VISIT_CANCELLED` and `VISITOR_CALENDAR`; `ck_email_template_overrides_kind_valid` the three
  host kinds (not `VISITOR_CALENDAR`).
- `visits.calendar_sequence integer NOT NULL DEFAULT 0` with CHECK
  `ck_visits_calendar_sequence_non_negative`. A constant default rewrites no table; existing visits start
  at 0.
- No grant: the runtime role's table privileges cover a new column and changed CHECKs.
- **Locks** (after the review, B14-23): the upgrade waits at most 5 s for a lock, and the CHECKs of
  `email_messages` and `visits` are added `NOT VALID` and then validated.
- **Downgrade** (after `LOCK TABLE visits, email_messages, email_template_overrides`, SEC-39) refuses while
  an e-mail of the four kinds is in the log, while a company has a text of a host's kind, or while a
  **SCHEDULED** visit's version is above 0 (calendars hold it, and after the next upgrade the counter
  would start again below it, so their entries would ignore the visit's next change; a visit that is no
  longer SCHEDULED sends nothing again). A host kind's row without a text (a reset) holds nothing and is
  removed. The whole downgrade is one transaction.

*Held by.* `tests/integration/test_calendar_database_rules.py` (12): the runtime role writes the new kinds
and no unknown one, texts of the host's kinds and none of `VISITOR_CALENDAR`, a version from 0 and never
negative; each of the four refusals; the round trip (a finished visit's version, an emptied text row);
and a host's e-mail written while the downgrade starts still blocks it. `test_migrations.py`
(`test_models_match_migration`, the round trip to 0005 and back) unchanged.

## The application

**B14-12 — The pass page gets no calendar control in this phase.** The contract asked for "Add to
calendar" on `/pass` "from the pass data already on the page". The page has none: it is static (D-20),
holds only the token in its fragment and `?c=<slug>` in its query, and asks the public brand endpoint for
the company's identity, which by design (B12-9) says nothing of an address or a visit. No field on an
existing response can reach it. The options, as put to the lead:

- **(a)** no control on `/pass`: a visitor invited by e-mail has the calendar invitation; a visitor whose
  pass the host shares himself (no e-mail address) is not covered. **Decided by the lead.**
- **(b)** the event's facts in the pass link's query (visit ID, start, end): in nginx's logs and link
  previews, without the host, the address or the purpose, and **stale after a new time** (the link is
  shown once and stays valid, D-22), so the page would add the wrong time; worse than nothing.
- **(c)** a public read keyed by the SHA-256 of the token, computed in the browser: always current and
  complete, but a new endpoint and a token-derived value sent by the page, which D-20 rules out today.

D-20 stays as it is. A visitor whose pass the host shares himself can be covered later by (c), if the
owner asks; its cost and conditions are above.

**B14-13 — The fields the web application needs.** Only what was missing:

- `Visit.calendar_sequence: int` (every `Visit`, `InsideVisit` included): the version the e-mails sent
  (B14-6), for a downloaded `.ics` with the same `UID`.
- `MeCompany.address`, `MeCompany.address_ar` (`GET /auth/me`): the company's address, the location of the
  host's event on the visit page. Shown as the e-mails choose (`address_ar` in Arabic when set, else
  `address`, and the other way round). Every user of the company could already read it in the visitor
  e-mails; until now only `GET /company/settings` returned it.
- `EditableEmailKind` gains the three host kinds.

The web application's events follow B14-3 (no link), with the `UID`s of B14-9.

**B14-14 — A test e-mail carries no event; a preview shows the e-mail.** `POST …/email-templates/{kind}/test`
renders the kind with the sample visit (tomorrow 10:00, Sara Ahmad) and sends it to the editor: with an
event it would put that visit into the editor's own calendar (Gmail may add it by itself, Outlook adds
it tentatively). So a test e-mail has no calendar part, and the host's notice of a new visit says nothing
about one being attached. A preview (`POST …/preview`, `GET …/preview`) is the e-mail as a recipient sees
it, the line included; it sends nothing. The calendar invitation has no preview of its own (it is not
editable); its words are the invitation's.

---

## The review's fixes

An independent review of this phase (2026-10-19) reported, for the backend, one high, four medium and six
low findings (H1, M1 to M4, L1 to L5, L7); the lead and the owner decided each one, and these entries
carry those decisions out. Sources read on 2026-10-19.

**B14-15 — The host's e-mails have a budget per acting user, a company's calendar e-mails one per company
(review H1, L1).** The finding: `HOST_VISIT_SCHEDULED` was queued at every creation and
`HOST_VISIT_CANCELLED` at every cancellation, with no budget. An EMPLOYEE creating and cancelling visits
for themselves sent two e-mails per pair of requests, with every e-mail budget at 1 (the review's probe:
fifteen pairs, thirty e-mails), through the one sending mailbox every company shares (Gmail 500 messages
a day, Google Workspace 2,000). A provider that stops the mailbox for the day stops every company's
invitations, and what stays queued is marked FAILED by `fail_interrupted` after 5 minutes.

- **`host_visit_notices_per_user_day`** (`HOST_VISIT_NOTICE_DAILY_LIMIT`, default **200**, 24 hours,
  keyed by the user whose request sends the e-mail): each of the host's three e-mails counts against
  whoever creates, reschedules or cancels the visit, or deactivates its host or takes the host role away
  (D-18), whoever the host is. 200 is a busy booker's day (a visit every few minutes, some moved or
  cancelled) with room to spare, and bounds an abused account to 200 a day.
- **`calendar_emails_per_company_day`** (`CALENDAR_EMAIL_COMPANY_DAILY_LIMIT`, default **500**, 24 hours,
  keyed by the company): every e-mail that carries a visit's event, on top of its other budgets:
  `VISITOR_CALENDAR`, `VISIT_RESCHEDULED`, `VISIT_CANCELLED` and the host's three (to a host whose
  address is the sending mailbox they go without the event, and count the same). Four companies at the
  default fill a Workspace mailbox's 2,000; `.env.example` and README §5 say to keep the companies'
  budgets, with the invitations and the other e-mails, below the mailbox's cap. The invitation itself is
  not in it: it has its own budget, which refuses the request (429) instead of leaving the pass out. Nor
  is `HOST_ARRIVAL`, read as outside "every calendar and host e-mail": it carries no event, predates this
  phase and has its own budget per checking-in user (B57-62); putting it in would let a busy day's
  bookings leave the desk's arrival notices out.
- **Beyond either**, the visit is still created, moved or cancelled, and the e-mail is left out and
  audited, as `_announce_reschedule` did: `VISIT_CREATED` gains `host_notified` and
  `host_notice_limited_by`; `INVITATION_QUEUED` gains `calendar_sent` and `notice_limited_by` (the
  calendar invitation's budget: the invitation goes, without its event); `VISIT_RESCHEDULED` has
  `notice_limited_by` for the visitor's notice (its meaning before this phase) and `host_notice_limited_by`
  for the host's; `VISIT_CANCELLED` gains `host_notice_limited_by`. Two keys, because the two notices of
  a new time now have budgets of their own and either can be left out alone.
- **Never left out**: an e-mail that takes the visit out of a visitor's calendar, the visitor's
  cancellation notice and the withdrawal from an old address (B14-17), by the owner's rule (B14-16). It
  takes a slot of the company's budget while there is one. Each follows an invitation or a calendar
  invitation that was counted, at most one per visit and address, so the budgets that let those out bound
  it.
- **L1: the host's notice of a new time is not in the reschedule budgets** (B14-2 had put the two notices
  of a new time in one slot of them). A quick fourth correction of a time still moves the host's
  calendar, and a new time that tells only the host (a visit whose visitor is not e-mailed) spends nothing
  of them: they are the visitor's notices' alone, as before this phase.
- In a new visit the host's notice is reserved before the visitor's calendar invitation: with one slot of
  the company's budget left, the host's notice takes it.
- The limiter counts in process memory (production-readiness R-1): the main API process serves every
  write, so it counts every one of these budgets.

*Held by.* `test_visit_calendars.py`: `test_the_host_s_e_mails_have_a_daily_budget_per_acting_user`,
`test_every_e_mail_budget_bounds_what_creating_and_cancelling_sends` (the review's probe: one e-mail
where there were thirty), `test_the_calendar_e_mails_have_a_daily_budget_per_company` (every left-out
e-mail audited, the other company untouched, the cancellation still sent),
`test_the_host_s_notice_of_a_new_time_is_not_in_the_reschedule_budgets`,
`test_a_deactivated_host_is_told_of_the_cancellations_it_causes` (the administrator's budget);
`test_visits_api.py` (the reschedule budgets); `test_rate_limit.py` (the scopes); `test_config.py`
(`.env.example`).

**B14-16 — A cancelled visit always leaves the visitor's calendar (review M1; the owner's decision,
"always removed").** `notify_visitor: false` used to leave a cancelled visit in the visitor's calendar.
Now, once the visitor's calendar holds the visit (the last event its address was sent is a REQUEST,
whatever became of that e-mail: B14-26 after the verification; it read the `VISITOR_CALENDAR` messages
alone before), the cancellation is sent whatever `notify_visitor` says, without the reason (B14-32), and
no budget leaves it out (B14-15). Otherwise `notify_visitor` decides, as before (B24-25: and only for a
visit with a requested invitation).

- **`Visit.visitor_calendar_sent: bool`** (and `InsideVisit`'s), the name the lead proposed: true exactly
  then, so the web application does not offer "Notify the visitor by email" for that visit. It is read
  with the page's other e-mail facts: one query more per page, the latest `VISITOR_CALENDAR` message per
  visit and address.
- ~~**A withdrawal counts as sent.**~~ Superseded by B14-26: the log now records the method each e-mail
  carried, so a withdrawal is a CANCEL and an address that had the event withdrawn holds nothing until a
  REQUEST reaches it again.
- `test_visits_api.py::test_cancel_without_body_or_notification` now expects `VISIT_CANCELLED` and
  `HOST_VISIT_CANCELLED` for an invited visit cancelled with `notify_visitor: false`.

*Held by.* `test_a_cancelled_visit_always_leaves_the_visitor_s_calendar`,
`test_a_calendar_that_has_the_visit_loses_it_even_after_a_resend_without_one`, the company budget test
above, `test_visit_concurrency.py::test_a_cancel_that_waited_for_a_reschedule_cancels_the_newer_version`.

**B14-17 — A visitor's old address loses the event (review M2, D-19).** Open item 7 said the event stayed
in the calendar of an address the visit no longer has. Now, when the visitor's address changes or is
removed, each SCHEDULED visit whose `VISITOR_CALENDAR` went to the old address (B14-16's lookup) gets:

- `calendar_sequence` one higher;
- a **withdrawal** to the old address: a `VISITOR_CALENDAR` message (no new e-mail kind, so revision
  `0016` and the demo database need nothing) whose iTIP `CANCEL` holds `UID`, `SEQUENCE`, `DTSTAMP`,
  `DTSTART`, `DTEND`, `ORGANIZER`, `ATTENDEE` (without `CN`), a `SUMMARY` that names nothing ("Visit" /
  «زيارة»), and no `DESCRIPTION`, no `LOCATION` and **no `STATUS`**: RFC 5546 §3.2.5 lets a CANCEL either
  cancel the event (`STATUS:CANCELLED`) or uninvite some attendees, and `STATUS` is not written when it
  uninvites (https://www.rfc-editor.org/rfc/rfc5546.html#section-3.2.5). The old address may be nobody
  the visit concerns (a typing mistake): `CalendarEvent.withdrawn`;
- an e-mail as minimal (`visitor_withdrawn`): the company's header and footer in both designs, the
  heading "This visit invitation has been withdrawn" / «سُحبت دعوة الزيارة هذه» and one sentence, "The
  visit has been removed from your calendar." / «أُزيلت الزيارة من تقويمك.»; no date, host, address,
  purpose or link; Reply-To only `EMAIL_REPLY_TO`, never the host's address. Subject "Visit invitation
  withdrawn" / «سحب دعوة الزيارة»;
- then, with a new address, the invitation and its calendar invitation as before, whose `REQUEST`
  carries the raised `SEQUENCE`.

The budget: the lead's decision was to count the withdrawal in the same invitation budget. It is counted
there and in the company's calendar e-mails, each **while it has room, and never refused**: refusing it
would keep the event in a calendar it should leave, and refusing the change of address would keep the
visit's e-mails going to an address that may be the wrong person's. The re-invitations keep their
all-or-nothing reservation (429 `INVITATION_LIMIT`, or 422 on `email` when they can never fit, SEC-44),
so that answer's count stays the number of visits.

*Held by.* `test_a_new_address_takes_the_visit_out_of_the_old_address_s_calendar` (the withdrawal read
back, its version, its e-mail, the budget it spends, the new address's version, a removed address),
`test_visitors_api.py::test_email_change_revokes_and_reissues_passes`, and
`test_email_calendar.py::test_a_withdrawal_uninvites_its_attendee_without_cancelling_the_event`,
`::test_the_withdrawal_from_an_old_address_says_nothing_of_the_visit` (both leading languages).

**B14-18 — A failed calendar invitation needs attention like a failed invitation (review L5).** When the
calendar invitation that followed the visit's latest invitation to the visitor's address FAILED while the
invitation went out (or is on its way), the visit's `invitation` shows that failure (`FAILED`, its error,
its attempts) with **`calendar_failed: true`**, and the visit is under *Needs attention*
(`needs_attention` filter, the dashboards' count): the visitor has the pass without the event, and the
host's resend sends both again. `VisitInvitation.calendar_failed` (added at the lead's request, so the web
application does not say "Invitation not delivered" of an invitation that was) is true exactly then and
false otherwise: a failed invitation shows its own failure with `calendar_failed: false`, whatever its
calendar invitation did. The calendar invitation of an
earlier invitation and a withdrawal (to an address the visitor no longer has) never count: a resend whose
calendar invitation the company's budget leaves out shows as the resend went, and its `INVITATION_QUEUED`
row says the calendar invitation was left out (B14-15).

**A host's e-mail that fails stays internal**: `email_messages` (FAILED, `last_error`) and the logs, not
the visit. The host sees the visit in the application, and no action of theirs would send it again.

*Held by.* `test_a_failed_calendar_invitation_needs_attention_like_a_failed_invitation` (a failed host's
e-mail beside it changes nothing; the resend clears `calendar_failed`),
`test_a_failed_invitation_is_the_invitation_s_failure_whatever_its_calendar_invitation_did` (its calendar
invitation sent or failed), `test_a_failed_calendar_invitation_of_an_earlier_invitation_is_not_the_visit_s`,
and the D-19 test above (a failed withdrawal is not a failed
invitation).

**B14-19 — The host's event is private (review M3).** The host's event carries `CLASS:PRIVATE` (RFC 5545
§3.8.1.3): a host's calendar is often shared with colleagues or delegated, and the event names the
visitor, their company and the purpose. In Outlook a private item's details are hidden from people the
calendar is shared with
(https://support.microsoft.com/office/make-an-appointment-or-meeting-private-dc3898f0-22f5-45c6-8cc8-b4d4db84111d).
**Google's handling of `CLASS` in an iMIP invitation is unverified**: Google documents none of it; the
real-client check looks at a shared calendar (open item 11). The visitor's event has no `CLASS`.

*Held by.* `test_email_calendar.py::test_the_host_s_event_is_private_and_the_visitor_s_is_not`.

**B14-20 — A host being deactivated is told of the cancellations it causes (review M2, D-18).** A
deactivation cancels the host's SCHEDULED visits; until now the host was sent nothing, so their calendar
kept every entry. Now the host is sent `HOST_VISIT_CANCELLED` for each visit they were told of
(`HOST_VISIT_SCHEDULED` in the log), at the moment the account stops, within the budgets of the
administrator who deactivates it (B14-15; `UsersService` settles them after its commit). A deactivated
account is sent nothing afterwards, as everywhere.

*Held by.* `test_a_deactivated_host_is_told_of_the_cancellations_it_causes`,
`test_visit_hooks_e2e.py::test_deactivating_a_host_cancels_their_scheduled_visits`.

**B14-21 — The sending mailbox in any spelling (review L7).** `sends_from` compared exact strings.
`mailbox_key` now compares the mailbox an address reaches: letter case aside; without a `+tag` (Gmail,
Google Workspace and Microsoft 365 deliver `name+tag@` to `name@`); and for gmail.com and googlemail.com
(one domain) without dots, which Gmail ignores ("If someone accidentally adds dots to your address when
emailing you, you'll still get that email", https://support.google.com/mail/answer/7436150; in an
organisation's domain dots count, so they stay). Another address of the same account (an alias) cannot
be told from its spelling (open item 5).

*Held by.* `test_email_calendar.py::test_an_address_is_compared_as_the_mailbox_it_reaches`,
`::test_the_sending_mailbox_is_recognised_in_any_spelling`.

**B14-22 — Resend: the attachment's content type is plain `text/calendar` (review L4).** Resend's API
reference calls `content_type` the attachment's "Content type", "derived from the filename property"
when not set, and says nothing of parameters (https://resend.com/docs/api-reference/emails/send-email);
its list of refused attachments names extensions only, not `.ics`
(https://resend.com/docs/knowledge-base/what-attachment-types-are-not-supported). A parameter it does not
document (`method=…; charset=UTF-8`) could get the notice refused; a plain media type is what the page's
words cover. The method is in the object (`METHOD:` inside the `.ics`), where Gmail and Apple Mail read
it.

*Held by.* `test_resend.py::test_a_calendar_event_is_an_ics_attachment`.

**B14-23 — Revision `0016` waits 5 seconds for a lock, and validates its CHECKs separately (review L2).**

- `SET LOCAL lock_timeout = '5s'` first, `SET LOCAL lock_timeout TO DEFAULT` last: every statement takes
  its table's ACCESS EXCLUSIVE lock, which queues behind every open transaction that read the table, and
  every request then queues behind the migration. A lock not granted in 5 s fails the upgrade, which
  leaves nothing behind (one transaction) and is run again; deploy/README.md says so.
- The CHECKs of `email_messages` and `visits` are added `NOT VALID`, then `VALIDATE CONSTRAINT`.
  **Alembic runs the whole upgrade in one transaction** (`alembic/env.py`), so the scan of the validation
  still runs under the lock the `ALTER` took: the split is the form that lets a later revision, or a
  revision run per transaction, validate under a weaker lock. What bounds the wait here is the
  `lock_timeout`; the tables are each read once.
- The end state is the same as before: the same constraint names, all validated. The demo database,
  already at `0016`, needs nothing.

*Held by.* `test_calendar_database_rules.py::test_the_0016_upgrade_adds_its_checks_not_valid_then_validates_them`
(the statements in order, Alembic's offline mode),
`::test_the_0016_upgrade_gives_up_a_lock_it_cannot_get_and_leaves_every_check_validated` (a reader holds
`visits`: the upgrade fails after 5 s at version `0015`; run again, every CHECK is validated and the
session's `lock_timeout` is its own again); `test_migrations.py` (the model and the migration agree).

**B14-24 — A release gate for calendar events: a dedicated sending mailbox, signed by its domain (review
M4; documents only).** production-readiness §15 E is now a blocking item: `EMAIL_FROM` must be a mailbox of
the system's own that hosts nobody (no person's mailbox, no alias or `+tag` of one), and the Google
Workspace domain should sign with its own DKIM key, so that `From`, the envelope sender and every event's
`ORGANIZER` are one authenticated address (B14-5). README §10 and deploy/README.md say the same.

*Amended after the verification:* B14-26 (which calendars hold the visit), B14-27 (the switch), B14-28 (the
company's budget counts events, and a notice goes without its event), B14-29 and B14-30 (an address
change), B14-31 (the calendar invitation sent again alone), B14-32 (no reason in a forced cancellation),
B14-33 (domains in IDNA form).

**B14-25 — Carets in a `CN` are doubled (review L3).** RFC 6868 §3 makes `^n`, `^'` and `^^` in a
parameter value a line break, a double quote and a caret for a reader that decodes them (`icalendar`
does: a name typed `Dana^nGuest` read back with a line break). `common_name` doubles every caret, so every
name reads back as typed (https://www.rfc-editor.org/rfc/rfc6868.html#section-3).

*Held by.* `test_email_calendar.py::test_a_name_s_carets_are_doubled_and_read_back_as_typed` (five names,
the organizer's and the attendee's `CN`, read back by `icalendar`).

**Also added**: `test_visit_concurrency.py::test_racing_reschedules_each_raise_the_calendar_version` (two
new times racing on two connections: versions 1 and 2, each one's e-mails carrying its own) and
`::test_a_cancel_that_waited_for_a_reschedule_cancels_the_newer_version`; the existing race of a
cancellation before a waiting new time now checks that the refused new time raised nothing.

---

## After the verification

Two independent verifiers checked the review's fixes (2026-10-20): probes of the calendar rules and of
the budgets, and a release audit. The owner decided a switch for calendar e-mails; the lead decided the
rest. The probes now pass, and each is a test of the suite (`tests/integration/test_calendar_events.py`).

**B14-26 — Each e-mail records the event it carried; a calendar holds the visit when its last event is a
REQUEST (verification, MEDIUM).** The finding: B14-16 and B14-17 read only the `VISITOR_CALENDAR`
messages, so a visit put in the visitor's calendar by a notice of a new time (one booked before the
release and then moved, or one whose calendar invitation a budget left out) stayed there at its
cancellation with `notify_visitor: false`, and an old address that got the event that way was never sent
its withdrawal.

- Revision `0017` adds `email_messages.calendar_method` (`REQUEST`, `CANCEL`, or NULL for none), written
  when a message is queued (`EmailService._queue`). A message's kind no longer says whether it carried an
  event: a notice can now go without one (B14-27, B14-28). The rows before the revision are marked by
  their kind and age (the revision's docstring): every row of the kinds `0016` added carried one, the
  notices of a new time and of a cancellation from the first of those rows on, and none before.
- **A calendar holds the visit** when the last event its mailbox was sent of the visit is a REQUEST,
  whatever became of that e-mail (`app.services.calendar_state.holds_event`): the visitor's calendar
  from `VISITOR_CALENDAR`, `VISIT_RESCHEDULED` and `VISIT_CANCELLED`, the host's from the host's three. A
  REQUEST that failed may still have arrived, so the rule sends one CANCEL too many rather than one too
  few. A withdrawal is a CANCEL now, so an address that had the event withdrawn holds nothing until a
  REQUEST reaches it again (open item 13 closed). One mailbox's events are read in every spelling of its
  address (B14-21).
- **`Visit.visitor_calendar_sent`** is exactly that, for the visitor's current address; the views read
  one query more per page (every event of the page's visits, a handful each).
- **`calendar_failed`** (B14-18) now ends once a later REQUEST to that address went out or is on its way:
  the calendar has the visit. A later REQUEST that fails too leaves it; a failed REQUEST after a calendar
  invitation that went out is the notice's failure (shown in `last_notice`), not this.

*Held by.* `test_calendar_events.py`: `test_an_event_a_notice_of_a_new_time_put_in_the_calendar_leaves_it_at_the_cancellation`,
`test_a_visit_booked_before_the_calendars_and_rescheduled_leaves_the_calendar`,
`test_an_old_address_that_got_the_event_by_a_notice_of_a_new_time_loses_it`,
`test_a_failed_calendar_invitation_is_put_right_by_a_later_request`; `tests/unit/test_calendar_state.py`
(18: the rules, case by case); `test_calendar_database_rules.py::test_the_0017_upgrade_marks_the_event_each_earlier_e_mail_carried`
(from 0015 nothing is marked; from 0016 each kind and age as above; the CHECK validated).

**B14-27 — A switch for calendar invitations, off on production until its mailbox is authenticated (the
owner's decision).** `CALENDAR_INVITATIONS_ENABLED` (default `true`; `false` in
`deploy/env/backend.env.example`). The domain the production mailbox sends from has no SPF, no DKIM of its
own and no DMARC today, and an unauthenticated sender of invitations is what spoofing looks like. Off means
**no new calendar entry**, and the calendars that already hold a visit are kept right:

- no `VISITOR_CALENDAR` after an invitation (but to a calendar that holds the visit, where it changes
  nothing), no `HOST_VISIT_SCHEDULED` (so a host is told of nothing about a visit booked while it is off);
- a notice of a new time or of a cancellation carries its event only to a calendar that holds the visit
  (`VisitLifecycle.attach_event`), and goes without it otherwise; the withdrawal from an old address and
  the host's cancellations still go (they only remove);
- `visitor_calendar_sent` and `calendar_failed` keep their meaning; the calendar invitation sent again
  alone (B14-31) goes, since that calendar was sent the visit while the switch was on;
- edge: a calendar invitation that failed before the switch went off counts as holding the visit (B14-26),
  so a new time may still put the visit in that calendar: a right entry, never a wrong one.

The release gate (production-readiness §15 E, deploy/README.md, README §10): keep it false until the
sending mailbox is a dedicated one that hosts nobody (B14-24) and its domain has SPF, its own DKIM and
DMARC.

*Held by.* `test_with_calendar_invitations_off_no_calendar_gets_a_new_entry`,
`test_switching_calendar_invitations_off_keeps_the_entries_already_made_right`,
`test_the_calendar_invitation_alone_is_sent_again_within_its_budgets`; `test_config.py` (both templates).

**B14-28 — The company's budget counts calendar events; beyond it a notice goes without its event
(verification, MEDIUM, a regression of B14-15).** The finding: once a company's
`calendar_emails_per_company_day` was spent, by anyone's e-mails, the visitor's notice of a new time was
left out altogether. Decided (lead): beyond that budget a notice goes **without its event**, and the
audit says so; the same for every e-mail whose purpose is not the event itself.

- **Only the event**, left out beyond it: the visitor's calendar invitation, and the host's notice of a
  new visit (its purpose is the host's event: the switch sends none, B14-27; it counts against the host's
  budget and the company's together, `QuotaUnit.host_new_visit_notice`).
- **Notices**, sent without their event beyond it: the visitor's notice of a new time (its own budgets,
  the reschedule budgets, still leave it out), the host's notice of a new time (the host's budget still
  leaves it out). `VISIT_RESCHEDULED` gains `calendar_sent` and `host_calendar_sent`; `notice_limited_by`
  / `host_notice_limited_by` name the company's budget when it left the event out (`*_notified` true).
- **Removals** (the cancellations, the withdrawal) are never left out and count while there is room
  (`calendar_removal`): B14-15 had left the host's cancellation out beyond it; it goes now, with its
  CANCEL.
- The company's budget no longer bounds how many host e-mails a company sends; the host's budget per
  acting user does, as before (H1's per-actor half).

*Held by.* `test_visit_calendars.py::test_the_calendar_e_mails_have_a_daily_budget_per_company` (rewritten),
`test_calendar_events.py::test_one_user_s_host_notices_do_not_silence_another_visitor_s_notice_of_a_new_time`,
`::test_a_deactivation_beyond_the_budget_still_removes_every_visitor_event`,
`::test_in_a_new_visit_the_host_s_notice_is_reserved_before_the_calendar_invitation` (B14-15's order, held
by no test before).

**B14-29 — An address change closes the REQUESTs still waiting for the old address (verification,
Low–Medium).** A calendar invitation or a notice of a new time still PENDING for the old address (the
host corrects a mistyped address seconds after booking) could be delivered after the withdrawal and put
the visit back in that calendar. `EmailMessageRepository.close_pending_requests` closes them in the
change's transaction (FAILED, "Not sent: the visitor's address changed."), as `close_pending_invitations`
does for invitations; the delivery that later gets a slot finds the row closed and sends nothing. A CANCEL
waiting for the old address still goes.

*Held by.* `test_calendar_events.py::test_a_request_still_waiting_for_the_old_address_is_not_sent_after_the_change`
(through `EmailDispatcher.deliver` afterwards).

**B14-30 — No withdrawal for another spelling of the same mailbox; the new address's event is newer than
the withdrawal (verification, Low).** The withdrawal and the new address's REQUEST shared `UID`,
`SEQUENCE` and `DTSTAMP` (whole seconds). If the two addresses are one mailbox (`mailbox_key`: letter
case, a `+tag`, Gmail's dots, IDNA), no withdrawal is sent: the new spelling's invitation updates the
entry. Otherwise the version is raised once more after the withdrawal, so the new address's REQUEST is
one version newer and a calendar that receives both (one person's two addresses) keeps the visit whatever
their order.

*Held by.* `test_calendar_events.py::test_another_spelling_of_the_same_mailbox_keeps_the_event`,
`::test_each_calendar_is_sent_newer_versions_only` (two changes and a return: every address's versions in
order), the D-19 tests of `test_visit_calendars.py` (versions 1, 2, 3).

**B14-31 — When only the calendar invitation failed, the resend sends it alone (verification, Low).** The
remedy of B14-18 rotated a pass that had arrived. Now, when `visit.invitation.calendar_failed` is true,
`POST /visits/{id}/invitation` sends the calendar invitation alone: the same version of the visitor's
event with a new `DTSTAMP`, no pass rotation, no invitation. The answer is `VisitResendResult` (a new
contract type, the shape of `VisitCreateResult` with `pass_url: string | null`): **null exactly then**,
the new pass's URL otherwise. It counts as one of the visit's hourly resends, of the user's daily
invitations and of the company's calendar events, all or none (`QuotaUnit.calendar_resend`; 429
`INVITATION_LIMIT` otherwise, nothing sent), and is audited `INVITATION_QUEUED` with `pass_id` null and
`calendar_sent` true. With the switch off it still goes (B14-27).

*Held by.* `test_visit_calendars.py::test_a_failed_calendar_invitation_needs_attention_like_a_failed_invitation`
(the same pass, version and UID, a newer DTSTAMP; after it the resend is a resend again),
`test_calendar_events.py::test_the_calendar_invitation_alone_is_sent_again_within_its_budgets`.

**B14-32 — A cancellation sent only to clear the visitor's calendar carries no reason (verification,
Low–Medium).** B14-16 sends it whatever `notify_visitor` says; the free-text reason the canceller typed
for the record was in it. With `notify_visitor: false` it now goes without the reason (the host's
cancellation keeps it, as before).

*Held by.* `test_calendar_events.py::test_a_cancellation_the_visitor_was_not_to_be_told_of_carries_no_reason`.

**B14-33 — A domain in Unicode and in IDNA form is one domain (verification, very low).** `mailbox_key`
writes the domain in its IDNA (punycode) form, so `exämple.com` and `xn--exmple-cua.com` are one mailbox,
for `sends_from` (B14-21) and for which calendar holds the visit (B14-26).

*Held by.* `test_email_calendar.py::test_an_address_is_compared_as_the_mailbox_it_reaches`,
`::test_the_sending_mailbox_is_recognised_in_any_spelling` (an IDN sender).

**B14-34 — The upgrade procedure (the release audit; documents only).** deploy/README.md "Upgrading a
running deployment":
- `sudo` for Compose: the env files are mode 600;
- the release tree written with `git -c core.autocrlf=input archive`;
- `rsync --delete` with protect filters for the secrets, the certificate, local tooling, a root `.env`
  and override files, after a dry run;
- never `chown -R` over `deploy/tls`;
- a backup and the previous images tagged;
- a temporary swap for the build on a small VM;
- `migrate` run first, on its own, while the old API serves (a plain `up -d` stops every API container
  before it);
- the API and the frontend with `--no-deps`, then a plain `up -d`;
- the rollback as `up -d --no-build --no-deps` of the four services on the previous images, which cannot
  run `migrate` on the newer schema.

**Not changed, recorded.** The verifiers' mutations of the withdrawal's "never refused" and of "the host's
notice reserved first" survived for want of a test: both properties now have one (B14-28's list,
`test_a_withdrawal_is_never_refused`).

---

## Deviations and decisions for the frontend

1. **Seven editable kinds** (B14-2): `HOST_VISIT_SCHEDULED`, `HOST_VISIT_RESCHEDULED`,
   `HOST_VISIT_CANCELLED` join the four; their audience is the host; fields and variables as above; the
   defaults come from the API.
2. **`Visit.calendar_sequence`**, **`MeCompany.address` / `address_ar`** (B14-13); `InsideVisit` has
   `calendar_sequence` too.
3. **`UID`s** `visit-<id>-visitor` and `visit-<id>-host`; `SEQUENCE` = `calendar_sequence`; times in UTC;
   no link (B14-3, B14-4, B14-9).
4. **No control on `/pass`** (B14-12).
5. **The outbox**: an invitation is followed by a `VISITOR_CALENDAR` message to the same address; every
   scheduled visit sends `HOST_VISIT_SCHEDULED` to its host; a new time adds `HOST_VISIT_RESCHEDULED` after
   `VISIT_RESCHEDULED`; a cancellation adds `HOST_VISIT_CANCELLED` (also with `notify_visitor: false`). A
   message with an event has `<id>.ics` and `"calendar": {method, uid, sequence}` in its JSON (`null`
   otherwise). An E2E helper that takes "the last message" or counts them must filter by kind. Since the
   review: a cancellation with `notify_visitor: false` of a visit whose `visitor_calendar_sent` is true
   sends `VISIT_CANCELLED` too (B14-16); an address change sends the old address a `VISITOR_CALENDAR`
   whose `calendar.method` is `CANCEL`, before the new address's two (B14-17); a deactivation sends the
   host `HOST_VISIT_CANCELLED` per cancelled visit (B14-20).
6. **The host's description label** is «الحجز بواسطة» / "Booked by".
7. **`Visit.visitor_calendar_sent: bool`** (B14-16): the cancellation dialog does not offer "Notify the
   visitor by email" when it is true. **`Visit.invitation`** is FAILED, with the calendar's error, when
   the calendar invitation failed, and then says so: **`VisitInvitation.calendar_failed: bool`** (B14-18),
   so the visit does not say that the invitation was not delivered.
8. **Audit** (B14-15): the policies `host_visit_notices_per_user_day` and `calendar_emails_per_company_day`
   as values of `notice_limited_by` / `host_notice_limited_by`; the keys `calendar_sent`
   (`INVITATION_QUEUED`) and `host_notice_limited_by` (`VISIT_CREATED`, `VISIT_RESCHEDULED`,
   `VISIT_CANCELLED`); `host_notified` now also on `VISIT_CREATED`. After the verification:
   `VISIT_RESCHEDULED` also carries `calendar_sent` and `host_calendar_sent` (a new key), and a
   `*_limited_by` naming `calendar_emails_per_company_day` with `*_notified` true means "sent without its
   event" (B14-28); a calendar invitation sent again alone writes `INVITATION_QUEUED` with `pass_id` null
   (B14-31).
9. **After the verification:** `POST /visits/{id}/invitation` answers `VisitResendResult` (`pass_url`
   null when only the calendar invitation was sent again, which happens exactly when
   `visit.invitation.calendar_failed` was true: no new pass, so no warning about one) (B14-31);
   `CALENDAR_INVITATIONS_ENABLED` changes no response field (B14-27); the outbox: a notice may come
   without `calendar` (B14-27, B14-28), an address change's new REQUEST is one version above the
   withdrawal, another spelling of the same mailbox gets no withdrawal (B14-30), a forced cancellation
   has no reason (B14-32).

## What a client or a test may have relied on

1. **More e-mails.** Creating a scheduled visit sends the host `HOST_VISIT_SCHEDULED`; an invitation is
   followed by `VISITOR_CALENDAR`; a new time and a cancellation send the host theirs. A test that saw no
   e-mail for a visit without an invitation now sees the host's.
2. **`VisitLifecycle.cancel`** returns a tuple of jobs (the visitor's, then the host's) and
   **`VisitLifecycle.invite`** a tuple (the invitation, then its calendar invitation).
3. **Audit metadata**: `VISIT_RESCHEDULED` and `VISIT_CANCELLED` rows carry `host_notified` (a boolean, a
   key the audit vocabulary already has).
4. **The MIME tree** of a message with an event is `multipart/mixed` (B14-7); every other message is the
   tree it was. The invitation's tree is unchanged.
5. **`Me.company`** has `address` and `address_ar`; every `Visit` has `calendar_sequence`.
6. **The outbox JSON** has a `calendar` key on every message.
7. ~~**The reschedule budgets** are spent by a new time that tells only the host, one slot for the
   visitor's and the host's notice together.~~ Reverted by the review (B14-15): they are the visitor's
   notices' alone again, and the host's notices have budgets of their own.
8. **After the review:** `VisitLifecycle.cancel` and `invite` take the request's `QuotaUnit`;
   `HostedVisitCanceller.cancel_hosted_visits` takes one too (`UsersService` settles it after its commit);
   `tell_host` returns the job or the budget that left it out; `QuotaUnit.reschedule_notice` takes the
   company. `Visit` has `visitor_calendar_sent`, `VisitInvitation` has `calendar_failed`;
   `INVITATION_QUEUED`, `VISIT_CREATED`, `VISIT_RESCHEDULED`
   and `VISIT_CANCELLED` carry more metadata (B14-15); a `VISITOR_CALENDAR` message may carry a `CANCEL`
   (B14-17).
9. **After the verification:** revision `0017`; `EmailMessage.calendar_method` is written for every
   message; `LatestEmail` has `calendar_method`; `EmailMessageRepository.latest_calendars` is gone
   (`event_messages`, read by `app.services.calendar_state`); `VisitLifecycle.tell_host` returns a
   `Notice`; `QuotaUnit.reschedule_notice` no longer takes the company and `host_visit_notice` no longer
   reserves the company's budget (`host_new_visit_notice`, `calendar_event`, `calendar_resend`);
   `EmailService.queue_visit_rescheduled`, `queue_visit_cancelled` and `queue_host_visit` take `calendar`.

## Verification (2026-10-19)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 318 files already formatted |
| `mypy` (`backend/`) | no issues in 162 source files |
| `pytest` (`backend/`, the default order, before the last 14 tests were added) | 4,622 passed, 12 skipped (the opt-in performance checks), 1,604.99 s |
| `pytest` (`backend/`, the default order, the final tree) | 4,635 passed, 12 skipped, **1 failed**: `test_access_log.py::test_the_response_time_excludes_background_work`, the load-sensitive check of a test-only route that phase-12-backend.md already names (a response under 0.5 s while the web application's builder kept a Node process busy); 3 of 3 passed run alone right after, and the run above passed it |
| `pytest --committed-first` (`backend/`, the final tree) | **4,636 passed**, 12 skipped, 651.80 s |
| contract snapshot | regenerated (`EditableEmailKind`, `Visit.calendar_sequence`, `InsideVisit.calendar_sequence`, `MeCompany.address`, `MeCompany.address_ar`); the web application's parity test (`api.contract.test.ts`, run once read-only) 89 passed against it, and `auditVocabulary.test.ts` with `fieldMessages.test.ts` 21 passed |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,113 files, no development artefact or credential |

New tests: 221 more collected (4,427 before, 4,648 now): `tests/unit/test_email_calendar.py` (67),
`tests/integration/test_visit_calendars.py` (13), `tests/integration/test_calendar_database_rules.py` (12),
`test_email_templates_api.py` (14), `test_smtp.py` (4), `test_resend.py` (3), `test_email.py` (2), and the
parametrised checks over the editable kinds, which now count seven (the size guard 16 more, among them).
Changed: the tests that counted or took "the last" e-mail of a visit (they now say which kinds a request
sends, in order), the `Me` payloads (`address`, `address_ar`), the outbox's JSON (`calendar`) and the
revision the downgrade tests stop at (`HEAD = "0016"`).

**Each safeguard taken out again.** In a private copy of the backend, 34 single changes each removed one
thing this phase added: 11 of the writer (folding inside a character, at 76 octets, continuation lines of
75; commas not escaped; line breaks not normalised; direction controls kept; local time instead of UTC;
`RSVP=TRUE`; a CANCEL not marked cancelled; a `UID` without the role; a `CN` not made safe), 2 of the
content (the organizer not the sending address, a link in the description), 11 of who gets what (the
invitation carrying the event; no calendar invitation; one to the sending mailbox; the provider's guard;
the sending mailbox's host given the event; no new version on a new time, none at a cancellation; a host
never told, told; an inactive host told; the host's notice outside the budget; the host not told of a
new visit), 1 of the test e-mails (an event in one), 5 of the providers (the calendar part disposed as an
attachment, without its method, no `.ics` attachment, Resend without the method, the outbox without the
file), 1 of the calendar invitation (a subject of its own) and 3 of the migration (a scheduled visit's
version ignored, the downgrade without its lock, `VISITOR_CALENDAR` made editable). **A test failed for
all 34.**

**E-mails, rendered and looked at.** The host's notice of a new visit and the calendar invitation in both
leading languages for a company with a logo for light and one for dark surfaces (a navy wordmark, a
diamond for dark) and one with no logo and a colour (`#7c3aed`), and the host's new time and cancellation
with the logo in both languages: 12 e-mails as sent, rendered by the real service and templates to
static files with their images inline, screenshot with Playwright (from the web application's
`node_modules`) in Chromium and WebKit, light and dark (`colorScheme`), at 600 and 375 pixels: 96
screenshots, **none wider than its window**. Looked at: the host's new visit (Arabic-led, light, 600;
English-led, dark, WebKit; Arabic-led without a logo, dark, 375), the calendar invitation (Arabic-led
without a logo, light; English-led with the logo, WebKit, 375) and the cancellation (Arabic-led, dark,
WebKit, 375). What was looked at reads: the company's header and colours in both designs, the dark logo
with the name beside it, the details grid, the muted line that the event is attached, both languages.

**The real-send procedure, dry run.** The script of the final report (one sample calendar invitation,
its new time and its cancellation, as the visitor or the host; no database) sent four messages through
the SMTP provider to a local capture server (aiosmtpd on 127.0.0.1): each `multipart/mixed` with the
`text/calendar` alternative and `invite.ics`, the events read back with `REQUEST` 0, `REQUEST` 1 (the
next day), `CANCEL` 2, and the host's; it refused to send to `EMAIL_FROM`'s own address. No real e-mail
was sent.

Not run here: the Playwright E2E suite (the web application's builder's), the web application's other
suites, anything in Docker, any real mail client.

### After the review (2026-10-20)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 318 files already formatted |
| `mypy` (`backend/`) | no issues in 162 source files |
| `pytest` (`backend/`, the default order, the final tree) | **4,688 passed**, 12 skipped (the opt-in performance checks), 698.13 s |
| `pytest`, the run before it (the same tree but the last fix below) | 4,687 passed, 12 skipped, **1 failed**: `test_platform_recovery.py::test_the_tag_ends_with_the_temporary_password`, a Phase 11 test that fails whenever the generated temporary password starts with "x" (it then presents the password itself as "another" one, about one run in seventy). Fixed in the test (another first character then); 3 of 3 passed alone, and the final run passed it |
| `pytest`, an earlier run (2026-10-19, before `calendar_failed`, on a busy machine) | 4,685 passed, 12 skipped, 1 failed: `test_access_log.py::test_the_response_time_excludes_background_work` (1.24 s for a response with a 0.5 s budget), the load-sensitive check already named above; it passed in both later runs |
| contract snapshot | regenerated: `Visit.visitor_calendar_sent`, `InsideVisit.visitor_calendar_sent`, `VisitInvitation.calendar_failed` |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,116 files, no development artefact or credential |

New tests: 52 more collected (4,648 before the review's fixes, 4,700 now): `tests/unit/test_email_calendar.py`
(18: carets, the host's event private, the withdrawal's object and e-mail, the sending mailbox's spellings),
`tests/integration/test_visit_calendars.py` (10, and two rewritten: the deactivated host, the notices of a
new time), `tests/integration/test_calendar_database_rules.py` (2: the upgrade's statements, its lock
timeout and validated CHECKs), `tests/integration/test_visit_concurrency.py` (2: racing new times, a
cancellation after a new time), and the catalog's checks over the five new texts (20). Changed: the
tests that expected the old behaviour (`test_visits_api.py`: a cancellation with `notify_visitor: false`,
the reschedule budgets, the `NOT_SENT` invitation; `test_visitors_api.py`: an address change;
`test_visit_hooks_e2e.py`: a deactivation; `test_users_api.py`: the hook's `quota`; `test_resend.py`: the
content type; `test_rate_limit.py`: the two policies' scope) and the flaky test above.

**Each fix taken out again.** In place, one at a time, each file restored after its run: 28 single changes,
each removing one thing the review's fixes added: the carets doubled; `CLASS:PRIVATE`, and the host's event
asking for it; a withdrawal without `STATUS`, without a location, without the visitor's name; the `+tag`
and Gmail's dots; Resend's plain content type; the host's notices per user and per company, the visitor's
new time per company, the calendar invitation in the company's budget; the cancellation whatever
`notify_visitor` says, and never left out; the deactivated host told; the host's new time out of the
reschedule budgets; the withdrawal, its version, its count; `visitor_calendar_sent`; the failed calendar
invitation as the invitation's, under Needs attention, only after its invitation, and `calendar_failed`
set exactly then (2); the migration's lock timeout and its validation. **A test failed for all 28**; for
one (an earlier invitation's failed calendar invitation shown as the visit's) only after
`test_a_failed_calendar_invitation_of_an_earlier_invitation_is_not_the_visit_s` was added.

**The withdrawal e-mail, rendered and looked at.** Arabic-led and English-led, for a company with a logo
for light and one for dark surfaces and for one with no logo and a colour: 4 e-mails rendered by the real
service and templates, screenshot in Chromium and WebKit, light and dark, at 600 and 375 pixels: 32
screenshots, **none wider than its window**. Looked at: Arabic-led with the logo (Chromium, light, 600)
and English-led without one (WebKit, dark, 375): the company's header, the yellow "Invitation withdrawn"
pill, the heading and its one sentence in both languages, the footer; nothing of the visit.

Not run here: the Playwright E2E suite (the web application's builder's), the opt-in performance checks
(the visit lists read one indexed query more per page: the latest calendar e-mail per visit and address),
anything in Docker, any real mail client.

### After the verification (2026-10-20)

| Gate | Result |
|---|---|
| `ruff check .` (`backend/`) | all checks passed |
| `ruff format --check .` (`backend/`) | 322 files already formatted |
| `mypy` (`backend/`) | no issues in 163 source files |
| `pytest` (`backend/`, the default order, the final tree) | **4,727 passed**, 12 skipped (the opt-in performance checks), 747.39 s |
| `pytest`, the run before it (the same tree) | 4,726 passed, 12 skipped, **1 failed**: `test_access_log.py::test_the_response_time_excludes_background_work` (966.5 ms for a response with a 0.5 s budget), the load-sensitive check named above; 3 of 3 passed alone right after |
| the verifiers' probes (`verify14b`, their harness and throwaway databases) | 8 of 9 pass, among them every one that failed before; the ninth printed what another spelling of the same mailbox is sent and took its first e-mail for a withdrawal, which B14-30 removes on purpose (its new test asserts what goes instead) |
| contract snapshot | regenerated: `VisitResendResult` |
| `python -m unittest discover -s deploy/verify -p "test_*.py"` | 46 tests OK |
| `ruff check deploy`, `ruff format --check deploy` | clean, 6 files formatted |
| `deploy/verify/check_release_tree.py` | 1,124 files, no development artefact or credential |

New tests: 39 more collected (4,700 before this round, 4,739 now): `tests/integration/test_calendar_events.py`
(15: the switch, the holders, the probes, an address change, the budgets' events, the calendar
invitation sent again alone), `tests/unit/test_calendar_state.py` (18), `test_calendar_database_rules.py`
(1: revision `0017`), `test_email_calendar.py` (5: IDNA). Rewritten for the new rules: five tests of
`test_visit_calendars.py` (the company's budget, an address change's versions, the resend when only the
calendar invitation failed, an earlier invitation's calendar invitation, a resend without one) and the
revision the downgrade tests stop at (`HEAD = "0017"`).

**Each fix taken out again.** In place, one at a time, each file restored after its run: 16 single
changes, each removing one thing of this round: the notices of a new time among the events that put the
visit in a calendar; the method recorded with each e-mail; the switch, and the host's notice of a new
visit kept from it; a notice of a new time dropped instead of sent without its event beyond the company's
budget; a removal left out beyond it; a withdrawal refused beyond it; the REQUESTs waiting for an old
address closed; no withdrawal for another spelling of the same mailbox; the new address's event newer than
the withdrawal; the calendar invitation sent again alone; no reason in a forced cancellation; domains in
IDNA form; a later REQUEST putting a failed calendar invitation right, in Python and in SQL; the rows
before `0017` marked. **A test failed for all 16.**

## Open after this phase

1. **Real mail clients.** No real e-mail was sent by this phase. The MIME tree is the one Google sends and
   [MS-STANOICAL] describes, checked by parsing what a real SMTP server receives; how Gmail (web and
   apps), Outlook (Microsoft 365, desktop, outlook.com, mobile) and Apple Mail show the card, add the
   event, apply a new time and remove a cancelled one is the lead's check with the owner's consent, with
   the procedure in the final report of this phase. Google documents none of its iMIP handling.
2. **Outlook keeps a cancelled meeting** as "Canceled: …" until the user removes it (a community report);
   Gmail's handling of an iMIP CANCEL is undocumented.
3. **Gmail offers Yes / No / Maybe** whatever `RSVP` says; answers reach `EMAIL_FROM`'s mailbox as iTIP
   REPLY e-mails. Nothing reads them; a sending mailbox that is a person's (production) receives them.
4. **One sending mailbox organizes every tenant's events.** Google's guidance is an organizer address per
   organizer; abuse reported against that address affects every tenant. A domain per tenant, or a
   mailbox per tenant, would be a product decision (EMAIL_FROM per company).
5. **The sending mailbox's own host** (production: `hamad.raouf@salma.ai`) gets the host's e-mails
   without the event; a `+tag` or Gmail-dot spelling of it is recognised (B14-21), an alias of another
   account is not and would be invited to its own event. A sending mailbox that hosts nobody is now a
   release gate (B14-24, production-readiness §15 E).
6. **A purpose or department change** is not sent to the calendars (as it was never e-mailed); the next
   new time carries it.
7. ~~**An address change (D-19)** leaves the event in the old address's calendar.~~ Closed by the review
   (B14-17). Open still: a host whose e-mail address changes keeps the event at the old one.
8. **Resend** carries the event as an attachment only (B14-7): Outlook users of a Resend deployment open
   the file, and a new time or a cancellation does not move their entry by itself.
9. **A share-myself visitor** has no calendar control on `/pass` (B14-12).
10. **Sending volume.** A visit with an invitation now sends three e-mails at creation (was one), a new
    time two, a cancellation two. Gmail's sending limits (production-readiness L-27) apply to all of them;
    since the review the calendar e-mails have a budget per company and the host's a budget per user
    (B14-15). The budgets are counted in process memory (R-1): one main API process counts them all.
11. **Google and `CLASS:PRIVATE`** (B14-19): whether Google Calendar keeps an invited event private is
    undocumented; the real-client check looks at a shared calendar.
12. **The withdrawal** (B14-17): how Gmail, Outlook and Apple Mail apply a CANCEL that uninvites one
    attendee without `STATUS` is unverified (RFC 5546 says that is how it is written); the real-client
    check changes a visitor's address.
13. ~~**An address that comes back**~~ Closed by B14-26: a withdrawal is recorded as a CANCEL.
14. **Calendar e-mails are off on production** until the release gate (B14-27): the real-client check
    needs them on, on a deployment whose sending mailbox passes the gate (or a test deployment).
15. **The rows before revision `0017`** are marked by their kind and age (B14-26): a host whose address
    was the sending mailbox counts as holding an event it was never sent (it is then sent the visit's
    later notices as before), and a withdrawal sent before the revision counts as a REQUEST (a CANCEL
    too many later).
