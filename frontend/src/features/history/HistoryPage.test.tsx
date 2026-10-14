import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { FINANCE, LEGAL, makeHost, makeVisit, page } from '../../test/fixtures'
import { recordAddresses, renderRoutes } from '../../test/render'
import type { Role, Visit } from '../../types/api'

const HOST = makeHost()

const overrideVisit = makeVisit({
  id: '5a1b2c3d-0000-4000-8000-000000000011',
  status: 'CHECKED_OUT',
  visitor: { id: 'v-1', full_name: 'Élodie Martin', company_name: 'Orbit Labs' },
  host: { id: HOST.id, full_name: HOST.full_name, phone: HOST.phone },
  department: { id: LEGAL.id, name: LEGAL.name, name_ar: null },
  purpose: 'Contract signing',
  check_in_at: '2026-10-06T06:05:00Z',
  check_in_method: 'OVERRIDE',
  check_in_note: 'Arrived early',
  check_out_at: '2026-10-06T07:15:00Z',
  check_out_method: 'CORRECTED',
  check_out_note: 'Left without scanning',
  duration_seconds: 4200,
})

const walkIn = makeVisit({
  id: '5a1b2c3d-0000-4000-8000-000000000012',
  status: 'CHECKED_OUT',
  visitor: { id: 'v-2', full_name: 'Karim Saleh', company_name: null },
  department: null,
  is_walk_in: true,
  walk_in_reason: 'DELIVERY',
  check_in_at: '2026-10-05T08:00:00Z',
  check_in_method: 'WALK_IN',
  check_out_at: '2026-10-06T07:00:00Z',
  check_out_method: 'BULK',
  check_out_note: 'Stale',
  duration_seconds: 82800,
})

function visitRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/visits')
}

function lastQuery(requests: RecordedRequest[]) {
  return Object.fromEntries(visitRequests(requests).at(-1)!.url.searchParams)
}

