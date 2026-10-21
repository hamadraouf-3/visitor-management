import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../test/appRoutes'
import { jsonResponse, makeMe, mockApi } from '../../test/api'
import { myVisitsRoutes } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { Role } from '../../types/api'
import { historyRoutes } from '../history/testRoutes'
import { insideRoutes } from '../inside/testRoutes'
import { journeyRoutes } from '../journey/testRoutes'
import { reportsRoutes } from '../reports/testRoutes'
import { adminDashboardRoutes } from './testRoutes'

/**
 * Who sees the history, evacuation list, reports and administration (§7.5, §10). The UI only
 * hides and redirects; the backend enforces every permission.
 */
function signedInAs(roles: Role[], { trackingAllowed = false }: { trackingAllowed?: boolean } = {}) {
  return mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(roles, {}, { tracking_allowed: trackingAllowed })),
    ...myVisitsRoutes(),
    ...historyRoutes(),
    ...insideRoutes(),
    ...reportsRoutes(),
    ...adminDashboardRoutes(),
    ...journeyRoutes(),
  })
}

async function navigationLinks() {
  const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent)
}

describe('section access by role', () => {
  it('management reads history, the evacuation list and reports, and nothing of administration', async () => {
    signedInAs(['MANAGEMENT'])
    const { router } = renderRoutes(routes, { initialEntries: ['/admin/users'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reports')
    expect(await navigationLinks()).toEqual(['Visitors', 'Inside now', 'Visit history', 'Reports'])
  })

  it('reception reads history and the evacuation list, but not reports', async () => {
    signedInAs(['RECEPTIONIST'])
    const { router } = renderRoutes(routes, { initialEntries: ['/history'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visit history' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/history')
    const links = await navigationLinks()
    expect(links).toEqual(expect.arrayContaining(['Inside now', 'Visit history']))
    expect(links).not.toContain('Reports')
    expect(links).not.toContain('Users')
  })

  // Phase 15: the Visitor Journey is for administrators, management and reception of a company whose tracking the
  // platform owner allows; a host has no tab and no page, and nobody has them while it is not allowed.
  it.each([['MANAGEMENT'], ['RECEPTIONIST'], ['SYSTEM_ADMIN']] as Role[][])('%s has the Visitor Journey tab and reaches the page while tracking is allowed', async (role) => {
    signedInAs([role], { trackingAllowed: true })
    const { router } = renderRoutes(routes, { initialEntries: ['/journey'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visitor Journey' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/journey')
    expect(await navigationLinks()).toContain('Visitor Journey')
  })

  it('gives a host (EMPLOYEE only) no Visitor Journey tab, even while tracking is allowed', async () => {
    signedInAs(['EMPLOYEE'], { trackingAllowed: true })
    renderRoutes(routes, { initialEntries: ['/visits'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(await navigationLinks()).not.toContain('Visitor Journey')
  })

  it('only administrators have Visitor tracking in the navigation', async () => {
    signedInAs(['MANAGEMENT', 'RECEPTIONIST'], { trackingAllowed: true })
    renderRoutes(routes, { initialEntries: ['/journey'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visitor Journey' })).toBeInTheDocument()
    expect(await navigationLinks()).not.toContain('Visitor tracking')
  })

  it('offers neither the Visitor Journey nor Visitor tracking while the platform owner has not allowed tracking', async () => {
    signedInAs(['SYSTEM_ADMIN', 'MANAGEMENT', 'RECEPTIONIST'])
    renderRoutes(routes, { initialEntries: ['/admin'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeInTheDocument()
    const links = await navigationLinks()
    expect(links).toContain('Inside now')
    expect(links).not.toContain('Visitor Journey')
    expect(links).not.toContain('Visitor tracking')
  })

  it.each([
    [['MANAGEMENT'], '/journey', '/reports'],
    [['SYSTEM_ADMIN'], '/journey/5a1b2c3d-0000-4000-8000-0000000000a1', '/admin'],
    [['SYSTEM_ADMIN'], '/admin/tracking', '/admin'],
  ] as [Role[], string, string][])('sends %s from %s to its landing page %s while tracking is not allowed', async (roles, path, landing) => {
    signedInAs(roles)
    const { router } = renderRoutes(routes, { initialEntries: [path] })

    await waitFor(() => expect(router.state.location.pathname).toBe(landing))
    expect(screen.queryByRole('heading', { level: 1, name: /Visitor Journey|Visitor tracking/ })).toBeNull()
  })

  it.each(['/history', '/inside', '/reports', '/admin/audit', '/journey', '/journey/5a1b2c3d-0000-4000-8000-0000000000a1', '/admin/tracking'])('sends an employee from %s to My visits', async (path) => {
    signedInAs(['EMPLOYEE'], { trackingAllowed: true })
    const { router } = renderRoutes(routes, { initialEntries: [path] })

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
  })

  it('administrators reach every section, reports included', async () => {
    signedInAs(['SYSTEM_ADMIN'])
    const { router } = renderRoutes(routes, { initialEntries: ['/reports'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reports')
    expect(await navigationLinks()).toEqual(
      expect.arrayContaining(['Inside now', 'Visit history', 'Reports', 'Dashboard', 'Users', 'Departments', 'Company settings', 'Audit log']),
    )
  })
})
