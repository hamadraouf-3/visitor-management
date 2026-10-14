import { describe, expect, it } from 'vitest'
import { attendanceLines, formatAttendance, formatTodayVisitTime, formatVisitDateRange, formatVisitTimes, formatVisitWhen } from './format'

const AMMAN = 'Asia/Amman' // UTC+3
const scheduled_start = '2026-09-20T06:00:00Z' // 09:00 Amman
const NOW = '2026-10-05T16:00:00Z' // Mon 5 Oct 2026, 19:00 Amman

describe('formatAttendance', () => {
  it('puts check-in, check-out and time on site on one line', () => {
    expect(
      formatAttendance(
        { scheduled_start, check_in_at: '2026-09-20T06:02:00Z', check_out_at: '2026-09-20T07:15:00Z', duration_seconds: 4380 },
        AMMAN,
      ),
    ).toBe('In 09:02 · Out 10:15 · 1h 13m')
  })

  it('says when the visitor has not checked out, and dates a time on another day', () => {
    expect(formatAttendance({ scheduled_start, check_in_at: '2026-09-20T06:02:00Z', check_out_at: null, duration_seconds: null }, AMMAN)).toBe(
      'In 09:02 · not checked out',
    )
    expect(
      formatAttendance(
        { scheduled_start, check_in_at: '2026-09-20T06:02:00Z', check_out_at: '2026-09-21T06:00:00Z', duration_seconds: 86280 },
        AMMAN,
      ),
    ).toBe('In 09:02 · Out Mon, 21 Sep 2026, 09:00 · 23h 58m')
  })

  it('splits into the times and the time on site for a narrow column (attendanceLines)', () => {
    expect(
      attendanceLines({ scheduled_start, check_in_at: '2026-09-20T06:02:00Z', check_out_at: '2026-09-20T07:15:00Z', duration_seconds: 4380 }, AMMAN),
    ).toEqual({ times: 'In 09:02 · Out 10:15', length: '1h 13m' })
    expect(attendanceLines({ scheduled_start, check_in_at: '2026-09-20T06:02:00Z', check_out_at: null, duration_seconds: null }, AMMAN)).toEqual({
      times: 'In 09:02',
      length: 'Not checked out',
    })
    expect(attendanceLines({ scheduled_start, check_in_at: null, check_out_at: null, duration_seconds: null }, AMMAN)).toBeNull()
  })

  it('is empty for a visit nobody checked in to', () => {
    expect(formatAttendance({ scheduled_start, check_in_at: null, check_out_at: null, duration_seconds: null }, AMMAN)).toBeNull()
  })
})

describe('visit dates and times', () => {
  it('words one company day with a closed dash', () => {
    expect(formatVisitDateRange('2026-10-07T00:12:00Z', '2026-10-07T03:12:00Z', AMMAN)).toBe('Wed, 7 Oct 2026, 03:12–\u206006:12')
    expect(formatVisitWhen('2026-10-05T19:17:00Z', '2026-10-05T20:12:00Z', AMMAN, NOW)).toBe('Today, 22:17–\u206023:12')
    expect(formatVisitWhen('2026-10-09T06:00:00Z', '2026-10-09T07:00:00Z', AMMAN, NOW)).toBe('Fri, 9 Oct 2026, 09:00–\u206010:00')
  })

  it('names the end day of a visit across midnight in short form, the year only when it changes', () => {
    expect(formatVisitDateRange('2026-10-05T19:42:00Z', '2026-10-05T21:42:00Z', AMMAN)).toBe('Mon, 5 Oct 2026, 22:42\u00a0– Tue, 6 Oct, 00:42')
    expect(formatVisitDateRange('2026-12-31T20:00:00Z', '2026-12-31T22:00:00Z', AMMAN)).toBe('Thu, 31 Dec 2026, 23:00\u00a0– Fri, 1 Jan 2027, 01:00')
  })

  it('gives the times under a date line, naming only the later day of a visit across midnight', () => {
    expect(formatVisitTimes('2026-10-07T00:12:00Z', '2026-10-07T03:12:00Z', AMMAN)).toBe('03:12–\u206006:12')
    expect(formatVisitTimes('2026-10-05T19:42:00Z', '2026-10-05T21:42:00Z', AMMAN)).toBe('22:42\u00a0– Tue, 6 Oct, 00:42')
    expect(formatVisitTimes('2026-10-05T19:42:00Z', '2026-10-05T21:42:00Z', AMMAN, 'ar')).toBe('22:42\u00a0– الثلاثاء، 6\u00a0تشرين\u00a0الأول، 00:42')
  })

  it('keeps the relative day in lists for a visit across midnight', () => {
    expect(formatVisitWhen('2026-10-05T19:42:00Z', '2026-10-05T21:42:00Z', AMMAN, NOW)).toBe('Today, 22:42\u00a0– Tomorrow, 00:42')
    expect(formatVisitWhen('2026-10-04T20:00:00Z', '2026-10-04T22:00:00Z', AMMAN, NOW)).toBe('Yesterday, 23:00\u00a0– Today, 01:00')
    expect(formatVisitWhen('2026-10-09T19:00:00Z', '2026-10-09T22:00:00Z', AMMAN, NOW)).toBe('Fri, 9 Oct 2026, 22:00\u00a0– Sat, 10 Oct, 01:00')
  })

  it('gives only the time of one of today’s visits where the column already says “Today”', () => {
    expect(formatTodayVisitTime('2026-10-05T06:00:00Z', '2026-10-05T07:00:00Z', AMMAN, NOW)).toBe('09:00–\u206010:00')
    expect(formatTodayVisitTime('2026-10-05T19:42:00Z', '2026-10-05T21:42:00Z', AMMAN, NOW)).toBe('from 22:42')
    expect(formatTodayVisitTime('2026-10-04T20:00:00Z', '2026-10-04T22:00:00Z', AMMAN, NOW)).toBe('until 01:00')
    // Still inside from an earlier day (B24-11): dated in full.
    expect(formatTodayVisitTime('2026-10-04T06:00:00Z', '2026-10-04T07:00:00Z', AMMAN, NOW)).toBe('Yesterday, 09:00–\u206010:00')
  })
})
