import { expect, test, type Locator, type Page } from '@playwright/test'
import type { CompanySettings, Department, Host, InsideList, Me, ReceptionToday, ScanResult, Visit, VisitorSearchPage } from '../src/types/api.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * A toast must never take the tap meant for the reception's primary actions (6 s). On a phone they
 * sit at the bottom of the screen: the scan result's full-width "Check in" bar and the confirm
 * buttons of bottom-sheet dialogs (gate finding: a full-width toast at the bottom covered them).
 * On the reception tablet (820 px) and on desktops the scan result's action row ends the result
 * panel at the bottom of the inline end, where toasts used to sit from 640 px: the Arabic
 * acceptance run found the walk-in's toast over the next visitor's Check in (L-21), and at 1440 px
 * it covered the whole button. Toasts are at the top centre at every width now. The API is mocked;
 * this spec needs only the Vite server. The first test runs in the mobile project (390 × 844,
 * touch), the second in all three (1440, 820 and 390 px), in English and in Arabic.
 */

const NOW = Date.now()
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const PASS_TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'

const ME: Me = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'Rana Saleh',
    email: 'rana.saleh@example.com',
    phone: null,
    roles: ['RECEPTIONIST'],
    department: null,
    must_change_password: false,
    preferred_language: null,
  },
  company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Demo Holdings', name_ar: null, slug: 'demo-holdings', timezone: 'Asia/Amman', default_language: 'en', brand: UNBRANDED, address: null, address_ar: null },
}

function visit(id: string, name: string, overrides: Partial<Visit> = {}): Visit {
  return {
    id,
    status: 'SCHEDULED',
    visitor: { id: `${id}-visitor`, full_name: name, company_name: 'Orbit Labs' },
    host: { id: '00000000-0000-4000-8000-0000000000aa', full_name: 'Omar Khalil', phone: '+962 79 000 0077' },
    department: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Legal', name_ar: null },
    purpose: 'Quarterly review',
    scheduled_start: iso(NOW - 10 * MIN),
    scheduled_end: iso(NOW + 50 * MIN),
    window_start: iso(NOW - 70 * MIN),
    window_end: iso(NOW + 110 * MIN),
    is_walk_in: false,
    walk_in_reason: null,
    check_in_at: null,
    check_in_method: null,
    check_in_note: null,
    checked_in_by: null,
    check_out_at: null,
    check_out_method: null,
    check_out_note: null,
    checked_out_by: null,
    cancelled_at: null,
    cancellation_reason: null,
    cancelled_by: null,
    no_show_at: null,
    duration_seconds: null,
    is_overdue: false,
    is_stale: false,
    created_by: { id: ME.user.id, full_name: ME.user.full_name },
    created_at: iso(NOW - 86_400_000),
    updated_at: iso(NOW - 86_400_000),
    invitation: { status: 'SENT', to_email: 'visitor@example.com', attempts: 1, last_attempt_at: iso(NOW - 86_400_000), sent_at: iso(NOW - 86_400_000), error: null, calendar_failed: false },
    last_notice: null,
    calendar_sequence: 0,
    visitor_calendar_sent: false,
    pass: { status: 'ACTIVE', issued_at: iso(NOW - 86_400_000), revoke_reason: null },
    permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: true, can_check_out: false },
    ...overrides,
  }
}

const insideVisit = (id: string, name: string) =>
  visit(id, name, {
    status: 'CHECKED_IN',
    check_in_at: iso(NOW - 40 * MIN),
    check_in_method: 'QR',
    permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: false, can_check_out: true },
  })

const INSIDE = [insideVisit('00000000-0000-4000-8000-000000000011', 'Élodie Martin'), insideVisit('00000000-0000-4000-8000-000000000012', 'Karim Nasser')]
const TODAY: ReceptionToday = {
  date: new Date(NOW).toISOString().slice(0, 10),
  counts: { expected: 1, inside: INSIDE.length, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 },
  expected: [visit('00000000-0000-4000-8000-000000000021', 'Sara Haddad')],
  inside: [],
  checked_out: [],
  no_show: [],
}

