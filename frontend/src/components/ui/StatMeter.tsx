import { cn } from '../../utils/cn'

export interface StatMeterSegment {
  value: number
  /**
   * `strong` the main part (ink, turquoise on dark), `attention` mawdoo3's yellow (what needs
   * action), `accent` teal, `muted` the rest (still to come).
   */
  tone: 'strong' | 'attention' | 'accent' | 'muted'
}

export interface StatMeterProps {
  segments: readonly StatMeterSegment[]
  className?: string
}

const TONES = {
  strong: 'bg-fg',
  attention: 'bg-attention',
  accent: 'bg-accent-strong',
  muted: 'bg-chart-muted',
} as const

/**
 * Direction C's stacked bar under a KPI ("11 arrived · 1 no-show · 2 to come"): each segment as
 * wide as its share. Decorative: the tile's hint says the same numbers in words, so the bar is
 * hidden from assistive technology. Segments of 0 are left out; nothing is drawn for a total of 0.
 */
export function StatMeter({ segments, className }: StatMeterProps) {
  const visible = segments.filter((segment) => segment.value > 0)
  if (visible.length === 0) return null
  return (
    <span aria-hidden="true" data-stat-meter="" className={cn('flex h-1.5 gap-0.5', className)}>
      {visible.map((segment, index) => (
        <span key={index} className={cn('rounded-[3px]', TONES[segment.tone])} style={{ flexGrow: segment.value, flexBasis: 0 }} />
      ))}
    </span>
  )
}
