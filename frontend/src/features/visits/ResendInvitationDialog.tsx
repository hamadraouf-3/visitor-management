import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { TextWithEmails } from '../../components/ui/EmailText'
import { useToast } from '../../components/ui/toastContext'
import { useStableId } from '../../hooks/useStableId'
import type { Visit, VisitResendResult } from '../../types/api'
import { textWithParts } from '../../utils/text'
import { calendarInvitationFailed } from './invitationText'
import { useResendInvitation } from './queries'

export interface ResendInvitationDialogProps {
  visit: Visit
  onClose: () => void
  /**
   * The resend went out: the result carries the new one-time pass link, or null when only the calendar
   * invitation was sent again, the pass kept.
   */
  onResent: (result: VisitResendResult) => void
  /**
   * Offered when the last invitation failed and the visitor's address may be corrected: the
   * likely fix is a new address, not the same one again. Closes this dialog and opens the
   * visitor's details (the server re-sends to a new address by itself, D-19).
   */
  onCorrectEmail?: () => void
}

/**
 * Confirms a resend (POST /visits/{id}/invitation). Resending rotates the pass (D-10): the
 * QR code the visitor already has stops working, so the dialog says so before anything happens.
 *
 * When only the calendar invitation had failed (`calendar_failed`, Phase 14), the resend sends that one
 * alone and the pass stays (B14-31): the dialog is about the calendar invitation, with no word of a new
 * pass or QR code, and a toast says it is being sent (no new pass to show).
 */
export function ResendInvitationDialog({ visit, onClose, onResent, onCorrectEmail }: ResendInvitationDialogProps) {
  const { t } = useTranslation('visits')
  const toast = useToast()
  const resend = useResendInvitation(visit.id)
  const previous = visit.invitation.to_email
  const failed = visit.invitation.status === 'FAILED'
  // Only the calendar invitation failed: the invitation reached the address, and a resend sends both again.
  const calendarFailed = calendarInvitationFailed(visit.invitation)
  const offerCorrection = failed && !calendarFailed && onCorrectEmail !== undefined
  const failedId = useStableId('resend-failed')
  const warningId = useStableId('resend-warning')

  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={calendarFailed ? t('resend.titleCalendar') : failed ? t('resend.titleFailed') : t('resend.title')}
      // Announced with the title: why it is sent again (a failure) and what stops working, if anything does.
      describedBy={calendarFailed ? (previous ? failedId : undefined) : failed && previous ? `${failedId} ${warningId}` : warningId}
      dismissible={!resend.isPending}
      // Three actions with long labels need the wide panel to share one row (they wrap otherwise).
      size={offerCorrection ? 'lg' : 'md'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={resend.isPending} focusableWhenDisabled>
            {calendarFailed ? t('resend.notNow') : t('resend.keep')}
          </Button>
          <Button
            variant={offerCorrection ? 'secondary' : 'primary'}
            loading={resend.isPending}
            onClick={() =>
              resend.mutate(undefined, {
                onSuccess: (result) => {
                  if (result.pass_url === null) {
                    toast.show({
                      tone: 'success',
                      title: previous ? t('resend.calendarSendingTo', { email: previous }) : t('resend.calendarSending'),
                    })
                  }
                  onResent(result)
                },
              })
            }
          >
            {calendarFailed ? t('failure.resendCalendar') : offerCorrection ? t('failure.resendSame') : t('failure.resend')}
          </Button>
          {offerCorrection && (
            <Button onClick={onCorrectEmail} disabled={resend.isPending} focusableWhenDisabled>
              {t('failure.correctAndResend')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {resend.isError && (
          <Alert tone="danger">
            <ApiErrorMessage error={resend.error} />
          </Alert>
        )}
        {failed && previous && (
          <p id={failedId} className="text-sm text-fg">
            <TextWithEmails
              parts={
                calendarFailed
                  ? textWithParts((markers) => t('invitationText.statusCalendarFailed', markers), { recipient: { email: previous } })
                  : textWithParts((markers) => t('resend.lastFailed', markers), { email: { email: previous } })
              }
            />
          </p>
        )}
        {/* The one sentence a destructive confirmation keeps: what stops working. A calendar invitation
            sent again alone replaces nothing. */}
        {!calendarFailed && <Alert id={warningId} tone="warning" title={t('rotation.title')} />}
        {!failed && previous && (
          <p className="text-sm text-fg-muted">
            <TextWithEmails parts={textWithParts((markers) => t('resend.lastWentTo', markers), { email: { email: previous } })} />
          </p>
        )}
      </div>
    </Dialog>
  )
}
