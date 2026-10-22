import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { formatTime, formatTimeRange } from '../../utils/datetime'
import { DataLine } from '../../components/ui/DataLine'
import { LocationPath } from './LocationPath'
import type { JourneyStay } from './types'
import { ZoneAccessBadge } from './ZoneAccessBadge'

/** «خارج المسموح» / "Outside allowed area": an icon and words in the alerts' red, never the colour alone. */
export function OutsideAllowedMark() {
  const { t } = useTranslation('journey')
  return (
    <span data-outside-allowed="" className="inline-flex items-center gap-1 text-meta font-semibold text-danger-text">
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {t('outsideAllowed')}
    </span>
  )
}

export interface JourneyPathProps {
  path: readonly JourneyStay[]
  timeZone: string
  /** Only the latest stays (the live map's panel): "Latest n of m" is not said, the full journey has them all. */
  limit?: number
}

/**
 * A visit's path (Phase 16): its confirmed places in the order they were seen, one stay per zone in a row
 * (the server collapses them): floor › zone, a restricted or common zone marked, from when to when and how
 * often; a place outside the visit's allowed areas (as they are now) in the alerts' red with «خارج المسموح».
 * Read as a route, oldest first. Only confirmed places: an uncertain observation never makes a stay.
 */
export function JourneyPath({ path, timeZone, limit }: JourneyPathProps) {
  const { t } = useTranslation('journey')
  const shown = limit !== undefined && path.length > limit ? path.slice(-limit) : path
  if (shown.length === 0) return <p className="text-sm text-fg-muted">{t('path.empty')}</p>
  return (
    <ol data-journey-path="" className="flex flex-col">
      {shown.map((stay, index) => (
        <li key={`${stay.from}-${stay.location.zone.id}`} data-stay-allowed={stay.allowed ? 'true' : 'false'} className="relative flex gap-3 pb-4 last:pb-0">
          {index < shown.length - 1 && <span aria-hidden="true" className="absolute start-[5px] top-4 bottom-0 w-0.5 rounded-full bg-border" />}
          <span
            aria-hidden="true"
            className={cn('relative mt-1 size-3 shrink-0 rounded-full ring-4 ring-surface', stay.allowed ? 'bg-accent-strong' : 'bg-danger-solid')}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className={cn('text-sm leading-snug font-semibold', stay.allowed ? 'text-fg' : 'text-danger-text')}>
                <LocationPath places={[stay.location.floor, stay.location.zone]} />
              </p>
              <ZoneAccessBadge access={stay.location.zone.access} />
            </div>
            <p className="text-meta text-fg-muted tabular-nums">
              <DataLine
                items={[
                  <time key="when" dateTime={stay.from}>
                    {stay.from === stay.to ? formatTime(stay.from, timeZone) : formatTimeRange(stay.from, stay.to, timeZone)}
                  </time>,
                  t('path.observations', { count: stay.observations }),
                ]}
              />
            </p>
            {!stay.allowed && <OutsideAllowedMark />}
          </div>
        </li>
      ))}
    </ol>
  )
}
