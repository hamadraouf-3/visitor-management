import type { TFunction } from 'i18next'
import { Contact, SearchX, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { hasAnyRole, SECTION_ACCESS } from '../../auth/roles'
import { Avatar } from '../../components/ui/Avatar'
import { Button, ButtonLink } from '../../components/ui/Button'
import { EmailText } from '../../components/ui/EmailText'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PhoneNumber } from '../../components/ui/PhoneLink'
import { Pagination } from '../../components/ui/Pagination'
import { SearchField } from '../../components/ui/SearchField'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { Table, type TableColumn } from '../../components/ui/Table'
import { tableRowLinkProps } from '../../components/ui/tableStyles'
import { backLinkState, useBackLinkToHere, type BackLink } from '../../hooks/useBackLink'
import { useNow } from '../../hooks/useNow'
import { useSearchInput } from '../../hooks/useSearchInput'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import { paths } from '../../paths'
import type { Me, VisitorSearchItem } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatDate } from '../../utils/datetime'
import { formatTodayVisitTime } from '../visits/format'
import { ListPanel } from '../../components/ui/ListPanel'
import { useVisitorSearch, VISITORS_PAGE_SIZE } from './queries'
import { VISITOR_STAT_LABELS } from './visitorFields'

const ROW_LINK = tableRowLinkProps('md')
/** Direction C's rows centre their cells on the avatar (the table layout only). */
const MIDDLE = 'md:align-middle'
const NONE = <span className="text-fg-muted">—</span>

interface VisitorColumnContext {
  timeZone: string
  back: BackLink
  now: number
}

/** Whether the visitor is in the building now (one of today's visits is checked in). */
function isInside(item: VisitorSearchItem): boolean {
  return item.today_visits.some((visit) => visit.status === 'CHECKED_IN')
}

/**
 * The visitor's SCHEDULED / CHECKED_IN visits today (in scope), each linking to the visit. The
 * column says "Today", so a visit is only its time ("from 22:42" when it ends on a later day).
 */
function TodayVisits({ item, timeZone, back, now }: VisitorColumnContext & { item: VisitorSearchItem }) {
  const { t } = useTranslation('visitors')
  if (item.today_visits.length === 0) return NONE
  // Above the card-wide visitor link (stacked layout), so these links stay their own targets.
  return (
    <ul className="relative z-10 flex flex-col gap-1.5">
      {item.today_visits.map((visit) => {
        const time = formatTodayVisitTime(visit.scheduled_start, visit.scheduled_end, timeZone, now)
        return (
          <li key={visit.id} className="flex flex-wrap items-center gap-2">
            {/* The name starts with the visible time (WCAG 2.5.3) and adds the host for context. */}
            <Link
              to={paths.visit(visit.id)}
              state={backLinkState(back)}
              aria-label={t('search.todayVisitWith', { time, host: visit.host.full_name })}
              className="inline-flex min-h-6 items-center font-numeric font-medium text-accent-text tabular-nums hover:underline pointer-coarse:min-h-11"
            >
              {time}
            </Link>
            <StatusBadge type="visit" status={visit.status} />
          </li>
        )
      })}
    </ul>
  )
}

