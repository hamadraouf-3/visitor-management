import { Building2 } from 'lucide-react'
import { useState } from 'react'
import { useColorScheme } from '../../appearance/useAppearance'
import { toneTileClasses } from '../../components/ui/tones'
import { parseCompanyBrand } from '../../identity/brand'
import type { PlatformCompany } from '../../types/api'
import { cn } from '../../utils/cn'

export interface CompanyLogoTileProps {
  company: Pick<PlatformCompany, 'brand' | 'slug' | 'is_active'>
  /** `sm`: a tile for a row of the companies list. `lg`: a plate beside a page's title. */
  size?: 'sm' | 'lg'
  className?: string
}

/* One box per size, with or without a logo, so the names beside the tiles of a list line up. A logo
   is usually a wide wordmark: the box is wider than tall, and the logo keeps its proportions in it. */
const BOX = {
  sm: 'h-10 w-[4.5rem] rounded-item',
  lg: 'h-14 w-[6.5rem] rounded-control sm:w-32',
} as const

/**
 * A company's logo on the platform owner's pages (Phase 12). In the light scheme its logo stands on the
 * card itself, as on the company's own pages: no fill, no edge (Phase 13, F13-26). In the dark scheme it
 * is its logo for dark surfaces, or for a company without one the logo for light surfaces on a white
 * plate with the cards' edge. A company without a logo, or whose files do not load, has the building tile
 * in the same box. The box is the same either way. Decorative: the company's name is written beside it.
 */
export function CompanyLogoTile({ company, size = 'sm', className }: CompanyLogoTileProps) {
  // A file that does not load is given up, per address: the other logo stands in for it, or the tile for both.
  const [failed, setFailed] = useState<readonly string[]>([])
  const scheme = useColorScheme()
  const brand = parseCompanyBrand(company.brand, company.slug)
  const usable = (url: string | null) => (url !== null && !failed.includes(url) ? url : null)
  const light = usable(brand.logo_url)
  const dark = scheme === 'dark' ? usable(brand.logo_dark_url) : null
  if (!light) {
    return (
      <span
        aria-hidden="true"
        className={cn('flex shrink-0 items-center justify-center', BOX[size], size === 'lg' ? '[&_svg]:size-6' : '[&_svg]:size-[1.125rem]', toneTileClasses[company.is_active ? 'accent' : 'neutral'], className)}
      >
        <Building2 />
      </span>
    )
  }
  const logo = dark ?? light
  return (
    <span
      aria-hidden="true"
      data-company-logo-tile=""
      // `dark-scheme`: the logo for light surfaces, on its plate in the dark scheme only.
      data-logo-plate={dark ? undefined : 'dark-scheme'}
      className={cn(
        'flex shrink-0 items-center justify-center border border-transparent',
        !dark && 'scheme-dark:border-border scheme-dark:bg-white',
        BOX[size],
        size === 'lg' ? 'px-2.5 py-2' : 'px-1.5 py-1',
        className,
      )}
    >
      <img
        src={logo}
        alt=""
        decoding="async"
        draggable={false}
        onError={() => setFailed((current) => (current.includes(logo) ? current : [...current, logo]))}
        className="block max-h-full max-w-full object-contain"
      />
    </span>
  )
}
