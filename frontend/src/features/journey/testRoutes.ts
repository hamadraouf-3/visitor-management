import { jsonResponse, makeMe, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import type { JourneyListItem, LiveJourneys, LocationTree, Me, Role, TrackingAlert, TrackingAlertSummary, TrackingCamera, TrackingSettings, TrackingStatus, VisitJourney } from '../../types/api'
import type { AccessAreas, BuildingNode, JourneyEvent, JourneyPlace, JourneyStay, LiveVisitor } from './types'

/** Fixtures and API routes of the Visitor Journey (tests only). Every value is a test's own: nothing here is real data. */

export const VISIT_ID = '5a1b2c3d-0000-4000-8000-0000000000a1'

export const TOWER: JourneyPlace['building'] = { id: 'b1000000-0000-4000-8000-000000000001', name: 'North Tower', name_ar: 'البرج الشمالي' }
export const FLOOR_3: JourneyPlace['floor'] = { id: 'f1000000-0000-4000-8000-000000000003', name: 'Floor 3', name_ar: 'الطابق الثالث', level: 3 }
export const LOBBY: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000001', name: 'Lobby', name_ar: 'الردهة', access: 'STANDARD' }
export const MEETING: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000002', name: 'Meeting rooms', name_ar: null, access: 'STANDARD' }

export const PLACE: JourneyPlace = { building: TOWER, floor: FLOOR_3, zone: LOBBY }

/* Phase 16: a ground floor with a common reception, and a fourth floor with a restricted server room. */
export const GROUND: JourneyPlace['floor'] = { id: 'f1000000-0000-4000-8000-000000000000', name: 'Ground floor', name_ar: 'الطابق الأرضي', level: 0 }
export const FLOOR_4: JourneyPlace['floor'] = { id: 'f1000000-0000-4000-8000-000000000004', name: 'Floor 4', name_ar: 'الطابق الرابع', level: 4 }
export const RECEPTION_ZONE: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000010', name: 'Reception', name_ar: 'الاستقبال', access: 'COMMON' }
export const OPEN_OFFICE: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000041', name: 'Open office', name_ar: 'المكاتب المفتوحة', access: 'STANDARD' }
export const SERVER_ROOM: JourneyPlace['zone'] = { id: 'z1000000-0000-4000-8000-000000000042', name: 'Server room', name_ar: 'غرفة الخوادم', access: 'RESTRICTED' }
export const FLOOR_4_PLACE: JourneyPlace = { building: TOWER, floor: FLOOR_4, zone: OPEN_OFFICE }
export const SERVER_PLACE: JourneyPlace = { building: TOWER, floor: FLOOR_4, zone: SERVER_ROOM }

const STAMP = { created_at: '2026-10-19T08:00:00Z', updated_at: '2026-10-19T08:00:00Z' }

function treeZone(floorId: string, zone: JourneyPlace['zone'], isActive = true) {
  return { ...zone, floor_id: floorId, is_active: isActive, ...STAMP }
}

/** North Tower: the ground floor (reception), floor 3 (lobby, meeting rooms) and floor 4 (open office, server room). */
export function makeTower(): BuildingNode {
  return {
    ...TOWER,
    is_active: true,
    ...STAMP,
    floors: [
      { ...GROUND, building_id: TOWER.id, is_active: true, ...STAMP, zones: [treeZone(GROUND.id, RECEPTION_ZONE)] },
      { ...FLOOR_3, building_id: TOWER.id, is_active: true, ...STAMP, zones: [treeZone(FLOOR_3.id, LOBBY), treeZone(FLOOR_3.id, MEETING)] },
      { ...FLOOR_4, building_id: TOWER.id, is_active: true, ...STAMP, zones: [treeZone(FLOOR_4.id, OPEN_OFFICE), treeZone(FLOOR_4.id, SERVER_ROOM)] },
    ],
  }
}

export function makeLocationTree(buildings: BuildingNode[] = [makeTower()]): LocationTree {
  return { buildings }
}

export const NO_AREAS: AccessAreas = { floors: [], zones: [] }

/** Floor 3 allowed (as a department on it gives). */
export const FLOOR_3_AREAS: AccessAreas = { floors: [{ ...FLOOR_3, building: TOWER, is_active: true }], zones: [] }

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
    area_alerts_enabled: true,
    alert_notify_host: true,
    alert_emails: [],
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
    alert: null,
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
    allowed: true,
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
      makeEvent({ id: 'e1', type: 'ENROLLED', observed_at: '2026-10-20T08:06:00Z', camera: { id: 'c1', name: 'Reception desk' }, location: null, match: null, confidence: null, confirmed: false, allowed: null }),
      makeEvent({ id: 'e2', observed_at: '2026-10-20T08:40:00Z', location: { ...PLACE, zone: MEETING }, match: 'UNCERTAIN', confidence: 0.42, confirmed: false, allowed: null }),
      makeEvent({ id: 'e3', observed_at: '2026-10-20T08:56:00Z', confidence: 0.91 }),
    ],
    timeline_total: 3,
    can_enroll: false,
    enroll_blocker: 'ALREADY_ENROLLED',
    can_revoke: true,
    access_areas: FLOOR_3_AREAS,
    can_edit_access_areas: true,
    alerts: [],
    path: [makeStay({ from: '2026-10-20T08:56:00Z', to: '2026-10-20T08:56:00Z', observations: 1 })],
    ...overrides,
  }
}

