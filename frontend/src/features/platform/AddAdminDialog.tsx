import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { rateLimitWaitSeconds } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { PlatformCompanyAdmin } from '../../types/api'
import { formatWaitDuration } from '../../utils/duration'
import { TemporaryPasswordField } from '../admin/TemporaryPasswordField'
import { ADMIN_CODES, ADMIN_FIELDS, EMPTY_ADMIN, toAdminCreate, validateAdminValues, type AdminValues } from './companyForm'
import { useCreateCompanyAdmin } from './queries'
import { TemporaryPasswordReveal } from './TemporaryPasswordReveal'

export interface AddAdminDialogProps {
  companyId: string
  /** Whether the company is active: an administrator of a deactivated one cannot sign in yet, and the confirmation says so. */
  companyActive: boolean
  onClose: () => void
}

/**
 * Another administrator of a company (POST /platform/companies/{id}/admins): a SYSTEM_ADMIN with a
 * temporary password (D-11), shown once more after the account exists, as for "Add user".
 */
export function AddAdminDialog({ companyId, companyActive, onClose }: AddAdminDialogProps) {
  const { t } = useTranslation('platform')
  const create = useCreateCompanyAdmin(companyId)
  const [values, setValues] = useState<AdminValues>(EMPTY_ADMIN)
  const [created, setCreated] = useState<{ admin: PlatformCompanyAdmin; temporaryPassword: string } | null>(null)
  const form = useFormErrors<keyof AdminValues>(create.error, { fields: ADMIN_FIELDS, codes: ADMIN_CODES })
  const formId = useStableId('add-admin')
  const passwordRef = useRef<HTMLInputElement>(null)
  // Too many addresses were refused (429, B11-42): the form says how long to wait, from `Retry-After`.
  const wait = rateLimitWaitSeconds(create.error)
  const formError = wait !== null ? t('form.limited', { duration: formatWaitDuration(wait) }) : form.formError
  const set = <K extends keyof AdminValues>(key: K, value: AdminValues[K]) => {
    const next = { ...values, [key]: value }
    setValues(next)
    if (form.attempted) form.refresh(validateAdminValues(next))
  }

  if (created) {
    return (
      <Dialog
        open
        onClose={onClose}
        initialFocusRef={passwordRef}
        title={t('created.adminTitle')}
        description={t('created.description')}
        footer={<Button onClick={onClose}>{t('created.done')}</Button>}
      >
        <TemporaryPasswordReveal
          fullName={created.admin.full_name}
          email={created.admin.email}
          temporaryPassword={created.temporaryPassword}
          companyActive={companyActive}
          passwordRef={passwordRef}
        />
      </Dialog>
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateAdminValues(values))) return
    create.mutate(toAdminCreate(values), { onSuccess: (admin) => setCreated({ admin, temporaryPassword: values.temporaryPassword }) })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('company.admins.add')}
      size="lg"
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending} focusableWhenDisabled>
            {t('form.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            {t('form.addAdmin')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('form.fullName')} required {...form.field('fullName')}>
            <Input autoComplete="off" value={values.fullName} onChange={(event) => set('fullName', event.target.value)} />
          </Field>
          <Field label={t('form.email')} required {...form.field('email')}>
            <Input type="email" inputMode="email" autoComplete="off" spellCheck={false} dir="ltr" value={values.email} onChange={(event) => set('email', event.target.value)} />
          </Field>
        </div>
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
