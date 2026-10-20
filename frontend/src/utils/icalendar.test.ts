import { describe, expect, it } from 'vitest'
import { calendarText, escapeText, foldLine, formatUtc, MAX_LINE_OCTETS, writeCalendar, type CalendarEvent } from './icalendar'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** RFC 5545 §3.1 unfolding: a CRLF followed by one space or tab is removed. */
function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, '')
}

/** RFC 5545 §3.3.11, the reverse of `escapeText`. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === 'n' || char === 'N' ? '\n' : char))
}

/** The content lines of an object, unfolded: name (parameters dropped) → raw value. */
function properties(text: string): [string, string][] {
  return unfold(text)
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => {
      const colon = line.indexOf(':')
      return [line.slice(0, colon).split(';')[0]!, line.slice(colon + 1)]
    })
}

/** The SEQUENCE written for `value`. */
function sequence(value: number): string {
  return properties(writeCalendar({ prodId: '-//x//y//EN', events: [{ ...EVENT, sequence: value }] })).find(([name]) => name === 'SEQUENCE')![1]
}

const EVENT: CalendarEvent = {
  uid: 'visit-5a1b2c3d-0000-4000-8000-000000000001-host',
  sequence: 2,
  stamp: '2026-10-05T06:10:00Z',
  start: '2026-10-06T06:00:00Z',
  end: '2026-10-06T07:00:00.000Z',
  summary: 'Visit: Élodie Martin',
  description: 'Host: Lina Haddad\nPurpose: Review; budget, Q3',
  location: 'King Hussein Business Park, Building 4\\B',
}

describe('formatUtc', () => {
  it('writes an instant as a UTC DATE-TIME, whatever the offset it was given in', () => {
    expect(formatUtc('2026-10-06T06:00:00Z')).toBe('20261006T060000Z')
    expect(formatUtc('2026-10-06T09:00:00+03:00')).toBe('20261006T060000Z')
    expect(formatUtc('2026-12-31T23:59:59.999Z')).toBe('20261231T235959Z')
    expect(formatUtc(new Date(Date.UTC(2027, 0, 2, 3, 4, 5)))).toBe('20270102T030405Z')
  })

  it('refuses what is not an instant', () => {
    expect(() => formatUtc('tomorrow')).toThrow(RangeError)
  })
})

