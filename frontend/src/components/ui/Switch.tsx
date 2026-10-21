import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { Spinner } from './Spinner'

export interface SwitchProps {
  /** The visible name of what it turns on and off. */
  label: ReactNode
  checked: boolean
  /** Asked with the other state; the caller decides (and may confirm first). */
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  /** A change is being saved: the switch is busy and ignores presses. */
  loading?: boolean
  /** An element that says more about it, e.g. why it cannot be changed (a short state beside it). */
  'aria-describedby'?: string
  id?: string
  className?: string
}

/**
 * An on/off setting that takes effect when pressed (WAI-ARIA switch: a `button` with `role="switch"` and
 * `aria-checked`; Space and Enter press it). The state is the thumb's place, and the track's fill: on is the
 * green of the status colours (never the company's, which may be a pale yellow, F12-16) under a thumb in
 * the surface's colour (4.98:1, dark 6.75:1), off an outlined track with a grey thumb at the start. In a
 * forced-colours mode the track and thumb take the system's colours, and the thumb's place still says it.
 * The button holds the track and the words: one target, at least 44 px tall. While it cannot be changed
 * (`disabled`, or a change being saved) it stays focusable, `aria-disabled`, as the kit's buttons do.
 */
export function Switch({ label, checked, onCheckedChange, disabled = false, loading = false, id, className, 'aria-describedby': describedBy }: SwitchProps) {
  const inert = disabled || loading
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-busy={loading || undefined}
      // Focusable while it cannot be changed, so its reason (`aria-describedby`) is heard where it is.
      aria-disabled={inert || undefined}
      onClick={() => {
        if (!inert) onCheckedChange(!checked)
      }}
      className={cn(
        'group inline-flex min-h-11 max-w-full items-center gap-3 rounded-control text-start text-sm font-semibold text-fg',
        inert ? 'cursor-not-allowed' : 'cursor-pointer',
        disabled && 'opacity-60',
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-switch-track=""
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 transition-colors forced-color-adjust-none',
          checked
            ? 'border-success-solid bg-success-solid forced-colors:border-[Highlight] forced-colors:bg-[Highlight]'
            : 'border-border-strong bg-surface forced-colors:border-[CanvasText] forced-colors:bg-[Canvas]',
        )}
      >
        <span
          data-switch-thumb=""
          className={cn(
            'absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-[inset-inline-start] motion-reduce:transition-none',
            checked ? 'start-[1.375rem] bg-surface forced-colors:bg-[HighlightText]' : 'start-0.5 bg-neutral-solid forced-colors:bg-[CanvasText]',
          )}
        />
      </span>
      <span className="min-w-0 break-words">{label}</span>
      {loading && <Spinner size="sm" decorative />}
    </button>
  )
}
