import { useEffect, useState } from 'react'

/**
 * The current time, refreshed every `refreshMs` (default: each minute). Render code that
 * depends on "now" (today's date in the company timezone, "Today"/"Tomorrow" labels) reads it
 * from here instead of calling `Date.now()` during render, so it stays pure and still rolls
 * over at midnight on a page left open.
 */
export function useNow(refreshMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), refreshMs)
    return () => window.clearInterval(timer)
  }, [refreshMs])
  return now
}
