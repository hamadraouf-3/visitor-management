import { useAuth } from '../../auth/useAuth'
import { VisitHistory } from './VisitHistory'

/** /history (§10, D-25): company-wide, read-only visit history (its header, filters and table). */
export function HistoryPage() {
  const { me } = useAuth()
  if (!me) return null
  return <VisitHistory me={me} />
}
