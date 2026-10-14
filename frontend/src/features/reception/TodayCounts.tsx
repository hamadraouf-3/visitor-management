import { CalendarClock, DoorOpen, LogOut, RotateCw, UserPlus, UserX, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { IconTile } from '../../components/ui/IconTile'
import { LiveIndicator } from '../../components/ui/LiveIndicator'
import type { Tone } from '../../components/ui/tones'
import { useLanguage } from '../../i18n/useLanguage'
import type { ReceptionToday } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatCount } from '../../utils/number'

export interface TodayCountsProps {
  counts: ReceptionToday['counts'] | undefined
  failed: boolean
  onRetry: () => void
  className?: string
}

interface CountTile {
  key: 'expected' | 'inside' | 'checkedOut' | 'noShows' | 'walkIns'
  label: string
  value: number | undefined
  icon: LucideIcon
  tone: Tone
  /** The icon points the reading direction's way (sign-out): mirrored in Arabic, as in the chips and buttons. */
  mirrorIcon?: boolean
  /**
   * Expected and inside are also the Expected and Inside tabs' badges, right under the strip:
   * phones leave these two tiles out, so the strip stays one row of three above the camera.
   */
  alsoOnTab?: boolean
}

/** One tile: label and icon over a Space Grotesk numeral (direction C's KPI, compact for the scanner screen). */
function Tile({ tile, live }: { tile: CountTile; live?: string }) {
  const { language } = useLanguage()
  const inside = tile.key === 'inside'
  return (
    <div
      data-count={tile.key}
      className={cn(
        'flex min-w-0 flex-col justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2.5 sm:px-4 sm:py-3',
        tile.alsoOnTab && 'max-sm:hidden',
      )}
    >
      <dt className="flex items-start justify-between gap-2 text-meta font-medium text-fg-secondary">
        <span className="min-w-0 break-words">{tile.label}</span>
        <IconTile icon={tile.icon} tone={tile.tone} size="sm" mirrorIcon={tile.mirrorIcon} className="max-lg:hidden" />
      </dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={cn(
            'font-numeric text-2xl leading-none font-semibold tracking-tight tabular-nums sm:text-[2rem]',
            // The figure the desk is about: mawdoo3's turquoise on the dark screen (accent text 8.93:1).
            inside ? 'text-accent-text' : 'text-fg',
          )}
        >
          {tile.value === undefined ? '–' : formatCount(tile.value, language)}
        </span>
        {live && <LiveIndicator label={live} tone="highlight" />}
      </dd>
    </div>
  )
}

/**
 * Today at reception (§10) as direction C's KPI strip: expected, inside (live), checked out,
 * no-shows and walk-ins, from GET /reception/today (polled every 15 s). The tiles keep their
 * place while the numbers load ("–") and when they fail (a line with "Try again" under them).
 * Not a live region: the poll would announce it every 15 s.
 */
export function TodayCounts({ counts, failed, onRetry, className }: TodayCountsProps) {
  const { t } = useTranslation(['reception', 'common'])
  const tiles: CountTile[] = [
    { key: 'expected', label: t('counts.expected'), value: counts?.expected, icon: CalendarClock, tone: 'info', alsoOnTab: true },
    { key: 'inside', label: t('counts.inside'), value: counts?.inside, icon: DoorOpen, tone: 'accent', alsoOnTab: true },
    { key: 'checkedOut', label: t('counts.checkedOut'), value: counts?.checked_out, icon: LogOut, tone: 'neutral', mirrorIcon: true },
    {
      key: 'noShows',
      label: t('counts.noShows'),
      value: counts?.no_show,
      icon: UserX,
      tone: counts && counts.no_show > 0 ? 'warning' : 'neutral',
    },
    { key: 'walkIns', label: t('counts.walkIns'), value: counts?.walk_ins, icon: UserPlus, tone: 'neutral' },
  ]
  return (
    <section aria-label={t('counts.label')} aria-busy={!counts && !failed} className={cn('flex flex-col gap-2', className)}>
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-5 sm:gap-3">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} live={tile.key === 'inside' && counts ? t('counts.live') : undefined} />
        ))}
      </dl>
      {!counts &&
        (failed ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <span role="status">{t('counts.unavailable')}</span>
            <Button variant="ghost" icon={<RotateCw aria-hidden="true" />} onClick={onRetry}>
              {t('common:actions.tryAgain')}
            </Button>
          </div>
        ) : (
          <span className="sr-only">{t('counts.loading')}</span>
        ))}
    </section>
  )
}
