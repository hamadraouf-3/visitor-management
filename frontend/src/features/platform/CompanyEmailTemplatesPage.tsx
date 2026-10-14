import { useMemo } from 'react'
import { useCompanyName } from '../../i18n/useLanguage'
import type { PlatformCompany } from '../../types/api'
import { EmailTemplateList } from '../admin/EmailTemplateList'
import { EmailTemplatesSourceContext } from '../admin/emailTemplatesSource'
import { platformEmailTemplatesSource } from './companyEmailTemplates'
import { CompanyLogoTile } from './CompanyLogoTile'
import { CompanyScope } from './CompanyScope'

function CompanyEmailTemplates({ company }: { company: PlatformCompany }) {
  const displayName = useCompanyName(company)
  const source = useMemo(() => platformEmailTemplatesSource(company, displayName, <CompanyLogoTile company={company} size="lg" />), [company, displayName])
  return (
    <EmailTemplatesSourceContext.Provider value={source}>
      <EmailTemplateList />
    </EmailTemplatesSourceContext.Provider>
  )
}

/** /platform/companies/:companyId/email-templates: a company's e-mail texts, for the platform owner (Phase 12). */
export function CompanyEmailTemplatesPage() {
  return <CompanyScope>{(company) => <CompanyEmailTemplates company={company} />}</CompanyScope>
}
