import { TZDate, tz, tzOffset } from '@date-fns/tz'
import { differenceInCalendarDays, format } from 'date-fns'
import { currentLanguage, i18n, INTL_LOCALES, type Language } from '../i18n'
import { ARABIC_TIME_ZONE_PLACES } from '../i18n/timeZonePlaces'

/**
 * Company-timezone date/time helpers. Every business time is shown and entered in the
 * company's IANA timezone (Me.company.timezone), never the browser's (§3, D-15). API values
 * are UTC ISO strings; date-only values are company-local `YYYY-MM-DD` keys.
 *
 * Every formatter speaks the UI language (`language`, default: the current one; F10-5):
 * - English keeps the app's fixed formats ("Mon, 5 Oct 2026", "09:30").
 * - Arabic uses the Levantine month names used across Jordan ("الاثنين، 5 تشرين الأول 2026",
 *   `ar-JO`) with Latin digits, and the same 24-hour "09:30" times: times, codes and phone
 *   numbers stay unambiguous and match what people type.
 * Render code that shows dates calls `useTranslation()` (or `useLanguage()`), so it re-renders
 * when the language changes.
 */

export type DateInput = string | number | Date

const DATE_PATTERN = 'EEE, d MMM yyyy'
const SHORT_DATE_PATTERN = 'EEE, d MMM'
const TIME_PATTERN = 'HH:mm'
const DATE_KEY_PATTERN = 'yyyy-MM-dd'
const WALL_TIME_PATTERN = "yyyy-MM-dd'T'HH:mm"

const WALL_TIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const DATE_KEY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/

/** Direction marks some `Intl` outputs carry; the text is laid out by its context instead. */
const BIDI_MARKS = /[\u200E\u200F\u061C]/g

/*
 * Where a date or a time may break across lines. A line may break after the weekday's comma and
 * between a date and its time ("Thu, 8 Oct 2026," / "00:00\u201300:45"), never inside a time range or
 * inside "8 \u062A\u0634\u0631\u064A\u0646 \u0627\u0644\u0623\u0648\u0644 2026": the en dash is a break opportunity (UAX #14 class BA) and the
 * Levantine month names are two words, so without these characters an Arabic cell read
 * \u00AB\u2026\u060C 00:00\u2013\u00BB / \u00AB00:45\u00BB or \u00AB8 \u062A\u0634\u0631\u064A\u0646\u00BB / \u00AB\u0627\u0644\u0623\u0648\u0644\u00BB. Both are invisible to people and screen readers.
 */
const NO_BREAK_SPACE = '\u00A0'
/** U+2060 WORD JOINER: no line break on either side. */
const WORD_JOINER = '\u2060'
const EN_DASH = '\u2013'

/** "09:00\u201310:30" on one line: a closed en dash with a word joiner after it. */
export function joinTimeRange(start: string, end: string): string {
  return `${start}${EN_DASH}${WORD_JOINER}${end}`
}

/**
 * "23:45 \u2013 Thu, 8 Oct, 00:30": a spaced en dash between two sides that contain spaces; the dash
 * stays with the start (a no-break space before it) and the line may break after it.
 */
export function joinSpacedRange(start: string, end: string): string {
  return `${start}${NO_BREAK_SPACE}${EN_DASH} ${end}`
}

/**
 * An Arabic date with its day, month and year kept on one line ("8 \u062A\u0634\u0631\u064A\u0646 \u0627\u0644\u0623\u0648\u0644 2026" with no-break
 * spaces); the space after the weekday's comma stays a break opportunity.
 */
function unbreakableArabicDate(text: string): string {
  return text.replace(/(?<!\u060C) /g, NO_BREAK_SPACE)
}

function toTimestamp(value: DateInput): number {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(timestamp)) throw new RangeError(`Invalid date value: ${String(value)}`)
  return timestamp
}

/** The instant as a date whose calendar fields are those of `timeZone`. */
export function toZoned(value: DateInput, timeZone: string): TZDate {
  return new TZDate(toTimestamp(value), timeZone)
}

