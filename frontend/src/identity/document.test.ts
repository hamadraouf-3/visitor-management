import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY } from '../appearance/appearance'
import { errorResponse, jsonResponse, mockApi } from '../test/api'
import { makeBrand, SAMPLE_COLOURS } from '../test/palettes'
import type { PublicCompanyBrand } from '../types/api'
import { applyBootIdentity, primeBootIdentity } from './boot'
import { paletteProblems } from './brand'
import { applyDocumentIdentity, companyManifestUrl, documentIdentityOf, IDENTITY_CHANGE_ATTRIBUTE, PRODUCT_MANIFEST } from './document'
import { identityOfPublicBrand, NEUTRAL, PRODUCT } from './identity'
import { readCachedBrand, rememberCompany, writeCachedBrand } from './storage'
import { BRAND_VARIABLE_NAMES, brandTokens, DEFAULT_THEME_COLORS, PENDING_PALETTE, PLATFORM_THEME_COLORS } from './tokens'
import { publicBrandQuery } from './useIdentity'

/* An identity on the document: the palette's properties, the browser chrome's colour, the tab's icon, the manifest (Phase 12). */

const NOVA: PublicCompanyBrand = {
  slug: 'nova-labs',
  name: 'Nova Labs',
  name_ar: null,
  default_language: 'en',
  brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.darkBlue, logo: true, icon: true, version: 'v7' }),
}
const PLAIN: PublicCompanyBrand = { slug: 'other-corp', name: 'Other Corp', name_ar: null, default_language: 'en', brand: makeBrand('other-corp') }
/** A company whose colour is a light one: its surfaces are that colour, under dark ink. */
const SAHARA: PublicCompanyBrand = { slug: 'sahara', name: 'Sahara Sun', name_ar: null, default_language: 'en', brand: makeBrand('sahara', { color: SAMPLE_COLOURS.amber }) }

/** Two frames on: what was scheduled for after the next paint has run. */
const twoFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

const root = () => document.documentElement
const links = (rel: string) => [...document.head.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)].map((link) => link.getAttribute('href'))
/** The browser chrome's colour: one meta, for the scheme the page is drawn in (Phase 13). */
const themeColor = () => [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content).join(' ')

/** The head as `index.html` ships it: neutral icons, the default colours, no manifest. */
beforeEach(() => {
  document.head.innerHTML = `
    <meta name="theme-color" content="#188086" />
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" type="image/png" sizes="16x16" href="/icons/neutral-16.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/neutral-32.png" />
    <link rel="apple-touch-icon" href="/icons/neutral-apple-touch-icon.png" />
    <title>الزوار | Visitors</title>`
})

afterEach(() => {
  document.head.innerHTML = ''
  window.localStorage.clear()
})

