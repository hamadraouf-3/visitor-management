import { AxeBuilder } from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import type { Language } from '../src/i18n/languages.ts'
import type { JourneyListItem, LocationTree, Role, TrackingCamera, TrackingKey, TrackingSettings, TrackingStatus, VisitJourney } from '../src/types/api.ts'
import { measureTouchTargets } from './support/touch-targets.ts'
import { COMPANY_ID, meOf, mockCompanyApi, platformCompanyOf, uuid, type MockCompany } from './support/mock-company.ts'
import { horizontalOverflow } from './support/ui.ts'

/*
 * The Visitor Journey's screens (Phase 15, F15) at the project's viewport, in both languages and both
 * colour schemes, with the API mocked: the day's list (a table from 1024 px, cards below), a visit's
 * journey («موقع مُستنتج» / "Inferred location", the timeline, the Simulated marks), the administrator's
 * tracking page (settings and keys, locations, cameras) and the platform owner's switch. Each: no serious
 * or critical axe finding, no sideways scroll at the viewport and at 320 px, every control a tap reaches
 * over at least 44 px on a touch screen. Every value here is the spec's own test data.
 *
 * With `P15_SHOTS` set to a folder, each scene is also saved there as a screenshot (the frontend agent's
 * visual check); the suite itself writes none.
 */

const COMPANY: MockCompany = { slug: 'cedar', name: 'Cedar Holdings', name_ar: 'سيدار القابضة', colour: '#1d8387' }
const SHOTS = process.env.P15_SHOTS
const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

const TOWER = { id: uuid('b1', 1), name: 'North Tower', name_ar: 'البرج الشمالي' }
const FLOOR_G = { id: uuid('f1', 0), name: 'Ground floor', name_ar: 'الطابق الأرضي', level: 0 }
const FLOOR_3 = { id: uuid('f1', 3), name: 'Floor 3', name_ar: 'الطابق الثالث', level: 3 }
const RECEPTION = { id: uuid('a1', 1), name: 'Reception', name_ar: 'الاستقبال' }
const LOBBY = { id: uuid('a1', 2), name: 'Lift lobby', name_ar: 'ردهة المصاعد' }
const MEETING = { id: uuid('a1', 3), name: 'Meeting rooms', name_ar: 'غرف الاجتماعات' }

const visitSummary = (index: number, name: string, company: string | null, status: 'CHECKED_IN' | 'CHECKED_OUT' = 'CHECKED_IN') => ({
  id: uuid('aa', index),
  status,
  visitor: { id: uuid('bb', index), full_name: name, company_name: company },
  host: { id: uuid('00', 1), full_name: 'Lina Haddad' },
  department: null,
  scheduled_start: iso(-60),
  scheduled_end: iso(60),
  check_in_at: iso(-55),
  check_out_at: status === 'CHECKED_OUT' ? iso(-5) : null,
})

const ITEMS: JourneyListItem[] = [
  { visit: visitSummary(1, 'Maya Odeh', 'Cedar Advisory'), state: 'ACTIVE', simulated: true, last_location: { building: TOWER, floor: FLOOR_3, zone: MEETING }, last_observed_at: iso(-4), freshness_seconds: 240 },
  { visit: visitSummary(2, 'هند العبدالله', null), state: 'UNCERTAIN', simulated: true, last_location: null, last_observed_at: null, freshness_seconds: null },
  { visit: visitSummary(3, 'Khalid Mansour', 'Blue Falcon Trading and Logistics Services'), state: 'STALE', simulated: true, last_location: { building: TOWER, floor: FLOOR_G, zone: LOBBY }, last_observed_at: iso(-40), freshness_seconds: 2400 },
  { visit: visitSummary(4, 'Marco Rossi', 'Express Courier'), state: 'PENDING', simulated: true, last_location: null, last_observed_at: null, freshness_seconds: null },
  { visit: visitSummary(5, 'Grace Lee', null, 'CHECKED_OUT'), state: 'ENDED', simulated: true, last_location: { building: TOWER, floor: FLOOR_G, zone: RECEPTION }, last_observed_at: iso(-9), freshness_seconds: 540 },
  { visit: visitSummary(6, 'Sara Khoury', 'Northwind'), state: 'NOT_ENROLLED', simulated: false, last_location: null, last_observed_at: null, freshness_seconds: null },
]

