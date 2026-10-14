import { focusManager, onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insideVisit, makeInside, makeSettings, makeToday, RECEPTION_NOW, RECEPTIONIST } from '../features/reception/testing/receptionFixtures'
import { routes } from '../test/appRoutes'
import { COMPANY_SIGN_IN, errorResponse, jsonResponse, makeMe, mockApi, noContent, publicBrandRoute, type RouteHandler } from '../test/api'
import { myVisitsRoutes } from '../test/fixtures'
import { findAlert, renderRoutes } from '../test/render'
import type { Me } from '../types/api'
import type { AuthChange } from './authSync'

/**
 * SEC-41: toasts outlive pages (the provider is above the router), and an error toast stays until
 * dismissed. A refused one-tap check-out names the visitor, so on a shared reception tablet the
 * name stayed on the sign-in screen and into the next user's session. Every change of who is
 * signed in now removes every toast.
 */

const VISITOR = 'Zainab Haddad-Secret'
const REFUSED = `${VISITOR} was not checked out`
const LINA: Me = makeMe(['EMPLOYEE'], { id: '7f0d1c0e-1111-4a5b-9c1d-0000000000b2', full_name: 'Lina Saleh', email: 'lina@acme.example' })
const VISIT = insideVisit({ visitor: { id: 'v-secret', full_name: VISITOR, company_name: 'Northwind' } })
const NOT_AUTHENTICATED = () => errorResponse(401, 'NOT_AUTHENTICATED', 'Please sign in.')

/**
 * A receptionist on the Inside tab of a shared tablet. `session.me` is who the session cookie
 * belongs to (null: no session); `session.checkOut` answers the one-tap check-out.
 */
function receptionTablet() {
  const session: { me: Me | null; checkOut: RouteHandler } = {
    me: RECEPTIONIST,
    // A colleague checked the visitor out a moment ago.
    checkOut: () => errorResponse(409, 'VISIT_COMPLETED', 'The visitor has already checked out.'),
  }
  const whileSignedIn = (handler: RouteHandler): RouteHandler => (request) => (session.me ? handler(request) : NOT_AUTHENTICATED())
  const api = mockApi({
    'GET /auth/me': () => (session.me ? jsonResponse(session.me) : NOT_AUTHENTICATED()),
    ...publicBrandRoute(),
    'GET /reception/today': whileSignedIn(() => jsonResponse(makeToday({ inside: [VISIT] }))),
    'GET /reception/inside': whileSignedIn(() => jsonResponse(makeInside([VISIT]))),
    'GET /company/settings': whileSignedIn(() => jsonResponse(makeSettings())),
    [`POST /visits/${VISIT.id}/check-out`]: (request) => session.checkOut(request),
    'POST /auth/logout': () => {
      session.me = null
      return noContent()
    },
    'POST /auth/login': () => {
      session.me = LINA
      return jsonResponse(LINA)
    },
    ...myVisitsRoutes(),
  })
  return { session, ...api, ...renderRoutes(routes, { initialEntries: ['/reception?tab=inside'] }) }
}

/** The receptionist's one-tap check-out of the visitor, refused: the error toast names them. */
async function refusedCheckOut(user: ReturnType<typeof receptionTablet>['user']) {
  const item = (await screen.findByText(VISITOR)).closest('li') as HTMLElement
  await user.click(within(item).getByRole('button', { name: 'Check out' }))
  await findAlert(REFUSED)
}

/** The toast region is empty (its two live regions stay), and the visitor's name is nowhere. */
async function expectNoToastOfThePreviousSession() {
  await waitFor(() => expect(document.querySelector('[data-toast-region]')?.textContent).toBe(''))
  expect(document.body).not.toHaveTextContent(VISITOR)
}

/** Another tab of the same browser: its own channel object. */
function otherTab() {
  const channel = new BroadcastChannel('vms-auth')
  return {
    // BroadcastChannel.postMessage has no target origin (a channel is same-origin by definition).
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    send: (change: AuthChange) => channel.postMessage(change),
    close: () => channel.close(),
  }
}

describe('toasts end with the session (SEC-41)', () => {
  const tabs: ReturnType<typeof otherTab>[] = []
  beforeEach(() => {
    // 09:10 Amman: the visitor checked in at 09:02, so Check out is one tap.
    vi.useFakeTimers({ now: RECEPTION_NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    for (const tab of tabs.splice(0)) tab.close()
    act(() => {
      focusManager.setFocused(undefined)
      onlineManager.setOnline(true)
    })
    vi.useRealTimers()
  })

  it('removes the toast at sign-out, and the next user never sees it', async () => {
    const { user, router } = receptionTablet()
    await refusedCheckOut(user)

    await user.click(screen.getAllByRole('button', { name: 'Account menu for Rana Saleh' })[0]!)
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await expectNoToastOfThePreviousSession()

    // An employee outside that visitor's scope signs in on the same tablet.
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'lina@acme.example')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
    await expectNoToastOfThePreviousSession()
  })

  it('removes the toast when the session ended on the server (401)', async () => {
    const { user, session, router } = receptionTablet()
    await refusedCheckOut(user)

    // Idle timeout, deactivation or a revoked session: the next request is answered 401.
    session.me = null
    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(COMPANY_SIGN_IN)
    await expectNoToastOfThePreviousSession()
  })

  it('removes the toast when another tab signs out', async () => {
    const { user, session } = receptionTablet()
    await refusedCheckOut(user)
    const other = otherTab()
    tabs.push(other)

    session.me = null
    other.send('signed-out')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await expectNoToastOfThePreviousSession()
  })

  it('removes the toast when another tab signs in as someone else', async () => {
    const { user, session } = receptionTablet()
    await refusedCheckOut(user)
    const other = otherTab()
    tabs.push(other)

    session.me = LINA
    other.send('signed-in')

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    await expectNoToastOfThePreviousSession()
  })

  it('removes the toast when the page comes back from the back/forward cache, also offline (SEC-51)', async () => {
    const { user, session, router } = receptionTablet()
    await refusedCheckOut(user)

    // The session ended while the page sat in the browser's cache; Back on an offline tablet.
    session.me = null
    act(() => onlineManager.setOnline(false))
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })

    expect(await screen.findByText('Checking your session…')).toBeInTheDocument()
    await expectNoToastOfThePreviousSession()

    act(() => onlineManager.setOnline(true))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(COMPANY_SIGN_IN)
    await expectNoToastOfThePreviousSession()
  })

  it('shows no toast for a check-out refused because the session had already ended', async () => {
    const { user, session, router } = receptionTablet()
    await screen.findByText(VISITOR)

    // The session ended between two polls; the receptionist's tap is the first request to learn it.
    session.me = null
    session.checkOut = NOT_AUTHENTICATED
    const item = screen.getByText(VISITOR).closest('li') as HTMLElement
    await user.click(within(item).getByRole('button', { name: 'Check out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(COMPANY_SIGN_IN)
    // The request's error arrives after the session ended: its toast does not stay.
    await expectNoToastOfThePreviousSession()
  })

  it('keeps the toast when the session is checked again and is still the same user', async () => {
    const { user, requests } = receptionTablet()
    await refusedCheckOut(user)
    const before = requests.filter((request) => request.path === '/auth/me').length

    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))

    await waitFor(() => expect(requests.filter((request) => request.path === '/auth/me').length).toBeGreaterThan(before))
    expect(await findAlert(REFUSED)).toHaveTextContent('The visitor has already checked out.')
  })
})
