import { onlineManager } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queryKeys'
import { routes } from '../test/appRoutes'
import { deferred, errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../test/api'
import { FINANCE, LEGAL, makeVisit, makeVisitor, VISIT_ID, VISITOR_ID } from '../test/fixtures'
import { i18n } from '../i18n'
import { findAlert, renderRoutes } from '../test/render'
import type { Role, Visit } from '../types/api'

const NOW = new Date('2026-10-05T06:10:00Z') // 09:10 Amman
const PASS_URL = 'https://visitors.example.com/pass#Yp4_wL0-bR3sU8nO5cM9dZ2aX7fI6kQ1tE-hG_vJl3B'
const DETAIL = `/visits/${VISIT_ID}`
const RESCHEDULE_QUEUED = { kind: 'VISIT_RESCHEDULED', status: 'PENDING', to_email: 'elodie@orbit.example', sent_at: null, error: null } as const

function setup({
  visit = makeVisit(),
  roles = ['EMPLOYEE'],
  routes: extra = {},
}: { visit?: Visit | RouteHandler; roles?: Role[]; routes?: Record<string, RouteHandler> } = {}) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(roles)),
    [`GET ${DETAIL}`]: typeof visit === 'function' ? visit : () => jsonResponse(visit),
    'GET /departments': () => jsonResponse([FINANCE, LEGAL]),
    ...extra,
  })
  const view = renderRoutes(routes, { initialEntries: [DETAIL] })
  return { ...api, ...view }
}

function bodyOf(requests: RecordedRequest[], method: string, path: string): unknown {
  return requests.find((request) => request.method === method && request.path === path)?.body
}

/** The page's requests for the visit. */
function visitLoads(requests: RecordedRequest[]): number {
  return requests.filter((request) => request.method === 'GET' && request.path === DETAIL).length
}

async function loaded(name = 'Élodie Martin') {
  return screen.findByRole('heading', { level: 1, name })
}

/** Picks a new start date and time in the edit dialog (company wall time). */
function reschedule(dialog: HTMLElement, date: string, time: string) {
  fireEvent.change(within(dialog).getByLabelText('Starts date'), { target: { value: date } })
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Starts time' }), { target: { value: time } })
}

