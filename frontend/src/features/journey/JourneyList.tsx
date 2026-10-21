import { CalendarSearch, FilterX, SearchX, ShieldX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../api/client'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { DateField } from '../../components/ui/DateField'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { FilterPanel } from '../../components/ui/FilterPanel'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { SearchField } from '../../components/ui/SearchField'
import { Select } from '../../components/ui/Select'
import { useBackLinkToHere } from '../../hooks/useBackLink'
import { useNow } from '../../hooks/useNow'
import { useSearchInput } from '../../hooks/useSearchInput'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import type { Me } from '../../types/api'
import { companyToday, formatDateKey } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import {
  activeJourneyFilterCount,
  JOURNEY_PAGE_SIZE,
  journeyFilterChanges,
  journeyListParams,
  readJourneyFilters,
  type JourneyFilters,
} from './journeyFilters'
import { JOURNEY_STATE_META, JOURNEY_STATES, isJourneyState } from './journeyStates'
import { JourneyTable } from './JourneyTable'
import { useJourneyList, useTrackingStatus } from './queries'
import { TrackingStatusBanner } from './TrackingStatusBanner'
import { trackingBanner } from './trackingStatus'

/**
 * «رحلة الزائر» / "Visitor Journey" (§F): the company's visits of a day (today unless another is chosen)
 * that are inside or ended that day, each with its journey state and the last floor and zone a confirmed
 * observation gave, with its time. The one-line tracking banner above; search, state and day as filters,
 * kept in the address (the search text in the history entry's state, as everywhere). A table from 1024 px,
 * cards below. The list is asked again every 30 s while the page is open.
 */
export function JourneyList({ me }: { me: Me }) {
  const { t } = useTranslation(['journey', 'common'])
  const timeZone = me.company.timezone
  const now = useNow(30_000)
  const today = companyToday(timeZone, now)
  const [params, updateParams] = useUrlParams()
  const filters = readJourneyFilters(params)
  const page = readPageParam(params)
  const status = useTrackingStatus()
  const listParams = journeyListParams(filters, page)
  const journeys = useJourneyList(listParams)
  const applyFilters = (changes: Partial<JourneyFilters>) => updateParams(journeyFilterChanges(changes, today))
  const search = useSearchInput(filters.q, (q) => applyFilters({ q }))
  const backLink = useBackLinkToHere(t('detail.back'))
  const activeCount = activeJourneyFilterCount(filters, today)
  const clearFilters = () => {
    search.clear()
    updateParams(journeyFilterChanges({ date: null, state: null, q: '' }, today))
  }
  const data = journeys.data?.page
  // The page says Simulated once, in its line, while the simulator is the provider: the rows then do not repeat it.
  const simulatedShown = status.data !== undefined && trackingBanner(status.data).simulated
  const day = filters.date ?? today
  const forbidden = journeys.isError && isApiError(journeys.error) && journeys.error.status === 403

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={
          <div className="min-h-5">
            {data && <MetaLine items={[t('list.count', { count: data.total, formatted: formatCount(data.total) }), day === today ? t('common:dates.today') : formatDateKey(day)]} />}
          </div>
        }
      />
      <TrackingStatusBanner status={status.data} />

      <FilterPanel activeCount={activeCount}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] xl:items-end">
          <SearchField
            label={t('list.filters.search')}
            placeholder={t('list.filters.searchPlaceholder')}
            value={search.text}
            onValueChange={search.setText}
            onSubmit={search.commitNow}
            onClear={search.clear}
          />
          <Field label={t('list.filters.state')}>
            <Select value={filters.state ?? ''} onChange={(event) => applyFilters({ state: isJourneyState(event.target.value) ? event.target.value : null })}>
              <option value="">{t('list.filters.allStates')}</option>
              {JOURNEY_STATES.map((state) => (
                <option key={state} value={state}>
                  {JOURNEY_STATE_META[state].label}
                </option>
              ))}
            </Select>
          </Field>
          <DateField label={t('list.filters.date')} value={day} max={today} onChange={(date) => applyFilters({ date })} />
          <Button variant="ghost" icon={<FilterX aria-hidden="true" />} disabled={activeCount === 0} focusableWhenDisabled onClick={clearFilters} className="self-start xl:self-end">
            {t('list.filters.clear')}
          </Button>
        </div>
      </FilterPanel>

      <p role="status" className="sr-only">
        {data ? t('list.found', { count: data.total }) : ''}
      </p>

      {forbidden ? (
        <EmptyState icon={ShieldX} title={t('list.noAccess')} description={<ApiErrorMessage error={journeys.error} />} />
      ) : journeys.isError ? (
        <LoadErrorAlert title={t('list.loadError')} error={journeys.error} onRetry={() => void journeys.refetch()} />
      ) : (
        <>
          <JourneyTable
            items={data?.items ?? []}
            timeZone={timeZone}
            now={now}
            answeredAt={journeys.data?.answeredAt ?? 0}
            simulatedShown={simulatedShown}
            backLink={backLink}
            loading={journeys.isPending || journeys.isPlaceholderData}
            empty={
              data && data.total > 0 ? (
                <EmptyState
                  title={t('list.empty.pageTitle')}
                  action={
                    <Button variant="secondary" onClick={() => updateParams({ page: null })}>
                      {t('list.empty.firstPage')}
                    </Button>
                  }
                />
              ) : filters.state !== null || filters.q !== '' ? (
                <EmptyState
                  icon={SearchX}
                  title={t('list.empty.filteredTitle')}
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      {t('list.filters.clear')}
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={CalendarSearch} title={t('list.empty.title')} />
              )
            }
          />
          {data && data.total > 0 && (
            <Pagination
              page={page}
              pageSize={JOURNEY_PAGE_SIZE}
              total={data.total}
              label={t('list.pagesLabel')}
              onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
            />
          )}
        </>
      )}
    </>
  )
}
