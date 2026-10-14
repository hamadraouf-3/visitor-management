import { UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { EmailText } from '../../components/ui/EmailText'
import { PhoneNumber } from '../../components/ui/PhoneLink'
import type { Visitor } from '../../types/api'

export interface SelectedVisitorSummaryProps {
  visitor: Visitor
  /** Go back to entering a new visitor. */
  onClear: () => void
}

/**
 * The chosen returning visitor's details in the invite and walk-in forms, in the order of the
 * new-visitor fields (company, phone, email). The name is already in the field above, so it is
 * not repeated.
 */
export function SelectedVisitorSummary({ visitor, onClear }: SelectedVisitorSummaryProps) {
  const { t } = useTranslation('visitors')
  return (
    <div className="flex flex-col gap-3 rounded-control border border-border-subtle bg-surface-sunken p-4 sm:flex-row sm:items-start sm:justify-between">
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-fg-muted">{t('fields.company')}</dt>
        <dd className="min-w-0 break-words text-fg">{visitor.company_name ?? '—'}</dd>
        <dt className="text-fg-muted">{t('fields.phone')}</dt>
        <dd className="min-w-0 text-fg">{visitor.phone ? <PhoneNumber>{visitor.phone}</PhoneNumber> : '—'}</dd>
        <dt className="text-fg-muted">{t('fields.email')}</dt>
        <dd className="min-w-0 text-fg">{visitor.email ? <EmailText address={visitor.email} /> : '—'}</dd>
      </dl>
      <Button variant="secondary" icon={<UserPlus aria-hidden="true" />} onClick={onClear} className="shrink-0">
        {t('fields.enterNewInstead')}
      </Button>
    </div>
  )
}
