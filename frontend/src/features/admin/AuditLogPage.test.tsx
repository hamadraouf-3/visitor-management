import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { AuditLog } from '../../types/api'
import { makeAuditLog, makeUser } from './testRoutes'

const VISIT_ID = '5a1b2c3d-0000-4000-8000-000000000031'

const userUpdated = makeAuditLog()
const scanFailed = makeAuditLog({
  id: 'a0000000-0000-4000-8000-000000000002',
  seq: 1041,
  action: 'PASS_SCANNED',
  actor: { id: 'r-1', full_name: 'Rana Saleh' },
  entity_type: null,
  entity_id: null,
  metadata: { outcome: 'INVALID' },
})
const noShow = makeAuditLog({
  id: 'a0000000-0000-4000-8000-000000000003',
  seq: 1040,
  action: 'VISIT_MARKED_NO_SHOW',
  actor: null,
  entity_type: 'visit',
  entity_id: VISIT_ID,
  metadata: {},
  ip_address: null,
  user_agent: null,
  request_id: null,
})

function auditRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/audit-logs')
}

function lastQuery(requests: RecordedRequest[]) {
  return Object.fromEntries(auditRequests(requests).at(-1)!.url.searchParams)
}

function setup({ logs = () => jsonResponse(page([userUpdated, scanFailed, noShow], { page_size: 50 })), path = '/admin/audit', extra = {} }: { logs?: RouteHandler; path?: string; extra?: Record<string, RouteHandler> } = {}) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), 'GET /audit-logs': logs, ...extra })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

function eventItems() {
  return within(screen.getByRole('list', { name: 'Audit events, newest first' })).getAllByRole('listitem')
}

