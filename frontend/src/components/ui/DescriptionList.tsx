import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

export interface DescriptionItem {
  term: string
  description: ReactNode
  /** Spans the full width on wide layouts (long text such as a purpose). */
  wide?: boolean
}

export interface DescriptionListProps {
  items: readonly (DescriptionItem | false | null | undefined)[]
  /** Two columns from `sm` up; one column otherwise. */
  columns?: 1 | 2
  className?: string
}

/** Label/value pairs as a semantic `<dl>` (details pages, summaries). Falsy items are skipped. */
export function DescriptionList({ items, columns = 2, className }: DescriptionListProps) {
  const visible = items.filter((item): item is DescriptionItem => Boolean(item))
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4', columns === 2 && 'sm:grid-cols-2', className)}>
      {visible.map((item) => (
        <div key={item.term} className={cn('min-w-0', item.wide && columns === 2 && 'sm:col-span-2')}>
          <dt className="text-sm font-medium text-fg-muted">{item.term}</dt>
          <dd className="mt-1 text-sm break-words text-fg">{item.description}</dd>
        </div>
      ))}
    </dl>
  )
}
