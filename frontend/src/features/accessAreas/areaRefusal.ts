import type { QueryClient } from '@tanstack/react-query'
import { getFieldErrorCodes, getFieldErrors, isApiError } from '../../api/client'
import { queryKeys } from '../../api/queryKeys'

/** `floor_ids` / `zone_ids` of a visit's areas, or of a new visit's (`access_areas.floor_ids`). */
const AREA_FIELD = /(?:^|\.)(?:floor_ids|zone_ids)$/

/**
 * Whether a refusal names an allowed area (422 on `floor_ids` / `zone_ids`: archived, or gone): a place the
 * picker offered is no longer there.
 */
export function refusesAnArea(error: unknown): boolean {
  if (!isApiError(error) || error.status !== 422) return false
  return Object.keys({ ...getFieldErrors(error), ...getFieldErrorCodes(error) }).some((path) => AREA_FIELD.test(path))
}

/**
 * After such a refusal the company's places are asked for again (`GET /locations`, otherwise kept for minutes):
 * the picker stops offering the place, and drops it from what it holds (F16-43), so a second try can succeed.
 */
export function refreshPlacesAfterRefusal(queryClient: QueryClient, error: unknown): void {
  if (refusesAnArea(error)) void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.locations })
}
