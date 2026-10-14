import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import type { ServerFieldPaths } from '../../utils/forms'
import { characterCountLabel } from '../../utils/text'
import { formatVisitDateRange } from './format'
import { PURPOSE_MAX_LENGTH } from './inviteForm'
import { DepartmentSelect } from './pickers'
import { useUpdateVisit } from './queries'
import { ScheduleFields } from './ScheduleFields'
import {
  editValuesFromVisit,
  rescheduledConfirmation,
  toVisitUpdate,
  validateVisitEdit,
  withEditedStart,
  type VisitEditField,
  type VisitEditValues,
} from './visitEdit'

const SERVER_FIELDS: ServerFieldPaths<VisitEditField> = {
  purpose: 'purpose',
  department: 'department_id',
  start: 'scheduled_start',
  end: 'scheduled_end',
}

export interface EditVisitDialogProps {
  visit: Visit
  timeZone: string
  onClose: () => void
  /** After a saved change, with the updated visit (e.g. to follow a reschedule email). */
  onSaved?: (visit: Visit) => void
}

/** Edit or reschedule a SCHEDULED visit (PATCH /visits/{id}); rescheduling keeps the pass (D-22). */
export function EditVisitDialog({ visit, timeZone, onClose, onSaved }: EditVisitDialogProps) {
  const { t } = useTranslation('visits')
  const toast = useToast()
  const update = useUpdateVisit(visit.id)
  const [values, setValues] = useState<VisitEditValues>(() => editValuesFromVisit(visit))
  const form = useFormErrors(update.error, { fields: SERVER_FIELDS })
  const formId = useStableId('edit-visit')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateVisitEdit(values, visit, Date.now()))) return
    const body = toVisitUpdate(values, visit)
    if (Object.keys(body).length === 0) {
      onClose()
      return
    }
    const rescheduled = body.scheduled_start !== undefined || body.scheduled_end !== undefined
    update.mutate(body, {
      onSuccess: (updated) => {
        if (rescheduled) toast.show({ title: t('edit.rescheduledTitle'), ...rescheduledConfirmation(visit, updated) })
        else toast.show({ tone: 'success', title: t('edit.updatedTitle') })
        onClose()
        onSaved?.(updated)
      },
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('edit.title')}
      description={`${visit.visitor.full_name} · ${formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone)}`}
      dismissible={!update.isPending}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending} focusableWhenDisabled>
            {t('edit.discard')}
          </Button>
          <Button type="submit" form={formId} loading={update.isPending}>
            {t('edit.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <ScheduleFields
          timeZone={timeZone}
          values={values}
          onStartChange={(start) => setValues((current) => withEditedStart(current, start))}
          onEndChange={(end) => setValues((current) => ({ ...current, end }))}
          startField={form.field('start')}
          endField={form.field('end')}
        />
        <Field label={t('invite.department')} optional {...form.field('department')}>
          <DepartmentSelect
            value={values.departmentId}
            onChange={(departmentId) => setValues((current) => ({ ...current, departmentId }))}
            current={visit.department}
          />
        </Field>
        <Field label={t('invite.purpose')} required hint={characterCountLabel(values.purpose, PURPOSE_MAX_LENGTH)} {...form.field('purpose')}>
          <Textarea rows={3} value={values.purpose} onChange={(event) => setValues((current) => ({ ...current, purpose: event.target.value }))} />
        </Field>
      </form>
    </Dialog>
  )
}
