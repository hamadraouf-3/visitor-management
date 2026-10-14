import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { queryKeys } from '../../api/queryKeys'
import { listVisits } from '../../api/visits'
import type { VisitListParams } from '../../types/api'

/**
 * A page of the company-wide history. `params` is null while the filters cannot be sent (an
 * end date before the start date): no request is made. While another page or filter loads,
 * the previous rows stay on screen, marked busy, so the list does not jump.
 */
export function useHistoryList(params: VisitListParams | null) {
  return useQuery({
    queryKey: queryKeys.visits.list(params ?? {}),
    queryFn: ({ signal }) => listVisits(params ?? {}, { signal }),
    enabled: params !== null,
    placeholderData: keepPreviousData,
  })
}
