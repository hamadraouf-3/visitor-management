import { CircleCheck, CircleHelp, FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import type { JourneyState } from '../../types/api'
import { JOURNEY_STATE_META } from './journeyStates'

/** A visit's journey state: icon and words on its tone, never colour alone. */
export function JourneyStateBadge({ state, size = 'md', className }: { state: JourneyState; size?: 'sm' | 'md'; className?: string }) {
  // Re-renders on a language switch: the label is read from the catalog.
  useTranslation('journey')
  const meta = JOURNEY_STATE_META[state]
  return (
    <Badge tone={meta.tone} icon={meta.icon} size={size} className={className}>
      {meta.label}
    </Badge>
  )
}

/**
 * «محاكاة» / "Simulated": everything the simulator provider produced carries it (the contract's rule: no
 * simulated movement is ever shown as real). `data-simulated` lets the end-to-end suite find every one.
 */
export function SimulatedBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { t } = useTranslation('journey')
  return (
    <span data-simulated="" className="inline-flex max-w-full">
      <Badge tone="info" icon={FlaskConical} size={size}>
        {t('simulated')}
      </Badge>
    </span>
  )
}

/**
 * An observation's mark in the timeline: «مؤكد» / "Confirmed" when the application counts it (the provider said
 * CONFIRMED, at or above the company's threshold), else «غير مؤكد» / "Uncertain".
 */
export function ConfirmationBadge({ confirmed }: { confirmed: boolean }) {
  const { t } = useTranslation('journey')
  return (
    <Badge tone={confirmed ? 'success' : 'warning'} icon={confirmed ? CircleCheck : CircleHelp}>
      {confirmed ? t('mark.confirmed') : t('mark.uncertain')}
    </Badge>
  )
}
