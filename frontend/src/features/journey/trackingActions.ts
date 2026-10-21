import { hasAnyRole, TRACKING_ACTION_ROLES } from '../../auth/roles'
import type { Role, TrackingCamera, VisitJourney } from '../../types/api'

export type TrackingActions =
  /** Nothing to offer: management (read only), or a running association a role may not stop. */
  | { kind: 'none' }
  | { kind: 'stop' }
  | { kind: 'start'; cameras: TrackingCamera[] }
  /** A disabled "Start tracking" with the reason beside it, as a short state (`enrollBlockerLabel`). */
  | { kind: 'blocked'; blocker: NonNullable<VisitJourney['enroll_blocker']> }

/**
 * What the journey page offers (contract §B): the server decides (`can_enroll`, `enroll_blocker`,
 * `can_revoke`), the page follows. Reception and administrators stop a running association; they start one
 * at a reception camera when the server says it can. A start the server would refuse is never offered, and
 * the reason it gives is said beside the disabled button, except the two that call for no button at all
 * (a running association, a role that cannot start one).
 *
 * `cameras` are the company's active enrollment points as this person may read them; `null` while they are
 * being asked for. With none, the server's own blocker is `NO_ENROLLMENT_POINT`; a camera archived since
 * the journey was read is the same case.
 */
export function trackingActionsFor(journey: VisitJourney, cameras: readonly TrackingCamera[] | null, roles: readonly Role[]): TrackingActions {
  // Read only for anyone without a tracking role, whatever the server lists first among its reasons.
  if (!hasAnyRole(roles, TRACKING_ACTION_ROLES)) return { kind: 'none' }
  if (journey.can_revoke) return { kind: 'stop' }
  if (journey.can_enroll) {
    if (cameras === null) return { kind: 'none' }
    return cameras.length > 0 ? { kind: 'start', cameras: [...cameras] } : { kind: 'blocked', blocker: 'NO_ENROLLMENT_POINT' }
  }
  const blocker = journey.enroll_blocker
  if (blocker === null || blocker === 'ALREADY_ENROLLED' || blocker === 'NOT_PERMITTED') return { kind: 'none' }
  return { kind: 'blocked', blocker }
}
