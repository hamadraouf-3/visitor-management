import { AxeBuilder } from '@axe-core/playwright'
import { request, type Page } from '@playwright/test'
import type { PlatformCompanyCreated, TrackingSettings, Visit, VisitJourney } from '../../src/types/api.ts'
import type { Api } from '../support/api.ts'
import { ACCOUNTS } from '../support/accounts.ts'
import { expect, test, type OpenOptions, type Session } from '../support/fixtures.ts'
import { BASE_URL } from '../support/paths.ts'
import { minutes } from '../support/time.ts'
import { allowTracking, enrollVisit, simulateJourney, trackingData } from '../support/tracking.ts'
import { followNavLink, horizontalOverflow, strongPassword, uniqueTag } from '../support/ui.ts'

/*
 * The Visitor Journey against the real API (Phase 15, contract §F and §G), with the simulator provider
 * (`TRACKING_PROVIDER=simulator`, e2e/support/env.ts) and the places the global setup prepared
 * (e2e/support/tracking.ts). Every observation comes from the backend's `simulate-journey`, through the
 * same ingestion service a provider's events go through, and is marked Simulated. Other Corp is never
 * allowed to track: its pages say "Tracking is off".
 */

async function checkedInVisit(host: Api, reception: Api, name: string): Promise<Visit> {
  const now = Date.now()
  const created = await host.createVisit({ visitor: { full_name: name, company_name: 'Atlas Freight' }, start: new Date(now - minutes(2)), end: new Date(now + minutes(118)) })
  return reception.checkIn(created.visit.id, { method: 'MANUAL' })
}

/** No serious or critical axe finding and no sideways scroll. */
async function accessible(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await horizontalOverflow(page), name).toBeLessThanOrEqual(0)
}

/** A receptionist of the main company whose language is Arabic, signed in in a context of its own (on a phone). */
async function arabicReceptionist(admin: Api, open: (options?: OpenOptions) => Promise<Session>): Promise<Session> {
  const tag = uniqueTag()
  const email = `rana.journey.${tag}@demo.local`
  const temporary = strongPassword()
  const password = strongPassword()
  await admin.ok('POST', '/users', { full_name: `Rana Saleh ${tag}`, email, roles: ['RECEPTIONIST'], temporary_password: temporary })
  const session = await open({ device: 'mobile' })
  const signedIn = await session.context.request.post('/api/v1/auth/login', { data: { email, password: temporary } })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await session.api.ok('POST', '/auth/change-password', { current_password: temporary, new_password: password })
  await session.api.ok('PATCH', '/auth/preferences', { language: 'ar' })
  return session
}

/** "Floor 2, Meeting rooms" or "Floor 2, Open office": a place of the simulator's walk (it moves on only after a minute). */
function walkPlace(language: 'en' | 'ar'): RegExp {
  const data = trackingData()
  if (language === 'ar') return /الطابق الثاني.*(غرف الاجتماعات|المكاتب المفتوحة)/
  return new RegExp(`${data.floor2.name}.*(${data.walk.map((camera) => camera.zone).join('|')})`)
}

