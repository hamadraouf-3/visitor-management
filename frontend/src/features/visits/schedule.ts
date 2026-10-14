import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import { addMinutesUtc, formatDate, formatTimeRange, toDateKey } from '../../utils/datetime'
import { formatDuration } from '../../utils/duration'
import type { FormErrors } from '../../utils/forms'
import { formatVisitDateRange } from './format'

/**
 * Visit schedule rules, mirroring the server (§4 visits, D-14) so most mistakes are caught
 * before a request. The server stays authoritative and reports the same rules as field errors.
 */
export const MAX_VISIT_DURATION_MS = 24 * 60 * 60_000
export const PAST_TOLERANCE_MS = 5 * 60_000
export const MAX_DAYS_AHEAD = 365
export const DEFAULT_DURATION_MINUTES = 60

const DAY_MS = 24 * 60 * 60_000

const t = i18n.getFixedT(null, 'visits')

/** The schedule rules' messages, in the UI language when read. */
export const SCHEDULE_MESSAGES = lazyTexts({
  startRequired: () => t('schedule.startRequired'),
  endRequired: () => t('schedule.endRequired'),
  endBeforeStart: () => t('schedule.endBeforeStart'),
  tooLong: () => t('schedule.tooLong'),
  inPast: () => t('schedule.inPast'),
  endInPast: () => t('schedule.endInPast'),
  tooFarAhead: () => t('schedule.tooFarAhead', { count: MAX_DAYS_AHEAD }),
})

export interface ScheduleValues {
  /** UTC ISO instants, or null when the field is empty or incomplete. */
  start: string | null
  end: string | null
}

export interface ScheduleRuleOptions {
  now: number
  /**
   * Whether "not in the past" applies. A visit whose start has just passed can still get a new
   * purpose or end time; the rule applies when the start is set or changed.
   */
  checkStartInFuture?: boolean
}

export function validateSchedule(
  { start, end }: ScheduleValues,
  { now, checkStartInFuture = true }: ScheduleRuleOptions,
): FormErrors<'start' | 'end'> {
  const errors: FormErrors<'start' | 'end'> = {}
  if (!start) errors.start = SCHEDULE_MESSAGES.startRequired
  if (!end) errors.end = SCHEDULE_MESSAGES.endRequired
  if (!start || !end) return errors

  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (checkStartInFuture && startMs < now - PAST_TOLERANCE_MS) errors.start = SCHEDULE_MESSAGES.inPast
  else if (startMs > now + MAX_DAYS_AHEAD * DAY_MS) errors.start = SCHEDULE_MESSAGES.tooFarAhead

  if (endMs <= startMs) errors.end = SCHEDULE_MESSAGES.endBeforeStart
  else if (endMs - startMs > MAX_VISIT_DURATION_MS) errors.end = SCHEDULE_MESSAGES.tooLong
  // Also when the start is not checked: a visit under way can have its end moved, but not
  // into the past (the server's END_IN_PAST on scheduled_end, B24-24).
  else if (endMs < now) errors.end = SCHEDULE_MESSAGES.endInPast
  return errors
}

/**
 * The end after the start moved: the visit keeps its length (e.g. 09:00–10:30 moved to 11:00
 * becomes 11:00–12:30). Without a usable previous length, the default of one hour applies.
 */
export function endForNewStart(previous: ScheduleValues, nextStart: string | null): string | null {
  if (!nextStart) return previous.end
  const length = previous.start && previous.end ? Date.parse(previous.end) - Date.parse(previous.start) : Number.NaN
  const minutes = Number.isFinite(length) && length > 0 ? length / 60_000 : DEFAULT_DURATION_MINUTES
  return addMinutesUtc(nextStart, minutes)
}

/**
 * The chosen schedule read back in the app's own format, e.g. "Mon, 5 Oct 2026 · 20:30–21:30
 * (1h)". The native date input shows the browser's locale format (month first in en-US), which
 * a day-first reader can misread; this line removes the doubt.
 * Null while the range is incomplete or not a valid range (the field errors explain it).
 */
export function scheduleReadBack({ start, end }: ScheduleValues, timeZone: string): string | null {
  if (!start || !end) return null
  const length = Date.parse(end) - Date.parse(start)
  if (!(length > 0)) return null
  const duration = formatDuration(length / 1000)
  if (toDateKey(start, timeZone) !== toDateKey(end, timeZone)) {
    return t('schedule.readBack', { range: formatVisitDateRange(start, end, timeZone), duration })
  }
  return t('schedule.readBack', { range: `${formatDate(start, timeZone)} · ${formatTimeRange(start, end, timeZone)}`, duration })
}
