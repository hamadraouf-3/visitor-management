import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router'
import { ForgotPasswordForm } from '../features/auth/ForgotPasswordForm'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useRememberedCompanyAddress } from '../identity/useRememberedCompanyAddress'
import { CenteredLayout } from '../layouts/CenteredLayout'

/**
 * `/forgot-password`, neutral; with `?c={slug}` under that company's identity (Phase 12). On a device
 * that has signed in before, the page without a company leads to its company's, as `/login` does.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation('auth')
  useDocumentTitle(t('forgot.title'))
  const companyAddress = useRememberedCompanyAddress()
  if (companyAddress) return <Navigate to={companyAddress} replace />
  return (
    <CenteredLayout neutralIcon={KeyRound}>
      <ForgotPasswordForm />
    </CenteredLayout>
  )
}
