import { ALL_ROLES } from '../../auth/roles'
import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { UrlParamChanges } from '../../hooks/useUrlParams'
import type { Role, UserListParams } from '../../types/api'

export const USERS_PAGE_SIZE = 25

export const USER_PARAM = { q: 'q', role: 'role', status: 'status', page: 'page' } as const

export const USER_STATUS_FILTERS = ['all', 'active', 'inactive'] as const
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number]

const t = i18n.getFixedT(null, 'admin')

export const USER_STATUS_FILTER_LABELS: Record<UserStatusFilter, string> = lazyTexts({
  all: () => t('users.statusFilter.all'),
  active: () => t('users.statusFilter.active'),
  inactive: () => t('users.statusFilter.inactive'),
})

export interface UserFilters {
  q: string
  role: Role | null
  status: UserStatusFilter
}

/** The filters in the URL; unknown values fall back to "every". */
export function readUserFilters(params: URLSearchParams): UserFilters {
  const role = params.get(USER_PARAM.role)
  const status = params.get(USER_PARAM.status)
  return {
    q: params.get(USER_PARAM.q)?.trim() ?? '',
    role: role !== null && (ALL_ROLES as readonly string[]).includes(role) ? (role as Role) : null,
    status: status !== null && (USER_STATUS_FILTERS as readonly string[]).includes(status) ? (status as UserStatusFilter) : 'all',
  }
}

export function userFilterChanges(filters: Partial<UserFilters>): UrlParamChanges {
  const changes: UrlParamChanges = { [USER_PARAM.page]: null }
  if ('q' in filters) changes[USER_PARAM.q] = filters.q?.trim() || null
  if ('role' in filters) changes[USER_PARAM.role] = filters.role ?? null
  if ('status' in filters) changes[USER_PARAM.status] = filters.status === 'all' ? null : (filters.status ?? null)
  return changes
}

/** GET /users parameters (§8): `q` matches name or email; `role` keeps holders of that role. */
export function userListParams(filters: UserFilters, page: number): UserListParams {
  const params: UserListParams = { page, page_size: USERS_PAGE_SIZE }
  if (filters.q) params.q = filters.q
  if (filters.role) params.role = [filters.role]
  if (filters.status !== 'all') params.is_active = filters.status === 'active'
  return params
}
