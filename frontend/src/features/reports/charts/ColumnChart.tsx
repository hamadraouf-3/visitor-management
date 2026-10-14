import { useRef } from 'react'
import { useStableId } from '../../../hooks/useStableId'
import { useLanguage } from '../../../i18n/useLanguage'
import { cn } from '../../../utils/cn'
import { labelIndices, niceTicks, summarizeSeries, type ChartDatum } from '../chartData'
import { HatchPattern } from './ChartLegend'
import { ChartReadout } from './ChartReadout'
import { useChartCursor } from './useChartCursor'
import { PRINT_CHART_WIDTH, useChartSize } from './useChartSize'

export interface ColumnChartProps {
  data: readonly ChartDatum[]
  /** The value in words, e.g. "12 visits". */
  formatValue: (value: number) => string
  /** Accessible name of the plot (the figure's title). */
  label: string
  /**
   * `columns` (default) for short series; `line` for long ones (a year of days), where columns
   * would be hairlines.
   */
  variant?: 'columns' | 'line'
  height?: number
  /** The drawing height on paper (default: `height`); shorter, so the report fits two pages. */
  printHeight?: number
  /** The drawing width on paper (see useChartSize). */
  printWidth?: number
  /** Horizontal space one axis label needs, so labels never overlap. */
  axisLabelWidth?: number
  /** The axis labels are numbers (hours): drawn in the numeral face. */
  numericAxis?: boolean
  /**
   * Name the last mark on the axis even if that breaks the labels' rhythm (default, for dates);
   * off for an axis whose end is obvious (the hours of a day).
   */
  labelEnd?: boolean
}

const MARGIN = { top: 20, right: 8, bottom: 28 } as const
const MAX_BAR = 24
/** Approximate advance of a character at the axis text size (12 px), to keep edge labels inside the chart. */
const LABEL_CHAR_WIDTH = 7
const CORNER = 4
/** Approximate advance of a digit at the tick size, for the y-axis width. */
const DIGIT_WIDTH = 7.5

/** A column with a rounded data end and a square foot on the baseline. */
function columnPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return ''
  const r = Math.min(CORNER, width / 2, height)
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

/**
 * A single-series chart over an ordered axis (days, hours): thin teal columns (the series colour,
 * `chart-1`) or a 2 px line with a light wash, solid hairline gridlines, round y-axis ticks in the
 * numeral face, and the peak labelled directly. A mark still under way (today) is drawn as in
 * progress: a hatched column, or a hollow point on the line, never the peak (the card's
 * `ChartLegend` names it). Hovering or focusing a mark shows its value in the readout above the plot; every mark
 * is a keyboard stop (one Tab stop, arrows move) with its label and value as its accessible name.
 * On paper it is drawn at `printWidth` and `printHeight` and stretches to its box (see
 * useChartSize).
 *
 * Right to left in Arabic (as direction C draws it): time runs from the right, and the value
 * axis stands on the right. The geometry is laid out once, left to right, and mirrored: the marks
 * and hit targets through a mirroring transform, the texts by their x (`mx`), never mirrored
 * themselves. The drawing takes the UI's direction, so a text's start and end anchors are its
 * reading start and end in either language.
 */
