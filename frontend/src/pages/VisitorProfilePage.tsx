import { useParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { VisitorProfile } from '../features/visitors/VisitorProfile'

/** /visitors/:visitorId (§10 visitor profile and history). */
export function VisitorProfilePage() {
  const { visitorId } = useParams()
  const { me } = useAuth()
  if (!me || !visitorId) return null
  return <VisitorProfile key={visitorId} visitorId={visitorId} me={me} />
}
