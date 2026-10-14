import { currentLanguage, i18n, type Language } from '../../i18n'
import type { Visit } from '../../types/api'
import { formatTime, toDateKey, type DateInput } from '../../utils/datetime'

/*
 * The flags of a visitor who is still checked in, worded once for every screen that lists
 * them: the reception Inside tab, the evacuation list (/inside) and its printout.
 */

export type InsideFlagKind = 'previous-day' | 'overdue'

export interface InsideFlag {
  kind: InsideFlagKind
  /** "Previous day", "Overdue · due out 10:00" (in the UI language). */
  label: string
}

/** "Previous day": the flag's label, also the heading of its count on the evacuation list. */
export function previousDayLabel(language: Language = currentLanguage()): string {
  return i18n.t('insideFlags.previousDay', { ns: 'visits', lng: language })
}

/**
 * A visitor checked in before today (company-local, `is_stale`) and past the scheduled end of
 * the visit (`is_overdue`). The overdue flag names the time the visitor was due out when that
 * was today; for an earlier day "Previous day" already says it, and the time alone would read
 * as today's.
 */
export function insideFlags(
  visit: Pick<Visit, 'is_overdue' | 'is_stale' | 'scheduled_end'>,
  timeZone: string,
  now: DateInput,
  language: Language = currentLanguage(),
): InsideFlag[] {
  const t = (key: 'overdue' | 'overdueDueOut', values?: { time: string }) =>
    i18n.t(`insideFlags.${key}`, { ns: 'visits', lng: language, ...values })
  const flags: InsideFlag[] = []
  if (visit.is_stale) {
    flags.push({ kind: 'previous-day', label: previousDayLabel(language) })
  }
  if (visit.is_overdue) {
    const dueToday = toDateKey(visit.scheduled_end, timeZone) === toDateKey(now, timeZone)
    flags.push({
      kind: 'overdue',
      label: dueToday ? t('overdueDueOut', { time: formatTime(visit.scheduled_end, timeZone) }) : t('overdue'),
    })
  }
  return flags
}
