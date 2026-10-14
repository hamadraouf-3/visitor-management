import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/useAuth'
import { PageHeader } from '../components/ui/PageHeader'
import { VisitorSearch } from '../features/visitors/VisitorSearch'

/** /visitors (§10 visitor search). */
export function VisitorsPage() {
  const { t } = useTranslation('visitors')
  const { me } = useAuth()
  if (!me) return null
  return (
    <>
      <PageHeader title={t('search.title')} />
      <VisitorSearch me={me} />
    </>
  )
}
