import { BellRing, CircleCheck, Eye, MapPinX, ShieldAlert, type LucideIcon } from 'lucide-react'
import type { Tone } from '../../../components/ui/tones'
import { i18n } from '../../../i18n'
import type { TrackingAlertResolution, TrackingAlertStatus, TrackingAlertType } from '../../../types/api'

/*
 * A tracking alert's words (Phase 16): its type and its status as chips (an icon and words on a tone, never
 * colour alone), and how it was resolved. Both types are the alerts' red; each has its own symbol.
 */

export interface AlertChipMeta {
  /** In the UI language, read when rendered. */
  readonly label: string
  readonly tone: Tone
  readonly icon: LucideIcon
}

function chip(label: () => string, tone: Tone, icon: LucideIcon): AlertChipMeta {
  return {
    get label() {
      return label()
    },
    tone,
    icon,
  }
}

/** «منطقة غير مسموحة» / "Unauthorized area", «منطقة مقيّدة» / "Restricted area". */
export const ALERT_TYPE_META: Readonly<Record<TrackingAlertType, AlertChipMeta>> = {
  UNAUTHORIZED_AREA: chip(() => i18n.t('journey:alerts.type.UNAUTHORIZED_AREA'), 'danger', MapPinX),
  RESTRICTED_AREA: chip(() => i18n.t('journey:alerts.type.RESTRICTED_AREA'), 'danger', ShieldAlert),
}

/** Open (red: nobody has looked), acknowledged (amber: someone is on it), resolved (grey). */
export const ALERT_STATUS_META: Readonly<Record<TrackingAlertStatus, AlertChipMeta>> = {
  OPEN: chip(() => i18n.t('journey:alerts.status.OPEN'), 'danger', BellRing),
  ACKNOWLEDGED: chip(() => i18n.t('journey:alerts.status.ACKNOWLEDGED'), 'warning', Eye),
  RESOLVED: chip(() => i18n.t('journey:alerts.status.RESOLVED'), 'neutral', CircleCheck),
}

export function alertResolutionLabel(resolution: TrackingAlertResolution): string {
  return i18n.t(`journey:alerts.resolution.${resolution}`)
}

/** An alert still to be dealt with (open or acknowledged): the one a visit may have at a time. */
export function isActiveAlert(status: TrackingAlertStatus): boolean {
  return status === 'OPEN' || status === 'ACKNOWLEDGED'
}

/** The longest note the server keeps (one line). */
export const ALERT_NOTE_MAX = 300
