import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { useLanguage } from '../../i18n/useLanguage'
import { formatCount } from '../../utils/number'

export interface CountBadgeProps {
  /** A number (formatted for the UI language) or text already formatted. */
  children: number | ReactNode
  /**
   * `neutral` (default): the count beside a section's title ("Today's visits 14"). `attention`:
   * mawdoo3's yellow with ink text (8.74:1), for things that need action. `accent`: the teal tint.
   */
  tone?: 'neutral' | 'attention' | 'accent'
  className?: string
}

const TONES = {
  neutral: 'bg-surface-muted text-fg-secondary',
  attention: 'bg-attention text-on-attention',
  accent: 'bg-accent-surface text-accent-text',
} as const

/**
 * A count in a small pill, in Space Grotesk with Latin digits (direction C). Give it its words
 * where the number alone would not say what it counts (the section's title usually does).
 */
export function CountBadge({ children, tone = 'neutral', className }: CountBadgeProps) {
  const { language } = useLanguage()
  return (
    <span
      data-count-badge={tone}
      className={cn(
        'inline-flex min-w-6 shrink-0 items-center justify-center rounded-full px-2 py-0.5 font-numeric text-[0.8125rem] leading-5 font-semibold tabular-nums',
        TONES[tone],
        className,
      )}
    >
      {typeof children === 'number' ? formatCount(children, language) : children}
    </span>
  )
}
