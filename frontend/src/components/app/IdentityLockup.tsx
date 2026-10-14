import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { isLightSurface } from '../../identity/brand'
import { identityName } from '../../identity/identity'
import { useIdentity } from '../../identity/useIdentity'
import { useLanguage } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'
import { BrandLockup } from './BrandLockup'
import { CompanyLogo } from './CompanyLogo'

export interface IdentityLockupProps {
  /**
   * `shell`: the coloured shell (sidebar, top bar, drawer). `page`: a light page (sign-in, errors, the
   * visitor pass). `paper`: a printed sheet.
   */
  surface: 'shell' | 'page' | 'paper'
  /** `sm` the phone and tablet top bar, `md` the sidebar and the drawer, `lg` the public pages. */
  size?: 'sm' | 'md' | 'lg'
  /**
   * The shell is the deep one whatever the colour scheme (around the dark reception screen): a dark
   * surface also for a company whose own colour is light.
   */
  deepShell?: boolean
  /**
   * The company's name is written beside the lockup anyway (a printed sheet's header): a company
   * without a logo shows nothing instead of its name, and an emblem is not given the name again.
   */
  logoOnly?: boolean
  /** What a neutral page shows in the lockup's place; nothing by default (no logo, no name). */
  neutral?: ReactNode
  className?: string
}

/**
 * The identity at the head of a page (Phase 12): the company's logo, or its name as a wordmark; the
 * product's lockup in the platform owner's area; nothing on a neutral page, and nothing while a
 * company's identity is still on its way. Every place outside the platform owner's area that
 * showed the product's lockup shows this.
 */
export function IdentityLockup({ surface, size = 'md', deepShell = false, logoOnly = false, neutral = null, className }: IdentityLockupProps) {
  const { identity, pending } = useIdentity()
  const { language } = useLanguage()
  if (identity.kind === 'product') return surface === 'paper' ? null : <BrandLockup surface={surface} size={size} className={className} />
  if (identity.kind === 'neutral') return pending ? null : <>{neutral}</>
  if (logoOnly && !identity.brand.logo_url) return null
  const { palette } = identity.brand
  return (
    <span data-identity-lockup={surface} className={cn('inline-flex min-w-0 items-center', className)}>
      <CompanyLogo
        brand={identity.brand}
        name={identityName(identity, language)}
        surface={surface}
        size={size}
        // A company's own shell is a light surface when its colour is: the logo follows the shell's ink.
        shellTone={!deepShell && palette && isLightSurface(palette) ? 'light' : 'dark'}
        nameBeside={!logoOnly}
      />
    </span>
  )
}

/**
 * What a neutral sign-in or password page shows where a company's logo would stand: direction C's
 * dark tile with the page's own symbol. Decorative, and nobody's logo.
 */
export function NeutralMark({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden="true" data-neutral-mark="" className="flex size-14 items-center justify-center rounded-[1.125rem] bg-emphasis text-highlight">
      <Icon className="size-7" />
    </span>
  )
}
