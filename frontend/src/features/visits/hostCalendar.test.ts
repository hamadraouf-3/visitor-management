// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeVisit, ME_ID, VISIT_ID } from '../../test/fixtures'
import type { Visit } from '../../types/api'
import {
  CALENDAR_PRODID,
  eventLocation,
  googleCalendarUrl,
  HOST_EVENT_TEXTS,
  hostCalendarEvent,
  hostCalendarFile,
  hostCalendarFileName,
  hostEventUid,
  MAX_LINK_LENGTH,
  offersHostCalendar,
  outlookCalendarUrl,
} from './hostCalendar'

const BACKEND_APP = fileURLToPath(new URL('../../../../backend/app', import.meta.url))
const COMPANY = { address: 'King Hussein Business Park\nBuilding 4,\nAmman', address_ar: 'مجمع الملك حسين للأعمال\nالمبنى 4،\nعمّان' }
const NOW = Date.parse('2026-10-05T06:10:00Z')
const PASS_TOKEN = 'Yp4_wL0-bR3sU8nO5cM9dZ2aX7fI6kQ1tE-hG_vJl3B'

/** The content lines of an `.ics`, unfolded (RFC 5545 §3.1), by name. */
function properties(text: string): Record<string, string> {
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n')
  return Object.fromEntries(lines.filter((line) => line.includes(':')).map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]))
}

describe('the host’s event of a visit', () => {
  it('is the e-mailed event: its UID, its SEQUENCE, the visit’s times in UTC, in English', () => {
    const visit = makeVisit({ calendar_sequence: 0, created_by: { id: ME_ID, full_name: 'Lina Haddad' } })
    const event = hostCalendarEvent(visit, COMPANY, 'en')
    expect(event).toEqual({
      uid: `visit-${VISIT_ID}-host`,
      sequence: 0,
      stamp: visit.updated_at,
      start: '2026-10-06T06:00:00Z',
      end: '2026-10-06T07:00:00Z',
      summary: 'Visit: Élodie Martin',
      location: 'King Hussein Business Park, Building 4, Amman',
      // The host booked it: no "Booked by".
      description: 'Visitor: Élodie Martin\nCompany: Orbit Labs\nDepartment: Finance\nPurpose: Quarterly review',
      // Private, as the e-mailed one (B14-19): only the file carries it, a link cannot.
      private: true,
    })
  })

  it('speaks Arabic in the Arabic UI: the Arabic summary, labels, department name and address', () => {
    const visit = makeVisit({ department: { id: 'd', name: 'Finance', name_ar: 'المالية' } })
    const event = hostCalendarEvent(visit, COMPANY, 'ar')
    expect(event.summary).toBe('زيارة: Élodie Martin')
    expect(event.location).toBe('مجمع الملك حسين للأعمال، المبنى 4، عمّان')
    expect(event.description).toBe('الزائر: Élodie Martin\nالشركة: Orbit Labs\nالقسم: المالية\nالغرض من الزيارة: Quarterly review')
  })

  it('names who booked the visit when that is not the host, and leaves out what the visit does not have', () => {
    const visit = makeVisit({
      created_by: { id: 'someone-else', full_name: '  Amal\nHaddad ' },
      visitor: { id: 'v', full_name: 'Sara  Ahmad', company_name: null },
      department: null,
    })
    expect(hostCalendarEvent(visit, { address: null, address_ar: null }, 'en')).toMatchObject({
      summary: 'Visit: Sara Ahmad',
      location: null,
      description: 'Visitor: Sara Ahmad\nPurpose: Quarterly review\nBooked by: Amal Haddad',
    })
  })

  it('puts a name in the summary as it is: no `$` in it is read as a replacement pattern', () => {
    for (const name of ['A$&B', 'Ke$$ha', 'x $` y', "Jo $' Ann", '$1 Nour']) {
      const visit = makeVisit({ visitor: { id: 'v', full_name: name, company_name: null } })
      expect(hostCalendarEvent(visit, COMPANY, 'en').summary).toBe(`Visit: ${name}`)
      expect(hostCalendarEvent(visit, COMPANY, 'ar').summary).toBe(`زيارة: ${name}`)
    }
  })

  it('keeps the UID and raises the SEQUENCE as the visit changes', () => {
    const first = hostCalendarFile(hostCalendarEvent(makeVisit({ calendar_sequence: 0 }), COMPANY, 'en'))
    const moved = hostCalendarFile(
      hostCalendarEvent(makeVisit({ calendar_sequence: 1, scheduled_start: '2026-10-07T08:30:00Z', scheduled_end: '2026-10-07T09:00:00Z' }), COMPANY, 'en'),
    )
    expect(properties(first)).toMatchObject({ UID: `visit-${VISIT_ID}-host`, SEQUENCE: '0', DTSTART: '20261006T060000Z', DTEND: '20261006T070000Z' })
    expect(properties(moved)).toMatchObject({ UID: `visit-${VISIT_ID}-host`, SEQUENCE: '1', DTSTART: '20261007T083000Z', DTEND: '20261007T090000Z' })
    expect(properties(first)).toMatchObject({ PRODID: CALENDAR_PRODID, STATUS: 'CONFIRMED', CLASS: 'PRIVATE' })
    expect(hostEventUid('abc')).toBe('visit-abc-host')
  })

  it('names its file by the visit’s day in the company’s time zone, nothing about the people', () => {
    expect(hostCalendarFileName(makeVisit({ scheduled_start: '2026-10-06T22:30:00Z' }), 'Asia/Amman')).toBe('visit-2026-10-07.ics')
  })
})

