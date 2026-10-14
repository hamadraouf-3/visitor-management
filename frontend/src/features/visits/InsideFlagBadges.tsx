import { CalendarClock, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import type { Visit } from '../../types/api'
import type { DateInput } from '../../utils/datetime'
import { insideFlags, type InsideFlagKind } from './insideFlags'

const FLAG_ICONS: Record<InsideFlagKind, typeof Clock> = {
  'previous-day': CalendarClock,
  overdue: Clock,
}

export interface InsideFlagBadgesProps {
  visit: Pick<Visit, 'is_overdue' | 'is_stale' | 'scheduled_end'>
  timeZone: string
  now: DateInput
}

/** "Previous day" and "Overdue · due out 10:00" as warning badges (icon and text, never colour alone). */
export function InsideFlagBadges({ visit, timeZone, now }: InsideFlagBadgesProps) {
  // Re-renders on a language switch: the labels are read from the catalog.
  useTranslation('visits')
  return insideFlags(visit, timeZone, now).map((flag) => (
    <Badge key={flag.kind} tone="warning" icon={FLAG_ICONS[flag.kind]}>
      {flag.label}
    </Badge>
  ))
}
