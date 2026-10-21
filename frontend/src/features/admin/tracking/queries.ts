import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../../api/queryKeys'
import {
  createBuilding,
  createFloor,
  createTrackingCamera,
  createTrackingKey,
  createZone,
  getLocations,
  getTrackingSettings,
  listTrackingCameras,
  listTrackingKeys,
  revokeTrackingKey,
  updateBuilding,
  updateFloor,
  updateTrackingCamera,
  updateTrackingSettings,
  updateZone,
} from '../../../api/tracking'
import type {
  BuildingCreate,
  BuildingUpdate,
  FloorCreate,
  FloorUpdate,
  TrackingCameraCreate,
  TrackingCameraUpdate,
  TrackingKeyCreate,
  TrackingSettingsUpdate,
  ZoneCreate,
  ZoneUpdate,
} from '../../../types/api'

/* Visitor tracking, as the company's administrator sets it up (Phase 15). */

/** The settings and the health read with them; asked again each minute while open (the health moves). */
export function useTrackingSettings() {
  return useQuery({
    queryKey: queryKeys.tracking.settings,
    queryFn: ({ signal }) => getTrackingSettings({ signal }),
    refetchInterval: 60_000,
  })
}

/** A change of a setting: the banner's status and every journey follow (turning it off ends the running ones). */
export function useUpdateTrackingSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TrackingSettingsUpdate) => updateTrackingSettings(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.tracking.settings, settings)
      void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.status })
      void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.all })
    },
  })
}

/* Keys -------------------------------------------------------------------------------------------- */

export function useTrackingKeys() {
  return useQuery({
    queryKey: queryKeys.tracking.keys,
    queryFn: ({ signal }) => listTrackingKeys({ signal }),
  })
}

/** `gcTime: 0`: the answer, which holds the key itself, leaves the mutation cache as soon as its dialog closes. */
export function useCreateTrackingKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TrackingKeyCreate) => createTrackingKey(body),
    gcTime: 0,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.keys }),
  })
}

export function useRevokeTrackingKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => revokeTrackingKey(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.keys }),
  })
}

/* Locations --------------------------------------------------------------------------------------- */

export function useLocations() {
  return useQuery({
    queryKey: queryKeys.tracking.locations,
    queryFn: ({ signal }) => getLocations({ signal }),
  })
}

/** After a change of a place: the tree, the cameras that name it, and the journeys that show it. */
function useLocationChanged() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.locations })
    void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.cameras.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.all })
  }
}

export function useCreateBuilding() {
  const changed = useLocationChanged()
  return useMutation({ mutationFn: (body: BuildingCreate) => createBuilding(body), onSuccess: changed })
}

export function useUpdateBuilding() {
  const changed = useLocationChanged()
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: BuildingUpdate }) => updateBuilding(id, body), onSuccess: changed })
}

export function useCreateFloor() {
  const changed = useLocationChanged()
  return useMutation({ mutationFn: (body: FloorCreate) => createFloor(body), onSuccess: changed })
}

export function useUpdateFloor() {
  const changed = useLocationChanged()
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: FloorUpdate }) => updateFloor(id, body), onSuccess: changed })
}

export function useCreateZone() {
  const changed = useLocationChanged()
  return useMutation({ mutationFn: (body: ZoneCreate) => createZone(body), onSuccess: changed })
}

export function useUpdateZone() {
  const changed = useLocationChanged()
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: ZoneUpdate }) => updateZone(id, body), onSuccess: changed })
}

/* Cameras ----------------------------------------------------------------------------------------- */

export function useAdminCameras(includeArchived: boolean) {
  const params = includeArchived ? { include_archived: true } : {}
  return useQuery({
    queryKey: queryKeys.tracking.cameras.list(params),
    queryFn: ({ signal }) => listTrackingCameras(params, { signal }),
  })
}

/** After a change of a camera: every list of cameras (reception's start of tracking reads them too) and the journeys. */
function useCameraChanged() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.cameras.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.tracking.locations })
    void queryClient.invalidateQueries({ queryKey: queryKeys.journeys.all })
  }
}

export function useCreateCamera() {
  const changed = useCameraChanged()
  return useMutation({ mutationFn: (body: TrackingCameraCreate) => createTrackingCamera(body), onSuccess: changed })
}

export function useUpdateCamera() {
  const changed = useCameraChanged()
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: TrackingCameraUpdate }) => updateTrackingCamera(id, body), onSuccess: changed })
}
