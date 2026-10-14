import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import { useDepartmentName } from '../../i18n/departmentName'
import type { Department } from '../../types/api'
import {
  conflictField,
  DEPARTMENT_FIELDS,
  departmentFormValues,
  toDepartmentCreate,
  toDepartmentUpdate,
  validateDepartment,
  type DepartmentField,
  type DepartmentFormValues,
} from './departmentForm'
import { useCreateDepartment, useUpdateDepartment } from './queries'

export interface DepartmentNameDialogProps {
  /** The department to rename; omitted to create one. */
  department?: Department
  /** Every department (inactive ones included), to catch a duplicate name before sending. */
  departments: readonly Department[]
  onClose: () => void
}

/**
 * Create a department or rename one: its name (the default, English one) and its Arabic name, which
 * the Arabic UI shows when it is set (phase 10 shared contract B). A rename updates the names on
 * scheduled visits too (D-17).
 */
export function DepartmentNameDialog({ department, departments, onClose }: DepartmentNameDialogProps) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const departmentName = useDepartmentName()
  const create = useCreateDepartment()
  const update = useUpdateDepartment()
  const mutation = department ? update : create
  const [values, setValues] = useState<DepartmentFormValues>(() => departmentFormValues(department))
  // A 409 names the field whose name is taken (`details.field`, "name" or "name_ar").
  const form = useFormErrors(mutation.error, { fields: DEPARTMENT_FIELDS, codes: { CONFLICT: conflictField(mutation.error) } })
  const formId = useStableId('department-name')

  const set = (key: DepartmentField, value: string) => setValues((current) => ({ ...current, [key]: value }))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateDepartment(values, departments, department))) return
    const done = (saved: Department) => {
      const name = departmentName(saved)
      // "Renamed to …" when the name people see changed; a change to the other language's name only is "… saved".
      let title = t('departments.created', { name })
      if (department) title = name !== departmentName(department) ? t('departments.renamed', { name }) : t('departments.saved', { name })
      toast.show({ tone: 'success', title })
      onClose()
    }
    if (!department) {
      create.mutate(toDepartmentCreate(values), { onSuccess: done })
      return
    }
    const body = toDepartmentUpdate(department, values)
    if (!body) onClose()
    else update.mutate({ id: department.id, body }, { onSuccess: done })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={department ? t('departments.renameNamed', { name: departmentName(department) }) : t('departments.add')}
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending} focusableWhenDisabled>
            {t('departments.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={mutation.isPending}>
            {department ? t('departments.rename') : t('departments.add')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label={t('departments.name')} required {...form.field('name')}>
          <Input autoComplete="off" value={values.name} onChange={(event) => set('name', event.target.value)} />
        </Field>
        {/* Typed in Arabic: right to left whatever the UI language, as the company's Arabic name. */}
        <Field label={t('departments.nameAr')} optional {...form.field('nameAr')}>
          <Input dir="rtl" lang="ar" autoComplete="off" value={values.nameAr} onChange={(event) => set('nameAr', event.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}
