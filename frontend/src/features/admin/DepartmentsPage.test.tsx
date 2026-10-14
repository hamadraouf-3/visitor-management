import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest } from '../../test/api'
import { FINANCE, LEGAL } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { Department, DepartmentCreate, DepartmentUpdate, Me } from '../../types/api'

const ARCHIVE: Department = { ...FINANCE, id: '7f0d1c0e-2222-4a5b-9c1d-0000000000aa', name: 'Archive', is_active: false }

function writes(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/departments'))
}

const ADMIN = makeMe(['SYSTEM_ADMIN'])
/** The same administrator in the Arabic UI. */
const ARABIC_ADMIN: Me = { ...ADMIN, user: { ...ADMIN.user, preferred_language: 'ar' } }
/** Finance with its Arabic name (the demo's departments have both, phase 10 shared contract B). */
const FINANCE_AR: Department = { ...FINANCE, name_ar: 'المالية' }

/** The server's 409 for a name another department has (`details.field` names which one). */
function nameTaken(departments: Department[], body: { name?: string; name_ar?: string | null }, exceptId?: string) {
  const others = departments.filter((department) => department.id !== exceptId)
  const { name, name_ar: nameAr } = body
  if (name !== undefined && others.some((department) => department.name.toLowerCase() === name.toLowerCase())) {
    return errorResponse(409, 'CONFLICT', 'A department with this name already exists.', { field: 'name' })
  }
  if (nameAr && others.some((department) => department.name_ar?.toLowerCase() === nameAr.toLowerCase())) {
    return errorResponse(409, 'CONFLICT', 'A department with this Arabic name already exists.', { field: 'name_ar' })
  }
  // Across the languages too (B10-29): a name may not be another department's Arabic name, nor the reverse.
  if (name !== undefined && others.some((department) => department.name_ar?.toLowerCase() === name.toLowerCase())) {
    return errorResponse(409, 'CONFLICT', 'A department with this Arabic name already exists.', { field: 'name' })
  }
  if (nameAr && others.some((department) => department.name.toLowerCase() === nameAr.toLowerCase())) {
    return errorResponse(409, 'CONFLICT', 'A department with this name already exists.', { field: 'name_ar' })
  }
  return null
}

function setup(initial: Department[] = [FINANCE, LEGAL, ARCHIVE], path = '/admin/departments', me: Me = ADMIN) {
  let departments = [...initial]
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(me),
    'GET /departments': () => jsonResponse(departments),
    'POST /departments': (request) => {
      const body = request.body as DepartmentCreate
      const conflict = nameTaken(departments, body)
      if (conflict) return conflict
      const created = { ...FINANCE, id: `new-${body.name}`, name: body.name, name_ar: body.name_ar ?? null }
      departments = [...departments, created]
      return jsonResponse(created, 201)
    },
    ...Object.fromEntries(
      initial.map((department) => [
        `PATCH /departments/${department.id}`,
        (request: { body: unknown }) => {
          const body = request.body as DepartmentUpdate
          const conflict = nameTaken(departments, body, department.id)
          if (conflict) return conflict
          const updated = { ...departments.find((item) => item.id === department.id)!, ...body }
          departments = departments.map((item) => (item.id === department.id ? updated : item))
          return jsonResponse(updated)
        },
      ]),
    ),
  })
  /** A department another administrator added after this page loaded its list. */
  const addElsewhere = (department: Department) => {
    departments = [...departments, department]
  }
  return { ...api, addElsewhere, ...renderRoutes(routes, { initialEntries: [path] }) }
}

