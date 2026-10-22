import { useTranslation } from 'react-i18next'
import { NavBadge } from '../../../layouts/NavBadge'
import { useTrackingAlertSummary } from './queries'

/**
 * The navigation's count of active tracking alerts (Phase 16): open and acknowledged, in the alerts' red while
 * any is open, quiet when all of them are being dealt with; nothing at none. It reads what the shell's watcher
 * asks for (the same cache entry); it asks for nothing itself.
 */
export function TrackingAlertsNavBadge() {
  const { t } = useTranslation('journey')
  const { data } = useTrackingAlertSummary({ poll: false })
  if (!data || data.active <= 0) return null
  return <NavBadge count={data.active} tone={data.open > 0 ? 'danger' : 'neutral'} label={t('alerts.active', { count: data.active })} />
}
