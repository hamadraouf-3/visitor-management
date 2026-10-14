import { ALL_ROLES, PERSON_ROLE_LABELS } from '../../auth/roles'
import { i18n } from '../../i18n'
import type { Role, User, UserCreate, UserUpdate } from '../../types/api'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLength } from '../../utils/passwordPolicy'

/** Column limits of `users` (§4); the server enforces the same. */
export const USER_LIMITS = { fullName: 200, email: 320, phone: 40 } as const

const t = i18n.getFixedT(null, ['admin', 'auth'])

/** A role as the form offers it: its name beside a person (the account's), in the UI language when read. */
function roleOption(role: Role): { role: Role; label: string } {
  return {
    role,
    get label() {
      return PERSON_ROLE_LABELS[role]
    },
  }
}

/** Roles in the order the form offers them (§7.5). */
export const ROLE_OPTIONS: readonly { role: Role; label: string }[] = (['EMPLOYEE', 'RECEPTIONIST', 'MANAGEMENT', 'SYSTEM_ADMIN'] as const).map(roleOption)

/** Roles that make a user a host (§7.5 "Hosts = active users with EMPLOYEE or SYSTEM_ADMIN"). */
const HOST_ROLES: readonly Role[] = ['EMPLOYEE', 'SYSTEM_ADMIN']

export function isHostRoleSet(roles: readonly Role[]): boolean {
  return roles.some((role) => HOST_ROLES.includes(role))
}

/** Roles in the canonical order (the server stores them ordered too). */
export function orderedRoles(roles: readonly Role[]): Role[] {
  return ALL_ROLES.filter((role) => roles.includes(role))
}

// Deliberately permissive (accepts `.local` / `.test` domains, B1-22): the server validates addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function maxLength(max: number): string {
  return maxLengthMessage(max)
}

/* Create ------------------------------------------------------------------------------------ */

export interface UserCreateValues {
  fullName: string
  email: string
  phone: string
  roles: Role[]
  /** '' = no department. */
  departmentId: string
  temporaryPassword: string
}

export const EMPTY_USER_CREATE: UserCreateValues = { fullName: '', email: '', phone: '', roles: [], departmentId: '', temporaryPassword: '' }

/** The form's fields and the request paths the server reports them under (§8.2 `details.fields`). */
export const USER_CREATE_FIELDS = {
  fullName: 'full_name',
  email: 'email',
  phone: 'phone',
  roles: 'roles',
  departmentId: 'department_id',
  temporaryPassword: 'temporary_password',
} as const

function validateName(fullName: string): string | undefined {
  const value = fullName.trim()
  if (!value) return t('users.validation.fullNameRequired')
  if (value.length > USER_LIMITS.fullName) return maxLength(USER_LIMITS.fullName)
  return undefined
}

function validatePhone(phone: string): string | undefined {
  return phone.trim().length > USER_LIMITS.phone ? maxLength(USER_LIMITS.phone) : undefined
}

function validateRoles(roles: readonly Role[]): string | undefined {
  return roles.length === 0 ? t('users.validation.rolesRequired') : undefined
}

/** The temporary password against the policy the browser can check (§7.1); the server also rejects common passwords. */
export function validateTemporaryPassword(password: string, email: string): string | undefined {
  if (!password) return t('users.validation.temporaryPasswordRequired')
  const length = passwordLength(password)
  if (length < PASSWORD_MIN_LENGTH) return t('auth:password.tooShort', { min: PASSWORD_MIN_LENGTH })
  if (length > PASSWORD_MAX_LENGTH) return t('auth:password.tooLong', { max: PASSWORD_MAX_LENGTH })
  if (email.trim() && password.trim().toLowerCase() === email.trim().toLowerCase()) return t('users.validation.passwordIsEmail')
  return undefined
}

export function validateUserCreate(values: UserCreateValues): FormErrors<keyof UserCreateValues> {
  const errors: FormErrors<keyof UserCreateValues> = {}
  const email = values.email.trim()
  errors.fullName = validateName(values.fullName)
  if (!email) errors.email = t('users.validation.emailRequired')
  else if (email.length > USER_LIMITS.email) errors.email = maxLength(USER_LIMITS.email)
  else if (!EMAIL_PATTERN.test(email)) errors.email = t('auth:validation.emailInvalid', { example: 'name@company.com' })
  errors.phone = validatePhone(values.phone)
  errors.roles = validateRoles(values.roles)
  errors.temporaryPassword = validateTemporaryPassword(values.temporaryPassword, values.email)
  return errors
}

