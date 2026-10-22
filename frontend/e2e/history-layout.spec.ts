import { expect, test, type Page } from '@playwright/test'
import type { Me, Paginated, Visit } from '../src/types/api.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * Layout regression: the visit history must fit its card at every desktop width (finding of
 * the Phase 5–7 gate: at 1024, 1280 and 1440 px the table was wider than its box and hid the
 * Attendance column behind a scroll box). The API is mocked, so this spec needs only the Vite
 * server; the widths are set per test, so it runs in the desktop project only.
 */

const ME: Me = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'Lina Haddad',
    email: 'lina.haddad@example.com',
    phone: null,
    roles: ['SYSTEM_ADMIN'],
    department: null,
    must_change_password: false,
    preferred_language: null,
  },
  company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Demo Holdings', name_ar: null, slug: 'demo-holdings', timezone: 'Asia/Amman', default_language: 'en', brand: UNBRANDED, address: null, address_ar: null, tracking_allowed: false },
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The widest values a row can hold: a 48-character host, a long company, every method badge. */
function visit(index: number): Visit {
  const start = Date.parse('2026-10-05T06:00:00Z') - index * 86_400_000
  const actor = { id: ME.user.id, full_name: ME.user.full_name }
  return {
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    status: 'CHECKED_OUT',
    visitor: { id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`, full_name: 'Mohammad Abdel-Rahman Al-Khatib', company_name: 'Blue Ridge Consulting Group International' },
    host: { id: '00000000-0000-4000-8000-0000000000a1', full_name: 'Alexander Maximilian von Hohenberg-Schwarzenfeld', phone: null },
    department: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Research and Development', name_ar: null },
    purpose: 'Insurance renewal discussion for the 2027 policy year with the underwriting team',
    scheduled_start: iso(start),
    scheduled_end: iso(start + 90 * 60_000),
    window_start: iso(start - 3_600_000),
    window_end: iso(start + 150 * 60_000),
    is_walk_in: false,
    walk_in_reason: null,
    check_in_at: iso(start - 20 * 60_000),
    check_in_method: 'OVERRIDE',
    check_in_note: 'Arrived early – host confirmed',
    checked_in_by: actor,
    check_out_at: iso(start + 26 * 3_600_000),
    check_out_method: 'CORRECTED',
    check_out_note: 'Left without checking out',
    checked_out_by: actor,
    cancelled_at: null,
    cancellation_reason: null,
    cancelled_by: null,
    no_show_at: null,
    duration_seconds: 26 * 3600 + 20 * 60,
    is_overdue: false,
    is_stale: false,
    created_by: actor,
    created_at: iso(start - 86_400_000),
    updated_at: iso(start - 86_400_000),
    invitation: { status: 'SENT', to_email: 'visitor@example.com', attempts: 1, last_attempt_at: iso(start), sent_at: iso(start), error: null, calendar_failed: false },
    last_notice: null,
    access_areas: { floors: [], zones: [] },
    calendar_sequence: 0,
    visitor_calendar_sent: false,
    pass: { status: 'REVOKED', issued_at: iso(start - 86_400_000), revoke_reason: 'VISIT_COMPLETED' },
    permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: false, can_check_out: false, can_edit_access_areas: false },
  }
}

async function mockApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    if (path === '/auth/me') return route.fulfill({ json: ME })
    if (path === '/visits') {
      const body: Paginated<Visit> = { items: Array.from({ length: 25 }, (_, index) => visit(index)), page: 1, page_size: 25, total: 25 }
      return route.fulfill({ json: body })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
}

test.describe('visit history layout', () => {
  for (const width of [1024, 1280, 1440]) {
    test(`fits its card without a horizontal scroll at ${width} px`, async ({ page }) => {
      test.skip(test.info().project.name !== 'desktop', 'Sets its own desktop widths')
      await page.setViewportSize({ width, height: 900 })
      await mockApi(page)
      await page.goto('/history')
      const table = page.getByRole('table', { name: 'Visit history' })
      await expect(table.getByRole('link', { name: 'Mohammad Abdel-Rahman Al-Khatib' }).first()).toBeVisible()

      const box = await table.evaluate((element) => {
        const wrapper = element.parentElement as HTMLElement
        return { scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }
      })
      expect(box.scrollWidth).toBe(box.clientWidth)
      expect(box.page).toBe(0)
      // Attendance, the main fact of a visit's history, lies inside the card, not behind a scroll.
      const attendance = table.getByText('In 08:40 · Out Tue, 6 Oct 2026, 11:00').first()
      await expect(attendance).toBeVisible()
      const [cell, card] = await Promise.all([attendance.boundingBox(), table.boundingBox()])
      expect(cell && card && cell.x + cell.width <= card.x + card.width + 0.5).toBe(true)
    })
  }
})
