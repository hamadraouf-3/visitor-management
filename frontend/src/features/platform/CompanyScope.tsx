import { Building2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { hasErrorCode } from '../../api/client'
import { ButtonLink } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PageSpinner } from '../../components/ui/Spinner'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { paths } from '../../paths'
import type { PlatformCompany } from '../../types/api'
import { usePlatformCompany } from './queries'

/**
 * A page about one company of the platform (`/platform/companies/:companyId/…`): the company loaded,
 * or the same "not found" and load error as the company's own page. Its children render with the
 * company.
 */
export function CompanyScope({ children }: { children: (company: PlatformCompany) => ReactNode }) {
  const { t } = useTranslation('platform')
  const { companyId = '' } = useParams()
  const company = usePlatformCompany(companyId)
  const notFound = company.isError && hasErrorCode(company.error, 'NOT_FOUND')
  useDocumentTitle(notFound ? t('company.notFound') : undefined)

  if (company.isPending) return <PageSpinner />
  if (company.isError) {
    if (notFound) {
      return (
        <EmptyState
          headingLevel="h1"
          icon={Building2}
          title={t('company.notFound')}
          action={
            <ButtonLink to={paths.platformCompanies} variant="secondary">
              {t('company.back')}
            </ButtonLink>
          }
        />
      )
    }
    return <LoadErrorAlert title={t('company.loadError')} error={company.error} onRetry={() => void company.refetch()} />
  }
  return <>{children(company.data)}</>
}
