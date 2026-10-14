import { useTranslation } from 'react-i18next'
import { ButtonLink } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { paths } from '../../paths'

/** An unknown address inside the platform owner's area: in its shell, with the way back to the companies. */
export function PlatformNotFound() {
  const { t } = useTranslation(['common', 'platform'])
  useDocumentTitle(t('notFound.title'))
  return (
    <EmptyState
      headingLevel="h1"
      figure="404"
      title={t('notFound.title')}
      action={
        <ButtonLink to={paths.platformCompanies} variant="secondary">
          {t('platform:company.back')}
        </ButtonLink>
      }
    />
  )
}
