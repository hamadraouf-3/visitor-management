import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContextOptions, type Page, type Route } from '@playwright/test'
import type { Language } from '../src/i18n/languages.ts'
import type { EmailPreview, EmailTemplate, Me, PlatformAuditLog, PlatformCompany, PlatformCompanyAdmin, PlatformMe } from '../src/types/api.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * Layout, touch and keyboard regressions of the Phase 11 screens, from the UX, i18n and accessibility
 * review (decisions F11-23 on): what jsdom cannot measure. The API is mocked, so this spec needs only
 * the Vite server; both languages come from the mocked accounts' own preference.
 *
 * - H1: the platform's audit log at 768 to 1440 px: no cell over another, the event never squeezed.
 * - M7: an event's raw metadata reads left to right and is no scroll box of its own (axe).
 * - L1: 44 px touch targets on the platform's audit log.
 * - L10: the platform's shell is not a company's in the dark colour scheme either.
 * - L13: a long slug strands no separator dot, and wraps on the reading side.
 * - L14: a long address is whole on the created screen.
 * - L16: the Arabic created date stays on one line in the companies table.
 * - M6, L7, L8: the e-mail texts editor: one tab stop per row of variables, nothing moves when a text
 *   takes focus, a field's two languages side by side or one right under the other.
 */

const PROJECT_WIDTH: Record<string, number> = { desktop: 1440, tablet: 820, mobile: 390 }
/** A page's first render: the dev server may still be transforming the route's lazy modules (they are cold after an edit). */
const FIRST_RENDER = { timeout: 30_000 }
const LANGUAGES: Language[] = ['en', 'ar']
const iso = (ms: number) => new Date(ms).toISOString()
const uuid = (prefix: string, index: number) => `${prefix}000000-0000-4000-8000-${String(index).padStart(12, '0')}`

/* The platform owner's side ----------------------------------------------------------------- */

const PLATFORM_ADMIN_ID = uuid('9a', 1)
const platformMe = (language: Language): PlatformMe => ({
  admin: { id: PLATFORM_ADMIN_ID, full_name: 'Platform Owner', email: 'platform@demo.local', must_change_password: false, preferred_language: language },
})

const LONG_SLUG = 'petra-logistics-and-international-freight-forwarding-company'

function company(index: number, overrides: Partial<PlatformCompany> = {}): PlatformCompany {
  return {
    id: uuid('9b', index),
    name: 'Nova Labs',
    name_ar: 'مختبرات نوفا',
    slug: 'nova-labs',
    timezone: 'Asia/Amman',
    default_language: 'ar',
    is_active: true,
    deactivated_at: null,
    // A date in a month of two words, among the longest in Arabic: «الثلاثاء، 13 تشرين الأول 2026».
    created_at: '2026-10-13T08:00:00Z',
    updated_at: '2026-10-13T08:00:00Z',
    counts: { active_users: 12, visits_last_30_days: 1284 },
    brand: UNBRANDED,
    ...overrides,
  }
}

const NOVA = company(1)
const PETRA = company(2, {
  name: 'Petra Logistics and International Freight Forwarding Company',
  name_ar: 'شركة البتراء للخدمات اللوجستية والشحن الدولي والتخليص الجمركي',
  slug: LONG_SLUG,
})
const OLD = company(3, { name: 'Old Tenant', name_ar: 'مستأجر سابق', slug: 'old-tenant', is_active: false, deactivated_at: '2026-10-13T09:00:00Z' })
const COMPANIES = [NOVA, PETRA, OLD]

const LONG_ADDRESS = 'abdulrahman.abdullah.alkhatib.almahmoud@petra-logistics-international.test'
const ADMINS: PlatformCompanyAdmin[] = [
  { id: uuid('9c', 1), full_name: 'عبد الرحمن عبد الله الخطيب المحمود', email: LONG_ADDRESS, is_active: true, must_change_password: true, last_login_at: null, created_at: '2026-10-13T08:00:00Z' },
  { id: uuid('9c', 2), full_name: 'Christopher Alexander Montgomery-Fitzgerald', email: 'christopher.montgomery@petra-logistics-international.test', is_active: true, must_change_password: false, last_login_at: '2026-10-13T08:30:00Z', created_at: '2026-10-13T08:00:00Z' },
]

