import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { LANGUAGE_STORAGE_KEY } from '../src/i18n/languages.ts'
import { Api } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { strongPassword, uniqueTag } from './support/ui.ts'

/*
 * Phase 11's pages in Arabic, right to left (the Arabic smoke spec of F10-13 for the new pages), on the
 * desktop and the phone: the platform owner's sign-in, companies, new company and audit log, and a
 * company's e-mail texts. axe-core finds no serious or critical violation and the pages do not scroll
 * sideways. No seeded account's language changes (every other spec reads English): the platform pages
 * follow the device's language (the platform account has none of its own), and the e-mail texts are read
 * by an administrator the spec creates in Other Corp.
 */

test.beforeEach(() => {
  test.skip(test.info().project.name === 'tablet', 'The desktop and the phone cover both layouts of the shell.')
})

async function expectArabicPage(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`),
    'serious or critical axe violations in Arabic',
  ).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'horizontal overflow').toBeLessThanOrEqual(0)
}

/** Brings the main navigation into view: the sidebar is there on the desktop; a phone has it in a drawer behind a button. */
async function showNavigation(page: Page): Promise<boolean> {
  const openDrawer = page.getByRole('button', { name: 'فتح قائمة التنقل' })
  const drawer = await openDrawer.isVisible()
  if (drawer) await openDrawer.click()
  return drawer
}

/** Closes the phone's drawer again (nothing to do on the desktop). */
async function hideNavigation(page: Page, drawer: boolean): Promise<void> {
  if (!drawer) return
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeHidden()
}

test('the platform owner’s pages in Arabic', async ({ open }) => {
  // Signed out: the platform sign-in switches to Arabic.
  const signedOut = await open()
  await signedOut.page.goto('/platform/login')
  await signedOut.page.getByRole('button', { name: 'العربية' }).click()
  await expect(signedOut.page.getByRole('heading', { level: 1, name: 'تسجيل الدخول إلى المنصة' })).toBeVisible()
  await expect(signedOut.page.getByText('المنصة', { exact: true })).toBeVisible()
  await expectArabicPage(signedOut.page)

  // Signed in, the device in Arabic (the platform account has no language of its own).
  const { page, context } = await open({ platform: true })
  await context.addInitScript(([key]) => window.localStorage.setItem(key, 'ar'), [LANGUAGE_STORAGE_KEY])
  await page.goto('/platform/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'الشركات' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Other Corp' })).toBeVisible()
  await expectArabicPage(page)

  await page.goto('/platform/companies/new')
  await expect(page.getByRole('heading', { level: 1, name: 'إضافة شركة' })).toBeVisible()
  await expect(page.getByLabel('الاسم بالعربية')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByLabel('المعرّف المختصر')).toHaveAttribute('dir', 'ltr')
  await expectArabicPage(page)

  await page.goto('/platform/audit')
  await expect(page.getByRole('heading', { level: 1, name: 'سجل التدقيق' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'أحداث تدقيق المنصة، الأحدث أولًا' })).toBeVisible()
  await expectArabicPage(page)
})

test('a company’s e-mail texts in Arabic', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const email = `rania.texts.${tag}@other.local`
  const temporary = strongPassword()
  const password = strongPassword()
  const otherAdmin = await apiAs('otherAdmin')
  await otherAdmin.ok('POST', '/users', { full_name: `Rania Odeh ${tag}`, email, roles: ['SYSTEM_ADMIN'], temporary_password: temporary })

  const { page, context } = await open()
  const signedIn = await context.request.post('/api/v1/auth/login', { data: { email, password: temporary } })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  const api = Api.of(context)
  await api.ok('POST', '/auth/change-password', { current_password: temporary, new_password: password })
  await api.ok('PATCH', '/auth/preferences', { language: 'ar' })

  await page.goto('/admin/email-templates')
  await expect(page.getByRole('heading', { level: 1, name: 'نصوص الرسائل' })).toBeVisible()
  // The navigation names the section with the same words (the sidebar, or the phone's drawer), and reads in Arabic too.
  const drawer = await showNavigation(page)
  await expect(page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('link', { name: 'نصوص الرسائل', exact: true })).toBeVisible()
  await expectArabicPage(page)
  await hideNavigation(page, drawer)
  await expectArabicPage(page)

  await page.getByRole('link', { name: 'دعوة الزائر' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'دعوة الزائر' })).toBeVisible()
  const arabicSubject = page.locator('[data-template-field="ar.subject"]').getByRole('textbox')
  const englishSubject = page.locator('[data-template-field="en.subject"]').getByRole('textbox')
  await expect(arabicSubject).toHaveAttribute('dir', 'rtl')
  await expect(englishSubject).toHaveAttribute('dir', 'ltr')
  await expect(page.locator('[data-preview-subject]')).toBeVisible({ timeout: 15_000 })
  await expectArabicPage(page)

  // A problem in the words of the Arabic catalog.
  await arabicSubject.fill('زيارتك')
  await expect(page.locator('[data-template-field="ar.subject"]')).toContainText('أدرج «الشركة» في هذا النص.')
  // The braces by their Arabic name, with an example; then the page with every text's variables and its errors.
  await arabicSubject.fill('زيارتك إلى {{company}}')
  await expect(page.locator('[data-template-field="ar.subject"]')).toContainText('اكتب المتغيّر بين حاصرتين، هكذا: {visitor_name}. الحاصرتان للمتغيّرات فقط.')
  await expect(page.getByRole('toolbar', { name: 'المتغيّرات: الموضوع (العربية)' })).toBeVisible()
  await expectArabicPage(page)
})
