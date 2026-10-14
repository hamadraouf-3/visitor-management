import type { TFunction } from 'i18next'
import { UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CellStack } from '../../components/ui/CellStack'
import { EmptyState } from '../../components/ui/EmptyState'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { Table, type TableColumn } from '../../components/ui/Table'
import { useBackLinkToHere, type BackLink } from '../../hooks/useBackLink'
import { useDepartmentName } from '../../i18n/departmentName'
import type { InsideVisit } from '../../types/api'
import { formatTimeOnDay, toDateKey } from '../../utils/datetime'
import { formatDuration, secondsBetween } from '../../utils/duration'
import { InsideFlagBadges } from '../visits/InsideFlagBadges'
import { insideFlags } from '../visits/insideFlags'
import { VisitLinkCell } from '../visits/VisitLinkCell'

/*
 * Cards below lg: a tablet in portrait is where the list is used to call hosts and missing
 * visitors during an evacuation, and there each card is one tap target (the stretched visitor
 * link) with each phone number on its own unbroken line, under the person it reaches.
 */
const STACK_BELOW = 'lg'
const NONE = <span className="text-fg-muted">—</span>

interface InsideColumnContext {
  timeZone: string
  now: number
}

function insideColumns({
  timeZone,
  now,
  back,
  t,
  departmentName,
}: InsideColumnContext & { back: BackLink; t: TFunction<'inside'>; departmentName: (department: InsideVisit['department']) => string }): TableColumn<InsideVisit>[] {
  return [
    {
      id: 'visitor',
      header: t('list.visitor'),
      primary: true,
      cell: (visit) => (
        <VisitLinkCell visit={visit} backLink={back} stackBelow={STACK_BELOW}>
          {visit.visitor.phone && (
            // The visitor's current number (B57-72), on its own line under the name (also without a
            // company line between them), above the card-wide link like the host's.
            <div data-visitor-phone="" className="mt-0.5">
              <PhoneLink phone={visit.visitor.phone} label={t('list.call', { name: visit.visitor.full_name })} className="relative z-10 text-sm font-normal" />
            </div>
          )}
        </VisitLinkCell>
      ),
    },
    {
      id: 'flags',
      header: t('list.flags'),
      stacked: 'inline',
      // A card without flags leaves the row out (no blank band); the table keeps its "None".
      isEmpty: (visit) => insideFlags(visit, timeZone, now).length === 0,
      cell: (visit) =>
        insideFlags(visit, timeZone, now).length === 0 ? (
          <span className="sr-only">{t('list.none')}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            <InsideFlagBadges visit={visit} timeZone={timeZone} now={now} />
          </div>
        ),
    },
    {
      id: 'host',
      header: t('list.host'),
      cell: (visit) => (
        <div className="min-w-0">
          <span className="block break-words">{visit.host.full_name}</span>
          {visit.host.phone && (
            // Above the card-wide visitor link, so the phone number stays its own target.
            <PhoneLink phone={visit.host.phone} label={t('list.call', { name: visit.host.full_name })} className="relative z-10 text-sm" />
          )}
        </div>
      ),
    },
    {
      id: 'department',
      header: t('list.department'),
      isEmpty: (visit) => visit.department === null,
      cell: (visit) => (visit.department ? <span className="break-words">{departmentName(visit.department)}</span> : NONE),
    },
    {
      id: 'checked-in',
      header: t('list.checkedIn'),
      // Direction C's two-line cell: when, then how long the visitor has been inside.
      cell: (visit) =>
        visit.check_in_at ? (
          <CellStack
            // A time of today in Space Grotesk; an earlier day's date in the text face.
            numeric={toDateKey(visit.check_in_at, timeZone) === toDateKey(now, timeZone)}
            primary={formatTimeOnDay(visit.check_in_at, now, timeZone)}
            secondary={formatDuration(secondsBetween(visit.check_in_at, now))}
          />
        ) : (
          NONE
        ),
    },
  ]
}

export interface EvacuationListProps extends InsideColumnContext {
  /** In roll-call order. */
  visits: InsideVisit[]
  loading?: boolean
}

/** Everyone inside: visitor and host and how to reach each, department, check-in time and flags. */
export function EvacuationList({ visits, loading, ...context }: EvacuationListProps) {
  const { t } = useTranslation('inside')
  const back = useBackLinkToHere(t('list.backLabel'))
  const departmentName = useDepartmentName()
  return (
    <Table
      columns={insideColumns({ ...context, back, t, departmentName })}
      rows={visits}
      getRowKey={(visit) => visit.id}
      caption={t('list.caption')}
      loading={loading}
      stackBelow={STACK_BELOW}
      empty={<EmptyState icon={UsersRound} title={t('list.emptyTitle')} />}
    />
  )
}
