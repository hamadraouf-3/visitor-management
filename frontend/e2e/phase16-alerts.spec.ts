import { AxeBuilder } from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import type { Language } from '../src/i18n/languages.ts'
import type { CompanySettings, Department, Host, LiveJourneys, LocationTree, ReceptionToday, Role, TrackingAlert, TrackingAlertPage, TrackingAlertSummary, TrackingSettings, TrackingStatus, VisitJourney, VisitorSearchPage } from '../src/types/api.ts'
import { measureTouchTargets } from './support/touch-targets.ts'
import { meOf, mockCompanyApi, uuid, type MockCompany } from './support/mock-company.ts'
import { horizontalOverflow } from './support/ui.ts'

/*
 * The screens of Phase 16 (F16) at the project's viewport, in both languages and both colour schemes, with
 * the API mocked: the live map (floors, zones, visitors; an alert, a place not recent, no location, not
 * tracked), a visitor's panel (the path with places outside the allowed areas, the alert and its actions), the
 * tracking alerts page, a visit's journey (its allowed areas, alerts and path) with its allowed areas' dialog,
 * and the invitation's and the walk-in's allowed areas. Each: no serious or critical axe finding, no sideways
 * scroll at the viewport and at 320 px,
 * every control a tap reaches over at least 44 px on a touch screen. Every value here is the spec's own test
 * data.
 *
 * With `P16_SHOTS` set to a folder, each scene is also saved there as a screenshot (the frontend agent's
 * visual check); the suite itself writes none.
 */

const COMPANY: MockCompany = { slug: 'cedar', name: 'Cedar Holdings', name_ar: 'سيدار القابضة', colour: '#1d8387' }
const SHOTS = process.env.P16_SHOTS
const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const at = (minutes: number) => iso(minutes)

const TOWER = { id: uuid('b1', 1), name: 'North Tower', name_ar: 'البرج الشمالي' }
const ANNEX = { id: uuid('b1', 2), name: 'Annex', name_ar: 'الملحق' }
const FLOOR_G = { id: uuid('f1', 0), name: 'Ground floor', name_ar: 'الطابق الأرضي', level: 0 }
const FLOOR_2 = { id: uuid('f1', 2), name: 'Floor 2', name_ar: 'الطابق الثاني', level: 2 }
const FLOOR_4 = { id: uuid('f1', 4), name: 'Floor 4', name_ar: 'الطابق الرابع', level: 4 }
const ANNEX_1 = { id: uuid('f2', 1), name: 'Annex floor 1', name_ar: 'الطابق الأول في الملحق', level: 1 }
const RECEPTION = { id: uuid('a1', 1), name: 'Reception', name_ar: 'الاستقبال', access: 'COMMON' as const }
const LOBBY = { id: uuid('a1', 2), name: 'Lift lobby', name_ar: 'ردهة المصاعد', access: 'COMMON' as const }
const OFFICE_2 = { id: uuid('a1', 3), name: 'Open office', name_ar: 'المكاتب المفتوحة', access: 'STANDARD' as const }
const MEETING_2 = { id: uuid('a1', 4), name: 'Meeting rooms', name_ar: 'غرف الاجتماعات', access: 'STANDARD' as const }
const OFFICE_4 = { id: uuid('a1', 5), name: 'Finance offices', name_ar: 'مكاتب المالية', access: 'STANDARD' as const }
const SERVER = { id: uuid('a1', 6), name: 'Server room', name_ar: 'غرفة الخوادم', access: 'RESTRICTED' as const }
const ANNEX_HALL = { id: uuid('a1', 7), name: 'Training hall', name_ar: 'قاعة التدريب', access: 'STANDARD' as const }

type Zone = typeof RECEPTION | typeof OFFICE_2 | typeof SERVER
type Floor = typeof FLOOR_G
const place = (floor: Floor, zone: Zone, building = TOWER) => ({ building, floor, zone })

const node = <T extends object>(value: T, rest: object) => ({ ...value, ...rest, created_at: iso(-3000), updated_at: iso(-3000) })
const floorNode = (floor: Floor, building: typeof TOWER, zones: Zone[]) =>
  node(floor, { building_id: building.id, is_active: true, zones: zones.map((zone) => node(zone, { floor_id: floor.id, is_active: true })) })
