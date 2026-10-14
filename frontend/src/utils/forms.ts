import { getErrorMessage, getFieldErrorCodes, getFieldErrors, isApiError, type ApiError } from '../api/client'
import { currentLanguage, i18n, type Language } from '../i18n'
import { translateFieldError } from '../i18n/fieldMessages'

/** Messages per form field; a field without a message is valid. */
export type FormErrors<K extends string> = Partial<Record<K, string>>

export function hasErrors(errors: FormErrors<string>): boolean {
  return Object.values(errors).some(Boolean)
}

/** The message for text longer than a field allows (the server enforces the same limits). */
export function maxLengthMessage(max: number, language: Language = currentLanguage()): string {
  return i18n.t('text.maxLength', { lng: language, count: max })
}

/**
 * Where the server reports each form field: the `details.fields` path(s) of a 422
 * VALIDATION_ERROR (§8.2), e.g. `{ newPassword: 'new_password', visitorEmail: 'visitor.email' }`.
 * Declare every field the form shows, also those the server never reports, so the field is known.
 */
export type ServerFieldPaths<K extends string> = Record<K, string | readonly string[]>

/** Error codes that describe one field rather than the whole form, e.g. INVALID_CURRENT_PASSWORD. */
export type FieldErrorCodes<K extends string> = Partial<Record<ApiError['code'], K>>

export interface ServerFormErrors<K extends string> {
  /** Server messages shown on the form's fields. */
  fieldErrors: FormErrors<K>
  /** Everything else, for the form-level alert; null when the fields already show the whole error. */
  formError: string | null
}

const NO_SERVER_ERRORS = { fieldErrors: {}, formError: null } as const

/**
 * Splits a failed request into field messages and a form-level message. Field paths the form
 * does not show (e.g. `body` for a model-level rule) go to the form-level message, so no
 * server message is ever dropped.
 */
export function resolveServerErrors<K extends string>(
  error: unknown,
  paths: ServerFieldPaths<K>,
  codes: FieldErrorCodes<K> = {},
): ServerFormErrors<K> {
  if (!error) return NO_SERVER_ERRORS

  const codeField = isApiError(error) ? codes[error.code] : undefined
  if (codeField !== undefined) return { fieldErrors: { [codeField]: getErrorMessage(error) } as FormErrors<K>, formError: null }

  const fieldByPath = new Map<string, K>()
  for (const field of Object.keys(paths) as K[]) {
    const fieldPaths = paths[field]
    for (const path of typeof fieldPaths === 'string' ? [fieldPaths] : fieldPaths) fieldByPath.set(path, field)
  }

  const fieldErrors: FormErrors<K> = {}
  const unattributed: string[] = []
  const fieldCodes = getFieldErrorCodes(error)
  for (const [path, serverMessage] of Object.entries(getFieldErrors(error))) {
    // The server's English message, or in Arabic the catalog's text for its code (B10-18).
    const message = translateFieldError(serverMessage, fieldCodes[path])
    const field = fieldByPath.get(path)
    if (field === undefined) {
      if (!unattributed.includes(message)) unattributed.push(message)
    } else {
      fieldErrors[field] ??= message
    }
  }

  if (unattributed.length > 0) return { fieldErrors, formError: unattributed.join(' ') }
  if (hasErrors(fieldErrors)) return { fieldErrors, formError: null }
  return { fieldErrors, formError: getErrorMessage(error) }
}

/** Client-side messages win: they describe what is in the field now. */
export function mergeFormErrors<K extends string>(fields: readonly K[], client: FormErrors<K>, server: FormErrors<K>): FormErrors<K> {
  const merged: FormErrors<K> = {}
  for (const field of fields) {
    const message = client[field] || server[field]
    if (message) merged[field] = message
  }
  return merged
}

/** Fields with a message, in the given order. */
export function invalidFields<K extends string>(fields: readonly K[], errors: FormErrors<K>): K[] {
  return fields.filter((field) => Boolean(errors[field]))
}
