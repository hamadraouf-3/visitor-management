import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { AccessDenied } from '../components/app/StatusScreens'
import { landingPath } from './roles'
import { useAuth } from './useAuth'

/**
 * The Visitor Journey's guard (Phase 15): its pages exist for a company only while the platform owner allows
 * its visitor tracking (`Me.company.tracking_allowed`). Otherwise the person is sent to their own landing page,
 * as a role guard does (cosmetic: the server answers what the company may do). Inside `RequireRole`.
 */
export function RequireTrackingAllowed({ children }: { children?: ReactNode }) {
  const { me } = useAuth()
  const location = useLocation()
  if (!me) return null
  if (me.company.tracking_allowed) return children ?? <Outlet />
  const home = landingPath(me.user.roles)
  // Never redirect to the page that just refused (would loop).
  if (home === location.pathname) return <AccessDenied />
  return <Navigate to={home} replace />
}
