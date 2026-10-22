import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { isApiError } from '../../api/client'
import { isBackgroundFetch, LIST_POLL_MS } from '../../api/queries'
import { queryKeys } from '../../api/queryKeys'
import { checkOutStale, createWalkIn, getReceptionToday, scanPass } from '../../api/reception'
import { searchVisitors } from '../../api/visitors'
import { checkInVisit, checkOutVisit } from '../../api/visits'
import { refreshPlacesAfterRefusal } from '../accessAreas/areaRefusal'
import type { CheckInRequest, CheckOutRequest, CheckOutStaleRequest, ScanRequest, WalkInCreate } from '../../types/api'
import { refreshAfterVisitChange } from '../visits/queries'

/** Results of the visitor search ("Find a visitor"). */
export const VISITOR_LOOKUP_SIZE = 10

/**
 * Today's counts and lists (GET /reception/today), polled every 15 s. Every fetch after the
 * first answer carries `X-Background-Refresh: 1` (§7.2), so a reception tablet left alone
 * still reaches the session's idle timeout.
 */
export function useReceptionToday() {
  return useQuery({
    queryKey: queryKeys.reception.today,
    queryFn: ({ signal, client, queryKey }) => getReceptionToday({ signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
    refetchInterval: LIST_POLL_MS,
  })
}

/** Visitors matching the search box with their actionable visits of today (`today_visits`, B24-11). */
export function useVisitorLookup(q: string) {
  const params = { q, page_size: VISITOR_LOOKUP_SIZE }
  return useQuery({
    queryKey: queryKeys.visitors.search(params),
    queryFn: ({ signal }) => searchVisitors(params, { signal }),
    enabled: q.length >= 2,
  })
}

/**
 * A refused change (409: the visit changed meanwhile, e.g. someone else checked the visitor in;
 * 404/403/410) means the lists are stale: reload them so the row shows its current state.
 */
function refreshAfterRefusal(queryClient: QueryClient, error: unknown): void {
  if (isApiError(error) && (error.status === 409 || error.status === 404 || error.status === 403 || error.status === 410)) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.reception.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.visitors.all })
  }
}

/** POST /reception/scan. A scan changes nothing, so nothing is refreshed. */
export function useScanPass() {
  return useMutation({ mutationFn: (body: ScanRequest) => scanPass(body) })
}

export function useCheckIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: { visitId: string; body: CheckInRequest }) => checkInVisit(visitId, body),
    onSuccess: (visit) => refreshAfterVisitChange(queryClient, visit),
    onError: (error) => refreshAfterRefusal(queryClient, error),
  })
}

export function useCheckOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ visitId, body }: { visitId: string; body: CheckOutRequest }) => checkOutVisit(visitId, body),
    onSuccess: (visit) => refreshAfterVisitChange(queryClient, visit),
    onError: (error) => refreshAfterRefusal(queryClient, error),
  })
}

export function useCheckOutStale() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CheckOutStaleRequest) => checkOutStale(body),
    onSuccess: () => refreshAfterVisitChange(queryClient),
    onError: (error) => refreshAfterRefusal(queryClient, error),
  })
}

/**
 * Registers a walk-in. A refusal refreshes what it proves stale: 409 VISITOR_ALREADY_INSIDE
 * the Inside list and counts; 409 WALK_INS_DISABLED the company settings too, so the Walk-in
 * tab shows that walk-ins are turned off instead of keeping the form open; a refused allowed
 * area (archived meanwhile) the places (F16-43).
 */
export function useCreateWalkIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: WalkInCreate) => createWalkIn(body),
    onSuccess: (visit) => refreshAfterVisitChange(queryClient, visit),
    onError: (error) => {
      refreshAfterRefusal(queryClient, error)
      refreshPlacesAfterRefusal(queryClient, error)
      if (isApiError(error) && error.code === 'WALK_INS_DISABLED') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.companySettings })
      }
    },
  })
}
