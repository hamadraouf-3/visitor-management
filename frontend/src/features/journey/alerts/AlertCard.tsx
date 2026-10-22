import { ArrowRight, Building2, Route as RouteIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ButtonLink } from '../../../components/ui/Button'
import { backLinkState, type BackLink } from '../../../hooks/useBackLink'
import { useStableId } from '../../../hooks/useStableId'
import { paths } from '../../../paths'
import type { TrackingAlert } from '../../../types/api'
import { cn } from '../../../utils/cn'
import { formatTimeOnDay } from '../../../utils/datetime'
import { formatCount } from '../../../utils/number'
import { AllowedAreasList } from '../../accessAreas/AllowedAreasList'
import { FactList } from '../../visits/FactList'
import { SimulatedBadge } from '../JourneyBadges'
import { LocationPath } from '../LocationPath'
import { useLocationName } from '../locationNames'
import type { JourneyPlace } from '../types'
import { ZoneAccessBadge } from '../ZoneAccessBadge'
import { AlertActions } from './AlertActions'
import type { AlertActionKind } from './queries'
import { AlertStatusBadge, AlertTypeBadge } from './AlertBadges'
import { ALERT_TYPE_META, alertResolutionLabel } from './alertLabels'

/** A place of an alert: floor › zone, a restricted or common zone marked. */
function AlertPlace({ place }: { place: JourneyPlace }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <LocationPath places={[place.floor, place.zone]} />
      <ZoneAccessBadge access={place.zone.access} />
    </span>
  )
}

/** The building under the places (once when both are in it). */
function AlertBuilding({ place }: { place: JourneyPlace }) {
  const name = useLocationName()
  return (
    <span className="block text-meta font-normal text-fg-muted">
      <bdi>{name(place.building)}</bdi>
    </span>
  )
}

export interface AlertCardProps {
  alert: TrackingAlert
  timeZone: string
  now: number
  /** The page says Simulated already (its line): the card leaves the mark out. */
  simulatedShown?: boolean
  /** Where "Open journey" returns to (the alerts page, a visit's journey has none: it is that journey). */
  backLink?: BackLink
  /** On a visit's journey: no visitor's name or link (the page is about them). */
  inJourney?: boolean
  /** The heading level of the visitor's name (h2 on the alerts page, h3 inside a card). */
  headingLevel?: 'h2' | 'h3'
  /** `plain`: no frame of its own, for a list inside a card (a visit's journey). */
  variant?: 'card' | 'plain'
  /** An action pressed: the list that shows the card opens its dialog (F16-33). */
  onAct: (kind: AlertActionKind) => void
}

/**
 * One tracking alert (Phase 16): the visitor and their company, the type and the status, the host, where it
 * opened and where the visitor was seen last (first → last), since when and how often, the visit's allowed
 * floors, the latest note, who acknowledged or resolved it and how; then what staff may do and the way to the
 * journey. Read only for management.
 */
