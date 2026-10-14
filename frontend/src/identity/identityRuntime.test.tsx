import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { chooseAppearance } from '../appearance/appearance'
import { isPublicPage, loginPath, safeNextPath, signInPath } from '../auth/redirect'
import { errorResponse, jsonResponse, makeMe, mockApi, noContent, NOT_AUTHENTICATED, type RouteHandler } from '../test/api'
import { routes } from '../test/appRoutes'
import { myVisitsRoutes } from '../test/fixtures'
import { makeBrand, SAMPLE_COLOURS } from '../test/palettes'
import { recordAddresses, renderBrowserRoutes, renderRoutes } from '../test/render'
import type { Me, PublicCompanyBrand } from '../types/api'
import { IDENTITY_CHANGE_ATTRIBUTE } from './document'
import { BRANDS_STORAGE_KEY, COMPANY_STORAGE_KEY, readCachedBrand, readRememberedCompany, rememberCompany, writeCachedBrand } from './storage'
import { BRAND_VARIABLE_NAMES, brandTokens, PENDING_PALETTE } from './tokens'

/*
 * A company's identity at run time (Phase 12): its own sign-in page and the links between the
 * signed-out pages, the device that remembers its company, and the signed-in app in the company's
 * colours and logo.
 */

const RESET_TOKEN = 'rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2AXo3_vK9-aQ2'

const NOVA: PublicCompanyBrand = {
  slug: 'nova-labs',
  name: 'Nova Labs',
  name_ar: 'مختبرات نوفا',
  default_language: 'en',
  brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.darkBlue, logo: true, logoDark: true, icon: true, version: 'v3' }),
}
const PLAIN: PublicCompanyBrand = { slug: 'other-corp', name: 'Other Corp', name_ar: null, default_language: 'en', brand: makeBrand('other-corp') }

function meOf(company: PublicCompanyBrand, roles: Me['user']['roles'] = ['EMPLOYEE']): Me {
  const me = makeMe(roles)
  return { ...me, company: { ...me.company, id: `company-${company.slug}`, slug: company.slug, name: company.name, name_ar: company.name_ar, brand: company.brand } }
}

const publicBrands: Record<string, RouteHandler> = {
  'GET /public/companies/nova-labs/brand': () => jsonResponse(NOVA),
  'GET /public/companies/other-corp/brand': () => jsonResponse(PLAIN),
  'GET /public/companies/no-such-company/brand': () => errorResponse(404, 'NOT_FOUND', 'Not found.'),
}

const root = () => document.documentElement
/** The browser chrome's colour (one meta: Phase 13). */
const themeColor = () => document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content
const address = (router: { state: { location: { pathname: string; search: string } } }) => `${router.state.location.pathname}${router.state.location.search}`
const headLinks = (rel: string) => [...document.head.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)].map((link) => link.getAttribute('href'))

/** A page's markup without what differs between two renders of the same page: the generated ids, and the company the link to the password reset keeps. */
function comparable(markup: string | undefined): string | undefined {
  return markup?.replaceAll(/id="[^"]*"|for="[^"]*"|aria-describedby="[^"]*"|aria-labelledby="[^"]*"/g, '').replace('?c=no-such-company', '')
}

