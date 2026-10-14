import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../test/api'
import { makeVisit, makeVisitor, page, VISITOR_ID } from '../test/fixtures'
import { renderRoutes } from '../test/render'
import type { Role, Visitor } from '../types/api'

const NOW = new Date('2026-10-05T06:10:00Z')
const PROFILE = `/visitors/${VISITOR_ID}`

const pastVisit = makeVisit({
  id: '5a1b2c3d-0000-4000-8000-000000000021',
  status: 'CHECKED_OUT',
  scheduled_start: '2026-09-20T06:00:00Z',
  scheduled_end: '2026-09-20T07:00:00Z',
  check_in_at: '2026-09-20T05:58:00Z',
  check_in_method: 'QR',
  checked_in_by: { id: 'r1', full_name: 'Rana Saleh' },
  check_out_at: '2026-09-20T07:35:00Z',
  check_out_method: 'QR',
  checked_out_by: { id: 'r1', full_name: 'Rana Saleh' },
  duration_seconds: 5820,
  purpose: 'Site inspection',
})

function historyRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'GET' && request.path === `${PROFILE}/visits`)
}

function setup({
  roles = ['EMPLOYEE'],
  visitor = makeVisitor(),
  history = () => jsonResponse(page([pastVisit], { page_size: 20 })),
  extra = {},
}: { roles?: Role[]; visitor?: Visitor | RouteHandler; history?: RouteHandler; extra?: Record<string, RouteHandler> } = {}) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(roles)),
    [`GET ${PROFILE}`]: typeof visitor === 'function' ? visitor : () => jsonResponse(visitor),
    [`GET ${PROFILE}/visits`]: history,
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [PROFILE] }) }
}

