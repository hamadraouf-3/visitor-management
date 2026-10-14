import { i18n } from '../../i18n'
import type { Visit, VisitCancelRequest, VisitUpdate } from '../../types/api'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'
import { isBlankText } from '../../utils/text'
import { PURPOSE_MAX_LENGTH } from './inviteForm'
import { endForNewStart, validateSchedule } from './schedule'

const t = i18n.getFixedT(null, 'visits')

/* ------------------------------------------------------------------------------------------ */
/* Which emails a change sends                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Whether the visitor has an email address on file. The visit carries no address, but the
 * server grants `can_resend` exactly when the caller manages the SCHEDULED visit and the
 * visitor has one (B24-30), and the edit and cancel dialogs are offered only to such callers
 * (`can_edit` = `can_cancel` = managing a SCHEDULED visit). Meaningful only in that context.
 */
export function visitorHasEmail(visit: Visit): boolean {
  return visit.permissions.can_resend
}

/**
 * Whether the server emails the visitor notices about this visit (reschedule, cancellation):
 * only when an invitation was requested for it and the visitor has an address (B24-25,
 * B24-70). A requested invitation always leaves an invitation status other than NOT_SENT.
 */
function visitorGetsNotices(visit: Visit): boolean {
  return visitorHasEmail(visit) && visit.invitation.status !== 'NOT_SENT'
}


/**
 * Whether a new date or time is normally emailed to the visitor (VISIT_RESCHEDULED, B24-25).
 * Even then the server leaves the email out once a reschedule-notice budget is spent (B24-70:
 * 3 per visit and hour, RESCHEDULE_NOTICE_DAILY_LIMIT per user and day) and saves the change
 * anyway. Before saving that cannot be known, so the dialog never promises every change; after
 * saving, the response's `last_notice` tells (`rescheduleEmailOutcome`).
 */
export function rescheduleEmailsVisitor(visit: Visit): boolean {
  return visitorGetsNotices(visit)
}

/*
 * Every reschedule promise carries an exception (B24-70 budgets, see `rescheduleEmailsVisitor`):
 * "except after several changes in a short time", in the catalog's sentences.
 */

/**
 * Whether a cancellation can be emailed to the visitor (VISIT_CANCELLED). The server ignores
 * `notify_visitor` for a visit whose invitation was never requested (B24-70), so the choice is
 * offered only when this holds.
 */
export function cancelEmailsVisitor(visit: Visit): boolean {
  return visitorGetsNotices(visit)
}

/** Whether the visit's latest notice is a reschedule email still queued: what a reschedule that emails leaves behind. */
function hasQueuedRescheduleNotice(visit: Visit): boolean {
  return visit.last_notice?.kind === 'VISIT_RESCHEDULED' && visit.last_notice.status === 'PENDING'
}

/**
 * What became of the email about a reschedule, read from the PATCH response (`after`): a
 * notice the server queues is still PENDING in the response, because delivery runs after it.
 * - `none-expected`: the visit gets no notices (`rescheduleEmailsVisitor`).
 * - `queued`: the response's latest notice is a pending reschedule email, and the visit had
 *   none pending before, so this change queued it.
 * - `omitted`: no pending reschedule email: a notice budget was spent (B24-70).
 * - `unknown`: an earlier change's email was still pending, so the two cannot be told apart.
 */
export type RescheduleEmailOutcome = 'none-expected' | 'queued' | 'omitted' | 'unknown'

export function rescheduleEmailOutcome(before: Visit, after: Visit): RescheduleEmailOutcome {
  if (!rescheduleEmailsVisitor(before)) return 'none-expected'
  if (!hasQueuedRescheduleNotice(after)) return 'omitted'
  return hasQueuedRescheduleNotice(before) ? 'unknown' : 'queued'
}

export interface ChangeConfirmation {
  tone: 'success' | 'warning'
  /** What became of the email; none when it cannot be told (the toast's title alone). */
  description?: string
}

/**
 * The confirmation after a reschedule: says the visitor is emailed only when the response shows it.
 * When it cannot be told (`unknown`) the toast is its title alone: pointing at the timeline was a note,
 * not an outcome (decision 3).
 */
export function rescheduledConfirmation(before: Visit, after: Visit): ChangeConfirmation {
  switch (rescheduleEmailOutcome(before, after)) {
    case 'none-expected':
      return { tone: 'success', description: t('edit.rescheduledNoEmail') }
    case 'queued':
      return { tone: 'success', description: t('edit.rescheduledQueued') }
    case 'omitted':
      return { tone: 'warning', description: t('edit.rescheduledLeftOut') }
    case 'unknown':
      return { tone: 'success' }
  }
}

