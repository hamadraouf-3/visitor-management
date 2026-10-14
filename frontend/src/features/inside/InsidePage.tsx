import { useAuth } from '../../auth/useAuth'
import { EvacuationScreen } from './EvacuationScreen'

/** /inside (§10, D-25): the evacuation list. */
export function InsidePage() {
  const { me } = useAuth()
  if (!me) return null
  return <EvacuationScreen me={me} />
}
