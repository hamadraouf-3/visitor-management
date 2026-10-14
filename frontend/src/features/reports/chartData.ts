import { currentLanguage, i18n, type Language } from '../../i18n'
import { departmentDisplayName } from '../../i18n/departmentName'
import type { ReportSummary } from '../../types/api'
import { formatDateKey, formatDayMonth, joinTimeRange, shiftDateKey } from '../../utils/datetime'
import { formatDuration } from '../../utils/duration'
import { formatNumber } from '../../utils/number'

const t = i18n.getFixedT(null, 'reports')

/** One mark of a single-series chart. */
export interface ChartDatum {
  key: string
  /** Short axis label ("5 Oct", "09"). */
  axisLabel: string
  /** Full label for the readout, the data table and assistive technology ("Mon, 5 Oct 2026"). */
  label: string
  value: number
  /**
   * The period is still under way (today): its value will grow, so the chart draws it as an
   * in-progress mark and it never counts as the busiest.
   */
  partial?: boolean
}

/** Added to today's label wherever the day is named: the readout, the data table and the mark's name. */
export function todaySoFar(language: Language = currentLanguage()): string {
  return t('charts.todaySoFar', { lng: language })
}

/** "5 Oct" · "5 تشرين الأول" for a date key (a chart's axis). */
export function shortDateLabel(dateKey: string, language: Language = currentLanguage()): string {
  return formatDayMonth(dateKey, language)
}

/**
 * One point per company-local day of the range, oldest first. Days the server left out (no
 * visits) count 0, so the chart's time axis has no gaps; days outside the range are ignored.
 * `today` (company-local) is marked partial: the report counts the visits booked for a day,
 * so today's value still includes visitors who have not arrived yet.
 */
export function fillDailySeries(points: ReportSummary['visits_per_day'], from: string, to: string, today?: string): ChartDatum[] {
  const counts = new Map<string, number>()
  for (const point of points) counts.set(point.date, (counts.get(point.date) ?? 0) + point.count)
  const series: ChartDatum[] = []
  for (let day = from; day <= to; day = shiftDateKey(day, 1)) {
    const value = counts.get(day) ?? 0
    series.push(
      day === today
        ? { key: day, axisLabel: shortDateLabel(day), label: `${formatDateKey(day)} (${todaySoFar()})`, value, partial: true }
        : { key: day, axisLabel: shortDateLabel(day), label: formatDateKey(day), value },
    )
  }
  return series
}

/** "09:00": the start of an hour of the day (a headline figure; the range is in the table and the readout). */
export function hourStartLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** "09:00–09:59" for an hour of the day, never broken at its dash. */
export function hourRangeLabel(hour: number): string {
  const start = String(hour).padStart(2, '0')
  return joinTimeRange(`${start}:00`, `${start}:59`)
}

/** All 24 hours of the company's day, 0 to 23, with 0 for hours without check-ins. */
export function fillHourlySeries(points: ReportSummary['check_ins_by_hour']): ChartDatum[] {
  const counts = new Map<number, number>()
  for (const point of points) {
    if (Number.isInteger(point.hour) && point.hour >= 0 && point.hour <= 23) counts.set(point.hour, (counts.get(point.hour) ?? 0) + point.count)
  }
  return Array.from({ length: 24 }, (_, hour) => ({
    key: String(hour),
    axisLabel: String(hour).padStart(2, '0'),
    label: hourRangeLabel(hour),
    value: counts.get(hour) ?? 0,
  }))
}

export const OTHER_DEPARTMENTS_KEY = 'other'

/**
 * Departments by visits, largest first (ties by name). Past `limit` bars the rest fold into one
 * "Other departments" bar, so long lists stay readable; the data table lists every department.
 * Each department is named in `language` (its Arabic name in Arabic when it has one).
 */
export function departmentBars(items: ReportSummary['by_department'], limit = 8, language: Language = currentLanguage()): ChartDatum[] {
  const sorted = departmentRows(
    items.filter((item) => item.count > 0),
    language,
  )
  if (sorted.length <= limit) return sorted
  const shown = sorted.slice(0, limit - 1)
  const rest = sorted.slice(limit - 1)
  const other = rest.reduce((sum, item) => sum + item.value, 0)
  const label = t('charts.otherDepartments', { count: rest.length, lng: language })
  return [...shown, { key: OTHER_DEPARTMENTS_KEY, axisLabel: label, label, value: other }]
}

