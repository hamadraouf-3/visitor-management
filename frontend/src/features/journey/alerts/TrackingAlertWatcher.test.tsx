import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../../i18n'
import { jsonResponse, makeMe, mockApi, type RecordedRequest } from '../../../test/api'
import { routes } from '../../../test/appRoutes'
import { myVisitsRoutes } from '../../../test/fixtures'
import { renderRoutes } from '../../../test/render'
import { adminDashboardRoutes } from '../../admin/testRoutes'
import { setBaseTitle } from '../../../hooks/documentTitle'
import type { Me, TrackingAlertSummary } from '../../../types/api'
import { briefOf, FLOOR_4, FLOOR_4_PLACE, makeAlert, makeAlertSummary, makeTrackedMe, makeTrackingStatus, makeVisitJourney, OPEN_OFFICE, otherVisit } from '../testRoutes'
import { writeAlertPreference } from './alertPreferences'
import { beep } from './beep'

vi.mock('./beep', () => ({ beep: vi.fn<() => void>(), installAudioUnlock: () => () => undefined }))

const MAYA = makeAlert()
const OMAR = makeAlert({ id: 'a1e00000-0000-4000-8000-000000000002', visit: otherVisit(2, 'Omar Saleh'), last_location: FLOOR_4_PLACE, opened_at: '2026-10-20T08:58:00Z' })
const SAMI = makeAlert({ id: 'a1e00000-0000-4000-8000-000000000003', visit: otherVisit(3, 'Sami Khoury'), opened_at: '2026-10-20T08:59:00Z' })
const SUMMARY_KEY = ['tracking', 'alerts', 'summary']

/** A browser whose notifications are allowed; each one shown is kept with its listeners and a spied close. */
function grantNotifications() {
  const shown: { title: string; listeners: Map<string, () => void>; close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal(
    'Notification',
    Object.assign(
      class {
        listeners = new Map<string, () => void>()
        close = vi.fn<() => void>()
        constructor(title: string) {
          shown.push({ title, listeners: this.listeners, close: this.close })
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners.set(type, listener)
        }
      },
      { permission: 'granted', requestPermission: vi.fn<() => Promise<NotificationPermission>>() },
    ),
  )
  return shown
}

function summaryRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/tracking/alerts/summary')
}

/** The shell on the alerts page (an empty list), with a summary the test changes and asks for again. */
function setup(initial: TrackingAlertSummary, me: Me = makeTrackedMe(['RECEPTIONIST'])) {
  const summary = { current: initial }
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(me),
    'GET /tracking/status': () => jsonResponse(makeTrackingStatus()),
    'GET /tracking/alerts': () => jsonResponse({ items: [], page: 1, page_size: 20, total: 0 }),
    'GET /tracking/alerts/summary': () => jsonResponse(summary.current),
    // A toast's View (or a notification) opens this visitor's journey.
    [`GET /visits/${OMAR.visit.id}/journey`]: () => jsonResponse(makeVisitJourney({ visit: { ...makeVisitJourney().visit, id: OMAR.visit.id } })),
  })
  const view = renderRoutes(routes, { initialEntries: ['/journey/alerts'] })
  const next = async (value: TrackingAlertSummary) => {
    summary.current = value
    await act(() => view.queryClient.invalidateQueries({ queryKey: SUMMARY_KEY }))
  }
  return { ...api, ...view, next }
}

const open = (...alerts: (typeof MAYA)[]) => makeAlertSummary({ open: alerts.length, active: alerts.length, latest: alerts.map(briefOf) })

beforeEach(() => {
  window.localStorage.clear()
  // A choice holds for the page's life (also where storage refuses it): each test starts from the defaults.
  const { id } = makeTrackedMe(['RECEPTIONIST']).user
  writeAlertPreference(id, 'sound', true)
  writeAlertPreference(id, 'notifications', false)
  document.title = ''
})

afterEach(async () => {
  vi.mocked(beep).mockClear()
  await i18n.changeLanguage('en')
})

