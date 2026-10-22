import { i18n } from '../../i18n'
import { catalogText } from '../../i18n/catalogText'
import { lazyTexts } from '../../i18n/lazyTexts'
import { paths } from '../../paths'
import type { AuditLog } from '../../types/api'

const t = i18n.getFixedT(null, 'admin')

/**
 * The audit actions the backend records (`AuditAction` in backend/app/services/audit.py; a test
 * keeps the two in step), grouped as the action filter offers them. Their words are in the
 * `admin` catalog (`audit.actions.<CODE>`, `audit.groups.<key>`), read when read, so the filter
 * and the list follow the UI language. An action missing here (a newer backend) still reads
 * sensibly through `humanizeAuditCode`.
 */
const ACTION_GROUP_CODES = [
  {
    key: 'auth',
    actions: [
      'AUTH_LOGIN_SUCCEEDED',
      'AUTH_LOGIN_FAILED',
      'AUTH_ACCOUNT_THROTTLED',
      'AUTH_LOGOUT',
      'AUTH_PASSWORD_CHANGED',
      'AUTH_PASSWORD_CHANGE_FAILED',
      'AUTH_PASSWORD_RESET_REQUESTED',
      'AUTH_PASSWORD_RESET_COMPLETED',
      'AUTH_PASSWORD_RESET_FAILED',
    ],
  },
  { key: 'security', actions: ['ACCESS_DENIED', 'CSRF_FAILED', 'RATE_LIMITED'] },
  {
    key: 'administration',
    actions: [
      'USER_CREATED',
      'USER_UPDATED',
      'USER_ROLES_CHANGED',
      'USER_DEACTIVATED',
      'USER_REACTIVATED',
      'USER_CHANGE_REFUSED',
      'DEPARTMENT_CREATED',
      'DEPARTMENT_UPDATED',
      'COMPANY_CREATED',
      'COMPANY_SETTINGS_UPDATED',
      'COMPANY_DEACTIVATED',
      'COMPANY_REACTIVATED',
      // A company's logo or colour, set or removed by the platform owner (Phase 12).
      'COMPANY_BRAND_UPDATED',
    ],
  },
  { key: 'emailTexts', actions: ['EMAIL_TEMPLATE_UPDATED', 'EMAIL_TEMPLATE_RESET', 'EMAIL_TEMPLATE_TEST_SENT'] },
  {
    key: 'visits',
    actions: [
      'VISITOR_CREATED',
      'VISITOR_UPDATED',
      'VISITOR_LINK_REFUSED',
      'VISIT_CREATED',
      'VISIT_UPDATED',
      'VISIT_RESCHEDULED',
      'VISIT_CANCELLED',
      'VISIT_MARKED_NO_SHOW',
      'VISIT_TIME_SHIFTED',
    ],
  },
  {
    key: 'reception',
    actions: [
      'VISIT_CHECKED_IN',
      'VISIT_CHECK_IN_REFUSED',
      'VISIT_CHECKED_OUT',
      'VISIT_CHECK_OUT_REFUSED',
      'STALE_VISITS_CHECKED_OUT',
      'WALK_IN_CREATED',
      'WALK_IN_REFUSED',
    ],
  },
  { key: 'passes', actions: ['PASS_ISSUED', 'PASS_REVOKED', 'PASS_SCANNED', 'INVITATION_QUEUED', 'INVITATION_SENT', 'INVITATION_FAILED'] },
  // Phase 15: visitor tracking (a visit's tracking, the switches and settings, keys, cameras, places, a journey opened).
  {
    key: 'tracking',
    actions: [
      'TRACKING_ENROLLMENT_REQUESTED',
      'TRACKING_ASSOCIATION_ACTIVATED',
      'TRACKING_ASSOCIATION_ENDED',
      'TRACKING_ASSOCIATION_REVOKED',
      'JOURNEY_VIEWED',
      'JOURNEY_LIST_VIEWED',
      'TRACKING_ENABLED',
      'TRACKING_DISABLED',
      'TRACKING_ALLOWED',
      'TRACKING_DISALLOWED',
      'TRACKING_SETTINGS_UPDATED',
      'TRACKING_KEY_CREATED',
      'TRACKING_KEY_REVOKED',
      'TRACKING_CAMERA_CREATED',
      'TRACKING_CAMERA_UPDATED',
      'LOCATION_CREATED',
      'LOCATION_UPDATED',
      // Phase 16: a visit's allowed areas, and the area alerts (opened and escalated by the system, acknowledged and resolved by staff or the system).
      'VISIT_ACCESS_AREAS_CHANGED',
      'TRACKING_ALERT_OPENED',
      'TRACKING_ALERT_ESCALATED',
      'TRACKING_ALERT_ACKNOWLEDGED',
      'TRACKING_ALERT_RESOLVED',
    ],
  },
] as const satisfies readonly { key: string; actions: readonly string[] }[]

