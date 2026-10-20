import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { queryKeys } from '../../api/queryKeys'
import { getVisit } from '../../api/visits'
import type { Visit } from '../../types/api'

/** §10: the invitation status is polled every 2 s, for up to 30 s, while it is PENDING. */
export const INVITATION_POLL_INTERVAL_MS = 2000
export const INVITATION_POLL_WINDOW_MS = 30_000

/** Whether an email about the visit is still being sent: the invitation, or a cancellation or reschedule notice. */
function emailBeingSent(visit: Visit | undefined): boolean {
  return visit?.invitation.status === 'PENDING' || visit?.last_notice?.status === 'PENDING'
}

/**
 * The next poll delay, or false to stop: only while an email about the visit is being sent and
 * the polling window is open. Delivery that takes longer (retries with backoff, a lost
 * background task) is not chased indefinitely; the page then shows the current status and
 * offers a manual check.
 */
export function emailPollDelay(visit: Visit | undefined, windowOpen: boolean): number | false {
  return windowOpen && emailBeingSent(visit) ? INVITATION_POLL_INTERVAL_MS : false
}

/**
 * The visit as it is now, for something a person asked to make from it (Phase 14: the host's calendar
 * event, F14-15): fetched whatever the cache holds, which it then updates, so the page shows it too.
 *
 * - A request of the page already on its way may have left before the change this one is for: it is
 *   cancelled, and a new one asked (F14-28).
 * - Offline it fails at once, not paused until the connection is back (`networkMode: 'always'`, no
 *   retry): the person who asked gets the error now, and nothing opens later on its own.
 */
export async function fetchVisitNow(queryClient: QueryClient, visitId: string): Promise<Visit> {
  const queryKey = queryKeys.visits.detail(visitId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => getVisit(visitId, { signal }),
    staleTime: 0,
    networkMode: 'always',
    retry: false,
  })
}

/**
 * A visit, polled while its invitation or latest notice is PENDING (bounded by the polling
 * window). The window opens on mount and again on `restartPolling` (after a resend, a
 * cancellation or reschedule, or "Check again").
 */
export function useVisitDetail(visitId: string) {
  const [windowEndsAt, setWindowEndsAt] = useState(() => Date.now() + INVITATION_POLL_WINDOW_MS)
  const [windowOpen, setWindowOpen] = useState(true)

  useEffect(() => {
    if (!windowOpen) return
    const timer = window.setTimeout(() => setWindowOpen(false), Math.max(0, windowEndsAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [windowEndsAt, windowOpen])

  const query = useQuery({
    queryKey: queryKeys.visits.detail(visitId),
    queryFn: ({ signal }) => getVisit(visitId, { signal }),
    refetchInterval: (current) => emailPollDelay(current.state.data, windowOpen),
  })

  const pending = query.data?.invitation.status === 'PENDING'
  return {
    query,
    /** Still PENDING after the polling window: show the status as it is and offer a manual check. */
    pollingStopped: pending && !windowOpen,
    restartPolling: () => {
      setWindowEndsAt(Date.now() + INVITATION_POLL_WINDOW_MS)
      setWindowOpen(true)
    },
  }
}
