import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { Role, VisitJourney } from '../../types/api'
import { makeCamera, makeEvent, makeJourneyItem, makeTrackedMe, makeTrackingStatus, makeVisitJourney, MEETING, PLACE, VISIT_ID } from './testRoutes'

/** 12:00 in Amman; the last confirmed sighting was at 11:56 (four minutes before). */
const NOW = new Date('2026-10-20T09:00:00Z')

function journeyRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/journeys')
}

function lastQuery(requests: RecordedRequest[]) {
  return Object.fromEntries(journeyRequests(requests).at(-1)!.url.searchParams)
}

function setupList({
  roles = ['RECEPTIONIST'] as Role[],
  journeys = () => jsonResponse(page([makeJourneyItem()])),
  status = () => jsonResponse(makeTrackingStatus()),
  path = '/journey',
  language = null,
}: { roles?: Role[]; journeys?: RouteHandler; status?: RouteHandler; path?: string; language?: 'ar' | null } = {}) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeTrackedMe(roles, { preferred_language: language })), 'GET /tracking/status': status, 'GET /journeys': journeys })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

function setupDetail({
  roles = ['RECEPTIONIST'] as Role[],
  journey = () => jsonResponse(makeVisitJourney()),
  status = () => jsonResponse(makeTrackingStatus()),
  extra = {},
  language = null,
}: { roles?: Role[]; journey?: RouteHandler; status?: RouteHandler; extra?: Record<string, RouteHandler>; language?: 'ar' | null } = {}) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeTrackedMe(roles, { preferred_language: language })), 'GET /tracking/status': status, [`GET /visits/${VISIT_ID}/journey`]: journey, ...extra })
  return { ...api, ...renderRoutes(routes, { initialEntries: [`/journey/${VISIT_ID}`] }) }
}

afterEach(async () => {
  vi.useRealTimers()
  await i18n.changeLanguage('en')
})

