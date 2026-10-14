import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../utils/cn'

/**
 * Custom property on the root element with the height of the sticky action bar on screen;
 * index.css reserves it (plus a margin) as the page's bottom scroll padding.
 */
export const STICKY_ACTIONS_HEIGHT = '--sticky-actions-height'

/** Room for a control's focus ring: the global `:focus-visible` outline (2 px) and its offset (2 px). */
const FOCUS_RING = 4

/** Bars on screen and their heights; the tallest is published (normally there is one). */
const mountedBars = new Map<HTMLElement, number>()

function publishHeight() {
  const root = document.documentElement
  if (mountedBars.size === 0) {
    root.style.removeProperty(STICKY_ACTIONS_HEIGHT)
    return
  }
  root.style.setProperty(STICKY_ACTIONS_HEIGHT, `${Math.ceil(Math.max(...mountedBars.values()))}px`)
}

/*
 * Revealing the whole focused field. The scroll padding brings a newly focused input, select or
 * checkbox fully above the bar, but for a text area the browser scrolls only its caret line into
 * view: at 320 × 720 Tab left 43 of the settings' "Address" field's 90 px under the bar. So
 * once the browser has scrolled (in the next animation frame, before it is painted), a focused
 * control that a bar still covers, ring included, is scrolled into view as a whole, which
 * honours the same padding.
 *
 * Keyboard and programmatic focus (Tab, focus on the first error) only: a click or tap leaves the
 * page where it is, as the browser does, so the text under the pointer does not move while a
 * mouse button is down (that would select text).
 */
let pointerTarget: Element | null = null
let pendingReveal = 0

function onPointerDown(event: PointerEvent) {
  pointerTarget = event.target instanceof Element ? event.target : null
}

function onKeyDown() {
  pointerTarget = null
}

/** Whether the focus came from pressing the pointer on the control, or on its label. */
function focusedByPointer(control: Element): boolean {
  if (!pointerTarget) return false
  return control.contains(pointerTarget) || pointerTarget.closest('label')?.control === control
}

function onFocusIn(event: FocusEvent) {
  cancelAnimationFrame(pendingReveal)
  const control = event.target
  if (!(control instanceof HTMLElement) || focusedByPointer(control)) return
  pendingReveal = requestAnimationFrame(() => revealAboveBars(control))
}

/**
 * The element that shows the focus: the control, or for a visually hidden one (the radio of a
 * segmented choice, 1 px) the label around it, which draws the ring. The browser scrolls only
 * the 1 px radio into view, which left up to 10 px of a walk-in segment under the bar.
 */
function shownFocus(control: HTMLElement): HTMLElement {
  const box = control.getBoundingClientRect()
  if (box.width > 1 && box.height > 1) return control
  return control.closest('label') ?? control
}

function revealAboveBars(control: HTMLElement) {
  if (document.activeElement !== control) return
  const shown = shownFocus(control)
  const box = shown.getBoundingClientRect()
  for (const bar of mountedBars.keys()) {
    if (bar.contains(control)) return
    const barBox = bar.getBoundingClientRect()
    const top = Math.max(box.top - FOCUS_RING, barBox.top)
    const bottom = Math.min(box.bottom + FOCUS_RING, barBox.bottom)
    const left = Math.max(box.left, barBox.left)
    const right = Math.min(box.right, barBox.right)
    if (bottom <= top || right <= left) continue
    // Covered by the bar itself, not by something above both (a dialog).
    if (!bar.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))) continue
    // A control taller than the room between the scroll paddings (a whole tab panel) stays where
    // the browser put it: aligning one of its edges could scroll its focused part out of view.
    const root = getComputedStyle(document.documentElement)
    const room = window.innerHeight - (parseFloat(root.scrollPaddingTop) || 0) - (parseFloat(root.scrollPaddingBottom) || 0)
    if (box.height > room) return
    shown.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return
  }
}

/** While a bar is on screen (the first one mounts, the last one unmounts). */
function listen(on: boolean) {
  if (on) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return
  }
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('focusin', onFocusIn)
  cancelAnimationFrame(pendingReveal)
  pointerTarget = null
}

export interface StickyActionBarProps {
  children: ReactNode
  /** Layout of the actions (flex direction, alignment, gaps). */
  className?: string
}

/**
 * A form's action bar that stays at the bottom of the screen, edge to edge, while the form
 * scrolls (the walk-in form, the company settings), so the primary action is always in reach.
 *
 * Its height changes with the layout (on a phone the settings bar stacks a status line and two
 * full-width buttons), the text size and the zoom, so it is measured: the browser then scrolls a
 * newly focused field (Tab, focus on an error) above the bar instead of under it (WCAG 2.4.11
 * Focus Not Obscured). A focused text area, which the browser scrolls only as far as its caret,
 * is then brought fully above the bar, focus ring included.
 */
export function StickyActionBar({ children, className }: StickyActionBarProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = ref.current
    if (!bar) return
    const measure = () => {
      mountedBars.set(bar, bar.getBoundingClientRect().height)
      publishHeight()
    }
    if (mountedBars.size === 0) listen(true)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    // The border box: the bottom padding follows the safe area (a phone's home indicator).
    observer?.observe(bar, { box: 'border-box' })
    return () => {
      observer?.disconnect()
      mountedBars.delete(bar)
      publishHeight()
      if (mountedBars.size === 0) listen(false)
    }
  }, [])

  return (
    <div
      ref={ref}
      data-sticky-actions=""
      className={cn(
        'sticky bottom-0 z-10 -mx-4 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        'sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8',
        className,
      )}
    >
      {children}
    </div>
  )
}
