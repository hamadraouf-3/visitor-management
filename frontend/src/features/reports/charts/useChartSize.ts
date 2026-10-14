import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * The width a full-width chart is drawn at for printing: the content width of A4 or Letter in
 * portrait with the browser's default margins (about 717–739 px), less the page's and the chart
 * card's padding. The SVG then stretches to the paper's exact width (`print:w-full`), so its text
 * stays close to its screen size instead of shrinking with a wide screen's drawing.
 */
export const PRINT_CHART_WIDTH = 620

/**
 * The drawing width of a chart in one of the two columns the report prints side by side
 * (department and hour): half the paper's content width, less the gap and the card's padding.
 */
export const PRINT_HALF_CHART_WIDTH = 290

/**
 * Whether the page is being printed: true from `beforeprint` (window.print() or the browser's
 * own Print) to `afterprint`. The browser lays the page out for paper right after
 * `beforeprint`, and no resize is observed in between, so the change renders synchronously,
 * inside the event.
 */
export function usePrinting(): boolean {
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    const startPrinting = () => flushSync(() => setPrinting(true))
    const stopPrinting = () => setPrinting(false)
    window.addEventListener('beforeprint', startPrinting)
    window.addEventListener('afterprint', stopPrinting)
    return () => {
      window.removeEventListener('beforeprint', startPrinting)
      window.removeEventListener('afterprint', stopPrinting)
    }
  }, [])
  return printing
}

export interface ChartSize {
  /** CSS pixels to draw at. */
  width: number
  /** The page is being printed (charts draw their paper layout). */
  printing: boolean
}

/**
 * The element's content width in CSS pixels, kept current with a ResizeObserver, so a chart
 * draws its marks and text at their real size instead of scaling a fixed drawing. `fallback`
 * applies until the first measurement (and where layout is unavailable, e.g. tests). While the
 * page is printed it is `printWidth` ({@link PRINT_CHART_WIDTH} for a chart across the paper,
 * {@link PRINT_HALF_CHART_WIDTH} for one of two side by side).
 */
export function useChartSize(ref: RefObject<HTMLElement | null>, fallback: number, printWidth: number = PRINT_CHART_WIDTH): ChartSize {
  const [width, setWidth] = useState(fallback)
  const printing = usePrinting()

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const measured = Math.floor(element.clientWidth)
      if (measured > 0) setWidth(measured)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return { width: printing ? printWidth : width, printing }
}