/** The trail's rows: every kind of length a cell can hold. */
function auditLogs(): PlatformAuditLog[] {
  const rows: Partial<PlatformAuditLog>[] = [
    { action: 'COMPANY_DEACTIVATED', company: OLD, entity_type: 'company', entity_id: OLD.id, metadata: { revoked_sessions: 3, invalidated_reset_links: 1 } },
    { action: 'USER_CREATED', company: PETRA, entity_type: 'user', entity_id: ADMINS[1]!.id, metadata: {} },
    { action: 'AUTH_PASSWORD_RESET_REQUESTED', company: PETRA, entity_type: 'user', entity_id: ADMINS[0]!.id, metadata: { email_message_id: uuid('9e', 1) } },
    { action: 'COMPANY_CREATED', company: PETRA, entity_type: 'company', entity_id: PETRA.id, metadata: {} },
    { action: 'RATE_LIMITED', company: null, entity_type: null, entity_id: null, metadata: { policy: 'login_ip', route: '/api/v1/platform/auth/login', method: 'POST' } },
    { action: 'AUTH_ACCOUNT_THROTTLED', company: null, entity_type: 'platform_admin', entity_id: PLATFORM_ADMIN_ID, metadata: { reason: 'bad_password' } },
    { action: 'COMPANY_SETTINGS_UPDATED', company: NOVA, entity_type: 'company', entity_id: NOVA.id, metadata: { changed_fields: ['timezone', 'name_ar', 'default_language'] } },
    { action: 'PLATFORM_ADMIN_CREATED', actor: null, company: null, entity_type: 'platform_admin', entity_id: PLATFORM_ADMIN_ID, metadata: { source: 'cli' } },
  ]
  return rows.map((row, index) => ({
    id: uuid('9d', index + 1),
    seq: 100 - index,
    created_at: iso(Date.parse('2026-10-13T11:15:49Z') - index * 61_000),
    action: 'COMPANY_CREATED',
    actor: { id: PLATFORM_ADMIN_ID, full_name: 'Platform Owner' },
    company: null,
    entity_type: null,
    entity_id: null,
    metadata: {},
    ip_address: '203.0.113.10',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    request_id: `req-${index}`,
    ...row,
    // The trail names a company by its three fields only.
    ...(row.company ? { company: { id: row.company.id, name: row.company.name, name_ar: row.company.name_ar } } : {}),
  }))
}

