import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { DateTimeField } from '../../components/ui/DateTimeField'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import { formatDateTime } from '../../utils/datetime'
import { characterCountLabel } from '../../utils/text'
import {
  defaultCheckOutAt,
  REASON_MAX_LENGTH,
  toCorrectedCheckOut,
  validateCorrectedCheckOut,
  type CorrectedCheckOutValues,
} from './checkOutForms'
import { useCheckOut } from './queries'

export interface CorrectCheckOutDialogProps {
  visit: Visit
  timeZone: string
  /** The check-out was saved (called before the dialog closes). */
  onDone: (visit: Visit) => void
  onClose: () => void
}

/**
 * "Correct check-out time" (CORRECTED, §8): checks out a visitor who left without checking out,
 * at the time they actually left, with a required note. Reports leave such check-outs out of
 * the average duration (§5).
 */
export function CorrectCheckOutDialog({ visit, timeZone, onDone, onClose }: CorrectCheckOutDialogProps) {
  const { t } = useTranslation('reception')
  const toast = useToast()
  const checkOut = useCheckOut()
  const [values, setValues] = useState<CorrectedCheckOutValues>(() => ({ checkOutAt: defaultCheckOutAt(visit, Date.now()), note: '' }))
  const form = useFormErrors(checkOut.error, { fields: { checkOutAt: 'check_out_at', note: 'note' } })
  const formId = useStableId('correct-check-out')
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateCorrectedCheckOut(values, visit, Date.now(), timeZone))) return
    checkOut.mutate(
      { visitId: visit.id, body: toCorrectedCheckOut(values) },
      {
        onSuccess: (updated) => {
          toast.show({
            tone: 'success',
            title: t('checkedOut', { name: updated.visitor.full_name }),
            description: updated.check_out_at ? t('correct.recordedFor', { when: formatDateTime(updated.check_out_at, timeZone) }) : undefined,
          })
          onDone(updated)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('correct.title')}
      dismissible={!checkOut.isPending}
      initialFocusRef={noteRef}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={checkOut.isPending} focusableWhenDisabled>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} size="lg" loading={checkOut.isPending}>
            {t('correct.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="flex flex-col gap-1">
          <p className="text-2xl leading-tight font-bold break-words text-fg">{visit.visitor.full_name}</p>
          <p className="text-sm text-fg-muted">
            {t('correct.context', {
            checkIn: visit.check_in_at ? formatDateTime(visit.check_in_at, timeZone) : '—',
              scheduledEnd: formatDateTime(visit.scheduled_end, timeZone),
            })}
          </p>
        </div>
        <DateTimeField
          label={t('correct.leftAt')}
          value={values.checkOutAt}
          onChange={(checkOutAt) => setValues((current) => ({ ...current, checkOutAt }))}
          timeZone={timeZone}
          stepMinutes={5}
          readBack
          required
          {...form.field('checkOutAt')}
        />
        <Field
          label={t('correct.note')}
          required
          hint={characterCountLabel(values.note, REASON_MAX_LENGTH)}
          {...form.field('note')}
        >
          <Textarea
            ref={noteRef}
            rows={2}
            value={values.note}
            onChange={(event) => setValues((current) => ({ ...current, note: event.target.value }))}
          />
        </Field>
      </form>
    </Dialog>
  )
}
