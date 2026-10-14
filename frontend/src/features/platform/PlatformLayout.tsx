import { Building2, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SessionOwnerContext } from '../../auth/useAuth'
import { ShellFrame } from '../../layouts/ShellFrame'
import { paths } from '../../paths'
import type { NavEntry } from '../types'
import { PlatformLanguageSwitcher, PlatformLockup, PlatformUserMenu } from './PlatformChrome'
import { usePlatformAuth } from './usePlatformAuth'

/**
 * The platform owner's shell (Phase 11): the frame of the company app (`ShellFrame`) in a colour of
 * its own (`theme-shell-platform`: the deep teal; the slate in the dark colour scheme), with the
 * product's lockup labelled "Platform" / «المنصة», the platform's two sections and the platform
 * account's menu, so it is never taken for a company. The navigation is hidden while a
 * password change is required. Lists below keep their view state under the platform account
 * (`SessionOwnerContext`), never asking the company session who is signed in.
 */
export function PlatformLayout() {
  const { t } = useTranslation()
  const { me } = usePlatformAuth()
  if (!me) return null

  const entries: NavEntry[] = me.admin.must_change_password
    ? []
    : [
        { to: paths.platformCompanies, label: t('nav.items.platformCompanies'), icon: Building2, roles: [], section: 'main', order: 1 },
        { to: paths.platformAudit, label: t('nav.items.platformAudit'), icon: ScrollText, roles: [], section: 'main', order: 2 },
      ]

  return (
    <SessionOwnerContext.Provider value={`platform:${me.admin.id}`}>
      <ShellFrame
        entries={entries}
        shellTheme="theme-shell-platform"
        renderLockup={(size) => <PlatformLockup size={size} />}
        languageSwitch={<PlatformLanguageSwitcher />}
        renderUserMenu={(placement) => <PlatformUserMenu admin={me.admin} placement={placement} />}
      />
    </SessionOwnerContext.Provider>
  )
}
