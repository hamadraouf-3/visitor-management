import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../i18n'
import {
  calendarDaysFromToday,
  companyToday,
  formatDate,
  formatDateAtTime,
  formatDateKey,
  formatDateTime,
  formatDateTimeRange,
  formatRelativeDateTime,
  formatRelativeTime,
  formatShortDate,
  formatTime,
  formatShortUtcOffset,
  formatTimeRange,
  formatTimeZoneName,
  formatUtcOffset,
  isDateKey,
  isTimeOfDay,
  isWallTimeShifted,
  joinSpacedRange,
  joinTimeRange,
  momentOnDay,
  nextHalfHourUtc,
  relativeDayLabel,
  shiftDateKey,
  toDateKey,
  toWallParts,
  utcToWallTime,
  wallTimeSlots,
  wallTimeToUtc,
} from './datetime'

const AMMAN = 'Asia/Amman' // UTC+3 all year
const NEW_YORK = 'America/New_York' // EST -5 / EDT -4; 2026: DST 8 Mar 02:00 → 03:00, 1 Nov 02:00 → 01:00
const KOLKATA = 'Asia/Kolkata' // UTC+5:30

describe('test environment', () => {
  it('runs with a browser timezone (UTC) different from the company timezones', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
    expect(new Date('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(0)
  })
})

describe('formatting in the company timezone', () => {
  // 21:30 UTC on 5 Oct is already 00:30 on 6 Oct in Amman.
  const lateEvening = '2026-10-05T21:30:00Z'

  it('formats date, time and date-time in the company zone, not the browser zone', () => {
    expect(formatDate(lateEvening, AMMAN)).toBe('Tue, 6 Oct 2026')
    expect(formatTime(lateEvening, AMMAN)).toBe('00:30')
    expect(formatDateTime(lateEvening, AMMAN)).toBe('Tue, 6 Oct 2026, 00:30')
    expect(formatDateTime(lateEvening, 'UTC')).toBe('Mon, 5 Oct 2026, 21:30')
    expect(formatDateAtTime(lateEvening, AMMAN)).toBe('Tue, 6 Oct 2026 at 00:30')
  })

  it('accepts ISO strings, timestamps and Date objects', () => {
    const instant = '2026-10-05T06:00:00Z'
    expect(formatTime(instant, AMMAN)).toBe('09:00')
    expect(formatTime(Date.parse(instant), AMMAN)).toBe('09:00')
    expect(formatTime(new Date(instant), AMMAN)).toBe('09:00')
  })

  it('throws on invalid input instead of rendering "Invalid Date"', () => {
    expect(() => formatDate('not a date', AMMAN)).toThrow(RangeError)
  })

  it('formats time ranges on one day and across days', () => {
    expect(formatTimeRange('2026-10-05T06:00:00Z', '2026-10-05T07:30:00Z', AMMAN)).toBe('09:00–\u206010:30')
    expect(formatDateTimeRange('2026-10-05T06:00:00Z', '2026-10-05T07:30:00Z', AMMAN)).toBe('Mon, 5 Oct 2026, 09:00–\u206010:30')
    // 23:00–01:00 Amman spans two company days although it is one UTC day.
    expect(formatTimeRange('2026-10-05T20:00:00Z', '2026-10-05T22:00:00Z', AMMAN)).toBe(
      'Mon, 5 Oct 2026, 23:00\u00a0– Tue, 6 Oct 2026, 01:00',
    )
    expect(formatDateTimeRange('2026-10-05T20:00:00Z', '2026-10-05T22:00:00Z', AMMAN)).toBe(
      'Mon, 5 Oct 2026, 23:00\u00a0– Tue, 6 Oct 2026, 01:00',
    )
  })

  it('labels offsets and zones, following DST', () => {
    expect(formatUtcOffset(AMMAN, '2026-01-15T12:00:00Z')).toBe('UTC+03:00')
    expect(formatUtcOffset(NEW_YORK, '2026-01-15T12:00:00Z')).toBe('UTC-05:00')
    expect(formatUtcOffset(NEW_YORK, '2026-07-15T12:00:00Z')).toBe('UTC-04:00')
    expect(formatUtcOffset(KOLKATA, '2026-07-15T12:00:00Z')).toBe('UTC+05:30')
  })

  it('names the zone for people: place and short offset, following DST', () => {
    expect(formatShortUtcOffset(AMMAN, '2026-10-05T12:00:00Z')).toBe('UTC+3')
    expect(formatShortUtcOffset(KOLKATA, '2026-07-15T12:00:00Z')).toBe('UTC+5:30')
    expect(formatShortUtcOffset(NEW_YORK, '2026-01-15T12:00:00Z')).toBe('UTC-5')
    expect(formatTimeZoneName(AMMAN, '2026-10-05T12:00:00Z')).toBe('Amman time (UTC+3)')
    expect(formatTimeZoneName(NEW_YORK, '2026-07-15T12:00:00Z')).toBe('New York time (UTC-4)')
    expect(formatTimeZoneName(NEW_YORK, '2026-01-15T12:00:00Z')).toBe('New York time (UTC-5)')
    expect(formatTimeZoneName('America/Argentina/Buenos_Aires', '2026-01-15T12:00:00Z')).toBe('Buenos Aires time (UTC-3)')
    // Zones without a place are named by their offset.
    expect(formatTimeZoneName('UTC', '2026-01-15T12:00:00Z')).toBe('UTC')
    expect(formatTimeZoneName('Etc/GMT-3', '2026-01-15T12:00:00Z')).toBe('UTC+3')
  })
})

describe('company-local days', () => {
  it('derives the company-local date key around midnight', () => {
    expect(toDateKey('2026-10-05T20:59:59Z', AMMAN)).toBe('2026-10-05')
    expect(toDateKey('2026-10-05T21:00:00Z', AMMAN)).toBe('2026-10-06')
    expect(companyToday(AMMAN, '2026-10-05T21:00:00Z')).toBe('2026-10-06')
    expect(companyToday('UTC', '2026-10-05T21:00:00Z')).toBe('2026-10-05')
  })

  it('labels relative days by company calendar, not browser calendar', () => {
    const now = '2026-10-05T21:30:00Z' // Tue 6 Oct, 00:30 in Amman
    expect(relativeDayLabel('2026-10-06T06:00:00Z', AMMAN, now)).toBe('Today')
    expect(relativeDayLabel('2026-10-05T20:00:00Z', AMMAN, now)).toBe('Yesterday')
    expect(relativeDayLabel('2026-10-07T06:00:00Z', AMMAN, now)).toBe('Tomorrow')
    expect(relativeDayLabel('2026-10-09T06:00:00Z', AMMAN, now)).toBe('Fri, 9 Oct 2026')
    expect(calendarDaysFromToday('2026-10-09T06:00:00Z', AMMAN, now)).toBe(3)
    expect(formatRelativeDateTime('2026-10-06T06:00:00Z', AMMAN, now)).toBe('Today, 09:00')
  })

  it('counts calendar days correctly across a DST change', () => {
    // 7 Mar 12:00 EST → 9 Mar 12:00 EDT is two company days although only 47 hours apart.
    expect(calendarDaysFromToday('2026-03-09T16:00:00Z', NEW_YORK, '2026-03-07T17:00:00Z')).toBe(2)
  })

  it('shifts and formats date keys without timezone effects', () => {
    expect(shiftDateKey('2026-10-05', 1)).toBe('2026-10-06')
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDateKey('2026-03-08', 1)).toBe('2026-03-09')
    expect(formatDateKey('2026-10-05')).toBe('Mon, 5 Oct 2026')
    expect(() => shiftDateKey('05/10/2026', 1)).toThrow(RangeError)
  })

  it('recognises existing calendar dates in YYYY-MM-DD form', () => {
    expect(isDateKey('2026-10-05')).toBe(true)
    expect(isDateKey('2028-02-29')).toBe(true)
    expect(isDateKey('2026-02-29')).toBe(false)
    expect(isDateKey('2026-13-01')).toBe(false)
    expect(isDateKey('2026-10-5')).toBe(false)
    expect(isDateKey('05/10/2026')).toBe(false)
    expect(isDateKey('2026-10-05T00:00')).toBe(false)
    expect(isDateKey('')).toBe(false)
  })
})

