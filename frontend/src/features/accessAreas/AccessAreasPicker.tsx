import { X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '../../components/ui/Checkbox'
import { Combobox } from '../../components/ui/Combobox'
import { FieldMessages, OptionalMarker } from '../../components/ui/Field'
import { FOCUS_ROW_ATTRIBUTE, useListFocusRecovery } from '../../hooks/useListFocusRecovery'
import { useStableId } from '../../hooks/useStableId'
import { useLanguage } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'
import { LocationPath } from '../journey/LocationPath'
import { locationName } from '../journey/locationNames'
import { ZoneAccessBadge } from '../journey/ZoneAccessBadge'
import { addZone, matchingZones, removeZone, toggleFloor, zoneLabel, type AreaOptions, type AreaSelection, type ZoneOption } from './accessAreas'

export interface AccessAreasPickerProps {
  options: AreaOptions
  value: AreaSelection
  onChange: (value: AreaSelection) => void
  /** The group's legend, «المناطق المسموحة» / "Allowed areas" by default; visually hidden where a heading already names it (a dialog's title). */
  legend?: string
  legendHidden?: boolean
  /** Marks the legend "(optional)" (the forms, where nothing chosen is "not set"). */
  optional?: boolean
  /** The group's id: a refused field focuses its first control. */
  id?: string
  error?: string
  disabled?: boolean
}

/**
 * A visit's allowed areas (Phase 16), one picker wherever they are chosen: the floors as checkboxes, by
 * building (named only when there are several) in level order; then «مناطق إضافية» / "Extra zones", a
 * search over the active zones (a restricted one marked) that adds each chosen zone as a chip with its own
 * remove button (the focus then goes on to the next chip's, else the search, F16-44). Controlled: the owner
 * keeps the selection and sends it.
 */
export function AccessAreasPicker({ options, value, onChange, legend, legendHidden = false, optional = false, id, error, disabled = false }: AccessAreasPickerProps) {
  const { t } = useTranslation('journey')
  const { language } = useLanguage()
  const legendText = legend ?? t('areas.title')
  const groupId = useStableId('areas', id)
  const legendId = `${groupId}-legend`
  const errorId = error ? `${groupId}-error` : undefined
  const zonesId = useStableId('extra-zones')
  const [query, setQuery] = useState('')
  const several = options.buildings.length > 1
  const chosenZones = value.zoneIds.map((zoneId) => options.zones.find((zone) => zone.id === zoneId)).filter((zone): zone is ZoneOption => zone !== undefined)
  const offered = matchingZones(options.zones, value.zoneIds, query)
  // A removed chip takes its focused button with it: the focus goes on to the chip now in its place, else to the
  // previous one, else to the search (the combobox's input, found by its id when the recovery runs).
  const chipsRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLElement | null>(null)
  const recoverFocus = useListFocusRecovery({ list: chipsRef, fallback: searchRef, version: value.zoneIds })
  const removeChip = (zoneId: string) => {
    searchRef.current = document.getElementById(zonesId)
    recoverFocus(zoneId)
    onChange(removeZone(value, zoneId))
  }

  return (
    <fieldset id={groupId} aria-labelledby={legendId} aria-describedby={errorId} className="flex min-w-0 flex-col gap-4">
      <legend id={legendId} className={cn('mb-1 text-sm font-semibold text-fg', legendHidden && 'sr-only')}>
        {legendText}
        {optional && <OptionalMarker />}
      </legend>

      <div role="group" aria-label={t('areas.floors')} className="flex flex-col gap-3">
        {options.buildings.map((group) => (
          <div key={group.building.id} className="flex flex-col gap-2">
            {several && (
              <p className="text-meta font-semibold text-fg-secondary">
                <bdi>{locationName(group.building, language)}</bdi>
              </p>
            )}
            {/* Two a row from the small breakpoint: a company's floors are a handful. On a touch screen each row's
                44 px reaches 12 px past its line: the rows stand 24 px apart, so no row covers its neighbour's. */}
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 pointer-coarse:gap-y-6">
              {group.floors.map((floor) => (
                <Checkbox
                  key={floor.id}
                  data-area-floor={floor.id}
                  label={<bdi>{locationName(floor, language)}</bdi>}
                  checked={value.floorIds.includes(floor.id)}
                  disabled={disabled}
                  onChange={(event) => onChange(toggleFloor(value, floor.id, event.target.checked))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {options.zones.length > 0 && (
        <div className="flex flex-col gap-2">
          <label htmlFor={zonesId} className="text-sm font-semibold text-fg">
            {t('areas.extraZones')}
          </label>
          <Combobox<ZoneOption>
            id={zonesId}
            value={null}
            onChange={(zone) => {
              if (zone) onChange(addZone(value, zone.id))
              setQuery('')
            }}
            options={offered}
            onQueryChange={setQuery}
            getOptionKey={(zone) => zone.id}
            getOptionLabel={(zone) => zoneLabel(zone, language)}
            renderOption={(zone) => (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <LocationPath places={[zone.floor, zone]} />
                <ZoneAccessBadge access={zone.access} />
              </span>
            )}
            placeholder={t('areas.searchZones')}
            emptyMessage={t('areas.noZone')}
            disabled={disabled}
          />
          {chosenZones.length > 0 && (
            <ul ref={chipsRef} aria-label={t('areas.extraZones')} className="flex flex-wrap gap-2">
              {chosenZones.map((zone) => (
                <li key={zone.id} data-area-zone={zone.id} {...{ [FOCUS_ROW_ATTRIBUTE]: zone.id }} className="flex min-h-9 max-w-full items-center gap-2 rounded-full border border-border bg-surface-muted ps-3 pe-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-sm text-fg">
                    <LocationPath places={[zone.floor, zone]} />
                    <ZoneAccessBadge access={zone.access} />
                  </span>
                  {/* A 44 px target on touch screens, without growing the chip (negative margins). */}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeChip(zone.id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface hover:text-fg disabled:cursor-not-allowed pointer-coarse:-my-2 pointer-coarse:size-11"
                  >
                    <X aria-hidden="true" className="size-4" />
                    <span className="sr-only">{t('areas.remove', { name: zoneLabel(zone, language) })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <FieldMessages error={error} errorId={errorId} />
    </fieldset>
  )
}
