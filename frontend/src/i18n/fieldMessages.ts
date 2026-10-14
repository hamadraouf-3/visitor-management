import type { FieldCodeEntry } from '../api/client'
import type { FieldErrorCode } from '../types/api'
import { catalogText } from './catalogText'
import { currentLanguage, type Language } from './index'

/*
 * The per-field errors of a 422 VALIDATION_ERROR. The server sends, for each field path, a message
 * written in English for people (`details.fields`) and a stable code with its parameters
 * (`details.field_codes`, backend B10-18: `{code: 'too_long', params: {max: 500}}`).
 *
 * - English: the server's own message, as for whole errors (F10-6): it is written for people and is
 *   sometimes more specific than its code ("Email address is too long." is `too_long`).
 * - Arabic: the `errors:fieldCodes.<code>` text, filled with the code's parameters. A code the
 *   catalog does not know (a newer server) or a field without a code (an older one) keeps the
 *   server's words, so nothing is ever hidden.
 *
 * Until B10-18 the Arabic text was found by matching the English wording, which broke silently on
 * any rewording; the codes replace that table.
 */

/** The parameter that selects a counted code's plural form (i18next's `count`). */
const COUNTED_BY: Partial<Record<FieldErrorCode, string>> = {
  too_short: 'min',
  too_long: 'max',
  too_few_items: 'min',
  too_many_items: 'max',
  visit_too_long: 'max_hours',
  too_far_ahead: 'max_days',
  range_too_long: 'max_days',
  too_many_reinvitations: 'count',
  placeholder_repeated: 'max',
}

/**
 * Values a text needs that the server does not send as parameters: Latin words an Arabic text may
 * not hold (`catalogs.test.ts`), such as the example of a variable as a text writes it. A parameter
 * of the same name from the server wins.
 */
const OWN_VALUES: Partial<Record<FieldErrorCode, Readonly<Record<string, string>>>> = {
  invalid_placeholder: { example: '{visitor_name}' },
}

/** The catalog's values for a code's parameters: lists joined, the counting one as `count`. */
export function fieldCodeValues(entry: FieldCodeEntry, language: Language): Record<string, string | number> {
  const values: Record<string, string | number> = { ...OWN_VALUES[entry.code as FieldErrorCode] }
  for (const [name, value] of Object.entries(entry.params)) {
    values[name] = Array.isArray(value) ? value.join(language === 'ar' ? '، ' : ', ') : value
  }
  const counter = COUNTED_BY[entry.code as FieldErrorCode]
  if (counter !== undefined) {
    const count = Number(entry.params[counter])
    if (Number.isFinite(count)) values.count = count
  }
  return values
}

/** A field error of a 422 in the UI language (see the note above). */
export function translateFieldError(message: string, entry: FieldCodeEntry | undefined, language: Language = currentLanguage()): string {
  if (language === 'en' || entry === undefined) return message
  const values = fieldCodeValues(entry, language)
  // A counted code whose count did not arrive would show its "other" form with no number: keep the server's words.
  if (COUNTED_BY[entry.code as FieldErrorCode] !== undefined && values.count === undefined) return message
  return catalogText('errors', `fieldCodes.${entry.code}`, { lng: language, ...values }) ?? message
}
