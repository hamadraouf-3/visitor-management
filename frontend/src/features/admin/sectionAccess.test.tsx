import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../test/appRoutes'
import { jsonResponse, makeMe, mockApi } from '../../test/api'
import { myVisitsRoutes } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { Role } from '../../types/api'
import { historyRoutes } from '../history/testRoutes'
import { insideRoutes } from '../inside/testRoutes'
import { reportsRoutes } from '../reports/testRoutes'
import { adminDashboardRoutes } from './testRoutes'

/**
 * Who sees the history, evacuation list, reports and administration (§7.5, §10). The UI only
 * hides and redirects; the backend enforces every permission.
 */
function signedInAs(roles: Role[]) {
  return mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(roles)),
    ...myVisitsRoutes(),
    ...historyRoutes(),
    ...insideRoutes(),
    ...reportsRoutes(),
    ...adminDashboardRoutes(),
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

  it.each(['/history', '/inside', '/reports', '/admin/audit'])('sends an employee from %s to My visits', async (path) => {
    signedInAs(['EMPLOYEE'])
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