describe('a company’s own sign-in page', () => {
  it.each(['/c/nova-labs', '/c/nova-labs/login', '/login?c=nova-labs'])('%s shows the company’s identity above the sign-in form', async (path) => {
    const { requests } = mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    renderRoutes(routes, { initialEntries: [path] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })

    // Its logo for light surfaces, named by the company; the dark-surface one in the dark scheme.
    const logo = await screen.findByRole('img', { name: 'Nova Labs' })
    expect(logo).toHaveAttribute('src', NOVA.brand.logo_url)
    // The light scheme of a device that chose nothing (jsdom's is light): nothing else is offered.
    expect(logo.closest('[data-identity-lockup="page"]')?.querySelector('source')).toBeNull()
    await waitFor(() => expect(document.title).toBe('Sign in · Nova Labs'))
    // Its colours on the document, its icon in the tab, its manifest for the installable app.
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(NOVA.brand.palette?.strong)
    expect(headLinks('icon')).toEqual([NOVA.brand.icon_url])
    expect(headLinks('manifest')).toEqual(['/api/v1/public/companies/nova-labs/manifest.webmanifest'])
    // No mark of the neutral page, and nothing of the product.
    expect(document.querySelector('[data-neutral-mark], [data-brand-lockup]')).toBeNull()
    expect(document.body).not.toHaveTextContent('Mawdoo3')
    expect(requests.map((request) => request.path).toSorted()).toEqual(['/auth/me', '/public/companies/nova-labs/brand'])
  })

  it('shows a company without a logo by its name, in the default colours', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    renderRoutes(routes, { initialEntries: ['/c/other-corp'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })

    await waitFor(() => expect(document.querySelector('[data-identity-lockup="page"] [data-company-wordmark]')).toHaveTextContent('Other Corp'))
    expect(document.querySelectorAll('main img')).toHaveLength(0)
    await waitFor(() => expect(document.title).toBe('Sign in · Other Corp'))
    for (const name of BRAND_VARIABLE_NAMES) expect(root().style.getPropertyValue(name)).toBe('')
    expect(headLinks('icon')).toContain('/icons/neutral-32.png')
  })

  it('is the neutral page for a slug nobody has: the same page as /login, and no word about the company', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const unknown = renderRoutes(routes, { initialEntries: ['/c/no-such-company'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    await waitFor(() => expect(document.querySelector('[data-neutral-mark]')).not.toBeNull())
    const shown = { text: document.body.textContent, title: document.title, markup: document.querySelector('main')?.innerHTML }
    unknown.unmount()

    renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    await waitFor(() => expect(document.title).toBe('Sign in'))
    expect(document.body.textContent).toBe(shown.text)
    expect(document.title).toBe(shown.title)
    expect(comparable(document.querySelector('main')?.innerHTML)).toBe(comparable(shown.markup))
  })

  it('keeps the company across the links between the signed-out pages', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/c/nova-labs'] })
    await screen.findByRole('img', { name: 'Nova Labs' })

    await user.click(screen.getByRole('link', { name: 'Forgot your password?' }))
    await screen.findByRole('heading', { level: 1, name: 'Reset your password' })
    expect(address(router)).toBe('/forgot-password?c=nova-labs')
    expect(await screen.findByRole('img', { name: 'Nova Labs' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Reset your password · Nova Labs'))

    await user.click(screen.getByRole('link', { name: 'Back to sign in' }))
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    expect(address(router)).toBe('/c/nova-labs')
  })

  it('shows the identity on the reset link the server wrote, and leads back to the company’s pages', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands, 'POST /auth/reset-password': () => errorResponse(400, 'INVALID_RESET_TOKEN', 'This link is invalid or has expired.') })
    // The loader reads the token from the browser's own address (and takes it out of it; the company stays).
    window.history.replaceState(null, '', `/reset-password?c=nova-labs#token=${RESET_TOKEN}`)
    const { user } = renderBrowserRoutes(routes)
    await screen.findByRole('heading', { level: 1, name: 'Choose a new password' })
    expect(await screen.findByRole('img', { name: 'Nova Labs' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Choose a new password · Nova Labs'))
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/reset-password?c=nova-labs')

    await user.type(screen.getByLabelText('New password'), 'A-long-new-passphrase-2026')
    await user.type(screen.getByLabelText('Confirm new password'), 'A-long-new-passphrase-2026')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    await screen.findByRole('heading', { level: 1, name: 'Link invalid or expired' })
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password?c=nova-labs')
  })

  it('signs in from the company’s page and continues to the page asked for', async () => {
    let signedIn = false
    mockApi({
      'GET /auth/me': () => (signedIn ? jsonResponse(meOf(NOVA)) : NOT_AUTHENTICATED()),
      ...publicBrands,
      ...myVisitsRoutes(),
      'POST /auth/login': () => {
        signedIn = true
        return jsonResponse(meOf(NOVA))
      },
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/c/nova-labs?next=%2Fvisits'] })
    await screen.findByRole('img', { name: 'Nova Labs' })

    await user.type(screen.getByLabelText('Email'), 'lina.haddad@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    expect(address(router)).toBe('/visits')
    await waitFor(() => expect(document.title).toBe('My visits · Nova Labs'))
  })

  it('sends someone who is already signed in on to the app', async () => {
    // While the session is being checked the page already asks for the company its address names.
    mockApi({ 'GET /auth/me': () => jsonResponse(meOf(NOVA)), ...publicBrands, ...myVisitsRoutes() })
    const { router } = renderRoutes(routes, { initialEntries: ['/c/nova-labs'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    expect(address(router)).toBe('/visits')
  })
})

describe('the device remembers its company after a sign-in', () => {
  it('keeps the company and its identity, and nothing of the person', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(meOf(NOVA)), ...myVisitsRoutes() })
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })

    await waitFor(() => expect(readRememberedCompany()).toBe('nova-labs'))
    expect(readCachedBrand('nova-labs')).toEqual({ ...NOVA, default_language: 'en' })
    const stored = `${window.localStorage.getItem(COMPANY_STORAGE_KEY)}${window.localStorage.getItem(BRANDS_STORAGE_KEY)}`
    for (const personal of ['Lina', 'lina.haddad@example.com', 'EMPLOYEE', '7f0d1c0e-1111']) expect(stored).not.toContain(personal)
  })

  it('leads /login to the company’s sign-in page, with the page to return to, and never shows the neutral page on the way', async () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const { router } = renderRoutes(routes, { initialEntries: ['/login?next=%2Fvisits%2Fnew'] })
    const seen = recordAddresses(router)

    await screen.findByRole('img', { name: 'Nova Labs' })
    expect(address(router)).toBe('/c/nova-labs?next=%2Fvisits%2Fnew')
    expect(seen.every((entry) => entry.startsWith('/c/nova-labs'))).toBe(true)
    expect(document.querySelector('[data-neutral-mark]')).toBeNull()
  })

  it('leaves /login alone on a device that knows no company, and when the address names one itself', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const neutral = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    expect(address(neutral.router)).toBe('/login')
    neutral.unmount()

    rememberCompany('nova-labs')
    const other = renderRoutes(routes, { initialEntries: ['/login?c=other-corp'] })
    await waitFor(() => expect(document.querySelector('[data-company-wordmark]')).toHaveTextContent('Other Corp'))
    expect(address(other.router)).toBe('/login?c=other-corp')
  })

  it('leads a sign-out to the company’s sign-in page, in its identity', async () => {
    let signedIn = true
    mockApi({
      'GET /auth/me': () => (signedIn ? jsonResponse(meOf(NOVA)) : NOT_AUTHENTICATED()),
      ...publicBrands,
      ...myVisitsRoutes(),
      'POST /auth/logout': () => {
        signedIn = false
        return noContent()
      },
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    expect(address(router)).toBe('/c/nova-labs')
    expect(await screen.findByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', NOVA.brand.logo_url)
    // The colours stay the company's through the sign-out: no moment in the default ones.
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(NOVA.brand.palette?.strong)
  })

  it('names the device’s sign-in page for an expired session, with the page to return to', () => {
    expect(signInPath()).toBe('/login')
    expect(loginPath({ pathname: '/visits/new', search: '?visitor=7' })).toBe('/login?next=%2Fvisits%2Fnew%3Fvisitor%3D7')
    rememberCompany('nova-labs')
    expect(signInPath()).toBe('/c/nova-labs')
    expect(loginPath({ pathname: '/visits/new', search: '?visitor=7' })).toBe('/c/nova-labs?next=%2Fvisits%2Fnew%3Fvisitor%3D7')
    expect(loginPath({ pathname: '/', search: '' })).toBe('/c/nova-labs')
  })

  it('never takes a company’s sign-in page as the page to return to', () => {
    for (const path of ['/c/nova-labs', '/c/nova-labs/login', '/c/anything']) {
      expect(isPublicPage(path)).toBe(true)
      expect(safeNextPath(path)).toBeNull()
    }
    expect(safeNextPath('/c/nova-labs/../../visits')).toBe('/visits')
    expect(isPublicPage('/visits')).toBe(false)
  })

  it('forgets a company that no longer exists: /login is the neutral page again', async () => {
    writeCachedBrand({ ...NOVA, slug: 'no-such-company', brand: makeBrand('no-such-company', { color: SAMPLE_COLOURS.red }) })
    rememberCompany('no-such-company')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const first = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    expect(address(first.router)).toBe('/c/no-such-company')

    await waitFor(() => expect(readRememberedCompany()).toBeNull())
    expect(readCachedBrand('no-such-company')).toBeNull()
    // The server's answer replaced this device's copy: the neutral page, the default colours.
    await waitFor(() => expect(document.querySelector('[data-neutral-mark]')).not.toBeNull())
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe('')
    first.unmount()

    const next = renderRoutes(routes, { initialEntries: ['/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    expect(address(next.router)).toBe('/login')
  })
})

describe('the signed-out pages of a device that remembers its company (UX review: the password pages were neutral, the 404 was not)', () => {
  it('leads /forgot-password to the same page of the device’s company, in its identity, as /login does', async () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const { router } = renderRoutes(routes, { initialEntries: ['/forgot-password'] })
    const seen = recordAddresses(router)

    await screen.findByRole('heading', { level: 1, name: 'Reset your password' })
    expect(await screen.findByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(address(router)).toBe('/forgot-password?c=nova-labs')
    // Replaced, not added: the page without a company is not a step back.
    expect(seen.every((entry) => entry === '/forgot-password?c=nova-labs')).toBe(true)
    expect(document.querySelector('[data-neutral-mark]')).toBeNull()
    await waitFor(() => expect(document.title).toBe('Reset your password · Nova Labs'))
    // The way back to the sign-in page keeps the company.
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/c/nova-labs')
  })

  it('leads an older reset link without a company there too, and the form keeps the link’s token', async () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    window.history.replaceState(null, '', `/reset-password#token=${RESET_TOKEN}`)
    const { requests } = mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands, 'POST /auth/reset-password': () => noContent() })
    const written = [vi.spyOn(window.history, 'replaceState'), vi.spyOn(window.history, 'pushState')]
    const { user } = renderBrowserRoutes(routes)

    expect(await screen.findByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(`${window.location.pathname}${window.location.search}`).toBe('/reset-password?c=nova-labs')
    // The token is where the loader put it, never in the address: the router still holds the link's
    // fragment, and the way to the company's page must not write it back.
    expect(window.location.href).not.toContain(RESET_TOKEN)
    expect(window.location.hash).toBe('')
    const addresses = written.flatMap((spy) => spy.mock.calls.map(([, , url]) => String(url)))
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.filter((url) => url.includes(RESET_TOKEN))).toEqual([])

    await user.type(screen.getByLabelText('New password'), 'violet-harbour-lantern-42')
    await user.type(screen.getByLabelText('Confirm new password'), 'violet-harbour-lantern-42')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(await screen.findByRole('heading', { name: 'Your password has been reset' })).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/auth/reset-password')?.body).toEqual({ token: RESET_TOKEN, new_password: 'violet-harbour-lantern-42' })
    window.history.replaceState(null, '', '/')
  })

  it('leaves the password pages alone when the address names a company itself, and on a device that knows none', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    const neutral = renderRoutes(routes, { initialEntries: ['/forgot-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Reset your password' })
    expect(address(neutral.router)).toBe('/forgot-password')
    expect(document.querySelector('[data-neutral-mark]')).not.toBeNull()
    neutral.unmount()

    rememberCompany('nova-labs')
    const other = renderRoutes(routes, { initialEntries: ['/forgot-password?c=other-corp'] })
    await waitFor(() => expect(document.querySelector('[data-company-wordmark]')).toHaveTextContent('Other Corp'))
    expect(address(other.router)).toBe('/forgot-password?c=other-corp')
  })
})

describe('a company’s page on a device that has never seen it, on a slow connection (UX review: the default teal first, then a fade)', () => {
  it('is drawn in nobody’s colours while the identity is on its way, and takes the company’s at once when it arrives', async () => {
    const held: { answer?: (response: Response) => void } = {}
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, 'GET /public/companies/nova-labs/brand': () => new Promise<Response>((resolve) => (held.answer = resolve)) })
    renderRoutes(routes, { initialEntries: ['/c/nova-labs'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })

    // The primary button and the links: the neutral slate, never the default teal.
    await waitFor(() => expect(root().style.getPropertyValue('--brand-light-accent')).toBe(PENDING_PALETTE.surface))
    expect(root().style.getPropertyValue('--brand-light-accent-text')).toBe(PENDING_PALETTE.strong)
    for (const name of BRAND_VARIABLE_NAMES) expect(root().style.getPropertyValue(name)).not.toMatch(/#188086|#136a6f/)
    // Nothing of an identity is drawn meanwhile, as before.
    expect(document.querySelector('[data-identity-lockup], [data-neutral-mark]')).toBeNull()

    // The first change after this one is the company's: no transition runs while it is applied.
    await waitFor(() => expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false))
    held.answer?.(jsonResponse(NOVA))
    await screen.findByRole('img', { name: 'Nova Labs' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(NOVA.brand.palette?.surface)
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(true)
    await waitFor(() => expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false))
  })

  it('is the neutral page in the default colours once it is known that nobody has the slug', async () => {
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    renderRoutes(routes, { initialEntries: ['/c/no-such-company'] })
    await waitFor(() => expect(document.querySelector('[data-neutral-mark]')).not.toBeNull())
    await waitFor(() => expect(root().style.getPropertyValue('--brand-light-accent')).toBe(''))
  })
})

describe('a copy on the device that somebody planted (security review, Phase 12)', () => {
  // An entry for `evil-co` that borrows another company's logo, as the review planted it in storage.
  const PLANTED_LOGO = '/api/v1/public/companies/nova-labs/brand/logo.png?v=zzz'
  const planted = { slug: 'evil-co', name: 'Nova Labs', name_ar: null, default_language: 'en', brand: { ...makeBrand('evil-co'), logo_url: PLANTED_LOGO } }
  const plant = () => window.localStorage.setItem(BRANDS_STORAGE_KEY, JSON.stringify([{ at: 5, brand: planted }]))

  it('never shows another company’s logo under this company’s address, not even until the server answers', async () => {
    plant()
    const { release, held } = hold()
    mockApi({
      'GET /auth/me': NOT_AUTHENTICATED,
      'GET /public/companies/evil-co/brand': async () => {
        await held
        return errorResponse(404, 'NOT_FOUND', 'Not found.')
      },
    })
    const seen = watchImages()
    renderRoutes(routes, { initialEntries: ['/c/evil-co'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    // The planted copy is all the device has until the server answers: its logo is not this company's, and is not drawn.
    await waitFor(() => expect(document.querySelector('[data-identity-lockup="page"]')).not.toBeNull())
    expect(document.querySelector('[data-identity-lockup="page"] img')).toBeNull()

    // The server's answer (nobody has that slug) replaces the copy: the neutral page, nothing kept.
    release()
    await waitFor(() => expect(document.querySelector('[data-neutral-mark]')).not.toBeNull())
    expect(readCachedBrand('evil-co')).toBeNull()
    expect(window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? '').not.toContain('nova-labs')
    expect(seen.filter((source) => source.includes('nova-labs'))).toEqual([])
  })

  it('is replaced by the server’s own answer for that company, on the page and in storage', async () => {
    plant()
    const real: PublicCompanyBrand = { slug: 'evil-co', name: 'Evil Co', name_ar: null, default_language: 'en', brand: makeBrand('evil-co', { color: SAMPLE_COLOURS.red, logo: true }) }
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, 'GET /public/companies/evil-co/brand': () => jsonResponse(real) })
    const seen = watchImages()
    renderRoutes(routes, { initialEntries: ['/c/evil-co'] })
    const logo = await screen.findByRole('img', { name: 'Evil Co' })
    expect(logo).toHaveAttribute('src', real.brand.logo_url)
    await waitFor(() => expect(document.title).toBe('Sign in · Evil Co'))
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? '[]')).toEqual([{ at: expect.any(Number) as number, brand: real }]))
    expect(seen.filter((source) => source.includes('nova-labs'))).toEqual([])
  })

  it('cannot make an answer of the API lend a logo either: a session’s brand keeps only its own company’s files', async () => {
    const forged = meOf({ ...PLAIN, slug: 'evil-co', brand: { ...makeBrand('evil-co', { color: SAMPLE_COLOURS.red }), logo_url: PLANTED_LOGO, logo_dark_url: '/api/v1/public/companies/nova-labs/brand/logo_dark.png?v=zzz' } })
    mockApi({ 'GET /auth/me': () => jsonResponse(forged), ...myVisitsRoutes() })
    const seen = watchImages()
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    // The company's name stands where the logo would: the wordmark, in its own colours.
    await waitFor(() => expect(document.querySelector('[data-identity-lockup="shell"] [data-company-wordmark]')).toHaveTextContent('Other Corp'))
    expect(document.querySelector('[data-identity-lockup] img')).toBeNull()
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(forged.company.brand.palette?.strong)
    expect(seen.filter((source) => source.includes('nova-labs'))).toEqual([])
    await waitFor(() => expect(readCachedBrand('evil-co')?.brand.logo_url).toBeNull())
  })
})

/** Every image address the page ever drew: an image that shows for a moment has shown. */
function watchImages(): string[] {
  const seen: string[] = []
  const note = () => {
    for (const image of document.querySelectorAll('img, source')) seen.push(image.getAttribute('src') ?? image.getAttribute('srcset') ?? '')
  }
  new MutationObserver(note).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] })
  return seen
}

/** An answer held back until `release()` is called. */
function hold(): { held: Promise<void>; release: () => void } {
  const lock: { open?: () => void } = {}
  const held = new Promise<void>((resolve) => {
    lock.open = resolve
  })
  return { held, release: () => lock.open?.() }
}

describe('the signed-in app in the company’s identity', () => {
  it('draws with the company’s palette, shows its logo in the shell and names it in every title', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(meOf(NOVA)), ...myVisitsRoutes() })
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })

    const tokens = brandTokens(NOVA.brand.palette!)
    await waitFor(() => expect(root().style.getPropertyValue('--brand-shell-shell')).toBe(NOVA.brand.palette?.surface))
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(tokens.light.accent)
    expect(root().style.getPropertyValue('--brand-dark-accent')).toBe(tokens.dark.accent)
    expect(root().style.getPropertyValue('--brand-deep-shell')).toBe(NOVA.brand.palette?.deep)
    expect(document.querySelectorAll('style')).toHaveLength(0)
    // The shell: the logo for dark surfaces, named by the company.
    const logo = document.querySelector<HTMLImageElement>('[data-app-bar] [data-identity-lockup="shell"] img')
    expect(logo).toHaveAttribute('src', NOVA.brand.logo_dark_url)
    expect(logo).toHaveAttribute('alt', 'Nova Labs')
    await waitFor(() => expect(document.title).toBe('My visits · Nova Labs'))
    expect(headLinks('icon')).toEqual([NOVA.brand.icon_url])
    expect(headLinks('manifest')).toEqual(['/api/v1/public/companies/nova-labs/manifest.webmanifest'])
    // Signed in, the session carries the identity: the public endpoint is not asked.
    expect(document.body).not.toHaveTextContent('Mawdoo3')
  })

  it('gives the browser’s chrome the shell’s colour of the scheme the device’s appearance draws the page in, live (Phase 13)', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#188086" />')
    mockApi({ 'GET /auth/me': () => jsonResponse(meOf(NOVA)), ...myVisitsRoutes() })
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    await waitFor(() => expect(themeColor()).toBe(NOVA.brand.palette?.surface))
    act(() => chooseAppearance('dark'))
    await waitFor(() => expect(themeColor()).toBe(NOVA.brand.palette?.deep))
    act(() => chooseAppearance('light'))
    await waitFor(() => expect(themeColor()).toBe(NOVA.brand.palette?.surface))
    document.head.querySelector('meta[name="theme-color"]')?.remove()
  })

  it('never asks the public brand endpoint while signed in', async () => {
    const { requests } = mockApi({ 'GET /auth/me': () => jsonResponse(meOf(NOVA)), ...myVisitsRoutes() })
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    await waitFor(() => expect(document.title).toBe('My visits · Nova Labs'))
    expect(requests.some((request) => request.path.startsWith('/public/'))).toBe(false)
  })

  it('names the company in the UI language: its Arabic name in Arabic', async () => {
    const me = meOf(NOVA)
    mockApi({ 'GET /auth/me': () => jsonResponse({ ...me, user: { ...me.user, preferred_language: 'ar' } }), ...myVisitsRoutes() })
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'زياراتي' })
    await waitFor(() => expect(document.title).toBe('زياراتي · مختبرات نوفا'))
    expect(document.querySelector('[data-app-bar] [data-identity-lockup="shell"] img')).toHaveAttribute('alt', 'مختبرات نوفا')
  })

  it('shows a company without a brand by its name, in the default palette: nothing is set on the document', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(meOf(PLAIN)), ...myVisitsRoutes() })
    renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    await waitFor(() => expect(document.title).toBe('My visits · Other Corp'))
    expect(document.querySelector('[data-app-bar] [data-company-wordmark]')).toHaveTextContent('Other Corp')
    for (const name of BRAND_VARIABLE_NAMES) expect(root().style.getPropertyValue(name)).toBe('')
    expect(root().getAttribute('style') ?? '').toBe('')
    expect(headLinks('icon')).toContain('/icons/neutral-32.png')
  })

  it('follows the session to another company: the first one’s colours and logo go', async () => {
    const session = { me: meOf(NOVA) }
    mockApi({ 'GET /auth/me': () => jsonResponse(session.me), ...myVisitsRoutes() })
    const { queryClient } = renderRoutes(routes, { initialEntries: ['/visits'] })
    await screen.findByRole('heading', { level: 1, name: 'My visits' })
    await waitFor(() => expect(root().style.getPropertyValue('--brand-shell-shell')).toBe(NOVA.brand.palette?.strong))

    // Someone of another company signed in in another tab: the session check now names them.
    session.me = { ...meOf(PLAIN), user: { ...meOf(PLAIN).user, id: 'another-user', full_name: 'Sami Odeh' } }
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })

    await waitFor(() => expect(document.title).toContain('Other Corp'))
    expect(root().style.getPropertyValue('--brand-shell-shell')).toBe('')
    await waitFor(() => expect(document.querySelector('[data-app-bar] [data-company-wordmark]')).toHaveTextContent('Other Corp'))
    expect(readRememberedCompany()).toBe('other-corp')
  })

  it('takes the company’s language for a device that has chosen none and whose browser speaks neither', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['fr-FR'], language: 'fr-FR' })
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, 'GET /public/companies/nova-labs/brand': () => jsonResponse({ ...NOVA, default_language: 'ar' }) })
    renderRoutes(routes, { initialEntries: ['/c/nova-labs'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('تسجيل الدخول · مختبرات نوفا'))
  })
})
