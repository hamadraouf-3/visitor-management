import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.ts'
import { productTraces } from './support/identity.ts'
import { strongPassword, uniqueTag } from './support/ui.ts'

/*
 * Arabic, right to left (phase 10, F10-13): the one spec that reads the Arabic UI; every other spec
 * reads English (the global setup pins it, F10-12). On the desktop (sidebar) and the phone (top bar
 * and drawer), the two layouts of the shell:
 * - signed out: the sign-in page of no company (Phase 12: no logo and no product name, its own mark
 *   and icon) switches to Arabic and back, `<html lang dir>` follow, the self-hosted Arabic font
 *   loads, and the choice survives a reload (device memory);
 * - signed in: a user of its own (never a seeded account, whose language every other spec relies
 *   on), without a language of its own, chooses Arabic on the sign-in page and signs in: the choice
 *   is kept over the company's default and saved to the account (PATCH /auth/preferences, phase 10
 *   review: it fell back to English), the shell shows the company's own identity (the logo the seed
 *   gave it, its Arabic name in the title), the layout is mirrored (the navigation on the right) and
 *   it survives a reload; then back to English with the shell's switch, saved the same way.
 * Both run axe-core in Arabic: no serious or critical violation.
 */

test.beforeEach(() => {
  test.skip(test.info().project.name === 'tablet', 'The desktop and the phone cover both layouts of the shell.')
})

async function expectNoAxeViolations(page: Page) {
  // Every loading spinner is gone, so the page shows its content.
  await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
    'serious or critical axe violations in Arabic',
  ).toEqual([])
}

async function expectDirection(page: Page, language: 'ar' | 'en') {
  await expect(page.locator('html')).toHaveAttribute('lang', language)
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
}

test('sign-in page: Arabic, right to left, remembered on the device, and back to English', async ({ open }) => {
  const { page } = await open()
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expectDirection(page, 'en')
  // The page of no company: its title is the page's alone.
  await expect(page).toHaveTitle('Sign in')

  await page.getByRole('button', { name: 'العربية' }).click()
  await expectDirection(page, 'ar')
  await expect(page).toHaveTitle('تسجيل الدخول')
  // No small print under the form (brand pass, decision 3).
  await expect(page.getByRole('contentinfo')).toHaveCount(0)

  // No company is known here: no logo and no name, of a company or of the product; the page's own mark and the neutral icon.
  await expect(page.locator('[data-neutral-mark]')).toBeVisible()
  await expect(page.locator('[data-identity-lockup], [data-brand-lockup], [data-page-identity] img')).toHaveCount(0)
  await expect(page.locator('head link[rel="icon"]').first()).toHaveAttribute('href', /^\/icons\/neutral-/)
  await expect(page.locator('head link[rel="manifest"]')).toHaveCount(0)
  expect(await productTraces(page)).toEqual([])

  // Readex Pro, self-hosted, renders the Arabic text.
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => [...document.fonts].some((face) => face.family.includes('Readex Pro') && face.status === 'loaded'))).toBe(true)

  // The switch sits at the inline end: on the left in Arabic.
  const toEnglish = page.getByRole('button', { name: 'English' })
  const box = await toEnglish.boundingBox()
  expect(box!.x + box!.width / 2).toBeLessThan(page.viewportSize()!.width / 2)

  await expectNoAxeViolations(page)

  await page.reload()
  await expectDirection(page, 'ar')
  await page.getByRole('button', { name: 'English' }).click()
  await expectDirection(page, 'en')
  await expect(page).toHaveTitle('Sign in')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(await productTraces(page)).toEqual([])
})

test('signed-in shell: Arabic chosen at sign-in, right to left, saved to the account, and back to English', async ({ apiAs, open }) => {
  const tag = uniqueTag()
  const name = `Rana Haddad ${tag}`
  const email = `rana.rtl.${tag}@demo.local`
  const temporary = strongPassword()
  const password = strongPassword()
  const admin = await apiAs('admin')
  await admin.ok('POST', '/users', { full_name: name, email, roles: ['EMPLOYEE'], temporary_password: temporary })

  const { page, context, api } = await open()
  const signedIn = await context.request.post('/api/v1/auth/login', { data: { email, password: temporary } })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await api.ok('POST', '/auth/change-password', { current_password: temporary, new_password: password })
  expect((await api.me()).user.preferred_language, 'no language of its own yet').toBeNull()
  await api.ok('POST', '/auth/logout')

  // Arabic chosen on the sign-in page (an English browser), then signing in in Arabic.
  await page.goto('/login')
  await expectDirection(page, 'en')
  await page.getByRole('button', { name: 'العربية' }).click()
  await expectDirection(page, 'ar')
  await page.getByLabel('البريد الإلكتروني', { exact: true }).fill(email)
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password)
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/preferences') && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click()
  expect((await saved).status(), 'PATCH /auth/preferences').toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'زياراتي' })).toBeVisible()
  await expectDirection(page, 'ar')
  // The company's own name ends the title, in Arabic.
  const { company } = await api.me()
  await expect(page).toHaveTitle(`زياراتي · ${company.name_ar}`)
  expect((await api.me()).user.preferred_language).toBe('ar')

  // The company's identity on the shell: its logo for dark surfaces (the seed gave this company the
  // Mawdoo3 identity as its own), served by the API and loaded, named by the company's Arabic name;
  // nothing of the product. The account menu in Arabic.
  const lockup = page.locator('[data-identity-lockup="shell"]:visible').first()
  const logo = lockup.locator('img')
  await expect(logo).toBeVisible()
  await expect(logo).toHaveAttribute('data-company-logo', 'dark')
  await expect(logo).toHaveAttribute('src', new RegExp(`^/api/v1/public/companies/${company.slug}/brand/logo_dark\\.png\\?v=`))
  await expect(logo).toHaveAttribute('alt', company.name_ar!)
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  expect(await productTraces(page)).toEqual([])
  await expect(page.getByRole('button', { name: `قائمة الحساب: ${name}` })).toBeVisible()
  const viewport = page.viewportSize()!

  if (test.info().project.name === 'desktop') {
    // The sidebar is on the right, the inline start of Arabic.
    const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' })
    await expect(nav.getByRole('link', { name: 'زياراتي' })).toHaveAttribute('aria-current', 'page')
    const sidebar = await page.getByRole('complementary').boundingBox()
    expect(sidebar!.x + sidebar!.width).toBeGreaterThan(viewport.width - 2)
    expect(sidebar!.x).toBeGreaterThan(viewport.width / 2)
  } else {
    // The drawer opens from the right.
    await page.getByRole('button', { name: 'فتح قائمة التنقل' }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('link', { name: 'زياراتي' })).toBeVisible()
    const panel = await drawer.boundingBox()
    expect(panel!.x + panel!.width).toBeGreaterThan(viewport.width - 2)
    await page.getByRole('button', { name: 'إغلاق القائمة' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }

  await expectNoAxeViolations(page)

  // Saved to the account: a new page load starts in Arabic.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'زياراتي' })).toBeVisible()
  await expectDirection(page, 'ar')

  const back = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/preferences') && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'English' }).click()
  expect((await back).status()).toBe(200)
  await expectDirection(page, 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible()
  await expect(page).toHaveTitle(`My visits · ${company.name}`)
  await expect(page.getByRole('button', { name: `Account menu for ${name}` })).toBeVisible()
  expect((await api.me()).user.preferred_language).toBe('en')
})
