import { Building2, FileQuestion, Play, ShieldX, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Dialog } from '../../components/ui/Dialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PageHeader } from '../../components/ui/PageHeader'
import { Select } from '../../components/ui/Select'
import { PageSpinner } from '../../components/ui/Spinner'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { useToast } from '../../components/ui/toastContext'
import { hasAnyRole, TRACKING_ACTION_ROLES } from '../../auth/roles'
import { backLinkState, useBackLink, useBackLinkToHere, type BackLink } from '../../hooks/useBackLink'
import { useNow } from '../../hooks/useNow'
import { useStableId } from '../../hooks/useStableId'
import { paths } from '../../paths'
import type { EnrollBlocker, Me, TrackingCamera, VisitJourney } from '../../types/api'
import { formatDateTime } from '../../utils/datetime'
import { focusPageHeading, isFocusLost } from '../../utils/focus'
import { FactList } from '../visits/FactList'
import { SimulatedBadge } from './JourneyBadges'
import { InferredLocationCard } from './JourneyLocation'
import { endReasonLabel, enrollBlockerLabel } from './journeyStates'
import { JourneyTimelineCard } from './JourneyTimeline'
import { agoSeconds } from './freshness'
import { useEnrollmentCameras, useEnrollVisit, useRevokeVisitTracking, useTrackingStatus, useVisitJourney } from './queries'
import { trackingActionsFor } from './trackingActions'
import { TrackingStatusBanner } from './TrackingStatusBanner'
import { trackingBanner, type TrackingBannerLine } from './trackingStatus'

/** Load failures: 404 and 403 get their own state; anything else can be retried. */
function JourneyLoadError({ error, back, onRetry }: { error: unknown; back: BackLink; onRetry: () => void }) {
  const { t } = useTranslation('journey')
  const status = isApiError(error) ? error.status : 0
  const backAction = (
    <ButtonLink to={back.to} state={back.state} variant="secondary">
      {back.label}
    </ButtonLink>
  )
  if (status === 404) {
    return (
      <>
        <PageHeader title={t('detail.notFound.title')} back={back} />
        <EmptyState icon={FileQuestion} title={t('detail.notFound.heading')} action={backAction} />
      </>
    )
  }
  if (status === 403) {
    return (
      <>
        <PageHeader title={t('detail.noAccess.title')} back={back} />
        <EmptyState icon={ShieldX} title={t('detail.noAccess.heading')} description={<ApiErrorMessage error={error} />} action={backAction} />
      </>
    )
  }
  return (
    <>
      <PageHeader title={t('detail.title')} back={back} />
      <LoadErrorAlert title={t('detail.loadError')} error={error} onRetry={onRetry} />
    </>
  )
}

/** The visit the journey belongs to: its host, its status and its times, and the way to the visit's own page. */
function VisitSummaryCard({ journey, timeZone }: { journey: VisitJourney; timeZone: string }) {
  const { t } = useTranslation('journey')
  const { visit } = journey
  // The visit page's "Back to …" returns here.
  const back = useBackLinkToHere(t('detail.backToJourney'))
  return (
    <Card
      title={t('detail.visit.title')}
      actions={
        <ButtonLink to={paths.visit(visit.id)} state={backLinkState(back)} variant="secondary" size="sm">
          {t('detail.visit.open')}
        </ButtonLink>
      }
    >
      <FactList
        columns={1}
        items={[
          { term: t('detail.visit.host'), description: visit.host.full_name },
          { term: t('detail.visit.status'), description: <StatusBadge type="visit" status={visit.status} /> },
          visit.check_in_at !== null && { term: t('detail.visit.checkedIn'), description: <span className="tabular-nums">{formatDateTime(visit.check_in_at, timeZone)}</span> },
          visit.check_out_at !== null && { term: t('detail.visit.checkedOut'), description: <span className="tabular-nums">{formatDateTime(visit.check_out_at, timeZone)}</span> },
        ]}
      />
    </Card>
  )
}

type EnrollMutation = ReturnType<typeof useEnrollVisit>