describe('the shell’s tracking alert watcher', () => {
  it('only sets the badge and the title on the first answer', async () => {
    const { requests } = setup(open(MAYA))
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    const entry = await within(nav).findByRole('link', { name: 'Tracking alerts 1 active alert' })
    expect(entry.querySelector('[data-nav-badge]')).toHaveAttribute('data-nav-badge', 'danger')
    await waitFor(() => expect(document.title).toMatch(/^\(1\) Tracking alerts · /))
    expect(screen.queryByText(/^Alert:/)).toBeNull()
    expect(beep).not.toHaveBeenCalled()
    // Never the person's own activity: a screen left open still reaches the idle timeout.
    expect(summaryRequests(requests).every((request) => request.headers.get('X-Background-Refresh') === '1')).toBe(true)
  })

  it('tells of a new open alert once: a toast whose View opens the journey, and a beep', async () => {
    const { next, router, user } = setup(open(MAYA))
    await screen.findByRole('link', { name: 'Tracking alerts 1 active alert' })
    await next(open(OMAR, MAYA))

    const toast = await screen.findByText('Alert: Omar Saleh in Floor 4 › Open office')
    const card = toast.closest('div.pointer-events-auto') as HTMLElement
    // Danger: said at once (the assertive region), and kept until dismissed.
    expect(toast.closest('[role="alert"]')).not.toBeNull()
    expect(card).toHaveTextContent('Simulated')
    expect(beep).toHaveBeenCalledOnce()
    await waitFor(() => expect(document.title).toMatch(/^\(2\) /))

    await next(open(OMAR, MAYA))
    expect(screen.getAllByText(/^Alert:/)).toHaveLength(1)

    await user.click(within(card).getByRole('button', { name: 'View' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/journey/${OMAR.visit.id}`))
    expect(screen.queryByText('Alert: Omar Saleh in Floor 4 › Open office')).toBeNull()
  })

  it('tells again of an alert escalated to a restricted area', async () => {
    const { next } = setup(open(MAYA))
    await screen.findByRole('link', { name: 'Tracking alerts 1 active alert' })
    await next(open({ ...MAYA, type: 'RESTRICTED_AREA' }))
    expect(await screen.findByText('Alert: Maya Odeh in Floor 4 › Open office')).toBeInTheDocument()
  })

  it('stays silent when the viewer turned the sound off, and shows a browser notification when turned on and allowed', async () => {
    const me = makeTrackedMe(['RECEPTIONIST'])
    writeAlertPreference(me.user.id, 'sound', false)
    writeAlertPreference(me.user.id, 'notifications', true)
    const shown: { title: string; options: NotificationOptions }[] = []
    vi.stubGlobal(
      'Notification',
      Object.assign(
        class {
          constructor(title: string, options: NotificationOptions) {
            shown.push({ title, options })
          }
          addEventListener() {}
          close() {}
        },
        { permission: 'granted', requestPermission: vi.fn<() => Promise<NotificationPermission>>() },
      ),
    )
    const { next } = setup(makeAlertSummary(), me)
    await screen.findByRole('navigation', { name: 'Main navigation' })
    await waitFor(() => expect(document.title).not.toBe(''))
    await next(open(OMAR))
    expect(await screen.findByText('Alert: Omar Saleh in Floor 4 › Open office')).toBeInTheDocument()
    expect(beep).not.toHaveBeenCalled()
    expect(shown).toEqual([{ title: 'Alert: Omar Saleh in Floor 4 › Open office', options: { body: 'Simulated', tag: OMAR.id, lang: 'en' } }])
  })

  it('quiets the badge while every active alert is acknowledged, and takes the title’s count away', async () => {
    const { next } = setup(open(MAYA))
    await screen.findByRole('link', { name: 'Tracking alerts 1 active alert' })
    await next(makeAlertSummary({ open: 0, active: 1, latest: [] }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Tracking alerts 1 active alert' }).querySelector('[data-nav-badge]')).toHaveAttribute('data-nav-badge', 'neutral'))
    await waitFor(() => expect(document.title).toMatch(/^Tracking alerts · /))
    await next(makeAlertSummary())
    await waitFor(() => expect(screen.getByRole('link', { name: 'Tracking alerts' }).querySelector('[data-nav-badge]')).toBeNull())
  })

  it('makes only Tracking alerts the current page on its page, and Visitor Journey on a journey', async () => {
    setup(makeAlertSummary())
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getByRole('link', { name: 'Tracking alerts' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Visitor Journey' })).not.toHaveAttribute('aria-current')
  })

  it('tells of several new alerts in one answer oldest first, so the newest is said last, with one beep', async () => {
    const { next } = setup(open(MAYA))
    await screen.findByRole('link', { name: 'Tracking alerts 1 active alert' })
    await next(open(SAMI, OMAR, MAYA))
    await screen.findByText('Alert: Sami Khoury in Floor 4 › Open office')
    expect(screen.getAllByText(/^Alert:/).map((toast) => toast.textContent)).toEqual(['Alert: Omar Saleh in Floor 4 › Open office', 'Alert: Sami Khoury in Floor 4 › Open office'])
    expect(beep).toHaveBeenCalledOnce()
  })

  it('never tells of an alert open before the start that moves up into the five latest (F16-38)', async () => {
    // Six open at the start: the summary names the five newest.
    const six = Array.from({ length: 6 }, (_, index) => makeAlert({ id: `a1e00000-0000-4000-8000-00000000010${index}`, visit: otherVisit(10 + index, `Visitor ${index + 1}`), opened_at: `2026-10-20T08:1${index}:00Z` })).toReversed()
    const { next } = setup(makeAlertSummary({ open: 6, active: 6, latest: six.slice(0, 5).map(briefOf) }))
    await screen.findByRole('link', { name: 'Tracking alerts 6 active alerts' })
    // A colleague acknowledged the newest: the oldest moves up.
    await next(makeAlertSummary({ open: 5, active: 6, latest: six.slice(1).map(briefOf) }))
    await waitFor(() => expect(document.title).toMatch(/^\(5\) /))
    expect(screen.queryByText(/^Alert:/)).toBeNull()
    expect(beep).not.toHaveBeenCalled()
  })

  it('tells of a new alert in Arabic, the name and the place isolated, with «عرض»', async () => {
    const { next, router, user } = setup(open(MAYA), makeTrackedMe(['RECEPTIONIST'], { preferred_language: 'ar' }))
    await waitFor(() => expect(document.title).toMatch(/^\(1\) /))
    await next(open(OMAR, MAYA))
    const text = `تنبيه: \u2068Omar Saleh\u2069 في \u2068${FLOOR_4.name_ar} › ${OPEN_OFFICE.name_ar}\u2069`
    const toast = await screen.findByText(text)
    await user.click(within(toast.closest('div.pointer-events-auto') as HTMLElement).getByRole('button', { name: 'عرض' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/journey/${OMAR.visit.id}`))
  })

  it('opens the journey from a browser notification, and closes the notifications it showed when it goes (F16-39)', async () => {
    const me = makeTrackedMe(['RECEPTIONIST'])
    writeAlertPreference(me.user.id, 'notifications', true)
    const shown = grantNotifications()
    const { next, router, unmount } = setup(open(MAYA), me)
    await screen.findByRole('link', { name: 'Tracking alerts 1 active alert' })
    await next(open(SAMI, MAYA))
    await next(open(OMAR, SAMI, MAYA))
    await waitFor(() => expect(shown.map((one) => one.title)).toEqual(['Alert: Sami Khoury in Floor 4 › Open office', 'Alert: Omar Saleh in Floor 4 › Open office']))

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    act(() => shown[1]!.listeners.get('click')!())
    await waitFor(() => expect(router.state.location.pathname).toBe(`/journey/${OMAR.visit.id}`))
    expect(focus).toHaveBeenCalledOnce()
    expect(shown[1]!.close).toHaveBeenCalledOnce()
    // The system says it is closed: it is forgotten.
    shown[1]!.listeners.get('close')!()

    // Signing out (or another person) unmounts the watcher: a visitor's name and place leave the system's centre.
    unmount()
    expect(shown[0]!.close).toHaveBeenCalledOnce()
    expect(shown[1]!.close).toHaveBeenCalledOnce()
  })

  it('takes the title’s count away when it goes, so the next page’s title has none', async () => {
    const { unmount } = setup(open(MAYA))
    await waitFor(() => expect(document.title).toMatch(/^\(1\) /))
    unmount()
    expect(document.title).not.toMatch(/^\(1\) /)
    setBaseTitle('Sign in')
    expect(document.title).toBe('Sign in')
  })

  it('does not run while a password change is required', async () => {
    const { requests } = mockApi({
      'GET /auth/me': () => jsonResponse(makeTrackedMe(['RECEPTIONIST'], { must_change_password: true })),
      'GET /tracking/alerts/summary': () => jsonResponse(open(MAYA)),
    })
    renderRoutes(routes, { initialEntries: ['/change-password'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeInTheDocument()
    expect(summaryRequests(requests)).toEqual([])
    expect(screen.queryByRole('link', { name: /Tracking alerts/ })).toBeNull()
  })

  it('runs for nobody else: a host, or a company whose tracking is not allowed', async () => {
    const host = mockApi({ 'GET /auth/me': () => jsonResponse(makeTrackedMe(['EMPLOYEE'])), ...myVisitsRoutes() })
    const view = renderRoutes(routes, { initialEntries: ['/visits'] })
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).queryByRole('link', { name: /Tracking alerts/ })).toBeNull()
    expect(summaryRequests(host.requests)).toEqual([])
    view.unmount()

    const untracked = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN', 'MANAGEMENT'])), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(screen.queryByRole('link', { name: /Tracking alerts/ })).toBeNull()
    expect(summaryRequests(untracked.requests)).toEqual([])
  })
})
