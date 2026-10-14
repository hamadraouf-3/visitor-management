import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { tabId, tabPanelId } from './tabIds'

export interface TabItem<T extends string> {
  value: T
  label: ReactNode
  /** Count or status shown after the label. */
  badge?: ReactNode
  /** `warning` draws attention to the badge (e.g. items that need action); default neutral. */
  badgeTone?: 'neutral' | 'warning'
  disabled?: boolean
}

export interface TabsProps<T extends string> {
  /** Shared prefix for tab/panel ids; pass the same value to each TabPanel. */
  idBase: string
  /** Accessible name of the tab list. */
  label: string
  items: readonly TabItem<T>[]
  value: T
  /**
   * To keep the selected tab in the URL, read it with `readEnumParam` and write it with
   * `useUrlParams` (hooks/useUrlParams), together with any other parameter the change resets
   * (e.g. the page), in one navigation.
   */
  onValueChange: (value: T) => void
  /** `xl` gives touch-sized tabs (reception tablets). */
  size?: 'md' | 'xl'
  /**
   * Below `sm`: `scroll` (default) keeps one row that scrolls sideways when the tabs do not
   * fit; `grid` lays them out two per row as outlined segments, so every tab is visible (for
   * four tabs whose labels and counts cannot share one phone-width row).
   */
  phoneLayout?: 'scroll' | 'grid'
  className?: string
}

/**
 * WAI-ARIA tabs with automatic activation: the arrow keys move and select in the reading
 * direction (Right moves forward in English, Left in Arabic; both wrap), Home/End jump to the
 * first/last tab; only the selected tab is in the Tab order.
 *
 * Direction C's segmented control: the tabs sit on a track, and the selected one is raised (white
 * on the light content area, mawdoo3's turquoise on dark surfaces) with a bolder label.
 *
 * When the tabs do not fit (phones), the list scrolls sideways: the selected tab is scrolled
 * into view, and shadows at the edges show that more tabs lie beyond. With `phoneLayout="grid"`
 * they wrap into a two-column grid on phones instead; the selected one has a thicker border.
 */
