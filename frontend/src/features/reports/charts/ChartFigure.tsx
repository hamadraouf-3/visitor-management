import { Table2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { useStableId } from '../../../hooks/useStableId'
import { cn } from '../../../utils/cn'

export interface ChartTableRow {
  key: string
  label: string
  value: string
}

export interface ChartFigureProps {
  title: string
  /**
   * One or two sentences that state what the chart shows: its accessible description, read by
   * assistive technology and never shown (decision 3 of the brand pass: no notes under a title).
   */
  summary: string
  /**
   * The one figure the chart is summed up by, at the end of the header (direction C's "79 visits"
   * beside a chart's title), e.g. the daily average or the busiest hour. Data, never a sentence.
   */
  figure?: { label: string; value: string }
  /** Under the drawing, at the start of the card's foot: a `ChartLegend` naming marks drawn differently. */
  legend?: ReactNode
  /** The chart's data as a two-column table: always available to assistive technology, shown on request. */
  table: { columns: readonly [string, string]; rows: readonly ChartTableRow[] }
  children: ReactNode
  className?: string
}

/**
 * A chart in direction C's card: the title and the headline figure in one row, the drawing, then
 * the legend and "Show table" at the card's foot, and the chart's data table (the accessible
 * equivalent of the drawing, dataviz "table view"): visually hidden but read by screen readers,
 * and displayed by "Show table". The summary sentence is the figure's accessible description only.
 */
export function ChartFigure({ title, summary, figure, legend, table, children, className }: ChartFigureProps) {
  const { t } = useTranslation('reports')
  const id = useStableId('chart')
  const [tableShown, setTableShown] = useState(false)
  return (
    <figure
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-summary`}
      className={cn(
        'flex min-w-0 flex-col rounded-card border border-border bg-surface break-inside-avoid print:rounded-lg print:border-black/30',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-4 sm:px-5 sm:pt-5 print:px-3 print:pt-2">
        <h2 id={`${id}-title`} className="min-w-0 text-section font-bold break-words text-fg print:text-sm">
          {title}
        </h2>
        {figure && (
          <p className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-meta text-fg-muted print:text-[9pt]">{figure.label}</span>
            <span className="font-numeric text-lg font-semibold text-fg tabular-nums print:text-[10pt]">{figure.value}</span>
          </p>
        )}
      </div>
      <p id={`${id}-summary`} className="sr-only">
        {summary}
      </p>
      <div className="flex flex-1 flex-col px-4 pt-2 sm:px-5 print:px-3 print:pt-1">{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-2 pb-3 sm:px-5 sm:pb-4 print:px-3 print:pt-1 print:pb-2">
        {legend}
        <Button
          variant="ghost"
          size="sm"
          icon={<Table2 aria-hidden="true" />}
          onClick={() => setTableShown((shown) => !shown)}
          className="ms-auto shrink-0 -me-3 print:hidden"
        >
          {tableShown ? t('charts.hideTable') : t('charts.showTable')}
        </Button>
      </div>
      <div className="px-4 sm:px-5">
        {/* Hidden by a wrapper: a table ignores the 1 px width of `sr-only` and would widen the page. */}
        <div className={tableShown ? 'mb-4 overflow-x-auto rounded-control border border-border-subtle sm:mb-5 print:hidden' : 'sr-only'}>
          <table className="w-full border-collapse text-start text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="border-b border-border-subtle bg-surface-sunken">
              <tr>
                <th scope="col" className="px-3 py-2 text-start text-[0.78125rem] font-semibold text-fg-muted">
                  {table.columns[0]}
                </th>
                <th scope="col" className="px-3 py-2 text-end text-[0.78125rem] font-semibold text-fg-muted">
                  {table.columns[1]}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {table.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="px-3 py-1.5 text-start font-normal text-fg">
                    {row.label}
                  </th>
                  <td className="px-3 py-1.5 text-end font-numeric text-fg tabular-nums">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </figure>
  )
}
