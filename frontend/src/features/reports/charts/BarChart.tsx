import { useRef } from 'react'
import { useLanguage } from '../../../i18n/useLanguage'
import { cn } from '../../../utils/cn'
import type { ChartDatum } from '../chartData'
import { ChartReadout } from './ChartReadout'
import { useChartCursor } from './useChartCursor'
import { PRINT_CHART_WIDTH, useChartSize } from './useChartSize'

export interface BarChartProps {
  /** Largest first. */
  data: readonly ChartDatum[]
  formatValue: (value: number) => string
  /** Accessible name of the plot (the figure's title). */
  label: string
  /** The drawing width on paper (see useChartSize). */
  printWidth?: number
}

const BAR = 16
/** On paper: thinner bars in shorter rows, so a ranking of eight or more fits half a page. */
const PRINT_BAR = 12
const CORNER = 4
const VALUE_SPACE = 52
/** Approximate advance of a character at the label size, to shorten labels that do not fit. */
const CHAR_WIDTH = 7
/** Below this width labels sit above their bars instead of beside them. */
const STACK_BELOW = 480

/** A bar from the baseline at `x`, with a rounded data end on the right. */
function barPath(x: number, y: number, width: number, height: number): string {
  if (width <= 0) return ''
  const r = Math.min(CORNER, width, height / 2)
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`
}

/** The label cut to `maxChars` with an ellipsis; the full text is in the readout, the name and the table. */
function fitLabel(text: string, maxChars: number): string {
  const characters = [...text]
  return characters.length <= maxChars ? text : `${characters.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

/**
 * Horizontal bars for a ranking of named categories (departments): thin teal bars (the series
 * colour, `chart-1`) from one baseline, each with its value at the tip in the numeral face.
 * Labels sit beside the bars on wide screens and above them on phones and on paper, where the
 * chart has half the page's width and its rows are shorter.
 * Every bar is a keyboard stop with its label and value as its accessible name.
 *
 * Right to left in Arabic: labels on the right and bars growing to the left, laid out left to
 * right and mirrored as the column chart is (bars through a transform, texts by their x).
 */
export function BarChart({ data, formatValue, label, printWidth = PRINT_CHART_WIDTH }: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { direction } = useLanguage()
  const rtl = direction === 'rtl'
  const { width, printing } = useChartSize(containerRef, 640, printWidth)
  const cursor = useChartCursor(data.length, 0, { rtl })
  const mx = (x: number) => (rtl ? width - x : x)
  const mirror = rtl ? `matrix(-1 0 0 1 ${width} 0)` : undefined
  const stacked = width < STACK_BELOW
  const bar = printing ? PRINT_BAR : BAR
  // Stacked: the label line (12 px text), then the bar. On paper 34 px a row instead of 44.
  const rowHeight = stacked ? (printing ? 34 : 44) : 32
  const labelY = (index: number) => index * rowHeight + (printing ? 10 : 14)
  const labelWidth = stacked ? width : Math.min(200, Math.round(width * 0.34))
  const x0 = stacked ? 0 : labelWidth + 12
  const barSpace = Math.max(1, width - x0 - VALUE_SPACE)
  const max = Math.max(1, ...data.map((datum) => datum.value))
  const height = data.length * rowHeight + 4
  const maxChars = Math.max(4, Math.floor(labelWidth / CHAR_WIDTH))
  const barTop = (index: number) => index * rowHeight + (stacked ? (printing ? 18 : 22) : (rowHeight - bar) / 2)

  return (
    <div ref={containerRef} className="w-full">
      <ChartReadout active={cursor.active !== null ? data[cursor.active] : undefined} formatValue={formatValue} />
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
        <g aria-hidden="true">
          <line x1={mx(x0)} x2={mx(x0)} y1={0} y2={height} className="stroke-neutral-border" strokeWidth={1} />
          {data.map((datum, index) => {
            const barWidth = (datum.value / max) * barSpace
            const y = barTop(index)
            return (
              <g key={datum.key}>
                <text
                  x={mx(stacked ? 0 : labelWidth)}
                  y={stacked ? labelY(index) : y + bar / 2}
                  textAnchor={stacked ? 'start' : 'end'}
                  dominantBaseline="middle"
                  className="fill-fg-secondary text-xs"
                >
                  {fitLabel(datum.label, maxChars)}
                </text>
                <path
                  d={barPath(x0, y, barWidth, bar)}
                  transform={mirror}
                  className={cn('transition-colors', cursor.active === index ? 'fill-accent-strong-hover' : 'fill-chart-1')}
                />
                <text x={mx(x0 + barWidth + 6)} y={y + bar / 2} dominantBaseline="middle" className="fill-fg font-numeric text-xs font-semibold tabular-nums">
                  {datum.value.toLocaleString('en-GB')}
                </text>
              </g>
            )
          })}
        </g>
        <g>
          {data.map((datum, index) => (
            <rect
              key={datum.key}
              {...cursor.targetProps(index)}
              role="img"
              aria-label={`${datum.label}: ${formatValue(datum.value)}`}
              x={0}
              y={index * rowHeight}
              width={width}
              height={rowHeight}
              className={cn('fill-transparent outline-none', cursor.focused === index && 'stroke-focus')}
              strokeWidth={cursor.focused === index ? 2 : 0}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}
