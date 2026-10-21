import { MapPin, MapPinOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Card } from '../../components/ui/Card'
import { DataLine } from '../../components/ui/DataLine'
import { IconTile } from '../../components/ui/IconTile'
import type { JourneyState } from '../../types/api'
import { companyToday, formatDateTime, formatTime, toDateKey } from '../../utils/datetime'
import { formatAgo } from '../../utils/duration'
import { JourneyStateBadge } from './JourneyBadges'
import { LocationPath } from './LocationPath'
import { useLocationName } from './locationNames'
import type { JourneyPlace } from './types'

/** «غير معروف» / "Unknown": no confirmed observation, so no floor is shown (the contract's rule: never a guess). */
export function UnknownLocation({ className }: { className?: string }) {
  const { t } = useTranslation('journey')
  return (
    <span data-location-unknown="" className={className ?? 'text-fg-muted'}>
      {t('unknown')}
    </span>
  )
}

export interface ObservedAtProps {
  at: string
  /** How long ago, in seconds (from the server's freshness). */
  agoSeconds: number
  timeZone: string
  now: number
  /** Say the date of a sighting that is not today (where the page does not say the day already). */
  withDate?: boolean
  /** The building's name, first. */
  building?: string
}

/**
 * When the floor was seen: "Tower A · 09:41 · 4m ago". How long ago only for a sighting of today, in the
 * company's time zone (a past day's "26h ago" says nothing).
 */
export function ObservedAt({ at, agoSeconds, timeZone, now, withDate = false, building }: ObservedAtProps) {
  const today = toDateKey(at, timeZone) === companyToday(timeZone, now)
  const when = withDate && !today ? formatDateTime(at, timeZone) : formatTime(at, timeZone)
  return (
    <span className="tabular-nums">
      <DataLine
        items={[
          building,
          <time key="time" dateTime={at}>
            {when}
          </time>,
          // "4m ago" is one phrase: never "قبل" at the end of a line and "4 د" on the next.
          today && (
            <span key="ago" data-freshness="" className="whitespace-nowrap">
              {formatAgo(agoSeconds)}
            </span>
          ),
        ]}
      />
    </span>
  )
}

export interface InferredLocationCardProps {
  location: JourneyPlace | null
  observedAt: string | null
  /** Seconds since the sighting, as of now. */
  agoSeconds: number | null
  state: JourneyState
  timeZone: string
  now: number
}

/**
 * The last known floor and zone, under the title «موقع مُستنتج» / "Inferred location": the contract asks
 * for a visible sign that it is inferred, not guaranteed. Only a confirmed observation gives it; without
 * one, «غير معروف» / "Unknown". The state's chip stands beside the title (STALE or UNCERTAIN says the floor
 * is not to be relied on as it stands), then when it was seen and how long ago.
 */
export function InferredLocationCard({ location, observedAt, agoSeconds, state, timeZone, now }: InferredLocationCardProps) {
  const { t } = useTranslation('journey')
  const name = useLocationName()
  return (
    <Card title={t('inferredLocation')} actions={<JourneyStateBadge state={state} />}>
      <div data-inferred-location="" className="flex items-start gap-3.5">
        <IconTile icon={location ? MapPin : MapPinOff} tone={location ? 'accent' : 'neutral'} size="lg" />
        {location ? (
          <div className="min-w-0 flex-1">
            <p className="text-xl leading-snug font-semibold text-fg">
              <LocationPath places={[location.floor, location.zone]} />
            </p>
            <p className="mt-0.5 text-sm text-fg-secondary">
              <bdi>{name(location.building)}</bdi>
            </p>
            {observedAt && (
              <p className="mt-3 text-sm font-medium text-fg">
                <span className="text-meta font-medium text-fg-muted">{t('detail.location.observed')} </span>
                <ObservedAt at={observedAt} agoSeconds={agoSeconds ?? 0} timeZone={timeZone} now={now} withDate />
              </p>
            )}
          </div>
        ) : (
          <p className="self-center text-xl leading-snug font-semibold">
            <UnknownLocation className="text-fg-secondary" />
          </p>
        )}
      </div>
    </Card>
  )
}