export function makeStay(overrides: Partial<JourneyStay> = {}): JourneyStay {
  return { location: PLACE, from: '2026-10-20T08:30:00Z', to: '2026-10-20T08:40:00Z', observations: 3, allowed: true, ...overrides }
}

export const ALERT_ID = 'a1e00000-0000-4000-8000-000000000001'

/** An open alert: Maya Odeh seen in floor 4's open office, outside her floor 3. */
export function makeAlert(overrides: Partial<TrackingAlert> = {}): TrackingAlert {
  return {
    id: ALERT_ID,
    type: 'UNAUTHORIZED_AREA',
    status: 'OPEN',
    simulated: true,
    visit: makeJourneyItem().visit,
    first_location: FLOOR_4_PLACE,
    last_location: FLOOR_4_PLACE,
    opened_at: '2026-10-20T08:50:00Z',
    last_seen_at: '2026-10-20T08:56:00Z',
    escalated_at: null,
    observations: 2,
    access_areas: FLOOR_3_AREAS,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    note: null,
    can_act: true,
    ...overrides,
  }
}

export function makeAlertSummary(overrides: Partial<TrackingAlertSummary> = {}): TrackingAlertSummary {
  return { open: 0, active: 0, latest: [], ...overrides }
}

/** The summary's line for an open alert. */
export function briefOf(alert: TrackingAlert): TrackingAlertSummary['latest'][number] {
  return { id: alert.id, type: alert.type, visit_id: alert.visit.id, visitor_name: alert.visit.visitor.full_name, location: alert.last_location, opened_at: alert.opened_at, escalated_at: alert.escalated_at, simulated: alert.simulated }
}

export function makeLiveVisitor(overrides: Partial<LiveVisitor> = {}): LiveVisitor {
  const item = makeJourneyItem()
  return {
    visit: item.visit,
    state: 'ACTIVE',
    simulated: true,
    last_location: PLACE,
    last_observed_at: '2026-10-20T08:56:00Z',
    freshness_seconds: 240,
    alert: null,
    access_areas: FLOOR_3_AREAS,
    ...overrides,
  }
}

/** Another visitor's visit, numbered `index`. */
export function otherVisit(index: number, name: string, company: string | null = null): LiveVisitor['visit'] {
  const id = String(index).padStart(12, '0')
  return { ...makeJourneyItem().visit, id: `5a1b2c3d-0000-4000-8000-${id}`, visitor: { id: `v1000000-0000-4000-8000-${id}`, full_name: name, company_name: company } }
}

export function makeLiveJourneys(visitors: LiveVisitor[] = [makeLiveVisitor()], overrides: Partial<LiveJourneys> = {}): LiveJourneys {
  return { generated_at: '2026-10-20T09:00:00Z', truncated: false, visitors, ...overrides }
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

/**
 * The routes /journey needs, for tests that only land on the page (guards, navigation): the live map (its
 * default view) and the list, the places, and the alerts' summary the shell polls. Spread into `mockApi({...})`.
 */
export function journeyRoutes(items: JourneyListItem[] = []): Record<string, RouteHandler> {
  return {
    'GET /tracking/status': () => jsonResponse(makeTrackingStatus()),
    'GET /journeys': () => jsonResponse(page(items)),
    'GET /journeys/live': () => jsonResponse(makeLiveJourneys([])),
    'GET /locations': () => jsonResponse(makeLocationTree()),
    ...alertSummaryRoute(),
  }
}

/** The summary the shell's alert watcher polls (every page of a tracked company's staff). */
export function alertSummaryRoute(summary: TrackingAlertSummary = makeAlertSummary()): Record<string, RouteHandler> {
  return { 'GET /tracking/alerts/summary': () => jsonResponse(summary) }
}