describe('Audit log', () => {
  it('lists events in words, newest first, with who did them and links to what they concern', async () => {
    const { requests } = setup()
    await screen.findByRole('list', { name: 'Audit events, newest first' })
    expect(lastQuery(requests)).toEqual({ page: '1', page_size: '50' })

    const [first, second, third] = eventItems()
    expect(first).toHaveTextContent('User updated')
    expect(first).toHaveTextContent('Lina Haddad')
    // The time to the second over the date, in the company's time zone (Amman).
    const time = first!.querySelector('time')!
    expect(time).toHaveAttribute('datetime', '2026-10-05T06:31:05Z')
    expect(time.firstElementChild).toHaveTextContent('09:31:05')
    expect(time.lastElementChild).toHaveTextContent('Mon, 5 Oct 2026')
    expect(within(first!).getByRole('link', { name: 'Events for this user' })).toHaveAttribute(
      'href',
      `/admin/audit?entity_type=user&entity_id=${userUpdated.entity_id}`,
    )
    expect(second).toHaveTextContent('Failure or denial:')
    expect(second).toHaveTextContent('Visitor pass scanned')
    expect(within(second!).getByText('Invalid')).toBeInTheDocument()
    expect(third).toHaveTextContent('Visit marked as no-show')
    expect(third).toHaveTextContent('System or anonymous')
    expect(within(third!).getByRole('link', { name: 'Open visit' })).toHaveAttribute('href', `/visits/${VISIT_ID}`)

    // The header counts the events; no description or time-zone sentence (decision 3).
    const header = screen.getByRole('heading', { level: 1, name: 'Audit log' }).closest('header')!
    expect(header).toHaveTextContent('3 events')
    expect(header.textContent).not.toMatch(/Append-only|Times are/)
    expect(screen.getByRole('combobox', { name: 'Performed by' })).not.toHaveAccessibleDescription()
    expect(screen.getByLabelText('Record ID')).not.toHaveAccessibleDescription()
    // Every filter is optional, so none is marked so; "Clear filters" takes the cell after Record ID (review).
    expect(screen.queryByText(/optional/i)).toBeNull()
    const grid = screen.getByLabelText('Record ID').closest('.grid') as HTMLElement
    expect(grid).toContainElement(screen.getByRole('button', { name: 'Clear filters' }))
    expect(grid.lastElementChild).toContainElement(screen.getByRole('button', { name: 'Clear filters' }))
  })

  it('expands an event to everything recorded, and shows metadata as text, never as markup', async () => {
    const hostile = makeAuditLog({
      metadata: { route: '<img src=x onerror="window.hacked=1">', changed_fields: ['<script>alert(1)</script>'], coalesced: 3 },
    })
    const { user } = setup({ logs: () => jsonResponse(page([hostile], { page_size: 50 })) })
    await screen.findByRole('list', { name: 'Audit events, newest first' })

    const toggle = screen.getByRole('button', { name: /^Details: User updated, Mon, 5 Oct 2026, 09:31:05/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const details = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(details).toHaveTextContent('203.0.113.10')
    expect(details).toHaveTextContent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(details).toHaveTextContent('req-7c1e')
    expect(details).toHaveTextContent('1042')
    expect(details).toHaveTextContent('2026-10-05T06:31:05Z')
    expect(within(details).getByText('Route').nextElementSibling).toHaveTextContent('<img src=x onerror="window.hacked=1">')
    expect(within(details).getByText('Changed fields').nextElementSibling).toHaveTextContent('<script>alert(1)</script>')
    expect(within(details).getByText('Merged events').nextElementSibling).toHaveTextContent('3')
    // Rendered as characters: no element was created from the stored strings.
    expect(details.querySelector('img, script, b')).toBeNull()
    expect((window as { hacked?: number }).hacked).toBeUndefined()
    expect(details.querySelector('pre')?.textContent).toContain('"route": "<img src=x onerror=\\"window.hacked=1\\">"')
  })

  it('labels each open event’s recorded details as a group, not a landmark, so several open events do not repeat one', async () => {
    const { user } = setup()
    await screen.findByRole('list', { name: 'Audit events, newest first' })
    for (const toggle of screen.getAllByRole('button', { name: /^Details: / })) await user.click(toggle)

    // axe `landmark-unique`: a labelled <section> is a region landmark, and three open events gave three named alike.
    const list = screen.getByRole('list', { name: 'Audit events, newest first' })
    expect(within(list).getAllByRole('group', { name: 'Recorded details' })).toHaveLength(3)
    expect(within(list).queryAllByRole('region')).toHaveLength(0)
    expect(list.querySelectorAll('section')).toHaveLength(0)
  })

  it('sends the filters in the URL and keeps them in step with the controls', async () => {
    const entityId = '7f0d1c0e-1111-4a5b-9c1d-000000000077'
    const actor = makeUser({ id: '7f0d1c0e-1111-4a5b-9c1d-0000000000ab', full_name: 'Sami Admin', email: 'sami@acme.example', is_active: false })
    const { requests, router, user } = setup({
      path: `/admin/audit?action=USER_UPDATED&entity_type=user&entity_id=${entityId}&from=2026-10-01&to=2026-10-05&page=2`,
      extra: { 'GET /users': () => jsonResponse(page([actor], { page_size: 10 })) },
    })
    await screen.findByRole('list', { name: 'Audit events, newest first' })
    expect(lastQuery(requests)).toEqual({
      page: '2',
      page_size: '50',
      action: 'USER_UPDATED',
      entity_type: 'user',
      entity_id: entityId,
      date_from: '2026-10-01',
      date_to: '2026-10-05',
    })
    expect(screen.getByRole('combobox', { name: 'Event' })).toHaveValue('USER_UPDATED')
    expect(screen.getByRole('combobox', { name: 'Record type' })).toHaveValue('user')
    expect(screen.getByLabelText('Record ID')).toHaveValue(entityId)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Event' }), 'AUTH_LOGIN_FAILED')
    await waitFor(() => expect(lastQuery(requests)).toMatchObject({ action: 'AUTH_LOGIN_FAILED', page: '1' }))

    await user.type(screen.getByRole('combobox', { name: 'Performed by' }), 'sami')
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option')).toHaveTextContent('(inactive)')
    await user.click(within(listbox).getByRole('option'))
    await waitFor(() => expect(lastQuery(requests).actor_user_id).toBe(actor.id))
    // The URL holds the ID only; the name shown is the record that was picked.
    const search = new URLSearchParams(router.state.location.search)
    expect(search.get('actor')).toBe(actor.id)
    expect(search.has('actorName')).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Performed by' })).toHaveValue('Sami Admin')
    expect(requests.filter((request) => request.path === `/users/${actor.id}`)).toHaveLength(0)
  })

  it('names the actor of a link by the server’s record for its ID, never by a name in the URL', async () => {
    const actor = makeUser({ id: '7f0d1c0e-1111-4a5b-9c1d-0000000000ab', full_name: 'Sami Admin' })
    const { requests } = setup({
      // A crafted link: Sami's ID labelled with another user's name.
      path: `/admin/audit?actor=${actor.id}&actorName=Lina%20Haddad`,
      extra: { [`GET /users/${actor.id}`]: () => jsonResponse(actor) },
    })
    await screen.findByRole('list', { name: 'Audit events, newest first' })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Performed by' })).toHaveValue('Sami Admin'))
    expect(lastQuery(requests).actor_user_id).toBe(actor.id)
  })

  it('says "Unknown user" for an actor ID that is not a user of the company', async () => {
    const id = '7f0d1c0e-1111-4a5b-9c1d-0000000000ff'
    const { requests } = setup({
      path: `/admin/audit?actor=${id}&actorName=Lina%20Haddad`,
      extra: { [`GET /users/${id}`]: () => errorResponse(404, 'NOT_FOUND', 'User not found.') },
    })
    await screen.findByRole('list', { name: 'Audit events, newest first' })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Performed by' })).toHaveValue('Unknown user'))
    expect(requests.filter((request) => request.path === `/users/${id}`)).toHaveLength(1)
  })

  it('refuses an incomplete ID instead of sending it', async () => {
    const { requests, user } = setup()
    await screen.findByRole('list', { name: 'Audit events, newest first' })
    const id = screen.getByLabelText('Record ID')

    await user.type(id, '7f0d1c0e-1111')
    fireEvent.blur(id)
    expect(id).toHaveAccessibleDescription(expect.stringContaining('Enter a complete ID'))
    expect(auditRequests(requests).every((request) => !request.url.searchParams.has('entity_id'))).toBe(true)
  })

  it('names an action the labels do not know yet', async () => {
    setup({ path: '/admin/audit?action=BADGE_PRINTED' })
    const select = await screen.findByRole('combobox', { name: 'Event' })
    expect(within(select).getByRole('option', { name: 'Badge printed' })).toBeInTheDocument()
    expect(select).toHaveValue('BADGE_PRINTED')
  })

  it('offers only the record types a company’s log can hold: no platform account (UX review L17)', async () => {
    setup()
    const select = await screen.findByRole('combobox', { name: 'Record type' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All records',
      'Visit',
      'Visitor',
      'User',
      'Department',
      'Company',
      'Visitor pass',
      'Email',
      'Session',
      'Email texts',
      // Phase 15: the places and the tracking's cameras and keys.
      'Building',
      'Floor',
      'Zone',
      'Camera',
      'Provider key',
    ])
    // The platform's own actions were never offered either.
    expect(within(screen.getByRole('combobox', { name: 'Event' })).queryByRole('option', { name: /Platform account/ })).toBeNull()
  })

  it('still shows a record type from a link that the filter does not offer', async () => {
    const { requests } = setup({ path: '/admin/audit?entity_type=platform_admin' })
    const select = await screen.findByRole('combobox', { name: 'Record type' })
    expect(select).toHaveValue('platform_admin')
    expect(within(select).getAllByRole('option', { name: 'Platform account' })).toHaveLength(1)
    await waitFor(() => expect(lastQuery(requests)).toMatchObject({ entity_type: 'platform_admin' }))
  })

  it('lays a row out in columns from the tablet’s width: a company’s log has no company column (UX review H1)', async () => {
    setup()
    const list = await screen.findByRole('list', { name: 'Audit events, newest first' })
    const row = list.querySelector('[data-audit-row]')!
    expect(row.className).toContain('md:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,11rem)_7.5rem]')
    expect(row.querySelector('[data-audit-cell="company"]')).toBeNull()
    expect(list.parentElement!.querySelector('[data-audit-header]')).toHaveClass('hidden', 'md:grid')
  })

  it('shows the raw metadata left to right, at its full height (UX review M7)', async () => {
    const { user } = setup({ logs: () => jsonResponse(page([makeAuditLog({ metadata: { changed_fields: ['name', 'name_ar'], source: 'platform' } })], { page_size: 50 })) })
    await user.click(await screen.findByRole('button', { name: /^Details: / }))
    const raw = document.querySelector('pre')!
    // JSON is left to right in the Arabic UI too; no scroll box of its own, which needed a tab stop (axe scrollable-region-focusable).
    expect(raw).toHaveAttribute('dir', 'ltr')
    expect(raw.className).not.toMatch(/overflow-(?:auto|y-auto|scroll)|max-h-/)
    expect(raw).not.toHaveAttribute('tabindex')
  })

  it('shows empty and failed results', async () => {
    let fail = false
    const { user } = setup({
      path: '/admin/audit?action=CSRF_FAILED',
      logs: () => (fail ? errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : jsonResponse(page<AuditLog>([], { page_size: 50 }))),
    })
    expect(await screen.findByRole('heading', { name: 'No events match these filters' })).toBeInTheDocument()

    fail = true
    await user.selectOptions(screen.getByRole('combobox', { name: 'Event' }), 'RATE_LIMITED')
    expect(await screen.findByText('The audit log could not be loaded')).toBeInTheDocument()
  })
})
