import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { PasswordInput } from '../../components/ui/PasswordInput'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useFormErrors } from '../../hooks/useFormErrors'
import { CenteredLayout } from '../../layouts/CenteredLayout'
import type { ServerFieldPaths } from '../../utils/forms'
import { validateLogin, type LoginValues } from '../auth/validation'
import { PlatformLanguageSwitcher, PlatformTag } from './PlatformChrome'
import { postPlatformLoginPath, safePlatformNextPath } from './platformRedirect'
import { usePlatformAuth } from './usePlatformAuth'
import { usePlatformSignIn } from './usePlatformSessionActions'

const SERVER_FIELDS: ServerFieldPaths<keyof LoginValues> = { email: 'email', password: 'password' }

/**
 * /platform/login: the platform owner's sign-in (Phase 11), the product's lockup labelled
 * "Platform". A company session does not count here (another principal); there is no
 * forgot-password for platform accounts (an operator resets them with the CLI, B11-8).
 */
export function PlatformLoginPage() {
  const { t } = useTranslation('platform')
  useDocumentTitle(t('signIn.title'))
  const { me } = usePlatformAuth()
  const [searchParams] = useSearchParams()
  const next = safePlatformNextPath(searchParams.get('next'))
  const signIn = usePlatformSignIn()
  const [values, setValues] = useState<LoginValues>({ email: '', password: '' })
  const form = useFormErrors(signIn.error, { fields: SERVER_FIELDS })

  if (me && !signIn.isPending) return <Navigate to={postPlatformLoginPath(me, next)} replace />

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateLogin(values))) return
    signIn.mutate({ email: values.email.trim(), password: values.password })
  }

  return (
    <CenteredLayout eyebrow={<PlatformTag surface="page" />} languageSwitch={<PlatformLanguageSwitcher />}>
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
              dir="ltr"
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
      </Card>
    </CenteredLayout>
  )
}
