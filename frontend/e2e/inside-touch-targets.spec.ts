import { expect, test, type Page } from '@playwright/test'
import type { InsideList, InsideVisit, Me } from '../src/types/api.ts'
import { expectSeparateVisitorTargets, measureVisitorTargets } from './support/hit-targets.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * Touch targets on the evacuation list (/inside), finding of the accessibility audit: on a touch
 * screen below lg (cards), in a row whose visitor has a phone but no company, the phone link's
 * touch area (it reaches 12 px up) covered the lower 8 px of the visitor's name, so a tap there
 * dialled the visitor instead of opening the visit, and the name's band was 30 px tall. In the
 * touch table (lg+) a name on two lines lost its lower 5 px the same way. Now the name and company
 * keep those 12 px clear on every touch layout (ROW_LINK_LINES_ABOVE_TARGET).
 *
 * Measured with elementFromPoint, as a tap lands (support/hit-targets.ts), on every combination of
 * company and phone and a name that wraps. The API is mocked, so this spec needs only the Vite
 * server. The phone and tablet projects (touch) check their own widths and the ones the audit
 * used; the desktop project (mouse) checks that the table is as it was.
 */

const WIDTHS: Record<string, number[]> = { mobile: [320, 390], tablet: [768, 820, 1024], desktop: [1024, 1440] }

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

const iso = (ms: number) => new Date(ms).toISOString()

function inside(index: number, fullName: string, companyName: string | null, phone: string | null): InsideVisit {
  const start = Date.now() - 30 * 60_000
  const actor = { id: ME.user.id, full_name: ME.user.full_name }
  return {
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    status: 'CHECKED_IN',
    visitor: { id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`, full_name: fullName, company_name: companyName, phone },
    host: { id: '00000000-0000-4000-8000-0000000000a1', full_name: 'Omar Khalil', phone: '+962 79 000 0077' },
    department: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Finance', name_ar: null },
    purpose: 'Quarterly review',
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
    calendar_sequence: 0,
    visitor_calendar_sent: false,
    pass: { status: 'ACTIVE', issued_at: iso(start), revoke_reason: null },
    permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: false, can_check_out: true },
  }
}

/** Every combination of company and phone; the audit's rows (Grace Lee, Tom Ng) and a name that wraps on a phone. */
const VISITS: InsideVisit[] = [
  inside(1, 'Aisha Rahman', 'Gulf Freight', '+962 79 555 0101'),
  inside(2, 'Grace Lee', null, '+962 79 555 0102'),
  inside(3, 'Tom Ng', null, '+962 79 555 0103'),
  inside(4, 'Mohammad Abdel-Rahman Al-Khatib', null, '+962 79 555 0104'),
  inside(5, 'Lina Odeh', 'Cedar Advisory', null),
  inside(6, 'Sami Aziz', null, null),
]

async function openList(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    if (path === '/auth/me') return route.fulfill({ json: ME })
    if (path === '/reception/inside') return route.fulfill({ json: { count: VISITS.length, items: VISITS } satisfies InsideList })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
  await page.goto('/inside')
  await expect(page.getByRole('link', { name: 'Call Grace Lee: +962 79 555 0102' })).toBeVisible()
}

test('a visitor’s phone never covers the name, the link to the visit, at any width', async ({ page }, testInfo) => {
  const widths = WIDTHS[testInfo.project.name]
  test.skip(!widths, 'Runs in the desktop, tablet and phone projects')
  await openList(page)
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  expect(touch, 'touch screen').toBe(testInfo.project.name !== 'desktop')

  for (const width of widths!) {
    await test.step(`${width} px`, async () => {
      await page.setViewportSize({ width, height: 900 })
      const cards = await page.evaluate(() => matchMedia('(width < 64rem)').matches)
      const rows = await measureVisitorTargets(page)
      expect(rows.map((row) => row.name).toSorted()).toEqual(VISITS.map((visit) => visit.visitor.full_name).toSorted())
      expectSeparateVisitorTargets(rows, { touch })

      const withPhone = rows.filter((row) => row.phone !== null)
      if (touch) {
        // The name and company keep the phone's 12 px reach clear, so its touch area starts below
        // them, and every row with a phone puts it at the same place: a missing company line does
        // not move it up into the name.
        for (const row of withPhone) {
          expect(row.linesHeight, `${row.name}: height of the name and company`).toBeGreaterThanOrEqual(44)
          expect(row.phone!.gapBelowLines, `${row.name}: space above the phone line`).toBeGreaterThanOrEqual(12)
        }
        const oneLine = withPhone.filter((row) => row.nameLines === 1)
        expect(oneLine.some((row) => row.hasCompany) && oneLine.some((row) => !row.hasCompany), 'rows with and without a company').toBe(true)
        expect(new Set(oneLine.map((row) => Math.round(row.phone!.offsetFromName))).size, 'phone lines at the same place in every row').toBe(1)
        if (width === 320) expect(rows.find((row) => row.name.startsWith('Mohammad'))?.nameLines, 'the long name wraps').toBeGreaterThan(1)
      } else {
        // With a mouse the table is unchanged: the phone line right under the name or company.
        expect(cards, 'table layout').toBe(false)
        for (const row of withPhone) {
          expect(row.phone!.gapBelowLines, `${row.name}: space above the phone line`).toBeLessThanOrEqual(2)
          expect(row.phone!.height, `${row.name}: height of the phone link`).toBeLessThan(44)
        }
      }
    })
  }
})
