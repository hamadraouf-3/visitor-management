import { useAuth } from '../../auth/useAuth'
import { AuditTrail } from './AuditTrail'

/** /admin/audit (D-13): the append-only audit log. */
export function AuditLogPage() {
  const { me } = useAuth()
  if (!me) return null
  return <AuditTrail me={me} />
}