export function AlertCard({ alert, timeZone, now, simulatedShown = false, backLink, inJourney = false, headingLevel: Heading = 'h2', variant = 'card', onAct }: AlertCardProps) {
  const { t } = useTranslation('journey')
  const headingId = useStableId('alert')
  const moved = alert.first_location.zone.id !== alert.last_location.zone.id
  const sameBuilding = alert.first_location.building.id === alert.last_location.building.id
  const when = (value: string) => <span className="tabular-nums">{formatTimeOnDay(value, now, timeZone)}</span>
  const byWhom = (user: { full_name: string } | null, at: string) =>
    user ? t('alerts.byWhom', { name: user.full_name, when: formatTimeOnDay(at, now, timeZone) }) : t('alerts.automatically', { when: formatTimeOnDay(at, now, timeZone) })

  return (
    <article
      aria-labelledby={headingId}
      data-alert-card={alert.id}
      data-alert-state={alert.status}
      className={cn(
        'flex min-w-0 flex-col gap-4',
        variant === 'card' && 'rounded-card border bg-surface p-4 sm:p-5',
        // An open alert's edge is the alerts' red (3:1 against the canvas and the card): nobody has looked yet.
        variant === 'card' && (alert.status === 'OPEN' ? 'border-danger-solid' : 'border-border'),
      )}
    >
      <header className="flex flex-col gap-2">
        <Heading id={headingId} className={cn('min-w-0 font-bold break-words text-fg', inJourney ? 'sr-only' : 'text-base')}>
          {inJourney ? `${ALERT_TYPE_META[alert.type].label} · ${formatTimeOnDay(alert.opened_at, now, timeZone)}` : alert.visit.visitor.full_name}
        </Heading>
        {!inJourney && alert.visit.visitor.company_name && (
          <p className="-mt-1 flex min-w-0 items-center gap-1.5 text-sm text-fg-secondary">
            <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            <span className="min-w-0 break-words">{alert.visit.visitor.company_name}</span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <AlertTypeBadge type={alert.type} size="md" />
          <AlertStatusBadge status={alert.status} size="md" />
          {alert.simulated && !simulatedShown && <SimulatedBadge size="md" />}
        </div>
      </header>

      <FactList
        items={[
          !inJourney && { term: t('alerts.fields.host'), description: alert.visit.host.full_name },
          {
            term: t('alerts.fields.where'),
            wide: true,
            // Where it opened, then where the visitor was seen last; the building once when it is the same.
            description: moved ? (
              <span data-alert-where="" className="flex min-w-0 flex-col">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="flex min-w-0 flex-col">
                    <AlertPlace place={alert.first_location} />
                    {!sameBuilding && <AlertBuilding place={alert.first_location} />}
                  </span>
                  <ArrowRight aria-hidden="true" className="mirror-rtl size-4 shrink-0 text-fg-muted" />
                  {/* The arrow in words: "Floor 4, Open office to Floor 4, Server room", two places, not one (F16-47). */}
                  <span className="sr-only"> {t('alerts.whereTo')} </span>
                  <span className="flex min-w-0 flex-col">
                    <AlertPlace place={alert.last_location} />
                    {!sameBuilding && <AlertBuilding place={alert.last_location} />}
                  </span>
                </span>
                {sameBuilding && <AlertBuilding place={alert.last_location} />}
              </span>
            ) : (
              <span data-alert-where="" className="flex min-w-0 flex-col">
                <AlertPlace place={alert.last_location} />
                <AlertBuilding place={alert.last_location} />
              </span>
            ),
          },
          { term: t('alerts.fields.since'), description: when(alert.opened_at) },
          { term: t('alerts.fields.lastSeen'), description: when(alert.last_seen_at) },
          { term: t('alerts.fields.observations'), description: <span className="font-numeric tabular-nums">{formatCount(alert.observations)}</span> },
          // A visit's own journey and panel show its allowed areas beside the alert: not again here.
          !inJourney && { term: t('alerts.fields.allowedFloors'), description: <AllowedAreasList areas={alert.access_areas} show="floors" /> },
          alert.note !== null && { term: t('alerts.fields.note'), wide: true, description: <bdi className="break-words">{alert.note}</bdi> },
          alert.acknowledged_at !== null && { term: t('alerts.fields.acknowledged'), description: byWhom(alert.acknowledged_by, alert.acknowledged_at) },
          alert.resolved_at !== null && {
            term: t('alerts.fields.resolved'),
            description: (
              <span className="flex flex-col">
                {alert.resolution && <span>{alertResolutionLabel(alert.resolution)}</span>}
                <span className="text-sm font-normal text-fg-secondary">{byWhom(alert.resolved_by, alert.resolved_at)}</span>
              </span>
            ),
          },
        ]}
      />

      {inJourney ? (
        // Kept mounted when nothing is left to do (it then draws nothing): once a resolve takes its buttons
        // away, its own effect gives the focus to the page's heading (F16-34).
        <AlertActions alert={alert} onAct={onAct} className="flex flex-wrap gap-2 border-t border-border-subtle pt-4 empty:hidden" />
      ) : (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
          <AlertActions alert={alert} onAct={onAct} />
          <ButtonLink to={paths.journeyVisit(alert.visit.id)} state={backLink ? backLinkState(backLink) : undefined} variant="ghost" size="sm" icon={<RouteIcon aria-hidden="true" />} className="ms-auto">
            {t('alerts.openJourney')}
          </ButtonLink>
        </footer>
      )}
    </article>
  )
}