/** Every department, largest first (ties by name), named in `language`: the data table of the department chart. */
export function departmentRows(items: ReportSummary['by_department'], language: Language = currentLanguage()): ChartDatum[] {
  return items
    .map((item) => {
      // Visits without a department: the API names them in English ("No department"); the UI says it in its own language.
      const name = item.department_id === null ? t('charts.departments.unassigned', { lng: language }) : departmentDisplayName(item, language)
      return { key: item.department_id ?? 'none', axisLabel: name, label: name, value: item.count }
    })
    .toSorted((a, b) => b.value - a.value || a.label.localeCompare(b.label, language))
}

export interface SeriesSummary {
  total: number
  /** The first highest complete point (a partial one never counts), or null when every value is 0. */
  peak: ChartDatum | null
  /** The largest value of any point, partial ones included: the top of the value axis. */
  max: number
  /** The point still under way, if any (today). */
  partial: ChartDatum | null
}

export function summarizeSeries(series: readonly ChartDatum[]): SeriesSummary {
  let total = 0
  let max = 0
  let peak: ChartDatum | null = null
  let partial: ChartDatum | null = null
  for (const datum of series) {
    total += datum.value
    max = Math.max(max, datum.value)
    if (datum.partial) partial = datum
    else if (datum.value > 0 && (peak === null || datum.value > peak.value)) peak = datum
  }
  return { total, peak, max, partial }
}

/**
 * The daily chart's one-sentence summary: the total, the busiest complete day and, while the
 * period includes today, today's count so far. An unfinished today is never "the busiest day":
 * its count includes visitors still expected.
 */
export function dailySummaryText(series: readonly ChartDatum[], formatVisits: (count: number) => string): string {
  const { total, peak, partial } = summarizeSeries(series)
  const days = series.length
  if (total === 0) return t('charts.dailyNone', { count: days })
  const sentences = [t('charts.dailyTotal', { count: days, visits: formatVisits(total) })]
  if (peak) {
    const values = { day: peak.label, visits: formatVisits(peak.value) }
    sentences.push(partial ? t('charts.dailyBusiestFull', values) : t('charts.dailyBusiest', values))
  }
  if (partial) sentences.push(t('charts.dailyToday', { visits: formatVisits(partial.value) }))
  return sentences.join(' ')
}

/**
 * Round axis ticks from 0 to at least `max`: steps of 1, 2 or 5 times a power of ten, about
 * `target` of them (0–4 → 0,1,2,3,4; 42 → 0,10,20,30,40,50).
 */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const rough = max / target
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power
  const wholeStep = Math.max(1, Math.round(step))
  const top = Math.ceil(max / wholeStep) * wholeStep
  const ticks: number[] = []
  for (let value = 0; value <= top; value += wholeStep) ticks.push(value)
  return ticks
}

/**
 * Indices whose axis labels are shown when only `maxLabels` fit: every `step`-th from the
 * first. With `nameEnd` (dates: the last day of a period is worth naming) the last index takes
 * the place of the last regular label when it is at least half a step beyond it, so no two
 * labels come closer than a step. Without it the labels keep a regular rhythm to the end (hours
 * of the day: "… 18 21", not "… 18 20 23").
 */
export function labelIndices(count: number, maxLabels: number, { nameEnd = true }: { nameEnd?: boolean } = {}): number[] {
  if (count <= 0) return []
  const step = Math.max(1, Math.ceil(count / Math.max(1, maxLabels)))
  const indices: number[] = []
  for (let index = 0; index < count; index += step) indices.push(index)
  const last = count - 1
  const lastLabelled = indices.at(-1) ?? 0
  if (nameEnd && indices.length > 1 && lastLabelled !== last && last - lastLabelled >= step / 2) indices[indices.length - 1] = last
  return indices
}

/**
 * "8.4": a mean with one decimal (visits a day, visits per visitor), Latin digits in both
 * languages; "—" when there is nothing to average.
 */
export function formatMean(total: number, count: number): string {
  if (!(count > 0)) return '—'
  return formatNumber(total / count, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** "12.5%" for a rate between 0 and 1; "—" when the server has no rate (no finished visits). */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—'
  const percent = rate * 100
  return `${percent.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: percent > 0 && percent < 10 ? 1 : 0 })}%`
}

/** A share of a total with one decimal, "38.7%", "31.0%", so a column of shares lines up. */
export function formatShare(part: number, total: number): string {
  if (!(total > 0)) return '—'
  return `${((part / total) * 100).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

/** The average visit length, "1h 12m"; "—" when no visit qualifies. */
export function formatAverageDuration(seconds: number | null): string {
  return seconds === null ? '—' : formatDuration(seconds)
}
