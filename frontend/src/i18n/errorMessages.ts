import { currentLanguage, i18n } from './index'
import enErrors from './locales/en/errors.json'

/** An error code with a message in the `errors` catalog: every API code (§8.2) and the client's own. */
export type CatalogErrorCode = keyof typeof enErrors.codes

export function isCatalogErrorCode(code: string): code is CatalogErrorCode {
  return Object.hasOwn(enErrors.codes, code)
}

/** What `errorMessage` needs of a failed request (the API client's `ApiError`). */
export interface ErrorLike {
  status: number
  code: string
  /** The server's English message (or the client's, for a failure that never reached the API). */
  message: string
}

const GATEWAY_STATUSES = new Set([502, 503, 504])

/**
 * The user-facing message of a failed request, in the UI language (F10-6).
 *
 * - English: the server's own message. It is written for end users (§8.2) and is often more
 *   specific than the code ("A department with this name already exists." for CONFLICT); the
 *   English catalog holds the same default texts.
 * - Arabic: the catalog's text for the error code; a gateway page (no API answer) says the
 *   service is unavailable. A code the catalog does not know falls back to the server's message.
 */
export function errorMessage(error: ErrorLike): string {
  if (currentLanguage() === 'en') return error.message
  if (error.code === 'UNEXPECTED_RESPONSE' && GATEWAY_STATUSES.has(error.status)) return i18n.t('unavailable', { ns: 'errors' })
  if (isCatalogErrorCode(error.code)) return i18n.t(`codes.${error.code}`, { ns: 'errors' })
  return error.message
}

/** For anything thrown that is not an API error. */
export function fallbackErrorMessage(): string {
  return i18n.t('fallback', { ns: 'errors' })
}
