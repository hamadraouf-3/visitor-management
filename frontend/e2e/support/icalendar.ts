import { BACKEND_DIR, PYTHON } from './paths.ts'
import { run } from './processes.ts'

/*
 * Calendar objects read by a real iCalendar parser (Phase 14): the `icalendar` package of the backend's
 * virtual environment (a test dependency of the backend, `requirements-dev.txt`), run in isolated mode
 * on the text it is given. Whatever the writer (the backend's e-mails, the SPA's download) got wrong in
 * escaping, folding or structure shows here as a parse error or a different value.
 */

/** One VEVENT as the parser reads it: texts unescaped and unfolded, times as UTC ISO strings. */
export interface ParsedEvent {
  /** The calendar's METHOD (an iTIP message's), or null for a plain object. */
  method: string | null
  prodId: string
  uid: string
  sequence: number
  start: string
  end: string
  summary: string
  description: string | null
  location: string | null
  status: string | null
  organizer: string | null
  attendee: string | null
  /** The attendee's RSVP parameter, as written. */
  rsvp: string | null
  /** The event's CLASS (`PRIVATE` for the host's, B14-19), or null. */
  classification: string | null
}

const SCRIPT = `
import json, sys
from datetime import timezone
from icalendar import Calendar
calendar = Calendar.from_ical(sys.stdin.buffer.read())
def text(component, name):
    value = component.get(name)
    return None if value is None else str(value)
events = []
for event in calendar.walk("VEVENT"):
    attendee = event.get("attendee")
    events.append({
        "method": text(calendar, "method"),
        "prodId": text(calendar, "prodid"),
        "uid": text(event, "uid"),
        "sequence": int(event.get("sequence", 0)),
        "start": event.decoded("dtstart").astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "end": event.decoded("dtend").astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "summary": text(event, "summary"),
        "description": text(event, "description"),
        "location": text(event, "location"),
        "status": text(event, "status"),
        "organizer": text(event, "organizer"),
        "attendee": None if attendee is None else str(attendee),
        "rsvp": None if attendee is None else attendee.params.get("RSVP"),
        "classification": text(event, "class"),
    })
print(json.dumps(events))
`

/** The events of an iCalendar object, read by the `icalendar` package. */
export async function parseCalendar(text: string): Promise<ParsedEvent[]> {
  const result = await run(PYTHON, ['-I', '-c', SCRIPT], { cwd: BACKEND_DIR, env: process.env, input: text, timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(`The iCalendar parser refused the object (exit ${result.code}): ${result.stderr}`)
  return JSON.parse(result.stdout) as ParsedEvent[]
}

const CR = 0x0d
const LF = 0x0a

/**
 * The rules of the text itself (RFC 5545 §3.1) that a lenient parser forgives: CRLF line ends, at most 75
 * octets a line, valid UTF-8 in each. Read from the file's octets, as written: text decoded first would
 * have replaced a character cut in two by a fold with U+FFFD, and hidden it.
 */
export function lineProblems(octets: Uint8Array): string[] {
  const bytes = Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength)
  const problems: string[] = []
  if (bytes.at(-2) !== CR || bytes.at(-1) !== LF) problems.push('the last line has no CRLF')
  if (bytes.some((byte, at) => (byte === LF && bytes[at - 1] !== CR) || (byte === CR && bytes[at + 1] !== LF))) problems.push('a line ends without CRLF')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let start = 0
  for (let index = 0; start <= bytes.length; index += 1) {
    const end = bytes.indexOf('\r\n', start)
    const line = bytes.subarray(start, end === -1 ? bytes.length : end)
    if (line.length > 75) problems.push(`line ${index + 1} has ${line.length} octets`)
    try {
      decoder.decode(line)
    } catch {
      problems.push(`line ${index + 1} is not UTF-8 on its own`)
    }
    if (end === -1) break
    start = end + 2
  }
  return problems
}
