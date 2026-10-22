import { AxeBuilder } from '@axe-core/playwright'
import { randomBytes } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { ACCOUNTS, platformStorageStatePath, storageStatePath, type AccountKey } from '../support/accounts.ts'
import { expect, test } from '../support/fixtures.ts'
import { qualityData, type QualityData } from '../support/quality-data.ts'
import { afterFrames, horizontalOverflow } from '../support/ui.ts'

/*
 * Every page, for every role, at the project's viewport (desktop 1440 × 900, tablet 820 × 1180 and
 * phone 390 × 844, both with touch): no serious or critical axe-core violation (WCAG 2.x A/AA and
 * best practices) and no horizontal page scroll, at that width and at 320 px (WCAG 1.4.10 reflow: a
 * small phone, or a desktop window zoomed to 400 %; F9-7 found the walk-in bar and the admin
 * dashboard 5 px and 1 px too wide there). The pages show real data from the running API
 * (support/quality-data.ts), loaded before they are checked.
 */

test.describe.configure({ mode: 'parallel' })

interface PageCheck {
  name: string
  path: (data: QualityData) => string
  /** Content that shows the page has loaded its data. */
  ready: (page: Page, data: QualityData) => Locator
}

const h1 = (name: string | RegExp) => (page: Page) => page.getByRole('heading', { level: 1, name })
/**
 * A page's first render, its data loaded: on a machine loaded by the whole suite the dev server's modules
 * and the API's first answer took more than the default 10 s (the audit log on the tablet, 2026-10-20: the
 * page loaded in 5 s, and the list's request answered 13 s after the navigation began).
 */
const FIRST_RENDER = { timeout: 30_000 }

const PAGES = {
  changePassword: { name: 'change password', path: () => '/change-password', ready: (page) => page.getByLabel('Current password') },
  myVisits: { name: 'my visits', path: () => '/visits', ready: h1('My visits') },
  invite: { name: 'invite visitor', path: () => '/visits/new', ready: (page) => page.getByRole('button', { name: 'Send invitation' }) },
  visit: { name: 'visit details', path: (data) => `/visits/${data.scheduledVisitId}`, ready: (page) => page.getByRole('heading', { name: 'Timeline' }) },
  visitors: { name: 'visitor search', path: () => '/visitors', ready: (page, data) => page.getByRole('link', { name: data.scheduledVisitorName }).first() },
  visitor: { name: 'visitor profile', path: (data) => `/visitors/${data.scheduledVisitorId}`, ready: (page) => page.getByRole('heading', { name: 'Visit history' }) },
  reception: { name: 'reception: scan', path: () => '/reception', ready: (page) => page.getByText('Ready to scan') },
  receptionExpected: { name: 'reception: expected', path: () => '/reception?tab=expected', ready: (page) => page.getByText('Sara Khoury').first() },
  receptionInside: { name: 'reception: inside', path: () => '/reception?tab=inside', ready: (page) => page.getByRole('list', { name: 'Visitors inside' }) },
  receptionWalkIn: { name: 'reception: walk-in', path: () => '/reception?tab=walk-in', ready: (page) => page.getByRole('button', { name: 'Check in walk-in' }) },
  history: { name: 'visit history', path: () => '/history', ready: (page) => page.getByText('Karim Nasser').first() },
  inside: { name: 'inside now (evacuation list)', path: () => '/inside', ready: (page) => page.getByText('Karim Nasser').first() },
  reports: { name: 'reports', path: () => '/reports', ready: h1('Reports') },
  adminDashboard: { name: 'admin dashboard', path: () => '/admin', ready: h1('Admin dashboard') },
  adminUsers: { name: 'admin: users', path: () => '/admin/users', ready: (page) => page.getByText('admin@demo.local').first() },
  adminDepartments: { name: 'admin: departments', path: () => '/admin/departments', ready: (page) => page.getByText('Human Resources').first() },
  adminSettings: { name: 'admin: company settings', path: () => '/admin/settings', ready: (page) => page.getByRole('textbox', { name: 'Company name' }) },
  adminAudit: { name: 'admin: audit log', path: () => '/admin/audit', ready: (page) => page.getByRole('list', { name: 'Audit events, newest first' }) },
  // Phase 11: a company's e-mail texts (the editor with its draft preview rendered).
  adminEmailTemplates: { name: 'admin: e-mail texts', path: () => '/admin/email-templates', ready: (page) => page.getByRole('list', { name: 'Emails' }) },
  adminEmailTemplate: { name: 'admin: e-mail texts editor', path: () => '/admin/email-templates/VISITOR_INVITATION', ready: (page) => page.locator('[data-preview-subject]') },
  // Phase 14: one of the host's e-mails of a visit (no button field, the department among the variables).
  adminEmailTemplateHost: { name: 'admin: e-mail texts editor (host)', path: () => '/admin/email-templates/HOST_VISIT_SCHEDULED', ready: (page) => page.locator('[data-preview-subject]') },
  // Phase 15: the Visitor Journey (the inside visitor is tracked by the simulator) and visitor tracking's administration.
  // Phase 16: the live map is /journey's first view; the day's list its second; the tracking alerts (none open here).
  journey: { name: 'visitor journey: the live map', path: () => '/journey', ready: (page) => page.locator('[data-floor-band]').first() },
  journeyList: { name: 'visitor journey: the list', path: () => '/journey?view=list', ready: (page) => page.locator('[data-location-path]').first() },
  journeyAlerts: { name: 'tracking alerts', path: () => '/journey/alerts', ready: (page) => page.locator('[data-alert-card]').first().or(page.getByRole('heading', { name: 'No active alerts' })) },
  journeyVisit: { name: 'a visitor’s journey', path: (data) => `/journey/${data.trackedVisitId}`, ready: (page) => page.locator('[data-journey-timeline]') },
  adminTracking: { name: 'admin: visitor tracking', path: () => '/admin/tracking', ready: (page) => page.getByRole('list', { name: 'Provider keys' }).or(page.getByText('No keys')) },
  adminTrackingLocations: { name: 'admin: tracking locations', path: () => '/admin/tracking?tab=locations', ready: (page) => page.getByRole('list', { name: 'Floors of Mawdoo3 HQ' }) },
  adminTrackingCameras: { name: 'admin: tracking cameras', path: () => '/admin/tracking?tab=cameras', ready: (page) => page.getByRole('table', { name: 'Cameras' }) },
} satisfies Record<string, PageCheck>

