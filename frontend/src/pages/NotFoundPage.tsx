import { useTranslation } from 'react-i18next'
import { ButtonLink } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { CenteredLayout } from '../layouts/CenteredLayout'
import { paths } from '../paths'

export function NotFoundContent() {
  const { t } = useTranslation()
  useDocumentTitle(t('notFound.title'))
  return (
    <EmptyState
      figure="404"
      headingLevel="h1"
      title={t('notFound.title')}
      action={<ButtonLink to={paths.home}>{t('notFound.goHome')}</ButtonLink>}
    />
  )
}

/** Catch-all route: public, so a mistyped link never forces a sign-in first. */
export function NotFoundPage() {
  return (
    <CenteredLayout>
      <NotFoundContent />
    </CenteredLayout>
  )
}
