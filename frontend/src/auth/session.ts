import { notifyManager, type QueryClient } from '@tanstack/react-query'
import { isMeQueryKey, isPlatformQueryKey, queryKeys } from '../api/queryKeys'
import type { Me } from '../types/api'

/**
 * Session transitions on the query cache. Server data of one user must never be shown to
 * the next user of a shared device, so every sign-in and sign-out starts from an empty cache.
 *
 * The platform owner's session (Phase 11) is another principal with cookies of its own: a
 * browser may hold both, and neither ends the other. The company session's transitions therefore
 * leave the platform's cache entries (`queryKeys.platform`, mutations keyed under it) alone; the
 * platform's own transitions are in `features/platform/platformSession.ts`.
 */

/** Every cached query but the platform's (and, with `keepMe`, but the session check). */
function removeCompanyQueries(queryClient: QueryClient, { keepMe = false } = {}): void {
  queryClient.removeQueries({ predicate: (query) => !isPlatformQueryKey(query.queryKey) && !(keepMe && isMeQueryKey(query.queryKey)) })
}

/** Every mutation but the platform's (`mutationKey` under `queryKeys.platform`). */
export function clearCompanyMutations(queryClient: QueryClient): void {
  const cache = queryClient.getMutationCache()
  for (const mutation of cache.getAll()) {
    if (!isPlatformQueryKey(mutation.options.mutationKey ?? [])) cache.remove(mutation)
  }
}

export function startSession(queryClient: QueryClient, me: Me): void {
  // Queries only: the sign-in mutation that called this is still settling.
  removeCompanyQueries(queryClient)
  queryClient.setQueryData(queryKeys.me, me)
}

export function endSession(queryClient: QueryClient): void {
  removeCompanyQueries(queryClient)
  clearCompanyMutations(queryClient)
  queryClient.setQueryData<Me | null>(queryKeys.me, null)
}

/**
 * The tab no longer knows whether its session exists (SEC-51: the page came back from the
 * browser's back/forward cache, after an unknown time, and the session may have ended without
 * any message reaching it). Every query and mutation of the session is dropped, and `['auth','me']`
 * goes back to "not known yet", so `RequireAuth` shows its loader until the server answers. The
 * same user then starts again from fresh data; a 401 goes to /login; another user goes through
 * the identity check. Offline the loader (or "We could not load your session") stays, with
 * nothing of the session behind it: a failed check keeps the last known user only while it is
 * known, and here it is not.
 */
export function forgetSession(queryClient: QueryClient): void {
  notifyManager.batch(() => {
    removeCompanyQueries(queryClient, { keepMe: true })
    clearCompanyMutations(queryClient)
    // Refetched at once where a page needs it (`RequireAuth`); a public page sends nothing.
    void queryClient.resetQueries({ queryKey: queryKeys.me, exact: true })
  })
}

/** After another user's answer: everything of the previous company session goes but the session check itself. */
export function dropPreviousSessionData(queryClient: QueryClient): void {
  removeCompanyQueries(queryClient, { keepMe: true })
  clearCompanyMutations(queryClient)
}

export function markPasswordChangeRequired(queryClient: QueryClient, required: boolean): void {
  queryClient.setQueryData<Me | null>(queryKeys.me, (me) =>
    me ? { ...me, user: { ...me.user, must_change_password: required } } : me,
  )
}