const notMocked = (route: Route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
const signedOut = (route: Route) => route.fulfill({ status: 401, json: { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in.', details: {} }, request_id: 'e2e' } })

async function mockPlatform(page: Page, language: Language) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    if (path === '/platform/auth/me') return route.fulfill({ json: platformMe(language) })
    if (path === '/auth/me') return signedOut(route)
    if (path === '/platform/audit-logs') return route.fulfill({ json: { items: auditLogs(), page: 1, page_size: 50, total: 8 } })
    if (path === '/platform/companies' && request.method() === 'POST') return route.fulfill({ status: 201, json: { company: PETRA, admin: ADMINS[0] } })
    if (path === '/platform/companies') return route.fulfill({ json: { items: COMPANIES, page: 1, page_size: 25, total: COMPANIES.length } })
    const found = COMPANIES.find((item) => path.startsWith(`/platform/companies/${item.id}`))
    if (found && path.endsWith('/admins')) return route.fulfill({ json: ADMINS })
    if (found) return route.fulfill({ json: found })
    return notMocked(route)
  })
}

/** The colour of the shell on screen: the sidebar on a desktop, the top bar below. */
function shellColour(page: Page): Promise<string> {
  return page.locator('aside:visible, header[data-app-bar]:visible').first().evaluate((element) => getComputedStyle(element).backgroundColor)
}

/** A context of this project's kind with other options (a width, the dark colour scheme). */
async function openWith(browser: Browser, projectUse: BrowserContextOptions, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext({ baseURL: projectUse.baseURL, locale: 'en-US', viewport: projectUse.viewport, hasTouch: projectUse.hasTouch, ...options })
  return context.newPage()
}

/** How the rows of the audit log lie: pairs of cells that overlap, cells whose text spills, the widths the review measured. */
function measureAuditRows(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-audit-row]')]
    let overlaps = 0
    let spilling = 0
    const widths = { event: Infinity, company: Infinity, actor: Infinity }
    for (const row of rows) {
      const cells = [...row.querySelectorAll<HTMLElement>('[data-audit-cell]')]
      const boxes = cells.map((cell) => cell.getBoundingClientRect())
      boxes.forEach((a, i) => {
        for (const b of boxes.slice(i + 1)) {
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (x > 0.5 && y > 0.5) overlaps += 1
        }
      })
      for (const cell of cells) {
        if (cell.scrollWidth > cell.clientWidth + 1) spilling += 1
        const kind = cell.dataset.auditCell
        if (kind === 'event' || kind === 'company' || kind === 'actor') widths[kind] = Math.min(widths[kind], cell.getBoundingClientRect().width)
      }
    }
    const header = document.querySelector('[data-audit-header]')
    return {
      rows: rows.length,
      overlaps,
      spilling,
      widths,
      columns: header !== null && getComputedStyle(header).display !== 'none',
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

test.describe('the platform’s audit log (H1, M7, L1)', () => {
  for (const language of LANGUAGES) {
    test(`${language}: no cell lies over another and the event keeps its width, from 768 to 1440 px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'Sets its own widths')
      await mockPlatform(page, language)
      await page.goto('/platform/audit')
      await expect(page.locator('[data-audit-row]')).toHaveCount(8, FIRST_RENDER)
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      // The administrators' names have arrived: the longest lines the event cell holds.
      await expect(page.locator('[data-audit-concerns]').filter({ hasText: 'Montgomery-Fitzgerald' })).toHaveCount(1)

      // 1024 and 1100 px are narrower for the list than 1023: the sidebar takes 256 px from 1024 on.
      for (const width of [768, 820, 900, 1023, 1024, 1100, 1152, 1279, 1280, 1366, 1440]) {
        await test.step(`${width} px`, async () => {
          await page.setViewportSize({ width, height: 900 })
          const measured = await measureAuditRows(page)
          expect(measured.rows).toBe(8)
          expect(measured.overlaps, 'pairs of cells that overlap').toBe(0)
          expect(measured.spilling, 'cells whose content spills out').toBe(0)
          expect(measured.pageOverflow, 'horizontal scroll of the page').toBeLessThanOrEqual(0)
          // Columns only where five fit (from 1280 px); below, the stacked row, whose cells have the row's width.
          expect(measured.columns, 'laid out in columns').toBe(width >= 1280)
          expect(measured.widths.event, 'the event’s width').toBeGreaterThanOrEqual(192)
          expect(measured.widths.company, 'the company’s width').toBeGreaterThanOrEqual(150)
          expect(measured.widths.actor, 'the actor’s width').toBeGreaterThanOrEqual(150)
        })
      }
    })

    test(`${language}: an event’s raw metadata reads left to right and is not a scroll box of its own`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name === 'tablet', 'The desktop and the phone cover both layouts')
      await mockPlatform(page, language)
      await page.goto('/platform/audit')
      await expect(page.locator('[data-audit-row]')).toHaveCount(8, FIRST_RENDER)
      await page.locator('[data-audit-cell="details"]').nth(6).click()
      await page.locator('summary').click()
      const raw = page.locator('[data-audit-raw]')
      await expect(raw).toContainText('"changed_fields"')
      const box = await raw.evaluate((element) => {
        const style = getComputedStyle(element)
        const brace = document.createRange()
        brace.setStart(element.firstChild!, 0)
        brace.setEnd(element.firstChild!, 1)
        return {
          direction: style.direction,
          scrolls: element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1,
          overflowY: style.overflowY,
          // The opening brace stands at the box's left edge, in the Arabic page too.
          braceFromLeft: brace.getBoundingClientRect().left - element.getBoundingClientRect().left,
        }
      })
      expect(box.direction).toBe('ltr')
      expect(box.scrolls).toBe(false)
      expect(box.overflowY).toBe('visible')
      expect(box.braceFromLeft).toBeLessThan(24)
      const results = await new AxeBuilder({ page }).analyze()
      const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
    })
  }

  test('touch targets: the company chip’s button and a row’s company link are 44 px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop', 'Touch screens')
    await mockPlatform(page, 'ar')
    await page.goto(`/platform/audit?company=${PETRA.id}`)
    await expect(page.locator('[data-audit-row]')).toHaveCount(8, FIRST_RENDER)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'touch screen').toBe(true)
    const sizes = await page.evaluate(() => {
      const targets = {
        clear: [...document.querySelectorAll('[data-clear-company]')],
        links: [...document.querySelectorAll('[data-audit-cell="company"] a')],
        details: [...document.querySelectorAll('[data-audit-cell="details"]')],
      }
      const measured = Object.entries(targets).map(([name, elements]) => [
        name,
        elements.map((element) => {
          const box = element.getBoundingClientRect()
          return { width: Math.round(box.width), height: Math.round(box.height) }
        }),
      ])
      return Object.fromEntries(measured) as Record<keyof typeof targets, { width: number; height: number }[]>
    })
    expect(sizes.clear).toHaveLength(1)
    expect(sizes.clear[0]!.width).toBeGreaterThanOrEqual(44)
    expect(sizes.clear[0]!.height).toBeGreaterThanOrEqual(44)
    expect(sizes.links.length).toBeGreaterThan(3)
    expect(Math.min(...sizes.links.map((link) => link.height)), 'height of a row’s company link').toBeGreaterThanOrEqual(44)
    expect(Math.min(...sizes.details.map((button) => button.height)), 'height of a row’s Details button').toBeGreaterThanOrEqual(44)
  })
})

test('the platform’s shell is not a company’s in the dark colour scheme (L10)', async ({ browser }, testInfo) => {
  const use = testInfo.project.use

  const colours: Record<string, { platform: string; company: string }> = {}
  for (const colorScheme of ['light', 'dark'] as const) {
    const platform = await openWith(browser, use, { colorScheme })
    await mockPlatform(platform, 'en')
    await platform.goto('/platform/companies')
    await expect(platform.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible(FIRST_RENDER)

    const companyPage = await openWith(browser, use, { colorScheme })
    await mockEditor(companyPage, 'en')
    await companyPage.goto('/admin/email-templates/VISITOR_INVITATION')
    await expect(companyPage.getByRole('heading', { level: 1, name: 'Visitor invitation' })).toBeVisible(FIRST_RENDER)

    colours[colorScheme] = { platform: await shellColour(platform), company: await shellColour(companyPage) }
    await platform.context().close()
    await companyPage.context().close()
  }
  // Light: the deep teal beside the side-nav teal. Dark: a company's shell is the deep teal, the platform's the slate.
  expect(colours.light).toEqual({ platform: 'rgb(15, 59, 63)', company: 'rgb(24, 128, 134)' })
  expect(colours.dark).toEqual({ platform: 'rgb(51, 68, 78)', company: 'rgb(15, 59, 63)' })
})

test('an idle platform tab is signed out when its session ends, and only its re-checks are background refreshes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The session: once is enough')
  // The server no longer counts a platform request marked as a background refresh as activity (B11-34): the
  // session's heartbeat must be marked, and the page's own requests must not.
  await page.clock.install()
  let signedIn = true
  const calls: { call: string; background: boolean }[] = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    calls.push({ call: `${request.method()} ${path}`, background: request.headers()['x-background-refresh'] === '1' })
    if (path === '/platform/auth/me') return signedIn ? route.fulfill({ json: platformMe('en') }) : signedOut(route)
    if (path === '/auth/me') return signedOut(route)
    if (path === '/platform/companies') return route.fulfill({ json: { items: COMPANIES, page: 1, page_size: 25, total: COMPANIES.length } })
    return notMocked(route)
  })
  const sessionChecks = () => calls.filter((entry) => entry.call === 'GET /platform/auth/me')
  await page.goto('/platform/companies?status=active')
  await expect(page.getByRole('link', { name: 'Nova Labs' })).toBeVisible(FIRST_RENDER)
  // The page's own load: the session check and the list, neither a background refresh. (The development
  // build mounts twice, so the load may ask more than once; none of it is marked.)
  expect(calls.map((entry) => entry.call)).toEqual(expect.arrayContaining(['GET /platform/auth/me', 'GET /platform/companies']))
  expect(calls.filter((entry) => entry.background)).toEqual([])
  const marked = () => calls.filter((entry) => entry.background)

  // Nobody touches the tab. A minute on, the heartbeat re-checks the session, as a background refresh.
  await page.clock.fastForward(65_000)
  await expect.poll(() => marked().length).toBe(1)
  expect(marked()).toEqual([{ call: 'GET /platform/auth/me', background: true }])
  await expect(page.getByRole('link', { name: 'Nova Labs' })).toBeVisible()

  // The server ends the idle session; the next beat finds out, and the page goes to the platform sign-in, to come back here.
  signedIn = false
  await page.clock.fastForward(65_000)
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to the platform' })).toBeVisible()
  await expect(page).toHaveURL(/\/platform\/login\?next=%2Fplatform%2Fcompanies%3Fstatus%3Dactive$/)
  await expect(page.getByRole('link', { name: 'Nova Labs' })).toHaveCount(0)
  // The two beats are the only marked requests; whatever else was asked (the load, the sign-in page) is not.
  expect(marked()).toEqual([
    { call: 'GET /platform/auth/me', background: true },
    { call: 'GET /platform/auth/me', background: true },
  ])
  expect(sessionChecks().filter((entry) => !entry.background).length).toBeGreaterThanOrEqual(1)
  // Signed out, the tab asks no more: nobody's session is left to re-check.
  const signedOutAt = calls.length
  await page.clock.fastForward(121_000)
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to the platform' })).toBeVisible()
  expect(calls.slice(signedOutAt).filter((entry) => entry.call === 'GET /platform/auth/me')).toEqual([])
})

test.describe('companies (L13, L14, L16)', () => {
  test('the Arabic created date stays on one line, and no header spills out of its column', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The table’s columns: desktop widths')
    await mockPlatform(page, 'ar')
    await page.goto('/platform/companies')
    await expect(page.locator('[data-company-created]')).toHaveCount(3, FIRST_RENDER)
    for (const width of [1280, 1366, 1440, 1920]) {
      await test.step(`${width} px`, async () => {
        await page.setViewportSize({ width, height: 900 })
        const table = await page.evaluate(() => ({
          dateLines: [...document.querySelectorAll('[data-company-created]')].map((date) => new Set([...date.getClientRects()].map((rect) => Math.round(rect.top))).size),
          dates: [...document.querySelectorAll('[data-company-created]')].map((date) => date.textContent),
          spillingHeaders: [...document.querySelectorAll('thead th')].filter((header) => header.scrollWidth > header.clientWidth + 1).map((header) => header.textContent),
        }))
        expect(table.dates[0]).toContain('تشرين')
        expect(table.dateLines, 'lines of each created date').toEqual([1, 1, 1])
        expect(table.spillingHeaders, 'headers wider than their column').toEqual([])
      })
    }
  })

  for (const language of LANGUAGES) {
    test(`${language}: a long slug strands no separator dot and wraps on the reading side`, async ({ page }, testInfo) => {
      await mockPlatform(page, language)
      await page.goto(`/platform/companies/${PETRA.id}`)
      await expect(page.locator('main header [data-meta-item]')).toHaveCount(3, FIRST_RENDER)
      const widths = testInfo.project.name === 'desktop' ? [1024, 1280, 1440] : [PROJECT_WIDTH[testInfo.project.name]!]
      for (const width of widths) {
        await test.step(`${width} px`, async () => {
          await page.setViewportSize({ width, height: 900 })
          const line = await page.evaluate(() => {
            const facts = [...document.querySelectorAll<HTMLElement>('main header [data-meta-item]')]
            const clip = facts[0]!.parentElement!.parentElement!.getBoundingClientRect()
            const rtl = document.documentElement.dir === 'rtl'
            // Facts whose boxes share a band of the page are one row.
            const rows: { top: number; bottom: number; facts: HTMLElement[] }[] = []
            for (const fact of facts) {
              const box = fact.getBoundingClientRect()
              const row = rows.find((other) => box.top < other.bottom - 1 && box.bottom > other.top + 1)
              if (row) row.facts.push(fact)
              else rows.push({ top: box.top, bottom: box.bottom, facts: [fact] })
            }
            // A fact's dot is drawn 12 px inside its box; it shows only inside the line's clip.
            const showsDot = (fact: HTMLElement) => {
              if (getComputedStyle(fact, '::before').display === 'none') return false
              const box = fact.getBoundingClientRect()
              const dot = rtl ? box.right - 12 : box.left + 12
              return dot > clip.left && dot < clip.right
            }
            const slug = document.querySelector<HTMLElement>('main header [data-meta-item] > [dir="ltr"]')!
            const text = document.createRange()
            text.selectNodeContents(slug)
            const slugBox = slug.getBoundingClientRect()
            return {
              // In every row the first fact shows no dot and each later one shows its own.
              rows: rows.map((row) => row.facts.map(showsDot)),
              slugLines: [...text.getClientRects()].map((rect) => Math.round(rtl ? slugBox.right - rect.right : rect.left - slugBox.left)),
              pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            }
          })
          for (const row of line.rows) expect(row, 'dots shown by the facts of one row').toEqual(row.map((_, index) => index > 0))
          // Each line of the slug starts where the facts start: the right in Arabic.
          for (const offset of line.slugLines) expect(Math.abs(offset), 'a slug line’s distance from the reading side').toBeLessThanOrEqual(1)
          expect(line.pageOverflow).toBeLessThanOrEqual(0)
        })
      }
    })
  }

  test('a long address is whole on the created screen, under one line about the password', async ({ page }) => {
    await mockPlatform(page, 'ar')
    await page.goto('/platform/companies/new')
    await expect(page.getByRole('heading', { level: 1, name: 'إضافة شركة' })).toBeVisible(FIRST_RENDER)
    await page.getByLabel('اسم الشركة').fill('Petra Logistics')
    await page.getByLabel('الاسم الكامل').fill(ADMINS[0]!.full_name)
    await page.getByLabel('البريد الإلكتروني').fill(LONG_ADDRESS)
    await page.getByRole('button', { name: 'إنشاء تلقائي' }).click()
    await page.getByRole('button', { name: 'إنشاء الشركة' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'أُنشئت الشركة' })).toBeVisible()

    const value = page.locator('[data-read-only-value]')
    await expect(value).toHaveText(LONG_ADDRESS)
    const address = await value.evaluate((element) => {
      const text = document.createRange()
      text.selectNodeContents(element)
      const box = element.getBoundingClientRect()
      return {
        inside: [...text.getClientRects()].every((rect) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5),
        clipped: element.scrollWidth > element.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(address).toEqual({ inside: true, clipped: false, pageOverflow: address.pageOverflow })
    expect(address.pageOverflow).toBeLessThanOrEqual(0)
    // One line (shown once, when it expires), as "Add user" has; no second sentence under the password.
    await expect(page.getByText('سلّم كلمة المرور المؤقتة الآن، فهي لا تُعرض إلا مرة واحدة وتنتهي صلاحيتها بعد 72 ساعة.')).toBeVisible()
    await expect(page.locator('main [id$="-hint"]')).toHaveCount(0)
  })
})

/* A company's e-mail texts ------------------------------------------------------------------- */

const adminMe = (language: Language): Me => ({
  user: { id: uuid('00', 1), full_name: 'Lina Haddad', email: 'lina.haddad@example.com', phone: null, roles: ['SYSTEM_ADMIN'], department: null, must_change_password: false, preferred_language: language },
  company: { id: uuid('00', 2), name: 'Demo Holdings', name_ar: null, slug: 'demo-holdings', timezone: 'Asia/Amman', default_language: 'en', brand: UNBRANDED },
})

function preview(language: Language): EmailPreview {
  const english = ['Your visit to Demo Holdings', '', 'Hello Sara Ahmad,', 'Lina Haddad has invited you to visit Demo Holdings.']
  const arabic = ['زيارتك إلى Demo Holdings', '', 'مرحبًا Sara Ahmad،']
  const [lead, other, otherName] = language === 'en' ? [english, arabic, 'العربية'] : [arabic, english, 'English']
  const rule = '-'.repeat(40)
  // A company's e-mail (Phase 12): headed by its name, and "Sent by <company>." in each language, the leading one first.
  const footers = ['Sent by Demo Holdings.', 'أُرسلت من \u2068Demo Holdings\u2069.']
  return {
    kind: 'VISITOR_INVITATION',
    language,
    subject: language === 'en' ? 'Your visit to Demo Holdings | زيارتك إلى Demo Holdings' : 'زيارتك إلى Demo Holdings | Your visit to Demo Holdings',
    html: '<!DOCTYPE html><html></html>',
    text: ['Demo Holdings', '='.repeat(40), '', ...lead, '', rule, otherName, rule, '', ...other, '', '--', ...(language === 'en' ? footers : footers.toReversed())].join('\n'),
  }
}

type TemplateField = EmailTemplate['fields'][number]

function templateText(name: TemplateField['name'], multiline: boolean, max: number, ar: string, en: string, required: string[] = []): TemplateField {
  return {
    name,
    multiline,
    max_length: max,
    required_variables: required,
    // The purpose of a visit is not a variable of a subject (B11-40).
    forbidden_variables: name === 'subject' ? ['purpose'] : [],
    default: { ar, en },
    override: { ar: null, en: null },
  }
}

/** The invitation's texts as the API answers them, nothing changed: seven fields, eight variables. */
function invitationTemplate(): EmailTemplate {
  return {
    kind: 'VISITOR_INVITATION',
    variables: ['visitor_name', 'company', 'host_name', 'date', 'time', 'timezone', 'department', 'purpose'],
    max_variable_uses: 3,
    updated_at: null,
    fields: [
      templateText('subject', false, 150, 'زيارتك إلى {company} يوم {date}', 'Your visit to {company} on {date}', ['company']),
      templateText('heading', false, 150, 'زيارتك إلى {company}', 'Your visit to {company}'),
      templateText('greeting', false, 150, 'مرحبًا {visitor_name}،', 'Hello {visitor_name},'),
      templateText('intro', true, 1000, 'تلقّيت دعوةً من {host_name} لزيارة {company}.', '{host_name} has invited you to visit {company}.'),
      templateText('button', false, 40, 'عرض بطاقة الزيارة', 'Open my visitor pass'),
      templateText('closing', true, 1000, '', ''),
      templateText('footer_note', true, 300, '', ''),
    ],
  }
}

async function mockEditor(page: Page, language: Language) {
  const template = invitationTemplate()
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    if (path === '/auth/me') return route.fulfill({ json: adminMe(language) })
    if (path === '/email-templates/VISITOR_INVITATION') return route.fulfill({ json: template })
    if (path === '/email-templates/VISITOR_INVITATION/preview' && request.method() === 'POST') {
      return route.fulfill({ json: preview((request.postDataJSON() as { language: Language }).language) })
    }
    return notMocked(route)
  })
}

async function openEditor(page: Page, language: Language) {
  await mockEditor(page, language)
  await page.goto('/admin/email-templates/VISITOR_INVITATION')
  await expect(page.locator('[data-preview-subject]')).toBeVisible(FIRST_RENDER)
  await expect(page.locator('html')).toHaveAttribute('lang', language)
}

const field = (page: Page, key: string) => page.locator(`[data-template-field="${key}"]`)
const control = (page: Page, key: string) => field(page, key).locator('input, textarea')

test.describe('the e-mail texts editor (M6, L7, L8)', () => {
  for (const language of LANGUAGES) {
    test(`${language}: a row of variables is one tab stop, with the arrow keys in the reading direction`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'The keyboard: once is enough')
      await openEditor(page, language)
      const closing = control(page, 'en.closing')
      await closing.fill('See you, ')
      await closing.press('End')
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute('title') ?? document.activeElement?.tagName ?? '')

      await page.keyboard.press('Tab')
      expect(await focused()).toBe('{visitor_name}')
      // The next variable is on the right in English and on the left in Arabic.
      await page.keyboard.press(language === 'ar' ? 'ArrowLeft' : 'ArrowRight')
      expect(await focused()).toBe('{company}')
      await page.keyboard.press(language === 'ar' ? 'ArrowRight' : 'ArrowLeft')
      expect(await focused()).toBe('{visitor_name}')
      await page.keyboard.press('End')
      expect(await focused()).toBe('{purpose}')
      await page.keyboard.press('Home')
      await page.keyboard.press('Enter')
      await expect(closing).toHaveValue('See you, {visitor_name}')
      await expect(closing).toBeFocused()
      expect(await closing.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe('See you, {visitor_name}'.length)
      // One stop: the Tab after the variables leaves the text's cell.
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.closest('[data-template-field]')?.getAttribute('data-template-field'))).not.toBe('en.closing')

      // From the first text to Save it was 138 presses of Tab.
      await control(page, 'ar.subject').focus()
      let presses = 0
      while (presses < 200) {
        await page.keyboard.press('Tab')
        presses += 1
        if (await page.evaluate(() => document.activeElement?.getAttribute('type') === 'submit')) break
      }
      expect(presses).toBeLessThanOrEqual(45)
      // Each of the fourteen rows of variables names the text it belongs to.
      const names = await page.getByRole('toolbar').evaluateAll((toolbars) => toolbars.map((toolbar) => toolbar.getAttribute('aria-label')))
      expect(names).toHaveLength(14)
      expect(new Set(names).size).toBe(14)
    })

    test(`${language}: nothing moves when another text takes focus, and a field’s two languages are together`, async ({ page }, testInfo) => {
      await openEditor(page, language)
      const width = PROJECT_WIDTH[testInfo.project.name]!
      const tops = () =>
        page.evaluate(() =>
          Object.fromEntries([...document.querySelectorAll('[data-template-field]')].map((element) => [element.getAttribute('data-template-field'), Math.round(element.getBoundingClientRect().top + window.scrollY)])),
        )
      const before = await tops()
      expect(Object.keys(before)).toHaveLength(14)

      // By pointer (the form jumped 78 px under it), then by keyboard, then with a text that gains its "Use default" button.
      const target = control(page, 'en.intro')
      await target.scrollIntoViewIfNeeded()
      const under = (await target.boundingBox())!.y
      await target.click()
      expect(Math.round((await target.boundingBox())!.y - under), 'movement under the pointer').toBe(0)
      expect(await tops()).toEqual(before)
      await control(page, 'ar.closing').focus()
      expect(await tops()).toEqual(before)
      await control(page, 'ar.closing').fill('نراك قريبًا')
      await expect(field(page, 'ar.closing').getByRole('button').first()).toBeVisible()
      expect(await tops()).toEqual(before)

      // By field: the Arabic and the English text of a field side by side from the tablet's width, the
      // English one right under the Arabic one on a phone, never another field between them.
      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-template-row]')].map((row) => [...row.querySelectorAll('[data-template-field]')].map((cell) => cell.getAttribute('data-template-field')))
        const [arabic, english, next] = ['ar.intro', 'en.intro', 'ar.button'].map((key) => document.querySelector(`[data-template-field="${key}"]`)!.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect]
        return {
          rows,
          sameLine: Math.abs(arabic.top - english.top) < 2,
          arabicFirst: document.documentElement.dir === 'rtl' ? arabic.left > english.left : arabic.left < english.left,
          englishUnderArabic: english.top - arabic.bottom,
          nextFieldBelowBoth: next.top > Math.max(arabic.bottom, english.bottom),
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })
      expect(layout.rows[0]).toEqual(['ar.subject', 'en.subject'])
      expect(layout.rows).toHaveLength(7)
      expect(layout.nextFieldBelowBoth).toBe(true)
      expect(layout.pageOverflow).toBeLessThanOrEqual(0)
      if (width >= 768) {
        expect(layout.sameLine, 'side by side').toBe(true)
        expect(layout.arabicFirst, 'the Arabic text first in the reading direction').toBe(true)
      } else {
        expect(layout.sameLine, 'stacked').toBe(false)
        // Right under: only the gap between two cells.
        expect(layout.englishUnderArabic).toBeGreaterThan(0)
        expect(layout.englishUnderArabic).toBeLessThanOrEqual(24)
      }

      // The variables are whole or reachable: a row that does not fit scrolls sideways (touch) or wraps (mouse).
      const toolbar = await field(page, 'en.subject').getByRole('toolbar').evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth + 1,
        scrolls: getComputedStyle(element).overflowX === 'auto',
        chipHeights: [...element.querySelectorAll('button')].map((chip) => Math.round(chip.getBoundingClientRect().height)),
      }))
      expect(toolbar.fits || toolbar.scrolls).toBe(true)
      const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
      expect(Math.min(...toolbar.chipHeights)).toBeGreaterThanOrEqual(touch ? 44 : 24)
    })
  }

  test('ar: the draft’s lines keep their section’s side, whatever script a name has', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'tablet', 'The desktop and the phone cover both layouts')
    await openEditor(page, 'ar')
    const sections = await page.locator('[data-preview-section]').evaluateAll((elements) =>
      elements.map((section) => {
        const box = section.getBoundingClientRect()
        const rtl = getComputedStyle(section).direction === 'rtl'
        // Every line starts at its section's reading side: the right in the Arabic one, the left in the English one.
        const offsets = [...section.querySelectorAll('p')].map((line) => {
          const text = document.createRange()
          text.selectNodeContents(line)
          const rect = text.getBoundingClientRect()
          return Math.round(rtl ? box.right - rect.right : rect.left - box.left)
        })
        return { language: section.getAttribute('lang'), direction: section.getAttribute('dir'), lines: offsets.length, farthest: Math.max(...offsets.map(Math.abs)) }
      }),
    )
    // The Arabic section, the English one under its name, then the footer: its mark and the Arabic line (the leading language's), and the English line.
    expect(sections.map((section) => `${section.language}/${section.direction}`)).toEqual(['ar/rtl', 'en/ltr', 'ar/rtl', 'en/ltr'])
    for (const section of sections) expect(section.farthest, `${section.language}: a line away from its side`).toBeLessThanOrEqual(1)
    // "Hello Sara Ahmad," in the English section and «مرحبًا Sara Ahmad،» in the Arabic one.
    await expect(page.locator('[data-preview-section][lang="en"]').first()).toContainText('Hello Sara Ahmad,')
    await expect(page.locator('[data-preview-section][lang="ar"]').first()).toContainText('مرحبًا Sara Ahmad،')
  })
})
