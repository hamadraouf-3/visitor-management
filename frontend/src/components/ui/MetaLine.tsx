import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

export interface MetaLineProps {
  /** Facts in a row (a date, "Updated 11:20", a count); empty items are left out. */
  items: readonly ReactNode[]
  /**
   * Below `sm` one fact per line, without separators (for facts too long to share a phone-width
   * line, such as a date range).
   */
  stackOnPhones?: boolean
  className?: string
}

/**
 * A line of facts separated by small dots (direction C's line under a page title: "Wed 7 Oct
 * 2026 · Updated 11:20"). Data only, never an explanation. `PageHeader` takes it as `meta`.
 *
 * A dot never ends or starts a line when the facts wrap (a long slug stranded one at 1440 px: UX
 * review L13): each fact carries its dot in the room before it, the row starts that room's width
 * outside the line, and the line clips there, so the first fact of every line shows none. A fact
 * with a direction of its own (a slug, an address: `dir="ltr"` in the Arabic UI) that wraps keeps
 * its lines on the side the line of facts starts from (`text-align-parent`, index.css).
 */
export function MetaLine({ items, stackOnPhones = false, className }: MetaLineProps) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== false && item !== '')
  if (visible.length === 0) return null
  return (
    // Clipped 4 px outside the text on both sides, so a focus ring of a fact at an edge stays whole.
    <p className={cn('-mx-1 overflow-x-clip px-1 text-sm text-fg-secondary', className)}>
      <span className={cn('-ms-6 flex flex-wrap items-center gap-y-1', stackOnPhones && 'max-sm:ms-0 max-sm:flex-col max-sm:items-start max-sm:gap-y-0.5')}>
        {visible.map((item, index) => (
          <span
            key={index}
            data-meta-item=""
            className={cn(
              'relative inline-flex min-w-0 items-center gap-1.5 ps-6 [&>[dir]]:text-align-parent',
              'before:absolute before:start-2.5 before:top-1/2 before:size-1 before:-translate-y-1/2 before:rounded-full before:bg-border-strong',
              stackOnPhones && 'max-sm:ps-0 max-sm:before:hidden',
            )}
          >
            {item}
          </span>
        ))}
      </span>
    </p>
  )
}
