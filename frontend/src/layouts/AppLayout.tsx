import type { ReactNode } from 'react'
import { hasAnyRole } from '../auth/roles'
import type { Me, Role } from '../types/api'
import { useAuth } from '../auth/useAuth'
import { IdentityLockup } from '../components/app/IdentityLockup'
import { LanguageSwitcher } from '../components/app/LanguageSwitcher'
import type { NavEntry, ShellExtension } from '../features/types'
import { ShellFrame } from './ShellFrame'
import { useShellSurface } from './shellSurface'
import { UserMenu } from './UserMenu'

interface AppLayoutProps {
  /** Every feature's navigation entries; filtered here by the user's roles. */
  navigation: readonly NavEntry[]
  /** Every feature's shell extensions (Phase 16: the tracking alerts' watcher); filtered as the entries are. */
  extensions?: readonly ShellExtension[]
  children?: ReactNode
}

/** Offered to this person: their roles allow it, and the company's tracking is allowed where it needs that. */
function offered(me: Me, entry: { roles: readonly Role[]; requiresTracking?: boolean }): boolean {
  return hasAnyRole(me.user.roles, entry.roles) && (!entry.requiresTracking || me.company.tracking_allowed)
}

/**
 * Authenticated shell of a company's users, direction C: a shell in the company's colour (the
 * product's teal when it has none) around the light content area, drawn by `ShellFrame`.
 *
 * - Desktop (lg+): the sidebar opens with the appearance toggle and the language switch (Phase 13)
 *   over the company's identity (its logo for dark surfaces, its logo on a white plate, or its name
 *   as a wordmark: Phase 12), then the navigation, and the user block at its foot.
 * - Tablet/mobile: the top bar and the navigation drawer, in the same colour.
 * - The shell is the company's own colour: a light one (a yellow, a pastel) is a light surface under
 *   dark ink, and everything on it follows that ink (`identity/tokens.ts`).
 * - A route whose `handle` asks for the dark surface (`DARK_SURFACE_HANDLE`, the reception
 *   tablet) gets the deep shell and dark tokens for the page and its dialogs (`data-surface`).
 *
 * The Visitor Journey's entries (`requiresTracking`) are offered only while the platform owner allows the
 * company's tracking (Phase 15). The features' shell extensions (Phase 16: the tracking alerts' watcher) run
 * under the same rule.
 *
 * While a password change is required the navigation is hidden (every other endpoint answers 403
 * until then); the language and the appearance can still be switched.
 */
export function AppLayout({ navigation, extensions = [], children }: AppLayoutProps) {
  const { me } = useAuth()
  const surface = useShellSurface()

  if (!me) return null

  const entries = me.user.must_change_password ? [] : navigation.filter((entry) => offered(me, entry))
  const running = me.user.must_change_password ? [] : extensions.filter((extension) => offered(me, extension))

  return (
    <>
      <ShellFrame
      entries={entries}
      // The deep shell around a dark screen, so it is dark from edge to edge; the coloured shell otherwise.
      shellTheme={surface === 'dark' ? 'theme-shell-deep' : 'theme-shell'}
      darkSurface={surface === 'dark'}
      renderLockup={(size) => <IdentityLockup surface="shell" size={size} deepShell={surface === 'dark'} className={size === 'sm' ? 'ms-1' : undefined} />}
      languageSwitch={<LanguageSwitcher />}
      renderUserMenu={(placement) => <UserMenu user={me.user} company={me.company} placement={placement} />}
      >
        {children}
      </ShellFrame>
      {/* Keyed by the person: a new session starts each extension afresh (what it has seen, what it said). */}
      {running.map(({ id, component: Extension }) => (
        <Extension key={`${id}:${me.user.id}`} />
      ))}
    </>
  )
}
