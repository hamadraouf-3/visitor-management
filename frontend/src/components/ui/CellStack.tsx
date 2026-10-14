import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

export interface CellStackProps {
  /** The main line: a name (often the row's link), a time range. */
  primary: ReactNode
  /** The line under it, smaller and muted: a company, "Left 09:41", a department. */
  secondary?: ReactNode
  /** Before both lines, e.g. an `Avatar`. */
  leading?: ReactNode
  /** The main line is a number or a time: Space Grotesk, tabular digits, medium weight. */
  numeric?: boolean
  className?: string
}

/**
 * Direction C's two-line table cell and list text: a 14.5 px semibold main line with a 12.5 px
 * muted line under it, optionally after an avatar. Use it in `Table` cells (`cell: (row) =>
 * <CellStack … />`) and in `ListRow`s, so every list reads the same.
 */
export function CellStack({ primary, secondary, leading, numeric = false, className }: CellStackProps) {
  const lines = (
    <span className={cn('flex min-w-0 flex-col', !leading && className)}>
      <span
        className={cn(
          'leading-snug break-words text-fg',
          numeric ? 'font-numeric font-medium tabular-nums' : 'text-[0.90625rem] font-semibold',
        )}
      >
        {primary}
      </span>
      {secondary && <span className="text-[0.78125rem] leading-snug break-words text-fg-muted">{secondary}</span>}
    </span>
  )
  if (!leading) return lines
  return (
    <span className={cn('flex min-w-0 items-center gap-3', className)}>
      {leading}
      {lines}
    </span>
  )
}
