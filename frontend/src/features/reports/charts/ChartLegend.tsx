import { useStableId } from '../../../hooks/useStableId'

/** The in-progress texture: diagonal series lines on a light wash of the series colour (45°, dataviz). */
export function HatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
      <rect width={6} height={6} className="fill-chart-1/15" />
      <line x1={0} y1={0} x2={0} y2={6} className="stroke-chart-1" strokeWidth={2.5} />
    </pattern>
  )
}

export interface ChartLegendItem {
  label: string
  /** The mark it names, drawn as the chart draws it: a column, a hatched column, a line, a hollow point. */
  mark: 'column' | 'hatched' | 'line' | 'hollow'
}

function Swatch({ mark, hatchId }: { mark: ChartLegendItem['mark']; hatchId: string }) {
  switch (mark) {
    case 'column':
      return <rect width={12} height={12} rx={3} className="fill-chart-1" />
    case 'hatched':
      // A presentation attribute, not a class: a fill class would override the pattern.
      return <rect x={0.5} y={0.5} width={11} height={11} rx={2.5} fill={`url(#${hatchId})`} className="stroke-chart-1" strokeWidth={1} />
    case 'line':
      return <line x1={1} x2={11} y1={6} y2={6} className="stroke-chart-1" strokeWidth={2} strokeLinecap="round" />
    case 'hollow':
      return <circle cx={6} cy={6} r={4} className="fill-surface stroke-chart-1" strokeWidth={2} />
  }
}

/**
 * Direction C's legend under a chart: a small swatch of each kind of mark and its name, so a mark
 * drawn differently (today, still under way) is told by texture and words, never colour alone.
 * Its own texture definition, so it can stand anywhere in the card.
 */
export function ChartLegend({ items }: { items: readonly ChartLegendItem[] }) {
  const hatchId = useStableId('legend-hatch')
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.78125rem] text-fg-secondary">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <svg aria-hidden="true" width={12} height={12} className="shrink-0">
            {item.mark === 'hatched' && (
              <defs>
                <HatchPattern id={hatchId} />
              </defs>
            )}
            <Swatch mark={item.mark} hatchId={hatchId} />
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
  )
}