const HOST: Host = {
  id: '00000000-0000-4000-8000-0000000000aa',
  full_name: 'Omar Khalil',
  phone: '+962 79 000 0077',
  department: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Legal', name_ar: null },
}
const DEPARTMENTS: Department[] = [{ id: '00000000-0000-4000-8000-0000000000d1', name: 'Legal', name_ar: null, is_active: true, created_at: iso(NOW - 86_400_000), updated_at: iso(NOW - 86_400_000) }]
const SETTINGS: CompanySettings = {
  id: ME.company.id,
  name: ME.company.name,
  name_ar: null,
  default_language: 'en',
  timezone: 'Asia/Amman',
  address: null,
  address_ar: null,
  email_domain: null,
  pass_grace_before_minutes: 60,
  pass_grace_after_minutes: 60,
  notify_host_on_check_in: true,
  allow_walk_ins: true,
}
const WALK_IN = visit('00000000-0000-4000-8000-000000000031', 'Tariq Mansour', {
  status: 'CHECKED_IN',
  is_walk_in: true,
  walk_in_reason: 'DELIVERY',
  check_in_at: iso(NOW),
  check_in_method: 'WALK_IN',
  permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: false, can_check_out: true },
})

async function mockApi(page: Page, language: 'ar' | 'en' | null = null) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    const key = `${request.method()} ${path}`
    if (key === 'GET /auth/me') return route.fulfill({ json: { ...ME, user: { ...ME.user, preferred_language: language } } satisfies Me })
    if (key === 'GET /company/settings') return route.fulfill({ json: SETTINGS })
    if (key === 'GET /departments') return route.fulfill({ json: DEPARTMENTS })
    if (key === 'GET /users/hosts') return route.fulfill({ json: [HOST] })
    if (key === 'GET /visitors') return route.fulfill({ json: { items: [], page: 1, page_size: 20, total: 0 } satisfies VisitorSearchPage })
    if (key === 'POST /reception/walk-ins') return route.fulfill({ status: 201, json: WALK_IN })
    if (key === 'GET /reception/today') return route.fulfill({ json: TODAY })
    if (key === 'GET /reception/inside') return route.fulfill({ json: { count: INSIDE.length, items: INSIDE.map((v) => ({ ...v, visitor: { ...v.visitor, phone: null } })) } satisfies InsideList })
    if (key === 'POST /reception/scan') return route.fulfill({ json: { result: 'READY', visit: TODAY.expected[0]!, warnings: [], actions: { check_in: true, check_out: false } } satisfies ScanResult })
    const checkOut = INSIDE.find((v) => key === `POST /visits/${v.id}/check-out`)
    if (checkOut) return route.fulfill({ json: { ...checkOut, status: 'CHECKED_OUT', check_out_at: iso(NOW), check_out_method: 'MANUAL' } })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
}

/** What a tap at the centre of `target` would hit: the target itself, or a toast over it. */
async function tapTarget(page: Page, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error('The target is not on screen')
  return page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return { button: hit?.closest('button')?.textContent?.trim() ?? null, onToast: Boolean(hit?.closest('[data-toast-region]')) }
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
}

test('a toast on a phone leaves the scan result’s Check in and a dialog’s confirm button free to tap', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'A phone layout with touch')
  await mockApi(page)
  await page.goto('/reception?tab=inside')

  // A one-tap check-out shows a success toast for 6 s.
  await page.getByRole('list', { name: 'Visitors inside' }).getByRole('listitem').first().getByRole('button', { name: 'Check out' }).click()
  const toast = page.getByText('Élodie Martin checked out')
  await expect(toast).toBeVisible()
  const toastBox = await toast.boundingBox()
  // At the top of the screen, away from the bottom action zone.
  expect(toastBox!.y).toBeLessThan(844 / 4)

  // A bottom-sheet dialog's confirm button.
  await page.getByRole('button', { name: 'More actions for Karim Nasser' }).click()
  await page.getByRole('menuitem', { name: 'Correct check-out time' }).click()
  const save = page.getByRole('dialog').getByRole('button', { name: 'Save check-out' })
  await expect(save).toBeVisible()
  await expect(toast).toBeVisible()
  expect(await tapTarget(page, save)).toEqual({ button: 'Save check-out', onToast: false })
  await page.keyboard.press('Escape')

  // The scan result's full-width Check in bar.
  await page.getByRole('tab', { name: /^Scan/ }).click()
  await page.getByRole('button', { name: 'Enter or paste pass' }).click()
  await page.getByLabel('Scan or paste a pass').fill(PASS_TOKEN)
  await page.keyboard.press('Enter')
  const checkIn = page.getByRole('button', { name: 'Check in', exact: true })
  await expect(checkIn).toBeVisible()
  await expect(toast).toBeVisible()
  expect(await tapTarget(page, checkIn)).toEqual({ button: 'Check in', onToast: false })
})

