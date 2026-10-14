import type { LucideIcon } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { FORCED_COLORS_CHOSEN } from './buttonStyles'

/** `mirrorIcon`: the icon is directional (sign out, an arrow) and is mirrored in right-to-left text. */
export type MenuItem =
  | { id: string; label: string; icon?: LucideIcon; mirrorIcon?: boolean; to: string }
  | { id: string; label: string; icon?: LucideIcon; mirrorIcon?: boolean; onSelect: () => void; tone?: 'default' | 'danger' }

/**
 * One choice among a few, inside the menu (WAI-ARIA `menuitemradio` items in a `group` named by
 * `label`): the device's appearance in the account menu. Choosing keeps the menu open (a click, Space)
 * so the effect is seen at once; Enter chooses and closes it, as the menu pattern has it. The group is
 * set apart from the items after it by a separator.
 */
export interface MenuRadioGroup {
  id: string
  type: 'radio-group'
  label: string
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon }[]
  onValueChange: (value: string) => void
}

export type MenuEntry = MenuItem | MenuRadioGroup

export interface MenuProps {
  /** Content of the trigger button. */
  trigger: ReactNode
  /** Accessible name of the trigger when its content is not descriptive text. */
  triggerLabel?: string
  items: readonly MenuEntry[]
  /** Which edge of the trigger the popup lines up with, in the reading direction. */
  align?: 'start' | 'end'
  /** Where the popup opens: below the trigger (default) or above it (e.g. at the bottom of a sidebar). */
  placement?: 'bottom' | 'top'
  triggerClassName?: string
  /**
   * Extra content at the top of the popup (e.g. the signed-in user's name). It is rendered
   * outside the `role="menu"` element: a menu may only contain menu items, and arrow keys
   * never visit it.
   */
  header?: ReactNode
}

function isRadioGroup(entry: MenuEntry): entry is MenuRadioGroup {
  return 'type' in entry && entry.type === 'radio-group'
}

/** How many items of the menu an entry is (each choice of a group is one). */
const sizeOf = (entry: MenuEntry) => (isRadioGroup(entry) ? entry.options.length : 1)

function itemClass(danger: boolean): string {
  return cn(
    'flex min-h-10 w-full items-center gap-3 rounded-item px-3 py-2 text-start text-sm font-medium hover:bg-surface-muted focus:bg-surface-muted pointer-coarse:min-h-11',
    danger ? 'text-danger-text' : 'text-fg',
  )
}

/**
 * Menu button (WAI-ARIA menu pattern): Enter/Space/ArrowDown open and focus the first item,
 * ArrowUp the last; arrows/Home/End move; Escape closes and returns focus; Tab and outside
 * clicks close. The menu is named by its trigger (`aria-labelledby`). Within a group of choices
 * (`MenuRadioGroup`, laid out in a row) Left and Right also move, in the reading direction.
 */
