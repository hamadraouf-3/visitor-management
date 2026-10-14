import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { IdentityLockup } from '../app/IdentityLockup'
import { formatDateAtClockTime, formatTimeZoneName } from '../../utils/datetime'

export interface PrintSheetHeaderProps {
  companyName: string
  /** What the sheet is, e.g. "Visitor report". */
  title: string
  /** When the figures on the sheet were generated (the moment their data arrived). */
  generatedAt: number
  /** The company time zone the times are given in. */
  timeZone: string
  /** Lines between the title and "Generated …", e.g. the period a report covers. */
  lines?: ReactNode
  /** Who printed the sheet, said after "Generated …" (the evacuation list says it in its footer). */
  printedBy?: string
  /** Under "Generated …", in large type: the one figure the sheet is for (the evacuation list's headcount). */
  emphasis?: ReactNode
  /**
   * A header of its own, above content that also shows on screen (the report): hidden on screen
   * and from assistive technology, which read the page's own header. Off inside a sheet that
   * is itself paper-only (the evacuation list).
   */
  paperOnly?: boolean
  className?: string
}

/**
 * The head of a printed sheet, black on white: the company, the sheet's title, what it covers,
 * when its figures were generated in which time zone, and who printed it, so a sheet read
 * later still says what it is, with the company's logo at the inline end (Phase 12; a company
 * without a logo has its name, which heads the sheet anyway).
 * One header for the printed evacuation list and the report.
 */
export function PrintSheetHeader({ companyName, title, generatedAt, timeZone, lines, printedBy, emphasis, paperOnly = false, className }: PrintSheetHeaderProps) {
  const { t } = useTranslation()
  const generated = t('print.generated', {
    when: formatDateAtClockTime(generatedAt, timeZone),
    zone: formatTimeZoneName(timeZone, generatedAt),
  })
  return (
    <header
      aria-hidden={paperOnly || undefined}
      className={cn('border-b-2 border-black pb-2 text-[9pt] leading-snug text-black', paperOnly && 'hidden print:block', className)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-semibold tracking-wide uppercase">{companyName}</p>
          <h2 className="mt-1 text-[16pt] font-bold">{title}</h2>
        </div>
        <IdentityLockup surface="paper" size="md" logoOnly />
      </div>
      {lines && <div className="mt-1">{lines}</div>}
      <p className={lines ? undefined : 'mt-1'}>{printedBy ? `${generated} ${t('print.printedBy', { name: printedBy })}` : generated}</p>
      {emphasis && <p className="mt-2 text-[13pt] font-bold">{emphasis}</p>}
    </header>
  )
}
