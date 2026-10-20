import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { ACCOUNTS, platformStorageStatePath, storageStatePath, type AccountKey } from '../support/accounts.ts'
import { expect, test } from '../support/fixtures.ts'
import { qualityData, type QualityData } from '../support/quality-data.ts'
import { afterFrames, horizontalOverflow } from '../support/ui.ts'

/*
 * The device's appearance (Phase 13) on the real pages, with the running API's data
 * (support/quality-data.ts), at the project's viewport and at 320 px:
 *
 * - The toggle (F13-25) on a signed-out page and in the administrator's shell: a press draws the other
 *   scheme than the one shown and keeps it across a reload, from the first frame.
 *
 * - Dark, chosen on a device whose own scheme is light: the main pages of every kind (the signed-out
 *   pages and the pass, the dashboards, visits, the administrator's pages, reports, the e-mail texts,
 *   the platform owner's pages) have no serious or critical axe violation and no horizontal scroll,
 *   and are drawn in the dark scheme (the root's `data-scheme`, the dark canvas).
 * - Light, chosen on a device whose own scheme is dark: the reception screen, dark by design under
 *   System, is light, every tab of it, and its camera panel stays the dark panel.
 */

test.describe.configure({ mode: 'parallel' })

const CANVAS = { light: 'rgb(241, 241, 241)', dark: 'rgb(16, 22, 25)' } as const

interface PageCheck {
  name: string
  path: (data: QualityData) => string
  ready: (page: Page, data: QualityData) => Locator
}

const h1 = (name: string | RegExp) => (page: Page) => page.getByRole('heading', { level: 1, name })
const companyOf = (data: QualityData) => new URL(data.passUrl).searchParams.get('c') ?? ''

/** The device chose `appearance` on an earlier visit: it is in storage before the page's first script runs. */
async function choose(page: Page, appearance: 'light' | 'dark') {
  await page.addInitScript((value) => window.localStorage.setItem('vms.appearance', value), appearance)
}

async function checkPage(page: Page, check: PageCheck, scheme: 'light' | 'dark', { frames = true }: { frames?: boolean } = {}) {
  const data = qualityData()
  await page.goto(check.path(data))
  await expect(check.ready(page, data)).toBeVisible()
  await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-scheme')), 'the scheme on the root').toBe(scheme)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'the canvas').toBe(CANVAS[scheme])

  // A sandboxed frame (the saved e-mail) runs no script: axe reads the page around it.
  const builder = new AxeBuilder({ page })
  const results = await (frames ? builder : builder.exclude('iframe[sandbox]').options({ iframes: false })).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help} — ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.any[0]?.message ?? ''}`).join(', ')}`),
    'serious or critical axe violations',
  ).toEqual([])
  expect(await horizontalOverflow(page), 'horizontal page overflow in px').toBeLessThanOrEqual(0)

  await page.setViewportSize({ width: 320, height: page.viewportSize()?.height ?? 720 })
  await afterFrames(page, 2)
  expect(await horizontalOverflow(page), 'horizontal page overflow at 320 px in px').toBeLessThanOrEqual(0)
}

const SIGNED_OUT: PageCheck[] = [
  { name: 'sign in', path: () => '/login', ready: h1('Sign in') },
  { name: 'a company’s sign in', path: (data) => `/c/${companyOf(data)}`, ready: (page) => page.locator('[data-identity-lockup="page"] img') },
  { name: 'forgot password', path: (data) => `/forgot-password?c=${companyOf(data)}`, ready: h1('Reset your password') },
  { name: 'visitor pass', path: (data) => data.passUrl.replace(/^https?:\/\/[^/]+/, ''), ready: (page) => page.getByRole('img', { name: 'Visitor pass QR code' }) },
  { name: 'page not found', path: () => '/no-such-page', ready: h1('Page not found') },
  { name: 'platform sign in', path: () => '/platform/login', ready: h1('Sign in to the platform') },
]

