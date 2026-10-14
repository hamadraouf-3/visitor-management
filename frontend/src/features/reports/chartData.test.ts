import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import {
  dailySummaryText,
  departmentBars,
  departmentRows,
  fillDailySeries,
  fillHourlySeries,
  formatAverageDuration,
  formatRate,
  formatShare,
  labelIndices,
  niceTicks,
  summarizeSeries,
  todaySoFar,
} from './chartData'

describe('fillDailySeries', () => {
  it('has one point per day of the range, with 0 for days without visits', () => {
    const series = fillDailySeries(
      [
        { date: '2026-09-29', count: 4 },
        { date: '2026-10-02', count: 7 },
      ],
      '2026-09-28',
      '2026-10-02',
    )
    expect(series.map((point) => [point.key, point.value])).toEqual([
      ['2026-09-28', 0],
      ['2026-09-29', 4],
      ['2026-09-30', 0],
      ['2026-10-01', 0],
      ['2026-10-02', 7],
    ])
    expect(series[3]).toMatchObject({ axisLabel: '1 Oct', label: 'Thu, 1 Oct 2026' })
  })

  it('crosses month and leap-day boundaries by calendar date, whatever the clocks do', () => {
    // 29 Mar 2026 is a DST change in Europe; dates are calendar keys, so nothing shifts.
    const series = fillDailySeries([], '2028-02-27', '2028-03-01')
    expect(series.map((point) => point.key)).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'])
  })

  it('ignores days outside the range and adds up repeated days', () => {
    const series = fillDailySeries(
      [
        { date: '2026-09-01', count: 9 },
        { date: '2026-10-01', count: 2 },
        { date: '2026-10-01', count: 3 },
      ],
      '2026-10-01',
      '2026-10-01',
    )
    expect(series).toEqual([{ key: '2026-10-01', axisLabel: '1 Oct', label: 'Thu, 1 Oct 2026', value: 5 }])
  })
})

describe('fillHourlySeries', () => {
  it('has all 24 hours of the day, 0 to 23, with 0 for hours without check-ins', () => {
    const series = fillHourlySeries([
      { hour: 9, count: 12 },
      { hour: 0, count: 1 },
      { hour: 23, count: 2 },
      { hour: 24, count: 99 },
      { hour: -1, count: 99 },
    ])
    expect(series).toHaveLength(24)
    expect(series.map((point) => point.value)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])
    expect(series[9]).toMatchObject({ key: '9', axisLabel: '09', label: '09:00–\u206009:59' })
  })
})

describe('departmentBars', () => {
  const items = [
    { department_id: 'a', name: 'Finance', name_ar: null, count: 5 },
    { department_id: null, name: 'No department', name_ar: null, count: 9 },
    { department_id: 'b', name: 'Legal', name_ar: null, count: 5 },
    { department_id: 'c', name: 'Empty', name_ar: null, count: 0 },
  ]

  it('sorts by visits, then name, and leaves out departments without visits', () => {
    expect(departmentBars(items).map((bar) => [bar.key, bar.value])).toEqual([
      ['none', 9],
      ['a', 5],
      ['b', 5],
    ])
  })

  it('names visits without a department in the UI language, not with the API’s English name', async () => {
    await i18n.changeLanguage('ar')
    expect(departmentBars(items)[0]).toMatchObject({ key: 'none', label: 'بدون قسم', axisLabel: 'بدون قسم' })
    expect(departmentRows(items).find((row) => row.key === 'none')?.label).toBe('بدون قسم')
    await i18n.changeLanguage('en')
    expect(departmentBars(items)[0]?.label).toBe('No department')
  })

  it('names each department in the UI language: its Arabic name in Arabic when it has one (phase 10 shared contract B)', () => {
    const named = [
      { department_id: 'a', name: 'Finance', name_ar: 'المالية', count: 5 },
      { department_id: 'b', name: 'Legal', name_ar: null, count: 5 },
      { department_id: 'c', name: 'Administration', name_ar: 'الإدارة', count: 5 },
    ]
    expect(departmentRows(named, 'en').map((row) => row.label)).toEqual(['Administration', 'Finance', 'Legal'])
    // Ties sorted by the shown name: «الإدارة» before «المالية»; Legal keeps its name.
    expect(departmentRows(named, 'ar').map((row) => [row.label, row.axisLabel])).toEqual([
      ['الإدارة', 'الإدارة'],
      ['المالية', 'المالية'],
      ['Legal', 'Legal'],
    ])
    expect(departmentBars(named, 2, 'ar').map((bar) => bar.label)).toEqual(['الإدارة', 'أقسام أخرى (2)'])
  })

  it('folds the tail into one "Other departments" bar', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ department_id: `d${index}`, name: `Dept ${index}`, name_ar: null, count: 20 - index }))
    const bars = departmentBars(many, 8)
    expect(bars).toHaveLength(8)
    expect(bars.at(-1)).toMatchObject({ key: 'other', label: 'Other departments (5)', value: 9 + 10 + 11 + 12 + 13 })
    expect(departmentRows(many)).toHaveLength(12)
  })
})

