import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import { characterCountLabel } from '../../utils/text'
import { formatVisitDateRange } from './format'
import { useCancelVisit } from './queries'
import {
  CANCEL_REASON_MAX_LENGTH,
  cancelEmailsVisitor,
  cancelledMessage,
  cancelNoEmailNotice,
  toCancelRequest,
  validateCancel,
  type CancelValues,
} from './visitEdit'

export interface CancelVisitDialogProps {
  visit: Visit
  timeZone: string
  onClose: () => void
  /** After the dialog closed on a successful cancellation, with the cancelled visit. */
  onCancelled?: (visit: Visit) => void
}

/**
 * Confirms a cancellation (POST /visits/{id}/cancel): who and when, and one sentence on what it
 * does (the QR code stops working); an optional reason with its length, the visitor notified by
 * default. The choice is offered only when the server would send the email: the visitor has an
 * address and an invitation was requested for the visit (`cancelEmailsVisitor`); otherwise one
 * line says the visitor is not emailed.
 */
export function CancelVisitDialog({ visit, timeZone, onClose, onCancelled }: CancelVisitDialogProps) {
  const { t } = useTranslation('visits')
  const toast = useToast()
  const cancel = useCancelVisit(visit.id)
  const canNotify = cancelEmailsVisitor(visit)
  const noEmailNotice = cancelNoEmailNotice(visit)
  const [values, setValues] = useState<CancelValues>({ reason: '', notifyVisitor: canNotify })
  const form = useFormErrors(cancel.error, { fields: { reason: 'reason' } })
  const formId = useStableId('cancel-visit')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateCancel(values))) return
    const body = toCancelRequest(values)
    cancel.mutate(body, {
      onSuccess: (cancelled) => {
        toast.show({ tone: 'success', title: t('cancel.doneTitle'), description: cancelledMessage(cancelled) })
        onClose()
        onCancelled?.(cancelled)
      },
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={t('cancel.title')}
      description={t('cancel.description', { name: visit.visitor.full_name, when: formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone) })}
      dismissible={!cancel.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={cancel.isPending} focusableWhenDisabled>
            {t('cancel.keep')}
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={cancel.isPending}>
            {t('cancel.confirm')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label={t('cancel.reason')} optional hint={characterCountLabel(values.reason, CANCEL_REASON_MAX_LENGTH)} {...form.field('reason')}>
          <Textarea rows={2} value={values.reason} onChange={(event) => setValues((current) => ({ ...current, reason: event.target.value }))} />
        </Field>
        {canNotify ? (
          <Checkbox
            label={t('cancel.notify')}
            checked={values.notifyVisitor}
            onChange={(event) => setValues((current) => ({ ...current, notifyVisitor: event.target.checked }))}
          />
        ) : (
          <p className="text-sm font-medium text-fg-secondary">{noEmailNotice}</p>
        )}
      </form>
    </Dialog>
  )
}
