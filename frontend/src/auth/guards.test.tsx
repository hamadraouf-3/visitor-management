import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiRequest } from '../api/client'
import { queryKeys } from '../api/queryKeys'
import { routes } from '../test/appRoutes'
import { COMPANY_SIGN_IN, errorResponse, jsonResponse, makeMe, mockApi, noContent, NOT_AUTHENTICATED, publicBrandRoute } from '../test/api'
import { adminDashboardRoutes } from '../features/admin/testRoutes'
import { receptionRoutes } from '../features/reception/testing/receptionFixtures'
import { reportsRoutes } from '../features/reports/testRoutes'
import { myVisitsRoutes, visitorsRoutes } from '../test/fixtures'
import { renderRoutes } from '../test/render'
import type { Role } from '../types/api'

function signedInAs(roles: Role[], overrides: Parameters<typeof makeMe>[1] = {}) {
  // Every landing page loads data on mount (§10 landing by role priority).
  return mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(roles, overrides)),
    ...myVisitsRoutes(),
    ...visitorsRoutes(),
    ...receptionRoutes(),
    ...adminDashboardRoutes(),
    ...reportsRoutes(),
  })
}

describe('RequireAuth', () => {
  it('redirects unauthenticated users to /login with a next parameter', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    const { router } = renderRoutes(routes, { initialEntries: ['/visits?tab=past'] })

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toBe('?next=%2Fvisits%3Ftab%3Dpast')
  })

  it('forces a pending password change before anything else', async () => {
    signedInAs(['EMPLOYEE'], { must_change_password: true })
    const { router } = renderRoutes(routes, { initialEntries: ['/visits'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/change-password')
    expect(screen.getByText('Choose a new password to continue')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
  })

  it('offers a retry when the session cannot be checked', async () => {
    mockApi({ 'GET /auth/me': () => errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') })
    renderRoutes(routes, { initialEntries: ['/visits'] })

    expect(await screen.findByText('We could not load your session')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('landing by role priority', () => {
  it.each([
    [['RECEPTIONIST', 'EMPLOYEE'], '/reception', 'Reception'],
    [['SYSTEM_ADMIN', 'EMPLOYEE'], '/admin', 'Admin dashboard'],
    [['EMPLOYEE', 'MANAGEMENT'], '/visits', 'My visits'],
    [['MANAGEMENT'], '/reports', 'Reports'],
  ] as [Role[], string, string][])('sends %j from / to %s', async (roles, path, heading) => {
    signedInAs(roles)
    const { router } = renderRoutes(routes, { initialEntries: ['/'] })

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(path)
  })
})

describe('RequireRole', () => {
  it('redirects users without a matching role to their landing page', async () => {
    signedInAs(['EMPLOYEE'])
    const { router } = renderRoutes(routes, { initialEntries: ['/admin/users'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
  })

  it('grants access when any of the user’s roles matches', async () => {
    signedInAs(['MANAGEMENT'])
    const { router } = renderRoutes(routes, { initialEntries: ['/history'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visit history' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/history')
  })

  it('shows only the navigation sections the roles allow', async () => {
    signedInAs(['EMPLOYEE'])
    renderRoutes(routes, { initialEntries: ['/visits'] })

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(links).toEqual(['My visits', 'Invite visitor', 'Visitors'])
    expect(within(nav).getByRole('link', { name: 'My visits' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('global auth handling', () => {
  it('on 401 from any API call clears the cache and returns to login with next, without the search text', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      ...publicBrandRoute(),
      ...visitorsRoutes(),
      'GET /visits': NOT_AUTHENTICATED,
    })
    const { router, queryClient } = renderRoutes(routes, { initialEntries: ['/visitors?q=martin'] })
    await screen.findByRole('heading', { level: 1, name: 'Visitors' })
    queryClient.setQueryData(queryKeys.visits.list({}), { items: [], page: 1, page_size: 25, total: 0 })

    await apiRequest('/visits').catch(() => undefined)

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    // The device's own sign-in page: its company's (Phase 12).
    expect(router.state.location.pathname).toBe(COMPANY_SIGN_IN)
    // The typed search never reaches an address (SEC-20): `next` is the page alone.
    expect(router.state.location.search).toBe('?next=%2Fvisitors')
    expect(queryClient.getQueryData(queryKeys.visits.list({}))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
  })

  it('on 403 PASSWORD_CHANGE_REQUIRED goes to /change-password', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      ...visitorsRoutes(),
      'GET /visits': () => errorResponse(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.'),
    })
    const { router } = renderRoutes(routes, { initialEntries: ['/visitors'] })
    await screen.findByRole('heading', { level: 1, name: 'Visitors' })

    await apiRequest('/visits').catch(() => undefined)

    expect(await screen.findByText('Choose a new password to continue')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/change-password')
  })

  it('signs out through the API, clears every cached query and shows the login page', async () => {
    const { requests } = mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      ...publicBrandRoute(),
      ...myVisitsRoutes(),
      'POST /auth/logout': () => noContent(),
    })
    const { router, queryClient, user } = renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    queryClient.setQueryData(queryKeys.dashboard.employee, { counts: {}, today: [] })

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(COMPANY_SIGN_IN)
    expect(requests.some((request) => request.method === 'POST' && request.path === '/auth/logout')).toBe(true)
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.dashboard.employee)).toBeUndefined())
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
  })

  it('keeps the user signed in and explains when sign-out cannot reach the server', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      ...myVisitsRoutes(),
      'POST /auth/logout': () => Promise.reject(new TypeError('Failed to fetch')),
    })
    const { router, user } = renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByText('Could not sign out')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
  })
})
