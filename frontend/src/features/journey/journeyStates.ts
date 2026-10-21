import { CircleDashed, CircleHelp, CircleOff, CircleStop, Clock, Hourglass, MapPin, Unplug, type LucideIcon } from 'lucide-react'
import type { Tone } from '../../components/ui/tones'
import { i18n } from '../../i18n'
import type { EnrollBlocker, JourneyState, TrackingEndReason } from '../../types/api'

/*
 * The journey state of a visit, as the server computes it (one value, contract §C): its chip's words,
 * tone and symbol. The server decides the state; the page only names it. A state's colour never follows
 * the company's (F12-16), and is never the only sign of it: the icon and the words say it too.
 */

export interface JourneyStateMeta {
  /** In the UI language, read when rendered. */
  readonly label: string
  readonly tone: Tone
  readonly icon: LucideIcon
}

function meta(state: JourneyState, tone: Tone, icon: LucideIcon): JourneyStateMeta {
  return {
    get label() {
      return i18n.t(`journey:state.${state}`)
    },
    tone,
    icon,
  }
}

/**
 * - `ACTIVE` (green): the latest confirmed observation is fresh: the only state whose floor is current.
 * - `UNCERTAIN`, `STALE` (amber): there may be a floor, but it is not to be relied on as it stands.
 * - `UNAVAILABLE` (red): the provider stopped answering while the visit is tracked.
 * - `PENDING` (blue): enrolment asked for, not yet confirmed by the provider.
 * - `DISABLED`, `NOT_ENROLLED`, `ENDED` (grey): nothing is being tracked.
 */
export const JOURNEY_STATE_META: Readonly<Record<JourneyState, JourneyStateMeta>> = {
  DISABLED: meta('DISABLED', 'neutral', CircleOff),
  NOT_ENROLLED: meta('NOT_ENROLLED', 'neutral', CircleDashed),
  PENDING: meta('PENDING', 'info', Hourglass),
  ACTIVE: meta('ACTIVE', 'success', MapPin),
  UNCERTAIN: meta('UNCERTAIN', 'warning', CircleHelp),
  STALE: meta('STALE', 'warning', Clock),
  UNAVAILABLE: meta('UNAVAILABLE', 'danger', Unplug),
  ENDED: meta('ENDED', 'neutral', CircleStop),
}

/** The states in the order the list's filter offers them: what is being tracked first, then what is not. */
export const JOURNEY_STATES: readonly JourneyState[] = ['ACTIVE', 'UNCERTAIN', 'STALE', 'UNAVAILABLE', 'PENDING', 'NOT_ENROLLED', 'ENDED', 'DISABLED']

export function isJourneyState(value: string | null | undefined): value is JourneyState {
  return typeof value === 'string' && (JOURNEY_STATES as readonly string[]).includes(value)
}

/** A pending or active association runs: the visit is being tracked (until check-out, a stop or its expiry). */
export function isTracking(state: JourneyState): boolean {
  return state === 'PENDING' || state === 'ACTIVE' || state === 'UNCERTAIN' || state === 'STALE' || state === 'UNAVAILABLE'
}

export function endReasonLabel(reason: TrackingEndReason): string {
  return i18n.t(`journey:endReason.${reason}`)
}

/**
 * Why "Start tracking" cannot be pressed, as the short state beside it (`enroll_blocker`). Null for the two
 * blockers that show no disabled button: a running association (its "Stop tracking" is offered instead,
 * to those who may) and a role that cannot start tracking (management reads the journey only).
 */
export function enrollBlockerLabel(blocker: EnrollBlocker): string | null {
  if (blocker === 'ALREADY_ENROLLED' || blocker === 'NOT_PERMITTED') return null
  return i18n.t(`journey:blocker.${blocker}`)
}
