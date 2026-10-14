import { describe, expect, it } from 'vitest'
import {
  matchingPreset,
  presetRange,
  rangeDays,
  readReportRange,
  reportRangeChanges,
  reportRangeError,
  reportSummaryParams,
} from './reportRange'

const TODAY = '2026-10-05'

describe('presets', () => {
  it('end today and include it', () => {
    expect(presetRange('last-7', TODAY)).toEqual({ from: '2026-09-29', to: TODAY })
    expect(presetRange('last-30', TODAY)).toEqual({ from: '2026-09-06', to: TODAY })
    expect(rangeDays(presetRange('last-30', TODAY))).toBe(30)
    expect(rangeDays(presetRange('last-90', TODAY))).toBe(90)
    expect(presetRange('this-month', TODAY)).toEqual({ from: '2026-10-01', to: TODAY })
  })

  it('cover whole calendar months and years', () => {
    expect(presetRange('last-month', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(presetRange('last-month', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(presetRange('last-month', '2027-01-10')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(presetRange('last-12-months', TODAY)).toEqual({ from: '2025-10-06', to: TODAY })
    // Across 29 February the year has 366 days, which is still allowed.
    const leap = presetRange('last-12-months', '2028-02-29')
    expect(leap).toEqual({ from: '2027-03-01', to: '2028-02-29' })
    expect(rangeDays(leap)).toBe(366)
    expect(reportRangeError(leap.from, leap.to)).toBeNull()
  })

  it('are recognised from their dates', () => {
    expect(matchingPreset({ from: '2026-09-06', to: TODAY }, TODAY)).toBe('last-30')
    expect(matchingPreset({ from: '2026-09-07', to: TODAY }, TODAY)).toBeNull()
  })
})

describe('the range in the URL', () => {
  it('defaults to the last 30 days, written as no parameters', () => {
    expect(readReportRange(new URLSearchParams(), TODAY)).toEqual({ from: '2026-09-06', to: TODAY })
    expect(readReportRange(new URLSearchParams({ from: '2026-09-01' }), TODAY)).toEqual({ from: '2026-09-06', to: TODAY })
    expect(readReportRange(new URLSearchParams({ from: '2026-13-01', to: TODAY }), TODAY)).toEqual({ from: '2026-09-06', to: TODAY })
    expect(reportRangeChanges({ from: '2026-09-06', to: TODAY }, TODAY)).toEqual({ from: null, to: null })
  })

  it('keeps any other range', () => {
    const range = { from: '2026-01-01', to: '2026-03-31' }
    expect(readReportRange(new URLSearchParams(range), TODAY)).toEqual(range)
    expect(reportRangeChanges(range, TODAY)).toEqual(range)
    expect(reportSummaryParams(range)).toEqual({ date_from: '2026-01-01', date_to: '2026-03-31' })
  })
})

describe('reportRangeError', () => {
  it('needs both dates, in order, and at most 366 days', () => {
    expect(reportRangeError(null, TODAY)).toBe('Choose a start and an end date.')
    expect(reportRangeError(TODAY, '2026-10-04')).toBe('Choose an end date on or after the start date.')
    expect(reportRangeError('2025-10-04', TODAY)).toBe('Choose a range of at most 366 days.')
    expect(reportRangeError('2025-10-05', TODAY)).toBeNull()
    expect(reportRangeError(TODAY, TODAY)).toBeNull()
  })
})
