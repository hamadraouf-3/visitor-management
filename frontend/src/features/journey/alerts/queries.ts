import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isBackgroundFetch } from '../../../api/queries'
import { queryKeys } from '../../../api/queryKeys'
import { acknowledgeTrackingAlert, getTrackingAlertSummary, listTrackingAlerts, resolveTrackingAlert } from '../../../api/tracking'
import type { TrackingAlert, TrackingAlertListParams } from '../../../types/api'

/** The shell asks for the alerts' counts every 15 s, also in a background tab (the contract): an alert must reach a receptionist who is on another tab. */
export const ALERT_SUMMARY_POLL_MS = 15_000
/** An open alerts page asks again as often (paused in a background tab, where the shell's poll speaks). */
export const ALERT_LIST_REFRESH_MS = 15_000

/**
 * The alerts' counts and the latest open ones (`GET /tracking/alerts/summary`). Every request is a background
 * refresh (`X-Background-Refresh: 1`): the shell's poll is never the person's own activity, so a screen left
 * open still reaches the session's idle timeout (§7.2, as the session check's heartbeat). `poll`: the shell's
 * watcher drives the polling; every other reader (the navigation's badge) only reads the same cache entry.
 */
export function useTrackingAlertSummary({ poll }: { poll: boolean }) {
  return useQuery({
    queryKey: queryKeys.tracking.alerts.summary,
    queryFn: ({ signal }) => getTrackingAlertSummary({ signal, backgroundRefresh: true }),
    refetchInterval: poll ? ALERT_SUMMARY_POLL_MS : false,
    refetchIntervalInBackground: poll,
    staleTime: poll ? 0 : Infinity,
    refetchOnWindowFocus: poll,
  })
}

/** A page of alerts: the active ones (any day) or a day's; the previous cards stay, marked busy, while the next load. */
export function useTrackingAlerts(params: TrackingAlertListParams) {
  return useQuery({
    queryKey: queryKeys.tracking.alerts.list(params),
    queryFn: ({ signal, client, queryKey }) => listTrackingAlerts(params, { signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
    placeholderData: keepPreviousData,
    refetchInterval: ALERT_LIST_REFRESH_MS,
  })
}

export type AlertActionKind = 'acknowledge' | 'resolve'

export interface AlertActionRequest {
  alertId: string
  kind: AlertActionKind
  /** One line, at most 300 characters; empty: none. */
  note: string
}

/**
 * Asks again for every list of alerts, the counts, and the journeys (whose rows, visitors and panels name the
 * active alert): after an action, or once a refused action's dialog is closed.
 */
export function useRefreshAlerts(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.alerts.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.all })
  }
}

/**
 * Acknowledging or resolving an alert (reception and administrators). Answered with the alert; the alerts and
 * the journeys are asked again. A refusal (409 `ALERT_RESOLVED`: it was resolved meanwhile) asks for nothing
 * here: its dialog says it first and asks again when it is closed (F16-33), so the card the person acted on
 * stays in place behind the dialog until then.
 */
export function useAlertAction() {
  const refresh = useRefreshAlerts()
  return useMutation({
    mutationFn: ({ alertId, kind, note }: AlertActionRequest): Promise<TrackingAlert> => {
      const body = { note: note.trim() || null }
      return kind === 'acknowledge' ? acknowledgeTrackingAlert(alertId, body) : resolveTrackingAlert(alertId, body)
    },
    onSuccess: refresh,
  })
}