describe('Visitor profile', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows contact details, statistics and the visit history', async () => {
    setup({ roles: ['RECEPTIONIST'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Élodie Martin' })).toBeInTheDocument()
    // The browser keeps page titles in its saved history: never the visitor's name (SEC-27).
    await waitFor(() => expect(document.title).toBe('Visitor profile · Acme Holdings'))
    expect(screen.getByRole('link', { name: 'elodie@orbit.example' })).toHaveAttribute('href', 'mailto:elodie@orbit.example')
    expect(screen.getByRole('link', { name: 'Call Élodie Martin: +962 79 555 0100' })).toHaveAttribute('href', 'tel:+962795550100')
    // The company is the title's line of facts (no description).
    const pageHeader = screen.getByRole('heading', { level: 1, name: 'Élodie Martin' }).closest('header') as HTMLElement
    expect(pageHeader).toHaveTextContent('Orbit Labs')
    // The count covers every status and "last" is the last arrival (B24-12), so they cannot contradict
    // each other: direction C's KPI tile, the last check-in at its foot.
    const stats = screen.getByText('All visits').closest('div.rounded-card') as HTMLElement
    expect(stats).toHaveTextContent('All visits3')
    expect(stats).toHaveTextContent('Last check-inSun, 20 Sep 2026')

    const table = await screen.findByRole('table', { name: 'Visit history' })
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Date',
      'Status',
      'Host',
      'Department',
      'Purpose',
      'Attendance',
    ])
    const row = within(table).getAllByRole('row')[1] as HTMLElement
    const dateLink = within(row).getByRole('link', { name: 'Sun, 20 Sep 2026, 09:00–\u206010:00' })
    expect(dateLink).toHaveAttribute('href', `/visits/${pastVisit.id}`)
    // One line in the table only: in the phone card a visit across midnight wraps instead of overflowing.
    expect(dateLink.className).toContain('lg:whitespace-nowrap')
    expect(dateLink.className.split(' ')).not.toContain('whitespace-nowrap')
    expect(row).toHaveTextContent('Lina Haddad')
    expect(row).toHaveTextContent('Finance')
    expect(row).toHaveTextContent('Site inspection')
    // Check-in and check-out in company time, and the time on site, in one cell.
    expect(row).toHaveTextContent('In 08:58 · Out 10:35 · 1h 37m')
    expect(within(row).getByText('Checked out')).toBeInTheDocument()
    // Not a card inside a card: the history is a section of the page, its title counting the visits.
    const history = table.closest('section') as HTMLElement
    expect(history.querySelector('h2')).toHaveTextContent('Visit history')
    expect(history.querySelector('[data-count-badge]')).toHaveTextContent('1')
    // No scope note, and reception does not invite.
    expect(screen.queryByText(/Only visits you host or have created/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'Invite again' })).toBeNull()
  })

  it('hands the visit page a back link without the visitor’s name, which the visit page adds from the visit (SEC-28)', async () => {
    const visit = pastVisit
    const { router, user } = setup({
      history: () => jsonResponse(page([visit], { page_size: 20 })),
      extra: { [`GET /visits/${visit.id}`]: () => jsonResponse(visit) },
    })
    const table = await screen.findByRole('table', { name: 'Visit history' })

    await user.click(within(table).getByRole('link', { name: 'Sun, 20 Sep 2026, 09:00–\u206010:00' }))

    // On screen: the name, from the visit just loaded. (The visit page is a lazy route, and its
    // heading is the visitor's name, as the profile's is: wait for something only it shows.)
    expect(await screen.findByRole('link', { name: `Back to ${visit.visitor.full_name}` })).toHaveAttribute('href', PROFILE)
    expect(screen.getByRole('heading', { level: 1, name: visit.visitor.full_name })).toBeInTheDocument()
    // What the browser keeps with the history entry: generic words only.
    expect(router.state.location.state).toMatchObject({ backLink: { to: PROFILE, label: 'Back to visitor profile', owner: makeMe().user.id } })
    expect(JSON.stringify(router.state.location.state)).not.toContain(visit.visitor.full_name)
  })

  it('links the email address so that it cannot carry extra headers into the mail client', async () => {
    // The server accepts '?', '=' and '&' in the local part; unencoded, this would add a Cc.
    setup({ visitor: makeVisitor({ email: 'a?cc=evil@example.com' }) })

    const link = await screen.findByRole('link', { name: 'a?cc=evil@example.com' })
    expect(link).toHaveAttribute('href', 'mailto:a%3Fcc%3Devil@example.com')
    expect(new URL(link.getAttribute('href') as string).search).toBe('')
  })

  it('invites the visitor again with them preselected', async () => {
    setup()

    expect(await screen.findByRole('link', { name: 'Invite again' })).toHaveAttribute('href', `/visits/new?visitor=${VISITOR_ID}`)
    expect(screen.getByRole('button', { name: 'Edit visitor' })).toBeInTheDocument()
  })

  it('adds no scope note for an employee either (decision 3: the server scopes what is shown)', async () => {
    setup()
    const table = await screen.findByRole('table', { name: 'Visit history' })
    expect(table.closest('section')).not.toHaveTextContent(/visits you host or have created|Newest first/i)
    expect(screen.queryByText(/visits you host or have created/i)).toBeNull()
  })

  it('offers "Edit visitor" only when the visitor’s permissions allow it', async () => {
    setup({ visitor: makeVisitor({ permissions: { can_edit: false } }) })
    await screen.findByRole('heading', { level: 1, name: 'Élodie Martin' })

    expect(screen.queryByRole('button', { name: 'Edit visitor' })).toBeNull()
  })

  it('edits the visitor, warning that a new email address re-sends the invitations', async () => {
    const updated = makeVisitor({ email: 'e.martin@orbit.example', phone: null })
    const { user, requests } = setup({ extra: { [`PATCH ${PROFILE}`]: () => jsonResponse(updated) } })
    await screen.findByRole('heading', { level: 1, name: 'Élodie Martin' })

    await user.click(screen.getByRole('button', { name: 'Edit visitor' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit visitor' })
    const email = within(dialog).getByRole('textbox', { name: /^Email/ })
    // No description or hint (decision 3): what a new address does is said once it is typed.
    expect(dialog).not.toHaveAccessibleDescription()
    expect(email).not.toHaveAccessibleDescription()
    expect(within(dialog).queryByText('The visitor gets new invitations')).toBeNull()

    await user.clear(email)
    await user.type(email, 'e.martin@orbit.example')
    expect(within(dialog).getByText('The visitor gets new invitations')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('QR codes sent to the previous address stop working.')
    await user.clear(within(dialog).getByRole('textbox', { name: /^Phone/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Visitor updated')).toBeInTheDocument()
    // Worded so it holds also when the visitor has no scheduled visit.
    expect(screen.getByText('Any scheduled visits of Élodie Martin get a new invitation and QR code at e.martin@orbit.example.')).toBeInTheDocument()
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ email: 'e.martin@orbit.example', phone: null })
    expect(screen.getByRole('link', { name: 'e.martin@orbit.example' })).toBeInTheDocument()
  })

  it('shows a duplicate email address on the email field', async () => {
    const { user } = setup({
      extra: { [`PATCH ${PROFILE}`]: () => errorResponse(409, 'VISITOR_EXISTS', 'A visitor with this email already exists.') },
    })
    await screen.findByRole('heading', { level: 1, name: 'Élodie Martin' })
    await user.click(screen.getByRole('button', { name: 'Edit visitor' }))
    const dialog = screen.getByRole('dialog')
    const email = within(dialog).getByRole('textbox', { name: /^Email/ })

    await user.clear(email)
    await user.type(email, 'omar@orbit.example')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'))
    expect(email).toHaveAccessibleDescription(/A visitor with this email already exists\./)
    expect(email).toHaveFocus()
  })

  it('pages through the history', async () => {
    const { requests, user, router } = setup({
      history: (request) => jsonResponse(page([pastVisit], { page: Number(request.url.searchParams.get('page')), page_size: 20, total: 45 })),
    })
    expect(await screen.findByText('Showing 1–20 of 45')).toBeInTheDocument()
    expect(Object.fromEntries(historyRequests(requests)[0]!.url.searchParams)).toEqual({ page: '1', page_size: '20' })

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Showing 21–40 of 45')).toBeInTheDocument()
    expect(historyRequests(requests).at(-1)?.url.searchParams.get('page')).toBe('2')
    expect(router.state.location.search).toBe('?page=2')
  })

  it('names the end day of a visit across midnight in short form', async () => {
    const lateVisit = makeVisit({
      id: '5a1b2c3d-0000-4000-8000-000000000022',
      scheduled_start: '2026-10-05T19:42:00Z',
      scheduled_end: '2026-10-05T21:42:00Z',
    })
    setup({ history: () => jsonResponse(page([lateVisit], { page_size: 20 })) })
    const table = await screen.findByRole('table', { name: 'Visit history' })
    expect(within(table).getByRole('link', { name: 'Mon, 5 Oct 2026, 22:42\u00a0– Tue, 6 Oct, 00:42' })).toBeInTheDocument()
  })

  it('shows an empty history', async () => {
    setup({ history: () => jsonResponse(page([], { page_size: 20 })) })
    expect(await screen.findByRole('heading', { name: 'No visits yet' })).toBeInTheDocument()
  })

  it('shows a visitor that is not found with the way back, without guidance text', async () => {
    const { requests } = setup({ visitor: () => errorResponse(404, 'NOT_FOUND', 'The requested item was not found.') })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visitor not found' })).toBeInTheDocument()
    const empty = screen.getByRole('heading', { level: 2, name: 'This visitor does not exist or is not available to you' })
    expect(empty.parentElement?.querySelector('p')).toBeNull()
    expect(within(empty.parentElement as HTMLElement).getByRole('link', { name: 'Back to Visitors' })).toHaveAttribute('href', '/visitors')
    expect(historyRequests(requests)).toHaveLength(0)
  })
})
