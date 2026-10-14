import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/useAuth'
import { PageHeader } from '../components/ui/PageHeader'
import { ChangePasswordForm } from '../features/auth/ChangePasswordForm'

/** Forced (temporary or expired password, §7.2) or voluntary password change. */
export function ChangePasswordPage() {
  const { t } = useTranslation('auth')
  const { user } = useAuth()
  if (!user) return null
  return (
    <div className="max-w-xl">
      <PageHeader title={t('change.title')} />
      <ChangePasswordForm user={user} />
    </div>
  )
}