const TREE: LocationTree = {
  buildings: [
    node(ANNEX, { is_active: true, floors: [floorNode(ANNEX_1, ANNEX, [ANNEX_HALL])] }) as LocationTree['buildings'][number],
    node(TOWER, { is_active: true, floors: [floorNode(FLOOR_G, TOWER, [RECEPTION, LOBBY]), floorNode(FLOOR_2, TOWER, [OFFICE_2, MEETING_2]), floorNode(FLOOR_4, TOWER, [OFFICE_4, SERVER])] }) as LocationTree['buildings'][number],
  ],
}

const FLOOR_2_AREAS = { floors: [{ ...FLOOR_2, building: TOWER, is_active: true }], zones: [] }

const visitSummary = (index: number, name: string, company: string | null) => ({
  id: uuid('aa', index),
  status: 'CHECKED_IN' as const,
  visitor: { id: uuid('bb', index), full_name: name, company_name: company },
  host: { id: uuid('00', 2), full_name: 'Omar Khalil' },
  department: null,
  scheduled_start: iso(-60),
  scheduled_end: iso(60),
  check_in_at: iso(-55),
  check_out_at: null,
})

const OMAR = visitSummary(1, 'Omar Saleh', 'Atlas Freight')
const LAYLA = visitSummary(2, 'ليلى الحسن', 'شركة المدار للاستشارات')

const ALERTS: TrackingAlert[] = [
  {
    id: uuid('ae', 1),
    type: 'RESTRICTED_AREA',
    status: 'OPEN',
    simulated: true,
    visit: OMAR,
    first_location: place(FLOOR_4, OFFICE_4),
    last_location: place(FLOOR_4, SERVER),
    opened_at: at(-9),
    last_seen_at: at(-2),
    // Escalated when first seen in the server room (the journey's path).
    escalated_at: at(-4),
    observations: 5,
    access_areas: FLOOR_2_AREAS,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    note: null,
    can_act: true,
  },
  {
    id: uuid('ae', 2),
    type: 'UNAUTHORIZED_AREA',
    status: 'ACKNOWLEDGED',
    simulated: true,
    visit: LAYLA,
    first_location: place(FLOOR_4, OFFICE_4),
    last_location: place(FLOOR_4, OFFICE_4),
    opened_at: at(-25),
    last_seen_at: at(-6),
    escalated_at: null,
    observations: 3,
    access_areas: FLOOR_2_AREAS,
    acknowledged_at: at(-20),
    acknowledged_by: { id: uuid('00', 1), full_name: 'Lina Haddad' },
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    note: 'Escorted back by her host',
    can_act: true,
  },
]

const live = (index: number, name: string, company: string | null, rest: Partial<LiveJourneys['visitors'][number]>): LiveJourneys['visitors'][number] => ({
  visit: visitSummary(index, name, company),
  state: 'ACTIVE',
  simulated: true,
  last_location: place(FLOOR_2, OFFICE_2),
  last_observed_at: at(-2),
  freshness_seconds: 120,
  alert: null,
  access_areas: FLOOR_2_AREAS,
  ...rest,
})

const VISITORS: LiveJourneys['visitors'] = [
  live(1, 'Omar Saleh', 'Atlas Freight', { last_location: place(FLOOR_4, SERVER), alert: { id: ALERTS[0]!.id, type: 'RESTRICTED_AREA', status: 'OPEN' } }),
  live(2, 'ليلى الحسن', 'شركة المدار للاستشارات', { last_location: place(FLOOR_4, OFFICE_4), alert: { id: ALERTS[1]!.id, type: 'UNAUTHORIZED_AREA', status: 'ACKNOWLEDGED' } }),
  live(3, 'Maya Odeh', 'Cedar Advisory', {}),
  live(4, 'هند العبدالله', null, { state: 'STALE', last_location: place(FLOOR_2, MEETING_2), last_observed_at: at(-25), freshness_seconds: 1500 }),
  live(5, 'Khalid Mansour', 'Blue Falcon Trading and Logistics Services', { last_location: place(FLOOR_G, LOBBY) }),
  live(6, 'Marco Rossi', 'Express Courier', { state: 'PENDING', last_location: null, last_observed_at: null, freshness_seconds: null }),
  live(7, 'Grace Lee', null, { state: 'UNAVAILABLE', last_location: null, last_observed_at: null, freshness_seconds: null }),
  live(8, 'Sara Khoury', 'Northwind', { state: 'NOT_ENROLLED', simulated: false, last_location: null, last_observed_at: null, freshness_seconds: null }),
]

