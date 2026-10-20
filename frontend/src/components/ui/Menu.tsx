import type { LucideIcon } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { Spinner } from './Spinner'

/**
 * `mirrorIcon`: the icon is directional (sign out, an arrow) and is mirrored in right-to-left text.
 * `to` is a page of the app; `href` an address outside it, opened in a new tab (Phase 14: a calendar's
 * new-event form), which its name tells a screen reader; an `https:` address only, never a script's or
 * a data address.
 */
export type MenuItem =
  | { id: string; label: string; icon?: LucideIcon; mirrorIcon?: boolean; to: string }
  | { id: string; label: string; icon?: LucideIcon; mirrorIcon?: boolean; href: `https://${string}` }
  | { id: string; label: string; icon?: LucideIcon; mirrorIcon?: boolean; onSelect: () => void; tone?: 'default' | 'danger' }

/** What a caller may do to its menu from outside it. */
export interface MenuControl {
  /** Closes the menu if it is open (and stops a load); the focus it had goes back to the trigger. */
  close: () => void
}

export type MenuProps = {
  /** Content of the trigger button. */
  trigger: ReactNode
  /** The trigger's leading icon (decorative), as the `Button`'s: the kit's spinner takes its place while `loadItems` runs. */
  triggerIcon?: ReactNode
  /** Accessible name of the trigger when its content is not descriptive text. */
  triggerLabel?: string
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
  /**
   * The popup as wide as its longest item, within its limits, instead of the room its trigger leaves it:
   * no item wraps beside a narrow trigger (Phase 14: the calendars, whose names are long in Arabic).
   */
  fitContent?: boolean
} & (
  | { items: readonly MenuItem[]; loadItems?: never; controlRef?: never }
  | {
      items?: never
      /**
       * The items, made when the menu is opened from data fetched then (Phase 14: the calendars, from the
       * visit as it is now), instead of fixed ones. Meanwhile the trigger is busy (`aria-busy`, and
       * `aria-disabled` as the loading `Button`: it keeps the focus and ignores activation), and the menu
       * opens on what comes back. Null or a failure (which the caller shows) opens nothing; neither does
       * a load overtaken by a click outside, Escape or the focus leaving the trigger.
       */
      loadItems: () => Promise<readonly MenuItem[] | null>
      /**
       * Lets the caller close the menu when the loaded items no longer say what they were made from
       * (Phase 14: the visit changed while its calendar menu was open). The next opening loads them again.
       */
      controlRef?: Ref<MenuControl>
    }
)

function itemClass(danger: boolean): string {
  return cn(
    'flex min-h-10 w-full items-center gap-3 rounded-item px-3 py-2 text-start text-sm font-medium hover:bg-surface-muted focus:bg-surface-muted pointer-coarse:min-h-11',
    danger ? 'text-danger-text' : 'text-fg',
  )
}

/**
 * Menu button (WAI-ARIA menu pattern): Enter/Space/ArrowDown open and focus the first item,
 * ArrowUp the last; arrows/Home/End move, from the item that has the focus; Enter and Space choose
 * it; Escape closes and returns focus; Tab and outside clicks close. The menu is named by its
 * trigger (`aria-labelledby`).
 */
