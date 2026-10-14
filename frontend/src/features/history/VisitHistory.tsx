import { CalendarSearch, FilterX, SearchX } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHostById } from '../../api/queries'
import { hasRole } from '../../auth/roles'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { DateRangeFields } from '../../components/ui/DateRangeFields'
import { Field } from '../../components/ui/Field'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { SearchField } from '../../components/ui/SearchField'
import { useBackLinkToHere } from '../../hooks/useBackLink'
import { useNow } from '../../hooks/useNow'
import { useSearchInput } from '../../hooks/useSearchInput'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import type { Host, Me } from '../../types/api'
import { HostPicker } from '../visits/pickers'
import { FilterPanel } from '../../components/ui/FilterPanel'
import { StatusFilter } from '../../components/ui/StatusFilter'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { dateRangeError, dateRangeFact } from '../../utils/dateRange'
import { formatCount } from '../../utils/number'
import { DepartmentFilter } from './DepartmentFilter'
import {
  activeHistoryFilterCount,
  clearHistoryFilterChanges,
  HISTORY_PAGE_SIZE,
  HISTORY_SEARCH_MIN_LENGTH,
  HISTORY_STATUSES,
  historyFilterChanges,
  historyListParams,
  isHistorySearchable,
  readHistoryFilters,
  type HistoryFilters,
} from './historyFilters'
import { HistoryTable } from './HistoryTable'
import { useHistoryList } from './queries'

/** A stand-in option for a host the filter cannot name (yet): the URL's name is never shown unverified. */
function unnamedHost(id: string, label: string): Host {
  return { id, full_name: label, phone: null, department: null }
}

export interface VisitHistoryProps {
  me: Me
}

/**
 * Company-wide, read-only visit history (§10 /history, D-25) for administrators, management
 * and reception: the page's header with the number of visits found, the filters, and the table.
 * Every filter and the page live in the URL, so a view can be bookmarked and shared; the search
 * text and the host's name are kept in the history entry's state instead (`useUrlParams`), and
 * the back button restores both. Rows link to the visit page, which shows each role only the
 * actions it may take. No notes (decision 3 of the brand pass): the search says what it searches
 * in its placeholder, and only the three-character minimum is said under it.
 */
export function VisitHistory({ me }: VisitHistoryProps) {
  const { t } = useTranslation(['history', 'common'])
  const timeZone = me.company.timezone
  const now = useNow()
  const [params, updateParams] = useUrlParams()
  const filters = readHistoryFilters(params)
  const page = readPageParam(params)

  const applyFilters = (changes: Partial<HistoryFilters>) => updateParams(historyFilterChanges(changes))
  // The host is named as the server has it: the one just picked, else looked up by its ID.
  const [pickedHost, setPickedHost] = useState<Host | null>(null)
  const picked = filters.host !== null && pickedHost?.id === filters.host.id ? pickedHost : null
  const hostLookup = useHostById(picked ? null : filters.host)
  const hostValue = !filters.host
    ? null
    : (picked ?? hostLookup.data ?? unnamedHost(filters.host.id, hostLookup.isPending ? t('filters.hostLoading') : t('filters.hostSelected')))
  const search = useSearchInput(filters.q, (q) => applyFilters({ q }))
  const rangeError = dateRangeError(filters.from, filters.to)
  const listParams = historyListParams(filters, page)
  const visits = useHistoryList(listParams)

  const activeCount = activeHistoryFilterCount(filters)
  const clearFilters = () => {
    search.clear()
    updateParams(clearHistoryFilterChanges())
  }
  const backLink = useBackLinkToHere(t('backLabel'))
  const data = listParams ? visits.data : undefined
  const rows = data?.items ?? []

  return (
    <>
      <PageHeader
        title={t('title')}
        // The view as facts: how many visits it holds and the dates it covers, read back in the app's
        // format (the date inputs show the browser's). The line keeps its height while the first page
        // loads, so the page does not jump.
        meta={
          <div className="min-h-5">
            {data && (
              <MetaLine
                stackOnPhones
                items={[
                  t('count', { count: data.total, formatted: formatCount(data.total) }),
                  !rangeError && dateRangeFact(filters.from, filters.to),
                ]}
              />
            )}
          </div>
        }
      />
      <FilterPanel activeCount={activeCount}>
        {/* One row of labels and one of controls: the dates' "From" and "To" sit level with the other
            labels (the group is named "Scheduled date" for assistive technology). The dates need 22rem
            (two 10.5rem inputs, whose empty placeholder must clear the calendar button, and their gap);
            the search takes a larger share of the rest for its placeholder. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <SearchField
            label={t('filters.search')}
            placeholder={t('filters.searchPlaceholder')}
            // Searched from three characters (B57-65); the list is not narrowed by fewer.
            hint={
              search.text.trim() !== '' && !isHistorySearchable(search.text)
                ? t('filters.searchMinLength', { count: HISTORY_SEARCH_MIN_LENGTH })
                : undefined
            }
            value={search.text}
            onValueChange={search.setText}
            onSubmit={search.commitNow}
            onClear={search.clear}
          />
          <DateRangeFields legend={t('filters.dates')} from={filters.from} to={filters.to} error={rangeError} onChange={(range) => applyFilters(range)} />
          <Field label={t('filters.host')}>
            <HostPicker
              value={hostValue}
              // Every filter names its "all" state, as the department's does.
              placeholder={t('filters.hostAll')}
              onChange={(host) => {
                setPickedHost(host)
                applyFilters({ host: host ? { id: host.id, nameHint: host.full_name } : null })
              }}
            />
          </Field>
          <Field label={t('filters.department')}>
            <DepartmentFilter
              value={filters.departmentId}
              includeInactive={hasRole(me.user.roles, 'SYSTEM_ADMIN')}
              onChange={(departmentId) => applyFilters({ departmentId })}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <StatusFilter statuses={HISTORY_STATUSES} value={filters.statuses} onChange={(statuses) => applyFilters({ statuses })} />
          <Button
            variant="ghost"
            icon={<FilterX aria-hidden="true" />}
            disabled={activeCount === 0}
            focusableWhenDisabled
            onClick={clearFilters}
            className="self-start md:self-auto"
          >
            {t('filters.clear')}
          </Button>
        </div>
      </FilterPanel>

      <p role="status" className="sr-only">
        {data ? t('found', { count: data.total }) : ''}
      </p>

      {rangeError ? (
        // The error itself is said once, under "To" (the field to correct).
        <EmptyState icon={CalendarSearch} title={t('checkDates')} />
      ) : visits.isError ? (
        <LoadErrorAlert title={t('loadError')} error={visits.error} onRetry={() => void visits.refetch()} />
      ) : (
        <>
          <HistoryTable
            visits={rows}
            timeZone={timeZone}
            now={now}
            backLink={backLink}
            loading={visits.isPending || visits.isPlaceholderData}
            empty={
              data && data.total > 0 ? (
                <EmptyState
                  title={t('empty.pageTitle')}
                  action={
                    <Button variant="secondary" onClick={() => updateParams({ page: null })}>
                      {t('empty.firstPage')}
                    </Button>
                  }
                />
              ) : activeCount > 0 ? (
                <EmptyState
                  icon={SearchX}
                  title={t('empty.filteredTitle')}
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      {t('filters.clear')}
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={CalendarSearch} title={t('empty.title')} />
              )
            }
          />
          {data && data.total > 0 && (
            <Pagination
              page={page}
              pageSize={HISTORY_PAGE_SIZE}
              total={data.total}
              label={t('pagesLabel')}
              onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
            />
          )}
        </>
      )}
    </>
  )
}