describe('axes and summaries', () => {
  it('rounds ticks to 1, 2 or 5 times a power of ten', () => {
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
    expect(niceTicks(42)).toEqual([0, 20, 40, 60])
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(1300)).toEqual([0, 500, 1000, 1500])
  })

  it('spreads axis labels evenly without crowding the last one', () => {
    expect(labelIndices(24, 8)).toEqual([0, 3, 6, 9, 12, 15, 18, 23])
    expect(labelIndices(24, 12)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 23])
    expect(labelIndices(30, 10)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 29])
    expect(labelIndices(5, 10)).toEqual([0, 1, 2, 3, 4])
    expect(labelIndices(0, 10)).toEqual([])
  })

  it('keeps a regular rhythm to the end of an axis that need not be named (hours)', () => {
    expect(labelIndices(24, 8, { nameEnd: false })).toEqual([0, 3, 6, 9, 12, 15, 18, 21])
    expect(labelIndices(24, 12, { nameEnd: false })).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22])
    expect(labelIndices(24, 5, { nameEnd: false })).toEqual([0, 5, 10, 15, 20])
  })

  it('finds the total and the first peak', () => {
    const series = fillHourlySeries([
      { hour: 8, count: 3 },
      { hour: 10, count: 3 },
    ])
    expect(summarizeSeries(series)).toMatchObject({ total: 6, peak: { key: '8' }, max: 3, partial: null })
    expect(summarizeSeries(fillHourlySeries([])).peak).toBeNull()
  })
})

const visits = (count: number) => `${count} ${count === 1 ? 'visit' : 'visits'}`

describe('today in the daily series (still under way)', () => {
  const points = [
    { date: '2026-10-04', count: 9 },
    { date: '2026-10-06', count: 27 },
  ]

  it('marks today as partial and says so in its label (readout, table and the mark’s name)', () => {
    const series = fillDailySeries(points, '2026-10-04', '2026-10-06', '2026-10-06')
    expect(series.map((point) => Boolean(point.partial))).toEqual([false, false, true])
    expect(series[2]!.label).toBe(`Tue, 6 Oct 2026 (${todaySoFar()})`)
    expect(fillDailySeries(points, '2026-10-04', '2026-10-06').some((point) => point.partial)).toBe(false)
  })

  it('never makes an unfinished today the peak, but keeps it in the total and at the top of the axis', () => {
    const summary = summarizeSeries(fillDailySeries(points, '2026-10-04', '2026-10-06', '2026-10-06'))
    expect(summary).toMatchObject({ total: 36, max: 27, peak: { key: '2026-10-04' }, partial: { key: '2026-10-06', value: 27 } })
  })

  it('names the busiest full day and today’s count so far', () => {
    expect(dailySummaryText(fillDailySeries(points, '2026-10-04', '2026-10-06', '2026-10-06'), visits)).toBe(
      '36 visits over 3 days. The busiest full day was Sun, 4 Oct 2026, with 9 visits. Today so far: 27 visits.',
    )
    expect(dailySummaryText(fillDailySeries(points, '2026-10-04', '2026-10-06'), visits)).toBe(
      '36 visits over 3 days. The busiest day was Tue, 6 Oct 2026, with 27 visits.',
    )
    // A period of today alone has no full day.
    expect(dailySummaryText(fillDailySeries(points, '2026-10-06', '2026-10-06', '2026-10-06'), visits)).toBe(
      '27 visits over 1 day. Today so far: 27 visits.',
    )
    expect(dailySummaryText(fillDailySeries([], '2026-10-04', '2026-10-06', '2026-10-06'), visits)).toBe('No visits over 3 days.')
  })

  it('formats rates, durations and shares', () => {
    expect(formatRate(0.125)).toBe('12.5%')
    expect(formatRate(0.25)).toBe('25%')
    expect(formatRate(0.05)).toBe('5.0%')
    expect(formatRate(0)).toBe('0%')
    expect(formatRate(null)).toBe('—')
    expect(formatAverageDuration(4380)).toBe('1h 13m')
    expect(formatAverageDuration(null)).toBe('—')
    expect(formatShare(310, 1000)).toBe('31.0%')
    expect(formatShare(1, 3)).toBe('33.3%')
    expect(formatShare(1, 0)).toBe('—')
  })
})
