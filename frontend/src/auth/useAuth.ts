import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { createContext, useContext, useSyncExternalStore } from 'react'
import { getMe } from '../api/auth'
import { isApiError } from '../api/client'
import { isBackgroundFetch } from '../api/queries'
import { shouldRetryQuery } from '../api/queryClient'
import { isMeQueryKey, queryKeys } from '../api/queryKeys'
import type { Me } from '../types/api'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error'

/**
 * How often a signed-in tab asks the server whether its session still exists (SEC-50). The
 * server ends a session after SESSION_IDLE_MINUTES (at least 5) or its absolute lifetime without
 * telling anyone, so a page that sends no request of its own would otherwise keep showing the
 * previous user's data, and name them in the account menu, until someone touches it.
 */
export const SESSION_HEARTBEAT_MS = 60_000

/**
 * `null` means "not signed in" (401); other failures are errors. Only the first check (a page
 * load) is the user's own request. Every re-check (the heartbeat, the tab shown again, another
 * tab's sign-in) is sent as a background refresh (§7.2), so it never keeps an idle session alive:
 * the session check is not user activity, and a kiosk screen that wakes up is not either.
 */
export async function fetchMe({
  signal,
  client,
  queryKey,
}: { signal?: AbortSignal; client?: QueryClient; queryKey?: QueryKey } = {}): Promise<Me | null> {
  try {
    return await getMe({ signal, backgroundRefresh: client && queryKey ? isBackgroundFetch(client, queryKey) : false })
  } catch (error) {
    if (isApiError(error) && error.status === 401) return null
    throw error
  }
}

export const meQueryOptions = {
  queryKey: queryKeys.me,
  queryFn: fetchMe,
  staleTime: 5 * 60_000,
  // Every time the tab becomes visible again, however fresh: the session cookie is shared by
  // all tabs, so someone may have signed in as another user elsewhere. `AuthProvider` clears
  // the cache when the answer names another user.
  refetchOnWindowFocus: 'always',
  retry: shouldRetryQuery,
} as const

/**
 * The session heartbeat (SEC-50), mounted once by `RequireAuth` (every page's observer of
 * `['auth','me']` would otherwise start a timer of its own). While someone is signed in it asks
 * `/auth/me` every {@link SESSION_HEARTBEAT_MS} as a background refresh. A session the server has
 * ended answers 401, and `AuthProvider` clears the cache, the toasts and the screen and goes to
 * /login; another user's answer goes through the identity check. It also runs while the tab is
 * hidden, so a tab shown again after the session ended is already at /login, even when the
 * device is offline by then. Signed out, or on a public page, it sends nothing.
 */
export function useSessionHeartbeat(): void {
  useQuery({
    ...meQueryOptions,
    refetchInterval: (query) => (query.state.data ? SESSION_HEARTBEAT_MS : false),
    refetchIntervalInBackground: true,
    // A timer only: the component that mounts it never re-renders because of it.
    notifyOnChangeProps: [],
  })
}

/**
 * The session as the cache has it (`['auth','me']`), without observing the query: an observer would
 * fetch `/auth/me`, and public pages (the visitor pass) ask the server nothing about a session.
 * Undefined while it is not known, null when nobody is signed in.
 */
export function useCachedMe(): Me | null | undefined {
  const queryClient = useQueryClient()
  return useSyncExternalStore(
    (onChange) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (isMeQueryKey(event.query.queryKey)) onChange()
      }),
    () => queryClient.getQueryData<Me | null>(queryKeys.me),
  )
}

/** Who a session is: the user and the company. Another identity means another person's data. */
export function sessionIdentity(me: Me | null | undefined): string | null {
  return me ? `${me.company.id}:${me.user.id}` : null
}

/**
 * Who owns the pages below it when that is not the company session: the platform owner's area
 * (Phase 11) provides `platform:<id>`, so its lists keep their view state without asking the
 * company session (`/auth/me`) who is signed in. Undefined (the default): the company session.
 */
export const SessionOwnerContext = createContext<string | null | undefined>(undefined)

/**
 * The signed-in user's ID (null while signed out). Router state is tagged with it: the
 * browser keeps every history entry's state after sign-out, and a page must not show what a
 * previous user of the tab left there (`useUrlParams`, `useBackLink`). In the platform owner's
 * area it is the platform account (`SessionOwnerContext`), and the company session is not asked.
 */
export function useSessionUserId(): string | null {
  const override = useContext(SessionOwnerContext)
  const query = useQuery({ ...meQueryOptions, enabled: override === undefined })
  if (override !== undefined) return override
  return query.data?.user.id ?? null
}

/**
 * The signed-in user and company, from TanStack Query `['auth','me']` — the only source of
 * auth state (no other global store). A transient refetch failure keeps the last known user,
 * except after a restore from the back/forward cache, which forgets it first (SEC-51).
 */
export function useAuth() {
  const query = useQuery(meQueryOptions)
  const me = query.data ?? null

  let status: AuthStatus
  if (me) status = 'authenticated'
  else if (query.isPending) status = 'loading'
  else if (query.isError) status = 'error'
  else status = 'unauthenticated'

  return {
    status,
    me,
    user: me?.user ?? null,
    company: me?.company ?? null,
    error: query.error,
    refetch: query.refetch,
  }
}