/** The platform owner's pages (Phase 11), with the platform account's own session. */
const PLATFORM_PAGES: PageCheck[] = [
  { name: 'platform: companies', path: () => '/platform/companies', ready: (page) => page.getByRole('link', { name: 'Other Corp' }) },
  { name: 'platform: add company', path: () => '/platform/companies/new', ready: h1('Add company') },
  { name: 'platform: audit log', path: () => '/platform/audit', ready: (page) => page.getByRole('list', { name: 'Platform audit events, newest first' }) },
  { name: 'platform: change password', path: () => '/platform/change-password', ready: (page) => page.getByLabel('Current password') },
]

/** The company a pass link names (`/pass?c=<slug>#<token>`, Phase 12): the seeded main company, which has an identity. */
const companyOf = (data: QualityData) => new URL(data.passUrl).searchParams.get('c') ?? ''

const PUBLIC_PAGES: PageCheck[] = [
  { name: 'sign in', path: () => '/login', ready: h1('Sign in') },
  // Phase 12: the pages of a company, in its identity, before anyone signs in.
  { name: 'a company’s sign in', path: (data) => `/c/${companyOf(data)}`, ready: (page) => page.locator('[data-identity-lockup="page"] img') },
  { name: 'a company’s forgot password', path: (data) => `/forgot-password?c=${companyOf(data)}`, ready: (page) => page.locator('[data-identity-lockup="page"] img') },
  { name: 'forgot password', path: () => '/forgot-password', ready: h1('Reset your password') },
  { name: 'reset password (no link)', path: () => '/reset-password', ready: h1('Link invalid or expired') },
  { name: 'reset password (form)', path: () => `/reset-password#token=${randomBytes(32).toString('base64url')}`, ready: h1('Choose a new password') },
  { name: 'visitor pass', path: (data) => data.passUrl.replace(/^https?:\/\/[^/]+/, ''), ready: (page) => page.getByRole('img', { name: 'Visitor pass QR code' }) },
  { name: 'visitor pass (incomplete link)', path: () => '/pass', ready: (page) => page.getByText('This pass link is incomplete or invalid') },
  { name: 'page not found', path: () => '/no-such-page', ready: h1('Page not found') },
  { name: 'platform sign in', path: () => '/platform/login', ready: h1('Sign in to the platform') },
]

const ROLE_PAGES: { label: string; account: AccountKey; pages: PageCheck[] }[] = [
  {
    label: 'administrator',
    account: 'admin',
    pages: [
      PAGES.adminDashboard,
      PAGES.adminUsers,
      PAGES.adminDepartments,
      PAGES.adminSettings,
      PAGES.adminAudit,
      PAGES.adminEmailTemplates,
      PAGES.adminEmailTemplate,
      PAGES.adminEmailTemplateHost,
      PAGES.adminTracking,
      PAGES.adminTrackingLocations,
      PAGES.adminTrackingCameras,
      PAGES.journey,
      PAGES.journeyList,
      PAGES.journeyAlerts,
      PAGES.journeyVisit,
      PAGES.reception,
      PAGES.receptionExpected,
      PAGES.receptionInside,
      PAGES.receptionWalkIn,
      PAGES.myVisits,
      PAGES.invite,
      PAGES.visit,
      PAGES.visitors,
      PAGES.visitor,
      PAGES.history,
      PAGES.inside,
      PAGES.reports,
      PAGES.changePassword,
    ],
  },
  { label: 'employee', account: 'employee', pages: [PAGES.myVisits, PAGES.invite, PAGES.visit, PAGES.visitors, PAGES.visitor, PAGES.changePassword] },
  {
    label: 'reception',
    account: 'reception',
    pages: [PAGES.reception, PAGES.receptionExpected, PAGES.receptionInside, PAGES.receptionWalkIn, PAGES.visitors, PAGES.visitor, PAGES.visit, PAGES.history, PAGES.inside, PAGES.journey, PAGES.journeyList, PAGES.journeyAlerts, PAGES.journeyVisit, PAGES.changePassword],
  },
  { label: 'management', account: 'management', pages: [PAGES.reports, PAGES.history, PAGES.inside, PAGES.journey, PAGES.journeyList, PAGES.journeyAlerts, PAGES.journeyVisit, PAGES.visitors, PAGES.visitor, PAGES.visit, PAGES.changePassword] },
]

