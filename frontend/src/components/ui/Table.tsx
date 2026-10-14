import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { Spinner } from './Spinner'
import { TABLE_STACK_CLASSES as STACK, type TableStackBreakpoint } from './tableStyles'

export interface TableColumn<T> {
  id: string
  /** Column header; also the label shown before the value in the stacked layout. */
  header: string
  cell: (row: T) => ReactNode
  align?: 'start' | 'end'
  /**
   * The card title in the stacked layout (no label). Use for the row's main link; give that
   * link `tableRowLinkProps(stackBelow)` and the whole card becomes its target.
   */
  primary?: boolean
  /** Hide the visual header text (e.g. an actions column); the header stays for screen readers. */
  headerHidden?: boolean
  /**
   * In the stacked layout: `row` (default) shows "Header  value" on its own line, the value
   * aligned to the start beside the label; `inline` shows the value without a label, flowing on one
   * line with the next inline cells (badges, a time); `hidden` leaves the column out of the
   * card (information the card repeats, e.g. the same department on every row).
   */
  stacked?: 'row' | 'inline' | 'hidden'
  /**
   * Whether the row has no value in this column. The stacked card then leaves the cell out
   * (a `row` cell's "Header —" line, an `inline` cell's empty space); the table layout still
   * shows the cell.
   */
  isEmpty?: (row: T) => boolean
  className?: string
  /** Classes for the header cell, e.g. a width (`md:w-[22%]`) for `layout="fixed"`. */
  headerClassName?: string
}

export interface TableProps<T> {
  columns: TableColumn<T>[]
  rows: T[]
  getRowKey: (row: T) => string
  /** Describes the table for assistive technology. */
  caption: string
  captionVisible?: boolean
  /** Shown instead of the table when there are no rows (typically an EmptyState). */
  empty?: ReactNode
  loading?: boolean
  /** Below this breakpoint the rows stack as cards (`lg` for wide tables, `xl` for the widest). Default `md`. */
  stackBelow?: TableStackBreakpoint
  /**
   * `fixed`: column widths come from the header cells (`headerClassName`), so columns stay
   * put between pages, tabs and searches. `fixed-xl`: the same from the `xl` breakpoint on,
   * content-sized below it, for a table whose columns need a desktop's width (give its
   * headers `xl:w-…` widths). `auto` (default): widths follow the content.
   */
  layout?: 'auto' | 'fixed' | 'fixed-xl'
  /** Draw the table's own border and background (default). Off inside a card. */
  framed?: boolean
  /**
   * Rows to highlight with a teal tint (direction C's visitor inside now, an overdue visit), in the
   * table and as a stacked card. Never the only mark: the row's status chip or text says why.
   */
  isRowHighlighted?: (row: T) => boolean
  className?: string
}

type StackClasses = (typeof STACK)[TableStackBreakpoint]

/** Whether a cell shows the "Header  value" line in the stacked layout. */
function hasStackedLabel<T>(column: TableColumn<T>): boolean {
  return !column.primary && !column.headerHidden && (column.stacked ?? 'row') === 'row'
}

function cellClasses<T>(column: TableColumn<T>, row: T, stack: StackClasses): string {
  const alignEnd = column.align === 'end' && stack.alignEnd
  if (column.primary) return stack.primaryCell
  switch (column.stacked) {
    case 'hidden':
      return cn(stack.hiddenCell, alignEnd)
    case 'inline':
      return cn(column.isEmpty?.(row) ? stack.hiddenCell : stack.inlineCell, alignEnd)
    default:
      if (column.headerHidden) return cn(stack.actionsCell, alignEnd)
      return cn(column.isEmpty?.(row) ? stack.hiddenCell : stack.rowCell, alignEnd)
  }
}

/** Stacked-layout label before a value. Hidden from assistive technology: the column header names the cell. */
function StackedLabel({ children, className }: { children: string; className: string }) {
  return (
    <span aria-hidden="true" className={cn('text-start font-medium text-fg-muted', className)}>
      {children}
    </span>
  )
}

/**
 * Semantic table on wide screens; below `stackBelow` every row becomes a stacked card with
 * "Header  value" lines, values aligned to the start beside their labels and empty values left out
 * (one DOM, no duplicated content for assistive technology).
 *
 * The explicit table roles are deliberate: the stacked layout changes `display` on the
 * table, rows and cells, and WebKit then drops native table semantics. The header row is
 * visually hidden in the stacked layout (not `display: none`) so column headers stay in the
 * accessibility tree and keep naming every cell.
 */
export function Table<T>({
  columns,
  rows,
  getRowKey,
  caption,
  captionVisible = false,
  empty,
  loading = false,
  stackBelow = 'md',
  layout = 'auto',
  framed = true,
  isRowHighlighted,
  className,
}: TableProps<T>) {
  const { t } = useTranslation()
  const stack = STACK[stackBelow]
  if (loading && rows.length === 0) {
    return (
      <div className="flex justify-center rounded-card border border-border bg-surface p-8">
        <Spinner label={t('table.loading', { caption: caption.toLowerCase() })} showLabel />
      </div>
    )
  }
  if (rows.length === 0 && empty) return <>{empty}</>

  return (
    // Positioned, so visually hidden (absolute) header text stays inside the scroll box instead of widening the page.
    <div className={cn('relative', stack.wrapper, framed && stack.frame, className)} aria-busy={loading || undefined}>
      {/* oxlint-disable jsx-a11y/no-redundant-roles, jsx-a11y/no-interactive-element-to-noninteractive-role -- the native roles must survive the display changes (see above) */}
      <table
        role="table"
        className={cn(
          'w-full border-collapse text-start text-sm',
          stack.table,
          layout === 'fixed' && stack.fixed,
          layout === 'fixed-xl' && stack.fixedXl,
        )}
      >
        <caption className={captionVisible ? 'px-4 py-3 text-start font-semibold text-fg' : 'sr-only'}>{caption}</caption>
        <thead role="rowgroup" className={cn('border-b border-border-subtle bg-surface-sunken', stack.thead)}>
          <tr role="row">
            {columns.map((column) => (
              <th
                key={column.id}
                role="columnheader"
                scope="col"
                className={cn(
                  stack.headerCell,
                  // Explicitly: a header cell centres its text unless told otherwise (the table's own
                  // alignment does not reach it).
                  'text-[0.78125rem] font-semibold whitespace-nowrap text-fg-muted',
                  column.align === 'end' ? 'text-end' : 'text-start',
                  column.headerClassName,
                )}
              >
                {column.headerHidden ? <span className="sr-only">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className={cn('divide-border', stack.tbody)}>
          {rows.map((row) => (
            <tr
              key={getRowKey(row)}
              role="row"
              data-highlighted={isRowHighlighted?.(row) || undefined}
              className={cn('align-top', stack.row, isRowHighlighted?.(row) ? 'bg-row-highlight' : stack.rowSurface)}
            >
              {columns.map((column) => (
                <td key={column.id} role="cell" className={cn(stack.cell, cellClasses(column, row, stack), column.className)}>
                  {hasStackedLabel(column) ? (
                    <>
                      <StackedLabel className={stack.label}>{column.header}</StackedLabel>
                      {/* One grid item for the value, whatever the cell renders. */}
                      <div className="min-w-0">{column.cell(row)}</div>
                    </>
                  ) : (
                    column.cell(row)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* oxlint-enable jsx-a11y/no-redundant-roles, jsx-a11y/no-interactive-element-to-noninteractive-role */}
    </div>
  )
}
