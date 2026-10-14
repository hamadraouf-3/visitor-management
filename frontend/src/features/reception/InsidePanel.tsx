import { LogOut, PencilLine, SearchX, Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage, getErrorReference } from '../../api/client'
import { useInsideList } from '../../api/queries'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { SearchField } from '../../components/ui/SearchField'
import { PageSpinner } from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/toastContext'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { ROW_ACTION_ATTRIBUTE, useListFocusRecovery } from '../../hooks/useListFocusRecovery'
import { useNow } from '../../hooks/useNow'
import type { Visit } from '../../types/api'
import { InsideFlagBadges } from '../visits/InsideFlagBadges'
import { StaleCheckOutDialog } from './StaleCheckOutDialog'
import { VisitActionDialog, type ListVisitAction } from './VisitActionDialog'
import { useCheckOut } from './queries'
import { isRecentCheckIn } from './scanOutcome'
import { checkedInLabel, isBulkCheckOutCandidate, listCanCheckOut, matchesVisitFilter } from './visitActions'
import { VisitList, VisitRow } from './VisitRow'

interface InsideRowProps {
  visit: Visit
  timeZone: string
  now: number
  onAction: (action: ListVisitAction) => void
  /** The one-tap check-out succeeded (called before the list drops the row). */
  onCheckedOut: (visit: Visit) => void
}

function InsideRow({ visit, timeZone, now, onAction, onCheckedOut }: InsideRowProps) {
  const { t } = useTranslation(['reception', 'errors'])
  const toast = useToast()
  const checkOut = useCheckOut()
  const canCheckOut = listCanCheckOut(visit)

  // §10 "one-tap Check out": the visitor is at the desk on the way out. A check-in less than
  // 5 minutes ago is the scanner's exception: probably someone arriving, so it asks first.
  const checkOutNow = () => {
    if (isRecentCheckIn(visit, Date.now())) {
      onAction({ kind: 'check-out', visit })
      return
    }
    checkOut.mutate(
      { visitId: visit.id, body: { method: 'MANUAL' } },
      {
        onSuccess: (updated) => {
          toast.show({ tone: 'success', title: t('checkedOut', { name: updated.visitor.full_name }) })
          onCheckedOut(updated)
        },
        onError: (error) => {
          const reference = getErrorReference(error)
          toast.show({
            tone: 'danger',
            title: t('inside.notCheckedOut', { name: visit.visitor.full_name }),
            description: reference ? `${getErrorMessage(error)} ${t('errors:referenceLabel')} ${reference}` : getErrorMessage(error),
          })
        },
      },
    )
  }

  return (
    <VisitRow
      visit={visit}
      when={checkedInLabel(visit, now, timeZone)}
      inside
      badges={<InsideFlagBadges visit={visit} timeZone={timeZone} now={now} />}
      action={
        canCheckOut && (
          // Outlined, as everywhere a check-out is offered: solid primary means a check-in.
          <Button
            variant="secondary"
            size="lg"
            icon={<LogOut aria-hidden="true" className="mirror-rtl" />}
            loading={checkOut.isPending}
            onClick={checkOutNow}
            {...{ [ROW_ACTION_ATTRIBUTE]: '' }}
          >
            {t('actions.checkOut')}
          </Button>
        )
      }
      // A correction is the rare, audited exception (the visitor left without checking out).
      moreActions={
        canCheckOut
          ? [{ id: 'correct-check-out', label: t('correct.title'), icon: PencilLine, onSelect: () => onAction({ kind: 'correct-check-out', visit }) }]
          : []
      }
    />
  )
}

export interface InsidePanelProps {
  timeZone: string
  /** A check-out succeeded (the scanner leaves a result about the same visit). */
  onVisitChanged: (visit: Visit) => void
  /** The bulk check-out of earlier days succeeded. */
  onStaleCheckedOut: () => void
}

/**
 * Inside tab (§10): everyone checked in now, whatever the date (GET /reception/inside, polled),
 * with check-in time, time inside and host. Overdue and previous-day visits are flagged with
 * the words and tone of the evacuation list. One-tap Check out (MANUAL; a confirmation only
 * for a check-in less than 5 minutes ago, as on the scanner), "Correct check-out time"
 * (CORRECTED) in the row's menu for someone who left earlier, and a bulk check-out of everyone
 * left from previous days. After a check-out the visitor's row is gone; focus moves to the
 * next row's Check out (or the filter), never to the page.
 */
export function InsidePanel({ timeZone, onVisitChanged, onStaleCheckedOut }: InsidePanelProps) {
  const { t } = useTranslation('reception')
  const inside = useInsideList()
  const now = useNow(30_000)
  const [filter, setFilter] = useState('')
  const [action, setAction] = useState<ListVisitAction | null>(null)
  const [staleDialog, setStaleDialog] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const recoverFocus = useListFocusRecovery({ list: listRef, fallback: filterRef, version: inside.data })

  if (!inside.data) {
    if (inside.isPending) return <PageSpinner label={t('inside.loading')} />
    return <LoadErrorAlert title={t('inside.loadError')} error={inside.error} onRetry={() => void inside.refetch()} />
  }

  const items = inside.data.items
  const stale = items.filter(isBulkCheckOutCandidate)
  const shown = items.filter((visit) => matchesVisitFilter(visit, filter))

  return (
    <div ref={listRef} className="flex flex-col gap-5">
      {stale.length > 0 && (
        <Alert
          tone="warning"
          title={t('inside.staleTitle', { count: stale.length })}
          action={
            <Button
              variant="secondary"
              icon={<LogOut aria-hidden="true" className="mirror-rtl" />}
              onClick={() => setStaleDialog(true)}
              // The label is long: it wraps inside the alert on phones instead of overflowing it.
              className="max-w-full whitespace-normal [&_svg]:shrink-0"
            >
              {t('inside.staleAction')}
            </Button>
          }
        />
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <SearchField
          label={t('inside.filter')}
          labelHidden
          placeholder={t('filterPlaceholder')}
          value={filter}
          onValueChange={setFilter}
          onClear={() => setFilter('')}
          inputRef={filterRef}
          className="sm:max-w-md sm:flex-1"
        />
        <p className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span aria-hidden="true" className="size-2 shrink-0 animate-live rounded-full bg-highlight text-highlight" />
          {t('inside.count', { count: inside.data.count })}
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState icon={Users} title={t('inside.emptyTitle')} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('inside.noMatch', { filter: filter.trim() })}
          action={
            <Button variant="secondary" onClick={() => setFilter('')}>
              {t('clearFilter')}
            </Button>
          }
        />
      ) : (
        <VisitList label={t('inside.listLabel')}>
          {shown.map((visit) => (
            <InsideRow
              key={visit.id}
              visit={visit}
              timeZone={timeZone}
              now={now}
              onAction={setAction}
              onCheckedOut={(updated) => {
                recoverFocus(updated.id)
                onVisitChanged(updated)
              }}
            />
          ))}
        </VisitList>
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
      {staleDialog && (
        <StaleCheckOutDialog
          visits={stale}
          timeZone={timeZone}
          now={now}
          onDone={() => {
            recoverFocus(null)
            onStaleCheckedOut()
          }}
          onClose={() => setStaleDialog(false)}
        />
      )}
    </div>
  )
}
