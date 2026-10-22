import { useLanguage } from '../i18n/useLanguage'
import { cn } from '../utils/cn'
import { formatCount } from '../utils/number'

export interface NavBadgeProps {
  count: number
  /** What the count is, in words, for assistive technology ("3 active alerts"): the figure alone says nothing. */
  label: string
  /**
   * `danger`: something needs action now (an open alert), the status red with white figures (5.62:1, dark 4.67:1),
   * never the shell's colour. `neutral`: counted, nothing new (the shell's own tint and ink).
   */
  tone?: 'danger' | 'neutral'
}

/**
 * A count at the end of a navigation entry (Phase 16), drawn on the shell: the figure in a pill, its words read
 * instead. Its colours stay readable on every shell (a company's light one included) and on the current
 * page's pill.
 */
export function NavBadge({ count, label, tone = 'neutral' }: NavBadgeProps) {
  const { language } = useLanguage()
  if (count <= 0) return null
  return (
    <>
      {/* A space beside the entry's label, for the link's name ("Tracking alerts 3 active alerts"), as the tabs' counts have. */}
      {' '}
      <span data-nav-badge={tone} className="ms-auto flex shrink-0 items-center">
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex min-w-6 items-center justify-center rounded-full px-1.5 font-numeric text-xs leading-5 font-semibold tabular-nums',
            tone === 'danger' ? 'bg-danger-solid text-on-danger' : 'bg-neutral-surface text-neutral-text ring-1 ring-border ring-inset',
          )}
        >
          {formatCount(count, language)}
        </span>
        <span className="sr-only">{label}</span>
      </span>
    </>
  )
}
