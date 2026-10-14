import { useAuth } from '../../auth/useAuth'
import { DepartmentList } from './DepartmentList'

/** /admin/departments: the company's departments. */
export function DepartmentsPage() {
  const { me } = useAuth()
  if (!me) return null
  return <DepartmentList me={me} />
}
