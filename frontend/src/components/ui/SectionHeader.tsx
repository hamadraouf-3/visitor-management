import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { CountBadge } from './CountBadge'

export interface SectionHeaderProps {
  title: ReactNode
  /** A count beside the title (direction C: "Today's visits 14"). */
  count?: number | ReactNode
  /** At the end of the row: tabs, a segmented filter, a link. They wrap under the title on phones. */
  actions?: ReactNode
  headingLevel?: 'h2' | 'h3'
  /** The heading's id, for a region named by it (`aria-labelledby`). */
  id?: string
  className?: string
}

/**
 * A section's title row, without a description (decision 3 of the brand pass: no explanatory
 * notes): an 18 px bold heading, an optional count and actions at the inline end.
 */
export function SectionHeader({ title, count, actions, headingLevel: Heading = 'h2', id, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-3', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Heading id={id} className="min-w-0 text-section font-bold break-words text-fg">
          {title}
        </Heading>
        {count !== undefined && count !== null && <CountBadge>{count}</CountBadge>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
