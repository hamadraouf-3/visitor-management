import { useTranslation } from 'react-i18next'
import { Navigate, Outlet, useLocation } from 'react-router'
import { FullPageLoader, SessionCheckError } from '../components/app/StatusScreens'
import { paths } from '../paths'
import { loginPath } from './redirect'
import { useAuth, useSessionHeartbeat } from './useAuth'

/**
 * Gate for every authenticated route: unauthenticated users go to /login?next=<here>;
 * users who must change their password can only reach /change-password (§7.2). While it is
 * mounted, the session heartbeat notices a session the server has ended (SEC-50).
 */
export function RequireAuth() {
  const { t } = useTranslation()
  const { status, me, error, refetch } = useAuth()
  useSessionHeartbeat()
  const location = useLocation()

  if (status === 'loading') return <FullPageLoader label={t('app.checkingSession')} />
  if (status === 'error') return <SessionCheckError error={error} onRetry={() => void refetch()} />
  if (!me) return <Navigate to={loginPath(location)} replace />
  if (me.user.must_change_password && location.pathname !== paths.changePassword) {
    return <Navigate to={paths.changePassword} replace />
  }
  return <Outlet />
}