describe('Visit detail', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the visitor, status, schedule in the company timezone, people, purpose and timeline', async () => {
    setup()
    const title = await loaded()
    // The browser keeps page titles in its saved history: never the visitor's name (SEC-27).
    await waitFor(() => expect(document.title).toBe('Visit details · Acme Holdings'))

    const pageHeader = title.closest('header') as HTMLElement
    expect(within(pageHeader).getByText('Scheduled')).toBeInTheDocument()
    expect(within(pageHeader).getByText('Invitation sent')).toBeInTheDocument()
    expect(pageHeader).toHaveTextContent('Orbit Labs')

    const details = screen.getByRole('heading', { name: 'Visit details' }).closest('section') as HTMLElement
    // The schedule leads the card (direction C's numerals); no time-zone note (decision 3).
    expect(details).toHaveTextContent('WhenTue, 6 Oct 2026, 09:00–\u206010:00')
    expect(details).not.toHaveTextContent(/Times on this page|UTC/)
    expect(within(details).getByRole('link', { name: 'Call Lina Haddad: +962 79 000 0001' })).toHaveAttribute('href', 'tel:+962790000001')
    expect(details).toHaveTextContent('Finance')
    expect(details).toHaveTextContent('Quarterly review')
    expect(details).toHaveTextContent('Created byLina Haddad on Mon, 5 Oct 2026 at 09:10')
    expect(within(details).getByRole('link', { name: 'Élodie Martin' })).toHaveAttribute('href', '/visitors/5a1b2c3d-0000-4000-8000-0000000000a1')

    const timeline = screen.getByRole('heading', { name: 'Timeline' }).closest('section') as HTMLElement
    expect(within(timeline).getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Visit created',
      'Invitation sent',
    ])
    // The connector joins the dots on the inline start (the right in Arabic, where the dots are):
    // a physical `left-[5px]` left it on the far side of the Arabic timeline (phase 10 review).
    const connectors = timeline.querySelectorAll('[data-timeline-connector]')
    expect(connectors).toHaveLength(1)
    expect(connectors[0]).toHaveClass('start-[5px]')
    expect(connectors[0]?.className).not.toMatch(/\b(left|right)-/)

    // One line; "sent" (accepted by the provider), never "delivered". One attempt is not worth a line.
    const invitation = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    expect(within(invitation).getByText('Sent')).toBeInTheDocument()
    expect(invitation).toHaveTextContent('Sent to elodie@orbit.example on Mon, 5 Oct 2026 at 09:10.')
    expect(invitation).not.toHaveTextContent(/attempt/i)
    expect(invitation).not.toHaveTextContent(/deliver/i)

    const pass = screen.getByRole('heading', { name: 'Visitor pass' }).closest('section') as HTMLElement
    expect(within(pass).getByText('Active')).toBeInTheDocument()
    // The window's date too, not only its times (a visit on another day than today). No security note (decision 3).
    expect(pass).toHaveTextContent('Valid Tue, 6 Oct 2026, 08:00–\u206011:00')
    expect(pass).not.toHaveTextContent(/arrival margin|shown only once/)
    // An invitation email carries the pass: no new link is offered.
    expect(within(pass).queryByRole('button', { name: 'Issue a new pass link' })).toBeNull()

    // One fixed order: details, invitation, pass, timeline (also the order in one column).
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Visit details',
      'Invitation',
      'Visitor pass',
      'Timeline',
    ])
  })

  it('keeps "Cancel visit" from being the strongest action on the page', async () => {
    setup()
    await loaded()
    const cancel = screen.getByRole('button', { name: 'Cancel visit' })
    // An outlined danger button: the solid red style is kept for the confirmation dialog.
    expect(cancel.className).toContain('border-danger-solid')
    expect(cancel.className).not.toContain('bg-danger-solid')
  })

  it('offers edit, resend and cancel only as the visit’s permissions allow', async () => {
    setup({ visit: makeVisit({ permissions: { can_edit: true, can_resend: false, can_cancel: true } }) })
    await loaded()

    expect(screen.getByRole('button', { name: 'Edit or reschedule' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel visit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Resend invitation/ })).toBeNull()
  })

  it('shows no actions to the host when the server allows none (e.g. a checked-in visit)', async () => {
    setup({
      visit: makeVisit({
        status: 'CHECKED_IN',
        check_in_at: '2026-10-06T06:02:00Z',
        check_in_method: 'QR',
        checked_in_by: { id: 'r1', full_name: 'Rana Saleh' },
        permissions: { can_edit: false, can_resend: false, can_cancel: false },
      }),
    })
    await loaded()

    expect(screen.queryByRole('button', { name: 'Edit or reschedule' })).toBeNull()
    expect(screen.queryByRole('button', { name: /invitation/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel visit' })).toBeNull()
    expect(screen.getByText('Checked in by Rana Saleh')).toBeInTheDocument()
  })

  it('follows the permissions, not the role: a management user sees what the server allows', async () => {
    setup({ roles: ['MANAGEMENT'], visit: makeVisit({ permissions: { can_edit: false, can_resend: false, can_cancel: true } }) })
    await loaded()

    expect(screen.getByRole('button', { name: 'Cancel visit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit or reschedule' })).toBeNull()
    // Without "My visits" access the back link leads to Visitors.
    expect(screen.getByRole('link', { name: 'Back to Visitors' })).toHaveAttribute('href', '/visitors')
  })

  it('edits the purpose and department, sending only what changed', async () => {
    const updated = makeVisit({ purpose: 'Contract signing', department: { id: LEGAL.id, name: LEGAL.name, name_ar: null } })
    const { user, requests } = setup({ routes: { [`PATCH ${DETAIL}`]: () => jsonResponse(updated) } })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Edit or reschedule' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit or reschedule visit' })
    expect(dialog).toHaveAccessibleDescription('Élodie Martin · Tue, 6 Oct 2026, 09:00–\u206010:00')
    // No note about the emails a change sends (decision 3): the confirmation says what happened.
    expect(within(dialog).queryByRole('status')).toBeNull()
    expect(dialog).not.toHaveTextContent(/emailed|QR code/)

    const purpose = within(dialog).getByRole('textbox', { name: /^Purpose/ })
    await user.clear(purpose)
    await user.type(purpose, 'Contract signing')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Department/ }), 'Legal')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Visit updated')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(bodyOf(requests, 'PATCH', DETAIL)).toEqual({ purpose: 'Contract signing', department_id: LEGAL.id })
    const details = screen.getByRole('heading', { name: 'Visit details' }).closest('section') as HTMLElement
    expect(details).toHaveTextContent('Contract signing')
  })

  it('reschedules: both ends in UTC, the length kept, and the visitor emailed', async () => {
    const { user, requests } = setup({
      routes: {
        [`PATCH ${DETAIL}`]: (request) => {
          const body = request.body as { scheduled_start: string; scheduled_end: string }
          // The server queued the email about the new time: the response's latest notice.
          return jsonResponse(
            makeVisit({ scheduled_start: body.scheduled_start, scheduled_end: body.scheduled_end, last_notice: RESCHEDULE_QUEUED }),
          )
        },
      },
    })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Edit or reschedule' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Starts date')).toHaveValue('2026-10-06')
    expect(within(dialog).getByRole('combobox', { name: 'Starts time' })).toHaveValue('09:00')

    reschedule(dialog, '2026-10-07', '14:00')
    expect(within(dialog).getByLabelText('Ends date')).toHaveValue('2026-10-07')
    expect(within(dialog).getByRole('combobox', { name: 'Ends time' })).toHaveValue('15:00')
    // Read back in the app's own format (the native date input shows the browser locale's).
    expect(dialog).toHaveTextContent('Wed, 7 Oct 2026 · 14:00–\u206015:00 (1h)')
    // No time-zone or 24-hour note under the pair (decision 3).
    expect(within(dialog).getByLabelText('Starts date')).not.toHaveAccessibleDescription()
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Visit rescheduled')).toBeInTheDocument()
    expect(screen.getByText('The visitor is being emailed the new date and time.')).toBeInTheDocument()
    expect(bodyOf(requests, 'PATCH', DETAIL)).toEqual({
      scheduled_start: '2026-10-07T11:00:00.000Z',
      scheduled_end: '2026-10-07T12:00:00.000Z',
    })
  })

  it('says so when the server left the email about the new time out (notice budget, B24-70)', async () => {
    const { user } = setup({
      routes: {
        [`PATCH ${DETAIL}`]: (request) => {
          const body = request.body as { scheduled_start: string; scheduled_end: string }
          // Saved, but no new notice: the visit's latest notice is still none.
          return jsonResponse(makeVisit({ scheduled_start: body.scheduled_start, scheduled_end: body.scheduled_end }))
        },
      },
    })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Edit or reschedule' }))
    reschedule(screen.getByRole('dialog'), '2026-10-07', '14:00')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Visit rescheduled')).toBeInTheDocument()
    expect(screen.getByText('The visitor was not emailed: the limit for emails about changes was reached.')).toBeInTheDocument()
    expect(screen.queryByText(/is being emailed the new date/)).toBeNull()
  })

  it('does not let the end of a visit under way move into the past', async () => {
    // 08:30–09:30 Amman; now 09:10.
    const underWay = makeVisit({ scheduled_start: '2026-10-05T05:30:00Z', scheduled_end: '2026-10-05T06:30:00Z' })
    const { user, requests } = setup({ visit: underWay })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Edit or reschedule' }))
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Ends time' }), { target: { value: '09:00' } })
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(within(dialog).getByRole('combobox', { name: 'Ends time' })).toHaveAccessibleDescription(/The end cannot be in the past\./)
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false)
  })

  it('does not promise a reschedule email when no invitation was sent', async () => {
    const notInvited = makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } })
    const { user } = setup({
      visit: notInvited,
      routes: {
        [`PATCH ${DETAIL}`]: (request) => {
          const body = request.body as { scheduled_start: string; scheduled_end: string }
          return jsonResponse({ ...notInvited, scheduled_start: body.scheduled_start, scheduled_end: body.scheduled_end })
        },
      },
    })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Edit or reschedule' }))
    const dialog = screen.getByRole('dialog')

    reschedule(dialog, '2026-10-07', '14:00')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('The visitor was not emailed.')).toBeInTheDocument()
    expect(screen.queryByText(/is being emailed/)).toBeNull()
  })

  it('shows a refusal in the dialog with the server message and reloads the visit', async () => {
    let fetches = 0
    const { user } = setup({
      visit: () => {
        fetches += 1
        return jsonResponse(makeVisit())
      },
      routes: { [`PATCH ${DETAIL}`]: () => errorResponse(409, 'VISIT_NOT_EDITABLE', 'Only scheduled visits can be changed.') },
    })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Edit or reschedule' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: /^Purpose/ }), ' (updated)')

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByText('Only scheduled visits can be changed.')).toBeInTheDocument()
    await waitFor(() => expect(fetches).toBe(2))
  })

  it('cancels with an optional reason and notifies the visitor by default', async () => {
    const cancelled = makeVisit({
      status: 'CANCELLED',
      cancelled_at: '2026-10-05T06:12:00Z',
      cancelled_by: { id: 'u1', full_name: 'Lina Haddad' },
      cancellation_reason: 'Meeting moved online',
      pass: { status: 'REVOKED', revoke_reason: 'VISIT_CANCELLED' },
      permissions: { can_edit: false, can_resend: false, can_cancel: false },
      last_notice: { kind: 'VISIT_CANCELLED', status: 'PENDING', to_email: 'elodie@orbit.example', sent_at: null, error: null },
    })
    // The page follows the cancellation email while it is sent: later reads return the cancelled visit.
    let current = makeVisit()
    const { user, requests } = setup({
      visit: () => jsonResponse(current),
      routes: {
        [`POST ${DETAIL}/cancel`]: () => {
          current = cancelled
          return jsonResponse(cancelled)
        },
      },
    })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Cancel visit' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this visit?' })
    expect(dialog).toHaveAccessibleDescription(/Tue, 6 Oct 2026, 09:00–\u206010:00\. The visitor’s QR code stops working/)
    expect(within(dialog).getByRole('checkbox', { name: 'Notify the visitor by email' })).toBeChecked()
    await user.type(within(dialog).getByRole('textbox', { name: /^Reason/ }), '  Meeting moved online ')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel visit' }))

    expect(await screen.findByText('Visit cancelled')).toBeInTheDocument()
    expect(bodyOf(requests, 'POST', `${DETAIL}/cancel`)).toEqual({ reason: 'Meeting moved online', notify_visitor: true })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // The button that opened the dialog is gone with the permission; focus continues at the heading.
    expect(screen.queryByRole('button', { name: 'Cancel visit' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Élodie Martin' })).toHaveFocus()
    expect(screen.getByText('Cancelled by Lina Haddad')).toBeInTheDocument()
    expect(screen.getByText('The visit was cancelled.')).toBeInTheDocument()
    // Who, when and why, right under the header.
    expect(screen.getByText('This visit was cancelled').parentElement).toHaveTextContent(
      'Cancelled by Lina Haddad on Mon, 5 Oct 2026 at 09:12. Reason: Meeting moved online',
    )
    // The response carries the queued cancellation email, so the confirmation may say so.
    expect(screen.getByText('The visitor is being notified by email.')).toBeInTheDocument()
    expect(screen.getByText('This visit was cancelled').parentElement).toHaveTextContent(
      'The cancellation is being emailed to elodie@orbit.example.',
    )
  })

  it('tells the host when the cancellation email could not be sent, and shows the invitation as history', async () => {
    setup({
      roles: ['MANAGEMENT'],
      visit: makeVisit({
        status: 'CANCELLED',
        cancelled_at: '2026-10-05T06:12:00Z',
        cancelled_by: { id: 'u1', full_name: 'Lina Haddad' },
        pass: { status: 'REVOKED', revoke_reason: 'VISIT_CANCELLED' },
        permissions: { can_edit: false, can_resend: false, can_cancel: false },
        last_notice: { kind: 'VISIT_CANCELLED', status: 'FAILED', to_email: 'elodie@orbit.example', sent_at: null, error: 'Mailbox unavailable' },
      }),
    })
    await loaded()

    const banner = screen.getByText('This visit was cancelled').parentElement as HTMLElement
    expect(banner).toHaveTextContent('The cancellation email to elodie@orbit.example could not be sent. Let the visitor know yourself.')
    const timeline = screen.getByRole('heading', { name: 'Timeline' }).closest('section') as HTMLElement
    expect(within(timeline).getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Visit created',
      'Invitation sent',
      'Cancelled by Lina Haddad',
      'Cancellation email could not be sent',
    ])
    expect(timeline).toHaveTextContent('The visitor was not told. Let them know yourself.')

    // The invitation is history now: a green "Sent" must not read as if the visit were on.
    const invitation = screen.getByRole('heading', { name: 'Original invitation' }).closest('section') as HTMLElement
    const badge = within(invitation).getByText('Sent').closest('span.rounded-full')
    expect(badge).toHaveClass('bg-neutral-surface')
    expect(screen.queryByRole('heading', { name: 'Invitation' })).toBeNull()
  })

  it('does not offer to notify a visitor who has no email address', async () => {
    const noAddress = makeVisit({
      invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null },
      permissions: { can_resend: false },
    })
    const { user, requests } = setup({
      visit: noAddress,
      routes: {
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor({ email: null })),
        [`POST ${DETAIL}/cancel`]: () => jsonResponse({ ...noAddress, status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z' }),
      },
    })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Cancel visit' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(dialog).toHaveTextContent('The visitor will not be emailed.')
    // One sentence for what the cancellation does; the reason's hint is only its length.
    expect(dialog).toHaveAccessibleDescription(/^Élodie Martin, Tue, 6 Oct 2026, 09:00–\u206010:00\. The visitor’s QR code stops working\.$/)
    expect(within(dialog).getByRole('textbox', { name: /^Reason/ })).toHaveAccessibleDescription('0 of 300 characters')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel visit' }))

    expect(await screen.findByText('The visitor was not notified.')).toBeInTheDocument()
    expect(bodyOf(requests, 'POST', `${DETAIL}/cancel`)).toEqual({ notify_visitor: false })
  })

  it('does not offer to notify a visitor who has an address but was never invited (B24-70)', async () => {
    // Created with "share the pass myself": the visitor has an address (can_resend), but the
    // server sends no cancellation email for a visit whose invitation was never requested.
    const notInvited = makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } })
    const { user, requests } = setup({
      visit: notInvited,
      routes: { [`POST ${DETAIL}/cancel`]: () => jsonResponse({ ...notInvited, status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z' }) },
    })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Cancel visit' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(dialog).toHaveTextContent('The visitor will not be emailed.')
    expect(within(dialog).getByRole('textbox', { name: /^Reason/ })).toHaveAccessibleDescription('0 of 300 characters')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel visit' }))

    expect(await screen.findByText('The visitor was not notified.')).toBeInTheDocument()
    expect(screen.queryByText('The visitor is being notified by email.')).toBeNull()
    expect(bodyOf(requests, 'POST', `${DETAIL}/cancel`)).toEqual({ notify_visitor: false })
  })

  it('offers no choice when the visitor was sent the calendar invitation: the cancellation always tells them', async () => {
    const inCalendar = makeVisit({ visitor_calendar_sent: true })
    const cancelled = makeVisit({
      visitor_calendar_sent: true,
      status: 'CANCELLED',
      cancelled_at: '2026-10-05T06:12:00Z',
      calendar_sequence: 1,
      permissions: { can_edit: false, can_cancel: false, can_resend: false },
      last_notice: { kind: 'VISIT_CANCELLED', status: 'PENDING', to_email: 'elodie@orbit.example', sent_at: null, error: null },
    })
    const { user, requests } = setup({ visit: inCalendar, routes: { [`POST ${DETAIL}/cancel`]: () => jsonResponse(cancelled) } })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Cancel visit' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this visit?' })
    // No box to clear and no words about it: the visitor will be told, and the visit leaves their calendar.
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(dialog).not.toHaveTextContent('The visitor will not be emailed.')
    expect(dialog).not.toHaveTextContent(/notify|email/i)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel visit' }))

    expect(await screen.findByText('The visitor is being notified by email.')).toBeInTheDocument()
    expect(bodyOf(requests, 'POST', `${DETAIL}/cancel`)).toEqual({ notify_visitor: true })
  })

  it('offers no choice and says nothing about e-mail for such a visitor even with no address on file now; the outcome says what happened', async () => {
    // The address was removed after the calendar invitation went out: the response tells whether an e-mail went.
    const inCalendar = makeVisit({ visitor_calendar_sent: true, permissions: { can_resend: false } })
    const { user } = setup({
      visit: inCalendar,
      routes: { [`POST ${DETAIL}/cancel`]: () => jsonResponse({ ...inCalendar, status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z' }) },
    })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Cancel visit' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(dialog).not.toHaveTextContent('The visitor will not be emailed.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel visit' }))

    expect(await screen.findByText('The visitor was not notified.')).toBeInTheDocument()
  })

  it('cancels without notifying the visitor when the box is cleared, and without a reason', async () => {
    const { user, requests } = setup({
      routes: {
        [`POST ${DETAIL}/cancel`]: () =>
          jsonResponse(makeVisit({ status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z', permissions: { can_edit: false, can_cancel: false } })),
      },
    })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Cancel visit' }))
    const dialog = screen.getByRole('alertdialog')

    await user.click(within(dialog).getByRole('checkbox', { name: 'Notify the visitor by email' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel visit' }))

    expect(await screen.findByText('The visitor was not notified.')).toBeInTheDocument()
    expect(bodyOf(requests, 'POST', `${DETAIL}/cancel`)).toEqual({ notify_visitor: false })
  })

  it('keeps the visit when the cancellation is dismissed', async () => {
    const { user, requests } = setup()
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Cancel visit' })

    await user.click(trigger)
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep visit' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
  })

  it('puts a failed invitation under the header with the ways out, and resends to the same address', async () => {
    const resent = makeVisit({ invitation: { status: 'PENDING', attempts: 0, sent_at: null } })
    const { user, requests } = setup({
      visit: makeVisit({ invitation: { status: 'FAILED', sent_at: null, attempts: 3, error: 'Recipient domain is configured to fail.' } }),
      routes: {
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()),
        [`POST ${DETAIL}/invitation`]: () => jsonResponse({ visit: resent, pass_url: PASS_URL, visitor_match: { reused: false } }),
      },
    })
    const title = await loaded()

    // The reason the visit needs attention is the first thing after the header.
    const header = title.closest('header') as HTMLElement
    expect(within(header).getByText('Invitation failed')).toBeInTheDocument()
    const banner = screen.getByText(/^Invitation not delivered to/).closest('div.flex') as HTMLElement
    expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner).toHaveTextContent('Invitation not delivered to elodie@orbit.example')
    // What happened and the ways out; no advice (decision 3).
    expect(banner).not.toHaveTextContent('The visit is still scheduled.')
    expect(await within(banner).findByRole('button', { name: 'Correct email and resend' })).toBeInTheDocument()
    // The resend lives in the banner, not twice on the page.
    expect(screen.getAllByRole('button', { name: /^Resend/ })).toHaveLength(1)

    const invitation = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    expect(invitation).toHaveTextContent('Could not be sent to elodie@orbit.example.')
    expect(invitation).toHaveTextContent('3 attempts, the last on Mon, 5 Oct 2026 at 09:10.')
    expect(within(invitation).getByText('Recipient domain is configured to fail.')).toBeInTheDocument()

    await user.click(within(banner).getByRole('button', { name: 'Resend to same address' }))
    let dialog = screen.getByRole('alertdialog', { name: 'Send the invitation again?' })
    // One consequence, the warning; the title says the rest (decision 3). Both lines describe the
    // alertdialog, so a screen reader announces them with its title (review: focus lands on "Keep").
    expect(dialog).not.toHaveTextContent('will receive a new invitation')
    expect(dialog).toHaveTextContent('The previous QR code will stop working')
    expect(dialog).toHaveAccessibleDescription('The last invitation to elodie@orbit.example could not be sent. The previous QR code will stop working')
    expect(dialog).not.toHaveTextContent(/Any QR code or pass link/)
    expect(within(dialog).getByRole('button', { name: 'Keep current invitation' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Keep current invitation' }))
    expect(requests.some((request) => request.path === `${DETAIL}/invitation`)).toBe(false)

    await user.click(within(banner).getByRole('button', { name: 'Resend to same address' }))
    dialog = screen.getByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Resend to same address' }))

    const heading = await screen.findByRole('heading', { level: 2, name: 'New visitor pass' })
    expect(heading).toHaveFocus()
    const panel = heading.closest('section') as HTMLElement
    expect(panel).toHaveTextContent('The previous QR code no longer works.')
    // The panel announces the new invitation's progress; the card below shows it without a second announcement.
    expect(within(panel).getAllByRole('status')[0]).toHaveTextContent('Sending the invitation to elodie@orbit.example')
    const invitationCard = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    expect(within(invitationCard).queryByRole('status')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Pass link' })).toHaveValue(PASS_URL)
    expect(screen.getByRole('textbox', { name: 'Pass link' })).toHaveAccessibleDescription('Shown only once.')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(requests.filter((request) => request.method === 'POST' && request.path === `${DETAIL}/invitation`)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('textbox', { name: 'Pass link' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Élodie Martin' })).toHaveFocus()
  })

  it('says when only the calendar invitation did not arrive, and sends it alone again: no new pass, no address doubted', async () => {
    const calendarFailed = makeVisit({
      invitation: { status: 'FAILED', sent_at: null, calendar_failed: true, attempts: 2, last_attempt_at: '2026-10-05T06:10:09Z', error: 'Mailbox full' },
    })
    // The resend sends the calendar invitation alone (B14-31): the invitation as it was, no new pass.
    const resent = makeVisit()
    let current = calendarFailed
    // No GET /visitors/{id}: the page does not load the visitor to offer a correction.
    const { user, requests } = setup({
      visit: () => jsonResponse(current),
      routes: {
        [`POST ${DETAIL}/invitation`]: () => {
          current = resent
          return jsonResponse({ visit: resent, pass_url: null, visitor_match: { reused: false } })
        },
      },
    })
    const title = await loaded()

    const header = title.closest('header') as HTMLElement
    expect(within(header).getByText('Calendar invitation not delivered')).toBeInTheDocument()
    expect(header).not.toHaveTextContent('Invitation failed')
    const invitation = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    // The banner's title; the card below says the same in its own line.
    const bannerTitle = screen.getAllByText(/^The calendar invitation did not reach/).find((element) => !invitation.contains(element))
    const banner = bannerTitle?.closest('div.flex') as HTMLElement
    expect(banner).toHaveTextContent('The calendar invitation did not reach elodie@orbit.example')
    expect(banner).not.toHaveTextContent('Invitation not delivered')
    // The address took the invitation: no correction; sending the calendar invitation again is the way out.
    expect(within(banner).queryByRole('button', { name: 'Correct email and resend' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Resend/ }).map((button) => button.textContent)).toEqual(['Resend calendar invitation'])
    expect(requests.some((request) => request.path.startsWith('/visitors/'))).toBe(false)

    expect(within(invitation).getByText('Calendar failed')).toBeInTheDocument()
    expect(invitation).toHaveTextContent('The calendar invitation did not reach elodie@orbit.example.')
    expect(invitation).not.toHaveTextContent('Could not be sent')
    expect(within(invitation).getByText('Mailbox full')).toBeInTheDocument()
    const timeline = screen.getByRole('heading', { name: 'Timeline' }).closest('section') as HTMLElement
    expect(within(timeline).getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Visit created',
      'Calendar invitation not delivered',
    ])

    await user.click(within(banner).getByRole('button', { name: 'Resend calendar invitation' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Send the calendar invitation again?' })
    // Nothing is replaced: no word of a new pass or QR code.
    expect(dialog).toHaveAccessibleDescription('The calendar invitation did not reach elodie@orbit.example.')
    expect(dialog).not.toHaveTextContent(/QR|pass/i)
    expect(within(dialog).queryByRole('button', { name: 'Correct email and resend' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Resend calendar invitation' }))

    expect(await screen.findByText('Sending the calendar invitation to elodie@orbit.example')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('heading', { level: 2, name: 'New visitor pass' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Pass link' })).toBeNull()
    // The banner went with the failure; the focus goes on from the page's heading.
    await waitFor(() => expect(screen.queryByText(/^The calendar invitation did not reach/)).toBeNull())
    await waitFor(() => expect(title).toHaveFocus())
    expect(requests.filter((request) => request.method === 'POST' && request.path === `${DETAIL}/invitation`)).toHaveLength(1)
  })

  it('keeps the calendar invitation’s resend in its dialog when the invitation budget is spent (429), nothing sent', async () => {
    const calendarFailed = makeVisit({ invitation: { status: 'FAILED', sent_at: null, calendar_failed: true } })
    const { user } = setup({
      visit: calendarFailed,
      routes: { [`POST ${DETAIL}/invitation`]: () => errorResponse(429, 'INVITATION_LIMIT', 'You have reached the limit of invitations for today.') },
    })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Resend calendar invitation' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Send the calendar invitation again?' })
    await user.click(within(dialog).getByRole('button', { name: 'Resend calendar invitation' }))
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/^Sending the calendar invitation/)).toBeNull()
  })

  it('corrects the visitor’s address from a failed invitation; the server re-sends it there', async () => {
    let visitFetches = 0
    const failedVisit = makeVisit({ invitation: { status: 'FAILED', sent_at: null, to_email: 'elodie@orbit.exmaple' } })
    const { user, requests } = setup({
      visit: () => {
        visitFetches += 1
        // After the address change (D-19) the invitation goes out again.
        return jsonResponse(
          requests.some((request) => request.method === 'PATCH')
            ? makeVisit({ invitation: { status: 'PENDING', sent_at: null, to_email: 'elodie@orbit.example' } })
            : failedVisit,
        )
      },
      routes: {
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor({ email: 'elodie@orbit.exmaple' })),
        [`PATCH /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor({ email: 'elodie@orbit.example' })),
        [`GET /visitors/${VISITOR_ID}/visits`]: () => jsonResponse({ items: [], page: 1, page_size: 20, total: 0 }),
      },
    })
    await loaded()

    await user.click(await screen.findByRole('button', { name: 'Correct email and resend' }))
    const dialog = screen.getByRole('dialog', { name: 'Correct the email address' })
    const email = within(dialog).getByRole('textbox', { name: /^Email/ })
    expect(email).toHaveFocus()
    await user.clear(email)
    await user.type(email, 'elodie@orbit.example')
    await user.click(within(dialog).getByRole('button', { name: 'Save and send invitation' }))

    expect(await screen.findByText('Any scheduled visits of Élodie Martin get a new invitation and QR code at elodie@orbit.example.')).toBeInTheDocument()
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ email: 'elodie@orbit.example' })
    // The visit is reloaded and shows the new invitation on its way.
    await waitFor(() => expect(visitFetches).toBeGreaterThan(1))
    const invitation = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    await waitFor(() => expect(within(invitation).getByRole('status')).toHaveTextContent('Sending the invitation to elodie@orbit.example'))
    expect(screen.queryByRole('button', { name: 'Correct email and resend' })).toBeNull()
  })

  it('offers the resend dialog’s own way to the address correction', async () => {
    const { user } = setup({
      visit: makeVisit({ invitation: { status: 'FAILED', sent_at: null } }),
      routes: { [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()) },
    })
    await loaded()
    await screen.findByRole('button', { name: 'Correct email and resend' })

    await user.click(screen.getByRole('button', { name: 'Resend to same address' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('The last invitation to elodie@orbit.example could not be sent.')
    expect(dialog).not.toHaveTextContent('If that address is wrong')
    await user.click(within(dialog).getByRole('button', { name: 'Correct email and resend' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Correct the email address' })).toBeInTheDocument()
  })

  it('tells the host how to reach a visitor without an email address', async () => {
    const { user } = setup({
      visit: makeVisit({
        invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null },
        permissions: { can_resend: false },
      }),
      routes: { [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor({ email: null })) },
    })
    await loaded()

    const invitation = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    expect(invitation).toHaveTextContent('The visitor has no email address.')
    await user.click(await within(invitation).findByRole('button', { name: 'Add an email address' }))
    expect(screen.getByRole('dialog', { name: 'Correct the email address' })).toBeInTheDocument()
  })

  it('shows a no-show’s outcome under the header, with the invitation as history', async () => {
    setup({
      visit: makeVisit({
        status: 'NO_SHOW',
        // Marked lazily (§5) two days after the pass expired at 11:00 on Tue 6 Oct (Amman).
        no_show_at: '2026-10-08T18:14:00Z',
        pass: { status: 'EXPIRED' },
        permissions: { can_edit: false, can_resend: false, can_cancel: false },
      }),
    })
    await loaded()

    // Worded from the pass window, so it agrees with the pass card; the marking time is the timeline's.
    // The fact only, under the title: the rule's explanation went (decision 3, review).
    const banner = screen.getByText('The visitor did not arrive').closest('div.flex') as HTMLElement
    expect(banner).toHaveTextContent('Pass expired on Tue, 6 Oct 2026 at 11:00.')
    expect(banner).not.toHaveTextContent('did not check in before')
    expect(banner).not.toHaveTextContent('Thu, 8 Oct')
    expect(screen.getByRole('heading', { name: 'Visitor pass' }).closest('section')).toHaveTextContent('The pass was valid until Tue, 6 Oct 2026, 11:00.')
    expect(screen.getByRole('heading', { name: 'Timeline' }).closest('section')).toHaveTextContent('Marked as no-showThu, 8 Oct 2026, 21:14')
    // The host's likely next step.
    expect(within(banner).getByRole('link', { name: 'Invite again' })).toHaveAttribute('href', `/visits/new?visitor=${VISITOR_ID}`)

    // The same card order as for any visit; the invitation is history.
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Visit details',
      'Original invitation',
      'Visitor pass',
      'Timeline',
    ])
    // A pass that no longer works needs no "shown only once" note.
    expect(screen.getByRole('heading', { name: 'Visitor pass' }).closest('section')).not.toHaveTextContent('shown only once')
  })

  it('offers "Invite again" on a cancelled visit only to those who may invite', async () => {
    const cancelled = makeVisit({
      status: 'CANCELLED',
      cancelled_at: '2026-10-05T06:12:00Z',
      pass: { status: 'REVOKED', revoke_reason: 'VISIT_CANCELLED' },
      permissions: { can_edit: false, can_resend: false, can_cancel: false },
    })
    setup({ roles: ['MANAGEMENT'], visit: cancelled })
    await loaded()

    expect(screen.getByText('This visit was cancelled')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Invite again' })).toBeNull()
  })

  it('gathers the header actions in one menu for phones, so the content comes first', async () => {
    const { user } = setup()
    await loaded()

    // Below sm the full-width buttons give way to this menu beside the title (CSS; jsdom renders both).
    const trigger = screen.getByRole('button', { name: 'Actions' })
    expect(trigger.closest('[class~="sm:hidden"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Edit or reschedule' }).parentElement?.className).toContain('max-sm:hidden')

    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit or reschedule',
      'Resend invitation',
      'Cancel visit',
    ])
    await user.click(within(menu).getByRole('menuitem', { name: 'Cancel visit' }))
    expect(screen.getByRole('alertdialog', { name: 'Cancel this visit?' })).toBeInTheDocument()
  })

  it('issues a new pass link for a visitor who gets no invitation email, warning that the old QR code stops working', async () => {
    const notInvited = makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } })
    const { user, requests } = setup({
      visit: notInvited,
      routes: {
        [`POST ${DETAIL}/pass`]: () =>
          jsonResponse({ visit: { ...notInvited, pass: { ...notInvited.pass, issued_at: '2026-10-05T06:10:30Z' } }, pass_url: PASS_URL }),
      },
    })
    await loaded()

    const passCard = screen.getByRole('heading', { name: 'Visitor pass' }).closest('section') as HTMLElement
    expect(passCard).not.toHaveTextContent(/shown only once|issue a new link/i)
    await user.click(within(passCard).getByRole('button', { name: 'Issue a new pass link' }))

    // The one sentence a destructive confirmation keeps: what stops working.
    const dialog = screen.getByRole('alertdialog', { name: 'Issue a new pass link?' })
    // The warning is the alertdialog's description: announced with its title, though focus starts on "Keep".
    expect(dialog).toHaveAccessibleDescription('The previous QR code will stop working')
    expect(dialog).toHaveTextContent('The previous QR code will stop working')
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Issue new pass link' }))

    const heading = await screen.findByRole('heading', { level: 2, name: 'New visitor pass' })
    expect(heading).toHaveFocus()
    const panel = heading.closest('section') as HTMLElement
    expect(panel).toHaveTextContent('The previous QR code no longer works.')
    // No email: no delivery status, and sharing the link is the main action.
    expect(within(panel).queryByText(/Sending the invitation/)).toBeNull()
    expect(within(panel).getByRole('textbox', { name: 'Pass link' })).toHaveValue(PASS_URL)
    // Like the one-time password: one short line says it is shown once.
    expect(within(panel).getByRole('textbox', { name: 'Pass link' })).toHaveAccessibleDescription('Shown only once.')
    expect(within(panel).getByRole('button', { name: 'Copy link' }).className).toContain('bg-accent')
    expect(requests.filter((request) => request.method === 'POST' && request.path === `${DETAIL}/pass`)).toHaveLength(1)
  })

  it('shows why a new pass link was refused', async () => {
    const notInvited = makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } })
    const { user } = setup({
      visit: notInvited,
      routes: { [`POST ${DETAIL}/pass`]: () => errorResponse(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.') },
    })
    await loaded()
    await user.click(screen.getByRole('button', { name: 'Issue a new pass link' }))
    const dialog = screen.getByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Issue new pass link' }))

    expect(await within(dialog).findByText('Too many requests. Please wait and try again.')).toBeInTheDocument()
  })

  it('shows why a resend was refused', async () => {
    const { user } = setup({
      routes: {
        [`POST ${DETAIL}/invitation`]: () =>
          errorResponse(409, 'VISITOR_EMAIL_REQUIRED', 'The visitor needs an email address to receive an invitation.'),
      },
    })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Resend invitation' }))
    const dialog = screen.getByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Resend invitation' }))

    expect(await within(dialog).findByText('The visitor needs an email address to receive an invitation.')).toBeInTheDocument()
  })

  it('polls an invitation that is being sent until it is sent', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
    let fetches = 0
    setup({
      visit: () => {
        fetches += 1
        return jsonResponse(fetches < 2 ? makeVisit({ invitation: { status: 'PENDING', sent_at: null } }) : makeVisit())
      },
    })
    await loaded()
    const pending = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    expect(within(pending).getByRole('status')).toHaveTextContent('Sending the invitation to elodie@orbit.example')

    await act(() => vi.advanceTimersByTimeAsync(2000))

    const invitation = screen.getByRole('heading', { name: 'Invitation' }).closest('section') as HTMLElement
    await waitFor(() => expect(invitation).toHaveTextContent('Sent to elodie@orbit.example on Mon, 5 Oct 2026 at 09:10.'))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(fetches).toBe(2)
  })

  it('shows a 404 with the way back, without repeating "not found" or guidance text', async () => {
    setup({ visit: () => errorResponse(404, 'NOT_FOUND', 'The requested item was not found.') })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visit not found' })).toBeInTheDocument()
    const empty = screen.getByRole('heading', { level: 2, name: 'This visit does not exist or is not available to you' })
    expect(empty.parentElement?.querySelector('p')).toBeNull()
    expect(screen.queryByText('The requested item was not found.')).toBeNull()
    expect(screen.getAllByRole('link', { name: 'Back to My visits' }).length).toBeGreaterThan(0)
  })

  it('ignores a back link that another user left in the tab’s history (SEC-28)', async () => {
    // Before: a receptionist opened this visit from a visitor's profile, then signed out; an
    // employee signed in in the same tab and pressed Back. The server refuses the visit to them.
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      [`GET ${DETAIL}`]: () => errorResponse(404, 'NOT_FOUND', 'The requested item was not found.'),
    })
    const state = { backLink: { to: `/visitors/${VISITOR_ID}`, label: 'Back to Zainab Secretvisitor', owner: '7f0d1c0e-1111-4a5b-9c1d-0000000000aa' } }
    renderRoutes(routes, { initialEntries: [{ pathname: DETAIL, state }] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Visit not found' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Back to My visits' })[0]).toHaveAttribute('href', '/visits')
    expect(document.body).not.toHaveTextContent('Zainab')
  })

  it('explains a 403 with the server message', async () => {
    setup({ visit: () => errorResponse(403, 'FORBIDDEN', 'You do not have permission to perform this action.') })

    expect(await screen.findByRole('heading', { level: 1, name: 'No access to this visit' })).toBeInTheDocument()
    expect(screen.getByText('You do not have permission to perform this action.')).toBeInTheDocument()
  })

  it('offers a retry for other failures', async () => {
    let fail = true
    const { user } = setup({
      visit: () => (fail ? errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : jsonResponse(makeVisit())),
    })

    const alert = await findAlert('The visit could not be loaded')
    expect(alert).toHaveTextContent('Something went wrong. Please try again.')
    // A server failure carries the reference the service desk can look up.
    expect(alert).toHaveTextContent('Reference: req-test-1')
    fail = false
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await loaded()).toBeInTheDocument()
  })
})

/** The dates of the open calendar menu's Google Calendar link. */
async function googleDates(): Promise<string | null> {
  const items = within(await screen.findByRole('menu', { name: 'Add to my calendar' })).getAllByRole('menuitem')
  return new URL(items[0]!.getAttribute('href')!).searchParams.get('dates')
}

/** The `.ics` the menu's last item saves, and the link it follows to save it. */
function captureDownload() {
  const blobs: Blob[] = []
  const links: HTMLAnchorElement[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:calendar/1'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    links.push(this)
  })
  return { blobs, links }
}

describe('Add to my calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const ADDRESS = { address: 'King Hussein Business Park\nBuilding 4', address_ar: 'مجمع الملك حسين للأعمال\nالمبنى 4' }

  /**
   * The visit page of `visit`. `now`, when given, answers every later request for the visit: the visit as
   * it is when the menu fetches it again, changed elsewhere since the page loaded.
   */
  function open({
    visit = makeVisit(),
    now,
    roles = ['EMPLOYEE'],
    language = 'en',
  }: { visit?: Visit; now?: RouteHandler; roles?: Role[]; language?: 'ar' | 'en' } = {}) {
    const me = makeMe(roles, { preferred_language: language })
    let loads = 0
    const api = mockApi({
      'GET /auth/me': () => jsonResponse({ ...me, company: { ...me.company, ...ADDRESS } }),
      [`GET ${DETAIL}`]: (request) => {
        loads += 1
        return loads > 1 && now ? now(request) : jsonResponse(visit)
      },
      'GET /departments': () => jsonResponse([FINANCE, LEGAL]),
    })
    return { ...api, ...renderRoutes(routes, { initialEntries: [DETAIL] }) }
  }

  const MOVED = makeVisit({ calendar_sequence: 1, scheduled_start: '2026-10-07T11:30:00Z', scheduled_end: '2026-10-07T12:15:00Z', updated_at: '2026-10-05T07:00:00Z' })

  it('offers the host their event in Google Calendar, in Outlook and as a file, from the schedule', async () => {
    const download = captureDownload()
    const { user } = open({ visit: makeVisit({ calendar_sequence: 2 }) })
    await loaded()

    const details = screen.getByRole('heading', { name: 'Visit details' }).closest('section') as HTMLElement
    const trigger = within(details).getByRole('button', { name: 'Add to my calendar' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Add to my calendar' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Google Calendar', 'Outlook', 'Apple and others (.ics)'])
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Google Calendar (opens in a new tab)', 'Outlook (opens in a new tab)', null])
    await waitFor(() => expect(items[0]).toHaveFocus())

    // The calendars' own new-event forms, in a new tab that knows nothing of this page.
    const google = new URL(items[0]!.getAttribute('href')!)
    expect(google.host).toBe('calendar.google.com')
    expect(google.searchParams.get('text')).toBe('Visit: Élodie Martin')
    expect(google.searchParams.get('dates')).toBe('20261006T060000Z/20261006T070000Z')
    expect(google.searchParams.get('location')).toBe('King Hussein Business Park, Building 4')
    expect(items[0]).toHaveAttribute('target', '_blank')
    expect(items[0]).toHaveAttribute('rel', 'noopener noreferrer')
    expect(new URL(items[1]!.getAttribute('href')!).host).toBe('outlook.office.com')

    await user.click(items[2]!)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(download.links.map((link) => [link.download, link.href])).toEqual([['visit-2026-10-06.ics', 'blob:calendar/1']])
    expect(download.blobs[0]!.type).toBe('text/calendar;charset=utf-8')
    const ics = await download.blobs[0]!.text()
    expect(ics).toContain(`\r\nUID:visit-${VISIT_ID}-host\r\nSEQUENCE:2\r\n`)
    expect(ics).toContain('\r\nSUMMARY:Visit: Élodie Martin\r\n')
    expect(ics).not.toMatch(/\/pass|#/)
  })

  it('is reached and left from the keyboard', async () => {
    const { user } = open()
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Add to my calendar' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Google Calendar/ })).toHaveFocus())
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Apple and others (.ics)' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('writes the event in Arabic in the Arabic UI', async () => {
    await i18n.changeLanguage('ar')
    const download = captureDownload()
    const { user } = open({ language: 'ar', visit: makeVisit({ department: { id: FINANCE.id, name: 'Finance', name_ar: 'المالية' } }) })
    await user.click(await screen.findByRole('button', { name: 'أضف إلى تقويمي' }))
    const items = within(await screen.findByRole('menu', { name: 'أضف إلى تقويمي' })).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['تقويم Google', 'Outlook', 'تقويم Apple وغيره (ملف ics)'])
    expect(new URL(items[0]!.getAttribute('href')!).searchParams.get('location')).toBe('مجمع الملك حسين للأعمال، المبنى 4')
    await user.click(items[2]!)
    const ics = (await download.blobs[0]!.text()).replace(/\r\n /g, '')
    expect(ics).toContain('SUMMARY:زيارة: Élodie Martin\r\n')
    expect(ics).toContain('DESCRIPTION:الزائر: Élodie Martin\\nالشركة: Orbit Labs\\nالقسم: المالية\\nالغرض من الزيارة: Quarterly review\r\n')
  })

  it('is offered for the host’s own scheduled visit only, not after it ended', async () => {
    const cases: [string, Visit, Role[]][] = [
      ['cancelled', makeVisit({ status: 'CANCELLED', cancelled_at: '2026-10-05T06:00:00Z' }), ['EMPLOYEE']],
      ['checked in', makeVisit({ status: 'CHECKED_IN', check_in_at: '2026-10-05T06:00:00Z', check_in_method: 'QR' }), ['EMPLOYEE']],
      ['ended', makeVisit({ scheduled_start: '2026-10-05T04:00:00Z', scheduled_end: '2026-10-05T05:00:00Z' }), ['EMPLOYEE']],
      ['walk-in', makeVisit({ is_walk_in: true }), ['EMPLOYEE']],
      ['another host’s', makeVisit({ host: { id: 'another-host', full_name: 'Omar Khalil', phone: null } }), ['SYSTEM_ADMIN', 'EMPLOYEE']],
    ]
    for (const [, visit, roles] of cases) {
      const view = open({ visit, roles })
      await loaded()
      expect(screen.queryByRole('button', { name: 'Add to my calendar' })).toBeNull()
      view.unmount()
    }
  })

  it('is written from the visit as it is when the menu opens: a new time made elsewhere since the page loaded', async () => {
    const download = captureDownload()
    const moved = makeVisit({ calendar_sequence: 1, scheduled_start: '2026-10-07T11:30:00Z', scheduled_end: '2026-10-07T12:15:00Z', updated_at: '2026-10-05T07:00:00Z' })
    const { user, requests } = open({ now: () => jsonResponse(moved) })
    await loaded()
    const details = screen.getByRole('heading', { name: 'Visit details' }).closest('section') as HTMLElement
    expect(details).toHaveTextContent('Tue, 6 Oct 2026, 09:00–\u206010:00')

    await user.click(screen.getByRole('button', { name: 'Add to my calendar' }))
    const items = within(await screen.findByRole('menu', { name: 'Add to my calendar' })).getAllByRole('menuitem')
    expect(visitLoads(requests)).toBe(2)
    expect(new URL(items[0]!.getAttribute('href')!).searchParams.get('dates')).toBe('20261007T113000Z/20261007T121500Z')
    expect(new URL(items[1]!.getAttribute('href')!).searchParams.get('startdt')).toBe('2026-10-07T11:30:00Z')
    await user.click(items[2]!)
    const ics = await download.blobs[0]!.text()
    expect(ics).toContain('\r\nSEQUENCE:1\r\nDTSTAMP:20261005T070000Z\r\nDTSTART:20261007T113000Z\r\nDTEND:20261007T121500Z\r\n')
    expect(download.links[0]!.download).toBe('visit-2026-10-07.ics')
    // The page shows the visit the menu was written from.
    expect(details).toHaveTextContent('Wed, 7 Oct 2026, 14:30–\u206015:15')
  })

  it('shows the kit’s loading state while it fetches the visit again', async () => {
    const now = deferred<Response>()
    const { user } = open({ now: () => now.promise })
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Add to my calendar' })

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    expect(trigger.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()

    now.resolve(jsonResponse(makeVisit()))
    expect(await screen.findByRole('menu', { name: 'Add to my calendar' })).toBeInTheDocument()
    expect(trigger).not.toHaveAttribute('aria-busy')
    expect(trigger.querySelector('.animate-spin')).toBeNull()
  })

  it('opens nothing for a visit cancelled elsewhere since: the page shows the cancellation, and the focus goes on from its heading', async () => {
    const download = captureDownload()
    const cancelled = makeVisit({ status: 'CANCELLED', cancelled_at: '2026-10-05T06:05:00Z', calendar_sequence: 1 })
    const { user } = open({ now: () => jsonResponse(cancelled) })
    const heading = await loaded()

    screen.getByRole('button', { name: 'Add to my calendar' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to my calendar' })).toBeNull())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(heading).toHaveFocus()
    expect(await screen.findByText('This visit was cancelled')).toBeInTheDocument()
    expect(download.blobs).toEqual([])
  })

  it('opens nothing for a visit that ended or began since, or that is no longer this host’s', async () => {
    const changes: Visit[] = [
      makeVisit({ scheduled_start: '2026-10-05T05:00:00Z', scheduled_end: '2026-10-05T06:00:00Z' }),
      makeVisit({ status: 'CHECKED_IN', check_in_at: '2026-10-05T06:05:00Z', check_in_method: 'QR' }),
      makeVisit({ host: { id: 'another-host', full_name: 'Omar Khalil', phone: null } }),
    ]
    for (const changed of changes) {
      const view = open({ now: () => jsonResponse(changed) })
      await loaded()
      await view.user.click(screen.getByRole('button', { name: 'Add to my calendar' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to my calendar' })).toBeNull())
      expect(screen.queryByRole('menu')).toBeNull()
      view.unmount()
    }
  })

  it('shows the kit’s error toast when the visit cannot be fetched again, and opens nothing', async () => {
    const { user } = open({ now: () => errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') })
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Add to my calendar' })

    await user.click(trigger)
    const toast = await findAlert('The visit could not be loaded')
    expect(toast).toHaveTextContent('Something went wrong. Please try again.')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).not.toHaveAttribute('aria-busy')
    // The page keeps the visit it shows.
    expect(screen.getByRole('heading', { level: 1, name: 'Élodie Martin' })).toBeInTheDocument()
  })

  it('closes its open menu when the visit changes under it, the focus back on its trigger; opened again, it says the new time', async () => {
    let current = makeVisit()
    const { user, queryClient } = open({ now: () => jsonResponse(current) })
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Add to my calendar' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await googleDates()).toBe('20261006T060000Z/20261006T070000Z')
    const first = screen.getAllByRole('menuitem')[0]!
    await waitFor(() => expect(first).toHaveFocus())

    // A refetch that finds the visit as it was keeps the menu open.
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(VISIT_ID) }))
    expect(screen.getByRole('menu', { name: 'Add to my calendar' })).toBeInTheDocument()

    // A new time reaches the page (a poll, a refetch): the menu, still saying the old one, closes.
    current = MOVED
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(VISIT_ID) }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger).toHaveFocus()
    const details = screen.getByRole('heading', { name: 'Visit details' }).closest('section') as HTMLElement
    expect(details).toHaveTextContent('Wed, 7 Oct 2026, 14:30–\u206015:15')
    await user.keyboard('{Enter}')
    expect(await googleDates()).toBe('20261007T113000Z/20261007T121500Z')
  })

  it('asks again when a request of the page was already on its way: the menu says the visit as it is now', async () => {
    const held = deferred<Response>()
    let answers = 0
    const { user, queryClient, requests } = open({ now: () => ((answers += 1) === 1 ? held.promise : jsonResponse(MOVED)) })
    await loaded()
    // A refetch of the page left before the change (a poll, the window's focus) and is still on its way.
    void queryClient.invalidateQueries({ queryKey: queryKeys.visits.detail(VISIT_ID) })
    await waitFor(() => expect(visitLoads(requests)).toBe(2))

    await user.click(screen.getByRole('button', { name: 'Add to my calendar' }))
    expect(await googleDates()).toBe('20261007T113000Z/20261007T121500Z')
    expect(visitLoads(requests)).toBe(3)
    held.resolve(jsonResponse(makeVisit()))
  })

  it('fails at once offline, with the error toast, and never opens later on its own', async () => {
    let offline = false
    const { user } = open({ now: () => (offline ? Promise.reject(new TypeError('Failed to fetch')) : jsonResponse(makeVisit())) })
    await loaded()
    const trigger = screen.getByRole('button', { name: 'Add to my calendar' })
    offline = true
    act(() => onlineManager.setOnline(false))
    try {
      await user.click(trigger)
      expect(await findAlert('The visit could not be loaded')).toBeInTheDocument()
      expect(trigger).not.toHaveAttribute('aria-busy')
      // Back online: nothing opens by itself.
      offline = false
      act(() => onlineManager.setOnline(true))
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      onlineManager.setOnline(true)
    }
  })

  it.each([
    [404, 'NOT_FOUND', 'The requested item was not found.', 'Visit not found'],
    [403, 'FORBIDDEN', 'You do not have permission to perform this action.', 'No access to this visit'],
  ] as const)('a %i on the menu’s request: the page turns to it, and the focus goes on from its heading', async (status, code, message, title) => {
    const { user } = open({ now: () => errorResponse(status, code, message) })
    await loaded()
    screen.getByRole('button', { name: 'Add to my calendar' }).focus()
    await user.keyboard('{Enter}')

    const heading = await screen.findByRole('heading', { level: 1, name: title })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Add to my calendar' })).toBeNull()
  })

  it('writes nothing while the page renders: a time the browser cannot read fails the menu, not the page', async () => {
    const broken = makeVisit({ updated_at: 'not a time' })
    const { user } = open({ visit: broken, now: () => jsonResponse(broken) })
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Add to my calendar' }))
    expect(await findAlert('The visit could not be loaded')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Visit details' })).toBeInTheDocument()
  })
})
