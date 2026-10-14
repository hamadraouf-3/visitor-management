import { Building2, ChevronDown, ChevronsUpDown, KeyRound, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../api/client'
import { useAppearanceMenuGroup } from '../appearance/useAppearance'
import { useSignOut } from '../auth/useSessionActions'
import { Avatar } from '../components/ui/Avatar'
import { Menu, type MenuEntry } from '../components/ui/Menu'
import { useToast } from '../components/ui/toastContext'
import { useCompanyName } from '../i18n/useLanguage'
import { paths } from '../paths'
import type { Me } from '../types/api'

export interface UserMenuProps {
  user: Me['user']
  /** The company the user works in: named in the menu's header. */
  company: Me['company']
  /** `bar`: compact trigger in the top bar (phones, tablets). `sidebar`: direction C's user block at the foot of the sidebar (desktop). */
  placement?: 'bar' | 'sidebar'
}

/**
 * The signed-in user's block and account menu: the device's appearance (Light, Dark, System: Phase 13),
 * change password, sign out. The menu's header names the user, their e-mail, roles and company. The sidebar's block does not repeat the company:
 * its logo or wordmark heads the shell (Phase 12), so every user sees whose data they are in.
 *
 * The menu is never wider than the screen (`Menu`): the name and the address are cut with an
 * ellipsis, and the company's name, which may be long, wraps onto a second line.
 */
export function UserMenu({ user, company, placement = 'bar' }: UserMenuProps) {
  const { t } = useTranslation()
  const signOut = useSignOut()
  const toast = useToast()
  const companyName = useCompanyName(company)
  const appearance = useAppearanceMenuGroup()
  const inSidebar = placement === 'sidebar'
  // One person's roles: their job titles («موظف · مدير النظام»), not the teams' names.
  const roles = user.roles.map((role) => t(`roles.person.${role}`)).join(' · ')

  const items: MenuEntry[] = [
    appearance,
    { id: 'change-password', label: t('account.changePassword'), icon: KeyRound, to: paths.changePassword },
    {
      id: 'sign-out',
      label: t('account.signOut'),
      icon: LogOut,
      mirrorIcon: true,
      onSelect: () =>
        signOut.mutate(undefined, {
          onError: (error) => toast.show({ tone: 'danger', title: t('account.signOutFailed'), description: getErrorMessage(error) }),
        }),
    },
  ]

  return (
    <Menu
      items={items}
      triggerLabel={t('account.menuFor', { name: user.full_name })}
      align={inSidebar ? 'start' : 'end'}
      placement={inSidebar ? 'top' : 'bottom'}
      triggerClassName={
        inSidebar
          ? 'flex min-h-15 w-full items-center gap-3 rounded-[0.875rem] border border-border bg-surface px-2.5 py-2 text-start transition-colors hover:bg-surface-muted'
          : 'flex min-h-11 items-center gap-2 rounded-control px-1.5 py-1 text-sm font-medium text-fg transition-colors hover:bg-surface-muted'
      }
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{user.full_name}</p>
          <p className="truncate text-sm text-fg-muted">
            <span dir="ltr">{user.email}</span>
          </p>
          <p className="mt-1 text-xs text-fg-muted">{roles}</p>
          {companyName && (
            // A long company name takes a second line; it never widens the menu.
            <p data-user-company="" className="mt-2 flex items-start gap-1.5 text-xs leading-[1.125rem] font-medium text-fg-secondary">
              <Building2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="line-clamp-2 min-w-0 break-words">{companyName}</span>
            </p>
          )}
        </div>
      }
      trigger={
        <>
          <Avatar name={user.full_name} tone="highlight" size={inSidebar ? 'md' : 'sm'} />
          {inSidebar ? (
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-fg">{user.full_name}</span>
                <span className="truncate text-xs text-fg-muted">{roles}</span>
              </span>
              <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            </>
          ) : (
            <>
              <span className="hidden max-w-48 truncate sm:inline">{user.full_name}</span>
              <ChevronDown aria-hidden="true" className="size-4 text-fg-muted" />
            </>
          )}
        </>
      }
    />
  )
}
