import { useAuth } from '../auth/useAuth'
import { InviteVisitor } from '../features/visits/InviteVisitor'

/**
 * /visits/new (§10 Invite visitor). The page title lives in the feature: it changes from
 * "Invite visitor" to the outcome once the visit is created.
 */
export function InviteVisitorPage() {
  const { me } = useAuth()
  if (!me) return null
  return (
    <div className="max-w-3xl">
      <InviteVisitor me={me} />
    </div>
  )
}