function visitorColumns({ timeZone, back, now, t }: VisitorColumnContext & { t: TFunction<'visitors'> }): TableColumn<VisitorSearchItem>[] {
  return [
    {
      id: 'visitor',
      header: t('search.columns.visitor'),
      primary: true,
      className: MIDDLE,
      // Direction C's row: the avatar, the name (the link to the profile) over the company.
      cell: (item) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={item.full_name} tone={isInside(item) ? 'emphasis' : 'neutral'} className="max-md:hidden" />
          <div className="min-w-0">
            <Link
              to={paths.visitor(item.id)}
              state={backLinkState(back)}
              {...ROW_LINK}
              className={cn('font-semibold break-words text-accent-text hover:underline md:text-[0.90625rem] md:leading-snug', ROW_LINK.className)}
            >
              {item.full_name}
            </Link>
            {item.company_name && <p className="text-sm font-normal break-words text-fg-muted md:text-[0.78125rem] md:leading-snug">{item.company_name}</p>}
          </div>
        </div>
      ),
    },
    {
      id: 'contact',
      header: t('search.columns.contact'),
      className: MIDDLE,
      isEmpty: (item) => !item.email && !item.phone,
      // One line per value; a long address is cut with an ellipsis and shown whole on hover.
      cell: (item) =>
        item.email || item.phone ? (
          <span className="flex min-w-0 flex-col leading-snug md:max-w-64">
            {item.email && <EmailText address={item.email} overflow="truncate" />}
            {item.phone && <PhoneNumber className="text-[0.78125rem] whitespace-nowrap text-fg-muted">{item.phone}</PhoneNumber>}
          </span>
        ) : (
          NONE
        ),
    },
    {
      id: 'today',
      header: t('search.columns.today'),
      className: MIDDLE,
      isEmpty: (item) => item.today_visits.length === 0,
      cell: (item) => <TodayVisits item={item} timeZone={timeZone} back={back} now={now} />,
    },
    {
      id: 'last',
      header: VISITOR_STAT_LABELS.lastCheckIn,
      className: MIDDLE,
      isEmpty: (item) => item.stats.last_visit_at === null,
      // One line in the table only: in a 320 px card a long Arabic date (weekday and Levantine month) wraps.
      cell: (item) =>
        item.stats.last_visit_at ? <span className="text-fg-secondary md:whitespace-nowrap">{formatDate(item.stats.last_visit_at, timeZone)}</span> : NONE,
    },
    {
      id: 'total',
      header: VISITOR_STAT_LABELS.total,
      className: MIDDLE,
      align: 'end',
      cell: (item) => <span className="font-numeric text-[0.9375rem] font-semibold text-fg tabular-nums">{item.stats.total_visits}</span>,
    },
  ]
}

/**
 * Visitor search (§10 /visitors), direction C: one card with the search as its header, the
 * visitors (scoped by the server, §7.5), each with their visits today, and the pagination. A
 * visitor inside the building now is highlighted. Debounced; the search text and page are kept
 * with the page (the text in the history entry's state, never in the URL: `useUrlParams`). A
 * search without matches offers to invite a new visitor to those who may.
 */
export function VisitorSearch({ me }: { me: Me }) {
  const { t } = useTranslation('visitors')
  const timeZone = me.company.timezone
  const [params, updateParams] = useUrlParams()
  const q = params.get('q')?.trim() ?? ''
  const page = readPageParam(params)
  const search = useSearchInput(q, (value) => updateParams({ q: value, page: null }))
  const result = useVisitorSearch({ ...(q ? { q } : {}), page, page_size: VISITORS_PAGE_SIZE })
  const back = useBackLinkToHere(t('backToVisitors'))
  const canInvite = hasAnyRole(me.user.roles, SECTION_ACCESS.inviteVisitor)
  const now = useNow()
  const data = result.data

  const empty = q ? (
    <EmptyState
      icon={SearchX}
      title={t('search.noMatchesTitle', { q })}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={search.clear}>
            {t('search.clear')}
          </Button>
          {canInvite && (
            <ButtonLink to={paths.inviteVisitor} variant="secondary" icon={<UserPlus aria-hidden="true" />}>
              {t('search.inviteNew')}
            </ButtonLink>
          )}
        </div>
      }
    />
  ) : (
    <EmptyState
      icon={Contact}
      title={t('search.emptyTitle')}
      action={
        canInvite ? (
          <ButtonLink to={paths.inviteVisitor} icon={<UserPlus aria-hidden="true" />}>
            {t('search.invite')}
          </ButtonLink>
        ) : undefined
      }
    />
  )

  return (
    <ListPanel
      frameFrom="md"
      toolbar={
        <SearchField
          label={t('search.label')}
          labelHidden
          placeholder={t('search.placeholder')}
          value={search.text}
          onValueChange={search.setText}
          onSubmit={search.commitNow}
          onClear={search.clear}
          className="max-w-md"
        />
      }
      footer={
        !result.isError &&
        data &&
        data.total > 0 && (
          <Pagination
            page={page}
            pageSize={VISITORS_PAGE_SIZE}
            total={data.total}
            label={t('search.pagesLabel')}
            onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
          />
        )
      }
    >
      {result.isError ? (
        <LoadErrorAlert title={t('search.loadError')} error={result.error} onRetry={() => void result.refetch()} />
      ) : (
        <Table
          columns={visitorColumns({ timeZone, back, now, t })}
          rows={data?.items ?? []}
          getRowKey={(item) => item.id}
          caption={q ? t('search.captionMatching', { q }) : t('search.title')}
          loading={result.isPending || result.isPlaceholderData}
          empty={empty}
          framed={false}
          isRowHighlighted={isInside}
        />
      )}
    </ListPanel>
  )
}
