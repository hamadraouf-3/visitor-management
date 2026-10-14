import { ChevronRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '../../utils/cn'
import { toneTileClasses, type Tone } from './tones'

export interface StatTileProps {
  label: string
  value: ReactNode
  /** Facts under the number ("11 arrived · 1 no-show · 2 to come", "Last check-out 11:05"). Data, not explanations. */
  hint?: ReactNode
  icon?: LucideIcon
  tone?: Tone
  /**
   * `emphasis`: direction C's dark tile (ink, deep teal in the dark scheme) with the number in
   * mawdoo3's light turquoise (7.90:1), for the one figure a screen is about (people inside the
   * building now). At most one per screen.
   */
  variant?: 'default' | 'emphasis'
  /** Beside the number, e.g. a `LiveIndicator` ("● Live"). */
  aside?: ReactNode
  /** At the foot of the tile, above the hint: a `StatMeter`, a row of avatars. */
  footer?: ReactNode
  /**
   * Makes the whole tile a link (e.g. to the filtered list behind the number). It shows a
   * chevron at rest, so touch and keyboard users see it leads somewhere before they act.
   */
  to?: string
  className?: string
}

/**
 * One number with its label: direction C's KPI tile, the number 52 px in Space Grotesk (Latin
 * digits in both languages), the label and a tinted icon tile above it, facts at its foot. Tiles in
 * a `StatGrid` row share their height, their feet aligned. Compact below `sm`, so tiles sit two per
 * row on a phone instead of stacking one per screen-width row before the content they summarise,
 * and compact on paper, where five share a row and each label keeps to one line (the decorative
 * icon is left out).
 *
 * The icon tile is shown from `sm`: beside the label in a 138 px phone tile (320 px screens,
 * 400 % zoom) it would leave a one-word label such as "Administrators" no room (WCAG 1.4.10).
 * A link's chevron sits beside the number, where there is room. The label wraps between words
 * and, only when a single word is wider than the tile, inside it.
 */
export function StatTile({ label, value, hint, icon: Icon, tone = 'neutral', variant = 'default', aside, footer, to, className }: StatTileProps) {
  const emphasis = variant === 'emphasis'
  const inner = (
    <>
      <p className="flex items-start justify-between gap-2 text-sm font-medium text-fg-secondary print:text-xs">
        <span className="min-w-0 break-words">{label}</span>
        {Icon && (
          <span
            aria-hidden="true"
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-item max-sm:hidden print:hidden',
              emphasis ? 'bg-fg/10 text-highlight' : toneTileClasses[tone],
            )}
          >
            <Icon className="size-[1.125rem]" />
          </span>
        )}
      </p>
      <p
        className={cn(
          'mt-2 flex items-end justify-between gap-2 font-numeric text-kpi-sm font-semibold tabular-nums sm:mt-3 sm:text-kpi print:mt-0.5 print:text-xl',
          emphasis ? 'text-highlight print:text-fg' : 'text-fg',
        )}
      >
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 break-words">{value}</span>
          {aside && <span className="shrink-0 font-sans text-meta font-normal tracking-normal print:hidden">{aside}</span>}
        </span>
        {to && <ChevronRight aria-hidden="true" data-link-cue="" className="mirror-rtl size-5 shrink-0 text-fg-muted print:hidden" />}
      </p>
      {(footer || hint) && (
        <div className="mt-auto flex flex-col gap-2 pt-3 print:pt-1">
          {footer && <div className="print:hidden">{footer}</div>}
          {hint && <p className="text-xs leading-relaxed text-fg-muted sm:text-meta print:text-[10px] print:leading-tight">{hint}</p>}
        </div>
      )}
    </>
  )
  // The dark tile's tokens apply inside it, not to the tile itself: a link's focus ring is drawn
  // outside the tile, on the page, so it takes the page's focus colour (#188086, 4.16:1 on the
  // canvas). On the tile, the dark set's light turquoise was 1.73:1 against the light canvas.
  const content = emphasis ? <div className="theme-dark flex min-w-0 flex-1 flex-col text-fg">{inner}</div> : inner
  const classes = cn(
    'flex min-w-0 flex-col rounded-card border p-3 sm:p-5 print:p-2',
    emphasis ? 'border-emphasis bg-emphasis print:border-black print:bg-white' : 'border-border bg-surface',
    className,
  )

  if (to) {
    return (
      <Link
        to={to}
        className={cn(classes, 'transition-colors', emphasis ? 'hover:border-highlight' : 'hover:border-border-strong hover:bg-surface-sunken')}
      >
        {content}
      </Link>
    )
  }
  return <div className={classes}>{content}</div>
}

/**
 * Responsive grid for StatTiles: two per row up to `lg`, four from there. Below 360 px (small
 * phones, a desktop zoomed to 400 %) one per row: a 138 px tile cannot hold a long one-word
 * label such as "Administrators" beside its number.
 */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 sm:gap-4 lg:grid-cols-4', className)}>{children}</div>
}