describe('the location', () => {
  it('is the address of the UI’s language, else the other one, on one line', () => {
    expect(eventLocation(COMPANY, 'en')).toBe('King Hussein Business Park, Building 4, Amman')
    expect(eventLocation({ address: null, address_ar: 'عمّان' }, 'en')).toBe('عمّان')
    expect(eventLocation({ address: 'Amman', address_ar: null }, 'ar')).toBe('Amman')
    expect(eventLocation({ address: 'Amman', address_ar: '' }, 'ar')).toBe('Amman')
    expect(eventLocation({ address: '  \n ,\n', address_ar: null }, 'en')).toBeNull()
    expect(eventLocation({ address: null, address_ar: null }, 'ar')).toBeNull()
  })
})

/** Whether the page offers the event of a visit with `overrides` to `userId`, at NOW. */
function offers(overrides: Partial<Visit>, userId = ME_ID): boolean {
  return offersHostCalendar(makeVisit(overrides), userId, NOW)
}

describe('when the visit page offers it', () => {
  it('to the host of a scheduled visit that has not ended', () => {
    expect(offers({})).toBe(true)
    expect(offers({}, 'another-user')).toBe(false)
  })

  it('never for a visit that began, ended, was cancelled or is a walk-in', () => {
    expect(offers({ status: 'CHECKED_IN' })).toBe(false)
    expect(offers({ status: 'CHECKED_OUT' })).toBe(false)
    expect(offers({ status: 'CANCELLED' })).toBe(false)
    expect(offers({ status: 'NO_SHOW' })).toBe(false)
    expect(offers({ is_walk_in: true })).toBe(false)
    expect(offers({ scheduled_start: '2026-10-05T05:00:00Z', scheduled_end: '2026-10-05T06:10:00Z' })).toBe(false)
  })
})

/** The description a link carries, as plain text again. */
function plain(html: string): string {
  return html.replace(/<br>/g, '\n').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

/** Where the reader's characters (grapheme clusters) of `text` end, in UTF-16 units. */
function clusterEnds(text: string): Set<number> {
  const ends = new Set([0])
  let at = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) ends.add((at += segment.length))
  return ends
}

/** `count` times one Arabic letter. */
function letters(count: number, letter = 'ب'): string {
  return letter.repeat(count)
}

