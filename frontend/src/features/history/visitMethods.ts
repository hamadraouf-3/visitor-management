import type { Visit } from '../../types/api'
import { VISIT_METHOD_SHORT_LABELS } from '../visits/labels'

/**
 * Check-in and check-out methods that change how a visit's times should be read (§4, §5):
 * an override or walk-in was not a regular pass check-in, and a corrected or bulk check-out
 * time was entered by staff (reports leave those out of the average duration).
 */
export type VisitMethodFlag = 'OVERRIDE' | 'WALK_IN' | 'CORRECTED' | 'BULK'

export interface VisitMethodBadge {
  flag: VisitMethodFlag
  label: string
}

/** The method badges a visit carries, check-in first. */
export function visitMethodBadges(visit: Pick<Visit, 'check_in_method' | 'check_out_method' | 'is_walk_in'>): VisitMethodBadge[] {
  const flags: VisitMethodFlag[] = []
  if (visit.check_in_method === 'OVERRIDE') flags.push('OVERRIDE')
  if (visit.is_walk_in || visit.check_in_method === 'WALK_IN') flags.push('WALK_IN')
  if (visit.check_out_method === 'CORRECTED') flags.push('CORRECTED')
  if (visit.check_out_method === 'BULK') flags.push('BULK')
  return flags.map((flag) => ({ flag, label: VISIT_METHOD_SHORT_LABELS[flag] }))
}