describe('what a page’s head says', () => {
  it('for a company: its palette, its own icon, its own manifest', () => {
    expect(documentIdentityOf(identityOfPublicBrand(NOVA), '/visits')).toEqual({
      palette: NOVA.brand.palette,
      themeColors: { light: NOVA.brand.palette!.surface, dark: NOVA.brand.palette!.deep },
      icons: { url: '/api/v1/public/companies/nova-labs/brand/icon.png?v=v7' },
      manifest: '/api/v1/public/companies/nova-labs/manifest.webmanifest',
    })
    expect(companyManifestUrl('nova-labs')).toBe('/api/v1/public/companies/nova-labs/manifest.webmanifest')
  })

  it('for a company without a colour and an icon: the default palette, the neutral icon, still its manifest', () => {
    expect(documentIdentityOf(identityOfPublicBrand(PLAIN), '/c/other-corp')).toEqual({
      palette: null,
      themeColors: DEFAULT_THEME_COLORS,
      icons: 'neutral',
      manifest: '/api/v1/public/companies/other-corp/manifest.webmanifest',
    })
  })

  it('on the visitor’s pass: the company’s colours and icon, and no manifest', () => {
    expect(documentIdentityOf(identityOfPublicBrand(NOVA), '/pass').manifest).toBeNull()
  })

  it('for a neutral page: nothing of anybody', () => {
    expect(documentIdentityOf(NEUTRAL, '/login')).toEqual({ palette: null, themeColors: DEFAULT_THEME_COLORS, icons: 'neutral', manifest: null })
  })

  it('while a company’s identity is on its way: nobody’s colours, not the default ones', () => {
    expect(documentIdentityOf(NEUTRAL, '/c/nova-labs', true)).toEqual({
      palette: PENDING_PALETTE,
      themeColors: { light: PENDING_PALETTE.surface, dark: PENDING_PALETTE.deep },
      icons: 'neutral',
      manifest: null,
    })
    // A palette like any other: it keeps the guarantees, and it has nothing of the product's teal.
    expect(paletteProblems(PENDING_PALETTE)).toEqual([])
    expect(Object.values(PENDING_PALETTE).join(' ')).not.toMatch(/#188086|#136a6f|#0f3b3f/)
    // A company and the product are never "on their way".
    expect(documentIdentityOf(identityOfPublicBrand(NOVA), '/visits', true).palette).toBe(NOVA.brand.palette)
    expect(documentIdentityOf(PRODUCT, '/platform/companies', true).palette).toBeNull()
  })

  it('in the platform owner’s area: the product’s icons and manifest, the default palette, the chrome in its own shell’s colours', () => {
    expect(documentIdentityOf(PRODUCT, '/platform/companies')).toEqual({ palette: null, themeColors: PLATFORM_THEME_COLORS, icons: 'product', manifest: PRODUCT_MANIFEST })
    expect(documentIdentityOf(PRODUCT, '/platform/login').themeColors).toBe(PLATFORM_THEME_COLORS)
  })
})

describe('an identity applied to the document', () => {
  it('puts a company’s palette on the root element through the CSSOM, never as markup', () => {
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/visits'), 'light')
    const tokens = brandTokens(NOVA.brand.palette!)
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(tokens.light.accent)
    expect(root().style.getPropertyValue('--brand-shell-shell')).toBe(NOVA.brand.palette!.surface)
    expect(root().style.getPropertyValue('--brand-deep-shell')).toBe(NOVA.brand.palette!.deep)
    expect(root().style.getPropertyValue('--brand-dark-accent')).toBe(tokens.dark.accent)
    expect(root().style.getPropertyValue('--brand-shell-scheme')).toBe('dark')
    for (const name of BRAND_VARIABLE_NAMES) expect(root().style.getPropertyValue(name)).not.toBe('')
    // No style element was added: the page's policy is `style-src 'self'`.
    expect(document.querySelectorAll('style')).toHaveLength(0)
  })

  it('paints a light colour’s shell and buttons in the colour itself, under dark ink, and tells the browser’s chrome', () => {
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(SAHARA), '/visits'), 'light')
    const palette = SAHARA.brand.palette!
    expect(palette.surface).toBe(SAMPLE_COLOURS.amber)
    expect(root().style.getPropertyValue('--brand-shell-shell')).toBe(SAMPLE_COLOURS.amber)
    expect(root().style.getPropertyValue('--brand-shell-fg')).toBe(palette.on_surface)
    expect(root().style.getPropertyValue('--brand-shell-focus')).toBe(palette.on_surface)
    expect(root().style.getPropertyValue('--brand-shell-scheme')).toBe('light')
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(SAMPLE_COLOURS.amber)
    expect(root().style.getPropertyValue('--brand-light-on-accent')).toBe(palette.on_surface)
    expect(themeColor()).toBe(SAMPLE_COLOURS.amber)
    // The dark scheme keeps the deep step.
    expect(root().style.getPropertyValue('--brand-deep-shell')).toBe(palette.deep)
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(SAHARA), '/visits'), 'dark')
    expect(themeColor()).toBe(palette.deep)
  })

  it('replaces a page’s colours at once: no transition runs while they change, and they run again after', async () => {
    applyDocumentIdentity(document, documentIdentityOf(NEUTRAL, '/c/nova-labs', true), 'light')
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(PENDING_PALETTE.surface)
    await twoFrames()
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false)

    // The company's identity arrives: its colours are on the document with transitions off.
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/c/nova-labs'), 'light')
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(NOVA.brand.palette!.surface)
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(true)
    await twoFrames()
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false)

    // The same identity again changes nothing, so nothing is switched off.
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/c/nova-labs'), 'light')
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false)
    // Back to the default colours is a change like any other.
    applyDocumentIdentity(document, documentIdentityOf(NEUTRAL, '/login'), 'light')
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(true)
    await twoFrames()
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false)
  })

  it('gives the browser’s chrome the shell’s colours, the tab the company’s icon, and links its manifest', () => {
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/visits'), 'light')
    expect(themeColor()).toBe(NOVA.brand.palette!.surface)
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/visits'), 'dark')
    expect(themeColor()).toBe(NOVA.brand.palette!.deep)
    expect(links('icon')).toEqual(['/api/v1/public/companies/nova-labs/brand/icon.png?v=v7'])
    expect(links('apple-touch-icon')).toEqual(['/api/v1/public/companies/nova-labs/brand/icon.png?v=v7'])
    expect(links('manifest')).toEqual(['/api/v1/public/companies/nova-labs/manifest.webmanifest'])
  })

  it('leaves the stylesheet’s own colours for a company without a colour, and takes them back from one that had one', () => {
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/visits'), 'light')
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(PLAIN), '/visits'), 'light')
    for (const name of BRAND_VARIABLE_NAMES) expect(root().style.getPropertyValue(name)).toBe('')
    expect(themeColor()).toBe('#188086')
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(PLAIN), '/visits'), 'dark')
    expect(themeColor()).toBe('#0f3b3f')
    expect(links('icon')).toEqual(['/icons/neutral-16.png', '/icons/neutral-32.png', '/icons/neutral-48.png', '/icons/neutral-192.png'])
    expect(links('manifest')).toEqual(['/api/v1/public/companies/other-corp/manifest.webmanifest'])
  })

  it('is neutral again after a company: no palette, the neutral icon, no manifest', () => {
    applyDocumentIdentity(document, documentIdentityOf(identityOfPublicBrand(NOVA), '/visits'), 'light')
    applyDocumentIdentity(document, documentIdentityOf(NEUTRAL, '/login'), 'light')
    expect(root().getAttribute('style') ?? '').toBe('')
    expect(links('icon')).toContain('/icons/neutral-32.png')
    expect(links('apple-touch-icon')).toEqual(['/icons/neutral-apple-touch-icon.png'])
    expect(links('manifest')).toEqual([])
  })

  it('shows the product’s own icons and manifest in the platform owner’s area only', () => {
    applyDocumentIdentity(document, documentIdentityOf(PRODUCT, '/platform/companies'), 'light')
    expect(links('icon')).toEqual(['/icons/favicon-16.png', '/icons/favicon-32.png', '/icons/favicon-48.png', '/icons/icon-192.png'])
    expect(links('apple-touch-icon')).toEqual(['/icons/apple-touch-icon.png'])
    expect(links('manifest')).toEqual(['/manifest.webmanifest'])
    for (const name of BRAND_VARIABLE_NAMES) expect(root().style.getPropertyValue(name)).toBe('')
    // The chrome is the platform's shell: the deep teal, the slate in the dark scheme.
    expect(themeColor()).toBe('#0f3b3f')
    applyDocumentIdentity(document, documentIdentityOf(PRODUCT, '/platform/companies'), 'dark')
    expect(themeColor()).toBe('#33444e')
    // Leaving the area takes them away again.
    applyDocumentIdentity(document, documentIdentityOf(NEUTRAL, '/login'), 'light')
    expect(links('icon').join(' ')).not.toContain('favicon')
    expect(links('manifest')).toEqual([])
    expect(themeColor()).toBe('#188086')
  })

  it('touches nothing when the same identity is applied again', () => {
    const identity = documentIdentityOf(identityOfPublicBrand(NOVA), '/visits')
    applyDocumentIdentity(document, identity, 'light')
    const [icon, manifest] = [document.head.querySelector('link[rel="icon"]'), document.head.querySelector('link[rel="manifest"]')]
    applyDocumentIdentity(document, identity, 'light')
    expect(document.head.querySelector('link[rel="icon"]')).toBe(icon)
    expect(document.head.querySelector('link[rel="manifest"]')).toBe(manifest)
  })
})

