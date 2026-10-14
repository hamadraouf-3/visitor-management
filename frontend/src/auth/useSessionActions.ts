import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { changePassword, forgotPassword, login, logout, resetPassword } from '../api/auth'
import { isApiError } from '../api/client'
import { queryKeys } from '../api/queryKeys'
import type { ChangePasswordRequest, LoginRequest, ResetPasswordRequest } from '../types/api'
import { broadcastAuthChange } from './authSync'
import { signInPath } from './redirect'
import { endSession, markPasswordChangeRequired, startSession } from './session'

/**
 * Signs in; on success the cache starts fresh with the returned `Me`, and the other tabs are
 * told, since the new session cookie is theirs too (`AuthProvider`).
 */
export function useSignIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (credentials: LoginRequest) => login(credentials),
    onSuccess: (me) => {
      startSession(queryClient, me)
      broadcastAuthChange('signed-in')
    },
  })
}

/**
 * Signs out on the server, then clears every cached query, tells the other tabs to do the same
 * (they share the session) and goes to the device's sign-in page (its company's, Phase 12). A 401 means the session had already ended, which
 * is treated as success; other failures (e.g. offline) leave the user signed in so a shared
 * device is never falsely shown as signed out.
 */
export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async () => {
      try {
        await logout()
      } catch (error) {
        if (!(isApiError(error) && error.status === 401)) throw error
      }
    },
    onSuccess: () => {
      endSession(queryClient)
      broadcastAuthChange('signed-out')
      navigate(signInPath(), { replace: true })
    },
  })
}

/** Changes the password; other sessions are revoked by the server (§7.2). */
export function useChangePassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => changePassword(body),
    onSuccess: () => {
      markPasswordChangeRequired(queryClient, false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.me })
    },
  })
}

/**
 * Requests a password reset link. The server answers 202 with the same body whether or not
 * the account exists (§7.2), so success says nothing about the address.
 */
export function useRequestPasswordReset() {
  return useMutation({ mutationFn: (email: string) => forgotPassword({ email }) })
}

/**
 * Sets a new password with a reset token. The server revokes every session of the account,
 * including one in this browser, so the local session ends as well.
 */
export function useResetPassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ResetPasswordRequest) => resetPassword(body),
    onSuccess: () => endSession(queryClient),
  })
}
