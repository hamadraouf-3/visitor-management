import { ChevronsUpDown, Search } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { controlClassName, useControlA11yProps } from './fieldContext'
import { Spinner } from './Spinner'

export interface ComboboxProps<T> {
  /** The selected option. */
  value: T | null
  onChange: (value: T | null) => void
  options: readonly T[]
  getOptionKey: (option: T) => string
  /** Text placed in the input when the option is selected. */
  getOptionLabel: (option: T) => string
  /**
   * Richer option content (e.g. name + department + phone). `query` is the text the options
   * are filtered by ('' while browsing the full list), e.g. to highlight the match.
   */
  renderOption?: (option: T, query: string) => ReactNode
  /**
   * Text the options should match; the owner loads them (see AsyncCombobox). Also called on
   * open: with '' when the field still shows the selected option (browse the full list).
   */
  onQueryChange?: (query: string) => void
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  errorMessage?: string | null
  emptyMessage?: string
  /** Shown instead of results when no search runs yet (e.g. query too short). */
  idleMessage?: string | null
  placeholder?: string
  /**
   * `select` (default): a picker with a value (e.g. the host). A click in the field or on the
   * chevron opens the full list with the current option highlighted; typing filters it.
   * `search`: a search box (e.g. returning visitors) with a magnifier icon; the list opens
   * when the user types.
   */
  variant?: 'select' | 'search'
  disabled?: boolean
  id?: string
  name?: string
  invalid?: boolean
  'aria-describedby'?: string
  className?: string
}

/**
 * Editable combobox with a listbox popup (WAI-ARIA 1.2 pattern, list autocomplete).
 * Arrow keys move through options, Enter selects, Escape closes the popup (without closing
 * a surrounding dialog), Tab and blur close it and restore the selected option's label.
 * Clearing the text and leaving the field clears the selection.
 *
 * Opening the popup while the field still shows the selected option browses the full list
 * (the selected label is not used as a filter); the selected option is the active one once
 * the list shows. Filtering starts with the first typed character.
 *
 * Only options the user can see are reachable: while the popup shows a loading, error, idle
 * or empty state, arrows and Enter do nothing and there is no active descendant, and the
 * active option is reset whenever the visible list changes (to the selected option while
 * browsing, otherwise to none). Enter never submits the surrounding form while the popup is
 * open (the typed text is not a selection yet).
 */
