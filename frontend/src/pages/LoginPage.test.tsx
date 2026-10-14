import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { receptionRoutes } from '../features/reception/testing/receptionFixtures'
import { i18n } from '../i18n'
import { reportsRoutes } from '../features/reports/testRoutes'
import { routes } from '../test/appRoutes'
import { deferred, errorResponse, jsonResponse, makeMe, mockApi, NOT_AUTHENTICATED } from '../test/api'
import { myVisitsRoutes, visitorsRoutes } from '../test/fixtures'
import { findAlert, renderRoutes } from '../test/render'

async function fillAndSubmit(user: ReturnType<typeof renderRoutes>['user'], email: string, password: string) {
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('LoginPage', () => {
  it('is neutral without a company: the form under the page’s own mark, no logo, no name, no notes, no small print', async () => {
    const { requests } = mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    const { container } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })

    // Phase 12: the general sign-in page names nobody, neither a company nor the product.
    await waitFor(() => expect(document.title).toBe('Sign in'))
    expect(container.querySelector('[data-brand-lockup], [data-brand-logo], [data-identity-lockup], [data-company-wordmark]')).toBeNull()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container).not.toHaveTextContent('Mawdoo3')
    // Where a logo would stand: direction C's dark tile with the page's symbol, decorative.
    const mark = container.querySelector('[data-neutral-mark]')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveClass('bg-emphasis', 'text-highlight')
    // It asks the server who is signed in, and nothing about any company.
    expect(requests.map((request) => request.path)).toEqual(['/auth/me'])
    // Decision 3 of the brand pass: no description under the title, no legal footer.
    expect(screen.queryByRole('contentinfo')).toBeNull()
    expect(screen.queryByText(/authorised users/)).toBeNull()
    expect(screen.queryByText('Use your work email address and password.')).toBeNull()
  })

  it('shows the server error message, with focus still on the button after the request', async () => {
    const pending = deferred<Response>()
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => pending.promise,
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, 'lina.haddad@example.com', 'not-the-password')
    expect(await screen.findByRole('button', { name: 'Signing in…' })).toHaveFocus()
    pending.resolve(errorResponse(401, 'INVALID_CREDENTIALS', 'Invalid email or password.'))

    expect(await findAlert('Invalid email or password.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    // Focus survived the pending state, so the user can retry from the keyboard.
    const button = screen.getByRole('button', { name: 'Sign in' })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).toHaveFocus()
  })

  it('puts server field messages on the field and focuses it', async () => {
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { email: 'Enter at most 320 characters.' },
        }),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, 'lina.haddad@example.com', 'whatever')

    const email = await screen.findByLabelText('Email', { selector: '[aria-invalid="true"]' })
    expect(email).toHaveAccessibleDescription('Enter at most 320 characters.')
    expect(email).toHaveFocus()
    expect(screen.queryByText('Please correct the highlighted fields.')).toBeNull()
  })

  it.each([
    ['en', 'Sign in', 'Email', 'Password', 'This company is deactivated.'],
    ['ar', 'تسجيل الدخول', 'البريد الإلكتروني', 'كلمة المرور', 'هذه الشركة معطّلة.'],
  ] as const)('says that the company is deactivated, in the form’s error area, and stays usable (%s)', async (language, title, emailLabel, passwordLabel, message) => {
    // 409 COMPANY_INACTIVE: the credentials were right and the deactivation is the only obstacle (B11-46).
    let deactivated = true
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => (deactivated ? errorResponse(409, 'COMPANY_INACTIVE', 'This company is deactivated.') : jsonResponse(makeMe(['EMPLOYEE']))),
      ...myVisitsRoutes(),
    })
    await i18n.changeLanguage(language)
    const { user, router } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: title })
    await user.type(screen.getByLabelText(emailLabel), 'lina.haddad@example.com')
    await user.type(screen.getByLabelText(passwordLabel), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: title }))

    // The code's own message, as the form's error: not a field's, and not the wording of wrong credentials or a lockout.
    expect(await findAlert(message)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(screen.getByLabelText(emailLabel)).not.toHaveAttribute('aria-invalid')
    expect(screen.getByLabelText(passwordLabel)).not.toHaveAttribute('aria-invalid')
    expect(document.body.textContent).not.toMatch(/Invalid email or password|Too many|غير صحيحة|طلبات كثيرة/)
    // The form is as it was: the same values, the button enabled; signing in works once the company is reactivated.
    expect(screen.getByLabelText(emailLabel)).toHaveValue('lina.haddad@example.com')
    expect(screen.getByLabelText(passwordLabel)).toHaveValue('correct horse battery staple')
    const button = screen.getByRole('button', { name: title })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-disabled')
    deactivated = false
    await user.click(button)
    await waitFor(() => expect(router.state.location.pathname).toBe('/visits'))
    await i18n.changeLanguage('en')
  })

  it('shows rate-limit messages from the server as-is', async () => {
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => errorResponse(429, 'RATE_LIMITED', 'Too many attempts. Try again later.'),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, 'lina.haddad@example.com', 'whatever')

    expect(await findAlert('Too many attempts. Try again later.')).toBeInTheDocument()
  })

  it('marks the focused button busy while signing in, then continues to the landing page', async () => {
    const pending = deferred<Response>()
    const { requests } = mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => pending.promise,
      ...myVisitsRoutes(),
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, '  Lina.Haddad@example.com ', 'correct horse battery staple')

    const button = await screen.findByRole('button', { name: 'Signing in…' })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveFocus()
    // A second Enter while the first sign-in runs sends nothing.
    await user.keyboard('{Enter}')
    await user.click(screen.getByLabelText('Password'))
    await user.keyboard('{Enter}')
    expect(requests.filter((request) => request.path === '/auth/login')).toHaveLength(1)
    expect(requests.find((request) => request.path === '/auth/login')?.body).toEqual({
      email: 'Lina.Haddad@example.com',
      password: 'correct horse battery staple',
    })

    pending.resolve(jsonResponse(makeMe(['EMPLOYEE'])))

    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
  })

  it('validates required fields before sending anything', async () => {
    const { requests } = mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const email = screen.getByLabelText('Email')
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAccessibleDescription('Enter your email address.')
    expect(email).toHaveFocus()
    expect(requests.some((request) => request.path === '/auth/login')).toBe(false)
  })

  it('focuses the password when only the password is missing', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await user.type(screen.getByLabelText('Email'), 'lina.haddad@example.com')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByLabelText('Password')).toHaveFocus()
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
  })

  it('continues to a safe next page after sign-in, without private parameters', async () => {
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => jsonResponse(makeMe(['EMPLOYEE'])),
      ...visitorsRoutes(),
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/login?next=%2Fvisitors%3Fpage%3D2%26q%3Dmartin'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, 'lina.haddad@example.com', 'correct horse battery staple')

    expect(await screen.findByRole('heading', { level: 1, name: 'Visitors' })).toBeInTheDocument()
    // A search text in `next` (a crafted or old link) is dropped: it never goes into an address.
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe('/visitors?page=2')
  })

  it('ignores an off-site next parameter', async () => {
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => jsonResponse(makeMe(['MANAGEMENT'])),
      ...reportsRoutes(),
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/login?next=%2F%2Fevil.example.com%2Fphish'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, 'lina.haddad@example.com', 'correct horse battery staple')

    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reports')
  })

  it('ignores a next parameter whose dot segments normalise to a protocol-relative path', async () => {
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'POST /auth/login': () => jsonResponse(makeMe(['MANAGEMENT'])),
      ...reportsRoutes(),
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/login?next=%2F.%2F%2Fevil.example.com'] })
    await screen.findByRole('heading', { name: 'Sign in' })

    await fillAndSubmit(user, 'lina.haddad@example.com', 'correct horse battery staple')

    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reports')
    expect(screen.queryByText('Something went wrong')).toBeNull()
  })

  it('redirects an already signed-in user away from the login page', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['RECEPTIONIST'])), ...receptionRoutes() })
    const { router } = renderRoutes(routes, { initialEntries: ['/login'] })

    await screen.findByRole('heading', { level: 1, name: 'Reception' })
    expect(router.state.location.pathname).toBe('/reception')
  })
})
