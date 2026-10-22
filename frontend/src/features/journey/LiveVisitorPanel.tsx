import { Building2, Pencil, Route as RouteIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, ButtonLink } from '../../components/ui/Button'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { Sheet } from '../../components/ui/Sheet'
import { PageSpinner } from '../../components/ui/Spinner'
import { backLinkState, useBackLinkToHere } from '../../hooks/useBackLink'
import { paths } from '../../paths'
import type { Me } from '../../types/api'
import { isFocusLost } from '../../utils/focus'
import { AccessAreasDialog } from '../accessAreas/AccessAreasDialog'
import { AllowedAreasList } from '../accessAreas/AllowedAreasList'
import { FactList } from '../visits/FactList'
import { AlertActionDialog, type AlertActing } from './alerts/AlertActions'
import { AlertCard } from './alerts/AlertCard'
import { isActiveAlert } from './alerts/alertLabels'
import { agoSeconds } from './freshness'
import { JourneyStateBadge, SimulatedBadge } from './JourneyBadges'
import { ObservedAt, UnknownLocation } from './JourneyLocation'
import { JourneyPath } from './JourneyPath'
import { LocationPath } from './LocationPath'
import { useLocationName } from './locationNames'
import { useVisitJourney } from './queries'
import type { LiveVisitor } from './types'

export interface LiveVisitorPanelProps {
  visitId: string
  /** The visitor as the live map has them now; null once they are no longer inside (the journey still says). */
  visitor: LiveVisitor | null
  me: Me
  now: number
  /** When the live map was answered: the visitor's freshness counts on from then. */
  answeredAt: number
  simulatedShown: boolean
  onClose: () => void
}

/** A titled part of the panel. */
function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-border-subtle pt-4 first:border-t-0 first:pt-0">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-fg">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * A visitor of the live map (Phase 16), in a side panel (a sheet on phones): the visitor and their state, the
 * active alert with what staff may do, the host, the current place, the allowed areas (changed here by those
 * the server allows), the path, and «الرحلة الكاملة» / "Full journey". Reads the visit's journey, asked
 * again every 15 s while open (opening it is audited as a journey's opening).
 */
export function LiveVisitorPanel({ visitId, visitor, me, now, answeredAt, simulatedShown, onClose }: LiveVisitorPanelProps) {
  const { t } = useTranslation('journey')
  const name = useLocationName()
  const timeZone = me.company.timezone
  const journey = useVisitJourney(visitId)
  const back = useBackLinkToHere(t('detail.back'))
  const [editingAreas, setEditingAreas] = useState(false)
  const [acting, setActing] = useState<AlertActing | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const data = journey.data
  const summary = visitor?.visit ?? data?.visit
  const visitorName = summary?.visitor.full_name ?? ''
  const location = visitor ? visitor.last_location : (data?.last_location ?? null)
  const observedAt = visitor ? visitor.last_observed_at : (data?.last_observed_at ?? null)
  const freshness = visitor ? visitor.freshness_seconds : (data?.freshness_seconds ?? null)
  const state = visitor?.state ?? data?.state
  const simulated = visitor?.simulated ?? data?.association?.simulated ?? false
  const activeAlert = data?.alerts.find((alert) => isActiveAlert(alert.status)) ?? null
  const areas = data?.access_areas ?? visitor?.access_areas

  // A resolve (or the alert resolved meanwhile) takes the alert, its actions with it, out of the panel; a closed
  // dialog then returns the focus to a button that is gone. The panel itself takes it: the page's heading is
  // behind the modal sheet (F16-34). Checked after every render: the focus is never left on the page's body while
  // the modal sheet is open.
  useEffect(() => {
    if (acting === null && isFocusLost()) contentRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus()
  })

  return (
    <Sheet
      open
      onClose={onClose}
      title={visitorName}
      meta={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-secondary">
          {state && <JourneyStateBadge state={state} size="sm" />}
          {simulated && !simulatedShown && <SimulatedBadge />}
          {summary?.visitor.company_name && (
            <span className="flex min-w-0 items-center gap-1.5">
              <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 break-words">{summary.visitor.company_name}</span>
            </span>
          )}
        </div>
      }
      footer={
        <ButtonLink to={paths.journeyVisit(visitId)} state={backLinkState(back)} variant="secondary" icon={<RouteIcon aria-hidden="true" />}>
          {t('panel.fullJourney')}
        </ButtonLink>
      }
    >
      <div ref={contentRef} data-live-panel={visitId} className="flex flex-col gap-4">
        {activeAlert && (
          <div data-panel-alert="" className="rounded-card border border-danger-solid p-3.5">
            <AlertCard alert={activeAlert} timeZone={timeZone} now={now} simulatedShown inJourney headingLevel="h3" variant="plain" onAct={(kind) => setActing({ alert: activeAlert, kind })} />
          </div>
        )}

        <section data-panel-facts="" className="flex flex-col gap-2.5">
          <FactList
            columns={1}
            items={[
              summary && { term: t('detail.visit.host'), description: summary.host.full_name },
              {
                // «موقع مُستنتج»: the place is inferred, never guaranteed (F15-5), here too.
                term: t('inferredLocation'),
                description:
                  location && observedAt ? (
                    <span className="flex flex-col gap-0.5">
                      <LocationPath places={[location.floor, location.zone]} className="font-semibold" />
                      <span className="text-meta font-normal text-fg-muted">
                        <ObservedAt at={observedAt} agoSeconds={agoSeconds(freshness, answeredAt, now)} timeZone={timeZone} now={now} withDate building={name(location.building)} />
                      </span>
                    </span>
                  ) : (
                    <UnknownLocation />
                  ),
              },
            ]}
          />
        </section>

        <PanelSection
          title={t('areas.title')}
          action={
            data?.can_edit_access_areas && (
              <Button variant="secondary" size="sm" icon={<Pencil aria-hidden="true" />} onClick={() => setEditingAreas(true)} aria-label={t('areas.editNamed')}>
                {t('areas.edit')}
              </Button>
            )
          }
        >
          {areas ? <AllowedAreasList areas={areas} /> : null}
        </PanelSection>

        <PanelSection title={t('path.title')}>
          {journey.isError ? (
            <LoadErrorAlert title={t('panel.loadError')} error={journey.error} retrying={journey.isFetching} onRetry={() => void journey.refetch()} />
          ) : data ? (
            <JourneyPath path={data.path} timeZone={timeZone} />
          ) : (
            <PageSpinner label={t('panel.loading')} />
          )}
        </PanelSection>
      </div>
      {editingAreas && data && <AccessAreasDialog visitId={visitId} visitorName={visitorName} areas={data.access_areas} onClose={() => setEditingAreas(false)} />}
      {acting && <AlertActionDialog alert={acting.alert} kind={acting.kind} onClose={() => setActing(null)} />}
    </Sheet>
  )
}
