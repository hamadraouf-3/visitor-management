import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../test/api'
import { makeDashboard, makeVisit, makeVisitor, page } from '../test/fixtures'
import { findAlert, recordAddresses, renderRoutes } from '../test/render'
import type { Visit } from '../types/api'

// 10:00 on Mon 5 Oct 2026 in Amman (the company timezone); the test browser runs in UTC.
const NOW = new Date('2026-10-05T07:00:00Z')

const todayVisit = makeVisit({
  id: 'a1b2c3d4-0000-4000-8000-000000000011',
  scheduled_start: '2026-10-05T08:00:00Z',
  scheduled_end: '2026-10-05T09:30:00Z',
})
const failedVisit = makeVisit({
  id: 'a1b2c3d4-0000-4000-8000-000000000012',
  visitor: { id: 'v2', full_name: 'Omar Khalil', company_name: null },
  department: null,
  invitation: { status: 'FAILED', sent_at: null },
})
const TODAY_STATUSES = 'SCHEDULED,CHECKED_IN,CHECKED_OUT,NO_SHOW'

function visitsRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === '/visits')
}

function lastVisitsQuery(requests: RecordedRequest[]): Record<string, string> {
  const last = visitsRequests(requests).at(-1)
  if (!last) throw new Error('No GET /visits request')
  return Object.fromEntries(last.url.searchParams)
}

function serverFailure() {
  return errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.')
}

function setup({
  visits = () => jsonResponse(page([todayVisit])),
  extra = {},
  initialEntry = '/visits',
}: { visits?: RouteHandler; extra?: Record<string, RouteHandler>; initialEntry?: string } = {}) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
    'GET /dashboard/employee': () => jsonResponse(makeDashboard()),
    'GET /visits': visits,
    ...extra,
  })
  const view = renderRoutes(routes, { initialEntries: [initialEntry] })
  return { ...api, ...view }
}