/**
 * The cancel dialog's line when no email can go out (it then offers no notify choice), so the
 * host knows the visitor is not told; null otherwise. A fact, not the reason (decision 3).
 */
export function cancelNoEmailNotice(visit: Visit): string | null {
  return cancelEmailsVisitor(visit) ? null : t('cancel.notEmailed')
}

/**
 * The confirmation after a cancellation (`after` the response): says the visitor is emailed only
 * when the response's latest notice is the cancellation email (a visit is cancelled once, so such
 * a notice can only come from this request), and otherwise that they were not notified.
 */
export function cancelledMessage(after: Visit): string {
  return after.last_notice?.kind === 'VISIT_CANCELLED' ? t('cancel.doneNotifying') : t('cancel.doneNotNotified')
}

/* ------------------------------------------------------------------------------------------ */
/* Edit / reschedule (PATCH /visits/{id})                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface VisitEditValues {
  purpose: string
  /** '' = no department. */
  departmentId: string
  start: string | null
  end: string | null
}

export type VisitEditField = 'purpose' | 'department' | 'start' | 'end'

export function editValuesFromVisit(visit: Visit): VisitEditValues {
  return {
    purpose: visit.purpose,
    departmentId: visit.department?.id ?? '',
    start: visit.scheduled_start,
    end: visit.scheduled_end,
  }
}

/** A new start keeps the visit's length, as on the invite form. */
export function withEditedStart(values: VisitEditValues, start: string | null): VisitEditValues {
  return { ...values, start, end: endForNewStart(values, start) }
}

function sameInstant(a: string | null, b: string): boolean {
  return a !== null && Date.parse(a) === Date.parse(b)
}

export function scheduleChanged(values: VisitEditValues, visit: Visit): boolean {
  return !sameInstant(values.start, visit.scheduled_start) || !sameInstant(values.end, visit.scheduled_end)
}

export function validateVisitEdit(values: VisitEditValues, visit: Visit, now: number): FormErrors<VisitEditField> {
  const errors: FormErrors<VisitEditField> = {}
  const purpose = values.purpose.trim()
  if (isBlankText(purpose)) errors.purpose = t('invite.purposeRequired')
  else if (purpose.length > PURPOSE_MAX_LENGTH) errors.purpose = maxLengthMessage(PURPOSE_MAX_LENGTH)
  // As on the server (B24-24): the schedule rules apply to a changed schedule only, so a visit
  // under way can still get a new purpose; "not in the past" applies to a changed start only,
  // while a moved end must not lie in the past. A cleared field counts as a change.
  if (scheduleChanged(values, visit)) {
    Object.assign(errors, validateSchedule(values, { now, checkStartInFuture: !sameInstant(values.start, visit.scheduled_start) }))
  }
  return errors
}

/**
 * Only what changed (PATCH semantics): an unchanged schedule is not sent, so editing the purpose
 * does not email the visitor. Clearing the department sends `null`. Call after validation.
 */
export function toVisitUpdate(values: VisitEditValues, visit: Visit): VisitUpdate {
  const update: VisitUpdate = {}
  const purpose = values.purpose.trim()
  if (purpose !== visit.purpose) update.purpose = purpose
  if (values.departmentId !== (visit.department?.id ?? '')) update.department_id = values.departmentId || null
  if (values.start && !sameInstant(values.start, visit.scheduled_start)) update.scheduled_start = values.start
  if (values.end && !sameInstant(values.end, visit.scheduled_end)) update.scheduled_end = values.end
  return update
}

/* ------------------------------------------------------------------------------------------ */
/* Cancel (POST /visits/{id}/cancel)                                                           */
/* ------------------------------------------------------------------------------------------ */

export const CANCEL_REASON_MAX_LENGTH = 300

export interface CancelValues {
  reason: string
  notifyVisitor: boolean
}

export function validateCancel(values: CancelValues): FormErrors<'reason'> {
  return values.reason.trim().length > CANCEL_REASON_MAX_LENGTH ? { reason: maxLengthMessage(CANCEL_REASON_MAX_LENGTH) } : {}
}

/** The reason is optional and left out when blank; the notification choice is always explicit. */
export function toCancelRequest(values: CancelValues): VisitCancelRequest {
  const reason = values.reason.trim()
  return { ...(reason ? { reason } : {}), notify_visitor: values.notifyVisitor }
}
