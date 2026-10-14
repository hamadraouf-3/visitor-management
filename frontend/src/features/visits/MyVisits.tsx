import type { TFunction } from 'i18next'
import { CalendarCheck, CalendarClock, CalendarDays, CircleCheck, RotateCw, SearchX, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, ButtonLink } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { SearchField } from '../../components/ui/SearchField'
import { Select } from '../../components/ui/Select'
import { TabPanel, Tabs } from '../../components/ui/Tabs'
import { useBackLinkToHere } from '../../hooks/useBackLink'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useNow } from '../../hooks/useNow'
import { useSearchInput } from '../../hooks/useSearchInput'
import { pageParamValue, readEnumParam, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import { paths } from '../../paths'
import type { EmployeeDashboard, Me } from '../../types/api'
import { ListPanel } from '../../components/ui/ListPanel'
import {
  DEFAULT_MY_VISITS_TAB,
  filteredEmptyTitle,
  MY_VISITS_PAGE_SIZE,
  MY_VISITS_SHOW_OPTIONS,
  MY_VISITS_TAB_LABELS,
  MY_VISITS_TABLE_CAPTIONS,
  MY_VISITS_TABS,
  readShow,
  searchEmptyTitle,
  tabCount,
  visitListParamsForTab,
  type MyVisitsShow,
  type MyVisitsTab,
} from './myVisitsTabs'
import { useEmployeeDashboard, useVisitList } from './queries'
import { VisitTable } from './VisitTable'

const TABS_ID = 'my-visits'

/**
 * The line of facts under the title (direction C's meta line): visitors inside now (a live dot
 * while there are any) and the last 30 days. Today, upcoming and needs-attention counts are the
 * tab badges, so they are not repeated. The line keeps its height while the counts load, so the
 * list below does not jump. On phones the two facts do not fit one row: each takes its own line,
 * without the dot between them.
 */
function VisitSummary({ counts, failed, onRetry }: { counts: EmployeeDashboard['counts'] | undefined; failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation(['visits', 'common'])
  const inside = counts ? t('myVisits.summary.insideNow', { count: counts.inside }) : ''
  return (
    <section
      aria-label={t('myVisits.summary.label')}
      className="flex min-h-8 flex-col items-start gap-x-2.5 gap-y-0.5 text-sm text-fg-secondary sm:flex-row sm:flex-wrap sm:items-center"
    >
      {counts ? (
        <>
          {counts.inside > 0 ? (
            // Direction C's live dot (it stops pulsing under reduced motion); the words say it.
            <span className="inline-flex items-center gap-1.5 font-medium text-fg">
              <span aria-hidden="true" className="size-2 shrink-0 animate-live rounded-full bg-success-solid" />
              {inside}
            </span>
          ) : (
            <span>{inside}</span>
          )}
          <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-border-strong max-sm:hidden" />
          <span>
            {t('myVisits.summary.lastPrefix')}
            {t('myVisits.summary.last30Days', { completed: counts.completed_30d, cancelled: counts.cancelled_30d })}
          </span>
        </>
      ) : failed ? (
        <span role="status" className="flex flex-wrap items-center gap-2">
          {t('myVisits.summary.unavailable')}
          <Button variant="ghost" size="sm" icon={<RotateCw aria-hidden="true" />} onClick={onRetry}>
            {t('common:actions.tryAgain')}
          </Button>
        </span>
      ) : (
        <span>{t('myVisits.summary.loading')}</span>
      )}
    </section>
  )
}

/** An empty list: a short title, an icon and the way on (no explanation, decision 3). */
function emptyStateFor(
  t: TFunction<'visits'>,
  tab: MyVisitsTab,
  show: MyVisitsShow,
  q: string,
  onClearSearch: () => void,
  onShowDefault: () => void,
) {
  if (q) {
    return (
      <EmptyState
        icon={SearchX}
        title={searchEmptyTitle(tab, q)}
        action={
          <Button variant="secondary" onClick={onClearSearch}>
            {t('myVisits.empty.clearSearch')}
          </Button>
        }
      />
    )
  }
  if (show !== 'default') {
    return (
      <EmptyState
        icon={SearchX}
        title={filteredEmptyTitle(tab, show)}
        action={
          <Button variant="secondary" onClick={onShowDefault}>
            {t('myVisits.empty.showDefault', { option: MY_VISITS_SHOW_OPTIONS[tab][0]?.label.toLowerCase() ?? '' })}
          </Button>
        }
      />
    )
  }
  const invite = (
    <ButtonLink to={paths.inviteVisitor} icon={<UserPlus aria-hidden="true" />}>
      {t('myVisits.invite')}
    </ButtonLink>
  )
  switch (tab) {
    case 'today':
      return <EmptyState icon={CalendarDays} title={t('myVisits.empty.todayTitle')} action={invite} />
    case 'upcoming':
      return <EmptyState icon={CalendarClock} title={t('myVisits.empty.upcomingTitle')} action={invite} />
    case 'past':
      return <EmptyState icon={CalendarCheck} title={t('myVisits.empty.pastTitle')} />
    case 'attention':
      return <EmptyState icon={CircleCheck} title={t('myVisits.empty.attentionTitle')} />
  }
}

export interface MyVisitsProps {
  me: Me
}

/**
 * "My visits" (§10), direction C: the title with the summary as its line of facts (from the
 * employee dashboard), the tabs as a segmented control whose badges carry the dashboard counts,
 * then the selected tab's visits as one card: search and status choice as its header, the table,
 * the pagination. Tab, status choice and page live in the URL (`?tab=&show=&page=`), so views can
 * be bookmarked and shared; the search text is kept in the history entry's state instead
 * (`useUrlParams`), so the back button still restores it.
 */
export function MyVisits({ me }: MyVisitsProps) {
  const { t } = useTranslation('visits')
  const timeZone = me.company.timezone
  const [params, updateParams] = useUrlParams()
  const tab = readEnumParam(params, 'tab', MY_VISITS_TABS, DEFAULT_MY_VISITS_TAB)
  const show = readShow(tab, params.get('show'))
  const q = params.get('q')?.trim() ?? ''
  const page = readPageParam(params)

  const search = useSearchInput(q, (value) => updateParams({ q: value, page: null }))
  const now = useNow()
  const dashboard = useEmployeeDashboard()
  const visits = useVisitList(visitListParamsForTab({ tab, show, q, page }, timeZone, now))
  const counts = dashboard.data?.counts

  const selectTab = (next: MyVisitsTab) =>
    updateParams({ tab: next === DEFAULT_MY_VISITS_TAB ? null : next, show: null, page: null })
  const selectShow = (next: MyVisitsShow) => updateParams({ show: next === 'default' ? null : next, page: null })

  const backLink = useBackLinkToHere(t('backToMyVisits'))
  // From sm the field is wide enough to name what it searches; on a phone it shares its row with
  // the status choice, and anything longer than one word would be cut off.
  const roomyToolbar = useMediaQuery('(min-width: 40rem)')
  const data = visits.data
  const showOptions = MY_VISITS_SHOW_OPTIONS[tab]
  // Both requests failed (e.g. the server is down): one message and one retry, not two.
  const allFailed = dashboard.isError && visits.isError

  const invite = (
    <ButtonLink to={paths.inviteVisitor} icon={<UserPlus aria-hidden="true" />}>
      {t('myVisits.invite')}
    </ButtonLink>
  )

  return (
    <>
      {/* On phones the same link sits beside the title instead of a full-width row above the list. */}
      <PageHeader
        title={t('myVisits.title')}
        meta={!allFailed && <VisitSummary counts={counts} failed={dashboard.isError} onRetry={() => void dashboard.refetch()} />}
        actions={invite}
        mobileActions={invite}
      />

      {/* Four tabs with counts do not fit one phone-width row: on phones they form a 2×2 grid, so
          "Needs attention", the most actionable one, is never cut off. */}
      <Tabs
        idBase={TABS_ID}
        label={t('myVisits.tabsLabel')}
        value={tab}
        onValueChange={selectTab}
        phoneLayout="grid"
        className="mb-4"
        items={MY_VISITS_TABS.map((value) => {
          const count = tabCount(value, counts)
          return {
            value,
            label: MY_VISITS_TAB_LABELS[value],
            badge: count,
            badgeTone: value === 'attention' && count !== undefined && count > 0 ? ('warning' as const) : undefined,
          }
        })}
      />
      <TabPanel idBase={TABS_ID} value={tab} selected={tab}>
        <ListPanel
          frameFrom="lg"
          toolbar={
            // Search and status choice share one row, also on phones. The search names what it
            // searches in its placeholder; the status choice shows its current option, whole: on
            // phones it is as wide as its longest option (a fixed 160 px cut "All but cancelled"
            // and «الكل عدا الملغاة» off mid-word) and the search takes the rest.
            <div className="flex items-center gap-2 sm:gap-3">
              <SearchField
                label={t('myVisits.search.label')}
                labelHidden
                placeholder={roomyToolbar ? t('myVisits.search.placeholder') : t('myVisits.search.placeholderShort')}
                value={search.text}
                onValueChange={search.setText}
                onSubmit={search.commitNow}
                onClear={search.clear}
                className="min-w-0 flex-1 sm:max-w-md"
              />
              {showOptions.length > 0 && (
                <Select
                  aria-label={t('myVisits.show.label')}
                  value={show}
                  onChange={(event) => selectShow(readShow(tab, event.target.value))}
                  className="shrink-0 sm:ms-auto sm:w-52"
                >
                  {showOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          }
          footer={
            !visits.isError &&
            data &&
            data.total > 0 && (
              <Pagination
                page={page}
                pageSize={MY_VISITS_PAGE_SIZE}
                total={data.total}
                label={t('myVisits.pagesLabel')}
                onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
              />
            )
          }
        >
          {visits.isError ? (
            <LoadErrorAlert
              title={allFailed ? t('myVisits.loadErrorAll') : t('myVisits.loadError')}
              error={visits.error}
              onRetry={() => {
                void visits.refetch()
                if (dashboard.isError) void dashboard.refetch()
              }}
            />
          ) : (
            <VisitTable
              visits={data?.items ?? []}
              caption={MY_VISITS_TABLE_CAPTIONS[tab]}
              timeZone={timeZone}
              now={now}
              backLink={backLink}
              currentUserId={me.user.id}
              loading={visits.isPending || visits.isPlaceholderData}
              framed={false}
              empty={
                data && data.total > 0 ? (
                  <EmptyState
                    title={t('myVisits.empty.pageTitle')}
                    action={
                      <Button variant="secondary" onClick={() => updateParams({ page: null })}>
                        {t('myVisits.empty.firstPage')}
                      </Button>
                    }
                  />
                ) : (
                  emptyStateFor(t, tab, show, q, search.clear, () => selectShow('default'))
                )
              }
            />
          )}
        </ListPanel>
      </TabPanel>
    </>
  )
}
