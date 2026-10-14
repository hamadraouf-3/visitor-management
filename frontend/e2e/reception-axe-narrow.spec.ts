import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Me, ReceptionToday } from '../src/types/api.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * Accessibility at a narrow width without touch: a desktop window 390 px wide, or a page zoomed
 * to 400 % (WCAG 1.4.10 reflow), lays out like a phone but keeps a fine pointer, so the touch
 * sizes (`pointer-coarse:`) do not apply. axe found the reception's "Beep on check-in and
 * check-out" checkbox at 20 px with 23 px of clear space there (target-size, WCAG 2.2 SC 2.5.8,
 * serious). The API is mocked; this spec needs only the Vite server and runs once, in the
 * desktop project (which has a fine pointer), at 390 px.
 */

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
  company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Demo Holdings', name_ar: null, slug: 'demo-holdings', timezone: 'Asia/Amman', default_language: 'en', brand: UNBRANDED },
}

const TODAY: ReceptionToday = {
  date: '2026-10-06',
  counts: { expected: 0, inside: 0, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 },
  expected: [],
  inside: [],
  checked_out: [],
  no_show: [],
}

test('the reception Scan tab has no serious or critical axe violations at 390 px with a fine pointer', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'Needs a fine pointer')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    if (path === '/auth/me') return route.fulfill({ json: ME })
    if (path === '/reception/today') return route.fulfill({ json: TODAY })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
  await page.goto('/reception')
  const beep = page.getByRole('checkbox', { name: 'Beep on check-in and check-out' })
  await expect(beep).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true)
  // At 24 px a target passes SC 2.5.8 whatever its neighbours (the camera picker shares its row
  // when there are several cameras), so this does not depend on the layout axe happens to see.
  const box = await beep.boundingBox()
  expect(box && Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24)

  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
})
