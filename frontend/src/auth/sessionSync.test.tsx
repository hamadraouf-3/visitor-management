import { focusManager } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queryKeys'
import { routes } from '../test/appRoutes'
import { COMPANY_SIGN_IN, errorResponse, jsonResponse, makeMe, mockApi, noContent, publicBrandRoute, type RecordedRequest } from '../test/api'
import { makeVisitor, myVisitsRoutes, page, VISITOR_ID } from '../test/fixtures'
import { createTestQueryClient, renderRoutes } from '../test/render'
import type { Me } from '../types/api'
import { broadcastAuthChange, subscribeToAuthChanges, type AuthChange } from './authSync'

const OMAR: Me = makeMe(['EMPLOYEE'], { id: '7f0d1c0e-1111-4a5b-9c1d-0000000000a1', full_name: 'Omar Khalil', email: 'omar@acme.example' })
const LINA: Me = makeMe(['EMPLOYEE'], { id: '7f0d1c0e-1111-4a5b-9c1d-0000000000b2', full_name: 'Lina Saleh', email: 'lina@acme.example' })
const PROFILE = `/visitors/${VISITOR_ID}`
const SECRET = makeVisitor({ full_name: 'Zainab Secretvisitor', email: 'visitor0@example.com', phone: '+962 79 111 220' })

/** Another tab of the same browser: its own channel object. */
function otherTab() {
  const channel = new BroadcastChannel('vms-auth')
  const received: unknown[] = []
  channel.addEventListener('message', (event) => received.push(event.data))
  return {
    received,
    // BroadcastChannel.postMessage has no target origin (a channel is same-origin by definition).
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    send: (change: AuthChange) => channel.postMessage(change),
    close: () => channel.close(),
  }
}

function notAuthenticated() {
  return errorResponse(401, 'NOT_AUTHENTICATED', 'Please sign in.')
}

function meRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/auth/me')
}

/**
 * Omar has a visitor's profile open. The session cookie is shared by every tab: `session.me` is
 * who the server says the cookie belongs to, `session.visible` whether the visitor is in that
 * user's scope.
 */
function omarOnAProfile(initialEntries: string[] = [PROFILE]) {
  const session = { me: OMAR as Me | null, visible: true }
  const api = mockApi({
    'GET /auth/me': () => (session.me ? jsonResponse(session.me) : notAuthenticated()),
    ...publicBrandRoute(),
    // Without a session the server answers 401. A page of the previous user that re-renders
    // before it is replaced may fetch again (seen under load); it must not get the visitor back.
    [`GET ${PROFILE}`]: () =>
      !session.me ? notAuthenticated() : session.visible ? jsonResponse(SECRET) : errorResponse(404, 'NOT_FOUND', 'The requested item was not found.'),
    [`GET ${PROFILE}/visits`]: () =>
      !session.me
        ? notAuthenticated()
        : session.visible
          ? jsonResponse(page([], { page_size: 20 }))
          : errorResponse(404, 'NOT_FOUND', 'The requested item was not found.'),
    'POST /auth/logout': () => noContent(),
    ...myVisitsRoutes(),
  })
  return { session, ...api, ...renderRoutes(routes, { initialEntries }) }
}