describe('escapeText', () => {
  it('escapes the backslash, the semicolon and the comma, and writes every line break as \\n', () => {
    expect(escapeText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d')
    expect(escapeText('one\r\ntwo\rthree\nfour\u2028five\u2029six')).toBe('one\\ntwo\\nthree\\nfour\\nfive\\nsix')
    // The backslash first: an escape it writes is never escaped again.
    expect(escapeText('\\n')).toBe('\\\\n')
  })

  it('drops the control characters TEXT may not hold and the direction controls; a tab is a space', () => {
    expect(escapeText('a\u0000b\u0007c\u001bd\u007fe\u0085f\tg')).toBe('abcdef g')
    expect(escapeText('\u2067سارة\u2069 \u202bOrbit\u202c')).toBe('سارة Orbit')
    // What the calendar links carry: the same text, not escaped.
    expect(calendarText('Review;\tbudget,\r\nQ3\u2066')).toBe('Review; budget,\nQ3')
  })

  it('leaves Arabic and colons as they are', () => {
    expect(escapeText('زيارة: سارة أحمد، الطابق 3')).toBe('زيارة: سارة أحمد، الطابق 3')
  })

  it('is undone by an RFC 5545 reader', () => {
    const value = 'Purpose: review; budget, Q3\nC:\\temp\\n'
    expect(unescapeText(escapeText(value))).toBe(value)
  })
})

describe('foldLine', () => {
  it('leaves a line of 75 octets as it is', () => {
    const line = `SUMMARY:${'x'.repeat(MAX_LINE_OCTETS - 8)}`
    expect(encoder.encode(line)).toHaveLength(75)
    expect(foldLine(line)).toBe(line)
  })

  it('folds a longer line into lines of at most 75 octets, each next one starting with one space', () => {
    const line = `DESCRIPTION:${'abcdefghij'.repeat(20)}`
    const folded = foldLine(line).split('\r\n')
    expect(folded.length).toBeGreaterThan(2)
    expect(folded.map((part) => encoder.encode(part).length)).toEqual([75, 75, ...folded.slice(2).map((part) => encoder.encode(part).length)])
    for (const part of folded.slice(1)) expect(part.startsWith(' ')).toBe(true)
    expect(unfold(foldLine(line))).toBe(line)
  })

  it('folds Arabic between characters, never inside one, by octets', () => {
    // Two octets a letter: the limit falls inside a letter unless the writer counts octets.
    const line = `SUMMARY:${'زيارة: سارة أحمد، '.repeat(12)}`
    const folded = foldLine(line).split('\r\n')
    for (const part of folded) {
      const bytes = encoder.encode(part)
      expect(bytes.length).toBeLessThanOrEqual(MAX_LINE_OCTETS)
      // Each physical line is valid UTF-8 on its own: no character was cut in two.
      expect(decoder.decode(bytes)).toBe(part)
    }
    // Lines are filled: a fold leaves less than one character's room.
    for (const part of folded.slice(0, -1)) expect(encoder.encode(part).length).toBeGreaterThanOrEqual(MAX_LINE_OCTETS - 1)
    expect(unfold(foldLine(line))).toBe(line)
  })

  it('keeps a character outside the Basic Multilingual Plane whole (four octets, two UTF-16 units)', () => {
    const line = `SUMMARY:${'😀'.repeat(40)}`
    for (const part of foldLine(line).split('\r\n')) expect(decoder.decode(encoder.encode(part))).toBe(part)
    expect(unfold(foldLine(line))).toBe(line)
  })
})

describe('writeCalendar', () => {
  const text = writeCalendar({ prodId: '-//Acme Holdings//Visitors//EN', events: [EVENT] })

  it('ends every line with CRLF, the last one too, and has no bare line feed', () => {
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('is one calendar with one event, in the order RFC 5545 readers expect', () => {
    expect(properties(text).map(([name]) => name)).toEqual([
      'BEGIN',
      'PRODID',
      'VERSION',
      'CALSCALE',
      'BEGIN',
      'UID',
      'SEQUENCE',
      'DTSTAMP',
      'DTSTART',
      'DTEND',
      'SUMMARY',
      'LOCATION',
      'DESCRIPTION',
      'STATUS',
      'TRANSP',
      'END',
      'END',
    ])
    const values = Object.fromEntries(properties(text).filter(([name]) => name !== 'BEGIN' && name !== 'END'))
    expect(values).toMatchObject({
      VERSION: '2.0',
      PRODID: '-//Acme Holdings//Visitors//EN',
      UID: EVENT.uid,
      DTSTAMP: '20261005T061000Z',
      SEQUENCE: '2',
      DTSTART: '20261006T060000Z',
      DTEND: '20261006T070000Z',
      STATUS: 'CONFIRMED',
    })
    expect(unescapeText(values.SUMMARY!)).toBe(EVENT.summary)
    expect(unescapeText(values.DESCRIPTION!)).toBe(EVENT.description)
    expect(unescapeText(values.LOCATION!)).toBe(EVENT.location)
  })

  it('is not an invitation: no METHOD, ORGANIZER or ATTENDEE', () => {
    expect(properties(text).map(([name]) => name)).not.toEqual(expect.arrayContaining(['METHOD']))
    expect(text).not.toMatch(/^(ORGANIZER|ATTENDEE)/m)
  })

  it('leaves out an empty description and location', () => {
    const bare = writeCalendar({ prodId: '-//x//y//EN', events: [{ ...EVENT, description: '', location: null }] })
    expect(bare).not.toContain('DESCRIPTION')
    expect(bare).not.toContain('LOCATION')
  })

  it('writes CLASS:PRIVATE for a private event, before STATUS, and nothing for another', () => {
    const lines = writeCalendar({ prodId: '-//x//y//EN', events: [{ ...EVENT, private: true }] }).split('\r\n')
    expect(lines.indexOf('CLASS:PRIVATE')).toBeGreaterThan(-1)
    expect(lines.indexOf('CLASS:PRIVATE') + 1).toBe(lines.indexOf('STATUS:CONFIRMED'))
    expect(writeCalendar({ prodId: '-//x//y//EN', events: [EVENT] })).not.toContain('CLASS')
  })

  it('writes a whole SEQUENCE of zero or more, and 0 for one that is missing or not a number (never NaN)', () => {
    expect([0, 1, 7].map(sequence)).toEqual(['0', '1', '7'])
    expect(sequence(-1)).toBe('0')
    expect(sequence(2.9)).toBe('2')
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null]) expect(sequence(value as number)).toBe('0')
  })

  it('folds an Arabic event into valid lines that read back to the same texts', () => {
    const arabic: CalendarEvent = {
      ...EVENT,
      summary: 'زيارة: سارة أحمد من شركة الأفق للاستشارات الهندسية والتجارية',
      description: 'المضيف: لينا حداد\nالقسم: المالية\nالغرض من الزيارة: مراجعة الميزانية الفصلية، وخطة العام القادم؛ ومتابعة العقود',
      location: 'مجمع الملك حسين للأعمال، المبنى 4، عمّان',
    }
    const written = writeCalendar({ prodId: '-//Acme Holdings//Visitors//EN', events: [arabic] })
    for (const line of written.split('\r\n').slice(0, -1)) {
      const bytes = encoder.encode(line)
      expect(bytes.length).toBeLessThanOrEqual(MAX_LINE_OCTETS)
      expect(decoder.decode(bytes)).toBe(line)
    }
    const values = Object.fromEntries(properties(written).filter(([name]) => name !== 'BEGIN' && name !== 'END'))
    expect(unescapeText(values.SUMMARY!)).toBe(arabic.summary)
    expect(unescapeText(values.DESCRIPTION!)).toBe(arabic.description)
    expect(unescapeText(values.LOCATION!)).toBe(arabic.location)
  })
})
