import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { Department, Visit, Zone } from '../../src/types/api.ts'
import { alertsOf, apiOf, areaCompany, sessionOf, trackedVisit, waitForAlert, type AreaCompany } from '../support/area-alerts.ts'
import { expect, test } from '../support/fixtures.ts'
import { waitForMessage } from '../support/outbox.ts'
import { simulateAt } from '../support/tracking.ts'
import { horizontalOverflow, uniqueTag } from '../support/ui.ts'

/*
 * Area alerts against the real API (Phase 16, contract §E), in a company of their own (support/area-alerts.ts)
 * so their toasts and badges never reach the other specs' sessions. The administrator marks a zone restricted
 * and puts a department on floor 2 through the pages; a host of that department invites a visitor, whose
 * allowed area the invitation form starts from that floor; reception checks the visitor in and starts the
 * tracking; the backend's `simulate-journey --cameras` then walks the visitor onto floor 4 (one floor a run:
 * two floors within 60 s would make the journey uncertain, and raise nothing). Every observation goes through
 * the ingestion service and is marked Simulated.
 */

test.describe.configure({ mode: 'serial' })

/** No serious or critical axe finding and no sideways scroll. */
async function accessible(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await horizontalOverflow(page), name).toBeLessThanOrEqual(0)
}

/** The navigation's links (the drawer opened on a phone). */
async function navigationLinks(page: Page): Promise<string[]> {
  const openDrawer = page.getByRole('button', { name: /^(Open navigation|فتح التنقل)$/ })
  if (await openDrawer.isVisible()) await openDrawer.click()
  const links = (await page.getByRole('navigation').first().getByRole('link').allTextContents()).map((text) => text.trim())
  if (await openDrawer.isVisible()) await page.keyboard.press('Escape')
  return links
}

/** The shell asks for the alerts' counts every 15 s: a new alert is said within one poll. */
const WATCH_TIMEOUT = 25_000

let company: AreaCompany

test.beforeAll(async () => {
  test.setTimeout(180_000)
  company = await areaCompany()
})

test('an administrator marks the server room restricted and puts the team on floor 2, through the pages', async ({ open }) => {
  const { page } = await sessionOf(open, company.admin)
  await page.goto('/admin/tracking?tab=locations')
  const floors = page.getByRole('list', { name: `Floors of ${company.building.name}` })
  await floors.getByRole('button', { name: 'Actions for Server room' }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit zone Server room' })
  await expect(dialog.getByRole('combobox', { name: 'Access' })).toHaveValue('STANDARD')
  await dialog.getByRole('combobox', { name: 'Access' }).selectOption({ label: 'Restricted' })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  const zones = floors.getByRole('list', { name: 'Zones of Floor 4' })
  await expect(zones.getByRole('listitem').filter({ hasText: 'Server room' }).locator('[data-zone-access="RESTRICTED"]')).toHaveText('Restricted')
  await expect(page.getByRole('list', { name: 'Zones of Ground floor' }).locator('[data-zone-access="COMMON"]')).toHaveText('Common')
  await accessible(page, 'the locations editor with access levels')

  await page.goto('/admin/departments')
  const floorChoice = page.getByRole('combobox', { name: `Floor of ${company.department.name}` })
  await floorChoice.selectOption({ label: 'Floor 2' })
  await expect(page.getByText(`Floor of ${company.department.name} saved`)).toBeVisible()
  await accessible(page, 'the departments with their floors')

  const admin = await apiOf(company.admin)
  try {
    const departments = await admin.ok<Department[]>('GET', '/departments')
    expect(departments.find((department) => department.id === company.department.id)?.floor?.id).toBe(company.floors.floor2.id)
    const tree = await admin.ok<{ buildings: { floors: { zones: Zone[] }[] }[] }>('GET', '/locations')
    const server = tree.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.zones)).find((zone) => zone.id === company.zones.server.id)
    expect(server?.access).toBe('RESTRICTED')
  } finally {
    await admin.dispose()
  }
})

