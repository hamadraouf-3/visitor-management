import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContextOptions, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Language } from '../src/i18n/languages.ts'
import type { CompanyBrand, Me, PlatformCompany, PlatformMe, PublicCompanyBrand } from '../src/types/api.ts'
import { ICON_PNG, LOGO_DARK_SVG, LOGO_PNG, NOT_AN_IMAGE, rgb } from './support/identity.ts'
import { mockPalette, SAMPLE_COLOURS, UNBRANDED } from './support/mock-brand.ts'

/*
 * A company's identity in the browser (Phase 12, decisions F12-1 on): what jsdom cannot show. The API
 * is mocked, so this spec needs only the Vite server; the palettes are the test suite's stand-ins,
 * which keep the contract's guarantees (the scenarios in e2e/flows and e2e/quality use the server's).
 *
 * - The shell in three companies' colours (a dark blue, an orange, a yellow), with and without a logo
 *   for dark surfaces, and a company without an identity: the shell's colour is the palette's surface,
 *   the company's own colour (a yellow company is yellow, under dark ink), in the light scheme and the
 *   deep step in the dark one; the logo fits its place; axe finds nothing; both languages.
 * - No flash of another identity: a device that knows its company paints its colours before the
 *   session check answers, and a company's sign-in page does not move when its logo arrives.
 * - The identity page prepares pictures in the browser: what is uploaded is a PNG the canvas made,
 *   inside the contract's limits, never the chosen file's bytes; an SVG is rasterised; a file that
 *   is no picture is refused.
 */

const FIRST_RENDER = { timeout: 30_000 }
const LANGUAGES: Language[] = ['en', 'ar']
const uuid = (prefix: string, index: number) => `${prefix}000000-0000-4000-8000-${String(index).padStart(12, '0')}`

interface MockCompany {
  id: string
  slug: string
  name: string
  name_ar: string | null
  colour: string | null
  logo: boolean
}

const COMPANIES = {
  blue: { id: uuid('9b', 1), slug: 'nova-labs', name: 'Nova Labs', name_ar: 'مختبرات نوفا', colour: SAMPLE_COLOURS.darkBlue, logo: true },
  orange: { id: uuid('9b', 2), slug: 'petra', name: 'Petra Logistics', name_ar: 'البتراء للخدمات اللوجستية', colour: SAMPLE_COLOURS.orange, logo: true },
  yellow: { id: uuid('9b', 3), slug: 'sahara', name: 'Sahara Sun', name_ar: 'شمس الصحراء', colour: SAMPLE_COLOURS.yellow, logo: true },
  plain: { id: uuid('9b', 4), slug: 'other-corp', name: 'Other Corp', name_ar: null, colour: null, logo: false },
} satisfies Record<string, MockCompany>

function brandOf(company: MockCompany, darkLogo: boolean): CompanyBrand {
  const file = (kind: string) => `/api/v1/public/companies/${company.slug}/brand/${kind}.png?v=v1`
  return {
    logo_url: company.logo ? file('logo') : null,
    logo_dark_url: company.logo && darkLogo ? file('logo_dark') : null,
    icon_url: company.logo ? file('icon') : null,
    color: company.colour,
    palette: company.colour ? mockPalette(company.colour) : null,
    version: 'v1',
  }
}

const publicBrand = (company: MockCompany, darkLogo: boolean): PublicCompanyBrand => ({ slug: company.slug, name: company.name, name_ar: company.name_ar, default_language: 'en', brand: brandOf(company, darkLogo) })

const meOf = (company: MockCompany, language: Language, darkLogo: boolean): Me => ({
  user: { id: uuid('00', 1), full_name: 'Lina Haddad', email: 'lina.haddad@example.com', phone: null, roles: ['SYSTEM_ADMIN', 'EMPLOYEE'], department: null, must_change_password: false, preferred_language: language },
  company: { id: company.id, name: company.name, name_ar: company.name_ar, slug: company.slug, timezone: 'Asia/Amman', default_language: 'en', brand: brandOf(company, darkLogo), address: null, address_ar: null, tracking_allowed: false },
})

const platformMe = (language: Language): PlatformMe => ({ admin: { id: uuid('9a', 1), full_name: 'Platform Owner', email: 'platform@demo.local', must_change_password: false, preferred_language: language } })