/** The words this test reads, in the two UI languages (the reception and visitors catalogs). */
const WORDS = {
  en: {
    walkInTab: 'Walk-in',
    fullName: 'Full name',
    host: 'Host',
    purpose: 'Purpose',
    oneHour: '1 hour',
    delivery: 'Delivery',
    submit: 'Check in walk-in',
    toast: 'Tariq Mansour checked in',
    toastDescription: 'Registered as a walk-in.',
    scanTab: 'Scan',
    passField: 'Scan or paste a pass',
    passOpen: 'Enter or paste pass',
    checkIn: 'Check in',
    scanNext: 'Scan next',
  },
  ar: {
    walkInTab: 'بدون موعد',
    fullName: 'الاسم الكامل',
    host: 'المضيف',
    purpose: 'الغرض من الزيارة',
    oneHour: 'ساعة',
    delivery: 'توصيل',
    submit: 'تسجيل دخول الزائر',
    toast: 'سُجّل دخول Tariq Mansour',
    toastDescription: 'تم التسجيل بدون موعد.',
    scanTab: 'المسح',
    passField: 'امسح البطاقة أو الصقها',
    passOpen: 'إدخال البطاقة أو لصقها',
    checkIn: 'تسجيل الدخول',
    scanNext: 'مسح التالي',
  },
} as const

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Whether two boxes share any area. */
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Whether a tap at the centre or near a corner of `target` would land on a toast. */
async function anyTapOnToast(page: Page, target: Locator): Promise<boolean> {
  const box = await target.boundingBox()
  if (!box) throw new Error('The target is not on screen')
  const inset = 4
  const points = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + inset, y: box.y + box.height - inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
  ]
  return page.evaluate((spots) => spots.some(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-toast-region]'))), points)
}

for (const language of ['en', 'ar'] as const) {
  test(`after a walk-in, the toast leaves the next visitor’s Check in and Scan next free on every screen (${language})`, async ({ page }) => {
    const words = WORDS[language]
    const viewport = page.viewportSize()!
    await mockApi(page, language)
    await page.goto('/reception?tab=walk-in')
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    await expect(page.getByRole('tab', { name: new RegExp(`^${words.walkInTab}`) })).toHaveAttribute('aria-selected', 'true')

    // A walk-in: its toast has a title and a description, the tallest the reception shows.
    await page.getByLabel(words.fullName).fill('Tariq Mansour')
    await page.getByRole('combobox', { name: words.host }).fill('Omar')
    await page.getByRole('option', { name: /Omar Khalil/ }).first().click()
    await page.getByLabel(words.purpose).fill('Parcel delivery')
    for (const radio of [words.oneHour, words.delivery]) {
      const id = await page.getByRole('radio', { name: radio, exact: true }).getAttribute('id')
      await page.locator(`label[for="${id}"]`).click()
    }
    await page.getByRole('button', { name: words.submit }).click()
    const toast = page.locator('[data-toast-region] .shadow-pop').filter({ hasText: words.toast })
    await expect(toast).toBeVisible()
    await expect(toast).toContainText(words.toastDescription)
    await expect(page.getByRole('tab', { name: new RegExp(`^${words.scanTab}`) })).toHaveAttribute('aria-selected', 'true')

    // The next visitor's pass, scanned while the toast is still up.
    const field = page.getByLabel(words.passField)
    if (!(await field.isVisible())) await page.getByRole('button', { name: words.passOpen }).click()
    await field.fill(PASS_TOKEN)
    await page.keyboard.press('Enter')
    const checkIn = page.getByRole('button', { name: words.checkIn, exact: true })
    const scanNext = page.getByRole('button', { name: words.scanNext })
    await expect(checkIn).toBeVisible()
    await expect(toast).toBeVisible()

    // At the top of the screen, centred, clear of the result's actions however the page is scrolled.
    for (const scroll of ['as the scan left it', 'scrolled to the end'] as const) {
      if (scroll === 'scrolled to the end') await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const toastBox = (await toast.boundingBox())!
      for (const [name, button] of [
        [words.checkIn, checkIn],
        [words.scanNext, scanNext],
      ] as const) {
        expect(intersects(toastBox, (await button.boundingBox())!), `${name} under the toast (${scroll})`).toBe(false)
        expect(await anyTapOnToast(page, button), `a tap on ${name} lands on the toast (${scroll})`).toBe(false)
      }
      expect(toastBox.y + toastBox.height, `the toast's bottom (${scroll})`).toBeLessThan(viewport.height / 4)
      expect(Math.abs(toastBox.x + toastBox.width / 2 - viewport.width / 2), `the toast's centre (${scroll})`).toBeLessThanOrEqual(1)
    }
  })
}
