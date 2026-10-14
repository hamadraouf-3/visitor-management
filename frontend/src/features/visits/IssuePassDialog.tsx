import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { useStableId } from '../../hooks/useStableId'
import type { Visit, VisitPassResult } from '../../types/api'
import { useIssuePass } from './queries'

export interface IssuePassDialogProps {
  visit: Visit
  onClose: () => void
  /** The new pass was issued; the result carries its one-time link. */
  onIssued: (result: VisitPassResult) => void
}

/**
 * Confirms a new pass link (POST /visits/{id}/pass) for a visitor who gets no invitation email.
 * Issuing rotates the pass (D-10), so the dialog says before anything happens that the previous
 * QR code stops working. No email is sent: the host shares the new link.
 */
export function IssuePassDialog({ visit, onClose, onIssued }: IssuePassDialogProps) {
  const { t } = useTranslation('visits')
  const issue = useIssuePass(visit.id)
  const warningId = useStableId('issue-pass-warning')
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={t('issuePass.title')}
      // Announced with the title: what stops working.
      describedBy={warningId}
      dismissible={!issue.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={issue.isPending} focusableWhenDisabled>
            {t('issuePass.keep')}
          </Button>
          <Button loading={issue.isPending} onClick={() => issue.mutate(undefined, { onSuccess: onIssued })}>
            {t('issuePass.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {issue.isError && (
          <Alert tone="danger">
            <ApiErrorMessage error={issue.error} />
          </Alert>
        )}
        {/* The one sentence a destructive confirmation keeps: what stops working. */}
        <Alert id={warningId} tone="warning" title={t('rotation.title')} />
      </div>
    </Dialog>
  )
}