describe('wall time ⇄ UTC', () => {
  it('converts company wall time to UTC and back', () => {
    expect(wallTimeToUtc('2026-10-05T09:00', AMMAN)).toBe('2026-10-05T06:00:00.000Z')
    expect(wallTimeToUtc('2026-10-05T09:00:30', AMMAN)).toBe('2026-10-05T06:00:30.000Z')
    expect(utcToWallTime('2026-10-05T06:00:00.000Z', AMMAN)).toBe('2026-10-05T09:00')
    expect(wallTimeToUtc('2026-10-05T09:00', KOLKATA)).toBe('2026-10-05T03:30:00.000Z')
    expect(utcToWallTime('2026-10-05T21:30:00Z', AMMAN)).toBe('2026-10-06T00:30')
  })

  it('handles the America/New_York spring-forward gap by moving forward', () => {
    expect(wallTimeToUtc('2026-03-08T01:59', NEW_YORK)).toBe('2026-03-08T06:59:00.000Z') // EST
    expect(wallTimeToUtc('2026-03-08T02:30', NEW_YORK)).toBe('2026-03-08T07:30:00.000Z') // → 03:30 EDT
    expect(wallTimeToUtc('2026-03-08T03:00', NEW_YORK)).toBe('2026-03-08T07:00:00.000Z') // EDT
    expect(isWallTimeShifted('2026-03-08T02:30', NEW_YORK)).toBe(true)
    expect(isWallTimeShifted('2026-03-08T03:30', NEW_YORK)).toBe(false)
    expect(utcToWallTime(wallTimeToUtc('2026-03-08T02:30', NEW_YORK) ?? '', NEW_YORK)).toBe('2026-03-08T03:30')
  })

  it('resolves the America/New_York fall-back overlap to the first occurrence', () => {
    expect(wallTimeToUtc('2026-11-01T01:30', NEW_YORK)).toBe('2026-11-01T05:30:00.000Z') // 01:30 EDT
    expect(isWallTimeShifted('2026-11-01T01:30', NEW_YORK)).toBe(false)
    // The second 01:30 (EST) still formats as 01:30 wall time.
    expect(utcToWallTime('2026-11-01T06:30:00Z', NEW_YORK)).toBe('2026-11-01T01:30')
  })

  it.each(['', 'garbage', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-05T24:00', '2026-10-05T10:60', '2026-10-05 10:00'])(
    'rejects invalid wall time %j',
    (value) => {
      expect(wallTimeToUtc(value, AMMAN)).toBeNull()
    },
  )
})

describe('date and 24-hour time entry', () => {
  it('splits an instant into the company-local date and HH:mm', () => {
    expect(toWallParts('2026-10-05T21:30:00Z', AMMAN)).toEqual({ date: '2026-10-06', time: '00:30' })
    expect(toWallParts(null, AMMAN)).toEqual({ date: '', time: '' })
  })

  it.each([
    ['00:00', true],
    ['23:59', true],
    ['09:07', true],
    ['24:00', false],
    ['9:00', false],
    ['09:60', false],
    ['', false],
  ])('recognises %j as a time of day: %s', (value, expected) => {
    expect(isTimeOfDay(value)).toBe(expected)
  })

  it('offers every quarter hour of an ordinary day, or another step', () => {
    const slots = wallTimeSlots('2026-10-05', AMMAN)
    expect(slots).toHaveLength(96)
    expect(slots.slice(0, 3)).toEqual(['00:00', '00:15', '00:30'])
    expect(slots.at(-1)).toBe('23:45')
    expect(wallTimeSlots('2026-10-05', AMMAN, { stepMinutes: 30 })).toHaveLength(48)
    expect(wallTimeSlots(null, NEW_YORK)).toHaveLength(96)
  })

  it('leaves out the times a spring-forward gap removes, and keeps both days around it whole', () => {
    const gapDay = wallTimeSlots('2026-03-08', NEW_YORK)
    expect(gapDay).toHaveLength(92)
    expect(gapDay).not.toContain('02:00')
    expect(gapDay).not.toContain('02:45')
    expect(gapDay).toContain('01:45')
    expect(gapDay).toContain('03:00')
    expect(wallTimeSlots('2026-03-07', NEW_YORK)).toHaveLength(96)
    expect(wallTimeSlots('2026-03-09', NEW_YORK)).toHaveLength(96)
    // A fall-back day keeps every wall time (the repeated hour is offered once).
    expect(wallTimeSlots('2026-11-01', NEW_YORK)).toHaveLength(96)
  })

  it('adds a current time off the grid in order, and ignores anything that is not a time', () => {
    const slots = wallTimeSlots('2026-10-05', AMMAN, { include: '09:07' })
    expect(slots).toHaveLength(97)
    expect(slots.slice(36, 39)).toEqual(['09:00', '09:07', '09:15'])
    expect(wallTimeSlots('2026-10-05', AMMAN, { include: '09:15' })).toHaveLength(96)
    expect(wallTimeSlots('2026-10-05', AMMAN, { include: 'soon' })).toHaveLength(96)
  })
})

describe('nextHalfHourUtc (Invite form default start)', () => {
  it('rounds up to the next :00 or :30 company wall-clock boundary', () => {
    expect(nextHalfHourUtc(AMMAN, '2026-10-05T06:10:00Z')).toBe('2026-10-05T06:30:00.000Z') // 09:10 → 09:30
    expect(nextHalfHourUtc(AMMAN, '2026-10-05T06:30:00Z')).toBe('2026-10-05T07:00:00.000Z') // exactly 09:30 → 10:00
    expect(nextHalfHourUtc(AMMAN, '2026-10-05T06:59:59.999Z')).toBe('2026-10-05T07:00:00.000Z')
    expect(nextHalfHourUtc(AMMAN, '2026-10-05T20:45:00Z')).toBe('2026-10-05T21:00:00.000Z') // 23:45 → 00:00 next day
  })

  it('uses company wall-clock boundaries for half-hour offsets', () => {
    // 03:40 UTC = 09:10 in Kolkata → 09:30 local = 04:00 UTC.
    expect(nextHalfHourUtc(KOLKATA, '2026-10-05T03:40:00Z')).toBe('2026-10-05T04:00:00.000Z')
  })

  it('stays on the instant timeline inside the fall-back overlap', () => {
    // 06:10 UTC = 01:10 EST (second occurrence) → 01:30 EST = 06:30 UTC, not 01:30 EDT (05:30 UTC).
    expect(nextHalfHourUtc(NEW_YORK, '2026-11-01T06:10:00Z')).toBe('2026-11-01T06:30:00.000Z')
  })
})

describe('independence from the browser timezone', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Tokyo'])('gives identical results when the browser is in %s', (zone) => {
    vi.stubEnv('TZ', zone)
    // Sanity check: the process timezone really changed.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)

    expect(formatDateTime('2026-10-05T21:30:00Z', AMMAN)).toBe('Tue, 6 Oct 2026, 00:30')
    expect(wallTimeToUtc('2026-10-05T09:00', AMMAN)).toBe('2026-10-05T06:00:00.000Z')
    expect(wallTimeToUtc('2026-03-08T02:30', NEW_YORK)).toBe('2026-03-08T07:30:00.000Z')
    expect(relativeDayLabel('2026-10-06T06:00:00Z', AMMAN, '2026-10-05T21:30:00Z')).toBe('Today')
    expect(nextHalfHourUtc(AMMAN, '2026-10-05T06:10:00Z')).toBe('2026-10-05T06:30:00.000Z')
  })
})

