import { UserPlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { EmailText } from '../../components/ui/EmailText'
import { HighlightMatch } from '../../components/ui/HighlightMatch'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { SearchField } from '../../components/ui/SearchField'
import { Spinner } from '../../components/ui/Spinner'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useListFocusRecovery } from '../../hooks/useListFocusRecovery'
import { useNow } from '../../hooks/useNow'
import type { Visit, VisitorSearchItem } from '../../types/api'
import { formatTimeRange } from '../../utils/datetime'
import { InsideFlagBadges } from '../visits/InsideFlagBadges'
import { useVisitorLookup, VISITOR_LOOKUP_SIZE } from './queries'
import { VisitActionDialog, type ListVisitAction } from './VisitActionDialog'
import { arrivalStatus, checkedInLabel, orderSearchResults, withTodayNoShows } from './visitActions'
import { VisitList } from './VisitRow'
import { ActionVisitRow } from './VisitRowAction'
import type { WalkInPrefill } from './walkInForm'

const MIN_QUERY_LENGTH = 2
const SEARCH_DEBOUNCE_MS = 300
/** Results shown at first; the rest of the page behind "Show all". */
const RESULTS_AT_ONCE = 5

interface TodayVisitProps {
  visit: Visit
  timeZone: string
  now: number
  onAction: (action: ListVisitAction) => void
  onWalkIn: (prefill: WalkInPrefill) => void
}

/**
 * One of the visitor's visits (SCHEDULED or a no-show today, or CHECKED_IN on any day) as the
 * Expected and Inside lists show it, with the action `rowAction` gives it: the same labels and the same
 * early check-in rule as Expected. The visitor is named above the row, so the row leaves the
 * name out.
 */
function TodayVisit({ visit, timeZone, now, onAction, onWalkIn }: TodayVisitProps) {
  const inside = visit.status === 'CHECKED_IN'
  const status = arrivalStatus(visit, now, timeZone)
  return (
    <ActionVisitRow
      visit={visit}
      now={now}
      showVisitor={false}
      when={
        inside ? checkedInLabel(visit, now, timeZone) : formatTimeRange(visit.scheduled_start, visit.scheduled_end, timeZone)
      }
      whenNumeric={!inside}
      badges={
        inside ? (
          <>
            <StatusBadge type="visit" status={visit.status} />
            <InsideFlagBadges visit={visit} timeZone={timeZone} now={now} />
          </>
        ) : (
          <Badge tone={status.tone}>{status.label}</Badge>
        )
      }
      onAction={onAction}
      onWalkIn={onWalkIn}
    />
  )
}

interface ResultProps {
  item: VisitorSearchItem
  query: string
  timeZone: string
  now: number
  onAction: (action: ListVisitAction) => void
  onWalkIn: (prefill: WalkInPrefill) => void
}

/**
 * One visitor (initials, name, company, e-mail and phone) and their visits to act on. A visitor
 * without one says so; "Register walk-in" follows as a quiet action, so the real check-in and
 * check-out buttons of the results stand out.
 */
function VisitorResult({ item, query, timeZone, now, onAction, onWalkIn }: ResultProps) {
  const { t } = useTranslation('reception')
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={item.full_name} className="ring-1 ring-border" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-base leading-snug font-semibold break-words text-fg">
            <HighlightMatch text={item.full_name} query={query} />
          </p>
          {item.company_name && (
            <p className="text-meta break-words text-fg-muted">
              <HighlightMatch text={item.company_name} query={query} />
            </p>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-meta">
            {/* The address breaks only at its separators, never mid-domain. */}
            {item.email && <EmailText address={item.email} className="text-fg-muted" />}
            {item.phone && <PhoneLink phone={item.phone} label={t('call', { name: item.full_name })} />}
          </div>
        </div>
      </div>
      {item.today_visits.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control bg-surface-muted ps-4 pe-1 py-1">
          <p className="text-sm text-fg-muted">{t('search.noVisitToday')}</p>
          <Button variant="ghost" icon={<UserPlus aria-hidden="true" />} onClick={() => onWalkIn({ visitor: item })}>
            {t('actions.registerWalkIn')}
          </Button>
        </div>
      ) : (
        <VisitList label={t('search.visitsOf', { name: item.full_name })}>
          {item.today_visits.map((visit) => (
            <TodayVisit key={visit.id} visit={visit} timeZone={timeZone} now={now} onAction={onAction} onWalkIn={onWalkIn} />
          ))}
        </VisitList>
      )}
    </li>
  )
}

