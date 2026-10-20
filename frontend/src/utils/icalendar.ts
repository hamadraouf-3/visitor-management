/*
 * A minimal iCalendar writer (RFC 5545) for one event a person adds to their own calendar (Phase 14,
 * F14-3): no recurrence, no time zones (every time is UTC), no scheduling (no METHOD, ORGANIZER or
 * ATTENDEE: the file is the person's own copy, not an invitation). Written by hand, as the backend's
 * own writer is: the format is small, and every rule it needs is here and tested.
 *
 * - Lines end with CRLF, the last one included (§3.1).
 * - A line longer than 75 octets is folded: CRLF and one space, the space counting towards the next
 *   line's 75 (§3.1). Octets of UTF-8, never inside a character: an Arabic letter is two octets, and
 *   a fold falls between letters, never between the two octets of one.
 * - TEXT values escape the backslash, the semicolon, the comma and the line break (§3.3.11); the control
 *   characters TEXT may not hold are dropped, a tab is a space, and the direction controls go too (a
 *   calendar's one-line views close none of them). The rules of the backend's writer
 *   (`app/email/calendar.py`, `text_value`), so a file written here says what the e-mailed event says.
 */

/** One event, its times as instants (ISO strings or dates); written in UTC. */
export interface CalendarEvent {
  /** Globally unique and stable: the same object is the same event in every calendar (§3.8.4.7). */
  uid: string
  /** Revision of the event; a calendar keeps the highest it has seen (§3.8.7.4). */
  sequence: number
  /** When the information of the event last changed (without METHOD, DTSTAMP means that, §3.8.7.2). */
  stamp: string | Date
  start: string | Date
  end: string | Date
  summary: string
  /** Lines of text; omitted when empty. */
  description?: string | null
  location?: string | null
  /**
   * The event is its owner's own business (`CLASS:PRIVATE`, §3.8.1.3): a calendar shared with others
   * shows them the time taken, not what it is (the host's event, as the backend writes it, B14-19).
   */
  private?: boolean
}

export interface CalendarObject {
  /** Who made the object (§3.7.3). */
  prodId: string
  events: readonly CalendarEvent[]
}

/** The longest line, in octets, without its CRLF (§3.1). */
export const MAX_LINE_OCTETS = 75

const CRLF = '\r\n'

/** An instant as a UTC DATE-TIME: `20261006T060000Z` (§3.3.5, form 2). */
export function formatUtc(instant: string | Date): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not an instant: ${String(instant)}`)
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
}

/** A line break: CRLF, CR, LF and the Unicode line and paragraph separators. */
const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g
/** C0 controls but the line breaks, DEL and C1: not allowed in TEXT (§3.3.11, TSAFE-CHAR). A tab is a space first. */
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
/** Explicit embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069). */
const DIRECTION_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g

/**
 * Text as a calendar may hold it, before any escaping: every line break a line feed, a tab a space, no
 * control or direction-control character. The calendar links carry the same text.
 */
export function calendarText(value: string): string {
  return value.replace(LINE_BREAKS, '\n').replace(/\t/g, ' ').replace(CONTROLS, '').replace(DIRECTION_CONTROLS, '')
}

/** A TEXT value (§3.3.11): `calendarText`, then `\` `;` `,` escaped and every line break written `\n`. */
export function escapeText(value: string): string {
  return calendarText(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

/** The UTF-8 length of one code point. */
function octets(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * A content line folded to `MAX_LINE_OCTETS` octets a line (§3.1): the first line holds at most 75
 * octets, each next one a space and at most 74. Whole code points only, so no UTF-8 character is split.
 */
export function foldLine(line: string): string {
  const lines: string[] = []
  let current = ''
  let used = 0
  for (const char of line) {
    const size = octets(char.codePointAt(0)!)
    if (used + size > MAX_LINE_OCTETS) {
      lines.push(current)
      current = ' '
      used = 1
    }
    current += char
    used += size
  }
  lines.push(current)
  return lines.join(CRLF)
}

/** A property with a TEXT value: `SUMMARY:…`. */
function textProperty(name: string, value: string): string {
  return `${name}:${escapeText(value)}`
}

/** A SEQUENCE value: a whole number, never negative; 0 for one that is missing or not a number (never `NaN`). */
function sequenceValue(sequence: number | null | undefined): number {
  return typeof sequence === 'number' && Number.isFinite(sequence) ? Math.max(0, Math.trunc(sequence)) : 0
}

/** The properties in the order of the backend's writer (`write_calendar`); readers take any order. */
function eventLines(event: CalendarEvent): string[] {
  const lines = [
    'BEGIN:VEVENT',
    textProperty('UID', event.uid),
    `SEQUENCE:${sequenceValue(event.sequence)}`,
    `DTSTAMP:${formatUtc(event.stamp)}`,
    `DTSTART:${formatUtc(event.start)}`,
    `DTEND:${formatUtc(event.end)}`,
    textProperty('SUMMARY', event.summary),
  ]
  if (event.location) lines.push(textProperty('LOCATION', event.location))
  if (event.description) lines.push(textProperty('DESCRIPTION', event.description))
  if (event.private) lines.push('CLASS:PRIVATE')
  lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT')
  return lines
}

/** The iCalendar object (`.ics`), its lines folded and each ended by CRLF. */
export function writeCalendar(calendar: CalendarObject): string {
  const lines = ['BEGIN:VCALENDAR', `PRODID:${calendar.prodId}`, 'VERSION:2.0', 'CALSCALE:GREGORIAN', ...calendar.events.flatMap(eventLines), 'END:VCALENDAR']
  return lines.map((line) => foldLine(line) + CRLF).join('')
}
