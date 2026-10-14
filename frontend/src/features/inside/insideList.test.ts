import { describe, expect, it } from 'vitest'
import { makeVisit } from '../../test/fixtures'
import { formatDateAtClockTime, formatTimeOnDay } from '../../utils/datetime'
import { insideSummary, sortForRollCall } from './insideList'

const visit = (id: string, visitor: string, host = 'Omar Khalil', flags: { is_overdue?: boolean; is_stale?: boolean } = {}) =>
  makeVisit({ id, visitor: { id: `v-${id}`, full_name: visitor, company_name: null }, host: { id: 'h', full_name: host, phone: null }, ...flags })

describe('sortForRollCall', () => {
  it('orders by visitor name ignoring case and accents, then host, then id', () => {
    const sorted = sortForRollCall([
      visit('3', 'zara Haddad'),
      visit('1', 'Élodie Martin', 'Sami'),
      visit('2', 'elodie martin', 'Adam'),
      visit('4', 'Ahmad Ali'),
    ])
    expect(sorted.map((item) => item.id)).toEqual(['4', '2', '1', '3'])
  })
})

describe('insideSummary', () => {
  it('takes the headcount from the server and counts the flags', () => {
    const visits = [visit('1', 'A', 'H', { is_overdue: true }), visit('2', 'B', 'H', { is_overdue: true, is_stale: true }), visit('3', 'C')]
    expect(insideSummary(3, visits)).toEqual({ headcount: 3, overdue: 2, previousDays: 1 })
  })
})

describe('time formats of the list in the company time zone', () => {
  // 21:30 UTC on 5 Oct is 00:30 on 6 Oct in Amman (UTC+3); the browser runs in UTC here.
  const now = '2026-10-05T21:30:00Z'

  it('shows only the time for a check-in on the same company-local day', () => {
    expect(formatTimeOnDay('2026-10-05T21:05:00Z', now, 'Asia/Amman')).toBe('00:05')
  })

  it('adds the date for a check-in on an earlier company-local day', () => {
    expect(formatTimeOnDay('2026-10-05T20:55:00Z', now, 'Asia/Amman')).toBe('Mon, 5 Oct 2026, 23:55')
  })

  it('prints the generation time to the second', () => {
    expect(formatDateAtClockTime(Date.parse('2026-10-05T06:31:05.900Z'), 'Asia/Amman')).toBe('Mon, 5 Oct 2026 at 09:31:05')
  })
})
