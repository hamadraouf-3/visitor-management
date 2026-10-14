import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { UrlParamChanges } from '../../hooks/useUrlParams'
import type { PlatformCompanyListParams } from '../../types/api'

export const COMPANIES_PAGE_SIZE = 25

export const COMPANY_PARAM = { q: 'q', status: 'status', page: 'page' } as const

export const COMPANY_STATUS_FILTERS = ['all', 'active', 'inactive'] as const
export type CompanyStatusFilter = (typeof COMPANY_STATUS_FILTERS)[number]

const t = i18n.getFixedT(null, 'platform')

export const COMPANY_STATUS_FILTER_LABELS: Record<CompanyStatusFilter, string> = lazyTexts({
  all: () => t('companies.statusFilter.all'),
  active: () => t('companies.statusFilter.active'),
  inactive: () => t('companies.statusFilter.inactive'),
})

export interface CompanyFilters {
  q: string
  status: CompanyStatusFilter
}

/** The filters of the view (the search text from the history entry's state, `useUrlParams`); unknown values mean "every". */
export function readCompanyFilters(params: URLSearchParams): CompanyFilters {
  const status = params.get(COMPANY_PARAM.status)
  return {
    q: params.get(COMPANY_PARAM.q)?.trim() ?? '',
    status: status !== null && (COMPANY_STATUS_FILTERS as readonly string[]).includes(status) ? (status as CompanyStatusFilter) : 'all',
  }
}

/** A filter change goes back to the first page. */
export function companyFilterChanges(filters: Partial<CompanyFilters>): UrlParamChanges {
  const changes: UrlParamChanges = { [COMPANY_PARAM.page]: null }
  if ('q' in filters) changes[COMPANY_PARAM.q] = filters.q?.trim() || null
  if ('status' in filters) changes[COMPANY_PARAM.status] = filters.status === 'all' ? null : (filters.status ?? null)
  return changes
}

/** GET /platform/companies parameters: `q` matches the name, the Arabic name or the slug. */
export function companyListParams(filters: CompanyFilters, page: number): PlatformCompanyListParams {
  const params: PlatformCompanyListParams = { page, page_size: COMPANIES_PAGE_SIZE }
  if (filters.q) params.q = filters.q
  if (filters.status !== 'all') params.is_active = filters.status === 'active'
  return params
}

/**
 * The platform owner's time zone for dates and times: the device's (Phase 11, F11-7). The platform
 * owner belongs to no company, so there is no company time zone to follow.
 */
export function platformTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
