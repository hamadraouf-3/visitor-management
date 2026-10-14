import { describe, expect, it } from 'vitest'
import { SCHEDULE_MESSAGES, scheduleReadBack, validateSchedule } from './schedule'

const AMMAN = 'Asia/Amman' // UTC+3
const NOW = Date.parse('2026-10-05T06:10:00Z') // 09:10 Amman

describe('scheduleReadBack', () => {
  it('reads the range back in the app format: day first, 24-hour, with the length', () => {
    expect(scheduleReadBack({ start: '2026-10-05T17:30:00Z', end: '2026-10-05T18:30:00Z' }, AMMAN)).toBe(
      'Mon, 5 Oct 2026 · 20:30–\u206021:30 (1h)',
    )
    expect(scheduleReadBack({ start: '2026-10-06T06:00:00Z', end: '2026-10-06T07:30:00Z' }, AMMAN)).toBe(
      'Tue, 6 Oct 2026 · 09:00–\u206010:30 (1h 30m)',
    )
  })

  it('names the end day in short form when the visit crosses midnight in the company zone', () => {
    expect(scheduleReadBack({ start: '2026-10-05T20:00:00Z', end: '2026-10-05T22:00:00Z' }, AMMAN)).toBe(
      'Mon, 5 Oct 2026, 23:00\u00a0– Tue, 6 Oct, 01:00 (2h)',
    )
  })

  it('says nothing for an incomplete or reversed range (the field errors explain it)', () => {
    expect(scheduleReadBack({ start: null, end: '2026-10-05T18:30:00Z' }, AMMAN)).toBeNull()
    expect(scheduleReadBack({ start: '2026-10-05T18:30:00Z', end: '2026-10-05T18:30:00Z' }, AMMAN)).toBeNull()
    expect(scheduleReadBack({ start: '2026-10-05T18:30:00Z', end: '2026-10-05T17:30:00Z' }, AMMAN)).toBeNull()
  })
})

describe('validateSchedule', () => {
  it('mirrors the server rules (D-14, B24-24)', () => {
    expect(validateSchedule({ start: '2026-10-05T07:00:00Z', end: '2026-10-05T08:00:00Z' }, { now: NOW })).toEqual({})
    expect(validateSchedule({ start: '2026-10-05T07:00:00Z', end: '2026-10-05T07:00:00Z' }, { now: NOW })).toEqual({
      end: SCHEDULE_MESSAGES.endBeforeStart,
    })
    expect(validateSchedule({ start: '2026-10-05T07:00:00Z', end: '2026-10-06T07:01:00Z' }, { now: NOW })).toEqual({
      end: SCHEDULE_MESSAGES.tooLong,
    })
    // Five minutes of tolerance for the start.
    expect(validateSchedule({ start: '2026-10-05T06:06:00Z', end: '2026-10-05T07:00:00Z' }, { now: NOW })).toEqual({})
    expect(validateSchedule({ start: '2026-10-05T06:04:00Z', end: '2026-10-05T07:00:00Z' }, { now: NOW })).toEqual({
      start: SCHEDULE_MESSAGES.inPast,
    })
  })

  it('refuses an end in the past also when the start is not checked (a visit under way)', () => {
    const underWay = { start: '2026-10-05T06:00:00Z', end: '2026-10-05T06:05:00Z' }
    expect(validateSchedule(underWay, { now: NOW, checkStartInFuture: false })).toEqual({ end: SCHEDULE_MESSAGES.endInPast })
    expect(validateSchedule({ ...underWay, end: '2026-10-05T06:15:00Z' }, { now: NOW, checkStartInFuture: false })).toEqual({})
  })
})