export function Tabs<T extends string>({
  idBase,
  label,
  items,
  value,
  onValueChange,
  size = 'md',
  phoneLayout = 'scroll',
  className,
}: TabsProps<T>) {
  const grid = phoneLayout === 'grid'
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<T, HTMLButtonElement>())
  const enabled = items.filter((item) => !item.disabled)

  // Only the list scrolls (never the page, as scrollIntoView could). The list is the tabs'
  // offset parent (`relative`), so offsetLeft is measured from its start; in right-to-left
  // text the overflowing tabs lie at negative offsets and `scrollLeft` runs from 0 down, so the
  // same arithmetic holds. Sizes change after mount (badges arrive with their counts, the window
  // is resized), so the selected tab is revealed again whenever the list or a tab changes size;
  // a user's own scrolling is kept.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const revealSelected = () => {
      const tab = tabRefs.current.get(value)
      if (!tab || list.scrollWidth <= list.clientWidth) return
      const start = tab.offsetLeft
      const end = start + tab.offsetWidth
      if (start < list.scrollLeft) list.scrollLeft = start
      else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth
    }
    revealSelected()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(revealSelected)
    observer.observe(list)
    for (const tab of tabRefs.current.values()) observer.observe(tab)
    return () => observer.disconnect()
  }, [value])

  const select = (next: TabItem<T> | undefined) => {
    if (!next) return
    onValueChange(next.value)
    tabRefs.current.get(next.value)?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = enabled.findIndex((item) => item.value === value)
    const next = () => select(enabled[(index + 1) % enabled.length])
    const previous = () => select(enabled[(index - 1 + enabled.length) % enabled.length])
    // In right-to-left text the next tab is on the left (WAI-ARIA APG, tabs).
    const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl'
    switch (event.key) {
      case 'ArrowRight':
        if (rtl) previous()
        else next()
        break
      case 'ArrowLeft':
        if (rtl) next()
        else previous()
        break
      case 'Home':
        select(enabled[0])
        break
      case 'End':
        select(enabled[enabled.length - 1])
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    // The track. Its colour also covers the scroll shadows; the tab list inside it is what scrolls.
    // It hugs its segments as C's compact group (never wider than its container, where the list
    // scrolls); the phone grid spans the width. A screen that wants a full-width track passes `w-full`.
    <div
      data-tabs-track=""
      className={cn('w-fit max-w-full rounded-[0.875rem] bg-tab-track p-1', grid && 'max-sm:w-full max-sm:bg-transparent max-sm:p-0', className)}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        className={cn(
          'scroll-shadow-x relative flex gap-1 overflow-x-auto [--scroll-shadow-cover:var(--color-tab-track)]',
          // Nothing to scroll in the grid; `visible` keeps the focus rings of the outer tabs unclipped, and
          // no scroll shadows: on the bare page their cover (the track's colour) drew bands at the edges.
          grid && 'max-sm:grid max-sm:grid-cols-2 max-sm:gap-2 max-sm:overflow-visible max-sm:bg-none',
        )}
      >
        {items.map((item) => {
          const selected = item.value === value
          return (
            <button
              key={item.value}
              ref={(element) => {
                if (element) tabRefs.current.set(item.value, element)
                else tabRefs.current.delete(item.value)
              }}
              type="button"
              role="tab"
              id={tabId(idBase, item.value)}
              aria-selected={selected}
              // Only the selected panel is mounted, so only its tab may reference it.
              aria-controls={selected ? tabPanelId(idBase, item.value) : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.value)}
              onKeyDown={handleKeyDown}
              className={cn(
                'inline-flex shrink-0 items-center justify-center gap-2 rounded-item whitespace-nowrap transition-colors',
                size === 'xl' ? 'min-h-14 px-5 text-base' : 'min-h-11 px-4 text-sm',
                selected
                  ? // The ring on the raised segment takes its text colour (ink: 15.42:1 on white, 7.31:1 on turquoise).
                    'bg-tab-selected font-semibold text-on-tab-selected shadow-raise focus-visible:outline-on-tab-selected'
                  : 'font-medium text-fg-secondary hover:bg-surface/60 hover:text-fg',
                // White on the light track is 1.22:1: the raised segment's teal edge is what marks it
                // (4.70:1 against the segment, 3.85:1 against the track; WCAG 1.4.11). On dark surfaces
                // the edge has the segment's own colour. The phone grid has its own 2 px border.
                selected && (grid ? 'sm:ring-1 sm:ring-tab-indicator sm:ring-inset' : 'ring-1 ring-tab-indicator ring-inset'),
                // Phones, grid: outlined segments; the selected one keeps its raised fill (white here, turquoise
                // on dark surfaces, so its label keeps 15.42:1 / 7.31:1) and is marked by a 2 px accent border,
                // not colour alone. Its focus ring lies outside it, on the page: the focus colour, not its text's.
                // 44 px tall there (the touch minimum) whatever the size, so two rows of tabs stay compact.
                grid && 'max-sm:min-h-11 max-sm:rounded-control max-sm:px-3 max-sm:shadow-none',
                grid &&
                  (selected
                    ? 'max-sm:border-2 max-sm:border-accent-strong max-sm:focus-visible:outline-focus'
                    : 'max-sm:border max-sm:border-border-strong max-sm:bg-surface'),
                // The scrolling list clips whatever lies outside it, the global ring (2 px outside the
                // tab) included: the ring is drawn inside the tab. The phone grid does not scroll, so
                // its segments keep the ring outside them.
                grid ? 'sm:focus-visible:-outline-offset-4' : 'focus-visible:-outline-offset-4',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {item.label}
              {/* A space for the accessible name ("Today 2", not "Today2"); flex layout ignores it. */}
              {item.badge !== undefined && ' '}
              {item.badge !== undefined && (
                <span
                  className={cn(
                    'min-w-6 rounded-full px-2 py-0.5 text-center font-numeric text-xs font-semibold tabular-nums',
                    item.badgeTone === 'warning'
                      ? // Needs action: mawdoo3's yellow with ink text (8.74:1), as in direction C.
                        'bg-attention text-on-attention'
                      : selected
                        ? 'bg-surface-muted text-fg'
                        : 'bg-border text-fg-secondary',
                  )}
                >
                  {item.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export interface TabPanelProps {
  idBase: string
  value: string
  /** The currently selected tab value. */
  selected: string
  children: ReactNode
  className?: string
}

/** Only the selected panel is rendered; the others are unmounted (no hidden stale content). */
export function TabPanel({ idBase, value, selected, children, className }: TabPanelProps) {
  if (value !== selected) return null
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idBase, value)}
      aria-labelledby={tabId(idBase, value)}
      tabIndex={0}
      className={cn('pt-4 focus-visible:outline-offset-4', className)}
    >
      {children}
    </div>
  )
}
