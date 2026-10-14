import { useMemo } from 'react'
import { useAuth } from '../../auth/useAuth'
import { EmailTemplateList } from './EmailTemplateList'
import { companyEmailTemplatesSource, EmailTemplatesSourceContext } from './emailTemplatesSource'

/** /admin/email-templates: the company's own e-mail texts, for its administrator. */
export function EmailTemplatesPage() {
  const { me } = useAuth()
  const timeZone = me?.company.timezone
  const source = useMemo(() => (timeZone ? companyEmailTemplatesSource(timeZone) : null), [timeZone])
  if (!source) return null
  return (
    <EmailTemplatesSourceContext.Provider value={source}>
      <EmailTemplateList />
    </EmailTemplatesSourceContext.Provider>
  )
}