/**
 * Line-break opportunities (UAX #14), simplified to what dates and times contain: after a space, and
 * after an en dash unless a word joiner follows it. No-break spaces and joiners are not ones.
 */
function breaks(text: string): number[] {
  return [...text.matchAll(/ |\u2013(?!\u2060)/g)].map((match) => match.index)
}

/** U+00A0 between the day, the month's words and the year of an Arabic date (they never part at a line end). */
const NB = '\u00a0'

describe('Arabic (Levantine month names, Latin digits)', () => {
  const lateEvening = '2026-10-05T21:30:00Z'

  it('formats dates with Levantine month names and Latin digits; times stay 24-hour', () => {
    expect(formatDate(lateEvening, AMMAN, 'ar')).toBe(`الثلاثاء، 6${NB}تشرين${NB}الأول${NB}2026`)
    expect(formatShortDate(lateEvening, AMMAN, 'ar')).toBe(`الثلاثاء، 6${NB}تشرين${NB}الأول`)
    expect(formatTime(lateEvening, AMMAN)).toBe('00:30')
    expect(formatDateTime(lateEvening, AMMAN, 'ar')).toBe(`الثلاثاء، 6${NB}تشرين${NB}الأول${NB}2026، 00:30`)
    expect(formatDateAtTime(lateEvening, AMMAN, 'ar')).toBe(`الثلاثاء، 6${NB}تشرين${NB}الأول${NB}2026 الساعة 00:30`)
    expect(formatDateTimeRange('2026-10-05T06:00:00Z', '2026-10-05T07:30:00Z', AMMAN, 'ar')).toBe(`الاثنين، 5${NB}تشرين${NB}الأول${NB}2026، 09:00–\u206010:30`)
    expect(formatDateTime(lateEvening, AMMAN, 'ar')).not.toMatch(/[٠-٩\u200E\u200F\u061C]/)
  })

  it('names every month as people do across Jordan', () => {
    // "الخميس، 15 كانون الثاني 2026": the weekday, then the day, the month and the year kept together.
    const months = Array.from({ length: 12 }, (_, index) =>
      formatDateKey(`2026-${String(index + 1).padStart(2, '0')}-15`, 'ar').split(' ')[1]!.split(NB).slice(1, -1).join(' '),
    )
    expect(months).toEqual([
      'كانون الثاني',
      'شباط',
      'آذار',
      'نيسان',
      'أيار',
      'حزيران',
      'تموز',
      'آب',
      'أيلول',
      'تشرين الأول',
      'تشرين الثاني',
      'كانون الأول',
    ])
  })

  it('never breaks an Arabic date or a time range across lines (review: «تشرين» / «الأول», «00:00–» / «00:45»)', () => {
    const date = formatDate('2026-10-07T21:00:00Z', AMMAN, 'ar') // الخميس، 8 تشرين الأول 2026
    expect(breaks(date)).toEqual([date.indexOf('، ') + 1])
    const range = formatDateTimeRange('2026-10-07T21:00:00Z', '2026-10-07T21:45:00Z', AMMAN, 'ar')
    expect(range).toBe(`الخميس، 8${NB}تشرين${NB}الأول${NB}2026، 00:00–\u206000:45`)
    // Only after the weekday's comma and after the comma between the date and the times.
    expect(breaks(range).map((index) => range[index! - 1])).toEqual(['،', '،'])
    expect(breaks(formatTimeRange('2026-10-07T21:00:00Z', '2026-10-07T21:45:00Z', AMMAN, 'ar'))).toEqual([])
    expect(breaks(joinTimeRange('09:00', '10:00'))).toEqual([])
    // Across days: the dash stays with the start, the line may break after it.
    const across = joinSpacedRange('23:49', formatDateTime('2026-10-07T21:19:00Z', AMMAN, 'ar'))
    expect(across.indexOf(`${NB}–`)).toBe(5)
    expect(across).not.toMatch(/تشرين |الأول 2026/)
    // English dates keep their fixed format; the time range is bound there too.
    expect(formatDate('2026-10-07T21:00:00Z', AMMAN, 'en')).toBe('Thu, 8 Oct 2026')
    expect(breaks(formatTimeRange('2026-10-07T21:00:00Z', '2026-10-07T21:45:00Z', AMMAN, 'en'))).toEqual([])
  })

  it('splits a moment into its date and time for a sentence, saying whether it is on the reference day', () => {
    // 21:48 on Wed 7 Oct (Amman) against Thu 8 Oct 00:03: another day, so the sentence names the date.
    expect(momentOnDay('2026-10-07T18:48:00Z', '2026-10-07T21:03:00Z', AMMAN, 'ar')).toEqual({
      sameDay: false,
      date: `الأربعاء، 7${NB}تشرين${NB}الأول${NB}2026`,
      time: '21:48',
    })
    expect(momentOnDay('2026-10-07T18:48:00Z', '2026-10-07T20:30:00Z', AMMAN, 'en')).toEqual({ sameDay: true, date: 'Wed, 7 Oct 2026', time: '21:48' })
  })

  it('labels relative days and the time zone in Arabic', () => {
    expect(relativeDayLabel('2026-10-06T06:00:00Z', AMMAN, lateEvening, 'ar')).toBe('اليوم')
    expect(relativeDayLabel('2026-10-07T06:00:00Z', AMMAN, lateEvening, 'ar')).toBe('غدًا')
    expect(relativeDayLabel('2026-10-05T06:00:00Z', AMMAN, lateEvening, 'ar')).toBe('أمس')
    expect(formatRelativeDateTime('2026-10-06T06:30:00Z', AMMAN, lateEvening, 'ar')).toBe('اليوم، 09:30')
    expect(formatTimeZoneName(AMMAN, '2026-10-05T12:00:00Z', 'ar')).toBe('توقيت عمّان (UTC+3)')
    expect(formatTimeZoneName(NEW_YORK, '2026-07-15T12:00:00Z', 'ar')).toBe('توقيت نيويورك (UTC-4)')
    // A place without an Arabic name keeps its English one; a zone without a place, its offset.
    expect(formatTimeZoneName('America/Bogota', '2026-07-15T12:00:00Z', 'ar')).toBe('توقيت Bogota (UTC-5)')
    expect(formatTimeZoneName('UTC', '2026-01-15T12:00:00Z', 'ar')).toBe('UTC')
  })

  it('follows the UI language when none is given', async () => {
    await i18n.changeLanguage('ar')
    try {
      expect(formatDate(lateEvening, AMMAN)).toBe(`الثلاثاء، 6${NB}تشرين${NB}الأول${NB}2026`)
      expect(relativeDayLabel('2026-10-06T06:00:00Z', AMMAN, lateEvening)).toBe('اليوم')
    } finally {
      await i18n.changeLanguage('en')
    }
    expect(formatDate(lateEvening, AMMAN)).toBe('Tue, 6 Oct 2026')
  })
})

