import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Building, Floor, PlatformCompany, PlatformCompanyPage, TrackingCamera, TrackingSettings, VisitJourney, Zone } from '../../src/types/api.ts'
import { Api } from './api.ts'
import { backendCli } from './cli.ts'
import { RUN_DIR } from './paths.ts'

/*
 * The Visitor Journey's E2E data (Phase 15). The API runs with `TRACKING_PROVIDER=simulator` (env.ts). The
 * global setup prepares the seeded main company once per run, through the real API: the platform owner
 * allows its tracking, its administrator turns it on with a confidence threshold, and creates a building,
 * two floors, four zones and three cameras (one at reception, two on floor 2 the simulator walks past: two
 * confirmed observations a second apart on two floors would be a conflict, UNCERTAIN). Other Corp is never
 * allowed: it is the "Tracking is off" company of every spec.
 *
 * Observations come from the backend's own `simulate-journey` command, which sends them through the same
 * ingestion service a provider's events go through, marked Simulated. It walks past the active cameras
 * that are not reception cameras, in name order: the two of the setup are named "A1 …" and "A2 …" so they
 * come first, whatever cameras a spec adds (theirs never start with "A"). Nothing here is real data.
 */

export interface TrackingData {
  companyId: string
  building: { id: string; name: string }
  ground: { id: string; name: string }
  floor2: { id: string; name: string }
  zones: { reception: string; lobby: string; meeting: string; office: string }
  /** The reception camera (an enrollment point). */
  receptionCamera: { id: string; name: string }
  /** The two cameras the simulator walks past, in its order. */
  walk: { id: string; name: string; floor: string; zone: string }[]
}

const FILE = path.join(RUN_DIR, 'tracking-data.json')

/** The settings every spec relies on: on, with a threshold the simulator's confidence (0.9) passes. */
export const E2E_MIN_CONFIDENCE = 0.5
export const SIMULATED_CONFIDENCE = 0.9

export async function companyIdOf(platform: Api, name: string): Promise<string> {
  const companies = await platform.ok<PlatformCompanyPage>('GET', `/platform/companies?q=${encodeURIComponent(name)}&page_size=100`)
  const company = companies.items.find((item) => item.name === name)
  if (!company) throw new Error(`No company named ${name}`)
  return company.id
}

export function allowTracking(platform: Api, companyId: string, allowed: boolean): Promise<PlatformCompany> {
  return platform.ok<PlatformCompany>('PATCH', `/platform/companies/${companyId}/tracking`, { allowed })
}

/** Run once by the global setup: the main company's tracking, places and cameras. */
export async function prepareTracking(): Promise<TrackingData> {
  const platform = await Api.platform()
  const admin = await Api.as('admin')
  try {
    const companyId = (await admin.me()).company.id
    await allowTracking(platform, companyId, true)
    const settings = await admin.ok<TrackingSettings>('PATCH', '/tracking/settings', { enabled: true, min_confidence: E2E_MIN_CONFIDENCE })
    if (!settings.enabled || settings.provider !== 'simulator') throw new Error(`Tracking is not on with the simulator: ${JSON.stringify(settings)}`)

    const building = await admin.ok<Building>('POST', '/locations/buildings', { name: 'Mawdoo3 HQ', name_ar: 'مقر موضوع' })
    const ground = await admin.ok<Floor>('POST', '/locations/floors', { building_id: building.id, name: 'Ground floor', name_ar: 'الطابق الأرضي', level: 0 })
    const floor2 = await admin.ok<Floor>('POST', '/locations/floors', { building_id: building.id, name: 'Floor 2', name_ar: 'الطابق الثاني', level: 2 })
    const zone = (floorId: string, name: string, nameAr: string) => admin.ok<Zone>('POST', '/locations/zones', { floor_id: floorId, name, name_ar: nameAr })
    const reception = await zone(ground.id, 'Reception', 'الاستقبال')
    const lobby = await zone(ground.id, 'Lift lobby', 'ردهة المصاعد')
    const meeting = await zone(floor2.id, 'Meeting rooms', 'غرف الاجتماعات')
    const office = await zone(floor2.id, 'Open office', 'المكاتب المفتوحة')
    const camera = (body: object) => admin.ok<TrackingCamera>('POST', '/tracking/cameras', body)
    const desk = await camera({ provider_camera_id: 'e2e-reception-01', name: 'Reception desk', zone_id: reception.id, is_enrollment_point: true })
    // Both on one floor: two confirmed observations a second apart on two floors would be a conflict (UNCERTAIN).
    const first = await camera({ provider_camera_id: 'e2e-floor2-meeting-01', name: 'A1 floor 2 meeting rooms', zone_id: meeting.id })
    const second = await camera({ provider_camera_id: 'e2e-floor2-office-01', name: 'A2 floor 2 open office', zone_id: office.id })

    const data: TrackingData = {
      companyId,
      building: { id: building.id, name: building.name },
      ground: { id: ground.id, name: ground.name },
      floor2: { id: floor2.id, name: floor2.name },
      zones: { reception: reception.id, lobby: lobby.id, meeting: meeting.id, office: office.id },
      receptionCamera: { id: desk.id, name: desk.name },
      walk: [
        { id: first.id, name: first.name, floor: floor2.name, zone: meeting.name },
        { id: second.id, name: second.name, floor: floor2.name, zone: office.name },
      ],
    }
    writeFileSync(FILE, JSON.stringify(data, null, 2))
    return data
  } finally {
    await platform.dispose()
    await admin.dispose()
  }
}

export function trackingData(): TrackingData {
  return JSON.parse(readFileSync(FILE, 'utf8')) as TrackingData
}

/** Starts a visit's tracking at the setup's reception camera, through the API (reception or an administrator). */
export function enrollVisit(api: Api, visitId: string, cameraId: string = trackingData().receptionCamera.id): Promise<VisitJourney> {
  return api.ok<VisitJourney>('POST', `/visits/${visitId}/tracking/enroll`, { camera_id: cameraId })
}

export interface SimulateOptions {
  /** How many observations (default 2: past the two cameras of the setup, in order). */
  steps?: number
  match?: 'CONFIRMED' | 'UNCERTAIN'
  confidence?: number
}

/**
 * `python -m app.cli simulate-journey`: observations of the visit's simulator association, one second apart
 * and the last now (never before the association began), through the ingestion service. Its line of
 * outcomes is returned; it fails when the visit has no open association.
 */
export function simulateJourney(visitId: string, { steps = 2, match = 'CONFIRMED', confidence = SIMULATED_CONFIDENCE }: SimulateOptions = {}): Promise<string> {
  return backendCli(['simulate-journey', '--visit', visitId, '--steps', String(steps), '--interval-seconds', '1', '--match', match, '--confidence', String(confidence)])
}
