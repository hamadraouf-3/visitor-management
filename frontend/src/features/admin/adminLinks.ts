import { paths } from '../../paths'
import type { Role } from '../../types/api'
import { HISTORY_STATUSES, historyFilterChanges } from '../history/historyFilters'
import { userFilterChanges } from './userFilters'

function withQuery(path: string, changes: Record<string, string | null>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(changes)) if (value !== null) query.set(key, value)
  const serialized = query.toString()
  return serialized ? `${path}?${serialized}` : path
}

/**
 * The visits the dashboard counts as "today": scheduled for that company-local day, cancelled
 * ones left out (as the server counts them), so the list behind the tile shows its number.
 */
export function historyLinkForDay(dateKey: string): string {
  return withQuery(
    paths.history,
    historyFilterChanges({ from: dateKey, to: dateKey, statuses: HISTORY_STATUSES.filter((status) => status !== 'CANCELLED') }),
  )
}

/** The active accounts holding one role, the set each account tile counts. */
export function usersLinkForRole(role: Role): string {
  return withQuery(paths.adminUsers, userFilterChanges({ role, status: 'active' }))
}
