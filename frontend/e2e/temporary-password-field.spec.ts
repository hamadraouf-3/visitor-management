import { expect, test, type Page } from '@playwright/test'
import type { Department, Me, UserPage } from '../src/types/api.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * The new account's temporary password (Users → Add user → Generate) is read off the screen and
 * handed over, so none of it may hide under the show/hide button. In Arabic the button covered the
 * password's first two characters (Arabic acceptance run, L-23): the input is left to right, so its
 * `pe-12` put the room for the button on the right, while the button's `end-0` followed the
 * right-to-left page and sat on the left. Measured in the browser: the button must not reach into
 * the input's content box (the box minus its padding and border), where the text is drawn. The API
 * is mocked; the test runs in all three projects, in English and in Arabic.
 */

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

const ADMIN: Me = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'Amal Haddad',
    email: 'amal.haddad@example.com',
    phone: null,
    roles: ['SYSTEM_ADMIN'],
    department: null,
    must_change_password: false,
    preferred_language: null,
  },
  company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Mawdoo3', name_ar: 'موضوع', slug: 'mawdoo3', timezone: 'Asia/Amman', default_language: 'ar', brand: UNBRANDED, address: null, address_ar: null, tracking_allowed: false },
}
const DEPARTMENTS: Department[] = [{ id: '00000000-0000-4000-8000-0000000000d1', name: 'IT', name_ar: null, is_active: true, created_at: iso(NOW), updated_at: iso(NOW), floor: null }]

const WORDS = {
  en: { add: 'Add user', generate: 'Generate', password: 'Temporary password', toggle: 'Show password' },
  ar: { add: 'إضافة مستخدم', generate: 'إنشاء تلقائي', password: 'كلمة المرور المؤقتة', toggle: 'إظهار كلمة المرور' },
} as const

async function mockApi(page: Page, language: 'ar' | 'en') {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    const key = `${request.method()} ${path}`
    if (key === 'GET /auth/me') return route.fulfill({ json: { ...ADMIN, user: { ...ADMIN.user, preferred_language: language } } satisfies Me })
    if (key === 'GET /users') return route.fulfill({ json: { items: [], page: 1, page_size: 20, total: 0 } satisfies UserPage })
    if (key === 'GET /departments') return route.fulfill({ json: DEPARTMENTS })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
}

for (const language of ['en', 'ar'] as const) {
  test(`the show/hide button leaves the whole generated temporary password visible (${language})`, async ({ page }) => {
    const words = WORDS[language]
    await mockApi(page, language)
    await page.goto('/admin/users')
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    await page.getByRole('button', { name: words.add }).first().click()
    const dialog = page.getByRole('dialog', { name: words.add })
    await dialog.getByRole('button', { name: words.generate }).click()
    const input = dialog.getByLabel(words.password, { exact: true })
    await expect(input).toHaveValue(/^\S{12,}$/)
    const toggle = dialog.getByRole('button', { name: words.toggle })
    await expect(toggle).toBeVisible()

    const geometry = await input.evaluate((element, toggleName) => {
      const field = element as HTMLInputElement
      const style = getComputedStyle(field)
      const box = field.getBoundingClientRect()
      const content = {
        left: box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
        right: box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
      }
      const button = [...(field.parentElement?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent?.trim() === toggleName)
      const rect = button!.getBoundingClientRect()
      // The text's own width (monospace, so its advance), drawn from the content box's start.
      const canvas = document.createElement('canvas').getContext('2d')!
      canvas.font = style.font
      return { content, button: { left: rect.left, right: rect.right }, textWidth: canvas.measureText(field.value).width, direction: style.direction }
    }, words.toggle)

    expect(geometry.direction).toBe('ltr')
    // The button lies wholly outside the content box, on its inline end (the right: the password reads left to right).
    expect(geometry.button.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.content.right - 0.5)
    // And the generated password fits the content box, so none of it scrolls under the button either.
    expect(geometry.textWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.content.right - geometry.content.left)
  })
}
