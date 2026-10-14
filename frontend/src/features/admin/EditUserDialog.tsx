import { Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { Dialog } from '../../components/ui/Dialog'
import { EmailText } from '../../components/ui/EmailText'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { User } from '../../types/api'
import type { FieldErrorCodes } from '../../utils/forms'
import { DepartmentSelect } from '../visits/pickers'
import { useUpdateUser } from './queries'
import { RoleCheckboxes } from './RoleCheckboxes'
import {
  cancelledVisitsMessage,
  cancelsHostedVisits,
  selfEditLocks,
  toUserUpdate,
  USER_EDIT_FIELDS,
  userEditValues,
  validateUserEdit,
  type UserEditValues,
} from './userForm'

type EditField = keyof UserEditValues

export interface EditUserDialogProps {
  user: User
  /** The signed-in administrator: their own administrator role and activity cannot be changed here. */
  currentUserId: string
  onClose: () => void
}

/**
 * Edit an account (PATCH /users/{id}): name, phone, department, roles and whether it is
 * active. Only changed fields are sent. The dialog never offers self-demotion or
 * self-deactivation; it warns before a change that cancels the person's scheduled hosted
 * visits (D-18) and reports how many were cancelled.
 */
export function EditUserDialog({ user, currentUserId, onClose }: EditUserDialogProps) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const isSelf = user.id === currentUserId
  const update = useUpdateUser(user.id, isSelf)
  const [values, setValues] = useState<UserEditValues>(() => userEditValues(user))
  const locks = selfEditLocks(user, currentUserId)
  const deactivating = user.is_active && !values.isActive
  const cancelsVisits = cancelsHostedVisits(user, values)
  // LAST_ADMIN concerns whichever change would leave no active administrator.
  const codes: FieldErrorCodes<EditField> = { LAST_ADMIN: deactivating ? 'isActive' : 'roles' }
  const form = useFormErrors(update.error, { fields: USER_EDIT_FIELDS, codes })
  const formId = useStableId('edit-user')
  const activeId = form.field('isActive').id

  const set = <K extends EditField>(key: K, value: UserEditValues[K]) => setValues((current) => ({ ...current, [key]: value }))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateUserEdit(values))) return
    const body = toUserUpdate(user, values)
    if (!body) {
      onClose()
      return
    }
    update.mutate(body, {
      onSuccess: (updated) => {
        toast.show({ tone: 'success', title: deactivating ? t('users.editDialog.deactivated', { name: updated.full_name }) : t('users.editDialog.saved') })
        if (updated.cancelled_visits) {
          toast.show({
            tone: 'info',
            title: t('users.editDialog.visitsCancelledTitle'),
            description: cancelledVisitsMessage(updated.full_name, updated.cancelled_visits),
          })
        }
        onClose()
      },
    })
  }

  const submitLabel = deactivating
    ? t('users.editDialog.deactivate')
    : cancelsVisits
      ? t('users.editDialog.saveAndCancel')
      : t('users.editDialog.save')
  const activeError = form.field('isActive').error

  return (
    <Dialog
      open
      onClose={onClose}
      title={isSelf ? t('users.editDialog.titleSelf') : t('users.editNamed', { name: user.full_name })}
      // Which account this is: its sign-in address (data; it cannot be changed here).
      description={<EmailText address={user.email} />}
      size="lg"
      dismissible={!update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending} focusableWhenDisabled>
            {t('users.editDialog.discard')}
          </Button>
          <Button type="submit" form={formId} variant={cancelsVisits ? 'danger' : 'primary'} loading={update.isPending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-5">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('users.form.fullName')} required className="sm:col-span-2" {...form.field('fullName')}>
            <Input autoComplete="off" value={values.fullName} onChange={(event) => set('fullName', event.target.value)} />
          </Field>
          <Field label={t('users.form.phone')} optional {...form.field('phone')}>
            <Input type="tel" inputMode="tel" autoComplete="off" value={values.phone} onChange={(event) => set('phone', event.target.value)} />
          </Field>
          <Field label={t('users.form.department')} optional {...form.field('departmentId')}>
            <DepartmentSelect value={values.departmentId} current={user.department} markInactive onChange={(departmentId) => set('departmentId', departmentId)} />
          </Field>
        </div>

        <RoleCheckboxes
          id={form.field('roles').id}
          error={form.field('roles').error}
          value={values.roles}
          onChange={(roles) => set('roles', roles)}
          locked={locks.adminRole ? { role: 'SYSTEM_ADMIN', reason: t('users.editDialog.ownAdminRole') } : null}
        />

        <div id={activeId} className="flex flex-col gap-1.5">
          <Checkbox
            label={
              locks.active ? (
                <span className="inline-flex items-center gap-1.5">
                  {t('users.editDialog.active')}
                  <Lock aria-hidden="true" data-locked-active="" className="size-4 shrink-0" />
                </span>
              ) : (
                t('users.editDialog.active')
              )
            }
            hiddenDescription={locks.active ? t('users.editDialog.ownAccountActive') : undefined}
            checked={values.isActive}
            disabled={locks.active}
            aria-invalid={activeError ? true : undefined}
            onChange={(event) => set('isActive', event.target.checked)}
          />
          {activeError && (
            <p role="alert" className="text-sm font-medium text-danger-text">
              {activeError}
            </p>
          )}
        </div>

        {cancelsVisits && (
          <Alert tone="warning" role="status" title={t('users.editDialog.cancelsVisitsTitle')}>
            {deactivating
              ? t('users.editDialog.cancelsVisitsDeactivating', { name: user.full_name })
              : t('users.editDialog.cancelsVisitsRoles', { name: user.full_name })}
          </Alert>
        )}
      </form>
    </Dialog>
  )
}