describe('the calendar links', () => {
  const event = hostCalendarEvent(makeVisit({ purpose: 'Review; budget, Q3 & plans' }), COMPANY, 'en')
  const DESCRIPTION_HTML = 'Visitor: Élodie Martin<br>Company: Orbit Labs<br>Department: Finance<br>Purpose: Review; budget, Q3 &amp; plans'

  it('open Google Calendar’s new-event form with the event, its times in UTC, its description as HTML', () => {
    const url = new URL(googleCalendarUrl(event))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'TEMPLATE',
      text: 'Visit: Élodie Martin',
      dates: '20261006T060000Z/20261006T070000Z',
      details: DESCRIPTION_HTML,
      location: 'King Hussein Business Park, Building 4, Amman',
    })
    // Spaces are %20: a `+` would be read as a plus by a reader that is not a form.
    expect(googleCalendarUrl(event)).not.toContain('+')
  })

  it('open Outlook on the web’s new-event form (work and school accounts), its body as HTML', () => {
    const url = new URL(outlookCalendarUrl(event))
    expect(url.origin + url.pathname).toBe('https://outlook.office.com/calendar/0/deeplink/compose')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: 'Visit: Élodie Martin',
      startdt: '2026-10-06T06:00:00Z',
      enddt: '2026-10-06T07:00:00Z',
      body: DESCRIPTION_HTML,
      location: 'King Hussein Business Park, Building 4, Amman',
    })
  })

  it('write a description of several lines with `&`, `<`, `>`, `"` and Arabic as HTML that reads as written', () => {
    const visit = makeVisit({
      visitor: { id: 'v', full_name: 'Tom & Jerry <Ltd>', company_name: 'شركة "الأفق" & شركاه' },
      purpose: 'مراجعة الميزانية\nA < B & C > D\r\n"quoted" <b>not bold</b>',
    })
    const arabic = hostCalendarEvent(visit, COMPANY, 'ar')
    const html =
      'الزائر: Tom &amp; Jerry &lt;Ltd&gt;<br>الشركة: شركة &quot;الأفق&quot; &amp; شركاه<br>القسم: Finance<br>' +
      'الغرض من الزيارة: مراجعة الميزانية<br>A &lt; B &amp; C &gt; D<br>&quot;quoted&quot; &lt;b&gt;not bold&lt;/b&gt;'
    for (const [link, name] of [
      [googleCalendarUrl(arabic), 'details'],
      [outlookCalendarUrl(arabic), 'body'],
    ] as const) {
      const url = new URL(link)
      expect(url.searchParams.get(name)).toBe(html)
      // No line feed is left for a form to drop, and no `&` of the text breaks the query.
      expect(link).not.toMatch(/%0A|%0D/)
    }
    // The subject and the title stay plain text, their `&` and `<` as they are (Outlook reads its subject's
    // `%26` right again: add-to-calendar-button dropped its full-width ampersand in v2.9.0).
    expect(new URL(outlookCalendarUrl(arabic)).searchParams.get('subject')).toBe('زيارة: Tom & Jerry <Ltd>')
    expect(new URL(googleCalendarUrl(arabic)).searchParams.get('text')).toBe('زيارة: Tom & Jerry <Ltd>')
    expect(outlookCalendarUrl(arabic)).not.toContain('FF06')
    // The file keeps the plain text.
    expect(properties(hostCalendarFile(arabic)).DESCRIPTION).toContain('A < B & C > D\\n"quoted" <b>not bold</b>')
  })

  it('carry Arabic intact', () => {
    const arabic = hostCalendarEvent(makeVisit({ visitor: { id: 'v', full_name: 'سارة أحمد', company_name: null } }), COMPANY, 'ar')
    expect(new URL(googleCalendarUrl(arabic)).searchParams.get('text')).toBe('زيارة: سارة أحمد')
    expect(new URL(outlookCalendarUrl(arabic)).searchParams.get('location')).toBe('مجمع الملك حسين للأعمال، المبنى 4، عمّان')
  })

  it('are never longer than the bound: the description is cut first, between characters, with “…”', () => {
    // The longest Arabic texts the API allows: a 200-letter name, company and booker, a 120-letter
    // department, a 500-letter purpose.
    const visit = makeVisit({
      visitor: { id: 'v', full_name: letters(200, 'س'), company_name: letters(200, 'ش') },
      department: { id: 'd', name: 'Finance', name_ar: letters(120, 'ق') },
      purpose: `${letters(497)} 😀😀😀`,
      created_by: { id: 'someone-else', full_name: letters(200, 'ح') },
    })
    const longest = hostCalendarEvent(visit, COMPANY, 'ar')
    for (const [link, name] of [
      [googleCalendarUrl(longest), 'details'],
      [outlookCalendarUrl(longest), 'body'],
    ] as const) {
      expect(link.length).toBeLessThanOrEqual(MAX_LINK_LENGTH)
      // Close to the bound: no more is cut than needed.
      expect(link.length).toBeGreaterThan(MAX_LINK_LENGTH - 60)
      const url = new URL(link)
      const description = url.searchParams.get(name)!
      expect(description.endsWith('…')).toBe(true)
      expect(description.startsWith(`الزائر: ${letters(10, 'س')}`)).toBe(true)
      // The summary and the location whole.
      expect(url.searchParams.get(name === 'details' ? 'text' : 'subject')).toBe(longest.summary)
      expect(url.searchParams.get('location')).toBe(longest.location)
    }
    // The file carries everything.
    expect(properties(hostCalendarFile(longest)).DESCRIPTION).toContain('😀😀😀')
  })

  it('cut the location, then the summary, when the description alone is not enough, never inside a character', () => {
    // A 1,000-letter address: the description goes, the address is cut, the summary stays.
    const longAddress = { address: null, address_ar: `${letters(990, 'ع')} \u{1F468}\u200D\u{1F469}\u200D\u{1F467} عمّان` }
    const farAway = hostCalendarEvent(makeVisit({ visitor: { id: 'v', full_name: letters(200, 'س'), company_name: null } }), longAddress, 'ar')
    for (const link of [googleCalendarUrl(farAway), outlookCalendarUrl(farAway)]) {
      expect(link.length).toBeLessThanOrEqual(MAX_LINK_LENGTH)
      const url = new URL(link)
      expect(url.searchParams.get('details') ?? url.searchParams.get('body')).toBeNull()
      expect(url.searchParams.get('location')!.endsWith('…')).toBe(true)
      expect(url.searchParams.get('text') ?? url.searchParams.get('subject')).toBe(farAway.summary)
    }
  })

  // A reader's character of several code points: a family joined by ZWJ, a flag, a skin tone, a keycap,
  // Arabic letters with their vowel marks, an emoji beside a letter.
  const CLUSTERS: [string, string][] = [
    ['a family (ZWJ)', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['a flag', '\u{1F1F8}\u{1F1E6}'],
    ['a skin tone', '\u{1F44D}\u{1F3FD}'],
    ['a keycap', '1\uFE0F\u20E3'],
    ['Arabic with vowel marks', '\u0645\u064F\u062D\u064E\u0645\u0651\u064E\u062F\u064C '],
    ['Arabic and an emoji', '\u0628\u{1F600}'],
  ]

  it.each(CLUSTERS)('cut %s whole, wherever the cut falls', (_, cluster) => {
    const cuts = new Set<number>()
    // A longer lead moves the cut across every code point of the clusters after it.
    for (let lead = 0; lead < 16; lead += 1) {
      const clustered = hostCalendarEvent(makeVisit({ purpose: `${'x'.repeat(lead)}${cluster.repeat(400)}` }), COMPANY, 'ar')
      const ends = clusterEnds(clustered.description!)
      for (const [link, name] of [
        [googleCalendarUrl(clustered), 'details'],
        [outlookCalendarUrl(clustered), 'body'],
      ] as const) {
        expect(link.length).toBeLessThanOrEqual(MAX_LINK_LENGTH)
        const text = plain(new URL(link).searchParams.get(name)!)
        expect(text.endsWith('…')).toBe(true)
        const kept = text.slice(0, -1).trimEnd()
        expect(clustered.description!.startsWith(kept)).toBe(true)
        expect(ends.has(kept.length)).toBe(true)
        cuts.add(kept.length - lead)
      }
    }
    // The cut did move against the clusters, not stay on one spot.
    expect(cuts.size).toBeGreaterThan(1)
  })

  it('cut between code points where Intl.Segmenter is missing: never half a surrogate pair', () => {
    const { Segmenter } = Intl
    const intl = Intl as { Segmenter?: unknown }
    intl.Segmenter = undefined
    try {
      for (let lead = 0; lead < 4; lead += 1) {
        const emoji = hostCalendarEvent(makeVisit({ purpose: `${'x'.repeat(lead)}${'\u{1F600}'.repeat(600)}` }), COMPANY, 'en')
        for (const link of [googleCalendarUrl(emoji), outlookCalendarUrl(emoji)]) {
          const url = new URL(link)
          const text = url.searchParams.get('details') ?? url.searchParams.get('body')!
          expect(text.endsWith('\u{1F600}…')).toBe(true)
        }
      }
    } finally {
      intl.Segmenter = Segmenter
    }
  })

  it('leave a short event whole', () => {
    for (const link of [googleCalendarUrl(event), outlookCalendarUrl(event)]) expect(decodeURIComponent(link)).not.toContain('…')
  })

  it('carry Arabic intact', () => {
    const arabic = hostCalendarEvent(makeVisit({ visitor: { id: 'v', full_name: 'سارة أحمد', company_name: null } }), COMPANY, 'ar')
    expect(new URL(googleCalendarUrl(arabic)).searchParams.get('text')).toBe('زيارة: سارة أحمد')
    expect(new URL(outlookCalendarUrl(arabic)).searchParams.get('location')).toBe('مجمع الملك حسين للأعمال، المبنى 4، عمّان')
  })

  it('and the file never hold a pass link or token: the visit has none, and nothing else is read', () => {
    const visit = makeVisit()
    const written = [googleCalendarUrl(hostCalendarEvent(visit, COMPANY, 'en')), outlookCalendarUrl(hostCalendarEvent(visit, COMPANY, 'ar')), hostCalendarFile(hostCalendarEvent(visit, COMPANY, 'en'))]
    for (const text of written) {
      expect(text).not.toContain(PASS_TOKEN)
      expect(text).not.toMatch(/\/pass|#/)
    }
  })
})

