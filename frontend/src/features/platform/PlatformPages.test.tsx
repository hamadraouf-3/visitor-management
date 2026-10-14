import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest } from '../../test/api'
import { page } from '../../test/fixtures'
import { findAlert, renderRoutes } from '../../test/render'
import type { PlatformCompany, PlatformCompanyCreate } from '../../types/api'
import { makeCompanyAdmin, makePlatformAuditLog, makePlatformCompany, makePlatformMe, platformRoutes } from './testRoutes'

const NOVA = makePlatformCompany()
const ACME = makePlatformCompany({ id: '9b000000-0000-4000-8000-000000000002', name: 'Acme', name_ar: null, slug: 'acme', is_active: false, deactivated_at: '2026-10-04T08:00:00Z' })

function listQueries(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/platform/companies' && request.method === 'GET').map((request) => Object.fromEntries(request.url.searchParams))
}

function auditQueries(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/platform/audit-logs').map((request) => Object.fromEntries(request.url.searchParams))
}

/** The new-company page, with the server's answer to the creation. */
function setupNewCompany(create: (body: PlatformCompanyCreate) => Response) {
  const api = mockApi({
    ...platformRoutes(),
    'POST /platform/companies': (request) => create(request.body as PlatformCompanyCreate),
    [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(NOVA),
    [`GET /platform/companies/${NOVA.id}/admins`]: () => jsonResponse([makeCompanyAdmin()]),
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: ['/platform/companies/new'] }) }
}

async function fillNewCompany(user: ReturnType<typeof renderRoutes>['user']) {
  await screen.findByRole('heading', { level: 1, name: 'Add company' })
  await user.type(screen.getByLabelText('Company name'), 'Nova Labs')
  await user.type(screen.getByLabelText(/Arabic name/), 'نوفا لابز')
  await user.click(screen.getByRole('radio', { name: 'English' }))
  await user.type(screen.getByLabelText('Full name'), 'Nadia Haddad')
  await user.type(screen.getByLabelText('Email'), 'Nadia@Nova.Example')
  await user.type(screen.getByLabelText('Temporary password'), 'k7Hq2-mPx9z-4tRwc-Yb3nD')
}

/** A company's page: an active and an inactive administrator; deactivation and reactivation change the company. */
function setupCompanyPage(company: PlatformCompany = NOVA, routesOverride: Record<string, (request: RecordedRequest) => Response> = {}) {
  let current = company
  const api = mockApi({
    ...platformRoutes(),
    [`GET /platform/companies/${company.id}`]: () => jsonResponse(current),
    [`GET /platform/companies/${company.id}/admins`]: () =>
      jsonResponse([makeCompanyAdmin(), makeCompanyAdmin({ id: '9c000000-0000-4000-8000-000000000002', full_name: 'Omar Old', email: 'omar@nova.example', is_active: false })]),
    [`POST /platform/companies/${company.id}/deactivate`]: () => {
      current = { ...current, is_active: false, deactivated_at: '2026-10-05T08:00:00Z' }
      return jsonResponse(current)
    },
    [`POST /platform/companies/${company.id}/reactivate`]: () => {
      current = { ...current, is_active: true, deactivated_at: null }
      return jsonResponse(current)
    },
    ...routesOverride,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [`/platform/companies/${company.id}`] }) }
}