/** "Start tracking", with the reception camera to bind at when there are several. */
function StartTracking({ cameras, enroll }: { cameras: TrackingCamera[]; enroll: EnrollMutation }) {
  const { t } = useTranslation('journey')
  const toast = useToast()
  const [cameraId, setCameraId] = useState(cameras[0]?.id ?? '')
  const chosen = cameras.find((camera) => camera.id === cameraId) ?? cameras[0]
  return (
    <div className="flex flex-col gap-3">
      {cameras.length > 1 && (
        <Field label={t('detail.tracking.camera')}>
          <Select value={chosen?.id ?? ''} onChange={(event) => setCameraId(event.target.value)}>
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Button
        icon={<Play aria-hidden="true" />}
        loading={enroll.isPending}
        className="self-start"
        onClick={() => {
          if (!chosen) return
          enroll.mutate({ camera_id: chosen.id }, { onSuccess: () => toast.show({ tone: 'success', title: t('detail.tracking.startedToast') }) })
        }}
      >
        {t('detail.tracking.start')}
      </Button>
    </div>
  )
}

/** "Stop tracking", after one line: it cannot be undone for this association. */
function StopTracking({ journey }: { journey: VisitJourney }) {
  const { t } = useTranslation('journey')
  const toast = useToast()
  const revoke = useRevokeVisitTracking(journey.visit.id)
  const [confirming, setConfirming] = useState(false)
  const close = () => {
    setConfirming(false)
    revoke.reset()
  }
  return (
    <>
      <Button variant="danger-outline" icon={<Square aria-hidden="true" />} className="self-start" onClick={() => setConfirming(true)}>
        {t('detail.tracking.stop')}
      </Button>
      <Dialog
        open={confirming}
        role="alertdialog"
        onClose={close}
        dismissible={!revoke.isPending}
        title={t('detail.tracking.stopTitle', { name: journey.visit.visitor.full_name })}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={revoke.isPending} focusableWhenDisabled>
              {t('detail.tracking.keep')}
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(undefined, {
                  onSuccess: () => {
                    setConfirming(false)
                    toast.show({ tone: 'success', title: t('detail.tracking.stoppedToast') })
                  },
                })
              }
            >
              {t('detail.tracking.stop')}
            </Button>
          </>
        }
      >
        {revoke.isError ? (
          <Alert tone="danger">
            <ApiErrorMessage error={revoke.error} outsideForm />
          </Alert>
        ) : undefined}
      </Dialog>
    </>
  )
}

/** A blocker whose words the page's line already says (F15-35): "Tracking is off" twice, "No tracking provider" twice. */
function repeatsBanner(blocker: EnrollBlocker, line: TrackingBannerLine | null): boolean {
  return (blocker === 'NOT_ENABLED' && line === 'off') || (blocker === 'PROVIDER_DISABLED' && line === 'noProvider')
}

/**
 * The visit's tracking: when it was requested or started, when it ended and why, and what the person may do
 * about it (`trackingActionsFor`). A start that cannot be made is a disabled button with its reason beside it
 * as a short state (read out only, when the page's line says it already). A refused start stays said here,
 * whatever the journey the page then shows (F15-39). When the action changes under a keyboard user's focus (a
 * start becomes a stop, a stop a start, or nothing is left), the focus goes to the new action, else to the
 * page's heading (F15-32).
 */
