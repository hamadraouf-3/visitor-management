import { describe, expect, it } from 'vitest'
import {
  activeHistoryFilterCount,
  clearHistoryFilterChanges,
  EMPTY_HISTORY_FILTERS,
  HISTORY_PAGE_SIZE,
  historyFilterChanges,
  historyListParams,
  isHistorySearchable,
  parseStatuses,
  readHistoryFilters,
} from './historyFilters'
import { visitMethodBadges } from './visitMethods'

const HOST_ID = '7f0d1c0e-1111-4a5b-9c1d-000000000077'
const DEPARTMENT_ID = '7f0d1c0e-2222-4a5b-9c1d-000000000002'

describe('readHistoryFilters', () => {
  it('reads every filter from the URL', () => {
    const params = new URLSearchParams({
      from: '2026-09-01',
      to: '2026-09-30',
      status: 'CHECKED_OUT,NO_SHOW',
      host: HOST_ID,
      hostName: 'Omar Khalil',
      department: DEPARTMENT_ID,
      q: '  orbit  ',
    })
    expect(readHistoryFilters(params)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      statuses: ['CHECKED_OUT', 'NO_SHOW'],
      // The URL's name is only a hint to look the host up by; the filter never shows it as such.
      host: { id: HOST_ID, nameHint: 'Omar Khalil' },
      departmentId: DEPARTMENT_ID,
      q: 'orbit',
    })
  })

  it('ignores malformed values instead of sending them', () => {
    const params = new URLSearchParams({
      from: '2026-02-30',
      to: 'yesterday',
      status: 'EXPIRED,checked_in,,CHECKED_IN',
      host: 'not-a-uuid',
      department: '42',
    })
    expect(readHistoryFilters(params)).toEqual({ ...EMPTY_HISTORY_FILTERS, statuses: ['CHECKED_IN'] })
  })

  it('reads a host without a name in the URL', () => {
    expect(readHistoryFilters(new URLSearchParams({ host: HOST_ID.toUpperCase() })).host).toEqual({ id: HOST_ID, nameHint: null })
  })
})

describe('parseStatuses', () => {
  it('keeps known statuses once, in lifecycle order', () => {
    expect(parseStatuses('CANCELLED,SCHEDULED,CANCELLED')).toEqual(['SCHEDULED', 'CANCELLED'])
    expect(parseStatuses(null)).toEqual([])
  })
})

describe('historyFilterChanges', () => {
  it('writes only the changed filters and always returns to page 1', () => {
    expect(historyFilterChanges({ statuses: ['NO_SHOW', 'SCHEDULED'] })).toEqual({ page: null, status: 'SCHEDULED,NO_SHOW' })
    expect(historyFilterChanges({ host: { id: HOST_ID, nameHint: 'Omar Khalil' } })).toEqual({ page: null, host: HOST_ID, hostName: 'Omar Khalil' })
    expect(historyFilterChanges({ from: '2026-10-01', to: null })).toEqual({ page: null, from: '2026-10-01', to: null })
    expect(historyFilterChanges({ q: '  ' })).toEqual({ page: null, q: null })
  })

  it('writes no status when every status or none is selected', () => {
    expect(historyFilterChanges({ statuses: ['SCHEDULED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED'] }).status).toBeNull()
    expect(historyFilterChanges({ statuses: [] }).status).toBeNull()
  })

  it('clears everything', () => {
    expect(clearHistoryFilterChanges()).toEqual({
      page: null,
      from: null,
      to: null,
      status: null,
      host: null,
      hostName: null,
      department: null,
      q: null,
    })
  })
})

describe('historyListParams', () => {
  it('asks for every visit of the company, newest first, with the filters', () => {
    expect(
      historyListParams(
        {
          from: '2026-09-01',
          to: '2026-09-30',
          statuses: ['CHECKED_OUT'],
          host: { id: HOST_ID, nameHint: 'Omar' },
          departmentId: DEPARTMENT_ID,
          q: 'orbit',
        },
        3,
      ),
    ).toEqual({
      scope: 'all',
      order: 'desc',
      page: 3,
      page_size: HISTORY_PAGE_SIZE,
      date_from: '2026-09-01',
      date_to: '2026-09-30',
      status: ['CHECKED_OUT'],
      host_id: HOST_ID,
      department_id: DEPARTMENT_ID,
      q: 'orbit',
    })
  })

  it('leaves out filters that are not set', () => {
    expect(historyListParams(EMPTY_HISTORY_FILTERS, 1)).toEqual({ scope: 'all', order: 'desc', page: 1, page_size: HISTORY_PAGE_SIZE })
  })

  it('sends the search only from three characters (B57-65: shorter ones read every visit)', () => {
    expect(historyListParams({ ...EMPTY_HISTORY_FILTERS, q: 'el' }, 1)).not.toHaveProperty('q')
    expect(historyListParams({ ...EMPTY_HISTORY_FILTERS, q: 'eli' }, 1)?.q).toBe('eli')
    // Counted once case and accents are folded; an accent is not a character of its own.
    expect(isHistorySearchable('E\u0301l')).toBe(false)
    expect(isHistorySearchable('سمر')).toBe(true)
    expect(isHistorySearchable('079')).toBe(true)
    expect(activeHistoryFilterCount({ ...EMPTY_HISTORY_FILTERS, q: 'el' })).toBe(0)
  })

  it('makes no request for an end date before the start date', () => {
    expect(historyListParams({ ...EMPTY_HISTORY_FILTERS, from: '2026-10-05', to: '2026-10-04' }, 1)).toBeNull()
  })
})

describe('activeHistoryFilterCount', () => {
  it('counts the date range once', () => {
    expect(activeHistoryFilterCount(EMPTY_HISTORY_FILTERS)).toBe(0)
    expect(activeHistoryFilterCount({ ...EMPTY_HISTORY_FILTERS, from: '2026-10-01', to: '2026-10-02', q: 'xyz', statuses: ['NO_SHOW'] })).toBe(3)
  })
})

describe('visitMethodBadges', () => {
  it('flags overrides, walk-ins, corrected and bulk check-outs', () => {
    expect(visitMethodBadges({ check_in_method: 'QR', check_out_method: 'MANUAL', is_walk_in: false })).toEqual([])
    expect(
      visitMethodBadges({ check_in_method: 'OVERRIDE', check_out_method: 'CORRECTED', is_walk_in: false }).map((badge) => badge.label),
    ).toEqual(['Override', 'Corrected check-out'])
    expect(visitMethodBadges({ check_in_method: 'WALK_IN', check_out_method: 'BULK', is_walk_in: true }).map((badge) => badge.flag)).toEqual([
      'WALK_IN',
      'BULK',
    ])
  })
})
