import { jsonResponse, makeMe, type RouteHandler } from '../../../test/api'
import { makeInsideVisit, makeVisit, VISIT_ID } from '../../../test/fixtures'
import type { CompanySettings, InsideList, ReceptionToday, ScanResult, Visit } from '../../../types/api'

/**
 * Fixtures for the reception tests. The company is in Asia/Amman (UTC+3); "now" is Tue 6 Oct
 * 2026, 09:10 Amman, inside the pass window (08:00–11:00) of the default visit (09:00–10:00).
 */

export const RECEPTION_NOW = new Date('2026-10-06T06:10:00Z')

/** secrets.token_urlsafe(32): 43 URL-safe characters. */
export const PASS_TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'
export const PASS_URL = `https://visitors.example.com/pass#${PASS_TOKEN}`
export const OTHER_PASS_TOKEN = 'Yp4_wL0-bR3sU8nO5cM9dZ2aX7fI6kQ1tE-hG_vJl3B'

export const RECEPTIONIST = makeMe(['RECEPTIONIST'], {
  id: '7f0d1c0e-1111-4a5b-9c1d-0000000000f1',
  full_name: 'Rana Saleh',
  department: null,
})

type VisitOverrides = Parameters<typeof makeVisit>[0]

/** A visit as reception sees it: may be checked in, not edited. */
export function receptionVisit(overrides: VisitOverrides = {}): Visit {
  return makeVisit({
    host: { id: '7f0d1c0e-1111-4a5b-9c1d-000000000077', full_name: 'Omar Khalil', phone: '+962 79 000 0077' },
    ...overrides,
    permissions: { can_edit: false, can_cancel: false, can_resend: false, can_check_in: true, can_check_out: false, ...overrides.permissions },
  })
}

/** The same visit after its check-in at 09:02 Amman. */
export function insideVisit(overrides: VisitOverrides = {}): Visit {
  return receptionVisit({
    status: 'CHECKED_IN',
    check_in_at: '2026-10-06T06:02:00Z',
    check_in_method: 'QR',
    checked_in_by: { id: RECEPTIONIST.user.id, full_name: RECEPTIONIST.user.full_name },
    ...overrides,
    permissions: { can_check_in: false, can_check_out: true, ...overrides.permissions },
  })
}

export function checkedOutVisit(overrides: VisitOverrides = {}): Visit {
  return insideVisit({
    status: 'CHECKED_OUT',
    check_out_at: '2026-10-06T07:00:00Z',
    check_out_method: 'QR',
    checked_out_by: { id: RECEPTIONIST.user.id, full_name: RECEPTIONIST.user.full_name },
    duration_seconds: 3480,
    ...overrides,
    permissions: { can_check_in: false, can_check_out: false, ...overrides.permissions },
  })
}

export function readyScan(visit: Visit = receptionVisit(), warnings: ScanResult['warnings'] = []): ScanResult {
  return { result: 'READY', visit, warnings, actions: { check_in: true, check_out: false } }
}

export function insideScan(visit: Visit = insideVisit(), warnings: ScanResult['warnings'] = []): ScanResult {
  return { result: 'ALREADY_CHECKED_IN', visit, warnings, actions: { check_in: false, check_out: true } }
}

export function makeToday(lists: Partial<Pick<ReceptionToday, 'expected' | 'inside' | 'checked_out' | 'no_show'>> = {}, counts: Partial<ReceptionToday['counts']> = {}): ReceptionToday {
  const expected = lists.expected ?? []
  const inside = lists.inside ?? []
  const checkedOut = lists.checked_out ?? []
  const noShow = lists.no_show ?? []
  return {
    date: '2026-10-06',
    counts: {
      expected: expected.length,
      inside: inside.length,
      checked_out: checkedOut.length,
      no_show: noShow.length,
      cancelled: 0,
      walk_ins: 0,
      ...counts,
    },
    expected,
    inside,
    checked_out: checkedOut,
    no_show: noShow,
  }
}

export function makeInside(items: Visit[] = []): InsideList {
  return { count: items.length, items: items.map((visit) => makeInsideVisit(visit)) }
}

export function makeSettings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    id: RECEPTIONIST.company.id,
    name: RECEPTIONIST.company.name,
    name_ar: null,
    default_language: 'en',
    timezone: RECEPTIONIST.company.timezone,
    address: null,
    address_ar: null,
    email_domain: null,
    pass_grace_before_minutes: 60,
    pass_grace_after_minutes: 60,
    notify_host_on_check_in: true,
    allow_walk_ins: true,
    ...overrides,
  }
}

/**
 * Every request the reception screen makes when it opens on its default tab, with empty
 * answers. Tests that only land on /reception (e.g. after signing in as a receptionist) add
 * these to their mockApi routes.
 */
export function receptionRoutes(): Record<string, RouteHandler> {
  return { 'GET /reception/today': () => jsonResponse(makeToday()) }
}

export { VISIT_ID }
