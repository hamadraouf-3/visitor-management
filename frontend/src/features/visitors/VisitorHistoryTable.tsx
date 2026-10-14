import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { Table, type TableColumn } from '../../components/ui/Table'
import { tableRowLinkProps } from '../../components/ui/tableStyles'
import { backLinkState, type BackLink } from '../../hooks/useBackLink'
import { useDepartmentName } from '../../i18n/departmentName'
import { paths } from '../../paths'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatAttendance, formatVisitDateRange } from '../visits/format'

interface HistoryColumnContext {
  timeZone: string
  backLink: BackLink
}

const NONE = <span className="text-fg-muted">—</span>
// Six columns need the width of a desktop; tablets get the card layout.
const STACK_BELOW = 'lg'
const ROW_LINK = tableRowLinkProps(STACK_BELOW)

function historyColumns({
  timeZone,
  backLink,
  t,
  departmentName,
}: HistoryColumnContext & { t: TFunction<'visitors'>; departmentName: (department: Visit['department']) => string }): TableColumn<Visit>[] {
  return [
    {
      id: 'date',
      header: t('profile.history.columns.date'),
      primary: true,
      cell: (visit) => (
        <Link
          to={paths.visit(visit.id)}
          state={backLinkState(backLink)}
          {...ROW_LINK}
          // One line in the table; in the stacked card a visit across midnight wraps instead of overflowing it.
          className={cn('font-semibold text-accent-text tabular-nums hover:underline lg:whitespace-nowrap', ROW_LINK.className)}
        >
          {formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone)}
        </Link>
      ),
    },
    { id: 'status', header: t('profile.history.columns.status'), stacked: 'inline', cell: (visit) => <StatusBadge type="visit" status={visit.status} /> },
    { id: 'host', header: t('profile.history.columns.host'), cell: (visit) => <span className="text-fg lg:whitespace-nowrap">{visit.host.full_name}</span> },
    {
      id: 'department',
      header: t('profile.history.columns.department'),
      isEmpty: (visit) => visit.department === null,
      cell: (visit) => (visit.department ? <span className="text-fg-secondary">{departmentName(visit.department)}</span> : NONE),
    },
    {
      id: 'purpose',
      header: t('profile.history.columns.purpose'),
      cell: (visit) => (
        <span title={visit.purpose} className="line-clamp-2 break-words text-fg-secondary">
          {visit.purpose}
        </span>
      ),
    },
    {
      id: 'attendance',
      header: t('profile.history.columns.attendance'),
      isEmpty: (visit) => visit.check_in_at === null,
      cell: (visit) => {
        const attendance = formatAttendance(visit, timeZone)
        return attendance ? <span className="font-numeric text-[0.8125rem] text-fg-secondary tabular-nums">{attendance}</span> : NONE
      },
    },
  ]
}

export interface VisitorHistoryTableProps extends HistoryColumnContext {
  visits: Visit[]
  loading?: boolean
  empty: ReactNode
  /** Draw the table's own frame (default); off inside a `ListPanel`. */
  framed?: boolean
}

/**
 * A visitor's visits (§10 profile history): date, status, host, department, purpose and
 * attendance (check-in, check-out and time on site in one cell). Cards below lg.
 */
export function VisitorHistoryTable({ visits, loading, empty, framed = true, ...context }: VisitorHistoryTableProps) {
  const { t } = useTranslation('visitors')
  const departmentName = useDepartmentName()
  return (
    <Table
      columns={historyColumns({ ...context, t, departmentName })}
      rows={visits}
      getRowKey={(visit) => visit.id}
      caption={t('profile.history.title')}
      loading={loading}
      empty={empty}
      stackBelow={STACK_BELOW}
      framed={framed}
    />
  )
}
