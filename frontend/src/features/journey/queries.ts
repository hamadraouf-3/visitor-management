import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../api/queryKeys'
import { enrollVisit, getTrackingStatus, getVisitJourney, listJourneys, listTrackingCameras, revokeVisitTracking } from '../../api/tracking'
import type { JourneyListParams, JourneyPage, TrackingEnrollRequest, VisitJourney } from '../../types/api'

/**
 * How often an open journey page asks again (paused in a background tab): observations arrive from the
 * provider at any time, and a state turns STALE or UNAVAILABLE as time passes, which only the server says.
 */
export const JOURNEY_LIST_REFRESH_MS = 30_000
export const JOURNEY_DETAIL_REFRESH_MS = 15_000
const STATUS_REFRESH_MS = 60_000

/** The tracking status for the page's one-line banner (all three roles). */
export function useTrackingStatus() {
  return useQuery({
    queryKey: queryKeys.tracking.status,
    queryFn: ({ signal }) => getTrackingStatus({ signal }),
    refetchInterval: STATUS_REFRESH_MS,
  })
}

/** A page of journeys with when it was answered (the device's clock), from which its `freshness_seconds` count on. */
export interface AnsweredJourneyPage {
  page: JourneyPage
  answeredAt: number
}

/**
 * A page of the day's journeys; the previous rows stay on screen, marked busy, while the next load. The answer
 * carries its own time: while placeholder rows show, the query's `dataUpdatedAt` is 0, and the rows on screen
 * must keep counting from when they were answered (F15-30).
 */
export function useJourneyList(params: JourneyListParams) {
  return useQuery({
    queryKey: queryKeys.journeys.list(params),
    queryFn: async ({ signal }): Promise<AnsweredJourneyPage> => ({ page: await listJourneys(params, { signal }), answeredAt: Date.now() }),
    placeholderData: keepPreviousData,
    refetchInterval: JOURNEY_LIST_REFRESH_MS,
  })
}

export function useVisitJourney(visitId: string) {
  return useQuery({
    queryKey: queryKeys.journeys.detail(visitId),
    queryFn: ({ signal }) => getVisitJourney(visitId, { signal }),
    refetchInterval: JOURNEY_DETAIL_REFRESH_MS,
  })
}

/**
 * The reception cameras a visit can be enrolled at: the server gives reception its active enrollment points
 * only, and administrators every active camera, of which the enrollment points are kept.
 */
export function useEnrollmentCameras(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tracking.cameras.list(),
    queryFn: ({ signal }) => listTrackingCameras({}, { signal }),
    enabled,
    select: (cameras) => cameras.filter((camera) => camera.is_active && camera.is_enrollment_point),
  })
}

/** After a tracking action: the answer is the visit's journey; every list of journeys is asked again. */
function useJourneyChanged(visitId: string) {
  const queryClient = useQueryClient()
  return (journey: VisitJourney) => {
    queryClient.setQueryData(queryKeys.journeys.detail(visitId), journey)
    void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.all })
  }
}

export function useEnrollVisit(visitId: string) {
  const changed = useJourneyChanged(visitId)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TrackingEnrollRequest) => enrollVisit(visitId, body),
    onSuccess: changed,
    // Refused (tracking turned off, the visit checked out, the camera archived meanwhile): the page shows what
    // holds now, the reception cameras included.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.detail(visitId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.cameras.all })
    },
  })
}

export function useRevokeVisitTracking(visitId: string) {
  const changed = useJourneyChanged(visitId)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => revokeVisitTracking(visitId),
    onSuccess: changed,
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.detail(visitId) }),
  })
}
