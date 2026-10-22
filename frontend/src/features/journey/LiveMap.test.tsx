import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { routes } from '../../test/appRoutes'
import { makeVisit, page } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { Role, TrackingAlert } from '../../types/api'
import {
  alertSummaryRoute,
  FLOOR_3,
  FLOOR_3_AREAS,
  FLOOR_4,
  FLOOR_4_PLACE,
  makeAlert,
  makeJourneyItem,
  makeLiveJourneys,
  makeLiveVisitor,
  makeLocationTree,
  makeStay,
  makeTower,
  makeTrackedMe,
  makeTrackingStatus,
  makeVisitJourney,
  otherVisit,
  SERVER_PLACE,
  SERVER_ROOM,
  TOWER,
  VISIT_ID,
} from './testRoutes'

/** 12:00 in Amman; the server answered at the same moment. */
const NOW = new Date('2026-10-20T09:00:00Z')
const empty = () => jsonResponse(makeLocationTree([]))
const ALERT_REF = { id: 'a1e00000-0000-4000-8000-000000000001', type: 'UNAUTHORIZED_AREA' as const, status: 'OPEN' as const }
/** A second building, with one floor and one zone. */
const ANNEX_ID = 'b1000000-0000-4000-8000-000000000002'
const ANNEX_FLOOR = { id: 'f2000000-0000-4000-8000-000000000001', name: 'Annex hall', name_ar: null, level: 0 }
const ANNEX_ZONE = { id: 'z2000000-0000-4000-8000-000000000001', name: 'Annex lobby', name_ar: null, access: 'STANDARD' as const }
const ANNEX_STAMP = { created_at: '2026-10-19T08:00:00Z', updated_at: '2026-10-19T08:00:00Z' }
const ANNEX = {
  ...makeTower(),
  id: ANNEX_ID,
  name: 'Annex',
  name_ar: null,
  floors: [{ ...ANNEX_FLOOR, building_id: ANNEX_ID, is_active: true, ...ANNEX_STAMP, zones: [{ ...ANNEX_ZONE, floor_id: ANNEX_FLOOR.id, is_active: true, ...ANNEX_STAMP }] }],
}
const ANNEX_PLACE = { building: { id: ANNEX_ID, name: 'Annex', name_ar: null }, floor: ANNEX_FLOOR, zone: ANNEX_ZONE }

/** Whether Maya is under "No location", and the "Not tracked" line. */
function asideShown() {
  return [within(document.querySelector('[data-no-location]') as HTMLElement).queryByRole('button', { name: 'Maya Odeh' }) !== null, document.querySelector('[data-not-tracked]')?.textContent]
}

/** Maya's chip in the server room's tile. */
function chipInServerRoom() {
  return document.querySelector(`[data-zone-tile="${SERVER_ROOM.id}"] [data-live-chip="${VISIT_ID}"]`)
}

function liveRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/journeys/live')
}

/** Maya (floor 3, lobby), Omar (floor 4, open office, an open alert), Lina (starting), Basel (not started), Rana (not recent). */
function everyone() {
  return makeLiveJourneys([
    makeLiveVisitor(),
    makeLiveVisitor({ visit: otherVisit(2, 'Omar Saleh'), last_location: FLOOR_4_PLACE, alert: ALERT_REF }),
    makeLiveVisitor({ visit: otherVisit(3, 'Lina Haddad'), state: 'PENDING', last_location: null, last_observed_at: null, freshness_seconds: null }),
    makeLiveVisitor({ visit: otherVisit(4, 'Basel Nasser'), state: 'NOT_ENROLLED', last_location: null, last_observed_at: null, freshness_seconds: null }),
    makeLiveVisitor({ visit: otherVisit(5, 'Rana Odeh'), state: 'STALE', freshness_seconds: 720 }),
  ])
}