/* ------------------------------------------------------------------------------------------ */
/* Arabic calendar text (Intl)                                                                 */
/* ------------------------------------------------------------------------------------------ */

const intlDateFormats = new Map<string, Intl.DateTimeFormat>()

/** `Intl` date text in Arabic: Levantine month names, Latin digits, in the given zone. */
function arabicDate(timestamp: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const key = `${timeZone}|${JSON.stringify(options)}`
  let formatter = intlDateFormats.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(INTL_LOCALES.ar, { ...options, timeZone, calendar: 'gregory' })
    intlDateFormats.set(key, formatter)
  }
  return unbreakableArabicDate(formatter.format(timestamp).replace(BIDI_MARKS, ''))
}

const ARABIC_DATE: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
const ARABIC_SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }

/* ------------------------------------------------------------------------------------------ */
/* Formatting                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** "Mon, 5 Oct 2026" · "الاثنين، 5 تشرين الأول 2026" */
export function formatDate(value: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  if (language === 'ar') return arabicDate(toTimestamp(value), timeZone, ARABIC_DATE)
  return format(toZoned(value, timeZone), DATE_PATTERN)
}

/** "Mon, 5 Oct" · "الاثنين، 5 تشرين الأول": a date in the current year's context (headers, cards). */
export function formatShortDate(value: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  if (language === 'ar') return arabicDate(toTimestamp(value), timeZone, ARABIC_SHORT_DATE)
  return format(toZoned(value, timeZone), SHORT_DATE_PATTERN)
}

/** "09:30" (24-hour, Latin digits, in both languages) */
export function formatTime(value: DateInput, timeZone: string): string {
  return format(toZoned(value, timeZone), TIME_PATTERN)
}

/** "Mon, 5 Oct 2026, 09:30" · "الاثنين، 5 تشرين الأول 2026، 09:30" */
export function formatDateTime(value: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  return i18n.t('dates.dateTime', { lng: language, date: formatDate(value, timeZone, language), time: formatTime(value, timeZone) })
}

/** "Mon, 5 Oct 2026 at 09:30", for a moment inside a sentence ("Cancelled by … on …"). */
export function formatDateAtTime(value: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  return i18n.t('dates.atTime', { lng: language, date: formatDate(value, timeZone, language), time: formatTime(value, timeZone) })
}

/** "09:31:05": a time to the second (when a list was generated, when an audit event happened). */
export function formatClockTime(value: DateInput, timeZone: string): string {
  return format(toZoned(value, timeZone), 'HH:mm:ss')
}

/** "Mon, 5 Oct 2026 at 09:31:05" (e.g. the header of a printed list). */
export function formatDateAtClockTime(value: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  return i18n.t('dates.atTime', { lng: language, date: formatDate(value, timeZone, language), time: formatClockTime(value, timeZone) })
}

/**
 * A time on the reference day as "09:05"; on another company-local day with its date,
 * "Sat, 3 Oct 2026, 17:40" (a check-in time relative to today, a check-out relative to the
 * visit's own day).
 */
export function formatTimeOnDay(value: DateInput, referenceDay: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  return isSameCompanyDay(value, referenceDay, timeZone) ? formatTime(value, timeZone) : formatDateTime(value, timeZone, language)
}

function isSameCompanyDay(a: DateInput, b: DateInput, timeZone: string): boolean {
  return toDateKey(a, timeZone) === toDateKey(b, timeZone)
}

/** A moment for a sentence: whether it is on the reference company-local day, its date and its time. */
export interface MomentOnDay {
  sameDay: boolean
  date: string
  time: string
}

/**
 * A moment relative to a reference day, for a sentence that names it. Each such sentence has a key
 * for the same day ({{time}}) and one for another day ({{date}}, {{time}}), so each language words
 * it: "at 21:48" / "at Wed, 7 Oct 2026, 21:48", «الساعة 21:48» / «يوم الأربعاء، 7 تشرين الأول 2026
 * الساعة 21:48». (A single "at {{time}}" filled with a whole date put «الساعة» before a date.)
 */
