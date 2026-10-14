import { useLocation } from 'react-router'
import { isPlatformPage } from '../../auth/redirect'
import { useProductName } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'
import { BrandLogo } from './BrandLogo'

export interface BrandLockupProps {
  /**
   * `shell`: the white logo on the teal shell (sidebar, top bar, drawer) and other dark surfaces.
   * `page`: on a light page (sign-in, errors, the visitor pass): the teal logo, white in the dark
   * colour scheme.
   */
  surface: 'shell' | 'page'
  /**
   * `sm` the phone and tablet top bar, `md` the sidebar and the drawer, `lg` the public pages
   * (sign-in, errors, the visitor pass), centred.
   */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: { logo: 'h-[1.375rem]', name: 'text-xs leading-none', gap: 'gap-1' },
  md: { logo: 'h-8', name: 'text-[0.8125rem] leading-none', gap: 'gap-1.5' },
  lg: { logo: 'h-12', name: 'text-lg leading-tight', gap: 'gap-2' },
} as const

/**
 * The product lockup: the Mawdoo3 logo with the product's name under it, «زوار موضوع» / "Mawdoo3
 * Visitors" (F10-27). The name is real text and the logo is decorative beside it, so the lockup
 * reads once, as the product's name. Phrasing content only (spans), so it can be a heading's text
 * (the navigation drawer's title).
 *
 * The product's lockup belongs to the platform owner's area alone (Phase 12): outside `/platform/…`
 * it renders nothing. Pages of a company and neutral pages use `IdentityLockup`.
 */
export function BrandLockup({ surface, size = 'md', className }: BrandLockupProps) {
  const name = useProductName()
  const { pathname } = useLocation()
  const sizes = SIZES[size]
  if (!isPlatformPage(pathname)) return null
  return (
    <span data-brand-lockup={surface} className={cn('inline-flex flex-col', sizes.gap, size === 'lg' ? 'items-center text-center' : 'items-start', className)}>
      <BrandLogo variant={surface === 'shell' ? 'white' : 'auto'} decorative className={sizes.logo} />
      <span className={cn('font-display font-semibold tracking-[-0.01em] whitespace-nowrap', sizes.name, surface === 'shell' ? 'text-fg' : 'text-fg-secondary')}>
        {name}
      </span>
    </span>
  )
}
