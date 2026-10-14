import { CalendarCheck, Clock, Percent, UserCheck, UsersRound } from 'lucide-react'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { StatMeter, type StatMeterSegment } from '../../components/ui/StatMeter'
import { StatTile } from '../../components/ui/StatTile'
import type { ReportSummary } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatCount } from '../../utils/number'
import { formatAverageDuration, formatMean, formatRate } from './chartData'

/** The swatch of each meter tone, as StatMeter draws it (ink, mawdoo3's yellow, the teal, the muted grey). */
const SWATCHES: Record<StatMeterSegment['tone'], string> = {
  strong: 'bg-fg',
  attention: 'bg-attention',
  accent: 'bg-accent-strong',
  muted: 'bg-chart-muted',
}

interface Outcome {
  key: string
  label: string
  value: number
  tone: StatMeterSegment['tone']
}

/**
 * Where the visits booked for the period ended: arrived (checked in, inside or out since), no-show,
 * cancelled, and still expected (today's visitors not yet arrived; none for a past period). The four
 * add up to the visits booked (§8.1 totals; the report counts every status).
 */
function outcomes(totals: ReportSummary['totals'], labels: Record<'arrived' | 'noShow' | 'cancelled' | 'expected', string>): Outcome[] {
  const expected = Math.max(0, totals.visits - totals.checked_in - totals.no_show - totals.cancelled)
  const all: Outcome[] = [
    { key: 'arrived', label: labels.arrived, value: totals.checked_in, tone: 'strong' },
    { key: 'noShow', label: labels.noShow, value: totals.no_show, tone: 'attention' },
    { key: 'cancelled', label: labels.cancelled, value: totals.cancelled, tone: 'muted' },
    { key: 'expected', label: labels.expected, value: expected, tone: 'accent' },
  ]
  return all.filter((outcome) => outcome.key !== 'expected' || outcome.value > 0)
}

/** The outcomes with their counts: the words and numbers of the meter above them (a list, read in order). */
function OutcomeList({ items, label }: { items: readonly Outcome[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-6 gap-y-2 text-meta xl:flex-col xl:gap-2.5">
      {items.map((item) => (
        <li key={item.key} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-fg-secondary">
            <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-[3px]', SWATCHES[item.tone])} />
            {item.label}
          </span>
          <span className="font-numeric font-semibold text-fg tabular-nums">{formatCount(item.value)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The period's key figures in direction C's tiles. The one figure the report is about, the visits
 * booked, is the dark tile (turquoise numeral), with a meter of their outcomes and the outcomes'
 * counts; unique visitors, check-ins, the no-show rate (with its share as a yellow meter) and the
 * average duration follow, each with facts at its foot, never an explanation (decision 3).
 *
 * From xl the dark tile spans two rows beside a 2 × 2 block; below it takes a whole row and the
 * others sit two per row (one per row under 360 px). On paper the five share one compact row, the
 * meters left out and the outcomes said in one line. A period without visits has no outcomes to
 * show: the five tiles then share one row from xl (the dark tile one row tall, its numeral the size
 * of the others), so a lone 0 does not fill the screen's heaviest block.
 */
export function ReportKpis({ report }: { report: ReportSummary }) {
  const { t } = useTranslation('reports')
  const { totals } = report
  const booked = outcomes(totals, {
    arrived: t('summary.arrived'),
    noShow: t('summary.noShow'),
    cancelled: t('summary.cancelled'),
    expected: t('summary.expected'),
  })
  // The no-show rate's base: every visit that reached an outcome or is checked in (§8.1).
  const settledOthers = Math.max(0, totals.checked_in + totals.cancelled)
  const empty = totals.visits === 0

  return (
    <div
      data-empty-period={empty || undefined}
      className={cn(
        'grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 sm:gap-4 print:grid-cols-5 print:gap-2',
        empty ? 'xl:grid-cols-5' : 'xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]',
      )}
    >
      <StatTile
        variant="emphasis"
        label={t('summary.visitsBooked')}
        // The figure the report is about: larger where its tile spans two rows (xl).
        value={<span className={cn(!empty && 'xl:text-[4.5rem] xl:leading-none')}>{formatCount(totals.visits)}</span>}
        icon={CalendarCheck}
        footer={
          totals.visits > 0 && (
            <div className="flex flex-col gap-4">
              <StatMeter segments={booked} className="h-2" />
              <OutcomeList items={booked} label={t('summary.outcomes')} />
            </div>
          )
        }
        // Paper leaves the meter out (StatTile): the outcomes in one line instead.
        hint={
          totals.visits > 0 && (
            <span className="hidden print:inline">
              {booked.map((item, index) => (
                <Fragment key={item.key}>
                  {index > 0 && ' · '}
                  {/* A label never parts from its count at a line break. */}
                  <span className="whitespace-nowrap">
                    {item.label} {formatCount(item.value)}
                  </span>
                </Fragment>
              ))}
            </span>
          )
        }
        className={cn('col-span-2 max-[22.5rem]:col-span-1 xl:col-span-1 print:col-span-1 print:row-span-1', !empty && 'xl:row-span-2')}
      />
      <StatTile
        label={t('summary.uniqueVisitors')}
        value={formatCount(totals.unique_visitors)}
        icon={UsersRound}
        tone="info"
        hint={totals.unique_visitors > 0 ? t('summary.visitsPerVisitor', { value: formatMean(totals.checked_in, totals.unique_visitors) }) : undefined}
      />
      <StatTile
        label={t('summary.checkedIn')}
        value={formatCount(totals.checked_in)}
        icon={UserCheck}
        tone="success"
        hint={
          <>
            <span className="block">{t('summary.checkedOutCount', { count: totals.checked_out, formatted: formatCount(totals.checked_out) })}</span>
            {totals.walk_ins > 0 && (
              <span className="block">{t('summary.walkInsCount', { count: totals.walk_ins, formatted: formatCount(totals.walk_ins) })}</span>
            )}
          </>
        }
      />
      <StatTile
        label={t('summary.noShowRate')}
        value={formatRate(report.no_show_rate)}
        icon={Percent}
        tone="warning"
        footer={
          report.no_show_rate !== null && (
            <StatMeter
              segments={[
                { value: totals.no_show, tone: 'attention' },
                { value: settledOthers, tone: 'muted' },
              ]}
            />
          )
        }
        hint={t('summary.noShowsCount', { count: totals.no_show, formatted: formatCount(totals.no_show) })}
      />
      <StatTile label={t('summary.averageDuration')} value={formatAverageDuration(report.avg_duration_seconds)} icon={Clock} />
    </div>
  )
}
