import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../test/api'
import { makeSearchItem, makeVisit, makeVisitor, page } from '../test/fixtures'
import { findAlert, recordAddresses, renderRoutes } from '../test/render'
import type { Role, VisitorSearchItem } from '../types/api'

const NOW = new Date('2026-10-06T05:00:00Z') // 08:00 Amman on the fixture visit's day

const elodie = makeSearchItem({ today_visits: [makeVisit()] })
const omar = makeSearchItem({
  id: '5a1b2c3d-0000-4000-8000-0000000000b2',
  full_name: 'Omar Khalil',
  email: null,
  phone: null,
  company_name: null,
  stats: { total_visits: 0, last_visit_at: null },
})

function searches(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/visitors')
}

function setup({
  roles = ['EMPLOYEE'],
  visitors = () => jsonResponse(page([elodie, omar])),
  initialEntry = '/visitors',
  extra = {},
}: { roles?: Role[]; visitors?: RouteHandler; initialEntry?: string; extra?: Record<string, RouteHandler> } = {}) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(roles)), 'GET /visitors': visitors, ...extra })
  return { ...api, ...renderRoutes(routes, { initialEntries: [initialEntry] }) }
}

describe('Visitors', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists visitors with contact details, today’s visits and the last visit', async () => {
    const { requests } = setup()

    const table = await screen.findByRole('table', { name: 'Visitors' })
    // The same words as the profile (B24-12): every visit counts, "last" is the last arrival.
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Visitor',
      'Contact',
      'Today',
      'Last check-in',
      'All visits',
    ])
    const [, first, second] = within(table).getAllByRole('row') as HTMLElement[]
    expect(within(first!).getByRole('link', { name: 'Élodie Martin' })).toHaveAttribute('href', `/visitors/${elodie.id}`)
    expect(first).toHaveTextContent('Orbit Labs')
    // A long address is cut with an ellipsis in its cell; the whole address is its title.
    expect(within(first!).getByText('elodie@orbit.example')).toHaveAttribute('title', 'elodie@orbit.example')
    // Today's visit, in company time, linking to the visit.
    expect(within(first!).getByRole('link', { name: '09:00–\u206010:00 with Lina Haddad' })).toHaveAttribute('href', `/visits/${elodie.today_visits[0]!.id}`)
    expect(within(first!).getByText('Scheduled')).toBeInTheDocument()
    expect(first).toHaveTextContent('Sun, 20 Sep 2026')
    // One token for every empty value.
    expect(within(second!).getAllByText('—')).toHaveLength(3)
    expect(second).not.toHaveTextContent(/None|Never/)

    expect(Object.fromEntries(searches(requests)[0]!.url.searchParams)).toEqual({ page: '1', page_size: '25' })
  })

  it('searches after typing stops and keeps the search with the page, not in the address', async () => {
    const { requests, user, router } = setup()
    await screen.findByRole('table', { name: 'Visitors' })
    const addresses = recordAddresses(router)

    await user.type(screen.getByRole('searchbox', { name: 'Search visitors' }), 'mart')

    await waitFor(() => expect(searches(requests).at(-1)?.url.searchParams.get('q')).toBe('mart'))
    expect(searches(requests).filter((request) => request.url.searchParams.has('q'))).toHaveLength(1)
    // Not in the address, so not in the browser's saved history (SEC-20): not even for a moment.
    expect(router.state.location.search).toBe('')
    expect(addresses).not.toHaveLength(0)
    expect(addresses.filter((address) => address.includes('q='))).toEqual([])
    expect(router.state.location.state).toEqual({ view: { owner: makeMe().user.id, values: { q: 'mart' } } })
    expect(await screen.findByRole('table', { name: 'Visitors matching “mart”' })).toBeInTheDocument()
  })

  it('returns from a visitor’s profile to the same search, still without it in the address', async () => {
    const { requests, user, router } = setup({
      extra: {
        [`GET /visitors/${elodie.id}`]: () => jsonResponse(makeVisitor()),
        [`GET /visitors/${elodie.id}/visits`]: () => jsonResponse(page([], { page_size: 20 })),
      },
    })
    await screen.findByRole('table', { name: 'Visitors' })
    await user.type(screen.getByRole('searchbox', { name: 'Search visitors' }), 'mart')
    const table = await screen.findByRole('table', { name: 'Visitors matching “mart”' })

    await user.click(within(table).getByRole('link', { name: 'Élodie Martin' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Élodie Martin' })).toBeInTheDocument()
    const back = screen.getByRole('link', { name: 'Back to Visitors' })
    expect(back).toHaveAttribute('href', '/visitors')

    await user.click(back)
    expect(await screen.findByRole('table', { name: 'Visitors matching “mart”' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search visitors' })).toHaveValue('mart')
    expect(searches(requests).at(-1)?.url.searchParams.get('q')).toBe('mart')
    expect(router.state.location.search).toBe('')
  })

  it.each([['EMPLOYEE'], ['RECEPTIONIST'], ['MANAGEMENT'], ['SYSTEM_ADMIN']] as Role[][])(
    'opens with the title and the search as the list card’s header, without a description, for %s',
    async (role) => {
      setup({ roles: [role] })
      const title = await screen.findByRole('heading', { level: 1, name: 'Visitors' })
      await screen.findByRole('table', { name: 'Visitors' })
      // No page description or scope note (decision 3): the server scopes the list.
      expect((title.closest('header') as HTMLElement).querySelector('p')).toBeNull()
      expect(screen.queryByText(/visitors you added or invited|see who is expected today/)).toBeNull()
      // The search names what it searches in its placeholder; its label is its accessible name.
      const search = screen.getByRole('searchbox', { name: 'Search visitors' })
      expect(search).toHaveAttribute('placeholder', 'Name, email, phone or company')
      expect(search).not.toHaveAccessibleDescription()
    },
  )

  it('highlights a visitor who is inside the building now', async () => {
    const inside = makeSearchItem({ today_visits: [makeVisit({ status: 'CHECKED_IN', check_in_at: '2026-10-06T05:58:00Z' })] })
    setup({ visitors: () => jsonResponse(page([inside, omar])) })

    const table = await screen.findByRole('table', { name: 'Visitors' })
    const [, first, second] = within(table).getAllByRole('row') as HTMLElement[]
    expect(first).toHaveAttribute('data-highlighted', 'true')
    expect(within(first!).getByText('Checked in')).toBeInTheDocument()
    expect(second).not.toHaveAttribute('data-highlighted')
  })

  it('shows only the time of a visit today, and "from" for one that ends after midnight', async () => {
    const lateVisit = makeVisit({ scheduled_start: '2026-10-06T19:42:00Z', scheduled_end: '2026-10-06T21:42:00Z' })
    setup({ visitors: () => jsonResponse(page([makeSearchItem({ today_visits: [lateVisit] })])) })

    const table = await screen.findByRole('table', { name: 'Visitors' })
    expect(within(table).getByRole('link', { name: 'from 22:42 with Lina Haddad' })).toHaveAttribute('href', `/visits/${lateVisit.id}`)
  })

  it('shows empty states for no visitors and for a search without matches', async () => {
    const { user } = setup({ visitors: () => jsonResponse(page<VisitorSearchItem>([])) })

    const none = await screen.findByRole('heading', { name: 'No visitors yet' })
    // A title, an icon and the way on: no explanatory sentence (decision 3).
    expect(none.parentElement?.querySelector('p')).toBeNull()
    expect(screen.getAllByRole('link', { name: 'Invite visitor' }).some((link) => link.getAttribute('href') === '/visits/new')).toBe(true)

    await user.type(screen.getByRole('searchbox', { name: 'Search visitors' }), 'zz')
    const noMatch = await screen.findByRole('heading', { name: 'No visitors match “zz”' })
    // Someone not on record yet can be invited from here.
    const emptyState = noMatch.parentElement as HTMLElement
    expect(within(emptyState).getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
    expect(within(emptyState).getByRole('link', { name: 'Invite a new visitor' })).toHaveAttribute('href', '/visits/new')
  })

  it('offers to invite a new visitor after a search only to those who may invite', async () => {
    setup({ roles: ['RECEPTIONIST'], initialEntry: '/visitors?q=zz', visitors: () => jsonResponse(page<VisitorSearchItem>([])) })
    const noMatch = await screen.findByRole('heading', { name: 'No visitors match “zz”' })
    expect(within(noMatch.parentElement as HTMLElement).queryByRole('link', { name: 'Invite a new visitor' })).toBeNull()
  })

  it('shows the server message when the search fails', async () => {
    setup({ visitors: () => errorResponse(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.') })

    const alert = await findAlert('Visitors could not be loaded')
    expect(alert).toHaveTextContent('Too many requests. Please wait and try again.')
  })

  it('pages through results', async () => {
    const { requests, user, router } = setup({
      visitors: (request) => jsonResponse(page([elodie], { page: Number(request.url.searchParams.get('page')), total: 30 })),
    })
    await screen.findByText('Showing 1–25 of 30')

    await user.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => expect(searches(requests).at(-1)?.url.searchParams.get('page')).toBe('2'))
    expect(router.state.location.search).toBe('?page=2')
  })
})
