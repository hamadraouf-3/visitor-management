import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { adminDashboardRoutes } from '../../features/admin/testRoutes'
import { LANGUAGE_STORAGE_KEY } from '../../i18n'
import { errorResponse, jsonResponse, makeMe, mockApi, NOT_AUTHENTICATED } from '../../test/api'
import { routes } from '../../test/appRoutes'
import { renderRoutes } from '../../test/render'
import type { Me } from '../../types/api'

function arabicMe(): Me {
  const me = makeMe(['SYSTEM_ADMIN'])
  return { ...me, user: { ...me.user, preferred_language: 'ar' }, company: { ...me.company, name: 'Mawdoo3', name_ar: 'موضوع' } }
}

describe('LanguageSwitcher', () => {
  it('switches the sign-in page to Arabic, right to left, and remembers it on the device', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED })
    const { user } = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(document.documentElement).toHaveAttribute('dir', 'ltr')

    // The switch names the other language in its own script.
    const toArabic = screen.getByRole('button', { name: 'العربية' })
    expect(toArabic).toHaveAttribute('lang', 'ar')
    await user.click(toArabic)

    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    expect(document.documentElement).toHaveAttribute('lang', 'ar')
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar')
    // The title follows the language. The page is neutral (Phase 12): it names nobody, in either language.
    await waitFor(() => expect(document.title).toBe('تسجيل الدخول'))
    expect(screen.queryByText('زوار موضوع')).toBeNull()
    const toEnglish = screen.getByRole('button', { name: 'English' })
    expect(toEnglish).toHaveFocus()

    await user.click(toEnglish)
    expect(document.documentElement).toHaveAttribute('dir', 'ltr')
    await waitFor(() => expect(document.title).toBe('Sign in'))
    expect(screen.queryByText('Mawdoo3 Visitors')).toBeNull()
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
  })

  it('saves the choice to the account when signed in, and the shell follows', async () => {
    const { requests } = mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
      'PATCH /auth/preferences': () => jsonResponse(arabicMe()),
      ...adminDashboardRoutes(),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    await user.click(screen.getByRole('button', { name: 'العربية' }))

    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ language: 'ar' })
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    // The company's Arabic name heads the shell (its wordmark: it has no logo); the navigation and the account menu in Arabic.
    await waitFor(() => expect(document.querySelector('[data-company-wordmark]')).toHaveTextContent('موضوع'))
    expect(screen.queryByText('زوار موضوع')).toBeNull()
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' })
    expect(within(nav).getByRole('link', { name: 'لوحة التحكم' })).toBeInTheDocument()
    expect(within(nav).getByRole('heading', { name: 'الإدارة' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'قائمة الحساب: Lina Haddad' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'English' })).toHaveFocus()
  })

  it('goes back to the previous language and says so when the choice cannot be saved', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
      'PATCH /auth/preferences': () => errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.'),
      ...adminDashboardRoutes(),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    await user.click(screen.getByRole('button', { name: 'العربية' }))

    const alert = await screen.findByText('Could not save your language')
    expect(alert.closest('[role="alert"]')).toHaveTextContent('The service is busy. Please try again.')
    expect(document.documentElement).toHaveAttribute('dir', 'ltr')
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument()
  })

  it('can be used on the forced password change screen', async () => {
    const forced = makeMe(['EMPLOYEE'], { must_change_password: true })
    const { requests } = mockApi({
      'GET /auth/me': () => jsonResponse(forced),
      'PATCH /auth/preferences': () => jsonResponse({ ...forced, user: { ...forced.user, preferred_language: 'ar' } }),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await user.click(screen.getByRole('button', { name: 'العربية' }))

    expect(requests.some((request) => request.method === 'PATCH' && request.path === '/auth/preferences')).toBe(true)
    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'ar'))
  })
})

describe('LanguageController', () => {
  it("shows the shell in the signed-in user's language: their preference over the company's default", async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(arabicMe()), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })

    const nav = await screen.findByRole('navigation', { name: 'التنقل الرئيسي' })
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'الاستقبال',
      'زياراتي',
      'دعوة زائر',
      'الزوار',
      'داخل المبنى الآن',
      'سجل الزيارات',
      'التقارير',
      'لوحة التحكم',
      'المستخدمون',
      'الأقسام',
      'إعدادات الشركة',
      'نصوص الرسائل',
      'سجل التدقيق',
    ])
    expect(document.querySelector('[data-company-wordmark]')).toHaveTextContent('موضوع')
    // No time-zone line in the shell any more (brand pass, decision 3).
    expect(screen.queryByText('توقيت عمّان (UTC+3)')).toBeNull()
    expect(screen.getByRole('link', { name: 'انتقل إلى المحتوى الرئيسي' })).toBeInTheDocument()
  })

  it("follows the company's default language when the user has no preference", async () => {
    const me = makeMe(['SYSTEM_ADMIN'])
    mockApi({ 'GET /auth/me': () => jsonResponse({ ...me, company: { ...me.company, default_language: 'ar' } }), ...adminDashboardRoutes() })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })

    await screen.findByRole('navigation', { name: 'التنقل الرئيسي' })
    expect(document.documentElement).toHaveAttribute('lang', 'ar')
    // No Arabic company name: the English one is shown (in the account menu's header).
    await user.click(screen.getByRole('button', { name: 'قائمة الحساب: Lina Haddad' }))
    expect(document.querySelector('[data-user-company]')).toHaveTextContent('Acme Holdings')
  })
})
