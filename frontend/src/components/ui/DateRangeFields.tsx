import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { useLanguage } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'
import { dateRangeReadBack } from '../../utils/dateRange'
import { DateField } from './DateField'

export interface DateRangeFieldsProps {
  /** Group name for assistive technology, e.g. "Scheduled date" (visually hidden, see below). */
  legend: string
  from: string | null
  to: string | null
  onChange: (range: { from: string | null; to: string | null }) => void
  /** Shown on the end date (the field the user corrects), e.g. an end before the start. */
  error?: string | null
  /** Upper bound offered by the date pickers, `YYYY-MM-DD`. */
  max?: string
  /** Mark both dates as required (the report range); filters leave them optional. */
  required?: boolean
  className?: string
}

/**
 * A company-local date range: "From" and "To" date inputs in one group (direction C's filter row).
 *
 * The group's name is visually hidden: "From" and "To" are the visible labels, level with the other
 * labels of the row they sit in (a visible legend put a second label row over the dates and pushed
 * them below their neighbours). The screen reads the chosen dates back as facts in its header
 * (`dateRangeReadBack`, the native inputs show the browser's format); the group carries the same
 * read-back as its description.
 */
export function DateRangeFields({ legend, from, to, onChange, error, max, required = false, className }: DateRangeFieldsProps) {
  const { t } = useTranslation()
  const { language } = useLanguage()
  const groupId = useStableId('date-range')
  const readBackId = `${groupId}-read-back`
  const readBack = dateRangeReadBack(from, to, language)
  return (
    <fieldset aria-describedby={readBack ? readBackId : undefined} className={cn('min-w-0', className)}>
      <legend className="sr-only">{legend}</legend>
      {/* An optional date input is at least 10.5rem wide, so an empty field's placeholder ("mm/dd/yyyy")
          is not cut by the calendar button; a required one always holds a date, which 9.5rem fits, so two
          sit side by side on a 390 px phone. Where two do not fit, "To" goes under "From". The tracks may
          grow (1fr): with a fixed maximum, auto-fill counts tracks at that maximum and put "To" under
          "From" in a container that had room for both. */}
      <div
        data-date-range-grid=""
        className={cn('grid gap-3', required ? 'grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]')}
      >
        <DateField label={t('field.from')} value={from} max={to ?? max} required={required} onChange={(value) => onChange({ from: value, to })} />
        <DateField
          label={t('field.to')}
          value={to}
          min={from ?? undefined}
          max={max}
          required={required}
          error={error ?? undefined}
          onChange={(value) => onChange({ from, to: value })}
        />
      </div>
      {readBack && (
        <p id={readBackId} className="sr-only">
          {readBack}
        </p>
      )}
    </fieldset>
  )
}
