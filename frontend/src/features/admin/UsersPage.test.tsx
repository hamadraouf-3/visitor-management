import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { FINANCE, LEGAL, page } from '../../test/fixtures'
import { findAlert, renderRoutes } from '../../test/render'
import type { User } from '../../types/api'
import { makeUser } from './testRoutes'

const me = makeMe(['SYSTEM_ADMIN', 'EMPLOYEE'])
const self = makeUser({
  id: me.user.id,
  full_name: me.user.full_name,
  email: me.user.email,
  roles: ['SYSTEM_ADMIN', 'EMPLOYEE'],
  department: { id: FINANCE.id, name: FINANCE.name, name_ar: null },
})
const omar = makeUser()
const newcomer = makeUser({
  id: '7f0d1c0e-1111-4a5b-9c1d-000000000088',
  full_name: 'Rana Saleh',
  email: 'rana.saleh@acme.example',
  roles: ['RECEPTIONIST'],
  department: null,
  must_change_password: true,
  last_login_at: null,
})

function userRequests(requests: RecordedRequest[], method = 'GET') {
  return requests.filter((request) => request.method === method && request.path.startsWith('/users'))
}

function setup(extra: Record<string, RouteHandler> = {}, path = '/admin/users') {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(me),
    'GET /users': () => jsonResponse(page([self, omar, newcomer])),
    'GET /departments': () => jsonResponse([FINANCE, LEGAL]),
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

async function openEdit(user: ReturnType<typeof renderRoutes>['user'], name: string) {
  await user.click(await screen.findByRole('button', { name: `Edit ${name}` }))
  return screen.findByRole('dialog')
}

/** 13:00 in Amman on the day of `makeUser`'s last sign-in (09:00 Amman), so it reads "Today, 09:00". */
const NOW = new Date('2026-10-05T10:00:00Z')

describe('Users page', () => {
  // Only the clock: debounces and queries keep real timers (phase-2-4-frontend decision 30).
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists accounts with roles, status and last sign-in', async () => {
    setup()
    const table = await screen.findByRole('table', { name: 'Users' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows[0]).toHaveTextContent('Lina Haddad (you)')
    expect(within(rows[0]!).getByText('Administrator')).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('omar.khalil@acme.example')
    expect(rows[1]).toHaveTextContent('Legal')
    expect(within(rows[1]!).getByText('Today, 09:00')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Temporary password')).toBeInTheDocument()
    expect(rows[2]).toHaveTextContent('Never signed in')
    // Direction C's person cell: the initials tile (decorative) beside the name.
    expect(rows[1]!.querySelector('[data-avatar]')).toHaveAttribute('aria-hidden', 'true')
    // Below 1280 px each account is a card (two per row from md): five columns need a desktop's width.
    expect((table.querySelector('tbody') as HTMLElement).className).toContain('md:max-xl:grid-cols-2')
    // The header counts the accounts; no explanatory sentence under the title (decision 3).
    const header = screen.getByRole('heading', { level: 1, name: 'Users' }).closest('header')!
    expect(header).toHaveTextContent('3 accounts')
    expect(header.textContent).not.toMatch(/never deleted|deactivated/)
    expect(screen.getByRole('searchbox', { name: 'Search users' })).toHaveAttribute('placeholder', 'Name or email')
  })

  it('mutes an inactive account’s name and says "Inactive" beside it', async () => {
    const former = makeUser({ id: '7f0d1c0e-1111-4a5b-9c1d-000000000099', full_name: 'Fatima Benali', is_active: false })
    setup({ 'GET /users': () => jsonResponse(page([omar, former])) })
    const table = await screen.findByRole('table', { name: 'Users' })
    const [active, inactive] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement]

    const name = within(inactive).getByText('Fatima Benali')
    expect(name.className).toContain('text-fg-muted')
    expect(name.nextElementSibling).toHaveTextContent('Inactive')
    expect(within(active).getByText('Omar Khalil').className).not.toContain('text-fg-muted')
    expect(within(active).queryByText('Inactive')).toBeNull()
  })

  it('maps the search, role and status filters to the request and the URL', async () => {
    const { requests, router, user } = setup({}, '/admin/users?role=MANAGEMENT&status=inactive&q=omar')
    await screen.findByRole('table', { name: 'Users' })
    expect(Object.fromEntries(userRequests(requests)[0]!.url.searchParams)).toEqual({
      page: '1',
      page_size: '25',
      q: 'omar',
      role: 'MANAGEMENT',
      is_active: 'false',
    })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'RECEPTIONIST')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all')
    await waitFor(() =>
      expect(Object.fromEntries(userRequests(requests).at(-1)!.url.searchParams)).toEqual({ page: '1', page_size: '25', q: 'omar', role: 'RECEPTIONIST' }),
    )
    expect(new URLSearchParams(router.state.location.search).get('status')).toBeNull()
  })
})

