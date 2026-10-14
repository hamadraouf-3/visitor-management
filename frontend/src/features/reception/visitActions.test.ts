import { describe, expect, it } from 'vitest'
import { defaultCheckOutAt, toCorrectedCheckOut, validateCorrectedCheckOut, validateReason } from './checkOutForms'
import { insideVisit, RECEPTION_NOW, receptionVisit } from './testing/receptionFixtures'
import { makeSearchItem } from '../../test/fixtures'
import type { Visit } from '../../types/api'
import { formatTimeOnDay } from '../../utils/datetime'
import {
  arrivalStatus,
  bulkCheckOutAt,
  checkedInLabel,
  checkInTimeAndStay,
  expectedGroup,
  isBulkCheckOutCandidate,
  listCanCheckOut,
  listCheckIn,
  matchesVisitFilter,
  orderSearchResults,
  overrideContext,
  rowAction,
  timeInside,
  withTodayNoShows,
} from './visitActions'

const TZ = 'Asia/Amman'
const at = (iso: string) => Date.parse(iso)

// Default visit: scheduled 09:00–10:00 Amman (06:00–07:00Z), pass window 08:00–11:00 (05:00–08:00Z).
describe('listCheckIn', () => {
  it('is MANUAL inside the pass window and OVERRIDE outside it', () => {
    const visit = receptionVisit()
    expect(listCheckIn(visit, at('2026-10-06T05:00:00Z'))).toBe('manual')
    expect(listCheckIn(visit, at('2026-10-06T08:00:00Z'))).toBe('manual')
    expect(listCheckIn(visit, at('2026-10-06T04:59:00Z'))).toBe('override')
    expect(listCheckIn(visit, at('2026-10-06T08:01:00Z'))).toBe('override')
  })

  it('is OVERRIDE for a no-show and nothing when the server allows no check-in', () => {
    expect(listCheckIn(receptionVisit({ status: 'NO_SHOW' }), RECEPTION_NOW.getTime())).toBe('override')
    expect(listCheckIn(receptionVisit({ permissions: { can_check_in: false } }), RECEPTION_NOW.getTime())).toBeNull()
  })
})

describe('listCanCheckOut', () => {
  it('needs a checked-in visit the server allows to check out', () => {
    expect(listCanCheckOut(insideVisit())).toBe(true)
    expect(listCanCheckOut(insideVisit({ permissions: { can_check_out: false } }))).toBe(false)
    expect(listCanCheckOut(receptionVisit())).toBe(false)
  })
})

describe('arrivalStatus', () => {
  const visit = receptionVisit()
  it.each([
    ['2026-10-06T04:30:00Z', 'Pass valid from 08:00', 'neutral'],
    ['2026-10-06T05:30:00Z', 'Due 09:00', 'info'],
    ['2026-10-06T06:30:00Z', 'Expected now', 'success'],
    ['2026-10-06T07:30:00Z', 'Late · pass valid until 11:00', 'warning'],
    ['2026-10-06T08:30:00Z', 'Pass expired 11:00', 'warning'],
  ])('at %s: %s', (now, label, tone) => {
    expect(arrivalStatus(visit, at(now), TZ)).toEqual({ label, tone })
  })

  it('names a no-show', () => {
    expect(arrivalStatus(receptionVisit({ status: 'NO_SHOW' }), at('2026-10-06T09:00:00Z'), TZ).label).toBe('No-show · pass expired 11:00')
  })
})

describe('overrideContext', () => {
  it('says why the pass cannot be used', () => {
    expect(overrideContext(receptionVisit(), at('2026-10-06T04:00:00Z'), TZ)).toBe('The pass is valid from 08:00.')
    expect(overrideContext(receptionVisit({ status: 'NO_SHOW' }), at('2026-10-06T09:00:00Z'), TZ)).toBe('The pass expired at 11:00.')
  })
})

describe('check-in time and time inside', () => {
  it('shows today’s time alone and an earlier day with its date', () => {
    const now = RECEPTION_NOW.getTime()
    expect(formatTimeOnDay(insideVisit().check_in_at!, now, TZ)).toBe('09:02')
    expect(formatTimeOnDay('2026-10-05T14:00:00Z', now, TZ)).toBe('Mon, 5 Oct 2026, 17:00')
    expect(timeInside(insideVisit(), now)).toBe('8m')
  })

  it('is worded once for the lists, the search and the result: "Checked in 09:02 · 8m inside"', () => {
    const now = RECEPTION_NOW.getTime()
    expect(checkInTimeAndStay(insideVisit(), now, TZ)).toBe('09:02 · 8m inside')
    expect(checkedInLabel(insideVisit(), now, TZ)).toBe('Checked in 09:02 · 8m inside')
    expect(checkedInLabel(insideVisit({ check_in_at: '2026-10-05T14:00:00Z' }), now, TZ)).toBe('Checked in Mon, 5 Oct 2026, 17:00 · 16h 10m inside')
  })

  it('says when a visitor who has left checked out, and counts their stay up to then, not up to now', () => {
    const now = RECEPTION_NOW.getTime() + 4 * 3_600_000
    const left = insideVisit({ status: 'CHECKED_OUT', check_out_at: '2026-10-06T06:50:00Z', check_out_method: 'MANUAL' })
    expect(timeInside(left, now)).toBe('48m')
    expect(checkInTimeAndStay(left, now, TZ)).toBe('09:02 · out 09:50')
  })
})