/** The text of each row's first cell (the department's names). */
function rowNames(table: HTMLElement) {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent)
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('Departments', () => {
  it('lists active departments and, on request, inactive ones too, from one request that includes them', async () => {
    const { requests, user, router } = setup()
    const table = await screen.findByRole('table', { name: 'Departments' })
    expect(within(table).getAllByRole('row').slice(1).map((row) => row.querySelector('td')?.textContent)).toEqual(['Finance', 'Legal'])
    expect(requests.find((request) => request.path === '/departments')?.url.searchParams.get('include_inactive')).toBe('true')

    await user.click(screen.getByRole('checkbox', { name: 'Show inactive departments (1)' }))
    expect(router.state.location.search).toBe('?inactive=1')
    expect(within(table).getAllByRole('row').slice(1).map((row) => row.querySelector('td')?.textContent)).toEqual(['Finance', 'Legal', 'ArchiveInactive'])
    expect(within(table).getByRole('button', { name: 'Reactivate Archive' })).toBeInTheDocument()
    // Only the exception is flagged, as on the Users list: no "Active" badge, and no status column.
    expect(within(table).queryByText('Active')).toBeNull()
    expect(within(table).queryByRole('columnheader', { name: 'Status' })).toBeNull()
    expect(within(table).getByText('Archive')).toHaveClass('text-fg-muted')
    // The header counts both, in place of the old explanatory sentence (decision 3).
    const header = screen.getByRole('heading', { level: 1, name: 'Departments' }).closest('header')!
    expect(header).toHaveTextContent('2 active departments')
    expect(header).toHaveTextContent('1 inactive')
    expect(header.textContent).not.toMatch(/never deleted/)
  })

  it('creates a department and shows a name conflict on the field', async () => {
    const { requests, user } = setup()
    await screen.findByRole('table', { name: 'Departments' })
    await user.click(screen.getAllByRole('button', { name: 'Add department' })[0]!)
    let dialog = await screen.findByRole('dialog', { name: 'Add department' })

    // Caught before sending: an inactive department already has the name.
    await user.type(within(dialog).getByLabelText('Name'), 'archive')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription('An inactive department has this name. Reactivate it instead.')
    expect(writes(requests)).toHaveLength(0)

    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), '  Security  ')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(await screen.findByText('Security created')).toBeInTheDocument()
    expect(writes(requests)[0]!.body).toEqual({ name: 'Security' })

    // A name the list did not know yet (another administrator was quicker): the server's 409.
    await user.click(screen.getAllByRole('button', { name: 'Add department' })[0]!)
    dialog = await screen.findByRole('dialog', { name: 'Add department' })
    await user.type(within(dialog).getByLabelText('Name'), 'SECURITY ')
    await waitFor(() => expect(screen.queryAllByRole('row').length).toBeGreaterThan(3))
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription('A department with this name already exists.')
  })

  it('renames, deactivates and reactivates', async () => {
    const { requests, user } = setup([FINANCE, LEGAL, ARCHIVE], '/admin/departments?inactive=1')
    await screen.findByRole('table', { name: 'Departments' })

    await user.click(screen.getByRole('button', { name: 'Rename Legal' }))
    const rename = await screen.findByRole('dialog', { name: 'Rename Legal' })
    // No explanatory notes (decision 3): the dialog is its title, the field and the buttons.
    expect(rename).not.toHaveAttribute('aria-describedby')
    await user.clear(within(rename).getByLabelText('Name'))
    await user.type(within(rename).getByLabelText('Name'), 'Legal Affairs')
    await user.click(within(rename).getByRole('button', { name: 'Rename' }))
    expect(await screen.findByText('Renamed to Legal Affairs')).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Deactivate Finance' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Finance?' })
    // A deactivation can be undone: the confirmation is its title and its two choices, no explanation.
    expect(confirm).not.toHaveAttribute('aria-describedby')
    expect(confirm).not.toHaveTextContent('It can no longer be chosen')
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate department' }))
    expect(await screen.findByText('Finance deactivated')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reactivate Archive' }))
    expect(await screen.findByText('Archive reactivated')).toBeInTheDocument()

    expect(writes(requests).map((request) => request.body)).toEqual([{ name: 'Legal Affairs' }, { is_active: false }, { is_active: true }])
  })

  it('keeps keyboard focus on the page when a deactivated department leaves the list', async () => {
    const { user } = setup()
    await screen.findByRole('table', { name: 'Departments' })
    await user.click(screen.getByRole('button', { name: 'Deactivate Finance' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deactivate department' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Deactivate Finance' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Departments' })).toHaveFocus())
  })

  it('names a department in two languages: the name, and the Arabic name the Arabic UI shows', async () => {
    const { requests, user } = setup()
    await screen.findByRole('table', { name: 'Departments' })
    await user.click(screen.getAllByRole('button', { name: 'Add department' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Add department' })

    // Two fields, labels only (decision 3): the name is required, the Arabic name optional and typed right to left.
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    const nameAr = within(dialog).getByRole('textbox', { name: 'Arabic name (optional)' })
    expect(name).toHaveAttribute('aria-required', 'true')
    expect(nameAr).not.toHaveAttribute('aria-required')
    expect(nameAr).toHaveAttribute('dir', 'rtl')
    expect(nameAr).toHaveAttribute('lang', 'ar')
    expect(name).not.toHaveAccessibleDescription()
    expect(nameAr).not.toHaveAccessibleDescription()

    // Only the name is required.
    await user.type(nameAr, 'الأمن')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(name).toHaveAccessibleDescription('Enter a department name.')
    expect(writes(requests)).toHaveLength(0)

    await user.type(name, 'Security')
    await user.type(nameAr, '  ')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(await screen.findByText('Security created')).toBeInTheDocument()
    expect(writes(requests)[0]!.body).toEqual({ name: 'Security', name_ar: 'الأمن' })
    // The list shows the English name, the Arabic one under it in its own language.
    const table = screen.getByRole('table', { name: 'Departments' })
    await waitFor(() => expect(rowNames(table)).toContain('Securityالأمن'))
    expect(within(table).getByText('الأمن')).toHaveAttribute('lang', 'ar')
  })

  it('changes or clears the Arabic name alone, and sends nothing when nothing changed', async () => {
    const { requests, user } = setup([FINANCE_AR, LEGAL, ARCHIVE])
    await screen.findByRole('table', { name: 'Departments' })

    await user.click(screen.getByRole('button', { name: 'Rename Finance' }))
    let dialog = await screen.findByRole('dialog', { name: 'Rename Finance' })
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Finance')
    expect(within(dialog).getByRole('textbox', { name: 'Arabic name (optional)' })).toHaveValue('المالية')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes(requests)).toHaveLength(0)

    // Cleared: sent as null, so the Arabic UI shows the name again. The name shown here did not change: "saved".
    await user.click(screen.getByRole('button', { name: 'Rename Finance' }))
    dialog = await screen.findByRole('dialog', { name: 'Rename Finance' })
    await user.clear(within(dialog).getByRole('textbox', { name: 'Arabic name (optional)' }))
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(await screen.findByText('Finance saved')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Rename Legal' }))
    dialog = await screen.findByRole('dialog', { name: 'Rename Legal' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Arabic name (optional)' }), 'الشؤون القانونية')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(await screen.findByText('Legal saved')).toBeInTheDocument()

    expect(writes(requests).map((request) => request.body)).toEqual([{ name_ar: null }, { name_ar: 'الشؤون القانونية' }])
  })

  it('catches an Arabic name another department has, and shows the server’s conflict on that field', async () => {
    const { requests, user, addElsewhere } = setup([FINANCE_AR, LEGAL, { ...ARCHIVE, name_ar: 'الأرشيف' }])
    await screen.findByRole('table', { name: 'Departments' })
    await user.click(screen.getAllByRole('button', { name: 'Add department' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Add department' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    const nameAr = within(dialog).getByRole('textbox', { name: 'Arabic name (optional)' })

    // Before sending, as for the name: an active department's, then an inactive one's (it can be reactivated).
    await user.type(name, 'Accounts')
    await user.type(nameAr, 'المالية')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(nameAr).toHaveAccessibleDescription('A department with this Arabic name already exists.')
    expect(nameAr).toHaveFocus()
    await user.clear(nameAr)
    await user.type(nameAr, 'الأرشيف')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(nameAr).toHaveAccessibleDescription('An inactive department has this Arabic name. Reactivate it instead.')
    expect(writes(requests)).toHaveLength(0)

    // Taken meanwhile by another administrator: the server's 409 names the Arabic name's field.
    addElsewhere({ ...LEGAL, id: 'elsewhere', name: 'Procurement', name_ar: 'المشتريات' })
    await user.clear(nameAr)
    await user.type(nameAr, 'المشتريات')
    await user.click(within(dialog).getByRole('button', { name: 'Add department' }))
    await waitFor(() => expect(nameAr).toHaveAccessibleDescription('A department with this Arabic name already exists.'))
    expect(name).not.toHaveAccessibleDescription()
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('catches a name that is another department’s in the other language, on the field that has it', async () => {
    const { requests, user, addElsewhere } = setup([FINANCE_AR, LEGAL, ARCHIVE])
    await screen.findByRole('table', { name: 'Departments' })
    await user.click(screen.getAllByRole('button', { name: 'Add department' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Add department' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    const nameAr = within(dialog).getByRole('textbox', { name: 'Arabic name (optional)' })
    const submit = () => user.click(within(dialog).getByRole('button', { name: 'Add department' }))

    // The review's case: Name «المالية» beside Finance / «المالية».
    await user.type(name, 'المالية')
    await submit()
    expect(name).toHaveAccessibleDescription('A department with this Arabic name already exists.')
    expect(name).toHaveFocus()
    // An Arabic name that is another department's name: Finance (which has an Arabic name), then the inactive Archive.
    await user.clear(name)
    await user.type(name, 'Procurement')
    await user.type(nameAr, 'finance')
    await submit()
    expect(nameAr).toHaveAccessibleDescription('A department with this name already exists.')
    expect(name).not.toHaveAccessibleDescription()
    await user.clear(nameAr)
    await user.type(nameAr, 'Archive')
    await submit()
    expect(nameAr).toHaveAccessibleDescription('An inactive department has this name. Reactivate it instead.')
    expect(writes(requests)).toHaveLength(0)

    // Taken meanwhile by another administrator: the server's 409 names the field.
    addElsewhere({ ...LEGAL, id: 'elsewhere', name: 'Purchasing' })
    await user.clear(nameAr)
    await user.type(nameAr, 'Purchasing')
    await submit()
    await waitFor(() => expect(nameAr).toHaveAccessibleDescription('A department with this name already exists.'))
    expect(writes(requests)).toHaveLength(1)
  })

  it('lists each department in the UI language, sorted by it, with the other language’s name under it', async () => {
    await i18n.changeLanguage('ar')
    const administration: Department = { ...LEGAL, id: '7f0d1c0e-2222-4a5b-9c1d-0000000000ad', name: 'Administration', name_ar: 'الإدارة' }
    setup([FINANCE_AR, LEGAL, administration], '/admin/departments', ARABIC_ADMIN)
    const table = await screen.findByRole('table', { name: 'الأقسام' })

    // «الإدارة» before «المالية» by their Arabic names; Legal has no Arabic name and shows its name alone.
    expect(rowNames(table)).toEqual(['الإدارةAdministration', 'الماليةFinance', 'Legal'])
    expect(within(table).getByText('Finance')).toHaveAttribute('lang', 'en')
    expect(within(table).getByRole('button', { name: 'تغيير اسم المالية' })).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'تغيير اسم Legal' })).toBeInTheDocument()

    await i18n.changeLanguage('en')
    await waitFor(() => expect(rowNames(screen.getByRole('table', { name: 'Departments' }))).toEqual(['Administrationالإدارة', 'Financeالمالية', 'Legal']))
  })
})
