import { useTranslation } from 'react-i18next'
import { PageHeader } from '../../components/ui/PageHeader'
import { paths } from '../../paths'
import { PasswordChangeForm } from '../auth/ChangePasswordForm'
import { usePlatformAuth } from './usePlatformAuth'
import { usePlatformChangePassword } from './usePlatformSessionActions'

/**
 * /platform/change-password: the forced change of a temporary platform password (an operator's
 * `create-platform-admin`), or a voluntary one. A forced change continues to the companies.
 */
export function PlatformChangePasswordPage() {
  const { t } = useTranslation('platform')
  const { admin } = usePlatformAuth()
  const change = usePlatformChangePassword()
  if (!admin) return null
  return (
    <div className="max-w-xl">
      <PageHeader title={t('changePassword.title')} />
      <PasswordChangeForm account={admin} change={change} forcedNext={paths.platformCompanies} />
    </div>
  )
}