const camera = (id: number, name: string, providerId: string, zone: typeof RECEPTION, floor: typeof FLOOR_G, enrollment: boolean, active = true): TrackingCamera => ({
  id: uuid('cc', id),
  provider_camera_id: providerId,
  name,
  zone_id: zone.id,
  location: { building: TOWER, floor, zone },
  is_enrollment_point: enrollment,
  is_active: active,
  created_at: iso(-3000),
  updated_at: iso(-3000),
})
const CAMERAS = [
  camera(1, 'Reception desk', 'cam-reception-01', RECEPTION, FLOOR_G, true),
  camera(2, 'Main entrance', 'cam-entrance-02', RECEPTION, FLOOR_G, true),
  camera(3, 'Floor 3 lift lobby', 'shaheen/floor-3/lobby-east-0003', MEETING, FLOOR_3, false),
]

const event = (index: number, minutes: number, rest: Partial<VisitJourney['timeline'][number]>): VisitJourney['timeline'][number] => ({
  id: uuid('ee', index),
  type: 'OBSERVED',
  observed_at: iso(minutes),
  received_at: iso(minutes),
  camera: { id: CAMERAS[2]!.id, name: CAMERAS[2]!.name },
  location: { building: TOWER, floor: FLOOR_3, zone: MEETING },
  match: 'CONFIRMED',
  // The server never confirms an observation without a confidence.
  confidence: 0.9,
  confirmed: true,
  model_version: 'simulator',
  ...rest,
})

const JOURNEY: VisitJourney = {
  visit: ITEMS[0]!.visit,
  state: 'ACTIVE',
  association: {
    id: uuid('ad', 1),
    status: 'ACTIVE',
    provider: 'simulator',
    simulated: true,
    created_at: iso(-50),
    activated_at: iso(-50),
    ended_at: null,
    ended_reason: null,
    expires_at: iso(90),
    enrollment_camera: { id: CAMERAS[0]!.id, name: CAMERAS[0]!.name },
  },
  last_location: { building: TOWER, floor: FLOOR_3, zone: MEETING },
  last_observed_at: iso(-4),
  freshness_seconds: 240,
  timeline: [
    event(1, -50, { type: 'ENROLLED', camera: { id: CAMERAS[0]!.id, name: CAMERAS[0]!.name }, location: null, match: null, confidence: null, confirmed: false }),
    event(2, -42, { location: { building: TOWER, floor: FLOOR_G, zone: LOBBY }, camera: { id: CAMERAS[1]!.id, name: CAMERAS[1]!.name } }),
    event(3, -30, { match: 'UNCERTAIN', confidence: 0.41, confirmed: false }),
    event(4, -12, { confidence: 0.93 }),
    event(5, -4, {}),
  ],
  timeline_total: 5,
  can_enroll: false,
  enroll_blocker: 'ALREADY_ENROLLED',
  can_revoke: true,
}

const STATUS: TrackingStatus = { provider: 'simulator', simulated: true, available: true, allowed: true, enabled: true, last_contact_at: iso(-1), healthy: true }
const SETTINGS: TrackingSettings = {
  provider: 'simulator',
  allowed: true,
  enabled: true,
  min_confidence: 0.8,
  stale_after_minutes: 15,
  retention_days: 30,
  health: { last_contact_at: iso(-1), last_accepted_event_at: iso(-4), rejected_last_24h: [{ reason: 'UNKNOWN_CAMERA', count: 3 }, { reason: 'TOO_OLD', count: 1 }], provider_errors_last_24h: [] },
}
const KEYS: TrackingKey[] = [
  { id: uuid('kk', 1), label: 'Shaheen pilot', prefix: 'vtk_Ab3d', created_at: iso(-3000), created_by: { id: uuid('00', 1), full_name: 'Lina Haddad' }, last_used_at: iso(-1), revoked_at: null },
  { id: uuid('kk', 2), label: 'Old pilot key', prefix: 'vtk_Q9xw', created_at: iso(-9000), created_by: null, last_used_at: iso(-8000), revoked_at: iso(-3000) },
]
const node = <T extends object>(value: T, rest: object) => ({ ...value, ...rest, created_at: iso(-3000), updated_at: iso(-3000) })
const TREE: LocationTree = {
  buildings: [
    node(TOWER, {
      is_active: true,
      floors: [
        node(FLOOR_G, { building_id: TOWER.id, is_active: true, zones: [node(RECEPTION, { floor_id: FLOOR_G.id, is_active: true }), node(LOBBY, { floor_id: FLOOR_G.id, is_active: true })] }),
        node(FLOOR_3, { building_id: TOWER.id, is_active: true, zones: [node(MEETING, { floor_id: FLOOR_3.id, is_active: true })] }),
      ],
    }) as LocationTree['buildings'][number],
    node({ id: uuid('b1', 2), name: 'Annex', name_ar: null }, { is_active: true, floors: [] }) as LocationTree['buildings'][number],
  ],
}

