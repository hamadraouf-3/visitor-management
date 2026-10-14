import { Inbox, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

export interface EmptyStateProps {
  title: ReactNode
  /**
   * A line under the title. Kept for real messages (a server's error); the brand pass's decision 3
   * drops explanatory sentences, so an empty list shows a short title, an icon and an action.
   */
  description?: ReactNode
  icon?: LucideIcon
  /**
   * A big numeral in place of the icon (direction C's KPI face, Latin digits): "404" on the page
   * that was not found. Decorative: the title says it in words.
   */
  figure?: string
  /** Call to action (button or link). */
  action?: ReactNode
  /**
   * h1 when the empty state is the whole page (errors, not found): a solid card with a larger
   * title. h2/h3 inside a page: the dashed placeholder of an empty list.
   */
  headingLevel?: 'h1' | 'h2' | 'h3'
  className?: string
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  figure,
  action,
  headingLevel: Heading = 'h2',
  className,
}: EmptyStateProps) {
  const page = Heading === 'h1'
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-card border bg-surface px-6 text-center',
        page ? 'border-border py-14' : 'border-dashed border-neutral-border py-12',
        className,
      )}
    >
      {figure ? (
        <span aria-hidden="true" className="font-numeric text-kpi font-semibold text-accent-text tabular-nums">
          {figure}
        </span>
      ) : (
        <span className="flex size-12 items-center justify-center rounded-control bg-surface-muted text-fg-muted">
          <Icon aria-hidden="true" className="size-6" />
        </span>
      )}
      <Heading className={cn('font-bold text-fg', page ? 'text-2xl' : 'text-lg')}>{title}</Heading>
      {description && <p className="max-w-md text-sm leading-relaxed text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
