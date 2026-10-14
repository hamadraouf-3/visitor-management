import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { adminDashboardRoutes } from '../features/admin/testRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, NOT_AUTHENTICATED } from '../test/api'
import { routes } from '../test/appRoutes'
import { renderRoutes } from '../test/render'
import type { Me } from '../types/api'
import { i18n, LANGUAGE_STORAGE_KEY } from './index'
import { LANGUAGE_CHOSEN_KEY } from './languages'

/*
 * The screens an Arabic-speaking person meets first are Arabic from top to bottom (phase 10
 * review: the sign-in, reset, forced-change and 404 pages were mostly English inside the right-to-
 * left layout). Every test starts the UI in Arabic, as an `ar-*` browser does before sign-in.
 */

/** Visible words of the page outside the language switch (which names the other language on purpose). */
function latinWordsOutsideSwitch(): string[] {
  const clone = document.body.cloneNode(true) as HTMLElement
  for (const node of clone.querySelectorAll('[data-language-switch], .sr-only, [aria-hidden="true"], input, textarea')) node.remove()
  return clone.textContent?.match(/[A-Za-z]{3,}/g) ?? []
}

function arabicMe(roles: Me['user']['roles'], overrides: Partial<Me['user']> = {}): Me {
  const me = makeMe(roles, overrides)
  return { ...me, user: { ...me.user, preferred_language: 'ar' }, company: { ...me.company, name: 'Mawdoo3', name_ar: 'موضوع' } }
}

describe('Arabic sign-in and account pages', () => {
  it('shows the sign-in page in Arabic only, right to left', async () => {
    await i18n.changeLanguage('ar')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    renderRoutes(routes, { initialEntries: ['/login'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    await waitFor(() => expect(document.title).toBe('تسجيل الدخول'))
    // The neutral page (Phase 12): no logo and no name, only the page's own mark; no note under the title (brand pass, decision 3).
    expect(screen.queryByText('زوار موضوع')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-neutral-mark]')).not.toBeNull()
    expect(screen.queryByText('استخدم بريد العمل الإلكتروني وكلمة المرور.')).toBeNull()
    expect(screen.getByLabelText('البريد الإلكتروني')).toBeInTheDocument()
    expect(screen.getByLabelText('كلمة المرور')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'تسجيل الدخول' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'هل نسيت كلمة المرور؟' })).toBeInTheDocument()
    expect(latinWordsOutsideSwitch()).toEqual([])
  })

  it('validates the sign-in form in Arabic', async () => {
    await i18n.changeLanguage('ar')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })

    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'not-an-address')
    await user.click(screen.getByRole('button', { name: 'تسجيل الدخول' }))

    expect(screen.getByLabelText('البريد الإلكتروني')).toHaveAccessibleDescription('أدخل بريدًا إلكترونيًا صالحًا، مثل name@company.com.')
    expect(screen.getByLabelText('كلمة المرور')).toHaveAccessibleDescription('أدخل كلمة المرور.')
  })

  it('shows the password reset request in Arabic', async () => {
    await i18n.changeLanguage('ar')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    renderRoutes(routes, { initialEntries: ['/forgot-password'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'إعادة تعيين كلمة المرور' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('إعادة تعيين كلمة المرور'))
    expect(screen.getByRole('button', { name: 'إرسال رابط إعادة التعيين' })).toBeInTheDocument()
    expect(latinWordsOutsideSwitch()).toEqual([])
  })

  it('shows the page-not-found page in Arabic', async () => {
    await i18n.changeLanguage('ar')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    renderRoutes(routes, { initialEntries: ['/no-such-page'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'الصفحة غير موجودة' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('الصفحة غير موجودة'))
    expect(latinWordsOutsideSwitch()).toEqual([])
  })

  it('shows the forced password change in Arabic, the server’s field error included (by its code)', async () => {
    const forced = arabicMe(['EMPLOYEE'], { must_change_password: true })
    mockApi({
      'GET /auth/me': () => jsonResponse(forced),
      'POST /auth/change-password': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { new_password: 'This password is too common. Choose a less predictable password.' },
          field_codes: { new_password: { code: 'password_common', params: {} } },
        }),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'تغيير كلمة المرور' })).toBeInTheDocument()
    expect(screen.getByText('اختر كلمة مرور جديدة للمتابعة')).toBeInTheDocument()
    expect(screen.getByText('متطلبات كلمة المرور')).toBeInTheDocument()
    expect(screen.getByText('يجب ألا تكون من كلمات المرور الشائعة.')).toBeInTheDocument()
    // The guidance list indents on the reading side.
    expect(screen.getByText('يجب ألا تكون من كلمات المرور الشائعة.').closest('ul')).toHaveClass('ps-6')

    await user.type(screen.getByLabelText('كلمة المرور الحالية'), 'old-password-123')
    await user.type(screen.getByLabelText('كلمة المرور الجديدة'), 'password1234567')
    await user.type(screen.getByLabelText('تأكيد كلمة المرور الجديدة'), 'password1234567')
    await user.click(screen.getByRole('button', { name: 'تغيير كلمة المرور' }))

    await waitFor(() =>
      expect(screen.getByLabelText('كلمة المرور الجديدة')).toHaveAccessibleDescription(
        expect.stringContaining('كلمة المرور هذه شائعة جدًا. اختر كلمة مرور يصعب توقّعها.'),
      ),
    )
    expect(document.body.textContent).not.toContain('This password is too common')
  })
})

