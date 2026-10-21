import { useParams } from 'react-router'
import { useAuth } from '../../auth/useAuth'
import { JourneyDetail } from './JourneyDetail'

/** /journey/:visitId (Phase 15): one visit's journey. */
export function JourneyDetailPage() {
  const { visitId } = useParams()
  const { me } = useAuth()
  if (!me || !visitId) return null
  // Keyed by visit: a dialog or a chosen camera never carries over to another visit.
  return <JourneyDetail key={visitId} visitId={visitId} me={me} />
}
