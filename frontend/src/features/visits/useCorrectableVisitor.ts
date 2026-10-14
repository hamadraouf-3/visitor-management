import type { Visit, Visitor } from '../../types/api'
import { useVisitor } from '../visitors/queries'

/**
 * The visit's visitor when the caller may correct their contact details, else null (also
 * while the visit loads). Loaded only when `wanted` (e.g. the invitation failed, or the
 * visitor has no email address) and the caller manages the visit. Whether the visitor may be
 * edited is the visitor's own `permissions.can_edit` (§7.5 edit rule); the visit does not
 * carry it.
 */
export function useCorrectableVisitor(visit: Visit | undefined, wanted: boolean): Visitor | null {
  const query = useVisitor(visit?.visitor.id ?? '', wanted && visit !== undefined && visit.permissions.can_edit)
  return query.data?.permissions.can_edit ? query.data : null
}
