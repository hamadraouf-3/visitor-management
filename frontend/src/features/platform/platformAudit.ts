import type { PlatformAuditLog } from '../../types/api'

/**
 * The actions the platform's own trail records (B11-4, docs/api.md §10.11), in the order the platform
 * audit page's filter offers them. Their words are the company audit log's (`admin:audit.actions`).
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'COMPANY_CREATED',
  'COMPANY_SETTINGS_UPDATED',
  'COMPANY_DEACTIVATED',
  'COMPANY_REACTIVATED',
  // A company's logo or colour, set or removed (Phase 12).
  'COMPANY_BRAND_UPDATED',
  'USER_CREATED',
  // An address that cannot be used, when a company or an administrator is created (B11-42).
  'USER_CHANGE_REFUSED',
  'AUTH_PASSWORD_RESET_REQUESTED',
  'AUTH_LOGIN_SUCCEEDED',
  'AUTH_LOGIN_FAILED',
  'AUTH_ACCOUNT_THROTTLED',
  'AUTH_LOGOUT',
  'AUTH_PASSWORD_CHANGED',
  'AUTH_PASSWORD_CHANGE_FAILED',
  // A platform request after its session had ended (`reason: session_ended`).
  'ACCESS_DENIED',
  'CSRF_FAILED',
  'RATE_LIMITED',
  'PLATFORM_ADMIN_CREATED',
  'PLATFORM_ADMIN_PASSWORD_SET',
] as const

/**
 * The companies whose events in `logs` concern a user (an administrator created, a reset link
 * sent), each once and in a stable order: the companies whose administrators' names the page asks for.
 */
export function companiesOfUserEvents(logs: readonly PlatformAuditLog[]): string[] {
  const ids = new Set<string>()
  for (const log of logs) if (log.entity_type === 'user' && log.entity_id && log.company) ids.add(log.company.id)
  return [...ids].toSorted()
}
