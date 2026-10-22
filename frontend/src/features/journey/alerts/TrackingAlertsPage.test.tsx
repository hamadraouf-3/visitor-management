import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../../i18n'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest, type RouteHandler } from '../../../test/api'
import { routes } from '../../../test/appRoutes'
import { renderRoutes } from '../../../test/render'
import type { Role, TrackingAlert } from '../../../types/api'
import { alertSummaryRoute, FLOOR_4_PLACE, makeAlert, makeTrackedMe, makeTrackingStatus, otherVisit, PLACE, SERVER_PLACE, VISIT_ID } from '../testRoutes'

/** 12:00 in Amman. */
const NOW = new Date('2026-10-20T09:00:00Z')

function alertRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/tracking/alerts')
}

function alertPage(items: TrackingAlert[], total = items.length) {
  return { items, page: 1, page_size: 20, total }
}

/** The server's list: the Active tab leaves a resolved alert out (scope=active), the day's keeps it. */
function serverList(alerts: () => TrackingAlert[]): RouteHandler {
  return ({ url }) => {
    const items = alerts().filter((alert) => url.searchParams.get('scope') === 'day' || alert.status !== 'RESOLVED')
    return jsonResponse(alertPage(items))
  }
}

function setup({
  roles = ['RECEPTIONIST'] as Role[],
  alerts = () => jsonResponse(alertPage([makeAlert()])),
  status = () => jsonResponse(makeTrackingStatus()),
  extra = {},
  path = '/journey/alerts',
  language = null,
}: { roles?: Role[]; alerts?: RouteHandler; status?: RouteHandler; extra?: Record<string, RouteHandler>; path?: string; language?: 'ar' | null } = {}) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeTrackedMe(roles, { preferred_language: language })),
    'GET /tracking/status': status,
    'GET /tracking/alerts': alerts,
    ...alertSummaryRoute(),
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(async () => {
  vi.useRealTimers()
  await i18n.changeLanguage('en')
})

