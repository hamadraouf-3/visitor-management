import { currentLanguage, i18n, type Language } from '../../i18n'
import type { Visit } from '../../types/api'
import {
  calendarDaysFromToday,
  formatDate,
  formatDateTime,
  formatDateTimeRange,
  formatShortDate,
  formatTime,
  formatTimeOnDay,
  formatTimeRange,
  joinSpacedRange,
  joinTimeRange,
  relativeDayLabel,
  toDateKey,
  toZoned,
  type DateInput,
} from '../../utils/datetime'
import { formatDuration } from '../../utils/duration'

const t = i18n.getFixedT(null, ['visits', 'common'])

/*
 * Visit times in the company timezone. One company day: "Mon, 5 Oct 2026, 09:00–10:30" (a
 * closed en dash between two times). Across midnight the end names its day in short form, the
 * year only when it differs: "Mon, 5 Oct 2026, 22:42 – Tue, 6 Oct, 00:42". The spaced en dash
 * there is deliberate: both sides contain spaces, and a closed dash would bind "22:42–Tue".
 * Neither range breaks at its dash, and an Arabic "8 تشرين الأول" never splits
 * (`joinTimeRange`, `joinSpacedRange` and the date formatters of utils/datetime).
 */

function isSameCompanyDay(a: DateInput, b: DateInput, timeZone: string): boolean {
  return toDateKey(a, timeZone) === toDateKey(b, timeZone)
}

/** "Tue, 6 Oct", or "Fri, 1 Jan 2027" when the year differs from the reference instant's. */
function shortDate(value: DateInput, reference: DateInput, timeZone: string, language: Language): string {
  return toZoned(value, timeZone).getFullYear() === toZoned(reference, timeZone).getFullYear()
    ? formatShortDate(value, timeZone, language)
    : formatDate(value, timeZone, language)
}

/** A day and a time: "Tue, 6 Oct, 00:42" (the language's comma). */
function dayAndTime(day: string, time: string, language: Language): string {
  return t('common:dates.dateTime', { lng: language, date: day, time })
}

/** The end of a range that ends on a later company day: "Tue, 6 Oct, 00:42". */
function laterDayEnd(start: DateInput, end: DateInput, timeZone: string, language: Language): string {
  return dayAndTime(shortDate(end, start, timeZone, language), formatTime(end, timeZone), language)
}

/**
 * A visit's times under its date (the date is on the line above): "09:00–10:00", and across midnight
 * "23:30 – Thu, 8 Oct, 00:15" (only the later day is named, not both dates in full).
 */
export function formatVisitTimes(start: DateInput, end: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  if (isSameCompanyDay(start, end, timeZone)) return formatTimeRange(start, end, timeZone, language)
  return joinSpacedRange(formatTime(start, timeZone), laterDayEnd(start, end, timeZone, language))
}

/** When a visit takes place, as a date and times: "Mon, 5 Oct 2026, 09:00–10:00" or "Mon, 5 Oct 2026, 22:42 – Tue, 6 Oct, 00:42". */
export function formatVisitDateRange(start: DateInput, end: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  if (isSameCompanyDay(start, end, timeZone)) return formatDateTimeRange(start, end, timeZone, language)
  return joinSpacedRange(formatDateTime(start, timeZone, language), laterDayEnd(start, end, timeZone, language))
}

/** The day of a range's end relative to today when it is near ("Tomorrow"), else its short date. */
function relativeEndDay(start: DateInput, end: DateInput, timeZone: string, now: DateInput, language: Language): string {
  return Math.abs(calendarDaysFromToday(end, timeZone, now)) <= 1
    ? relativeDayLabel(end, timeZone, now, language)
    : shortDate(end, start, timeZone, language)
}

/**
 * When a visit takes place, relative to today, for lists: "Today, 09:00–10:00",
 * "Mon, 5 Oct 2026, 09:00–10:00", and across midnight "Today, 22:42 – Tomorrow, 00:42" or
 * "Fri, 9 Oct 2026, 22:00 – Sat, 10 Oct, 01:00".
 */
export function formatVisitWhen(start: string, end: string, timeZone: string, now: DateInput = Date.now(), language: Language = currentLanguage()): string {
  const startDay = relativeDayLabel(start, timeZone, now, language)
  if (isSameCompanyDay(start, end, timeZone)) return dayAndTime(startDay, joinTimeRange(formatTime(start, timeZone), formatTime(end, timeZone)), language)
  const from = dayAndTime(startDay, formatTime(start, timeZone), language)
  return joinSpacedRange(from, dayAndTime(relativeEndDay(start, end, timeZone, now, language), formatTime(end, timeZone), language))
}

/**
 * The time of one of today's visits where the column already says "Today" (visitor search):
 * "09:00–10:00"; "from 22:42" when it ends on a later day; "until 00:42" when it started on an
 * earlier day; a visit that neither starts nor ends today (a visitor still inside from an
 * earlier day) is dated in full, relative to today.
 */
export function formatTodayVisitTime(start: string, end: string, timeZone: string, now: DateInput = Date.now(), language: Language = currentLanguage()): string {
  const today = toDateKey(now, timeZone)
  const startsToday = toDateKey(start, timeZone) === today
  const endsToday = toDateKey(end, timeZone) === today
  if (startsToday && endsToday) return joinTimeRange(formatTime(start, timeZone), formatTime(end, timeZone))
  if (startsToday) return t('format.fromTime', { lng: language, time: formatTime(start, timeZone) })
  if (endsToday) return t('format.untilTime', { lng: language, time: formatTime(end, timeZone) })
  return formatVisitWhen(start, end, timeZone, now, language)
}

/**
 * Check-in, check-out and time on site in one short line: "In 09:02 · Out 10:15 · 1h 13m",
 * "In 09:02 · not checked out", or null when the visitor never checked in. Times on another
 * day than the visit's carry their date.
 */
export function formatAttendance(
  visit: Pick<Visit, 'scheduled_start' | 'check_in_at' | 'check_out_at' | 'duration_seconds'>,
  timeZone: string,
  language: Language = currentLanguage(),
): string | null {
  const lines = attendanceLines(visit, timeZone, language)
  if (!lines) return null
  if (!visit.check_out_at) return `${lines.times} · ${t('format.notCheckedOutInline', { lng: language })}`
  return lines.length ? `${lines.times} · ${lines.length}` : lines.times
}

/**
 * The same facts in two short lines for a narrow column: the times ("In 09:02 · Out 10:15")
 * and the time on site ("1h 13m", or "Not checked out"), so the column stays narrow. Null when
 * the visitor never checked in.
 */
export function attendanceLines(
  visit: Pick<Visit, 'scheduled_start' | 'check_in_at' | 'check_out_at' | 'duration_seconds'>,
  timeZone: string,
  language: Language = currentLanguage(),
): { times: string; length: string | null } | null {
  if (!visit.check_in_at) return null
  const checkIn = t('format.in', { lng: language, time: formatTimeOnDay(visit.check_in_at, visit.scheduled_start, timeZone, language) })
  if (!visit.check_out_at) return { times: checkIn, length: t('format.notCheckedOut', { lng: language }) }
  const checkOut = t('format.out', { lng: language, time: formatTimeOnDay(visit.check_out_at, visit.scheduled_start, timeZone, language) })
  return {
    times: `${checkIn} · ${checkOut}`,
    length: visit.duration_seconds === null ? null : formatDuration(visit.duration_seconds, language),
  }
}
