/**
 * How long ago a place was seen, as of `now`: the server's `freshness_seconds` when it answered (`answeredAt`)
 * plus the time since. Never the device's clock against the server's, which may differ (F15-5). Without a
 * known answer time (`answeredAt` 0, as a query reports while it shows placeholder data), the server's own
 * figure, never "497913h ago" (F15-30).
 */
export function agoSeconds(freshness: number | null, answeredAt: number, now: number): number {
  const since = answeredAt > 0 ? Math.max(0, Math.round((now - answeredAt) / 1000)) : 0
  return (freshness ?? 0) + since
}