test('a host invites with the team’s floor; reception is alerted when the visitor goes up to floor 4, and acknowledges then resolves', async ({ open }) => {
  test.setTimeout(300_000)
  const name = `Dana Haddad ${uniqueTag()}`

  // The host: the invitation's allowed areas start from the department's floor; no alerts for a host.
  const host = await sessionOf(open, company.host)
  await host.page.goto('/visits/new')
  await expect(host.page.getByRole('heading', { level: 1, name: 'Invite visitor' })).toBeVisible()
  const areas = host.page.getByRole('group', { name: 'Allowed areas (optional)' })
  await expect(areas.getByRole('checkbox', { name: 'Floor 2' })).toBeChecked()
  await expect(areas.getByRole('checkbox', { name: 'Floor 4' })).not.toBeChecked()
  expect(await navigationLinks(host.page)).not.toEqual(expect.arrayContaining(['Tracking alerts']))
  expect((await navigationLinks(host.page)).some((link) => link.startsWith('Tracking alerts') || link === 'Visitor Journey')).toBe(false)
  await host.api.fails('GET', '/tracking/alerts', 403)
  await host.api.fails('GET', '/tracking/alerts/summary', 403)
  await host.page.getByRole('textbox', { name: 'Full name' }).fill(name)
  await host.page.getByRole('radio', { name: 'I’ll share the pass myself' }).check({ force: true })
  await host.page.getByRole('textbox', { name: /^Purpose/ }).fill('Quarterly review')
  const created = host.page.waitForResponse((answer) => answer.url().endsWith('/api/v1/visits') && answer.request().method() === 'POST')
  await host.page.getByRole('button', { name: 'Create visit' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON()).toMatchObject({ access_areas: { floor_ids: [company.floors.floor2.id], zone_ids: [] } })
  const visit = ((await response.json()) as { visit: Visit }).visit
  expect(visit.access_areas.floors.map((floor) => floor.id)).toEqual([company.floors.floor2.id])

  // Reception: checks the visitor in and starts the tracking at the reception desk, then watches the live map.
  const receptionApi = await apiOf(company.reception)
  try {
    await receptionApi.checkIn(visit.id, { method: 'MANUAL' })
    await receptionApi.ok('POST', `/visits/${visit.id}/tracking/enroll`, { camera_id: company.cameras.desk.id })
    const { page } = await sessionOf(open, company.reception)
    const firstSummary = page.waitForResponse((answer) => answer.url().endsWith('/api/v1/tracking/alerts/summary'))
    await page.goto('/journey')
    await expect(page.getByRole('region', { name: `Floors of ${company.building.name}` })).toBeVisible()
    await firstSummary
    await expect(page.locator(`[data-no-location] [data-live-chip="${visit.id}"]`)).toBeVisible()

    // Floor 4 is outside the visit's floor 2: the alert is raised by the ingestion of the observation.
    expect(await simulateAt(visit.id, [company.cameras.office4.provider_camera_id])).toMatch(/accepted: 1/)
    const alert = await waitForAlert(receptionApi, visit.id, (one) => one.status === 'OPEN')
    expect(alert).toMatchObject({ type: 'UNAUTHORIZED_AREA', simulated: true, observations: 1, last_location: { zone: { id: company.zones.office4.id } } })

    // The shell says it: a toast (with the way to the journey), the badge, the tab's title.
    const toast = page.getByText(`Alert: ${name} in Floor 4 › Finance offices`)
    await expect(toast).toBeVisible({ timeout: WATCH_TIMEOUT })
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tracking alerts 1 active alert' })).toBeVisible()
    await expect(page).toHaveTitle(/^\(1\) /)
    // The map: the visitor's chip on floor 4, in the alerts' red.
    const chip = page.getByRole('region', { name: `Floors of ${company.building.name}` }).locator(`[data-live-chip="${visit.id}"]`)
    await expect(chip).toHaveAttribute('data-chip-alert', 'OPEN', { timeout: WATCH_TIMEOUT })
    await expect(chip.locator('xpath=ancestor::*[@data-floor-band][1]')).toHaveAttribute('data-floor-band', company.floors.floor4.id)
    await accessible(page, 'the live map with an alert')

    // The panel: the path, the place outside the allowed areas in red, the alert.
    await chip.click()
    const panel = page.getByRole('dialog', { name })
    await expect(panel.locator('[data-journey-path] li').last()).toHaveAttribute('data-stay-allowed', 'false')
    await expect(panel.locator('[data-journey-path] li').last()).toContainText('Outside allowed area')
    await expect(panel.locator('[data-panel-alert] [data-alert-type="UNAUTHORIZED_AREA"]')).toBeVisible()
    await accessible(page, 'a visitor’s panel with an alert')
    await page.keyboard.press('Escape')

    // The toast's View opens the journey: the place outside is marked in the timeline.
    await page.getByRole('button', { name: 'View' }).click()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await expect(page.locator('[data-journey-timeline] [data-event-allowed="false"]').first()).toContainText('Outside allowed area')

    // The alerts page: acknowledge with a note, then resolve.
    await page.goto('/journey/alerts')
    const card = page.locator(`[data-alert-card="${alert.id}"]`)
    await expect(card.locator('[data-alert-status]')).toHaveText('Open')
    await expect(card).toContainText('Allowed floorsFloor 2')
    await accessible(page, 'the tracking alerts')
    await card.getByRole('button', { name: 'Acknowledge' }).click()
    let dialog = page.getByRole('dialog', { name: `Acknowledge the alert for ${name}?` })
    await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill('Called the host')
    await dialog.getByRole('button', { name: 'Acknowledge' }).click()
    await expect(card.locator('[data-alert-status]')).toHaveText('Acknowledged')
    await expect(card).toContainText('Called the host')
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator('[data-nav-badge="neutral"]')).toBeVisible({ timeout: WATCH_TIMEOUT })
    await card.getByRole('button', { name: 'Resolve' }).click()
    dialog = page.getByRole('dialog', { name: `Resolve the alert for ${name}?` })
    await dialog.getByRole('button', { name: 'Resolve' }).click()
    await expect(card).toHaveCount(0)
    expect((await alertsOf(receptionApi, visit.id))[0]).toMatchObject({ status: 'RESOLVED', resolution: 'MANUAL', note: 'Called the host', resolved_by: { full_name: company.reception.name } })
    await expect(page).not.toHaveTitle(/^\(\d+\) /, { timeout: WATCH_TIMEOUT })

    // E-mailed to the host and to the company's alert address, marked simulated.
    const toAddress = await waitForMessage({ kind: 'TRACKING_ALERT', to: company.alertEmail, where: (message) => message.text.includes(name) })
    expect(toAddress.subject).toContain('[Simulated]')
    expect(toAddress.text).toContain(`/journey/${visit.id}`)
    const toHost = await waitForMessage({ kind: 'TRACKING_ALERT', to: company.host.email, where: (message) => message.text.includes(name) })
    expect(toHost.text).not.toContain(`/journey/${visit.id}`)
  } finally {
    await receptionApi.dispose()
  }
})

