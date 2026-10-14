import { Building2 } from 'lucide-react'
import { useState } from 'react'
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
 * A company's logo on the platform owner's pages (Phase 12): on a white plate, in either colour
 * scheme (it is the logo for light surfaces). A company without a logo, or whose file does not
 * load, has the building tile in the same box. Decorative: the company's name is written beside it.
 */
export function CompanyLogoTile({ company, size = 'sm', className }: CompanyLogoTileProps) {
  const [failed, setFailed] = useState<string | null>(null)
  const logo = parseCompanyBrand(company.brand, company.slug).logo_url
  if (!logo || failed === logo) {
    return (
      <span
        aria-hidden="true"
        className={cn('flex shrink-0 items-center justify-center', BOX[size], size === 'lg' ? '[&_svg]:size-6' : '[&_svg]:size-[1.125rem]', toneTileClasses[company.is_active ? 'accent' : 'neutral'], className)}
      >
        <Building2 />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      data-company-logo-tile=""
      className={cn('flex shrink-0 items-center justify-center border border-border bg-white', BOX[size], size === 'lg' ? 'px-2.5 py-2' : 'px-1.5 py-1', className)}
    >
      <img src={logo} alt="" decoding="async" draggable={false} onError={() => setFailed(logo)} className="block max-h-full max-w-full object-contain" />
    </span>
  )
}