const stay = (floor: Floor, zone: Zone, from: number, to: number, observations: number, allowed: boolean) => ({ location: place(floor, zone), from: at(from), to: at(to), observations, allowed })
const event = (index: number, minutes: number, floor: Floor, zone: Zone, allowed: boolean): VisitJourney['timeline'][number] => ({
  id: uuid('ee', index),
  type: 'OBSERVED',
  observed_at: at(minutes),
  received_at: at(minutes),
  camera: { id: uuid('cc', index), name: `${zone.name} camera` },
  location: place(floor, zone),
  match: 'CONFIRMED',
  confidence: 0.9,
  confirmed: true,
  model_version: 'simulator',
  allowed,
})

const JOURNEY: VisitJourney = {
  visit: OMAR,
  state: 'ACTIVE',
  association: {
    id: uuid('ad', 1),
    status: 'ACTIVE',
    provider: 'simulator',
    simulated: true,
    created_at: at(-50),
    activated_at: at(-50),
    ended_at: null,
    ended_reason: null,
    expires_at: at(90),
    enrollment_camera: { id: uuid('cc', 99), name: 'Reception desk' },
  },
  last_location: place(FLOOR_4, SERVER),
  last_observed_at: at(-2),
  freshness_seconds: 120,
  timeline: [
    { ...event(1, -50, FLOOR_G, RECEPTION, true), type: 'ENROLLED', location: null, match: null, confidence: null, confirmed: false, allowed: null },
    event(2, -40, FLOOR_2, OFFICE_2, true),
    event(3, -30, FLOOR_2, OFFICE_2, true),
    event(4, -9, FLOOR_4, OFFICE_4, false),
    event(5, -2, FLOOR_4, SERVER, false),
  ],
  timeline_total: 5,
  can_enroll: false,
  enroll_blocker: 'ALREADY_ENROLLED',
  can_revoke: true,
  access_areas: FLOOR_2_AREAS,
  can_edit_access_areas: true,
  alerts: [ALERTS[0]!, { ...ALERTS[1]!, id: uuid('ae', 3), visit: OMAR, status: 'RESOLVED', type: 'UNAUTHORIZED_AREA', resolution: 'RETURNED', resolved_at: at(-35), resolved_by: null, note: null, opened_at: at(-45), last_seen_at: at(-42), can_act: false }],
  path: [stay(FLOOR_G, RECEPTION, -50, -48, 2, true), stay(FLOOR_2, OFFICE_2, -40, -30, 4, true), stay(FLOOR_4, OFFICE_4, -9, -6, 2, false), stay(FLOOR_4, SERVER, -4, -2, 3, false)],
}

const STATUS: TrackingStatus = { provider: 'simulator', simulated: true, available: true, allowed: true, enabled: true, last_contact_at: iso(-1), healthy: true }
const SUMMARY: TrackingAlertSummary = {
  open: 1,
  active: 2,
  latest: [{ id: ALERTS[0]!.id, type: 'RESTRICTED_AREA', visit_id: OMAR.id, visitor_name: OMAR.visitor.full_name, location: place(FLOOR_4, SERVER), opened_at: ALERTS[0]!.opened_at, escalated_at: ALERTS[0]!.escalated_at, simulated: true }],
}
const DEPARTMENTS: Department[] = [
  { id: uuid('dd', 1), name: 'Finance', name_ar: 'المالية', is_active: true, created_at: iso(-9000), updated_at: iso(-9000), floor: { ...FLOOR_2, building: TOWER, is_active: true } },
  { id: uuid('dd', 2), name: 'Legal', name_ar: 'الشؤون القانونية', is_active: true, created_at: iso(-9000), updated_at: iso(-9000), floor: null },
]

