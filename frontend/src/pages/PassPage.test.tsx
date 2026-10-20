import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { chooseAppearance } from '../appearance/appearance'
import { i18n, LANGUAGE_STORAGE_KEY } from '../i18n'
import { BRANDS_STORAGE_KEY, COMPANY_STORAGE_KEY } from '../identity/storage'
import { errorResponse, jsonResponse, mockApi } from '../test/api'
import { routes } from '../test/appRoutes'
import { makeBrand, SAMPLE_COLOURS } from '../test/palettes'
import { findAlert, renderRoutes } from '../test/render'
import type { PublicCompanyBrand } from '../types/api'

const TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'

/** A company with a whole identity, and one with none (its name, the default colours). */
const NOVA: PublicCompanyBrand = {
  slug: 'nova-labs',
  name: 'Nova Labs',
  name_ar: 'مختبرات نوفا',
  default_language: 'en',
  brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.darkBlue, logo: true, logoDark: true, icon: true }),
}
const PLAIN: PublicCompanyBrand = { slug: 'other-corp', name: 'Other Corp', name_ar: null, default_language: 'en', brand: makeBrand('other-corp') }

/** The company's logo on screen (the page also holds a copy for paper, which a screen never shows). */
async function screenLogo(): Promise<HTMLImageElement> {
  return waitFor(() => {
    const logo = document.querySelector<HTMLImageElement>('[data-identity-lockup="page"] img')
    if (!logo) throw new Error('No logo on screen yet')
    return logo
  })
}

/** The pass of an older link (no company): the page asks the server nothing at all. */
function renderPass(url: string) {
  const fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  const view = renderRoutes(routes, { initialEntries: [url] })
  return { ...view, fetchMock }
}

/** The pass of a link that names its company: only that company's public brand is answered. */
function renderCompanyPass(url: string, companies: PublicCompanyBrand[] = [NOVA, PLAIN]) {
  const api = mockApi(Object.fromEntries(companies.map((company) => [`GET /public/companies/${company.slug}/brand`, () => jsonResponse(company)])))
  return { ...api, ...renderRoutes(routes, { initialEntries: [url] }) }
}

