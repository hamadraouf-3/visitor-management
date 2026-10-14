import { Ban, CircleCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import type { PlatformCompany } from '../../types/api'

/** A company's state as a chip, icon and text (never colour alone): active, or deactivated. */
export function CompanyStatusBadge({ company, size = 'sm' }: { company: Pick<PlatformCompany, 'is_active'>; size?: 'sm' | 'md' }) {
  const { t } = useTranslation('platform')
  return company.is_active ? (
    <Badge tone="success" icon={CircleCheck} size={size}>
      {t('companies.status.active')}
    </Badge>
  ) : (
    <Badge tone="warning" icon={Ban} size={size}>
      {t('companies.status.inactive')}
    </Badge>
  )
}
