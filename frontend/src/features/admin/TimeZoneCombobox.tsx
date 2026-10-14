import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Combobox } from '../../components/ui/Combobox'
import { HighlightMatch } from '../../components/ui/HighlightMatch'
import { formatShortUtcOffset } from '../../utils/datetime'
import { filterTimeZones, listTimeZones, timeZoneLabel } from './timeZones'

export interface TimeZoneComboboxProps {
  value: string
  onChange: (timeZone: string) => void
  /** The reference instant for the UTC offsets shown next to each zone. */
  now: number
}

/**
 * Searchable list of IANA time zones (§4 companies.timezone), each with its current UTC offset.
 * The field reads the chosen zone as people do, "Los Angeles — America/Los_Angeles (UTC-7)",
 * matching how the rest of the app names it ("Los Angeles time (UTC-7)").
 * The list is only built into the popup while it is open: several hundred zones with offsets
 * are not worth rendering for a closed field. Use inside a `Field`.
 */
export function TimeZoneCombobox({ value, onChange, now }: TimeZoneComboboxProps) {
  const { t } = useTranslation('admin')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const zones = useMemo(() => listTimeZones(value), [value])
  const options = open ? filterTimeZones(zones, query) : []

  return (
    <Combobox<string>
      value={value || null}
      // Cleared: the form reports the missing zone (the field shows what will be saved).
      onChange={(zone) => onChange(zone ?? '')}
      options={options}
      getOptionKey={(zone) => zone}
      getOptionLabel={(zone) => timeZoneLabel(zone, now)}
      renderOption={(zone, filter) => (
        <span className="flex items-center justify-between gap-3">
          <span dir="ltr" className="break-all">
            <HighlightMatch text={zone} query={filter.trim().replaceAll(' ', '_')} />
          </span>
          <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatShortUtcOffset(zone, now)}</span>
        </span>
      )}
      onQueryChange={setQuery}
      onOpenChange={setOpen}
      emptyMessage={t('settings.timezone.empty', { first: 'Amman', second: 'New York' })}
    />
  )
}