const platformCompany = (company: MockCompany): PlatformCompany => ({
  id: company.id,
  name: company.name,
  name_ar: company.name_ar,
  slug: company.slug,
  timezone: 'Asia/Amman',
  default_language: 'en',
  is_active: true,
  deactivated_at: null,
  created_at: '2026-10-13T08:00:00Z',
  updated_at: '2026-10-13T08:00:00Z',
  counts: { active_users: 12, visits_last_30_days: 84 },
  brand: brandOf(company, false),
  tracking_allowed: false,
})

const notMocked = (route: Route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
const signedOut = (route: Route) => route.fulfill({ status: 401, json: { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in.', details: {} }, request_id: 'e2e' } })

const LOGO_BYTES = readFileSync(LOGO_PNG)
const ICON_BYTES = readFileSync(ICON_PNG)

interface MockOptions {
  me?: Me | null
  platform?: PlatformMe | null
  darkLogo?: boolean
  /** Holds an answer back until the test lets it go (the session check, a company's public brand). */
  hold?: { path: string; release: Promise<void> }
  /** What the identity page sent (PUT, DELETE and PATCH of a brand). */
  sent?: { method: string; path: string; contentType: string | undefined; body: Buffer | null }[]
}

async function mock(page: Page, { me = null, platform = null, darkLogo = true, hold, sent }: MockOptions = {}) {
  const companies = Object.values(COMPANIES)
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    if (hold && path === hold.path) await hold.release

    const file = /^\/public\/companies\/([a-z0-9-]+)\/brand\/(logo|logo_dark|icon)\.png$/.exec(path)
    if (file) {
      const company = companies.find((item) => item.slug === file[1])
      if (!company?.logo) return notMocked(route)
      // The same picture for the two logos: what matters here is where each is drawn.
      return route.fulfill({ status: 200, contentType: 'image/png', body: file[2] === 'icon' ? ICON_BYTES : LOGO_BYTES })
    }
    const brand = /^\/public\/companies\/([a-z0-9-]+)\/brand$/.exec(path)
    if (brand) {
      const company = companies.find((item) => item.slug === brand[1])
      return company ? route.fulfill({ json: publicBrand(company, darkLogo) }) : notMocked(route)
    }
    if (path.endsWith('/manifest.webmanifest')) return route.fulfill({ status: 200, contentType: 'application/manifest+json', body: '{"name":"Company","icons":[]}' })

    if (path === '/auth/me') return me ? route.fulfill({ json: me }) : signedOut(route)
    if (path === '/dashboard/employee') return route.fulfill({ json: { counts: { today: 2, upcoming: 5, inside: 1, completed_30d: 12, cancelled_30d: 2, needs_attention: 1 }, today: [] } })
    if (path === '/visits') return route.fulfill({ json: { items: [], page: 1, page_size: 25, total: 0 } })

    if (path === '/platform/auth/me') return platform ? route.fulfill({ json: platform }) : signedOut(route)
    if (path === '/platform/brand/palette') return route.fulfill({ json: mockPalette((request.postDataJSON() as { color: string }).color) })
    const scoped = /^\/platform\/companies\/([0-9a-f-]+)(\/.*)?$/.exec(path)
    const company = scoped ? companies.find((item) => item.id === scoped[1]) : undefined
    if (scoped && company) {
      const rest = scoped[2] ?? ''
      if (rest === '') return route.fulfill({ json: platformCompany(company) })
      if (rest.startsWith('/brand') && request.method() !== 'GET') {
        sent?.push({ method: request.method(), path, contentType: request.headers()['content-type'], body: request.postDataBuffer() })
        return route.fulfill({ json: brandOf(company, false) })
      }
    }
    return notMocked(route)
  })
}

/** An answer held back until `release()` is called. */
function gate(): { held: Promise<void>; release: () => void } {
  const lock: { open?: () => void } = {}
  const held = new Promise<void>((resolve) => {
    lock.open = resolve
  })
  return { held, release: () => lock.open?.() }
}

async function openWith(browser: Browser, projectUse: BrowserContextOptions, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ baseURL: projectUse.baseURL, locale: 'en-US', viewport: projectUse.viewport, hasTouch: projectUse.hasTouch, ...options })
  return context.newPage()
}

/** The shell on screen: the sidebar on a desktop, the top bar below. */
const shell = (page: Page) => page.locator('aside:visible, header[data-app-bar]:visible').first()
const shellColour = (page: Page) => shell(page).evaluate((element) => getComputedStyle(element).backgroundColor)
const token = (page: Page, name: string) => page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name)