describe('sessions across tabs (SEC-26)', () => {
  const tabs: ReturnType<typeof otherTab>[] = []
  afterEach(() => {
    for (const tab of tabs.splice(0)) tab.close()
    act(() => focusManager.setFocused(undefined))
  })

  it('signs this tab out when another tab signs out', async () => {
    const { session, router, queryClient } = omarOnAProfile()
    await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
    const other = otherTab()
    tabs.push(other)

    session.me = null
    other.send('signed-out')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    // No `next`: the next person to sign in here may be someone else.
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(COMPANY_SIGN_IN)
    expect(queryClient.getQueryData(queryKeys.visitors.detail(VISITOR_ID))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
    expect(document.body).not.toHaveTextContent('visitor0@example.com')
  })

  it('drops the previous user’s data when another tab signs in as someone else', async () => {
    // Omar opened the profile, then its second page.
    const { session, router, queryClient } = omarOnAProfile([PROFILE, `${PROFILE}?page=2`])
    await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
    expect(screen.getAllByRole('button', { name: 'Account menu for Omar Khalil' }).length).toBeGreaterThan(0)
    const other = otherTab()
    tabs.push(other)

    // Omar signed out and Lina signed in in the other tab; Lina may not see this visitor.
    session.me = LINA
    session.visible = false
    other.send('signed-in')

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
    expect(screen.getAllByRole('button', { name: 'Account menu for Lina Saleh' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Account menu for Omar Khalil' })).toBeNull()
    expect(document.body).not.toHaveTextContent('visitor0@example.com')
    expect(queryClient.getQueryData(queryKeys.visitors.detail(VISITOR_ID))).toBeUndefined()

    // Back to the profile's first page: nothing of Omar's comes back, the server answers for Lina.
    await act(() => router.navigate(-1))
    expect(router.state.location.pathname).toBe(PROFILE)
    expect(await screen.findByRole('heading', { level: 1, name: 'Visitor not found' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Zainab')
  })

  it('clears the cache of a tab on a public page but leaves the page as it is', async () => {
    mockApi({})
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.me, OMAR)
    queryClient.setQueryData(queryKeys.visitors.detail(VISITOR_ID), SECRET)
    const { router } = renderRoutes(routes, { initialEntries: ['/pass'], queryClient })
    await screen.findByRole('heading', { level: 1 })
    const other = otherTab()
    tabs.push(other)

    other.send('signed-out')

    await waitFor(() => expect(queryClient.getQueryData(queryKeys.me)).toBeNull())
    expect(queryClient.getQueryData(queryKeys.visitors.detail(VISITOR_ID))).toBeUndefined()
    expect(router.state.location.pathname).toBe('/pass')
  })

  it('stays where it is when the same user signs in again in another tab', async () => {
    const { requests, router } = omarOnAProfile()
    await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
    const other = otherTab()
    tabs.push(other)
    const before = meRequests(requests).length

    other.send('signed-in')

    await waitFor(() => expect(meRequests(requests).length).toBe(before + 1))
    expect(router.state.location.pathname).toBe(PROFILE)
    expect(screen.getByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })).toBeInTheDocument()
  })

  it('checks who is signed in each time the tab is shown again, and drops another user’s data', async () => {
    const { session, requests, router } = omarOnAProfile()
    await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
    const before = meRequests(requests).length

    // A message this tab missed: Lina signed in elsewhere while this tab was hidden.
    session.me = LINA
    session.visible = false
    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(meRequests(requests).length).toBeGreaterThan(before)
    expect(router.state.location.pathname).toBe('/visits')
    expect(document.body).not.toHaveTextContent('visitor0@example.com')
  })

  it('takes a refused refetch’s data off the screen', async () => {
    const { session, queryClient } = omarOnAProfile()
    await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
    expect(screen.getByText('visitor0@example.com')).toBeInTheDocument()

    // The visitor left this user's scope (or the cookie is someone else's): the refetch is refused.
    session.visible = false
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.visitors.all }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Visitor not found' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('visitor0@example.com')
    expect(queryClient.getQueryData(queryKeys.visitors.detail(VISITOR_ID))).toBeUndefined()
  })

  it('tells the other tabs when this tab signs out', async () => {
    const { user } = omarOnAProfile()
    await screen.findByRole('heading', { level: 1, name: 'Zainab Secretvisitor' })
    const other = otherTab()
    tabs.push(other)

    await user.click(screen.getAllByRole('button', { name: 'Account menu for Omar Khalil' })[0]!)
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await waitFor(() => expect(other.received).toEqual(['signed-out']))
  })

  it('tells the other tabs when this tab signs in', async () => {
    mockApi({
      'GET /auth/me': () => errorResponse(401, 'NOT_AUTHENTICATED', 'Please sign in.'),
      'POST /auth/login': () => jsonResponse(OMAR),
      ...myVisitsRoutes(),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    const other = otherTab()
    tabs.push(other)

    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'omar@acme.example')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    await waitFor(() => expect(other.received).toEqual(['signed-in']))
  })
})

describe('authSync without BroadcastChannel', () => {
  it('uses a storage event that leaves nothing in storage', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listener = vi.fn<(change: AuthChange) => void>()
    const unsubscribe = subscribeToAuthChanges(listener)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    // Another tab's change arrives as a storage event.
    window.dispatchEvent(new StorageEvent('storage', { key: 'vms-auth-change', newValue: JSON.stringify({ change: 'signed-out', id: '1' }) }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'vms-auth-change', newValue: null }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: JSON.stringify({ change: 'signed-in' }) }))
    expect(listener.mock.calls).toEqual([['signed-out']])

    // This tab's change is written for the other tabs and removed at once.
    broadcastAuthChange('signed-in')
    expect(setItem).toHaveBeenCalledWith('vms-auth-change', expect.stringContaining('"change":"signed-in"'))
    expect(window.localStorage.getItem('vms-auth-change')).toBeNull()

    unsubscribe()
    window.dispatchEvent(new StorageEvent('storage', { key: 'vms-auth-change', newValue: JSON.stringify({ change: 'signed-in', id: '2' }) }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
