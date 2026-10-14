import type { LucideIcon } from 'lucide-react'
import type { RouteObject } from 'react-router'
import type { Role } from '../types/api'

export type NavSection = 'main' | 'insights' | 'admin'

export interface NavEntry {
  to: string
  label: string
  icon: LucideIcon
  /** Shown to users holding any of these roles (cosmetic; the backend enforces). */
  roles: readonly Role[]
  section: NavSection
  /** Sort key within the whole navigation. */
  order: number
  /** Active only on an exact match (e.g. /visits must not stay active on /visits/new). */
  end?: boolean
}

/**
 * What a feature contributes to the app. Each feature owns its `routes.tsx`; `router.tsx`
 * only composes them (§3.2-10).
 */
export interface FeatureModule {
  /** Routes outside authentication (rendered without the app layout). */
  publicRoutes?: RouteObject[]
  /** Routes inside RequireAuth + AppLayout; each guards its own roles. */
  routes?: RouteObject[]
  nav?: NavEntry[]
}
