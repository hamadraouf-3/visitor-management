import { jsonResponse, makeMe, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import type { JourneyListItem, Me, Role, TrackingCamera, TrackingSettings, TrackingStatus, VisitJourney } from '../../types/api'
import type { JourneyEvent, JourneyPlace } from './types'

/** Fixtures and API routes of the Visitor Journey (tests only). Every value is a test's own: nothing here is real data. */

export const VISIT_ID = '5a1b2c3d-0000-4000-8000-0000000000a1'

export const TOWER: JourneyPlace['building'] = { id: 'b1000000-0000-4000-8000-000000000001', name: 'North Tower', name_ar: 'البرج الشمالي' }
export const FLOOR_3: JourneyPlace['floor'] = { id: 'f1000000-0000-4000-8000-000000000003', name: 'Floor 3', name_ar: 'الطابق الثالث', level: 3 }
export const LOBBY: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000001', name: 'Lobby', name_ar: 'الردهة' }
export const MEETING: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000002', name: 'Meeting rooms', name_ar: null }

export const PLACE: JourneyPlace = { building: TOWER, floor: FLOOR_3, zone: LOBBY }

export function makeTrackingStatus(overrides: Partial<TrackingStatus> = {}): TrackingStatus {
  return { provider: 'simulator', simulated: true, available: true, allowed: true, enabled: true, last_contact_at: '2026-10-20T08:58:00Z', healthy: true, ...overrides }
}

export function makeTrackingSettings(overrides: Partial<TrackingSettings> = {}): TrackingSettings {
  return {
    provider: 'simulator',
    allowed: true,
    enabled: true,
    min_confidence: 0.8,
    stale_after_minutes: 15,
    retention_days: 30,
    health: { last_contact_at: '2026-10-20T08:58:00Z', last_accepted_event_at: '2026-10-20T08:57:00Z', rejected_last_24h: [], provider_errors_last_24h: [] },
    ...overrides,
  }
}

export function makeJourneyItem(overrides: Partial<JourneyListItem> = {}): JourneyListItem {
  return {
    visit: {
      id: VISIT_ID,
      status: 'CHECKED_IN',
      visitor: { id: 'v1000000-0000-4000-8000-000000000001', full_name: 'Maya Odeh', company_name: 'Cedar Advisory' },
      host: { id: 'u1000000-0000-4000-8000-000000000001', full_name: 'Omar Khalil' },
      department: null,
      scheduled_start: '2026-10-20T08:00:00Z',
      scheduled_end: '2026-10-20T10:00:00Z',
      check_in_at: '2026-10-20T08:05:00Z',
      check_out_at: null,
    },
    state: 'ACTIVE',
    simulated: true,
    last_location: PLACE,
    last_observed_at: '2026-10-20T08:56:00Z',
    freshness_seconds: 240,
    ...overrides,
  }
}

/** A confirmed observation by default, with a confidence: the server never confirms one without (F15-41). */
export function makeEvent(overrides: Partial<JourneyEvent> = {}): JourneyEvent {
  return {
    id: 'e1000000-0000-4000-8000-000000000001',
    type: 'OBSERVED',
    observed_at: '2026-10-20T08:56:00Z',
    received_at: '2026-10-20T08:56:01Z',
    camera: { id: 'c1000000-0000-4000-8000-000000000002', name: 'Floor 3 lobby' },
    location: PLACE,
    match: 'CONFIRMED',
    confidence: 0.9,
    confirmed: true,
    model_version: 'simulator',
    ...overrides,
  }
}

export function makeVisitJourney(overrides: Partial<VisitJourney> = {}): VisitJourney {
  const item = makeJourneyItem()
  return {
    visit: item.visit,
    state: 'ACTIVE',
    association: {
      id: 'a1000000-0000-4000-8000-000000000001',
      status: 'ACTIVE',
      provider: 'simulator',
      simulated: true,
      created_at: '2026-10-20T08:06:00Z',
      activated_at: '2026-10-20T08:06:00Z',
      ended_at: null,
      ended_reason: null,
      expires_at: '2026-10-20T10:30:00Z',
      enrollment_camera: { id: 'c1000000-0000-4000-8000-000000000001', name: 'Reception desk' },
    },
    last_location: PLACE,
    last_observed_at: '2026-10-20T08:56:00Z',
    freshness_seconds: 240,
    timeline: [
      makeEvent({ id: 'e1', type: 'ENROLLED', observed_at: '2026-10-20T08:06:00Z', camera: { id: 'c1', name: 'Reception desk' }, location: null, match: null, confidence: null, confirmed: false }),
      makeEvent({ id: 'e2', observed_at: '2026-10-20T08:40:00Z', location: { ...PLACE, zone: MEETING }, match: 'UNCERTAIN', confidence: 0.42, confirmed: false }),
      makeEvent({ id: 'e3', observed_at: '2026-10-20T08:56:00Z', confidence: 0.91 }),
    ],
    timeline_total: 3,
    can_enroll: false,
    enroll_blocker: 'ALREADY_ENROLLED',
    can_revoke: true,
    ...overrides,
  }
}

export function makeCamera(overrides: Partial<TrackingCamera> = {}): TrackingCamera {
  return {
    id: 'c1000000-0000-4000-8000-000000000001',
    provider_camera_id: 'cam-reception-01',
    name: 'Reception desk',
    zone_id: LOBBY.id,
    location: PLACE,
    is_enrollment_point: true,
    is_active: true,
    created_at: '2026-10-19T08:00:00Z',
    updated_at: '2026-10-19T08:00:00Z',
    ...overrides,
  }
}

/** A session of a company whose tracking the platform owner allows (the Visitor Journey is offered). */
export function makeTrackedMe(roles: Role[], overrides: Partial<Me['user']> = {}): Me {
  return makeMe(roles, overrides, { tracking_allowed: true })
}

/** The routes /journey needs, for tests that only land on the page (guards, navigation). Spread into `mockApi({...})`. */
export function journeyRoutes(items: JourneyListItem[] = []): Record<string, RouteHandler> {
  return {
    'GET /tracking/status': () => jsonResponse(makeTrackingStatus()),
    'GET /journeys': () => jsonResponse(page(items)),
  }
}
