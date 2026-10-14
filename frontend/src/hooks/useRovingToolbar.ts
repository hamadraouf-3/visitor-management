import { useRef, useState, type KeyboardEvent } from 'react'

/**
 * The keyboard of a WAI-ARIA toolbar (APG "Toolbar"): the row of controls is one tab stop, the arrow
 * keys move between its controls in the reading direction (Right is "next" in English, Left in
 * Arabic; both wrap), Home and End jump to the first and the last. Tab comes back to the control that
 * was focused last (roving `tabindex`).
 *
 * Spread `toolbarProps` on the element that holds the controls (give it an accessible name) and
 * `itemProps(index)` on each control, in their visual order.
 */
export function useRovingToolbar(count: number) {
  const [current, setCurrent] = useState(0)
  const items = useRef<(HTMLElement | null)[]>([])
  // The tab stop stays inside the row when it loses controls.
  const active = Math.min(current, Math.max(count - 1, 0))

  const focusItem = (index: number) => {
    setCurrent(index)
    items.current[index]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (count === 0) return
    const focused = items.current.indexOf(event.target as HTMLElement)
    const from = focused >= 0 && focused < count ? focused : active
    // In right-to-left text the next control is on the left (WAI-ARIA APG).
    const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl'
    const next = (from + 1) % count
    const previous = (from - 1 + count) % count
    switch (event.key) {
      case 'ArrowRight':
        focusItem(rtl ? previous : next)
        break
      case 'ArrowLeft':
        focusItem(rtl ? next : previous)
        break
      case 'Home':
        focusItem(0)
        break
      case 'End':
        focusItem(count - 1)
        break
      default:
        return
    }
    event.preventDefault()
  }

  return {
    toolbarProps: { role: 'toolbar' as const, onKeyDown },
    itemProps: (index: number) => ({
      tabIndex: index === active ? 0 : -1,
      ref: (element: HTMLElement | null) => {
        items.current[index] = element
      },
      onFocus: () => setCurrent(index),
    }),
  }
}
