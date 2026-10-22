import type { Building, Department, Floor, PlatformCompanyCreated, TrackingAlert, TrackingAlertPage, TrackingCamera, TrackingSettings, User, Visit, Zone } from '../../src/types/api.ts'
import { Api } from './api.ts'
import type { OpenOptions, Session } from './fixtures.ts'
import { allowTracking, E2E_MIN_CONFIDENCE, enrollVisit } from './tracking.ts'
import { strongPassword, uniqueTag } from './ui.ts'
import { minutes } from './time.ts'
import { sleep } from './processes.ts'

/*
 * The area alerts' E2E company (Phase 16): a company of its own, so its alerts never reach the toasts and
 * badges of the other specs' sessions (the seeded company's reception and administrators run the shell's
 * alert watcher too). Made once per worker through the real API: the platform owner creates and allows it;
 * its administrator turns tracking on (with a confidence threshold the simulator passes, and an address for
 * the alert e-mails) and creates a building with a ground floor (a common reception), floor 2 (an open
 * office) and floor 4 (an office and a server room), a camera in each zone (the reception's an enrollment
 * point), a department (its floor is set by a spec, through the page), and a receptionist, a host of that
 * department and a manager. Every name and address is a test's own.
 */

export interface Account {
  email: string
  password: string
  name: string
}

export interface AreaCompany {
  tag: string
  companyId: string
  companyName: string
  admin: Account
  reception: Account
  host: Account
  management: Account
  /** The company's alert e-mail address (`alert_emails`). */
  alertEmail: string
  department: { id: string; name: string }
  building: { id: string; name: string }
  floors: { ground: Floor; floor2: Floor; floor4: Floor }
  zones: { reception: Zone; office2: Zone; office4: Zone; server: Zone }
  /** Provider camera IDs: the reception's (where tracking starts) and one a zone. */
  cameras: { desk: TrackingCamera; office2: TrackingCamera; office4: TrackingCamera; server: TrackingCamera }
}

/** A user the administrator creates with a temporary password, which the user then changes. */
async function newUser(admin: Api, tag: string, key: string, name: string, roles: User['roles'], departmentId?: string): Promise<Account> {
  const email = `${key}.${tag}@alerts.test`
  const temporary = strongPassword()
  const password = strongPassword()
  await admin.ok('POST', '/users', { full_name: name, email, roles, temporary_password: temporary, ...(departmentId ? { department_id: departmentId } : {}) })
  const first = await Api.signedIn(email, temporary)
  try {
    await first.ok('POST', '/auth/change-password', { current_password: temporary, new_password: password })
  } finally {
    await first.dispose()
  }
  return { email, password, name }
}

