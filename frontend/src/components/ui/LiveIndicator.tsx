import { cn } from '../../utils/cn'

export interface LiveIndicatorProps {
  /** What is live, in the UI language ("Live", "Updated 11:20"). */
  label: string
  /** `success` (default) a green dot, for light surfaces; `highlight` light turquoise, for dark tiles. */
  tone?: 'success' | 'highlight'
  className?: string
}

/**
 * A pulsing dot with a short label (direction C's "● Live" beside the inside-now figure). The pulse
 * stops under reduced motion; the label says it in words.
 */
export function LiveIndicator({ label, tone = 'success', className }: LiveIndicatorProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-meta text-fg-secondary', className)}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 animate-live rounded-full bg-current', tone === 'highlight' ? 'text-highlight' : 'text-success-solid')} />
      <span>{label}</span>
    </span>
  )
}