const ADMIN: PageCheck[] = [
  { name: 'admin dashboard', path: () => '/admin', ready: h1('Admin dashboard') },
  { name: 'my visits', path: () => '/visits', ready: h1('My visits') },
  { name: 'visit details', path: (data) => `/visits/${data.scheduledVisitId}`, ready: (page) => page.getByRole('heading', { name: 'Timeline' }) },
  { name: 'invite visitor', path: () => '/visits/new', ready: (page) => page.getByRole('button', { name: 'Send invitation' }) },
  { name: 'visit history', path: () => '/history', ready: (page) => page.getByText('Karim Nasser').first() },
  { name: 'admin: users', path: () => '/admin/users', ready: (page) => page.getByText('admin@demo.local').first() },
  { name: 'admin: company settings', path: () => '/admin/settings', ready: (page) => page.getByRole('textbox', { name: 'Company name' }) },
  { name: 'admin: audit log', path: () => '/admin/audit', ready: (page) => page.getByRole('list', { name: 'Audit events, newest first' }) },
  { name: 'reports', path: () => '/reports', ready: h1('Reports') },
  { name: 'admin: e-mail texts editor', path: () => '/admin/email-templates/VISITOR_INVITATION', ready: (page) => page.locator('[data-preview-subject]') },
  // Phase 14: one of the host's e-mails of a visit.
  { name: 'admin: e-mail texts editor (host)', path: () => '/admin/email-templates/HOST_VISIT_SCHEDULED', ready: (page) => page.locator('[data-preview-subject]') },
]

const RECEPTION: PageCheck[] = [
  { name: 'reception: scan', path: () => '/reception', ready: (page) => page.getByText('Ready to scan') },
  { name: 'reception: expected', path: () => '/reception?tab=expected', ready: (page) => page.getByText('Sara Khoury').first() },
  { name: 'reception: inside', path: () => '/reception?tab=inside', ready: (page) => page.getByRole('list', { name: 'Visitors inside' }) },
  { name: 'reception: walk-in', path: () => '/reception?tab=walk-in', ready: (page) => page.getByRole('button', { name: 'Check in walk-in' }) },
]

const PLATFORM: PageCheck[] = [
  { name: 'platform: companies', path: () => '/platform/companies', ready: (page) => page.getByRole('link', { name: 'Other Corp' }) },
  { name: 'platform: audit log', path: () => '/platform/audit', ready: (page) => page.getByRole('list', { name: 'Platform audit events, newest first' }) },
]

test.describe('Dark, on a device in its light scheme', () => {
  test.use({ colorScheme: 'light' })

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } })
    for (const check of SIGNED_OUT) {
      test(`Dark · signed out · ${check.name}: axe and horizontal scroll`, async ({ page }) => {
        await choose(page, 'dark')
        await checkPage(page, check, 'dark')
      })
    }
  })

  const roles: { account: AccountKey; pages: PageCheck[] }[] = [
    { account: 'admin', pages: ADMIN },
    { account: 'reception', pages: RECEPTION },
  ]
  for (const { account, pages } of roles) {
    test.describe(ACCOUNTS[account].email, () => {
      test.use({ storageState: storageStatePath(account) })
      for (const check of pages) {
        test(`Dark · ${account} · ${check.name}: axe and horizontal scroll`, async ({ page }) => {
          await choose(page, 'dark')
          await checkPage(page, check, 'dark')
        })
      }
    })
  }

  test.describe('the saved e-mail', () => {
    test.use({ storageState: storageStatePath('admin') })
    test('Dark · admin · the saved e-mail, Light and Dark: axe on the page around it', async ({ page }) => {
      await choose(page, 'dark')
      await checkPage(page, ADMIN.at(-1)!, 'dark')
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.getByRole('tab', { name: 'Saved email' }).click()
      const schemes = page.getByRole('radiogroup', { name: 'Email appearance' })
      await expect(schemes.getByRole('radio', { name: 'Light' })).toBeChecked()
      await schemes.getByText('Dark', { exact: true }).click()
      await expect(page.locator('iframe[data-saved-preview]')).toHaveAttribute('src', /scheme=dark/)
      const results = await new AxeBuilder({ page }).exclude('iframe[sandbox]').options({ iframes: false }).analyze()
      expect(results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map((violation) => violation.id)).toEqual([])
    })
  })

  test.describe('platform owner', () => {
    test.use({ storageState: platformStorageStatePath() })
    for (const check of PLATFORM) {
      test(`Dark · platform owner · ${check.name}: axe and horizontal scroll`, async ({ page }) => {
        await choose(page, 'dark')
        await checkPage(page, check, 'dark')
      })
    }

    for (const sub of [
      { name: 'identity', page: 'identity', ready: (current: Page) => current.locator('[data-identity-preview]') },
      { name: 'e-mail texts editor', page: 'email-templates/VISITOR_INVITATION', ready: (current: Page) => current.locator('[data-preview-subject]') },
    ]) {
      test(`Dark · platform owner · ${sub.name} of ${ACCOUNTS.admin.company}: axe and horizontal scroll`, async ({ page }) => {
        await choose(page, 'dark')
        await page.goto('/platform/companies')
        await page.getByRole('link', { name: ACCOUNTS.admin.company, exact: true }).click()
        await expect(h1(ACCOUNTS.admin.company)(page)).toBeVisible()
        const base = new URL(page.url()).pathname
        await checkPage(page, { name: sub.name, path: () => `${base}/${sub.page}`, ready: sub.ready }, 'dark')
      })
    }
  })
})