describe('Tracking alerts: the page', () => {
  it('lists the active alerts: the visitor, the type and the status, the host, where, since, how often, the allowed floors, Simulated once', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const moved = makeAlert({ id: 'a2', visit: otherVisit(2, 'Omar Saleh', 'Atlas Freight'), type: 'RESTRICTED_AREA', first_location: FLOOR_4_PLACE, last_location: SERVER_PLACE, observations: 5, note: 'Called the host' })
    const { requests } = setup({ alerts: () => jsonResponse(alertPage([makeAlert(), moved])) })

    expect(await screen.findByRole('heading', { level: 1, name: 'Tracking alerts' })).toBeInTheDocument()
    const maya = await screen.findByRole('article', { name: 'Maya Odeh' })
    expect(Object.fromEntries(alertRequests(requests).at(-1)!.url.searchParams)).toEqual({ scope: 'active', page: '1', page_size: '20' })
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true')
    expect(maya).toHaveTextContent('Cedar Advisory')
    expect(maya.querySelector('[data-alert-type]')).toHaveTextContent('Unauthorized area')
    expect(maya.querySelector('[data-alert-status]')).toHaveTextContent('Open')
    expect(maya).toHaveTextContent('HostOmar Khalil')
    expect(maya.querySelector('[data-alert-where]')).toHaveTextContent('Floor 4,Open officeNorth Tower')
    expect(maya).toHaveTextContent('Since11:50')
    expect(maya).toHaveTextContent('Last seen11:56')
    expect(maya).toHaveTextContent('Observations2')
    expect(maya).toHaveTextContent('Allowed floorsFloor 3')
    expect(within(maya).getByRole('link', { name: 'Open journey' })).toHaveAttribute('href', `/journey/${VISIT_ID}`)

    const omar = screen.getByRole('article', { name: 'Omar Saleh' })
    expect(omar.querySelector('[data-alert-type]')).toHaveTextContent('Restricted area')
    // Where it opened, then where the visitor was seen last; the restricted zone marked; the building once.
    expect(omar.querySelector('[data-alert-where]')).toHaveTextContent('Floor 4,Open office to Floor 4,Server roomRestrictedNorth Tower')
    expect(omar).toHaveTextContent('NoteCalled the host')
    expect(document.querySelectorAll('main [data-simulated]')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Tracking' }).querySelector('[data-simulated]')).not.toBeNull()
  })

  it('lists a day’s alerts, any status, with the day in the address', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const resolved = makeAlert({ status: 'RESOLVED', resolution: 'RETURNED', resolved_at: '2026-10-19T09:30:00Z', resolved_by: null, can_act: false })
    const { requests, router, user } = setup({ alerts: () => jsonResponse(alertPage([resolved])) })
    await screen.findByRole('article', { name: 'Maya Odeh' })

    await user.click(screen.getByRole('tab', { name: 'By day' }))
    await waitFor(() => expect(Object.fromEntries(alertRequests(requests).at(-1)!.url.searchParams)).toEqual({ scope: 'day', page: '1', page_size: '20' }))
    expect(router.state.location.search).toBe('?scope=day')

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-19' } })
    await waitFor(() => expect(alertRequests(requests).at(-1)!.url.searchParams.get('day')).toBe('2026-10-19'))
    expect(router.state.location.search).toBe('?scope=day&day=2026-10-19')
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    expect(card.querySelector('[data-alert-status]')).toHaveTextContent('Resolved')
    expect(card).toHaveTextContent('ResolvedReturned to an allowed area')
    expect(card).toHaveTextContent('Automatically, Mon, 19 Oct 2026, 12:30')
    expect(within(card).queryByRole('button', { name: 'Resolve' })).toBeNull()
  })

  it('acknowledges an open alert with a note, then resolves it', async () => {
    let current = makeAlert()
    const answer = (next: TrackingAlert) => {
      current = next
      return jsonResponse(next)
    }
    const { requests, user } = setup({
      alerts: () => jsonResponse(alertPage([current])),
      extra: {
        [`POST /tracking/alerts/${current.id}/acknowledge`]: () => answer({ ...current, status: 'ACKNOWLEDGED', acknowledged_at: '2026-10-20T08:59:00Z', acknowledged_by: { id: 'u1', full_name: 'Lina Haddad' }, note: 'On it' }),
        [`POST /tracking/alerts/${current.id}/resolve`]: () => answer({ ...current, status: 'RESOLVED', resolution: 'MANUAL', resolved_at: '2026-10-20T09:00:00Z', resolved_by: { id: 'u1', full_name: 'Lina Haddad' }, can_act: false }),
      },
    })
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    await user.click(within(card).getByRole('button', { name: 'Acknowledge' }))
    let dialog = await screen.findByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), 'On it')
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(card.querySelector('[data-alert-status]')).toHaveTextContent('Acknowledged'))
    expect(requests.filter((request) => request.method === 'POST').map((request) => [request.path, request.body])).toEqual([[`/tracking/alerts/${current.id}/acknowledge`, { note: 'On it' }]])
    expect(await screen.findByText('Alert acknowledged')).toBeInTheDocument()
    expect(card).toHaveTextContent('Acknowledged\u2068Lina Haddad\u2069')
    // The focus goes on to the action left.
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Resolve' })).toHaveFocus())

    await user.click(within(card).getByRole('button', { name: 'Resolve' }))
    dialog = await screen.findByRole('dialog', { name: 'Resolve the alert for Maya Odeh?' })
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(card.querySelector('[data-alert-status]')).toHaveTextContent('Resolved'))
    expect(requests.filter((request) => request.method === 'POST').at(-1)!.body).toEqual({ note: null })
    expect(card).toHaveTextContent('Resolved by staff')
  })

  it('resolves on the Active tab: the card leaves, the focus goes on to the next card’s action, else to the heading (F16-34)', async () => {
    const omar = makeAlert({ id: 'a1e00000-0000-4000-8000-000000000002', visit: otherVisit(2, 'Omar Saleh'), opened_at: '2026-10-20T08:40:00Z' })
    let alerts = [makeAlert(), omar]
    const resolve = (id: string) => () => {
      alerts = alerts.map((alert) => (alert.id === id ? { ...alert, status: 'RESOLVED' as const, can_act: false } : alert))
      return jsonResponse(alerts.find((alert) => alert.id === id))
    }
    const { user } = setup({
      alerts: serverList(() => alerts),
      extra: { [`POST /tracking/alerts/${makeAlert().id}/resolve`]: resolve(makeAlert().id), [`POST /tracking/alerts/${omar.id}/resolve`]: resolve(omar.id) },
    })
    const maya = await screen.findByRole('article', { name: 'Maya Odeh' })
    await user.click(within(maya).getByRole('button', { name: 'Resolve' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Resolve the alert for Maya Odeh?' })).getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Maya Odeh' })).toBeNull())
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Omar Saleh' })).getByRole('button', { name: 'Acknowledge' })).toHaveFocus())

    await user.click(within(screen.getByRole('article', { name: 'Omar Saleh' })).getByRole('button', { name: 'Resolve' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Resolve the alert for Omar Saleh?' })).getByRole('button', { name: 'Resolve' }))
    expect(await screen.findByRole('heading', { name: 'No active alerts' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Tracking alerts' })).toHaveFocus())
  })

  it('says a refused action in its dialog (409 ALERT_RESOLVED), and keeps it there while the alert leaves the list (F16-33)', async () => {
    let resolvedMeanwhile = false
    const { queryClient, requests, user } = setup({
      alerts: serverList(() => [resolvedMeanwhile ? makeAlert({ status: 'RESOLVED', resolution: 'RETURNED', can_act: false }) : makeAlert()]),
      extra: {
        [`POST /tracking/alerts/${makeAlert().id}/acknowledge`]: () => {
          resolvedMeanwhile = true
          return errorResponse(409, 'ALERT_RESOLVED', 'This alert is already resolved.')
        },
      },
    })
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    await user.click(within(card).getByRole('button', { name: 'Acknowledge' }))
    const dialog = await screen.findByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }))
    expect(await within(dialog).findByText('This alert is already resolved.')).toBeInTheDocument()

    // The list's own refresh (every 15 s) comes back without the alert while the dialog is open.
    const listed = alertRequests(requests).length
    await act(() => queryClient.invalidateQueries({ queryKey: ['tracking', 'alerts', 'list'] }))
    await waitFor(() => expect(alertRequests(requests).length).toBeGreaterThan(listed))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Maya Odeh' })).toBeNull())
    expect(within(dialog).getByText('This alert is already resolved.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })).toBeNull()
    expect(await screen.findByRole('heading', { name: 'No active alerts' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Tracking alerts' })).toHaveFocus())
  })

  it('asks for the list again once a refused action’s dialog is closed, not before', async () => {
    const { requests, user } = setup({
      extra: { [`POST /tracking/alerts/${makeAlert().id}/resolve`]: () => errorResponse(409, 'ALERT_RESOLVED', 'This alert is already resolved.') },
    })
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    await user.click(within(card).getByRole('button', { name: 'Resolve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve the alert for Maya Odeh?' })
    const listed = alertRequests(requests).length
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))
    await within(dialog).findByText('This alert is already resolved.')
    // The card stays behind the dialog as it was until the person has read why.
    await act(async () => {})
    expect(alertRequests(requests)).toHaveLength(listed)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(alertRequests(requests).length).toBeGreaterThan(listed))
  })

  it('refuses a note longer than 300 characters at its field', async () => {
    const { requests, user } = setup()
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    await user.click(within(card).getByRole('button', { name: 'Resolve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve the alert for Maya Odeh?' })
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' })
    await user.click(note)
    await user.paste('x'.repeat(301))
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))
    expect(note).toHaveAttribute('aria-invalid', 'true')
    expect(requests.filter((request) => request.method === 'POST')).toEqual([])
  })

  it('offers management no action', async () => {
    setup({ roles: ['MANAGEMENT'], alerts: () => jsonResponse(alertPage([makeAlert({ can_act: false })])) })
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    expect(within(card).queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Resolve' })).toBeNull()
    expect(within(card).getByRole('link', { name: 'Open journey' })).toBeInTheDocument()
  })

  it('has an empty state for each tab, and its own for a refusal', async () => {
    const { user, unmount } = setup({ alerts: () => jsonResponse(alertPage([])) })
    expect(await screen.findByRole('heading', { name: 'No active alerts' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'By day' }))
    expect(await screen.findByRole('heading', { name: 'No alerts on this day' })).toBeInTheDocument()
    unmount()

    setup({ alerts: () => errorResponse(403, 'FORBIDDEN', 'You do not have access to this resource.') })
    expect(await screen.findByRole('heading', { name: 'No access to tracking alerts' })).toBeInTheDocument()
    expect(screen.getByText('You do not have access to this resource.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('past its last page (its alerts resolved meanwhile, an old link) offers the first page, with the pages, not "No active alerts" (F16-35)', async () => {
    const { router, user } = setup({
      path: '/journey/alerts?page=3',
      alerts: ({ url }) => jsonResponse(url.searchParams.get('page') === '3' ? { items: [], page: 3, page_size: 20, total: 21 } : alertPage([makeAlert()], 21)),
    })
    expect(await screen.findByRole('heading', { name: 'Nothing on this page' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No active alerts' })).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Pages of alerts' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go to the first page' }))
    expect(router.state.location.search).toBe('')
    expect(await screen.findByRole('article', { name: 'Maya Odeh' })).toBeInTheDocument()
  })

  it('keeps an Arabic name and its time in order in English (the name isolated)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setup({ alerts: () => jsonResponse(alertPage([makeAlert({ status: 'ACKNOWLEDGED', acknowledged_at: '2026-10-20T08:59:00Z', acknowledged_by: { id: 'u3', full_name: 'ليلى الحسن' } })])) })
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    expect(card).toHaveTextContent('Acknowledged\u2068ليلى الحسن\u2069, 11:59')
  })

  it('keeps the viewer’s sound and browser notifications on this device', async () => {
    const requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => 'granted')
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'default', requestPermission }))
    const { user } = setup()
    const settings = await screen.findByRole('region', { name: 'Alert settings' })
    const sound = within(settings).getByRole('switch', { name: 'Alert sound' })
    const notifications = within(settings).getByRole('switch', { name: 'Browser notifications' })
    expect(sound).toHaveAttribute('aria-checked', 'true')
    expect(notifications).toHaveAttribute('aria-checked', 'false')

    await user.click(sound)
    expect(sound).toHaveAttribute('aria-checked', 'false')
    expect(window.localStorage.getItem(`vms.trackingAlerts.sound.${makeTrackedMe(['RECEPTIONIST']).user.id}`)).toBe('0')

    await user.click(notifications)
    expect(requestPermission).toHaveBeenCalledOnce()
    await waitFor(() => expect(notifications).toHaveAttribute('aria-checked', 'true'))
  })

  it('says when the browser blocks or lacks notifications, the switch disabled', async () => {
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'denied', requestPermission: vi.fn<() => Promise<NotificationPermission>>() }))
    setup()
    const settings = await screen.findByRole('region', { name: 'Alert settings' })
    const notifications = within(settings).getByRole('switch', { name: 'Browser notifications' })
    expect(notifications).toHaveAttribute('aria-disabled', 'true')
    expect(notifications).toHaveAccessibleDescription('Blocked by the browser')
  })

  it('reads in Arabic', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setup({ language: 'ar', alerts: () => jsonResponse(alertPage([makeAlert({ status: 'ACKNOWLEDGED', last_location: { ...PLACE } })])) })
    expect(await screen.findByRole('heading', { level: 1, name: 'تنبيهات التتبّع' })).toBeInTheDocument()
    const card = await screen.findByRole('article', { name: 'Maya Odeh' })
    expect(card.querySelector('[data-alert-type]')).toHaveTextContent('منطقة غير مسموحة')
    expect(card.querySelector('[data-alert-status]')).toHaveTextContent('اطُّلع عليه')
    expect(within(card).getByRole('button', { name: 'إغلاق' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'النشطة' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'صوت التنبيه' })).toBeInTheDocument()
  })
})
