import type { TFunction } from 'i18next'
import { Building2, Clock, DoorOpen, FileText, Layers, MessageSquareText, Ticket, UserRound, UserPlus, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { useDepartmentName } from '../../i18n/departmentName'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatTimeRange, toDateKey } from '../../utils/datetime'
import { formatVisitWhen } from '../visits/format'
import { walkInReasonLabel } from '../visits/labels'
import { checkInTimeAndStay } from './visitActions'

interface Fact {
  term: string
  description: ReactNode
  icon: LucideIcon
  /** Free text (a purpose, a note): the whole row, so it never squeezes into half of it. */
  wide?: boolean
}

export interface VisitFactsProps {
  visit: Visit
  timeZone: string
  now: number
  /** Adds the pass window (refused passes: when the pass is or was valid). */
  showWindow?: boolean
  /** The visitor's company; left out where it is shown under the visitor's name (the scan result). */
  showCompany?: boolean
  /** The surface the facts lie on: the panel (`surface`) or a dialog (`raised`). */
  surface?: 'surface' | 'raised'
  className?: string
}

/**
 * The note reception typed at check-in (B57-64: a walk-in's note, required for the reason
 * OTHER; the reason given for an OVERRIDE), as written. Null when there is none.
 */
function checkInNoteFact(visit: Visit, t: TFunction<'reception'>): Fact | null {
  const note = visit.check_in_note?.trim()
  if (!note) return null
  return {
    term: visit.check_in_method === 'OVERRIDE' ? t('facts.reasonGiven') : t('facts.note'),
    description: <span className="whitespace-pre-wrap">{note}</span>,
    icon: MessageSquareText,
    wide: true,
  }
}

/**
 * Which facts take a whole row of the two-column grid: the wide ones, and a short one that would
 * otherwise stand alone in its row (before a wide one, or last), so every row is filled.
 */
function fullRows(facts: readonly Fact[]): boolean[] {
  const full: boolean[] = []
  let open = -1
  facts.forEach((fact, index) => {
    if (fact.wide) {
      if (open >= 0) full[open] = true
      open = -1
      full[index] = true
      return
    }
    full[index] = false
    open = open >= 0 ? -1 : index
  })
  if (open >= 0) full[open] = true
  return full
}

/**
 * What reception needs to know about a visit at a glance (§10 result panel), as direction C's
 * framed grid of facts, each with its icon: company, host with a tap-to-call phone, department,
 * purpose, scheduled time in the company time zone and, once checked in, since when. Why the
 * visitor was let in stays with the visit: a walk-in's reason with the receptionist's note under
 * it, and an override's reason under the check-in. Two columns from `sm`, one on phones.
 */
export function VisitFacts({ visit, timeZone, now, showWindow = false, showCompany = true, surface = 'surface', className }: VisitFactsProps) {
  const { t } = useTranslation('reception')
  const departmentName = useDepartmentName()
  const note = checkInNoteFact(visit, t)
  const facts = (
    [
      showCompany && Boolean(visit.visitor.company_name) && { term: t('facts.company'), description: visit.visitor.company_name, icon: Building2 },
      {
        term: t('facts.host'),
        icon: UserRound,
        description: (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{visit.host.full_name}</span>
            {visit.host.phone && <PhoneLink phone={visit.host.phone} label={t('call', { name: visit.host.full_name })} />}
          </span>
        ),
      },
      { term: t('facts.scheduled'), description: formatVisitWhen(visit.scheduled_start, visit.scheduled_end, timeZone, now), icon: Clock },
      Boolean(visit.department) && { term: t('facts.department'), description: departmentName(visit.department), icon: Layers },
      showWindow && {
        term: t('facts.passValid'),
        description: formatTimeRange(visit.window_start, visit.window_end, timeZone),
        icon: Ticket,
        // A window across midnight names both days: a whole row, rather than four lines in half of one.
        wide: toDateKey(visit.window_start, timeZone) !== toDateKey(visit.window_end, timeZone),
      },
      { term: t('facts.purpose'), description: <span className="whitespace-pre-wrap">{visit.purpose}</span>, icon: FileText, wide: true },
      visit.is_walk_in && Boolean(visit.walk_in_reason) && { term: t('facts.walkIn'), description: walkInReasonLabel(visit.walk_in_reason ?? ''), icon: UserPlus },
      visit.check_in_method !== 'OVERRIDE' && note,
      visit.check_in_at !== null && { term: t('facts.checkedIn'), description: checkInTimeAndStay(visit, now, timeZone), icon: DoorOpen },
      visit.check_in_method === 'OVERRIDE' && note,
    ] satisfies (Fact | null | false)[]
  ).filter((fact): fact is Fact => Boolean(fact))
  const full = fullRows(facts)
  return (
    <dl className={cn('grid grid-cols-1 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-2', className)}>
      {facts.map((fact, index) => {
        const Icon = fact.icon
        return (
          <div
            key={fact.term}
            className={cn('flex min-w-0 flex-col gap-1 px-4 py-3', surface === 'raised' ? 'bg-surface-raised' : 'bg-surface', full[index] && 'sm:col-span-2')}
          >
            <dt className="flex items-center gap-1.5 text-meta text-fg-muted">
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              {fact.term}
            </dt>
            <dd className="min-w-0 text-[0.9375rem] leading-snug font-semibold break-words text-fg">{fact.description}</dd>
          </div>
        )
      })}
    </dl>
  )
}
