import type { Language } from '../../i18n'
import { departmentDisplayName } from '../../i18n/departmentName'
import type { Me, Visit } from '../../types/api'
import { toDateKey } from '../../utils/datetime'
import { calendarText, formatUtc, writeCalendar, type CalendarEvent } from '../../utils/icalendar'

/*
 * The visit in the host's own calendar (Phase 14, F14-1 … F14-6): the event the host's e-mails carry
 * (backend B14-3), written in the browser from the visit on the page, for Google Calendar and Outlook
 * on the web (a link that opens their new-event form) and every other calendar (an `.ics` file).
 *
 * The same calendar object as the e-mailed one: its UID (`visit-<id>-host`), its SEQUENCE (the visit's
 * `calendar_sequence`), its times, and its summary, location and description in the words the backend
 * writes them (`HOST_EVENT_TEXTS`, held to the backend's catalog by `hostCalendar.test.ts`). An import
 * meets the entry the e-mail made instead of adding a second one, and the e-mails that follow (a new
 * time, a cancellation) move or remove it. **Never the pass link or its token** (backend B14-4): this
 * page never has them, and nothing here reads them.
 */

/** The backend catalog's words of the host's event (`backend/app/email/i18n.py`: `calendar.host_summary`, `label.*`). */
export const HOST_EVENT_TEXTS: Record<Language, { summary: string; visitor: string; company: string; department: string; purpose: string; bookedBy: string }> = {
  ar: { summary: 'زيارة: {visitor}', visitor: 'الزائر', company: 'الشركة', department: 'القسم', purpose: 'الغرض من الزيارة', bookedBy: 'الحجز بواسطة' },
  en: { summary: 'Visit: {visitor}', visitor: 'Visitor', company: 'Company', department: 'Department', purpose: 'Purpose', bookedBy: 'Booked by' },
}

/** How each language joins an address's lines into a location (backend `rendering.COMMA`). */
const COMMA: Record<Language, string> = { ar: '، ', en: ', ' }

/** Who wrote the object, as the backend writes it (`calendar.PRODID`): nothing names the product or a company. */
export const CALENDAR_PRODID = '-//Visits//Visit calendar 1.0//EN'

/** The host's event's UID (backend `event_uid`): stable for the visit's life, no domain, no personal data. */
export function hostEventUid(visitId: string): string {
  return `visit-${visitId}-host`
}

/** A name as one line (backend `one_line`): every run of white space one space, none at either end. */
function oneLine(value: string | null | undefined): string | null {
  return value == null ? null : value.replace(/\s+/g, ' ').trim()
}

/** What `str.splitlines()` splits at, in the backend's `one_line_address`. */
// oxlint-disable-next-line no-control-regex
const ADDRESS_LINE_BREAKS = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/

/**
 * The company's address in a language, on one line (backend `company_addresses`, `one_line_address`):
 * Arabic takes `address_ar`, else `address`; English `address`, else `address_ar`. Each line trimmed of
 * white space and of a closing comma or semicolon, joined by the language's comma. Null when there is none.
 */
export function eventLocation(company: Pick<Me['company'], 'address' | 'address_ar'>, language: Language): string | null {
  const address = language === 'ar' ? company.address_ar || company.address : company.address || company.address_ar
  if (!address) return null
  const lines = address.split(ADDRESS_LINE_BREAKS).map((line) => line.trim().replace(/[,;،]+$/u, '').trim())
  return lines.filter((line) => line !== '').join(COMMA[language]) || null
}

/**
 * The description (backend `_host_event`, `event_description`): a "Label: value" line for each of the
 * visitor, their company, the department, the purpose and who booked the visit when that is not the
 * host, when it has a value.
 */
