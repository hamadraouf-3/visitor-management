import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { toneSurfaceClasses, type Tone } from './tones'

export interface BadgeProps {
  tone?: Tone
  icon?: LucideIcon
  /** The icon points the reading direction's way (an arrow): mirrored in right-to-left text. */
  mirrorIcon?: boolean
  /** Colour classes that replace the tone's (the visit status chips have their own palette). */
  colorClassName?: string
  /**
   * `sm` (default): the compact chip for secondary facts (an invitation's state, "Override"), 24 px.
   * `md`: direction C's status chip, 28 px with 13 px text, for the one status a row or a page is
   * about (a visit's status in tables and detail headers).
   */
  size?: 'sm' | 'md'
  className?: string
  children: ReactNode
}

const SIZE_CLASSES = {
  sm: 'min-h-6 gap-1 px-2 text-xs leading-5',
  md: 'min-h-7 gap-1.5 px-3 text-[0.8125rem] leading-5',
} as const

/** A chip: icon and text on a tinted, rounded background (direction C's status chip). */
export function Badge({ tone = 'neutral', icon: Icon, mirrorIcon = false, colorClassName, size = 'sm', className, children }: BadgeProps) {
  return (
    <span
      data-size={size}
      className={cn(
        'inline-flex max-w-full items-center rounded-full border py-px font-semibold whitespace-nowrap',
        SIZE_CLASSES[size],
        colorClassName ?? toneSurfaceClasses[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', mirrorIcon && 'mirror-rtl')} />}
      <span className="truncate">{children}</span>
    </span>
  )
}