function answer(route: Route, json: unknown) {
  return route.fulfill({ json })
}

/** The company's session in `language` with `roles`, and the journey's API. */
async function mocked(page: Page, language: Language, scheme: 'light' | 'dark', roles: Role[] = ['SYSTEM_ADMIN', 'RECEPTIONIST'], platform = false) {
  await page.emulateMedia({ colorScheme: scheme })
  await mockCompanyApi(page, {
    company: COMPANY,
    signedIn: platform ? null : language,
    platform: platform ? language : null,
    extra: (apiPath, route) => {
      if (apiPath === '/auth/me' && !platform) return answer(route, meOf(COMPANY, language, {}, roles, true))
      if (apiPath === '/tracking/status') return answer(route, STATUS)
      if (apiPath === '/journeys') return answer(route, { items: ITEMS, page: 1, page_size: 25, total: ITEMS.length })
      if (apiPath === `/visits/${JOURNEY.visit.id}/journey`) return answer(route, JOURNEY)
      if (apiPath === '/tracking/settings') return answer(route, SETTINGS)
      if (apiPath === '/tracking/keys') return answer(route, KEYS)
      if (apiPath === '/tracking/cameras') return answer(route, CAMERAS)
      if (apiPath === '/locations') return answer(route, TREE)
      if (apiPath === `/platform/companies/${COMPANY_ID}/admins`) return answer(route, [])
      if (apiPath === `/platform/companies/${COMPANY_ID}`) return answer(route, { ...platformCompanyOf(COMPANY), tracking_allowed: true })
      return undefined
    },
  })
}

const WORDS = {
  en: { journey: 'Visitor Journey', inferred: 'Inferred location', simulated: 'Simulated', tracking: 'Visitor tracking', locations: 'Locations', cameras: 'Cameras', allowed: 'Tracking allowed' },
  ar: { journey: 'رحلة الزائر', inferred: 'موقع مُستنتج', simulated: 'محاكاة', tracking: 'تتبّع الزوار', locations: 'المواقع', cameras: 'الكاميرات', allowed: 'السماح بالتتبّع' },
} as const

