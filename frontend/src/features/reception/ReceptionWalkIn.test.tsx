import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorResponse, jsonResponse, type RecordedRequest, type RouteHandler } from '../../test/api'
import { FINANCE, LEGAL, makeHost, makeVisitor, page, VISITOR_ID } from '../../test/fixtures'
import type { WalkInCreate } from '../../types/api'
import { insideVisit, makeSettings, RECEPTION_NOW } from './testing/receptionFixtures'
import { renderReception, requestsTo, stubCoarsePointer } from './testing/renderReception'

const omar = makeHost()
const walkIn = insideVisit({ is_walk_in: true, check_in_method: 'WALK_IN', walk_in_reason: 'NO_INVITATION' })

function setup(routes: Record<string, RouteHandler> = {}) {
  return renderReception({
    initialEntry: '/reception?tab=walk-in',
    camera: { permission: 'prompt' },
    routes: {
      'GET /departments': () => jsonResponse([FINANCE, LEGAL]),
      'GET /users/hosts': () => jsonResponse([omar]),
      'GET /visitors': () => jsonResponse(page([makeVisitor()])),
      'POST /reception/walk-ins': () => jsonResponse(walkIn, 201),
      ...routes,
    },
  })
}

/** An option of the open typeahead popup (scoped: the form also holds a 96-option time list). */
async function popupOption(name: RegExp) {
  return within(await screen.findByRole('listbox')).findByRole('option', { name })
}

function walkInBodies(requests: RecordedRequest[]): WalkInCreate[] {
  return requestsTo(requests, 'POST', '/reception/walk-ins').map((request) => request.body as WalkInCreate)
}

type User = ReturnType<typeof setup>['user']

/** A returning visitor's walk-in: visitor, host, purpose and reason. */
async function fillReturningVisitor(user: User) {
  await user.type(await screen.findByRole('combobox', { name: /^Returning visitor/ }), 'elo')
  await user.click(await popupOption(/Élodie Martin/))
  await user.click(screen.getByRole('combobox', { name: 'Host' }))
  await user.click(await popupOption(/Omar Khalil/))
  fireEvent.change(screen.getByRole('textbox', { name: /^Purpose/ }), { target: { value: 'Contract signing' } })
  await user.click(screen.getByRole('radio', { name: 'No invitation' }))
}

