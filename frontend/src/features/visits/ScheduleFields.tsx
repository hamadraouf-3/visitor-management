import { CalendarCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DateTimeField } from '../../components/ui/DateTimeField'
import { scheduleReadBack, type ScheduleValues } from './schedule'

interface FieldWiring {
  id: string
  error: string | undefined
}

export interface ScheduleFieldsProps {
  timeZone: string
  values: ScheduleValues
  onStartChange: (start: string | null) => void
  onEndChange: (end: string | null) => void
  /** `form.field('start')` / `form.field('end')` (useFormErrors). */
  startField: FieldWiring
  endField: FieldWiring
}

/**
 * Starts / Ends of a visit as one group (Invite visitor, Edit visit): each a date and a 24-hour
 * time in company wall time (DateTimeField), and the chosen range read back in the app's own date
 * format (the native date input shows the browser's) with its length, announced politely as it
 * changes. No note about the time zone or the 24-hour limit (decision 3): the read-back is the
 * data, and a range the server refuses gets its validation message.
 */
export function ScheduleFields({ timeZone, values, onStartChange, onEndChange, startField, endField }: ScheduleFieldsProps) {
  const { t } = useTranslation('visits')
  const readBack = scheduleReadBack(values, timeZone)

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DateTimeField
          label={t('schedule.starts')}
          required
          timeZone={timeZone}
          showTimeZone={false}
          value={values.start}
          onChange={onStartChange}
          {...startField}
        />
        <DateTimeField
          label={t('schedule.ends')}
          required
          timeZone={timeZone}
          showTimeZone={false}
          value={values.end}
          onChange={onEndChange}
          {...endField}
        />
      </div>
      <p aria-live="polite" className="flex min-h-5 items-center gap-2 text-sm font-medium text-fg">
        {readBack && <CalendarCheck aria-hidden="true" className="size-4 shrink-0 text-accent-text" />}
        <span className="font-numeric tabular-nums">{readBack}</span>
      </p>
    </div>
  )
}
