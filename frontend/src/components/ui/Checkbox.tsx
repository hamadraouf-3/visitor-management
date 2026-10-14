import type { ComponentPropsWithRef, ReactNode } from 'react'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  label: ReactNode
  description?: ReactNode
  /**
   * Describes the box for assistive technology only, e.g. why a disabled box cannot change; on
   * screen the label carries a sign of it (a lock). No standing note under the label (the user's
   * request 8). Ignored when `description` is given.
   */
  hiddenDescription?: ReactNode
}

export function Checkbox({ label, description, hiddenDescription, id, className, disabled, ...rest }: CheckboxProps) {
  const inputId = useStableId('checkbox', id)
  const descriptionId = description || hiddenDescription ? `${inputId}-description` : undefined

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {/*
       * The box, the gap beside it and the words are one tap target: the label holds them all. A tap
       * meant for the box that lands a few pixels off it (the box alone is 24 px, with 12 px of nothing
       * between it and its words) still ticks it. On touch screens the row is padded to 44 px (20 px
       * line + 2 × 12 px), without moving its neighbours.
       */}
      <label htmlFor={inputId} data-checkbox-row="" className={cn('flex items-start gap-3 pointer-coarse:-my-3 pointer-coarse:py-3', !disabled && 'cursor-pointer')}>
        {/*
         * 24 px on every pointer (WCAG 2.2 SC 2.5.8): a 20 px box needs 24 px of clear space
         * around it, which a narrow window or 400 % zoom does not always leave. Centred on the
         * label's 20 px first line.
         */}
        <input
          {...rest}
          id={inputId}
          type="checkbox"
          disabled={disabled}
          aria-describedby={descriptionId}
          className="-my-0.5 size-6 shrink-0 cursor-pointer accent-accent-strong disabled:cursor-not-allowed"
        />
        <span className={cn('text-sm font-semibold', disabled ? 'text-fg-muted' : 'text-fg')}>{label}</span>
      </label>
      {description ? (
        // Under the words, not under the box (the box and its gap are 36 px).
        <p id={descriptionId} className="ps-9 text-sm text-fg-muted">
          {description}
        </p>
      ) : (
        hiddenDescription && (
          <span id={descriptionId} className="sr-only">
            {hiddenDescription}
          </span>
        )
      )}
    </div>
  )
}