/** Presses the toggle in `scope` and checks the page: drawn in `scheme`, kept on the device, and so after a reload. */
async function press(page: Page, scope: Locator, scheme: 'light' | 'dark', ready: Locator) {
  const toggle = scope.getByRole('button', { name: 'Dark mode', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', String(scheme === 'light'))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(scheme === 'dark'))
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-scheme'))).toBe(scheme)
  expect(await page.evaluate(() => window.localStorage.getItem('vms.appearance'))).toBe(scheme)
  await page.reload()
  await expect(ready).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-scheme'))).toBe(scheme)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(CANVAS[scheme])
}

test.describe('The toggle, pressed on a device in its light scheme', () => {
  test.use({ colorScheme: 'light' })

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } })
    test('the toggle · signed out · a company’s sign in: Dark, kept across a reload, then Light', async ({ page }) => {
      const check = SIGNED_OUT[1]!
      const ready = check.ready(page, qualityData())
      await page.goto(check.path(qualityData()))
      await expect(ready).toBeVisible()
      const header = page.locator('[data-public-header]')
      await press(page, header, 'dark', ready)
      await press(page, header, 'light', ready)
    })
  })

  test.describe(ACCOUNTS.admin.email, () => {
    test.use({ storageState: storageStatePath('admin') })
    test('the toggle · admin · my visits: from the shell, Dark kept across a reload, axe, then Light', async ({ page }) => {
      const ready = h1('My visits')(page)
      await page.goto('/visits')
      await expect(ready).toBeVisible()
      // The sidebar on a desktop, the top bar below.
      const shell = page.locator('aside:visible, header[data-app-bar]:visible').first()
      await press(page, shell, 'dark', ready)
      await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map((violation) => violation.id)).toEqual([])
      expect(await horizontalOverflow(page), 'horizontal page overflow in px').toBeLessThanOrEqual(0)
      await press(page, shell, 'light', ready)
    })
  })
})

test.describe('Light, on a device in its dark scheme: the reception screen', () => {
  test.use({ colorScheme: 'dark', storageState: storageStatePath('reception') })
  for (const check of RECEPTION) {
    test(`Light · reception · ${check.name}: light, its camera panel dark, axe and horizontal scroll`, async ({ page }) => {
      await choose(page, 'light')
      await checkPage(page, check, 'light')
      // Light from edge to edge: no dark surface for the page and its dialogs.
      await expect(page.locator('[data-surface]')).toHaveCount(0)
      if (check.path(qualityData()) === '/reception') {
        // The camera's panel shows a live picture of any brightness: the same dark panel as in the dark scheme.
        expect(await page.locator('.bg-media').first().evaluate((panel) => getComputedStyle(panel).backgroundColor)).toBe('rgb(14, 19, 22)')
      }
    })
  }
})
