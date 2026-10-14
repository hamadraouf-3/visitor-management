import { useLocation } from 'react-router'
import { useColorScheme } from '../../appearance/useAppearance'
import { isPlatformPage } from '../../auth/redirect'
import { BRAND, brandName, type LogoVariant } from '../../brand'
import { useLanguage } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'

export interface BrandLogoProps {
  /**
   * `white` on the teal shell and dark surfaces, `teal` on light surfaces, `ink` for print and
   * single-colour use. `auto`: teal on a light page, white when the page is drawn in the dark colour
   * scheme (the platform's sign-in page; the device's appearance, Phase 13).
   */
  variant: LogoVariant | 'auto'
  /**
   * The logo's text alternative is the brand's name in the UI language ("Mawdoo3", "موضوع").
   * Decorative when its name is said next to it anyway (the product lockup).
   */
  decorative?: boolean
  /** Size it by height (`h-8`); the width follows the logo's 462 × 149 proportions. */
  className?: string
}

/**
 * The Mawdoo3 wordmark (F10-8): the product's own logo. Since Phase 12 it belongs to the platform
 * owner's area alone: a company's staff and visitors see that company's identity (`IdentityLockup`,
 * `CompanyLogo`), and a neutral page shows none. Outside `/platform/…` it renders nothing, whoever
 * asks for it.
 */
export function BrandLogo({ variant, decorative = false, className }: BrandLogoProps) {
  const { language } = useLanguage()
  const { pathname } = useLocation()
  const scheme = useColorScheme()
  if (!isPlatformPage(pathname)) return null
  const image = (
    <img
      src={BRAND.logo[variant === 'auto' ? 'teal' : variant]}
      alt={decorative ? '' : brandName(language)}
      width={BRAND.logoSize.width}
      height={BRAND.logoSize.height}
      decoding="async"
      draggable={false}
      data-brand-logo={variant}
      className={cn('block h-8 w-auto shrink-0 select-none', className)}
    />
  )
  if (variant !== 'auto') return image
  // The white file in the dark scheme, on screen: the teal one is the fallback, and print's `screen`
  // query keeps it on paper.
  return (
    <picture className="contents">
      {scheme === 'dark' && <source media="screen" srcSet={BRAND.logo.white} />}
      {image}
    </picture>
  )
}