describe('Add user', () => {
  it('validates, generates a temporary password, creates the account and shows the password once', async () => {
    const { requests, user } = setup({ 'POST /users': () => jsonResponse(newcomer, 201) })
    await user.click((await screen.findAllByRole('button', { name: 'Add user' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Add user' })
    // No explanatory notes (decision 3): no description, no hints under the fields or the roles.
    expect(dialog).not.toHaveAttribute('aria-describedby')
    expect(within(dialog).getByLabelText('Email')).not.toHaveAccessibleDescription()
    expect(within(dialog).getByRole('checkbox', { name: 'Employee' })).not.toHaveAccessibleDescription()
    // The password rules stay.
    expect(within(dialog).getByText('Must not be a commonly used password.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Create user' }))
    expect(within(dialog).getByLabelText('Full name')).toHaveFocus()
    expect(within(dialog).getByText('Choose at least one role.')).toBeInTheDocument()
    expect(userRequests(requests, 'POST')).toHaveLength(0)

    await user.type(within(dialog).getByLabelText('Full name'), 'Rana Saleh')
    await user.type(within(dialog).getByLabelText('Email'), 'Rana.Saleh@acme.example')
    await user.click(within(dialog).getByRole('checkbox', { name: 'Reception' }))
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }))
    const password = within(dialog).getByLabelText('Temporary password') as HTMLInputElement
    expect(password).toHaveAttribute('type', 'text')
    expect(password.value).toMatch(/^[^-]{5}(-[^-]{5}){3}$/)
    const generated = password.value
    expect(within(dialog).getByText('12–128 characters')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Create user' }))

    const created = await screen.findByRole('dialog', { name: 'User created' })
    expect(userRequests(requests, 'POST')[0]!.body).toEqual({
      full_name: 'Rana Saleh',
      email: 'rana.saleh@acme.example',
      roles: ['RECEPTIONIST'],
      temporary_password: generated,
    })
    expect(within(created).getByLabelText('Temporary password')).toHaveValue(generated)
    // Focused on open, ready to copy.
    expect(within(created).getByLabelText('Temporary password')).toHaveFocus()
    expect(within(created).getByLabelText('Temporary password')).not.toHaveAccessibleDescription()
    // The address under its label as text that wraps: a read-only input cut a long one off on a phone (UX review L14).
    const address = within(created).getByText('rana.saleh@acme.example')
    expect(address.closest('dl')).toHaveTextContent('Email')
    expect(address.closest('dd')).not.toBeNull()
    expect(within(created).queryByDisplayValue('rana.saleh@acme.example')).not.toBeInTheDocument()
    // One line before closing loses the password for good, the dialog's description; no other note.
    expect(created).toHaveAccessibleDescription('The temporary password is shown only once and expires after 72\u00a0hours.')
    // The number keeps its unit on its line (a no-break space), and it is said once.
    expect(created.textContent?.match(/72\u00a0hours/g)).toHaveLength(1)
    expect(created.textContent).not.toMatch(/in person|Forgot password|first sign-in/)

    await user.click(within(created).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByDisplayValue(generated)).toBeNull()
  })

  it('shows an unavailable email address and a refused password on their fields', async () => {
    let attempt = 0
    const { user } = setup({
      'POST /users': () => {
        attempt += 1
        return attempt === 1
          ? errorResponse(409, 'USER_EMAIL_UNAVAILABLE', 'This email address cannot be used.')
          : errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
              fields: { temporary_password: 'This password is too common. Choose a less predictable password.' },
            })
      },
    })
    await user.click((await screen.findAllByRole('button', { name: 'Add user' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Add user' })
    await user.type(within(dialog).getByLabelText('Full name'), 'Rana Saleh')
    await user.type(within(dialog).getByLabelText('Email'), 'taken@acme.example')
    await user.click(within(dialog).getByRole('checkbox', { name: 'Employee' }))
    await user.type(within(dialog).getByLabelText('Temporary password'), 'password1234')

    await user.click(within(dialog).getByRole('button', { name: 'Create user' }))
    const email = within(dialog).getByLabelText('Email')
    await waitFor(() => expect(email).toHaveAccessibleDescription(expect.stringContaining('This email address cannot be used.')))
    expect(email).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Create user' }))
    const password = within(dialog).getByLabelText('Temporary password')
    await waitFor(() => expect(password).toHaveAccessibleDescription(expect.stringContaining('This password is too common.')))
    expect(password).toHaveFocus()
  })
})

/** The same administrator, signed in with Arabic as their language. */
function arabicSession() {
  return jsonResponse({ ...me, user: { ...me.user, preferred_language: 'ar' } })
}

describe('Roles in Arabic (final touches)', () => {
  // A role beside one account is a job title («موظف»), not the team that holds it («الموظفون»); the
  // role filter picks people out by role, so it names the teams.
  it('names each account’s roles as job titles and filters by the teams', async () => {
    setup({ 'GET /auth/me': arabicSession })
    const table = await screen.findByRole('table', { name: 'المستخدمون' })
    const [selfRow, omarRow, newcomerRow] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement, HTMLElement]

    expect(within(selfRow).getByText('مدير النظام')).toBeInTheDocument()
    expect(within(selfRow).getByText('موظف')).toBeInTheDocument()
    expect(within(omarRow).getByText('موظف')).toBeInTheDocument()
    expect(within(newcomerRow).getByText('موظف استقبال')).toBeInTheDocument()
    expect(table.textContent).not.toMatch(/الموظفون|إدارة النظام|الاستقبال/)

    const filter = screen.getByRole('combobox', { name: 'الدور' })
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'كل الأدوار',
      'إدارة النظام',
      'الموظفون',
      'الاستقبال',
      'الإدارة العليا',
    ])
  })

  it('offers the roles as job titles in the user dialogs, and their sentences name them so', async () => {
    const { user } = setup({ 'GET /auth/me': arabicSession })

    await user.click(await screen.findByRole('button', { name: 'تعديل Lina Haddad' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('checkbox', { name: 'مدير النظام' })).toHaveAccessibleDescription('لا يمكنك إزالة دور مدير النظام عن نفسك.')
    await user.click(within(dialog).getByRole('button', { name: 'إغلاق' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'تعديل Omar Khalil' }))
    dialog = await screen.findByRole('dialog')
    const roles = within(dialog).getByRole('group', { name: 'الأدوار' })
    expect(within(roles).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual([
      'موظف',
      'موظف استقبال',
      'الإدارة العليا',
      'مدير النظام',
    ])
    await user.click(within(roles).getByRole('checkbox', { name: 'موظف' }))
    await user.click(within(roles).getByRole('checkbox', { name: 'الإدارة العليا' }))
    expect(within(dialog).getByText(/^دون دور «موظف» أو «مدير النظام» لا يعود حساب Omar Khalil مضيفًا/)).toBeInTheDocument()
  })
})

describe('Edit user', () => {
  it('never offers to remove one’s own administrator role or to deactivate oneself', async () => {
    const { requests, user } = setup({ [`PATCH /users/${self.id}`]: () => jsonResponse({ ...self, full_name: 'Lina H. Haddad' }) })
    const dialog = await openEdit(user, 'Lina Haddad')

    // The account is named by its sign-in address, the dialog's only description.
    expect(dialog).toHaveAccessibleDescription(me.user.email)
    const admin = within(dialog).getByRole('checkbox', { name: 'Administrator' })
    expect(admin).toBeChecked()
    expect(admin).toBeDisabled()
    expect(admin).toHaveAccessibleDescription('You cannot remove your own administrator role.')
    const active = within(dialog).getByRole('checkbox', { name: 'Account is active' })
    expect(active).toBeDisabled()
    expect(active).toHaveAccessibleDescription('You cannot deactivate your own account.')
    // On screen a lock on each, not a standing sentence (the user's request 8): the reasons are
    // there for assistive technology only.
    expect(admin.closest('label')?.querySelector('[data-locked-role]')).not.toBeNull()
    expect(dialog.querySelector('[data-locked-active]')).not.toBeNull()
    for (const reason of ['You cannot remove your own administrator role.', 'You cannot deactivate your own account.']) {
      expect(within(dialog).getByText(reason)).toHaveClass('sr-only')
    }

    const name = within(dialog).getByLabelText('Full name')
    await user.clear(name)
    await user.type(name, 'Lina H. Haddad')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(userRequests(requests, 'PATCH')[0]!.body).toEqual({ full_name: 'Lina H. Haddad' })
  })

  it('warns that deactivating cancels hosted visits and reports how many were cancelled (D-18)', async () => {
    const { requests, user } = setup({
      [`PATCH /users/${omar.id}`]: () => jsonResponse({ ...omar, is_active: false, cancelled_visits: 3 } satisfies User),
    })
    const dialog = await openEdit(user, 'Omar Khalil')

    await user.click(within(dialog).getByRole('checkbox', { name: 'Account is active' }))
    expect(within(dialog).getByText('Scheduled visits will be cancelled')).toBeInTheDocument()
    expect(within(dialog).getByText('Deactivating Omar Khalil cancels every scheduled visit they host.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate user' }))

    expect(await screen.findByText('Omar Khalil was deactivated')).toBeInTheDocument()
    expect(screen.getByText('Hosted visits cancelled')).toBeInTheDocument()
    expect(screen.getByText('3 scheduled visits hosted by Omar Khalil were cancelled.')).toBeInTheDocument()
    expect(userRequests(requests, 'PATCH')[0]!.body).toEqual({ is_active: false })
  })

  it('warns when removing the last host role', async () => {
    const { user } = setup()
    const dialog = await openEdit(user, 'Omar Khalil')

    await user.click(within(dialog).getByRole('checkbox', { name: 'Employee' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Management' }))
    expect(within(dialog).getByText(/Without the Employee or Administrator role, Omar Khalil can no longer host/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save and cancel hosted visits' })).toBeInTheDocument()
  })

  it('shows LAST_ADMIN on the roles it concerns', async () => {
    const otherAdmin = makeUser({ id: '7f0d1c0e-1111-4a5b-9c1d-0000000000ad', full_name: 'Sami Admin', roles: ['SYSTEM_ADMIN'] })
    const { user } = setup({
      'GET /users': () => jsonResponse(page([otherAdmin])),
      [`PATCH /users/${otherAdmin.id}`]: () => errorResponse(409, 'LAST_ADMIN', 'The company must keep at least one active administrator.'),
    })
    const dialog = await openEdit(user, 'Sami Admin')

    await user.click(within(dialog).getByRole('checkbox', { name: 'Administrator' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Management' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save and cancel hosted visits' }))

    const roles = await within(dialog).findByRole('group', { name: 'Roles' })
    await waitFor(() => expect(roles).toHaveAccessibleDescription(expect.stringContaining('The company must keep at least one active administrator.')))
    expect(roles).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows LAST_ADMIN on the active switch when deactivating', async () => {
    const otherAdmin = makeUser({ id: '7f0d1c0e-1111-4a5b-9c1d-0000000000ad', full_name: 'Sami Admin', roles: ['SYSTEM_ADMIN'] })
    const { user } = setup({
      'GET /users': () => jsonResponse(page([otherAdmin])),
      [`PATCH /users/${otherAdmin.id}`]: () => errorResponse(409, 'LAST_ADMIN', 'The company must keep at least one active administrator.'),
    })
    const dialog = await openEdit(user, 'Sami Admin')
    await user.click(within(dialog).getByRole('checkbox', { name: 'Account is active' }))
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate user' }))

    expect(await findAlert('The company must keep at least one active administrator.')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Account is active' })).toHaveFocus()
  })

  it('reports a refused self-modification in the form', async () => {
    const { user } = setup({
      [`PATCH /users/${omar.id}`]: () =>
        errorResponse(409, 'SELF_MODIFICATION', 'You cannot remove your own administrator access or deactivate yourself.'),
    })
    const dialog = await openEdit(user, 'Omar Khalil')
    await user.type(within(dialog).getByLabelText('Phone (optional)'), '1')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await findAlert('You cannot remove your own administrator access or deactivate yourself.')).toBeInTheDocument()
  })

  it('closes without a request when nothing changed', async () => {
    const { requests, user } = setup()
    const dialog = await openEdit(user, 'Omar Khalil')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(userRequests(requests, 'PATCH')).toHaveLength(0)
  })

  it('clears a phone and a department with null', async () => {
    const { requests, user } = setup({ [`PATCH /users/${omar.id}`]: () => jsonResponse({ ...omar, phone: null, department: null }) })
    const dialog = await openEdit(user, 'Omar Khalil')
    await user.clear(within(dialog).getByLabelText('Phone (optional)'))
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Department (optional)' }), '')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(userRequests(requests, 'PATCH')).toHaveLength(1))
    expect(userRequests(requests, 'PATCH')[0]!.body).toEqual({ phone: null, department_id: null })
  })
})
