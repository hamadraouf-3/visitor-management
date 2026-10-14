import { describe, expect, it } from 'vitest'
import { makeDashboard } from '../../test/fixtures'
import { filteredEmptyTitle, MY_VISITS_PAGE_SIZE, MY_VISITS_SHOW_OPTIONS, readShow, tabCount, visitListParamsForTab } from './myVisitsTabs'

const AMMAN = 'Asia/Amman' // UTC+3
// 10:00 on Mon 5 Oct 2026 in Amman.
const NOW = '2026-10-05T07:00:00Z'

describe('visitListParamsForTab', () => {
  it('maps Today to the company-local day and every status the dashboard counts (all but cancelled), earliest first', () => {
    // The badge is counts.today, which leaves out cancelled visits (B24-31); the list must count the same set.
    expect(visitListParamsForTab({ tab: 'today', show: 'default', q: '', page: 1 }, AMMAN, NOW)).toEqual({
      scope: 'mine',
      page: 1,
      page_size: MY_VISITS_PAGE_SIZE,
      status: ['SCHEDULED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW'],
      date_from: '2026-10-05',
      date_to: '2026-10-05',
      order: 'asc',
    })
  })

  it('maps Upcoming to scheduled visits from tomorrow on, earliest first', () => {
    expect(visitListParamsForTab({ tab: 'upcoming', show: 'default', q: '', page: 2 }, AMMAN, NOW)).toEqual({
      scope: 'mine',
      page: 2,
      page_size: MY_VISITS_PAGE_SIZE,
      status: ['SCHEDULED'],
      date_from: '2026-10-06',
      order: 'asc',
    })
  })

  it('maps Past to every visit before today, latest first', () => {
    expect(visitListParamsForTab({ tab: 'past', show: 'default', q: '', page: 1 }, AMMAN, NOW)).toEqual({
      scope: 'mine',
      page: 1,
      page_size: MY_VISITS_PAGE_SIZE,
      date_to: '2026-10-04',
      order: 'desc',
    })
  })

  it('maps Needs attention to the server rule, without a date range or statuses', () => {
    expect(visitListParamsForTab({ tab: 'attention', show: 'default', q: '', page: 1 }, AMMAN, NOW)).toEqual({
      scope: 'mine',
      page: 1,
      page_size: MY_VISITS_PAGE_SIZE,
      needs_attention: true,
      order: 'asc',
    })
  })

  it('finds the cancelled visits of each period, which the default views leave out', () => {
    expect(visitListParamsForTab({ tab: 'today', show: 'cancelled', q: '', page: 1 }, AMMAN, NOW)).toMatchObject({
      status: ['CANCELLED'],
      date_from: '2026-10-05',
      date_to: '2026-10-05',
    })
    expect(visitListParamsForTab({ tab: 'upcoming', show: 'cancelled', q: '', page: 1 }, AMMAN, NOW)).toMatchObject({
      status: ['CANCELLED'],
      date_from: '2026-10-06',
    })
    expect(visitListParamsForTab({ tab: 'past', show: 'cancelled', q: '', page: 1 }, AMMAN, NOW)).toMatchObject({
      status: ['CANCELLED'],
      date_to: '2026-10-04',
    })
    expect(visitListParamsForTab({ tab: 'past', show: 'attended', q: '', page: 1 }, AMMAN, NOW).status).toEqual(['CHECKED_IN', 'CHECKED_OUT'])
    expect(visitListParamsForTab({ tab: 'past', show: 'no-show', q: '', page: 1 }, AMMAN, NOW).status).toEqual(['NO_SHOW'])
  })

  it('adds the trimmed search text and leaves out an empty one', () => {
    expect(visitListParamsForTab({ tab: 'past', show: 'default', q: '  orbit  ', page: 1 }, AMMAN, NOW).q).toBe('orbit')
    expect(visitListParamsForTab({ tab: 'past', show: 'default', q: '   ', page: 1 }, AMMAN, NOW)).not.toHaveProperty('q')
  })

  it('uses the company calendar, not the browser one, around midnight', () => {
    // 21:30 UTC on 5 Oct is already 00:30 on Tue 6 Oct in Amman; the test browser runs in UTC.
    const lateEvening = '2026-10-05T21:30:00Z'
    const at = (tab: 'today' | 'upcoming' | 'past', zone = AMMAN) => visitListParamsForTab({ tab, show: 'default', q: '', page: 1 }, zone, lateEvening)
    expect(at('today')).toMatchObject({ date_from: '2026-10-06', date_to: '2026-10-06' })
    expect(at('upcoming').date_from).toBe('2026-10-07')
    expect(at('past').date_to).toBe('2026-10-05')
    // The same instant in a zone behind UTC is still 5 Oct.
    expect(at('today', 'America/New_York').date_from).toBe('2026-10-05')
  })
})

describe('readShow', () => {
  it('accepts only the choices the tab offers', () => {
    expect(readShow('upcoming', 'cancelled')).toBe('cancelled')
    expect(readShow('upcoming', 'attended')).toBe('default')
    expect(readShow('attention', 'cancelled')).toBe('default')
    expect(readShow('past', null)).toBe('default')
    expect(MY_VISITS_SHOW_OPTIONS.attention).toEqual([])
  })

  it('names the empty list of a status choice', () => {
    expect(filteredEmptyTitle('today', 'cancelled')).toBe('No cancelled visits today')
    expect(filteredEmptyTitle('upcoming', 'cancelled')).toBe('No cancelled upcoming visits')
    expect(filteredEmptyTitle('past', 'attended')).toBe('No attended past visits')
    expect(filteredEmptyTitle('past', 'no-show')).toBe('No past no-shows')
  })
})

describe('tabCount', () => {
  it('shows the dashboard counts on Today, Upcoming and Needs attention only', () => {
    const counts = makeDashboard({ today: 3, upcoming: 7, needs_attention: 2 }).counts
    expect(tabCount('today', counts)).toBe(3)
    expect(tabCount('upcoming', counts)).toBe(7)
    expect(tabCount('attention', counts)).toBe(2)
    expect(tabCount('past', counts)).toBeUndefined()
    expect(tabCount('today', undefined)).toBeUndefined()
  })
})