type ActionGroupKey = (typeof ACTION_GROUP_CODES)[number]['key']

function groupLabel(key: ActionGroupKey): string {
  return t(`audit.groups.${key}`)
}

/**
 * Actions only the platform's own trail records (Phase 11: the CLI created or reset a platform
 * account). They have words (the platform owner's audit page reads them) but are not offered in a
 * company's action filter, where they never appear.
 */
export const PLATFORM_ACCOUNT_ACTIONS: readonly string[] = ['PLATFORM_ADMIN_CREATED', 'PLATFORM_ADMIN_PASSWORD_SET']

/** Every action with a label: the filter's, in filter order, then the platform accounts'. */
export const KNOWN_AUDIT_ACTIONS: readonly string[] = [...ACTION_GROUP_CODES.flatMap((group) => group.actions), ...PLATFORM_ACCOUNT_ACTIONS]

/** The action filter's groups: a label and each action's label, in the UI language when read. */
export const AUDIT_ACTION_GROUPS: readonly { readonly label: string; readonly actions: Readonly<Record<string, string>> }[] = ACTION_GROUP_CODES.map(
  (group) => ({
    get label() {
      return groupLabel(group.key)
    },
    actions: lazyTexts(Object.fromEntries(group.actions.map((action) => [action, () => auditActionLabel(action)]))),
  }),
)

