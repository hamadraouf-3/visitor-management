import type { ChartDatum } from '../chartData'

export interface ChartReadoutProps {
  active: ChartDatum | undefined
  formatValue: (value: number) => string
}

/**
 * The chart's tooltip, in a fixed line above the plot: the value of the hovered or focused mark
 * (the value leads, the label follows), so it never covers the marks. Empty otherwise: no hint
 * on how to read a chart (decision 3 of the brand pass). Hidden from assistive technology, which
 * reads the same text as the focused mark's name.
 */
export function ChartReadout({ active, formatValue }: ChartReadoutProps) {
  return (
    <p aria-hidden="true" className="mb-1 flex min-h-6 flex-wrap items-baseline gap-x-2 text-sm print:hidden">
      {active && (
        <>
          <span className="font-semibold text-fg tabular-nums">{formatValue(active.value)}</span>
          <span className="text-fg-muted">{active.label}</span>
        </>
      )}
    </p>
  )
}
