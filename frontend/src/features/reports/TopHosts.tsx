import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/ui/Avatar'
import { Card } from '../../components/ui/Card'
import { useStableId } from '../../hooks/useStableId'
import { useLanguage } from '../../i18n/useLanguage'
import type { ReportSummary } from '../../types/api'
import { formatCount } from '../../utils/number'
import { formatShare } from './chartData'

const HEADER = 'py-2.5 text-[0.78125rem] font-semibold whitespace-nowrap text-fg-muted'

/**
 * A host's visits as a bar on a track, the busiest host's the whole track: the ranking read at a
 * glance. Drawn in SVG (it prints without background graphics), from the reading start.
 */
function HostBar({ count, max }: { count: number; max: number }) {
  const { direction } = useLanguage()
  const share = max > 0 ? Math.max(2, (count / max) * 100) : 0
  return (
    <svg aria-hidden="true" data-host-bar="" width="100%" height={8} className="block">
      <rect width="100%" height={8} rx={4} className="fill-surface-muted" />
      <rect x={direction === 'rtl' ? `${100 - share}%` : 0} width={`${share}%`} height={8} rx={4} className="fill-chart-1" />
    </svg>
  )
}

/**
 * The ten hosts with the most visits in the period (§8.1 `top_hosts`), as direction C's table in a
 * card: rank, the host with an avatar, the visits as a number and a bar, and the share of all
 * visits booked.
 */
export function TopHosts({ hosts, total }: { hosts: ReportSummary['top_hosts']; total: number }) {
  const { t } = useTranslation('reports')
  const titleId = useStableId('top-hosts')
  const busiest = hosts[0]?.count ?? 0
  return (
    <Card title={t('topHosts.title')} titleId={titleId} className="break-inside-avoid print:rounded-lg print:border-black/30" flush>
      {hosts.length === 0 ? (
        <p className="px-4 py-4 text-sm text-fg-muted sm:px-5">{t('topHosts.empty')}</p>
      ) : (
        <table className="w-full border-collapse text-start text-sm">
          <caption className="sr-only">{t('topHosts.title')}</caption>
          <thead className="border-b border-border-subtle bg-surface-sunken">
            <tr>
              <th scope="col" className={`${HEADER} w-12 ps-4 pe-2 text-start sm:ps-5`}>
                {t('topHosts.rank')}
              </th>
              <th scope="col" className={`${HEADER} pe-4 text-start`}>
                {t('topHosts.host')}
              </th>
              <th scope="col" className={`${HEADER} pe-4 text-start sm:w-[48%]`}>
                {t('topHosts.visits')}
              </th>
              <th scope="col" className={`${HEADER} w-20 pe-4 text-end sm:pe-5`}>
                {t('topHosts.share')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {hosts.map((host, index) => (
              <tr key={host.host_id}>
                <td className="py-3 ps-4 pe-2 font-numeric text-fg-muted tabular-nums sm:ps-5 print:py-1">{index + 1}</td>
                <th scope="row" className="py-3 pe-4 text-start font-normal print:py-1">
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar name={host.full_name} size="sm" tone={index === 0 ? 'emphasis' : 'neutral'} className="max-sm:hidden print:hidden" />
                    <span className="min-w-0 font-semibold break-words text-fg">{host.full_name}</span>
                  </span>
                </th>
                <td className="py-3 pe-4 print:py-1">
                  {/* The count in a column of its own width, the bar beside it (from sm). */}
                  <span className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-3 font-numeric font-semibold text-fg tabular-nums">
                    {formatCount(host.count)}
                    <span className="max-sm:hidden">
                      <HostBar count={host.count} max={busiest} />
                    </span>
                  </span>
                </td>
                <td className="py-3 pe-4 text-end font-numeric text-fg-muted tabular-nums sm:pe-5 print:py-1">{formatShare(host.count, total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
