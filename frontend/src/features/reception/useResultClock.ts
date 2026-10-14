import { useEffect, useState } from 'react'
import type { FlowState } from './scanFlow'
import { RECENT_CHECK_IN_MS } from './scanOutcome'

/** How often "checked in 4m ago" and similar texts of a shown result are brought up to date. */
const DISPLAY_REFRESH_MS = 10_000

/** When the shown result's check-in stops being recent (§10: 5 minutes), or null when no rule depends on it. */
export function recentCheckInEndsAt(flow: FlowState): number | null {
  if (flow.step !== 'result' && flow.step !== 'acting') return null
  const { outcome } = flow
  if (outcome.kind !== 'inside' || !outcome.visit.check_in_at) return null
  const checkedInAt = Date.parse(outcome.visit.check_in_at)
  return Number.isNaN(checkedInAt) ? null : checkedInAt + RECENT_CHECK_IN_MS
}

/**
 * The one time the scan result is judged and shown with. The panel's actions and the keys that
 * trigger them (Enter in the empty pass field, or with nothing focused) read the same value, so
 * Enter can never check out a visitor while the panel still asks for a confirmation.
 *
 * It is never older than the moment the result arrived (`shownAt`), refreshes every 10 s for
 * the texts, and moves exactly when a recent check-in turns 5 minutes old, so the panel changes
 * from "Check out…" (confirmation) to the one-key "Check out" at that moment, not up to 10 s
 * later.
 */
export function useResultClock(flow: FlowState): number {
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), DISPLAY_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  const boundary = recentCheckInEndsAt(flow)
  useEffect(() => {
    if (boundary === null) return
    let timer: number
    const arm = () => {
      // A millisecond past the boundary: from then on the check-in is no longer recent.
      timer = window.setTimeout(
        () => {
          const now = Date.now()
          setTick(now)
          // The clock decides, not the timer: one that fired while the clock is still short of the
          // boundary (the device's clock was set back meanwhile) waits for the rest.
          if (now < boundary) arm()
        },
        Math.max(0, boundary - Date.now()) + 1,
      )
    }
    arm()
    return () => window.clearTimeout(timer)
  }, [boundary])

  const shownAt = flow.step === 'result' || flow.step === 'acting' ? flow.shownAt : 0
  return Math.max(tick, shownAt)
}
