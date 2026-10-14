import { UserCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import type { Visitor } from '../../types/api'
import { useVisitor } from './queries'
import { registeredVisitorId } from './visitorFields'

export interface RegisteredVisitorActionProps {
  /** The failed create request (invite or walk-in). */
  error: unknown
  /** Use the registered visitor instead of the new one typed in the form. */
  onSelect: (visitor: Visitor) => void
}

/**
 * After 409 `VISITOR_EXISTS` with `details.visitor_id` (B57-70: the email address belongs to a
 * visitor registered under another name), offers that visitor as the returning visitor. The
 * record is loaded and shown in the form before anything is sent again, so the person at the
 * desk is compared with the registered name ("Select that visitor, or correct the email", the
 * server's message on the Email field). Nothing is shown without the id (EMPLOYEE-only callers),
 * or when the record cannot be loaded: the visitor search finds them too.
 */
export function RegisteredVisitorAction({ error, onSelect }: RegisteredVisitorActionProps) {
  const { t } = useTranslation('visitors')
  const visitorId = registeredVisitorId(error)
  const visitor = useVisitor(visitorId ?? '', visitorId !== null)
  if (visitorId === null || visitor.isError) return null
  return (
    <Button
      variant="secondary"
      icon={<UserCheck aria-hidden="true" />}
      loading={visitor.isPending}
      onClick={() => {
        if (visitor.data) onSelect(visitor.data)
      }}
      className="self-start"
    >
      {t('fields.selectRegistered')}
    </Button>
  )
}
