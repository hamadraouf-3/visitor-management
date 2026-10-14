import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ROW_LINK_LINES_ABOVE_TARGET, tableRowLinkProps, type TableStackBreakpoint } from '../../components/ui/tableStyles'
import { backLinkState, type BackLink } from '../../hooks/useBackLink'
import { paths } from '../../paths'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'

export interface VisitLinkCellProps {
  visit: Pick<Visit, 'id'> & { visitor: Pick<Visit['visitor'], 'full_name' | 'company_name'> }
  /** Where the visit page's "Back to …" link returns: the exact list view the user came from. */
  backLink: BackLink
  /** The table's `stackBelow`: below it the link covers the whole card. */
  stackBelow: TableStackBreakpoint
  /**
   * More about the visitor under the name and company, each on its own line (the evacuation
   * list's phone). Interactive content must sit above the card-wide link (`relative z-10`), and
   * its touch area may reach at most 12 px up (`PhoneLink`): on a touch screen the name and company
   * keep that clear, so it never covers them and the link keeps a band at least 44 px tall.
   */
  children?: ReactNode
  /**
   * Before the name and company, e.g. the visitor's `Avatar`: direction C's two-line row (a 14.5 px
   * name over a 12.5 px company, after the avatar). Without it the cell keeps its plain lines.
   */
  leading?: ReactNode
}

/*
 * Direction C's compact row (14.5 px name, 12.5 px company) applies in the table layout only: the
 * stacked card keeps its larger title. Spelled out per breakpoint for Tailwind.
 */
const COMPACT_LINES: Record<TableStackBreakpoint, { name: string; company: string }> = {
  md: { name: 'md:text-[0.90625rem] md:leading-snug', company: 'text-sm md:text-[0.78125rem] md:leading-snug' },
  lg: { name: 'lg:text-[0.90625rem] lg:leading-snug', company: 'text-sm lg:text-[0.78125rem] lg:leading-snug' },
  xl: { name: 'xl:text-[0.90625rem] xl:leading-snug', company: 'text-sm xl:text-[0.78125rem] xl:leading-snug' },
}

/**
 * The visitor cell of a visit table (My visits, the history, the evacuation list): the
 * visitor's name as the link to the visit, the company under it. In a table's stacked layout
 * the link's hit area is the whole card.
 */
export function VisitLinkCell({ visit, backLink, stackBelow, children, leading }: VisitLinkCellProps) {
  const rowLink = tableRowLinkProps(stackBelow)
  const compact = leading ? COMPACT_LINES[stackBelow] : null
  const lines = (
    // With content under them, the name and company keep clear of its touch area on a touch
    // screen, in the cards and in the table (ROW_LINK_LINES_ABOVE_TARGET): a phone link's touch
    // area reaches 12 px up, and took the lower part of the name without a company line.
    <div className={cn('min-w-0', children ? ROW_LINK_LINES_ABOVE_TARGET : undefined)}>
      <Link
        to={paths.visit(visit.id)}
        state={backLinkState(backLink)}
        {...rowLink}
        className={cn('font-semibold break-words text-accent-text hover:underline', compact?.name, rowLink.className)}
      >
        {visit.visitor.full_name}
      </Link>
      {visit.visitor.company_name && (
        <p className={cn('font-normal break-words text-fg-muted', compact ? compact.company : 'text-sm')}>
          {visit.visitor.company_name}
        </p>
      )}
    </div>
  )
  return (
    <div className="min-w-0">
      {leading ? (
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          {lines}
        </div>
      ) : (
        lines
      )}
      {children}
    </div>
  )
}