export interface VisitorSearchDialogProps {
  timeZone: string
  onClose: () => void
  /** Register a walk-in (the dialog closes; the Walk-in tab opens pre-filled). */
  onWalkIn: (prefill: WalkInPrefill) => void
  /** A check-in or check-out succeeded (the scanner leaves a result about the same visit). */
  onVisitChanged: (visit: Visit) => void
  /** Today's no-shows from the reception screen's polled GET /reception/today; undefined while unknown. */
  noShows: readonly Visit[] | undefined
}

/**
 * "Find a visitor" (§10): GET /visitors?q with each visitor's actionable visits of today
 * (SCHEDULED today, or still CHECKED_IN, plus today's no-shows from the screen's list), and an
 * inline Check in or Check out for each, for a visitor without a usable pass. A late visitor's
 * no-show offers "Check in anyway…" (OVERRIDE), so nobody is registered twice as a walk-in. Visitors reception can act on come first (inside, then
 * expected by start time), then the rest. A dialog over the screen, so the results never push
 * the scanner out of view and use the dialog's whole width; Escape, Close and a camera scan
 * close it. The first five results show, the rest of the page behind "Show all".
 */
export function VisitorSearchDialog({ timeZone, onClose, onWalkIn, onVisitChanged, noShows }: VisitorSearchDialogProps) {
  const { t } = useTranslation('reception')
  const [text, setText] = useState('')
  const query = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS)
  const lookup = useVisitorLookup(query.length >= MIN_QUERY_LENGTH ? query : '')
  const now = useNow(15_000)
  const [action, setAction] = useState<ListVisitAction | null>(null)
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLElement>(null)
  const recoverFocus = useListFocusRecovery({ list: resultsRef, fallback: inputRef, version: lookup.data })
  const active = query.length >= MIN_QUERY_LENGTH && text.trim().length > 0

  const walkIn = (prefill: WalkInPrefill) => {
    onWalkIn(prefill)
    onClose()
  }

  let results = null
  if (active) {
    if (lookup.isPending) {
      results = <Spinner label={t('search.searching')} showLabel />
    } else if (lookup.isError) {
      results = (
        <Alert tone="danger">
          <ApiErrorMessage error={lookup.error} />
        </Alert>
      )
    } else if (lookup.data.items.length === 0) {
      results = (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-fg-muted">{t('search.noMatch', { query })}</p>
          <Button variant="secondary" size="lg" icon={<UserPlus aria-hidden="true" />} onClick={() => walkIn({})}>
            {t('actions.registerWalkIn')}
          </Button>
        </div>
      )
    } else {
      const { total } = lookup.data
      const items = orderSearchResults(withTodayNoShows(lookup.data.items, noShows ?? []))
      const showAll = expandedFor === query
      const shown = showAll ? items : items.slice(0, RESULTS_AT_ONCE)
      results = (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {shown.map((item) => (
              <VisitorResult key={item.id} item={item} query={query} timeZone={timeZone} now={now} onAction={setAction} onWalkIn={walkIn} />
            ))}
          </ul>
          {!showAll && items.length > RESULTS_AT_ONCE && (
            <Button variant="secondary" onClick={() => setExpandedFor(query)} className="mt-3">
              {t('search.showAll', { count: items.length })}
            </Button>
          )}
          {total > VISITOR_LOOKUP_SIZE && (showAll || items.length <= RESULTS_AT_ONCE) && (
            <p className="mt-3 text-meta text-fg-muted">{t('search.capped', { shown: VISITOR_LOOKUP_SIZE, total })}</p>
          )}
        </>
      )
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('search.open')} size="lg" initialFocusRef={inputRef}>
      <div className="flex flex-col gap-4">
        <SearchField
          label={t('search.open')}
          labelHidden
          value={text}
          onValueChange={setText}
          onClear={() => setText('')}
          placeholder={t('search.placeholder')}
          inputRef={inputRef}
        />
        {results && (
          <section ref={resultsRef} aria-label={t('search.resultsLabel')} aria-busy={lookup.isFetching}>
            {results}
          </section>
        )}
      </div>
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
    </Dialog>
  )
}
