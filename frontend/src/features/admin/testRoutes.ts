import { jsonResponse, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import type { AdminDashboard, AuditLog, CompanySettings, User } from '../../types/api'

/** Fixtures and API routes for the administration screens (tests only). */

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '7f0d1c0e-1111-4a5b-9c1d-000000000077',
    full_name: 'Omar Khalil',
    email: 'omar.khalil@acme.example',
    phone: '+962 79 000 0077',
    roles: ['EMPLOYEE'],
    department: { id: '7f0d1c0e-2222-4a5b-9c1d-000000000099', name: 'Legal', name_ar: null },
    is_active: true,
    must_change_password: false,
    last_login_at: '2026-10-05T06:00:00Z',
    created_at: '2026-01-01T08:00:00Z',
    updated_at: '2026-01-01T08:00:00Z',
    ...overrides,
  }
}

export function makeAuditLog(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    seq: 1042,
    created_at: '2026-10-05T06:31:05Z',
    action: 'USER_UPDATED',
    actor: { id: '7f0d1c0e-1111-4a5b-9c1d-000000000001', full_name: 'Lina Haddad' },
    entity_type: 'user',
    entity_id: '7f0d1c0e-1111-4a5b-9c1d-000000000077',
    metadata: { changed_fields: ['full_name', 'phone'] },
    ip_address: '203.0.113.10',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    request_id: 'req-7c1e',
    ...overrides,
  }
}

export function makeAdminDashboard(overrides: Partial<AdminDashboard> = {}): AdminDashboard {
  return {
    counts: { visitors_total: 0, visits_total: 0, inside_now: 0, visits_today: 0, employees: 0, receptionists: 0, management: 0, admins: 1 },
    recent_audit: [],
    ...overrides,
  }
}

export function makeCompanySettings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    id: '7f0d1c0e-3333-4a5b-9c1d-000000000003',
    name: 'Acme Holdings',
    name_ar: null,
    default_language: 'en',
    timezone: 'Asia/Amman',
    address: null,
    address_ar: null,
    email_domain: 'acme.example',
    pass_grace_before_minutes: 60,
    pass_grace_after_minutes: 60,
    notify_host_on_check_in: true,
    allow_walk_ins: true,
    ...overrides,
  }
}

/**
 * API routes /admin needs, for tests that land on it (route guards, navigation): the dashboard and
 * the company settings its settings card shows. Spread into `mockApi({...})`.
 */
export function adminDashboardRoutes(dashboard: AdminDashboard = makeAdminDashboard(), settings: CompanySettings = makeCompanySettings()): Record<string, RouteHandler> {
  return { 'GET /dashboard/admin': () => jsonResponse(dashboard), 'GET /company/settings': () => jsonResponse(settings) }
}

/** API routes /admin/audit needs, with the given events. */
export function auditLogRoutes(logs: AuditLog[] = []): Record<string, RouteHandler> {
  return { 'GET /audit-logs': () => jsonResponse(page(logs, { page_size: 50 })) }
}
