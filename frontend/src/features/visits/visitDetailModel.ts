import { i18n } from '../../i18n'
import type { Visit } from '../../types/api'
import { calendarInvitationFailed } from './invitationText'
import { visitorHasEmail } from './visitEdit'

const t = i18n.getFixedT(null, 'visits')

/*
 * What the visit page offers, derived from the visit alone. The server decides through
 * `visit.permissions` (B24-30); these rules only choose how the allowed actions are presented,
 * so the page never infers rights from roles. VisitDetail.tsx maps the results to dialogs,
 * icons and layout.
 */

export type VisitActionId = 'edit' | 'resend' | 'cancel'

export interface VisitHeaderAction {
  id: VisitActionId
  label: string
  tone: 'default' | 'danger'
}

/** Whether the visit is over (cancelled, completed or a no-show): nothing about it can change any more. */
export function isFinishedVisit(visit: Visit): boolean {
  return visit.status !== 'SCHEDULED' && visit.status !== 'CHECKED_IN'
}

/** A scheduled visit whose invitation email failed: the page leads with the failure and its ways out. */
export function hasFailedInvitation(visit: Visit): boolean {
  return visit.status === 'SCHEDULED' && visit.invitation.status === 'FAILED'
}

/**
 * The caller manages the visit but the visitor has no email address on file: the server grants
 * `can_resend` exactly when there is one (see `visitorHasEmail`), and `can_edit` to whoever
 * manages a SCHEDULED visit.
 */
export function visitorHasNoEmailOnFile(visit: Visit): boolean {
  return visit.permissions.can_edit && !visitorHasEmail(visit)
}

/**
 * Whether the page offers to correct the visitor's email address (and so loads the visitor to
 * learn whether the caller may edit them): after a failed invitation, or for a visitor without
 * an address who was never invited ("Add an email address"). Not when only the calendar
 * invitation failed: the invitation itself went to the same address, so the address is no
 * reason to doubt (the resend sends both again).
 */
export function wantsVisitorCorrection(visit: Visit): boolean {
  return (
    (visit.invitation.status === 'FAILED' && !calendarInvitationFailed(visit.invitation)) ||
    (visitorHasNoEmailOnFile(visit) && visit.invitation.status === 'NOT_SENT')
  )
}

/**
 * Whether the host can get a new one-time pass link to share themselves (POST /visits/{id}/pass,
 * offered on the pass card): the caller manages the scheduled visit (`can_edit`, the server's
 * own rule for that endpoint) and no invitation email carries the pass, because none was
 * requested or the visitor has no address. Without it, a host who left the success view before
 * sharing the first link had no way to give the visitor a QR code.
 */
export function canIssuePassLink(visit: Visit): boolean {
  return visit.permissions.can_edit && (visit.invitation.status === 'NOT_SENT' || !visitorHasEmail(visit))
}

/**
 * The header's actions, as the visit's permissions allow them, in display order. A failed
 * invitation's resend lives in the failure banner, next to its explanation, so it is not
 * offered twice; "Send invitation" replaces "Resend" when none was sent yet.
 */
export function visitHeaderActions(visit: Visit): VisitHeaderAction[] {
  const { permissions } = visit
  const actions: VisitHeaderAction[] = []
  if (permissions.can_edit) actions.push({ id: 'edit', label: t('detail.actions.edit'), tone: 'default' })
  if (permissions.can_resend && visit.invitation.status !== 'FAILED') {
    const label = visit.invitation.status === 'NOT_SENT' ? t('detail.actions.sendInvitation') : t('detail.actions.resendInvitation')
    actions.push({ id: 'resend', label, tone: 'default' })
  }
  if (permissions.can_cancel) actions.push({ id: 'cancel', label: t('detail.actions.cancel'), tone: 'danger' })
  return actions
}

/**
 * The invitation card's title. Once the visit is cancelled or a no-show, the invitation is
 * history: "Original invitation", with its badge in a neutral tone, so a green "Sent" does not
 * read as if the visit were still on.
 */
export function invitationCardTitle(visit: Visit): string {
  return isOriginalInvitation(visit) ? t('detail.invitation.originalTitle') : t('detail.invitation.title')
}

/** The invitation of a visit that did not take place: shown as history (see `invitationCardTitle`). */
export function isOriginalInvitation(visit: Visit): boolean {
  return visit.status === 'CANCELLED' || visit.status === 'NO_SHOW'
}