async function checkPage(page: Page, check: PageCheck) {
  const data = qualityData()
  await page.goto(check.path(data))
  await expect(check.ready(page, data)).toBeVisible(FIRST_RENDER)
  // Every loading spinner (a `status` with a spinning icon) is gone, so the data is on screen.
  await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
  await page.waitForLoadState('networkidle')

  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
    'serious or critical axe violations',
  ).toEqual([])
  expect(await horizontalOverflow(page), 'horizontal page overflow in px').toBeLessThanOrEqual(0)

  await page.setViewportSize({ width: 320, height: page.viewportSize()?.height ?? 720 })
  await afterFrames(page, 2)
  expect(await horizontalOverflow(page), 'horizontal page overflow at 320 px in px').toBeLessThanOrEqual(0)
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  for (const check of PUBLIC_PAGES) {
    test(`signed out · ${check.name}: axe and horizontal scroll`, async ({ page }) => {
      await checkPage(page, check)
    })
  }
})

for (const role of ROLE_PAGES) {
  test.describe(role.label, () => {
    test.use({ storageState: storageStatePath(role.account) })
    for (const check of role.pages) {
      test(`${role.label} · ${check.name}: axe and horizontal scroll`, async ({ page }) => {
        await checkPage(page, check)
      })
    }
  })
}

test.describe('administrator · audit log with event details open', () => {
  test.use({ storageState: storageStatePath('admin') })
  test('two open events: axe, including landmark-unique', async ({ page }) => {
    await page.goto('/admin/audit')
    await expect(PAGES.adminAudit.ready(page)).toBeVisible(FIRST_RENDER)
    await page.waitForLoadState('networkidle')
    // Each open event used to add a region landmark named "Recorded details": two open events repeated it
    // (axe `landmark-unique`, a moderate rule the page check above does not block on).
    const toggles = page.getByRole('button', { name: /^Details: / })
    await toggles.nth(0).click()
    await toggles.nth(1).click()
    await expect(page.getByRole('group', { name: 'Recorded details' })).toHaveCount(2)

    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical' || violation.id === 'landmark-unique',
    )
    expect(
      blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
      'axe violations with event details open',
    ).toEqual([])
  })
})

test.describe('platform owner', () => {
  test.use({ storageState: platformStorageStatePath() })
  for (const check of PLATFORM_PAGES) {
    test(`platform owner · ${check.name}: axe and horizontal scroll`, async ({ page }) => {
      await checkPage(page, check)
    })
  }

  test('platform owner · a company’s page: axe and horizontal scroll', async ({ page }) => {
    await page.goto('/platform/companies')
    await page.getByRole('link', { name: 'Other Corp' }).click()
    const heading = h1('Other Corp')(page)
    await expect(heading).toBeVisible()
    const url = new URL(page.url())
    await checkPage(page, { name: 'platform: company', path: () => url.pathname, ready: (current) => current.getByRole('list', { name: 'Administrators of Other Corp' }) })
  })

  // Phase 12: a company's identity and its e-mail texts in the platform area, for a company with an
  // identity (the seeded main company) and for one without (Other Corp).
  for (const company of [ACCOUNTS.admin.company, ACCOUNTS.otherAdmin.company]) {
    const pages: { name: string; page: string; ready: PageCheck['ready'] }[] = [
      { name: 'identity', page: 'identity', ready: (current) => current.locator('[data-identity-preview]') },
      { name: 'e-mail texts', page: 'email-templates', ready: (current) => current.getByRole('list', { name: 'Emails' }) },
      { name: 'e-mail texts editor', page: 'email-templates/VISITOR_INVITATION', ready: (current) => current.locator('[data-preview-subject]') },
    ]
    for (const check of pages) {
      test(`platform owner · ${check.name} of ${company}: axe and horizontal scroll`, async ({ page }) => {
        await page.goto('/platform/companies')
        await page.getByRole('link', { name: company, exact: true }).click()
        await expect(h1(company)(page)).toBeVisible()
        const base = new URL(page.url()).pathname
        await checkPage(page, { name: `platform: ${check.name}`, path: () => `${base}/${check.page}`, ready: check.ready })
      })
    }
  }
})