/*
 * The host's event says what the e-mailed one says: its words, its UID and its PRODID are the backend's,
 * read here from the backend's source (as `auditVocabulary.test.ts` reads it), so a change there fails here.
 */
/** A module of the backend's app, its line ends LF. */
function backend(path: string): string {
  return readFileSync(join(BACKEND_APP, path), 'utf8').replaceAll('\r\n', '\n')
}

describe('the backend’s host event', () => {
  const catalog = backend('email/i18n.py')
  const entry = (key: string) => {
    const match = new RegExp(`"${key.replaceAll('.', '\\.')}":\\s*\\{\\s*EN:\\s*"([^"]*)",\\s*AR:\\s*"([^"]*)"`).exec(catalog)
    if (!match) throw new Error(`${key} not found in the backend's catalog`)
    return { en: match[1]!, ar: match[2]! }
  }

  it('has the same words', () => {
    const keys = { summary: 'calendar.host_summary', visitor: 'label.visitor', company: 'label.company', department: 'label.department', purpose: 'label.purpose', bookedBy: 'label.booked_by' } as const
    for (const language of ['en', 'ar'] as const) {
      const words = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, entry(key)[language]]))
      expect(HOST_EVENT_TEXTS[language]).toEqual(words)
    }
  })

  it('lists the same details in the same order, with no line after them', () => {
    const service = backend('email/service.py')
    const body = /def _host_event\([\s\S]*?\n {4}def /.exec(service)?.[0] ?? ''
    const details = /details = \(([\s\S]*?)\n {8}\)/.exec(body)?.[1] ?? ''
    expect([...details.matchAll(/"(label\.[a-z_]+)"/g)].map((match) => match[1])).toEqual(['label.visitor', 'label.company', 'label.department', 'label.purpose', 'label.booked_by'])
    expect(body).toContain('description=event_description(lead, details),')
    // Private (B14-19): the file of the visit page says so too.
    expect(body).toContain('private=True,')
  })

  it('has the same UID and PRODID', () => {
    const calendar = backend('email/calendar.py')
    expect(calendar).toContain('return f"visit-{visit_id}-{role}"')
    expect(calendar).toContain(`PRODID = "${CALENDAR_PRODID}"`)
  })
})
