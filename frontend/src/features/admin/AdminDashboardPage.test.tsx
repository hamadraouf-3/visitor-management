import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi } from '../../test/api'
import { renderRoutes } from '../../test/render'
import { ADMIN_DASHBOARD_REFRESH_MS } from './queries'
import { makeAdminDashboard, makeAuditLog, makeCompanySettings } from './testRoutes'

const VISIT_ID = '5a1b2c3d-0000-4000-8000-000000000041'

afterEach(() => {
  vi.useRealTimers()
})

describe('Admin dashboard', () => {
  it('shows the counts as links to the lists behind them, and the latest events in words', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T09:00:00Z'), toFake: ['Date'] })
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
      'GET /company/settings': () => jsonResponse(makeCompanySettings()),
      'GET /dashboard/admin': () =>
        jsonResponse(
          makeAdminDashboard({
            counts: { visitors_total: 1284, visits_total: 3410, inside_now: 7, visits_today: 23, employees: 41, receptionists: 3, management: 2, admins: 2 },
            recent_audit: [
              makeAuditLog({ action: 'VISIT_CHECKED_IN', entity_type: 'visit', entity_id: VISIT_ID, metadata: { method: 'QR' } }),
              makeAuditLog({ id: 'a2', seq: 1, action: 'AUTH_LOGIN_FAILED', actor: null, entity_type: null, entity_id: null, metadata: { reason: 'unknown_account' } }),
            ],
          }),
        ),
    })
    renderRoutes(routes, { initialEntries: ['/admin'] })

    await screen.findByRole('heading', { level: 2, name: 'Visits' })
    const main = within(screen.getByRole('main'))
    const inside = main.getByRole('link', { name: /Inside now/ })
    // A link at rest, not only on hover: each tile shows a chevron (decorative).
    expect(inside.querySelector('[data-link-cue]')).toHaveAttribute('aria-hidden', 'true')
    expect(inside).toHaveAttribute('href', '/inside')
    expect(inside).toHaveTextContent('7')
    // The one figure the screen is about: direction C's dark tile, refreshed while the page is open.
    expect(inside).toHaveClass('bg-emphasis')
    expect(inside).toHaveTextContent('Live')
    // "Today" is the company's day: 12:00 in Amman.
    expect(main.getByRole('link', { name: /Visits today/ })).toHaveAttribute('href', '/history?from=2026-10-05&to=2026-10-05&status=SCHEDULED%2CCHECKED_IN%2CCHECKED_OUT%2CNO_SHOW')
    expect(main.getByRole('link', { name: /Visitors/ })).toHaveTextContent('1,284')

    // Active accounts by role: one row per role, each a link to the users holding it.
    const accounts = main.getByRole('region', { name: 'Active accounts by role' })
    expect(within(accounts).getByRole('link', { name: /Reception/ })).toHaveAttribute('href', '/admin/users?role=RECEPTIONIST&status=active')
    expect(within(accounts).getByRole('link', { name: /Employees/ })).toHaveTextContent('41')
    expect(within(accounts).getByRole('link', { name: /Administrators/ })).toHaveTextContent('2')

    // The settings that apply to everyone, as facts, with the way to change them.
    const company = await main.findByRole('region', { name: 'Company settings' })
    const fact = (term: string) => within(company).getByText(term).nextElementSibling
    expect(fact('Default language')).toHaveTextContent('English')
    expect(fact('Time zone')).toHaveTextContent('Amman time (UTC+3)')
    expect(fact('Walk-in visitors')).toHaveTextContent('Allowed')
    expect(fact('Pass window')).toHaveTextContent('60 min before · 60 min after')
    expect(within(company).getByRole('link', { name: 'Edit settings' })).toHaveAttribute('href', '/admin/settings')

    const events = within(screen.getByRole('list', { name: 'Latest audit events' })).getAllByRole('listitem')
    expect(events[0]).toHaveTextContent('Visitor checked in')
    expect(events[0]).toHaveTextContent('Today, 09:31')
    expect(within(events[0]!).getByRole('link', { name: 'Open visit' })).toHaveAttribute('href', `/visits/${VISIT_ID}`)
    expect(events[1]).toHaveTextContent('Failure or denial:')
    expect(events[1]).toHaveTextContent('Sign-in failed')
    expect(events[1]).toHaveTextContent('Unknown account')
    expect(events[1]).toHaveTextContent('System or anonymous')
    expect(screen.getByRole('link', { name: 'Open audit log' })).toHaveAttribute('href', '/admin/audit')
  })

  it('opens with the date and when the figures were read, and no explanatory notes (decision 3)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T09:00:00Z'), toFake: ['Date'] })
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), 'GET /company/settings': () => jsonResponse(makeCompanySettings()),
      'GET /dashboard/admin': () => jsonResponse(makeAdminDashboard()) })
    renderRoutes(routes, { initialEntries: ['/admin'] })

    const heading = await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })
    const header = heading.closest('header')!
    await waitFor(() => expect(header).toHaveTextContent(/Updated \d\d:\d\d/))
    expect(header).toHaveTextContent('Mon, 5 Oct 2026')
    // The admin hosts too: the "Invite visitor" primary action, as on My visits.
    expect(within(header).getAllByRole('link', { name: 'Invite visitor' })[0]).toHaveAttribute('href', '/visits/new')

    const main = screen.getByRole('main')
    await within(main).findByRole('heading', { name: 'No events yet' })
    for (const note of [/at a glance/, /counted under each/, /Checked in, any day/, /Since the start/, /People on record/, /most recent audit events/, /recorded here/]) {
      expect(main.textContent).not.toMatch(note)
    }
  })

  it('reads its figures again while it is open, so "Live" holds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { requests } = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), 'GET /company/settings': () => jsonResponse(makeCompanySettings()),
      'GET /dashboard/admin': () => jsonResponse(makeAdminDashboard()) })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { name: 'No events yet' })
    const reads = () => requests.filter((request) => request.path === '/dashboard/admin').length
    expect(reads()).toBe(1)

    await vi.advanceTimersByTimeAsync(ADMIN_DASHBOARD_REFRESH_MS)
    await waitFor(() => expect(reads()).toBe(2))
  })

  it('says when no events exist and offers a retry when loading fails', async () => {
    let fail = true
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
      'GET /company/settings': () => jsonResponse(makeCompanySettings()),
      'GET /dashboard/admin': () => (fail ? errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.') : jsonResponse(makeAdminDashboard())),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })

    expect(await screen.findByText('The dashboard could not be loaded', {}, { timeout: 4000 })).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'No events yet' })).toBeInTheDocument()
  })
})
