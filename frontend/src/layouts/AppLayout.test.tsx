import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { RouteObject } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { chooseAppearance } from '../appearance/appearance'
import { RequireAuth } from '../auth/RequireAuth'
import { adminDashboardRoutes, auditLogRoutes } from '../features/admin/testRoutes'
import { navigation } from '../router'
import { routes } from '../test/appRoutes'
import { jsonResponse, makeMe, mockApi } from '../test/api'
import { makeBrand, SAMPLE_COLOURS } from '../test/palettes'
import { renderRoutes } from '../test/render'
import type { Me } from '../types/api'
import { AppLayout } from './AppLayout'
import { RootLayout } from './RootLayout'
import { DARK_SURFACE_HANDLE } from './shellSurface'

/** Tailwind's `lg`: the sidebar layout. Unstubbed after each test (vitest `unstubGlobals`). */
function stubDesktop() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 64rem)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** The phone and tablet top bar. */
function appBar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>('[data-app-bar]')
  if (!bar) throw new Error('No top bar')
  return bar
}

/** An administrator of a company with these files of an identity (Phase 12), and this colour. */
function meWithLogos(files: { logo?: boolean; logoDark?: boolean; color?: string }, roles: Parameters<typeof makeMe>[0] = ['SYSTEM_ADMIN']): Me {
  const me = makeMe(roles)
  return { ...me, company: { ...me.company, brand: makeBrand(me.company.slug, files) } }
}

