import type {
  Building,
  BuildingCreate,
  BuildingUpdate,
  Floor,
  FloorCreate,
  FloorUpdate,
  JourneyListParams,
  JourneyPage,
  LocationTree,
  TrackingCamera,
  TrackingCameraCreate,
  TrackingCameraListParams,
  TrackingCameraUpdate,
  TrackingEnrollRequest,
  TrackingKey,
  TrackingKeyCreate,
  TrackingKeyCreated,
  TrackingSettings,
  TrackingSettingsUpdate,
  TrackingStatus,
  VisitJourney,
  Zone,
  ZoneCreate,
  ZoneUpdate,
} from '../types/api'
import { apiRequest, segment, type CallOptions } from './client'

/*
 * The Visitor Journey (Phase 15, docs/api.md): the tracking status and settings, the provider's keys, the
 * location registry and the cameras, the day's journeys and a visit's journey, and the tracking actions on
 * a visit. The provider-facing ingestion endpoint (`POST /tracking/events`, a Bearer key) is never called
 * from the browser.
 */

/* Status and settings ------------------------------------------------------------------------ */

/** The banner's facts (administrators, management and reception). */
export function getTrackingStatus(options?: CallOptions): Promise<TrackingStatus> {
  return apiRequest('/tracking/status', options)
}

export function getTrackingSettings(options?: CallOptions): Promise<TrackingSettings> {
  return apiRequest('/tracking/settings', options)
}

/** `enabled: false` ends every running association of the company. */
export function updateTrackingSettings(body: TrackingSettingsUpdate, options?: CallOptions): Promise<TrackingSettings> {
  return apiRequest('/tracking/settings', { ...options, method: 'PATCH', body })
}

/* Keys (administrators) ---------------------------------------------------------------------- */

/** Newest first, revoked ones included. */
export function listTrackingKeys(options?: CallOptions): Promise<TrackingKey[]> {
  return apiRequest('/tracking/keys', options)
}

/** 201: the key itself is in this response only. */
export function createTrackingKey(body: TrackingKeyCreate, options?: CallOptions): Promise<TrackingKeyCreated> {
  return apiRequest('/tracking/keys', { ...options, method: 'POST', body })
}

/** Revokes the key (idempotent): the provider's requests with it are refused from then on. */
export function revokeTrackingKey(id: string, options?: CallOptions): Promise<TrackingKey> {
  return apiRequest(`/tracking/keys/${segment(id)}`, { ...options, method: 'DELETE' })
}

/* Locations --------------------------------------------------------------------------------------- */

/** The company's buildings, floors and zones, archived ones included. */
export function getLocations(options?: CallOptions): Promise<LocationTree> {
  return apiRequest('/locations', options)
}

export function createBuilding(body: BuildingCreate, options?: CallOptions): Promise<Building> {
  return apiRequest('/locations/buildings', { ...options, method: 'POST', body })
}

/** Archive: `is_active: false` (409 `LOCATION_IN_USE` while it has active floors). Nothing is ever deleted. */
export function updateBuilding(id: string, body: BuildingUpdate, options?: CallOptions): Promise<Building> {
  return apiRequest(`/locations/buildings/${segment(id)}`, { ...options, method: 'PATCH', body })
}

export function createFloor(body: FloorCreate, options?: CallOptions): Promise<Floor> {
  return apiRequest('/locations/floors', { ...options, method: 'POST', body })
}

export function updateFloor(id: string, body: FloorUpdate, options?: CallOptions): Promise<Floor> {
  return apiRequest(`/locations/floors/${segment(id)}`, { ...options, method: 'PATCH', body })
}

export function createZone(body: ZoneCreate, options?: CallOptions): Promise<Zone> {
  return apiRequest('/locations/zones', { ...options, method: 'POST', body })
}

export function updateZone(id: string, body: ZoneUpdate, options?: CallOptions): Promise<Zone> {
  return apiRequest(`/locations/zones/${segment(id)}`, { ...options, method: 'PATCH', body })
}

/* Cameras ----------------------------------------------------------------------------------------- */

/** Administrators: the active cameras (and the archived ones on request); reception: its active enrollment points. */
export function listTrackingCameras(params: TrackingCameraListParams = {}, options?: CallOptions): Promise<TrackingCamera[]> {
  return apiRequest('/tracking/cameras', { ...options, query: params })
}

export function createTrackingCamera(body: TrackingCameraCreate, options?: CallOptions): Promise<TrackingCamera> {
  return apiRequest('/tracking/cameras', { ...options, method: 'POST', body })
}

/** Archive: `is_active: false`; restore: `is_active: true`. */
export function updateTrackingCamera(id: string, body: TrackingCameraUpdate, options?: CallOptions): Promise<TrackingCamera> {
  return apiRequest(`/tracking/cameras/${segment(id)}`, { ...options, method: 'PATCH', body })
}

/* Journeys ---------------------------------------------------------------------------------------- */

export function listJourneys(params: JourneyListParams, options?: CallOptions): Promise<JourneyPage> {
  return apiRequest('/journeys', { ...options, query: params })
}

/** Opening a journey is audited by the server (one entry per person, visit and hour). */
export function getVisitJourney(visitId: string, options?: CallOptions): Promise<VisitJourney> {
  return apiRequest(`/visits/${segment(visitId)}/journey`, options)
}

/** Idempotent: a running association is returned as it is. */
export function enrollVisit(visitId: string, body: TrackingEnrollRequest, options?: CallOptions): Promise<VisitJourney> {
  return apiRequest(`/visits/${segment(visitId)}/tracking/enroll`, { ...options, method: 'POST', body })
}

/** Idempotent: nothing running leaves the journey as it is. */
export function revokeVisitTracking(visitId: string, options?: CallOptions): Promise<VisitJourney> {
  return apiRequest(`/visits/${segment(visitId)}/tracking/revoke`, { ...options, method: 'POST' })
}
