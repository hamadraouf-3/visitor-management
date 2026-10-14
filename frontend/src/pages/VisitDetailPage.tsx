import { useParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { VisitDetail } from '../features/visits/VisitDetail'

/** /visits/:visitId (§10 visit detail). */
export function VisitDetailPage() {
  const { visitId } = useParams()
  const { me } = useAuth()
  if (!me || !visitId) return null
  // Keyed by visit: dialogs and a one-time pass link never carry over to another visit.
  return <VisitDetail key={visitId} visitId={visitId} me={me} />
}