async function expectNoAxeViolations(page: Page, what: string) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.any[0]?.message ?? ''}`).join(', ')}`), `axe: ${what}`).toEqual([])
}

/* The shell in a company's identity ---------------------------------------------------------- */

for (const [key, company] of Object.entries(COMPANIES).filter(([, item]) => item.colour !== null)) {
  for (const darkLogo of [true, false]) {
    test(`shell: ${key} (${company.colour}), ${darkLogo ? 'with' : 'without'} a logo for dark surfaces, in both schemes and languages`, async ({ browser }, testInfo) => {
      const palette = mockPalette(company.colour!)
      for (const language of LANGUAGES) {
        for (const scheme of ['light', 'dark'] as const) {
          const page = await openWith(browser, testInfo.project.use, { colorScheme: scheme })
          await mock(page, { me: meOf(company, language, darkLogo), darkLogo })
          await page.goto('/visits')
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)

          // The shell is the palette's: the company's own colour (its surface), the deep step in the dark colour scheme.
          expect(await shellColour(page), `${language} ${scheme}`).toBe(rgb(scheme === 'light' ? palette.surface : palette.deep))
          expect(await token(page, '--color-accent')).toBe(scheme === 'light' ? palette.surface : palette.bright)
          expect(await token(page, '--brand-light-accent')).toBe(palette.surface)
          // Everything on the shell is in its ink: white on a dark colour, the dark ink on a light one.
          const lightShell = scheme === 'light' && palette.on_surface !== '#ffffff'
          expect(await shell(page).evaluate((element) => getComputedStyle(element).color)).toBe(rgb(scheme === 'light' ? palette.on_surface : '#ffffff'))

          // The logo: the dark-surface one on a dark shell itself; else the logo for light surfaces on a
          // white plate (a light shell never carries the dark-surface logo); loaded, and inside the shell.
          const logo = shell(page).locator('[data-identity-lockup="shell"] img')
          await expect(logo).toBeVisible()
          const showsDarkLogo = darkLogo && !lightShell
          await expect.poll(() => logo.evaluate((image: HTMLImageElement) => new URL(image.currentSrc).pathname)).toContain(showsDarkLogo ? '/brand/logo_dark.png' : '/brand/logo.png')
          await expect(logo).toHaveAttribute('alt', language === 'ar' ? company.name_ar! : company.name)
          expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
          const plate = shell(page).locator('[data-logo-plate]')
          if (showsDarkLogo) {
            // No plate, or one that has let go of its fill (a light company's, in the dark scheme).
            expect(await plate.evaluateAll((plates) => plates.map((element) => getComputedStyle(element).backgroundColor))).toEqual((await plate.count()) === 0 ? [] : ['rgba(0, 0, 0, 0)'])
          } else {
            expect(await plate.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
          }
          const [logoBox, shellBox] = [await logo.boundingBox(), await shell(page).boundingBox()]
          expect(logoBox!.x).toBeGreaterThanOrEqual(shellBox!.x)
          expect(logoBox!.x + logoBox!.width).toBeLessThanOrEqual(shellBox!.x + shellBox!.width + 0.5)
          expect(logoBox!.height).toBeGreaterThanOrEqual(18)

          await expect(page).toHaveTitle(new RegExp(` · ${language === 'ar' ? company.name_ar : company.name}$`))
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
          await expectNoAxeViolations(page, `${key} ${language} ${scheme}`)
          await page.context().close()
        }
      }
    })
  }
}

test('shell: a company without an identity is its own name, in the default colours', async ({ browser }, testInfo) => {
  for (const scheme of ['light', 'dark'] as const) {
    const page = await openWith(browser, testInfo.project.use, { colorScheme: scheme })
    await mock(page, { me: meOf(COMPANIES.plain, 'en', false) })
    await page.goto('/visits')
    await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible(FIRST_RENDER)
    await expect(shell(page).locator('[data-company-wordmark]')).toHaveText('Other Corp')
    await expect(shell(page).locator('img')).toHaveCount(0)
    expect(await shellColour(page)).toBe(scheme === 'light' ? 'rgb(24, 128, 134)' : 'rgb(15, 59, 63)')
    expect(await token(page, '--brand-light-accent')).toBe('')
    await expect(page).toHaveTitle('My visits · Other Corp')
    await expectNoAxeViolations(page, `plain ${scheme}`)
    await page.context().close()
  }
})