/** A host of Finance (floor 2): the walk-in's areas start from it. */
const HOST: Host = { id: uuid('00', 2), full_name: 'Omar Khalil', phone: '+962 79 000 0077', department: { id: DEPARTMENTS[0]!.id, name: DEPARTMENTS[0]!.name, name_ar: DEPARTMENTS[0]!.name_ar } }
const TODAY: ReceptionToday = { date: iso(0).slice(0, 10), counts: { expected: 0, inside: 0, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 }, expected: [], inside: [], checked_out: [], no_show: [] }
const COMPANY_SETTINGS: CompanySettings = {
  id: uuid('c0', 1),
  name: COMPANY.name,
  name_ar: COMPANY.name_ar,
  default_language: 'en',
  timezone: 'Asia/Amman',
  address: null,
  address_ar: null,
  email_domain: null,
  pass_grace_before_minutes: 60,
  pass_grace_after_minutes: 60,
  notify_host_on_check_in: true,
  allow_walk_ins: true,
}

const SETTINGS: TrackingSettings = {
  provider: 'simulator',
  allowed: true,
  enabled: true,
  min_confidence: 0.8,
  stale_after_minutes: 15,
  retention_days: 30,
  health: { last_contact_at: iso(-1), last_accepted_event_at: iso(-2), rejected_last_24h: [], provider_errors_last_24h: [] },
  area_alerts_enabled: true,
  alert_notify_host: true,
  alert_emails: ['security@cedar.example', 'facilities.manager@cedar.example'],
}

function answer(route: Route, json: unknown) {
  return route.fulfill({ json })
}

/** The company's session in `language` with `roles` (tracking allowed), and Phase 16's API. */
async function mocked(page: Page, language: Language, scheme: 'light' | 'dark', roles: Role[] = ['SYSTEM_ADMIN', 'RECEPTIONIST']) {
  await page.emulateMedia({ colorScheme: scheme })
  const me = meOf(COMPANY, language, {}, roles, true)
  // The host's own department, Finance (on floor 2): the invitation's areas start from it.
  me.user.department = { id: DEPARTMENTS[0]!.id, name: DEPARTMENTS[0]!.name, name_ar: DEPARTMENTS[0]!.name_ar }
  await mockCompanyApi(page, {
    company: COMPANY,
    signedIn: language,
    extra: (apiPath, route) => {
      if (apiPath === '/auth/me') return answer(route, me)
      if (apiPath === '/tracking/status') return answer(route, STATUS)
      if (apiPath === '/tracking/alerts/summary') return answer(route, SUMMARY)
      if (apiPath === '/tracking/alerts') return answer(route, { items: ALERTS, page: 1, page_size: 20, total: ALERTS.length } satisfies TrackingAlertPage)
      if (apiPath === '/locations') return answer(route, TREE)
      // The whole company's, as the map asks for it (F16-36): it places each visitor in their building itself.
      if (apiPath === '/journeys/live') return answer(route, { generated_at: iso(0), truncated: false, visitors: VISITORS } satisfies LiveJourneys)
      if (apiPath === `/visits/${OMAR.id}/journey`) return answer(route, JOURNEY)
      if (apiPath === '/departments') return answer(route, DEPARTMENTS)
      if (apiPath === '/tracking/settings') return answer(route, SETTINGS)
      if (apiPath === '/tracking/keys') return answer(route, [])
      if (apiPath === '/users/hosts') return answer(route, [HOST])
      if (apiPath === '/reception/today') return answer(route, TODAY)
      if (apiPath === '/company/settings') return answer(route, COMPANY_SETTINGS)
      if (apiPath === '/visitors') return answer(route, { items: [], page: 1, page_size: 20, total: 0 } satisfies VisitorSearchPage)
      return undefined
    },
  })
}