describe('PassPage (/pass)', () => {
  it('renders a QR code for the token and Print, without notes and without any API call', async () => {
    const { fetchMock } = renderPass(`/pass#${TOKEN}`)

    const qr = await screen.findByRole('img', { name: 'Visitor pass QR code' })
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h\d+v1h-\d+z/)
    expect(screen.getByRole('button', { name: 'Print pass' })).toBeInTheDocument()
    // The pass, its code and printing; no instructions or tips (the user's request 8: what to do at
    // reception and what to bring are in the invitation e-mail that links here).
    expect(screen.getByRole('article', { name: 'Visitor pass' })).toHaveTextContent(/^Visitor passPrint pass$/)
    expect(screen.queryByRole('list')).toBeNull()
    // The title is set by an effect, which can run a moment after the lazy page's first paint. A link
    // without a company is the neutral pass (Phase 12): the title names nobody.
    await waitFor(() => expect(document.title).toBe('Visitor pass'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows an error state when the link has no token', async () => {
    const { fetchMock } = renderPass('/pass')

    expect(await findAlert('This pass link is incomplete or invalid')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Visitor pass QR code' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated token', `/pass#${TOKEN.slice(0, 20)}`],
    ['invalid characters', `/pass#${TOKEN.slice(0, 40)}<b>`],
    ['named parameter', `/pass#token=${TOKEN}`],
  ])('shows an error state for a %s', async (_label, url) => {
    renderPass(url)

    expect(await findAlert('This pass link is incomplete or invalid')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Visitor pass QR code' })).toBeNull()
  })

  it('is entirely Arabic in Arabic, right to left, its rows laid out by logical sides', async () => {
    await i18n.changeLanguage('ar')
    renderPass(`/pass#${TOKEN}`)

    expect(await screen.findByRole('img', { name: 'رمز QR لبطاقة الزيارة' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'بطاقة الزيارة' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'طباعة البطاقة' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'بطاقة الزيارة' })).toHaveTextContent(/^بطاقة الزيارةطباعة البطاقة$/)
    await waitFor(() => expect(document.title).toBe('بطاقة الزيارة'))
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    // No English left on the page but the switch that offers it (the QR code's address is not text).
    expect(screen.getByRole('main').textContent).not.toMatch(/[A-Za-z]{3,}/)
  })

  it('lets the visitor switch the language, remembered on the device, without any API call', async () => {
    const { user, fetchMock } = renderPass(`/pass#${TOKEN}`)
    await screen.findByRole('img', { name: 'Visitor pass QR code' })

    await user.click(screen.getByRole('button', { name: 'العربية' }))

    expect(screen.getByRole('heading', { level: 1, name: 'بطاقة الزيارة' })).toBeInTheDocument()
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar')
    await user.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Visitor pass' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is neutral without a company: no logo, no name, and nothing of the product, on screen and on paper', async () => {
    renderPass(`/pass#${TOKEN}`)
    await screen.findByRole('img', { name: 'Visitor pass QR code' })

    const main = screen.getByRole('main')
    expect(main.querySelector('[data-identity-lockup], [data-brand-lockup], [data-brand-logo], [data-company-wordmark]')).toBeNull()
    // The only image is the pass's own code.
    expect(main.querySelectorAll('img')).toHaveLength(0)
    expect(document.body).not.toHaveTextContent('Mawdoo3')
    expect(document.body).not.toHaveTextContent('موضوع')
    // The pass card names the pass; the code is large and stays black on white.
    expect(screen.getByRole('article', { name: 'Visitor pass' })).toContainElement(screen.getByRole('img', { name: 'Visitor pass QR code' }))
  })
})

describe('the pass of a company (/pass?c={slug}, Phase 12)', () => {
  it('carries the company’s identity: its logo over the card, its name in the title, its colours on the document', async () => {
    renderCompanyPass(`/pass?c=nova-labs#${TOKEN}`)
    await screen.findByRole('img', { name: 'Visitor pass QR code' })

    // On screen the company's logo (the dark-surface one in the dark scheme), named by the company.
    const logo = await screenLogo()
    expect(logo).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(logo).toHaveAttribute('alt', 'Nova Labs')
    const lockup = logo.closest('[data-identity-lockup="page"]')
    expect(lockup).toHaveClass('print:hidden')
    expect(lockup?.querySelector('source')).toBeNull()
    act(() => chooseAppearance('dark'))
    expect(lockup?.querySelector('source')).toHaveAttribute('srcset', NOVA.brand.logo_dark_url)
    expect(lockup?.querySelector('source')).toHaveAttribute('media', 'screen')
    // On paper the logo for light surfaces, whatever the screen's scheme.
    const paper = document.querySelector('[data-identity-lockup="paper"] img')
    expect(paper).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(paper?.closest('.print\\:flex')).toHaveClass('hidden')
    expect(document.querySelector('[data-identity-lockup="paper"] source')).toBeNull()

    await waitFor(() => expect(document.title).toBe('Visitor pass · Nova Labs'))
    // The card's head is the shell's colour: the company's own, through the document's properties.
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--brand-shell-shell')).toBe(NOVA.brand.palette?.strong))
    expect(document.querySelector('#pass-title')?.parentElement).toHaveClass('theme-shell', 'bg-shell')
    expect(document.body).not.toHaveTextContent('Mawdoo3')
  })

  it('offers the appearance toggle beside the language switch, and stands the logo on the page itself in the light scheme (F13-25, F13-26)', async () => {
    const lightOnly: PublicCompanyBrand = { ...NOVA, brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.darkBlue, logo: true }) }
    const { user } = renderCompanyPass(`/pass?c=nova-labs#${TOKEN}`, [lightOnly])
    await screen.findByRole('img', { name: 'Visitor pass QR code' })
    // The toggle first, the language switch in the inline-end corner; neither on paper.
    const toggle = screen.getByRole('button', { name: 'Dark mode' })
    expect(toggle.nextElementSibling).toBe(screen.getByRole('button', { name: 'العربية' }))
    expect(toggle.closest('header')).toHaveClass('print:hidden')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    // No fill and no edge in the light scheme: the plate is the dark scheme's alone, in the same room.
    const room = (await screenLogo()).closest('[data-logo-room]')
    expect(room).toHaveAttribute('data-logo-plate', 'dark-scheme')
    expect(room).toHaveClass('border-transparent', 'scheme-dark:bg-white', 'scheme-dark:border-border')
    expect(room).not.toHaveClass('bg-white')
    await user.click(toggle)
    expect(document.documentElement).toHaveAttribute('data-scheme', 'dark')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // On paper the logo stands on the paper itself.
    expect(document.querySelector('[data-identity-lockup="paper"] [data-logo-plate], [data-identity-lockup="paper"] [data-logo-room]')).toBeNull()
  })

  it('asks the server for the company’s public brand and nothing else, and never sends the token', async () => {
    const { requests, fetchMock } = renderCompanyPass(`/pass?c=nova-labs#${TOKEN}`)
    await screenLogo()
    await waitFor(() => expect(document.title).toBe('Visitor pass · Nova Labs'))

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /public/companies/nova-labs/brand'])
    for (const [input, init] of fetchMock.mock.calls) {
      // Not in the address, not in a header, not in a body; and the request is anonymous.
      expect(String(input)).not.toContain(TOKEN)
      expect(JSON.stringify([...new Headers(init?.headers).entries()])).not.toContain(TOKEN)
      expect(init?.body).toBeUndefined()
      expect(init?.credentials).toBe('omit')
      expect(init?.referrerPolicy).toBe('no-referrer')
    }
    // No session check, and no manifest for the browser to fetch.
    expect(requests.some((request) => request.path === '/auth/me')).toBe(false)
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull()
    // The token is nowhere this device keeps things either.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN)
    expect(window.localStorage.getItem(BRANDS_STORAGE_KEY)).toContain('nova-labs')
    // A visitor's device does not become the company's: only a sign-in remembers a company.
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBeNull()
  })

  it('keeps the company in the code it shows: what reception scans is the link itself', async () => {
    const first = renderCompanyPass(`/pass?c=nova-labs#${TOKEN}`)
    const withCompany = (await screen.findByRole('img', { name: 'Visitor pass QR code' })).querySelector('path')?.getAttribute('d')
    expect(withCompany).toBeTruthy()
    first.unmount()

    // Another link's code is another picture: the company is part of what is encoded.
    renderPass(`/pass#${TOKEN}`)
    const plain = (await screen.findByRole('img', { name: 'Visitor pass QR code' })).querySelector('path')?.getAttribute('d')
    expect(plain).toBeTruthy()
    expect(plain).not.toBe(withCompany)
  })

  it('shows a company without a logo by its name, in the default colours, in the visitor’s language', async () => {
    await i18n.changeLanguage('ar')
    renderCompanyPass(`/pass?c=nova-labs#${TOKEN}`, [{ ...NOVA, brand: makeBrand('nova-labs') }])
    await screen.findByRole('img', { name: 'رمز QR لبطاقة الزيارة' })

    const wordmark = await waitFor(() => {
      const element = document.querySelector('[data-identity-lockup="page"] [data-company-wordmark]')
      if (!element) throw new Error('No wordmark yet')
      return element
    })
    expect(wordmark).toHaveTextContent('مختبرات نوفا')
    await waitFor(() => expect(document.title).toBe('بطاقة الزيارة · مختبرات نوفا'))
    expect(document.documentElement.style.getPropertyValue('--brand-shell-shell')).toBe('')
    expect(screen.getByRole('main').querySelectorAll('img')).toHaveLength(0)
  })

  it('is the neutral pass for a slug nobody has, and for an answer that is no brand', async () => {
    const { requests } = mockApi({
      'GET /public/companies/gone/brand': () => errorResponse(404, 'NOT_FOUND', 'Not found.'),
      'GET /public/companies/odd/brand': () => jsonResponse({ slug: 'another-company', name: 'Another' }),
    })
    for (const slug of ['gone', 'odd']) {
      const view = renderRoutes(routes, { initialEntries: [`/pass?c=${slug}#${TOKEN}`] })
      await screen.findByRole('img', { name: 'Visitor pass QR code' })
      await waitFor(() => expect(requests.some((request) => request.path === `/public/companies/${slug}/brand`)).toBe(true))
      await waitFor(() => expect(document.title).toBe('Visitor pass'))
      expect(document.querySelector('[data-identity-lockup]')).toBeNull()
      expect(screen.getByRole('button', { name: 'Print pass' })).toBeInTheDocument()
      view.unmount()
    }
    expect(window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? '').not.toContain('gone')
  })

  it('ignores a company that is no slug: the neutral pass, and no request', async () => {
    const { fetchMock } = renderPass(`/pass?c=Nova%20Labs#${TOKEN}`)
    await screen.findByRole('img', { name: 'Visitor pass QR code' })
    await waitFor(() => expect(document.title).toBe('Visitor pass'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens in the company’s identity at once on a device that has seen it, then checks it with the server', async () => {
    window.localStorage.setItem(BRANDS_STORAGE_KEY, JSON.stringify([{ at: 1, brand: NOVA }]))
    // The company changed its colour since.
    const now = { ...NOVA, brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.orange, logo: true, version: 'v2' }) }
    renderCompanyPass(`/pass?c=nova-labs#${TOKEN}`, [now])

    // Before the server answers: this device's copy.
    expect(await screenLogo()).toHaveAttribute('src', NOVA.brand.logo_url)
    // Then the server's.
    await waitFor(() => expect(document.querySelector('[data-identity-lockup="page"] img')).toHaveAttribute('src', now.brand.logo_url))
    // The pass's head is the company's own colour: orange under dark ink, not a darkened step of it.
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--brand-shell-shell')).toBe(SAMPLE_COLOURS.orange))
    expect(document.documentElement.style.getPropertyValue('--brand-shell-fg')).toBe(now.brand.palette?.on_surface)
  })
})
