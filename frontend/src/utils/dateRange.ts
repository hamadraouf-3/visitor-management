import { currentLanguage, i18n, type Language } from '../i18n'
import { formatDateKey, isDateKey } from './datetime'

/**
 * The message for a company-local date range (`YYYY-MM-DD` keys, which compare as text) whose
 * end lies before its start, or null when the range is usable. Shown on the end date, the
 * field the user corrects.
 */
export function dateRangeError(from: string | null, to: string | null, language: Language = currentLanguage()): string | null {
  return from !== null && to !== null && to < from ? i18n.t('dates.rangeEndBeforeStart', { lng: language }) : null
}

/** The chosen range in the app's own date format, e.g. "From Mon, 5 Oct 2026 to Sun, 11 Oct 2026." */
export function dateRangeReadBack(from: string | null, to: string | null, language: Language = currentLanguage()): string | null {
  const start = from && isDateKey(from) ? formatDateKey(from, language) : null
  const end = to && isDateKey(to) ? formatDateKey(to, language) : null
  if (start && end) {
    return start === end
      ? i18n.t('dates.rangeOn', { lng: language, date: start })
      : i18n.t('dates.rangeFromTo', { lng: language, from: start, to: end })
  }
  if (start) return i18n.t('dates.rangeFrom', { lng: language, date: start })
  if (end) return i18n.t('dates.rangeUpTo', { lng: language, date: end })
  return null
}

/** The chosen range as a fact in a header's line of facts (`MetaLine`): the read-back without its full stop. */
export function dateRangeFact(from: string | null, to: string | null, language: Language = currentLanguage()): string | null {
  return dateRangeReadBack(from, to, language)?.replace(/\.$/, '') ?? null
}
