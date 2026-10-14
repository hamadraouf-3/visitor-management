import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateRangeFields } from '../../components/ui/DateRangeFields'
import { Field } from '../../components/ui/Field'
import { Select } from '../../components/ui/Select'
import {
  matchingPreset,
  presetRange,
  REPORT_PRESET_LABELS,
  REPORT_PRESETS,
  reportRangeError,
  type ReportPreset,
  type ReportRange,
} from './reportRange'

const CUSTOM = 'custom'

export interface ReportRangeControlsProps {
  range: ReportRange
  /** Company-local today, `YYYY-MM-DD`. */
  today: string
  onChange: (range: ReportRange) => void
}

/**
 * The report period, in one row above everything it scopes: a preset (last 7, 30, 90 days, this
 * or last month, last 12 months) or a custom range, its "From" and "To" dates beside the preset with
 * their labels on one line (the group is named "Dates" for assistive technology). A custom range
 * applies as soon as both dates form a valid range of at most 366 days; until then the error says
 * what to fix and the report keeps showing the last valid range. The page header reads the period
 * back in the app's own date format.
 */
export function ReportRangeControls({ range, today, onChange }: ReportRangeControlsProps) {
  const { t } = useTranslation(['reports', 'common'])
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>(range)
  const [syncedRange, setSyncedRange] = useState(range)
  if (syncedRange.from !== range.from || syncedRange.to !== range.to) {
    setSyncedRange(range)
    setDraft(range)
  }

  const error = reportRangeError(draft.from, draft.to)
  const preset = draft.from && draft.to && !error ? matchingPreset({ from: draft.from, to: draft.to }, today) : null

  const changeDates = (next: { from: string | null; to: string | null }) => {
    setDraft(next)
    if (next.from && next.to && !reportRangeError(next.from, next.to)) onChange({ from: next.from, to: next.to })
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,15rem)_minmax(0,24rem)]">
      <Field label={t('range.period')}>
        <Select
          value={preset ?? CUSTOM}
          onChange={(event) => {
            const value = event.target.value
            if ((REPORT_PRESETS as readonly string[]).includes(value)) onChange(presetRange(value as ReportPreset, today))
          }}
        >
          {REPORT_PRESETS.map((option) => (
            <option key={option} value={option}>
              {REPORT_PRESET_LABELS[option]}
            </option>
          ))}
          <option value={CUSTOM} disabled={preset !== null}>
            {t('range.custom')}
          </option>
        </Select>
      </Field>
      {/* A report's dates are always set (required: two fit side by side from a 390 px phone up). */}
      <DateRangeFields legend={t('range.dates')} from={draft.from} to={draft.to} required error={error} onChange={changeDates} />
    </div>
  )
}
