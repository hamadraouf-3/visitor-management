import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

export interface Fact {
  term: string
  description: ReactNode
  /** Spans both columns (long text such as a purpose). */
  wide?: boolean
}

export interface FactListProps {
  items: readonly (Fact | false | null | undefined)[]
  /** Two (default) or three columns from `sm` up (the first of three wider, for a date and time); one column otherwise. */
  columns?: 1 | 2 | 3
  className?: string
}

/**
 * Facts as a semantic `<dl>` in direction C's detail style (the invitation's details table): a
 * 13 px muted term over a 15 px value. Falsy items are skipped.
 */
export function FactList({ items, columns = 2, className }: FactListProps) {
  const visible = items.filter((item): item is Fact => Boolean(item))
  return (
    <dl className={cn('grid grid-cols-1 gap-x-8 gap-y-5', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]', className)}>
      {visible.map((item) => (
        <div key={item.term} className={cn('min-w-0', item.wide && columns > 1 && 'sm:col-span-full')}>
          <dt className="text-meta font-medium text-fg-muted">{item.term}</dt>
          <dd className="mt-1 text-[0.9375rem] leading-snug font-medium break-words text-fg">{item.description}</dd>
        </div>
      ))}
    </dl>
  )
}
