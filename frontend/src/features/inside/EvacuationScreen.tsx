import { CalendarClock, Clock, Printer, RotateCw, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { LiveIndicator } from '../../components/ui/LiveIndicator'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { StatTile } from '../../components/ui/StatTile'
import { useCompanyName } from '../../i18n/useLanguage'
import type { Me } from '../../types/api'
import { formatClockTime } from '../../utils/datetime'
import { previousDayLabel } from '../visits/insideFlags'
import { EvacuationList } from './EvacuationList'
import { insideSummary, sortForRollCall } from './insideList'
import { PrintableEvacuationList } from './PrintableEvacuationList'
import { usePrintWhenFresh } from './usePrintWhenFresh'

export interface EvacuationScreenProps {
  me: Me
}

/**
 * The evacuation list (§10, D-25) for administrators, management and reception, in direction C:
 * the time of the list under the title (live: it is refreshed every 15 seconds), the headcount as
 * the dark emphasis tile beside the flag counts, then everyone checked in (any date) with hosts
 * and their phones. "Print list" first fetches the current list, then prints a black-on-white
 * page with the headcount and the time it was generated (see usePrintWhenFresh).
 */
export function EvacuationScreen({ me }: EvacuationScreenProps) {
  const { t } = useTranslation(['inside', 'common'])
  const timeZone = me.company.timezone
  const companyName = useCompanyName(me.company)
  const { list, refresh, refreshing, print, preparingPrint } = usePrintWhenFresh(timeZone)
  const data = list.data
  const generatedAt = list.dataUpdatedAt
  const visits = sortForRollCall(data?.items ?? [])
  const summary = insideSummary(data?.count ?? 0, visits)

  // The list's own time, the dot pulsing while it is refreshed in the background (every 15 s).
  const updated = data && !list.isError && (
    <LiveIndicator label={t('updatedAt', { time: formatClockTime(generatedAt, timeZone) })} />
  )
  const stale = data && list.isError && t('updatedAt', { time: formatClockTime(generatedAt, timeZone) })

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={t('title')}
          meta={data && <MetaLine items={[updated, stale]} />}
          actions={
            <>
              <Button variant="secondary" icon={<RotateCw aria-hidden="true" />} loading={refreshing} onClick={() => void refresh()}>
                {t('refresh')}
              </Button>
              <Button icon={<Printer aria-hidden="true" />} loading={preparingPrint} disabled={!data} onClick={() => void print()}>
                {t('printList')}
              </Button>
            </>
          }
        />

        {list.isError && !data ? (
          <LoadErrorAlert title={t('loadError')} error={list.error} onRetry={() => void refresh()} />
        ) : (
          <>
            {list.isError && data && (
              <Alert
                tone="warning"
                role="status"
                title={t('refreshFailed.title')}
                className="mb-4"
                action={
                  <Button variant="secondary" icon={<RotateCw aria-hidden="true" />} loading={refreshing} onClick={() => void refresh()}>
                    {t('common:actions.tryAgain')}
                  </Button>
                }
              >
                {t('refreshFailed.description', { time: formatClockTime(generatedAt, timeZone) })} <ApiErrorMessage error={list.error} />
              </Alert>
            )}

            <section aria-label={t('summary.label')} className="mb-6">
              {/* Phones: the headcount across the row, the two flag counts beside each other under it. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
                <StatTile
                  label={t('summary.headcount')}
                  value={data ? summary.headcount : '…'}
                  icon={UsersRound}
                  variant="emphasis"
                  className="max-sm:col-span-2"
                />
                <StatTile
                  label={t('summary.overdue')}
                  value={data ? summary.overdue : '…'}
                  icon={Clock}
                  tone={summary.overdue > 0 ? 'warning' : 'neutral'}
                />
                <StatTile
                  label={previousDayLabel()}
                  value={data ? summary.previousDays : '…'}
                  icon={CalendarClock}
                  tone={summary.previousDays > 0 ? 'warning' : 'neutral'}
                />
              </div>
            </section>

            <EvacuationList visits={visits} timeZone={timeZone} now={generatedAt} loading={list.isPending} />
          </>
        )}
      </div>

      {data && (
        <PrintableEvacuationList
          companyName={companyName}
          timeZone={timeZone}
          generatedAt={generatedAt}
          headcount={summary.headcount}
          visits={visits}
          printedBy={me.user.full_name}
        />
      )}
    </>
  )
}