export function momentOnDay(value: DateInput, referenceDay: DateInput, timeZone: string, language: Language = currentLanguage()): MomentOnDay {
  return { sameDay: isSameCompanyDay(value, referenceDay, timeZone), date: formatDate(value, timeZone, language), time: formatTime(value, timeZone) }
}

/**
 * "09:00–10:30" on one company-local day; "Mon, 5 Oct 2026, 23:00 – Tue, 6 Oct 2026, 01:00"
 * otherwise. In Arabic the range reads right to left (start first) by the bidi algorithm. Neither
 * breaks at its dash (`joinTimeRange`, `joinSpacedRange`).
 */
export function formatTimeRange(start: DateInput, end: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  if (isSameCompanyDay(start, end, timeZone)) {
    return joinTimeRange(formatTime(start, timeZone), formatTime(end, timeZone))
  }
  return joinSpacedRange(formatDateTime(start, timeZone, language), formatDateTime(end, timeZone, language))
}

/** "Mon, 5 Oct 2026, 09:00–10:30", or the full two-sided form across days. */
export function formatDateTimeRange(start: DateInput, end: DateInput, timeZone: string, language: Language = currentLanguage()): string {
  if (isSameCompanyDay(start, end, timeZone)) {
    return i18n.t('dates.dateTime', {
      lng: language,
      date: formatDate(start, timeZone, language),
      time: formatTimeRange(start, end, timeZone, language),
    })
  }
  return formatTimeRange(start, end, timeZone, language)
}

/** Company-local calendar date of an instant: "2026-10-05". */
export function toDateKey(value: DateInput, timeZone: string): string {
  return format(toZoned(value, timeZone), DATE_KEY_PATTERN)
}

/** Today's company-local date key (for date-only API filters). */
export function companyToday(timeZone: string, now: DateInput = Date.now()): string {
  return toDateKey(now, timeZone)
}

