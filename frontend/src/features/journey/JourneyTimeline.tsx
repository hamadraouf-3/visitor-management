import { useTranslation } from 'react-i18next'
import { Card } from '../../components/ui/Card'
import { DataLine } from '../../components/ui/DataLine'
import { cn } from '../../utils/cn'
import { formatDateTime, formatTime, toDateKey } from '../../utils/datetime'
import { formatCount, formatPercent } from '../../utils/number'
import { ConfirmationBadge } from './JourneyBadges'
import { LocationPath } from './LocationPath'
import type { JourneyEvent } from './types'

type DotTone = 'success' | 'warning' | 'info' | 'neutral'

const TONE_DOT: Record<DotTone, string> = {
  success: 'bg-success-solid',
  warning: 'bg-warning-solid',
  info: 'bg-info-solid',
  neutral: 'bg-neutral-solid',
}

function dotTone(event: JourneyEvent): DotTone {
  if (event.type === 'ENROLLED') return 'info'
  if (event.type === 'LOST') return 'neutral'
  return event.confirmed ? 'success' : 'warning'
}

/** Whether the events span more than one company-local day: then each time says its date. */
function spansDays(events: readonly JourneyEvent[], timeZone: string): boolean {
  return new Set(events.map((event) => toDateKey(event.observed_at, timeZone))).size > 1
}

export interface JourneyTimelineCardProps {
  events: readonly JourneyEvent[]
  /** Every event of the visit; the API sends at most the latest 500. */
  total: number
  timeZone: string
}

/**
 * Every event of the journey, newest first (the lead's decision: a live journey is read from its latest
 * sighting; the server answers oldest first, by when each was observed, and the page turns the list round):
 * the time; for an observation its floor › zone and its mark (confirmed when the application counts
 * it, uncertain otherwise: an uncertain one is listed and marked, and never becomes the last known floor);
 * the camera's name; the confidence only when the provider sent one.
 */
export function JourneyTimelineCard({ events, total, timeZone }: JourneyTimelineCardProps) {
  const { t } = useTranslation('journey')
  const withDate = spansDays(events, timeZone)
  const newestFirst = events.toReversed()
  return (
    <Card title={t('detail.timeline.title')} count={total > 0 ? formatCount(total) : undefined}>
      {events.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('detail.timeline.empty')}</p>
      ) : (
        <>
          {events.length < total && (
            <p className="mb-4 text-meta text-fg-muted">{t('detail.timeline.latest', { shown: formatCount(events.length), total: formatCount(total) })}</p>
          )}
          <ol data-journey-timeline="" className="flex flex-col">
            {newestFirst.map((event, index) => (
              <li key={event.id} data-event-type={event.type} className="relative flex gap-3.5 pb-5 last:pb-0">
                {index < events.length - 1 && <span aria-hidden="true" className="absolute start-[5px] top-5 bottom-1 w-0.5 rounded-full bg-border" />}
                <span aria-hidden="true" className={cn('relative mt-1.5 size-3 shrink-0 rounded-full ring-4 ring-surface', TONE_DOT[dotTone(event)])} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[0.90625rem] leading-snug font-semibold text-fg">
                      {event.type === 'OBSERVED' && event.location ? <LocationPath places={[event.location.floor, event.location.zone]} /> : t(`detail.timeline.events.${event.type}`)}
                    </p>
                    {event.type === 'OBSERVED' && <ConfirmationBadge confirmed={event.confirmed} />}
                  </div>
                  <p className="text-meta text-fg-muted tabular-nums">
                    <DataLine
                      items={[
                        <time key="time" dateTime={event.observed_at}>
                          {withDate ? formatDateTime(event.observed_at, timeZone) : formatTime(event.observed_at, timeZone)}
                        </time>,
                        event.camera?.name,
                        event.confidence !== null && <span key="confidence" data-confidence="">{t('confidence', { value: formatPercent(event.confidence) })}</span>,
                      ]}
                    />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  )
}
