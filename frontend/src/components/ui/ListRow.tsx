import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { IconTile } from './IconTile'
import type { Tone } from './tones'

export interface RowListProps {
  /** Names the list for assistive technology when no heading right above it does. */
  label?: string
  /** Inside a `Card` (default): rows run edge to edge with dividers. `false`: a framed list of its own. */
  inCard?: boolean
  className?: string
  children: ReactNode
}

/**
 * A list of `ListRow`s with hairline dividers (direction C's "needs attention" and activity
 * lists). Put it in a `Card` with `flush`, or give `inCard={false}` for a list
 * with its own frame.
 */
export function RowList({ label, inCard = true, className, children }: RowListProps) {
  return (
    <ul
      aria-label={label}
      className={cn('divide-y divide-border-subtle', !inCard && 'rounded-card border border-border bg-surface', className)}
    >
      {children}
    </ul>
  )
}

export interface ListRowProps {
  /** The row's main line (a name, an event); may be a link. */
  title: ReactNode
  /** Facts under the title (a company, "Delivery failed: …", a time). Data, not explanations. */
  detail?: ReactNode
  /** A third, quieter line (a time, "Due 14:30 today"). */
  meta?: ReactNode
  /** An icon in a tinted tile at the start, or… */
  icon?: LucideIcon
  tone?: Tone
  /** …any element there instead (an `Avatar`). */
  leading?: ReactNode
  /** Beside the text at the end (a status chip, a time). */
  trailing?: ReactNode
  /** Under the text: one button or link that acts on this row (C's "Resend pass"). */
  action?: ReactNode
  /** Highlights the row (the visitor inside now, an overdue one): a teal tint. */
  highlighted?: boolean
  className?: string
}

/**
 * One row of a `RowList`: icon tile (or avatar), a semibold title, muted detail lines, and an
 * optional trailing element and action (direction C).
 */
export function ListRow({ title, detail, meta, icon, tone = 'neutral', leading, trailing, action, highlighted = false, className }: ListRowProps) {
  return (
    <li className={cn('flex items-start gap-3 px-4 py-4 sm:px-5', highlighted && 'bg-row-highlight', className)}>
      {leading ?? (icon && <IconTile icon={icon} tone={tone} />)}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[0.90625rem] leading-snug font-semibold break-words text-fg">{title}</div>
            {detail && <div className="mt-0.5 text-meta break-words text-fg-secondary">{detail}</div>}
            {meta && <div className="mt-0.5 text-[0.78125rem] leading-snug text-fg-muted">{meta}</div>}
          </div>
          {trailing && <div className="shrink-0">{trailing}</div>}
        </div>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </li>
  )
}
