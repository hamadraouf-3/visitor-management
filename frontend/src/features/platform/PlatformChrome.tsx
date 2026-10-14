import { ChevronDown, ChevronsUpDown, KeyRound, LogOut, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { useAppearanceMenuGroup } from '../../appearance/useAppearance'
import { BrandLockup } from '../../components/app/BrandLockup'
import { BrandLogo } from '../../components/app/BrandLogo'
import { LanguageSwitchButton } from '../../components/app/LanguageSwitcher'
import { Avatar } from '../../components/ui/Avatar'
import { Menu, type MenuEntry } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/toastContext'
import { LANGUAGES } from '../../i18n'
import { useProductName } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { PlatformMe } from '../../types/api'
import { cn } from '../../utils/cn'
import { usePlatformChangeLanguage, usePlatformSignOut } from './usePlatformSessionActions'

/**
 * The "Platform" label beside the product's name (Phase 11): the platform owner's area is never
 * taken for a company's. `shell`: white on the deep teal shell; `page`: on a light page (the sign-in).
 */
export function PlatformTag({ surface = 'shell', compact = false, className }: { surface?: 'shell' | 'page'; compact?: boolean; className?: string }) {
  const { t } = useTranslation('platform')
  return (
    <span
      data-platform-tag=""
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[0.71875rem] leading-4 font-semibold whitespace-nowrap',
        surface === 'shell' ? 'border-fg/40 bg-fg/10 text-fg' : 'border-accent-border bg-accent-surface text-accent-text',
        className,
      )}
    >
      <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
      {/* `compact` (the phone's top bar): below 384 px the shield alone shows, the word is read. */}
      <span className={compact ? 'max-[24rem]:sr-only' : undefined}>{t('area')}</span>
    </span>
  )
}

/**
 * The lockup of the platform's shell: the product's lockup with the "Platform" label, under it in the
 * sidebar and the drawer, beside it in the top bar. On phones the bar shows the logo and the label (the
 * product's name is read, not shown): the label, the language switch and the account menu must fit 320 px.
 */
export function PlatformLockup({ size }: { size: 'sm' | 'md' }) {
  const productName = useProductName()
  if (size === 'md') {
    return (
      <span className="inline-flex flex-col items-start gap-2">
        <BrandLockup surface="shell" size="md" />
        <PlatformTag />
      </span>
    )
  }
  return (
    <span className="ms-1 inline-flex min-w-0 items-center gap-2">
      <BrandLockup surface="shell" size="sm" className="max-sm:hidden" />
      <span className="inline-flex sm:hidden">
        <BrandLogo variant="white" decorative className="h-[1.375rem]" />
        <span className="sr-only">{productName}</span>
      </span>
      <PlatformTag compact />
    </span>
  )
}

/** The platform pages' language switch: saved to the platform account when signed in to the platform. */
export function PlatformLanguageSwitcher({ className }: { className?: string }) {
  const change = usePlatformChangeLanguage()
  return <LanguageSwitchButton onSwitch={(language) => change.mutate(language)} pending={change.isPending} className={className} />
}

const words = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/** The same words, whatever the spacing and the letters' case. */
function sameWords(a: string, b: string): boolean {
  return words(a) === words(b)
}

export interface PlatformUserMenuProps {
  admin: PlatformMe['admin']
  /** `bar`: compact trigger in the top bar; `sidebar`: the user block at the foot of the sidebar. */
  placement?: 'bar' | 'sidebar'
}

/**
 * The platform owner's account block and menu (the device's appearance, change password, sign out), as
 * the company shell's `UserMenu`: the appearance is one choice per device, for both areas (Phase 13).
 */
export function PlatformUserMenu({ admin, placement = 'bar' }: PlatformUserMenuProps) {
  const { t, i18n } = useTranslation('platform')
  const signOut = usePlatformSignOut()
  const toast = useToast()
  const appearance = useAppearanceMenuGroup()
  const inSidebar = placement === 'sidebar'
  // An account named by its role's own words (the demo account is «مالك المنصة»): the menu says them once (UX review L11).
  const namedByRole = LANGUAGES.some((language) => sameWords(admin.full_name, i18n.t('account.role', { ns: 'platform', lng: language })))

  const items: MenuEntry[] = [
    appearance,
    { id: 'change-password', label: t('account.changePassword'), icon: KeyRound, to: paths.platformChangePassword },
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
      triggerLabel={t('account.menuFor', { name: admin.full_name })}
      align={inSidebar ? 'start' : 'end'}
      placement={inSidebar ? 'top' : 'bottom'}
      triggerClassName={
        inSidebar
          ? 'flex min-h-15 w-full items-center gap-3 rounded-[0.875rem] border border-border bg-surface px-2.5 py-2 text-start transition-colors hover:bg-surface-muted'
          : 'flex min-h-11 items-center gap-2 rounded-control px-1.5 py-1 text-sm font-medium text-fg transition-colors hover:bg-surface-muted'
      }
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{admin.full_name}</p>
          <p className="truncate text-sm text-fg-muted">
            <span dir="ltr">{admin.email}</span>
          </p>
          {!namedByRole && (
            <p data-account-role="" className="mt-1 text-xs text-fg-muted">
              {t('account.role')}
            </p>
          )}
        </div>
      }
      trigger={
        <>
          <Avatar name={admin.full_name} tone="highlight" size={inSidebar ? 'md' : 'sm'} />
          {inSidebar ? (
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-fg">{admin.full_name}</span>
                <span className="truncate text-xs text-fg-muted">
                  <span dir="ltr">{admin.email}</span>
                </span>
              </span>
              <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            </>
          ) : (
            <>
              <span className="hidden max-w-48 truncate sm:inline">{admin.full_name}</span>
              <ChevronDown aria-hidden="true" className="size-4 text-fg-muted" />
            </>
          )}
        </>
      }
    />
  )
}