/* No flash of another identity ---------------------------------------------------------------- */

test('a device that knows its company paints its colours before the session check answers', async ({ browser }, testInfo) => {
  const company = COMPANIES.orange
  const palette = mockPalette(company.colour)
  const page = await openWith(browser, testInfo.project.use)
  // What an earlier sign-in left on the device.
  await page.addInitScript(
    ([slug, brands]) => {
      window.localStorage.setItem('vms.company', slug!)
      window.localStorage.setItem('vms.brands', brands!)
    },
    [company.slug, JSON.stringify([{ at: 1, brand: publicBrand(company, true) }])],
  )
  const { held, release } = gate()
  await mock(page, { me: meOf(company, 'en', true), hold: { path: '/auth/me', release: held } })
  await page.goto('/visits')

  // The session is still unknown: the page shows its loader, already in the company's colours, with its icon in the tab.
  await expect(page.getByText('Checking your session…')).toBeVisible(FIRST_RENDER)
  expect(await token(page, '--brand-shell-shell')).toBe(palette.surface)
  expect(await token(page, '--color-accent')).toBe(palette.surface)
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute('href', `/api/v1/public/companies/${company.slug}/brand/icon.png?v=v1`)
  await expect(page.locator('head meta[name="theme-color"]')).toHaveAttribute('content', palette.surface)

  release()
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible()
  expect(await shellColour(page)).toBe(rgb(palette.surface))
})