test('a restricted zone escalates an acknowledged alert; widening the allowed areas resolves it', async ({ open }) => {
  test.setTimeout(300_000)
  const name = `Yara Nasser ${uniqueTag()}`
  const hostApi = await apiOf(company.host)
  const receptionApi = await apiOf(company.reception)
  try {
    const visit = await trackedVisit(company, name, { host: hostApi, reception: receptionApi })
    expect(visit.access_areas.floors.map((floor) => floor.id)).toEqual([company.floors.floor2.id])
    expect(await simulateAt(visit.id, [company.cameras.office4.provider_camera_id])).toMatch(/accepted: 1/)
    const opened = await waitForAlert(receptionApi, visit.id, (one) => one.status === 'OPEN')
    await receptionApi.ok('POST', `/tracking/alerts/${opened.id}/acknowledge`, {})

    const { page } = await sessionOf(open, company.reception)
    const firstSummary = page.waitForResponse((answer) => answer.url().endsWith('/api/v1/tracking/alerts/summary'))
    await page.goto('/journey/alerts')
    await firstSummary
    const card = page.locator(`[data-alert-card="${opened.id}"]`)
    await expect(card.locator('[data-alert-status]')).toHaveText('Acknowledged')

    // The server room (restricted) on the same floor: the alert is escalated and open again, and said again.
    expect(await simulateAt(visit.id, [company.cameras.server.provider_camera_id])).toMatch(/accepted: 1/)
    const escalated = await waitForAlert(receptionApi, visit.id, (one) => one.type === 'RESTRICTED_AREA')
    expect(escalated).toMatchObject({ id: opened.id, status: 'OPEN', observations: 2, first_location: { zone: { id: company.zones.office4.id } }, last_location: { zone: { id: company.zones.server.id } } })
    await expect(page.getByText(`Alert: ${name} in Floor 4 › Server room`)).toBeVisible({ timeout: WATCH_TIMEOUT })
    await expect(card.locator('[data-alert-type]')).toHaveText('Restricted area', { timeout: WATCH_TIMEOUT })
    await expect(card.locator('[data-alert-status]')).toHaveText('Open')
    await expect(card.locator('[data-alert-where]')).toContainText('Server room')

    // Reception widens the visit's areas on the journey: floor 4 and the server room. The alert is resolved.
    await card.getByRole('link', { name: 'Open journey' }).click()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await page.getByRole('button', { name: 'Edit allowed areas' }).click()
    const dialog = page.getByRole('dialog', { name: `Allowed areas of ${name}` })
    await dialog.getByRole('checkbox', { name: 'Floor 4' }).check()
    await dialog.getByRole('combobox', { name: 'Extra zones' }).fill('server')
    await page.getByRole('listbox').getByRole('option', { name: /Server room/ }).click()
    await accessible(page, 'the allowed areas’ picker')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Allowed areas saved')).toBeVisible()
    const alerts = page.locator('[data-visit-alerts]')
    await expect(alerts.locator(`[data-alert-card="${opened.id}"] [data-alert-status]`)).toHaveText('Resolved')
    await expect(alerts.locator(`[data-alert-card="${opened.id}"]`)).toContainText('Allowed areas changed')
    expect((await alertsOf(receptionApi, visit.id))[0]).toMatchObject({ status: 'RESOLVED', resolution: 'AREAS_CHANGED' })
    // The places seen on floor 4 are allowed now: no stay of the path is outside any more.
    await expect(page.locator('[data-journey-path] [data-stay-allowed="false"]')).toHaveCount(0)
  } finally {
    await hostApi.dispose()
    await receptionApi.dispose()
  }
})

