import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { CheckOutRequest, Visit } from '../../types/api'
import { formatDateTime } from '../../utils/datetime'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'
import { isBlankText } from '../../utils/text'
import { bulkCheckOutAt } from './visitActions'

const t = i18n.getFixedT(null, 'reception')

/** Override reasons, correction notes and bulk check-out reasons are `varchar(300)` (§4, §8.1). */
export const REASON_MAX_LENGTH = 300

/** A required reason or note: trimmed, 1–300 characters. */
export function validateReason(text: string, emptyMessage: string): string | undefined {
  const value = text.trim()
  if (isBlankText(value)) return emptyMessage
  if (value.length > REASON_MAX_LENGTH) return maxLengthMessage(REASON_MAX_LENGTH)
  return undefined
}

/** The messages of the reason fields, in the UI language when read. */
export const REASON_MESSAGES = lazyTexts({
  overrideRequired: () => t('override.reasonRequired'),
  staleRequired: () => t('stale.reasonRequired'),
  correctionRequired: () => t('correct.noteRequired'),
})

/** Quick picks for "Check in anyway" (the reason stays editable), in the UI language when read. */
export const OVERRIDE_REASONS = lazyTexts({
  late: () => t('override.reasons.late'),
  early: () => t('override.reasons.early'),
  noPass: () => t('override.reasons.noPass'),
})

/**
 * The common reasons offered for an override of this visit: the arrival that applies (early
 * while the pass is not valid yet, late otherwise, also for a no-show), then a missing pass.
 * The arrival that does not apply is left out, so it cannot be picked by mistake.
 */
export function overrideReasonSuggestions(visit: Pick<Visit, 'status' | 'window_start'>, now: number): string[] {
  const early = visit.status === 'SCHEDULED' && now < Date.parse(visit.window_start)
  return [early ? OVERRIDE_REASONS.early : OVERRIDE_REASONS.late, OVERRIDE_REASONS.noPass]
}

export interface CorrectedCheckOutValues {
  /** UTC instant the visitor left, or null while the date is incomplete. */
  checkOutAt: string | null
  note: string
}

export type CorrectedCheckOutField = keyof CorrectedCheckOutValues

/**
 * The default time the visitor left: the scheduled end (the most likely departure of someone
 * who left without checking out), never before the check-in and never in the future. The same
 * rule the bulk check-out of previous days applies (B57-16).
 */
export function defaultCheckOutAt(visit: Visit, now: number): string {
  return new Date(bulkCheckOutAt(visit, now)).toISOString()
}

export function validateCorrectedCheckOut(
  values: CorrectedCheckOutValues,
  visit: Visit,
  now: number,
  timeZone: string,
): FormErrors<CorrectedCheckOutField> {
  const errors: FormErrors<CorrectedCheckOutField> = {}
  if (!values.checkOutAt) {
    errors.checkOutAt = t('correct.leftAtRequired')
  } else {
    const leftAt = Date.parse(values.checkOutAt)
    if (visit.check_in_at && leftAt < Date.parse(visit.check_in_at)) {
      errors.checkOutAt = t('correct.leftAtBeforeCheckIn', { when: formatDateTime(visit.check_in_at, timeZone) })
    } else if (leftAt > now) {
      errors.checkOutAt = t('correct.leftAtFuture')
    }
  }
  const note = validateReason(values.note, REASON_MESSAGES.correctionRequired)
  if (note) errors.note = note
  return errors
}

export function toCorrectedCheckOut(values: CorrectedCheckOutValues): CheckOutRequest {
  if (!values.checkOutAt) throw new Error('toCorrectedCheckOut needs a validated form')
  return { method: 'CORRECTED', check_out_at: values.checkOutAt, note: values.note.trim() }
}