/** POST /users body: trimmed text; an empty phone and "no department" are left out. */
export function toUserCreate(values: UserCreateValues): UserCreate {
  const body: UserCreate = {
    full_name: values.fullName.trim(),
    email: values.email.trim().toLowerCase(),
    roles: orderedRoles(values.roles),
    temporary_password: values.temporaryPassword,
  }
  const phone = values.phone.trim()
  if (phone) body.phone = phone
  if (values.departmentId) body.department_id = values.departmentId
  return body
}

/* Edit -------------------------------------------------------------------------------------- */

export interface UserEditValues {
  fullName: string
  phone: string
  roles: Role[]
  departmentId: string
  isActive: boolean
}

export const USER_EDIT_FIELDS = {
  fullName: 'full_name',
  phone: 'phone',
  roles: 'roles',
  departmentId: 'department_id',
  isActive: 'is_active',
} as const

export function userEditValues(user: User): UserEditValues {
  return {
    fullName: user.full_name,
    phone: user.phone ?? '',
    roles: orderedRoles(user.roles),
    departmentId: user.department?.id ?? '',
    isActive: user.is_active,
  }
}

export function validateUserEdit(values: UserEditValues): FormErrors<keyof UserEditValues> {
  return { fullName: validateName(values.fullName), phone: validatePhone(values.phone), roles: validateRoles(values.roles) }
}

function sameRoles(a: readonly Role[], b: readonly Role[]): boolean {
  return a.length === b.length && a.every((role) => b.includes(role))
}

/**
 * PATCH /users/{id} body with only what changed, or null when nothing did. A cleared phone or
 * department is sent as `null` (the server clears it).
 */
export function toUserUpdate(user: User, values: UserEditValues): UserUpdate | null {
  const body: UserUpdate = {}
  const fullName = values.fullName.trim()
  if (fullName !== user.full_name) body.full_name = fullName
  const phone = values.phone.trim()
  if (phone !== (user.phone ?? '')) body.phone = phone || null
  if (values.departmentId !== (user.department?.id ?? '')) body.department_id = values.departmentId || null
  if (!sameRoles(values.roles, user.roles)) body.roles = orderedRoles(values.roles)
  if (values.isActive !== user.is_active) body.is_active = values.isActive
  return Object.keys(body).length > 0 ? body : null
}

/**
 * What the edit form must not offer for the signed-in administrator's own account (§7.5:
 * removing one's own administrator role or deactivating oneself is refused with
 * SELF_MODIFICATION). The UI never offers it in the first place.
 */
export interface SelfEditLocks {
  /** The administrator role cannot be removed. */
  adminRole: boolean
  /** The account cannot be deactivated. */
  active: boolean
}

export function selfEditLocks(user: Pick<User, 'id' | 'roles'>, currentUserId: string): SelfEditLocks {
  const self = user.id === currentUserId
  return { adminRole: self && user.roles.includes('SYSTEM_ADMIN'), active: self }
}

/**
 * Whether saving cancels the user's scheduled hosted visits (D-18): the account is deactivated,
 * or it loses its last host role.
 */
export function cancelsHostedVisits(user: Pick<User, 'roles' | 'is_active'>, values: Pick<UserEditValues, 'roles' | 'isActive'>): boolean {
  // Only a host has scheduled visits to lose: someone who was never one (reception, management)
  // has none, and a host who lost the role had theirs cancelled then. So no warning for them.
  if (!user.is_active || !isHostRoleSet(user.roles)) return false
  if (!values.isActive) return true
  return !isHostRoleSet(values.roles)
}

/** The confirmation after a save that cancelled hosted visits (`User.cancelled_visits`, D-18). */
export function cancelledVisitsMessage(fullName: string, count: number): string {
  return t('users.cancelledVisits', { count, name: fullName })
}
