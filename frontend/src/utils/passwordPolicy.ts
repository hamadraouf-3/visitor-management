import { currentLanguage, i18n, type Language } from '../i18n'

/**
 * Client-side hints for the password policy (§7.1). The server is authoritative: it also
 * rejects common passwords and returns a 422 field message, which forms display as-is.
 */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

export interface PasswordRequirement {
  id: 'length' | 'not-email'
  label: string
  met: boolean
}

/** Length is counted in Unicode code points, like the server (Python `len`). */
export function passwordLength(password: string): number {
  return [...password].length
}

function equalsEmail(password: string, email: string | undefined): boolean {
  if (!email) return false
  return password.trim().toLowerCase() === email.trim().toLowerCase()
}

export function passwordRequirements(password: string, email?: string, language: Language = currentLanguage()): PasswordRequirement[] {
  const length = passwordLength(password)
  return [
    {
      id: 'length',
      label: i18n.t('password.requirementLength', { ns: 'auth', lng: language, min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }),
      met: length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH,
    },
    {
      id: 'not-email',
      label: i18n.t('password.requirementNotEmail', { ns: 'auth', lng: language }),
      met: password.length > 0 && !equalsEmail(password, email),
    },
  ]
}

/** First policy violation as a field message, or null when the password passes the client checks. */
export function validateNewPassword(password: string, email?: string, language: Language = currentLanguage()): string | null {
  if (!password) return i18n.t('password.enterNew', { ns: 'auth', lng: language })
  const length = passwordLength(password)
  if (length < PASSWORD_MIN_LENGTH) return i18n.t('password.tooShort', { ns: 'auth', lng: language, min: PASSWORD_MIN_LENGTH })
  if (length > PASSWORD_MAX_LENGTH) return i18n.t('password.tooLong', { ns: 'auth', lng: language, max: PASSWORD_MAX_LENGTH })
  if (equalsEmail(password, email)) return i18n.t('password.notEmail', { ns: 'auth', lng: language })
  return null
}

export function validatePasswordConfirmation(password: string, confirmation: string, language: Language = currentLanguage()): string | null {
  if (!confirmation) return i18n.t('password.confirm', { ns: 'auth', lng: language })
  return password === confirmation ? null : i18n.t('password.mismatch', { ns: 'auth', lng: language })
}