describe('the companies', () => {
  it('lists each company with its state and counts, and links to it', async () => {
    mockApi(platformRoutes({ companies: [NOVA, ACME] }))
    renderRoutes(routes, { initialEntries: ['/platform/companies'] })

    const table = await screen.findByRole('table', { name: 'Companies' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('link', { name: 'Nova Labs' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}`)
    expect(rows[0]).toHaveTextContent('nova-labs')
    expect(rows[0]).toHaveTextContent('Active')
    expect(rows[0]).toHaveTextContent('12')
    expect(rows[0]).toHaveTextContent('84')
    expect(rows[1]).toHaveTextContent('Deactivated')
    expect(screen.getByText('2 companies')).toBeInTheDocument()
  })

  it('searches and filters by state', async () => {
    const { requests } = mockApi(platformRoutes({ companies: [NOVA] }))
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    await screen.findByRole('link', { name: 'Nova Labs' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'inactive')
    await waitFor(() => expect(listQueries(requests).at(-1)).toMatchObject({ is_active: 'false', page: '1' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search companies' }), 'nova{Enter}')
    await waitFor(() => expect(listQueries(requests).at(-1)).toMatchObject({ q: 'nova', is_active: 'false' }))
  })
})

describe('adding a company', () => {
  it('suggests the slug, creates the company with its first administrator and shows the password once', async () => {
    const { requests, user, router } = setupNewCompany(() => jsonResponse({ company: NOVA, admin: makeCompanyAdmin() }, 201))
    await fillNewCompany(user)
    expect(screen.getByLabelText('Slug')).toHaveValue('nova-labs')
    await user.click(screen.getByRole('button', { name: 'Create company' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Company created' })).toBeInTheDocument()
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      name: 'Nova Labs',
      name_ar: 'نوفا لابز',
      slug: 'nova-labs',
      timezone: 'Asia/Amman',
      default_language: 'en',
      admin: { full_name: 'Nadia Haddad', email: 'nadia@nova.example', temporary_password: 'k7Hq2-mPx9z-4tRwc-Yb3nD' },
    })
    expect(screen.getByText('Nadia Haddad can now sign in')).toBeInTheDocument()
    expect(screen.getByLabelText('Temporary password')).toHaveValue('k7Hq2-mPx9z-4tRwc-Yb3nD')
    expect(screen.getByLabelText('Temporary password')).toHaveFocus()
    // One line before leaving loses the password, as "Add user" has: shown once, and when it expires (UX review L15).
    expect(screen.getByText('Pass the temporary password on now: it is shown only once and expires after 72 hours.')).toBeInTheDocument()
    expect(screen.queryByText('Expires after 72 hours.')).not.toBeInTheDocument()
    // The address as text that wraps, never a one-line input that cuts a long one off (UX review L14).
    const address = screen.getByText('nadia@nova.example')
    expect(address.closest('dd')).not.toBeNull()
    expect(address.closest('dl')).toHaveTextContent('Email')
    expect(screen.queryByDisplayValue('nadia@nova.example')).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Open company' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/platform/companies/${NOVA.id}`)
    // Shown once: nowhere on the company's page.
    expect(screen.queryByDisplayValue('k7Hq2-mPx9z-4tRwc-Yb3nD')).not.toBeInTheDocument()
  })

  it('checks the form, then again as it is corrected', async () => {
    const { requests, user } = setupNewCompany(() => jsonResponse({}, 500))
    await screen.findByRole('heading', { level: 1, name: 'Add company' })
    await user.click(screen.getByRole('button', { name: 'Create company' }))
    expect(await screen.findByText('Enter the company name.')).toBeInTheDocument()
    expect(screen.getByLabelText('Company name')).toHaveFocus()
    await user.type(screen.getByLabelText('Company name'), 'Nova')
    expect(screen.queryByText('Enter the company name.')).not.toBeInTheDocument()
    expect(screen.queryByText('Enter a slug.')).not.toBeInTheDocument()
    expect(screen.getByText("Enter the administrator's full name.")).toBeInTheDocument()
    expect(requests.some((request) => request.method === 'POST')).toBe(false)
  })

  it('puts a taken slug and a taken address on their fields', async () => {
    let answer = errorResponse(409, 'CONFLICT', 'A company with this slug already exists.', { field: 'slug' })
    const { user } = setupNewCompany(() => answer)
    await fillNewCompany(user)
    await user.click(screen.getByRole('button', { name: 'Create company' }))
    expect(await screen.findByText('A company with this slug already exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('Slug')).toHaveAttribute('aria-invalid', 'true')

    answer = errorResponse(409, 'USER_EMAIL_UNAVAILABLE', 'This email address cannot be used.')
    await user.click(screen.getByRole('button', { name: 'Create company' }))
    expect(await screen.findByText('This email address cannot be used.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
  })

  it.each([
    ['en', 'Too many attempts. Try again in 42\u00a0minutes.'],
    ['ar', 'محاولات كثيرة جدًا. حاول مجددًا بعد 42\u00a0دقيقة.'],
  ] as const)('says how long to wait when too many addresses were refused (%s) (B11-42)', async (language, message) => {
    mockApi({
      ...platformRoutes({ me: makePlatformMe({ preferred_language: language }) }),
      'POST /platform/companies': () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', details: {} }, request_id: 'r' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '2500' },
        }),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies/new'] })
    const labels = language === 'ar' ? ['إضافة شركة', 'اسم الشركة', 'الاسم الكامل', 'البريد الإلكتروني', 'كلمة المرور المؤقتة', 'إنشاء الشركة'] : ['Add company', 'Company name', 'Full name', 'Email', 'Temporary password', 'Create company']
    await screen.findByRole('heading', { level: 1, name: labels[0] })
    await user.type(screen.getByLabelText(labels[1]!), 'Nova Labs')
    await user.type(screen.getByLabelText(labels[2]!), 'Nadia Haddad')
    await user.type(screen.getByLabelText(labels[3]!), 'nadia@nova.example')
    await user.type(screen.getByLabelText(labels[4]!), 'k7Hq2-mPx9z-4tRwc-Yb3nD')
    await user.click(screen.getByRole('button', { name: labels[5] }))
    // The form's error says the wait; the form stays filled.
    expect(await findAlert(message)).toBeInTheDocument()
    expect(screen.getByLabelText(labels[1]!)).toHaveValue('Nova Labs')
    expect(screen.queryByText('Too many requests. Please wait and try again.')).not.toBeInTheDocument()
  })

  it('shows the server’s field codes in Arabic', async () => {
    mockApi({
      ...platformRoutes({ me: makePlatformMe({ preferred_language: 'ar' }) }),
      'POST /platform/companies': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Invalid', {
          fields: { slug: 'Use 1–80 lowercase letters.', 'admin.temporary_password': 'This password is too common.' },
          field_codes: { slug: { code: 'invalid_format', params: {} }, 'admin.temporary_password': { code: 'password_common', params: {} } },
        }),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies/new'] })
    await screen.findByRole('heading', { level: 1, name: 'إضافة شركة' })
    await user.type(screen.getByLabelText('اسم الشركة'), 'Nova Labs')
    await user.type(screen.getByLabelText('الاسم الكامل'), 'Nadia Haddad')
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'nadia@nova.example')
    await user.type(screen.getByLabelText('كلمة المرور المؤقتة'), 'k7Hq2-mPx9z-4tRwc-Yb3nD')
    await user.click(screen.getByRole('button', { name: 'إنشاء الشركة' }))
    expect(await screen.findByText('أدخل القيمة بالصيغة المطلوبة.')).toBeInTheDocument()
    expect(screen.getByText('كلمة المرور هذه شائعة جدًا. اختر كلمة مرور يصعب توقّعها.')).toBeInTheDocument()
  })
})

describe('a company’s page', () => {
  it('shows the company’s identity, counts and administrators', async () => {
    setupCompanyPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })).toBeInTheDocument()
    expect(screen.getByText('نوفا لابز')).toBeInTheDocument()
    expect(screen.getAllByText('nova-labs').length).toBeGreaterThan(0)
    expect(screen.getByText('Active users').closest('div')).toHaveTextContent('12')
    const admins = await screen.findByRole('list', { name: 'Administrators of Nova Labs' })
    expect(within(admins).getAllByRole('listitem')).toHaveLength(2)
    expect(within(admins).getByText('Inactive')).toBeInTheDocument()
    // A reset link only for the active administrator.
    const reset = within(admins).getAllByRole('button', { name: /^Send reset link to / })
    expect(reset).toHaveLength(1)
    // Its name starts with the words on it (WCAG 2.5.3).
    expect(reset[0]).toHaveTextContent('Send reset link')
    expect(reset[0]).toHaveAccessibleName('Send reset link to Nadia Haddad')
    // The log narrowed to this company is not named as the navigation's whole log is (UX review L4).
    expect(within(screen.getByRole('main')).getByRole('link', { name: "This company's audit log" })).toHaveAttribute('href', `/platform/audit?company=${NOVA.id}`)
    const auditLinks = screen.getAllByRole('link', { name: /audit log/i })
    expect(auditLinks.map((link) => link.getAttribute('href')).toSorted()).toEqual(['/platform/audit', `/platform/audit?company=${NOVA.id}`])
    expect(new Set(auditLinks.map((link) => link.textContent)).size).toBe(auditLinks.length)
  })

  it('deactivates after one line of confirmation, then reactivates', async () => {
    const { requests, user } = setupCompanyPage()
    await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Deactivate Nova Labs?' })
    expect(dialog).toHaveAccessibleDescription('Its users are signed out and cannot sign in, and its visitor passes stop working.')
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate company' }))

    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument()
    expect(screen.getAllByText('Deactivated').length).toBeGreaterThan(0)
    expect(screen.queryAllByRole('button', { name: /Send reset link/ })).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Reactivate' }))
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
    expect(requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
      `/platform/companies/${NOVA.id}/deactivate`,
      `/platform/companies/${NOVA.id}/reactivate`,
    ])
  })

  it('sends a password reset link and says where; a refusal says why', async () => {
    let refuse = false
    const { user } = setupCompanyPage(NOVA, {
      [`POST /platform/companies/${NOVA.id}/admins/${makeCompanyAdmin().id}/password-reset`]: () =>
        refuse ? errorResponse(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.') : jsonResponse({ sent_to: 'nadia@nova.example' }, 202),
    })
    const button = await screen.findByRole('button', { name: 'Send reset link to Nadia Haddad' })
    await user.click(button)
    expect(await screen.findByText('Reset link sent')).toBeInTheDocument()
    expect(screen.getByText('To nadia@nova.example')).toBeInTheDocument()
    refuse = true
    await user.click(button)
    expect(await screen.findByText('The reset link could not be sent')).toBeInTheDocument()
    // Without a `Retry-After` the server's own words.
    expect(screen.getByText('Too many requests. Please wait and try again.')).toBeInTheDocument()
  })

  it.each([
    ['en', 'Send reset link to Nadia Haddad', 'Too many reset links for this account. Try again in 12 minutes.'],
    ['ar', 'إرسال رابط إعادة التعيين إلى Nadia Haddad', 'بلغ هذا الحساب الحد المسموح من روابط إعادة التعيين. حاول مجددًا بعد 12 دقيقة.'],
  ] as const)('says how long to wait when the account’s reset links are used up (%s) (UX review L9)', async (language, buttonName, message) => {
    const { user } = setupCompanyPage(NOVA, {
      'GET /platform/auth/me': () => jsonResponse(makePlatformMe({ preferred_language: language })),
      [`POST /platform/companies/${NOVA.id}/admins/${makeCompanyAdmin().id}/password-reset`]: () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', details: {} }, request_id: 'r' }), {
          status: 429,
          // 11 minutes and 5 seconds: the wait is rounded up, never promised short.
          headers: { 'Content-Type': 'application/json', 'Retry-After': '665' },
        }),
    })
    await user.click(await screen.findByRole('button', { name: buttonName }))
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('edits the company’s identity, sending only what changed', async () => {
    const { requests, user } = setupCompanyPage(NOVA, { [`PATCH /platform/companies/${NOVA.id}`]: (request) => jsonResponse({ ...NOVA, ...(request.body as object) }) })
    await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Nova Labs' })
    await user.clear(within(dialog).getByLabelText(/Arabic name/))
    await user.click(within(dialog).getByRole('radio', { name: 'العربية' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Company saved')).toBeInTheDocument()
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ name_ar: null, default_language: 'ar' })
  })

  it('adds an administrator and shows the temporary password once', async () => {
    const { requests, user } = setupCompanyPage(NOVA, {
      [`POST /platform/companies/${NOVA.id}/admins`]: () => jsonResponse(makeCompanyAdmin({ id: 'new', full_name: 'Rami Saleh', email: 'rami@nova.example', must_change_password: true }), 201),
    })
    await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })
    await user.click(screen.getByRole('button', { name: 'Add administrator' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add administrator' })
    await user.type(within(dialog).getByLabelText('Full name'), 'Rami Saleh')
    await user.type(within(dialog).getByLabelText('Email'), 'rami@nova.example')
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }))
    const password = (within(dialog).getByLabelText('Temporary password') as HTMLInputElement).value
    await user.click(within(dialog).getByRole('button', { name: 'Add administrator' }))

    const created = await screen.findByRole('dialog', { name: 'Administrator added' })
    expect(within(created).getByLabelText('Temporary password')).toHaveValue(password)
    expect(within(created).getByLabelText('Temporary password')).toHaveFocus()
    expect(within(created).getByText('Rami Saleh can now sign in')).toBeInTheDocument()
    expect(created).toHaveAccessibleDescription('Pass the temporary password on now: it is shown only once and expires after 72\u00a0hours.')
    expect(within(created).getByText('rami@nova.example').closest('dd')).not.toBeNull()
    expect(requests.find((request) => request.path.endsWith('/admins') && request.method === 'POST')?.body).toEqual({
      full_name: 'Rami Saleh',
      email: 'rami@nova.example',
      temporary_password: password,
    })
  })

  it.each([
    ['en', 'Add administrator', 'Full name', 'Email', 'Generate', 'Administrator added', 'Rami Saleh can sign in once the company is reactivated', 'Rami Saleh can now sign in'],
    ['ar', 'إضافة مدير نظام', 'الاسم الكامل', 'البريد الإلكتروني', 'إنشاء تلقائي', 'أُضيف مدير النظام', 'بإمكان Rami Saleh تسجيل الدخول بعد إعادة تفعيل الشركة', 'بإمكان Rami Saleh تسجيل الدخول الآن'],
  ] as const)('does not say an administrator of a deactivated company can sign in now (%s) (UX review M4)', async (language, add, fullName, email, generate, added, later, now) => {
    const { user } = setupCompanyPage(ACME, {
      'GET /platform/auth/me': () => jsonResponse(makePlatformMe({ preferred_language: language })),
      [`POST /platform/companies/${ACME.id}/admins`]: () => jsonResponse(makeCompanyAdmin({ id: 'new', full_name: 'Rami Saleh', email: 'rami@acme.example', must_change_password: true }), 201),
    })
    await screen.findByRole('heading', { level: 1, name: 'Acme' })
    await user.click(screen.getByRole('button', { name: add }))
    const dialog = await screen.findByRole('dialog', { name: add })
    await user.type(within(dialog).getByLabelText(fullName), 'Rami Saleh')
    await user.type(within(dialog).getByLabelText(email), 'rami@acme.example')
    await user.click(within(dialog).getByRole('button', { name: generate }))
    await user.click(within(dialog).getAllByRole('button').at(-1)!)

    const created = await screen.findByRole('dialog', { name: added })
    expect(within(created).getByText(later).closest('[role="status"]')).not.toBeNull()
    expect(created).not.toHaveTextContent(now)
  })

  it('says how long to wait when adding administrators is limited, and the server’s words when it does not say', async () => {
    let retryAfter: string | null = '61'
    const { user } = setupCompanyPage(NOVA, {
      [`POST /platform/companies/${NOVA.id}/admins`]: () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', details: {} }, request_id: 'r' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
        }),
    })
    await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })
    await user.click(screen.getByRole('button', { name: 'Add administrator' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add administrator' })
    await user.type(within(dialog).getByLabelText('Full name'), 'Rami Saleh')
    await user.type(within(dialog).getByLabelText('Email'), 'rami@nova.example')
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add administrator' }))
    // 61 seconds: rounded up, never promised short.
    expect(await within(dialog).findByText('Too many attempts. Try again in 2 minutes.')).toBeInTheDocument()
    retryAfter = null
    await user.click(within(dialog).getByRole('button', { name: 'Add administrator' }))
    expect(await within(dialog).findByText('Too many requests. Please wait and try again.')).toBeInTheDocument()
  })

  it('says when the company does not exist', async () => {
    mockApi({ ...platformRoutes(), 'GET /platform/companies/9b000000-0000-4000-8000-0000000000ff': () => errorResponse(404, 'NOT_FOUND', 'Not found') })
    renderRoutes(routes, { initialEntries: ['/platform/companies/9b000000-0000-4000-8000-0000000000ff'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Company not found' })).toBeInTheDocument()
  })
})

describe('the platform’s audit log', () => {
  it('lists the events with the company they concern, filtered by event and company', async () => {
    const { requests } = mockApi({
      ...platformRoutes(),
      'GET /platform/audit-logs': () =>
        jsonResponse(
          page(
            [
              makePlatformAuditLog(),
              makePlatformAuditLog({ id: 'x2', seq: 6, action: 'PLATFORM_ADMIN_CREATED', actor: null, company: null, entity_type: 'platform_admin', metadata: { source: 'cli' } }),
            ],
            { page_size: 50 },
          ),
        ),
      [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(NOVA),
    })
    const { user } = renderRoutes(routes, { initialEntries: [`/platform/audit?company=${NOVA.id}`] })

    const list = await screen.findByRole('list', { name: 'Platform audit events, newest first' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Company deactivated')
    expect(within(items[0]!).getByRole('link', { name: 'Nova Labs' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}`)
    expect(items[1]).toHaveTextContent('Platform account created')
    expect(items[1]).toHaveTextContent('Command line')
    expect(await screen.findByText('Company: Nova Labs')).toBeInTheDocument()
    expect(auditQueries(requests).at(-1)).toMatchObject({ company_id: NOVA.id, page_size: '50' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Event' }), 'COMPANY_CREATED')
    await waitFor(() => expect(auditQueries(requests).at(-1)).toMatchObject({ action: 'COMPANY_CREATED' }))
    await user.click(screen.getByRole('button', { name: 'All companies' }))
    await waitFor(() => expect(auditQueries(requests).at(-1)).not.toHaveProperty('company_id'))
  })

  it('opens an event’s details', async () => {
    mockApi({ ...platformRoutes(), 'GET /platform/audit-logs': () => jsonResponse(page([makePlatformAuditLog()], { page_size: 50 })) })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/audit'] })
    await user.click(await screen.findByRole('button', { name: /Details: Company deactivated/ }))
    expect(await screen.findByText('Reset links invalidated')).toBeInTheDocument()
    expect(screen.getByText('req-9d')).toBeInTheDocument()
    // The raw JSON reads left to right in either language and is not a scroll box of its own (UX review M7).
    const raw = document.querySelector('[data-audit-raw]')!
    expect(raw).toHaveAttribute('dir', 'ltr')
    expect(raw.className).not.toMatch(/overflow-(?:auto|y-auto|scroll)|max-h-/)
    expect(raw).toHaveTextContent('"revoked_sessions": 3')
  })

  it('says which administrator a row is about, asking only the companies whose rows concern a user (UX review L12)', async () => {
    const OTHER = '9b000000-0000-4000-8000-000000000009'
    const { requests } = mockApi({
      ...platformRoutes(),
      'GET /platform/audit-logs': () =>
        jsonResponse(
          page(
            [
              makePlatformAuditLog({ id: 'u1', seq: 9, action: 'USER_CREATED', entity_type: 'user', entity_id: makeCompanyAdmin().id, metadata: {} }),
              makePlatformAuditLog({ id: 'u2', seq: 8, action: 'AUTH_PASSWORD_RESET_REQUESTED', entity_type: 'user', entity_id: makeCompanyAdmin().id, metadata: {} }),
              // An administrator the company no longer lists: the row keeps the kind of record.
              makePlatformAuditLog({ id: 'u3', seq: 7, action: 'USER_CREATED', entity_type: 'user', entity_id: '9c000000-0000-4000-8000-0000000000ee', metadata: {} }),
              // A row about a company itself: its administrators are not asked for.
              makePlatformAuditLog({ id: 'c1', seq: 6, action: 'COMPANY_CREATED', company: { id: OTHER, name: 'Other Co', name_ar: null }, entity_id: OTHER, metadata: {} }),
            ],
            { page_size: 50 },
          ),
        ),
      [`GET /platform/companies/${NOVA.id}/admins`]: () => jsonResponse([makeCompanyAdmin({ full_name: 'نادية حداد' })]),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/audit'] })

    const list = await screen.findByRole('list', { name: 'Platform audit events, newest first' })
    const [created, reset, unknown, company] = within(list).getAllByRole('listitem')
    await waitFor(() => expect(created).toHaveTextContent('User: نادية حداد'))
    expect(reset).toHaveTextContent('User: نادية حداد')
    // The name is isolated: an Arabic name keeps its place in the English line.
    expect(within(created!).getByText('نادية حداد').tagName).toBe('BDI')
    expect(unknown!.querySelector('[data-audit-concerns]')).toHaveTextContent(/^User$/)
    expect(company!.querySelector('[data-audit-concerns]')).toHaveTextContent(/^Company$/)
    // One request for the one company with rows about a user, none for the other.
    expect(requests.filter((request) => request.path.endsWith('/admins')).map((request) => request.path)).toEqual([`/platform/companies/${NOVA.id}/admins`])

    // The details say the name over the ID.
    await user.click(within(created!).getByRole('button', { name: /Details: User created/ }))
    const record = await within(created!).findByText('Record')
    expect(record.parentElement).toHaveTextContent('Userنادية حداد9c000000-0000-4000-8000-000000000001')
  })

  it('offers the trail’s nineteen events as its filter, and words the refusals of the final contract and a change of identity', async () => {
    mockApi({
      ...platformRoutes(),
      'GET /platform/audit-logs': () =>
        jsonResponse(
          page(
            [
              // An address that cannot be used, when the platform owner creates an account (B11-42).
              makePlatformAuditLog({ id: 'r1', seq: 9, action: 'USER_CHANGE_REFUSED', entity_type: null, entity_id: null, metadata: { code: 'USER_EMAIL_UNAVAILABLE', operation: 'create' } }),
              makePlatformAuditLog({ id: 'r2', seq: 8, action: 'RATE_LIMITED', company: null, entity_type: null, entity_id: null, metadata: { policy: 'user_email_refusals_per_user', route: '/api/v1/platform/companies', method: 'POST' } }),
              makePlatformAuditLog({ id: 'r3', seq: 7, action: 'ACCESS_DENIED', actor: null, company: null, entity_type: null, entity_id: null, metadata: { reason: 'session_ended' } }),
              makePlatformAuditLog({ id: 'r4', seq: 6, action: 'RATE_LIMITED', actor: null, company: null, entity_type: null, entity_id: null, metadata: { policy: 'login_failures_device' } }),
              makePlatformAuditLog({ id: 'r5', seq: 5, action: 'AUTH_LOGIN_FAILED', actor: null, company: null, entity_type: 'platform_admin', metadata: { reason: 'seed_account' } }),
              makePlatformAuditLog({ id: 'r6', seq: 4, action: 'PLATFORM_ADMIN_CREATED', actor: null, company: null, entity_type: 'platform_admin', metadata: { source: 'seed' } }),
              // A company's logo removed by the platform owner (Phase 12): which part of the identity, never the picture.
              makePlatformAuditLog({ id: 'r7', seq: 3, action: 'COMPANY_BRAND_UPDATED', metadata: { changed_fields: ['logo_dark'], removed_fields: ['logo_dark'] } }),
            ],
            { page_size: 50 },
          ),
        ),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/audit'] })
    const list = await screen.findByRole('list', { name: 'Platform audit events, newest first' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('User change refused')
    expect(within(items[0]!).getByText('User email unavailable')).toBeInTheDocument()
    expect(within(items[1]!).getByText('Refused account email addresses (user)')).toBeInTheDocument()
    expect(items[2]).toHaveTextContent('Access denied')
    expect(within(items[2]!).getByText('Session ended')).toBeInTheDocument()
    expect(within(items[3]!).getByText('Failed sign-ins (device)')).toBeInTheDocument()
    expect(within(items[4]!).getByText('Demo account')).toBeInTheDocument()
    // A row a seed wrote names the seed, not "System".
    expect(items[5]).toHaveTextContent('Demo data seed')
    expect(items[5]).not.toHaveTextContent('System or anonymous')
    expect(items[6]).toHaveTextContent('Company identity updated')
    // Its details say which part of the identity, in words.
    await user.click(within(items[6]!).getByRole('button', { name: /Details: Company identity updated/ }))
    expect(await within(items[6]!).findByText('Removed fields')).toBeInTheDocument()
    expect(within(items[6]!).getAllByText('Logo for dark surfaces')).toHaveLength(2)

    const options = within(screen.getByRole('combobox', { name: 'Event' })).getAllByRole('option').map((option) => option.textContent)
    expect(options).toHaveLength(20)
    expect(options).toEqual(expect.arrayContaining(['All events', 'User change refused', 'Access denied', 'Too many requests', 'User created', 'Company identity updated']))
    expect(new Set(options).size).toBe(20)
  })

  it('keeps its rows stacked until there is room for the company column, which a company’s own log does not have (UX review H1)', async () => {
    mockApi({ ...platformRoutes(), 'GET /platform/audit-logs': () => jsonResponse(page([makePlatformAuditLog()], { page_size: 50 })) })
    renderRoutes(routes, { initialEntries: ['/platform/audit'] })
    const list = await screen.findByRole('list', { name: 'Platform audit events, newest first' })
    const row = list.querySelector('[data-audit-row]')!
    // Five columns only from `xl`: the event at least 12rem, the company and the actor sharing the rest.
    expect(row.className).toContain('xl:grid-cols-[12rem_minmax(12rem,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7.5rem]')
    expect(row.className).not.toMatch(/\bmd:grid-cols-/)
    for (const cell of row.querySelectorAll('[data-audit-cell]')) expect(cell.className).not.toMatch(/\bmd:(?:col-start|row-start|col-span)-/)
    const header = list.parentElement!.querySelector('[data-audit-header]')!
    expect(header).toHaveClass('hidden', 'xl:grid')
    expect(header).not.toHaveClass('md:grid')
    expect([...header.children].map((cell) => cell.textContent)).toEqual(['Time', 'Event', 'Company', 'By', ''])
    // Touch targets: the chip's button and a row's company link (UX review L1; measured in e2e/phase11-review.spec.ts).
    expect(within(row as HTMLElement).getByRole('link', { name: 'Nova Labs' }).className).toContain('pointer-coarse:py-3')
  })
})

describe('errors', () => {
  it('shows a company list that could not be loaded, with Try again', async () => {
    mockApi({ 'GET /platform/auth/me': () => jsonResponse(makePlatformMe()), 'GET /platform/companies': () => errorResponse(500, 'INTERNAL_ERROR', 'Boom') })
    renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    expect(await findAlert('The companies could not be loaded.')).toBeInTheDocument()
  })
})
