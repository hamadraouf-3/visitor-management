import { notifyManager, type QueryClient } from '@tanstack/react-query'
import { isPlatformMeQueryKey, isPlatformQueryKey, queryKeys } from '../../api/queryKeys'
import type { PlatformMe } from '../../types/api'

/**
 * The platform owner's session transitions on the query cache (Phase 11). They touch only the
 * platform's entries (`queryKeys.platform`, mutations keyed under it): a company session in the same
 * browser is another principal and stays as it is (`auth/session.ts` does the same the other way).
 */

/** Every platform query (and, with `keepMe`, but the platform session check). */
function removePlatformQueries(queryClient: QueryClient, { keepMe = false } = {}): void {
  queryClient.removeQueries({ predicate: (query) => isPlatformQueryKey(query.queryKey) && !(keepMe && isPlatformMeQueryKey(query.queryKey)) })
}

/** The platform's mutations (`mutationKey` under `queryKeys.platform`). */
function clearPlatformMutations(queryClient: QueryClient): void {
  const cache = queryClient.getMutationCache()
  for (const mutation of cache.getAll()) {
    if (isPlatformQueryKey(mutation.options.mutationKey ?? [])) cache.remove(mutation)
  }
}

/** A platform sign-in: the platform's cache starts fresh with the answer. */
export function startPlatformSession(queryClient: QueryClient, me: PlatformMe): void {
  removePlatformQueries(queryClient)
  queryClient.setQueryData(queryKeys.platform.me, me)
}

/** A platform sign-out or an ended platform session: nothing of it stays. */
export function endPlatformSession(queryClient: QueryClient): void {
  removePlatformQueries(queryClient)
  clearPlatformMutations(queryClient)
  queryClient.setQueryData<PlatformMe | null>(queryKeys.platform.me, null)
}

/** Back from the back/forward cache (SEC-51): nothing of the platform session shows until the server answers again. */
export function forgetPlatformSession(queryClient: QueryClient): void {
  notifyManager.batch(() => {
    removePlatformQueries(queryClient, { keepMe: true })
    clearPlatformMutations(queryClient)
    void queryClient.resetQueries({ queryKey: queryKeys.platform.me, exact: true })
  })
}

/** Another platform account answered: the previous one's data goes, the session check stays. */
export function dropPreviousPlatformData(queryClient: QueryClient): void {
  removePlatformQueries(queryClient, { keepMe: true })
  clearPlatformMutations(queryClient)
}

export function markPlatformPasswordChangeRequired(queryClient: QueryClient, required: boolean): void {
  queryClient.setQueryData<PlatformMe | null>(queryKeys.platform.me, (me) => (me ? { admin: { ...me.admin, must_change_password: required } } : me))
}

/** Who a platform session is; another identity means another person's data. */
export function platformIdentity(me: PlatformMe | null | undefined): string | null {
  return me ? `platform:${me.admin.id}` : null
}
