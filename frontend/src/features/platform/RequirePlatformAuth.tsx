import { useTranslation } from 'react-i18next'
import { Navigate, Outlet, useLocation } from 'react-router'
import { FullPageLoader, SessionCheckError } from '../../components/app/StatusScreens'
import { paths } from '../../paths'
import { platformLoginPath } from './platformRedirect'
import { usePlatformAuth, usePlatformSessionHeartbeat } from './usePlatformAuth'

/**
 * Gate of every signed-in platform page (Phase 11): without a platform session, the platform
 * sign-in (a company session does not count: it is another principal); while a password change is
 * required, only /platform/change-password. The platform session's heartbeat runs while it is mounted.
 */
export function RequirePlatformAuth() {
  const { t } = useTranslation()
  const { status, me, error, refetch } = usePlatformAuth()
  usePlatformSessionHeartbeat()
  const location = useLocation()

  if (status === 'loading') return <FullPageLoader label={t('app.checkingSession')} />
  if (status === 'error') return <SessionCheckError error={error} onRetry={() => void refetch()} />
  if (!me) return <Navigate to={platformLoginPath(location)} replace />
  if (me.admin.must_change_password && location.pathname !== paths.platformChangePassword) {
    return <Navigate to={paths.platformChangePassword} replace />
  }
  return <Outlet />
}