beforeEach(() => {
  vi.useFakeTimers({ now: RECEPTION_NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Walk-in tab', () => {
  it('registers a returning visitor with four inputs and returns to Scan', async () => {
    const { user, requests, router } = setup()

    // 1. Visitor (lookup first)
    await user.type(await screen.findByRole('combobox', { name: /^Returning visitor/ }), 'elo')
    await user.click(await popupOption(/Élodie Martin/))
    expect(screen.queryByRole('textbox', { name: 'Full name' })).toBeNull()
    // 2. Host, shown with their phone
    await user.click(screen.getByRole('combobox', { name: 'Host' }))
    await user.click(await popupOption(/Omar Khalil/))
    expect(screen.getByRole('link', { name: 'Call Omar Khalil: +962 79 000 0077' })).toBeInTheDocument()
    // The department follows the host; the stay defaults to one hour (Amman time), with no date to enter.
    expect(screen.getByRole('combobox', { name: /^Department/ })).toHaveValue(LEGAL.id)
    const stay = screen.getByRole('radiogroup', { name: 'Expected to stay' })
    expect(within(stay).getByRole('radio', { name: '1 hour' })).toBeChecked()
    expect(stay).toHaveAccessibleDescription('Leaves about 10:10 if checked in now.')
    expect(screen.queryByLabelText('Expected end date')).toBeNull()
    // 3. Purpose, 4. Reason
    fireEvent.change(screen.getByRole('textbox', { name: /^Purpose/ }), { target: { value: 'Contract signing' } })
    await user.click(screen.getByRole('radio', { name: 'No invitation' }))

    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))

    await waitFor(() => expect(walkInBodies(requests)).toHaveLength(1))
    expect(walkInBodies(requests)[0]).toEqual({
      visitor_id: makeVisitor().id,
      host_id: omar.id,
      purpose: 'Contract signing',
      expected_end: '2026-10-06T07:10:00.000Z',
      reason: 'NO_INVITATION',
    })
    expect(await screen.findByText('Élodie Martin checked in')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'true'))
    expect(router.state.location.search).toBe('')
    // Lists and counts are refreshed.
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today').length).toBeGreaterThan(1))
  })

  it('registers a new visitor; "Other" needs a note, and server field messages go to their fields', async () => {
    let attempts = 0
    const { user, requests } = setup({
      'POST /reception/walk-ins': () => {
        attempts += 1
        return attempts === 1
          ? errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
              fields: { expected_end: 'The visit must end within 24 hours.' },
            })
          : jsonResponse(walkIn, 201)
      },
    })
    await screen.findByRole('combobox', { name: /^Returning visitor/ })

    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Sami Odeh' } })
    // The optional contact details wait behind one button; opening it moves on to the first field.
    expect(screen.queryByRole('textbox', { name: /^Phone/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add contact details (optional)' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Company/ })).toHaveFocus())
    fireEvent.change(screen.getByRole('textbox', { name: /^Phone/ }), { target: { value: '079 555 0101' } })
    await user.click(screen.getByRole('combobox', { name: 'Host' }))
    await user.click(await popupOption(/Omar Khalil/))
    fireEvent.change(screen.getByRole('textbox', { name: /^Purpose/ }), { target: { value: 'Courier' } })
    await user.click(screen.getByRole('radio', { name: 'Other' }))

    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))
    const note = await screen.findByRole('textbox', { name: 'Reason details' })
    expect(note).toHaveAccessibleDescription(/Describe the reason for this walk-in\./)
    await waitFor(() => expect(note).toHaveFocus())
    expect(walkInBodies(requests)).toHaveLength(0)

    fireEvent.change(note, { target: { value: 'Collecting signed contracts' } })
    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))
    // A server message about the end goes to the stay the form shows.
    await waitFor(() =>
      expect(screen.getByRole('radiogroup', { name: 'Expected to stay' })).toHaveAccessibleDescription(/The visit must end within 24 hours\./),
    )

    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))
    await waitFor(() => expect(walkInBodies(requests)).toHaveLength(2))
    expect(walkInBodies(requests)[1]).toEqual({
      visitor: { full_name: 'Sami Odeh', phone: '079 555 0101' },
      host_id: omar.id,
      purpose: 'Courier',
      expected_end: '2026-10-06T07:10:00.000Z',
      reason: 'OTHER',
      reason_note: 'Collecting signed contracts',
    })
  })

  it('refuses an address registered under another name on the Email field and offers that registered visitor (B57-70)', async () => {
    const message = 'This email address belongs to the registered visitor “Élodie Martin”. Select that visitor, or correct the email.'
    let attempts = 0
    const { user, requests } = setup({
      'POST /reception/walk-ins': () => {
        attempts += 1
        return attempts === 1 ? errorResponse(409, 'VISITOR_EXISTS', message, { visitor_id: VISITOR_ID }) : jsonResponse(walkIn, 201)
      },
      [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()),
    })
    await screen.findByRole('combobox', { name: /^Returning visitor/ })
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'John Impostor' } })
    await user.click(screen.getByRole('button', { name: 'Add contact details (optional)' }))
    fireEvent.change(screen.getByRole('textbox', { name: /^Email/ }), { target: { value: 'elodie@orbit.example' } })
    await user.click(screen.getByRole('combobox', { name: 'Host' }))
    await user.click(await popupOption(/Omar Khalil/))
    fireEvent.change(screen.getByRole('textbox', { name: /^Purpose/ }), { target: { value: 'Meeting' } })
    await user.click(screen.getByRole('radio', { name: 'No invitation' }))

    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Email/ })).toHaveAccessibleDescription(/Select that visitor, or correct the email\./))
    // Shown once, on the field, not again in the form alert.
    expect(screen.getAllByText(message)).toHaveLength(1)

    await user.click(await screen.findByRole('button', { name: 'Select the registered visitor' }))
    expect(screen.queryByRole('textbox', { name: 'Full name' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Enter a new visitor instead' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))

    await waitFor(() => expect(walkInBodies(requests)).toHaveLength(2))
    expect(walkInBodies(requests)[1]).toMatchObject({ visitor_id: makeVisitor().id, host_id: omar.id, purpose: 'Meeting', reason: 'NO_INVITATION' })
    expect(walkInBodies(requests)[1]).not.toHaveProperty('visitor')
  })

  it('on a touch screen puts focus on "Enter or paste pass" after the walk-in, not on the page', async () => {
    stubCoarsePointer()
    const { user } = setup()
    await fillReturningVisitor(user)

    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'true'))
    // The focused submit button went with the Walk-in tab; no on-screen keyboard opens either.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enter or paste pass' })).toHaveFocus())
  })

  it('reads and tabs its footer in one order: Clear form, then the primary Check in walk-in', async () => {
    setup()
    const submit = await screen.findByRole('button', { name: 'Check in walk-in' })
    const footer = submit.parentElement as HTMLElement
    expect(within(footer).getAllByRole('button').map((button) => button.textContent)).toEqual(['Clear form', 'Check in walk-in'])
    expect(footer.className).not.toMatch(/reverse/)
    // "Clear form" is quiet and at the far end from the primary; the bar stays in reach while the form scrolls.
    expect(within(footer).getByRole('button', { name: 'Clear form' }).className).not.toContain('border')
    expect(footer.className).toContain('justify-between')
    expect(footer.className).toMatch(/(^|\s)sticky(\s|$)/)
    expect(footer.className).toContain('bottom-0')
  })

  it('asks for a date and time only for "Other…", starting at the end picked so far', async () => {
    const { user, requests } = setup()
    await fillReturningVisitor(user)
    await user.click(screen.getByRole('radio', { name: '2 hours' }))
    expect(screen.getByRole('radiogroup', { name: 'Expected to stay' })).toHaveAccessibleDescription('Leaves about 11:10 if checked in now.')

    await user.click(screen.getByRole('radio', { name: 'Other…' }))
    expect(screen.getByLabelText('Expected end date')).toHaveValue('2026-10-06')
    expect(screen.getByRole('combobox', { name: 'Expected end time' })).toHaveValue('11:10')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Expected end time' }), '12:30')

    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))
    await waitFor(() => expect(walkInBodies(requests)).toHaveLength(1))
    expect(walkInBodies(requests)[0]?.expected_end).toBe('2026-10-06T09:30:00.000Z')
  })

  it('lays the reasons out as an even grid of equal segments (two per row on phones, three from sm)', async () => {
    setup()
    const reasons = await screen.findByRole('radiogroup', { name: 'Reason for the walk-in' })
    const grid = within(reasons).getByRole('radio', { name: 'No invitation' }).closest('label')?.parentElement as HTMLElement
    expect(grid.className).toContain('grid-cols-2')
    expect(grid.className).toContain('sm:grid-cols-3')
  })

  it('keeps what was entered when reception switches to another tab and back', async () => {
    const { user } = setup()
    const purpose = await screen.findByRole('textbox', { name: /^Purpose/ })
    fireEvent.change(purpose, { target: { value: 'Delivery for legal' } })

    await user.click(screen.getByRole('tab', { name: 'Scan' }))
    await user.click(screen.getByRole('tab', { name: 'Walk-in' }))
    expect(await screen.findByRole('textbox', { name: /^Purpose/ })).toHaveValue('Delivery for legal')
  })

  it('shows the server’s message when walk-ins are refused, and refreshes the lists it proves stale', async () => {
    const { user, requests } = setup({
      'POST /reception/walk-ins': () => errorResponse(409, 'VISITOR_ALREADY_INSIDE', 'This visitor is already checked in on another visit.'),
    })
    await fillReturningVisitor(user)
    const todayLoads = requestsTo(requests, 'GET', '/reception/today').length
    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))

    expect(await screen.findByText('This visitor is already checked in on another visit.')).toBeInTheDocument()
    // The visitor is inside on another visit: the counts and the Inside list are out of date.
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today').length).toBeGreaterThan(todayLoads))
  })

  it('shows that walk-ins are turned off when the server refuses one for that reason (WALK_INS_DISABLED)', async () => {
    let allowed = true
    const { user } = setup({
      'GET /company/settings': () => jsonResponse(makeSettings({ allow_walk_ins: allowed })),
      'POST /reception/walk-ins': () => {
        allowed = false
        return errorResponse(409, 'WALK_INS_DISABLED', 'Walk-in registration is turned off for this company.')
      },
    })
    await fillReturningVisitor(user)
    await user.click(screen.getByRole('button', { name: 'Check in walk-in' }))

    // The cached settings still allowed walk-ins; they are reloaded, so the form gives way.
    expect(await screen.findByText('Walk-in registration is turned off')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check in walk-in' })).toBeNull()
  })

  it('explains that walk-ins are turned off for the company', async () => {
    renderReception({
      initialEntry: '/reception?tab=walk-in',
      camera: { permission: 'prompt' },
      routes: { 'GET /company/settings': () => jsonResponse(makeSettings({ allow_walk_ins: false })), 'GET /departments': () => jsonResponse([]) },
    })
    expect(await screen.findByText('Walk-in registration is turned off')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check in walk-in' })).toBeNull()
  })
})
