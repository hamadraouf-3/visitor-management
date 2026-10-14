import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { FieldContext } from './fieldContext'

export interface FieldProps {
  label: ReactNode
  /** Help text, linked to the control with aria-describedby. */
  hint?: ReactNode
  /**
   * Leave the hint out while the field shows an error, for a hint the error repeats in other
   * words (e.g. "Needed to email the invitation." above an error that asks for the address to
   * email the invitation). Hints that still help while correcting, such as a character count
   * or an input format, stay: that is the default.
   */
  hideHintOnError?: boolean
  /** Error message; marks the control aria-invalid and is linked with aria-describedby. */
  error?: ReactNode
  /**
   * Marks the control `aria-required`. Nothing is added to the label: forms mark only their
   * optional fields (`optional`), so a field without a marker is one the user must fill.
   */
  required?: boolean
  /** Adds "(optional)" to the label. */
  optional?: boolean
  /** Explicit control id; generated otherwise. */
  id?: string
  className?: string
  /** One control (Input, Select, Textarea, Combobox…) that reads its wiring from context. */
  children: ReactNode
}

/**
 * The "(optional)" label marker; forms mark only optional fields. A real space (not a margin)
 * separates it, so the accessible name reads "Phone (optional)".
 */
export function OptionalMarker() {
  const { t } = useTranslation()
  return (
    <>
      {' '}
      <span className="font-normal text-fg-muted">{t('field.optional')}</span>
    </>
  )
}

/** The hint and error under a control (or a group of controls), with the ids that describe it. */
export function FieldMessages({ hint, hintId, error, errorId }: { hint?: ReactNode; hintId?: string; error?: ReactNode; errorId?: string }) {
  return (
    <>
      {hint && (
        <p id={hintId} className="text-sm leading-relaxed text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </>
  )
}

/**
 * Label, control, hint, error, in that order. The hint sits below the control so that controls
 * side by side in a grid row line up whether or not each has a hint.
 */
export function Field({
  label,
  hint: hintText,
  hideHintOnError = false,
  error,
  required = false,
  optional = false,
  id,
  className,
  children,
}: FieldProps) {
  const controlId = useStableId('field', id)
  const hint = error && hideHintOnError ? undefined : hintText
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        <label htmlFor={controlId} className="text-sm font-semibold text-fg">
          {label}
          {optional && <OptionalMarker />}
        </label>
        {children}
        <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
      </div>
    </FieldContext.Provider>
  )
}