function parseDateKey(dateKey: string): [number, number, number] {
  const match = DATE_KEY_REGEX.exec(dateKey)
  if (!match) throw new RangeError(`Invalid date key: ${dateKey}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** False for dates that do not exist (2026-02-30 would otherwise roll into March). */
function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** True for an existing calendar date in the `YYYY-MM-DD` form used by date-only API filters. */
export function isDateKey(value: string): boolean {
  const match = DATE_KEY_REGEX.exec(value)
  return match !== null && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** Calendar arithmetic on a date key, independent of any timezone or DST. */
export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = parseDateKey(dateKey)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** "Mon, 5 Oct 2026" for a company-local date key (no timezone conversion). */
export function formatDateKey(dateKey: string, language: Language = currentLanguage()): string {
  const [year, month, day] = parseDateKey(dateKey)
  if (language === 'ar') return arabicDate(Date.UTC(year, month - 1, day), 'UTC', ARABIC_DATE)
  return format(new TZDate(year, month - 1, day, 'UTC'), DATE_PATTERN)
}

const ARABIC_DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }

/** "5 Oct" · "5 تشرين الأول" for a date key: a short day on a chart axis (Arabic has no abbreviated months). */
export function formatDayMonth(dateKey: string, language: Language = currentLanguage()): string {
  const [year, month, day] = parseDateKey(dateKey)
  if (language === 'ar') return arabicDate(Date.UTC(year, month - 1, day), 'UTC', ARABIC_DAY_MONTH)
  return format(new TZDate(year, month - 1, day, 'UTC'), 'd MMM')
}

/** Whole company-local calendar days from `now` to `value` (0 = same day, 1 = tomorrow). */
export function calendarDaysFromToday(value: DateInput, timeZone: string, now: DateInput = Date.now()): number {
  return differenceInCalendarDays(toTimestamp(value), toTimestamp(now), { in: tz(timeZone) })
}

/** "Today" / "Tomorrow" / "Yesterday" (اليوم / غدًا / أمس), otherwise the formatted company-local date. */
export function relativeDayLabel(value: DateInput, timeZone: string, now: DateInput = Date.now(), language: Language = currentLanguage()): string {
  switch (calendarDaysFromToday(value, timeZone, now)) {
    case 0:
      return i18n.t('dates.today', { lng: language })
    case 1:
      return i18n.t('dates.tomorrow', { lng: language })
    case -1:
      return i18n.t('dates.yesterday', { lng: language })
    default:
      return formatDate(value, timeZone, language)
  }
}

/** "Today, 09:30" / "Tomorrow, 14:00" / "Mon, 5 Oct 2026, 09:30". */
export function formatRelativeDateTime(value: DateInput, timeZone: string, now: DateInput = Date.now(), language: Language = currentLanguage()): string {
  return i18n.t('dates.dateTime', { lng: language, date: relativeDayLabel(value, timeZone, now, language), time: formatTime(value, timeZone) })
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

const relativeTimeFormats = new Map<Language, Intl.RelativeTimeFormat>()

/**
 * "3 hours ago", "in 20 minutes", "now" · "قبل 3 ساعات", "خلال 20 دقيقة", "الآن": the distance
 * from `now` in its largest whole unit (days, hours, minutes), for "updated …" lines. Times of
 * day that matter (a visit's start) are shown as times instead.
 */
export function formatRelativeTime(value: DateInput, now: DateInput = Date.now(), language: Language = currentLanguage()): string {
  let formatter = relativeTimeFormats.get(language)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(INTL_LOCALES[language], { numeric: 'auto' })
    relativeTimeFormats.set(language, formatter)
  }
  const seconds = Math.round((toTimestamp(value) - toTimestamp(now)) / 1000)
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit).replace(BIDI_MARKS, '')
  }
  return formatter.format(0, 'second').replace(BIDI_MARKS, '')
}

/** "UTC+03:00" for the zone's offset at the given instant. */
export function formatUtcOffset(timeZone: string, at: DateInput = Date.now()): string {
  const offset = tzOffset(timeZone, new Date(toTimestamp(at)))
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

/** "UTC+3", "UTC+5:30", "UTC-4", "UTC" (compact, for labels people read). */
export function formatShortUtcOffset(timeZone: string, at: DateInput = Date.now()): string {
  const offset = tzOffset(timeZone, new Date(toTimestamp(at)))
  if (offset === 0) return 'UTC'
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  const minutes = absolute % 60
  return `UTC${sign}${Math.floor(absolute / 60)}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`
}

/**
 * The company's time zone for people, not developers: "Amman time (UTC+3)",
 * "New York time (UTC-4)" · "توقيت عمّان (UTC+3)". The place is the last segment of the IANA
 * name (in Arabic when `ARABIC_TIME_ZONE_PLACES` knows it); zones without one (e.g. "UTC") are
 * shown by their offset alone. Show it once per screen (form group, column header or page
 * description), not next to every time.
 */
export function formatTimeZoneName(timeZone: string, at: DateInput = Date.now(), language: Language = currentLanguage()): string {
  const offset = formatShortUtcOffset(timeZone, at)
  const slash = timeZone.lastIndexOf('/')
  const englishPlace = slash >= 0 && !timeZone.startsWith('Etc/') ? timeZone.slice(slash + 1).replaceAll('_', ' ') : ''
  if (!englishPlace) return offset
  const place = language === 'ar' ? (ARABIC_TIME_ZONE_PLACES[englishPlace] ?? englishPlace) : englishPlace
  return i18n.t('dates.timeZone', { lng: language, place, offset })
}

/* ------------------------------------------------------------------------------------------ */
/* Wall time ⇄ UTC (company-local date and time entry)                                         */
/* ------------------------------------------------------------------------------------------ */

/** UTC instant → company wall time "YYYY-MM-DDTHH:mm". */
export function utcToWallTime(value: DateInput, timeZone: string): string {
  return format(toZoned(value, timeZone), WALL_TIME_PATTERN)
}

/**
 * Company wall time "YYYY-MM-DDTHH:mm[:ss]" → UTC ISO string ("…Z"), or null when the input
 * is malformed or names a non-existent calendar date.
 *
 * DST: a wall time inside a spring-forward gap does not exist and resolves forward
 * (America/New_York 02:30 → 03:30 EDT); an ambiguous fall-back time resolves to its first
 * (earlier) occurrence. Use {@link isWallTimeShifted} to warn the user about the former.
 */
export function wallTimeToUtc(wallTime: string, timeZone: string): string | null {
  const match = WALL_TIME_REGEX.exec(wallTime.trim())
  if (!match) return null
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  if (!isCalendarDate(year, month, day)) return null

  const zoned = new TZDate(year, month - 1, day, hours, minutes, seconds, timeZone)
  if (Number.isNaN(zoned.getTime())) return null
  return new Date(zoned.getTime()).toISOString()
}

/** True when the wall time does not exist in the zone (DST gap) and was moved forward. */
export function isWallTimeShifted(wallTime: string, timeZone: string): boolean {
  const utc = wallTimeToUtc(wallTime, timeZone)
  if (!utc) return false
  return utcToWallTime(utc, timeZone) !== wallTime.trim().slice(0, 16)
}

/* ------------------------------------------------------------------------------------------ */
/* Date + time-of-day entry (a date input and a 24-hour time list)                            */
/* ------------------------------------------------------------------------------------------ */

const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const HOUR_MS = 60 * 60_000

/** True for a 24-hour wall-clock time "HH:mm". */
export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_REGEX.test(value)
}

/** The company-local date key and "HH:mm" of an instant; empty strings for no value. */
export function toWallParts(value: DateInput | null, timeZone: string): { date: string; time: string } {
  return value === null ? { date: '', time: '' } : { date: toDateKey(value, timeZone), time: formatTime(value, timeZone) }
}

/**
 * Whether the zone's UTC offset may change during the company-local day: compared over a
 * window that covers that day in every zone (UTC−12 … UTC+14), so a transition at midnight
 * is not missed.
 */
function offsetMayChangeOn(dateKey: string, timeZone: string): boolean {
  const [year, month, day] = parseDateKey(dateKey)
  const dayStartUtc = Date.UTC(year, month - 1, day)
  return tzOffset(timeZone, new Date(dayStartUtc - 14 * HOUR_MS)) !== tzOffset(timeZone, new Date(dayStartUtc + 38 * HOUR_MS))
}

/**
 * The 24-hour times "HH:mm" offered for a company-local day: every `stepMinutes` from 00:00,
 * without the times a spring-forward gap removes from that day (they do not exist there),
 * plus `include` when it is a time off the grid (e.g. a visit created at 09:07), in order.
 * Without a valid date the full grid is returned.
 */
export function wallTimeSlots(
  dateKey: string | null,
  timeZone: string,
  { stepMinutes = 15, include = null }: { stepMinutes?: number; include?: string | null } = {},
): string[] {
  const checkGaps = dateKey !== null && isDateKey(dateKey) && offsetMayChangeOn(dateKey, timeZone)
  const slots: string[] = []
  for (let minutes = 0; minutes < 24 * 60; minutes += stepMinutes) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    if (checkGaps && isWallTimeShifted(`${dateKey}T${time}`, timeZone)) continue
    slots.push(time)
  }
  if (include !== null && isTimeOfDay(include) && !slots.includes(include)) {
    // "HH:mm" strings sort in time order.
    return [...slots, include].toSorted()
  }
  return slots
}

/* ------------------------------------------------------------------------------------------ */
/* Defaults                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Adds minutes to an instant; returns a UTC ISO string. */
export function addMinutesUtc(value: DateInput, minutes: number): string {
  return new Date(toTimestamp(value) + minutes * 60_000).toISOString()
}

/**
 * The next :00 or :30 company wall-clock boundary strictly after `now` (Invite form default).
 * Computed on the instant timeline, so it stays correct inside a DST fall-back overlap where
 * rebuilding the wall time would pick the wrong occurrence.
 */
export function nextHalfHourUtc(timeZone: string, now: DateInput = Date.now()): string {
  const timestamp = toTimestamp(now)
  const zoned = new TZDate(timestamp, timeZone)
  const elapsedInSlot = ((zoned.getMinutes() % 30) * 60 + zoned.getSeconds()) * 1000 + zoned.getMilliseconds()
  return new Date(timestamp - elapsedInSlot + 30 * 60_000).toISOString()
}