describe('the identity a page starts with, before anything renders', () => {
  it('is this device’s copy of the company the address names', () => {
    writeCachedBrand(NOVA)
    applyBootIdentity({ pathname: '/c/nova-labs', search: '' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe(NOVA.brand.palette!.surface)
    expect(links('manifest')).toEqual(['/api/v1/public/companies/nova-labs/manifest.webmanifest'])
  })

  it('is the device’s own company on a page of the app', () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    applyBootIdentity({ pathname: '/visits', search: '' })
    expect(root().style.getPropertyValue('--brand-shell-shell')).toBe(NOVA.brand.palette!.surface)
    expect(links('icon')).toEqual(['/api/v1/public/companies/nova-labs/brand/icon.png?v=v7'])
  })

  it('gives the browser’s chrome the colour of the scheme the device’s appearance draws the page in (Phase 13)', () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    applyBootIdentity({ pathname: '/visits', search: '' })
    expect(themeColor()).toBe(NOVA.brand.palette!.surface)
    // A device that chose Dark: the deep step, whatever the device's own scheme (jsdom has none: light).
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark')
    applyBootIdentity({ pathname: '/visits', search: '' })
    expect(themeColor()).toBe(NOVA.brand.palette!.deep)
    // One meta, without a media query: the device's own scheme does not pick another colour.
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
    expect(document.head.querySelector('meta[name="theme-color"]')?.hasAttribute('media')).toBe(false)
  })

  it('is the pass’s own company on the visitor’s pass, whatever company the device remembers', () => {
    writeCachedBrand(NOVA)
    writeCachedBrand(PLAIN)
    rememberCompany('nova-labs')
    applyBootIdentity({ pathname: '/pass', search: '?c=other-corp' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe('')
    applyBootIdentity({ pathname: '/pass', search: '' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe('')
    expect(links('manifest')).toEqual([])
  })

  it('is neutral on a device that knows no company', () => {
    applyBootIdentity({ pathname: '/visits', search: '' })
    applyBootIdentity({ pathname: '/login', search: '' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe('')
    expect(links('icon')).toContain('/icons/neutral-32.png')
    expect(links('manifest')).toEqual([])
  })

  it('is nobody’s colours for a company the device has never seen: neither the default ones nor another company’s', () => {
    writeCachedBrand(PLAIN)
    rememberCompany('other-corp')
    for (const location of [
      { pathname: '/c/nova-labs', search: '' },
      { pathname: '/forgot-password', search: '?c=nova-labs' },
      { pathname: '/pass', search: '?c=nova-labs' },
    ]) {
      applyBootIdentity(location)
      // The primary button, the links and a pass's head: the neutral slate until the company's colours are known.
      expect(root().style.getPropertyValue('--brand-light-accent')).toBe(PENDING_PALETTE.surface)
      expect(root().style.getPropertyValue('--brand-light-accent-text')).toBe(PENDING_PALETTE.strong)
      expect(root().style.getPropertyValue('--brand-shell-shell')).toBe(PENDING_PALETTE.surface)
      expect(themeColor()).toBe(PENDING_PALETTE.surface)
      expect(links('icon')).toContain('/icons/neutral-32.png')
      expect(links('manifest')).toEqual([])
    }
    // A slug that is none names no company: the plain neutral page.
    applyBootIdentity({ pathname: '/login', search: '?c=Not A Slug' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe('')
  })

  it('is the product’s in the platform owner’s area, whatever the device remembers', () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    applyBootIdentity({ pathname: '/platform/companies', search: '' })
    expect(root().style.getPropertyValue('--brand-light-accent')).toBe('')
    expect(links('manifest')).toEqual(['/manifest.webmanifest'])
    expect(links('icon')).toContain('/icons/favicon-32.png')
  })
})

const NOVA_ROUTE = 'GET /public/companies/nova-labs/brand'
const brandRequests = (requests: { path: string }[]) => requests.filter((request) => request.path.startsWith('/public/')).length
const accent = () => root().style.getPropertyValue('--brand-light-accent')

describe('a company this device has never seen, before the first render', () => {
  it('waits for its identity: the page then starts in its colours, with its icon, and the device keeps a copy', async () => {
    const { requests } = mockApi({ [NOVA_ROUTE]: () => jsonResponse(NOVA) })
    const queryClient = new QueryClient()
    for (const location of [
      { pathname: '/c/nova-labs', search: '' },
      { pathname: '/login', search: '?c=nova-labs' },
      { pathname: '/pass', search: '?c=nova-labs' },
    ]) {
      window.localStorage.clear()
      queryClient.clear()
      applyDocumentIdentity(document, documentIdentityOf(NEUTRAL, location.pathname), 'light')
      await primeBootIdentity(queryClient, location)
      expect(accent()).toBe(NOVA.brand.palette!.surface)
      expect(links('icon')).toEqual(['/api/v1/public/companies/nova-labs/brand/icon.png?v=v7'])
      expect(readCachedBrand('nova-labs')).toEqual(NOVA)
      // The page's own query finds the answer: nothing is asked twice.
      expect(queryClient.getQueryData(publicBrandQuery('nova-labs').queryKey)).toEqual(NOVA)
    }
    expect(brandRequests(requests)).toBe(3)
    // The visitor's pass still links no manifest; a sign-in page links the company's.
    expect(links('manifest')).toEqual([])
    // Asked without a session: no cookie goes with the request.
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.credentials === 'omit')).toBe(true)
  })

  it('asks nothing for a page that names no company, for the platform owner’s area, and for a company the device has a copy of', async () => {
    const { requests } = mockApi({})
    const queryClient = new QueryClient()
    writeCachedBrand(NOVA)
    for (const location of [
      { pathname: '/login', search: '' },
      { pathname: '/visits', search: '' },
      { pathname: '/pass', search: '' },
      { pathname: '/platform/login', search: '?c=nova-labs' },
      { pathname: '/c/nova-labs', search: '' },
      { pathname: '/login', search: '?c=Not A Slug' },
    ]) {
      await primeBootIdentity(queryClient, location)
    }
    expect(requests).toEqual([])
  })

  it('does not hold the page for a slow answer: it renders without an identity, and the late answer is the app’s to apply', async () => {
    const held: { answer?: (response: Response) => void } = {}
    mockApi({ [NOVA_ROUTE]: () => new Promise<Response>((resolve) => (held.answer = resolve)) })
    const queryClient = new QueryClient()
    const started = Date.now()
    await primeBootIdentity(queryClient, { pathname: '/c/nova-labs', search: '' }, 40)
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(accent()).toBe('')
    // The request is still the query's: the page joins it instead of asking again.
    expect(queryClient.isFetching({ queryKey: publicBrandQuery('nova-labs').queryKey })).toBe(1)
    held.answer?.(jsonResponse(NOVA))
    await vi.waitFor(() => expect(queryClient.getQueryData(publicBrandQuery('nova-labs').queryKey)).toEqual(NOVA))
    // Once the page renders, the boot no longer touches the document.
    expect(accent()).toBe('')
  })

  it('renders the neutral page for a slug nobody has, and for an answer that fails', async () => {
    mockApi({
      'GET /public/companies/no-such-company/brand': () => errorResponse(404, 'NOT_FOUND', 'Not found.'),
      'GET /public/companies/broken/brand': () => errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong.'),
    })
    const queryClient = new QueryClient()
    await primeBootIdentity(queryClient, { pathname: '/c/no-such-company', search: '' })
    await primeBootIdentity(queryClient, { pathname: '/c/broken', search: '' })
    expect(accent()).toBe('')
    expect(links('icon')).toContain('/icons/neutral-32.png')
    expect(readCachedBrand('no-such-company')).toBeNull()
    expect(readCachedBrand('broken')).toBeNull()
  })
})
