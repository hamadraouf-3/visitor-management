import { useMemo } from 'react'
import { useParams } from 'react-router'
import { useCompanyName } from '../../i18n/useLanguage'
import type { PlatformCompany } from '../../types/api'
import { EmailTemplatesSourceContext } from '../admin/emailTemplatesSource'
import { EmailTemplateView } from '../admin/EmailTemplateView'
import { platformEmailTemplatesSource } from './companyEmailTemplates'
import { CompanyLogoTile } from './CompanyLogoTile'
import { CompanyScope } from './CompanyScope'

function CompanyEmailTemplate({ company }: { company: PlatformCompany }) {
  const { kind } = useParams()
  const displayName = useCompanyName(company)
  const source = useMemo(() => platformEmailTemplatesSource(company, displayName, <CompanyLogoTile company={company} size="lg" />), [company, displayName])
  return (
    <EmailTemplatesSourceContext.Provider value={source}>
      <EmailTemplateView kind={kind} />
    </EmailTemplatesSourceContext.Provider>
  )
}

/** /platform/companies/:companyId/email-templates/:kind: one of a company's e-mails, edited by the platform owner (Phase 12). */
export function CompanyEmailTemplatePage() {
  return <CompanyScope>{(company) => <CompanyEmailTemplate company={company} />}</CompanyScope>
}