const WORDS = {
  en: {
    journey: 'Visitor Journey',
    alerts: 'Tracking alerts',
    floors: 'Floors of North Tower',
    invite: 'Invite visitor',
    areas: 'Allowed areas (optional)',
    allowed: 'Allowed areas',
    path: 'Path',
    editAreas: 'Edit allowed areas',
    areasDialog: 'Allowed areas of Omar Saleh',
    host: 'Host',
    checkIn: 'Check in walk-in',
  },
  ar: {
    journey: 'رحلة الزائر',
    alerts: 'تنبيهات التتبّع',
    floors: 'طوابق البرج الشمالي',
    invite: 'دعوة زائر',
    areas: 'المناطق المسموحة (اختياري)',
    allowed: 'المناطق المسموحة',
    path: 'المسار',
    editAreas: 'تعديل المناطق المسموحة',
    areasDialog: 'المناطق المسموحة لـ \u2068Omar Saleh\u2069',
    host: 'المضيف',
    checkIn: 'تسجيل دخول الزائر',
  },
} as const

/** Axe, sideways scroll at the viewport and at 320 px, and (with P16_SHOTS) the screenshot, last: a full-page screenshot resets Chromium's touch emulation. */
async function check(page: Page, name: string, { fullPage = true }: { fullPage?: boolean } = {}): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((one) => one.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await horizontalOverflow(page), `${name}: sideways scroll`).toBeLessThanOrEqual(0)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage })
  }
  const viewport = page.viewportSize()!
  if (viewport.width > 320) {
    await page.setViewportSize({ width: 320, height: viewport.height })
    expect(await horizontalOverflow(page), `${name}: sideways scroll at 320 px`).toBeLessThanOrEqual(0)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-320.png`), fullPage })
    await page.setViewportSize(viewport)
  }
}

/** Touch targets are measured on the tablet and the phone, in the suite's runs (a screenshot run leaves them out, as F15-22's). */
function touchChecked(project: string): boolean {
  return project !== 'desktop' && !SHOTS
}

async function smallTargets(page: Page): Promise<string[]> {
  const targets = await measureTouchTargets(page)
  return targets.filter((target) => target.reach.height < 44 || target.reach.width < 24).map((target) => `${target.what}: ${target.reach.width}×${target.reach.height}`)
}

for (const language of ['en', 'ar'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the live map and a visitor’s panel in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const words = WORDS[language]
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme)
      // The tower (the first building by name is the annex, the map's default).
      await page.goto(`/journey?building=${TOWER.id}`)
      await expect(page.getByRole('heading', { level: 1, name: words.journey })).toBeVisible({ timeout: 30_000 })
      const floors = page.getByRole('region', { name: words.floors })
      await expect(floors.locator('[data-floor-band]')).toHaveCount(3)
      await expect(floors.locator('[data-chip-alert]')).toHaveCount(2)
      await expect(page.locator('[data-no-location] [data-live-chip]')).toHaveCount(2)
      await expect(page.locator('[data-not-tracked]')).toHaveAttribute('data-not-tracked', '1')
      // The simulator is the provider: Simulated once, in the page's line; never on a chip.
      await expect(page.locator('main [data-simulated]')).toHaveCount(1)
      // The shell's badge: two active, one of them open (the alerts' red).
      const openDrawer = page.getByRole('button', { name: /^(Open navigation|فتح التنقل)$/ })
      if (!(await openDrawer.isVisible())) await expect(page.locator('[data-nav-badge="danger"]')).toHaveText(/2/)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `live-map-${tag}`)

      await floors.locator(`[data-live-chip="${OMAR.id}"]`).click()
      const panel = page.getByRole('dialog', { name: 'Omar Saleh' })
      await expect(panel.locator('[data-journey-path] li')).toHaveCount(4)
      await expect(panel.locator('[data-stay-allowed="false"]')).toHaveCount(2)
      await expect(panel.locator('[data-panel-alert] [data-alert-type="RESTRICTED_AREA"]')).toBeVisible()
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `live-panel-${tag}`, { fullPage: false })
    })

    test(`the tracking alerts and a visit’s journey in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const words = WORDS[language]
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme)
      await page.goto('/journey/alerts')
      await expect(page.getByRole('heading', { level: 1, name: words.alerts })).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-alert-card]')).toHaveCount(2)
      await expect(page.locator('[data-alert-card][data-alert-state="OPEN"] [data-alert-actions] button')).toHaveCount(2)
      await expect(page.locator('main [data-simulated]')).toHaveCount(1)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `alerts-${tag}`)

      await page.goto(`/journey/${OMAR.id}`)
      await expect(page.getByRole('heading', { name: words.allowed })).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-visit-alerts] [data-alert-card]')).toHaveCount(2)
      await expect(page.locator('[data-journey-path] [data-stay-allowed="false"]')).toHaveCount(2)
      await expect(page.locator('[data-journey-timeline] [data-event-allowed="false"]')).toHaveCount(2)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `journey-detail-${tag}`)

      // The allowed areas' dialog: the floors' 44 px rows apart on touch screens (F16-20), the extra zones' search.
      await page.getByRole('button', { name: words.editAreas }).click()
      const dialog = page.getByRole('dialog', { name: words.areasDialog })
      await expect(dialog.locator(`[data-area-floor="${FLOOR_2.id}"]`)).toBeChecked()
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `areas-dialog-${tag}`, { fullPage: false })
    })

    test(`the invitation’s allowed areas in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const words = WORDS[language]
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme, ['EMPLOYEE'])
      await page.goto('/visits/new')
      await expect(page.getByRole('heading', { level: 1, name: words.invite })).toBeVisible({ timeout: 30_000 })
      const areas = page.getByRole('group', { name: words.areas })
      // Finance's floor, as the server would apply it.
      await expect(areas.locator(`[data-area-floor="${FLOOR_2.id}"]`)).toBeChecked()
      await areas.getByRole('combobox').fill(language === 'ar' ? 'خوادم' : 'server')
      await page.getByRole('listbox').getByRole('option').first().click()
      await expect(areas.locator(`[data-area-zone="${SERVER.id}"]`)).toBeVisible()
      // A host has no alerts tab.
      await expect(page.locator('[data-nav-badge]')).toHaveCount(0)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `invite-areas-${tag}`)
    })

    test(`the walk-in’s allowed areas in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const words = WORDS[language]
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme, ['RECEPTIONIST'])
      await page.goto('/reception?tab=walk-in')
      await expect(page.getByRole('button', { name: words.checkIn })).toBeVisible({ timeout: 30_000 })
      const areas = page.getByRole('group', { name: words.areas })
      await expect(areas).toBeVisible()
      // The host's department is Finance, on floor 2: the field starts from it.
      await page.getByRole('combobox', { name: words.host, exact: true }).click()
      await page.getByRole('listbox').getByRole('option', { name: /Omar Khalil/ }).click()
      await expect(areas.locator(`[data-area-floor="${FLOOR_2.id}"]`)).toBeChecked()
      await areas.getByRole('combobox').fill(language === 'ar' ? 'خوادم' : 'server')
      await page.getByRole('listbox').getByRole('option').first().click()
      await expect(areas.locator(`[data-area-zone="${SERVER.id}"]`)).toBeVisible()
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `walkin-areas-${tag}`)
    })
  }
}

