import { CalendarCheck, SearchX } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { CountBadge } from '../../components/ui/CountBadge'
import { EmptyState } from '../../components/ui/EmptyState'
import { SearchField } from '../../components/ui/SearchField'
import { PageSpinner } from '../../components/ui/Spinner'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { useListFocusRecovery } from '../../hooks/useListFocusRecovery'
import { useNow } from '../../hooks/useNow'
import { useStableId } from '../../hooks/useStableId'
import type { ReceptionToday, Visit } from '../../types/api'
import { formatTodayVisitTime } from '../visits/format'
import { VisitActionDialog, type ListVisitAction } from './VisitActionDialog'
import { arrivalStatus, expectedGroup, matchesVisitFilter } from './visitActions'
import { VisitList } from './VisitRow'
import { ActionVisitRow } from './VisitRowAction'
import type { WalkInPrefill } from './walkInForm'

export interface ExpectedPanelProps {
  today: ReceptionToday | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  timeZone: string
  onWalkIn: (prefill: WalkInPrefill) => void
  /** A check-in succeeded (the scanner leaves a result about the same visit). */
  onVisitChanged: (visit: Visit) => void
}

interface ExpectedRowProps {
  visit: Visit
  timeZone: string
  now: number
  onAction: (action: ListVisitAction) => void
  onWalkIn: (prefill: WalkInPrefill) => void
}

/** One expected visitor: where they stand against their pass window, and the action `rowAction` gives the visit. */
function ExpectedRow({ visit, timeZone, now, onAction, onWalkIn }: ExpectedRowProps) {
  const status = arrivalStatus(visit, now, timeZone)
  return (
    <ActionVisitRow
      visit={visit}
      now={now}
      // Today's visits: the time alone, "from 23:15" for one that ends after midnight (not two full dates).
      when={formatTodayVisitTime(visit.scheduled_start, visit.scheduled_end, timeZone, now)}
      whenNumeric
      badges={<Badge tone={status.tone}>{status.label}</Badge>}
      onAction={onAction}
      onWalkIn={onWalkIn}
    />
  )
}

interface ExpectedGroupProps {
  title: string
  visits: readonly Visit[]
  row: (visit: Visit) => ReactNode
  /** The count in mawdoo3's yellow: the group needs action (today's no-shows). */
  attention?: boolean
}

/** A group of the Expected tab: its title with the count (direction C's section header), then its rows. */
function ExpectedGroupSection({ title, visits, row, attention = false }: ExpectedGroupProps) {
  const headingId = useStableId('expected-group')
  if (visits.length === 0) return null
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="flex items-center gap-2.5 text-section font-bold text-fg">
        {title}
        {/* A space for the accessible name ("Arriving now 3"). */}{' '}
        <CountBadge tone={attention ? 'attention' : 'neutral'}>{visits.length}</CountBadge>
      </h2>
      <VisitList>{visits.map(row)}</VisitList>
    </section>
  )
}

/**
 * Expected tab (§10): today's SCHEDULED visits with an inline filter, in three groups with
 * their counts and no notes: arriving now (the pass is valid, or the visitor is late), later
 * today (the pass is not valid yet) and today's no-shows, since a late visitor can still be
 * checked in anyway on the same day. After a check-in the visitor leaves the list; focus moves to the
 * next visitor's action (or the filter), never to the page.
 */
export function ExpectedPanel({ today, loading, error, onRetry, timeZone, onWalkIn, onVisitChanged }: ExpectedPanelProps) {
  const { t } = useTranslation('reception')
  const now = useNow(15_000)
  const [filter, setFilter] = useState('')
  const [action, setAction] = useState<ListVisitAction | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const recoverFocus = useListFocusRecovery({ list: listRef, fallback: filterRef, version: today })

  if (!today) {
    if (loading) return <PageSpinner label={t('expected.loading')} />
    return <LoadErrorAlert title={t('expected.loadError')} error={error} onRetry={onRetry} />
  }

  const expected = today.expected.filter((visit) => matchesVisitFilter(visit, filter))
  const arriving = expected.filter((visit) => expectedGroup(visit, now) === 'arriving')
  const later = expected.filter((visit) => expectedGroup(visit, now) === 'later')
  const noShows = today.no_show.filter((visit) => matchesVisitFilter(visit, filter))
  const truncated = today.counts.expected > today.expected.length
  const row = (visit: Visit) => (
    <ExpectedRow key={visit.id} visit={visit} timeZone={timeZone} now={now} onAction={setAction} onWalkIn={onWalkIn} />
  )

  return (
    <div ref={listRef} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <SearchField
          label={t('expected.filter')}
          labelHidden
          placeholder={t('filterPlaceholder')}
          value={filter}
          onValueChange={setFilter}
          onClear={() => setFilter('')}
          inputRef={filterRef}
          className="sm:max-w-md sm:flex-1"
        />
        {truncated && (
          <p className="text-meta text-fg-muted">{t('expected.truncated', { shown: today.expected.length, total: today.counts.expected })}</p>
        )}
      </div>

      {today.expected.length === 0 && today.no_show.length === 0 ? (
        <EmptyState icon={CalendarCheck} title={t('expected.emptyTitle')} />
      ) : expected.length === 0 && noShows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('expected.noMatch', { filter: filter.trim() })}
          action={
            <Button variant="secondary" onClick={() => setFilter('')}>
              {t('clearFilter')}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-7">
          <ExpectedGroupSection title={t('expected.arriving')} visits={arriving} row={row} />
          <ExpectedGroupSection title={t('expected.later')} visits={later} row={row} />
          <ExpectedGroupSection title={t('expected.noShows')} visits={noShows} row={row} attention />
        </div>
      )}

      {action && (
        <VisitActionDialog
          action={action}
          timeZone={timeZone}
          now={now}
          onDone={(visit) => {
            recoverFocus(visit.id)
            onVisitChanged(visit)
          }}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  )
}
