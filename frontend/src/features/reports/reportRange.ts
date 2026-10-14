import { readDateParam, type UrlParamChanges } from '../../hooks/useUrlParams'
import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { ReportSummaryParams } from '../../types/api'
import { isDateKey, shiftDateKey } from '../../utils/datetime'

/** §8: a report covers at most 366 days; without a choice, the last 30 (today included). */
export const REPORT_MAX_DAYS = 366
export const REPORT_DEFAULT_DAYS = 30

export const REPORT_PARAM = { from: 'from', to: 'to' } as const

export const REPORT_PRESETS = ['last-7', 'last-30', 'last-90', 'this-month', 'last-month', 'last-12-months'] as const
export type ReportPreset = (typeof REPORT_PRESETS)[number]

const t = i18n.getFixedT(null, ['reports', 'common'])

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = lazyTexts({
  'last-7': () => t('presets.last7'),
  'last-30': () => t('presets.last30'),
  'last-90': () => t('presets.last90'),
  'this-month': () => t('presets.thisMonth'),
  'last-month': () => t('presets.lastMonth'),
  'last-12-months': () => t('presets.last12Months'),
})

export interface ReportRange {
  /** Company-local `YYYY-MM-DD`, inclusive. */
  from: string
  to: string
}

/** Days in an inclusive range of date keys ("2026-10-01".."2026-10-01" is 1). */
export function rangeDays({ from, to }: ReportRange): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1
}

function firstOfMonth(dateKey: string): string {
  return `${dateKey.slice(0, 8)}01`
}

/** The range a preset stands for on the company-local day `today`. */
export function presetRange(preset: ReportPreset, today: string): ReportRange {
  switch (preset) {
    case 'last-7':
      return { from: shiftDateKey(today, -6), to: today }
    case 'last-30':
      return { from: shiftDateKey(today, -(REPORT_DEFAULT_DAYS - 1)), to: today }
    case 'last-90':
      return { from: shiftDateKey(today, -89), to: today }
    case 'this-month':
      return { from: firstOfMonth(today), to: today }
    case 'last-month': {
      const lastDay = shiftDateKey(firstOfMonth(today), -1)
      return { from: firstOfMonth(lastDay), to: lastDay }
    }
    case 'last-12-months':
      // From the day after the same date a year ago: 365 days, 366 across a 29 February.
      return { from: shiftDateKey(yearAgo(today), 1), to: today }
  }
}

/** The same calendar day one year earlier (29 Feb becomes 28 Feb). */
function yearAgo(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4)) - 1
  const candidate = `${year}${dateKey.slice(4)}`
  return isDateKey(candidate) ? candidate : `${year}-02-28`
}

/** The preset a range matches on `today`, or null for a custom range. */
export function matchingPreset(range: ReportRange, today: string): ReportPreset | null {
  return REPORT_PRESETS.find((preset) => {
    const candidate = presetRange(preset, today)
    return candidate.from === range.from && candidate.to === range.to
  }) ?? null
}

/** The range in the URL, or the default (last 30 days) when either end is missing or malformed. */
export function readReportRange(params: URLSearchParams, today: string): ReportRange {
  const from = readDateParam(params, REPORT_PARAM.from)
  const to = readDateParam(params, REPORT_PARAM.to)
  if (from !== null && to !== null) return { from, to }
  return presetRange('last-30', today)
}

/** URL changes for a range; the default range is written as no parameters. */
export function reportRangeChanges(range: ReportRange, today: string): UrlParamChanges {
  const isDefault = matchingPreset(range, today) === 'last-30'
  return { [REPORT_PARAM.from]: isDefault ? null : range.from, [REPORT_PARAM.to]: isDefault ? null : range.to }
}

/** Why a range cannot be reported on, or null. Both ends are required. */
export function reportRangeError(from: string | null, to: string | null): string | null {
  if (from === null || to === null) return t('range.bothRequired')
  if (to < from) return t('common:dates.rangeEndBeforeStart')
  if (rangeDays({ from, to }) > REPORT_MAX_DAYS) return t('range.tooLong', { count: REPORT_MAX_DAYS })
  return null
}

/** GET /reports/summary parameters: the range is always sent, so the page and the server agree on it. */
export function reportSummaryParams(range: ReportRange): ReportSummaryParams {
  return { date_from: range.from, date_to: range.to }
}
