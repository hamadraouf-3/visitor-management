import type { UseMutationResult } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { landingPath } from '../../auth/roles'
import { useChangePassword } from '../../auth/useSessionActions'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field } from '../../components/ui/Field'
import { PasswordInput } from '../../components/ui/PasswordInput'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import type { ChangePasswordRequest, Me } from '../../types/api'
import type { FieldErrorCodes, ServerFieldPaths } from '../../utils/forms'
import { PasswordRequirements } from './PasswordRequirements'
import { validateChangePassword, type ChangePasswordValues } from './validation'

const EMPTY: ChangePasswordValues = { currentPassword: '', newPassword: '', confirmPassword: '' }

const SERVER_FIELDS: ServerFieldPaths<keyof ChangePasswordValues> = {
  currentPassword: 'current_password',
  newPassword: 'new_password',
  confirmPassword: [],
}
const FIELD_CODES: FieldErrorCodes<keyof ChangePasswordValues> = { INVALID_CURRENT_PASSWORD: 'currentPassword' }

export interface ChangePasswordFormProps {
  user: Me['user']
}

/**
 * Forced (temporary or expired password, §7.2) or voluntary password change of a company's user.
 * After a forced change the user continues to their landing page; a voluntary change stays on the page.
 */
export function ChangePasswordForm({ user }: ChangePasswordFormProps) {
  const change = useChangePassword()
  return <PasswordChangeForm account={user} change={change} forcedNext={landingPath(user.roles)} />
}

export interface PasswordChangeFormProps {
  /** The account: its e-mail address (the new password must differ from it) and whether the change is forced. */
  account: { email: string; must_change_password: boolean }
  /** The session's own change (the company's `POST /auth/change-password`, the platform owner's `/platform/auth/change-password`). */
  change: UseMutationResult<void, Error, ChangePasswordRequest>
  /** Where a forced change continues. */
  forcedNext: string
}

/** The password change form, for either principal (Phase 11: the platform owner uses it too). */
export function PasswordChangeForm({ account, change, forcedNext }: PasswordChangeFormProps) {
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const toast = useToast()
  const [values, setValues] = useState<ChangePasswordValues>(EMPTY)
  const form = useFormErrors(change.error, { fields: SERVER_FIELDS, codes: FIELD_CODES })

  const forced = account.must_change_password

  const update = (field: keyof ChangePasswordValues) => (value: string) => setValues((current) => ({ ...current, [field]: value }))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateChangePassword(values, account.email))) return
    change.mutate(
      { current_password: values.currentPassword, new_password: values.newPassword },
      {
        onSuccess: () => {
          setValues(EMPTY)
          toast.show({ tone: 'success', title: t('change.changedTitle') })
          if (forced) navigate(forcedNext, { replace: true })
        },
      },
    )
  }

  return (
    <>
      {forced && (
        <Alert tone="warning" title={t('change.forcedTitle')} className="mb-6" />
      )}
      <Card>
        {form.formError && (
          <Alert tone="danger" className="mb-4">
            {form.formError}
          </Alert>
        )}
        <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label={t('change.currentPassword')} {...form.field('currentPassword')}>
            <PasswordInput
              name="current-password"
              autoComplete="current-password"
              value={values.currentPassword}
              onChange={(event) => update('currentPassword')(event.target.value)}
            />
          </Field>
          <Field label={t('change.newPassword')} {...form.field('newPassword')}>
            <PasswordInput
              name="new-password"
              autoComplete="new-password"
              value={values.newPassword}
              onChange={(event) => update('newPassword')(event.target.value)}
            />
          </Field>
          <PasswordRequirements password={values.newPassword} email={account.email} />
          <Field label={t('change.confirmPassword')} {...form.field('confirmPassword')}>
            <PasswordInput
              name="confirm-password"
              autoComplete="new-password"
              value={values.confirmPassword}
              onChange={(event) => update('confirmPassword')(event.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" loading={change.isPending}>
              {t('change.submit')}
            </Button>
          </div>
        </form>
      </Card>
    </>
  )
}