function eventDescription(visit: Visit, language: Language): string {
  const texts = HOST_EVENT_TEXTS[language]
  const bookedBy = visit.created_by.id === visit.host.id ? null : oneLine(visit.created_by.full_name)
  const details: [string, string | null][] = [
    [texts.visitor, oneLine(visit.visitor.full_name)],
    [texts.company, oneLine(visit.visitor.company_name)],
    [texts.department, visit.department ? oneLine(departmentDisplayName(visit.department, language)) : null],
    [texts.purpose, visit.purpose],
    [texts.bookedBy, bookedBy],
  ]
  return details
    .filter((detail): detail is [string, string] => Boolean(detail[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

/**
 * The host's event of the visit, in `language` (the page's, which is the host's own: their preference,
 * else the company's default, as the backend leads the host's e-mails). DTSTAMP is when the visit last
 * changed: a file without METHOD reads it as the event's last revision (RFC 5545 §3.8.7.2). Private, as
 * the e-mailed one (`CLASS:PRIVATE`, B14-19, F14-29): only the file carries it; Google's and Outlook's
 * links have no parameter for it.
 */
export function hostCalendarEvent(visit: Visit, company: Pick<Me['company'], 'address' | 'address_ar'>, language: Language): CalendarEvent {
  // As the backend's `translate`: the summary is one line of plain spaces. The name goes in by a function:
  // as a replacement string, a `$&`, `$$` or `` $` `` in it would be read as a pattern.
  const visitor = oneLine(visit.visitor.full_name) ?? ''
  const summary = HOST_EVENT_TEXTS[language].summary.replace('{visitor}', () => visitor).replaceAll('\u00a0', ' ')
  return {
    uid: hostEventUid(visit.id),
    sequence: visit.calendar_sequence,
    stamp: visit.updated_at,
    start: visit.scheduled_start,
    end: visit.scheduled_end,
    summary,
    location: eventLocation(company, language),
    description: eventDescription(visit, language),
    private: true,
  }
}

/**
 * Whether the visit page offers the host's event (F14-2): to the visit's host, for a scheduled visit
 * (`SCHEDULED`: not begun, not cancelled, never a walk-in, which begins inside) that has not ended.
 */
export function offersHostCalendar(visit: Visit, userId: string, now: number): boolean {
  return visit.host.id === userId && visit.status === 'SCHEDULED' && !visit.is_walk_in && new Date(visit.scheduled_end).getTime() > now
}

/**
 * The longest link to a calendar's form, in characters as written (an Arabic letter is six, `%D8%B2`;
 * F14-17). A person who is signed out goes through the calendar's sign-in, which carries the whole link
 * again (about three times its length at Google), and a request line over 8 KB is commonly refused
 * (RFC 9110 asks only for 8,000 octets): 2,000 stays under both, as the add-to-calendar docs advise. The
 * `.ics` file carries everything.
 */
export const MAX_LINK_LENGTH = 2000

/** An event's texts as a link carries them; a text cut to nothing is null. */
interface LinkTexts {
  summary: string | null
  location: string | null
  description: string | null
}

/**
 * Google Calendar's new-event form with the event (its `render?action=TEMPLATE` link, times in UTC). The
 * description as HTML (F14-18), as add-to-calendar-button sends it.
 */
export function googleCalendarUrl(event: CalendarEvent): `https://${string}` {
  const dates = `${formatUtc(event.start)}/${formatUtc(event.end)}`
  return fittedLink(event, (texts) =>
    linkWith('https://calendar.google.com/calendar/render', [
      ['action', 'TEMPLATE'],
      ['text', texts.summary],
      ['dates', dates],
      ['details', texts.description && htmlText(texts.description)],
      ['location', texts.location],
    ]),
  )
}

/**
 * Outlook on the web's new-event form with the event: the deeplink of work and school accounts
 * (Microsoft 365, `outlook.office.com`), which is where a company's people keep their calendars (F14-4),
 * in the form add-to-calendar-button sends on every device (F14-18). The body is HTML: Outlook drops a
 * bare line feed.
 */
export function outlookCalendarUrl(event: CalendarEvent): `https://${string}` {
  const [start, end] = [iso(event.start), iso(event.end)]
  return fittedLink(event, (texts) =>
    linkWith('https://outlook.office.com/calendar/0/deeplink/compose', [
      ['path', '/calendar/action/compose'],
      ['rru', 'addevent'],
      ['subject', texts.summary],
      ['startdt', start],
      ['enddt', end],
      ['body', texts.description && htmlText(texts.description)],
      ['location', texts.location],
    ]),
  )
}

/** An instant in ISO 8601, UTC, to the second: `2026-10-06T06:00:00Z`. */
function iso(instant: string | Date): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not an instant: ${String(instant)}`)
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Text as the forms' HTML description takes it (F14-18): `&`, `<`, `>` and `"` escaped, so the words read
 * as written and nothing in them is markup, and each line break a `<br>`.
 */
function htmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>')
}

/** Which texts are cut first when a link is too long: what a calendar shows first is kept longest. */
const CUT_ORDER = ['description', 'location', 'summary'] as const

/**
 * A text's characters as a reader sees them, the grapheme clusters (F14-30): an emoji of several code
 * points (a family joined by ZWJ, a flag, a skin tone, a keycap) or a letter with its vowel mark is one,
 * and a cut between two of them never leaves half of one. Where `Intl.Segmenter` is missing, the code
 * points (half a surrogate pair cannot be encoded at least).
 */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text)
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), ({ segment }) => segment)
}

/**
 * The link `build` writes from the event's texts (each as a calendar holds it, `calendarText`), at most
 * `MAX_LINK_LENGTH` long (F14-17): while it is longer, the description, then the location, then the
 * summary is cut to its longest beginning that fits, between characters as a reader sees them
 * (`graphemes`), and ended with "…"; a text none of which fits is left out.
 */
function fittedLink(event: CalendarEvent, build: (texts: LinkTexts) => `https://${string}`): `https://${string}` {
  const texts: LinkTexts = {
    summary: calendarText(event.summary),
    location: event.location ? calendarText(event.location) : null,
    description: event.description ? calendarText(event.description) : null,
  }
  let link = build(texts)
  for (const name of CUT_ORDER) {
    if (link.length <= MAX_LINK_LENGTH) break
    const characters = graphemes(texts[name] ?? '')
    const cut = (count: number) => (count === 0 ? null : `${characters.slice(0, count).join('').trimEnd()}…`)
    // The most characters that fit, by halving: `fits` does (none, at worst), `fails` does not.
    let [fits, fails] = [0, characters.length]
    while (fails - fits > 1) {
      const middle = Math.floor((fits + fails) / 2)
      if (build({ ...texts, [name]: cut(middle) }).length <= MAX_LINK_LENGTH) fits = middle
      else fails = middle
    }
    texts[name] = cut(fits)
    link = build(texts)
  }
  return link
}

/** A link with its query: each value encoded (`%20`, never `+`); empty ones left out. */
function linkWith(base: `https://${string}`, parameters: [string, string | null | undefined][]): `https://${string}` {
  const query = parameters
    .filter((parameter): parameter is [string, string] => Boolean(parameter[1]))
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')
  return `${base}?${query}`
}

/** The `.ics` file of the event (RFC 5545). */
export function hostCalendarFile(event: CalendarEvent): string {
  return writeCalendar({ prodId: CALENDAR_PRODID, events: [event] })
}

/** The file's name: the visit's day in the company's time zone, nothing about the people (`visit-2026-10-06.ics`). */
export function hostCalendarFileName(visit: Visit, timeZone: string): string {
  return `visit-${toDateKey(visit.scheduled_start, timeZone)}.ics`
}
