import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import {
  formatDateTime,
  formatTime,
  formatTimeZoneName,
  isDateKey,
  isTimeOfDay,
  isWallTimeShifted,
  toWallParts,
  wallTimeSlots,
  wallTimeToUtc,
} from '../../utils/datetime'
import { FieldMessages } from './Field'
import { FieldContext } from './fieldContext'
import { Input } from './Input'
import { Select } from './Select'

export interface DateTimeFieldProps {
  /** Names the group; the controls are announced as "<label> date" and "<label> time". */
  label: ReactNode
  /** UTC ISO instant, or null when empty or incomplete. */
  value: string | null
  /** Receives a UTC ISO instant (or null when the date is cleared or incomplete). */
  onChange: (value: string | null) => void
  /** Company IANA timezone; the controls show and accept wall time in this zone. */
  timeZone: string
  hint?: ReactNode
  error?: ReactNode
  /** Marks both controls `aria-required`. */
  required?: boolean
  /**
   * Names the time zone in the field's own hint. Off by default (the brand pass's decision 3: no
   * time-zone notes; every time in the app is the company's): turn it on only where a person
   * must know the zone to answer correctly.
   */
  showTimeZone?: boolean
  /** Extra `aria-describedby` id(s) for both controls, e.g. a hint shared by a group of fields. */
  describedBy?: string
  /** Minutes between the offered times (default 15). The current value is offered too when it is off the grid. */
  stepMinutes?: number
  /**
   * Reads the chosen moment back in the app's format ("Tue, 6 Oct 2026, 10:10") in the hint: the
   * native date part shows the browser's format. Off where a group reads the value back itself
   * (ScheduleFields).
   */
  readBack?: boolean
  disabled?: boolean
  /** Id of the date input, the group's first control (form error focus targets it). */
  id?: string
  className?: string
}

/**
 * Date and time entry in the company timezone, independent of the browser's timezone and
 * locale: a native date input and a list of 24-hour times ("HH:mm", every `stepMinutes`) of
 * that company-local day. The native `datetime-local` input showed the browser's format
 * (12-hour with AM/PM in en-US) next to the app's 24-hour times and cost seven keyboard stops.
 *
 * The value is a UTC instant. While the date is incomplete the value is null, and the chosen
 * time is kept until the date is complete again. Times a spring-forward gap removes from the
 * chosen day are not offered; if a date change lands the kept time in such a gap, it moves
 * forward and the hint says so.
 */
export function DateTimeField({
  label,
  value,
  onChange,
  timeZone,
  hint,
  error,
  required = false,
  showTimeZone = false,
  describedBy,
  stepMinutes = 15,
  readBack = false,
  disabled,
  id,
  className,
}: DateTimeFieldProps) {
  const { t } = useTranslation()
  const dateId = useStableId('date-time', id)
  const timeId = `${dateId}-time`
  const labelId = `${dateId}-label`
  const dateNameId = `${dateId}-date-name`
  const timeNameId = `${dateId}-time-name`
  // What the user entered while the value is null (an incomplete date).
  const [draft, setDraft] = useState(() => toWallParts(value, timeZone))
  const [lastInput, setLastInput] = useState<string | null>(null)
  // Offset shown for the chosen instant (DST-aware), or for when the field was first shown.
  const [mountedAt] = useState(() => Date.now())

  const shown = value ? toWallParts(value, timeZone) : draft
  const slots = useMemo(
    () => wallTimeSlots(isDateKey(shown.date) ? shown.date : null, timeZone, { stepMinutes, include: shown.time || null }),
    [shown.date, shown.time, timeZone, stepMinutes],
  )
  const shifted = lastInput !== null && value !== null && isWallTimeShifted(lastInput, timeZone)

  const commit = (next: { date: string; time: string }) => {
    setDraft(next)
    const wall = isDateKey(next.date) && isTimeOfDay(next.time) ? `${next.date}T${next.time}` : null
    setLastInput(wall)
    onChange(wall ? wallTimeToUtc(wall, timeZone) : null)
  }

  const readBackText = readBack && value ? formatDateTime(value, timeZone) : null
  const hasHint = Boolean(hint) || showTimeZone || shifted || readBackText !== null
  const hintId = hasHint ? `${dateId}-hint` : undefined
  const errorId = error ? `${dateId}-error` : undefined
  const fieldDescribedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div role="group" aria-labelledby={labelId} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label id={labelId} htmlFor={dateId} className="text-sm font-semibold text-fg">
        {label}
      </label>
      {/* The parts of the controls' names after the group label (aria-labelledby reads hidden text). */}
      <span id={dateNameId} hidden>
        {t('field.date')}
      </span>
      <span id={timeNameId} hidden>
        {t('field.time')}
      </span>
      <FieldContext.Provider value={{ id: dateId, describedBy: fieldDescribedBy, invalid: Boolean(error), required }}>
        {/* Sized to its content (a date and a time), not stretched across a wide form. */}
        <div className="grid grid-cols-[minmax(0,12rem)_7rem] gap-2">
          <Input
            type="date"
            aria-labelledby={`${labelId} ${dateNameId}`}
            aria-describedby={describedBy}
            value={shown.date}
            disabled={disabled}
            onChange={(event) => commit({ date: event.target.value, time: shown.time })}
          />
          <Select
            id={timeId}
            aria-labelledby={`${labelId} ${timeNameId}`}
            aria-describedby={describedBy}
            value={shown.time}
            disabled={disabled}
            onChange={(event) => commit({ date: shown.date, time: event.target.value })}
            className="tabular-nums"
          >
            {!shown.time && (
              <option value="" disabled>
                --:--
              </option>
            )}
            {slots.map((time) => (
              <option key={time} value={time}>
                {time}
              </option>
            ))}
          </Select>
        </div>
      </FieldContext.Provider>
      <FieldMessages
        hintId={hintId}
        hint={
          hasHint && (
            <>
              {readBackText && <span className="block font-medium text-fg">{readBackText}</span>}
              {hint && <span className="block">{hint}</span>}
              {showTimeZone && <span className="block">{formatTimeZoneName(timeZone, value ?? mountedAt)}</span>}
              {shifted && value && (
                <span className="block text-warning-text">
                  {t('dates.dstShifted', { zone: formatTimeZoneName(timeZone, value), time: formatTime(value, timeZone) })}
                </span>
              )}
            </>
          )
        }
        errorId={errorId}
        error={error}
      />
    </div>
  )
}
