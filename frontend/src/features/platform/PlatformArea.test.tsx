import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../../api/queryKeys'
import { platformAuthSync, subscribeToAuthChanges, type AuthChange } from '../../auth/authSync'
import { endSession } from '../../auth/session'
import { safeNextPath } from '../../auth/redirect'
import { i18n } from '../../i18n'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, NOT_AUTHENTICATED, noContent } from '../../test/api'
import { createTestQueryClient, renderRoutes } from '../../test/render'
import type { PlatformMe } from '../../types/api'
import { endPlatformSession } from './platformSession'
import { makePlatformCompany, makePlatformMe, platformRoutes } from './testRoutes'

/*
 * The platform owner's area (Phase 11): another principal with its own session, guard, shell and
 * language preference. A company session never opens it and is never touched by it.
 */

const PLATFORM_HEADING = { level: 1, name: 'Sign in to the platform' } as const

describe('the platform guard', () => {
  it('shows the platform sign-in to a company user: a company session does not count', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), 'GET /platform/auth/me': NOT_AUTHENTICATED })
    const { router } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })

    expect(await screen.findByRole('heading', PLATFORM_HEADING)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/platform/login')
    // No company shell, no company navigation.
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument()
    expect(screen.getByText('Platform')).toBeInTheDocument()
  })

  it('keeps the page it was asked for in `next`', async () => {
    mockApi({ 'GET /platform/auth/me': NOT_AUTHENTICATED })
    const { router } = renderRoutes(routes, { initialEntries: ['/platform/audit?action=COMPANY_CREATED'] })
    await screen.findByRole('heading', PLATFORM_HEADING)
    expect(router.state.location.search).toBe('?next=%2Fplatform%2Faudit%3Faction%3DCOMPANY_CREATED')
  })

  it('signs in and continues to `next`, with the platform shell and its two sections', async () => {
    const { requests } = mockApi({
      'GET /platform/auth/me': NOT_AUTHENTICATED,
      'POST /platform/auth/login': () => jsonResponse(makePlatformMe()),
      'GET /platform/audit-logs': () => jsonResponse({ items: [], page: 1, page_size: 50, total: 0 }),
    })
    const { router, user } = renderRoutes(routes, { initialEntries: ['/platform/login?next=%2Fplatform%2Faudit'] })
    await screen.findByRole('heading', PLATFORM_HEADING)
    await user.type(screen.getByLabelText('Email'), 'platform@demo.local')
    await user.type(screen.getByLabelText('Password'), 'Demo-Visitor-2026')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/platform/audit')
    expect(requests.find((request) => request.path === '/platform/auth/login')?.body).toEqual({ email: 'platform@demo.local', password: 'Demo-Visitor-2026' })
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Companies', 'Audit log'])
    expect(screen.getAllByText('Platform').length).toBeGreaterThan(0)
    // The company session is never asked who is signed in.
    expect(requests.some((request) => request.path === '/auth/me')).toBe(false)
  })

  it('refuses a wrong password with the server’s one answer', async () => {
    mockApi({
      'GET /platform/auth/me': NOT_AUTHENTICATED,
      'POST /platform/auth/login': () => errorResponse(401, 'INVALID_CREDENTIALS', 'Invalid email or password.'),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/login'] })
    await screen.findByRole('heading', PLATFORM_HEADING)
    await user.type(screen.getByLabelText('Email'), 'platform@demo.local')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument()
  })

  it('allows only the password change while one is required, then continues to the companies', async () => {
    let me: PlatformMe = makePlatformMe({ must_change_password: true })
    const { requests } = mockApi({
      ...platformRoutes(),
      'GET /platform/auth/me': () => jsonResponse(me),
      'POST /platform/auth/change-password': () => {
        me = makePlatformMe()
        return noContent()
      },
    })
    const { router, user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/platform/change-password')
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Current password'), 'Temporary-Pass-123')
    await user.type(screen.getByLabelText('New password'), 'A-much-better-pass-2026')
    await user.type(screen.getByLabelText('Confirm new password'), 'A-much-better-pass-2026')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Companies' })).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/platform/auth/change-password')?.body).toEqual({
      current_password: 'Temporary-Pass-123',
      new_password: 'A-much-better-pass-2026',
    })
  })

  it('goes to the forced change when the server says one is required', async () => {
    mockApi({
      'GET /platform/auth/me': () => jsonResponse(makePlatformMe()),
      'GET /platform/companies': () => errorResponse(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.'),
    })
    const { router } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/platform/change-password')
  })

  it('sends /platform to the companies', async () => {
    mockApi(platformRoutes())
    const { router } = renderRoutes(routes, { initialEntries: ['/platform'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Companies' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/platform/companies')
  })

  it('shows an unknown platform address inside the platform shell', async () => {
    mockApi(platformRoutes())
    renderRoutes(routes, { initialEntries: ['/platform/nothing-here'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Companies' })).toBeInTheDocument()
  })
})

describe('two principals in one browser', () => {
  it('ends only the platform session when a platform request answers 401, and keeps the company’s', async () => {
    const queryClient = createTestQueryClient()
    const companyMe = makeMe(['SYSTEM_ADMIN'])
    queryClient.setQueryData(queryKeys.me, companyMe)
    mockApi({ 'GET /platform/auth/me': () => jsonResponse(makePlatformMe()), 'GET /platform/companies': NOT_AUTHENTICATED })
    const { router } = renderRoutes(routes, { initialEntries: ['/platform/companies?status=active'], queryClient })

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(router.state.location.search).toBe('?next=%2Fplatform%2Fcompanies%3Fstatus%3Dactive')
    expect(queryClient.getQueryData(queryKeys.platform.me)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(companyMe)
  })

  it('a company sign-out or expiry leaves the platform cache alone, and the other way round', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.me, makeMe())
    queryClient.setQueryData(queryKeys.users.list(), { items: [] })
    queryClient.setQueryData(queryKeys.platform.me, makePlatformMe())
    queryClient.setQueryData(queryKeys.platform.companies.list(), { items: [] })

    endSession(queryClient)
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.users.list())).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.platform.me)).toEqual(makePlatformMe())
    expect(queryClient.getQueryData(queryKeys.platform.companies.list())).toEqual({ items: [] })

    queryClient.setQueryData(queryKeys.me, makeMe())
    endPlatformSession(queryClient)
    expect(queryClient.getQueryData(queryKeys.platform.me)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.platform.companies.list())).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(makeMe())
  })

  it('never sends a company sign-in to a platform page', () => {
    expect(safeNextPath('/platform/companies', 'http://localhost')).toBeNull()
    expect(safeNextPath('/platform', 'http://localhost')).toBeNull()
    expect(safeNextPath('/platformer', 'http://localhost')).toBe('/platformer')
  })

  it('signs out of the platform only', async () => {
    const queryClient = createTestQueryClient()
    const companyMe = makeMe(['EMPLOYEE'])
    queryClient.setQueryData(queryKeys.me, companyMe)
    const { requests } = mockApi({ ...platformRoutes(), 'POST /platform/auth/logout': () => noContent() })
    const { router, user } = renderRoutes(routes, { initialEntries: ['/platform/companies'], queryClient })
    await screen.findByRole('heading', { level: 1, name: 'Companies' })

    await user.click(screen.getAllByRole('button', { name: 'Account menu for Platform Owner' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
    expect(requests.some((request) => request.path === '/auth/logout')).toBe(false)
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(companyMe)
  })
})

describe('the platform shell', () => {
  it('has a shell theme of its own, which differs from a company’s in the dark colour scheme too (UX review L10)', async () => {
    mockApi(platformRoutes())
    const { container } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    await screen.findByRole('heading', { level: 1, name: 'Companies' })
    // The top bar (or the sidebar on a desktop) and the navigation drawer: never the companies' `theme-shell`,
    // nor the bare deep teal, which is what `theme-shell` becomes in the dark scheme (designTokens.test.ts).
    const shells = container.querySelectorAll('header[data-app-bar], aside')
    expect(shells.length).toBeGreaterThan(0)
    for (const shell of shells) {
      expect(shell).toHaveClass('theme-shell-platform')
      expect(shell).not.toHaveClass('theme-shell')
      expect(shell).not.toHaveClass('theme-shell-deep')
    }
  })

  it('names the account and its role in the account menu', async () => {
    mockApi(platformRoutes())
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    await screen.findByRole('heading', { level: 1, name: 'Companies' })
    await user.click(screen.getAllByRole('button', { name: 'Account menu for Platform Owner' })[0]!)
    const menu = await screen.findByRole('menu')
    const header = menu.parentElement!
    expect(within(header).getByText('platform@demo.local')).toBeInTheDocument()
    // "Platform Owner" (the name) and "Platform owner" (the role) are the same words: said once.
    expect(header.querySelector('[data-account-role]')).toBeNull()
    expect(within(header).getAllByText(/platform owner/i)).toHaveLength(1)
  })

  it.each([
    ['مالك المنصة', 'ar', 'قائمة الحساب: مالك المنصة'],
    ['مالك المنصة', 'en', 'Account menu for مالك المنصة'],
  ] as const)('does not repeat the role under an account named «%s», whatever the UI language (%s) (UX review L11)', async (name, language, menuName) => {
    mockApi(platformRoutes({ me: makePlatformMe({ full_name: name, preferred_language: language }) }))
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    await screen.findByRole('heading', { level: 1, name: language === 'ar' ? 'الشركات' : 'Companies' })
    await user.click(screen.getAllByRole('button', { name: menuName })[0]!)
    const header = (await screen.findByRole('menu')).parentElement!
    expect(within(header).getAllByText('مالك المنصة')).toHaveLength(1)
    expect(header.querySelector('[data-account-role]')).toBeNull()
    expect(within(header).getByText('platform@demo.local')).toBeInTheDocument()
  })

  it('says the role under an account with a name of its own', async () => {
    mockApi(platformRoutes({ me: makePlatformMe({ full_name: 'Huda Mansour' }) }))
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    await screen.findByRole('heading', { level: 1, name: 'Companies' })
    await user.click(screen.getAllByRole('button', { name: 'Account menu for Huda Mansour' })[0]!)
    const header = (await screen.findByRole('menu')).parentElement!
    expect(header.querySelector('[data-account-role]')).toHaveTextContent('Platform owner')
  })
})

describe('the platform pages’ language', () => {
  it('follows the platform account’s preference and saves a switch to it, not to a company account', async () => {
    const saved: unknown[] = []
    mockApi({
      ...platformRoutes({ me: makePlatformMe({ preferred_language: 'ar' }) }),
      'PATCH /platform/auth/preferences': (request) => {
        saved.push(request.body)
        return jsonResponse(makePlatformMe({ preferred_language: 'en' }))
      },
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/companies'] })

    expect(await screen.findByRole('heading', { level: 1, name: 'الشركات' })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
    // The company's Arabic name in the Arabic UI.
    expect(await screen.findByRole('link', { name: 'نوفا لابز' })).toBeInTheDocument()
    expect(screen.getAllByText('المنصة').length).toBeGreaterThan(0)

    await user.click(screen.getAllByRole('button', { name: 'English' })[0]!)
    expect(await screen.findByRole('heading', { level: 1, name: 'Companies' })).toBeInTheDocument()
    expect(saved).toEqual([{ language: 'en' }])
    expect(i18n.language).toBe('en')
  })

  it('keeps a language picked on the platform sign-in page and saves it at sign-in', async () => {
    const saved: unknown[] = []
    mockApi({
      'GET /platform/auth/me': NOT_AUTHENTICATED,
      'POST /platform/auth/login': () => jsonResponse(makePlatformMe()),
      'GET /platform/companies': () => jsonResponse({ items: [makePlatformCompany()], page: 1, page_size: 25, total: 1 }),
      'PATCH /platform/auth/preferences': (request) => {
        saved.push(request.body)
        return jsonResponse(makePlatformMe({ preferred_language: 'ar' }))
      },
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/platform/login'] })
    await screen.findByRole('heading', PLATFORM_HEADING)
    await user.click(screen.getByRole('button', { name: 'العربية' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول إلى المنصة' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'platform@demo.local')
    await user.type(screen.getByLabelText('كلمة المرور'), 'Demo-Visitor-2026')
    await user.click(screen.getByRole('button', { name: 'تسجيل الدخول' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'الشركات' })).toBeInTheDocument()
    await waitFor(() => expect(saved).toEqual([{ language: 'ar' }]))
  })
})

describe('the realms’ messages between tabs', () => {
  it('tells a platform sign-out to the platform’s listeners only', async () => {
    const company = vi.fn<(change: AuthChange) => void>()
    const platform = vi.fn<(change: AuthChange) => void>()
    const stopCompany = subscribeToAuthChanges(company)
    const stopPlatform = platformAuthSync.subscribe(platform)
    try {
      // Another tab: a channel of its own.
      const otherTab = new BroadcastChannel('vms-platform-auth')
      // A channel is same-origin by definition: postMessage has no target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      otherTab.postMessage('signed-out')
      otherTab.close()
      await waitFor(() => expect(platform).toHaveBeenCalledWith('signed-out'))
      expect(company).not.toHaveBeenCalled()
    } finally {
      stopCompany()
      stopPlatform()
    }
  })
})
