import { ArrowLeftRight, ClipboardPen, DoorOpen, ShieldAlert, type LucideIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { Table, type TableColumn } from '../../components/ui/Table'
import type { BackLink } from '../../hooks/useBackLink'
import { useDepartmentName } from '../../i18n/departmentName'
import type { Visit } from '../../types/api'
import { companyToday, formatDate, formatShortDate, toDateKey } from '../../utils/datetime'
import { attendanceLines, formatVisitTimes } from '../visits/format'
import { VisitLinkCell } from '../visits/VisitLinkCell'
import { visitMethodBadges, type VisitMethodBadge, type VisitMethodFlag } from './visitMethods'

const STACK_BELOW = 'xl'
const NONE = <span className="text-fg-muted">—</span>
/** A cell's second line (direction C): 12.5 px, muted. */
const SECOND_LINE = 'block text-[0.78125rem] leading-snug text-fg-muted'

const METHOD_ICONS: Record<VisitMethodFlag, LucideIcon> = {
  OVERRIDE: ShieldAlert,
  WALK_IN: DoorOpen,
  CORRECTED: ClipboardPen,
  BULK: ArrowLeftRight,
}

/** A method chip: icon and name (no tooltip explaining the method, decision 3; the visit page tells the story). */
export function MethodBadge({ badge }: { badge: VisitMethodBadge }) {
  return (
    <Badge tone="neutral" icon={METHOD_ICONS[badge.flag]}>
      {badge.label}
    </Badge>
  )
}

interface HistoryColumnContext {
  timeZone: string
  backLink: BackLink
  /** The current time (`useNow`): a date of this year is shown without its year. */
  now: number
}

/**
 * "Wed, 7 Oct" for a visit of this year (company-local), "Tue, 7 Oct 2025" for an older or later
 * one: the year is said only where it tells something, which keeps the Arabic date ("الأربعاء، 7
 * تشرين الأول") on one line in a column narrow enough to leave the purpose its room.
 */
function visitDate(value: string, timeZone: string, now: number): string {
  const sameYear = toDateKey(value, timeZone).slice(0, 4) === companyToday(timeZone, now).slice(0, 4)
  return sameYear ? formatShortDate(value, timeZone) : formatDate(value, timeZone)
}

/** Inside the building now: the row a reader looks for first (direction C's tinted row, its status chip says why). */
function isInside(visit: Visit): boolean {
  return visit.status === 'CHECKED_IN'
}

/*
 * From xl: a table with fixed column widths, so it always fits its card whatever the names.
 * The visitor (an avatar, the name as the link, the company under it) and the host (the
 * department under it) get a share and wrap; status, date and attendance get the width of their
 * longest value in each language, measured (the "Corrected check-out" chip, 131 px for «لم يحضر
 * الزائر»; "Wed, 7 Oct", «الأربعاء، 7 تشرين الأول»; "In 08:49 · Out 09:51", 168 px for «دخول 14:48 ·
 * خروج 15:21»); the purpose takes the rest and is cut to one line with its full text as the title.
 * A date of another year adds its year on a second line.
 * Below xl (a 1024 px screen leaves 702 px beside the sidebar, less than those six facts need
 * as a table): a card per visit whose title links to the visit, with the status and method
 * badges on one line and the other values as labelled lines; empty values are left out. Cards
 * sit two per row from md.
 */
function historyColumns({
  timeZone,
  backLink,
  now,
  t,
  departmentName,
}: HistoryColumnContext & { t: TFunction<'history'>; departmentName: (department: Visit['department']) => string }): TableColumn<Visit>[] {
  return [
    {
      id: 'visitor',
      header: t('columns.visitor'),
      primary: true,
      headerClassName: 'xl:w-[18%] 2xl:w-[20%]',
      cell: (visit) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={visit.visitor.full_name} size="sm" tone={isInside(visit) ? 'emphasis' : 'neutral'} className="print:hidden" />
          <VisitLinkCell visit={visit} backLink={backLink} stackBelow={STACK_BELOW} />
        </div>
      ),
    },
    {
      id: 'status',
      header: t('columns.status'),
      stacked: 'inline',
      headerClassName: 'xl:w-[10.75rem] 2xl:w-[11.25rem] xl:rtl:w-[10rem] 2xl:rtl:w-[10.5rem]',
      cell: (visit) => (
        <div className="flex flex-wrap gap-1 xl:flex-col xl:items-start">
          <StatusBadge type="visit" status={visit.status} />
          {visitMethodBadges(visit).map((badge) => (
            <MethodBadge key={badge.flag} badge={badge} />
          ))}
        </div>
      ),
    },
    {
      id: 'date',
      header: t('columns.date'),
      // Arabic dates name the weekday and the month in full («الأربعاء، 7 تشرين الأول»): wider, so the
      // date keeps one line above its times.
      headerClassName: 'xl:w-[7.5rem] 2xl:w-[8rem] xl:rtl:w-[11.75rem] 2xl:rtl:w-[12.25rem]',
      cell: (visit) => (
        <div className="leading-snug">
          <span className="block font-medium text-fg">{visitDate(visit.scheduled_start, timeZone, now)}</span>
          <span className={`${SECOND_LINE} font-numeric tabular-nums`}>{formatVisitTimes(visit.scheduled_start, visit.scheduled_end, timeZone)}</span>
        </div>
      ),
    },
    {
      // The host and, muted under it, the department the visit was booked for.
      id: 'host',
      header: t('columns.host'),
      headerClassName: 'xl:w-[14%] 2xl:w-[15%]',
      cell: (visit) => (
        <div className="min-w-0 leading-snug">
          <span className="block break-words text-fg">{visit.host.full_name}</span>
          {visit.department && <span className={`${SECOND_LINE} break-words`}>{departmentName(visit.department)}</span>}
        </div>
      ),
    },
    {
      id: 'purpose',
      header: t('columns.purpose'),
      cell: (visit) => (
        // dir=auto: an English purpose in the Arabic table is cut at its own end ("Quarterly busi…"),
        // aligned as the cell is (match-parent; Chromium knows only the prefixed form), not to its own start.
        <span dir="auto" title={visit.purpose} className="line-clamp-2 break-words text-fg-secondary [text-align:-webkit-match-parent] [text-align:match-parent] xl:block xl:truncate">
          {visit.purpose}
        </span>
      ),
    },
    {
      id: 'attendance',
      header: t('columns.attendance'),
      // "دخول 14:48 · خروج 15:21" is wider than "In 14:48 · Out 15:21": the Arabic column keeps it on one line.
      headerClassName: 'xl:w-40 2xl:w-[10.5rem] xl:rtl:w-48',
      isEmpty: (visit) => visit.check_in_at === null,
      cell: (visit) => {
        const lines = attendanceLines(visit, timeZone)
        if (!lines) return NONE
        return (
          <div className="leading-snug tabular-nums">
            <span className="block text-fg">{lines.times}</span>
            {lines.length && <span className={SECOND_LINE}>{lines.length}</span>}
          </div>
        )
      },
    },
  ]
}

export interface HistoryTableProps extends HistoryColumnContext {
  visits: Visit[]
  loading?: boolean
  empty?: ReactNode
}

/** The company-wide visit history (§10 /history): read-only, every row links to the visit page. */
export function HistoryTable({ visits, loading, empty, ...context }: HistoryTableProps) {
  const { t } = useTranslation('history')
  const departmentName = useDepartmentName()
  return (
    <Table
      columns={historyColumns({ ...context, t, departmentName })}
      rows={visits}
      getRowKey={(visit) => visit.id}
      caption={t('title')}
      loading={loading}
      empty={empty}
      stackBelow={STACK_BELOW}
      layout="fixed"
      isRowHighlighted={isInside}
    />
  )
}
