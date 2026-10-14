import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { CheckInMethod, CheckOutMethod, PassRevokeReason, WalkInReason } from '../../types/api'

const t = i18n.getFixedT(null, 'visits')

/*
 * Every label here is read from the catalog when it is read (`lazyTexts`), so it is in the UI
 * language on the next render, as the status labels are (F10-7).
 */

const WALK_IN_REASON_LABELS: Record<WalkInReason, string> = lazyTexts({
  NO_INVITATION: () => t('walkInReasons.NO_INVITATION'),
  EARLY_ARRIVAL: () => t('walkInReasons.EARLY_ARRIVAL'),
  LATE_ARRIVAL: () => t('walkInReasons.LATE_ARRIVAL'),
  LOST_PASS: () => t('walkInReasons.LOST_PASS'),
  DELIVERY: () => t('walkInReasons.DELIVERY'),
  OTHER: () => t('walkInReasons.OTHER'),
})

/** A walk-in reason code in words; free text (the "Other" note) is shown as written. */
export function walkInReasonLabel(reason: string): string {
  return reason in WALK_IN_REASON_LABELS ? WALK_IN_REASON_LABELS[reason as WalkInReason] : reason
}

/*
 * The words for how a visitor was checked in and out, kept here once:
 * - the long form, a phrase for a sentence ("Method: override by reception", the timeline);
 * - the short form, a badge or a value (the history's method badges, the audit log's metadata).
 */

/** How the visitor was checked in, as a phrase (the timeline). */
export const CHECK_IN_METHOD_LABELS: Record<CheckInMethod, string> = lazyTexts({
  QR: () => t('checkInMethods.QR'),
  MANUAL: () => t('checkInMethods.MANUAL'),
  OVERRIDE: () => t('checkInMethods.OVERRIDE'),
  WALK_IN: () => t('checkInMethods.WALK_IN'),
})

/** How the visitor was checked out, as a phrase (the timeline). */
export const CHECK_OUT_METHOD_LABELS: Record<CheckOutMethod, string> = lazyTexts({
  QR: () => t('checkOutMethods.QR'),
  MANUAL: () => t('checkOutMethods.MANUAL'),
  CORRECTED: () => t('checkOutMethods.CORRECTED'),
  BULK: () => t('checkOutMethods.BULK'),
})

/** A check-in or check-out method in a word or two: a badge, a value in a list. */
export const VISIT_METHOD_SHORT_LABELS: Record<CheckInMethod | CheckOutMethod, string> = lazyTexts({
  QR: () => t('methodShort.QR'),
  MANUAL: () => t('methodShort.MANUAL'),
  OVERRIDE: () => t('methodShort.OVERRIDE'),
  WALK_IN: () => t('methodShort.WALK_IN'),
  CORRECTED: () => t('methodShort.CORRECTED'),
  BULK: () => t('methodShort.BULK'),
})

/** Why a pass no longer works, in words (§4 visitor_passes.revoke_reason). */
export const PASS_REVOKE_REASON_LABELS: Record<PassRevokeReason, string> = lazyTexts({
  ROTATED: () => t('passRevokeReasons.ROTATED'),
  VISIT_CANCELLED: () => t('passRevokeReasons.VISIT_CANCELLED'),
  VISIT_COMPLETED: () => t('passRevokeReasons.VISIT_COMPLETED'),
  VISITOR_EMAIL_CHANGED: () => t('passRevokeReasons.VISITOR_EMAIL_CHANGED'),
})
