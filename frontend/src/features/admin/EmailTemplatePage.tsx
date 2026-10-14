import { useMemo } from 'react'
import { useParams } from 'react-router'
import { useAuth } from '../../auth/useAuth'
import { companyEmailTemplatesSource, EmailTemplatesSourceContext } from './emailTemplatesSource'
import { EmailTemplateView } from './EmailTemplateView'

/** /admin/email-templates/:kind: one of the company's own e-mails, for its administrator. */
export function EmailTemplatePage() {
  const { kind } = useParams()
  const { me } = useAuth()
  const timeZone = me?.company.timezone
  const source = useMemo(() => (timeZone ? companyEmailTemplatesSource(timeZone) : null), [timeZone])
  if (!source) return null
  return (
    <EmailTemplatesSourceContext.Provider value={source}>
      <EmailTemplateView kind={kind} />
    </EmailTemplatesSourceContext.Provider>
  )
}
