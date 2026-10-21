import type { Page } from '@playwright/test'
import { Api } from '../support/api.ts'
import { expect, test } from '../support/fixtures.ts'
import { minutes } from '../support/time.ts'
import { uniqueTag } from '../support/ui.ts'

/*
 * The role matrix of contract §7.5 as each role meets it in the UI: what the navigation offers,
 * where a page the role may not open leads (its own landing page; the guard is cosmetic), and that
 * the API refuses the same actions (403 FORBIDDEN, or 404 for another owner's visit), whatever
 * the UI shows.
 */

const ALL_LINKS = [
  'Reception',
  'My visits',
  'Invite visitor',
  'Visitors',
  'Inside now',
  // Phase 15: administrators, management and reception; never a host.
  'Visitor Journey',
  'Visit history',
  'Reports',
  'Dashboard',
  'Users',
  'Departments',
  'Company settings',
  'Email texts',
  'Visitor tracking',
  'Audit log',
]

async function expectNavigation(page: Page, allowed: readonly string[]) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(nav).toBeVisible()
  for (const link of ALL_LINKS) {
    await expect(nav.getByRole('link', { name: link, exact: true }), `navigation link “${link}”`).toHaveCount(allowed.includes(link) ? 1 : 0)
  }
}

async function expectRedirects(page: Page, paths: readonly string[], landing: RegExp) {
  for (const path of paths) {
    await page.goto(path)
    await expect(page, `${path} must lead to the role's landing page`).toHaveURL(landing)
  }
}

async function expectForbidden(api: Api, requests: readonly (readonly [method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown])[]) {
  for (const [method, path, body] of requests) {
    expect((await api.fails(method, path, 403, body)).error.code, `${method} ${path}`).toBe('FORBIDDEN')
  }
}

