import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/ui/Avatar'
import { CellStack } from '../../components/ui/CellStack'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { Table, type TableColumn } from '../../components/ui/Table'
import type { BackLink } from '../../hooks/useBackLink'
import { useDepartmentName } from '../../i18n/departmentName'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'
import { attendanceLines, formatVisitWhen } from './format'
import { VisitLinkCell } from './VisitLinkCell'

const STACK_BELOW = 'lg'
/** Direction C's rows centre their cells on the avatar (the table layout only). */
const MIDDLE = 'lg:align-middle'

interface VisitColumnContext {
  timeZone: string
  backLink: BackLink
  now: number
  /** Leave out the Host column (e.g. every row is hosted by the signed-in user). */
  hideHost: boolean
}

/** A visitor who is inside the building now: the row a host looks for first (direction C's highlighted row). */
function isInside(visit: Visit): boolean {
  return visit.status === 'CHECKED_IN'
}

/*
 * Wide screens: one row per visit, direction C's table (the visitor after an avatar with the
 * company under the name, the time over what happened, compact status chips). Phones and tablets
 * (below lg): a compact card per visit, which is one link as a whole: the visitor and company,
 * then the time with the visit and invitation chips on one line, then the host when shown. The
 * department is left out of the card (it repeats the host's on most rows). The column order
 * serves the card.
 *
 * From xl on the columns have fixed widths, so they stay put when the tab, page or search
 * changes (the chip columns fit their longest chip; the visitor takes the rest). Between lg and
 * xl the content area is too narrow for fixed widths and the columns follow content. In the card
 * no "Invitation" header names the invitation chip, so it says so itself ("Invitation sent", see
 * INVITATION_STATUS_META).
 */
function visitColumns({
  timeZone,
  backLink,
  now,
  hideHost,
  t,
  departmentName,
}: VisitColumnContext & { t: TFunction<'visits'>; departmentName: (department: Visit['department']) => string }): TableColumn<Visit>[] {
  const columns: (TableColumn<Visit> | false)[] = [
    {
      id: 'visitor',
      header: t('table.visitor'),
      primary: true,
      className: MIDDLE,
      cell: (visit) => (
        <VisitLinkCell
          visit={visit}
          backLink={backLink}
          stackBelow={STACK_BELOW}
          leading={<Avatar name={visit.visitor.full_name} tone={isInside(visit) ? 'emphasis' : 'neutral'} className="max-lg:hidden" />}
        />
      ),
    },
    {
      id: 'when',
      header: t('table.when'),
      stacked: 'inline',
      className: MIDDLE,
      headerClassName: hideHost ? 'xl:w-[27%]' : 'xl:w-[24%]',
      cell: (visit) => {
        // Under the time, what happened: "In 10:07", "In 09:02 · Out 10:15" (data, not a note).
        const attendance = attendanceLines(visit, timeZone)
        const cancelled = visit.status === 'CANCELLED'
        return (
          <CellStack
            numeric
            primary={<span className={cn(cancelled && 'text-fg-muted line-through')}>{formatVisitWhen(visit.scheduled_start, visit.scheduled_end, timeZone, now)}</span>}
            secondary={attendance && <span className="max-lg:hidden">{attendance.times}</span>}
          />
        )
      },
    },
    {
      id: 'status',
      header: t('table.status'),
      stacked: 'inline',
      // Direction C's 28 px status chip: the longest ("Checked out", «تم الخروج») fits 160 px with the cell's padding.
      className: MIDDLE,
      headerClassName: 'xl:w-40',
      cell: (visit) => <StatusBadge type="visit" status={visit.status} />,
    },
    {
      id: 'invitation',
      header: t('table.invitation'),
      stacked: 'inline',
      className: MIDDLE,
      headerClassName: 'xl:w-36',
      cell: (visit) => (
        <>
          <StatusBadge type="invitation" status={visit.invitation.status} className="max-lg:hidden" />
          <StatusBadge type="invitation" status={visit.invitation.status} standalone className="lg:hidden" />
        </>
      ),
    },
    !hideHost && {
      id: 'host',
      header: t('table.host'),
      className: MIDDLE,
      headerClassName: 'xl:w-[13%]',
      cell: (visit) => <span className="break-words text-fg">{visit.host.full_name}</span>,
    },
    {
      id: 'department',
      header: t('table.department'),
      stacked: 'hidden',
      className: MIDDLE,
      headerClassName: hideHost ? 'xl:w-[14%]' : 'xl:w-[12%]',
      // One line in the fixed layout; the whole name on hover (and for screen readers, always).
      cell: (visit) =>
        visit.department ? (
          <span className="block break-words text-fg-secondary xl:truncate" title={departmentName(visit.department)}>
            {departmentName(visit.department)}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
  ]
  return columns.filter((column): column is TableColumn<Visit> => column !== false)
}

export interface VisitTableProps extends Omit<VisitColumnContext, 'hideHost'> {
  visits: Visit[]
  caption: string
  /** The signed-in user: the Host column is left out while every listed visit is theirs. */
  currentUserId: string
  loading?: boolean
  empty?: ReactNode
  /** Draw the table's own frame (default); off inside a `ListPanel`. */
  framed?: boolean
}

/**
 * Visits as a table on lg+ screens and compact cards below (Table). The visitor's name links
 * to the visit page (whose back link returns to `backLink`); dates and times are in the
 * company timezone. A visitor inside the building now is highlighted.
 */
export function VisitTable({ visits, caption, currentUserId, loading, empty, framed = true, ...context }: VisitTableProps) {
  const { t } = useTranslation('visits')
  const departmentName = useDepartmentName()
  const hideHost = visits.length > 0 && visits.every((visit) => visit.host.id === currentUserId)
  return (
    <Table
      columns={visitColumns({ ...context, hideHost, t, departmentName })}
      rows={visits}
      getRowKey={(visit) => visit.id}
      caption={caption}
      loading={loading}
      empty={empty}
      stackBelow={STACK_BELOW}
      layout="fixed-xl"
      framed={framed}
      isRowHighlighted={isInside}
    />
  )
}
