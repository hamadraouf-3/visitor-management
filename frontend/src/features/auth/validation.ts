import { currentLanguage, i18n, type Language } from '../../i18n'
import type { FormErrors } from '../../utils/forms'
import { validateNewPassword, validatePasswordConfirmation } from '../../utils/passwordPolicy'

// Deliberately permissive: the server validates addresses; this only catches obvious typos.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An address in the shape people know, for the "valid address" message (Latin in both languages). */
const EXAMPLE_EMAIL = 'name@company.com'

export function validateEmail(email: string, language: Language = currentLanguage()): string | undefined {
  const value = email.trim()
  if (!value) return i18n.t('validation.emailRequired', { ns: 'auth', lng: language })
  if (!EMAIL_PATTERN.test(value)) return i18n.t('validation.emailInvalid', { ns: 'auth', lng: language, example: EXAMPLE_EMAIL })
  return undefined
}

export interface EmailValues {
  email: string
}

export function validateEmailForm(values: EmailValues): FormErrors<keyof EmailValues> {
  return { email: validateEmail(values.email) }
}

export interface LoginValues {
  email: string
  password: string
}

export function validateLogin(values: LoginValues): FormErrors<keyof LoginValues> {
  return {
    email: validateEmail(values.email),
    password: values.password ? undefined : i18n.t('validation.passwordRequired', { ns: 'auth' }),
  }
}

export interface NewPasswordValues {
  newPassword: string
  confirmPassword: string
}

export function validateNewPasswordForm(
  values: NewPasswordValues,
  email?: string,
): FormErrors<keyof NewPasswordValues> {
  return {
    newPassword: validateNewPassword(values.newPassword, email) ?? undefined,
    confirmPassword: validatePasswordConfirmation(values.newPassword, values.confirmPassword) ?? undefined,
  }
}

export interface ChangePasswordValues extends NewPasswordValues {
  currentPassword: string
}

export function validateChangePassword(values: ChangePasswordValues, email: string): FormErrors<keyof ChangePasswordValues> {
  return {
    currentPassword: values.currentPassword ? undefined : i18n.t('validation.currentPasswordRequired', { ns: 'auth' }),
    ...validateNewPasswordForm(values, email),
  }
}
