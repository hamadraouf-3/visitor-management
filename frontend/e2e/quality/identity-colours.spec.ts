import { AxeBuilder } from '@axe-core/playwright'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { LANGUAGE_STORAGE_KEY, type Language } from '../../src/i18n/languages.ts'
import type { CompanyBrand } from '../../src/types/api.ts'
import { platformStorageStatePath } from '../support/accounts.ts'
import { Api } from '../support/api.ts'
import { contextOptions, DEVICES, expect, test, type DeviceName } from '../support/fixtures.ts'
import { AWKWARD_COLOURS, createCompany, ICON_PNG, LOGO_PNG, putBrandAsset, rgb, rootToken, setBrandColour, shellBackground, signInFirstTime, type OwnCompany } from '../support/identity.ts'
import { STATE_DIR } from '../support/paths.ts'
import { horizontalOverflow, uniqueTag } from '../support/ui.ts'

/*
 * A company's colour never makes a page unreadable (Phase 12): the pages of a company whose colour
 * is one of the awkward ones (the yellow #f7b916, black, a very light colour) pass axe-core with no
 * serious or critical violation, in English and in Arabic, signed out (the company's sign-in page,
 * its password pages, its visitors' pass) and signed in (the shell, lists, the dashboard, the dark
 * reception screen, the reports' charts, the printed sheet's page), on the desktop and the phone; the
 * key pages also in the dark colour scheme. The palette is the server's own, derived from the colour.
 *
 * The company is this spec's own, one per project: its colour is company-wide, so no seeded company's
 * is touched. The tests of a project run in order (they change the same company's colour).
 */

// Each test opens a dozen pages in two or four contexts and runs axe on every one: far more than a page's test.
test.describe.configure({ mode: 'serial', timeout: 300_000 })

const LANGUAGES: readonly Language[] = ['en', 'ar']
/** A token of the right shape: the pass page is static and never asks the server about it. */
const PASS_TOKEN = randomBytes(32).toString('base64url')

let platform: Api
let own: OwnCompany
let adminState: string
let device: DeviceName

test.beforeEach(() => {
  test.skip(test.info().project.name === 'tablet', 'The desktop and the phone cover both layouts of the shell.')
})

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name === 'tablet') return
  device = testInfo.project.name in DEVICES ? (testInfo.project.name as DeviceName) : 'desktop'
  const tag = uniqueTag()
  platform = await Api.platform()
  own = await createCompany(platform, tag)
  // A logo for light surfaces only: on the shell it stands on its white plate.
  await putBrandAsset(platform, own.company.id, 'logo', LOGO_PNG)
  await putBrandAsset(platform, own.company.id, 'icon', ICON_PNG)

  // Its administrator, with every role, so one session reaches every page.
  const context = await browser.newContext(contextOptions(undefined, { device }))
  const { api } = await signInFirstTime(context, own.admin.email, own.admin.temporaryPassword)
  const me = await api.me()
  await api.ok('PATCH', `/users/${me.user.id}`, { roles: ['SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST', 'MANAGEMENT'] })
  adminState = path.join(STATE_DIR, `identity-${testInfo.project.name}-${tag}.json`)
  await context.storageState({ path: adminState })
  await context.close()
})

test.afterAll(async () => {
  await platform?.dispose()
})

async function expectReadable(page: Page, what: string) {
  // Every loading spinner is gone, so the page shows its content.
  await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help} — ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.any[0]?.message ?? ''}`).join(', ')}`),
    `serious or critical axe violations: ${what}`,
  ).toEqual([])
  expect(await horizontalOverflow(page), `horizontal page overflow in px: ${what}`).toBeLessThanOrEqual(0)
}

/** A context of the project's device in a language and a colour scheme; signed in with `state`. */
function openContext(browser: Browser, language: Language, { state, scheme = 'light' }: { state?: string; scheme?: 'light' | 'dark' } = {}): Promise<BrowserContext> {
  return browser.newContext({
    ...contextOptions(undefined, { device }),
    locale: language === 'ar' ? 'ar-JO' : 'en-US',
    colorScheme: scheme,
    ...(state ? { storageState: state } : {}),
  })
}

