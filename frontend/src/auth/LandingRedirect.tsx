import { Navigate } from 'react-router'
import { landingPath } from './roles'
import { useAuth } from './useAuth'

/** `/` → the landing page for the user's highest-priority role (§10). */
export function LandingRedirect() {
  const { me } = useAuth()
  if (!me) return null
  return <Navigate to={landingPath(me.user.roles)} replace />
}
