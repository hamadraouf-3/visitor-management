import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../api/queryKeys'
import { getVisitor, listVisitorVisits, searchVisitors, updateVisitor } from '../../api/visitors'
import type { VisitorSearchParams, VisitorUpdate } from '../../types/api'

export const VISITORS_PAGE_SIZE = 25
export const VISITOR_HISTORY_PAGE_SIZE = 20

/** Scoped visitor search (§7.5); the previous page stays visible while the next one loads. */
export function useVisitorSearch(params: VisitorSearchParams) {
  return useQuery({
    queryKey: queryKeys.visitors.search(params),
    queryFn: ({ signal }) => searchVisitors(params, { signal }),
    placeholderData: keepPreviousData,
  })
}

/** A visitor (scoped by the server). `enabled: false` waits, e.g. until the visitor is needed. */
export function useVisitor(visitorId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.visitors.detail(visitorId),
    queryFn: ({ signal }) => getVisitor(visitorId, { signal }),
    enabled,
  })
}

/** The visitor's visits, newest first, within the caller's scope. Loads once the profile is available. */
export function useVisitorVisits(visitorId: string, page: number, enabled: boolean) {
  const params = { page, page_size: VISITOR_HISTORY_PAGE_SIZE }
  return useQuery({
    queryKey: queryKeys.visitors.visits(visitorId, params),
    queryFn: ({ signal }) => listVisitorVisits(visitorId, params, { signal }),
    placeholderData: keepPreviousData,
    enabled,
  })
}

/**
 * Updates a visitor. Visits keep snapshots of the visitor's name and company that follow the
 * visitor while SCHEDULED (D-17), and an email change re-sends invitations (D-19), so visit
 * data is refreshed as well.
 */
export function useUpdateVisitor(visitorId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VisitorUpdate) => updateVisitor(visitorId, body),
    onSuccess: (visitor) => {
      const detailKey = queryKeys.visitors.detail(visitorId)
      queryClient.setQueryData(detailKey, visitor)
      // Everything else about visitors (searches, this visitor's history); the profile itself
      // is the response just stored.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.visitors.all,
        predicate: (query) => query.queryKey.length !== detailKey.length || query.queryKey.some((part, index) => part !== detailKey[index]),
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.visits.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.employee })
    },
  })
}
