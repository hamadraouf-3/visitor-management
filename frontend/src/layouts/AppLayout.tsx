import type { ReactNode } from 'react'
import { hasAnyRole } from '../auth/roles'
import { useAuth } from '../auth/useAuth'
import { IdentityLockup } from '../components/app/IdentityLockup'
import { LanguageSwitcher } from '../components/app/LanguageSwitcher'
import type { NavEntry } from '../features/types'
import { ShellFrame } from './ShellFrame'
import { useShellSurface } from './shellSurface'
import { UserMenu } from './UserMenu'

interface AppLayoutProps {
  /** Every feature's navigation entries; filtered here by the user's roles. */
  navigation: readonly NavEntry[]
  children?: ReactNode
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
 * company's tracking (Phase 15).
 *
 * While a password change is required the navigation is hidden (every other endpoint answers 403
 * until then); the language and the appearance can still be switched.
 */
export function AppLayout({ navigation, children }: AppLayoutProps) {
  const { me } = useAuth()
  const surface = useShellSurface()

  if (!me) return null

  const entries = me.user.must_change_password
    ? []
    : navigation.filter((entry) => hasAnyRole(me.user.roles, entry.roles) && (!entry.requiresTracking || me.company.tracking_allowed))

  return (
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
  )
}