for (const language of ['en', 'ar'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the administration’s access levels, department floors and area alerts in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme, ['SYSTEM_ADMIN'])
      await page.goto('/admin/tracking')
      await expect(page.locator('main [role="switch"]').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('main [role="switch"]')).toHaveCount(3)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `admin-settings-${tag}`)

      await page.goto('/admin/tracking?tab=locations')
      await expect(page.locator('[data-zone-access="RESTRICTED"]')).toHaveCount(1, { timeout: 30_000 })
      await expect(page.locator('[data-zone-access]')).toHaveCount(7)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `admin-locations-${tag}`)

      await page.goto('/admin/departments')
      await expect(page.locator('[data-department-floor]').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.locator(`[data-department-floor="${DEPARTMENTS[0]!.id}"]`)).toHaveValue(FLOOR_2.id)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `admin-departments-${tag}`)
    })
  }
}

test('management reads the alerts without an action', async ({ page }) => {
  await mocked(page, 'en', 'light', ['MANAGEMENT'])
  const readOnly = ALERTS.map((alert) => ({ ...alert, can_act: false }))
  await page.route('**/api/v1/tracking/alerts?**', (route) => route.fulfill({ json: { items: readOnly, page: 1, page_size: 20, total: readOnly.length } }))
  await page.goto('/journey/alerts')
  await expect(page.locator('[data-alert-card]')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-alert-actions] button')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open journey' })).toHaveCount(2)
})
