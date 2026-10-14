import { QueryCache, QueryClient, type Query } from '@tanstack/react-query'
import { isApiError } from './client'
import { isMeQueryKey, isPlatformMeQueryKey } from './queryKeys'

const MAX_RETRIES = 2
const TRANSIENT_STATUSES = new Set([502, 503, 504])

/** Only transient failures are retried; 4xx responses are definitive answers. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES || !isApiError(error)) return false
  return error.isNetworkError || TRANSIENT_STATUSES.has(error.status) || error.code === 'SERVICE_BUSY'
}

/**
 * A refetch the server refused for good: 404 (gone, or not in this user's scope) or 403 (not
 * allowed). The session checks (`['auth','me']`, the platform's `['platform','auth','me']`) and the
 * forced password change are excluded; the auth layers handle those.
 */
export function isRefusal(error: unknown, queryKey: readonly unknown[]): boolean {
  if (!isApiError(error)) return false
  if (isMeQueryKey(queryKey) || isPlatformMeQueryKey(queryKey)) return false
  return error.status === 404 || (error.status === 403 && error.code !== 'PASSWORD_CHANGE_REQUIRED')
}

/**
 * TanStack Query keeps the last data when a refetch fails, and pages render that data while it
 * exists. After a refusal the data must go: the record was deleted or left the user's scope, or
 * the browser's session now belongs to someone else (another tab signed in). The query keeps its
 * error, so the page shows its "not found" or "no access" state instead.
 */
export function forgetRefusedData(error: unknown, query: Query<unknown, unknown, unknown, readonly unknown[]>): void {
  if (!isRefusal(error, query.queryKey) || query.state.data === undefined) return
  query.setState({ data: undefined, dataUpdatedAt: 0 })
}

/** The app's query cache policy (also used by the test client). */
export function createQueryCache(): QueryCache {
  return new QueryCache({ onError: forgetRefusedData })
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: createQueryCache(),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetryQuery,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
