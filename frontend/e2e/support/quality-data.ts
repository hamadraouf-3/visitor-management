import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Api } from './api.ts'
import { RUN_DIR } from './paths.ts'
import { localDate, minutes, wallTimeToInstant } from './time.ts'
import { enrollVisit, simulateJourney } from './tracking.ts'

/*
 * Data the quality specs (e2e/quality) look at, created once per run by the global setup so every
 * page they open has content in every state they check: a scheduled visit with a sent invitation
 * (visit and visitor pages), visitors inside (Inside tab, evacuation list, history: one with a
 * company and a phone, and one with a phone and no company, the evacuation list's tightest cell for
 * touch targets) and one expected now (Expected tab). Demo Company; the flow specs never count these.
 */

export interface QualityData {
  scheduledVisitId: string
  scheduledVisitorId: string
  scheduledVisitorName: string
  insideVisitId: string
  /** Inside too: a visitor with a phone and no company. */
  phoneOnlyVisitorName: string
  expectedVisitId: string
  /** A pass link, for the public pass page. */
  passUrl: string
  /** Phase 15: the inside visitor's visit, tracked by the simulator, with observations (its journey page). */
  trackedVisitId: string
}

const FILE = path.join(RUN_DIR, 'quality-data.json')

export async function createQualityData(): Promise<QualityData> {
  const host = await Api.as('employee')
  const reception = await Api.as('reception')
  try {
    const timeZone = (await host.me()).company.timezone
    const tomorrow = localDate(Date.now() + minutes(24 * 60), timeZone)
    const start = wallTimeToInstant(tomorrow, '10:00', timeZone)
    const scheduled = await host.createVisit({
      visitor: { full_name: 'Mariam Haddad', email: 'mariam.haddad@guest.test', phone: '+962 79 555 0170', company_name: 'Cedar Advisory' },
      start,
      end: new Date(start.getTime() + minutes(90)),
      purpose: 'Annual compliance review with the finance team',
      sendInvitation: true,
    })
    await host.settledInvitation(scheduled.visit.id)
    const now = Date.now()
    const inside = await host.createVisit({
      visitor: { full_name: 'Karim Nasser', company_name: 'Orbit Labs', phone: '+962 79 555 0171' },
      start: new Date(now - minutes(2)),
      end: new Date(now + minutes(118)),
      purpose: 'Server room maintenance',
    })
    await reception.checkIn(inside.visit.id, { method: 'MANUAL' })
    // Phase 15: tracked by the simulator, past the setup's two cameras (prepareTracking ran first).
    await enrollVisit(reception, inside.visit.id)
    await simulateJourney(inside.visit.id)
    const phoneOnly = await host.createVisit({
      visitor: { full_name: 'Grace Lee', phone: '+962 79 555 0172' },
      start: new Date(now - minutes(2)),
      end: new Date(now + minutes(118)),
      purpose: 'Fire safety inspection',
    })
    await reception.checkIn(phoneOnly.visit.id, { method: 'MANUAL' })
    const expected = await host.createVisit({
      visitor: { full_name: 'Sara Khoury', company_name: 'Northwind Logistics' },
      start: new Date(now - minutes(1)),
      end: new Date(now + minutes(119)),
      purpose: 'Quarterly delivery planning',
    })
    const data: QualityData = {
      scheduledVisitId: scheduled.visit.id,
      scheduledVisitorId: scheduled.visit.visitor.id,
      scheduledVisitorName: scheduled.visit.visitor.full_name,
      insideVisitId: inside.visit.id,
      phoneOnlyVisitorName: phoneOnly.visit.visitor.full_name,
      expectedVisitId: expected.visit.id,
      passUrl: scheduled.pass_url,
      trackedVisitId: inside.visit.id,
    }
    writeFileSync(FILE, JSON.stringify(data, null, 2))
    return data
  } finally {
    await host.dispose()
    await reception.dispose()
  }
}

export function qualityData(): QualityData {
  return JSON.parse(readFileSync(FILE, 'utf8')) as QualityData
}
