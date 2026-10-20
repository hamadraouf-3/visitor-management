import { i18n } from '../../i18n'
import type { Visit } from '../../types/api'
import { formatDateAtTime } from '../../utils/datetime'
import { textWithParts, type TextPart } from '../../utils/text'
import { sameVisitorName } from '../visitors/visitorFields'

type Invitation = Visit['invitation']

const t = i18n.getFixedT(null, 'visits')

function recipient(invitation: Invitation): TextPart {
  return invitation.to_email ? { email: invitation.to_email } : t('invitationText.theVisitor')
}

/**
 * FAILED because the calendar invitation that followed the latest invitation did not arrive, while the
 * invitation itself, with the pass, went out or is on its way (`calendar_failed`, Phase 14): worded as
 * the calendar invitation's, never as a visitor without a pass. A resend sends both again.
 */
export function calendarInvitationFailed(invitation: Invitation): boolean {
  return invitation.status === 'FAILED' && invitation.calendar_failed
}

/**
 * The success view's page title: the outcome that holds whatever happens to the email (the
 * visit exists and its pass works), or that the visit was cancelled from the view. The card
 * below names the visitor; the invitation's state is the status line under the name.
 */
export function inviteSuccessTitle(visit: Visit): string {
  return visit.status === 'CANCELLED' ? t('inviteSuccess.titleCancelled') : t('inviteSuccess.titleScheduled')
}

/** The new visitor's details as the host typed them (inline visitor of the create request). */
export interface TypedVisitor {
  fullName: string
  email: string | null
}

/**
 * After an inline reuse (D-05) of a stored visitor whose name differs from the one typed
 * (compared as the server folds names): who the visit is really for, and the way out. The
 * stored name is the visit's own snapshot, which the view shows anyway, so nothing else about
 * the stored visitor is revealed (§7.5). Null when no visitor was reused or the names agree.
 */
export function reusedVisitorMismatch(typed: TypedVisitor | null, reused: boolean, visit: Visit): TextPart[] | null {
  if (!reused || !typed || sameVisitorName(typed.fullName, visit.visitor.full_name)) return null
  const address: TextPart = typed.email ? { email: typed.email } : t('invitationText.theAddressYouEntered')
  return textWithParts((markers) => t('invitationText.reusedMismatch', { ...markers, typed: typed.fullName, stored: visit.visitor.full_name }), {
    address,
  })
}

/**
 * The cancelled visit's banner line about the cancellation email (`Visit.last_notice`): sent,
 * being sent, failed (so the host must tell the visitor), or none at all.
 */
export function cancellationNoticeText(visit: Visit): TextPart[] {
  const notice = visit.last_notice?.kind === 'VISIT_CANCELLED' ? visit.last_notice : null
  if (!notice) return [t('invitationText.cancellationNotEmailed')]
  const parts = { email: { email: notice.to_email } }
  switch (notice.status) {
    case 'SENT':
      return textWithParts((markers) => t('invitationText.cancellationSent', markers), parts)
    case 'PENDING':
      return textWithParts((markers) => t('invitationText.cancellationPending', markers), parts)
    case 'FAILED':
      return textWithParts((markers) => t('invitationText.cancellationFailed', markers), parts)
  }
}

/**
 * One sentence about the invitation's state, for a polite live region. It states what the
 * server reports: SENT means the email provider accepted the message, not that it reached the
 * inbox, so it says "sent", never "delivered".
 */
export function invitationStatusText(invitation: Invitation, pollingStopped: boolean): TextPart[] {
  const parts = { recipient: recipient(invitation) }
  switch (invitation.status) {
    case 'NOT_SENT':
      return [t('invitationText.noInvitationSent')]
    case 'PENDING':
      return pollingStopped
        ? textWithParts((markers) => t('invitationText.statusStillSending', markers), parts)
        : textWithParts((markers) => t('invitationText.statusSending', markers), parts)
    case 'SENT':
      return textWithParts((markers) => t('invitationText.statusSent', markers), parts)
    case 'FAILED':
      return calendarInvitationFailed(invitation)
        ? textWithParts((markers) => t('invitationText.statusCalendarFailed', markers), parts)
        : textWithParts((markers) => t('invitationText.statusFailed', markers), parts)
  }
}

/**
 * The visit page's invitation summary, one line: "Sent to x on Mon, 5 Oct 2026 at 20:01."
 * `visitorHasNoEmail` turns NOT_SENT into the reason (only known to callers who manage the visit).
 */
export function invitationSummaryText(invitation: Invitation, timeZone: string, visitorHasNoEmail: boolean): TextPart[] {
  const parts = { recipient: recipient(invitation) }
  switch (invitation.status) {
    case 'SENT': {
      const sentAt = invitation.sent_at
      return sentAt
        ? textWithParts((markers) => t('invitationText.summarySentOn', { ...markers, when: formatDateAtTime(sentAt, timeZone) }), parts)
        : textWithParts((markers) => t('invitationText.summarySent', markers), parts)
    }
    case 'FAILED':
      return calendarInvitationFailed(invitation)
        ? textWithParts((markers) => t('invitationText.statusCalendarFailed', markers), parts)
        : textWithParts((markers) => t('invitationText.summaryFailed', markers), parts)
    case 'PENDING':
      return textWithParts((markers) => t('invitationText.summaryPending', markers), parts)
    case 'NOT_SENT':
      return visitorHasNoEmail ? [t('invitationText.summaryNoEmail')] : [t('invitationText.noInvitationSent')]
  }
}

/**
 * The title of a failed invitation's alert (success view and visit page): "Invitation not delivered to
 * x", or "The calendar invitation did not reach x" when only the calendar invitation failed.
 */
export function invitationFailedTitle(invitation: Invitation): TextPart[] {
  const email = invitation.to_email
  const calendar = calendarInvitationFailed(invitation)
  if (!email) return [calendar ? t('invitationText.calendarFailedTitle') : t('invitationText.failedTitle')]
  return textWithParts((markers) => (calendar ? t('invitationText.calendarFailedTitleTo', markers) : t('invitationText.failedTitleTo', markers)), {
    email: { email },
  })
}

/**
 * Whether the visitor depends on the one-time pass link: no invitation email went out, or it
 * failed. While an invitation is pending or sent, the email carries the QR code; so it does when
 * only the calendar invitation that followed it failed.
 */
export function passIsOnlyChannel(visit: Visit): boolean {
  return visit.invitation.status === 'NOT_SENT' || (visit.invitation.status === 'FAILED' && !calendarInvitationFailed(visit.invitation))
}