test('reception starts a visitor’s tracking; the simulator’s observations make the journey; check-out ends it', async ({ open, apiAs }) => {
  const data = trackingData()
  const tag = uniqueTag()
  const name = `Dana Haddad ${tag}`
  const host = await apiAs('employee')
  const receptionApi = await apiAs('reception')
  const visit = await checkedInVisit(host, receptionApi, name)

  const { page } = await open({ as: 'reception', device: 'tablet' })
  await page.goto('/reception')
  await expect(page.getByRole('heading', { level: 1, name: 'Reception' })).toBeVisible()
  await followNavLink(page, 'Visitor Journey')
  await expect(page.getByRole('heading', { level: 1, name: 'Visitor Journey' })).toBeVisible()
  // The deployment's provider is the simulator: the page says so in its one line.
  await expect(page.getByRole('region', { name: 'Tracking' }).locator('[data-simulated]')).toHaveText('Simulated')
  const row = page.getByRole('table', { name: 'Visitor Journey' }).getByRole('row').filter({ hasText: name })
  await expect(row).toContainText('Not started')
  await expect(row.locator('[data-location-unknown]')).toHaveText('Unknown')

  await row.getByRole('link', { name }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  const location = page.locator('[data-inferred-location]')
  await expect(location.locator('[data-location-unknown]')).toHaveText('Unknown')
  const cameraChoice = page.getByRole('combobox', { name: 'Reception camera' })
  if (await cameraChoice.isVisible()) await cameraChoice.selectOption({ label: data.receptionCamera.name })
  const enrolled = page.waitForResponse((response) => response.url().endsWith(`/visits/${visit.id}/tracking/enroll`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  expect((await enrolled).status()).toBe(200)
  expect((await enrolled).request().postDataJSON()).toEqual({ camera_id: data.receptionCamera.id })
  await expect(page.getByRole('button', { name: 'Stop tracking' })).toBeVisible()
  // Started, before any observation: Active, and still no place (the backend's rule of 2026-10-20 19:16).
  await expect(location.locator('[data-location-unknown]')).toHaveText('Unknown')
  await expect(page.getByRole('heading', { name: 'Inferred location' }).locator('xpath=ancestor::section[1]')).toContainText('Active')
  // Made by the simulator: marked so once, in the header (not again in the line or on the tracking card).
  await expect(page.locator('main [data-simulated]')).toHaveCount(1)
  await expect(page.locator('main [data-simulated]')).toHaveText('Simulated')
  const timeline = page.locator('[data-journey-timeline]')
  await expect(timeline.locator('[data-event-type="ENROLLED"]')).toContainText(data.receptionCamera.name)

  // Two observations on floor 2, confirmed with a confidence of 90 %, through the ingestion service.
  expect(await simulateJourney(visit.id)).toMatch(/accepted: 2/)
  await page.reload()
  const observed = timeline.locator('[data-event-type="OBSERVED"]')
  await expect(observed).toHaveCount(2)
  for (const index of [0, 1]) {
    await expect(observed.nth(index).locator('[data-location-path]')).toHaveText(walkPlace('en'))
    await expect(observed.nth(index)).toContainText('Confirmed')
    await expect(observed.nth(index)).toContainText('Confidence 90%')
  }
  await expect(observed.nth(0)).toContainText(new RegExp(data.walk.map((camera) => camera.name).join('|')))
  // The last confirmed floor and zone, under "Inferred location", with how long ago: the latest observation's.
  const latest = (await observed.nth(0).locator('[data-location-path]').textContent()) ?? ''
  await expect(page.getByRole('heading', { name: 'Inferred location' })).toBeVisible()
  await expect(location.locator('[data-location-path]')).toHaveText(latest)
  await expect(location).toContainText(data.building.name)
  await expect(location.locator('[data-freshness]')).toHaveText(/ago$/)
  await expect(page.locator('main').getByText('Active', { exact: true }).first()).toBeVisible()
  await accessible(page, 'a tracked visit’s journey (tablet)')

  // The list says the same: the state, the floor and zone; Simulated once, in the page's line, not row by row.
  await page.getByRole('link', { name: 'Back to Visitor Journey' }).click()
  const listed = page.getByRole('table', { name: 'Visitor Journey' }).getByRole('row').filter({ hasText: name })
  await expect(listed).toContainText('Active')
  await expect(listed.locator('[data-location-path]')).toHaveText(latest)
  await expect(page.getByRole('region', { name: 'Tracking' }).locator('[data-simulated]')).toHaveText('Simulated')
  await expect(page.locator('main [data-simulated]')).toHaveCount(1)
  await expect(listed.locator('[data-simulated]')).toHaveCount(0)
  await accessible(page, 'the journey list (tablet)')

  // Check-out ends the tracking in the same transaction; a later observation has nothing to attach to.
  await receptionApi.checkOut(visit.id, { method: 'MANUAL' })
  const after = await receptionApi.ok<VisitJourney>('GET', `/visits/${visit.id}/journey`)
  expect(after).toMatchObject({ state: 'ENDED', can_revoke: false, association: { status: 'ENDED', ended_reason: 'CHECKED_OUT', simulated: true } })
  await expect(simulateJourney(visit.id)).rejects.toThrow()
  await page.goto(`/journey/${visit.id}`)
  const tracking = page.getByRole('heading', { name: 'Tracking', exact: true }).locator('xpath=ancestor::section[1]')
  await expect(tracking).toContainText('Ended because')
  await expect(tracking).toContainText('Checked out')
  await expect(page.getByRole('button', { name: 'Stop tracking' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start tracking' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('Not inside')).toBeVisible()
  // The history stays: the floor seen last is still the inferred one.
  await expect(location.locator('[data-location-path]')).toHaveText(latest)
})

test('in Arabic on a phone: the journey as cards, «موقع مُستنتج», and a stop after one line', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const name = `Yara Nasser ${tag}`
  const host = await apiAs('employee')
  const receptionApi = await apiAs('reception')
  const visit = await checkedInVisit(host, receptionApi, name)
  await enrollVisit(receptionApi, visit.id)
  expect(await simulateJourney(visit.id)).toMatch(/accepted: 2/)

  const { page } = await arabicReceptionist(await apiAs('admin'), open)
  await page.goto('/journey')
  await expect(page.getByRole('heading', { level: 1, name: 'رحلة الزائر' })).toBeVisible()
  const card = page.getByRole('row').filter({ hasText: name })
  await expect(card).toContainText('نشط')
  await expect(page.getByRole('region', { name: 'التتبّع' }).locator('[data-simulated]')).toHaveText('محاكاة')
  await expect(card.locator('[data-simulated]')).toHaveCount(0)
  await expect(card.locator('[data-location-path]')).toHaveText(walkPlace('ar'))
  await accessible(page, 'the journey list in Arabic (phone)')

  await card.getByRole('link', { name }).click()
  await expect(page.getByRole('heading', { name: 'موقع مُستنتج' })).toBeVisible()
  const location = page.locator('[data-inferred-location] [data-location-path]')
  await expect(location).toHaveText(walkPlace('ar'))
  const latest = (await location.textContent()) ?? ''
  await expect(page.locator('[data-journey-timeline] [data-event-type="OBSERVED"]').first()).toContainText('مؤكد')
  await accessible(page, 'a journey in Arabic (phone)')
  await page.getByRole('button', { name: 'إيقاف التتبّع' }).click()
  const dialog = page.getByRole('alertdialog', { name: `إيقاف تتبّع ${name}؟` })
  await dialog.getByRole('button', { name: 'إيقاف التتبّع' }).click()
  await expect(page.getByRole('button', { name: 'إيقاف التتبّع' })).toHaveCount(0)
  await expect(page.getByText('أُوقف', { exact: true })).toBeVisible()
  expect(await receptionApi.ok<VisitJourney>('GET', `/visits/${visit.id}/journey`)).toMatchObject({ state: 'ENDED', association: { ended_reason: 'REVOKED' } })
  // The floor and zone seen last stay, as they were when seen.
  await expect(location).toHaveText(latest)
})

test('an administrator prepares a place and a camera, and makes a provider key that is shown once, works, and stops working when revoked', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const admin = await apiAs('admin')
  const { page } = await open({ as: 'admin' })
  await page.goto('/admin')
  await followNavLink(page, 'Visitor tracking')
  await expect(page.getByRole('heading', { level: 1, name: 'Visitor tracking' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Visitor tracking' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('heading', { name: 'Tracking', exact: true }).locator('xpath=ancestor::section[1]')).toContainText('Simulator')
  await accessible(page, 'tracking settings')

  // The retention, saved alone (and put back: other specs rely on the confidence threshold, not this).
  const before = await admin.ok<TrackingSettings>('GET', '/tracking/settings')
  try {
    const retention = page.getByRole('textbox', { name: 'Keep journeys for' })
    await retention.fill('45')
    const saved = page.waitForResponse((response) => response.url().endsWith('/tracking/settings') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Save changes' }).click()
    expect((await saved).request().postDataJSON()).toEqual({ retention_days: 45 })
    await expect(page.getByText('Tracking settings saved')).toBeVisible()
  } finally {
    await admin.ok('PATCH', '/tracking/settings', { retention_days: before.retention_days })
  }

  // A building, a floor at a level, a zone.
  const building = `UI Annex ${tag}`
  const zone = `Atrium ${tag}`
  await page.getByRole('tab', { name: 'Locations' }).click()
  await page.getByRole('button', { name: 'Add building' }).first().click()
  let dialog = page.getByRole('dialog', { name: 'Add building' })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(building)
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: `Actions for ${building}` }).click()
  await page.getByRole('menuitem', { name: 'Add floor' }).click()
  dialog = page.getByRole('dialog', { name: `Add a floor to ${building}` })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Mezzanine')
  await dialog.getByRole('textbox', { name: /Level/ }).fill('1')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  const floors = page.getByRole('list', { name: `Floors of ${building}` })
  await floors.getByRole('button', { name: 'Add zone' }).click()
  dialog = page.getByRole('dialog', { name: 'Add a zone to Mezzanine' })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(zone)
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(floors.getByRole('list', { name: 'Zones of Mezzanine' })).toContainText(zone)
  await accessible(page, 'tracking locations')

  // A camera in it (not at reception, named after the setup's two, so the simulator's walk keeps its order).
  const camera = `UI camera ${tag}`
  await page.getByRole('tab', { name: 'Cameras' }).click()
  await page.getByRole('button', { name: 'Add camera' }).click()
  dialog = page.getByRole('dialog', { name: 'Add camera' })
  await dialog.getByRole('textbox', { name: /Provider camera ID/ }).fill(`ui-${tag}`)
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(camera)
  await dialog.getByRole('combobox', { name: /Zone/ }).selectOption({ label: zone })
  await dialog.getByRole('button', { name: 'Add' }).click()
  const cameraRow = page.getByRole('table', { name: 'Cameras' }).getByRole('row').filter({ hasText: camera })
  await expect(cameraRow).toContainText(`ui-${tag}`)
  await expect(cameraRow.locator('[data-location-path]')).toHaveText(new RegExp(`${building}.*Mezzanine.*${zone}`))
  await accessible(page, 'tracking cameras')
  // Archived, then the place can be archived too (nothing active under it); a camera is never deleted.
  await cameraRow.getByRole('button', { name: `Archive ${camera}` }).click()
  await page.getByRole('alertdialog', { name: `Archive ${camera}?` }).getByRole('button', { name: 'Archive' }).click()
  await expect(cameraRow).toHaveCount(0)

  // A key: shown once, with a copy button; the ingestion takes it, and refuses it once revoked.
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Create key' }).click()
  dialog = page.getByRole('dialog', { name: 'Create key' })
  await dialog.getByRole('textbox', { name: /Label/ }).fill(`E2E ${tag}`)
  await dialog.getByRole('button', { name: 'Create' }).click()
  const shown = page.getByRole('dialog', { name: `Key “E2E ${tag}” created` })
  await expect(shown).toContainText('The key is shown only once.')
  const secret = await shown.getByRole('textbox', { name: 'Key' }).inputValue()
  expect(secret).toMatch(/^vtk_.{20,}$/)
  await expect(shown.getByRole('button', { name: 'Copy key' })).toBeVisible()
  await shown.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText(secret)).toHaveCount(0)

  const provider = await request.newContext({ baseURL: BASE_URL })
  try {
    const heartbeat = () =>
      provider.post('/api/v1/tracking/events', {
        headers: { Authorization: `Bearer ${secret}` },
        data: { events: [{ provider_event_id: `e2e-heartbeat-${uniqueTag()}`, type: 'HEARTBEAT', observed_at: new Date().toISOString() }] },
      })
    const taken = await heartbeat()
    expect(taken.status(), await taken.text()).toBe(200)
    expect(((await taken.json()) as { results: { result: string }[] }).results[0]!.result).toBe('accepted')
    // A session cookie is no key: the administrator's own session is refused there.
    const withCookie = await page.request.post('/api/v1/tracking/events', {
      data: { events: [{ provider_event_id: `e2e-cookie-${uniqueTag()}`, type: 'HEARTBEAT', observed_at: new Date().toISOString() }] },
    })
    expect(withCookie.status()).toBe(401)

    const keys = page.getByRole('list', { name: 'Provider keys' })
    await keys.getByRole('button', { name: `Revoke E2E ${tag}` }).click()
    await page.getByRole('alertdialog', { name: `Revoke the key “E2E ${tag}”?` }).getByRole('button', { name: 'Revoke' }).click()
    await expect(keys.getByRole('listitem').filter({ hasText: `E2E ${tag}` })).toContainText('Revoked')
    expect((await heartbeat()).status()).toBe(401)
  } finally {
    await provider.dispose()
  }
})

/** The navigation's links of a signed-in page. */
async function navigationLinks(page: Page): Promise<string[]> {
  const openDrawer = page.getByRole('button', { name: 'Open navigation' })
  if (await openDrawer.isVisible()) await openDrawer.click()
  const links = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').allTextContents()
  if (await openDrawer.isVisible()) await page.keyboard.press('Escape')
  return links
}

test('the platform owner allows a company’s tracking: its Visitor Journey appears, off until its administrator turns it on, and goes again when stopped', async ({ open }) => {
  const tag = uniqueTag()
  const temporary = strongPassword()
  const { page, api: platform } = await open({ platform: true })
  const created = await platform.ok<PlatformCompanyCreated>('POST', '/platform/companies', {
    name: `Tracking Test ${tag}`,
    slug: `tracking-${tag}`,
    timezone: 'Asia/Amman',
    default_language: 'en',
    admin: { full_name: `Huda Admin ${tag}`, email: `huda.${tag}@tracking.test`, temporary_password: temporary },
  })
  expect(created.company.tracking_allowed).toBe(false)

  // The company's administrator, in a browser of their own.
  const admin = await open()
  const signedIn = await admin.context.request.post('/api/v1/auth/login', { data: { email: `huda.${tag}@tracking.test`, password: temporary } })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await admin.api.ok('POST', '/auth/change-password', { current_password: temporary, new_password: strongPassword() })
  try {
    // Not allowed: no Visitor Journey and no Visitor tracking, and their pages lead home.
    await admin.page.goto('/admin')
    await expect(admin.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
    let links = await navigationLinks(admin.page)
    expect(links).toContain('Inside now')
    expect(links).not.toContain('Visitor Journey')
    expect(links).not.toContain('Visitor tracking')
    for (const path of ['/journey', '/admin/tracking']) {
      await admin.page.goto(path)
      await expect(admin.page).toHaveURL(/\/admin$/)
    }

    // The platform owner allows it, on the company's page.
    await page.goto(`/platform/companies/${created.company.id}`)
    const allowed = page.getByRole('switch', { name: 'Tracking allowed' })
    await expect(allowed).toHaveAttribute('aria-checked', 'false')
    await accessible(page, 'a company’s page (platform)')
    await allowed.click()
    await expect(allowed).toHaveAttribute('aria-checked', 'true')

    // Allowed: both are offered; tracking is off until the administrator turns it on.
    await admin.page.goto('/admin')
    await expect(admin.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
    links = await navigationLinks(admin.page)
    expect(links).toEqual(expect.arrayContaining(['Visitor Journey', 'Visitor tracking']))
    await admin.page.goto('/journey')
    await expect(admin.page.getByRole('region', { name: 'Tracking' })).toContainText('Tracking is off')
    await expect(admin.page.getByRole('heading', { name: 'No visits on this day' })).toBeVisible()
    await accessible(admin.page, 'the Visitor Journey while tracking is off')
    await admin.page.goto('/admin/tracking')
    const toggle = admin.page.getByRole('switch', { name: 'Visitor tracking' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await admin.page.goto('/journey')
    const banner = admin.page.getByRole('region', { name: 'Tracking' })
    await expect(banner.locator('[data-simulated]')).toHaveText('Simulated')
    await expect(banner).not.toContainText('Tracking is off')

    // Stopped by the platform owner, after one line: the company's own switch goes off, and so does the tab.
    await allowed.click()
    const dialog = page.getByRole('alertdialog', { name: `Stop tracking for Tracking Test ${tag}?` })
    await dialog.getByRole('button', { name: 'Stop tracking' }).click()
    await expect(allowed).toHaveAttribute('aria-checked', 'false')
    expect(await admin.api.ok<TrackingSettings>('GET', '/tracking/settings')).toMatchObject({ allowed: false, enabled: false })
    await admin.page.goto('/admin')
    await expect(admin.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
    links = await navigationLinks(admin.page)
    expect(links).not.toContain('Visitor Journey')
    expect(links).not.toContain('Visitor tracking')
  } finally {
    await allowTracking(platform, created.company.id, false)
  }
})

test('a company that is not allowed has no Visitor Journey: no tab, its pages lead home, and the API says Disabled', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const name = `Basel Odeh ${tag}`
  const otherHost = await apiAs('otherEmployee')
  const otherReceptionApi = await apiAs('otherReception')
  const visit = await checkedInVisit(otherHost, otherReceptionApi, name)

  const reception = await open({ as: 'otherReception' })
  await reception.page.goto('/reception')
  await expect(reception.page.getByRole('heading', { level: 1, name: 'Reception' })).toBeVisible()
  expect(await navigationLinks(reception.page)).not.toContain('Visitor Journey')
  for (const path of ['/journey', `/journey/${visit.id}`]) {
    await reception.page.goto(path)
    await expect(reception.page).toHaveURL(/\/reception$/)
  }
  const admin = await open({ as: 'otherAdmin' })
  await admin.page.goto('/admin/tracking')
  await expect(admin.page).toHaveURL(/\/admin$/)
  expect(await navigationLinks(admin.page)).not.toContain('Visitor tracking')

  // The API answers as before: the journey is DISABLED, its start not allowed.
  expect(await otherReceptionApi.ok<VisitJourney>('GET', `/visits/${visit.id}/journey`)).toMatchObject({ state: 'DISABLED', can_enroll: false, enroll_blocker: 'NOT_ALLOWED' })
  expect((await otherReceptionApi.me()).company.tracking_allowed).toBe(false)
})

test('a host has no Visitor Journey and the API refuses them; management reads it without an action; another company sees nothing', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const name = `Lama Haddad ${tag}`
  const host = await apiAs('employee')
  const receptionApi = await apiAs('reception')
  const visit = await checkedInVisit(host, receptionApi, name)
  await enrollVisit(receptionApi, visit.id)

  const employee = await open({ as: 'employee' })
  await employee.page.goto('/visits')
  await expect(employee.page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible()
  await expect(employee.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Visitor Journey' })).toHaveCount(0)
  await employee.page.goto(`/journey/${visit.id}`)
  await expect(employee.page).toHaveURL(/\/visits$/)
  for (const path of ['/journeys', `/visits/${visit.id}/journey`, '/tracking/status']) await host.fails('GET', path, 403)

  const management = await open({ as: 'management' })
  await management.page.goto(`/journey/${visit.id}`)
  await expect(management.page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(management.page.getByRole('heading', { name: 'Inferred location' })).toBeVisible()
  await expect(management.page.getByRole('button', { name: /tracking$/ })).toHaveCount(0)
  expect(ACCOUNTS.management.company).toBe('Mawdoo3')

  const other = await apiAs('otherReception')
  await other.fails('GET', `/visits/${visit.id}/journey`, 404)
  await receptionApi.ok('POST', `/visits/${visit.id}/tracking/revoke`)
})
