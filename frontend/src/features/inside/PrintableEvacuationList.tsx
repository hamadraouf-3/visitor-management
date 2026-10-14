import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { PrintSheetHeader } from '../../components/print/PrintSheetHeader'
import { PhoneNumber } from '../../components/ui/PhoneLink'
import { useDepartmentName } from '../../i18n/departmentName'
import type { InsideVisit } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatDate, formatTime, toDateKey } from '../../utils/datetime'
import { joinList } from '../../utils/text'
import { insideFlags } from '../visits/insideFlags'

export interface PrintableEvacuationListProps {
  companyName: string
  timeZone: string
  /** When the list was generated (the moment the data arrived). */
  generatedAt: number
  headcount: number
  /** In roll-call order. */
  visits: readonly InsideVisit[]
  printedBy: string
}

const CELL = 'border border-black px-1.5 py-1 text-start align-top'
/** Long names and companies wrap anywhere rather than run into the next column. */
const BODY_CELL = `${CELL} break-words`

/*
 * Column widths of the fixed table layout, so the sheet never runs past the printable area,
 * whatever the names: the roll-call box and the host's number keep their room, names wrap.
 */
const COLUMNS = [
  { key: 'number', width: 'w-[4%]' },
  { key: 'visitor', width: 'w-[13%]' },
  { key: 'visitorPhone', width: 'w-[11%]' },
  { key: 'company', width: 'w-[10%]' },
  { key: 'host', width: 'w-[12%]' },
  { key: 'hostPhone', width: 'w-[11%]' },
  { key: 'department', width: 'w-[10%]' },
  { key: 'checkedIn', width: 'w-[11%]' },
  { key: 'notes', width: 'w-[9%]' },
  { key: 'present', width: 'w-[9%] text-center' },
] as const

/** "08:02" for today; for an earlier day the date on its own line, so the column stays narrow. */
function CheckInCell({ checkInAt, timeZone, generatedAt, t }: { checkInAt: string; timeZone: string; generatedAt: number; t: TFunction<'inside'> }) {
  if (toDateKey(checkInAt, timeZone) === toDateKey(generatedAt, timeZone)) return <>{formatTime(checkInAt, timeZone)}</>
  return (
    <>
      <span className="block">{t('print.checkInDate', { date: formatDate(checkInAt, timeZone) })}</span>{' '}
      <span className="block">{formatTime(checkInAt, timeZone)}</span>
    </>
  )
}

/**
 * The evacuation list as it goes on paper (§10 print stylesheet): black on white, no
 * navigation or controls, a header with the company, the time the list was generated and the
 * headcount, and one row per visitor with an empty box to tick during the roll call. Hidden on
 * screen and from assistive technology, which read the on-screen list. Printed in landscape
 * (the `evacuation-list` page in index.css) in a 9 pt type.
 */
export function PrintableEvacuationList({ companyName, timeZone, generatedAt, headcount, visits, printedBy }: PrintableEvacuationListProps) {
  const { t } = useTranslation('inside')
  const departmentName = useDepartmentName()
  // The page needs no offset of its own: the layout drops the sidebar's room on paper
  // (AppLayout's `print:ps-0`), in either writing direction.
  return (
    <div aria-hidden="true" data-print-evacuation-list="" className="hidden bg-white text-[9pt] leading-snug text-black [page:evacuation-list] print:block">
      <PrintSheetHeader
        companyName={companyName}
        title={t('print.title')}
        generatedAt={generatedAt}
        timeZone={timeZone}
        emphasis={t('print.headcount', { count: headcount })}
        className="mb-3"
      />

      {visits.length === 0 ? (
        <p className="text-[11pt]">{t('print.empty')}</p>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                // A size smaller than the rows, so every header word fits its column whole.
                <th key={column.key} scope="col" className={cn(CELL, 'text-[8pt]', column.width)}>
                  {t(`print.columns.${column.key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visits.map((visit, index) => (
              <tr key={visit.id} className="break-inside-avoid">
                <td className={cn(BODY_CELL, 'tabular-nums')}>{index + 1}</td>
                <td className={cn(BODY_CELL, 'font-semibold')}>{visit.visitor.full_name}</td>
                <td className={BODY_CELL}>{visit.visitor.phone && <PhoneNumber>{visit.visitor.phone}</PhoneNumber>}</td>
                <td className={BODY_CELL}>{visit.visitor.company_name ?? ''}</td>
                <td className={BODY_CELL}>{visit.host.full_name}</td>
                <td className={BODY_CELL}>{visit.host.phone && <PhoneNumber>{visit.host.phone}</PhoneNumber>}</td>
                <td className={BODY_CELL}>{departmentName(visit.department)}</td>
                <td className={cn(BODY_CELL, 'tabular-nums')}>
                  {visit.check_in_at ? <CheckInCell checkInAt={visit.check_in_at} timeZone={timeZone} generatedAt={generatedAt} t={t} /> : ''}
                </td>
                <td className={BODY_CELL}>
                  {joinList(insideFlags(visit, timeZone, generatedAt).map((flag) => flag.label))}
                </td>
                <td className={cn(BODY_CELL, 'text-center')}>
                  <span className="inline-block size-4 border border-black" />
                  <span className="sr-only">{t('print.tick')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-3 text-[8pt]">{t('print.footer', { name: printedBy })}</p>
    </div>
  )
}