export function Menu({
  trigger,
  triggerIcon,
  triggerLabel,
  items,
  loadItems,
  controlRef,
  align = 'end',
  placement = 'bottom',
  triggerClassName,
  header,
  fitContent = false,
}: MenuProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const [loaded, setLoaded] = useState<readonly MenuItem[]>([])
  const [loading, setLoading] = useState(false)
  const menuId = useStableId('menu')
  const triggerId = `${menuId}-trigger`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLElement | null)[]>([])
  // Each load, and each closing, takes the next number: a load that comes back after the menu was
  // closed or asked for again opens nothing.
  const request = useRef(0)
  // The link item a Space press began on (see `handleMenuKeyUp`).
  const spacePressedOn = useRef<HTMLAnchorElement | null>(null)
  const shown = loadItems ? loaded : (items ?? [])

  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus()
  }, [open, focusIndex])

  useEffect(() => {
    if (!open && !loading) return
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        request.current += 1
        setLoading(false)
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open, loading])

  /** Opens on the first or the last item; with `loadItems`, once they have come. */
  const openAt = (edge: 'first' | 'last') => {
    if (!loadItems) {
      setFocusIndex(edge === 'first' ? 0 : shown.length - 1)
      setOpen(true)
      return
    }
    if (loading) return
    const current = ++request.current
    setLoading(true)
    void loadItems()
      .catch(() => null)
      .then((next) => {
        if (current !== request.current) return
        setLoading(false)
        if (!next?.length) return
        setLoaded(next)
        setFocusIndex(edge === 'first' ? 0 : next.length - 1)
        setOpen(true)
      })
  }

  const close = (restoreFocus: boolean) => {
    request.current += 1
    spacePressedOn.current = null
    setLoading(false)
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useImperativeHandle(
    controlRef,
    () => ({
      close: () => {
        const focusInside = containerRef.current?.contains(document.activeElement) ?? false
        request.current += 1
        spacePressedOn.current = null
        setLoading(false)
        setOpen(false)
        if (focusInside) triggerRef.current?.focus()
      },
    }),
    [],
  )

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // A held key repeats its keydown: only the press opens (or keeps opening) the menu.
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt('first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt('last')
    } else if (event.key === 'Escape' && loading) {
      event.stopPropagation()
      close(false)
    }
  }

  /** The focus leaving the trigger while the items load (Tab, a click elsewhere): they open nothing. */
  const handleTriggerBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (loading && !(event.relatedTarget instanceof Node && containerRef.current?.contains(event.relatedTarget))) close(false)
  }

  /** Moves the focus to an item (also when the state already names it: a pointer may have moved the focus since). */
  const focusItem = (index: number) => {
    setFocusIndex(index)
    itemRefs.current[index]?.focus()
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A held Enter or Space repeats its keydown, and the repeats of the one that opened the menu reach
    // its first item: only a press chooses, never a repeat (Enter would follow a link on its keydown,
    // and a button would take a repeated Space as a press).
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      return
    }
    const last = shown.length - 1
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
      case ' ':
        // Space chooses a button item natively, but not a link (`to`, `href`): the page would scroll.
        if (!(event.target instanceof HTMLAnchorElement)) return
        spacePressedOn.current = event.target
        break
      default:
        return
    }
    event.preventDefault()
  }

  /**
   * A link item is chosen when Space comes up on it, as a button is: only by a press that began on it,
   * never by the release of the Space that opened the menu on it from the trigger.
   */
  const handleMenuKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== ' ') return
    const pressedOn = spacePressedOn.current
    spacePressedOn.current = null
    if (pressedOn !== null && pressedOn === event.target) {
      event.preventDefault()
      pressedOn.click()
    }
  }

  const register = (index: number) => (element: HTMLElement | null) => {
    itemRefs.current[index] = element
  }

  const rendered = shown.map((item, index) => {
    const Icon = item.icon
    const content = (
      <>
        {Icon && <Icon aria-hidden="true" className={cn('size-4 shrink-0', item.mirrorIcon && 'mirror-rtl')} />}
        {item.label}
      </>
    )
    if ('to' in item) {
      return (
        <Link key={item.id} ref={register(index)} to={item.to} role="menuitem" tabIndex={-1} onClick={() => close(false)} className={itemClass(false)}>
          {content}
        </Link>
      )
    }
    if ('href' in item) {
      // The page stays: the focus goes back to the trigger, as after an action. The name begins with the visible words.
      return (
        <a
          key={item.id}
          ref={register(index)}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          role="menuitem"
          tabIndex={-1}
          onClick={() => close(true)}
          aria-label={`${item.label} ${t('actions.opensInNewTab')}`}
          className={itemClass(false)}
        >
          {content}
        </a>
      )
    }
    return (
      <button
        key={item.id}
        ref={register(index)}
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          close(true)
          item.onSelect()
        }}
        className={itemClass(item.tone === 'danger')}
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
        aria-busy={loading || undefined}
        aria-disabled={loading || undefined}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={handleTriggerKeyDown}
        onBlur={handleTriggerBlur}
        className={triggerClassName}
      >
        {loading ? <Spinner size="sm" decorative /> : triggerIcon}
        {trigger}
      </button>
      {open && (
        <div
          className={cn(
            // Never wider than the screen it opens on: a long line in its header wraps or is cut, and the items stay in reach.
            'absolute z-40 max-w-[min(20rem,calc(100vw-1.5rem))] min-w-56 overflow-hidden rounded-control border border-border bg-surface-raised text-fg shadow-pop',
            placement === 'top' ? 'bottom-full mb-2' : 'mt-2',
            align === 'end' ? 'end-0' : 'start-0',
            fitContent && 'w-max',
          )}
        >
          {header && <div className="border-b border-border px-4 py-3">{header}</div>}
          <div id={menuId} role="menu" aria-labelledby={triggerId} tabIndex={-1} onKeyDown={handleMenuKeyDown} onKeyUp={handleMenuKeyUp} className="p-1.5">
            {rendered}
          </div>
        </div>
      )}
    </div>
  )
}
