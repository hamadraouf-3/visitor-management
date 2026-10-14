import { useQuery, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { isApiError } from '../../api/client'
import { getPlatformMe } from '../../api/platform'
import { isBackgroundFetch } from '../../api/queries'
import { shouldRetryQuery } from '../../api/queryClient'
import { queryKeys } from '../../api/queryKeys'
import { SESSION_HEARTBEAT_MS, type AuthStatus } from '../../auth/useAuth'
import type { PlatformMe } from '../../types/api'

/**
 * Who is signed in to the platform (Phase 11): `null` is "nobody" (401), other failures are
 * errors. Like the company session check (`fetchMe`), every re-check is a background refresh, so it
 * never keeps an idle platform session alive (30 minutes by default, B11-6).
 */
export async function fetchPlatformMe({
  signal,
  client,
  queryKey,
}: { signal?: AbortSignal; client?: QueryClient; queryKey?: QueryKey } = {}): Promise<PlatformMe | null> {
  try {
    return await getPlatformMe({ signal, backgroundRefresh: client && queryKey ? isBackgroundFetch(client, queryKey) : false })
  } catch (error) {
    if (isApiError(error) && error.status === 401) return null
    throw error
  }
}

export const platformMeQueryOptions = {
  queryKey: queryKeys.platform.me,
  queryFn: fetchPlatformMe,
  staleTime: 5 * 60_000,
  // Every time the tab becomes visible again: the platform cookie is shared by all tabs.
  refetchOnWindowFocus: 'always',
  retry: shouldRetryQuery,
} as const

/** The platform session's heartbeat (SEC-50), mounted once by `RequirePlatformAuth`. */
export function usePlatformSessionHeartbeat(): void {
  useQuery({
    ...platformMeQueryOptions,
    refetchInterval: (query) => (query.state.data ? SESSION_HEARTBEAT_MS : false),
    refetchIntervalInBackground: true,
    notifyOnChangeProps: [],
  })
}

/** The platform owner from `['platform','auth','me']`, the only source of the platform session's state. */
export function usePlatformAuth() {
  const query = useQuery(platformMeQueryOptions)
  const me = query.data ?? null

  let status: AuthStatus
  if (me) status = 'authenticated'
  else if (query.isPending) status = 'loading'
  else if (query.isError) status = 'error'
  else status = 'unauthenticated'

  return { status, me, admin: me?.admin ?? null, error: query.error, refetch: query.refetch }
}