const SIGNED_OUT = (slug: string) => [`/c/${slug}`, `/forgot-password?c=${slug}`, `/reset-password?c=${slug}`, `/pass?c=${slug}#${PASS_TOKEN}`]
const SIGNED_IN = ['/visits', '/visits/new', '/visitors', '/reception', '/reception?tab=walk-in', '/inside', '/history', '/reports', '/admin', '/admin/users', '/admin/settings', '/admin/email-templates', '/change-password']
/** The pages the dark colour scheme is checked on too: the dark tokens and the deep shell. */
const DARK_SCHEME = ['/visits', '/reception', '/admin']

for (const [name, colour] of Object.entries(AWKWARD_COLOURS)) {
  test.describe(`a company whose colour is ${name} (${colour})`, () => {
    let brand: CompanyBrand

    test.beforeAll(async () => {
      if (!platform) return
      brand = await setBrandColour(platform, own.company.id, colour)
    })

    for (const language of LANGUAGES) {
      test(`${name} · ${language} · signed out: the sign-in, password and pass pages`, async ({ browser }) => {
        const slug = own.company.slug
        for (const scheme of ['light', 'dark'] as const) {
          const context = await openContext(browser, language, { scheme })
          const page = await context.newPage()
          for (const address of SIGNED_OUT(slug)) {
            await page.goto(address)
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
            await expect(page.locator('html')).toHaveAttribute('lang', language)
            // The company's palette is on the page: its surface, which is its own colour wherever an ink reads on it.
            await expect.poll(() => rootToken(page, '--brand-light-accent')).toBe(brand.palette!.surface)
            await expectReadable(page, `${address} (${scheme})`)
          }
          await context.close()
        }
      })

      test(`${name} · ${language} · signed in: the shell and its pages`, async ({ browser }) => {
        const context = await openContext(browser, language, { state: adminState })
        // The account's own language, so the signed-in pages follow it whatever the company's default.
        await Api.of(context).ok('PATCH', '/auth/preferences', { language })
        const page = await context.newPage()
        for (const address of SIGNED_IN) {
          await page.goto(address)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await expect(page.locator('html')).toHaveAttribute('lang', language)
          await expectReadable(page, address)
        }
        // The shell is the palette's surface (the yellow itself, under dark ink), with the logo on its white plate.
        await page.goto('/visits')
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        expect(await shellBackground(page)).toBe(rgb(brand.palette!.surface))
        expect(await page.locator('aside:visible, header[data-app-bar]:visible').first().evaluate((element) => getComputedStyle(element).color)).toBe(rgb(brand.palette!.on_surface))
        await expect(page.locator('[data-identity-lockup="shell"]:visible [data-logo-plate] img').first()).toBeVisible()
        await context.close()

        const dark = await openContext(browser, language, { state: adminState, scheme: 'dark' })
        const darkPage = await dark.newPage()
        for (const address of DARK_SCHEME) {
          await darkPage.goto(address)
          await expect(darkPage.getByRole('heading', { level: 1 })).toBeVisible()
          await expectReadable(darkPage, `${address} (dark)`)
        }
        // In the dark scheme the shell is the deep shade.
        expect(await shellBackground(darkPage)).toBe(rgb(brand.palette!.deep))
        await dark.close()
      })
    }
  })
}

test('the platform owner’s identity and email-text pages of that company, in both languages', async ({ browser }) => {
  for (const language of LANGUAGES) {
    const context = await browser.newContext({ ...contextOptions(undefined, { device }), storageState: platformStorageStatePath() })
    // The platform account has no language of its own: its pages follow the device's.
    await context.addInitScript(([key, value]) => window.localStorage.setItem(key!, value!), [LANGUAGE_STORAGE_KEY, language])
    const page = await context.newPage()
    const base = `/platform/companies/${own.company.id}`
    for (const address of [base, `${base}/identity`, `${base}/email-templates`, `${base}/email-templates/VISITOR_INVITATION`, '/platform/companies']) {
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      if (address.endsWith('/identity')) await expect(page.locator('[data-identity-preview]')).toBeVisible()
      await expectReadable(page, `${address} (${language})`)
      // The platform's own pages keep the product's colours, whatever the company's.
      expect(await rootToken(page, '--brand-light-accent')).toBe('')
    }
    await context.close()
  }
})
