import { focusManager, onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queryKeys'
import { routes } from '../test/appRoutes'
import { COMPANY_SIGN_IN, errorResponse, jsonResponse, makeMe, mockApi, publicBrandRoute, type RecordedRequest } from '../test/api'
import { makeVisitor, myVisitsRoutes, page, VISITOR_ID } from '../test/fixtures'
import { renderRoutes } from '../test/render'
import type { Me } from '../types/api'
import { SESSION_HEARTBEAT_MS } from './useAuth'

/**
 * A session the server ended without a word to this tab must not leave the previous user's data
 * on screen: neither on a page that sends no request of its own (SEC-50: the idle timeout of a
 * screen left open on a shared device), nor on a page the browser restores from its
 * back/forward cache (SEC-51: Back after leaving the app for another page load, also offline).
 */

const OMAR: Me = makeMe(['EMPLOYEE'], { id: '7f0d1c0e-1111-4a5b-9c1d-0000000000a1', full_name: 'Omar Khalil', email: 'omar@acme.example' })
const PROFILE = `/visitors/${VISITOR_ID}`
const SECRET = makeVisitor({ full_name: 'Zainab Secretvisitor', email: 'visitor0@example.com', phone: '+962 79 111 220' })
/** The device's own sign-in page (its company's, Phase 12), with the way back to the profile. */
const LOGIN_FROM_PROFILE = `${COMPANY_SIGN_IN}?next=${encodeURIComponent(PROFILE)}`

function notAuthenticated() {
  return errorResponse(401, 'NOT_AUTHENTICATED', 'Please sign in.')
}

function requestsTo(requests: RecordedRequest[], path: string) {
  return requests.filter((request) => request.method === 'GET' && request.path === path)
}

/**
 * Omar has a visitor's profile open: a page that polls nothing. `session.me` is who the server
 * says the session cookie belongs to (null: the session ended, and every request is answered 401).
 */
function omarOnAProfile(initialEntries: string[] = [PROFILE]) {
  const session = { me: OMAR as Me | null }
  const signedIn = (body: () => Response) => () => (session.me ? body() : notAuthenticated())
  const api = mockApi({
    'GET /auth/me': () => (session.me ? jsonResponse(session.me) : notAuthenticated()),
    ...publicBrandRoute(),
    [`GET ${PROFILE}`]: signedIn(() => jsonResponse(SECRET)),
    [`GET ${PROFILE}/visits`]: signedIn(() => jsonResponse(page([], { page_size: 20 }))),
    ...myVisitsRoutes(),
  })
  return { session, ...api, ...renderRoutes(routes, { initialEntries }) }
}

async function profileShown() {
  await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
  expect(screen.getByText('visitor0@example.com')).toBeInTheDocument()
}

/** Nothing of Omar's session is on screen: not the visitor, not his name in the account menu. */
function expectNothingOfTheSession() {
  expect(document.body).not.toHaveTextContent('Zainab')
  expect(document.body).not.toHaveTextContent('visitor0@example.com')
  expect(document.body).not.toHaveTextContent('+962 79 111 220')
  expect(screen.queryByRole('button', { name: 'Account menu for Omar Khalil' })).toBeNull()
}

/** The browser shows this document again from its back/forward cache (or, `persisted: false`, a normal load). */
function pageShow(persisted: boolean) {
  act(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted }))
  })
}

afterEach(() => {
  act(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })
  vi.useRealTimers()
})

