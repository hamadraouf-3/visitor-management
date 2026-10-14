import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../test/api'
import { FINANCE, LEGAL, makeHost, makeSearchItem, makeVisit, makeVisitor, page, VISIT_ID, VISITOR_ID } from '../test/fixtures'
import { findAlert, renderRoutes } from '../test/render'
import type { Me, Visit, VisitCreate, VisitCreateResult } from '../types/api'


// 09:10 on Mon 5 Oct 2026 in Amman (the company timezone); the test browser runs in UTC.
const NOW = new Date('2026-10-05T06:10:00Z')
const PASS_URL = 'https://visitors.example.com/pass#Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'
const me = makeMe(['EMPLOYEE'])
/** An administrator may invite for any host (§7.5, phase 10 shared contract A). */
const admin = makeMe(['SYSTEM_ADMIN'])
const omar = makeHost()

function pendingVisit(overrides: Partial<Visit['invitation']> = {}): Visit {
  return makeVisit({ invitation: { status: 'PENDING', attempts: 0, sent_at: null, last_attempt_at: null, ...overrides } })
}

function created(visit: Visit = pendingVisit(), reused = false): VisitCreateResult {
  return { visit, pass_url: PASS_URL, visitor_match: { reused } }
}

function setup({
  create = () => jsonResponse(created(), 201),
  extra = {},
  initialEntry = '/visits/new',
  as = me,
}: { create?: RouteHandler; extra?: Record<string, RouteHandler>; initialEntry?: string; as?: Me } = {}) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(as),
    'GET /departments': () => jsonResponse([FINANCE, LEGAL]),
    'GET /users/hosts': () =>
      jsonResponse([{ id: as.user.id, full_name: as.user.full_name, phone: null, department: as.user.department }, omar]),
    'POST /visits': create,
    [`GET /visits/${VISIT_ID}`]: () => jsonResponse(makeVisit()),
    ...extra,
  })
  const view = renderRoutes(routes, { initialEntries: [initialEntry] })
  return { ...api, ...view }
}

/** The success view: its page title is the outcome, its card names the visitor. */
async function successShown(visitorName = 'Élodie Martin') {
  const title = await screen.findByRole('heading', { level: 1, name: 'Visit scheduled' })
  expect(screen.getByRole('heading', { level: 2, name: visitorName })).toBeInTheDocument()
  return title
}

/** The success view's status line (a polite live region). */
async function statusLine(text: string) {
  return waitFor(() => {
    const match = screen.getAllByRole('status').find((element) => element.textContent === text)
    if (!match) throw new Error(`No status "${text}"`)
    return match
  })
}

const field = {
  name: () => screen.getByRole('textbox', { name: 'Full name' }),
  email: () => screen.getByRole('textbox', { name: /^Email/ }),
  purpose: () => screen.getByRole('textbox', { name: /^Purpose/ }),
  startDate: () => screen.getByLabelText('Starts date'),
  startTime: () => screen.getByRole('combobox', { name: 'Starts time' }),
  endDate: () => screen.getByLabelText('Ends date'),
  endTime: () => screen.getByRole('combobox', { name: 'Ends time' }),
  /** An administrator's host picker. */
  host: () => screen.getByRole('combobox', { name: 'Host' }),
  /** Everyone else's host: themselves, read-only. */
  ownHost: () => screen.getByRole('textbox', { name: 'Host' }),
  department: () => screen.getByRole('combobox', { name: /^Department/ }),
  emailDelivery: () => screen.getByRole('radio', { name: 'Email the invitation' }),
  shareDelivery: () => screen.getByRole('radio', { name: 'I’ll share the pass myself' }),
}

/** Sets a date input or picks a time (the native controls' change events). */
function change(control: HTMLElement, value: string) {
  fireEvent.change(control, { target: { value } })
}

/**
 * An option of the open typeahead popup. Scoped to its listbox: the form's two time lists
 * hold 192 options, and naming each of them on every retry makes an unscoped query slow.
 */
async function popupOption(name: RegExp) {
  return within(await screen.findByRole('listbox')).findByRole('option', { name })
}

type User = ReturnType<typeof setup>['user']

/** Plain text fields, filled with one change each (typing them key by key adds nothing these tests check). */
function fillNewVisitor({ name = 'Élodie Martin', email = 'elodie@orbit.example' }: { name?: string; email?: string } = {}) {
  change(field.name(), name)
  if (email) change(field.email(), email)
  change(field.purpose(), 'Quarterly review')
}

function createBody(requests: RecordedRequest[]): VisitCreate {
  const request = requests.find((candidate) => candidate.method === 'POST' && candidate.path === '/visits')
  if (!request) throw new Error('No POST /visits')
  return request.body as VisitCreate
}

function visitPolls(requests: RecordedRequest[]): number {
  return requests.filter((request) => request.method === 'GET' && request.path === `/visits/${VISIT_ID}`).length
}