test('a first visit to a company’s page opens in its colours: nothing is drawn in the default ones first', async ({ browser }, testInfo) => {
  for (const [company, address, heading] of [
    [COMPANIES.orange, `/c/${COMPANIES.orange.slug}`, 'Sign in'],
    [COMPANIES.yellow, `/forgot-password?c=${COMPANIES.yellow.slug}`, 'Reset your password'],
  ] as const) {
    const palette = mockPalette(company.colour)
    // A device that has never seen the company: no copy of its identity.
    const page = await openWith(browser, testInfo.project.use)
    // What the root element carries at the moment the page's first content is in the document.
    await page.addInitScript(() => {
      const seen = window as unknown as { firstAccent?: string; firstIcon?: string | null }
      new MutationObserver((_records, observer) => {
        if (!document.querySelector('#root h1')) return
        seen.firstAccent = document.documentElement.style.getPropertyValue('--brand-light-accent')
        seen.firstIcon = document.head.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null
        observer.disconnect()
      }).observe(document, { childList: true, subtree: true })
    })
    let asked = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/v1/public/companies/${company.slug}/brand`) asked += 1
    })
    await mock(page, {})
    await page.goto(address)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(FIRST_RENDER)
    const first = await page.evaluate(() => {
      const seen = window as unknown as { firstAccent?: string; firstIcon?: string | null }
      return { accent: seen.firstAccent, icon: seen.firstIcon }
    })
    expect(first).toEqual({ accent: palette.surface, icon: `/api/v1/public/companies/${company.slug}/brand/icon.png?v=v1` })
    await expect(page.locator('[data-identity-lockup="page"] img')).toBeVisible()
    // Asked once: the page's own query found the answer the boot had waited for.
    await page.waitForLoadState('networkidle')
    expect(asked).toBe(1)
    await page.context().close()
  }
})

test('a company’s sign-in page keeps its place while the identity is on its way, and shows no other identity meanwhile', async ({ browser }, testInfo) => {
  const company = COMPANIES.blue
  const page = await openWith(browser, testInfo.project.use)
  const { held, release } = gate()
  await mock(page, { hold: { path: `/public/companies/${company.slug}/brand`, release: held } })
  await page.goto(`/c/${company.slug}`)

  // The page waits for the identity only briefly: on a slow connection the form comes first.
  const heading = page.getByRole('heading', { level: 1, name: 'Sign in' })
  await expect(heading).toBeVisible(FIRST_RENDER)
  // Not known yet: nothing of an identity, not the neutral page's mark either, and no product.
  await expect(page.locator('[data-neutral-mark], [data-identity-lockup], [data-brand-lockup]')).toHaveCount(0)
  await expect(page).toHaveTitle('Sign in')
  const before = await heading.boundingBox()

  release()
  const logo = page.locator('[data-identity-lockup="page"] img')
  await expect(logo).toBeVisible()
  await expect(page).toHaveTitle(`Sign in · ${company.name}`)
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  // The form is where it was: the logo took the room kept for it.
  const after = await heading.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
  // The logo is no larger than its place, whatever the file's size.
  const box = await logo.boundingBox()
  expect(box!.height).toBeLessThanOrEqual(64.5)
  expect(box!.width).toBeLessThanOrEqual(240.5)
})

test('a copy planted in the device’s storage cannot lend a company another company’s logo (security review)', async ({ browser }, testInfo) => {
  const victim = COMPANIES.blue
  const page = await openWith(browser, testInfo.project.use)
  // What the review planted: an identity for a slug of its own, with the victim's logo and icon.
  const file = (kind: string) => `/api/v1/public/companies/${victim.slug}/brand/${kind}.png?v=zzz`
  const planted = { slug: 'evil-co', name: 'Evil Co', name_ar: null, default_language: 'en', brand: { ...UNBRANDED, logo_url: file('logo'), logo_dark_url: file('logo_dark'), icon_url: file('icon') } }
  await page.addInitScript(([brands]) => window.localStorage.setItem('vms.brands', brands!), [JSON.stringify([{ at: 1, brand: planted }])])
  const files: string[] = []
  page.on('request', (request) => {
    const requested = new URL(request.url()).pathname
    if (/\/brand\/[a-z_]+\.png$/.test(requested)) files.push(requested)
  })
  const { held, release } = gate()
  await mock(page, { hold: { path: '/public/companies/evil-co/brand', release: held } })
  await page.goto('/c/evil-co')

  // Until the server answers, the device's copy is all there is: its name, and none of the borrowed files.
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await expect(page.locator('[data-identity-lockup="page"] [data-company-wordmark]')).toHaveText('Evil Co')
  await expect(page.locator('[data-identity-lockup] img, [data-identity-lockup] source')).toHaveCount(0)
  await expect(page.locator('head link[rel="icon"]').first()).toHaveAttribute('href', /^\/icons\/neutral-/)

  // The server's answer (nobody has that slug) replaces the copy: the neutral page, and nothing of it is kept.
  release()
  await expect(page.locator('[data-neutral-mark]')).toBeVisible()
  await expect(page).toHaveTitle('Sign in')
  await page.waitForLoadState('networkidle')
  expect(files, 'brand files asked for').toEqual([])
  expect(await page.evaluate(() => window.localStorage.getItem('vms.brands') ?? '')).not.toContain(victim.slug)
})

test('the neutral sign-in page and a slug nobody has look the same, with the neutral icon', async ({ browser }, testInfo) => {
  const shots: Buffer[] = []
  for (const address of ['/login', '/c/no-such-company']) {
    const page = await openWith(browser, testInfo.project.use)
    await mock(page)
    await page.goto(address)
    await expect(page.locator('[data-neutral-mark]')).toBeVisible(FIRST_RENDER)
    await expect(page.locator('main img')).toHaveCount(0)
    await expect(page).toHaveTitle('Sign in')
    await expect(page.locator('head link[rel="icon"]').first()).toHaveAttribute('href', '/icons/neutral-16.png')
    await page.evaluate(() => document.fonts.ready)
    shots.push(await page.locator('main').screenshot())
    await expectNoAxeViolations(page, address)
    await page.context().close()
  }
  expect(shots[0]!.equals(shots[1]!), 'the two pages are the same picture').toBe(true)
})

/* The identity page prepares pictures in the browser -------------------------------------------- */

/** The width and height a PNG states (its IHDR), after checking its signature. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex'), 'the PNG signature').toBe('89504e470d0a1a0a')
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('the identity page uploads a PNG the canvas made, inside the limits, never the chosen file', async ({ browser }, testInfo) => {
  const company = COMPANIES.plain
  const page = await openWith(browser, testInfo.project.use)
  const sent: NonNullable<MockOptions['sent']> = []
  await mock(page, { platform: platformMe('en'), sent })
  await page.goto(`/platform/companies/${company.id}/identity`)
  await expect(page.getByRole('heading', { level: 1, name: 'Identity' })).toBeVisible(FIRST_RENDER)
  const slot = (kind: string) => page.locator(`[data-asset-slot="${kind}"]`)

  // A text file named like a picture: refused here, with the reason, and nothing staged.
  await page.locator('[data-asset-input="logo"]').setInputFiles(NOT_AN_IMAGE)
  await expect(slot('logo')).toContainText('This file cannot be read as an image. Choose a PNG, JPEG, WebP, SVG file.')
  await expect(page.getByRole('button', { name: 'Save identity' })).toHaveAttribute('aria-disabled', 'true')

  // A PNG with empty room around its drawing, and an SVG for dark surfaces.
  await page.locator('[data-asset-input="logo"]').setInputFiles(LOGO_PNG)
  await expect(slot('icon').locator('[data-asset-preview] img')).toBeVisible()
  await page.locator('[data-asset-input="logo_dark"]').setInputFiles(LOGO_DARK_SVG)
  await expect(slot('logo_dark').locator('[data-asset-preview] img')).toBeVisible()
  // The logo's own colour is found in its pixels and offered first.
  const first = page.locator('[data-suggested-colour]').first()
  await expect(first).toHaveAttribute('data-suggested-colour', SAMPLE_COLOURS.orange)
  await first.click()
  // The preview draws the palette on its own scope; the platform's page keeps the product's colours.
  const palette = mockPalette(SAMPLE_COLOURS.orange)
  await expect.poll(() => page.locator('[data-preview-shell]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(palette.surface))
  expect(await token(page, '--color-accent')).toBe('#188086')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await expectNoAxeViolations(page, 'the identity page with staged pictures')

  await page.getByRole('button', { name: 'Save identity' }).click()
  await expect(page.getByText('Identity saved')).toBeVisible()

  const base = `/platform/companies/${company.id}/brand`
  expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`PUT ${base}/assets/logo`, `PUT ${base}/assets/icon`, `PUT ${base}/assets/logo_dark`, `PATCH ${base}`])
  const [logo, icon, logoDark] = sent
  for (const upload of [logo!, icon!, logoDark!]) {
    expect(upload.contentType).toBe('image/png')
    expect(upload.body!.length).toBeLessThanOrEqual(512 * 1024)
  }
  // The logo: the canvas's own PNG, the drawing without its empty room, inside 32–1200 × 32–600.
  expect(logo!.body!.equals(LOGO_BYTES), 'the original bytes are never uploaded').toBe(false)
  const logoSize = pngSize(logo!.body!)
  expect(logoSize.width).toBeLessThan(760)
  expect(logoSize.height).toBeLessThan(300)
  expect(logoSize.width).toBeGreaterThanOrEqual(32)
  expect(logoSize.height).toBeGreaterThanOrEqual(32)
  // The icon: a 512 px square. The logo is a wordmark, so it is the company's letter on its colour.
  expect(pngSize(icon!.body!)).toEqual({ width: 512, height: 512 })
  // The SVG was rasterised: PNG bytes, as large as the limits allow, and not a byte of the SVG's text.
  const darkSize = pngSize(logoDark!.body!)
  expect(darkSize.width).toBeLessThanOrEqual(1200)
  expect(darkSize.height).toBeLessThanOrEqual(600)
  expect(darkSize.width, "larger than the 380 px the SVG states: drawn as a vector, not enlarged pixels").toBeGreaterThan(600)
  expect(logoDark!.body!.includes(Buffer.from('<svg'))).toBe(false)
  expect(JSON.parse(sent[3]!.body!.toString('utf8'))).toEqual({ color: SAMPLE_COLOURS.orange })
})

test('the identity page fits the screen in Arabic and in the dark scheme', async ({ browser }, testInfo) => {
  for (const scheme of ['light', 'dark'] as const) {
    const page = await openWith(browser, testInfo.project.use, { colorScheme: scheme })
    await mock(page, { platform: platformMe('ar') })
    await page.goto(`/platform/companies/${COMPANIES.yellow.id}/identity`)
    await expect(page.getByRole('heading', { level: 1, name: 'الهوية' })).toBeVisible(FIRST_RENDER)
    await expect(page.locator('[data-identity-preview]')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    // The sign-in link reads left to right, and is whole.
    const link = page.locator('[data-sign-in-link]').first()
    await expect(link).toHaveAttribute('dir', 'ltr')
    await expect(link).toContainText(`/c/${COMPANIES.yellow.slug}`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    // The saved palette is drawn on the preview: the shell in the company's own yellow (the deep step in the dark scheme).
    const palette = mockPalette(COMPANIES.yellow.colour)
    expect(palette.surface).toBe(COMPANIES.yellow.colour)
    await expect.poll(() => page.locator('[data-preview-shell]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(scheme === 'light' ? palette.surface : palette.deep))
    await expectNoAxeViolations(page, `the identity page, Arabic, ${scheme}`)
    await page.context().close()
  }
})