describe('expectedGroup', () => {
  it('is "later" until the pass window opens, then "arriving" (also when late)', () => {
    const visit = receptionVisit()
    expect(expectedGroup(visit, at('2026-10-06T04:59:00Z'))).toBe('later')
    expect(expectedGroup(visit, at('2026-10-06T05:00:00Z'))).toBe('arriving')
    expect(expectedGroup(visit, at('2026-10-06T08:30:00Z'))).toBe('arriving')
  })
})

describe('rowAction (one rule for the Expected list and "Find a visitor")', () => {
  it('is "Verify ID & check in" inside the pass window', () => {
    expect(rowAction(receptionVisit(), at('2026-10-06T05:00:00Z'))).toBe('manual')
  })

  it('is "Check in anyway…" for a late visitor and a no-show today', () => {
    expect(rowAction(receptionVisit(), at('2026-10-06T08:01:00Z'))).toBe('override')
    expect(rowAction(receptionVisit({ status: 'NO_SHOW' }), RECEPTION_NOW.getTime())).toBe('override')
  })

  it('keeps an early check-in in the row’s menu until the pass window opens', () => {
    expect(rowAction(receptionVisit(), at('2026-10-06T04:59:00Z'))).toBe('override-in-menu')
  })

  it('offers a walk-in when the server will not check the visit in (inactive host)', () => {
    expect(rowAction(receptionVisit({ permissions: { can_check_in: false } }), RECEPTION_NOW.getTime())).toBe('walk-in')
  })

  it('is Check out for a visitor inside, and nothing when the server allows no check-out', () => {
    expect(rowAction(insideVisit(), RECEPTION_NOW.getTime())).toBe('check-out')
    expect(rowAction(insideVisit({ permissions: { can_check_out: false } }), RECEPTION_NOW.getTime())).toBeNull()
  })
})

const searchItem = (id: string, todayVisits: Visit[]) => makeSearchItem({ id, full_name: id, today_visits: todayVisits })
const scheduledAt = (id: string, start: string) => receptionVisit({ id, scheduled_start: start })

function noShow(id: string, visitorId: string): Visit {
  return receptionVisit({ id, status: 'NO_SHOW', visitor: { id: visitorId, full_name: 'Sara Haddad', company_name: null } })
}

describe('withTodayNoShows', () => {
  it('adds today’s no-shows to the visitor they belong to, once', () => {
    const scheduled = receptionVisit({ id: 'scheduled', visitor: { id: 'v3', full_name: 'Sara Haddad', company_name: null } })
    const [sara, other] = withTodayNoShows(
      [makeSearchItem({ id: 'v3', today_visits: [scheduled] }), makeSearchItem({ id: 'v9', today_visits: [] })],
      [noShow('late', 'v3'), noShow('late', 'v3'), noShow('someone-else', 'v7')],
    )
    expect(sara?.today_visits.map((visit) => visit.id)).toEqual(['scheduled', 'late'])
    expect(other?.today_visits).toEqual([])
  })

  it('makes a visitor with only a no-show today one reception can act on', () => {
    const results = orderSearchResults(
      withTodayNoShows([makeSearchItem({ id: 'v1', full_name: 'Amal Chen' }), makeSearchItem({ id: 'v3', full_name: 'Sara Haddad' })], [noShow('late', 'v3')]),
    )
    expect(results.map((result) => result.full_name)).toEqual(['Sara Haddad', 'Amal Chen'])
    expect(rowAction(results[0]!.today_visits[0]!, RECEPTION_NOW.getTime())).toBe('override')
  })
})

describe('orderSearchResults', () => {
  it('puts visitors inside first, then those expected today by start time, then the rest in the server’s order', () => {
    const results = orderSearchResults([
      searchItem('Amal Chen', []),
      searchItem('Bilal Chen', [scheduledAt('late', '2026-10-06T14:15:00Z')]),
      searchItem('Carla Chen', []),
      searchItem('Dana Chen', [insideVisit({ id: 'inside' })]),
      searchItem('Eli Chen', [scheduledAt('early', '2026-10-06T07:00:00Z')]),
    ])
    expect(results.map((result) => result.full_name)).toEqual(['Dana Chen', 'Eli Chen', 'Bilal Chen', 'Amal Chen', 'Carla Chen'])
  })

  it('orders each visitor’s own visits the same way', () => {
    const [result] = orderSearchResults([
      searchItem('Dana Chen', [scheduledAt('later', '2026-10-06T14:00:00Z'), insideVisit({ id: 'inside' }), scheduledAt('sooner', '2026-10-06T12:00:00Z')]),
    ])
    expect(result?.today_visits.map((visit) => visit.id)).toEqual(['inside', 'sooner', 'later'])
  })
})