describe('formatRelativeTime', () => {
  const now = '2026-10-05T12:00:00Z'

  it('says the distance in its largest whole unit', () => {
    expect(formatRelativeTime('2026-10-05T09:00:00Z', now, 'en')).toBe('3 hours ago')
    expect(formatRelativeTime('2026-10-05T12:20:00Z', now, 'en')).toBe('in 20 minutes')
    expect(formatRelativeTime('2026-10-05T11:59:30Z', now, 'en')).toBe('now')
    expect(formatRelativeTime('2026-10-06T12:00:00Z', now, 'en')).toBe('tomorrow')
    expect(formatShortDate('2026-10-05T12:00:00Z', AMMAN, 'en')).toBe('Mon, 5 Oct')
  })

  it('in Arabic, with Latin digits', () => {
    expect(formatRelativeTime('2026-10-05T09:00:00Z', now, 'ar')).toBe('قبل 3 ساعات')
    expect(formatRelativeTime('2026-10-05T12:20:00Z', now, 'ar')).toBe('خلال 20 دقيقة')
    expect(formatRelativeTime('2026-10-05T11:59:30Z', now, 'ar')).toBe('الآن')
    expect(formatRelativeTime('2026-10-06T12:00:00Z', now, 'ar')).toBe('غدًا')
  })
})