describe('the language chosen before sign-in', () => {
  it('is kept and saved to an account without a preference of its own, instead of the company default', async () => {
    // An Arabic device; the company's default is Arabic too.
    await i18n.changeLanguage('ar')
    const me = makeMe(['SYSTEM_ADMIN'])
    const signedIn: Me = { ...me, company: { ...me.company, default_language: 'ar' } }
    let session: Me | null = null
    const { requests } = mockApi({
      'GET /auth/me': () => (session ? jsonResponse(session) : NOT_AUTHENTICATED()),
      'POST /auth/login': () => {
        session = signedIn
        return jsonResponse(signedIn)
      },
      'PATCH /auth/preferences': () => {
        session = { ...signedIn, user: { ...signedIn.user, preferred_language: 'en' } }
        return jsonResponse(session)
      },
      ...adminDashboardRoutes(),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })

    // The person picks English on the sign-in page, then signs in.
    await user.click(screen.getByRole('button', { name: 'English' }))
    expect(window.sessionStorage.getItem(LANGUAGE_CHOSEN_KEY)).toBe('1')
    await user.type(screen.getByLabelText('Email'), 'lina.haddad@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeInTheDocument()
    await waitFor(() => expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ language: 'en' }))
    expect(document.documentElement).toHaveAttribute('lang', 'en')
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
    // Used up: a later sign-in in this tab follows the account again.
    expect(window.sessionStorage.getItem(LANGUAGE_CHOSEN_KEY)).toBeNull()
  })

  it('gives way to an account’s own language, and is not carried to the next sign-in on the device', async () => {
    await i18n.changeLanguage('ar')
    const me = makeMe(['SYSTEM_ADMIN'])
    const withOwnLanguage: Me = { ...me, user: { ...me.user, preferred_language: 'ar' }, company: { ...me.company, default_language: 'ar' } }
    let session: Me | null = null
    const { requests } = mockApi({
      'GET /auth/me': () => (session ? jsonResponse(session) : NOT_AUTHENTICATED()),
      'POST /auth/login': () => {
        session = withOwnLanguage
        return jsonResponse(withOwnLanguage)
      },
      ...adminDashboardRoutes(),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })

    await user.click(screen.getByRole('button', { name: 'English' }))
    await user.type(screen.getByLabelText('Email'), 'lina.haddad@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // The account chose Arabic before: Arabic it is, and nothing is saved.
    expect(await screen.findByRole('heading', { level: 1, name: 'لوحة تحكم الإدارة' })).toBeInTheDocument()
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false)
    // The choice is used up all the same: the next person to sign in here is not given it.
    expect(window.sessionStorage.getItem(LANGUAGE_CHOSEN_KEY)).toBeNull()
  })

  it('without a choice on this visit, the company default applies and nothing is saved', async () => {
    await i18n.changeLanguage('en')
    const me = makeMe(['SYSTEM_ADMIN'])
    const signedIn: Me = { ...me, company: { ...me.company, default_language: 'ar' } }
    let session: Me | null = null
    const { requests } = mockApi({
      'GET /auth/me': () => (session ? jsonResponse(session) : NOT_AUTHENTICATED()),
      'POST /auth/login': () => {
        session = signedIn
        return jsonResponse(signedIn)
      },
      ...adminDashboardRoutes(),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })

    await user.type(screen.getByLabelText('Email'), 'lina.haddad@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'لوحة تحكم الإدارة' })).toBeInTheDocument()
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false)
  })
})

describe('the Arabic shell', () => {
  it('pins the sign-in page’s language switch to the window corner, not to a centred column', async () => {
    await i18n.changeLanguage('ar')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })

    // jsdom has no layout: the header spans the page (no max width) and ends at the inline end.
    const header = screen.getByRole('button', { name: 'English' }).closest('header')
    expect(header).toHaveAttribute('data-public-header')
    expect(header).toHaveClass('w-full', 'justify-end')
    expect(header?.className).not.toMatch(/max-w-/)
  })

  it('names the dashboard, its tiles and the latest activity in Arabic', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(arabicMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'لوحة تحكم الإدارة' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('لوحة تحكم الإدارة · موضوع'))
    const main = screen.getByRole('main')
    expect(await within(main).findByText('مباشر')).toBeInTheDocument()
    expect(await within(main).findByRole('heading', { name: 'الحسابات النشطة حسب الدور' })).toBeInTheDocument()
    expect(main.textContent).not.toMatch(/Visits|Inside now|Latest activity/)
  })
})