describe('isBulkCheckOutCandidate (B57-71)', () => {
  it('takes visitors from an earlier day whose visit has ended, and only those reception may check out', () => {
    expect(isBulkCheckOutCandidate(insideVisit({ is_stale: true, is_overdue: true }))).toBe(true)
    // A night visit still under way keeps "Previous day" but stays inside.
    expect(isBulkCheckOutCandidate(insideVisit({ is_stale: true, is_overdue: false }))).toBe(false)
    expect(isBulkCheckOutCandidate(insideVisit({ is_stale: false, is_overdue: true }))).toBe(false)
    expect(isBulkCheckOutCandidate(insideVisit({ is_stale: true, is_overdue: true, permissions: { can_check_out: false } }))).toBe(false)
  })
})

describe('bulkCheckOutAt', () => {
  const now = at('2026-10-06T06:10:00Z')
  it('is the scheduled end, or the check-in when that was later, never after now (B57-16)', () => {
    const scheduledEnd = '2026-10-05T15:00:00Z'
    expect(bulkCheckOutAt({ check_in_at: '2026-10-05T14:00:00Z', scheduled_end: scheduledEnd }, now)).toBe(at(scheduledEnd))
    expect(bulkCheckOutAt({ check_in_at: '2026-10-05T16:00:00Z', scheduled_end: scheduledEnd }, now)).toBe(at('2026-10-05T16:00:00Z'))
    expect(bulkCheckOutAt({ check_in_at: '2026-10-05T20:00:00Z', scheduled_end: '2026-10-06T18:00:00Z' }, now)).toBe(now)
  })
})

describe('matchesVisitFilter', () => {
  const visit = receptionVisit()
  it('matches visitor, company, host, department and purpose, ignoring case and accents', () => {
    expect(matchesVisitFilter(visit, 'elodie')).toBe(true)
    expect(matchesVisitFilter(visit, 'ORBIT')).toBe(true)
    expect(matchesVisitFilter(visit, 'khalil')).toBe(true)
    expect(matchesVisitFilter(visit, 'finance')).toBe(true)
    expect(matchesVisitFilter(visit, 'quarterly')).toBe(true)
    expect(matchesVisitFilter(visit, 'nobody')).toBe(false)
    expect(matchesVisitFilter(visit, '   ')).toBe(true)
  })
})

describe('corrected check-out', () => {
  const now = at('2026-10-06T12:00:00Z')

  it('defaults to the scheduled end, never before the check-in and never in the future', () => {
    expect(defaultCheckOutAt(insideVisit(), now)).toBe('2026-10-06T07:00:00.000Z')
    expect(defaultCheckOutAt(insideVisit({ check_in_at: '2026-10-06T07:30:00Z' }), now)).toBe('2026-10-06T07:30:00.000Z')
    expect(defaultCheckOutAt(insideVisit(), at('2026-10-06T06:30:00Z'))).toBe('2026-10-06T06:30:00.000Z')
  })

  it('requires a time between the check-in and now, and a note', () => {
    const visit = insideVisit()
    expect(validateCorrectedCheckOut({ checkOutAt: null, note: '' }, visit, now, TZ)).toEqual({
      checkOutAt: 'Choose the date and time the visitor left.',
      note: 'Explain the correction, e.g. "Left at 17:00 without checking out".',
    })
    expect(validateCorrectedCheckOut({ checkOutAt: '2026-10-06T06:00:00Z', note: 'x' }, visit, now, TZ).checkOutAt).toBe(
      'Choose a time after the check-in (Tue, 6 Oct 2026, 09:02).',
    )
    expect(validateCorrectedCheckOut({ checkOutAt: '2026-10-06T12:05:00Z', note: 'x' }, visit, now, TZ).checkOutAt).toBe(
      'The time the visitor left cannot be in the future.',
    )
    expect(validateCorrectedCheckOut({ checkOutAt: '2026-10-06T07:00:00Z', note: 'Left at 10:00' }, visit, now, TZ)).toEqual({})
  })

  it('sends the instant and the trimmed note', () => {
    expect(toCorrectedCheckOut({ checkOutAt: '2026-10-06T07:00:00.000Z', note: '  Left at 10:00  ' })).toEqual({
      method: 'CORRECTED',
      check_out_at: '2026-10-06T07:00:00.000Z',
      note: 'Left at 10:00',
    })
  })
})

describe('validateReason', () => {
  it('requires 1–300 characters after trimming', () => {
    expect(validateReason('   ', 'Enter a reason.')).toBe('Enter a reason.')
    // Invisible characters only (a zero-width space, a byte-order mark): no reason at all.
    expect(validateReason('\u200b', 'Enter a reason.')).toBe('Enter a reason.')
    expect(validateReason(' \ufeff\u2060 ', 'Enter a reason.')).toBe('Enter a reason.')
    expect(validateReason('x'.repeat(301), 'Enter a reason.')).toBe('Enter at most 300 characters.')
    expect(validateReason(` ${'x'.repeat(300)} `, 'Enter a reason.')).toBeUndefined()
  })
})