test('the check-out resolves the visit’s active alert', async ({ open }) => {
  test.setTimeout(240_000)
  const name = `Basel Odeh ${uniqueTag()}`
  const hostApi = await apiOf(company.host)
  const receptionApi = await apiOf(company.reception)
  try {
    const visit = await trackedVisit(company, name, { host: hostApi, reception: receptionApi })
    expect(await simulateAt(visit.id, [company.cameras.office4.provider_camera_id])).toMatch(/accepted: 1/)
    const opened = await waitForAlert(receptionApi, visit.id, (one) => one.status === 'OPEN')
    await receptionApi.checkOut(visit.id, { method: 'MANUAL' })
    // Resolved in the check-out's transaction, by whoever checked the visitor out.
    expect((await alertsOf(receptionApi, visit.id))[0]).toMatchObject({ id: opened.id, status: 'RESOLVED', resolution: 'CHECKED_OUT', resolved_by: { full_name: company.reception.name } })

    const { page } = await sessionOf(open, company.reception)
    await page.goto('/journey/alerts?scope=day')
    const card = page.locator(`[data-alert-card="${opened.id}"]`)
    await expect(card.locator('[data-alert-status]')).toHaveText('Resolved')
    await expect(card).toContainText('Checked out')
    await expect(card).toContainText(company.reception.name)
    await expect(card.getByRole('button')).toHaveCount(0)
  } finally {
    await hostApi.dispose()
    await receptionApi.dispose()
  }
})

test('management reads the alerts without an action; reception reads them in Arabic on a phone', async ({ open }) => {
  test.setTimeout(240_000)
  const name = `Lama Haddad ${uniqueTag()}`
  const hostApi = await apiOf(company.host)
  const receptionApi = await apiOf(company.reception)
  try {
    const visit = await trackedVisit(company, name, { host: hostApi, reception: receptionApi })
    expect(await simulateAt(visit.id, [company.cameras.office4.provider_camera_id])).toMatch(/accepted: 1/)
    const opened = await waitForAlert(receptionApi, visit.id, (one) => one.status === 'OPEN')

    const management = await sessionOf(open, company.management)
    await management.page.goto('/journey/alerts')
    const card = management.page.locator(`[data-alert-card="${opened.id}"]`)
    await expect(card.locator('[data-alert-status]')).toHaveText('Open')
    await expect(card.getByRole('button')).toHaveCount(0)
    await expect(card.getByRole('link', { name: 'Open journey' })).toBeVisible()
    await management.api.fails('POST', `/tracking/alerts/${opened.id}/acknowledge`, 403, {})

    const arabic = await sessionOf(open, company.reception, { device: 'mobile', language: 'ar' })
    await arabic.page.goto('/journey')
    await expect(arabic.page.getByRole('tab', { name: 'الخريطة الحية' })).toHaveAttribute('aria-selected', 'true')
    const chip = arabic.page.locator(`[data-live-chip="${visit.id}"]`)
    await expect(chip).toHaveAttribute('data-chip-alert', 'OPEN')
    await accessible(arabic.page, 'the live map in Arabic (phone)')
    await chip.click()
    await expect(arabic.page.getByRole('dialog', { name })).toContainText('خارج المسموح')
    await accessible(arabic.page, 'a visitor’s panel in Arabic (phone)')
    await arabic.page.keyboard.press('Escape')
    await arabic.page.goto('/journey/alerts')
    await expect(arabic.page.getByRole('heading', { level: 1, name: 'تنبيهات التتبّع' })).toBeVisible()
    const arabicCard = arabic.page.locator(`[data-alert-card="${opened.id}"]`)
    await expect(arabicCard.locator('[data-alert-type]')).toHaveText('منطقة غير مسموحة')
    await expect(arabicCard.locator('[data-alert-status]')).toHaveText('مفتوح')
    await accessible(arabic.page, 'the tracking alerts in Arabic (phone)')
    await receptionApi.ok('POST', `/tracking/alerts/${opened.id}/resolve`, {})
  } finally {
    await hostApi.dispose()
    await receptionApi.dispose()
  }
})
