import type {
  ChangePasswordRequest,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  Me,
  PreferencesUpdate,
  ResetPasswordRequest,
} from '../types/api'
import { apiRequest, type CallOptions } from './client'

export function login(body: LoginRequest, options?: CallOptions): Promise<Me> {
  return apiRequest('/auth/login', { ...options, method: 'POST', body })
}

export function logout(options?: CallOptions): Promise<void> {
  return apiRequest('/auth/logout', { ...options, method: 'POST' })
}

export function getMe(options?: CallOptions): Promise<Me> {
  return apiRequest('/auth/me', options)
}

export function changePassword(body: ChangePasswordRequest, options?: CallOptions): Promise<void> {
  return apiRequest('/auth/change-password', { ...options, method: 'POST', body })
}

/** Always 202 with an identical body, whether or not the account exists (§7.2). */
export function forgotPassword(body: ForgotPasswordRequest, options?: CallOptions): Promise<ForgotPasswordResponse> {
  return apiRequest('/auth/forgot-password', { ...options, method: 'POST', body })
}

export function resetPassword(body: ResetPasswordRequest, options?: CallOptions): Promise<void> {
  return apiRequest('/auth/reset-password', { ...options, method: 'POST', body })
}

/**
 * Saves the signed-in user's UI language and answers with the updated `Me`. Allowed while a
 * password change is required, so the forced-change screen can switch language too.
 */
export function updatePreferences(body: PreferencesUpdate, options?: CallOptions): Promise<Me> {
  return apiRequest('/auth/preferences', { ...options, method: 'PATCH', body })
}