describe('Visitor Journey: the list', () => {
  it('lists the day’s visits with their state and the last confirmed floor and zone with its time, Simulated said once for the page', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const { requests } = setupList()

    const table = await screen.findByRole('table', { name: 'Visitor Journey' })
    expect(lastQuery(requests)).toEqual({ page: '1', page_size: '25' })
    expect(within(table).getByRole('columnheader', { name: 'Inferred location' })).toBeInTheDocument()
    const row = within(table).getAllByRole('row')[1]!
    expect(within(row).getByRole('link', { name: 'Maya Odeh' })).toHaveAttribute('href', `/journey/${VISIT_ID}`)
    expect(row).toHaveTextContent('Cedar Advisory')
    expect(row).toHaveTextContent('Omar Khalil')
    expect(within(row).getByText('Active')).toBeInTheDocument()
    // "Floor 3 › Lobby": the chevron is decorative, a hidden comma reads between the two.
    expect(row.querySelector('[data-location-path]')).toHaveTextContent('Floor 3,Lobby')
    expect(row).toHaveTextContent('North Tower · 11:56 · 4m ago')
    expect(screen.getByRole('heading', { level: 1, name: 'Visitor Journey' })).toBeInTheDocument()
    // The simulator is the provider: the page's line says Simulated, and no row repeats it.
    const banner = screen.getByRole('region', { name: 'Tracking' })
    expect(document.querySelectorAll('[data-simulated]')).toHaveLength(1)
    expect(banner.querySelector('[data-simulated]')).toHaveTextContent('Simulated')
    expect(row.querySelector('[data-simulated]')).toBeNull()
  })

  it('marks a simulated row when the page itself is not marked', async () => {
    setupList({ status: () => jsonResponse(makeTrackingStatus({ provider: 'disabled', simulated: false, available: false, healthy: false })) })
    const table = await screen.findByRole('table', { name: 'Visitor Journey' })
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tracking' })).toHaveTextContent('No tracking provider'))
    expect(document.querySelectorAll('[data-simulated]')).toHaveLength(1)
    expect(within(table).getAllByRole('row')[1]!.querySelector('[data-simulated]')).toHaveTextContent('Simulated')
    expect(screen.getByRole('region', { name: 'Tracking' }).querySelector('[data-simulated]')).toBeNull()
  })

  it('says how long ago from the server’s freshness, not from the device’s clock', async () => {
    // The device's clock says four minutes since the sighting; the server, which observed it, says ten.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setupList({ journeys: () => jsonResponse(page([makeJourneyItem({ freshness_seconds: 600 })])) })
    const table = await screen.findByRole('table', { name: 'Visitor Journey' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('North Tower · 11:56 · 10m ago')
  })

  it('keeps how long ago of the rows on screen while another filter loads', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    let release: (() => void) | undefined
    const { requests } = setupList({
      journeys: (request) =>
        request.url.searchParams.has('state')
          ? new Promise<Response>((resolve) => {
              release = () => resolve(jsonResponse(page([makeJourneyItem({ state: 'STALE' })])))
            })
          : jsonResponse(page([makeJourneyItem()])),
    })
    const table = await screen.findByRole('table', { name: 'Visitor Journey' })

    fireEvent.change(screen.getByRole('combobox', { name: 'State' }), { target: { value: 'STALE' } })
    await waitFor(() => expect(lastQuery(requests)).toMatchObject({ state: 'STALE' }))
    // The previous rows stay, marked busy, and still say four minutes (the query's own time is 0 meanwhile).
    await waitFor(() => expect(table.closest('[aria-busy]')).not.toBeNull())
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('North Tower · 11:56 · 4m ago')

    release?.()
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Visitor Journey' })).getByText('Not recent')).toBeInTheDocument())
  })

  it('says «Unknown» where no confirmed observation exists, and never a floor', async () => {
    setupList({ journeys: () => jsonResponse(page([makeJourneyItem({ state: 'UNCERTAIN', last_location: null, last_observed_at: null, freshness_seconds: null, simulated: false })])) })

    const table = await screen.findByRole('table', { name: 'Visitor Journey' })
    const row = within(table).getAllByRole('row')[1]!
    expect(row.querySelector('[data-location-unknown]')).toHaveTextContent('Unknown')
    expect(row.querySelector('[data-location-path]')).toBeNull()
    expect(row.querySelector('[data-simulated]')).toBeNull()
    expect(within(row).getByText('Uncertain')).toBeInTheDocument()
  })

  it('has one line of tracking state above the list', async () => {
    const status = { current: makeTrackingStatus({ provider: 'disabled', simulated: false, available: false, healthy: false }) }
    const { queryClient } = setupList({ status: () => jsonResponse(status.current) })
    const refresh = async (next: typeof status.current) => {
      status.current = next
      await act(() => queryClient.invalidateQueries({ queryKey: ['tracking', 'status'] }))
    }

    const banner = await screen.findByRole('region', { name: 'Tracking' })
    expect(banner).toHaveTextContent(/^No tracking provider$/)

    // A provider exists, the company has not turned it on.
    await refresh(makeTrackingStatus({ enabled: false, healthy: false }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tracking' })).toHaveTextContent('Tracking is off'))
    expect(screen.getByRole('region', { name: 'Tracking' })).not.toHaveTextContent('No tracking provider')

    await refresh(makeTrackingStatus({ healthy: false }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tracking' })).toHaveTextContent('The tracking provider is not connected'))
    expect(screen.getByRole('region', { name: 'Tracking' })).toHaveTextContent('Simulated')

    // On and connected: the Simulated mark alone, without the line's frame.
    await refresh(makeTrackingStatus())
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tracking' })).toHaveTextContent(/^Simulated$/))
    const alone = screen.getByRole('region', { name: 'Tracking' })
    expect(alone).toHaveAttribute('data-tracking-banner', 'simulated')
    expect(alone).not.toHaveClass('border')
    expect(alone).not.toHaveClass('rounded-card')
  })

  it('filters by state, day and search, in the request and the address', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const { requests, router } = setupList()
    await screen.findByRole('table', { name: 'Visitor Journey' })

    fireEvent.change(screen.getByRole('combobox', { name: 'State' }), { target: { value: 'STALE' } })
    await waitFor(() => expect(lastQuery(requests)).toEqual({ page: '1', page_size: '25', state: 'STALE' }))
    expect(router.state.location.search).toBe('?state=STALE')

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-19' } })
    await waitFor(() => expect(lastQuery(requests)).toEqual({ page: '1', page_size: '25', state: 'STALE', day: '2026-10-19' }))

    const search = screen.getByRole('searchbox', { name: 'Search' })
    fireEvent.change(search, { target: { value: 'Cedar' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(lastQuery(requests)).toMatchObject({ q: 'Cedar' }))
    // The search text never goes into the address.
    expect(router.state.location.search).not.toContain('Cedar')
  })

  it('has an empty state for a day without visits', async () => {
    setupList({ journeys: () => jsonResponse(page([])) })
    expect(await screen.findByRole('heading', { name: 'No visits on this day' })).toBeInTheDocument()
  })

  it('has its own empty state for filters that match nothing, which clears them', async () => {
    const { requests, router, user } = setupList({ path: '/journey?state=STALE', journeys: () => jsonResponse(page([])) })
    expect(await screen.findByRole('heading', { name: 'No visits match these filters' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No visits on this day' })).toBeNull()
    expect(lastQuery(requests)).toMatchObject({ state: 'STALE' })

    // The filter panel has one too; the empty state's is the last.
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1)!)
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(await screen.findByRole('heading', { name: 'No visits on this day' })).toBeInTheDocument()
  })

  it('says so when the API refuses the list (403)', async () => {
    setupList({ journeys: () => errorResponse(403, 'FORBIDDEN', 'You do not have permission to do this.') })
    expect(await screen.findByRole('heading', { name: 'No access to the Visitor Journey' })).toBeInTheDocument()
  })

  it('reads in Arabic', async () => {
    setupList({ language: 'ar', journeys: () => jsonResponse(page([makeJourneyItem({ last_location: null, last_observed_at: null, freshness_seconds: null })])) })
    const table = await screen.findByRole('table', { name: 'رحلة الزائر' })
    expect(within(table).getByRole('columnheader', { name: 'موقع مُستنتج' })).toBeInTheDocument()
    const row = within(table).getAllByRole('row')[1]!
    expect(row).toHaveTextContent('غير معروف')
    expect(row).toHaveTextContent('نشط')
    expect(screen.getByRole('region', { name: 'التتبّع' })).toHaveTextContent('محاكاة')
  })
})

/** A visit inside whose tracking can be started. */
const notTracked = () =>
  makeVisitJourney({ state: 'NOT_ENROLLED', association: null, last_location: null, last_observed_at: null, freshness_seconds: null, timeline: [], timeline_total: 0, can_enroll: true, enroll_blocker: null, can_revoke: false })

describe('Visitor Journey: a visit', () => {
  it('shows the last known floor and zone under «Inferred location», with the state, when and how long ago', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setupDetail()

    expect(await screen.findByRole('heading', { level: 1, name: 'Maya Odeh' })).toBeInTheDocument()
    // The tab's title never names the visitor.
    expect(document.title).not.toContain('Maya')
    const card = screen.getByRole('heading', { name: 'Inferred location' }).closest('section')!
    const location = card.querySelector('[data-inferred-location]')!
    expect(location.querySelector('[data-location-path]')).toHaveTextContent('Floor 3,Lobby')
    expect(location).toHaveTextContent('North Tower')
    expect(location).toHaveTextContent('Observed 11:56 · 4m ago')
    // The state is said once, on the location it qualifies (not in the header too).
    expect(within(card).getByText('Active')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(1)
  })

  it('says how long ago from the server’s freshness, not from the device’s clock', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setupDetail({ journey: () => jsonResponse(makeVisitJourney({ freshness_seconds: 600 })) })
    const card = (await screen.findByRole('heading', { name: 'Inferred location' })).closest('section')!
    expect(card.querySelector('[data-inferred-location]')).toHaveTextContent('Observed 11:56 · 10m ago')
  })

  it('says «Unknown» without a confirmed observation', async () => {
    setupDetail({ journey: () => jsonResponse(makeVisitJourney({ state: 'UNCERTAIN', last_location: null, last_observed_at: null, freshness_seconds: null })) })
    const card = (await screen.findByRole('heading', { name: 'Inferred location' })).closest('section')!
    expect(card.querySelector('[data-location-unknown]')).toHaveTextContent('Unknown')
    expect(card.querySelector('[data-location-path]')).toBeNull()
    expect(card).not.toHaveTextContent('Observed')
  })

  it('lists the timeline newest first: each observation with its mark, its camera, a confidence only when the provider sent one, the start last', async () => {
    setupDetail({
      journey: () =>
        jsonResponse(
          makeVisitJourney({
            timeline: [
              makeEvent({ id: 'e1', type: 'ENROLLED', observed_at: '2026-10-20T08:06:00Z', camera: { id: 'c1', name: 'Reception desk' }, location: null, match: null, confidence: null, confirmed: false }),
              makeEvent({ id: 'e2', observed_at: '2026-10-20T08:40:00Z', location: { ...PLACE, zone: MEETING }, match: 'UNCERTAIN', confidence: null, confirmed: false }),
              makeEvent({ id: 'e3', observed_at: '2026-10-20T08:56:00Z', confidence: 0.91 }),
              makeEvent({ id: 'e4', type: 'LOST', observed_at: '2026-10-20T08:58:00Z', location: null, match: null, confidence: null, confirmed: false, camera: null }),
            ],
            timeline_total: 4,
          }),
        ),
    })
    await screen.findByRole('heading', { name: /^Timeline/ })
    const events = within(document.querySelector<HTMLElement>('[data-journey-timeline]')!).getAllByRole('listitem')
    expect(events).toHaveLength(4)
    // The server answers oldest first; the page shows the latest sighting at the top (the lead's decision).
    expect(events.map((event) => event.getAttribute('data-event-type'))).toEqual(['LOST', 'OBSERVED', 'OBSERVED', 'ENROLLED'])
    expect(events[0]).toHaveTextContent('Out of sight')
    expect(events[0]!.querySelector('[data-confidence]')).toBeNull()
    expect(events[1]).toHaveTextContent('Confirmed')
    expect(events[1]).toHaveTextContent('11:56 · Floor 3 lobby · Confidence 91%')
    expect(events[2]!.querySelector('[data-location-path]')).toHaveTextContent('Floor 3,Meeting rooms')
    expect(events[2]).toHaveTextContent('Uncertain')
    // The provider sent no confidence for this one: none is shown.
    expect(events[2]!.querySelector('[data-confidence]')).toBeNull()
    expect(events[3]).toHaveTextContent('Tracking started')
    expect(events[3]).toHaveTextContent('11:06 · Reception desk')
    expect(events[3]!.querySelector('[data-confidence]')).toBeNull()
  })

  it('says «No observations» for an empty timeline', async () => {
    setupDetail({ journey: () => jsonResponse(makeVisitJourney({ timeline: [], timeline_total: 0 })) })
    const card = (await screen.findByRole('heading', { name: /^Timeline/ })).closest('section')!
    expect(card).toHaveTextContent('No observations')
  })

  it('marks what the simulator made «Simulated» once, in the header: not on the tracking, not in the line', async () => {
    setupDetail({ status: () => jsonResponse(makeTrackingStatus({ healthy: false })) })
    await screen.findByRole('heading', { level: 1, name: 'Maya Odeh' })
    const banner = await screen.findByText('The tracking provider is not connected')
    expect(document.querySelectorAll('[data-simulated]')).toHaveLength(1)
    expect(banner.closest('[data-tracking-banner]')!.querySelector('[data-simulated]')).toBeNull()
    const tracking = screen.getByRole('heading', { name: 'Tracking' }).closest('section')!
    expect(tracking.querySelector('[data-simulated]')).toBeNull()
  })

  it('says when tracking was requested while the provider has not started it', async () => {
    const pending = makeVisitJourney()
    setupDetail({ journey: () => jsonResponse(makeVisitJourney({ state: 'PENDING', association: { ...pending.association!, status: 'PENDING', created_at: '2026-10-20T08:06:00Z', activated_at: null }, last_location: null, last_observed_at: null, freshness_seconds: null })) })
    const tracking = (await screen.findByRole('heading', { name: 'Tracking' })).closest('section')!
    expect(tracking).toHaveTextContent('Requested')
    expect(tracking).not.toHaveTextContent('Started')
  })

  it('lets reception stop the tracking, after one line, the focus then on the page’s heading', async () => {
    const active = makeVisitJourney()
    const stopped: VisitJourney = {
      ...active,
      state: 'ENDED',
      association: { ...active.association!, status: 'ENDED', ended_at: '2026-10-20T09:00:00Z', ended_reason: 'REVOKED' },
      can_revoke: false,
      can_enroll: false,
      enroll_blocker: 'NOT_CHECKED_IN',
      visit: { ...active.visit, status: 'CHECKED_OUT', check_out_at: '2026-10-20T09:00:00Z' },
    }
    let current = active
    const { requests, user } = setupDetail({
      journey: () => jsonResponse(current),
      extra: {
        [`POST /visits/${VISIT_ID}/tracking/revoke`]: () => {
          current = stopped
          return jsonResponse(stopped)
        },
      },
    })

    await user.click(await screen.findByRole('button', { name: 'Stop tracking' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop tracking Maya Odeh?' })
    await user.click(within(dialog).getByRole('button', { name: 'Stop tracking' }))

    await waitFor(() => expect(requests.some((request) => request.method === 'POST' && request.path === `/visits/${VISIT_ID}/tracking/revoke`)).toBe(true))
    expect(await screen.findByText('Tracking stopped')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const tracking = screen.getByRole('heading', { name: 'Tracking' }).closest('section')!
    expect(tracking).toHaveTextContent('Ended because')
    expect(tracking).toHaveTextContent('Stopped')
    expect(within(tracking).queryByRole('button', { name: 'Stop tracking' })).toBeNull()
    // The stop went with its button, and the disabled start that took its place is focused, with its reason.
    const start = within(tracking).getByRole('button', { name: 'Start tracking' })
    await waitFor(() => expect(start).toHaveFocus())
    expect(start).toHaveAccessibleDescription('Not inside')
  })

  it('keeps the focus on the action in both directions: a start moves it to Stop, a stop back to Start', async () => {
    let current = notTracked()
    const { user } = setupDetail({
      journey: () => jsonResponse(current),
      extra: {
        'GET /tracking/cameras': () => jsonResponse([makeCamera()]),
        [`POST /visits/${VISIT_ID}/tracking/enroll`]: () => {
          current = makeVisitJourney({ state: 'PENDING', last_location: null, last_observed_at: null, freshness_seconds: null })
          return jsonResponse(current)
        },
        [`POST /visits/${VISIT_ID}/tracking/revoke`]: () => {
          current = notTracked()
          return jsonResponse(current)
        },
      },
    })

    await user.click(await screen.findByRole('button', { name: 'Start tracking' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop tracking' })).toHaveFocus())

    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop tracking Maya Odeh?' })
    await user.click(within(dialog).getByRole('button', { name: 'Stop tracking' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start tracking' })).toHaveFocus())
  })

  it('starts the tracking at the chosen reception camera when there are several', async () => {
    const desk = makeCamera()
    const gate = makeCamera({ id: 'c1000000-0000-4000-8000-000000000009', name: 'Main gate', provider_camera_id: 'cam-gate' })
    let current = notTracked()
    const { requests, user } = setupDetail({
      journey: () => jsonResponse(current),
      extra: {
        'GET /tracking/cameras': () => jsonResponse([desk, gate]),
        [`POST /visits/${VISIT_ID}/tracking/enroll`]: () => {
          current = makeVisitJourney()
          return jsonResponse(current)
        },
      },
    })

    const camera = await screen.findByRole('combobox', { name: 'Reception camera' })
    expect(screen.getByText('No observations')).toBeInTheDocument()
    await user.selectOptions(camera, 'Main gate')
    await user.click(screen.getByRole('button', { name: 'Start tracking' }))

    await waitFor(() => expect(requests.find((request) => request.method === 'POST' && request.path === `/visits/${VISIT_ID}/tracking/enroll`)?.body).toEqual({ camera_id: gate.id }))
    expect(await screen.findByRole('button', { name: 'Stop tracking' })).toBeInTheDocument()
  })

  it('starts at the one reception camera without asking which', async () => {
    const { requests, user } = setupDetail({
      journey: () => jsonResponse(notTracked()),
      extra: {
        // An administrator reads every active camera; only the reception ones are offered.
        'GET /tracking/cameras': () => jsonResponse([makeCamera(), makeCamera({ id: 'c-floor', name: 'Floor 3 lobby', is_enrollment_point: false })]),
        [`POST /visits/${VISIT_ID}/tracking/enroll`]: () => jsonResponse(makeVisitJourney()),
      },
      roles: ['SYSTEM_ADMIN'],
    })
    await user.click(await screen.findByRole('button', { name: 'Start tracking' }))
    expect(screen.queryByRole('combobox', { name: 'Reception camera' })).toBeNull()
    await waitFor(() => expect(requests.find((request) => request.path === `/visits/${VISIT_ID}/tracking/enroll`)?.body).toEqual({ camera_id: makeCamera().id }))
  })

  it('keeps a refused start said (409), with the server’s message, once the page shows why', async () => {
    let current = notTracked()
    const { user } = setupDetail({
      journey: () => jsonResponse(current),
      extra: {
        'GET /tracking/cameras': () => jsonResponse([makeCamera()]),
        [`POST /visits/${VISIT_ID}/tracking/enroll`]: () => {
          // Turned off meanwhile.
          current = makeVisitJourney({ ...notTracked(), state: 'DISABLED', can_enroll: false, enroll_blocker: 'NOT_ENABLED' })
          return errorResponse(409, 'TRACKING_NOT_AVAILABLE', 'Visitor tracking is not available.', { reason: 'NOT_ENABLED' })
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Start tracking' }))

    const tracking = screen.getByRole('heading', { name: 'Tracking' }).closest('section')!
    await waitFor(() => expect(within(tracking).getByRole('button', { name: 'Start tracking' })).toHaveAttribute('aria-disabled', 'true'))
    const alert = within(tracking).getByRole('alert')
    expect(alert).toHaveTextContent('Tracking could not be started')
    expect(alert).toHaveTextContent('Visitor tracking is not available.')
    // The start went with the refusal; its disabled successor, with the reason, has the focus.
    await waitFor(() => expect(within(tracking).getByRole('button', { name: 'Start tracking' })).toHaveFocus())
    expect(within(tracking).getByRole('button', { name: 'Start tracking' })).toHaveAccessibleDescription('Tracking is off')
  })

  it('says a refused camera’s own message (422), not “the highlighted fields”, and asks for the cameras again', async () => {
    const { requests, user } = setupDetail({
      journey: () => jsonResponse(notTracked()),
      extra: {
        'GET /tracking/cameras': () => jsonResponse([makeCamera()]),
        [`POST /visits/${VISIT_ID}/tracking/enroll`]: () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
            fields: { camera_id: 'This camera is not a reception camera of the company.' },
            field_codes: { camera_id: { code: 'not_found', params: {} } },
          }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Start tracking' }))

    const tracking = screen.getByRole('heading', { name: 'Tracking' }).closest('section')!
    const alert = await within(tracking).findByRole('alert')
    expect(alert).toHaveTextContent('This camera is not a reception camera of the company.')
    expect(alert).not.toHaveTextContent('highlighted')
    await waitFor(() => expect(requests.filter((request) => request.path === '/tracking/cameras')).toHaveLength(2))
  })

  it('says the reception cameras could not be loaded, with a retry, never “No reception camera”', async () => {
    let failing = true
    const { user } = setupDetail({
      journey: () => jsonResponse(notTracked()),
      extra: { 'GET /tracking/cameras': () => (failing ? errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong.') : jsonResponse([makeCamera()])) },
    })
    const tracking = (await screen.findByRole('heading', { name: 'Tracking' })).closest('section')!
    expect(await within(tracking).findByText('The reception cameras could not be loaded')).toBeInTheDocument()
    expect(tracking).not.toHaveTextContent('No reception camera')
    expect(within(tracking).queryByRole('button', { name: 'Start tracking' })).toBeNull()

    failing = false
    await user.click(within(tracking).getByRole('button', { name: 'Try again' }))
    expect(await within(tracking).findByRole('button', { name: 'Start tracking' })).not.toHaveAttribute('aria-disabled')
  })

  it('shows why a start cannot be made, as a short state beside the disabled button', async () => {
    setupDetail({ journey: () => jsonResponse(makeVisitJourney({ state: 'DISABLED', association: null, can_enroll: false, enroll_blocker: 'NOT_ALLOWED', can_revoke: false })) })
    const start = await screen.findByRole('button', { name: 'Start tracking' })
    expect(start).toHaveAttribute('aria-disabled', 'true')
    expect(start).toHaveAccessibleDescription('Tracking not allowed')
    expect(screen.getByText('Tracking not allowed')).not.toHaveClass('sr-only')
  })

  it('does not repeat the line’s words beside the disabled start, but still reads them out', async () => {
    setupDetail({
      status: () => jsonResponse(makeTrackingStatus({ enabled: false, healthy: false })),
      journey: () => jsonResponse(makeVisitJourney({ state: 'DISABLED', association: null, can_enroll: false, enroll_blocker: 'NOT_ENABLED', can_revoke: false })),
    })
    await waitFor(() => expect(document.querySelector('[data-tracking-banner="off"]')).not.toBeNull())
    const start = await screen.findByRole('button', { name: 'Start tracking' })
    expect(start).toHaveAccessibleDescription('Tracking is off')
    await waitFor(() => expect(document.querySelector('[data-start-blocked="NOT_ENABLED"]')).toHaveClass('sr-only'))
  })

  it('offers management no action', async () => {
    setupDetail({ roles: ['MANAGEMENT'], journey: () => jsonResponse(makeVisitJourney({ can_revoke: false, can_enroll: false, enroll_blocker: 'NOT_PERMITTED' })) })
    await screen.findByRole('heading', { level: 1, name: 'Maya Odeh' })
    expect(screen.queryByRole('button', { name: 'Stop tracking' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start tracking' })).toBeNull()
  })

  it.each([
    [404, 'NOT_FOUND', 'Journey not found'],
    [403, 'FORBIDDEN', 'No access'],
  ])('has its own state for a %i', async (status, code, title) => {
    setupDetail({ journey: () => errorResponse(status, code, 'Refused.') })
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument()
  })

  it('says the latest of a long timeline', async () => {
    const journey: VisitJourney = makeVisitJourney({ timeline_total: 812 })
    setupDetail({ journey: () => jsonResponse(journey) })
    expect(await screen.findByText('Latest 3 of 812')).toBeInTheDocument()
  })

  it('reads in Arabic, with «موقع مُستنتج» and «محاكاة»', async () => {
    setupDetail({ language: 'ar' })
    expect(await screen.findByRole('heading', { name: 'موقع مُستنتج' })).toBeInTheDocument()
    expect(document.querySelector('[data-inferred-location] [data-location-path]')).toHaveTextContent('الطابق الثالث،الردهة')
    expect(screen.getAllByText('محاكاة')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'إيقاف التتبّع' })).toBeInTheDocument()
  })

  it('says «لا يوجد رصد» for an empty timeline in Arabic', async () => {
    setupDetail({ language: 'ar', journey: () => jsonResponse(makeVisitJourney({ timeline: [], timeline_total: 0 })) })
    expect(await screen.findByText('لا يوجد رصد')).toBeInTheDocument()
  })
})
