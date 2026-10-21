import { i18n } from '../i18n'
import { lazyTexts } from '../i18n/lazyTexts'
import { paths } from '../paths'
import type { Role } from '../types/api'

export const ALL_ROLES = ['SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST', 'MANAGEMENT'] as const satisfies readonly Role[]

/*
 * A role has two names, each read from the catalog in the UI language when it is used. Arabic says
 * them differently: beside one person a job title in the singular («عمر خليل · موظف»), for the people
 * who hold it a team in the plural («الموظفون»). English says both the same way ("Employee").
 */

/**
 * A role beside one person (`common:roles.person`): the shell's user block and account menu, the
 * users list's role chips, the user dialogs' role choices, and an account's roles in the audit log.
 */
export const PERSON_ROLE_LABELS: Record<Role, string> = lazyTexts({
  SYSTEM_ADMIN: () => i18n.t('roles.person.SYSTEM_ADMIN'),
  EMPLOYEE: () => i18n.t('roles.person.EMPLOYEE'),
  RECEPTIONIST: () => i18n.t('roles.person.RECEPTIONIST'),
  MANAGEMENT: () => i18n.t('roles.person.MANAGEMENT'),
})

/**
 * A role as the group of people who hold it (`common:roles.group`), where people are picked out by
 * it: the users list's role filter, beside "All roles". (The admin dashboard counts each group under
 * words of its own, `admin:dashboard.accounts`.)
 */
export const GROUP_ROLE_LABELS: Record<Role, string> = lazyTexts({
  SYSTEM_ADMIN: () => i18n.t('roles.group.SYSTEM_ADMIN'),
  EMPLOYEE: () => i18n.t('roles.group.EMPLOYEE'),
  RECEPTIONIST: () => i18n.t('roles.group.RECEPTIONIST'),
  MANAGEMENT: () => i18n.t('roles.group.MANAGEMENT'),
})

/** Roles may be combined; a capability is granted when any role grants it (D-04). */
export function hasRole(roles: readonly Role[], role: Role): boolean {
  return roles.includes(role)
}

export function hasAnyRole(roles: readonly Role[], allowed: readonly Role[]): boolean {
  return allowed.some((role) => roles.includes(role))
}

/**
 * Which roles may open each section (§7.5 matrix, §10 routes). The UI uses this for route
 * guards and navigation only; the backend enforces every permission.
 */
export const SECTION_ACCESS = {
  myVisits: ['EMPLOYEE', 'SYSTEM_ADMIN'],
  inviteVisitor: ['EMPLOYEE', 'SYSTEM_ADMIN'],
  visitDetail: ALL_ROLES,
  reception: ['RECEPTIONIST', 'SYSTEM_ADMIN'],
  visitors: ALL_ROLES,
  history: ['SYSTEM_ADMIN', 'MANAGEMENT', 'RECEPTIONIST'],
  inside: ['SYSTEM_ADMIN', 'MANAGEMENT', 'RECEPTIONIST'],
  /** The Visitor Journey (Phase 15): hosts (EMPLOYEE only) get no tab, and the API answers them 403 (least privilege). */
  journey: ['SYSTEM_ADMIN', 'MANAGEMENT', 'RECEPTIONIST'],
  reports: ['MANAGEMENT', 'SYSTEM_ADMIN'],
  admin: ['SYSTEM_ADMIN'],
} as const satisfies Record<string, readonly Role[]>

/**
 * Roles that may start and stop a visit's tracking (Phase 15): reception and administrators. Management
 * reads the journey only. Cosmetic like every role rule here: the backend enforces it.
 */
export const TRACKING_ACTION_ROLES = ['RECEPTIONIST', 'SYSTEM_ADMIN'] as const satisfies readonly Role[]

/**
 * Roles that read every visitor and full visit histories (§7.5). Holders of only EMPLOYEE see
 * visitors they created or invited, and histories limited to visits they own.
 */
export const COMPANY_WIDE_VISITOR_ROLES = ['SYSTEM_ADMIN', 'RECEPTIONIST', 'MANAGEMENT'] as const satisfies readonly Role[]

/** True when the server limits this user's visitor search and histories to their own visits. */
export function hasScopedVisitorAccess(roles: readonly Role[]): boolean {
  return !hasAnyRole(roles, COMPANY_WIDE_VISITOR_ROLES)
}

/** Landing page by role priority (§10): reception, then admin, employee, management. */
const LANDING_BY_PRIORITY: readonly [Role, string][] = [
  ['RECEPTIONIST', paths.reception],
  ['SYSTEM_ADMIN', paths.adminDashboard],
  ['EMPLOYEE', paths.myVisits],
  ['MANAGEMENT', paths.reports],
]

/** Every user has at least one role (DB constraint); the fallback is open to all roles. */
const FALLBACK_LANDING = paths.visitors

export function landingPath(roles: readonly Role[]): string {
  return LANDING_BY_PRIORITY.find(([role]) => roles.includes(role))?.[1] ?? FALLBACK_LANDING
}