export function ColumnChart({
  data,
  formatValue,
  label,
  variant = 'columns',
  height: screenHeight = 240,
  printHeight,
  printWidth = PRINT_CHART_WIDTH,
  axisLabelWidth = 48,
  numericAxis = false,
  labelEnd = true,
}: ColumnChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const hatchId = useStableId('chart-hatch')
  const { direction } = useLanguage()
  const rtl = direction === 'rtl'
  const { width, printing } = useChartSize(containerRef, 640, printWidth)
  const height = printing ? (printHeight ?? screenHeight) : screenHeight
  const { peak, max, partial } = summarizeSeries(data)
  const peakIndex = peak ? data.indexOf(peak) : 0
  const partialIndex = partial ? data.indexOf(partial) : -1
  const cursor = useChartCursor(data.length, peak ? peakIndex : Math.max(0, partialIndex), { rtl })
  /** A horizontal position of the left-to-right layout, as drawn. */
  const mx = (x: number) => (rtl ? width - x : x)
  const mirror = rtl ? `matrix(-1 0 0 1 ${width} 0)` : undefined

  const ticks = niceTicks(max)
  const maxTick = ticks.at(-1) ?? 1
  const left = Math.max(28, String(maxTick).length * DIGIT_WIDTH + 14)
  const plotWidth = Math.max(1, width - left - MARGIN.right)
  const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom)
  const baseline = MARGIN.top + plotHeight
  const band = plotWidth / Math.max(1, data.length)
  const barWidth = Math.max(1, Math.min(MAX_BAR, band * 0.7, band - 2))
  const xCenter = (index: number) => left + band * index + band / 2
  const yOf = (value: number) => baseline - (value / maxTick) * plotHeight
  // Room for the longest axis label (Arabic month names are long), at least `axisLabelWidth`.
  const labelSpace = Math.max(axisLabelWidth, ...data.map((datum) => [...datum.axisLabel].length * LABEL_CHAR_WIDTH + 12))
  const shownLabels = new Set(labelIndices(data.length, Math.floor(plotWidth / labelSpace), { nameEnd: labelEnd }))

  const active = cursor.active !== null ? data[cursor.active] : undefined
  const linePath = variant === 'line' ? data.map((datum, index) => `${index === 0 ? 'M' : 'L'}${xCenter(index)},${yOf(datum.value)}`).join('') : ''
  const areaPath = variant === 'line' && data.length > 0 ? `${linePath}L${xCenter(data.length - 1)},${baseline}L${xCenter(0)},${baseline}Z` : ''

  return (
    <div ref={containerRef} className="w-full">
      <ChartReadout active={active} formatValue={formatValue} />
      <svg
        role="group"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        direction={direction}
        className="block h-auto max-w-full print:w-full"
        onPointerLeave={cursor.onPointerLeave}
      >
        <defs>
          <HatchPattern id={hatchId} />
        </defs>
        {/* Gridlines and y-axis ticks: solid hairlines one step off the surface. */}
        <g aria-hidden="true">
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={mx(left)}
                x2={mx(left + plotWidth)}
                y1={yOf(tick)}
                y2={yOf(tick)}
                className={tick === 0 ? 'stroke-neutral-border' : 'stroke-chart-grid'}
                strokeWidth={1}
              />
              <text x={mx(left - 8)} y={yOf(tick)} textAnchor="end" dominantBaseline="middle" className="fill-fg-muted font-numeric text-[0.6875rem] tabular-nums">
                {tick.toLocaleString('en-GB')}
              </text>
            </g>
          ))}
          {data.map((datum, index) => {
            if (!shownLabels.has(index)) return null
            // A label centred on the last mark would run past the far edge: end it there instead.
            const halfWidth = ([...datum.axisLabel].length * LABEL_CHAR_WIDTH) / 2
            const atEnd = xCenter(index) + halfWidth > width
            return (
              <text
                key={datum.key}
                x={atEnd ? mx(width) : mx(xCenter(index))}
                y={baseline + 18}
                textAnchor={atEnd ? 'end' : 'middle'}
                className={cn('fill-fg-muted text-xs tabular-nums', numericAxis && 'font-numeric', datum.partial && 'fill-fg font-semibold')}
              >
                {datum.axisLabel}
              </text>
            )
          })}
        </g>

        {/* Marks, mirrored in right-to-left text. */}
        <g aria-hidden="true" transform={mirror}>
          {variant === 'columns' ? (
            data.map((datum, index) => {
              const d = columnPath(xCenter(index) - barWidth / 2, yOf(datum.value), barWidth, baseline - yOf(datum.value))
              return datum.partial ? (
                // A presentation attribute, not a class: a fill class would override the pattern.
                <path key={datum.key} d={d} fill={`url(#${hatchId})`} className="stroke-chart-1" strokeWidth={cursor.active === index ? 2 : 1} />
              ) : (
                <path key={datum.key} d={d} className={cn('transition-colors', cursor.active === index ? 'fill-accent-strong-hover' : 'fill-chart-1')} />
              )
            })
          ) : (
            <>
              <path d={areaPath} className="fill-chart-1/10" />
              <path d={linePath} fill="none" className="stroke-chart-1" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {partial && (
                <circle cx={xCenter(partialIndex)} cy={yOf(partial.value)} r={4} className="fill-surface stroke-chart-1" strokeWidth={2} />
              )}
              {active && cursor.active !== null && (
                <>
                  <line x1={xCenter(cursor.active)} x2={xCenter(cursor.active)} y1={MARGIN.top} y2={baseline} className="stroke-neutral-border" strokeWidth={1} />
                  <circle cx={xCenter(cursor.active)} cy={yOf(active.value)} r={4} className="fill-chart-1 stroke-surface" strokeWidth={2} />
                </>
              )}
            </>
          )}
        </g>
        {peak && (
          <text aria-hidden="true" x={mx(xCenter(peakIndex))} y={yOf(peak.value) - 6} textAnchor="middle" className="fill-fg font-numeric text-xs font-semibold tabular-nums">
            {peak.value.toLocaleString('en-GB')}
          </text>
        )}

        {/* Hit targets: the whole band of each mark, larger than the mark itself. */}
        <g transform={mirror}>
          {data.map((datum, index) => (
            <rect
              key={datum.key}
              {...cursor.targetProps(index)}
              role="img"
              aria-label={`${datum.label}: ${formatValue(datum.value)}`}
              x={left + band * index}
              y={MARGIN.top}
              width={band}
              height={plotHeight}
              className={cn('fill-transparent outline-none', cursor.focused === index && 'stroke-focus')}
              strokeWidth={cursor.focused === index ? 2 : 0}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}
