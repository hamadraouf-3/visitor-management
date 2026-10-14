import type { Department, EmployeeDashboard, Host, InsideVisit, Paginated, Visit, Visitor, VisitorSearchItem } from '../types/api'
import { jsonResponse, makeMe, type RouteHandler } from './api'

/** API response fixtures for the employee screens. Times are UTC; the test company is in Asia/Amman (UTC+3). */

const me = makeMe(['EMPLOYEE'])

export const ME_ID = me.user.id
export const FINANCE: Department = {
  id: me.user.department!.id,
  name: me.user.department!.name,
  name_ar: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}
export const LEGAL: Department = { ...FINANCE, id: '7f0d1c0e-2222-4a5b-9c1d-000000000099', name: 'Legal' }

export const VISIT_ID = '5a1b2c3d-0000-4000-8000-000000000001'
export const VISITOR_ID = '5a1b2c3d-0000-4000-8000-0000000000a1'

export function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: '7f0d1c0e-1111-4a5b-9c1d-000000000077',
    full_name: 'Omar Khalil',
    phone: '+962 79 000 0077',
    department: { id: LEGAL.id, name: LEGAL.name, name_ar: null },
    ...overrides,
  }
}

type VisitOverrides = Omit<Partial<Visit>, 'invitation' | 'pass' | 'permissions'> & {
  invitation?: Partial<Visit['invitation']>
  pass?: Partial<Visit['pass']>
  permissions?: Partial<Visit['permissions']>
}

/** A SCHEDULED visit on Tue 6 Oct 2026, 09:00–10:00 Amman, invitation SENT, owner permissions. */
export function makeVisit({ invitation, pass, permissions, ...overrides }: VisitOverrides = {}): Visit {
  return {
    id: VISIT_ID,
    status: 'SCHEDULED',
    visitor: { id: VISITOR_ID, full_name: 'Élodie Martin', company_name: 'Orbit Labs' },
    host: { id: ME_ID, full_name: 'Lina Haddad', phone: '+962 79 000 0001' },
    department: { id: FINANCE.id, name: FINANCE.name, name_ar: null },
    purpose: 'Quarterly review',
    scheduled_start: '2026-10-06T06:00:00Z',
    scheduled_end: '2026-10-06T07:00:00Z',
    window_start: '2026-10-06T05:00:00Z',
    window_end: '2026-10-06T08:00:00Z',
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
    created_by: { id: ME_ID, full_name: 'Lina Haddad' },
    created_at: '2026-10-05T06:10:00Z',
    updated_at: '2026-10-05T06:10:00Z',
    invitation: {
      status: 'SENT',
      to_email: 'elodie@orbit.example',
      attempts: 1,
      last_attempt_at: '2026-10-05T06:10:02Z',
      sent_at: '2026-10-05T06:10:02Z',
      error: null,
      ...invitation,
    },
    last_notice: null,
    pass: { status: 'ACTIVE', issued_at: '2026-10-05T06:10:00Z', revoke_reason: null, ...pass },
    permissions: { can_edit: true, can_cancel: true, can_resend: true, can_check_in: false, can_check_out: false, ...permissions },
    ...overrides,
  }
}

/** A visit as the evacuation list (`GET /reception/inside`) carries it: the visitor with their current phone (B57-72). */
export function makeInsideVisit(visit: Visit, phone: string | null = null): InsideVisit {
  return { ...visit, visitor: { ...visit.visitor, phone } }
}

export function makeVisitor(overrides: Partial<Visitor> = {}): Visitor {
  return {
    id: VISITOR_ID,
    full_name: 'Élodie Martin',
    email: 'elodie@orbit.example',
    phone: '+962 79 555 0100',
    company_name: 'Orbit Labs',
    created_at: '2026-09-01T08:00:00Z',
    updated_at: '2026-09-01T08:00:00Z',
    stats: { total_visits: 3, last_visit_at: '2026-09-20T07:00:00Z' },
    permissions: { can_edit: true },
    ...overrides,
  }
}

export function makeSearchItem(overrides: Partial<VisitorSearchItem> = {}): VisitorSearchItem {
  return { ...makeVisitor(), today_visits: [], ...overrides }
}

export function makeDashboard(counts: Partial<EmployeeDashboard['counts']> = {}): EmployeeDashboard {
  return {
    counts: { today: 2, upcoming: 5, inside: 1, completed_30d: 12, cancelled_30d: 2, needs_attention: 1, ...counts },
    today: [],
  }
}

export function page<T>(items: T[], { page: pageNumber = 1, page_size = 25, total = items.length } = {}): Paginated<T> {
  return { items, page: pageNumber, page_size, total }
}

/** Routes the My visits page needs, with empty results (for tests that only land on it). */
export function myVisitsRoutes(): Record<string, RouteHandler> {
  return {
    'GET /dashboard/employee': () => jsonResponse(makeDashboard()),
    'GET /visits': () => jsonResponse(page<Visit>([])),
  }
}

/** Routes the Visitors page needs, with empty results. */
export function visitorsRoutes(): Record<string, RouteHandler> {
  return { 'GET /visitors': () => jsonResponse(page<VisitorSearchItem>([])) }
}
