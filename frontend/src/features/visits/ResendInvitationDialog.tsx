import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { TextWithEmails } from '../../components/ui/EmailText'
import { useStableId } from '../../hooks/useStableId'
import type { Visit, VisitCreateResult } from '../../types/api'
import { textWithParts } from '../../utils/text'
import { useResendInvitation } from './queries'

export interface ResendInvitationDialogProps {
  visit: Visit
  onClose: () => void
  /** The new invitation went out; the result carries the new one-time pass link. */
  onResent: (result: VisitCreateResult) => void
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
 */
export function ResendInvitationDialog({ visit, onClose, onResent, onCorrectEmail }: ResendInvitationDialogProps) {
  const { t } = useTranslation('visits')
  const resend = useResendInvitation(visit.id)
  const previous = visit.invitation.to_email
  const failed = visit.invitation.status === 'FAILED'
  const offerCorrection = failed && onCorrectEmail !== undefined
  const failedId = useStableId('resend-failed')
  const warningId = useStableId('resend-warning')

  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={failed ? t('resend.titleFailed') : t('resend.title')}
      // Announced with the title: why it is sent again (a failure) and what stops working.
      describedBy={failed && previous ? `${failedId} ${warningId}` : warningId}
      dismissible={!resend.isPending}
      // Three actions with long labels need the wide panel to share one row (they wrap otherwise).
      size={offerCorrection ? 'lg' : 'md'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={resend.isPending} focusableWhenDisabled>
            {t('resend.keep')}
          </Button>
          <Button
            variant={offerCorrection ? 'secondary' : 'primary'}
            loading={resend.isPending}
            onClick={() => resend.mutate(undefined, { onSuccess: onResent })}
          >
            {offerCorrection ? t('failure.resendSame') : t('failure.resend')}
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
            <TextWithEmails parts={textWithParts((markers) => t('resend.lastFailed', markers), { email: { email: previous } })} />
          </p>
        )}
        {/* The one sentence a destructive confirmation keeps: what stops working. */}
        <Alert id={warningId} tone="warning" title={t('rotation.title')} />
        {!failed && previous && (
          <p className="text-sm text-fg-muted">
            <TextWithEmails parts={textWithParts((markers) => t('resend.lastWentTo', markers), { email: { email: previous } })} />
          </p>
        )}
      </div>
    </Dialog>
  )
}