function setupMap({
  roles = ['RECEPTIONIST'] as Role[],
  live = () => jsonResponse(everyone()),
  locations = () => jsonResponse(makeLocationTree()),
  status = () => jsonResponse(makeTrackingStatus()),
  extra = {},
  path = '/journey',
  language = null,
}: { roles?: Role[]; live?: RouteHandler; locations?: RouteHandler; status?: RouteHandler; extra?: Record<string, RouteHandler>; path?: string; language?: 'ar' | null } = {}) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeTrackedMe(roles, { preferred_language: language })),
    'GET /tracking/status': status,
    'GET /journeys/live': live,
    'GET /locations': locations,
    ...alertSummaryRoute(),
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

/** The panel's journey: Maya allowed on floor 3, seen on floor 4 (outside) after the lobby, with an open alert. */
function panelJourney(alert: TrackingAlert = makeAlert()) {
  return makeVisitJourney({
    alerts: [alert],
    path: [makeStay(), makeStay({ location: FLOOR_4_PLACE, from: '2026-10-20T08:50:00Z', to: '2026-10-20T08:56:00Z', observations: 2, allowed: false })],
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await i18n.changeLanguage('en')
})

describe('Visitor Journey: the live map', () => {
  it('draws everyone inside on the building’s floors, highest first, in their zones; who has no place and who is not tracked beside them', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const { requests } = setupMap()

    const floors = await screen.findByRole('region', { name: 'Floors of North Tower' })
    expect(within(screen.getByRole('tablist', { name: 'View' })).getByRole('tab', { name: 'Live map' })).toHaveAttribute('aria-selected', 'true')
    // The whole company's (F16-36): the map places each visitor in their building itself.
    expect([...liveRequests(requests).at(-1)!.url.searchParams]).toEqual([])
    // The header says when the server answered (company time, to the second) and how many are inside.
    expect(screen.getByRole('heading', { level: 1, name: 'Visitor Journey' }).closest('header')).toHaveTextContent('Updated 12:00:00')
    expect(screen.getByRole('heading', { level: 1, name: 'Visitor Journey' }).closest('header')).toHaveTextContent('5 visitors')

    const bands = within(floors).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(bands).toEqual(['Floor 4', 'Floor 3', 'Ground floor'])
    const floor3 = floors.querySelector(`[data-floor-band="${FLOOR_3.id}"]`) as HTMLElement
    expect(floor3).toHaveTextContent('2 visitors')
    // The band's header is the floor's name and its count, nothing else: no bare level, which read as a count (the owner, F16-32).
    const header = floor3.querySelector('header') as HTMLElement
    expect([...header.children].map((child) => child.textContent)).toEqual(['Floor 3', '2 visitors'])
    const lobby = within(floor3).getByRole('region', { name: 'Lobby' })
    expect(within(lobby).getByRole('button', { name: 'Maya Odeh' })).toBeInTheDocument()
    // A restricted zone and a common one are marked; a standard one is not.
    expect(within(floors).getByRole('region', { name: 'Server room' }).querySelector('[data-zone-access="RESTRICTED"]')).toHaveTextContent('Restricted')
    expect(within(floors).getByRole('region', { name: 'Reception' }).querySelector('[data-zone-access="COMMON"]')).toHaveTextContent('Common')
    expect(lobby.querySelector('[data-zone-access]')).toBeNull()

    const noLocation = document.querySelector('[data-no-location]') as HTMLElement
    expect(within(noLocation).getByRole('button', { name: 'Lina Haddad' })).toBeInTheDocument()
    expect(document.querySelector('[data-not-tracked]')).toHaveTextContent('Not tracked1')
    // Simulated once: in the page's line, while the simulator is the provider; never on a chip.
    expect(document.querySelectorAll('main [data-simulated]')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Tracking' }).querySelector('[data-simulated]')).not.toBeNull()
  })

  it('draws a visitor with an active alert in the alerts’ red, and a place that is not recent dashed with how long ago', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setupMap()
    const floors = await screen.findByRole('region', { name: 'Floors of North Tower' })

    const omar = within(floors).getByRole('button', { name: 'Omar Saleh, Alert' })
    expect(omar).toHaveAttribute('data-chip-alert', 'OPEN')
    expect(omar).toHaveClass('bg-danger-surface', 'text-danger-text')
    expect(omar.closest('[data-floor-band]')).toHaveAttribute('data-floor-band', FLOOR_4.id)

    const rana = within(floors).getByRole('button', { name: 'Rana Odeh, Not recent, 12m ago' })
    expect(rana).toHaveClass('border-dashed')
    expect(rana.querySelector('[data-freshness]')).toHaveTextContent('12m')
  })

  it('marks a simulated visitor on its chip when the page itself does not say Simulated', async () => {
    setupMap({ status: () => jsonResponse(makeTrackingStatus({ provider: 'disabled', simulated: false, available: false, healthy: false })) })
    const floors = await screen.findByRole('region', { name: 'Floors of North Tower' })
    await waitFor(() => expect(screen.getByRole('region', { name: 'Tracking' })).toHaveTextContent('No tracking provider'))
    expect(within(floors).getByRole('button', { name: 'Maya Odeh, Simulated' }).querySelector('[data-simulated]')).not.toBeNull()
  })

  it('offers the buildings when there are several, the chosen one kept in the address, from one answer for the whole company', async () => {
    const { requests, router, user } = setupMap({
      locations: () => jsonResponse(makeLocationTree([makeTower(), ANNEX])),
      live: () => jsonResponse(makeLiveJourneys([makeLiveVisitor(), makeLiveVisitor({ visit: otherVisit(2, 'Omar Saleh'), last_location: ANNEX_PLACE })])),
    })
    const choice = await screen.findByRole('combobox', { name: 'Building' })
    expect(within(choice).getAllByRole('option').map((option) => option.textContent)).toEqual(['North Tower', 'Annex'])
    const tower = await screen.findByRole('region', { name: 'Floors of North Tower' })
    expect(within(tower).getByRole('button', { name: 'Maya Odeh' })).toBeInTheDocument()
    expect(within(tower).queryByRole('button', { name: 'Omar Saleh' })).toBeNull()

    await user.selectOptions(choice, 'Annex')
    expect(router.state.location.search).toBe(`?building=${ANNEX_ID}`)
    const annex = await screen.findByRole('region', { name: 'Floors of Annex' })
    expect(within(annex).getByRole('button', { name: 'Omar Saleh' })).toBeInTheDocument()
    expect(within(annex).queryByRole('button', { name: 'Maya Odeh' })).toBeNull()
    expect(liveRequests(requests).every((request) => !request.url.searchParams.has('building_id'))).toBe(true)
  })

  it('draws a visitor last seen in a building it cannot show (archived) on the building shown, in a band of its own marked Archived (F16-36)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setupMap({
      locations: () => jsonResponse(makeLocationTree([makeTower(), { ...ANNEX, is_active: false }])),
      live: () => jsonResponse(makeLiveJourneys([makeLiveVisitor({ visit: otherVisit(2, 'Omar Saleh'), state: 'STALE', freshness_seconds: 900, last_location: ANNEX_PLACE })])),
    })
    const floors = await screen.findByRole('region', { name: 'Floors of North Tower' })
    expect(screen.queryByRole('heading', { name: 'Nobody inside' })).toBeNull()
    const band = within(floors).getByRole('region', { name: /^Annex,\s?Annex hall$/ })
    expect(band.querySelector('header')).toHaveTextContent('Archived')
    expect(within(band).getByRole('button', { name: 'Omar Saleh, Not recent, 15m ago' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Visitor Journey' }).closest('header')).toHaveTextContent('1 visitor')
  })

  it('lists "No location" and counts "Not tracked" for the whole company, whichever building is shown', async () => {
    const { user } = setupMap({
      locations: () => jsonResponse(makeLocationTree([makeTower(), ANNEX])),
      live: () =>
        jsonResponse(
          makeLiveJourneys([
            makeLiveVisitor({ state: 'UNAVAILABLE', last_location: ANNEX_PLACE }),
            makeLiveVisitor({ visit: otherVisit(2, 'Omar Saleh'), state: 'DISABLED', last_location: ANNEX_PLACE }),
          ]),
        ),
    })
    await screen.findByRole('region', { name: 'Floors of North Tower' })
    expect(asideShown()).toEqual([true, 'Not tracked1'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Building' }), 'Annex')
    await screen.findByRole('region', { name: 'Floors of Annex' })
    expect(asideShown()).toEqual([true, 'Not tracked1'])
  })

  it('says when no place is set up yet, with the way to set them up for an administrator only', async () => {
    const admin = setupMap({ roles: ['SYSTEM_ADMIN'], locations: empty })
    expect(await screen.findByRole('heading', { name: 'No locations yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set up locations' })).toHaveAttribute('href', '/admin/tracking?tab=locations')
    expect(liveRequests(admin.requests)).toEqual([])
    admin.unmount()

    setupMap({ locations: empty })
    expect(await screen.findByRole('heading', { name: 'No locations yet' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Set up locations' })).toBeNull()
  })

  it('says when nobody is inside', async () => {
    setupMap({ live: () => jsonResponse(makeLiveJourneys([])) })
    expect(await screen.findByRole('heading', { name: 'Nobody inside' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Floors of North Tower' })).toBeNull()
  })

  it('never says "Nobody inside" while visitors are in another building: the empty building’s floors are drawn', async () => {
    setupMap({
      locations: () => jsonResponse(makeLocationTree([makeTower(), ANNEX])),
      live: () => jsonResponse(makeLiveJourneys([makeLiveVisitor({ last_location: ANNEX_PLACE })])),
    })
    const floors = await screen.findByRole('region', { name: 'Floors of North Tower' })
    expect(within(floors).queryAllByRole('button')).toEqual([])
    expect(screen.queryByRole('heading', { name: 'Nobody inside' })).toBeNull()
  })

  it('says when the answer was cut at the server’s limit', async () => {
    setupMap({ live: () => jsonResponse(makeLiveJourneys([makeLiveVisitor()], { truncated: true })) })
    await screen.findByRole('region', { name: 'Floors of North Tower' })
    expect(screen.getByText('First 1 shown')).toBeInTheDocument()
  })

  it('draws an uncertain place dashed with its sign, and a visitor whose alert is acknowledged still in the alerts’ red', async () => {
    setupMap({
      live: () =>
        jsonResponse(
          makeLiveJourneys([
            makeLiveVisitor({ visit: otherVisit(6, 'Hana Saleh'), state: 'UNCERTAIN' }),
            makeLiveVisitor({ visit: otherVisit(7, 'Sami Khoury'), last_location: FLOOR_4_PLACE, alert: { ...ALERT_REF, status: 'ACKNOWLEDGED' } }),
          ]),
        ),
    })
    const floors = await screen.findByRole('region', { name: 'Floors of North Tower' })
    const hana = within(floors).getByRole('button', { name: 'Hana Saleh, Uncertain' })
    expect(hana).toHaveClass('border-dashed')
    expect(hana).toHaveAttribute('data-chip-state', 'UNCERTAIN')
    const sami = within(floors).getByRole('button', { name: 'Sami Khoury, Alert' })
    expect(sami).toHaveAttribute('data-chip-alert', 'ACKNOWLEDGED')
    expect(sami).toHaveClass('bg-danger-surface')
  })

  it('asks again only as background refreshes: every live, status and panel request after the first carries X-Background-Refresh (F16-37)', async () => {
    const { requests, queryClient, user } = setupMap({ extra: { [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(panelJourney()) } })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))
    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    await waitFor(() => expect(panel.querySelector('[data-journey-path]')).not.toBeNull())
    await act(() => queryClient.invalidateQueries({ queryKey: ['journeys'] }))
    await act(() => queryClient.invalidateQueries({ queryKey: ['tracking', 'status'] }))

    const sent = (path: string) => requests.filter((request) => request.method === 'GET' && request.path === path).map((request) => request.headers.get('X-Background-Refresh'))
    for (const path of ['/journeys/live', '/tracking/status', `/visits/${VISIT_ID}/journey`]) {
      // The first is the person's own; at least one more, each a background refresh.
      expect({ path, sent: sent(path) }).toEqual({ path, sent: [null, '1', ...sent(path).slice(2).map(() => '1')] })
    }
  })

  it('switches to the list and back, in the address', async () => {
    const { router, user } = setupMap({ extra: { 'GET /journeys': () => jsonResponse(page([makeJourneyItem()])) } })
    await screen.findByRole('region', { name: 'Floors of North Tower' })
    await user.click(screen.getByRole('tab', { name: 'List' }))
    expect(await screen.findByRole('table', { name: 'Visitor Journey' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?view=list')
    expect(screen.getByRole('tabpanel', { name: 'List' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Live map' }))
    expect(await screen.findByRole('region', { name: 'Floors of North Tower' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('')
  })

  it('keeps the focus on the view’s tab across a switch, which mounts the other view’s tab list (F16-40)', async () => {
    const { user } = setupMap({ extra: { 'GET /journeys': () => jsonResponse(page([makeJourneyItem()])) } })
    await screen.findByRole('region', { name: 'Floors of North Tower' })
    // A first load leaves the focus where it is.
    expect(screen.getByRole('tab', { name: 'Live map' })).not.toHaveFocus()
    act(() => screen.getByRole('tab', { name: 'Live map' }).focus())
    await user.keyboard('{ArrowRight}')
    await screen.findByRole('table', { name: 'Visitor Journey' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'List' })).toHaveFocus())

    await user.keyboard('{ArrowLeft}')
    await screen.findByRole('region', { name: 'Floors of North Tower' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Live map' })).toHaveFocus())
  })

  it('says when the map cannot be loaded, with a retry', async () => {
    setupMap({ live: () => errorResponse(500, 'INTERNAL_ERROR', 'Boom') })
    expect(await screen.findByText('The live map could not be loaded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('Visitor Journey: a visitor’s panel on the live map', () => {
  it('opens on a chip: the visitor, the host, the inferred place, the allowed areas, the path (outside in red), the alert, the full journey', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const { user } = setupMap({ extra: { [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(panelJourney()) } })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))

    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    expect(panel).toHaveTextContent('Cedar Advisory')
    expect(panel).toHaveTextContent('HostOmar Khalil')
    expect(panel.querySelector('[data-panel-facts]')).toHaveTextContent('Inferred locationFloor 3,Lobby')
    expect(panel).toHaveTextContent('North Tower · 11:56 · 4m ago')
    expect(panel.querySelector('[data-allowed-floor]')).toHaveTextContent('Floor 3')

    await waitFor(() => expect(panel.querySelector('[data-journey-path]')).not.toBeNull())
    const stays = panel.querySelector('[data-journey-path]')!.querySelectorAll('li')
    expect(stays).toHaveLength(2)
    expect(stays[0]).toHaveAttribute('data-stay-allowed', 'true')
    expect(stays[1]).toHaveAttribute('data-stay-allowed', 'false')
    expect(stays[1]).toHaveTextContent('Floor 4,Open office')
    // A word joiner after the dash keeps the range on one line (joinTimeRange).
    expect(stays[1]).toHaveTextContent('11:50–\u206011:56')
    expect(stays[1]).toHaveTextContent('2 observations')
    expect(stays[1]).toHaveTextContent('Outside allowed area')

    const alert = panel.querySelector('[data-panel-alert]') as HTMLElement
    expect(alert).toHaveTextContent('Unauthorized area')
    expect(alert).toHaveTextContent('Open')
    expect(within(alert).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Full journey' })).toHaveAttribute('href', `/journey/${VISIT_ID}`)
  })

  it('acknowledges the alert with a note, and asks again for the alerts and the journeys', async () => {
    const acknowledged = makeAlert({ status: 'ACKNOWLEDGED', acknowledged_at: '2026-10-20T08:59:00Z', acknowledged_by: { id: 'u2', full_name: 'Lina Haddad' }, note: 'Escorted back' })
    let journey = panelJourney()
    const { requests, user } = setupMap({
      extra: {
        [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(journey),
        [`POST /tracking/alerts/${acknowledged.id}/acknowledge`]: () => {
          journey = panelJourney(acknowledged)
          return jsonResponse(acknowledged)
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))
    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    await user.click(await within(panel).findByRole('button', { name: 'Acknowledge' }))

    const dialog = await screen.findByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), 'Escorted back')
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })).toBeNull())
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({ note: 'Escorted back' })
    expect(await within(panel).findByText('Acknowledged', { selector: '[data-alert-status] *' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    expect(within(panel).getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
    expect(panel).toHaveTextContent('Escorted back')
  })

  it('resolves the alert from the panel: the alert leaves the panel and the focus stays in it (F16-34)', async () => {
    const resolved = makeAlert({ status: 'RESOLVED', resolution: 'MANUAL', resolved_at: '2026-10-20T09:00:00Z', resolved_by: { id: 'u2', full_name: 'Lina Haddad' }, can_act: false })
    let journey = panelJourney()
    const { user } = setupMap({
      extra: {
        [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(journey),
        [`POST /tracking/alerts/${resolved.id}/resolve`]: () => {
          journey = panelJourney(resolved)
          return jsonResponse(resolved)
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))
    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    await user.click(await within(panel).findByRole('button', { name: 'Resolve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve the alert for Maya Odeh?' })
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))

    await waitFor(() => expect(panel.querySelector('[data-panel-alert]')).toBeNull())
    await waitFor(() => expect(panel).toHaveFocus())
  })

  it('keeps a refusal in its dialog while the alert leaves the panel, until it is closed (F16-33)', async () => {
    const resolved = makeAlert({ status: 'RESOLVED', resolution: 'RETURNED', resolved_at: '2026-10-20T08:59:00Z', can_act: false })
    let journey = panelJourney()
    const { queryClient, user } = setupMap({
      extra: {
        [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(journey),
        [`POST /tracking/alerts/${resolved.id}/acknowledge`]: () => {
          journey = panelJourney(resolved)
          return errorResponse(409, 'ALERT_RESOLVED', 'This alert is already resolved.')
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))
    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    await user.click(await within(panel).findByRole('button', { name: 'Acknowledge' }))
    const dialog = await screen.findByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }))
    expect(await within(dialog).findByText('This alert is already resolved.')).toBeInTheDocument()

    // The panel's own refresh (every 15 s) brings the resolved alert meanwhile.
    await act(() => queryClient.invalidateQueries({ queryKey: ['journeys'] }))
    await waitFor(() => expect(panel.querySelector('[data-panel-alert]')).toBeNull())
    expect(within(dialog).getByText('This alert is already resolved.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Acknowledge the alert for Maya Odeh?' })).toBeNull()
    await waitFor(() => expect(panel).toHaveFocus())
  })

  it('gives the focus back to the visitor’s chip on closing, also when the refresh moved them to another zone (F16-41)', async () => {
    let visitors = everyone()
    const { queryClient, user } = setupMap({
      live: () => jsonResponse(visitors),
      extra: { [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(panelJourney()) },
    })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))
    await screen.findByRole('dialog', { name: 'Maya Odeh' })
    visitors = makeLiveJourneys([makeLiveVisitor({ last_location: SERVER_PLACE })])
    await act(() => queryClient.invalidateQueries({ queryKey: ['journeys', 'live'] }))
    await waitFor(() => expect(chipInServerRoom()).not.toBeNull())

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Maya Odeh' })).toBeNull()
    await waitFor(() => expect(chipInServerRoom()).toHaveFocus())
  })

  it('changes the allowed areas from the panel (reception): the panel and the map are asked again and show the new areas', async () => {
    const widened = { floors: [...FLOOR_3_AREAS.floors, { ...FLOOR_4, building: TOWER, is_active: true }], zones: [] }
    let journey = panelJourney()
    const { requests, user } = setupMap({
      extra: {
        [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(journey),
        [`PUT /visits/${VISIT_ID}/access-areas`]: () => {
          journey = makeVisitJourney({ alerts: [makeAlert({ status: 'RESOLVED', resolution: 'AREAS_CHANGED', resolved_at: '2026-10-20T09:00:00Z', can_act: false })], access_areas: widened })
          return jsonResponse(makeVisit({ id: VISIT_ID, status: 'CHECKED_IN', access_areas: widened }))
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Maya Odeh' }))
    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    await waitFor(() => expect(panel.querySelector('[data-panel-alert]')).not.toBeNull())
    await user.click(await within(panel).findByRole('button', { name: 'Edit allowed areas' }))
    const dialog = await screen.findByRole('dialog', { name: 'Allowed areas of Maya Odeh' })
    expect(within(dialog).getByRole('checkbox', { name: 'Floor 3' })).toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Floor 4' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({ floor_ids: [FLOOR_3.id, FLOOR_4.id], zone_ids: [] }))

    const put = requests.findIndex((request) => request.method === 'PUT')
    await waitFor(() => expect(requests.slice(put).some((request) => request.method === 'GET' && request.path === `/visits/${VISIT_ID}/journey`)).toBe(true))
    await waitFor(() => expect(requests.slice(put).some((request) => request.method === 'GET' && request.path === '/journeys/live')).toBe(true))
    await waitFor(() => expect([...panel.querySelectorAll('[data-allowed-floor]')].map((floor) => floor.textContent)).toEqual(['Floor 3', 'Floor 4']))
    expect(panel.querySelector('[data-panel-alert]')).toBeNull()
  })

  it('offers management neither an alert’s actions nor a change of the areas', async () => {
    setupMap({
      roles: ['MANAGEMENT'],
      extra: { [`GET /visits/${VISIT_ID}/journey`]: () => jsonResponse(makeVisitJourney({ alerts: [makeAlert({ can_act: false })], can_edit_access_areas: false })) },
    })
    const chip = await screen.findByRole('button', { name: 'Maya Odeh' })
    chip.click()
    const panel = await screen.findByRole('dialog', { name: 'Maya Odeh' })
    await waitFor(() => expect(panel.querySelector('[data-panel-alert]')).not.toBeNull())
    expect(within(panel).queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Resolve' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Edit allowed areas' })).toBeNull()
  })

  it('reads in Arabic', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setupMap({ language: 'ar' })
    expect(await screen.findByRole('tab', { name: 'الخريطة الحية' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'القائمة' })).toBeInTheDocument()
    const floors = await screen.findByRole('region', { name: 'طوابق البرج الشمالي' })
    expect(within(floors).getByRole('heading', { name: 'الطابق الرابع' })).toBeInTheDocument()
    expect(within(floors).getByRole('region', { name: 'غرفة الخوادم' })).toHaveTextContent('مقيّدة')
    expect(within(floors).getByRole('button', { name: 'Omar Saleh، تنبيه' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'بدون موقع' })).toBeInTheDocument()
    expect(document.querySelector('[data-not-tracked]')).toHaveTextContent('غير متتبَّع')
    expect(screen.getByRole('heading', { level: 1 }).closest('header')).toHaveTextContent('حُدّثت 12:00:00')
    expect(screen.getByRole('heading', { level: 1 }).closest('header')).toHaveTextContent('5 زوار')
    expect(SERVER_ROOM.name_ar).toBe('غرفة الخوادم')
  })
})
