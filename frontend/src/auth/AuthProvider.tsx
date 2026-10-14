import { notifyManager, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isPlatformPath, subscribeToApiErrors } from '../api/client'
import { isMeQueryKey, queryKeys } from '../api/queryKeys'
import { useToast } from '../components/ui/toastContext'
import { paths } from '../paths'
import type { Me } from '../types/api'
import { subscribeToAuthChanges } from './authSync'
import { isPlatformPage, isPublicPage, loginPath, signInPath } from './redirect'
import { dropPreviousSessionData, endSession, forgetSession, markPasswordChangeRequired } from './session'
import { sessionIdentity } from './useAuth'

/**
 * Global reactions to auth changes (§7.2). Server data of one user must never be shown to the
 * next user of a shared device, also not in another tab of the same browser:
 * - 401 NOT_AUTHENTICATED while signed in (session expired or revoked): clear every cached
 *   query and go to the device's sign-in page (its company's `/c/{slug}`, else `/login`) with
 *   `?next=<current page>`.
 * - 403 PASSWORD_CHANGE_REQUIRED: go to /change-password.
 * - Another tab signed out: clear every cached query and go to the device's sign-in page.
 * - Another tab signed in: check the session again. All tabs share the session cookie, so if it
 *   now belongs to another user (or company), every cached query of the previous one is removed
 *   and the tab starts again from the landing page. The same check runs whenever `/auth/me`
 *   answers (it is refetched each time the tab is shown again), so a missed message is caught.
 * - Whenever the signed-in user changes, in any of these ways or by a sign-in or sign-out in
 *   this tab: every toast is removed, and none of the previous session can appear later.
 * - The page came back from the back/forward cache (Back after leaving it for another page
 *   load): it may be hours later and the session may have ended without a word, so nothing of
 *   it stays on screen until the server confirms who is signed in (SEC-51).
 * - A session the server ended while the page sends nothing of its own (the idle timeout on a
 *   screen left open) is found by `RequireAuth`'s heartbeat, whose 401 ends it here (SEC-50).
 * It makes no API calls of its own on public pages, so /pass stays request-free. Auth state
 * lives only in TanStack Query (`useAuth`).
 *
 * The platform owner (Phase 11) is another principal with a session of its own: its requests
 * (`/platform/…`) and its pages (`/platform…`) are not this session's, so a platform 401 or 403
 * never ends or redirects the company session, and a company session's end never takes a platform
 * page away (`features/platform/PlatformAuthProvider.tsx` handles the platform's).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { reset: resetToasts } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  useLayoutEffect(() => {
    locationRef.current = location
  })

  useEffect(
    () =>
      subscribeToApiErrors((error, request) => {
        // The platform's own session answers for its requests (PlatformAuthProvider).
        if (isPlatformPath(request.path)) return
        if (error.status === 401 && error.code === 'NOT_AUTHENTICATED') {
          // Only an established session can expire; anonymous 401s are the normal signed-out state.
          if (!queryClient.getQueryData(queryKeys.me)) return
          endSession(queryClient)
          navigate(loginPath(locationRef.current), { replace: true })
          return
        }
        if (error.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
          markPasswordChangeRequired(queryClient, true)
          if (locationRef.current.pathname !== paths.changePassword) navigate(paths.changePassword, { replace: true })
        }
      }),
    [queryClient, navigate],
  )

  useEffect(
    () =>
      subscribeToAuthChanges((change) => {
        if (change === 'signed-out') {
          if (!queryClient.getQueryData(queryKeys.me)) return
          endSession(queryClient)
          // No `next`: the next person to sign in here may be someone else. A public page (a
          // visitor pass, a password reset) stays as it is.
          if (!isPublicPage(locationRef.current.pathname) && !isPlatformPage(locationRef.current.pathname)) navigate(signInPath(), { replace: true })
          return
        }
        // Signed in elsewhere: who is this tab now? The answer goes through the identity check
        // below; a tab on the sign-in page continues as the new user.
        void queryClient.invalidateQueries({ queryKey: queryKeys.me })
      }),
    [queryClient, navigate],
  )

  // Toasts belong to the session that showed them: they outlive pages (the provider is above the
  // router), and an error toast stays until dismissed, so a visitor's name in one stayed on the
  // sign-in screen and into the next user's session. Every change of who is signed in goes
  // through `['auth','me']`: a sign-out here or in another tab, a session that ended on the
  // server (401), a sign-in, another user's sign-in elsewhere. Each one removes every toast,
  // and a request of the previous session that settles later cannot show one (`ToastApi.reset`).
  // A re-check that answers with the same user (a refetch, a password change) keeps them.
  // The reset runs with the cache's own notifications of the change, so the components that show
  // toasts re-render in the same render as the rest of the app (RequireAuth's redirect, the new
  // page), never before it: a page of the previous session re-rendered on its own would fetch
  // its cleared queries again. A toast asked for until then is in the list the reset clears.
  useEffect(() => {
    const known = queryClient.getQueryData<Me | null>(queryKeys.me)
    // undefined: not known yet (first load).
    let identity = known === undefined ? undefined : sessionIdentity(known)
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || !isMeQueryKey(event.query.queryKey)) return
      const me = event.query.state.data as Me | null | undefined
      // Removed or pending again: wait for the answer.
      if (me === undefined) return
      const next = sessionIdentity(me)
      if (identity !== undefined && next !== identity) notifyManager.schedule(resetToasts)
      identity = next
    })
  }, [queryClient, resetToasts])

  // A document restored from the back/forward cache resumes with its query cache, component
  // state and toasts as they were when it was left, and nothing told it that the session ended
  // meanwhile (a 401 elsewhere is not broadcast, SEC-26; a sign-out through the menu is, but
  // only to documents that are running). Its only re-check was the refetch of `/auth/me` when
  // shown, and while that is pending, or fails because the device is offline, the last known
  // user is kept, so the previous user's visitors stayed on screen and browsable. Now the
  // restore forgets the session (`forgetSession`): the loader replaces the page and the toasts
  // go, in the same render, until the server answers. A page without a known session (the
  // sign-in page, a public page) has nothing to hide and is left as it is.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !queryClient.getQueryData(queryKeys.me)) return
      notifyManager.batch(() => {
        forgetSession(queryClient)
        notifyManager.schedule(resetToasts)
      })
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [queryClient, resetToasts])

  useEffect(() => {
    let identity = sessionIdentity(queryClient.getQueryData<Me | null>(queryKeys.me))
    return queryClient.getQueryCache().subscribe((event) => {
      if (!isMeQueryKey(event.query.queryKey)) return
      if (event.type === 'removed') {
        // A local sign-in or sign-out starts from an empty cache (`session.ts`).
        identity = null
        return
      }
      if (event.type !== 'updated') return
      const me = event.query.state.data as Me | null | undefined
      // Pending again (reset or first load): the identity is unknown until the answer.
      if (me === undefined) return
      const previous = identity
      identity = sessionIdentity(me)
      if (previous === null || identity === null || previous === identity) return
      // The session now belongs to someone else: nothing of the previous user may stay.
      dropPreviousSessionData(queryClient)
      if (!isPublicPage(locationRef.current.pathname) && !isPlatformPage(locationRef.current.pathname)) navigate(paths.home, { replace: true })
    })
  }, [queryClient, navigate])

  return <>{children}</>
}
