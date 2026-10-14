import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { isApiError } from '../../api/client'
import { platformChangePassword, platformLogin, platformLogout, updatePlatformPreferences } from '../../api/platform'
import { queryKeys } from '../../api/queryKeys'
import { platformAuthSync } from '../../auth/authSync'
import { useSwitchLanguage } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { ChangePasswordRequest, LoginRequest, PlatformMe } from '../../types/api'
import { endPlatformSession, markPlatformPasswordChangeRequired, startPlatformSession } from './platformSession'

/** Mutation keys of the platform session (under `queryKeys.platform`, so a company sign-out leaves them alone). */
const KEYS = {
  signIn: [...queryKeys.platform.all, 'sign-in'],
  signOut: [...queryKeys.platform.all, 'sign-out'],
  changePassword: [...queryKeys.platform.all, 'change-password'],
  language: [...queryKeys.platform.all, 'language'],
} as const

/** Signs in to the platform; the platform's cache starts fresh and the other tabs are told. */
export function usePlatformSignIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: KEYS.signIn,
    mutationFn: (credentials: LoginRequest) => platformLogin(credentials),
    onSuccess: (me) => {
      startPlatformSession(queryClient, me)
      platformAuthSync.broadcast('signed-in')
    },
  })
}

/**
 * Signs out of the platform, then clears the platform's cache, tells the other tabs and goes to the
 * platform sign-in. A 401 means the session had already ended (success); other failures keep it.
 * A company session in the same browser is not touched.
 */
export function usePlatformSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationKey: KEYS.signOut,
    mutationFn: async () => {
      try {
        await platformLogout()
      } catch (error) {
        if (!(isApiError(error) && error.status === 401)) throw error
      }
    },
    onSuccess: () => {
      endPlatformSession(queryClient)
      platformAuthSync.broadcast('signed-out')
      navigate(paths.platformLogin, { replace: true })
    },
  })
}

/** Changes the platform password: the server revokes every platform session and sets new cookies. */
export function usePlatformChangePassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: KEYS.changePassword,
    mutationFn: (body: ChangePasswordRequest) => platformChangePassword(body),
    onSuccess: () => {
      markPlatformPasswordChangeRequired(queryClient, false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.me })
    },
  })
}

/**
 * The platform pages' language switch: saved to the platform account (PATCH
 * /platform/auth/preferences) when signed in to the platform, else remembered on the device.
 */
export function usePlatformChangeLanguage() {
  const queryClient = useQueryClient()
  return useSwitchLanguage<PlatformMe>({
    mutationKey: KEYS.language,
    save: (language) => (queryClient.getQueryData<PlatformMe | null>(queryKeys.platform.me) ? updatePlatformPreferences({ language }) : null),
    onSaved: (me) => queryClient.setQueryData(queryKeys.platform.me, me),
  })
}