export function Menu({ trigger, triggerLabel, items, align = 'end', placement = 'bottom', triggerClassName, header }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const menuId = useStableId('menu')
  const triggerId = `${menuId}-trigger`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLElement | null)[]>([])
  const count = items.reduce((total, entry) => total + sizeOf(entry), 0)

  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus()
  }, [open, focusIndex])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const openAt = (index: number) => {
    setFocusIndex(index)
    setOpen(true)
  }

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt(0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(count - 1)
    }
  }

  /** The first index and the size of the group of choices the item at `index` belongs to, or null. */
  const groupAt = (index: number): { first: number; size: number } | null => {
    let first = 0
    for (const entry of items) {
      const size = sizeOf(entry)
      if (index < first + size) return isRadioGroup(entry) ? { first, size } : null
      first += size
    }
    return null
  }

  /** Moves the focus to an item (also when the state already names it: a pointer may have moved the focus since). */
  const focusItem = (index: number) => {
    setFocusIndex(index)
    itemRefs.current[index]?.focus()
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = count - 1
    // The item that has the focus: the one the arrows last reached, or the one a pointer pressed since.
    const focused = itemRefs.current.findIndex((element) => element === event.target)
    const current = focused >= 0 ? focused : focusIndex
    switch (event.key) {
      case 'ArrowDown':
        focusItem(current >= last ? 0 : current + 1)
        break
      case 'ArrowUp':
        focusItem(current <= 0 ? last : current - 1)
        break
      case 'ArrowRight':
      case 'ArrowLeft': {
        const group = groupAt(current)
        if (!group) return
        // In right-to-left text the next choice is on the left.
        const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl'
        const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1
        focusItem(group.first + ((current - group.first + step + group.size) % group.size))
        break
      }
      case 'Home':
        focusItem(0)
        break
      case 'End':
        focusItem(last)
        break
      case 'Escape':
        event.stopPropagation()
        close(true)
        break
      case 'Tab':
        setOpen(false)
        return
      default:
        return
    }
    event.preventDefault()
  }

  const register = (index: number) => (element: HTMLElement | null) => {
    itemRefs.current[index] = element
  }

  // The index of each entry's first item: a group of choices is as many items as it has choices.
  const starts = items.reduce<number[]>((list, _entry, position) => [...list, position === 0 ? 0 : list[position - 1]! + sizeOf(items[position - 1]!)], [])
  const rendered = items.map((entry, position) => {
    const start = starts[position]!
    if (isRadioGroup(entry)) {
      const labelId = `${menuId}-${entry.id}`
      return (
        <Fragment key={entry.id}>
          <div role="group" aria-labelledby={labelId} data-menu-group={entry.id} className="pb-1.5">
            {/* The group's name, read once through `aria-labelledby`. */}
            <p id={labelId} aria-hidden="true" className="px-3 pt-1 pb-1.5 text-xs font-semibold text-fg-muted">
              {entry.label}
            </p>
            <div className="grid grid-cols-3 gap-1">
              {entry.options.map((option, offset) => {
                const Icon = option.icon
                const checked = option.value === entry.value
                return (
                  <button
                    key={option.value}
                    ref={register(start + offset)}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    onClick={() => entry.onValueChange(option.value)}
                    onKeyDown={(event) => {
                      // Space chooses and keeps the menu open; Enter chooses and closes it (WAI-ARIA APG, menu).
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      entry.onValueChange(option.value)
                      if (event.key === 'Enter') close(true)
                    }}
                    className={cn(
                      // A tile, its symbol over its word: three of them fit the narrowest menu (14 rem) in either language.
                      'flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-item px-1 py-1.5 text-[0.8125rem] leading-tight whitespace-nowrap',
                      // The chosen one is the shell's current-page pill: the menu opens from the shell (the system's selection colours in a forced-colours mode).
                      checked ? cn('bg-accent font-semibold text-on-accent', FORCED_COLORS_CHOSEN) : 'font-medium text-fg hover:bg-surface-muted focus:bg-surface-muted',
                    )}
                  >
                    {Icon && <Icon aria-hidden="true" className="size-[1.125rem] shrink-0" />}
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
          {position < items.length - 1 && <hr className="my-1 border-border" />}
        </Fragment>
      )
    }
    const Icon = entry.icon
    const content = (
      <>
        {Icon && <Icon aria-hidden="true" className={cn('size-4 shrink-0', entry.mirrorIcon && 'mirror-rtl')} />}
        {entry.label}
      </>
    )
    if ('to' in entry) {
      return (
        <Link key={entry.id} ref={register(start)} to={entry.to} role="menuitem" tabIndex={-1} onClick={() => close(false)} className={itemClass(false)}>
          {content}
        </Link>
      )
    }
    return (
      <button
        key={entry.id}
        ref={register(start)}
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          close(true)
          entry.onSelect()
        }}
        className={itemClass(entry.tone === 'danger')}
      >
        {content}
      </button>
    )
  })

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={handleTriggerKeyDown}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={cn(
            // Never wider than the screen it opens on: a long line in its header wraps or is cut, and the items stay in reach.
            'absolute z-40 max-w-[min(20rem,calc(100vw-1.5rem))] min-w-56 overflow-hidden rounded-control border border-border bg-surface-raised text-fg shadow-pop',
            placement === 'top' ? 'bottom-full mb-2' : 'mt-2',
            align === 'end' ? 'end-0' : 'start-0',
          )}
        >
          {header && <div className="border-b border-border px-4 py-3">{header}</div>}
          <div id={menuId} role="menu" aria-labelledby={triggerId} tabIndex={-1} onKeyDown={handleMenuKeyDown} className="p-1.5">
            {rendered}
          </div>
        </div>
      )}
    </div>
  )
}
