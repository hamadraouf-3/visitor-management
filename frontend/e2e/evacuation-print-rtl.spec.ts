import { expect, test, type Page } from '@playwright/test'
import type { InsideList, InsideVisit, Me } from '../src/types/api.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * The Arabic evacuation list on paper (phase 10 review): the printed sheet carried a physical
 * `lg:print:-ml-64` that undid the sidebar's room in English, but in Arabic the room is on the
 * right, so the sheet was pulled 256 px off the paper's left edge and its first columns were cut
 * off. The layout now drops the sidebar's room itself on paper (`print:ps-0`), in either direction.
 *
 * Checked in print media on the desktop (the sidebar's width, lg+), with the API mocked: the sheet
 * spans the page from edge to edge, its columns run right to left, and its words are Arabic.
 */

const ME: Me = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'رنا صالح',
    email: 'rana.saleh@example.com',
    phone: null,
    roles: ['RECEPTIONIST'],
    department: null,
    must_change_password: false,
    preferred_language: 'ar',
  },
  company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Demo Holdings', name_ar: 'القابضة التجريبية', slug: 'demo-holdings', timezone: 'Asia/Amman', default_language: 'ar', brand: UNBRANDED, address: null, address_ar: null, tracking_allowed: false },
}

const iso = (ms: number) => new Date(ms).toISOString()

function inside(index: number, fullName: string, companyName: string | null): InsideVisit {
  const start = Date.now() - 30 * 60_000
  const actor = { id: ME.user.id, full_name: ME.user.full_name }
  return {
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    status: 'CHECKED_IN',
    visitor: { id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`, full_name: fullName, company_name: companyName, phone: '+962 79 555 0101' },
    host: { id: '00000000-0000-4000-8000-0000000000a1', full_name: 'عمر خليل', phone: '+962 79 000 0077' },
    // The demo's departments have an English name and an Arabic one; the Arabic sheet shows the Arabic name.
    department: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Finance', name_ar: 'المالية' },
    purpose: 'مراجعة ربعية',
    scheduled_start: iso(start),
    scheduled_end: iso(start + 2 * 3_600_000),
    window_start: iso(start - 3_600_000),
    window_end: iso(start + 3 * 3_600_000),
    is_walk_in: false,
    walk_in_reason: null,
    check_in_at: iso(start + index * 60_000),
    check_in_method: 'QR',
    check_in_note: null,
    checked_in_by: actor,
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
    created_by: actor,
    created_at: iso(start),
    updated_at: iso(start),
    invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, last_attempt_at: null, sent_at: null, error: null, calendar_failed: false },
    last_notice: null,
    access_areas: { floors: [], zones: [] },
    calendar_sequence: 0,
    visitor_calendar_sent: false,
    pass: { status: 'ACTIVE', issued_at: iso(start), revoke_reason: null },
    permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: false, can_check_out: true, can_edit_access_areas: false },
  }
}

const VISITS: InsideVisit[] = [inside(1, 'عائشة الرحمن', 'الشحن الخليجي'), inside(2, 'Grace Lee', null)]

async function openList(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    if (path === '/auth/me') return route.fulfill({ json: ME })
    if (path === '/reception/inside') return route.fulfill({ json: { count: VISITS.length, items: VISITS } satisfies InsideList })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
  await page.goto('/inside')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByRole('heading', { level: 1, name: 'داخل المبنى الآن' })).toBeVisible()
}

test('the Arabic evacuation list fits the paper, right to left', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The sidebar takes room from lg up: the desktop is the case that was cut off.')
  await openList(page)
  await page.emulateMedia({ media: 'print' })

  const sheet = page.locator('[data-print-evacuation-list]')
  await expect(sheet).toBeVisible()
  // On paper the navigation is gone and its room with it: the sheet sits in the middle of the
  // page (the page column's own margins on both sides), not pushed toward either edge.
  await expect(page.getByRole('complementary')).toBeHidden()
  const width = page.viewportSize()!.width
  const box = (await sheet.boundingBox())!
  expect(box.x, 'left edge of the sheet').toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, 'right edge of the sheet').toBeLessThanOrEqual(width + 0.5)
  expect(Math.abs(box.x - (width - box.x - box.width)), 'the same margin on both sides').toBeLessThanOrEqual(1)
  expect(box.width, 'the sheet takes the page column').toBeGreaterThan(width / 2)

  // Arabic, and the columns run from the right: "#" first, the roll-call box last.
  await expect(sheet).toContainText('قائمة الإخلاء')
  await expect(sheet).not.toContainText(/Evacuation|Visitor|Checked in|Present/)
  const headers = sheet.locator('th')
  const first = (await headers.first().boundingBox())!
  const last = (await headers.last().boundingBox())!
  expect(first.x, 'the first column on the right').toBeGreaterThan(last.x)
  expect(first.x + first.width).toBeLessThanOrEqual(width + 0.5)
  expect(last.x, 'the last column inside the page').toBeGreaterThanOrEqual(0)
  // Every cell lies on the page: nothing is cut off at either edge.
  for (const cell of await sheet.locator('th, td').all()) {
    const cellBox = (await cell.boundingBox())!
    expect(cellBox.x).toBeGreaterThanOrEqual(0)
    expect(cellBox.x + cellBox.width).toBeLessThanOrEqual(width + 0.5)
  }
})
