import type { ReactNode } from 'react'
import { isDateKey } from '../../utils/datetime'
import { Field } from './Field'
import { Input } from './Input'

export interface DateFieldProps {
  label: ReactNode
  /** Company-local date `YYYY-MM-DD`, or null when empty. */
  value: string | null
  /** Receives a valid `YYYY-MM-DD`, or null when cleared or incomplete. */
  onChange: (value: string | null) => void
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  /** Earliest/latest selectable dates, `YYYY-MM-DD`. */
  min?: string
  max?: string
  disabled?: boolean
  id?: string
  name?: string
  className?: string
}

/**
 * Date-only entry for company-local `YYYY-MM-DD` values (`date_from`/`date_to` filters,
 * report ranges, §3.2-7). The value is a calendar date, so no timezone conversion happens:
 * the native date input already speaks `YYYY-MM-DD`. No time-zone sentence under it (the brand
 * pass's decision 3): every date in the app is the company's.
 */
export function DateField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  min,
  max,
  disabled,
  id,
  name,
  className,
}: DateFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} className={className}>
      <Input
        type="date"
        name={name}
        value={value ?? ''}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value
          onChange(isDateKey(raw) ? raw : null)
        }}
      />
    </Field>
  )
}
