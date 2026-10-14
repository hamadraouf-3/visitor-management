import { focusManager, onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_REFRESH_HEADER } from '../../api/client'
import { queryKeys } from '../../api/queryKeys'
import { SESSION_HEARTBEAT_MS } from '../../auth/useAuth'
import { routes } from '../../test/appRoutes'
import { jsonResponse, makeMe, mockApi, NOT_AUTHENTICATED, type RecordedRequest } from '../../test/api'
import { createTestQueryClient, renderRoutes } from '../../test/render'
import type { PlatformCompany } from '../../types/api'
import { makeCompanyAdmin, makePlatformCompany, makePlatformMe, platformRoutes } from './testRoutes'

/*
 * The platform session's idle timeout (30 minutes, B11-6) and the requests that count as activity.
 * The server no longer counts a platform request sent with `X-Background-Refresh: 1` (B11-34), so the
 * header must be on the session's own re-checks and on nothing the platform owner asks for: a request
 * of theirs that carried it would not keep their session alive, and a re-check without it would keep
 * an abandoned tab signed in for ever.
 */

const NOVA = makePlatformCompany()

const background = (request: RecordedRequest) => request.headers.get(BACKGROUND_REFRESH_HEADER)
const platformRequests = (requests: RecordedRequest[]) => requests.filter((request) => request.path.startsWith('/platform'))
const sessionChecks = (requests: RecordedRequest[]) => requests.filter((request) => request.path === '/platform/auth/me')

afterEach(() => {
  act(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })
  vi.useRealTimers()
})

describe('the platform session’s heartbeat', () => {
  it('takes an idle platform tab to the platform sign-in within a minute of the server ending its session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const queryClient = createTestQueryClient()
    const companyMe = makeMe(['SYSTEM_ADMIN'])
    queryClient.setQueryData(queryKeys.me, companyMe)
    let signedIn = true
    const { requests } = mockApi({
      ...platformRoutes({ companies: [NOVA] }),
      'GET /platform/auth/me': () => (signedIn ? jsonResponse(makePlatformMe()) : NOT_AUTHENTICATED()),
    })
    const { router } = renderRoutes(routes, { initialEntries: ['/platform/companies?status=active'], queryClient })
    await screen.findByRole('link', { name: 'Nova Labs' })
    expect(sessionChecks(requests)).toHaveLength(1)

    // Nobody touches the tab: the server ends the session, and the next beat finds out.
    signedIn = false
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to the platform' })).toBeInTheDocument()
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe('/platform/login?next=%2Fplatform%2Fcompanies%3Fstatus%3Dactive')
    // Nothing of the platform session is kept; the company session of the same browser is untouched.
    expect(queryClient.getQueryData(queryKeys.platform.me)).toBeNull()
    expect(queryClient.getQueriesData({ queryKey: queryKeys.platform.companies.all })).toEqual([])
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(companyMe)
    expect(screen.queryByRole('link', { name: 'Nova Labs' })).not.toBeInTheDocument()
    // The beat that found it was a background refresh.
    expect(sessionChecks(requests).map(background)).toEqual([null, '1'])
    // The sign-in page beats no more: nobody is signed in.
    await act(() => vi.advanceTimersByTimeAsync(2 * SESSION_HEARTBEAT_MS))
    expect(sessionChecks(requests)).toHaveLength(2)
  })

  it('marks only the session’s re-checks as background refreshes, never what the platform owner asks for', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let company: PlatformCompany = NOVA
    const { requests } = mockApi({
      ...platformRoutes({ companies: [NOVA] }),
      [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(company),
      [`GET /platform/companies/${NOVA.id}/admins`]: () => jsonResponse([makeCompanyAdmin()]),
      [`POST /platform/companies/${NOVA.id}/deactivate`]: () => {
        company = { ...company, is_active: false, deactivated_at: '2026-10-05T08:00:00Z' }
        return jsonResponse(company)
      },
      [`POST /platform/companies/${NOVA.id}/reactivate`]: () => {
        company = { ...company, is_active: true, deactivated_at: null }
        return jsonResponse(company)
      },
      'GET /platform/audit-logs': () => jsonResponse({ items: [], page: 1, page_size: 50, total: 0 }),
      'PATCH /platform/auth/preferences': () => jsonResponse(makePlatformMe({ preferred_language: 'ar' })),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })

    // The platform owner works: a list, a company, an action with its confirmation, the refetches it causes, another page, a setting.
    await user.click(await screen.findByRole('link', { name: 'Nova Labs' }))
    await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })
    await screen.findByRole('list', { name: 'Administrators of Nova Labs' })
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deactivate company' }))
    await user.click(await screen.findByRole('button', { name: 'Reactivate' }))
    await screen.findByRole('button', { name: 'Deactivate' })
    await user.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Audit log' }))
    await screen.findByRole('heading', { level: 1, name: 'Audit log' })
    await user.click(screen.getAllByRole('button', { name: 'العربية' })[0]!)
    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH')).toBe(true))

    const asked = platformRequests(requests)
    expect(asked.map((request) => `${request.method} ${request.path}`)).toEqual(
      expect.arrayContaining([
        'GET /platform/auth/me',
        'GET /platform/companies',
        `GET /platform/companies/${NOVA.id}`,
        `GET /platform/companies/${NOVA.id}/admins`,
        `POST /platform/companies/${NOVA.id}/deactivate`,
        `POST /platform/companies/${NOVA.id}/reactivate`,
        'GET /platform/audit-logs',
        'PATCH /platform/auth/preferences',
      ]),
    )
    // Not one of them is a background refresh: the first session check is the page's own load.
    expect(asked.filter((request) => background(request) !== null)).toEqual([])

    // The tab is left alone: two beats (one in a hidden tab), then the check when it is shown again.
    const before = requests.length
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))
    act(() => focusManager.setFocused(false))
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))
    act(() => focusManager.setFocused(true))
    await waitFor(() => expect(sessionChecks(requests.slice(before)).length).toBeGreaterThanOrEqual(3))

    // Every re-check of the session is a background refresh, and nothing else carries the header.
    const idle = platformRequests(requests.slice(before))
    expect(sessionChecks(idle).map(background)).toEqual(sessionChecks(idle).map(() => '1'))
    const marked = platformRequests(requests).filter((request) => background(request) !== null)
    expect(marked.length).toBeGreaterThanOrEqual(3)
    expect(new Set(marked.map((request) => `${request.method} ${request.path}`))).toEqual(new Set(['GET /platform/auth/me']))
  })
})
