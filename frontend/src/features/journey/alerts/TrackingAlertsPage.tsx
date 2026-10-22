import { BellOff, ShieldX } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../../api/client'
import { useAuth } from '../../../auth/useAuth'
import { ApiErrorMessage } from '../../../components/ui/ApiErrorMessage'
import { Button } from '../../../components/ui/Button'
import { DateField } from '../../../components/ui/DateField'
import { EmptyState } from '../../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../../components/ui/MetaLine'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Pagination } from '../../../components/ui/Pagination'
import { PageSpinner } from '../../../components/ui/Spinner'
import { TabPanel, Tabs } from '../../../components/ui/Tabs'
import { useBackLinkToHere } from '../../../hooks/useBackLink'
import { FOCUS_ROW_ATTRIBUTE, useListFocusRecovery } from '../../../hooks/useListFocusRecovery'
import { useNow } from '../../../hooks/useNow'
import { pageParamValue, readDateParam, readEnumParam, readPageParam, useUrlParams } from '../../../hooks/useUrlParams'
import type { Me } from '../../../types/api'
import { companyToday, formatDateKey } from '../../../utils/datetime'
import { formatCount } from '../../../utils/number'
import { useTrackingStatus } from '../queries'
import { TrackingStatusBanner } from '../TrackingStatusBanner'
import { trackingBanner } from '../trackingStatus'
import { AlertActionDialog, type AlertActing } from './AlertActions'
import { AlertCard } from './AlertCard'
import { ALERT_SCOPES, ALERTS_PAGE_SIZE, ALERTS_PARAM, alertListParams } from './alertFilters'
import { AlertSettings } from './AlertSettings'
import { useTrackingAlerts } from './queries'

function AlertsView({ me }: { me: Me }) {
  const { t } = useTranslation(['journey', 'common'])
  const timeZone = me.company.timezone
  const now = useNow(15_000)
  const today = companyToday(timeZone, now)
  const [params, updateParams] = useUrlParams()
  const scope = readEnumParam(params, ALERTS_PARAM.scope, ALERT_SCOPES, 'active')
  const day = readDateParam(params, ALERTS_PARAM.day)
  const page = readPageParam(params)
  const shownDay = day ?? today
  const alerts = useTrackingAlerts(alertListParams(scope, day && day !== today ? day : null, page))
  const status = useTrackingStatus()
  const backLink = useBackLinkToHere(t('alerts.back'))
  const simulatedShown = status.data !== undefined && trackingBanner(status.data).simulated
  const data = alerts.data
  const forbidden = alerts.isError && isApiError(alerts.error) && alerts.error.status === 403
  const [acting, setActing] = useState<AlertActing | null>(null)
  // When an action takes its card off the list (a resolve on the Active tab, or the alert gone meanwhile), the
  // focus goes on to the card now in its place, else to the page's heading (F16-34; no fallback field here).
  const listRef = useRef<HTMLUListElement>(null)
  const noFallback = useRef<HTMLElement>(null)
  const recoverFocus = useListFocusRecovery({ list: listRef, fallback: noFallback, version: data })
  const closeAction = (acted: boolean) => {
    if (acting && (acted || !data?.items.some((alert) => alert.id === acting.alert.id))) recoverFocus(acting.alert.id)
    setActing(null)
  }

  return (
    <>
      <PageHeader
        title={t('alerts.title')}
        meta={
          <div className="min-h-5">
            {data && <MetaLine items={[t('alerts.count', { count: data.total, formatted: formatCount(data.total) }), scope === 'day' && (shownDay === today ? t('common:dates.today') : formatDateKey(shownDay))]} />}
          </div>
        }
      />
      <TrackingStatusBanner status={status.data} />

      <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <Tabs
          idBase="tracking-alerts"
          label={t('alerts.tabs.label')}
          items={[
            { value: 'active', label: t('alerts.tabs.active') },
            { value: 'day', label: t('alerts.tabs.day') },
          ]}
          value={scope}
          onValueChange={(next) => updateParams({ [ALERTS_PARAM.scope]: next === 'active' ? null : next, [ALERTS_PARAM.page]: null })}
        />
        <AlertSettings userId={me.user.id} />
      </div>

      <TabPanel idBase="tracking-alerts" value={scope} selected={scope} className="flex flex-col gap-4">
        {scope === 'day' && (
          <div className="max-w-xs">
            <DateField
              label={t('alerts.date')}
              value={shownDay}
              max={today}
              onChange={(next) => updateParams({ [ALERTS_PARAM.day]: next && next !== today ? next : null, [ALERTS_PARAM.page]: null })}
            />
          </div>
        )}
        <p role="status" className="sr-only">
          {data ? t('alerts.found', { count: data.total }) : ''}
        </p>
        {forbidden ? (
          <EmptyState icon={ShieldX} title={t('alerts.noAccess')} description={<ApiErrorMessage error={alerts.error} />} />
        ) : alerts.isError ? (
          <LoadErrorAlert title={t('alerts.loadError')} error={alerts.error} onRetry={() => void alerts.refetch()} />
        ) : !data ? (
          <PageSpinner label={t('alerts.loading')} />
        ) : data.items.length === 0 ? (
          data.total > 0 ? (
            // Past the last page (its alerts were resolved, or an old link): the way back, not "no alerts" (F16-35).
            <EmptyState
              title={t('list.empty.pageTitle')}
              action={
                <Button variant="secondary" onClick={() => updateParams({ [ALERTS_PARAM.page]: null })}>
                  {t('list.empty.firstPage')}
                </Button>
              }
            />
          ) : (
            <EmptyState icon={BellOff} title={scope === 'active' ? t('alerts.empty.active') : t('alerts.empty.day')} />
          )
        ) : (
          <ul ref={listRef} aria-busy={alerts.isPlaceholderData || undefined} className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            {data.items.map((alert) => (
              <li key={alert.id} {...{ [FOCUS_ROW_ATTRIBUTE]: alert.id }} className="min-w-0">
                <AlertCard alert={alert} timeZone={timeZone} now={now} simulatedShown={simulatedShown} backLink={backLink} onAct={(kind) => setActing({ alert, kind })} />
              </li>
            ))}
          </ul>
        )}
        {data && data.total > 0 && !forbidden && !alerts.isError && (
          <Pagination
            page={page}
            pageSize={ALERTS_PAGE_SIZE}
            total={data.total}
            label={t('alerts.pagesLabel')}
            onPageChange={(next) => updateParams({ [ALERTS_PARAM.page]: pageParamValue(next) })}
          />
        )}
      </TabPanel>
      {acting && <AlertActionDialog alert={acting.alert} kind={acting.kind} onClose={closeAction} />}
    </>
  )
}

/**
 * /journey/alerts «تنبيهات التتبّع» / "Tracking alerts" (Phase 16): the active alerts (open and acknowledged,
 * any day), or a day's (any status), newest first; each with what staff may do about it and the way to the
 * visitor's journey; the viewer's own sound and notification settings. Asked again every 15 s.
 */
export function TrackingAlertsPage() {
  const { me } = useAuth()
  if (!me) return null
  return <AlertsView me={me} />
}
