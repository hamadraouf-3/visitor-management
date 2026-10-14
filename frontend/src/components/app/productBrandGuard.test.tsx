import { screen, waitFor } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRAND } from '../../brand'
import { adminDashboardRoutes } from '../../features/admin/testRoutes'
import { platformRoutes } from '../../features/platform/testRoutes'
import { i18n } from '../../i18n'
import { rememberCompany, writeCachedBrand } from '../../identity/storage'
import { errorResponse, jsonResponse, makeMe, mockApi, NOT_AUTHENTICATED, type RouteHandler } from '../../test/api'
import { routes } from '../../test/appRoutes'
import { myVisitsRoutes } from '../../test/fixtures'
import { makeBrand, SAMPLE_COLOURS } from '../../test/palettes'
import { renderRoutes } from '../../test/render'
import type { Me, PublicCompanyBrand } from '../../types/api'

/*
 * Phase 12, decision 1: the product's name («زوار موضوع» / "Mawdoo3 Visitors") and the Mawdoo3 logo
 * are never shown to a company's staff or visitors, nor on a page that is nobody's. They remain in
 * the platform owner's area alone.
 *
 * Three guards, each of which fails when that is broken:
 * - by construction: `BrandLockup` and `BrandLogo` render nothing outside `/platform/…`
 *   (`BrandLockup.test.tsx`);
 * - in the source: only the files listed here may import the product's lockup, logo or name, so a
 *   new screen cannot quietly take them;
 * - on screen: every kind of page outside the platform owner's area is rendered, for a company
 *   with an identity, a company without one and nobody, in both languages, and nothing of the
 *   product is in the document: not in the page, its title, its tab icon or its manifest.
 */

// The module's own address as text: this file runs in jsdom, whose `URL` is not Node's.
const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The product's own markers in a document. */
const PRODUCT_WORDS = [BRAND.productName.en, BRAND.productName.ar, BRAND.name.en]
const PRODUCT_FILES = Object.values(BRAND.logo)

function listSources(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith('.d.ts') ? [path] : []
  return readdirSync(path).flatMap((name) => listSources(join(path, name)))
}

/** What nothing outside the platform owner's area may import. */
const PRODUCT_NAMES = ['BrandLockup', 'BrandLogo', 'BRAND', 'brandName', 'productName', 'useProductName']

/** The files that may, each with its reason. */
const MAY_NAME_THE_PRODUCT: Readonly<Record<string, string>> = {
  'brand.ts': 'defines the product’s name and logo files',
  'components/app/BrandLogo.tsx': 'the product’s logo itself; renders nothing outside the platform owner’s area',
  'components/app/BrandLockup.tsx': 'the product’s lockup itself; renders nothing outside the platform owner’s area',
  'components/app/IdentityLockup.tsx': 'shows the product’s lockup for the platform owner’s area only (identity kind "product")',
  'identity/useIdentity.ts': 'the title’s name: the product’s for the platform owner’s area only',
  'i18n/useLanguage.ts': 'defines useProductName',
  'features/platform/PlatformChrome.tsx': 'the platform owner’s shell and sign-in page',
}

/** The names a source imports, from any module. */
function importedNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
      if (name) names.push(name)
    }
  }
  return names
}

/** A source's code: its comments may name the product (they explain the rule). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('in the source', () => {
  const sources = listSources(sourceDir).map((path) => ({ file: relative(sourceDir, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }))

  it('only the listed files import the product’s lockup, logo or name', () => {
    const offenders = sources
      .filter(({ file }) => !(file in MAY_NAME_THE_PRODUCT))
      .flatMap(({ file, text }) => importedNames(text).filter((name) => PRODUCT_NAMES.includes(name)).map((name) => `${file} imports ${name}`))
    expect(offenders).toEqual([])
    // The list holds no file that is gone.
    expect(Object.keys(MAY_NAME_THE_PRODUCT).filter((file) => !sources.some((source) => source.file === file))).toEqual([])
  })

  it('finds an import that would break the rule (the check checks)', () => {
    expect(importedNames("import { BrandLockup } from '../components/app/BrandLockup'\nimport { type Me, useProductName as name } from './x'")).toEqual(['BrandLockup', 'Me', 'useProductName'])
  })

  it('no source writes the product’s name or its logo files itself, outside its definition', () => {
    const offenders = sources
      .filter(({ file }) => file !== 'brand.ts')
      .flatMap(({ file, text }) =>
        [...PRODUCT_WORDS, ...PRODUCT_FILES, '/icons/favicon-', '/icons/icon-'].filter((word) => withoutComments(text).includes(word)).map((word) => `${file}: ${word}`),
      )
    // The document's head for the platform owner's area names the product's icon files.
    expect(offenders.filter((offender) => !offender.startsWith('identity/document.ts: /icons/'))).toEqual([])
  })

  it('no catalog text names the product: the words of every screen are a company’s or nobody’s', () => {
    const catalogs = listCatalogs(join(sourceDir, 'i18n', 'locales'))
    const offenders = catalogs.flatMap((path) => PRODUCT_WORDS.filter((word) => readFileSync(path, 'utf8').includes(word)).map((word) => `${relative(sourceDir, path)}: ${word}`))
    expect(catalogs.length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})

function listCatalogs(path: string): string[] {
  if (statSync(path).isFile()) return path.endsWith('.json') ? [path] : []
  return readdirSync(path).flatMap((name) => listCatalogs(join(path, name)))
}

/* ---- on screen --------------------------------------------------------------------------------- */

const TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'

const NOVA: PublicCompanyBrand = {
  slug: 'nova-labs',
  name: 'Nova Labs',
  name_ar: 'مختبرات نوفا',
  default_language: 'en',
  brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.darkBlue, logo: true, logoDark: true, icon: true }),
}
const PLAIN: PublicCompanyBrand = { slug: 'other-corp', name: 'Other Corp', name_ar: null, default_language: 'en', brand: makeBrand('other-corp') }

function meOf(company: PublicCompanyBrand): Me {
  const me = makeMe(['SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST'])
  return { ...me, company: { ...me.company, slug: company.slug, name: company.name, name_ar: company.name_ar, brand: company.brand } }
}

const publicBrands: Record<string, RouteHandler> = {
  'GET /public/companies/nova-labs/brand': () => jsonResponse(NOVA),
  'GET /public/companies/other-corp/brand': () => jsonResponse(PLAIN),
  'GET /public/companies/no-such-company/brand': () => errorResponse(404, 'NOT_FOUND', 'Not found.'),
}

/** Everything of the product that a document could show. */
function productTraces(): string[] {
  const traces: string[] = []
  const page = `${document.title}\n${document.body.textContent ?? ''}`
  for (const word of PRODUCT_WORDS) if (page.includes(word)) traces.push(`the words “${word}”`)
  if (document.querySelector('[data-brand-lockup], [data-brand-logo]')) traces.push('the product’s lockup or logo')
  for (const image of document.querySelectorAll('img, source')) {
    const address = image.getAttribute('src') ?? image.getAttribute('srcset') ?? ''
    if (address.startsWith('/brand/') || address.startsWith('/icons/')) traces.push(`an image of the product: ${address}`)
  }
  for (const link of document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')) {
    const address = link.getAttribute('href') ?? ''
    if (address === '/manifest.webmanifest' || /^\/icons\/(?!neutral-)/.test(address)) traces.push(`in the head: ${address}`)
  }
  return traces
}

/** A page outside the platform owner's area: its address, and how to know it has rendered. */
interface Page {
  name: string
  address: string
  /** Text of the page's own heading, per language. */
  heading: Record<'en' | 'ar', string>
}

const SIGNED_OUT: readonly Page[] = [
  { name: 'the sign-in page', address: '/login', heading: { en: 'Sign in', ar: 'تسجيل الدخول' } },
  { name: 'the forgot-password page', address: '/forgot-password', heading: { en: 'Reset your password', ar: 'إعادة تعيين كلمة المرور' } },
  { name: 'the reset-password page without a token', address: '/reset-password', heading: { en: 'Link invalid or expired', ar: 'الرابط غير صالح أو منتهي الصلاحية' } },
  { name: 'the visitor’s pass', address: `/pass#${TOKEN}`, heading: { en: 'Visitor pass', ar: 'بطاقة الزيارة' } },
  { name: 'a page that does not exist', address: '/no-such-page', heading: { en: 'Page not found', ar: 'الصفحة غير موجودة' } },
]

