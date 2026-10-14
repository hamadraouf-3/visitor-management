import { notifyManager, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isPlatformPath, subscribeToApiErrors } from '../../api/client'
import { updatePlatformPreferences } from '../../api/platform'
import { isPlatformMeQueryKey, queryKeys } from '../../api/queryKeys'
import { platformAuthSync } from '../../auth/authSync'
import { isPlatformPage } from '../../auth/redirect'
import { useToast } from '../../components/ui/toastContext'
import { applyLanguage } from '../../i18n'
import { isLanguage, takeChosenLanguage, type Language } from '../../i18n/languages'
import { paths } from '../../paths'
import type { PlatformMe } from '../../types/api'
import { platformLoginPath } from './platformRedirect'
import { dropPreviousPlatformData, endPlatformSession, forgetPlatformSession, markPlatformPasswordChangeRequired, platformIdentity } from './platformSession'

/**
 * Global reactions to the platform session (Phase 11), mounted around every platform page; the
 * company session's are `AuthProvider`'s, and neither touches the other's state:
 * - 401 NOT_AUTHENTICATED from a `/platform` request while signed in to the platform: the platform's
 *   cache is cleared and the page goes to /platform/login?next=<here>.
 * - 403 PASSWORD_CHANGE_REQUIRED from a `/platform` request: /platform/change-password.
 * - Another tab signed out of the platform: the platform's cache is cleared, the page goes to the
 *   platform sign-in. Another tab signed in: the platform session is checked again.
 * - The platform session now belongs to another platform account: its data and toasts go, and the
 *   page starts again from the companies.
 * - Back from the back/forward cache: nothing of the platform session shows until the server answers.
 */
export function PlatformAuthProvider({ children }: { children: ReactNode }) {
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
        if (!isPlatformPath(request.path)) return
        if (error.status === 401 && error.code === 'NOT_AUTHENTICATED') {
          if (!queryClient.getQueryData(queryKeys.platform.me)) return
          endPlatformSession(queryClient)
          if (isPlatformPage(locationRef.current.pathname)) navigate(platformLoginPath(locationRef.current), { replace: true })
          return
        }
        if (error.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
          markPlatformPasswordChangeRequired(queryClient, true)
          if (locationRef.current.pathname !== paths.platformChangePassword) navigate(paths.platformChangePassword, { replace: true })
        }
      }),
    [queryClient, navigate],
  )

  useEffect(
    () =>
      platformAuthSync.subscribe((change) => {
        if (change === 'signed-out') {
          if (!queryClient.getQueryData(queryKeys.platform.me)) return
          endPlatformSession(queryClient)
          if (isPlatformPage(locationRef.current.pathname)) navigate(paths.platformLogin, { replace: true })
          return
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.platform.me })
      }),
    [queryClient, navigate],
  )

  // Toasts belong to the platform session that showed them (as `AuthProvider` does for the company's):
  // every change of who is signed in to the platform removes them; a re-check with the same account keeps them.
  useEffect(() => {
    const known = queryClient.getQueryData<PlatformMe | null>(queryKeys.platform.me)
    let identity = known === undefined ? undefined : platformIdentity(known)
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || !isPlatformMeQueryKey(event.query.queryKey)) return
      const me = event.query.state.data as PlatformMe | null | undefined
      if (me === undefined) return
      const next = platformIdentity(me)
      if (identity !== undefined && next !== identity) notifyManager.schedule(resetToasts)
      identity = next
    })
  }, [queryClient, resetToasts])

  // Another platform account (signed in in another tab): nothing of the previous one may stay.
  useEffect(() => {
    let identity = platformIdentity(queryClient.getQueryData<PlatformMe | null>(queryKeys.platform.me))
    return queryClient.getQueryCache().subscribe((event) => {
      if (!isPlatformMeQueryKey(event.query.queryKey)) return
      if (event.type === 'removed') {
        // A local sign-in or sign-out starts from an empty platform cache (`platformSession.ts`).
        identity = null
        return
      }
      if (event.type !== 'updated') return
      const me = event.query.state.data as PlatformMe | null | undefined
      if (me === undefined) return
      const previous = identity
      identity = platformIdentity(me)
      if (previous === null || identity === null || previous === identity) return
      dropPreviousPlatformData(queryClient)
      if (isPlatformPage(locationRef.current.pathname)) navigate(paths.platformCompanies, { replace: true })
    })
  }, [queryClient, navigate])

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !queryClient.getQueryData(queryKeys.platform.me)) return
      notifyManager.batch(() => {
        forgetPlatformSession(queryClient)
        notifyManager.schedule(resetToasts)
      })
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [queryClient, resetToasts])

  return <>{children}</>
}

/** The cached platform session without observing the query (an observer would fetch it). */
function useCachedPlatformMe(): PlatformMe | null | undefined {
  const queryClient = useQueryClient()
  return useSyncExternalStore(
    (onChange) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (isPlatformMeQueryKey(event.query.queryKey)) onChange()
      }),
    () => queryClient.getQueryData<PlatformMe | null>(queryKeys.platform.me),
  )
}

/**
 * Applies the platform owner's language (`preferred_language`) whenever it changes, as
 * `LanguageController` does for the company session. Without a preference the device's language
 * stays, and a language picked on the platform sign-in page is saved to the account at sign-in.
 */
export function PlatformLanguageController(): null {
  const me = useCachedPlatformMe()
  const queryClient = useQueryClient()
  const preference: unknown = me?.admin.preferred_language
  const language: Language | null = isLanguage(preference) ? preference : null
  const identity = platformIdentity(me)
  const applied = useRef<string | null>(null)

  useLayoutEffect(() => {
    const key = identity === null ? null : `${identity}:${language ?? ''}`
    if (key === applied.current) return
    const signedIn = applied.current === null || !applied.current.startsWith(`${identity}:`)
    applied.current = key
    if (!me || identity === null) return
    if (signedIn) {
      // Taken at every platform sign-in, used or not (as for the company session, F10-24).
      const chosen = takeChosenLanguage()
      if (chosen && language === null) {
        applyLanguage(chosen)
        updatePlatformPreferences({ language: chosen }).then(
          (saved) => queryClient.setQueryData(queryKeys.platform.me, saved),
          () => {},
        )
        return
      }
    }
    if (language) applyLanguage(language)
  }, [identity, language, me, queryClient])

  return null
}
