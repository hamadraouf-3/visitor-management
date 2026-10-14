import { useRef, useState, type KeyboardEvent } from 'react'

/**
 * Pointer and keyboard access to the marks of a chart. Each mark has a hit target that is a
 * focusable element; only one is in the Tab order (roving tabindex), arrow keys move between
 * marks, Home/End jump to the ends. The active mark is the hovered one, else the focused one.
 *
 * `rtl`: the chart is drawn right to left (Arabic), so the next mark is on the left and Left
 * moves to it (as tabs do, WAI-ARIA APG); Down and Up keep their meaning.
 */
export function useChartCursor(count: number, initialIndex = 0, { rtl = false }: { rtl?: boolean } = {}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [tabStop, setTabStop] = useState(initialIndex)
  const targets = useRef<(SVGElement | null)[]>([])
  const stop = Math.min(Math.max(0, tabStop), Math.max(0, count - 1))

  const moveTo = (index: number) => {
    const next = Math.min(Math.max(0, index), count - 1)
    setTabStop(next)
    targets.current[next]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<SVGElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        moveTo(rtl ? index - 1 : index + 1)
        break
      case 'ArrowLeft':
        moveTo(rtl ? index + 1 : index - 1)
        break
      case 'ArrowDown':
        moveTo(index + 1)
        break
      case 'ArrowUp':
        moveTo(index - 1)
        break
      case 'Home':
        moveTo(0)
        break
      case 'End':
        moveTo(count - 1)
        break
      default:
        return
    }
    event.preventDefault()
  }

  /** Props for the hit target of mark `index`. */
  const targetProps = (index: number) => ({
    ref: (element: SVGElement | null) => {
      targets.current[index] = element
    },
    tabIndex: index === stop ? 0 : -1,
    onPointerEnter: () => setHovered(index),
    onFocus: () => {
      setFocused(index)
      setTabStop(index)
    },
    onBlur: () => setFocused((current) => (current === index ? null : current)),
    onKeyDown: (event: KeyboardEvent<SVGElement>) => handleKeyDown(event, index),
  })

  return {
    active: hovered ?? focused,
    focused,
    targetProps,
    /** For the plot: leaving it with the pointer ends the hover. */
    onPointerLeave: () => setHovered(null),
  }
}
