import { useAuth } from '../../auth/useAuth'
import { JourneyList } from './JourneyList'

/** /journey (Phase 15): the day's visits and their journeys. */
export function JourneyPage() {
  const { me } = useAuth()
  if (!me) return null
  return <JourneyList me={me} />
}
