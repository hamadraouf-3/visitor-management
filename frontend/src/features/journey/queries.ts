import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isBackgroundFetch } from '../../api/queries'
import { queryKeys } from '../../api/queryKeys'
import { enrollVisit, getLiveJourneys, getLocations, getTrackingStatus, getVisitJourney, listJourneys, listTrackingCameras, revokeVisitTracking } from '../../api/tracking'
import type { JourneyListParams, JourneyPage, LiveJourneys, TrackingEnrollRequest, VisitJourney } from '../../types/api'

/**
 * How often an open journey page asks again (paused in a background tab): observations arrive from the
 * provider at any time, and a state turns STALE or UNAVAILABLE as time passes, which only the server says.
 */
export const JOURNEY_LIST_REFRESH_MS = 30_000
export const JOURNEY_DETAIL_REFRESH_MS = 15_000
const STATUS_REFRESH_MS = 60_000

/*
 * Every poll of the journey's pages after their first load is a background refresh (`X-Background-Refresh: 1`):
 * the live map, the alerts and a journey are left open on reception screens, and only the person's own requests
 * may keep the session from its idle timeout (§7.2, F16-37). The first load is the person's request.
 */

/** The tracking status for the page's one-line banner (all three roles). */
export function useTrackingStatus() {
  return useQuery({
    queryKey: queryKeys.tracking.status,
    queryFn: ({ signal, client, queryKey }) => getTrackingStatus({ signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
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
    queryFn: async ({ signal, client, queryKey }): Promise<AnsweredJourneyPage> => ({
      page: await listJourneys(params, { signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
      answeredAt: Date.now(),
    }),
    placeholderData: keepPreviousData,
    refetchInterval: JOURNEY_LIST_REFRESH_MS,
  })
}

export function useVisitJourney(visitId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.journeys.detail(visitId),
    queryFn: ({ signal, client, queryKey }) => getVisitJourney(visitId, { signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
    refetchInterval: JOURNEY_DETAIL_REFRESH_MS,
    enabled,
  })
}

/* Phase 16: the live map ---------------------------------------------------------------------------- */

/** The live map asks again every 15 s (paused in a background tab), as reception's lists do. */
export const LIVE_MAP_REFRESH_MS = 15_000
/** Places change rarely; the map's floors and zones are asked for again every few minutes. */
const LOCATIONS_STALE_MS = 5 * 60_000

/** The company's buildings, floors and zones (`GET /locations`): the map's bands and tiles. */
export function useLocationTree() {
  return useQuery({
    queryKey: queryKeys.tracking.locations,
    queryFn: ({ signal }) => getLocations({ signal }),
    staleTime: LOCATIONS_STALE_MS,
  })
}

/** Everyone inside now, with when the server answered (their `freshness_seconds` count on from then, F15-30). */
export interface AnsweredLiveJourneys {
  live: LiveJourneys
  answeredAt: number
}

/**
 * Everyone checked in now (the whole company: the map places each visitor in their building itself, so one last
 * seen in a building the map cannot show, or the "No location" and "Not tracked" ones, are never left out,
 * F16-36), for the live map. The poll after the first load is a background refresh (`X-Background-Refresh: 1`):
 * a map left open on a reception screen still reaches the session's idle timeout (§7.2), as the evacuation list
 * does.
 */
export function useLiveJourneys(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.journeys.live,
    queryFn: async ({ signal, client, queryKey }): Promise<AnsweredLiveJourneys> => ({
      live: await getLiveJourneys({}, { signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
      answeredAt: Date.now(),
    }),
    enabled,
    refetchInterval: LIVE_MAP_REFRESH_MS,
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