async function openForm() {
  return screen.findByRole('heading', { level: 1, name: 'Invite visitor' })
}

async function submitInvite(user: User, visitor: { name?: string; email?: string } = {}) {
  await openForm()
  fillNewVisitor(visitor)
  await user.click(screen.getByRole('button', { name: 'Send invitation' }))
}

describe('Invite visitor: form', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('starts with host = me, my department, the next half hour, one hour, and the invitation on', async () => {
    setup()
    await openForm()

    expect(field.ownHost()).toHaveValue('Lina Haddad')
    await waitFor(() => expect(within(field.department()).getByRole('option', { name: 'Legal' })).toBeInTheDocument())
    expect(field.department()).toHaveValue(FINANCE.id)
    // Without a department_id the server applies the host's department (B24-23), so "No
    // department" would be a promise the request cannot keep while the host has one.
    expect(within(field.department()).queryByRole('option', { name: 'No department' })).toBeNull()
    // A date and a 24-hour time each, in company time.
    expect(field.startDate()).toHaveValue('2026-10-05')
    expect(field.startTime()).toHaveValue('09:30')
    expect(field.endDate()).toHaveValue('2026-10-05')
    expect(field.endTime()).toHaveValue('10:30')
    // No time-zone or 24-hour note (decision 3); the range is read back with its length.
    for (const control of [field.startDate(), field.startTime(), field.endDate(), field.endTime()]) {
      expect(control).not.toHaveAccessibleDescription()
    }
    expect(screen.getByText('Mon, 5 Oct 2026 · 09:30–\u206010:30 (1h)')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/UTC|Times in/)
    expect(field.emailDelivery()).toBeChecked()
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeInTheDocument()
    // The purpose's only hint is its length (a constraint), not who sees it.
    expect(field.purpose()).toHaveAccessibleDescription('0 of 500 characters')
    // No page or card description, no hint that restates a label (decision 3).
    const title = screen.getByRole('heading', { level: 1, name: 'Invite visitor' })
    expect((title.closest('header') as HTMLElement).querySelector('p')).toBeNull()
    expect(field.ownHost()).not.toHaveAccessibleDescription()
    expect(screen.getByRole('combobox', { name: /^Returning visitor/ })).not.toHaveAccessibleDescription()
    expect(screen.getByRole('combobox', { name: /^Returning visitor/ })).toHaveAttribute('placeholder', 'Name, email, phone or company')
  })

  it('asks how the visitor gets the pass right under the email, and marks only optional fields', async () => {
    setup()
    await openForm()

    const delivery = screen.getByRole('radiogroup', { name: 'How will the visitor get their pass?' })
    // In the Visitor card, directly after the email field: it decides whether the email is needed.
    const visitorCard = screen.getByRole('heading', { name: 'Visitor' }).closest('section') as HTMLElement
    expect(visitorCard).toContainElement(delivery)
    const controls = within(visitorCard).getAllByRole('textbox')
    expect(controls.at(-1)).toBe(field.email())
    expect(field.email().compareDocumentPosition(delivery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()

    // Required fields carry no asterisk; only optional ones are marked.
    expect(document.body).not.toHaveTextContent('*')
    expect(field.name()).toHaveAttribute('aria-required', 'true')
    expect(field.email()).toHaveAccessibleName('Email')
    // Required while the invitation is emailed; no hint restating why (its error says it when it is missing).
    expect(field.email()).toHaveAttribute('aria-required', 'true')
    expect(field.email()).not.toHaveAccessibleDescription()
    // Each way to get the pass is named by what it does, without a description.
    expect(field.emailDelivery()).not.toHaveAccessibleDescription()
    expect(field.shareDelivery()).not.toHaveAccessibleDescription()
    expect(screen.getByRole('textbox', { name: 'Phone (optional)' })).toBeInTheDocument()
  })

  it('invites an employee’s visitors in their own name only: the host is read-only and the request carries their id', async () => {
    const { user, requests } = setup()
    await openForm()

    // Their own name, as data: no picker to choose someone else (§7.5, the user's request of 2026-10-08).
    expect(field.ownHost()).toHaveValue(me.user.full_name)
    expect(field.ownHost()).toHaveAttribute('readonly')
    expect(field.ownHost()).not.toHaveAttribute('aria-required')
    expect(screen.queryByRole('combobox', { name: 'Host' })).toBeNull()
    // The department still defaults to theirs.
    await waitFor(() => expect(within(field.department()).getByRole('option', { name: 'Legal' })).toBeInTheDocument())
    expect(field.department()).toHaveValue(FINANCE.id)

    fillNewVisitor()
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    expect(createBody(requests)).toMatchObject({ host_id: me.user.id })
    // No department_id: their own is the server's default (B24-23).
    expect(createBody(requests)).not.toHaveProperty('department_id')
    // Nobody else was looked up.
    expect(requests.some((request) => request.path === '/users/hosts')).toBe(false)
  })

  it('shows the server’s refusal of another host on the read-only Host field (host_must_be_self)', async () => {
    const message = 'You can only invite visitors you host yourself.'
    const { user } = setup({
      create: () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { host_id: message },
          field_codes: { host_id: { code: 'host_must_be_self', params: {} } },
        }),
    })
    await openForm()
    fillNewVisitor()

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => expect(field.ownHost()).toHaveAttribute('aria-invalid', 'true'))
    expect(field.ownHost()).toHaveAccessibleDescription(message)
    expect(field.ownHost()).toHaveFocus()
    expect(screen.getAllByText(message)).toHaveLength(1)
  })

  it('lets an administrator invite for any host, themselves by default, and sends the chosen host', async () => {
    const { user, requests } = setup({ as: admin })
    await openForm()

    expect(field.host()).toHaveValue(admin.user.full_name)
    expect(field.host()).toHaveAttribute('aria-required', 'true')
    expect(screen.queryByRole('textbox', { name: 'Host' })).toBeNull()

    await user.clear(field.host())
    await user.type(field.host(), 'Omar')
    await user.click(await popupOption(/Omar Khalil/))
    fillNewVisitor()
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    expect(createBody(requests)).toMatchObject({ host_id: omar.id })
  })

  it('does not default to a host department that is no longer active, and leaves the default to the server', async () => {
    // Omar's department (Legal) was deactivated: it is not in the active list.
    const { user, requests } = setup({ as: admin, extra: { 'GET /departments': () => jsonResponse([FINANCE]) } })
    await openForm()

    await user.clear(field.host())
    await user.type(field.host(), 'Omar')
    await user.click(await popupOption(/Omar Khalil/))

    await waitFor(() => expect(field.department()).toHaveValue(''))
    expect(within(field.department()).getByRole('option', { name: 'No department' })).toBeInTheDocument()
    expect(within(field.department()).queryByRole('option', { name: 'Legal' })).toBeNull()

    fillNewVisitor()
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    // No department_id: the server applies none for an inactive host department (B24-23)
    // instead of refusing the visit with "This department is inactive."
    expect(createBody(requests)).not.toHaveProperty('department_id')
    expect(createBody(requests)).toMatchObject({ host_id: omar.id })
  })

  it('sends a department other than the host’s', async () => {
    const { user, requests } = setup()
    await openForm()
    await waitFor(() => expect(within(field.department()).getByRole('option', { name: 'Legal' })).toBeInTheDocument())

    await user.selectOptions(field.department(), 'Legal')
    fillNewVisitor()
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    expect(createBody(requests)).toMatchObject({ department_id: LEGAL.id })
  })

  it('lists every host when the host field is clicked, not only the current one', async () => {
    const { user, requests } = setup({ as: admin })
    await openForm()

    await user.click(field.host())

    expect(await popupOption(/Omar Khalil/)).toBeInTheDocument()
    expect(await popupOption(/Lina Haddad/)).toHaveAttribute('aria-selected', 'true')
    const search = requests.find((request) => request.path === '/users/hosts')
    expect(search?.url.searchParams.has('q')).toBe(false)
  })

  it('takes the department of a newly chosen host', async () => {
    const { user } = setup({ as: admin })
    await openForm()

    await user.clear(field.host())
    await user.type(field.host(), 'Omar')
    await user.click(await popupOption(/Omar Khalil/))

    expect(field.host()).toHaveValue('Omar Khalil')
    expect(field.department()).toHaveValue(LEGAL.id)
  })

  it('keeps the visit length when the start changes', async () => {
    setup()
    await openForm()

    change(field.endTime(), '11:00') // 09:30–\u206011:00: 90 minutes
    change(field.startDate(), '2026-10-06')
    change(field.startTime(), '14:00')

    expect(field.endDate()).toHaveValue('2026-10-06')
    expect(field.endTime()).toHaveValue('15:30')
    expect(screen.getByText('Tue, 6 Oct 2026 · 14:00–\u206015:30 (1h 30m)')).toBeInTheDocument()
  })

  it('sends the company wall time as timezone-aware UTC when the browser is in another timezone', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const { user, requests } = setup()
    await openForm()
    // The defaults are company time too, not Los Angeles time.
    expect(field.startDate()).toHaveValue('2026-10-05')
    expect(field.startTime()).toHaveValue('09:30')

    fillNewVisitor()
    change(field.startDate(), '2026-10-06')
    change(field.startTime(), '09:00')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    expect(createBody(requests)).toEqual({
      visitor: { full_name: 'Élodie Martin', email: 'elodie@orbit.example' },
      host_id: me.user.id,
      purpose: 'Quarterly review',
      scheduled_start: '2026-10-06T06:00:00.000Z',
      scheduled_end: '2026-10-06T07:00:00.000Z',
      send_invitation: true,
    })
  })

  it('requires the email only when the invitation is emailed', async () => {
    // What the server answers for a visit created without an invitation.
    const notInvited = makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } })
    const { user, requests } = setup({
      create: () => jsonResponse(created(notInvited), 201),
      extra: { [`GET /visits/${VISIT_ID}`]: () => jsonResponse(notInvited) },
    })
    await openForm()
    fillNewVisitor({ email: '' })

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(field.email()).toHaveAttribute('aria-invalid', 'true')
    // The error names the way out for a host who does not have the address.
    expect(field.email()).toHaveAccessibleDescription(
      'Enter the visitor’s email address to email the invitation, or choose “I’ll share the pass myself”.',
    )
    expect(field.email()).toHaveFocus()
    expect(requests.some((request) => request.method === 'POST')).toBe(false)

    await user.click(field.shareDelivery())
    expect(field.email()).toHaveAccessibleName('Email (optional)')
    expect(field.email()).not.toHaveAttribute('aria-required')
    await user.click(screen.getByRole('button', { name: 'Create visit' }))

    expect(await successShown()).toBeInTheDocument()
    expect(await statusLine('No invitation email was sent for this visit.')).toBeInTheDocument()
    // The pass is then the visitor's only way in: sharing it is the main action, with one short line and no alert.
    expect(screen.getByRole('textbox', { name: 'Pass link' })).toHaveAccessibleDescription('Shown only once.')
    expect(screen.getByRole('button', { name: 'Copy link' }).className).toContain('bg-accent')
    expect(createBody(requests)).toMatchObject({ visitor: { full_name: 'Élodie Martin' }, send_invitation: false })
    expect(createBody(requests).visitor).not.toHaveProperty('email')
  })

  it('checks the schedule before sending', async () => {
    const { user, requests } = setup()
    await openForm()
    fillNewVisitor()

    change(field.endTime(), '09:00')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(field.endDate()).toHaveAccessibleDescription(/The end must be after the start\./)
    expect(field.endTime()).toHaveAccessibleDescription(/The end must be after the start\./)
    expect(field.endTime()).toHaveAttribute('aria-invalid', 'true')
    // Focus goes to the group's first control.
    expect(field.endDate()).toHaveFocus()
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
  })

  it('reaches Cancel before the submit button, in the order they are shown', async () => {
    setup()
    await openForm()
    const submit = screen.getByRole('button', { name: 'Send invitation' })
    const footer = submit.parentElement as HTMLElement
    expect([...footer.children].map((element) => element.textContent)).toEqual(['Cancel', 'Send invitation'])
    expect(footer.className).not.toMatch(/reverse/)
  })

  it('shows the server’s field errors on their fields and focuses the first', async () => {
    const { user } = setup({
      create: () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: {
            'visitor.email': 'Enter a valid email address.',
            scheduled_start: 'The start cannot be in the past.',
            body: 'Provide either an existing visitor or new visitor details, not both.',
          },
        }),
    })
    await openForm()
    fillNewVisitor()

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => expect(field.email()).toHaveAttribute('aria-invalid', 'true'))
    expect(field.email()).toHaveAccessibleDescription(/Enter a valid email address\./)
    expect(field.startDate()).toHaveAccessibleDescription(/The start cannot be in the past\./)
    expect(field.email()).toHaveFocus()
    // A message for no field of the form is still shown, in the form alert.
    expect(await findAlert('Provide either an existing visitor or new visitor details, not both.')).toBeInTheDocument()
  })

  it('shows a refused relink of an address registered under another name on the Email field (B57-01)', async () => {
    const message =
      "A visitor with this email address is already registered under a different name. Check the visitor's name, or ask reception to check the visitor's details."
    const { user } = setup({ create: () => errorResponse(409, 'VISITOR_EXISTS', message) })
    await openForm()
    fillNewVisitor({ name: 'Karim Fail' })

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => expect(field.email()).toHaveAttribute('aria-invalid', 'true'))
    expect(field.email()).toHaveAccessibleDescription(new RegExp(message.replace(/[.?']/g, '.')))
    expect(field.email()).toHaveFocus()
    // Shown once, next to the field, not again in the form alert.
    expect(screen.getAllByText(message)).toHaveLength(1)
  })

  it('offers the registered visitor an address belongs to, shown before the visit is sent for them (B57-70)', async () => {
    const message = 'This email address belongs to the registered visitor “Élodie Martin”. Select that visitor, or correct the email.'
    let attempts = 0
    const { user, requests } = setup({
      create: () => {
        attempts += 1
        return attempts === 1 ? errorResponse(409, 'VISITOR_EXISTS', message, { visitor_id: VISITOR_ID }) : jsonResponse(created(), 201)
      },
      extra: { [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()) },
    })
    await openForm()
    fillNewVisitor({ name: 'Elodie Martinez' })

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))
    await waitFor(() => expect(field.email()).toHaveAccessibleDescription(/Select that visitor, or correct the email\./))
    await user.click(await screen.findByRole('button', { name: 'Select the registered visitor' }))

    // The registered record replaces the typed details, so the name can be compared before sending.
    expect(screen.queryByRole('textbox', { name: 'Full name' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Enter a new visitor instead' })).toBeInTheDocument()
    expect(screen.queryByText(message)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    const bodies = requests.filter((request) => request.method === 'POST' && request.path === '/visits').map((request) => request.body as VisitCreate)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toMatchObject({ visitor_id: VISITOR_ID })
    expect(bodies[1]).not.toHaveProperty('visitor')
  })

  it('shows other server errors, such as the invitation limit, as the server words them', async () => {
    const { user } = setup({ create: () => errorResponse(429, 'INVITATION_LIMIT', 'Invitation limit reached. Please try again later.') })
    await openForm()
    fillNewVisitor()

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(await findAlert('Invitation limit reached. Please try again later.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send invitation' })).toHaveFocus()
  })

  it('invites a returning visitor picked from the typeahead', async () => {
    const elodie = makeSearchItem()
    const { user, requests } = setup({ extra: { 'GET /visitors': () => jsonResponse(page([elodie])) } })
    await openForm()

    expect(screen.getByText('or enter a new visitor')).toBeInTheDocument()
    await user.type(screen.getByRole('combobox', { name: /^Returning visitor/ }), 'elo')
    const option = await popupOption(/Élodie Martin/)
    // What matched is marked.
    expect(option.querySelector('[data-match]')).toHaveTextContent('Élo')
    await user.click(option)

    const search = requests.find((request) => request.path === '/visitors')
    expect(Object.fromEntries(search?.url.searchParams ?? [])).toEqual({ q: 'elo', page_size: '10' })
    expect(screen.queryByRole('textbox', { name: 'Full name' })).toBeNull()
    expect(screen.queryByText('or enter a new visitor')).toBeNull()
    // The selected visitor's details, without repeating the name the field shows.
    const details = screen.getByText('Company').closest('dl') as HTMLElement
    expect(details).toHaveTextContent('CompanyOrbit LabsPhone+962 79 555 0100Emailelodie@orbit.example')
    expect(details).not.toHaveTextContent('Élodie Martin')

    await user.type(field.purpose(), 'Contract signing')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    expect(createBody(requests)).toMatchObject({ visitor_id: elodie.id, purpose: 'Contract signing' })
    expect(createBody(requests)).not.toHaveProperty('visitor')
  })

  it('starts with the visitor of "Invite again", resolved through the scoped visitor endpoint', async () => {
    const { user, requests } = setup({
      initialEntry: `/visits/new?visitor=${VISITOR_ID}`,
      extra: { [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()) },
    })
    await openForm()

    expect(await screen.findByRole('combobox', { name: /^Returning visitor/ })).toHaveValue('Élodie Martin')
    expect(screen.queryByRole('textbox', { name: 'Full name' })).toBeNull()
    await user.type(field.purpose(), 'Follow-up')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    await successShown()
    expect(createBody(requests)).toMatchObject({ visitor_id: VISITOR_ID, purpose: 'Follow-up' })
    expect(createBody(requests)).not.toHaveProperty('visitor')
  })

  it('falls back to the empty form when the visitor of "Invite again" cannot be loaded', async () => {
    setup({
      initialEntry: '/visits/new?visitor=5a1b2c3d-0000-4000-8000-0000000000ff',
      extra: { 'GET /visitors/5a1b2c3d-0000-4000-8000-0000000000ff': () => errorResponse(404, 'NOT_FOUND', 'The requested item was not found.') },
    })

    expect(await screen.findByText('The visitor could not be loaded')).toBeInTheDocument()
    expect(field.name()).toHaveValue('')
  })

  it('does not send an invitation to a returning visitor without an email address', async () => {
    const { user, requests } = setup({ extra: { 'GET /visitors': () => jsonResponse(page([makeSearchItem({ email: null })])) } })
    await openForm()
    const picker = screen.getByRole('combobox', { name: /^Returning visitor/ })
    await user.type(picker, 'elo')
    await user.click(await popupOption(/Élodie Martin/))
    await user.type(field.purpose(), 'Contract signing')

    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(picker).toHaveAccessibleDescription(/This visitor has no email address\. Choose “I’ll share the pass myself”/)
    expect(picker).toHaveFocus()
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
    // The delivery choice is offered for a returning visitor too.
    expect(field.emailDelivery()).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Enter a new visitor instead' }))
    expect(field.name()).toBeInTheDocument()
  })
})

describe('Invite visitor: success view', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls the invitation while it is being sent and stops once it is delivered', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
    let polls = 0
    const { user, requests } = setup({
      extra: {
        [`GET /visits/${VISIT_ID}`]: () => {
          polls += 1
          return jsonResponse(polls < 3 ? pendingVisit() : makeVisit())
        },
      },
    })
    await submitInvite(user)

    // The outcome that holds whatever the email does, as the page title (which takes focus), then the email's progress.
    const title = await successShown()
    expect(title).toHaveFocus()
    await waitFor(() => expect(document.title).toBe('Visit scheduled · Acme Holdings'))
    expect(await statusLine('Sending the invitation to elodie@orbit.example')).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(2000))
    await act(() => vi.advanceTimersByTimeAsync(2000))
    // "Sent" (accepted by the provider), never "delivered".
    expect(await statusLine('Invitation sent to elodie@orbit.example.')).toBeInTheDocument()
    expect(screen.queryByText(/deliver/i)).toBeNull()

    const pollsWhenSent = visitPolls(requests)
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(visitPolls(requests)).toBe(pollsWhenSent)
  })

  it('stops polling after 30 seconds, shows the current status and can check again', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
    const { user, requests } = setup({ extra: { [`GET /visits/${VISIT_ID}`]: () => jsonResponse(pendingVisit()) } })
    await submitInvite(user)
    await statusLine('Sending the invitation to elodie@orbit.example')

    await act(() => vi.advanceTimersByTimeAsync(31_000))

    expect(await statusLine('The invitation to elodie@orbit.example is still being sent.')).toBeInTheDocument()
    const polls = visitPolls(requests)
    // About one request every 2 seconds for 30 seconds, then none.
    expect(polls).toBeGreaterThanOrEqual(14)
    expect(polls).toBeLessThanOrEqual(17)
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(visitPolls(requests)).toBe(polls)

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(visitPolls(requests)).toBe(polls + 1))
    expect(await statusLine('Sending the invitation to elodie@orbit.example')).toBeInTheDocument()
  })

  it('leads with the created visit when the email fails, and makes sharing the pass the main action', async () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null, error: 'Mailbox unavailable' } })
    const { user } = setup({
      create: () => jsonResponse(created(failed), 201),
      extra: {
        [`GET /visits/${VISIT_ID}`]: () => jsonResponse(failed),
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()),
      },
    })
    await submitInvite(user)

    expect(await successShown()).toBeInTheDocument()
    // The live region still announces the failure, but is not shown next to the alert that says the same.
    const announced = await statusLine('The invitation email to elodie@orbit.example could not be sent.')
    expect(announced.parentElement).toHaveClass('sr-only')

    // One alert: what failed and the ways to fix the email (no advice, decision 3).
    const title = screen.getByText(/^Invitation not delivered to/)
    expect(title).toHaveTextContent('Invitation not delivered to elodie@orbit.example')
    const alert = title.closest('div.flex') as HTMLElement
    expect(await within(alert).findByRole('button', { name: 'Correct email and resend' })).toBeInTheDocument()
    expect(alert).not.toHaveTextContent(/Share the pass below/)
    expect(within(alert).getByRole('button', { name: 'Resend to same address' })).toBeInTheDocument()

    // The pass card is neutral: no second alert repeating the failure, one short line under the link.
    expect(screen.getByRole('heading', { level: 3, name: 'Visitor pass' })).toBeInTheDocument()
    expect(screen.queryByText(/Share this pass with the visitor now/)).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Pass link' })).toHaveAccessibleDescription('Shown only once.')

    // One primary action: sharing the pass on screen. The ways to fix the email come next.
    expect(screen.getByRole('button', { name: 'Copy link' }).className).toContain('bg-accent')
    expect(screen.getByRole('button', { name: 'Correct email and resend' }).className).not.toContain('bg-accent')
    expect(screen.getByRole('button', { name: 'Resend to same address' }).className).not.toContain('bg-accent')
    expect(screen.getByRole('link', { name: 'View visit' }).className).not.toContain('bg-accent')
  })

  it('corrects the address from the success view and withdraws the pass link the change replaced', async () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null, to_email: 'elodie@orbit.exmaple' } })
    let corrected = false
    const { user, requests } = setup({
      create: () => jsonResponse(created(failed), 201),
      extra: {
        [`GET /visits/${VISIT_ID}`]: () =>
          jsonResponse(corrected ? makeVisit({ invitation: { status: 'PENDING', sent_at: null } }) : failed),
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor({ email: 'elodie@orbit.exmaple' })),
        [`PATCH /visitors/${VISITOR_ID}`]: () => {
          corrected = true
          return jsonResponse(makeVisitor())
        },
      },
    })
    await submitInvite(user)

    await user.click(await screen.findByRole('button', { name: 'Correct email and resend' }))
    const dialog = screen.getByRole('dialog', { name: 'Correct the email address' })
    const email = within(dialog).getByRole('textbox', { name: /^Email/ })
    await user.clear(email)
    await user.type(email, 'elodie@orbit.example')
    await user.click(within(dialog).getByRole('button', { name: 'Save and send invitation' }))

    expect(await screen.findByText('The visitor pass was replaced')).toBeInTheDocument()
    expect(screen.getByText('The visitor pass was replaced').parentElement).toHaveTextContent('A new invitation is being sent to elodie@orbit.example.')
    // D-19 revoked the pass this screen showed: its link must not be shared any more.
    expect(screen.queryByRole('textbox', { name: 'Pass link' })).toBeNull()
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ email: 'elodie@orbit.example' })
    expect(await statusLine('Sending the invitation to elodie@orbit.example')).toBeInTheDocument()
  })

  it('resends from the success view and shows the new pass link instead of the old one', async () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null } })
    const NEW_PASS_URL = 'https://visitors.example.com/pass#Zq9_aB1-cD2eF3gH4iJ5kL6mN7oP8qR9sT0-uV_wXyZ'
    const { user, requests } = setup({
      create: () => jsonResponse(created(failed), 201),
      extra: {
        [`GET /visits/${VISIT_ID}`]: () => jsonResponse(failed),
        // This visitor may not be edited by the caller: only the resend is offered.
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor({ permissions: { can_edit: false } })),
        [`POST /visits/${VISIT_ID}/invitation`]: () => jsonResponse({ visit: pendingVisit(), pass_url: NEW_PASS_URL, visitor_match: { reused: false } }),
      },
    })
    await submitInvite(user)
    await statusLine('The invitation email to elodie@orbit.example could not be sent.')
    await waitFor(() => expect(requests.some((request) => request.path === `/visitors/${VISITOR_ID}`)).toBe(true))
    await screen.findByRole('button', { name: 'Resend invitation' })
    expect(screen.queryByRole('button', { name: 'Correct email and resend' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Resend invitation' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Resend invitation' }))

    expect(await screen.findByText('The visitor pass was replaced')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Pass link' })).toHaveValue(NEW_PASS_URL)
  })

  it('does not load a reused visitor’s record to correct it on the spot', async () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null } })
    const { user, requests } = setup({
      create: () => jsonResponse(created(failed, true), 201),
      extra: { [`GET /visits/${VISIT_ID}`]: () => jsonResponse(failed) },
    })
    await submitInvite(user)

    await statusLine('The invitation email to elodie@orbit.example could not be sent.')
    expect(screen.getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correct email and resend' })).toBeNull()
    expect(requests.some((request) => request.path.startsWith('/visitors/'))).toBe(false)
  })

  it('warns when the existing visitor record used has another name, and lets the host cancel the visit', async () => {
    // The typed address already belongs to Sami Nasser: the server linked the visit to him (D-05).
    const sami = makeVisit({ visitor: { id: VISITOR_ID, full_name: 'Sami Nasser', company_name: 'Jordan Telecom Group' } })
    const cancelledSami = makeVisit({
      ...sami,
      status: 'CANCELLED',
      cancelled_at: '2026-10-05T06:11:00Z',
      pass: { status: 'REVOKED', revoke_reason: 'VISIT_CANCELLED' },
      permissions: { can_edit: false, can_cancel: false, can_resend: false },
    })
    let current = sami
    const { user, requests } = setup({
      create: () => jsonResponse(created(sami, true), 201),
      extra: {
        [`GET /visits/${VISIT_ID}`]: () => jsonResponse(current),
        [`POST /visits/${VISIT_ID}/cancel`]: () => {
          current = cancelledSami
          return jsonResponse(cancelledSami)
        },
      },
    })
    await submitInvite(user, { name: 'Karim Fail', email: 'visitor@fail.test' })
    await successShown('Sami Nasser')
    // The company on its own line under the name, as on every other screen.
    const company = screen.getByRole('heading', { level: 2, name: 'Sami Nasser' }).nextElementSibling
    expect(company?.tagName).toBe('P')
    expect(company).toHaveTextContent(/^Jordan Telecom Group$/)

    const warning = screen.getByText('Check who this visit is for').parentElement as HTMLElement
    expect(warning).toHaveTextContent(
      'You entered “Karim Fail”, but visitor@fail.test already belongs to “Sami Nasser”, so this visit is for “Sami Nasser”.',
    )
    // Who the visit is for comes before how it is delivered.
    expect(screen.queryByText(/its saved details were not overwritten/i)).toBeNull()

    await user.click(within(warning.parentElement as HTMLElement).getByRole('button', { name: 'Cancel this visit' }))
    await user.click(within(screen.getByRole('alertdialog', { name: 'Cancel this visit?' })).getByRole('button', { name: 'Cancel visit' }))

    const title = await screen.findByRole('heading', { level: 1, name: 'Visit cancelled' })
    await waitFor(() => expect(title).toHaveFocus())
    expect(requests.some((request) => request.method === 'POST' && request.path === `/visits/${VISIT_ID}/cancel`)).toBe(true)
    // The pass went with the visit: its one-time link is no longer offered.
    expect(screen.queryByRole('textbox', { name: 'Pass link' })).toBeNull()
    expect(screen.queryByText('Check who this visit is for')).toBeNull()
    // The title says it; no alert explaining the pass or advising on the next invitation (decision 3).
    expect(screen.queryByText('The visit was cancelled')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Sami Nasser' }).parentElement?.parentElement).toHaveTextContent('Cancelled')
    expect(screen.getByRole('button', { name: 'Invite another visitor' }).className).toContain('bg-accent')
  })

  it('adds no note when an existing visitor record of the same name was used (decision 3)', async () => {
    const { user } = setup({ create: () => jsonResponse(created(makeVisit(), true), 201) })
    await submitInvite(user)

    await successShown()
    expect(await statusLine('Invitation sent to elodie@orbit.example.')).toBeInTheDocument()
    expect(screen.queryByText(/already belongs to|visitor record was used/)).toBeNull()
  })

  it('offers the one-time pass: copy, QR code and print, with a note that it is shown only once', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const { user } = setup({ create: () => jsonResponse(created(makeVisit()), 201) })
    await submitInvite(user)

    const link = await screen.findByRole('textbox', { name: 'Pass link' })
    expect(link).toHaveValue(PASS_URL)
    // Like the one-time password: one short line says it is shown once. A web address reads left to right.
    expect(link).toHaveAccessibleDescription('Shown only once.')
    expect(link).toHaveAttribute('dir', 'ltr')
    // Direction C's pass card: the code itself beside the link, a picture of what "Show QR code" opens (hidden from assistive technology).
    const card = screen.getByRole('region', { name: 'Visitor pass' })
    await waitFor(() => expect(card.querySelector('[aria-hidden="true"] svg path')).not.toBeNull())
    expect(within(card).queryByRole('img')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    // user-event provides the clipboard in tests.
    expect(await navigator.clipboard.readText()).toBe(PASS_URL)
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show QR code' }))
    const dialog = screen.getByRole('dialog', { name: 'Visitor pass QR code' })
    // The code large, with whose pass it is and for when; no explanation (decision 3).
    expect(dialog).not.toHaveAccessibleDescription()
    const qr = await within(dialog).findByRole('img', { name: 'Visitor pass QR code for Élodie Martin' })
    expect(dialog).toHaveTextContent('Tue, 6 Oct 2026, 09:00–\u206010:00')
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h\d+v1h-\d+z/)
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show QR code' })).toHaveFocus()

    const printButton = screen.getByRole('button', { name: 'Print pass' })
    await waitFor(() => expect(printButton).toBeEnabled())
    await user.click(printButton)
    expect(print).toHaveBeenCalledOnce()

    // What goes on paper: the company (its logo when it has one; Phase 12), visitor, date and time, host and QR code. Never the product.
    const printable = document.querySelector<HTMLElement>('[data-print-pass]')
    expect(printable).not.toBeNull()
    expect(printable).toHaveAttribute('aria-hidden', 'true')
    expect(printable).not.toHaveTextContent('Mawdoo3')
    expect(printable?.querySelector('[data-brand-logo]')).toBeNull()
    expect(printable).toHaveTextContent('Acme Holdings')
    expect(printable).toHaveTextContent('Élodie Martin')
    expect(printable).toHaveTextContent('Tue, 6 Oct 2026, 09:00–\u206010:00')
    expect(printable).not.toHaveTextContent('UTC')
    // The pass's facts and code; no instructions or tips on paper either (the user's request 8).
    expect(printable).not.toHaveTextContent(/reception|photo/i)
    expect(within(printable as HTMLElement).getByRole('img', { hidden: true, name: 'Visitor pass QR code' })).toBeInTheDocument()
  })

  it('leads to the visit, or to a fresh form for the next invitation', async () => {
    const { user } = setup({ create: () => jsonResponse(created(makeVisit()), 201) })
    await submitInvite(user)
    await statusLine('Invitation sent to elodie@orbit.example.')
    // With the email on its way, the visit is the one primary action.
    expect(screen.getByRole('link', { name: 'View visit' })).toHaveAttribute('href', `/visits/${VISIT_ID}`)
    expect(screen.getByRole('link', { name: 'View visit' }).className).toContain('bg-accent')
    expect(screen.getByRole('button', { name: 'Copy link' }).className).not.toContain('bg-accent')

    await user.click(screen.getByRole('button', { name: 'Invite another visitor' }))

    expect(field.name()).toHaveValue('')
    expect(field.purpose()).toHaveValue('')
    expect(screen.getByRole('combobox', { name: /^Returning visitor/ })).toHaveFocus()
    // The one-time link is gone with the success view.
    expect(screen.queryByRole('textbox', { name: 'Pass link' })).toBeNull()
    expect(document.querySelector('[data-print-pass]')).toBeNull()
  })
})
