import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

/*
 * Tailwind only generates classes it finds spelled out in the source, so each breakpoint's classes
 * are written in full. From the breakpoint on, the panel is direction C's list card: the toolbar
 * as its header, the table edge to edge under a hairline, the footer under another. Below it the
 * table's rows are cards of their own (`Table` `stackBelow`), so the panel draws no frame there:
 * a card of cards would only cost width on a phone.
 */
const FRAME = {
  md: {
    panel: 'md:gap-0 md:overflow-hidden md:rounded-card md:border md:border-border md:bg-surface',
    toolbar: 'md:px-4 md:py-3',
    // The table's own loading box and an empty list's placeholder sit inside the frame: no frame of their own.
    body: 'md:[&>div.rounded-card]:rounded-none md:[&>div.rounded-card]:border-0',
    divider: 'md:border-t md:border-border-subtle',
    footer: 'md:border-t md:border-border-subtle md:px-4',
  },
  lg: {
    panel: 'lg:gap-0 lg:overflow-hidden lg:rounded-card lg:border lg:border-border lg:bg-surface',
    toolbar: 'lg:px-4 lg:py-3',
    body: 'lg:[&>div.rounded-card]:rounded-none lg:[&>div.rounded-card]:border-0',
    divider: 'lg:border-t lg:border-border-subtle',
    footer: 'lg:border-t lg:border-border-subtle lg:px-4',
  },
  xl: {
    panel: 'xl:gap-0 xl:overflow-hidden xl:rounded-card xl:border xl:border-border xl:bg-surface',
    toolbar: 'xl:px-4 xl:py-3',
    body: 'xl:[&>div.rounded-card]:rounded-none xl:[&>div.rounded-card]:border-0',
    divider: 'xl:border-t xl:border-border-subtle',
    footer: 'xl:border-t xl:border-border-subtle xl:px-4',
  },
} as const

export interface ListPanelProps {
  /** The panel's header row: tabs, a search, a status choice. */
  toolbar?: ReactNode
  /** Under the list: the pagination ("Showing 1–6 of 6"). */
  footer?: ReactNode
  /** The table's `stackBelow`: from there on the panel frames the table. */
  frameFrom: 'md' | 'lg' | 'xl'
  className?: string
  /** A `Table` with `framed={false}`, or what replaces it (a load error). */
  children: ReactNode
}

/**
 * A list as one card (direction C's "Today's visits"): toolbar, table and pagination share a frame
 * with hairlines between them. Below `frameFrom` the parts stack with gaps instead. Every searchable
 * list uses it (My visits, Visitors, a visitor's history, Users): the search with a hidden label and
 * a placeholder, the filters as selects named by `aria-label` showing their current option.
 */
export function ListPanel({ toolbar, footer, frameFrom, className, children }: ListPanelProps) {
  const frame = FRAME[frameFrom]
  return (
    <div className={cn('flex flex-col gap-4', frame.panel, className)}>
      {toolbar && <div className={frame.toolbar}>{toolbar}</div>}
      <div className={cn('min-w-0', frame.body, toolbar ? frame.divider : undefined)}>{children}</div>
      {footer && <div className={frame.footer}>{footer}</div>}
    </div>
  )
}
