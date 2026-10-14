import { MailX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { hasErrorCode } from '../../api/client'
import { ButtonLink } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PageSpinner } from '../../components/ui/Spinner'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import type { EmailTemplateKind } from '../../types/api'
import { EmailTemplateEditor } from './EmailTemplateEditor'
import { isEmailTemplateKind } from './emailTemplateForm'
import { useEmailTemplatesSource } from './emailTemplatesSource'
import { useEmailTemplate } from './queries'

function NotFound() {
  const { t } = useTranslation('admin')
  const source = useEmailTemplatesSource()
  useDocumentTitle(t('emailTemplates.notFound'))
  return (
    <EmptyState
      headingLevel="h1"
      icon={MailX}
      title={t('emailTemplates.notFound')}
      action={
        <ButtonLink to={source.listPath} variant="secondary">
          {t('emailTemplates.back')}
        </ButtonLink>
      }
    />
  )
}

function TemplateLoader({ kind }: { kind: EmailTemplateKind }) {
  const { t } = useTranslation('admin')
  const template = useEmailTemplate(kind)
  if (template.isPending) return <PageSpinner />
  if (template.isError) {
    if (hasErrorCode(template.error, 'NOT_FOUND')) return <NotFound />
    return <LoadErrorAlert title={t('emailTemplates.loadError')} error={template.error} onRetry={() => void template.refetch()} />
  }
  return <EmailTemplateEditor key={kind} template={template.data} />
}

/**
 * One e-mail's texts, by the kind an address names (the four editable kinds; any other is not
 * found, B11-21), from the page's source: the company's own, or a company's for the platform owner.
 */
export function EmailTemplateView({ kind }: { kind: string | undefined }) {
  if (!isEmailTemplateKind(kind)) return <NotFound />
  return <TemplateLoader kind={kind} />
}
