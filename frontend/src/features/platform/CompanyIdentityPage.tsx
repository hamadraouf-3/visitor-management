import { CompanyScope } from './CompanyScope'
import { IdentityEditor } from './IdentityEditor'

/** /platform/companies/:companyId/identity: the company's logo, colour and sign-in link (Phase 12). */
export function CompanyIdentityPage() {
  // Another company is another form: nothing staged for one is carried to the next.
  return <CompanyScope>{(company) => <IdentityEditor key={company.id} company={company} />}</CompanyScope>
}
