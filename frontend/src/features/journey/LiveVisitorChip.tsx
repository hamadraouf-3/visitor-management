import { CircleHelp, Clock, FlaskConical, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { formatAgo, formatDuration } from '../../utils/duration'
import { initials } from '../../utils/text'
import { JOURNEY_STATE_META } from './journeyStates'
import type { LiveVisitor } from './types'

export interface LiveVisitorChipProps {
  visitor: LiveVisitor
  /** Seconds since the visitor's place was seen, as of now (the server's freshness counted on). */
  agoSeconds: number | null
  /** The page says Simulated already (its line): the chip leaves the mark out. */
  simulatedShown: boolean
  onOpen: (visitId: string) => void
}

/**
 * A visitor on the live map (Phase 16): a button with the initials and the name that opens the visitor's
 * panel. An active alert makes it the alerts' red with a warning sign; a place that is not recent (or not
 * certain) is drawn dashed and quieter, with how long ago it was seen; the simulator's visitor has its mark
 * when the page does not say it already. Each sign has its words for assistive technology, never colour alone.
 */
export function LiveVisitorChip({ visitor, agoSeconds, simulatedShown, onOpen }: LiveVisitorChipProps) {
  const { t } = useTranslation('journey')
  const name = visitor.visit.visitor.full_name
  const alert = visitor.alert !== null
  const stale = visitor.state === 'STALE'
  const uncertain = visitor.state === 'UNCERTAIN'
  const quiet = (stale || uncertain) && !alert
  return (
    <button
      type="button"
      data-live-chip={visitor.visit.id}
      data-chip-alert={alert ? visitor.alert?.status : undefined}
      data-chip-state={visitor.state}
      onClick={() => onOpen(visitor.visit.id)}
      className={cn(
        'inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border py-1 ps-1 pe-3 text-start text-sm font-semibold transition-colors',
        alert
          ? // The alerts' red: its text 5.80:1 on its surface (8.28:1 dark), its edge 5.62:1 against the tile.
            'border-danger-solid bg-danger-surface text-danger-text hover:bg-danger-border/40'
          : quiet
            ? 'border-dashed border-border-strong bg-surface text-fg-secondary hover:bg-surface-muted'
            : 'border-border-strong bg-surface text-fg hover:bg-surface-muted',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold select-none',
          alert ? 'bg-danger-solid text-on-danger' : quiet ? 'bg-surface-muted text-fg-secondary' : 'bg-emphasis text-highlight',
        )}
      >
        {initials(name)}
      </span>
      <span className="max-w-[12rem] min-w-0 truncate">{name}</span>
      {alert && (
        <>
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">{`${t('locationSeparator')} ${t('live.alert')}`}</span>
        </>
      )}
      {stale && agoSeconds !== null && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap">
          <Clock aria-hidden="true" className="size-3.5" />
          <span aria-hidden="true" data-freshness="">
            {formatDuration(agoSeconds)}
          </span>
          <span className="sr-only">{`${t('locationSeparator')} ${JOURNEY_STATE_META.STALE.label}${t('locationSeparator')} ${formatAgo(agoSeconds)}`}</span>
        </span>
      )}
      {uncertain && (
        <>
          <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">{`${t('locationSeparator')} ${JOURNEY_STATE_META.UNCERTAIN.label}`}</span>
        </>
      )}
      {visitor.simulated && !simulatedShown && (
        <>
          <FlaskConical aria-hidden="true" data-simulated="" className="size-4 shrink-0" />
          <span className="sr-only">{`${t('locationSeparator')} ${t('simulated')}`}</span>
        </>
      )}
    </button>
  )
}