describe('the session heartbeat (SEC-50)', () => {
  it('takes a page that sends nothing to the sign-in page within a minute of the server ending its session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { session, requests, router, queryClient } = omarOnAProfile()
    await profileShown()
    const checks = requestsTo(requests, '/auth/me').length

    // The idle timeout (or deactivation, a password reset elsewhere): the server ends the session.
    session.me = null
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(LOGIN_FROM_PROFILE)
    expectNothingOfTheSession()
    expect(queryClient.getQueryData(queryKeys.visitors.detail(VISITOR_ID))).toBeUndefined()
    // The heartbeat found it, as a background refresh.
    expect(requestsTo(requests, '/auth/me')).toHaveLength(checks + 1)
    expect(requestsTo(requests, '/auth/me')[checks]?.headers.get('X-Background-Refresh')).toBe('1')
  })

  it('never keeps an idle session alive: only the first check is the user’s own request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { requests } = omarOnAProfile()
    await profileShown()
    expect(requestsTo(requests, '/auth/me')).toHaveLength(1)

    // Two beats, the second in a hidden tab, then the check when the tab is shown again.
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))
    await waitFor(() => expect(requestsTo(requests, '/auth/me')).toHaveLength(2))
    act(() => focusManager.setFocused(false))
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))
    await waitFor(() => expect(requestsTo(requests, '/auth/me')).toHaveLength(3))
    act(() => focusManager.setFocused(true))
    await waitFor(() => expect(requestsTo(requests, '/auth/me')).toHaveLength(4))

    const headers = requestsTo(requests, '/auth/me').map((request) => request.headers.get('X-Background-Refresh'))
    expect(headers).toEqual([null, '1', '1', '1'])
    expect(screen.getByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })).toBeInTheDocument()
  })

  it('beats once a minute per tab, however many parts of the page read the session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { requests } = omarOnAProfile()
    await profileShown()
    const checks = requestsTo(requests, '/auth/me').length

    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS))
    await waitFor(() => expect(requestsTo(requests, '/auth/me')).toHaveLength(checks + 1))
    await act(() => vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_MS / 2))
    expect(requestsTo(requests, '/auth/me')).toHaveLength(checks + 1)
  })

  it('sends nothing while signed out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { requests } = mockApi({ 'GET /auth/me': () => notAuthenticated() })
    renderRoutes(routes, { initialEntries: ['/login'] })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await waitFor(() => expect(requestsTo(requests, '/auth/me')).toHaveLength(1))

    await act(() => vi.advanceTimersByTimeAsync(3 * SESSION_HEARTBEAT_MS))
    expect(requestsTo(requests, '/auth/me')).toHaveLength(1)
  })

  it('sends nothing while no user is known (the session check failed)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { requests } = mockApi({ 'GET /auth/me': () => errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong.') })
    renderRoutes(routes, { initialEntries: [PROFILE] })
    expect(await screen.findByText('We could not load your session')).toBeInTheDocument()
    const checks = requestsTo(requests, '/auth/me').length

    // "Try again" is the person's to press.
    await act(() => vi.advanceTimersByTimeAsync(3 * SESSION_HEARTBEAT_MS))
    expect(requestsTo(requests, '/auth/me')).toHaveLength(checks)
  })
})

describe('a page restored from the back/forward cache (SEC-51)', () => {
  it('shows nothing of the session until the server answers, also offline, then signs in again', async () => {
    const { session, requests, router, queryClient } = omarOnAProfile()
    await profileShown()

    // The session ended while the document sat in the cache; the next person presses Back with
    // the device offline, so the check of the session cannot be answered.
    session.me = null
    act(() => onlineManager.setOnline(false))
    pageShow(true)

    expect(await screen.findByText('Checking your session…')).toBeInTheDocument()
    expectNothingOfTheSession()
    // Nothing is left to reach through the page's links either.
    expect(queryClient.getQueryData(queryKeys.visitors.detail(VISITOR_ID))).toBeUndefined()
    expect(queryClient.getQueryCache().findAll().every((query) => query.state.data === undefined)).toBe(true)
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(screen.getByText('Checking your session…')).toBeInTheDocument()
    expectNothingOfTheSession()

    // Back online: the server says the session has ended.
    const checks = requestsTo(requests, '/auth/me').length
    act(() => onlineManager.setOnline(true))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(LOGIN_FROM_PROFILE)
    expect(requestsTo(requests, '/auth/me').length).toBeGreaterThan(checks)
    expectNothingOfTheSession()
  })

  it('lets the same user carry on, from data loaded again', async () => {
    const { requests, router } = omarOnAProfile()
    await profileShown()
    const loads = requestsTo(requests, PROFILE).length

    pageShow(true)

    await profileShown()
    expect(router.state.location.pathname).toBe(PROFILE)
    expect(requestsTo(requests, PROFILE).length).toBeGreaterThan(loads)
  })

  it('leaves a page shown by a normal load as it is', async () => {
    const { requests } = omarOnAProfile()
    await profileShown()
    const checks = requestsTo(requests, '/auth/me').length

    pageShow(false)

    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(requestsTo(requests, '/auth/me')).toHaveLength(checks)
    expect(screen.getByText('visitor0@example.com')).toBeInTheDocument()
  })

  it('leaves a restored sign-in page as it is', async () => {
    const { requests } = mockApi({ 'GET /auth/me': () => notAuthenticated() })
    renderRoutes(routes, { initialEntries: ['/login'] })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await waitFor(() => expect(requestsTo(requests, '/auth/me')).toHaveLength(1))

    pageShow(true)

    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(requestsTo(requests, '/auth/me')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })
})
