import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { CountBadge } from './CountBadge'

export interface CardProps {
  title?: ReactNode
  /** A count beside the title (direction C: "Needs attention 2"). */
  count?: number | ReactNode
  /** Rendered at the end of the header (buttons, links, tabs). */
  actions?: ReactNode
  /** Heading level of the title; defaults to h2. */
  headingLevel?: 'h2' | 'h3'
  /** The title's id, for a region named by it. */
  titleId?: string
  /**
   * `emphasis`: direction C's dark panel (ink, deep teal in the dark scheme) for the one panel a
   * screen is about; kit components inside take the dark tokens (`theme-dark`).
   */
  variant?: 'default' | 'emphasis'
  /**
   * The body without its padding, for content that runs edge to edge (a table with its own cell
   * padding, a list of rows with hairlines between them). `bodyClassName` cannot remove it: `cn`
   * joins classes without merging, and Tailwind emits `px-4` after `p-0`.
   */
  flush?: boolean
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

/** A white panel with an 18 px radius and a hairline edge (direction C); flat, no shadow. */
export function Card({
  title,
  count,
  actions,
  headingLevel: Heading = 'h2',
  titleId,
  variant = 'default',
  flush = false,
  className,
  bodyClassName,
  children,
}: CardProps) {
  const hasHeader = Boolean(title || actions)
  const emphasis = variant === 'emphasis'
  return (
    <section
      aria-labelledby={title && titleId ? titleId : undefined}
      className={cn(
        'rounded-card border',
        emphasis ? 'theme-dark border-emphasis bg-emphasis text-fg print:border-black print:bg-white' : 'border-border bg-surface',
        className,
      )}
    >
      {hasHeader && (
        <header className="flex flex-col gap-3 border-b border-border-subtle px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            {title && (
              <div className="flex items-center gap-2.5">
                <Heading id={titleId} className="min-w-0 text-section font-bold break-words text-fg">
                  {title}
                </Heading>
                {count !== undefined && count !== null && <CountBadge>{count}</CountBadge>}
              </div>
            )}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && 'px-4 py-4 sm:px-5', bodyClassName)}>{children}</div>
    </section>
  )
}
