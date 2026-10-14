import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { CopyButton } from '../../components/ui/CopyButton'
import { Dialog } from '../../components/ui/Dialog'
import { EmailText } from '../../components/ui/EmailText'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { ReadOnlyField } from '../../components/ui/ReadOnlyField'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { User } from '../../types/api'
import type { FieldErrorCodes } from '../../utils/forms'
import { DepartmentSelect } from '../visits/pickers'
import { useCreateUser } from './queries'
import { RoleCheckboxes } from './RoleCheckboxes'
import { TemporaryPasswordField } from './TemporaryPasswordField'
import { EMPTY_USER_CREATE, toUserCreate, USER_CREATE_FIELDS, validateUserCreate, type UserCreateValues } from './userForm'

type CreateField = keyof UserCreateValues

const FIELD_CODES: FieldErrorCodes<CreateField> = { USER_EMAIL_UNAVAILABLE: 'email' }

/** The account just created and its temporary password: shown once, then gone with the dialog. */
interface Created {
  user: User
  temporaryPassword: string
}

/**
 * The new account's sign-in, shown once: the dialog's one line before closing it loses the
 * password for good (shown once, expires after 72 hours: the user's request 8 allows one short line
 * before an irreversible action), the e-mail address and the temporary password, read-only, with
 * a copy button.
 */
function CreatedView({ created, onDone }: { created: Created; onDone: () => void }) {
  const { t } = useTranslation('admin')
  // The password is what the administrator came for: focused (and selected) on open, ready to copy.
  const passwordRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog
      open
      onClose={onDone}
      initialFocusRef={passwordRef}
      title={t('users.created.title')}
      description={t('users.created.description')}
      footer={<Button onClick={onDone}>{t('users.created.done')}</Button>}
    >
      <div className="flex flex-col gap-4">
        <Alert tone="success" role="status" title={t('users.created.canSignIn', { name: created.user.full_name })} />
        {/* As text that wraps: a read-only input cut a long address off at a phone's width. */}
        <ReadOnlyField label={t('users.form.email')}>
          <EmailText address={created.user.email} />
        </ReadOnlyField>
        <div className="flex flex-col gap-2">
          <Field label={t('users.form.temporaryPassword')}>
            <Input ref={passwordRef} readOnly dir="ltr" value={created.temporaryPassword} className="font-mono" onFocus={(event) => event.target.select()} />
          </Field>
          <CopyButton value={created.temporaryPassword} label={t('users.created.copy')} copiedLabel={t('users.created.copied')} className="self-start" />
        </div>
      </div>
    </Dialog>
  )
}

export interface CreateUserDialogProps {
  onClose: () => void
}

/**
 * New account (POST /users): name, email, phone, roles, department and a temporary password
 * (D-11), which the dialog shows once more after the account exists. The password lives only
 * in this dialog's state and in a mutation that is dropped when the dialog closes.
 */
export function CreateUserDialog({ onClose }: CreateUserDialogProps) {
  const { t } = useTranslation('admin')
  const create = useCreateUser()
  const [values, setValues] = useState<UserCreateValues>(EMPTY_USER_CREATE)
  const [created, setCreated] = useState<Created | null>(null)
  const form = useFormErrors(create.error, { fields: USER_CREATE_FIELDS, codes: FIELD_CODES })
  const formId = useStableId('create-user')

  if (created) return <CreatedView created={created} onDone={onClose} />

  const set = <K extends CreateField>(key: K, value: UserCreateValues[K]) => setValues((current) => ({ ...current, [key]: value }))
  const text = (key: 'fullName' | 'email' | 'phone') => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value),
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateUserCreate(values))) return
    create.mutate(toUserCreate(values), {
      onSuccess: (user) => setCreated({ user, temporaryPassword: values.temporaryPassword }),
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('users.add')}
      size="lg"
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending} focusableWhenDisabled>
            {t('users.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            {t('users.create')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-5">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('users.form.fullName')} required {...form.field('fullName')}>
            <Input autoComplete="off" {...text('fullName')} />
          </Field>
          <Field label={t('users.form.email')} required {...form.field('email')}>
            <Input type="email" inputMode="email" autoComplete="off" spellCheck={false} {...text('email')} />
          </Field>
          <Field label={t('users.form.phone')} optional {...form.field('phone')}>
            <Input type="tel" inputMode="tel" autoComplete="off" {...text('phone')} />
          </Field>
          <Field label={t('users.form.department')} optional {...form.field('departmentId')}>
            <DepartmentSelect value={values.departmentId} onChange={(departmentId) => set('departmentId', departmentId)} />
          </Field>
        </div>
        <RoleCheckboxes
          id={form.field('roles').id}
          error={form.field('roles').error}
          value={values.roles}
          onChange={(roles) => set('roles', roles)}
        />
        <TemporaryPasswordField
          {...form.field('temporaryPassword')}
          value={values.temporaryPassword}
          email={values.email}
          onChange={(password) => set('temporaryPassword', password)}
        />
      </form>
    </Dialog>
  )
}
