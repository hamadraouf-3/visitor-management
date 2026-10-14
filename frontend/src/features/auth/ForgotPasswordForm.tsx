import { MailCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useRequestPasswordReset } from '../../auth/useSessionActions'
import { Alert } from '../../components/ui/Alert'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useFormErrors } from '../../hooks/useFormErrors'
import { signInPathFor } from '../../identity/links'
import { useIdentity } from '../../identity/useIdentity'
import { useLanguage } from '../../i18n/useLanguage'
import type { ServerFieldPaths } from '../../utils/forms'
import { validateEmailForm, type EmailValues } from './validation'

const SERVER_FIELDS: ServerFieldPaths<keyof EmailValues> = { email: 'email' }

/**
 * Requests a reset link. The confirmation is identical for every address whether or not an
 * account exists (no account oracle, §7.2); the typed address is never echoed. In English it is
 * the server's message (the server owns the wording, including how long the link stays valid);
 * in Arabic the catalog's translation of it. The catalog's English text is only for a 202 without
 * the documented `message` (e.g. a proxy that dropped the body).
 */
export function ForgotPasswordForm() {
  const { t } = useTranslation('auth')
  const { language } = useLanguage()
  // Back to the sign-in page the person came from: the company's own when the address names one.
  const signIn = signInPathFor(useIdentity().linkSlug)
  const [values, setValues] = useState<EmailValues>({ email: '' })
  const request = useRequestPasswordReset()
  const form = useFormErrors(request.error, { fields: SERVER_FIELDS })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateEmailForm(values))) return
    request.mutate(values.email.trim())
  }

  if (request.isSuccess) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-success-surface text-success-solid">
            <MailCheck aria-hidden="true" className="size-6" />
          </span>
          <h1 className="text-2xl font-bold text-fg">{t('forgot.sentTitle')}</h1>
          <p className="text-sm text-fg-muted">{(language === 'en' && request.data?.message?.trim()) || t('forgot.sentFallback')}</p>
          <ButtonLink to={signIn} variant="secondary" fullWidth className="mt-2">
            {t('forgot.backToSignIn')}
          </ButtonLink>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <h1 className="text-2xl font-bold text-fg">{t('forgot.title')}</h1>

      {form.formError && (
        <Alert tone="danger" className="mt-4">
          {form.formError}
        </Alert>
      )}

      <form noValidate onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <Field label={t('forgot.email')} {...form.field('email')}>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={values.email}
            onChange={(event) => setValues({ email: event.target.value })}
          />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={request.isPending}>
          {t('forgot.submit')}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm">
        {/* 44 px tall on touch screens (padding inside, the same space outside), the layout unchanged. */}
        <Link
          to={signIn}
          className="inline-flex items-center rounded-sm font-medium text-accent-text hover:underline pointer-coarse:-my-3 pointer-coarse:py-3"
        >
          {t('forgot.backToSignIn')}
        </Link>
      </p>
    </Card>
  )
}
