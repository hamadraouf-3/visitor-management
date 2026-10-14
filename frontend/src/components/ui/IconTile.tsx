import type { LucideIcon } from 'lucide-react'
import { cn } from '../../utils/cn'
import { toneTileClasses, type Tone } from './tones'

export interface IconTileProps {
  icon: LucideIcon
  tone?: Tone
  /** `sm` 32 px, `md` 36 px (KPI tiles, list rows; direction C), `lg` 48 px (empty states). */
  size?: 'sm' | 'md' | 'lg'
  /** The icon points the reading direction's way (an arrow): mirrored in right-to-left text. */
  mirrorIcon?: boolean
  className?: string
}

const SIZES = {
  sm: 'size-8 rounded-item [&_svg]:size-4',
  md: 'size-9 rounded-item [&_svg]:size-[1.125rem]',
  lg: 'size-12 rounded-control [&_svg]:size-6',
} as const

/** A tinted square behind an icon (direction C's tile). Decorative: the text beside it says what it means. */
export function IconTile({ icon: Icon, tone = 'neutral', size = 'md', mirrorIcon = false, className }: IconTileProps) {
  return (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center', SIZES[size], toneTileClasses[tone], className)}>
      <Icon className={cn(mirrorIcon && 'mirror-rtl')} />
    </span>
  )
}
