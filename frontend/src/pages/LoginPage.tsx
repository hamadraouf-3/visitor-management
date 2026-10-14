import { LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router'
import { LoginForm } from '../features/auth/LoginForm'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { COMPANY_PARAM, companySlugOf } from '../identity/links'
import { readRememberedCompany } from '../identity/storage'
import { CenteredLayout } from '../layouts/CenteredLayout'
import { paths } from '../paths'

/**
 * The sign-in page (Phase 12): `/login` is neutral (no logo, no name); `/c/{slug}`, `/c/{slug}/login`
 * and `/login?c={slug}` show that company's identity. On a device that has signed in before,
 * `/login` without a company leads to its company's sign-in page, keeping `?next=`.
 */
export function LoginPage() {
  const { t } = useTranslation('auth')
  useDocumentTitle(t('signIn.title'))
  const location = useLocation()

  if (location.pathname === paths.login && companySlugOf(location) === null) {
    const remembered = readRememberedCompany()
    if (remembered) {
      const parameters = new URLSearchParams(location.search)
      parameters.delete(COMPANY_PARAM)
      const query = parameters.toString()
      return <Navigate to={`${paths.companySignIn(remembered)}${query ? `?${query}` : ''}`} replace />
    }
  }

  return (
    <CenteredLayout neutralIcon={LockKeyhole}>
      <LoginForm />
    </CenteredLayout>
  )
}
