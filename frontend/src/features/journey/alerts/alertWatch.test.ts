import { describe, expect, it } from 'vitest'
import { briefOf, makeAlert, makeAlertSummary } from '../testRoutes'
import { alertKey, alertTitlePrefix, watchSummary } from './alertWatch'

const first = briefOf(makeAlert({ id: 'a1' }))
const second = briefOf(makeAlert({ id: 'a2', opened_at: '2026-10-20T08:58:00Z' }))

describe('what the shell’s watcher tells of', () => {
  it('only sets the counts on the first answer: those alerts were there before', () => {
    const step = watchSummary(makeAlertSummary({ open: 1, active: 1, latest: [first] }), null)
    expect(step.fresh).toEqual([])
    expect([...step.seen]).toEqual([alertKey(first)])
  })

  it('tells of an open alert not seen before, once', () => {
    const start = watchSummary(makeAlertSummary({ open: 1, active: 1, latest: [first] }), null)
    const next = watchSummary(makeAlertSummary({ open: 2, active: 2, latest: [second, first] }), start)
    expect(next.fresh).toEqual([second])
    expect(watchSummary(makeAlertSummary({ open: 2, active: 2, latest: [second, first] }), next).fresh).toEqual([])
  })

  it('tells again of an alert escalated to a restricted area (the server opens it again)', () => {
    const start = watchSummary(makeAlertSummary({ open: 1, active: 1, latest: [first] }), null)
    const escalated = { ...first, type: 'RESTRICTED_AREA' as const }
    expect(watchSummary(makeAlertSummary({ open: 1, active: 1, latest: [escalated] }), start).fresh).toEqual([escalated])
  })

  it('nothing to tell when no alert is open, also after some were', () => {
    const start = watchSummary(makeAlertSummary({ open: 1, active: 1, latest: [first] }), null)
    const step = watchSummary(makeAlertSummary(), start)
    expect(step.fresh).toEqual([])
    expect(step.seen).toBe(start.seen)
  })

  describe('more open alerts than the summary names (5, the newest first)', () => {
    // A1 (the oldest) … A6 (the newest), a minute apart: the first answer names A6 … A2.
    const six = Array.from({ length: 6 }, (_, index) => briefOf(makeAlert({ id: `A${index + 1}`, opened_at: `2026-10-20T08:0${index}:00Z` }))).toReversed()
    const summary = (latest: typeof six, open = latest.length) => makeAlertSummary({ open, active: open, latest })

    it('keeps the first answer’s oldest as the cut-off only when some open alert was left out', () => {
      expect(watchSummary(summary(six.slice(0, 5), 6), null).cutoff).toBe('2026-10-20T08:01:00Z')
      expect(watchSummary(summary(six.slice(0, 5)), null).cutoff).toBeNull()
    })

    it('never tells of an alert open before the start that moves up once a newer one is acknowledged (F16-38)', () => {
      const start = watchSummary(summary(six.slice(0, 5), 6), null)
      // A colleague acknowledged A6: A1 moves up into the five.
      const next = watchSummary(summary(six.slice(1), 5), start)
      expect(next.fresh).toEqual([])
      expect(next.seen.has(alertKey(six[5]!))).toBe(true)
      // A new alert is still told of.
      const fresh = briefOf(makeAlert({ id: 'A7', opened_at: '2026-10-20T08:30:00Z' }))
      expect(watchSummary(summary([fresh, ...six.slice(1, 5)], 6), next).fresh).toEqual([fresh])
    })

    it('still tells of an escalation of one seen before, older than the cut-off', () => {
      const start = watchSummary(summary(six.slice(0, 5), 6), null)
      // A6 acknowledged: A1 (older than the cut-off) is taken in; then it is escalated to a restricted area.
      const next = watchSummary(summary(six.slice(1), 5), start)
      const escalated = { ...six[5]!, type: 'RESTRICTED_AREA' as const }
      expect(watchSummary(summary([...six.slice(1, 5), escalated], 5), next).fresh).toEqual([escalated])
    })

    it('takes the cut-off from the summary’s order, so an escalation as the last brief makes nothing look new (B16-26)', () => {
      // E opened at 08:00 and escalated at 08:03; B opened at 08:01; C4 … C7 opened at 08:04 … 08:07. By
      // `escalated_at ?? opened_at` the first answer names C7 … C4 and E, and leaves B out.
      const escalated = briefOf(makeAlert({ id: 'E', type: 'RESTRICTED_AREA', opened_at: '2026-10-20T08:00:00Z', escalated_at: '2026-10-20T08:03:00Z' }))
      const left = briefOf(makeAlert({ id: 'B', opened_at: '2026-10-20T08:01:00Z' }))
      const newer = [7, 6, 5, 4].map((minute) => briefOf(makeAlert({ id: `C${minute}`, opened_at: `2026-10-20T08:0${minute}:00Z` })))
      const start = watchSummary(summary([...newer, escalated], 6), null)
      // C7 acknowledged: B moves up. It opened after E's opening but before E's escalation: there at the start.
      const next = watchSummary(summary([...newer.slice(1), escalated, left], 5), start)
      expect(next.fresh).toEqual([])
      expect(next.seen.has(alertKey(left))).toBe(true)
      // The cut-off is E's escalation, its place in the order, not its opening.
      expect(start.cutoff).toBe('2026-10-20T08:03:00Z')
    })

    it('tells of an alert the first answer left out once it escalates: it sorts by its escalation (B16-26)', () => {
      const start = watchSummary(summary(six.slice(0, 5), 6), null)
      // A1, left out and never seen, escalates at 08:20: the summary now names it first.
      const escalated = { ...six[5]!, type: 'RESTRICTED_AREA' as const, escalated_at: '2026-10-20T08:20:00Z' }
      const next = watchSummary(summary([escalated, ...six.slice(0, 4)], 6), start)
      expect(next.fresh).toEqual([escalated])
      // Told once.
      expect(watchSummary(summary([escalated, ...six.slice(0, 4)], 6), next).fresh).toEqual([])
    })
  })

  it('puts "(n) " before the title while alerts are open', () => {
    expect(alertTitlePrefix(0)).toBe('')
    expect(alertTitlePrefix(2)).toBe('(2) ')
  })
})