test.describe('permission violations per role', () => {
  test('signed out: every page asks to sign in and the API answers 401', async ({ open }) => {
    const { page } = await open()
    for (const path of ['/visits', '/reception', '/admin/users', '/reports']) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/login\?next=/)
      expect(new URL(page.url()).searchParams.get('next')).toBe(path)
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    }
    const anonymous = await Api.anonymous()
    try {
      for (const [method, path] of [['GET', '/visits'], ['GET', '/auth/me'], ['POST', '/reception/scan'], ['GET', '/audit-logs']] as const) {
        expect((await anonymous.fails(method, path, 401, method === 'POST' ? { token: 'x' } : undefined)).error.code, path).toBe('NOT_AUTHENTICATED')
      }
    } finally {
      await anonymous.dispose()
    }
  })

  test('employee: own visits only, no reception, history, reports or administration', async ({ open, apiAs }) => {
    // A visit of another employee, unknown to this one.
    const other = await apiAs('employeeB')
    const now = Date.now()
    const foreign = await other.createVisit({ visitor: { full_name: `Private Guest ${uniqueTag()}` }, start: new Date(now + minutes(30)), end: new Date(now + minutes(90)) })

    const { page, api } = await open({ as: 'employee' })
    await page.goto('/')
    await expect(page).toHaveURL(/\/visits$/)
    await expectNavigation(page, ['My visits', 'Invite visitor', 'Visitors'])
    await expectRedirects(page, ['/reception', '/history', '/inside', '/journey', '/reports', '/admin', '/admin/users', '/admin/audit', '/admin/settings', '/admin/email-templates', '/admin/tracking'], /\/visits$/)
    await page.goto(`/visits/${foreign.visit.id}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Visit not found' })).toBeVisible()
    await page.goto(`/visitors/${foreign.visit.visitor.id}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Visitor not found' })).toBeVisible()

    await api.fails('GET', `/visits/${foreign.visit.id}`, 404)
    await api.fails('POST', `/visits/${foreign.visit.id}/cancel`, 404, { reason: 'Not mine' })
    await expectForbidden(api, [
      ['GET', '/reception/today'],
      ['POST', '/reception/scan', { token: 'x'.repeat(43) }],
      ['GET', '/reception/inside'],
      ['GET', '/reports/summary'],
      ['GET', '/audit-logs'],
      ['GET', '/users'],
      ['POST', '/departments', { name: 'Not allowed' }],
      ['PATCH', '/company/settings', { allow_walk_ins: false }],
      // Phase 15: a host reads no journey, not even the tracking's status.
      ['GET', '/journeys'],
      ['GET', '/tracking/status'],
      ['GET', '/locations'],
    ])
    // Denials are recorded (§7.4).
    const me = await api.me()
    const denied = await (await apiAs('admin')).auditLogs({ action: 'ACCESS_DENIED', actor_user_id: me.user.id })
    expect(denied.length).toBeGreaterThanOrEqual(1)
  })

  test('reception: reception, visitors, history and inside; no invitations, reports or administration', async ({ open }) => {
    const { page, api } = await open({ as: 'reception' })
    await page.goto('/')
    await expect(page).toHaveURL(/\/reception$/)
    await expectNavigation(page, ['Reception', 'Visitors', 'Inside now', 'Visitor Journey', 'Visit history'])
    await expectRedirects(page, ['/visits', '/visits/new', '/reports', '/admin', '/admin/departments', '/admin/audit', '/admin/tracking'], /\/reception$/)
    const now = Date.now()
    await expectForbidden(api, [
      ['POST', '/visits', { visitor: { full_name: 'Not allowed' }, host_id: (await api.me()).user.id, purpose: 'x', scheduled_start: new Date(now + minutes(10)).toISOString(), scheduled_end: new Date(now + minutes(70)).toISOString(), send_invitation: false }],
      ['GET', '/reports/summary'],
      ['GET', '/audit-logs'],
      ['GET', '/users'],
      ['POST', '/departments', { name: 'Not allowed' }],
      ['PATCH', '/company/settings', { allow_walk_ins: false }],
      ['GET', '/dashboard/employee'],
      // Phase 15: tracking is set up by administrators only.
      ['GET', '/tracking/settings'],
      ['POST', '/tracking/keys', { label: 'Not allowed' }],
      ['POST', '/locations/buildings', { name: 'Not allowed' }],
    ])
  })

  test('management: reads reports, history and the inside list; changes nothing', async ({ open, apiAs }) => {
    const host = await apiAs('employee')
    const now = Date.now()
    const visit = await host.createVisit({ visitor: { full_name: `Board Guest ${uniqueTag()}` }, start: new Date(now + minutes(30)), end: new Date(now + minutes(90)) })

    const { page, api } = await open({ as: 'management' })
    await page.goto('/')
    await expect(page).toHaveURL(/\/reports$/)
    await expectNavigation(page, ['Visitors', 'Inside now', 'Visitor Journey', 'Visit history', 'Reports'])
    await expectRedirects(page, ['/reception', '/visits', '/visits/new', '/admin', '/admin/users', '/admin/tracking'], /\/reports$/)
    // Read-only: the visit opens, without any action.
    await page.goto(`/visits/${visit.visit.id}`)
    await expect(page.getByRole('heading', { level: 1, name: visit.visit.visitor.full_name })).toBeVisible()
    for (const action of ['Edit or reschedule', 'Cancel visit', 'Resend invitation', 'Send invitation', 'Issue a new pass link']) {
      await expect(page.getByRole('button', { name: action })).toHaveCount(0)
    }
    await page.goto(`/visitors/${visit.visit.visitor.id}`)
    await expect(page.getByRole('heading', { level: 1, name: visit.visit.visitor.full_name })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit visitor' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Invite again' })).toHaveCount(0)

    await expectForbidden(api, [
      ['POST', `/visits/${visit.visit.id}/cancel`, { reason: 'Not allowed' }],
      ['PATCH', `/visits/${visit.visit.id}`, { purpose: 'Changed' }],
      ['POST', `/visits/${visit.visit.id}/check-in`, { method: 'MANUAL' }],
      ['POST', `/visits/${visit.visit.id}/invitation`],
      ['PATCH', `/visitors/${visit.visit.visitor.id}`, { company_name: 'Changed' }],
      ['POST', '/reception/scan', { token: 'x'.repeat(43) }],
      ['POST', '/reception/check-out-stale', { reason: 'Not allowed' }],
      ['GET', '/audit-logs'],
      ['GET', '/users'],
      // Phase 15: management reads journeys, and neither starts nor stops one, nor sets tracking up.
      ['POST', `/visits/${visit.visit.id}/tracking/enroll`, { camera_id: visit.visit.id }],
      ['POST', `/visits/${visit.visit.id}/tracking/revoke`],
      ['PATCH', '/tracking/settings', { enabled: false }],
    ])
    expect((await host.visit(visit.visit.id)).status).toBe('SCHEDULED')
  })

  test('administrator: every section is offered and opens', async ({ open }) => {
    const { page } = await open({ as: 'admin' })
    await page.goto('/')
    await expect(page).toHaveURL(/\/admin$/)
    await expectNavigation(page, ALL_LINKS)
    for (const [path, heading] of [
      ['/admin/users', 'Users'],
      ['/admin/departments', 'Departments'],
      ['/admin/settings', 'Company settings'],
      ['/admin/audit', 'Audit log'],
      ['/admin/email-templates', 'Email texts'],
      ['/reception', 'Reception'],
      ['/reports', 'Reports'],
      ['/history', 'Visit history'],
      ['/inside', 'Inside now'],
      ['/journey', 'Visitor Journey'],
      ['/admin/tracking', 'Visitor tracking'],
      ['/visits', 'My visits'],
      ['/visits/new', 'Invite visitor'],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    }
  })
})
