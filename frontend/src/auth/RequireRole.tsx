import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { AccessDenied } from '../components/app/StatusScreens'
import type { Role } from '../types/api'
import { hasAnyRole, landingPath } from './roles'
import { useAuth } from './useAuth'

interface RequireRoleProps {
  /** Any one of these roles grants access. */
  roles: readonly Role[]
  children?: ReactNode
}

/**
 * Role guard (cosmetic: the backend enforces every permission). Users without a matching
 * role are sent to their own landing page. Must be rendered inside RequireAuth.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const { me } = useAuth()
  const location = useLocation()
  if (!me) return null

  if (hasAnyRole(me.user.roles, roles)) return children ?? <Outlet />

  const home = landingPath(me.user.roles)
  // Never redirect to the page that just denied access (would loop).
  if (home === location.pathname) return <AccessDenied />
  return <Navigate to={home} replace />
}