function TrackingCard({ journey, me, timeZone, bannerLine }: { journey: VisitJourney; me: Me; timeZone: string; bannerLine: TrackingBannerLine | null }) {
  const { t } = useTranslation('journey')
  const mayAct = hasAnyRole(me.user.roles, TRACKING_ACTION_ROLES)
  // The reception cameras are asked for only when the server says a start can be made.
  const cameras = useEnrollmentCameras(journey.can_enroll && mayAct)
  const enroll = useEnrollVisit(journey.visit.id)
  const reasonId = useStableId('start-blocked')
  const actionsRef = useRef<HTMLDivElement>(null)
  const actions = trackingActionsFor(journey, cameras.data ?? null, me.user.roles)
  const camerasFailed = journey.can_enroll && mayAct && cameras.isError
  const blockedLabel = actions.kind === 'blocked' ? enrollBlockerLabel(actions.blocker) : null
  const { association } = journey

  const shownKind = camerasFailed ? 'error' : actions.kind
  const previousKind = useRef(shownKind)
  useEffect(() => {
    if (previousKind.current !== shownKind && isFocusLost()) {
      const next = actionsRef.current?.querySelector<HTMLElement>('button')
      if (next) next.focus()
      else focusPageHeading()
    }
    previousKind.current = shownKind
  }, [shownKind, actionsRef, previousKind])

  return (
    <Card title={t('detail.tracking.title')}>
      <div className="flex flex-col gap-5">
        {association && (
          <FactList
            columns={1}
            items={[
              association.activated_at === null
                ? { term: t('detail.tracking.requested'), description: <span className="tabular-nums">{formatDateTime(association.created_at, timeZone)}</span> }
                : { term: t('detail.tracking.started'), description: <span className="tabular-nums">{formatDateTime(association.activated_at, timeZone)}</span> },
              association.ended_at !== null && { term: t('detail.tracking.ended'), description: <span className="tabular-nums">{formatDateTime(association.ended_at, timeZone)}</span> },
              association.ended_reason !== null && { term: t('detail.tracking.reason'), description: endReasonLabel(association.ended_reason) },
            ]}
          />
        )}
        {enroll.isError && (
          <Alert tone="danger" title={t('detail.tracking.startFailed')}>
            <ApiErrorMessage error={enroll.error} outsideForm />
          </Alert>
        )}
        <div ref={actionsRef} className="flex flex-col gap-3 empty:hidden">
          {camerasFailed ? (
            <LoadErrorAlert title={t('detail.tracking.camerasLoadError')} error={cameras.error} retrying={cameras.isFetching} onRetry={() => void cameras.refetch()} />
          ) : (
            <>
              {actions.kind === 'stop' && <StopTracking journey={journey} />}
              {actions.kind === 'start' && <StartTracking key={association?.id ?? 'none'} cameras={actions.cameras} enroll={enroll} />}
              {actions.kind === 'blocked' && blockedLabel && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button icon={<Play aria-hidden="true" />} disabled focusableWhenDisabled aria-describedby={reasonId}>
                    {t('detail.tracking.start')}
                  </Button>
                  <span
                    id={reasonId}
                    data-start-blocked={actions.blocker}
                    className={repeatsBanner(actions.blocker, bannerLine) ? 'sr-only' : 'text-sm font-semibold text-fg-muted'}
                  >
                    {blockedLabel}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

export interface JourneyDetailProps {
  visitId: string
  me: Me
}

/**
 * A visit's journey (§F): the visitor (and «محاكاة» / "Simulated" for the simulator's journey), the one-line
 * tracking banner, the last known floor and zone under «موقع مُستنتج» / "Inferred location" with the journey's
 * state, when it was seen and how long ago, the visit, the tracking and its actions, and the timeline. Asked
 * again every 15 s while open.
 */
export function JourneyDetail({ visitId, me }: JourneyDetailProps) {
  const { t } = useTranslation('journey')
  const timeZone = me.company.timezone
  const back = useBackLink({ to: paths.journey, label: t('detail.back') })
  const journey = useVisitJourney(visitId)
  const status = useTrackingStatus()
  const now = useNow(15_000)
  const data = journey.data

  if (!data) {
    if (journey.isError) return <JourneyLoadError error={journey.error} back={back} onRetry={() => void journey.refetch()} />
    return (
      <>
        <PageHeader title={t('detail.title')} back={back} />
        <PageSpinner label={t('detail.loading')} />
      </>
    )
  }

  const { visit } = data
  const simulated = data.association?.simulated === true
  // The server's freshness when it answered, plus the time since: not the device's clock, which may be off.
  const freshness = data.freshness_seconds === null ? null : agoSeconds(data.freshness_seconds, journey.dataUpdatedAt, now)
  return (
    <>
      <PageHeader
        title={visit.visitor.full_name}
        // Never the visitor's name in the tab's title: the browser keeps titles in its history (§7.2).
        documentTitle={t('detail.title')}
        back={back}
        meta={
          (simulated || visit.visitor.company_name) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-secondary">
              {simulated && <SimulatedBadge size="md" />}
              {visit.visitor.company_name && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                  <span className="min-w-0 break-words">{visit.visitor.company_name}</span>
                </span>
              )}
            </div>
          )
        }
      />
      <TrackingStatusBanner status={status.data} simulatedShown={simulated} />

      {/* On wide screens the location and the timeline are the main column, the visit and the tracking
          the side one; in one column the location, then the tracking and its actions, before the long
          timeline. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 lg:col-span-2">
          <InferredLocationCard
            location={data.last_location}
            observedAt={data.last_observed_at}
            agoSeconds={freshness}
            state={data.state}
            timeZone={timeZone}
            now={now}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <TrackingCard journey={data} me={me} timeZone={timeZone} bannerLine={status.data ? trackingBanner(status.data).line : null} />
          <VisitSummaryCard journey={data} timeZone={timeZone} />
        </div>
        <div className="min-w-0 lg:col-span-2 lg:row-start-2">
          <JourneyTimelineCard events={data.timeline} total={data.timeline_total} timeZone={timeZone} />
        </div>
      </div>
    </>
  )
}
