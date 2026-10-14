import { useLocation } from 'react-router'
import { companySlugOf, withCompany } from './links'
import { readRememberedCompany } from './storage'

/**
 * The signed-out pages follow the company this device last signed in to (Phase 12): `/login` leads
 * to its sign-in page, and the password pages opened without a company (`/forgot-password`, an older
 * `/reset-password` link) lead to themselves with it (`?c={slug}`), so every signed-out page of the
 * device carries one identity. Null when the address already names a company, or the device
 * remembers none: the page stays where it is.
 *
 * The address's other parameters are kept; its fragment never is. A reset link's fragment is its
 * token: the route's loader has read it and taken it out of the address bar by then, but the
 * router's own location still holds it, and carrying it along would write the token back into the
 * address.
 */
export function useRememberedCompanyAddress(): string | null {
  const location = useLocation()
  if (companySlugOf(location) !== null) return null
  const remembered = readRememberedCompany()
  if (!remembered) return null
  return withCompany(`${location.pathname}${location.search}`, remembered)
}
