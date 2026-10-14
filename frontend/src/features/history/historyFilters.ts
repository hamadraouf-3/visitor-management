import { readDateParam, readUuidParam, type UrlParamChanges } from '../../hooks/useUrlParams'
import type { VisitListParams, VisitStatus } from '../../types/api'
import { dateRangeError } from '../../utils/dateRange'
import { foldText } from '../../utils/text'

/** Visit statuses in the order the filter offers them (lifecycle order, §5). */
export const HISTORY_STATUSES: readonly VisitStatus[] = ['SCHEDULED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED']

export const HISTORY_PAGE_SIZE = 25

/**
 * The history searches from three characters (B57-65): a shorter query has no trigram for the
 * search indexes to look up, so the server would read every visit of the company for it.
 */
export const HISTORY_SEARCH_MIN_LENGTH = 3

/** Whether the search text is long enough to be sent (three characters once case and accents are folded). */
export function isHistorySearchable(q: string): boolean {
  return [...foldText(q.trim())].length >= HISTORY_SEARCH_MIN_LENGTH
}

/**
 * Parameter keys of the history page. `q` and `hostName` are private (`PRIVATE_PARAMS`): they
 * are kept in the history entry's state, never in the query string.
 */
export const HISTORY_PARAM = {
  from: 'from',
  to: 'to',
  status: 'status',
  host: 'host',
  /**
   * The selected host's name: only a hint to look the host up by (GET /users/hosts has no
   * lookup by ID). The filter shows a name only when the server returns that ID with it. A
   * bookmarked or shared view has no hint (it is private), so its filter says "Selected host".
   */
  hostName: 'hostName',
  department: 'department',
  q: 'q',
  page: 'page',
} as const

/** The filters of the company-wide visit history, as read from the URL. */
export interface HistoryFilters {
  /** Company-local `YYYY-MM-DD` (scheduled date), or null for no bound. */
  from: string | null
  to: string | null
  /** Empty = every status. */
  statuses: VisitStatus[]
  /** The host's ID, and the name the URL suggests for looking it up (never shown unverified). */
  host: { id: string; nameHint: string | null } | null
  departmentId: string | null
  /** Visitor, company or host name (server-side text search). */
  q: string
}

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  from: null,
  to: null,
  statuses: [],
  host: null,
  departmentId: null,
  q: '',
}

/** Known statuses from a comma-separated value, deduplicated, in the filter's order. */
export function parseStatuses(raw: string | null): VisitStatus[] {
  if (!raw) return []
  const requested = new Set(raw.split(',').map((part) => part.trim().toUpperCase()))
  return HISTORY_STATUSES.filter((status) => requested.has(status))
}

/**
 * The filters in the URL. Malformed values (an impossible date, an ID that is not a UUID,
 * an unknown status) are ignored, so a hand-edited or outdated link still opens a list
 * instead of an error.
 */
export function readHistoryFilters(params: URLSearchParams): HistoryFilters {
  const hostId = readUuidParam(params, HISTORY_PARAM.host)
  const hostName = params.get(HISTORY_PARAM.hostName)?.trim()
  return {
    from: readDateParam(params, HISTORY_PARAM.from),
    to: readDateParam(params, HISTORY_PARAM.to),
    statuses: parseStatuses(params.get(HISTORY_PARAM.status)),
    host: hostId ? { id: hostId, nameHint: hostName || null } : null,
    departmentId: readUuidParam(params, HISTORY_PARAM.department),
    q: params.get(HISTORY_PARAM.q)?.trim() ?? '',
  }
}

/** URL changes for a new set of filters; any change returns to the first page. */
export function historyFilterChanges(filters: Partial<HistoryFilters>): UrlParamChanges {
  const changes: UrlParamChanges = { [HISTORY_PARAM.page]: null }
  if ('from' in filters) changes[HISTORY_PARAM.from] = filters.from ?? null
  if ('to' in filters) changes[HISTORY_PARAM.to] = filters.to ?? null
  if ('statuses' in filters) {
    const statuses = HISTORY_STATUSES.filter((status) => filters.statuses?.includes(status))
    // Every status selected is the same as none: keep the URL short.
    changes[HISTORY_PARAM.status] = statuses.length === 0 || statuses.length === HISTORY_STATUSES.length ? null : statuses.join(',')
  }
  if ('host' in filters) {
    changes[HISTORY_PARAM.host] = filters.host?.id ?? null
    changes[HISTORY_PARAM.hostName] = filters.host?.nameHint ?? null
  }
  if ('departmentId' in filters) changes[HISTORY_PARAM.department] = filters.departmentId ?? null
  if ('q' in filters) changes[HISTORY_PARAM.q] = filters.q?.trim() || null
  return changes
}

/** URL changes that remove every filter (and the page). */
export function clearHistoryFilterChanges(): UrlParamChanges {
  return historyFilterChanges(EMPTY_HISTORY_FILTERS)
}

/** How many filters narrow the list (for the "Filters (n)" control on phones). */
export function activeHistoryFilterCount(filters: HistoryFilters): number {
  return [
    filters.from !== null || filters.to !== null,
    filters.statuses.length > 0,
    filters.host !== null,
    filters.departmentId !== null,
    isHistorySearchable(filters.q),
  ].filter(Boolean).length
}

/**
 * GET /visits parameters for the history (§8): every visit of the company (`scope=all`; the
 * page's roles read all visits, §7.5), newest scheduled first. Dates are company-local
 * scheduled dates (B24-21). Returns null while the date range is invalid, so no request is
 * made that the server would refuse.
 */
export function historyListParams(filters: HistoryFilters, page: number): VisitListParams | null {
  if (dateRangeError(filters.from, filters.to)) return null
  const params: VisitListParams = { scope: 'all', order: 'desc', page, page_size: HISTORY_PAGE_SIZE }
  if (filters.statuses.length > 0) params.status = filters.statuses
  if (filters.from) params.date_from = filters.from
  if (filters.to) params.date_to = filters.to
  if (filters.host) params.host_id = filters.host.id
  if (filters.departmentId) params.department_id = filters.departmentId
  if (isHistorySearchable(filters.q)) params.q = filters.q
  return params
}
