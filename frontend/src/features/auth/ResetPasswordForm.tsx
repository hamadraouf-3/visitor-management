import { CircleCheck, Link2Off } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { hasErrorCode } from '../../api/client'
import { useResetPassword } from '../../auth/useSessionActions'
import { Alert } from '../../components/ui/Alert'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { PasswordInput } from '../../components/ui/PasswordInput'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useFormErrors } from '../../hooks/useFormErrors'
import { signInPathFor, withCompany } from '../../identity/links'
import { useIdentity } from '../../identity/useIdentity'
import { paths } from '../../paths'
import type { ServerFieldPaths } from '../../utils/forms'
import { PasswordRequirements } from './PasswordRequirements'
import { validateNewPasswordForm, type NewPasswordValues } from './validation'

const SERVER_FIELDS: ServerFieldPaths<keyof NewPasswordValues> = { newPassword: 'new_password', confirmPassword: [] }

export interface ResetPasswordFormProps {
  /** Token captured from the link fragment by the route loader; null when missing or malformed. */
  token: string | null
}

/**
 * Chooses a new password with a reset link. A missing token or one the server rejects
 * (INVALID_RESET_TOKEN) shows the invalid-link state with a way to request a new link.
 */
export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const { t } = useTranslation('auth')
  const [values, setValues] = useState<NewPasswordValues>({ newPassword: '', confirmPassword: '' })
  const reset = useResetPassword()
  // The link names its company (`?c={slug}`, Phase 12): the ways on from here keep it.
  const { linkSlug } = useIdentity()
  const form = useFormErrors(reset.error, { fields: SERVER_FIELDS })
  const invalid = !token || hasErrorCode(reset.error, 'INVALID_RESET_TOKEN')
  // The document title names what the page shows, as its heading does.
  useDocumentTitle(invalid ? t('reset.invalidTitle') : reset.isSuccess ? t('reset.doneTitle') : t('reset.title'))

  if (invalid) {
    return (
      <EmptyState
        icon={Link2Off}
        headingLevel="h1"
        title={t('reset.invalidTitle')}
        action={<ButtonLink to={withCompany(paths.forgotPassword, linkSlug)}>{t('reset.requestNewLink')}</ButtonLink>}
      />
    )
  }

  if (reset.isSuccess) {
    return (
      <EmptyState
        icon={CircleCheck}
        headingLevel="h1"
        title={t('reset.doneTitle')}
        action={<ButtonLink to={signInPathFor(linkSlug)}>{t('reset.signIn')}</ButtonLink>}
      />
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateNewPasswordForm(values))) return
    reset.mutate({ token, new_password: values.newPassword })
  }

  return (
    <Card>
      <h1 className="text-2xl font-bold text-fg">{t('reset.title')}</h1>

      {form.formError && (
        <Alert tone="danger" className="mt-4">
          {form.formError}
        </Alert>
      )}

      <form noValidate onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <Field label={t('reset.newPassword')} {...form.field('newPassword')}>
          <PasswordInput
            name="new-password"
            autoComplete="new-password"
            value={values.newPassword}
            onChange={(event) => setValues((current) => ({ ...current, newPassword: event.target.value }))}
          />
        </Field>
        <PasswordRequirements password={values.newPassword} />
        <Field label={t('reset.confirmPassword')} {...form.field('confirmPassword')}>
          <PasswordInput
            name="confirm-password"
            autoComplete="new-password"
            value={values.confirmPassword}
            onChange={(event) => setValues((current) => ({ ...current, confirmPassword: event.target.value }))}
          />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={reset.isPending}>
          {t('reset.submit')}
        </Button>
      </form>
    </Card>
  )
}
