import type { LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
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
  /**
   * Offered only while the platform owner allows the company's visitor tracking (`Me.company.tracking_allowed`,
   * Phase 15): the Visitor Journey and visitor tracking's administration.
   */
  requiresTracking?: boolean
  /**
   * A count at the end of the entry (Phase 16: the tracking alerts' active count), drawn by the feature: a
   * component that reads its own data and renders nothing when there is nothing to count. It renders a
   * `NavBadge` (layouts/NavBadge), which carries the count's words for assistive technology.
   */
  badge?: ComponentType
}

/**
 * Something a feature runs in the company shell on every page (Phase 16: the tracking alerts' watcher, which
 * polls and notifies). Mounted once by `AppLayout` for the people its roles (and tracking) allow, never while a
 * password change is required; renders nothing of its own on the page.
 */
export interface ShellExtension {
  /** A name, for React's key. */
  id: string
  component: ComponentType
  roles: readonly Role[]
  /** Only while the company's tracking is allowed, as `NavEntry.requiresTracking`. */
  requiresTracking?: boolean
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
  /** Run in the company shell (Phase 16). */
  shell?: ShellExtension[]
}