describe('My visits', () => {
  beforeEach(() => {
    // Only the clock: timers stay real so debounces and queries run normally.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the summary line, the counts on the tabs and today’s visits in the company timezone', async () => {
    const { requests } = setup()

    const summary = await screen.findByRole('region', { name: 'Visit summary' })
    expect(await within(summary).findByText('1 inside now')).toBeInTheDocument()
    expect(summary).toHaveTextContent('Last 30 days: 12 completed · 2 cancelled')
    // Today, upcoming and needs-attention counts are on the tabs, not repeated in tiles.
    expect(screen.getByRole('tab', { name: 'Today 2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Upcoming 5' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Needs attention 1' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Today\s*2/ })).toBeNull()
    // The summary is the title's line of facts (direction C): no description, no time-zone note (decision 3).
    const pageHeader = screen.getByRole('heading', { level: 1, name: 'My visits' }).closest('header') as HTMLElement
    expect(pageHeader).toContainElement(summary)
    expect(pageHeader).not.toHaveTextContent(/Times are|Visits you host/)

    const table = await screen.findByRole('table', { name: 'Today’s visits' })
    const row = within(table).getAllByRole('row')[1] as HTMLElement
    expect(within(row).getByRole('link', { name: 'Élodie Martin' })).toHaveAttribute('href', `/visits/${todayVisit.id}`)
    expect(row).toHaveTextContent('Orbit Labs')
    // Direction C's row: the visitor after an avatar of their initials (decorative, the name is written beside it).
    expect(row.querySelector('[data-avatar]')).toHaveTextContent('ÉM')
    expect(row.querySelector('[data-avatar]')).toHaveAttribute('aria-hidden', 'true')
    // 08:00–09:30 UTC is 11:00–12:30 in Amman.
    expect(row).toHaveTextContent('Today, 11:00–\u206012:30')
    expect(row).toHaveTextContent('Finance')
    expect(within(row).getByText('Scheduled')).toBeInTheDocument()
    // Under the "Invitation" column the short word; in the phone card, where no header names it, the long one.
    expect(within(row).getByText('Sent').closest('span.rounded-full')?.className).toContain('max-lg:hidden')
    expect(within(row).getByText('Invitation sent').closest('span.rounded-full')?.className).toContain('lg:hidden')
    // From xl on the columns keep their widths across tabs; the department stays on one line.
    expect(table.className).toContain('xl:table-fixed')
    expect(within(row).getByText('Finance')).toHaveAttribute('title', 'Finance')
    expect(within(row).getByText('Finance').className).toContain('xl:truncate')
    // Every visit listed is hosted by the signed-in user: no Host column repeating their name.
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).not.toContain('Host')

    expect(lastVisitsQuery(requests)).toEqual({
      scope: 'mine',
      page: '1',
      page_size: '25',
      status: TODAY_STATUSES,
      date_from: '2026-10-05',
      date_to: '2026-10-05',
      order: 'asc',
    })
  })

  it('lists today the same visits the Today badge counts: cancelled ones only on request', async () => {
    // The dashboard leaves cancelled visits out of counts.today (B24-31), so the default list does too.
    const cancelled = makeVisit({ id: 'a1b2c3d4-0000-4000-8000-000000000013', status: 'CANCELLED', cancelled_at: '2026-10-05T06:00:00Z' })
    const { requests, user, router } = setup({
      visits: (request) => jsonResponse(page(request.url.searchParams.get('status') === 'CANCELLED' ? [cancelled] : [todayVisit])),
    })
    await screen.findByRole('table', { name: 'Today’s visits' })
    expect(lastVisitsQuery(requests).status).toBe(TODAY_STATUSES)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Cancelled')

    await waitFor(() => expect(lastVisitsQuery(requests)).toMatchObject({ status: 'CANCELLED', date_from: '2026-10-05', date_to: '2026-10-05' }))
    expect(router.state.location.search).toBe('?show=cancelled')
    const table = await screen.findByRole('table', { name: 'Today’s visits' })
    expect(await within(table).findByText('Cancelled')).toBeInTheDocument()
  })

  it('finds cancelled upcoming visits, which the Upcoming list leaves out', async () => {
    const { requests } = setup({ initialEntry: '/visits?tab=upcoming&show=cancelled', visits: () => jsonResponse(page<Visit>([])) })

    expect(await screen.findByRole('heading', { name: 'No cancelled upcoming visits' })).toBeInTheDocument()
    expect(lastVisitsQuery(requests)).toMatchObject({ status: 'CANCELLED', date_from: '2026-10-06' })
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('cancelled')
  })

  it('shows the Host column when another host’s visit is listed', async () => {
    const otherHost = makeVisit({ id: 'a1b2c3d4-0000-4000-8000-000000000014', host: { id: 'h2', full_name: 'Omar Khalil', phone: null } })
    setup({ visits: () => jsonResponse(page([todayVisit, otherHost])) })

    const table = await screen.findByRole('table', { name: 'Today’s visits' })
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toContain('Host')
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('Omar Khalil')
  })

  it('marks the Needs attention badge when something needs attention', async () => {
    setup()
    const badge = (await screen.findByRole('tab', { name: 'Needs attention 1' })).querySelector('span')
    expect(badge?.className).toContain('bg-attention')
  })

  it.each([
    ['Upcoming', 'upcoming', { status: 'SCHEDULED', date_from: '2026-10-06', order: 'asc' }],
    ['Past', 'past', { date_to: '2026-10-04', order: 'desc' }],
    ['Needs attention', 'attention', { needs_attention: 'true', order: 'asc' }],
  ])('switches to %s: the URL and the request filters follow', async (label, tab, filters) => {
    // A status choice belongs to its tab and is reset with it, like the page.
    const { requests, user, router } = setup({ initialEntry: '/visits?page=3&show=cancelled' })
    await screen.findByRole('table', { name: 'Today’s visits' })

    await user.click(screen.getByRole('tab', { name: new RegExp(label) }))

    await waitFor(() => expect(lastVisitsQuery(requests)).toEqual({ scope: 'mine', page: '1', page_size: '25', ...filters }))
    // The page resets with the tab.
    expect(router.state.location.search).toBe(`?tab=${tab}`)
    expect(screen.getByRole('tab', { name: new RegExp(label) })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()
  })

  it('moves between tabs with the arrow keys', async () => {
    const { user, router } = setup()
    await screen.findByRole('table', { name: 'Today’s visits' })

    screen.getByRole('tab', { name: /Today/ }).focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: /Upcoming/ })).toHaveFocus()
    expect(router.state.location.search).toBe('?tab=upcoming')
  })

  it('restores tab, search and page from a link of an earlier version, moving the search out of the address', async () => {
    const { requests, router } = setup({ initialEntry: '/visits?tab=past&q=orbit&page=2', visits: () => jsonResponse(page([todayVisit], { page: 2, total: 30 })) })

    await screen.findByRole('table', { name: 'Past visits' })
    expect(lastVisitsQuery(requests)).toMatchObject({ q: 'orbit', page: '2', date_to: '2026-10-04' })
    expect(screen.getByRole('searchbox', { name: 'Search visits' })).toHaveValue('orbit')
    expect(screen.getByText('Showing 26–30 of 30')).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).toBe('?tab=past&page=2'))
  })

  it('searches within the tab after typing stops, and starts again at page 1', async () => {
    const { requests, user, router } = setup({ initialEntry: '/visits?tab=past&page=2' })
    await screen.findByRole('table', { name: 'Past visits' })
    const addresses = recordAddresses(router)

    await user.type(screen.getByRole('searchbox', { name: 'Search visits' }), 'orbit')

    await waitFor(() => expect(lastVisitsQuery(requests)).toMatchObject({ q: 'orbit', page: '1', date_to: '2026-10-04' }))
    // The search text is kept with the history entry, never in the address (SEC-20).
    expect(router.state.location.search).toBe('?tab=past')
    expect(router.state.location.state).toEqual({ view: { owner: makeMe().user.id, values: { q: 'orbit' } } })
    expect(addresses.filter((address) => address.includes('q='))).toEqual([])
    // One request for the finished word, not one per keystroke.
    expect(visitsRequests(requests).filter((request) => request.url.searchParams.has('q'))).toHaveLength(1)
  })

  it('pages through the results', async () => {
    const { requests, user, router } = setup({ visits: (request) => jsonResponse(page([todayVisit], { page: Number(request.url.searchParams.get('page')), total: 60 })) })
    await screen.findByText('Showing 1–25 of 60')

    await user.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => expect(lastVisitsQuery(requests).page).toBe('2'))
    expect(router.state.location.search).toBe('?page=2')
    expect(await screen.findByText('Showing 26–50 of 60')).toBeInTheDocument()
  })

  it.each([
    ['today', 'No visits today'],
    ['upcoming', 'No upcoming visits'],
    ['past', 'No past visits'],
    ['attention', 'Nothing needs your attention'],
  ])('shows an empty state on the %s tab', async (tab, title) => {
    setup({ initialEntry: `/visits?tab=${tab}`, visits: () => jsonResponse(page<Visit>([])) })

    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('explains an empty search and clears it', async () => {
    const { user, router } = setup({
      initialEntry: '/visits?tab=past&q=nobody',
      visits: (request) => jsonResponse(page(request.url.searchParams.has('q') ? [] : [todayVisit])),
    })

    // Worded for the tab, not with the tab's name as a noun; a title and the way out, no explanation.
    const empty = await screen.findByRole('heading', { name: 'No past visits match “nobody”' })
    expect(empty.parentElement?.querySelector('p')).toBeNull()
    // The empty state's own button (the search field has an icon button with the same name).
    await user.click(within(empty.parentElement as HTMLElement).getByRole('button', { name: 'Clear search' }))

    expect(await screen.findByRole('table', { name: 'Past visits' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?tab=past')
    expect(screen.getByRole('searchbox', { name: 'Search visits' })).toHaveValue('')
  })

  it('shows the server message when the list fails, and retries', async () => {
    let fail = true
    const { user } = setup({
      visits: () => (fail ? errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.') : jsonResponse(page([todayVisit]))),
    })

    const alert = await findAlert('Visits could not be loaded')
    expect(alert).toHaveTextContent('The service is busy. Please try again.')

    fail = false
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('table', { name: 'Today’s visits' })).toBeInTheDocument()
  })

  it('keeps the list usable when the counts cannot be loaded', async () => {
    let fail = true
    const { user } = setup({
      extra: {
        'GET /dashboard/employee': () => (fail ? errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : jsonResponse(makeDashboard())),
      },
    })

    expect(await screen.findByText('The visit counts are unavailable.')).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Today’s visits' })).toBeInTheDocument()
    fail = false
    await user.click(within(screen.getByRole('region', { name: 'Visit summary' })).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('1 inside now')).toBeInTheDocument()
  })

  it('shows one message with one retry when counts and list both fail, with the support reference', async () => {
    let fail = true
    const { user } = setup({
      visits: () => (fail ? serverFailure() : jsonResponse(page([todayVisit]))),
      extra: { 'GET /dashboard/employee': () => (fail ? serverFailure() : jsonResponse(makeDashboard())) },
    })

    const alert = await findAlert('My visits could not be loaded')
    expect(alert).toHaveTextContent('Reference: req-test-1')
    expect(screen.queryByText('The visit counts are unavailable.')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1)

    fail = false
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('table', { name: 'Today’s visits' })).toBeInTheDocument()
    expect(await screen.findByText('1 inside now')).toBeInTheDocument()
  })

  it('opens a visit, whose back link returns to the same tab', async () => {
    const { user, router } = setup({
      initialEntry: '/visits?tab=attention',
      visits: () => jsonResponse(page([failedVisit])),
      extra: {
        [`GET /visits/${failedVisit.id}`]: () => jsonResponse(failedVisit),
        // The failed invitation offers to correct the visitor's address.
        'GET /visitors/v2': () => jsonResponse(makeVisitor({ id: 'v2', full_name: 'Omar Khalil' })),
      },
    })
    const table = await screen.findByRole('table', { name: 'Visits that need attention' })
    expect(within(table).getByText('Failed')).toBeInTheDocument()

    await user.click(within(table).getByRole('link', { name: 'Omar Khalil' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Omar Khalil' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/visits/${failedVisit.id}`)
    expect(screen.getByRole('link', { name: 'Back to My visits' })).toHaveAttribute('href', '/visits?tab=attention')
    expect(await screen.findByRole('button', { name: 'Correct email and resend' })).toBeInTheDocument()
  })

  it('offers "Invite visitor" in the header', async () => {
    setup()
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    expect(screen.getAllByRole('link', { name: 'Invite visitor' }).some((link) => link.getAttribute('href') === '/visits/new')).toBe(true)
  })

  it('keeps the phone layout compact so the list starts on the first screen', async () => {
    // jsdom applies no Tailwind CSS: the responsive classes are the contract (checked in a real browser too).
    setup()
    const title = await screen.findByRole('heading', { level: 1, name: 'My visits' })

    // "Invite visitor" sits beside the title on phones instead of a full-width row of its own.
    const header = title.closest('header') as HTMLElement
    const [phoneInvite, wideInvite] = within(header).getAllByRole('link', { name: 'Invite visitor' }) as [HTMLElement, HTMLElement]
    expect(phoneInvite.closest('[class~="sm:hidden"]')).not.toBeNull()
    expect(wideInvite.closest('[class~="max-sm:hidden"]')).not.toBeNull()

    // All four tabs stay visible: two per row on phones, none cut off.
    const tablist = screen.getByRole('tablist', { name: 'Visits' })
    expect(tablist.className).toContain('max-sm:grid-cols-2')
    expect(await screen.findByRole('tab', { name: 'Needs attention 1' })).toBeInTheDocument()

    // Search and the status choice share one row, the list card's header. No hint line under the
    // search: its placeholder says what it searches (on a phone, where the row is narrow, one word).
    const search = screen.getByRole('searchbox', { name: 'Search visits' })
    const show = screen.getByRole('combobox', { name: 'Show' })
    expect(search).not.toHaveAccessibleDescription()
    expect(search).toHaveAttribute('placeholder', 'Search')
    const row = search.closest('form')?.parentElement as HTMLElement
    expect(row).toContainElement(show)
    expect(row.className).not.toContain('flex-col')
    // The status choice is as wide as its longest option on phones, so its current option is never cut
    // off ("All but cancell", «الكل عدا الملغا» in a fixed 160 px; review); the search takes the rest.
    const choice = show.parentElement as HTMLElement
    expect(choice.className).toContain('shrink-0')
    expect(choice.className).not.toMatch(/(?:^|\s)w-\d/)
    expect(choice.className).toContain('sm:w-52')

    // The summary's two facts take a line each on phones (no dot between them there).
    const summary = screen.getByRole('region', { name: 'Visit summary' })
    expect(summary.className).toContain('flex-col')
    expect(summary.className).toContain('sm:flex-row')
    expect(summary.querySelector('.size-1')?.className).toContain('max-sm:hidden')
  })
})
