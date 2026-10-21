import { CircleOff, Unplug } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TrackingStatus } from '../../types/api'
import { cn } from '../../utils/cn'
import { SimulatedBadge } from './JourneyBadges'
import { trackingBanner, type TrackingBannerLine } from './trackingStatus'

const LINE_KEY = {
  noProvider: 'banner.noProvider',
  off: 'banner.off',
  notConnected: 'banner.notConnected',
} as const satisfies Record<TrackingBannerLine, string>

/**
 * The page's one line about tracking (contract §F), from `GET /tracking/status`: «لا يوجد مزوّد تتبّع» / "No
 * tracking provider", «التتبّع غير مفعّل» / "Tracking is off", or «مزوّد التتبّع غير متصل» / "The tracking
 * provider is not connected", and the «محاكاة» / "Simulated" mark while the deployment's provider is the
 * simulator. Nothing when tracking is on, connected and real; the mark alone stands without a frame. No
 * explanation under it (the owner's rule). `simulatedShown`: the page marks what the simulator made itself (a
 * visit's journey), so the line leaves the mark out.
 */
export function TrackingStatusBanner({ status, simulatedShown = false, className }: { status: TrackingStatus | undefined; simulatedShown?: boolean; className?: string }) {
  const { t } = useTranslation('journey')
  if (!status) return null
  const found = trackingBanner(status)
  // The page says Simulated already (a visit's simulated journey, in its header): the line does not repeat it.
  const banner = simulatedShown ? { ...found, simulated: false } : found
  if (banner.line === null && !banner.simulated) return null
  if (banner.line === null) {
    return (
      <section aria-label={t('banner.label')} data-tracking-banner="simulated" className={cn('mb-6 flex', className)}>
        <SimulatedBadge size="md" />
      </section>
    )
  }
  const notConnected = banner.line === 'notConnected'
  const Icon = notConnected ? Unplug : CircleOff
  return (
    <section
      aria-label={t('banner.label')}
      data-tracking-banner={banner.line}
      className={cn(
        'mb-6 flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-card border px-4 py-2.5 text-sm font-semibold',
        notConnected ? 'border-warning-border bg-warning-surface text-warning-text' : 'border-border bg-surface text-fg',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden="true" className={cn('size-5 shrink-0', notConnected ? 'text-warning-solid' : 'text-fg-muted')} />
        <span>{t(LINE_KEY[banner.line])}</span>
      </span>
      {banner.simulated && <SimulatedBadge size="md" />}
    </section>
  )
}