const forCompany = (page: Page, slug: string): Page => {
  if (page.address === '/login') return { ...page, address: `/c/${slug}` }
  const [path, fragment] = page.address.split('#')
  return { ...page, address: `${path}?c=${slug}${fragment ? `#${fragment}` : ''}` }
}

const SIGNED_IN: readonly Page[] = [
  { name: 'the shell and a list', address: '/visits', heading: { en: 'My visits', ar: 'زياراتي' } },
  { name: 'the admin dashboard', address: '/admin', heading: { en: 'Admin dashboard', ar: 'لوحة تحكم الإدارة' } },
  { name: 'the evacuation list with its printed sheet', address: '/inside', heading: { en: 'Inside now', ar: 'داخل المبنى الآن' } },
  { name: 'the password change', address: '/change-password', heading: { en: 'Change password', ar: 'تغيير كلمة المرور' } },
]

async function shown(page: Page, language: 'en' | 'ar') {
  await screen.findByRole('heading', { level: 1, name: page.heading[language] })
  // The title and the document's head are set by effects, a moment after the heading.
  await waitFor(() => expect(document.title).toContain(page.heading[language]))
}

describe.each(['en', 'ar'] as const)('on screen, in %s', (language) => {
  it.each(SIGNED_OUT)('nothing of the product on $name, signed out and without a company', async (page) => {
    await i18n.changeLanguage(language)
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    renderRoutes(routes, { initialEntries: [page.address] })
    await shown(page, language)
    expect(productTraces()).toEqual([])
    // A neutral page names nobody at all.
    expect(document.title).toBe(page.heading[language])
    expect(document.querySelector('[data-identity-lockup], [data-company-wordmark]')).toBeNull()
  })

  it.each([NOVA, PLAIN].flatMap((company) => SIGNED_OUT.filter((page) => page.address !== '/no-such-page').map((page) => ({ company, page: forCompany(page, company.slug) }))))(
    'nothing of the product on $page.name of $company.name ($page.address)',
    async ({ company, page }) => {
      await i18n.changeLanguage(language)
      mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
      renderRoutes(routes, { initialEntries: [page.address] })
      await shown(page, language)
      const name = language === 'ar' ? (company.name_ar ?? company.name) : company.name
      await waitFor(() => expect(document.title).toBe(`${page.heading[language]} · ${name}`))
      expect(productTraces()).toEqual([])
      // The company's own identity is there instead: its logo, or its name.
      expect(document.querySelector('[data-identity-lockup]')).not.toBeNull()
    },
  )

  it('nothing of the product, and nothing of any company, for a slug nobody has', async () => {
    await i18n.changeLanguage(language)
    mockApi({ 'GET /auth/me': NOT_AUTHENTICATED, ...publicBrands })
    renderRoutes(routes, { initialEntries: ['/c/no-such-company'] })
    await shown(SIGNED_OUT[0]!, language)
    await waitFor(() => expect(document.querySelector('[data-neutral-mark]')).not.toBeNull())
    expect(productTraces()).toEqual([])
    expect(document.title).toBe(SIGNED_OUT[0]!.heading[language])
  })

  it.each([NOVA, PLAIN].flatMap((company) => SIGNED_IN.map((page) => ({ company, page }))))('nothing of the product on $page.name for a user of $company.name', async ({ company, page }) => {
    const me = meOf(company)
    mockApi({
      'GET /auth/me': () => jsonResponse({ ...me, user: { ...me.user, preferred_language: language } }),
      ...myVisitsRoutes(),
      ...adminDashboardRoutes(),
      'GET /reception/inside': () => jsonResponse({ count: 0, items: [] }),
    })
    renderRoutes(routes, { initialEntries: [page.address] })
    await shown(page, language)
    const name = language === 'ar' ? (company.name_ar ?? company.name) : company.name
    await waitFor(() => expect(document.title).toBe(`${page.heading[language]} · ${name}`))
    expect(productTraces()).toEqual([])
  })
})

describe('an address that does not exist, on a device that has signed in', () => {
  it.each([NOVA, PLAIN])('shows the device’s company ($name), from its own copy, and nothing of the product', async (company) => {
    // What a sign-in leaves on the device: its company and that company's identity.
    writeCachedBrand(company)
    rememberCompany(company.slug)
    const { requests } = mockApi({})
    renderRoutes(routes, { initialEntries: ['/no-such-page'] })
    await screen.findByRole('heading', { level: 1, name: 'Page not found' })
    await waitFor(() => expect(document.title).toBe(`Page not found · ${company.name}`))
    expect(document.querySelector('[data-identity-lockup="page"]')).not.toBeNull()
    expect(productTraces()).toEqual([])
    // The page is public: it asks the server nothing.
    expect(requests).toEqual([])
  })
})

describe('the platform owner’s area keeps the product’s brand', () => {
  it('shows the lockup and names the product in the title, also on a device that knows a company', async () => {
    writeCachedBrand(NOVA)
    rememberCompany('nova-labs')
    mockApi({ ...platformRoutes(), 'GET /auth/me': () => jsonResponse(meOf(NOVA)) })
    renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    await screen.findByRole('heading', { level: 1, name: 'Companies' })
    await waitFor(() => expect(document.title).toBe('Companies · Mawdoo3 Visitors'))
    expect(document.querySelector('[data-brand-lockup="shell"]')).toHaveTextContent('Mawdoo3 Visitors')
    expect(productTraces()).toEqual(expect.arrayContaining(['the product’s lockup or logo', 'in the head: /manifest.webmanifest']))
    // And none of a company's colours.
    expect(document.documentElement.style.getPropertyValue('--brand-light-accent')).toBe('')
  })

  it('the check finds the product where it is (the check checks)', async () => {
    mockApi({ 'GET /platform/auth/me': NOT_AUTHENTICATED })
    renderRoutes(routes, { initialEntries: ['/platform/login'] })
    await screen.findByRole('heading', { level: 1, name: 'Sign in to the platform' })
    await waitFor(() => expect(document.title).toBe('Sign in to the platform · Mawdoo3 Visitors'))
    const traces = productTraces()
    expect(traces).toContain('the words “Mawdoo3 Visitors”')
    expect(traces).toContain('an image of the product: /brand/logo-teal.png')
    expect(traces).toContain('in the head: /icons/favicon-32.png')
  })
})
