import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isApiError } from '../../api/client'
import { queryKeys } from '../../api/queryKeys'
import { getLocations } from '../../api/tracking'
import { updateVisitAccessAreas } from '../../api/visits'
import type { VisitAccessAreasInput } from '../../types/api'
import { refreshAfterVisitChange } from '../visits/queries'
import { areaOptions } from './accessAreas'
import { refreshPlacesAfterRefusal } from './areaRefusal'

/** Places change rarely: one load per few minutes while a form or a dialog needs them. */
const LOCATIONS_STALE_MS = 5 * 60_000

/**
 * The company's active floors and zones, as the allowed areas' picker offers them (`GET /locations`: every
 * role reads it since Phase 16, a host the active places only). One cache entry with the administration's
 * locations editor, which asks again after each change of a place.
 */
export function useAreaOptions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.tracking.locations,
    queryFn: ({ signal }) => getLocations({ signal }),
    enabled,
    staleTime: LOCATIONS_STALE_MS,
    select: areaOptions,
  })
}

/**
 * Changes a visit's allowed areas (`PUT /visits/{id}/access-areas`). The answer is the visit; its journey, the
 * live map, the lists and the alerts follow (a change may resolve the active alert or raise one). A refusal
 * because the visit moved on (409) or went away reloads what the page shows; one naming a place (archived
 * meanwhile) reloads the places (F16-43).
 */
export function useUpdateVisitAccessAreas(visitId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VisitAccessAreasInput) => updateVisitAccessAreas(visitId, body),
    onSuccess: (visit) => {
      refreshAfterVisitChange(queryClient, visit)
      void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.alerts.all })
    },
    onError: (error) => {
      refreshPlacesAfterRefusal(queryClient, error)
      if (isApiError(error) && (error.status === 409 || error.status === 404 || error.status === 403)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(visitId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.detail(visitId) })
      }
    },
  })
}
