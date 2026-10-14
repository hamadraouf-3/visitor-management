import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router'
import { postLoginPath, safeNextPath } from '../../auth/redirect'
import { useAuth } from '../../auth/useAuth'
import { useSignIn } from '../../auth/useSessionActions'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { PasswordInput } from '../../components/ui/PasswordInput'
import { useFormErrors } from '../../hooks/useFormErrors'
import { withCompany } from '../../identity/links'
import { useIdentity } from '../../identity/useIdentity'
import { paths } from '../../paths'
import type { ServerFieldPaths } from '../../utils/forms'
import { validateLogin, type LoginValues } from './validation'

const SERVER_FIELDS: ServerFieldPaths<keyof LoginValues> = { email: 'email', password: 'password' }

/**
 * Sign-in form; continues to a safe `?next=` page or the role's landing page once signed in. On a
 * company's sign-in page the link to the password reset keeps the company (`?c={slug}`, Phase 12).
 */
export function LoginForm() {
  const { t } = useTranslation('auth')
  const { me } = useAuth()
  const { linkSlug } = useIdentity()
  const [searchParams] = useSearchParams()
  const next = safeNextPath(searchParams.get('next'))
  const signIn = useSignIn()
  const [values, setValues] = useState<LoginValues>({ email: '', password: '' })
  const form = useFormErrors(signIn.error, { fields: SERVER_FIELDS })

  // Signed in (already, or just now): continue to the requested page or the role's landing page.
  if (me && !signIn.isPending) return <Navigate to={postLoginPath(me, next)} replace />

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateLogin(values))) return
    signIn.mutate({ email: values.email.trim(), password: values.password })
  }

  return (
    <Card>
      <h1 className="text-2xl font-bold text-fg">{t('signIn.title')}</h1>

      {form.formError && (
        <Alert tone="danger" className="mt-4">
          {form.formError}
        </Alert>
      )}

      <form noValidate onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <Field label={t('signIn.email')} {...form.field('email')}>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={values.email}
            onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
          />
        </Field>
        <Field label={t('signIn.password')} {...form.field('password')}>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            value={values.password}
            onChange={(event) => setValues((current) => ({ ...current, password: event.target.value }))}
          />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={signIn.isPending}>
          {signIn.isPending ? t('signIn.submitting') : t('signIn.submit')}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm">
        {/* 44 px tall on touch screens (padding inside, the same space outside), the layout unchanged. */}
        <Link
          to={withCompany(paths.forgotPassword, linkSlug)}
          className="inline-flex items-center rounded-sm font-medium text-accent-text hover:underline pointer-coarse:-my-3 pointer-coarse:py-3"
        >
          {t('signIn.forgotPassword')}
        </Link>
      </p>
    </Card>
  )
}