export function Combobox<T>({
  value,
  onChange,
  options,
  getOptionKey,
  getOptionLabel,
  renderOption,
  onQueryChange,
  onOpenChange,
  loading = false,
  errorMessage,
  emptyMessage,
  idleMessage,
  placeholder,
  variant = 'select',
  disabled,
  id,
  name,
  invalid,
  'aria-describedby': describedBy,
  className,
}: ComboboxProps<T>) {
  const { t } = useTranslation()
  const a11y = useControlA11yProps({ id, 'aria-describedby': describedBy, invalid })
  const listboxId = useStableId('combobox-listbox')
  const valueKey = value === null ? null : getOptionKey(value)
  const selectedLabel = value === null ? '' : getOptionLabel(value)

  const [query, setQuery] = useState(selectedLabel)
  const [synced, setSynced] = useState({ key: valueKey, label: selectedLabel })
  const [open, setOpenState] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  // Opened while the field shows the selected option: list everything, not matches of its label.
  const [browsing, setBrowsing] = useState(false)
  const filterText = browsing ? '' : query

  // Adopt externally changed selections (derived-state reset during render): a new selection,
  // or the same one under a new label (its record loaded, e.g. a filter opened from a link),
  // unless the user is typing over it.
  if (valueKey !== synced.key || selectedLabel !== synced.label) {
    if (valueKey !== synced.key || query === synced.label) setQuery(selectedLabel)
    setSynced({ key: valueKey, label: selectedLabel })
  }

  const setOpen = (next: boolean) => {
    if (next === open) return
    setOpenState(next)
    setActiveIndex(-1)
    onOpenChange?.(next)
  }

  const showResults = !loading && !errorMessage && !idleMessage
  // While results are hidden, `options` may still hold the previous search's matches
  // (AsyncCombobox keeps them to avoid flicker); they must not be selectable unseen.
  const navigable = open && showResults && options.length > 0

  // Identity of the list the user can navigate; a new list (or none) starts with no active
  // option, or with the selected one while browsing (it is visible in that list).
  const navigationKey = navigable ? options.map(getOptionKey).join('\u0000') : null
  const [syncedNavigationKey, setSyncedNavigationKey] = useState(navigationKey)
  if (navigationKey !== syncedNavigationKey) {
    setSyncedNavigationKey(navigationKey)
    setActiveIndex(navigable && browsing && valueKey !== null ? options.findIndex((option) => getOptionKey(option) === valueKey) : -1)
  }

  const optionId = (index: number) => `${listboxId}-option-${index}`
  const activeOptionId = navigable && activeIndex >= 0 && activeIndex < options.length ? optionId(activeIndex) : undefined

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])

  const select = (option: T) => {
    onChange(option)
    setSynced({ key: getOptionKey(option), label: getOptionLabel(option) })
    setQuery(getOptionLabel(option))
    setOpen(false)
  }

  const openPopup = () => {
    if (open || disabled) return
    const browse = query === selectedLabel
    setBrowsing(browse)
    onQueryChange?.(browse ? '' : query)
    setOpen(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) {
          openPopup()
          return
        }
        if (navigable) setActiveIndex((index) => Math.min(index + 1, options.length - 1))
        return
      case 'ArrowUp':
        if (!open) return
        event.preventDefault()
        if (navigable) setActiveIndex((index) => Math.max(index - 1, 0))
        return
      case 'Enter': {
        if (!open) return
        event.preventDefault()
        const option = navigable && activeIndex >= 0 ? options[activeIndex] : undefined
        if (option !== undefined) select(option)
        return
      }
      case 'Escape':
        if (open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
        return
      case 'Tab':
        setOpen(false)
        return
      default:
        return
    }
  }

  const handleBlur = () => {
    setOpen(false)
    if (query.trim() === '') {
      if (value !== null) onChange(null)
      setQuery('')
      return
    }
    setQuery(selectedLabel)
  }

  const statusMessage = loading
    ? t('app.loading')
    : errorMessage
      ? errorMessage
      : idleMessage
        ? idleMessage
        : options.length === 0
          ? (emptyMessage ?? t('combobox.noMatches'))
          : null
  const liveMessage = !open ? '' : (statusMessage ?? t('combobox.results', { count: options.length }))

  return (
    <div className={cn('relative', className)}>
      {variant === 'search' && (
        <Search aria-hidden="true" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
      )}
      <input
        {...a11y}
        name={name}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={query}
        onClick={variant === 'select' ? openPopup : undefined}
        onChange={(event) => {
          setQuery(event.target.value)
          setBrowsing(false)
          onQueryChange?.(event.target.value)
          if (!open) {
            setOpenState(true)
            onOpenChange?.(true)
          }
          setActiveIndex(-1)
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={cn(controlClassName, variant === 'search' ? 'ps-10' : 'pe-11')}
      />
      {variant === 'select' && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? t('combobox.hideOptions') : t('combobox.showOptions')}
          disabled={disabled}
          // Keep focus in the input so blur handling does not run.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (open ? setOpen(false) : openPopup())}
          // 44 px wide, as tall as the control: a full touch target.
          className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-fg-muted disabled:cursor-not-allowed"
        >
          <ChevronsUpDown aria-hidden="true" className="size-4" />
        </button>
      )}

      <div
        hidden={!open}
        role="presentation"
        // Clicking inside the popup must not blur the input.
        onMouseDown={(event) => event.preventDefault()}
        className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-control border border-border bg-surface-raised py-1.5 shadow-pop"
      >
        {statusMessage && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-fg-muted">
            {loading && <Spinner size="sm" decorative />}
            {statusMessage}
          </div>
        )}
        {/*
          The list scrolls itself, not the popup around it: a scrolling region must be focusable
          (axe scrollable-region-focusable). tabIndex -1 adds no Tab stop; focus stays on the input
          (the popup's mousedown handler keeps it there), and the active option is scrolled into view.
        */}
        <div role="listbox" id={listboxId} aria-label={t('combobox.options')} hidden={!navigable} tabIndex={-1} className="max-h-72 overflow-y-auto">
          {options.map((option, index) => {
            const key = getOptionKey(option)
            const selected = key === valueKey
            const active = index === activeIndex
            return (
              // Pointer selection; keyboard selection is handled on the input (aria-activedescendant).
              // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
              <div
                key={key}
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                // Never focused (focus stays on the input); the popup's mousedown handler prevents it.
                tabIndex={-1}
                onClick={() => select(option)}
                onMouseMove={() => setActiveIndex(index)}
                className={cn(
                  'mx-1.5 cursor-pointer rounded-item px-3 py-2 text-sm text-fg',
                  active && 'bg-accent-surface',
                  selected && 'font-semibold',
                )}
              >
                {renderOption ? renderOption(option, filterText) : getOptionLabel(option)}
              </div>
            )
          })}
        </div>
      </div>
      <span role="status" className="sr-only">
        {liveMessage}
      </span>
    </div>
  )
}