/** Axe, sideways scroll at the viewport and at 320 px, and (with P15_SHOTS) the screenshot, last: a full-page screenshot resets Chromium's touch emulation. */
async function check(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((one) => one.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await horizontalOverflow(page), `${name}: sideways scroll`).toBeLessThanOrEqual(0)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
  }
  const viewport = page.viewportSize()!
  if (viewport.width > 320) {
    await page.setViewportSize({ width: 320, height: viewport.height })
    expect(await horizontalOverflow(page), `${name}: sideways scroll at 320 px`).toBeLessThanOrEqual(0)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-320.png`), fullPage: true })
    await page.setViewportSize(viewport)
  }
}

/**
 * Touch targets are measured on the tablet and the phone, in the suite's runs: a full-page screenshot
 * (`P15_SHOTS`) resets Chromium's touch emulation for the page, so a run that saves its scenes leaves them out.
 */
function touchChecked(project: string): boolean {
  return project !== 'desktop' && !SHOTS
}

async function smallTargets(page: Page): Promise<string[]> {
  const targets = await measureTouchTargets(page)
  return targets.filter((target) => target.reach.height < 44 || target.reach.width < 24).map((target) => `${target.what}: ${target.reach.width}×${target.reach.height}`)
}

for (const language of ['en', 'ar'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the journey list and a visit’s journey in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const words = WORDS[language]
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme)
      await page.goto('/journey')
      await expect(page.getByRole('heading', { level: 1, name: words.journey })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(ITEMS[2]!.visit.visitor.full_name)).toBeVisible()
      await expect(page.getByRole('columnheader', { name: words.inferred })).toBeAttached()
      // The simulator is the provider: the page's line says Simulated once, and no row repeats it.
      await expect(page.locator('[data-simulated]')).toHaveCount(1)
      await expect(page.locator('[data-tracking-banner="simulated"] [data-simulated]')).toHaveText(words.simulated)
      await expect(page.locator('[data-location-unknown]').first()).toBeVisible()
      await check(page, `journey-list-${tag}`)

      await page.getByRole('link', { name: 'Maya Odeh' }).click()
      await expect(page.getByRole('heading', { name: words.inferred })).toBeVisible()
      await expect(page.locator('[data-journey-timeline] li')).toHaveCount(JOURNEY.timeline.length)
      // The simulator's journey: Simulated once, in the header; the line and the tracking card leave it out.
      await expect(page.locator('[data-simulated]')).toHaveCount(1)
      await expect(page.locator('[data-simulated]')).toHaveText(words.simulated)
      await expect(page.locator('[data-tracking-banner]')).toHaveCount(0)
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `journey-detail-${tag}`)
    })

    test(`the administrator’s visitor tracking in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000)
      const words = WORDS[language]
      const tag = `${testInfo.project.name}-${language}-${scheme}`
      await mocked(page, language, scheme)
      await page.goto('/admin/tracking')
      await expect(page.getByRole('heading', { level: 1, name: words.tracking })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('switch', { name: words.tracking })).toHaveAttribute('aria-checked', 'true')
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `admin-settings-${tag}`)

      await page.getByRole('tab', { name: words.locations }).click()
      await expect(page.locator('[data-place="zone"]').first()).toBeVisible()
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `admin-locations-${tag}`)

      await page.getByRole('tab', { name: words.cameras }).click()
      await expect(page.getByText('shaheen/floor-3/lobby-east-0003')).toBeVisible()
      if (touchChecked(testInfo.project.name)) expect(await smallTargets(page)).toEqual([])
      await check(page, `admin-cameras-${tag}`)
    })

    test(`the platform owner’s tracking switch in ${language}, ${scheme}`, async ({ page }, testInfo) => {
      const words = WORDS[language]
      await mocked(page, language, scheme, undefined, true)
      await page.goto(`/platform/companies/${COMPANY_ID}`)
      await expect(page.getByRole('switch', { name: words.allowed })).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
      await check(page, `platform-company-${testInfo.project.name}-${language}-${scheme}`)
    })
  }
}

test('a manager reads the journey without an action, and a phone shows cards', async ({ page }, testInfo) => {
  await mocked(page, 'en', 'light', ['MANAGEMENT'])
  await page.goto(`/journey/${JOURNEY.visit.id}`)
  await expect(page.getByRole('heading', { name: 'Inferred location' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Stop tracking' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start tracking' })).toHaveCount(0)
  await page.goto('/journey')
  const table = page.getByRole('table', { name: 'Visitor Journey' })
  await expect(table).toBeVisible()
  // Cards below 1024 px (the header row is for assistive technology only), a table from there.
  const headerVisible = await table.locator('thead').evaluate((head) => head.getBoundingClientRect().height > 1)
  expect(headerVisible).toBe(testInfo.project.name === 'desktop')
})

test('a company whose tracking is not allowed has no Visitor Journey: no tab, and its page leads home', async ({ page }) => {
  // The session says tracking is not allowed (`meOf`'s default): the tab and the administration's entry are gone.
  await mockCompanyApi(page, { company: COMPANY, signedIn: 'en', extra: (apiPath, route) => (apiPath === '/auth/me' ? answer(route, meOf(COMPANY, 'en', {}, ['MANAGEMENT'])) : undefined) })
  await page.goto('/journey')
  await expect(page).toHaveURL(/\/reports$/, { timeout: 30_000 })
  const openDrawer = page.getByRole('button', { name: 'Open navigation' })
  if (await openDrawer.isVisible()) await openDrawer.click()
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(nav.getByRole('link', { name: 'Inside now' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Visitor Journey' })).toHaveCount(0)
})
