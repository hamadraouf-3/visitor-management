import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { getEmployeeDashboard } from '../../api/dashboard'
import { isApiError } from '../../api/client'
import { queryKeys } from '../../api/queryKeys'
import { cancelVisit, createVisit, issueVisitPass, listVisits, resendInvitation, updateVisit } from '../../api/visits'
import type { Visit, VisitCancelRequest, VisitCreate, VisitListParams, VisitPassResult, VisitResendResult, VisitUpdate } from '../../types/api'

export function useEmployeeDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard.employee,
    queryFn: ({ signal }) => getEmployeeDashboard({ signal }),
  })
}

/** Everything but the page and the search text: the "view" a list shows. */
function listView(params: VisitListParams): string {
  const { page: _page, q: _q, ...view } = params
  return JSON.stringify(view, Object.keys(view).toSorted())
}

/**
 * A page of visits. While the next page or search loads, the previous rows of the SAME view
 * stay on screen (marked busy); a different view (another tab) starts empty, so rows of one
 * tab never appear under another.
 */
export function useVisitList(params: VisitListParams) {
  return useQuery({
    queryKey: queryKeys.visits.list(params),
    queryFn: ({ signal }) => listVisits(params, { signal }),
    placeholderData: (previous, previousQuery) => {
      const previousParams = previousQuery?.queryKey[2] as VisitListParams | undefined
      return previousParams && listView(previousParams) === listView(params) ? keepPreviousData(previous) : undefined
    },
  })
}

/**
 * After a visit changed (created, edited, cancelled, checked in or out, a walk-in, a bulk
 * check-out): every list and count that can show it, on any screen. The detail itself is set
 * from the mutation's response, so it is not refetched. Invalidating a query no screen shows
 * only marks it stale.
 */
export function refreshAfterVisitChange(queryClient: QueryClient, visit?: Visit): void {
  if (visit) queryClient.setQueryData(queryKeys.visits.detail(visit.id), visit)
  void queryClient.invalidateQueries({ queryKey: queryKeys.visits.lists })
  void queryClient.invalidateQueries({ queryKey: queryKeys.visitors.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.reception.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.employee })
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.admin })
  // A check-out or a cancellation ends the visit's tracking (Phase 15), in the same transaction.
  void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.all })
}

/**
 * A refused change (409: the visit changed status meanwhile; 404/403: gone or out of scope)
 * means the shown visit is stale: reload it so its status and allowed actions are current.
 */
function refreshStaleVisit(queryClient: QueryClient, visitId: string, error: unknown): void {
  if (isApiError(error) && (error.status === 409 || error.status === 404 || error.status === 403)) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(visitId) })
  }
}

/**
 * Creates a visit (and invitation). The result carries the one-time `pass_url`; `gcTime: 0`
 * drops it from the mutation cache as soon as no component shows it (§6: never retrievable
 * later).
 */
export function useCreateVisit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VisitCreate) => createVisit(body),
    gcTime: 0,
    onSuccess: (result) => refreshAfterVisitChange(queryClient, result.visit),
  })
}

export function useUpdateVisit(visitId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VisitUpdate) => updateVisit(visitId, body),
    onSuccess: (visit) => refreshAfterVisitChange(queryClient, visit),
    onError: (error) => refreshStaleVisit(queryClient, visitId, error),
  })
}

export function useCancelVisit(visitId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VisitCancelRequest) => cancelVisit(visitId, body),
    onSuccess: (visit) => refreshAfterVisitChange(queryClient, visit),
    onError: (error) => refreshStaleVisit(queryClient, visitId, error),
  })
}

/** Rotates the pass and sends a new invitation; the result carries the new one-time `pass_url`. */
export function useResendInvitation(visitId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (): Promise<VisitResendResult> => resendInvitation(visitId),
    gcTime: 0,
    onSuccess: (result) => refreshAfterVisitChange(queryClient, result.visit),
    onError: (error) => refreshStaleVisit(queryClient, visitId, error),
  })
}

/**
 * Rotates the pass without sending an email; the result carries the new one-time `pass_url`
 * for the host to share (`gcTime: 0`, as for the other one-time links).
 */
export function useIssuePass(visitId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (): Promise<VisitPassResult> => issueVisitPass(visitId),
    gcTime: 0,
    onSuccess: (result) => refreshAfterVisitChange(queryClient, result.visit),
    onError: (error) => refreshStaleVisit(queryClient, visitId, error),
  })
}