/** "VISIT_CHECKED_IN" → "Visit checked in" (for codes without a label). */
export function humanizeAuditCode(code: string): string {
  const words = code.toLowerCase().split(/[_\s]+/).filter(Boolean).join(' ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code
}

/**
 * Whether the platform owner did this to the company (Phase 11, B11-5): the company's trail records
 * it without an actor, with `metadata.source = "platform"` (and the platform account's opaque ID).
 */
export function isPlatformSourced(log: Pick<AuditLog, 'actor' | 'metadata'>): boolean {
  return log.actor === null && log.metadata.source === 'platform'
}

export function auditActionLabel(action: string): string {
  return catalogText('admin', `audit.actions.${action}`) ?? humanizeAuditCode(action)
}

/**
 * Failures and denials (§7.4 security events): shown with a warning mark so they stand out in
 * a list of routine events.
 */
const FAILURE_ACTIONS = new Set([
  'AUTH_LOGIN_FAILED',
  'AUTH_ACCOUNT_THROTTLED',
  'AUTH_PASSWORD_CHANGE_FAILED',
  'AUTH_PASSWORD_RESET_FAILED',
  'ACCESS_DENIED',
  'CSRF_FAILED',
  'RATE_LIMITED',
  'INVITATION_FAILED',
  'USER_CHANGE_REFUSED',
  'VISITOR_LINK_REFUSED',
  'VISIT_CHECK_IN_REFUSED',
  'VISIT_CHECK_OUT_REFUSED',
  'WALK_IN_REFUSED',
])

/** Scan outcomes that are not a usable pass (§6 rows 1–3, 5–8). */
const SUCCESSFUL_SCAN_OUTCOMES = new Set(['READY', 'ALREADY_CHECKED_IN'])

export function isFailureEvent(log: Pick<AuditLog, 'action' | 'metadata'>): boolean {
  if (FAILURE_ACTIONS.has(log.action)) return true
  if (log.action === 'PASS_SCANNED') {
    const outcome = log.metadata.outcome
    return typeof outcome === 'string' && !SUCCESSFUL_SCAN_OUTCOMES.has(outcome)
  }
  return false
}

/** Entity types the backend records (`AuditEntity`), as the filter offers them; words when read. */
export const AUDIT_ENTITY_LABELS: Readonly<Record<string, string>> = lazyTexts({
  visit: () => t('audit.entities.visit'),
  visitor: () => t('audit.entities.visitor'),
  user: () => t('audit.entities.user'),
  department: () => t('audit.entities.department'),
  company: () => t('audit.entities.company'),
  pass: () => t('audit.entities.pass'),
  email: () => t('audit.entities.email'),
  session: () => t('audit.entities.session'),
  email_template: () => t('audit.entities.email_template'),
  platform_admin: () => t('audit.entities.platform_admin'),
  // Phase 15: the places and the tracking's cameras and keys.
  building: () => t('audit.entities.building'),
  floor: () => t('audit.entities.floor'),
  zone: () => t('audit.entities.zone'),
  tracking_camera: () => t('audit.entities.tracking_camera'),
  tracking_key: () => t('audit.entities.tracking_key'),
})

/**
 * Record types only the platform's own trail holds (a platform account): they have words, since the
 * platform owner's audit page reads them, but a company's record-type filter does not offer them:
 * none of a company's rows can match (UX review L17).
 */
export const PLATFORM_ENTITY_TYPES: readonly string[] = ['platform_admin']

/** The record types a company's audit log can hold, as its filter offers them. */
export function companyAuditEntityTypes(): [string, string][] {
  return Object.entries(AUDIT_ENTITY_LABELS).filter(([entityType]) => !PLATFORM_ENTITY_TYPES.includes(entityType))
}

export function auditEntityLabel(entityType: string): string {
  return AUDIT_ENTITY_LABELS[entityType] ?? humanizeAuditCode(entityType)
}

/**
 * Where an audit event's entity can be seen: its own page for visits and visitors, otherwise
 * the audit log narrowed to that entity (users, departments, … have no page of their own).
 */
export function auditEntityLink(log: Pick<AuditLog, 'entity_type' | 'entity_id'>): string | null {
  if (!log.entity_type || !log.entity_id) return null
  switch (log.entity_type) {
    case 'visit':
      return paths.visit(log.entity_id)
    case 'visitor':
      return paths.visitor(log.entity_id)
    default: {
      const query = new URLSearchParams({ entity_type: log.entity_type, entity_id: log.entity_id })
      return `${paths.adminAudit}?${query.toString()}`
    }
  }
}

/**
 * What an event concerns, in words, for its summary line: the entity type, or "Own account"
 * when a user acted on their own account (a sign-in, a password change), where naming the
 * user again would only repeat the actor. IDs are left to the event's details.
 */
export function auditEntityDescription(log: Pick<AuditLog, 'entity_type' | 'entity_id' | 'actor'>): string | null {
  if (!log.entity_type) return null
  if (log.entity_type === 'user' && log.actor && log.entity_id === log.actor.id) return t('audit.ownAccount')
  return auditEntityLabel(log.entity_type)
}

/** The text of the link `auditEntityLink` returns. */
export function auditEntityLinkText(entityType: string): string {
  switch (entityType) {
    case 'visit':
      return t('audit.openVisit')
    case 'visitor':
      return t('audit.openVisitor')
    default:
      return catalogText('admin', `audit.eventsFor.${entityType}`) ?? t('audit.eventsForRecord', { entity: auditEntityLabel(entityType).toLowerCase() })
  }
}

const ERROR_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

/**
 * An API error code the server records as a value (a refused check-in's `code`) that the audit
 * vocabulary has no short words for: the error's own message, without its full stop, so a newer
 * server's code still reads in the UI language instead of in English words. Null for other codes.
 */
function errorCodeLabel(code: string): string | null {
  if (!ERROR_CODE.test(code)) return null
  return catalogText('errors', `codes.${code}`)?.replace(/\.$/, '') ?? null
}

/**
 * A code the server records as a value (a scan's outcome, why a sign-in failed, an error code,
 * a rate-limit policy, a changed field, where a record came from) in the UI language: the
 * catalog's words for the codes it knows (`audit.values.<code>`: "name_ar" → "Arabic name"), an
 * error code's message (`errors:codes.<code>`), or null. `auditVocabulary.test.ts` checks that every
 * value the backend writes has words in both languages.
 */
export function auditCodeText(code: string): string | null {
  return catalogText('admin', `audit.values.${code}`) ?? errorCodeLabel(code)
}
