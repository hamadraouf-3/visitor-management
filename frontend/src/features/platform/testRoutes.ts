import { EMPTY_BRAND } from '../../identity/brand'
import { jsonResponse, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import type { PlatformAuditLog, PlatformCompany, PlatformCompanyAdmin, PlatformMe } from '../../types/api'

/** Fixtures and API routes of the platform owner's area (tests only). */

export const PLATFORM_ADMIN_ID = '9a000000-0000-4000-8000-000000000001'

export function makePlatformMe(overrides: Partial<PlatformMe['admin']> = {}): PlatformMe {
  return {
    admin: { id: PLATFORM_ADMIN_ID, full_name: 'Platform Owner', email: 'platform@demo.local', must_change_password: false, preferred_language: null, ...overrides },
  }
}

export function makePlatformCompany(overrides: Partial<PlatformCompany> = {}): PlatformCompany {
  return {
    id: '9b000000-0000-4000-8000-000000000001',
    name: 'Nova Labs',
    name_ar: 'نوفا لابز',
    slug: 'nova-labs',
    timezone: 'Asia/Amman',
    default_language: 'en',
    is_active: true,
    deactivated_at: null,
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-01T08:00:00Z',
    counts: { active_users: 12, visits_last_30_days: 84 },
    brand: EMPTY_BRAND,
    tracking_allowed: false,
    ...overrides,
  }
}

export function makeCompanyAdmin(overrides: Partial<PlatformCompanyAdmin> = {}): PlatformCompanyAdmin {
  return {
    id: '9c000000-0000-4000-8000-000000000001',
    full_name: 'Nadia Haddad',
    email: 'nadia@nova.example',
    is_active: true,
    must_change_password: false,
    last_login_at: '2026-10-05T06:00:00Z',
    created_at: '2026-10-01T08:00:00Z',
    ...overrides,
  }
}

export function makePlatformAuditLog(overrides: Partial<PlatformAuditLog> = {}): PlatformAuditLog {
  return {
    id: '9d000000-0000-4000-8000-000000000001',
    seq: 7,
    created_at: '2026-10-05T06:31:05Z',
    action: 'COMPANY_DEACTIVATED',
    actor: { id: PLATFORM_ADMIN_ID, full_name: 'Platform Owner' },
    company: { id: '9b000000-0000-4000-8000-000000000001', name: 'Nova Labs', name_ar: 'نوفا لابز' },
    entity_type: 'company',
    entity_id: '9b000000-0000-4000-8000-000000000001',
    metadata: { revoked_sessions: 3, invalidated_reset_links: 0 },
    ip_address: '203.0.113.10',
    user_agent: 'Mozilla/5.0',
    request_id: 'req-9d',
    ...overrides,
  }
}

/** The platform session and its company list, for tests that land in the platform owner's area. */
export function platformRoutes({
  me = makePlatformMe(),
  companies = [makePlatformCompany()],
}: { me?: PlatformMe; companies?: PlatformCompany[] } = {}): Record<string, RouteHandler> {
  return {
    'GET /platform/auth/me': () => jsonResponse(me),
    'GET /platform/companies': () => jsonResponse(page(companies)),
  }
}
