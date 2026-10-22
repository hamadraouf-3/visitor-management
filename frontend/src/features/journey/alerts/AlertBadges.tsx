import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/Badge'
import type { TrackingAlertStatus, TrackingAlertType } from '../../../types/api'
import { ALERT_STATUS_META, ALERT_TYPE_META } from './alertLabels'

/** The alert's type: «منطقة غير مسموحة» / "Unauthorized area" or «منطقة مقيّدة» / "Restricted area". */
export function AlertTypeBadge({ type, size = 'sm' }: { type: TrackingAlertType; size?: 'sm' | 'md' }) {
  // Re-renders on a language switch: the label is read from the catalog.
  useTranslation('journey')
  const meta = ALERT_TYPE_META[type]
  return (
    <span data-alert-type={type} className="inline-flex max-w-full">
      <Badge tone={meta.tone} icon={meta.icon} size={size}>
        {meta.label}
      </Badge>
    </span>
  )
}

export function AlertStatusBadge({ status, size = 'sm' }: { status: TrackingAlertStatus; size?: 'sm' | 'md' }) {
  useTranslation('journey')
  const meta = ALERT_STATUS_META[status]
  return (
    <span data-alert-status={status} className="inline-flex max-w-full">
      <Badge tone={meta.tone} icon={meta.icon} size={size}>
        {meta.label}
      </Badge>
    </span>
  )
}
