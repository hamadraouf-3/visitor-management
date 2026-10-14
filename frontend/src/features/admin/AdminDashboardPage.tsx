import { useAuth } from '../../auth/useAuth'
import { AdminDashboard } from './AdminDashboard'

/** /admin: the admin dashboard. */
export function AdminDashboardPage() {
  const { me } = useAuth()
  if (!me) return null
  return <AdminDashboard me={me} />
}