describe('AppLayout', () => {
  it('names the company in the account menu, with the appearance, change password and sign out', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }))

    const menu = screen.getByRole('menu', { name: 'Account menu for Lina Haddad' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Change password', 'Sign out'])
    // The device's appearance first (Phase 13): a group of three choices, System chosen until the device chooses.
    const appearance = within(menu).getByRole('group', { name: 'Appearance' })
    expect(within(appearance).getAllByRole('menuitemradio').map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Light', 'false'],
      ['Dark', 'false'],
      ['System', 'true'],
    ])
    // The account summary is shown above the menu, outside role="menu": roles and the company.
    expect(screen.getByText('Administrator')).toBeVisible()
    expect(within(menu).queryByText('Administrator')).toBeNull()
    const company = document.querySelector('[data-user-company]')
    expect(company).toHaveTextContent('Acme Holdings')
    expect(menu).not.toContainElement(company as HTMLElement)
    expect(within(menu).getByRole('menuitemradio', { name: 'Light' })).toHaveFocus()

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Change password' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Account menu for Lina Haddad' })).toHaveFocus()
  })

  it('heads the top bar with the company’s identity, its name as a wordmark without a logo, and never the product’s', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    const { container } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    const bar = appBar()
    expect(bar).toHaveClass('theme-shell', 'bg-shell')
    const lockup = within(bar).getByText('Acme Holdings').closest('[data-identity-lockup]')
    expect(lockup).toHaveAttribute('data-identity-lockup', 'shell')
    // A company without a logo is its own name (Phase 12): no image, and nothing of the product.
    expect(within(bar).getByText('Acme Holdings')).toHaveAttribute('data-company-wordmark')
    expect(lockup?.querySelector('img')).toBeNull()
    expect(bar.querySelector('[data-brand-lockup], [data-brand-logo]')).toBeNull()
    expect(container).not.toHaveTextContent('Mawdoo3')
    // No time-zone chatter anywhere in the shell (brand pass, decision 3).
    expect(container).not.toHaveTextContent(/Amman time|UTC\+3/)
  })

  it('opens the navigation drawer on small screens, named by the company, and closes it after navigating', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes(), ...auditLogRoutes() })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const drawer = screen.getByRole('dialog', { name: 'Acme Holdings' })
    await user.click(within(drawer).getByRole('link', { name: 'Audit log' }))

    // The router commits the new page in a transition, so the layout's focus effect can run after
    // the heading is already in the DOM: wait for the focus, not just for the heading.
    const heading = await screen.findByRole('heading', { level: 1, name: 'Audit log' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(router.state.location.pathname).toBe('/admin/audit')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('paints the navigation drawer in the shell teal only (one background utility, as the top bar)', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const drawer = screen.getByRole('dialog', { name: 'Acme Holdings' })
    // Two background utilities on one element are decided by the stylesheet's order (bg-surface
    // came after bg-shell and won). Exactly one, the shell's.
    const backgrounds = [...drawer.classList].filter((name) => name.startsWith('bg-'))
    expect(backgrounds).toEqual(['bg-shell'])
    expect(drawer).toHaveClass('theme-shell')
  })

  it('shows the skip link as a padded pill with its focus ring inside it (review: no padding, a teal ring on the teal shell)', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    const skip = await screen.findByRole('link', { name: 'Skip to main content' })
    expect(skip).toHaveAttribute('href', '#main-content')
    // `focus:not-sr-only` resets the padding, so the padding is set after it, in the same state.
    expect(skip).toHaveClass('sr-only', 'focus:not-sr-only', 'focus:px-4', 'focus:py-2', 'focus-visible:outline-offset-[-5px]')
    expect(skip).not.toHaveClass('px-4')
  })

  it('drops the sidebar room on paper, so printed pages use the whole sheet in either direction', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    const main = await screen.findByRole('main')

    // The wrapper keeps a logical start padding for the sidebar on screen (left in English, right
    // in Arabic) and none in print, where the sidebar is hidden.
    const wrapper = main.parentElement
    expect(wrapper).toHaveClass('lg:ps-64', 'print:ps-0')
  })

  it('on desktop keeps the account menu at the foot of the teal sidebar and drops the top bar', async () => {
    stubDesktop()
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    // No top bar: neither its navigation button nor a second account menu.
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Account menu/ })).toHaveLength(1)
    const sidebar = screen.getByRole('complementary')
    expect(sidebar).toHaveClass('theme-shell', 'bg-shell')
    expect(within(sidebar).getByText('Acme Holdings')).toHaveAttribute('data-company-wordmark')
    await user.click(within(sidebar).getByRole('button', { name: 'Account menu for Lina Haddad' }))
    expect(within(sidebar).getByRole('menu', { name: 'Account menu for Lina Haddad' })).toBeInTheDocument()
  })

  it('heads the sidebar with the company’s logo for dark surfaces, named by the company, and names the company once', async () => {
    stubDesktop()
    const me = meWithLogos({ logo: true, logoDark: true })
    mockApi({ 'GET /auth/me': () => jsonResponse(me), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    const sidebar = screen.getByRole('complementary')
    const logo = within(sidebar).getByRole('img', { name: 'Acme Holdings' })
    expect(logo).toHaveAttribute('src', me.company.brand.logo_dark_url)
    expect(logo).toHaveAttribute('data-company-logo', 'dark')
    // It stands on the shell itself: no plate, and no wordmark beside it.
    expect(sidebar.querySelector('[data-logo-plate]')).toBeNull()
    expect(sidebar.querySelector('[data-company-wordmark]')).toBeNull()
    // The user block names the person and their roles; the company is the logo above.
    const trigger = within(sidebar).getByRole('button', { name: 'Account menu for Lina Haddad' })
    expect(trigger).toHaveTextContent('Lina Haddad')
    expect(trigger).toHaveTextContent('Administrator')
    expect(trigger).not.toHaveTextContent('Acme Holdings')
    expect(sidebar).not.toHaveTextContent('Mawdoo3')
  })

  it('puts a company’s only logo on a white plate on the shell, and falls back to its name when the file does not load', async () => {
    stubDesktop()
    const me = meWithLogos({ logo: true })
    mockApi({ 'GET /auth/me': () => jsonResponse(me), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    const sidebar = screen.getByRole('complementary')
    const logo = within(sidebar).getByRole('img', { name: 'Acme Holdings' })
    expect(logo).toHaveAttribute('src', me.company.brand.logo_url)
    expect(logo).toHaveAttribute('data-company-logo', 'light')
    // The logo is made for light surfaces: a white plate carries it on the coloured shell.
    expect(logo.closest('[data-logo-plate]')).toHaveClass('bg-white')

    // A file that is gone (removed a moment ago): the company's name stands in.
    fireEvent.error(logo)
    expect(within(sidebar).queryByRole('img')).toBeNull()
    expect(within(sidebar).getByText('Acme Holdings')).toHaveAttribute('data-company-wordmark')
  })

  it('on a shell that is a light colour, never draws the logo for dark surfaces: the logo on its plate, and the ink follows the shell', async () => {
    stubDesktop()
    // A yellow company: its shell is yellow under dark ink (the palette's surface is the colour itself).
    const me = meWithLogos({ logo: true, logoDark: true, color: SAMPLE_COLOURS.amber })
    mockApi({ 'GET /auth/me': () => jsonResponse(me), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })

    const sidebar = screen.getByRole('complementary')
    const logo = within(sidebar).getByRole('img', { name: 'Acme Holdings' })
    // The white logo for dark surfaces would not show on yellow: the logo for light surfaces, on its plate.
    expect(logo).toHaveAttribute('src', me.company.brand.logo_url)
    expect(logo.closest('[data-logo-plate]')).toHaveClass('bg-white')
    // In the dark colour scheme the shell is the deep one: there it takes the dark-surface logo (on screen).
    expect(sidebar.querySelector('picture source')).toBeNull()
    act(() => chooseAppearance('dark'))
    expect(sidebar.querySelector('picture source')).toHaveAttribute('srcset', me.company.brand.logo_dark_url)
    expect(sidebar.querySelector('picture source')).toHaveAttribute('media', 'screen')
    act(() => chooseAppearance('system'))

    // The document carries the shell's colours: the yellow itself, and its ink for everything drawn on it.
    const palette = me.company.brand.palette!
    const root = document.documentElement.style
    await waitFor(() => expect(root.getPropertyValue('--brand-shell-shell')).toBe(SAMPLE_COLOURS.amber))
    for (const token of ['fg', 'fg-secondary', 'fg-muted', 'accent', 'accent-text', 'focus', 'highlight']) expect(root.getPropertyValue(`--brand-shell-${token}`)).toBe(palette.on_surface)
    expect(root.getPropertyValue('--brand-shell-on-accent')).toBe(SAMPLE_COLOURS.amber)
    expect(root.getPropertyValue('--brand-shell-border')).toMatch(/^rgb\(28 38 43 \/ /)
    expect(root.getPropertyValue('--brand-shell-scheme')).toBe('light')
    // The shell's parts read those through the tokens: no class of the shell names a colour of its own.
    expect(sidebar.className).not.toMatch(/white|text-\[#/)
    expect(sidebar).toHaveClass('border-e', 'border-shell-edge')
  })

  it('around the dark reception screen the shell is the deep one whatever the company’s colour: the logo for dark surfaces stands on it', async () => {
    const tree: RouteObject[] = [
      {
        path: '/',
        Component: RootLayout,
        children: [{ Component: RequireAuth, children: [{ element: <AppLayout navigation={navigation} />, children: [{ path: 'dark', handle: DARK_SURFACE_HANDLE, element: <h1>Dark screen</h1> }] }] }],
      },
    ]
    const me = meWithLogos({ logo: true, logoDark: true, color: SAMPLE_COLOURS.amber }, ['RECEPTIONIST'])
    mockApi({ 'GET /auth/me': () => jsonResponse(me) })
    renderRoutes(tree, { initialEntries: ['/dark'] })
    await screen.findByRole('heading', { level: 1, name: 'Dark screen' })

    expect(appBar()).toHaveClass('theme-shell-deep')
    const logo = within(appBar()).getByRole('img', { name: 'Acme Holdings' })
    expect(logo).toHaveAttribute('src', me.company.brand.logo_dark_url)
    expect(logo).toHaveAttribute('data-company-logo', 'dark')
    expect(appBar().querySelector('[data-logo-plate], picture')).toBeNull()
  })

  it('keeps the account menu inside the screen, and a long company name on two lines (UX review: 598 px wide at 390 px)', async () => {
    const long = 'International Company for Advanced Technological Solutions and Integrated Digital Services'
    const me = makeMe(['SYSTEM_ADMIN'])
    mockApi({ 'GET /auth/me': () => jsonResponse({ ...me, company: { ...me.company, name: long } }), ...adminDashboardRoutes() })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'Admin dashboard' })
    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }))

    // The popup is never wider than 20rem, nor than the screen less its gutters.
    const popup = screen.getByRole('menu').parentElement as HTMLElement
    expect(popup).toHaveClass('max-w-[min(20rem,calc(100vw-1.5rem))]', 'min-w-56')
    // The company's line wraps and is cut after its second line: it does not set the menu's width.
    const company = document.querySelector('[data-user-company]') as HTMLElement
    expect(company).toHaveTextContent(long)
    const text = company.querySelector('span') as HTMLElement
    expect(text).toHaveClass('line-clamp-2', 'break-words', 'min-w-0')
    expect(text).not.toHaveClass('truncate')
    expect(company.className).not.toMatch(/whitespace-nowrap|truncate/)
  })

  it('names one person’s roles as job titles in Arabic, in the user block and the account menu (final touches)', async () => {
    stubDesktop()
    const me = makeMe(['SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST'], { full_name: 'عمر خليل', preferred_language: 'ar' })
    mockApi({ 'GET /auth/me': () => jsonResponse(me), ...adminDashboardRoutes() })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin'] })
    await screen.findByRole('heading', { level: 1, name: 'لوحة تحكم الإدارة' })

    // «عمر خليل · موظف»: beside one person the job title, never the team («الموظفون», «الاستقبال»).
    const roles = 'مدير النظام · موظف · موظف استقبال'
    const trigger = within(screen.getByRole('complementary')).getByRole('button', { name: 'قائمة الحساب: عمر خليل' })
    expect(within(trigger).getByText(roles)).toBeInTheDocument()
    expect(trigger.textContent).not.toMatch(/الموظفون|إدارة النظام|الاستقبال/)
    // The menu's header (outside role="menu") says them the same way.
    await user.click(trigger)
    const [, header] = screen.getAllByText(roles)
    expect(header).toBeDefined()
    expect(screen.getByRole('menu', { name: 'قائمة الحساب: عمر خليل' })).not.toContainElement(header!)

    // The dashboard counts the people who hold each role: there the teams are right.
    const accounts = await screen.findByRole('heading', { name: 'الحسابات النشطة حسب الدور' })
    const card = accounts.closest('section') ?? document.body
    for (const team of ['الموظفون', 'الاستقبال', 'الإدارة العليا', 'إدارة النظام']) expect(within(card).getByText(team)).toBeInTheDocument()
  })

  it('groups admin navigation under its own heading', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN', 'EMPLOYEE'])), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getByRole('heading', { name: 'Administration' })).toBeInTheDocument()
    expect(within(nav).getByRole('heading', { name: 'Insights' })).toBeInTheDocument()
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Reception',
      'My visits',
      'Invite visitor',
      'Visitors',
      'Inside now',
      'Visit history',
      'Reports',
      'Dashboard',
      'Users',
      'Departments',
      'Company settings',
      'Email texts',
      'Audit log',
    ])
  })

  it('marks the current page as a pill in the shell accent', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])), ...adminDashboardRoutes() })
    renderRoutes(routes, { initialEntries: ['/admin'] })

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    const current = within(nav).getByRole('link', { name: 'Dashboard' })
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current).toHaveClass('bg-accent', 'text-on-accent', 'font-semibold')
    expect(within(nav).getByRole('link', { name: 'Users' })).not.toHaveClass('bg-accent')
  })

  it('draws a dark screen (route handle) edge to edge: the deep shell and data-surface for the page and its portals', async () => {
    const tree: RouteObject[] = [
      {
        path: '/',
        Component: RootLayout,
        children: [
          {
            Component: RequireAuth,
            children: [
              {
                element: <AppLayout navigation={navigation} />,
                children: [
                  { path: 'dark', handle: DARK_SURFACE_HANDLE, element: <h1>Dark screen</h1> },
                  { path: 'light', element: <h1>Light screen</h1> },
                ],
              },
            ],
          },
        ],
      },
    ]
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['RECEPTIONIST'])) })
    const { container, router } = renderRoutes(tree, { initialEntries: ['/dark'] })
    await screen.findByRole('heading', { level: 1, name: 'Dark screen' })

    expect(container.querySelector('[data-surface="dark"]')).not.toBeNull()
    expect(appBar()).toHaveClass('theme-shell-deep')
    expect(appBar()).not.toHaveClass('theme-shell')

    await router.navigate('/light')
    await screen.findByRole('heading', { level: 1, name: 'Light screen' })
    expect(container.querySelector('[data-surface]')).toBeNull()
    expect(appBar()).toHaveClass('theme-shell')
  })

  it('draws the dark screen light for a device that chose Light, and dark for one that chose Dark or leaves it to the device (Phase 13)', async () => {
    const tree: RouteObject[] = [
      {
        path: '/',
        Component: RootLayout,
        children: [{ Component: RequireAuth, children: [{ element: <AppLayout navigation={navigation} />, children: [{ path: 'dark', handle: DARK_SURFACE_HANDLE, element: <h1>Dark screen</h1> }] }] }],
      },
    ]
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['RECEPTIONIST'])) })
    act(() => chooseAppearance('light'))
    const { container } = renderRoutes(tree, { initialEntries: ['/dark'] })
    await screen.findByRole('heading', { level: 1, name: 'Dark screen' })
    // A person who picks Light sees the reception light: the coloured shell, no dark surface for the page or its portals.
    expect(container.querySelector('[data-surface]')).toBeNull()
    expect(appBar()).toHaveClass('theme-shell')
    expect(appBar()).not.toHaveClass('theme-shell-deep')

    act(() => chooseAppearance('dark'))
    expect(container.querySelector('[data-surface="dark"]')).not.toBeNull()
    expect(appBar()).toHaveClass('theme-shell-deep')

    act(() => chooseAppearance('system'))
    // System: dark by design, as before, on a device in its light scheme too (jsdom's is light).
    expect(container.querySelector('[data-surface="dark"]')).not.toBeNull()
    expect(appBar()).toHaveClass('theme-shell-deep')
  })
})
