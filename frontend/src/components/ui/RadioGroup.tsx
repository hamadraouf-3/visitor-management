import { Check, CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { ACCENT_FILL_EDGE } from './buttonStyles'

export interface RadioOption<T extends string> {
  value: T
  label: ReactNode
  /** Second line under the label (`list` variant only). */
  description?: ReactNode
  disabled?: boolean
}

export interface RadioGroupProps<T extends string> {
  /** Group label, rendered as the fieldset legend. */
  label: ReactNode
  options: readonly RadioOption<T>[]
  /** Selected value; null while nothing has been chosen. */
  value: T | null
  onValueChange: (value: T) => void
  /** Help text, linked to the group with aria-describedby. */
  hint?: ReactNode
  /** Error message; marks the group aria-invalid and is linked with aria-describedby. */
  error?: ReactNode
  /** Marks the group `aria-required` (nothing is drawn: forms mark only optional fields). */
  required?: boolean
  disabled?: boolean
  /**
   * `list`: stacked radios with optional descriptions. `segmented`: a wrapping row of
   * button-like options for quick picks (walk-in reason, check-in option).
   */
  variant?: 'list' | 'segmented'
  /** `xl` gives touch-sized segments for reception tablets (`segmented` only). */
  size?: 'md' | 'xl'
  /**
   * `segmented` only. `wrap` (default): segments as wide as their text, wrapping into rows.
   * `grid`: equal-width segments, two per row on phones and three from `sm`, so a set of
   * quick picks lines up instead of wrapping into ragged rows.
   */
  layout?: 'wrap' | 'grid'
  /** Shared `name` of the radios; generated when omitted. */
  name?: string
  id?: string
  className?: string
}

/**
 * Single choice from a few visible options. Native radios in a fieldset: arrow keys move
 * and select within the group, Tab enters and leaves it, and assistive technology gets the
 * group name, hint and error. The selected segment shows a check mark (never color alone).
 */
export function RadioGroup<T extends string>({
  label,
  options,
  value,
  onValueChange,
  hint,
  error,
  required = false,
  disabled = false,
  variant = 'list',
  size = 'md',
  layout = 'wrap',
  name,
  id,
  className,
}: RadioGroupProps<T>) {
  const groupId = useStableId('radio-group', id)
  const groupName = name ?? groupId
  const legendId = `${groupId}-legend`
  const hintId = hint ? `${groupId}-hint` : undefined
  const errorId = error ? `${groupId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <fieldset
      id={groupId}
      role="radiogroup"
      aria-labelledby={legendId}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      aria-required={required || undefined}
      disabled={disabled}
      className={cn('min-w-0', className)}
    >
      {/* Like Field: only optional questions are marked; `required` is announced, not drawn. */}
      <legend id={legendId} className="mb-1.5 text-sm font-semibold text-fg">
        {label}
      </legend>
      {hint && (
        <p id={hintId} className="mb-2 text-sm text-fg-muted">
          {hint}
        </p>
      )}

      <div
        className={
          variant !== 'segmented' ? 'flex flex-col gap-3' : layout === 'grid' ? 'grid grid-cols-2 gap-2 sm:grid-cols-3' : 'flex flex-wrap gap-2'
        }
      >
        {options.map((option, index) => {
          const inputId = `${groupId}-option-${index}`
          const checked = option.value === value
          const input = (
            <input
              id={inputId}
              type="radio"
              name={groupName}
              value={option.value}
              checked={checked}
              disabled={option.disabled}
              aria-labelledby={variant === 'list' ? `${inputId}-label` : undefined}
              aria-describedby={variant === 'list' && option.description ? `${inputId}-description` : undefined}
              onChange={() => onValueChange(option.value)}
              className={
                variant === 'segmented'
                  ? 'sr-only'
                  : // 24 px like the kit's checkbox (WCAG 2.2 SC 2.5.8), centred on the label's first line.
                    '-my-0.5 size-6 shrink-0 cursor-pointer accent-accent-strong disabled:cursor-not-allowed'
              }
            />
          )

          if (variant === 'segmented') {
            return (
              <label
                key={option.value}
                htmlFor={inputId}
                className={cn(
                  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-control border text-center font-semibold select-none',
                  size === 'xl' ? 'min-h-14 px-5 text-base' : 'min-h-11 px-4 text-sm',
                  checked
                    ? cn('border-accent bg-accent text-on-accent hover:bg-accent-hover', ACCENT_FILL_EDGE)
                    : 'border-border-strong bg-surface text-fg hover:bg-surface-muted',
                  // The radio itself is visually hidden, so its focus ring is drawn on the segment.
                  'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
                  'has-disabled:cursor-not-allowed has-disabled:opacity-60',
                )}
              >
                {input}
                {checked && <Check aria-hidden="true" className="size-4 shrink-0" />}
                {option.label}
              </label>
            )
          }

          // The whole row (radio, label and description) is one tap target, at least 44 px tall
          // on touch screens. The name is the label only; the description stays the description.
          const unavailable = option.disabled || disabled
          return (
            <label
              key={option.value}
              className={cn('flex items-start gap-3 pointer-coarse:min-h-11', unavailable ? 'cursor-not-allowed' : 'cursor-pointer')}
            >
              {input}
              <span className="flex flex-col gap-0.5">
                <span id={`${inputId}-label`} className={cn('text-sm font-medium', unavailable ? 'text-fg-muted' : 'text-fg')}>
                  {option.label}
                </span>
                {option.description && (
                  <span id={`${inputId}-description`} className="text-sm text-fg-muted">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>

      {error && (
        <p id={errorId} className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  )
}
