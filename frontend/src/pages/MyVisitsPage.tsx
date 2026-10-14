import { useAuth } from '../auth/useAuth'
import { MyVisits } from '../features/visits/MyVisits'

/** /visits (§10 My visits). The header lives in the feature: its line of facts is the dashboard's counts. */
export function MyVisitsPage() {
  const { me } = useAuth()
  if (!me) return null
  return <MyVisits me={me} />
}