function setup({
  roles = ['MANAGEMENT'],
  path = '/history',
  visits = () => jsonResponse(page([overrideVisit, walkIn])),
  extra = {},
}: { roles?: Role[]; path?: string; visits?: RouteHandler; extra?: Record<string, RouteHandler> } = {}) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(roles)), 'GET /visits': visits, ...extra })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Visit history page', () => {
  it('lists every visit of the company, newest first, with method badges', async () => {
    const { requests } = setup()

    const table = await screen.findByRole('table', { name: 'Visit history' })
    expect(lastQuery(requests)).toEqual({ scope: 'all', order: 'desc', page: '1', page_size: '25' })

    const rows = within(table).getAllByRole('row')
    const first = rows[1]!
    expect(within(first).getByRole('link', { name: 'Élodie Martin' })).toHaveAttribute('href', `/visits/${overrideVisit.id}`)
    expect(first).toHaveTextContent('Orbit Labs')
    expect(first).toHaveTextContent('Omar Khalil')
    // The department is a muted second line under the host, not a column of its own.
    const host = within(first).getByText('Omar Khalil')
    expect(host.nextElementSibling).toHaveTextContent('Legal')
    expect(within(table).queryByRole('columnheader', { name: 'Department' })).toBeNull()
    expect(first).toHaveTextContent('Contract signing')
    // Attendance in two short lines: the times, then the time on site.
    expect(within(first).getByText('In 09:05 · Out 10:15')).toBeInTheDocument()
    expect(within(first).getByText('1h 10m')).toBeInTheDocument()
    // Times in the company time zone (Amman, UTC+3), not the browser's (UTC in tests).
    expect(first).toHaveTextContent('09:05')
    expect(first).toHaveTextContent('10:15')
    expect(first).toHaveTextContent('1h 10m')
    expect(within(first).getByText('Checked out')).toBeInTheDocument()
    expect(within(first).getByText('Override')).toBeInTheDocument()
    expect(within(first).getByText('Corrected check-out')).toBeInTheDocument()

    const second = rows[2]!
    expect(within(second).getByText('Walk-in')).toBeInTheDocument()
    expect(within(second).getByText('Bulk check-out')).toBeInTheDocument()
    // A check-in on another day than the visit's own shows its date.
    expect(second).toHaveTextContent('Mon, 5 Oct 2026, 11:00')

    // A badge is its icon and name: no tooltip and no legend explaining the methods (decision 3).
    expect(within(first).getByText('Override').closest('[title]')).toBeNull()
    expect(screen.queryByText('Checked in by reception with an override and a reason.')).toBeNull()
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument()
    // The header says how many visits the view holds, as a fact.
    const header = screen.getByRole('heading', { level: 1, name: 'Visit history' }).closest('header') as HTMLElement
    expect(header).toHaveTextContent('2 visits')
  })

  it('shows no notes: no page description, time zone, field hints or empty-state sentences', async () => {
    setup({ path: '/history?status=NO_SHOW', visits: () => jsonResponse(page<Visit>([])) })
    const empty = await screen.findByRole('heading', { name: 'No visits match these filters' })
    for (const note of [/Every visit of/, /Times are/, /Amman time/, /Active hosts/, /Visitor, company or host name./, /Try a wider/]) {
      expect(screen.queryByText(note)).toBeNull()
    }
    // The empty state is a title, an icon and its action.
    expect(empty.parentElement!.querySelector('p')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Host' })).toHaveAccessibleDescription('')
    // Every filter names its "all" state when empty, as the department's does (review).
    expect(screen.getByRole('combobox', { name: 'Host' })).toHaveAttribute('placeholder', 'All hosts')
    // The search says what it searches in its placeholder, not in a line under the field.
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveAttribute('placeholder', 'Visitor, company, host')
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveAccessibleDescription('')
  })

  it('dates a visit of this year without its year, an older one with it', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T09:00:00Z'), toFake: ['Date'] })
    const lastYear = makeVisit({
      id: '5a1b2c3d-0000-4000-8000-000000000014',
      visitor: { id: 'v-4', full_name: 'Rana Obeidat', company_name: null },
      scheduled_start: '2025-12-30T07:00:00Z',
      scheduled_end: '2025-12-30T08:00:00Z',
      window_start: '2025-12-30T06:00:00Z',
      window_end: '2025-12-30T09:00:00Z',
    })
    setup({ visits: () => jsonResponse(page([overrideVisit, lastYear])) })
    const table = await screen.findByRole('table', { name: 'Visit history' })
    const [, thisYearRow, lastYearRow] = within(table).getAllByRole('row')
    expect(within(thisYearRow!).getByText('Tue, 6 Oct')).toBeInTheDocument()
    expect(within(thisYearRow!).getByText('09:00–\u206010:00')).toBeInTheDocument()
    expect(within(lastYearRow!).getByText('Tue, 30 Dec 2025')).toBeInTheDocument()
  })

  it('tints the rows of visitors inside the building now, whose status chip says so', async () => {
    const inside = makeVisit({
      id: '5a1b2c3d-0000-4000-8000-000000000013',
      status: 'CHECKED_IN',
      visitor: { id: 'v-3', full_name: 'Hind Khatib', company_name: 'Al Bayan' },
      check_in_at: '2026-10-06T06:05:00Z',
      check_in_method: 'QR',
    })
    setup({ visits: () => jsonResponse(page([inside, walkIn])) })
    const table = await screen.findByRole('table', { name: 'Visit history' })
    const [, insideRow, doneRow] = within(table).getAllByRole('row')
    expect(insideRow).toHaveAttribute('data-highlighted', 'true')
    expect(within(insideRow!).getByText('Checked in')).toBeInTheDocument()
    expect(doneRow).not.toHaveAttribute('data-highlighted')
  })

  it('sends the filters in the URL and shows them in the controls', async () => {
    const { requests, router } = setup({
      path: `/history?from=2026-09-01&to=2026-09-30&status=NO_SHOW,CANCELLED&q=orbit&department=${LEGAL.id}&host=${HOST.id}&hostName=Omar%20Khalil&page=2`,
      visits: () => jsonResponse(page([], { page: 2, total: 30 })),
      extra: { 'GET /departments': () => jsonResponse([FINANCE, LEGAL]), 'GET /users/hosts': () => jsonResponse([HOST]) },
    })

    await screen.findByRole('heading', { level: 1, name: 'Visit history' })
    await waitFor(() => expect(visitRequests(requests)).toHaveLength(1))
    expect(lastQuery(requests)).toEqual({
      scope: 'all',
      order: 'desc',
      page: '2',
      page_size: '25',
      date_from: '2026-09-01',
      date_to: '2026-09-30',
      status: 'NO_SHOW,CANCELLED',
      q: 'orbit',
      department_id: LEGAL.id,
      host_id: HOST.id,
    })

    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('orbit')
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01')
    expect(screen.getByLabelText('To')).toHaveValue('2026-09-30')
    // The dates are one group, named for assistive technology; the header reads them back in the app's format.
    expect(screen.getByRole('group', { name: 'Scheduled date' })).toContainElement(screen.getByLabelText('To'))
    const header = screen.getByRole('heading', { level: 1, name: 'Visit history' }).closest('header') as HTMLElement
    expect(header).toHaveTextContent('30 visits')
    expect(header).toHaveTextContent('From Tue, 1 Sep 2026 to Wed, 30 Sep 2026')
    // The host's name as the directory returns it for that ID (looked up by the URL's name).
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Host' })).toHaveValue('Omar Khalil'))
    expect(requests.find((request) => request.path === '/users/hosts')?.url.searchParams.get('q')).toBe('Omar Khalil')
    expect(await screen.findByDisplayValue('Legal')).toBe(screen.getByRole('combobox', { name: 'Department' }))
    expect(screen.getByRole('checkbox', { name: 'No-show' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Cancelled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Scheduled' })).not.toBeChecked()
    // Management reads the active departments only (`include_inactive` is for administrators).
    expect(requests.find((request) => request.path === '/departments')?.url.search).toBe('')
    // A link of an earlier version: the search text and the host's name leave the address (SEC-20).
    await waitFor(() =>
      expect(router.state.location.search).toBe(`?from=2026-09-01&to=2026-09-30&status=NO_SHOW%2CCANCELLED&department=${LEGAL.id}&host=${HOST.id}&page=2`),
    )
    expect(router.state.location.state).toEqual({ view: { owner: makeMe().user.id, values: { q: 'orbit', hostName: 'Omar Khalil' } } })
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('orbit')
  })

  it('never shows a host name from the URL that the server does not give for that host', async () => {
    const other = makeHost({ id: '7f0d1c0e-1111-4a5b-9c1d-0000000000cc', full_name: 'Sami Admin' })
    const { requests } = setup({
      // A crafted link: Omar's ID under another name.
      path: `/history?host=${HOST.id}&hostName=Sami%20Admin`,
      extra: { 'GET /users/hosts': () => jsonResponse([other]) },
    })
    await screen.findByRole('table', { name: 'Visit history' })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Host' })).toHaveValue('Selected host'))
    expect(screen.getByRole('combobox', { name: 'Host' })).not.toHaveValue('Sami Admin')
    // The list is still filtered by the ID.
    expect(lastQuery(requests).host_id).toBe(HOST.id)
  })

  it('applies filter changes to the URL and the request, starting again at page 1', async () => {
    const { requests, router, user } = setup({ path: '/history?page=2' })
    await screen.findByRole('table', { name: 'Visit history' })
    const addresses = recordAddresses(router)

    await user.click(screen.getByRole('checkbox', { name: 'Checked out' }))
    await waitFor(() => expect(lastQuery(requests).status).toBe('CHECKED_OUT'))
    expect(lastQuery(requests).page).toBe('1')
    expect(router.state.location.search).toBe('?status=CHECKED_OUT')

    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'élodie')
    await waitFor(() => expect(lastQuery(requests).q).toBe('élodie'))
    // The search text is kept with the history entry, never in the address (SEC-20).
    expect(router.state.location.search).toBe('?status=CHECKED_OUT')
    expect(addresses.filter((address) => address.includes('q='))).toEqual([])

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    await waitFor(() => expect(lastQuery(requests).date_from).toBe('2026-10-01'))
    expect(new URLSearchParams(router.state.location.search).get('from')).toBe('2026-10-01')
  })

  it('searches from three characters and says so before that', async () => {
    const { requests, user } = setup()
    await screen.findByRole('table', { name: 'Visit history' })
    const search = screen.getByRole('searchbox', { name: 'Search' })

    await user.type(search, 'el')
    await waitFor(() => expect(search).toHaveAccessibleDescription(/Type at least 3 characters to search\./))
    // Committed to the page's view, but not sent: two characters have no trigram to look up (B57-65).
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(visitRequests(requests).every((request) => !request.url.searchParams.has('q'))).toBe(true)

    await user.type(search, 'i')
    await waitFor(() => expect(lastQuery(requests).q).toBe('eli'))
    // Searchable: the minimum is no longer said, and no other line takes its place.
    expect(search).toHaveAccessibleDescription('')
  })

  it('explains an end date before the start date and makes no request for it', async () => {
    const { requests } = setup({ path: '/history?from=2026-10-05' })
    await screen.findByRole('table', { name: 'Visit history' })
    const before = visitRequests(requests).length

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } })

    expect(await screen.findByRole('heading', { name: 'Check the dates' })).toBeInTheDocument()
    const to = screen.getByLabelText('To')
    expect(to).toHaveAttribute('aria-invalid', 'true')
    expect(to).toHaveAccessibleDescription('Choose an end date on or after the start date.')
    expect(visitRequests(requests)).toHaveLength(before)
  })

  it('offers to clear filters when nothing matches', async () => {
    const { router, user } = setup({ path: '/history?status=NO_SHOW&q=nobody', visits: () => jsonResponse(page<Visit>([])) })

    expect(await screen.findByRole('heading', { name: 'No visits match these filters' })).toBeInTheDocument()
    const [clear] = screen.getAllByRole('button', { name: 'Clear filters' }).filter((button) => !button.hasAttribute('aria-disabled'))
    await user.click(clear!)

    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('')
  })

  it('shows a load failure with a retry', async () => {
    let fail = true
    const { user } = setup({
      visits: () => (fail ? errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : jsonResponse(page([overrideVisit]))),
    })

    expect(await screen.findByText('The visit history could not be loaded')).toBeInTheDocument()
    expect(screen.getByText('Reference:')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Élodie Martin' })).toBeInTheDocument()
  })

  it('lets administrators filter by inactive departments too', async () => {
    const archived = { ...FINANCE, id: '7f0d1c0e-2222-4a5b-9c1d-0000000000aa', name: 'Archive', is_active: false }
    const { requests, user } = setup({
      roles: ['SYSTEM_ADMIN'],
      extra: { 'GET /departments': () => jsonResponse([FINANCE, archived]) },
    })
    await screen.findByRole('table', { name: 'Visit history' })

    await user.click(screen.getByRole('combobox', { name: 'Department' }))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: /Archive/ })).toHaveTextContent('Inactive')
    expect(requests.find((request) => request.path === '/departments')?.url.searchParams.get('include_inactive')).toBe('true')

    await user.click(within(listbox).getByRole('option', { name: /Archive/ }))
    await waitFor(() => expect(lastQuery(requests).department_id).toBe(archived.id))
  })
})