async function prepare(): Promise<AreaCompany> {
  const tag = uniqueTag()
  const companyName = `Area Alerts ${tag}`
  const platform = await Api.platform()
  const temporary = strongPassword()
  const adminAccount: Account = { email: `admin.${tag}@alerts.test`, password: strongPassword(), name: `Huda Admin ${tag}` }
  let admin: Api | null = null
  try {
    const created = await platform.ok<PlatformCompanyCreated>('POST', '/platform/companies', {
      name: companyName,
      slug: `alerts-${tag}`,
      timezone: 'Asia/Amman',
      default_language: 'en',
      admin: { full_name: adminAccount.name, email: adminAccount.email, temporary_password: temporary },
    })
    await allowTracking(platform, created.company.id, true)
    const first = await Api.signedIn(adminAccount.email, temporary)
    try {
      await first.ok('POST', '/auth/change-password', { current_password: temporary, new_password: adminAccount.password })
    } finally {
      await first.dispose()
    }
    admin = await Api.signedIn(adminAccount.email, adminAccount.password)

    const alertEmail = `security.${tag}@alerts.test`
    const settings = await admin.ok<TrackingSettings>('PATCH', '/tracking/settings', { enabled: true, min_confidence: E2E_MIN_CONFIDENCE, alert_emails: [alertEmail] })
    if (!settings.enabled || !settings.area_alerts_enabled) throw new Error(`Area alerts are not on: ${JSON.stringify(settings)}`)

    const building = await admin.ok<Building>('POST', '/locations/buildings', { name: 'Alerts Tower', name_ar: 'برج التنبيهات' })
    const floor = (name: string, nameAr: string, level: number) => admin!.ok<Floor>('POST', '/locations/floors', { building_id: building.id, name, name_ar: nameAr, level })
    const ground = await floor('Ground floor', 'الطابق الأرضي', 0)
    const floor2 = await floor('Floor 2', 'الطابق الثاني', 2)
    const floor4 = await floor('Floor 4', 'الطابق الرابع', 4)
    const zone = (floorId: string, name: string, nameAr: string, access: Zone['access']) => admin!.ok<Zone>('POST', '/locations/zones', { floor_id: floorId, name, name_ar: nameAr, access })
    const reception = await zone(ground.id, 'Reception', 'الاستقبال', 'COMMON')
    const office2 = await zone(floor2.id, 'Open office', 'المكاتب المفتوحة', 'STANDARD')
    const office4 = await zone(floor4.id, 'Finance offices', 'مكاتب المالية', 'STANDARD')
    // Standard here: a spec makes it restricted through the locations editor.
    const server = await zone(floor4.id, 'Server room', 'غرفة الخوادم', 'STANDARD')
    const camera = (key: string, name: string, zoneId: string, enrollment = false) =>
      admin!.ok<TrackingCamera>('POST', '/tracking/cameras', { provider_camera_id: `aa-${tag}-${key}`, name, zone_id: zoneId, is_enrollment_point: enrollment })
    const cameras = {
      desk: await camera('desk', 'Reception desk', reception.id, true),
      office2: await camera('f2', 'Floor 2 office', office2.id),
      office4: await camera('f4', 'Floor 4 offices', office4.id),
      server: await camera('server', 'Server room door', server.id),
    }
    const department = await admin.ok<Department>('POST', '/departments', { name: `Area Team ${tag}` })

    return {
      tag,
      companyId: created.company.id,
      companyName,
      admin: adminAccount,
      reception: await newUser(admin, tag, 'reception', `Rania Reception ${tag}`, ['RECEPTIONIST']),
      host: await newUser(admin, tag, 'host', `Hadi Host ${tag}`, ['EMPLOYEE'], department.id),
      management: await newUser(admin, tag, 'management', `Mona Manager ${tag}`, ['MANAGEMENT']),
      alertEmail,
      department: { id: department.id, name: department.name },
      building: { id: building.id, name: building.name },
      floors: { ground, floor2, floor4 },
      zones: { reception, office2, office4, server },
      cameras,
    }
  } finally {
    await platform.dispose()
    await admin?.dispose()
  }
}

let prepared: Promise<AreaCompany> | null = null

/** The worker's area alerts company (made at the first call). */
export function areaCompany(): Promise<AreaCompany> {
  prepared ??= prepare()
  return prepared
}

/** The JSON API as one of the company's people (dispose it). */
export function apiOf(account: Account): Promise<Api> {
  return Api.signedIn(account.email, account.password)
}

/** A browser of one of the company's people, signed in (and in Arabic when asked). */
export async function sessionOf(open: (options?: OpenOptions) => Promise<Session>, account: Account, options: OpenOptions & { language?: 'ar' } = {}): Promise<Session> {
  const { language, ...rest } = options
  const session = await open(rest)
  const signedIn = await session.context.request.post('/api/v1/auth/login', { data: { email: account.email, password: account.password } })
  if (!signedIn.ok()) throw new Error(`Sign-in of ${account.email} failed: ${signedIn.status()} ${await signedIn.text()}`)
  await session.api.ok('PATCH', '/auth/preferences', { language: language ?? 'en' })
  return session
}

/** A visit of the host, checked in by reception and enrolled at the reception desk: the visitor is tracked. */
export async function trackedVisit(company: AreaCompany, name: string, { host, reception }: { host: Api; reception: Api }): Promise<Visit> {
  const now = Date.now()
  const created = await host.createVisit({ visitor: { full_name: name, company_name: 'Atlas Freight' }, start: new Date(now - minutes(2)), end: new Date(now + minutes(118)) })
  const visit = await reception.checkIn(created.visit.id, { method: 'MANUAL' })
  await enrollVisit(reception, visit.id, company.cameras.desk.id)
  return visit
}

/** The visit's alerts as the API has them (newest first). */
export async function alertsOf(api: Api, visitId: string): Promise<TrackingAlert[]> {
  const day = await api.ok<TrackingAlertPage>('GET', `/tracking/alerts?scope=day&visit_id=${visitId}&page_size=100`)
  return day.items
}

/** Waits until the visit's newest alert matches `predicate` (the ingestion's evaluation runs in its own transaction). */
export async function waitForAlert(api: Api, visitId: string, predicate: (alert: TrackingAlert) => boolean, timeoutMs = 20_000): Promise<TrackingAlert> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const newest = (await alertsOf(api, visitId))[0]
    if (newest && predicate(newest)) return newest
    if (Date.now() > deadline) throw new Error(`No matching alert for visit ${visitId} after ${timeoutMs} ms: ${JSON.stringify(newest ?? null)}`)
    await sleep(250)
  }
}
