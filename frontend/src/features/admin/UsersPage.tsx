import { useAuth } from '../../auth/useAuth'
import { UserDirectory } from './UserDirectory'

/** /admin/users: the company's accounts. */
export function UsersPage() {
  const { me } = useAuth()
  if (!me) return null
  return <UserDirectory me={me} />
}
