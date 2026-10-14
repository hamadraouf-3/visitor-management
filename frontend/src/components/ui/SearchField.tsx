import { Search, X } from 'lucide-react'
import { useRef, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { controlClassName } from './fieldContext'

export interface SearchFieldProps {
  /** Accessible name; also shown above the field unless `labelHidden`. */
  label: string
  labelHidden?: boolean
  value: string
  onValueChange: (value: string) => void
  /** Enter: run the search now instead of after the debounce. */
  onSubmit?: () => void
  /** Shows a clear button while the field has text. */
  onClear?: () => void
  placeholder?: string
  /** Help text, linked with aria-describedby. */
  hint?: string
  /**
   * `always` (default) shows the hint under the field. `sm` shows it from the `sm` breakpoint
   * on; on phones it is only the input's accessible description, which saves a line where
   * the field shares its row with another control.
   */
  hintVisibility?: 'always' | 'sm'
  /** The input element, e.g. to move focus back to the field after the list below it changed. */
  inputRef?: RefObject<HTMLInputElement | null>
  className?: string
}

/**
 * Search box for list pages: a `role="search"` landmark named by the field's label (a screen
 * may hold several, e.g. reception's visitor search and a tab's filter, and landmark
 * navigation must tell them apart), with a labelled `type="search"` input, a decorative icon
 * and a clear button. Enter submits without reloading the page.
 */
export function SearchField({
  label,
  labelHidden = false,
  value,
  onValueChange,
  onSubmit,
  onClear,
  placeholder,
  hint,
  hintVisibility = 'always',
  inputRef: externalInputRef,
  className,
}: SearchFieldProps) {
  const { t } = useTranslation()
  const inputId = useStableId('search')
  const labelId = `${inputId}-label`
  const hintId = hint ? `${inputId}-hint` : undefined
  const ownInputRef = useRef<HTMLInputElement>(null)
  const inputRef = externalInputRef ?? ownInputRef

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit?.()
  }

  return (
    <form role="search" aria-labelledby={labelId} onSubmit={handleSubmit} className={cn('flex flex-col gap-1.5', className)}>
      <label id={labelId} htmlFor={inputId} className={labelHidden ? 'sr-only' : 'text-sm font-semibold text-fg'}>
        {label}
      </label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className={cn(controlClassName, 'ps-10', onClear && 'pe-11', '[&::-webkit-search-cancel-button]:appearance-none')}
        />
        {onClear && value && (
          <button
            type="button"
            onClick={() => {
              onClear()
              // The button disappears with the text; keep keyboard users in the field.
              inputRef.current?.focus()
            }}
            className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-control text-fg-muted hover:text-fg"
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">{t('actions.clearSearch')}</span>
          </button>
        )}
      </div>
      {hint && (
        <p id={hintId} className={cn('text-sm leading-relaxed text-fg-muted', hintVisibility === 'sm' && 'max-sm:sr-only')}>
          {hint}
        </p>
      )}
    </form>
  )
}
